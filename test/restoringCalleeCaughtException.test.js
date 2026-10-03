const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');

// Geoblox wf.b(ZI)V stores `ib.e = ma.b(15869)`. ma.b is a restoring direct
// positional body: it pumps the network client (em.a -> bj.b -> bj.a) before
// checking its argument. bj.a throws a RuntimeException and catches it itself.
// That throw unwinds the positional chain; every level restores its frame and
// rethrows. The structured caller restored itself *before* the invoke (pc and
// argument still on its stack) because the callee was a restoring body, as if
// the exception were its own. bj.a then handled it, ma.b returned normally onto
// that stack, and wf.b replayed the invoke with the stale return value as the
// argument: ma.b(0) answered 61 ("bad key"), read as a JS5 error, and the game
// dropped its lobby connection. A caller whose call left a child frame must
// resume after the invoke, whatever ABI the callee used.
const source = `
public class ReplayCaller {
  static int status(int key) {
    Pump.pump();
    if (key != 15869) return 61;
    return Pump.count & 1;
  }

  static int tick() {
    return status(15869);
  }

  // The same restoring shape, but the exception escapes the callee: the
  // caller's own handler, whose range starts at the invoke, must catch it.
  static int checked(int key) {
    Pump.pump();
    return Pump.slots[(Pump.count & 7) == 0 ? 9 : key & 3];
  }

  static int guarded(int key) {
    try {
      return checked(key);
    } catch (ArrayIndexOutOfBoundsException e) {
      return 99;
    }
  }

  public static void main(String[] args) {
    long guardedSum = 0;
    for (int i = 0; i < 400; i++) {
      guardedSum = guardedSum * 31 + guarded(i);
    }
    int bad = 0;
    long sum = 0;
    for (int i = 0; i < 400; i++) {
      int value = tick();
      if (value == 61) bad++;
      sum = sum * 31 + value;
    }
    System.out.println(guardedSum + " " + bad + " " + sum);
  }
}

class Pump {
  static int count;
  static int[] slots = {0, 1, 2, 3};

  static void pump() {
    count++;
    Pump.step(count);
  }

  static int step(int index) {
    try {
      return Pump.read(index);
    } catch (RuntimeException e) {
      return -1;
    }
  }

  static int read(int index) {
    if ((index & 3) == 0) throw new IllegalStateException("caught by step");
    return slots[index & 3];
  }
}
`;

function reference() {
  let guardedSum = 0n;
  for (let i = 0; i < 400; i++) {
    const value = ((1 + i) & 7) === 0 ? 99 : i & 3;
    guardedSum = BigInt.asIntN(64, guardedSum * 31n + BigInt(value));
  }
  let sum = 0n;
  for (let i = 0; i < 400; i++) {
    sum = BigInt.asIntN(64, sum * 31n + BigInt((401 + i) & 1));
  }
  return `${guardedSum} 0 ${sum}`;
}

const jitOptions = {compileWorker: false, warmupThreshold: 0, structuredSsa: true};

test('a caller resumes after the invoke when a restoring callee\'s ' +
  'descendant catches the exception', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-restoring-catch-'));
  t.teardown(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.writeFileSync(path.join(directory, 'ReplayCaller.java'), source);
  execFileSync('javac', ['-g', '-d', directory,
    path.join(directory, 'ReplayCaller.java')]);

  const probe = new JVM({classpath: directory, jit: jitOptions});
  await probe.loadClassByName('ReplayCaller');
  await probe.loadClassByName('Pump');
  const status = probe.jit.getGeneratedFunction(
    await probe.findMethodInHierarchy('ReplayCaller', 'status', '(I)I'));
  t.equal(typeof status?.jvmRestoringDirectPositionalBody, 'function',
    'status has the restoring direct positional ABI, like ma.b');
  const checked = probe.jit.getGeneratedFunction(
    await probe.findMethodInHierarchy('ReplayCaller', 'checked', '(I)I'));
  t.equal(typeof checked?.jvmRestoringDirectPositionalBody, 'function',
    'checked has the restoring direct positional ABI');

  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    await new JVM({classpath: directory, jit: jitOptions}).run('ReplayCaller');
  } finally {
    process.stdout.write = originalWrite;
  }
  t.equal(output.trim(), reference(),
    'no call is replayed with a stale return value as its argument, and an ' +
    'escaping exception reaches the handler that covers the invoke');
  t.end();
});
