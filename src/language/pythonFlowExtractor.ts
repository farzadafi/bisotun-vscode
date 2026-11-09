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
import { PythonAnalysisContext, PythonBoundSource } from './python/pythonAnalysisContext';
import {
  parsePythonOutline,
  PythonCallSite,
  PythonFileOutline,
  PythonTypeDef,
} from './python/pythonFileOutline';
import { PythonCallResolver, PythonResolvedCall } from './python/pythonCallResolver';
import { LanguageFlowExtractor } from './languageFlowExtractor';

const RESOLVED: ResolutionStatus = 'RESOLVED';
const UNRESOLVED: ResolutionStatus = 'UNRESOLVED';

const MODEL_KIND: NodeKind = 'MODEL';
const UNKNOWN_KIND: NodeKind = 'UNKNOWN';

/** One expandable scope of the tokenizer strategy: a function, a class-body block or the module. */
interface TokenizerScope {
  startOffset: number;
  endOffset: number;
  displayName: string;
  kind: NodeKind;
}

/** A scope still to crawl; `node` is set only for unresolved (leaf) calls. */
interface ReaderScope {
  source: PythonBoundSource;
  scope: TokenizerScope | null;
  node?: FlowNode | undefined;
}

const BLOCK_SCOPE_NAME = 'block()';
const MODULE_SCOPE_NAME = 'module()';

/**
 * Python builtins that are not declarations in project source: calling them (`str`, `len`, `print`,
 * `range`, ...) never expands a flow and only adds noise, so unresolved sites naming one are dropped.
 */
const PYTHON_BUILTINS = new Set([
  'abs', 'all', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray', 'bytes', 'callable',
  'chr', 'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir', 'divmod', 'enumerate',
  'eval', 'exec', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr',
  'hash', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list',
  'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow',
  'print', 'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice',
  'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip',
]);

/**
 * Methods on primitive values - strings, lists, dicts, numerics - that are not project behavior.
 * `raw.strip()` and the tail of `raw.strip().lower()` both collapse to a site named `strip` /
 * `lower` (the chain is identifier members only, so the post-call `.lower()` site is bare). Only
 * *unresolved* sites are ever checked - a user `def strip(self)` or `from .utils import lower`
 * resolves first and is kept - so a primitive method name that is still unresolved is noise by
 * construction (it can only be a method on a value or a nonexistent global).
 */
const PRIMITIVE_METHODS = new Set([
  'append', 'bit_count', 'capitalize', 'casefold', 'center', 'clear', 'close', 'copy', 'count',
  'decode', 'discard', 'encode', 'endswith', 'expandtabs', 'extend', 'find', 'format', 'format_map',
  'fromhex', 'get', 'hex', 'index', 'insert', 'isalnum', 'isalpha', 'isascii', 'isdecimal',
  'isdigit', 'isidentifier', 'islower', 'isnumeric', 'isprintable', 'isspace', 'istitle',
  'isupper', 'items', 'iter', 'join', 'keys', 'ljust', 'lower', 'lstrip', 'maketrans',
  'partition', 'pop', 'popitem', 'real', 'remove', 'replace', 'reverse', 'rfind', 'rindex',
  'rjust', 'rpartition', 'rsplit', 'rstrip', 'setdefault', 'sort', 'split', 'splitlines',
  'startswith', 'strip', 'swapcase', 'title', 'translate', 'union', 'update', 'upper', 'values',
  'zfill',
]);

/** First segment of a dotted module specifier (`json`, `uuid`): stdlib modules never expand. */
const STD_MODULE_PREFIXES = new Set([
  'abc', 'argparse', 'ast', 'asyncio', 'base64', 'bisect', 'builtins', 'calendar',
  'collections', 'contextlib', 'copy', 'csv', 'ctypes', 'dataclasses', 'datetime',
  'decimal', 'difflib', 'enum', 'errno', 'functools', 'gc', 'glob', 'gzip', 'hashlib',
  'heapq', 'hmac', 'html', 'http', 'importlib', 'inspect', 'io', 'itertools', 'json',
  'locale', 'logging', 'math', 'mimetypes', 'multiprocessing', 'operator', 'os', 'pathlib',
  'pickle', 'platform', 'pprint', 'queue', 'random', 're', 'secrets', 'selectors',
  'shutil', 'signal', 'site', 'socket', 'socketserver', 'sqlite3', 'ssl', 'statistics',
  'string', 'struct', 'subprocess', 'sys', 'tempfile', 'threading', 'time', 'timeit',
  'tkinter', 'traceback', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uuid',
  'warnings', 'wave', 'weakref', 'webbrowser', 'xml', 'zipfile',
]);

/**
 * Python flow extractor: a port of the JetBrains `PythonFlowExtractor` tokenizer
 * tier. It requires no Python language service: everything comes from the hand
 * written tokenizer, the indentation aware outline and the conservative Python
 * call resolver. A call is only expanded when a declaration can actually be
 * found by name in the current file or in a file reachable through an import;
 * anything else becomes an UNRESOLVED node (never fabricated).
 *
 * Unlike Java (LSP) and JS/TS (also tokenizer based but using the legacy crawled
 * `core/flowCrawler.ts`), this extractor reuses the current VS Code open
 * document via `PythonAnalysisContext` for the root scope and reads imported
 * files from disk with the same 2 MB cap and per-file cache the JetBrains
 * context uses.
 */
export class PythonFlowExtractor implements LanguageFlowExtractor {
  readonly supportedLanguages: LanguageKind[] = ['PYTHON'];

  private readonly callResolver = new PythonCallResolver();
  private readonly analysisContext: PythonAnalysisContext;

  constructor(factory: AnalysisContextFactory = defaultAnalysisContext) {
    this.analysisContext = factory();
  }

  extractFlow(opts: {
    document: vscode.TextDocument;
    position: vscode.Position;
    maxDepth: number;
    includeModels: boolean;
  }): Promise<FlowResult | undefined> {
    const { document, position, maxDepth, includeModels } = opts;
    const languageKind = this.languageKindOf(document);
    if (languageKind !== 'PYTHON') {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(
      this.extractFlowImpl(document, position, maxDepth, includeModels, languageKind)
    );
  }

  private languageKindOf(document: vscode.TextDocument): LanguageKind {
    const byLanguage = languageKindOfLanguageId(document.languageId);
    const byExtension = languageKindFromExtension(this.extensionOf(document.fileName));
    if (byExtension === 'PYTHON') return byExtension;
    if (byExtension === 'UNKNOWN') return byLanguage;
    return byLanguage;
  }

  private extensionOf(fileName: string): string | undefined {
    if (!fileName) return undefined;
    const base = fileName.replace(/\\/g, '/');
    const lastSlash = base.lastIndexOf('/');
    const name = lastSlash >= 0 ? base.substring(lastSlash + 1) : base;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.substring(dot + 1) : undefined;
  }

  private extractFlowImpl(
    document: vscode.TextDocument,
    position: vscode.Position,
    maxDepth: number,
    includeModels: boolean,
    languageKind: LanguageKind
  ): FlowResult | undefined {
    const source = this.analysisContext.sourceForFileAsSource(document.uri.fsPath);
    if (!source) return undefined;

    const caretOffset = document.offsetAt(position);
    const clamped = Math.max(0, Math.min(caretOffset, Math.max(source.text.length - 1, 0)));
    const scope = resolveScope(source.outline, clamped);
    if (!scope) return undefined;

    return this.buildTokenizedFlow(source, scope, maxDepth, includeModels);
  }

  private buildTokenizedFlow(
    source: PythonBoundSource,
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
          if (!handleScope) continue;
          const sites = handle.source.outline.callSitesIn(
            handleScope.startOffset,
            handleScope.endOffset
          );
          for (const site of sites) {
            const resolved = this.resolveTokenizedCall(handle.source, site);
            if (!resolved) {
              // `PaymentService()` names a class, not a function: instantiation contributes the
              // imported MODEL but never an execution node, so skip it instead of emitting an
              // UNRESOLVED node (matches the JetBrains fixture contract).
              if (this.isConstructorCall(handle.source, site)) continue;
              if (this.isNoiseCall(handle.source, site)) continue;
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
            if (!visitedNodeIds.add(node.id)) continue;
            roots.push({ source: resolved.source, scope: targetScope });
            if (depth < maxDepth) next.push({ source: resolved.source, scope: targetScope });
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
    source: PythonBoundSource,
    site: PythonCallSite
  ): PythonResolvedCall | undefined {
    return this.callResolver.resolve(source, site, (from, specifier) =>
      this.importedSource(from, specifier)
    );
  }

  private isConstructorCall(source: PythonBoundSource, site: PythonCallSite): boolean {
    return this.callResolver.isConstructorCall(source, site, (from, specifier) =>
      this.importedSource(from, specifier)
    );
  }

  /**
   * Whether an unresolved site is ecosystem noise rather than a project call. Only unresolved sites
   * reach this gate - a user `def strip(self)` or a same-named module import still resolves first and
   * is kept. A site is noise when it names a Python builtin (`str`, `len`, `print`), when its member
   * segment is a primitive/string method (`raw.strip`, and the bare `lower` of `raw.strip().lower()`
   * where the call chain is split by `()`), or when its root module is stdlib (`json.dumps`,
   * `uuid.uuid4`) - all are outside the workspace by definition, so nothing in a flow should point
   * at them.
   */
  private isNoiseCall(source: PythonBoundSource, site: PythonCallSite): boolean {
    if (PYTHON_BUILTINS.has(site.name)) return true;
    if (PRIMITIVE_METHODS.has(site.name)) return true;
    const binding = source.outline.importFor(site.rootIdentifier);
    if (binding && STD_MODULE_PREFIXES.has(binding.specifier.split('.')[0])) return true;
    return false;
  }

  private importedSource(
    source: PythonBoundSource,
    specifier: string
  ): PythonBoundSource | undefined {
    const targetPath = this.analysisContext.resolveSpecifier(source.filePath, specifier);
    if (!targetPath) return undefined;
    const text = this.analysisContext.sourceForPath(targetPath);
    if (text === undefined) return undefined;
    return { filePath: targetPath, text, outline: parsePythonOutline(text) };
  }

  private collectModels(roots: ReaderScope[]): FlowNode[] {
    const models = new Map<string, FlowNode>();
    for (const handle of roots) {
      const scope = handle.scope;
      if (!scope) continue;
      for (const name of handle.source.outline.identifiersIn(scope.startOffset, scope.endOffset)) {
        const localType = handle.source.outline.typeNamed(name);
        if (localType) {
          if (this.isModelType(handle.source, localType)) {
            this.addModel(models, handle.source, localType);
          }
          continue;
        }
        const binding = handle.source.outline.importFor(name);
        if (!binding || !binding.importedName) continue;
        const targetSource = this.importedSource(handle.source, binding.specifier);
        if (!targetSource) continue;
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
   * call inside the body, so they are excluded. A plain DTO like `class User:` (possibly with an
   * `__init__` that just stores values) passes.
   */
  private isModelType(source: PythonBoundSource, type: PythonTypeDef): boolean {
    const outline = source.outline;
    const publicMethods = outline.functionsIn(type).filter((fn) => !fn.name.startsWith('__'));
    if (publicMethods.length > 0) return false;
    return outline.callSitesIn(type.startOffset, type.endOffset, false).length === 0;
  }

  private addModel(
    models: Map<string, FlowNode>,
    source: PythonBoundSource,
    type: PythonTypeDef
  ): void {
    const start = clamp(type.startOffset, 0, source.text.length);
    const end = clamp(type.endOffset, start, source.text.length);
    const id = `${source.filePath}:${start}-${end}`;
    if (models.has(id)) return;
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
    source: PythonBoundSource,
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

  private unresolvedNode(source: PythonBoundSource, site: PythonCallSite): FlowNode {
    const start = site.offset;
    const end = Math.min(start + site.rawText.length, source.text.length);
    return {
      id: `${source.filePath}:${start}-${end}`,
      displayName: site.rawText,
      filePath: relativePath(source.filePath),
      range: lineRange(source.text, start, end),
      languageKind: languageOf(source.filePath),
      resolutionStatus: UNRESOLVED,
      kind: UNKNOWN_KIND,
      code: source.text.substring(start, end).trim(),
    };
  }
}

/** Factory seam so extractor tests can inject an in-memory analysis context. */
export interface AnalysisContextFactory {
  (): PythonAnalysisContext;
}

function defaultAnalysisContext(): PythonAnalysisContext {
  return createDefaultAnalysisContext();
}

/** Creates the default context: workspace root + currently open documents as in-memory readers. */
function createDefaultAnalysisContext(): PythonAnalysisContext {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    path.dirname(vscode.window.activeTextEditor?.document.uri.fsPath ?? '/');
  const openSourceReader = (filePath: string): string | undefined =>
    vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filePath)?.getText();
  return new PythonAnalysisContext({ workspaceRoot, openSourceReader });
}

function rootNameOf(scope: TokenizerScope): string {
  const bare = scope.displayName.replace(/\(\)$/, '');
  const dot = bare.lastIndexOf('.');
  return dot >= 0 ? bare.substring(dot + 1) : bare;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function languageKindOfLanguageId(languageId: string | undefined): LanguageKind {
  const id = (languageId ?? '').toLowerCase().trim();
  if (id.includes('python') || id === 'py') return 'PYTHON';
  return 'UNKNOWN';
}

function languageKindFromExtension(extension: string | undefined): LanguageKind {
  if (extension === undefined) return 'UNKNOWN';
  const ext = extension.toLowerCase();
  if (ext === 'py' || ext === 'pyw' || ext === 'pyi') return 'PYTHON';
  return 'UNKNOWN';
}

function languageOf(filePath: string): LanguageKind {
  return languageKindFromExtension(extensionOfPath(filePath));
}

function extensionOfPath(filePath: string): string | undefined {
  const base = filePath.replace(/\\/g, '/');
  const lastSlash = base.lastIndexOf('/');
  const name = lastSlash >= 0 ? base.substring(lastSlash + 1) : base;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.substring(dot + 1) : undefined;
}

function relativePath(filePath: string): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '/';
  if (!workspaceRoot || workspaceRoot === '/') return filePath;
  return filePath.startsWith(workspaceRoot)
    ? filePath.slice(workspaceRoot.length).replace(/^[/\\]/, '')
    : filePath;
}

/** Computes a 1-based, inclusive line range for a source offset span (port of the JS `jsLineRange`). */
function lineRange(text: string, startOffset: number, endOffset: number): SourceRange {
  if (text.length === 0) return UNKNOWN_RANGE;
  const start = clamp(startOffset, 0, text.length);
  const end = clamp(endOffset, start, text.length);
  let startLine = 1;
  let endLine = 1;
  for (let index = 0; index < end; index++) {
    if (text[index] === '\n') {
      endLine++;
      if (index < start) startLine++;
    }
  }
  return { startLine, endLine };
}

/** Caret -> scope, decided on real source offsets only (never on PSI). */
export function resolveScope(
  outline: PythonFileOutline,
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
  const block = outline.blockContaining(caretOffset);
  if (block) {
    return {
      startOffset: block.startOffset,
      endOffset: block.endOffset,
      displayName: BLOCK_SCOPE_NAME,
      kind: UNKNOWN_KIND,
    };
  }
  const moduleHasContent =
    outline.types.length > 0 ||
    outline.functions.length > 0 ||
    outline.callSitesIn(0, outline.text.length).length > 0;
  return moduleHasContent
    ? { startOffset: 0, endOffset: outline.text.length, displayName: MODULE_SCOPE_NAME, kind: UNKNOWN_KIND }
    : undefined;
}
