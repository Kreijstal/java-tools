# Handwritten kernel retirement

This note tracks the conversion of the old complete-algorithm JavaScript
substitutions into targets for generic bytecode-derived compilation. The
production optimizer must not select a class or method by name. The historical
modules now live under `scripts/oracles/`: production modules do not import
them and no JIT option or environment variable can select them. Benchmark
drivers invoke them directly as differential and performance references.

## Current inventory

| Historical oracle | Production replacement | Checked workload |
| --- | --- | --- |
| affine sprite raster | structured SSA with quotient/product recurrence range versioning | original and recompiled DekoBloko bytecode |
| fused gradient triangle | structurally verified wrapper/raster/scanline region | original DekoBloko bytecode |
| fused flat triangle | structurally verified wrapper/raster/scanline region | original DekoBloko bytecode |
| transparent raster / clipped span | structured SSA counted loops and array-range versioning | generic Java fixtures |
| tiled blit | structured SSA nested counted loops | generic Java fixture matching the algorithm |
| perspective span | structured SSA nested counted loops | generic Java fixture matching the algorithm |
| bilinear sampler | acyclic structured SSA with entry field caches | generic Java fixture matching the algorithm |
| polygon raster | structured SSA caller plus generated span child | generic moving convex-polygon fixture |

The proxy fixture and its driver are
`benchmarks/SsaHandwrittenKernelTargetsBenchmark.java` and
`scripts/benchmarkSsaHandwrittenKernelTargets.js`. The Java identities are used
only by the benchmark driver to find its entry points. No optimizer source
contains those identities.

## Physical retirement (2026-08-02)

The seven historical `Handwritten*` modules were moved from `src/jit/` to
`scripts/oracles/`. Their production imports, runtime options, environment
gates, counters, late-link retry path, and semantic replacement slots were
removed. `FusedRegionCompiler`, `JitCompiler`, and `JvmSsaBlockRenderer` can no
longer install or execute them.

`test/fusedHotLoopRegression.test.js` asserts that loading the production JVM
does not load an oracle module and that compiled regions expose no oracle slot.
`npm run test:performance:jvm-kernel-proxy` is the approximately three-second
paired CI gate. It requires exact checksums and uses relaxed per-family timing
limits to catch large regressions without making normal CI depend on sub-2%
timing noise. The slower three-process `<= 1.01` measurement remains the strict
retirement/performance acceptance protocol.

## Generic changes

Two reusable changes came from this pass:

1. The fused lexical compiler now reads each verified non-volatile,
   read-only static field once per kernel invocation. A static written by the
   method, or a volatile static, remains a live bytecode read. This preserves
   snapshot/state behavior because a fused invocation is scheduler-atomic and
   a later invocation reloads the current field value.
2. Structured SSA array-range analysis now accepts constant integer
   recurrences (`iinc`, or `local + constant`) in addition to invariant static
   steps. The fast loop is entered only after endpoint, trip-count, and int32
   overflow checks. The unchanged slow loop still reconstructs the exact
   throwing PC, locals, operand stack, and mutations preceding an exception.

Neither transformation checks descriptors, owners, class names, method names,
or known fingerprints.

## Measurements

Environment for the measurements below:

- java-tools base commit: `aaa2c1efdcb01c1b4e59ad638e6730ebb7a78b14`
- worktree: dirty (the results describe the working changes in this note)
- Node: `v26.4.0`
- javac: `11.0.31`, fixture target Java 8
- DekoBloko classes:
  `/home/kreijstal/git/dekobloko-work/classes-original`
- ordinary generic configuration: `structuredSsa=true`

The real-bytecode fused differential executed 200 gradient and 200 flat
wrapper calls with identical destination pixels. The generic runtime installed
no handwritten wrapper or compact raster. Paired timing then changed as
follows:

| Family | Before stable-static hoist | After | Output |
| --- | ---: | ---: | --- |
| gradient wrapper/raster/scanline | 2.04x oracle | 1.30x oracle | exact |
| flat wrapper/raster/scanline | 2.99x oracle | 1.33x oracle | exact |

The post-change entries are medians of three clean Node processes (process
paired medians: gradient 1.297, 1.304, 1.262; flat 1.330, 1.339, 1.292).

Command:

```sh
FUSED_DIFFERENTIAL_BENCHMARK=1 \
FUSED_DIFFERENTIAL_BENCHMARK_ITERATIONS=2000 \
FUSED_DIFFERENTIAL_BENCHMARK_ROUNDS=7 \
FUSED_DIFFERENTIAL_BENCHMARK_WARMUPS=4 \
node scripts/differentialFusedRenderers.js \
  /home/kreijstal/git/dekobloko-work/classes-original 200
```

Three clean proxy processes, each containing seven paired rounds, reported:

| Family | process paired medians | three-process median | Output |
| --- | ---: | ---: | --- |
| tiled blit, 128 pixels | 2.611x, 3.160x, 3.011x | 3.011x | exact |
| perspective span, about 96 pixels | 2.165x, 2.123x, 2.105x | 2.123x | exact |
| bilinear sampler, one pixel | 3.101x, 3.215x, 3.106x | 3.106x | exact |
| polygon raster, about 1600 pixels | 2.531x, 2.689x, 2.445x | 2.531x | exact |

Command:

```sh
npm run benchmark:jvm:ssa-kernel-targets
```

These proxy ratios are deliberately not presented as wins. They expose the
remaining generic gaps:

- cyclic/wrapped source indexes prevent the tiled source load from receiving
  a loop-wide range proof;
- the perspective texture index is a bit-packed recurrence and retains
  checked loads;
- acyclic samplers still pay restoring-entry and exception-state scaffolding
  per call;
- polygon scan conversion repeatedly enters its generated span child instead
  of fusing the child scalar body into the parent loop.

The next compiler work should therefore be generic cyclic-index range
versioning and trusted intermethod region formation. Re-enabling a historical
complete-algorithm substitution would hide those costs and is not an
acceptable production fix.

## 2026-07-31 continuation

The follow-up pass kept every historical implementation as a benchmark oracle
and added two bytecode-derived mechanisms:

- integer interval propagation now proves ranges such as
  `(value & mask) + (value >>> shift)`. The emitted fast loop is guarded by
  the derived maximum index and array length; a short array executes the
  unchanged checked loop and restores the exact `iaload` PC;
- a method compiled before class initialization can snapshot a subsequently
  linked, non-volatile static at generated entry. Scalar fields qualify
  directly; reference fields qualify only when their read is inside a lexical
  loop. The unresolved first invocation retains `getStaticSyncAt`, and every
  later invocation reloads the current map/object slot, so static rebinding and
  snapshots remain visible between entries.

Neither analysis reads an owner, method name, descriptor fingerprint, or known
guest constant combination. A new cold-link test compiles before synthetic
`<clinit>` writes, checks the initial stores, rebinds the destination array,
and verifies that the next invocation mutates only the new array.

The higher-volume Node A/B for cold-linked static snapshots used 100,000
invocations per timing sample, nine paired rounds, and five warmups:

| Polygon proxy | generated ns/invocation | oracle ns/invocation | paired ratio |
| --- | ---: | ---: | ---: |
| cold-linked snapshots disabled | 5,968.43 | 2,420.68 | 2.4766x |
| cold-linked snapshots enabled | 5,517.84 | 2,433.94 | 2.3350x |

The bit-bounded perspective proof is correct and removes two checked-load
sites, but repeated clean-process timings were tier-sensitive and did not show
a dependable whole-kernel speedup. It remains useful generic range
information, not a claimed FPS breakthrough.

The production Firefox bundle was rebuilt and installed with SHA-256
`14bd2441766dce47cf0337b5c47936a77aee80190d59c5797c6fc3c31ea61f3e`.
Brick-A-Brac painted its first visible frame at 18.62 seconds. The following
20.01-second window presented 158 frames (7.90 FPS), while the guest marked
only 186 dirty frames and had a 7.3-second worst gap. Presentation was not
latched: 158 frames were scheduled, 158 presented, and 18 timer fallbacks
completed starved animation-frame callbacks. The screenshot was still inside
the Jagex-logo/asset phase, so this is a negative startup result rather than a
gameplay measurement. The remaining startup limiter is guest asset/audio work,
not these raster kernels.

## 2026-07-30 remaining-oracle pass

Three more transformations target costs exposed by the four-oracle proxy
without selecting a guest identity:

- restoring scalar entries now resolve and snapshot cold-linked static
  locations before any guest effect. Their loop bodies use the snapshot
  unconditionally instead of branching on linkage at each load. Rebinding is
  still observed at the next scalar entry;
- array range analysis recognizes a verified `index++` recurrence whose
  equality branch resets a phase to zero and subtracts an invariant modulus
  from the index. A runtime phase/window/overflow guard removes the cyclic
  source-load check from the fast loop. The slow loop retains prior stores,
  exact failing PC, locals, and nested array operands;
- restoring entries inline their cold materialization statements instead of
  creating one closure for every operand depth on every call. The successful
  sampler/span path now creates only the lazy frame-spill closure.

The high-volume proxy command used 100,000 calls per sample, nine paired
rounds, and five warmups. All four checksums remained exact. A representative
run reported 713.95 ns for tiled blit, 534.01 ns for perspective span,
78.69 ns for the one-pixel bilinear sampler, and 5,190.07 ns for polygon
raster. Process-to-process V8 tiering also moved the paired oracle, so these
numbers are recorded as proxy progress rather than an FPS claim.

The same live run uncovered an independent resume-state correctness defect.
A handler-protected non-void call could leave structured SSA after consuming
its argument, then enter the baseline resume body at the call join without the
pending return value. Runtime telemetry identified the structural state
(`availableOperands=0`, `requiredOperands=1`) before the old negative
JavaScript stack length. Such methods now use the complete baseline generated
tier from entry until pending-return values are represented explicitly in the
SSA join. This gate does not affect the call-free raster/mixer/codec kernels or
polygon's void span child.

Production bundle SHA-256
`4b316e2926b2b7308e9e6a554d14f44353a552448e873d72b34788392b55d700`
completed a 75.02-second Firefox measurement without page/runtime errors.
Brick-A-Brac painted its first visible frame at 20.17 seconds and presented
439 frames (5.85 frames/s) while it remained in asset preparation. This is
still not a gameplay FPS result and is below the acceptance target. The
focused JIT suite passed 1,198/1,198 assertions before that build.

## 2026-08-01 complete-kernel continuation

This pass continued through every remaining historical oracle family without
enabling any complete guest algorithm in production. Selection and analysis
remain independent of guest owner and member names.

The generic renderer gained four reusable mechanisms:

- handler-bearing methods with a protected non-void call are still rendered
  far enough to publish a verified restoring positional kernel, but their
  ordinary `Frame` entry uses the baseline pending-return handoff. This split
  fixed a live `rp.a(ZZI)V -> pg.c(I)Z` operand underflow without throwing away
  the unrelated affine kernel solely because it has a handler;
- eager read-only primitive-array instance fields now participate in the same
  endpoint range proofs as array parameters and statics. A field-backed proof
  disables lexical continuation so another Java thread cannot rebind the
  field between proof and use;
- shifted current/carried induction values such as
  `vertices[(previous << 1) + 1]` receive a guarded range version after the
  initializer, unique carried assignment, ordering, and every backedge are
  verified. Polygon scan conversion removes four successful-path checks;
- acyclic restoring entries inline their cold spill statements instead of
  allocating a spill closure on every successful call.

The real DekoBloko affine benchmark remained bit exact and published the
generic positional ABI. A representative Node 26.4.0 run measured 34,678 ns
per invocation versus 18,186 ns for the historical oracle (paired ratio
1.958x), improved from 47,207 ns at the start of the pass. The standalone
generic clipped span measured 51.51 ns versus 75.67 ns for its handwritten
counterpart, so that historical span is no longer a useful production fast
path.

The four-family proxy remains intentionally adversarial. A representative
seven-round run after the range/copy changes reported exact checksums and the
following generated metadata:

| Family | Generic shape observed |
| --- | --- |
| tiled blit | 2 loops, 2 range guards, cyclic source proof |
| perspective span | 3 loops, 4 range guards, 2 bit-bounded ranges |
| bilinear sampler | acyclic, 3 entry field caches |
| polygon raster | 2 loops, 4 shifted/carried ranges |

Node timings remain tier-sensitive and are not an FPS claim. The persistent
gaps are approximately 2x for tiled/perspective, 1.6x for bilinear, and 2.4x
for polygon in the latest process. Polygon's main remaining cost is repeated
entry into its generated span child, not the span body in isolation.

An experimental checked-leaf ABI was therefore built for a single bounded,
call-free loop. Its guards dominate every guest effect; rejection returns to
canonical invocation before the first write, and focused tests verify valid
stores plus short-array rejection. It reduced the Node polygon proxy from
5.83 us to 5.10 us in one paired process. Firefox A/B rejected it decisively:
the comparable animated Brick-A-Brac menu window fell from 9.20 FPS to 2.60
FPS and then 0.50 FPS on a repeat. The selector is consequently **off by
default** and available only through `checkedLeafDirectPositional=true` or
`JVM_ENABLE_CHECKED_LEAF_POSITIONAL=1`. The proxy enables it explicitly so the
experiment stays reproducible; production does not.

The safe Firefox run used bundle SHA-256
`da8ede1cb22422510d952198ba8b5abb249f8b24cae65ce5961e42af653e37b1`.
After a 90-second post-first-frame wait and the same click sequence, a
20.004-second window presented 184 frames (9.20 FPS), with no page/runtime
errors and no recurrence of the operand underflow. The screenshot was the
animated title/menu login dialog rather than gameplay, so the result is below
the 30 FPS goal and is not an acceptance result.

Focused verification after the production rollback passed 1,215/1,215 JIT
assertions. The production build completed with the four existing webpack
warnings. The served rollback bundle currently has SHA-256
`fb29a83a2a19f396c7a2f0ae1686b6b47d4734954cc64c21bf551c67974855e8`;
it retains the checked-leaf compiler only behind the disabled experimental
gate.

### Guarded obfuscator CFG and split-induction breakthrough

The 9.20 FPS sample above was an outlier. A final clean rollback measurement
with bundle SHA-256
`6564be93586aa56dd11140d8108318aa1086c4a4c3fe76ea22562c86f57643f9`
presented 30 frames in 20.022 seconds (1.50 FPS). That value is the safe
baseline for the following same-machine measurements.

Time profiling then exposed two generic shapes that the toy kernels had not
reproduced:

- an initialized boolean static was copied once to an immutable integer local
  and tested repeatedly inside an otherwise numeric raster. Those branches
  created an irreducible CFG. The compiler now resolves the boolean location,
  guards its observed value before every guest effect, rewrites only direct
  `iload`/`ifeq` or `ifne` consumers of the uniquely written local, and proves
  that the originating read received the normal entry guard. The affected
  live raster changed from an irreducible fallback to five structured loops
  with ten branches pruned;
- tiny pure integer helpers were hidden behind unreachable catch-and-format
  tails. The integer-leaf verifier now walks only normal CFG successors and
  still applies its non-throwing opcode whitelist. Eight protected calls in
  the raster consequently inline as scalar expressions, removing the reason
  its ordinary entry required the baseline pending-return ABI.

Bundle SHA-256
`aa13e7829d3e86c0fc9c4eb4fba7e0dd3f77f4bba2e292a2b0af295c674e370e`
painted its first visible frame in 18.17 seconds and then presented 145 frames
in 20.019 seconds (7.24 FPS). There were no page/runtime errors. The formerly
dominant raster no longer appeared among the sampled synchronous blockers.

The next blocker used a unique `iinc` that dominated every natural-loop
backedge but lived in the block immediately before the literal backedge,
separated by the same inert boolean guard. Counted-loop verification now uses
a path/dominance proof instead of requiring the update and backedge to share a
basic block. Verified integer-leaf calls are also treated as the scalar,
non-throwing operations they become after emission. For a nested scanline over
an initialized static primitive array this enables:

- one entry endpoint/overflow/array-length guard;
- a branch-free typed-array fast loop, with the complete checked loop as its
  slow arm;
- one runtime trip-count charge instead of a scheduler test for every pixel;
- canonical safe-point fallback between scanlines if the outer region exceeds
  its time quantum.

The transformation is descriptor-, owner-, member-, and constant-independent.
It does not speculate on first-use-linked array fields; those retain the
canonical checked path until a later compilation can resolve their location.
Single long static-array loops retain lexical continuation and refresh their
static snapshots after a Java-thread yield.

Bundle SHA-256
`95a95d8db7eb0ab4340f56e6ddbf17127b27d8769da77f537493b61f99deff00`
painted its first visible frame in 18.25 seconds. After the same 90-second
warmup, its 20.022-second window presented 332 frames (16.58 FPS), with no
errors. The previous 146 ms / 64 ms-maximum raster blocker disappeared; its
remaining wrapper samples totaled 4 ms. This is an 11.1x improvement over the
clean 1.50 FPS baseline, but it remains below the 30 FPS acceptance goal.

Reproduction metadata: the java-tools base commit was
`69650d38b6778c883a30c0c9da8540cf04373d39`; the tree was dirty with the five
tracked optimizer/benchmark/test/documentation files described by this
section. The served original `brickabrac.jar` SHA-256 was
`91284c0ec25fa4f8913876c78be9d80d273d8dd567d5b92950f1795f37b3c95d`.
The page used `mode=structured`, `yield=timer`, handwritten oracles off,
checked-leaf positional off, a 90,000 ms post-first-frame warmup, and a 20,000
ms requested measurement window.

A deliberately sampled follow-up (`timings=1`, rate 1/256) presented 11.12
FPS, demonstrating material profiler cost. It found no remaining dominant
historical raster kernel: the largest generated samples were isolated asset
or model-construction calls, while presentation performed 625 Wasm swizzles
and 422 ms of copy work over the complete run. Future live profiling must
therefore separate recurring animation time from one-shot asset/model work;
re-enabling handwritten raster algorithms would no longer address the
measured top blocker.

The focused suite now has 1,228 assertions, including copied-boolean guard
fallback, unreachable diagnostic-tail leaf inlining, split-update dominance,
range-versioned output, static rebinding, continuation refresh, and exact
exception-state coverage. The four-family Node proxy remains checksum exact;
the latest representative process measured generic/oracle ratios of 3.03x
(tiled), 2.03x (perspective), 1.56x (bilinear), and 2.26x (polygon). These
microbenchmark gaps remain optimizer targets, but the live A/B shows that the
newly admitted guest bodies—not complete handwritten substitutions—produced
the large Firefox gain.

## 2026-08-01 parity correction and captured checked leaves

Disabling a handwritten production selector is not the same thing as retiring
its implementation. The historical files remain required performance oracles
until the bytecode-derived path is comparably fast for every covered family.
Exact pixels plus a faster live workload are necessary, but they do not waive
this per-kernel throughput gate. In particular, the four proxy gaps recorded
above mean that tiled, perspective, bilinear, and polygon kernels are **not yet
retired** and must not be deleted.

This continuation reduced generic overhead without recognizing a guest owner
or member name:

- generated natural counted loops and javac post-decrement loops are rendered
  as ordinary JavaScript `while` loops rather than infinite loops containing a
  header branch and explicit continue;
- nonzero CFG edges remove their dominated `idiv`/`irem` zero check;
- range analysis hoists fixed, nested-counted, and post-decrement endpoint
  guards when failure can return to canonical execution before the first guest
  effect; the retained slow arm still owns exact exception restoration;
- a verified checked child leaf can publish a second fixed-arity body whose
  non-volatile static values and raw primitive-array view are supplied by its
  generated caller. The caller snapshots those locations once per synchronous
  scheduler slice. A safe point resumes through the canonical frame, so a
  later slice observes static rebinding. The child keeps its own class,
  debugger, and range guards and returns to canonical child invocation before
  its first write when a guard fails.

The captured child removes six static-map reads and one array-view lookup from
each polygon scanline call. Three clean Node 26.4.0 processes, seven paired
rounds each, remained checksum exact:

| Family | process paired medians | three-process median | Status |
| --- | ---: | ---: | --- |
| tiled blit | 2.816x, 2.824x, 2.893x | **2.824x** | not parity |
| perspective span | 1.711x, 1.937x, 1.931x | **1.931x** | not parity |
| bilinear sampler | 1.535x, 1.556x, 1.520x | **1.535x** | not parity |
| polygon raster | 1.704x, 1.521x, 1.513x | **1.521x** | not parity |

The polygon median improves on the preceding 2.26x result, and perspective
improves on 2.03x, but neither result satisfies the retirement gate. Firefox
was intentionally not used as a success claim while the fast Node proxy still
fails parity. The next work remains method-entry layout proof for cyclic tiled
rows, whole-span destination/texture preflight for perspective, and a compact
acyclic exceptional ABI for the one-pixel sampler.

Reproduction base: java-tools
`ec84410f3d650e6949851f3616b51b0668af6922`, dirty with the generic renderer,
compiler linkage, proxy, tests, and this documentation update. Command:

```sh
npm run benchmark:jvm:ssa-kernel-targets
```

## 2026-08-01 cyclic rectangle parity

The tiled proxy's earlier `2.824x` result mixed two different questions. The
generic side received all twelve dynamic guest operands and retained JVM entry
and exceptional semantics. The old `runTiledOracle` accepted only destination,
source, and a case number; it hardcoded width, height, row count, copy width,
and stride, omitted every entry/layout guard, and was small enough for V8 to
inline into the measurement batch. It remains useful as an explicitly selected
fixed-specialization ceiling (`SSA_TILED_FIXED_CEILING=1`), but it is not an
equivalent handwritten retirement gate.

The default comparator now invokes the exact positional function installed by
the handwritten intrinsic, factored through its `createRun` factory rather
than copied into the benchmark. It therefore includes its dynamic operands,
bytecode/debug/class-state guards, `arrayData` resolution, integer narrowing,
complete preflight before the first write, fallbacks, and runtime counter.
Generic SSA then added the assumptions that implementation relies on as
verified compiler facts:

- a one-dimensional increment/wrap recurrence is extended through an
  enclosing counted row loop only after verifying the row normalization,
  entry-phase restore, row increment/reset, cycle subtraction, invariant
  locals, unique write counts, and the preheader `height * width` definition;
- one entry predicate proves positive dimensions, valid horizontal/vertical
  phases, non-overflowing cycle size, and the complete backing rectangle;
- all destination and source guards must dominate the outermost entry before
  a nested checked leaf can be published. A partially proved recurrence keeps
  the restoring implementation, preventing a fallback after an earlier row
  has already written;
- dynamic nested trip counts are capped and charged once. The admitted checked
  leaf has no scheduler branch, checked array helper, `Frame`, or restoring
  slow twin;
- checked-leaf SSA removes invariant parameter aliases and one-use arithmetic
  values, folds single-exit CFG blocks, and emits shared range-predicate values
  for product/base/end and outer trips/inner trips/stride/final index. Each
  assumption is therefore computed once.

None of these decisions reads a guest class name, method name, descriptor, or
fingerprint. An altered row recurrence in the unit fixture is rejected from
the checked-leaf tier.

Three fresh Node 26.4.0 processes, 10 warmup batches and seven paired rounds
per process, produced exact checksums and these generic/dynamic-handwritten
paired medians:

| Process | generic ns/invocation | handwritten ns/invocation | paired ratio |
| --- | ---: | ---: | ---: |
| 1 | 538.97 | 546.97 | **0.985x** |
| 2 | 542.11 | 546.36 | **0.992x** |
| 3 | 542.79 | 554.33 | **0.981x** |

The three-process median is **0.985x**, and every process is at or below the
requested `1.01x` ceiling. The checksum on both sides was `-2077411136` in all
three processes. Reproduction command:

```sh
for run in 1 2 3; do
  SSA_KERNEL_TARGET_ITERATIONS=10000 \
  SSA_KERNEL_TARGET_ROUNDS=7 \
  SSA_KERNEL_TARGET_WARMUPS=10 \
  node scripts/benchmarkSsaHandwrittenKernelTargets.js
done
```

This establishes proxy parity for the dynamic tiled implementation. The
historical module remains checked in until the real guest differential/live
path confirms that the same verified checked leaf is selected there; the
fixed-specialization ceiling is not used to veto retirement because it omits
the handwritten implementation's required guards.

### Capture-free caller fusion closes the fixed tiled ceiling

A follow-up source diff explained why the optional fixed ceiling could still
appear roughly 1.3--1.4x faster than a standalone generic entry. Its JavaScript
function accepts only destination, source, and a case number; nine layout
operands are constants, both arrays are already raw backing arrays, and it has
no JVM entry or all-or-nothing layout guard. The generic checked body accepted
all twelve dynamic operands and was invoked as a separate 15-argument
JavaScript function (including helpers, thread, and the guarded-entry flag).

The generic compiler already inserted checked children lexically when they
captured static targets. It accidentally withheld the same source from a
capture-free checked child, leaving the tiled family behind a cached function
pointer and preventing host constant propagation. Checked-leaf discovery now
publishes ordinary capture-free source as well. A call-only, handler-free,
forward wrapper can itself publish a checked leaf when it has exactly one
lexically available, non-throwing checked child and no other guest effect or
throwing operation. A failed child layout returns the async sentinel before
the first child effect; canonical execution therefore still owns the exact
exception path.

The benchmark now includes `tiled-blit-compiled-caller`, whose Java caller
computes the changing phase from `item` but supplies the repeated layout
constants in bytecode. Its generated source contains the two array/layout
predicates and both nested loops in one function, with no cached child call,
`tryInvokeSyncAt`, `Frame`, operand materialization, or method dispatch.
Selection uses checked-leaf properties and CFG/effect verification only; it
does not inspect class names, method names, descriptors, or fingerprints.

Three fresh Node 26.4.0 processes (12 warmups, nine paired rounds, 10,000
invocations per batch) produced matching checksums:

| Family | process paired ratios | Status |
| --- | ---: | --- |
| tiled standalone / exact dynamic handwritten | 0.972x, 0.982x, 0.986x | passes 1.01x |
| tiled compiled caller / fixed specialized ceiling | **0.868x, 0.872x, 0.866x** | generic is faster |

The compiled-caller medians were 202.89/233.57, 206.19/238.65, and
206.78/239.92 generic/ceiling ns per invocation. This closes the apparent
fixed-ceiling gap through generic interprocedural optimization rather than by
teaching the optimizer a tiled method identity.

### Trusted nested entries remove the remaining standalone call-shape gap

A later long-sample rerun exposed an intermittent 1.11--1.15x regression in
the standalone tiled row even though the compiled Java caller remained faster
than the fixed ceiling. The JavaScript and optimized-machine-code diff located
the difference at entry rather than in the blit: the dynamic generic checked
leaf was 3,532 bytes of optimized code versus 3,512 bytes for the exact
handwritten entry, and still accepted a dynamic `nestedEntryGuarded` operand.
The compiled caller already proved that operand true, but a large separately
compiled leaf was not reliably inlined and specialized by V8.

Checked leaves now publish a second, generic trusted-nested ABI. It is selected
only by a generated caller after that caller's scheduler/debug entry guard has
succeeded. The specialized child still retains its class-lifecycle epoch,
array-view, trip-count, and complete range predicates, so rejection remains
before the first guest effect. No owner, method name, descriptor, fingerprint,
or tiled-loop identity participates in publication or selection. The original
dynamic guarded entry remains available for untrusted entry.

On Node 26.4.0 the trusted entry reduced the tiled function's optimized code
from 3,532 to 3,320 bytes. With an unusually busy host pinned to one CPU and
V8 concurrent recompilation disabled, three 50,000-invocation, 12-warmup,
11-round processes produced standalone generic/exact-handwritten paired
medians of **0.866x, 0.839x, and 0.879x**. The lexically fused caller/fixed
ceiling medians were **0.769x, 0.770x, and 0.728x**. Every checksum matched.
The absolute nanoseconds are intentionally not used from that run because the
host load average exceeded 30; the paired ratios and optimized-code diff are
the reproducible evidence.

```sh
for run in 1 2 3; do
  taskset -c 15 env \
    SSA_KERNEL_TARGET_ITERATIONS=50000 \
    SSA_KERNEL_TARGET_ROUNDS=11 \
    SSA_KERNEL_TARGET_WARMUPS=12 \
    node --no-concurrent-recompilation \
      scripts/benchmarkSsaHandwrittenKernelTargets.js
done
```

## 2026-08-01 full comparator audit and lexical checked leaves

Extending the tiled audit to the other proxy rows found two more comparator
errors. `runBilinearOracle` was a stripped arithmetic implementation without
the installed intrinsic's class/debug, receiver-layout, source-bounds,
destination-location/bounds, fallback, or counter work. The perspective row
called only `runKernel`, omitting the installed positional wrapper's same
entry and complete-span preflight. The default benchmark now invokes the
exact functions retained by `BilinearSamplerOracle` and
`PerspectiveSpanOracle`; their stripped functions remain explicitly
named ceilings, not retirement gates.

The polygon proxy is different: its Java fixture is a direct per-row edge
intersection algorithm, while `PolygonRasterOracle` models a shared
edge-table method suite. They produce the same selected convex images but are
not state- or rounding-equivalent in general. An attempted cross-comparison
correctly produced different hashes and was removed. The existing polygon row
is now labelled `equivalent-scanline-ceiling`; a same-bytecode historical gate
is still required before the historical polygon implementation can be
retired.

Generic compiler improvements from this audit are independent of every guest
identity:

- an acyclic, handler-free, call-free method with exactly one final primitive
  array effect can publish a transactional checked leaf. Exceptional field,
  source-load, division, and destination-store paths return to canonical
  execution before that effect, without embedding a `Frame` reconstruction in
  the hot body;
- a verified non-throwing checked child can be lexically inserted into its
  structured caller. Captured static values are substituted into block-local
  SSA names and the caller's class guard covers the child/capture owners, so a
  scanline loop contains neither JavaScript call dispatch nor `try/catch`;
- forward CFG inequality facts are killed on local writes, closed
  transitively, and intersected at joins. Both arms of a crossing predicate
  can therefore prove the same unordered endpoint inequality and remove an
  impossible `idiv` exception arm without recognizing polygon code.

Three fresh Node 26.4.0 processes (10 warmups, seven paired rounds) produced:

| Family | process paired ratios | Status |
| --- | ---: | --- |
| tiled, exact dynamic handwritten | 0.846x, 0.970x, 1.005x | passes 1.01x |
| perspective, exact dynamic handwritten | 0.798x, 0.772x, 0.781x | passes 1.01x |
| bilinear, exact dynamic handwritten | 0.107x, 0.110x, 0.112x | passes 1.01x |
| polygon, equivalent scanline ceiling | 1.140x, 1.150x, 1.156x | **not parity** |

All rows retained identical paired destination checksums. Polygon improved
from roughly 1.49x before lexical child insertion to a 1.15x three-process
median, but it remains above the requested 1.01x ceiling. The full retirement
goal therefore remains open; fused gradient/flat, affine, and the remaining
historical span families also require equivalent-comparator audits rather than
being inferred from this four-row proxy.

## Verification

The focused differential checks are:

```sh
node scripts/differentialFusedRenderers.js \
  /home/kreijstal/git/dekobloko-work/classes-original 200
node scripts/benchmarkSsaHandwrittenKernelTargets.js
timeout 90s node node_modules/tape/bin/tape test/jitCompiler.test.js
```

The unit suite includes explicit rejection coverage for volatile and written
static hoists, and exception-state coverage for a failed constant-recurrence
array guard.
