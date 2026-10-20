import * as vscode from 'vscode';

export interface EnclosingScope {
  className: string;
  methodName: string;
  range: vscode.Range;
}

export interface ModelDefinition {
  name: string;
  filePath: string;
  code: string;
}

export interface ImplementationLocation {
  uri: vscode.Uri;
  range: vscode.Range;
}

export interface FallbackCall {
  uri: vscode.Uri;
  range: vscode.Range;
  name: string;
  detail?: string;
}

export interface LanguageStrategy {
  readonly languageId: string;

  supports(languageId: string): boolean;

  extractTypeCandidates(code: string): string[];

  findEnclosingScope(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<EnclosingScope | undefined>;

  resolveModelDefinition(
    document: vscode.TextDocument,
    typeName: string,
    methodRange: vscode.Range
  ): Promise<ModelDefinition | undefined>;

  resolveImplementationLocation(
    uri: vscode.Uri,
    position: vscode.Position
  ): Promise<ImplementationLocation | undefined>;

  resolveFallbackCalls?(
    document: vscode.TextDocument,
    methodRange: vscode.Range
  ): Promise<FallbackCall[]>;
}
