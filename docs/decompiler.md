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

## Final control-frame cleanup

Loop and dispatch reconstruction can expose a redundant labeled break after
the earlier frame cleanup has run. `finalizeControlFrames` finishes the source
pipeline by reusing the existing lexical fallthrough and unused-frame proofs.
It removes such breaks and their unused labels, retaining blocks that contain
declarations. It does not rerun predicate or loop transformations.

A break can disappear only when its entire path to its plain-block destination
is the final statement of transparent blocks, branches and plain labels.
Intermediate loops, switches, try/catch/finally and monitors refuse that proof.
In particular, a break in a finally block can override a pending return and
must remain. Cleanup entirely inside an enclosing protected region is allowed;
its statements retain their exception and monitor coverage.

The final stage also calls `finalizeTerminalSwitchFrames`. When a switch is the
last statement on every enclosing continuation to a plain-block exit, breaking
the nearest switch reaches that same exit. The shared destination localizer
can then erase the jump's label; the unused-frame proof removes its wrapper
only when declaration scope permits. Case order, guards, fallthrough, actions,
returns and exceptions remain intact. Work, loops or protected constructs
between the switch and plain exit refuse reconstruction. Protected constructs
inside the switch remain intact and unwind on the same abrupt exit, including
finally overrides of pending returns. An enclosing protected region also stays
in place. This is a destination rewrite, not break removal.

The terminal switch cleanup was validated with 99 passing tests and one
existing optional corpus check skipped. Five new switch
groups include six independent native event/completion models matching 49,920
cases: case fallthrough, nonzero/negative flags, partial effects, signed overflow,
injected failures, return/finally priority and monitor ownership. Publication
still requires compiling and independently auditing the complete exported
corpus, including retired labels and resulting lexical-label ordinal migrations.

### Stable guarded fallbacks

`foldStableGuardedFallbacks` replaces a frame such as
`Pick: { if (selected) { prefix(); if (keep()) break Pick; } fallback(); }`
with `if (selected) { prefix(); } if (!(selected) || !(keep())) { fallback(); }`.
Every prefix, guard and fallback action stays in one source location. No
selector variable, duplicated callback or assumed control-flag value is added.

A repeated condition must be a total expression over uniquely scoped primitive
locals or parameters, and the complete prefix must not write any of its inputs.
Assignment, compound assignment and increment targets are checked through
parentheses, including nested loops, assertions and protected statements. Calls
cannot mutate these primitive bindings by reference. A guard cannot use a local
declared in the prefix, since that declaration's scope ends before the second
condition. The guard itself can throw, unbox, divide or mutate: it still runs
once, after the same prefix and only when the original condition was true.
An empty prefix needs one condition evaluation, allowing effectful conditions.

Floating arithmetic is repeated only with a verified FP-strict source context.
The normal emitter passes its actual emitted `strictfp` method flag. Comparisons
of stored floating values remain supported without that flag. This preserves
the choices allowed by [Java8-16 value-set conversion](https://docs.oracle.com/javase/specs/jls/se11/html/jls-5.html#jls-5.1.13).
Equality negation uses the existing exact complement helper; other predicates
retain logical negation, including NaN-sensitive ordering comparisons.

The frame must have one direct guarded exit and a complete following fallback.
Protected boundaries around that exit and extra references decline recovery.
Prefix, fallback and declaration scopes stay whole; a declaring frame or a
single-statement slot keeps its braces. Diagnostics record source fragments,
condition copies, equality complements and the sole consumed transfer.
Bodies, regions, nesting and label counts are bounded. Each recovery removes
one label, so the emitter's final iteration converges.

`node --test test/stableGuardedFallbackRecovery.test.js` covers nine groups,
including 207,360 independent native action/completion cases across 12 models
and six contexts. It checks callback order, partial writes, nullable unboxing,
NaNs, signed overflow, guard mutations, finally overrides and monitor release.
Another 55 FP-strict arithmetic cases cover underflow, overflow and signed zero.

### Arithmetic fallback stores

`foldArithmeticStoreFallbacks` permits bounded integral arithmetic in primitive
assignment fallbacks. It preserves original expression association and read order,
including signed overflow, shifts and division/remainder failures. Exclusive
source arms execute each original store once on its original paths. Other frame
exits retain their name and scope; the final reference can retire the frame.
Scoped local/formal and owned-field evidence is required. Floating, boxed,
unknown, cast, call, increment, array and conditional operands refuse. Original
simple-store APIs retain their existing policy. Final predicate/grouping cleanup
runs after arithmetic recovery, so new inverse guards use direct comparisons
without changing expression association or evaluation order.

`node --test test/arithmeticStoreFallbackRecovery.test.js` checks six groups,
including 262,440 native comparisons across 36 models. Original, shared and final
structured forms compare with independent oracles for
nullable early/keep guards, prefix mutations, volatile reads, overflow, shifts,
zero divisors, partial writes, aliases, finally overrides and monitor release.
Publication independently attributes every arithmetic operand, original/copied
binding and surviving transfer/protected scope before export.

### Final conditions after structural recovery

The normal emitter finishes predicate operators and condition grouping after
late frame, loop and shared-fallback reconstruction. This expresses exposed
inverse guards as direct comparisons and removes redundant condition parentheses.
Scoped local/formal and owned-field descriptors justify integral relational
complements. Unknown and floating relations retain their original NaN/unboxing
outcomes; operands, read/call order, short circuits and arithmetic association
stay intact. This uses the existing generic predicate and grouping proofs.

`node --test test/latePredicateCleanup.test.js test/predicateNegationRecovery.test.js test/predicateGroupingRecovery.test.js`
checks normal emission, refusal boundaries and independent native oracles for
boxing identity, nullable unboxing, side effects, overflow, NaNs, volatile fields,
exceptions, finally overrides and monitor release. Publication separately proves
exact permitted operator edits and primitive operand types, then compares full
javac trees before/after grouping modulo parentheses. Every ordinary/label
binding and transfer/protected scope must remain exact.

### Shared frames with primitive store fallbacks

`foldSharedStoreFallbacks` extends primitive-store recovery to frames with other
exits. It consumes only the selected guarded skip and retains the original frame
name, braces and remaining destinations. One through eight integral/boolean
assignments occupy exclusive arms; each store still executes once on its original
paths. Scoped local/formal and owned-field type evidence is required. Unknown,
boxed, floating or computed operands, direct prefix declarations, intervening
work and crossed loop/protected/monitor corridors refuse reconstruction.

`node --test test/sharedStoreFallbackRecovery.test.js` covers six groups,
including 174,960 native comparisons across 24 models. Original, shared and
subsequently structured forms compare with independent oracles for early exits,
nullable predicates/guards, mutations, partial writes, overflow, volatile fields,
aliases, finally overrides and monitor release. Publication independently
reattributes primitive stores, exact terminal corridors, all original/copied
bindings and every surviving transfer/protected scope before export.

### Late cleanup after shared fallbacks

Shared callback and primitive-store recovery change nested branches into complete
exclusive arms. A previously nonterminal early frame exit can then have an
action-free terminal corridor. The normal emitter reruns `foldTerminalGuardedFrameExits` after each shared
recovery stage to express that remaining exit as an inverse guard around its complete
suffix. Original predicates/actions stay once; other exits retain their frame.
Protected/loop/monitor crossings and intervening work still refuse.

`node --test test/sharedGuardedFallbackRecovery.test.js test/sharedStoreFallbackRecovery.test.js`
validates normal emission of both final structured forms. Each fixture's 174,960
native cases compare original, shared and final forms with an independent oracle. Publication must reattribute the
actual intermediate source with javac and independently prove every consumed
exit, remaining transfer/protected scope, binding and complete naming object.

### Shared frames with bounded callback fallbacks

`foldSharedGuardedFallbacks` keeps other frame exits while reconstructing one
final guarded skip of a bounded callback. Its callback occupies exclusive source
arms and executes once on the original paths. Original conditions, prefixes and
guards occur once. Terminal plain-block/if/label corridors permit nested dispatch;
nonterminal work and crossed loop/protected/monitor corridors refuse. Other
exits retain the original frame name, braces and destination.

One callback with simple operands, at most 32 tokens/512 bytes and one line, can
be copied. Computed arithmetic, casts, array/call operands, poly expressions,
prefix-owned direct declarations, nested execution and unsupported syntax refuse.
The original sole-exit API remains unchanged. Late shared recovery makes remaining
terminal guards available for a separately verified continuation cleanup.

`node --test test/sharedGuardedFallbackRecovery.test.js` covers six groups,
including 174,960 native comparisons across 12 direct/nested/protected contexts.
Original, shared and subsequent structured forms compare with independent models
for early exits, mutations, nullable guards/payloads, overloads, aliases, partial
failures, overflow, finally overrides and monitor release. Publication requires
independent callback/corridor/scope evidence, all original/copied bindings,
consumed and surviving transfers/protected scopes, unchanged complete naming
objects, compilation and dictionary reversal.

### Frames ending in terminal loops

`foldTerminalFrameLoops` recognizes a loop ending a plain frame through only
terminal blocks, if arms and labels. Every frame break must be inside that loop.
When the loop is also each break's nearest loop/switch destination, ordinary
bare breaks replace the frame exits and its label retires. Otherwise the existing
frame name moves onto the loop, or merges into the loop's existing name. No new
name, condition, selector, action or header/update evaluation is introduced.

Frame prefixes remain before the loop. Declaration and scalar-statement scopes
retain braces; declaration-free frame bodies flatten. Whole protected constructs
inside the loop stay intact. Prefix references, nonterminal work, crossed loops,
try/catch/finally or monitor corridors, nested execution and unsupported syntax
refuse. Bounds limit source, nesting, labels, references and individual regions.
Diagnostics identify complete frame/loop extents, the terminal corridor, retained
scope and every moved, merged or localized break for independent javac proof.

`node --test test/terminalFrameLoopRecovery.test.js` covers six groups, including
69,120 native comparisons across 96 loop/protected/merge/exit models. Loop guards,
updates and iterator work, nullable conditions, aliases, partial failures,
overflow, nested exits, pending returns/throws, finally priority and monitor
release compare with independent models. Publication must prove every binding,
exact continuation/destination/protected scope, label identity migration,
compilation, dictionary reversal and clean source/archive reproduction.

### Terminal guarded frame remainders

`foldTerminalGuardedFrameExits` replaces a direct guarded break followed by
work with an inverse guard around that complete suffix. The containing block
must reach the frame's end through only terminal plain blocks and if arms.
No condition or action is copied or reevaluated; whole nested/protected suffixes
stay together. Nonterminal work and corridors crossing loops, try/catch/finally,
monitors or other unsupported boundaries refuse.

The last eligible guard recovers first. Other exits retain their existing frame
name and scope; the last removed reference retires that label. Declaration and
scalar-statement scopes retain braces when needed. Diagnostics provide exact
frame/container/guard/suffix ranges, corridor kinds and the consumed transfer
for independent javac continuation and per-occurrence binding validation.
Source/nesting/label/transfer and individual-region limits bound the work.

`node --test test/terminalGuardedFrameRecovery.test.js` covers six groups,
including 77,760 native comparisons across 24 direct/nested/chained/protected
models. Nullable and effectful guards, partial writes, overflow, local aliases,
nested loop exits, returns, throws, finally priority and monitor release are
compared with an independent structured oracle. Publication checks every
original action and binding, consumed and remaining transfers, protected scopes,
retained/retired label identities, compilation and byte reversal.

### Guarded primitive-store fallbacks

`foldGuardedStoreFallbacks` extends exclusive fallback reconstruction to one
through eight simple integral/boolean assignments. The guarded prefix keeps its
original condition and guard exactly once; fallback assignments occupy exclusive
arms in their original order. No selector, predicate reevaluation, inferred
control flag value, reassociation, new label or repeated runtime store is needed.
A terminal plain-block/if corridor can connect the selected branch to the frame
exit. Extra work, loops, protected boundaries and other corridors refuse.

Scoped primitive local/formal declarations or exact owned-field metadata prove
destination and operand types. Reference boxing stores, floating stores,
computed/cast/call/array operands, unknown receivers and shadowed class qualifiers
refuse. Prefix-owned direct declarations refuse so cloned assignments cannot
capture different locals. Original frame scopes remain when needed. Limits bound
source/nesting/labels, fallback statements/tokens/bytes and individual regions.
Diagnostics identify the exact store clone, source ranges and terminal corridor
for independent javac attribution and per-occurrence transfer/scope validation.

`node --test test/guardedStoreFallbackRecovery.test.js` covers six groups,
including 77,760 native comparisons across 24 direct/nested/protected/store models.
The independent oracle checks nullable conditions/guards, volatile writes, partial
failures, signed overflow, finally overrides, monitor release and alias identity.
Publication requires exact copied-store bindings and terminal-corridor evidence,
every original binding/transfer/protected scope, explicit label migrations,
compilation, dictionary reversal and clean source/archive reproduction.

### Terminal loop-frame labels

`foldTerminalLoopFrames` recognizes a loop body ending with a plain labeled
frame followed only by a bare break of that loop. Exiting the frame reaches
that same final loop exit without any intervening action or protected boundary.
The existing frame name can therefore label the loop itself; if the loop already
has a label, the equivalent frame exits merge into it. Nested breaks keep an
explicit destination. No new label, selector, condition or action is introduced.

Declaration-free frame bodies flatten into the loop body. A frame containing
direct declarations retains its whole block scope. Loop headers, updates,
bare breaks/continues, outer named continues, and whole nested/protected
constructs remain in place. A frame's break inside a finally still overrides
pending return/throw/continue at the same loop exit. Suffix work, non-loop final
exits, named continues to a plain frame, unsupported syntax, nested execution
and source/nesting/label/transfer limits refuse. Diagnostics identify the moved
or retired label, complete loop/frame extents, original break references and
terminal exit for independent destination/protected-scope verification.

`node --test test/terminalLoopFrameRecovery.test.js` covers six groups.
Native independent models compare 11,520 cases across 48 loop/protected/merge
contexts, including outer updates and guards, nested breaks and continues,
aliases, overflow, partial failures, returns, throws, finally priority and
monitor release. Publication requires independently parsed exact frame/loop
continuations, every binding and transfer/protected scope, explicit label
identity/ordinal migrations, compilation and byte reversal.

### Small exclusive guarded fallbacks

`foldSmallGuardedFallbacks` reconstructs a single-exit frame such as
`Pick: { if (test()) { prefix(); if (keep()) break Pick; } fallback(2); }`
as `if (test()) { prefix(); if (!(keep())) { fallback(2); } } else { fallback(2); }`.
The condition, prefix and guard retain one source occurrence and execute at
exactly their old points. The small fallback has two exclusive source sites;
only one runs on any original fallback path. Conditions may mutate, unbox or
throw. No condition is reevaluated and no selector or flag invariant is added.

The fallback must be one call with simple literals (including signed integral
literals), identifiers, self/super or field operands, at most 32 tokens/512 characters and one source line. Calls in
operands, arithmetic, casts and poly expressions refuse the copy. Prefix-owned
direct declarations refuse to prevent a copied fallback from observing a
shadowing binding. Nested execution and unsupported syntax refuse globally.
The sole guarded frame exit is direct, and the fallback ends the exact frame;
protected constructs are neither split nor crossed. Outer declaration and
scalar statement scopes retain their braces. Diagnostics mark copied source
fragments, allowing independent javac comparison of each added method/value/type
reference against its original binding. Each recovered frame removes one label,
so the final emitter iteration converges within its source/nesting/label budgets.

`node --test test/smallGuardedFallbackRecovery.test.js` covers seven groups.
Native independent models compare 12,960 cases across six completion contexts,
including condition mutation, nullable unboxing, overloads, aliases, partial
failures, finally priority and monitor release. Publication requires independent
shape/scope/copy evidence, exact source reconstruction, every retained and
copied binding, transfer/protection comparison, compilation and byte reversal.

### Single-pass inner loops

`foldSinglePassInnerLoops` removes an inner `while` whose body cannot fall
through or continue to its own header. Its bare breaks become continues of
the immediately enclosing loop only when normal inner-loop completion already
reaches that loop's next update/test point without intervening actions. Literal
`true` headers become intact blocks, or flatten a declaration-free body into its
parent block. Other headers become ordinary `if` statements with the original
condition evaluated once; scalar statement slots keep braces.

The lexical destination resolver checks every original break and continue,
including syntactically dead ones and finally overrides. A terminal corridor
may pass through blocks, branches, labels, catches, try bodies and monitors.
It cannot pass through a switch or an enclosing finally: normal completion of a
finally resumes a pending return/throw, whereas a continue would override it.
Protected constructs inside the removed loop stay whole. An inner finally's
own break can still override a pending completion at the same outer boundary.
Inner labels, own backedges, body fallthrough, suffix actions, unsupported
resource syntax, nested execution and source/nesting/transfer limits refuse.
No predicate, callback, selector or assumed control-flag value is introduced.
Diagnostics identify the loop/body/header, original transfers, exact outer loop
and terminal corridor for independent javac auditing.

`node --test test/singlePassInnerLoopRecovery.test.js` covers eight groups.
Native independent models compare 31,104 cases across 48 outer-loop/protected
contexts plus 50 inner-finally override cases. They check outer updates and
condition effects, nullable guards, aliases, partial writes, overflow, returns,
throws, close callbacks, monitor release and finally priority. Source publication
requires independent completion/corridor/destination evidence, every retained
binding and protected scope, full compilation and byte reversal.

### Exact self casts

The final emitter calls `simplifySelfCasts` with its actual erased source class
header. Casts such as `((Owner) (this)).field` become `this.field`; argument,
constructor, return and monitor expressions receive the same cleanup. The
caller must provide the exact source type and confirm that it has no type
parameters. Different class casts, ordinary receivers, nullable expressions,
boxing and qualified enclosing `this` retain their original source.

Only exact owner casts around the bare `this` expression are eligible. No
initializer value, hierarchy guess, field or callback is evaluated by recovery.
The original and resulting frontend ASTs must match after ignoring parentheses
and these exact self casts. Calls and syntactic control/monitor parentheses
remain distinct. Nested execution, annotations, translated offsets and excessive
source, nesting or cast counts refuse. Diagnostics identify the original `this`
and each removed cast-type token range, allowing independent publication audits
to verify the type references removed and every surviving binding.

`node --test test/selfCastRecovery.test.js test/javaAstEmitterIdentityCasts.test.js`
passes 11 groups. The self-cast native fixture compares 810 cases across six
completion contexts, covering overloaded calls, hidden fields, aliases,
constructors, retained runtime checks, boxing, partial effects, finally priority
and monitor release. Existing local identity-cast tests remain unchanged.
Corpus publication requires independent javac proof of exact self types, full
AST and surviving occurrence-binding comparison, compilation and byte reversal.

### Guarded primitive assignment sequences

`foldGuardedAssignmentSequences` reconstructs a frame that provisionally assigns
several primitive locals or parameters, then either keeps the sequence or
assigns a complete fallback sequence. It emits one ordinary `if/else` with
`originalCondition && keepGuard`. Both conditions occur once; both assignment
sequences retain their original statement order and assignment conversions.
No selector, repeated predicate or assumed flag value is introduced.

Both arms must assign the same unique primitive destinations exactly once.
All right-hand sides and the keep guard must be total primitive expressions.
The guard cannot read a destination, and no fallback value can read any
selected destination: those reads would observe discarded provisional stores.
Provisional values may depend on earlier provisional assignments. Calls,
unboxing, arrays, fields, division, remainder and mutations refuse recovery.
The original condition may have effects or throw; it still executes once,
before either sequence. Protected scopes and enclosing statement slots remain.
The shared primitive proof verifies binding scope and type without inferring
values. Diagnostics identify both sequences and the sole consumed labeled exit.
Bodies, regions, destinations, nesting and label counts are bounded.

`node --test test/guardedAssignmentSequenceRecovery.test.js` covers nine groups.
Independent native models compare 10,800 cases across six completion contexts,
including partial condition effects, nullable unboxing, signed overflow,
finally overrides and monitor release. Seven primitive models add 294 cases
for narrowing conversions, integers beyond double precision, NaNs and signed
zero. Full corpus compilation and independent binding/transfer audits remain
publication requirements.

### Guarded primitive-local value selection

The final emitter phase also recognizes a provisional local assignment followed
by a keep-value guard and a fallback assignment. For example,
`Pick: { if (test()) { value = 235; if (flag == 0) break Pick; } value = 285; }`
becomes `value = (test()) && (flag == 0) ? (235) : (285);`.
The condition remains evaluated once, with its original effects and unboxing.
The captured flag remains a value read; its initializer is never treated as a
constant. The guard and both value expressions must be total expressions over
proven primitive locals or parameters. Calls, fields, arrays, unboxing,
division, remainder, mutations and unsupported syntax refuse the proof.
Neither the guard nor the fallback may read the destination: those reads would
observe the provisional store on the original path. Only a uniquely scoped
primitive local is a destination; fields, arrays and formal parameters remain.

The value expressions must have the same Java primitive type, avoiding
conditional numeric promotion and precision changes. Narrow destinations use
an explicit byte/short/char cast when required to preserve assignment conversion
and compilation. Parentheses retain every numeric expression's association.
The exact frame contains no extra actions, declarations or protected boundary;
enclosing try/catch/finally and monitor scopes stay in place. Diagnostics identify
each original value, guard, local store, declaration and consumed labeled exit.
The generic primitive-expression proof is shared with redundant-exit cleanup;
it proves types and scope, not values.

`node --test test/guardedLocalAssignmentRecovery.test.js` checks the normal
emitter phase, token origins, dependencies, scope and refusal cases. Native
independent tables compare 30,240 cases across six completion contexts, with
condition callbacks, nullable unboxing, partial failures, signed overflow,
finally overrides and monitor release. Nine primitive models add 378 typed
cases for narrowing, signed zero, NaN and integers beyond double precision.

### Effect-free guards with identical exits

The final cleanup also removes a guard such as `if (flag == 0) break; break;`
when both exits have the same kind, spelling and resolved lexical destination.
Matching exits in both arms are reduced to the original first exit. Colon-case
fallthrough is eligible only when its next statement is the matching exit;
work in the next case prevents removal. No loop, case, action or protected
region moves. A return is eligible only when it has no value.

`redundantExitGuardRecovery.js` proves that guard evaluation consists solely of
explicitly scoped primitive local/parameter reads, literals and supported
effect-free operators. It makes no assumptions about captured values, including
negative/nonzero flags, NaNs or signed zero. Declarations, initializers and
mutations elsewhere stay intact. Fields, calls, arrays, casts, unboxing,
allocation, assignments, increments, division and remainder refuse recovery.
Unknown types, shadowed bindings, ambiguous syntax and nested execution also
refuse. Optional diagnostics enumerate character deletions without retaining
the proof tree.

Seven new focused groups include ten independent native completion/event
models covering 192,000 cases: capture callbacks and injected failures,
case fallthrough, cyclic mutation/overflow, finally overrides, monitor ownership,
floating values, nullable unboxing and division failures. Run:

```sh
JAVA_TOOL_OPTIONS=-XX:-UsePerfData NODE_PATH=/home/kreijstal/git/java-tools/node_modules node --test test/terminalControlCleanup.test.js test/javaAstEmitterLoopExits.test.js test/javaAstEmitterTrailingLoops.test.js test/cfrBranchMergeRegressions.test.js
```

Result: 106 passing tests and one existing optional corpus skip. This is generic
Java reconstruction; publication still requires independent complete-corpus
type/binding/destination and source-byte proofs. Catalog-wide effects are not
yet verified.

## Why our own decompiler?

### Finishing work after repeatable loop prefixes

`simplifyPredicateNegations` optionally accepts `ownedFields: {owner, fields}`,
where each field has its emitted `name`, Java `type` and Boolean `static` flag.
CFR supplies only declarations on the current class, using the original field
descriptors and the same spelling policy as field emission. Direct `this.field`
and unshadowed current-class static accesses can prove integral operands,
including array elements and lengths. Inherited, arbitrary-receiver and free
field names remain unknown; boxed/floating comparisons retain unboxing and NaN
behavior. Only predicate operators change. Volatile reads, receivers, increments,
array checks, callbacks and protected completion stay in their original order.
This typed field phase runs after existing structural cleanup.
Class-qualified evidence additionally requires `classQualifierUnshadowed: true`:
CFR checks every superclass and interface for fields or member types hiding the class name. An
unknown ancestor declines that evidence. Locals/formals and a same-named own field
still refuse; direct `this.field` evidence does not depend on this flag.

`simplifyPredicateGrouping` removes redundant parentheses only in if/while,
braced do-while and for conditions. It retains every operator and operand and
preserves exact association, including same-precedence right-hand Boolean
chains. Mandatory control/cast/call parentheses and arithmetic/comparison
operands stay intact. Lower-precedence groups remain explicit. Diagnostics
record only matched parentheses and one-character deletions. Comments, Unicode
translation, nested executable scopes and uncertain syntax decline recovery.
CFR runs this last, after all structural and operator choices.

`foldTerminalLoopTails` handles an infinite loop with a repeatable prefix,
finishing work and a final bare own-loop break. Every other own transfer must
be a continue inside the prefix. Moving that same final break before the
finishing work makes the prefix's normal completion leave the loop; the intact
finishing work then runs once after it. No predicate is moved or reevaluated,
and no field or control-flag value is assumed. Earlier own breaks, including
finally overrides, refuse recovery because they originally skip finishing work.

Each moved statement remains whole. Direct prefix declarations refuse because
their loop scope would not reach the continuation. Direct tail declarations
retain a block, and scalar/case parents retain a wrapper around loop and tail.
All inner/nonlocal transfers and protected/monitor groups keep their targets.
Diagnostics record a token permutation, including the original break, rather
than synthesizing another execution path. This runs last in source cleanup.

Run:

```sh
JAVA_TOOL_OPTIONS=-XX:-UsePerfData NODE_PATH=/home/kreijstal/git/java-tools/node_modules node --test test/terminalControlCleanup.test.js test/javaAstEmitterLoopExits.test.js test/javaAstEmitterTrailingLoops.test.js test/cfrBranchMergeRegressions.test.js
```

Result: 113 passing tests and one existing optional corpus skip. Seven new
focused groups include eight independent native event/completion models matching
69,120 cases, including predicate callbacks/nullable unboxing, partial effects,
signed overflow, return/finally priority, monitor ownership, declaration shadowing
and refusal of early own breaks. Publication separately requires exact complete
source replay and independent compiler binding, transfer and protected-scope
evidence. Catalog-wide effects remain unverified.

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

Exception-region reconstruction also checks the normal control-flow edges of
each try and handler component. The contract retains the source graph before
controlled splitting. An independent tree traversal resolves labeled breaks,
continues and fallthroughs to the next executed block, then compares each
conditional arm and switch key with that graph. Switches follow Java's case
fallthrough rules, so a lost case exit cannot masquerade as normal completion.
Every emitted copy must keep
those edges. Terminal-only components are checked as well. After nested regions
are composed and labels renamed, these checks run again, followed by a check of
the outer collapsed graph and its selector-routing branches. Failure declines
structured recovery and preserves the existing CFG fallback.

This catches gaps that sink identity alone cannot detect: deleting both a sink
and its transfer while a sibling still reaches that sink, swapping two intact
exit branches, or redirecting a continue to another valid enclosing loop. Inner
collapsed regions are opaque blocks in their parent's graph and have separate
component checks. These checks cover normal control flow before printer cleanup;
they do not prove expression evaluation, exception-table normalization, selector
expression generation, or whole-program equivalence.

Focused regression commands:

```sh
node test/structuredFlowVerifier.test.js    # 6 graph checks
node test/javaAstEmitterLoopExits.test.js   # 7 checks, including 424 native comparisons
node test/exceptionStructurer.test.js       # 30 checks, including damaged trees
node test/cfrExceptionLoopExits.test.js     # 1,368 native JVM comparisons
node test/cfrNestedLoopSplitting.test.js    # 840 native JVM comparisons
```

An isolated export from the pass-14 decompiler plus these checks reproduces all
303 pinned GeoBlox Java files byte for byte, and all 303 compile with the frozen
FunOrb stubs. Its two existing operand-stack dispatchers remain unchanged; this
exit-validation change introduces no additional fallback. Earlier uncommitted
parallel-backedge improvements are excluded from that comparison.

### Loop-header reconstruction must distinguish internal breaks

The Java emitter also needs an exit proof when moving an arm or trailing
statements out of a `while (true)` loop and rebuilding its header condition.
An inner loop is not automatically an abrupt exit from the outer arm: a break
to that inner loop completes it normally. The same is true of a labelled block
whose body breaks to its own label. Treating either as an unconditional exit
can move work outside the outer loop and change iteration behavior, even when
the source-edge contracts passed before emission.

`alwaysExits` now checks the destination of breaks before claiming that a loop
or labelled block always leaves the arm. The search includes conditional arms,
switch cases, catch handlers, and synchronized bodies. A possible internal break
keeps the original loop structure. This is deliberately conservative about dead
branches: it does not attempt a new reachability proof. Real returns, transfers
to enclosing labels, and inner loops without an internal break can still justify
header reconstruction.

`node test/javaAstEmitterLoopExits.test.js` exercises both exit-arm and trailing
statement reconstruction. Four printed Java fixtures compare results and effect
traces against native Java over 106 limits each, including exceptions caught
inside the inner loop and exits through synchronized bodies. Against the prior
emitter, the regression tests fail and the first printed fixture loses the
outer iteration, producing a missing-return javac error. With the destination
check, all seven tests and all 424 comparisons pass. The existing exception-loop
fixture's 504 comparisons, nested-cycle fixture's 840 comparisons and parallel
operand fixture's 6,650 comparisons also pass.

A fresh export with this emitter change reproduces the pass-15 GeoBlox output
and diagnostics byte for byte: 303 Java files, zero hard failures and zero
dispatchers. Its Java source tree SHA-256 remains
`6b638e579bfeb73adbb6583b0581f4d6df93c9ca5930816ea81bf1a48aa3f015`.
This is an output compatibility check, not whole-game behavioral equivalence;
the existing publication remains pinned to its original generator commit.

### Reconstruct terminal protected loop arms without splitting their regions

The emitter can now recognize an intact `try/catch` arm as an unconditional
exit when both its body and every catch always leave. A normally completing
body or catch, or a break consumed by an inner block or loop, retains the
original `while (true)`. A `synchronized` arm can likewise leave when its body
always leaves. Unsupported finally-bearing trees remain conservative. The
existing rotation checks still refuse references to the rotated loop label
and work before its condition.

This moves the entire protected arm after the reconstructed loop header; it
does not move individual expressions across a try or monitor boundary. Catch
order, nested protection, monitor acquisition and release, and original
rendering order stay intact. The same proof applies to protected trailing
statements after an empty exit arm.

Focused validation:

```sh
NODE_PATH=/home/kreijstal/git/java-tools/node_modules node test/javaAstEmitterLoopExits.test.js
NODE_PATH=/home/kreijstal/git/java-tools/node_modules node test/cfrExceptionLoopExits.test.js
NODE_PATH=/home/kreijstal/git/java-tools/node_modules node test/exceptionStructurer.test.js
```

The emitter suite has 26 groups, including 2,240 new native comparisons across
both rotation shapes and five protected-region layouts. They compare values,
effect traces, specific-before-general catch priority, throwable identity,
null monitor failures, lock ownership during completion, and monitor release.
The other two suites retain their six and 36 passing groups respectively.

The fresh export still reproduces all 303 currently pinned GeoBlox sources
byte for byte, with zero hard failures and zero fallback methods. This proof
extension does **not** remove any of its 11 retained region selectors or improve
its current source layout. The readable publication and its generator pin are
unchanged. Those selectors need a separate proof for their shared continuations;
this check does not establish whole-game behavioral equivalence.

### Remove routing that has no observable continuation

A separate cleanup uses the exception structurer's allocated selector identities.
It removes a selector only when its exact initialized `int` declaration is
present and every source occurrence is a standalone decimal-literal store or
an equality/inequality comparison with two empty block arms. Complete parsing
and token accounting refuse live reads, shadowing, field lookups, captures,
effectful stores or tests, unsupported syntax, Unicode escapes and scalar
statement bodies that would become invalid Java when deleted. Other declarations
cannot refer to the removed local. Only the proven statements and declaration
are erased; try, catch, finally and monitor extents remain unchanged.

`NODE_PATH=/home/kreijstal/git/java-tools/node_modules node test/javaAstEmitterLoopExits.test.js`
passes 29 groups. The three added cleanup groups include 96 native comparisons
of effects, specific-before-general catches, throwable identity, monitor
ownership/release, finally effects, repeated loops and nullable empty tests that
must still throw. The six exception-loop and 36 region-contract groups also pass.

The candidate GeoBlox export changes only `ic.a(B)V`: its cache write now has
one fewer local, two fewer stores and no empty post-catch test. The two cache
calls, catch assignments and subsequent packet-offset update stay in their
original regions. All 303 sources export without hard failures or fallback
methods; retained selectors decrease from 11 to 10. This does not justify
removing selectors that choose observable or throwing continuations, nor does
it establish whole-game equivalence.

### Coalesce terminal work inside existing plain blocks

Tail reconstruction now descends into plain blocks while retaining their braces
and declaration scopes. Each block and braced conditional arm uses its own
terminal continuation. Existing loop, label, try and monitor bodies remain
opaque; no loop-completion assumption is added.

When ordinary continuation factoring refuses an opaque prefix, exact whole
return/throw tails can still use the existing plain-block skip proof. Breaks
at the end of that newly introduced block are removed only through trailing
ifs and plain blocks. Conditions still evaluate; old labels and protected
regions are not entered. A new label with no remaining transfer is discarded.
A retained new label is refused when its prefix exceeds 512 Java tokens, avoiding
an extra exit frame around a large method merely to share a small cleanup.

The GeoBlox candidate removes 189 lines across seven files and reduces retained
selectors from ten to nine. `ba.b(I)V` now clears its task reference
once after the null-task/status/join paths. Its synchronized close/notification,
volatile status-wait loop and InterruptedException handler stay intact; the
resulting empty selector test is removed by the existing allocator-bound cleanup.
No generated plain-block exit label remains in the game export. This does not
establish equivalence of asset-dependent rendering or live network operation.

Focused checks:

```sh
NODE_PATH=/home/kreijstal/git/java-tools/node_modules node test/javaAstEmitterLoopExits.test.js
NODE_PATH=/home/kreijstal/git/java-tools/node_modules node test/cfrExceptionLoopExits.test.js
NODE_PATH=/home/kreijstal/git/java-tools/node_modules node test/cfrNestedLoopSplitting.test.js
```

The emitter has 31 passing groups, including 432 new native comparisons for
plain-block scopes, retained skips over intervening work, finite/infinite-loop
syntax, nullable tests, catch priority, checked/fatal throwable identity,
finally effects and monitor ownership/release. The two integration suites retain
six and three passing groups. Original shadowed locals and opaque region bodies
remain unchanged in the refusal fixtures.

## Parallel operand copies at loop backedges

Multiple live operand-stack values no longer force a dispatcher by themselves.
The owned CFG renderer uses typed join carriers. If outgoing values or the
consumed condition/selector read a carrier that the edge is about to overwrite,
it snapshots those values before assigning the destination carriers. Copies are
parallel: a swap must not overwrite the source of its second assignment. The
post-copy values are also retained for forwarding through single-predecessor
blocks, so a later branch or return cannot read the overwritten old expression.
A successor cannot forward its own carrier away; cyclic aliases retain their
stores and declarations rather than deleting each other.

The legacy range recognizer does not carry permutations around loops. A
backedge containing swap or an inserting dup therefore selects the owned CFG
renderer, including when a switch is the only backward transfer. Existing
exception-region, synchronized, source-flow and code-size gates still apply.

`node test/cfrParallelBackedges.test.js` covers six operand-permutation fixtures
and six comparison fixtures. It compares original verified bytecode with both
structured and forced-dispatcher execution: 6,650 result/effect comparisons,
including int, long, references, consumed conditions/selectors, nonzero flags,
array failures and catches. This is scoped differential evidence, not proof of
whole-game equivalence.

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

## Typed complement comparison readability

Integer and long XOR with a literal -1 now render as `~value` by default.
Comparisons of that expression against a literal at the same signed JVM width
reverse the operator and complement the constant. For example,
`(characterCode ^ -1) <= -129` becomes `characterCode >= 128`. Constant-first
comparisons preserve evaluation of the other operand exactly once.

Only canonical decimal literals within the signed 32-bit or 64-bit range are
accepted. Inferred constant metadata does not authorize removing a call, and
casts do not retain complement identity. Other XOR masks, booleans, mismatched
widths and floating-point operands remain outside this rewrite. Experimental
identity folding and interclass DCE retain their existing opt-in flag.

`node test/cfrComplementComparisons.test.js` validates default behavior and
refusals, then compares original verified JVM execution with structured and
forced-dispatcher reconstruction. The 220 methods cover all six comparisons,
both operand orders, nine constants at each width, 15 boundary inputs plus
throwing calls, byte narrowing, another XOR mask and two effectful operands.
All 7,040 result/effect-trace comparisons must match.

## Nested numeric negation must not become a decrement

JVM `ineg`, `lneg`, `fneg` and `dneg` change a value, not the local that supplied
it. Adjacent rendered minus signs are unsafe: Java lexes `--x` as a decrement,
so two JVM negations printed without parentheses mutate `x`. Negative literals
have atomic precedence too, so precedence checks alone cannot prevent `--7`.
The numeric-negation renderer now parenthesizes an operand beginning with a
minus sign, producing `-(-x)` or `-(-7)` without folding its evaluation.

The actual GeoBlox result-sequence probe found this in sprite rotation: the
source-pivot calculation decremented its argument, changing the rendered pixel
buffer and later result timing. A fresh export changes six expressions across
`dm.java` and `il.java`; bytecode inputs and method/local identities are unchanged.
The generic fix is not a patch to those game classes.

Run `node test/cfrNumericNegation.test.js` for 274 native JVM comparisons in
ordinary and forced-dispatcher modes. The fixture retains two, three and four
successive negations for all four numeric types, tests signed integer limits,
floating-point signed zero, subnormals, infinities and NaN payloads, checks an
unchanged input used again, negative literals, a real decrement and one evaluated
call with normal and throwing outcomes. This tests numeric emission and evaluation
order, not whole-game equivalence.

## Preserve exception context when reconstructing loop exits

Normal CFG edges and sink-to-transfer identities alone cannot prove a try/catch
composition safe. Exchanging intact try and handler components preserves their
internal edges, but changes which effects execute normally and which exceptions
protect them. Reordering whole catches also preserves component graphs while
changing handler priority.

Each collapsed region now retains an independent snapshot of the protected-body
and catch-arm bindings, including ordered catch types and intentional nested
catch structure. Synchronized components retain the lock local and acquisition
PC. After composition, every emitted region copy must match that snapshot, and
every component must remain under its own region. Catch-type arrays are copied,
so later in-place mutations cannot change the evidence. Label and catch-parameter
renaming remain valid. A mismatch declines reconstruction and keeps the CFG
fallback. This checks composition, not the original exception-table normalization
or subsequent expression/printer transformations.

The expanded native loop-exit fixture also exposed a fallback bug: the last
typed handler was treated as an unconditional catch-all. An unmatched
`AssertionError` went into a `RuntimeException` handler and became a
`ClassCastException`. The dispatcher now tests every typed handler in table
order. Only an actual `Throwable`/catch-all row supplies an unconditional target;
otherwise it rethrows the same throwable through the existing generic helper.
It does not wrap checked exceptions or execute handler effects on a mismatch.

Handler dominance also does not prove that its whole normal continuation shares
the same enclosing exception coverage. javac duplicates `finally` cleanup after
catch-arm breaks, continues and returns, outside the outer catch-all's protected
ranges. Absorbing that cleanup into a collapsed inner catch moved it under the
outer catch-all. If cleanup threw, the reconstructed method ran cleanup again.
The native regression's first failing trace was `1:0,CF1,F2,`; native execution
produced `1:0,CF1,` and propagated the same `AssertionError` after one cleanup.

Region collapse now retains the original throwing instruction PCs, including
those in previously collapsed components. Handler carving stops before a block
whose enclosing protected-range coverage differs from the region entry, and
keeps only the handler blocks reachable without crossing that boundary. The
excluded continuation becomes an explicit exit sink, so cleanup stays outside
the enclosing catch. Widening over proven nonthrowing glue remains supported.
Before accepting a collapse, all retained throwing PCs must also match the
entry's coverage in every remaining exception group; incompatible protected
bodies or handler entries decline reconstruction and retain the CFG fallback.

Sibling catches with overlapping types also need exact exception coverage.
When identical complete protected-range sets list `RuntimeException` before
`IllegalArgumentException`, the later catch cannot handle an exception thrown
by the first handler. Nesting those catches to satisfy javac widens coverage:
the old reconstruction swallowed a cleanup failure and continued the loop.
The first native mismatch was `0:1:1:1:93:W1,CNW2,W3,`; the original bytecode
returned `0:1:1:1:IllegalArgumentException:true:W1,C`.

Such sibling groups now decline reconstruction with `shadowed sibling catch
requires exact exception-table routing`. The existing CFG dispatcher preserves
their ordered table rows, original throw sites and throwable identity. This
also covers partially shadowed multi-catch alternatives, catch-all rows and
application types resolved through the supplied hierarchy. Specific-before-
supertype siblings still structure normally. Genuine enclosing catches have
different complete range sets and retain their existing reconstruction; no
handler coverage is invented merely because Java rejects a sibling catch.

Range nesting also does not establish the original table's priority. A broader
outer row may precede a narrower inner row even when the outer range covers the
inner handler. Reconstructing the smaller range first then sends an exception
to the inner handler, although native execution chooses the outer handler.
The version-49 regression demonstrates this on a catch-arm loop continuation:
native `0:1:0:0:93:W1,OW2,W3,` became `0:1:0:0:93:W1,IW2,W3,`. The return
value agrees, but the handler effects differ.

Before carving, the structurer now compares the original table with the planned
region order at each live instruction that can throw. Adjacent alternatives
with the same handler may combine, and redundant alternatives covered by a
broader type in that same handler may disappear. Handler order and coverage
otherwise have to agree exactly. This also catches priorities that change
between disjoint protected ranges, and self-protected handlers whose throwing
instructions would be lost by normalization. Liveness includes all exception
handler entries, not just normal paths from the method entry. Proven nonthrowing
instructions do not require exception coverage.

A mismatch reports `exception-table priority or coverage changes at throwing
pc ...` and retains the original-table dispatcher. The check is intentionally
conservative: even a different order of unrelated handlers may decline. Existing
exit, component-binding and enclosing-coverage checks still run for regions
that pass this preflight.

Focused commands:

```sh
node test/exceptionStructurer.test.js       # 35 checks; includes boundaries, sibling and nested table priority
node test/cfrExceptionLoopExits.test.js     # 7,200 native result/effect comparisons
node test/cfrNestedLoopSplitting.test.js    # 840 native comparisons
node test/structuredFlowVerifier.test.js    # 6 checks
node test/javaAstEmitterLoopExits.test.js   # 7 checks, including 424 native comparisons
node test/exceptionRegionSplitting.test.js  # 4 checks, including 512 routed traces
node node_modules/tape/bin/tape test/cfrCatchSemanticsRegressions.test.js
```

The new ordered-handler fixture covers inner/outer breaks and continues from
the try and both catch arms, specific-before-supertype handler priority,
exceptions outside the protected range, unmatched errors and checked exceptions,
and escaped throwable identity. Structured and forced-dispatcher output must
match native execution. The original fixture contributes 504 comparisons and
the ordered-handler fixture contributes 864. The finally fixture adds 1,848
comparisons across six exit modes, 14 exception positions and 11 cleanup-failure
positions. It checks cleanup effects, preserved return values, cleanup exceptions
overriding pending transfers, and escaped throwable identity. Both ordinary
structured output and the forced CFG dispatcher must match native execution.
The finally fixture and the new structural boundary check fail on commit
`8e04627fac5198652db34c7bf8c363463a1e3b0c` before handler carving was bounded.

The shadowed-sibling fixture adds 3,600 native comparisons. Version-49 bytecode
tests runtime-supertype and catch-all priority tables, plus a valid ordered
control, across loop continues, breaks, returns and normal continuation. Work
and handler cleanup can throw specific runtime exceptions, other runtime
exceptions, errors or checked exceptions. Both default and forced-dispatcher
exports compile with `javac --release 8` and match native result/effect traces
and escaped throwable identity. Shadowed default output must retain its
dispatcher, while the ordered control must remain structured. The native and
structural regressions fail on `38a83d19e58776bbc4dd1b794811aa1a5963996a`.

The nested-priority fixture adds 384 native comparisons across outer-first and
inner-first tables, four loop-exit modes, six work-failure positions and both
inner/outer cleanup failures. Default and forced-dispatcher Java must match
native return values, ordered effects and escaped throwable identity. Only the
outer-first default requires the dispatcher; the inner-first control remains
structured. This regression fails on
`e6dd72c89fa7f51cc34cd78d08cf5c6227799126` before the priority preflight.
The updated generator reproduces all 303 pass-20 GeoBlox sources and diagnostics
byte for byte, with zero dispatchers or hard failures. The source-tree SHA-256
remains `07610c2d655bf96e59584f07be867c62e47cf3b3c484063504d9958443e89da2`;
this is a game-source digest, separate from the decompiler source-archive digest.

The earlier component-binding hardening preserved all 303 pinned GeoBlox
sources byte for byte. Bounding handler continuations changes only `oc.java`:
the arithmetic guard after a swallowed `maxMemory` reflection failure now stays
outside the enclosing `Exception` handler, as in the bytecode. The fresh export
still has zero hard failures and zero dispatchers, and diagnostics are unchanged.
All 303 sources compile in the result-sequence probe and match the recorded native
trace through 27 result scenarios and 26,043 ticks per variant. That probe does
not inject reflection failures into `oc.a(I)V`; the generic finally fixture
supplies the failure-path evidence.

The published readable input remains pinned to its recorded generator. These
fresh export artifacts are validation output, not an updated publication or a
declaration/name migration. The checks do not establish whole-game equivalence.

## Preserve JVM floating comparison behavior

The expression IR now retains the opcode for `fcmpl`, `fcmpg`, `dcmpl`,
`dcmpg` and `lcmp`. The low variants yield -1 for unordered operands; the
high variants yield +1. Rendering each as a Java relational comparison loses
NaN behavior. In GeoBlox's score-popup loop, native `fcmpl; iflt` keeps a
NaN-progress popup active, but the previous `progress < 1.0f` source credited
it instead. The corrected branch is `!(progress >= 1.0f)`.

Branch emission selects the ordered relation or its logical complement from
the exact opcode and integer branch. Negation retains this comparison metadata,
including across nested materialized booleans. Relational expressions without
integral type evidence retain logical `!` rather than exchanging `<` for `>=`.
This preserves NaN behavior; equality comparisons may still invert directly.
Redundant outer logical negations can cancel without assuming an ordered value.

A compare result used as a value now calls a small primitive helper rather
than an undefined `compare(...)` placeholder or a ternary that repeats operand
expressions. This covers stores, arithmetic, arguments and duplicate results.
Helper parameters evaluate the original operands once in left-to-right order,
including when either operand throws. Helper comparisons treat signed zero as
equal and never return zero for NaN; `Float.compare` and `Double.compare` would
not match those JVM rules. Only helpers called in accepted source are emitted,
with deterministic names that avoid existing methods/fields. Java 8 interfaces
receive public static helpers, rather than unsupported private methods.

Focused validation:

```sh
node test/cfrFloatingComparisons.test.js
node test/cfrComplementComparisons.test.js
node test/cfrNumericNegation.test.js
node test/cfrStateMachineReadability.test.js
node node_modules/tape/bin/tape test/cfrStructuredFeatures.test.js test/cfrAdditionalFeatures.test.js
```

The floating fixture performs 75,000 native comparisons over float/double
NaNs with distinct payloads and signs, infinities, finite extremes, subnormal
values, both zeros and signed long extremes. Every comparison opcode is tested
against all six unary branches, inverted returns, materialized/nested boolean
joins, stored results, arithmetic, method arguments, operand effects and
duplication. It also checks failure order and throwable identity, existing
helper-name collisions and interface compilation. Default structured output
and forced CFG output both compile under `javac --release 8` and match native
version-49/52 bytecode traces. The branch, value and unknown-type negation
regressions fail on `824823f7c767cd61f75f0a2b62e786c529e1a48b` before this fix.

The standalone state-machine fixtures also now supply the same throw-owner
and generic escape helper that production class emission already provides.
This corrects a stale test harness after the prior unmatched-throw hardening;
all 11 dispatcher readability checks compile and pass.

## Proving loop updates before recovering `for`

While-to-for recovery now parses the complete body and proves that every normal
or own-continue backedge contains exactly one update selected for removal.
Every break/return/throw/other exit must contain none. Other writes to the
counter, shadow declarations, unsupported syntax and Unicode escapes refuse
recovery. Nested loop, label, try, finally and monitor bodies remain opaque;
updates or own continues within them cannot move to the header. Both the early
linear loop renderer and later CFG text cleanup use this proof.

The former continue-only inference found an increment before a null-entry
continue in GeoBlox dispatcher shutdown and lifted it into the for header,
leaving increments in the success/catch arms. This skipped cache indices 1 and
3 in a five-entry fixture. Native bytecode closes every entry. Preferences
search has the same continue/caught-failure shape. These loops now retain
explicit while backedges at their original protected boundaries. Eligible
ordinary counting loops still become for loops.

`test/cfrExceptionLoopExits.test.js` includes direct refusal/acceptance checks
and 600 native protected-counter cases, each compared with structured and
forced-dispatcher recompilation (1,200 comparisons). The independent visitation
oracle checks skipped/present entries, caught IOException, uncaught runtime
failures/errors, final counters, effect order and throwable identity. GeoBlox's
existing native probe separately covers 96 cache-shutdown combinations of null
entries and close failures, including handle retention and monitor release.
This is evidence for those scopes; goto-free output and successful compilation
alone do not establish whole-corpus runtime equivalence.

### Unread receiver snapshots

The structured renderer can discard allocator-owned Object stack slots when
their complete source occurrences are standalone assignments of `this` or
`null`. A single default-null declaration must match the allocator identity;
parsed AST statements and lexer offsets account for every occurrence. Reads,
other initializers or right-hand sides, casts, aliases, field access, shadowing,
scalar statement bodies, unsupported syntax and Unicode escapes refuse cleanup.
Conditions, handler ranges, monitors, loops and transfers stay in place. No
allocation, field/array read, call, class initialization or throwing cast is
deleted by this proof. The pass applies after existing selector cleanup and
before optional structured-method partitioning; dispatcher fallback is unchanged.

`test/javaAstEmitterLoopExits.test.js` adds proof acceptance/refusal checks and
96 native original/rebuilt comparisons for condition effects, failure identity,
catch priority, finally overriding pending failures, null locks and monitor
release. These fixtures establish that limited transformation scope; full
GeoBlox execution remains separately unverified.

## Resolving equivalent stack joins to a fixed point

Typed operand-stack copies previously survived when the incoming edges named
several carriers that earlier proofs already aliased to one value. The renderer
now revisits complete incoming-edge proofs until no further same-type copies
can be resolved. It keeps incomplete or effectful edges, conflicting values,
self references and alias cycles (including chains feeding cycles). Reference
copies between allocator-owned carriers of exactly the same declared type no
longer widen through Object; ordinary locals and differing verifier types keep
the existing coercions. Conditions, parallel-copy snapshots, handlers and
monitors remain at their original execution points.

Deleted stores also left large runs of blank lines. A lexical pass compacts only
gaps containing whitespace; comment-containing gaps, string/character/text-block
tokens, Unicode escapes and lexing failures retain their original bytes.
This presentation step runs after helper partitioning and loop recovery.

The partition suite exposed a pre-existing budget defect, reproduced at
049d323: helpers budgeted original returns, then expanded them into shared
completion-flag stores. Two helpers reached 24,290/24,296 characters and were
rejected, producing a dispatcher. Packing now includes the actual return-store
expansion instead of raising the budget or changing the fixture expectation.
All six partition regressions check their expected structured/fallback modes
and native behavior, including parameter mutation, checked catches and
nonlocal loop exits.

`node test/cfrParallelBackedges.test.js` passes 16 groups: the existing 6,650
native comparisons plus 1,440 new comparisons for protected/unprotected typed
joins in structured and forced-dispatcher modes. The new fixtures retain the
original reference and integer after parameter reassignment and check identity,
null/empty strings, signed overflow and caught/uncaught failures. Pure graph
checks cover multi-pass discovery, incomplete edge counts, type conflicts and
cycles. Separate tests protect comment/literal bytes during blank-line cleanup.

The fixed 303-class GeoBlox export compiles. It removes 1,075 allocator-owned
carrier declarations (1,073 locals and two partitioned carrier fields), adds no
declarations and retains all 388 override relationships. Its raw source shrinks
from 85,591 to 80,520 lines across 176 changed files. The pointer-spawn method
loses 15 intermediate locals; genuinely different variant/category values
remain explicit. These are source reconstruction checks, not full-game runtime
or browser-performance evidence.

## Token-safe carrier aliases and primitive value joins

Carrier aliases previously used whole-source regular-expression substitution.
A native typed-join regression demonstrates that this changes an original
`"stackIn_3_0"` diagnostic string to `"stackIn_2_0"`. Alias substitution now
requires complete lexical and scope checks and edits identifier tokens only.
Strings, comments, member names and method names keep their bytes. Shadowed
declarations, types, labels, Unicode escapes and unsupported syntax refuse the
cleanup and retain the original carrier declarations and stores.

The Java parser now represents qualified explicit generic calls such as
`cd.<RuntimeException>sneakyThrow(error)` with separate receiver, type arguments,
method name and arguments. Nested generics, bounded nested wildcards, reference
arrays and combined closing-angle tokens are supported; shifts in ordinary
expressions are unchanged. Empty, incomplete or invalid invocation type
arguments retain unsupported nodes. Type names therefore remain visible to
alias scope checks instead of weakening the proof around generic calls.

Same-type primitive local/literal branches can become a conditional assignment
before and after carrier cleanup. Each source and destination must have a
proven identical primitive type. Reference values, boxing, narrowing, mixed
types and effectful right-hand sides keep the original branches. The later
pass uses final declaration types after Boolean promotion, refuses inline
shadowing and keeps protected, monitor, loop and label bodies opaque.
Floating comparisons retain their original Boolean negations, including NaNs.

`node test/cfrParallelBackedges.test.js` covers 18 groups and 8,210 native
comparisons, including diagnostic-string preservation and 120 generic-call
loop cases checking early breaks, continues, failure identity and finally
counter observations. `node test/javaAstEmitterLoopExits.test.js` covers 36
groups and 54,549 native comparisons. Its 11,556 new comparisons cover all
eight primitive types, raw floating bits, overflow, condition effects,
unboxing failures, exception identity and finally observations through both
initial and post-cleanup emission. `node test/javaFrontendAst.test.js` passes
248 assertions, including nested generic calls and invalid-form refusals.

The fixed GeoBlox export removes 50 lines across eight files (80,520 to
80,470), including 12 primitive value branches and an existing URL-validation
loop recovered as a for loop. All 19,558 declarations and 388 override
relationships remain; declaration reordering requires 14 guarded naming-map
ordinal migrations. Native fixtures and source reconstruction do not establish
whole-game equivalence or browser/phone performance.

### Sharing return cleanup through an existing exit block

After local-variable scope normalization, `factorLabeledBlockReturnTails`
matches a plain labeled block followed by a return/throw tail. An identical
terminal copy inside that block can become a break to its existing label.
This shares the cleanup without adding another labeled frame, helper method
or dispatcher. Conditions, preceding effects, local declarations, the final
tail and all other source bytes remain at their original locations.

Replacement can traverse nested loops, ordinary blocks, conditionals and
labels. It never crosses try/catch/finally, synchronized or switch bodies.
Discovery can operate wholly inside a protected region or monitor; both copies
must stay in that same region. Exact token spelling, complete parsed extents,
unique label identity and absence of inner declarations shadowing tail names
are required. Tail declarations, protected/control constructs, unsupported
syntax, Unicode escapes and embedded comments refuse the transformation.
Declarations before the exit block remain in the same enclosing scope and
are supported. Running before normalization would mistake an escaping JVM
local's temporary inline declaration for a different identity, so the pass
runs only after the existing scope reconstruction.

The emitter tests add refusal checks and 2,048 native comparisons across while,
for, enhanced-for and do loops, early exits/continues, nested labels, surrounding
protected/monitor regions, side effects, signed zero/NaN, failure ordering,
throwable identity, shadows and enclosing locals. Protected/monitor crossings
remain intact in the negative cases. The fixed GeoBlox corpus removes one
13-line duplicate publication tail from the Bzip2 run emitter; its other 302
files and diagnostics remain unchanged. The large loop/label structure is
still present, and broader reconstruction requires separate proofs.


### Removing redundant control frames

After scope normalization and existing exit-tail sharing, `simplifyControlFrames`
resolves every labeled break/continue against the lexical Java AST. A jump loses
its label only when an ordinary break or continue reaches the exact same nearest
loop or switch. Outer-loop exits through another loop/switch keep their labels;
labels with remaining references remain. No CFG edge is inferred or introduced.

Unused labels can disappear. A plain block can lose its braces only when it is
a direct statement in another block and none of its direct statements declares
a variable or class. Loop, conditional, try/catch/finally and monitor bodies keep
their braces and ownership. For-header/catch declarations keep their construct
scopes. Protected transfers may lose an unnecessary label, but their statements,
regions and destinations do not move. Literal/member names and all other tokens
are unchanged; removed multiline frames are dedented. Complete parsing, exact
token ranges and unique label names are required. Comments, Unicode escapes,
text blocks, unknown syntax, unbound labels and nested executable bodies refuse
cleanup. The pass repeats only while deleting source, reaching a fixed point.

The emitter tests include two new groups and 2,048 native comparisons covering
nested loops, switches, all loop forms, shadowing, side effects, protected/monitor
exits, failure/throwable identity and lock release. The optional whole-corpus
check uses JDK Java ASTs independently of the JavaScript parser:

```sh
CFR_CONTROL_FRAMES_BEFORE=PREVIOUS_JAVA CFR_CONTROL_FRAMES_AFTER=FRESH_JAVA \
  node test/javaAstEmitterLoopExits.test.js
```

Both directories must contain exactly the same Java file inventory. The checker
compares ordered AST events, expression tokens and resolved transfer destinations,
omitting only block/label frames. For GeoBlox all 303 files match, including
1,129 loop/switch destinations and 1,762 jump statements. All 19,558 declarations,
118,961 reference identities/spellings/order and 388 override rows also match.
The regenerated corpus changes 153 files and removes 588 lines (80,457 to 79,869);
diagnostics remain byte-identical and all sources compile. The full emitter suite
passes 41 groups with the corpus check enabled; exception-exit tests pass eight.
The wider CFR fixture suite passes 33/36: the same three try-with-resources tests
fail on the pinned pre-cleanup baseline, independently of this change. Large
labeled bodies, whole-game execution and browser/phone performance remain outside
these structural and controlled native proofs.


### Recovering literal boolean decisions from exit blocks

`foldLabeledBooleanDecisions` runs after local-variable scope normalization,
before redundant control frames disappear. It recognizes a plain labeled block
whose trailing conditional tree assigns one primitive boolean local a literal
and breaks to that same block, with the opposite literal as the final fallback.
The tree can become a short-circuit expression. For example, nested successful
checks selecting true become `a && b && c`; nested negated checks selecting false
become `a || b || c`. Sequential successful branches become OR alternatives.
Mixed AND/OR grouping and left-to-right evaluation order stay explicit.

Predicate operands keep their original bytes and execution order, including calls,
assignments, nullable unboxing, floating comparisons and failures. Negating a
decision uses logical negation/De Morgan's law; relational operators are never
complemented, preserving NaNs. The remaining assignment executes after the same
predicates and no intermediate leaf store can precede another predicate. Prefix
statements stay before the expression in the same protected/monitor region.

The target must have one visible primitive boolean declaration in an enclosing
block before the decision; shadowed, unrelated, boxed, field and unknown targets
refuse folding. Branch bodies contain only conditionals/plain blocks or an exact
literal store plus the consumed break. Extra effects, alternate branches,
protected/monitor crossings, declarations and other exits refuse it. The shared
complete parser/token proof also refuses comments, Unicode escapes, text blocks,
unknown syntax and nested executable bodies. At most 12 leaf stores and 256
predicate tokens can become one expression. Same-operator grouping is flattened
without changing operand order.

Two focused groups include 13,824 native comparisons across boolean truth tables,
initial values, nullable boxed conditions, NaNs/signed zero, self-modifying
predicates, repeated calls, short-circuit failures, partial state, throwable
identity, surrounding catch/finally and monitor ownership/release. The emitter
suite passes 42 tests; the optional pass77 whole-corpus AST frame-only checker is
skipped when no external directories are supplied. Exception-exit tests pass
eight. That frame-only proof does not assert equivalence of this new boolean
syntax; the native tests and scope/transfer proof cover the decision rewrite.

The fixed GeoBlox input folds 17 decisions across 12 files, removing 156 lines
(79,869 to 79,713), including board-clear eligibility, raster dirtiness,
queue-settled checks, name/host checks and null-guarded calls. All 303 sources
compile and diagnostics stay byte-identical. All 19,558 declarations and 388
override rows remain, without local ordinal migrations. The only removed
references are 17 duplicate local stores; all other ordered binding events match.
These checks leave whole-game execution, real platform/assets/server traffic and
browser/phone performance unverified.

### Recovering void returns from consumed exit blocks

`foldVoidReturnExits` runs after scope normalization and boolean decisions,
before redundant control-frame cleanup. A break to a plain labeled block
immediately followed by `return;` becomes a direct void return. No expression
is evaluated at that destination, and both transfers leave the same protected
and monitor regions. A finally may override either transfer in the same way.
Value returns and intervening work are refused; predicates, effects and exception
regions are not moved. Exact lexical jump destinations and unique labels are
required, and nested executable bodies or unsupported syntax refuse the method.

A separate three-valued normal-completion proof decides whether the trailing
return remains reachable after consuming those breaks. Fallthrough keeps it;
proven abrupt completion removes it; an unknown proof preserves the original
candidate. The proof resolves loop and label exits, including explicit finally
bodies that override break/continue. Simple final primitive boolean constants
require a unique preceding declaration in lexical scope; ordinary runtime
predicates require evidence rather than guessing about qualified constants.
Switch completion and unsupported constant expressions remain conservative.
Resource-header syntax is unsupported by this parser and is left unchanged.

`node test/javaAstEmitterLoopExits.test.js` passes 44 tests, with its optional
pass77 frame-only corpus check skipped. The two new groups include 46,080 native
comparisons of all loop forms, explicit resource-close/finally paths, exceptions,
throwable identity, partial state and monitor ownership/release. Finally return,
throw, outer break and outer continue override pending transfers in the fixtures.
`node test/cfrExceptionLoopExits.test.js` passes eight groups. These tests do not
claim resource-header or whole-game equivalence.

The fixed GeoBlox input consumes 95 jumps in 38 exit blocks across 25 files,
including menu rendering, tutorial input and sprite rotation. Five unreachable
trailing returns disappear. Subsequent control-frame cleanup removes their
unused labels and nondeclaring braces. This removes 81 lines (79,713 to 79,632).
All 303 sources compile, and their ordered 19,558 declaration and 118,944
reference identities/spellings plus 388 override rows match the prior corpus.
Applying only the two documented rules to the previous bodies produces the
exact token streams of all 303 regenerated files. The frame-only AST proof from
pass77 remains historical; it is not evidence for replacing breaks with returns.

### Folding nested braced guards

`foldNestedIfGuards` runs after control-frame cleanup. A braced `if` whose body
contains only another braced `if`, with no alternate on either statement,
becomes a left-to-right short-circuit `&&` guard. Conditions keep their original
bytes and parentheses; the innermost body block retains its declarations and
scope. No expression, effect, try/finally or monitor crosses a protected boundary.
The renderer dedents only whitespace and wraps ordinary multiline guards.

An alternate, intervening statement/declaration, label or protected wrapper
stops a chain. Comments, Unicode escapes, nested executable bodies, unsupported
syntax and invalid statement expressions refuse reconstruction. Operand and
predicate budgets are 16 conditions and 512 tokens; an oversized chain remains
intact rather than folding its suffix. The parser and matching lexical braces
must prove every header and block extent.

`NODE_PATH=/path/to/dependencies node test/javaAstEmitterLoopExits.test.js`
passes 46 tests; the optional pass77 frame-only corpus check remains skipped.
The two new groups include 17,280 native comparisons of short-circuit calls,
nullable unboxing, floating/NaN conditions, primitive/partial stores, throwing
operands, early returns, body declaration scopes, catch/finally effects and
monitor ownership/release. Final state is compared after invocation, including
finally effects on early-return paths. The exception-loop suite passes eight
groups.

The fixed GeoBlox corpus folds 710 guard chains, merging 913 nested conditions
across 131 files. It removes 913 lines (79,632 to 78,719), including the nine
optional-array null checks in mesh projection. Independent JDK source positions
locate method and initializer bodies; applying only guard folding and retained
frame cleanup to the prior corpus reproduces all 303 regenerated token streams.
All 303 files compile. Ordered declaration/reference/override identities remain
19,558/118,944/388, with no local ordinal migrations; diagnostics are unchanged.
Real assets, whole-game execution and browser/phone performance are not proved
by this structural comparison.


### Full integer arguments to narrow static parameters

The JVM uses integer slots for byte, short and char parameters. An invocation
performs no implicit `i2b`, `i2s` or `i2c`. In GeoBlox, a nonzero control flag
forwards a depth comparison operand through a stack carrier into the face
collector's byte guard. The value -8170 must remain -8170; a Java byte cast
changes it to 22 and incorrectly skips sprite-reference cleanup.

For an owned static target reached with an int-typed `stackIn` carrier at a
narrow parameter, the renderer adds a deterministic `$cfr$intArgs$...` entry
point with int parameters. The original method/signature remains. The added
body uses the same bytecode with full-width parameter locals; array/reference
parameters and the return descriptor are preserved. Calls to a selected target
use the new entry point. Earlier callers and owners are rendered again when a
later class discovers the need, so directory/JAR traversal order cannot leave
an unresolved helper. Names use a descriptor hash and avoid existing names.
Diagnostics list the original and generated identities.

The native regression compares 201 invocation results through directory, JAR
and multi-class AST exports, including -8170, byte/short/char limits, integer
extremes and canonical original-signature calls. Separate checks cover name
collisions, arrays/references and refusal for unavailable, nonstatic,
native/abstract and interface/enum targets. This is a correction for owned
static calls through stack carriers; arbitrary direct int expressions,
external methods, virtual dispatch, constructors and boolean encodings remain
outside its proof. The original and generated bodies currently coexist, which
adds source size rather than simplifying this particular method.

### Reconstructing labeled skip guards

`foldLabeledSkipGuards` recognizes a plain labeled block whose initial statements
are braced `if` guards containing only `break` to that block. Every reference to
the unique label must be one of those leading guards. The remainder must be
nonempty. The block becomes an ordinary `if` over the short-circuit conjunction
of negated original predicates; its remainder keeps the original block scope.
Negation uses `!` rather than guessing an opposite floating comparison, preserving
NaNs, unboxing and predicate effects. Nested guard folding runs first and again
when a new ordinary guard exposes another chain.

An alternate, work before a guard, work inside its break arm, a remaining exit to
the same label, a loop/switch label or duplicate/unbound label refuses the rewrite.
Comments, Unicode escapes, nested executable bodies, unsupported/malformed
statements and unknown lexical extents also refuse it. The leading guard chain
has budgets of 16 predicates and 512 tokens. No declaration, call or protected
boundary moves; try/finally and monitors may enclose the entire decision or
remain intact in its remainder. Ancestor and unlabeled loop/switch transfers
retain their destinations.

`NODE_PATH=/path/to/dependencies JAVA_TOOL_OPTIONS=-XX:-UsePerfData node test/javaAstEmitterLoopExits.test.js`
passes 48 tests with one optional historical pass77 corpus check skipped.
Two new groups include 4,032 native comparisons covering ordered/throwing
predicates, nullable booleans, NaNs, declaration scopes, partial effects, ancestor
jumps, switch/loop breaks, early returns, finally effects observed after invocation
and monitor ownership/release. Exception exits retain eight passing groups, and
full-integer argument regression retains two passing groups.

The fixed GeoBlox corpus removes 57 exit-block labels and 66 guard breaks across
25 files, reducing 78,886 lines to 78,689. The main session updater loses five
labels and shrinks from 660 to 643 lines. All 303 sources compile. Independent
JDK body positions plus the documented skip/nested-guard transforms reproduce
all 303 token streams; ordered 19,591 declarations, 119,181 references and 388
override rows remain unchanged. The 21 spans of at least 300 lines (15 with
labels) remain; some spans include nested helpers. This improves individual
control decisions without claiming that the remaining large bodies are solved.

### Removing terminal breaks to plain blocks

`removeFallthroughLabelBreaks` runs after guard reconstruction. A labeled break
can disappear when ordinary completion reaches exactly the same plain-block
destination. The path may contain only final statements of braced blocks,
conditional branches and plain labels. No predicate, effect or declaration moves.
A bare conditional break becomes an empty statement so its predicate still runs.
Existing control-frame cleanup then removes unused labels and scope-safe braces.

Intermediate loops, switches, try/catch/finally and monitors refuse the rewrite;
their continuations or abrupt-completion behavior require a different proof.
Protected regions enclosing the entire destination remain intact. Exact lexical
braces and jump tokens, unique resolved labels and valid ancestor/unlabeled
transfers are required. Comments, Unicode escapes, nested executable bodies,
unsupported syntax, malformed expressions and unknown extents refuse cleanup.
Parser end offsets do not describe complete statement extents, so matching
lexical delimiters establish block boundaries instead.

`NODE_PATH=/path/to/dependencies JAVA_TOOL_OPTIONS=-XX:-UsePerfData node test/javaAstEmitterLoopExits.test.js`
passes 50 tests with one optional historical corpus check skipped. Two new groups
include 5,376 native comparisons of scopes, predicate/work failures, nullable
unboxing, NaNs, ancestor transfers, retained meaningful exits, enclosing finally
state after invocation and monitor ownership/release. Exception-exit and integer
argument regression retain eight and two passing groups respectively.

The fixed GeoBlox export removes 102 breaks, 73 unused labels and 73 nondeclaring
block frames across 50 files, reducing 78,689 lines to 78,441. Independent JDK body
positions and just these documented transforms reproduce all 303 token streams.
All sources compile; ordered 19,591 declarations, 119,181 references and 388
overrides remain unchanged, as do diagnostics. The instrument-patch constructor
shrinks from 492 to 468 lines and nine block labels to one. There remain 21 method
spans of at least 300 lines, 13 with block labels; some include nested helpers.
These controlled proofs do not establish whole-game or browser/phone acceptance.

### Recovering conditional alternatives from plain exits

`foldLabeledIfElseExits` runs after terminal-break cleanup. A direct braced `if`
ending in the only break to a unique plain block has an existing alternate: the
remaining statements in that block. It becomes `if/else`; a branch containing
only the break becomes an ordinary guard using logical negation. Prefix work
stays before the predicate, both branch bodies retain their order, and an outer
block preserves prefix declaration scopes until existing scope-safe cleanup.
The rewrite duplicates neither work nor predicates and introduces no locals.

The break must be the final direct statement of the consequent, with a nonempty
fallback after the `if`. Alternates, other references to the destination,
intermediate loops/switches/protected regions, bare branches, unknown extents,
duplicate/unbound labels and invalid ancestor transfers refuse reconstruction.
Comments, Unicode escapes, nested executables and unsupported/malformed syntax
also refuse it. Protected work inside either branch or the prefix remains intact,
as do regions enclosing the entire destination. This does not yet reconstruct
multi-exit decision trees such as the compact music score's controller decoder.

`NODE_PATH=/path/to/dependencies JAVA_TOOL_OPTIONS=-XX:-UsePerfData node test/javaAstEmitterLoopExits.test.js`
passes 52 groups with one optional historical corpus check skipped. Two new
groups include 6,720 native comparisons and explicit selected/fallback oracles.
They cover ordered work/predicates, unboxing, NaNs, partial effects, shadowed
branch locals, ancestor break/continue, return overrides, enclosing and branch
finally effects observed after invocation, and monitor ownership/release.
Exception-exit and integer-argument tests retain eight and two passing groups.

The fixed GeoBlox export reconstructs 64 labels/breaks: 47 conditional alternatives
and 17 ordinary guards. Scope-safe cleanup unwraps 64 blocks across 45 files,
removing 145 lines (78,441 to 78,296). Independent JDK body positions plus only
these rules reproduce all 303 token streams. All sources compile, ordered
19,591 declarations/119,181 references/388 overrides remain, and diagnostics
are byte-identical. Gameplay rendering shrinks 395 to 390 lines and 22 to 20
block labels; board reconciliation shrinks 504 to 502 lines and 17 to 16 labels.
The instrument-patch constructor now has no labels and 466 lines. There remain
21 large method spans, 12 with block labels. Complete gameplay/assets and
browser/phone acceptance remain unverified.

### Recovering ordered multi-exit decisions

`foldLabeledExitTrees` extends conditional-alternative reconstruction to multiple
breaks to one unique plain block. Each selected braced arm must end in a direct
break to that destination. Its remaining sequence becomes an alternate; nested
selected arms use the same proof. Every destination reference must be consumed
before removing its label. Effects between decisions stay inside the fallback
that originally reached them. A pure fallback conditional becomes `else if`
only when no prefix work/declaration needs a surrounding block.

Bare-break arms become logical-negation guards when a fallback remains. A live
predicate with no remaining effects still executes in an empty conditional arm.
Original predicate bytes/order, scopes, early returns and ancestor transfers
remain; no work/predicate is duplicated and no local is added. Target breaks in
intermediate loops, switches or protected wrappers refuse reconstruction.
Existing alternates carrying target exits, unsupported syntax, comments, Unicode
escapes, nested executables, invalid transfers and unknown extents also refuse it.
Budgets are 16 recovered choices, depth 16 and 32 target references per frame;
an oversized tree stays intact. Enclosing and branch-local protected regions
remain intact rather than being moved across the new alternatives.

`NODE_PATH=/path/to/dependencies JAVA_TOOL_OPTIONS=-XX:-UsePerfData node test/javaAstEmitterLoopExits.test.js`
passes 54 groups with one optional historical corpus check skipped. Two new
groups include 16,128 native comparisons plus first/second/fallback oracles.
Fixtures cover short-circuit/unboxing failures, ordered predicate/work traces,
NaNs, interleaved effects, scopes, nested destinations, ancestor break/continue,
returns, finally state after invocation and monitor ownership/release. Exception
and integer-argument regressions retain eight and two passing groups.

The fixed GeoBlox corpus reconstructs 27 frames, 75 breaks and 75 choices
(18 ordinary guards), unwraps 27 scope-safe blocks and removes 126 lines across
24 files (78,296 to 78,170). The compact music controller decoder becomes an
ordered alternative chain, reducing its constructor 541 to 519 lines with no
block labels. Bzip2 block decoding also loses its last block label, shrinking
388 to 385 lines. Gameplay rendering falls 390 to 385 lines and 20 to 19 labels;
menu action handling falls 335 to 325 lines and 20 to 18 labels. Independent JDK
body positions plus only these documented rules reproduce all 303 token streams.
Raw sources compile; ordered 19,591 declarations/119,181 references/388 override
rows and diagnostics remain unchanged. There remain 21 large method spans,
10 with block labels. Larger reconstructions and whole-game/browser/phone
acceptance remain unfinished or unverified.

### Simplifying dominated Boolean predicates

`simplifyDominatedPredicates` removes neutral `&&`/`||` operands when a preceding
branch or short-circuit operand proves an equality of the same captured
primitive int local. For example, inside `if (flag == 0)`,
`if (ready() && flag == 0)` becomes `if (ready())`. Equality/exclusion facts also
apply to different decimal int constants. While/for bodies receive their
entry-condition facts; do-while bodies do not receive facts from their later
condition. The final pipeline runs this after existing structural/predicate
cleanup, without rerunning passes that move control frames.

Facts require a unique visible declaration and no later/cyclic writes or
cyclic declaration. Fields, boxed/floating values, ambiguous names and nested
executables remain opaque. No initializer/global value is assumed. Boolean
identity elimination retains every unknown atom exactly once, in order;
absorbing expressions such as `effect() && knownFalse` remain in place. Entirely
known conditions remain for the separate completion-aware pass. Loop cleanup
requires a surviving expression proven nonconstant to the Java compiler.

Only source characters are deleted; all statements, declarations, scopes,
labels, protected regions, monitors and diagnostics remain. Optional
`retainDiagnostics` records deleted ranges, removed comparisons and their
branch facts. `parameterNames` supplies method-signature evidence for
nonconstant loop operands. Source/depth/edit budgets and unsupported/commented/
Unicode-translated input refuse cleanup.

`node --test test/dominatedPredicateRecovery.test.js` passes five focused groups.
Ten native variants match 262,500 independent ordered-oracle cases: varying
signed flags, nullable/noncached Booleans, reference identity, NaN/signed zeros/
infinities, callbacks that mutate a volatile global while the snapshot stays
stable, callback failures, loops, abrupt exits, finally overrides and monitors.

### Simplifying recovered Boolean predicates

`simplifyPredicateNegations` runs after control-flow recovery, which can add
fresh negations after typed IR rendering. It complements `==`/`!=`, cancels
double negation, and applies De Morgan to `&&`/`||` in if/while/for conditions
and braced do-while conditions. Both operand order and short-circuit paths stay
the same. The final pipeline finishes Boolean cleanup before enabling
`complementIntegralRelations` (default true for the standalone helper), making
grouping independent of when operand types become available.
Relational tests are complemented only when both operands have proven
primitive integral types. The optional `parameters: [{name, type}]` comes from
the method signature; scoped unique local declarations, primitive casts,
integer/character literals, integral arithmetic and known array access/length
provide further evidence. Floating/unknown relations retain their negation and
NaN outcomes. Field/call results and boxed values remain unknown unless an
explicit primitive cast proves the result. Shadowed names, for-initializer
locals and out-of-scope declarations do not establish types. Call arguments
and boxed-Boolean identity operands remain byte exact, including unboxing.
Double negation is simplified only where Java requires a primitive Boolean
condition; assignments, return values and call arguments remain opaque.
The implementation applies token edits without moving statements, scopes,
labels, protected regions or monitors. Unsupported/commented/Unicode-translated
input, nested executables and source/depth/edit budgets refuse this cleanup.

`node --test test/predicateNegationRecovery.test.js` passes nine focused groups.
Six native context variants match 708,750 independent ordered-oracle cases,
including nullable/noncached Boolean values, reference identity, integer
overflow, NaN/signed zeros/infinities, throwing callbacks, skipped evaluations,
finally overrides and nullable monitor acquisition/release. Seven further
integral variants match 453,600 independent ordered `Long.compare` oracle cases:
postincrements, int overflow/division, long shifts with masked/negative counts,
NaN/infinity casts, nullable arrays and bounds failures, narrowing casts,
throwing callbacks, finally overrides and monitor release. Diagnostics report
the operand types and exact operator ranges for independent compiler audits.

### Recovering captured-integer if dispatches

`recoverScalarIfDispatches` recognizes transparent integer if ladders inside an
existing plain labeled block. A unique captured primitive `int` local must stay
unmodified throughout dispatch; leading computations remain before the new
switch. At least three and at most sixteen equality constants partition all
integer values, including negative values and an exhaustive Other class.
Actions retain their original lexical order and each appears exactly once.
Unknown flag guards, callbacks, numeric work and original labeled exits remain.
Only contiguous case runs and exits to the existing frame can be serialized;
noncontiguous shared work refuses reconstruction instead of being duplicated.
New bare switch exits skip only a simple break to the frame, or finish a run.
Nested protected actions remain whole. Nested loops/switches/labels, local
declarations, ambiguous transfers, mutable or boxed classifiers, unsupported
syntax and excessive depth/action counts refuse this feature. The ordinary
cleanup path runs it after the existing guard/loop recovery passes.

The optional `{nestedRegions: true}` also searches suffixes inside blocks
enclosed by a plain label. It keeps the complete prefix in place outside the
new switch, including declarations, earlier switches/loops, selector writes,
and whole protected constructs. The selected suffix must still meet every
ordinary dispatch restriction. Its unique local must be in scope at the first
comparison and remain unmodified until the suffix ends. Bare breaks in the
suffix refuse because a new switch would change their destination; prefix
breaks retain their original frames. Scalar captures declared inside the same
block are supported. At most 128 suffix candidates are inspected, with the
existing 40,000-character region limit and a 400,000-character body limit.
The compiler runs this option after its other structural/predicate cleanup;
the default whole-frame policy stays conservative.

Four additional test groups cover nested capture scopes, opaque prefixes and
unsafe suffixes. Six independent native models compare 99,144 cases across
guarded fallthrough, zero/nonzero flags, selector writes, null unboxing/monitors,
signed overflow, injected failures and return/break/continue/finally completion.

`foldScalarSwitchPrefixes` joins consecutive terminating equality arms before
an existing primitive-local switch. The unique captured `int` local must be
in scope, and prefix actions cannot write it. Prefix case constants must be
distinct from each other and every existing numeric case. The original switch
header/body, callback order, fallthrough and transfer targets stay intact. Its
pure selector read moves before the removed comparisons; no action is copied
twice. Arms must not complete normally, including through catches/finally, and
bare prefix breaks refuse. Declaration-bearing arm blocks retain their scopes;
empty declaration scopes can be flattened. Fields, boxed/effectful selectors,
unknown case constants, overlapping cases, nested executables and unsupported
syntax refuse. Prefixes are bounded to 32 arms and 64 total numeric cases, with
40,000-character regions and 400,000-character bodies. The compiler runs this
after nested dispatch recovery.

Six additional test groups include six independent native control/completion
models checking 13,824 cases, with integer extremes, signed overflow, nullable
guards/monitors, finally overrides, nonlocal transfers, declaration scopes and
mutation inside the unchanged old switch body.


`foldBooleanLocalAssignments` replaces an if/else whose complete arms assign
opposite Boolean literals to the same unique primitive Boolean local with one
assignment of the original condition (or its logical negation). It retains the
condition's original grouping and evaluates/unboxes it once before the store.
Condition callbacks, short-circuit order, partial local writes, floating/NaN
predicates and all enclosing exception/finally/monitor scopes remain. The
surviving destination identifier keeps its original binding; declarations and
initializers remain intact. Boxed, field, array, parameter, ambiguous or
out-of-scope destinations, extra arm effects, same-valued arms, nested
executables, translated Unicode/comments and unsupported syntax refuse.
At most 256 branches, 40,000-character regions, 128 AST levels and a
400,000-character body are considered. This runs after switch-prefix recovery;
earlier structural and predicate phases are not repeated.

`node --test test/booleanLocalAssignmentRecovery.test.js` checks both polarities,
final/uninitialized declarations, braced and unbraced arms, nested local scopes,
independent token-permutation diagnostics and all destination/budget refusals.
Six independent native truth/completion models compare 124,416 cases with
condition writes, short-circuit null unboxing, integer overflow in callbacks,
NaN/infinite predicates, returns/nonlocal continues, failure identity, finally
overrides and monitor release.

`foldNaturalLoopExits` removes a continue that is the final statement of its
own braced loop body: normal completion already takes the same update/header.
It also changes an outer labeled continue to an inner bare break when that
inner loop is the outer body's final statement. Every reference to the retired
outer label must be such a continue, and each replacement must have the inner
loop as its nearest break destination. An intervening loop/switch, suffix
statement, try/finally/monitor wrapper between the two loops, or other outer
label reference refuses that reconstruction. Bare prefix exits retain their
existing targets. All while/for/do/enhanced-for headers, updates, declarations,
condition effects and complete protected groups stay in place; finally can
still override a pending completion. The label is retired only when no other
reference needs it. No value is inferred and no action is duplicated.

Diagnostics identify exact original transfer/keyword/label ranges and both
loop bodies, with lexical edits sufficient for independent replay. Each call
removes a continue or its nonlocal name; the compiler repeats this final phase
after Boolean-local recovery without rerunning earlier reconstruction phases.
Regions are bounded to 40,000 characters, bodies to 400,000, nested paths to 128
AST levels and a localizing step to 128 outward references. Unsupported syntax,
comments/Unicode translation and nested executables refuse.

`node --test test/naturalLoopExitRecovery.test.js` checks all loop forms,
remaining label references, complete protected bodies, token/byte edit replay,
incorrect break destinations and scope/statement/budget refusals. An independent
native pending-completion dispatcher compares 20,160 cases in eight loop models,
with effectful headers/updates, signed-overflow callbacks, zero/nonzero flags,
partial failures, return snapshots, finally overrides and monitor release.

The emitter finishes terminal switch frames again after late nested dispatch,
switch-prefix, Boolean-local and natural-loop recovery. A switch introduced by
those phases can expose an enclosing plain label with the same continuation.
This uses the existing terminal-destination and frame-scope proofs, retaining
all cases, fallthrough, conditions, callbacks and protected constructs. It does
not rerun earlier predicate or dispatch recovery. The complete emitter-pipeline
fixture `node --test test/cfrLateSwitchFrames.test.js` proves the ordering
regression, unsafe suffix/protection refusals and declaration scope retention.
An independent native action dispatcher compares 66,528 cases across four
completion contexts, including nonzero flags, callback failures, overflow,
return snapshots, finally overrides and nullable monitors.

`node --test test/scalarIfDispatchRecovery.test.js` covers supported case runs,
empty/default paths, integer extremes, scope/target/mutation refusals and budgets.
Seven native variants compare 20,160 independent cases, retaining negative/zero/
positive flags, short-circuit/null/throwing callbacks, overflow, return snapshots,
finally overrides, monitor ownership/release and ancestor break/continue targets.
An additional native fixture checks 21 empty/default/extreme-key cases, including
signed minimum and maximum case constants and overflow in the action itself.

### Keeping terminating else effects inside their loop

Terminal trailing-loop recovery also permits earlier breaks to the same loop
inside the intact prefix. For example,
`while (true) { if (stop()) { cleanup(); break; } work(); if (again()) continue; break; }`
becomes `do { if (stop()) { cleanup(); break; } work(); } while (again());`.
The early exit still skips `again()`, including its side effects or unboxing
failure. A label remains when a prefix break still names it. Whole nested
try/catch/finally, monitor, switch and local scopes remain in place.
Earlier own continues still refuse this rewrite because they skipped the old
trailing test; a nonterminal suffix still refuses own prefix breaks because
moving that suffix outside the loop would execute it after an early exit.
The ordinary cleanup path repeats terminal recovery after making terminating
else arms explicit, since those exits can expose direct trailing backedges.
Three focused groups include 8,064 independent native event cases for both exit
reasons, short-circuit predicates, nulls, exceptions, finally overrides, monitor
release, nested destinations, return snapshots and enclosing transfers.

`foldLoopElseExitGuards` recognizes a literal-true loop containing exactly a
braced `if (predicate) { arm } else { exitEffects }` and a terminal bare break
to that loop. It emits `if (!(predicate)) { exitEffects; break; }`, followed by
the original arm contents and original terminal break. This removes one nesting
level without moving the false-arm effects outside the loop. A true arm that
falls through still skips those effects; a true-arm continue still reevaluates
the predicate. Original own/nonlocal transfers keep their destinations.

Both arms must have a normal completion path, so neither synthesized nor
retained breaks create unreachable Java. Direct true-arm declarations refuse
flattening. Declarations, labels, loops, switches and protected groups in the
false arm also refuse reconstruction; whole nested true-arm scopes, loops,
try/catch/finally and synchronized groups stay intact. Existing syntax/transfer,
comment, Unicode-escape and nested-executable refusals still apply. Predicate
bytes are evaluated once and negated as written, with no numeric/control-flag
assumption. No local, label or ordinary reference is added or removed.

`NODE_PATH=/path/to/dependencies JAVA_TOOL_OPTIONS=-XX:-UsePerfData node --test test/javaAstEmitterTrailingLoops.test.js`
passes 20 groups. Three new groups include six native variants and 5,184 cases
checked against an independent event model: both exit reasons, nullable/effectful
predicates, nonzero flags, pending return/exception snapshots, finally backedges
and own-loop break overrides, ancestor transfers, local scopes and monitor
release. `node --test test/javaAstEmitterLoopExits.test.js` with the same
environment passes 66 groups with one existing optional corpus check skipped.

In the fixed GeoBlox corpus the new form applies to 12 loops in 10 methods
across six owners, including screen/session updates and board reconciliation.
It changes indentation, not line counts: eight large labeled bodies remain.
Full game/browser/phone behavior and performance acceptance are unverified.

### Recovering nested predicate-only skip trees

`foldLabeledGuardTrees` turns trees containing only conditionals and breaks to
one plain destination into a short-circuit condition for their remainder.
Sequential guards combine with AND; an outer conditional whose nested guards
may skip the remainder combines its logical negation with their continuation
using OR. Negation retains original predicate bytes instead of guessing opposite
floating comparisons. Prefix work stays before the condition and a new block
keeps remainder declarations scoped. Multiline AND/OR expressions stay grouped.

Every destination reference must be consumed. A nested remainder qualifies only
when normal completion reaches that exact target through final plain blocks,
if branches or plain labels. Intermediate work, loops, switches and protected
wrappers refuse that path proof. Work inside a guard, alternates, unsupported
syntax, comments, Unicode escapes, nested executables and invalid transfers also
refuse it. Budgets per frame are 16 predicates, 16 target references, nesting
depth 16 and 512 predicate tokens. No effect/predicate is duplicated or local
added; existing enclosing/branch-local protected regions remain intact.

`NODE_PATH=/path/to/dependencies JAVA_TOOL_OPTIONS=-XX:-UsePerfData node test/javaAstEmitterLoopExits.test.js`
passes 56 groups with one optional historical corpus check skipped. Two new
groups include 16,128 native comparisons and bypass/skip/NaN oracles. They cover
short-circuit order, nullable predicates, NaNs, prefix effects, partial failures,
declaration scopes, separate terminal branches, ancestor jumps/returns, finally
state after invocation and monitor ownership/release. Exception-exit and integer
argument tests retain eight and two passing groups.

The fixed GeoBlox export removes 41 labels/frames and 82 breaks, recovering 42
remainder guards over 97 predicates across 19 files. Scope-safe cleanup unwraps
41 blocks and saves 219 lines (78,170 to 77,951). Menu rendering falls 372 to 304
lines and 10 to four block labels; menu actions fall 325 to 322 lines and 18 to
17 labels. Gameplay rendering falls 385 to 379 lines and 19 to 18 labels; board
reconciliation falls 502 to 496 lines and 16 to 15 labels. Independent JDK body
positions plus only these documented rules reproduce all 303 token streams.
Sources compile; ordered 19,591 declarations/119,181 references/388 overrides
and diagnostics remain unchanged. The 21 large method spans (10 with block
labels) remain. Larger reconstructions and full-game/browser/phone acceptance
remain unfinished or unverified.
