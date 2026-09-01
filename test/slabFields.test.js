'use strict';

// Representation tests for slab-backed primitive instance fields
// (JVM_WASM_FIELDS / options.wasmFields, see src/core/objectModel.js). The
// field map stops being a plain object for eligible classes, so the invariants
// every other subsystem relies on — reads, writes, key resolution, enumeration
// — are pinned here.

const test = require('tape');
const { WasmHeap } = require('../src/core/wasmHeap');
const {
  newFields, slabLayoutFor, hasField, enumerateFieldKeys, instanceFieldTemplate,
  denseLayoutFor, denseSlotFor, readField, writeField,
} = require('../src/core/objectModel');

function fieldItem(name, descriptor, flags = []) {
  return { type: 'field', field: { name, descriptor, flags, accessFlags: flags.includes('static') ? 0x0008 : 0x0001 } };
}

// Minimal stand-in for the parts of JVM that objectModel touches.
function fakeJvm({ wasmFields = true } = {}) {
  return {
    nextHashCode: 1,
    classEpoch: 1,
    wasmHeap: new WasmHeap(1),
    wasmFields,
    jre: { 'java/lang/Object': {} },
    classes: {
      Base: {
        ast: { classes: [{ superClassName: 'java/lang/Object', items: [
          fieldItem('flag', 'Z'), fieldItem('count', 'I'),
        ] }] },
      },
      Sub: {
        ast: { classes: [{ superClassName: 'Base', items: [
          fieldItem('pos', 'I'), fieldItem('total', 'J'),
          fieldItem('scale', 'D'), fieldItem('name', 'Ljava/lang/String;'),
          fieldItem('shared', 'I', ['static']),
        ] }] },
      },
      Orphan: {
        ast: { classes: [{ superClassName: 'NotLoadedYet', items: [
          fieldItem('x', 'I'),
        ] }] },
      },
    },
  };
}

test('dense guest fields use stable superclass-first numeric slots', (t) => {
  const jvm = fakeJvm({ wasmFields: false });
  jvm.denseInstanceFields = true;
  const base = denseLayoutFor(jvm, 'Base');
  const sub = denseLayoutFor(jvm, 'Sub');
  t.ok(base && sub, 'both guest classes have a dense layout');
  t.equal(denseSlotFor(jvm, 'Base', 'count', 'I'), 1,
    'declaring class resolves its numeric slot');
  t.equal(sub.slots.get('Base.count'), base.slots.get('Base.count'),
    'inherited field keeps the same slot in a subclass');
  t.deepEqual(sub.keys, [
    'Base.flag', 'Base.count', 'Sub.pos', 'Sub.total', 'Sub.scale', 'Sub.name',
  ], 'layout is superclass-first and excludes static fields');
  t.end();
});

test('dense guest fields preserve keyed read, write, presence, and enumeration', (t) => {
  const jvm = fakeJvm({ wasmFields: false });
  jvm.denseInstanceFields = true;
  const first = newFields(jvm, 'Sub');
  const second = newFields(jvm, 'Sub');
  t.ok(Array.isArray(first), 'storage is an ordinary dense array');
  t.equal(readField(first, 'Base.count'), 0, 'primitive default is readable');
  t.equal(readField(first, 'Sub.name'), null, 'reference default is readable');
  writeField(first, 'Base.count', 42);
  writeField(first, 'Sub.name', 'dense');
  t.equal(readField(first, 'Base.count'), 42, 'inherited primitive round-trips');
  t.equal(readField(first, 'Sub.name'), 'dense', 'reference round-trips');
  t.equal(readField(second, 'Base.count'), 0, 'instances do not share slots');
  t.ok(hasField(first, 'Sub.pos'), 'declared key is present');
  t.notOk(hasField(first, 'Sub.shared'), 'static key is absent');
  t.deepEqual(enumerateFieldKeys(first), denseLayoutFor(jvm, 'Sub').keys,
    'enumeration exposes Java keys, not numeric storage indexes');
  t.end();
});

test('slab layout covers primitive instance fields across the guest chain', (t) => {
  const jvm = fakeJvm();
  const layout = slabLayoutFor(jvm, 'Sub');
  t.ok(layout, 'Sub is slab-eligible');
  const keys = layout.slots.map((slot) => slot.key).sort();
  t.deepEqual(keys, ['Base.count', 'Base.flag', 'Sub.pos', 'Sub.scale', 'Sub.total'],
    'inherited primitives included, static excluded, reference excluded');
  t.deepEqual(layout.refKeys, ['Sub.name'], 'reference fields stay plain');
  const offsets = new Map(layout.slots.map((slot) => [slot.key, slot]));
  t.equal(offsets.get('Sub.total').offset % 8, 0, 'long slot is 8-aligned');
  t.equal(offsets.get('Sub.scale').offset % 8, 0, 'double slot is 8-aligned');
  t.equal(offsets.get('Sub.pos').offset % 4, 0, 'int slot is 4-aligned');
  t.equal(layout.size % 8, 0, 'object size is 8-aligned');
  t.end();
});

test('slab fields default, read back, and stay per-instance', (t) => {
  const jvm = fakeJvm();
  const a = newFields(jvm, 'Sub');
  const b = newFields(jvm, 'Sub');
  t.equal(a['Sub.pos'], 0, 'int defaults to 0');
  t.equal(a['Base.flag'], 0, 'boolean defaults to 0');
  t.equal(a['Sub.total'], BigInt(0), 'long defaults to 0n');
  t.equal(a['Sub.scale'], 0, 'double defaults to 0');
  t.equal(a['Sub.name'], null, 'reference defaults to null');

  a['Sub.pos'] = 42;
  a['Sub.total'] = BigInt('9007199254740993');
  a['Sub.scale'] = 0.5;
  a['Base.count'] = -7;
  a['Sub.name'] = 'hello';
  t.equal(a['Sub.pos'], 42, 'int round-trips');
  t.equal(a['Sub.total'], BigInt('9007199254740993'),
    'long round-trips beyond double precision');
  t.equal(a['Sub.scale'], 0.5, 'double round-trips');
  t.equal(a['Base.count'], -7, 'negative int round-trips');
  t.equal(a['Sub.name'], 'hello', 'reference round-trips');

  t.equal(b['Sub.pos'], 0, 'sibling instance is unaffected');
  t.equal(b['Base.count'], 0, 'sibling inherited field is unaffected');
  t.end();
});

test('slab fields answer hasField and enumerateFieldKeys like a plain map', (t) => {
  const jvm = fakeJvm();
  const slab = newFields(jvm, 'Sub');
  const plain = instanceFieldTemplate(jvm, 'Sub');
  t.ok(hasField(slab, 'Sub.pos'), 'primitive field is present');
  t.ok(hasField(slab, 'Sub.name'), 'reference field is present');
  t.ok(hasField(slab, 'Base.flag'), 'inherited field is present');
  t.notOk(hasField(slab, 'Sub.missing'), 'unknown key is absent');
  t.notOk(hasField(slab, 'toString'), 'Object.prototype members are not fields');
  t.notOk(hasField(slab, '_wasmBase'), 'the base pointer is not a field');
  t.notOk(hasField(plain, 'toString'),
    'plain maps answer the same way for prototype members');

  const slabKeys = enumerateFieldKeys(slab).sort();
  t.deepEqual(slabKeys,
    ['Base.count', 'Base.flag', 'Sub.name', 'Sub.pos', 'Sub.scale', 'Sub.total'],
    'enumeration lists slab and reference fields');
  t.notOk(enumerateFieldKeys(slab).includes('_wasmBase'),
    'enumeration hides the base pointer');
  t.deepEqual(enumerateFieldKeys(plain).sort(),
    Object.keys(plain).sort(), 'plain maps enumerate unchanged');
  t.end();
});

test('slab eligibility is refused where the representation cannot hold', (t) => {
  const off = fakeJvm({ wasmFields: false });
  t.equal(slabLayoutFor(off, 'Sub'), null, 'disabled flag refuses');
  t.deepEqual(newFields(off, 'Sub'), instanceFieldTemplate(off, 'Sub'),
    'disabled flag yields the plain defaulted map');

  const jvm = fakeJvm();
  t.equal(slabLayoutFor(jvm, 'Orphan'), null,
    'unresolved superclass refuses (hierarchy still loading)');
  jvm.classes.NotLoadedYet = {
    ast: { classes: [{ superClassName: 'java/lang/Object', items: [fieldItem('y', 'I')] }] },
  };
  jvm.classEpoch += 1;
  const layout = slabLayoutFor(jvm, 'Orphan');
  t.ok(layout, 'the class becomes eligible once its superclass loads');
  t.deepEqual(layout.slots.map((slot) => slot.key).sort(),
    ['NotLoadedYet.y', 'Orphan.x'], 'the late superclass contributes its field');

  jvm.jre.Sub = {};
  jvm.classEpoch += 1;
  t.equal(slabLayoutFor(jvm, 'Sub'), null, 'classes with a JRE stub refuse');
  t.end();
});

test('slab allocation falls back to a plain map when the heap is spent', (t) => {
  const jvm = fakeJvm();
  jvm.wasmHeap.top = jvm.wasmHeap.limit - 8;
  const fields = newFields(jvm, 'Sub');
  t.deepEqual(fields, instanceFieldTemplate(jvm, 'Sub'),
    'exhaustion degrades to the plain map, never to a broken object');
  t.end();
});
