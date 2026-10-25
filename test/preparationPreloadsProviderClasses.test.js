// A class reached by reflection alone (Class.forName) must load and run from
// a jar served by an in-memory provider that has no directory to read.
'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { JVM } = require('../src/core/jvm');
const { getFileProvider, setFileProvider } = require('../src/core/classLoader');
const BrowserFileProvider = require('../src/io/BrowserFileProvider');
const frontend = require('../src/java-frontend');

test('a reflection-only class in a provider-served jar loads and runs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preload-provider-'));
  const previousProvider = getFileProvider();
  t.teardown(() => { setFileProvider(previousProvider); fs.rmSync(dir, {recursive: true, force: true}); });
  fs.writeFileSync(path.join(dir, 'Base.java'), 'public abstract class Base { abstract int get(int i); }\n');
  fs.writeFileSync(path.join(dir, 'Lazy.java'), [
    'public final class Lazy extends Base {',
    '  int f;',
    '  synchronized int get(int i) { f = i; return f + 1; }',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Main.java'), [
    'public class Main {',
    '  static int sum;',
    '  public static void main(String[] args) throws Exception {',
    '    Base b = (Base) Class.forName("Lazy").newInstance();',
    '    for (int i = 0; i < 100; i++) sum += b.get(i);',
    '  }',
    '}',
  ].join('\n'));
  for (const name of ['Base.java', 'Lazy.java', 'Main.java']) {
    frontend.compileJavaFile(path.join(dir, name), {outputDir: dir, sourceFileName: name, classpath: [dir]});
  }
  const zip = new JSZip();
  for (const name of ['Base', 'Lazy', 'Main']) zip.file(`${name}.class`, fs.readFileSync(path.join(dir, `${name}.class`)));
  const jar = await zip.generateAsync({type: 'uint8array'});
  const provider = new BrowserFileProvider();
  await provider.loadJarArchive(jar, 'fixture.jar');
  t.deepEqual((await provider.listClassNames('.')).sort(), ['Base', 'Lazy', 'Main'], 'the provider lists every class of the jar');
  setFileProvider(provider);

  const jvm = new JVM({classpath: ['.']});
  await jvm.run('Main');
  t.equal(jvm.classes.Main.staticFields.get('sum:I'), 5050, 'correct result');
  t.ok(jvm.classes.Lazy, 'Lazy was loaded');
  t.end();
});
