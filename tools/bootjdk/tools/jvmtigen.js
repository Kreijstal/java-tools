'use strict';
// Stand-in for src/hotspot/share/prims/jvmtiGen.java, which applies one of
// the jvmti*.xsl stylesheets to jvmti.xml with the JDK's built-in XSLT
// processor (Xalan). This runs xsltproc instead, on a copy of the
// stylesheets with two differences between the processors smoothed over:
//  - Xalan ignores stray text directly inside xsl:choose (jvmtiEnter.xsl has
//    "<xsl:choose>g"); libxslt rejects the stylesheet.
//  - Xalan sorts text keys with the en_US collator, libxslt by code point
//    unless xsl:sort names a language, so each text xsl:sort gets lang="en".
// Xalan also writes the platform line separator for each newline.
// With these, jvmtiEnter.cpp, jvmtiEnterTrace.cpp, jvmtiEnv.hpp and jvmti.h
// match the Java tool's output; jvmti.html (documentation only) differs in
// HTML serialization.
//
// usage: jvmtiGen [-verbose] -IN xml -XSL xsl -OUT out [-PARAM name value ...]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { LNSEP } = require('./util');

function usage() {
  process.stderr.write('usage:\n  java jvmtiGen [-verbose] -IN <input XML file name> -XSL <XSL file> -OUT <output file name> [-PARAM <name> <expression> ...]\n');
  return 2;
}

function patchStylesheet(text) {
  return text
    .replace(/(<xsl:choose>)[^<\s]+/g, '$1')
    .replace(/<xsl:sort((?:\s+(?!lang=|data-type="number")[\w-]+="[^"]*")*)\s*\/>/g, '<xsl:sort$1 lang="en"/>');
}

function main(argv) {
  let inFile = null, xslFile = null, outFile = null, verbose = false;
  const params = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-verbose') verbose = true;
    else if (a === '-IN') inFile = argv[++i];
    else if (a === '-XSL') xslFile = argv[++i];
    else if (a === '-OUT') outFile = argv[++i];
    else if (a === '-PARAM') {
      if (i + 2 < argv.length) params.push(argv[++i], argv[++i]);
      else return usage();
    } else return usage();
  }
  if (!inFile || !xslFile || !outFile) return usage();

  // copy the stylesheet and its siblings (xsl:import is relative)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jvmtigen-'));
  try {
    const xslDir = path.dirname(path.resolve(xslFile));
    for (const f of fs.readdirSync(xslDir)) {
      if (f.endsWith('.xsl')) fs.writeFileSync(path.join(tmp, f), patchStylesheet(fs.readFileSync(path.join(xslDir, f), 'utf8')));
    }
    const out = path.join(tmp, 'out');
    const args = ['--xinclude', '--nonet'];
    for (let i = 0; i < params.length; i += 2) args.push('--stringparam', params[i], params[i + 1]);
    args.push('-o', out, path.join(tmp, path.basename(xslFile)), inFile);
    if (verbose) process.stderr.write(`xsltproc ${args.join(' ')}\n`);
    const r = spawnSync(process.env.XSLTPROC || 'xsltproc', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.error) {
      process.stderr.write(`jvmtiGen error: cannot run xsltproc: ${r.error.message}\n`);
      return 1;
    }
    if (r.status !== 0) {
      process.stderr.write(`jvmtiGen error: xsltproc exited with status ${r.status}\n`);
      return 1;
    }
    let text = fs.readFileSync(out, 'latin1');
    if (LNSEP !== '\n') text = text.replace(/\n/g, LNSEP);
    fs.writeFileSync(outFile, text, 'latin1');
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { main, patchStylesheet };
