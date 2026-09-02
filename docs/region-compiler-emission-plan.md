# Region compiler: from text recovery to emission

`src/jit/HotCallGraphRegionCompiler.js` composes a hot call-graph region out of
the per-method JavaScript that `src/jit/JvmSsaBlockRenderer.js` publishes on
`generated.*`. It used to recover the structure of that JavaScript by re-parsing
it with `acorn` and splicing byte ranges (`applySourceEdits`), plus a handful of
regular expressions over generated text. One `parse()` call is left (§6).

That violated the compiler-pass rule the repository works to:

> The JIT emits JavaScript source text. It must not re-parse or regex-match the
> JavaScript it has already generated. Analysis and transformation happen on the
> compiler's own representation *before* the text is emitted; emission is the
> last step. Late-bound compiler-owned tokens expanded by exact identity are
> acceptable; parsing generated JS with acorn and applying source edits is not.

Commit `741c9b1` ("Insert checked leaves lexically by declaration, not by text
rewriting") is the model: the renderer renders once into a form that is valid
both standalone and inserted, publishes the *fragments* and the *names* it used,
and the consumer assembles rather than rewrites.

## 1. Inventory of text-recovery sites

Line numbers are as of `master` (`bc9fe15` era, region compiler at 3514 lines).

| # | Site | What it recovers from text | Where the renderer has it |
|---|------|----------------------------|---------------------------|
| 1 | `applySourceEdits` (L70) | — (shared byte-splice engine for 2,3,4,6,8,9,10) | n/a; **gone** with its last caller |
| 2 | `removeUnusedRegionBindings` (L127; `parse` L132, edits L245) | which renderer-published call bindings (`ssaCallSite<i>`, `ssaFastPositional*<i>`, `ssaLateLinkPositional<i>`) are still referenced after lowering, and their pure-initializer dependency chain | the region compiler itself decides which bindings it links; the renderer knows each binding's declaration text and kind. **Do not emit** instead of parse-and-delete. |
| 3 | `inlineAtomicPositionalSource` — **gone** (§6) | callee parameter binding, local declarations, `return` statements, label set of an atomic positional body, in order to alpha-rename and splice it into a caller | the renderer publishes `jvmInternalRegionPositionalInsertion` and `jvmRestoringDirectPositionalInsertion`: the same body with its exits routed to a result token and an exit label, plus an `assemble` that binds the parameters by declaration. |
| 4 | `removeUnreachableRegionFunctions` (L396; `parse` L399, edits L429) — **gone** (stage E) | the call graph among the module's own `jvmRegionNode<i>` / helper functions, to drop unreachable ones | the region compiler *builds* `declarations` itself and knows every function name it emitted and every name it linked. This is a data-level reachability walk over its own emission list. |
| 5 | `splitModuleSourceForFactoryHoist` (L454; `parse` L457, slice L489) — **gone** (stage E) | top-level function-declaration boundaries in the assembled module | the region compiler assembled that module from a `declarations` array; keep the array, emit two texts. |
| 6 | `outlineLargeRegionLoops` (L507; `parse` L549, edits L713/L758) — **gone** (stage F) | loop statements, their byte size, and their free variables, to outline them into helper functions | needs renderer-published statement/loop fragment boundaries with free-variable sets (see §4). |
| 7 | `collectOversizedUnits` (L830) — **gone** (stage F) | AST consumer of #9's parse | as #9 |
| 8 | `liftOversizedUnitLocalsToEnvironment` (L876; `parse` L883, edits L1009) — **gone** (stage F) | function-scoped `let/const` declarations and all their reference sites, to move them into an environment array | the renderer owns every local name it emits (`local<slot>`, `ssaValue<n>`, call bindings). It can publish the *name set* per unit and, better, render local access through a late-bound accessor token so lifting is a choice of expansion, not a rewrite. |
| 9 | `partitionOversizedLinearBlocks` (L1014) — **gone** (stages C, D, F) | statement boundaries of oversized linear runs and the live names crossing them; whether a statement is a `yield`; where the directive prologue ends | statement-level fragment boundaries + free variables (§4). The `yield` regex and the directive regex are removable now (see §2, stage D). |
| 10 | `rewriteCallBindings` (L1947; `parse` L1960, AST index L2030–L2110, slices L2182/L2192/L2270/L2305/L2334, edit application L2436) | per call site: the marker span, the raw-invoke `CallExpression` and its argument texts, the assignment target (`out`), the innermost `try` around the call with its `catch` parameter and its restoring `else`-block, the `let <out>;` declaration statement, the `thread.callStack.items.length` depth declaration, the binding `VariableDeclarator` initializers, and the trailing `true` literal of unlowered raw calls | **all of it.** The renderer emits every one of those strings; it only fails to publish them. |
| 11 | `let safePointBudget = N;` regex on `outlined.source` (L2813) | the renderer's exact per-method safe-point budget declaration, so the fused module can own one counter | the renderer knows the declaration text it emitted; publish it and remove by exact identity, or publish a variant without it. |

Not violations (kept): `plan.root.key.replace(/[^A-Za-z0-9._-]/g,"_")` (L3041) and
`namespace.replace(...)` (L880/L1025) sanitize *identifiers the compiler owns*,
not generated JavaScript.

## 2. Staged plan

Each stage leaves `node scripts/run-tests.js` green on its own.

### Stage A — call-site linking becomes data (site 10)

The renderer gains, per call site with a real `syncCallSite` id, a
`regionLowering` record published inside `generated.jvmStructuredRegionCallSites`:

```
regionLowering: {
  resultName, resultDeclaration,   // `out`, `let out;`
  depthName,                       // the call's `thread.callStack.items.length` snapshot
  rawCallPrefix,                   // `<rawInvoke>(helpers, `
  rawCallSuffix, nestedRawCallSuffix,   // `thread, true)` / `thread, 2)`
  operandTokens: ["/*__JVM_CALL_ARG_<pc>_0__*/", …],
  fastCall: { caught, restoreMarkers, handlerMarkers } | null,
}
```

plus `generated.jvmStructuredRegionCallBindingDeclarations`, mapping each binding
name to the exact declaration text(s) and kind (`let`/`const`) the renderer
emitted for it in each positional variant, and
`generated.jvmStructuredRegionRunCounterStatements`, the exact
`helpers.structuredSsa.*RunCount += 1;` statements an internal node drops.

`rewriteCallBindings` then does no parsing. It locates the compiler-owned
`/*__JVM_REGION_CALL_START_<pc>__*/` … `/*__JVM_REGION_CALL_END_<pc>__*/` span by
exact identity and takes every other fact from tokens the call itself emitted.
Selecting the *linked* form of a call is a choice between published forms, not a
search for a call expression.

**Why the record is tokens and not finished strings.** The first attempt
published the operand list, the restoring arm and the catch body as the strings
the call was emitted from. That is wrong, and the tests said so: the renderer
runs *line-level* passes over its own output after emission — the SSA alias
coalescer at ~5030-5200 and, for the restoring and checked-leaf tiers, the
regex peephole `compactCheckedLeafLines` (~10070-10460, which substitutes
immutable local aliases, inlines one-use pure snapshots and folds local
self-updates). A `ssaValue7` captured at emission may be `local0` — or an
inlined expression — in the body finally published. Only names that are never
rewritten (the result, the depth snapshot, the catch parameter, the call
bindings) can be published as text. Everything the peephole may rewrite is
instead *delimited* in the emitted call, so the region reads the operand and the
two exception arms out of whichever specialized body carries them:

* one `/*__JVM_CALL_ARG_<pc>_<n>__*/` token in front of each operand inside the
  raw invocation;
* `/*__JVM_CALL_HANDLER_START_<pc>__*/` … `_END_` around the fast-call catch body;
* `/*__JVM_CALL_RESTORE_START_<pc>__*/` … `_END_` around its call-pc restoring arm
  (an optional argument of `materializeCallExceptionLines`).

This is the same idiom as the region call markers themselves, and the same one
`specializeSelfRecursiveCalls` already uses: exact identity on a token the
compiler emitted. Those line-level renderer passes are themselves a much larger
instance of the problem this document is about; a later pass that moved them
onto the structured representation would let these delimiters be dropped again
in favour of a plain published operand list.

Conservatism: when a call's tokens are not present in the variant being composed
(a body a later pass specialized away, such as a self-recursive direct call),
the edge is simply not lowered — exactly the `if (!rawCall) continue` outcome the
AST version already had. Correctness never depends on the lookup succeeding; the
final `replaced.has(rawInvoke)` check still rejects a module that could not be
linked, and the ordinary tier remains the fallback.

### Stage B — unused bindings are not emitted (site 2)

`removeUnusedRegionBindings` parsed the *result* to discover that a binding had
become dead. After stage A the compiler already knows precisely which bindings it
eliminated (`eliminatedBindingNames`) and which declaration text belongs to each,
so the binding is simply not emitted: the published declaration is replaced by
nothing rather than by a rewritten initializer. The DCE parse and its
`pureGeneratedExpression` purity predicate are gone.

The reference walk it replaced existed to catch the one out-of-span reader of a
call binding, the loop-invariant raw target declared in the prologue. The
renderer now publishes those sites as
`generated.jvmStructuredRegionInvariantPositionalCallIndices`, and they keep
their bindings; so does a call span the renderer emitted more than once, since
an unlowered copy still reads them. Both conditions fail safe: the binding
survives as a dead declaration — a missed size win, never an unbound name.

### Stage C — no directive regex, no `safePointBudget` regex (sites 9, 11)

* The `'use strict';` prologue is *prepended by the region compiler itself*, so
  it now assembles the module body without it, runs the source passes, and
  attaches the directive at the end. `partitionOversizedLinearBlocks` takes an
  `options.directive` naming the prologue its caller prefixed (the renderer's
  own call passes `"'use strict';\n"`), slices it off before partitioning and
  re-attaches it after, instead of locating a directive with
  `/^(['"]use strict['"];\n?)/`.
* The renderer publishes `generated.jvmStructuredSafePointBudgetDeclarations`,
  the exact declaration strings it emitted for each positional variant (three
  distinct budgets: the entry budget, the direct/internal budget, and the
  restoring budget). The fused module removes them by exact identity instead of
  matching `/let safePointBudget = \d+;/`, so every node closes over the one
  module-owned counter.

### Stage D — `yield` regex (site 9) — landed, **interim**

`partitionOversizedLinearBlocks` replaced `yield` with `void ` in an analysis
copy so acorn would accept a generator *body* as a program. It now parses
`function* __jvmRegionUnit() { … }` — the prefix idiom sites 2, 3 and 10 already
used — and rebases the resulting offsets onto the untouched emitted source with
`rebaseAstOffsets`, so nothing downstream sees the wrapper. The
`slice(node.start, +5) === "yield"` probe goes away with it: real
`YieldExpression` nodes now reach the audit, which is what the probe stood in
for.

The regex was not merely inelegant. It cannot tell the keyword from the same
five characters used as a property name, so a body containing `{yield: 3}` or
`names.yield` was analysed as a *different program* than the one being
rewritten. `test/hotCallGraphLinearPartition.test.js`
("a \"yield\" inside a string is not mistaken for a keyword") drives exactly that
shape and diverges from the original generator under the old pass.

**This stage was interim** and is now finished: stage F moved the pass onto
§4's fragments, and `GENERATOR_UNIT_PREFIX`, `rebaseAstOffsets` and the parse
itself are gone. A unit is a generator because its *caller* says so, not
because a wrapper made acorn accept it, and a run carries a yield because the
statements in it say so.

### Stage E — module-level structure (sites 4, 5) — landed

`compileModule` now builds `declarations` as
`{name, kind, references, text}[]` instead of a flat string list, and both
module-level passes became list operations over that plan. No renderer change
was required.

**Reachability.** `removeUnreachableRegionFunctions` is replaced by
`pruneUnreachableRegionDeclarations(declarations, roots)`. The references come
from emission, not from text:

* `rewriteCallBindings` records every region function name it links —
  the surviving `const <rawInvoke> = jvmRegionNode<i>;` binding, the compact
  internal direct call, and the unlowered direct-call fallback — and returns it
  as `linkedFunctionNames`.
* A composed body (`composedInternalSources`) or an exceptional-inline body
  embeds its callees' text, so its set is the union of what it linked and what
  each embedded body linked; `composedInternalLinkedNames` and
  `exceptionalInlineLinkedNames` carry that union through the composition fixed
  point.
* Loop outlining moves statements out of a node's body into helpers emitted
  beside it, so a node and its helpers are one declaration entry and share one
  reference set. Nothing has to ask what an outlined loop calls.

The set may over-approximate (an inline candidate that was rejected still
contributes its callee's names). That direction is safe by construction: it
retains a declaration that could have been dropped; it never unbinds a name.
Pruning now runs *before* the lift and partition passes, so a dead declaration
is no longer lifted, partitioned and then deleted from the result.

**Factory hoist.** The module is assembled from three regions the compiler owns:
the per-entry prologue (`let safePointBudget = N;`), the declaration region, and
the entry statements. Only the declaration region is handed to
`liftOversizedUnitLocalsToEnvironment` and `partitionOversizedLinearBlocks`, so
the split is a choice between two assembled texts;
`splitRegionModuleForFactoryHoist(plan)` replaces
`splitModuleSourceForFactoryHoist(moduleSource)` and parses nothing.

The hoist aborts when the entry statements declare a binding, because a
declaration evaluated once in the factory cannot close over a binding recreated
on every entry. The module-owned safe-point counter that stage C introduced is
exactly such a binding and every node function reads it, so **an emitted region
module does not factory-hoist today** — and did not before this change either:
the parse-based splitter aborted on the same top-level `let`, which means
`JVM_ENABLE_HOT_CALL_GRAPH_FACTORY_HOIST=1` has been a no-op for real modules
(verified directly on an emitted module shape). The predicate is kept structural
rather than deleted so that removing the module-scoped counter re-enables the
hoist without reintroducing a parse.

**Generated-text differences.** The partitioner's
`const jvmRegionSegmentState0 = [];` prepend now lands after `let
safePointBudget` instead of before it (both precede every use, and the node
functions hoist), and unreachable node functions are absent from the source the
partition pass sees rather than deleted from its output.

### Stage F — inlining, outlining, partitioning, env-lift (sites 3, 6, 8, 9)

All four landed. Site 3 is the insertion contract §6 records; sites 6, 8 and 9
are selections and rewrites over the statement records §4 publishes. The
region compiler no longer calls `parse` at all.

**What each site became.**

* Site 3 — `inlineAtomicPositionalSource` is gone; §6 records the insertion
  contract that replaced it.
* `outlineLargeRegionLoops(unit, options)` takes a unit -- a header, a
  statement list and a footer the compiler owns -- and returns the rewritten
  unit plus the helper units it created. A candidate is a loop the renderer
  cut as its own fragment; its live-in set is the names its statements
  recorded as reads, its live-out set the names they recorded as writes, and
  every `return` it carries is re-established from the split the statement
  published around its own keyword. Innermost-first selection and the
  `jvmRegionOutlinedState<n>` protocol are unchanged.
* `liftOversizedUnitLocalsToEnvironment(units, options)` lifts the names
  §4's `jvmStructuredRegionLocalNames` declares once at a unit's top level.
  A reference is rewritten by substituting the operand in the statement's own
  parts list and rendering it again -- `rerenderStatement` performed by the
  consumer -- so the shorthand-property expansion the AST version needed has
  no analogue: the operand model cannot express a shorthand property, and a
  fixture that contains one is declined.
* `partitionOversizedLinearBlocks(units, options)` walks a unit's statement
  groups, where a group is a statement and everything up to its matching
  close, computed from the nesting deltas the emitters recorded. Runs are
  maximal consecutive groups; an oversized group recurses into the statement
  lists it owns, split at the block continuations (`} else {`) it contains.
  The `jvmRegionSegmentState<n>` protocol, the outward-jump table and the
  run-declaration hoist are unchanged; a jump is spliced between the parts the
  statement published around its own `break`/`continue`.

**How fragments survive composition.** Option (b): the statement list travels
alongside the source and is kept in step by construction.
`rewriteCallBindings` returns the edits it applied, and
`applyRegionStatementEdits` maps them onto the records -- a statement an edit
rewrote, and every statement a multi-line edit spanned, become one opaque
record whose names are unknown, so nothing containing it is relocated; an edit
that empties a statement leaves an empty record. A merged record keeps the
nesting delta of what it replaced, which holds because a lowered call span and
its replacement are both complete constructs; if it ever stopped holding the
deltas would not balance and `statementGroups` declines the body rather than
mis-grouping it. Composed bodies (`composedInternalStatements`,
`exceptionalInlineStatements`) carry their records through the composition
fixed point the same way.

**`compileModule` owns units.** A declaration entry is no longer a text blob
but the units it is emitted from, so pruning, the factory-hoist split,
lifting and partitioning are all list operations and the module text is
rendered once, at the end.

**What a pass now declines.** A region is extracted only when every statement
in it is relocatable. A statement is not, when it opens a `switch`, carries a
nested function, mentions `this`/`super`/`await`/`arguments`/`eval`/`var`,
declares an ambient name, carries both a `return` and a jump, carries more
than one of either, or is the opaque record a composition edit produced. The
AST version accepted a few of these and handled them explicitly; the loss is
measured in §3.

**Sources without records.** `jvmHotCallGraphFramedSource` and the checked-leaf
variants are not among the three positional variants §4 publishes, so a node
emitted from one of them is emitted as finished text and no structural pass
touches it. Two consequences, both measured:

* `JVM_ENABLE_HOT_CALL_GRAPH_FRAMED_PARTITION=1` is a no-op on a real module:
  its unit is the framed root, which has no records. It was not a no-op
  before.
* The renderer's own two calls (the continuation tier's loop outlining and
  linear partitioning, `JVM_ENABLE_STRUCTURED_LOOP_OUTLINING` and
  `JVM_ENABLE_STRUCTURED_LINEAR_PARTITION`) stay wired but are inert: the
  canonical body's prologue still carries lines no emitter recorded -- the
  entry scaffold, the local declarations, the spill helper and the frame
  materialization helpers -- so `regionFragmentsOf` declines it. Recording
  those emitters lights both back up with no further change here.

## 3. Status

* Stage A — landed. `rewriteCallBindings` no longer calls `parse`, walks an AST,
  or caches an AST index; `callBindingParseCount` is asserted to stay at zero.
* Stage B — landed. `removeUnusedRegionBindings` and `pureGeneratedExpression`
  are deleted.
* Stage C — landed. The `'use strict'` and `safePointBudget` regexes are gone.
* Stage D — landed, and no longer interim: the `yield`→`void ` regex, the
  `slice(node.start, +5) === "yield"` probe, the generator-declaration wrapper
  and the offset rebase are all gone with stage F.
* Stage E — landed. `removeUnreachableRegionFunctions` and
  `splitModuleSourceForFactoryHoist` are deleted; module reachability and the
  factory-hoist split are list operations over `compileModule`'s own
  `{name, kind, references, text}` emission plan.
* Stage F, renderer half — landed. The renderer runs no line-level text pass
  any more: every statement it emits is recorded as a parts list (§5), the
  optimizations run over those records, and §4's fragments are published.
* Stage F, site 3 — landed. `inlineAtomicPositionalSource` is deleted. The
  renderer publishes an insertable form of both bodies a region inserts and the
  region compiler assembles it; §6 records the contract that shipped.
* Stage F, the rest of the region-compiler half — landed. Sites 6, 8 and 9 are
  selections and rewrites over §4's records; `compileModule` assembles the
  module from units it owns.

**No regex over generated JavaScript remains in
`HotCallGraphRegionCompiler.js`.** The two `replace(/[^A-Za-z0-9…]/g, …)` calls
that are left sanitize compiler-owned identifiers and file names, not generated
JavaScript.

**No `parse()` call remains**, down from six, and the `acorn` import is gone
with them. `applySourceEdits`, `walkAst`, `identifierIsPropertyName`,
`collectPatternNames`, `GENERATOR_UNIT_PREFIX`, `rebaseAstOffsets`,
`collectOversizedUnits` and the module-level
`childrenOf`/`isFunction`/`isLoop`/`jumpLabelIdentifier` helpers are all
deleted: nothing in the file reads generated JavaScript any more.

**Two defects the move exposed**, both in the published contract rather than
in the passes:

* A fragment's `writes` came from each statement's operand target, so it
  missed the ambient names a statement assigns -- `frame`, `locals` and
  `stack` through the frame materialization's destructuring target, and
  `safePointBudget` through its own decrements. An outlined loop received
  those as parameters and never wrote them back. The renderer publishes them
  now, and `structuredRegionFragments.test.js` cross-checks every fragment's
  published name sets against an acorn reading of its own text.
* The outliner's shared `jvmRegionOutlinedState<n>` array is declared inside
  the body, so an outer loop enclosing an earlier helper's call site has to
  receive it; it was filtered out of the live-in set. The nested-outlining
  case in `hotCallGraphLinearPartition.test.js` pins it.

**Measured effect on emitted text.** Dumping every region module the two
`hotCallGraph` test files compile, on `e956619` and on this branch: 27 of 28
modules are byte-identical. The one that differs is the loop-outlining
corpus, and it differs in four ways, all benign: the positional live-in and
live-out orders differ (declaration and call site agree), the literal
`undefined` is no longer passed as a parameter (the AST pass treated it as a
free identifier), the outlined loop's first line keeps its own indentation,
and the live-out *sets* are identical only after the ambient-write fix above.

**Where the passes no longer fire.** `jvmHotCallGraphFramedSource` and the
checked-leaf variants are not among the three positional variants §4
publishes, so a node emitted from one carries no records and no structural
pass touches it. `JVM_ENABLE_HOT_CALL_GRAPH_FRAMED_PARTITION=1` is therefore
a no-op on a real module, where it was not before. Measured: over
`hotCallGraphRegion.test.js` + `jitCompiler.test.js` with that flag and
`JVM_ENABLE_HOT_CALL_GRAPH_LINEAR_PARTITION=1`, and again with the smallest
budgets the options accept (16 KB units, 4 KB segments), `e956619` lifts 0
names and cuts 0 segments in all 12 module compiles -- exactly what this
branch does. The loss is real for a framed root larger than the unit budget
and unobservable in the corpora.

## 4. What the renderer publishes for stage F

`generated.jvmStructuredRegionFragments` and
`generated.jvmStructuredRegionLocalNames` are published next to the existing
`generated.jvmHotCallGraph*` assignments:

```
generated.jvmStructuredRegionFragments = {
  <variantName>: [
    { id, kind: "linear" | "loop" | "try" | "declaration",
      lines: string[],
      declares: string[],      // names introduced here
      reads: string[],         // names read from an enclosing scope
      writes: string[],        // names assigned in an enclosing scope
      statements: [            // one per line, in order
        { text,                // == lines[i]
          indent,              // the assembler's prefix; not part of identity
          parts,               // the emitter's own parts list, or null
          kind, def, write, writes, reads,
          delta,               // the block nesting the statement opens/closes
          label,               // the label it introduces, or null
          jump,                // {kind, label, before, after} or null
          exit,                // {before, argument, after} for a `return`
          yields, continuesBlock,
          opens,               // "loop" | "try" | "switch" | "block" | null
          relocatable } ] },
    …
  ]
}
generated.jvmStructuredRegionLocalNames = {
  <variantName>: { declared: string[], kinds: {name: "let"|"const"} }
}
```

`<variantName>` is one of `jvmDirectPositionalSource`,
`jvmInternalRegionPositionalSource` and `jvmRestoringDirectPositionalSource` —
the three sources `HotCallGraphRegionCompiler.compileModule` composes. The
contract, pinned by `test/structuredRegionFragments.test.js`:

* The fragments' lines, joined in order with `"\n"`, are exactly the published
  source of that variant without its `'use strict';` directive. Late-bound
  sentinel expansions (`helpers.returnVoid()` → `ssaReturnVoid`) are applied to
  the fragments as well.
* A guest loop and a guest `try`/`catch` are each one fragment, at whatever
  depth they occur. Every other construct stays with the statements around it,
  so the list is a partition of the body in order.
* The restoring tier's own `try { … } catch (error)` wrapper is compiler
  scaffolding rather than a guest exception region, so it does not collapse the
  whole body into one fragment: the opening and the handler are their own
  fragments and the statements between keep their structure.
* `reads` includes the *ambient* names a fragment mentions — `helpers`,
  `frame`, `locals`, `stack`, `thread`, `plan`, `restorationDepth`,
  `safePointBudget`, `nestedEntryGuarded`, `framelessEntry`. No statement
  declares one (the tier's outermost scope does), but an outlined unit still
  has to receive them.
* A name a fragment assigns appears in both `writes` and `reads`. That
  includes the ambient names a statement assigns: the frame materialization's
  `[frame, locals, stack] = …` target and `safePointBudget`'s own decrements
  are writes even though no statement records them as an operand target.
* Every line publishes the statement record behind it. `parts` is the parts
  list the emitter built (§5), so a consumer rewrites a statement by
  substituting operand references and rendering it again -- exactly what
  `rerenderStatement` does inside the renderer -- rather than by editing
  characters. Everything else on the record is read off that parts list's own
  skeleton: the literal chunks the emitter wrote, with each operand replaced
  by one placeholder character and with string literals and comments masked
  out, so a `;` inside `'/ by zero'` or a keyword inside a marker comment is
  never read as syntax.
* `exit` and `jump` split a statement around the `return` or the
  `break`/`continue` it carries, into the parts before it, its argument or
  label, and the parts after it. Both are complete statements, so a consumer
  that relocates one replaces its own range by a block and leaves the guard
  the emitter wrote around it intact.
* `relocatable` is false when the statement may not be moved into a helper
  function: it opens a `switch`, carries a nested function, mentions
  `this`/`super`/`await`/`arguments`/`eval`/`var`, declares an ambient name
  (the helper already receives that name as a parameter), carries both a
  `return` and a jump or more than one of either, or lost its parts to a late
  expansion the fragment could not follow.
* `declares` never contains an ambient name. A tier declares those in its
  outermost scope, and a fragment that happens to contain the declaration
  still reports the name as ambient -- which is why declaring one is not
  relocatable.

Two caveats for the consumer:

* `jvmStructuredRegionLocalNames` is keyed by variant instead of being one
  record, because the variants declare different names.
* A method whose self-recursive calls are respecialized publishes no fragments
  for the affected variant: that respecialization is still a text splice over
  the joined module. A missing entry must be handled, as must an entry for a
  variant this compile did not emit.

With these, `outlineLargeRegionLoops`, `partitionOversizedLinearBlocks` and
`liftOversizedUnitLocalsToEnvironment` became selections and joins over
compiler-owned lists, and the last three `parse()` calls in the region
compiler are gone.

A variant that cannot publish a record for every one of its lines publishes no
fragments at all, so a consumer never sees a partial list. The canonical
continuation-tier body is exactly that case today: its prologue still carries
lines no emitter recorded -- `const locals = frame.locals;`, the entry check,
the `let local<slot>` declarations, the `spillLocals` arrow and the
`ssaMaterialize*` helper declarations, 11-17 lines per body -- so
`regionFragmentsOf` declines it and the renderer's own two calls into these
passes are inert. Recording those five emitters is all that is needed to light
them, and the framed region root, back up.

## 5. The renderer's statement IR

`src/jit/JvmSsaBlockRenderer.js` used to emit strings and then run its own
optimizations over them with about fifty regular expressions. Every statement
it emits is now built from a *parts list*: opaque literal chunks interleaved
with `{ref: name}` operand references.

* `e` is the expression tagged template, `exprConcat` joins pieces, and
  `st` / `constDecl` / `letDecl` / `storeLocal` / `stmt` record a statement.
  Records are keyed by the trimmed rendered text — the identity idiom
  `methodIntegerOriginLines` and `checkedLeafOmittableLines` already used —
  because indentation is applied by the assembler, not by the statement.
* `emittedNames` is every name a compile mints, so an interpolation becomes an
  operand reference exactly when it is one; `operandExpressions` remembers the
  parts of every composite operand the block simulator keeps as a string
  (it compares and keys those by identity).
* A record carries what it defines, what it writes, what it reads, and a small
  set of properties read off its own *parts skeleton* — the literal chunks with
  each operand reference replaced by one placeholder character, so an operand
  can neither contribute nor split an operator, a bracket or a keyword: does it
  call a helper or `new`, does it divide, does it index, does it open a
  condition or a `try`, does it throw, does it mention the safe-point budget,
  and what lexical nesting does it open or close.
* A pass rewrites a statement only through `rerenderStatement`, which
  substitutes operand references and records the result again. Marker
  expansion (an array-range access token becoming its guard variable) is that
  same substitution.
* `JVM_JIT_VERIFY_STATEMENT_IR=1` re-checks a finished body the way the
  generated-scope verifier does: it reports any line no emitter recorded and
  any record whose operands disagree with the names actually present. It
  reports 0 issues over both JIT corpora. `scripts/statement-ir-audit.js` runs
  it over a test file.

What still touches emitted characters in the renderer: the opt-in verifier
above; the exact-identity token expansions the rule permits
(`helpers.returnVoid()` → `ssaReturnVoid`, `helpers.asyncInvokeSentinel()` →
`ssaAsyncInvoke`, the checked-leaf bail retarget, and the self-recursive
respecialization, whose search text and replacement the compiler both built);
and one admission test on a *compiler operand* rather than on a rendered line —
`materializeLines` only compacts a materialization whose operand expressions
contain no comma.

## 6. Site 3 (`inlineAtomicPositionalSource`): landed

`inlineAtomicPositionalSource` parsed the JavaScript the renderer had just
emitted, alpha-renamed every binding and label it found, and turned each
`return` into an assignment plus a `break` so the body could be spliced into a
caller. It is deleted. The renderer publishes the body a caller inserts, the
way 741c9b1 published the checked-leaf one, and the region compiler assembles.

### What the renderer publishes

```
generated.jvmInternalRegionPositionalInsertion =
generated.jvmRestoringDirectPositionalInsertion = {
  serial,                 // this compile's serial
  source,                 // the body, exits carrying the two tokens
  exitCount,
  resultToken,            // `ssaRegionInlineResult<serial>`
  labelToken,             // `ssaRegionInlineBody<serial>`
  argumentNames,          // `argument0` … `argumentN`
  entryGuardName,         // `nestedEntryGuarded`
  entryGuardValue,        // `2`
  assemble({source, argumentValues, resultName, exitLabel, namespace,
            declareResult}) -> string | null,
}
```

`assemble` emits, for one call site:

```
let <resultName>;                          // when declareResult
const <namespace>a0 = <argumentValues[0]>; // staged in the caller's scope
…
<exitLabel>: {
  const plan = jvmRegionInlinePlan<i>;     // the restoring tier's plan, which
                                           // the region compiler prefixes onto
                                           // the insertable source
  const argument0 = <namespace>a0;
  …
  const nestedEntryGuarded = 2;
  <source, with both tokens expanded by exact identity>
}
```

The caller binds the callee's names *by declaration inside a block*, so the
callee's `local<slot>` / `ssaValue<n>` / `plan` / `frame` / `locals` / `stack` /
`restorationDepth` shadow the caller's rather than colliding with them, and
nothing is renamed. The argument values are staged in the caller's scope first
because inside that block every name the body declares is in its temporal dead
zone, and a call operand is routinely spelled `local3` or `argument0`.

### How an exit becomes insertable

Not by a fourth `insertable` arm per emitter, which is what §6 first proposed:
that would have had to enumerate the exits, and the census below shows they are
spread across `render`, the getstatic emitters and five `continuationFallbacks`
entries, with more shapes reachable in bodies the corpora do not exercise. The
transform is instead uniform, and it runs on the statement IR (§5), not on text:

* `partsReturnPositions(parts)` walks a statement's own *parts skeleton* — the
  literal chunks the emitter wrote, with each operand reference standing for one
  placeholder character — with rendered string literals excluded, and reports
  every whole-word `return` outside one. An operand can neither supply nor split
  the keyword, and the deopt reason `'structured SSA return with active child'`
  is inside a string and is not reported.
* `splitReturnParts(parts)` splits the statement into `before` / `value` /
  `after` around exactly one such return, locating the terminating `;` the same
  string-aware way. It handles both a whole-line `return { deopt: … };` and an
  exit embedded in a one-line guard, `if (c) { return ssaAsyncInvoke; }`.
* `insertableExitStatement` re-records the statement through `recordStatement`
  as `{ <resultToken> = <value>; break <labelToken>; }`, so the insertable body
  is statement IR like every other body. `JVM_JIT_VERIFY_STATEMENT_IR=1` audits
  it explicitly (`internal-region-insertion` / `restoring-insertion` labels) and
  reports 0 issues over both JIT corpora.

The caller therefore observes exactly the value it observes today, including the
`{deopt: …}` object. The `checkedLeaf` arm was **not** reused: it delivers
`helpers.asyncInvokeSentinel()` where the caller receives a deopt object, and
the guarded-fallback shape in `rewriteCallBindings` distinguishes the two.

### Labels

A guest loop or block label is named after its header pc (`L1`, `L3`), so two
unrelated bodies routinely declare the same one and nesting them is a syntax
error — the first thing the change hit. The inserted copy renames every label it
declares and every reference to it to `<label>_ssaInline<serial>`. The rename is
driven by the label each statement *recorded* (`loopHeader`, `blockLabel`,
`break`, `continue` all carry `label` meta); a statement that mentions one of the
body's labels without having recorded one rejects the whole variant, because its
jump would otherwise be left pointing at the caller's label. A renamed label
stays a literal chunk and is not registered as an emitted name: it names a
statement, not a value.

### The fail-safe

`insertableBodyOf` returns null — no insertion is published, and the edge is
linked as a region function instead of inlined — when

* a line was never recorded by an emitter (a hand-assembled nested function such
  as the restoring tier's `function spillLocals() { … }`, whose returns belong
  to it and not to this activation),
* a statement carries `yield` as a whole word,
* a statement mentions one of the body's labels without having recorded it,
* an exit cannot be represented as one assignment-and-break (two returns in one
  statement, or a return whose value cannot be delimited),
* the body has no exits at all,
* or the compile respecialized its self-recursive calls, which is a text splice
  over the joined module — the same condition that suppresses §4's fragments.

Every one of these is an identity or metadata check over statement records, not
a scan of generated text. An emitter that grows a new exit form loses inlining
rather than escaping the caller's activation.

`JVM_DEBUG_INSERTION_VETO=<file>` appends one line per rejection, naming the
reason and the statement, so a body that stops being insertable can be traced
back to the emitter that changed.

### Composition

`inlineAtomicPositionalSource` was not applied to the renderer's published
source. Measured over `test/hotCallGraphRegion.test.js` +
`test/jitCompiler.test.js`, every one of its inputs came from
`inlineSources`, and they are two different bodies:

* 31/81 are `composedInternalSources` — `jvmInternalRegionPositionalSource`
  after `rewriteCallBindings` has already inserted the node's own callees;
* 50/81 are `exceptionalInlineSources` — `const plan = jvmRegionInlinePlan<i>;`
  followed by **`jvmRestoringDirectPositionalSource`**, a different tier
  entirely, again possibly composed.

So both bodies publish an insertion, and composition runs over the callee's
*insertable* base exactly as it runs over its standalone base
(`composeInsertion`, one extra `rewriteCallBindings` per composed node). A
composed body then stays insertable by construction: its own exits already carry
the tokens, and every callee it embeds is a self-contained labeled block whose
exits break out of that block only. Nothing rewrites an emitted `return`. A node
whose callee has no insertable form gets none either, and
`inlineAdmissionReason` reports `target-without-insertable-body`.

Admission budgets still measure the standalone composed source, so which edges
are inlined is unchanged.

### Uniqueness

The exit label and the argument staging slots a call site introduces are named
`jvmRegionInline<pc>_<calleeSerial>_`. The pc separates two insertions of the
same callee in one body; the callee's compile serial separates an insertion from
the ones a *composed* callee already carries at the same pc — which is exactly
the collision the first attempt produced (`Label 'jvmRegionInline2_return' has
already been declared`). The result and label tokens themselves carry the
callee's serial, so no two insertions can share one at any nesting depth; a body
can never nest inside itself, because composition is a fixed point over an
acyclic graph.

### The census that shaped this

Measured by dumping the sources actually handed to `inlineAtomicPositionalSource`
over the two JIT test files (81 insertions on this tree; §6's earlier count of 85
was taken before intervening renderer changes):

* Java returns — `render`'s `directPositional` branch;
* `return ssaAsyncInvoke;` embedded in one-line guards (the restoring entry
  guard and the entry array-data guard, both built from `CHECKED_LEAF_BAIL`);
* seven deopt shapes: `'asynchronous structured SSA callee'`,
  `'asynchronous structured SSA callee left active child'`,
  `'structured SSA callee left active child'`,
  `'thread yielded in structured SSA callee'`,
  `'class initialization in structured SSA getstatic'`,
  `'structured SSA coarse loop guard'`, `'structured SSA safe point'`.

After the change all 52 inline sites over those two files still receive an
insertion, and the region modules report the same
`lexicallyInlinedEdges` (44) and `exceptionalInlinedEdges` (17) as before, with
zero `inlineFailures`.

### Generated-text differences

Diffing the 31 emitted region modules over the two JIT test files, master vs
this change: 9 are byte-identical (no edge in them was inlined) and 22 differ.
Every difference is inside an inlined body, and they are:

1. the alpha-renaming is gone — the callee's names are its own, shadowing the
   caller's inside the inserted block;
2. one argument is now two declarations (`const <ns>a0 = <operand>;` in the
   caller's scope, `const argument0 = <ns>a0;` inside the block) instead of one,
   which is what makes the operand safe to evaluate;
3. the callee's `'use strict';` directive is no longer carried into the middle
   of the caller's block, where it was a no-op expression statement (48
   occurrences);
4. a returned value keeps the parentheses the emitter wrote
   (`{ x = (((a + 1) | 0)); … }` rather than `{ x = (a + 1) | 0; … }`); the AST
   version dropped one layer because acorn does not model them;
5. in one module, an inserted body's `let safePointBudget = …;` is now removed
   by the module's exact-identity safe-point strip, because the declaration is
   no longer renamed and therefore matches. That body's polling now charges the
   enclosing region counter instead of a private one — which is the "fused graph
   owns one shared quantum" property stage C introduced, extended to inserted
   bodies. It is strictly more conservative (a shared counter reaches its safe
   point sooner, never later) and the module always declares one, so no name is
   left unbound. This is a behavioural consequence of removing the rename, not a
   deliberate design choice; it is recorded here because it is the one
   difference that is not purely syntactic.

Nothing outside the inlined bodies changed.
