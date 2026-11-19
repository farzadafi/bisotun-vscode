// Hand written Go tokenizer, the tokenizer tier of the Go extraction strategy.
//
// Same contract as the JS/TS, Python and C++ tokenizers: a state machine, never a regex scan, that
// understands line comments, block comments, interpreted strings, rune literals and raw string
// literals. In addition it performs Go's automatic semicolon insertion, so the outline can work on
// statements (`x := 1`, `var a, b int`) without re-deriving line boundaries.
//
// It deliberately does not build an AST: constructs it cannot understand are consumed
// conservatively so a call is never invented from text inside a comment or a string.

export type GoTokenType = 'IDENTIFIER' | 'KEYWORD' | 'STRING' | 'NUMBER' | 'PUNCTUATION';

export interface GoToken {
  readonly type: GoTokenType;
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly line: number;
  /** True for the `;` the scanner inserts at a line break / end of file. */
  readonly implicit?: boolean;
}

export interface GoComment {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly line: number;
}

export interface GoTokenStream {
  readonly tokens: GoToken[];
  readonly comments: GoComment[];
}

export const GO_KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
  'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range',
  'return', 'select', 'struct', 'switch', 'type', 'var',
]);

/** Multi-character operators, longest first so `<<=` never tokenizes as `<<` + `=`. */
const OPERATORS = [
  '<<=', '>>=', '&^=', '...', ':=', '<-', '++', '--', '&&', '||', '<<', '>>', '==', '!=',
  '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '&^',
];

/** Keywords after which Go inserts a semicolon at a line break. */
const SEMICOLON_KEYWORDS = new Set(['break', 'continue', 'fallthrough', 'return']);

export function isGoIdentifierStart(ch: string): boolean {
  return ch === '_' || /[A-Za-z]/.test(ch);
}

export function isGoIdentifierPart(ch: string): boolean {
  return ch === '_' || /[A-Za-z0-9]/.test(ch);
}

export class GoTokenizer {
  private readonly tokens: GoToken[] = [];
  private readonly comments: GoComment[] = [];
  private index = 0;
  private line = 1;

  constructor(private readonly text: string) {}

  tokenize(): GoTokenStream {
    const text = this.text;
    while (this.index < text.length) {
      const ch = text[this.index];
      if (ch === '\n') {
        this.insertSemicolon(this.index, this.line);
        this.line++;
        this.index++;
      } else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\u000b' || ch === '\f') {
        this.index++;
      } else if (ch === '/' && text[this.index + 1] === '/') {
        this.skipLineComment();
      } else if (ch === '/' && text[this.index + 1] === '*') {
        this.skipBlockComment();
      } else if (ch === '"') {
        this.readInterpretedString('"', 'STRING');
      } else if (ch === '`') {
        this.readRawString();
      } else if (ch === '\'') {
        this.readInterpretedString('\'', 'STRING');
      } else if (isGoIdentifierStart(ch)) {
        this.readIdentifier();
      } else if (ch >= '0' && ch <= '9') {
        this.readNumber();
      } else if (ch === '.' && text[this.index + 1] >= '0' && text[this.index + 1] <= '9') {
        this.readNumber();
      } else {
        this.readPunctuation();
      }
    }
    this.insertSemicolon(this.text.length, this.line);
    return { tokens: this.tokens, comments: this.comments };
  }

  private push(type: GoTokenType, start: number, end: number, line: number): void {
    const text = this.text.substring(start, end);
    // Collapse `;;` (an explicit semicolon right after an inserted one) into one separator.
    const previous = this.tokens[this.tokens.length - 1];
    if (text === ';' && previous !== undefined && previous.text === ';') {
      return;
    }
    this.tokens.push({ type, text, startOffset: start, endOffset: end, line });
  }

  /** Go automatic semicolon insertion: only after a token that can end a statement. */
  private insertSemicolon(offset: number, line: number): void {
    const previous = this.tokens[this.tokens.length - 1];
    if (previous === undefined || previous.text === ';') {
      return;
    }
    if (!canEndStatement(previous)) {
      return;
    }
    this.tokens.push({ type: 'PUNCTUATION', text: ';', startOffset: offset, endOffset: offset, line, implicit: true });
  }

  private skipLineComment(): void {
    const start = this.index;
    const startLine = this.line;
    this.index += 2;
    while (this.index < this.text.length && this.text[this.index] !== '\n') {
      this.index++;
    }
    this.comments.push({
      text: this.text.substring(start, this.index),
      startOffset: start,
      endOffset: this.index,
      line: startLine,
    });
  }

  private skipBlockComment(): void {
    const start = this.index;
    const startLine = this.line;
    this.index += 2;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === '\n') {
        this.line++;
        this.index++;
      } else if (ch === '*' && this.text[this.index + 1] === '/') {
        this.index += 2;
        break;
      } else {
        this.index++;
      }
    }
    this.comments.push({
      text: this.text.substring(start, this.index),
      startOffset: start,
      endOffset: this.index,
      line: startLine,
    });
  }

  private readInterpretedString(quote: string, type: GoTokenType): void {
    const start = this.index;
    const startLine = this.line;
    this.index++;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === '\\') {
        if (this.text[this.index + 1] === '\n') {
          this.line++;
        }
        this.index = Math.min(this.index + 2, this.text.length);
      } else if (ch === quote) {
        this.index++;
        this.push(type, start, this.index, startLine);
        return;
      } else if (ch === '\n') {
        // Unterminated literal: stop at the line end instead of swallowing the file.
        this.push(type, start, this.index, startLine);
        return;
      } else {
        this.index++;
      }
    }
    this.push(type, start, this.index, startLine);
  }

  /** Backtick raw string; may span lines and contains no escapes. */
  private readRawString(): void {
    const start = this.index;
    const startLine = this.line;
    this.index++;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === '`') {
        this.index++;
        break;
      }
      if (ch === '\n') {
        this.line++;
      }
      this.index++;
    }
    this.push('STRING', start, this.index, startLine);
  }

  private readIdentifier(): void {
    const start = this.index;
    const startLine = this.line;
    while (this.index < this.text.length && isGoIdentifierPart(this.text[this.index])) {
      this.index++;
    }
    const value = this.text.substring(start, this.index);
    this.push(GO_KEYWORDS.has(value) ? 'KEYWORD' : 'IDENTIFIER', start, this.index, startLine);
  }

  private readNumber(): void {
    const start = this.index;
    const startLine = this.line;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (/[0-9A-Za-z_.]/.test(ch) || ch === '\'') {
        this.index++;
      } else if (
        (ch === '+' || ch === '-') &&
        /[eEpP]/.test(this.text[this.index - 1] ?? '')
      ) {
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

/** Mirrors go/scanner: which tokens allow an inserted `;` at the following line break. */
function canEndStatement(token: GoToken): boolean {
  if (token.type === 'IDENTIFIER' || token.type === 'NUMBER' || token.type === 'STRING') {
    return true;
  }
  if (token.type === 'KEYWORD') {
    return SEMICOLON_KEYWORDS.has(token.text);
  }
  return token.text === ')' || token.text === ']' || token.text === '}' || token.text === '++' || token.text === '--';
}
