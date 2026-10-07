'use strict';
// Small pieces of Java library behaviour that the build tool ports need to
// reproduce exactly.

// System.getProperty("line.separator"); BOOTJDK_LINE_SEPARATOR=crlf|lf
// overrides it, so Windows output can be reproduced and checked elsewhere
const LNSEP = { crlf: '\r\n', lf: '\n' }[process.env.BOOTJDK_LINE_SEPARATOR]
  || (process.platform === 'win32' ? '\r\n' : '\n');

// Matcher.appendReplacement's replacement syntax: \c is a literal c, $n and
// ${name} are group references. Returns the expanded replacement for match m.
function appendReplacement(m, repl) {
  let out = '';
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i];
    if (c === '\\') {
      i++;
      if (i >= repl.length) throw new Error('character to be escaped is missing');
      out += repl[i];
    } else if (c === '$') {
      i++;
      if (i >= repl.length) throw new Error('Illegal group reference: group index is missing');
      if (repl[i] === '{') {
        const end = repl.indexOf('}', i);
        if (end < 0) throw new Error("named capturing group is missing trailing '}'");
        const name = repl.slice(i + 1, end);
        if (!m.groups || !(name in m.groups)) throw new Error(`No group with name {${name}}`);
        out += m.groups[name] || '';
        i = end;
      } else {
        let n = repl.charCodeAt(i) - 48;
        if (n < 0 || n > 9) throw new Error('Illegal group reference');
        // take further digits while the group number stays valid
        while (i + 1 < repl.length) {
          const d = repl.charCodeAt(i + 1) - 48;
          if (d < 0 || d > 9) break;
          const nn = n * 10 + d;
          if (nn >= m.length) break;
          n = nn; i++;
        }
        if (n >= m.length) throw new Error(`No group ${n}`);
        out += m[n] === undefined ? '' : m[n];
      }
    } else out += c;
  }
  return out;
}

// String.trim(): strips code points <= U+0020 from both ends
function javaTrim(s) {
  let a = 0, b = s.length;
  while (a < b && s.charCodeAt(a) <= 32) a++;
  while (b > a && s.charCodeAt(b - 1) <= 32) b--;
  return s.slice(a, b);
}

// the lines Scanner.nextLine() returns for a whole input
function splitLines(text) {
  if (text === '') return [];
  const lines = text.split(/\r\n|[\n\r\u2028\u2029\u0085]/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

module.exports = { LNSEP, appendReplacement, javaTrim, splitLines };
