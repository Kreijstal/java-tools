# Structurally verified affine sprite raster JIT

## Finding

Firefox phase-local timing of moving Dekobloko gameplay identified a nested
column-oriented affine sprite/mask rasterizer as a dominant generated guest
body. Its structured continuation had 283 bytecode instructions, 33 locals,
21 spilled locals, two loops, and two calls to the same integer-division
helper. The continuation repeatedly materialized this state while the outer UI
renderer called the rasterizer more than 20,000 times per second.

The browser canvas upload was not the limiting stage. In the same sessions,
upload averaged about 0.95 ms per presented image. Long synchronous guest
rendering intervals also prevented the guest audio producer from refilling its
WebAudio queue, coupling low gameplay FPS to audible music gaps.

## Historical optimization

The historical `AffineSpriteRasterOracle` replaces the verified guest body
only inside the differential benchmark with one
positional JavaScript kernel:

- Selection uses the complete descriptor, verified CFG and stack depths,
  repeated call/field relationships, and identity-canonicalized bytecode
  fingerprints.
- No guest class, method, or field name participates in recognition.
- Both the original classfile and decompile-then-`javac` layouts are accepted
  as independently audited fingerprints.
- The two `(III)I` calls must resolve to the same verified helper shape.
- Initialized static locations and instance-field slots are bound once while
  their current values remain live.
- A class/debugger guard and complete array/layout preflight run before the
  first destination write. Rejected entries execute the canonical JVM method.
- Runtime counters expose successful runs and guarded fallbacks.

The structured SSA caller feeds the 12 operands positionally, avoiding generic
call dispatch, a child `Frame`, operand-stack materialization, and generator
continuations inside the raster body.

That implementation is now a benchmark-only differential oracle, not a
production compiler tier. It lives in `scripts/oracles/` and the normal
runtime derives the complete method from bytecode through
`JvmSsaBlockRenderer`.
The historical measurements below remain useful as the performance target and
as evidence that this guest body mattered; they are not measurements of the
current production selection policy.

## Generic SSA replacement (2026-07-30)

The exact original classfile was used to compare the current generated
restoring-positional body against `AffineSpriteRasterOracle.runRaster`.
The optimizer does not inspect the guest owner or member name. Four generic
changes close part of the former gap:

- scheduler coarsening is decided per natural loop, so calls in an outer row
  loop no longer force a poll in a call-free inner pixel loop;
- an affine destination index updated by a stable positive static stride gets
  one versioned range guard, with the exceptional slow loop unchanged;
- normal-flow write summaries exclude handler-only exception reporters, which
  permits immutable argument fields and their primitive-array views to be
  loaded once per generated entry; and
- small integer helpers containing a guarded `putstatic`, division, and a
  rethrow-only handler publish the generic restoring scalar ABI. The raster's
  two division calls therefore execute without child `Frame` allocation or
  generic dispatch.

The checked-in benchmark discovers the audited bytecode shape structurally:

```text
node scripts/benchmarkSsaAffineSpriteKernel.js \
  /path/to/original/classes
```

It runs an ABBA sequence for seven rounds, compares the complete destination
checksum every round, and reports paired medians. On Node 26.4.0, 64×64,
3,000 invocations per batch:

| Generated layout | Generic SSA | Oracle | SSA/oracle |
| --- | ---: | ---: | ---: |
| Original classfile | 88,003 ns/invocation | 39,983 ns/invocation | 2.201× |
| Recompiled classfile | 107,184 ns/invocation | 53,869 ns/invocation | 1.990× |

The recompiled measurement uses the original audited shape only to construct
the test data and oracle; the measured target is the 335-instruction
decompile-plus-`javac` method. Both rows are bit exact. The generated original
body reports two loops, four eager entry fields, and a runtime-versioned inner
loop. The remaining roughly 2× gap was primarily the per-load exceptional
bounds branches for computed sprite and mask coordinates. A later generic
recurrence pass now proves the structurally common
`(induction / invariant) * invariant + invariant` index range from its first
and last values. It requires the quotient/product definitions to dominate the
access and the recurrence update to execute on every natural-loop backedge
after the access. Runtime guards reject null storage, division by zero,
integer overflow, excessive trip counts, or either endpoint outside the
array. The rejected arm is the unchanged checked loop.

In the same optimization session, the original-class ABBA harness measured
2.468× before this pass. Three clean post-change processes measured 1.969×,
1.995×, and 2.020×, for a 1.995× median. This is a 19.2% reduction in the
total ratio, or a 32.2% reduction in overhead above the oracle. Every process
produced the exact same complete destination checksum. Absolute times varied
with host load, so the paired ratios inside each ABBA process are
authoritative.

Before the entry-field and scalar-helper changes, the same original-classfile
harness measured a 5.877× SSA/oracle ratio. The final authoritative paired run
measured 2.201×, a 62.5% reduction in relative overhead while retaining exact
JVM exception restoration. An immediately preceding run on a less-loaded host
measured lower absolute times and a 2.440× paired ratio; absolute throughput is
therefore not compared across those processes.

## Correctness

The focused JIT suite contains a deterministic differential over 200 moving,
clipped, masked, dimmed, and destination-blended invocations. It compares
every destination pixel against an independently expressed Java-arithmetic
reference. Separate cases verify floor-division behavior and that source or
destination rejection happens before any write.

Command:

```text
timeout 90s node node_modules/tape/bin/tape test/jitCompiler.test.js
```

Result on 2026-07-28: 746 tests passed.

Both production class layouts were also loaded through the JVM and passed the
complete matcher:

| Layout | Caller fingerprint | Helper fingerprint | Suite fingerprint |
| --- | ---: | ---: | ---: |
| Original classfile | 1773827786 | 1778623157 | 2237033000 |
| Decompile + `javac` | 1163529563 | 182681963 | 1400128061 |

## Firefox measurement

The probe follows the real full-mode path: login, asset/audio startup, Stamina
selection, stage intro, Space to start, ten-second gameplay warmup, and a
15-second moving-gameplay window. Generated-method timing is disabled during
the measurement. It records presented images, WebAudio diagnostics, fast-path
counters, surface hash, and page errors.

Reproduction identity:

| Item | Value |
| --- | --- |
| java-tools base commit | `b70840200e76c9a135ac3df4b8c05c215b220266` |
| Dekobloko JAR SHA-256 | `a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e` |
| Firefox | 146.0.1, Playwright Firefox build 1509 |
| Node.js | 26.4.0 |
| Viewport | 1000 × 800 |
| Optimizer gates | renderer pipeline, scalar loops/bodies, fused regions, structured SSA |
| Runtime mode | full mode, production bundle, real audio |
| Tree state | dirty; only the files listed in this change belong to this experiment |

Initial same-bundle A/B:

| Configuration | Bundle SHA-256 | Presented | FPS | Raster runs | Fallbacks | Errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Disabled | `71ab8c2366663b05ca33f9356489e67b706e3fca18fbc90e4a1dd201e51436e7` | 185 | 12.32 | 0 | 0 | 0 |
| Enabled | `71ab8c2366663b05ca33f9356489e67b706e3fca18fbc90e4a1dd201e51436e7` | 289 | 19.24 | 347,944 | 0 | 0 |

This is a 56.1% increase in presented gameplay FPS. During the enabled
15-second window, audio recorded one 37 ms underrun. The disabled control
recorded one 70 ms underrun. Startup underruns are cumulative and are kept
separate from the gameplay-window deltas.

A later allocation-reduced bundle,
`472477855b32e59e0148bd5dcf6d25eefd37a5c147e18349df051cb5cdf8df35`,
keeps the same semantic proof and differential coverage. Its three clean
enabled runs measured 18.51, 21.76, and 21.58 FPS: a **21.58 FPS median**.
Every run had zero guarded fallbacks and zero page/runtime errors. Gameplay
audio-gap deltas were 108, 75, and 38 ms (75 ms median). Run-to-run game timing
varies, which is why the median is retained instead of a single displayed-FPS
sample.

The deployed follow-up bundle is
`46ac49fb43d26a01a34e211beb3fd6867d3a4792114ab2d40fcea0b7248fb355`.
Relative to the measured bundle, it only adds a pre-write integer-overflow
proof and deduplicates cold dependency owners; the median above remains
attributed to the exact measured `472477…` artifact.

## Remaining bottleneck

The optimization is worth retaining, but 18–19 FPS is not the 30 FPS target.
It removes one large child body; the outer `qc`/UI scene family still owns the
remaining frame time. The next profiling pass should run after this fast path
is enabled, then target the new phase-local exclusive-time leader. Audio should
continue to be judged by underrun duration during the same gameplay window:
optimizing WebAudio conversion will not repair gaps caused by a long
synchronous renderer interval.

## Continuous WebAudio correction

A later remote session confirmed the rendering result at 47–51 FPS but
reported corrupted, rather than merely interrupted, audio. Telemetry separated
the two cases: the audio queue remained near 0.79 seconds and underrun totals
were often unchanged for tens of seconds.

The browser bridge had represented every 256-frame 22.05 kHz
`SourceDataLine.write` as a separate `AudioBufferSourceNode`. Firefox therefore
had to restart its 22.05 kHz to device-rate conversion roughly 86 times per
second for each active output. A Java `SourceDataLine` is one continuous PCM
stream, so those artificial resampler boundaries were incorrect.

The bridge now coalesces adjacent guest writes into capacity-aware continuous
regions while counting staged PCM in `available()`:

- the 65,536-byte stereo music line uses 2,048-frame regions;
- the 8,192-byte effects line uses 512-frame regions;
- an incomplete short effect is scheduled after at most 100 ms;
- `flush`, `drain`, and `close` account for staged data explicitly; and
- telemetry reports the negotiated format, guest writes, scheduled buffers,
  removed boundaries, boundary jumps, saturation, and queued staged frames.

The first real-mixer probe with fixed 2,048-frame regions verified 22,050 Hz,
stereo, signed 16-bit little-endian PCM, reduced 8,998 guest writes to 1,111
WebAudio buffers, recorded no saturated samples, and added zero underruns in
the moving-gameplay window. The capacity-aware follow-up prevents the smaller
effects line from retaining a partial sound indefinitely.
