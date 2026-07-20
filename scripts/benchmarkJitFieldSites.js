'use strict';

const { JVM } = require('../src/core/jvm');

const iterations = positiveInteger('FIELD_BENCHMARK_ITERATIONS', 5_000_000);

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function measure(name, operation) {
  let checksum = 0;
  for (let index = 0; index < 10_000; index += 1) checksum += Number(operation());
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) checksum += Number(operation());
  const elapsedNs = Number(process.hrtime.bigint() - started);
  return {
    name,
    iterations,
    elapsedMs: elapsedNs / 1e6,
    accessesPerSecond: iterations * 1e9 / elapsedNs,
    checksum,
  };
}

const jvm = new JVM({ jit: { warmupThreshold: 0 } });
jvm.classes.FieldBase = {
  staticFields: new Map([['shared:I', 7]]),
  ast: { classes: [{ superClassName: null }] },
};
jvm.classes.FieldChild = {
  staticFields: new Map(),
  ast: { classes: [{ superClassName: 'FieldBase' }] },
};
jvm.classInitializationState.set('FieldBase', 'INITIALIZED');
jvm.classInitializationState.set('FieldChild', 'INITIALIZED');

const object = {
  type: 'FieldChild',
  fields: { 'FieldBase.value': 11 },
};
const instanceArg = [null, 'FieldBase', ['value', 'I']];
const staticArg = [null, 'FieldChild', ['shared', 'I']];
const instanceSite = jvm.jit.registerFieldSite(instanceArg);
const staticSite = jvm.jit.registerFieldSite(staticArg);

const results = [
  measure('generic inherited getfield', () => jvm.jit.getField(object, instanceArg)),
  measure('cached inherited getfield', () => jvm.jit.getFieldAt(instanceSite, object)),
  measure('generic inherited getstatic', () => jvm.jit.getStaticSync(staticArg)),
  measure('cached inherited getstatic', () => jvm.jit.getStaticSyncAt(staticSite)),
];

process.stdout.write(`${JSON.stringify({ node: process.version, results }, null, 2)}\n`);
