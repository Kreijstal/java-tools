'use strict';
// Port of make/jdk/src/classes/build/tools/generatecharacter/
// GenerateCaseFolding.java: generates jdk.internal.lang.CaseFolding from
// CaseFolding.txt. The Character.toUpperCase/toLowerCase the Java tool takes
// from the running JDK come from the UnicodeData.txt next to CaseFolding.txt.
//
// usage: GenerateCaseFolding template CaseFolding.txt output
const path = require('path');
const { javaTrim } = require('./util');
const { readLines, writeLines, javaSplit, simpleCaseMaps } = require('./genchar-common');

const hex = s => parseInt(s, 16);

// String.format("0x%013xL", long) for a non-negative value
const long13 = v => '0x' + v.toString(16).padStart(13, '0') + 'L';

function foldingToLong(folding) {
  const cp = hex(folding[0]);
  let value = BigInt(hex(folding[1]));
  if (cp < 0x10000 && folding.length !== 2) {
    let shift = 16n;
    for (let j = 2; j < folding.length; j++) {
      value |= BigInt(hex(folding[j])) << shift;
      shift <<= 1n;
    }
    value |= BigInt(folding.length - 1) << 48n;
  }
  return value;
}

function genFoldingEntries(foldings) {
  let sb = '    private static final int[] CASE_FOLDING_CPS = {\n';
  let width = 10;
  for (let i = 0; i < foldings.length; i++) {
    if (i % width === 0) sb += '        ';
    sb += '0X' + foldings[i][0];
    if (i < foldings.length - 1) sb += ', ';
    if (i % width === width - 1 || i === foldings.length - 1) sb += '\n';
  }
  sb += '    };\n\n';
  sb += '    private static final long[] CASE_FOLDING_VALUES = {\n';
  width = 6;
  for (let i = 0; i < foldings.length; i++) {
    if (i % width === 0) sb += '        ';
    sb += long13(foldingToLong(foldings[i]));
    if (i < foldings.length - 1) sb += ', ';
    if (i % width === width - 1 || i === foldings.length - 1) sb += '\n';
  }
  sb += '    };\n';
  return sb;
}

function main(args) {
  if (args.length !== 3) {
    process.stderr.write('Usage: java GenerateCaseFolding TemplateFile CaseFolding.txt CaseFolding.java\n');
    return 1;
  }
  const [templateFile, caseFoldingTxt, genSrcFile] = args;
  const lines = readLines(caseFoldingTxt).filter(l => !l.startsWith('#'));
  const ch = simpleCaseMaps(path.join(path.dirname(caseFoldingTxt), 'UnicodeData.txt'));

  // java.lang: full/1:M case folding
  const caseFoldings = lines.filter(l => /^.*; [CF]; .*$/.test(l)).map(l => {
    const fields = javaSplit(l, /; /);
    return [fields[0], ...javaSplit(javaTrim(fields[2]), / /)];
  });

  // util.regex
  const expanded = lines.filter(l => /^.*; [CTS]; .*$/.test(l))
    .map(l => javaSplit(l, /; /))
    .filter(cols => {
      // the folding case doesn't map back to the original char
      const cp1 = hex(cols[0]), cp2 = hex(cols[2]);
      return ch.toUpperCase(cp2) !== cp1 && ch.toLowerCase(cp2) !== cp1;
    })
    .map(cols => `        entry(0x${cols[0]}, 0x${cols[2]})`)
    .join(',\n');

  // the logic does not pick 0131; added manually to support 'I's
  const T_0x0131_0x49 = '        entry(0x0131, 0x0049),\n';

  writeLines(genSrcFile, readLines(templateFile)
    .map(l => l.includes('%%%Entries') ? genFoldingEntries(caseFoldings) : l)
    .map(l => l.includes('%%%Expanded_Case_Map_Entries') ? T_0x0131_0x49 + expanded : l));
  return 0;
}

module.exports = { main };
