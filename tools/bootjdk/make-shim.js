#!/usr/bin/env node
'use strict';
// Create a shim boot JDK: a directory whose bin/java, bin/javac, bin/jar and
// bin/javadoc run this directory's JavaScript tools on Node (shell scripts,
// or small executables built from launcher-win.c on Windows).
// It lets the JDK's configure and make run without any binary JDK.
//
// usage: make-shim.js --jdk-src DIR [--gensrc DIR]... [--os NAME] [--os-type NAME]
//                     [--version N] OUTDIR
//   --jdk-src  the JDK source tree whose classes stand in for the platform API
//   --gensrc   a directory of generated sources laid out per module, as in
//              <build>/support/gensrc (may not exist yet)
//   --os, --os-type  source subdirectories to use (default: windows/windows on
//              Windows, linux/unix elsewhere)
const fs = require('fs');
const path = require('path');

const o = { gensrc: [], version: '28' };
const rest = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--jdk-src') o.jdkSrc = path.resolve(argv[++i]);
  else if (a === '--gensrc') o.gensrc.push(path.resolve(argv[++i]));
  else if (a === '--os') o.os = argv[++i];
  else if (a === '--os-type') o.osType = argv[++i];
  else if (a === '--version') o.version = argv[++i];
  else rest.push(a);
}
if (rest.length !== 1 || !o.jdkSrc) {
  process.stderr.write('usage: make-shim.js --jdk-src DIR [--gensrc DIR]... [--os NAME] [--os-type NAME] [--version N] OUTDIR\n');
  process.exit(2);
}
const win = process.platform === 'win32';
o.os = o.os || (win ? 'windows' : 'linux');
o.osType = o.osType || (win ? 'windows' : 'unix');

const out = path.resolve(rest[0]);
fs.mkdirSync(path.join(out, 'bin'), { recursive: true });
fs.mkdirSync(path.join(out, 'conf'), { recursive: true });
fs.writeFileSync(path.join(out, 'conf', 'shim.json'), `${JSON.stringify(o, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'release'), `JAVA_VERSION="${o.version}"\nIMPLEMENTOR="javac-js shim"\n`);

const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const cstr = (s) => `L"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const launcher = path.join(__dirname, 'launcher.js');
for (const tool of ['java', 'javac', 'jar', 'javadoc']) {
  const f = path.join(out, 'bin', tool);
  if (win) {
    // a real executable: the JDK build runs Windows programs through fixpath,
    // which converts paths in arguments and @argfiles; scripts get no fixpath
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.env.CC || 'gcc', ['-O2', '-municode', '-s',
      `-DSHIM_HOME=${cstr(out)}`, `-DSHIM_LAUNCHER=${cstr(launcher)}`, `-DSHIM_TOOL=${cstr(tool)}`,
      '-o', `${f}.exe`, path.join(__dirname, 'launcher-win.c')], { stdio: 'inherit' });
    if (r.status !== 0) {
      process.stderr.write(`compiling ${tool}.exe failed\n`);
      process.exit(1);
    }
    fs.rmSync(f, { force: true });
    continue;
  }
  const script = [
    '#!/bin/sh',
    `BOOTJDK_SHIM_HOME=${q(out)}`,
    'export BOOTJDK_SHIM_HOME',
    `exec node ${q(launcher)} ${tool} "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(f, script);
  fs.chmodSync(f, 0o755);
}
process.stdout.write(`shim boot JDK written to ${out}\n`);
