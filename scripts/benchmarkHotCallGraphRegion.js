#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {performance} = require('perf_hooks');
const {JVM} = require('../src/core/jvm');
const Stack = require('../src/core/stack');

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(body, iterations, samples) {
  const elapsed = [];
  let checksum = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      checksum = (checksum + body()) | 0;
    }
    elapsed.push(performance.now() - started);
  }
  return {milliseconds: median(elapsed), checksum};
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-region-bench-'));
  try {
    const className = 'GenericRegionBenchmark';
    const wideCalls = Array.from({length: 128}, (_unused, index) =>
      `    sum += transform(value + ${index}, bias);`).join('\n');
    const source = `
public final class GenericRegionBenchmark {
  static int transform(int value, boolean bias) {
    return (value * 1664525 + (bias ? 1013904223 : 1013904224)) ^
      (value >>> 11);
  }
  static int mix(int value, boolean bias) {
    return transform(value, bias) + transform(value ^ 0x5a5a5a5a, bias);
  }
  static int render(int[] values, int rounds, boolean bias) {
    int sum = 0;
    for (int round = 0; round < rounds; round++) {
      for (int index = 0; index < values.length; index++) {
        sum = (sum * 31) + mix(values[index] + round, bias);
      }
    }
    return sum;
  }
  static int wide(int value, boolean bias) {
    int sum = 0;
${wideCalls}
    return sum;
  }
}
`;
    const sourcePath = path.join(directory, `${className}.java`);
    fs.writeFileSync(sourcePath, source);
    execFileSync('javac', ['-g', '-d', directory, sourcePath]);
    const jvm = new JVM({classpath: directory, jit: {
      warmupThreshold: 0,
      structuredSsa: true,
      hotCallGraphRegions: true,
      // The second fixture deliberately stress-tests a very wide root. Keep
      // it outside the production semantic-qualification bound without
      // weakening that default for real applications.
      hotCallGraphMaxRootCodeItems: 4096,
      profileMethods: false,
    }});
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
    const method = await jvm.findMethodInHierarchy(
      className, 'render', '([IIZ)I');
    const generated = jvm.jit.getGeneratedFunction(method);
    const baselineSource = generated.jvmRestoringDirectPositionalBody;
    if (typeof baselineSource !== 'function') {
      throw new Error('fixture did not produce the restoring positional ABI');
    }
    const baselinePlan = jvm.jit.hotCallGraphRegions.restorationPlan({
      method,
      owner: className,
      generated,
    });
    const region = jvm.jit.compileHotCallGraphRegion(method);
    if (!region?.body || region.nodes.length < 3) {
      throw new Error(jvm.jit.hotCallGraphRegions.lastRejectionReason ||
        'fixture did not produce a multi-method region');
    }
    if (process.env.JVM_REGION_BENCH_DUMP === '1') {
      console.error('[region-nodes]\n' + JSON.stringify(region.nodes.map(
        (node) => ({
          key: node.key,
          atomic: node.atomic,
          edges: node.edges.length,
          directBody: typeof node.generated.jvmDirectPositionalBody ===
            'function',
          internalSource: typeof node.generated
            .jvmInternalRegionPositionalSource === 'string',
        })), null, 2));
      console.error('[baseline-source]\n' +
        generated.jvmRestoringDirectPositionalSource);
      console.error('[region-source]\n' +
        region.body.jvmHotCallGraphRegionSource);
    }
    const values = Array.from({length: 64},
      (_unused, index) => Math.imul(index + 1, 2654435761) | 0);
    values.type = '[I';
    const thread = {
      id: 0, status: 'runnable', pendingException: null,
      callStack: new Stack(),
    };
    // This proxy measures the jointly lowered numeric body, not scheduler
    // turnover. A cold compiler pass can otherwise let the wall-clock slice
    // expire before measurement and make both functions return deopt records.
    jvm._nextEventLoopYieldAt = Number.POSITIVE_INFINITY;
    const baseline = () => baselineSource(
      jvm.jit, baselinePlan, values, 8, 1, thread, false);
    const fused = () => region.body(
      jvm.jit, values, 8, 1, thread, false);
    for (let index = 0; index < 1000; index += 1) {
      baseline();
      fused();
    }
    const iterations = Number(process.env.JVM_REGION_BENCH_ITERATIONS) || 3000;
    const samples = Number(process.env.JVM_REGION_BENCH_SAMPLES) || 5;
    const baselineResult = measure(baseline, iterations, samples);
    const regionResult = measure(fused, iterations, samples);
    const baselineCheck = baseline();
    const regionCheck = fused();
    if (baselineCheck !== regionCheck) {
      throw new Error(`region checksum mismatch baseline=${baselineCheck} ` +
        `region=${regionCheck}`);
    }
    const ratio = baselineResult.milliseconds / regionResult.milliseconds;
    const wideMethod = await jvm.findMethodInHierarchy(
      className, 'wide', '(IZ)I');
    jvm.jit.getGeneratedFunction(wideMethod);
    const wideCompileStarted = performance.now();
    const wideRegion = jvm.jit.compileHotCallGraphRegion(wideMethod);
    const wideCompileMs = performance.now() - wideCompileStarted;
    if (!wideRegion?.body || wideRegion.connectedEdgeCount !== 128) {
      throw new Error('wide call-graph fixture did not retain all 128 edges');
    }
    if (wideCompileMs > 5000) {
      throw new Error(`wide call-graph compilation took ${
        wideCompileMs.toFixed(1)} ms (limit 5000 ms)`);
    }
    console.log(JSON.stringify({
      nodes: region.nodes.length,
      codeItems: region.totalCodeItems,
      wideEdges: wideRegion.connectedEdgeCount,
      wideCompileMs: Number(wideCompileMs.toFixed(3)),
      iterations,
      samples,
      baselineMs: Number(baselineResult.milliseconds.toFixed(3)),
      regionMs: Number(regionResult.milliseconds.toFixed(3)),
      speedup: Number(ratio.toFixed(3)),
      checksum: regionResult.checksum,
    }, null, 2));
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
