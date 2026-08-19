'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { compileJavaSource } = require('../src/java-frontend/compiler');
const { assembleJasminBytes } = require('../src/utils/jasminAssembly');
const DebugController = require('../src/debug/debugController');

const SOURCE = `public class LineDemo {
    public static void main(String[] args) {
        int a = 1;
        int b = 2;
        int c = a + b;
        System.out.println(c);
    }
}
`;

test('compiler emits SourceFile and LineNumberTable attributes', (t) => {
  const result = compileJavaSource(SOURCE, {
    sourceLevel: '8',
    sourceFileName: 'LineDemo.java',
  });
  t.equal(result.bytecodeIr.status, 'complete', 'source lowers completely');
  const jasmin = result.classes[0].jasmin;
  t.match(jasmin, /\.sourcefile "LineDemo\.java"/, 'SourceFile attribute is emitted');
  t.match(jasmin, /\.linenumbertable/, 'LineNumberTable is emitted');
  // The implicit constructor carries a table of its own - javac gives it the
  // class declaration line - so pick the table out of main's method body rather
  // than taking whichever one comes first.
  const method = jasmin.match(/\.method public static main[\s\S]*?\.end method/);
  t.ok(method, 'main is emitted');
  const table = method[0].match(/\.linenumbertable([\s\S]*?)\.end linenumbertable/);
  t.ok(table, 'line number table is well formed');
  const lines = table[1].trim().split('\n').map((entry) => entry.trim());
  t.deepEqual(
    lines.map((entry) => entry.split(/\s+/)[1]),
    ['3', '4', '5', '6'],
    'one entry per statement line, in order',
  );
  const ctor = jasmin.match(/\.method public <init>[\s\S]*?\.end method/);
  const ctorTable = ctor[0].match(/\.linenumbertable([\s\S]*?)\.end linenumbertable/);
  t.deepEqual(
    ctorTable[1].trim().split('\n').map((entry) => entry.trim().split(/\s+/)[1]),
    ['1'],
    'the implicit constructor points at the class declaration, the way javac does',
  );
  t.end();
});

test('debugger reports source file and line while paused', async (t) => {
  const result = compileJavaSource(SOURCE, {
    sourceLevel: '8',
    sourceFileName: 'LineDemo.java',
  });
  const bytes = assembleJasminBytes(result.classes[0].jasmin);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-line-debug-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'LineDemo.class'), Buffer.from(bytes));
    const controller = new DebugController({ classpath: tempDir });
    await controller.start('LineDemo');

    let state = controller.getCurrentState();
    t.equal(state.executionState, 'paused', 'starts paused at method entry');
    t.equal(state.className, 'LineDemo', 'state names the paused class');
    t.equal(state.sourceFile, 'LineDemo.java', 'state carries the SourceFile name');
    t.equal(state.sourceLine, 3, 'entry pc maps to the first statement line');

    const seenLines = new Set([state.sourceLine]);
    for (let i = 0; i < 16 && !controller.isCompleted(); i += 1) {
      await controller.stepInstruction();
      state = controller.getCurrentState();
      if (typeof state.sourceLine === 'number') seenLines.add(state.sourceLine);
    }
    t.deepEqual([...seenLines].sort(), [3, 4, 5, 6], 'stepping walks every statement line');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});
