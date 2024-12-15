import ts = require('typescript');
import type config = require('@tsslint/config');
import core = require('@tsslint/core');
import url = require('url');
import fs = require('fs');
import worker_threads = require('worker_threads');
import languagePlugins = require('./languagePlugins.js');

import { createLanguage, FileMap } from '@volar/language-core';
import { decorateLanguageServiceHost, resolveFileLanguageId, createProxyLanguageService } from '@volar/typescript';

let projectVersion = 0;
let typeRootsVersion = 0;
let options: ts.CompilerOptions = {};
let fileNames: string[] = [];
let linter: core.Linter;

const snapshots = new Map<string, ts.IScriptSnapshot>();
const versions = new Map<string, number>();
const originalHost: ts.LanguageServiceHost = {
	...ts.sys,
	useCaseSensitiveFileNames() {
		return ts.sys.useCaseSensitiveFileNames;
	},
	getProjectVersion() {
		return projectVersion.toString();
	},
	getTypeRootsVersion() {
		return typeRootsVersion;
	},
	getCompilationSettings() {
		return options;
	},
	getScriptFileNames() {
		return fileNames;
	},
	getScriptVersion(fileName) {
		return versions.get(fileName)?.toString() ?? '0';
	},
	getScriptSnapshot(fileName) {
		if (!snapshots.has(fileName)) {
			snapshots.set(fileName, ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName)!));
		}
		return snapshots.get(fileName);
	},
	getDefaultLibFileName(options) {
		return ts.getDefaultLibFilePath(options);
	},
};
const host: ts.LanguageServiceHost = { ...originalHost };
const originalService = ts.createLanguageService(host);

export function createLocal() {
	return {
		setup(...args: Parameters<typeof setup>) {
			return setup(...args);
		},
		lint(...args: Parameters<typeof lint>) {
			return lint(...args)[0];
		},
		lintAndFix(...args: Parameters<typeof lintAndFix>) {
			return lintAndFix(...args)[0];
		},
		hasCodeFixes(...args: Parameters<typeof hasCodeFixes>) {
			return hasCodeFixes(...args);
		},
		hasRules(...args: Parameters<typeof hasRules>) {
			return hasRules(...args)[0];
		},
	};
}

export function create() {
	const worker = new worker_threads.Worker(__filename);
	return {
		setup(...args: Parameters<typeof setup>) {
			return sendRequest(setup, ...args);
		},
		async lint(...args: Parameters<typeof lint>) {
			const [res, newCache] = await sendRequest(lint, ...args);
			Object.assign(args[1], newCache); // Sync the cache
			return res;
		},
		async lintAndFix(...args: Parameters<typeof lintAndFix>) {
			const [res, newCache] = await sendRequest(lintAndFix, ...args);
			Object.assign(args[1], newCache); // Sync the cache
			return res;
		},
		hasCodeFixes(...args: Parameters<typeof hasCodeFixes>) {
			return sendRequest(hasCodeFixes, ...args);
		},
		async hasRules(...args: Parameters<typeof hasRules>) {
			const [res, newCache] = await sendRequest(hasRules, ...args);
			Object.assign(args[1], newCache); // Sync the cache
			return res;
		},
	};

	function sendRequest<T extends (...args: any) => void>(t: T, ...args: any[]) {
		return new Promise<Awaited<ReturnType<T>>>(resolve => {
			worker.once('message', json => {
				resolve(JSON.parse(json));
			});
			worker.postMessage(JSON.stringify([t.name, ...args]));
		});
	}
}

worker_threads.parentPort?.on('message', async json => {
	const data: [cmd: keyof typeof handlers, ...args: any[]] = JSON.parse(json);
	const result = await (handlers[data[0]] as any)(...data.slice(1));
	worker_threads.parentPort!.postMessage(JSON.stringify(result));
});

const handlers = {
	setup,
	lint,
	lintAndFix,
	hasCodeFixes,
	hasRules,
};

async function setup(
	tsconfig: string,
	languages: string[],
	configFile: string,
	builtConfig: string,
	_fileNames: string[],
	_options: ts.CompilerOptions
) {
	const clack = await import('@clack/prompts');

	let config: config.Config | config.Config[];
	try {
		config = (await import(url.pathToFileURL(builtConfig).toString())).default;
	} catch (err) {
		if (err instanceof Error) {
			clack.log.error(err.stack ?? err.message);
		} else {
			clack.log.error(String(err));
		}
		return false;
	}

	for (let key in host) {
		if (!(key in originalHost)) {
			// @ts-ignore
			delete host[key];
		} else {
			// @ts-ignore
			host[key] = originalHost[key];
		}
	}
	let service = originalService;

	const plugins = languagePlugins.load(tsconfig, languages);
	if (plugins.length) {
		const { getScriptSnapshot } = originalHost;
		const language = createLanguage<string>(
			[
				...plugins,
				{ getLanguageId: fileName => resolveFileLanguageId(fileName) },
			],
			new FileMap(ts.sys.useCaseSensitiveFileNames),
			fileName => {
				const snapshot = getScriptSnapshot(fileName);
				if (snapshot) {
					language.scripts.set(fileName, snapshot);
				}
			}
		);
		decorateLanguageServiceHost(ts, language, host);
		const proxy = createProxyLanguageService(service);
		proxy.initialize(language);
		service = proxy.proxy;
	}

	projectVersion++;
	typeRootsVersion++;
	fileNames = _fileNames;
	options = _options;
	linter = core.createLinter({
		configFile,
		languageService: service,
		languageServiceHost: host,
		typescript: ts,
		tsconfig: ts.server.toNormalizedPath(tsconfig),
	}, config, 'cli', clack);

	return true;
}

function lintAndFix(fileName: string, fileCache: core.FileLintCache) {
	let retry = 3;
	let shouldRetry = true;
	let newSnapshot: ts.IScriptSnapshot | undefined;
	let diagnostics!: ts.DiagnosticWithLocation[];

	while (shouldRetry && retry--) {
		if (Object.values(fileCache[1]).some(fixes => fixes > 0)) {
			// Reset the cache if there are any fixes applied.
			fileCache[1] = {};
			fileCache[2].length = 0;
			fileCache[3].length = 0;
		}
		diagnostics = linter.lint(fileName, fileCache);
		const fixes = linter
			.getCodeFixes(fileName, 0, Number.MAX_VALUE, diagnostics, fileCache[4])
			.filter(fix => fix.fixId === 'tsslint');
		const textChanges = core.combineCodeFixes(fileName, fixes);
		if (textChanges.length) {
			const oldSnapshot = snapshots.get(fileName)!;
			newSnapshot = core.applyTextChanges(oldSnapshot, textChanges);
			snapshots.set(fileName, newSnapshot);
			versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
			projectVersion++;
			shouldRetry = true;
		}
	}

	if (newSnapshot) {
		ts.sys.writeFile(fileName, newSnapshot.getText(0, newSnapshot.getLength()));
		fileCache[0] = fs.statSync(fileName).mtimeMs;
		fileCache[1] = {};
		fileCache[2].length = 0;
		fileCache[3].length = 0;
	}

	if (shouldRetry) {
		diagnostics = linter.lint(fileName, fileCache);
	}

	return [
		diagnostics.map(diagnostic => ({
			...diagnostic,
			file: {
				fileName: diagnostic.file.fileName,
				text: diagnostic.file.text,
			},
			relatedInformation: diagnostic.relatedInformation?.map(info => ({
				...info,
				file: info.file ? {
					fileName: info.file.fileName,
					text: info.file.text,
				} : undefined,
			})),
		})) as ts.DiagnosticWithLocation[],
		fileCache,
	] as const;
}

function lint(fileName: string, fileCache: core.FileLintCache) {
	return [
		linter.lint(fileName, fileCache).map(diagnostic => ({
			...diagnostic,
			file: {
				fileName: diagnostic.file.fileName,
				text: diagnostic.file.text,
			},
			relatedInformation: diagnostic.relatedInformation?.map(info => ({
				...info,
				file: info.file ? {
					fileName: info.file.fileName,
					text: info.file.text,
				} : undefined,
			})),
		})) as ts.DiagnosticWithLocation[],
		fileCache,
	] as const;
}

function hasCodeFixes(fileName: string) {
	return linter.hasCodeFixes(fileName);
}

function hasRules(fileName: string, minimatchCache: core.FileLintCache[4]) {
	return [Object.keys(linter.getRules(fileName, minimatchCache)).length > 0, minimatchCache] as const;
}
