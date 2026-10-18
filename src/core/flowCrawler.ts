import * as vscode from 'vscode';
import { strategyRegistry } from '../strategies/strategyRegistry';
import { isWorkspaceUri } from '../strategies/javaStrategy';

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

export async function crawlFlow(
  document: vscode.TextDocument,
  position: vscode.Position,
  options: { maxDepth: number; useFallback: boolean }
): Promise<FlowResult> {
  const strategy = strategyRegistry.getStrategy(document.languageId);
  if (!strategy) {
    console.warn(`[Bisotun] No strategy registered for language: ${document.languageId}`);
    return { nodes: [], models: [] };
  }

  const nodes: FlowNode[] = [];
  const visited = new Set<string>();

  const rootScope = await strategy.findEnclosingScope(document, position);
  if (!rootScope) {
    return { nodes: [], models: [] };
  }

  const rootCode = document.getText(rootScope.range);
  const rootKey = `${document.uri.toString()}#${rootScope.methodName}#${rootScope.range.start.line}`;
  visited.add(rootKey);

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

  const queue: Array<{ uri: vscode.Uri; range: vscode.Range; depth: number }> = [
    { uri: document.uri, range: rootScope.range, depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= options.maxDepth) {
      continue;
    }

    try {
      const callItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        current.uri,
        current.range.start
      );

      if (callItems && callItems.length > 0) {
        const outgoing = await vscode.commands.executeCommand<
          vscode.CallHierarchyOutgoingCall[]
        >('vscode.provideOutgoingCalls', callItems[0]);

        if (outgoing) {
          for (const call of outgoing) {
            const target = call.to;

            if (!isWorkspaceUri(target.uri)) {
              continue;
            }

            const targetKey = `${target.uri.toString()}#${target.name}#${target.range.start.line}`;
            let crawlTargetUri = target.uri;
            let crawlTargetRange = target.range;

            if (!visited.has(targetKey)) {
              visited.add(targetKey);
              const targetDoc = await vscode.workspace.openTextDocument(target.uri);
              const methodCode = targetDoc.getText(target.range).trim();

              nodes.push({
                className: target.detail || '',
                methodName: target.name,
                filePath: vscode.workspace.asRelativePath(target.uri),
                startLine: target.range.start.line + 1,
                endLine: target.range.end.line + 1,
                language: targetDoc.languageId,
                code: methodCode,
                depth: current.depth + 1,
                uri: target.uri,
              });
            }

            // بررسی پیاده‌سازی متد اینترفیس
            const impl = await strategy.resolveImplementationLocation(
              target.uri,
              target.selectionRange?.start ?? target.range.start
            );

            if (impl && impl.uri.toString() !== target.uri.toString()) {
              const implDoc = await vscode.workspace.openTextDocument(impl.uri);
              const implScope = await strategy.findEnclosingScope(implDoc, impl.range.start);

              const effectiveRange = implScope ? implScope.range : impl.range;
              const effectiveClassName = implScope ? implScope.className : '';
              const effectiveMethodName = implScope ? implScope.methodName : target.name;
              const implKey = `${impl.uri.toString()}#${effectiveMethodName}#${effectiveRange.start.line}`;

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
            }

            queue.push({
              uri: crawlTargetUri,
              range: crawlTargetRange,
              depth: current.depth + 1,
            });
          }
        }
      }
    } catch (e) {
      console.warn('[Bisotun] Call hierarchy error:', e);
    }
  }

  // استخراج DTOها / مدل‌ها
  const models: ExtractedModel[] = [];
  const processedModels = new Set<string>();

  for (const node of nodes) {
    if (!node.uri) continue;
    const doc = await vscode.workspace.openTextDocument(node.uri);
    const candidateTypes = strategy.extractTypeCandidates(node.code);

    const range = new vscode.Range(
      new vscode.Position(node.startLine - 1, 0),
      new vscode.Position(node.endLine - 1, 0)
    );

    for (const typeName of candidateTypes) {
      if (!processedModels.has(typeName) && typeName !== node.className) {
        processedModels.add(typeName);
        const resolved = await strategy.resolveModelDefinition(doc, typeName, range);
        if (resolved) {
          models.push(resolved);
        }
      }
    }
  }

  return { nodes, models };
}