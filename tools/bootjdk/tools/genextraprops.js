'use strict';
// Port of make/jdk/src/classes/build/tools/generateextraproperties/
// GenerateExtraProperties.java: replaces %%%Property(=Value)%%% lines of a
// template with code point range conditions taken from a UCD property file.
//
// usage: GenerateExtraProperties template props output name...
const { javaTrim } = require('./util');
const { readLines, writeLines, isBlank } = require('./genchar-common');

function toHexString(cp) {
  const s = (cp >>> 0).toString(16).toUpperCase();
  return s.length < 4 ? '0'.repeat(4 - s.length) + s : s;
}

function parseRange(input) {
  input = input.replace(/\s#.*/, '');
  const start = parseInt(input.replace(/[\s.].*/, ''), 16);
  const last = input.includes('..')
    ? parseInt(javaTrim(input.replace(/.*\.\./, '').replace(/;.*/, '')), 16)
    : start;
  return { start, last };
}

function rangeToString(r) {
  if (r.start === r.last) return ' '.repeat(12) + 'cp == 0x' + toHexString(r.start);
  if (r.start === r.last - 1) {
    return ' '.repeat(12) + 'cp == 0x' + toHexString(r.start) + ' ||\n' +
      ' '.repeat(12) + 'cp == 0x' + toHexString(r.last);
  }
  return ' '.repeat(11) + '(cp >= 0x' + toHexString(r.start) + ' && cp <= 0x' + toHexString(r.last) + ')';
}

function main(args) {
  const [templateFile, propertiesFile, gensrcFile] = args;
  const props = readLines(propertiesFile);
  const replacement = new Map();
  for (const name of args.slice(3)) {
    const pn = '; ' + name.replace('=', '; ');
    const ranges = props
      .filter(l => !(l.startsWith('#') || isBlank(l)))
      .filter(l => l.includes(pn))
      .map(l => parseRange(l.replace(/ .*/, '')))
      .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const r of ranges) {
      const lastRange = merged[merged.length - 1];
      if (lastRange && lastRange.last + 1 === r.start) {
        merged[merged.length - 1] = { start: lastRange.start, last: r.last };
      } else merged.push(r);
    }
    replacement.set('%%%' + name + '%%%', merged.map(rangeToString).join(' ||\n') + ';');
  }
  writeLines(gensrcFile, readLines(templateFile).map(l => {
    const t = javaTrim(l);
    return replacement.has(t) ? replacement.get(t) : l;
  }));
  return 0;
}

module.exports = { main };
