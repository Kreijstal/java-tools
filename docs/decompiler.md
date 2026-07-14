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
(`orbdefence` irreducibility 2→0, `steelsentinels` 7→0). Gated conservatively:
refuses on exception-range overlap, more than one non-redirectable entry, or a
region over the size cap.

**Important finding:** region-splitting is a tool *for our own structurer*, not
for CFR. Feeding split bytecode back through CFR makes CFR's output *worse*
(`orbdefence` 4→15 markers, `steelsentinels` 2→26) because CFR re-linearizes the
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
