import * as vscode from 'vscode';
import { isExternalUri } from '../utils/filter';

export async function findFallbackDefinition(
  symbolName: string,
): Promise<{ uri: vscode.Uri; range: vscode.Range; code: string } | undefined> {
  const files = await vscode.workspace.findFiles(
    '**/*.{java,py,js,jsx,ts,tsx}',
    '**/{node_modules,dist,build,target,.venv,venv}/**',
    500,
  );

  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const patterns = [
    new RegExp(`\\b(class|interface|enum)\\s+${escaped}\\b`),
    new RegExp(`\\b${escaped}\\s*\\(`),
    new RegExp(`\\b(def|function)\\s+${escaped}\\b`),
  ];

  for (const uri of files) {
    if (isExternalUri(uri)) {
      continue;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();

    for (const pattern of patterns) {
      const match = pattern.exec(text);

      if (!match || match.index === undefined) {
        continue;
      }

      const start = document.positionAt(match.index);
      const end = findBlockEnd(document, start);

      return {
        uri,
        range: new vscode.Range(start, end),
        code: document.getText(new vscode.Range(start, end)),
      };
    }
  }

  return undefined;
}

function findBlockEnd(
  document: vscode.TextDocument,
  start: vscode.Position,
): vscode.Position {
  let braceCount = 0;
  let started = false;

  for (let line = start.line; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;

    for (const char of text) {
      if (char === '{') {
        braceCount++;
        started = true;
      } else if (char === '}') {
        braceCount--;

        if (started && braceCount === 0) {
          return new vscode.Position(line, text.length);
        }
      }
    }

    if (!started && line > start.line + 30) {
      return new vscode.Position(line, text.length);
    }
  }

  return new vscode.Position(document.lineCount - 1, 0);
}
