import * as vscode from 'vscode';

export function isExternalUri(uri: vscode.Uri): boolean {
  const path = uri.fsPath.replace(/\\/g, '/');

  return (
    path.includes('/node_modules/') ||
    path.includes('/site-packages/') ||
    path.includes('/.venv/') ||
    path.includes('/venv/') ||
    path.includes('/target/') ||
    path.includes('/build/') ||
    path.includes('/dist/') ||
    path.endsWith('.jar')
  );
}

export function isSupportedDocument(document: vscode.TextDocument): boolean {
  return ['java', 'python', 'javascript', 'typescript'].includes(
    document.languageId,
  );
}
