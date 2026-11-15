// C++ flow extractor: the tokenizer tier, the C++ counterpart of `JsTsFlowExtractor` and
// `PythonFlowExtractor`.
//
// No language server and no regex parsing: everything comes from the hand written tokenizer
// (`src/cpp/cppTokenizer.ts`), the C++ outline (`src/cpp/cppFileOutline.ts`) and the tiered call
// resolver (`src/cpp/cppCallResolver.ts`). A call is only expanded when a declaration can actually
// be found in the current file, in a base class, or in a file reachable through one of the file's
// `#include`s; everything else becomes an UNRESOLVED node (never fabricated).
//
// Standard library and platform noise (`std::`, container/string accessors, C library functions,
// `ALL_CAPS` macros) is filtered exactly like the JS/TS and Python builtin gates: only sites that
// failed to resolve are checked, so a project method that happens to share a standard name still
// wins.
//
// The traversal is the same BFS as the other tokenizer tiers: root scope from the caret,
// `maxDepth` levels (0 = root only), cycle-safe via node ids, and data models collected only when a
// declaration of a referenced type is really parsed.

import * as path from 'path';
import * as vscode from 'vscode';

import {
  FlowNode,
  FlowResult,
  LanguageKind,
  NodeKind,
  ResolutionStatus,
  SourceRange,
  UNKNOWN_RANGE,
} from '../core/types';
import { CppAnalysisContext, CppBoundSource } from '../cpp/cppAnalysisContext';
import { CppCallResolver, CppResolvedCall } from '../cpp/cppCallResolver';
import {
  CppBlockSpan,
  CppCallSite,
  CppFunctionDef,
  CppTypeDef,
  parseCppOutline,
} from '../cpp/cppFileOutline';
import { LanguageFlowExtractor } from './languageFlowExtractor';
import { detectLanguageKind } from './languageKindDetector';

const RESOLVED: ResolutionStatus = 'RESOLVED';
const UNRESOLVED: ResolutionStatus = 'UNRESOLVED';

const MODEL_KIND: NodeKind = 'MODEL';
const UNKNOWN_KIND: NodeKind = 'UNKNOWN';

/** One expandable scope of the tokenizer strategy: a function, a `{...}` block or the file. */
interface TokenizerScope {
  startOffset: number;
  endOffset: number;
  displayName: string;
  kind: NodeKind;
}

/** A scope still to crawl; `node` is set only for unresolved (leaf) calls. */
interface ReaderScope {
  source: CppBoundSource;
  scope: TokenizerScope | null;
  node?: FlowNode | undefined;
}

const BLOCK_SCOPE_NAME = 'block()';
const MODULE_SCOPE_NAME = 'file()';

/**
 * Standard library members, algorithms, smart pointer helpers and C library functions. An
 * unresolved call naming one can only point outside the workspace, so it is dropped instead of
 * filling the flow with `push_back()` / `size()` / `printf()` noise.
 */
const CPP_STD_FUNCTIONS = new Set([
  // Containers and strings
  'push_back', 'pop_back', 'emplace_back', 'emplace', 'insert', 'erase', 'clear', 'size',
  'empty', 'resize', 'reserve', 'capacity', 'shrink_to_fit', 'at', 'front', 'back', 'begin',
  'end', 'cbegin', 'cend', 'rbegin', 'rend', 'crbegin', 'crend', 'data', 'c_str', 'substr',
  'append', 'assign', 'compare', 'replace', 'copy', 'length', 'max_size', 'swap', 'find',
  'rfind', 'find_first_of', 'find_last_of', 'find_first_not_of', 'find_last_not_of', 'count',
  'contains', 'lower_bound', 'upper_bound', 'equal_range', 'merge', 'splice', 'emplace_hint',
  'try_emplace', 'insert_or_assign', 'extract', 'bucket_count', 'load_factor', 'rehash',
  'to_string', 'to_wstring', 'stoi', 'stol', 'stoll', 'stoul', 'stoull', 'stof', 'stod',
  'stold', 'getline', 'istream', 'ostream',
  // Algorithms and utilities
  'sort', 'stable_sort', 'partial_sort', 'nth_element', 'reverse', 'rotate', 'shuffle',
  'unique', 'remove', 'remove_if', 'transform', 'accumulate', 'reduce', 'inner_product',
  'for_each', 'any_of', 'all_of', 'none_of', 'find_if', 'find_if_not', 'count_if', 'copy_if',
  'remove_copy', 'replace_copy', 'fill', 'fill_n', 'generate', 'generate_n', 'min', 'max',
  'minmax', 'clamp', 'make_pair', 'make_tuple', 'tie', 'make_unique', 'make_shared', 'move',
  'forward', 'exchange', 'as_const', 'visit', 'holds_alternative', 'get_if',
  // Streams and diagnostics
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'sscanf', 'puts', 'putchar', 'getchar',
  'fopen', 'fclose', 'fread', 'fwrite', 'fseek', 'tellg', 'tellp', 'flush', 'open', 'close',
  'read', 'write', 'seekg', 'seekp', 'rdbuf', 'sync_with_stdio', 'setprecision', 'setw',
  // Smart pointers / RAII / threading
  'reset', 'release', 'get', 'use_count', 'lock', 'unlock', 'try_lock', 'notify_one',
  'notify_all', 'wait', 'join', 'detach', 'yield', 'this_thread',
  // C library
  'malloc', 'calloc', 'realloc', 'free', 'memcpy', 'memmove', 'memset', 'memcmp', 'strlen',
  'strcmp', 'strncmp', 'strcpy', 'strncpy', 'strcat', 'strchr', 'strstr', 'atoi', 'atol',
  'atof', 'abs', 'labs', 'exit', 'abort', 'assert', 'raise', 'system', 'getenv', 'setenv',
  'time', 'clock', 'sleep', 'qsort', 'bsearch',
]);

/** Qualifiers that always name a platform component, never project code. */
const CPP_NOISE_QUALIFIERS = new Set([
  'std', 'boost', 'chrono', 'filesystem', 'this_thread', 'ranges', 'views',
]);

/** Factory seam so extractor tests can inject an in-memory analysis context. */
export interface CppAnalysisContextFactory {
  (): CppAnalysisContext;
}

export class CppFlowExtractor implements LanguageFlowExtractor {
  readonly supportedLanguages: LanguageKind[] = ['CPP'];

  private readonly callResolver = new CppCallResolver();
  private readonly analysisContext: CppAnalysisContext;
  private readonly parsedCache = new Map<string, CppBoundSource | undefined>();

  constructor(factory: CppAnalysisContextFactory = defaultCppAnalysisContext) {
    this.analysisContext = factory();
  }

  extractFlow(opts: {
    document: vscode.TextDocument;
    position: vscode.Position;
    maxDepth: number;
    includeModels: boolean;
  }): Promise<FlowResult | undefined> {
    const { document, position, maxDepth, includeModels } = opts;
    const languageKind = detectLanguageKind({
      languageId: document.languageId,
      fileName: document.fileName,
    });
    if (languageKind !== 'CPP') {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(
      this.extractFlowImpl(document, position, maxDepth, includeModels)
    );
  }

  private extractFlowImpl(
    document: vscode.TextDocument,
    position: vscode.Position,
    maxDepth: number,
    includeModels: boolean
  ): FlowResult | undefined {
    const source = this.analysisContext.sourceForFileAsSource(document.uri.fsPath);
    if (!source) {
      return undefined;
    }
    const caretOffset = document.offsetAt(position);
    const clamped = Math.max(0, Math.min(caretOffset, Math.max(source.text.length - 1, 0)));
    const scope = resolveScope(source.outline, clamped);
    if (!scope) {
      return undefined;
    }
    return this.buildTokenizedFlow(source, scope, maxDepth, includeModels);
  }

  private buildTokenizedFlow(
    source: CppBoundSource,
    scope: TokenizerScope,
    maxDepth: number,
    includeModels: boolean
  ): FlowResult {
    const rootNode = this.nodeFor(source, scope, RESOLVED);
    const visitedNodeIds = new Set<string>([rootNode.id]);
    const roots: ReaderScope[] = [];

    if (maxDepth > 0) {
      let frontier: ReaderScope[] = [{ source, scope }];
      let depth = 1;
      while (depth <= maxDepth && frontier.length > 0) {
        const next: ReaderScope[] = [];
        for (const handle of frontier) {
          const handleScope = handle.scope;
          if (!handleScope) {
            continue;
          }
          const sites = handle.source.outline.callSitesIn(
            handleScope.startOffset,
            handleScope.endOffset
          );
          for (const site of sites) {
            const resolved = this.resolveTokenizedCall(handle.source, site);
            if (!resolved) {
              if (this.isNoiseCall(handle.source, site)) {
                continue;
              }
              const node = this.unresolvedNode(handle.source, site);
              if (visitedNodeIds.add(node.id)) {
                roots.push({ source: handle.source, scope: null, node });
              }
              continue;
            }
            const definition = resolved.definition;
            if (
              handle.source === resolved.source &&
              definition.name === rootNameOf(scope) &&
              definition.startOffset === scope.startOffset
            ) {
              continue;
            }
            const targetScope: TokenizerScope = {
              startOffset: definition.startOffset,
              endOffset: definition.endOffset,
              displayName: definition.displayName,
              kind: definition.kind,
            };
            const node = this.nodeFor(resolved.source, targetScope, RESOLVED);
            if (!visitedNodeIds.add(node.id)) {
              continue;
            }
            roots.push({ source: resolved.source, scope: targetScope });
            if (depth < maxDepth) {
              next.push({ source: resolved.source, scope: targetScope });
            }
          }
        }
        frontier = next;
        depth++;
      }
    }

    const resolvedNodes = roots
      .filter((it): it is ReaderScope & { scope: TokenizerScope } => it.scope !== null)
      .map((it) => this.nodeFor(it.source, it.scope, RESOLVED));
    const unresolvedNodes = roots
      .filter((it): it is ReaderScope & { node: FlowNode } => it.node !== undefined)
      .map((it) => it.node);

    const models = includeModels ? this.collectModels([{ source, scope }, ...roots]) : [];

    return {
      root: rootNode,
      nodes: [...resolvedNodes, ...unresolvedNodes],
      models,
      warnings: [],
    };
  }

  private resolveTokenizedCall(source: CppBoundSource, site: CppCallSite): CppResolvedCall | undefined {
    return this.callResolver.resolve(source, site, this.includedSource);
  }

  /** Resolves one `#include` to a parsed source; disk headers are parsed once per extraction. */
  private readonly includedSource = (
    source: CppBoundSource,
    specifier: string,
    isSystem: boolean
  ): CppBoundSource | undefined => {
    const targetPath = this.analysisContext.resolveInclude(source.filePath, { specifier, isSystem });
    if (!targetPath) {
      return undefined;
    }
    return this.parsedSource(targetPath);
  };

  private parsedSource(filePath: string): CppBoundSource | undefined {
    if (this.parsedCache.has(filePath)) {
      return this.parsedCache.get(filePath);
    }
    const text = this.analysisContext.sourceForPath(filePath);
    const source = text === undefined
      ? undefined
      : { filePath, text, outline: parseCppOutline(text) };
    this.parsedCache.set(filePath, source);
    return source;
  }

  /**
   * Whether an unresolved site is ecosystem noise. Only unresolved sites reach this gate: a project
   * function or method with the same name resolves first and is kept.
   */
  private isNoiseCall(source: CppBoundSource, site: CppCallSite): boolean {
    if (CPP_NOISE_QUALIFIERS.has(site.rootIdentifier) || (site.qualifier !== null && CPP_NOISE_QUALIFIERS.has(site.qualifier))) {
      return true;
    }
    if (CPP_STD_FUNCTIONS.has(site.name)) {
      return true;
    }
    // `new External()` where the type is not part of the project: object creation of a platform
    // type is not a callable flow node.
    if (site.isConstructor) {
      return true;
    }
    const enclosing = source.outline.functionContaining(site.offset);
    if (enclosing) {
      // A call whose name is a parameter/local is a functor invocation (`handler()`), and a name
      // that is a member is a member-function pointer call - neither names a free function.
      if (source.outline.variableType(enclosing, site.name) !== undefined) {
        return true;
      }
      if (enclosing.className !== null) {
        const owner = source.outline.typeNamed(enclosing.className);
        if (owner && source.outline.fieldNamed(owner, site.name) !== undefined) {
          return true;
        }
      }
    }
    // Macro and constant invocations (`CHECK(x)`, `MAX(a, b)`) are preprocessor noise unless a real
    // declaration resolved them above.
    if (/^[A-Z][A-Z0-9_]{1,}$/.test(site.name)) {
      return true;
    }
    return false;
  }

  private collectModels(roots: ReaderScope[]): FlowNode[] {
    const models = new Map<string, FlowNode>();
    for (const handle of roots) {
      const scope = handle.scope;
      if (!scope) {
        continue;
      }
      for (const name of handle.source.outline.identifiersIn(scope.startOffset, scope.endOffset)) {
        const localType = handle.source.outline.typeNamed(name);
        if (localType) {
          this.addModelWithBases(models, handle.source, localType, 0);
          continue;
        }
        for (const target of this.includedSources(handle.source)) {
          const includedType = target.outline.typeNamed(name);
          if (includedType) {
            this.addModelWithBases(models, target, includedType, 0);
            break;
          }
        }
      }
    }
    return Array.from(models.values());
  }

  /** Adds a data model plus its project base classes (derived -> base relationship). */
  private addModelWithBases(
    models: Map<string, FlowNode>,
    source: CppBoundSource,
    type: CppTypeDef,
    depth: number
  ): void {
    if (!this.isModelType(source, type)) {
      return;
    }
    this.addModel(models, source, type);
    if (depth >= 3) {
      return;
    }
    for (const base of type.bases) {
      const localBase = source.outline.typeNamed(base);
      if (localBase) {
        this.addModelWithBases(models, source, localBase, depth + 1);
        continue;
      }
      for (const target of this.includedSources(source)) {
        const includedBase = target.outline.typeNamed(base);
        if (includedBase) {
          this.addModelWithBases(models, target, includedBase, depth + 1);
          break;
        }
      }
    }
  }

  /**
   * A model is a pure data type: an enum, or a class/struct that declares no behavior (constructors
   * and destructors allowed) and executes nothing. Service classes with methods are excluded.
   */
  private isModelType(source: CppBoundSource, type: CppTypeDef): boolean {
    if (type.kind === 'enum') {
      return true;
    }
    const outline = source.outline;
    const behaviors = outline
      .functionsIn(type)
      .filter((fn) => !fn.isConstructor && !fn.isDestructor);
    if (behaviors.length > 0) {
      return false;
    }
    return outline.callSitesIn(type.startOffset, type.endOffset, false).length === 0;
  }

  private includedSources(source: CppBoundSource): CppBoundSource[] {
    const result: CppBoundSource[] = [];
    const seen = new Set<string>();
    for (const include of source.outline.includes) {
      const target = this.includedSource(source, include.specifier, include.isSystem);
      if (!target || seen.has(target.filePath) || target.filePath === source.filePath) {
        continue;
      }
      seen.add(target.filePath);
      result.push(target);
    }
    return result;
  }

  private addModel(
    models: Map<string, FlowNode>,
    source: CppBoundSource,
    type: CppTypeDef
  ): void {
    const start = clamp(type.startOffset, 0, source.text.length);
    const end = clamp(type.endOffset, start, source.text.length);
    const id = `${source.filePath}:${start}-${end}`;
    if (models.has(id)) {
      return;
    }
    models.set(id, {
      id,
      displayName: type.name,
      filePath: relativePath(source.filePath),
      range: lineRange(source.text, start, end),
      languageKind: languageOf(source.filePath),
      resolutionStatus: RESOLVED,
      kind: MODEL_KIND,
      code: source.text.substring(start, end).trim(),
    });
  }

  private nodeFor(
    source: CppBoundSource,
    scope: TokenizerScope,
    status: ResolutionStatus
  ): FlowNode {
    const start = clamp(scope.startOffset, 0, source.text.length);
    const end = clamp(scope.endOffset, start, source.text.length);
    return {
      id: `${source.filePath}:${start}-${end}`,
      displayName: scope.displayName,
      filePath: relativePath(source.filePath),
      range: lineRange(source.text, start, end),
      languageKind: languageOf(source.filePath),
      resolutionStatus: status,
      kind: scope.kind,
      code: source.text.substring(start, end).trim(),
    };
  }

  private unresolvedNode(source: CppBoundSource, site: CppCallSite): FlowNode {
    const start = site.offset;
    const end = Math.min(start + site.rawText.length, source.text.length);
    return {
      id: `${source.filePath}:${start}-${end}`,
      displayName: `${site.rawText}()`,
      filePath: relativePath(source.filePath),
      range: lineRange(source.text, start, end),
      languageKind: languageOf(source.filePath),
      resolutionStatus: UNRESOLVED,
      kind: UNKNOWN_KIND,
      code: source.text.substring(start, end).trim(),
    };
  }
}

function defaultCppAnalysisContext(): CppAnalysisContext {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    path.dirname(vscode.window.activeTextEditor?.document.uri.fsPath ?? '/');
  const openSourceReader = (filePath: string): string | undefined =>
    vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filePath)?.getText();
  return new CppAnalysisContext({ workspaceRoot, openSourceReader });
}

function rootNameOf(scope: TokenizerScope): string {
  const bare = scope.displayName.replace(/\(.*\)$/, '');
  const namespaceSeparator = bare.lastIndexOf('::');
  if (namespaceSeparator >= 0) {
    return bare.substring(namespaceSeparator + 2);
  }
  const dot = bare.lastIndexOf('.');
  return dot >= 0 ? bare.substring(dot + 1) : bare;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function languageOf(filePath: string): LanguageKind {
  return detectLanguageKind({ fileName: filePath, languageId: undefined });
}

function relativePath(filePath: string): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '/';
  if (!workspaceRoot || workspaceRoot === '/') {
    return filePath;
  }
  return filePath.startsWith(workspaceRoot)
    ? filePath.slice(workspaceRoot.length).replace(/^[/\\]/, '')
    : filePath;
}

/** Computes a 1-based, inclusive line range for a source offset span. */
function lineRange(text: string, startOffset: number, endOffset: number): SourceRange {
  if (text.length === 0) {
    return UNKNOWN_RANGE;
  }
  const start = clamp(startOffset, 0, text.length);
  const end = clamp(endOffset, start, text.length);
  let startLine = 1;
  let endLine = 1;
  for (let index = 0; index < end; index++) {
    if (text[index] === '\n') {
      endLine++;
      if (index < start) {
        startLine++;
      }
    }
  }
  return { startLine, endLine };
}

/**
 * Caret -> scope, decided on real source offsets only. Order of preference: innermost
 * function/lambda, innermost `{...}` block, file scope - the last one only when the file really
 * declares something to crawl, so an empty or unparsable file reports nothing.
 */
export function resolveScope(
  outline: { functionContaining(offset: number): CppFunctionDef | undefined; blockContaining(offset: number): CppBlockSpan | undefined; types: CppTypeDef[]; functions: CppFunctionDef[]; callSitesIn(span: number, endOffset: number, skipNested?: boolean): CppCallSite[]; text: string },
  caretOffset: number
): TokenizerScope | undefined {
  const fn = outline.functionContaining(caretOffset);
  if (fn) {
    return {
      startOffset: fn.startOffset,
      endOffset: fn.endOffset,
      displayName: fn.displayName,
      kind: fn.kind,
    };
  }
  const block: CppBlockSpan | undefined = outline.blockContaining(caretOffset);
  if (block) {
    return {
      startOffset: block.startOffset,
      endOffset: block.endOffset,
      displayName: BLOCK_SCOPE_NAME,
      kind: UNKNOWN_KIND,
    };
  }
  const fileHasContent =
    outline.functions.length > 0 ||
    outline.types.length > 0 ||
    outline.callSitesIn(0, outline.text.length).length > 0;
  return fileHasContent
    ? { startOffset: 0, endOffset: outline.text.length, displayName: MODULE_SCOPE_NAME, kind: UNKNOWN_KIND }
    : undefined;
}
