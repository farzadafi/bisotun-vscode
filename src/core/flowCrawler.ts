import * as vscode from 'vscode';
import { CycleDetector } from './cycleDetector';
import { resolveImplementation, findEnclosingScope } from './lspResolver';
import { findFallbackDefinition } from './fallbackResolver';
import { isExternalUri } from '../utils/filter';
import { ExtractedMethod } from '../constants';

export interface CrawlOptions {
  maxDepth: number;
  useFallback: boolean;
}

export async function crawlFlow(
  document: vscode.TextDocument,
  position: vscode.Position,
  options: CrawlOptions,
): Promise<ExtractedMethod[]> {
  const detector = new CycleDetector();
  const result: ExtractedMethod[] = [];

  const enclosingScope = await findEnclosingScope(document, position);

  if (!enclosingScope) {
    return result;
  }

  const methodCode = document.getText(enclosingScope.range);
  const languageId = getLanguageId(document.uri.fsPath);

  const rootKey = `${document.uri.toString()}#${enclosingScope.className}#${enclosingScope.methodName}`;
  detector.markVisited(rootKey);

  result.push({
    className: enclosingScope.className,
    methodName: enclosingScope.methodName,
    filePath: '',
    startLine: enclosingScope.range.start.line,
    endLine: enclosingScope.range.end.line,
    language: languageId,
    code: methodCode,
    uri: document.uri,
  });

  if (options.maxDepth > 0) {
    await crawlMethodBody(
      document,
      enclosingScope.range,
      1,
      options,
      detector,
      result,
    );
  }

  return result;
}

async function crawlMethodBody(
  document: vscode.TextDocument,
  methodRange: vscode.Range,
  depth: number,
  options: CrawlOptions,
  detector: CycleDetector,
  result: ExtractedMethod[],
): Promise<void> {
  if (depth > options.maxDepth) {
    return;
  }

  const calls = extractCallPositions(document, methodRange);

  for (const call of calls) {
    let definition = await resolveImplementation(document, call.position);

    if (!definition && options.useFallback) {
      const line = document.lineAt(call.position.line).text;
      const symbolName = extractSymbolAtPosition(line, call.position.character);
      if (symbolName) {
        definition = await findFallbackDefinition(symbolName);
      }
    }

    if (!definition || isExternalUri(definition.uri)) {
      continue;
    }

    const targetDocument = await vscode.workspace.openTextDocument(definition.uri);
    const scope = await findEnclosingScope(targetDocument, definition.range.start);

    if (!scope) {
      continue;
    }

    const key = `${targetDocument.uri.toString()}#${scope.className}#${scope.methodName}`;
    if (detector.hasVisited(key)) {
      continue;
    }
    detector.markVisited(key);

    const methodCode = targetDocument.getText(scope.range);
    const languageId = getLanguageId(targetDocument.uri.fsPath);

    result.push({
      className: scope.className,
      methodName: scope.methodName,
      filePath: '',
      startLine: scope.range.start.line,
      endLine: scope.range.end.line,
      language: languageId,
      code: methodCode,
      uri: targetDocument.uri,
    });

    if (depth < options.maxDepth) {
      await crawlMethodBody(
        targetDocument,
        scope.range,
        depth + 1,
        options,
        detector,
        result,
      );
    }
  }
}

function extractCallPositions(
  document: vscode.TextDocument,
  range: vscode.Range,
): { position: vscode.Position }[] {
  const calls: { position: vscode.Position }[] = [];
  const text = document.getText(range);
  const startOffset = document.offsetAt(range.start);

  const regex = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const symbol = match[1];
    const matchIndex = match.index;

    if (!isLikelyMethodCall(text, matchIndex, symbol)) {
      continue;
    }

    const matchOffset = startOffset + matchIndex;
    const position = document.positionAt(matchOffset);
    calls.push({ position });
  }

  return calls;
}

function isLikelyMethodCall(text: string, index: number, symbol: string): boolean {
  const keywords = new Set([
    'if', 'while', 'for', 'switch', 'catch', 'synchronized',
    'new', 'return', 'throw', 'instanceof', 'typeof',
    'super', 'this', 'class', 'interface', 'enum',
  ]);

  if (keywords.has(symbol)) {
    return false;
  }

  let lookback = index - 1;
  while (lookback >= 0 && /\s/.test(text[lookback])) {
    lookback--;
  }
  if (lookback >= 0 && text[lookback] === '@') {
    return false;
  }

  return true;
}

function extractSymbolAtPosition(
  line: string,
  character: number,
): string | undefined {
  const left = line.slice(0, character);
  const right = line.slice(character);

  const leftMatch = left.match(/[A-Za-z_$][\w$]*$/);
  const rightMatch = right.match(/^[A-Za-z_$][\w$]*/);

  const symbol = `${leftMatch?.[0] ?? ''}${rightMatch?.[0] ?? ''}`;
  return symbol || undefined;
}

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
