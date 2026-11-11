# Bisotun Flow Extractor for Visual Studio Code

Deep method execution flow and context extractor optimized for LLMs (Claude, ChatGPT, DeepSeek, Local LLMs).

Extract complete execution graphs, inter-module dependencies, and related data models directly to your clipboard in structured, token-efficient Markdown.

---

## 🚀 Supported Languages

- **Java** (Spring Boot, Records, Interfaces, Entities, DTOs)
- **Python** (FastAPI, Flask, Django, Standalone functions & Models)
- **TypeScript & TSX** (Classes, Methods, Interfaces, DTOs, Type aliases)
- **JavaScript & JSX** (ES modules, Classes, Prototypes, Utilities)

---

## ⚡ Key Features

- **Token-Efficient Context:** Only extracts real business logic and calls, eliminating runtime built-ins, framework plumbing, and prototype noise.
- **Deep Inter-File Traversal:** Traces method executions across controllers, services, repositories, and helper utilities.
- **Automated Data Model Detection:** Automatically collects referenced DTOs, schemas, entities, and type definitions at the bottom of the flow.
- **Context-Menu Driven:** Right-click inside any function or method and extract immediately.

---

## 🛠️ Usage

1. Open any Java, Python, TypeScript, or JavaScript file.
2. Place your cursor inside the method/function you want to trace.
3. **Right-click** and open the **Bisotun** submenu:
   - **Copy Deep Execution Flow:** Traverses the full call tree up to `bisotun.maxDepth`.
   - **Copy Shallow Flow (1 Level):** Direct callees only.
   - **Copy Code Only:** Extracts the current method without dependencies.
4. Paste directly into your LLM chat.

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
