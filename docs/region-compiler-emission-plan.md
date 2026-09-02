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
| 3 | `inlineAtomicPositionalSource` (L255; `parse` L270, edits L366/L382) | callee parameter binding, local declarations, `return` statements, label set of an atomic positional body, in order to alpha-rename and splice it into a caller | the renderer already renders checked leaves as `ssaInlineBody<serial>: { … }` with `assemble({feeds, provenGuards, exitLabel})` (741c9b1). The same shape is needed for `jvmInternalRegionPositionalSource`: a body valid standalone *and* inserted, plus published parameter/result/label names. |
| 4 | `removeUnreachableRegionFunctions` (L396; `parse` L399, edits L429) | the call graph among the module's own `jvmRegionNode<i>` / helper functions, to drop unreachable ones | the region compiler *builds* `declarations` itself and knows every function name it emitted and every name it linked. This is a data-level reachability walk over its own emission list. |
| 5 | `splitModuleSourceForFactoryHoist` (L454; `parse` L457, slice L489) | top-level function-declaration boundaries in the assembled module | the region compiler assembled that module from a `declarations` array; keep the array, emit two texts. |
| 6 | `outlineLargeRegionLoops` (L507; `parse` L549, edits L713/L758) | loop statements, their byte size, and their free variables, to outline them into helper functions | needs renderer-published statement/loop fragment boundaries with free-variable sets (see §4). |
| 7 | `collectOversizedUnits` (L830) | AST consumer of #9's parse | as #9 |
| 8 | `liftOversizedUnitLocalsToEnvironment` (L876; `parse` L883, edits L1009) | function-scoped `let/const` declarations and all their reference sites, to move them into an environment array | the renderer owns every local name it emits (`local<slot>`, `ssaValue<n>`, call bindings). It can publish the *name set* per unit and, better, render local access through a late-bound accessor token so lifting is a choice of expansion, not a rewrite. |
| 9 | `partitionOversizedLinearBlocks` (L1014) — `yield`→`void` regex (L1045), `parse` (L1048), `slice(node.start, +5) === "yield"` probe (L1170), fragment slices (L1265/L1286/L1293), `'use strict'` prologue regex (L1403) | statement boundaries of oversized linear runs and the live names crossing them; whether a statement is a `yield`; where the directive prologue ends | statement-level fragment boundaries + free variables (§4). The `yield` regex and the directive regex are removable now (see §2, stage D). |
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
  resultName, resultDeclaration,          // `out`, `let out;`
  depthName, depthDeclaration,            // callStackDepth and its `let … = thread.callStack.items.length;`
  callArguments: [...args, ...captures],  // exactly rawCall.arguments.slice(1, -2)
  rawCallExpression,                      // the emitted `raw ? raw(helpers, …, thread, true) : invoke(…)`
  nestedRawCallExpression,                // same with the raw arm's nestedEntryGuarded = 2
  fastCall: { caught, restoringSource, handlerSource } | null,
}
```

and `generated.jvmStructuredRegionCallBindingDeclarations`, mapping each binding
name to the exact declaration text(s) and kind (`let`/`const`) the renderer
emitted for it in each positional variant, plus
`generated.jvmStructuredRegionRunCounterStatements`, the exact
`helpers.structuredSsa.*RunCount += 1;` statements an internal node drops.

`rewriteCallBindings` then does no parsing. It locates the compiler-owned
`/*__JVM_REGION_CALL_START_<pc>__*/` … `/*__JVM_REGION_CALL_END_<pc>__*/` span by
exact identity, and takes every other fact from `regionLowering`. Selecting the
*linked* form of a call is a choice between two published strings, not a search
for a call expression.

Conservatism: when a published fragment is not present verbatim in the variant
being composed (a source that a later renderer pass specialized or partitioned),
the edge is simply not lowered — exactly the `if (!rawCall) continue` outcome the
AST version already had. Correctness never depends on the lookup succeeding; the
final `replaced.has(rawInvoke)` check still rejects a module that could not be
linked, and the ordinary tier remains the fallback.

### Stage B — unused bindings are not emitted (site 2)

`removeUnusedRegionBindings` parsed the *result* to discover that a binding had
become dead. After stage A the compiler already knows precisely which bindings it
eliminated (`eliminatedBindingNames`) and which declaration text belongs to each.
It therefore deletes the declaration by exact identity of the published text —
"do not emit this binding" — and the DCE parse disappears. The transitive
`pureGeneratedExpression` closure is replaced by the renderer's own knowledge of
the binding dependency chain (`ssaCallSite<i>` → `ssaFastPositional<i>` →
`ssaFastPositionalInvoke<i>` / `…RawInvoke<i>` / `…Receiver<i>`), published with
the declarations.

### Stage C — no directive regex, no `safePointBudget` regex (sites 9, 11)

* The `'use strict';` prologue is *prepended by the region compiler itself*. It
  now partitions the body without the directive and re-joins afterwards, so the
  partition pass never has to find a directive in text.
* The renderer publishes `generated.jvmStructuredSafePointBudgetDeclarations`,
  the exact declaration strings it emitted. The fused module removes them by
  exact identity instead of matching `/let safePointBudget = \d+;/`.

### Stage D — `yield` regex (site 9), deferred

`partitionOversizedLinearBlocks` replaces `yield` with `void ` in an analysis copy
so acorn will accept a generator *body* as a program. Two ways out, both cheap
relative to stages E/F:

* parse `function* __jvmRegionUnit() { … }` (the prefix idiom already used by
  sites 2, 3 and 10) — removes the regex and its false positives inside strings
  and comments, but keeps the parse; or
* have the renderer publish a non-generator variant of the framed body, as the
  task statement suggests, and partition that.

Neither is worth landing on its own while the surrounding pass still parses.

### Stage E — module-level structure (sites 4, 5)

`removeUnreachableRegionFunctions` and `splitModuleSourceForFactoryHoist` both
re-derive structure the region compiler had in hand seconds earlier. Replace the
flat `declarations: string[]` with `declarations: {name, kind, references, text}[]`
so reachability and factory hoisting become list operations over the compiler's
own emission plan. No renderer change is required; this is a refactor of
`compileModule`'s own bookkeeping.

### Stage F — inlining, outlining, partitioning, env-lift (sites 3, 6, 8, 9)

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

* Stage A — landed.
* Stage B — landed.
* Stage C — landed.
* Stages D, E, F — not landed; see §2 for exactly what each needs.

## 4. What the renderer must publish next

Concretely, for stage F, near the existing `generated.jvmHotCallGraph*`
assignments:

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
generated.jvmStructuredRegionLocalNames = { declared: string[], kinds: {name: "let"|"const"} }
```

With those, `outlineLargeRegionLoops`, `partitionOversizedLinearBlocks` and
`liftOversizedUnitLocalsToEnvironment` become selections and joins over
compiler-owned lists, and the last four `parse()` calls in the region compiler go
away.
