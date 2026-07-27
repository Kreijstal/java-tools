#!/usr/bin/env node
'use strict';

// Executes the original Dekobloko synthesizer bytecode with a minimal,
// representative object graph.  The class and method names below identify the
// benchmark input only; optimizer selection remains descriptor/opcode/CFG
// based.  The zero-filter instrument still exercises the dominant per-sample
// envelope calls and mixing loop while avoiding invented game state.

const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const jar = process.env.DEKOBLOKO_JAR ||
  '/home/kreijstal/git/dekobloko-work/dekobloko.jar';
const samples = positiveInteger('DEKOBLOKO_AUDIO_SAMPLES', 22050);
const rounds = positiveInteger('DEKOBLOKO_AUDIO_ROUNDS', 3);
const warmups = positiveInteger('DEKOBLOKO_AUDIO_WARMUPS', 1);
const tiers = [
  { name: 'javascript-long', longArithmeticWasmFirst: false },
  { name: 'wasm-native-long', longArithmeticWasmFirst: true },
];

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function intArray(length, values = []) {
  const array = new Array(length).fill(0);
  for (let index = 0; index < values.length && index < length; index += 1) {
    array[index] = values[index] | 0;
  }
  array.type = '[I';
  array.elementType = 'int';
  return array;
}

function envelope() {
  return {
    type: 'sd',
    fields: {
      'sd.b': 0,
      'sd.d': intArray(2, [0, 65535]),
      'sd.c': intArray(2, [0, 65535]),
      'sd.k': 0,
      'sd.f': 2,
      'sd.j': 0,
      'sd.e': 0,
      'sd.g': 0,
      'sd.a': 2,
      'sd.h': 0,
      'sd.i': 0,
    },
  };
}

function synthesizer() {
  const pitch = envelope();
  pitch.fields['sd.a'] = 1;
  return {
    type: 'kj',
    fields: {
      'kj.q': { type: 'hj', fields: { 'hj.g': intArray(2) } },
      'kj.r': 1000,
      'kj.b': pitch,
      'kj.y': null,
      'kj.a': null,
      'kj.s': null,
      'kj.f': null,
      'kj.j': null,
      'kj.g': intArray(5, [100, 0, 0, 0, 0]),
      'kj.v': null,
      'kj.n': envelope(),
      'kj.l': null,
      'kj.h': 0,
      'kj.i': intArray(5),
      'kj.o': 0,
      'kj.u': null,
      'kj.e': intArray(5),
      'kj.k': envelope(),
      'kj.w': null,
      'kj.x': null,
      'kj.m': null,
      'kj.d': null,
      'kj.p': null,
      'kj.t': 100,
    },
  };
}

function sentinelFrame() {
  return new Frame({
    name: 'benchmarkCaller',
    descriptor: '()V',
    attributes: [{
      type: 'code',
      code: {
        codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
        localsSize: '0',
        stackSize: '1',
        exceptionTable: [],
      },
    }],
  });
}

async function createRuntime(tier) {
  process.env.JVM_WASM_JIT = '1';
  process.env.JVM_WASM_STRUCTURED = '1';
  const jvm = new JVM({
    classpath: [jar],
    jit: {
      warmupThreshold: 0,
      preferWholeMethodJs: true,
      profileMethods: false,
      scalarLoops: false,
      structuredSsa: true,
      postIncrementHelpers: true,
      longArithmeticWasmFirst: tier.longArithmeticWasmFirst,
      fusedRegions: false,
    },
  });
  for (const className of ['an', 'hj', 'kj', 'sd']) {
    const classData = await jvm.loadClassByName(className);
    if (!classData.staticFields) classData.staticFields = new Map();
    jvm.classInitializationState.set(className, 'INITIALIZED');
  }
  const statics = jvm.classes.kj.staticFields;
  statics.set('c:[I', intArray(Math.max(220500, samples)));
  statics.set('u:[I', intArray(32768));
  statics.set('j:[I', intArray(32768));
  for (const field of ['w', 'x', 'd', 'm', 'p']) {
    statics.set(`${field}:[I`, intArray(5));
  }
  const method = await jvm.findMethodInHierarchy('kj', 'a', '(II)[I');
  const envelopeMethod = await jvm.findMethodInHierarchy('sd', 'a', '(I)I');
  const thread = {
    id: 1,
    name: `audio-${tier.name}`,
    status: 'runnable',
    pendingException: null,
    callStack: new Stack(),
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, method, envelopeMethod, thread, receiver: synthesizer() };
}

async function invoke(runtime) {
  const caller = sentinelFrame();
  const frame = new Frame(runtime.method);
  frame.className = 'kj';
  frame.locals[0] = runtime.receiver;
  frame.locals[1] = samples;
  frame.locals[2] = 1000;
  runtime.thread.status = 'runnable';
  runtime.thread.callStack.push(caller);
  runtime.thread.callStack.push(frame);
  let ticks = 0;
  while (runtime.thread.callStack.size() > 1) {
    await runtime.jvm.executeTick();
    if (++ticks > 2000000) throw new Error('audio synthesis exceeded scheduler tick limit');
  }
  const output = caller.stack.pop();
  runtime.thread.callStack.pop();
  let checksum = 0;
  for (let index = 0; index < samples; index += 97) {
    checksum = Math.imul(checksum ^ output[index], 16777619) | 0;
  }
  return { checksum, ticks };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  const results = [];
  for (const tier of tiers) {
    const runtime = await createRuntime(tier);
    for (let index = 0; index < warmups; index += 1) await invoke(runtime);
    const elapsed = [];
    const ticks = [];
    let checksum = 0;
    for (let index = 0; index < rounds; index += 1) {
      const started = process.hrtime.bigint();
      const result = await invoke(runtime);
      elapsed.push(Number(process.hrtime.bigint() - started) / 1e6);
      ticks.push(result.ticks);
      checksum = result.checksum;
    }
    const synthBody = runtime.jvm.jit.codegenCache.get(runtime.method);
    const envelopeBody = runtime.jvm.jit.codegenCache.get(runtime.envelopeMethod);
    results.push({
      tier: tier.name,
      medianMs: median(elapsed),
      samplesPerSecond: samples * 1000 / median(elapsed),
      checksum,
      schedulerTicks: ticks,
      synthTier: synthBody?.jvmStructuredSsa ? 'structured'
        : synthBody?.jvmSynchronous ? 'generated' : 'interpreted',
      envelopeTier: envelopeBody?.jvmSynchronous ? 'generated' : 'interpreted',
      wasmRuns: runtime.jvm.jit.wasmJit.runCount,
      longArithmeticWasmFirstMethods:
        runtime.jvm.jit.longArithmeticWasmFirstMethodCount,
    });
  }
  const expected = results[0].checksum;
  if (results.some((result) => result.checksum !== expected)) {
    throw new Error(`audio differential failed: ${results.map((result) =>
      `${result.tier}=${result.checksum}`).join(', ')}`);
  }
  process.stdout.write(`${JSON.stringify({ jar, samples, rounds, warmups, results }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
