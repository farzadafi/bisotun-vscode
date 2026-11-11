# Change Log

All notable changes to the "Bisotun Flow Extractor" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
