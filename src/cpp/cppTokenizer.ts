// Hand written C++ tokenizer, the tokenizer tier of the C++ extraction strategy.
//
// Like the JS/TS and Python tokenizers this is a state machine, not a regex scanner: it understands
// line/block comments, string and character literals (including raw string literals with arbitrary
// delimiters and `'` digit separators) and preprocessor directives. A directive is kept as a single
// DIRECTIVE token covering its whole logical line (with `\` continuations), so macro bodies can never
// leak calls into the flow and no preprocessor noise reaches the outline.
//
// It deliberately does not attempt full C++ parsing: constructs it cannot understand are consumed
// conservatively so that a call is never invented from text inside a comment or a string.

export type CppTokenType =
  | 'IDENTIFIER'
  | 'KEYWORD'
  | 'STRING'
  | 'NUMBER'
  | 'PUNCTUATION'
  | 'DIRECTIVE';

export interface CppToken {
  readonly type: CppTokenType;
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly line: number;
}

const KEYWORDS = new Set([
  'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor', 'bool', 'break',
  'case', 'catch', 'char', 'char8_t', 'char16_t', 'char32_t', 'class', 'co_await', 'co_return',
  'co_yield', 'compl', 'concept', 'const', 'consteval', 'constexpr', 'constinit', 'const_cast',
  'continue', 'decltype', 'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum',
  'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'goto', 'if', 'inline',
  'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'not_eq', 'nullptr',
  'operator', 'or', 'or_eq', 'private', 'protected', 'public', 'register', 'reinterpret_cast',
  'requires', 'return', 'short', 'signed', 'sizeof', 'static', 'static_assert', 'static_cast',
  'struct', 'switch', 'template', 'this', 'thread_local', 'throw', 'true', 'try', 'typedef',
  'typeid', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'wchar_t',
  'while', 'xor', 'xor_eq',
]);

/** Multi-character operators, longest first so `<=>` never tokenizes as `<=` + `>`. */
const OPERATORS = [
  '->*', '<=>', '>>=', '<<=', '...', '::', '->', '.*', '++', '--', '<<', '>>', '<=', '>=',
  '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##',
];

/** Raw string prefixes: `R"(...)"`, `LR"d(...)d"`, `u8R"d(...)d"`, ... */
const RAW_STRING_PREFIXES = new Set(['R', 'LR', 'uR', 'UR', 'u8R']);

export function isCppIdentifierStart(ch: string): boolean {
  return ch === '_' || ch === '$' || /[A-Za-z]/.test(ch);
}

export function isCppIdentifierPart(ch: string): boolean {
  return ch === '_' || ch === '$' || /[A-Za-z0-9]/.test(ch);
}

export class CppTokenizer {
  private readonly tokens: CppToken[] = [];
  private index = 0;
  private line = 1;
  /** True until the first token of a line is produced; directives may be indented. */
  private lineStart = true;

  constructor(private readonly text: string) {}

  tokenize(): CppToken[] {
    const text = this.text;
    while (this.index < text.length) {
      const ch = text[this.index];
      if (ch === '\n') {
        this.line++;
        this.lineStart = true;
        this.index++;
      } else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\u000b' || ch === '\f') {
        this.index++;
      } else if (ch === '#' && this.lineStart) {
        this.readDirective();
      } else if (ch === '/' && text[this.index + 1] === '/') {
        this.skipLineComment();
      } else if (ch === '/' && text[this.index + 1] === '*') {
        this.skipBlockComment();
      } else if (ch === '"' || ch === "'") {
        this.readQuoted(ch);
      } else if (isCppIdentifierStart(ch)) {
        this.readIdentifier();
      } else if (ch >= '0' && ch <= '9') {
        this.readNumber();
      } else {
        this.readPunctuation();
      }
    }
    return this.tokens;
  }

  private push(type: CppTokenType, start: number, end: number, line: number): void {
    this.tokens.push({ type, text: this.text.substring(start, end), startOffset: start, endOffset: end, line });
    this.lineStart = false;
  }

  private skipLineComment(): void {
    this.index += 2;
    while (this.index < this.text.length && this.text[this.index] !== '\n') this.index++;
  }

  private skipBlockComment(): void {
    this.index += 2;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === '\n') {
        this.line++;
        this.lineStart = true;
        this.index++;
      } else if (ch === '*' && this.text[this.index + 1] === '/') {
        this.index += 2;
        return;
      } else {
        this.index++;
      }
    }
  }

  /** One `#...` logical line; `\` continuations and an unterminated directive end at EOF. */
  private readDirective(): void {
    const start = this.index;
    const startLine = this.line;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === '\n') {
        if (this.text[this.index - 1] === '\\') {
          this.line++;
          this.index++;
          continue;
        }
        break;
      }
      if (ch === '\\' && this.text[this.index + 1] === '\n') {
        this.line++;
        this.index += 2;
        continue;
      }
      this.index++;
    }
    this.push('DIRECTIVE', start, this.index, startLine);
  }

  private readQuoted(quote: string): void {
    const start = this.index;
    const startLine = this.line;
    this.index++;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === '\\') {
        // Keep the escaped character inside the literal (and its line count correct).
        if (this.text[this.index + 1] === '\n') this.line++;
        this.index = Math.min(this.index + 2, this.text.length);
      } else if (ch === quote) {
        this.index++;
        this.push('STRING', start, this.index, startLine);
        return;
      } else if (ch === '\n') {
        // Unterminated literal: stop at the line end instead of swallowing the file.
        this.push('STRING', start, this.index, startLine);
        return;
      } else {
        this.index++;
      }
    }
    this.push('STRING', start, this.index, startLine);
  }

  /** `"delimiter(...)delimiter"` body of a raw string; `this.index` is on the opening quote. */
  private readRawStringBody(): void {
    const start = this.index;
    const startLine = this.line;
    this.index++; // opening quote
    const delimiterStart = this.index;
    let paren = this.text.indexOf('(', this.index);
    if (paren === -1 || paren - delimiterStart > 16) {
      // Not a valid raw string: consume conservatively to the end of the line.
      while (this.index < this.text.length && this.text[this.index] !== '\n') this.index++;
      this.push('STRING', start, this.index, startLine);
      return;
    }
    const delimiter = this.text.substring(delimiterStart, paren);
    const terminator = `)${delimiter}"`;
    const close = this.text.indexOf(terminator, paren + 1);
    if (close === -1) {
      this.index = this.text.length;
    } else {
      this.index = close + terminator.length;
    }
    for (let i = start; i < this.index; i++) if (this.text[i] === '\n') this.line++;
    this.push('STRING', start, this.index, startLine);
  }

  private readIdentifier(): void {
    const start = this.index;
    const startLine = this.line;
    while (this.index < this.text.length && isCppIdentifierPart(this.text[this.index])) this.index++;
    const value = this.text.substring(start, this.index);
    if (RAW_STRING_PREFIXES.has(value) && this.text[this.index] === '"') {
      this.readRawStringBody();
      return;
    }
    this.push(KEYWORDS.has(value) ? 'KEYWORD' : 'IDENTIFIER', start, this.index, startLine);
  }

  private readNumber(): void {
    const start = this.index;
    const startLine = this.line;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (/[A-Za-z0-9._]/.test(ch)) {
        this.index++;
      } else if (ch === "'" && /[0-9A-Fa-f]/.test(this.text[this.index + 1] ?? '')) {
        // C++14 digit separator: 1'000'000
        this.index++;
      } else {
        break;
      }
    }
    this.push('NUMBER', start, this.index, startLine);
  }

  private readPunctuation(): void {
    const start = this.index;
    const startLine = this.line;
    let length = 1;
    for (const operator of OPERATORS) {
      if (this.text.startsWith(operator, this.index)) {
        length = operator.length;
        break;
      }
    }
    this.index = Math.min(this.index + length, this.text.length);
    this.push('PUNCTUATION', start, this.index, startLine);
  }
}
