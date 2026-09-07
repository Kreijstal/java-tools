#!/usr/bin/env node
"use strict";

// Phase 1 four-arm benchmark (docs/phase1-worker-audit.md, task 7):
//   worker off, worker on, worker off, worker on
// against the same checkout, with ahead-of-main preparation on, exactly as
// the measurement contract in docs/plan-linear-runtime.md requires.
//
// The Deko Bloko launcher this phase's numbers were designed around is NOT in
// this checkout, so this script substitutes a SYNTHETIC LATE-LOADING
// benchmark:
//   - Phase1BenchmarkMain: a hot loop the guest runs after main();
//   - BenchLate: a class that is deliberately loaded AFTER preparation, which
//     exercises the late class loading and its post-main compilation behavior.
//
// This is a mechanism test for late loading, not game acceptance evidence: it
// does not establish Deko Bloko loading latency, FPS, or frame pacing. The
// original plan records a real boot regression that passed the worker suite
// and a larger default-mode gate, so synthetic numbers must not be read as
// game numbers.
//
// Game-specific metrics (postLogoToMenuMs, mean FPS, frame percentiles) have
// no producer here and are reported as null, never as a fabricated number.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const { JVM } = require("../src/core/jvm");
const frontend = require("../src/java-frontend");

const ROOT = path.resolve(__dirname, "..");
const PREPARE = (process.env.ALTERORB_JVMJS_PREPARE_BEFORE_START || "1") === "1";
const ROUNDS = Number(process.env.JVM_PHASE1_BENCH_ROUNDS || 2000);
const OUT = process.env.JVM_PHASE1_BENCH_OUT ||
  path.join(ROOT, "bench", "phase1-worker.json");

const MAIN_SOURCE = `public class Phase1BenchmarkMain {
  static int spin(int n) { int acc = 0; for (int i = 0; i < n; i++) { acc = (acc * 31 + i) & 0xffff; } return acc; }
  static int run(int rounds) { int acc = 0; for (int r = 0; r < rounds; r++) { int s = spin(64); int c = BenchLate.compute(acc); acc = acc + s + c; } return acc; }
  public static void main(String[] args) { System.out.println(run(${ROUNDS})); }
}
`;

const LATE_SOURCE = `public class BenchLate {
  static int compute(int x) { int acc = x; for (int i = 0; i < 64; i++) { acc = (acc * 17 + i) & 0xffff; } return acc; }
}
`;

function compile(source, fileName, dir) {
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, source);
  frontend.compileJavaFile(file, { outputDir: dir, sourceFileName: fileName });
  return dir;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1,
    Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function runArm(workerOn) {
  // A single arm: prepare everything on the main classpath, load the late
  // class afterwards, then run main(). BenchLate's methods therefore compile
  // after main(): synchronously with the worker off, on the worker with it on.
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase1-main-"));
  const lateDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase1-late-"));
  compile(MAIN_SOURCE, "Phase1BenchmarkMain.java", mainDir);
  compile(LATE_SOURCE, "BenchLate.java", lateDir);

  const jvm = new JVM({
    classpath: [mainDir],
    prepareBeforeMain: PREPARE,
    jit: { profileMethods: true, compileWorker: workerOn, warmupThreshold: 0 },
  });
  try {
    let output = "";
    jvm.registerJreMethods({ "java/io/PrintStream": {
      "println(I)V": (_j, _o, args) => { output += `${args[0]}\n`; },
    } });

    const started = performance.now();
    if (PREPARE) {
      await jvm.precompileInitializedClasses({
        preloadClasspath: true, initializedOnly: false,
        effectful: true, wasm: true,
      });
    }
    jvm.classpath.push(lateDir);
    await jvm.loadClassByName("BenchLate");
    const mainStarted = performance.now();
    await jvm.run("Phase1BenchmarkMain", { prepare: false });
    await jvm.jit.compileWorker.whenIdle();
    const ended = performance.now();

    const worker = jvm.jit.compileWorker.stats;
    const install = jvm.jit.installCensus();
    const sync = jvm.jit.syncCompileCensus();
    const totalMs = ended - started;
    const steadyMs = ended - mainStarted;

    return {
      arm: workerOn ? "worker-on" : "worker-off",
      rounds: ROUNDS,
      prepareBeforeMain: PREPARE,
      output: output.trim(),
      // Game launcher metrics: no producer in this checkout.
      postLogoToMenuMs: null,
      meanFps: null,
      frameP50Ms: null,
      frameP90Ms: null,
      frameP95Ms: null,
      frameP99Ms: null,
      worstFrameMs: null,
      // What this checkout can measure, and the point of the phase:
      wallMs: Number(totalMs.toFixed(3)),
      steadyStateMs: Number(steadyMs.toFixed(3)),
      hotLoopIterationsPerSec: Number((ROUNDS / (steadyMs / 1000)).toFixed(1)),
      preMainSyncCompileCount: sync.preMainSyncCompileCount,
      preMainSyncCompileMs: Number(sync.preMainSyncCompileMs.toFixed(3)),
      postMainSyncCompileCount: sync.postMainSyncCompileCount,
      postMainSyncCompileMs: Number(sync.postMainSyncCompileMs.toFixed(3)),
      postMainSyncCompileByTier: sync.postMainSyncCompileByTier,
      totalInstallMs: Number(install.totalInstallMs.toFixed(3)),
      largestInstallMs: Number(install.largestInstallMs.toFixed(3)),
      installCount: install.installCount,
      installAttemptCount: install.attemptCount,
      preMainInstallAttemptMs: Number(install.preMainAttemptMs.toFixed(3)),
      postMainInstallAttemptMs: Number(install.postMainAttemptMs.toFixed(3)),
      validationMs: Number(install.validationMs.toFixed(3)),
      descriptorBindingMs: Number(install.descriptorBindingMs.toFixed(3)),
      newFunctionMs: Number(install.newFunctionMs.toFixed(3)),
      wasmInstantiationMs: Number(install.wasmInstantiationMs.toFixed(3)),
      publicationMs: Number(install.publicationMs.toFixed(3)),
      workerRequests: worker.requested,
      workerQueued: worker.queued,
      workerCompleted: worker.completed,
      workerInstalled: worker.installed,
      workerRefused: worker.refused,
      workerStale: worker.stale,
      workerSuperseded: worker.superseded,
      workerFailed: worker.failed,
      workerRefusedReasons: worker.refusedReasons,
      workerStaleReasons: worker.staleReasons,
    };
  } finally {
    await jvm.jit.compileWorker.dispose();
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(lateDir, { recursive: true, force: true });
  }
}

async function main() {
  const arms = [];
  for (const workerOn of [false, true, false, true]) {
    const result = await runArm(workerOn);
    arms.push(result);
  }

  const report = {
    kind: "phase1-worker-synthetic-late-loading-benchmark",
    prepareBeforeMain: PREPARE,
    rounds: ROUNDS,
    note: "Synthetic late-loading mechanism benchmark. Deko Bloko launcher " +
      "metrics (postLogoToMenuMs, meanFps, frame percentiles) are null: the " +
      "launcher is not in this checkout, and this workload is not game " +
      "acceptance evidence. hotLoopIterationsPerSec is the substitute " +
      "throughput signal and includes the worker's one-time boot in the " +
      "worker-on arms.",
    arms,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

  // Readable console summary.
  console.log(`Phase 1 worker benchmark (prepareBeforeMain=${PREPARE}, ` +
    `rounds=${ROUNDS})`);
  console.log(`${"arm".padEnd(11)} ${"postMainSyncMs".padStart(15)} ` +
    `${"postMainCount".padStart(14)} ${"totalInstallMs".padStart(15)} ` +
    `${"largestInstall".padStart(15)} ${"req".padStart(5)} ` +
    `${"installed".padStart(9)} ${"refused".padStart(7)} ` +
    `${"stale".padStart(5)} ${"hotLoop/s".padStart(12)}`);
  for (const arm of arms) {
    console.log(`${arm.arm.padEnd(11)} ` +
      `${String(arm.postMainSyncCompileMs).padStart(15)} ` +
      `${String(arm.postMainSyncCompileCount).padStart(14)} ` +
      `${String(arm.totalInstallMs).padStart(15)} ` +
      `${String(arm.largestInstallMs).padStart(15)} ` +
      `${String(arm.workerRequests).padStart(5)} ` +
      `${String(arm.workerInstalled).padStart(9)} ` +
      `${String(arm.workerRefused).padStart(7)} ` +
      `${String(arm.workerStale).padStart(5)} ` +
      `${String(arm.hotLoopIterationsPerSec).padStart(12)}`);
  }
  console.log(`\nMachine-readable result: ${OUT}`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
