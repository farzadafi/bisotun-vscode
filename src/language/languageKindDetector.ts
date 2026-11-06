  import {
  LanguageKind,
  isJsFamily,
  languageKindFromExtension,
  languageKindFromLanguageId,
} from '../core/types';

/**
 * Resolves the LanguageKind of a file.
 * The editor language id is authoritative when a real language parser exists; otherwise (for
 * example a plain-text file with a recognized extension) the file extension is used. JSX/TSX share
 * the JavaScript/TypeScript language id, so the extension wins for those two.
 *
 * Mirrors the JetBrains plugin's `LanguageKindDetector`.
 */
export function detectLanguageKind(opts: {
  languageId?: string | undefined;
  fileName?: string | undefined;
}): LanguageKind {
  const byLanguage = languageKindFromLanguageId(opts.languageId);
  const byExtension = languageKindFromExtension(extensionOf(opts.fileName));
  return merge(byLanguage, byExtension);
}

export function extensionOf(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const base = fileName.replace(/\\/g, '/');
  const lastSlash = base.lastIndexOf('/');
  const name = lastSlash >= 0 ? base.substring(lastSlash + 1) : base;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.substring(dot + 1) : undefined;
}

function merge(byLanguage: LanguageKind, byExtension: LanguageKind): LanguageKind {
  if (byExtension === 'UNKNOWN') return byLanguage;
  if (byLanguage === 'UNKNOWN') return byExtension;
  if (byExtension === 'JSX' || byExtension === 'TSX') return byExtension;
  if (byExtension === 'PYTHON') return byExtension;
  if (isJsFamily(byLanguage) && isJsFamily(byExtension)) return byExtension;
  return byLanguage;
}
