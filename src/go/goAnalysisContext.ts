// Go source context - resolves files, packages and imports to `GoBoundSource`.
//
// Mirrors `CppAnalysisContext` / `PythonAnalysisContext`: the root file can come from the open
// VS Code document or from disk, sibling files of the same package are read with the same 2 MB cap
// and per-file cache, and Go build constraints (`//go:build`, `// +build` and GOOS/GOARCH file name
// suffixes) are honoured so a flow never points at a file the toolchain would exclude.
//
// Import resolution works from the module path declared in `go.mod` and the `vendor/` directory.
// Standard library packages are never resolved, exactly like standard headers in the C++ tier.

import * as fs from 'fs';
import * as path from 'path';

import { GoFileOutline, parseGoOutline } from './goFileOutline';

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export const GO_OS_VALUES = new Set([
  'aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'hurd', 'illumos', 'ios', 'js', 'linux',
  'netbsd', 'openbsd', 'plan9', 'solaris', 'wasip1', 'windows',
]);

export const GO_ARCH_VALUES = new Set([
  '386', 'amd64', 'arm', 'arm64', 'loong64', 'mips', 'mips64', 'mips64le', 'mipsle', 'ppc64',
  'ppc64le', 'riscv64', 's390x', 'wasm',
]);

const UNIX_OS = new Set([
  'aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'hurd', 'illumos', 'ios', 'linux',
  'netbsd', 'openbsd', 'solaris',
]);

/** The source a file resolves to: its text plus the parsed outline. */
export interface GoBoundSource {
  filePath: string;
  text: string;
  outline: GoFileOutline;
  packageName: string;
  packageDir: string;
}

export type SourceTextReader = (filePath: string) => string | undefined;
export type OpenDocumentSourceReader = (filePath: string) => string | undefined;
export type DirectoryReader = (directory: string) => string[] | undefined;

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

const diskDirectoryReader: DirectoryReader = (directory) => {
  try {
    return fs.readdirSync(directory);
  } catch {
    return undefined;
  }
};

const noOpenDocumentSourceReader: OpenDocumentSourceReader = () => undefined;

/** Platform used for build-constraint evaluation. */
export interface GoPlatform {
  readonly goos: string;
  readonly goarch: string;
  readonly tags: ReadonlySet<string>;
}

export function defaultGoPlatform(): GoPlatform {
  const goos = platformToGoos(process.platform);
  const goarch = platformToGoarch(process.arch);
  return { goos, goarch, tags: defaultTags(goos, goarch) };
}

function platformToGoos(platform: string): string {
  if (platform === 'win32') {
    return 'windows';
  }
  if (platform === 'sunos') {
    return 'solaris';
  }
  return GO_OS_VALUES.has(platform) ? platform : 'linux';
}

function platformToGoarch(arch: string): string {
  if (arch === 'x64') {
    return 'amd64';
  }
  if (arch === 'ia32') {
    return '386';
  }
  if (arch === 'arm') {
    return 'arm';
  }
  return GO_ARCH_VALUES.has(arch) ? arch : 'amd64';
}

function defaultTags(goos: string, goarch: string): ReadonlySet<string> {
  const tags = new Set<string>(['gc', goos, goarch]);
  if (UNIX_OS.has(goos)) {
    tags.add('unix');
  }
  for (let minor = 0; minor <= 23; minor++) {
    tags.add(`go1.${minor}`);
  }
  return tags;
}

export class GoAnalysisContext {
  private readonly cache = new Map<string, string | undefined>();
  private readonly parsedCache = new Map<string, GoBoundSource | undefined>();
  private readonly textReader: SourceTextReader;
  private readonly openSourceReader: OpenDocumentSourceReader;
  private readonly directoryReader: DirectoryReader;
  private readonly platform: GoPlatform;
  private modulePathCache: string | null | undefined;
  private readonly goModuleOverride: string | undefined;

  constructor(options: {
    workspaceRoot?: string;
    textReader?: SourceTextReader;
    openSourceReader?: OpenDocumentSourceReader;
    directoryReader?: DirectoryReader;
    modulePath?: string;
    platform?: GoPlatform;
  } = {}) {
    this.workspaceRoot = options.workspaceRoot ?? '';
    this.textReader = options.textReader ?? diskSourceReader;
    this.openSourceReader = options.openSourceReader ?? noOpenDocumentSourceReader;
    this.directoryReader = options.directoryReader ?? diskDirectoryReader;
    this.platform = options.platform ?? defaultGoPlatform();
    this.goModuleOverride = options.modulePath;
  }

  readonly workspaceRoot: string;

  /** The open document's text, mirroring `sourceForFile`. */
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
  sourceForFileAsSource(filePath: string): GoBoundSource | undefined {
    return this.parsedSource(filePath) ?? undefined;
  }

  /** All buildable `.go` files of the package `source` belongs to, excluding `source` itself. */
  packageSourcesFor(source: GoBoundSource): GoBoundSource[] {
    return this.packageSourcesIn(source.packageDir, source.packageName).filter(
      (candidate) => candidate.filePath !== source.filePath
    );
  }

  /** Every buildable `.go` file of a package, sorted by path. */
  packageSourcesIn(directory: string, packageName?: string): GoBoundSource[] {
    const entries = this.directoryReader(directory);
    if (entries === undefined) {
      return [];
    }
    const result: GoBoundSource[] = [];
    for (const entry of [...entries].sort()) {
      if (!entry.endsWith('.go') || entry.endsWith('_test.go')) {
        continue;
      }
      const filePath = joinPath(directory, entry);
      const source = this.parsedSource(filePath);
      if (source === undefined) {
        continue;
      }
      if (packageName !== undefined && source.packageName !== packageName) {
        continue;
      }
      result.push(source);
    }
    return result;
  }

  /** Resolves an import path from `source` to the sources of the imported package. */
  resolveImport(source: GoBoundSource, importPath: string): GoBoundSource[] | undefined {
    const directory = this.resolveImportDirectory(source, importPath);
    if (directory === undefined) {
      return undefined;
    }
    const sources = this.packageSourcesIn(directory);
    return sources.length > 0 ? sources : undefined;
  }

  /** Directory an import path names, or `undefined` for the standard library / missing packages. */
  resolveImportDirectory(source: GoBoundSource, importPath: string): string | undefined {
    const specifier = importPath.trim();
    if (specifier.length === 0) {
      return undefined;
    }
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
      return this.existingDirectory(path.normalize(joinPath(source.packageDir, specifier)));
    }
    const modulePath = this.modulePath();
    if (modulePath !== null && (specifier === modulePath || specifier.startsWith(`${modulePath}/`))) {
      const relative = specifier.substring(modulePath.length).replace(/^\//, '');
      const directory = relative.length > 0
        ? joinPath(this.workspaceRoot, relative)
        : this.workspaceRoot;
      const existing = this.existingDirectory(directory);
      if (existing !== undefined) {
        return existing;
      }
    }
    const candidates: string[] = [];
    if (this.workspaceRoot.length > 0) {
      candidates.push(joinPath(joinPath(this.workspaceRoot, 'vendor'), specifier));
      candidates.push(joinPath(this.workspaceRoot, specifier));
    }
    for (const candidate of candidates) {
      const existing = this.existingDirectory(path.normalize(candidate));
      if (existing !== undefined) {
        return existing;
      }
    }
    return undefined;
  }

  /** Module path from `go.mod`, `null` when the file is missing or has no `module` directive. */
  modulePath(): string | null {
    if (this.goModuleOverride !== undefined) {
      return this.goModuleOverride;
    }
    if (this.modulePathCache !== undefined) {
      return this.modulePathCache;
    }
    this.modulePathCache = null;
    if (this.workspaceRoot.length > 0) {
      const goMod = this.sourceForPath(joinPath(this.workspaceRoot, 'go.mod'));
      if (goMod !== undefined) {
        const match = /^\s*module\s+(\S+)/m.exec(goMod);
        if (match) {
          this.modulePathCache = match[1];
        }
      }
    }
    return this.modulePathCache;
  }

  platformInfo(): GoPlatform {
    return this.platform;
  }

  private parsedSource(filePath: string): GoBoundSource | undefined {
    if (this.parsedCache.has(filePath)) {
      return this.parsedCache.get(filePath);
    }
    const text = this.sourceForFile(filePath) ?? this.sourceForPath(filePath);
    if (text === undefined) {
      this.parsedCache.set(filePath, undefined);
      return undefined;
    }
    if (!fileMatchesBuildConstraints(text, filePath, this.platform)) {
      this.parsedCache.set(filePath, undefined);
      return undefined;
    }
    const outline = parseGoOutline(text);
    const source: GoBoundSource = {
      filePath,
      text,
      outline,
      packageName: outline.packageName,
      packageDir: dirnameOf(filePath),
    };
    this.parsedCache.set(filePath, source);
    return source;
  }

  private existingDirectory(directory: string): string | undefined {
    const entries = this.directoryReader(directory);
    return entries === undefined ? undefined : directory;
  }
}

/**
 * Whether a `.go` file is built for the current platform: GOOS/GOARCH file-name suffixes plus the
 * `//go:build` expression (or the legacy `// +build` lines when no `//go:build` line exists).
 */
export function fileMatchesBuildConstraints(
  text: string,
  fileName: string,
  platform: GoPlatform
): boolean {
  if (!suffixMatchesPlatform(baseNameOf(fileName), platform)) {
    return false;
  }
  const tags = new Set<string>(platform.tags);
  tags.add(platform.goos);
  tags.add(platform.goarch);
  const header = leadingHeaderLines(text);
  const goBuild = header
    .map((line) => /^\/\/go:build\s+(.+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null);
  if (goBuild.length > 0) {
    return goBuild.every((match) => evaluateBuildExpression(match[1], tags));
  }
  const plusBuild = header
    .map((line) => /^\/\/\s*\+build\s+(.+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null);
  return plusBuild.every((match) => evaluatePlusBuild(match[1], tags));
}

/** Lines before the `package` clause (where build constraints must live). */
function leadingHeaderLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*package\s+[A-Za-z_]/.test(line)) {
      break;
    }
    lines.push(line);
  }
  return lines;
}

function suffixMatchesPlatform(fileName: string, platform: GoPlatform): boolean {
  const stem = fileName.replace(/\.go$/i, '');
  const parts = stem.split('_');
  if (parts.length < 2) {
    return true;
  }
  const last = parts[parts.length - 1];
  if (GO_ARCH_VALUES.has(last)) {
    if (last !== platform.goarch) {
      return false;
    }
    const previous = parts[parts.length - 2];
    if (GO_OS_VALUES.has(previous) && previous !== platform.goos) {
      return false;
    }
    return true;
  }
  if (GO_OS_VALUES.has(last)) {
    return last === platform.goos;
  }
  return true;
}

/** Evaluates a `//go:build` expression: `!`, `&&`, `||`, parentheses and tag identifiers. */
export function evaluateBuildExpression(expression: string, tags: ReadonlySet<string>): boolean {
  const tokens = expression.match(/[A-Za-z0-9_.]+|&&|\|\||!|\(|\)/g) ?? [];
  let index = 0;
  const peek = (): string | undefined => tokens[index];
  const parseOr = (): boolean => {
    let value = parseAnd();
    while (peek() === '||') {
      index++;
      const right = parseAnd();
      value = value || right;
    }
    return value;
  };
  const parseAnd = (): boolean => {
    let value = parseUnary();
    while (peek() === '&&') {
      index++;
      const right = parseUnary();
      value = value && right;
    }
    return value;
  };
  const parseUnary = (): boolean => {
    const token = peek();
    if (token === undefined) {
      return false;
    }
    if (token === '!') {
      index++;
      return !parseUnary();
    }
    if (token === '(') {
      index++;
      const value = parseOr();
      if (peek() === ')') {
        index++;
      }
      return value;
    }
    index++;
    return tagValue(token, tags);
  };
  return parseOr();
}

/** Legacy `// +build` line: space-separated options (OR), commas inside an option (AND). */
export function evaluatePlusBuild(expression: string, tags: ReadonlySet<string>): boolean {
  const options = expression.trim().split(/\s+/).filter((option) => option.length > 0);
  if (options.length === 0) {
    return true;
  }
  return options.some((option) =>
    option.split(',').every((term) => {
      if (term.startsWith('!')) {
        return !tagValue(term.substring(1), tags);
      }
      return tagValue(term, tags);
    })
  );
}

function tagValue(tag: string, tags: ReadonlySet<string>): boolean {
  if (tag === 'cgo') {
    return false;
  }
  if (/^go1\.\d+$/.test(tag)) {
    return tags.has(tag);
  }
  return tags.has(tag);
}

function baseNameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.substring(index + 1) : normalized;
}

function dirnameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.substring(0, index) : normalized;
}

function joinPath(directory: string, relative: string): string {
  if (relative.length === 0) {
    return directory;
  }
  const base = directory.replace(/\/+$/, '');
  return `${base}/${relative.replace(/^\/+/, '')}`;
}
