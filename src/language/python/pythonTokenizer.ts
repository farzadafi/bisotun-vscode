// Python tokenizer (port of the JetBrains plugin's `PythonTokenizer`).
//
// This is the "tokenizer tier" of the Python strategy: a hand written,
// indentation-aware tokenizer that mirrors `com.bisotun.language.PythonTokenizer`
// from the JetBrains plugin. It understands strings including f-strings and
// triple-quoted strings, comments, indentation (leading whitespace per line)
// and bracket/backslash continuation lines. It does NOT attempt full Python
// parsing - anything it cannot understand is simply consumed conservatively so
// that calls are never invented.

export enum PythonTokenType {
  IDENTIFIER = 'IDENTIFIER',
  KEYWORD = 'KEYWORD',
  STRING = 'STRING',
  NUMBER = 'NUMBER',
  PUNCTUATION = 'PUNCTUATION',
}

/** A single token of a Python source file. */
export interface PythonToken {
  type: PythonTokenType;
  text: string;
  startOffset: number;
  endOffset: number;
  line: number;
  indent: number;
}

const PYTHON_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import',
  'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'True', 'try', 'while', 'with', 'yield',
]);

function isIdentifierStart(c: string): boolean {
  return c === '_' || /[A-Za-z]/.test(c);
}

function isIdentifierPart(c: string): boolean {
  return c === '_' || /[A-Za-z0-9]/.test(c);
}

/** Returns true if the text starting at `i` begins a string literal (with an optional r/b/u/f prefix). */
function isStringPrefix(s: string, i: number, n: number): boolean {
  let j = i;
  let prefixChars = 0;
  while (j < n && prefixChars < 3) {
    const ch = s[j];
    if (/[rubfRUBF]/.test(ch)) {
      j++;
      prefixChars++;
    } else {
      break;
    }
  }
  return prefixChars > 0 && j < n && (s[j] === "'" || s[j] === '"');
}

/** Consumes one string literal (including triple-quoted and prefixed). Returns the index just after it. */
function consumeString(s: string, i: number, n: number): number {
  // skip prefix letters (r, b, u, f and combinations)
  let j = i;
  while (j < n && /[rubfRUBF]/.test(s[j])) j++;
  if (j >= n) return i + 1;
  const quote = s[j];
  if (quote !== "'" && quote !== '"') return i + 1;
  const triple = j + 2 < n && s[j + 1] === quote && s[j + 2] === quote;
  j = j + (triple ? 3 : 1);
  while (j < n) {
    if (s[j] === '\\') {
      j += 2;
      continue;
    }
    if (triple) {
      if (j + 2 < n && s[j] === quote && s[j + 1] === quote && s[j + 2] === quote) return j + 3;
    } else {
      if (s[j] === quote) return j + 1;
      if (s[j] === '\n') return j + 1; // unterminated single-line string; do not run off the line
    }
    j++;
  }
  return n;
}

function indentOf(s: string, lineStart: number, tokenStart: number): number {
  let col = 0;
  let k = lineStart;
  while (k < tokenStart && col < 255) {
    const ch = s[k];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4;
    else return col;
    k++;
  }
  return col;
}

/** A minimal Python tokenizer. */
export class PythonTokenizer {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  tokenize(): PythonToken[] {
    const text = this.text;
    const n = text.length;
    const result: PythonToken[] = [];
    let i = 0;
    let line = 1;
    let lineStart = 0;

    while (i < n) {
      const c = text[i];
      const tokenStart = i;
      const tLine = line;
      const tLineStart = lineStart;
      if (c === '\n') {
        i++;
        line++;
        lineStart = i;
        continue;
      }
      if (c === ' ' || c === '\t') {
        i++;
        continue;
      }
      if (c === '#') {
        i = this.skipComment(i);
        continue;
      }
      if (isStringPrefix(text, i, n)) {
        const start = i;
        const end = consumeString(text, i, n);
        const raw = text.substring(start, end);
        result.push({ type: PythonTokenType.STRING, text: raw, startOffset: start, endOffset: end, line: tLine, indent: indentOf(text, tLineStart, start) });
        i = end;
        continue;
      }
      if (isIdentifierStart(c)) {
        const start = i;
        while (i < n && isIdentifierPart(text[i])) i++;
        const raw = text.substring(start, i);
        const type = PYTHON_KEYWORDS.has(raw) ? PythonTokenType.KEYWORD : PythonTokenType.IDENTIFIER;
        result.push({ type, text: raw, startOffset: start, endOffset: i, line: tLine, indent: indentOf(text, tLineStart, start) });
        continue;
      }
      if (/[0-9]/.test(c)) {
        const start = i;
        while (i < n && (/[A-Za-z0-9_.]/.test(text[i]))) i++;
        const raw = text.substring(start, i);
        result.push({ type: PythonTokenType.NUMBER, text: raw, startOffset: start, endOffset: i, line: tLine, indent: indentOf(text, tLineStart, start) });
        continue;
      }
      // anything else is a single punctuation token
      const start = i;
      i++;
      const raw = text.substring(start, i);
      result.push({ type: PythonTokenType.PUNCTUATION, text: raw, startOffset: start, endOffset: i, line: tLine, indent: indentOf(text, tLineStart, start) });
    }
    return result;
  }

  private skipComment(i: number): number {
    let j = i;
    const text = this.text;
    while (j < text.length && text[j] !== '\n') j++;
    return j;
  }
}
