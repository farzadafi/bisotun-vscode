import * as vscode from 'vscode';
import { strategyRegistry } from '../strategies/strategyRegistry';
import { isWorkspaceUri } from '../utils/filter';

export interface FlowNode {
  className: string;
  methodName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  code: string;
  depth: number;
  uri?: vscode.Uri;
}

export interface ExtractedModel {
  name: string;
  filePath: string;
  code: string;
}

export interface FlowResult {
  nodes: FlowNode[];
  models: ExtractedModel[];
}

interface QueueItem {
  uri: vscode.Uri;
  range: vscode.Range;
  depth: number;
  methodName?: string;
  selectionRange?: vscode.Range;
}

function isSameRange(first: vscode.Range, second: vscode.Range): boolean {
  return (
    first.start.line === second.start.line &&
    first.start.character === second.start.character &&
    first.end.line === second.end.line &&
    first.end.character === second.end.character
  );
}

/**
 * Key یکتا برای یک سمبل/متد:
 * بر اساس URI + name + position (برای جلوگیری قطعی از تکرار نودها)
 */
function createSymbolKey(uri: vscode.Uri, name: string, position: vscode.Position): string {
  return [uri.toString(), name, position.line, position.character].join('#');
}

function addPositionIfUnique(positions: vscode.Position[], position: vscode.Position): void {
  const exists = positions.some(item => item.line === position.line && item.character === position.character);
  if (!exists) {
    positions.push(position);
  }
}

function findSymbolPositions(
  document: vscode.TextDocument,
  range: vscode.Range,
  symbolName?: string
): vscode.Position[] {
  const positions: vscode.Position[] = [];

  const startLine = Math.max(0, range.start.line);
  const endLine = Math.min(document.lineCount - 1, range.end.line);

  if (!symbolName) {
    return positions;
  }

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    const lineText = document.lineAt(lineNumber).text;

    let searchStart = 0;
    while (searchStart < lineText.length) {
      const index = lineText.indexOf(symbolName, searchStart);
      if (index < 0) break;

      const before = index > 0 ? lineText[index - 1] : '';
      const after = lineText[index + symbolName.length] ?? '';

      const validBefore = before.length === 0 || !/[A-Za-z0-9_$]/.test(before);
      const validAfter = after.length === 0 || !/[A-Za-z0-9_$]/.test(after);

      if (validBefore && validAfter) {
        addPositionIfUnique(positions, new vscode.Position(lineNumber, index));
      }

      searchStart = index + symbolName.length;
    }
  }

  return positions;
}

function findFallbackPositions(document: vscode.TextDocument, range: vscode.Range): vscode.Position[] {
  const positions: vscode.Position[] = [];

  const startLine = Math.max(0, range.start.line);
  const endLine = Math.min(document.lineCount - 1, range.end.line);

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    const lineText = document.lineAt(lineNumber).text;
    const firstNonWhitespace = lineText.search(/\S/);

    if (firstNonWhitespace >= 0) {
      addPositionIfUnique(positions, new vscode.Position(lineNumber, firstNonWhitespace));
    }
  }

  return positions;
}

async function prepareCallHierarchyAtBestPosition(
  document: vscode.TextDocument,
  range: vscode.Range,
  methodName?: string,
  selectionRange?: vscode.Range
): Promise<vscode.CallHierarchyItem[]> {
  const positions: vscode.Position[] = [];

  if (selectionRange) {
    addPositionIfUnique(positions, selectionRange.start);
  }

  for (const position of findSymbolPositions(document, range, methodName)) {
    addPositionIfUnique(positions, position);
  }

  addPositionIfUnique(positions, range.start);

  for (const position of findFallbackPositions(document, range)) {
    addPositionIfUnique(positions, position);
  }

  for (const position of positions) {
    try {
      const callItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        document.uri,
        position
      );

      if (callItems && callItems.length > 0) {
        return callItems;
      }
    } catch {
      // تلاش با موقعیت بعدی
    }
  }

  return [];
}

export async function crawlFlow(
  document: vscode.TextDocument,
  position: vscode.Position,
  options: { maxDepth: number; useFallback: boolean }
): Promise<FlowResult> {
  const rootStrategy = strategyRegistry.getStrategy(document.languageId);

  if (!rootStrategy) {
    console.warn(`[Bisotun] No strategy registered for language: ${document.languageId}`);
    return { nodes: [], models: [] };
  }

  const nodes: FlowNode[] = [];
  const visited = new Set<string>();
  const scheduled = new Set<string>();

  const rootScope = await rootStrategy.findEnclosingScope(document, position);
  if (!rootScope) {
    return { nodes: [], models: [] };
  }

  const rootCode = document.getText(rootScope.range);
  const rootPos = (rootScope as any).selectionRange?.start ?? rootScope.range.start;
  const rootKey = createSymbolKey(document.uri, rootScope.methodName, rootPos);

  visited.add(rootKey);
  scheduled.add(rootKey);

  nodes.push({
    className: rootScope.className,
    methodName: rootScope.methodName,
    filePath: vscode.workspace.asRelativePath(document.uri),
    startLine: rootScope.range.start.line + 1,
    endLine: rootScope.range.end.line + 1,
    language: document.languageId,
    code: rootCode.trim(),
    depth: 0,
    uri: document.uri,
  });

  const queue: QueueItem[] = [
    {
      uri: document.uri,
      range: rootScope.range,
      depth: 0,
      methodName: rootScope.methodName,
      selectionRange: (rootScope as any).selectionRange,
    },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= options.maxDepth) continue;

    try {
      const currentDoc = await vscode.workspace.openTextDocument(current.uri);
      const currentStrategy = strategyRegistry.getStrategy(currentDoc.languageId) ?? rootStrategy;

      const callItems = await prepareCallHierarchyAtBestPosition(
        currentDoc,
        current.range,
        current.methodName,
        current.selectionRange
      );

      const outgoingCalls: Array<{
        uri: vscode.Uri;
        range: vscode.Range;
        selectionRange?: vscode.Range;
        name: string;
        detail?: string;
      }> = [];

      if (callItems.length > 0) {
        const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
          'vscode.provideOutgoingCalls',
          callItems[0]
        );

        for (const call of outgoing ?? []) {
          outgoingCalls.push({
            uri: call.to.uri,
            range: call.to.range,
            selectionRange: call.to.selectionRange,
            name: call.to.name,
            detail: call.to.detail,
          });
        }
      }

      if (options.useFallback && currentStrategy.resolveFallbackCalls) {
        const fallbackCalls = await currentStrategy.resolveFallbackCalls(currentDoc, current.range);
        outgoingCalls.push(...fallbackCalls);
      }

      const processedTargets = new Set<string>();

      for (const target of outgoingCalls) {
        if (!isWorkspaceUri(target.uri)) continue;

        const cleanName = target.name.replace(/^#/, '');

        // جلوگیری از ثبت Constructor به عنوان متد معمولی
        if (/^[A-Z]/.test(cleanName) && target.name === cleanName) {
          continue;
        }

        const targetPos = target.selectionRange?.start ?? target.range.start;
        const targetKey = createSymbolKey(target.uri, target.name, targetPos);

        if (processedTargets.has(targetKey)) continue;
        processedTargets.add(targetKey);

        let crawlTargetUri = target.uri;
        let crawlTargetRange = target.range;
        let crawlTargetMethodName = target.name;
        let crawlTargetSelectionRange = target.selectionRange;

        if (!visited.has(targetKey)) {
          visited.add(targetKey);

          const targetDoc = await vscode.workspace.openTextDocument(target.uri);

          nodes.push({
            className: target.detail || '',
            methodName: target.name,
            filePath: vscode.workspace.asRelativePath(target.uri),
            startLine: target.range.start.line + 1,
            endLine: target.range.end.line + 1,
            language: targetDoc.languageId,
            code: targetDoc.getText(target.range).trim(),
            depth: current.depth + 1,
            uri: target.uri,
          });
        }

        const targetDocForStrategy = await vscode.workspace.openTextDocument(target.uri);
        const targetStrategy = strategyRegistry.getStrategy(targetDocForStrategy.languageId) ?? rootStrategy;

        const impl = await targetStrategy.resolveImplementationLocation(
          target.uri,
          target.selectionRange?.start ?? target.range.start
        );

        if (impl) {
          const implDoc = await vscode.workspace.openTextDocument(impl.uri);
          const implScope = await targetStrategy.findEnclosingScope(implDoc, impl.range.start);

          const effectiveRange = implScope?.range ?? impl.range;
          const effectiveClassName = implScope?.className ?? '';
          const effectiveMethodName = implScope?.methodName ?? target.name;

          const implementationChanged =
            impl.uri.toString() !== target.uri.toString() || !isSameRange(impl.range, target.range);

          if (implementationChanged) {
            const implPos = (implScope as any)?.selectionRange?.start ?? effectiveRange.start;
            const implKey = createSymbolKey(impl.uri, effectiveMethodName, implPos);

            if (!visited.has(implKey)) {
              visited.add(implKey);

              nodes.push({
                className: effectiveClassName,
                methodName: effectiveMethodName,
                filePath: vscode.workspace.asRelativePath(impl.uri),
                startLine: effectiveRange.start.line + 1,
                endLine: effectiveRange.end.line + 1,
                language: implDoc.languageId,
                code: implDoc.getText(effectiveRange).trim(),
                depth: current.depth + 1,
                uri: impl.uri,
              });
            }

            crawlTargetUri = impl.uri;
            crawlTargetRange = effectiveRange;
            crawlTargetMethodName = effectiveMethodName;
            crawlTargetSelectionRange = (implScope as any)?.selectionRange;
          }
        }

        const crawlPos = crawlTargetSelectionRange?.start ?? crawlTargetRange.start;
        const nextKey = createSymbolKey(crawlTargetUri, crawlTargetMethodName, crawlPos);

        if (!scheduled.has(nextKey)) {
          scheduled.add(nextKey);

          queue.push({
            uri: crawlTargetUri,
            range: crawlTargetRange,
            depth: current.depth + 1,
            methodName: crawlTargetMethodName,
            selectionRange: crawlTargetSelectionRange,
          });
        }
      }
    } catch (error) {
      console.warn('[Bisotun] Call hierarchy error:', error);
    }
  }

  // استخراج DTOها / مدل‌ها
  const models: ExtractedModel[] = [];
  const processedModels = new Set<string>();

  for (const node of nodes) {
    if (!node.uri) continue;

    const nodeDoc = await vscode.workspace.openTextDocument(node.uri);
    const nodeStrategy = strategyRegistry.getStrategy(node.language) ?? rootStrategy;

    const candidateTypes = nodeStrategy.extractTypeCandidates(node.code);

    const range = new vscode.Range(
      new vscode.Position(node.startLine - 1, 0),
      new vscode.Position(node.endLine - 1, 0)
    );

    for (const typeName of candidateTypes) {
      if (processedModels.has(typeName) || typeName === node.className) continue;

      processedModels.add(typeName);

      const resolved = await nodeStrategy.resolveModelDefinition(nodeDoc, typeName, range);
      if (resolved) {
        models.push(resolved);
      }
    }
  }

  return { nodes, models };
}
