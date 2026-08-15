#!/usr/bin/env node
'use strict';

/*
 * Run benchmarks/OpcodeDifferential.java on HotSpot and on the JS JVM, once
 * per wasm backend, and report any shape whose checksum disagrees.
 *
 * Why HotSpot is the oracle: comparing our two backends against each other
 * only says they differ, not which is wrong, and comparing either against our
 * own interpreter shares any bug that lives in shared decode. The real JVM is
 * the only independent authority.
 *
 * Usage: node scripts/checkWasmOpcodeDifferential.js [--n 4000] [--seed N]
 * Exits non-zero if any backend disagrees with HotSpot.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'benchmarks', 'OpcodeDifferential.java');
const className = 'OpcodeDifferential';

function parseArgs(argv) {
  const options = { n: 4000, seed: 123456789 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--n') options.n = Number(argv[++i]);
    else if (argv[i] === '--seed') options.seed = Number(argv[++i]);
  }
  return options;
}

function compileFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-opcode-diff-'));
  execFileSync('javac', ['-source', '8', '-target', '8', '-d', dir, source],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  return dir;
}

function hotspotResults(dir, options) {
  const out = execFileSync('java', ['-cp', dir, className,
    String(options.n), String(options.seed)], { encoding: 'utf8' });
  const map = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = /^RESULT (\w+) (-?\d+)$/.exec(line);
    if (m) map.set(m[1], Number(m[2]));
  }
  if (!map.size) throw new Error('no RESULT lines from HotSpot');
  return map;
}

/*
 * Each shape runs in a freshly spawned process so the backend flags apply from
 * the first compile; toggling them inside one process would leave already
 * compiled modules in place and silently measure the wrong backend.
 */
function guestResult(dir, shape, options, env) {
  const runner = `
    const { JVM } = require(${JSON.stringify(path.join(root, 'src/core/jvm'))});
    const Frame = require(${JSON.stringify(path.join(root, 'src/core/frame'))});
    const Stack = require(${JSON.stringify(path.join(root, 'src/core/stack'))});
    (async () => {
      const jvm = new JVM({ classpath: [${JSON.stringify(dir)}],
        jit: { enabled: true, warmupThreshold: 0 } });
      const cd = await jvm.loadClassByName(${JSON.stringify(className)});
      if (!cd.staticFields) cd.staticFields = new Map();
      cd.staticFieldsInitialized = true;
      jvm.classInitializationState.set(${JSON.stringify(className)}, 'INITIALIZED');
      const thread = { id: 1, name: 'diff', status: 'runnable',
        pendingException: null, callStack: new Stack() };
      jvm.threads = [thread];
      jvm.currentThreadIndex = 0;
      const method = await jvm.findMethodInHierarchy(
        ${JSON.stringify(className)}, ${JSON.stringify(shape)}, '(II)I');
      const caller = new Frame({ name: 'sentinel', descriptor: '()V', attributes: [{
        type: 'code', code: { codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
          localsSize: '0', stackSize: '1', exceptionTable: [] } }] });
      const frame = new Frame(method);
      frame.className = ${JSON.stringify(className)};
      frame.locals[0] = ${options.n};
      frame.locals[1] = ${options.seed};
      thread.callStack.push(caller);
      thread.callStack.push(frame);
      let ticks = 0;
      while (thread.callStack.size() > 1) {
        await jvm.executeTick();
        if (++ticks > 200000000) throw new Error('tick limit');
      }
      console.log('VALUE ' + (caller.stack.pop() | 0));
      process.exit(0);
    })().catch((e) => { console.log('ERROR ' + (e && e.message)); process.exit(3); });
  `;
  const res = execFileSync(process.execPath, ['-e', runner], {
    encoding: 'utf8', env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const m = /^VALUE (-?\d+)$/m.exec(res);
  if (!m) throw new Error(`no VALUE for ${shape}: ${res.trim().slice(0, 200)}`);
  return Number(m[1]);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dir = compileFixture();
  const native = hotspotResults(dir, options);
  const backends = [
    { name: 'structured', env: { JVM_WASM_JIT: '1', JVM_WASM_STRUCTURED: '1' } },
    { name: 'dispatcher', env: { JVM_WASM_JIT: '1', JVM_WASM_STRUCTURED: '0' } },
    { name: 'no-wasm', env: { JVM_WASM_JIT: '0' } },
  ];
  let failures = 0;
  console.log(`n=${options.n} seed=${options.seed}`);
  console.log(`${'shape'.padEnd(13)}${'hotspot'.padStart(13)}` +
    backends.map((b) => b.name.padStart(13)).join(''));
  for (const [shape, expected] of native) {
    const cells = [];
    for (const backend of backends) {
      let got;
      try {
        got = guestResult(dir, shape, options, backend.env);
      } catch (err) {
        got = `ERR`;
      }
      const bad = got !== expected;
      if (bad) failures += 1;
      cells.push(`${bad ? '*' : ''}${got}`.padStart(13));
    }
    console.log(shape.padEnd(13) + String(expected).padStart(13) + cells.join(''));
  }
  if (failures) {
    console.log(`\n${failures} backend/shape disagreements with HotSpot ` +
      `(marked *)`);
    process.exit(1);
  }
  console.log('\nall backends agree with HotSpot');
}

main();
