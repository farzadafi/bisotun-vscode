# Bisotun Flow Extractor - Comprehensive Specification

## 1. Extraction Scope & Triggers

### 1.1 Supported Languages
- **Java** (`java`) - via `JavaStrategy`
- **JavaScript** (`javascript`) - via `JavaScriptStrategy`
- **TypeScript** (`typescript`) - supported through JavaScriptStrategy `supports()` method
- **JavaScript React** (`javascriptreact`) - supported through JavaScriptStrategy `supports()` method
- **TypeScript React** (`typescriptreact`) - supported through JavaScriptStrategy `supports()` method

**Language detection**: `src/utils/filter.ts:36-47` - `isSupportedDocument()` checks `document.languageId` against supported list.

### 1.2 Commands & Context Menu Locations

| Command | ID | When Visible | Description |
|---------|-----|-------------|-------------|
| `bisotun.extractFlow` | `bisotun.extractFlow` | `editorTextFocus` | Full extraction with models, depth from config |
| `bisotun.copyDeepFlow` | `bisotun.copyDeepFlow` | `editorTextFocus` | Deep extraction (default maxDepth=4) to clipboard |
| `bisotun.copyShallowFlow` | `bisotun.copyShallowFlow` | `editorTextFocus` | Shallow extraction (maxDepth=1) to clipboard |
| `bisotun.copyCodeOnly` | `bisotun.copyCodeOnly` | `editorTextFocus` | Code-only extraction (maxDepth=0) to clipboard |

**Context Menu**: Editor context panel, `bisotun.submenu` group `navigation@1`, with submenu items grouped as `1_actions@1` through `1_actions@3`.

**Command Palette**: All 4 commands available when `editorTextFocus`.

**Activation Events** (package.json): `onLanguage:java`, `onLanguage:typescript`, `onLanguage:javascript`, `onLanguage:python`, `onLanguage:javascriptreact`, `onLanguage:typescriptreact`.

### 1.3 Starting Points
- Cursor position in active editor document
- `findEnclosingScope()` determines the root method/class scope
- For Java: finds enclosing class and method via `vscode.executeDocumentSymbolProvider`
- For JavaScript/TypeScript: similar document symbol traversal
- Root flow starts from the identified scope and traverses call hierarchy

## 2. AST / Symbol Crawling Rules

### 2.1 Call Hierarchy Traversal Logic
- **Depth limit**: Configurable `maxDepth` (default 4, set via `vscode.workspace.getConfiguration('bisotun')`)
- **Cycle detection**: `src/core/cycleDetector.ts` - `CycleDetector` class with `visited` Set, `hasVisited()`, `markVisited()`, `clear()` methods
- **Recursion guards**: `scheduled` Set in `flowCrawler.ts` prevents re-processing same key
- **Key generation**: `createSymbolKey()` in `flowCrawler.ts:49-51` creates `[uri, name, line, char]` unique keys

### 2.2 Reference/Definition Resolution LSP Commands
- `vscode.executeDocumentSymbolProvider` - extracts document symbols (classes, methods, fields)
- `vscode.executeDefinitionProvider` - finds type definitions/usages
- `vscode.executeImplementationProvider` - finds method implementations
- `vscode.prepareCallHierarchy` - prepares call hierarchy items
- `vscode.provideOutgoingCalls` - gets outgoing calls from a call hierarchy item

### 2.3 Framework-Specific Patterns

#### Spring Boot (Java Strategy)
- **Services, Repositories, Interfaces → Implementations**: `javaStrategy.resolveModelDefinition()` opens target documents and finds model symbols (classes/interfaces/enums)
- **Dependency Injection**: `@Autowired`, `@Component`, `@Service`, `@Repository` etc. tracked in `JAVA_PRIMITIVE_TYPES` set (also used as exclusion filter)
- **Mappers**: MapStruct/static mappers/model mapper classes captured as type candidates

#### Streams, Lambdas, Method References
- JavaStrategy `extractTypeCandidates()` removes annotations first (`code.replace(/@[A-Za-z0-9_]+/g, ' ')`)
- Lambda expressions handled via regex patterns
- Method references extracted as type candidates

#### Constructors & Dependency Injection Fields
- **Java**: `inferConstructorParameterTypes()` in `javascriptStrategy.ts` (also used indirectly) - parses `constructor(param1, param2)` and maps parameters to types
- **Field extraction**: Both strategies track `this.foo = new Bar()` assignments and constructor parameter types

#### Async Calls / Event Listeners / Reactive Chains
- JavaScriptStrategy `extractFallbackCalls()` chained regex patterns:
  - `this.userService.getUserProfile(...)` - chained calls
  - `helperMethod(...)` - member calls
  - `this.helperMethod(...)` - direct calls
- Reactive chains captured via member call regex patterns

## 3. Data Model & Type Extraction

### 3.1 What Counts as a "Model"
- **Entities**: Java classes annotated with `@Entity` (or similar JPA annotations)
- **DTOs**: Data Transfer Objects, Projections, Records
- **Interfaces**: Type definitions, especially Spring Repository interfaces
- **Enums**: Java enums, TypeScript enums
- **Type Aliases**: `type X = Y` in TypeScript, `typedef` in Java
- **Generics unwrapping**: `List<T>`, `Optional<T>`, `Page<T>` - extracted as type candidates then deep-unwrapped

### 3.2 Deep Type Unwrapping
- **Generics**: Regex `/\b[A-Z][A-Za-z0-9_]+>/g` captures generic type names
- `List<ChapterResponse>` → extracts `ChapterResponse`
- `Optional<T>` → extracts `T`
- `Page<T>` → extracts `T` (with pageable metadata)
- **Map entries**: `Map<K, V>` patterns handled in candidate extraction

### 3.3 Field Extraction & Annotation Preservation
- **Jackson annotations**: `@Id`, `@Column`, `@GeneratedValue` etc. - Java strategy strips annotations before type extraction but preserves them in model code extraction
- **Validation constraints**: `@NotNull`, `@Size`, `@Pattern` etc. - included in `JAVA_PRIMITIVE_TYPES` set (thus excluded from type candidates, but model code preserves them)
- **Model code extraction**: `findModelSymbol()` and `findDeclarationRange()` in `javascriptStrategy.ts` extract actual code including annotations

## 4. Filtering & Boundary Rules

### 4.1 Excluded Packages/Paths
From `src/utils/filter.ts:3-16` `isExternalUri()`:
- `/node_modules/` paths
- `/site-packages/` paths
- `/.venv/` or `/venv/` paths
- `/target/` paths
- `/build/` paths
- `/dist/` paths
- Paths ending with `.jar`

From `src/core/fallbackResolver.ts:8-11`:
- `**/{node_modules,dist,build,target,.venv,venv}/**` - glob pattern for fallback search

### 4.2 Additional Filtering Heuristics
- `isWorkspaceUri()` check ensures only workspace-local files are processed
- `isSupportedDocument()` filters to supported language IDs only
- Test files: Not explicitly filtered but build directories excluded
- Constructor exclusion: `if (/^[A-Z]/.test(cleanName) && target.name === cleanName) continue;` in `flowCrawler.ts:261-263` prevents registering constructors as regular methods

### 4.3 Thresholds & Heuristics to Avoid Crawling Entire Frameworks
- `maxDepth` config (default 4) limits traversal depth
- `useFallback` config (default true) controls whether fallback call resolution is attempted
- File count limit: `vscode.workspace.findFiles()` with `50` limit (JS) or `20` limit in test
- `findFiles` max results: 50 files typically sufficient for most projects

## 5. Output Formatting & Extras

### 5.1 Markdown Template & Sections Generated
From `src/utils/formatter.ts`:

```
# Context Flow Extracted by Bisotun

- Root Target: `Class#Method`
- Extracted Nodes: N
- Extracted Models: M
- Estimated Tokens: ~T

## Root Method
### `Class#Method`
- File: `path`
- Lines: N-M

```language
code
```

## Execution Dependencies
### `Class#Method`
- File: `path`
- Lines: N-M

```language
code
```
(if nodes.length > 1)

## Related Data Models (DTOs / Projections / Records)
### Model: `Type`
- File: `path`

```language
code
```
(if models.length > 0)
```

### 5.2 Token Estimation Formula
- `Math.round(totalChars / 4)` where `totalChars` is sum of all node code lengths + all model code lengths
- Calculated in `formatter.ts:11-14`

### 5.3 Extra Outputs
- **Clipboard**: `vscode.env.clipboard.writeText(output)` - writes formatted markdown to system clipboard
- **Status Bar Notifications**:
  - Success: `Bisotun: Extracted N methods & M models to clipboard!`
  - Warning: `Bisotun: No methods found at the cursor position.`
  - Error: `Bisotun Exception: ${err.message}`
- **Webview/Extensions**: Not directly visible in source, but `extension.ts` configuration `bisotun.*` settings imply configurable behavior
- **Telemetry**: Not explicitly tracked, but console logging present (`[Bisotun]` prefixed messages)
- **Settings/Configs** (package.json):
  - `bisotun.maxDepth` (number, default 4)
  - `bisotun.useFallback` (boolean, default true)

## 6. Edge Cases Handled

### 6.1 Special Heuristics & Regex Fallbacks

#### Annotation Stripping (Java)
- `code.replace(/@[A-Za-z0-9_]+/g, ' ')` removes annotations before type candidate extraction
- Prevents `@GetMapping`, `@PathVariable` etc. from being captured as type names

#### Non-Code Masking (JavaScript/TypeScript)
- `maskNonCode()` function in `javascriptStrategy.ts:669-763` strips comments, strings, template literals before extracting uppercase type candidates
- Handles: single quotes, double quotes, template literals, line comments `//`, block comments `/* */`

#### Constructor Exclusion
- `flowCrawler.ts:261-263`: `if (/^[A-Z]/.test(cleanName) && target.name === cleanName) continue;`
- Prevents registering `OrderResponse()` constructor as a regular method

#### Import-Based Prioritization
- `javascriptStrategy.resolveFallbackCalls()`: When multiple methods match same name, checks `importMap.has(call.receiver)` and prioritizes methods from expected import path
- `parseImports()` extracts import mappings for resolution fallback

#### Fallback Model Resolution Order (JavaScript)
1. Imported model definition (via `resolveImportedModelDefinition`)
2. LSP definition provider results
3. Inline definition within current document
4. Direct import map lookup

#### Cycle Prevention
- `CycleDetector` class used alongside `visited` and `scheduled` Sets in `flowCrawler`
- `createSymbolKey` ensures unique identification by URI + name + position

#### Edge Case: Empty/Undefined Symbols
- All strategy methods check `if (!symbols || symbols.length === 0) return undefined/[]`
- Optional chaining (`??`) throughout for safe access

#### Language Mixing (TypeScript/JavaScript)
- `JavaScriptStrategy.supports()` returns true for `javascript`, `typescript`, `javascriptreact`, `typescriptreact`
- Single strategy handles all JS/TS language variants

#### Map Model Extraction
- Both Java and JS strategies extract `findModelSymbol()` from document symbols
- Falls back to `findDeclarationRange()` for type definitions
- Handles nested types within class hierarchies

### 6.2 Additional Edge Cases
- **Missing LSP providers**: Try-catch blocks around all `vscode.executeCommand()` calls
- **External URIs**: `isExternalUri()` guards prevent processing external dependencies
- **Workspace URI validation**: `isWorkspaceUri()` ensures only local project files are crawled
- **Document language mismatch**: Fallback to `rootStrategy` if per-document strategy not found
- **Position inside symbol**: `isPositionInsideSymbol()` checks both range containment and line range overlap