# Phase 1 Worker Audit

This documents the Phase 1 "Junior Work Package" observability, test, and
benchmarking work on top of the compile worker landed in
`docs/plan-linear-runtime.md`. It intentionally changes no JIT semantics: no
tier transitions, worker refusal fallback, staleness rules, speculation
transport, or Wasm transport were altered. The only production behavior change
is additive instrumentation and an opt-in assertion.

Status summary:

| # | Task | Status |
| --- | --- | --- |
| 1 | Post-main synchronous compilation instrumentation | done |
| 2 | Result installation cost instrumentation | done |
| 3 | Worker result census (requests/completed/installed/refused/stale/superseded/failed + reason aggregation) | done |
| 4 | Opt-in post-main blocking assertion | done |
| 5 | Worker equivalence fixtures (10) | done |
| 6 | Generated-code table-ID audit | done (below) |
| 7 | Four-arm benchmark script | done |

---

## 1. Post-main synchronous compilation instrumentation

`JitCompiler` now splits every synchronous compile into pre-main and post-main
accounting. The boundary is `jvm.run()`'s `markMainStarted()` call, placed
after preparation and after the main frame is pushed but before guest
execution begins. Work before that point is preparation and is free by the
measurement contract; work after it is a stall.

Counters (on `jit`):

```
preMainSyncCompileCount    preMainSyncCompileMs
postMainSyncCompileCount   postMainSyncCompileMs
postMainSyncCompileByTier  // {tier: {count, inclusiveMs}} for post-main compiles
```

Accounting contract:

- `postMainSyncCompileCount` / `preMainSyncCompileCount` count every compile
  attempt (success, null result, thrown exception).
- `postMainSyncCompileMs` / `preMainSyncCompileMs` are the **outermost-only**
  elapsed stall time: nested compiles (a compile that triggers another) do not
  double-count their overlap, because a nesting-depth guard adds only the
  interval that transitioned depth 0 → 1.
- `postMainSyncCompileByTier[tier].inclusiveMs` is the per-tier inclusive time
  (it includes nested compiles), so its per-tier sums are NOT comparable to
  `postMainSyncCompileMs`. They are labeled `inclusiveMs` for exactly that
  reason.
- Every instrumented entry point finalizes timing in a `finally` block, so a
  throwing compilation is counted like a successful or null one. The original
  exception behavior is unchanged: `compileMethod` and
  `compileHotCallGraphRegion` propagate, while
  `getStructuredRegionCandidate` still swallows the compiler error into
  `codegenCompileErrors` and returns null.

`jit.syncCompileCensus()` returns all of the above plus `mainStarted` as plain
data; `jit.compileWorker.census()` returns worker + install + sync-compile
census together for the benchmark.

Compile paths instrumented (one accounting interval per compile, guarded
before the compiler runs):

| Path | entry path (`caller`) | tier label |
| --- | --- | --- |
| `JitCompiler.compileMethod` (baseline, structured SSA, scalar loop, direct intrinsic, inline loop regions) | `compileMethod` | `structured-ssa` / `scalar-loop` / `direct-intrinsic` / `generated-sync` / `generated-async` / `hot-call-graph` / `none` |
| `JitCompiler.getStructuredRegionCandidate` | `getStructuredRegionCandidate` | `structured-region-candidate` |
| `JitCompiler.compileHotCallGraphRegion` | `compileHotCallGraphRegion` | `hot-call-graph-region` |
| `WasmJit.compile` | `wasm-compile` | `wasm` |

Diagnostic mode: `JVM_JIT_TRACE_POST_MAIN_SYNC_COMPILE=1` prints method,
descriptor, tier, entry path, ms, and outermost for every synchronous compile
after `main()`.

Assertion mode: `JVM_JIT_ASSERT_NO_POST_MAIN_SYNC_COMPILE=1` checks BEFORE any
compiler work runs, so a prohibited post-main compile never enters the
compiler. The check is separate from the (non-throwing) timing finalization,
so it can neither mask an original compiler error nor fire after the work it
is meant to prevent.

---

## 2. Result installation cost instrumentation

`CompileWorkerClient.receive` and `JitCompiler.materializeGeneratedResult`
now time the main-thread work performed after a worker result arrives, broken
out into phases (a category that does not apply to a result records zero):

```
validationMs          // resultStalenessReason

descriptorBindingMs   // placeSiteTables + internLinkRecords + internRegionCallSites
newFunctionMs         // new Function in materializeTextBody
wasmInstantiationMs   // 0 for JS-tier bodies; no Wasm result is transported yet
publicationMs         // codegenCache.set + publishGeneratedTargetUpgrade
totalInstallMs        // receive() entry to publication done
```

Aggregates (on `jit.installStats`, exposed via `jit.installCensus()`):

```
installCount           // successful publishes only
largestInstallMs       // largest successful install
attemptCount           // every result that reached materialization
preMainAttemptCount    // attempts before main()
preMainAttemptMs
postMainAttemptCount   // attempts after main()
postMainAttemptMs
```

An *attempt* is recorded for every result that reaches materialization,
including a result rejected after validation or partial materialization (that
work still occupied the main thread) and a superseded result. A successful
*install* is a distinct, narrower count. The pre/post split gives the runtime
boundary the benchmark needs without it having to snapshot and subtract.

---

## 3. Worker result census

`CompileWorkerClient.stats` now reports the complete result census:

```
requests    // sent to the worker
completed   // results received (installed + refused + stale + superseded)
installed
refused
stale
superseded  // result arrived but the method already had a body
failed      // send failures + worker errors
```

Refusal and staleness reasons are aggregated into stable keys rather than
free-form strings:

```
refusedReasons   // e.g. method-not-mirrored, untransportable-table, grant-overflow,
                 //      not-serializable, worker-compiler-refused, compile-threw, worker-threw
staleReasons     // e.g. class-epoch-moved, initialization-assumption, no-provenance,
                 //      region-call-site-unresolved, site-conflict, rejected-on-arrival
```

Classification lives in `classifyRefusalReason` / `classifyStaleReason` /
`slugReason` (with the exact `site-conflict` mapping from
`materializeGeneratedResult`'s `placeSiteTables` conflict paths).

---

## 4. Post-main blocking assertion

`JVM_JIT_ASSERT_NO_POST_MAIN_SYNC_COMPILE=1` (off by default) is a debug guard
checked **before** any compiler work runs: a prohibited post-main compile
never enters the compiler. The error carries:

```
error.jitAssertNoPostMainSyncCompile = { method, descriptor, tier, caller }
```

`tier` and `caller` carry the entry-path label (`compileMethod`,
`getStructuredRegionCandidate`, `compileHotCallGraphRegion`, `wasm-compile`)
where a more specific caller is unavailable. The guard is separate from the
(non-throwing) timing finalization, so it can neither mask an original
compiler error nor fire after the work it is meant to prevent. This is a
debugging/test mode only.

---

## 5. Worker equivalence fixtures

`test/workerEquivalence.test.js` runs ten small Java fixtures twice — worker
off, then worker on — and asserts observable output/state match. It compares
behavior, not which tier was chosen.

1. `StaticFieldProbe` — static field read/write
2. `InstanceFieldProbe` — instance field read/write
3. `VirtualCallProbe` — virtual call (override)
4. `InterfaceCallProbe` — interface call
5. `PrimitiveArrayProbe` — primitive array access
6. `ReferenceArrayProbe` — reference array access
7. `ExceptionProbe` — exception throw/catch
8. `ClassInitProbe` — class initialization
9. `RecursionProbe` — recursion
10. `ConstructorProbe` — constructor invocation

Fixtures live in `sources/worker-equiv/`. Each test asserts the worker arm
actually received work (`requested > 0`), materialized and published at least
one body (`installed > 0`), and — because a short fixture can finish before
publication — runs the program a second time in the same JVM and checks
`CompileWorkerClient.installedMethods` against
`jit.generatedMethodRunCounts` to prove a worker-transported body was actually
executed by the guest, not a local fallback.

---

## 6. Generated-code table-ID audit

Every occurrence of a bare numeric table index written into generated
JavaScript text by an emitter. Three classifications, in order of strength:

| Classification | Meaning |
| --- | --- |
| **Symbolically rebound** | The receiver resolves the dependency in its own runtime, by name/capture. |
| **Shared-ID-dependent** | Correctness depends on the ID reservation and placement protocol (`reserveSiteIdSpace` / `describeSiteTablesSince` / `placeSiteTables`). |
| **Explicitly refused** | The dependency cannot currently cross safely; the result is refused (`untransportableTableGrowth`). |

Shared-ID-dependent sites are valid under the existing protocol, but they are
**not** evidence that the dependency on shared numeric IDs has been removed.
That dependency is exactly the architectural source of transport restrictions
identified in `docs/plan-linear-runtime.md` §1.5, item 3.

The fast paths of the structured renderer already emit **symbolically
rebound** dependencies and therefore do not appear in the table below:
`helpers.getFieldAtSite(capturedFieldSite(…))`,
`helpers.tryInvokeSyncAtSite(capturedSyncCallSite(…))`,
`helpers.structuredSsa.restoreDirectFrameSlots(capturedRestoringLayout(…))`,
and the `capturedDirectStaticTarget` / `ssaLinkStaticTarget` capture.

| file | line / function | table | generated form | classification |
| --- | --- | --- | --- | --- |
| `JitCompiler.js` | 5413–5414 / `compileScalarIntegerLoop` | `fieldSites` | `helpers.getFieldAt(<id>, obj)` | shared-ID-dependent |
| `JitCompiler.js` | 5487 / `compileScalarIntegerLoop` | `syncCallSites` | `helpers.tryInvokeSyncAt(<id>, frame, thread)` | shared-ID-dependent |
| `JitCompiler.js` | 5747–5764 / `compileBaselineMethod` | `inlineLoopRegions` | `helpers.canRunInlineLoopRegion(<id>, frame)` / `helpers.runInlineLoopRegion(<id>, frame, thread)` | explicitly refused |
| `JitCompiler.js` | 6220–6258 / `emitInstruction` | `fieldSites` | `helpers.getFieldAt(<id>, obj)` / `helpers.putFieldAt(<id>, obj, value)` | shared-ID-dependent |
| `JitCompiler.js` | 6265, 6284 / `emitInstruction` | `directStaticTargets` | `helpers.directStaticTargets[<id>]` | shared-ID-dependent |
| `JitCompiler.js` | 6316 / `emitInstruction` | `directJreInitializationTokens` | `helpers.directJreInitializationTokens[<id>].initialized` | explicitly refused |
| `JitCompiler.js` | 6321 / `emitInstruction` | `directJreIntrinsics` | `helpers.directJreIntrinsics[<id>](…)` | explicitly refused |
| `JitCompiler.js` | 6347, 6358 / `emitInstruction` | `syncCallSites` | `helpers.tryInvokeSyncAt(<id>, frame, thread)` | shared-ID-dependent |
| `JitCompiler.js` | 9899 / `emitInlineIntegerMethod` | `fieldSites` | `helpers.getFieldAt(<id>, obj)` | shared-ID-dependent |
| `JvmSsaBlockRenderer.js` | 6169 / `compileMethodBody` | `directJreInitializationTokens` | `helpers.directJreInitializationTokens[<id>].initialized` | explicitly refused |
| `JvmSsaBlockRenderer.js` | 6177 / `compileMethodBody` | `directJreIntrinsics` | `helpers.directJreIntrinsics[<id>](…)` | explicitly refused |
| `JvmSsaBlockRenderer.js` | 12123 / `compileMethodBody` | `checkedLeafCaptureCaches` | `helpers.checkedLeafCaptureCaches[<id>]` | explicitly refused |
| `HotCallGraphRegionCompiler.js` | 2521 / `rewriteCallBindings` | `syncCallSites` | `helpers.tryInvokeSyncAt(<id>, frame, thread)` | shared-ID-dependent |

Notes:

- "shared-ID-dependent" means the table is in `transportableSiteTables`: the
  requester reserves a disjoint id range, the worker compiles into it,
  `describeSiteTablesSince` ships the entries, and `placeSiteTables` rebuilds
  them at the sender's indices on arrival. Correctness rests on that protocol,
  which is the shared-numeric-id dependency the plan wants designed out.
- "explicitly refused" means the table is watermarked by
  `untransportableTableGrowth` but has no descriptor/rebuild path, so a compile
  that allocated into it is refused and recompiled locally. These are
  `directJreIntrinsics`, `directJreInitializationTokens`,
  `checkedLeafCaptureCaches`, `inlineLoopRegions`. They remain documented
  limitations and were not fixed in this pass.
- `restoringFrameLayouts` no longer has a bare-id emit site: the restore path
  now binds the slot list symbolically (`ssaLinkRestoringLayout<id>` capture
  into `helpers.structuredSsa.restoreDirectFrameSlots`).
- No emitter was refactored for this audit. Making the four refused tables
  transportable is expert work (descriptor + rebuild path per table), not a
  local fix.

---

## 7. Four-arm benchmark

`scripts/benchmarkPhase1Worker.js` runs `worker off / on / off / on` against
the same checkout with ahead-of-main preparation on
(`ALTERORB_JVMJS_PREPARE_BEFORE_START=1`) and writes one JSON result file plus
a console summary.

```bash
node scripts/benchmarkPhase1Worker.js
# ALTERORB_JVMJS_PREPARE_BEFORE_START=1 JVM_PHASE1_BENCH_ROUNDS=2000 \
#   JVM_PHASE1_BENCH_OUT=bench-phase1-worker.json node scripts/benchmarkPhase1Worker.js
```

Because the Deko Bloko launcher is not in this checkout (see
`docs/plan-linear-runtime.md` "the launcher A/B is the substitute"), the
script substitutes a **synthetic late-loading mechanism benchmark** — a
mechanism test for late class loading and its post-main compilation behavior,
**not** game acceptance evidence. It does not establish Deko Bloko loading
latency, FPS, or frame pacing, and must not be read as such (the original plan
records a real boot regression that passed both the worker suite and a larger
default-mode gate).

The two-class workload:

- `Phase1BenchmarkMain` — the hot loop the guest runs after `main()`;
- `BenchLate` — loaded **after** preparation (pushed onto the classpath after
  `precompileInitializedClasses`), exercising late class loading. Its methods
  therefore compile after `main()`: synchronously with the worker off, on the
  worker with it on.

Captured per arm: `preMainSyncCompile*`, `postMainSyncCompile*` (+per-tier
`inclusiveMs`), `totalInstallMs`, `largestInstallMs`, install attempt counts
and the pre/post-main install split, the install phase breakdown, and the full
worker census (`requests`, `installed`, `refused`, `stale`, `superseded`,
`failed`, reason aggregates). Game-launcher metrics (`postLogoToMenuMs`,
`meanFps`, frame percentiles) have no producer here and are emitted as `null`,
never fabricated; `hotLoopIterationsPerSec` is the substitute throughput signal
and, on this deliberately tiny workload, includes the worker's one-time boot,
so the arm with the worker on understates steady-state throughput.

Sample output: `docs/sample-phase1-worker-benchmark.json`.

---

## 8. Architecturally suspicious items left unchanged

Recorded per the work-package review rule; none were changed.

1. **Materialization happens before the "already has a body" check.**
   `CompileWorkerClient.receive` fully calls `materializeGeneratedResult` and
   only then checks `codegenCache.has(method)` to decide install vs superseded.
   A superseded result therefore pays full descriptor binding + `new Function`
   cost on the main thread for a body that is thrown away. The superseded
   counter now makes this measurable; moving the `codegenCache.has` check
   earlier (or tagging the method as "has an in-flight result" and skipping
   materialization) is an obvious optimization, but it changes result-handling
   behavior and was left for review.

2. **Four tables remain untransportable by construction** (section 6): a single
   slow-path reference to `directJreIntrinsics`,
   `directJreInitializationTokens`, `checkedLeafCaptureCaches`, or
   `inlineLoopRegions` throws away a whole otherwise-good compile
   (`untransportableTableGrowth`). The fix — symbolic captures plus a
   descriptor/rebuild path per table, as already done for the five
   transportable tables — is mechanical in shape but touches the emitters'
   slow paths, which is exactly the code this package was told not to redesign.

3. **A superseded/stale result's materialization cost is now counted as an
   attempt, not an install.** `recordResultInstallTiming` records every result
   that reaches materialization (installed, stale, superseded) under
   `attemptCount` / pre/post-main attempt ms, and reserves `installCount` /
   `largestInstallMs` for successful publishes. The remaining gap is that the
   attempt phase breakdown for stale/superseded results is attributed in bulk
   (`totalInstallMs`) rather than per phase, because `materializeGeneratedResult`
   fills the phase timings incrementally; that is cosmetic and was left as-is.

4. **`wasmInstantiationMs` is always zero today.** No Wasm result is
   transported (the Wasm tier's import closures are live objects and are not
   described symbolically yet — see `docs/plan-linear-runtime.md`). The phase
   is wired and records zero rather than being absent, so the Wasm result
   landing later will light it up without a census schema change.

5. **The tiny synthetic workload makes the worker's fixed boot cost visible.**
   With `prepareBeforeMain` on and a two-class workload, the worker-on arm's
   `hotLoopIterationsPerSec` is dominated by the worker's one-time JVM boot
   and classpath preload, because there is not enough steady-state work to
   amortize it. This is an artifact of the substitute workload, not evidence
   about the worker; `postMainSyncCompileMs` is the number the phase cares
   about, and it is zero in the worker-on arm and non-zero in the worker-off
   arm.
