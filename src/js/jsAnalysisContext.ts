// JS/TS source context - resolves files and import specifiers to `JsBoundSource`.
//
// Mirrors the JetBrains `AnalysisContext` used by the JS/TS tokenizer tier: the root file can come
// from the open VS Code document (`sourceForFile`) or from disk (`sourceForPath`), and import
// specifiers are resolved relative to the importing file only. Path aliases (`@/...`) and bare
// package specifiers (`react`) are intentionally left unresolved, exactly like the reference.

import * as path from 'path';
import * as fs from 'fs';

import { JsFileOutline, parseJsOutline } from './jsFileOutline';

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Extension candidates tried for a specifier, in order, mirroring the JetBrains list. */
export const JS_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'] as const;

/**
 * The source a file resolves to: its text plus the parsed outline. The resolver works against this
 * struct so both the open document and the disk cache share one code path.
 */
export interface JsBoundSource {
  filePath: string;
  text: string;
  outline: JsFileOutline;
}

/** Seam for reading a file, mirroring the JetBrains `AnalysisContext` disk reader. */
export type SourceTextReader = (filePath: string) => string | undefined;

/** Reads the currently open document's text, mirroring the plugin's `sourceForFile`. */
export type OpenDocumentSourceReader = (filePath: string) => string | undefined;

const diskSourceReader: SourceTextReader = (filePath) => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {return undefined;}
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
};

const noOpenDocumentSourceReader: OpenDocumentSourceReader = () => undefined;

export class JsAnalysisContext {
  private readonly cache = new Map<string, string | undefined>();
  private readonly textReader: SourceTextReader;
  private readonly openSourceReader: OpenDocumentSourceReader;

  constructor(options: {
    workspaceRoot?: string;
    textReader?: SourceTextReader;
    openSourceReader?: OpenDocumentSourceReader;
  } = {}) {
    this.workspaceRoot = options.workspaceRoot ?? '';
    this.textReader = options.textReader ?? diskSourceReader;
    this.openSourceReader = options.openSourceReader ?? noOpenDocumentSourceReader;
  }

  readonly workspaceRoot: string;

  /** The open document's text when it is in the workspace, mirroring `sourceForFile`. */
  sourceForFile(filePath: string): string | undefined {
    return this.openSourceReader(filePath);
  }

  /** Disk text with a per-file cache; a file is cached as `undefined` after a read miss. */
  sourceForPath(filePath: string): string | undefined {
    if (!filePath) {return undefined;}
    if (this.cache.has(filePath)) {return this.cache.get(filePath);}
    const text = this.textReader(filePath);
    this.cache.set(filePath, text);
    return text;
  }

  /** Reads and parses `filePath`, bounded to existing files and the 2 MB limit. */
  sourceForFileAsSource(filePath: string): JsBoundSource | undefined {
    const text = this.sourceForFile(filePath) ?? this.sourceForPath(filePath);
    if (text === undefined) {return undefined;}
    return { filePath, text, outline: parseJsOutline(text) };
  }

  /**
   * Resolves a relative specifier (`./x`, `../x/y`) to the file it imports. Bare modules and
   * aliases stay unresolved; the usual extensions and an `index.*` fallback are tried, mirroring
   * the JetBrains `AnalysisContext.resolveSpecifier`.
   */
  resolveSpecifier(fromFile: string, specifier: string): string | undefined {
    if (!specifier.startsWith('.')) {return undefined;}
    const baseDirectory = path.dirname(fromFile);
    const base = path.normalize(path.join(baseDirectory, specifier));
    const candidates: string[] = [base];
    for (const extension of JS_EXTENSIONS) {
      candidates.push(`${base}.${extension}`);
    }
    for (const extension of JS_EXTENSIONS) {
      candidates.push(path.join(base, `index.${extension}`));
    }
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) {return candidate;}
      } catch {
        // keep looking
      }
    }
    return undefined;
  }
}
