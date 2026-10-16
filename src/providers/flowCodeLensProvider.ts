import * as vscode from 'vscode';
import { COMMANDS } from '../constants';

export class FlowCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(
    document: vscode.TextDocument,
  ): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];

    for (let line = 0; line < document.lineCount; line++) {
      const text = document.lineAt(line).text;

      // تشخیص خط تعریف متد یا تابع بدون بلوک کردن ترد با LSP
      if (!/\b(class|def|function|public|private|protected)\b/.test(text)) {
        continue;
      }

      const range = new vscode.Range(line, 0, line, text.length);

      lenses.push(
        new vscode.CodeLens(range, {
          title: 'Alamut: Copy Deep Flow',
          command: COMMANDS.copyDeepFlow,
          arguments: [document.uri, new vscode.Position(line, 0)],
        }),
        new vscode.CodeLens(range, {
          title: 'Alamut: Copy Shallow Flow',
          command: COMMANDS.copyShallowFlow,
          arguments: [document.uri, new vscode.Position(line, 0)],
        }),
      );
    }

    return lenses;
  }
}
