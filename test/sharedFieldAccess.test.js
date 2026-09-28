'use strict';
const test = require('tape');
const Renderer = require('../src/jit/JvmSsaBlockRenderer');

test('shared field access preserves dense, named and fallback storage', t => {
  const renderer = Object.create(Renderer.prototype), site = {}, key = 'Owner.value';
  const token = {}, failure = new Error('fallback failed');
  for (const value of [0, -0, NaN, null, undefined, token]) {
    for (const fields of [[value], {[key]: value}, null]) {
      const object = {fields}, calls = [];
      const helpers = {
        getFieldAtSite: (s, o) => { calls.push(['get', s, o]); return token; },
        putFieldAtSite: (s, o, v) => { calls.push(['put', s, o, v]); },
      };
      const fallback = fields === null || !Array.isArray(fields) && value === undefined;
      t.ok(Object.is(renderer.readDenseOrNamedField(helpers, site, object, 0, key),
        fallback ? token : value), 'read retains exact value or fallback');
      t.deepEqual(calls, fallback ? [['get', site, object]] : [], 'read fallback identity');
      calls.length = 0;
      renderer.writeDenseOrNamedField(helpers, site, object, 0, key, value);
      t.deepEqual(calls, fields === null ? [['put', site, object, value]] : [], 'write fallback identity');
      if (fields !== null) t.ok(Object.is(fields[Array.isArray(fields) ? 0 : key], value), 'write retains exact value');
    }
  }
  const helpers = {getFieldAtSite() {throw failure;}, putFieldAtSite() {throw failure;}};
  for (const action of [
    () => renderer.readDenseOrNamedField(helpers, site, {}, 0, key),
    () => renderer.writeDenseOrNamedField(helpers, site, {}, 0, key, token),
  ]) t.throws(action, e => e === failure, 'fallback exception identity is preserved');
  t.end();
});
