'use strict';
// Port of make/jdk/src/classes/build/tools/generatespecialcasing/
// GenerateSpecialCasing.java: fills the %%%SpecialCasing%%% entries of the
// java.lang.ConditionalSpecialCasing template from SpecialCasing.txt.
//
// usage: GenerateSpecialCasing template SpecialCasing.txt output
const { javaTrim } = require('./util');
const { readLines, writeLines, javaSplit, isBlank } = require('./genchar-common');

function entryToString(e) {
  if (e.codePoint == null || isBlank(e.codePoint)) throw new Error(`Corrupt entry: ${e}`);
  const hex = cps => cps.map(cp => cp === '' ? '' : '0x' + cp).join(',');
  return `        new Entry(0x${e.codePoint}, new char[]{${hex(e.lowerCase)}}, ` +
    `new char[]{${hex(e.upperCase)}}, "${e.language}", ${e.condition === '' ? 'NONE' : e.condition}),`;
}

function main(args) {
  const [templateFile, specialCasingFile, gensrcFile] = args;
  const entries = readLines(specialCasingFile)
    .filter(l => !(l.startsWith('#') || isBlank(l)))
    .map(l => javaSplit(l.replace(/#.*$/, ''), /;/))
    // U+0130 is needed even if it is non-conditional
    .filter(l => !isBlank(l[4]) || l[0] === '0130')
    .map(l => ({
      codePoint: l[0],
      lowerCase: javaSplit(javaTrim(l[1]), / /),
      upperCase: javaSplit(javaTrim(l[3]), / /),
      language: javaTrim(l[4].replace(/[A-Z].*$/, '')),
      condition: javaTrim(l[4].replace(/^[ a-z]*/, '').toUpperCase()),
    }));
  const out = [];
  for (const l of readLines(templateFile)) {
    if (javaTrim(l) === '%%%SpecialCasing%%%') for (const e of entries) out.push(entryToString(e));
    else out.push(l);
  }
  writeLines(gensrcFile, out);
  return 0;
}

module.exports = { main };
