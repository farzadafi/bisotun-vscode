// Python file outline (port of the JetBrains plugin's `PythonFileOutline` +
// `PythonFileOutlineBuilder`).
//
// The Python analogue of the JS/JSX file outline: functions/classes are found
// by their `def` / `class` statement and their span extends to the next
// statement whose indentation is not deeper, which is exactly the Python block
// rule. Nothing that cannot be parsed unambiguously is reported, so no
// declaration is ever invented.

import { NodeKind } from '../../core/types';
import { PythonToken, PythonTokenType, PythonTokenizer } from './pythonTokenizer';

/** A function-like declaration discovered by the tokenizer tier. */
export interface PythonFunctionDef {
  name: string;
  displayName: string;
  startOffset: number;
  endOffset: number;
  nameOffset: number;
  indent: number;
  kind: NodeKind;
}

/**
 * One imported binding: `import a.b as c` -> localName `c`, importedName `a.b`, isModule true;
 * `from m import x as y` -> localName `y`, importedName `x`, isModule false.
 */
export interface PythonImportBinding {
  localName: string;
  importedName: string | null;
  specifier: string;
  isModule: boolean;
  isRelative: boolean;
}

export interface PythonTypeDef {
  name: string;
  startOffset: number;
  endOffset: number;
}

/**
 * A call site inside a function body. `rawText` keeps the full chain
 * (`service.users.list`) so an unresolved node still shows what the code
 * actually called.
 */
export interface PythonCallSite {
  name: string;
  qualifier: string | null;
  rootIdentifier: string;
  offset: number;
  rawText: string;
}

const SELF_INSTANCE = 'self';
const NODE_KIND_FUNCTION: NodeKind = 'FUNCTION';
const NODE_KIND_METHOD: NodeKind = 'METHOD';

/**
 * Indentation based outline of a Python file.
 */
export class PythonFileOutline {
  readonly text: string;
  readonly functions: PythonFunctionDef[];
  readonly types: PythonTypeDef[];
  readonly imports: PythonImportBinding[];
  private readonly tokens: PythonToken[];

  constructor(
    text: string,
    functions: PythonFunctionDef[],
    types: PythonTypeDef[],
    imports: PythonImportBinding[],
    tokens: PythonToken[]
  ) {
    this.text = text;
    this.functions = functions;
    this.types = types;
    this.imports = imports;
    this.tokens = tokens;
  }

  /**
   * Innermost (named) function containing `offset`; prefers the latest start.
   *
   * A caret anywhere on the `def`'s own physical line - including the leading indentation before
   * the `def` keyword and whitespace after the signature - is treated as being inside the
   * function. This keeps `resolveScope` from falling back to the class `block` scope when the
   * cursor sits on a method's signature line (the JetBrains fixture caret lands exactly on
   * `def create_user_endpoint` and must resolve to that method, never to the class body).
   */
  functionContaining(offset: number): PythonFunctionDef | undefined {
    let best: PythonFunctionDef | undefined;
    for (const fn of this.functions) {
      const fnLineStart = this.text.lastIndexOf('\n', fn.startOffset - 1) + 1;
      if (offset >= fnLineStart && offset <= fn.endOffset) {
        if (!best || fn.startOffset > best.startOffset) best = fn;
      }
    }
    return best;
  }

  functionNamed(name: string): PythonFunctionDef | undefined {
    return this.functions.find((fn) => fn.name === name);
  }

  typeNamed(name: string): PythonTypeDef | undefined {
    return this.types.find((type) => type.name === name);
  }

  /** Functions declared inside `type`'s span: class methods. */
  functionsIn(type: PythonTypeDef): PythonFunctionDef[] {
    return this.functions.filter(
      (fn) => fn.startOffset >= type.startOffset && fn.endOffset <= type.endOffset
    );
  }

  /** Method named `name` declared by `type`, or undefined when that type does not declare it. */
  methodIn(type: PythonTypeDef, name: string): PythonFunctionDef | undefined {
    return this.functionsIn(type).find((fn) => fn.name === name);
  }

  /** Identifier names used inside `[startOffset, endOffset)`; never resolves anything by itself. */
  identifiersIn(startOffset: number, endOffset: number): Set<string> {
    const names = new Set<string>();
    for (const token of this.tokens) {
      if (token.startOffset < startOffset || token.startOffset >= endOffset) continue;
      if (token.type === PythonTokenType.IDENTIFIER) names.add(token.text);
    }
    return names;
  }

  /**
   * Calls whose callee starts inside `[startOffset, endOffset)`. Member chains are collapsed to the
   * last segment, so `service.users.list()` yields name `list`, qualifier `users`, root `service`.
   * When `skipNestedFunctions` is true the bodies of nested declarations are skipped, so a module
   * scope lists its own statements instead of every call made by the functions it holds.
   */
  callSitesIn(startOffset: number, endOffset: number, skipNestedFunctions: boolean = true): PythonCallSite[] {
    const sites = new Map<number, PythonCallSite>();
    const nested = skipNestedFunctions
      ? this.functions.filter((fn) => fn.startOffset > startOffset && fn.endOffset <= endOffset)
      : [];

    let i = this.firstTokenIndexAtOrAfter(startOffset);
    while (i < this.tokens.length && this.tokens[i].startOffset < endOffset) {
      const token = this.tokens[i];
      if (
        token.type !== PythonTokenType.IDENTIFIER ||
        nested.some((fn) => token.startOffset >= fn.startOffset && token.startOffset <= fn.endOffset)
      ) {
        i++;
        continue;
      }
      if (i > 0 && this.tokens[i - 1].text === '@') {
        i++;
        continue;
      }
      const chain = [token.text];
      let last = i;
      while (true) {
        const separator = last + 1;
        const next = separator + 1;
        if (next >= this.tokens.length) break;
        if (this.tokens[separator].text === '.' && this.isNameToken(next)) {
          chain.push(this.tokens[next].text);
          last = next;
        } else {
          break;
        }
      }
      const afterChain = last + 1;
      const isCall =
        afterChain < this.tokens.length &&
        this.tokens[afterChain].type === PythonTokenType.PUNCTUATION &&
        this.tokens[afterChain].text === '(';
      if (isCall && !this.isFunctionNameToken(last)) {
        const root = chain[0];
        if (!sites.has(this.tokens[i].startOffset)) {
          sites.set(this.tokens[i].startOffset, {
            name: chain[chain.length - 1],
            qualifier: chain.length > 1 ? chain[chain.length - 2] : null,
            rootIdentifier: root,
            offset: this.tokens[i].startOffset,
            rawText: chain.join('.'),
          });
        }
      }
      i = last + 1;
    }
    return Array.from(sites.values());
  }

  /** Innermost class body containing `offset`; used when the caret is inside a class but outside a method. */
  blockContaining(offset: number): PythonTypeDef | undefined {
    let best: PythonTypeDef | undefined;
    for (const type of this.types) {
      const start = type.startOffset;
      const end = type.endOffset;
      if (offset < start || offset > end) continue;
      if (!best || start > best.startOffset) best = type;
    }
    return best;
  }

  /**
   * Type of the instance attribute `self.<field>` declared inside `type`, or of a class-level
   * annotation `<field>: <Type>`. This is the basis for resolving `self.<field>.<method>()` without
   * relying on a textual relation between the field name and the class name.
   *
   * Scans the whole class span (assignments typically live in `__init__`, but are accepted anywhere
   * inside the class) for the three supported declaration shapes:
   *
   *   - `self.<field> = <Type>(...)`      (constructor assignment in `__init__`)
   *   - `self.<field>: <Type> = <value>`  (annotated assignment)
   *   - `<field>: <Type>`                 (class-level annotation on its own statement)
   *
   * Returns the declared type name only - never a definition - so the resolver still has to prove a
   * declaration exists before it can jump anywhere.
   */
  attributeTypeOfClass(type: PythonTypeDef, field: string): string | undefined {
    let best: string | undefined;
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.startOffset < type.startOffset || token.startOffset >= type.endOffset) continue;
      if (token.type !== PythonTokenType.IDENTIFIER) continue;

      if (token.text === SELF_INSTANCE && this.tokens[i + 1]?.text === '.') {
        const fieldToken = this.tokens[i + 2];
        if (!fieldToken || fieldToken.type !== PythonTokenType.IDENTIFIER) continue;
        if (fieldToken.text !== field) continue;
        const operator = this.tokens[i + 3];
        if (operator?.text === ':') {
          const annotated = this.typeNameAt(i + 4);
          if (annotated) return annotated;
          continue;
        }
        if (operator?.text === '=') {
          const assigned = this.typeNameAt(i + 4);
          if (assigned) {
            // `self.<field> = <Type>(...)` declares a constructed field.
            if (this.tokens[i + 5]?.text === '(') return assigned;
            // `self.<field> = <param>` copies the constructor parameter; the field's type is
            // the `__init__` parameter annotation (`def __init__(self, repo: UserRepository)`).
            const paramType = this.parameterTypeOfClass(type, assigned);
            if (paramType) return paramType;
          }
        }
        continue;
      }

      // Class-level annotation `<field>: <Type>`: the field token opens its own physical line and is
      // immediately followed by a colon (never a `def`/`class`/`if`... header).
      if (token.text === field && this.tokens[i + 1]?.text === ':') {
        const prev = this.tokens[i - 1];
        if (prev !== undefined && prev.line === token.line) continue;
        const annotated = this.typeNameAt(i + 2);
        if (annotated) best = best ?? annotated;
      }
    }
    return best;
  }

  /** Next identifier after `fromIndex` - the declared type in `self.x: T` / `self.x = T` forms. */
  private typeNameAt(fromIndex: number): string | undefined {
    const token = this.tokens[fromIndex];
    if (!token || token.type !== PythonTokenType.IDENTIFIER) return undefined;
    return token.text;
  }

  /**
   * Type annotation of a parameter in the class's `__init__` signature, e.g. `repo` in
   * `def __init__(self, repo: UserRepository)`. Used when a field is assigned a bare parameter
   * (`self.repo = repo`): the field type is the parameter's annotation, not a constructor call.
   */
  private parameterTypeOfClass(type: PythonTypeDef, paramName: string): string | undefined {
    const init = this.functionsIn(type).find((fn) => fn.name === '__init__');
    if (!init) return undefined;
    const end = Math.min(init.endOffset, this.text.length);
    let depth = 0;
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.startOffset < init.startOffset || token.startOffset >= end) continue;
      if (token.text === '(') {
        depth++;
        continue;
      }
      if (token.text === ')') {
        depth = Math.max(depth - 1, 0);
        continue;
      }
      if (depth !== 1) continue;
      if (token.type !== PythonTokenType.IDENTIFIER || token.text !== paramName) continue;
      const colon = this.tokens[i + 1];
      const annotated = colon?.text === ':' ? this.typeNameAt(i + 2) : undefined;
      return annotated;
    }
    return undefined;
  }


  importFor(localName: string): PythonImportBinding | undefined {
    return this.imports.find((imp) => imp.localName === localName);
  }

  static parse(text: string): PythonFileOutline {
    return new PythonFileOutlineBuilder(text).build();
  }

  private firstTokenIndexAtOrAfter(offset: number): number {
    let low = 0;
    let high = this.tokens.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.tokens[middle].startOffset < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private isNameToken(index: number): boolean {
    const token = this.tokens[index];
    return token !== undefined && token.type === PythonTokenType.IDENTIFIER;
  }

  private isFunctionNameToken(index: number): boolean {
    const offset = this.tokens[index].startOffset;
    return this.functions.some((fn) => fn.nameOffset === offset);
  }
}

/** A Python-logical statement (one or more physical lines joined by brackets or `\`). */
interface Statement {
  startIndex: number;
  endIndex: number;
  startOffset: number;
  indent: number;
}

interface FunctionRecord {
  name: string;
  startOffset: number;
  nameOffset: number;
  indent: number;
  endOffset: number;
}

interface TypeRecord {
  name: string;
  startOffset: number;
  indent: number;
  endOffset: number;
}

type OpenBody = OpenFunction | OpenType;

interface OpenFunction {
  kind: 'function';
  record: FunctionRecord;
  indent: number;
}

interface OpenType {
  kind: 'type';
  record: TypeRecord;
  indent: number;
}

/**
 * Parses the token stream into the indentation based [PythonFileOutline].
 *
 * Works on the physical lines grouped by the tokenizer (which already records the indent of each
 * line and consumes comments/strings). Statements are the Python-logical statements created by
 * joining physical lines whose parentheses are unbalanced or that end with a backslash. `def` /
 * `class` declarations and `import` / `from` statements are recognized from the statement head;
 * every block's extent is then the classic Python rule - everything up to the next statement whose
 * indentation is not deeper.
 */
class PythonFileOutlineBuilder {
  private readonly text: string;
  private readonly tokens: PythonToken[];
  private readonly functions: FunctionRecord[] = [];
  private readonly types: TypeRecord[] = [];
  private readonly imports: PythonImportBinding[] = [];

  constructor(text: string) {
    this.text = text;
    this.tokens = new PythonTokenizer(text).tokenize();
  }

  build(): PythonFileOutline {
    const statements = this.logicalStatements();
    this.parseStatements(statements);
    return new PythonFileOutline(
      this.text,
      this.materializedFunctions(),
      this.materializedTypes(),
      this.imports,
      this.tokens
    );
  }

  private logicalStatements(): Statement[] {
    const statements: Statement[] = [];
    let balance = 0;
    let startIndex = -1;
    let startOffset = -1;
    let indent = 0;

    let consume = 0;
    while (consume < this.tokens.length) {
      const lineNumber = this.tokens[consume].line;
      const lineTokens: PythonToken[] = [];
      while (consume < this.tokens.length && this.tokens[consume].line === lineNumber) {
        lineTokens.push(this.tokens[consume]);
        consume++;
      }
      if (lineTokens.length === 0) continue;
      const last = consume - 1;
      if (startIndex < 0) {
        // First line of the statement; keep this token index across all continuation lines
        // so a multi-line statement (e.g. a `def` whose closing `)` sits on its own line) is
        // still reported with its real head (def name, start offset). Pushing `first` here
        // would record only the last continuation line and silently drop the declaration.
        startIndex = consume - lineTokens.length;
        startOffset = lineTokens[0].startOffset;
        indent = lineTokens[0].indent;
      }
      for (const t of lineTokens) {
        if (t.text === '(' || t.text === '[' || t.text === '{') balance++;
        else if (t.text === ')' || t.text === ']' || t.text === '}') balance = Math.max(balance - 1, 0);
      }
      const continues = balance > 0 || lineTokens[lineTokens.length - 1].text === '\\';
      if (!continues) {
        statements.push({ startIndex, endIndex: last + 1, startOffset, indent });
        startIndex = -1;
        startOffset = -1;
      }
    }
    if (startIndex >= 0) {
      statements.push({ startIndex, endIndex: this.tokens.length, startOffset, indent });
    }
    return statements;
  }

  private parseStatements(statements: Statement[]): void {
    const stack: OpenBody[] = [];
    for (const statement of statements) {
      this.closeOpenBodies(stack, statement.startOffset, statement.indent);
      this.handleStatement(statement, stack);
    }
    const eof = this.text.length;
    while (stack.length > 0) {
      const open = stack.pop() as OpenBody;
      open.record.endOffset = eof;
    }
  }

  private closeOpenBodies(stack: OpenBody[], nextOffset: number, nextIndent: number): void {
    while (stack.length > 0 && stack[stack.length - 1].indent >= nextIndent) {
      const open = stack.pop() as OpenBody;
      open.record.endOffset = nextOffset;
    }
  }

  private handleStatement(statement: Statement, stack: OpenBody[]): void {
    const first = this.tokens[statement.startIndex];
    if (!first) return;
    if (first.text === '@') return; // decorator; not a declaration body itself
    const keyword = this.firstKeyword(statement);
    if (!keyword) return;
    switch (keyword) {
      case 'def':
        this.handleDef(statement, stack);
        break;
      case 'async':
        this.handleAsyncDef(statement, stack);
        break;
      case 'class':
        this.handleClass(statement, stack);
        break;
      case 'import':
        this.handleImport(statement);
        break;
      case 'from':
        this.handleFrom(statement);
        break;
    }
  }

  private firstKeyword(statement: Statement): string | undefined {
    for (let i = statement.startIndex; i < statement.endIndex; i++) {
      const token = this.tokens[i];
      if (token.type === PythonTokenType.KEYWORD) return token.text;
    }
    return undefined;
  }

  private indexOfKeyword(statement: Statement, keyword: string): number | undefined {
    for (let i = statement.startIndex; i < statement.endIndex; i++) {
      const token = this.tokens[i];
      if (token.type === PythonTokenType.KEYWORD && token.text === keyword) return i;
    }
    return undefined;
  }

  private statementEndOffset(statement: Statement): number {
    if (statement.startIndex >= statement.endIndex) return statement.startOffset;
    return this.tokens[statement.endIndex - 1].endOffset;
  }

  private handleDef(statement: Statement, stack: OpenBody[]): void {
    const defIndex = this.indexOfKeyword(statement, 'def');
    if (defIndex === undefined) return;
    const nameToken = this.tokens[defIndex + 1];
    if (!nameToken || nameToken.type !== PythonTokenType.IDENTIFIER) return;
    const endOffset = this.statementEndOffset(statement);
    const record: FunctionRecord = {
      name: nameToken.text,
      startOffset: this.tokens[defIndex].startOffset,
      nameOffset: nameToken.startOffset,
      indent: statement.indent,
      endOffset,
    };
    this.functions.push(record);
    stack.push({ kind: 'function', record, indent: record.indent });
  }

  private handleAsyncDef(statement: Statement, stack: OpenBody[]): void {
    this.handleDef(statement, stack);
  }

  private handleClass(statement: Statement, stack: OpenBody[]): void {
    const classIndex = this.indexOfKeyword(statement, 'class');
    if (classIndex === undefined) return;
    const nameToken = this.tokens[classIndex + 1];
    if (!nameToken || nameToken.type !== PythonTokenType.IDENTIFIER) return;
    const endOffset = this.statementEndOffset(statement);
    const record: TypeRecord = {
      name: nameToken.text,
      startOffset: this.tokens[classIndex].startOffset,
      indent: statement.indent,
      endOffset,
    };
    this.types.push(record);
    stack.push({ kind: 'type', record, indent: record.indent });
  }

  private handleImport(statement: Statement): void {
    const kwIndex = this.indexOfKeyword(statement, 'import');
    if (kwIndex === undefined) return;
    let i = kwIndex + 1;
    while (i < statement.endIndex) {
      const first = this.tokens[i];
      if (first.type === PythonTokenType.PUNCTUATION && first.text === ',') {
        i++;
        continue;
      }
      const parts: string[] = [];
      while (i < statement.endIndex) {
        const t = this.tokens[i];
        if (t.type === PythonTokenType.IDENTIFIER) {
          parts.push(t.text);
          i++;
        } else if (t.type === PythonTokenType.PUNCTUATION && t.text === '.') {
          i++;
        } else {
          break;
        }
      }
      if (parts.length === 0) {
        i++;
        continue;
      }
      const module = parts.join('.');
      let local = parts[parts.length - 1];
      let isRelative = false;
      if (i < statement.endIndex &&
          this.tokens[i].type === PythonTokenType.KEYWORD &&
          this.tokens[i].text === 'as' &&
          this.tokens[i + 1]?.type === PythonTokenType.IDENTIFIER) {
        local = this.tokens[i + 1].text;
        i += 2;
      }
      this.addImport(local, module, module, true, isRelative);
    }
  }

  private handleFrom(statement: Statement): void {
    const fromIndex = this.indexOfKeyword(statement, 'from');
    if (fromIndex === undefined) return;
    const importIndex = this.indexOfKeyword(statement, 'import');
    if (importIndex === undefined || importIndex <= fromIndex) return;

    let i = fromIndex + 1;
    const parts: string[] = [];
    while (i < importIndex) {
      const t = this.tokens[i];
      if (t.type === PythonTokenType.IDENTIFIER) {
        parts.push(t.text);
        i++;
      } else if (t.type === PythonTokenType.PUNCTUATION && t.text === '.') {
        i++;
      } else {
        break;
      }
    }
    const specifier = parts.join('.');
    if (specifier.length === 0) {
      // `from . import x` is still importable through the file's own directory.
      this.handleInlineImport(statement, importIndex + 1, '', true);
      return;
    }
    let isRelative = false;
    let j = fromIndex + 1;
    while (j < importIndex && this.tokens[j].type === PythonTokenType.PUNCTUATION &&
           (this.tokens[j].text === '.' || this.tokens[j].text === '...')) {
      isRelative = true;
      j++;
    }
    this.handleInlineImport(statement, importIndex + 1, specifier, isRelative);
  }

  private handleInlineImport(
    statement: Statement,
    start: number,
    specifier: string,
    isRelative: boolean
  ): void {
    let i = start;
    while (i < statement.endIndex) {
      const t = this.tokens[i];
      if (t.type === PythonTokenType.PUNCTUATION && t.text === ',') {
        i++;
        continue;
      }
      if (t.type !== PythonTokenType.IDENTIFIER) {
        i++;
        continue;
      }
      const imported = t.text;
      let local = imported;
      if (
        i + 2 < statement.endIndex &&
        this.tokens[i + 1].type === PythonTokenType.KEYWORD &&
        this.tokens[i + 1].text === 'as' &&
        this.tokens[i + 2].type === PythonTokenType.IDENTIFIER
      ) {
        local = this.tokens[i + 2].text;
        i += 3;
      } else {
        i++;
      }
      this.addImport(local, imported, specifier, false, isRelative);
    }
  }

  private addImport(
    local: string,
    imported: string | null,
    specifier: string,
    isModule: boolean,
    isRelative: boolean
  ): void {
    if (!this.imports.some((imp) => imp.localName === local && imp.specifier === specifier)) {
      this.imports.push({ localName: local, importedName: imported, specifier, isModule, isRelative });
    }
  }

  private materializedFunctions(): PythonFunctionDef[] {
    return this.functions.map((record) => {
      const owner = this.enclosingTypeName(record);
      return {
        name: record.name,
        displayName: owner ? `${owner}.${record.name}()` : `${record.name}()`,
        startOffset: record.startOffset,
        endOffset: trimTrailingBlankLines(this.text, record.endOffset),
        nameOffset: record.nameOffset,
        indent: record.indent,
        kind: owner ? NODE_KIND_METHOD : NODE_KIND_FUNCTION,
      };
    });
  }

  private materializedTypes(): PythonTypeDef[] {
    return this.types.map((record) => ({
      name: record.name,
      startOffset: record.startOffset,
      endOffset: trimTrailingBlankLines(this.text, record.endOffset),
    }));
  }

  /** Innermost class owning `record`, used to qualify method display names as `Class.method()`. */
  private enclosingTypeName(record: FunctionRecord): string | undefined {
    let best: TypeRecord | undefined;
    for (const type of this.types) {
      if (record.startOffset > type.startOffset && record.endOffset <= type.endOffset) {
        if (!best || type.startOffset > best.startOffset) best = type;
      }
    }
    return best?.name;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Narrows a block's end offset to the last non-blank line so extracted ranges/code never include
 * trailing empty lines (blocks end at the next statement's start offset, which is on a fresh line).
 */
function trimTrailingBlankLines(text: string, endOffset: number): number {
  let end = clamp(endOffset, 0, text.length);
  while (end > 0) {
    const prevNewline = text.lastIndexOf('\n', end - 1);
    const line = prevNewline >= 0 ? text.substring(prevNewline + 1, end) : text.substring(0, end);
    if (line.trim().length > 0) break;
    end = prevNewline >= 0 ? prevNewline : 0;
  }
  return end;
}

/** Convenience `parse` at module level mirroring `PythonFileOutline.parse`. */
export function parsePythonOutline(text: string): PythonFileOutline {
  return PythonFileOutline.parse(text);
}
