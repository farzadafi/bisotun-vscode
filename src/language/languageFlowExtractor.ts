import * as vscode from 'vscode';
import { FlowResult, LanguageKind } from '../core/types';

/**
 * Common contract for every language flow extractor.
 *
 * Mirrors the JetBrains plugin's `LanguageFlowExtractor`: extraction always
 * converts platform elements into plain data (`FlowResult`) as fast as
 * possible, so rendering never touches the document.
 *
 * Concrete strategies:
 *  - Java: thin adapter over the LSP (document symbols, definition and call
 *    hierarchy) providers shipped with the Red Hat extension.
 *  - JS/TS/JSX/TSX and Python: tokenizer tier ports (bounded hand written
 *    parsers) that behave identically with or without a real language service.
 */
export interface LanguageFlowExtractor {
  /** Languages this extractor can handle (the `LanguageKind` set). */
  readonly supportedLanguages: LanguageKind[];

  extractFlow(opts: {
    document: vscode.TextDocument;
    position: vscode.Position;
    maxDepth: number;
    includeModels: boolean;
  }): Promise<FlowResult | undefined>;
}
