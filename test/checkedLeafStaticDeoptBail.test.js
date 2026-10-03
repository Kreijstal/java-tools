const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');

// Geoblox bh.a(BI)I: a read-only sine lookup into another class's static
// table. Prepared before main, the table's class is not initialized, so each
// getstatic keeps its class-initialization arm. The checked-leaf bodies once
// carried the framed arm -- `ssaMaterialize0(pc)` and `frame`, neither bound
// in a frameless body -- and threw "ssaMaterialize0 is not defined" on the
// first call. A checked leaf bails instead; its caller's ordinary call runs
// the initialization. main inserts sin lexically, and an inserted body's bail
// leaves past its result copy: the caller's slot must already hold the bail
// value, or main reads `undefined` and skips its fallback call.
const tableSource = `
public class SineTable {
  static int[] table = new int[4097];
  static {
    for (int i = 0; i < table.length; i++) table[i] = (i * 7) & 1023;
  }
}
`;

const userSource = `
public class SineUser {
  static int sin(byte unused, int angle) {
    if (unused <= 7) return -8;
    angle &= 8191;
    if (angle < 4096) {
      return angle < 2048 ? SineTable.table[angle] : SineTable.table[4096 - angle];
    }
    return angle >= 6144 ? -SineTable.table[8192 - angle]
      : -SineTable.table[angle - 4096];
  }

  public static void main(String[] args) {
    long sum = 0;
    for (int angle = 0; angle < 9000; angle += 7) {
      sum = sum * 31 + sin((byte) 9, angle);
    }
    System.out.println(sum);
  }
}
`;

function reference() {
  const table = Array.from({length: 4097}, (_, i) => (i * 7) & 1023);
  const sin = (angle) => {
    angle &= 8191;
    if (angle < 4096) return angle < 2048 ? table[angle] : table[4096 - angle];
    return angle >= 6144 ? -table[8192 - angle] : -table[angle - 4096];
  };
  let sum = 0n;
  for (let angle = 0; angle < 9000; angle += 7) {
    sum = BigInt.asIntN(64, sum * 31n + BigInt(sin(angle)));
  }
  return String(sum);
}

const leafJit = {compileWorker: false, warmupThreshold: 0, structuredSsa: true,
  checkedLeafDirectPositional: true};

test('a cold checked leaf bails at an uninitialized static read instead of ' +
  'materializing a frame it does not have', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-leaf-static-'));
  t.teardown(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.writeFileSync(path.join(directory, 'SineTable.java'), tableSource);
  fs.writeFileSync(path.join(directory, 'SineUser.java'), userSource);
  execFileSync('javac', ['-g', '-d', directory,
    path.join(directory, 'SineTable.java'),
    path.join(directory, 'SineUser.java')]);

  const jvm = new JVM({classpath: directory, jit: leafJit});
  await jvm.loadClassByName('SineUser');
  await jvm.loadClassByName('SineTable');
  const method = await jvm.findMethodInHierarchy('SineUser', 'sin', '(BI)I');
  const generated = jvm.jit.getGeneratedFunction(method);
  const leafKeys = ['jvmCheckedLeafDirectPositionalBody',
    'jvmTrustedCheckedLeafDirectPositionalBody'];
  for (const key of leafKeys) {
    const body = String(generated?.[key] || '');
    t.ok(/helpers\.staticDeopt\(\)/.test(body),
      `${key} keeps the class-initialization check`);
    t.notOk(/ssaMaterialize|\bframe\b/.test(body),
      `${key} references no frame materialization`);
  }
  t.equal(generated.jvmTrustedCheckedLeafDirectPositionalBody(
    jvm.jit, 9, 100, null), jvm.jit.asyncInvokeSentinel(),
  'the trusted leaf bails before SineTable is initialized');
  const main = jvm.jit.getGeneratedFunction(await jvm.findMethodInHierarchy(
    'SineUser', 'main', '([Ljava/lang/String;)V'));
  t.equal(main?.jvmStructuredLexicalCheckedLeafCallCount, 1,
    'main inserts the leaf, so the run below takes the inserted bail');

  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    await new JVM({classpath: directory, jit: leafJit}).run('SineUser');
  } finally {
    process.stdout.write = originalWrite;
  }
  t.equal(output.trim(), reference(),
    'prepared compiled bodies match the JS reference');
  t.end();
});
