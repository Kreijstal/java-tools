#!/usr/bin/env node
'use strict';
// Entry point of the shim boot JDK's bin/ scripts: launcher.js <tool> args...
const tool = process.argv[2];
const args = process.argv.slice(3);

function finish(code) {
  process.exitCode = code & 0xff;
}

switch (tool) {
  case 'java':
    require('./java').main(args, finish);
    break;
  case 'javac':
    require('./javac').main(args, finish);
    break;
  case 'jar':
  case 'javadoc':
    if (args.includes('--help') || args.includes('-help')) {
      process.stdout.write(tool === 'jar' ? 'Usage: jar [OPTION...] [ [--release VERSION] [-C dir] files] ...\n' : 'Usage: javadoc [options] [packagenames] [sourcefiles] [@files]\n');
      finish(0);
    } else if (args.includes('-version') || args.includes('--version')) {
      process.stdout.write(`${tool} ${require('./config').VERSION}\n`);
      finish(0);
    } else {
      process.stderr.write(`shim ${tool}: not implemented\n`);
      finish(1);
    }
    break;
  default:
    process.stderr.write(`shim: unknown tool ${tool}\n`);
    finish(1);
}
