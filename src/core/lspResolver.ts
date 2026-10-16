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

export interface ExtractedModel {
  name: string;
  filePath: string;
  code: string;
}

const PRIMITIVE_TYPES = new Set([
  'void', 'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double',
  'Boolean', 'Byte', 'Character', 'Short', 'Integer', 'Long', 'Float', 'Double',
  'String', 'Object', 'Class', 'List', 'Set', 'Map', 'Collection', 'Optional',
  'Page', 'Pageable', 'Sort', 'ResponseEntity', 'Stream', 'Arrays', 'ArrayList',
  'HashMap', 'HashSet', 'UUID', 'LocalDate', 'LocalDateTime', 'Instant', 'Date',
  'BigDecimal', 'BigInteger', 'CompletableFuture', 'Mono', 'Flux',
  'Override', 'Transactional', 'Autowired', 'Component', 'Service', 'Repository',
  'Controller', 'RestController', 'Bean', 'Configuration'
]);

/**
 * بررسی اینکه فایل متعلق به ورک‌اسپیس پروژه است و از پکیج‌های اکسترنال یا jar نیست
 */
export function isWorkspaceUri(uri: vscode.Uri): boolean {
  if (isExternalUri(uri)) {
    return false;
  }
  const fsPath = uri.fsPath || uri.path;
  if (fsPath.includes('.jar!') || fsPath.includes('.jar/') || fsPath.endsWith('.jar')) {
    return false;
  }
  return vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

/**
 * استخراج نام کلاس‌ها و رکوردهای اختصاصی (حذف انوتیشن‌ها با @)
 */
export function extractTypeCandidates(code: string): string[] {
  // پاک کردن انوتیشن‌ها تا کلماتی مثل GetMapping و PathVariable برداشته شوند
  const codeWithoutAnnotations = code.replace(/@[A-Za-z0-9_]+/g, ' ');

  const regex = /\b([A-Z][a-zA-Z0-9_]+)\b/g;
  const matches = new Set<string>();
  let match;
  while ((match = regex.exec(codeWithoutAnnotations)) !== null) {
    const typeName = match[1];
    if (!PRIMITIVE_TYPES.has(typeName)) {
      matches.add(typeName);
    }
  }
  return Array.from(matches);
}

export async function resolveModelDefinition(
  document: vscode.TextDocument,
  typeName: string,
  methodRange: vscode.Range
): Promise<ExtractedModel | undefined> {
  const methodText = document.getText(methodRange);
  const index = methodText.indexOf(typeName);
  if (index === -1) {
    return undefined;
  }

  const targetOffset = document.offsetAt(methodRange.start) + index;
  const position = document.positionAt(targetOffset);

  try {
    const definitions = await vscode.commands.executeCommand<
      vscode.Location[] | vscode.LocationLink[] | undefined
    >('vscode.executeDefinitionProvider', document.uri, position);

    if (!definitions || definitions.length === 0) {
      return undefined;
    }

    const first = definitions[0];
    const uri = first instanceof vscode.Location ? first.uri : first.targetUri;

    // فقط فایل‌های داخل پروژه
    if (!isWorkspaceUri(uri)) {
      return undefined;
    }

    const targetDoc = await vscode.workspace.openTextDocument(uri);
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri
    );

    let modelSymbol: vscode.DocumentSymbol | undefined;
    if (symbols && symbols.length > 0) {
      modelSymbol = symbols.find(
        (s) =>
          s.name === typeName &&
          (s.kind === vscode.SymbolKind.Class ||
            s.kind === vscode.SymbolKind.Interface ||
            s.kind === vscode.SymbolKind.Struct ||
            s.kind === vscode.SymbolKind.Enum)
      );
    }

    // اگر سیمبل پیدا شد همان رنج، در غیر این صورت کل فایل DTO/Model
    const code = modelSymbol ? targetDoc.getText(modelSymbol.range) : targetDoc.getText();

    return {
      name: typeName,
      filePath: vscode.workspace.asRelativePath(uri),
      code: code.trim(),
    };
  } catch {
    return undefined;
  }
}

export async function resolveImplementationLocation(
  uri: vscode.Uri,
  position: vscode.Position
): Promise<{ uri: vscode.Uri; range: vscode.Range } | undefined> {
  try {
    const implementations = await vscode.commands.executeCommand<
      vscode.Location[] | vscode.LocationLink[] | undefined
    >('vscode.executeImplementationProvider', uri, position);

    if (implementations && implementations.length > 0) {
      for (const impl of implementations) {
        const targetUri = impl instanceof vscode.Location ? impl.uri : impl.targetUri;
        const targetRange =
          impl instanceof vscode.Location
            ? impl.range
            : impl.targetSelectionRange ?? impl.targetRange;

        if (targetUri && targetRange && isWorkspaceUri(targetUri)) {
          return { uri: targetUri, range: targetRange };
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined;
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
