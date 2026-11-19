import * as assert from 'assert';
import * as vscode from 'vscode';

import { FlowResult, languageKindInfo } from '../core/types';
import { GoAnalysisContext, evaluateBuildExpression, fileMatchesBuildConstraints } from '../go/goAnalysisContext';
import { parseGoOutline } from '../go/goFileOutline';
import { GoFlowExtractor } from '../language/goFlowExtractor';
import { detectLanguageKind } from '../language/languageKindDetector';
import { formatFlow } from '../utils/formatter';

/**
 * Go flow extractor: hermetic tests.
 *
 * The extractor's package context is replaced by an in-memory file map and no real
 * workspace/document is opened, so the whole tokenizer tier (tokenizer, outline, resolver, BFS
 * flow) runs without `gopls` or files on disk. Import resolution is mapped onto the same in-memory
 * map through `go.mod`'s module path.
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

class InMemoryGoContext extends GoAnalysisContext {
  constructor(files: Map<string, string>) {
    super({
      workspaceRoot: '/proj',
      modulePath: 'example.com/proj',
      textReader: (filePath) => files.get(filePath),
      openSourceReader: (filePath) => files.get(filePath),
      directoryReader: (directory) => {
        const prefix = directory.endsWith('/') ? directory : `${directory}/`;
        const names = new Set<string>();
        for (const filePath of files.keys()) {
          if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes('/')) {
            names.add(filePath.slice(prefix.length));
          }
        }
        return names.size > 0 ? Array.from(names) : undefined;
      },
      platform: {
        goos: 'linux',
        goarch: 'amd64',
        tags: new Set(['gc', 'linux', 'amd64', 'unix']),
      },
    });
  }
}

function makeExtractor(files: Map<string, string>): GoFlowExtractor {
  const context = new InMemoryGoContext(files);
  return new GoFlowExtractor(() => context);
}

function makeDocument(fileName: string, text: string, languageId = 'go'): vscode.TextDocument {
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
  'package billing',
  '',
  'import (',
  '\t"context"',
  '\t"fmt"',
  '\t"errors"',
  '',
  '\t"example.com/proj/internal/models"',
  ')',
  '',
  'const DefaultRetries = 3',
  '',
  'const (',
  '\tStatusActive = "active"',
  '\tStatusClosed = "closed"',
  ')',
  '',
  'var ErrNotFound = errors.New("not found")',
  '',
  'type Result[T any] struct {',
  '\tValue T',
  '\tErr   error',
  '}',
  '',
  'type Base struct {',
  '\tID int',
  '}',
  '',
  'type User struct {',
  '\tBase',
  '\t*models.Address',
  '\tName  string `json:"name"`',
  '\tEmail string `json:"email"`',
  '}',
  '',
  'type Store interface {',
  '\tSave(ctx context.Context, user *User) error',
  '\tFind(id int) (*User, error)',
  '\tBaseReader',
  '}',
  '',
  'type BaseReader interface {',
  '\tLoad(id int) (*User, error)',
  '}',
  '',
  'type PaymentProcessor = PaymentService',
  '',
  'type Amount float64',
  '',
  'type PaymentService struct {',
  '\tBase',
  '\tstore Store',
  '\tname  string',
  '}',
  '',
  'func (s *PaymentService) Process(ctx context.Context, id int) (Result[bool], error) {',
  '\tuser, err := s.store.Find(id)',
  '\tif err != nil {',
  '\t\treturn Result[bool]{}, fmt.Errorf("find: %w", err)',
  '\t}',
  '\tfor _, tag := range user.Name {',
  '\t\tfmt.Println(tag)',
  '\t}',
  '\tswitch user.Name {',
  '\tcase "admin":',
  '\t\ts.notify(ctx)',
  '\tdefault:',
  '\t\tbreak',
  '\t}',
  '\treturn Result[bool]{Value: true}, nil',
  '}',
  '',
  'func (s *PaymentService) notify(ctx context.Context) {',
  '\tgo s.store.Save(ctx, nil)',
  '\tdefer s.cleanup()',
  '}',
  '',
  'func (s *PaymentService) cleanup() {}',
  '',
  'func NewPaymentService(store Store) *PaymentService {',
  '\tsvc := &PaymentService{store: store}',
  '\treturn svc',
  '}',
  '',
  'func init() {',
  '\t_ = NewPaymentService(nil)',
  '}',
  '',
  'func Run(ctx context.Context) error {',
  '\tch := make(chan int)',
  '\tgo func() {',
  '\t\tch <- 1',
  '\t}()',
  '\tselect {',
  '\tcase v := <-ch:',
  '\t\t_ = v',
  '\tdefault:',
  '\t\tbreak',
  '\t}',
  '\tdefer close(ch)',
  '\tpanic("boom")',
  '}',
].join('\n');

suite('Go language detection', () => {
  test('.go files resolve to GO', () => {
    assert.strictEqual(detectLanguageKind({ fileName: 'main.go' }), 'GO');
    assert.strictEqual(detectLanguageKind({ fileName: '/proj/internal/app/service.GO' }), 'GO');
  });

  test('the go language id is authoritative and a plain file name still falls back to the extension', () => {
    assert.strictEqual(detectLanguageKind({ languageId: 'go' }), 'GO');
    assert.strictEqual(detectLanguageKind({ languageId: 'plaintext', fileName: 'util.go' }), 'GO');
    assert.strictEqual(detectLanguageKind({ languageId: 'plaintext', fileName: 'notes.txt' }), 'UNKNOWN');
  });

  test('Go renders with a go code fence', () => {
    assert.strictEqual(languageKindInfo('GO').displayName, 'Go');
    assert.strictEqual(languageKindInfo('GO').codeFence, 'go');
  });

  test('previously supported languages keep their detection', () => {
    assert.strictEqual(detectLanguageKind({ fileName: 'a.ts' }), 'TS');
    assert.strictEqual(detectLanguageKind({ fileName: 'a.tsx' }), 'TSX');
    assert.strictEqual(detectLanguageKind({ fileName: 'a.js' }), 'JS');
    assert.strictEqual(detectLanguageKind({ fileName: 'a.py' }), 'PYTHON');
    assert.strictEqual(detectLanguageKind({ fileName: 'a.cpp' }), 'CPP');
    assert.strictEqual(detectLanguageKind({ fileName: 'a.java' }), 'JAVA');
    assert.strictEqual(detectLanguageKind({ fileName: 'a.kt' }), 'KOTLIN');
  });
});

suite('Go outline', () => {
  const outline = parseGoOutline(FEATURE_SOURCE);

  test('package and imports are recorded with their local aliases', () => {
    assert.strictEqual(outline.packageName, 'billing');
    assert.deepStrictEqual(
      outline.imports.map((item) => [item.alias, item.path]),
      [
        ['context', 'context'],
        ['fmt', 'fmt'],
        ['errors', 'errors'],
        ['models', 'example.com/proj/internal/models'],
      ]
    );
    assert.strictEqual(outline.importNamed('models')?.path, 'example.com/proj/internal/models');
  });

  test('constants and variables are recorded', () => {
    assert.deepStrictEqual(
      outline.values.map((value) => [value.name, value.kind]),
      [
        ['DefaultRetries', 'const'],
        ['StatusActive', 'const'],
        ['StatusClosed', 'const'],
        ['ErrNotFound', 'var'],
      ]
    );
    const defaultRetries = outline.valueNamed('DefaultRetries');
    assert.ok(defaultRetries);
    assert.strictEqual(defaultRetries.type, '');
  });

  test('structs keep fields, tags, embedded types and generics', () => {
    const user = outline.typeNamed('User');
    assert.ok(user);
    assert.strictEqual(user.kind, 'struct');
    assert.deepStrictEqual(
      user.fields.map((field) => [field.name, field.embedded, field.type]),
      [
        ['Base', true, 'Base'],
        ['Address', true, '*models.Address'],
        ['Name', false, 'string'],
        ['Email', false, 'string'],
      ]
    );
    assert.strictEqual(user.fields[2].tag, '`json:"name"`');
    assert.deepStrictEqual(user.embeddeds.map((item) => item.name), ['Base', 'Address']);

    const result = outline.typeNamed('Result');
    assert.ok(result);
    assert.deepStrictEqual(
      result.typeParams.map((param) => [param.name, param.constraint]),
      [['T', 'any']]
    );
    assert.deepStrictEqual(result.fields.map((field) => field.name), ['Value', 'Err']);
  });

  test('interfaces keep method signatures and embedded interfaces', () => {
    const store = outline.typeNamed('Store');
    assert.ok(store);
    assert.strictEqual(store.kind, 'interface');
    assert.deepStrictEqual(
      store.interfaceMethods.map((method) => method.name),
      ['Save', 'Find']
    );
    const save = store.interfaceMethods[0];
    assert.deepStrictEqual(
      save.parameters.map((param) => [param.name, param.type]),
      [
        ['ctx', 'context.Context'],
        ['user', '*User'],
      ]
    );
    assert.deepStrictEqual(save.returns.map((param) => param.type), ['error']);
    const find = store.interfaceMethods[1];
    assert.deepStrictEqual(find.returns.map((param) => param.type), ['*User', 'error']);
    assert.deepStrictEqual(store.embeddeds.map((item) => item.name), ['BaseReader']);
  });

  test('methods keep receivers, parameters and named/unnamed results', () => {
    const process = outline.functions.find((fn) => fn.name === 'Process');
    assert.ok(process);
    assert.strictEqual(process.kind, 'METHOD');
    assert.strictEqual(process.receiverType, 'PaymentService');
    assert.strictEqual(process.receiverName, 's');
    assert.strictEqual(process.isPointerReceiver, true);
    assert.strictEqual(process.displayName, 'PaymentService.Process(ctx context.Context, id int)');
    assert.deepStrictEqual(
      process.parameters.map((param) => [param.name, param.type]),
      [
        ['ctx', 'context.Context'],
        ['id', 'int'],
      ]
    );
    assert.deepStrictEqual(process.returns.map((param) => param.type), ['Result[bool]', 'error']);
  });

  test('free functions, init and constructors are distinguished', () => {
    const create = outline.functionNamed('NewPaymentService');
    assert.ok(create);
    assert.strictEqual(create.kind, 'FUNCTION');
    assert.strictEqual(create.receiverType, null);
    assert.deepStrictEqual(create.parameters.map((param) => [param.name, param.type]), [['store', 'Store']]);
    assert.deepStrictEqual(create.returns.map((param) => param.type), ['*PaymentService']);

    const init = outline.functionNamed('init');
    assert.ok(init);
    assert.strictEqual(init.isInit, true);
  });

  test('aliases and named types are recognised', () => {
    const processor = outline.typeNamed('PaymentProcessor');
    assert.ok(processor);
    assert.strictEqual(processor.kind, 'alias');
    assert.strictEqual(processor.isAlias, true);
    assert.strictEqual(processor.underlying, 'PaymentService');

    const amount = outline.typeNamed('Amount');
    assert.ok(amount);
    assert.strictEqual(amount.kind, 'named');
    assert.strictEqual(amount.underlying, 'float64');
  });

  test('local variables, short declarations and channel locals are recovered', () => {
    const process = outline.functions.find((fn) => fn.name === 'Process');
    assert.ok(process);
    assert.deepStrictEqual(
      outline.localsIn(process).map((local) => [local.name, local.isShort]),
      [
        ['user', true],
        ['err', true],
        ['tag', true],
      ]
    );

    const run = outline.functionNamed('Run');
    assert.ok(run);
    const ch = outline.localsIn(run).find((local) => local.name === 'ch');
    assert.ok(ch);
    assert.strictEqual(ch.type, 'chan');
    assert.ok(outline.localsIn(run).some((local) => local.name === 'v'));
  });

  test('functions can reach the declared type of a variable', () => {
    const process = outline.functions.find((fn) => fn.name === 'Process');
    assert.ok(process);
    assert.strictEqual(outline.variableType(process, 's'), '*PaymentService');
    assert.strictEqual(outline.variableType(process, 'ctx'), 'context.Context');
  });

  test('composite literals are recorded, including generic ones', () => {
    const process = outline.functions.find((fn) => fn.name === 'Process');
    assert.ok(process);
    const literals = outline.compositeLiteralsIn(process.bodyStart, process.bodyEnd);
    assert.ok(literals.some((literal) => literal.typeName === 'Result'));

    const create = outline.functionNamed('NewPaymentService');
    assert.ok(create);
    const created = outline.compositeLiteralsIn(create.bodyStart, create.bodyEnd);
    assert.ok(created.some((literal) => literal.typeName === 'PaymentService' && literal.pointer));
  });

  test('control flow, goroutines, defer, select and channels are recorded', () => {
    const process = outline.functions.find((fn) => fn.name === 'Process');
    assert.ok(process);
    const kinds = new Set(
      outline.controlFlowIn(process.bodyStart, process.bodyEnd).map((node) => node.kind)
    );
    for (const kind of ['if', 'range', 'switch', 'case']) {
      assert.ok(kinds.has(kind as never), `expected ${kind}`);
    }

    const notify = outline.functions.find((fn) => fn.name === 'notify');
    assert.ok(notify);
    const notifyKinds = new Set(
      outline.controlFlowIn(notify.bodyStart, notify.bodyEnd).map((node) => node.kind)
    );
    assert.ok(notifyKinds.has('go'));
    assert.ok(notifyKinds.has('defer'));

    const run = outline.functionNamed('Run');
    assert.ok(run);
    const flow = outline.controlFlowIn(run.bodyStart, run.bodyEnd);
    const runKinds = new Set(flow.map((node) => node.kind));
    for (const kind of ['closure', 'select', 'case', 'defer', 'receive', 'send', 'panic', 'chan']) {
      assert.ok(runKinds.has(kind as never), `expected ${kind}`);
    }
  });

  test('call sites keep selector chains, defer and go markers, and never invent keywords', () => {
    const notify = outline.functions.find((fn) => fn.name === 'notify');
    assert.ok(notify);
    const calls = outline.callSitesIn(notify);
    const save = calls.find((call) => call.name === 'Save');
    assert.ok(save);
    assert.strictEqual(save.qualifier, 'store');
    assert.strictEqual(save.rootIdentifier, 's');
    assert.strictEqual(save.isGoStatement, true);
    const cleanup = calls.find((call) => call.name === 'cleanup');
    assert.ok(cleanup);
    assert.strictEqual(cleanup.isDefer, true);

    const process = outline.functions.find((fn) => fn.name === 'Process');
    assert.ok(process);
    const processCalls = outline.callSitesIn(process);
    assert.ok(processCalls.some((call) => call.rawText === 's.store.Find'));
    assert.ok(processCalls.some((call) => call.rawText === 'fmt.Errorf'));
    for (const keyword of ['if', 'for', 'range', 'switch', 'case', 'return', 'defer', 'go']) {
      assert.ok(!processCalls.some((call) => call.name === keyword), `${keyword} must not be a call`);
    }
  });

  test('interfaces report the structs that implement their method set', () => {
    const source = [
      'package shapes',
      '',
      'type Greeter interface {',
      '\tGreet(name string) string',
      '}',
      '',
      'type English struct{}',
      '',
      'func (e English) Greet(name string) string { return "hi " + name }',
      '',
      'type Silent struct{}',
    ].join('\n');
    const shapeOutline = parseGoOutline(source);
    const greeter = shapeOutline.typeNamed('Greeter');
    assert.ok(greeter);
    assert.deepStrictEqual(shapeOutline.implementationsOf(greeter).map((type) => type.name), ['English']);
  });

  test('malformed Go produces a partial outline instead of throwing', () => {
    const samples = [
      'package main\nfunc broken( { if x { foo(',
      'func (s *S) M(',
      'package\nimport (',
      'type X struct {',
      'type Broken interface { Do(',
      '',
    ];
    for (const sample of samples) {
      assert.doesNotThrow(() => parseGoOutline(sample));
    }
  });
});

suite('Go resolution and extraction', () => {
  test('same-file function calls resolve and respect the depth limit', async () => {
    const source = [
      'package main',
      '',
      'func inner() {}',
      '',
      'func middle() { inner() }',
      '',
      'func outer() { middle() }',
    ].join('\n');
    const extractor = makeExtractor(new Map([['/proj/main.go', source]]));

    const deep = (await extractor.extractFlow({
      document: makeDocument('/proj/main.go', source),
      position: positionAt(source, 'outer()'),
      maxDepth: 3,
      includeModels: false,
    })) as FlowResult;
    assert.strictEqual(deep.root.displayName, 'outer()');
    assert.strictEqual(deep.root.languageKind, 'GO');
    assert.deepStrictEqual(deep.nodes.map((node) => node.displayName), ['middle()', 'inner()']);

    const shallow = (await extractor.extractFlow({
      document: makeDocument('/proj/main.go', source),
      position: positionAt(source, 'outer()'),
      maxDepth: 1,
      includeModels: false,
    })) as FlowResult;
    assert.deepStrictEqual(shallow.nodes.map((node) => node.displayName), ['middle()']);

    const rootOnly = (await extractor.extractFlow({
      document: makeDocument('/proj/main.go', source),
      position: positionAt(source, 'outer()'),
      maxDepth: 0,
      includeModels: false,
    })) as FlowResult;
    assert.strictEqual(rootOnly.nodes.length, 0);
  });

  test('methods resolve through receivers, interfaces, goroutines and deferred calls', async () => {
    const extractor = makeExtractor(new Map([['/proj/billing.go', FEATURE_SOURCE]]));
    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/billing.go', FEATURE_SOURCE),
      position: positionAt(FEATURE_SOURCE, 'func (s *PaymentService) Process'),
      maxDepth: 3,
      includeModels: false,
    })) as FlowResult;

    assert.strictEqual(result.root.displayName, 'PaymentService.Process(ctx context.Context, id int)');
    assert.strictEqual(result.root.kind, 'METHOD');
    const names = result.nodes.map((node) => node.displayName);
    assert.ok(names.includes('Store.Find(id int)'), 'interface method call resolves');
    assert.ok(names.includes('PaymentService.notify(ctx context.Context)'));
    assert.ok(names.includes('Store.Save(ctx context.Context, user *User)'), 'goroutine launch');
    assert.ok(names.includes('PaymentService.cleanup()'), 'deferred call');
    assert.ok(
      names.every((name) => !name.startsWith('fmt.')),
      'standard library calls never become flow nodes'
    );
  });

  test('calls resolve across the files of the same package', async () => {
    const files = new Map<string, string>([
      [
        '/proj/internal/store/store.go',
        [
          'package store',
          '',
          'type Item struct {',
          '\tID int',
          '}',
          '',
          'func loadItem(id int) *Item { return &Item{ID: id} }',
        ].join('\n'),
      ],
      [
        '/proj/internal/store/queries.go',
        [
          'package store',
          '',
          'func FindItem(id int) *Item {',
          '\treturn loadItem(id)',
          '}',
        ].join('\n'),
      ],
    ]);
    const extractor = makeExtractor(files);
    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/internal/store/queries.go', files.get('/proj/internal/store/queries.go') as string),
      position: positionAt(files.get('/proj/internal/store/queries.go') as string, 'FindItem('),
      maxDepth: 2,
      includeModels: true,
    })) as FlowResult;

    const target = result.nodes.find((node) => node.displayName === 'loadItem(id int)');
    assert.ok(target, 'a sibling file of the same package is searched');
    assert.ok(target.filePath.includes('store.go'));
    assert.ok(result.models.some((model) => model.displayName === 'Item'));
  });

  test('imports resolve through the module path and pull related models', async () => {
    const files = new Map<string, string>([
      [
        '/proj/internal/models/user.go',
        [
          'package models',
          '',
          'type Address struct {',
          '\tCity string',
          '}',
          '',
          'type User struct {',
          '\tID int',
          '\t*Address',
          '}',
        ].join('\n'),
      ],
      [
        '/proj/internal/services/user_service.go',
        [
          'package services',
          '',
          'import "example.com/proj/internal/models"',
          '',
          'func LoadUser(id int) (*models.User, error) {',
          '\treturn &models.User{ID: id}, nil',
          '}',
        ].join('\n'),
      ],
      [
        '/proj/cmd/app/main.go',
        [
          'package main',
          '',
          'import "example.com/proj/internal/services"',
          '',
          'func main() {',
          '\tu, err := services.LoadUser(1)',
          '\t_ = u',
          '\tif err != nil {',
          '\t\tpanic(err)',
          '\t}',
          '}',
        ].join('\n'),
      ],
    ]);
    const mainSource = files.get('/proj/cmd/app/main.go') as string;
    const extractor = makeExtractor(files);
    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/cmd/app/main.go', mainSource),
      position: positionAt(mainSource, 'func main()'),
      maxDepth: 2,
      includeModels: true,
    })) as FlowResult;

    const loaded = result.nodes.find((node) => node.displayName.startsWith('LoadUser('));
    assert.ok(loaded, 'the imported package function is resolved');
    assert.ok(loaded.filePath.includes('user_service.go'));
    assert.strictEqual(loaded.resolutionStatus, 'RESOLVED');

    const modelNames = result.models.map((model) => model.displayName);
    assert.ok(modelNames.includes('User'));
    assert.ok(modelNames.includes('Address'), 'embedded types are related models');
    assert.ok(result.models.some((model) => model.filePath.includes('models/user.go')));
    assert.ok(formatFlow(result).includes('```go'));
  });

  test('standard library, built-ins and conversions are filtered while project calls stay', async () => {
    const source = [
      'package main',
      '',
      'import (',
      '\t"fmt"',
      '\t"strings"',
      '\t"errors"',
      ')',
      '',
      'func helper() {}',
      '',
      'func noisy(name string, values []int) error {',
      '\tfmt.Println(strings.TrimSpace(name))',
      '\tvalues = append(values, len(values))',
      '\t_ = strings.NewReplacer("a", "b")',
      '\t_ = errors.New("nope")',
      '\ttext := string(values[0])',
      '\t_ = text',
      '\tconverted := Amount(text)',
      '\t_ = converted',
      '\thelper()',
      '\texternalClient.Fetch()',
      '\treturn nil',
      '}',
      '',
      'type Amount int',
    ].join('\n');
    const extractor = makeExtractor(new Map([['/proj/noise.go', source]]));
    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/noise.go', source),
      position: positionAt(source, 'func noisy('),
      maxDepth: 1,
      includeModels: false,
    })) as FlowResult;

    assert.deepStrictEqual(
      result.nodes.map((node) => node.displayName),
      ['helper()', 'externalClient.Fetch()']
    );
    assert.strictEqual(result.nodes[0].resolutionStatus, 'RESOLVED');
    assert.strictEqual(result.nodes[1].resolutionStatus, 'UNRESOLVED');
  });

  test('defer, goroutine launches and panic/recover are preserved', async () => {
    const source = [
      'package main',
      '',
      'func cleanup() {}',
      '',
      'func start() {',
      '\tgo cleanup()',
      '\tdefer cleanup()',
      '}',
      '',
      'func guard() {',
      '\tdefer func() {',
      '\t\tif r := recover(); r != nil {',
      '\t\t\tcleanup()',
      '\t\t}',
      '\t}()',
      '\tpanic("boom")',
      '}',
    ].join('\n');
    const extractor = makeExtractor(new Map([['/proj/concurrency.go', source]]));
    const startFlow = (await extractor.extractFlow({
      document: makeDocument('/proj/concurrency.go', source),
      position: positionAt(source, 'func start()'),
      maxDepth: 1,
      includeModels: false,
    })) as FlowResult;
    const startNames = startFlow.nodes.map((node) => node.displayName);
    assert.ok(startNames.includes('cleanup()'), 'goroutine and deferred calls resolve');

    const guardFlow = (await extractor.extractFlow({
      document: makeDocument('/proj/concurrency.go', source),
      position: positionAt(source, 'func guard()'),
      maxDepth: 1,
      includeModels: false,
    })) as FlowResult;
    const guardNames = guardFlow.nodes.map((node) => node.displayName);
    assert.ok(guardNames.includes('panic()'));
    assert.ok(guardNames.includes('recover()'));
  });

  test('composite literal initialization of a project type is a resolved flow', async () => {
    const source = [
      'package main',
      '',
      'type Config struct {',
      '\tName string',
      '\tTags []string',
      '}',
      '',
      'func build() Config {',
      '\treturn Config{Name: "x", Tags: []string{"a"}}',
      '}',
      '',
      'func newConfig() *Config {',
      '\treturn &Config{Name: "y"}',
      '}',
    ].join('\n');
    const extractor = makeExtractor(new Map([['/proj/config.go', source]]));
    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/config.go', source),
      position: positionAt(source, 'func build()'),
      maxDepth: 1,
      includeModels: true,
    })) as FlowResult;
    assert.strictEqual(result.nodes.length, 0);
    assert.ok(result.models.some((model) => model.displayName === 'Config'));
  });

  test('generics keep their type parameters and declarations', async () => {
    const source = [
      'package main',
      '',
      'func Map[T any, U any](items []T, transform func(T) U) []U {',
      '\tout := make([]U, 0, len(items))',
      '\tfor _, item := range items {',
      '\t\tout = append(out, transform(item))',
      '\t}',
      '\treturn out',
      '}',
    ].join('\n');
    const outline = parseGoOutline(source);
    const mapFn = outline.functionNamed('Map');
    assert.ok(mapFn);
    assert.deepStrictEqual(
      mapFn.typeParams.map((param) => [param.name, param.constraint]),
      [
        ['T', 'any'],
        ['U', 'any'],
      ]
    );
    const extractor = makeExtractor(new Map([['/proj/generics.go', source]]));
    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/generics.go', source),
      position: positionAt(source, 'func Map['),
      maxDepth: 1,
      includeModels: false,
    })) as FlowResult;
    assert.ok(result.root.code.startsWith('func Map[T any, U any]'));
  });

  test('capturing a struct yields the struct as the root node', async () => {
    const extractor = makeExtractor(new Map([['/proj/billing.go', FEATURE_SOURCE]]));
    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/billing.go', FEATURE_SOURCE),
      position: positionAt(FEATURE_SOURCE, 'type User struct'),
      maxDepth: 1,
      includeModels: false,
    })) as FlowResult;
    assert.strictEqual(result.root.displayName, 'User');
    assert.strictEqual(result.root.kind, 'MODEL');
    assert.ok(result.root.code.startsWith('type User struct'));
  });

  test('malformed Go is handled gracefully instead of throwing', async () => {
    const samples = [
      ['/proj/broken1.go', 'package main\n\nfunc broken() { if x { foo('],
      ['/proj/broken2.go', 'package main\n\ntype Unclosed struct { Field int'],
      ['/proj/broken3.go', 'package main\n\nfunc (s *S) M('],
      ['/proj/broken4.go', 'package main\n\nimport (\n\t"fmt"\n\nfunc run() { unknown(; } } }'],
      ['/proj/broken5.go', ''],
    ] as const;

    for (const [fileName, source] of samples) {
      const extractor = makeExtractor(new Map([[fileName, source]]));
      await assert.doesNotReject(async () => {
        const result = await extractor.extractFlow({
          document: makeDocument(fileName, source),
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
    const files = new Map([['/proj/billing.go', FEATURE_SOURCE]]);
    const extractor = makeExtractor(files);
    const runOnce = (): Promise<FlowResult | undefined> =>
      extractor.extractFlow({
        document: makeDocument('/proj/billing.go', FEATURE_SOURCE),
        position: positionAt(FEATURE_SOURCE, 'func (s *PaymentService) Process'),
        maxDepth: 3,
        includeModels: true,
      });

    const first = await runOnce();
    const second = await runOnce();
    assert.deepStrictEqual(second, first);

    const fresh = makeExtractor(files);
    const other = await fresh.extractFlow({
      document: makeDocument('/proj/billing.go', FEATURE_SOURCE),
      position: positionAt(FEATURE_SOURCE, 'func (s *PaymentService) Process'),
      maxDepth: 3,
      includeModels: true,
    });
    assert.deepStrictEqual(other, first, 'a fresh context produces the same flow');
  });

  test('a non-Go document is declined by the extractor', async () => {
    const source = 'export function run(): void {}\n';
    const extractor = makeExtractor(new Map([['/proj/app.ts', source]]));
    const result = await extractor.extractFlow({
      document: makeDocument('/proj/app.ts', source, 'typescript'),
      position: positionAt(source, 'run()'),
      maxDepth: 2,
      includeModels: true,
    });
    assert.strictEqual(result, undefined);
  });
});

suite('Go build constraints', () => {
  const platform = {
    goos: 'linux',
    goarch: 'amd64',
    tags: new Set(['gc', 'linux', 'amd64', 'unix']),
  };

  test('//go:build expressions are evaluated', () => {
    assert.strictEqual(evaluateBuildExpression('linux', platform.tags), true);
    assert.strictEqual(evaluateBuildExpression('windows', platform.tags), false);
    assert.strictEqual(evaluateBuildExpression('!windows', platform.tags), true);
    assert.strictEqual(evaluateBuildExpression('linux && amd64', platform.tags), true);
    assert.strictEqual(evaluateBuildExpression('windows || linux', platform.tags), true);
    assert.strictEqual(evaluateBuildExpression('(windows || linux) && !unix', platform.tags), false);
  });

  test('GOOS/GOARCH file suffixes and build tags exclude files from a package', () => {
    const linux = 'package store\n\nfunc LinuxOnly() {}\n';
    assert.strictEqual(fileMatchesBuildConstraints(linux, '/proj/store_linux.go', platform), true);
    assert.strictEqual(fileMatchesBuildConstraints(linux, '/proj/store_windows.go', platform), false);
    assert.strictEqual(fileMatchesBuildConstraints(linux, '/proj/store_amd64.go', platform), true);
    assert.strictEqual(fileMatchesBuildConstraints(linux, '/proj/store_arm64.go', platform), false);
    assert.strictEqual(
      fileMatchesBuildConstraints('//go:build windows\n\npackage store\n', '/proj/store.go', platform),
      false
    );
    assert.strictEqual(
      fileMatchesBuildConstraints('//go:build linux\n\npackage store\n', '/proj/store.go', platform),
      true
    );
    assert.strictEqual(
      fileMatchesBuildConstraints('// +build windows\n\npackage store\n', '/proj/store.go', platform),
      false
    );
  });

  test('a platform-excluded sibling is not used to resolve calls', async () => {
    const files = new Map<string, string>([
      [
        '/proj/platform/main.go',
        [
          'package platform',
          '',
          'func Run() {',
          '\tPlatformOnly()',
          '}',
        ].join('\n'),
      ],
      [
        '/proj/platform/impl_windows.go',
        [
          '//go:build windows',
          '',
          'package platform',
          '',
          'func PlatformOnly() {}',
        ].join('\n'),
      ],
    ]);
    const mainSource = files.get('/proj/platform/main.go') as string;
    const extractor = makeExtractor(files);
    const result = (await extractor.extractFlow({
      document: makeDocument('/proj/platform/main.go', mainSource),
      position: positionAt(mainSource, 'func Run()'),
      maxDepth: 1,
      includeModels: false,
    })) as FlowResult;
    assert.deepStrictEqual(result.nodes.map((node) => node.displayName), ['PlatformOnly()']);
    assert.strictEqual(result.nodes[0].resolutionStatus, 'UNRESOLVED');
  });
});
