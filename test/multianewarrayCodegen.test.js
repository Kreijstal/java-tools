// new T[a][b] and partially dimensioned arrays allocate every dimension the
// bytecode names, with zeroed leaves and null for unallocated inner dimensions.
'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');

test('multi-dimensional array allocation sizes, zeroes, and leaves inner dimensions null', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multianewarray-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'Main.java'), [
    'public class Main {',
    '  static int sum;',
    '  static int[][] grid(int a, int b) { int[][] g = new int[a][b]; g[a - 1][b - 1] = a * b; return g; }',
    '  static long[][][] cube(int n) { return new long[n][n][]; }',
    '  public static void main(String[] args) {',
    '    for (int i = 1; i < 40; i++) { int[][] g = grid(i, 3); sum += g[i - 1][2] + g.length; }',
    '    long[][][] c = cube(5); sum += c.length + (c[4][4] == null ? 1000 : 0);',
    '  }',
    '}',
  ].join('\n'));
  frontend.compileJavaFile(path.join(dir, 'Main.java'), {outputDir: dir, sourceFileName: 'Main.java'});
  const jvm = new JVM({classpath: dir});
  await jvm.run('Main');
  let expected = 0;
  for (let i = 1; i < 40; i++) expected += i * 3 + i;
  expected += 5 + 1000;
  t.equal(jvm.classes.Main.staticFields.get('sum:I'), expected, 'correct result');
  t.end();
});
