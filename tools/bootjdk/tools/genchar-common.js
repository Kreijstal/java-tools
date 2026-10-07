'use strict';
// java.nio.file / java.lang.String helpers shared by the ports of the
// character data generators (generatecharacter, generatespecialcasing,
// generateextraproperties).
const fs = require('fs');
const { LNSEP } = require('./util');

// Files.lines / BufferedReader.readLine: \n, \r and \r\n end a line
function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Files.write(path, lines): every line followed by line.separator
function writeLines(file, lines) {
  fs.writeFileSync(file, lines.map(l => l + LNSEP).join(''));
}

// String.split(regex) with limit 0: trailing empty strings dropped, a
// leading zero-width match yields no leading empty string
function javaSplit(s, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const out = [];
  let last = 0, m, found = false;
  while ((m = g.exec(s)) !== null) {
    if (m[0].length === 0) {
      if (m.index === 0 || m.index >= s.length) { g.lastIndex++; continue; }
    }
    found = true;
    out.push(s.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0].length === 0) g.lastIndex++;
  }
  if (!found) return [s];
  out.push(s.slice(last));
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

// String.isBlank (Character.isWhitespace)
const isBlank = s => /^[\t\n\x0b\f\r\x1c-\x20\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*$/.test(s);

module.exports = { readLines, writeLines, javaSplit, isBlank };

// Character.toUpperCase(int) / toLowerCase(int) of the running JDK, taken
// from the simple case mappings of a UnicodeData.txt
function simpleCaseMaps(unicodeDataFile) {
  const upper = new Map(), lower = new Map();
  for (const l of readLines(unicodeDataFile)) {
    const f = l.split(';');
    const cp = parseInt(f[0], 16);
    if (f[12]) upper.set(cp, parseInt(f[12], 16));
    if (f[13]) lower.set(cp, parseInt(f[13], 16));
  }
  return {
    toUpperCase: cp => upper.has(cp) ? upper.get(cp) : cp,
    toLowerCase: cp => lower.has(cp) ? lower.get(cp) : cp,
  };
}
module.exports.simpleCaseMaps = simpleCaseMaps;
