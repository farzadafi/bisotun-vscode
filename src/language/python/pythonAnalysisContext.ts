// Python source context - resolves files and import specifiers to `PythonBoundSource`.
//
// Mirrors the JetBrains `PythonAnalysisContext`: a source can come from the open VS Code document
// (`sourceForFile`) or from disk (`sourceForPath`), and import specifiers are resolved through the
// working directory with both dot-relative (`.pkg.mod`) and absolute (`pkg.mod`) Python import
// forms. `resolveSpecifier` never returns a path that exists on disk to keep the checker free of
// the filesystem.

import * as path from 'path';
import * as fs from 'fs';

import { PythonFileOutline, parsePythonOutline } from './pythonFileOutline';

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const PYTHON_EXTENSIONS = ['.py', '.pyw', '.pyi'] as const;

/**
 * Common Python stdlib modules whose contents should never be surfaced in a flow. Keeping them out
 * of `resolveSpecifier` means an `import json` stays unresolved rather than being read as a 2 MB
 * stdlib file.
 */
export const STDLIB_MODULES = new Set([
  'abc', 'argparse', 'ast', 'asyncio', 'base64', 'bisect', 'builtins', 'calendar',
  'collections', 'contextlib', 'copy', 'csv', 'ctypes', 'dataclasses', 'datetime',
  'decimal', 'difflib', 'enum', 'errno', 'functools', 'gc', 'glob', 'gzip', 'hashlib',
  'heapq', 'hmac', 'html', 'http', 'importlib', 'inspect', 'io', 'itertools', 'json',
  'locale', 'logging', 'math', 'mimetypes', 'multiprocessing', 'operator', 'os', 'pathlib',
  'pickle', 'platform', 'pprint', 'queue', 'random', 're', 'secrets', 'selectors',
  'shutil', 'signal', 'site', 'socket', 'socketserver', 'sqlite3', 'ssl', 'statistics',
  'string', 'struct', 'subprocess', 'sys', 'tempfile', 'threading', 'time', 'timeit',
  'tkinter', 'traceback', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uuid',
  'warnings', 'wave', 'weakref', 'webbrowser', 'xml', 'zipfile',
]);


/**
 * The source a file resolves to: its text plus the parsed outline. The resolver works against this
 * struct so both the open document and the disk cache share one code path.
 */
export interface PythonBoundSource {
  filePath: string;
  text: string;
  outline: PythonFileOutline;
}

/** Seam for reading a file, mirroring the JetBrains `PythonAnalysisContext` disk reader. */
export type SourceTextReader = (filePath: string) => string | undefined;

/** Reads the currently open document's text, mirroring the plugin's `sourceForFile`. */
export type OpenDocumentSourceReader = (filePath: string) => string | undefined;

const diskSourceReader: SourceTextReader = (filePath) => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return undefined;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
};

const noOpenDocumentSourceReader: OpenDocumentSourceReader = () => undefined;


export class PythonAnalysisContext {
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

  /** The open document's text when it is in the workspace and not a disk-only context. */
  sourceForFile(filePath: string): string | undefined {
    return this.openSourceReader(filePath);
  }

  /** Disk text with a per-file cache; a file is cached as `undefined` after a read miss. */
  sourceForPath(filePath: string): string | undefined {
    if (!filePath) return undefined;
    if (this.cache.has(filePath)) return this.cache.get(filePath);
    const text = this.textReader(filePath);
    this.cache.set(filePath, text);
    return text;
  }

  /** Reads and parses `filePath`, bounded to existing files and the 2 MB limit. */
  sourceForFileAsSource(filePath: string): PythonBoundSource | undefined {
    const text = this.sourceForFile(filePath) ?? this.sourceForPath(filePath);
    if (text === undefined) return undefined;
    return { filePath, text, outline: parsePythonOutline(text) };
  }

  /** Resolves an import specifier to the file it imports, or undefined for stdlib/third-party. */
  resolveSpecifier(fromFile: string, specifier: string): string | undefined {
    const normalized = specifier.replace(/^\.+/, '');
    if (normalized.length === 0) return undefined;

    const baseSegments = normalized.split('.');
    const baseModule = baseSegments[0];
    if (STDLIB_MODULES.has(baseModule)) return undefined;

    const fromDir = path.dirname(fromFile);

    // Absolute import: try `workspaceRoot/base`, then each ancestor of `fromDir`.
    const candidates: string[] = [];
    if (this.workspaceRoot) {
      candidates.push(path.join(this.workspaceRoot, ...baseSegments));
    }
    let dir = fromDir;
    while (dir !== path.dirname(dir)) {
      candidates.push(path.join(dir, ...baseSegments));
      dir = path.dirname(dir);
    }

    // Dot-relative import: `.mod` -> `fromDir/mod`, `.pkg.mod` -> `fromDir/pkg/mod`.
    const dotBare = specifier.replace(/^\.+/, '');
    if (specifier.startsWith('.') && dotBare.length > 0) {
      candidates.push(path.join(fromDir, ...dotBare.split('.')));
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
      const normalizedCandidate = path.normalize(candidate);
      if (seen.has(normalizedCandidate)) continue;
      seen.add(normalizedCandidate);
      const existing = this.firstExisting(normalizedCandidate);
      if (existing) return existing;
    }
    return undefined;
  }

  /** First existing source resolution for a module path (`.py`/`.pyi`/`.pyw`, or `__init__.py`). */
  firstExisting(modulePath: string): string | undefined {
    if (!modulePath) return undefined;
    for (const extension of PYTHON_EXTENSIONS) {
      const file = `${modulePath}${extension}`;
      if (this.exists(file)) return file;
    }
    const initFile = path.join(modulePath, '__init__.py');
    return this.exists(initFile) ? initFile : undefined;
  }

  private exists(filePath: string): boolean {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }
}
