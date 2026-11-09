import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

import { FlowResult } from '../core/types';
import { PythonAnalysisContext } from '../language/python/pythonAnalysisContext';
import {
  parsePythonOutline,
  PythonCallSite,
  PythonFileOutline,
} from '../language/python/pythonFileOutline';
import { PythonCallResolver } from '../language/python/pythonCallResolver';
import { PythonFlowExtractor } from '../language/pythonFlowExtractor';
import { formatFlow } from '../utils/formatter';

/**
 * Python flow extractor: hermetic tests.
 *
 * The extractor's disk context is replaced by an in-memory map and no real
 * workspace/document is opened, so the whole tokenizer tier (outline, resolver,
 * BFS flow) runs without a Python language server or files. The cases mirror the
 * JetBrains `PythonFlowExtractorTest` (outline discovery, caret scope, module vs
 * function call listing, chain collapse, resolver tiers, cross-file imports and
 * the stdlib suppression that keeps `import json` unresolved).
 */

const SERVICE_SOURCE = [
  'class PaymentService:',
  '    def helper(self):',
  '        return 1',
  '',
  '    def process(self):',
  '        total = payment.amount',
  '        value = self.helper()',
  '        return total + value',
].join('\n');

const MODULE_SOURCE = [
  'start_billing()',
  '',
  'def run():',
  '    return helper()',
  '',
  'def helper():',
  '    return 1',
].join('\n');

/** `PythonAnalysisContext` sealed to an in-memory file map (POSIX paths, no disk). */
class InMemoryPythonContext extends PythonAnalysisContext {
  private readonly files: Map<string, string>;
  readonly workspaceRoot = '/proj';

  constructor(files: Map<string, string>) {
    super({
      workspaceRoot: '/proj',
      textReader: (filePath) => files.get(filePath),
      openSourceReader: (filePath) => files.get(filePath),
    });
    this.files = files;
  }

  override resolveSpecifier(fromFile: string, specifier: string): string | undefined {
    const normalized = specifier.replace(/^\.+/, '');
    if (normalized.length === 0) return undefined;
    const baseSegments = normalized.split('.');
    const fromDir = path.posix.dirname(fromFile);
    const candidates: string[] = [];
    if (specifier.startsWith('.')) {
      candidates.push(path.posix.join(fromDir, ...baseSegments));
    } else {
      candidates.push(path.posix.join(this.workspaceRoot, ...baseSegments));
      candidates.push(path.posix.join(fromDir, ...baseSegments));
    }
    for (const candidate of candidates) {
      const resolved = this.firstInMemory(candidate);
      if (resolved) return resolved;
    }
    return undefined;
  }

  private firstInMemory(modulePath: string): string | undefined {
    for (const extension of ['.py', '.pyi', '.pyw']) {
      const file = `${modulePath}${extension}`;
      if (this.files.has(file)) return file;
    }
    const initFile = path.posix.join(modulePath, '__init__.py');
    return this.files.has(initFile) ? initFile : undefined;
  }
}

function makeExtractor(files: Map<string, string>): PythonFlowExtractor {
  const context = new InMemoryPythonContext(files);
  return new PythonFlowExtractor(() => context);
}

function sourceFor(outline: PythonFileOutline, text: string, filePath = '/proj/app.py') {
  return { filePath, text, outline };
}

function makeDocument(fileName: string, text: string): vscode.TextDocument {
  const lines = text.split('\n');
  const uri = { scheme: 'file', path: fileName, fsPath: fileName } as vscode.Uri;
  return {
    languageId: 'python',
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

/** Line/character of the start of `needle`. */
function positionOf(text: string, needle: string): vscode.Position {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `needle not found in fixture: ${needle}`);
  let line = 0;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return { line, character: index - lineStart } as vscode.Position;
}

suite('PythonFlowExtractor', () => {
  const resolver = new PythonCallResolver();

  test('outline discovers module functions and class methods in source order', () => {
    const outline = parsePythonOutline(SERVICE_SOURCE);
    assert.deepStrictEqual(
      outline.functions.map((fn) => fn.name),
      ['helper', 'process']
    );
    assert.deepStrictEqual(
      outline.types.map((type) => type.name),
      ['PaymentService']
    );
  });

  test('innermost function wins at the caret and class methods are METHODS', () => {
    const outline = parsePythonOutline(SERVICE_SOURCE);

    const insideBody = outline.functionContaining(SERVICE_SOURCE.indexOf('payment.amount'));
    assert.ok(insideBody, 'caret inside a method body resolves to that method');
    assert.strictEqual(insideBody.name, 'process');
    assert.strictEqual(insideBody.kind, 'METHOD');

    const atDef = outline.functionContaining(SERVICE_SOURCE.indexOf('def process'));
    assert.strictEqual(atDef?.name, 'process');
  });

  test('module scope lists its own calls only (nested function bodies are skipped)', () => {
    const outline = parsePythonOutline(MODULE_SOURCE);
    const moduleCalls = outline.callSitesIn(0, MODULE_SOURCE.length);
    assert.deepStrictEqual(
      moduleCalls.map((site) => site.rawText),
      ['start_billing']
    );
  });

  test('function scope collapses member call chains to the last segment', () => {
    const outline = parsePythonOutline(SERVICE_SOURCE);
    const process = outline.functionNamed('process');
    assert.ok(process);

    const calls = outline.callSitesIn(process.startOffset, process.endOffset);
    assert.strictEqual(calls.length, 1);
    const site = calls[0];
    assert.strictEqual(site.name, 'helper');
    assert.strictEqual(site.qualifier, 'self');
    assert.strictEqual(site.rootIdentifier, 'self');
    assert.strictEqual(site.rawText, 'self.helper');
  });

  test('same-file plain call resolves to the local function', () => {
    const outline = parsePythonOutline(MODULE_SOURCE);
    const source = sourceFor(outline, MODULE_SOURCE);
    const site: PythonCallSite = {
      name: 'helper',
      qualifier: null,
      rootIdentifier: 'helper',
      offset: MODULE_SOURCE.indexOf('helper()'),
      rawText: 'helper()',
    };

    const resolved = resolver.resolve(source, site, () => undefined);
    assert.ok(resolved);
    assert.strictEqual(resolved.definition.name, 'helper');
    assert.strictEqual(resolved.source.filePath, '/proj/app.py');
  });

  test('self method call resolves to the class method in the same file', () => {
    const outline = parsePythonOutline(SERVICE_SOURCE);
    const source = sourceFor(outline, SERVICE_SOURCE, '/proj/services.py');
    const process = outline.functionNamed('process');
    assert.ok(process);
    const site: PythonCallSite = {
      name: 'helper',
      qualifier: 'self',
      rootIdentifier: 'self',
      offset: SERVICE_SOURCE.indexOf('self.helper()'),
      rawText: 'self.helper()',
    };

    const resolved = resolver.resolve(source, site, () => undefined);
    assert.ok(resolved);
    assert.strictEqual(resolved.definition.name, 'helper');
    assert.strictEqual(resolved.definition.kind, 'METHOD');
  });

  test('self.<field>.<method> resolves through the field declared type (name unrelated to the class)', () => {
    // `wallet` has no textual relation to `BillingGateway`: without the declared-type tier this
    // resolves nothing (or only by name guessing), with it the field annotation tells us the method
    // lives on `BillingGateway`. The gateway's `__init__` type is `gateway` (also unrelated), so the
    // whole chain is proven through declarations, not names.
    const controller = [
      'from .billing import BillingGateway',
      '',
      'class BillingController:',
      '    def __init__(self):',
      '        self.wallet = BillingGateway()',
      '',
      '    def pay(self):',
      '        self.wallet.charge("card")',
    ].join('\n');
    const billing = [
      'class BillingGateway:',
      '    def __init__(self):',
      '        self.gateway = PaymentConnector()',
      '',
      '    def charge(self, method):',
      '        self.gateway.run(method)',
    ].join('\n');
    const connector = [
      'class PaymentConnector:',
      '    def run(self, method):',
      '        return method',
    ].join('\n');
    const files = new Map<string, string>([
      ['/proj/billing.py', billing],
      ['/proj/controller.py', controller],
      ['/proj/connector.py', connector],
    ]);
    const context = new InMemoryPythonContext(files);
    const source = context.sourceForFileAsSource('/proj/controller.py');
    assert.ok(source);
    const site: PythonCallSite = {
      name: 'charge',
      qualifier: 'wallet',
      rootIdentifier: 'self',
      offset: controller.indexOf('self.wallet.charge'),
      rawText: 'self.wallet.charge',
    };

    const resolved = resolver.resolve(source, site, (from, specifier) => {
      const targetPath = context.resolveSpecifier(from.filePath, specifier);
      return targetPath ? context.sourceForFileAsSource(targetPath) : undefined;
    });

    assert.ok(resolved, 'field typed via __init__ resolves through its declared type');
    assert.strictEqual(resolved.definition.name, 'charge');
    assert.ok(resolved.source.filePath.includes('billing.py'));
  });

  test('from relative import resolves a method in another file', () => {
    const files = new Map<string, string>([
      ['/proj/services.py', SERVICE_SOURCE],
      [
        '/proj/runner.py',
        [
          'from .services import PaymentService',
          '',
          'def run():',
          '    svc = PaymentService()',
          '    svc.helper()',
        ].join('\n'),
      ],
    ]);
    const context = new InMemoryPythonContext(files);
    const source = context.sourceForFileAsSource('/proj/runner.py');
    assert.ok(source);
    const site: PythonCallSite = {
      name: 'helper',
      qualifier: 'svc',
      rootIdentifier: 'svc',
      offset: files.get('/proj/runner.py')!.indexOf('svc.helper()'),
      rawText: 'svc.helper()',
    };

    const resolved = resolver.resolve(source, site, (from, specifier) => {
      const targetPath = context.resolveSpecifier(from.filePath, specifier);
      return targetPath ? context.sourceForFileAsSource(targetPath) : undefined;
    });

    assert.ok(resolved);
    assert.strictEqual(resolved.definition.name, 'helper');
    assert.strictEqual(resolved.source.filePath, '/proj/services.py');
  });

  test('unresolvable member call stays unresolved instead of inventing a target', () => {
    const outline = parsePythonOutline(SERVICE_SOURCE);
    const source = sourceFor(outline, SERVICE_SOURCE, '/proj/services.py');
    const site: PythonCallSite = {
      name: 'fetch',
      qualifier: 'external_client',
      rootIdentifier: 'external_client',
      offset: SERVICE_SOURCE.indexOf('external_client'),
      rawText: 'external_client.fetch()',
    };
    const resolved = resolver.resolve(source, site, () => undefined);
    assert.strictEqual(resolved, undefined);
  });

  test('stdlib imports stay unresolved (json is suppressed by the context)', () => {
    const context = new InMemoryPythonContext(new Map());
    assert.strictEqual(context.resolveSpecifier('/proj/runner.py', 'json'), undefined);
  });

  suite('extractFlow', () => {
    const filesFor = (runner: string, services = SERVICE_SOURCE) =>
      new Map<string, string>([
        ['/proj/runner.py', runner],
        ['/proj/services.py', services],
      ]);

    test('resolves a cross-file method but does not collect a service with public methods as a model', async () => {
      const runner = [
        'from .services import PaymentService',
        '',
        'def run():',
        '    svc = PaymentService()',
        '    svc.helper()',
      ].join('\n');
      const extractor = makeExtractor(filesFor(runner));

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/runner.py', runner),
        position: positionOf(runner, 'def run'),
        maxDepth: 1,
        includeModels: true,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'run()');
      assert.strictEqual(result.root.resolutionStatus, 'RESOLVED');
      assert.strictEqual(result.nodes.length, 1);
      assert.strictEqual(result.nodes[0].displayName, 'PaymentService.helper()');
      assert.strictEqual(result.nodes[0].resolutionStatus, 'RESOLVED');
      assert.strictEqual(result.nodes[0].kind, 'METHOD');
      assert.strictEqual(result.nodes[0].languageKind, 'PYTHON');
      assert.ok(result.nodes[0].filePath.includes('services.py'));

      assert.strictEqual(result.models.length, 0, 'a service with public methods is not a pure DTO');
    });

    test('a pure DTO class is collected as a model', async () => {
      const dtoSource = [
        'class UserRequest:',
        '    def __init__(self, name):',
        '        self.name = name',
      ].join('\n');
      const runner = [
        'from .services import PaymentService',
        'from .repositories import UserRequest',
        '',
        'def run():',
        '    payload = UserRequest("alice")',
        '    svc = PaymentService()',
        '    svc.helper()',
      ].join('\n');
      const extractor = makeExtractor(
        new Map<string, string>([
          ['/proj/runner.py', runner],
          ['/proj/services.py', SERVICE_SOURCE],
          ['/proj/repositories.py', dtoSource],
        ])
      );

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/runner.py', runner),
        position: positionOf(runner, 'def run'),
        maxDepth: 1,
        includeModels: true,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.models.length, 1);
      assert.strictEqual(result.models[0].displayName, 'UserRequest');
      assert.strictEqual(result.models[0].kind, 'MODEL');
      assert.ok(result.models[0].filePath.includes('repositories.py'));
      assert.ok(result.models[0].code.includes('class UserRequest'));
    });

    test('self-attribute chains across four files form a nested tree and collect only the pure DTO model', async () => {
      // Controller and service own `self.user_service` / `self.repo`; both resolve through the
      // declared-type tier (field -> `UserService` / `UserRepository`, no reliance on the fuzzy
      // name-score match). `UserService` / `UserRepository` are services, not models: they carry
      // public methods plus call sites, so the new `collectModels` gates keep exactly the pure
      // `User` DTO.
      const controller = [
        'from .services import UserService',
        '',
        'class UserController:',
        '    def create_user_endpoint(self):',
        '        self.user_service = UserService()',
        "        self.user_service.register_user('alice')",
      ].join('\n');
      const services = [
        'from .repositories import UserRepository',
        'from .repositories import User',
        'from .utils import normalize_username',
        'from .notifications import send_welcome_email',
        '',
        'class UserService:',
        '    def register_user(self, username):',
        '        self.repo = UserRepository()',
        '        normalized = normalize_username(username)',
        '        user = User(normalized)',
        '        send_welcome_email(user)',
        '        self.repo.save(user)',
      ].join('\n');
      const repositories = [
        'class User:',
        '    def __init__(self, username):',
        '        self.username = username',
        '',
        'class UserRepository:',
        '    def save(self, user):',
        '        return user',
      ].join('\n');
      const utils = [
        'def normalize_username(name):',
        '    return name.strip()',
      ].join('\n');
      const notifications = [
        'def send_welcome_email(user):',
        '    return None',
      ].join('\n');
      const files = new Map<string, string>([
        ['/proj/apps/users/api.py', controller],
        ['/proj/apps/users/services.py', services],
        ['/proj/apps/users/repositories.py', repositories],
        ['/proj/apps/users/utils.py', utils],
        ['/proj/apps/users/notifications.py', notifications],
      ]);
      const extractor = makeExtractor(files);

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/apps/users/api.py', controller),
        position: positionOf(controller, 'def create_user_endpoint'),
        maxDepth: 3,
        includeModels: true,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'UserController.create_user_endpoint()');
      assert.strictEqual(result.root.resolutionStatus, 'RESOLVED');

      assert.ok(
        result.nodes.map((node) => node.displayName).includes('UserService.register_user()'),
        'controller self.user_service.register_user() resolves into the service'
      );
      const serviceNode = result.nodes.find((node) => node.displayName === 'UserService.register_user()');
      assert.ok(serviceNode, 'service node present');
      assert.ok(serviceNode!.filePath.includes('apps/users/services.py'));

      assert.ok(
        result.nodes.map((node) => node.displayName).includes('UserRepository.save()'),
        'service self.repo.save() resolves into the repository'
      );
      const repoNode = result.nodes.find((node) => node.displayName === 'UserRepository.save()');
      assert.ok(repoNode, 'repository node present');
      assert.ok(repoNode!.filePath.includes('apps/users/repositories.py'));

      const modelNames = result.models.map((model) => model.displayName);
      assert.deepStrictEqual(
        modelNames,
        ['User'],
        'only the pure DTO is collected; services and repositories are not models'
      );
      const userModel = result.models[0];
      assert.strictEqual(userModel.kind, 'MODEL');
      assert.ok(userModel.filePath.includes('apps/users/repositories.py'));
      assert.ok(userModel.code.includes('class User'));
    });

    test('real controller fixture: multi-line signature, __init__-assigned fields, param-typed repo, and User model', async () => {
      // Mirrors /home/farzadafi/PycharmProjects/python: a controller whose method signature spans
      // multiple physical lines, a service field assigned in `__init__` (self.userService), a
      // repository field copied from an `__init__` parameter annotation (self.repo = repo:
      // UserRepository), a subpackage util (utils.mailer), and a pure DTO `User` instantiated in
      // the service. The caret sits on the multi-line `def` header and must resolve to exactly
      // that method - never to the class body or to `__init__`.
      const controller = [
        'from service import UserService',
        'from repository import UserRepository',
        '',
        '',
        'class UserController:',
        '    def __init__(self):',
        '        repo = UserRepository()',
        '        self.userService = UserService(repo)',
        '',
        '    def create_user_endpoint(',
        '        self, user_id: int, username: str, email: str, name: str',
        '    ):',
        '        return self.userService.register_user(user_id, username, email, name)',
        '',
        '',
        'def test_call():',
        '    return UserController().create_user_endpoint(',
        '        1, " Alice ", "alice@example.com", "Alice"',
        '    )',
      ].join('\n');
      const service = [
        'import json',
        'import uuid',
        '',
        'from repository import UserRepository, User',
        'from utils.mailer import send_welcome_email',
        '',
        '',
        'def normalize_username(raw: str) -> str:',
        '    return raw.strip().lower()',
        '',
        '',
        'class UserService:',
        '    def __init__(self, repo: UserRepository):',
        '        self.repo = repo',
        '',
        '    def register_user(',
        '        self, user_id: int, username: str, email: str, name: str',
        '    ) -> User:',
        '        normalized_username = normalize_username(username)',
        '',
        '        user = User(',
        '            user_id=user_id,',
        '            username=normalized_username,',
        '            email=email,',
        '            name=name,',
        '        )',
        '',
        '        trace_id = str(uuid.uuid4())',
        '        payload = json.dumps({',
        '            "user_id": user.user_id,',
        '            "entity_type": user.entity_type,',
        '            "trace_id": trace_id,',
        '        })',
        '        send_welcome_email(email, payload)',
        '',
        '        return self.repo.save(user)',
        '',
        '    def get_user_profile(self, user_id: int) -> User:',
        '        user = self.repo.find_by_id(user_id)',
        '        if not user:',
        '            raise ValueError(f"User with ID {user_id} not found")',
        '        return user',
      ].join('\n');
      const repository = [
        'from typing import Dict, Optional',
        '',
        '',
        'class User:',
        '    entity_type = "user"  # Class attribute',
        '',
        '    def __init__(self, user_id: int, username: str, email: str, name: str):',
        '        self.user_id = user_id',
        '        self.username = username',
        '        self.email = email',
        '        self.name = name',
        '',
        '',
        'class UserRepository:',
        '    def __init__(self):',
        '        self._db: Dict[int, User] = {}',
        '',
        '    def find_by_id(self, user_id: int) -> Optional[User]:',
        '        return self._db.get(user_id)',
        '',
        '    def save(self, user: User) -> User:',
        '        self._db[user.user_id] = user',
        '        return user',
      ].join('\n');
      const mailer = [
        'def send_welcome_email(email: str, payload: str) -> bool:',
        '    # Stub for flow testing; no email is actually sent.',
        '    return True',
      ].join('\n');
      const files = new Map<string, string>([
        ['/proj/controller.py', controller],
        ['/proj/service.py', service],
        ['/proj/repository.py', repository],
        ['/proj/utils/mailer.py', mailer],
      ]);
      const extractor = makeExtractor(files);

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/controller.py', controller),
        position: positionOf(controller, 'def create_user_endpoint'),
        maxDepth: 3,
        includeModels: true,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'UserController.create_user_endpoint()');
      assert.strictEqual(result.root.resolutionStatus, 'RESOLVED');
      assert.strictEqual(result.root.kind, 'METHOD');
      assert.strictEqual(result.root.range.startLine, 10);
      assert.strictEqual(result.root.range.endLine, 13, 'multi-line def body ends at line 13');

      const names = result.nodes.map((node) => node.displayName);
      assert.ok(names.includes('UserService.register_user()'), 'controller -> service via __init__ field');
      assert.ok(names.includes('normalize_username()'), 'service -> module function');
      assert.ok(names.includes('send_welcome_email()'), 'service -> utils.mailer subpackage function');
      assert.ok(names.includes('UserRepository.save()'), 'service -> repository via __init__ param-typed field');

      const mailerNode = result.nodes.find((node) => node.displayName === 'send_welcome_email()');
      assert.ok(mailerNode);
      assert.ok(mailerNode!.filePath.includes('utils/mailer.py'), 'send_welcome_email lives in utils/mailer.py');

      const modelNames = result.models.map((model) => model.displayName);
      assert.deepStrictEqual(modelNames, ['User'], 'User is the only pure DTO in the flow');
      const userModel = result.models[0];
      assert.ok(userModel.code.includes('class User'));
      assert.ok(userModel.filePath.includes('repository.py'));
    });

    test('self-recursion is skipped by the cycle guard', async () => {
      const source = ['def a():', '    return a()', '', 'def b():', '    return b()'].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.py', source]]));

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/app.py', source),
        position: positionOf(source, 'def a'),
        maxDepth: 3,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'a()');
      assert.strictEqual(result.nodes.length, 0, 'self recursion must not produce a node');
    });

    test('depth limit caps the expanded chain', async () => {
      const source = [
        'def a():',
        '    return b()',
        '',
        'def b():',
        '    return c()',
        '',
        'def c():',
        '    return d()',
        '',
        'def d():',
        '    return 1',
      ].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.py', source]]));

      const depth2 = (await extractor.extractFlow({
        document: makeDocument('/proj/app.py', source),
        position: positionOf(source, 'def a'),
        maxDepth: 2,
        includeModels: false,
      })) as FlowResult;
      assert.deepStrictEqual(
        depth2.nodes.map((node) => node.displayName),
        ['b()', 'c()']
      );

      const depth0 = (await extractor.extractFlow({
        document: makeDocument('/proj/app.py', source),
        position: positionOf(source, 'def a'),
        maxDepth: 0,
        includeModels: false,
      })) as FlowResult;
      assert.strictEqual(depth0.nodes.length, 0, 'maxDepth 0 extracts the root only');
    });

    test('module-level call with no function at the caret uses the module scope', async () => {
      const source = ['start_billing()', '', 'def run():', '    return 1'].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.py', source]]));

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/app.py', source),
        position: { line: 0, character: 0 } as vscode.Position,
        maxDepth: 1,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'module()');
      assert.strictEqual(result.nodes.length, 1);
      assert.strictEqual(result.nodes[0].displayName, 'start_billing');
      assert.strictEqual(result.nodes[0].resolutionStatus, 'UNRESOLVED');
    });

    test('stdlib imports are filtered, unresolved project calls are kept', async () => {
      // `send_welcome_email` has no declaration in the workspace, so it stays UNRESOLVED - but it is
      // a project call, unlike `json.dumps` / `uuid.uuid4` which are stdlib by import and must not
      // appear as execution dependencies at all.
      const source = [
        'import json',
        'import uuid',
        '',
        'def run():',
        '    payload = json.dumps({"a": 1})',
        '    trace_id = str(uuid.uuid4())',
        '    send_welcome_email(payload)',
      ].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.py', source]]));

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/app.py', source),
        position: positionOf(source, 'def run'),
        maxDepth: 1,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'run()');
      assert.deepStrictEqual(
        result.nodes.map((node) => node.displayName),
        ['send_welcome_email'],
        'stdlib and builtin calls are filtered; a genuinely unresolved project call stays'
      );
      assert.strictEqual(result.nodes[0].resolutionStatus, 'UNRESOLVED');
    });

    test('builtins and primitive methods are filtered out of execution dependencies', async () => {
      const source = [
        'def run():',
        '    raw = "  alice  "',
        '    cleaned = raw.strip().lower()',
        '    parts = cleaned.split(",")',
        '    n = len(parts)',
        '    name = str(n)',
        '    print(name, parts)',
      ].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.py', source]]));

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/app.py', source),
        position: positionOf(source, 'def run'),
        maxDepth: 1,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'run()');
      assert.deepStrictEqual(
        result.nodes.map((node) => node.displayName),
        [],
        'builtins (len/str/print) and primitive/string methods (strip/lower/split) are not dependencies'
      );
    });

    test('from-import stdlib calls are filtered by their module root', async () => {
      const source = [
        'from uuid import uuid4',
        '',
        'def run():',
        '    trace_id = str(uuid4())',
      ].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.py', source]]));

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/app.py', source),
        position: positionOf(source, 'def run'),
        maxDepth: 1,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.deepStrictEqual(
        result.nodes.map((node) => node.displayName),
        [],
        'a from-import whose module is stdlib is noise, not an unresolved dependency'
      );
    });

    test('a user method named like a primitive method still resolves through the declared type', async () => {
      const source = [
        'class Greeter:',
        '    def strip(self, text):',
        '        return text',
        '',
        'class Runner:',
        '    def __init__(self):',
        '        self.greeter = Greeter()',
        '',
        '    def run(self):',
        '        return self.greeter.strip("x")',
      ].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.py', source]]));

      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/app.py', source),
        position: positionOf(source, 'def run'),
        maxDepth: 1,
        includeModels: false,
      })) as FlowResult;

      assert.ok(result);
      assert.deepStrictEqual(
        result.nodes.map((node) => node.displayName),
        ['Greeter.strip()'],
        'the noise filter never shadows a real user method - resolution runs first'
      );
      assert.strictEqual(result.nodes[0].resolutionStatus, 'RESOLVED');
    });

    test('the language kind falls back to the file extension (.pyw)', async () => {
      const source = ['def run():', '    return 1'].join('\n');
      const extractor = makeExtractor(new Map([['/proj/app.pyw', source]]));

      const result = await extractor.extractFlow({
        document: {
          ...makeDocument('/proj/app.pyw', source),
          languageId: 'plaintext',
        } as unknown as vscode.TextDocument,
        position: positionOf(source, 'def run'),
        maxDepth: 1,
        includeModels: false,
      });

      assert.ok(result);
      assert.strictEqual(result.root.displayName, 'run()');
    });

    test('the markdown.md contract is produced for a Python flow', async () => {
      const runner = [
        'from .services import PaymentService',
        'from .repositories import UserRequest',
        '',
        'def run():',
        '    payload = UserRequest("alice")',
        '    svc = PaymentService()',
        '    svc.helper()',
      ].join('\n');
      const dtoSource = [
        'class UserRequest:',
        '    def __init__(self, name):',
        '        self.name = name',
      ].join('\n');
      const extractor = makeExtractor(
        new Map<string, string>([
          ['/proj/runner.py', runner],
          ['/proj/services.py', SERVICE_SOURCE],
          ['/proj/repositories.py', dtoSource],
        ])
      );
      const result = (await extractor.extractFlow({
        document: makeDocument('/proj/runner.py', runner),
        position: positionOf(runner, 'def run'),
        maxDepth: 1,
        includeModels: true,
      })) as FlowResult;
      assert.ok(result);

      const md = formatFlow(result, 'markdown');
      assert.ok(md.includes('# Context Flow Extracted by Bisotun'), 'summary header');
      assert.ok(md.includes('- Root Target: `run`'), 'root target');
      assert.ok(md.includes('- Extracted Nodes: 2'), 'root + helper');
      assert.ok(md.includes('- Extracted Models: 1'), 'one imported pure DTO model');
      assert.ok(md.includes('## Root Method'), 'root method section');
      assert.ok(md.includes('## Execution Dependencies'), 'dependencies section');
      assert.ok(
        md.includes('## Related Data Models (DTOs / Projections / Records)'),
        'models section'
      );
      assert.ok(md.includes('### Model: `UserRequest`'), 'model header');
      assert.ok(md.includes('```python'), 'python code fence');
    });
  });
});
