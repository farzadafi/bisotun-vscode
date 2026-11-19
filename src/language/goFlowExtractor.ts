// Go flow extractor: the tokenizer tier, the Go counterpart of `CppFlowExtractor` and
// `JsTsFlowExtractor`.
//
// No language server and no regex parsing: everything comes from the hand written tokenizer
// (`src/go/goTokenizer.ts`), the Go outline (`src/go/goFileOutline.ts`), the `go.mod`-aware package
// context (`src/go/goAnalysisContext.ts`) and the tiered call resolver
// (`src/go/goCallResolver.ts`). A call is only expanded when a declaration can actually be found in
// the current file, in a sibling file of the same package, or in a package reachable through one of
// the file's imports; everything else becomes an UNRESOLVED node (never fabricated).
//
// Standard library packages, built-in functions and built-in type conversions are filtered exactly
// like the JS/TS, Python and C++ builtin gates: only sites that failed to resolve are checked, so a
// project function that happens to share a built-in name still wins. `panic`/`recover` are kept on
// purpose: they carry the error-handling shape of the flow.
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
import { GoAnalysisContext, GoBoundSource } from '../go/goAnalysisContext';
import { GoCallResolver, GoResolvedCall, packageQualifierOf } from '../go/goCallResolver';
import { GoCallSite, GoFileOutline, GoFunctionDef, GoTypeDef } from '../go/goFileOutline';
import { LanguageFlowExtractor } from './languageFlowExtractor';
import { detectLanguageKind } from './languageKindDetector';

const RESOLVED: ResolutionStatus = 'RESOLVED';
const UNRESOLVED: ResolutionStatus = 'UNRESOLVED';

const MODEL_KIND: NodeKind = 'MODEL';
const UNKNOWN_KIND: NodeKind = 'UNKNOWN';

/** One expandable scope of the tokenizer strategy: a function, a type, a `{...}` block or the file. */
interface GoScope {
  startOffset: number;
  endOffset: number;
  displayName: string;
  kind: NodeKind;
  /** Set for function/method scopes so calls inside nested function literals are crawled too. */
  definition?: GoFunctionDef;
}

/** A scope still to crawl; `node` is set only for unresolved (leaf) calls. */
interface ReaderScope {
  source: GoBoundSource;
  scope: GoScope | null;
  node?: FlowNode | undefined;
}

const BLOCK_SCOPE_NAME = 'block()';
const FILE_SCOPE_NAME = 'file()';

/**
 * Go built-in functions. An unresolved call naming one can only point at the runtime, so it is
 * dropped instead of filling the flow with `len()` / `append()` noise. `panic` and `recover` are
 * deliberately absent: they are kept as error-handling flow.
 */
const GO_BUILTIN_FUNCTIONS = new Set([
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max',
  'min', 'new', 'print', 'println', 'real',
]);

/** Predeclared Go types: `string(x)` / `int64(y)` are conversions, not calls. */
const GO_PREDECLARED_TYPES = new Set([
  'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error', 'float32', 'float64',
  'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32',
  'uint64', 'uintptr',
]);

/**
 * Standard library package names, used as a fallback when a malformed file uses a package
 * qualifier without a matching `import` (well formed files are gated by their import path).
 */
const GO_STD_PACKAGES = new Set([
  'archive', 'bufio', 'bytes', 'cmp', 'compress', 'container', 'context', 'crypto', 'database',
  'debug', 'embed', 'encoding', 'errors', 'expvar', 'flag', 'fmt', 'go', 'hash', 'html', 'image',
  'index', 'io', 'log', 'maps', 'math', 'mime', 'net', 'os', 'path', 'plugin', 'reflect', 'regexp',
  'runtime', 'slices', 'sort', 'strconv', 'strings', 'sync', 'syscall', 'testing', 'text', 'time',
  'unicode', 'unsafe',
]);

/** Factory seam so extractor tests can inject an in-memory analysis context. */
export interface GoAnalysisContextFactory {
  (): GoAnalysisContext;
}

export class GoFlowExtractor implements LanguageFlowExtractor {
  readonly supportedLanguages: LanguageKind[] = ['GO'];

  private readonly callResolver = new GoCallResolver();
  private readonly analysisContext: GoAnalysisContext;
  private readonly packageCache = new Map<string, GoBoundSource[]>();

  constructor(factory: GoAnalysisContextFactory = defaultGoAnalysisContext) {
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
    if (languageKind !== 'GO') {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(this.extractFlowImpl(document, position, maxDepth, includeModels));
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
    const scope = resolveGoScope(source.outline, clamped);
    if (!scope) {
      return undefined;
    }
    return this.buildFlow(source, scope, maxDepth, includeModels);
  }

  private buildFlow(
    source: GoBoundSource,
    scope: GoScope,
    maxDepth: number,
    includeModels: boolean
  ): FlowResult {
    const rootNode = this.nodeFor(source, scope);
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
          const sites = handleScope.definition !== undefined
            ? handle.source.outline.callSitesIn(handleScope.definition)
            : handle.source.outline.callSitesIn(handleScope.startOffset, handleScope.endOffset);
          for (const site of sites) {
            const resolved = this.resolveCall(handle.source, site);
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
              definition.startOffset === handleScope.startOffset
            ) {
              continue;
            }
            const targetScope: GoScope = {
              startOffset: definition.startOffset,
              endOffset: definition.endOffset,
              displayName: definition.displayName,
              kind: definition.kind,
              definition,
            };
            const node = this.nodeFor(resolved.source, targetScope);
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
      .filter((it): it is ReaderScope & { scope: GoScope } => it.scope !== null)
      .map((it) => this.nodeFor(it.source, it.scope));
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

  private resolveCall(source: GoBoundSource, site: GoCallSite): GoResolvedCall | undefined {
    return this.callResolver.resolve(
      source,
      site,
      this.samePackage(source),
      (from, importPath) => this.analysisContext.resolveImport(from, importPath)
    );
  }

  private samePackage(source: GoBoundSource): GoBoundSource[] {
    const key = source.packageDir;
    const cached = this.packageCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const sources = this.analysisContext.packageSourcesFor(source);
    this.packageCache.set(key, sources);
    return sources;
  }

  /**
   * Whether an unresolved site is ecosystem noise. Only unresolved sites reach this gate: a project
   * function or method with the same name resolves first and is kept.
   */
  private isNoiseCall(source: GoBoundSource, site: GoCallSite): boolean {
    const outline = source.outline;
    const qualifier = site.qualifier;
    const imported = qualifier !== null ? outline.importNamed(qualifier) : undefined;

    // Calls on a package that is not part of the workspace (standard library or third-party).
    if (imported !== undefined) {
      return this.analysisContext.resolveImport(source, imported.path) === undefined;
    }

    if (qualifier === null) {
      if (GO_BUILTIN_FUNCTIONS.has(site.name) || GO_PREDECLARED_TYPES.has(site.name)) {
        return true;
      }
      // `Foo(x)` where `Foo` is a declared type is a conversion, not a call.
      if (outline.typeNamed(site.name) !== undefined) {
        return true;
      }
      if (this.samePackage(source).some((candidate) => candidate.outline.typeNamed(site.name) !== undefined)) {
        return true;
      }
      return false;
    }

    // A bare `fmt.Println` in a file whose import block could not be parsed.
    if (imported === undefined && qualifier === site.rootIdentifier && GO_STD_PACKAGES.has(qualifier)) {
      return true;
    }

    const enclosing = outline.functionContaining(site.offset);
    if (enclosing !== undefined) {
      const variable = outline.variableType(enclosing, site.rootIdentifier);
      // Function-typed values and parameters: a functor invocation, not a free function.
      if (variable !== undefined && variable.trim().startsWith('func')) {
        return true;
      }
      // Selector on a value whose declared type lives outside the workspace.
      if (variable !== undefined && this.isExternalType(source, variable)) {
        return true;
      }
    }
    return false;
  }

  private isExternalType(source: GoBoundSource, typeText: string): boolean {
    const qualifier = packageQualifierOf(typeText);
    if (qualifier === null) {
      return false;
    }
    const imported = source.outline.importNamed(qualifier);
    if (imported === undefined) {
      return false;
    }
    return this.analysisContext.resolveImport(source, imported.path) === undefined;
  }

  private collectModels(roots: ReaderScope[]): FlowNode[] {
    const models = new Map<string, FlowNode>();
    for (const handle of roots) {
      const scope = handle.scope;
      if (!scope) {
        continue;
      }
      const outline = handle.source.outline;
      const identifiers = outline.identifiersIn(scope.startOffset, scope.endOffset);
      for (const name of identifiers) {
        const localType = outline.typeNamed(name);
        if (localType) {
          this.addModelWithEmbedded(models, handle.source, localType, 0);
          continue;
        }
        const siblings = this.samePackage(handle.source);
        for (const sibling of siblings) {
          const sharedType = sibling.outline.typeNamed(name);
          if (sharedType) {
            this.addModelWithEmbedded(models, sibling, sharedType, 0);
            break;
          }
        }
      }
      // Types referenced through an import alias (`models.User`, `&models.User{}`).
      for (const imported of outline.imports) {
        if (!identifiers.has(imported.alias)) {
          continue;
        }
        for (const target of this.analysisContext.resolveImport(handle.source, imported.path) ?? []) {
          for (const type of target.outline.types) {
            if (identifiers.has(type.name)) {
              this.addModelWithEmbedded(models, target, type, 0);
            }
          }
        }
      }
      for (const literal of outline.compositeLiteralsIn(scope.startOffset, scope.endOffset)) {
        const qualifier = literal.qualifier;
        if (qualifier === null) {
          continue;
        }
        const imported = outline.importNamed(qualifier);
        if (imported === undefined) {
          continue;
        }
        for (const target of this.analysisContext.resolveImport(handle.source, imported.path) ?? []) {
          const literalType = target.outline.typeNamed(literal.typeName);
          if (literalType) {
            this.addModelWithEmbedded(models, target, literalType, 0);
          }
        }
      }
    }
    return Array.from(models.values());
  }

  /** Adds a data model plus the types it embeds (struct/interface embedding relationship). */
  private addModelWithEmbedded(
    models: Map<string, FlowNode>,
    source: GoBoundSource,
    type: GoTypeDef,
    depth: number
  ): void {
    this.addModel(models, source, type);
    if (depth >= 3) {
      return;
    }
    const local = [source, ...this.samePackage(source)];
    for (const embedded of type.embeddeds) {
      const qualifier = packageQualifierOf(embedded.type);
      if (qualifier !== null) {
        const imported = source.outline.importNamed(qualifier);
        if (imported === undefined) {
          continue;
        }
        for (const target of this.analysisContext.resolveImport(source, imported.path) ?? []) {
          const embeddedType = target.outline.typeNamed(embedded.name);
          if (embeddedType) {
            this.addModelWithEmbedded(models, target, embeddedType, depth + 1);
          }
        }
        continue;
      }
      for (const candidate of local) {
        const embeddedType = candidate.outline.typeNamed(embedded.name);
        if (embeddedType) {
          this.addModelWithEmbedded(models, candidate, embeddedType, depth + 1);
          break;
        }
      }
    }
  }

  private addModel(
    models: Map<string, FlowNode>,
    source: GoBoundSource,
    type: GoTypeDef
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

  private nodeFor(source: GoBoundSource, scope: GoScope): FlowNode {
    const start = clamp(scope.startOffset, 0, source.text.length);
    const end = clamp(scope.endOffset, start, source.text.length);
    return {
      id: `${source.filePath}:${start}-${end}`,
      displayName: scope.displayName,
      filePath: relativePath(source.filePath),
      range: lineRange(source.text, start, end),
      languageKind: languageOf(source.filePath),
      resolutionStatus: RESOLVED,
      kind: scope.kind,
      code: source.text.substring(start, end).trim(),
    };
  }

  private unresolvedNode(source: GoBoundSource, site: GoCallSite): FlowNode {
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

function defaultGoAnalysisContext(): GoAnalysisContext {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    path.dirname(vscode.window.activeTextEditor?.document.uri.fsPath ?? '/');
  const openSourceReader = (filePath: string): string | undefined =>
    vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filePath)?.getText();
  return new GoAnalysisContext({ workspaceRoot, openSourceReader });
}

/**
 * Caret -> scope, decided on real source offsets only. Order of preference: innermost
 * function/method/function literal, innermost type declaration, innermost `{...}` block, package
 * scope - the last one only when the file really declares something to crawl, so an empty or
 * unparsable file reports nothing.
 */
export function resolveGoScope(outline: GoFileOutline, caretOffset: number): GoScope | undefined {
  const fn = outline.functionContaining(caretOffset);
  if (fn) {
    return {
      startOffset: fn.startOffset,
      endOffset: fn.endOffset,
      displayName: fn.displayName,
      kind: fn.kind,
      definition: fn,
    };
  }
  const type = outline.typeContaining(caretOffset);
  if (type) {
    return {
      startOffset: type.startOffset,
      endOffset: type.endOffset,
      displayName: type.name,
      kind: MODEL_KIND,
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
  const hasContent =
    outline.packageName.length > 0 ||
    outline.imports.length > 0 ||
    outline.types.length > 0 ||
    outline.functions.length > 0 ||
    outline.values.length > 0 ||
    outline.callSitesIn(0, outline.text.length).length > 0;
  return hasContent
    ? {
        startOffset: 0,
        endOffset: outline.text.length,
        displayName: FILE_SCOPE_NAME,
        kind: UNKNOWN_KIND,
      }
    : undefined;
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
