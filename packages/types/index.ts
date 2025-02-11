import type {
	CodeFixAction,
	Diagnostic,
	DiagnosticWithLocation,
	FileTextChanges,
	LanguageService,
	LanguageServiceHost,
	SourceFile,
} from 'typescript';

export interface ProjectContext {
	typescript: typeof import('typescript');
	languageServiceHost: LanguageServiceHost;
	languageService: LanguageService;
}

export interface Config {
	include?: string[];
	exclude?: string[];
	rules?: Rules;
	plugins?: Plugin[];
	formatting?: FormattingProcess[];
}

export interface Plugin {
	(ctx: ProjectContext): PluginInstance;
}

export interface FormattingProcess {
	(ctx: FormattingContext): void;
}

export interface FormattingContext {
	typescript: typeof import('typescript');
	sourceFile: SourceFile;
	insert(pos: number, text: string): void;
	remove(start: number, end: number): void;
	replace(start: number, end: number, text: string): void;
}

export interface PluginInstance {
	resolveRules?(fileName: string, rules: Record<string, Rule>): Record<string, Rule>;
	resolveDiagnostics?(sourceFile: SourceFile, diagnostics: DiagnosticWithLocation[]): DiagnosticWithLocation[];
	resolveCodeFixes?(sourceFile: SourceFile, diagnostic: Diagnostic, codeFixes: CodeFixAction[]): CodeFixAction[];
}

export interface Rules {
	[name: string]: Rule | Rules;
}

export interface Rule {
	(ctx: RuleContext): void;
}

export interface RuleContext {
	typescript: typeof import('typescript');
	languageServiceHost: LanguageServiceHost;
	languageService: LanguageService;
	sourceFile: SourceFile;
	reportError(message: string, start: number, end: number, stackOffset?: number | false): Reporter;
	reportWarning(message: string, start: number, end: number, stackOffset?: number | false): Reporter;
	reportSuggestion(message: string, start: number, end: number, stackOffset?: number | false): Reporter;
}

export interface Reporter {
	withDeprecated(): Reporter;
	withUnnecessary(): Reporter;
	withFix(title: string, getChanges: () => FileTextChanges[]): Reporter;
	withRefactor(title: string, getChanges: () => FileTextChanges[]): Reporter;
}
