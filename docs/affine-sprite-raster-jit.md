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

## Optimization

`HandwrittenAffineSpriteRaster` replaces the verified guest body with one
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
- `JVM_DISABLE_AFFINE_SPRITE_RASTER=1` or JIT option
  `affineSpriteRaster: false` provides a same-bundle differential control.
- Runtime counters expose successful runs and guarded fallbacks.

The structured SSA caller feeds the 12 operands positionally, avoiding generic
call dispatch, a child `Frame`, operand-stack materialization, and generator
continuations inside the raster body.

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
