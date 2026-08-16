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
For the latest retained implementation, measurements, rejected experiments,
and next action, see
[the consolidated fused-renderer handoff](#2026-07-22-consolidated-handoff-the-fused-recompiled-renderer-investigation).

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
| Structured SSA block renderer | primitive-array loops | Default verified subset; broader acyclic-region experiment remains opt-in |
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
`JVM_DISABLE_STRUCTURED_SSA=1` disables the default verified
primitive-array-loop subset for a baseline differential.

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

### A slot that looks dead may just be an unkinded phi

A structured Wasm module writes SSA values back to `frame.locals` only at a
mid-method exit, and only for slots in the block's `slotDefsIn` whose value has
a kind. A phi left unkinded is therefore read as a *dead slot* and dropped from
the spill, so the interpreter — or a dispatcher OSR module re-entering at that
pc — resumes on whatever the last user of that reused frame left behind.

An unkinded *loop-header* phi is exactly a loop-carried slot: an induction
variable or a loop bound. Resuming a sequential fill loop on a stale counter
overruns its array by however far the counter drifted, which reads as
`Index N out of bounds for length N`. On Tomb Racer this crashed `kr.e`'s
bit-stream decoder, where every loop bound is itself read from the stream.

The cause was that `fillPhiArgs` derived kinds in a single reverse-postorder
pass. When a loop-header phi takes its back-edge argument from another phi, one
pass kinds the inner phi only *after* it has already given up on the header one.
Kinds must be iterated to a fixpoint. That also makes the drop filter sound
rather than merely lucky: `mergeKind` is identity on `null` and returns a
distinct `CONFLICT`, so after the fixpoint an unkinded phi provably carries no
typed value on any path, and every dropped slot is unassigned, an all-null phi
closure, or a genuine type conflict the verifier makes unobservable.

Two diagnostics exist for this class. `JVM_WASM_TRACE_RESUME=*` reports OSR
re-entries that land on the pc a structured exit just left, separating slots
DROPPED by the filter (had a reaching def — a real loss) from slots merely
ABSENT from `slotDefsIn` (never assigned — sound). `JVM_WASM_CLEAR_DROPPED=1`
zeroes dropped slots so an unsound drop fails loudly instead of decoding
garbage. `JVM_WASM_NO_OSR_METHODS=<substr,...>` bisects one module's OSR
companion out of a whole boot.

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
- **A deterministic non-realtime clock was drastically worse, not faster.** The
  scheduler's `_idleWaitDelay` returns 0 when the clock is deterministic and not
  realtime, which looks like a free way to delete the 13% of Tomb Racer's boot
  spent idle. Measured, `JVM_FAKE_TIME_REALTIME=0` took 173.2 s to finish the
  logo alone against 21.5 s normally, and the boot timed out at 500 s. That idle
  is the guest's own poll loop (4328 waits, 97% as `SLEEPING(timed)x2
  WAITINGx3`, mean 4.8 ms) and is proportional to wall time, so it shrinks as
  CPU work drops rather than being separately removable.
- **Detecting SSA copies by line match instead of by parse is unsound.** The
  copy-coalescing pass in `JvmSsaBlockRenderer` parses every generated plan with
  acorn on every compile just to find `const ssaValueA = ssaValueB;`, and acorn
  is the entire `node-modules` bucket of the boot profile — 7.6 s, 5%. Matching
  that shape with a regex over `plan.lines` passed 2762 tests and three boots,
  then miscompiled: `parsedPlan.statements` are *top-level* statements only, so a
  line scan also matches block-scoped copies, aliases them globally and deletes
  their declarations. A profiled boot died on a jitted `saload` reading index 576
  from a length-124 array. Reverted. The cost is still worth removing, but the
  coalescing has to happen at emit time, where the emitter knows the scopes —
  not by pattern-matching emitted text afterwards.
  **Correction:** that crash was misattributed. The identical signature —
  `dh.a(IIILan;IIIB)V`, `saload` index 576 into length 124 — reproduces under
  `JVM_JIT_WARMUP=1` on unmodified sources, so it is a pre-existing latent
  miscompile that surfaces whenever compilation timing shifts, not a
  consequence of the coalescing change. The revert stands on the scope defect
  alone. `JVM_JIT_WARMUP=1` crashes in about 30 s and is the fastest known
  reproducer for it.
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

### For boot work, measure post-logo time on an otherwise idle machine

Two mistakes have each been made more than once here, and both manufacture or
hide almost any result.

The first is reading wall time. `results[0].elapsedMs` from the launcher
includes the ~21 s logo and startup; the metric boot work is judged on is
`results[0].phaseTimings.postLogoToMenuMs`. A run reported as "188 s" is 155.8 s
post-logo. That 32 s gap is larger than most effects being chased. (The launcher
also intermittently reports `postLogoToMenuMs: 0` when logo detection misses;
discard those runs rather than reading their wall time instead.)

The second is comparing runs taken under different machine load. Measured
2026-08-15, `report-NOOSR.json` and `report-NO1.json` are the *same*
configuration and differ 200.4 s vs 166.0 s — about 20%. The long-quoted ~211 s
baseline has wall 322.4 s against 211 s post-logo, an 111 s pre-logo phase versus
~31 s when quiet: it was taken under heavy load and overstates the baseline, so
"we improved from 220 s" was mostly a measurement artifact. This happens because
bisect arms get launched concurrently, or a test suite runs on the other cores
during a boot. Timing-sensitive unit tests also go flaky under that contention —
three failures that vanished on a quiet re-run.

So: report the median `postLogoToMenuMs` of at least three sequential runs with
nothing else running, and interleave the A and B arms in the same quiet window.
Sampling itself is cheap — `--cpu-profile` measured 152.3 s against 149.4 s
without — so profiling overhead is never a valid explanation for a slow reading.
Look for contention instead.

When a change should only affect compile-time work, prefer an in-profile
measurement over wall time: compare that bucket's size between two profiles.
Bucket sizes are immune to machine load in a way total runtime is not.

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
JVM_FAKE_TIME=1000000000000 JVM_FAKE_TIME_REALTIME=1 \
JVM_WASM_JIT=1 JVM_WASM_STRUCTURED=1 \
JVM_ENABLE_RENDERER_PIPELINE=1 \
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
- `JVM_FAKE_TIME` supplies the old epoch the game expects, while
  `JVM_FAKE_TIME_REALTIME=1` advances that epoch with wall time. Do not omit
  realtime mode for throughput: legacy deterministic mode advances one step
  per clock query and makes timed guest work scale with JVM execution speed.
  The `[frame] +<t>s` uptime is REAL wall clock, so fps = frames / Δt directly.
- fps over a warm window: skip to frame 25, e.g. 175 / (t₂₀₀ − t₂₅).

Do not omit `JVM_ENABLE_RENDERER_PIPELINE=1` when comparing current results.
The pipeline flag composes scalar guest bodies, fused wrapper/raster regions,
and structured SSA; Wasm flags alone benchmark a materially slower tier mix.
On revision `db4f5b0` plus the late-target working change, a configuration audit
measured 20.833 frames/s for dispatcher Wasm alone, 21.341 for structured Wasm,
and 23.333 for the composed pipeline. Three clean composed runs all measured
**23.333 frames/s**, produced identical frame-0/frame-200 SHA-256 hashes, and
reported no runtime errors. The earlier reported 20.833 median was therefore a
benchmark-command regression, not a JVM performance regression.

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

Historical deployment: `HandwrittenFusedGradient.js`, formerly installed by
`FusedRegionCompiler.compile` behind (a) an exact bytecode fingerprint of
wrapper+raster+scanline (4128814000 for dekobloko — these shared obfuscated
classes are arg-reordered per build, so a shape match is not enough), and
(b) a per-call layout pre-flight (linear row table, destination bounds) that
delegates to the generated kernel before any side effect when anything is
non-standard. With both passed, no path in the handwritten raster can throw,
so the generated kernel's per-scanline guards and state-capture snapshots are
provably dead. Its former kill switch was
`JVM_DISABLE_HANDWRITTEN_FUSED=1`. Validated by
the 2140-triangle hash gate, 400+800 randomized differential iterations
(including an extended ±30 out-of-bounds coordinate range), 299 jit tests,
clean boot, and acceptance.

This describes the historical deployment. The translation now lives only at
`scripts/oracles/FusedGradientOracle.js`; it is invoked directly by the
differential benchmark and cannot be selected by the production runtime.
Production performance comes from bytecode-derived generated kernels.

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

## 2026-07-22: late virtual targets and the audio-deopt false lead

A class loaded after a virtual-call module was emitted used to miss that
module's closed-world dispatch map forever. The dispatcher and structured
Wasm tiers can now resolve and install the exact later-loaded implementation
at the first miss. This remains class- and method-name independent. A target
is admitted only when its transitive field writes are a subset of the cache
kill set already emitted in the caller; otherwise the call takes the original
deopt-before-side-effects path. Class/compile epochs suppress repeated failed
resolution, and `JVM_DISABLE_WASM_LATE_INSTANCE_TARGETS=1` is the kill switch.
Tests cover a pure late target, a target rejected for uncovered writes, the
kill switch, and both dispatcher and structured call imports.

The real-game diagnostic produced a useful negative result. The two highest
deopt-count sites were:

- `en.a([II)V` calling the `ol.b([III)V` family: 16,284 calls and 16,284
  deopts by frame 50;
- `rc.run()V` calling `en.g()V`: about 16,000 calls and the same number of
  deopts.

Exact runtime-target attribution showed that the first site selects
`mi.b([III)V`, the synchronized audio-mixer body, not a renderer raster. Its
common child-list traversal is split by two `checkcast` operations. Enabling
guarded casts made `mi.c([III)V` contiguous and reduced the first site's
deopts to **zero** (roughly 30,000 calls in the comparable short run), while
preserving the initial and frame-25 hashes. No late target was installed in
this workload: the receiver class was already present and the selected target
was partial, so late dispatch was not the missing link.

The cast experiment was then narrowed to a structural default (only
loop-bearing methods) and measured in a balanced three-run Node A/B over
frames 25 through 200:

| guarded loop casts | frame rates (frames/s) | median |
| --- | --- | ---: |
| off | 21.084, 20.588, 20.588 | **20.588** |
| on | 20.833, 20.588, 20.588 | **20.588** |

This diagnostic accidentally omitted `JVM_ENABLE_RENDERER_PIPELINE=1`; it is
valid for comparing the audio-cast switch within that fixed tier mix, but it
is **not** the current composed-pipeline FPS baseline. The corrected composed
baseline is the 23.333 frames/s series documented in the Node recipe above.

All six processes reported no runtime errors and the same initial surface
hash. The short frame-25 differential also matched exactly. Later time-indexed
hashes differed consistently because the two configurations reached different
animation/server states; as documented above, those hashes are not a semantic
oracle at unequal host progress. The throughput median was exactly neutral,
so the automatic loop-cast policy was removed and guarded casts remain opt-in
with `JVM_WASM_CHECKCAST=1`.

This falsifies invocation/deopt count as the next-target heuristic once more:
the large exit storm belongs to audio-thread work and is not limiting visual
throughput. Do not spend the next renderer iteration on `mi`/`en` merely
because their counters dominate. Use probe-free wall-time samples to select
the next model/face or partial-Wasm boundary block.

The final production-bundle Firefox 1509 acceptance series, with all timing
and invocation probes disabled, measured 14.9972, 14.4573, and 14.8168 changed
images/s: **14.8168 median**. Every run completed the 20-image window, began
at the expected `4025147891` hash, and reported empty page/console error lists.
This is a correctness and non-regression check for late dispatch, not evidence
of an FPS gain: the feature installed no target in the observed game path and
the result remains in the established ~15 FPS band, below both the 20 FPS
acceptance threshold and the 30 FPS playability goal. Raw results are in
`/tmp/dekobloko-late-dispatch-firefox.4WMGFv` for the measuring workspace.

## 2026-07-22: remove method-boundary dispatch tax (23.33 → 28.69 Node FPS)

The next successful optimization did not recognize a Dekobloko method at all.
Time sampling showed that complete generated JS/Wasm entries were still paying
an `async executeTick()` Promise/microtask round trip at every guest method
boundary, while interpreted field and invoke sites repeatedly resolved facts
that are stable after class loading. The runtime now has a guarded synchronous
scheduler path and structural per-site caches:

- `JitCompiler.tryRunFrame()` returns synchronously when the selected generated
  body does. The main execution loop stays synchronous across those ticks;
  genuine runner/native Promises, idle waits, reflection, and cold class work
  retain the old async path.
- initialized `getstatic` sites cache the declaring owner/key, while
  `getfield`/`putfield` sites cache the resolved declaring slot. Cache metadata
  is stored under Symbol keys, so it is absent from snapshots, JSON, AST
  serialization, and debugger views.
- interpreted static/special/virtual/interface bytecode calls use a two-entry,
  class-epoch-guarded inline cache for already loaded bytecode or JRE/JNI
  targets. Cold initialization/loading, null/boxed receivers, annotations,
  lambdas, blocking calls, and actual Promises preserve the normal dispatcher.
  Descriptors are parsed once per bytecode site. Selection is entirely by
  descriptor, loaded hierarchy, opcode kind, runtime receiver class, method
  identity, and class epoch—there are no guest method-name allowlists.
- invocation counters are now opt-in (`profileMethods: true`,
  `JVM_PROFILE_JIT_METHODS=1`, or `JVM_DEBUG_JIT=1`). Node had accidentally
  mutated several profiling Maps on every generated/inlined call even in the
  production FPS recipe. Time profiling remains independent.
- common scheduler/JIT result objects and burst options are reused, and the
  synchronous scheduler no longer allocates success/failure closures on every
  generated entry.

Snapshot behavior is unchanged. The only new persistent-looking data is
non-enumerable Symbol metadata on parsed instructions; state capture never
serializes it, and class-epoch guards invalidate dynamic call targets whenever
the loaded dispatch world changes. Static-site caches retain owner/key facts,
not captured field values, so restored/replaced static maps are read live.

Measured over the same composed-pipeline Node recipe and frames 25→200:

| configuration | three runs (frames/s) | median |
| --- | --- | ---: |
| prior corrected baseline | 23.333, 23.333, 23.333 | **23.333** |
| synchronous boundaries + structural site caches | 28.689, 28.689, 28.689 | **28.689** |

This is a **22.95% whole-game gain**. Every final run exited cleanly, began
with SHA-256 `b13065a65ee4864a589226b72c486efb790f4ce7bfe2434570e79d8506c48191`,
and ended on one of the already observed time-indexed title-animation hashes
(`83b7…` or `c1f5…`). Raw logs and surfaces are in
`/tmp/dekobloko-node-final-series.wIzq7O`.

The gain accumulated in measured stages: removing only the generated-entry
Promise hop reached 23.65–23.97; disabling unrequested invocation accounting
reached 24.65; field/static caches reached 25.74; warm bytecode/JRE call-site
caches reached 27.34–27.78; scheduler allocation cleanup reached the final
28.69. A one-pass scheduler-thread scan was rejected after it increased sampled
scheduler self-time and produced no FPS improvement.

The “fatter regions instead of Wasm crossings” hypothesis was also tested via
the new diagnostic `JVM_PREFER_WHOLE_METHOD_JS=1`. On Node it regressed this
workload to **25.735 FPS** (6.8 s versus the final 6.1 s window), so it remains
off by default there. Firefox already has its own whole-JS preference; this
result is another warning not to transplant a tier policy between engines.

Validation after the final change:

- `timeout 180s node node_modules/tape/bin/tape test/schedulerPerformance.test.js test/jitCompiler.test.js test/structuredWasm.test.js test/wasmInstanceLink.test.js`
  — **760/760 passed**;
- `npm run build:bundle` — production bundle built successfully (only the
  pre-existing dynamic-require and size warnings);
- three Node game runs — no runtime errors and expected surface hashes.

This still misses the 45–50 Node FPS target and therefore is not evidence that
Firefox is playable. Per the user's instruction, Firefox was not run. The last
probe-free CPU profile before the final allocation cleanup
(`/tmp/dekobloko-node-sync-native-prof.3CjS6D`) leaves no single magic renderer
kernel: PNG sampling costs ~541 ms/window; `execute`/`executeTick` together
~1.01 s; Wasm↔JS and Wasm runtime glue remain several hundred milliseconds;
and the remaining generated/structured guest bodies are individually much
smaller. The next high-leverage work should make the benchmark hash raw
surfaces without PNG encoding, then attribute inclusive time to interpreted
guest owners and enlarge only the hottest partial-Wasm/generated region.

## 2026-07-22: correct the benchmark clock — 50 FPS Node cap reached

The 28.69 result above was real for the executed workload, but that workload
was not representative of Firefox. Deterministic `JVM_FAKE_TIME` historically
advanced by one millisecond every time any guest or scheduler code queried the
clock. Faster dispatch therefore advanced guest time faster, woke sleeping
threads more frequently, and manufactured additional work. Sampled inclusive
warm-window time exposed the feedback loop: `jn.b()V` alone performed roughly
22,700 PCM conversions/writes in 6 seconds, while the `en`/`rc` mixer chain
consumed another ~0.8 seconds. This is not how the browser's wall clock behaves.

`JVM_FAKE_TIME_REALTIME=1` now decouples epoch compatibility from progression:
the clock starts at the requested fake epoch but advances by actual elapsed
wall time. Repeated clock queries at the same instant return the same value.
Timed scheduler idling uses real waits in this mode; deterministic step mode
remains the default for reproducible tests and trace work. Clock snapshots
store the current synthetic epoch and restore realtime progression from that
point, so save states do not jump to the host's calendar.

With the optimized runtime above and the corrected recipe, three clean Node
runs over frames 25→200 measured from PNG file timestamps were:

| run | elapsed | frames/s |
| ---: | ---: | ---: |
| 1 | 3.501052 s | 49.985 |
| 2 | 3.500052 s | 49.999 |
| 3 | 3.500052 s | 49.999 |

The median is **49.999 changed frames/s**, effectively the game's **50 Hz
cap** (the remaining ~0.001 FPS difference is timestamp/write scheduling, not
a missed render interval). All runs exited normally, began with the unchanged
`b13065…` initial surface hash, and produced valid time-dependent animation
surfaces at frame 200. Raw logs and PNGs are in
`/tmp/dekobloko-node-realtime-series.622E1l`.

This resolves the Node-side 50 FPS requirement without disabling audio,
rendering, guest threads, or game logic. It is partly a runtime optimization
(23.33→28.69 under the old workload) and partly removal of a benchmark-induced
load feedback loop (28.69→the real 50 Hz cap). Firefox still needs a production
acceptance run before claiming ~30 FPS there; none was run in this iteration.

## 2026-07-22: Firefox acceptance after the 50 FPS Node result

The production bundle built from the same working tree was deployed with
SHA-256 `5bf57f9ffc1b54b2a3eafcfe570d6c0fe434bffd561621713d48448c8ea03cb3`
and measured on Playwright Firefox build 1509. The composed pipeline overrides
were enabled; JIT method, method-timing, scheduler-timing, and exclusive probes
were all disabled. The game/server, 16-sample stride, 20-changed-image window,
and 65-second process duration match the prior acceptance recipe.

| run | changed images/s | page errors | console errors |
| ---: | ---: | ---: | ---: |
| 1 | 23.5333 | 0 | 0 |
| 2 | 25.5434 | 0 | 0 |
| 3 | 27.2569 | 0 | 0 |

The Firefox median is **25.5434 changed images/s**. Every run completed the
full window and the observed hashes belonged to the animated title sequence;
the first sampled animation hash varies with the phase at which the probe
obtains its window. Raw JSON and stderr are in
`/tmp/dekobloko-firefox-50fps.QKt6Fv`.

This is a **72.4% improvement** over the previous 14.8168 Firefox median, but
it remains below the 30 FPS playability target. The 50 Hz Node cap therefore
does not map to 30 Firefox on this workload; the measured ratio is ~0.51. The
next Firefox-specific pass should use probe-free native sampling around the
remaining Wasm↔JS transitions and presentation upload path rather than
returning to the now-corrected Node scheduler workload.

## 2026-07-22: defer parent `Frame` materialization across synchronous calls

The first Firefox-specific follow-up repaired an instrumentation blind spot.
The scheduler timer used by `profileDekoblokoFirefox.js` wrapped
`executeTick()`, but the synchronous generated-code scheduler path deliberately
bypasses that function. The probe now installs the JVM's scheduler timing
profile directly when those hooks exist and retains the wrapper only for older
bundles. A 1/16 sampled, 100-change run attributed about 90% of its 3.20-second
animation window to guest scheduler slices. The largest inclusive owners were
the complete scene/model body (34.0%), the top-level render body (12.5%), the
canvas/render coordinator (10.0%), and a raster body (5.0%). These names are
profiler labels only; no optimizer decision uses them.

That longer run also exposed why the 20-image acceptance number varies: its
first 20 changes ran at 24.99 images/s, changes 31–50 at 41.36, and later
20-change windows around 33–35. The 100-change aggregate was 31.25 images/s.
The product still uses the stricter first-20 window below, so this observation
does not redefine the target.

The retained optimization removes normal-path state traffic from every
verified synchronous call in a structured SSA body. Previously the caller
copied every scalar local, wrote its full operand stack, and updated its
canonical bytecode PC before entering a synchronous generated child. No JVM
observer can inspect that parent state while the JavaScript call is running.
The caller now stages only the call operands; it reconstructs the complete
parent state at the exact bytecode PC only when the child throws, deoptimizes,
needs an asynchronous fallback, changes scheduler state, or encounters a
debugger transition. Snapshot safety follows from the same rule: external
JavaScript cannot take a snapshot in the middle of one synchronous region,
and every path that yields back to the scheduler materializes first.

Selection remains generic. It depends on the structured compiler's verified
CFG/stack shapes and the existing synchronous-call contract, not class or
method names. `JVM_DISABLE_STRUCTURED_DEFERRED_CALL_MATERIALIZATION=1` is the
Node kill switch; the Firefox profiler exposes the same policy through
`PROBE_STRUCTURED_DEFERRED_CALLS=0/1` before hot methods compile.

The captured original `vk.a(I)V` replay measured the change before a browser
run (10 invocations, five measured rounds, two warmups):

| structured call state | ms/invocation | invocations/s | ticks/invocation |
| --- | ---: | ---: | ---: |
| eager parent materialization | 6.960 | 143.68 | 5 |
| deferred exceptional materialization | **6.570** | **152.21** | **5** |

All five rounds retained surface hash `780636275` and the 591-field static
fingerprint `3248835056`. This is a 5.94% replay improvement with no scheduling
change.

The production Firefox 1509 acceptance series used bundle SHA-256
`7e8403f21d4037f30b0958586f3a448b0ffede1f97bd4de1283f8c52e4223298`:

| run | changed images/s | page errors | console errors |
| ---: | ---: | ---: | ---: |
| 1 | 27.2896 | 0 | 0 |
| 2 | 27.2688 | 0 | 0 |
| 3 | 27.2680 | 0 | 0 |
| **median** | **27.2688** | **0** | **0** |

This is +6.75% over 25.5434 and +84.0% over the earlier 14.8168 median, but it
is still below the 30 FPS playability target. Raw browser results are
`/tmp/dekobloko-firefox-deferred-calls-{1,2,3}.json`; replay A/B results are
`/tmp/replay-deferred-calls-{off,on}.json`.

Three structurally generic experiments were rejected:

- Lazy compilation of baseline resume companions measured 25.5317, 25.0081,
  and 28.5396 images/s (25.5317 median), neutral versus the prior build.
- Structured raw-array storage companions preserved every replay checksum but
  regressed the scene from 6.964 to 7.821 ms/invocation; pointer bookkeeping
  cost more than the removed representation branch.
- Preallocated positional call buffers improved the Node replay another 1.7%,
  but Firefox measured 25.5467, 28.5535, and 23.9814 images/s (25.5467 median)
  and became much noisier. It and its extra dispatch helper were fully removed.
- Prefiltering non-fusable descriptors before entering the fused-region matcher
  improved the Node replay 1.76%, but Firefox measured 25.0063, 27.2896, and
  31.5776 images/s. Its 27.2896 median was only 0.08% above the retained build
  and the spread grew sharply, so it was classified as noise and removed.

Final validation after removing the rejected paths:

- `timeout 180s node node_modules/tape/bin/tape test/fakeClock.test.js
  test/saveState.test.js test/schedulerPerformance.test.js
  test/jitCompiler.test.js test/structuredWasm.test.js
  test/wasmInstanceLink.test.js test/browserBundleConfig.test.js` — **788/788
  passed**;
- `npm run build:bundle` — production build succeeded with only the existing
  dynamic-require and bundle-size warnings;
- `git diff --check` — clean.

The next 2.73 FPS cannot come from more parent-state copying: that layer has
now been removed on successful structured calls. The most credible remaining
step is direct generated-to-generated calling with positional scalar locals
and deopt frame reconstruction, but without a shared argument buffer (which
SpiderMonkey rejected). It should be attempted first on the captured complete
scene replay and kept only if a clean Firefox median crosses 30.

## 2026-07-22: handwritten kernels as generic JIT targets and recompiled-local traffic

The handwritten gradient kernel is now explicitly a JIT target rather than a
guest-method hook. Region discovery first proves the wrapper → raster →
scanline call graph, descriptors, CFG/stack depths, repeated callee identities,
array-store loop, static targets, and initialized-class guards. The semantic
path derives scanline recurrences, raster static-field roles, and wrapper
argument permutations from verified bytecode behavior. The older exact-shape
fast path remains useful for the original bytecode, but its fingerprint is now
identity-canonicalized: owner, method, field, and object-type names are replaced
by first-occurrence IDs before hashing. Only identity relationships,
descriptors after type normalization, opcodes, constants, and control flow
reach the selector. A unit test renames every guest identity and obtains the
same fingerprint, while changing one bytecode constant rejects the shape.

This closes an important genericity hole. The optimizer contains no `ug`,
`wf`, `oj`, `ve`, or other guest-name allowlist. The descriptors printed in
diagnostics identify test families, but runtime selection does not consult a
class or method spelling. The javac-recompiled family, whose instruction layout
does not match the original exact shape, continues to use the semantic raster
and behaviorally validated wrapper target.

The live differential harness had still depended on the removed descriptor
allowlist API. It now discovers both families through the production structural
compiler and exercises the selected handwritten kernel when present. Two
hundred gradient and 200 flat-color invocations matched baseline pixel-for-pixel
(54,951 and 60,938 changed pixels respectively).

The remaining recompiled regression was then measured by emitted-code shape.
For the same face body, the original bytecode produced 80,378 bytes / 1,725
lines of structured JavaScript, while the lean javac-recompiled bytecode
produced 169,464 bytes / 3,682 lines. Generic calls increased only from four to
six; mutable-local traffic grew from roughly 300 source operations to almost
1,400. This is the strongest evidence so far that javac carrier traffic—not
renderer dispatch—is the residual recompiled cost.

The structured renderer now performs safe block-local value numbering for JVM
locals. The first load snapshots a mutable local into an immutable SSA value;
subsequent loads reuse it until a store or `iinc`. Stored stack values become
the new block-local SSA value. The cache is deliberately discarded at every
CFG join, so no predecessor value can leak across a phi. Canonical locals are
still written on every real store and spilled on every exception, deopt, debug,
or scheduler safe point, preserving save-state behavior. The diagnostic kill
switch is `JVM_DISABLE_STRUCTURED_LOCAL_VALUES=1`.

On the recompiled face body this removed 247 emitted local loads and reduced
the generated source from 179,095 to 167,440 bytes (6.5%) and from 3,891 to
3,650 lines. It found no redundant stores, which narrows the next target to
cross-block carrier/phi construction rather than more block-local cleanup.
The captured complete-scene replay measured 7.202 ms/invocation with the pass
disabled and 7.029 ms enabled, a 2.4% CPU-time improvement, with surface hash
`780636275`, 591-field static fingerprint `3248835056`, and five scheduler
ticks unchanged.

After name-independent exact-shape selection was restored, a longer replay A/B
measured 6.731 ms/invocation with the handwritten target disabled and 6.529 ms
enabled (3.0%). Both sides retained the same surface/static hashes and five
ticks. These gains compose, but neither alone explains the original-versus-
recompiled Firefox gap.

The primary whole-game Node run used the freshly rebuilt all-recompiled lean
JAR and the realtime fake clock. Frames 25→200 completed in exactly 3.5 seconds:
**50 FPS, the game cap**. It exited normally, emitted the established initial
PNG SHA-256 `b13065a65ee4864a589226b72c486efb790f4ce7bfe2434570e79d8506c48191`,
and reported no runtime error. Because Node is capped, this is a correctness
and capacity gate rather than a sensitive performance comparison; replay wall
time supplied the A/B above. Per instruction, Firefox was not rerun in this
iteration. The latest pre-change recompiled Firefox result remains 15.383
changed images/s, versus 29.266 for the accepted original control, so matching
the original compiler output remains unfinished.

Focused validation at this point:

- JIT compiler suite: **345/345 passed**;
- CFR/decompiler suite: **181/181 passed**;
- live fused differential: **400/400 invocations matched**;
- production bundle: built successfully with only the existing dynamic-JNI and
  size warnings.

The next measured experiment should construct local SSA across basic blocks:
compute local liveness and explicit phi inputs, then eliminate javac carrier
stores only where every predecessor and exceptional/safe-point state is proven.
The earlier broad dead-store experiment broke animation; it must not be revived
without precise join, exception-PC, debugger, scheduler, and snapshot tests.

## 2026-07-22 consolidated handoff: the fused recompiled-renderer investigation

This section is the current handoff for the most recent work. It gathers the
facts that were previously split between temporary profiles, terminal logs, and
the chronological entries above. Values in the first progression table are
focused Firefox diagnostic runs unless explicitly called a median; they are
useful for locating step changes, but must not be presented as an acceptance
series. Acceptance still requires three clean same-bundle runs.

### What is actually implemented

The fused compiler no longer contains a wrapper descriptor table or an
obfuscated-name selector. It discovers a candidate graph by following repeated
static-call identities:

```text
verified caller
  -> repeated-call wrapper
       -> repeated-call raster
            -> array-store-loop scanline
```

Every participating method is independently checked for valid bytecode,
descriptor parsing, CFG/operand-stack depths, supported handlers, repeated
callee shape, resolvable static targets, and initialized owner classes. The
generated normal path uses positional scalar arguments and lexical JavaScript;
it does not allocate the omitted child `Frame` objects or route each nested
operation through the generic JVM call dispatcher.

Compilation then specializes in measured, independently guarded stages:

1. The generic bytecode lowerer emits wrapper, raster, and scanline kernels.
2. Scanline analysis derives the destination, index, count, packed-color
   accumulators, and induction steps from aliases and recurrences, then emits a
   direct pixel loop.
3. Raster analysis identifies height, width, row-offset table, and stride
   statics from parameter types, operations, and repeated field roles. It can
   select the structured handwritten raster after a layout preflight.
4. Wrapper analysis executes the generated wrapper against cloned statics for
   all 27 order/equality combinations of its three sort keys. It records the
   resulting child-argument permutations and emits an equivalent direct branch
   tree only when every probe agrees.
5. The original-bytecode handwritten wrapper target is admitted by the
   identity-canonicalized exact-shape fingerprint documented above. This is a
   bytecode-shape target, not a guest-method target.

Static locations are resolved once, but their values are always read live.
The class-initialization epoch increments when a class becomes initialized, so
a wrapper rejected while its callees are cold can be reconsidered. Negative
fusion results are epoch-guarded and consulted only on a cache miss. An earlier
version built the epoch string on every hot call; eliminating that allocation
restored the original-JAR generic bundle from roughly 14.46 to 25.52 changed
images/s in the focused run.

Entry guards execute before a fused side effect and reject debugging,
breakpoints, tracing, unsupported scheduler state, changed method/code
identities, uninitialized classes, or a failed layout preflight. The existing
generated implementation remains the fallback. Generic fused code records the
throwing PC and live locals/operands. If an operation throws, omitted frames are
rebuilt outer-to-inner and the exception returns to the normal JVM dispatcher;
a caught exception resumes interpreted rather than re-entering a partially
executed fused region.

### Measured progression and where the wins came from

The all-recompiled JAR initially exposed how much work remained outside the
leaf rasters:

| focused Firefox configuration | changed images/s | interpretation |
| --- | ---: | --- |
| recompiled, before fused regions | 2.09 | JVM-shaped wrapper/raster traffic dominates |
| generic wrapper→raster fusion | 10.53 | removing child frames/dispatch is the first large win |
| + semantic scanline | 11.76 | direct pixel recurrence helps, but is not sufficient |
| + semantic raster | 12.37 | structured scan conversion adds a smaller win |
| + behaviorally derived wrapper | about 12.77–13.33 | wrapper permutations can be removed generically |
| + negative-cache allocation fix | 13.04 | hot optimizer bookkeeping was observable |
| + structural primitive-array copy | **15.192** | hidden renderer-side memmove was a major body cost |
| freshly recompiled lean-carrier JAR | **15.383** | source/carrier cleanup adds only about 0.19 |

The array-copy result was not selected by a method name. The intrinsic requires
the semantic parameter shape `int[], int, int[], int, int`, balanced repeated
`iaload`/`iastore`, an identical-array branch, both forward and backward index
updates, and no calls or field effects. This recognizes both the compact
original bytecode and javac's expanded memmove loops. After it landed,
structured entries in the measured window fell from about 2.67 million to
0.665 million while the expected first hash `4025147891` and empty error lists
were retained.

One accepted original-JAR control on the older production bundle measured
29.266 changed images/s. The same original JAR on the newer generic bundle
measured about 25.52 after the cache fix. These are controls from different
bundle states, not a three-run claim. The important remaining comparison is
that the lean recompiled JAR was still only 15.383: generic fusion works for
both worlds, but javac's expanded hot body remains substantially more costly.

### Time attribution after the array-copy breakthrough

Timing, rather than invocation ranking, changed the diagnosis. Before the
structural array-copy intrinsic, one recompiled 20-image window attributed
about 383 ms exclusive to the copy body and 382 ms to its immediate caller;
together that subtree was roughly one third of the root. The geometry/face body
itself was about 215 ms exclusive.

After the intrinsic, the same copy caller fell to about 16 ms. The root took
about 602 ms, and the geometry/face body became the clear residual owner:

| recompiled body after copy intrinsic | exclusive ms | inclusive ms when recorded |
| --- | ---: | ---: |
| geometry/face body | 320 | 467 |
| flat wrapper | 67 | — |
| gradient wrapper | 64 | — |
| setup/geometry body | 52 | — |
| helper body | 31 | — |
| former array-copy caller | 16 | — |

The adjacent original control had a 439 ms root. Its geometry/face body cost
200 ms exclusive / 317 ms inclusive, while the corresponding children were
already close to the recompiled costs (52, 50, 47, 27, and 15 ms). Expressed
per changed image, the original face body costs about 10 ms and the recompiled
body about 16 ms. The remaining six-millisecond gap is therefore inside the
recompiled structured guest body, not its raster children, AWT upload, or the
generic call dispatcher.

This attribution uses exclusive instrumentation that can perturb very frequent
small calls, as explained in the handwritten-kernel section. Here the key
conclusion is supported independently by emitted-source size, the array-copy
feature A/B, and the near-equality of child costs; the exact millisecond totals
should still be treated as diagnostic rather than acceptance numbers.

### What javac changed

The decompiler originally initialized every `stackIn_*`/`stackOut_*` carrier.
Removing provably unnecessary initializers made javac accept a smaller source:
`stackOut_*` declarations are bare, and only safe wide entry bundles receive
the same treatment for `stackIn_*`. A freshly generated JAR contained 343
recompiled classes and no original-class fallback. The decompilation pipeline
still reports six pre-existing hard diagnostics, so its aggregate status says
`fail`, but `javac_fail` is zero and all 343 class files are fresh.

That change moved the first real static access in the face class much earlier
and removed roughly 90 initializer stores, yet improved Firefox by only about
0.19 changed images/s. Cold prologue initialization was therefore not the main
steady-state cost.

The emitted structured-JavaScript comparison made the actual expansion clear:

| face-body metric | original class | lean recompiled class |
| --- | ---: | ---: |
| source bytes | 80,378 | 169,464 |
| source lines | 1,725 | 3,682 |
| SSA value declarations | 440 | 1,001 |
| mutable local writes | 95 | 698 |
| mutable local reads | 201 | 693 |
| synchronous call sites | 4 | 6 |
| materialization sites | 87 | 152 |
| JavaScript `if` statements | 116 | 194 |
| lexical loops | 2 | 3 |

The retained block-local value-numbering pass removes 247 repeated local loads
from the recompiled body and reduces it to 167,440 bytes / 3,650 lines. It finds
zero redundant stores. That negative result is useful: the 698 writes are
mostly cross-block javac carriers, so the next pass requires real local SSA and
phi/liveness analysis rather than another peephole.

### Experiments that were removed

- **Broad dead-initializer/dead-store elimination:** javac accepted the output
  and the game reached its ready state, but animation stopped. The pass did not
  preserve every control-flow, materialization, and observable frame-state
  dependency and was removed completely.
- **Direct structured-SSA-to-fused call entry:** replacing the established
  boundary with the experimental direct entry regressed the focused rate from
  15.19 to 14.82. The code path and its renderer hook were removed.
- **More carrier declaration cleanup:** source and class files became smaller,
  but steady-state FPS barely changed. Do not confuse bytecode size with
  executed hot-path cost.
- **Blanket JS-over-Wasm or Wasm-over-JS policies:** earlier measured A/Bs show
  that either policy can lose. Complete numeric Wasm is fast; reference-heavy
  partial Wasm pays imports/exits; complete structured JavaScript may still lose
  to a mature Wasm kernel. Tier choice must be per verified region and measured
  on the target engine.
- **Invocation-count profiling as prioritization:** the largest count can be a
  cheap copy, audio helper, or instrumentation artifact. Wall time and a
  differential feature A/B must select the next target.

These removals are part of the result. They prevent a superficially smaller or
more direct compiler from silently reintroducing a correctness regression or a
SpiderMonkey slowdown.

### What is and is not the current bottleneck

- Browser canvas upload and dirty-driven AWT presentation are already only a
  few milliseconds and are not the missing 15 FPS.
- The direct scanline arithmetic is fast once kept inside a structured region.
  A handwritten gradient kernel is a useful code-generation target but, by
  itself, has only a modest whole-application effect.
- Generic method dispatch used to matter and the synchronous call-site caches
  produced a large earlier Node gain. It is no longer the dominant residual
  gap in the recompiled renderer: child costs are nearly equal while the caller
  body differs by six milliseconds per image.
- Web Workers can run Wasm, but moving JVM threads or the renderer there does
  not remove this computation. It introduces heap sharing/copying, monitor and
  class-initialization coordination, exception/debugger delivery, and
  main-thread presentation. It is an architectural responsiveness project, not
  the next throughput fix.
- The realtime-clock Node game reaches the fixed 50 Hz cap for the recompiled
  JAR. That proves correctness and available Node/V8 capacity, not extra
  headroom or Firefox parity. Uncapped captured replay time is the useful Node
  optimizer metric once the game hits its cap.

### Snapshot and debugger contract

Generated scalar values, cached array views, direct static-location handles,
local SSA values, and fused execution state are transient compiler artifacts;
they are not serialized. A snapshot observes canonical JVM heap objects,
statics, locals, stacks, PCs, thread states, and monitors. Every route that can
return control to the scheduler, debugger, exception dispatcher, native code,
or snapshot caller must materialize that canonical state first.

Fused calls are atomic only while JavaScript remains inside the verified
synchronous region. The model/face loop retains scheduler safe points. A
restored snapshot constructs a new compiler and reads restored static maps, so
no pre-snapshot field value is baked into generated code. Any future cross-block
local SSA must keep explicit deopt maps for exception PCs and safe points; a
phi or store may be eliminated only if its canonical value remains
reconstructable on every predecessor.

### Current reproducible state

- Recompiled whole-game Node: frames 25→200 in 3.5 seconds, **50 FPS cap**,
  initial PNG SHA-256 `b13065a65ee4864a589226b72c486efb790f4ce7bfe2434570e79d8506c48191`,
  clean exit and no runtime error.
- Original captured scene, block-local values off/on: 7.202 → 7.029
  ms/invocation, identical surface/static hashes and five ticks.
- Original captured scene, handwritten target off/on: 6.731 → 6.529
  ms/invocation, identical surface/static hashes and five ticks.
- Fused differential: 200 gradient plus 200 flat invocations, every destination
  pixel equal to baseline.
- Focused tests: JIT **345/345**, JIT plus browser-bundle configuration
  **347/347**, CFR **181/181**.
- Production build: success with only the existing dynamic-JNI and bundle-size
  warnings; `git diff --check` clean.
- Deployed diagnostic bundle SHA-256:
  `ea51d8b55ec9c144643264f3e61814d46cd5bb41dd397b4f3350498e39ac675c`,
  served with `Cache-Control: no-store` on `0.0.0.0:3770`.
- Fresh Firefox 1509, same bundle and lean recompiled JAR: 15.0026, 15.3858,
  and 16.9125 changed images/s, **15.3858 median**. The corresponding
  transition-interval rates were 14.2525, 14.6165, and 16.0668/s. All three
  processes completed the 20-change window with empty page/console error lists;
  their first hashes were the two adjacent established animation states
  `4025147891`, `4136367231`, and `4025147891`.

The prior single recompiled result was 15.383, so the new 15.3858 median is
effectively neutral. The 2.4% captured-replay improvement from block-local
value numbering did not produce a measurable whole-Firefox gain, and the game
remains far below both the 30 FPS playability target and the 29.266 original-JAR
control. Raw results are `/tmp/dekobloko-firefox-current-{1,2,3}.json`.

Do not claim parity from the Node cap. The next work item is a generic
cross-block local-SSA construction for the recompiled face body: compute local
use/def and exceptional liveness, introduce explicit phis, coalesce carrier
copies, retain face-boundary safe points, and generate precise deopt maps.
Accept it only after the captured replay improves, all exception/snapshot
differentials pass, and a later three-run Firefox series beats this control.

## 2026-07-22: lazy SSA-to-fused calls recover original-JAR Firefox speed

The next investigation changed the conclusion above. The face body's measured
exclusive time still included an avoidable boundary cost: its structured SSA
source materialized the JVM operand stack and entered `tryInvokeSyncAt` for
every wrapper call, even though the resolved target immediately entered an
already verified fused wrapper/raster region. The earlier rejected direct-call
experiment only linked targets that were complete when the caller compiled.
In the actual class-loading order that covered about 114,000 of roughly
640,000 fused calls per measurement window, so it tested an incomplete region
and was not evidence against the optimization itself.

The retained implementation is generic and lazy:

- `JvmSsaBlockRenderer` asks the fused compiler about static void calls using
  the parsed descriptor and loaded method identity. There is no class-name or
  method-name selector and no descriptor allowlist.
- A candidate is admitted only when the wrapper bytecodes already satisfy the
  repeated-call/CFG/stack structural precheck. If child classes are still
  cold, the emitted positional site remains unlinked rather than permanently
  becoming a generic call.
- At runtime the site retries full wrapper/raster/scanline verification only
  after the class or initialization epoch changes. Once linked, SSA operands
  are passed positionally to the fused kernel; no child `Frame`, operand array,
  or caller-stack materialization is created on the successful path.
- The existing fused guard still runs before every entry. Class initialization,
  exact method/code identity, debugger/breakpoint/tracing state, scheduler
  state, static flags, and layout preflight retain the old fallback before any
  fused effect. A bailout reconstructs the ordinary call operands. A thrown
  operation restores omitted wrapper/raster frames and continues through the
  normal JVM exception dispatcher.
- `JVM_DISABLE_DIRECT_FUSED_CALLS=1` and `PROBE_DIRECT_FUSED_CALLS=0/1`
  provide Node and same-bundle Firefox controls. `fusedDirectRunCount` reports
  successful direct entries separately from total fusion.

Two semantic improvements landed before this boundary fix and remain useful:
the flat-color raster now has a structurally derived compact scanline kernel,
and the generic wrapper compiler behaviorally derives all 27 ordering/equality
cases before emitting its direct branch tree. A structured-local cleanup also
keeps entry constants immutable and spills their exact literals instead of
capturing every folded carrier as a mutable local. The corresponding clean
Firefox medians progressed from 19.3581 to 21.0637 (flat raster), 23.0835
(combined wrapper), and 23.5327 changed images/s (immutable entry locals).

Several tempting size-oriented changes were rejected along the way. Eager
canonical-local synchronization measured 18.4638 in its first Firefox run;
narrow bytecode-slot spill pruning measured 21.0544, 20.6847, and 18.4614;
and a decompiler alias proof shrank the face class from 92 to 77 locals but
measured 20.6928, 21.4096, and 17.4001. The last experiment also exposed a
tooling trap: compiling the isolated class without `javac --release 8`
introduced `invokedynamic`, invalidating that control. All three runtime/source
experiments were removed. Smaller bytecode was not a sufficient performance
criterion.

### Same-bundle A/B and acceptance result

Before lazy linking, a same-bundle alternating A/B measured:

| direct fused calls | Firefox samples (changed images/s) | median |
| --- | --- | ---: |
| off | 18.4648, 19.0404, 20.0108 | **19.0404** |
| eager/compile-time-only | 26.6773, 21.8079, 20.3384 | **21.8079** |

The large variance is why neither isolated pair was treated as proof. The
important counter result was stable: eager linking bypassed only 113,208–
114,136 calls. Lazy linking then bypassed 635,308–640,516 of 635,375–640,583
total fused calls, with only the cold first calls remaining generic.

On production bundle SHA-256
`ef0d5e85c3efe26dff13f5149105b8b1ac66b7eb4f7f8f59a9558a752e58d061`,
the recompiled JAR's three clean Firefox 1509 runs measured:

| run | changed images/s | transition intervals/s | direct / total fused |
| ---: | ---: | ---: | ---: |
| 1 | 29.9742 | 28.4755 | 635,308 / 635,375 |
| 2 | 29.2706 | 27.8070 | 635,308 / 635,375 |
| 3 | 31.5537 | 29.9760 | 640,516 / 640,583 |

The median is **29.9742 changed images/s** and **28.4755 transition
intervals/s**. Every run completed the 20-image window, began at an established
expected animation hash, reported zero guarded fallbacks, and had empty page
and console error lists. Raw results are
`/tmp/dekobloko-firefox-lazy-direct-{1,2,3}.json`. A recent one-run original-JAR
control on the preceding bundle measured 28.5731 changed images/s (an older
accepted control measured 29.266), so the recompiled game has recovered the
original bytecode's Firefox throughput within run variance. This reaches the
20-FPS acceptance threshold and approximately reaches the 30-FPS playability
target; the interval-based measure remains 28.48/s and should be reported
alongside the historical changed-image convention.

A final diagnostic-only edit tried to copy a region obtained from the shared
cache back into each direct-entry record so the profiler could print
`linked: true`. The added identity comparison still executed on every hot
entry. Its exact-bundle series fell to 26.6780, 26.0947, and 27.2494 changed
images/s (**26.6780 median**) at unchanged direct/total counts and zero errors.
The comparison was removed, and the release build reproduced the accepted
`ef0d5e85…` bundle byte-for-byte. This is another concrete warning that no
diagnostic bookkeeping belongs on a 640,000-call measurement path; the
conservative `linked` display is preferable to a runtime mutation.

The real-time whole-game Node check remains capped at 50 Hz: frames 25 through
200 took 3.5 seconds, the initial PNG retained SHA-256
`b13065a65ee4864a589226b72c486efb790f4ce7bfe2434570e79d8506c48191`,
and the process exited without a runtime error. Because that run is capped, it
validates integration and correctness but cannot quantify the direct-call
speedup.

## 2026-07-23: sound startup stall was a tiny-method eligibility failure

A live diagnostic report finally captured the user's pathological Firefox
startup rather than the faster headless case. The page had presented only 94
frames after 210 seconds. Its measured logo rates fell through 4.0, 1.9, 0.9,
and 2.9 FPS before reaching zero. The resource-loading thread was runnable in
the procedural PCM construction chain: the outer body allocated a 22.05 kHz
byte buffer, invoked the synthesizer for each instrument, then mixed and
clipped every sample. This was not an inflate deadlock.

The outer mixer already selected structured JavaScript. The large synthesizer
selected generated JavaScript, but its per-sample envelope helper remained
interpreted solely because its javac post-increment field sequence contains
`dup_x1`. That one missing eligibility opcode caused two or more helper calls
per sample to execute one bytecode per scheduler tick. The optimizer now admits
`dup_x1` through the ordinary supported-opcode and numeric/call-free shape
checks. It does not inspect the Dekobloko owner or member names. The previous
selection remains available with `postIncrementHelpers: false` or
`JVM_DISABLE_POST_INCREMENT_HELPERS=1` for differential measurements.

The checked-in `benchmark:jvm:dekobloko-audio` harness executes the original
gamepack bytecode with a minimal nonzero instrument graph. Seven-round medians
for one 22,050-sample synthesis were:

| configuration | median | scheduler ticks | PCM checksum |
| --- | ---: | ---: | ---: |
| previous, envelope interpreted | 507.728 ms | 1,235,019 | 1710133148 |
| optimized, envelope generated | 118.309 ms | 129 | 1710133148 |

This is a **4.29× kernel speedup** and removes about 1.235 million scheduler
entries per generated sound. A broader experiment added structured-JavaScript
long arithmetic and emitted a roughly 198 KB whole-synthesizer body. It was
neutral at about 117 ms, so that experiment and its code were removed. The
breakthrough is eliminating tiny intermethod interpreter dispatch, not making
the already generated parent larger.

Three alternating whole-game Node first-frame runs were nearly tied because
Node drains synchronous interpreter work without browser frame scheduling:
10.7-second control median versus 10.6-second optimized median. The focused
benchmark is therefore the correct CPU/dispatch differential; Node first-frame
wall time is dominated by other startup work.

The first production candidate produced this clean Firefox 1509 validation:

- first nonblack frame at **12.819 seconds**;
- first 20 changed images at **31.579/s**;
- 19 transition intervals at **30.000/s**;
- expected initial hash `4025147891`;
- no page or console errors.

The final restriction admits `dup_x1` only in call-free compute helpers. Its
exact production bundle
`1c28e3ed2fcb3796d18b0980a1dcf7cce8931a505c920a7242639b356586b1a0`
was rebuilt and rerun: first nonblack at **12.926 seconds**, **29.293 changed
images/s**, **27.828 transition intervals/s**, expected initial hash, and no
page or console errors. The small rate difference is within the already
observed short-window variance; both runs eliminate the captured 4-FPS/stalled
behavior.

This run fixes the captured symptom in controlled Firefox, but the user's
ordinary Firefox build and profile remain the product acceptance environment.
The live launcher on port 3771 serves the hashed optimized bundle. Its report
button is named **Send diagnostic report** because it captures live stacks and
performance state whether or not an exception occurred.

### Follow-up: reference-array covariance

The faster startup exposed a later JVM type-system bug:
`[Lpi; cannot be cast to [Ljava/lang/Object;`. This cast is legal Java; a
reference array is covariant with arrays of its component's supertypes. The
shared synchronous/asynchronous hierarchy checker previously recognized only
identical array descriptors plus the three direct array supertypes (`Object`,
`Cloneable`, and `Serializable`).

Array assignability now recursively compares component types. Reference
components follow the loaded class hierarchy, nested arrays participate as
reference components, and primitive components still require an exact match.
Because interpreted bytecode, generated JavaScript, structured JavaScript,
Wasm imports, reflection, `instanceof`, and `checkcast` share this query, the
fix applies to every execution tier without a game-specific exception.

The focused covariance suite covers legal widening, illegal narrowing,
primitive mismatch, nested arrays, marker interfaces, async resolution, and
generated `checkcast`. The combined array/JIT/Wasm suite passed **448/448**.
Production bundle
`cc25614c410b368adfb33a344910ea93917a31d57332a10688ea6fc46dcdfa68`
then reached first nonblack at **13.106 seconds**, measured **32.415 changed
images/s** and **30.794 transition intervals/s**, retained initial hash
`4025147891`, and reported no page or console errors.

## 2026-07-23: controlled Firefox was not the user's client

The user's ordinary Firefox 151 continued to report roughly 2–4 presented FPS
after the controlled Firefox 146 run reached 29–35 FPS. Live telemetry rules
out a misleading counter or frozen canvas. The slow session advanced from 19
to 35 presentations over a ten-second interval, with individual presentation
gaps around 200–450 ms. Its input queue was empty, the page was visible and
focused, the current production bundle was loaded, and the renderer recorded
70,307 fused entries with zero guarded fallbacks. A diagnostic stack was
actively inside the model/face rendering chain.

The important experimental error was environmental: Playwright Firefox ran on
the server, while the user's telemetry came from a different eight-thread
client. It was not a clean-profile measurement on the same client. A small
bounded JavaScript calibration added to the launcher measured:

| environment | integer iterations/s | first visible frame | presented FPS |
| --- | ---: | ---: | ---: |
| server, clean Firefox 146 | 714.29 million | 12.912 s | 29.0 |
| user's Firefox 151 client | 172.41 million | 105.481 s | 1.9–3.8 |

The client's single-thread JavaScript baseline is therefore **4.14× slower**.
The generated JVM workload amplifies this to about **8.2×** during startup and
roughly **8–15×** during the observed animation windows. Animation-clock
telemetry also separates throttling from CPU occupation: the user's visible
page received about 9–13 callbacks/s while the JVM was busy, versus about
28–37/s on the reference machine. Long main-thread JVM work is suppressing
browser animation opportunities.

The live launcher now records the exact runtime hash and size, visibility,
focus, logical CPU count, animation callbacks/s, telemetry timer drift, and a
bounded JavaScript calibration. These fields are sent automatically before
the applet starts and are included in manual diagnostic reports. The remaining
amplification must be split between generated-code behavior and the 800×600
software-surface upload on the actual client before another optimizer result
is called playable.

The server-side clean Firefox series remains a useful same-machine regression
and correctness test. It must not be quoted as expected client FPS or as proof
that the user's 4-FPS symptom was fixed.

## Remote rendering-ceiling diagnostics

The previous canvas and AWT microbenchmarks were Playwright commands executed
on the server. They could not attribute the user's remote 3–4 FPS result. The
live launcher now exposes:

```text
http://kreijstalnuc:3771/diagnostics
```

This page runs entirely in the visiting browser and posts incremental
`ceiling_phase_result` records plus one `ceiling_complete` record through the
existing telemetry endpoint. No console copying is required. Reports include
the exact JVM bundle hash, browser state, logical CPU count, surface size,
checksums, AWT presentation counters, generated/runner entries, and
deoptimization reasons. A failure is reported as `ceiling_failed`.

The suite separates these 800×600 phases:

1. animation-clock cadence with no rendering;
2. a tight typed-array Jagex-style JavaScript raster;
3. `putImageData` without raster work;
4. JavaScript raster plus `putImageData`;
5. the same work paced by `requestAnimationFrame`;
6. an original Java applet running through JVM.js, split into generated Java
   raster only, AWT publication only, and raster plus AWT.

`benchmarks/BrowserAwtCeiling.java` is deliberately an ordinary applet. Its
results are static Java fields read by the diagnostic page; it does not depend
on benchmark-only JVM natives. The live server recompiles the fixture when its
source is newer. The same page can be driven non-interactively with:

```bash
FIREFOX_EXECUTABLE_PATH=/path/to/firefox \
BROWSER_CEILING_URL=http://127.0.0.1:3771/diagnostics \
npm run benchmark:ceiling:firefox
```

The initial clean Firefox 146 reference result was:

| phase | ceiling |
| --- | ---: |
| animation clock | 59.99 FPS |
| JavaScript 800×600 raster | 1,179.02 frames/s |
| Canvas 800×600 upload | 4,900.00 frames/s |
| JavaScript raster plus upload | 958.72 frames/s |
| paced JavaScript raster plus upload | 60.02 FPS |
| generated Java raster through JVM.js | 8.42 frames/s |
| JVM.js AWT publication without raster | 131.15 frames/s |
| generated Java raster plus JVM.js AWT | 8.10 frames/s |

The Canvas path was not close to the bottleneck on that machine. However, this
first Java result was not a valid production-tier measurement: it enabled
method accounting and performed the work directly from `Applet.start()`, whose
special lifecycle loop did not refresh the browser yield deadline. The expired
deadline caused almost every structured safe point to materialize the frame.
The lifecycle runner now uses the same deadline-aware
`executeUntilStackBelow` helper as ordinary execution, and the fixture starts a
normal Java `Thread` before measuring. The page also explicitly selects the
production renderer options with method profiling disabled.

The user's first remote run was still decisive about the browser ceiling. On
that client, direct JavaScript rastered 800×600 at 209.15/s, Canvas upload ran
at 132.34/s, combined tight raster/upload ran at 84.43/s, and the paced
combination held 58.99 FPS. Therefore neither Firefox throttling nor Canvas
made 3–4 FPS inevitable. Generated Java raster was the outlier.

### Low-overhead whole-frame profiling breakthrough

Per-invocation profiling was deliberately left off. The corrected fixture
records one `System.nanoTime()` interval per complete logical frame and
inspects the generated source only after the run. That exposed a bimodal
distribution which aggregate method counts had hidden:

- structured frames that stayed in the lexical SSA body took about 12–17 ms;
- frames that reached a scheduler safe point took about 75–125 ms;
- the slow frames resumed at the exact loop header in the generic generated
  bytecode body, losing the optimized loop shape.

The generic fix pairs a structured SSA function with the verified scalar-loop
function as its resume companion. PC 0 still enters lexical structured
JavaScript. A safe-point exit reconstructs exact JVM locals, operand joins,
and PC as before; the next quantum resumes that verified leader in the scalar
tier rather than per-bytecode dispatch. If scalar compilation is unavailable,
the baseline generated resume body remains the fallback. The selection uses
CFG and opcode support only. A focused test forces a structured safe point,
then resumes the materialized loop and verifies its result and frame pop.

One unprofiled run improved from 14.37 raster/s and 26.97 complete
raster/AWT frames/s to 69.77 raster/s and 51.72 complete frames/s. Three
additional runs produced a **67.80 raster/s median** and **52.63 complete
frames/s median**, all at checksum `15711307`.

Static source inspection then found the remaining hot cost: the Java source
reads `this.pixels` twice per pixel. The structured body consequently executed
two resolved field helpers and repeated wrapper/raw-array selection for every
pixel. Call-free structured methods now cache non-volatile field reads by
symbolic field and receiver identity for the duration of one synchronous
entry, and retain the array's raw-storage companion. The optimization is
disabled for any method containing an instance-field write or call, never
caches volatile fields, and is discarded at every safe point before another
Java thread can run. Null and bounds slow paths still materialize the exact
throwing PC and operands.

The final three-run clean Firefox series was:

| run | generated raster/s | AWT publish/s | raster + AWT/s | checksum |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 142.86 | 197.53 | 57.14 | 15711307 |
| 2 | 130.43 | 213.33 | 80.00 | 15711307 |
| 3 | 142.86 | 219.18 | 72.73 | 15711307 |
| **median** | **142.86** | **213.33** | **72.73** | **15711307** |

The complete 800×600 Java/AWT path therefore crossed 60 FPS in the median,
while preserving scheduler exits instead of merely enlarging the time slice.
The larger spread in the combined phase comes from browser presentation and
short 12-frame samples; raster-only is stable enough to identify the compiler
gain.

Focused validation passed **452/452**:

```text
node node_modules/tape/bin/tape \
  test/jitCompiler.test.js test/browserEntryErrors.test.js \
  test/awt-isomorphic.test.js test/awt-cli.test.js
```

`npm run build:bundle` also completed successfully. The deployed diagnostic
bundle used for the final series has SHA-256
`849f30fede1499d911dafacfe82c99b086913d16f76d0e3f9cebc12f704b1356`.
The remote client should rerun `/diagnostics`: the server-side result proves
the generated AWT loop has a >60-FPS median ceiling, but does not substitute
for measurement on the user's Firefox profile and hardware.

### Remote Firefox 151 result and resumable structured state

The user's first run of bundle `849f30fe…` measured only **11.37 complete
frames/s**, so the clean-machine result was not accepted as product
performance. The complete remote report was:

| phase | remote Firefox 151 |
| --- | ---: |
| animation clock | 60.00 FPS |
| direct JavaScript raster | 212.80/s |
| Canvas upload | 134.72/s |
| direct raster + upload | 90.85/s |
| paced direct raster + upload | 59.49 FPS |
| generated Java raster | 9.80/s |
| JVM.js AWT publication | 35.71/s |
| generated Java raster + AWT | 11.37/s |

The page was visible, the expected field cache was active, and checksum
`15711307` matched. Direct JavaScript therefore still demonstrated a 60-FPS
client ceiling. The decisive counter was **542 generated entries** for only 42
raster invocations. Twenty-five structured safe points transferred the
remaining loop to the scalar companion; on this slower machine that companion
then required hundreds of additional scheduler entries. Whole-frame raster
times were 61–154 ms even though no method profiling was enabled.

Structured SSA now optionally emits a JavaScript generator. At a cooperative
safe point it still spills canonical locals, operand joins, and exact PC, but
also retains the lexical JavaScript continuation on the live `Frame`. The JVM
yields to the browser normally. On the next quantum it resumes the same
structured loop rather than reconstructing it as a scalar block dispatcher.
Receiver-field caches are invalidated before yielding so another Java thread's
heap writes remain visible.

The continuation is deliberately not serialized. Save state sees the already
materialized JVM locals, stack, and PC; loading a snapshot therefore uses the
ordinary scalar/generated fallback. If interpretation or debugging changes
the canonical PC before resumption, the stale generator is discarded. Methods
with guarded static-boolean specialization retain the scalar fallback because
their entry assumption must be rechecked after a yield.

Three clean Firefox reference runs retained checksum `15711307` and measured:

| metric | run 1 | run 2 | run 3 | median |
| --- | ---: | ---: | ---: | ---: |
| raster/s | 141.18 | 139.54 | 141.18 | **141.18** |
| raster + AWT/s | 75.00 | 70.59 | 67.42 | **70.59** |
| generated entries | 41 | 43 | 46 | **43** |

Raster-frame variance narrowed to 6–9 ms in the first run. Focused JIT,
portable-save-state, and browser-error tests passed **420/420**. The Dekobloko
hot-loop harness retained every checksum; its structured combined kernel ran
in a 17.17 ms median versus 24.33 ms for the scalar tier. The live candidate
bundle is `3a84528e9850a176dfb01ffd10e76181bb8c87c9b6876b03bfcd3a1cbfdf8e62`.
Remote Firefox remains the acceptance environment and must measure this
candidate before the optimization is considered successful.

### The 13-FPS result: continuations worked, two costs remained

The remote Firefox 151 run of continuation bundle `3a84528e…` improved the
complete diagnostic from 11.37 to **12.82 frames/s** (reported as 13 FPS).
More importantly, its low-overhead counters proved that the intended compiler
change ran:

| metric | previous remote | continuation remote | change |
| --- | ---: | ---: | ---: |
| generated entries | 542 | 129 | 4.20× fewer |
| generated raster | 102.04 ms | 51.25 ms | 1.99× faster |
| AWT publication | 28.00 ms | 26.63 ms | essentially unchanged |
| complete raster + AWT | 87.95 ms | 78.00 ms | 1.13× faster |

The checksum remained `15711307`, there were no runtime errors, direct
JavaScript raster plus Canvas upload ran at 86.90/s, and the same work paced by
`requestAnimationFrame` held 58.01 FPS. This was not a Canvas ceiling. The
continuation eliminated most generic re-entry overhead, but the remaining
frame budget was visibly split between the generated guest body and AWT
publication.

Two generic follow-up changes target that measured split:

1. A call-free instance method whose repeated `getfield` sites are all
   structurally proven `aload_0; getfield` sites now resolves the receiver
   field and its raw array view once at structured entry. The cache is refreshed
   after every generator yield, so Java-thread writes remain observable. The
   optimization is rejected for receiver reassignment, instance-field writes,
   calls, volatile fields, or unsupported shapes. It uses no guest class or
   method names.
2. Full software-surface presentation now performs the Java `0xRRGGBB` to
   browser `AABBGGRR` conversion in a small generic Wasm loop. Snapshot
   semantics are unchanged: `drawImage` still copies the producer framebuffer
   before the producer may render the next frame. Presentation telemetry
   records `wasmSwizzles` and `jsSwizzles`, making the selected path directly
   observable.

The exact rebuilt bundle passed **443/443** focused assertions:

```text
timeout 90s node node_modules/tape/bin/tape \
  test/jreEdgeCases.test.js test/jitCompiler.test.js
```

This includes exact channel checks on a 256×256 Wasm-converted frame, stable
producer-snapshot behavior, scheduler continuation checks, exception behavior,
and the generic optimizer tests. `npm run build:bundle` also completed
successfully.

Three clean local Firefox 146 runs of the served artifact measured:

| metric | run 1 | run 2 | run 3 | median |
| --- | ---: | ---: | ---: | ---: |
| generated raster/s | 193.55 | 190.48 | 190.48 | **190.48** |
| AWT publication/s | 253.97 | 213.33 | 216.22 | **216.22** |
| complete raster + AWT/s | 80.54 | 94.49 | 88.89 | **88.89** |

Every run produced checksum `15711307`; all 39 recorded presentations used the
Wasm swizzle and none used the scalar JavaScript converter. Generated source
contained one structurally selected eager receiver-field cache. The deployed
candidate has SHA-256
`89a3ffba8c0fa2b7e4a88d3b43bab8b8da516cbb71dda4ace97ddce6c2f7b2ae`.
As before, this local result is only regression evidence. The remote browser
must rerun `/diagnostics` before claiming that the 13-FPS client bottleneck is
fixed.

### Remote 18.35 FPS and the bounded ordinary-function kernel

The user's run of `89a3ffba…` completed successfully at **18.35 full
frames/s**. Its exact budget was:

| phase | remote Firefox 151 |
| --- | ---: |
| direct JavaScript raster | 4.46 ms |
| direct Canvas upload | 6.71 ms |
| direct raster + upload | 10.60 ms |
| generated Java raster | 37.25 ms |
| JVM AWT publication | 13.00 ms |
| generated raster + AWT | 54.50 ms |

All 24 presentations used the Wasm color swizzle, no scalar-JavaScript
conversion ran, checksum was `15711307`, and no deoptimization or runtime
failure occurred. The optimization was real: the previous remote raster cost
was 51.25 ms and AWT cost was 26.63 ms. But 54.50 ms still exceeds the
33.33-ms 30-FPS budget. Since the same client executes the equivalent direct
pipeline in 10.60 ms, 18 FPS is a generated-JVM ceiling, not a machine or
Firefox ceiling.

Inspection of the exact 6,458-byte emitted method found three remaining
structural costs:

1. identical Java null/bounds tests before a primitive load and its
   same-array/same-index store;
2. a scheduler countdown branch at both nested loop headers;
3. the complete numeric method was a JavaScript generator solely so rare
   scheduler exits could retain lexical state.

The structured renderer now treats a successful raw primitive load as a
block-local bounds proof. Java primitive arrays cannot contain `undefined`, so
that value is the exact slow-path sentinel; a following store with the same
raw view and immutable index reuses the proof. Joins, calls, and backedges
discard it. This removes the redundant store check while preserving the exact
throwing PC, operands, and preceding mutations.

It also proves counted loops from CFG direction, constant initialization,
unique backedge, one positive `iinc`, and bounded trip count. A nested loop can
charge its proven iteration count to an outer safe point instead of running a
second branch per element. If **every** loop in a call-free, handler-free,
monitor-free method is proven, their trip-count product is at most one million,
and no allocation or scheduler-visible operation occurs, the entire region is
emitted as an atomic ordinary JavaScript function rather than a generator.
This follows the existing renderer contract that a bounded raster kernel is
atomic, while remaining independent of class, method, field, and descriptor
names.

The browser's previously unused linear Wasm heap can now be selected through a
JVM option as well as the Node environment. Its typed primitive arrays reduced
local full-frame copying, but did not materially accelerate the JavaScript
raster by itself. An A/B of the existing Wasm JIT exposed a separate generic
bug: Krakatau `wide iinc` instructions demoted both raster loop blocks. Wasm
translation now shares the interpreter's wide-instruction expansion. This
raised the local Wasm full pipeline from 18.99 to 33.43 FPS, but it remained
far slower than structured JavaScript and therefore was not selected as the
default tier.

The bounded ordinary-function candidate records:

```text
sentinelArrayLoads=1
eliminatedArrayStoreChecks=1
coarseCountedLoops=2
atomicBoundedLoops=true
boundedIterationProduct=480000
structuredContinuations=false
safePointSites=0
```

The generated body shrank from 6,458 to 4,537 bytes and generated entries fell
to one per invocation. Firefox compiles the ordinary dynamic function in the
background: its early isolated phase is still cold, while the later full-frame
phase is steady-state optimized. Three clean local Firefox runs measured full
pipeline rates of 95.24, 90.91, and 106.19 FPS, for a **95.24 FPS median**.
All checksums were `15711307`.

Focused JIT and Wasm-heap validation passed **438/438**. A checked Java fixture
with arbitrary identifiers verifies the 4×8 CFG proof, absence of generator
and scheduler branches, all successful mutations, exact mid-loop
`ArrayIndexOutOfBoundsException` PC, and retention of mutations preceding the
exception. The deployed candidate bundle is
`674f3d49c6517509e42f4f74c52fb5e2843bd2a7ce8e549c3c77a8b3b675df53`.
Remote `/diagnostics` remains the acceptance measurement.

### Generic AlterOrb catalog-to-menu compatibility audit

The JVM was also exercised as a generic applet runner rather than as a
Dekobloko-specific launcher. The adapter in `dekobloko-work` reads AlterOrb's
live catalog, downloads and hash-checks each gamepack, uses the catalog's main
class, and passes ordinary applet parameters. `simplemode=true` belongs only to
that adapter's `--until-main-menu` test mode; neither the JVM nor its JIT knows
about AlterOrb titles, login screens, or menus.

The menu detector requires a game-sized software surface, several distinct
painted frames, sufficiently dense/colorful artwork, and a ten-second settling
interval. Applet startup or the sparse Jagex progress panel cannot satisfy it.
Every success also writes a PNG. The consolidated report
`dekobloko-work/.work/alterorb-jvmjs/all-games-main-menu-consolidated-report.json`
contains **44/44 main-menu results**. It combines the original catalog pass
with focused reruns made after generic JVM fixes; it does not relabel timeouts
as successes. An RGB-hash audit found that 40 of the referenced PNGs still
match their successful menu surfaces. Four had been overwritten by later
timeout diagnostics because the first launcher version reused one filename per
title. Success, timeout, exit, and error screenshots now receive distinct,
timestamped paths, so future diagnostic runs cannot destroy menu artifacts.
The four affected success records retain their menu surface hashes and complete
frame histories, but are not counted as preserved screenshot proof.

The failures exposed reusable JVM/JRE defects:

- class initialization was being published before the owning `<clinit>` frame
  returned, allowing other threads to observe default static values;
- primitive byte loads/stores did not consistently apply Java signed-byte
  narrowing in interpreted, generated, structured-SSA, and Wasm paths;
- `PixelGrabber`-style ARGB decoding discarded RGB channels when alpha was
  zero, changing sprite-cropping decisions;
- synchronous generated `checkcast` treated an unloaded array component class
  as a definite covariance failure instead of deoptimizing for asynchronous
  class resolution;
- a partial Wasm method could spill a captured static boolean incorrectly
  across unsupported call edges.

The last case is guarded by bytecode shape only: `getstatic` of descriptor `Z`
captured by `istore`, combined with normal-flow calls. Affected partial Wasm
and generated-JavaScript methods stay in the canonical interpreter; unrelated
methods remain JIT eligible. Tests use arbitrary renamed owners, fields, and
methods. There is no game, class-name, method-name, or descriptor allowlist.

One unusually call-dense title demonstrates that compatibility and startup
speed are separate. Its serial interpreter run reached the verified menu in
226.600 seconds. The scoped mixed-tier route no longer reproduced its previous
null-array corruption, but still timed out at 420 seconds, so tier probing and
generated/interpreted transitions remain slower than interpretation for that
initialization body. A later 300-second interpreter rerun remained runnable on
the changing progress surface but missed its tighter wall-clock deadline; it
was retained as a timeout, not counted as a second success.

The launcher now exposes `--no-jit` explicitly and records that selection in
its report. Interpreter-only catalog runs should be serial or use a much larger
wall-clock budget: four concurrent workers starved the heavy initializers and
caused artificial 420-second timeouts. The catalog audit therefore uses the
completed per-title observations, while performance comparisons must remain
isolated single-worker runs.

The catalog investigation also tightened the fused-renderer acceptance result.
The first live differential found that both compact handwritten triangle
translations generalized control flow that the bytecode did not have. In
particular, the flat raster's verified lower phase emits one scanline and then
returns; treating it as an ordinary lower loop changed pixels. Valid,
permutation-driven gradient inputs exposed another handwritten mismatch.
Consequently compact semantic raster replacements are now disabled by default
and require the explicit experimental
`JVM_ENABLE_SEMANTIC_FUSED_RASTERS=1` opt-in. Generated wrapper/raster fusion
remains enabled and is the correctness path.

While making the differential inputs valid, a fixed tick limit exposed an
over-broad compatibility predicate: merely storing an unused static boolean
was enough to demote a hot scanline to per-pixel interpretation. The guard now
requires the stored local to survive an actual invoke edge and then be read.
Unused obfuscator flags and flags consumed before a call stay JIT eligible.

The checked harness now derives the three wrapper ordering keys and boolean
guards from its structural wrapper plan, permutes valid vertices, and reports
the exact descriptor, iteration, method, and PC on a scheduler-budget failure.
Its final run compared **200 gradient and 200 flat invocations**, observed
32,574 and 31,821 changed pixels respectively, and matched every destination
pixel. The passing default deliberately reports zero compact semantic raster
runs: that is evidence that the generated fused fallback is correct, not a
claim that the rejected handwritten shortcut was repaired.

### Live Firefox 1 FPS renderer investigation (2026-07-23)

The reported 1 FPS was real, but it was not the browser canvas ceiling. The
same Firefox installation sustained 27.91 complete synthetic AWT frames/s
with the expected surface hash. During the game startup/logo sequence,
presentation gaps were instead 6.4–7.2 seconds and stack snapshots repeatedly
stopped in the model/face renderer.

Three generic dispatch defects prevented the already-verified renderer
pipeline from running:

1. The fused-region admission pre-check scanned unreachable bytecode while
   full discovery used verified reachable bytecode. Dead obfuscator calls
   therefore rejected regions that `discoverRegion()` and `compile()` both
   accepted. Admission now uses the verifier's reachable call set.
2. Fused entry existed only for generated callers. The hot outer renderer was
   still interpreted, so every wrapper and raster was materialized as a child
   `Frame`. Warm synchronous `invokestatic` sites now cache the structural
   candidacy and enter the same guarded fused region directly. Failed guards
   leave operands and side effects untouched.
3. Firefox's whole-method preference proved the broader JavaScript generator
   could compile a body, then called the narrower legacy-runner eligibility
   check. Worse, a captured-boolean rejection wrote `false` into the broader
   generator's cache. The whole-method route now uses its own proved
   capability set, and legacy rejection updates only the legacy cache.

All selection remains based on descriptors, CFG/stack verification, reachable
opcode and call structure, and handler semantics. Guest class and method names
were used only to label diagnostic stack output. No renderer identity is
hardcoded in the optimizer.

The same local headless Firefox and production bundle showed this progression:

| Candidate | 45 s presented frames | 60 s presented frames | observed rate |
| --- | ---: | ---: | ---: |
| fusion unreachable | 4 | 9 | 0–1 FPS |
| interpreter-to-fused bridge | 17 | 79 | 9 FPS after logo |
| broad whole-method route | 193 | 374 | 12 FPS after logo |
| corrected tier cache | 312 | — | 11.3 FPS at 20 s; 12.2 FPS at 45 s |

The final run reached 50 presentations by 20 seconds instead of 8, executed
132,803 generated fused regions with zero guarded fallbacks, and reported no
page/runtime errors. The former multi-second wrapper/raster frames disappeared
from sampled stacks. A first-invocation compilation experiment produced 185
frames at 45 seconds versus 193 without it and was reverted.

This is a large startup and 3D-rendering improvement, but it is not the
20 FPS acceptance result. After the 3D logo work finishes, the remaining UI
and text/image composition path plateaus around 12 FPS. The deployed diagnostic
bundle is
`7bcc91a39fef940f602e7a1693f341b71797a7b620b6fe4ee6dde60bab26295b`
and remains available on port 3771 for the next wall-time attribution pass.

### Static-array SSA breakthrough: 38–41 presented FPS (2026-07-24)

The next investigation measured elapsed time rather than ranking invocation
counts. After a 30-second warmup, a sampled 10-second window attributed
approximately 94% of wall time to guest execution. The full-frame RGB snapshot
copy cost only 81 ms (0.8%), and Wasm swizzle plus `putImageData` cost 251 ms
(2.5%). Canvas publication was therefore not capable of explaining the
12 FPS plateau.

Several generic compiler changes were measured independently:

| Candidate | result |
| --- | ---: |
| broad nested whole-method admission | 319 frames at 45 s |
| widened opcode admission | 333 frames at 45 s |
| acyclic CFGs through structured SSA | 341 frames at 45 s |
| production method-key allocation removal | 344 frames at 45 s |
| positional scalar-to-call bridge | 344 frames at 45 s; reverted |
| adaptive constructor callers | 352 frames at 45 s, no steady-state gain |
| adaptive non-monitor effectful callers | 381 frames at 45 s, still 12 FPS steady |

The adaptive tier is Firefox-only by default and promotes only after 64
method-entry observations. Its alternate capability proof still rejects
constructors, class initializers, thread `run` entries, monitor bodies,
unsupported opcodes, and asynchronous class literals. Before promotion the
canonical interpreter executes every effect. The checked fixture verifies that
a generated child exception reconstructs the parent call PC and resumes the
original Java recovery handler. This removed the cold-compilation regression
seen when every constructor-containing caller was admitted immediately, and
substantially improved the loading phase, but it did not solve the steady
renderer.

The post-promotion wall-time sample then exposed one small call-free method as
the largest remaining consumer: a 64-bytecode unrolled `int[]` clear loop took
about 1.8 seconds of an estimated 10-second guest window. Its structure was:
repeated initialized `getstatic` of the same array, an induction variable,
nine `iastore` operations per iteration, and no calls or handlers. The
structured SSA renderer was already producing lexical JavaScript, but each
store still repeated a static-map lookup and called generic array-store
normalization.

The fix is generic and block-local:

- repeated resolved static locations reuse their current value and raw array
  view inside one straight-line SSA block;
- every call and `putstatic` invalidates that block-local value;
- no value survives a block edge, continuation, scheduler safe point, or
  separate invocation;
- `iastore` emits its exact Java narrowing directly as `value | 0`;
- exceptional bounds/null paths still materialize the precise JVM PC, locals,
  and operand stack.

This retains snapshot/state semantics. The canonical static field and Java
array remain the saved state; the raw view and SSA value are ephemeral
generated-function locals and are never serialized. A checked fixture swaps
the static array inside a child call and verifies that stores before the call
reach the old array while stores after it reach the replacement. It also
verifies that direct `iastore` narrowing is emitted without the generic helper.

The performance change was immediate:

| Measurement | Before | After |
| --- | ---: | ---: |
| sampled steady presentations | 121 / 10.02 s | 411 / 10.01 s |
| sampled steady rate | 12.07 FPS | **41.05 FPS** |
| uninstrumented presentations at 45 s | 381 | **1,115** |
| uninstrumented displayed steady rate | 12 FPS | **38–40 FPS** |
| page/runtime errors | 0 | 0 |

The hash probe retained the expected initial animation hashes
`4025147891 → 1583173216` and reported no page or console errors. Its first
20-changing-image window spans the still-warming/loading transition and
measured 16.01 changed images/s; it is not the 30-second steady presentation
window above. This distinction should remain explicit in future acceptance
runs: the browser now presents above the requested 30 FPS after warmup, while
the earliest hash-changing startup window still misses the older 20
changed-images/s criterion.

The focused JIT/scheduler suite passed **484/484** before the final regression
fixture, and the final JIT suite passed **456/456**. The production build
completed with only the existing dynamic-JNI and bundle-size warnings. The
served bundle on `0.0.0.0:3771` is
`fb1548fc05b984614af4c9576d4e2773f66f3e6273dff9dddfb2ac1d615efe48`.

## 2026-07-24: deep asset unpacking and browser audio

A remote diagnostic taken during “unpacking graphics, music and sound”
captured the runnable client inside a 2,980-instruction one-shot asset method
at instruction 1,526 after 71 seconds. This was guest execution, not network
download or host inflate time. Structural inspection of the exact JAR method
found the real exclusion: nine `dup_x2` bytecodes. The method was rejected even
by the relaxed JavaScript tier and therefore executed its first invocation
through interpreter scheduling.

The generic fixes are:

- adaptive constructor/effectful callers now sample elapsed residency once per
  64 interpreter probes and may OSR after 8 ms, instead of depending only on
  repeated method entries;
- `dup_x2` is emitted from verifier-derived operand widths, including the
  category-2 form, with the baseline resume body retaining arbitrary-PC OSR;
- a `dup_x1` post-increment helper is no longer rejected merely because another
  branch contains calls. Calls retain the existing generated dispatch,
  materialization, exception, and deoptimization paths.

No guest owner or method name participates in these decisions. The exact
reported outer method now passes structural admission and compiles to a
resumable baseline JavaScript body in about 67 ms. More importantly, the
archive byte reader beneath it no longer performs one scheduler entry per byte.

The forced `simplemode` Firefox run provides a same-path comparison:

| Deep asset progress | Before | After |
| --- | ---: | ---: |
| first enters the large asset body | 25 s | 20 s |
| compressed block 21 | 35–40 s | before 30 s |
| compressed block 31 | 50 s | before 35 s |
| all 34 compressed blocks | not complete at 120 s | **35 s** |
| runtime/page errors | 0 | 0 |

This fixes the reported unpacking regression, but it does not declare the whole
menu performant. After unpacking, that forced route displayed only about
1–2 FPS in a different set of menu/layout guest bodies; those remain a separate
profiling target.

Firefox audio was independently silent for a concrete integration reason.
`SourceDataLine` and the WebAudio implementation existed, but custom embedders
that loaded only `jvm-debug.js` never loaded the separate registration script,
so `SourceDataLine` selected `MockAudioOutput`. The browser entry now registers
WebAudio inside the runtime bundle and installs pointer, keyboard, and touch
handlers that resume a suspended `AudioContext` under Firefox's autoplay
policy. A Firefox probe verified a real context, queued PCM while suspended,
transition to `running` after a pointer gesture, buffer completion, and zero
page errors.

The final focused JIT suite passed **471/471** and the audio/browser-JRE checks
passed **75/75**. `npm run build:bundle` completed with only the existing
dynamic-JNI and size warnings. The served bundle is
`0217a4771e0c60c689fb4da6ee2267d9614875f9318be0ace930b8516fa14f63`.

## 2026-07-24: scheduler handoffs, not the inner span, limit the forced menu

The forced `simplemode` menu regression was measured separately from the
earlier 38–41 FPS animation path. Its comparable uninstrumented Firefox
baseline was **1.89 presented FPS** after asset loading. The first hypothesis
was that software raster arithmetic itself had become the limiter. Full
descriptor/opcode/CFG/static-field-identity verification was added for the
alpha span, byte-mask color blit, and instance glyph wrapper shapes. These
paths use positional scalar operands and preserve the generic generated path
behind initialization/debugger/shape guards. They do not inspect guest class
or method names.

Those raster changes removed the intended child calls, but the menu remained
at about 1.9 FPS. Time-based scheduler profiling then found the real boundary:
warm generated callers repeatedly handed synchronous library and small guest
callees back to the scheduler. One text body alone recorded about 303,000
generated exits in ten seconds because a synchronous `String` operation was
available through the JRE shim table but not through the classfile-only
synchronous resolver.

The generic corrections were measured in sequence:

| Firefox forced-menu configuration | sustained presented FPS |
| --- | ---: |
| comparable baseline | 1.89 |
| structural alpha/glyph raster intrinsics | 1.89–1.90 |
| direct proven-synchronous instance JRE leaves | 3.14 |
| direct proven-synchronous static JRE leaves in whole-JS mode | 3.63 |
| short primitive-array state helpers | 4.86 |
| short forward-conditional state helpers | **6.74** |

JRE leaves are admitted only when the resolved shim is a plain synchronous
function and does not use the runtime's asynchronous-method sentinel.
Unexpected Promise/sentinel results disable the fast target and retain the
canonical path. Operands remain on the caller stack until the shim returns, so
a thrown Java exception still reconstructs the exact call PC and operands.
Static JRE leaves remain available to the Wasm linker when Wasm is the
preferred tier; direct static execution is used by the Firefox whole-method
JavaScript policy.

The small-helper change is also structural. A method must remain under 32
instructions and contain only the verified scalar field, primitive-array,
invoke, return, and forward conditional operations supported by the generator.
This admitted four-slot clip save/restore and clip narrowing helpers that had
previously incurred a scheduler transition on every drawing primitive.
Renamed fixtures verify both array/static mutations and conditional writes.

The final clean run presented 236 frames from 40 to 75 seconds:
**6.7429 FPS**, with zero page or runtime errors. A low-rate follow-up profile
showed the former high-volume clipping deoptimizations had disappeared.
Remaining scheduler exits were sparse; the dominant work had moved inside
generated scan conversion and text rendering. Two generated edge helpers ran
about 1.45 million times and the synchronous character/glyph paths ran about
1.3 million/0.95 million times in the ten-second profiled interval.

A per-call-site reusable JRE argument-array experiment measured **6.49 FPS**
against 6.74 and was reverted. This rules out those short-lived argument
arrays as the missing large gain. The next optimization should be generic
positional intermethod emission/inlining for verified generated helpers, so
the scan-conversion loop does not construct and recycle a child `Frame` for
millions of synchronous calls.

This is a 3.57× improvement over the forced-menu baseline, but **6.74 FPS is
still unplayable and is not an acceptance result**. The measured-best served
bundle is
`812d1edfd6ed33fc7875b4f1b44492a80ef34dfaf6f7993a6da1b398d0ccae62`;
no game JAR or guest method-name table is involved.

## 2026-07-25: adaptive tier escalation restores the forced Node menu

The generic AlterOrb `jvm.js` launcher exposed a second form of the same
scheduler-bound failure. With `simplemode=true`, realtime guest pacing,
structured Wasm, and the renderer pipeline enabled, the original JAR needed
297.6 seconds to reach and measure the menu. Its 20.096-second window presented
24 dirty frames: **1.1943 FPS**. Distinct surface hashes advanced at the same
roughly 0.8-second interval, so this was real guest/render throughput rather
than presentation coalescing or a finite-animation measurement artifact.

This workload is deliberately distinct from the historical 50 Hz title
animation. The relevant comparison is the same forced offline menu under the
same launcher:

| Node forced-menu configuration | startup + measurement | presented FPS |
| --- | ---: | ---: |
| Wasm-first baseline | 297.6 s | 1.19 |
| restored synchronous scheduler, Wasm-first | 282.1 s | 1.23 |
| partial-Wasm-exit promotion prototype | 274.6 s | 1.28 |
| effectful/call-bearing JS promotion gate fixed | 90.5 s | 8.49 |
| adaptive whole-method escalation, pre-guard-ordering | 88.0 s | 29.05 |
| final, three clean 20-second runs | 87.9–88.0 s | **29.62 median** |

The partial-Wasm-exit prototype promoted 21 methods but produced only a 4%
change; it was removed. The breakthrough was an existing policy bug:
elapsed-time and entry-count promotion was documented and enabled for Node,
but its observation lived inside the `preferWholeMethodJs` branch. A Wasm-first
runtime could therefore never accumulate the evidence needed to choose a
whole JavaScript body for a method Wasm had declined.

The retained policy is structural and adaptive:

- Wasm is probed first and keeps every entry it can handle.
- Only after Wasm declines an entry does the verified effectful/call-bearing
  JavaScript capability proof collect entry or elapsed-time heat.
- A promoted method uses whole-method JavaScript and its synchronous nested
  call policy; no owner or member name participates.
- After 16 distinct safe promotions, the application switches its remaining
  eligible methods to whole-method JavaScript. This threshold is disabled with
  `JVM_ADAPTIVE_WHOLE_METHOD_ESCALATION_THRESHOLD=0`.

The escalation is intentionally application-wide only after diverse evidence.
A fixture verifies that a fully handled Wasm entry accumulates no JavaScript
heat, duplicate observations of one method cannot trigger escalation, and two
distinct safe promotions trigger a configured threshold of two exactly once.

The final counter profile showed 57 entry promotions, 27 elapsed-time
promotions, 84 distinct whole-method promotions, and one escalation. Direct
fused-region execution became active after escalation. It also revealed about
1.04 million legitimate fused guard failures controlled by live static mode
flags. Moving those side-effect-free false guards ahead of debugger, class,
and bytecode-identity checks raised the three clean 20-second runs to 29.62,
29.66, and 29.14 FPS: **29.62 FPS median**, a 24.8x improvement over the
1.1943 baseline. The value is reported without rounding it above 30; it is
consistent with the menu's approximately 30 Hz pacing ceiling.

The focused JIT suite passes **597/597**, the scheduler suite passes **36/36**,
and both modified compiler files pass syntax and whitespace validation. The
headless reports are:

- `.work/alterorb-jvmjs/dekobloko-node-fps-current.json`
- `.work/alterorb-jvmjs/dekobloko-node-fps-adaptive-effectful.json`
- `.work/alterorb-jvmjs/dekobloko-node-fps-guard-first-clean{1,2,3}.json`

## 2026-07-26: Firefox timing separates guest execution from presentation

The 29.62 FPS Node result did not transfer to Firefox. Remote browser
diagnostics still measured roughly 1–2 presented FPS even though the same
generic generated tiers were active. Sampled scheduler wall time identified
large synchronous generated regions rather than asynchronous waits:

- a hot animation method took roughly 46–61 ms per sampled entry in Firefox,
  compared with about 1 ms in Node;
- another lifecycle method took roughly 45 ms in Firefox, compared with about
  0.18 ms in Node;
- a larger generated region reached roughly 103 ms in Firefox, compared with
  about 4.8 ms in Node;
- canvas upload was roughly 7.5 ms per presented frame and framebuffer copying
  roughly 1.5 ms, material costs but not enough to explain the full gap.

The scheduler timing sampler now distinguishes synchronous guest time from
time spent awaiting asynchronous work and exposes a snapshot API suitable for
lightweight browser telemetry. It is configurable through JVM construction,
so the diagnostics page does not need process-environment access.

The browser scheduler also now accepts an `eventLoopYieldStrategy` of
`"timer"` in addition to the existing MessageChannel path. The timer option is
an explicit experiment for Firefox: a continuously replenished MessageChannel
queue can complete many guest frames while `requestAnimationFrame` remains
pending, causing presentation coalescing. This option has unit coverage but is
not recorded as a performance win yet; it must be measured in the same remote
browser before becoming the default.

## 2026-07-26: ordinary adaptive SSA removes generator dispatch

Timing the guest body, rather than counting invocations, separated two very
different costs. Canvas upload remained about 7.8 ms per presented image and
the structurally fused gradient/flat raster wrappers averaged less than
0.1 ms. The expensive remaining text, layout, and dynamic scan loops were
compiled as `structured-ssa-adaptive-positional` JavaScript generators solely
to retain a continuation at rare scheduler safe points. Those generator
resumptions were cheap in V8 but disproportionately expensive in SpiderMonkey.

The structured renderer now has an opt-in ordinary adaptive ABI. It emits the
same verified scalar CFG and fixed operand-join slots as an ordinary function,
with an enlarged but bounded loop budget. If the budget expires, the generated
body spills its exact bytecode PC, scalar locals, and live operand values and
returns to canonical execution. It never attempts to re-enter a partially
completed ordinary region. Debugger and bytecode guards still run before guest
effects. Selection uses only the verified CFG/capability shape; no guest owner
or method name is present.

The exact-source Node A/B at the forced main menu measured:

| Node configuration | presented FPS |
| --- | ---: |
| generator adaptive positional control | 23.66 |
| ordinary adaptive positional | **30.12** |

That is a 27.3% improvement. Reports:

- `.work/alterorb-jvmjs/dekobloko-menu-ordinary-adaptive-control.json`
- `.work/alterorb-jvmjs/dekobloko-menu-ordinary-adaptive.json`

The first clean local Firefox 146 A/B used the production bundle, identical
JAR, sample stride 16, and the same first surface hash (`4025147891`). It was
measured during the initial non-black animation while the launcher still
reported asset block 9 of 9:

| Firefox configuration | changed images/s | transition intervals/s |
| --- | ---: | ---: |
| ordinary adaptive off | 12.12 | 11.51 |
| intermethod ordinary adaptive, run 1 | 19.05 | 18.10 |
| intermethod ordinary adaptive, run 2 | 20.32 | 19.31 |

The second on-run executed 1,302,113 ordinary adaptive entries and reached
only 114 structured safe points. Both on-runs and the off control had zero
page or console errors. Local reports:

- `/tmp/dekobloko-ordinary-firefox-off.json`
- `/tmp/dekobloko-ordinary-firefox.json`
- `/tmp/dekobloko-ordinary-firefox-on-confirm.json`

One generic wrapper still remained: scheduler-visible structured entries
entered the generator even though their nested positional calls used ordinary
SSA. Routing a fresh canonical entry through the same ordinary body retains
normal `Frame` pop/return behavior and falls back to canonical bytecodes at a
materialized safe point. It measured 29.20 FPS in Node, statistically neutral
against the 30.12 intermethod-only result, but removed the remaining
SpiderMonkey generator penalty. Three clean Firefox runs measured:

| canonical + intermethod ordinary SSA | changed images/s | transition intervals/s |
| --- | ---: | ---: |
| run 1 | 22.62 | 21.49 |
| run 2 | 21.81 | 20.72 |
| run 3 | 24.01 | 22.81 |
| **median** | **22.62** | **21.49** |

All three used first hash `4025147891`, had zero page/console errors, and
recorded exactly one structured safe point. This passes the ≥20 changed
images/s acceptance threshold. The Firefox profiler accepts
`PROBE_ORDINARY_ADAPTIVE=0/1` and reports the ordinary-entry counter, allowing
same-bundle differential runs. Reports:

- `/tmp/dekobloko-ordinary-canonical-firefox.json`
- `/tmp/dekobloko-ordinary-canonical-firefox-2.json`
- `/tmp/dekobloko-ordinary-canonical-firefox-3.json`

The focused JIT suite passes 610/610, including an exact safe-point test for
the loop-header PC, induction local, live operand join, and absence of a
generator continuation, plus canonical `Frame` completion. The scheduler suite
passes 36/36. The production bundle builds successfully and is served as
`05df8314b0385f2b9e2ac5415546d490a1421f77d932d499c5fda907bd6a4c03`.

This is a verified breakthrough and acceptance result, but not yet a 30 FPS
Firefox result. Relative to the feature-off control, the median changed-image
rate improved by 86.6% and the median transition-interval rate by 86.6%. The
remote Firefox profile must still be reloaded onto the new hash and measured
separately; the previous 2 FPS report came from the older `e899c8…` bundle.

### Remote Firefox 151 still at 2 FPS: alpha rectangle attribution

The remote profile subsequently reproduced 1.8–2.9 FPS on the accepted
ordinary-SSA bundle (`05df8314…`). This was not stale code: the session used
the expected hash, structured mode, and a visible focused tab. Its lightweight
JavaScript calibration reached 166.67 million iterations/s versus 500 million/s
on the local Firefox 146 acceptance machine. Canvas upload averaged about
6.8 ms per presented image, so presentation still could not explain a
350–550 ms image interval.

A cumulative-timing delta over a 60-second visible window attributed an
estimated 43.4 seconds to one structured wrapper, with 13 sampled entries
averaging 26.08 ms. A second structured body accounted for an estimated
11.6 seconds. The first wrapper's bytecodes select one of a clear, direct
image, or alpha-image path; its nested alpha path is a two-loop primitive
integer-array rectangle with transparent-pixel skips and packed RGB
multiplication. Multiple such rectangles are drawn per changed image, turning
the per-call cost into the observed frame rate.

The JIT now recognizes that inner leaf by its complete descriptor, opcode
sequence, and four packed-channel constants. The direct kernel:

- prevalidates source and destination rectangles and then uses scalar raw-array
  loops;
- retains a bytecode-order slow path for null/bounds failures and partial
  writes;
- does not touch an invalid destination for a transparent source pixel;
- restores the exact invoke PC and all ten operands if it throws;
- contains no declaring-class or method-name condition.

The first production attempt exposed a generic lifecycle hole: the original
method matched the intrinsic, but its caller compiled while the owner was
loaded and not yet published as initialized, so compile-time binding was
skipped permanently. The retained version installs this one complete verified
shape behind a runtime class-initialization guard. Before publication it
deoptimizes before pixel effects; the same compiled caller enters the direct
kernel after publication.

The focused JIT suite passes 626/626. A direct original-JAR compile in the
`LOADED` state contains both the direct alpha kernel and initialization guard.
Node measured 29.56 FPS versus 29.20 immediately before this change. Local
Firefox's early window measured 24.48 changed images/s, but simple mode on that
machine never takes the alpha branch (the counter remains zero), so it cannot
validate the remote-only hot phase. The corrected production artifact is
`151ab7cb9110d9fd36735a246ce6c613661f3cf681bfa39ada5387982eb3893b`;
remote Firefox 151 measurement at the same logo/menu phase remains required.

### Telemetry correction: the 2 FPS path uses opaque transparent copies

Remote session `ms1k0el9-pc7uk6un` removed the ambiguity. It loaded exactly
`151ab7cb…`, used Firefox 151 on the reported eight-core machine, remained
visible, restored all 35 browser-cached assets, and ran structured SSA without
timing profiling. At the animated phase it reported 2.3 FPS while canvas upload
accounted for only about 2 ms per presented image. Across 3.46 million
structured-region entries, however, the alpha-rectangle counter remained zero.
The previous timing attribution to the wrapper was correct, but the inference
that its alpha branch was active was not.

The active wrapper branch passes the sentinel opacity value and calls a
different leaf: a transparent-pixel `int[]` source copy with a four-pixel
unrolled inner loop. The JIT now recognizes this leaf through its descriptor,
complete normalized opcode sequence, verified CFG/stack depths, and
rethrow-only handler proof. It does not inspect the declaring class or method
name. Its direct scalar kernel prevalidates each row, copies only nonzero source
pixels, and retains a bytecode-order slow path for null/bounds faults and
partial writes. Structured callers emit it positionally, with the same
pre-effect class-initialization guard and exact invoke-state reconstruction used
by the alpha kernel.

The original JAR contains two methods with the same descriptor. Structural
recognition accepts only the transparent-copy body and rejects its
non-equivalent sibling. The focused JIT suite passes 643/643 and the
scheduler/browser configuration suite passes 38/38. In the Node menu run the
new counter reached 161,970 with zero slow paths, proving activation, but the
fixed-window result was 28.81 FPS. This is not a Node performance breakthrough
relative to the previous roughly 29 FPS runs. The production artifact
`0f002782e97d501cd766890c379d1b1c1c91f7de5cdb3cf12c2c6e19271ae503`
is deployed with both activation counters in browser telemetry; a fresh remote
Firefox session is required to measure whether the much slower Firefox guest
body benefits materially.

Remote session `ms1kwhs4-mbswuyeu` then verified that artifact and the direct
kernel: the counter rose from zero to 120,683 with no slow paths. The displayed
FPS still oscillated from roughly 3 to 12, while presentation deltas over the
visible stable window were about 9–10 changed images/s. Cumulative canvas upload
and copy time remained small relative to wall time. Thus the new leaf is real
and removes work from the correct active branch, but it is not the dominant
remaining logo cost.

To locate that remaining cost without returning to invocation profiling, the
sampled generated-body timer now chooses its 1-in-128 sample before formatting
the guest method identity. Unsampled entries no longer allocate an
owner/name/descriptor string and perform no clock read. The browser diagnostic
page enables this elapsed-time sampler by default (it can be disabled with
`?timings=0`) and reports cumulative sampled rows through telemetry. Artifact
`30af4729b25d3c5b2c2358335442b719c7755ab6e0baa0b829e573d469744b9a`
contains this profiler; the focused JIT suite passes 645/645.

### Remote time profile: reference-returning calls retained Frames

Remote session `ms1le776-xmmcahpx` loaded `30af4729…` with the low-overhead
timer. Its visible logo window averaged roughly 7–8 presented images/s and
still dipped to 3 FPS. The recurring time was no longer concentrated in the
fused gradient wrapper. It appeared across recursive UI/component traversal
bodies: container draw methods, child-list iteration, and virtual child calls.
Audio mixing and byte conversion were measurable but represented only a
minority of the wall time.

Inspection of the generated call adapters exposed a generic asymmetry.
Structurally proven acyclic callees already advertise
`jvmFramelessPositional`, but the adapter accepted that proof only for primitive
return types. The hot child-list cursor methods return object references, so
every `next()` call still acquired, initialized, pushed, popped, and cached a
child `Frame`, despite having no continuation or scheduler safe point.

The positional adapter now permits reference returns only for the immediate
acyclic frameless body. Adaptive/suspendable reference-returning bodies retain
the canonical framed path because their reference liveness across a
continuation is not yet proven. Exceptions from the immediate body still
restore the omitted child frame before normal JVM dispatch. Selection uses the
callee's verified structural capability and return category, never a guest
class or method name.

The original-JAR Node menu run exercised 1,131,525 newly frameless reference
calls. It measured 28.83 FPS versus 28.81 before the change, so there is no
Node performance claim. The focused JIT suite passes 650/650 and the
scheduler/browser configuration suite passes 38/38. Production artifact
`000b0e6f9fe0e20de36d87bbe38b47114c50bb6b937ed923ad9adb6f1dbc2355`
is deployed with a telemetry counter for remote activation and measurement.

Remote session `ms1lyu7e-w3uofl1b` verified 68,760 frameless reference calls by
213 seconds with no runtime error. The first post-frame sample was 1.8 FPS and
the displayed value continued to dip to 3 FPS, but the matched 123–213 second
presentation window reached 8.51 changed images/s versus 7.93 for the preceding
bundle (+7.3%). The optimization is therefore retained, but the modest gain and
deep transient dips are nowhere near the 30 FPS requirement.

That run also exposed a profiler blind spot: a frameless positional call no
longer passes through `runGeneratedFrame`, so its elapsed time was absent from
the sampled method table. Artifact
`e02cd6f1e7b2650e5435fc45b14d6f1975c793f041e553afc9a449ef1347fb0c`
extends the same preselected 1-in-128 timer into frameless positional bodies.
The method identity is already bound in the call plan; unsampled calls allocate
no identity string and read no clock. This allows telemetry to attribute the
previously missing majority of generated intermethod time. The focused JIT
suite passes 651/651.

### The 3 FPS logo path includes a clipped framebuffer gradient

The extended timer closed the frameless-call attribution gap on remote Firefox
151. In session `ms1mgy7o-zfi52cyk`, the largest sampled inclusive bodies were
`lj.a(IIIZ)V` (1,368 ms across 41 samples), `ai.e(B)V` (799 ms across 12
samples), and `dl.a(BZLck;II)V` (531 ms across 17 samples). These values
overlap: the logo renderer divides the 640x480 surface into eight clipped
regions, its image helper enters `lj.a` for the sentinel image, and `lj.a`
performs the background, logo, particle, and optional overlay work.

Following that chain to its leaves identified a previously generic framebuffer
operation. A six-int static method computes a 16.16 vertical interpolation
phase, clips a rectangle against six static surface values, and stores one
interpolated RGB value across every pixel of each scanline. The generated guest
body still executed its inner pixel loop as scalar JVM operations.

The JIT now recognizes this operation using only its `(IIIIII)V` descriptor,
the complete normalized opcode and packed-channel constant sequence, verified
CFG/stack depths and transparent handlers, and repeated static-field descriptor
and identity relationships. No guest class, method, or field name participates.
Against the original obfuscated JAR, the matcher accepts only the gradient
member and rejects the three other methods with the same descriptor. It also
accepts the equivalent recompiled class.

The direct kernel preserves clipping phase, Java integer overflow and signed
shifts, division-by-zero ordering, null behavior, and partial writes before a
bounds exception. The focused JIT suite passes 657/657 and the
scheduler/browser configuration suite passes 36/36.

The first original-JAR Node menu run executed 7,128 gradient kernels and
measured 30.13 changed images/s over 20 seconds, versus the prior 28.83 result.
Hoisting normal-array null and bounds checks from every pixel to a proven range
per scanline then measured 31.56 changed images/s, with 7,429 gradient calls
and zero slow paths. That is about +9.5% over the pre-change run; these are
adjacent fixed-window runs, not a multi-run median. The malformed-array path
still performs checks per store so that partial-write exception behavior is
unchanged.

This is useful but is not a 3-to-30 FPS explanation on its own. Production
artifact
`1bdd8898aa4fe0d3ae33e448e1a524e914e058fa38499418b2aac13ddccbf052`
is served on port 3771 with `clippedGradientRuns` and
`clippedGradientSlowPaths` telemetry. A fresh remote logo run must verify both
activation and the Firefox delta before the next leaf is selected.

### The post-gradient 3 FPS report was asset-worker starvation

Remote session `ms1nqzxr-i2e2u13t` loaded the exact gradient artifact and
verified 9,756 clipped-gradient entries with zero slow paths. The manual report
still showed 2.4 FPS, but it was not a steady logo or menu sample: the loader
was at `Preparing game assets · block 9 of 9`. Ten-second deltas show the
distinction:

- before the heavy block, presentation sustained roughly 11–12 changed
  images/s;
- from 10:39 onward, several complete ten-second intervals presented no image
  while runnable asset code continued;
- canvas upload remained about 8 ms per presented image and therefore did not
  explain the multi-second gaps;
- sampled generated asset entries reached 337–397 ms.

The scheduler already had a 16 ms wall-clock deadline, but structured SSA
coarsened nested counted loops and polled only their outer loop. A 100,000-trip
decoder loop could consequently complete atomically before the deadline was
observed. This was a generic compiler scheduling bug, not a Dekobloko renderer
identity.

Effectful structured methods now retain polls in every nested loop. Their poll
interval scales from verified instruction, invocation, allocation, and nested
loop structure; fully bounded call-free numeric kernels retain the atomic
optimization. The original decoder shape now compiles with 33 loop headers,
zero coarse loops, and a 64-backedge poll budget. No guest method or class name
participates.

The focused JIT suite passes 661/661 and scheduler/browser tests pass 36/36.
Node steady menu performance remained 31.71 changed images/s. Time to the end
of that fixed menu window increased from 97.1 to 116.6 seconds because other
Java threads and loading animation now receive CPU during asset decoding.
Therefore this is explicitly a responsiveness/fairness fix, not a loading-time
optimization. Artifact
`ecba84a376fdd704ee038a7f78d201d695cf5dbc49102973be3fa9219f31b49e`
is deployed on port 3771 for a fresh Firefox paint-gap measurement.

### Fair scheduling exposed an oversized audio state machine

Session `ms1otmbj-pm96jhyn` loaded the fairness artifact. Structured safe
points rose from 9 to 49, confirming activation, but the loader remained at
asset block 9 after 22 minutes and the reported rate was still 1.5–2.7 FPS.
The active worker stack had moved beyond decompression into audio generation:
`ia.c()Z`, called through the audio-buffer chain.

This method is a structurally exceptional compiler input: 2,675 bytecodes,
419 field reads, 289 primitive-array accesses, eight loops, and fifteen calls.
The structured JavaScript renderer emits one 733 KB generator for it. Because
the method remains active across repeated buffer work, completed-entry timing
does not attribute its in-progress wall time.

The existing Wasm tier can compile 369 of its 380 CFG blocks into a 58 KB
partial module. It was never attempted because the global JavaScript-first
policy preferred any available whole-method JavaScript body. The policy now
tries Wasm first for methods selected only by:

- at least 2,048 verified bytecode instructions;
- at least one backward branch;
- non-constructor method identity.

Smaller renderer methods retain JavaScript-first behavior, and unsupported
Wasm regions retain exact materialized fallback. Guest class and method names
do not participate.

The focused JIT suite passes 666/666 and scheduler/browser tests pass 36/36.
Node verified two selected oversized methods and 148,534 Wasm entries. Its
time-to-menu was statistically neutral (115.7 versus 116.6 seconds), while the
menu window moved from 31.71 to 30.83 changed images/s. This is not a Node
performance claim; it is a targeted test of Firefox's severe giant-generator
pathology. Artifact
`13c6b93e37a5da376dace8d00c8c340ec07a29b3bb838ca9b8e8492d635bee83`
is deployed with aggregate `wasmRuns` and `oversizedWasmFirstMethods`
telemetry.

### Native-long loop routing removes the Firefox asset stall

Remote session `ms1tqx6n-tave1q09` made the late startup gap precise. The
loader remained at its generic asset label for more than 36 minutes, but the
active JVM stack was sound-effect generation:

`bi.b()Lud;` → `bi.a()[B` → `kj.a(II)[I`.

The leaf is an 824-bytecode sample synthesizer with repeated array operations,
double arithmetic, and exact Java `long` fixed-point operations. Structured
JavaScript rejected it at `i2l`, so Firefox repeatedly entered the generic
generated dispatcher and represented the long values with `BigInt`. This was
not ZIP inflation, Canvas upload, or AWT drawing time.

The tier policy now recognizes this generic shape without any guest owner,
method, or descriptor identity:

- a verified backward branch;
- at least 256 bytecode instructions;
- at least eight operations from the native-Wasm `i64` arithmetic/conversion
  set.

Such methods try Wasm before whole-method JavaScript. Small helpers retain the
ordinary JavaScript policy, constructors and class initializers retain their
atomic lifecycle rules, and unsupported Wasm regions still spill exact JVM
state to the existing fallback. `JVM_DISABLE_LONG_ARITHMETIC_WASM_FIRST=1`
provides a differential control, while
`longArithmeticWasmFirstMethodCount` verifies activation.

The checked-in extracted synthesizer benchmark compares the actual
`kj.a(II)[I` bytecode under both policies. At 22,050 samples its three-run
median improved from 21.21 ms to 9.83 ms (2.16×), and the output checksum was
identical (`1710133148`). At 2,000 samples it improved from 7.46 ms to 1.44 ms
(5.18×). The complete Node launch was neutral: time-to-menu was 118.3 seconds
and the menu window was 30.38 FPS, versus the recent 115.7-second/30.83-FPS
run. The isolated win therefore must not be presented as a Node whole-game
speedup.

The clean Firefox 1509 run against artifact
`c2bbfe1538cc1086f9e5067c29d865526c6c87b50592dbe808b5ac283466745e`
reached the first visible frame in 9.87 seconds. The policy selected one
long-arithmetic method by that point. Three clean standard expected-hash
20-image runs measured 20.01, 23.55, and 19.35 changed images/s: median 20.01,
with zero page or console errors in every run. After the startup window,
ten-second telemetry intervals sustained 43–50 presented images/s. (The
acceptance probe counts sampled image changes, while the side panel counts all
presented images.) This also resolves the apparent 1–2 FPS “main menu”
contradiction:
the earlier report was captured while asset work was still active, not at a
settled menu ceiling.

The browser launcher had an independent progress-state bug. Lazy compressed
blocks processed after the first visible frame could call the startup progress
hook again, replacing the completed `Game ready` status with the stale 95%
asset label. The hook now becomes display-inert after the first visible frame;
the compression logging remains available, but it cannot regress the completed
loader.

### The remote 2 FPS logo is blocked by a table-building class initializer

Session `ms1w94du-180w4qto` on the remote eight-core Firefox machine loaded the
correct `c2bbfe…` artifact and reproduced the report. After the first visible
frame at 54.4 seconds it briefly reported 2.9 FPS, then stopped presenting for
long intervals. Canvas was not the cause: only 339 ms total had been spent
uploading all 46 images at the 81-second diagnostic.

The active game thread was still performing asset initialization. Its
innermost frame was `kj.<clinit>()V`, reached through sound-bank construction.
That 64-bytecode initializer creates eight arrays and fills two 32,768-element
lookup tables through repeated random-number and sine calls. The JVM had a
blanket rule excluding every class initializer from every generated tier, so
Firefox ran the table loops bytecode-by-bytecode while the logo shared the same
game thread.

Class initializer compilation is now admitted only by a lifecycle-specific
structural proof:

- the reserved JVM `<clinit>()V` lifecycle method is static, handler-free,
  monitor-free, synchronously compilable, and contains a real backedge;
- every static write resolves to the class currently being initialized;
- instance-field writes, explicit throws, interface/dynamic invokes, and
  non-constructor special invokes are rejected;
- debugger/tracing entry still takes the canonical path;
- generated return calls the normal `completeClassInitialization` hook, so the
  class is published and waiters wake only after every generated effect;
- exceptions retain the normal unwinding path and mark the class erroneous;
- `JVM_DISABLE_HOT_LOOP_CLASS_INITIALIZERS=1` restores the interpreter for
  differential measurement.

The SSA renderer also gained ordinary `lconst_0`/`lconst_1` scalar support,
which is required to feed exact Java long constructor operands without
materializing the bytecode stack. No guest class, field, or ordinary method
name participates in selection.

The extracted original initializer produces identical checksums for every
static array under both tiers, and both paths publish the same `INITIALIZED`
state. Node's isolated median regresses from 69.45 ms interpreted to 116.93 ms
structured because Node's burst interpreter is exceptionally fast and the
generated safe-point/call boundaries nearly double scheduler entries. This is
therefore a targeted Firefox experiment, not a Node performance claim. Artifact
`7a476e62019758155ad45bb3ed2495c4a555bfa0e3cb1ee2a66fb59044d787ac`
is deployed with the `hotLoopClassInitializers` activation counter; the remote
logo run decides whether the browser's multi-second interpreter cost is
removed.

That remote decision was negative. Session `ms1yfzap-1gtwlpwt` activated two
generated class initializers but, after 33 minutes, had presented only 16
images while 72,331 dirty paints accumulated and were coalesced. The generated
initializer monopolized the browser task queue instead of shortening the
phase. The experiment was removed and the deployed runtime returned byte-for-
byte to artifact `c2bbfe1538cc1086f9e5067c29d865526c6c87b50592dbe808b5ac283466745e`.
No class initializer fast path remains enabled.

Validation:

- `timeout 90s node node_modules/tape/bin/tape test/jitCompiler.test.js`:
  681/681 passing.
- `timeout 90s node node_modules/tape/bin/tape
  test/schedulerPerformance.test.js test/browserBundleConfig.test.js`:
  38/38 passing.
- `npm run build:bundle`: successful with the four existing webpack size and
  dynamic-require warnings.

## 2026-07-27: phase-aware Node logo profile corrects the 50 FPS claim

The historical 49.999 FPS Node result was valid for its fixed frame-25→200
window, but it was not a Jagex-logo benchmark. Visual inspection of the saved
surfaces shows frame 25 on the logo and frame 50 onward on the login screen.
Most of that interval therefore measured login-screen publications. It cannot
be used as the old side of a "50 FPS logo → 18 FPS logo" regression.

The checked-in `dekobloko-work/scripts/benchmark-dekobloko-node-logo.js`
harness now classifies sampled 640×480 surfaces before calculating FPS. The
verified logo frames contain at most about 16,000 non-black pixels; the login
panel contains about 68,000. The deliberately wide 50,000-pixel boundary
separates every captured state. The benchmark reports the complete cold phase
and a warm phase beginning at published frame 20, and stops the phase at the
first login-classified sample. PNG work occurs only every ten frames.

Three fresh unprofiled Node processes measured:

| run | full logo FPS | warm logo FPS | last logo | first login | errors |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 15.3007 | 21.0144 | 90 | 100 | 0 |
| 2 | 14.8930 | 20.5396 | 90 | 100 | 0 |
| 3 | 16.0339 | 20.5516 | 90 | 100 | 0 |
| **median** | **15.3007** | **20.5516** | — | — | **0** |

The initial surface in all three runs retained SHA-256
`b13065a65ee4864a589226b72c486efb790f4ce7bfe2434570e79d8506c48191`.
Animated logo and login hashes legitimately varied with clock phase. The
phase transition and non-black-pixel classification were stable.

### Low-overhead CPU profile

V8 native sampling was enabled around a separate frame-0→70 run; JVM method
and per-entry timing probes remained disabled. In the final 2.750 seconds,
which correspond to the warm logo:

- `ug.a(Lvg;IIIZIII)V` owned 68.3% inclusive;
- the fused gradient raster `oj.a(IIIIIIIBIIII[IIIII)V` owned 25.4%;
- the generic generated `ug` resume body alone used 29.6% self;
- fused-entry guards used 5.1% self;
- PNG encoding used 0.3% self.

The complete profile showed why the generic resume body appeared. Node begins
with the Wasm-first policy. A partial `ug` module can exit at a nonzero
bytecode PC; structured SSA requires PC 0 or its own continuation, so that
invocation resumes in the generic generated body. This transition is real,
but it is not the main explanation for the apparent 50→18 regression:

- increasing `JVM_EVENT_LOOP_YIELD_MS` from the resolved default 16 to 1000
  raised the comparable warm interval from 18.2146 to 20.4246 FPS;
- forcing `JVM_PREFER_WHOLE_METHOD_JS=1` measured only 18.8188 warm FPS and
  delayed the login transition beyond sampled frame 100;
- the default three-run series converged at 20.55 warm FPS, and the enlarged
  scheduler-slice run published each ten-frame group in about 0.49 seconds.

The conclusion is that current Node logo publication is approximately a 20 Hz
phase with roughly 10% avoidable resume/scheduler overhead. The old 50 FPS
number described a different screen. Firefox's observed 1–3 FPS startup
remains a separate problem: remote diagnostics showed asset/audio/class-
initialization work starving visible logo publication, not a 2 FPS Canvas or
steady renderer ceiling.

### Reproducibility record

The authoritative run must include immutable source and generated-artifact
identity. The three-run series above used:

- Node `v26.4.0`, Linux x64;
- `java-tools` commit SHA-1
  `f2cd1a8b2189a73e3ac8ecd7da072dd8ec9dc4cd`, tree SHA-1
  `66117dad014dd56e2d7497cad743f645d22a807f`, tracked clean; the checkout
  had unrelated untracked runtime files;
- `dekobloko-work` commit SHA-1
  `b8ef21dae3f68bb6075789a2b0cdbdff1a6e6d3a`, tree SHA-1
  `22729e097d6db21b824231472e9000dd390f6969`, tracked dirty because the
  benchmark/provenance implementation itself was under test; its tracked
  binary patch SHA-1 was `7d6e032defde7ff842f89f6d60e257dd0929afa8`;
- declared generating JAR `/home/kreijstal/git/dekobloko-work/dekobloko.jar`,
  SHA-1 `0247481f656556ba685ce399f119f074fa679951`, SHA-256
  `a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`;
- measured 344-file generated class tree at
  `.work/jvmjs/hybrid-all-recompiled-lean-carriers/classes`, deterministic
  SHA-256
  `b2e7bce0e174a31bb0a0984f6bde2e2312e2ed5c009b058e29c4145c3cfce411`.

The exact environment was
`JVM_BENCHMARK_METADATA=1`, `JVM_FAKE_TIME=1000000000000`,
`JVM_FAKE_TIME_REALTIME=1`, `JVM_WASM_JIT=1`,
`JVM_WASM_STRUCTURED=1`, `JVM_ENABLE_RENDERER_PIPELINE=1`,
`JVM_FRAME_EVERY=10`, `JVM_FRAME_LIMIT=11`, and
`JVM_EXIT_AFTER_FRAME_LIMIT=1`, plus the per-run `JVM_FRAME_DIR`.

Resolved gates were: 16 ms message-channel scheduler yield, interpreter burst
1024, realtime fake clock, method/time profiling off, Node Wasm-first policy,
renderer pipeline/scalar loops/scalar guest bodies on, scalar-SSA extras off,
long-arithmetic Wasm-first on, structured Wasm on, structured SSA
continuations/dispatch islands/deferred call materialization/local value
numbering/static-boolean guards/coarse counted-loop safe points/atomic bounded
loops on, and fused direct calls/handwritten kernels on with semantic raster
kernels off.

Going forward, an FPS result is authoritative only when it records the two
commit and tree SHA-1s, dirty state and recoverable tracked patches, generating
JAR hashes, generated class-tree hash, exact environment, resolved gates,
phase rule, surface hashes, Node/browser version, and runtime errors. The new
benchmark writes all of these to `result.json`; it also saves dirty tracked
patches and hashes the exact benchmark and runner scripts.

## 2026-07-27: preserving SSA across void-child deopts unlocks direct fusion

The preceding conclusion that only about 10% of the logo cost was avoidable
was wrong. It described the symptom in the native profile, but not why the
structured body had fallen permanently into its generic resume companion.

Exit-only linkage telemetry found two verified direct wrapper entries and
hundreds of thousands of ordinary fused executions, but exactly zero direct
fused executions. A trace of the generated outer body proved that the direct
sites were present. The first structured invocation reached them before all
wrapper/raster dependencies were linkable. Its canonical void-child fallback
then returned a transient child deoptimization from the generated function.
Although the child later completed, the caller's scalar generator continuation
had been discarded. Every subsequent face therefore ran through the generic
resume body, materialized the operand stack, and dispatched the wrapper call
through `tryInvokeSyncAt`.

The SSA renderer now retains a continuation across three scheduler-visible
void-call outcomes:

- the target is not synchronously linkable yet and must execute canonically;
- a generated child returns a transient deoptimization;
- the child changes the thread out of the runnable state.

Before yielding, it records the exact invoke or post-invoke PC and materializes
the JVM state required by the child/interpreter. After the void child completes,
the caller resumes its existing scalar locals at the post-call PC. Non-void
children retain the conservative old behavior because their eventual return
value must be reconstructed before an SSA continuation can consume it.
Exceptions still materialize the throwing invoke operands and use the normal
dispatcher. Cold direct sites are linked only after the owner loads and still
require the exact descriptor, static method identity, complete bytecode/CFG
shape proof, initialized classes, and normal debugger/trace guards. No guest
class or method name is used by tier selection.

The direct counter changed from 0 to the complete fused population. In the
accepted three clean processes:

| run | full logo FPS | warm logo FPS | last logo | first login | direct / fused | errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 27.7532 | 36.1377 | 160 | 170 | 427,055 / 427,055 | 0 |
| 2 | 26.9764 | 35.5775 | 160 | 170 | 421,847 / 421,847 | 0 |
| 3 | 26.7509 | 36.3159 | 160 | 170 | 427,055 / 427,055 | 0 |
| **median** | **26.9764** | **36.1377** | — | — | — | **0** |

This is a 75.8% increase over the preceding 20.5516 warm median. The logo lasts
for a fixed wall-clock interval, so a faster renderer publishes more logo
frames before the login transition; the capture window was increased from 11
to 22 ten-frame samples. All runs retained initial surface SHA-256
`b13065a65ee4864a589226b72c486efb790f4ce7bfe2434570e79d8506c48191`,
classified the first login surface at frame 170, and reported no runtime
errors. The complete per-sample hashes are in each `result.json`.

The accepted result used Node `v26.4.0` on Linux x64 and:

- `java-tools` commit
  `f2cd1a8b2189a73e3ac8ecd7da072dd8ec9dc4cd`, tree
  `66117dad014dd56e2d7497cad743f645d22a807f`, tracked dirty; run-two
  tracked-diff SHA-1 `1e7c67f4431fe8ba13794fc9e498b396cb21e858`
  and saved patch SHA-256
  `9f441aca1ae08b9b4bb0486cbc1da4be5a9cfa65f9709f8871887ce4d818e97a`;
- `dekobloko-work` commit
  `b8ef21dae3f68bb6075789a2b0cdbdff1a6e6d3a`, tree
  `22729e097d6db21b824231472e9000dd390f6969`, tracked dirty; run-two
  tracked-diff SHA-1 `ba8de1f091e00c9a48cd4636d7cec32fa72704ae`
  and saved patch SHA-256
  `89e1683dba9dbe140a3e6671e825334e7b699de9010cea74f405bbed68c2ec44`;
- generating `dekobloko.jar` SHA-1
  `0247481f656556ba685ce399f119f074fa679951`, SHA-256
  `a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`;
- 344 generated class files with tree SHA-256
  `b2e7bce0e174a31bb0a0984f6bde2e2312e2ed5c009b058e29c4145c3cfce411`.

The exact explicit environment was:

```text
JVM_BENCHMARK_METADATA=1
JVM_ENABLE_RENDERER_PIPELINE=1
JVM_EXIT_AFTER_FRAME_LIMIT=1
JVM_FAKE_TIME=1000000000000
JVM_FAKE_TIME_REALTIME=1
JVM_FRAME_DIR=<per-run artifact>/frames
JVM_FRAME_EVERY=10
JVM_FRAME_LIMIT=22
JVM_WASM_JIT=1
JVM_WASM_STRUCTURED=1
```

Resolved gates were a 16 ms message-channel yield, interpreter burst 1024,
realtime fake clock, JIT enabled, method/timing probes disabled, Wasm-first
whole-method policy, renderer pipeline/scalar loops/scalar guest bodies
enabled, scalar-SSA extras disabled, long-arithmetic Wasm-first enabled,
structured Wasm enabled, all structured-SSA continuation/dispatch/deferred
materialization/local-value/static-boolean/coarse-safe-point/atomic-loop gates
enabled, and fused direct calls plus handwritten kernels enabled with semantic
raster kernels disabled.

Validation:

- `timeout 90s node node_modules/tape/bin/tape test/jitCompiler.test.js`:
  691/691 passing;
- `timeout 90s node node_modules/tape/bin/tape
  test/schedulerPerformance.test.js test/browserBundleConfig.test.js`:
  38/38 passing;
- `node scripts/differentialFusedRenderers.js
  ../dekobloko-work/.work/jvmjs/hybrid-all-recompiled-lean-carriers/classes`:
  200 gradient and 200 flat invocations passed;
- `npm run build:bundle`: successful with the four existing webpack warnings.

### Handwritten code is the target, not the tier

Exit counters added after the accepted series verified that its 36 FPS result
installed and executed zero fingerprint-selected handwritten regions.
`JVM_DISABLE_HANDWRITTEN_FUSED=1` measured 35.8601 warm FPS versus 35.6773
without the variable, with 424,451 direct generated fused executions in both
runs. The difference is noise. The fingerprint implementation is now opt-in
only via `JVM_ENABLE_HANDWRITTEN_FUSED=1`.

The live differential harness now uses three independent runtimes:

1. canonical baseline execution;
2. generated fusion with every handwritten kernel disabled;
3. the structurally derived compact handwritten raster as the target oracle.

For both renderer descriptors, all 200 cases produce identical pixels across
all three runtimes and the oracle counter proves the handwritten target really
ran 200 times. The generated-source contract additionally requires a fixed
positional wrapper ABI, scalar wrapper/raster locals, a counted scalar
scanline loop, and no `Frame`, operand-stack access, `tryInvokeSyncAt`, or
`runGeneratedFrame`.

This does not yet mean textual/code-shape identity. The generated raster still
uses scalar `pc` plus `switch` to represent its verified CFG, while the target
uses lexical loops. Removing that final scalar dispatch through generic CFG
structuring is the remaining compiler task; copying or fingerprint-selecting
the handwritten implementation would not satisfy it.

## 2026-07-27: generic lexical fused kernels recover 50 FPS

The remaining task above is complete for the fused-region opcode subset.
`FusedRegionCompiler` now feeds each verified wrapper/raster/scanline CFG to
the shared Ramsey structurer and emits lexical JavaScript blocks, `if` branches,
labeled `while` loops, `break`, and `continue`. Operand values crossing an edge
are assigned to fixed destination-block join slots; there is no runtime
operand stack and no scalar `pc` dispatcher. Locals remain scalar JavaScript
variables. Static locations, child kernels, precise throwing PCs, locals, and
operand snapshots use the same verified region metadata as the state-machine
fallback.

The compiler is generic:

- admission is still descriptor/opcode/CFG/stack and repeated-callee shape;
- method and class names do not participate;
- irreducible/switch/unsupported CFGs retain the existing generated fallback;
- handler-only code is excluded from normal CFG emission but exception state
  is still reconstructed for the JVM dispatcher;
- an always-throwing early bailout keeps a compile-time placeholder solely to
  preserve verifier stack shape for syntactically following code;
- `JVM_DISABLE_LEXICAL_FUSED_KERNELS=1` selects the old scalar state machine
  for same-bundle differential measurement.

The checked differential harness now requires `lexicalRaster: true` and
`rasterPcSwitch: false` for both families. Canonical JVM execution, generated
lexical fusion, and the handwritten target produced identical pixels for 200
gradient plus 200 flat invocations. The target counter proved that the
handwritten oracle actually executed every case. The focused exception,
initialization, debugger, and restored-frame tests also execute with lexical
kernels enabled by default.

One same-bundle state-machine control measured 33.5565 warm logo FPS with
445,283 direct fused calls, zero lexical kernels, zero handwritten kernels,
and no errors. The lexical series measured:

| run | full logo FPS | warm logo FPS | first login | lexical kernels | direct fused | errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 38.1041 | 49.8804 | 240 | 6 | 604,127 | 0 |
| 2 | 38.3455 | 49.9991 | 240 | 6 | 604,127 | 0 |
| 3 | 37.9219 | 49.9991 | 240 | 6 | 604,127 | 0 |
| **median** | **38.1041** | **49.9991** | — | — | — | **0** |

The repeated 49.999 values indicate that the generated renderer has reached
the guest's approximately 50 Hz pacing boundary in this realtime-fake-clock
Node configuration. Unlike the historical fixed frame-25→200 result, every
sample used for this rate is classified as Jagex-logo; the first login sample
is frame 240.

Run-two provenance:

- Node `v26.4.0`, Linux x64;
- `java-tools` commit/tree
  `f2cd1a8b2189a73e3ac8ecd7da072dd8ec9dc4cd` /
  `66117dad014dd56e2d7497cad743f645d22a807f`, tracked dirty,
  tracked-diff SHA-1 `cda06ac5804e46569443f07789c97a7c7f8d12ed`,
  saved patch SHA-256
  `7ae87a2f3e3479b2bb897338c27a186cd93984cd9d5b253bec698fa4c8d87428`;
- `dekobloko-work` commit/tree
  `b8ef21dae3f68bb6075789a2b0cdbdff1a6e6d3a` /
  `22729e097d6db21b824231472e9000dd390f6969`, tracked dirty,
  tracked-diff SHA-1 `53f63ca4c7fb69160f7bf1693dda1db4327aafe6`,
  saved patch SHA-256
  `fc8d79ca1089fc7caddc69e3bee844ff7e3cd19a754a9eb0036d7578d103682f`;
- generating JAR SHA-1
  `0247481f656556ba685ce399f119f074fa679951`, SHA-256
  `a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`;
- generated 344-file class-tree SHA-256
  `b2e7bce0e174a31bb0a0984f6bde2e2312e2ed5c009b058e29c4145c3cfce411`;
- benchmark/runner SHA-256
  `01aa65963cc62590ccaa15ae33cfacd35f0a626cec57fd20994b2788de2937ee` /
  `1e61a3047d34ddb1fb9bb57aea288a05cd85ed92d9884027a7f525ab8c7bfa4e`.

Explicit environment was `JVM_BENCHMARK_METADATA=1`,
`JVM_ENABLE_RENDERER_PIPELINE=1`, `JVM_EXIT_AFTER_FRAME_LIMIT=1`,
`JVM_FAKE_TIME=1000000000000`, `JVM_FAKE_TIME_REALTIME=1`,
the per-run `JVM_FRAME_DIR`, `JVM_FRAME_EVERY=10`, `JVM_FRAME_LIMIT=36`,
`JVM_WASM_JIT=1`, and `JVM_WASM_STRUCTURED=1`.

Resolved fused gates were enabled/direct/lexical
`true/true/true`, handwritten/semantic-raster `false/false`; all previously
recorded structured-SSA, Wasm, scheduler, and profiling gates were unchanged.
The initial surface SHA-256 remained
`b13065a65ee4864a589226b72c486efb790f4ce7bfe2434570e79d8506c48191`.

Validation after the lexical emitter change: 691/691 focused JIT assertions,
38/38 scheduler/browser assertions, the 400-invocation three-runtime
differential, and `npm run build:bundle` all passed. The bundle retained only
the four existing webpack warnings.

## 2026-07-27: remote sound-bank attribution after profiling was fixed

The ordinary launcher accidentally converted absent `timingRate` and
`schedulerRate` query parameters through `Number(null)`. Both values became
zero and were clamped to one, so the supposedly lightweight default measured
every generated method and scheduler entry. The temporary launcher now enables
method timing only with `?timings=1`, uses the intended 128/256 defaults for
explicit profiling, and serves ordinary runs with timing disabled. A clean
Firefox 1509 check then reached the first compressed block in 4.87 seconds,
painted the first nonblack frame in about 10 seconds, and sustained 47–49
presentations/s on the local host.

Remote session `ms3glqkc-dxomsxlc` loaded the same
`ec527ac4f556593e3550444d4f88f485e361e81b6cbd6a527dd95c144fa326a9`
bundle with timing disabled. Its JavaScript calibration was 172.41 million
iterations/s versus 714.29 million/s locally. The nine initial compressed
blocks took 34.5 seconds after applet entry and the first visible frame arrived
at 43.84 seconds, versus about 10 seconds locally. This approximately 4×
startup and rendering difference tracks the independent JavaScript
calibration; download, server-side inflate, and Canvas upload do not explain
it.

The manual report at 94.56 seconds captured the runnable resource thread in
the original sound-bank chain:

`bi.a()[B` → `bi.b()Lud;` → archive/resource callers.

The innermost active bytecode was the outer signed-byte saturation mixer after
the already optimized `kj.a(II)[I` synthesizer call. The session had completed
17 host inflates but continued creating PCM, while presentation fell to
roughly 0–9 FPS. Native-long Wasm was active for two structurally selected
methods, so this is not the old failure to route the fixed-point synthesizer.

A generic candidate added signed byte loads/stores, virtual-call boundaries,
and reference returns to the scalar resume compiler. It made the exact
138-instruction outer mixer eligible without consulting guest names. The
expanded checked-in audio benchmark produced identical PCM checksum
`-598032378`, but the isolated Node median moved only from 23.58 to 22.42 ms
(4.9%). The exact Firefox candidate was neutral/slightly worse: first nonblack
10.10 versus 9.91 seconds and 847 versus about 860 presentations at 30 seconds.
The runtime path and its unit fixture were therefore reverted. The benchmark
retains the complete outer sound-bank differential and reports the actually
selected entry/resume tiers so this low-value experiment is not repeated.

Whole-application Wasm-first mode was also rejected: its same-JAR Firefox
window measured 14.29 changed images/s, compared with roughly 32 on the
structured default in nearby sampled runs. The live `0.0.0.0:3771` launcher
therefore remains on the proven `ec527ac4…` structured bundle. Reaching 30 FPS
on the remote machine requires reducing the complete procedural PCM
synthesizer/resource-thread cost or moving that work off the browser main
thread; scalarizing only the outer byte mixer and globally preferring Wasm are
both insufficient.

## 2026-07-27: guest-Java PCM push diagnostic

The soundtrack diagnostic originally measured a pure-JavaScript mixer writing
one completed `Float32Array` to WebAudio. That establishes a useful browser
ceiling, but omits the actual game boundary. The checked-in
`benchmarks/JavaPcmPushDiagnostic.java` now generates 16-bit mono PCM inside
guest Java in 512-frame chunks and uses the same
`SourceDataLine.available()`/`write()`/`drain()` sequence as FunOrb. Its hot
fill method is called repeatedly so normal JIT warmup can occur; keeping the
entire synthesis loop in the one-shot `main` method initially produced a
misleading 16.27 seconds of guest generation for two seconds of PCM.

The Firefox runner is:

```bash
FIREFOX_EXECUTABLE_PATH=/path/to/firefox \
JAVA_PCM_SECONDS=2 \
npm run benchmark:pcm-push:firefox
```

The integrated diagnostic is also exposed by
`dekobloko-work/scripts/serve-audio-diagnostics.js`. It compiles the Java class
into an ignored local JAR and records the source, JAR, JVM bundle, and WebAudio
bridge SHA-256 values.

On headless Firefox 146, the first verified integrated run wrote 44,100 frames
(88,200 bytes) through 87 Java `SourceDataLine.write` calls:

- guest Java PCM generation: 91.0 ms;
- `SourceDataLine.write`, including the JVM.js bridge, byte copies, PCM
  conversion, `AudioBuffer` creation, and scheduling: 9.0 ms;
- producer backpressure wait: 1.67 seconds;
- push wall time: 1.81 seconds, followed by a 168 ms drain;
- worst browser event-loop stall: 8.0 ms;
- WebAudio underruns: zero;
- Java/bridge frame counts: both 44,100;
- PCM checksum: `eff06eed`.

This result does **not** support “pushing PCM to WebAudio is the dominant
cost” on the measured host. Once the Java fill loop warms into the JIT, bridge
writes account for about 9 ms across two seconds of audio. It instead provides
a realistic control for remote machines: if the same button reports large
`Java synthesis CPU`, the guest loop/JIT is responsible; large
`SourceDataLine.write` points to copies/conversion/scheduling; underruns with
low CPU point to scheduler or backpressure behavior.

The WebAudio diagnostics now count queue underruns and accumulated gap time.
The instrumentation is evaluated only at each PCM write and does not scan the
buffer a second time. Provenance for the integrated run was JVM bundle
`ec527ac4f556593e3550444d4f88f485e361e81b6cbd6a527dd95c144fa326a9`,
Java source
`bf8db3970b339877cf92c5d6a5f52a063908980ea5ad7b28ad33798897e45124`,
generated JAR
`4ccfe4df55d1af94e021dfe3328cc9f96df1057f92d91209a1779c5d0410740b`,
and WebAudio bridge
`234207c030cdb23bfc735e1e885bf8dab68f58dec21e959b11129a52d173a1bd`.

### Moving logo-animation replay (2026-07-28)

The first focused browser scene page repeatedly invoked one captured renderer
state and retained one surface hash. It was useful as a renderer throughput
control, but it was not an animation benchmark.

The replacement capture waits for two visible changed frames, then captures a
canonical entry to the active logo renderer. `PROBE_TRACE_AFTER_CHANGED_FRAMES`
is a generic profiler gate; it avoids selecting an earlier asset-preparation
invocation. Trace capture also enables existing method profiling while the
target is armed, which makes positional frameless calls materialize canonical
child Frames for `saveState` without changing normal execution. A separate JIT
bug was fixed: an unset target previously compared `null === null` and could
capture the first generated method under a null identity. The focused JIT suite
now asserts that no state serialization occurs until an arbitrary target
identity is configured.

The Dekobloko-side harness does not hardcode the obfuscated progress field. It
counts integer `getstatic` operands in the captured bytecode and requires one
candidate to have at least four reads and twice the next candidate's count.
The initial replacement used `0,25,…,175`; this proved that the scene moved,
but it was still only an eight-phase throughput probe, not the original
animation timeline.

The original guest lifecycle was subsequently audited end to end. It
initializes the progress value to zero, increments it before drawing, renders
1 through 250 at a 20 ms scheduler period, then takes its completion branch at
251. The current diagnostic replays all 250 visible states and requires each
complete loop to produce the same 307,200-pixel hash sequence. It deliberately
excludes the raster array's extra sentinel element.

The first full-timeline version still omitted the outer render path's
per-frame framebuffer clear. Resetting only at a loop boundary left stale
pixels and visible trails, so its hashes are invalid. The corrected harness
finds the unique `()V` guest method that repeatedly reads the recovered raster
field and stores zero without handlers, and executes that clear before every
captured render. This is structural diagnostic selection, not an optimizer
method-name rule.

Node 26.4 rendered two corrected loops at 143.02 states/s with a 6.739 ms
median guest state. Three clean headless Firefox 146.0.1 paced runs measured
34.38, 31.45, and 34.56 states/s (34.38 median). Both runtimes produced loop
hash `1711060353`, combined sequence hash `4093121037`, first hash
`2929241493`, last hash `3053477317`, 225 unique surfaces, and 449/499 changed
transitions. Firefox produced no page or JVM errors. Visual checkpoints at the
reveal, highlight sweep, and completed logo no longer retain fragments from
prior frames. The older 104 FPS Node and 42.61 FPS Firefox numbers are retained
only as phase-jump throughput history and must not be cited as original-logo
playback.

One remote report measured 0.92 FPS, 1,079.9 ms median guest time, and
7,923.696 scheduler slices per state. Its telemetry showed tier `generated`,
mode `tight`, and zero structured/fused/scalar counters: it deliberately
disabled the optimized path. The diagnostic now labels that choice “Slow
control (optimizations off)” and warns prominently when selected.

The measured browser bundle was
`537299a0ff80342f0133e537bf4c082a8ea61b3e66074f066234a4eb892f7dee`;
the method-entry trace was
`5b49fe4d0739167c0db566a8753661610fe357f82fe2e4398b5049582daa0a79`;
the classes JAR was
`b7e6941c374dce4eeb9230690b618935dadda78372977b1888d8f447f167bb16`;
and the source game JAR was
`a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`.
The audited timeline was
`93d87afcc1fd552a9247c8d84298a053a94cc3e89e8fcc896733fe75f0183490`.
The manifests record repository commits, trees, dirty state, tracked-patch
hashes, environment gates, and the explicit JIT configuration.

### Deadline and sampled method profiling

Aggregate mixer CPU was enough to prove the remote failure, but not enough to
optimize it. The diagnostic now records the latency of every 512-frame output
chunk against its 23.22 ms deadline. It reports per-phase maxima, first-32
warmup versus steady averages, deadline misses and longest consecutive miss
streak, and buckets at 5, 10, 15, 20, deadline, 30, and 50 ms. This bookkeeping
uses the `System.nanoTime` reads already surrounding mix, conversion, wait, and
write; the additional comparisons do not retain or scan PCM.

Two generic JVM samplers run only while the selected track is active:

- scheduler ownership samples 1/16 execution slices and therefore observes
  interpreted, generated, and inlined work according to the active guest frame;
- generated-method timing samples 1/128 generated entries and reports inclusive
  estimates, which can overlap when sampled methods are nested.

Neither sampler enables invocation counting, debugger tracing, or guest-name
selection. `?profile=0` disables both while retaining exact chunk measurements;
`schedulerSampleRate` and `jitSampleRate` change their rates. A five-second
progress event makes partial long-track profiles remotely visible before stop.

The first Firefox 146.0.1 profile completed the 195-chunk `Game Lose` track
with two deadline misses. Its first 32 chunks averaged 12.19 ms and its
remaining 163 averaged 7.60 ms. The worst pipeline chunk was 176 ms, almost
entirely a 173 ms mixer event. Scheduler samples attributed the largest
estimated synchronous share to `mi.b([III)V`; generated-entry samples then
identified `mi.c([III)V` and the `ei` sample-mixing bodies beneath it. These
identities are profiler output, not optimizer predicates.

An interleaved off/on/off/on check measured observer cost. Median-like
two-run averages were 5.482 s wall and 1.582 s measured pipeline with sampling
off, versus 5.540 s and 1.596 s on: approximately 1.1% wall overhead and 0.9%
pipeline overhead. Deadline misses remained two in all four runs.

### Full-track Node control does not reproduce the slowdown

`dekobloko-work/scripts/benchmark-guest-mixer-node.js` now runs the same guest
driver, original game JAR, decoded sample bank, and raw track descriptor
directly in Node. It records the Node/V8 versions, relevant `JVM_*` gates,
repository commits and dirty states, input hashes, phase timings, and tier
counters. The Node audio sink is deliberately non-blocking and discards PCM,
so this is a guest-compute throughput control rather than an audio-pacing test.

On 2026-07-27, the complete `Art_Deko_remix_NORMAL` track produced exactly the
same 2,793,984 frames and checksum `0x4756a903` in both environments. With the
same 1/128 generated-method and 1/16 scheduler sampling as the browser:

| measurement | Node 26.4 / V8 14.6 | Firefox 151 telemetry |
|---|---:|---:|
| audio represented | 126.711 s | 126.711 s |
| mixer | 7.206 s | 94.253 s |
| PCM conversion | 1.626 s | 34.874 s |
| output write | 0.182 s | 2.229 s |
| complete measured pipeline | 9.014 s | 131.356 s |
| steady chunk average | 1.627 ms | 23.889 ms |
| 23.22 ms deadline misses | 1 / 5,457 | 2,476 / 5,457 |
| pipeline throughput | 14.06x real time | 0.965x real time |

Thus normal Node did **not** reproduce the failure: Firefox's measured pipeline
was 14.57 times slower. Both profiles named the same generated hot bodies,
starting with `mi.b([III)V`, `ei.b([III)V`, `ol.a([III)V`, and `mi.c([III)V`.
Even `node --jitless`, stopped after 12 seconds, remained 2.75x real time with
an 8.41 ms steady chunk average. This suggests that merely selecting the
JVM.js generated JavaScript tier is insufficient to recreate the observed
failure under V8.

This is not yet a controlled engine-only comparison. Firefox submitted the
telemetry from remote address `100.88.76.3`; Node ran on `kreijstalnuc`, a
13th-generation Intel Core i7-1360P. Hardware, power policy, and browser task
scheduling are therefore still confounders. Run the checked-in Node command on
the Firefox host before concluding that the full 14.57x difference belongs to
SpiderMonkey:

```bash
node scripts/benchmark-guest-mixer-node.js --profile-timings
```

The comparison used java-tools commit
`3ab45904f2061720c11a1f783caa3a39108739f0`, JVM bundle
`fbdc712f7c86c52934cb12dbf32d42072d7c067e5a61bc38e9818b5c1b160c85`,
untouched game JAR
`a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`,
driver JAR
`62510b9a8a75f31eacb45cc55f9fd2bfcec9a8e54cfe58120be7d0c31c9dafde`,
track descriptor
`5e88dc300cdaf63f66219fe266d4484cbd815e4bcd27f5deba528c5bf863ca5b`,
and sample bank
`ebd1e0a0c3fcebfdd380f373c1a158f33a9c6a7fab3e0618994a69ffda07c2f2`.

### Default primitive-array SSA and synchronous class literals

The remote 195-chunk profile then exposed two generic tiering problems:

1. any `ldc SomeClass.class` made an otherwise supported complete caller an
   `async function`, even when the literal target had already been loaded;
2. the verified structured SSA array-loop tier remained disabled unless the
   complete experimental renderer pipeline was requested.

Class literals now use a loaded-only synchronous lookup. A genuinely cold
literal reconstructs the exact PC and operand state and transiently deopts
before loading; the warmed body reuses the canonical `java.lang.Class` object.
Resolving the literal still does not initialize its target. This changes the
diagnostic driver from `generated-async` to `generated-sync` without matching
its class or method name.

The structured renderer now admits verified primitive-array loops by default.
It still rejects unsupported descriptors, CFGs, stack shapes, opcodes, and
exception semantics. The broader acyclic/positional experiment remains behind
the explicit `structuredSsa=true` switch. This narrow policy avoids displacing
the established direct-integer-call tier while covering the `int[]`/`byte[]`
mixer kernels identified by profiling.

Three interleaved full-track Node runs per configuration measured:

| metric | structured off median | default array-loop median | change |
|---|---:|---:|---:|
| wall time | 9.352 s | 5.103 s | -45.4% |
| measured pipeline | 8.696 s | 4.455 s | -48.8% |
| mixer | 6.886 s | 2.648 s | -61.5% |
| steady 512-frame chunk | 1.569 ms | 0.780 ms | -50.3% |

All six runs generated 2,793,984 frames with checksum `0x4756a903` and one
cold deadline miss. The default path entered 143,836 structured regions per
run; the off control entered zero. The exact command accepts
`--structured-ssa default|on|off`, so this result can be repeated without
changing a source tree or environment:

```bash
node scripts/benchmark-guest-mixer-node.js \
  --no-prepare --structured-ssa default
```

This is a Node throughput result, not the Firefox acceptance result. Applying
the Node mixer ratio mechanically to the remote profile would put its ordinary
steady chunks below the 23.22 ms audio deadline, but Firefox must be measured
after rebuilding the production bundle before that can be claimed.

The rebuilt production bundle
`85899abdf7ba008d0c99763546d5e54691722eb93c22fa25dd13f2e124ffadd3`
was then measured in local headless Firefox with three clean interleaved
`structuredSsa=off/default` runs of the 195-chunk `Game Lose` track:

| metric | off median | default median | change |
|---|---:|---:|---:|
| steady chunk | 7.28 ms | 4.79 ms | -34.2% |
| first-32 warmup chunk | 11.94 ms | 13.66 ms | +14.4% |
| deadline misses | 2 / 195 | 2 / 195 | unchanged |
| PCM-conversion aggregate | 382 ms | 429 ms | +12.3% |

The steady-state improvement is repeatable in Firefox, but it does not remove
cold compilation/allocation spikes; maximum chunks remained 166-176 ms off and
237-251 ms by default. The remote Firefox host that reported a 29.36 ms steady
average must rerun the new bundle before its result can be inferred. A purely
proportional 34.2% improvement would be about 19.3 ms and therefore below the
23.22 ms deadline, but that number is a projection rather than telemetry.

Profiling provenance is guest driver source
`9d4986ad061f40a75b157b56ca0169d180fd2ac02e7250c175bf5e4719fa98be`,
driver JAR
`62510b9a8a75f31eacb45cc55f9fd2bfcec9a8e54cfe58120be7d0c31c9dafde`,
untouched `dekobloko.jar`
`a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`,
JVM bundle
`fbdc712f7c86c52934cb12dbf32d42072d7c067e5a61bc38e9818b5c1b160c85`,
sample bank
`ebd1e0a0c3fcebfdd380f373c1a158f33a9c6a7fab3e0618994a69ffda07c2f2`,
and WebAudio bridge
`234207c030cdb23bfc735e1e885bf8dab68f58dec21e959b11129a52d173a1bd`.

### Exclusive Firefox attribution after primitive-array SSA

Inclusive sampling had been repeatedly blaming every wrapper in the same call
chain for the complete elapsed time. A selective exclusive timer now admits
one diagnostic root, clocks only its generated subtree, subtracts nested
generated/frameless/fused calls, and records parent-child edges. Root selection
is diagnostic configuration; neither compilation nor optimization depends on
these method names. Entries outside the selected subtree do not format a
method key or read the clock.

The production bundle
`9ade9b6f565ec92466a23f584eb706044712b0c5b4aec18f616669a5df1a0f8e`
was measured in local headless Firefox 146 with the 195-chunk `Deko Bloko Game
Lose` track. The unprofiled control (`profile=0`) had a 5.09 ms steady chunk
average. Exact timing rooted at `mi.b([III)V` had a 5.25 ms steady average:
about 3.1% observer overhead. Both runs had two deadline misses, no page/JVM
errors, and checksum `0xe5069a58`.

The broad root covered 415 ms after the first audio scheduler yield. Its
dominant paths were:

| generated region | inclusive time | exclusive self time | interpretation |
|---|---:|---:|---|
| `mi.c([III)V` | 275 ms | 21 ms | voice/output traversal |
| `ol.a([III)V` | 244 ms | 14 ms | forwarding layer inside that traversal |
| `ei.b([III)V` | 230 ms | 49 ms | per-voice sample rendering |
| `ei.b([IIIII)I` | 178 ms | 49 ms | inner renderer dispatcher/body |
| `ei.b(II[B[IIIIIIILei;II)I` | 52 ms | 52 ms | structured primitive-array kernel |
| `ei.c(II[B[IIIIIIIILei;II)I` | 46 ms | 46 ms | alternate structured kernel |
| `ia.c()Z` | 90 ms | 38 ms | sequencer/update branch |

The rows are nested and must not be added as independent costs. Separate clean
root passes corroborated the structure: `mi.c` was 256 ms inclusive,
`ei.b([IIIII)I` was 171 ms, `ia.c` was 111 ms, and the two leaf kernels were
61 ms and 44 ms. Their steady chunk averages remained 4.13-4.98 ms, and every
run produced the same checksum with no runtime errors.

The other large hot loop is not below `mi.b`: the guest driver's inline
int-to-PCM16 conversion and checksum loop took 0.36-0.44 seconds over the same
195 chunks, while `SourceDataLine.write` took only about 43 ms in the broad
pass. The broad pass measured 832 ms of whole-track mixing and 438 ms of PCM
conversion. Therefore browser audio output is not the CPU bottleneck on this
host. The remaining steady cost is split between generated guest mixing
(especially the nested `mi.c → ol.a → ei.b` renderer path) and primitive-array
PCM conversion. Cold first-play latency remains separate: maximum pipeline
chunks were 232-255 ms and are dominated by warmup/compilation rather than
steady audio.

The exact diagnostic URL form is:

```text
/audio-diagnostics/?profile=0&exclusiveRoot=<Class.method(descriptor)>
```

Submitted results include exclusive rows and edges, selected tier gates, input
and bundle hashes, repository commit/tree identities, dirty state, tracked
patch hash, and relevant environment variables.

### Embedded primitive-array regions remove Firefox PCM conversion

The exclusive measurements revealed that the diagnostic driver's in-method
`int[]` to interleaved PCM16 `byte[]` conversion was spending roughly
0.36-0.50 seconds per 195 chunks in Firefox. Optimizing the complete driver
method did not reliably reach this loop: the interpreter executes a 1024
bytecode burst, so it can cross the loop header many times before method-entry
tiering observes it.

The JIT now extracts verified bounded primitive-array loops from larger
call-, allocation-, scheduler-, or handler-bearing methods. Selection uses
verifier stack depths, CFG edges, opcodes, constants, and local-slot
relationships, never guest class or method names. A generic structured SSA
region handles the admitted opcode subset. A fully verified saturating
`int[]`-to-two-`byte[]` store plus rolling-hash shape receives a direct scalar
kernel. Both generated callers and interpreter loop-header OSR enter the same
region. Debugging, tracing, invalid arrays, an excessive trip count, and other
failed guards retain canonical execution before optimized side effects.

On Node 26.4 / V8 14.6, the 195-chunk `Deko Bloko Game Lose` control measured
152.808 ms conversion with `--inline-loop-regions off` and 1.976 ms with it
on, a 98.7% reduction. All 195 loops entered the region, 24 through
interpreter OSR. Both runs produced checksum `0xe5069a58`, completed with no
guest error, and wrote 99,840 frames.

Production bundle
`00f28307b1ba39fe56bf958555eb3b4b6a68c0f846084b94e95a9780881f70f5`
was then tested in local headless Firefox 146. An instrumented run proved
195/195 region entries, including 185 interpreter-OSR entries. It measured
12.001 ms total conversion, a 2.70 ms steady chunk average, one cold deadline
miss, no underruns, no page errors, and the expected checksum.

Three clean, interleaved, sampling-disabled Firefox runs per configuration
measured:

| metric | regions off median | regions on median | change |
|---|---:|---:|---:|
| PCM conversion | 456.0 ms | 12.0 ms | -97.4% |
| complete measured pipeline | 1,234.0 ms | 818.0 ms | -33.7% |
| steady 512-frame chunk | 5.02 ms | 2.81 ms | -44.0% |
| deadline misses | 1 / 195 | 1 / 195 | unchanged |

Every A/B run used game JAR
`a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`,
driver JAR
`62510b9a8a75f31eacb45cc55f9fd2bfcec9a8e54cfe58120be7d0c31c9dafde`,
sample bank
`ebd1e0a0c3fcebfdd380f373c1a158f33a9c6a7fab3e0618994a69ffda07c2f2`,
and `Game Lose` descriptor
`1c675bf7eab1d2e0f6e2ab9d987696773c25be2c5cc2f12c18c7560423fdd1f9`.
All six runs had checksum `0xe5069a58`, zero guest errors, and zero page
errors. The optimized runs had zero WebAudio underruns; one of the three
disabled controls reported one underrun.

The remaining one-to-two misses per short run are cold mixer/JIT events:
maximum pipeline chunks remained 230-253 ms while the steady mean was far
below the 23.22 ms deadline. The earlier remote 5,088-chunk result had 669
misses and a 16.20 ms steady mean, but used a bundle where the conversion
region only covered late chunks. That host must rerun bundle
`00f28307...` before attributing its residual misses; the local result cannot
substitute for remote telemetry.

The differential controls are:

```text
/audio-diagnostics/?profile=0&inlineLoops=off
/audio-diagnostics/?profile=0&inlineLoops=on
```

### Real soundtrack through guest Java

The first audio-diagnostics page still routed `Play track` through its
JavaScript mixer; only the separate synthetic control entered Java. This was a
UI/implementation mismatch. It was briefly replaced with a host-rendered WAV
pushed by guest Java, which still omitted the expensive operation under
investigation and was removed.

`Play track through Java` now places the selected raw `ui` descriptor and a
binary decoded `ud` sample bank in the browser JVM virtual filesystem. It runs
`JavaFunOrbTrackPlayer` from a small driver JAR after loading the untouched
`dekobloko.jar`; the driver does not repackage game classes. Guest `ui`
parses the track; original guest `ia`, `mi`, and `ei` synthesize every
512-frame chunk; guest Java performs saturation and PCM16LE conversion, checks
`SourceDataLine.available()`, and writes each chunk through the JVM.js WebAudio
bridge. There is no host-rendered WAV and the integrated page no longer exposes
the two-second synthetic control.

Sample decompression is deliberately outside this measurement: `bi`/`va`
samples are decoded once while preparing the bank. Object construction,
sequencing, voice mixing, PCM conversion, pacing, and output are all guest Java.
This separates steady music mixing from the already measured archive/sample
unpacking startup problem.

Browser `FileInputStream` previously tried webpack's disabled Node `fs`
fallback and failed with `readFileSync is not a function`. It now reads the
active browser `FileProvider`, retaining Node filesystem fallback and signed
Java-byte semantics. Reflective instance fields now use the normal
owner-qualified JVM slot and `Field.setBoolean` is implemented; those changes
are required to recover private `ui.y` sample IDs and disable `ia` looping
without naming methods in the optimizer.

A Firefox 146.0.1 stop-after-3.5-seconds check on
`Deko Bloko Titlescreen` reported:

- guest sample-bank construction: 400 ms;
- guest track parse/hydration: 160 ms;
- original guest `mi.b` mixer CPU: 853 ms;
- guest PCM saturation/conversion: 375 ms;
- 162 guest Java `SourceDataLine.write` calls: 35 ms;
- backpressure wait: 2.48 seconds;
- 82,944 Java/bridge frames (3.76 seconds), with equal counts;
- zero underruns and zero queued-gap time;
- worst event-loop stall: 288 ms;
- non-silent sampled PCM with peak amplitude 0.782959;
- no browser or JVM errors.

This is the first integrated measurement that actually charges the recovered
guest music mixer. On this run mixer plus PCM conversion consumed 1.228 seconds
for 3.76 seconds of audio, or 3.06x real time. The output bridge itself remained
small at 35 ms; the meaningful guest costs are mixer execution, conversion,
and first-play object/class preparation.

Current provenance is guest-mixer source
`ffdeec82e5ac272045b0524141333f0b852d7d1437d61aa0c4fc0a31f079e2a7`,
decoded sample bank
`ebd1e0a0c3fcebfdd380f373c1a158f33a9c6a7fab3e0618994a69ffda07c2f2`,
untouched `dekobloko.jar`
`a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`,
generated driver JAR
`30b9dc891b93cb9f725fa9450fbd05342a5f3d648044ef2695293a5b774e180b`,
JVM bundle
`0845384d96705a0a8018fa8ae3fcff44c63c792d52170ede7376790320b02a66`,
and WebAudio bridge
`234207c030cdb23bfc735e1e885bf8dab68f58dec21e959b11129a52d173a1bd`.

## 2026-07-28: epoch-cached generated-region guards

> Correction: the measurements in this section used the eight-phase
> `0,25,…,175` moving-renderer probe. They establish the guard-cache A/B result
> for that synthetic workload, but they are not measurements of the original
> Jagex-logo timeline. The audited 1…250 timeline and superseding playback
> measurements are documented in “Moving logo-animation replay” above.

The moving 640×480 guest animation initially measured 42.61 FPS median in
three clean headless Firefox 146 runs. A low-overhead Gecko profile showed
`FusedRegionCompiler.guard` as a direct leaf in 129 of 4,000 one-millisecond
samples. The animation entered verified fused regions about 98,951 times over
30 frames, so each entry was repeating class-map and bytecode-identity walks
whose answers could not change without a JVM class lifecycle event.

Fused regions now cache only the stable portion of a successful guard against
`classEpoch` and `classInitializationEpoch`. Exact wrapper identity, live
mode/feature statics, thread/call-stack ownership, debugger and breakpoint
state, and tracing state remain checked at every entry before side effects.
Advancing either lifecycle epoch repeats initialization and dependency
identity verification. The structured SSA renderer applies the same rule to
its generated class-initialization sets, including direct and
exception-restoring positional bodies. Selection and caching use resolved
owners, identities, and epochs; there is no guest method-name table.

The focused JIT suite passes 722/722 assertions, including unchanged-epoch
reuse, class-epoch bytecode invalidation, initialization-epoch invalidation,
debugger fallback, operand preservation, and pre-side-effect fallback. The
production bundle built successfully with its four existing size/dynamic
dependency warnings.

Bundle
`537299a0ff80342f0133e537bf4c082a8ea61b3e66074f066234a4eb892f7dee`
produced these clean Firefox 146.0.1 results:

| run | displayed FPS | guest median | guest + upload median | hash total |
|---|---:|---:|---:|---:|
| 1 | 48.62 | 15 ms | 17 ms | 56 ms |
| 2 | 48.39 | 15 ms | 17 ms | 53 ms |
| 3 | 41.21 | 16 ms | 19 ms | 56 ms |

On that phase-jump probe, the 48.39 median is 13.6% above the earlier 42.61
median. The guest body
fits a 60 FPS budget at its 15–16 ms median, but upload plus the diagnostic-only
full 307,200-pixel hash keeps the displayed loop below 60. All three runs had
29/29 changed transitions, temporal sequence hash `1456157722`, and no page or
JVM errors. Node 26.4 measured 126.30, 126.72, and 142.96 FPS (126.72 median)
with 40/40 distinct full surfaces, versus the earlier 104.00 FPS result. These
numbers must not be reused as original-logo playback rates.

The post-change Gecko window contained 3,998 samples and only 16 inclusive
`guard` samples. The next largest optimizer-controlled self-time is the large
structured geometry body. Its generated JavaScript declares roughly 170 JVM
locals and retains long cross-block local/join-slot copy chains. The next
generic experiment should simplify SSA copies and phis, or split a verified
region at safe boundaries; method-name-selected kernels are neither necessary
nor justified by this profile.

## 2026-07-29: archive, BZip2, kerning, and initialization-site audit

This pass targeted bytecode and data-flow shapes only. No optimizer decision
uses the guest names `eh`, `kh`, `ad`, `td`, or `mm`; those identities appear
only in the diagnostic probe that reports which real game bodies exercised a
generic rule.

The three archive/reader bodies are not ordinary reducible scalar loops:

- the 430-item reader/archive body has 15 retreating edges and an irreducible
  CFG;
- the 451-item cache reader has two retreating edges but fails structured
  operand-stack verification;
- the 758-item archive unpacker has 16 retreating edges and a verified
  `dup_x2` form that the structured renderer cannot yet represent.

All three also carry a boolean static across guest calls. Partial Wasm must
continue rejecting that shape until every exit has a verifier-backed spill:
losing the boolean local can change arbitrary control flow. A measured
experiment that merely exposed the real backedges to the existing large
switch-based JavaScript compiler increased Firefox first-paint time to
35.477 seconds, so it was reverted. This is important negative evidence:
making an existing tier accept more methods is not automatically an
optimization.

The retained generic changes are:

- resolved instance fields in baseline generated bodies use their verified
  owner-qualified object slot directly, with the generic resolver as fallback;
- resolved static fields use direct map/object targets guarded by stable
  class-initialization tokens;
- interpreted `getstatic`, bytecode static calls, generated static calls, and
  generated static fields reuse the same stable tokens instead of repeating a
  `classInitializationState.get` at every hot site;
- direct mutations and state restore refresh those tokens, preserving debugger
  and snapshot semantics;
- call-bearing structured SSA methods can cache non-volatile field reads, but
  every guest call or field write invalidates the cache;
- array-field values snapshot their raw storage companion, so invalidating or
  rebinding a field cache cannot retarget an older live SSA array reference.

The real BZip2 body compiles all 139/139 Wasm blocks and completed one measured
run with zero exits. Its structured-JavaScript fallback now has 21 verified
field caches and 37 direct sentinel-checked array loads. The real font-kerning
body compiled 45/55 Wasm blocks, completed three measured runs with zero exits,
and its structured fallback has two field caches. These are structural
results, not guest-identity special cases.

An opt-in dense-array policy was also added for experimentation. It requires a
substantial method, at least 24 primitive-array operations, a real backedge,
only statically linkable calls, and no dynamic calls. Enabling it by default
moved Wasm compilation earlier but worsened the clean three-run Firefox
first-paint median from 16.405 to 17.481 seconds. It remains disabled by
default (`JVM_ENABLE_ARRAY_KERNEL_WASM_FIRST=1`) rather than shipping that
regression.

The final pre-load-spike interleaved control pair painted in 19.144 seconds for
the old bundle and 18.563 seconds for the retained optimized build; the
corresponding archive windows were 7.168 and 6.798 seconds. This is only a
modest paired improvement and is not enough evidence for a broad speedup
claim. Later three-run measurements became invalid for comparison because
unrelated QEMU and Wine processes saturated the host: the optimized runs were
20.247, 32.491, and 46.799 seconds, while a contemporaneous old-bundle control
took 57.266 seconds. All recorded runs had zero page/runtime errors.

The focused JIT suite passes 958/958 assertions. It checks structural
dense-array selection and rejection, static-token invalidation, 100 warm
interpreted static reads with one initial map lookup, 100 generated static
reads with no repeated lookup, and array-field cache invalidation across guest
effects. Scheduler/JIT edge tests pass 127/127, and the production build
completes with only the existing four webpack size/dynamic-dependency warnings.

Reproducibility:

- java-tools commit before the dirty working changes:
  `b70840200e76c9a135ac3df4b8c05c215b220266`;
- final bundle SHA-256:
  `8d1baab37604a7ea572e99cac1f0d387583366adfb453236cfb433b9bf821432`;
- untouched `dekobloko.jar` SHA-256:
  `a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`;
- Node `v26.4.0`, npm `12.0.1`, Firefox Playwright build 1509;
- browser query gate `schedulerRate=256`, default structured optimizer,
  default Wasm JIT, dense-array Wasm-first disabled;
- the java-tools tree was dirty with pre-existing audio, renderer, IDE, and
  documentation work as well as this pass.

## 2026-07-29: missing title instruments were a launcher override

The title-screen music defect was not caused by WebAudio, stereo conversion,
asset corruption, or the guest Vorbis implementation. The game launcher had
registered an application-specific JRE override for the guest method with
descriptor `(I)[F`; that override returned `null` for every packet. The normal
guest caller treats `null` as “no overlap samples for this packet”, so it
continued through the archive and constructed correctly sized, entirely
zero-filled PCM buffers. This also explains why the isolated audio diagnostic,
which did not install the launcher override, always sounded correct.

The launcher override was removed. No guest class or method identity was added
to the JIT, and a speculative structural JIT bailout was discarded after the
override was found.

The instrumented Firefox game then matched the standalone decoder exactly for
the three title samples that had been silent:

| decoded length | nonzero samples | FNV checksum |
|---:|---:|---:|
| 10,654 | 10,291 | 3,217,290,969 |
| 13,203 | 12,098 | 2,371,258,599 |
| 161,752 | 115,114 | 1,724,468,494 |

The first large live decode likewise changed from 0 nonzero bytes to 302,827
nonzero bytes out of 400,787. The title-mix report recorded no silent voices,
and every observed voice backed by those samples changed its destination
buffer.

Validation used Firefox Playwright build 1509, production JVM bundle SHA-256
`f32a24990fec7b742e3e9ed3dcda204efa361b4d485cec76a5676a3ea6379b82`,
untouched game JAR SHA-256
`a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`,
and trace JAR SHA-256
`67d907f87a071db647981a3cfe39c090ad334754394403c27bf1b759dcd3614f`.
The focused JIT suite passed 963/963 assertions and the production bundle
built successfully with the four existing size/dynamic-dependency warnings.

## 2026-07-29: short sound effects and AudioWorklet startup buffering

After restoring the music decoder, music was audible but the separate
sound-effect output was not. Browser telemetry showed that this was downstream
of the guest mixer: the 8 KiB `SourceDataLine` repeatedly supplied nonzero PCM
with peaks up to roughly 0.5, while the 64 KiB music line played normally.

The AudioWorklet used the same 80 ms startup cushion for both outputs. At
22,050 Hz that is 1,764 frames, but the effect line naturally publishes
512-frame regions and many observed short outputs contained only 1,024–1,536
frames. Their PCM reached the worklet queue but could be replaced or closed
before the processor ever started.

Worklet startup now retains the 80 ms ceiling for continuous streams while
limiting the threshold to the output's first natural coalesced region. The
music line therefore remains at 1,764 frames and the effect line starts at 512
frames. This is derived from negotiated format and buffer sizes; it contains
no game, class, method, or track identity.

The focused WebAudio test passes 34/34 assertions. Its fake worklet verifies
that one 512-frame region both meets the effect-line threshold and is posted to
the processor. A clean Firefox probe of the deployed game reported a running
audio context and these live contracts:

| line buffer | coalesced region | startup threshold |
|---:|---:|---:|
| 65,536 bytes | 2,048 frames | 1,764 frames |
| 8,192 bytes | 512 frames | 512 frames |

The deployed production bundle SHA-256 is
`2fa7b65f454986bbdbd7849260b661817f67a35b30185bd0213c6493be1c8145`.

## 2026-07-30: generic SSA regions replace production guest-kernel fingerprints

Complete raster, polygon, affine, sampler, and fused wrapper translations are
no longer production optimizer tiers. They remain available only as explicit
differential oracles through `guestKernelOracles: true` or
`JVM_ENABLE_GUEST_KERNEL_ORACLES=1`. `rendererPipeline` now enables the generic
scalar and structured-SSA tiers but does not implicitly enable fused regions.
The default compiler therefore does not select a translation from a guest
class name, method name, complete descriptor family, or whole-algorithm opcode
fingerprint.

The retained generic work is derived from verified bytecode and its normal
CFG:

- disconnected exception-reporting handlers do not affect normal-region
  eligibility;
- primitive-array parameters, structured loops, and static calls can use the
  restoring positional ABI;
- the normal path receives scalar operands and creates no child `Frame`;
- safe points and throwing operations lazily materialize the exact bytecode
  PC, locals, and operand stack;
- nested omitted frames are inserted at their recorded entry depth, restoring
  outer-to-inner JVM order;
- `JVM_TRACE_STRUCTURED_POSITIONAL=<substring>` reports a method's generic
  positional decision and rejected opcode without changing selection.

The focused JIT test builds an arbitrarily named Java array loop containing a
separate arithmetic helper. It verifies results derived from the helper's
actual bytecode, absence of a child frame on the warmed normal path, and exact
method/PC/locals restoration for a bounds exception on a later iteration. The
complete focused command passed 996/996 assertions:

```sh
timeout 90s node node_modules/tape/bin/tape test/jitCompiler.test.js
```

Node logo measurements used Node `v26.4.0`, java-tools base commit
`aaa2c1efdcb01c1b4e59ad638e6730ebb7a78b14`, dirty patches saved in each
artifact directory, untouched `dekobloko.jar` SHA-256
`a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`,
and generated-class-tree SHA-256
`b2e7bce0e174a31bb0a0984f6bde2e2312e2ed5c009b058e29c4145c3cfce411`.
The gate set was `JVM_ENABLE_RENDERER_PIPELINE=1`, structured Wasm enabled,
fused regions disabled, fake real-time clock enabled, sample stride 10, and a
36-image window.

| retained default stage | full-logo FPS | warm-logo FPS | runtime errors |
|---|---:|---:|---:|
| generic SSA before broad oracle-probe removal | 1.628 | n/a | 0 |
| oracle probing gated off | 4.218 | 6.835 | 0 |
| restoring positional array loops | 5.205 | 7.294 | 0 |
| normal-CFG reachability | 5.445 | 7.616 | 0 |

The explicit historical fused-region control reached 36.225 full-logo FPS and
48.320 warm-logo FPS. That number remains useful as a code-shape ceiling, but
it is not a production result because the large renderer-family recognizer is
disabled by default.

Two generic dispatch experiments were measured and removed. Eager side-effect-
free static linkage produced long synchronous compilation/atomic chains and
fell to 4.352 FPS. Feeding verifier-produced scalar callees directly from the
ordinary generated-sync stack machine was semantically stable after narrowing
but fell to 1.997 FPS. Neither negative path is present in the final bundle.

The production bundle built successfully with the existing four webpack
warnings. Its SHA-256 is
`0bee53516e2dd7b62a8090097b98f357da17c2cead4ffb933cb8e2bd2e384eff`.
These changes improve the generic baseline substantially, but they do not meet
the 20 FPS acceptance target; no Firefox FPS claim is made for this pass.

## 2026-07-30: bytecode-derived fused regions reach the handwritten target

The conclusion immediately above is superseded for the moving-logo renderer
family. Fused regions are now a production compiler tier and are enabled by
default, with `fusedRegions: false` or
`JVM_DISABLE_FUSED_REGIONS=1` retaining the differential control. The compiler
does not contain Deko Bloko class or method names. It discovers a region by
following verified calls from a wrapper into a raster and then into a
primitive-array store loop. Descriptors, CFG reachability, JVM stack depths,
callee multiplicity, initialized-class state, and bytecode identities are
guards; a complete guest algorithm or name-based substitution is not.

The generated normal path passes scalar operands positionally, emits lexical
JavaScript loops, and does not create child `Frame` objects or use generic
invoke dispatch. Class initialization, debugger state, tracing, and scheduler
state are checked before any fused side effect. A throwing operation records
its exact bytecode PC and operands, and lazily restores omitted callee frames
in JVM order before rethrowing through the normal dispatcher.

The focused compiler and hot-loop proxy command passed 1060/1060 assertions:

```sh
timeout 90s node node_modules/tape/bin/tape \
  test/jitCompiler.test.js test/fusedHotLoopRegression.test.js
```

The generic raster microbenchmark was bit exact with its handwritten
differential oracle and was within 3.2% of it:

| implementation | ns/pixel | destination checksum | source checksum |
|---|---:|---:|---:|
| generic SSA | 4.275 | 1,530,407,741 | 838,806,109 |
| handwritten oracle | 4.142 | 1,530,407,741 | 838,806,109 |

The exact 250-state Jagex-logo timeline then ran at 80.70 FPS in Node with a
9.91 ms median guest-render time. It produced 225 unique surfaces and all
expected hashes:

| property | value |
|---|---:|
| changed transitions | 224 / 249 |
| sequence hash | 1,711,060,353 |
| first surface hash | 2,929,241,493 |
| last surface hash | 3,053,477,317 |
| fused direct runs | 653,604 |

This run used Node `v26.4.0`, Deko Bloko JAR SHA-256
`a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`,
generated class tree SHA-256
`b2e7bce0e174a31bb0a0984f6bde2e2312e2ed5c009b058e29c4145c3cfce411`,
java-tools base revision
`aaa2c1efdcb01c1b4e59ad638e6730ebb7a78b14`, and dirty tracked trees in
both repositories. The benchmark explicitly records
`warmupThreshold: 0`, `preferWholeMethodJs: true`,
`rendererPipeline: true`, `fusedRegions: true`,
`DEKOBLOKO_ANIMATION_LOOPS=1`, and
`DEKOBLOKO_ANIMATION_WARMUPS=1`.

This is a renderer-family breakthrough, not yet a whole-game performance
claim. A full original-JAR, simple-mode Node launch to the main menu measured
only 1.36 presented FPS and 1.41 dirty frames/s over its fixed window, despite
502,496 direct fused entries. A previous run of the same route after the
effectful-field positional change measured 1.61 FPS, versus 1.12 FPS before
that change; the remaining menu path is both slow and variable. Firefox
diagnostic session `ms71gh94-hrzxtbjn`, using the older runtime SHA-256
`f1c1ccdcc2a35f1c64783889f642f8b6fb03c90dde2271d23039a509a3fd8c2c`,
reported 3.0 FPS and attributed sampled synchronous time primarily to a small
sprite/text wrapper-caller chain and its alpha-blending raster. Canvas upload
was not the dominant cost.

A gated, name-independent experiment also admitted one-slot reference
parameters, reference comparisons/casts, and static stores to the restoring
positional ABI. It selected the repeated sprite wrapper and passed 1069/1069
focused assertions, but the full menu reached only 1.62 FPS. That is within
the preceding variance and is not a meaningful step toward 30 FPS, so the
broadened runtime path was removed.

The rebuilt live bundle on port 3771 has SHA-256
`117761466883a0096382a2797262cf2e8846d29f862521b8c35ba0ee0c302ab8`.
No Firefox acceptance result is claimed for it yet; a new report must identify
that exact runtime before its FPS is comparable.

## 2026-07-30: SSA reaches the handwritten raster target

The clipped-span and moving-raster proxies now compare the generated SSA body
with the handwritten structural oracle through the same nested, positional
calling convention used by an SSA caller. No guest class name, method name, or
descriptor is used for selection.

Two generic changes closed the remaining generated-code gap:

- A runtime-bounded counted loop is versioned into a branch-free fast loop and
  a slow loop that retains the scheduler poll and exact frame restoration.
  Selection uses the verified trip count, positive induction step, overflow
  proof, and a 1,024-iteration ceiling.
- A positional child entered synchronously from an already-guarded SSA caller
  receives a trusted-entry bit. The child omits only the redundant
  debugger/profile/thread-state checks. Its class-initialization epoch guard,
  live static reads, bounds/null behavior, scheduler slow arm, and exact
  exception-frame reconstruction remain active. A standalone entry does not
  receive that bit and retains the complete guard.

The ABBA benchmark harness itself had one important measurement bug: it called
both implementations through a shared `target.invoke()` site. V8 repeatedly
deoptimized that harness site for a wrong call target/map. The checked-in
benchmarks now alternate batches while using separate monomorphic inner call
sites. This changes measurement only, not generated runtime code.

Five fresh-process span runs with the corrected harness measured a
trusted-entry median ratio of **1.0081** versus the handwritten oracle. The
same generated body with `SSA_TRUSTED_NESTED=0` measured **1.1313**, directly
attributing the remaining entry overhead. Seven earlier fresh trusted runs
gave a median ratio of **1.0026**. Every run produced the same destination
checksum. The complete moving raster was already on the favorable side of
parity: five fresh processes measured a median ratio of **0.9645** (generated
SSA faster), again with exact source and destination checksums.

The reproducible commands were:

```sh
SSA_SPAN_ROUNDS=13 SSA_SPAN_WARMUPS=8 \
SSA_SPAN_ITERATIONS=250000 SSA_TRUSTED_NESTED=1 \
node scripts/benchmarkSsaSpanKernel.js

SSA_RASTER_ROUNDS=9 SSA_RASTER_WARMUPS=5 \
SSA_RASTER_ITERATIONS=30000 \
node scripts/benchmarkSsaRasterKernels.js

timeout 90s node node_modules/tape/bin/tape \
  test/jitCompiler.test.js test/fusedHotLoopRegression.test.js
```

The focused correctness suite passed **1,083/1,083** assertions, including
class-initialization fallback-before-effects, debugger fallback, null/bounds
exceptions, nested omitted-frame restoration, direct scalar calls, and the
generic fused hot-loop proxy.

The browser report submitted immediately before this change was session
`ms71gh94-hrzxtbjn`. It used Firefox 153 and runtime SHA-256
`f1c1ccdcc2a35f1c64783889f642f8b6fb03c90dde2271d23039a509a3fd8c2c`,
not the later bundle. It reached the game and reported 2.8–3.0 presented FPS.
Between 142 and 537 seconds it executed roughly 95.2 million structured-SSA
entries and 16.0 million ordinary frameless entries while presenting almost
no frames. Sampled synchronous ownership was concentrated in a four-call
drawing wrapper, the main panel renderer, and sprite/raster children. Canvas
upload was not the reported bottleneck. This makes intermethod scalar entry
cost and fatter generic regions the next whole-game target even though the
isolated raster kernels themselves have now reached parity.

Measurements used Node `v26.4.0`, java-tools base revision
`aaa2c1efdcb01c1b4e59ad638e6730ebb7a78b14`, and a dirty tree (55 porcelain
entries, including pre-existing work). Failed experiments were removed:
canonicalizing the lexical loop into a source-level `while (i < bound)` was
slower, eliding the sole-loop budget bookkeeping was not a repeatable win,
load-range loop versioning regressed, and disabling exact run counters was
neutral. The retained runtime fast paths are therefore the two positively
attributed structural changes above.

The production webpack build completed with its existing four warnings. The
bundle copied to the live port-3771 game library has SHA-256
`df7faab661dc9729e03a7c642bbef7795a53d32a0c022adcb0900401295aaca1`.

## 2026-07-30: optimize the guest body around the finished raster kernels

The latest submitted Firefox report confirms that the isolated raster result
above was not the whole-game bottleneck. Session `ms71gh94-hrzxtbjn` reported
about 3 FPS while the page remained visible and focused. Surface upload
accumulated only about 1.47 seconds over roughly ten minutes. During the same
interval, structured SSA entered about 115 million times. Sampled scheduler
ownership remained in the guest model/panel/render call tree. This is a
guest-execution and intermethod-bound workload, not a canvas-upload limit.

Three bytecode-generic changes were retained:

- Structured JavaScript emits primitive array stores directly. It performs
  the exact JVM narrowing for byte/boolean, char, short, int, float, and long
  values in the generated expression instead of calling
  `normalizeArrayStore` for every pixel/sample. The differential switch is
  `JVM_DISABLE_STRUCTURED_INLINE_ARRAY_STORES=1`.
- Wasm uses opcode-specific array-store imports. The Wasm boundary has already
  coerced int, long, float, and double values to their JVM widths, so those
  imports store the value directly; byte/boolean, char, and short retain their
  required narrowing. The differential switch is
  `JVM_DISABLE_WASM_TYPED_ARRAY_STORES=1`.
- A large loop with dense primitive-array traffic and multiple dynamic call
  islands selects structured JavaScript on its first entry instead of
  beginning as a partial Wasm method and promoting after the one-shot work is
  already underway. Selection requires at least 512 verified instructions, 32
  primitive-array operations, two dynamic invokes, and a CFG backedge. It does
  not inspect a class name, method name, or guest descriptor. The differential
  switch is `JVM_DISABLE_DYNAMIC_ARRAY_STRUCTURED_FIRST=1`.

The Wasm-store result was directly attributed with a CPU profile:
`normalizeArrayStore` fell from about 604 ms of self time to 4 ms. Three
fresh-process, CPU-0-pinned, fusion-disabled Node runs measured:

| typed Wasm stores | median full-logo FPS | median warm-logo FPS |
|---|---:|---:|
| enabled | 19.557 | 31.976 |
| disabled | 16.621 | 27.803 |

That is a **17.7% full-logo** and **15.0% warm-logo** improvement. The
artifacts are
`/tmp/dekobloko-node-logo-benchmark.{VZVDOz,IBZcTa,kcCeLe}` and
`/tmp/dekobloko-node-logo-benchmark.{pQMU5M,Ucn51Q,C3IF87}`.
Inlining the structured-JavaScript stores separately measured a smaller
positive median of 16.61 versus 15.78 full-logo FPS, and 26.95 versus 26.18
warm-logo FPS.

The first-entry policy was measured in three enabled and three disabled runs
with identical tracked source, generated classes, and `fusedRuns: 0`:

| structured first for dynamic array loops | median full-logo FPS | median warm-logo FPS |
|---|---:|---:|
| enabled | 23.382 | 36.302 |
| disabled | 20.347 | 30.572 |

This is a **14.9% full-logo** and **18.7% warm-logo** median improvement.
Individual runs were noisy (one of three pairs reversed), so the exact
throughput is not a browser prediction. The complete artifacts are
`/tmp/dekobloko-node-logo-benchmark.{Kgon48,xXcKy1,XkmSmi}` and
`/tmp/dekobloko-node-logo-benchmark.{YHsNlG,1QBAZP,fEY97i}`. All six runs
completed with matching expected phase hashes, no runtime errors, and no fused
or handwritten execution.

The filtered logo-interval CPU profile also corrected an attribution mistake.
An outer continuation/dispatcher appeared expensive in the unfiltered profile,
but its samples included V8-inlined guest work. Embedding the resume closure
inside the structured function reduced the benchmark from 25.68/40.26 to
19.75/32.42 full/warm FPS and was removed completely. The retained changes are
therefore the array-store and first-entry improvements above, not a speculative
dispatcher rewrite.

The focused compiler command now passes **1,078/1,078** assertions, including
typed-store narrowing/null/bounds semantics and the no-name hot-loop policy:

```sh
timeout 90s node node_modules/tape/bin/tape test/jitCompiler.test.js
```

Benchmark metadata now records all three resolved gates and the number of
methods selected by the first-entry policy. The measurements used Node
`v26.4.0`, java-tools base revision
`aaa2c1efdcb01c1b4e59ad638e6730ebb7a78b14`, dirty tracked trees with patches
captured in every artifact, untouched `dekobloko.jar` SHA-256
`a22410ad930334f54672ce8acdf25d88c31e380550e8f88a5618bb730f3cf06e`,
and generated-class-tree SHA-256
`b2e7bce0e174a31bb0a0984f6bde2e2312e2ed5c009b058e29c4145c3cfce411`.
No new Firefox acceptance claim is made until the rebuilt bundle is measured.

The first post-change kernel check caught one emitter-level regression before
deployment: spelling an integer store as `Number(value) | 0` made V8's complete
raster about 1.69 times slower than the oracle. JVM SSA had already proven the
operand numeric, so the redundant `Number` conversion was removed. The
long-form rerun restored the bit-exact complete raster to **0.9835 times** the
oracle (generated faster). The tiny clipped-span proxy is more sensitive to
fixed entry bookkeeping. Splitting restoring-positional entries into their own
counter avoids two property writes per child call while retaining the exact
reported total; it measured about **1.06 times** the oracle. A subsequent
fusion-disabled whole-logo run remained clean at 22.08 full and 34.64 warm
FPS (`/tmp/dekobloko-node-logo-benchmark.Zbdl3k`).

The validated production bundle was then copied byte-for-byte to the live
port-3771 game library. Both the webpack output and the served response have
SHA-256
`7e06f3a1a325642364840b704b92010404d951e6f0316e923eceeb186f4d3f95`
(1,958,729 bytes). Webpack completed with its four existing warnings and the
post-build browser configuration test passed 7/7. This deployment still has
no Firefox FPS claim; the next submitted report must identify this exact
runtime hash.

### Range-versioned SSA beats the handwritten kernels

The next isolated check found that the range proof was present but its result
was still tested at every array store. The restoring SSA renderer now versions
runtime-bounded direct loops on every affine array-range guard that dominates
the loop. In the fast version, the compiler removes the impossible
materialization/bounds arm and emits only the proven array store. The slow
version is retained unchanged, including partial stores before a failing
iteration, the exact throwing bytecode PC, locals, operand stack, and restored
frame order. This is derived from counted-loop induction variables, CFG loop
membership, array base locals, and runtime array length; it uses no guest or
method identity.

Nine paired rounds measured the generated clipped span at **0.6922 times** the
handwritten target (41.60 versus 60.08 ns/invocation, generated about 44%
faster). The complete moving raster remained bit-exact and at
**0.9890 times** its handwritten target. Disabling only the new versioning
with `JVM_DISABLE_STRUCTURED_VERSIONED_ARRAY_STORES=1` returned the span to
**1.0903 times** the handwritten target, directly attributing the gain.

The last ordinary method-name exception was also removed from the large
dynamic-array tier policy. A test deliberately names the arbitrary structural
fixture `run`; selection still depends only on instruction count,
primitive-array density, dynamic-call islands, and a CFG backedge. Three
fusion-disabled full-logo runs are effectively neutral for that policy:
29.895/43.620 full/warm median enabled versus 29.766/43.313 disabled. It is
therefore not credited for the kernel breakthrough.

The same audit removed two older `run` exclusions from the broad codegen and
safe-control-flow capability checks. An ordinary member called `run` is now
judged by its bytecodes and CFG like any other method. JVM-defined
`<init>/<clinit>` semantics and standard-library parking operations remain
special because they have defined VM/scheduler behavior, not because of a
guest workload. A fusion-disabled post-audit logo run completed without errors
at 28.55 full and 41.97 warm FPS
(`/tmp/dekobloko-node-logo-benchmark.z2GBWZ`).

The focused suite now passes **1,080/1,080** assertions. Its generic span test
also proves that the range-success arm contains no materialization call and
that the slow arm still throws and restores the exact failing JVM state.

The rebuilt production bundle and the bytes served by port 3771 both have
SHA-256
`b13361fb26a35fe61605b8b3e046b71a46a3432b89d4c9f6647002e92797f897`
(1,959,505 bytes). This supersedes the earlier `1e038468…` runtime.
## 2026-07-30: generic SSA replaces more of the affine sprite oracle

The remaining fingerprint-selected guest-kernel inventory was checked against
both DekoBloko layouts. The 343 original classes contain one matching
substitution, the affine sprite raster; the current 343 recompiled classes
contain no accepted handwritten fingerprint. A logo run with
`JVM_ENABLE_GUEST_KERNEL_ORACLES=1` also executed zero perspective-span,
tiled-blit, affine-raster, polygon-raster, or bilinear-sampler substitutions.
This confirms that these files are differential/profiling oracles rather than
the normal runtime path.

A follow-up scan loaded every class from the 44 current original FunOrb game
directories. Its only accepted perspective/tiled/affine/bilinear/polygon
fingerprint was the same DekoBloko affine method. The other four substitutions
therefore have no current workload to optimize against and remain historical
oracles. The inventory also found that arbitrary `(IIIII)V` candidates can
contain `long` constants; canonical fingerprinting now represents `BigInt`
constants explicitly instead of allowing an opt-in oracle scan to throw during
`JSON.stringify`.

The original affine method exposed a generic compiler failure: two pure
integer calls in the outer row loop globally disabled scheduler coarsening,
leaving a poll at every pixel. `JvmSsaBlockRenderer` now computes unsafe
operations per natural loop. A call-free inner loop receives a branch-free
runtime-coarsened arm while its helper-containing outer loop retains the exact
safe point. The restoring positional quantum is 100 times the frame-owned
structural budget (bounded to one million) so ordinary raster children finish
between caller safe points instead of reconstructing their frame every few
rows.

Two related generic changes reduce intermethod and field overhead:

- `WasmJit` write summaries now walk verifier-reachable normal flow. Calls
  reachable only from an exception handler do not invalidate every caller
  field cache.
- Stable reference parameters may eagerly bind repeated primitive fields and
  raw array views when transitive write keys prove them unchanged.
- A verifier-supported `putstatic` is allowed in restoring scalar integer
  helpers. Reporter-guarded divide/clamp helpers therefore use the direct
  positional body while preserving precise exception frames.
- A primitive store whose index is a loop-local affine recurrence with a
  stable static stride receives one pre-loop range guard. The slow arm retains
  the original per-store bounds exception and materialization.

Focused validation:

```text
timeout 90s node node_modules/tape/bin/tape test/jitCompiler.test.js
# 1088/1088 passed

node node_modules/tape/bin/tape \
  test/schedulerPerformance.test.js test/browserBundleConfig.test.js
# 48/48 passed
```

The final provenance-recording A/B benchmark produced identical checksums.
Absolute host load changed substantially between repeats, so the paired ratio
within one ABBA process is the authoritative result:

| Path | ns/invocation | Relative to oracle |
| --- | ---: | ---: |
| Generic SSA | 88,003 | 2.201× |
| Handwritten oracle | 39,983 | 1.000× |

An earlier intermediate run, before eager entry fields and restoring scalar
helpers, measured 5.877×. Thus these generic changes remove 62.5% of the
relative overhead. The current recompiled method is also bit exact and
measured 1.990× its oracle in the same paired harness. The remaining gap is
computed source/mask array bounds proof across multiply/divide expressions;
it should be addressed with interval analysis rather than a method
fingerprint.

The recorded original-class artifact identifies Java-tools base commit
`aaa2c1efdcb01c1b4e59ad638e6730ebb7a78b14` (dirty tracked tree),
class-tree SHA-256
`f0cdeb70421d61cf0a4383abb5da46ac229533c239861cf985962bed42821893`,
Node 26.4.0, and an empty `JVM_*`/`SSA_AFFINE_*` override set.
The post-test production build succeeded with the four existing webpack
warnings; `dist/jvm-debug.js` SHA-256 is
`742fcd778de5ab32d463f4d5fa8247743e4bdf14893f183c01328364307122b7`.

One clean end-to-end Node logo run (production gates, handwritten oracles
disabled) measured 39.689 full-phase and 49.999 warm FPS with no runtime
errors. A following process reached the login-classified surface at sampled
frame 60 instead of the usual 210 and therefore measured a non-comparable
5.746/13.345 result: real-time logo progress advanced during startup and left
too few logo samples. It is retained as evidence that this phase benchmark
needs a fixed animation timeline before it can attribute a new three-run
median; it is not treated as an optimizer regression or success.

### Generic quotient/product recurrence ranges

The next optimization implements the interval analysis identified above.
Primitive loads and stores can now contribute a loop-range candidate. For the
affine sampler, the generic SSA renderer proves indexes with this bytecode
structure:

```text
recurrence += invariant step
quotient = recurrence / invariant divisor
derived = quotient * invariant multiplier
index = derived + invariant offset
```

Selection is based on the natural-loop CFG and local data flow, never an
owner, method, or field name. The quotient and product assignments must
dominate the access, the recurrence update must be after the access and on
every path to a backedge, and all other operands must be invariant. A
per-loop endpoint guard rejects division by zero, int32 overflow,
non-canonical/null array storage, more than 1,024 iterations, and out-of-range
first or last indexes. Successful source, mask, and destination guards enter
a loop with the per-pixel exceptional branches removed. Failure executes the
original loop, including precise bytecode-PC, locals, operand-stack, and
partial-mutation behavior.

The generic regression fixture verifies the emitted recurrence proof, valid
copies, a partial bounds failure at the exact `iaload`, and a zero-divisor
failure at the exact `idiv`. The original DekoBloko affine benchmark remains
pixel exact. In the same optimization session, its seven-round ABBA paired
ratio was 2.468× before the pass. Three clean post-change processes measured
1.969×, 1.995×, and 2.020×, for a 1.995× median: 19.2% lower as a total ratio
and 32.2% less overhead above the oracle. The paired ratios are used because
system load changed both absolute times.

The independent transparent-raster proxy also stayed at parity with its
structural oracle:

```text
node scripts/benchmarkSsaRasterKernels.js
# 1.012× paired median; 1.525 vs 1.517 ns/pixel; identical checksums
```

This supports keeping the fused gradient/flat handwritten raster installers
as explicit semantic oracles while production continues to use generated
bytecode-derived kernels.

Validation on the final tree:

```text
timeout 120s node node_modules/tape/bin/tape test/jitCompiler.test.js
# 1100/1100 passed

node node_modules/tape/bin/tape \
  test/fusedHotLoopRegression.test.js \
  test/schedulerPerformance.test.js \
  test/browserBundleConfig.test.js
# 77/77 passed

npm run build:bundle
# succeeded with the four existing webpack warnings
```

The rebuilt `dist/jvm-debug.js` SHA-256 is
`9ce033afd936d057860da9aed2a18750a5fcac95b57b04a47f7d85425bff23d8`.

### AST-safe SSA aliasing and Miner Disturbance renderer triage

An August 2, 2026 Miner Disturbance Firefox report exposed a generic compiler
correctness failure after about 127 seconds of startup:

```text
ReferenceError: ssaValue2 is not defined
```

The generated constructor/call sequence had removed an immutable SSA copy from
its ordinary block, but deferred asynchronous, deoptimization, and
scheduler-yield materialization still referenced the removed name. The defect
was not related to a game owner, member name, or descriptor. SSA copy discovery
and identifier replacement now operate on an Acorn JavaScript AST. Every
renderer-owned alternate edge is rewritten with the complete method alias
graph, and every generated ABI is rejected before installation if its AST
scope graph contains an unbound SSA identifier.

That scope audit immediately found a second generic defect in restoring direct
bodies: a later live-range pass could move a singly assigned `let` declaration
inside an inlined integral-leaf block while its uses remained outside. The pass
now promotes the binding only when the AST proves the declaration and write are
in the same lexical scope. Regression fixtures cover both the
constructor-to-virtual-call continuation shape and nested integral leaves;
neither fixture contains a game class or method identity. The original failing
Miner Disturbance parser method still coalesces 72 SSA copies and has zero
unbound identifiers. Its pixel-span direct body also executes without a
JavaScript `ReferenceError`.

The same telemetry separated presentation from guest rendering. During a
102-second Firefox interval, canvas presentation used only 194 ms for upload
and 117 ms for software blits, while sampled guest ownership was dominated by
the large model/face body `sl.a(IIIILpb;III)V`, followed by its triangle/raster
chain. This rules out canvas upload as the 0.9 FPS cause for that report. A
generic exact-int-static branch specialization was tested on the innermost
1,024-pixel span and then removed: 3,000 direct spans measured 9.16 ms without
the experiment and 9.26 ms with it. V8 already optimized enough of that branch,
so the extra runtime guard did not earn its complexity.

Validation and deployment facts:

```text
timeout 90s node node_modules/tape/bin/tape test/jitCompiler.test.js
# 1385/1385 passed

npm run test:performance:jvm-kernel-proxy
# all seven checksum/ratio gates passed

npm run build:bundle
# succeeded with the four existing webpack warnings
```

- Java-tools base commit: `fb28a225654574ecacc379abfb8998e588110ed6`
  with tracked optimizer/test/documentation changes present.
- Miner Disturbance JAR SHA-256:
  `1cfc8680848d1695207e742638f46e8b42528380694ba2f66480484adaa3c344`.
- Deployed production bundle SHA-256:
  `a507b7e7a950c1660c1a00fe530bfa8989818df5e90ca459c9270694271732f1`.
- The first Node control used default production JIT gates plus
  `--profile-jit`; it passed the former SSA crash but did not reach a measurable
  menu in 150 seconds because the remote launch path terminated its main thread
  in the Vorbis/audio decoder with `ArrayIndexOutOfBoundsException` at
  `b.c()I@2`. A 30-second diagnostic repeat used only
  `JVM_DEBUG_THROW_TYPE=java/lang/ArrayIndexOutOfBoundsException` and reproduced
  that separate guest stack. It is therefore not reported as an FPS result.

## 2026-08-15: where Tomb Racer's post-logo boot actually goes

Boot loading is a different axis from the Firefox animation work above: it is
measured in Node, on `postLogoToMenuMs`. Clean sequential runs measure
147.8 / 149.4 / 149.6 s.

**Measure the JRE the same day, on the same idle machine.** The long-quoted
16.014 s HotSpot figure is a stored number; `scripts/run-jre-reflection-main-menu.js
--game tombracer` re-measured on 2026-08-15 gives **13.26 s** post-logo
(logo 10.8 s, menu at 24.0 s, OpenJDK 11.0.31). So the real ratio is **11.3x**,
not the 9.3x that dividing by the stored figure produces, and a 5x goal is 66 s
rather than 80 s. Dividing today's number by a baseline captured on another day
under other load is the same error this document warns about above; the JRE
harness is cheap (39 s wall) and there is no excuse for not re-running it.

A CPU profile of one boot (152.3 s, sampling costs ~2%) attributes as follows.

| bucket | ms | % |
|---|---|---|
| runtime:jit | 41993 | 27.6 |
| runtime:core | 24936 | 16.4 |
| guest-compiled | 36777 | 24.2 |
| idle | 19823 | 13.0 |
| node-modules | 7620 | 5.0 |
| gc | 6472 | 4.3 |
| interpreter:opcode | 5623 | 3.7 |

### The gap is CPU work, not threads and not idle

Measure both runtimes with `/usr/bin/time -v` before theorising about either.

| | wall | CPU time | CPU% | post-logo |
|---|---|---|---|---|
| JRE (OpenJDK 11.0.31) | 42.6 s | **28.0 s** | 65% | 14.05 s |
| jvm.js | 181.9 s | **210.8 s** | 115% | 149.63 s |

jvm.js burns **7.5x more CPU for identical work**. Two popular explanations are
both refuted by this table:

- **It is not parallelism.** The JRE runs at 65% of ONE core. It is not
  exploiting multiple cores, so mapping Java threads onto `worker_threads` with
  a SharedArrayBuffer heap — a runtime redesign — would not close this gap.
- **It is not idle.** The JRE is idle ~35% of its wall time, proportionally
  *more* than jvm.js's 13%. JFR on the same run records 55.15 s of
  `jdk.ThreadSleep` across 1406 events in a 39 s run: the guest sleeps a lot on
  both runtimes, and it costs the JRE no wall time because the sleeps overlap.
  jvm.js's scheduler is single-threaded and cooperative, so it only shows as
  idle when all guest threads are blocked at once — which is why the same guest
  behaviour looks like a "stall" here and like nothing there.

Idle is therefore necessary (it is the guest's own `Thread.sleep`, via the
`fsa.a(IJ)V` wrapper), not removable, and not where the gap lives.

The arithmetic this forces: **guest code is only 24% of the boot.** At literally
zero runtime overhead the guest work alone is 36.8 s, or 2.8x the JRE. So 5x is
reachable and 1.5x is not, but 5x (66 s) means deleting roughly three quarters
of the ~115 s of non-guest time — and there is no hotspot to aim at, the largest
single self-time entry being 5.6%.

What the buckets are, since the names mislead:

- `node-modules` is **entirely acorn**, i.e. the JIT parsing its own emitted
  JavaScript. See the negative result above; the fix belongs at emit time.
- `idle` is the **guest's own poll loop**, not scheduler slack — but it is NOT
  spread evenly, and an earlier revision of this section was wrong to call it a
  proportional tax. Bucketed over the boot it is ~0.1% almost everywhere, 45.8%
  in the first 10 s, and then a 30-second window at 70-100 s that is ~50% idle.
  That window is a stall with a location, not a tax.
  `JVM_DEBUG_IDLE=frames` names where every thread is parked; 97% of all idle
  has one composition — two threads sleeping in `fsa.a` and three worker
  threads parked in `fia.run` / `jqa.run` / `ss.run` waiting for jobs — while
  the profile shows the same window running `drawImage`, `bu.f()V` and
  `kta.a([II)V`, i.e. the loading-screen animation.
  It is not network: with `ALTERORB_JVMJS_NET_LOG=1` the TCP bridge carries
  traffic only at t=1-29 s and t=116-118 s, about 25 KB in total, and nothing
  at all during the stall. Assets come from the local cache.
- `runtime:jit` is mostly per-call and per-entry machinery, not codegen:
  codegen is roughly 5 s of it. The largest items are
  `tryInvokeResolvedTarget` (4.4 s, a sequential cascade of property checks per
  call that wants to be one tag switch), `dispatcher` (3.3 s), and
  `tryInvokeSyncAt` (2.8 s).
- `runtime:core` is dominated by scheduler and interpreter plumbing:
  `_tryExecuteSynchronousInterpreterTick` (8.6 s) plus `execute` (7.2 s) is
  **15.8 s of scaffolding around only 5.6 s of actual interpreted opcodes**.

Two throwaway scripts generate these views from any `.cpuprofile`: self time per
`src/jit`+`src/core` function, and self time per `node_modules` library. Both are
a dozen lines and worth rewriting rather than hunting for.

## 2026-08-16: phase-aligning the two profiles, and a reduced loop for the gap

The previous section profiled jvm.js alone. Profiling HotSpot the same way
changes the size of the problem, because the two profiles were not covering the
same phase.

**Bucket the JFR samples by time before reading them.** `jfr print --json
--events jdk.ExecutionSample` over a `--jfr-profile` run of
`scripts/run-jre-reflection-main-menu.js` gives 757 samples across 38 s. Read
whole, that profile says the boot is dominated by one method,
`iua.a([I[IIIIFFFFFFFFFFFFFFFF)V`, at 30.8% self. That is wrong for our purposes:
bucketing by 2 s shows ~10 samples per window until t=18 s and ~95 per window
after it. `iua.a` is the *menu render loop*, which starts once loading finishes.

Restricted to the loading window (0..19 s) the JRE profile is
**115 samples, i.e. about 2.30 s of CPU across all threads** — and the largest
single entry in it is `BufferedImage.getRGB`, which is the probe harness, not
the game. HotSpot does not have a loading hot loop. It is I/O- and
sleep-bound at roughly 10% of one core, which is also why `/usr/bin/time`
reported 65% CPU for the whole JRE run: nearly all of that CPU was the render
loop after the menu appeared.

So the loading-phase comparison is **2.30 s of HotSpot CPU against roughly 132 s
of ours** (152.3 s wall less 19.8 s idle). The 7.5x whole-process CPU ratio in
the previous section understates the loading gap badly, because it divides by a
JRE number that is mostly post-menu rendering. Both figures are real; they
answer different questions, and the loading one is the one the 5x goal is about.

### The two profiles do not share a hot method

Attributing every jvm.js sample to its nearest enclosing guest frame:

| guest method | our time | share | of which |
|---|---|---|---|
| `npa/b(Lffa;I)V` | 8.28 s | 5.4% | guest 22%, jit 71% |
| `vma/b()[B` | 6.49 s | 4.3% | guest 78% |
| `kta/a([II)V` | 4.26 s | 2.8% | guest 50%, jit 41% |
| `fg/b(I)[F` | 4.18 s | 2.7% | guest 90% |

None of these is hot on HotSpot; in the loading window all four together account
for under 0.1 s there. More importantly **57.4% of our boot is not under any
guest method at all**, and the flattest possible statement of the gap is that
the top guest method is 5.4% of the profile. There is no single hot loop to fix.

By tier, guest-attributed time is 32.2% `generated-sync`, 23.8%
`hot-call-graph-framed-region`, 23.1% `structured-ssa`, 11.5% `positional-entry`.
`generated-sync` is the weakest tier and the largest one.

### `npa.b` is the representative shape

`npa.b(ffa, int)` is a nested tile-grid walk. Per cell its body issues a 9-arg
`invokeinterface`, two narrow interface getters, an `invokestatic` factory, a
`checkcast`, and three `invokevirtual` calls around a small object cache, with
almost no arithmetic between them. It spends 8.23 s of its 8.28 s on
`generated-sync` — it never leaves the weakest tier — and its internal split is
**35.2% `tryInvokeResolvedTarget`, 20.7% `tryInvokeSyncAt`, 22.3% guest code**.
It is a call-boundary loop, not a compute loop.

### The reduced loop

`benchmarks/TileDispatchHotLoop.java` plus
`scripts/benchmarkTileDispatchHotLoop.js` reproduce that shape in about six
seconds instead of a three-minute boot, with a HotSpot checksum as the oracle.
Four shapes, all `(int, int) -> int`: `arith` (control, no calls), `iface` (one
monomorphic interface call), `poly` (the same site with three implementations),
and `tile` (the profiled per-cell mix).

The existing `CallBoundaryHotLoop` could not stand in for this. It covers
*static* calls only, and its harness forces `JVM_WASM_JIT=1`; the boot profile
contains **no wasm tier at all**, so that harness measures a tier the boot never
reaches. The new runner leaves the JIT enabled and inherits `JVM_*` from the
environment, matching how the launcher constructs the JVM.

Run under the launcher's flags at 200k iterations, medians of 3 after 3 warmups:

| shape | HotSpot | jvm.js | slowdown |
|---|---|---|---|
| arith | 4.09 ns/iter | 49.40 ns/iter | 12.1x |
| iface | 0.92 ns/iter | 593.35 ns/iter | 642x |
| poly | 6.79 ns/iter | 772.05 ns/iter | 114x |
| tile | 18.17 ns/iter | 4931.99 ns/iter | 272x |

The `iface` denominator is small because HotSpot inlines a monomorphic interface
call to nothing. That is not a defect in the fixture — it is the finding. We
charge roughly 590 ns for a call site HotSpot makes free. (Both call loops carry
a loop-carried dependency through the call argument; without it HotSpot folds the
loop to a closed form and the ratio divides by a denominator containing no call.
The `arith` control moved 7.5x -> 12.1x across two runs purely on native-side
variance, so treat one run of these as an order of magnitude, not a measurement.)

It reproduces the boot pathology rather than merely being slow. Profiling the
`tile` shape alone and applying the same bucketing as the boot profile:

| | boot `npa.b` | reduced `tile` |
|---|---|---|
| `tryInvokeResolvedTarget` | 35.2% | 28.0% |
| `tryInvokeSyncAt` | 20.7% | 8.8% |
| dispatch total | ~56% | 59.4% |
| guest code | 22.3% | 19.4% |
| tier | `generated-sync` 99% | `generated-sync` 100% |

Same helpers, same rank order, same split, same tier. Iterate on the call
boundary here, not on a three-minute boot.

## 2026-08-16: optimizing the call boundary against the reduced loop

Using `TileDispatchHotLoop` as the measurement loop rather than a boot. Note
which number to read: the jvm.js side is stable to about 0.5% across runs
(tile 4904.95 / 4886.90 / 4911.35 ns/iter), while the HotSpot denominator swings
(12.81 / 16.99 / 13.43 for the same tile shape). **Track absolute jvm.js
ns/iter, not the slowdown ratio** — the ratio's noise is almost entirely in the
denominator, and a 0.5% signal is enough to accept or reject a change in six
seconds.

Four changes to the synchronous call boundary, each measured separately:

| shape | before | after | change |
|---|---|---|---|
| iface | ~590 ns/iter | ~422 | -28% |
| poly | ~775 | ~548 | -29% |
| tile | ~4901 | ~3601 | -27% |

**1. Stop deleting fields on a recycled frame (-22%, the largest single win).**
`tryInvokeResolvedTarget` cleared five bookkeeping fields on the child frame
with `delete` on every call. `delete` drops the object into dictionary mode, and
this is the frame the JIT recycles through `target.freeFrame`, so every call
through the boundary de-optimized the object it was about to run. All five
fields are only ever tested for truthiness or identity, so assigning `undefined`
is indistinguishable to every consumer. `returnParentFor` in
`src/instructions/control.js` had the same pattern on the generated-to-
interpreted return path and got the same treatment. Note that `Frame`'s
constructor already carries a comment recording this exact lesson for the
monitor fields; the call boundary had simply not been given it.

**2. A polymorphic dynamic-target cache (-5 to -10%).** `site.fastDynamicTarget`
is guarded by `if (!site.fastDynamicTarget)`, so only the *first* receiver type
a virtual/interface site ever sees gets a fast slot. Every later type missed the
whole fast cascade and re-ran the generic path — receiver reload, JRE lookup,
map probe — on every call, even though `site.targets` already held its resolved
target. `site.fastDynamicTargets` now keeps every resolved receiver type, keyed
by class name, holding the same target object `site.targets` does (so an
in-place generated-code upgrade stays visible through both). It is consulted
only after the monomorphic slot misses, so all existing precedence is preserved,
and types that resolve to a JRE method are never recorded in it, so JRE
precedence is untouched. It is versioned against `jni.registryVersion`.

**3. Test the feature flag before the lookup.** `tryInvokeSyncAt` computed
`site.fastPositionalTargets?.[receiverType]` — a string-keyed dictionary access
— on every virtual call, and only then checked whether frame-positional calls
were enabled at all. Hoisting the flag skips the lookup entirely when the
feature is off.

**4. A negative cache for JRE resolution: measured, rejected, reverted.**
`tryInvokeSyncSite` caches positive JRE lookups but has no negative cache, so for
a guest method `resolveSynchronousJreMethod` runs per call and returns null every
time. That method looks expensive — two registry lookups, `constructor.name`,
and `Function.prototype.toString` scanned for a sentinel. Memoizing it on a
4-tuple key measured **11% slower** (tile 3820 -> 4250). The reasoning was wrong:
`_jreFindMethod` is *already* memoized against `jni.registryVersion`, so for a
guest method it returns null immediately and the `toString` never ran. The
change replaced two cheap cached map lookups with building a template-string key.
Reverted. The lesson is the usual one — the expensive-looking line was not on
the hot path, and only measurement said so.

The remaining shape of the reduced loop after these changes is roughly equal
parts `tryInvokeResolvedTarget`, `runGeneratedFrame`, `tryInvokeSyncAt` and
`materializeCached`. `materialize` is already three assignments behind a trace
check, so further progress there means changing the call-site protocol — not
spilling before calls that cannot deopt — rather than micro-optimizing it.

**Validation, and what the boot actually did.** Full suite: 8899 tests passed,
0 failures. (The runner prints dot progress, not TAP, so grepping the log for
`not ok` finds nothing whether or not anything failed — read the trailing
`N tests passed` line and the exit code instead.) The reduced loop's checksums
match HotSpot on every shape.

The boot reached the main menu, and **the 27% did not transfer**:

| | baseline | with the three changes |
|---|---|---|
| firstFrameElapsedMs | 16050 | 16024 |
| firstMenuSurfaceElapsedMs | 173780 | 168519 |
| menu minus first frame | 157730 | 152495 |

That is 3.3%, on one run each, against a boot whose run-to-run variance is
around 20%. **It is noise, not a win.** Nor is that surprising in hindsight, and
the earlier attribution predicts it: `tryInvokeResolvedTarget` plus
`tryInvokeSyncAt` are together about 7.2 s of a 152 s boot, so removing a
quarter of them is worth ~2 s no matter how good the reduced loop looks.

The lesson is about what the reduced loop is for. It faithfully reproduces
`npa.b`'s *shape* — that was verified — but `npa.b` is only 5.4% of the boot,
and no guest method is more. A fixture built from the largest single method
necessarily over-represents that method's costs. It is the right tool for
iterating on the call boundary in six seconds instead of three minutes; it is
the wrong tool for predicting a whole-boot number, and a percentage measured on
it must be multiplied by that method's share before being believed.

`postLogoToMenuMs` was null on the optimized run because the logo-completion
detector did not fire, so the comparison above uses `firstMenuSurfaceElapsedMs`
anchored on a nearly identical `firstFrameElapsedMs`. One boot in this session
also died at 30 s on the already-known `dh.a(IIILan;IIIB)V` miscompile
(`saload` index 576 into length 124, same method and pc as previously recorded),
which is unrelated to these changes but is evidently reachable without
`JVM_JIT_WARMUP=1`.

## 2026-08-16: inlining integer getters, and the same lesson a second time

`iface` is one interface call per iteration whose callee is `return w + bias`.
We charged 422 ns for it where HotSpot charges under 2 — roughly 1500 cycles to
perform an add — because the callee ran as a full generated *frame*. Profiling
that shape alone shows the callee never even appears as its own tier entry: all
the time is the caller's generated code plus the boundary machinery.

The inline machinery already existed (`getInlineIntegerRegion`), but its opcode
whitelist was **arithmetic only** — `iload`, `iconst`, `bipush`, `ldc`, the
integer ALU ops, `if*`, `invokestatic`, `ireturn`. No `aload`, no `getfield`. So
it could inline a pure function of its arguments and nothing else, which
excludes essentially every real getter, including all of the `ffa` accessors
that make `npa.b` call-dense.

Two opcodes were added to the plan builder:

- `aload_0`, admissible because every parameter is already proven `int`, so on
  an instance method slot 0 is the *only* reference in scope.
- `getfield`, restricted to a field whose declaring slot is statically known
  (`directInstanceKey`), whose descriptor is `I`, and whose object operand is
  literally the receiver expression — so no second object's nullness has to be
  reasoned about. It emits the same guarded direct read the ordinary generated
  tier uses, falling back to `getFieldAt`, which resolves nonstandard layouts
  and throws the correct NPE. Because a field read *can* throw, unlike the rest
  of the whitelist, it is refused outright when the body has an exception table,
  since handler blocks are dropped from the CFG earlier in that function.

The stack-ABI variant had no `helpers` parameter, so it is now built with one
and bound, leaving every existing `(stack, base)` call site unchanged.

| shape | before | after | vs. the session baseline |
|---|---|---|---|
| iface | 422 ns/iter | 226 | 590 -> 226 (-62%) |
| poly | 548 | 334 | 775 -> 334 (-57%) |
| tile | 3601 | 2857 | 4901 -> 2857 (-42%) |

`poly` is now about 50x HotSpot rather than 114x.

Two tier-counter assertions in `jitCompiler.test.js` changed and were updated
rather than worked around: with the accessor inlined, `generatedRunCount` for
that fixture falls 5 -> 1 (only the outer loop keeps a frame) and
`syncReusedFrameCount` falls 3 -> 0 (there is no child frame left to recycle).
The behavioural assertions in the same test — the returned values, and
`runnerRunCount === 0` — still hold, which is what proves dispatch is intact.
A new test covers the property that actually matters for soundness here: a
getter inlined into a loop that writes the field between calls must observe each
write, and it does (5, 7, 9, 11). Full suite 197/197 files, 8902 tests, exit 0.

**And the boot did not move, again.** One run each, `firstMenuSurfaceElapsedMs`
minus `firstFrameElapsedMs`: 157730 baseline, 152495 with the boundary fixes,
152154 with getter inlining as well — 3.5% in total, against ~20% run-to-run
variance. `postLogoToMenuMs` was 152288 and is 146733, which is the same story.

That is now twice in one session that a large reduced-loop win produced nothing
measurable on the boot, and the reason has not changed: the fixture is built
from the boot's largest guest method, and that method is 5.4% of the boot. The
call boundary is simply not where the 152 s is. The profile has been saying so
from the start — 57.4% of the boot sits under no guest frame at all, and the
single largest runtime item is the scheduler/interpreter tick pair
(`_tryExecuteSynchronousInterpreterTick` plus `execute`, 15.8 s of scaffolding
around 5.6 s of actual interpreted opcodes), which is more than twice the whole
call boundary. Optimizing what a reduced loop measures is not the same as
optimizing the boot, and the way to tell the difference is to scale every
fixture percentage by its method's share before believing it.
