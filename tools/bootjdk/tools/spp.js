'use strict';
// Port of make/jdk/src/classes/build/tools/spp/Spp.java, the JDK build's
// stream preprocessor for the java.nio buffer, charset coder, VarHandle and
// ScopedMemoryAccess templates. Output matches the Java tool byte for byte,
// including its use of the platform line separator.
//
// usage: spp [-be] [-nel] [-Kkey] -Dvar=value ... -iin -oout
const fs = require('fs');
const { appendReplacement, javaTrim, splitLines, LNSEP } = require('./util');

const KEY = '([a-zA-Z0-9]+)';
const VAR = '([a-zA-Z0-9_\\-]+)';
// [\p{Print}&&[^{#:}]]: printable ASCII except { # : }
const TEXT = '([\\x20-\\x22\\x24-\\x39\\x3b-\\x7a\\x7c\\x7e]+)';

const GN_NOT = 1, GN_KEY = 2, GN_YES = 3, GN_NO = 5, GN_VAR = 6;

const ifkey = new RegExp(`^#if\\[(!)?${KEY}\\]`);
const elsekey = new RegExp(`^#else\\[(!)?${KEY}\\]`);
const endkey = new RegExp(`^#end\\[(!)?${KEY}\\]`);
const vardefSrc = `\\{#if\\[(!)?${KEY}\\]\\?${TEXT}(:${TEXT})?\\}|\\$${VAR}\\$`;
const vardef2 = new RegExp(`\\$${VAR}\\$`);

class SppError extends Error {}

function append(buf, ln, keys, vars) {
  const re = new RegExp(vardefSrc, 'g');
  let m, last = 0;
  while ((m = re.exec(ln)) !== null) {
    let repl;
    if (m[GN_VAR] !== undefined) {
      repl = vars.has(m[GN_VAR]) ? vars.get(m[GN_VAR]) : null;
    } else {
      let test = keys.has(m[GN_KEY]);
      if (m[GN_NOT] !== undefined) test = !test;
      repl = test ? m[GN_YES] : m[GN_NO];
      if (repl === undefined) repl = '';
      else {
        // embedded $var$
        let m2;
        while ((m2 = vardef2.exec(repl)) !== null) {
          if (!vars.has(m2[1])) throw new SppError(`undefined variable ${m2[1]}`);
          repl = repl.slice(0, m2.index) + appendReplacement(m2, vars.get(m2[1])) + repl.slice(m2.index + m2[0].length);
        }
      }
    }
    if (repl === null) {
      process.stderr.write(`Error: undefined variable in line ${ln}${LNSEP}`);
      process.exit(255);
    }
    buf.push(ln.slice(last, m.index), appendReplacement(m, repl));
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  buf.push(ln.slice(last));
}

// buffer of string pieces; Java's StringBuffer.setLength(0) is reset()
class Buf {
  constructor() { this.parts = []; }
  push(...s) { this.parts.push(...s); }
  reset() { this.parts.length = 0; }
  toString() { return this.parts.join(''); }
}

// returns true if #end[key], #end or EOF reached
function spp(lines, buf, key, keys, vars, be, el, skip) {
  while (lines.pos < lines.length) {
    let ln = lines[lines.pos++];
    if (be) {
      if (ln.startsWith('#begin')) { buf.reset(); continue; }
      if (ln === '#end') { lines.pos = lines.length; return true; }
    }
    let m;
    if ((m = ifkey.exec(ln))) {
      const k = m[GN_KEY];
      let test = keys.has(k);
      if (m[GN_NOT] !== undefined) test = !test;
      if (el) buf.push(LNSEP);
      if (!spp(lines, buf, k, keys, vars, be, el, skip || !test)) {
        spp(lines, buf, k, keys, vars, be, el, skip || test);
      }
      continue;
    }
    if ((m = elsekey.exec(ln))) {
      if (key !== m[GN_KEY]) throw new SppError(`Mis-matched #if-else-end at line <${ln}>`);
      if (el) buf.push(LNSEP);
      return false;
    }
    if ((m = endkey.exec(ln))) {
      if (key !== m[GN_KEY]) throw new SppError(`Mis-matched #if-else-end at line <${ln}>`);
      if (el) buf.push(LNSEP);
      return true;
    }
    if (ln.startsWith('#warn')) {
      ln = '// -- This file was mechanically generated: Do not edit! -- //';
    } else if (javaTrim(ln).startsWith('// ##')) {
      ln = '';
    }
    if (!skip) {
      append(buf, ln, keys, vars);
      if (!el) buf.push(LNSEP);
    }
    if (el) buf.push(LNSEP);
  }
  return true;
}

function main(args) {
  const vars = new Map();
  const keys = new Set();
  let be = false, el = true, inputFile = null, outputFile = null;
  for (const arg of args) {
    if (arg.startsWith('-D')) {
      const i = arg.indexOf('=');
      vars.set(arg.substring(2, i), arg.substring(i + 1));
    } else if (arg.startsWith('-K')) keys.add(arg.substring(2));
    else if (arg.startsWith('-i')) inputFile = arg.substring(2);
    else if (arg.startsWith('-o')) outputFile = arg.substring(2);
    else if (arg === '-be') be = true;
    else if (arg === '-nel') el = false;
    else {
      process.stderr.write(`Usage: java build.tools.spp.Spp [-be] [-nel] [-Kkey] -Dvar=value ... <in >out${LNSEP}`);
      return 255;
    }
  }
  const lines = splitLines(fs.readFileSync(inputFile, 'utf8'));
  lines.pos = 0;
  const buf = new Buf();
  spp(lines, buf, '', keys, vars, be, el, false);
  fs.appendFileSync(outputFile, buf.toString(), 'utf8');
  return 0;
}

module.exports = { main };
