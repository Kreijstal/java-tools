'use strict';
// Port of make/jdk/src/classes/build/tools/module/GenModuleLoaderMap.java:
// fills the module name lists into jdk/internal/module/ModuleLoaderMap.java.
//
// usage: GenModuleLoaderMap -o <output-file> -boot m1[,m2]* -platform m3[,m4]*
//            [-native-access m5[,m6]*] <original-source>
const fs = require('fs');
const { LNSEP } = require('./util');
const { compareStrings } = require('./misc-java');

// String.split(",") drops trailing empty strings
function splitComma(s) {
  const parts = s.split(',');
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function main(args) {
  const lists = { '-boot': [], '-platform': [], '-native-access': [] };
  let outfile = null, source = null;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option.startsWith('-')) {
      const arg = args[++i];
      if (option in lists) lists[option].push(...splitComma(arg));
      else if (option === '-o') outfile = arg;
      else throw new Error('invalid option: ' + option);
    } else source = option;
  }
  if (outfile === null) throw new Error('-o must be specified');
  if (!fs.existsSync(source)) throw new Error(source + ' not exist');

  const patch = (s, tag, mns) =>
    s.split(tag).join([...mns].sort(compareStrings).join('",\n            "'));
  const lines = fs.readFileSync(source, 'utf8').split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === '') lines.pop();
  let out = '';
  for (let line of lines) {
    if (line.includes('@@BOOT_MODULE_NAMES@@')) line = patch(line, '@@BOOT_MODULE_NAMES@@', lists['-boot']);
    else if (line.includes('@@PLATFORM_MODULE_NAMES@@')) line = patch(line, '@@PLATFORM_MODULE_NAMES@@', lists['-platform']);
    else if (line.includes('@@NATIVE_ACCESS_MODULE_NAMES@@')) {
      line = patch(line, '@@NATIVE_ACCESS_MODULE_NAMES@@', lists['-native-access']);
    }
    out += line + LNSEP;
  }
  fs.writeFileSync(outfile, out);
  return 0;
}

module.exports = { main };
