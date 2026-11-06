// Domain model for Bisotun flow extraction.
// This mirrors the JetBrains plugin's `com.bisotun.domain` package (FlowNode/FlowResult/NodeKind/
// ResolutionStatus/SourceRange) but with TypeScript string-literal unions instead of Kotlin enums,
// and no PSI or editor references: every node is plain data so rendering never touches the document.

/** What kind of source construct a FlowNode describes. */
export type NodeKind = 'FUNCTION' | 'COMPONENT' | 'METHOD' | 'MODEL' | 'UNKNOWN';

/** Whether a node of the extracted flow could be resolved to real source or not. */
export type ResolutionStatus = 'RESOLVED' | 'UNRESOLVED';

/** Inclusive, 1-based line range of a FlowNode inside its source file. */
export interface SourceRange {
  startLine: number;
  endLine: number;
}

export const UNKNOWN_RANGE: SourceRange = { startLine: 1, endLine: 1 };

/** Language agnostic flow node: plain data, no editor/document references. */
export interface FlowNode {
  /** Unique id, typically `path:startOffset-endOffset`. Used for dedup in the formatter. */
  id: string;
  displayName: string;
  filePath: string;
  range: SourceRange;
  languageKind: LanguageKind;
  resolutionStatus: ResolutionStatus;
  kind: NodeKind;
  /** Source snippet trimmed; empty allowed. */
  code: string;
}

/** Result of a single extraction run. */
export interface FlowResult {
  root: FlowNode;
  /** Root + crawled nodes, in the order used by the summary and the source listing. */
  nodes: FlowNode[];
  models: FlowNode[];
  /** Rendered verbatim in the markdown output. */
  warnings: string[];
}

export function allNodes(result: FlowResult): FlowNode[] {
  return [result.root, ...result.nodes];
}

/** Languages this plugin can describe (mirrors `LanguageKind` in the JetBrains plugin). */
export type LanguageKind =
  | 'JAVA'
  | 'KOTLIN'
  | 'JS'
  | 'JSX'
  | 'TS'
  | 'TSX'
  | 'PYTHON'
  | 'UNKNOWN';

export interface LanguageKindInfo {
  /** `LanguageKind` values (possibly several aliases) mapped from a file extension. */
  displayName: string;
  codeFence: string;
}

const LANGUAGE_INFO: Record<LanguageKind, LanguageKindInfo> = {
  JAVA: { displayName: 'Java', codeFence: 'java' },
  KOTLIN: { displayName: 'Kotlin', codeFence: 'kotlin' },
  JS: { displayName: 'JavaScript', codeFence: 'javascript' },
  JSX: { displayName: 'JavaScript (JSX)', codeFence: 'javascript' },
  TS: { displayName: 'TypeScript', codeFence: 'typescript' },
  TSX: { displayName: 'TypeScript (TSX)', codeFence: 'typescript' },
  PYTHON: { displayName: 'Python', codeFence: 'python' },
  UNKNOWN: { displayName: 'Unknown', codeFence: 'text' },
};

export function languageKindInfo(kind: LanguageKind): LanguageKindInfo {
  return LANGUAGE_INFO[kind];
}

export function isJsFamily(kind: LanguageKind): boolean {
  return kind === 'JS' || kind === 'JSX' || kind === 'TS' || kind === 'TSX';
}

export function isJavaFamily(kind: LanguageKind): boolean {
  return kind === 'JAVA' || kind === 'KOTLIN';
}

const EXTENSION_TO_KIND: Record<string, LanguageKind> = {
  java: 'JAVA',
  kt: 'KOTLIN',
  kts: 'KOTLIN',
  js: 'JS',
  mjs: 'JS',
  cjs: 'JS',
  jsx: 'JSX',
  ts: 'TS',
  mts: 'TS',
  cts: 'TS',
  tsx: 'TSX',
  py: 'PYTHON',
  pyw: 'PYTHON',
  pyi: 'PYTHON',
};

/** Language kind derived from a file extension (lowercased). Mirrors LanguageKind.fromExtension. */
export function languageKindFromExtension(extension: string | undefined | null): LanguageKind {
  if (!extension) return 'UNKNOWN';
  return EXTENSION_TO_KIND[extension.toLowerCase()] ?? 'UNKNOWN';
}

/** Mirrors `LanguageKind.fromLanguageId`. */
export function languageKindFromLanguageId(languageId: string | undefined | null): LanguageKind {
  const id = languageId?.toLowerCase().trim();
  if (!id) return 'UNKNOWN';
  if (id === 'java') return 'JAVA';
  if (id === 'kotlin') return 'KOTLIN';
  if (id.includes('typescript') && id.includes('jsx')) return 'TSX';
  if (id.includes('typescript')) return 'TS';
  if (id.includes('javascript') && id.includes('jsx')) return 'JSX';
  if (id.includes('javascript') || id.includes('ecmascript')) return 'JS';
  if (id.includes('python') || id === 'py') return 'PYTHON';
  if (id === 'ts' || id === 'tsx' || id === 'js' || id === 'jsx') {
    return languageKindFromExtension(id);
  }
  return 'UNKNOWN';
}
