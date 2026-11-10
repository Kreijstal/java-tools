'use strict';
const test = require('tape');
const { BrowserJVMDebug, javaTools } = require('../src/platform/browser-entry');

// A default-package class whose simple name matches a JRE class must not
// capture a fully qualified `new java.awt.Font(...)`. The readable Zombie Dawn
// source names a game class `Font`, and javac.js emitted `new Font` plus a
// nonexistent `Font.<init>(String,int,int)` for the AWT font of its loading bar.
test('a qualified new expression names the qualified class, not a same-named corpus class', async t => {
  const source = `public class QualifiedNew {
      public static int size, nested, viaMethod;
      public static boolean awtFont;
      static java.awt.Font font;
      public static void main(String[] args) {
        font = new java.awt.Font("Helvetica", 1, 13);
        size = font.getSize();
        awtFont = font.getClass().getName().equals("java.awt.Font");
        Outer.B.C c = new Outer.B.C();
        nested = c.v;
        viaMethod = new Maker().make().v;
      }
    }
    abstract class Font { int unrelated; }
    class Outer { static class B { static class C { int v = 7; } } }
    class Maker { Outer.B.C make() { return new Outer.B.C(); } }`;
  const artifacts = javaTools.compileJava(source).artifacts;
  const main = artifacts.find((artifact) => artifact.internalName === 'QualifiedNew');
  const pool = Buffer.from(main.bytes).toString('latin1');
  t.ok(pool.includes('java/awt/Font'), 'the constant pool names java/awt/Font');
  const debug = new BrowserJVMDebug();
  for (const artifact of artifacts) {
    debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
  }
  await debug.initialize();
  await debug.run('QualifiedNew');
  const fields = debug.debugController.jvm.classes.QualifiedNew.staticFields;
  t.equal(fields.get('size:I'), 13, 'the AWT constructor ran');
  t.equal(fields.get('awtFont:Z'), 1, 'the allocated object is a java.awt.Font');
  t.equal(fields.get('nested:I'), 7, 'a partially qualified nested class still resolves');
  t.equal(fields.get('viaMethod:I'), 7, 'a nested return type still resolves');
  t.end();
});
