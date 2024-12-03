import esbuild = require('esbuild');
import _path = require('path');
import fs = require('fs');
import url = require('url');
import type { Config } from '@tsslint/config';
import ErrorStackParser = require('error-stack-parser');

export async function watchConfigFile(
	configFilePath: string,
	onBuild: (config: Config | Config[] | undefined, result: esbuild.BuildResult) => void,
	watch = true,
	createHash: (path: string) => string = btoa,
	logger: Pick<typeof console, 'log' | 'warn' | 'error'> = console
) {
	let start: number;
	const outDir = getDotTsslintPath(configFilePath);
	const outFileName = createHash(_path.relative(outDir, configFilePath)) + '.mjs';
	const outFile = _path.join(outDir, outFileName);
	const resultHandler = async (result: esbuild.BuildResult) => {
		const t1 = Date.now() - start;
		start = Date.now();
		let config: Config | undefined;
		for (const error of [
			...result.errors,
			...result.warnings,
		]) {
			if (error.id) {
				error.id = 'esbuild:' + error.id;
			}
			else {
				error.id = 'config-build-error';
			}
		}
		if (!result.errors.length) {
			try {
				config = (await import(url.pathToFileURL(outFile).toString() + '?time=' + Date.now())).default;
			} catch (e: any) {
				if (e.stack) {
					const stack = ErrorStackParser.parse(e)[0];
					if (stack.fileName && stack.lineNumber !== undefined && stack.columnNumber !== undefined) {
						let fileName = stack.fileName
							.replace(/\\/g, '/')
							.split('?time=')[0];
						if (fileName.startsWith('file://')) {
							fileName = fileName.substring('file://'.length);
						}
						result.errors.push({
							id: 'config-import-error',
							text: String(e),
							location: {
								file: fileName,
								line: stack.lineNumber,
								column: stack.columnNumber - 1,
								lineText: '',
							},
						} as any);
					} else {
						result.errors.push({
							id: 'config-import-error',
							text: String(e),
						} as any);
					}
				} else {
					result.errors.push({
						id: 'config-import-error',
						text: String(e),
					} as any);
				}
			}
		}
		const t2 = Date.now() - start;
		logger.log(`Built ${_path.relative(process.cwd(), configFilePath)} in ${t1}ms, loaded ${config ? 'successfully' : 'with errors'} in ${t2}ms`);
		onBuild(config, result);
	};
	const ctx = await esbuild.context({
		entryPoints: [configFilePath],
		bundle: true,
		sourcemap: true,
		outfile: outFile,
		format: 'esm',
		platform: 'node',
		plugins: [{
			name: 'tsslint',
			setup(build) {
				build.onStart(() => {
					start = Date.now();
				});
				build.onResolve({ filter: /^https?:\/\// }, async ({ path: url }) => {
					const cachePath = _path.join(outDir, url.split('://')[0], ...url.split('://')[1].split('/'));
					if (!fs.existsSync(cachePath)) {
						console.time('Download ' + url);
						const response = await fetch(url);
						if (!response.ok) {
							throw new Error(`Failed to load ${url}`);
						}
						console.timeEnd('Download ' + url);
						const text = await response.text();
						fs.mkdirSync(_path.dirname(cachePath), { recursive: true });
						fs.writeFileSync(cachePath, text, 'utf8');
					}
					return {
						path: cachePath,
						external: !isTsFile(cachePath),
					};
				});
				build.onResolve({ filter: /.*/ }, ({ path, resolveDir }) => {
					if (!isTsFile(path)) {
						try {
							const maybeJsPath = require.resolve(path, { paths: [resolveDir] });
							if (!isTsFile(maybeJsPath) && fs.existsSync(maybeJsPath)) {
								return {
									path: url.pathToFileURL(maybeJsPath).toString(),
									external: true,
								};
							}
						} catch { }
					}
					return {};
				});
				if (watch) {
					build.onEnd(resultHandler);
				}
			},
		}],
	});
	if (watch) {
		await ctx.watch();
	}
	else {
		const result = await ctx.rebuild();
		await ctx.dispose();
		resultHandler(result);
	}
	return ctx;
}

function isTsFile(path: string) {
	return path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.cts') || path.endsWith('.mts');
}

export function getDotTsslintPath(configFilePath: string): string {
	return _path.resolve(configFilePath, '..', 'node_modules', '.tsslint');
}
