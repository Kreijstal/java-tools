const test = require('tape');
const { ClassDataStrings } = require('../src/core/ClassDataStrings');

test('class string sharing preserves cyclic transport data and bounds retention', t => {
  const pool = new ClassDataStrings({maxEntries: 2, maxLength: 5});
  const bytes = new Uint8Array([3, 4]);
  const root = {op: 'aload', items: ['aload', 'goto', 'extra', 'long descriptor'], bytes};
  root.self = root;
  const expected = structuredClone(root);
  t.equal(pool.share(root), root, 'updates the owned graph in place');
  t.deepEqual(root, expected, 'values, binary data, aliases and cycles are preserved');
  t.equal(root.bytes, bytes, 'binary storage is unchanged');
  t.equal(pool.values.size, 2, 'unique string retention is capped');
  t.notOk(pool.values.has('long descriptor'), 'long strings are not retained');
  pool.share({op: 'new'});
  t.equal(pool.values.size, 2, 'later classes cannot grow a full pool');
  t.equal(new ClassDataStrings({maxEntries: 0}).share(root), root, 'sharing can be disabled');
  t.throws(() => new ClassDataStrings({maxEntries: -1}), RangeError);
  t.end();
});

const path = require('path');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('class-loader-sharing-');
const loader = require('../src/core/classLoader');

test('class loading APIs preserve the same bytecode and annotation data', async t => {
  const classpath = compileFixture(t, 'SharedClassData', `
@Deprecated public class SharedClassData {
  public String text = "shared text";
  @Deprecated public int score(int n) { return n + text.length(); }
}`);
  const file = path.join(classpath, 'SharedClassData.class');
  const byPath = await loader.loadClassByPath(file);
  const byName = await loader.loadClass('SharedClassData', classpath);
  const sync = loader.loadClassByPathSync(file);
  t.deepEqual(byName, byPath.ast, 'named loading retains the same converted AST');
  t.deepEqual(sync, byPath.ast, 'synchronous loading retains the same converted AST');
  t.ok(byPath.constantPool.length, 'path API still returns the constant pool');
  t.doesNotThrow(() => structuredClone(byPath), 'the parsed graph remains worker transportable');
  t.end();
});
