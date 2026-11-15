// Outline of a C++ file, extracted from the hand written tokenizer in `cppTokenizer.ts`.
//
// This is the C++ equivalent of `JsFileOutline` / `PythonFileOutline`: declarations are recorded
// from the real token stream (never guessed from text) so the extractor can resolve calls, collect
// data models and read source spans without a language server.
//
// What the outline understands structurally:
//  - preprocessor includes (`#include "x.h"` / `<vector>`) as the C++ "import" relation;
//  - namespaces, including nested and anonymous ones;
//  - `class` / `struct` / `union` / `enum` declarations with their base classes and template
//    parameters;
//  - member functions, constructors, destructors and operator overloads (with parameters and
//    return types), free functions, out-of-class `Class::method` definitions;
//  - member variables (fields) and local variables;
//  - lambda expressions as nested function scopes;
//  - call sites inside function bodies.
// Anything unrecognised is skipped conservatively, so malformed input never throws.

import { NodeKind } from '../core/types';
import { CppToken, CppTokenizer } from './cppTokenizer';

export type CppTypeKind = 'class' | 'struct' | 'union' | 'enum';

export interface CppParameter {
  readonly name: string;
  readonly type: string;
  readonly startOffset: number;
}

export interface CppInclude {
  /** `x.h` for `#include "x.h"`, `vector` for `#include <vector>`. */
  readonly specifier: string;
  readonly isSystem: boolean;
  readonly offset: number;
  readonly line: number;
}

export interface CppNamespaceDef {
  readonly name: string;
  readonly qualifiedName: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface CppTypeDef {
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: CppTypeKind;
  /** Enclosing namespace chain (`billing::internal`), empty at global scope. */
  readonly namespace: string;
  readonly startOffset: number;
  readonly endOffset: number;
  /** Base class / struct names in declaration order. */
  readonly bases: string[];
  /** Raw `template <...>` parameter list, empty when the type is not a template. */
  readonly templateParams: string;
}

export interface CppFieldDef {
  readonly name: string;
  readonly type: string;
  /** Owning class/struct name, or `null` for a namespace-level variable. */
  readonly className: string | null;
  readonly offset: number;
  readonly isStatic: boolean;
}

export interface CppFunctionDef {
  readonly name: string;
  /** Compact `Class::name(params)` / `namespace::name(params)` form used in headers. */
  readonly displayName: string;
  readonly startOffset: number;
  readonly endOffset: number;
  /** Offset of the name (or `operator` / `[` for lambdas); guards call-site detection. */
  readonly nameOffset: number;
  readonly kind: NodeKind;
  /** Owning class for methods, constructors, destructors and operator overloads. */
  readonly className: string | null;
  readonly namespace: string;
  readonly returnType: string;
  readonly parameters: CppParameter[];
  readonly templateParams: string;
  readonly isConstructor: boolean;
  readonly isDestructor: boolean;
  /** Declaration only (`void f();`), i.e. the span has no body. */
  readonly isDeclaration: boolean;
  /** Body span (0/0 when the definition is not available). */
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

export interface CppLocalDef {
  readonly name: string;
  readonly type: string;
  readonly offset: number;
}

export interface CppCallSite {
  /** Last segment of the callee chain (`process` for `service.process()`). */
  readonly name: string;
  /** Immediate qualifier (`service`), or `null` for a bare call. */
  readonly qualifier: string | null;
  /** First identifier of the chain, never empty. */
  readonly rootIdentifier: string;
  readonly offset: number;
  /** Exact source text of the callee chain. */
  readonly rawText: string;
  /** `new Foo(...)` object creation. */
  readonly isConstructor: boolean;
}

export interface CppBlockSpan {
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface CppFileOutline {
  readonly functions: CppFunctionDef[];
  readonly types: CppTypeDef[];
  readonly namespaces: CppNamespaceDef[];
  readonly fields: CppFieldDef[];
  readonly includes: CppInclude[];
  readonly tokens: CppToken[];
  readonly text: string;

  /** Innermost function/lambda containing `offset`; prefers the latest start. */
  functionContaining(offset: number): CppFunctionDef | undefined;
  /** Function declared with `name` (prefers a definition). */
  functionNamed(name: string): CppFunctionDef | undefined;
  /** Class/struct/union/enum declared with `name` or a matching qualified name. */
  typeNamed(name: string): CppTypeDef | undefined;
  /** Innermost type whose span contains `offset`. */
  typeContaining(offset: number): CppTypeDef | undefined;
  /** Methods, constructors and destructors declared inside `type`. */
  functionsIn(type: CppTypeDef): CppFunctionDef[];
  /** Method/constructor/destructor/operator named `name` declared by `type`. */
  methodIn(type: CppTypeDef, name: string): CppFunctionDef | undefined;
  /** Fields declared directly by `type`. */
  fieldsIn(type: CppTypeDef): CppFieldDef[];
  /** Field named `name`, searching base classes too. */
  fieldNamed(type: CppTypeDef, name: string): CppFieldDef | undefined;
  /** Local variables declared inside a function body. */
  localsIn(fn: CppFunctionDef): CppLocalDef[];
  /** Declared type of a parameter, local or member visible at `name`. */
  variableType(fn: CppFunctionDef, name: string): string | undefined;
  /** Include directive whose specifier ends with `specifier`. */
  includeFor(specifier: string): CppInclude | undefined;
  /** Innermost namespace containing `offset`. */
  namespaceAt(offset: number): CppNamespaceDef | undefined;
  /** Calls whose callee starts inside a span or inside `fn`'s body. */
  callSitesIn(span: CppFunctionDef | number, endOffset?: number, skipNestedFunctions?: boolean): CppCallSite[];
  /** Identifier names used inside `[startOffset, endOffset)`. */
  identifiersIn(startOffset: number, endOffset: number): Set<string>;
  /** Innermost `{...}` pair containing `offset`. */
  blockContaining(offset: number): CppBlockSpan | undefined;
}

const NODE_KIND_FUNCTION: NodeKind = 'FUNCTION';
const NODE_KIND_METHOD: NodeKind = 'METHOD';

/** Keywords that can never start a declaration we care about. */
const FORBIDDEN_DECLARATION_STARTERS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
  'throw', 'try', 'catch', 'goto', 'new', 'delete', 'this', 'sizeof', 'alignof', 'decltype',
  'typeid', 'static_assert', 'co_await', 'co_return', 'co_yield', 'asm', 'nullptr', 'true',
  'false', 'friend',
]);

const TYPE_KEYWORDS = new Set([
  'auto', 'bool', 'char', 'char8_t', 'char16_t', 'char32_t', 'double', 'float', 'int', 'long',
  'short', 'signed', 'unsigned', 'void', 'wchar_t', 'const', 'volatile', 'static', 'mutable',
  'constexpr', 'consteval', 'constinit', 'thread_local', 'inline', 'virtual', 'explicit',
  'typename', 'struct', 'class', 'union', 'enum',
]);

const CALL_CHAIN_SEPARATORS = new Set(['.', '->', '::']);

const MULTIPLE_DECLARATOR_NEXT = new Set(['=', ';', '{', '(', ',', ':', ')', '[']);

interface Declarator {
  readonly name: string;
  readonly nameIndex: number;
  readonly nameStartOffset: number;
  readonly className: string | null;
  readonly isDestructor: boolean;
  readonly isOperator: boolean;
}

interface TemplatePrefix {
  readonly startOffset: number;
  readonly params: string;
  readonly nextIndex: number;
}

interface FunctionRecordResult {
  readonly next: number;
}

/**
 * Builds a `CppFileOutline` from the token stream. Every scan is bounded and every unmatched
 * bracket ends the current construct instead of throwing, so incomplete or invalid C++ still
 * produces a (partial) outline.
 */
export class CppFileOutlineBuilder {
  private readonly text: string;
  private readonly tokens: CppToken[];
  private readonly brackets: Int32Array;
  private readonly functions: CppFunctionDef[] = [];
  private readonly types: CppTypeDef[] = [];
  private readonly namespaces: CppNamespaceDef[] = [];
  private readonly fields: CppFieldDef[] = [];
  private readonly includes: CppInclude[] = [];

  constructor(text: string) {
    this.text = text;
    this.tokens = new CppTokenizer(text).tokenize();
    this.brackets = new Int32Array(this.tokens.length).fill(-1);
  }

  build(): CppFileOutline {
    this.matchBrackets();
    this.scanScope(0, this.tokens.length, [], null);
    return new CppFileOutlineImpl(
      this.text,
      this.sortedUnique(this.functions),
      this.uniqueTypes(),
      this.uniqueNamespaces(),
      this.fields,
      this.includes,
      this.tokens,
      this.brackets
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Token helpers
  // ---------------------------------------------------------------------------------------------

  private textAt(index: number): string | undefined {
    return this.tokens[index]?.text;
  }

  private isIdentifier(index: number): boolean {
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

  /** Index after a balanced `<...>` group, or `-1` when it is not a template argument list. */
  private skipTemplateArgs(from: number, limit: number): number {
    if (this.textAt(from) !== '<') {
      return -1;
    }
    let depth = 0;
    for (let index = from; index < limit; index++) {
      const text = this.tokens[index].text;
      if (text === '<') {
        depth++;
      } else if (text === '>') {
        depth--;
        if (depth <= 0) {
          return index + 1;
        }
      } else if (text === '>>') {
        depth -= 2;
        if (depth <= 0) {
          return index + 1;
        }
      } else if (text === ';' || text === '{' || text === '}') {
        return -1;
      }
    }
    return -1;
  }

  private looksLikeTemplateArgs(index: number): boolean {
    const previous = this.tokens[index - 1];
    if (!previous) {
      return false;
    }
    const previousIsName =
      previous.type === 'IDENTIFIER' || previous.text === '>' || previous.text === '>>';
    return previousIsName && this.skipTemplateArgs(index, Math.min(this.tokens.length, index + 80)) > 0;
  }

  private scanTemplatePrefix(index: number): TemplatePrefix | undefined {
    if (this.textAt(index) !== 'template') {
      return undefined;
    }
    const next = this.skipTemplateArgs(index + 1, Math.min(this.tokens.length, index + 120));
    if (next < 0) {
      return undefined;
    }
    return {
      startOffset: this.tokens[index].startOffset,
      params: this.compact(this.tokens[index + 1].endOffset, this.tokens[next - 1].startOffset),
      nextIndex: next,
    };
  }

  private compact(startOffset: number, endOffset: number): string {
    if (endOffset <= startOffset) {
      return '';
    }
    return this.text.substring(startOffset, endOffset).replace(/\s+/g, ' ').trim();
  }

  // ---------------------------------------------------------------------------------------------
  // Scope scanning
  // ---------------------------------------------------------------------------------------------

  private scanScope(
    from: number,
    to: number,
    namespaceStack: string[],
    enclosingType: CppTypeDef | null
  ): void {
    let index = from;
    let guard = 0;
    while (index < to && index < this.tokens.length && guard++ < 200000) {
      const token = this.tokens[index];
      if (token.type === 'DIRECTIVE') {
        this.recordInclude(token);
        index++;
        continue;
      }
      const text = token.text;
      if (text === 'namespace') {
        index = this.handleNamespace(index, to, namespaceStack);
        continue;
      }
      if (text === 'template') {
        const prefix = this.scanTemplatePrefix(index);
        if (prefix) {
          index = this.handleTemplateDeclaration(prefix, to, namespaceStack, enclosingType);
          continue;
        }
        index++;
        continue;
      }
      if (text === 'class' || text === 'struct' || text === 'union' || text === 'enum') {
        index = this.handleType(index, to, namespaceStack, undefined, enclosingType);
        continue;
      }
      if (text === 'extern' && this.tokens[index + 1]?.type === 'STRING' && this.textAt(index + 2) === '{') {
        const close = this.brackets[index + 2];
        if (close > index + 2) {
          this.scanScope(index + 3, close, namespaceStack, enclosingType);
          index = close + 1;
          continue;
        }
      }
      if (enclosingType !== null) {
        if ((text === 'public' || text === 'private' || text === 'protected') && this.textAt(index + 1) === ':') {
          index += 2;
          continue;
        }
        if (text === 'using' || text === 'typedef' || text === 'friend' || text === 'static_assert') {
          index = this.skipToStatementEnd(index, to);
          continue;
        }
        const member = this.tryFunction(index, to, namespaceStack, enclosingType, undefined);
        if (member) {
          index = member.next;
          continue;
        }
        const field = this.tryField(index, to, enclosingType);
        if (field) {
          index = field.next;
          continue;
        }
        index++;
        continue;
      }

      const free = this.tryFunction(index, to, namespaceStack, null, undefined);
      if (free) {
        index = free.next;
        continue;
      }
      index++;
    }
  }

  private handleTemplateDeclaration(
    prefix: TemplatePrefix,
    to: number,
    namespaceStack: string[],
    enclosingType: CppTypeDef | null
  ): number {
    const index = prefix.nextIndex;
    const text = this.textAt(index);
    if (text === 'class' || text === 'struct' || text === 'union' || text === 'enum') {
      return this.handleType(index, to, namespaceStack, prefix, enclosingType);
    }
    const declaration = this.tryFunction(index, to, namespaceStack, enclosingType, prefix);
    return declaration ? declaration.next : index + 1;
  }

  private handleNamespace(index: number, to: number, namespaceStack: string[]): number {
    let cursor = index + 1;
    while (this.textAt(cursor) === 'inline') {
      cursor++;
    }
    const parts: string[] = [];
    while (cursor < to) {
      const text = this.textAt(cursor);
      if (text === '{') {
        break;
      }
      if (text === ';' || text === '}' || text === undefined) {
        return cursor + 1; // namespace alias or malformed declaration
      }
      if (this.isIdentifier(cursor)) {
        parts.push(this.tokens[cursor].text);
      }
      cursor++;
    }
    if (this.textAt(cursor) !== '{') {
      return index + 1;
    }
    const bodyClose = this.brackets[cursor];
    if (bodyClose <= cursor) {
      return cursor + 1;
    }
    const name = parts.join('::');
    const qualified = [...namespaceStack, ...parts].filter((part) => part.length > 0).join('::');
    this.namespaces.push({
      name,
      qualifiedName: qualified,
      startOffset: this.tokens[index].startOffset,
      endOffset: this.tokens[bodyClose].endOffset,
    });
    const inner = name.length > 0 ? [...namespaceStack, ...parts] : namespaceStack;
    this.scanScope(cursor + 1, bodyClose, inner, null);
    return bodyClose + 1;
  }

  private handleType(
    index: number,
    to: number,
    namespaceStack: string[],
    templatePrefix: TemplatePrefix | undefined,
    enclosingType: CppTypeDef | null
  ): number {
    const keyword = this.tokens[index].text;
    const typeKind: CppTypeKind =
      keyword === 'enum' ? 'enum' : keyword === 'union' ? 'union' : keyword === 'struct' ? 'struct' : 'class';
    let cursor = index + 1;
    if (typeKind === 'enum' && (this.textAt(cursor) === 'class' || this.textAt(cursor) === 'struct')) {
      cursor++;
    }
    if (!this.isIdentifier(cursor)) {
      return index + 1;
    }
    const name = this.tokens[cursor].text;
    const bodyOpen = this.findBeforeStatementEnd(cursor + 1, '{', to);
    if (bodyOpen < 0) {
      return cursor + 1;
    }
    const bodyClose = this.brackets[bodyOpen];
    const startOffset = templatePrefix ? templatePrefix.startOffset : this.tokens[index].startOffset;
    const endOffset =
      bodyClose > bodyOpen ? this.tokens[bodyClose].endOffset : this.tokens[bodyOpen].endOffset;
    const qualifiedName = enclosingType
      ? `${enclosingType.qualifiedName}::${name}`
      : [...namespaceStack, name].join('::');
    const type: CppTypeDef = {
      name,
      qualifiedName,
      kind: typeKind,
      namespace: namespaceStack.join('::'),
      startOffset,
      endOffset,
      bases: typeKind === 'enum' ? [] : this.collectBases(cursor + 1, bodyOpen),
      templateParams: templatePrefix ? templatePrefix.params : '',
    };
    this.types.push(type);
    if (bodyClose > bodyOpen && typeKind !== 'enum') {
      this.scanScope(bodyOpen + 1, bodyClose, namespaceStack, type);
    }
    return bodyClose > bodyOpen ? bodyClose + 1 : bodyOpen + 1;
  }

  /** Base classes between `name` and the body brace, skipping access specifiers. */
  private collectBases(from: number, bodyOpen: number): string[] {
    let colon = -1;
    let depth = 0;
    for (let index = from; index < bodyOpen; index++) {
      const text = this.tokens[index].text;
      if (text === '<') {
        depth++;
      } else if (text === '>') {
        depth--;
      } else if (text === '>>') {
        depth -= 2;
      } else if (text === ':' && depth === 0) {
        colon = index;
        break;
      }
    }
    if (colon < 0) {
      return [];
    }
    const bases: string[] = [];
    const pushSegment = (start: number, end: number): void => {
      const parts: string[] = [];
      for (let index = start; index < end; index++) {
        const token = this.tokens[index];
        if (token.type === 'IDENTIFIER') {
          parts.push(token.text);
        } else if (token.text === '::') {
          parts.push('::');
        }
      }
      const joined = parts.join('').replace(/::+/g, '::').replace(/^::|::$/g, '');
      if (joined.length > 0) {
        bases.push(joined);
      }
    };
    let segmentStart = colon + 1;
    depth = 0;
    for (let index = colon + 1; index < bodyOpen; index++) {
      const text = this.tokens[index].text;
      if (text === '<') {
        depth++;
      } else if (text === '>') {
        depth--;
      } else if (text === '>>') {
        depth -= 2;
      } else if (text === ',' && depth === 0) {
        pushSegment(segmentStart, index);
        segmentStart = index + 1;
      }
    }
    pushSegment(segmentStart, bodyOpen);
    return bases;
  }

  private findBeforeStatementEnd(from: number, expected: string, limit: number): number {
    let index = from;
    let guard = 0;
    while (index < limit && index < this.tokens.length && guard++ < 200) {
      const text = this.tokens[index].text;
      if (text === expected) {
        return index;
      }
      if (text === ';' || text === '}') {
        return -1;
      }
      if (text === '(' || text === '[') {
        const close = this.brackets[index];
        if (close > index) {
          index = close + 1;
          continue;
        }
      }
      index++;
    }
    return -1;
  }

  private skipToStatementEnd(from: number, limit: number): number {
    let index = from;
    while (index < limit) {
      const text = this.tokens[index].text;
      if (text === ';') {
        return index + 1;
      }
      if (text === '{') {
        const close = this.brackets[index];
        return close > index ? close + 1 : index + 1;
      }
      index++;
    }
    return limit;
  }

  // ---------------------------------------------------------------------------------------------
  // Function parsing
  // ---------------------------------------------------------------------------------------------

  /** First top-level `(` of a declaration starting at `index`, or `-1`. */
  private findParamsOpen(index: number, limit: number): number {
    let cursor = index;
    let guard = 0;
    while (cursor < limit && cursor < this.tokens.length && guard++ < 160) {
      const text = this.tokens[cursor].text;
      if (text === '(') {
        return cursor;
      }
      if (text === ';' || text === '{' || text === '}' || text === '=' || text === ')') {
        return -1;
      }
      if (text === '<' && this.looksLikeTemplateArgs(cursor)) {
        const next = this.skipTemplateArgs(cursor, Math.min(this.tokens.length, cursor + 80));
        cursor = next > 0 ? next : cursor + 1;
        continue;
      }
      if (text === '[') {
        const close = this.brackets[cursor];
        if (close > cursor) {
          cursor = close + 1;
          continue;
        }
      }
      cursor++;
    }
    return -1;
  }

  private resolveDeclarator(index: number, paramsOpen: number): Declarator | undefined {
    let operatorIndex = -1;
    for (let cursor = index; cursor < paramsOpen; cursor++) {
      if (this.tokens[cursor].text === 'operator') {
        operatorIndex = cursor;
        break;
      }
    }
    if (operatorIndex >= 0) {
      // `operator()`: the first `(` belongs to the name, the second one starts the parameters.
      if (
        this.textAt(operatorIndex + 1) === '(' &&
        this.textAt(operatorIndex + 2) === ')' &&
        this.textAt(operatorIndex + 3) === '('
      ) {
        return {
          name: 'operator()',
          nameIndex: operatorIndex,
          nameStartOffset: this.tokens[operatorIndex].startOffset,
          className: this.classNameBefore(operatorIndex),
          isDestructor: false,
          isOperator: true,
        };
      }
      return {
        name: this.compact(this.tokens[operatorIndex].startOffset, this.tokens[paramsOpen].startOffset),
        nameIndex: operatorIndex,
        nameStartOffset: this.tokens[operatorIndex].startOffset,
        className: this.classNameBefore(operatorIndex),
        isDestructor: false,
        isOperator: true,
      };
    }
    const nameIndex = paramsOpen - 1;
    const nameToken = this.tokens[nameIndex];
    if (!nameToken || (nameToken.type !== 'IDENTIFIER' && nameToken.type !== 'KEYWORD')) {
      return undefined;
    }
    if (nameToken.type === 'KEYWORD' && !FORBIDDEN_DECLARATION_STARTERS.has(nameToken.text) && nameToken.text !== 'operator') {
      return undefined;
    }
    const isDestructor = this.textAt(nameIndex - 1) === '~';
    return {
      name: nameToken.text,
      nameIndex,
      nameStartOffset: nameToken.startOffset,
      className: this.classNameBefore(nameIndex),
      isDestructor,
      isOperator: false,
    };
  }

  /** First token of a return type, after storage/function specifiers (`static`, `inline`, ...). */
  private skipDeclarationSpecifiers(index: number, nameStartOffset: number): number {
    const specifiers = new Set([
      'static', 'inline', 'virtual', 'explicit', 'constexpr', 'consteval', 'constinit',
      'friend', 'extern', 'typename', 'register', 'thread_local',
    ]);
    let cursor = index;
    while (
      cursor < this.tokens.length &&
      this.tokens[cursor].startOffset < nameStartOffset &&
      specifiers.has(this.tokens[cursor].text)
    ) {
      cursor++;
    }
    return cursor < this.tokens.length && this.tokens[cursor].startOffset < nameStartOffset
      ? cursor
      : index;
  }

  /** Bare class name of a `Class::` / `ns::Class::` prefix that ends right before `index`. */
  private classNameBefore(index: number): string | null {
    let cursor = index;
    if (this.textAt(cursor) === '~') {
      cursor--;
    }
    if (this.textAt(cursor - 1) !== '::') {
      return null;
    }
    let nameIndex = cursor - 2;
    if (this.textAt(nameIndex) === '>') {
      // Skip a template argument list backwards: `Foo<T>::bar`.
      let depth = 0;
      for (let scan = nameIndex; scan >= 0; scan--) {
        const text = this.tokens[scan].text;
        if (text === '>') {
          depth++;
        } else if (text === '<') {
          depth--;
          if (depth === 0) {
            nameIndex = scan - 1;
            break;
          }
        }
      }
    }
    const token = this.tokens[nameIndex];
    return token && token.type === 'IDENTIFIER' ? token.text : null;
  }

  private tryFunction(
    index: number,
    limit: number,
    namespaceStack: string[],
    enclosingType: CppTypeDef | null,
    templatePrefix: TemplatePrefix | undefined
  ): FunctionRecordResult | undefined {
    const starter = this.tokens[index];
    if (!starter || starter.type === 'PUNCTUATION' || starter.type === 'DIRECTIVE') {
      return undefined;
    }
    if (starter.type === 'KEYWORD' && FORBIDDEN_DECLARATION_STARTERS.has(starter.text)) {
      return undefined;
    }
    if (starter.type === 'KEYWORD' && !TYPE_KEYWORDS.has(starter.text)) {
      return undefined;
    }
    const paramsOpen = this.findParamsOpen(index, limit);
    if (paramsOpen < 0) {
      return undefined;
    }
    const declarator = this.resolveDeclarator(index, paramsOpen);
    if (!declarator) {
      return undefined;
    }
    const paramsClose = this.brackets[paramsOpen];
    if (paramsClose <= paramsOpen) {
      return paramsClose === -1 ? { next: paramsOpen + 1 } : undefined;
    }

    const owner = enclosingType ? enclosingType.name : declarator.className;
    const returnTypeStart = this.skipDeclarationSpecifiers(index, declarator.nameStartOffset);
    const returnType = this.compact(this.tokens[returnTypeStart].startOffset, declarator.nameStartOffset);
    const isDestructor = declarator.isDestructor;
    const isConstructor =
      owner !== null && declarator.name === owner && !declarator.isOperator && !isDestructor;
    if (returnType.length === 0 && !isConstructor && !isDestructor && !declarator.isOperator) {
      return undefined;
    }

    const tail = this.parseFunctionTail(paramsClose + 1, limit, isConstructor);
    if (!tail) {
      return undefined;
    }

    const className = declarator.className ?? owner;
    const namespaceName = namespaceStack.join('::');
    const parameters = this.parseParameters(paramsOpen, paramsClose);
    const name = isDestructor ? `~${declarator.name}` : declarator.name;
    const displayBase = className !== null
      ? `${className}::${name}`
      : namespaceName.length > 0
        ? `${namespaceName}::${name}`
        : name;
    const displayName = `${displayBase}(${this.compact(this.tokens[paramsOpen].endOffset, this.tokens[paramsClose].startOffset)})`;

    const startOffset = templatePrefix ? templatePrefix.startOffset : starter.startOffset;
    const endOffset = tail.bodyClose >= 0
      ? this.tokens[tail.bodyClose].endOffset
      : this.tokens[tail.semicolonIndex].endOffset;

    const definition: CppFunctionDef = {
      name,
      displayName,
      startOffset,
      endOffset,
      nameOffset: declarator.nameStartOffset,
      kind: className !== null ? NODE_KIND_METHOD : NODE_KIND_FUNCTION,
      className,
      namespace: namespaceName,
      returnType,
      parameters,
      templateParams: templatePrefix ? templatePrefix.params : '',
      isConstructor,
      isDestructor,
      isDeclaration: tail.bodyClose < 0,
      bodyStart: tail.bodyClose >= 0 ? this.tokens[tail.bodyOpen].endOffset : 0,
      bodyEnd: tail.bodyClose >= 0 ? this.tokens[tail.bodyClose].startOffset : 0,
    };
    this.functions.push(definition);

    if (tail.bodyClose > tail.bodyOpen) {
      this.scanBody(tail.bodyOpen + 1, tail.bodyClose, namespaceStack, className);
    }
    return { next: tail.bodyClose >= 0 ? tail.bodyClose + 1 : tail.semicolonIndex + 1 };
  }

  /**
   * Everything between the closing parenthesis and the body. Returns the body braces, the
   * terminating `;` of a declaration, or `undefined` when the construct is not a function.
   */
  private parseFunctionTail(
    from: number,
    limit: number,
    isConstructor: boolean
  ): { bodyOpen: number; bodyClose: number; semicolonIndex: number } | undefined {
    let cursor = from;
    let guard = 0;
    let colonSeen = false;
    while (cursor < limit && cursor < this.tokens.length && guard++ < 120) {
      const text = this.tokens[cursor].text;
      if (text === '{') {
        const close = this.brackets[cursor];
        return close > cursor
          ? { bodyOpen: cursor, bodyClose: close, semicolonIndex: -1 }
          : undefined;
      }
      if (text === ';') {
        return { bodyOpen: -1, bodyClose: -1, semicolonIndex: cursor };
      }
      if (text === '=') {
        // `= 0;`, `= default;`, `= delete;` are declarations.
        const end = this.skipToStatementEnd(cursor, limit) - 1;
        const semicolon = this.textAt(end) === ';' ? end : cursor;
        return { bodyOpen: -1, bodyClose: -1, semicolonIndex: semicolon };
      }
      if (text === ':' && isConstructor) {
        colonSeen = true;
      }
      if (text === '}') {
        return undefined;
      }
      if (text === '(' && colonSeen) {
        const close = this.brackets[cursor];
        if (close > cursor) {
          cursor = close + 1;
          continue;
        }
      }
      if (text === '[' && colonSeen) {
        const close = this.brackets[cursor];
        if (close > cursor) {
          cursor = close + 1;
          continue;
        }
      }
      cursor++;
    }
    return undefined;
  }

  private parseParameters(open: number, close: number): CppParameter[] {
    const segments: Array<[number, number]> = [];
    let segmentStart = open + 1;
    let depth = 0;
    for (let index = open + 1; index < close; index++) {
      const text = this.tokens[index].text;
      if (text === '(' || text === '[' || text === '{' || text === '<') {
        depth++;
      } else if (text === ')' || text === ']' || text === '}' || text === '>') {
        depth--;
      } else if (text === '>>') {
        depth -= 2;
      } else if (text === ',' && depth <= 0) {
        segments.push([segmentStart, index]);
        segmentStart = index + 1;
      }
    }
    segments.push([segmentStart, close]);

    const parameters: CppParameter[] = [];
    for (const [start, end] of segments) {
      const parameter = this.parseParameter(start, end);
      if (parameter) {
        parameters.push(parameter);
      }
    }
    return parameters;
  }

  private parseParameter(start: number, end: number): CppParameter | undefined {
    if (end <= start) {
      return undefined;
    }
    let limit = end;
    let depth = 0;
    for (let index = start; index < end; index++) {
      const text = this.tokens[index].text;
      if (text === '(' || text === '[' || text === '{' || text === '<') {
        depth++;
      } else if (text === ')' || text === ']' || text === '}' || text === '>') {
        depth--;
      } else if (text === '>>') {
        depth -= 2;
      } else if (text === '=' && depth <= 0) {
        limit = index;
        break;
      }
    }
    if (limit <= start) {
      return undefined;
    }
    let nameIndex = -1;
    for (let index = limit - 1; index >= start; index--) {
      if (this.tokens[index].type === 'IDENTIFIER') {
        nameIndex = index;
        break;
      }
    }
    const isOnlyVoid =
      limit - start === 1 && this.tokens[start]?.type === 'KEYWORD' && this.tokens[start].text === 'void';
    if (isOnlyVoid) {
      return undefined;
    }
    if (nameIndex < 0) {
      // Unnamed parameter (`int`, `const Foo&`): keep the type so signatures stay faithful.
      return {
        name: '',
        type: this.compact(this.tokens[start].startOffset, this.tokens[limit - 1].endOffset),
        startOffset: this.tokens[start].startOffset,
      };
    }
    return {
      name: this.tokens[nameIndex].text,
      type: this.compact(this.tokens[start].startOffset, this.tokens[nameIndex].startOffset),
      startOffset: this.tokens[nameIndex].startOffset,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Members, fields, lambdas
  // ---------------------------------------------------------------------------------------------

  private tryField(
    index: number,
    limit: number,
    enclosingType: CppTypeDef
  ): { next: number } | undefined {
    const starter = this.tokens[index];
    if (!starter || starter.type === 'DIRECTIVE' || starter.type === 'PUNCTUATION') {
      return undefined;
    }
    if (starter.type === 'KEYWORD' && FORBIDDEN_DECLARATION_STARTERS.has(starter.text)) {
      return undefined;
    }
    const cursor = index;
    let nameIndex = -1;
    let depth = 0;
    let guard = 0;
    let scan = cursor;
    while (scan < limit && scan < this.tokens.length && guard++ < 60) {
      const text = this.tokens[scan].text;
      if (text === '<') {
        const next = this.skipTemplateArgs(scan, Math.min(this.tokens.length, scan + 60));
        if (next > 0) {
          scan = next;
          continue;
        }
      }
      if (text === '(' || text === '[') {
        return undefined; // an initializer or function we could not parse as a declaration
      }
      if (text === '>>') {
        depth -= 2;
      } else if (text === '>') {
        depth--;
      }
      if (depth <= 0) {
        if (text === ';') {
          return this.registerField(index, scan, nameIndex, enclosingType);
        }
        if (text === '{') {
          const close = this.brackets[scan];
          if (close > scan) {
            this.registerField(index, scan, nameIndex, enclosingType);
            return { next: close + 1 };
          }
        }
      }
      if (this.tokens[scan].type === 'IDENTIFIER') {
        nameIndex = scan;
      }
      scan++;
    }
    return undefined;
  }

  private registerField(
    start: number,
    terminator: number,
    nameIndex: number,
    enclosingType: CppTypeDef
  ): { next: number } | undefined {
    if (nameIndex < 0 || nameIndex <= start) {
      return undefined;
    }
    const name = this.tokens[nameIndex].text;
    let isStatic = false;
    for (let index = start; index < nameIndex; index++) {
      if (this.tokens[index].text === 'static') {
        isStatic = true;
        break;
      }
    }
    this.fields.push({
      name,
      type: this.compact(this.tokens[start].startOffset, this.tokens[nameIndex].startOffset),
      className: enclosingType.name,
      offset: this.tokens[nameIndex].startOffset,
      isStatic,
    });
    return { next: terminator + 1 };
  }

  /** Scans a function body for lambdas (each becomes a nested function scope). */
  private scanBody(
    from: number,
    to: number,
    namespaceStack: string[],
    className: string | null
  ): void {
    let index = from;
    let guard = 0;
    while (index < to && index < this.tokens.length && guard++ < 200000) {
      if (this.textAt(index) === '[') {
        const lambda = this.tryLambda(index, to, namespaceStack, className);
        if (lambda) {
          index = lambda.next;
          continue;
        }
      }
      index++;
    }
  }

  private tryLambda(
    index: number,
    to: number,
    namespaceStack: string[],
    className: string | null
  ): { next: number } | undefined {
    const captureClose = this.brackets[index];
    if (captureClose <= index) {
      return undefined;
    }
    let cursor = captureClose + 1;
    let paramsStart = -1;
    let paramsEnd = -1;
    if (this.textAt(cursor) === '(') {
      const close = this.brackets[cursor];
      if (close <= cursor) {
        return undefined;
      }
      paramsStart = cursor;
      paramsEnd = close;
      cursor = close + 1;
    }
    let guard = 0;
    while (cursor < to && guard++ < 40) {
      const text = this.textAt(cursor);
      if (text === '{') {
        const bodyClose = this.brackets[cursor];
        if (bodyClose <= cursor) {
          return undefined;
        }
        const parameters =
          paramsStart >= 0 ? this.parseParameters(paramsStart, paramsEnd) : [];
        const displayParams =
          paramsStart >= 0
            ? this.compact(this.tokens[paramsStart].endOffset, this.tokens[paramsEnd].startOffset)
            : '';
        const displayName = `lambda(${displayParams})`;
        this.functions.push({
          name: 'lambda',
          displayName,
          startOffset: this.tokens[index].startOffset,
          endOffset: this.tokens[bodyClose].endOffset,
          nameOffset: this.tokens[index].startOffset,
          kind: NODE_KIND_FUNCTION,
          className,
          namespace: namespaceStack.join('::'),
          returnType: '',
          parameters,
          templateParams: '',
          isConstructor: false,
          isDestructor: false,
          isDeclaration: false,
          bodyStart: this.tokens[cursor].endOffset,
          bodyEnd: this.tokens[bodyClose].startOffset,
        });
        this.scanBody(cursor + 1, bodyClose, namespaceStack, className);
        return { next: bodyClose + 1 };
      }
      if (text === 'mutable' || text === 'constexpr' || text === 'consteval' || text === 'noexcept' || text === '->' || text === '[' || text === ']' || text === 'const') {
        cursor++;
        continue;
      }
      if (this.tokens[cursor]?.type === 'IDENTIFIER') {
        cursor++;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  private recordInclude(token: CppToken): void {
    const match = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/.exec(token.text);
    if (!match) {
      return;
    }
    this.includes.push({
      specifier: match[2].trim(),
      isSystem: match[1] === '<',
      offset: token.startOffset,
      line: token.line,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Deduplication helpers
  // ---------------------------------------------------------------------------------------------

  private sortedUnique(functions: CppFunctionDef[]): CppFunctionDef[] {
    const unique: CppFunctionDef[] = [];
    for (const fn of functions) {
      if (unique.every((other) => other.startOffset !== fn.startOffset || other.nameOffset !== fn.nameOffset)) {
        unique.push(fn);
      }
    }
    unique.sort((left, right) => left.startOffset - right.startOffset);
    return unique;
  }

  private uniqueTypes(): CppTypeDef[] {
    const unique: CppTypeDef[] = [];
    for (const type of this.types) {
      if (unique.every((other) => other.startOffset !== type.startOffset || other.name !== type.name)) {
        unique.push(type);
      }
    }
    unique.sort((left, right) => left.startOffset - right.startOffset);
    return unique;
  }

  private uniqueNamespaces(): CppNamespaceDef[] {
    const unique: CppNamespaceDef[] = [];
    for (const namespace of this.namespaces) {
      if (unique.every((other) => other.startOffset !== namespace.startOffset)) {
        unique.push(namespace);
      }
    }
    return unique;
  }
}

/** Concrete outline; all data is computed by the builder. */
export class CppFileOutlineImpl implements CppFileOutline {
  readonly functions: CppFunctionDef[];
  readonly types: CppTypeDef[];
  readonly namespaces: CppNamespaceDef[];
  readonly fields: CppFieldDef[];
  readonly includes: CppInclude[];
  readonly tokens: CppToken[];
  readonly text: string;
  private readonly brackets: Int32Array;
  private readonly localCache = new Map<number, CppLocalDef[]>();

  constructor(
    text: string,
    functions: CppFunctionDef[],
    types: CppTypeDef[],
    namespaces: CppNamespaceDef[],
    fields: CppFieldDef[],
    includes: CppInclude[],
    tokens: CppToken[],
    brackets: Int32Array
  ) {
    this.text = text;
    this.functions = functions;
    this.types = types;
    this.namespaces = namespaces;
    this.fields = fields;
    this.includes = includes;
    this.tokens = tokens;
    this.brackets = brackets;
  }

  functionContaining(offset: number): CppFunctionDef | undefined {
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

  functionNamed(name: string): CppFunctionDef | undefined {
    const candidates = this.functions.filter((fn) => fn.name === name);
    return candidates.find((fn) => !fn.isDeclaration) ?? candidates[0];
  }

  typeNamed(name: string): CppTypeDef | undefined {
    const bare = normalizeTypeName(name);
    if (bare.length === 0) {
      return undefined;
    }
    return (
      this.types.find((type) => type.qualifiedName === bare) ??
      this.types.find((type) => type.name === bare)
    );
  }

  typeContaining(offset: number): CppTypeDef | undefined {
    let best: CppTypeDef | undefined;
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

  functionsIn(type: CppTypeDef): CppFunctionDef[] {
    return this.functions.filter(
      (fn) =>
        fn.startOffset >= type.startOffset &&
        fn.endOffset <= type.endOffset &&
        fn.className !== null
    );
  }

  methodIn(type: CppTypeDef, name: string): CppFunctionDef | undefined {
    const candidates = this.functionsIn(type).filter((fn) => fn.name === name);
    return candidates.find((fn) => !fn.isDeclaration) ?? candidates[0];
  }

  fieldsIn(type: CppTypeDef): CppFieldDef[] {
    return this.fields.filter(
      (field) =>
        field.className === type.name &&
        field.offset >= type.startOffset &&
        field.offset <= type.endOffset
    );
  }

  fieldNamed(type: CppTypeDef, name: string, depth = 0): CppFieldDef | undefined {
    const own = this.fieldsIn(type).find((field) => field.name === name);
    if (own !== undefined) {
      return own;
    }
    if (depth >= 4) {
      return undefined;
    }
    for (const base of type.bases) {
      const baseType = this.typeNamed(base);
      if (baseType !== undefined) {
        const inherited = this.fieldNamed(baseType, name, depth + 1);
        if (inherited !== undefined) {
          return inherited;
        }
      }
    }
    return undefined;
  }

  localsIn(fn: CppFunctionDef): CppLocalDef[] {
    const cached = this.localCache.get(fn.startOffset);
    if (cached !== undefined) {
      return cached;
    }
    const locals: CppLocalDef[] = [];
    if (fn.bodyEnd <= fn.bodyStart) {
      this.localCache.set(fn.startOffset, locals);
      return locals;
    }
    // A nested lambda is its own scope: its parameters/locals are not locals of the outer function.
    const nested = this.functions.filter(
      (candidate) => candidate !== fn && candidate.startOffset > fn.startOffset && candidate.endOffset <= fn.endOffset
    );
    let index = this.firstTokenIndexAtOrAfter(fn.bodyStart);
    let guard = 0;
    while (index < this.tokens.length && this.tokens[index].startOffset < fn.bodyEnd && guard++ < 20000) {
      if (nested.some((candidate) => this.tokens[index].startOffset >= candidate.startOffset && this.tokens[index].startOffset <= candidate.endOffset)) {
        index++;
        continue;
      }
      const local = this.tryLocalDeclaration(index, fn.bodyEnd);
      if (local) {
        locals.push(local.local);
        index = local.next;
        continue;
      }
      index++;
    }
    this.localCache.set(fn.startOffset, locals);
    return locals;
  }

  variableType(fn: CppFunctionDef, name: string): string | undefined {
    const parameter = fn.parameters.find((param) => param.name === name);
    if (parameter !== undefined && parameter.type.length > 0) {
      return parameter.type;
    }
    const local = this.localsIn(fn).find((item) => item.name === name);
    if (local !== undefined && local.type.length > 0) {
      return local.type;
    }
    return undefined;
  }

  includeFor(specifier: string): CppInclude | undefined {
    const normalized = specifier.replace(/\\/g, '/');
    return this.includes.find((include) => include.specifier.replace(/\\/g, '/') === normalized);
  }

  namespaceAt(offset: number): CppNamespaceDef | undefined {
    let best: CppNamespaceDef | undefined;
    for (const namespace of this.namespaces) {
      if (offset < namespace.startOffset || offset > namespace.endOffset) {
        continue;
      }
      if (best === undefined || namespace.startOffset > best.startOffset) {
        best = namespace;
      }
    }
    return best;
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
    span: CppFunctionDef | number,
    endOffset?: number,
    skipNestedFunctions = true
  ): CppCallSite[] {
    const isFunction = typeof span !== 'number';
    const start = isFunction ? span.bodyStart : span;
    const end = isFunction ? span.bodyEnd : (endOffset ?? this.text.length);
    if (end <= start) {
      return [];
    }
    const enclosingFunction = isFunction ? (span as CppFunctionDef) : this.functionContaining(start);
    const declarationOffsets = this.declarationOffsets(start, end, enclosingFunction);
    const locals = new Map<number, CppLocalDef>();
    if (enclosingFunction !== undefined) {
      for (const local of this.localsIn(enclosingFunction)) {
        locals.set(local.offset, local);
      }
    }
    const nested = isFunction
      ? []
      : skipNestedFunctions
        ? this.functions.filter((fn) => fn.startOffset > start && fn.endOffset <= end)
        : [];
    const sites = new Map<number, CppCallSite>();
    let index = this.firstTokenIndexAtOrAfter(start);
    while (index < this.tokens.length && this.tokens[index].startOffset < end) {
      const token = this.tokens[index];
      if (token.type !== 'IDENTIFIER') {
        index++;
        continue;
      }
      const local = locals.get(token.startOffset);
      if (local !== undefined) {
        // Direct initialization (`PaymentService service("x")`) creates an object: it is a real
        // constructor call of the local's declared type, not a declaration site.
        if (this.textAt(index + 1) === '(' && !/^\s*auto\s*$/.test(local.type)) {
          const typeName = normalizeTypeName(local.type);
          if (typeName.length > 0) {
            sites.set(token.startOffset, {
              name: typeName,
              qualifier: null,
              rootIdentifier: typeName,
              offset: token.startOffset,
              rawText: typeName,
              isConstructor: true,
            });
          }
        }
        index++;
        continue;
      }
      if (declarationOffsets.has(token.startOffset)) {
        index++;
        continue;
      }
      if (nested.some((fn) => token.startOffset >= fn.startOffset && token.startOffset <= fn.endOffset)) {
        index++;
        continue;
      }
      const chain = this.readChain(index);
      const afterChain = chain.lastIndex + 1;
      if (this.textAt(afterChain) !== '(') {
        index = chain.lastIndex + 1;
        continue;
      }
      const isConstructor = this.textAt(index - 1) === 'new';
      sites.set(token.startOffset, {
        name: chain.names[chain.names.length - 1],
        qualifier: chain.names.length > 1 ? chain.names[chain.names.length - 2] : null,
        rootIdentifier: chain.names[0],
        offset: token.startOffset,
        rawText: this.text.substring(token.startOffset, chain.lastIndex >= 0 ? this.tokens[chain.lastIndex].endOffset : token.endOffset),
        isConstructor,
      });
      index = chain.lastIndex + 1;
    }
    return Array.from(sites.values());
  }

  blockContaining(offset: number): CppBlockSpan | undefined {
    let best: CppBlockSpan | undefined;
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

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  /** Names that are declarations, never call sites: functions, fields, parameters, locals. */
  private declarationOffsets(
    start: number,
    end: number,
    fn: CppFunctionDef | undefined
  ): Set<number> {
    const offsets = new Set<number>();
    for (const candidate of this.functions) {
      offsets.add(candidate.nameOffset);
    }
    for (const field of this.fields) {
      offsets.add(field.offset);
    }
    for (const type of this.types) {
      // The declared name of a type is a type reference, not a call.
      offsets.add(type.startOffset + this.typeNameOffsetWithin(type));
    }
    const enclosingFunction = fn ?? this.functionContaining(start);
    if (enclosingFunction !== undefined) {
      for (const parameter of enclosingFunction.parameters) {
        if (parameter.name.length > 0) {
          offsets.add(parameter.startOffset);
        }
      }
      for (const local of this.localsIn(enclosingFunction)) {
        offsets.add(local.offset);
      }
    }
    return offsets;
  }

  private typeNameOffsetWithin(type: CppTypeDef): number {
    const startIndex = this.firstTokenIndexAtOrAfter(type.startOffset);
    for (let index = startIndex; index < this.tokens.length && this.tokens[index].startOffset < type.endOffset; index++) {
      if (this.tokens[index].type === 'IDENTIFIER' && this.tokens[index].text === type.name) {
        return this.tokens[index].startOffset - type.startOffset;
      }
    }
    return 0;
  }

  private readChain(index: number): { names: string[]; lastIndex: number } {
    const names: string[] = [this.tokens[index].text];
    let lastIndex = index;
    while (true) {
      const separator = this.tokens[lastIndex + 1];
      const next = this.tokens[lastIndex + 2];
      if (
        separator !== undefined &&
        CALL_CHAIN_SEPARATORS.has(separator.text) &&
        next !== undefined &&
        next.type === 'IDENTIFIER'
      ) {
        names.push(next.text);
        lastIndex += 2;
        continue;
      }
      break;
    }
    return { names, lastIndex };
  }

  private tryLocalDeclaration(
    index: number,
    limitOffset: number
  ): { local: CppLocalDef; next: number } | undefined {
    const starter = this.tokens[index];
    if (!starter) {
      return undefined;
    }
    const isTypeStarter =
      starter.type === 'IDENTIFIER' || (starter.type === 'KEYWORD' && TYPE_KEYWORDS.has(starter.text));
    if (!isTypeStarter || FORBIDDEN_DECLARATION_STARTERS.has(starter.text)) {
      return undefined;
    }
    // A declaration needs a type part and then `name` followed by one of `= ; { ( , : )`.
    let cursor = index;
    let guard = 0;
    while (cursor < this.tokens.length && guard++ < 24) {
      const token = this.tokens[cursor];
      if (token.startOffset >= limitOffset) {
        return undefined;
      }
      const text = token.text;
      if (token.type === 'IDENTIFIER') {
        const next = this.textAt(cursor + 1);
        const isDeclaredName =
          next !== undefined &&
          MULTIPLE_DECLARATOR_NEXT.has(next) &&
          cursor > index &&
          // `std::runtime_error(...)`: the identifier after `::` is part of the type name.
          this.textAt(cursor - 1) !== '::';
        if (isDeclaredName) {
          return {
            local: {
              name: token.text,
              type: this.compact(starter.startOffset, token.startOffset),
              offset: token.startOffset,
            },
            next: cursor + 1,
          };
        }
        cursor++;
        continue;
      }
      if (token.type === 'KEYWORD' && TYPE_KEYWORDS.has(text)) {
        cursor++;
        continue;
      }
      if (text === '*' || text === '&' || text === '&&' || text === '::' || text === '~') {
        cursor++;
        continue;
      }
      if (text === '<') {
        const next = this.skipTemplateArgs(cursor, Math.min(this.tokens.length, cursor + 60));
        if (next > 0) {
          cursor = next;
          continue;
        }
        return undefined;
      }
      return undefined;
    }
    return undefined;
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

  private compact(startOffset: number, endOffset: number): string {
    if (endOffset <= startOffset) {
      return '';
    }
    return this.text.substring(startOffset, endOffset).replace(/\s+/g, ' ').trim();
  }

  /** Index after a balanced `<...>` group, or `-1` when it is not a template argument list. */
  private skipTemplateArgs(from: number, limit: number): number {
    let depth = 0;
    for (let index = from; index < limit; index++) {
      const text = this.tokens[index].text;
      if (text === '<') {
        depth++;
      } else if (text === '>') {
        depth--;
        if (depth <= 0) {
          return index + 1;
        }
      } else if (text === '>>') {
        depth -= 2;
        if (depth <= 0) {
          return index + 1;
        }
      } else if (text === ';' || text === '{' || text === '}') {
        return -1;
      }
    }
    return -1;
  }
}

/** `billing::User<T>` -> `User`; used to match declared type references. */
export function normalizeTypeName(name: string): string {
  let value = name.trim();
  const template = value.indexOf('<');
  if (template >= 0) {
    value = value.substring(0, template);
  }
  value = value.replace(/^(const|volatile|struct|class|enum|typename)\s+/g, '').trim();
  const namespaceSeparator = value.lastIndexOf('::');
  if (namespaceSeparator >= 0 && value.endsWith('::') === false) {
    // Keep the last segment: `billing::User` is declared as `User` in namespace `billing`.
    const tail = value.substring(namespaceSeparator + 2);
    if (tail.length > 0) {
      value = tail;
    }
  }
  return value.replace(/[*&\s]+$/g, '').trim();
}

/** Parses `text` into a `CppFileOutline`. */
export function parseCppOutline(text: string): CppFileOutline {
  return new CppFileOutlineBuilder(text).build();
}
