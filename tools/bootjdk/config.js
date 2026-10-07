'use strict';
// Configuration of a generated shim boot JDK (see make-shim.js): the JDK
// version it reports and where javac-js finds the platform's Java sources.
const fs = require('fs');
const path = require('path');

const home = process.env.BOOTJDK_SHIM_HOME;
const conf = home ? JSON.parse(fs.readFileSync(path.join(home, 'conf', 'shim.json'), 'utf8')) : {};

const VERSION = conf.version || '28';

// Source roots standing in for the platform class library, highest priority
// first per module: generated sources, then the OS, OS type and shared
// directories, as the JDK build itself layers them.
function platformRoots() {
  if (!conf.jdkSrc) throw new Error('BOOTJDK_SHIM_HOME is not set or conf/shim.json names no jdkSrc');
  const srcDir = path.join(conf.jdkSrc, 'src');
  const roots = [];
  for (const m of fs.readdirSync(srcDir).sort()) {
    const cands = [];
    for (const g of conf.gensrc || []) cands.push(path.join(g, m));
    for (const d of [conf.os, conf.osType, 'share']) if (d) cands.push(path.join(srcDir, m, d, 'classes'));
    for (const c of cands) if (fs.existsSync(c)) roots.push(c);
  }
  return roots;
}

module.exports = { VERSION, conf, platformRoots };
