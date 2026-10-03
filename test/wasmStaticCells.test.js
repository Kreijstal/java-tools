'use strict';
const test = require('tape');
const {StaticFieldStore} = require('../src/core/StaticFieldStore');
const {bindStaticFieldAccessors} = require('../src/jit/staticFieldAccessors');
const {T} = require('../src/jit/wasmShared');

test('claimed static fields do not retain a second backing-map value', t => {
  const oldValue = new Int32Array(1024);
  const fields = new StaticFieldStore([['buffer:[I', oldValue]]);
  const access = bindStaticFieldAccessors(fields, 'buffer:[I', T.ref);
  t.equal(access.get(), oldValue, 'claiming preserves the original live value');
  t.equal(Map.prototype.get.call(fields, 'buffer:[I'), undefined,
    'claiming releases the duplicate backing-map reference');
  const nextValue = new Int32Array(8);
  access.set(nextValue);
  t.equal(fields.get('buffer:[I'), nextValue, 'resolved write replaces the live value');
  t.deepEqual([...fields.values()], [nextValue], 'values exposes the current cell');
  t.equal(new Map(fields).get('buffer:[I'), nextValue, 'Map copying reads the current cell');
  for (const reset of [() => fields.delete('buffer:[I'), () => fields.clear()]) {
    reset();
    fields.set('buffer:[I', oldValue);
    t.equal(access.get(), oldValue, 'restored key updates the existing cell');
    t.equal(Map.prototype.get.call(fields, 'buffer:[I'), undefined,
      'restoring membership does not create another retained value');
    access.set(nextValue);
    t.equal(fields.size, 1, 'resolved replacement preserves membership');
  }
  t.end();
});

test('Wasm static cells share writes and preserve storage membership', t => {
  const fields = new StaticFieldStore([['value:I', 1]]);
  const access = bindStaticFieldAccessors(fields, 'value:I', T.i32);
  const get = fields.get, set = fields.set;
  let lookups = 0;
  fields.get = function(...args) {lookups++; return get.apply(this, args);};
  fields.set = function(...args) {lookups++; return set.apply(this, args);};
  for (let i = 0; i < 1000; i++) {access.set(i); access.get();}
  t.equal(lookups, 0, 'warm reads and writes bypass keyed storage lookups');
  t.equal(fields.get('value:I'), 999, 'interpreter reads see Wasm writes');
  fields.set('value:I', 17);
  t.equal(access.get(), 17, 'Wasm reads see interpreter writes');
  fields.cell('value:I').value = 23;
  t.equal(access.get(), 23, 'Wasm reads see generated JS writes');
  t.deepEqual([...fields], [['value:I', 23]], 'iteration reads the live cell');
  fields.delete('value:I');
  t.equal(access.get(), undefined, 'deletion clears captured cells');
  access.set(31);
  t.ok(fields.has('value:I'), 'write after deletion restores key membership');
  t.equal(fields.get('value:I'), 31, 'restored value is shared');
  fields.clear();
  access.set(47);
  t.deepEqual([...fields], [['value:I', 47]], 'write after clear restores iteration');
  const cold = bindStaticFieldAccessors(fields, 'cold:Z', T.i32);
  t.notOk(fields.has('cold:Z'), 'binding does not create an uninitialized key');
  cold.set(true);
  t.equal(cold.get(), 1, 'boolean normalization remains at the import');
  t.ok(fields.has('cold:Z'), 'first cold write creates the key');
  const ordinary = new Map([['number:J', 9]]);
  const fallback = bindStaticFieldAccessors(ordinary, 'number:J', T.i64);
  t.equal(fallback.get(), 9n, 'ordinary Map retains long conversion');
  fallback.set(11n);
  t.equal(ordinary.get('number:J'), 11n, 'ordinary Map writes remain supported');
  const reference = {};
  const refs = bindStaticFieldAccessors(fields, 'ref:Ljava/lang/Object;', T.ref);
  refs.set(reference);
  t.equal(refs.get(), reference, 'reference identity is preserved');
  t.end();
});
