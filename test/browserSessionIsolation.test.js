'use strict';

const test = require('tape');
const { BrowserJVMDebug, javaTools } = require('../src/platform/browser-entry');

function populate(debug, value) {
  const compiled = javaTools.compileJava(`
    public class Entry {
      public static int result;
      public static int marker;
      public static void main(String[] args) throws java.io.IOException {
        result = Helper.value();
        marker = new java.io.FileInputStream("marker.bin").read();
      }
    }
    class Helper {
      public static int value() { return ${value}; }
    }
  `);
  debug.fileProvider.virtualFS.set("marker.bin", new Uint8Array([value]));
  for (const artifact of compiled.artifacts) {
    debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
  }
}

test('concurrent browser debuggers retain their own classes across resets', async t => {
  const first = new BrowserJVMDebug();
  populate(first, 11);
  const second = new BrowserJVMDebug();
  populate(second, 22);
  await Promise.all([first.initialize(), second.initialize()]);
  for (let run = 0; run < 2; run++) {
    await Promise.all([first.run('Entry'), second.run('Entry')]);
    t.equal(first.debugController.jvm.classes.Entry.staticFields.get('result:I'), 11,
      'first session resolves its own Helper after reset');
    t.equal(second.debugController.jvm.classes.Entry.staticFields.get('result:I'), 22,
      'second session resolves its own Helper after reset');
    t.equal(first.debugController.jvm.classes.Entry.staticFields.get('marker:I'), 11,
      'first session reads its own resources');
    t.equal(second.debugController.jvm.classes.Entry.staticFields.get('marker:I'), 22,
      'second session reads its own resources');
    t.equal(first.debugController.jvm.fileProvider, first.fileProvider,
      'reset retains the session provider');
  }
  const seen = [];
  first.fileProvider.listClassNames = async () => { seen.push('first'); return []; };
  second.fileProvider.listClassNames = async () => { seen.push('second'); return []; };
  await first.debugController.jvm.preloadClasspathClasses();
  t.deepEqual(seen, ['first'], 'classpath enumeration also uses the instance provider');
  t.end();
});
