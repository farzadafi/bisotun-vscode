import { JsTokenizer, JsToken, JsTokenType } from './jsTokenizer';
import { NodeKind } from '../core/types';

export type JsNodeKind = NodeKind;

export interface JsTypeDef {
  readonly name: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface JsFunctionDef {
  readonly name: string;
  /** Compact `name(params)` form rendered from real source, used in markdown headers. */
  readonly displayName: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly kind: JsNodeKind;
  /** Offset of the name token; used to guard call-site detection. */
  readonly nameOffset: number;
}

export interface JsImportBinding {
  /** Local name the rest of the file uses. */
  readonly localName: string;
  /** Module specifier (bare `react`, relative `../services`). */
  readonly specifier: string;
  /** Imported name for named/default imports, or `null` for `import './x'`. */
  readonly importedName: string | null;
  /** Whether this binding gives the module objects directly (`import * as ns`). */
  readonly isModule: boolean;
}

export interface JsCallSite {
  /** The bare function/module name being called (`users` for `svc.users()`). */
  readonly name: string;
  /** Immediate qualifier (`svc` for `svc.users()`), `null` for `f()` / `a.b.f()`. */
  readonly qualifier: string | null;
  /** First identifier of a dotted chain (`a` for `a.b.c()`). */
  readonly rootIdentifier: string;
  /** Offset of the chain start. */
  readonly offset: number;
  /** Raw chain text, e.g. `paymentService.processPayment`. */
  readonly rawText: string;
}

/** A `{...}` pair that the bracket matcher found. */
export interface JsBlockSpan {
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * Outline of a JavaScript/TypeScript file, extracted from the hand written
 * tokenizer in `jsTokenizer.ts`.
 *
 * This is a faithful port of the JetBrains `JsFileOutline` that the
 * tokenizer tier of `JsTsFlowExtractor` uses, so the flow the VSCode
 * extension produces matches the IDE plugin character for character.
 */
export interface JsFileOutline {
  readonly functions: JsFunctionDef[];
  readonly types: JsTypeDef[];
  readonly imports: JsImportBinding[];
  /** Name of the default export when it is a function (`export default function`). */
  readonly defaultExportName: string | null;
  readonly tokens: JsToken[];
  readonly bracketMatches: Int32Array;
  readonly text: string;

  /** Innermost function containing `offset`; prefers the latest start. */
  functionContaining(offset: number): JsFunctionDef | undefined;
  /** Function declared at module (or any) level with the exact name. */
  functionNamed(name: string): JsFunctionDef | undefined;
  typeNamed(name: string): JsTypeDef | undefined;
  /** Functions declared inside `type`'s span: class methods. */
  functionsIn(type: JsTypeDef): JsFunctionDef[];
  /** Method named `name` declared by `type`, or undefined when not declared. */
  methodIn(type: JsTypeDef, name: string): JsFunctionDef | undefined;
  importFor(localName: string): JsImportBinding | undefined;
  /** Identifier names used inside `[startOffset, endOffset)`; never resolves anything by itself. */
  identifiersIn(startOffset: number, endOffset: number): Set<string>;
  /**
   * Calls whose callee starts inside `[startOffset, endOffset)`. Member chains
   * are collapsed to the last segment, so `api.users.list()` yields name
   * `list`, qualifier `users`, root `api`. When `skipNestedFunctions` is true
   * the bodies of nested declarations are skipped, so a module or block scope
   * lists its own statements instead of every call made by the functions it
   * holds.
   */
  callSitesIn(startOffset: number, endOffset: number, skipNestedFunctions?: boolean): JsCallSite[];
  /** Calls inside a function body, including the bodies of its nested functions.
   * Mirrors the JVM `JsFileOutline.callSitesIn(function)` used by the tokenizer engine. */
  callSitesIn(functionDef: JsFunctionDef): JsCallSite[];
  /** Identifiers inside a function body, including nested function bodies. */
  identifiersIn(functionDef: JsFunctionDef): Set<string>;
  /** Innermost `{...}` pair containing `offset`, or undefined outside any block. */
  blockContaining(offset: number): JsBlockSpan | undefined;
}

export interface JsNamedExport {
  readonly name: string;
  readonly offset: number;
}

const NODE_KIND_FUNCTION: NodeKind = 'FUNCTION';
const NODE_KIND_METHOD: NodeKind = 'METHOD';
const NODE_KIND_COMPONENT: NodeKind = 'COMPONENT';

/**
 * Internal declaration record used while building the outline. `endOffset` is
 * computed from the real token stream once the containing block is known, so
 * the builder keeps this richer shape and only materializes the public
 * `JsFunctionDef` items at the end.
 */
interface FunctionRecord {
  readonly name: string;
  readonly displayName: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly nameOffset: number;
  readonly indent: number;
  readonly kind: NodeKind;
}

interface TypeRecord {
  readonly name: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

interface ImportCandidate {
  readonly localName: string;
  readonly importedName: string | null;
  readonly isNamespace: boolean;
}

const CLASS_MEMBER_MODIFIERS = new Set([
  'static', 'async', 'get', 'set', 'public', 'private', 'protected', 'readonly', 'abstract',
  'override', 'declare', '*',
]);

const STATEMENT_STARTERS = new Set([
  'const', 'let', 'var', 'function', 'class', 'export', 'import', 'interface', 'type',
  'enum', 'return', 'if', 'for', 'while', 'switch', 'try', 'throw',
]);

/** Builds a `JsFileOutline` from tokens, mirroring the Kotlin `JsFileOutlineBuilder`. */

export class JsFileOutlineBuilder {
  private readonly text: string;
  private readonly tokens: JsToken[];
  private readonly brackets: Int32Array;
  private readonly functions: FunctionRecord[] = [];
  private readonly types: TypeRecord[] = [];
  private readonly imports: JsImportBinding[] = [];
  private defaultExportName: string | null = null;

  constructor(text: string) {
    this.text = text;
    this.tokens = new JsTokenizer(text).tokenize();
    this.brackets = new Int32Array(this.tokens.length).fill(-1);
  }

  build(): JsFileOutline {
    this.matchBrackets();
    this.scanScope(0, this.tokens.length);
    const uniqueFunctions: FunctionRecord[] = [];
    for (const fn of this.functions) {
      if (uniqueFunctions.every((other) => other.startOffset !== fn.startOffset || other.endOffset !== fn.endOffset)) {
        uniqueFunctions.push(fn);
      }
    }
    uniqueFunctions.sort((a, b) => a.startOffset - b.startOffset);
    const uniqueTypes: TypeRecord[] = [];
    for (const type of this.types) {
      if (uniqueTypes.every((other) => other.name !== type.name || other.startOffset !== type.startOffset)) {
        uniqueTypes.push(type);
      }
    }
    const uniqueImports: JsImportBinding[] = [];
    for (const binding of this.imports) {
      if (
        uniqueImports.every(
          (other) => other.localName !== binding.localName || other.specifier !== binding.specifier
        )
      ) {
        uniqueImports.push(binding);
      }
    }
    return new JsFileOutlineImpl(
      this.text,
      uniqueFunctions,
      uniqueTypes,
      uniqueImports,
      this.defaultExportName,
      this.tokens,
      this.brackets
    );
  }

  private matchBrackets(): void {
    const stack: number[] = [];
    for (let index = 0; index < this.tokens.length; index++) {
      const tokenText = this.tokens[index].text;
      if (tokenText === '(' || tokenText === '[' || tokenText === '{') {
        stack.push(index);
      } else if (tokenText === ')' || tokenText === ']' || tokenText === '}') {
        if (stack.length === 0) continue;
        const expectedOpen = tokenText === ')' ? '(' : tokenText === ']' ? '[' : '{';
        let found: number | undefined;
        while (stack.length > 0) {
          const candidate = stack.pop()!;
          if (this.tokens[candidate].text === expectedOpen) {
            found = candidate;
            break;
          }
        }
        if (found !== undefined) {
          this.brackets[found] = index;
          this.brackets[index] = found;
        }
      }
    }
  }

  private scanScope(from: number, to: number): void {
    let i = from;
    while (i < to && i < this.tokens.length) {
      const tokenText = this.tokens[i].text;
      if (tokenText === 'function') {
        i = this.handleFunction(i, false);
      } else if (tokenText === 'async' && this.nextText(i + 1) === 'function') {
        i = this.handleFunction(i + 1, true);
      } else if (tokenText === 'class') {
        i = this.handleClass(i);
      } else if (tokenText === 'const' || tokenText === 'let' || tokenText === 'var') {
        i = this.handleVariable(i);
      } else if (tokenText === 'interface' || tokenText === 'enum') {
        i = this.handleNamedTypeBlock(i);
      } else if (tokenText === 'type' && this.isTypeAliasStart(i)) {
        i = this.handleTypeAlias(i);
      } else if (tokenText === 'import') {
        i = this.handleImport(i);
      } else if (tokenText === 'export') {
        i = this.handleExport(i);
      } else {
        i++;
      }
    }
  }

  private nextText(index: number): string | undefined {
    return this.tokens[index]?.text;
  }

  private isNameToken(index: number): boolean {
    const token = this.tokens[index];
    return token !== undefined && (token.type === 'IDENTIFIER' || token.type === 'KEYWORD');
  }

  private handleExport(index: number): number {
    if (this.nextText(index + 1) === 'default') {
      const candidate = index + 2;
      if (this.nextText(candidate) === 'function' || this.nextText(candidate) === 'class') {
        let cursor = candidate + 1;
        if (this.nextText(cursor) === '*') cursor++;
        if (this.tokens[cursor]?.type === 'IDENTIFIER') {
          this.defaultExportName = this.tokens[cursor].text;
        }
      } else if (this.tokens[candidate]?.type === 'IDENTIFIER') {
        this.defaultExportName = this.tokens[candidate].text;
      }
    }
    return index + 1;
  }

  private kindForName(name: string): NodeKind {
    return name.length > 0 && /^[A-Z]/.test(name) ? NODE_KIND_COMPONENT : NODE_KIND_FUNCTION;
  }

  private handleFunction(index: number, isAsync: boolean): number {
    let cursor = index + 1;
    if (this.nextText(cursor) === '*') cursor++;
    const nameIndex = cursor;
    const name =
      this.tokens[nameIndex]?.type === 'IDENTIFIER' ? this.tokens[nameIndex].text : undefined;
    const afterName = name !== undefined ? nameIndex + 1 : cursor;
    const afterGenerics = this.skipTypeParameters(afterName);
    const paramsOpen = this.findNextToken(afterGenerics, '(', afterGenerics + 12);
    if (paramsOpen === -1) return index + 1;
    const paramsClose = this.brackets[paramsOpen];
    if (paramsClose === -1) return index + 1;
    const bodyOpen = this.findBodyBrace(paramsClose + 1);
    const endIndex =
      bodyOpen !== -1 && this.brackets[bodyOpen] !== -1 ? this.brackets[bodyOpen] : paramsClose;
    const startOffset =
      isAsync && this.tokens[index - 1]?.text === 'async'
        ? this.tokens[index - 1].startOffset
        : name !== undefined
          ? this.tokens[nameIndex].startOffset
          : this.tokens[index].startOffset;
    if (name !== undefined) {
      this.functions.push({
        name,
        displayName: this.signature(name, paramsOpen, paramsClose),
        startOffset,
        endOffset: this.tokens[endIndex].endOffset,
        nameOffset: this.tokens[nameIndex].startOffset,
        indent: startOffset,
        kind: this.kindForName(name),
      });
    }
    if (bodyOpen !== -1 && endIndex > bodyOpen) {
      this.scanScope(bodyOpen + 1, endIndex);
    }
    return endIndex + 1;
  }

  private handleClass(index: number): number {
    const nameIndex = index + 1;
    const name = this.tokens[nameIndex]?.type === 'IDENTIFIER' ? this.tokens[nameIndex].text : undefined;
    const bodyOpen = this.findNextToken(nameIndex, '{', nameIndex + 60);
    if (bodyOpen === -1) return index + 1;
    const bodyClose = this.brackets[bodyOpen];
    if (bodyClose === -1) return index + 1;
    if (name !== undefined) {
      // The type span starts at the `class` keyword so model snippets read `class UserRequest { ... }`,
      // mirroring the Python `class`-keyword start (Python `isModelType` and model `code` rely on it).
      this.types.push({ name, startOffset: this.tokens[index].startOffset, endOffset: this.tokens[bodyClose].endOffset });
      this.collectMethods(name, bodyOpen, bodyClose);
    }
    return bodyClose + 1;
  }

  private collectMethods(className: string, bodyOpen: number, bodyClose: number): void {
    let i = bodyOpen + 1;
    while (i < bodyClose) {
      i = this.collectMember(className, i, bodyClose);
    }
  }

  private collectMember(className: string, start: number, bodyClose: number): number {
    const tokenText = this.nextText(start);
    if (tokenText === '@') return this.skipDecorator(start);
    if (tokenText === ';' || tokenText === ',') return start + 1;
    if (tokenText === '{') {
      const close = this.brackets[start];
      if (close > start) return close + 1;
    }
    const afterModifiers = this.skipMemberModifiers(start, bodyClose);
    if (afterModifiers > start) {
      const parsed = this.parseMember(className, afterModifiers, bodyClose);
      if (parsed !== -1) return parsed;
    }
    const parsed = this.parseMember(className, start, bodyClose);
    return parsed !== -1 ? parsed : start + 1;
  }

  private skipMemberModifiers(from: number, limit: number): number {
    let cursor = from;
    while (cursor < limit && CLASS_MEMBER_MODIFIERS.has(this.tokens[cursor].text)) cursor++;
    return cursor;
  }

  private skipDecorator(start: number): number {
    let cursor = start + 1;
    if (!this.isNameToken(cursor)) return start + 1;
    cursor++;
    while (this.nextText(cursor) === '.' && this.isNameToken(cursor + 1)) cursor += 2;
    if (this.nextText(cursor) === '(') {
      const close = this.brackets[cursor];
      if (close > cursor) return close + 1;
    }
    return cursor;
  }

  private skipTypeParameters(from: number): number {
    if (this.nextText(from) !== '<') return from;
    let depth = 0;
    let i = from;
    let guard = 0;
    while (i < this.tokens.length && guard++ < 80) {
      const tokenText = this.tokens[i].text;
      if (tokenText === '<') {
        depth++;
      } else if (tokenText === '>') {
        depth--;
        if (depth <= 0) return i + 1;
      } else if (tokenText === '>>') {
        depth -= 2;
        if (depth <= 0) return i + 1;
      } else if (tokenText === ';' || tokenText === '{' || tokenText === '}') {
        return from;
      }
      i++;
    }
    return from;
  }

  private parseMember(className: string, start: number, bodyClose: number): number {
    let nameIndex = start;
    if (this.nextText(nameIndex) === '#') nameIndex++;
    if (!this.isNameToken(nameIndex)) return -1;
    const name = this.tokens[nameIndex].text;
    const paramsOpen = this.skipTypeParameters(nameIndex + 1);
    if (this.nextText(paramsOpen) === '(') {
      const paramsClose = this.brackets[paramsOpen];
      if (paramsClose <= paramsOpen || paramsClose >= bodyClose) return nameIndex + 1;
      const afterParams = paramsClose + 1;
      const bodyOpen = this.findBodyBrace(afterParams);
      if (bodyOpen <= paramsClose || bodyOpen >= bodyClose) return nameIndex + 1;
      const bodyEnd = this.brackets[bodyOpen];
      if (bodyEnd <= bodyOpen) return nameIndex + 1;
      this.functions.push({
        name,
        displayName: this.signature(`${className}.${name}`, paramsOpen, paramsClose),
        startOffset: this.tokens[nameIndex].startOffset,
        endOffset: this.tokens[bodyEnd].endOffset,
        nameOffset: this.tokens[nameIndex].startOffset,
        indent: this.tokens[nameIndex].startOffset,
        kind: NODE_KIND_METHOD,
      });
      this.scanScope(bodyOpen + 1, bodyEnd);
      return bodyEnd + 1;
    }
    if (this.nextText(paramsOpen) !== '=') return -1;
    const arrow = this.findArrow(paramsOpen + 1);
    if (arrow === -1) return nameIndex + 1;
    const end = this.expressionEnd(arrow + 1);
    if (end <= arrow) return nameIndex + 1;
    this.functions.push({
      name,
      displayName: this.arrowSignature(`${className}.${name}`, paramsOpen + 1, arrow),
      startOffset: this.tokens[nameIndex].startOffset,
      endOffset: this.tokens[end].endOffset,
      nameOffset: this.tokens[nameIndex].startOffset,
      indent: this.tokens[nameIndex].startOffset,
      kind: NODE_KIND_METHOD,
    });
    const bodyOpen = this.findNextToken(arrow + 1, '{', arrow + 4);
    if (bodyOpen !== -1 && this.brackets[bodyOpen] !== -1) {
      this.scanScope(bodyOpen + 1, this.brackets[bodyOpen]);
    }
    return end + 1;
  }

  private arrowSignature(name: string, paramsStart: number, arrow: number): string {
    const first = this.tokens[paramsStart];
    if (!first) return name;
    if (first.text === '(') {
      const close = this.brackets[paramsStart];
      if (close >= paramsStart && close < arrow) return this.signature(name, paramsStart, close);
    }
    if (first.type === 'IDENTIFIER') return `${name}(${first.text})`;
    return name;
  }

  private handleVariable(index: number): number {
    const nameIndex = index + 1;
    const nameToken = this.tokens[nameIndex];
    if (!nameToken || nameToken.type !== 'IDENTIFIER') return index + 1;
    const equalsIndex = this.findAssignmentOperator(nameIndex + 1);
    if (equalsIndex === -1) return nameIndex + 1;
    let valueIndex = equalsIndex + 1;
    if (this.nextText(valueIndex) === 'async') valueIndex++;
    if (this.nextText(valueIndex) === 'function') {
      const paramsOpen = this.findNextToken(valueIndex, '(', valueIndex + 12);
      if (paramsOpen === -1) return equalsIndex + 1;
      const paramsClose = this.brackets[paramsOpen];
      if (paramsClose === -1) return equalsIndex + 1;
      const bodyOpen = this.findBodyBrace(paramsClose + 1);
      const endIndex = bodyOpen !== -1 && this.brackets[bodyOpen] !== -1 ? this.brackets[bodyOpen] : paramsClose;
      this.functions.push({
        name: nameToken.text,
        displayName: this.signature(nameToken.text, paramsOpen, paramsClose),
        startOffset: nameToken.startOffset,
        endOffset: this.tokens[endIndex].endOffset,
        nameOffset: nameToken.startOffset,
        indent: nameToken.startOffset,
        kind: this.kindForName(nameToken.text),
      });
      if (bodyOpen !== -1 && endIndex > bodyOpen) {
        this.scanScope(bodyOpen + 1, endIndex);
      }
      return endIndex + 1;
    }
    const arrow = this.findArrow(valueIndex);
    if (arrow === -1) return equalsIndex + 1;
    const end = this.expressionEnd(arrow + 1);
    if (end <= arrow) return equalsIndex + 1;
    this.functions.push({
      name: nameToken.text,
      displayName: this.arrowSignature(nameToken.text, valueIndex, arrow),
      startOffset: nameToken.startOffset,
      endOffset: this.tokens[end].endOffset,
      nameOffset: nameToken.startOffset,
      indent: nameToken.startOffset,
      kind: this.kindForName(nameToken.text),
    });
    const bodyOpen = this.findNextToken(arrow + 1, '{', arrow + 4);
    if (bodyOpen !== -1 && this.brackets[bodyOpen] !== -1) {
      this.scanScope(bodyOpen + 1, this.brackets[bodyOpen]);
    }
    return end + 1;
  }

  private handleNamedTypeBlock(index: number): number {
    const nameIndex = index + 1;
    const tok = this.tokens[nameIndex];
    const name = tok?.type === 'IDENTIFIER' ? tok.text : undefined;
    if (name === undefined) return index + 1;
    const bodyOpen = this.findNextToken(nameIndex, '{', nameIndex + 40);
    if (bodyOpen === -1) return index + 1;
    const bodyClose = this.brackets[bodyOpen];
    if (bodyClose === -1) return index + 1;
    this.types.push({ name, startOffset: this.tokens[nameIndex].startOffset, endOffset: this.tokens[bodyClose].endOffset });
    return bodyClose + 1;
  }

  private isTypeAliasStart(index: number): boolean {
    if (this.tokens[index + 1]?.type !== 'IDENTIFIER') return false;
    return this.nextText(index + 2) === '=' || this.nextText(index + 2) === '<';
  }

  private handleTypeAlias(index: number): number {
    const name = this.tokens[index + 1].text;
    const end = this.expressionEnd(index + 2);
    if (end <= index + 1) return index + 1;
    this.types.push({ name, startOffset: this.tokens[index + 1].startOffset, endOffset: this.tokens[end].endOffset });
    return end + 1;
  }

  private handleImport(index: number): number {
    let cursor = index + 1;
    if (this.nextText(cursor) === 'type') cursor++;
    const pending: ImportCandidate[] = [];
    if (this.nextText(cursor) === '{') {
      const close = this.brackets[cursor];
      if (close === -1) return index + 1;
      this.collectNamedBindings(cursor + 1, close, pending);
      cursor = close + 1;
    } else if (this.nextText(cursor) === '*') {
      if (this.nextText(cursor + 1) !== 'as' || !this.isNameToken(cursor + 2)) return index + 1;
      pending.push({ localName: this.tokens[cursor + 2].text, importedName: null, isNamespace: true });
      cursor += 3;
    } else if (this.isNameToken(cursor) && this.nextText(cursor) !== 'from') {
      pending.push({ localName: this.tokens[cursor].text, importedName: null, isNamespace: false });
      cursor += 1;
      if (this.nextText(cursor) === ',') {
        cursor++;
        if (this.nextText(cursor) === '{') {
          const close = this.brackets[cursor];
          if (close === -1) return index + 1;
          this.collectNamedBindings(cursor + 1, close, pending);
          cursor = close + 1;
        } else if (this.nextText(cursor) === '*' && this.nextText(cursor + 1) === 'as' && this.isNameToken(cursor + 2)) {
          pending.push({ localName: this.tokens[cursor + 2].text, importedName: null, isNamespace: true });
          cursor += 3;
        }
      }
    } else {
      return index + 1;
    }
    if (this.nextText(cursor) !== 'from') return index + 1;
    const specifierToken = this.tokens[cursor + 1];
    if (!specifierToken || specifierToken.type !== 'STRING') return index + 1;
    const specifier = specifierToken.text.replace(/^['"`]|['"`]$/g, '');
    for (const candidate of pending) {
      this.imports.push({
        localName: candidate.localName,
        importedName: candidate.importedName,
        specifier,
        isModule: candidate.isNamespace,
      });
    }
    return cursor + 2;
  }

  private collectNamedBindings(from: number, to: number, pending: ImportCandidate[]): void {
    let i = from;
    while (i < to) {
      if (this.tokens[i].text === 'type') {
        i++;
        continue;
      }
      if (this.tokens[i].type !== 'IDENTIFIER') {
        i++;
        continue;
      }
      const imported = this.tokens[i].text;
      if (this.nextText(i + 1) === 'as' && this.isNameToken(i + 2)) {
        pending.push({ localName: this.tokens[i + 2].text, importedName: imported, isNamespace: false });
        i += 3;
      } else {
        pending.push({ localName: imported, importedName: imported, isNamespace: false });
        i += 1;
      }
    }
  }

  private findNextToken(from: number, expected: string, limit: number): number {
    let i = from;
    while (i < this.tokens.length && i <= limit) {
      const tokenText = this.tokens[i].text;
      if (tokenText === expected) return i;
      if (tokenText === ';' || tokenText === '}') return -1;
      i++;
    }
    return -1;
  }

  private findAssignmentOperator(from: number): number {
    let i = from;
    let guard = 0;
    while (i < this.tokens.length && guard++ < 120) {
      const tokenText = this.tokens[i].text;
      if (tokenText === '=') return i;
      if (tokenText === ';' || tokenText === '}') return -1;
      if (tokenText === '<') {
        const afterGeneric = this.skipTypeParameters(i);
        if (afterGeneric > i) {
          i = afterGeneric;
          continue;
        }
      }
      if (tokenText === '(' || tokenText === '[' || tokenText === '{') {
        const close = this.brackets[i];
        if (close === -1) return -1;
        i = close + 1;
        continue;
      }
      i++;
    }
    return -1;
  }

  private findArrow(from: number): number {
    const start = this.skipAsyncOperator(from);
    if (this.nextText(start) === '(') {
      const close = this.brackets[start];
      if (close <= 0) return -1;
      const afterParams = close + 1;
      if (this.nextText(afterParams) === ':') return this.findArrowOperator(afterParams + 1);
      return this.nextText(afterParams) === '=>' ? afterParams : -1;
    }
    if (this.isNameToken(start) && this.nextText(start + 1) === '=>') return start + 1;
    if (this.nextText(start) === '<') {
      const afterGeneric = this.skipTypeParameters(start);
      if (afterGeneric > start) return this.findArrow(afterGeneric);
    }
    return -1;
  }

  private skipAsyncOperator(from: number): number {
    return this.nextText(from) === 'async' ? from + 1 : from;
  }

  private findArrowOperator(from: number): number {
    let i = from;
    let guard = 0;
    while (i < this.tokens.length && guard++ < 60) {
      const tokenText = this.tokens[i].text;
      if (tokenText === '=>') return i;
      if (tokenText === ';' || tokenText === '=' || tokenText === ',' || tokenText === ')') return -1;
      if (tokenText === '<') {
        const after = this.skipTypeParameters(i);
        if (after > i) {
          i = after;
          continue;
        }
      }
      if (tokenText === '(' || tokenText === '[' || tokenText === '{') {
        const close = this.brackets[i];
        if (close > 0) {
          i = close + 1;
          continue;
        }
      }
      i++;
    }
    return -1;
  }

  private expressionEnd(from: number): number {
    if (from >= this.tokens.length) return this.tokens.length - 1;
    let i = from;
    let guard = 0;
    while (i < this.tokens.length && guard++ < 400) {
      const token = this.tokens[i];
      if (token.text === '(' || token.text === '[' || token.text === '{') {
        const close = this.brackets[i];
        if (close <= 0) return i > from ? i - 1 : i;
        i = close + 1;
        continue;
      }
      if (token.text === ';' || token.text === ',' || token.text === ')' || token.text === ']' || token.text === '}') {
        return i > from ? i - 1 : i;
      }
      if (i > from && token.line > this.tokens[from].line && STATEMENT_STARTERS.has(token.text)) {
        return i - 1;
      }
      i++;
    }
    return this.tokens.length - 1;
  }

  private findBodyBrace(from: number): number {
    let i = from;
    let guard = 0;
    while (i < this.tokens.length && guard++ < 80) {
      const tokenText = this.tokens[i].text;
      if (tokenText === '{') return i;
      if (tokenText === ';' || tokenText === '=' || tokenText === ')' || tokenText === ']') return -1;
      if (tokenText === '<') {
        const afterGeneric = this.skipTypeParameters(i);
        if (afterGeneric > i) {
          i = afterGeneric;
          continue;
        }
      }
      if (tokenText === '(' || tokenText === '[') {
        const close = this.brackets[i];
        if (close > 0) {
          i = close + 1;
          continue;
        }
      }
      if (tokenText === ':') {
        const typeStart = i + 1;
        if (this.nextText(typeStart) === '{') {
          const close = this.brackets[typeStart];
          if (close > 0) {
            i = close + 1;
            continue;
          }
        }
      }
      i++;
    }
    return -1;
  }

  private signature(name: string, paramsOpen: number, paramsClose: number): string {
    if (
      paramsOpen < 0 || paramsOpen >= this.tokens.length ||
      paramsClose < 0 || paramsClose >= this.tokens.length || paramsClose < paramsOpen
    ) {
      return name;
    }
    const start = this.tokens[paramsOpen].endOffset;
    const end = this.tokens[paramsClose].startOffset;
    if (end <= start) return `${name}()`;
    const compact = this.text
      .substring(start, end)
      .split('\\n')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join(' ');
    return compact.length === 0 ? `${name}()` : `${name}(${compact})`;
  }
}

/** Concrete `JsFileOutline`; the constructor holds all computed data. */
export class JsFileOutlineImpl implements JsFileOutline {
  readonly functions: JsFunctionDef[];
  readonly types: JsTypeDef[];
  readonly imports: JsImportBinding[];
  readonly defaultExportName: string | null;
  readonly tokens: JsToken[];
  readonly bracketMatches: Int32Array;
  readonly text: string;

  constructor(
    text: string,
    functions: JsFunctionDef[],
    types: JsTypeDef[],
    imports: JsImportBinding[],
    defaultExportName: string | null,
    tokens: JsToken[],
    bracketMatches: Int32Array
  ) {
    this.text = text;
    this.functions = functions;
    this.types = types;
    this.imports = imports;
    this.defaultExportName = defaultExportName;
    this.tokens = tokens;
    this.bracketMatches = bracketMatches;
  }

  functionContaining(offset: number): JsFunctionDef | undefined {
    const contained = this.functions.filter(
      (fn) => offset >= fn.startOffset && offset <= fn.endOffset
    );
    if (contained.length === 0) return undefined;
    return contained.reduce((best, current) => (current.startOffset > best.startOffset ? current : best));
  }

  functionNamed(name: string): JsFunctionDef | undefined {
    return this.functions.find((fn) => fn.name === name);
  }

  typeNamed(name: string): JsTypeDef | undefined {
    return this.types.find((type) => type.name === name);
  }

  functionsIn(type: JsTypeDef): JsFunctionDef[] {
    return this.functions.filter(
      (fn) => fn.startOffset >= type.startOffset && fn.endOffset <= type.endOffset
    );
  }

  methodIn(type: JsTypeDef, name: string): JsFunctionDef | undefined {
    return this.functionsIn(type).find((fn) => fn.name === name);
  }

  importFor(localName: string): JsImportBinding | undefined {
    return this.imports.find((binding) => binding.localName === localName);
  }

  /** Identifiers inside a span or a function body (nested functions included). */
  identifiersIn(span: JsFunctionDef | number, endOffset?: number): Set<string> {
    const startOffset = typeof span === 'number' ? span : span.startOffset;
    const end = typeof span === 'number' ? (endOffset as number) : span.endOffset;
    const names = new Set<string>();
    let i = this.firstTokenIndexAtOrAfter(startOffset);
    while (i < this.tokens.length && this.tokens[i].startOffset < end) {
      if (this.tokens[i].type === 'IDENTIFIER') names.add(this.tokens[i].text);
      i++;
    }
    return names;
  }

  /** Calls inside a span (skipping nested function bodies by default) or a function body (nested bodies included). */
  callSitesIn(
    span: JsFunctionDef | number,
    endOffset?: number,
    skipNestedFunctions = true
  ): JsCallSite[] {
    const startOffset = typeof span === 'number' ? span : span.startOffset;
    const end = typeof span === 'number' ? (endOffset as number) : span.endOffset;
    const skipNested = typeof span === 'number' ? skipNestedFunctions : false;
    const sites = new Map<number, JsCallSite>();
    const declarationNames = new Set(this.functions.map((fn) => fn.nameOffset));
    const nested = skipNested
      ? this.functions.filter((fn) => fn.startOffset > startOffset && fn.endOffset <= end)
      : [];
    let i = this.firstTokenIndexAtOrAfter(startOffset);
    while (i < this.tokens.length && this.tokens[i].startOffset < end) {
      const token = this.tokens[i];
      if (
        token.type !== 'IDENTIFIER' ||
        // `new X(...)` is a constructor call = a type reference, not an execution dependency.
        this.tokens[i - 1]?.text === 'new' ||
        nested.some((fn) => token.startOffset >= fn.startOffset && token.startOffset <= fn.endOffset)
      ) {
        i++;
        continue;
      }
      const chain: string[] = [token.text];
      let last = i;
      while (true) {
        const separator = last + 1;
        if (separator + 1 >= this.tokens.length) break;
        const separatorText = this.tokens[separator].text;
        const next = this.tokens[separator + 1];
        if ((separatorText === '.' || separatorText === '?.') && this.isNameToken(next)) {
          chain.push(next.text);
          last = separator + 1;
        } else {
          break;
        }
      }
      const openParen = last + 1;
      if (openParen < this.tokens.length && this.tokens[openParen].text === '(') {
        const closeParen = this.bracketMatches[openParen];
        const looksLikeMethodDefinition =
          closeParen > 0 &&
          this.tokens[closeParen + 1]?.text === '{' &&
          !declarationNames.has(token.startOffset);
        if (!looksLikeMethodDefinition && !declarationNames.has(token.startOffset)) {
          sites.set(token.startOffset, {
            name: chain[chain.length - 1],
            qualifier: chain.length > 1 ? chain[chain.length - 2] : null,
            rootIdentifier: chain[0],
            offset: token.startOffset,
            rawText: chain.join('.'),
          });
        }
      }
      i = last + 1;
    }
    return Array.from(sites.values());
  }

  blockContaining(offset: number): JsBlockSpan | undefined {
    let best: JsBlockSpan | undefined;
    for (let index = 0; index < this.tokens.length; index++) {
      if (this.tokens[index].text !== '{') continue;
      const close = this.bracketMatches[index];
      if (close <= 0) continue;
      const start = this.tokens[index].startOffset;
      const end = this.tokens[close].endOffset;
      if (offset < start || offset > end) continue;
      if (best === undefined || start > best.startOffset) best = { startOffset: start, endOffset: end };
    }
    return best;
  }

  private firstTokenIndexAtOrAfter(offset: number): number {
    let low = 0;
    let high = this.tokens.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.tokens[middle].startOffset < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private isNameToken(token: JsToken): boolean {
    return token.type === 'IDENTIFIER' || token.type === 'KEYWORD';
  }
}

/** Parses `text` into a `JsFileOutline`, mirroring the Kotlin `JsFileOutline.parse`. */
export function parseJsOutline(text: string): JsFileOutline {
  return new JsFileOutlineBuilder(text).build();
}
