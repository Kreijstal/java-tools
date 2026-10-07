'use strict';
// Port of make/jdk/src/classes/build/tools/makejavasecurity/MakeJavaSecurity.java:
// builds conf/security/java.security (extra restricted packages, platform
// #ifdef filtering, .tbd numbering, JCE policy directory).
//
// usage: MakeJavaSecurity <in> <out> <target os> <target cpu arch> <policy dir> [<extra pkgs file>]
const fs = require('fs');
const { LNSEP } = require('./util');

const PKG_ACC = 'package.access';
const PKG_DEF = 'package.definition';
const PKG_ACC_INDENT = 15;
const PKG_DEF_INDENT = 19;

// BufferedReader.readLine / Files.readAllLines
function readLines(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function makeJavaSecurity(inLines, extraLines, os, arch, policyDir) {
  let lines = [];
  let p = 0;
  const readLine = () => p < inLines.length ? inLines[p++] : null;

  function addPackages(line, numSpaces) {
    let first = true;
    while (line !== null && line !== '') {
      if (!line.startsWith('#')) {
        if (!line.endsWith(',\\') || (!first && line.includes('='))) throw new Error('Invalid line: ' + line);
      }
      lines.push(line);
      line = readLine();
      first = false;
    }
    for (const arg of extraLines) {
      lines.push(arg.startsWith('#') ? arg : ' '.repeat(numSpaces) + arg + ',\\');
    }
    if (line !== null) lines.push(line);
  }

  let line = readLine();
  while (line !== null) {
    if (line.startsWith(PKG_ACC)) addPackages(line, PKG_ACC_INDENT);
    else if (line.startsWith(PKG_DEF)) addPackages(line, PKG_DEF_INDENT);
    else lines.push(line);
    line = readLine();
  }

  // #ifdef/#ifndef/#else/#endif filtering, no nesting
  let mode = 0; // 0: out of block, 1: in match, 2: in non-match
  const kept = [];
  for (const l of lines) {
    if (l.startsWith('#endif')) {
      mode = 0;
    } else if (l.startsWith('#ifdef ')) {
      mode = l.endsWith(l.indexOf('-') > 0 ? os + '-' + arch : os) ? 1 : 2;
    } else if (l.startsWith('#ifndef ')) {
      mode = l.endsWith(l.indexOf('-') > 0 ? os + '-' + arch : os) ? 2 : 1;
    } else if (l.startsWith('#else')) {
      if (mode === 0) throw new Error('#else not in #if block');
      mode = 3 - mode;
    } else if (mode !== 2) {
      kept.push(l);
    }
  }
  lines = kept;

  // .tbd -> .1, .2, ...
  const count = new Map();
  for (let i = 0; i < lines.length; i++) {
    const index = lines[i].indexOf('.tbd');
    if (index >= 0) {
      const prefix = lines[i].substring(0, index);
      const n = count.has(prefix) ? count.get(prefix) : 1;
      count.set(prefix, n + 1);
      lines[i] = prefix + '.' + n + lines[i].substring(index + 4);
    }
  }

  // JCE policy value
  for (let i = 0; i < lines.length; i++) {
    const index = lines[i].indexOf('crypto.policydir-tbd');
    if (index >= 0) lines[i] = lines[i].substring(0, index) + policyDir;
  }

  // drop the trailing ",\" of the last line of the package blocks
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith(PKG_ACC) || l.startsWith(PKG_DEF)) inBlock = true;
    if (inBlock && l === '') {
      lines[i - 1] = lines[i - 1].substring(0, lines[i - 1].length - 2);
      inBlock = false;
    }
  }
  return lines;
}

function main(args) {
  if (args.length < 5) {
    process.stderr.write('Usage: java MakeJavaSecurity [input java.security file name] '
      + '[output java.security file name] [openjdk target os] [openjdk target cpu architecture]'
      + '[JCE jurisdiction policy directory][more restricted packages file name?]' + LNSEP);
    return 1;
  }
  const extraLines = args.length === 6 ? readLines(args[5]) : [];
  const lines = makeJavaSecurity(readLines(args[0]), extraLines, args[2], args[3], args[4]);
  fs.writeFileSync(args[1], lines.map(l => l + LNSEP).join(''));
  return 0;
}

module.exports = { main, makeJavaSecurity };
