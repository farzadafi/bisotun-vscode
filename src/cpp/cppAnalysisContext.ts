// C++ source context - resolves files and `#include` specifiers to `CppBoundSource`.
//
// Mirrors `JsAnalysisContext` / `PythonAnalysisContext`: the root file can come from the open
// VS Code document (`sourceForFile`) or from disk (`sourceForPath`), included headers are read from
// disk with the same 2 MB cap and per-file cache, and standard library headers are never resolved
// (so `<vector>` can never pull a system header into a flow).

import * as fs from 'fs';
import * as path from 'path';

import { CppFileOutline, parseCppOutline } from './cppFileOutline';

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Header and source extensions tried when an include omits the extension. */
export const CPP_EXTENSIONS = [
  'h', 'hpp', 'hh', 'hxx', 'h++', 'ipp', 'inl', 'tpp', 'cpp', 'cc', 'cxx', 'c++', 'cp',
] as const;

/**
 * Common C++ standard library headers. `#include <...>` naming one of these is ecosystem
 * plumbing, exactly like a Python stdlib import: it never expands into the flow.
 */
export const CPP_STD_HEADERS = new Set([
  'algorithm', 'any', 'array', 'atomic', 'barrier', 'bit', 'bitset', 'cassert', 'cctype',
  'cerrno', 'cfenv', 'cfloat', 'charconv', 'chrono', 'cinttypes', 'climits', 'clocale',
  'cmath', 'codecvt', 'compare', 'complex', 'concepts', 'condition_variable', 'coroutine',
  'csetjmp', 'csignal', 'cstdarg', 'cstddef', 'cstdint', 'cstdio', 'cstdlib', 'cstring',
  'ctime', 'cuchar', 'cwchar', 'cwctype', 'deque', 'exception', 'execution', 'filesystem',
  'format', 'forward_list', 'fstream', 'functional', 'future', 'initializer_list', 'iomanip',
  'ios', 'iosfwd', 'iostream', 'istream', 'iterator', 'latch', 'limits', 'list', 'locale',
  'map', 'memory', 'memory_resource', 'mutex', 'new', 'numbers', 'numeric', 'optional',
  'ostream', 'queue', 'random', 'ranges', 'ratio', 'regex', 'scoped_allocator', 'semaphore',
  'set', 'shared_mutex', 'source_location', 'span', 'sstream', 'stack', 'stdexcept',
  'stop_token', 'streambuf', 'string', 'string_view', 'strstream', 'syncstream', 'system_error',
  'thread', 'tuple', 'type_traits', 'typeindex', 'typeinfo', 'unordered_map', 'unordered_set',
  'utility', 'valarray', 'variant', 'vector', 'version', 'cstdint', 'stdfloat', 'expected',
  'flat_map', 'flat_set', 'mdspan', 'print', 'spanstream', 'stacktrace', 'bits',
  'assert.h', 'ctype.h', 'errno.h', 'float.h', 'limits.h', 'locale.h', 'math.h', 'setjmp.h',
  'signal.h', 'stdarg.h', 'stddef.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'string.h', 'time.h',
  'wchar.h', 'wctype.h', 'unistd.h', 'pthread.h', 'sys/types.h', 'sys/stat.h', 'sys/time.h',
]);

/**
 * The source a file resolves to: its text plus the parsed outline. The resolver works against this
 * struct so both the open document and the disk cache share one code path.
 */
export interface CppBoundSource {
  filePath: string;
  text: string;
  outline: CppFileOutline;
}

/** Seam for reading a file, mirroring the JetBrains `AnalysisContext` disk reader. */
export type SourceTextReader = (filePath: string) => string | undefined;

/** Reads the currently open document's text, mirroring the plugin's `sourceForFile`. */
export type OpenDocumentSourceReader = (filePath: string) => string | undefined;

const diskSourceReader: SourceTextReader = (filePath) => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
      return undefined;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
};

const noOpenDocumentSourceReader: OpenDocumentSourceReader = () => undefined;

export class CppAnalysisContext {
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
    if (!filePath) {
      return undefined;
    }
    if (this.cache.has(filePath)) {
      return this.cache.get(filePath);
    }
    const text = this.textReader(filePath);
    this.cache.set(filePath, text);
    return text;
  }

  /** Reads and parses `filePath`, bounded to existing files and the 2 MB limit. */
  sourceForFileAsSource(filePath: string): CppBoundSource | undefined {
    const text = this.sourceForFile(filePath) ?? this.sourceForPath(filePath);
    if (text === undefined) {
      return undefined;
    }
    return { filePath, text, outline: parseCppOutline(text) };
  }

  /**
   * Resolves an include to the header/source it names.
   *
   * Quoted includes are resolved relative to the including file (and its ancestors up to the
   * workspace root), then through the usual `include/` and `src/` roots. Angle includes only resolve
   * inside the workspace, and standard library headers are rejected outright so a project flow can
   * never point at `<vector>`.
   */
  resolveInclude(
    fromFile: string,
    include: { specifier: string; isSystem: boolean }
  ): string | undefined {
    const specifier = include.specifier.replace(/\\/g, '/').trim();
    if (specifier.length === 0 || specifier.includes('..\\..\\..\\..\\')) {
      return undefined;
    }
    const firstSegment = specifier.split('/')[0];
    if (include.isSystem && CPP_STD_HEADERS.has(firstSegment)) {
      return undefined;
    }

    const candidates: string[] = [];
    const root = this.workspaceRoot;

    if (!include.isSystem) {
      let directory = dirnameOf(fromFile);
      for (let depth = 0; depth < 8; depth++) {
        candidates.push(path.normalize(path.join(directory, specifier)));
        if (root.length === 0) {
          break;
        }
        const parent = path.dirname(directory);
        if (parent === directory || !isInside(root, parent)) {
          break;
        }
        directory = parent;
      }
    }

    if (root.length > 0) {
      candidates.push(path.normalize(path.join(root, specifier)));
      candidates.push(path.normalize(path.join(root, 'include', specifier)));
      candidates.push(path.normalize(path.join(root, 'src', specifier)));
      if (!include.isSystem) {
        candidates.push(path.normalize(path.join(root, '..', 'include', specifier)));
      }
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      const existing = this.firstExisting(candidate);
      if (existing) {
        return existing;
      }
    }
    return undefined;
  }

  /** First existing file for a candidate path, trying the known C++ extensions when it has none. */
  firstExisting(candidate: string): string | undefined {
    if (this.exists(candidate)) {
      return candidate;
    }
    const leaf = candidate.split('/').pop() ?? '';
    if (leaf.includes('.')) {
      return undefined;
    }
    for (const extension of CPP_EXTENSIONS) {
      const file = `${candidate}.${extension}`;
      if (this.exists(file)) {
        return file;
      }
    }
    return undefined;
  }

  private exists(filePath: string): boolean {
    try {
      const stat = fs.statSync(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }
}

function dirnameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.substring(0, index) : normalized;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
