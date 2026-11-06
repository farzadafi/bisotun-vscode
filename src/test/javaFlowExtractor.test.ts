import * as assert from 'assert';
import * as vscode from 'vscode';

import { FlowResult } from '../core/types';
import { JavaFlowExtractor } from '../language/javaFlowExtractor';
import { formatFlow } from '../utils/formatter';

/**
 * Java flow extractor: unit tests with injected crawler + scope seams.
 *
 * The VS Code test host provides `vscode`, but the crawler and document-symbol
 * seams are injected, so no Red Hat Java LSP process is spawned and no files
 * are opened on disk. The only host surface touched is the default
 * `bisotun.useFallback` configuration read (empty config -> default `true`).
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

interface CrawledModel {
  name: string;
  filePath: string;
  code: string;
}

suite('JavaFlowExtractor', () => {
  const position = { line: 3, character: 4 } as vscode.Position;

  let crawlCalls: Array<{ maxDepth: number; useFallback: boolean }> = [];
  let strategyCalls: vscode.Position[] = [];

  function makeDocument(overrides: Partial<{ languageId: string; fileName: string }>) {
    return {
      languageId: overrides.languageId ?? 'java',
      fileName: overrides.fileName ?? '/fake/TestController.java',
      uri: { scheme: 'file', path: '/fake/TestController.java' } as unknown as vscode.Uri,
      getText: () => '',
      version: 1,
      isUntitled: false,
      isDirty: false,
      isClosed: false,
      lineAt: () => ({ text: '', lineNumber: 0 } as unknown as vscode.TextLine),
      offsetAt: () => 0,
      save: async () => true,
      validatePosition: () => position,
    } as unknown as vscode.TextDocument;
  }

  function rootNode(): CrawledNode {
    return {
      className: 'TestController',
      methodName: 'createOrder',
      filePath: '/fake/TestController.java',
      startLine: 10,
      endLine: 18,
      language: 'java',
      code: 'public Order createOrder(...) {\n  return repo.save(...);\n}',
    };
  }

  function childNode(): CrawledNode {
    return {
      className: 'OrderRepository',
      methodName: 'save',
      filePath: '/fake/OrderRepository.java',
      startLine: 42,
      endLine: 46,
      language: 'java',
      code: 'Order save(Order o) { ... }',
    };
  }

  function model(): CrawledModel {
    return {
      name: 'Order',
      filePath: '/fake/Order.java',
      code: 'public record Order(Long id, String status) {}',
    };
  }

  function makeExtractor(nodes: CrawledNode[], models: CrawledModel[]) {
    crawlCalls = [];
    strategyCalls = [];
    const crawl = async (
      _document: vscode.TextDocument,
      _position: vscode.Position,
      options: { maxDepth: number; useFallback: boolean }
    ) => {
      crawlCalls.push(options);
      return { nodes, models };
    };
    const strategy = {
      findEnclosingScope: async (_document: vscode.TextDocument, p: vscode.Position) => {
        strategyCalls.push(p);
        return {
          className: 'TestController',
          methodName: 'createOrder',
          range: { start: { line: 9, character: 0 }, end: { line: 18, character: 1 } } as vscode.Range,
        };
      },
    };
    return new JavaFlowExtractor(crawl, strategy);
  }

  test('maxDepth is forwarded to the crawler and root is trimmed from nodes', async () => {
    const extractor = makeExtractor([rootNode(), childNode()], [model()]);
    const result = await extractor.extractFlow({
      document: makeDocument({}),
      position,
      maxDepth: 0,
      includeModels: true,
    });

    assert.ok(result, 'Expected a flow result');
    assert.strictEqual(crawlCalls.length, 1);
    assert.strictEqual(crawlCalls[0].maxDepth, 0);
    assert.strictEqual(crawlCalls[0].useFallback, true);

    // Root trimmed: the crawler node list becomes root (index 0) + rest.
    assert.strictEqual(result.root.kind, 'METHOD');
    assert.strictEqual(result.root.displayName, 'TestController.createOrder');
    assert.strictEqual(result.nodes.length, 1);
    assert.strictEqual(result.nodes[0].displayName, 'OrderRepository.save');

    // Legacy line numbers map to id '{file}:{start}-{end}' and a SourceRange.
    assert.strictEqual(result.root.id, '/fake/TestController.java:10-18');
    assert.strictEqual(result.root.range.startLine, 10);
    assert.strictEqual(result.nodes[0].id, '/fake/OrderRepository.java:42-46');
  });

  test('nodes are RESOLVED METHOD nodes with snippet and code kept', async () => {
    const extractor = makeExtractor([rootNode(), childNode()], []);
    const result = (await extractor.extractFlow({
      document: makeDocument({}),
      position,
      maxDepth: 4,
      includeModels: true,
    })) as FlowResult;

    assert.ok(result);
    assert.strictEqual(result.root.resolutionStatus, 'RESOLVED');
    assert.strictEqual(result.root.kind, 'METHOD');
    assert.ok(result.root.code.includes('createOrder'), 'root code snippet preserved');
    assert.strictEqual(result.nodes[0].languageKind, 'JAVA');
  });

  test('includeModels=false drops models but keeps nodes', async () => {
    const extractor = makeExtractor([rootNode()], [model()]);
    const result = await extractor.extractFlow({
      document: makeDocument({}),
      position,
      maxDepth: 1,
      includeModels: false,
    });

    assert.ok(result);
    assert.ok(result.nodes.length === 0, 'no children, only root');
    assert.strictEqual(result.models.length, 0);
  });

  test('empty crawler result is surfaced as undefined (no methods at caret)', async () => {
    const extractor = makeExtractor([], []);
    const result = await extractor.extractFlow({
      document: makeDocument({}),
      position,
      maxDepth: 4,
      includeModels: true,
    });
    assert.strictEqual(result, undefined);
  });

  test('missing enclosing method is surfaced as undefined', async () => {
    crawlCalls = [];
    const crawl = async () => ({ nodes: [], models: [] });
    const strategy = { findEnclosingScope: async () => undefined };
    const extractor = new JavaFlowExtractor(crawl, strategy);

    const result = await extractor.extractFlow({
      document: makeDocument({}),
      position,
      maxDepth: 4,
      includeModels: true,
    });
    assert.strictEqual(result, undefined);
    assert.strictEqual(crawlCalls.length, 0, 'crawler must not run without a root scope');
  });

  test('Kotlin files are not supported (KOTLIN -> undefined, crawler untouched)', async () => {
    const extractor = makeExtractor([rootNode()], []);
    const result = await extractor.extractFlow({
      document: makeDocument({ languageId: 'kotlin', fileName: '/fake/Main.kt' }),
      position,
      maxDepth: 4,
      includeModels: true,
    });
    assert.strictEqual(result, undefined);
    assert.strictEqual(strategyCalls.length, 0);
  });

  test('Python files are not supported', async () => {
    const extractor = makeExtractor([rootNode()], []);
    const result = await extractor.extractFlow({
      document: makeDocument({ languageId: 'python', fileName: '/fake/app.py' }),
      position,
      maxDepth: 4,
      includeModels: true,
    });
    assert.strictEqual(result, undefined);
  });

  test('the markdown.md contract is produced for a Java flow', async () => {
    const extractor = makeExtractor([rootNode(), childNode()], [model()]);
    const result = (await extractor.extractFlow({
      document: makeDocument({}),
      position,
      maxDepth: 4,
      includeModels: true,
    })) as FlowResult;
    assert.ok(result);

    const md = formatFlow(result, 'markdown');
    assert.ok(md.includes('# Context Flow Extracted by Bisotun'), 'summary header');
    assert.ok(md.includes('- Root Target: `TestController#createOrder`'), 'root target');
    assert.ok(md.includes('- Extracted Nodes: 2'), 'node count');
    assert.ok(md.includes('## Root Method'), 'root method section');
    assert.ok(md.includes('## Execution Dependencies'), 'dependencies section');
    assert.ok(
      md.includes('## Related Data Models (DTOs / Projections / Records)'),
      'models section'
    );
    assert.ok(md.includes('### Model: `Order`'), 'model header');
  });
});

