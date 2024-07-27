export * from './lib/build';
export * from './lib/watch';

import type { Config, ProjectContext, Reporter, RuleContext, Rules } from '@tsslint/types';
import type * as ts from 'typescript';

import ErrorStackParser = require('error-stack-parser');
import path = require('path');
import minimatch = require('minimatch');

export type Linter = ReturnType<typeof createLinter>;

export function createLinter(ctx: ProjectContext, config: Config, withStack: boolean) {
	if (withStack) {
		require('source-map-support').install({
			retrieveFile(path: string) {
				// monkey-fix, refs: https://github.com/typescript-eslint/typescript-eslint/issues/9352
				if (path.replace(/\\/g, '/').includes('/@typescript-eslint/eslint-plugin/dist/rules/') && path.endsWith('.js.map')) {
					return JSON.stringify({
						version: 3,
						sources: [],
						sourcesContent: [],
						mappings: '',
						names: [],
					});
				}
			},
		});
	}
	const ts = ctx.typescript;
	const fileRules = new Map<string, Rules>();
	const fileFixes = new Map<string, Map<string, {
		diagnostic: ts.DiagnosticWithLocation;
		title: string;
		start: number;
		end: number;
		getEdits: () => ts.FileTextChanges[];
	}[]>>();
	const fileRefactors: typeof fileFixes = new Map();
	const sourceFiles = new Map<string, ts.SourceFile>();
	const plugins = (config.plugins ?? []).map(plugin => plugin(ctx));
	const excludes: string[] = [];

	for (let exclude of config.exclude ?? []) {
		const basePath = path.dirname(ctx.configFile);
		excludes.push(path.resolve(basePath, exclude));
	}

	return {
		lint(fileName: string) {
			if (excludes.some(pattern => minimatch.minimatch(fileName, pattern))) {
				return [];
			}

			const sourceFile = ctx.languageService.getProgram()?.getSourceFile(fileName);
			if (!sourceFile) {
				throw new Error(`No source file found for ${fileName}`);
			}

			const rulesContext: RuleContext = {
				...ctx,
				sourceFile,
				reportError,
				reportWarning,
				reportSuggestion,
			};
			const token = ctx.languageServiceHost.getCancellationToken?.();
			const rules = getFileRules(sourceFile.fileName);
			const fixes = getFileFixes(sourceFile.fileName);
			const refactors = getFileRefactors(sourceFile.fileName);

			let diagnostics: ts.DiagnosticWithLocation[] = [];
			let currentRuleId: string;

			fixes.clear();
			refactors.clear();

			for (const [id, rule] of Object.entries(rules)) {
				if (token?.isCancellationRequested()) {
					break;
				}
				currentRuleId = id;
				try {
					rule(rulesContext);
				} catch (err) {
					diagnostics.push({
						category: ts.DiagnosticCategory.Error,
						code: id as any,
						messageText: String(err),
						file: sourceFile,
						start: 0,
						length: 0,
						source: 'tsslint',
						relatedInformation: [],
					});
				}
			}

			for (const plugin of plugins) {
				if (plugin.resolveDiagnostics) {
					diagnostics = plugin.resolveDiagnostics(sourceFile.fileName, diagnostics);
				}
			}

			const diagnosticSet = new Set(diagnostics);

			for (const [ruleId, fix] of [...fixes]) {
				const final = fix.filter(fix => diagnosticSet.has(fix.diagnostic));
				if (final.length) {
					fixes.set(ruleId, final);
				}
				else {
					fixes.delete(ruleId);
				}
			}
			for (const [ruleId, refactor] of [...refactors]) {
				const final = refactor.filter(fix => diagnosticSet.has(fix.diagnostic));
				if (final.length) {
					refactors.set(ruleId, final);
				}
				else {
					refactors.delete(ruleId);
				}
			}

			return diagnostics;

			function reportError(message: string, start: number, end: number, traceOffset: false | number = 0) {
				return report(ts.DiagnosticCategory.Error, message, start, end, traceOffset);
			}

			function reportWarning(message: string, start: number, end: number, traceOffset: false | number = 0) {
				return report(ts.DiagnosticCategory.Warning, message, start, end, traceOffset);
			}

			function reportSuggestion(message: string, start: number, end: number, traceOffset: false | number = 0) {
				return report(ts.DiagnosticCategory.Suggestion, message, start, end, traceOffset);
			}

			function report(category: ts.DiagnosticCategory, message: string, start: number, end: number, traceOffset: false | number): Reporter {
				const error: ts.DiagnosticWithLocation = {
					category,
					code: currentRuleId as any,
					messageText: message,
					file: sourceFile!,
					start,
					length: end - start,
					source: 'tsslint',
					relatedInformation: [],
				};

				if (withStack) {
					const stacks = traceOffset === false
						? []
						: ErrorStackParser.parse(new Error());
					if (typeof traceOffset === 'number') {
						const baseOffset = 2 + traceOffset;
						if (stacks.length > baseOffset) {
							pushRelatedInformation(error, stacks[baseOffset]);
						}
					}
				}

				diagnostics.push(error);

				return {
					withDeprecated() {
						error.reportsDeprecated = true;
						return this;
					},
					withUnnecessary() {
						error.reportsUnnecessary = true;
						return this;
					},
					withFix(title, getEdits) {
						if (!fixes.has(currentRuleId)) {
							fixes.set(currentRuleId, []);
						}
						fixes.get(currentRuleId)!.push(({
							diagnostic: error,
							title,
							start,
							end,
							getEdits,
						}));
						return this;
					},
					withRefactor(title, getEdits) {
						if (!refactors.has(currentRuleId)) {
							refactors.set(currentRuleId, []);
						}
						refactors.get(currentRuleId)!.push(({
							diagnostic: error,
							title,
							start,
							end,
							getEdits,
						}));
						return this;
					},
				};
			}

			function pushRelatedInformation(error: ts.DiagnosticWithLocation, stack: ErrorStackParser.StackFrame) {
				if (stack.fileName && stack.lineNumber !== undefined && stack.columnNumber !== undefined) {
					let fileName = stack.fileName.replace(/\\/g, '/');
					if (fileName.startsWith('file://')) {
						fileName = fileName.substring('file://'.length);
					}
					if (fileName.includes('http-url:')) {
						fileName = fileName.split('http-url:')[1];
					}
					if (!sourceFiles.has(fileName)) {
						const text = ctx.languageServiceHost.readFile(fileName) ?? '';
						sourceFiles.set(
							fileName,
							ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
						);
					}
					const stackFile = sourceFiles.get(fileName);
					let pos = 0;
					try {
						pos = stackFile?.getPositionOfLineAndCharacter(stack.lineNumber - 1, stack.columnNumber - 1) ?? 0;
					} catch { }
					error.relatedInformation?.push({
						category: ts.DiagnosticCategory.Message,
						code: 0,
						file: stackFile,
						start: pos,
						length: 0,
						messageText: 'at ' + (stack.functionName ?? '<anonymous>'),
					});
				}
			}
		},
		hasCodeFixes(fileName: string) {

			const fixesMap = getFileFixes(fileName);

			for (const [_ruleId, fixes] of fixesMap) {
				if (fixes.length) {
					return true;
				}
			}

			return false;
		},
		getCodeFixes(fileName: string, start: number, end: number, diagnostics?: ts.Diagnostic[]) {

			const fixesMap = getFileFixes(fileName);

			let result: ts.CodeFixAction[] = [];

			for (const [ruleId, fixes] of fixesMap) {
				for (let i = 0; i < fixes.length; i++) {
					const fix = fixes[i];
					if (diagnostics?.length && !diagnostics.includes(fix.diagnostic)) {
						continue;
					}
					if (
						(fix.start >= start && fix.start <= end) ||
						(fix.end >= start && fix.end <= end) ||
						(start >= fix.start && start <= fix.end) ||
						(end >= fix.start && end <= fix.end)
					) {
						result.push({
							fixName: `tsslint:${ruleId}`,
							description: fix.title,
							changes: fix.getEdits(),
							fixId: 'tsslint',
							fixAllDescription: 'Fix all TSSLint errors'
						});
					}
				}
			}

			for (const plugin of plugins) {
				if (plugin.resolveCodeFixes) {
					result = plugin.resolveCodeFixes(fileName, result);
				}
			}

			return result;
		},
		getRefactors(fileName: string, start: number, end: number) {

			const refactorsMap = getFileRefactors(fileName);

			let result: ts.RefactorActionInfo[] = [];

			for (const [ruleId, refactors] of refactorsMap) {
				for (let i = 0; i < refactors.length; i++) {
					const refactor = refactors[i];
					if (
						(refactor.start >= start && refactor.start <= end) ||
						(refactor.end >= start && refactor.end <= end) ||
						(start >= refactor.start && start <= refactor.end) ||
						(end >= refactor.start && end <= refactor.end)
					) {
						result.push({
							name: `tsslint:${ruleId}:${i}`,
							description: refactor.title + ' (' + ruleId + ')',
							kind: 'quickfix',
						});
					}
				}
			}

			return result;
		},
		getRefactorEdits(fileName: string, name: string) {
			if (name.startsWith('tsslint:')) {
				const [ruleId, index] = name.slice('tsslint:'.length).split(':');
				const refactorsMap = getFileRefactors(fileName);
				const refactor = refactorsMap.get(ruleId)?.[Number(index)];
				if (refactor) {
					return refactor.getEdits();
				}
			}
		},
	};

	function getFileRules(fileName: string) {
		let rules = fileRules.get(fileName);
		if (!rules) {
			rules = { ...config.rules };
			for (const plugin of plugins) {
				if (plugin.resolveRules) {
					rules = plugin.resolveRules(fileName, rules);
				}
			}
			fileRules.set(fileName, rules);
		}
		return rules;
	}

	function getFileFixes(fileName: string) {
		if (!fileFixes.has(fileName)) {
			fileFixes.set(fileName, new Map());
		}
		return fileFixes.get(fileName)!;
	}

	function getFileRefactors(fileName: string) {
		if (!fileRefactors.has(fileName)) {
			fileRefactors.set(fileName, new Map());
		}
		return fileRefactors.get(fileName)!;
	}
}

export function combineCodeFixes(fileName: string, fixes: ts.CodeFixAction[]) {

	const changes = fixes
		.map(fix => fix.changes)
		.flat()
		.filter(change => change.fileName === fileName && change.textChanges.length)
		.sort((a, b) => b.textChanges[0].span.start - a.textChanges[0].span.start);

	let lastChangeAt = Number.MAX_VALUE;
	let finalTextChanges: ts.TextChange[] = [];

	for (const change of changes) {
		const textChanges = [...change.textChanges].sort((a, b) => a.span.start - b.span.start);
		const firstChange = textChanges[0];
		const lastChange = textChanges[textChanges.length - 1];
		if (lastChangeAt >= lastChange.span.start + lastChange.span.length) {
			lastChangeAt = firstChange.span.start;
			finalTextChanges = finalTextChanges.concat(textChanges);
		}
	}

	return finalTextChanges;
}

export function applyTextChanges(baseSnapshot: ts.IScriptSnapshot, textChanges: ts.TextChange[]): ts.IScriptSnapshot {
	textChanges = [...textChanges].sort((a, b) => b.span.start - a.span.start);
	let text = baseSnapshot.getText(0, baseSnapshot.getLength());
	for (const change of textChanges) {
		text = text.slice(0, change.span.start) + change.newText + text.slice(change.span.start + change.span.length);
	}
	return {
		getText(start, end) {
			return text.substring(start, end);
		},
		getLength() {
			return text.length;
		},
		getChangeRange(oldSnapshot) {
			if (oldSnapshot === baseSnapshot) {
				// TODO
			}
			return undefined;
		},
	};
}
