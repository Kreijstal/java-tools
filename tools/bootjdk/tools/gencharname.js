'use strict';
// Port of make/jdk/src/classes/build/tools/generatecharacter/
// CharacterName.java: writes the deflated java/lang/uniName.dat table of
// character names from UnicodeData.txt.
//
// usage: CharacterName UnicodeData.txt uniName.dat
const fs = require('fs');
const { deflate } = require('./genchar-deflate');
const { readLines } = require('./genchar-common');
const { parseSpec } = require('./gencharacter');

function main(args) {
  if (args.length !== 2) {
    process.stderr.write('Usage: java CharacterName UnicodeData.txt uniName.dat\n');
    return 1;
  }
  let namePool = '';
  const cpPool = Buffer.alloc(0x100000);
  const cpBlocks = new Uint8Array(0x110000 >> 8);
  let bkNum = 0, cpNum = 0, lastCp = 0, pos = 0;
  for (const line of readLines(args[0])) {
    if (line.startsWith('#')) continue;
    const spec = parseSpec(line);
    if (spec === null) continue;
    const cp = spec.codePoint;
    let name = spec.name;
    if (name === '<control>' && spec.oldName !== null) {
      if (cp === 0x7) name = 'BEL'; // <control>BELL -> BEL; U+1F514 is BELL
      else if (spec.oldName.length !== 0) name = spec.oldName;
      // "figment" names from NameAliases.txt
      else if (cp === 0x80) name = 'PADDING CHARACTER';
      else if (cp === 0x81) name = 'HIGH OCTET PRESET';
      else if (cp === 0x99) name = 'SINGLE GRAPHIC CHARACTER INTRODUCER';
      else continue;
    } else if (name.startsWith('<')) {
      continue;
    }
    cpNum++;
    if (!cpBlocks[cp >> 8]) { cpBlocks[cp >> 8] = 1; bkNum++; }
    if (cp === lastCp + 1) {
      cpPool[pos++] = name.length & 0xff;
    } else {
      cpPool[pos++] = 0; // segment start flag
      cpPool.writeInt32BE((name.length << 24) | (cp & 0xffffff), pos);
      pos += 4;
    }
    namePool += name;
    lastCp = cp;
  }
  // String.getBytes("ASCII"): anything else becomes '?'
  const names = Buffer.from(namePool.replace(/[^\x00-\x7f]/g, '?'), 'latin1');
  const head = Buffer.alloc(16);
  head.writeInt32BE(pos + names.length, 0);
  head.writeInt32BE(bkNum, 4);
  head.writeInt32BE(cpNum, 8);
  head.writeInt32BE(pos, 12);
  fs.writeFileSync(args[1], deflate(Buffer.concat([head, cpPool.subarray(0, pos), names])));
  return 0;
}

module.exports = { main };
