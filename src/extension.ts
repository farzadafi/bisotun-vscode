import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import { crawlFlow } from './core/flowCrawler';
import { formatFlow } from './utils/formatter';

export function activate(context: vscode.ExtensionContext): void {
  console.log('[Bisotun] Extension activated.');

  const config = vscode.workspace.getConfiguration('bisotun');

  async function validateEnvironment(document: vscode.TextDocument): Promise<boolean> {
    if (document.languageId === 'java') {
      const redhatExt = vscode.extensions.getExtension('redhat.java');
      if (!redhatExt) {
        const choice = await vscode.window.showErrorMessage(
          'Bisotun requires "Language Support for Java by Red Hat" extension to analyze Java projects.',
          'Install Extension'
        );
        if (choice === 'Install Extension') {
          vscode.commands.executeCommand('workbench.extensions.installExtension', 'redhat.java');
        }
        return false;
      }

      if (!redhatExt.isActive) {
        const choice = await vscode.window.showWarningMessage(
          'Java Language Support is currently initializing or disabled.',
          'Activate Now'
        );
        if (choice === 'Activate Now') {
          await redhatExt.activate();
          return true;
        }
        return false;
      }
    }
    return true;
  }

  async function handleExtraction(
    targetUri?: vscode.Uri,
    targetPosition?: vscode.Position,
    customDepth?: number,
    rawOnly: boolean = false
  ) {    const editor = vscode.window.activeTextEditor;
    const document = targetUri
      ? await vscode.workspace.openTextDocument(targetUri)
      : editor?.document;

    const position = targetPosition ?? editor?.selection.active;

    if (!document || !position) {
      vscode.window.showErrorMessage('Bisotun: No active document or cursor position found.');
      return;
    }

    const isValid = await validateEnvironment(document);
    if (!isValid) {
      return;
    }

    try {
      const maxDepth = customDepth ?? config.get<number>('maxDepth', 4);
      const useFallback = config.get<boolean>('useFallback', true);

      const flowResult = await crawlFlow(document, position, { maxDepth, useFallback });

      if (!flowResult.nodes || flowResult.nodes.length === 0) {
        vscode.window.showWarningMessage('Bisotun: No methods found at the cursor position.');
        return;
      }

      const output = formatFlow(flowResult, rawOnly ? 'raw' : 'markdown');
      await vscode.env.clipboard.writeText(output);
      vscode.window.showInformationMessage(
        `Bisotun: Extracted ${flowResult.nodes.length} methods & ${flowResult.models.length} models to clipboard!`
      );
    } catch (err: any) {
      console.error('[Bisotun] Error:', err);
      vscode.window.showErrorMessage(`Bisotun Exception: ${err?.message || err}`);
    }
  }

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
