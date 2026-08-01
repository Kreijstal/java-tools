# Handwritten kernel retirement

This note tracks the conversion of the old complete-algorithm JavaScript
substitutions into targets for generic bytecode-derived compilation. The
production optimizer must not select a class or method by name. The historical
modules remain opt-in differential oracles through `guestKernelOracles` or
`semanticFusedRasters`; neither option is enabled by default.

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
- ordinary generic configuration: `structuredSsa=true`,
  `guestKernelOracles=false`, `semanticFusedRasters=false`

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

The follow-up pass kept every historical implementation behind its existing
oracle gate and added two bytecode-derived mechanisms:

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
