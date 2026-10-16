import * as vscode from 'vscode';
import { isExternalUri } from '../utils/filter';

export interface ResolvedDefinition {
  uri: vscode.Uri;
  range: vscode.Range;
  code: string;
  className?: string;
  methodName?: string;
}

export interface EnclosingScope {
  className: string;
  methodName: string;
  range: vscode.Range;
}

export async function findEnclosingScope(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<EnclosingScope | undefined> {
  const symbols = await vscode.commands.executeCommand<
    vscode.DocumentSymbol[]
  >('vscode.executeDocumentSymbolProvider', document.uri);

  if (!symbols || symbols.length === 0) {
    return undefined;
  }

  let enclosingClass: vscode.DocumentSymbol | undefined;
  let enclosingMethod: vscode.DocumentSymbol | undefined;

  function traverse(syms: vscode.DocumentSymbol[], parent?: vscode.DocumentSymbol) {
    for (const sym of syms) {
      // بررسی این که پوزیشن داخل رنج متد یا نام آن باشد
      const inRange =
        sym.range.contains(position) ||
        (position.line >= sym.range.start.line && position.line <= sym.range.end.line);

      if (inRange) {
        if (
          sym.kind === vscode.SymbolKind.Class ||
          sym.kind === vscode.SymbolKind.Interface
        ) {
          enclosingClass = sym;
        } else if (
          sym.kind === vscode.SymbolKind.Method ||
          sym.kind === vscode.SymbolKind.Constructor ||
          sym.kind === vscode.SymbolKind.Function
        ) {
          enclosingMethod = sym;
          if (parent) {
            enclosingClass = parent;
          }
        }

        if (sym.children && sym.children.length > 0) {
          traverse(sym.children, sym);
        }
      }
    }
  }

  traverse(symbols);

  if (!enclosingMethod) {
    return undefined;
  }

  return {
    className: enclosingClass?.name || '',
    methodName: enclosingMethod.name,
    range: enclosingMethod.range,
  };
}

export async function resolveImplementation(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<ResolvedDefinition | undefined> {
  try {
    const implementations = await vscode.commands.executeCommand<
      vscode.Location[] | vscode.LocationLink[] | undefined
    >('vscode.executeImplementationProvider', document.uri, position);

    if (implementations && implementations.length > 0) {
      for (const impl of implementations) {
        const def = extractDefinitionFromLocation(impl);
        if (def && !isExternalUri(def.uri)) {
          return def;
        }
      }
    }
  } catch {
    // fallback to definition
  }

  return resolveDefinition(document, position);
}

function extractDefinitionFromLocation(
  location: vscode.Location | vscode.LocationLink,
): ResolvedDefinition | undefined {
  const uri =
    location instanceof vscode.Location ? location.uri : location.targetUri;

  let range: vscode.Range | undefined;
  if (location instanceof vscode.Location) {
    range = location.range;
  } else {
    range = location.targetSelectionRange ?? location.targetRange;
  }

  if (!range) {
    return undefined;
  }

  return { uri, range, code: '' };
}

export async function resolveDefinition(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<ResolvedDefinition | undefined> {
  const definitions = await vscode.commands.executeCommand<
    vscode.Location[] | vscode.LocationLink[] | undefined
  >('vscode.executeDefinitionProvider', document.uri, position);

  if (!definitions || definitions.length === 0) {
    return undefined;
  }

  for (const defItem of definitions) {
    const extracted = extractDefinitionFromLocation(defItem);
    if (extracted && !isExternalUri(extracted.uri)) {
      return extracted;
    }
  }

  return undefined;
}
