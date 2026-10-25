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
const KNOWN_BUGS = {
  // bug: System.arraycopy never throws ArrayStoreException (Object[] with an
  // Integer into String[] copies everything; int[] -> Object[], "str" -> [])
  // and aastore never checks the element type (Object[] o = new Integer[1];
  // o[0] = "s" succeeds). Closed world additionally crashes with a host
  // TypeError "Cannot convert 0 to a BigInt" (src/jre/arrayCopy.js copyRange)
  // on System.arraycopy(new int[2], 0, new long[2], 0, 2).
  SemArrayStore: 'bug: no ArrayStoreException from arraycopy/aastore; closed world TypeError on int[] -> long[] arraycopy',
  // bug: a throwing <clinit> propagates the raw exception instead of
  // ExceptionInInitializerError (and so later uses never see
  // NoClassDefFoundError): static class F { static int v; static { if (true)
  // throw new RuntimeException("boom"); } } ... catch (ExceptionInInitializerError e)
  // is never taken; the guest dies with RuntimeException: boom.
  SemInitFailure: 'bug: <clinit> exceptions are not wrapped in ExceptionInInitializerError',
  // bug (closed): a default method reading its interface's static field before
  // the interface was initialized reads 0: interface J { int I = three();
  // default int get() { return I; } } -> new Impl().get() prints 0, then J.I
  // prints 3. bug (js): invokevirtual of an inherited default method fails:
  // "Unsupported invokevirtual: Impl.get()I" (src/instructions/invoke.js).
  SemInterfaceInit: 'bug: closed world reads uninitialized interface static from a default method; JS tiers cannot invokevirtual a default method',
  // bug (js, JIT only; interpreter is right): JitCompiler jsLiteral() emits
  // ldc constants with JSON.stringify, so Float.NaN becomes null (0) and
  // -0.0f becomes 0 in compiled code: static float nan() { return Float.NaN; }
  // called hot returns 0.0f; Float.compare(0.0f, -0.0f) yields 0.
  'SemFloat/js': 'bug: JS JIT turns ldc NaN into 0 and -0.0f into 0 (jsLiteral uses JSON.stringify)',
  // bug (js, JIT only): an integral-valued float array-initializer constant in
  // a method already running in a JIT tier is int32-wrapped: after a hot loop,
  // float[] fs = {3.4028235e38f, 2.14748365E9f, 1.5f} holds {0.0f,
  // -2.14748365E9f, 1.5f}.
  'SemFloatArrayLiteral/js': 'bug: JS JIT int32-wraps integral float constants in array initializers',
  // bug (js, interpreter and JIT): d2i/f2i wrap instead of saturating
  // ((int) 1e10 == 1410065408, (int) Double.NEGATIVE_INFINITY == 2147483648),
  // d2l/f2l do not saturate ((long) 1e19 == 10000000000000000000), and l2f
  // double-rounds through double ((float) 0x7fffffbfffffffffL is 5f000000,
  // HotSpot 5effffff). src/instructions/conversions.js.
  'SemFloatConvert/js': 'bug: d2i/d2l/f2i/f2l do not saturate and l2f double-rounds in the JS tiers',
  // bug: float-to-decimal formatting prints the double expansion: "" + 0.1f
  // is "0.10000000149011612" (HotSpot "0.1"), 1e7f is "1E7" (HotSpot
  // "1.0E7"); same through Float.toString, String.valueOf and
  // StringBuilder.append(float). The JS tiers also hit the
  // SemFloatArrayLiteral bug here.
  SemFloatToString: 'bug: float formatting prints the double expansion (0.1f -> 0.10000000149011612)',
  // bug: ldiv/lrem compare the BigInt divisor with === 0, so a zero long
  // divisor throws a host RangeError instead of ArithmeticException
  // (src/instructions/math.js; closed world is right); Math.abs(Long.MIN_VALUE)
  // returns +2^63 (unwrapped BigInt) and Math.abs(Integer.MIN_VALUE) returns
  // 2147483648 in the JS tiers.
  'SemLongEdges/js': 'bug: long division by zero is a host RangeError; Math.abs(MIN_VALUE) does not wrap in the JS tiers',
  // bug: the JRE lacks Math.floorDiv/floorMod (long and int),
  // Long.signum/numberOfTrailingZeros/numberOfLeadingZeros/bitCount:
  // NoSuchMethodError java/lang/Math.floorDiv(JJ)J.
  SemLongMathLibrary: 'bug: Math.floorDiv/floorMod and Long bit helpers are missing (NoSuchMethodError)',
  // bug: System.out.println(Object) does not call the guest toString():
  // println(new StringBuilder("sb")) prints "[object Object]" (closed) or
  // "StringBuilder" (js); a guest class with toString() prints its class name.
  SemPrintObject: 'bug: println(Object) ignores toString() (prints [object Object] / class name)',
};

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
