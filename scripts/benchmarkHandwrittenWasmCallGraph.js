#!/usr/bin/env node
'use strict';

/*
 * Architectural floor for a call-dense guest workload.
 *
 * benchmarkCallBoundaryHotLoop.js measures what OUR COMPILER emits for
 * CallBoundaryHotLoop.runCall. This measures what the HOST can do at all, by
 * hand-emitting the same loop as WebAssembly and running it under the same
 * Node build. The gap between the two is our codegen; the gap between this
 * and HotSpot is the architecture.
 *
 * Two hand-written variants, identical arithmetic, differing only in what the
 * per-iteration call targets:
 *
 *   internal  call -> a wasm function in the same module (no host boundary)
 *   imported  call -> an imported JavaScript function (one boundary crossing)
 *
 * That pair is the point. If `internal` is near HotSpot while `imported` is
 * far from it, the cost is boundary crossing and the fix is keeping whole call
 * graphs resident in wasm. If `internal` is itself far from HotSpot, no amount
 * of compiler work reaches the target and the host is the ceiling.
 *
 * Guest semantics are Java's: int is i32 with wrapping arithmetic, so the
 * checksum is compared against HotSpot's rather than assumed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { OP, uleb, sleb } = require('../src/jit/wasmShared');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'benchmarks', 'CallBoundaryHotLoop.java');
const className = 'CallBoundaryHotLoop';
const iterations = Number(process.env.CALL_BOUNDARY_ITERATIONS || 2000000);
const rounds = Number(process.env.CALL_BOUNDARY_ROUNDS || 5);
const warmups = Number(process.env.CALL_BOUNDARY_WARMUPS || 3);
const seed = 12345;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function section(id, payload) {
  return [id, ...uleb(payload.length), ...payload];
}

function vector(entries) {
  return [...uleb(entries.length), ...entries.flat()];
}

function name(text) {
  const bytes = [...Buffer.from(text, 'utf8')];
  return [...uleb(bytes.length), ...bytes];
}

/*
 * step(x) = x * 33 + 17, matching CallBoundaryHotLoop.step.
 */
function stepBody() {
  return [
    OP.local_get, ...uleb(0),
    OP.i32_const, ...sleb(33), OP.i32_mul,
    OP.i32_const, ...sleb(17), OP.i32_add,
    OP.end,
  ];
}

/*
 * runCall(iterations, seed): value = seed; for (i..) value = step(value + i).
 * Locals 0,1 are the parameters; 2 is `value` and 3 is the induction variable.
 */
function runCallBody(stepFunctionIndex, indirect = false) {
  // call_indirect takes the table index from the stack, then the type and
  // table immediates; the table holds step at slot 0.
  const callSeq = indirect
    ? [OP.i32_const, ...sleb(0), 0x11, ...uleb(0), ...uleb(0)]
    : [OP.call, ...uleb(stepFunctionIndex)];
  const code = [
    OP.local_get, ...uleb(1), OP.local_set, ...uleb(2),
    OP.i32_const, ...sleb(0), OP.local_set, ...uleb(3),
    OP.block, 0x40,
    OP.loop, 0x40,
    // if (i >= iterations) break
    OP.local_get, ...uleb(3), OP.local_get, ...uleb(0), OP.i32_ge_s,
    OP.br_if, ...uleb(1),
    // value = step(value + i)
    OP.local_get, ...uleb(2), OP.local_get, ...uleb(3), OP.i32_add,
    ...callSeq,
    OP.local_set, ...uleb(2),
    // i += 1
    OP.local_get, ...uleb(3), OP.i32_const, ...sleb(1), OP.i32_add,
    OP.local_set, ...uleb(3),
    OP.br, ...uleb(0),
    OP.end,
    OP.end,
    OP.local_get, ...uleb(2),
    OP.end,
  ];
  // one local group: two i32 (value, i)
  return [...uleb(1), ...uleb(2), 0x7f, ...code];
}

function functionBody(bytes) {
  return [...uleb(bytes.length), ...bytes];
}

/*
 * `imported` places `step` in the import section, so it occupies function
 * index 0 and the module's own function indices shift accordingly.
 */
function buildModule({ imported, indirect }) {
  const typeStep = [0x60, ...uleb(1), 0x7f, ...uleb(1), 0x7f];
  const typeRun = [0x60, ...uleb(2), 0x7f, 0x7f, ...uleb(1), 0x7f];
  const parts = [];
  parts.push(section(1, vector([typeStep, typeRun])));
  if (indirect) {
    parts.push(section(3, vector([[...uleb(0)], [...uleb(1)]])));
    // one funcref table holding step, so the call target is not statically
    // known at the call site and cannot simply be inlined away
    parts.push(section(4, vector([[0x70, 0x00, ...uleb(1)]])));
    parts.push(section(7, vector([[...name('runCall'), 0x00, ...uleb(1)]])));
    parts.push(section(9, vector([[
      ...uleb(0), OP.i32_const, ...sleb(0), OP.end, ...uleb(1), ...uleb(0),
    ]])));
    parts.push(section(10, vector([
      functionBody([...uleb(0), ...stepBody()]),
      functionBody(runCallBody(0, true)),
    ])));
    return Uint8Array.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...parts.flat(),
    ]);
  }
  if (imported) {
    parts.push(section(2, vector([
      [...name('host'), ...name('step'), 0x00, ...uleb(0)],
    ])));
    // module defines only runCall (type 1); step is import index 0
    parts.push(section(3, vector([[...uleb(1)]])));
    parts.push(section(7, vector([[...name('runCall'), 0x00, ...uleb(1)]])));
    parts.push(section(10, vector([functionBody(runCallBody(0))])));
  } else {
    parts.push(section(3, vector([[...uleb(0)], [...uleb(1)]])));
    parts.push(section(7, vector([[...name('runCall'), 0x00, ...uleb(1)]])));
    parts.push(section(10, vector([
      functionBody([...uleb(0), ...stepBody()]),
      functionBody(runCallBody(0)),
    ])));
  }
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...parts.flat(),
  ]);
}

function hostStep(x) {
  return Math.imul(x, 33) + 17 | 0;
}

function instantiate(variant) {
  const bytes = buildModule({
    imported: variant === 'imported',
    indirect: variant === 'indirect',
  });
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {
    host: { step: hostStep },
  });
  return instance.exports.runCall;
}

function compileFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-handwritten-'));
  execFileSync('javac', ['-source', '8', '-target', '8', '-d', directory, source],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  return directory;
}

function nativeCallResult(directory) {
  const output = execFileSync('java', [
    '-Xbatch', '-cp', directory, className,
    String(iterations), String(rounds), String(warmups),
  ], { encoding: 'utf8' });
  const elapsed = [];
  let checksum = null;
  for (const line of output.split(/\r?\n/)) {
    const match = /^RESULT (\w+) (\d+) (\d+) (-?\d+)$/.exec(line);
    if (!match || match[1] !== 'call') continue;
    elapsed.push(Number(match[3]));
    checksum = Number(match[4]);
  }
  if (!elapsed.length) throw new Error('no RESULT call lines from HotSpot');
  return { median: median(elapsed), checksum };
}

function timeVariant(runCall) {
  const elapsed = [];
  let checksum = null;
  for (let round = 0; round < warmups + rounds; round += 1) {
    const started = process.hrtime.bigint();
    checksum = runCall(iterations, seed) | 0;
    const nanos = Number(process.hrtime.bigint() - started);
    if (round >= warmups) elapsed.push(nanos);
  }
  return { median: median(elapsed), checksum };
}

function main() {
  const directory = compileFixture();
  const native = nativeCallResult(directory);
  const rows = [];
  for (const variant of ['internal', 'indirect', 'imported']) {
    const result = timeVariant(instantiate(variant));
    if (result.checksum !== native.checksum) {
      throw new Error(`${variant}: checksum mismatch wasm=${result.checksum} ` +
        `native=${native.checksum}`);
    }
    rows.push({
      variant,
      nsPerIteration: result.median / iterations,
      slowdown: result.median / native.median,
    });
  }
  console.log(`iterations=${iterations} rounds=${rounds} ` +
    `checksum=${native.checksum}`);
  console.log(`hotspot    ${(native.median / iterations).toFixed(3)
    .padStart(8)} ns/iter   1.00x`);
  for (const row of rows) {
    console.log(`${row.variant.padEnd(10)} ${row.nsPerIteration.toFixed(3)
      .padStart(8)} ns/iter  ${row.slowdown.toFixed(2).padStart(5)}x`);
  }
}

main();
