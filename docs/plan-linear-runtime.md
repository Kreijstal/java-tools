# Plan: background compiler, linear-memory object model, wide Wasm

Target: Deko Bloko logo and menu at 24 fps in stock Firefox at 900 MHz.
Today: menu 6.8–7.06 fps JS-first, time-to-menu 171 s, compile is 24.5% of
main-thread time during the logo and 0–2% at the menu.

Order: G0 (one deciding measurement) → Phase 1 (compile worker) →
Phase 2 (objects in linear memory + GC) → Phase 3 (Wasm widening on the new
model). Phase 1 is model-independent, so nothing in it is thrown away by
Phase 2. Phase 3 is deliberately last: widening Wasm on the current
externref/import-closure model is the part a linear object model discards.

Worktree: ~/git/java-tools-slim (branch jit/slim-callsites), local mirror
scratchpad/slim synced with rsync. Test baseline: 11 known failures.

---------------------------------------------------------------------------

## G0 — deciding measurement (1 day)

Question: does a linear-memory object model actually close the gap to 24 fps,
or is the 6.8 fps ceiling somewhere else?

Do: hand-write the hottest raster leaf (ck.a, the blit kernel benchmarked in
scratchpad/jsshell/bench_blit.js at 14.1 ns/px under Ion) as a Wasm function
that reads its pixel arrays and object fields straight from linear memory,
with no imports on the per-pixel path. Run it in the same JS shell against the
same input as bench_blit. Repeat for one call-heavy per-frame driver (fh.a or
hn.f) with its callees as direct wasm calls.

Gate: if the kernel is not at least 2.5× faster than Ion's version, Phase 2
does not pay for itself and the plan stops after Phase 1. Record the numbers
in memory either way.

## G0 result (2026-09-06) — gate passed, Phase 2 is justified

Measured on i7-1360P (turbo, not the 900 MHz target; the gate is a ratio),
SpiderMonkey 153 shell (Ion), one variant per process, raster checksums
identical across variants. Benchmarks and generated bodies live in
bench/g0-linear-runtime/ (README there).

Kernel ck.a(III[I[IIIIIIIIII)V — the additive sprite blit behind ck.f(III)V;
the Node CPU profile of the menu confirms it is the hottest raster leaf
(6.5% self, tier ssa-direct-restoring-positional). ns per source pixel,
median of 7 rounds, 3 repeats:

    jvm.js restoring-positional body, plain Array (heap off)   8.5–9.0
    jvm.js restoring-positional body, Int32Array (heap on)     8.5–8.8
    hand JS over Int32Array                                    3.5–3.7
    hand Wasm, arrays in linear memory, no imports             1.7–1.9   → 4.7× vs jvm.js, 1.9× vs hand JS

Driver fh.a(IIZI)V (per-frame ray/triangle driver: 2 table lookups, an
int[6], and ok.a([III)V → ok.b([III)V / ok.a(II[I[I)V / ok.a()V / ok.a(II)V /
ok.b()Z / ok.b(II)V / ok.c()V / hk.c(IIIII)V per element; 48 elements,
640×480 raster). µs per frame:

    jvm.js tiers as the game links them (fh.a structured-ssa framed entry,
      callees restoring-positional, ok.a([IIIII[I[I)V through its
      positional-entry frame adapter), plain Array                  8.5–9.1 ms
    same, Int32Array                                               8.4–8.8 ms
    hand JS, direct calls, Int32Array                              2.5–2.8 ms
    hand Wasm, statics as globals, int[] in linear memory,
      callees as direct wasm calls                                 1.5–1.6 ms   → 5.5× vs jvm.js, 1.6× vs hand JS
    jvm.js chain with only the hk.c span leaf swapped for hand JS  9.2–9.8 ms   (leaf is not the cost)

Reading: the object model (fixed offsets, direct calls) buys 1.6–1.9× over
the best JavaScript; the rest of the 4.7–5.5× is what the current tiers
leave on the table (entry guards, Number()|0 coercions of every argument,
positional-entry frame adapters, static cells, per-span call protocol in the
rasterizer). Both halves are needed for 24 fps; neither alone gets there.

Not in this measurement: the 900 MHz Firefox numbers, boot compile share
(24.5%) and time-to-menu (171 s) quoted above came from another machine
and were not re-measured here. Node menu fps here: 48 (plain boot), 6.3 with
--profile-jit (instrumented, do not compare with browser numbers).

---------------------------------------------------------------------------

## Phase 1 — compile worker with hotness priority (1–2 weeks)

Goal: no compile work on the main thread **after main() starts**.

### Measurement contract (this governs every number in Phase 1)

Work done before `main()` is free. There is no budget for it, and no result
in this phase may be argued on the grounds that it costs time up front. The
whole classpath may be preloaded and every method compiled on both tiers
before the guest runs; that is the intended shape, not a concession.

Exactly two things count, and both are measured after `main()`:

1. **Loading time after main()** — `postLogoToMenuMs` from the Node launcher
   (`firstMenuSurfaceAt - logoCompletedAt`). NOT wall time, and NOT
   time-to-menu: those include preparation, which is free by the rule above.
2. **fps after the menu appears** — the launcher's `--measure-fps-ms` sample.

Method: `ALTERORB_JVMJS_PREPARE_BEFORE_START=1` on every arm, arms run
back-to-back in one script (off/on/off/on), same tree. Never compare against
a number measured on a different tree or a different day.

Corollary, and the reason this section exists: a compile that happens after
`main()` is a stall, so anything that pushes compilation later is a
regression even when it makes startup look faster. Freezing a tier once
preparation is done is therefore desirable, provided preparation actually
compiled everything eligible for that tier first.

### 1.1 Hotness sampler replaces call-count thresholds
- Today: JitCompiler.invocationCounts + warmupThreshold (JitCompiler.js:694),
  loop-bearing methods compile on sight, and the Wasm tier has its own
  `st.entries < threshold || !hasBackwardBranch` gate (WasmJit.js:2629)
  producing below-warmup / no-supported-backedge.
- New: a per-method decaying hotness score. The interpreter and baseline
  tiers bump the score on entry and on backedge (both counters already exist);
  a main-thread tick every ~50 ms halves all scores and pushes the top-N
  uncompiled methods to the worker queue. No threshold decides whether a
  method may compile; the queue order decides what compiles next.
- Loop-free methods are eligible. The no-supported-backedge refusal goes
  away; a loop-free method simply has a lower score per entry.
- Keep the existing tier-selection code paths for deopt/re-entry untouched;
  only the "should we compile now" decision changes.

### 1.2 Worker = shadow JVM
- The worker boots its own JVM instance from the same data package the page
  fetches (browser-entry.js:215 options.dataUrl) and loads classes with
  loadClassByName as the main thread does. Started at the first class load,
  in parallel with the main boot.
- Main → worker message: {className, methodKey, tier, classEpoch, the set of
  initialized classes the codegen may assume, jit options}.
- Worker runs the existing JvmSsaBlockRenderer / WasmJit / Structured
  compiler unchanged and returns:
  - JS tiers: {parameters, source, hoistedSource, captures[]} where each
    capture is a symbolic descriptor, not a live object:
    {name:'ssaLinkFieldSite…', kind:'fieldSite', owner, field, descriptor},
    {kind:'callSite', owner, name, descriptor, opcode},
    {kind:'classGuard', className}, {kind:'staticCell', owner, field},
    {kind:'sentinel', which:'asyncInvoke'|'returnVoid'}, …
    (sources of these today: JvmSsaBlockRenderer.js:2961–2975 and
    createStructuredFunction at 13646, which calls
    JitCompiler.createGeneratedFunction with a live captures map).
  - Wasm tier: a WebAssembly.Module compiled in the worker (structured-clone
    transferable) plus import descriptors for each of the 35+22+29
    addImport sites (field, static, dispatch map, JRE intrinsic, bridge).
- Main thread binds: interns each descriptor into its own site tables
  (fieldSites, syncCallSites, classInitializationGuards,
  directStaticTargets), renames the capture to its local site id, runs
  `new Function` (measured ~1% of boot), instantiates wasm with imports built
  from descriptors, then installs through the existing publish path.
- Site ids must therefore be symbolic across threads: the worker never
  assumes its numeric ids match the main thread's.

### 1.3 Staleness and correctness
- A result carries the classEpoch and initialized-class set it was compiled
  against. A compile that assumed a class was initialized when this thread has
  not initialized it is refused.
- **A moved class epoch is NOT by itself a reason to drop a body.** This
  bullet originally read "new subclass of a CHA-guarded callee", i.e. it was
  written assuming class-hierarchy-analysis guards exist in this JIT. They do
  not — there is no CHA devirtualization anywhere in src/jit. The check
  outlived the assumption that justified it, and cost 172 of 498 finished
  bodies on a real boot before it was caught. See "1.3 the class-epoch check
  was discarding finished bodies" below for the full audit.
- Dropping a result is never free: the method is then compiled on the main
  thread, after main(), which is the exact cost this phase exists to remove.
  Every discard path is therefore a defect to be designed out, not a knob to
  be tuned. See 1.5.
- The main thread never compiles synchronously; until a body arrives the
  method runs in the interpreter/baseline tier. The only exception is the
  existing deopt-to-generated_sync path, which stays.
- Seed the queue with every method of every loaded class in class-load order
  (this is what precompileInitializedClasses at jvm.js:1218 iterates today),
  reordered continuously by hotness.

### 1.4 Verification
- Full test suite in Node with the worker replaced by an in-process shadow
  compiler (same message protocol, synchronous), so the descriptor round-trip
  is tested without a browser.
- Node launcher A/B per the measurement contract above: `postLogoToMenuMs`
  and post-menu fps, preparation on in both arms, worker off/on/off/on
  back-to-back.
- The suite is necessary and nowhere near sufficient. Four defects that took
  dekobloko from a 66 s boot to a 180 s timeout all passed a 3310/3310
  ten-file gate and a 14/14 worker suite, because none of them bites below
  the scale of a real boot. Any Phase 1 claim needs the launcher A/B, not a
  green suite.
- The browser leg named in the original plan (nav.py + profile_attach2.py on
  :3772 against gecko-logo.json, 24.5% / 171 s) cannot run here: those
  artifacts do not exist in this checkout. The launcher A/B is the substitute
  and should be reported as such, never as the browser number.

### 1.5 Designing out the discard paths

Discarding a finished body means recompiling it on the main thread after
main(). Three things cause it; only the first was a plain bug.

1. **The class-epoch check** — fixed (see 1.3 and the audit below).
2. **`method not mirrored in the worker`** — infrastructure. The worker only
   knows classes the main thread pushes to it, so any gap in that push
   becomes a refusal. But the worker boots its own JVM from the same
   classpath: it can load classes itself instead of waiting to be told.
   Giving it the classpath-driven mirror removes this refusal class outright,
   and preloading it before main() is free.
3. **The shared site-id space** — the architectural cause, and the one that
   forces refusals by construction. The emitters write bare table indices
   into generated JavaScript on their slow paths (`helpers.getFieldAt(7, …)`,
   `helpers.directStaticTargets[3]`, `restoreDirectFrame(2, …)`), and
   generated JS is never reparsed, so the two JITs are forced to share one id
   space. Everything downstream follows: per-request grants, the 512-id
   stride, refusal when a compile outgrows its grant, and a hard refusal for
   any result touching one of the four tables the protocol cannot describe
   (directJreIntrinsics, directJreInitializationTokens,
   checkedLeafCaptureCaches, inlineLoopRegions) — a whole compile thrown away
   over one slow-path reference.

   Fix: emit those slow paths through symbolic captures, as the fast paths
   already do, so generated text carries no bare index. Then a result needs no
   grant, cannot outgrow one, and the four tables stop being fatal. This also
   closes the original 1.2 item "descriptors for the four untransportable
   tables" from the other direction, and it respects the no-reparse rule
   rather than fighting it.

## Phase 1 status (2026-09-06)

### 1.1 hotness sampler — implemented behind JVM_JIT_HOTNESS=1, OFF by default
Code: JitCompiler.recordHotness/hotnessTick/isHotnessSelected, credited on
every interpreted entry (canRun) and per interpreted bytecode burst (both
scheduler interpreter paths); the scheduler loop ticks it; WasmJit's
below-warmup / no-supported-backedge gate is replaced by "selected" in
sampler mode. Knobs: JVM_JIT_HOTNESS_TOP (4), _TICK_MS (50), _MIN_SCORE (1),
_BYTECODE_WEIGHT (1/32). Tests: test/jitHotness.test.js (fixture
sources/HotnessProbe.java). Correction to the plan text: there is no existing
interpreter backedge counter; only invocationCounts and WasmJit st.entries
exist, so bursts of interpreted bytecodes are credited instead.

Measured in Node (offline launcher, back-to-back, same tree), Deko Bloko to
menu + 15 s fps window:

    sampler off   elapsed 65.9 s   post-logo→menu 17.7 s   713 compiles / 11.6 s   fps 49.8
    sampler on    elapsed 108.8 s  post-logo→menu 37.6 s   611 compiles / 11.2 s   fps 50.1
    sampler off   elapsed 64.6 s   (repeat)                                        fps 49.9
    sampler on    elapsed 113.1 s  (repeat)                                        fps 49.9

### Correction (same day): most of that slowdown was the Wasm gate, not deferral
The first sampler patch also replaced WasmJit's own
`st.entries < threshold || !hasBackwardBranch` gate with "is this method
hotness-selected". A CPU profile of the two boots (`--cpu-profile`) showed why
that was wrong: with the sampler on, `va.d(I)[F` moved OFF the Wasm tier and
burned 8.7% of all samples on the JS structured tier, GC went 8.0% -> 15.0%,
`jvm-core` 4.7% -> 9.0%, and the Wasm category fell 6.2% -> 3.8% while the
compilers (`ssa.js`, `WasmJit.js`, `StructuredWasmCompiler.js`, `wasmInline.js`)
gained ~13% of samples in retries. Restoring the classic Wasm gate under the
sampler:

    sampler off (classic wasm gate)   elapsed 65.7 s   fps 49.9
    sampler on  (classic wasm gate)   elapsed 67.5 s   fps 49.9

So Phase 1.1's own cost is ~2 s, not ~45 s. The sampler governs the JS tiers
only; the Wasm tier keeps its entry/backedge gate. The rest of this section's
numbers were measured with the bad gate and are superseded.

The sampler removed only 14% of compiles and 3% of compile time, while hot
methods ran interpreted for thousands of calls before a tick selected them
(td.d(Lvl;)V 2589 interpreted entries, kj.a(II)[I 1975). On the main thread
"compile later, and only what is hot" is a pure deferral: the bill is
dominated by large methods that are needed either way (client.n 0.7 s,
ia.c 0.7 s, td.d 0.46 s ...). The 24.5% → <3% compile-share goal cannot come
from 1.1 alone; it needs 1.2 (compiles off the main thread). Keep the sampler
as the worker queue's priority order, not as a main-thread gate.

### 1.2 compile worker — protocol slice implemented, worker not started
What a compile actually needs from live runtime state (inventory of
JvmSsaBlockRenderer + JitCompiler compile paths):
- class metadata: jvm.classes[...] ASTs, findMethod, findClassNameForMethod
  (a shadow JVM loading the same classes has these);
- initialization: classInitializationState, class/initialization epochs,
  getClassInitializationToken (send the initialized set; guards re-verify on
  the main thread anyway: registerClassInitializationGuard starts at epoch −1);
- static stores: resolveStaticFieldSite reads classData.staticFields for the
  key → cell. A shadow JVM cannot run <clinit>; it must pre-create the
  declared static keys with default values for classes reported initialized,
  or the body degrades to getStaticSyncAt slow paths;
- site tables: registerFieldSite, registerSyncCallSite, registerDirectStaticTarget
  — ids are per-JIT, hence the symbolic protocol below;
- callee bodies at compile time: getCompileTimeCheckedLeaf / IntegerLeaf /
  DirectJre / SynchronousIntrinsic and primeMonomorphicSyncCallSite call
  getGeneratedFunction(callee) — the worker compiles callees itself (fine),
  but eager monomorphic priming and receiver profiles (site.targets) are
  main-thread observations the worker does not have; the result must be
  compiled without them and linked on the main thread, or the profile is
  shipped in the request;
- Wasm tier: WasmJit/StructuredWasmCompiler read jvm.classes[...] 10× and
  build import closures from live objects — the part Phase 2 discards.

Protocol slice landed (JitCompiler): every generated function now carries
jvmParameters / jvmTier / jvmGenerator / jvmAsynchronous / jvmHoistedSource /
jvmCaptureDescriptors; describeLinkRecords turns live captures into data
(kinds: staticCell{className,key}, callSite{op,className,methodName,
descriptor,callerPc}, fieldSite{className,fieldName,descriptor},
classGuard{owners}, sentinel{which}); internLinkRecords builds live records
for descriptors on any JIT (registering new site ids); rebindGeneratedFunction
rebuilds an equivalent function from text + descriptors alone (verified: the
rebound restoring-positional body of CaptureProbe.walk returns the same value
and bumps the same interned static cell by the same amount). Census over the
3155 bodies the booted game compiled: 5158 static cells, 3372 call sites, 923
class guards, 206 field sites, 2044 sentinels, nothing else — the protocol is
complete for the JS tiers. Test: test/jitCaptureDescriptors.test.js
(fixture sources/CaptureProbe.java). JVM_DUMP_GENERATED_CAPTURES=1 writes the
same descriptors as a sidecar next to JVM_DUMP_GENERATED_DIR dumps.
test/jitCompiler.test.js (2364) stays green with the sampler and protocol
changes in the tree.

### 1.2 result transport — landed; 1.4 in-process shadow compiler — landed
The multi-tier result object now crosses as plain data. Two pieces:

1. The structured renderer's continuation wrappers were closures over the
   compile's own locals (the guarded-static-boolean sites, the field-backed
   array guards, `items.length`, the adaptive-body policy flags). They are now
   module-level factories in JvmSsaBlockRenderer — createStructuredSpeculationState,
   wrapAdaptiveStructuredBody, wrapFramedStructuredBody,
   attachStructuredContinuationHelpers — driven by id-level descriptors
   (`jvmStructuredSpeculation`) and a plain shape record
   (`jvmStructuredWrapperShape`). The compile tail and the receiving thread
   call the same factories, so the two paths cannot drift. withResumeBody's
   dispatcher was factored out the same way (JitCompiler.buildResumeDispatcher).
2. JitCompiler.serializeGeneratedResult / materializeGeneratedResult.
   Serialization walks the result's own properties: a generated function
   becomes {parameters, source, hoistedSource, tier, generator, asynchronous,
   captures: descriptors}; a Set/array/plain object of scalars is projected as
   data (bigint and Set are tagged); anything else — a live method AST, a
   statement assembler — is refused and named in the payload's `dropped` list
   rather than shipped as null. Materialization interns every descriptor into
   the RECEIVING JIT's site tables, rebuilds each body with `new Function`,
   then reapplies the wrapper factories from the shape record.

Verified by test/jitShadowCompile.test.js, which is the 1.4 test double: a
second JVM instance plays the shadow JVM (same classpath, loads the class,
pre-creates the declared static keys of the classes the request reports
initialized, never runs a guest instruction), compiles CaptureProbe.walk with
no guest execution at all, and hands back a payload that survives
JSON.parse(JSON.stringify(...)) — the constraint a structured clone imposes.
The main JIT rebuilds it and the transported restoring-positional body returns
the same value as the main thread's own compile and writes the main JVM's own
static cell by the same amount. A ~170 KB payload for walk() drops exactly two
properties, both hot-call-graph-region inputs:
jvmRestoringDirectPositionalInsertion (statement assemblers) and
jvmStructuredRegionCallSites (resolved method ASTs). A transported body is
therefore not a region-outlining candidate; every execution tier crosses.

### 1.3 staleness — landed
A result records the world it was told to assume: the requester's class epoch
and its set of INITIALIZED classes (JitCompiler.captureResultProvenance). The
worker stamps the result with the REQUEST's provenance, never its own
incidental counters -- a shadow JVM's epoch and initialized set mean nothing on
the requesting thread. On arrival resultStalenessReason refuses a result whose
class epoch moved (a class registered since the compile can add a receiver type
to a site the body linked monomorphically) or that assumed a class this thread
has not initialized. A refused result is not repaired: nothing is installed and
the method compiles locally. Counted as jit.staleTransportedResults.

### 1.4 in-process shadow compiler — landed, and it corrected 1.2
src/jit/ShadowCompiler.js is the worker run in process and synchronously
(JVM_JIT_SHADOW_COMPILE=1, off by default). It owns a second JVM which gets a
structuredClone of each class AST -- exactly what postMessage hands a Worker --
its own StaticFieldStore, and its own JitCompiler with its own site tables. It
never runs a guest instruction. JVM_JIT_SHADOW_COMPILE_VERIFY=1 forces every
payload through JSON.parse(JSON.stringify(...)), the constraint a structured
clone imposes; _STRICT=1 turns every silent fallback into an error; _DIFF=1
also compiles locally and compares the two tier selections; _REPORT=<file>
writes the run's transport census.

Running test/jitCompiler.test.js with every compile routed through it found
three defects the capture census of 1.2 could not have found, because that
census only looked at CAPTURES:

1. **Bare table indices in the generated text.** The emitters write ids
   straight into the source on slow paths (`helpers.getFieldAt(7, ...)`,
   `helpers.directStaticTargets[3]`, `restoreDirectFrame(2, ...)`), so a
   transported body indexed the receiver's tables with the sender's ids and
   crashed on `initializationToken` of undefined. The earlier claim in this
   document that "the protocol is complete for the JS tiers" was wrong: it held
   for fast paths only. Generated JavaScript is never reparsed here, so the
   text cannot be rewritten on arrival. The two JITs share ONE id space
   instead: siteIdWatermark / reserveSiteIdSpace grant a compile ids at or
   above the requester's watermark, describeSiteTablesSince ships every entry
   the compile allocated, and placeSiteTables rebuilds each from the receiver's
   own world and puts it at that index, refusing the whole result if a slot is
   already occupied by something else.
2. **Not every table can cross.** Four more are indexed by bare id and have no
   descriptor yet: directJreIntrinsics, directJreInitializationTokens,
   checkedLeafCaptureCaches, inlineLoopRegions. untransportableTableGrowth
   watermarks them, so a compile that allocated into one is refused and
   compiled locally rather than installed broken.
3. **The environment variable overrode the explicit option**, so the shadow
   JVM built a shadow of its own, recursively, until the heap was exhausted.
   An explicit `shadowCompile: false` now wins over the variable.

Result on test/jitCompiler.test.js (2342 tests): 210 compile requests, 173
transported (82.4%), 10.8 MB of payload. The refusals are named: 19 no owning
class, 7 refused by the shadow's own compiler, 4 class not mirrored, 4
untransportable tables (3 inlineLoopRegions, 1 directJreIntrinsics +
directJreInitializationTokens), 2 stale on arrival. 21 of the 2342 tests still
fail under shadow mode; they are white-box assertions about which tier or
fallback a body published, and they differ because the shadow's world is not
VALUE-identical to the main's. That explanation is now RETRACTED -- see below.

### Correction: the 21 shadow-mode failures are not a <clinit> problem

I attributed them to the shadow's inability to run <clinit>, which leaves
statics at their defaults and decides value-dependent speculation differently.
Tested directly by shipping every static's current value in the request
(primitives and bigints exactly, arrays as type+length+primitive elements,
other references as a present-but-opaque stand-in): it fixed NONE of the 21 and
crashed the run outright at jitCompiler.test.js:6983, where an explicit
preparation returned null. Reverted.

What the failures actually say is `generic dispatch should not run for the
warmed X`. A worker compiles into fresh ids above the requester's watermark,
so every call site it describes is new here -- and `registerSyncCallSite` never
dedupes, so it is also empty. Installing the transported body pointed the
method at cold sites and its first entry took generic dispatch.

Aliasing an arriving site onto the receiver's warmed site (matching op, target,
descriptor, caller pc AND caller method, so two callers never share a PIC) is
in `placeSiteTables` and fixed exactly one test (2321 -> 2322 passing, none
broken). It is not the cluster's cause. Counting the misses says why:

    aliased 15 (0 of them carrying a link), fresh 132, of which
      63  the receiver has no site for that target at all
      45  identity matched but registered during this same placement (cold)
      11  same caller, different pc (all cold)
       7  different caller method (cold)
       6  different caller method (LINKED)  <- the only warm ones missed

108 of 132 have no warm counterpart to inherit. The warmth those tests assert
does not live in the receiver's call-site table, so no arrival-point matching
restores it. Closing the cluster needs the REQUEST to carry the requester's
learned link state (linked target plus PIC entries) so the worker compiles
against the same speculation, or the installed body to be re-warmed. That is a
protocol change of the same size as the site-id space work, and it is the next
design step -- not a fix to guess at.

The three clusters are probably three causes: 1176-1237 (warmed methods taking
generic dispatch), 1342-1346 (a checked leaf that is not a function on
arrival), 1626-1627 (a region plan arriving null).

### Correction: the two hotCallGraphRegion failures were NOT pre-existing

I recorded them here as pre-existing on the strength of restoring one file
from a working-tree backup. That is not a baseline: the backup already carried
the change that breaks them. A clean `git worktree` at HEAD runs the file
174/174.

The cause is the resume dispatcher (`ssaResumePc`, uncommitted work in this
tree -- HEAD has no occurrence of the name). It wraps the whole framed body in
one `switch (ssaResumePc) {`, and the framed partition pass only descends into
an oversized group whose head statement is relocatable. A `switch` head never
is, so the pass saw a single 58 KB group holding every loop it exists to cut,
declined it, and reported zero segments. The pass had therefore stopped firing
on ANY framed root that emits resume dispatch.

Fixed in `partitionOversizedLinearBlocks`: an oversized group whose head
cannot move is still descended into -- the head stays put, only runs inside
its body are cut. The file is 174/174 and the harness now cuts 9 segments
where it cut 0. A back-to-back A/B over nine JIT files (fix off, then on, same
tree) shows the fix removing exactly those two failures and adding none.

### The suite leaks JVM_PROFILE_JIT_METHODS across test files (pre-existing)

`test/jitCompiler.test.js` sets `process.env.JVM_PROFILE_JIT_METHODS = '1'` at
module scope (line 8, present at HEAD). tape requires every test file before
running any test, so the flag is on for every other file's JVMs. The hot
call-graph region guard (`HotCallGraphRegionCompiler.js`, `plan.guard`)
deliberately returns false whenever `profileMethods` is on, so four region
tests that call `plan.body(...)` and expect a scalar get the async sentinel
instead. Verified pre-existing: the clean HEAD worktree fails the same four
when those two files run in one process (plus two more in jitCompiler itself).

The three test files added for phases 1.1-1.4 no longer set that env at module
scope; they opt in per JVM with `jit: {profileMethods: true}`, which wins over
the env (`options.profileMethods ?? envProfileMethods`). Every JVM in
`test/hotCallGraphRegion.test.js` is now explicit about `profileMethods:
false`, which five of its fourteen already were.

Not done: the Worker itself (worker_thread / Web Worker boot from the data
package and the async message loop -- everything it would carry is now plain
data), value-identical static state in the request, descriptors for the four
untransportable tables, and the Wasm-tier result (a WebAssembly.Module is
structured-cloneable, but its import closures are built from live objects and
are not described symbolically yet).

---------------------------------------------------------------------------

### 1.2 the real worker — landed, and the suite hid four defects (2026-09-06)

The worker is a real `worker_threads` thread that boots its own JVM
(`src/jit/compileWorkerThread.js`); `src/jit/CompileWorkerClient.js` owns the
queue, the id grants and installation. 14 tests passed and a ten-file
default-mode gate ran 3310/3310 — and dekobloko still went from a 66 s boot to
a 180 s timeout, twice, in a back-to-back A/B. Every defect below was live at
once and none was visible to the suite, because the tests never reach the
scale where any of them bites.

The probe that found them (`JVM_JIT_COMPILE_WORKER_STATS=1`, 5 s dumps):
8547 requests, **29 installed**, 8467 refused, and `syncCallSites` grown from
152k to **4.4 million** entries, still climbing ~360k every five seconds.

1. **Classes were marked delivered before the send.** `pendingClasses()` added
   to `sentClasses` and then postMessage threw — structured clone is
   all-or-nothing, and one uncloneable class killed a batch of 344. Those
   classes were never offered again, so 99% of requests were refused with
   `method not mirrored in the worker`. Fixed: commit only after the send
   returns, and `quarantineUnsendable` finds the individual culprits and
   retries without them.
2. **A refused method was never retired.** It was removed from `inFlight` and
   nothing else, so `enqueue` re-queued it on the next call forever, and
   `getGeneratedFunction` never fell through to a local compile — the method
   stayed interpreted for the whole run. Fixed: `decline()` retires it to the
   main thread's own compiler, which is the honest fallback when the worker
   cannot deliver.
3. **The id grant was reserved before the send.** Every failed request still
   burned 512 ids in five tables. `placeSiteTables` scanned the whole
   `syncCallSites` array per install, so installs went quadratic against a
   table that only grew. Fixed: reserve after the send returns, and maintain
   a caller-keyed index in `registerSyncCallSite` instead of scanning.
4. **The queue was FIFO.** `precompileInitializedClasses` seeds every method
   of every loaded class, burying the handful the guest is actually running.
   Fixed: without the sampler the queue orders by demand — how often a method
   has been asked for again — which self-calibrates, since a seed is asked
   once and a running method is asked on every cache miss.

After these: requests plateau at 498 instead of running away, `failed` 0, the
table stable at 261k.

### 1.3 the class-epoch check was discarding finished bodies (2026-09-06)

With the storm gone the next loss was visible: of 498 results, 244 installed,
82 refused and **172 discarded on arrival**, every one reading
`class epoch moved 311 -> 312`. `resultStalenessReason` dropped any body whose
`jvm.classEpoch` had moved since the request was sent. Classes load
continuously during a boot, so an asynchronous compile essentially always
loses that race — and each discarded body was then recompiled on the main
thread, which is precisely the work Phase 1.2 exists to move off it. The
synchronous shadow compiler never hit this: nothing could load mid-compile,
so the check was free and looked harmless.

The check guards a link baked against "the set of classes that exist" with no
runtime check of its own. A transported result does not carry one:

- call sites arrive **cold** — `describeSiteTablesSince` carries only
  op/class/name/descriptor/pc, and `placeSiteTables` rebuilds them through
  `registerSyncCallSite` with empty `targets`/`jreTargets`;
- field sites and direct static targets are re-resolved on this thread, and
  static dispatch has no receiver to be wrong about;
- class-initialization guards start at epoch -1 and re-verify;
- both speculation kinds — guarded static booleans and field-backed array
  ranges — re-read their cell at entry;
- there is no class-hierarchy (CHA) devirtualization in this JIT, so no
  "single implementor" assumption exists for a new class to falsify;
- speculative monomorphic **wasm** links are the real epoch consumer, and they
  drop their own `specok` flag synchronously inside `bumpClassEpoch`.

So the epoch check is now enforced only for a result that declares itself
epoch-sensitive, which today means eager monomorphic call linking (off by
default since it miscompiled tombracer). The compiling JIT stamps that itself
via `stampResultProvenance`, rather than trusting the requester's snapshot.

Preloading the jar does not substitute for this. Only one of the three epoch
bump sites is jar class loading (`jvm.js:2435`/`2447`); `createArrayClass`
(2379) and JRE stub synthesis (2533) fire on demand throughout the run, so the
epoch keeps moving however much is preloaded.

### 1.5 designing out the discard paths — items 2 and 3 landed (2026-09-06)

**Item 2 (`method not mirrored`) is closed by construction.** The worker boots
its own JVM on the same classpath and preloads all of it before serving any
request (`compileWorkerThread.js`), so the classpath is never a refusal
source. The main thread still pushes classes, but only for what the classpath
cannot supply — synthesized JRE stubs and array classes. That push was also
made honest: a batch is marked delivered only after `postMessage` returns, and
a send that throws is bisected by `quarantineUnsendable` so one unclonable AST
no longer strands every class in its batch.

**Item 3 is implemented for the four tables the transported bodies actually
reference.** Each bare index in the emitters became a symbolic capture, and
the receiving JIT rebinds the capture by name:

| table | emit sites rerouted | how |
| --- | --- | --- |
| `fieldSites` | 13 | `getFieldAt`/`putFieldAt` split into id wrapper + `…AtSite` core |
| `directStaticTargets` | 6 | `capturedDirectStaticTarget` + new `staticTarget` describe kind |
| `restoringFrameLayouts` | 2 | `registerRestoringFrameLayout` + new `restoringLayout` describe kind |
| `syncCallSites` | 1 | `tryInvokeSyncAtSite` via `capturedSyncCallSite` |

`directJreIntrinsics` and `checkedLeafCaptureCaches` keep their bare indices.
The bodies exercised so far reference neither, so routing them now would be
speculative; the drop gate below turns any future need into a loud failure
rather than a silent miscompile.

Region call sites were made transportable separately: `describeRegionCallSites`
replaces the live `resolvedMethod` with a `{className, name, descriptor}`
reference and `internRegionCallSites` re-resolves it on arrival, refusing the
whole result if any target cannot be found.

**The drop gate — `payload.dropped` was reported but never consumed.** Metadata
that could not be projected to plain data was listed and then ignored, so
bodies installed with pieces missing. `materializeGeneratedResult` now refuses
any result with a dropped key unless that key is on
`JitCompiler.transportOptionalKeys`. The list has exactly one member,
`jvmRestoringDirectPositionalInsertion`: it holds statement assemblers that
cannot cross, and its consumer already null-guards it
(`HotCallGraphRegionCompiler.js:2959`), so losing it costs a lexical inline and
not correctness. Every other drop refuses.

**Two miscompiles surfaced, both reachable without the worker.**

1. `ssaLazyStaticTarget<n> is not defined`. Declarations are emitted for
   `lazyStaticSites` entries whose `referenced` flag is set, but the flag was
   only set when a site emitted new lines. Two `getstatic` sites on the same
   class+field share one entry cache while keeping separate variables and link
   records, so the second one referenced a variable that was never declared —
   a `ReferenceError` thrown from inside generated code on whichever guest
   thread reached the path first. The worker only changed tier selection
   enough to expose it.
2. A bare call-site index in transported text. The body said
   `helpers.tryInvokeSyncAt(1025, …)` while its capture `ssaLinkCallSite1025`
   had been correctly rebound to id 2053 on the receiver, so the call reached a
   different target, returned the void sentinel, and the body used that Symbol
   as an array index. This is the defect the drop gate was expected to catch
   and did not — it was found only because the assert forced the transport
   path to run on a realistic body.

`jitShadowCompile` now passes 19/19: a transported body returns the same value
and mutates the same static cell as the locally compiled one.

**Coverage note.** Making the worker default-on left the worker path thinly
covered — only `jitShadowCompile` and `jitCompileWorker` exercise it, because
the other JIT tests opt out with `jit: { compileWorker: false }` to keep their
synchronous `getGeneratedFunction` contract. The `prepareBeforeMain` path is
similarly thin. Both are gaps worth an equivalence test (same program, same
output, preparation on and off) before Phase 2.

### The compile worker was a net loss during preparation (2026-09-06)

`producerConsumer` failed on its 2000 ms bound from the moment the worker went
default-on, and it was not a flaky threshold. Paired, back to back:

| worker | runs |
| --- | --- |
| ON | 2051 / 2077 / 2089 ms |
| OFF | 1485 / 1526 / 1511 ms |

**The cost was entirely in ahead-of-main preparation, not in steady state.**
The test builds `new JVM({classpath:['sources']})` directly, and
`prepareBeforeMain` defaults to true, so `run()` compiles all 311 methods
before the guest starts. With the worker on that pass queued all 311, got
`null` back from every `getGeneratedFunction`, and then blocked on
`whenIdle()` while one worker thread — which also pays its own JVM boot,
classpath preload and `serializeGeneratedResult` per body — did work the main
thread could have done directly. Nothing overlapped, because nothing was
running. With `prepareBeforeMain: false` both arms measure 1039–1046 ms, the
guest's own `Thread.sleep(100)` × 10 floor.

Fix: `_precompileInitializedClasses` compiles on the calling thread when the
pass is `effectful`, which already means "the guest is paused for this". A
seed pass while the guest is running still queues — that is 1.3's "seed the
queue with every method", and there the point is precisely that this thread
does not stop to compile. After the fix, ON 1438/1496/1525 vs OFF
1473/1497/1498.

Four explanations were measured and rejected before this one, and each is
worth not re-testing:

- **id-space bloat.** 311 requests × 512-id grants leave `syncCallSites` near
  160 000 sparse entries. Stride 64 vs 512 changed nothing.
- **client overhead on the main thread.** Instrumented in-run: `sendMs` ≈ 23,
  `installMs` ≈ 45–63. About 75 ms of a 560 ms gap.
- **duplicated compilation.** Exactly 311 compiles in both arms — 311 local
  with the worker off, 311 on the worker (6 refused → 6 local) with it on.
  No duplication at all.
- **event-loop starvation.** Timer lag 83/26 ms with the worker vs 19/13 ms
  without; the loop was never starved.

What identified it was the CPU profile: main-thread busy time was unchanged
(671 → 719 ms) while `(idle)` went 968 → 1521 ms. The main thread was not
working harder, it was waiting.

**Consequence for the phase.** With preparation on by default, the only work
left for the worker is methods of classes that load after `main()`. The
`jitCompileWorker` tests had been driving the worker *through* preparation, so
they now build their JVMs with `prepareBeforeMain: false` to exercise the path
the worker actually serves. How much post-main compilation a real boot leaves
is now the open question that decides whether the worker can pay for itself;
the A/B must report it, not just the timings.

## Phase 2 — guest objects in linear memory with a collector (2–3 months)

Goal: fields at fixed offsets, arrays and strings in one heap, monomorphic
calls resolvable to addresses. This is the HotSpot property we lack and the
only path the measurements support toward 24 fps.

### 2.1 Layout (builds on the slab work already in the worktree)
- Object header: class index (cidx, already computed by makeObjectRef in
  objectModel.js:191), identity hash, monitor slot.
- All instance fields at per-class offsets (extend slabLayoutFor at
  objectModel.js:353 from primitives-only to references as i32 heap
  addresses).
- Arrays: header + length + elements (wasmHeap.js already places primitive
  arrays there; add reference arrays).
- Strings: guest objects whose value array lives in the heap; JS strings only
  at the JRE/JS boundary through the intern table (jvm.internString at
  jvm.js:363).
- Static fields: one slab per class.

### 2.2 Allocation and GC
- Replace the bump allocator (wasmHeap.js allocObject/alloc, never frees;
  measured 1.5 MB/min growth at the menu) with size-class free lists first,
  then a mark-compact pass once the root set is complete.
- Roots: interpreter frame locals and operand stacks, generated-body locals
  at safepoints (the existing safepoint budget machinery marks the points),
  static slabs, the intern table, and a handle table for references held by
  JS-side JRE/native code.
- Stop-the-world at safepoints. Growth of WebAssembly.Memory is allowed
  again once views are re-derived after growth (today the memory is fixed so
  views never detach; keep a single view-refresh hook).

### 2.3 Migration of the JS-side runtime
- Interpreter and JS tiers access fields through the accessor helpers
  (readField/writeField, objectModel.js:138–143) so the layout change is
  local; the JS tiers' generated bodies switch to slab loads exactly as
  wasmFields already does for primitives.
- JRE bootstrap and native methods (jre-bootstrap.js, jni.js) that touch
  `obj.fields` or JS properties directly are the large migration surface; do
  it class by class behind the same helpers, with the test suite as the
  gate after each package.
- JS object wrappers survive only as handles for JRE/JS code and for the
  DOM/canvas boundary.

### 2.4 Verification
- Full suite at each step; no new failures beyond the 11 known.
- Heap growth at the menu must stop (heap_check.py).
- Deko Bloko boots and reaches the menu; fps recorded but not yet the goal.

---------------------------------------------------------------------------

## Phase 3 — Wasm widening on the new model (3–4 weeks)

Goal: hot per-frame paths run in Wasm end to end; menu ≥ 24 fps.

- Field and array access become plain i32/f64 loads and stores (the import
  closures for fields, statics and the dispatch maps go away).
- Instance calls: class index → vtable → call_indirect through one shared
  function table. Every tier (interpreter trampolines, JS bodies, Wasm
  bodies) calls through that table, so a JS positional caller reaches a Wasm
  callee. This is what today prevents ck.a, hk.c, ok.b, lm.a from ever
  reaching the Wasm tier (their parents call them via site.fastPositional).
- String intrinsics (charAt, length, indexOf, equals) as Wasm helpers over
  heap char arrays; ldc strings as heap constants; ldc2_w constants inline.
- checkcast/instanceof as class-index table lookups.
- Constructors compile like any method (drop ctor-or-clinit exclusion once
  allocation is a heap call).
- Loop-free methods compile on hotness alone (Phase 1 already removed the
  backedge gate).
- Keep the JS tier only as the fallback for what the Wasm compiler refuses;
  the refusal census (wasm_flags.py) must show the per-frame drivers fh.a,
  hn.f, ke.k, ib.l and the raster leaves all in Wasm.

### Verification
- Census: all listed drivers and leaves compiled in Wasm.
- Profile: wasm-function share of the menu period dominant instead of 0.4%.
- logo_session9.py fps windows: logo and menu ≥ 24 fps at 900 MHz.

---------------------------------------------------------------------------

## Housekeeping before starting
- browser-entry.js currently ships wasmHeap/wasmHeapMb/wasmFields on; the
  best-known JS-first build (6.8–7.06 fps) had them off. Decide with the
  user: keep on as the Phase 2 foundation or revert for the default mode.
- Record in memory: process.env is empty in the bundle (all JVM_WASM_*
  switches were off in the browser until the jit.wasm option plumbing),
  the census reasons, the positional-link reason, the 24.5% boot compile
  share, and the G0 result.
- Commit only when asked.
