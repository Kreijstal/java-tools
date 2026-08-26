# Firefox GeoBlox performance investigation

This log records measured hypotheses so unsuccessful optimizations are not
repeated. GeoBlox names below identify profile locations only. Runtime policy
and optimizations must remain structural and game-independent.

## Measurement rules

- Classes are the same 353 class files produced by `javac.js`.
- HotSpot and browser comparisons use those same class files.
- Browser tests run through the Git-cloning page and its cloned `jvm.js`.
- The main menu is visually confirmed before clicking Instructions.
- A run samples 30 one-second windows after the click.
- Idle windows are excluded. Transition work is not idle and remains part of
  the floor measurement.
- Average FPS cannot establish success when active valleys remain below the
  target. The current target is a 10 FPS non-idle floor.

## Established evidence

The Java workload is not inherently a 2--5 FPS workload. HotSpot presents
approximately 149--151 frames per second with the same `javac.js` classes.
Its CPU profile is dominated by useful raster work:

- `dm.b([I[IIIIIIII)V`: 67.03% self time
- `dm.a([I[IIIIIII)V`: 8.94% self time
- `vb.c()V`: 5.08% self time

The original Chromium browser profile instead spent 52.2% in JVM
dispatch/scheduling and 29.4% in generated guest JavaScript. Canvas upload was
only about 441 ms over 30 seconds and was not the primary bottleneck.

Keeping imported-array raster loops and their same-class wrappers in
JavaScript improved Chromium from 5.09 to 18.24 FPS, with a measured 10.94 FPS
active floor. Firefox does not optimize the same generated code nearly as
well.

The Firefox Instructions screen was visually confirmed. Its initial overlay
showed about 2.2 FPS. The best retained 30-second run currently measured 5.06
FPS average, with late windows around 7.7--8.95 FPS and a 0.98 FPS transition
floor. This is not considered fixed.

## Retained changes

| Commit | Result | Reason retained |
| --- | --- | --- |
| `0cc3471` | Chromium 5.09 -> 7.88 FPS | Avoids Wasm-to-JS crossing for every imported array element. |
| `f4c97e6` | Chromium 7.88 -> 16.94+ FPS | Keeps a wrapper and its raster callee in one JS locality chain. |
| `a7dcb21` | Firefox average approximately 3.50 -> 4.66 FPS in its measured run | Gives the AWT producer a bounded structured quantum instead of repeatedly reconstructing a slow frame. |
| `1059a0f` | Firefox approximately 3.63 -> 4.29 FPS | Recognizes the structurally verified javac.js transparent-blit lowering. |
| `2b7052f` | Firefox approximately 4.29 -> 5.06 FPS | Replaces redundant per-row bounds validation with an equivalent constant-time proof, retaining an overflow fallback. |

The transparent intrinsic is genuinely active. One measured run recorded
16,479,272 successful calls and zero slow-path fallbacks. This call count marks
the hot execution location; it does **not** prove the Java game performs
unnecessary work, because HotSpot runs the same workload quickly.

## Rejected hypotheses and experiments

| Hypothesis or experiment | Measurement | Conclusion |
| --- | --- | --- |
| Canvas upload/presentation is the 75x cause. | Chromium upload consumed about 441 ms of a 30-second profile. | Rejected. Rendering computation and runtime overhead dominate. |
| Full graph fusion into Wasm must be faster. | Firefox/Chromium profiles showed Wasm crossing into JS for Java-array accesses; an experimental fused path increased the worst gap. | Rejected for ordinary JS-backed primitive arrays. Bytecode coverage is not execution locality. |
| Force Firefox raster chains back to ready Wasm. | JS-locality A/B: 3.50 FPS average. Partial live Wasm control: 3.72. Clean reload with Wasm policy: 1.42 average, 0.98 floor. | Rejected. The partial live switch did not invalidate already-linked JS callers and was misleading; the clean reload is authoritative. |
| Enable the existing linear Wasm array heap in browsers. | Typed arrays with the JS path: 3.52 average, 0.99 floor. Direct heap-backed Wasm: 1.52 average, 0.98 floor. A 64 MiB trial also exhausted the heap and exposed a browser-only `process.stderr` bug. | Rejected and fully reverted. Direct array loads do not repair Firefox's slow structured-Wasm body. |
| The opaque int-array blit is the remaining Firefox limiter. | Direct opaque-blit experiment: 4.75 average versus the 5.06 retained baseline, same 0.98 floor. | Rejected and reverted (`ea880b4`, reverted by `dd937c2`). HotSpot share did not translate into a Firefox improvement. |
| Generated JavaScript `try/catch` around transparent blits prevents SpiderMonkey optimization. | Exception-status experiment: 3.97 average versus 5.06 baseline. Floor was 1.96, but sustained throughput regressed. | Rejected and reverted (`856f54e`, reverted by `e93da9c`). |
| The workload itself explains Firefox performance. | HotSpot runs the identical class files at approximately 150 presentations/second. | Rejected. The problem is runtime cost per unit of useful work, not merely the existence of the work. |
| A presented-frame threshold alone identifies Instructions. | Captured canvas at 500 presentations was the main menu; after the click, a second capture confirmed Instructions. Some early profiles also included transition asset work. | The threshold is valid only together with visual/state confirmation. |

## Transition valleys

Entering Instructions performs lazy archive/cache reads, decoding, sprite
construction, and first-use compilation on the producer/UI thread. Measured
examples include `pk.e`, `ji.a`, `uh.a`, and `ua.c`, with uninterrupted
activations around 115--289 ms. This work is non-idle and must count against the
floor. Moving generic compilation preparation earlier is acceptable, but game
Java sources must not be modified and asset work must not be guessed away.

## Current direction

The remaining investigation should compare Firefox's cost per transparent
blit against V8 and HotSpot while separating:

1. intrinsic body time;
2. generated caller and positional-call overhead;
3. array representation/access cost;
4. transition-only archive/decode work; and
5. frame-production work versus presentation coalescing.

Do not reintroduce the rejected Wasm-heap, forced-Wasm, opaque-blit, or
exception-status experiments without new evidence that changes their measured
premises.
