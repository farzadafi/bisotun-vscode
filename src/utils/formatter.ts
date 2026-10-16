import * as vscode from 'vscode';
import { ExtractedMethod, MethodSummary } from '../constants';
import { countTokens } from './tokenCounter';

const BT3 = String.fromCharCode(96, 96, 96);

function getLanguageId(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    java: 'java',
    py: 'python',
    js: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    jsx: 'javascript',
    kt: 'kotlin',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
  };
  return languageMap[ext ?? ''] || 'text';
}

function getRelativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

export function formatFlow(
  arg1: ExtractedMethod | any[],
  arg2: ExtractedMethod[] | 'markdown' | 'raw',
  arg3?: number,
): string {
  if (Array.isArray(arg1) && (arg2 === 'markdown' || arg2 === 'raw')) {
    const nodes = arg1 as any[];
    if (arg2 === 'raw') {
      return nodes.map((n) => n.code || '').join('\n\n');
    }
    const root = nodes[0];
    const deps = nodes.slice(1);
    if (!root) {
      return '';
    }

    const rootMethod: ExtractedMethod = {
      className: root.className || '',
      methodName: root.methodName || '',
      filePath: root.uri ? getRelativePath(root.uri) : root.filePath || '',
      startLine: root.startLine ?? 0,
      endLine: root.endLine ?? 0,
      language: root.language || getLanguageId(root.filePath || ''),
      code: root.code || '',
    };

    const dependencies: ExtractedMethod[] = deps.map((d: any) => ({
      className: d.className || '',
      methodName: d.methodName || '',
      filePath: d.uri ? getRelativePath(d.uri) : d.filePath || '',
      startLine: d.startLine ?? 0,
      endLine: d.endLine ?? 0,
      language: d.language || getLanguageId(d.filePath || ''),
      code: d.code || '',
    }));

    return buildAndFormatMarkdown(rootMethod, dependencies);
  }

  return formatFlowOutput(arg1 as ExtractedMethod, arg2 as ExtractedMethod[], arg3 ?? 0);
}

function buildAndFormatMarkdown(
  rootMethod: ExtractedMethod,
  dependencies: ExtractedMethod[],
): string {
  const initialOutput = formatFlowOutput(rootMethod, dependencies, 0);
  const tokenCount = countTokens(initialOutput);
  return formatFlowOutput(rootMethod, dependencies, tokenCount);
}

export function formatFlowOutput(
  rootMethod: ExtractedMethod,
  dependencies: ExtractedMethod[],
  tokenCount: number,
): string {
  const parts: string[] = [];

  parts.push('# Context Flow Extracted by Bisotun');
  parts.push(`- Root Target: \`${rootMethod.className}#${rootMethod.methodName}\``);
  parts.push(`- Extracted Nodes: ${dependencies.length + 1}`);
  parts.push(`- Estimated Tokens: ~${tokenCount}`);
  parts.push('');

  parts.push('## Root Method');
  parts.push(`### \`${rootMethod.className}#${rootMethod.methodName}\``);
  parts.push(`- File: \`${rootMethod.filePath}\``);
  parts.push(`- Lines: ${rootMethod.startLine + 1}-${rootMethod.endLine + 1}`);
  parts.push('');
  parts.push(BT3 + rootMethod.language);
  parts.push(rootMethod.code);
  parts.push(BT3);
  parts.push('');

  if (dependencies.length > 0) {
    parts.push('## Execution Dependencies & Models');
    for (const dep of dependencies) {
      parts.push(`### \`${dep.className}#${dep.methodName}\``);
      parts.push(`- File: \`${dep.filePath}\``);
      parts.push(`- Lines: ${dep.startLine + 1}-${dep.endLine + 1}`);
      parts.push('');
      parts.push(BT3 + dep.language);
      parts.push(dep.code);
      parts.push(BT3);
      parts.push('');
    }
  }

  return parts.join('\n');
}

export function formatMethodSummary(summary: MethodSummary): string {
  return `${summary.className}#${summary.methodName} (${summary.startLine + 1}-${summary.endLine + 1}) ~${summary.tokenCount} tokens`;
}
