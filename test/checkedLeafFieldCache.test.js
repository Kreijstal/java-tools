'use strict';
// Kreijstal/java-tools#403: a nested reference-field predicate
// (`return this.a.b != null`) called in a hot loop once escaped a host
// ReferenceError as an unhandled guest exception. The program must print what
// HotSpot prints for a non-null terminal field, a null terminal field and a
// null intermediate receiver.
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { JVM } = require('../src/core/jvm');

const CLASS_NAME = 'FieldCacheLeaf';
const SOURCE = `
public final class FieldCacheLeaf {
  Payload payload = new Payload();
  final boolean ready() { return this.payload.bytes != null; }
  static int drive(FieldCacheLeaf leaf, int rounds) {
    int hits = 0;
    for (int i = 0; i < rounds; i++) {
      if (leaf.ready()) hits++;
    }
    return hits;
  }
  public static void main(String[] args) {
    FieldCacheLeaf leaf = new FieldCacheLeaf();
    int present = drive(leaf, 384);
    leaf.payload.bytes = null;
    int absent = drive(leaf, 384);
    leaf.payload = null;
    int broken;
    try {
      broken = drive(leaf, 384);
    } catch (NullPointerException e) {
      broken = -1;
    }
    System.out.println(present + " " + absent + " " + broken);
  }
}
final class Payload {
  byte[] bytes = new byte[1];
}
`;

function compileFixture(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checked-leaf-field-cache-'));
  t.teardown(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const sourcePath = path.join(tempDir, `${CLASS_NAME}.java`);
  fs.writeFileSync(sourcePath, SOURCE);
  execFileSync('javac', ['-g', '-d', tempDir, sourcePath], { stdio: 'inherit' });
  return tempDir;
}

test('a nested field null check in a hot loop prints what HotSpot prints', async (t) => {
  const classpath = compileFixture(t);
  const hotspot = spawnSync('java', ['-cp', classpath, CLASS_NAME], { encoding: 'utf8' });
  t.equal(hotspot.status, 0, `HotSpot runs the fixture: ${hotspot.stderr}`);
  const expected = hotspot.stdout.trim();
  t.equal(expected, '384 0 -1', 'HotSpot reports the reference counts');

  const jvm = new JVM({ classpath });
  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (_jvm, _obj, args) => { output += `${args[0]}\n`; },
    },
  });
  const hostErrors = [];
  const handle = jvm.handleException;
  jvm.handleException = function (exception, ...rest) {
    if (exception instanceof Error && !exception.type) hostErrors.push(exception.message);
    return handle.call(this, exception, ...rest);
  };
  await jvm.run(CLASS_NAME);
  t.deepEqual(hostErrors, [], 'no host error reaches the guest exception dispatcher');
  t.equal(output.trim(), expected, 'jvm.js prints what HotSpot prints');
  t.end();
});
