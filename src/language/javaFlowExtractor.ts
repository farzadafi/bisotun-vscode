import * as vscode from 'vscode';
import { crawlFlow } from '../core/flowCrawler';
import {
  FlowNode,
  FlowResult,
  LanguageKind,
  NodeKind,
  ResolutionStatus,
  SourceRange,
} from '../core/types';
import { JavaStrategy } from '../strategies/javaStrategy';
import { detectLanguageKind } from './languageKindDetector';
import { LanguageFlowExtractor } from './languageFlowExtractor';

/**
 * The legacy crawler's flow node seam: the only shape `crawlFlow` produces.
 * Closing over it keeps this file independent of internal crawler changes.
 */
interface CrawledNode {
  className: string;
  methodName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  code: string;
}

/** Legacy model shape produced by the crawler's model pass. */
interface CrawledModel {
  name: string;
  filePath: string;
  code: string;
}

interface CrawledFlow {
  nodes: CrawledNode[];
  models: CrawledModel[];
}

/** The `crawlFlow` seam the extractor depends on (injectable for tests). */
type Crawl = (
  document: vscode.TextDocument,
  position: vscode.Position,
  options: { maxDepth: number; useFallback: boolean }
) => Promise<CrawledFlow>;

/** The document-symbol seam (`JavaStrategy.findEnclosingScope`), injectable for tests. */
type ScopeStrategy = {
  findEnclosingScope(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<{ className: string; methodName: string; range: vscode.Range } | undefined>;
};

const METHOD_KIND: NodeKind = 'METHOD';
const MODEL_KIND: NodeKind = 'MODEL';
const RESOLVED: ResolutionStatus = 'RESOLVED';

/**
 * Java strategy: a thin adapter over the existing VS Code Java infrastructure
 * (the legacy LSP crawler in `core/flowCrawler.ts` plus the `JavaStrategy`
 * symbol/model helpers), mirroring the JetBrains plugin's `JavaFlowExtractor`
 * which wraps `FlowCrawler` + `ModelExtractor` without changing their behaviour.
 *
 * Only the mapping onto the language agnostic domain model lives here:
 *  - the root is still the enclosing method of the caret (via document symbols),
 *  - traversal still respects `maxDepth` (0 = root only, 1 = direct children),
 *  - every produced node maps to a real resolved method (nothing is fabricated),
 *  - models are only collected when `includeModels` is true,
 *  - warnings are empty on the Java path, exactly like the JetBrains Java flow.
 */
export class JavaFlowExtractor implements LanguageFlowExtractor {
  readonly supportedLanguages: LanguageKind[] = ['JAVA', 'KOTLIN'];

  /** Kept injectable so tests can stub the crawler without touching LSP. */
  private readonly crawl: Crawl;

  private readonly strategy: ScopeStrategy;

  constructor(crawl: Crawl = crawlFlow, strategy: ScopeStrategy = new JavaStrategy()) {
    this.crawl = crawl;
    this.strategy = strategy;
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

    return this.extractFlowOnKind(document, position, maxDepth, includeModels, languageKind);
  }

  /** Outer seam kept separate so the message handling mirrors the Java/Kotlin split. */
  private async extractFlowOnKind(
    document: vscode.TextDocument,
    position: vscode.Position,
    maxDepth: number,
    includeModels: boolean,
    languageKind: LanguageKind
  ): Promise<FlowResult | undefined> {
    if (languageKind === 'KOTLIN') {
      return undefined;
    }
    if (languageKind !== 'JAVA') {
      return undefined;
    }

    const rootScope = await this.strategy.findEnclosingScope(document, position);
    if (!rootScope) {
      return undefined;
    }

    const useFallback = vscode.workspace
      .getConfiguration('bisotun')
      .get<boolean>('useFallback', true);

    const crawled = await this.crawl(document, position, { maxDepth, useFallback });
    return this.toFlowResult(crawled, includeModels);
  }

  private toFlowResult(crawled: CrawledFlow, includeModels: boolean): FlowResult | undefined {
    if (crawled.nodes.length === 0) {
      return undefined;
    }

    const nodes = crawled.nodes.map((crawledNode) => this.toDomainNode(crawledNode));
    const root = nodes[0];
    const rest = nodes.slice(1);
    const models = includeModels ? crawled.models.map((model) => this.toModelNode(model)) : [];

    return {
      root,
      nodes: rest,
      models,
      warnings: [],
    };
  }

  private toDomainNode(crawledNode: CrawledNode): FlowNode {
    const displayName =
      crawledNode.className.length > 0
        ? `${crawledNode.className}.${crawledNode.methodName}`
        : crawledNode.methodName;
    return {
      id: `${crawledNode.filePath}:${crawledNode.startLine}-${crawledNode.endLine}`,
      displayName,
      filePath: crawledNode.filePath,
      range: this.toRange(crawledNode),
      languageKind: this.languageKindFor(crawledNode.language),
      resolutionStatus: RESOLVED,
      kind: METHOD_KIND,
      code: crawledNode.code,
    };
  }

  private toModelNode(model: CrawledModel): FlowNode {
    return {
      id: `${model.filePath}:${model.name}`,
      displayName: model.name,
      filePath: model.filePath,
      range: { startLine: 1, endLine: 1 },
      languageKind: 'JAVA',
      resolutionStatus: RESOLVED,
      kind: MODEL_KIND,
      code: model.code,
    };
  }

  private languageKindFor(language: string): LanguageKind {
    const byId = detectLanguageKind({ languageId: language, fileName: undefined });
    if (byId !== 'UNKNOWN') return byId;
    return 'JAVA';
  }

  private toRange(node: CrawledNode): SourceRange {
    return { startLine: node.startLine, endLine: node.endLine };
  }
}
