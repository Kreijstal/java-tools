const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');

// A structured call site has a fast positional call and the canonical invoke
// it falls back to while the site is unlinked. Each carried its own copy of
// the exception arm, and the canonical invoke staged the operand stack inline
// at every site. Geoblox's 9-slice painter (28 call sites) spent over half of
// its bytecode on that protocol and sat at SpiderMonkey's Ion size limit. One
// handler now covers both invocations, and the framed and adaptive bodies
// stage the canonical invoke through a helper per operand count. Exceptions
// from either invocation must still restore the caller at the right pc,
// whether the caller itself handles them or its own caller does.
const source = `
public class SharedHandlerMain {
  static int calls;

  // Throws on its first invocation (the unlinked, canonical invoke) and
  // again later through the linked positional call.
  static int check(int value) {
    calls++;
    if (value % 7 == 0) throw new IllegalStateException("check " + value);
    return value * 2;
  }

  static int pair(int left, int right) {
    if (left == right) throw new ArithmeticException("pair " + left);
    return left - right;
  }

  static int mix(int a, int b, int c) {
    return a * 3 + b * 5 + c;
  }

  // Caught by this method's own handlers.
  static int caughtHere(int count) {
    int sum = 0, caught = 0;
    for (int i = 0; i < count; i++) {
      try {
        sum += check(i);
      } catch (IllegalStateException e) {
        caught++;
      }
      try {
        sum += pair(i, i % 5);
      } catch (ArithmeticException e) {
        caught += 10;
      }
      sum += mix(i, sum & 7, caught);
    }
    return sum * 31 + caught;
  }

  // No handler here: the exception restores this frame and unwinds to main.
  static int escapes(int start, int count) {
    int sum = 0;
    for (int i = start; i < start + count; i++) {
      sum += mix(sum & 15, i, 1);
      sum += pair(i, 4) + check(i);
    }
    return sum;
  }

  public static void main(String[] args) {
    long total = caughtHere(60);
    int escaped = 0;
    for (int start = 0; start < 40; start += 3) {
      try {
        total = total * 31 + escapes(start, 6);
      } catch (RuntimeException e) {
        escaped++;
        total = total * 7 + e.getMessage().length();
      }
    }
    System.out.println(total + " " + escaped + " " + calls);
  }
}
`;

function reference() {
  let calls = 0;
  const check = (value) => {
    calls++;
    if (value % 7 === 0) throw new Error(`check ${value}`);
    return value * 2;
  };
  const pair = (left, right) => {
    if (left === right) throw new Error(`pair ${left}`);
    return left - right;
  };
  const mix = (a, b, c) => (a * 3 + b * 5 + c) | 0;
  const caughtHere = (count) => {
    let sum = 0, caught = 0;
    for (let i = 0; i < count; i++) {
      try { sum = (sum + check(i)) | 0; } catch (_) { caught++; }
      try { sum = (sum + pair(i, i % 5)) | 0; } catch (_) { caught += 10; }
      sum = (sum + mix(i, sum & 7, caught)) | 0;
    }
    return (Math.imul(sum, 31) + caught) | 0;
  };
  const escapes = (start, count) => {
    let sum = 0;
    for (let i = start; i < start + count; i++) {
      sum = (sum + mix(sum & 15, i, 1)) | 0;
      sum = (sum + ((pair(i, 4) + check(i)) | 0)) | 0;
    }
    return sum;
  };
  let total = BigInt(caughtHere(60));
  let escaped = 0;
  for (let start = 0; start < 40; start += 3) {
    try {
      total = BigInt.asIntN(64, total * 31n + BigInt(escapes(start, 6)));
    } catch (error) {
      escaped++;
      total = BigInt.asIntN(64, total * 7n + BigInt(error.message.length));
    }
  }
  return `${total} ${escaped} ${calls}`;
}

const jit = {compileWorker: false, warmupThreshold: 0, structuredSsa: true,
  compiledCallChains: true, ordinaryAdaptiveFramelessPositional: true,
  ordinaryAdaptiveCallChainSafePointBudget: 1};

async function compile(directory, options) {
  const jvm = new JVM({classpath: directory, jit: options});
  await jvm.loadClassByName('SharedHandlerMain');
  const method = await jvm.findMethodInHierarchy(
    'SharedHandlerMain', 'escapes', '(II)I');
  return jvm.jit.getGeneratedFunction(method, {allowEffectfulCalls: true});
}

async function run(directory, options) {
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    await new JVM({classpath: directory, jit: options}).run('SharedHandlerMain');
  } finally {
    process.stdout.write = originalWrite;
  }
  return output.trim();
}

test('call sites share one exception handler and outline the canonical ' +
  'invoke without changing exception behaviour', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-shared-handler-'));
  t.teardown(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.writeFileSync(path.join(directory, 'SharedHandlerMain.java'), source);
  execFileSync('javac', ['-g', '-d', directory,
    path.join(directory, 'SharedHandlerMain.java')]);

  const generated = await compile(directory, jit);
  const adaptive = String(generated?.jvmAdaptivePositionalBody || '');
  t.ok(adaptive.length > 0, 'escapes has an adaptive positional body');
  const sites = (adaptive.match(/__JVM_REGION_CALL_START_\d+__/g) || []).length;
  t.equal(sites, 3, 'the body has three call sites');
  t.equal((adaptive.match(/\bcatch \(/g) || []).length, sites,
    'one exception handler per call site');
  t.notOk(/tryInvokeSyncAtSite\(ssa/.test(adaptive),
    'the canonical invoke is staged through the outlined helper');
  // The staged stack holds the running sum below the arguments, so the
  // three sites need four, three and three operands.
  t.deepEqual((adaptive.match(/const ssaSlowInvoke\d+ = /g) || []),
    ['const ssaSlowInvoke3 = ', 'const ssaSlowInvoke4 = '],
    'one helper per operand count');
  t.equal((adaptive.match(/= ssaSlowInvoke\d+\(/g) || []).length, sites,
    'every site calls one');
  t.ok(/ssaColdCallOrdinary\(thread, /.test(adaptive),
    'the cold-call arm goes through the body-local wrapper');
  const restoring = String(generated?.jvmRestoringDirectPositionalBody || '');
  if (restoring) {
    t.notOk(/ssaSlowInvoke|ssaColdCallOrdinary/.test(restoring),
      'the restoring body keeps its own frame reconstruction');
  }

  const expected = reference();
  t.equal(await run(directory, jit), expected,
    'compact call sites match the JS reference');
  t.equal(await run(directory, {...jit, structuredSharedCallHandlers: false,
    structuredSlowCallOutlining: false}), expected,
  'and so do the separate handlers');
  t.end();
});
