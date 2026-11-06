# Bisotun Flow Extractor

Instantly Extract Execution Call Flows & Data Models in VS Code.

Bisotun Flow Extractor automates code navigation by tracing and extracting nested execution call hierarchies and related data models directly to your clipboard in clean Markdown format—ideal for context injection into LLMs (ChatGPT, Claude, Ollama) or team documentation.

---

## Why "Bisotun"? The Philosophy Beneath the Name

The extension is named after **Mount Bisotun**, a majestic peak located near Kermanshah, Iran, famous for holding the world's largest limestone cliff and the historic Bisotun Inscription—carved in three ancient cuneiform languages by command of Darius the Great.

Just as Mount Bisotun is structured in magnificent, enduring geological layers, complex software code is also built layer upon layer. Bisotun Flow Extractor dives deep through these architectural layers to unearth, decode, and document your call flows and data models with historical precision.

---

## Key Features

- **Deep Flow Extraction:** Recursively crawls method execution call chains up to configurable depths.
- **Model Crawler:** Automatically extracts referenced DTOs, Entities, and Interfaces.
- **Java Support (v1.0.0):** Robust parsing and traversal for Java codebases.
- **LLM-Optimized Markdown:** Generates structured markdown trees ready to be pasted into AI prompts.

---

## Keyboard Shortcuts

| Action | Windows / Linux | macOS |
| :--- | :--- | :--- |
| **Copy Deep Flow** (Calls + Models) | `Ctrl + Alt + Shift + D` | `Cmd + Option + Shift + D` |
| **Copy Shallow Flow** (Calls + Models) | `Ctrl + Alt + Shift + S` | `Cmd + Option + Shift + S` |
| **Copy Shallow Flow** (No Models) | `Ctrl + Alt + Shift + M` | `Cmd + Option + Shift + M` |
| **Copy Method Only** | `Ctrl + Alt + Shift + C` | `Cmd + Option + Shift + C` |

---

## Requirements

- Visual Studio Code version `1.80.0` or higher.
