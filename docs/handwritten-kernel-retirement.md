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
