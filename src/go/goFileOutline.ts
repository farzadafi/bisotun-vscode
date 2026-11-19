// Outline of a Go file, extracted from the hand written tokenizer in `goTokenizer.ts`.
//
// This is the Go equivalent of `CppFileOutline` / `PythonFileOutline` / `JsFileOutline`:
// declarations are recorded from the real token stream (never guessed from text) so the extractor
// can resolve calls, collect data models and read source spans without `gopls`.
//
// What the outline understands structurally:
//  - `package` and `import` declarations (single and parenthesized, aliased/dot/blank);
//  - package-level `const` / `var` declarations;
//  - `type` declarations: structs, interfaces, named types, aliases, type parameters;
//  - struct fields (grouped names, tags, embedded and pointer-embedded fields);
//  - interface methods (signatures) and embedded interfaces / type unions;
//  - functions and methods with value or pointer receivers, parameters, named and unnamed
//    results, variadic parameters, generics and `init` functions;
//  - local variables (`var`, short declarations `:=`, range clauses), composite literals and
//    function literals (each becomes a nested function scope);
//  - control flow (if/else/switch/type switch/case/for/range/break/continue/goto/select),
//    `defer`/`go` statements and channel creation/send/receive operations;
//  - call sites with their selector chains.
// Anything unrecognised is skipped conservatively, so malformed input never throws.

import { NodeKind } from '../core/types';
import { GoComment, GoToken, GoTokenizer } from './goTokenizer';

export type GoTypeKind = 'struct' | 'interface' | 'named' | 'alias';

export interface GoTypeParam {
  readonly name: string;
  readonly constraint: string;
  readonly offset: number;
}

export interface GoParameter {
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly variadic: boolean;
}

export interface GoFieldDef {
  readonly name: string;
  readonly type: string;
  readonly embedded: boolean;
  readonly pointer: boolean;
  readonly tag: string;
  readonly offset: number;
}

export interface GoEmbedded {
  /** Last identifier of the embedded type (`Base` for `*pkg.Base`). */
  readonly name: string;
  readonly type: string;
  readonly pointer: boolean;
  readonly offset: number;
}

export interface GoInterfaceMethod {
  readonly name: string;
  readonly displayName: string;
  readonly parameters: GoParameter[];
  readonly returns: GoParameter[];
  readonly startOffset: number;
  readonly endOffset: number;
  readonly nameOffset: number;
}

export interface GoImportDef {
  /** Import path exactly as written, without quotes. */
  readonly path: string;
  /** Local name: the explicit alias, `_`/`.`, or the last path segment. */
  readonly alias: string;
  readonly explicit: boolean;
  readonly offset: number;
  readonly line: number;
}

export interface GoValueDef {
  readonly name: string;
  readonly type: string;
  readonly kind: 'const' | 'var';
  readonly offset: number;
  readonly value: string;
}

export interface GoTypeDef {
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: GoTypeKind;
  readonly packageName: string;
  readonly startOffset: number;
  readonly endOffset: number;
  /** `{`/`}` of a struct or interface body; `-1` when there is none. */
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly typeParams: GoTypeParam[];
  readonly fields: GoFieldDef[];
  readonly embeddeds: GoEmbedded[];
  readonly interfaceMethods: GoInterfaceMethod[];
  /** Underlying type text for `type X int` / `type X = Y`. */
  readonly underlying: string;
  readonly isAlias: boolean;
}

export interface GoFunctionDef {
  readonly name: string;
  /** `Receiver.Name(params)` for methods, `Name(params)` for free functions. */
  readonly displayName: string;
  readonly startOffset: number;
  readonly endOffset: number;
  /** Offset of the declared name; guards call-site detection. */
  readonly nameOffset: number;
  readonly kind: NodeKind;
  /** Receiver base type (`Service` for `(s *Service)`), `null` for free functions. */
  readonly receiverType: string | null;
  readonly receiverName: string | null;
  readonly isPointerReceiver: boolean;
  readonly packageName: string;
  readonly typeParams: GoTypeParam[];
  readonly parameters: GoParameter[];
  readonly returns: GoParameter[];
  readonly isInit: boolean;
  readonly isDeclaration: boolean;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

export interface GoLocalDef {
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly isShort: boolean;
  readonly isConst: boolean;
  readonly isFuncLiteral: boolean;
}

export interface GoCompositeLiteral {
  /** Base type name of the literal (`User` for `&models.User{...}`), empty when unknown. */
  readonly typeName: string;
  readonly qualifier: string | null;
  readonly pointer: boolean;
  readonly offset: number;
}

export type GoControlFlowKind =
  | 'if'
  | 'else'
  | 'switch'
  | 'type-switch'
  | 'case'
  | 'for'
  | 'range'
  | 'break'
  | 'continue'
  | 'goto'
  | 'defer'
  | 'go'
  | 'select'
  | 'chan'
  | 'send'
  | 'receive'
  | 'return'
  | 'closure'
  | 'panic'
  | 'recover';

export interface GoControlFlowNode {
  readonly kind: GoControlFlowKind;
  readonly offset: number;
  /** Label for `goto`/`break`/`continue`, `default` for a default case, empty otherwise. */
  readonly detail: string;
}

export interface GoCallSite {
  /** Last segment of the callee chain (`Process` for `service.Process()`). */
  readonly name: string;
  /** Immediate qualifier (`service`, `pkg`), or `null` for a bare call. */
  readonly qualifier: string | null;
  /** First identifier of the chain, never empty. */
  readonly rootIdentifier: string;
  readonly offset: number;
  /** Exact source text of the callee chain. */
  readonly rawText: string;
  /** `go f()` goroutine launch. */
  readonly isGoStatement: boolean;
  /** `defer f()` deferred call. */
  readonly isDefer: boolean;
}

export interface GoBlockSpan {
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface GoFileOutline {
  readonly packageName: string;
  readonly packageOffset: number;
  readonly imports: GoImportDef[];
  readonly values: GoValueDef[];
  readonly types: GoTypeDef[];
  readonly functions: GoFunctionDef[];
  readonly composites: GoCompositeLiteral[];
  readonly controlFlow: GoControlFlowNode[];
  readonly tokens: GoToken[];
  readonly comments: GoComment[];
  readonly text: string;

  /** Innermost function/method/function literal containing `offset`. */
  functionContaining(offset: number): GoFunctionDef | undefined;
  /** Free function declared with `name` (prefers a body over a declaration). */
  functionNamed(name: string): GoFunctionDef | undefined;
  /** Type declared with `name`. */
  typeNamed(name: string): GoTypeDef | undefined;
  /** Innermost type whose span contains `offset`. */
  typeContaining(offset: number): GoTypeDef | undefined;
  /** Methods declared for `type` (interface signatures included). */
  functionsIn(type: GoTypeDef): GoFunctionDef[];
  /** Method named `name` declared by `type`. */
  methodIn(type: GoTypeDef, name: string): GoFunctionDef | undefined;
  /** Struct fields declared by `type` (embedded fields included as `embedded`). */
  fieldsIn(type: GoTypeDef): GoFieldDef[];
  /** Embedded struct/interface types declared by `type`. */
  embeddedsOf(type: GoTypeDef): GoEmbedded[];
  /** Structs whose method set covers every interface method (`interface -> implementation`). */
  implementationsOf(iface: GoTypeDef): GoTypeDef[];
  /** Local variables declared inside a function body (including `:=`). */
  localsIn(fn: GoFunctionDef): GoLocalDef[];
  /** Declared type of a parameter, receiver, local or package-level value named `name`. */
  variableType(fn: GoFunctionDef, name: string): string | undefined;
  /** Import whose local alias is `alias`. */
  importNamed(alias: string): GoImportDef | undefined;
  /** Package-level value (const or var) declared with `name`. */
  valueNamed(name: string): GoValueDef | undefined;
  /** Calls whose callee starts inside a span or inside `fn`'s body. */
  callSitesIn(span: GoFunctionDef | number, endOffset?: number, skipNestedFunctions?: boolean): GoCallSite[];
  /** Composite literals inside a span. */
  compositeLiteralsIn(startOffset: number, endOffset: number): GoCompositeLiteral[];
  /** Control-flow / concurrency constructs inside a span. */
  controlFlowIn(startOffset: number, endOffset: number): GoControlFlowNode[];
  /** Identifier names used inside `[startOffset, endOffset)`. */
  identifiersIn(startOffset: number, endOffset: number): Set<string>;
  /** Innermost `{...}` pair containing `offset`. */
  blockContaining(offset: number): GoBlockSpan | undefined;
}

const NODE_KIND_FUNCTION: NodeKind = 'FUNCTION';
const NODE_KIND_METHOD: NodeKind = 'METHOD';

const TYPE_STARTERS = new Set(['*', '[', 'map', 'chan', 'func', '<-', '...']);

interface ParsedSegment {
  readonly start: number;
  readonly end: number;
}

interface NameAndType {
  readonly names: string[];
  readonly type: string;
  readonly offset: number;
  readonly hasType: boolean;
}

/** Builds a `GoFileOutline` from the token stream. Every scan is bounded and never throws. */
export class GoFileOutlineBuilder {
  private readonly text: string;
  private readonly tokens: GoToken[];
  private readonly comments: GoComment[];
  private readonly brackets: Int32Array;
  private readonly imports: GoImportDef[] = [];
  private readonly values: GoValueDef[] = [];
  private readonly types: GoTypeDef[] = [];
  private readonly functions: GoFunctionDef[] = [];
  private readonly composites: GoCompositeLiteral[] = [];
  private readonly controlFlow: GoControlFlowNode[] = [];
  private readonly localsByFunction = new Map<number, GoLocalDef[]>();
  private packageName = '';
  private packageOffset = -1;

  constructor(text: string) {
    this.text = text;
    const stream = new GoTokenizer(text).tokenize();
    this.tokens = stream.tokens;
    this.comments = stream.comments;
    this.brackets = new Int32Array(this.tokens.length).fill(-1);
  }

  build(): GoFileOutline {
    this.matchBrackets();
    this.scanTopLevel(0, this.tokens.length);
    return new GoFileOutlineImpl({
      text: this.text,
      tokens: this.tokens,
      comments: this.comments,
      brackets: this.brackets,
      packageName: this.packageName,
      packageOffset: this.packageOffset,
      imports: this.imports,
      values: this.values,
      types: this.sortedUniqueTypes(),
      functions: this.sortedUniqueFunctions(),
      composites: this.composites,
      controlFlow: this.controlFlow,
      localsByFunction: this.localsByFunction,
    });
  }

  // -----------------------------------------------------------------------------------------------
  // Token helpers
  // -----------------------------------------------------------------------------------------------

  private textAt(index: number): string | undefined {
    return this.tokens[index]?.text;
  }

  private isIdent(index: number): boolean {
    return this.tokens[index]?.type === 'IDENTIFIER';
  }

  private matchBrackets(): void {
    const stack: number[] = [];
    for (let index = 0; index < this.tokens.length; index++) {
      const text = this.tokens[index].text;
      if (text === '(' || text === '[' || text === '{') {
        stack.push(index);
      } else if (text === ')' || text === ']' || text === '}') {
        const expected = text === ')' ? '(' : text === ']' ? '[' : '{';
        while (stack.length > 0) {
          const candidate = stack.pop() as number;
          if (this.tokens[candidate].text === expected) {
            this.brackets[candidate] = index;
            this.brackets[index] = candidate;
            break;
          }
        }
      }
    }
  }

  private compact(startOffset: number, endOffset: number): string {
    if (endOffset <= startOffset) {
      return '';
    }
    return this.text.substring(startOffset, endOffset).replace(/\s+/g, ' ').trim();
  }

  /** Splits `[from, to)` on top-level `;`, jumping over any bracketed group. */
  private segments(from: number, to: number): ParsedSegment[] {
    const result: ParsedSegment[] = [];
    let start = from;
    let index = from;
    let guard = 0;
    while (index < to && index < this.tokens.length && guard++ < 200000) {
      const text = this.tokens[index].text;
      if (text === '(' || text === '[' || text === '{') {
        const close = this.brackets[index];
        if (close > index && close < to) {
          index = close + 1;
          continue;
        }
      }
      if (text === ';') {
        if (index > start) {
          result.push({ start, end: index });
        }
        start = index + 1;
      }
      index++;
    }
    if (to > start) {
      result.push({ start, end: to });
    }
    return result;
  }

  /** Splits `[from, to)` on top-level commas, jumping over any bracketed group. */
  private commaSegments(from: number, to: number): ParsedSegment[] {
    const result: ParsedSegment[] = [];
    let start = from;
    let index = from;
    let guard = 0;
    while (index < to && index < this.tokens.length && guard++ < 20000) {
      const text = this.tokens[index].text;
      if (text === '(' || text === '[' || text === '{') {
        const close = this.brackets[index];
        if (close > index && close < to) {
          index = close + 1;
          continue;
        }
      }
      if (text === ',') {
        if (index > start) {
          result.push({ start, end: index });
        }
        start = index + 1;
      }
      index++;
    }
    if (to > start) {
      result.push({ start, end: to });
    }
    return result;
  }

  private statementEnd(from: number, limit: number): number {
    let index = from;
    let guard = 0;
    while (index < limit && index < this.tokens.length && guard++ < 20000) {
      const text = this.tokens[index].text;
      if (text === ';') {
        return index;
      }
      if (text === '(' || text === '[' || text === '{') {
        const close = this.brackets[index];
        if (close > index && close < limit) {
          index = close + 1;
          continue;
        }
      }
      index++;
    }
    return Math.min(limit, this.tokens.length);
  }

  // -----------------------------------------------------------------------------------------------
  // Top level
  // -----------------------------------------------------------------------------------------------

  private scanTopLevel(from: number, to: number): void {
    let index = from;
    let guard = 0;
    while (index < to && index < this.tokens.length && guard++ < 200000) {
      const text = this.textAt(index);
      if (text === 'package') {
        const nameIndex = index + 1;
        if (this.isIdent(nameIndex)) {
          this.packageName = this.tokens[nameIndex].text;
          this.packageOffset = this.tokens[nameIndex].startOffset;
        }
        index = this.statementEnd(index + 1, to) + 1;
        continue;
      }
      if (text === 'import') {
        index = this.handleImport(index, to);
        continue;
      }
      if (text === 'const' || text === 'var') {
        index = this.handleValue(index, to, text);
        continue;
      }
      if (text === 'type') {
        index = this.handleType(index, to);
        continue;
      }
      if (text === 'func') {
        index = this.handleFunc(index, to);
        continue;
      }
      index++;
    }
  }

  private handleImport(index: number, limit: number): number {
    let cursor = index + 1;
    const open = this.textAt(cursor);
    if (open === '(') {
      const close = this.brackets[cursor];
      if (close <= cursor) {
        return cursor + 1;
      }
      for (const segment of this.segments(cursor + 1, close)) {
        this.parseImportSpec(segment.start, segment.end);
      }
      return close + 1;
    }
    const end = this.statementEnd(cursor, limit);
    this.parseImportSpec(cursor, end);
    return end + 1;
  }

  private parseImportSpec(start: number, end: number): void {
    let pathIndex = -1;
    for (let index = start; index < end; index++) {
      if (this.tokens[index].type === 'STRING') {
        pathIndex = index;
        break;
      }
    }
    if (pathIndex < 0) {
      return;
    }
    const rawPath = this.tokens[pathIndex].text;
    const path = rawPath.substring(1, rawPath.length - 1);
    let alias = '';
    let explicit = false;
    for (let index = start; index < pathIndex; index++) {
      const token = this.tokens[index];
      if (token.type === 'IDENTIFIER' || token.text === '.' || token.text === '_') {
        alias = token.text;
        explicit = true;
      }
    }
    if (alias.length === 0) {
      const parts = path.split('/');
      alias = parts[parts.length - 1] ?? path;
    }
    this.imports.push({
      path,
      alias,
      explicit,
      offset: this.tokens[pathIndex].startOffset,
      line: this.tokens[pathIndex].line,
    });
  }

  private handleValue(index: number, limit: number, keyword: string): number {
    const kind: 'const' | 'var' = keyword === 'const' ? 'const' : 'var';
    let cursor = index + 1;
    if (this.textAt(cursor) === '(') {
      const close = this.brackets[cursor];
      if (close <= cursor) {
        return cursor + 1;
      }
      for (const segment of this.segments(cursor + 1, close)) {
        this.parseValueSpec(segment.start, segment.end, kind);
      }
      return close + 1;
    }
    const end = this.statementEnd(cursor, limit);
    this.parseValueSpec(cursor, end, kind);
    return end + 1;
  }

  private parseValueSpec(start: number, end: number, kind: 'const' | 'var'): void {
    const parsed = this.readNamesAndType(start, end);
    if (parsed === undefined) {
      return;
    }
    let value = '';
    for (let index = start; index < end; index++) {
      if (this.tokens[index].text === '=') {
        value = this.compact(this.tokens[index].endOffset, this.tokens[end - 1]?.endOffset ?? this.tokens[index].endOffset);
        break;
      }
    }
    for (const name of parsed.names) {
      this.values.push({
        name,
        type: parsed.hasType ? parsed.type : this.inferTypeFromValue(value),
        kind,
        offset: parsed.offset,
        value,
      });
    }
  }

  /** Leading `a, b` name list followed by an optional type; `undefined` when malformed. */
  private readNamesAndType(start: number, end: number): NameAndType | undefined {
    if (start >= end || !this.isIdent(start)) {
      return undefined;
    }
    const names: string[] = [];
    let cursor = start;
    let guard = 0;
    while (cursor < end && this.isIdent(cursor) && guard++ < 64) {
      names.push(this.tokens[cursor].text);
      if (this.textAt(cursor + 1) === ',' && this.isIdent(cursor + 2)) {
        cursor += 2;
        continue;
      }
      cursor += 1;
      break;
    }
    if (names.length === 0) {
      return undefined;
    }
    let typeEnd = cursor;
    while (typeEnd < end && this.textAt(typeEnd) !== '=') {
      typeEnd++;
    }
    const type = this.compact(
      this.tokens[cursor]?.startOffset ?? this.tokens[start].endOffset,
      this.tokens[typeEnd - 1]?.endOffset ?? this.tokens[start].endOffset
    );
    return {
      names,
      type,
      offset: this.tokens[start].startOffset,
      hasType: type.length > 0,
    };
  }

  private inferTypeFromValue(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return '';
    }
    if (trimmed.startsWith('&')) {
      const literal = /^&\s*([A-Za-z_][\w.]*)\s*\{/.exec(trimmed);
      if (literal) {
        return `*${literal[1]}`;
      }
      return '';
    }
    const literal = /^([A-Za-z_][\w.]*)\s*\{/.exec(trimmed);
    if (literal) {
      return literal[1];
    }
    if (/^func\s*\(/.test(trimmed)) {
      return 'func';
    }
    if (/^make\s*\(\s*chan\b/.test(trimmed)) {
      return 'chan';
    }
    if (/^\[\]/.test(trimmed)) {
      return trimmed.replace(/^\[\]([A-Za-z_][\w.]*).*/, '[]$1');
    }
    return '';
  }

  // -----------------------------------------------------------------------------------------------
  // Types
  // -----------------------------------------------------------------------------------------------

  private handleType(index: number, limit: number): number {
    let cursor = index + 1;
    if (this.textAt(cursor) === '(') {
      const close = this.brackets[cursor];
      if (close <= cursor) {
        return cursor + 1;
      }
      for (const segment of this.segments(cursor + 1, close)) {
        this.parseTypeSpec(segment.start, segment.end);
      }
      return close + 1;
    }
    const end = this.statementEnd(cursor, limit);
    this.parseTypeSpec(cursor, end);
    return end + 1;
  }

  private parseTypeSpec(start: number, end: number): void {
    if (start >= end || !this.isIdent(start)) {
      return;
    }
    const name = this.tokens[start].text;
    // Include the `type` keyword of a single declaration so the node code is the whole declaration.
    const startOffset = this.textAt(start - 1) === 'type'
      ? this.tokens[start - 1].startOffset
      : this.tokens[start].startOffset;
    let cursor = start + 1;
    let typeParams: GoTypeParam[] = [];
    if (this.textAt(cursor) === '[') {
      const close = this.brackets[cursor];
      if (close > cursor) {
        typeParams = this.parseTypeParams(cursor, close);
        cursor = close + 1;
      }
    }
    let isAlias = false;
    if (this.textAt(cursor) === '=') {
      isAlias = true;
      cursor++;
    }
    const isStruct = this.textAt(cursor) === 'struct' && this.textAt(cursor + 1) === '{';
    const isInterface = this.textAt(cursor) === 'interface' && this.textAt(cursor + 1) === '{';
    const kind: GoTypeKind = isAlias
      ? 'alias'
      : isStruct
        ? 'struct'
        : isInterface
          ? 'interface'
          : 'named';

    const fields: GoFieldDef[] = [];
    const embeddeds: GoEmbedded[] = [];
    const interfaceMethods: GoInterfaceMethod[] = [];
    let bodyStart = -1;
    let bodyEnd = -1;
    let endOffset = this.tokens[Math.max(end - 1, start)].endOffset;

    if ((isStruct || isInterface) && this.textAt(cursor + 1) === '{') {
      const open = cursor + 1;
      const close = this.brackets[open];
      if (close > open) {
        bodyStart = this.tokens[open].endOffset;
        bodyEnd = this.tokens[close].startOffset;
        endOffset = this.tokens[close].endOffset;
        if (isStruct) {
          this.parseStructBody(open, close, fields, embeddeds);
        } else {
          this.parseInterfaceBody(open, close, interfaceMethods, embeddeds);
        }
      } else {
        endOffset = this.tokens[open].endOffset;
      }
    }

    const underlyingStart = cursor < end
      ? this.tokens[cursor].startOffset
      : this.tokens[start].endOffset;
    const underlyingEnd = bodyStart >= 0
      ? this.tokens[cursor + 1].endOffset
      : endOffset;
    const underlying = isStruct || isInterface
      ? this.compact(underlyingStart, underlyingEnd)
      : this.compact(underlyingStart, this.tokens[Math.max(end - 1, cursor)]?.endOffset ?? underlyingStart);

    const type: GoTypeDef = {
      name,
      qualifiedName: this.packageName.length > 0 ? `${this.packageName}.${name}` : name,
      kind,
      packageName: this.packageName,
      startOffset,
      endOffset,
      bodyStart,
      bodyEnd,
      typeParams,
      fields,
      embeddeds,
      interfaceMethods,
      underlying,
      isAlias,
    };
    this.types.push(type);
  }

  /** `[T any]`, `[K, V comparable]`, `[T ~int | ~string]`; names may share a constraint. */
  private parseTypeParams(open: number, close: number): GoTypeParam[] {
    const result: GoTypeParam[] = [];
    let buffered: Array<{ name: string; offset: number }> = [];
    for (const segment of this.commaSegments(open + 1, close)) {
      if (!this.isIdent(segment.start)) {
        continue;
      }
      const name = this.tokens[segment.start].text;
      const offset = this.tokens[segment.start].startOffset;
      if (segment.start + 1 >= segment.end) {
        buffered.push({ name, offset });
        continue;
      }
      const constraint = this.compact(
        this.tokens[segment.start + 1].startOffset,
        this.tokens[segment.end - 1].endOffset
      );
      for (const pending of buffered) {
        result.push({ name: pending.name, constraint, offset: pending.offset });
      }
      buffered = [];
      result.push({ name, constraint, offset });
    }
    for (const pending of buffered) {
      result.push({ name: pending.name, constraint: '', offset: pending.offset });
    }
    return result;
  }

  private parseStructBody(
    open: number,
    close: number,
    fields: GoFieldDef[],
    embeddeds: GoEmbedded[]
  ): void {
    for (const segment of this.segments(open + 1, close)) {
      let limit = segment.end;
      let tag = '';
      if (limit - 1 > segment.start && this.tokens[limit - 1].type === 'STRING') {
        tag = this.tokens[limit - 1].text;
        limit--;
      }
      if (limit <= segment.start) {
        continue;
      }
      const first = this.tokens[segment.start];
      const rawType = (from: number): string =>
        this.compact(this.tokens[from].startOffset, this.tokens[limit - 1].endOffset);

      if (first.text === '*') {
        const text = rawType(segment.start);
        const name = lastIdentifierOf(text);
        embeddeds.push({ name, type: text, pointer: true, offset: first.startOffset });
        fields.push({ name, type: text, embedded: true, pointer: true, tag, offset: first.startOffset });
        continue;
      }
      if (limit - segment.start === 1 && first.type === 'IDENTIFIER') {
        embeddeds.push({ name: first.text, type: first.text, pointer: false, offset: first.startOffset });
        fields.push({
          name: first.text,
          type: first.text,
          embedded: true,
          pointer: false,
          tag,
          offset: first.startOffset,
        });
        continue;
      }
      if (
        first.type === 'IDENTIFIER' &&
        (this.textAt(segment.start + 1) === '.' || this.textAt(segment.start + 1) === '[')
      ) {
        const text = rawType(segment.start);
        const name = lastIdentifierOf(text);
        embeddeds.push({ name, type: text, pointer: false, offset: first.startOffset });
        fields.push({ name, type: text, embedded: true, pointer: false, tag, offset: first.startOffset });
        continue;
      }

      const names: string[] = [];
      let cursor = segment.start;
      while (cursor < limit && this.isIdent(cursor)) {
        names.push(this.tokens[cursor].text);
        if (this.textAt(cursor + 1) === ',' && this.isIdent(cursor + 2)) {
          cursor += 2;
          continue;
        }
        cursor += 1;
        break;
      }
      if (names.length === 0) {
        continue;
      }
      if (names.length === 1 && cursor >= limit) {
        embeddeds.push({ name: names[0], type: names[0], pointer: false, offset: first.startOffset });
        fields.push({ name: names[0], type: names[0], embedded: true, pointer: false, tag, offset: first.startOffset });
        continue;
      }
      const type = this.compact(
        this.tokens[cursor]?.startOffset ?? first.endOffset,
        this.tokens[limit - 1].endOffset
      );
      const multiple = this.fieldNameCount(segment.start, cursor);
      for (let index = 0; index < multiple; index++) {
        fields.push({
          name: names[index],
          type,
          embedded: false,
          pointer: type.startsWith('*'),
          tag,
          offset: first.startOffset,
        });
      }
    }
  }

  /** Number of declared names before `typeStart` (`a, b` -> 2). */
  private fieldNameCount(start: number, typeStart: number): number {
    let count = 0;
    for (let index = start; index < typeStart; index++) {
      if (this.isIdent(index) && (index === start || this.textAt(index - 1) === ',')) {
        count++;
      }
    }
    return count > 0 ? count : 1;
  }

  private parseInterfaceBody(
    open: number,
    close: number,
    methods: GoInterfaceMethod[],
    embeddeds: GoEmbedded[]
  ): void {
    for (const segment of this.segments(open + 1, close)) {
      if (this.isIdent(segment.start) && this.textAt(segment.start + 1) === '(') {
        const paramsOpen = segment.start + 1;
        const paramsClose = this.brackets[paramsOpen];
        if (paramsClose <= paramsOpen) {
          continue;
        }
        const name = this.tokens[segment.start].text;
        const parameters = this.parseParamList(paramsOpen, paramsClose);
        const returns = this.parseReturnsAt(paramsClose + 1, segment.end).returns;
        methods.push({
          name,
          displayName: `${name}(${this.compact(this.tokens[paramsOpen].endOffset, this.tokens[paramsClose].startOffset)})`,
          parameters,
          returns,
          startOffset: this.tokens[segment.start].startOffset,
          endOffset: this.tokens[segment.end - 1].endOffset,
          nameOffset: this.tokens[segment.start].startOffset,
        });
        continue;
      }
      const text = this.compact(
        this.tokens[segment.start].startOffset,
        this.tokens[segment.end - 1].endOffset
      );
      if (text.length > 0) {
        embeddeds.push({
          name: lastIdentifierOf(text),
          type: text,
          pointer: false,
          offset: this.tokens[segment.start].startOffset,
        });
      }
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Functions and methods
  // -----------------------------------------------------------------------------------------------

  private handleFunc(index: number, limit: number): number {
    let cursor = index + 1;
    let receiverType: string | null = null;
    let receiverName: string | null = null;
    let isPointerReceiver = false;
    if (this.textAt(cursor) === '(') {
      const close = this.brackets[cursor];
      if (close <= cursor) {
        return cursor + 1;
      }
      const receiver = this.parseParamList(cursor, close)[0];
      if (receiver !== undefined) {
        receiverName = receiver.name.length > 0 ? receiver.name : null;
        isPointerReceiver = receiver.type.trim().startsWith('*');
        receiverType = baseTypeName(receiver.type);
      }
      cursor = close + 1;
    }
    if (!this.isIdent(cursor)) {
      return cursor + 1;
    }
    const name = this.tokens[cursor].text;
    const nameOffset = this.tokens[cursor].startOffset;
    cursor++;
    let typeParams: GoTypeParam[] = [];
    if (this.textAt(cursor) === '[') {
      const close = this.brackets[cursor];
      if (close > cursor) {
        typeParams = this.parseTypeParams(cursor, close);
        cursor = close + 1;
      }
    }
    if (this.textAt(cursor) !== '(') {
      return cursor + 1;
    }
    const paramsOpen = cursor;
    const paramsClose = this.brackets[paramsOpen];
    if (paramsClose <= paramsOpen) {
      return paramsOpen + 1;
    }
    const parameters = this.parseParamList(paramsOpen, paramsClose);
    const returns = this.parseReturnsAt(paramsClose + 1, limit);
    cursor = returns.next;
    const paramsText = this.compact(
      this.tokens[paramsOpen].endOffset,
      this.tokens[paramsClose].startOffset
    );
    const displayBase = receiverType !== null ? `${receiverType}.${name}` : name;
    const displayName = `${displayBase}(${paramsText})`;

    let bodyOpen = -1;
    let bodyClose = -1;
    if (this.textAt(cursor) === '{') {
      bodyOpen = cursor;
      const close = this.brackets[cursor];
      bodyClose = close > cursor ? close : -1;
    }
    const startOffset = this.tokens[index].startOffset;
    let endOffset: number;
    if (bodyClose > bodyOpen) {
      endOffset = this.tokens[bodyClose].endOffset;
    } else if (cursor < this.tokens.length) {
      endOffset = this.tokens[Math.min(cursor, this.tokens.length - 1)].endOffset;
    } else {
      endOffset = this.tokens[this.tokens.length - 1]?.endOffset ?? startOffset;
    }

    const definition: GoFunctionDef = {
      name,
      displayName,
      startOffset,
      endOffset,
      nameOffset,
      kind: receiverType !== null ? NODE_KIND_METHOD : NODE_KIND_FUNCTION,
      receiverType,
      receiverName,
      isPointerReceiver,
      packageName: this.packageName,
      typeParams,
      parameters,
      returns: returns.returns,
      isInit: name === 'init' && receiverType === null,
      isDeclaration: bodyClose < 0,
      bodyStart: bodyClose > bodyOpen ? this.tokens[bodyOpen].endOffset : 0,
      bodyEnd: bodyClose > bodyOpen ? this.tokens[bodyClose].startOffset : 0,
    };
    this.functions.push(definition);

    if (bodyClose > bodyOpen) {
      this.localsByFunction.set(startOffset, []);
      this.scanBody(bodyOpen + 1, bodyClose, definition);
    }
    return bodyClose > bodyOpen ? bodyClose + 1 : cursor + 1;
  }

  /**
   * Parameter / result list. Consecutive segments share the type of the next typed segment
   * (`a, b int`), while a lone identifier in an otherwise type-only list is an unnamed type.
   */
  private parseParamList(open: number, close: number): GoParameter[] {
    if (close <= open + 1) {
      return [];
    }
    const parsed: NameAndType[] = [];
    for (const segment of this.commaSegments(open + 1, close)) {
      const first = this.tokens[segment.start];
      if (first === undefined) {
        continue;
      }
      if (TYPE_STARTERS.has(first.text) || first.text === 'interface' || first.text === 'struct') {
        parsed.push({
          names: [],
          type: this.compact(first.startOffset, this.tokens[segment.end - 1].endOffset),
          offset: first.startOffset,
          hasType: true,
        });
        continue;
      }
      if (
        first.type === 'IDENTIFIER' &&
        (this.textAt(segment.start + 1) === '.' || this.textAt(segment.start + 1) === '[')
      ) {
        // `pkg.Type` / `Result[bool]`: a qualified or generic type, never a parameter name.
        parsed.push({
          names: [],
          type: this.compact(first.startOffset, this.tokens[segment.end - 1].endOffset),
          offset: first.startOffset,
          hasType: true,
        });
        continue;
      }
      if (segment.end - segment.start === 1 && first.type === 'IDENTIFIER') {
        parsed.push({ names: [first.text], type: '', offset: first.startOffset, hasType: false });
        continue;
      }
      if (first.type === 'IDENTIFIER' || first.type === 'KEYWORD') {
        const names: string[] = [];
        let cursor = segment.start;
        while (cursor < segment.end && (this.tokens[cursor].type === 'IDENTIFIER' || this.tokens[cursor].text === '_')) {
          names.push(this.tokens[cursor].text);
          if (this.textAt(cursor + 1) === ',' && cursor + 2 < segment.end) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        const type = this.compact(
          this.tokens[cursor]?.startOffset ?? first.endOffset,
          this.tokens[segment.end - 1].endOffset
        );
        parsed.push({
          names,
          type,
          offset: first.startOffset,
          hasType: type.length > 0,
        });
        continue;
      }
      parsed.push({
        names: [],
        type: this.compact(first.startOffset, this.tokens[segment.end - 1].endOffset),
        offset: first.startOffset,
        hasType: true,
      });
    }

    const anyTyped = parsed.some((parameter) => parameter.hasType);
    const result: GoParameter[] = [];
    if (!anyTyped) {
      for (const parameter of parsed) {
        for (const name of parameter.names) {
          result.push({ name: '', type: name, offset: parameter.offset, variadic: false });
        }
      }
      return result;
    }
    let buffered: NameAndType[] = [];
    for (const parameter of parsed) {
      if (!parameter.hasType) {
        buffered.push(parameter);
        continue;
      }
      for (const pending of buffered) {
        for (const name of pending.names) {
          result.push({
            name,
            type: parameter.type,
            offset: pending.offset,
            variadic: parameter.type.startsWith('...'),
          });
        }
      }
      buffered = [];
      if (parameter.names.length === 0) {
        result.push({
          name: '',
          type: parameter.type,
          offset: parameter.offset,
          variadic: parameter.type.startsWith('...'),
        });
        continue;
      }
      for (const name of parameter.names) {
        result.push({
          name,
          type: parameter.type,
          offset: parameter.offset,
          variadic: parameter.type.startsWith('...'),
        });
      }
    }
    for (const pending of buffered) {
      for (const name of pending.names) {
        result.push({ name: '', type: name, offset: pending.offset, variadic: false });
      }
    }
    return result;
  }

  /** Result list after the parameter list; decides where the body brace may start. */
  private parseReturnsAt(from: number, limit: number): { returns: GoParameter[]; next: number } {
    const text = this.textAt(from);
    if (text === undefined || text === '{' || text === ';') {
      return { returns: [], next: from };
    }
    if (text === '(') {
      const close = this.brackets[from];
      if (close <= from) {
        return { returns: [], next: from };
      }
      return { returns: this.parseParamList(from, close), next: close + 1 };
    }
    const typeStarter = TYPE_STARTERS.has(text) || this.isIdent(from);
    if (!typeStarter) {
      return { returns: [], next: from };
    }
    let cursor = from;
    let guard = 0;
    while (cursor < limit && cursor < this.tokens.length && guard++ < 200) {
      const current = this.tokens[cursor].text;
      if (current === '{' || current === ';' || current === '}') {
        break;
      }
      if (current === '(' || current === '[') {
        const close = this.brackets[cursor];
        if (close > cursor) {
          cursor = close + 1;
          continue;
        }
      }
      cursor++;
    }
    if (cursor <= from) {
      return { returns: [], next: from };
    }
    return {
      returns: [{
        name: '',
        type: this.compact(this.tokens[from].startOffset, this.tokens[cursor - 1].endOffset),
        offset: this.tokens[from].startOffset,
        variadic: false,
      }],
      next: cursor,
    };
  }

  /** Function literal (`func(params) results { ... }`) as a nested function scope. */
  private tryFuncLiteral(index: number, limit: number): number | undefined {
    if (this.textAt(index + 1) !== '(') {
      return undefined;
    }
    const paramsOpen = index + 1;
    const paramsClose = this.brackets[paramsOpen];
    if (paramsClose <= paramsOpen) {
      return undefined;
    }
    const parameters = this.parseParamList(paramsOpen, paramsClose);
    const returns = this.parseReturnsAt(paramsClose + 1, limit);
    if (this.textAt(returns.next) !== '{') {
      return undefined;
    }
    const bodyOpen = returns.next;
    const bodyClose = this.brackets[bodyOpen];
    if (bodyClose <= bodyOpen) {
      return undefined;
    }
    const paramsText = this.compact(
      this.tokens[paramsOpen].endOffset,
      this.tokens[paramsClose].startOffset
    );
    const definition: GoFunctionDef = {
      name: 'func',
      displayName: `func(${paramsText})`,
      startOffset: this.tokens[index].startOffset,
      endOffset: this.tokens[bodyClose].endOffset,
      nameOffset: this.tokens[index].startOffset,
      kind: NODE_KIND_FUNCTION,
      receiverType: null,
      receiverName: null,
      isPointerReceiver: false,
      packageName: this.packageName,
      typeParams: [],
      parameters,
      returns: returns.returns,
      isInit: false,
      isDeclaration: false,
      bodyStart: this.tokens[bodyOpen].endOffset,
      bodyEnd: this.tokens[bodyClose].startOffset,
    };
    this.functions.push(definition);
    this.localsByFunction.set(definition.startOffset, []);
    this.controlFlow.push({ kind: 'closure', offset: definition.startOffset, detail: '' });
    this.scanBody(bodyOpen + 1, bodyClose, definition);
    return bodyClose + 1;
  }

  // -----------------------------------------------------------------------------------------------
  // Function bodies
  // -----------------------------------------------------------------------------------------------

  private scanBody(from: number, to: number, fn: GoFunctionDef): void {
    let index = from;
    let guard = 0;
    while (index < to && index < this.tokens.length && guard++ < 200000) {
      const token = this.tokens[index];
      const text = token.text;
      if (text === 'func') {
        const literal = this.tryFuncLiteral(index, to);
        if (literal !== undefined) {
          index = literal;
          continue;
        }
      }
      if (text === 'var' || text === 'const') {
        this.parseLocalValueDecl(index, to, fn, text === 'const');
        index++;
        continue;
      }
      if (token.type === 'IDENTIFIER') {
        this.tryShortDeclaration(index, to, fn);
      }
      this.recordControlFlow(index, to);
      this.recordCompositeLiteral(index, to);
      index++;
    }
  }

  private parseLocalValueDecl(index: number, limit: number, fn: GoFunctionDef, isConst: boolean): void {
    let cursor = index + 1;
    let declarations: ParsedSegment[] = [];
    if (this.textAt(cursor) === '(') {
      const close = this.brackets[cursor];
      if (close <= cursor) {
        return;
      }
      declarations = this.segments(cursor + 1, close);
    } else {
      declarations = [{ start: cursor, end: this.statementEnd(cursor, limit) }];
    }
    for (const declaration of declarations) {
      const parsed = this.readNamesAndType(declaration.start, declaration.end);
      if (parsed === undefined) {
        continue;
      }
      let value = '';
      for (let scan = declaration.start; scan < declaration.end; scan++) {
        if (this.tokens[scan].text === '=') {
          value = this.compact(
            this.tokens[scan].endOffset,
            this.tokens[declaration.end - 1]?.endOffset ?? this.tokens[scan].endOffset
          );
          break;
        }
      }
      const inferred = parsed.hasType ? parsed.type : this.inferTypeFromValue(value);
      for (const name of parsed.names) {
        this.addLocal(fn, {
          name,
          type: inferred,
          offset: parsed.offset,
          isShort: false,
          isConst,
          isFuncLiteral: inferred === 'func',
        });
      }
    }
  }

  private tryShortDeclaration(index: number, limit: number, fn: GoFunctionDef): void {
    const names: string[] = [];
    let cursor = index;
    let guard = 0;
    while (cursor < limit && this.isIdent(cursor) && guard++ < 64) {
      names.push(this.tokens[cursor].text);
      if (this.textAt(cursor + 1) === ',' && this.isIdent(cursor + 2)) {
        cursor += 2;
        continue;
      }
      cursor += 1;
      break;
    }
    if (names.length === 0 || this.textAt(cursor) !== ':=') {
      return;
    }
    const end = this.statementEnd(cursor + 1, limit);
    const value = this.compact(
      this.tokens[cursor].endOffset,
      this.tokens[Math.max(end - 1, cursor)].endOffset
    );
    const inferred = this.inferTypeFromValue(value);
    for (const name of names) {
      this.addLocal(fn, {
        name,
        type: inferred,
        offset: this.tokens[index].startOffset,
        isShort: true,
        isConst: false,
        isFuncLiteral: inferred === 'func',
      });
    }
  }

  private addLocal(fn: GoFunctionDef, local: GoLocalDef): void {
    if (local.name === '_') {
      return;
    }
    const locals = this.localsByFunction.get(fn.startOffset) ?? [];
    // One entry per declared name: `a, b := ...` is visited again at `b`, and shadowing inside a
    // nested block still refers to the same symbol for flow purposes.
    if (locals.some((existing) => existing.name === local.name)) {
      return;
    }
    locals.push(local);
    this.localsByFunction.set(fn.startOffset, locals);
  }

  /** Control flow, concurrency and channel constructs inside a function body. */
  private recordControlFlow(index: number, limit: number): void {
    const token = this.tokens[index];
    const push = (kind: GoControlFlowKind, detail = ''): void => {
      this.controlFlow.push({ kind, offset: token.startOffset, detail });
    };
    switch (token.text) {
      case 'if':
        push('if');
        break;
      case 'else':
        push('else');
        break;
      case 'switch':
        push(this.headerContainsTypeSwitch(index, limit) ? 'type-switch' : 'switch');
        break;
      case 'case':
        push('case');
        break;
      case 'default':
        push('case', 'default');
        break;
      case 'for':
        push(this.headerContainsKeyword(index, limit, 'range') ? 'range' : 'for');
        break;
      case 'break':
        push('break', this.labelAfter(index, limit));
        break;
      case 'continue':
        push('continue', this.labelAfter(index, limit));
        break;
      case 'goto':
        push('goto', this.labelAfter(index, limit));
        break;
      case 'defer':
        push('defer');
        break;
      case 'go':
        push('go');
        break;
      case 'select':
        push('select');
        break;
      case 'chan':
        push('chan');
        break;
      case '<-':
        push(this.isChannelSend(index) ? 'send' : 'receive');
        break;
      case 'return':
        push('return');
        break;
      case 'panic':
        if (this.textAt(index + 1) === '(') {
          push('panic');
        }
        break;
      case 'recover':
        if (this.textAt(index + 1) === '(') {
          push('recover');
        }
        break;
      case 'make':
        if (this.textAt(index + 2) === 'chan') {
          push('chan');
        }
        break;
      default:
        break;
    }
  }

  private headerContainsKeyword(index: number, limit: number, keyword: string): boolean {
    let cursor = index + 1;
    let guard = 0;
    while (cursor < limit && cursor < this.tokens.length && guard++ < 200) {
      const text = this.tokens[cursor].text;
      if (text === '{' || text === ';') {
        return false;
      }
      if (text === keyword) {
        return true;
      }
      cursor++;
    }
    return false;
  }

  private headerContainsTypeSwitch(index: number, limit: number): boolean {
    let cursor = index + 1;
    let guard = 0;
    while (cursor < limit && cursor < this.tokens.length && guard++ < 200) {
      const text = this.tokens[cursor].text;
      if (text === '{' || text === ';') {
        return false;
      }
      if (
        text === '.' &&
        this.textAt(cursor + 1) === '(' &&
        this.textAt(cursor + 2) === 'type' &&
        this.textAt(cursor + 3) === ')'
      ) {
        return true;
      }
      cursor++;
    }
    return false;
  }

  private labelAfter(index: number, limit: number): string {
    const next = this.tokens[index + 1];
    if (next !== undefined && next.type === 'IDENTIFIER' && index + 1 < limit) {
      return next.text;
    }
    return '';
  }

  /** `ch <- v` is a send; `<-ch` / `case <-ch:` is a receive. */
  private isChannelSend(index: number): boolean {
    const previous = this.tokens[index - 1];
    if (previous === undefined) {
      return false;
    }
    if (previous.type === 'IDENTIFIER' || previous.type === 'NUMBER' || previous.type === 'STRING') {
      return true;
    }
    return previous.text === ')' || previous.text === ']' || previous.text === '}';
  }

  /** `Type{...}`, `&Type{...}`, `[]Type{...}`: object/value creation of a declared type. */
  private recordCompositeLiteral(index: number, limit: number): void {
    if (this.textAt(index) !== '{') {
      return;
    }
    const previous = this.tokens[index - 1];
    if (previous === undefined) {
      return;
    }
    let chainStart = index - 1;
    let typeEnd = index;
    if (previous.type === 'IDENTIFIER') {
      while (
        chainStart - 2 >= 0 &&
        this.tokens[chainStart - 1]?.text === '.' &&
        this.tokens[chainStart - 2]?.type === 'IDENTIFIER'
      ) {
        chainStart -= 2;
      }
    } else if (previous.text === ']') {
      // Generic literal: `Result[bool]{...}`; the type arguments are not part of the type name.
      const open = this.brackets[index - 1];
      if (open <= 0 || this.tokens[open - 1]?.type !== 'IDENTIFIER') {
        return;
      }
      chainStart = open - 1;
      typeEnd = open;
      while (
        chainStart - 2 >= 0 &&
        this.tokens[chainStart - 1]?.text === '.' &&
        this.tokens[chainStart - 2]?.type === 'IDENTIFIER'
      ) {
        chainStart -= 2;
      }
    } else {
      return;
    }
    // A brace after `if x`, `for ...`, `switch x`, `else`, `func(...)`... is a block, not a literal.
    const beforeChain = this.tokens[chainStart - 1];
    if (beforeChain !== undefined) {
      const allowed = new Set(['=', ':=', '(', ',', '{', ';', ':', 'return', 'case', '&', '[']);
      if (!allowed.has(beforeChain.text) && beforeChain.type !== 'PUNCTUATION') {
        return;
      }
    }
    const chainTokens = this.tokens.slice(chainStart, typeEnd);
    const identifiers = chainTokens.filter((token) => token.type === 'IDENTIFIER').map((token) => token.text);
    if (identifiers.length === 0 || chainStart < 0 || index >= limit) {
      return;
    }
    const typeName = identifiers[identifiers.length - 1];
    const qualifier = identifiers.length > 1 ? identifiers[identifiers.length - 2] : null;
    const pointer = this.tokens[chainStart - 1]?.text === '&';
    this.composites.push({
      typeName,
      qualifier,
      pointer,
      offset: this.tokens[chainStart].startOffset,
    });
  }

  // -----------------------------------------------------------------------------------------------
  // Deduplication helpers
  // -----------------------------------------------------------------------------------------------

  private sortedUniqueTypes(): GoTypeDef[] {
    const unique: GoTypeDef[] = [];
    for (const type of this.types) {
      if (unique.every((other) => other.startOffset !== type.startOffset)) {
        unique.push(type);
      }
    }
    unique.sort((left, right) => left.startOffset - right.startOffset);
    return unique;
  }

  private sortedUniqueFunctions(): GoFunctionDef[] {
    const unique: GoFunctionDef[] = [];
    for (const fn of this.functions) {
      if (unique.every((other) => other.startOffset !== fn.startOffset || other.name !== fn.name)) {
        unique.push(fn);
      }
    }
    unique.sort((left, right) => left.startOffset - right.startOffset);
    return unique;
  }
}

/** Strips pointers, slices, arrays, maps and channel wrappers: `map[string]*pkg.Service` -> `pkg.Service`. */
export function containerTypeName(raw: string): string {
  let value = raw.trim();
  let guard = 0;
  while (value.length > 0 && guard++ < 16) {
    if (value.startsWith('*') || value.startsWith('&')) {
      value = value.slice(1).trim();
      continue;
    }
    if (value.startsWith('<-')) {
      value = value.slice(2).trim();
      continue;
    }
    if (value.startsWith('chan ')) {
      value = value.slice(5).trim();
      continue;
    }
    if (value.startsWith('[]')) {
      value = value.slice(2).trim();
      continue;
    }
    if (value.startsWith('[')) {
      const close = value.indexOf(']');
      value = close >= 0 ? value.slice(close + 1).trim() : value;
      continue;
    }
    if (value.startsWith('map[')) {
      const close = value.indexOf(']');
      value = close >= 0 ? value.slice(close + 1).trim() : value;
      continue;
    }
    if (value.startsWith('func(')) {
      return 'func';
    }
    break;
  }
  return value.trim();
}

/** `*pkg.Service[T]` -> `Service`. */
export function baseTypeName(raw: string): string {
  let value = containerTypeName(raw);
  const generic = value.indexOf('[');
  if (generic > 0) {
    value = value.substring(0, generic).trim();
  }
  const dot = value.lastIndexOf('.');
  if (dot >= 0 && dot + 1 < value.length) {
    value = value.substring(dot + 1);
  }
  return value.trim();
}

function lastIdentifierOf(raw: string): string {
  const matches = raw.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (matches === null || matches.length === 0) {
    return raw.trim();
  }
  return matches[matches.length - 1];
}

interface OutlineData {
  readonly text: string;
  readonly tokens: GoToken[];
  readonly comments: GoComment[];
  readonly brackets: Int32Array;
  readonly packageName: string;
  readonly packageOffset: number;
  readonly imports: GoImportDef[];
  readonly values: GoValueDef[];
  readonly types: GoTypeDef[];
  readonly functions: GoFunctionDef[];
  readonly composites: GoCompositeLiteral[];
  readonly controlFlow: GoControlFlowNode[];
  readonly localsByFunction: Map<number, GoLocalDef[]>;
}

/** Concrete outline; all data is computed by the builder. */
export class GoFileOutlineImpl implements GoFileOutline {
  readonly packageName: string;
  readonly packageOffset: number;
  readonly imports: GoImportDef[];
  readonly values: GoValueDef[];
  readonly types: GoTypeDef[];
  readonly functions: GoFunctionDef[];
  readonly composites: GoCompositeLiteral[];
  readonly controlFlow: GoControlFlowNode[];
  readonly tokens: GoToken[];
  readonly comments: GoComment[];
  readonly text: string;
  private readonly brackets: Int32Array;
  private readonly localsByFunction: Map<number, GoLocalDef[]>;
  private declarationOffsetCache: Set<number> | undefined;

  constructor(data: OutlineData) {
    this.text = data.text;
    this.tokens = data.tokens;
    this.comments = data.comments;
    this.brackets = data.brackets;
    this.packageName = data.packageName;
    this.packageOffset = data.packageOffset;
    this.imports = data.imports;
    this.values = data.values;
    this.types = data.types;
    this.functions = data.functions;
    this.composites = data.composites;
    this.controlFlow = data.controlFlow;
    this.localsByFunction = data.localsByFunction;
  }

  functionContaining(offset: number): GoFunctionDef | undefined {
    const contained = this.functions.filter(
      (fn) => offset >= fn.startOffset && offset <= fn.endOffset
    );
    if (contained.length === 0) {
      return undefined;
    }
    return contained.reduce((best, current) => {
      if (current.startOffset > best.startOffset) {
        return current;
      }
      if (current.startOffset === best.startOffset && current.endOffset < best.endOffset) {
        return current;
      }
      return best;
    });
  }

  functionNamed(name: string): GoFunctionDef | undefined {
    const candidates = this.functions.filter((fn) => fn.name === name && fn.receiverType === null);
    return candidates.find((fn) => !fn.isDeclaration) ?? candidates[0];
  }

  typeNamed(name: string): GoTypeDef | undefined {
    const bare = baseTypeName(name);
    if (bare.length === 0) {
      return undefined;
    }
    return this.types.find((type) => type.name === bare);
  }

  typeContaining(offset: number): GoTypeDef | undefined {
    let best: GoTypeDef | undefined;
    for (const type of this.types) {
      if (offset < type.startOffset || offset > type.endOffset) {
        continue;
      }
      if (best === undefined || type.startOffset > best.startOffset) {
        best = type;
      }
    }
    return best;
  }

  functionsIn(type: GoTypeDef): GoFunctionDef[] {
    const methods = this.functions.filter((fn) => fn.receiverType === type.name);
    if (type.kind !== 'interface') {
      return methods;
    }
    const synthesized = type.interfaceMethods.map((method) =>
      interfaceMethodDefinition(type, method, this.packageName)
    );
    return [...methods, ...synthesized];
  }

  methodIn(type: GoTypeDef, name: string): GoFunctionDef | undefined {
    const candidates = this.functionsIn(type).filter((fn) => fn.name === name);
    return candidates.find((fn) => !fn.isDeclaration) ?? candidates[0];
  }

  fieldsIn(type: GoTypeDef): GoFieldDef[] {
    return type.fields;
  }

  embeddedsOf(type: GoTypeDef): GoEmbedded[] {
    return type.embeddeds;
  }

  implementationsOf(iface: GoTypeDef): GoTypeDef[] {
    if (iface.kind !== 'interface' || iface.interfaceMethods.length === 0) {
      return [];
    }
    const required = iface.interfaceMethods.map((method) => method.name);
    return this.types.filter(
      (candidate) =>
        candidate.kind === 'struct' &&
        candidate.name !== iface.name &&
        required.every((name) =>
          this.functions.some((fn) => fn.receiverType === candidate.name && fn.name === name)
        )
    );
  }

  localsIn(fn: GoFunctionDef): GoLocalDef[] {
    return this.localsByFunction.get(fn.startOffset) ?? [];
  }

  variableType(fn: GoFunctionDef, name: string): string | undefined {
    const parameter = fn.parameters.find((param) => param.name === name);
    if (parameter !== undefined && parameter.type.length > 0) {
      return parameter.type;
    }
    if (fn.receiverType !== null && fn.receiverName === name) {
      return `${fn.isPointerReceiver ? '*' : ''}${fn.receiverType}`;
    }
    const local = this.localsIn(fn).find((item) => item.name === name);
    if (local !== undefined && local.type.length > 0) {
      return local.type;
    }
    const value = this.valueNamed(name);
    if (value !== undefined && value.type.length > 0) {
      return value.type;
    }
    return undefined;
  }

  importNamed(alias: string): GoImportDef | undefined {
    return this.imports.find((item) => item.alias === alias);
  }

  valueNamed(name: string): GoValueDef | undefined {
    return this.values.find((value) => value.name === name);
  }

  compositeLiteralsIn(startOffset: number, endOffset: number): GoCompositeLiteral[] {
    return this.composites.filter(
      (literal) => literal.offset >= startOffset && literal.offset <= endOffset
    );
  }

  controlFlowIn(startOffset: number, endOffset: number): GoControlFlowNode[] {
    return this.controlFlow.filter(
      (node) => node.offset >= startOffset && node.offset <= endOffset
    );
  }

  identifiersIn(startOffset: number, endOffset: number): Set<string> {
    const names = new Set<string>();
    let index = this.firstTokenIndexAtOrAfter(startOffset);
    while (index < this.tokens.length && this.tokens[index].startOffset < endOffset) {
      if (this.tokens[index].type === 'IDENTIFIER') {
        names.add(this.tokens[index].text);
      }
      index++;
    }
    return names;
  }

  callSitesIn(
    span: GoFunctionDef | number,
    endOffset?: number,
    skipNestedFunctions = true
  ): GoCallSite[] {
    const isFunction = typeof span !== 'number';
    const start = isFunction ? span.bodyStart : span;
    const end = isFunction ? span.bodyEnd : (endOffset ?? this.text.length);
    if (end <= start) {
      return [];
    }
    const declarations = this.declarationOffsets();
    const nested = isFunction
      ? []
      : skipNestedFunctions
        ? this.functions.filter((fn) => fn.startOffset > start && fn.endOffset <= end)
        : [];
    const sites = new Map<number, GoCallSite>();
    let index = this.firstTokenIndexAtOrAfter(start);
    while (index < this.tokens.length && this.tokens[index].startOffset < end) {
      const token = this.tokens[index];
      if (token.type !== 'IDENTIFIER') {
        index++;
        continue;
      }
      if (declarations.has(token.startOffset)) {
        index++;
        continue;
      }
      if (nested.some((fn) => token.startOffset >= fn.startOffset && token.startOffset <= fn.endOffset)) {
        index++;
        continue;
      }
      if (this.textAt(index + 1) === ':') {
        index++;
        continue;
      }
      const chain = this.readChain(index);
      let afterChain = chain.lastIndex + 1;
      if (this.textAt(afterChain) === '[') {
        const close = this.brackets[afterChain];
        if (close > afterChain && this.textAt(close + 1) === '(') {
          afterChain = close + 1;
        }
      }
      if (this.textAt(afterChain) !== '(') {
        index = chain.lastIndex + 1;
        continue;
      }
      const previous = this.tokens[index - 1];
      const rawEnd = this.tokens[afterChain - 1]?.endOffset ?? token.endOffset;
      sites.set(token.startOffset, {
        name: chain.names[chain.names.length - 1],
        qualifier: chain.names.length > 1 ? chain.names[chain.names.length - 2] : null,
        rootIdentifier: chain.names[0],
        offset: token.startOffset,
        rawText: this.text.substring(token.startOffset, rawEnd),
        isGoStatement: previous?.text === 'go',
        isDefer: previous?.text === 'defer',
      });
      index = afterChain;
    }
    return Array.from(sites.values());
  }

  blockContaining(offset: number): GoBlockSpan | undefined {
    let best: GoBlockSpan | undefined;
    for (let index = 0; index < this.tokens.length; index++) {
      if (this.tokens[index].text !== '{') {
        continue;
      }
      const close = this.brackets[index];
      if (close <= 0) {
        continue;
      }
      const start = this.tokens[index].startOffset;
      const end = this.tokens[close].endOffset;
      if (offset < start || offset > end) {
        continue;
      }
      if (best === undefined || start > best.startOffset) {
        best = { startOffset: start, endOffset: end };
      }
    }
    return best;
  }

  // -----------------------------------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------------------------------

  private declarationOffsets(): Set<number> {
    if (this.declarationOffsetCache !== undefined) {
      return this.declarationOffsetCache;
    }
    const offsets = new Set<number>();
    for (const fn of this.functions) {
      offsets.add(fn.nameOffset);
    }
    for (const field of this.types.flatMap((type) => type.fields)) {
      offsets.add(field.offset);
    }
    for (const value of this.values) {
      offsets.add(value.offset);
    }
    for (const type of this.types) {
      // The declared type name is a type reference, not a call.
      offsets.add(type.startOffset);
    }
    for (const locals of this.localsByFunction.values()) {
      for (const local of locals) {
        offsets.add(local.offset);
      }
    }
    this.declarationOffsetCache = offsets;
    return offsets;
  }

  private readChain(index: number): { names: string[]; lastIndex: number } {
    const names: string[] = [this.tokens[index].text];
    let lastIndex = index;
    while (true) {
      const separator = this.tokens[lastIndex + 1];
      const next = this.tokens[lastIndex + 2];
      if (separator !== undefined && separator.text === '.' && next !== undefined && next.type === 'IDENTIFIER') {
        names.push(next.text);
        lastIndex += 2;
        continue;
      }
      break;
    }
    return { names, lastIndex };
  }

  private firstTokenIndexAtOrAfter(offset: number): number {
    let low = 0;
    let high = this.tokens.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.tokens[middle].startOffset < offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  private textAt(index: number): string | undefined {
    return this.tokens[index]?.text;
  }
}

/** Interface method signatures exposed as flow nodes (`METHOD`, no body). */
export function interfaceMethodDefinition(
  type: GoTypeDef,
  method: GoInterfaceMethod,
  packageName: string
): GoFunctionDef {
  return {
    name: method.name,
    displayName: `${type.name}.${method.displayName}`,
    startOffset: method.startOffset,
    endOffset: method.endOffset,
    nameOffset: method.nameOffset,
    kind: NODE_KIND_METHOD,
    receiverType: type.name,
    receiverName: null,
    isPointerReceiver: false,
    packageName,
    typeParams: [],
    parameters: method.parameters,
    returns: method.returns,
    isInit: false,
    isDeclaration: true,
    bodyStart: 0,
    bodyEnd: 0,
  };
}

/** Parses `text` into a `GoFileOutline`. */
export function parseGoOutline(text: string): GoFileOutline {
  return new GoFileOutlineBuilder(text).build();
}
