#!/usr/bin/env node
const {performance} = require('perf_hooks');
const {JVM} = require('../src/core/jvm');
const Stack = require('../src/core/stack');

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function fixedPointMethod() {
  const instructions = [
    'iload_0', 'i2l', 'iload_1', 'i2l', 'lmul',
    {op: 'bipush', arg: 16}, 'lshr', 'l2i', 'ireturn',
  ];
  return {
    name: 'genericFixedPointProduct',
    descriptor: '(II)I',
    flags: ['static'],
    className: 'GenericArithmeticBenchmark',
    attributes: [{type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: `L${index}:`, instruction,
      })),
      localsSize: '2', stackSize: '4', exceptionTable: [],
    }}],
  };
}

function compile(scalarization) {
  const jvm = new JVM({jit: {
    warmupThreshold: 0,
    profileMethods: false,
    structuredSsa: true,
    structuredFixedPointScalarization: scalarization,
  }});
  const method = fixedPointMethod();
  jvm.classInitializationState.set(method.className, 'INITIALIZED');
  const generated = jvm.jit.getGeneratedFunction(method);
  const body = generated.jvmRestoringDirectPositionalBody;
  if (typeof body !== 'function') {
    throw new Error('fixture did not produce a direct positional SSA body');
  }
  const plan = jvm.jit.hotCallGraphRegions.restorationPlan({
    method, owner: method.className, generated,
  });
  const thread = {
    id: 0, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };
  return {
    generated,
    invoke(left, right) {
      return body(jvm.jit, plan, left, right, thread, false);
    },
  };
}

function measure(candidate, pairs, iterations, samples) {
  const times = [];
  let checksum = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    let value = 0;
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      const pair = pairs[index & (pairs.length - 1)];
      value = (value + candidate.invoke(pair[0], pair[1])) | 0;
    }
    times.push(performance.now() - started);
    checksum ^= value;
  }
  return {milliseconds: median(times), checksum};
}

function main() {
  const optimized = compile(true);
  const baseline = compile(false);
  const pairs = [];
  let state = 0x6d2b79f5;
  for (let index = 0; index < 4096; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    const left = state;
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    pairs.push([left, state]);
  }
  for (const [left, right] of pairs) {
    if (optimized.invoke(left, right) !== baseline.invoke(left, right)) {
      throw new Error(`differential mismatch for ${left}, ${right}`);
    }
  }
  const iterations = Number(process.env.JVM_FIXED_POINT_ITERATIONS) || 500000;
  const samples = Number(process.env.JVM_FIXED_POINT_SAMPLES) || 5;
  // Warm both generated functions before collecting medians.
  measure(optimized, pairs, 20000, 1);
  measure(baseline, pairs, 20000, 1);
  const baselineResult = measure(baseline, pairs, iterations, samples);
  const optimizedResult = measure(optimized, pairs, iterations, samples);
  if (baselineResult.checksum !== optimizedResult.checksum) {
    throw new Error('measured checksums differ');
  }
  const speedup = baselineResult.milliseconds / optimizedResult.milliseconds;
  console.log(JSON.stringify({
    iterations,
    samples,
    baselineMs: Number(baselineResult.milliseconds.toFixed(3)),
    optimizedMs: Number(optimizedResult.milliseconds.toFixed(3)),
    speedup: Number(speedup.toFixed(3)),
    checksum: optimizedResult.checksum,
    scalarizedGraphs:
      optimized.generated.jvmStructuredFixedPointScalarizationCount,
    optimizedBigIntTokens:
      (optimized.generated.jvmStructuredSource.match(/BigInt/g) || []).length,
    baselineBigIntTokens:
      (baseline.generated.jvmStructuredSource.match(/BigInt/g) || []).length,
  }, null, 2));
  if (speedup < 1.5) {
    throw new Error(`fixed-point scalarization speedup ${speedup.toFixed(3)}x ` +
      'is below the 1.5x regression floor');
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
