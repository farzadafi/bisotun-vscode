import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import { crawlFlow } from './core/flowCrawler';
import { formatFlow } from './utils/formatter';
import { FlowCodeLensProvider } from './providers/flowCodeLensProvider';

export function activate(context: vscode.ExtensionContext): void {
  console.log('[Bisotun] Extension activated.');

  // رجیستر کردن CodeLens در صورت فعال بودن
  const config = vscode.workspace.getConfiguration('bisotun');
  if (config.get<boolean>('enableCodeLens', true)) {
    const selector: vscode.DocumentSelector = [
      { scheme: 'file', language: 'java' },
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'python' },
    ];
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(selector, new FlowCodeLensProvider())
    );
  }

  async function handleExtraction(
    targetUri?: vscode.Uri,
    targetPosition?: vscode.Position,
    customDepth?: number,
    rawOnly: boolean = false
  ) {
    vscode.window.showInformationMessage('Bisotun: Command triggered...');

    const editor = vscode.window.activeTextEditor;
    const document = targetUri
      ? await vscode.workspace.openTextDocument(targetUri)
      : editor?.document;

    const position = targetPosition ?? editor?.selection.active;

    if (!document || !position) {
      vscode.window.showErrorMessage('Bisotun: No active document or cursor position found.');
      return;
    }

    try {
      const maxDepth = customDepth ?? config.get<number>('maxDepth', 4);
      const useFallback = config.get<boolean>('useFallback', true);

      vscode.window.showInformationMessage(`Bisotun: Crawling line ${position.line + 1}...`);

      const nodes = await crawlFlow(document, position, { maxDepth, useFallback });

      if (!nodes || nodes.length === 0) {
        vscode.window.showWarningMessage('Bisotun: No methods found at the cursor position.');
        return;
      }

      const output = formatFlow(nodes, rawOnly ? 'raw' : 'markdown');
      await vscode.env.clipboard.writeText(output);
      vscode.window.showInformationMessage(`Bisotun: Success! Extracted ${nodes.length} nodes to clipboard.`);
    } catch (err: any) {
      console.error('[Bisotun] Error:', err);
      vscode.window.showErrorMessage(`Bisotun Exception: ${err?.message || err}`);
    }
  }

  // ثبت کامندها
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.copyDeepFlow, (uri?: vscode.Uri, pos?: vscode.Position) =>
      handleExtraction(uri, pos, 4, false)
    ),
    vscode.commands.registerCommand(COMMANDS.copyShallowFlow, (uri?: vscode.Uri, pos?: vscode.Position) =>
      handleExtraction(uri, pos, 1, false)
    ),
    vscode.commands.registerCommand(COMMANDS.copyCodeOnly, (uri?: vscode.Uri, pos?: vscode.Position) =>
      handleExtraction(uri, pos, 0, true)
    ),
    vscode.commands.registerCommand(COMMANDS.extractFlow, (uri?: vscode.Uri, pos?: vscode.Position) =>
      handleExtraction(uri, pos)
    )
  );
}

export function deactivate(): void {}
