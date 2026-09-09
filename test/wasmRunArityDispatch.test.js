'use strict';
// callWasmRun replaces `run(...args)` with a fixed-arity call chosen by
// args.length. A wrong arm would pass the wrong arguments to a wasm export --
// a silent miscompile, not a crash -- so pin argument identity and order for
// every arm including the spread fallback, and pin that a real wasm export
// reached through it sees exactly what a spread would have delivered.
const test = require('tape');
const { callWasmRun } = require('../src/jit/wasmShared');

test('callWasmRun passes the same arguments a spread would, at every arity', (t) => {
  for (let arity = 0; arity <= 14; arity += 1) {
    const args = [];
    for (let i = 0; i < arity; i += 1) {
      // Mixed value kinds: an i64 slot is a BigInt and a ref slot is an
      // object, and neither may be coerced on the way through.
      args.push(i % 3 === 0 ? i * 7 : i % 3 === 1 ? BigInt(i) : { slot: i });
    }
    let seen = null;
    const run = (...received) => { seen = received; return arity; };
    const status = callWasmRun(run, args);
    t.equal(status, arity, `arity ${arity}: result returned`);
    t.equal(seen.length, arity, `arity ${arity}: argument count`);
    for (let i = 0; i < arity; i += 1) {
      t.equal(seen[i], args[i], `arity ${arity}: argument ${i} identity`);
    }
  }
  t.end();
});

test('callWasmRun drives a real wasm export identically to a spread', (t) => {
  // (func (export "run") (param i32 i32 i32) (result i32) -> a*100 + b*10 + c)
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x01, 0x60,
    0x03, 0x7f, 0x7f, 0x7f, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07,
    0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00, 0x0a, 0x13, 0x01, 0x11, 0x00,
    0x20, 0x00, 0x41, 0xe4, 0x00, 0x6c, 0x20, 0x01, 0x41, 0x0a, 0x6c, 0x6a,
    0x20, 0x02, 0x6a, 0x0b,
  ]);
  const { run } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
  const args = [3, 4, 5];
  t.equal(callWasmRun(run, args), run(...args), 'same result as the spread call');
  t.equal(callWasmRun(run, args), 345, 'and the arguments arrived in order');
  t.end();
});
