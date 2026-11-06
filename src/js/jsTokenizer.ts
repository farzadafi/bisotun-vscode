/**
 * Hand written JavaScript/TypeScript tokenizer, ported 1:1 from the JetBrains plugin's
 * `JsTokenizer` (part of the single JS/TS extraction strategy).
 *
 * This is deliberately not a regex scanner: it is a state machine that understands line comments,
 * block comments, single/double quoted strings and template literals (including `${...}`
 * interpolations with arbitrary nesting) so that no call is ever detected inside a string or a
 * comment. Regex literal bodies are not special cased; that mirrors the Kotlin behaviour exactly.
 */

export type JsTokenType = 'IDENTIFIER' | 'KEYWORD' | 'STRING' | 'NUMBER' | 'PUNCTUATION';

export interface JsToken {
  type: JsTokenType;
  text: string;
  startOffset: number;
  endOffset: number;
  line: number;
}

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
  'function', 'const', 'let', 'var', 'class', 'extends', 'super', 'new', 'typeof', 'instanceof',
  'in', 'of', 'try', 'catch', 'finally', 'throw', 'import', 'export', 'from', 'as', 'interface',
  'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly', 'abstract',
  'static', 'async', 'await', 'yield', 'this', 'null', 'undefined', 'true', 'false', 'delete',
  'void', 'get', 'set', 'declare'
]);

const TWO_CHAR_OPERATORS = new Set([
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=',
  '**', '<<', '>>', '|=', '&=', '%='
]);

const THREE_CHAR_OPERATORS = new Set(['===', '!==', '...', '**=', '<<=', '>>=', '??=', '&&=', '||=']);

/** Character classes used by the tokenizer. */
export function isIdentifierStart(ch: string): boolean {
  return ch === '_' || ch === '$' || /[a-zA-Z]/.test(ch);
}

export function isIdentifierPart(ch: string): boolean {
  return ch === '_' || ch === '$' || /[a-zA-Z0-9]/.test(ch);
}

export class JsTokenizer {
  private readonly tokens: JsToken[] = [];
  private index = 0;
  private line = 1;

  constructor(private readonly text: string) {}

  tokenize(): JsToken[] {
    const text = this.text;
    while (this.index < text.length) {
      const ch = text[this.index];
      if (ch === '\n') {
        this.advanceLine();
      } else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\u000b' || ch === '\f') {
        this.index++;
      } else if (ch === '/' && this.peek(1) === '/') {
        this.skipLineComment();
      } else if (ch === '/' && this.peek(1) === '*') {
        this.skipBlockComment();
      } else if (ch === "'" || ch === '"') {
        this.readQuotedString(ch);
      } else if (ch === '`') {
        this.readTemplateLiteral();
      } else if (isIdentifierStart(ch)) {
        this.readIdentifier();
      } else if (ch >= '0' && ch <= '9') {
        this.readNumber();
      } else {
        this.readPunctuation();
      }
    }
    return this.tokens;
  }


  private advanceLine(): void {
    if (this.index < this.text.length && this.text[this.index] === '\n') this.line++;
    this.index++;
  }

  private peek(offset: number): string | undefined {
    return this.text[this.index + offset] ?? undefined;
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
        this.advanceLine();
      } else if (ch === '*' && this.peek(1) === '/') {
        this.index += 2;
        return;
      } else {
        this.index++;
      }
    }
  }

  private readQuotedString(quote: string): void {
    const start = this.index;
    const startLine = this.line;
    this.index++;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === '\\') {
        this.index = Math.min(this.index + 2, this.text.length);
      } else if (ch === quote) {
        this.index++;
        this.tokens.push({
          type: 'STRING',
          text: this.text.substring(start, this.index),
          startOffset: start,
          endOffset: this.index,
          line: startLine,
        });
        return;
      } else if (ch === '\n') {
        this.advanceLine();
      } else {
        this.index++;
      }
    }
    this.tokens.push({
      type: 'STRING',
      text: this.text.substring(start, this.index),
      startOffset: start,
      endOffset: this.index,
      line: startLine,
    });
  }


  private readTemplateLiteral(): void {
    let chunkStart = this.index;
    let chunkLine = this.line;
    this.index++;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === '\\') {
        this.index = Math.min(this.index + 2, this.text.length);
      } else if (ch === '`') {
        this.index++;
        this.addStringToken(chunkStart, this.index, chunkLine);
        return;
      } else if (ch === '$' && this.peek(1) === '{') {
        this.addStringToken(chunkStart, this.index, chunkLine);
        this.index += 2;
        this.readTemplateExpression();
        chunkStart = this.index;
        chunkLine = this.line;
      } else if (ch === '\n') {
        this.advanceLine();
      } else {
        this.index++;
      }
    }
    this.addStringToken(chunkStart, this.index, chunkLine);
  }

  /** Tokenizes the inside of a `${...}` interpolation, stopping after the matching `}`. */
  private readTemplateExpression(): void {
    let depth = 1;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === '\n') {
        this.advanceLine();
      } else if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.index++;
      } else if (ch === '/' && this.peek(1) === '/') {
        this.skipLineComment();
      } else if (ch === '/' && this.peek(1) === '*') {
        this.skipBlockComment();
      } else if (ch === "'" || ch === '"') {
        this.readQuotedString(ch);
      } else if (ch === '`') {
        this.readTemplateLiteral();
      } else if (isIdentifierStart(ch)) {
        this.readIdentifier();
      } else if (ch >= '0' && ch <= '9') {
        this.readNumber();
      } else if (ch === '{') {
        depth++;
        this.readPunctuation();
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          this.index++;
          return;
        }
        this.readPunctuation();
      } else {
        this.readPunctuation();
      }
    }
  }


  private readIdentifier(): void {
    const start = this.index;
    while (this.index < this.text.length && isIdentifierPart(this.text[this.index])) {
      this.index++;
    }
    const value = this.text.substring(start, this.index);
    const type: JsTokenType = KEYWORDS.has(value) ? 'KEYWORD' : 'IDENTIFIER';
    this.tokens.push({ type, text: value, startOffset: start, endOffset: this.index, line: this.line });
  }

  private readNumber(): void {
    const start = this.index;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (/[a-zA-Z0-9._]/.test(ch)) this.index++;
      else break;
    }
    this.tokens.push({
      type: 'NUMBER',
      text: this.text.substring(start, this.index),
      startOffset: start,
      endOffset: this.index,
      line: this.line,
    });
  }

  private readPunctuation(): void {
    const start = this.index;
    let length: number;
    if (this.matchesOperator(THREE_CHAR_OPERATORS, 3)) length = 3;
    else if (this.matchesOperator(TWO_CHAR_OPERATORS, 2)) length = 2;
    else length = 1;
    this.index = Math.min(this.index + length, this.text.length);
    this.tokens.push({
      type: 'PUNCTUATION',
      text: this.text.substring(start, this.index),
      startOffset: start,
      endOffset: this.index,
      line: this.line,
    });
  }

  private matchesOperator(operators: Set<string>, length: number): boolean {
    if (this.index + length > this.text.length) return false;
    return operators.has(this.text.substring(this.index, this.index + length));
  }

  private addStringToken(startOffset: number, endOffset: number, line: number): void {
    this.tokens.push({
      type: 'STRING',
      text: this.text.substring(startOffset, endOffset),
      startOffset,
      endOffset,
      line,
    });
  }
}
