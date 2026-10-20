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

export function isWorkspaceUri(uri: vscode.Uri): boolean {
  if (isExternalUri(uri)) {
    return false;
  }

  const fsPath = uri.fsPath || uri.path;

  if (
    fsPath.includes('.jar!') ||
    fsPath.includes('.jar/') ||
    fsPath.endsWith('.jar')
  ) {
    return false;
  }

  return vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

export function isSupportedDocument(
  document: vscode.TextDocument,
): boolean {
  return [
    'java',
    'python',
    'javascript',
    'typescript',
    'javascriptreact',
    'typescriptreact',
  ].includes(document.languageId);
}
