# Region compiler: from text recovery to emission

`src/jit/HotCallGraphRegionCompiler.js` composes a hot call-graph region out of
the per-method JavaScript that `src/jit/JvmSsaBlockRenderer.js` publishes on
`generated.*`. Today it recovers the structure of that JavaScript by re-parsing
it with `acorn` and splicing byte ranges (`applySourceEdits`), plus a handful of
regular expressions over generated text.

That violates the compiler-pass rule the repository works to:

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
| 1 | `applySourceEdits` (L70) | — (shared byte-splice engine for 2,3,4,6,8,9,10) | n/a; disappears as its callers do |
| 2 | `removeUnusedRegionBindings` (L127; `parse` L132, edits L245) | which renderer-published call bindings (`ssaCallSite<i>`, `ssaFastPositional*<i>`, `ssaLateLinkPositional<i>`) are still referenced after lowering, and their pure-initializer dependency chain | the region compiler itself decides which bindings it links; the renderer knows each binding's declaration text and kind. **Do not emit** instead of parse-and-delete. |
| 3 | `inlineAtomicPositionalSource` (L255; `parse` L270, edits L366/L382) — **still present**, see §5 | callee parameter binding, local declarations, `return` statements, label set of an atomic positional body, in order to alpha-rename and splice it into a caller | the renderer already renders checked leaves as `ssaInlineBody<serial>: { … }` with `assemble({feeds, provenGuards, exitLabel})` (741c9b1). The same shape is needed for `jvmInternalRegionPositionalSource`: a body valid standalone *and* inserted, plus published parameter/result/label names. |
| 4 | `removeUnreachableRegionFunctions` (L396; `parse` L399, edits L429) — **gone** (stage E) | the call graph among the module's own `jvmRegionNode<i>` / helper functions, to drop unreachable ones | the region compiler *builds* `declarations` itself and knows every function name it emitted and every name it linked. This is a data-level reachability walk over its own emission list. |
| 5 | `splitModuleSourceForFactoryHoist` (L454; `parse` L457, slice L489) — **gone** (stage E) | top-level function-declaration boundaries in the assembled module | the region compiler assembled that module from a `declarations` array; keep the array, emit two texts. |
| 6 | `outlineLargeRegionLoops` (L507; `parse` L549, edits L713/L758) | loop statements, their byte size, and their free variables, to outline them into helper functions | needs renderer-published statement/loop fragment boundaries with free-variable sets (see §4). |
| 7 | `collectOversizedUnits` (L830) | AST consumer of #9's parse | as #9 |
| 8 | `liftOversizedUnitLocalsToEnvironment` (L876; `parse` L883, edits L1009) | function-scoped `let/const` declarations and all their reference sites, to move them into an environment array | the renderer owns every local name it emits (`local<slot>`, `ssaValue<n>`, call bindings). It can publish the *name set* per unit and, better, render local access through a late-bound accessor token so lifting is a choice of expansion, not a rewrite. |
| 9 | `partitionOversizedLinearBlocks` (L1014) — `yield`→`void` regex (L1045) and the `slice(node.start, +5) === "yield"` probe (L1170) are **gone** (stage D); `parse` (L1048), fragment slices (L1265/L1286/L1293), `'use strict'` prologue regex (L1403) | statement boundaries of oversized linear runs and the live names crossing them; whether a statement is a `yield`; where the directive prologue ends | statement-level fragment boundaries + free variables (§4). The `yield` regex and the directive regex are removable now (see §2, stage D). |
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

**This stage is interim.** The parse itself remains. It disappears when the pass
moves onto renderer-published fragments (`generated.jvmStructuredRegionFragments`,
§4) and selects fragments instead of byte ranges; the wrapper and the offset
rebase go with it.

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

Site 3 was attempted and is **blocked on emitters outside this pass**; see §5.

These are the deep ones. They are *real* compiler passes that happen to be
implemented on text. To move them to emission the renderer must publish, for each
positional body:

1. **Statement-level fragment boundaries.** An ordered list of fragments
   (`{id, lines, kind}`) instead of one joined string, with loops and try/catch
   marked as single structural units, so outlining and partitioning select
   fragments rather than byte ranges. `checkedLeafInlineBody.assemble()` from
   741c9b1 is the existing precedent for a body built from fragments.
2. **Free variables per fragment.** The set of emitted names each fragment reads
   and writes (the renderer knows them: it created every `local<slot>`,
   `ssaValue<n>` and call binding). This is what `liftOversizedUnitLocalsToEnvironment`
   and `partitionOversizedLinearBlocks` currently rediscover by walking the AST.
3. **Declared-name sets and their kinds** per body, so env-lift becomes a choice
   of how a fragment's names are spelled at emission (`local7` vs `env[7]`) —
   ideally a late-bound accessor token expanded by identity — rather than a
   rename over emitted text.
4. **Return/label discipline for insertion.** For `inlineAtomicPositionalSource`,
   the same contract 741c9b1 gave checked leaves: a body that completes through a
   labeled block into a published result name, with published parameter names the
   caller binds by declaration, so no alpha-renaming of emitted text is needed.

Until (1)–(4) exist, these four sites stay as they are: they are correct, they are
covered by tests, and moving them without the structural inputs above would only
relocate the parsing.

## 3. Status

* Stage A — landed. `rewriteCallBindings` no longer calls `parse`, walks an AST,
  or caches an AST index; `callBindingParseCount` is asserted to stay at zero.
* Stage B — landed. `removeUnusedRegionBindings` and `pureGeneratedExpression`
  are deleted.
* Stage C — landed. The `'use strict'` and `safePointBudget` regexes are gone.
* Stage D — landed as an **interim**: the `yield`→`void ` regex and the
  `slice(node.start, +5) === "yield"` probe are gone, but the pass still parses
  (now through the generator-declaration prefix idiom, with offsets rebased).
  It stops parsing when §4's fragments are consumed.
* Stage E — landed. `removeUnreachableRegionFunctions` and
  `splitModuleSourceForFactoryHoist` are deleted; module reachability and the
  factory-hoist split are list operations over `compileModule`'s own
  `{name, kind, references, text}` emission plan.
* Stage F, renderer half — landed. The renderer runs no line-level text pass
  any more: every statement it emits is recorded as a parts list (§5), the
  optimizations run over those records, and §4's fragments are published.
* Stage F, region-compiler half — not landed. Sites 6, 8 and 9 can now be
  replaced by selections over §4's fragments. Site 3 was attempted and is
  blocked on the renderer; §6 records the evidence and the exact contract.

**No regex over generated JavaScript remains in
`HotCallGraphRegionCompiler.js`.** The two `replace(/[^A-Za-z0-9…]/g, …)` calls
that are left sanitize compiler-owned identifiers and file names, not generated
JavaScript.

Four `parse()` calls remain, down from six:

| `parse()` | Pass | Removed by |
|-----------|------|------------|
| L127 | `inlineAtomicPositionalSource` | §5 — the renderer must publish an insertable body; attempted and blocked |
| L397 | `outlineLargeRegionLoops` | §4 fragments |
| L731 | `liftOversizedUnitLocalsToEnvironment` | §4 fragments + declared-name sets |
| L902 | `partitionOversizedLinearBlocks` | §4 fragments — stage D's generator wrapper here is explicitly interim |

`applySourceEdits` survives only as the shared byte-splice engine for those
four.

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
      writes: string[] },      // names assigned in an enclosing scope
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
* A name a fragment assigns appears in both `writes` and `reads`.

Two caveats for the consumer:

* `jvmStructuredRegionLocalNames` is keyed by variant instead of being one
  record, because the variants declare different names.
* A method whose self-recursive calls are respecialized publishes no fragments
  for the affected variant: that respecialization is still a text splice over
  the joined module. A missing entry must be handled, as must an entry for a
  variant this compile did not emit.

With these, `outlineLargeRegionLoops`, `partitionOversizedLinearBlocks` and
`liftOversizedUnitLocalsToEnvironment` become selections and joins over
compiler-owned lists, and the last four `parse()` calls in the region compiler
can go away.

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

## 6. Site 3 (`inlineAtomicPositionalSource`): attempted, blocked

The intended replacement is 741c9b1's insertion contract applied to
`generated.jvmInternalRegionPositionalSource` — the body the region compiler
inlines at `HotCallGraphRegionCompiler.js` L2045/L2071. The renderer would
publish an *insertable* variant of it: the body wrapped in
`ssaRegionInlineBody<serial>: { … }`, every exit rendered as
`{ ssaRegionInlineResult<serial> = v; break ssaRegionInlineBody<serial>; }`, and
the parameter names published so the caller binds them by declaration inside a
block scope (which is also what retires the alpha-renaming: the child's
`local<slot>` / `ssaValue<n>` names shadow the caller's inside that block, and
`compileSerial` already makes the label and result slot unique at any nesting
depth). The region compiler would then assemble, never parse.

**Why it does not land yet.** The contract requires that *every* exit of that
body be lowered at emission. It is not one exit family. Measured over
`test/hotCallGraphRegion.test.js` + `test/jitCompiler.test.js` by dumping the 85
sources actually handed to `inlineAtomicPositionalSource`:

* 57/85 bodies exit only through Java returns — `render`'s `directPositional`
  branch, `JvmSsaBlockRenderer.js:8571`;
* **28/85 also carry deopt exits**, in seven distinct shapes:
  `'asynchronous structured SSA callee'`,
  `'asynchronous structured SSA callee left active child'`,
  `'structured SSA callee left active child'`,
  `'thread yielded in structured SSA callee'`,
  `'class initialization in structured SSA getstatic'`,
  `'structured SSA coarse loop guard'`,
  `'structured SSA safe point'`;
* 0/85 carry the checked-leaf bail (`return helpers.asyncInvokeSentinel();`), so
  `retargetCheckedLeafBails` alone is not enough.

The AST inliner converts all of them uniformly, which is exactly why it parses.
Their emitters are:

| Exit | Emitter |
|------|---------|
| Java return | `JvmSsaBlockRenderer.js:8571` (`render`, `directPositional`) |
| safe point | `:8765` (`render`) |
| coarse loop guard | `:8872` (`render`) |
| getstatic class init | `:4033`, `:4069` |
| async callee / left-active-child / yielded callee | `:4219`, `:4233`, `:4238`, `:4774`, `:4825`, `:4834`, `:4857`, `:4862` |

The last two rows sit in the block-simulator emitters (~1300–5000) that
`refactor/checked-leaf-ir` rewrote concurrently, so they were left alone. The
line numbers in this section are those of 77d1e23; after §5 landed the same
exits are the `continuationFallbacks` entries and `render` exits described
here, but at different lines.

**What the renderer still owes, concretely.** The mechanism is already in place
and needs one more arm, not a redesign. Those call-lowering exits are not
emitted inline: they are entries in the `continuationFallbacks` map, which
already publishes three variants per exit — `continuation` (a `yield`),
`ordinary` (the deopt `return`) and `checkedLeaf` (`return
helpers.asyncInvokeSentinel();`). `render`'s `expandLines` (`:8548`) selects
one. Site 3 needs a fourth, `insertable`, holding the same statement with the
`return` replaced by the late-bound exit token, plus:

1. an `insertable` arm at `:4033`/`:4069` and at the five
   `continuationFallbacks.set(...)` sites listed above (one array entry each);
2. an exit target threaded through `render` for `:8571`, `:8765` and `:8872`
   (a scoped `insertableExitTarget`, selected the same way `checkedLeafOnly`
   already is);
3. `internalRegionPositionalInsertableSource` assembled beside
   `internalRegionPositionalSource` at `:10554` from the same fragment list,
   wrapped in the labeled block, and published as
   `generated.jvmInternalRegionPositionalInsertion =
   {source, result, label, argumentNames, entryGuardName}`;
4. the same fail-safe `assemble` already uses — reject the insertable variant if
   any `return ` survives — so an emitter that grows a new exit form loses
   inlining rather than silently leaving the caller's activation.

Two shortcuts were considered and rejected:

* *Reuse the existing `checkedLeaf` arm* (it already ends the exit in a bail
  that `retargetCheckedLeafBails` can retarget). Rejected: it delivers
  `helpers.asyncInvokeSentinel()` where the caller today receives the
  `{deopt: …}` object, and the guarded-fallback shape at
  `HotCallGraphRegionCompiler.js:2100` distinguishes the two. That is a
  semantic change, not a refactor.
* *Retarget returns by a line-level rewrite of the assembled body* (match lines
  whose trimmed text starts with `return `). Rejected: that is a new instance of
  precisely the problem this document exists to remove, and it would have to be
  correct about function nesting, which is the fact only a parse supplies.
