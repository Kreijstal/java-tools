'use strict';
// Java semantics checked against HotSpot. Each fixture under
// test/fixtures/semantics runs its kernels in hot loops (so the JIT tiers
// compile them) and prints checksums and edge values; jvm.js must print
// exactly what HotSpot prints.
//
// The first run uses jvm.js's default configuration for this Node: closed
// world (one Wasm GC module) where JS Promise Integration exists, the JS/
// partial-Wasm tiers otherwise. A second run covers the other configuration,
// so one Node run exercises both paths: on a JSPI Node, closedWorld: false;
// on an older Node, the defaults again under a JSPI Node (jspiNode()).
const test = require('tape');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { hotspot, runDetailed, jspiNode } = require('./helpers/closedWorld');

const FIXTURES = path.join(__dirname, 'fixtures', 'semantics');

function haveTool(name) {
  const result = spawnSync(name, ['-version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}
const skipReason = haveTool('java') && haveTool('javac') ? null : 'HotSpot java/javac unavailable';

let classes;
function compileAll() {
  if (classes) return classes;
  classes = fs.mkdtempSync(path.join(os.tmpdir(), 'java-semantics-'));
  const sources = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.java')).map((f) => path.join(FIXTURES, f));
  execFileSync('javac', ['--release', '8', '-nowarn', '-d', classes, ...sources], { stdio: ['ignore', 'ignore', 'pipe'] });
  return classes;
}

const hasJspiHere = typeof WebAssembly.Suspending === 'function';
const otherJspi = jspiNode();
// `wasmHeap: undefined` drops the helper's forced linear heap, so jvm.js
// picks every option itself.
const DEFAULTS = { wasmHeap: undefined };
// `tiers` names the execution path: 'closed' (closed-world Wasm GC module)
// or 'js' (interpreter, JS JIT and partial Wasm).
const configurations = [{ label: 'default', tiers: hasJspiHere ? 'closed' : 'js', options: DEFAULTS }];
if (hasJspiHere) configurations.push({ label: 'closedWorld:false', tiers: 'js', options: { ...DEFAULTS, closedWorld: false } });
else if (otherJspi && otherJspi !== process.execPath) configurations.push({ label: `default on ${otherJspi}`, tiers: 'closed', options: { ...DEFAULTS, jspiNode: true } });

// Known jvm.js bugs, keyed `Fixture` (every configuration) or
// `Fixture/closed` / `Fixture/js`: the test is skipped with the reason.
// Empty: every fixture matches HotSpot.
const KNOWN_BUGS = {};

const fixtures = fs.readdirSync(FIXTURES).filter((f) => /^Sem.*\.java$/.test(f)).map((f) => f.slice(0, -5)).sort();

for (const fixture of fixtures) {
  for (const { label, tiers, options } of configurations) {
    // JVM_SEMANTICS_KNOWN_BUGS=1 runs the known-bug cases too.
    const known = process.env.JVM_SEMANTICS_KNOWN_BUGS === '1' ? null
      : KNOWN_BUGS[`${fixture}/${tiers}`] || KNOWN_BUGS[fixture];
    test(`${fixture} matches HotSpot (${label}, ${tiers})`, { skip: skipReason || known || false, timeout: 60000 }, (t) => {
      const directory = compileAll();
      const expected = hotspot(directory, fixture);
      const actual = runDetailed(directory, fixture, options);
      t.equal(actual.failure, null, `guest finished without failure${actual.failure ? `: ${actual.stderr.slice(-2000)}` : ''}`);
      t.equal(actual.output, expected, 'stdout matches HotSpot');
      t.end();
    });
  }
}
