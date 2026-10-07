'use strict';
// Reads the contents of a ListResourceBundle from its Java source: the
// {"key", value} pairs returned by getContents(), where a value is a string
// literal concatenation or a `new String[] {...}` array. Used for the
// sun.text.resources BreakIteratorInfo/BreakIteratorRules bundles, which the
// JDK build compiles only to feed GenerateBreakIteratorData.
const fs = require('fs');

// JLS 3.3: \uXXXX escapes (preceded by an even number of backslashes)
function translateUnicodeEscapes(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== '\\') { out += c; continue; }
    let j = i + 1;
    if (src[j] === 'u') {
      while (src[j] === 'u') j++;
      const hex = src.substr(j, 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('illegal unicode escape');
      out += String.fromCharCode(parseInt(hex, 16));
      i = j + 3;
    } else {
      // a backslash not starting an escape; the next one cannot start one either
      out += c;
      if (src[j] === '\\') { out += '\\'; i = j; }
    }
  }
  return out;
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('//', i)) { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (src.startsWith('/*', i)) { i = src.indexOf('*/', i + 2) + 2; continue; }
    if (c === '"') {
      let s = '';
      i++;
      while (src[i] !== '"') {
        let ch = src[i++];
        if (ch === '\\') {
          ch = src[i++];
          const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', s: ' ', '"': '"', "'": "'", '\\': '\\' };
          if (ch in simple) s += simple[ch];
          else if (/[0-7]/.test(ch)) {
            let oct = ch;
            const max = ch <= '3' ? 3 : 2;
            while (oct.length < max && /[0-7]/.test(src[i])) oct += src[i++];
            s += String.fromCharCode(parseInt(oct, 8));
          } else throw new Error('illegal escape \\' + ch);
        } else s += ch;
      }
      i++;
      toks.push({ str: s });
      continue;
    }
    const m = /^[A-Za-z_$][\w$]*|^./.exec(src.slice(i, i + 64));
    toks.push(m[0]);
    i += m[0].length;
  }
  return toks;
}

function readBundle(file) {
  const toks = tokenize(translateUnicodeEscapes(fs.readFileSync(file, 'utf8')));
  const contents = new Map();
  let i = toks.indexOf('getContents');
  if (i < 0) throw new Error(`no getContents() in ${file}`);
  const concat = () => {
    let s = toks[i++].str;
    while (toks[i] === '+') { i++; s += toks[i++].str; }
    return s;
  };
  for (; i < toks.length; i++) {
    if (toks[i] !== '{' || !toks[i + 1] || toks[i + 1].str === undefined || toks[i + 2] !== ',') continue;
    const key = toks[i + 1].str;
    i += 3;
    let value;
    if (toks[i] === 'new') {
      // new String[] { "a", "b", ... }
      while (toks[i] !== '{') i++;
      i++;
      value = [];
      while (toks[i] !== '}') {
        if (toks[i] === ',') { i++; continue; }
        value.push(concat());
      }
      i++;
    } else value = concat();
    contents.set(key, value);
  }
  return contents;
}

module.exports = { readBundle };
