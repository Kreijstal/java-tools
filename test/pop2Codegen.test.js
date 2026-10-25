// pop2 discards one category-2 value (a long or a double) or two category-1
// values; a javac-discarded long call result is the common source.
'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');

test('a discarded long call result (pop2) leaves the operand stack intact', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop2-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'Main.java'), [
    'public class Main {',
    '  static long calls;',
    '  static long tick(int i) { calls += 1; return calls * 1000000007L + i; }',
    // the first tick's long result is discarded: javac emits pop2
    '  static long twice(int i) { tick(i); return tick(i) - (long) i; }',
    '  static long result;',
    '  public static void main(String[] args) { long s = 0; for (int i = 0; i < 50; i++) s += twice(i); result = s; }',
    '}',
  ].join('\n'));
  frontend.compileJavaFile(path.join(dir, 'Main.java'), {outputDir: dir, sourceFileName: 'Main.java'});
  const jvm = new JVM({classpath: dir});
  await jvm.run('Main');
  let expectedResult = 0n, calls = 0n;
  for (let i = 0; i < 50; i++) { calls += 1n; calls += 1n; expectedResult += calls * 1000000007n; }
  t.equal(jvm.classes.Main.staticFields.get('result:J'), expectedResult, 'correct result');
  const twice = jvm.classes.Main.ast.classes[0].items.find((item) => item.type === 'method' && item.method.name === 'twice').method;
  const items = jvm.jit.getCodeItems(twice);
  t.ok(items.some((item) => (item?.instruction?.op || item?.instruction) === 'pop2'), 'the fixture really contains pop2');
  t.end();
});
