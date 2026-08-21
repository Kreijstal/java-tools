'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('tape');
const { decompileClassBytes } = require('../src/decompiler/cfr');
const { compileJavaSource } = require('../src/java-frontend/compiler');

// Outer$Inner is a binary name, not a type name in source: javac reads it as one
// top-level identifier and reports "cannot find symbol" even when that exact
// class file is on the classpath. Only the InnerClasses attribute says which
// dollars are nesting separators.
const OUTER_SOURCE = `
public class Outer {
    static class Inner {
        int[] indices;
        java.awt.Color color;
    }
    Runnable r = new Runnable() { public void run() {} };
    int read(Inner inner) { return inner.indices[0]; }
    void paint(java.awt.Graphics g, Inner inner) { g.setColor(inner.color); }
}
`;

function buildFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-names-'));
  fs.writeFileSync(path.join(dir, 'Outer.java'), OUTER_SOURCE);
  const javac = spawnSync('javac', ['-nowarn', '-d', dir, path.join(dir, 'Outer.java')],
    { encoding: 'utf8' });
  if (javac.status !== 0) {
    t.skip(`javac unavailable or failed: ${javac.stderr || javac.error}`);
    return null;
  }
  return dir;
}

test('a member class is decompiled under its source name, an anonymous one is not', (t) => {
  const dir = buildFixture(t);
  if (!dir) { t.end(); return; }
  try {
    const decompiled = decompileClassBytes(
      new Uint8Array(fs.readFileSync(path.join(dir, 'Outer.class'))),
      { allowFallback: true, preserveFieldNames: true },
    );
    t.match(decompiled, /Outer\.Inner/,
      'the member class is referenced by its qualified source name');
    t.notOk(/Outer\$Inner/.test(decompiled),
      'the binary name javac rejects is gone');
    // An anonymous class has inner_name_index 0 and cannot be written as a
    // qualified name at all, so rewriting it would produce `Outer.1`.
    t.match(decompiled, /Outer\$1/,
      'an anonymous class keeps the only spelling it has');
    // The declaration itself is a binary name, not a qualified reference.
    t.match(decompiled, /class Outer\b/, 'the declared class name is unchanged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  t.end();
});

test('a classpath supplies the field types an undeclared nested type needs', (t) => {
  const dir = buildFixture(t);
  if (!dir) { t.end(); return; }
  try {
    // Only Outer.class is decompiled, so the unit references Outer.Inner without
    // declaring it. javac answers "what type is inner.color?" by reading
    // Outer$Inner.class; with no classpath the frontend has no such answer, and
    // an argument with no type makes setColor(Color) inapplicable.
    const source = `
public class Caller {
    void paint(java.awt.Graphics g, Outer.Inner inner) { g.setColor(inner.color); }
}
`;
    t.throws(() => compileJavaSource(source, { sourceLevel: '8' }),
      /minimal compiler does not support/,
      'without a classpath the argument type is unknown and the call cannot lower');

    const result = compileJavaSource(source, { sourceLevel: '8', classpath: [dir] });
    t.equal(result.bytecodeIr.status, 'complete',
      'the classpath resolves the field type and the call lowers');
    t.match(result.classes[0].jasmin, /getfield Field Outer\$Inner color Ljava\/awt\/Color;/,
      'the source name still links against the binary name');
    t.match(result.classes[0].jasmin, /invokevirtual Method java\/awt\/Graphics setColor/,
      'the declared JDK overload is the one selected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  t.end();
});
