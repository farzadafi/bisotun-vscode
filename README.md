# Bisotun Flow Extractor for Visual Studio Code

Deep method execution flow and context extractor optimized for LLMs (Claude, ChatGPT, DeepSeek, Local LLMs).

Extract complete execution graphs, inter-module dependencies, and related data models directly to your clipboard in structured, token-efficient Markdown.

---

## 🚀 Supported Languages

- **Java** (Spring Boot, Records, Interfaces, Entities, DTOs)
- **Python** (FastAPI, Flask, Django, Standalone functions & Models)
- **TypeScript & TSX** (Classes, Methods, Interfaces, DTOs, Type aliases)
- **JavaScript & JSX** (ES modules, Classes, Prototypes, Utilities)
- **C++** (Namespaces, Classes/Structs, Inheritance, Templates, Constructors/Destructors, Lambdas)
- **Go** (Packages, Structs & Interfaces, Methods with Receivers, Goroutines, Channels, Generics)

---

## ⚡ Key Features

- **Token-Efficient Context:** Only extracts real business logic and calls, eliminating runtime built-ins, framework plumbing, and prototype noise.
- **Deep Inter-File Traversal:** Traces method executions across controllers, services, repositories, and helper utilities.
- **Automated Data Model Detection:** Automatically collects referenced DTOs, schemas, entities, and type definitions at the bottom of the flow.
- **Context-Menu Driven:** Right-click inside any function or method and extract immediately.

---

## 🛠️ Usage

1. Open any Java, Python, TypeScript, JavaScript, C++, or Go file (`.cpp`, `.cc`, `.cxx`, `.h`, `.hpp`, `.hh`, `.hxx`, `.ipp`, `.go`).
2. Place your cursor inside the method/function you want to trace.
3. **Right-click** and open the **Bisotun** submenu:
   - **Copy Deep Execution Flow:** Traverses the full call tree up to `bisotun.maxDepth`.
   - **Copy Shallow Flow (1 Level):** Direct callees only.
   - **Copy Code Only:** Extracts the current method without dependencies.
4. Paste directly into your LLM chat.

---

## 🔧 C++ Extraction Notes

- Calls are resolved through the current file, base classes, and the headers reachable from the file's
  `#include` directives. Unresolvable calls are reported as `UNRESOLVED`, never invented.
- Object creation (`PaymentService service("x")` / `new PaymentService(...)`) resolves to the type's
  constructor.
- Standard library calls (`std::`, container/string accessors, C library functions) and `ALL_CAPS`
  macros are filtered as ecosystem noise, keeping the flow focused on project code.
- Constructs inside the extracted source (control flow, `try`/`catch`, `throw`, `return`, local and
  member variables, templates) are preserved verbatim in each node's code block.

---

## 🐹 Go Extraction Notes

- Requires no Go language server. Calls resolve through the current file, sibling files of the same
  package, and the packages reached from the file's `import` block via the module path in `go.mod`
  (plus `vendor/`). Unresolvable calls are reported as `UNRESOLVED`, never invented.
- Structs, interfaces, embedded types, type aliases, methods with value/pointer receivers,
  parameters, named and unnamed results, local variables, `:=` short declarations, composite
  literals, generic type parameters and `init` functions are part of the outline.
- Control flow (`if`/`else`/`switch`/type switch/`for`/`range`/`break`/`continue`/`goto`), `defer`,
  `go`, `select`, channel creation/send/receive and `panic`/`recover` stay verbatim in each node's
  code block; `defer` and `go` callees resolve like ordinary calls.
- Standard library packages (`fmt`, `strings`, `errors`, ...), built-in functions (`len`, `append`,
  ...) and built-in type conversions are filtered as ecosystem noise, keeping the flow focused on
  project code.
- `//go:build`, legacy `// +build` lines and GOOS/GOARCH file-name suffixes are honoured when a
  package is resolved; `_test.go` files are not treated as part of the package.

---

## ⚙️ Extension Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `bisotun.maxDepth` | `4` | Maximum depth of call hierarchy traversal (0 = target method only). |
| `bisotun.includeModels` | `true` | Automatically append referenced data models (DTOs, records, interfaces). |
| `bisotun.useFallback` | `true` | Enable heuristic/tokenizer fallback resolution when LSP definitions are missing. |

---

## 📄 Output Format Example
```markdown
# Context Flow Extracted by Bisotun
- Root Target: `UserController#createUser`
- Extracted Nodes: 5
- Extracted Models: 2
- Estimated Tokens: ~256

## Root Method
### `UserController#createUser`
- File: `ts/userController.ts`
- Lines: 13-15

...
