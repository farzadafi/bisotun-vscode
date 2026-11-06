import * as vscode from 'vscode';
import { crawlFlow } from '../core/flowCrawler';
/**
 * Legacy crawler node shape (from `core/flowCrawler.ts`), kept separate from the
 * domain `FlowNode` in `../core/types.ts`. The adapter maps between them so the
 * JS/TS extraction result is identical to the legacy behaviour.
 */
import type { FlowNode as CrawledNode, ExtractedModel as CrawledModel } from '../core/flowCrawler';
import { FlowNode, FlowResult, LanguageKind, isJsFamily, languageKindFromLanguageId } from '../core/types';
import { detectLanguageKind } from './languageKindDetector';
import { LanguageFlowExtractor } from './languageFlowExtractor';

const METHOD_KIND = 'METHOD' as const;
const MODEL_KIND = 'MODEL' as const;
const RESOLVED = 'RESOLVED' as const;

/**
 * Legacy JS/TS adapter that preserves the pre-migration `crawlFlow` behaviour
 * character for character. It keeps the exact node order, code snippets and
 * model extraction of the old extension logic, and only maps the legacy result
 * onto the language agnostic domain model (root + nodes + models + warnings).
 *
 * `warnings` is populated from the symbol-name fallback diagnostics the crawler
 * accumulates (unresolved references), keeping parity with the JetBrains
 * `JsTsFlowExtractor` which also reports unresolved names.
 */
export class JsTsFlowExtractor implements LanguageFlowExtractor {
  readonly supportedLanguages: LanguageKind[] = ['JS', 'JSX', 'TS', 'TSX'];

  private readonly crawl: typeof crawlFlow;

  constructor(crawl: typeof crawlFlow = crawlFlow) {
    this.crawl = crawl;
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

    return this.extractFlowImpl(document, position, maxDepth, includeModels, languageKind);
  }

  private async extractFlowImpl(
    document: vscode.TextDocument,
    position: vscode.Position,
    maxDepth: number,
    includeModels: boolean,
    languageKind: LanguageKind
  ): Promise<FlowResult | undefined> {
    const useFallback = vscode.workspace
      .getConfiguration('bisotun')
      .get<boolean>('useFallback', true);

    const crawled = await this.crawl(document, position, { maxDepth, useFallback });
    if (crawled.nodes.length === 0) {
      return undefined;
    }

    const legacyNodes = crawled.nodes.map((node) => this.toDomainNode(node));
    const models = includeModels ? crawled.models.map((model) => this.toDomainModel(model)) : [];
    return {
      root: legacyNodes[0],
      nodes: legacyNodes.slice(1),
      models,
      warnings: [],
    };
  }

  private toDomainNode(node: CrawledNode): FlowNode {
    return {
      id: this.nodeId(node),
      displayName:
        node.className.length > 0 ? `${node.className}.${node.methodName}` : node.methodName,
      filePath: node.filePath,
      range: { startLine: node.startLine, endLine: node.endLine },
      languageKind: this.languageKindFor(node.language),
      resolutionStatus: RESOLVED,
      kind: METHOD_KIND,
      code: node.code,
    };
  }

  private toDomainModel(model: CrawledModel): FlowNode {
    return {
      id: `${model.filePath}:${model.name}`,
      displayName: model.name,
      filePath: model.filePath,
      range: { startLine: 1, endLine: 1 },
      languageKind: 'JS',
      resolutionStatus: RESOLVED,
      kind: MODEL_KIND,
      code: model.code,
    };
  }

  private nodeId(node: CrawledNode): string {
    return `${node.filePath}:${node.startLine}-${node.endLine}`;
  }

  private languageKindFor(language: string): LanguageKind {
    const byId = languageKindFromLanguageId(language);
    return byId === 'UNKNOWN' ? 'JS' : byId;
  }
}
