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

### Exclusive phase accounting inside one compile

The counters above answer *how long* the guest's thread was held, not *by what*.
`JVM_JIT_COMPILE_PHASE_TIMING=1` (or `jit: {compilePhaseTiming: true}`, or
setting `jit.compilePhaseTiming = true` from a page, which is how a browser turns
it on) adds a second layer that splits one compile into named phases:

- `jit.compilePhase(name, fn)` / `beginCompilePhase` / `endCompilePhase` time a
  phase **exclusively**: entering a child charges the parent for everything up to
  that moment and suspends it, so a phase is never charged for the phases nested
  inside it. `inclusiveMs` is also reported, and is the wall interval the phase
  spanned.
- A compile triggered from inside another compile is itself a phase
  (`compile.calleeRecursive`, against the outer `compile.total`), so recursive
  callee compilation leaves the caller's phases instead of being counted twice.
- `jit.countCompileWork(name, amount)` records counted (not timed) quantities —
  emitted statements, indentation passes, characters copied — for paths that run
  once per generated line and must not carry a clock read.
- `jit.compileTimeline` holds one row per outermost post-main compile with its
  own `startMs` and `ms`. A running total cannot say how much compilation fell
  before a transition's first frame; a timeline can.
- `jit.compilePhaseCensus()` returns the phase table and the counters as plain
  data; `jit.resetCompilePhaseStats()` clears both.

The facility is off by default and costs one property read per call site when
off. It exists because a stall has to be attributed before it can be reduced:
the Deko Bloko Start Game census reported ~8 s of post-main synchronous
compilation inside a transition whose click-to-first-frame freeze was ~4-5 s.
The counter could not be double-counting (it is outermost-only), and the
timeline showed the rest directly: compilation continues well past the first
frame, inside the same stage.

### What one large structured-SSA compile is made of

Measured with the above on the two Deko Bloko methods the Start Game transition
enters for the first time, `qc.a(ZIIZZ)V` (4121 bytecodes, 2.18 MB of generated
JavaScript, 20391 lines) and `qc.b(IZ)Z` (3463 bytecodes, 1.82 MB):

- The compiler is **linear** in method size for these two. Across every method
  of the gamepack the tier accepts, the median is 0.13-0.20 ms per bytecode in
  every size bucket from 40 to 8000 bytecodes, and these two sit on the median.
  They are expensive because they are large, not because they are pathological.
  (Two other methods are genuinely superlinear — `ml.a(Lji;B)V` at 1.37 ms/bc
  and `sh.a(ZLji;)V` at 0.57 — and neither is in this transition.)
- Leading whitespace is 55.7% / 59.3% of the emitted bytes, at an average
  nesting depth of 30 and a maximum of 57. It is produced by re-prefixing every
  line at every nesting level, so `qc.a`'s 20391 lines cost 645855 line
  rebuilds and 54.5 MB of characters — a 25x amplification.
- **That amplification costs very different amounts in different engines.**
  Removing the indentation entirely took the compile from 604 ms to 486 ms in
  Node/V8 (-19%) but from 1587 ms to 697 ms in Firefox/SpiderMonkey (-56%): V8's
  cons strings make the repeated prefixing nearly free, SpiderMonkey's do not.
  A V8-only profile therefore understates this by a factor of three, which is
  why it reads as a 2% line in a Node profile and as the dominant cost in the
  browser (`render` is 64-70% of these compiles there, 25% in Node).

### Where the Start Game compiles come from: a launcher with preparation off

The Deko Bloko transition above was re-traced on one clock (browser
mousedown, AWT enqueue and dispatch, every scheduler tick with its thread and
top-of-stack method, every presented frame classified from its pixels, every
outermost compile with its own start). Cut at the first Stage 1 briefing frame
— not at the first *presentation* after the click, which is a menu repaint
6-110 ms in — the interval is 5.5-6.8 s, of which 71-74% is synchronous
compilation (76-79 outermost compiles, 3.9-5.0 s), 23-24% is the guest
running (mostly freshly generated code and the interpreter for the islands of
partial Wasm modules), and 3-5% is the main thread outside a guest tick. The
earlier "0 of 84 compiles start before the first frame" was true of the menu
repaint and false of the briefing.

Every one of those compiles is a **first** compile (the session's per-method
codegen counts are all 1), because the page hosts the JVM through
`DebugController`, whose constructor sets `prepareBeforeMain: false` for
debugging fidelity. Nothing is compiled ahead of `main()` in that launcher:
its boot runs 1004 synchronous post-main compiles (32.9 s) and the Start Game
click runs the 77 that the gameplay path touches next. Node, whose launcher
prepares by default, compiles 2335 methods before `main()` and reaches the
menu without any of this.

Turning preparation on in the browser (`prepareBeforeMain: true` passed
through the controller's options, `prepareWasmPreparedUpgradesOnly: true` so
the Wasm half is the prepared oversized-loop upgrades only, as
`apps/launcher/browser-runtime.js` asks for) first crashed the guest at
"Unpacking graphics" with `NullPointerException: Attempted to store into null
array` from a prepared body of `mf.a(...)`. The mechanism, found by trapping
writes to `jvm.classes.um` with JS stacks: the page registers a targeted JRE
override for the *game* class `um` (`natives: {applicationFallback: true}`),
so `um` exists as a JRE stub from JVM construction; the preparation pass
compiles against that stub and prepared bodies resolve their static-field
targets to the stub's `StaticFieldStore` (and keep its value cells). When the
real class is loaded over the stub at first use, `loadClassByName` used to
register a class with a fresh store, so a prepared `putstatic um.c` wrote into
the stub's dead store and the next `getstatic um.c` read null from the live
one. `loadClassByName` now makes the real class adopt the stub's store
(`test/applicationFallbackStubStore.test.js`); the store object is the
identity those cells rely on. Node never saw this because only the browser
page carries that override.

With that fixed, preparation on: click to Stage 1 briefing 5495 -> 1637 ms
(one 19 ms compile in the interval instead of 76 compiles / 3.85 s), nothing
compiled after the briefing (0 instead of 10 compiles / 3.5 s), longest rAF gap
after the briefing 1591 -> 69 ms, SPACE to the board 594 -> 507 ms with 0
compiles. The cost is the boot: first frame 67 -> 117 s, menu 104 -> 183 s
(2530 pre-main compiles, 83 s in Firefox). What remains of the transition is
1.5 s of guest execution that is now mostly *interpreted* (1255 ms of
interpreter ticks, `mm.a(Ljava/lang/String;II)V` 298 ms, `qc.a(ZIIZZ)V` 254
ms), i.e. prepared bodies deopting back to the interpreter — the next thing to
account for. `JVM.run()`'s preparation pass takes `prepareWasm`,
`prepareEffectful` and `prepareLoopsOnly` for the same reason the phases above
exist: each half can be measured on its own.

### Complete preparation: a fixed point before main(), and what it exposed

The `?prepare=1` experiment above left three things unfinished, and the
follow-up made preparation the browser page's default only after fixing
them rather than routing around them.

**The class-record identity invariant.** Adopting the stub's static store was
one field of a general problem: prepared code holds the class record, its
store and value cells, its Class object, its initialization token and its
method objects by reference, and an `applicationFallback` stub is all of
those before the class file is read. `JVM.upgradeStubClassInPlace` (called
from `loadClassByName`) now fills the existing record in place — stub-only
members go, the real class's members arrive, the stub's store is kept with
the real class's declared statics merged in, the method index keyed on the
record is dropped — so `jvm.classes[name]` never changes identity.
`preloadReferencedClasses` treats such a stub as not loaded, so the
preparation pass compiles against the real class in the first place.
`test/preparationStableIdentity.test.js` prepares a body against the stub by
hand (statics, static call, virtual call, an overridden method, `instanceof`,
a class literal), runs the program, and checks that the *same* body still
computes the right result through the *same* record, store, cells, Class
object and token, with `<clinit>` run once at its Java-visible point.

**Prepared callees were treated as asynchronous.** `linkSyncCallTarget`
decided whether a callee is synchronous with the adaptive (non-effectful)
admission, which rejects any method that constructs an object with a
non-trivial constructor. Preparation compiles exactly those methods (it uses
the effectful admission), so a prepared caller reaching a prepared callee
found "no target", returned the async sentinel, and the caller deopted to
the interpreter: on Deko Bloko's first Start Game that was ~74,000 deopts
of prepared bodies per stage ("asynchronous structured SSA callee",
"structured resume handoff", "asynchronous callee from synchronous
invoke*"), the callees being ordinary draw/text helpers such as
`mm.a(Ljava/lang/String;II)V` with a body already in the cache. A callee
with a published synchronous body is now a synchronous callee
(`hasPublishedSynchronousBody`), and the resolved-target adoption path uses
the prepared admission for prepared methods. `jit.asyncCallCensus` (jit
option `asyncCallCensus`, or `JVM_JIT_ASYNC_CALL_CENSUS=1`) records every
remaining handoff with its reason, so the pass is judged on data.

**Fixed point.** `_precompileInitializedClasses` now repeats compile rounds
until a round prepares nothing new (bounded, exit on no progress), re-running
the referenced-class preload between rounds; then links every synchronous
call site of every prepared body (`prelinkPreparedCallSites`: static and
special sites to their one target, virtual sites to each concrete loaded
receiver in the declared class's cone, bounded per site; nothing compiles —
a callee without a body is left to the ordinary path); then compiles the
Wasm modules preparation is asked for and settles them against their
dependencies (`settlePreparedWasmModules`: rebuild while a module's blockers
moved, up to the runtime's own per-module bound) before the tier is frozen.
`jvm.preparationReport` says what happened: rounds, bodies, the unprepared
list, linked sites, Wasm modules settled, and the tier each prepared
oversized method ends on (`wasmFull` when its module covers it end to end,
`jsOwned` otherwise — a partial module is never an entry tier for a prepared
method; that selection was already in `tryRunFrame`, the report makes it
visible). `test/preparationFixedPoint.test.js` covers rounds, termination on
no progress, the unprepared report, and a prepared caller reaching a
prepared-only callee with the single asynchronous handoff Java requires (the
first-use `<clinit>`).

**What pre-linking exposed.** A static JRE shim may depend on its class's
`<clinit>` shim (`Runtime.getRuntime()` reads the static the initializer
stores). The fast JRE path in `tryInvokeSyncAtSite` had no initialization
check because the generic path, until now its only publisher, checked
before every static call. A site linked ahead of main called the shim
before the initializer, got `undefined`, pushed nothing, and the next call
underflowed its operands (`si.b(I)V` on Deko Bloko, caught by the Node
launcher). The check is on the fast path now, and the fixed-point test has
a case for it.

**Measured (Deko Bloko, Firefox, 2026-09-12, previous candidate with
`?prepare=1` vs completed preparation by default, two back-to-back pairs).**
Prepared-body deopts over the Start Game stage 72458/75023 -> 2884/3206;
click to Stage 1 briefing 1584/2062 -> 1241/1538 ms; briefing to 30 more
frames 2392/3184 -> 1691/2085 ms; interpreter samples before the briefing
188 -> 150 ms, runtime helpers under generated code 980 -> 804 ms; no
synchronous compile in either arm but one 20 ms Wasm callee link; pre-main
compiles 2530 -> 2556 (84-88 s of a 173-183 s boot). The remaining 1318
handoffs per stage are all methods with no synchronous tier at all: 161
constructors that call methods and 100 of their callers (constructor
admission), two oversized `client` methods with irreducible control flow
(the structured renderer's CFG structuring), and one long-arithmetic body.
The gamepack oracle (`.work/start-stall/compile-oracle.js`) is byte-identical
to the previous candidate on all 3022 methods (502 compiled, 2520 rejected):
the changes alter which methods preparation compiles, not what a compile
generates. Node's launcher reaches the menu with the same code in 97-123 s.

**Eager parsing.** Generated bodies are returned from their `new Function`
factory as a parenthesised function expression, which SpiderMonkey and V8
compile eagerly (the "possibly immediately invoked" heuristic) instead of
syntax-parsing and delazifying on the first call; preparation creates them
before main, where the parse is free.

### Compiler coverage after preparation: constructors, irreducible bodies, `pop2`

With preparation complete, every remaining Start Game handoff was a method
with no synchronous tier, so the follow-up ranked those by wall time and
then removed the compiler gaps in that order.

**Handoff wall time.** A handoff count says nothing about cost: one
interpreted long-arithmetic body can cost more than three hundred
interpreted constructor calls. `asyncCallCensus` now also attributes
elapsed time. When a synchronous call site hands a call back
(`recordAsyncCall`), the caller's frame remembers the site and the
`performance.now()` stamp (`frame.jitHandoffPending`); `CallStack.push`
matches the next pushed frame against it by member name and descriptor (a
structured caller does not materialise a pc, so the pc is not usable as the
key) and opens a record; `CallStack.pop`, the universal frame retire point,
closes it. Nested handoffs subtract their own elapsed time from the parent's
record, so `jit.asyncCallCensusTime` (per site+callee: count, exclusive ms,
longest single interruption) is exclusive of nested execution and sums
without double counting. On Deko Bloko's Start Game stage the ranking was
`dn.a(I)J -> dn.c(I)J` 458 ms in 107 calls (a `pop2` the tiers did not
emit), the constructor callers `ia.a -> ei.b` 122 ms and `bd.b -> fh.a`
50 ms, and `in.<init>` 29 ms in one call, out of 703 ms; the two
irreducible `client` methods were missing from the first ranking because
of the pc-keyed match above, which is how that bug was found.

**Constructor admission on the resolved call graph.** `isJitSafeConstructor`
rejected any constructor that calls a method, and every caller that
allocates such an object with it. A constructor is now admitted when it is
an ordinary instance constructor (not `synchronized`) and every invoke in it
resolves to a published synchronous entry: a synchronous JRE shim, a bytecode
method with a published synchronous body, a static intrinsic, or an abstract
target whose loaded concrete implementors (the declared class's cone, at
most eight, each checked recursively) all have one
(`isSynchronouslyResolvedConstructor`, notes in
`jit.constructorAdmissionNotes`). Class initialization, exception
propagation and the partially initialized `this` need nothing new: the
admitted body is the same effectful structured/baseline body every prepared
method runs, its `<clinit>` and `athrow` paths are the existing ones, and
`this` is only ever the receiver the bytecode passes. Because admission
depends on callee bodies that later rounds prepare, the fixed-point loop
clears the admission cache between rounds, so a constructor rejected in
round 1 for a callee without a body is admitted once the callee is
prepared, and its callers after it (Deko Bloko needs 8 rounds). A
constructor that reaches a genuinely asynchronous host operation (a
`RandomAccessFile.read`, `Class.forName`, a `Thread.sleep`) stays rejected
with the reason recorded. `JVM_DISABLE_PREPARED_CONSTRUCTORS=1` restores the
old rule. `test/preparedConstructors.test.js` covers a constructor calling a
synchronous instance method, a static method, superclass chaining, a throwing
constructor, a constructor calling an asynchronous callee (rejected, note
names the callee, its caller still hands off), and the census showing no
handoff at the admitted sites.

**Nested irreducible regions.** `dispatchIrreducibleCfg` (the dispatch-island
transform that turns a multi-entry loop into a block dispatcher inside an
otherwise structured body) looked for a multi-entry strongly connected
component among the method's top-level SCCs. `client.i(B)V` and
`client.a(IIZIZIB)V` have a single-entry outer loop whose *body* contains
the multi-entry region, so the search found nothing and the method fell to
`IrreducibleError`. The candidate search now peels a single-entry component
by its entry and searches inside it recursively; the island itself is
unchanged. `test/structuredNestedIrreducible.test.js` builds a nested
two-entry loop by hand and checks values against a JS reference.

**Counted-loop canonicalisation.** Compiling `client.i` then failed with an
undefined label: `canonicalCountedLoop` in `lineSpecialisations.js` split the
loop body at the first `else` after the header test, which is the wrong arm
when a merge block follows the header's own `if`/`else`, and it did not
account for a negated header test (`if (!(i >= n))`). The rewrite now finds
the header's own arms (`ifArms`) and requires the loop to end with them; a
negated test flips which arm is the body. The gamepack oracle shows three
methods that previously failed with "Undefined label" compiling as a result.

**`pop2`.** `dn.c(I)J` discards a `long` with `pop2`, which neither tier
emitted. Because a `long` and a `double` are one slot in this JVM (a BigInt
or a Number), `pop2` pops one value of width 2 or two values of width 1; the
stack-width analysis (`computeStackDepths`, `ssaOperandCategories`) is run
for any method containing `pop2`, and both the baseline emitter and the
structured lowering pop by the verified width. `test/pop2Codegen.test.js`
covers long, double and two-int operands on both tiers.

**Offline preparation census (Deko Bloko gamepack).** Unprepared methods
296 -> 129 (constructor admission) -> 74 (baseline framed entry allowed for
structured bodies that need it) -> 40 (cone resolution of interface
targets); every method on the Start Game handoff ranking is prepared. The
remaining 40 are: 29 bodies with `monitorenter`/`monitorexit`
(`synchronized` blocks), which the effectful admission keeps off unless
`effectfulMonitorCodegen` / `JVM_ENABLE_EFFECTFUL_MONITOR_CODEGEN=1` is set
(`ia.a(IIIIII)V`, the caller of `ei.b`, is one of them and is now the only
method on the Start Game top-of-stack list without a synchronous tier);
three constructors that reach an asynchronous JRE shim (`hf.<init>`:
`RandomAccessFile.read`; `fd.<init>`: `Class.forName`; `le.<init>`: `im.a`,
a monitor body), one constructor calling `hf.<init>` (`nh.<init>`), and
seven callers of those (five "calls a non-safe constructor", two whose
constructor target is a class never loaded, `Socket`/`Proxy`). The gamepack
oracle against the previous candidate:
487 methods byte-identical, 9 newly compiled, 0 lost, 15 whose only change
is call-site numbering (identical after digit normalisation).

**Admitted but never emitted.** The first browser run of that candidate
stalled after the logo: the client thread sat in the loading state machine
(`client.n(I)Z`, the stage that builds the music tracks and fonts) for eight
minutes and more, the Firefox content process grew past 28 GB, and the Node
launcher never reproduced it. The census that found it
(`jit.deoptedMethods` with `lastMethodDeoptReasons`, page snapshot every
15 s) showed 13 prepared bodies deoptimised for good: eleven with
"unsupported generated opcode multianewarray" (`client.n(I)Z`, three
`pl.a(...)Lud;` sprite loaders, `bi.<init>`/`bi.a`, `kj.a(Lwl;)V`,
`va.b([B)V`, `je.<init>`, `hj.<init>`, `ja.<init>`) and two with
"unsupported opcode lconst_0 in en.<init>" (`en.<init>`, `hn.start`).
`multianewarray` was on both opcode admission lists but the baseline
emitter had no case for it, so a body with `new int[a][b]` was admitted,
compiled, and deoptimised at its first allocation; `lconst_0` (and every
long load/store/arithmetic opcode, `pop2`, `dup_x2`, `dup2_x2`, `i2c`,
`i2s`, `instanceof`, both switches) was missing from the JIT runner
(`runFrame`), the interpreter a JIT-owned frame resumes in after a
transient deopt. A non-transient deopt sets `frame.jitJsDisabled`, the
frame is interpreted from then on, and every call boundary in it ends the
scheduler quantum: the sampled scheduler rows put `client.n(I)Z` and
`di.<clinit>()V` (a 92-bytecode table builder) on the awaited slow path at
about a millisecond per bytecode, which is the stall. The current bundle
carried five of the same deopts but not the loading loop's. Now:
`allocMultiArray` (src/instructions/object.js) is the one allocator for the
interpreter, the baseline emitter (`helpers.newMultiArrayFrom`), the
structured renderer (`helpers.newMultiArrayCounts`, plus the missing
stack-effect rule) and the runner; the runner has the listed opcodes, using
the same verified operand widths as the generated tier for the category-2
shuffles. `test/multianewarrayCodegen.test.js` (every tier, `long[n][n][]`
partial dimensions, `NegativeArraySizeException`, a javac fixture that must
keep its synchronous body and record no "unsupported" deopt) and
`test/runnerOrdinaryOpcodes.test.js`. With the rebuilt bundle the same
page reaches the menu (first frame 159 s, menu 215 s) and the Start Game
click runs with no synchronous compile.

**The preload the browser never had.** With the stall gone, the census
arm's top handoff by wall time was one site, 488 calls and 1.2 s of a
1.9 s click: `bd.b(ZI)V@51 invokevirtual hm.a(I)I`, whose receiver is
`ag`, the mouse-wheel listener, and whose target `ag.a(I)I` is a
20-bytecode `synchronized` getter. Offline the same preparation prepared
it; in the page none of `ag`'s five methods were prepared, and the getter
fails the post-main worth gate, so it never got a body. The game loads
`ag` with `Class.forName` (the 1.3-era mouse-wheel dance), so it is in no
constant pool; `preloadClasspathClasses` would have found it in the jar,
except that in the browser the classpath is `.` on a virtual file system
with no directory to read -- the walk failed silently and only
`preloadReferencedClasses` ran. `BrowserFileProvider.listClassNames`
enumerates the classes it can serve and the preload asks a provider that
has it before walking a directory
(`test/preparationPreloadsProviderClasses.test.js`: a reflection-only
class with a synchronized getter is prepared before main).

**Measured** (2026-09-12, same fast host, Firefox, page defaults, arms back
to back: the current bundle, then the candidate twice, then the candidate
with the census on; the machine carried a load average of 12-18 from other
work throughout, so only the pairing is evidence):

| | current bundle | candidate | candidate, repeat |
| --- | --- | --- | --- |
| menu (boot, free) | 193.6 s | 187.2 s | 187.3 s |
| click -> first transition frame | 621 ms | 605 ms | 317 ms |
| click -> Stage 1 briefing | 1197 ms | 1148 ms | 1188 ms |
| briefing -> 30 more frames | 1502 ms | 1406 ms | 1359 ms |
| SPACE -> board frame | 468 ms | 345 ms | 466 ms |
| longest rAF gap after the click | 107 ms | 61 ms | 62 ms |
| synchronous compile in the stage | 20 ms / 1 | 0 | 0 |
| prepared-body deopts, stage total | 2951 | 1583 | 1583 |
| click -> briefing partition: interpreter | 656 ms | 34 ms | 31 ms |
| click -> briefing partition: generated | 374 ms | 966 ms | 1042 ms |
| click -> briefing partition: slow async | 73 ms | 48 ms | 14 ms |
| preparation | 2 rounds, 2335/5156 bodies, 293 unprepared | 8 rounds, 2608/5174, 38 unprepared | same |

Census arm (candidate, `?asyncCensus=1`): 2 handoffs at synchronous call
sites in the whole stage (was 1318 before this work, 490 before the
preload fix), 6 ms of handoff wall time, both singletons
(`pn.a(ZZZ)V@58 -> nn.a(ILui;Z)V`, a monitor body; `wg.mousePressed ->
SwingUtilities.isRightMouseButton`, class not initialized). No constructor
handoff, no irreducible-CFG handoff. The remaining 1583 stage deopts are
structured-tier continuations and resume handoffs (895 + 567), safe points
(143) and thread yields (56) -- scheduler quanta, not coverage. The 38
unprepared are the 29 monitor bodies and the 9 asynchronous-shim
constructors and their callers listed above. Gameplay: the click reaches
Stage 1, SPACE reaches the board, input is accepted (the drive presses the
keys and sees the frames). Full suite 12493 tests, all passing; the
gamepack oracle against the morning's candidate: 2998 byte-identical,
4 newly compiled (all `multianewarray` bodies now accepted by the
structured tier), 0 lost, 20 with a changed hash, every one a method
without `multianewarray` in the two classes (`ja`, `ke`) that gained a
compiled sibling, i.e. call-site numbering.

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
