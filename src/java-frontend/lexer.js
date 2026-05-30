'use strict';

class JavaTokenStream {
  constructor(tokens = []) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.index + offset] || null;
  }

  consume() {
    const token = this.peek();
    if (token) {
      this.index += 1;
    }
    return token;
  }

  mark() {
    return this.index;
  }

  reset(mark) {
    this.index = mark;
  }

  get eof() {
    return this.index >= this.tokens.length;
  }
}

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static',
  'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while',
  // Java 9+ / contextual words. They are marked as keywords here but the
  // parser still treats most names contextually via token text.
  'exports', 'module', 'non-sealed', 'open', 'opens', 'permits', 'provides',
  'record', 'requires', 'sealed', 'to', 'transitive', 'uses', 'var', 'with',
  'yield',
  // literals
  'true', 'false', 'null',
]);

const OPERATORS = [
  '>>>=', '>>>', '>>=', '<<=', '->', '::', '...', '&&', '||', '++', '--',
  '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '<<', '>>',
  '(', ')', '{', '}', '[', ']', ';', ',', '.', '@', '?', ':', '+', '-', '*',
  '/', '%', '<', '>', '=', '!', '~', '&', '|', '^',
];

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f';
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isIdentifierStart(ch) {
  return ch === '_' || ch === '$' || /[A-Za-z]/.test(ch) || ch.charCodeAt(0) > 0x7f;
}

function isIdentifierPart(ch) {
  return isIdentifierStart(ch) || isDigit(ch);
}

function isNumberPart(ch) {
  return /[A-Za-z0-9_.$]/.test(ch);
}

function isOperatorStart(ch) {
  return '(){}[];,.@?:+-*/%<>=!~&|^'.includes(ch);
}

function makeRange(startOffset, endOffset, startLine, startColumn, endLine, endColumn) {
  return {
    startOffset,
    endOffset,
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
  };
}

function decodeJavaEscapes(value) {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\' || i + 1 >= value.length) {
      result += ch;
      continue;
    }

    const next = value[++i];
    if (next === 'b') result += '\b';
    else if (next === 't') result += '\t';
    else if (next === 'n') result += '\n';
    else if (next === 'f') result += '\f';
    else if (next === 'r') result += '\r';
    else if (next === '"' || next === '\'' || next === '\\') result += next;
    else if (/[0-7]/.test(next)) {
      let octal = next;
      const maxExtra = next <= '3' ? 2 : 1;
      for (let j = 0; j < maxExtra && i + 1 < value.length && /[0-7]/.test(value[i + 1]); j++) {
        octal += value[++i];
      }
      result += String.fromCharCode(Number.parseInt(octal, 8));
    } else {
      result += next;
    }
  }
  return result;
}

function decodeSimpleLiteral(kind, raw) {
  if (kind === 'string') {
    return decodeJavaEscapes(raw.slice(1, -1));
  }
  if (kind === 'char') {
    return decodeJavaEscapes(raw.slice(1, -1));
  }
  if (kind === 'textBlock') {
    return decodeJavaEscapes(raw.slice(3, -3));
  }
  return raw;
}

function translateUnicodeEscapes(source) {
  return source.replace(/\\u+([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function tokenizeJava(source) {
  if (typeof source !== 'string') {
    throw new TypeError('Java source must be a string');
  }
  source = translateUnicodeEscapes(source);

  const tokens = [];
  const diagnostics = [];
  let i = 0;
  let line = 1;
  let column = 1;

  function current() {
    return source[i];
  }

  function startsWith(text) {
    return source.startsWith(text, i);
  }

  function advance(count = 1) {
    for (let j = 0; j < count && i < source.length; j += 1) {
      const ch = source[i];
      i += 1;
      if (ch === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
  }

  function emit(kind, text, startOffset, startLine, startColumn, extra = {}) {
    tokens.push({
      kind,
      text,
      range: makeRange(startOffset, i, startLine, startColumn, line, column),
      ...extra,
    });
  }

  while (i < source.length) {
    const ch = current();

    if (isWhitespace(ch)) {
      advance();
      continue;
    }

    if (startsWith('//')) {
      while (i < source.length && current() !== '\n') {
        advance();
      }
      continue;
    }

    if (startsWith('/*')) {
      const startOffset = i;
      const startLine = line;
      const startColumn = column;
      advance(2);
      while (i < source.length && !startsWith('*/')) {
        advance();
      }
      if (startsWith('*/')) {
        advance(2);
      } else {
        diagnostics.push({
          code: 'JAVA_UNTERMINATED_BLOCK_COMMENT',
          severity: 'error',
          message: 'Unterminated block comment.',
          range: makeRange(startOffset, i, startLine, startColumn, line, column),
        });
      }
      continue;
    }

    if (startsWith('"""')) {
      const startOffset = i;
      const startLine = line;
      const startColumn = column;
      advance(3);
      while (i < source.length && !startsWith('"""')) {
        advance();
      }
      if (startsWith('"""')) {
        advance(3);
      } else {
        diagnostics.push({
          code: 'JAVA_UNTERMINATED_TEXT_BLOCK',
          severity: 'error',
          message: 'Unterminated text block literal.',
          range: makeRange(startOffset, i, startLine, startColumn, line, column),
        });
      }
      const text = source.slice(startOffset, i);
      emit('textBlock', text, startOffset, startLine, startColumn, { value: decodeSimpleLiteral('textBlock', text) });
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const kind = quote === '"' ? 'string' : 'char';
      const startOffset = i;
      const startLine = line;
      const startColumn = column;
      advance();
      while (i < source.length) {
        if (current() === '\\') {
          advance(2);
          continue;
        }
        if (current() === quote) {
          advance();
          break;
        }
        if (current() === '\n' && kind === 'char') {
          diagnostics.push({
            code: 'JAVA_UNTERMINATED_CHAR_LITERAL',
            severity: 'error',
            message: 'Unterminated character literal.',
            range: makeRange(startOffset, i, startLine, startColumn, line, column),
          });
          break;
        }
        advance();
      }
      const text = source.slice(startOffset, i);
      emit(kind, text, startOffset, startLine, startColumn, { value: decodeSimpleLiteral(kind, text) });
      continue;
    }

    if (isDigit(ch)) {
      const startOffset = i;
      const startLine = line;
      const startColumn = column;
      advance();
      while (i < source.length && isNumberPart(current())) {
        // Do not eat the first dot in constructs such as `1.toString()`.
        if (current() === '.' && !isDigit(source[i + 1] || '') && source[i + 1] !== '_') {
          break;
        }
        advance();
      }
      const text = source.slice(startOffset, i);
      emit('number', text, startOffset, startLine, startColumn, { value: text });
      continue;
    }

    if (isIdentifierStart(ch)) {
      const startOffset = i;
      const startLine = line;
      const startColumn = column;
      advance();
      while (i < source.length && isIdentifierPart(current())) {
        advance();
      }
      let text = source.slice(startOffset, i);
      // Java's only hyphenated contextual keyword is easier to treat as one
      // token when it appears in a declaration modifier position.
      if (text === 'non' && source.startsWith('-sealed', i)) {
        advance('-sealed'.length);
        text = source.slice(startOffset, i);
      }
      const kind = JAVA_KEYWORDS.has(text) ? 'keyword' : 'identifier';
      emit(kind, text, startOffset, startLine, startColumn, {
        contextualKeyword: kind === 'keyword' ? text : null,
      });
      continue;
    }

    if (isOperatorStart(ch)) {
      const startOffset = i;
      const startLine = line;
      const startColumn = column;
      const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
      if (op) {
        advance(op.length);
        emit('symbol', op, startOffset, startLine, startColumn);
        continue;
      }
    }

    const startOffset = i;
    const startLine = line;
    const startColumn = column;
    advance();
    diagnostics.push({
      code: 'JAVA_UNKNOWN_CHARACTER',
      severity: 'warning',
      message: `Unknown Java source character: ${JSON.stringify(ch)}`,
      range: makeRange(startOffset, i, startLine, startColumn, line, column),
    });
    emit('unknown', ch, startOffset, startLine, startColumn);
  }

  return { tokens, diagnostics };
}

module.exports = {
  JavaTokenStream,
  tokenizeJava,
  translateUnicodeEscapes,
  JAVA_KEYWORDS,
};
