import * as vscode from 'vscode';

export interface LanguageStrategy {
    readonly languageId: string;

    supports(languageId: string): boolean;

    extractTypeCandidates(code: string): string[];

    findEnclosingScope(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<{ className: string; methodName: string; range: vscode.Range } | undefined>;

    resolveModelDefinition(
        document: vscode.TextDocument,
        typeName: string,
        methodRange: vscode.Range
    ): Promise<{ name: string; filePath: string; code: string } | undefined>;

    resolveImplementationLocation(
        uri: vscode.Uri,
        position: vscode.Position
    ): Promise<{ uri: vscode.Uri; range: vscode.Range } | undefined>;
}
