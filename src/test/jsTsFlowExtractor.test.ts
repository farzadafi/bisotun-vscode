import * as assert from 'assert';
import * as vscode from 'vscode';

import { FlowResult } from '../core/types';
import { JsAnalysisContext, JsBoundSource } from '../js/jsAnalysisContext';
import { parseJsOutline } from '../js/jsFileOutline';
import { JsCallResolver, JsResolvedCall } from '../js/jsCallResolver';
import { JsTsFlowExtractor, resolveScope } from '../language/jsTsFlowExtractor';
import { formatFlow } from '../utils/formatter';

/**
 * JS/TS/JSX/TSX flow extractor: hermetic tests.
 *
 * The extractor's disk context is replaced by an in-memory map and no real
 * workspace/document is opened, so the whole tokenizer tier (tokenizer,
 * outline, resolver, BFS flow) runs without a JS language server or files on
 * disk. The cases mirror the JetBrains `JsTsFlowExtractorTest` (caret scope,
 * chains, resolver tiers, cross-file imports, built-in filtering, models).
 */

/** Returns the 1-based line of `needle` inside `text` (0 for the start of a signature). */
function lineOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `needle not found in fixture: ${needle}`);
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

function positionAt(text: string, needle: string): vscode.Position {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `needle not found: ${needle}`);
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: index - lineStart } as vscode.Position;
}

/** `JsAnalysisContext` sealed to an in-memory file map (POSIX paths, no disk). */
class InMemoryJsContext extends JsAnalysisContext {
  private readonly files: Map<string, string>;

  constructor(files: Map<string, string>) {
    super({
      workspaceRoot: '/proj',
      textReader: (filePath) => files.get(filePath),
      openSourceReader: (filePath) => files.get(filePath),
    });
    this.files = files;
  }

  override resolveSpecifier(fromFile: string, specifier: string): string | undefined {
    const base = specifier.replace(/^\.\//, '');
    const fromDir = this.fromDir(fromFile);
    for (const extension of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']) {
      const candidate = this.path(fromDir, `${base}.${extension}`);
      if (this.files.has(candidate)) return candidate;
    }
    const index = this.path(fromDir, `${base}/index.ts`);
    if (this.files.has(index)) return index;
    return undefined;
  }

  private fromDir(filePath: string): string {
    const slash = filePath.lastIndexOf('/');
    return slash >= 0 ? filePath.slice(0, slash) : '/proj';
  }

  private path(dir: string, leaf: string): string {
    return dir === '/' ? `/${leaf}` : `${dir}/${leaf}`;
  }
}

function makeExtractor(files: Map<string, string>): JsTsFlowExtractor {
  const context = new InMemoryJsContext(files);
  return new JsTsFlowExtractor(() => context);
}

function makeDocument(fileName: string, text: string, languageId: string): vscode.TextDocument {
  const lines = text.split('\n');
  const uri = { scheme: 'file', path: fileName, fsPath: fileName } as vscode.Uri;
  return {
    languageId,
    fileName,
    uri,
    getText: () => text,
    lineCount: lines.length,
    offsetAt: (p: vscode.Position) => {
      let offset = 0;
      for (let i = 0; i < p.line; i++) offset += (lines[i] ?? '').length + 1;
      return Math.min(offset + p.character, text.length);
    },
  } as unknown as vscode.TextDocument;
}

const SERVICE_SOURCE = [
  'class PaymentService {',
  '  helper() {',
  '    return 1;',
  '  }',
  '',
  '  process() {',
  '    const total = payment.amount;',
  '    return this.helper() + total;',
  '  }',
  '}',
].join('\n');

const MODULE_SOURCE = [
  'startBilling();',
  '',
  'export function run() {',
  '  return helper();',
  '}',
  '',
  'function helper() {',
  '  return 1;',
  '}',
].join('\n');

suite('JsTsFlowExtractor', () => {
  const resolver = new JsCallResolver();

  test('outline discovers module functions and class methods in source order', () => {
    const outline = parseJsOutline(SERVICE_SOURCE);
    assert.deepStrictEqual(
      outline.functions.map((fn) => fn.name),
      ['helper', 'process']
    );
    assert.deepStrictEqual(
      outline.types.map((t) => t.name),
      ['PaymentService']
    );
  });

  test('innermost function wins at the caret and class methods are METHODS', () => {
    const outline = parseJsOutline(SERVICE_SOURCE);

    const insideBody = outline.functionContaining(SERVICE_SOURCE.indexOf('payment.amount'));
    assert.ok(insideBody, 'caret inside a method body resolves to that method');
    assert.strictEqual(insideBody.name, 'process');
    assert.strictEqual(insideBody.kind, 'METHOD');

    const atDef = outline.functionContaining(SERVICE_SOURCE.indexOf('process()'));
    assert.strictEqual(atDef?.name, 'process');
  });

  test('module scope lists its own calls only (nested function bodies are skipped)', () => {
    const outline = parseJsOutline(MODULE_SOURCE);
    const moduleCalls = outline.callSitesIn(0, MODULE_SOURCE.length);
    assert.deepStrictEqual(
      moduleCalls.map((site) => site.rawText),
      ['startBilling']
    );
  });

  test('function scope collapses member call chains to the last segment', () => {
    const outline = parseJsOutline(SERVICE_SOURCE);
    const process = outline.functionNamed('process');
    assert.ok(process);

    const calls = outline.callSitesIn(process.startOffset, process.endOffset);
    assert.strictEqual(calls.length, 1);
    const site = calls[0];
    // `this` is a keyword, so the chain collapses at `helper` (no qualifier) - the same behavior
    // as the JetBrains tokenizer tier, where `this` is never part of the call-site name.
    assert.strictEqual(site.name, 'helper');
    assert.strictEqual(site.qualifier, null);
    assert.strictEqual(site.rootIdentifier, 'helper');
    assert.strictEqual(site.rawText, 'helper');
  });

  test('same-file plain call resolves to the local function', () => {
    const outline = parseJsOutline(MODULE_SOURCE);
    const source: JsBoundSource = {
      filePath: '/proj/app.ts',
      text: MODULE_SOURCE,
      outline,
    };
    const run = outline.functionNamed('run');
    assert.ok(run);
    const site = outline.callSitesIn(run).find((s) => s.name === 'helper');
    assert.ok(site);

    const resolved = resolver.resolve(source, site, () => undefined);
    assert.ok(resolved);
    assert.strictEqual(resolved.definition.name, 'helper');
    assert.strictEqual(resolved.source.filePath, '/proj/app.ts');
  });

  test('this method call resolves to the class method in the same file', () => {
    const outline = parseJsOutline(SERVICE_SOURCE);
    const source: JsBoundSource = {
      filePath: '/proj/services.ts',
      text: SERVICE_SOURCE,
      outline,
    };
    const process = outline.functionNamed('process');
    assert.ok(process);
    const sites = outline.callSitesIn(process.startOffset, process.endOffset);
    const site = sites.find((s) => s.name === 'helper');
    assert.ok(site);

    const resolved = resolver.resolve(source, site, () => undefined);
    assert.ok(resolved);
    assert.strictEqual(resolved.definition.name, 'helper');
    assert.strictEqual(resolved.definition.kind, 'METHOD');
  });

  test('import binding resolves a module-level function in another file', () => {
    const outline = parseJsOutline(MODULE_SOURCE);
    const source: JsBoundSource = {
      filePath: '/proj/runner.ts',
      text: MODULE_SOURCE,
      outline,
    };
    const files = new Map<string, string>([
      ['/proj/services.js', 'export function run() { return 1; }'],
      ['/proj/runner.ts', MODULE_SOURCE],
    ]);
    const context = new InMemoryJsContext(files);
    const run = outline.functionNamed('run');
    assert.ok(run);
    // `startBilling` is a plain call in the module; `run` is a declaration (filtered).
    const moduleSites = outline.callSitesIn(0, MODULE_SOURCE.length, false);
    const site = moduleSites.find((s) => s.name === 'startBilling');
    assert.ok(site);

    const resolved = resolver.resolve(source, site, () => undefined);
    // No import binds `startBilling` and no declaration exists -> stays unresolved.
    assert.strictEqual(resolved, undefined);
  });

  test('exact binding matches the qualifier and resolves the member method', () => {
    const runner = [
      "import { PaymentService } from './services';",
      '',
      'export function run() {',
      '  const svc = new PaymentService();',
      '  return svc.process();',
      '}',
    ].join('\n');
    const files = new Map<string, string>([
      ['/proj/services.ts', SERVICE_SOURCE],
      ['/proj/runner.ts', runner],
    ]);
    const context = new InMemoryJsContext(files);
    const source = context.sourceForFileAsSource('/proj/runner.ts');
    assert.ok(source);
    const run = source.outline.functionNamed('run');
    assert.ok(run);
    const site = source.outline.callSitesIn(run).find((s) => s.name === 'process');
    assert.ok(site);

    const resolved = resolver.resolve(source, site, (from, specifier) => {
      const targetPath = context.resolveSpecifier(from.filePath, specifier);
      return targetPath ? context.sourceForFileAsSource(targetPath) : undefined;
    });
    assert.ok(resolved);
    assert.strictEqual(resolved.definition.name, 'process');
    assert.strictEqual(resolved.definition.kind, 'METHOD');
    assert.ok(resolved.source.filePath.endsWith('services.ts'));
  });

  test('fuzzy qualifier-to-import match resolves through the imported class', () => {
    // `gateway` has no exact binding, but `PaymentGateway` is the only import whose name relates.
    const runner = [
      "import { PaymentGateway } from './services';",
      '',
      'export function run() {',
      '  const gateway = new PaymentGateway();',
      '  return gateway.charge("card");',
      '}',
    ].join('\n');
    const services = [
      'export class PaymentGateway {',
      '  charge(method: string) {',
      '    return method;',
      '  }',
      '}',
    ].join('\n');
    const files = new Map<string, string>([
      ['/proj/services.ts', services],
      ['/proj/runner.ts', runner],
    ]);
    const context = new InMemoryJsContext(files);
    const source = context.sourceForFileAsSource('/proj/runner.ts');
    assert.ok(source);
    const run = source.outline.functionNamed('run');
    assert.ok(run);
    const site = source.outline.callSitesIn(run).find((s) => s.name === 'charge');
    assert.ok(site);

    const resolved = resolver.resolve(source, site, (from, specifier) => {
      const targetPath = context.resolveSpecifier(from.filePath, specifier);
      return targetPath ? context.sourceForFileAsSource(targetPath) : undefined;
    });
    assert.ok(resolved);
    assert.strictEqual(resolved.definition.name, 'charge');
    assert.strictEqual(resolved.definition.kind, 'METHOD');
    assert.ok(resolved.source.filePath.endsWith('services.ts'));
  });

  test('unresolvable member call stays unresolved instead of inventing a target', () => {
    const outline = parseJsOutline(SERVICE_SOURCE);
    const source: JsBoundSource = {
      filePath: '/proj/services.ts',
      text: SERVICE_SOURCE,
      outline,
    };
    const site = {
      name: 'fetch',
      qualifier: 'externalClient',
      rootIdentifier: 'externalClient',
      offset: SERVICE_SOURCE.indexOf('payment.amount'),
      rawText: 'externalClient.fetch()',
    };
    const resolved = resolver.resolve(source, site, () => undefined);
    assert.strictEqual(resolved, undefined);
  });

  test('host globals are filtered by the builtin gate', () => {
    const source = [
      'export function run() {',
      '  console.log("x");',
      '  document.querySelector("body");',
      '  Math.max(1, 2);',
      '}',
    ].join('\n');
    const context = new InMemoryJsContext(new Map([['/proj/app.ts', source]]));
    const extractor = makeExtractor(new Map([['/proj/app.ts', source]]));

    return extractor.extractFlow({
      document: makeDocument('/proj/app.ts', source, 'typescript'),
      position: positionAt(source, 'run() {'),
      maxDepth: 1,
      includeModels: false,
    }).then((result) => {
      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'run()');
      assert.deepStrictEqual(
        result.nodes.map((n) => n.displayName),
        [],
        'console/document/Math are ecosystem noise and must not expand a flow'
      );
    });
  });

  suite('extractFlow', () => {
    test('resolves a cross-file method and collects no model for a service', async () => {
      const runner = [
        "import { PaymentService } from './services';",
        '',
        'export function run() {',
        '  const svc = new PaymentService();',
        '  return svc.process();',
        '}',
      ].join('\n');
      const files = new Map<string, string>([
        ['/proj/services.ts', SERVICE_SOURCE],
        ['/proj/runner.ts', runner],
      ]);
      const extractor = makeExtractor(files);

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/runner.ts', runner, 'typescript'),
        position: positionAt(runner, 'run() {'),
        maxDepth: 3,
        includeModels: true,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'run()');
      assert.strictEqual(result.root.resolutionStatus, 'RESOLVED');
      const names = result.nodes.map((n) => n.displayName);
      assert.ok(names.includes('PaymentService.process()'), 'instance call resolves into the imported class');
      const first = result.nodes[0];
      assert.strictEqual(first.kind, 'METHOD');
      assert.strictEqual(first.languageKind, 'TS');
      assert.ok(first.filePath.includes('services.ts'));
      // A service with public methods is not a pure DTO.
      assert.strictEqual(result.models.length, 0);

      // The service method itself expands: process() -> PaymentService.helper() at depth 3.
      assert.strictEqual(result.nodes.length, 2);
      assert.ok(names.includes('PaymentService.helper()'));
    });

    test('imported class method called via instance resolves, service is not a model', () => {
      // Mirrors the JetBrains fixture: `svc.helper()` inside `process()` resolves into the class.
      const runner = [
        "import { PaymentService } from './services';",
        '',
        'export function run() {',
        '  const svc = new PaymentService();',
        '  return svc.helper();',
        '}',
      ].join('\n');
      const extractor = makeExtractor(
        new Map<string, string>([
          ['/proj/services.js', SERVICE_SOURCE],
          ['/proj/runner.js', runner],
        ])
      );

      return extractor.extractFlow({
        document: makeDocument('/proj/runner.js', runner, 'javascript'),
        position: positionAt(runner, 'run() {'),
        maxDepth: 3,
        includeModels: true,
      }).then((result) => {
        assert.ok(result);
        assert.strictEqual(result.nodes.length, 1);
        assert.strictEqual(result.nodes[0].displayName, 'PaymentService.helper()');
        assert.strictEqual(result.nodes[0].kind, 'METHOD');
        assert.ok(result.nodes[0].filePath.includes('services.js'));
        assert.strictEqual(result.models.length, 0);
      });
    });

    test('module-level call with no function at the caret uses the module scope', async () => {
      const source = [
        'startBilling();',
        '',
        'export function run() {',
        '  return 1;',
        '}',
      ].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.js', source]]));

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/app.js', source, 'javascript'),
        position: { line: 0, character: 0 } as vscode.Position,
        maxDepth: 1,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'module()');
      assert.strictEqual(result.nodes.length, 1);
      assert.strictEqual(result.nodes[0].displayName, 'startBilling()');
      assert.strictEqual(result.nodes[0].resolutionStatus, 'UNRESOLVED');
    });

    test('self-recursion is skipped by the cycle guard', async () => {
      const source = [
        'export function a() {',
        '  return a();',
        '}',
        '',
        'export function b() {',
        '  return b();',
        '}',
      ].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.ts', source]]));

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/app.ts', source, 'typescript'),
        position: positionAt(source, 'a() {'),
        maxDepth: 3,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'a()');
      assert.strictEqual(result.nodes.length, 0, 'self recursion must not produce a node');
    });

    test('depth limit caps the expanded chain', async () => {
      const source = [
        'export function a() { return b(); }',
        'export function b() { return c(); }',
        'export function c() { return d(); }',
        'export function d() { return 1; }',
      ].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.ts', source]]));

      const depth2 = (await extractor.extractFlow({
        document: makeDocument('/proj/app.ts', source, 'typescript'),
        position: positionAt(source, 'a() {'),
        maxDepth: 2,
        includeModels: false,
      })) as FlowResult;
      assert.deepStrictEqual(
        depth2.nodes.map((n) => n.displayName),
        ['b()', 'c()']
      );

      const depth0 = (await extractor.extractFlow({
        document: makeDocument('/proj/app.ts', source, 'typescript'),
        position: positionAt(source, 'a() {'),
        maxDepth: 0,
        includeModels: false,
      })) as FlowResult;
      assert.strictEqual(depth0.nodes.length, 0, 'maxDepth 0 extracts the root only');
    });

    test('cross-file function resolves through import and module function tier', async () => {
      const runner = [
        "import { sendNotification } from './notifications';",
        '',
        'export function run() {',
        '  sendNotification({ id: 1 });',
        '}',
      ].join('\n');
      const notifications = [
        'export function sendNotification(payload) {',
        '  return payload;',
        '}',
      ].join('\n');
      const extractor = makeExtractor(
        new Map<string, string>([
          ['/proj/notifications.ts', notifications],
          ['/proj/runner.ts', runner],
        ])
      );

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/runner.ts', runner, 'typescript'),
        position: positionAt(runner, 'run() {'),
        maxDepth: 2,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'run()');
      assert.deepStrictEqual(
        result.nodes.map((n) => n.displayName),
        ['sendNotification(payload)'],
        'imported function resolves into notifications.ts'
      );
      assert.strictEqual(result.nodes[0].resolutionStatus, 'RESOLVED');
      assert.ok(result.nodes[0].filePath.includes('notifications.ts'));
    });

    test('pure DTO class is collected as a model; service with methods is not', async () => {
      const dtoSource = [
        'export class UserRequest {',
        '  constructor(name) {',
        '    this.name = name;',
        '  }',
        '}',
      ].join('\n');
      const runner = [
        "import { PaymentService } from './services';",
        "import { UserRequest } from './repositories';",
        '',
        'export function run() {',
        '  const payload = new UserRequest("alice");',
        '  const svc = new PaymentService();',
        '  return svc.helper();',
        '}',
      ].join('\n');
      const files = new Map<string, string>([
        ['/proj/runner.ts', runner],
        ['/proj/services.ts', SERVICE_SOURCE],
        ['/proj/repositories.ts', dtoSource],
      ]);
      const extractor = makeExtractor(files);

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/runner.ts', runner, 'typescript'),
        position: positionAt(runner, 'run() {'),
        maxDepth: 3,
        includeModels: true,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.models.length, 1);
      assert.strictEqual(result.models[0].displayName, 'UserRequest');
      assert.strictEqual(result.models[0].kind, 'MODEL');
      assert.ok(result.models[0].filePath.includes('repositories.ts'));
      assert.ok(result.models[0].code.includes('class UserRequest'));
    });

    test('unresolved project calls stay, built-ins are filtered', async () => {
      // `logEvent` has no declaration anywhere and must stay UNRESOLVED; console.log / fetch are
      // host globals, `users.map` / `label.trim` are platform prototype calls and `setTimeout` is
      // a bare function global - none are dependencies at all.
      const source = [
        'export function run() {',
        '  logEvent({ id: 1 });',
        '  console.log("logged");',
        '  fetch("/api");',
        '  const users = [{ name: "a" }];',
        '  users.map((u) => u.name);',
        '  const label = "  x  ";',
        '  label.trim();',
        '  setTimeout(() => {}, 10);',
        '  return 1;',
        '}',
      ].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.js', source]]));

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/app.js', source, 'javascript'),
        position: positionAt(source, 'run() {'),
        maxDepth: 2,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'run()');
      assert.deepStrictEqual(
        result.nodes.map((n) => n.displayName),
        ['logEvent()'],
        'a genuinely unresolved project call stays; host globals, prototype methods and ' +
          'bare function globals are noise'
      );
      assert.strictEqual(result.nodes[0].resolutionStatus, 'UNRESOLVED');
    });

    test('a user method named like a prototype method still resolves through the declared type', async () => {
      // `transform.map` is a real project method; resolution runs before the noise gate, so the
      // fact that `map` is also a stdlib prototype name must not swallow the call.
      const source = [
        'export class Pipeline {',
        '  map(entry) {',
        '    return entry;',
        '  }',
        '}',
        '',
        'export function run() {',
        '  const transform = new Pipeline();',
        '  return transform.map("x");',
        '}',
      ].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.ts', source]]));

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/app.ts', source, 'typescript'),
        position: positionAt(source, 'run() {'),
        maxDepth: 2,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'run()');
      assert.deepStrictEqual(
        result.nodes.map((n) => n.displayName),
        ['Pipeline.map(entry)'],
        'the prototype-name gate never shadows a real user method - resolution runs first'
      );
      assert.strictEqual(result.nodes[0].resolutionStatus, 'RESOLVED');
    });

    test('builtin method names on unresolved qualifiers are filtered, not kept', async () => {
      // `client.get`, `repo.delete`, `store.set` name standard Map/Set methods; with no
      // declaration anywhere in the project they are prototype noise and must NOT appear
      // as dependency nodes. A real project declaration rescues them (see the declared-
      // resolution test below).
      const source = [
        'export function run() {',
        '  client.get("/users");',
        '  repo.delete(1);',
        '  store.set("k", "v");',
        '  return 1;',
        '}',
      ].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.js', source]]));

      return extractor.extractFlow({
        document: makeDocument('/proj/app.js', source, 'javascript'),
        position: positionAt(source, 'run() {'),
        maxDepth: 2,
        includeModels: false,
      }).then((result) => {
        assert.ok(result);
        assert.deepStrictEqual(
          result.nodes.map((n) => n.displayName),
          [],
          'unresolved calls naming stdlib methods (get/delete/set) are ecosystem noise'
        );
      });
    });

    test('a project-declared method named like a builtin still resolves (set/toString)', async () => {
      // Resolution runs before the noise gate: `Cache.set` and `User.toString` are real project
      // methods, so they stay as RESOLVED dependencies even though `set`/`toString` are builtin
      // names; `db#set`-style unresolved sites with NO declaration stay filtered.
      const cache = [
        'export class Cache {',
        '  set(key, value) {',
        '    return value;',
        '  }',
        '}',
      ].join('\n');
      const source = [
        "import { Cache } from './cache';",
        '',
        'export class User {',
        '  toString() {',
        '    return "user";',
        '  }',
        '}',
        '',
        'export function run() {',
        '  const cache = new Cache();',
        '  cache.set("k", 1);',
        '  const user = new User();',
        '  user.toString();',
        '  db.set("x", 2);',
        '  return 1;',
        '}',
      ].join('\n');
      const extractor = makeExtractor(
        new Map<string, string>([
          ['/proj/app.ts', source],
          ['/proj/cache.ts', cache],
        ])
      );

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/app.ts', source, 'typescript'),
        position: positionAt(source, 'run() {'),
        maxDepth: 2,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.deepStrictEqual(
        result.nodes.map((n) => n.displayName),
        ['Cache.set(key, value)', 'User.toString()'],
        'project declarations win over builtin names; unresolved db.set is filtered'
      );
      assert.ok(
        result.nodes.every((n) => n.resolutionStatus === 'RESOLVED'),
        'only genuinely resolved calls become dependencies'
      );
    });

    test('chain via this-field imports forms nothing extra; models stay exact', async () => {
      // `this.userService.registerUser()` in a controller resolves through the imported class.
      const controller = [
        "import { UserService } from './services';",
        '',
        'export class UserController {',
        '  constructor() {',
        '    this.userService = new UserService();',
        '  }',
        '',
        '  createUser() {',
        '    return this.userService.registerUser("alice");',
        '  }',
        '}',
      ].join('\n');
      const services = [
        "import { UserRepository } from './repositories';",
        "import { User } from './repositories';",
        '',
        'export class UserService {',
        '  registerUser(username) {',
        '    const user = new User(username);',
        '    return user;',
        '  }',
        '}',
      ].join('\n');
      const repositories = [
        'export class User {',
        '  constructor(username) {',
        '    this.username = username;',
        '  }',
        '}',
      ].join('\n');
      const files = new Map<string, string>([
        ['/proj/apps/users/controller.ts', controller],
        ['/proj/apps/users/services.ts', services],
        ['/proj/apps/users/repositories.ts', repositories],
      ]);
      const extractor = makeExtractor(files);

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/apps/users/controller.ts', controller, 'typescript'),
        position: positionAt(controller, 'createUser()'),
        maxDepth: 3,
        includeModels: true,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'UserController.createUser()');

      const names = result.nodes.map((n) => n.displayName);
      assert.ok(names.includes('UserService.registerUser(username)'), 'controller -> service');

      const modelNames = result.models.map((m) => m.displayName);
      assert.deepStrictEqual(modelNames, ['User'], 'only the pure DTO is a model');
      assert.ok(result.models[0].filePath.includes('repositories.ts'));
    });

    test('JSX component file extracts from a function declared in a .jsx file', async () => {
      const source = [
        "import { PaymentService } from './services';",
        '',
        'export function App() {',
        '  const svc = new PaymentService();',
        '  return svc.helper();',
        '}',
      ].join('\n');
      const extractor = makeExtractor(
        new Map<string, string>([
          ['/proj/services.js', SERVICE_SOURCE],
          ['/proj/App.jsx', source],
        ])
      );

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/App.jsx', source, 'javascriptreact'),
        position: positionAt(source, 'App() {'),
        maxDepth: 2,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'App()');
      assert.strictEqual(result.root.languageKind, 'JSX');
      assert.strictEqual(result.nodes.length, 1);
      assert.strictEqual(result.nodes[0].displayName, 'PaymentService.helper()');
    });

    test('markdown.md contract is produced for a TS flow', async () => {
      const runner = [
        "import { PaymentService } from './services';",
        "import { UserRequest } from './repositories';",
        '',
        'export function run() {',
        '  const payload = new UserRequest("alice");',
        '  const svc = new PaymentService();',
        '  return svc.helper();',
        '}',
      ].join('\n');
      const dtoSource = [
        'export class UserRequest {',
        '  constructor(name) {',
        '    this.name = name;',
        '  }',
        '}',
      ].join('\n');
      const secondDtoSource = [
        'export class AuditLog {',
        '  constructor(entry) {',
        '    this.entry = entry;',
        '  }',
        '}',
      ].join('\n');
      const runnerWithAudit = [
        "import { PaymentService } from './services';",
        "import { UserRequest } from './repositories';",
        "import { AuditLog } from './audit';",
        '',
        'export function run() {',
        '  const payload = new UserRequest("alice");',
        '  const log = new AuditLog("created");',
        '  const svc = new PaymentService();',
        '  return svc.helper();',
        '}',
      ].join('\n');
      const extractor = makeExtractor(
        new Map<string, string>([
          ['/proj/runner.ts', runnerWithAudit],
          ['/proj/services.ts', SERVICE_SOURCE],
          ['/proj/repositories.ts', dtoSource],
          ['/proj/audit.ts', secondDtoSource],
        ])
      );
      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/runner.ts', runnerWithAudit, 'typescript'),
        position: positionAt(runnerWithAudit, 'run() {'),
        maxDepth: 2,
        includeModels: true,
      })) as FlowResult;
      assert.ok(result);

      const md = formatFlow(result, 'markdown');
      assert.ok(md.includes('# Context Flow Extracted by Bisotun'), 'summary header');
      assert.ok(md.includes('- Root Target: `run`'), 'root target');
      assert.ok(md.includes('- Extracted Nodes: 2'), 'root + helper');
      assert.ok(md.includes('- Extracted Models: 2'), 'two imported pure DTO models');
      assert.ok(md.includes('## Root Method'), 'root method section');
      assert.ok(md.includes('## Execution Dependencies'), 'dependencies section');
      assert.ok(
        (md.match(/## Related Data Models \(DTOs \/ Projections \/ Records\)/g) ?? []).length === 1,
        'the models section header is emitted exactly once'
      );
      assert.ok(md.includes('### Model: `UserRequest`'), 'first model header');
      assert.ok(md.includes('### Model: `AuditLog`'), 'second model header');
      assert.ok(md.includes('```typescript'), 'typescript code fence');
    });

    test('caret scope resolution gates the module scope on real content', () => {
      const outline = parseJsOutline('// nothing here');
      const scope = resolveScope(outline, 0);
      assert.strictEqual(scope, undefined, 'an empty file has no module scope');

      const withContent = parseJsOutline('startBilling();');
      const moduleScope = resolveScope(withContent, 0);
      assert.ok(moduleScope);
      assert.strictEqual(moduleScope.displayName, 'module()');
    });
  });
});
