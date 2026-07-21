# Dekobloko in Firefox: correctness and performance field notes

This document records the investigation that made the Dekobloko gamepack boot
and improved its Jagex-logo animation in the browser JVM. It is deliberately a
lab notebook as well as a description of the final code: the rejected ideas and
measurement traps are here so that a future optimization pass does not repeat
them.

The results below were obtained on 2026-07-20 with Firefox/SpiderMonkey, an
800x600 software canvas, and `dekobloko.jar` served from a test page listening on
`0.0.0.0:3765`. The initial optimized baseline was JVM revision `ab3769b`; the
later results described below include the follow-up field-site and generated-call
changes. Absolute timings depend on the machine and Firefox build; comparisons
are useful only with the same JAR, bundle, browser, probe window, and host load.

## Executive synthesis

The investigation supports five high-confidence conclusions:

1. **Dekobloko is not slow because browser canvas upload is intrinsically
   slow.** An 800x600 JavaScript raster plus upload takes only a few
   milliseconds, and dirty-driven AWT publication is likewise a small share.
2. **The expensive work is the large guest geometry/raster control-flow graph.**
   It performs thousands of triangle submissions per changed image and mixes
   branches, fields, arrays, integer arithmetic, and calls. Executing those
   features through JVM-shaped stacks, frames, helpers, and tier boundaries is
   much more expensive than the underlying pixel arithmetic.
3. **Complete regions are fast; partial regions are often slow.** Whole-method
   generated JavaScript and complete numeric Wasm can both perform well.
   Repeated JavaScript/Wasm exits, unresolved dynamic calls, frame creation, and
   operand materialization can erase that advantage.
4. **Structural scalarization is the largest demonstrated renderer win.**
   Compiling the model/face body, wrapper, raster, and scanlines as scalar
   regions raised the matched Firefox result from 8.82 to 13.19 changed
   images/s. This remains below the 20 images/s acceptance threshold, so the
   broad paths are opt-in.
5. **Structured control flow pays; narrow local caching does not.** Basic-block
   SSA was neutral and a cross-block guarded field cache regressed, while the
   new structured SSA block renderer improved its final median by 6.10%. Its
   remaining limitation is coverage of the complete model/face body, not a need
   for more runtime checks on individual reads.

### What the hot guest body actually contains

Offline structural inspection found a 593-item model/face method with 525
normally reachable instructions, maximum operand-stack depth 18, 53 branches,
76 array operations, 43 field operations, 22 integer-array loads, and 22
rethrow/reporting handlers. Its two dominant natural loops perform vertex
transformation and per-face clipping/render selection. The body uses:

- integer and reference locals, including locals reused across CFG joins;
- `int[]`, `short[]`, reference-array loads, checked stores, and array lengths;
- initialized static lookup tables and instance model arrays;
- overflow-sensitive integer multiply/add/shift/divide/remainder operations;
- null, bounds, arithmetic, and explicit-throw exception points;
- static wrapper/raster calls and small integer/native helpers; and
- obfuscator/reporting paths that are normally cold but remain semantically
  observable when an exception occurs.

These facts—not the obfuscated owner or method name—drive compiler eligibility.
Optimizers may use descriptors, verified CFG/stack shapes, constant-pool method
identity, class initialization state, field flags, and observed monomorphic
targets. They must never contain a game method-name allowlist.

### Current tier and configuration status

| Facility | Default | Why |
|---|---|---|
| Generated whole-method JavaScript | enabled | Best general Firefox tier when the complete supported body stays in JS |
| Small handler-free scalar integer loops | enabled | Large repeatable synthetic gain with exact safe-point restoration |
| Array/field/call guest-body scalarization | disabled | Correct and faster, but only reaches about 13 images/s |
| Fused wrapper/raster regions | disabled | About 20% faster alone, but below the absolute acceptance target |
| Basic SSA companions/value numbering | disabled | Correct but neutral in the final A/B |
| Structured SSA block renderer | disabled | Correct and +6.10%, but misses the complete hot body and 20 images/s target |
| Cross-block guarded field cache | removed | Final counter-free A/B regressed by 2.13% |
| Partial numeric Wasm | available | Excellent for complete numeric loops; poor when imports/exits dominate |

Experimental controls are `JVM_ENABLE_SCALAR_GUEST_BODIES=1`,
`JVM_ENABLE_FUSED_REGIONS=1`, `JVM_ENABLE_SCALAR_SSA=1`, and
`JVM_ENABLE_STRUCTURED_SSA=1`, with corresponding browser probes
`PROBE_SCALAR_LOOPS=0/1`, `PROBE_FUSED_REGIONS=0/1`,
`PROBE_SCALAR_SSA=0/1`, and `PROBE_STRUCTURED_SSA=0/1`.
`JVM_ENABLE_RENDERER_PIPELINE=1` or `PROBE_RENDERER_PIPELINE=1` enables broad
scalar guest bodies, fused renderer regions, and structured SSA as one composed
configuration; explicit component probe switches are applied afterward and can
override it for an A/B.

### Accepted and rejected results at a glance

| Experiment | Result | Decision |
|---|---:|---|
| Cached generated field sites | about 5.33 → 7.14 images/s | retained |
| Direct generated-call argument transfer | 7.14 → 7.64-7.90 | retained |
| Dirty-driven AWT presentation | about 8.05; removed artificial polling ceiling | retained |
| Fused wrapper/raster family | 8.05 → 9.68 median | opt-in; below 20 target |
| Full scalar guest body plus fused raster | 8.82 → 13.19 | opt-in; largest renderer result |
| Scalar fixed CFG join slots | about 12.00 → 13.05 | retained within experimental tier |
| Direct scanline emission | 13.05 → 13.19 | retained within experimental tier |
| Scalar `sp` alone / local clearing / wrapper-only work | neutral | no isolated win claimed |
| Direct call-stack push/pop removal | neutral | removed |
| Basic-block SSA/edge threading | 12.6299 → 12.6314 median | opt-in infrastructure only |
| Cross-block guarded field cache | 13.3291 → 13.0458 median | removed |
| Structured SSA block renderer | 8.6354 → 9.1619 median | opt-in; +6.10%, incomplete hot-body coverage |
| Forward-branch integer leaf inlining | toy faces 315.13 → 11.85 ns/element median; Firefox pipeline 13.33 images/s median | retained; still below 20 images/s |
| More yielding, speculative JIT batching, blanket `run()` JIT | neutral or unsafe | removed/rejected |

## 2026-07-20 breakthrough: compile the guest body, not just its leaves

The largest result of this investigation came from compiling the renderer's
model/face caller as one scalar guest region. Previous work made individual
field accesses, calls, wrappers, rasters, and scanlines cheaper, but left the
large caller moving values through the generic JVM operand stack at every
branch. The new verifier keeps locals and CFG join values in JavaScript scalars
across the complete loop and reconstructs JVM state only where it is observable:
calls, exceptions, debugger entry, returns, and bounded scheduler safe points.

This is not an application-method special case. The compiler never selects the
obfuscated class or method names. Eligibility comes from the method descriptor,
verified CFG and operand-stack depths, supported opcode structure, resolved
field/call targets, and proof that exception handlers only report and rethrow.
The important Dekobloko features were:

- a 525-instruction normally reachable body with 53 branches;
- 76 array operations, including `int[]`, `short[]`, reference loads, and
  checked stores;
- 43 instance or static field operations;
- nested vertex and face loops with reference and integer locals; and
- repeated calls into the two structurally verified wrapper/raster families.

On the same production bundle and Firefox build 1509, the progression was:

| Configuration | Changed images/s | Change from 8.82 baseline |
|---|---:|---:|
| Existing generated implementation | 8.82 | — |
| Scalar model/face guest body | 10.43 | +18% |
| Scalar caller plus wrapper/raster fusion | 12.00 | +36% |
| Fixed scalar CFG join slots | 13.05 | +48% |
| Scanlines emitted inside raster kernels | 13.19 | +49% |

All measured runs retained an expected initial surface hash (`4025147891` or
`4136367231`) and reported no page or runtime error. The live differential
harness also matched every pixel for 200 gradient and 200 flat-color renderer
invocations. The optimizer did uncover one real JVM semantic trap:
`array[index++] = value` pushes the old index before executing `iinc`; a scalar
local reference is therefore incorrect unless the load is snapshotted. That
ordering now has a dedicated regression test.

This is a substantial steady-state breakthrough—roughly 49% over the matched
baseline—and strong evidence that repeated operand-stack traffic across the
large guest CFG was expensive. It is not the final performance target: 13.19 is
still below the required 20 changed images/s and well below the approximately
50 images/s Java reference. In accordance with the acceptance rule, the broad
array/field/call scalar tier and fused renderer remain opt-in. See
[Array/field guest-body scalarization](#arrayfield-guest-body-scalarization) for
the implementation stages, rollback decision, and reproduction details.

## TeaVM comparison and SSA experiment

TeaVM's useful lesson is not simply "emit Wasm." TeaVM is an ahead-of-time,
closed-world compiler, and its optimization pipeline first devirtualizes and
inlines calls, then repeatedly runs SSA-oriented passes such as loop-invariant
code motion, global value numbering, redundant field-read elimination, scalar
replacement, unreachable-code removal, and redundant-phi elimination. Its
ordinary JavaScript backend reconstructs reducible CFGs as structured loops and
conditionals; suspendable methods retain a state-machine representation. See
TeaVM's [overview](https://teavm.org/docs/intro/overview.html),
[optimization pipeline](https://github.com/konsoletyper/teavm/blob/ecb74c079080e6829cafc5f5a23a880289dc8038/core/src/main/java/org/teavm/vm/TeaVM.java#L660-L865),
[structured decompiler](https://github.com/konsoletyper/teavm/blob/ecb74c079080e6829cafc5f5a23a880289dc8038/core/src/main/java/org/teavm/ast/decompilation/Decompiler.java#L170-L225),
and [array unwrap motion](https://github.com/konsoletyper/teavm/blob/ecb74c079080e6829cafc5f5a23a880289dc8038/core/src/main/java/org/teavm/model/optimization/ArrayUnwrapMotion.java#L25-L62).

The browser JVM cannot copy those assumptions wholesale: classes initialize at
runtime, snapshots preserve the live object graph, debugger and scheduler exits
must reconstruct exact frames, and dynamic dispatch can change after code was
compiled. The first guarded adaptation therefore remains generic and
method-name-independent:

- reference values carry an SSA companion for the raw array storage, avoiding a
  repeated wrapper-versus-plain-array test at each verified load/store;
- local value numbering removes repeated field and array-length reads inside a
  basic block, with calls and block boundaries acting as conservative memory
  barriers;
- verified fall-through CFG edges flow directly into the next generated block
  instead of assigning `pc` and redispatching through the switch; and
- deoptimization, throwing bytecodes, calls, and safe points continue to
  materialize the canonical array object, JVM locals, operand order, and exact
  bytecode PC. Raw array views are generated-function temporaries and are never
  serialized.

The pass is controlled by `jit.scalarSsaOptimizations` or
`JVM_ENABLE_SCALAR_SSA=1`; the Firefox probe accepts
`PROBE_SCALAR_SSA=0/1`. It is off by default because the matched production
measurement was neutral:

| Same-bundle Firefox runs | Samples (changed images/s) | Median |
|---|---|---:|
| SSA off | 11.8783, 12.9016, 12.6299 | 12.6299 |
| SSA on | 12.6314, 12.5028, 13.0439 | 12.6314 |

That first pass was a **+0.01%** median change, well inside run variance. It
recorded 240 array-view sites and 382 threaded edges, but only one safely
eliminated repeated read. Basic-block value numbering was therefore too narrow.

The follow-up experimentally added cross-block memory SSA for non-volatile
fields whose receiver was a local proven stable for the method. Each symbolic
field/receiver pair received a lazy scalar cache; unknown calls and static writes
advanced a memory version, while volatile fields were never cached. The first
three-run sample appeared positive, but a frozen rerun was neutral. Removing a
hot diagnostic counter and repeating the complete A/B showed a regression:

| Same-bundle Firefox runs | Samples (changed images/s) | Median |
|---|---|---:|
| Cross-block memory SSA off | 11.8862, 13.3291, 13.4854 | 13.3291 |
| Cross-block memory SSA on | 12.9054, 13.0458, 13.3332 | 13.0458 |

The final **-2.13%** median result rejected the runtime cache. Instrumented runs
had shown about 2.3 million hits, so the failure was not lack of reuse: the
version/object guards cost more than the cached field helper calls saved. All
six final runs began with surface hash `4025147891`, reported no page/runtime
errors, and used the same production bundle, JAR, Firefox build, stride, and
20-image window. The runtime cache was removed; the volatile-read safety test
and these results remain as guidance for a future true SSA/structured compiler.

The broad guest-body and SSA tiers remain opt-in. The later structured SSA block
renderer completed the reducible-CFG step and demonstrated a +6.10% isolated
median and +7.54% composed median; see
[structured JVM SSA block renderer](#2026-07-20-structured-jvm-ssa-block-renderer).
The next issue is extending that compiler to the complete hot body without
reintroducing call/materialization overhead. Merely growing partial Wasm modules
would still pay JavaScript-heap and scheduler boundary costs; TeaVM's Wasm
backend has a typed closed-world object/vtable model that this runtime does not
yet share.

### Latest intermethod benchmark: what should and should not become Wasm

`npm run benchmark:jvm:intermethod` runs the same 50,000-iteration primitive
loop as a monolith, through eight static helpers, and through virtual and
interface forwarding. The 2026-07-20 five-round median was:

| Shape | HotSpot ns/iteration | Generated JS | Current Wasm path |
|---|---:|---:|---:|
| monolith | 4.88 | 11.61 | 5.45 |
| eight static calls | 4.84 | 7.30 | 344.50 |
| virtual | 4.83 | 178.72 | 48,484.33 |
| interface | 4.83 | 179.34 | 49,158.02 |

Checksums matched across every tier. Complete numeric Wasm is only about 12%
slower than HotSpot in this microbenchmark. Generated JavaScript also handles a
fully collapsed static chain well. The current Wasm static-call result is slow
because it is a partial region, and virtual/interface cases never become a
complete Wasm region at all. Their interpreter/tier exits are orders of
magnitude more expensive than the arithmetic.

The decision rule is therefore:

- use Wasm when the complete hot loop, its linked callees, and required memory
  access can remain inside one module invocation;
- use generated JavaScript when the heap is still represented as JavaScript
  objects/arrays or calls frequently need JVM services;
- add guarded devirtualization only when a runtime-type/method-identity guard
  can enter a complete compiled target and fall back before side effects; and
- do not “slowly fatten” partial modules without measuring boundary frequency.
  Larger modules help only when they remove exits, imports, conversions, frame
  materialization, or dynamic dispatch.

TeaVM can make stronger Wasm decisions because its AOT closed world provides a
typed heap, vtables, and restricted dynamic loading/reflection. Reproducing that
advantage here eventually requires either a typed/linear JVM heap or a batched
region interface; it is not a local emitter toggle.

### Snapshots, debugging, scheduling, and exceptions

Optimization temporaries are deliberately not part of the portable JVM state.
The saved state contains canonical Java objects and arrays, Java locals, operand
stacks, PCs, monitors, threads, and relative timing state. Generated JavaScript,
Wasm modules, inline caches, raw array views, scalar join values, and compiled
functions are rebuilt after loading.

This imposes hard rules on every optimized region:

- a raw array view may be cached in a generated local, but the frame must
  materialize the original Java array reference;
- every throwing operation must retain the exact bytecode PC and JVM operand
  order, including null, bounds, divide-by-zero, cast, call, and explicit throw;
- omitted inlined/fused frames must be reconstructed outer-to-inner before the
  normal exception dispatcher runs;
- a caught exception resumes in the interpreter rather than re-entering a
  partially completed optimized region;
- debugger mode, breakpoints, tracing, or an unsupported scheduler state must
  fall back before the first optimized side effect;
- class initialization must be complete before a direct static-field or method
  fast path executes; and
- long regions retain bounded safe points. The model/face design should keep a
  safe boundary between faces even if the interior becomes structured code.

The portable save-state tests prove that heap identity, cycles, shared arrays,
typed arrays, boxed strings, monitor wait sets, frame references, `BigInt`
values, file metadata, and deterministic execution survive restoration. JIT
changes must keep `test/saveState.test.js` green even when their optimized
temporaries never appear in the serialized graph.

## What was fixed

The work has four distinct layers. Keep them separate when diagnosing a
regression: a white screen, slow cold start, and slow animation had different
causes.

1. **Decompiler soundness (`7403bb5`)**: a split local's seed must survive a
   conditional store when the store does not dominate a later join. Linear
   instruction order is not dominance. This was the underlying lesson from
   Dekobloko issue #25 and the `String.length()J` symptom.
2. **Browser execution (`9e18746`, `5828d49`)**: targeted JRE overrides must
   fall back to application bytecode for unoverridden methods, and the browser
   bundle must preserve native async functions. Otherwise arguments remain on
   the JVM operand stack or the JIT silently loses its `AsyncFunction`
   constructor.
3. **Scheduler/dispatch (`65e16b3`, `acf4fdd`)**: cache synchronous handlers on
   shared code items, do not spin zero-delay tasks while all Java threads are
   parked, and let warm async-capable handlers continue within a bounded
   interpreter quantum when they complete synchronously.
4. **Firefox JIT runtime (`ec50265`, `e52f292`, `ab3769b`)**: prefer one
   generated-JS tier over frequent partial-Wasm/JS crossings, compile warm call
   islands synchronously, fuse straight-line generated bytecodes, reuse child
   frames, structurally recognize small raster helpers, and compile the two hot
   integer raster shapes without generic operand-stack traffic.

The measured Firefox logo-animation rate progressed from approximately
**1.4-1.5 changed frames/s**, through **4.4-4.6 changed frames/s**, to about
**5.3-5.4 changed frames/s** at `ab3769b`, then **7.14 changed frames/s** with
cached generated field sites, and finally **7.64-7.90 changed frames/s** after
removing generated-call argument shuffling. This is a changed-image throughput
measurement, not the browser's `requestAnimationFrame` presentation rate. The
corresponding interval-based rate has 19 intervals and is slightly lower; the
probe reports both values.

After replacing the temporary harness's fixed 100 ms canvas poll with
dirty-driven AWT presentation, a final run measured **8.05 changed images/s**
and 7.65 transition intervals/s. The presentation change is primarily a
correctness and latency fix; treat the small throughput difference from the
7.64-7.90 band as normal run variance unless repeated measurements establish
otherwise.

Cold time remained roughly 52-54 seconds in the final headless test. That was
accepted because the product decision was to prioritize sustained runtime speed
over cold-start parity. Do not reject a runtime optimization solely because it
adds compilation time before the animation.

For scale, two instrumented Java 8 reference runs produced changed software
frames at roughly the display cadence (about 50 frames/s during the continuous
logo section). The JVM.js result is therefore improved, not yet native-speed or
fully playable.

## The issue #25 correctness lesson

`splitTypedReusedLocals` originally reasoned too much from linear bytecode. A
later store can appear before a join in the class file while being conditional
in the control-flow graph. It therefore does not necessarily kill the earlier
definition on the path that skips the store.

The safe rule implemented in `7403bb5` is:

- compute whether the split definition reaches any load that will not be
  rewritten;
- preserve a copy in the original local when it does; and
- allow conservative callers to reject the split entirely with
  `skipIfReachesUnrewrittenLoad`.

This generalizes beyond local splitting. Dead-code elimination and constant
evaluation must prove facts over CFG paths. A write after a definition in file
order is not a proof that the write dominates every use, and a value observed on
one predecessor is not automatically constant at a join. When a transformed
game fails later in an apparently ordinary JRE method, first verify stack/local
provenance at the call site; the JRE error can be only the first visible symptom
of earlier bytecode corruption.

## Browser and bundler lessons

### A targeted JRE override is not ownership of the whole class

An `applicationFallback` JRE entry augments an application class. If an
`invokestatic` is not implemented by the override, normal application method
resolution must still run. Returning early as if the whole class were a JRE
stub leaves call arguments on the operand stack and corrupts subsequent
execution. Class initialization must likewise load the application's bytecode
for these augmented classes.

The expanded unsupported-invoke diagnostic now includes declared class, caller,
descriptor, and PC. Preserve that context; `Unsupported invokevirtual:
java/lang/String.length()J` alone was not enough to locate the corrupting call
site.

### Babel can change runtime feature detection

The production-only white/black-screen difference was not evidence that Babel
itself was needed for JVM execution. The old generic `@babel/preset-env` target
lowered async functions to ordinary Promise-returning functions. Two runtime
checks then became unsound:

- `func.constructor.name === "AsyncFunction"` no longer identified async
  instruction handlers; and
- the JIT's dynamic `AsyncFunction` constructor probe no longer returned the
  native constructor, silently disabling generated bodies containing `await`.

`config/browser-babel.js` now targets browsers already new enough for the JVM's
WebAssembly and BigInt requirements, which preserves native async functions.
There is also an explicit async-opcode set in dispatch; constructor-name
reflection is retained only as a secondary guard. Any future bundler change must
run `test/browserBundleConfig.test.js` and inspect the production bundle, not
only unbundled Node tests.

## Runtime changes that paid off

### Reduce interpreter scheduling and dispatch overhead

`prepareSyncInstructions` resolves handlers and expands `wide` once per shared
method body. Non-enumerable Symbols keep this cache out of serialization and
debugger displays. The hot interpreter loop calls the cached handler rather than
performing string lookup and classification for every bytecode.

When all Java threads are sleeping or waiting, the scheduler sleeps until the
nearest deadline, capped by `eventLoopYieldMs`, rather than posting a zero-delay
task continuously. Deterministic/fake clocks retain zero-delay behavior.

Async-capable bytecodes such as warmed `getstatic` frequently take no async path.
After awaiting their handler, the bounded quantum can continue if the current
frame, thread status, and call stack still permit it. Calls, sleeps, waits,
blocking operations, instrumentation, debugger mode, and the quantum limit still
stop execution at safe boundaries.

### Cache generated field access sites

The direct-JavaScript ceiling experiment exposed another large source/JVM gap:
generated `getfield` and `getstatic` originally repeated descriptor unpacking,
class-hierarchy walking, field-key discovery, and map lookup for every access.
The logo model loop performs these operations for every vertex and face.

Generated code now registers field sites at compile time. An instance site
caches the resolved owner slot per runtime type; a static site caches the
declaring class's field map and key while still checking class initialization on
every access. In the checked-in Node microbenchmark, cached instance reads
improved from about 16.0M to 82-89M accesses/s and inherited static reads from
about 10.1M to 73-75M/s on the validated host.

In Firefox, this raised the 20-image logo measurement from 5.33 images/s to
7.10, 6.98, and finally 7.14 images/s, about a 34% improvement at the best
matched run. The expected logo and final surface hashes remained present.
Inlining array helper checks afterward measured 7.06 images/s, which was
neutral, so that experiment was removed.

### Keep Firefox in one engine tier when possible

SpiderMonkey performed poorly when a hot method repeatedly crossed from partial
Wasm into JavaScript and back. Firefox therefore defaults
`preferWholeMethodJs` to true. A whole generated JS method is selected before a
partial Wasm region when both are possible. This intentionally trades cold
compile time for lower steady-state transition cost.

An experiment forcing the opposite policy measured about 4.24 changed frames/s
against about 4.38 for whole-method JS at that point in the investigation. The
numbers are noisy, but the tier-crossing result was repeatable enough to retain
the Firefox-specific default.

### Make generated calls truly synchronous on the hot path

Generated methods can now be ordinary `Function` bodies when their structure is
synchronously compilable. Their invokes use registered call-site IDs with a
target cache. Warm static fields, casts, object allocation, and eligible callees
avoid Promise/`await` machinery.

For nested generated calls, a cached child `Frame` is reset and reused. Short
integer-only leaves are emitted as JS expressions. Structurally guarded
intrinsics cover:

- an integer array-copy shape;
- packed-color scanline `(IIIIIII[III)V`; and
- constant-color scanline `(IB[III)V`.

These are recognized from bytecode structure and constants, not application
class names. Every intrinsic retains Java null, bounds, overflow, shift, and
class-initialization behavior or falls back to normal invocation.

Registered call sites and field sites use integer-indexed arrays rather than
maps. A generated call copies arguments directly from the caller's existing
operand array into the recycled child locals; it does not build an argument
array with repeated `unshift` and then pop every source operand. Recycled locals
are cleared only while debugger or breakpoint checks are active. Verified
bytecode cannot read a non-parameter local before storing it, so erasing all 43
locals on every `oj` triangle invocation was redundant during normal play.

The direct argument transfer moved repeated Firefox measurements from 7.14 to
7.64 and 7.90 changed images/s. A subsequent no-local-clear run measured 7.69,
inside the same band; treat the local clear as removed work, not as a separately
demonstrated FPS gain.

### Fuse generated basic blocks

Straight-line bytecodes fall through adjacent `switch` cases instead of writing
`pc` and redispatching after every instruction. The operand-stack pointer is a
scalar `sp`; `stack.length` and exact `frame.pc` are materialized only at a call,
throw/deopt point, debugger check, control-flow edge, or return.

Scalar `sp` by itself was essentially flat in measurement (about 4.38 changed
frames/s in the relevant A/B run). It remains useful infrastructure because it
lets larger generated blocks avoid repeated `Array.push`, `Array.pop`, and
`length` traffic. Do not cite it as an isolated FPS win.

### Stackless hot raster generation

`compileStacklessIntegerRaster` is intentionally narrow. It recognizes exact
descriptors plus substantial structural evidence before selecting the special
compiler:

- raster: `a(IIIIIIIBIIII[IIIII)V`, large integer body, many loads/stores, and
  repeated packed-scanline calls;
- wrapper: `a(IIIIIIIIIIIIZIII)V`, wrapper-sized integer body with repeated
  raster calls.

Within each basic block it represents the JVM stack as generated JS expressions
and eager scalar temporaries. Stack state is materialized at branches, calls,
deoptimization, debugging, quantum exits, and returns. The raster can call the
packed-color implementation directly after a structural and initialized-class
guard; otherwise it takes the generic synchronous call path.

This final step raised the observed logo-animation rate from the mid-4s to about
5.3-5.4 changed frames/s.

## Correctness traps in stackless code generation

These bugs produced plausible images before failing, so smoke testing alone is
not enough.

### Capture local loads eagerly

Never leave a pending stack expression as `locals[n]`. If an `iinc` or store
changes that local before the expression is consumed, evaluating it later uses
the new value rather than the JVM value loaded earlier. Emit a scalar temporary
at each local load that can outlive the instruction.

### Capture block-entry stack values before resizing the array

An expression such as `stack[k]` is not a value snapshot. If generated branch
code sets `stack.length = 0` before evaluating a condition that still references
`stack[k]`, the condition observes `undefined`. Load block-entry values into
temporaries before any stack materialization or truncation.

### Class initialization is observable

A direct `invokestatic` fusion may run only when the owner is already
`INITIALIZED`. The cold path must go through ordinary invocation so `<clinit>`,
thread ordering, exceptions, and retry behavior are preserved. Structural
recognition of the callee is not permission to skip class initialization.

### Preserve deoptimization state exactly

At every unsupported opcode, asynchronous callee, debugger entry, or quantum
boundary, materialize locals, stack depth/content, and the correct resume PC.
Transient deoptimization must set `jitSkipOnce` when immediate re-entry would
repeat the same exit.

## Experiments that did not pay off

Keep the negative results visible. They were tested and removed rather than
forgotten.

- **More yielding was not the Firefox bottleneck.** The logo was CPU/dispatch
  bound once actual rendering began. Adjusting event-loop yield frequency did
  not explain the four-times browser gap. Yielding is still required for DOM,
  input, audio, timers, debugger operation, and Java thread fairness.
- **Web Workers were not a free fix.** JVM state, Java threads, and the software
  canvas are shared mutable structures, while DOM/canvas presentation remains
  on the main thread. A worker design would require copying, atomics, or RPC at
  synchronization points. No evidence showed that this overhead would beat
  reducing dispatch inside one thread, so it was not implemented.
- **Mapping Java threads directly to Web Workers is a runtime redesign, not a
  scheduler toggle.** The current heap consists of ordinary JavaScript objects,
  maps, arrays, monitors, and call stacks, none of which can be shared directly
  between workers. A correct mapping needs a SharedArrayBuffer-backed heap,
  atomic monitor/wait semantics, cross-worker class initialization, exception
  delivery, debugger coordination, and main-thread AWT presentation. A single
  raster worker could improve UI responsiveness, but copying or sharing its
  model/pixel buffers would not make the same computation intrinsically faster.
- **Batching repeated JIT attempts up to 64 was neutral and initially harmful.**
  A transient deopt can return `handled: true` without advancing PC or changing
  the Java call stack. The loop retried the same frame 64 times and caused about
  4.58 million calls to one method before the logo. Any future batching must
  prove progress by comparing thread, call-stack depth/top, and PC. With that
  guard, batching was still neutral and increased deopts, so it was removed.
- **Stackless expansion of `ug.a(Lvg;IIIZIII)V` was correct-looking but neutral.**
  It reached the raster quantum boundary and did not improve the animation.
  Likewise, the raster wrapper alone was neutral; the useful result required
  eliminating stack traffic in the large raster body itself.
- **Direct packed-scanline calls were only a small win.** In an instrumented
  full run, about 381,036 direct scanline calls consumed roughly 31 ms, while
  about 59,921 raster calls consumed roughly 555 ms and 59,920 wrapper calls
  consumed roughly 692 ms inclusive. After fusion, the scanline helper was not
  the dominant remaining cost.
- **Blanket-JITing `run()` is unsafe.** Observed `im.run`/`qk.run` frames include
  lifecycle, monitor/wait, and I/O behavior. The compiler excludes `run()` for
  good reason; eligibility must be structural and scheduler-safe, not based on
  a hot name.
- **A handwritten pure-JavaScript model/face ceiling was not a valid shortcut.**
  An isolated, disabled-by-default experiment selected the 593-item method from
  its descriptor shape, opcode counts, required fields, and the two fused callee
  descriptors—never its method name—and transcribed the two loops from CFR
  output into direct JavaScript `for` loops. The first active version skipped a
  structurally visible preprocessing call; adding that call still produced the
  wrong initial surface hash (`2910804539` instead of `4025147891` or
  `4136367231`). It executed 623 ceiling entries without page errors but measured
  only 7.79 changed images/s. Obfuscator control flow, signed/unsigned color
  masks, and exceptional ordering made the decompiled source an unsafe semantic
  oracle. The runtime path was deleted. A useful pure-JS ceiling must be emitted
  mechanically from verified bytecode/SSA and checked invocation-by-invocation
  against the baseline; handwritten game-field semantics are both brittle and
  slower here.

## Profiling without misleading yourself

### Measure the animation, not the four-minute wall clock

The test page creates a canvas long before useful pixels appear, and cold audio
decode/inflate/CRC work can dominate a full-run profile. Start runtime sampling
after the software canvas becomes nonblack. Otherwise methods such as audio
decode helpers (`va.a()Lud;`, `va.d(I)[F`) look like animation targets even when
they are cold-start work.

The repeated `JVM inflate` and `JVM CRC32` console messages are evidence of
progress through asset loading, not evidence that the black screen is the
inflate loop.

### Hash the internal software surface

The browser canvas can be attached and black while the guest is still working.
Read the first entry in `jvm._softCanvases`, sample its `_pixels`, count nonblack
values, and hash a fixed stride on each `requestAnimationFrame`. Record only hash
changes. This avoids X11/Xvfb screenshot timing and measures the data the JVM
actually rendered.

The repository probe below implements this method. Its established FPS estimate
is the number of changed images divided by elapsed wall time, not monitor FPS.
It also reports the stricter `(images - 1) / elapsed` interval rate. Keep the
sampling stride and changed-frame count unchanged for A/B comparisons.

### A faster animation need not have the same time-indexed hashes

When guest animation state depends on elapsed time, an optimization changes
which state is visible at a given host timestamp. Exact hash sequence equality
at equal wall times can therefore reject a correct speedup. Hashes are useful
for progress and endpoint smoke tests, not as the sole semantic oracle.

The robust validation used live differential execution:

- clone locals, operand stack, frame metadata, thread/call-stack shell, and the
  destination pixel array;
- execute the stackless raster and baseline generated raster on the same live
  input; and
- compare every output pixel and relevant local.

The final raster test compared 200/200 live invocations with no mismatch. The
wrapper test intercepted raster invokes and compared all 17 selected arguments
for 200/200 invocations. Preserve this style of differential test whenever the
special compiler grows.

### Attribute work after the correct runnable thread is selected

An early `executeTick` timing wrapper captured the method key before the
scheduler scanned to the runnable Java thread. It then attributed another
thread's work, or idle scanning, to the parked top frame (`im.run`/`qk.run`).
That made lifecycle methods appear hot. Instrument inside/after runnable-thread
selection, or sample `runGeneratedFrame` directly. Inclusive wrapper timings
must also be labeled as inclusive.

`performance.now()` around every hot call is perturbing. Sample (for example,
one in 16 calls), activate only after nonblack pixels, and compare multiple
runs. Use counters to explain control flow, then use timings to choose the next
target.

### Use the native Firefox sampler to separate tiers

A Gecko profiler run used 1 ms sampling with the `js` and `stackwalk` features,
then selected the approximately three-second content-process window containing
the first 20 nonblack logo changes. Sampling itself reduced the observed rate
from the normal 8.2-ish range to 7.10 changed images/s, so treat the percentages
as attribution rather than an FPS baseline. The selected window contained 3,000
samples:

| Execution context | Samples |
|---|---:|
| generated JavaScript tier | 47.1% |
| partial Wasm plus its JavaScript imports | 13.2% |
| bytecode interpreter | 12.9% |
| AWT/presentation | 1.6% |
| unresolved native/browser/other JVM frames | 25.3% |

Exclusive leaves within the generated-JavaScript share were 33.6% in generated
guest/JIT code, 7.4% in generated field helpers, 1.7% in generated call
dispatch, 1.5% in checked array helpers, 0.6% in recognized raster intrinsics,
and 0.2% in frame materialization. `getStaticSyncAt` alone was the largest
named runtime leaf at 5.8% of all selected samples. This explains why removing
only Java call-stack push/pop was neutral: the profiler found little exclusive
time there.

The partial-Wasm result is also important. JavaScript import/conversion glue
accounted for 8.2% of all samples, while actual Wasm bodies and trampolines were
only 2.9%; the remainder was unresolved native/Wasm frames. Do not assume that
more partial Wasm coverage is automatically faster in Firefox. The next useful
A/B test is to keep import-heavy or exit-heavy methods in a whole JavaScript
tier, or make their field/array access stay within Wasm. Disabling Wasm globally
would send unsupported methods back to the interpreter and is not an adequate
test of that hypothesis.

### Establish the plain-JavaScript canvas ceiling

Use `npm run benchmark:canvas:firefox` to separate browser canvas cost from JVM
cost. On the validated Firefox 146 headless build, all requestAnimationFrame
tests sustained 60 FPS:

| Work per 800x600 frame | Render time |
|---|---:|
| `requestAnimationFrame` only | 0.01 ms |
| `putImageData` only | 1.02 ms |
| full JavaScript color raster plus upload | 3.29 ms |
| full-frame Jagex-style blend plus upload | 4.28 ms |

The same blend ran about 810-815 times/s in a tight loop including
`putImageData`; the checked-in benchmark reports both its rAF and unconstrained
tests. This rules out Firefox's canvas upload and raw integer pixel math as the
reason for 5 FPS. The useful optimization target is JVM representation and
generated control/call overhead.

The non-invasive logo counter window also measured 323 `ug` model renders,
40,660 `wf`/`oj` gradient triangles, and 8,816 `tb`/`ib` triangles for 20 changed
images. That is roughly 16 model submissions and 2,474 triangle submissions per
changed image, plus 391,849 array-copy/constant-scanline intrinsic calls. These
counts justify optimizing compiled field and call sites before moving the
renderer to a worker.

### Isolate Java raster, AWT publication, and browser presentation

`npm run benchmark:awt:firefox` compiles and runs the checked-in Java applet in
JVM.js. It uses the same integer blend shape but separates four phases. The
first version of this experiment accidentally contained `wide iinc` bytecodes.
The interpreter expanded `wide`, but JIT eligibility inspected the raw opcode
and rejected the entire raster method. Its reported 0.76 frames/s was therefore
interpreter performance, not evidence about the generated JIT.

JIT analysis and code generation now share a normalized view that expands
`wide` without changing bytecode indices. The benchmark also fails unless its
raster records generated executions. A corrected Firefox run at 64x64 measured:

| Guest work | Rate |
|---|---:|
| generated Java `int[]` raster only | 588 frames/s |
| generated raster plus `MemoryImageSource.newPixels` and `Graphics.drawImage` | 769 frames/s |
| `Thread.sleep(1)` pacing control | 313 iterations/s |
| AWT publication plus pacing, without raster | 213 iterations/s |

All 21 raster invocations used generated code, with no runner fallback or
deoptimization. The raster phases are short enough that their ordering is
measurement noise; both demonstrate hundreds of frames/s. Twenty paced AWT
publications remained inexpensive. This changes the attribution: a compact
generated Java pixel loop is fast, while Dekobloko's large geometry/raster call
graph and JVM call/state representation remain expensive.

The earlier large-surface timeouts were another symptom of the same `wide`
eligibility hole. Keep the surface small so this remains a focused compiler/AWT
test, and keep the generated-run assertion so future coverage regressions
cannot silently turn it back into an interpreter benchmark.

The browser AWT path now snapshots a producer framebuffer when `drawImage`
publishes it, marks that surface dirty, and coalesces presentation on
`requestAnimationFrame`. It intentionally does not alias the producer array:
doing so exposed partially rendered frames while the game mutated its next
frame. The JVM records dirty, scheduled, coalesced, presented, and upload-time
counters. A Dekobloko validation run presented 108 completed 800x600 frames in
the 65-second probe and spent 237 ms uploading them, about 2.19 ms per upload.
There is no longer a harness-imposed 10 FPS ceiling.

## 2026-07-20: structured JVM SSA block renderer

The next experiment replaced the scalar tier's `while`/`switch (pc)` control
dispatcher with a real block renderer in `src/jit/JvmSsaBlockRenderer.js`.
`buildCfgFromCode` supplies verified basic blocks and operand-stack depths, and
the existing Ramsey structurer turns reducible control flow into lexical
JavaScript `while`, `if`, labeled `break`, and `continue` regions. Every
bytecode-produced operand receives a unique JavaScript value. An edge explicitly
feeds each live operand into a fixed join slot for its successor block, which is
the JavaScript representation of an operand-stack phi.

The first integer/control-only version passed its join and safe-point tests but
compiled **zero** Dekobloko methods in a production Firefox run. That negative
result confirmed the earlier bytecode inventory: even the smaller animation
loops combine reference locals with arrays, fields, division/remainder, and
calls. The renderer was therefore extended generically for those operations,
including synchronous static calls and no-op/rethrow exception handlers. It has
no class-name or method-name tests.

Correctness boundaries are explicit:

- loads snapshot locals into distinct operand values, preserving forms such as
  `array[index++]`;
- null, bounds, arithmetic, field, class-initialization, cast, call, and throw
  exits materialize the exact bytecode PC, scalar locals, and JVM operand order;
- every 10,000 loop-header entries reconstruct the ordinary `Frame` before a
  scheduler safe point; and
- debugger/breakpoint entry deoptimizes before the structured-run counter or
  guest mutation. SSA temporaries and join slots exist only inside the generated
  function, so snapshots continue to serialize canonical JVM frames and heap
  objects.

Focused differential coverage includes a loop-carried non-empty operand stack,
debug fallback, safe-point reconstruction, array/field/remainder/static-call
effects, a rethrow-only handler, and precise null-exception state. The production
probe exposes `PROBE_STRUCTURED_SSA=0/1` and reports compiled loops, entries,
safe points, and per-method runs.

The final same-bundle Firefox 1509 A/B used the production bundle, the same JAR,
sample stride, 20-image window, and 58-second probe. Per-method profiling was
off for these acceptance samples:

| Structured SSA | Samples (changed images/s) | Median |
|---|---|---:|
| off | 8.8898, 8.6319, 8.6354 | 8.6354 |
| on | 9.1619, 9.3751, 9.0883 | 9.1619 |

This is a **+6.10% median improvement**. Every run began with surface hash
`4025147891` and had no page or console errors. Enabled runs compiled 19 loop
headers and recorded roughly 168,000--171,000 structured entries. A diagnostic
profile showed animation-phase use in `hk.a(IIII)V` and several array helpers,
but the complete 593-item model/face body and wrapper/raster family still do not
fit the renderer's supported structured shape. The result is real but remains
far below 20 changed images/s, so `structuredSsa` stays opt-in. The next useful
work is coverage of the remaining hot-body operations/CFG shapes, not another
method-specific renderer.

The opt-in tiers are composable. A single `rendererPipeline` configuration now
enables broad scalar guest-body compilation, fused wrapper/raster/scanline
regions, and structured SSA; the matching environment/probe controls are
`JVM_ENABLE_RENDERER_PIPELINE=1` and `PROBE_RENDERER_PIPELINE=1`. The first
composed run exposed one generic gap: structured SSA took over a 27-bytecode
loop executed about 130,000 times but materialized its static integer leaf call,
whereas the older scalar compiler inlined it. Reusing the existing structurally
verified integer-leaf plan inside the SSA renderer raised that run from 12.25 to
13.04 images/s without method-specific selection.

A final same-bundle A/B left scalar guest bodies and fusion enabled on both
sides and changed only structured SSA:

| Composed pipeline | Samples (changed images/s) | Median |
|---|---|---:|
| structured SSA off | 12.1244, 11.9960, 12.7672 | 12.1244 |
| structured SSA on | 13.0388, 11.7621, 13.1874 | 13.0388 |

The composed median is **+7.54%** with structured SSA, despite visible run
variance. Initial hashes were `4025147891` or the previously accepted adjacent
animation hash `4136367231`, and every run had empty page/console error lists.
This restores the expected ~13-images/s class—the earlier 8--9 measurements
were intentionally isolated structured-on/default-pipeline A/B runs, not a
regression of the scalar+fused configuration. The combined pipeline still stays
opt-in because 13.04 remains well below the 20 images/s acceptance threshold.

### Final verification ledger

The completed implementation was checked with:

```bash
timeout 90s node node_modules/tape/bin/tape \
  test/jitCompiler.test.js \
  test/schedulerPerformance.test.js \
  test/saveState.test.js \
  test/browserBundleConfig.test.js
```

All **268 assertions passed**. This includes live array/field/call comparison,
loop-carried operand joins, verified static-leaf inlining, debugger fallback,
precise null/divide exception state, scheduler behavior, portable save-state
identity, and browser dynamic-function configuration.

```bash
npm run build:bundle
```

The production build completed successfully. Webpack reported only the known
dynamic-JNI and bundle-size warnings; the generated browser asset was about
920 KiB. After deployment, read-only checks confirmed an active
`0.0.0.0:3765` listener, HTTP 200 for `dekobloko.jar`, `Cache-Control: no-store`,
and a real Firefox page whose live JVM reported `rendererPipeline`, broad scalar
guest bodies, fused regions, and structured SSA all enabled.

## 2026-07-21: the node fps harness is the primary benchmark

The whole-app frame rate can be measured on plain node, and as of 2026-07-21
this is the **primary** optimization benchmark; Firefox is the acceptance
check, run only when a change survives the node bench.

Why node measures the same thing: with the JIT on, node/V8 reaches ~16.4 fps
at the title screen while Firefox/SpiderMonkey medians ~15.2 with every tier
enabled. The two engines converge because the bottleneck is the JVM emulation
layer (interpreted residue + JS↔wasm boundary traffic), not the browser
(canvas, compositing, DOM are all absent on node and the number barely moves).
A change that does not move the node number will not move Firefox; the 30 fps
goal restates as "make the node harness exceed 30".

Why the node bench is better for iteration:

- **Setup.** No Playwright, no pinned Firefox build (the package expects
  firefox-1511 while only 1509 is installed — every Firefox run needs
  `FIREFOX_EXECUTABLE_PATH=~/.cache/ms-playwright/firefox-1509/firefox/firefox`),
  no `0.0.0.0:3765` page server, no production bundle build/deploy cycle. The
  node run consumes the working tree directly — edit, run, measure.
- **Feedback latency.** One node run is ~60 s wall (boot ~20 s, then ~7 fps·s
  of measurement window). A defensible Firefox comparison needs a bundle build,
  a deploy, and ≥3 alternated runs per side of 65 s probe windows plus browser
  startup — tens of minutes per A/B.
- **Determinism.** Frame timestamps come from `[frame] +<t>s` stderr lines —
  exact arithmetic over a chosen window, no browser scheduling, thermal or
  background-tab noise, no `changedFramesPerSecond` probe-window truncation.
- **Debuggability.** stderr is right there: `JVM_DEBUG_WASMJIT=1` compile
  logs, frame PNGs (`JVM_FRAME_DIR`) for visual regression, plus every other
  JVM_* diagnostic — none of which survive the browser boundary comfortably.

The recipe (all of it is load-bearing):

```bash
JVM_FAKE_TIME=1000000000000 JVM_WASM_JIT=1 \
JVM_FRAME_DIR=/tmp/frames JVM_FRAME_EVERY=25 JVM_FRAME_LIMIT=9 \
JVM_EXIT_AFTER_FRAME_LIMIT=1 \
node scripts/run-jvmjs.js <classesDir> gameport1=43595 gameport2=43595
```

- **A local dekobloko server must be listening** (the tracked
  `apps/server` in dekobloko-work). The game streams its JS5 cache over the
  game TCP port; without a server every run loops `ECONNREFUSED` and never
  blits, and JIT-on runs die *faster* into `error_game_js5connect` (the
  compiled retry loop exhausts the connect budget) — which looks exactly like
  a JIT hang and is not one. Two 30-minute "regressions" were chased before
  this was understood.
- `gameport1=43595 gameport2=43595` are applet-parameter overrides
  (run-jvmjs.js defaults to 43594); bare `key=value` CLI args become applet
  params.
- `JVM_FAKE_TIME` unfreezes the game's sleeps; the `[frame] +<t>s` uptime is
  REAL wall clock, so fps = frames / Δt directly.
- fps over a warm window: skip to frame 25, e.g. 175 / (t₂₀₀ − t₂₅).

Known caveats: the measured scene is the title screen, not gameplay; every
25th frame pays a PNG encode (a few percent); node cannot replace the Firefox
acceptance run because SpiderMonkey's wasm/JS optimizer mix differs (the
history of node-side microbenchmarks mispredicting Firefox is documented
above — whole-app node fps has tracked Firefox where the toys did not).

Measured with it (2026-07-21): original obfuscated jar 16.4 fps (first blit
+20.1 s) vs decompiled+javac-recompiled classes 11.4 fps (first blit +26.0 s)
— the recompiled world is ~30% slower under identical conditions; javac's
~1.5–1.8× instruction verbosity dominates its better wasm coverage. Trace
replay cannot drive the recompiled classes (frame state binds to original
bytecode layout), so this boot-level harness is also the only recompiled-world
whole-app benchmark.

One Firefox-side trap recorded here because the node bench surfaced it: the
probe's *default* flags leave the fused/scalar/structured tiers off and
measure ~10.6 fps; the documented baselines (14.13 attribution, 15.18 best)
require the full override set (`PROBE_FUSED_REGIONS=1 PROBE_SCALAR_LOOPS=1
PROBE_SCALAR_SSA=0 PROBE_STRUCTURED_SSA=1 PROBE_RENDERER_PIPELINE=1`). Never
compare a default-flag run against those baselines.

## Reproducing the Firefox measurement

Build the production bundle, because the unbundled and bundled async behavior
can differ:

```bash
npm run build:bundle
```

Webpack's dynamic-JNI and asset-size warnings are expected; a nonzero exit is
not. Deploy `dist/jvm-debug.js` to the test page and ensure the server:

- listens on `0.0.0.0:3765` when another machine/browser must connect;
- serves the current bundle rather than a cached filename; and
- exposes the game as `dekobloko.jar`.

For the original temporary harness the deployment command was:

```bash
cp dist/jvm-debug.js /tmp/dekobloko-browser-bundle/jvm-debug-current.js
```

To host the measured composed pipeline for ordinary browser visitors—not only
for the profiler—the launcher must enable it on the already-created browser JVM
before loading the JAR:

```js
const debug = new JVMDebug.BrowserJVMDebug();
const jit = debug.debugController.jvm.jit;
jit.rendererPipelineEnabled = true;
jit.scalarLoopsEnabled = true;
jit.scalarGuestBodiesEnabled = true;
jit.fusedRegions.enabled = true;
jit.structuredSsa.enabled = true;
await debug.initialize();
await debug.loadFile(file);
```

The temporary launcher used during this investigation is started with:

```bash
node /tmp/dekobloko-browser-server.js
```

It binds explicitly to `0.0.0.0:3765`, serves the production bundle with
`Cache-Control: no-store`, exposes `dekobloko.jar` and cache files, and bridges
the game's WebSocket connection to TCP port 43594. Binding to `0.0.0.0` exposes
the launcher on every host interface; firewall and network access should be
treated accordingly.

With the page running locally, profile it using the checked-in probe:

```bash
PROBE_WAIT_MS=65000 npm run profile:dekobloko:firefox
```

Measure the raw browser/canvas ceiling with:

```bash
FIREFOX_EXECUTABLE_PATH=/path/to/firefox \
npm run benchmark:canvas:firefox
```

Run the Java/AWT phase benchmark with:

```bash
FIREFOX_EXECUTABLE_PATH=/path/to/firefox \
npm run benchmark:awt:firefox
```

Reproduce the generated field-resolution microbenchmark with:

```bash
npm run benchmark:jit:fields
```

Useful overrides are:

```bash
DEKOBLOKO_URL=http://kreijstalnuc:3765/ \
FIREFOX_EXECUTABLE_PATH=/path/to/firefox \
PROBE_WAIT_MS=65000 \
PROBE_CHANGED_FRAMES=20 \
PROBE_FUSED_REGIONS=1 \
PROBE_SCALAR_LOOPS=1 \
PROBE_SCALAR_SSA=0 \
PROBE_STRUCTURED_SSA=1 \
PROBE_RENDERER_PIPELINE=1 \
npm run profile:dekobloko:firefox
```

For a defensible optimizer A/B, build once, serve that exact bundle, and change
only one `PROBE_*` switch. Alternate on/off runs to reduce thermal and background
load bias, use at least three clean samples per side, compare medians, and keep
the raw JSON. Reject any run with a page/console error or an unexpected initial
surface hash. A provisional three-run improvement is not sufficient when a
counter or diagnostic write still perturbs the hot path; remove the
instrumentation and repeat before accepting the optimization. The rejected
cross-block field cache is the concrete reason for this rule.

Detailed per-method JIT maps are disabled during ordinary browser execution;
updating them on every generated call and intrinsic polluted the hot path.
Enable them for attribution runs with `PROBE_JIT_METHODS=1`. The profiler also
reports deltas beginning at the first nonblack software frame, so cold audio
and archive work no longer dominate the hot-method ranking.

If Playwright reports that its expected Firefox executable does not exist,
either run `npx playwright install firefox` or set `FIREFOX_EXECUTABLE_PATH` to
an already installed compatible build. The validated host used Playwright
Firefox build 1509 explicitly because the package expected a newer build that
was not installed.

The output includes the raw surface changes, both changed-frame rate
conventions, page status, JIT tier counters, hot generated/inlined/intrinsic
method counts, and deoptimization reasons. The `ab3769b` baseline observed the
expected first hashes `4025147891`, `4136367231`, reached the logo endpoint hash
`2740534465`, and measured 20 changed images in 3749.46 ms: 5.33 changed
images/s or 5.07 transition intervals/s. The field-site build retained those
hashes and measured 20 images in 2800 ms: 7.14 changed images/s or 6.79
transition intervals/s. The final call-transfer build measured 7.64 and 7.90
changed images/s in two runs; the no-local-clear follow-up measured 20 images in
2600.32 ms, or 7.69 changed images/s and 7.31 transition intervals/s. Save the
JSON together with the JVM commit, JAR hash, Firefox version, bundle hash, and
host details for a defensible comparison.

With dirty-driven presentation enabled, the expected initial hashes remained
present and the probe measured 20 images in 2483.38 ms: 8.05 changed images/s
or 7.65 transition intervals/s. It also reported 108 actual AWT presentations
and 237 ms of total browser upload work.

After `wide` normalization, direct cached static/intrinsic call targets, native
overlap copies, and opt-in browser statistics, two clean runs measured 8.51 and
8.28 changed images/s. Treat this as a modest improvement, not a solved
performance gap. A method-profile run over the animation observed roughly
638,000 overlap-copy intrinsics, 180,000 constant-fill intrinsics, and 83,000
executions each of the raster and wrapper; the next large gain must reduce that
render call graph's frame/state traffic rather than tune AWT or yielding.

A verifier-backed direct-call experiment then removed the Java call-stack
push/pop around the structurally recognized stackless raster. The first broad
prototype recorded about 158,000 direct wrapper/raster calls during the measured
animation, proving that the path was active, but nested direct calls complicated
exception and deoptimization frame ordering. A conservative version therefore
kept the wrapper frame and bypassed the stack only for the verified raster leaf.
Its two clean runs measured 8.16 and 8.28 changed images/s versus the 8.51 and
8.28 baseline above. The optimization was removed: call-stack container traffic
is not a material bottleneck by itself. Future cross-method optimization needs
to eliminate child `Frame`, locals, operand-stack, and materialization work, not
merely push/pop. Bytecode verification can justify such inlining, but building a
general verifier before a cross-boundary prototype demonstrates a repeatable
gain would be premature.

### Fused wrapper/raster region experiment

A subsequent opt-in compiler recognizes the two renderer families by method
descriptors, verified CFG/operand-stack shape, repeated callee shape, resolved
method identity, and structural scanline intrinsics. It does not select any
obfuscated class or method name. The generated region scalarizes locals and
stack joins, invokes the raster and scanline kernels positionally, caches
resolved static storage, guards class/debugger/scheduler state before consuming
caller operands, and reconstructs omitted wrapper/raster frames if an operation
throws. `PROBE_FUSED_REGIONS=0/1` controls same-bundle Firefox A/B runs and the
probe reports fused runs, guarded fallbacks, and restored exception frames.

On Firefox build 1509, the production-bundle three-run result was:

| Mode | changed images/s | Median |
|---|---:|---:|
| fused on | 9.75, 9.68, 9.30 | 9.68 |
| fused off | 8.22, 8.05, 7.95 | 8.05 |

The expected initial hashes `4025147891` and `4136367231` were retained, the
instrumented runs reported no page or console errors, and fused runs recorded
roughly 122,000--128,000 fused regions with one cold guarded fallback. Although
the median improvement was about 20%, it did not meet the experiment's absolute
acceptance threshold of 20 changed images/s. The runtime path is consequently
disabled by default and retained only as profiling/differential infrastructure;
enable it explicitly with `jit: { fusedRegions: true }`,
`JVM_ENABLE_FUSED_REGIONS=1`, or `PROBE_FUSED_REGIONS=1`. The remaining cost is
in the generated model/face caller body and its operand/call dispatch, so that
body should be profiled before another runtime fast path is selected.

### Generic scalar-loop experiment

A name-independent scalar tier was added for handler-free integer loops. It
verifies CFG stack depths, scalarizes used locals and operand expressions,
inlines only structurally complete static integer regions, and materializes the
exact `Frame` at throwing arithmetic operations, debugger entry, and a bounded
10,000-backedge scheduler safe point. On the checked-in intermethod benchmark
(50,000 iterations, five measured rounds), generated JavaScript improved from
roughly 177 to 58.10 ns/iteration for the monolith and from roughly 290 to
58.00 ns/iteration for the eight-static-call shape. HotSpot measured 4.88 and
4.84 ns/iteration respectively; the existing monolithic Wasm loop measured
5.55 ns/iteration, while partial Wasm with static calls measured 315.11
ns/iteration.

The pure scalar tier did not select a Dekobloko animation method because the hot
loops contain arrays, fields, or dynamic calls. A follow-up scalarized locals in
the already verified wrapper/raster basic-block compiler. It was active for
about 180,000--193,000 wrapper/raster entries per run, but same-bundle Firefox
build 1509 measurement showed no gain:

| Mode | changed images/s | Median |
|---|---:|---:|
| renderer locals scalarized | 8.57, 8.89, 8.06 | 8.57 |
| existing renderer emitter | 8.63, 8.51, 8.63 | 8.63 |

All runs retained initial surface hash `4025147891` and reported no page or
console errors. The renderer-local fast path was removed. The generic integer
loop tier remains enabled by default because its differential benchmark is a
large repeatable win and it does not activate for unsupported game shapes.
`PROBE_SCALAR_LOOPS=0/1` controls same-bundle Firefox A/B runs and reports scalar
entries and backedge safe points.

### Array/field guest-body scalarization

The scalar verifier was then extended to the features actually present in the
large model/face caller: reference locals, `int[]`/`short[]`/reference loads,
checked integer stores, array lengths and allocation, instance and initialized
static fields, reference branches, synchronous static calls, and rethrow-only
obfuscator handlers. Selection still uses descriptors, CFG/stack verification,
opcodes, and resolved method identities; it contains no game class or method
name allowlist. Internal branch joins use fixed scalar slots, while calls,
exceptions, returns, debugger entry, and bounded backedge safe points restore
the ordinary frame state.

A Firefox correctness run first exposed an important JVM ordering case in the
game's unrolled clear loop: `array[index++] = value` loads `index` before its
`iinc`. Snapshotting every local load fixed the otherwise one-element-shifted
stores. The focused differential test now covers that form, and an instrumented
45-second startup run completed 146,657 scalar regions without a runtime or page
error.

The first same-bundle pair measured 10.43 changed images/s with the broader
scalar tier versus 8.82 with it disabled. Combining caller scalarization with
the opt-in wrapper/raster fusion reached 12.00 images/s. Replacing internal
frame-stack joins with scalar slots raised the checked-in static-call
microbenchmark from about 70 to 12 ns/iteration and the browser combination to
13.05 images/s. Hoisting repeated fused guard lookup had no measurable browser
effect. Finally, emitting the structurally verified scanline loop directly in
the raster kernel passed 200 gradient and 200 flat-color live differential
invocations and measured 13.19 images/s. Expected initial hashes `4025147891`
and `4136367231` remained present and all browser runs were error-free.

The complete region is therefore roughly 49% faster than the matched 8.82
baseline, but it still misses the absolute 20 changed-images/s acceptance
threshold by a wide margin. The fused renderer remains disabled by default, and
the array/field/call-heavy scalar extension is also opt-in through
`jit: { scalarGuestBodies: true }`, `JVM_ENABLE_SCALAR_GUEST_BODIES=1`, or
`PROBE_SCALAR_LOOPS=1`. The small integer-only scalar tier remains enabled by
default. The result attributes the remaining gap primarily to the generated
geometry/raster arithmetic and overdraw, rather than AWT publication, frame
push/pop, fused-entry guards, or scanline helper dispatch.

Run the focused correctness suite after JIT edits:

```bash
timeout 90s node node_modules/tape/bin/tape test/jitCompiler.test.js
```

The final focused JIT run passed all 245 assertions. Scheduler/dispatch edits should
also run:

```bash
timeout 120s node node_modules/tape/bin/tape \
  test/jitCompiler.test.js test/schedulerPerformance.test.js
```

Bundler edits must additionally run:

```bash
node node_modules/tape/bin/tape test/browserBundleConfig.test.js
npm run build:bundle
```

## Primary optimizer benchmark: distilled Dekobloko hot loops

Full-game FPS is now a final integration metric, not the inner optimizer loop.
It takes roughly 50 seconds to reach the logo animation, mixes startup, class
loading, network/cache activity, scheduling, rendering, presentation, and host
variance, and gives poor attribution when a compiler change moves only a few
percent. The checked-in replacement is:

```bash
npm run benchmark:jvm:dekobloko-hot-loops
```

`benchmarks/DekoblokoHotLoopBenchmark.java` intentionally retains the features
that made the 593-item body expensive while removing game dependencies:

- a nested fixed-point vertex-transform loop over instance `int[]` fields;
- multiply/add/shift/divide with Java overflow and truncation semantics;
- projected-coordinate destination stores;
- a nested face loop gathering three `short` indices and six projected values;
- cross-product visibility branches, a small static integer shading helper, and
  checked color stores; and
- a combined caller that enters both hot loops.

The default workload uses 100 invocations, 40 passes, five measured rounds, and
three warmups. Each generated invocation remains below the 10,000-loop-header
safe-point budget, so the benchmark measures generated bodies instead of an
accidental deoptimization path. Work is normalized as vertex/face visits. The
script compiles the same source for HotSpot and jvm.js, constructs identical
heap data, and rejects a tier before timing is accepted if its checksum differs
from HotSpot.

The first full run produced:

| Tier | Vertices ns/element | Faces ns/element | Combined ns/element |
|---|---:|---:|---:|
| HotSpot (`-Xbatch`) | 4.0904 | 2.8947 | 3.2911 |
| Ordinary generated JS | 721.3730 | 1673.6200 | 1289.7304 |
| Broad scalar dispatcher | 18.8397 | 356.1176 | 224.1212 |
| Structured SSA | 10.0849 | 315.1315 | 196.1672 |

All twelve tier/shape results matched their HotSpot checksums. Against broad
scalar JS, structured SSA improved vertex work by **46.47%**, face work by
**11.51%**, and combined work by **12.47%**. This is much cleaner evidence than
a logo-animation sample: removing block dispatch matters substantially, but the
face loop remains about **108.86×** slower than HotSpot even after structuring.

The toy benchmark immediately exposed a compiler eligibility bug. Krakatau-style
normalized `bipush` and `sipush` operands are numeric strings, while the first
SSA verifier accepted only JavaScript numbers. The result was silent scalar
fallback for both toy loops. Constants are now normalized with `Number(...)`
and checked for finite integer form; a unit test uses the string representation.
The structured compiler also retains its latest rejection reason/error so future
toy failures can be attributed without instrumenting the full game.

### 2026-07-20 face-loop breakthrough: inline forward-branching integer leaves

Inspecting the structured source disproved the initial array hypothesis. The
small shading helper was *not* directly inlined because the integer-leaf
compiler accepted only straight-line methods. Every visible face therefore
materialized the caller `Frame`, called `tryInvokeSyncAt`, checked async/deopt
and thread state, and resumed the caller. The call sat inside the innermost
face loop; array checks were secondary.

The integer-leaf compiler now accepts a bounded forward conditional whose
fall-through region is straight-line integer code. It symbolically evaluates
both paths, emits JavaScript `if` control flow, and feeds changed locals and
operand values through explicit SSA-style phi temporaries at the join. The
guard remains structural:

- integer-only parameters and integer return;
- initialized static target resolved from the call descriptor;
- no exception handlers, recursion, backward edge, or unsupported opcode;
- verified forward target and equal operand-stack depth at the join; and
- the existing 64-instruction leaf and 256-instruction region limits.

No class or method name participates in selection. `ldc`/`ldc_w` integer
constants are also accepted after finite-integer normalization. If any proof
fails, compilation returns the existing generic call path without partially
emitting the inline.

After this change, the emitted face method contains the shading arithmetic and
branch directly and contains no `tryInvokeSyncAt`. A clean default benchmark
run produced:

| Tier | Vertices ns/element | Faces ns/element | Combined ns/element |
|---|---:|---:|---:|
| HotSpot (`-Xbatch`) | 3.8358 | 2.8967 | 3.2639 |
| Ordinary generated JS | 688.0667 | 1220.1814 | 1006.9735 |
| Broad scalar dispatcher | 18.6194 | 19.4630 | 18.8792 |
| Structured SSA | 9.9528 | **11.8374** | **10.9281** |

All checksums matched. Three clean processes measured structured face times of
11.8374, 11.9032, and 11.8466 ns/element, for a **11.8466 median**. Relative to
the pre-change 315.1315 result, that is **26.60× faster** and **96.24% less
time**. The corresponding HotSpot face median was 2.8896 ns/element, reducing
the slowdown from 108.86× to **4.10×**. The three structured combined results
were 10.9281, 10.9736, and 10.9258 ns/element (10.9281 median), a **17.95×**
improvement over 196.1672. The scalar tier benefits from the same generic
inliner, confirming that removed call/frame dispatch—not SSA loop syntax
alone—caused the discontinuity.

Several measured experiments were removed rather than accumulated around the
win. Cached raw-array companions measured 328.57 ns/face, out-of-line exception
materialization measured 331.09, and speculative primitive loads measured
323.64; none beat the original 315.13 result reliably and some regressed the
vertex loop. Disabling whole-method JavaScript did not make the existing Wasm
tier accept this reference/array-heavy shape, so it fell back to ordinary
generated JS. The clean retained change is the forward-branch leaf inliner plus
its differential unit coverage.

Run the toy A/B first for subsequent work, retain exact checksum comparison,
then use the full JAR only to verify hashes, exceptions, snapshots, and
end-to-end FPS. Toy nanoseconds per element are not game FPS and must never be
reported as such.

The post-inliner Firefox integration check used the rebuilt production bundle,
Firefox build 1509, the same `dekobloko.jar`, sample stride 16, 20-change
window, and the composed renderer pipeline. Three fresh browser processes
measured **11.2130, 13.3303, and 13.4780 changed images/s**, for a **13.3303
median**. Their transition-interval rates were 10.6524, 12.6638, and 12.8041/s
(12.6638 median). Every run began its animation window at expected surface hash
`4025147891`, had empty page and console error lists, compiled 51 structured
loops, and exercised roughly 233,000--239,000 structured entries plus 184,883
fused calls. The 13.3303 median is 2.24% above the earlier 13.0388 composed
median, but that difference is inside the observed Firefox run variance and is
not attributed solely to the inliner. The full game remains in the ~13 FPS
class and below the 20 changed-images/s acceptance target.

### Second-generation toy: renderer traffic, not only face arithmetic

An attribution-only Firefox run with per-method maps enabled is not valid for
FPS acceptance, but it exposed the missing workload shape. Its 20-change
animation interval observed 1,096,656 overlap-safe primitive copies, 48,951
clipped span fills, 174,468 fused calls, and only 501 directly inlined integer
helpers. The copy-to-span ratio was about 22.4:1. This explains why a 26.6x face
arithmetic improvement could disappear inside full-game variance.

`benchmarks/DekoblokoRendererTrafficBenchmark.java` and
`scripts/benchmarkDekoblokoRendererTraffic.js` preserve that traffic in three
separately attributable shapes:

- a clipped `(IIII)V` horizontal span writing an initialized static `int[]`
  software surface;
- an overlap-safe `([II[III)V` primitive copy with the same branch prefix and
  eight-way unrolled load/store family as the live structural intrinsic; and
- a composed nested caller with 22 copies per synthetic traffic unit plus one
  span.

The script confirms at runtime that the copy method is structurally recognized
as the native intrinsic. It compares HotSpot, ordinary generated JavaScript,
broad scalar JavaScript, and structured SSA, and rejects results unless every
checksum matches. Operations are synthetic calls, not frames or FPS. Run it
with:

```bash
npm run benchmark:jvm:dekobloko-renderer-traffic
```

The default 10-invocation, two-pass, five-round, three-warmup run measured:

| Tier | Span ns/op | Overlap copy ns/op | Composed ns/op |
|---|---:|---:|---:|
| HotSpot (`-Xbatch`) | 126.2063 | 10.1872 | 10.1757 |
| Ordinary generated JS | 2001.8078 | 1074.9578 | 1133.0212 |
| Broad scalar JS | 706.7021 | 911.4091 | 919.8720 |
| Structured SSA | **628.1823** | **868.6370** | **852.9469** |

All twelve shape/tier checksums matched. Structured spans are 4.98x slower than
HotSpot, but overlap copies are **85.27x** slower and composed traffic is
**83.82x** slower. One composed traffic unit costs 19.618 microseconds in
structured JavaScript versus 0.234 microseconds on HotSpot. The generated
structured source shows one synchronous call/materialization site in the copy
caller and one in the span caller; that single source site executes inside the
nested loop. Across the five measured rounds, span mode entered generated
regions 19,250 times, while copy mode entered its outer structured body only 50
times and repeatedly dispatched the already-recognized intrinsic from inside
it.

This changed the next optimization target. The implementation now emits the
already structurally verified copy and span intrinsics directly into structured
callers. Selection uses descriptors, exact normalized opcode sequences, stack
verification, static-field descriptors, and repeated field identities; method
names are not consulted. The span field references become cached positional
sites, but their current values are still read on every call. An uninitialized
class deoptimizes at the unexecuted call with all operands restored. Null and
bounds failures likewise restore the precise invoke PC and operand order before
the ordinary JVM exception dispatcher takes over.

One lower-level surprise mattered as much as dispatch removal. A raw Node 26
microbenchmark of the renderer's small overlapping ranges measured
`Array.prototype.copyWithin` at 713.24 ns/copy versus 12.37 ns/copy for an
explicit reverse primitive loop. `copyWithin` carries generic JavaScript array
semantics that this verified Java `int[]` operation does not require. Replacing
it with the direct reverse loop preserves memmove order and exact preflight
bounds behavior.

After both structural direct emissions, the same default checksum-gated toy run
measured:

| Tier | Span ns/op | Overlap copy ns/op | Composed ns/op | Composed ns/traffic unit |
|---|---:|---:|---:|---:|
| HotSpot (`-Xbatch`) | 180.8490 | 10.0612 | 10.0867 | 231.9945 |
| Ordinary generated JS | 1619.2081 | 342.1996 | 403.0862 | 9270.9815 |
| Broad scalar JS | 1316.5938 | 177.9486 | 216.3257 | 4975.4906 |
| Structured SSA | **235.0255** | **20.1090** | **24.2536** | **557.8323** |

All checksums again matched. Relative to the pre-change structured run, spans
improved **2.67x** (628.18 to 235.03 ns), copies improved **43.20x** (868.64 to
20.11 ns), and composed weighted operations improved **35.17x** (852.95 to
24.25 ns). A complete synthetic traffic unit fell from 19.618 microseconds to
0.558 microseconds and is now 2.40x HotSpot instead of 83.82x on the weighted
operation metric. Both inner structured sources report zero synchronous call
sites. The composed outer method retains two calls—one per bulk traffic
subroutine—so this benchmark deliberately does not claim all dispatch has
vanished.

The production-bundle Firefox integration result did **not** reproduce the toy
speedup at game scale. Three clean Firefox 1509 processes measured 13.9482,
12.9032, and 13.0409 changed images/s, a **13.0409 median**. The previous
same-configuration median was 13.3303, so the observed change is -2.17% and
well inside the already observed process variance; it is not evidence of an FPS
win. All three runs began at expected surface hash `4025147891`, reported no
page or console errors, compiled 51 structured loops, and exercised about
180,000 structured entries and 193,000--195,000 fused calls. The optimization
therefore remains a strong isolated JVM improvement, but it falsifies the idea
that these two operation bodies alone are the missing end-to-end bottleneck.
The next game investigation must profile post-optimization wall time rather
than rank methods by call counts alone.

### Third-generation benchmark: captured scene-entry replay

The earlier count attribution had an additional measurement flaw: its method
counter subtraction ran from the first non-black image to the end of the
65-second probe, not to the twentieth changed image. The 22.4:1 copy/span ratio
was still useful, but the absolute counts were not a 20-change window. The probe
now snapshots counters and sampled timings at the exact configured changed-image
boundary.

`PROBE_JIT_TIMINGS=1` adds randomized sampled wall-time attribution around
generated region entries. The default 1-in-256 sampler avoids periodic-call
aliasing and makes unsampled calls pay no clock read. After broad attribution,
`PROBE_JIT_TIMING_FILTER` can restrict full-rate measurement to discovered
method identities. These identities are diagnostics only; optimizer selection
does not consult them.

A full-rate, four-method run over the corrected 20-change window measured:

| Actual guest region | Tier | Entries | Inclusive sampled time |
|---|---|---:|---:|
| `vk.a(I)V` scene renderer | generated-sync | 669 | 430 ms |
| `ug.a(Lvg;IIIZIII)V` geometry/raster body | scalar | 329 | 276 ms |
| `on.a(Z[IZ[IZZLvg;)V` setup/geometry body | scalar | 329 | 129 ms |
| `hk.b()V` surface body | structured | 40 | 83 ms |

The window lasted 1515.96 ms at 13.19 changed images/s and began with expected
hash `4025147891`; page and console error lists were empty. The entries are
generated-region resumptions, not Java method invocations, so inclusive times
overlap. That distinction is the breakthrough the synthetic toys missed.

The JIT can now capture a one-time portable save state immediately before any
side effect at a selected generated method's PC 0. The captured `vk` artifact
contains its real local argument, caller context, initialized class statics,
and reachable heap graph. The observed capture contained 570 loaded classes and
8,755 graph nodes; it was 38.8 MB as JSON and 587 KB with gzip. It is generated
on demand rather than checked in because a complete game heap may contain
session-specific data. Capture it with:

```bash
FIREFOX_EXECUTABLE_PATH=/path/to/firefox \
PROBE_WAIT_MS=65000 \
PROBE_RENDERER_PIPELINE=1 \
PROBE_TRACE_METHOD='vk.a(I)V' \
PROBE_TRACE_OUTPUT=/tmp/dekobloko-vk-trace.json \
npm run profile:dekobloko:firefox
```

`scripts/benchmarkDekoblokoTraceReplay.js` restores that state, isolates the
captured entry frame, invokes the complete original guest method, discovers the
software surface structurally, and compares its full 75,600-pixel hash after
every round. It also fingerprints all 591 primitive-array and scalar static
fields, catching renderer mutations that do not immediately reach the surface.
This is a replay benchmark rather than a hand-written Java
approximation; HotSpot cannot consume the JVM.js heap encoding. Run it with:

```bash
DEKOBLOKO_REPLAY_ITERATIONS=10 \
DEKOBLOKO_REPLAY_ROUNDS=5 \
DEKOBLOKO_REPLAY_WARMUPS=2 \
npm run benchmark:jvm:dekobloko-trace-replay -- \
  /tmp/dekobloko-vk-trace.json /path/to/classes-original
```

The five-round replay measured:

| Tier | ms/complete `vk` invocation | Invocations/s | Scheduler ticks/invocation |
|---|---:|---:|---:|
| Generated JS | 54.604 | 18.31 | 3,692 |
| Broad scalar JS | 35.883 | 27.87 | 3,689 |
| Composed structured pipeline | **23.856** | **41.92** | **3,689** |

Every tier produced surface hash `780636275` after every measured round; the
591-field static fingerprints also matched. The structured
pipeline is 2.29x faster than ordinary generated JavaScript on this exact live
body, but it does not reduce scheduler transitions. A one-invocation diagnostic
replay found 73 outer `vk` deoptimizations for asynchronous static callees, 13
`on` non-leader scalar entries, and 217 `oj` structured-entry deoptimizations;
the complete call still crossed roughly 3,689 scheduler ticks. This replay now
models the missing inefficiency: repeated partial-region exits and resumptions
across the full scene body, with its actual object graph and raster work. The
next optimizer experiment should be accepted or rejected against this replay
before another 65-second Firefox series.

#### First replay-driven optimization: compile fixed-point long helpers

Scheduler-site attribution showed that the outer deoptimizations were not the
largest transition source. One complete scene invocation spent about 3,456 of
its 3,689 ticks—93.7%—interpreting a small fixed-point helper one bytecode at a
time. The generic generated tier already supported `i2l`, but rejected the
helper's `lmul`, arithmetic `lshr`, and `l2i` sequence. No method identity was
needed to find or enable it.

The generated compiler and fallback runner now implement those three JVM
operations with 64-bit `BigInt` wrapping, the JVM's six-bit long-shift mask,
and signed low-32-bit conversion. An arbitrary-name unit test covers negative
operands and a shift greater than 63. On the captured replay:

| Tier | Before ms/invocation | After ms/invocation | Before ticks | After ticks |
|---|---:|---:|---:|---:|
| Generated JS | 54.604 | 51.042 | 3,692 | 12 |
| Broad scalar JS | 35.883 | 32.527 | 3,689 | 9 |
| Composed structured pipeline | **23.856** | **19.627** | **3,689** | **9** |

The structured replay improved 21.5% and removed 99.76% of scheduler entries.
Every measured round retained surface hash `780636275` and matching 591-field
static fingerprints. This also explains why removing transitions did not make
the complete scene 100x faster: the transitions were numerous but cheap, while
the fused raster work remains the majority of replay wall time.

The rebuilt Firefox bundle produced three runs satisfying the expected initial
hash gate: 14.2833, 13.7969, and 13.9530 changed images/s, for a **13.9530
median**. Transition-interval rates were 13.5691, 13.1071, and 13.2554/s
(13.2554 median). All runs began with hash `4025147891` and had no page or
console errors. Relative to the immediate 13.0409 median this is a 7.0% gain;
relative to the older 13.3303 median it is 4.7%. One additional process sampled
the next non-black state first (`4136367231`) but converged to the same later
surface and had no errors; it was excluded from the expected-initial-hash set
rather than silently treated as an accepted run.

This is the first toy/replay result whose predicted scale agrees with Firefox:
the measured scene region was roughly 28% of the window, and making its replay
about 21.5% faster predicts an overall gain near 6%; Firefox observed 7%.
However, 13.95 FPS is still far from 30 FPS. Reaching 30 requires reducing total
frame time from roughly 71.7 ms to 33.3 ms—more than half—not merely removing
the remaining nine scene transitions. Future work should use the replay to
reduce the large scalar geometry bodies and fused raster workload, while a
separate whole-frame profile accounts for the other ~72% of wall time.

#### Real-input region microbenchmarks

The complete-scene replay can now derive smaller entry traces without inventing
Java approximations. `scripts/deriveDekoblokoRegionTrace.js` restores a parent
trace, runs its original guest body, and captures the first entry of any
requested child. The requested method key is only a diagnostic capture command;
it is never an optimizer allowlist or selection rule. The derived state retains
the actual arguments, receiver graph, initialized statics, and raster surface
from that scene.

The four current cases isolate the two large geometry bodies and the two
wrapper-to-raster chains:

```bash
npm run trace:dekobloko:derive-region -- \
  /tmp/dekobloko-vk-trace.json /path/to/classes-original \
  'ug.a(Lvg;IIIZIII)V' /tmp/dekobloko-ug-trace.json
npm run trace:dekobloko:derive-region -- \
  /tmp/dekobloko-vk-trace.json /path/to/classes-original \
  'on.a(Z[IZ[IZZLvg;)V' /tmp/dekobloko-on-trace.json
npm run trace:dekobloko:derive-region -- \
  /tmp/dekobloko-vk-trace.json /path/to/classes-original \
  'wf.a(IIIIIIIIIIIIZIII)V' /tmp/dekobloko-gradient-wrapper-trace.json
npm run trace:dekobloko:derive-region -- \
  /tmp/dekobloko-vk-trace.json /path/to/classes-original \
  'tb.a(IIIIIIII)V' /tmp/dekobloko-flat-wrapper-trace.json
```

Run all derived cases with:

```bash
npm run benchmark:jvm:dekobloko-regions -- \
  /path/to/classes-original \
  /tmp/dekobloko-ug-trace.json \
  /tmp/dekobloko-on-trace.json \
  /tmp/dekobloko-gradient-wrapper-trace.json \
  /tmp/dekobloko-flat-wrapper-trace.json
```

Unless `DEKOBLOKO_REPLAY_ITERATIONS` is supplied, the suite calibrates each case
to a roughly 50 ms timing round, with a 5,000-invocation cap. It reports opcode
shape, branches, calls, fields, arrays, allocations, handlers, selected tier,
scheduler entries, and optimizer counters. After every round it compares the
entire 75,600-pixel surface and all relevant scalar/primitive-array statics
against the ordinary generated tier.

One five-round Node 26.4.0 run measured:

| Real captured case | Bytecodes | Generated | Scalar | Composed structured | Generated/structured |
|---|---:|---:|---:|---:|---:|
| large geometry/raster body | 592 | 1.659 ms | 1.096 ms | **0.545 ms** | **3.04x** |
| setup/geometry body | 961 | 0.261 ms | 0.133 ms | **0.133 ms** | **1.97x** |
| gradient wrapper to raster | 255 | 5.327 us | 5.455 us | **3.668 us** | **1.45x** |
| flat wrapper to raster | 167 | 2.703 us | 2.262 us | **2.173 us** | **1.24x** |

All five surface-hash rounds and all five static-state fingerprints matched for
all three tiers in every case. The first geometry case contains 24 invokes, 48
field operations, 42 array accesses, 53 branches, and 22 handlers; the second
contains 19 invokes, 58 field operations, 95 array accesses, 49 branches, and
22 handlers. They reproduce the dense mixed guest work that the earlier
handwritten toys omitted.

The boundary is now clear: one wrapper/raster call is inexpensive, although its
high multiplicity can still accumulate. The largest isolated opportunity is the
592-bytecode geometry composition, where combining scalarization with the
structured/fused callees removes about 1.11 ms per captured invocation. The next
toy-driven optimizer should target that generic shape—large reducible integer
CFGs with many array/field operations and synchronously composable callees—and
then validate the predicted whole-scene saving in the parent replay before a
Firefox run.

#### Controlled splitting for the expensive geometry CFG

The focused benchmark exposed a precise structural rejection rather than an
unsupported arithmetic operation: the 592-bytecode body had one
non-dominating retreating edge. A branch before its main face loop could enter
the loop at a secondary block, making the normal-flow CFG irreducible even
though the hot path itself looked like ordinary nested loops. The scalar tier's
`switch (pc)` tolerated that shape, but the lexical SSA renderer correctly
refused it.

The experimental structured renderer can apply bounded controlled SCC splitting
when—and only when—the reducibility proof raises `IrreducibleError`. It clones abstract
CFG blocks rather than altering guest bytecode, redirects external entries into
private copies, and retries the ordinary dominator/reducibility proof. Every
clone retains its original bytecode indices, stack-depth proof, field/call
sites, and exception materialization PC. The transform is capped at 256 total
blocks and at most twice the original CFG size; anything larger or still
irreducible falls back unchanged. Selection uses CFG structure only, with no
class or method names. It is disabled by default after the Firefox acceptance
failure below; enable it only with `jit.structuredIrreducibleSplitting`,
`JVM_ENABLE_STRUCTURED_IRREDUCIBLE_SPLITTING=1`,
`DEKOBLOKO_REPLAY_STRUCTURED_SPLIT=1`, or `PROBE_STRUCTURED_SPLIT=1`.

An arbitrary-name two-entry-loop test exercises both entries and verifies local
state. On the real capture, 39 blocks were cloned, the result structured as
three lexical loops, and the target moved from the scalar tier to structured
SSA. Its emitted JavaScript is approximately 441 KB, which turned out to be the
critical engine-specific cost.

Measured results were:

| Replay | Before | After | Improvement |
|---|---:|---:|---:|
| focused geometry body | 0.545 ms | **0.469 ms** | **14.0%** |
| complete captured scene | 19.627 ms | **17.440 ms** | **11.1%** |

The complete replay retained surface hash `780636275` and the same 591-field
static fingerprint in every one of five rounds across generated, scalar, and
structured tiers. Its generated/scalar/structured times on the final replay
were 50.904, 32.114, and 17.440 ms per invocation respectively.

The first browser series appeared to measure 14.4599, 15.3737, and 14.8179
images/s, but the new split counters remained zero. Investigation found that the
long-running server was serving `/tmp/dekobloko-browser-bundle/jvm-debug-current.js`
while `build:bundle` updated `dist/jvm-debug.js`; that series therefore measured
the previous bundle and is invalid evidence for this experiment. The profiler
now exposes split method/block counters and optional structural compile
diagnostics so this failure cannot remain hidden.

After deploying the exact production bundle, every active run reported two
split methods, 44 cloned blocks, and zero scalar-loop runs. Three fresh Firefox
processes passing the expected initial-hash gate measured 13.1813, 12.3746, and
12.9072 changed images/s, for a **12.9072 median**. Transition-interval rates
were 12.5222, 11.7558, and 12.2619/s (12.2619 median). Every accepted run began
at hash `4025147891` and had no page or console errors. Two additional
error-free runs sampled the next non-black state first and were excluded by the
predeclared hash gate.

That is a 7.5% regression from the previous 13.9530 median, despite improving
the Node/V8 focused and complete-scene replays. The most plausible explanation
is SpiderMonkey optimization/front-end pressure from the approximately 441 KB
duplicated function; removing the scalar dispatcher was not enough to repay the
code-size cost. Controlled splitting therefore remains available only as an
experimental A/B option and is off in the normal renderer pipeline. This is an
important limitation of the replay: it remains a strong semantic oracle and can
identify guest work, but Node/V8 timings do not predict the response of Firefox
to extremely large generated JavaScript. The next experiment should reduce
code size or use a localized state-machine island rather than clone the entire
SCC.

After disabling the experiment, rebuilding, and deploying the exact bundle, a
clean verification run reported zero split methods/blocks, restored 3,163
scalar entries, began at hash `4025147891`, and measured 13.9501 changed
images/s with no errors. Use `PROBE_STRUCTURED_DIAGNOSTICS=1` to make the probe
attempt and report every scalar method's structured compilation after the
timing window; this diagnostic mode is not an acceptance run.

#### Non-overlapping wall-time attribution

Invocation counts are no longer used to decide what is expensive. With
`PROBE_SCHEDULER_TIMINGS=1`, the Firefox probe times complete JVM scheduler
slices and attributes each slice to the guest frame that owned it at entry.
Nested generated, fused, and intrinsic calls are charged once to that outer
frame, so method totals do not overlap. Idle/no-frame slices are separate, and
the report gives milliseconds, percentage of the animation window, and
percentage of measured JVM time. `PROBE_JIT_METHODS` and the older inclusive
per-invocation timer remain off during this measurement.

Use an every-slice diagnostic run with:

```bash
PROBE_RENDERER_PIPELINE=1 \
PROBE_SCHEDULER_TIMINGS=1 \
PROBE_SCHEDULER_TIMING_RATE=1 \
PROBE_JIT_METHODS=0 \
PROBE_JIT_TIMINGS=0 \
npm run profile:dekobloko:firefox
```

Every-slice timing adds observer cost and is therefore not an FPS acceptance
run. In the measured window it reduced the displayed rate from roughly 13.95 to
12.63 images/s. Sampling one in four slices reduced some overhead but missed
rare expensive slices badly—the scene owner estimate fell from 513 to 248 ms—
so duration-weighted conclusions must use rate 1.

The exact 20-image timing window lasted 1,583.16 ms. Non-overlapping JVM slices
accounted for 1,436 ms (90.7%); only 147.16 ms was outside measured JVM calls.
The leading owners were:

| Scheduler-slice owner | Time/window | ms per changed image | Window share |
|---|---:|---:|---:|
| complete scene owner | 513 ms | 25.65 | 32.4% |
| surface body | 130 ms | 6.50 | 8.2% |
| six-int surface/render body | 96 ms | 4.80 | 6.1% |
| three-int guest body | 94 ms | 4.70 | 5.9% |
| Canvas-facing body | 58 ms | 2.90 | 3.7% |
| array/eight-int body | 48 ms | 2.40 | 3.0% |

Those six non-overlapping owners consume 939 ms, or 59.3% of the measured
window. The complete scene remains the largest single target, but it is only a
third of wall time; surface/render work and non-render guest logic together are
large enough that optimizing one method family cannot reach 30 FPS. The next
optimizer should be evaluated by milliseconds removed from this table, not by
entry counts.

#### Exclusive time inside the complete scene

The scheduler timer identifies the complete scene as the largest outer owner,
but deliberately hides its callees. A second diagnostic timer now partitions a
selected generated root into **exclusive** method time: entering a nested
generated or fused region pauses its parent clock, and returning resumes it.
It also records parent-to-child edges using the child's inclusive duration.
Consequently, the exclusive method totals add up to the root duration exactly,
while the edges retain the call hierarchy. This is elapsed time, not an
invocation counter.

Use it independently of the scheduler and older inclusive timers:

```bash
PROBE_RENDERER_PIPELINE=1 \
PROBE_EXCLUSIVE_TIMINGS=1 \
PROBE_EXCLUSIVE_ROOT='vk.a(I)V' \
PROBE_SCHEDULER_TIMINGS=0 \
PROBE_JIT_METHODS=0 \
PROBE_JIT_TIMINGS=0 \
npm run profile:dekobloko:firefox
```

The root key above is only a profiler selection supplied at run time. It is not
embedded in an optimizer or used to select generated code. The timer itself is
disabled by default and the normal path does not read a clock.

In a clean 20-changed-image Firefox run, the animation window was 1,516.58 ms
(13.1876 changed images/s with instrumentation), the accepted adjacent initial
hash was `4136367231`, and both page and console error lists were empty. The
selected scene root accounted for 561 ms (37.0% of the window), and its
exclusive totals also summed to exactly 561 ms:

| Exclusive body | Tier | Time | ms per changed image | Scene-root share |
|---|---|---:|---:|---:|
| gradient raster | fused gradient | 164 ms | 8.20 | 29.2% |
| geometry/face body | scalar | 147 ms | 7.35 | 26.2% |
| transform/project body | generated | 99 ms | 4.95 | 17.6% |
| transform-loop body | scalar | 53 ms | 2.65 | 9.4% |
| geometry helper | structured | 39 ms | 1.95 | 7.0% |
| flat raster | fused flat color | 20 ms | 1.00 | 3.6% |
| scene root's own body | generated | 15 ms | 0.75 | 2.7% |
| remaining measured bodies | mixed | 24 ms | 1.20 | 4.3% |

The measured edge hierarchy resolves the real target:

```text
scene root: 561 ms
├─ geometry/face subtree: 370 ms (66.0%)
│  ├─ geometry/face body itself: 147 ms exclusive
│  ├─ gradient raster: 164 ms
│  ├─ geometry helper: 39 ms
│  └─ flat raster: 20 ms
├─ transform-loop subtree: 153 ms (27.3%)
│  ├─ transform-loop body itself: 53 ms exclusive
│  └─ transform/project body: 100 ms inclusive
├─ small allocation/helper subtree: 23 ms (4.1%)
└─ scene root itself: 15 ms exclusive (2.7%)
```

The largest culprit is therefore the geometry/face subtree, not generic method
dispatch: it costs 18.50 ms per changed image and contains two comparably large
halves, the geometry/control body (7.35 ms/image exclusive) and gradient
rasterization (8.20 ms/image). The scene root's own generated body is only
0.75 ms/image. Optimizing call entry alone cannot remove the 18.50 ms because
most of it is arithmetic, control flow, and pixel work already executing inside
the child bodies. The next focused benchmark and optimizer experiment should
cover the complete geometry-to-gradient path and report milliseconds removed
from both halves.

Finally, three fresh Firefox processes with all timing and invocation probes
disabled measured 13.3303, 13.0468, and 13.9486 changed images/s, for a
**13.3303 median**. Each began at the expected hash `4025147891` and reported no
page or console errors. This confirms that the deployed build remains in the
roughly 13 FPS operating range; it does not establish a performance change
against the earlier 13.9530 median because the two medians were not collected
as an interleaved same-build A/B experiment.

Useful workload overrides are:

```bash
DEKOBLOKO_TOY_INVOCATIONS=100 \
DEKOBLOKO_TOY_PASSES=40 \
DEKOBLOKO_TOY_ROUNDS=5 \
DEKOBLOKO_TOY_WARMUPS=3 \
npm run benchmark:jvm:dekobloko-hot-loops
```

Renderer-traffic workload overrides are:

```bash
DEKOBLOKO_TRAFFIC_INVOCATIONS=10 \
DEKOBLOKO_TRAFFIC_PASSES=2 \
DEKOBLOKO_TRAFFIC_ROUNDS=5 \
DEKOBLOKO_TRAFFIC_WARMUPS=3 \
npm run benchmark:jvm:dekobloko-renderer-traffic
```

## 2026-07-21: quantum continuation, resume bodies, and broad structured coverage

Three related changes were made after profiling the captured `vk` replay with
per-method attribution. All were validated by the checksum-gated replay
(surface hash `780636275`, 591-field static fingerprint `3248835056` unchanged
across every tier and round) plus the `ug`/`on` derived-region replays, whose
surface and static hashes also matched across all three tiers.

1. **Need-based safe points (`continueQuantum`).** A generated region's
   10,000-iteration safe-point budget previously forced a deopt even when the
   scheduler had nothing to do. At the budget boundary, regions now keep
   running when there is no debugger, no deterministic clock, no other
   runnable Java thread, no expired sleep/wait deadline, and the wall-clock
   event-loop yield deadline (`_nextEventLoopYieldAt`, re-armed by
   `JVM.execute` after every real host yield) has not passed. Applied to the
   structured SSA loop safe point, scalar backedge safe point, baseline
   sync/async quantum, and stackless raster quantum. Deterministic/fake-clock
   runs always yield, preserving reproducible scheduling; a dedicated test
   covers the solo-thread, contended-thread, expired-deadline, and
   sleep-deadline cases. The replay harness previously never re-armed the
   deadline, which silently disabled this policy; it now mirrors
   `JVM.execute`'s re-arm exactly.

2. **Resume bodies for PC-0 tiers.** The structured, scalar, and stackless
   tiers enter only at PC 0 (or block leaders). A frame that exited mid-method
   (safe point, transient deopt, async callee) finished its invocation one
   interpreted bytecode per scheduler tick: a diagnostic replay showed
   `vk.a(I)V` accumulating 29,951 entry deopts and 59,901 scheduler frames
   once it became structured-eligible, and `oj`'s post-safe-point remainders
   had been crawling in the interpreter all along (217 entry deopts per
   3-invocation profile). `compileMethod` now pairs every fast-tier body with
   a baseline generated companion and dispatches on `frame.pc === 0`; the
   dispatcher forwards the fast body's metadata and source. This removed the
   deopt storm completely (scheduler ticks back to 5 per complete scene
   invocation).

3. **Broad structured-SSA opcode coverage.** Rejection-reason attribution on
   the hot bodies found small, generic gaps: `em.a(Lvg;ZIBI)V`
   (transform/project family) was rejected only for a cold obfuscator-path
   string `ldc`; `vg.a(I)V` only for `putfield`; `vk.a(I)V` failed operand
   verification because `stackEffect` did not know `d2i`. The renderer now
   covers double/float loads, stores, constants (`ldc`/`ldc2_w` including
   string interning and BigInt longs), arithmetic, `fround` float semantics,
   `dcmpl/dcmpg/fcmpl/fcmpg`, `d2i/f2i` matching the baseline tier's
   truncate-and-wrap narrowing exactly (tier consistency over spec purity at
   the ±infinity edge), `i2s/i2c`, `putfield` (null-checked, materialized),
   `new` (class-initialization guarded), `dup2` (two category-1 form with a
   BigInt runtime deopt guard, mirroring the interpreter), all primitive
   array loads/stores, `d/f/l` returns, and dynamic calls
   (`invokevirtual`/`invokespecial`/`invokeinterface`) through the existing
   `tryInvokeSyncAt` monomorphic-cache machinery. No class or method names
   participate in selection. A differential unit test compares the structured
   and baseline tiers on a double/putfield loop.

On the captured complete-scene replay (Node 26, five iterations, three
rounds), the structured pipeline improved from 100.0 ms to **83.8 ms** per
`vk` invocation (-16%), with the generated and scalar control tiers unchanged.
The derived setup/geometry region (`on.a`) improved from 132 us to **45 us**
per invocation under the composed pipeline. In the production Firefox bundle,
structured compiled loops rose from 51 to **193** and structured entries from
about 239,000 to over 315,000 per probe window, with zero scalar-loop
safe-point exits, empty page/console error lists, and the expected initial
surface hash `4025147891`.

The Firefox acceptance series (build 1509, production bundle, composed
renderer pipeline, no timing probes) measured 12.9097, 13.7882, and 14.2880
changed images/s, for a **13.7882 median**. Every run began at expected hash
`4025147891` with empty page and console error lists. Relative to the prior
13.3303 clean median this is +3.4%; relative to the earlier 13.9530 median it
is -1.2%. Both deltas are inside the observed process variance, so this
revision is recorded as neutral-to-slightly-positive in Firefox despite the
-16% replay improvement — another instance of the established pattern that
Node/V8 replay gains do not transfer one-to-one to SpiderMonkey. The changes
are retained because they are checksum-neutral, strictly reduce dispatch and
interpreter-crawl work, and materially widen structured coverage (51 to 193
compiled loops) that later compiler passes can build on. The remaining path
to 30 FPS is unchanged: reduce the geometry/raster subtree's actual
arithmetic/pixel cost (structured-region code-size-aware handling of the
irreducible `on.a`/`ug.a` shapes, then whole-region Wasm with a stable heap
interface), not more entry/dispatch tuning.

## 2026-07-21 (later): dispatch islands, compact emission, and the opcode-eligibility trap

This revision attacked the two largest wall-time blocks from a fresh
rate-1 scheduler attribution (window 1,532.7 ms for 20 images, 90.8% inside
measured JVM slices): the scene subtree under the complete scene owner
(439 ms, 28.6%) and a previously hidden interpreter tail of roughly a dozen
hot-but-never-compiled methods totaling ~233 ms (~15%). A fresh exclusive
breakdown of the scene root (462 ms inclusive) showed the two irreducible
scalar bodies as its largest halves: the geometry/face body at 134 ms
exclusive (335 ms inclusive) and the surface body at 70 ms exclusive, ahead
of the fused gradient raster at 136 ms.

### Structured dispatch islands (kept)

The structured tier now makes a multiple-entry strongly connected component
reducible by routing every edge into its entries through a synthetic
dispatcher: rerouted edges record their destination in a per-island state
variable and jump to a chain of state-test blocks that fans back out to the
real entries. Setter blocks are duplicated by provenance (inside/outside the
component) so each back edge targets a header that dominates it, entries at
nonzero operand depth pass their live operands through island transfer slots,
and the dispatcher loop's safe point materializes per-state (the resume pc is
the selected entry's first instruction). Unlike the previous SCC clone
(441 KB, −7.5% Firefox), code growth is a constant number of empty blocks.
Checksum-gated region replays: surface body 18.7 → 5.1 ms per round (3.7×),
geometry/face body 63.5 → 29.5 ms (2.2×), identical surface and static
hashes on every tier and round. The complete-scene replay improved from
646 to 551 ms per round.

### Compact emission via one spill closure (kept)

The first island build emitted 318 KB of source for the surface body and
Firefox showed no scene-subtree gain despite the −16% replay — consistent
with SpiderMonkey declining to fully optimize very large function bodies
(the same failure mode as the 441 KB clone). The renderer's frame
reconstruction repeated a full locals copy at hundreds of guard, call, and
return sites; hoisting it into a single per-body `spillLocals()` closure cut
the surface body to 134 KB (−58%) with unchanged checksums.

### Widened opcode eligibility (implemented, kept OFF)

The interpreter tail was blocked from every generated tier by stale opcode
allowlists, not by the compiler: the baseline emitter's `default:` case
deopts on `lload`/`ladd`-family long operations, `instanceof`, `dup_x1`, and
`i2s`/`i2c`. All of these are now implemented with interpreter parity.
Two important lessons:

1. **Long operands must be defensively converted.** Longs are BigInt on the
   fast path but arrive as plain Number 0 from uninitialized fields; the
   interpreter wraps every operand in `BigInt()` and the first build that
   did not crashed the whole game at boot ("can't convert BigInt to
   number"), including through the pre-existing `l2i`/`lcmp` emissions. All
   long emissions now mirror the interpreter's conversions exactly.
2. **Individually faster methods can still be a whole-app regression.**
   With eligibility widened, every unlocked method got individually faster
   in the rate-1 owner table (e.g. the largest tail method fell from 50 ms
   to 16 ms per window), yet the six-run acceptance median fell from
   13.79 to 12.77 images/s. One unlocked 40-instruction long-returning
   helper was measurably slower compiled than interpreted (20 → 34 ms per
   window at ~700 calls). The A/B with identical islands+emission code and
   eligibility reverted restored the best-ever median (below), so the
   widened lists sit behind `EXTENDED_TIER_OPCODES_ENABLED = false` in
   `JitCompiler.js` with the measurement recorded next to the flag.

### Acceptance series (3-run medians, expected hashes, empty error lists)

| Bundle | Runs (changed images/s) | Median |
|---|---|---:|
| Prior revision (baseline) | 12.91 / 13.79 / 14.29 | 13.79 |
| + widened eligibility (6 runs) | 12.37–13.79 | 12.77 |
| + dispatch islands | 13.33 / 13.48 / 13.80 | 13.48 |
| + spillLocals | 12.91 / 13.04 / 13.48 | 13.04 |
| islands + spillLocals, eligibility OFF | 13.64 / 14.12 / 14.12 | **14.12** |

The final configuration is the first clean acceptance median above the
project's previous best (13.95). The kept changes are the dispatch islands
and the compact emission; the opcode implementations remain in the tree
(correct, tested, boot-verified) awaiting an explanation of the whole-app
cost — likely candidates are IC/GC pressure from many more compiled bodies
and generated-entry overhead on tiny non-loop helpers — before their
eligibility returns.

## 2026-07-21 (later still): the handwritten upper-bound experiment

The question this session answered: if a human hand-wrote the hottest scene
kernel as idiomatic JS, how much faster would it be than the JIT's best
output — and does closing that gap move whole-app fps?

Method (all correctness checksum-gated):

1. Captured the real workload: replaying the vk trace against the original
   jar classes with an instrumented `FusedRegionCompiler.tryInvoke` yields
   every fused wrapper call — 2140 gradient triangles + 464 flat-color spans
   per scene render. (The transformed `/tmp/dekobloko-full-pipeline` classes
   have only 5 scanline calls in `oj.a`, so the fused family never verifies
   there — fused tiers are browser/original-jar-only.)
2. Dumped the generated fused kernels (`Function.toString()`), then built an
   acorn/escodegen partial evaluator that folds the region guard's invariant
   (`client.field_A === 0`) through them: 113 → 81 raster cases, every
   obfuscator diagnostic path dead.
3. Hand-translated the pruned kernel into structured JS: real loops, statics
   hoisted to locals, no pc-switch, no s-var shuffling.
4. Benchmarked all variants inside Firefox via Playwright on the captured
   triangle stream with FNV hash equality as the gate.

Firefox results (20 scene passes of the 2140-triangle stream, hash-identical):

| variant | median | speedup |
| --- | --- | --- |
| generated fused kernel | 79ms | 1.00x |
| + statics hoisted | 76ms | 1.04x |
| guard-justified pruning | 55ms | 1.44x |
| pruning + hoisting | 51ms | 1.55x |
| handwritten structured | **8ms** | **9.9x** |

(V8 aside: the same statics hoist is a 20% *regression* in V8 while being a
win in Firefox — engine non-transfer again — and the handwritten kernel is
18.3x in V8.)

Deployment: `src/jit/HandwrittenFusedGradient.js`, installed by
`FusedRegionCompiler.compile` behind (a) an exact bytecode fingerprint of
wrapper+raster+scanline (4128814000 for dekobloko — these shared obfuscated
classes are arg-reordered per build, so a shape match is not enough), and
(b) a per-call layout pre-flight (linear row table, destination bounds) that
delegates to the generated kernel before any side effect when anything is
non-standard. With both passed, no path in the handwritten raster can throw,
so the generated kernel's per-scanline guards and state-capture snapshots are
provably dead. Kill switch: `JVM_DISABLE_HANDWRITTEN_FUSED=1`. Validated by
the 2140-triangle hash gate, 400+800 randomized differential iterations
(including an extended ±30 out-of-bounds coordinate range), 299 jit tests,
clean boot, and acceptance.

Acceptance: 13.79 / 14.46 / 14.81 → **median 14.46, new best** (prior 14.12).

**The bigger finding: the old attribution was inflated by its own probe.**
The browser exclusive-timing capture charged `wf.a` 584ms per 2s window
(~29% of frame time), but the isolated Firefox measurement of one full
scene's gradient load is ~4ms — at ~14 scenes/s that is ~5% of frame time.
The per-call exclusive-timing instrumentation (211k samples per window)
dominates its own measurement for cheap-but-frequent calls. A 9.9x kernel
win therefore moved whole-app fps by only ~+0.3. Every attribution number
derived from per-call timers is suspect in proportion to call frequency;
`tb.a` flat-color (46k samples/window) is likely similarly overstated.

Follow-ups this implies:

- Re-derive attribution probe-free: native Firefox sampling profiler, or
  differential feature A/Bs (disable one tier per run, measure fps delta).
  Do this before optimizing anything else.
- The handwritten kernel is the proven target shape for the structured
  emitter: structured control flow, statics hoisted once per body, invariant
  flags folded through (the falseGuardTargets partial evaluation), guard
  elimination where a pre-flight proves them dead. Generalizing those into
  JvmSsaBlockRenderer/FusedRegionCompiler is the "make the JIT emit what the
  human wrote" step, and unlike the one-off kernel it compounds across all
  hot methods.
- The flat-color family can get the same handwritten treatment cheaply, but
  its real share is probably small once probe inflation is discounted.

## Where to optimize next

Do not assume the large raster or yield policy is still dominant. Re-profile
only the post-nonblack interval on the current revision. Prefer general,
structurally guarded compiler improvements over game class-name allowlists.
Promising work must show all three:

1. a repeatable changed-frame improvement over several same-environment runs;
2. live differential equality or a comparably strong semantic oracle; and
3. correct materialization at exceptions, class initialization, debugger
   boundaries, calls, and scheduler yields.

If an experiment is neutral, revert it and add the result here. Smaller code
with a recorded negative result is more useful than accumulating speculative
fast paths.

### Structured natural loops: completed foundation and remaining work

The planned JVM SSA/block renderer now exists. For accepted methods it replaces
the scalar compiler's `while (true) { switch (pc) { ... } }` dispatcher with
nested JavaScript `while`/`if`, labeled `break`, and labeled `continue` control
flow. The implementation status against the original roadmap is:

1. **Completed:** normalized bytecode is divided into explicit blocks and passed
   through the existing Ramsey structurer, which supplies dominators, backedge
   classification, merge blocks, loop nesting, and reducibility checks.
2. **Completed:** instruction results receive unique SSA-style JavaScript values;
   predecessor edges feed live operand values into fixed successor join slots.
   A non-empty loop-carried operand has a dedicated differential/safe-point test.
3. **Conservative:** heap reads and writes remain direct verified operations,
   with calls acting as materialization/effect boundaries. The rejected
   cross-block field-cache experiment is evidence not to add memory guards until
   a real alias/effect analysis can remove more work than it introduces.
4. **Completed for the supported subset:** only single-entry reducible methods
   without switches are structured. Irreducible CFGs, switches, unsupported
   bytecodes, and meaningful recovery handlers retain the older scalar,
   stackless, generated, or interpreted implementation.
5. **Partial:** constant expressions and verified integer leaves are emitted
   directly, but global copy propagation, redundant-join elimination, dead-value
   elimination, global value numbering, LICM, and memory SSA remain future work.
6. **Completed for supported throwing operations:** null, bounds, arithmetic,
   cast, field, class-initialization, call, explicit-throw, debugger, and safe
   point exits reconstruct the bytecode PC, locals, and operand order. Caught
   exceptions resume through the normal JVM path rather than re-entering a
   partially executed structured region.
7. **Completed at loop headers:** a bounded 10,000-entry budget reconstructs the
   ordinary `Frame` before yielding. A face-boundary safe point remains necessary
   if the complete model/face body becomes one accepted structured region.

The current capability set is intentionally explicit: integer/reference loads
and stores, constants, stack `dup`/`pop`, integer arithmetic/shift/divide/
remainder/conversion, branches, `int[]`/`short[]`/reference-array loads, checked
integer stores, array length/allocation, casts, instance/static reads, static
writes, synchronous static calls, verified integer-leaf inlining, returns, and
rethrow-only handlers. Dynamic calls, `putfield`, switches, float/long bodies,
monitors, meaningful catch recovery, and other unimplemented opcodes fall back.

The useful counters now record compiled loop headers, successful structured
entries, safe points, and per-method entries. A diagnostic run found 19 compiled
loop headers and roughly 168,000--176,000 entries. It also taught an important
tier-composition rule: a new tier can steal a method from a mature tier and
regress even when its control-flow shape is better. The 27-bytecode loop called
an integer leaf about 130,000 times; only after the SSA renderer reused the
existing verified leaf-inline plan did the composed pipeline recover from 12.25
to about 13 images/s.

The three-run same-bundle acceptance was satisfied for correctness and relative
improvement, but not for the absolute target: the composed median is 13.0388
images/s versus 12.1244 without structured SSA, and still below 20. The tier and
the one-switch composed pipeline therefore remain opt-in. The next compiler
work is to add rejection-reason attribution, identify the precise unsupported
operation or CFG shape in the 593-item body, extend only that generic capability,
and repeat the differential and Firefox A/B. A handwritten method replacement
or an obfuscated-name allowlist remains unacceptable.

### Secondary projects, in priority order

1. **Guarded devirtualization for complete regions.** The intermethod benchmark
   shows a large dynamic-dispatch gap, but this should follow actual hot-call
   attribution and must guard runtime type plus exact target identity.
2. **Whole-region Wasm with a stable heap interface.** Compile only when the
   complete loop and callees stay in Wasm, or batch array/field traffic so the
   boundary is crossed once per face/model rather than once per operation.
3. **Scalar replacement of short-lived guest objects.** Use escape analysis;
   materialize objects before calls, exceptions, debugging, monitors, native
   exposure, or snapshots.
4. **Overdraw/geometry work reduction.** This may ultimately matter more than
   dispatch, but it must preserve Java rendering semantics and cannot be a
   game-name-specific shortcut.

Do not prioritize canvas upload, scanline arithmetic, Java thread-to-worker
mapping, more frequent yielding, call-stack container push/pop, or another
guarded field cache unless new profiling contradicts the evidence above.

## Native Firefox sampling: the actual post-raster bottlenecks

The high-frequency exclusive timer attribution above was replaced with a raw
Gecko sampling profile. Generated JavaScript functions now receive stable
profiler names derived from the runtime method identity, descriptor, and
compiler tier. These names are diagnostic metadata only: optimizer selection
continues to use descriptors, bytecode/CFG structure, and verified callee
shapes, never game method or class names.

The labeled run used a 1 ms interval and the `js`, `stackwalk`, and `cpu`
features. It produced the expected initial surface hash, no runtime errors, and
20 changed images at 14.29 changed images/s under profiler overhead. The exact
post-nonblack interval was `[50383.40, 51783.14)` ms: 1,400 Gecko samples.

The largest leaf costs in that window were:

| leaf | samples | whole window |
| --- | ---: | ---: |
| `getStaticSyncAt` | 160 | 11.4% |
| partial-Wasm field import | 57 | 4.1% |
| partial-Wasm array imports | 70 | 5.0% |
| two largest structured guest bodies, combined self time | 60 | 4.3% |
| Wasm exit trampoline | 28 | 2.0% |
| `elemsOf` plus reference conversion | 48 | 3.4% |
| `getFieldAt` | 20 | 1.4% |
| fused flat raster | 19 | 1.4% |
| `executeTick` | 18 | 1.3% |
| `tryInvokeSyncAt` plus `tryInvokeResolvedTarget` | 15 | 1.1% |

There were 571 samples (40.8%) containing a named generated guest frame and
283 (20.2%) on the partial-Wasm path. A separate unlabeled capture attributed
about 41% to partial Wasm; run-to-run tier composition varies, so the exact
aggregate is less stable than the repeated observation that host imports and
boundary machinery consume more time than the Wasm arithmetic itself.

This resolves the earlier ambiguity:

- Generic Java call dispatch is not currently the largest cost. Its directly
  sampled helpers are around 1% of the window.
- Canvas/AWT and the raster arithmetic are not the missing path to 30 fps.
- The hottest guest owners are the model/face routines, but most of their
  inclusive samples land in JVM helpers rather than their own arithmetic.
- The first generic follow-up was initialized-static specialization: resolve
  an exact static slot once, retain mutable value reads, and bypass repeated
  field-site and class-state map lookup only while initialization and debugger
  guards hold. Its result is recorded below.
- Partial Wasm should become a whole-region backend with a stable heap
  interface or be avoided for reference-heavy loops. Crossing into JavaScript
  for individual array, field, and reference operations defeats the purpose of
  compiling a small arithmetic fragment to Wasm.

Raw profiles can be analyzed without enabling any JVM timing probe:

```sh
npm run analyze:dekobloko:firefox-profile -- \
  /tmp/dekobloko-gecko-named-PID.json \
  --url 127.0.0.1:3766 --start 50383.40 --end 51783.14
```

The analyzer selects the matching content `GeckoMain` thread, walks raw stack
tables, and reports top leaf frames plus inclusive and self samples for all
generated guest functions. Each optimization should be measured on an exact
animation window with this probe-free method, then validated with the existing
surface-hash and differential checks.

### Initialized-static specialization result

The structured SSA compiler now resolves static storage locations while it is
building a method, emits one class-initialization guard at method entry, and
then emits direct `Map.get`, `Map.set`, or object-property access. This remains
fully structural and class-name independent. It binds the storage location,
not the value, so static mutations after compilation remain visible. If any
participating class is not initialized, the guard returns to the existing JVM
path before executing a guest side effect. Debug entry still takes the older
path first.

Save states do not retain a stale binding: `loadState` installs restored static
maps and then constructs a new `JitCompiler`. Generated JavaScript and its
direct-static target table are deliberately not serialized.

Focused tests verify mutable post-compilation values, inherited field storage,
the before-side-effects initialization fallback, and profiler identity
metadata. The exact command passed 311 assertions:

```sh
timeout 90s node node_modules/tape/bin/tape test/jitCompiler.test.js
```

The production bundle rebuilt successfully. Three probe-free Firefox runs on
the same profiling-server bundle measured:

| run | changed images/s | elapsed for 20 images |
| ---: | ---: | ---: |
| 1 | 14.998 | 1333.50 ms |
| 2 | 14.627 | 1367.32 ms |
| 3 | 15.192 | 1316.48 ms |
| **median** | **14.998** | |

The previous best median was 14.46, so this is about a 3.7% whole-application
improvement. All runs had the expected first animation hash `4025147891` and
no page or console errors.

A second 1 ms Gecko capture confirmed the intended mechanical result:
`getStaticSyncAt` fell from 160/1400 samples (11.4%) to zero in the measured
animation window. The time did not all become frame rate because the next
bottleneck expanded into the available CPU budget. Partial Wasm occupied
365/1333 samples (27.4%), including 7.4% in field imports, 4.7% in array
imports, 4.4% in reference conversion, and 3.5% in the Wasm exit trampoline.
The capture itself rendered at 15.00 changed images/s with correct hashes and
no runtime errors.

Wasm modules now also carry a standard function-name custom section derived
from the runtime owner, method identity, descriptor, and tier. Like the
JavaScript profiler labels, this metadata never participates in optimization
selection. The next capture identified the partial-Wasm owners:

| Wasm guest body | inclusive samples | field-import leaf | array-import leaf |
| --- | ---: | ---: | ---: |
| `hk.a(IIIIII)V` | 149 (11.8%) | 41 | 14 |
| `hk.b()V` | 110 (8.7%) | 29 | 17 |
| `ck.a(IIIIIIII)V` | 65 (5.1%) | 4 | 16 |

This exposed a plausible tier-ordering experiment: the asynchronous nested-call
path asked partial Wasm before using an available complete synchronous
structured-JavaScript body. Reversing that order was correct but slower:

| run | JS-first changed images/s |
| ---: | ---: |
| 1 | 13.946 |
| 2 | 14.814 |
| 3 | 14.110 |
| **median** | **14.110** |

That is 5.9% below the 14.998 direct-static median. The runtime tier-ordering
change was therefore reverted. The important conclusion is subtler than
"partial Wasm is bad": boundary traffic is expensive, but these Wasm kernels
still save more arithmetic time than the boundary costs. Moving the same guest
bodies wholesale to the current JavaScript emitter does not solve it.

The next optimization should target the boundary *inside the winning Wasm
tier*, not generic invoke dispatch, another raster micro-kernel, or blanket
JS-first policy. Promising shapes are larger linked Wasm regions, batched
array/field access, or a stable heap representation that lets repeated
operations remain inside the module. The checked-in analyzer now reports
named Wasm owners and attributes field/array import leaf samples to them.

Source-map resolution found one more concrete boundary cost: the largest leaf
in the named-Wasm capture, minified as `S` (91/1266 samples, 7.2%), maps to
`toWasmValue` in `WasmJit.js`. Every generated import already has one fixed
result type, but integer and reference field/array reads still passed through
that shared polymorphic converter on every access.

The retained follow-up specializes those import closures when the module is
built. Integer imports perform only Java-boolean normalization; reference
imports return the reference directly; long/float/double imports retain the
generic converter. This changes no tier selection, bounds/null checks, heap
location, or write behavior.

Three probe-free Firefox runs measured:

| run | specialized-import changed images/s |
| ---: | ---: |
| 1 | 15.182 |
| 2 | 15.392 |
| 3 | 14.123 |
| **median** | **15.182** |

That is 1.2% above direct-static alone and 5.0% above the previous 14.46 best
median. Every run completed 20 changed images without page or console errors.
Two captured the usual first animation hash `4025147891`; the other 16 ms
sampling pass first observed the following known state `4136367231`.

## Wasm boundary traffic: field-value caching, batched spill, key inline cache

The named-owner capture left three boundary costs inside the winning partial-
Wasm tier: field imports (7.4%), array imports (4.7%), reference conversion
(4.4%), and the exit trampoline (3.5%). Three changes attack the import-call
count itself rather than the per-call conversion cost.

**Field-value caching in wasm locals.** `getstatic` results and
`aload s; getfield f` results now live in a pair of wasm locals (value +
filled flag). A repeated read — including across loop iterations, which is
where `hk.a`'s 41 field-import leaf samples came from — becomes a branch on
the flag instead of a wasm→JS import call. Soundness leans on the tier's
existing structure:

- wasm locals zero on every `run()` entry, so caches start invalid per run;
- a `putfield`/`putstatic` of the same `name:descriptor` clears every
  matching flag (inheritance can alias two owner classes onto one storage
  key, so the kill ignores the owner class);
- linked wasm callees may write any field, so calls clear all flags (Math
  intrinsics are pure and exempt);
- a store to slot `s` clears caches keyed on `s` and strips the compile-time
  provenance of values still on the simulated stack, so a stale receiver can
  never seed a cache for the slot's new object;
- no import in this tier runs guest code or a scheduler switch, so nothing
  else can write a field mid-run.

The dry pass discovers the full cache-entry set and pass 2 reuses it, so a
kill site emitted early in block order still covers a cache whose fill
compiles later — the alternative (per-block discovery) misses kills across
backedges. The cached instance path skips the null check: a filled flag
proves the same slot's object already loaded this field successfully in this
run. Kill switch: `JVM_DISABLE_WASM_FIELD_CACHE=1`.

**Batched exit spill.** Exit stubs previously spilled locals with one import
call per typed slot, and the stub is replicated into every block's fuel
prologue. One `spill_all` import now writes every slot in a single call —
fewer boundary crossings on the trampoline path and a smaller module.

**Monomorphic field-key cache.** The instance field import resolved its
storage key through a `Map.get` per access. Nearly every site is
monomorphic, so the closure now keeps the last class's key one identity
compare away.

Validation: the full jit suite passes (315 assertions, including a new
fixture whose loops mix cached reads with mid-loop `putstatic`/`putfield`
writes and a receiver-slot swap — the sums are wrong if any kill is
missing). The captured vk replay on original classes produces bit-identical
round hashes with the wasm tier off, on, and on-with-caching-disabled. Node
replay medians (V8, single runs, structured config): caching on 270.1 ms,
off 276.3 ms.

The profiler gained `PROBE_WASM_JIT` and `PROBE_WASM_FIELD_CACHE`
live-toggle overrides, and the attribution loop gained `no-wasm-jit` and
`no-wasm-field-cache` configurations, so the next attribution pass measures
the whole tier's and this change's honest whole-app contributions.

Interim differential attribution (n≈24 per config, loop still running):
disabling fused regions costs −1.36 fps and is the only configuration
separated from noise; disabling the handwritten gradient kernel measures
+0.00 — the honest confirmation of the probe-inflation finding. Disabling
structured SSA measures −0.00 with partial Wasm active, i.e. the tiers
overlap: wasm absorbs the bodies structured SSA used to carry.

Design conclusions recorded from this round:

1. **Exit transitions are synchronous control transfers, not waits.** There
   is nothing to overlap with threads or a message queue; bytecode needs
   each result before the next instruction. The lever is fewer/cheaper
   crossings, which is what call linking, field caching, and batched spill
   do.
2. **Data first, then code.** Moving the scheduler/JVM core into wasm while
   the heap stays JS-side would multiply import traffic. The enabling step
   is heap residency — primitive arrays as typed-array views over a shared
   `WebAssembly.Memory`, so `iaload` becomes a memory load for wasm and
   plain indexing for JS — after which moving more runtime code into wasm
   stops costing conversions.
3. **No toy-benchmark roadmap.** Piece-wise toy wins have twice failed to
   compose here (handwritten toys mispredicting Firefox; the 9.9x kernel
   moving the app +0.3 fps). Captured replays validate kernels; whole-app
   differential A/Bs decide what is real.

## Guard-tolerant partial callee linking (deopt on the never-path)

The user's observation that obfuscator guards are `if (never) throw x` turned
into a linking policy: a wasm callee whose normal flow still contains
unsupported blocks now links anyway ("partial"), because those blocks are
almost always diagnostic paths behind a boolean static that never flips.
Before this, one such block anywhere in a callee forced the caller to exit
wasm at every call site — the mid-computation transitions worth eliminating.

Mechanism: at a linked call to a partial callee the caller first spills its
typed slots (one batched `spill_all`), and the site requires an empty operand
stack under the arguments (void statement calls — the raster family shape —
qualify). The callee runs against a reusable scratch `Frame`; the frame stays
clean unless the callee actually exits, so the never-deopts path allocates
nothing. If any callee in the nested chain reaches a demoted block, its exit
stub spills into the scratch frame, and the import closures unwind with a
`NestedDeopt` carrying the frames innermost-first: each level stamps its
caller's resume pc (the item after the invoke — the interpreter increments pc
before dispatch, so returns land correctly), the top-level `execute()`
pushes the chain onto the Java call stack, and the scheduler resumes it
interpreted. Runtime counters veto a callee whose "never" path turns out hot
(>256 deopts and >25% of calls), and the caller's periodic recompile then
drops the link. The JS-jit runner treats a nested deopt as a transient yield
even when it could otherwise continue the child itself, since deopt frames
sit above the child.

Validation: 322 jit assertions, including a fixture whose helper guard flips
true mid-loop — the deopt round trip produces exact sums, the diagnostic
path executes interpreted with correct state, and deopts count only while
the guard is hot. The vk replay stays bit-identical. In the replay, `wf.a`
now links; most other raster callees still defer because their entry blocks
read statics of classes the replay never initializes (`client.A` etc.) —
a replay artifact, not a policy failure; the browser initializes those
classes, so linking should engage more broadly there.

Follow-on lever, per the same exceptions-are-exceptional assumption: blocks
inside LIVE exception-handler ranges are still demoted wholesale because a
live handler needs precise state at the throw. With wasm exception handling
(supported in Firefox), those blocks could compile speculatively: wrap the
block body in a wasm `try`; on `catch_all` the wasm locals are exactly the
precise state, so spill them, then rethrow to the interpreter's handler
dispatch. `checkcast` (an import calling isInstanceOf) and carried-stack
shapes at demoted-adjacent blocks are the other remaining demotion sources.
