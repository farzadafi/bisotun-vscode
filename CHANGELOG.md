# Change Log

All notable changes to the "Bisotun Flow Extractor" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.4.0] - 2026-11-15

### Added
- **Go Language Support:** Tokenizer-tier extractor (`GoFlowExtractor`, `GoTokenizer`,
  `GoFileOutline`, `GoCallResolver`, `GoAnalysisContext`) for `.go` files — no Go language server
  required.
- Packages and imports (aliased, dot and blank), constants, variables, structs with tags and
  embedded fields, interfaces with embedded interfaces, type aliases and named types, generic type
  parameters, methods with value/pointer receivers, free functions, parameters and named/unnamed
  results, local variables, `:=` short declarations, composite literals and `init` functions.
- Call resolution through the current file, sibling files of the same package, imported packages
  resolved from `go.mod`/`vendor`, receivers, embedded (promoted) methods and interface method
  signatures; unresolved calls are reported, never fabricated.
- Control flow, `defer`, `go`, `select`, channel creation/send/receive and `panic`/`recover` are
  captured, and `defer`/`go` callees are expanded.
- Standard library packages, built-in functions and type conversions are filtered consistently with
  the existing JS/TS, Python and C++ builtin gates.
- Go build constraints (`//go:build`, `// +build`, GOOS/GOARCH suffixes) are honoured during package
  resolution, and malformed Go is parsed conservatively instead of throwing.

## [1.3.0] - 2026-11-14

### Added
- **C++ Language Support:** Tokenizer-tier extractor (`CppFlowExtractor`, `CppTokenizer`,
  `CppFileOutline`, `CppCallResolver`) for `.cpp`, `.cc`, `.cxx`, `.c++`, `.h`, `.hpp`, `.hh`,
  `.hxx`, `.ipp`, `.inl` and `.tpp` files — no C++ language server required.
- Namespaces, classes/structs/unions/enums, inheritance (including inherited method resolution and
  base data models), constructors, destructors, operator overloads, methods, free functions,
  out-of-class definitions, parameters, return types, member and local variables, object creation,
  lambda expressions and templates.
- Call resolution through `#include`d headers, `this->`, declared variable/field types, base classes
  and qualifier-to-type matching; unresolved calls are reported, never fabricated.
- Standard library (`std::`, container/string accessors, C library functions) and macro noise is
  filtered consistently with the existing JS/TS and Python builtin gates.

### Fixed
- Preprocessor directives are tokenized as single logical lines, so macro bodies never leak calls
  into a flow.

## [1.2.0] - 2026-11-10

### Added
- **High-Performance JavaScript & TypeScript Support:** Integrated the dedicated tokenizer-tier extractor (`JsTsFlowExtractor`, `JsTokenizer`, and `JsFileOutline`) ported from the JetBrains plugin engine.
- Precise relative-import call resolution across modules, services, controllers, and repositories without relying on heavy external Language Servers.
- Automatic extraction of data models, DTOs, interfaces, and types (e.g., `CreateUserDto`, `User`).

### Fixed & Improved
- **Noise Elimination:** Built-in JS/TS prototype methods (`toLowerCase`, `trim`, `substring`, `toString`, `find`, `set`, `map`, etc.) and host globals are now strictly filtered out from execution dependencies.
- **Markdown Formatting:** Fixed a bug causing duplicate `## Related Data Models` headers; data models now render under a single deduplicated section.
- Fixed root target boundary resolution when extracting methods starting from the `class` keyword.

## [1.1.0] - 2026-11-10

### Added
- **Python Language Support:** Full support for extracting nested Python method execution call hierarchies and related data models across workspace files.
- Inter-file Python call resolution tracing across classes, standalone functions, and module imports.
- Automatic filtering for Python built-ins, primitive operations, and standard library calls to keep LLM context clean and token-efficient.
- Python data model detection (classes, DTOs, domain models).

## [1.0.0] - 2026-11-06

### Added
- Initial release of Bisotun Flow Extractor for Visual Studio Code.
- Core Dispatcher → Strategy architecture mirroring the production JetBrains plugin.
- Full Java execution call flow and data model extraction.
- LLM-optimized Markdown formatting and clipboard integration.
- Configurable depth limits and model inclusion toggles.
- Standard keyboard shortcuts for deep/shallow flow and method extraction.
