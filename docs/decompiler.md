# Structured Decompiler: goto-free control-flow recovery

This document records the design, the algorithms, and — importantly — *why* this
project grew its own control-flow structurer instead of relying on CFR or
Vineflower. It is written to be read cold, months later, by someone who has
forgotten every detail.

## TL;DR

`src/decompiler/` contains a **provably goto-free** control-flow structurer:

| File | Role |
| --- | --- |
| `structurer.js` | Turns any **reducible** normal-control-flow CFG into a goto-free statement tree (loops + labeled blocks + `break`/`continue`). Ramsey "Beyond Relooper" specialized to Java. |
| `../passes/regionSplit.js` | Makes an **irreducible** CFG reducible by controlled node splitting (Janssen & Corporaal), so it, too, falls under the structurer's guarantee. |
| `exceptionStructurer.js` | A conservative **try/catch** layer on top of the structurer: carves protected ranges + handlers out of the CFG as recursive sub-regions. Never emits wrong Java — bails with a reason instead. |
| `cfr.js` | A pre-existing proto-decompiler ("CFR-JS 0.4.0"). Its expression/statement reconstruction (operand stack → Java expressions) is kept; its weak pattern-matching structurer is what the above replaces. |

The design guarantee: **for any reducible CFG the structurer emits zero gotos**,
and region-splitting brings the irreducible minority into that class. This is an
*algorithmic* property, not a heuristic that happens to work on today's inputs.

## Why our own decompiler?

The immediate motivation was a gamepack-deobfuscation pipeline where the final
quality gate is "does CFR decompile every method without a `** GOTO` /
`Unable to fully structure code` marker?" After a long campaign of
oracle-gated, shape-based bytecode transforms we drove residual markers down to a
stubborn handful of methods across ~10 games — and hit a wall. The wall taught us
three things:

1. **The markers are decompiler heuristic limits, not properties of the
   bytecode.** The bytecode is verifiable and executable; CFR simply gives up on
   control-flow shapes its structurer can't pattern-match. Chasing those shapes
   with bytecode rewrites is chasing one tool's implementation quirks.

2. **CFR and Vineflower fail on _disjoint_ method sets.** Swapping in a second
   decompiler as the oracle *relocates* the failures rather than removing them.
   Proven on `terraphoenix`: CFR fails method `b`; Vineflower fails a *different*
   method `a(boolean, boolean)`. Vineflower additionally *crashes*
   (`DomHelper.parseGraph`) on genuine irreducibility rather than emitting a
   marker. So no single third-party tool clears the corpus, and a
   "multiplexer" that picks the best of both per-method is fragile plumbing that
   still inherits the union of their blind spots.

3. **Structuring a reducible CFG is a _solved_ problem** — Ramsey's ICFP 2022
   "Beyond Relooper" gives a total algorithm that structures *any* reducible CFG
   into `loop`/`block`/`break`/`continue` with no gotos. Java's labeled
   `label: { ... break label; }` and `while (true) { ... continue; }` map to it
   directly. If we own the structurer, goto-freedom stops being a thing we
   *hope* a third-party tool achieves and becomes a thing we *prove*.

The decision (2026-07-10) was therefore: **own the structurer.** Not a
from-scratch decompiler — reuse the large, tedious, already-working
expression-reconstruction layer (proto-CFR's ~2400 lines) and replace only the
~400-line structuring core with an algorithmic one, feeding it region-split
output for the irreducible minority.

### Why not "just implement a multiplexer over CFR + Vineflower"?

Considered and rejected. A multiplexer:
- inherits the union of both tools' bugs and crashes (Vineflower dies on
  irreducibility; you'd need to catch and fall back per method);
- gives no *guarantee* — it's "best of two heuristics", so a method both tools
  fail is unrecoverable;
- is opaque: when it fails you're debugging someone else's structurer.

Owning an algorithmic structurer gives a proof obligation we can actually
discharge, and every supporting analysis (CFG builder, dominators, SCC/loop
detection, reducibility oracle, node splitting) was already built during the
goto-cleanup work.

## What CFR/Vineflower actually fail on (the three classes)

From the residual-marker analysis across the 10 stubborn games:

1. **Disjoint irreducibility / awkward reducible flow.** Obfuscated dispatch and
   loop shapes that are reducible-but-awkward (CFR bails to `** GOTO`) or
   genuinely irreducible multi-entry SCCs (Vineflower crashes). The two tools
   disagree on *which* methods, so neither is a superset.

2. **Exception-range interactions.** Protected ranges whose boundaries interact
   with normal control flow in ways the structurer mishandles.

3. **Structure the tools simply don't attempt.** Shapes where the heuristic
   pattern set has no matching template and the fallback is a linear
   goto-dump.

The structurer + region-split combination produces goto-free structured output
for **443/443 methods** across the exact residual-marker classes that CFR and
Vineflower fail on. That is the core result: the algorithmic approach clears the
methods that defeated both third-party tools.

## The structurer (`structurer.js`)

Input: an abstract CFG of **normal edges only** — `{ n, entry, succ, succAll,
term }`. Exception edges are deliberately *not* in this graph (see the try/catch
section for why). Output: a statement tree of

```
seq | block(label) | loop(label) | if | switch | straight | break(label)
   | continue(label) | try
```

Algorithm (Ramsey "Beyond Relooper", specialized to Java labeled break/continue):

- Compute reverse-postorder and dominators (Cooper–Harvey–Kennedy).
- Classify edges; a **retreating** edge whose target does *not* dominate its
  source means the CFG is irreducible → throw `IrreducibleError` (the caller
  region-splits and retries).
- **Loop headers** (back-edge targets) become `while (true) { ... }` and the back
  edge becomes `continue L`.
- **Merge nodes** (≥2 forward predecessors) become labeled blocks; a forward
  branch into one becomes `break L`.
- A branch whose target is dominated by the branch and is *not* a merge is
  inlined directly (the common, label-free case).

Two subtleties that cost real debugging and are enshrined in tests:

- **Loops must wrap _everything_ they contain, including their internal merge
  blocks.** An earlier version wrapped the loop inside the merge-peeling base
  case, which hoisted a loop's own internal merge block *outside* the loop so its
  back edges couldn't find their header ("no enclosing loop for edge 4->1"). Fix:
  loop-wrapping lives in `doTree`, so the loop encloses the entire `nodeWithin`.

- **Parallel edges must be counted for merge detection.** Two switch cases (or a
  conditional whose taken == fall) sharing a target are one edge in the
  dominator graph but *two* predecessors for merge purposes. `succ` is deduped
  for dominators; `succAll` keeps parallel edges so a shared target is correctly
  seen as a merge and emitted once ("block emitted twice" bug otherwise).

`uniquifyLabels(tree)` renames every `block`/`loop` frame to a globally unique
`L<n>` and rewrites `break`/`continue` to the nearest enclosing frame. This is
required because the exception layer composes several independent `structure()`
results (a try body nested inside a method), and each call numbers its labels
from its own block ids — nested composition can reuse the same `L<id>` at two
depths, which is a **Java compile error**. `uniquifyLabels` makes composition
safe.

## Region splitting (`../passes/regionSplit.js`)

Controlled node splitting (Janssen & Corporaal, "Making Graphs Reducible with
Controlled Node Splitting"): for a multi-entry strongly-connected region, clone
the region once per secondary entry so each clone has a single entry, making the
whole CFG reducible without changing semantics. Clones are byte-identical, share
exits, and only external jump predecessors are redirected.

Verified via ASM `BasicVerifier`: the transformed class is exactly as verifiable
as the input, and a CFG that made Vineflower crash becomes structurable
(`regression corpus` irreducibility 2→0, `steelsentinels` 7→0). Gated conservatively:
refuses on exception-range overlap, more than one non-redirectable entry, or a
region over the size cap.

**Important finding:** region-splitting is a tool *for our own structurer*, not
for CFR. Feeding split bytecode back through CFR makes CFR's output *worse*
(`regression corpus` 4→15 markers, `steelsentinels` 2→26) because CFR re-linearizes the
clones. So region-split is wired into the structurer path only, never into the
CFR-gated baseline.

## The try/catch layer (`exceptionStructurer.js`)

The base structurer models only normal edges. Modeling JVM exception edges
directly is a trap: every protected instruction has an edge to its handler, which
creates massive irreducible fan-in and defeats structuring. CFR's approach — which
we follow — is to treat try/catch as **recursive region structuring**: carve the
try body and each handler out as self-contained sub-CFGs, structure each
independently, and wrap the results in a `try` node, collapsing the whole group to
a single super-block in the enclosing CFG.

Design stance: **Tier-1 / conservative.** Anything the layer cannot carve cleanly
— multiple external exits, a range boundary that doesn't land on a block leader,
an irreducible sub-region, a shared handler, an ambiguous join — returns
`{ ok: false, reason }` so the caller falls back rather than emitting wrong Java.
**Graceful bail is a feature.** The design invariant is *never emit Java that
means something different from the bytecode.*

Phases:

- **Phase A — normalize** the raw exception table into try groups: drop
  self-handlers (`start_pc === handler_pc`), shrink body/handler overlap, group
  identical `(start_pc, end_pc)` rows into one try with N ordered catches, map a
  catch-all (`0`/`"any"`/`null`) to `java.lang.Throwable`.
- **Phase B — carve** innermost group first. The try body is the set of blocks
  whose leader pc ∈ `[start_pc, end_pc)`; handler regions come from a
  synthetic-root dominator tree over the method entry + all handler entries; the
  region's single external successor is the join. Structure each sub-region,
  wrap in `{ t: 'try', ... }`, collapse to a super-block.

### The `end_pc` mid-block leak (found by adversarial verification, fixed)

An independent adversarial verifier recomputed try/handler/merge membership from
scratch and found one real defect. Try-body membership is decided by a block's
*leader* pc, but the layer did not check that the block *ends* at or before
`end_pc`. When `end_pc` falls mid-block — javac's normal "success continuation"
tail after the last protected call — the trailing instructions at pc ≥ `end_pc`
were rendered **inside** `try { }` even though the JVM does not protect them.

- Harmless when the tail is pure no-throw glue (`return`/`goto`/`iinc`/constants/
  loads/stores/non-trapping arithmetic): the `try` is merely drawn slightly large.
- **Wrong Java** when the tail contains a throwing instruction
  (`getfield`/`putfield`/`idiv`/`irem`/`invoke*`): the throw would be caught, or
  routed to the wrong *nested* handler, instead of propagating. Traced to
  observable divergence on real methods (a swallowed exception returning `-1`; a
  nested `idiv`-by-zero routed to the inner `Throwable` handler instead of the
  outer `Exception` handler).

**Fix (Tier-1, consistent with the bail-don't-guess stance):** before carving,
if a *reachable* try-body block straddles `end_pc` and the straddling tail
contains any instruction that can throw a catchable exception (`canThrow`, the
complement of an explicit no-throw allowlist), bail with
`"protected range ends mid-block over a throwing instruction"`. The reachability
restriction matters: obfuscators leave unreachable `athrow` blocks whose leader
sits inside a protected range; the base structurer correctly omits them, so they
must not trigger a spurious bail. Verified corpus-wide (all 44 games): **zero
throwing-tail leaks remain among `ok` outputs**, down from the 18 methods the
verifier traced.

A universal "split the block at `end_pc`" fix was prototyped and rejected: when
`end_pc` points exactly at the try body's trailing `goto merge` (the overwhelming
common case), splitting it off makes the try body and handler exit to different
blocks, producing a spurious "more than one external exit" bail and collapsing
coverage. The targeted throwing-tail bail keeps all the harmless-tail coverage and
converts only the genuinely-wrong methods to honest bails. Lifting these into
real output is deferred future work ("exception-boundary block split").

### Exception-region loop exits must keep their destination

Each reconstructed region exit carries its original CFG destination and the
identity of the labeled region block it leaves. After nested trees are composed
and their labels renamed, the contract verifier checks that every exit still
resolves to that block. A `continue`, a missing destination or owner, and an
unidentified transfer into a region frame all fail the contract. Legacy
`regionExit` printer nodes likewise require an explicit enclosing loop label and
`break`/`continue` mode; lexical proximity to a loop is insufficient evidence.
An ordinary empty conditional arm remains a no-op.

When exception-region reconstruction or Java source-flow validation fails, the
CFG dispatcher retains the exception table. Three former large-method shortcuts
could instead reconstruct only normal edges or remove handlers from the
dispatcher. Method size cannot justify either transformation. A native JVM
regression demonstrated the loss: a caught exception that should retry the body
without repeating setup returned `1,1` in the original, but the decompiled large
method returned `NullPointerException,1`, both with automatic and forced
dispatch. Adding 1,100 no-ops must not change catch behavior. Those shortcuts are
removed; oversized supported methods use bounded helpers, while unsupported
shapes must fail visibly rather than discard exception semantics.

Focused validation (run with `NODE_PATH` pointing at installed dependencies):

```sh
node --test test/structurer.test.js test/exceptionStructurer.test.js test/cfrInvariantFanout.test.js test/cfrNestedLoopSplitting.test.js
```

All four files pass, including verified original-bytecode versus rebuilt-Java
execution for small and large catch retries, protected loop fanouts, and nested
exception cycles. This is a targeted control-flow regression gate, not proof of
whole-game behavioral equivalence. A fresh fixed-input GeoBlox export still has
303 Java files, zero hard failures, and three original-method CFG fallbacks.

## Bounded structured helpers for oversized static-void methods

The owned renderer now attempts `structuredMethodPartition.js` before choosing
an oversized CFG dispatcher. It outlines complete structured statements into
methods of a local `$CfrPartitionedBody` carrier. Original statement source bytes
are retained, with indentation adjusted to the helper scope. Shared JVM locals
and mutable parameters become fields; first stores become assignments rather
than declarations that shadow those fields. Original initializers run in source
order after parameters are copied. Void returns in helpers set `finished`, and
call sites propagate that return before executing subsequent statements.

Calls remain in their original protected scopes. Helpers declare the enclosing
catch alternatives and the original method's declared exceptions, preserving
checked-catch reachability. Transfers must resolve to labels/loops/switches
inside a complete outlined statement. Small transfers to an enclosing frame
stay at their original site between outlined runs. Catch-local scopes are not extracted
independently. Resource/finally scopes, unpromoted locals, unclosed transfers,
oversized individual statements and exhausted budgets decline extraction and
retain the typed, exception-preserving CFG fallback. There is no game or method
name gate. Constructors, instance methods, value returns and synchronized
regions retain the existing restrictions.

Library options are `structureOversizedMethods` (default enabled; `false`
selects the previous dispatcher representation) and
`structuredPartitionSourceBudget` (default 24,000 source characters, clamped at
that maximum). The budget is a conservative source-weight limit, not a formal
bytecode-size proof; native compilation remains the classfile-limit gate.
`runCfr.js` records `structuredMethodPartition` entries separately from fallback
diagnostics, including original method identity, helper count and shared locals.

`node test/cfrPartitionedLocals.test.js` compares verified original bytecode with
rebuilt Java across six native fixtures and 270 result/effect/exception comparisons: both dispatcher
coalescing modes, structured returns/shared arrays/mutable parameters, checked
catches across helpers, budget refusal and a nonlocal loop break retained at its
original scope. Every generated carrier method in
these fixtures is checked below 32 KiB of actual Code bytes. The initial red
test exposed carrier shadowing: all 45 executions in each dispatcher mode threw
`NullPointerException` before their first effect. The fixed representations
match the original result, effect count and exception outcome.

For fixed-input GeoBlox, `wi.a(BLrh;)V` now uses three structured helpers instead
of 18 dispatcher helpers and 756 cases. Native compilation measured their Code
sizes as 7,764, 7,925 and 6,671 bytes. The outer run method is 240 bytes and keeps
the runtime catch and post-load guard behavior. The unchanged original
transformed bytecode is not replaced by this source publication.

## Guarantees, verification, and what is *not* claimed

- **Guaranteed:** reducible CFG ⇒ goto-free structured tree (structurer);
  irreducible CFG ⇒ made reducible by region-split ⇒ goto-free. Verified: 443/443
  residual-marker methods structured with 0 gotos.
- **Guaranteed:** the try/catch layer never emits Java whose exception behavior
  differs from the bytecode — it bails instead. Verified: 0 throwing-tail leaks,
  0 dropped/duplicated blocks, catch count/type/order faithful, 0 goto in output,
  labels unique, across the whole corpus.
- **Not claimed:** prettiness. Labeled-break output has more `L<n>:` blocks than
  CFR's best-case output. It is goto-free and correct; peephole simplification of
  the label structure is future work.
- **Not claimed:** full try/catch coverage. Tier-1 bails on shared handlers,
  multi-exit try, mid-block boundaries, `finally`/synchronized, and multicatch.
  Each is an honest `{ ok: false, reason }`, and each is a candidate future
  increment (same-target row merging, exception-boundary block splitting, etc.).

## Tests

- `test/structurer.test.js` — loops, diamonds, switches, nested loops, merge
  blocks, irreducibility rejection.
- `test/regionSplit.test.js` — irreducibility removal, gates, clone identity.
- `test/exceptionStructurer.test.js` — single/multi/nested try, catch-all,
  loop-in-try, multi-exit bail, no-table passthrough, mid-block throwing-tail
  bail.

## Readable regions inside CFG dispatchers

When full structuring refuses a method, the fallback keeps its typed operand
carriers and explicit dispatcher. Its renderer now reduces dispatch scaffolding
without changing the bytecode, evaluating operations differently, or weakening
`assertNoFallback`.

It combines straight-line `goto`/fallthrough states only when the successor has
one normal predecessor and is neither a method entry nor an exception-handler
entry. The ordered handler types and resolved handler targets must agree. Each
original block retains a separate Java scope, allowing repeated temporary names.

It then nests forward, single-entry branch regions inside ordinary `if` and
`switch` bodies. Incoming **edges** are counted, so repeated switch targets are
shared entries rather than duplicate inline bodies. Shared joins, backedges,
handler entries and differing handler regions keep explicit dispatcher states.
Nesting stops at four levels or a conservative 12,000-unit source-weight budget;
this leaves bounded cases for the existing oversized-method partitioner.

Nesting also needs a scope proof. The owned Java statement parser examines the
parent block. Local declarations, formal parameters, local classes, unsupported
nodes or parse failures prevent branch nesting. Otherwise moving a child under
a parent could silently bind its field access to a parent's local variable.
Generated block comments record original CFG block IDs for traceability.

The default is enabled. For comparison, use
`CFR_JS_COALESCE_STATE_MACHINE_CHAINS=0`, or pass
`coalesceStateMachineChains: false` to `decompileClassFile`. This gate controls
both straight-line coalescing and branch nesting. Fallback diagnostics include
`dispatchStatesBefore` and `dispatchStatesAfter`, including methods subsequently
split into local-class helpers.

### GeoBlox result and limits

Re-decompiling the same 303 verified transformed classes reduces emitted
numeric `switch (statePc)` cases from **3,051 to 1,330**. The 19 original fallback
methods remain; partitioning their largest method produces 18 helpers instead of
23. Gameplay update drops from 252 to 107 cases, gameplay rendering from 115 to
65, and board-entity reconciliation from 120 to 60. All 303 generated files
compile with `javac --release 8 -proc:none` and the frozen FunOrb stubs.

Straight-line coalescing alone reduced the total by only 59 cases. Single-entry
branch nesting produced the larger improvement. This is a source readability
change; it does not establish complete game equivalence or improve browser FPS.
Shared joins and loops still require dispatcher recovery in a future pass.

`node test/cfrStateMachineReadability.test.js` checks enabled and disabled
renderings against expected JVM results, and a native-compiled original against
both forced fallback variants. Its 11 checks cover duplicate local scopes,
shared joins, loops and effect order, switch arms and duplicate targets, field
shadowing refusals, handler boundaries/entries, bounded case weight, exception
and finally behavior, and oversized-method diagnostic retention.

Existing fixture suites require their repository-native inputs:

```sh
node scripts/compileJava.js sources/TryWithResourcesTest.java sources/PyramidApplet.java --out sources --no-progress
node test/cfrFixtures.test.js
node test/cfrStructuredFeatures.test.js
node test/cfrAdditionalFeatures.test.js
node test/cfrStackOrdering.test.js
```

The recorded results are respectively 36, 26, 77 and 38 passing assertions.
In the restricted verification environment, the last suite's child processes
used a temporary regular-file stdio adapter; its test and compiler code were
unchanged. Building the fixture inputs with host javac instead produced seven
existing shape-test failures, also present with coalescing disabled. The native
fixture build resolved them. `cfrObfuscationGuards.test.js` was skipped because
its external Krakatau binary was absent; it is not recorded as validated.

## Invariant loop fanouts without exception regions

The invariant-condition safeguard described in `cfr.js` protects exception
region collapse: two loop exits can become one continuation when separately
structured regions are combined. It previously applied to every method with
this latch shape, including handler-free methods. Those methods use the base
CFG structurer directly and can retain the original paths as labeled loops.
The safeguard now requires a nonempty effective exception table. The multi-value
operand-stack safeguard, synchronized-region rules, and source-flow validation
are unchanged; a failed structured rendering still falls back.

`node test/cfrInvariantFanout.test.js` runs four fixture variants against their
original, verified JVM bytecode and forced-dispatcher output. The variants
combine reversed latch conditions with absent/present exception protection.
Each variant checks 48 input combinations: four flag values, four loop sizes,
and null/full/short copy arrays. Protected variants must retain the safeguard;
handler-free variants must avoid dispatchers. Outputs and exception types agree
across the original and both reconstructed versions (384 differential checks).
The version-49 assembly fixture executes with verification enabled; this avoids
requiring StackMapTable frames from the fixture assembler.

On the same GeoBlox transformed classes, gameplay update, gameplay rendering
and scene transition now use labeled loops instead of dispatchers. Update
shrinks from roughly 2,000 to 770 source lines, and rendering from 941 to 426.
Total emitted dispatcher cases fall from 1,330 to 1,131; original fallback
methods fall from 19 to 16. Three original methods retain at least 50 cases:
`c.h(B)V` (58), `kc.b(I)V` (60) and partitioned `wi.a(BLrh;)V` (756).

The first remains behind the exception-region safeguard. The second's induced
exception subgraph still has three non-dominating retreating edges after the
current controlled split. Repeating that splitter makes no change: it handles
secondary entries of maximal strongly connected components, while this shape
requires examining nested cycles. A future fix needs dominance-aware nested
region splitting and exception/differential tests, rather than more identical
retries. The third has 9,499 normalized code items and triggers the generic
oversized static-void partitioner; removing that size gate does not prove its
Java output fits the 64 KiB method limit.

The four new differential tests, 11 dispatcher-readability checks, and existing
36 fixture, 26 structured-feature, 77 additional-feature and 38 stack-ordering
assertions pass. All 303 GeoBlox sources compile. This proves the focused latch
fixtures and export compilation, not complete game runtime equivalence.

## Explicit exception-region exits

Exception-region composition now records an exit contract for each collapsed
region. Every external sink retains its original working-CFG target ID and the
owning region ID. Its transfer is an explicit `break` to a labeled region
block, including when the sink itself has no statements. These IDs survive
block remapping, substitution and label uniquification. Before printing, the
contract verifier requires every enumerated target to be present and every
transfer to resolve to the matching region block, never an unrelated loop.
This checks exit identity and lexical ownership; it is not a proof of complete
expression reconstruction or whole-program equivalence.

Two unsafe shortcuts are removed or refused:

- An empty ordinary `if` arm is a no-op. The printer no longer turns it into a
  break from the nearest loop. Printer cleanup returns fresh composite nodes,
  so printing a tree twice cannot turn a previously removed fall-through break
  into a newly inferred loop exit.
- A catch continuation into the middle of a try body, or a normal jump into a
  handler component, cannot be mapped to the collapsed region entry. That would
  rerun setup or enter the wrong component. Such reentry now declines structured
  recovery and retains the CFG fallback. A retry at the actual try entry can
  still be represented by the enclosing loop.

The invariant-loop fanout safeguard permits protected methods to remain
structured only when their composed exit contracts verify. Other safeguards
and Java source-flow checks remain active. The compatibility printer node
`regionExit` still exists for explicit legacy trees; the exception-region layer
uses labeled transfers with contracts, not that nearest-loop shorthand.

Exit contracts now bind each synthetic sink ID to its original destination,
rather than checking destinations only as a set. The composed tree must retain
the sink immediately before its matching transfer, including an empty sink in
a single-exit region. Missing sinks, reordered transfers, exchanged
destinations, duplicate sink IDs, and destination-only legacy contracts are
refused. This adds a check of sink-to-transfer identity; it does not prove the
whole collapsed CFG or expression reconstruction equivalent.

Explicit legacy `regionExit` nodes also participate in label uniquification.
Both that pass and the printer resolve the nearest matching lexical frame,
including blocks, and require it to be a loop. A block shadowing a loop label
cannot turn an intended loop exit into a block exit. Ordinary `continue` nodes
targeting a block are refused during uniquification as well.

`test/cfrExceptionLoopExits.test.js` compiles a nested-loop Java fixture, then
compares the original JVM execution with both structured and forced-dispatcher
reconstruction. Its 252 inputs cover normal exits, inner and outer loop breaks
and continues from try and catch bodies, effect order, and exceptions in
unprotected continuations. Both reconstructions must match all results and
effect traces (504 comparisons). The original and rebuilt classes run with the
JVM verifier enabled.

Focused commands for this additional validation:

```sh
node test/structurer.test.js                 # 13 checks
node test/exceptionStructurer.test.js        # 20 checks
node test/cfrExceptionLoopExits.test.js      # 504 native behavior comparisons
```

A fresh export from the unchanged transformed GeoBlox class tree retains all
303 Java files byte for byte, and the diagnostics JSON is unchanged. The Java
tree SHA-256 remains
`2b5e8eca76820cb18760a231fc0825aded6e26972d646bfc3476d4f88d77147b`.
All 303 sources compile together against the pinned FunOrb stubs. The published
source and naming pins remain valid; these extra checks do not recover another
dispatcher or claim complete game runtime equivalence.

Focused validation:

```sh
node test/structurer.test.js                 # 10 checks
node test/exceptionStructurer.test.js        # 16 checks
node test/cfrInvariantFanout.test.js          # 10 JVM/regression tests
node --test test/structurer.test.js test/exceptionStructurer.test.js test/cfrStateMachineReadability.test.js test/cfrFixtures.test.js test/cfrStructuredFeatures.test.js test/cfrAdditionalFeatures.test.js test/cfrStackOrdering.test.js test/cfrCatchSemanticsRegressions.test.js
```

The ten JVM/regression tests include eight fanout variants (unprotected,
combined protection, separate catches with different continuations, and
multiple protected exits around an unprotected return, with both latch
polarities). Each compares 48 inputs against original verified bytecode and
both structured and forced-dispatcher output: 768 differential comparisons.
An executable no-op-arm test checks all loop iterations continue. Another
executes a catch that resumes after setup: the refused structured shape uses
its exact CFG and setup runs once, matching the original JVM. The grouped
regression command passes all eight files. As before, installed dependencies
and the temporary regular-file subprocess adapter were used in the restricted
environment; fixture sources use the repository-native compiler.

A fresh export of the unchanged 303 GeoBlox transformed classes emits zero
hard failures; all generated sources compile against the frozen stubs. Original
fallback methods fall from 16 to four and dispatcher cases from 1,131 to 877.
Generated methods containing dispatchers fall from 33 to 21. In particular,
`c.h(B)V` (`GameScreen.updateScreen`) is structured with its RuntimeException
catch intact. Two original methods still contain at least 50 dispatcher cases:
`kc.b(I)V` (60) and partitioned `wi.a(BLrh;)V` (756 across 18 helpers).
The other two fallbacks, `gh.f(I)V` (27) and `n.a(IIIIBIIII)[Ldm;` (34), retain
multi-value operand-stack safeguards. Nested-cycle splitting and bounded
structured helpers remain separate future work. These results validate the
focused fixtures and export integrity, not whole-game or browser performance.

## Splitting nested exception cycles

A maximal SCC can have one dominating entry while a cycle inside it has several
entries. The previous induced-region splitter saw only maximal SCCs, returned
no change, then tried one target-block copy. On `kc.b(I)V`, that extra block left
three non-dominating retreating edges. Retrying the same splitter did not help.

The splitter now traverses nested SCCs. For a component with one entry, it checks
that the entry dominates every member, removes that header from the induced
search graph and examines the child cycles. A component with several entries is
copied for one secondary entry: internal edges point to matching copies, external
exits retain their targets, and only external predecessors of that entry are
redirected. Every copy retains its original block identity. The search uses
reachable predecessors and stable numeric ordering; unreachable edges cannot
manufacture entries. Both SCC traversal and nested search use explicit work
stacks rather than JavaScript recursion.

Splitting is bounded to 64 copies of regions and, by default, at most
`min(8192, max(originalTerms * 4, originalTerms + 64))` terms. Callers can provide
`maxTerms` and `maxRounds`. An exhausted budget returns no partial result; the
exception layer retains its CFG fallback. The former unbudgeted one-block
retry is removed. The shared JVM SSA consumer retains its own smaller block cap.

The recorded board-entity subgraph becomes reducible after three region copies,
adding 18 blocks to its 119 original blocks. A fresh 303-class export changes
only `kc.java`. `kc.b(I)V` now uses loops and labeled blocks with its original
runtime catch. Fallbacks drop from four to three, and numeric dispatcher cases
from 877 to 817. The oversized initializer is the only remaining original
method with at least 50 cases. Other stack and method-size safeguards remain.

```sh
node test/exceptionRegionSplitting.test.js # 4 checks, including 512 routed traces
node test/cfrNestedLoopSplitting.test.js   # 3 verified JVM fixtures, 840 comparisons
```

The graph checks cover nested-cycle recovery, deterministic origin mapping,
input immutability, exact budget refusal, switch defaults and duplicate targets,
unreachable predecessors and a 5,000-node reducible cycle. The JVM fixtures cover
both branch polarities and a switch with repeated targets. They compare 140
flag/loop-limit/throw-point inputs per fixture against original version-49
verified bytecode and both structured and forced-dispatcher output. Side effects
encode their order, and thrown exceptions retain the catch result. All three
structured outputs must retain their catch and contain no dispatcher.

The nine existing decompiler regression files, including the ten invariant-loop
JVM tests, pass with the same restricted-environment stdio adapter used above.
The existing shared JVM SSA splitting test also passes all 14 assertions when
selected alone with a temporary tape filter; the generated JRE index was rebuilt
first. All 303 regenerated sources compile. These checks establish focused
splitting behavior and export integrity, not whole-game runtime equivalence.

## String builders crossing exception and branch joins

Concatenation recovery requires the complete append history of a freshly
constructed builder. An existing builder parameter, local alias or operand-stack
carrier can already contain text. Appending to such a receiver preserves the
actual `append(...).toString()` calls instead of treating its new suffix as the
whole string. This also preserves mutation of the existing builder and the
original invoked overload, including `append(char)` in exception contexts.

```sh
node test/cfrStringBuilderJoins.test.js
```

Both verified native fixtures compare seven outputs against original bytecode,
using structured and forced-dispatcher reconstruction. They cover prefixes
carried over branch joins, the same pattern in a runtime catch, and repeated
mutations of a caller-owned builder. Known complete inline chains still become
concatenations and are checked by `test/cfrAdditionalFeatures.test.js`.
