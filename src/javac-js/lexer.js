'use strict';

// Java lexer (JLS chapter 3) covering the syntax of current OpenJDK
// sources: unicode escapes, text blocks, all numeric literal forms,
// contextual keywords handled by the parser, and '>' splitting for
// generics (the parser asks for '>' pieces of '>>' and '>>>').

const KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static',
  'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
]);

// Longest first so that greedy matching works.
const OPERATORS = [
  '>>>=', '<<=', '>>=', '>>>', '...', '->', '::', '++', '--', '&&', '||',
  '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=',
  '<<', '>>', '(', ')', '{', '}', '[', ']', ';', ',', '.', '@', '=', '>',
  '<', '!', '~', '?', ':', '+', '-', '*', '/', '&', '|', '^', '%',
];

class LexError extends Error {
  constructor(message, file, line, col) {
    super(`${file || '<input>'}:${line}:${col}: ${message}`);
    this.file = file;
    this.line = line;
    this.col = col;
  }
}

// Translate \uXXXX escapes first (JLS 3.3). An escape is only eligible
// when the backslash is preceded by an even number of backslashes. We keep
// a position map so that diagnostics still point into the original text.
function translateUnicodeEscapes(src) {
  if (src.indexOf('\\u') < 0) return { text: src, map: null };
  let out = '';
  const map = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      // count preceding raw backslashes in the original text
      let n = 0;
      let j = i - 1;
      while (j >= 0 && src[j] === '\\') { n++; j--; }
      if (n % 2 === 0 && src[i + 1] === 'u') {
        let k = i + 1;
        while (src[k] === 'u') k++;
        const hex = src.substr(k, 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          map.push(i);
          out += String.fromCharCode(parseInt(hex, 16));
          i = k + 4;
          continue;
        }
      }
    }
    map.push(i);
    out += c;
    i++;
  }
  map.push(src.length);
  return { text: out, map };
}

function isJavaIdentifierStart(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95;
  return /[\p{L}\p{Nl}$_\p{Sc}\p{Pc}]/u.test(ch);
}

function isJavaIdentifierPart(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 36 || c === 95 || c <= 8 || (c >= 14 && c <= 27) || c === 127;
  return /[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Sc}\p{Pc}$_\u0000-\u0008\u000e-\u001b\u007f-\u009f­​-‏‪-‮⁠-⁤﻿]/u.test(ch);
}

// Process the escapes of a string or char literal body.
function unescapeJava(body, report) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const n = body[++i];
    switch (n) {
      case 'b': out += '\b'; break;
      case 't': out += '\t'; break;
      case 'n': out += '\n'; break;
      case 'f': out += '\f'; break;
      case 'r': out += '\r'; break;
      case 's': out += ' '; break;
      case '"': out += '"'; break;
      case '\'': out += '\''; break;
      case '\\': out += '\\'; break;
      case '\n': break; // line continuation inside text blocks
      default:
        if (n >= '0' && n <= '7') {
          let digits = n;
          const max = n <= '3' ? 3 : 2;
          while (digits.length < max && body[i + 1] >= '0' && body[i + 1] <= '7') digits += body[++i];
          out += String.fromCharCode(parseInt(digits, 8));
        } else {
          report(`illegal escape character \\${n}`);
        }
    }
  }
  return out;
}

// Text block processing (JLS 3.10.6): strip incidental indentation, trailing
// spaces, normalize line endings, then interpret escapes.
function processTextBlock(raw) {
  // raw is everything between the opening """ line terminator and the closing """
  const content = raw.replace(/\r\n?/g, '\n');
  const lines = content.split('\n');
  // the last line counts for indentation even if blank (it holds the closing delimiter)
  const significant = lines.filter((l, idx) => l.trim().length > 0 || idx === lines.length - 1);
  let minIndent = Infinity;
  for (const l of significant) {
    let k = 0;
    while (k < l.length && (l[k] === ' ' || l[k] === '\t' || l[k] === '\f')) k++;
    if (k === l.length && l !== lines[lines.length - 1]) continue;
    minIndent = Math.min(minIndent, k);
  }
  if (!isFinite(minIndent)) minIndent = 0;
  const stripped = lines.map((l, idx) => {
    let s = l.trim().length === 0 ? '' : l.slice(minIndent);
    if (idx !== lines.length - 1 || true) s = s.replace(/[ \t\f]+$/, '');
    return s;
  });
  // if the closing delimiter is on its own line, the last (empty) line is dropped
  // but the newline before it stays.
  let joined = stripped.join('\n');
  return joined;
}

class Token {
  constructor(kind, text, pos, end, value) {
    this.kind = kind; // 'ident' | 'keyword' | 'op' | 'int' | 'long' | 'float' | 'double' | 'char' | 'string' | 'eof'
    this.text = text;
    this.pos = pos;
    this.end = end;
    this.value = value;
    this.docComment = null;
    this.deprecatedDoc = false;
  }
}

function lex(source, file) {
  const { text: src, map } = translateUnicodeEscapes(source);
  const tokens = [];
  let i = 0;
  let pendingDoc = null;
  const lineStarts = [0];
  for (let k = 0; k < source.length; k++) if (source[k] === '\n') lineStarts.push(k + 1);

  function origPos(p) { return map ? map[Math.min(p, map.length - 1)] : p; }
  function lineCol(p) {
    const op = origPos(p);
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= op) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: op - lineStarts[lo] + 1 };
  }
  function fail(msg, p) {
    const { line, col } = lineCol(p);
    throw new LexError(msg, file, line, col);
  }

  while (i < src.length) {
    const c = src[i];
    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\u001a') { i++; continue; }
    // comments
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) fail('unterminated comment', i);
      if (src[i + 2] === '*' && src[i + 3] !== '/') pendingDoc = src.slice(i + 3, end);
      i = end + 2;
      continue;
    }
    const start = i;
    // identifiers / keywords
    if (isJavaIdentifierStart(c) || (c >= '\ud800' && c <= '\udbff')) {
      let j = i + 1;
      while (j < src.length) {
        const ch = src[j];
        if (ch >= '\ud800' && ch <= '\udbff') { j += 2; continue; }
        if (isJavaIdentifierPart(ch)) j++; else break;
      }
      const word = src.slice(i, j);
      const tok = new Token(KEYWORDS.has(word) ? 'keyword' : 'ident', word, start, j);
      if (pendingDoc !== null) { tok.docComment = pendingDoc; pendingDoc = null; }
      tokens.push(tok);
      i = j;
      continue;
    }
    // numbers
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const tok = lexNumber(src, i, fail);
      if (pendingDoc !== null) { tok.docComment = pendingDoc; pendingDoc = null; }
      tokens.push(tok);
      i = tok.end;
      continue;
    }
    // text blocks
    if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      let j = i + 3;
      while (src[j] === ' ' || src[j] === '\t' || src[j] === '\f') j++;
      if (src[j] === '\r') j++;
      if (src[j] !== '\n' && src[j - 1] !== '\r') fail('illegal text block open delimiter sequence', i);
      if (src[j] === '\n') j++;
      const bodyStart = j;
      let k = j;
      while (true) {
        if (k >= src.length) fail('unclosed text block', i);
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === '"' && src[k + 1] === '"' && src[k + 2] === '"') break;
        k++;
      }
      const raw = src.slice(bodyStart, k);
      const value = unescapeJava(processTextBlock(raw), (m) => fail(m, i));
      const tok = new Token('string', src.slice(i, k + 3), start, k + 3, value);
      tokens.push(tok);
      i = k + 3;
      continue;
    }
    // string literal
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j++;
        if (src[j] === '\n') fail('unclosed string literal', i);
        j++;
      }
      if (j >= src.length) fail('unclosed string literal', i);
      const value = unescapeJava(src.slice(i + 1, j), (m) => fail(m, i));
      tokens.push(new Token('string', src.slice(i, j + 1), start, j + 1, value));
      i = j + 1;
      continue;
    }
    // char literal
    if (c === '\'') {
      let j = i + 1;
      while (j < src.length && src[j] !== '\'') {
        if (src[j] === '\\') j++;
        j++;
      }
      const value = unescapeJava(src.slice(i + 1, j), (m) => fail(m, i));
      if (value.length !== 1) fail('illegal char literal', i);
      tokens.push(new Token('char', src.slice(i, j + 1), start, j + 1, value.charCodeAt(0)));
      i = j + 1;
      continue;
    }
    // operators
    let op = null;
    for (const o of OPERATORS) {
      if (src.startsWith(o, i)) { op = o; break; }
    }
    if (!op) fail(`illegal character '${c}' (\\u${c.charCodeAt(0).toString(16).padStart(4, '0')})`, i);
    const tok = new Token('op', op, start, i + op.length);
    if (op === '@' && pendingDoc !== null) { tok.docComment = pendingDoc; pendingDoc = null; }
    tokens.push(tok);
    i += op.length;
  }
  tokens.push(new Token('eof', '<EOF>', src.length, src.length));
  return { tokens, lineCol, text: src };
}

function lexNumber(src, i, fail) {
  const start = i;
  let j = i;
  const digitsOf = (re) => { while (j < src.length && (re.test(src[j]) || src[j] === '_')) j++; };
  let isFloat = false;
  let radix = 10;
  if (src[j] === '0' && (src[j + 1] === 'x' || src[j + 1] === 'X')) {
    radix = 16;
    j += 2;
    digitsOf(/[0-9a-fA-F]/);
    if (src[j] === '.') { isFloat = true; j++; digitsOf(/[0-9a-fA-F]/); }
    if (src[j] === 'p' || src[j] === 'P') {
      isFloat = true;
      j++;
      if (src[j] === '+' || src[j] === '-') j++;
      digitsOf(/[0-9]/);
    }
  } else if (src[j] === '0' && (src[j + 1] === 'b' || src[j + 1] === 'B')) {
    radix = 2;
    j += 2;
    digitsOf(/[01]/);
  } else {
    digitsOf(/[0-9]/);
    if (src[j] === '.' && /[0-9]/.test(src[j + 1] || '')) { isFloat = true; j++; digitsOf(/[0-9]/); }
    else if (src[j] === '.' && !/[A-Za-z_$.]/.test(src[j + 1] || '')) { isFloat = true; j++; }
    else if (src[j] === '.' && /[eEfFdD]/.test(src[j + 1] || '') && !/[A-Za-z0-9_$]/.test(src[j + 2] || '')) { isFloat = true; j++; }
    if (src[j] === 'e' || src[j] === 'E') {
      isFloat = true;
      j++;
      if (src[j] === '+' || src[j] === '-') j++;
      digitsOf(/[0-9]/);
    }
  }
  let suffix = src[j];
  let kind;
  if (suffix === 'f' || suffix === 'F') { kind = 'float'; j++; }
  else if (suffix === 'd' || suffix === 'D') { kind = 'double'; j++; }
  else if (suffix === 'l' || suffix === 'L') { kind = 'long'; j++; }
  else kind = isFloat ? 'double' : 'int';
  const text = src.slice(start, j);
  const clean = text.replace(/_/g, '');
  let value;
  if (kind === 'float' || kind === 'double') {
    let body = clean.replace(/[fFdD]$/, '');
    if (radix === 16) value = parseHexFloat(body);
    else value = Number(body);
    if (kind === 'float') value = Math.fround(value);
  } else {
    let body = clean.replace(/[lL]$/, '');
    let digits;
    if (radix === 16 || radix === 2) digits = body.slice(2);
    else if (body.length > 1 && body[0] === '0') { radix = 8; digits = body.slice(1); }
    else digits = body;
    let big = 0n;
    const R = BigInt(radix);
    for (const d of digits) big = big * R + BigInt(parseInt(d, radix));
    // range checks: decimal literals may be exactly 2^31 / 2^63 only after unary minus;
    // the parser handles that, so we keep the raw magnitude here.
    if (kind === 'int') {
      if (radix === 10) {
        if (big > 2147483648n) fail('integer number too large', start);
      } else if (big > 0xffffffffn) fail('integer number too large', start);
      else if (big > 0x7fffffffn) big -= 0x100000000n; // bit pattern
    } else {
      if (radix === 10) {
        if (big > 9223372036854775808n) fail('long number too large', start);
      } else if (big > 0xffffffffffffffffn) fail('long number too large', start);
      else if (big > 0x7fffffffffffffffn) big -= 0x10000000000000000n; // bit pattern
    }
    value = big; // BigInt magnitude, normalized by the parser
  }
  return new Token(kind, text, start, j, value);
}

function parseHexFloat(s) {
  // 0x<hex>[.<hex>]p<exp>
  const m = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)$/.exec(s);
  if (!m) return NaN;
  const intPart = m[1] || '';
  const frac = m[2] || '';
  let mant = 0;
  for (const d of intPart) mant = mant * 16 + parseInt(d, 16);
  let scale = 1;
  for (const d of frac) { scale /= 16; mant += parseInt(d, 16) * scale; }
  return mant * Math.pow(2, parseInt(m[3], 10));
}

module.exports = { lex, LexError, Token, KEYWORDS, unescapeJava, processTextBlock };
