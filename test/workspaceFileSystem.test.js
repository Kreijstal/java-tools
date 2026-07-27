'use strict';

const path = require('path');
const test = require('tape');
const { getAST } = require('jvm_parser');
const BrowserFileProvider = require('../src/io/BrowserFileProvider');
const { createZenFSWorkspace } = require('../src/io/ZenFSWorkspace');
const { compileJavaFiles } = require('../src/java-frontend/compiler');

test('ZenFS workspace compiles related Java files without touching the host filesystem', async (t) => {
  const workspace = await createZenFSWorkspace({ name: 'java-tools-workspace-test' });
  workspace.mkdirSync('/src/example', { recursive: true });
  workspace.writeFileSync('/src/example/Helper.java', `
    package example;
    final class Helper {
      static int twice(int value) {
        return value * 2;
      }
    }
  `);
  workspace.writeFileSync('/src/example/Main.java', `
    package example;
    public class Main {
      public static int answer() {
        return Helper.twice(21);
      }
    }
  `);

  const result = compileJavaFiles([
    '/src/example/Helper.java',
    '/src/example/Main.java',
  ], {
    fileSystem: workspace,
    pathModule: path.posix,
    sourceRoot: '/src',
    outputDir: '/classes',
    sourceLevel: '8',
  });

  t.equal(result.status, 'complete', 'multi-file compilation completes');
  t.deepEqual(
    result.written.map((entry) => entry.outputPath),
    ['/classes/example/Helper.class', '/classes/example/Main.class'],
    'class files are emitted into the virtual output tree',
  );
  const mainBytes = workspace.readFileSync('/classes/example/Main.class');
  t.deepEqual(
    Array.from(mainBytes.slice(0, 4)),
    [0xca, 0xfe, 0xba, 0xbe],
    'the workspace contains a JVM class file',
  );
  t.doesNotThrow(() => getAST(new Uint8Array(mainBytes)), 'emitted bytes parse as a class file');
  const mainClass = result.classes.find((entry) => entry.internalName === 'example/Main');
  t.ok(
    mainClass.jasmin.includes('example/Helper') && mainClass.jasmin.includes('(I)I'),
    'cross-file method metadata is resolved from virtual sources',
  );

  const provider = new BrowserFileProvider();
  provider.attachWorkspace(workspace);
  t.equal(
    await provider.exists('classes/example/Main.class'),
    true,
    'the JVM provider sees compiler output in the same workspace',
  );
  t.deepEqual(
    Array.from((await provider.readFile('/classes/example/Main.class')).slice(0, 4)),
    [0xca, 0xfe, 0xba, 0xbe],
    'leading and relative paths address the same workspace file',
  );
  t.deepEqual(
    workspace.listFiles('/src'),
    ['src/example/Helper.java', 'src/example/Main.java'],
    'the editor can enumerate its virtual source tree',
  );
  t.end();
});

test('workspace metadata is refreshed after an editor changes a source file', async (t) => {
  const workspace = await createZenFSWorkspace({ name: 'java-tools-workspace-refresh-test' });
  workspace.mkdirSync('/src/example', { recursive: true });
  workspace.writeFileSync('/src/example/Helper.java', `
    package example;
    class Helper {
      static int convert(int value) { return value; }
    }
  `);
  workspace.writeFileSync('/src/example/Main.java', `
    package example;
    class Main {
      static int run() { return Helper.convert(1); }
    }
  `);

  const options = {
    fileSystem: workspace,
    pathModule: path.posix,
    sourceRoot: '/src',
    outputDir: '/classes',
  };
  compileJavaFiles(['/src/example/Helper.java', '/src/example/Main.java'], options);

  workspace.writeFileSync('/src/example/Helper.java', `
    package example;
    class Helper {
      static long convert(long value) { return value; }
    }
  `);
  workspace.writeFileSync('/src/example/Main.java', `
    package example;
    class Main {
      static long run() { return Helper.convert(1L); }
    }
  `);
  const updated = compileJavaFiles(
    ['/src/example/Helper.java', '/src/example/Main.java'],
    options,
  );
  const mainClass = updated.classes.find((entry) => entry.internalName === 'example/Main');

  t.ok(
    mainClass.jasmin.includes('(J)J'),
    'the second compile sees the edited cross-file method descriptor',
  );
  t.notOk(
    mainClass.jasmin.includes('convert (I)I'),
    'virtual source metadata is not stale',
  );
  t.end();
});
