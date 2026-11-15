import * as assert from 'assert';
import * as vscode from 'vscode';

import { FlowResult, languageKindInfo } from '../core/types';
import { CppAnalysisContext } from '../cpp/cppAnalysisContext';
import { parseCppOutline } from '../cpp/cppFileOutline';
import { CppFlowExtractor } from '../language/cppFlowExtractor';
import { detectLanguageKind } from '../language/languageKindDetector';
import { formatFlow } from '../utils/formatter';

/**
 * C++ flow extractor: hermetic tests.
 *
 * The extractor's disk context is replaced by an in-memory file map and no real workspace/document
 * is opened, so the whole tokenizer tier (tokenizer, outline, resolver, BFS flow) runs without a C++
 * language server or files on disk. `#include` resolution is mapped onto the same in-memory map.
 */

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

/** `CppAnalysisContext` sealed to an in-memory file map (POSIX paths, no disk). */
class InMemoryCppContext extends CppAnalysisContext {
  private readonly files: Map<string, string>;

  constructor(files: Map<string, string>) {
    super({
      workspaceRoot: '/proj',
      textReader: (filePath) => files.get(filePath),
      openSourceReader: (filePath) => files.get(filePath),
    });
    this.files = files;
  }

  override resolveInclude(
    fromFile: string,
    include: { specifier: string; isSystem: boolean }
  ): string | undefined {
    if (include.isSystem) {
      return undefined;
    }
    const slash = fromFile.lastIndexOf('/');
    const directory = slash >= 0 ? fromFile.slice(0, slash) : '/proj';
    const candidates = [
      `${directory}/${include.specifier}`,
      `/proj/${include.specifier}`,
      `/proj/include/${include.specifier}`,
      `/proj/src/${include.specifier}`,
    ];
    for (const candidate of candidates) {
      if (this.files.has(candidate)) {
        return candidate;
      }
    }
    for (const candidate of candidates) {
      for (const extension of ['h', 'hpp', 'hh', 'hxx', 'ipp', 'cpp']) {
        const file = `${candidate}.${extension}`;
        if (this.files.has(file)) {
          return file;
        }
      }
    }
    return undefined;
  }
}

function makeExtractor(files: Map<string, string>): CppFlowExtractor {
  const context = new InMemoryCppContext(files);
  return new CppFlowExtractor(() => context);
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
      for (let i = 0; i < p.line; i++) {
        offset += (lines[i] ?? '').length + 1;
      }
      return Math.min(offset + p.character, text.length);
    },
  } as unknown as vscode.TextDocument;
}

const FEATURE_SOURCE = [
  '#include "models/user.h"',
  '#include <vector>',
  '#include <string>',
  '',
  'namespace billing {',
  '',
  'template <typename T>',
  'struct Result : Base {',
  '  T value;',
  '  bool ok;',
  '};',
  '',
  'class PaymentService : public ServiceBase {',
  'public:',
  '  PaymentService(std::string name) : name_(std::move(name)) {}',
  '  ~PaymentService() {}',
  '  Result<int> process(const std::string& id, int count);',
  '  void notify() { helper(); }',
  '  static PaymentService create() { return PaymentService("x"); }',
  'private:',
  '  std::string name_;',
  '  int retries_ = 3;',
  '};',
  '',
  'int run(const std::string& id) {',
  '  PaymentService service("billing");',
  '  auto result = service.process(id, 3);',
  '  for (int i = 0; i < 3; i++) {',
  '    service.notify();',
  '  }',
  '  switch (result.ok) {',
  '    case 1: return 0;',
  '    default: break;',
  '  }',
  '  std::vector<int> values;',
  '  values.push_back(1);',
  '  auto scale = [](int x) { return x * 2; };',
  '  try {',
  '    throw std::runtime_error("boom");',
  '  } catch (const std::exception& e) {',
  '    return 2;',
  '  }',
  '  return scale(1);',
  '}',
  '',
  'void PaymentService::notify() { helper(); }',
  '}',
].join('\n');

const USER_HEADER = [
  '#pragma once',
  '#include <string>',
  '',
  'namespace models {',
  '',
  'struct User {',
  '  int id;',
  '  std::string name;',
  '};',
  '',
  'struct Admin : User {',
  '  bool active;',
  '};',
  '',
  '}',
].join('\n');

const SERVICE_HEADER = [
  '#pragma once',
  '#include <string>',
  '#include "models/user.h"',
  '',
  'class ServiceBase {',
  'public:',
  '  void log(const std::string& message) { record(message); }',
  '  void record(const std::string& message) { (void)message; }',
  '};',
  '',
  'class PaymentService : public ServiceBase {',
  'public:',
  '  explicit PaymentService(std::string name) : name_(std::move(name)) {}',
  '',
  '  models::User process(const std::string& id) {',
  '    log(id);',
  '    return load(id);',
  '  }',
  '',
  '  models::User load(const std::string& id) { return models::User{}; }',
  '',
  'private:',
  '  std::string name_;',
  '};',
].join('\n');

const RUN_SOURCE = [
  '#include "services.h"',
  '#include <vector>',
  '',
  'int run(const std::string& id) {',
  '  PaymentService service("billing");',
  '  auto user = service.process(id);',
  '  for (int i = 0; i < 3; i++) {',
  '    service.log(id);',
  '  }',
  '  return user.id;',
  '}',
].join('\n');

suite('C++ language detection', () => {
  test('C++ source and header extensions resolve to CPP', () => {
    for (const fileName of ['a.cpp', 'b.cc', 'c.cxx', 'd.h', 'e.hpp', 'f.hh', 'g.hxx', 'h.ipp']) {
      assert.strictEqual(detectLanguageKind({ fileName }), 'CPP', fileName);
    }
  });

  test('the cpp language id is authoritative and a plain file name still falls back to the extension', () => {
    assert.strictEqual(detectLanguageKind({ languageId: 'cpp' }), 'CPP');
    assert.strictEqual(detectLanguageKind({ languageId: 'plaintext', fileName: 'util.hpp' }), 'CPP');
    assert.strictEqual(detectLanguageKind({ languageId: 'plaintext', fileName: 'notes.txt' }), 'UNKNOWN');
  });

  test('C++ renders with a cpp code fence', () => {
    assert.strictEqual(languageKindInfo('CPP').displayName, 'C++');
    assert.strictEqual(languageKindInfo('CPP').codeFence, 'cpp');
  });
});

suite('C++ outline', () => {
  const outline = parseCppOutline(FEATURE_SOURCE);

  test('includes are recorded with quote/angle distinction', () => {
    assert.deepStrictEqual(
      outline.includes.map((include) => [include.specifier, include.isSystem]),
      [
        ['models/user.h', false],
        ['vector', true],
        ['string', true],
      ]
    );
  });

  test('namespaces carry their qualified name', () => {
    assert.deepStrictEqual(
      outline.namespaces.map((namespace) => [namespace.name, namespace.qualifiedName]),
      [['billing', 'billing']]
    );
  });

  test('classes, structs, inheritance and template parameters are preserved', () => {
    const result = outline.typeNamed('Result');
    assert.ok(result);
    assert.strictEqual(result.kind, 'struct');
    assert.deepStrictEqual(result.bases, ['Base']);
    assert.strictEqual(result.templateParams, 'typename T');
    assert.strictEqual(result.qualifiedName, 'billing::Result');

    const service = outline.typeNamed('PaymentService');
    assert.ok(service);
    assert.strictEqual(service.kind, 'class');
    assert.deepStrictEqual(service.bases, ['ServiceBase']);
  });

  test('member variables keep their declared types', () => {
    const service = outline.typeNamed('PaymentService');
    assert.ok(service);
    assert.deepStrictEqual(
      outline.fieldsIn(service).map((field) => [field.name, field.type]),
      [
        ['name_', 'std::string'],
        ['retries_', 'int'],
      ]
    );
  });

  test('constructors, destructors, methods and free functions are distinguished', () => {
    const service = outline.typeNamed('PaymentService');
    assert.ok(service);
    const methods = outline.functionsIn(service);

    const constructor = methods.find((fn) => fn.isConstructor);
    assert.ok(constructor);
    assert.strictEqual(constructor.name, 'PaymentService');
    assert.strictEqual(constructor.displayName, 'PaymentService::PaymentService(std::string name)');
    assert.strictEqual(constructor.kind, 'METHOD');

    const destructor = methods.find((fn) => fn.isDestructor);
    assert.ok(destructor);
    assert.strictEqual(destructor.displayName, 'PaymentService::~PaymentService()');
    assert.strictEqual(destructor.isConstructor, false);

    const process = methods.find((fn) => fn.name === 'process');
    assert.ok(process);
    assert.strictEqual(process.returnType, 'Result<int>');
    assert.strictEqual(process.isDeclaration, true);
    assert.deepStrictEqual(
      process.parameters.map((parameter) => [parameter.name, parameter.type]),
      [
        ['id', 'const std::string&'],
        ['count', 'int'],
      ]
    );

    const create = methods.find((fn) => fn.name === 'create');
    assert.ok(create);
    assert.strictEqual(create.returnType, 'PaymentService', 'storage specifiers are not part of the type');

    const run = outline.functionNamed('run');
    assert.ok(run);
    assert.strictEqual(run.kind, 'FUNCTION');
    assert.strictEqual(run.displayName, 'billing::run(const std::string& id)');
    assert.strictEqual(run.className, null);
  });

  test('the out-of-class definition is parsed as a method of its class', () => {
    const definitions = outline.functions.filter((fn) => fn.name === 'notify');
    assert.strictEqual(definitions.length, 2, 'inline declaration plus out-of-class definition');
    for (const definition of definitions) {
      assert.strictEqual(definition.className, 'PaymentService');
    }
  });

  test('local variables are recovered from a function body', () => {
    const run = outline.functionNamed('run');
    assert.ok(run);
    assert.deepStrictEqual(
      outline.localsIn(run).map((local) => [local.name, local.type]),
      [
        ['service', 'PaymentService'],
        ['result', 'auto'],
        ['i', 'int'],
        ['values', 'std::vector<int>'],
        ['scale', 'auto'],
        ['e', 'const std::exception&'],
      ]
    );
  });

  test('lambda expressions become nested function scopes with parameters', () => {
    const lambdas = outline.functions.filter((fn) => fn.name === 'lambda');
    assert.strictEqual(lambdas.length, 1);
    assert.strictEqual(lambdas[0].displayName, 'lambda(int x)');
    assert.deepStrictEqual(
      lambdas[0].parameters.map((parameter) => [parameter.name, parameter.type]),
      [['x', 'int']]
    );

    const inside = outline.functionContaining(FEATURE_SOURCE.indexOf('x * 2'));
    assert.strictEqual(inside?.name, 'lambda');
  });

  test('call sites keep chains, qualifiers and object creation, and never invent control-flow calls', () => {
    const run = outline.functionNamed('run');
    assert.ok(run);
    const calls = outline.callSitesIn(run);
    const byName = new Map(calls.map((call) => [call.rawText, call]));

    assert.strictEqual(byName.get('PaymentService')?.isConstructor, true);
    assert.strictEqual(byName.get('service.process')?.name, 'process');
    assert.strictEqual(byName.get('service.process')?.qualifier, 'service');
    assert.strictEqual(byName.get('service.notify')?.qualifier, 'service');
    assert.strictEqual(byName.get('values.push_back')?.qualifier, 'values');
    assert.strictEqual(byName.get('std::runtime_error')?.qualifier, 'std');
    assert.strictEqual(byName.get('scale')?.name, 'scale');

    const names = calls.map((call) => call.name);
    for (const keyword of ['if', 'for', 'while', 'switch', 'case', 'catch', 'throw', 'return', 'try']) {
      assert.ok(!names.includes(keyword), `${keyword} must never be a call site`);
    }
  });

  test('function contents resolve by offset, preferring the innermost scope', () => {
    assert.strictEqual(
      outline.functionContaining(FEATURE_SOURCE.indexOf('result.ok'))?.name,
      'run'
    );
    assert.strictEqual(
      outline.functionContaining(FEATURE_SOURCE.indexOf('retries_'))?.name,
      undefined,
      'a field is not inside a function'
    );
    assert.strictEqual(
      outline.typeContaining(FEATURE_SOURCE.indexOf('retries_'))?.name,
      'PaymentService'
    );
  });
});

suite('C++ resolution and extraction', () => {
  test('same-file free function call resolves and respects the depth limit', async () => {
    const source = [
      'void inner() { }',
      '',
      'void middle() { inner(); }',
      '',
      'void outer() { middle(); }',
    ].join('\n');
    const extractor = makeExtractor(new Map([['/proj/src/app.cpp', source]]));

    const deep = (await extractor.extractFlow({
      document: makeDocument('/proj/src/app.cpp', source, 'cpp'),
      position: positionAt(source, 'outer()'),
      maxDepth: 3,
      includeModels: false,
    })) as FlowResult;
    assert.strictEqual(deep.root.displayName, 'outer()');
    assert.deepStrictEqual(deep.nodes.map((node) => node.displayName), ['middle()', 'inner()']);

    const shallow = (await extractor.extractFlow({
      document: makeDocument('/proj/src/app.cpp', source, 'cpp'),
      position: positionAt(source, 'outer()'),
      maxDepth: 1,
      includeModels: false,
    })) as FlowResult;
    assert.deepStrictEqual(shallow.nodes.map((node) => node.displayName), ['middle()']);

    const rootOnly = (await extractor.extractFlow({
      document: makeDocument('/proj/src/app.cpp', source, 'cpp'),
      position: positionAt(source, 'outer()'),
      maxDepth: 0,
      includeModels: false,
    })) as FlowResult;
    assert.strictEqual(rootOnly.nodes.length, 0);
  });

  test('object creation resolves the constructor of a project type', async () => {
    const source = [
      'class Engine {',
      'public:',
      '  Engine(int power) : power_(power) {}',
      '  int power_;',
      '  void start() { }',
      '};',
      '',
      'void boot() {',
      '  Engine engine(42);',
      '  engine.start();',
      '}',
    ].join('\n');
    const extractor = makeExtractor(new Map([['/proj/src/boot.cpp', source]]));

    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/src/boot.cpp', source, 'cpp'),
      position: positionAt(source, 'boot()'),
      maxDepth: 2,
      includeModels: false,
    })) as FlowResult;

    const names = result.nodes.map((node) => node.displayName);
    assert.ok(names.includes('Engine::Engine(int power)'), 'direct initialization is a constructor call');
    assert.ok(names.includes('Engine::start()'));
    const constructor = result.nodes.find((node) => node.displayName === 'Engine::Engine(int power)');
    assert.strictEqual(constructor?.kind, 'METHOD');
  });

  test('calls resolve across an included header, including inherited methods and models', async () => {
    const files = new Map<string, string>([
      ['/proj/src/run.cpp', RUN_SOURCE],
      ['/proj/src/services.h', SERVICE_HEADER],
      ['/proj/src/models/user.h', USER_HEADER],
    ]);
    const extractor = makeExtractor(files);

    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/src/run.cpp', RUN_SOURCE, 'cpp'),
      position: positionAt(RUN_SOURCE, 'run(const'),
      maxDepth: 3,
      includeModels: true,
    })) as FlowResult;

    assert.strictEqual(result.root.displayName, 'run(const std::string& id)');
    assert.strictEqual(result.root.languageKind, 'CPP');

    const names = result.nodes.map((node) => node.displayName);
    assert.ok(names.includes('PaymentService::process(const std::string& id)'));
    assert.ok(names.includes('ServiceBase::log(const std::string& message)'));
    assert.ok(names.includes('PaymentService::load(const std::string& id)'));
    assert.ok(names.includes('ServiceBase::record(const std::string& message)'));

    const processNode = result.nodes.find((node) => node.displayName.includes('PaymentService::process'));
    assert.ok(processNode);
    assert.ok(processNode.filePath.includes('services.h'), 'the resolved node points at the header');
    assert.strictEqual(processNode.kind, 'METHOD');

    const modelNames = result.models.map((model) => model.displayName);
    assert.ok(modelNames.includes('User'), 'a referenced data struct is collected');
    assert.ok(result.models.some((model) => model.filePath.includes('models/user.h')));
    assert.strictEqual(formatFlow(result).includes('```cpp'), true);
  });

  test('a derived data model pulls in its base model (derived -> base relationship)', async () => {
    const source = [
      '#include "models/user.h"',
      '',
      'int run() {',
      '  models::Admin admin;',
      '  return admin.id;',
      '}',
    ].join('\n');
    const files = new Map<string, string>([
      ['/proj/src/app.cpp', source],
      ['/proj/src/models/user.h', USER_HEADER],
    ]);
    const extractor = makeExtractor(files);

    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/src/app.cpp', source, 'cpp'),
      position: positionAt(source, 'run()'),
      maxDepth: 1,
      includeModels: true,
    })) as FlowResult;

    const modelNames = result.models.map((model) => model.displayName);
    assert.ok(modelNames.includes('Admin'));
    assert.ok(modelNames.includes('User'), 'the base struct is related data too');
  });

  test('standard library, container and macro noise never becomes a flow node', async () => {
    const source = [
      '#include <vector>',
      '#include <memory>',
      '#include <cstdio>',
      '#include <string>',
      '',
      'void helper() { }',
      '',
      'void noisy() {',
      '  std::vector<int> values;',
      '  values.push_back(1);',
      '  auto pointer = std::make_unique<int>(2);',
      '  printf("%d", *pointer);',
      '  std::string text = "x";',
      '  text.size();',
      '  text.empty();',
      '  CHECK(text.size());',
      '  helper();',
      '  externalClient.fetch();',
      '}',
    ].join('\n');
    const extractor = makeExtractor(new Map([['/proj/src/noise.cpp', source]]));

    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/src/noise.cpp', source, 'cpp'),
      position: positionAt(source, 'noisy()'),
      maxDepth: 1,
      includeModels: false,
    })) as FlowResult;

    const displayNames = result.nodes.map((node) => node.displayName);
    assert.deepStrictEqual(displayNames, ['helper()', 'externalClient.fetch()']);
    assert.strictEqual(result.nodes[0].resolutionStatus, 'RESOLVED');
    assert.strictEqual(result.nodes[1].resolutionStatus, 'UNRESOLVED');
  });

  test('a caret inside a lambda extracts the lambda and its calls', async () => {
    const source = [
      'int normalize(int x) { return x < 0 ? -x : x; }',
      '',
      'int apply(int value) {',
      '  auto doubler = [](int x) { return normalize(x * 2); };',
      '  return doubler(value);',
      '}',
    ].join('\n');
    const extractor = makeExtractor(new Map([['/proj/src/lambda.cpp', source]]));

    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/src/lambda.cpp', source, 'cpp'),
      position: positionAt(source, 'normalize(x * 2)'),
      maxDepth: 2,
      includeModels: false,
    })) as FlowResult;

    assert.strictEqual(result.root.displayName, 'lambda(int x)');
    assert.deepStrictEqual(result.nodes.map((node) => node.displayName), ['normalize(int x)']);
  });

  test('templates keep their parameters and full declaration in the extracted code', async () => {
    const source = [
      'template <typename T>',
      'T maxValue(T left, T right) {',
      '  return isGreater(left, right) ? left : right;',
      '}',
    ].join('\n');
    const extractor = makeExtractor(new Map([['/proj/src/template.cpp', source]]));
    const outline = parseCppOutline(source);
    const fn = outline.functionNamed('maxValue');
    assert.ok(fn);
    assert.strictEqual(fn.templateParams, 'typename T');
    assert.strictEqual(fn.returnType, 'T');

    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/src/template.cpp', source, 'cpp'),
      position: positionAt(source, 'maxValue(T'),
      maxDepth: 1,
      includeModels: false,
    })) as FlowResult;

    assert.strictEqual(result.root.displayName, 'maxValue(T left, T right)');
    assert.ok(result.root.code.startsWith('template <typename T>'));
    assert.deepStrictEqual(result.nodes.map((node) => node.displayName), ['isGreater()']);
  });

  test('self recursion is skipped by the cycle guard', async () => {
    const source = [
      'void recurse(int depth) {',
      '  if (depth > 0) { recurse(depth - 1); }',
      '}',
    ].join('\n');
    const extractor = makeExtractor(new Map([['/proj/src/rec.cpp', source]]));

    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/src/rec.cpp', source, 'cpp'),
      position: positionAt(source, 'recurse(int'),
      maxDepth: 4,
      includeModels: false,
    })) as FlowResult;

    assert.strictEqual(result.nodes.length, 0);
  });

  test('malformed C++ is handled gracefully instead of throwing', async () => {
    const samples = [
      ['/proj/src/broken1.cpp', 'void broken() { if (x) { foo('],
      ['/proj/src/broken2.cpp', 'class Unclosed { void method() {'],
      ['/proj/src/broken3.cpp', 'struct Truncated { int value;'],
      ['/proj/src/broken4.cpp', '#include "missing.h"\nvoid run() { unknown(; } } }'],
      ['/proj/src/broken5.cpp', ''],
    ] as const;

    for (const [fileName, source] of samples) {
      const extractor = makeExtractor(new Map([[fileName, source]]));
      await assert.doesNotReject(async () => {
        const result = await extractor.extractFlow({
          document: makeDocument(fileName, source, 'cpp'),
          position: { line: 0, character: 0 } as vscode.Position,
          maxDepth: 3,
          includeModels: true,
        });
        if (result !== undefined) {
          assert.ok(Array.isArray(result.nodes));
          assert.ok(Array.isArray(result.models));
        }
      }, `malformed input must not throw: ${fileName}`);
    }
  });

  test('output is deterministic across repeated runs', async () => {
    const files = new Map<string, string>([
      ['/proj/src/run.cpp', RUN_SOURCE],
      ['/proj/src/services.h', SERVICE_HEADER],
      ['/proj/src/models/user.h', USER_HEADER],
    ]);
    const extractor = makeExtractor(files);
    const runOnce = (): Promise<FlowResult | undefined> =>
      extractor.extractFlow({
        document: makeDocument('/proj/src/run.cpp', RUN_SOURCE, 'cpp'),
        position: positionAt(RUN_SOURCE, 'run(const'),
        maxDepth: 3,
        includeModels: true,
      });

    const first = await runOnce();
    const second = await runOnce();
    assert.deepStrictEqual(second, first);

    const third = makeExtractor(files);
    const other = await third.extractFlow({
      document: makeDocument('/proj/src/run.cpp', RUN_SOURCE, 'cpp'),
      position: positionAt(RUN_SOURCE, 'run(const'),
      maxDepth: 3,
      includeModels: true,
    });
    assert.deepStrictEqual(other, first, 'a fresh context produces the same flow');
  });

  test('a non-C++ document is declined by the extractor', async () => {
    const source = 'def run():\n    pass\n';
    const extractor = makeExtractor(new Map([['/proj/src/app.py', source]]));
    const result = await extractor.extractFlow({
      document: makeDocument('/proj/src/app.py', source, 'python'),
      position: positionAt(source, 'run()'),
      maxDepth: 2,
      includeModels: true,
    });
    assert.strictEqual(result, undefined);
  });
});
