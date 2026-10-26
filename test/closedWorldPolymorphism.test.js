'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {runDetailed, jspiNode} = require('./helpers/closedWorld');

test('wide virtual and interface dispatch stays compiled across value kinds and exceptions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-polymorphism-'));
  try {
    const count = 64;
    const classes = Array.from({length: count}, (_, i) => `
      static class C${i} extends Base {
        public int integer(int x) {if(x < 0) throw new IllegalStateException(); return x + ${i};}
        public long wide(long x) {return x + ${i};}
        public double decimal(double x) {return x + ${i};}
        public Object reference(Object x) {return x;}
        public void store(int x) {value = x + ${i};}
      }`).join('\n');
    const source = `public class ClosedPolymorphism {
      interface Operation {
        int integer(int x); long wide(long x); double decimal(double x);
        Object reference(Object x); void store(int x); int inherited();
      }
      static abstract class Base implements Operation {int value; public int inherited() {return value;}}
      ${classes}
      static int virtual(Base x) {return x.integer(11);}
      public static void main(String[] args) {
        Base[] objects = new Base[]{${Array.from({length: count}, (_, i) => `new C${i}()`).join(',')}};
        long sum = 0;
        for(int i = 0; i < objects.length; i++) {
          Operation op = objects[i];
          if(virtual(objects[i]) != i + 11 || op.integer(7) != i + 7) throw new Error("integer");
          if(op.wide(1099511627776L) != 1099511627776L + i) throw new Error("long");
          if(op.decimal(0.25) != i + 0.25 || op.reference(objects) != objects) throw new Error("reference");
          op.store(19);
          if(op.inherited() != 19 + i) throw new Error("void/inherited");
          sum += op.inherited();
        }
        try {((Operation)objects[17]).integer(-1); throw new Error("exception");}
        catch(IllegalStateException expected) {}
        try {Operation absent = null; absent.integer(1); throw new Error("null");}
        catch(NullPointerException expected) {}
        System.out.println("dispatch " + sum);
      }
    }`;
    const file = path.join(directory, 'ClosedPolymorphism.java');
    fs.writeFileSync(file, source);
    execFileSync('javac', ['--release', '8', '-d', directory, file]);
    const expected = count * 19 + count * (count - 1) / 2;
    for (const suspendable of jspiNode() ? [false, true] : [false]) {
      const result = runDetailed(directory, 'ClosedPolymorphism', {
        closedWorld: true, jspiNode: suspendable, jit: {compileWorker: false},
      });
      assert.equal(result.failure, null, result.stderr);
      assert.equal(result.output.trim(), `dispatch ${expected}`);
      assert.equal(result.stats?.rejected, 0, JSON.stringify(result.stats));
      assert.ok(result.stats.admitted > count * 5);
      assert.equal(result.stats.slowCalls || 0, 0);
    }
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});
