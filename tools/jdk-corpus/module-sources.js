#!/usr/bin/env node
'use strict';
// List the source files of a module the way the JDK build sees them: for the
// same relative path, gensrc overrides the OS specific directory, which
// overrides the OS type directory, which overrides share.
// usage: module-sources.js dir1 dir2 ... (highest priority first)
const fs = require('fs');
const path = require('path');
const seen = new Map();
for (const root of process.argv.slice(2)) {
  if (!fs.existsSync(root)) continue;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== 'snippet-files') walk(path.join(d, e.name), r); }
      else if (e.name.endsWith('.java') && e.name !== 'module-info.java' && e.name !== 'package-info.java' && !seen.has(r)) seen.set(r, path.join(d, e.name));
    }
  };
  walk(root, '');
}
for (const f of seen.values()) console.log(f);
