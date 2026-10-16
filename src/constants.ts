import * as vscode from 'vscode';

export const COMMANDS = {
  extractFlow: 'bisotun.extractFlow',
  copyDeepFlow: 'bisotun.copyDeepFlow',
  copyShallowFlow: 'bisotun.copyShallowFlow',
  copyCodeOnly: 'bisotun.copyCodeOnly',
} as const;

export interface ExtractedMethod {
  className: string;
  methodName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  code: string;
  uri?: vscode.Uri;
}

export interface MethodSummary {
  className: string;
  methodName: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}
