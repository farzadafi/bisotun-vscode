import * as vscode from 'vscode';
import * as path from 'path';
import { LanguageStrategy, FallbackCall } from '../strategies/languageStrategy';
import { isExternalUri, isWorkspaceUri } from '../utils/filter';

const JAVASCRIPT_BUILT_IN_TYPES = new Set([
  'Array',
  'ArrayBuffer',
  'BigInt',
  'Boolean',
  'Buffer',
  'Date',
  'Error',
  'File',
  'FormData',
  'Function',
  'HTMLElement',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'NodeJS',
  'Number',
  'Object',
  'Promise',
  'Readonly',
  'ReadonlyArray',
  'Record',
  'RegExp',
  'Request',
  'Response',
  'Set',
  'String',
  'Symbol',
  'URL',
  'URLSearchParams',
  'WeakMap',
  'WeakSet',
  'AbortController',
  'Blob',
  'Console',
  'Event',
  'EventTarget',
  'Infinity',
  'Partial',
  'Pick',
  'Omit',
  'Required',
  'ReturnType',
  'Parameters',
  'InstanceType',
  'Awaited',
  'React',
  'ReactNode',
]);

const METHOD_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Constructor,
]);

const CONTAINER_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Object,
  vscode.SymbolKind.Namespace,
]);

export class JavaScriptStrategy implements LanguageStrategy {
  readonly languageId = 'javascript';

  supports(languageId: string): boolean {
    return [
      'javascript',
      'typescript',
      'javascriptreact',
      'typescriptreact',
    ].includes(languageId);
  }

  extractTypeCandidates(code: string): string[] {
    const cleanCode = maskNonCode(code);
    const candidates = new Set<string>();

    const regex = /\b[A-Z][A-Za-z0-9_$]*\b/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(cleanCode)) !== null) {
      const candidate = match[0];

      if (!JAVASCRIPT_BUILT_IN_TYPES.has(candidate)) {
        candidates.add(candidate);
      }
    }

    return Array.from(candidates);
  }

  async findEnclosingScope(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<
    | {
        className: string;
        methodName: string;
        range: vscode.Range;
      }
    | undefined
  > {
    const symbols = await vscode.commands.executeCommand<
      vscode.DocumentSymbol[]
    >('vscode.executeDocumentSymbolProvider', document.uri);

    if (!symbols || symbols.length === 0) {
      return undefined;
    }

    let enclosingMethod: vscode.DocumentSymbol | undefined;
    let enclosingClassName: string | undefined;

    const visit = (
      currentSymbols: vscode.DocumentSymbol[],
      currentContainerName?: string,
    ): void => {
      for (const symbol of currentSymbols) {
        if (!isPositionInsideSymbol(symbol, position)) {
          continue;
        }

        const nextContainerName = CONTAINER_SYMBOL_KINDS.has(symbol.kind)
          ? symbol.name
          : currentContainerName;

        if (METHOD_SYMBOL_KINDS.has(symbol.kind)) {
          if (
            !enclosingMethod ||
            getRangeSize(symbol.range) < getRangeSize(enclosingMethod.range)
          ) {
            enclosingMethod = symbol;
            enclosingClassName = nextContainerName;
          }
        }

        if (symbol.children && symbol.children.length > 0) {
          visit(symbol.children, nextContainerName);
        }
      }
    };

    visit(symbols);

    if (!enclosingMethod) {
      return undefined;
    }

    return {
      className:
        enclosingClassName || getModuleNameFromDocument(document.fileName),
      methodName: enclosingMethod.name,
      range: enclosingMethod.range,
    };
  }

  async resolveModelDefinition(
    document: vscode.TextDocument,
    typeName: string,
    methodRange: vscode.Range,
  ): Promise<
    { name: string; filePath: string; code: string } | undefined
  > {
    const methodText = document.getText(methodRange);
    const typeIndex = findIdentifierIndex(methodText, typeName);

    if (typeIndex === -1) {
      return undefined;
    }

    const targetOffset = document.offsetAt(methodRange.start) + typeIndex;
    const position = document.positionAt(targetOffset);

    try {
      const definitions = await vscode.commands.executeCommand<
        vscode.Location[] | vscode.LocationLink[] | undefined
      >('vscode.executeDefinitionProvider', document.uri, position);

      if (definitions && definitions.length > 0) {
        const firstDefinition = definitions[0];
        const targetUri =
          firstDefinition instanceof vscode.Location
            ? firstDefinition.uri
            : firstDefinition.targetUri;

        const targetPosition =
          firstDefinition instanceof vscode.Location
            ? firstDefinition.range.start
            : firstDefinition.targetSelectionRange?.start ??
              firstDefinition.targetRange.start;

        if (isWorkspaceUri(targetUri) && !isExternalUri(targetUri)) {
          const targetDocument = await vscode.workspace.openTextDocument(targetUri);
          const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            targetUri,
          );

          const modelSymbol = findModelSymbol(symbols, typeName);
          if (modelSymbol) {
            return {
              name: typeName,
              filePath: vscode.workspace.asRelativePath(targetUri),
              code: targetDocument.getText(modelSymbol.range).trim(),
            };
          }

          const declarationRange = findDeclarationRange(targetDocument, typeName, targetPosition);
          if (declarationRange) {
            return {
              name: typeName,
              filePath: vscode.workspace.asRelativePath(targetUri),
              code: targetDocument.getText(declarationRange).trim(),
            };
          }
        }
      }

      // فال‌بک در صورت عدم شناسایی از طریق LSP (بررسی ایمپورت مستقیم مدل)
      const importMap = parseImports(document);
      if (importMap.has(typeName)) {
        const relPath = importMap.get(typeName)!;
        const resolvedUri = await resolveRelativeImportUri(document.uri, relPath);
        if (resolvedUri) {
          const targetDoc = await vscode.workspace.openTextDocument(resolvedUri);
          const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            resolvedUri,
          );
          const modelSymbol = findModelSymbol(symbols, typeName);
          if (modelSymbol) {
            return {
              name: typeName,
              filePath: vscode.workspace.asRelativePath(resolvedUri),
              code: targetDoc.getText(modelSymbol.range).trim(),
            };
          }
        }
      }
    } catch (error) {
      console.warn(`[Bisotun] JavaScript model resolution failed for "${typeName}".`, error);
    }

    return undefined;
  }

  async resolveImplementationLocation(
    uri: vscode.Uri,
    position: vscode.Position,
  ): Promise<{ uri: vscode.Uri; range: vscode.Range } | undefined> {
    try {
      const implementations = await vscode.commands.executeCommand<
        vscode.Location[] | vscode.LocationLink[] | undefined
      >('vscode.executeImplementationProvider', uri, position);

      if (!implementations || implementations.length === 0) {
        return undefined;
      }

      for (const implementation of implementations) {
        const targetUri =
          implementation instanceof vscode.Location
            ? implementation.uri
            : implementation.targetUri;

        const targetRange =
          implementation instanceof vscode.Location
            ? implementation.range
            : implementation.targetSelectionRange ?? implementation.targetRange;

        if (targetUri && targetRange && isWorkspaceUri(targetUri) && !isExternalUri(targetUri)) {
          return { uri: targetUri, range: targetRange };
        }
      }
    } catch (error) {
      console.warn('[Bisotun] JavaScript implementation lookup failed.', error);
    }

    return undefined;
  }

  async resolveFallbackCalls(
    document: vscode.TextDocument,
    methodRange: vscode.Range,
  ): Promise<FallbackCall[]> {
    const currentScope = await this.findEnclosingScope(document, methodRange.start);
    if (!currentScope) {
      return [];
    }

    const methodCode = document.getText(methodRange);
    const calls = extractFallbackCalls(methodCode);
    if (calls.length === 0) {
      return [];
    }

    const localSymbols = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    )) || [];

    const fieldTypes = inferFieldTypes(document, localSymbols, currentScope.className);
    const importMap = parseImports(document);
    const candidateFiles = new Map<string, vscode.TextDocument>();
    candidateFiles.set(document.uri.toString(), document);

    // واکشی ماژول‌های ایمپورت شده در فایل جاری
    for (const [, relativePath] of importMap) {
      const resolvedUri = await resolveRelativeImportUri(document.uri, relativePath);
      if (resolvedUri && isWorkspaceUri(resolvedUri) && !isExternalUri(resolvedUri)) {
        try {
          const importedDoc = await vscode.workspace.openTextDocument(resolvedUri);
          candidateFiles.set(resolvedUri.toString(), importedDoc);
        } catch {}
      }
    }

    // پیمایش بازگشتی فایل‌های پروژه برای متدهای غیرمستقیم
    const workspaceFiles = await vscode.workspace.findFiles(
      '**/*.{js,ts,mjs,cjs}',
      '**/node_modules/**',
      20,
    );
    for (const wf of workspaceFiles) {
      if (!candidateFiles.has(wf.toString())) {
        try {
          const wDoc = await vscode.workspace.openTextDocument(wf);
          candidateFiles.set(wf.toString(), wDoc);
        } catch {}
      }
    }

    const allMethods: Array<MethodCandidate & { uri: vscode.Uri }> = [];
    for (const doc of candidateFiles.values()) {
      const syms = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri,
      )) || [];
      const methods = collectMethodSymbols(syms);
      for (const m of methods) {
        // نام متد نباید دقیقاً برابر با یک کلاس DTO باشد (مثل سازنده OrderResponse)
        if (m.methodName !== m.className) {
          allMethods.push({ ...m, uri: doc.uri });
        }
      }
    }

    const result: FallbackCall[] = [];
    const visited = new Set<string>();

    for (const call of calls) {
      let matched = allMethods.filter(m => m.methodName === call.methodName);

      const targetClassName = call.receiver ? fieldTypes.get(call.receiver) : undefined;
      if (targetClassName) {
        const classMatched = matched.filter(m => m.className === targetClassName);
        if (classMatched.length > 0) {
          matched = classMatched;
        }
      } else if (!call.receiver && currentScope.className) {
        const localClassMatched = matched.filter(
          m => m.className === currentScope.className && m.uri.toString() === document.uri.toString(),
        );
        if (localClassMatched.length > 0) {
          matched = localClassMatched;
        }
      }

      if (matched.length > 1 && call.receiver && importMap.has(call.receiver)) {
        const expectedPath = importMap.get(call.receiver)!;
        const prioritized = matched.filter(m => m.uri.fsPath.includes(expectedPath.replace(/^\.\//, '')));
        if (prioritized.length > 0) {
          matched = prioritized;
        }
      }

      const target = matched[0];
      if (!target) {
        continue;
      }

      const key = `${target.uri.toString()}#${target.className}#${target.methodName}#${target.range.start.line}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      result.push({
        uri: target.uri,
        range: target.range,
        name: target.methodName,
        detail: target.className,
      });
    }

    return result;
  }
}

interface MethodCandidate {
  className: string;
  methodName: string;
  range: vscode.Range;
}

interface FallbackCallExpression {
  receiver?: string;
  methodName: string;
}

function collectMethodSymbols(
  symbols: vscode.DocumentSymbol[],
  currentClassName?: string,
): MethodCandidate[] {
  const result: MethodCandidate[] = [];

  for (const symbol of symbols) {
    const className =
      symbol.kind === vscode.SymbolKind.Class ? symbol.name : currentClassName;

    if (className && METHOD_SYMBOL_KINDS.has(symbol.kind)) {
      result.push({
        className,
        methodName: symbol.name,
        range: symbol.range,
      });
    }

    if (symbol.children && symbol.children.length > 0) {
      result.push(...collectMethodSymbols(symbol.children, className));
    }
  }

  return result;
}

function extractFallbackCalls(code: string): FallbackCallExpression[] {
  const result: FallbackCallExpression[] = [];

  // this.userService.getUserProfile(...)
  const chainedRegex = /\bthis\.([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = chainedRegex.exec(code)) !== null) {
    result.push({
      receiver: match[1],
      methodName: match[2],
    });
  }

  // receiver.method(...)
  const memberCallRegex = /\b([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  while ((match = memberCallRegex.exec(code)) !== null) {
    if (
      match[1] !== 'this' &&
      match[1] !== 'console' &&
      match[1] !== 'Math' &&
      match[1] !== 'JSON' &&
      match[1] !== 'Promise'
    ) {
      result.push({
        receiver: match[1],
        methodName: match[2],
      });
    }
  }

  // this.helperMethod(...)
  const directCallRegex = /\bthis\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  while ((match = directCallRegex.exec(code)) !== null) {
    result.push({
      methodName: match[1],
    });
  }

  return result;
}

function inferFieldTypes(
  document: vscode.TextDocument,
  symbols: vscode.DocumentSymbol[],
  className: string,
): Map<string, string> {
  const result = new Map<string, string>();
  const fullCode = document.getText();

  const classSymbol = findClassSymbol(symbols, className);
  const classCode = classSymbol ? document.getText(classSymbol.range) : fullCode;

  const variableTypes = inferVariableTypes(fullCode);
  const constructorParameterTypes = inferConstructorParameterTypes(
    fullCode,
    className,
    classCode,
    variableTypes,
  );

  const newAssignmentRegex = /this\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*new\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = newAssignmentRegex.exec(classCode)) !== null) {
    result.set(match[1], match[2]);
  }

  const parameterAssignmentRegex = /this\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;/g;
  while ((match = parameterAssignmentRegex.exec(classCode)) !== null) {
    const fieldName = match[1];
    const parameterName = match[2];
    const type = constructorParameterTypes.get(parameterName) ?? variableTypes.get(parameterName);
    if (type) {
      result.set(fieldName, type);
    }
  }

  return result;
}

function inferVariableTypes(code: string): Map<string, string> {
  const result = new Map<string, string>();
  const regex = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*new\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code)) !== null) {
    result.set(match[1], match[2]);
  }
  return result;
}

function inferConstructorParameterTypes(
  fullCode: string,
  className: string,
  classCode: string,
  variableTypes: Map<string, string>,
): Map<string, string> {
  const result = new Map<string, string>();
  const constructorMatch = /\bconstructor\s*\(([^)]*)\)/s.exec(classCode);
  if (!constructorMatch) {
    return result;
  }

  const parameters = constructorMatch[1]
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => p.split(/[=:]/)[0].replace(/\.\.\./, '').trim());

  const instantiationRegex = new RegExp(
    `new\\s+${escapeRegExp(className)}\\s*\\(([^)]*)\\)`,
    'g',
  );

  let match: RegExpExecArray | null;
  while ((match = instantiationRegex.exec(fullCode)) !== null) {
    const argumentsList = match[1].split(',').map(arg => arg.trim());
    parameters.forEach((param, index) => {
      const argument = argumentsList[index];
      if (!argument) {
        return;
      }
      const directTypeMatch = /^new\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(argument);
      if (directTypeMatch) {
        result.set(param, directTypeMatch[1]);
        return;
      }
      const variableType = variableTypes.get(argument);
      if (variableType) {
        result.set(param, variableType);
      }
    });
  }

  return result;
}

function parseImports(document: vscode.TextDocument): Map<string, string> {
  const importMap = new Map<string, string>();
  const text = document.getText();

  const esmRegex = /import\s+(?:\{([^}]+)\}|([A-Za-z0-9_$]+))\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = esmRegex.exec(text)) !== null) {
    const named = match[1];
    const defaultExport = match[2];
    const importPath = match[3];

    if (defaultExport) {
      importMap.set(defaultExport.trim(), importPath);
    }
    if (named) {
      named.split(',').forEach(item => {
        const parts = item.trim().split(/\s+as\s+/);
        const identifier = parts[parts.length - 1].trim();
        if (identifier) {
          importMap.set(identifier, importPath);
        }
      });
    }
  }

  const cjsRegex = /(?:const|let|var)\s+(?:\{([^}]+)\}|([A-Za-z0-9_$]+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = cjsRegex.exec(text)) !== null) {
    const named = match[1];
    const defaultExport = match[2];
    const importPath = match[3];

    if (defaultExport) {
      importMap.set(defaultExport.trim(), importPath);
    }
    if (named) {
      named.split(',').forEach(item => {
        const parts = item.trim().split(/\s*:\s*/);
        const identifier = parts[parts.length - 1].trim();
        if (identifier) {
          importMap.set(identifier, importPath);
        }
      });
    }
  }

  return importMap;
}

async function resolveRelativeImportUri(
  baseUri: vscode.Uri,
  relativePath: string,
): Promise<vscode.Uri | undefined> {
  if (!relativePath.startsWith('.')) {
    return undefined;
  }

  const baseDir = path.dirname(baseUri.fsPath);
  const targetPath = path.resolve(baseDir, relativePath);
  const extensionsToTry = ['', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '/index.js', '/index.ts'];

  for (const ext of extensionsToTry) {
    const fullPath = targetPath + ext;
    const uri = vscode.Uri.file(fullPath);
    try {
      await vscode.workspace.fs.stat(uri);
      return uri;
    } catch {}
  }

  return undefined;
}

function maskNonCode(code: string): string {
  let result = '';
  let state:
    | 'code'
    | 'singleQuote'
    | 'doubleQuote'
    | 'template'
    | 'lineComment'
    | 'blockComment' = 'code';

  for (let index = 0; index < code.length; index++) {
    const current = code[index];
    const next = code[index + 1];

    if (state === 'code') {
      if (current === '/' && next === '/') {
        result += '  ';
        index++;
        state = 'lineComment';
        continue;
      }
      if (current === '/' && next === '*') {
        result += '  ';
        index++;
        state = 'blockComment';
        continue;
      }
      if (current === "'") {
        result += ' ';
        state = 'singleQuote';
        continue;
      }
      if (current === '"') {
        result += ' ';
        state = 'doubleQuote';
        continue;
      }
      if (current === '`') {
        result += ' ';
        state = 'template';
        continue;
      }
      result += current;
      continue;
    }

    if (state === 'lineComment') {
      if (current === '\n') {
        result += '\n';
        state = 'code';
      } else {
        result += ' ';
      }
      continue;
    }

    if (state === 'blockComment') {
      if (current === '*' && next === '/') {
        result += '  ';
        index++;
        state = 'code';
      } else {
        result += current === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (
      state === 'singleQuote' ||
      state === 'doubleQuote' ||
      state === 'template'
    ) {
      if (current === '\\') {
        result += '  ';
        if (index + 1 < code.length) {
          result += code[index + 1] === '\n' ? '\n' : ' ';
          index++;
        }
        continue;
      }

      const closingCharacter =
        state === 'singleQuote' ? "'" : state === 'doubleQuote' ? '"' : '`';

      if (current === closingCharacter) {
        result += ' ';
        state = 'code';
      } else {
        result += current === '\n' ? '\n' : ' ';
      }
    }
  }

  return result;
}

function isPositionInsideSymbol(
  symbol: vscode.DocumentSymbol,
  position: vscode.Position,
): boolean {
  return (
    symbol.range.contains(position) ||
    (position.line >= symbol.range.start.line &&
      position.line <= symbol.range.end.line)
  );
}

function getRangeSize(range: vscode.Range): number {
  return (
    (range.end.line - range.start.line) * 1_000_000 +
    range.end.character -
    range.start.character
  );
}

function getModuleNameFromDocument(fileName: string): string {
  const normalizedPath = fileName.replace(/\\/g, '/');
  const fileNameOnly = normalizedPath.split('/').pop() || 'Module';
  return fileNameOnly.replace(/\.(jsx?|tsx?)$/, '') || 'Module';
}

function findIdentifierIndex(text: string, identifier: string): number {
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escapedIdentifier}\\b`).exec(text);
  return match?.index ?? -1;
}

function findModelSymbol(
  symbols: vscode.DocumentSymbol[] | undefined,
  typeName: string,
): vscode.DocumentSymbol | undefined {
  if (!symbols) {
    return undefined;
  }

  for (const symbol of symbols) {
    if (
      symbol.name === typeName &&
      (symbol.kind === vscode.SymbolKind.Class ||
        symbol.kind === vscode.SymbolKind.Interface ||
        symbol.kind === vscode.SymbolKind.Struct ||
        symbol.kind === vscode.SymbolKind.Enum ||
        symbol.kind === vscode.SymbolKind.Object)
    ) {
      return symbol;
    }

    const nestedSymbol = findModelSymbol(symbol.children, typeName);
    if (nestedSymbol) {
      return nestedSymbol;
    }
  }

  return undefined;
}

function findDeclarationRange(
  document: vscode.TextDocument,
  typeName: string,
  fallbackPosition: vscode.Position,
): vscode.Range | undefined {
  const escapedTypeName = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declarationPattern = new RegExp(`\\b(class|interface|type|enum)\\s+${escapedTypeName}\\b`);
  const match = declarationPattern.exec(document.getText());

  if (match?.index !== undefined) {
    const start = document.positionAt(match.index);
    const end = findDeclarationEnd(document, start);
    return new vscode.Range(start, end);
  }

  const line = document.lineAt(fallbackPosition.line);
  return new vscode.Range(fallbackPosition, new vscode.Position(fallbackPosition.line, line.text.length));
}

function findDeclarationEnd(
  document: vscode.TextDocument,
  start: vscode.Position,
): vscode.Position {
  let braceCount = 0;
  let hasStartedBlock = false;

  for (let lineNumber = start.line; lineNumber < document.lineCount; lineNumber++) {
    const lineText = document.lineAt(lineNumber).text;

    for (const character of lineText) {
      if (character === '{') {
        braceCount++;
        hasStartedBlock = true;
      } else if (character === '}') {
        braceCount--;
        if (hasStartedBlock && braceCount === 0) {
          return new vscode.Position(lineNumber, lineText.length);
        }
      }
    }

    if (!hasStartedBlock && lineText.includes(';')) {
      return new vscode.Position(lineNumber, lineText.length);
    }
  }

  return new vscode.Position(document.lineCount - 1, 0);
}

function findClassSymbol(
  symbols: vscode.DocumentSymbol[],
  className: string,
): vscode.DocumentSymbol | undefined {
  for (const symbol of symbols) {
    if (symbol.kind === vscode.SymbolKind.Class && symbol.name === className) {
      return symbol;
    }
    if (symbol.children && symbol.children.length > 0) {
      const nested = findClassSymbol(symbol.children, className);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
