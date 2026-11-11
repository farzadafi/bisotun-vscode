// JS/TS/JSX/TSX flow extractor: the tokenizer tier, ported from the JetBrains `JsTsFlowExtractor`.
//
// No regex and no language server: everything comes from the hand written tokenizer + outline
// (`src/js/jsTokenizer.ts`, `src/js/jsFileOutline.ts`) and the tiered call resolver
// (`src/js/jsCallResolver.ts`). A call is only expanded when a declaration can actually be found
// by name in the current file or in a file reachable through a relative import; everything else
// becomes an UNRESOLVED node (never fabricated). Host globals (`console`, `document`, `Math`, ...)
// are filtered out of the flow as ecosystem noise.
//
// The traversal is the same BFS the JetBrains tokenizer tier runs: root scope from the caret,
// `maxDepth` levels (0 = root only), cycle-safe via node ids, models collected only when a type
// declaration of a referenced name is really parsed.

import * as path from 'path';
import * as vscode from 'vscode';

import {
  FlowNode,
  FlowResult,
  isJsFamily,
  LanguageKind,
  NodeKind,
  ResolutionStatus,
  SourceRange,
  UNKNOWN_RANGE,
} from '../core/types';
import { JsAnalysisContext, JsBoundSource } from '../js/jsAnalysisContext';
import { JsCallResolver, JsResolvedCall, isBuiltinGlobal } from '../js/jsCallResolver';
import {
  JsBlockSpan,
  JsCallSite,
  JsFileOutline,
  JsTypeDef,
  parseJsOutline,
} from '../js/jsFileOutline';
import { detectLanguageKind } from './languageKindDetector';
import { LanguageFlowExtractor } from './languageFlowExtractor';

const RESOLVED: ResolutionStatus = 'RESOLVED';
const UNRESOLVED: ResolutionStatus = 'UNRESOLVED';

const MODEL_KIND: NodeKind = 'MODEL';
const UNKNOWN_KIND: NodeKind = 'UNKNOWN';

/** One expandable scope of the tokenizer strategy: a function, a `{...}` block or the module. */
interface TokenizerScope {
  startOffset: number;
  endOffset: number;
  displayName: string;
  kind: NodeKind;
}

/** A scope still to crawl; `node` is set only for unresolved (leaf) calls. */
interface ReaderScope {
  source: JsBoundSource;
  scope: TokenizerScope | null;
  node?: FlowNode | undefined;
}

const BLOCK_SCOPE_NAME = 'block()';
const MODULE_SCOPE_NAME = 'module()';

/**
 * Standard JS/TS built-in method names. A call whose name is one of these is NEVER registered as
 * a dependency node unless a real declaration in project source resolves it - an unresolved
 * prototype/method call (e.g. `dto.email.trim()`, `sessions.set()`, `arr.find()`) is ecosystem
 * noise, not project behavior.
 */
const JS_TS_BUILTIN_METHOD_NAMES = new Set<string>([
  // String
  'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'substring', 'substr',
  'slice', 'split', 'replace', 'replaceAll', 'includes', 'indexOf', 'lastIndexOf',
  'startsWith', 'endsWith', 'charAt', 'charCodeAt', 'concat', 'repeat', 'padStart',
  'padEnd', 'match', 'matchAll', 'search', 'toString', 'valueOf',
  // Array
  'find', 'findIndex', 'findLast', 'findLastIndex', 'filter', 'map', 'reduce',
  'reduceRight', 'forEach', 'some', 'every', 'join', 'splice', 'push', 'pop',
  'shift', 'unshift', 'sort', 'reverse', 'flat', 'flatMap', 'fill', 'copyWithin',
  // Map / Set / Collections
  'get', 'set', 'has', 'delete', 'clear', 'add', 'values', 'keys', 'entries', 'size',
  // Object / Function / Promise
  'then', 'catch', 'finally', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  'apply', 'call', 'bind',
]);

/** The bare method name of a call site, after the last `.` (`set` from `db.set`, `trim` from `dto.email.trim`). */
function isBuiltinMethodCall(site: JsCallSite): boolean {
  const raw = site.rawText.trim();
  const dotIndex = raw.lastIndexOf('.');
  const methodName = dotIndex >= 0 ? raw.substring(dotIndex + 1) : raw;
  return JS_TS_BUILTIN_METHOD_NAMES.has(methodName);
}

/** Factory seam so extractor tests can inject an in-memory analysis context. */
export interface JsAnalysisContextFactory {
  (): JsAnalysisContext;
}

/**
 * JS/TS/JSX/TSX flow extractor, tokenizer tier.
 *
 * Caret validation lives here, mirroring `resolveScope` in the JetBrains extractor: the caret is
 * matched against real scopes (innermost function, then `{...}` block, then module scope) using
 * source offsets only. The module scope is only used when the file really declares something to
 * crawl, so an empty or unparsable file reports nothing instead of an empty flow.
 */
export class JsTsFlowExtractor implements LanguageFlowExtractor {
  readonly supportedLanguages: LanguageKind[] = ['JS', 'JSX', 'TS', 'TSX'];

  private readonly callResolver = new JsCallResolver();
  private readonly analysisContext: JsAnalysisContext;

  constructor(factory: JsAnalysisContextFactory = defaultJsAnalysisContext) {
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
    if (!isJsFamily(languageKind)) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(
      this.extractFlowImpl(document, position, maxDepth, includeModels, languageKind)
    );
  }

  private extractFlowImpl(
    document: vscode.TextDocument,
    position: vscode.Position,
    maxDepth: number,
    includeModels: boolean,
    languageKind: LanguageKind
  ): FlowResult | undefined {
    const source = this.analysisContext.sourceForFileAsSource(document.uri.fsPath);
    if (!source) {return undefined;}

    const caretOffset = document.offsetAt(position);
    const clamped = Math.max(0, Math.min(caretOffset, Math.max(source.text.length - 1, 0)));
    const scope = resolveScope(source.outline, clamped);
    if (!scope) {return undefined;}

    return this.buildTokenizedFlow(source, scope, maxDepth, includeModels);
  }

  private buildTokenizedFlow(
    source: JsBoundSource,
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
          if (!handleScope) {continue;}
          const sites = handle.source.outline.callSitesIn(
            handleScope.startOffset,
            handleScope.endOffset
          );
          for (const site of sites) {
            const resolved = this.resolveTokenizedCall(handle.source, site);
            if (!resolved) {
              // Host globals (`console.log`, `document.querySelector`, `Math.max`, ...) and
              // standard prototype methods (`str.trim()`, `users.map()`, `sessions.set()`, ...)
              // are not project behavior: an unresolved site naming one never expands a flow
              // (matches the JetBrains `isBuiltinGlobal` gate).
              if (isBuiltinGlobal(handle.source, site) || isBuiltinMethodCall(site)) {
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
            if (!visitedNodeIds.add(node.id)) {continue;}
            roots.push({ source: resolved.source, scope: targetScope });
            if (depth < maxDepth) {next.push({ source: resolved.source, scope: targetScope });}
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

  private resolveTokenizedCall(
    source: JsBoundSource,
    site: JsCallSite
  ): JsResolvedCall | undefined {
    return this.callResolver.resolve(source, site, (from, specifier) =>
      this.importedSource(from, specifier)
    );
  }

  private importedSource(source: JsBoundSource, specifier: string): JsBoundSource | undefined {
    const targetPath = this.analysisContext.resolveSpecifier(source.filePath, specifier);
    if (!targetPath) {return undefined;}
    const text = this.analysisContext.sourceForPath(targetPath);
    if (text === undefined) {return undefined;}
    return { filePath: targetPath, text, outline: parseJsOutline(text) };
  }

  /** Models are only reported when a declaration of the used type is really parsed. */
  private collectModels(roots: ReaderScope[]): FlowNode[] {
    const models = new Map<string, FlowNode>();
    for (const handle of roots) {
      const scope = handle.scope;
      if (!scope) {continue;}
      for (const name of handle.source.outline.identifiersIn(scope.startOffset, scope.endOffset)) {
        const localType = handle.source.outline.typeNamed(name);
        if (localType) {
          if (this.isModelType(handle.source, localType)) {
            this.addModel(models, handle.source, localType);
          }
          continue;
        }
        const binding = handle.source.outline.importFor(name);
        if (!binding || binding.importedName === null) {continue;}
        const targetSource = this.importedSource(handle.source, binding.specifier);
        if (!targetSource) {continue;}
        const importedType = targetSource.outline.typeNamed(binding.importedName);
        if (importedType && this.isModelType(targetSource, importedType)) {
          this.addModel(models, targetSource, importedType);
        }
      }
    }
    return Array.from(models.values());
  }

  /**
   * A model is a pure data transfer type: a class that declares no behavior and executes nothing.
   * Service, controller and repository types carry either a public method (their whole point) or a
   * call inside the body, so they are excluded. A plain DTO like `class UserRequest` (possibly with
   * a `constructor` that just stores values) passes, mirroring the Python `__init__` rule.
   */
  private isModelType(source: JsBoundSource, type: JsTypeDef): boolean {
    const outline = source.outline;
    const publicMethods = outline.functionsIn(type).filter((fn) => fn.name !== 'constructor');
    if (publicMethods.length > 0) {return false;}
    return outline.callSitesIn(type.startOffset, type.endOffset, false).length === 0;
  }

  private addModel(
    models: Map<string, FlowNode>,
    source: JsBoundSource,
    type: JsTypeDef
  ): void {
    const start = clamp(type.startOffset, 0, source.text.length);
    const end = clamp(type.endOffset, start, source.text.length);
    const id = `${source.filePath}:${start}-${end}`;
    if (models.has(id)) {return;}
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
    source: JsBoundSource,
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

  private unresolvedNode(source: JsBoundSource, site: JsCallSite): FlowNode {
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

function defaultJsAnalysisContext(): JsAnalysisContext {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    path.dirname(vscode.window.activeTextEditor?.document.uri.fsPath ?? '/');
  const openSourceReader = (filePath: string): string | undefined =>
    vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filePath)?.getText();
  return new JsAnalysisContext({ workspaceRoot, openSourceReader });
}

function rootNameOf(scope: TokenizerScope): string {
  const bare = scope.displayName.replace(/\(\)$/, '');
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
  if (!workspaceRoot || workspaceRoot === '/') {return filePath;}
  return filePath.startsWith(workspaceRoot)
    ? filePath.slice(workspaceRoot.length).replace(/^[/\\]/, '')
    : filePath;
}

/** Computes a 1-based, inclusive line range for a source offset span (mirrors `jsLineRange`). */
function lineRange(text: string, startOffset: number, endOffset: number): SourceRange {
  if (text.length === 0) {return UNKNOWN_RANGE;}
  const start = clamp(startOffset, 0, text.length);
  const end = clamp(endOffset, start, text.length);
  let startLine = 1;
  let endLine = 1;
  for (let index = 0; index < end; index++) {
    if (text[index] === '\n') {
      endLine++;
      if (index < start) {startLine++;}
    }
  }
  return { startLine, endLine };
}

/**
 * Caret -> scope, decided on real source offsets only (never on PSI). Order of preference:
 * innermost function, innermost `{...}` block, module scope - the last one only when the file
 * really declares something to crawl, so an empty or unparsable file still reports nothing
 * instead of producing an empty flow.
 */
export function resolveScope(
  outline: JsFileOutline,
  caretOffset: number
): TokenizerScope | undefined {
  const fn = outline.functionContaining(caretOffset);
  if (fn) {
    return { startOffset: fn.startOffset, endOffset: fn.endOffset, displayName: fn.displayName, kind: fn.kind };
  }
  const block: JsBlockSpan | undefined = outline.blockContaining(caretOffset);
  if (block) {
    return {
      startOffset: block.startOffset,
      endOffset: block.endOffset,
      displayName: BLOCK_SCOPE_NAME,
      kind: UNKNOWN_KIND,
    };
  }
  const moduleHasContent =
    outline.functions.length > 0 ||
    outline.types.length > 0 ||
    outline.callSitesIn(0, outline.text.length).length > 0;
  return moduleHasContent
    ? { startOffset: 0, endOffset: outline.text.length, displayName: MODULE_SCOPE_NAME, kind: UNKNOWN_KIND }
    : undefined;
}
