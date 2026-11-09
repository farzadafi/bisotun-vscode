import * as vscode from 'vscode';
import {
  FlowResult,
  isJsFamily,
  LanguageKind,
  languageKindFromExtension,
  languageKindFromLanguageId,
} from '../core/types';
import { LanguageFlowExtractor } from './languageFlowExtractor';
import { JavaFlowExtractor } from './javaFlowExtractor';
import { JsTsFlowExtractor } from './jsTsFlowExtractor';
import { PythonFlowExtractor } from './pythonFlowExtractor';

/**
 * Singleton registry that resolves the right `LanguageFlowExtractor` for a
 * document, mirroring `FlowExtractionDispatcher` in the JetBrains plugin.
 *
 * The map is keyed on `LanguageKind` so a single JS/TS extractor serves the
 * JS, JSX, TS and TSX entries, exactly like `JsTsFlowExtractor.supportedLanguages`.
 */
class LanguageExtractionDispatcher {
  private readonly extractors: LanguageFlowExtractor[];

  constructor() {
    this.extractors = [new JavaFlowExtractor(), new JsTsFlowExtractor(), new PythonFlowExtractor()];
  }

  /**
   * Finds the extractor able to handle a document. The editor language id is
   * authoritative; the file extension is only a fallback, matching the
   * JetBrains `LanguageKindDetector` merge rules.
   */
  extractorFor(document: vscode.TextDocument): LanguageFlowExtractor | undefined {
    const languageKind = kindOf(document);
    return this.extractors.find((extractor) => extractor.supportedLanguages.includes(languageKind));
  }

  extractFlow(opts: {
    document: vscode.TextDocument;
    position: vscode.Position;
    maxDepth: number;
    includeModels: boolean;
  }): Promise<FlowResult | undefined> {
    const extractor = this.extractorFor(opts.document);
    if (!extractor) return Promise.resolve(undefined);
    return Promise.resolve(extractor.extractFlow(opts));
  }
}

export const flowExtractionDispatcher = new LanguageExtractionDispatcher();

/** Mirror of `LanguageKindDetector.detect`: language id wins, extension decides JSX/TSX. */
export function kindOf(document: vscode.TextDocument): LanguageKind {
  const byLanguage = languageKindFromLanguageId(document.languageId);
  const byExtension = languageKindFromExtension(extensionOf(document.fileName));
  if (byExtension === 'UNKNOWN') return byLanguage;
  if (byLanguage === 'UNKNOWN') return byExtension;
  if (byExtension === 'JSX' || byExtension === 'TSX') return byExtension;
  if (byExtension === 'PYTHON') return byExtension;
  if (isJsFamily(byLanguage) && isJsFamily(byExtension)) return byExtension;
  return byLanguage;
}

export function extensionOf(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const base = fileName.replace(/\\/g, '/');
  const lastSlash = base.lastIndexOf('/');
  const name = lastSlash >= 0 ? base.substring(lastSlash + 1) : base;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.substring(dot + 1) : undefined;
}
