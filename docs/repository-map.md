# Repository map and structural backlog

Baseline checkout: `c53e8f31f378cae4f704fc20db88860f5f01d9b9`, plus pre-existing
uncommitted local changes that this work preserves (`src/java-frontend/compiler.js`,
`src/java-frontend/javaIr.js`, `src/jit/JitCompiler.js`, `src/jit/JvmSsaBlockRenderer.js`,
and three untracked `test/javaFrontend*`/`test/jitEffectfulPreparationIdempotent` files).
Those changes are someone else's in-flight work; nothing here reverts or rewrites them.

Scale: 601 tracked JavaScript files outside `src/jre/`, 250,515 tracked JS lines in
total. `src/jre/` (about 380 small files) is a Java class library mirror organised by
package and is excluded from the size and duplication measurements below: it is
maintained source, but its shape is dictated by the JDK package tree, not by us.

## 1. Areas

| Area | Location | Size | State |
| --- | --- | --- | --- |
| Java frontend (source to classfile) | `src/java-frontend/` (21 files) | 21,423 | Large; `javaIr.js` 9,537 lines; a verified 3-module require cycle |
| Classfile/bytecode parsing and assembly | `src/parsing/` (9), `src/utils/jasminAssembly.js` | 6,366 | Reviewed; coherent |
| CFG / SSA / analysis | `src/cfg/` (4), `src/analysis/` (16) | 5,988 | Reviewed; coherent |
| Transformation passes | `src/passes/` (70 files) | 27,858 | Many small, well-separated passes; helper duplication across them |
| Decompiler | `src/decompiler/` (4 files) | 12,253 | `cfr.js` 9,848 lines in one file |
| Interpreter, scheduler, frames, class init | `src/core/` (15), `src/instructions/` (12) | 11,100 | `jvm.js` 4,709 lines; highest fan-in in the repo (98 importers) |
| Object model, heap, JRE, platform | `src/core/objectModel.js`, `src/core/wasmHeap.js`, `src/jre/`, `src/platform/` (9) | 6,861 + JRE | Reviewed; platform adapters are separate already |
| JS and Wasm compilers | `src/jit/` (17 files) | 42,820 | The densest area; 4 files hold 88% of it |
| Worker compile / transport / linking | `src/jit/CompileWorkerClient.js`, `compileWorkerThread.js`, `ShadowCompiler.js`, `WasmLinker.js` | 1,730 | Recently reorganised; reviewed, no change needed |
| Debug, CLI, browser entry points, tools | `src/debug/`, `src/lsp/`, `src/workspace/`, `scripts/`, `tools/` | ~10,000 | `scripts/jvm-cli.js` has the repo's highest fan-out (27) |
| Tests, fixtures, benchmarks, docs | `test/` (259 files), `bench/`, `benchmarks/`, `docs/` (13) | — | Test setup duplicated; docs mix reference and experiment logs |

Generated/vendor/evidence, excluded from "maintained source" measurements:
`dist/` and `build/` (gitignored build output), `browser-runtime/` (committed build
artifact, deliberately tracked), `bench/g0-linear-runtime/kernel/*.generated_*.js`
(retained experiment evidence), `node_modules/`.

## 2. Findings

Each finding is recorded with the evidence that establishes it. Nothing here is
claimed from a name alone.

### F1. The generated-source verifier is embedded in the renderer — VERIFIED
`src/jit/JvmSsaBlockRenderer.js` lines 49-202 hold `walkJavaScriptAst`,
`parseGeneratedStatements` and `unboundGeneratedSsaIdentifiers`: an opt-in audit that
re-parses finished output with acorn. It never transforms; the compiler never reads
back its own emitted JavaScript to decide what to emit. It is the only reason the
renderer imports `acorn`. Consumers: the renderer itself (line 13884, behind
`JVM_JIT_VERIFY_GENERATED=1`), `src/jit/JitCompiler.js:2658` (behind
`JVM_JIT_VERIFY_FREE_NAMES=1`), `test/jitFreeNames.test.js` and six assertions in
`test/jitCompiler.test.js`. Ownership: its own module. Compatibility: both
`module.exports.unboundGeneratedSsaIdentifiers` and `module.exports._test` on the
renderer are load-bearing for tests and must keep resolving.

### F2. Production code imports through test-only interfaces — VERIFIED
`src/jit/JitCompiler.js:33` reads `capturesBooleanStatic` and `isNoOpExceptionHandler`
out of `WasmJit._test`. `scripts/statement-ir-audit.js:7` reads
`renderer._test.reportStatementIrAudit()`. In both cases the `_test` bag is the only
route to a function that production/tooling genuinely needs, so `_test` no longer
means "test-only" and cannot be pruned safely.

### F3. Two stale duplicate modules at `src/` top level — VERIFIED
`src/conditionInverter.js` is byte-identical to `src/passes/conditionInverter.js`
except for one require path, and that path is broken: `require('./ast-to-cfg')`
resolves to nothing (`node -e "require('./src/conditionInverter.js')"` throws
`MODULE_NOT_FOUND`). It therefore cannot be a dependency of anything. The live copy
`src/passes/conditionInverter.js` is imported by `scripts/jvm-cli.js:22`.

`src/conditionInverterCfg.js` does load, and is imported by exactly one file in the
repository: `test/conditionInverterCfg.test.js`. Its `src/passes/` twin is **not**
identical, and the top-level copy is the maintained one: it replaces a plain
`visited` set with a two-bit `visitedStates` map so a node can be revisited in its
backedge state, which is exactly what the test ("condition inverter retains backedge
state when paths merge") pins. The `src/passes/` copy lacks that fix, carries an
unused `BasicBlock` import, and has **no importer anywhere in the repository** --
verified by a repository-wide search plus the absence of any dynamic `require` in
`src/` or `scripts/`, and by the three webpack entry graphs being static. Both files
date from "Organize src and add JVM JIT" (5bb382e), which copied them into
`passes/` and left the originals behind.

### F4. Require cycles exist, but none is a load-order hazard -- VERIFIED
Tarjan over the 601-file literal-require graph finds three strongly connected
components:

- `src/jit/ShadowCompiler.js` <-> `src/jit/JitCompiler.js` <-> `src/core/jvm.js`
- `src/java-frontend/jvmBytecodeIr.js` <-> `javaIr.js` <-> `compiler.js`
- `src/platform/ide/documents.js` <-> `src/platform/ide/actions.js`

Classifying every edge in those cycles by whether its `require` runs at module
top level or inside a function changes the conclusion: **each cycle is already
cut by at least one deferred require**, so no module ever observes a
half-initialised partner.

| Edge | Kind |
| --- | --- |
| `ShadowCompiler.js:99` -> `core/jvm` | deferred (inside a method) |
| `core/jvm.js:45` -> `jit/JitCompiler` | top level |
| `JitCompiler.js:4` -> `./ShadowCompiler` | top level |
| `javaIr.js:14` -> `./compiler` | top level |
| `compiler.js:1473,1474` -> `./javaIr`, `./jvmBytecodeIr` | deferred |
| `jvmBytecodeIr.js:7` -> `./compiler` | top level |
| `ide/documents.js:186` -> `./actions` | deferred |
| `ide/actions.js:66,101` -> `./documents` | deferred |

So these are existing design decisions, not latent initialisation bugs, and
breaking them apart would be churn without a defect to point at. What remains is
ordinary coupling: the deferred require is real coupling with a comment on it.
Recorded, deliberately not acted on.

### F5. Duplicated semantic helpers across passes -- VERIFIED by AST body hash
57 function bodies are byte-identical after comment/whitespace normalisation
across more than one file. The clusters, and what a closer look changed about
them:

- **Descriptor parameter lists.** `src/passes/` holds **13** helpers that read the
  parameter list out of a method descriptor, and hashing their bodies shows
  **9 distinct implementations**, not one duplicated 13 times: an 8-copy group, a
  3-copy group, and 7 singletons. The two groups are not interchangeable -- one
  returns `null` for a malformed descriptor, the other returns `[]` or the
  parameters gathered so far and never scans past the closing `)`. Neither is
  `src/parsing/typeParser.js`'s `parseDescriptor`, which is a third rule again
  (it yields readable type names, not raw descriptor slices). Only the two
  exact-identity groups are safe to consolidate; the 7 singletons have not been
  compared and must be treated individually.
- `branchTargets`, 5 copies; `collectReferencedLabels`, a 3-copy group and a
  separate 2-copy group (two different rules, not five copies of one);
  `labelReferencesWithSources`, 2; `targetsOf`, 2; `eachMethod`, 2.
- `assertJsonValue`, 5 copies (`src/cfg/cfgJoin.js`, `src/java-frontend/cfg.js`,
  `javaIr.js`, `jvmBytecodeIr.js`, `serialization.js`).

These are label/descriptor reading rules, not tier policy, so each is a candidate
for one owned module -- not for a general "utils" bag, and not for a single
helper with a mode flag.

### F6. Configuration and default resolution are unowned -- VERIFIED
202 distinct `JVM_*` options are read through `process.env` from 15 files under
`src/` (excluding `src/jre/`); 458 `JVM_*` names appear in the repository once
comments, docs and test harnesses are counted, so a mention is not a consumer.
Each read site inlines its own default and truthiness rule and there is no
registry, no documented default, and no statement of which options are supported.
Measured, however, the sprawl is shallower than the raw count suggests: only 9
options are read from more than one `src/` file, and at those sites the rules
currently agree. The inventory is now `docs/runtime-options.md`.

### F7. Duplicated test setup — VERIFIED
13 test files each define their own `compileJavaFixture(t, className, source)`; the
bodies differ only in a temp-dir prefix and small option variations. 20 test files use
the shared `test/test-helpers.js`; the rest hand-roll their setup.

### F8. Oversized units — VERIFIED (acorn measurement, functions >= 140 lines)
157 functions across `src/`. The extremes are structural, not stylistic:
`JvmSsaBlockRenderer.compileMethodBody` is 14,588 lines (88% of its file);
`HotCallGraphRegionCompiler.compileModule` 765; `javaIr.lowerStatementToJavaIrOpsInner`
830; `cfr.decompileOwnedStructuredControlFlow` 710; `JitCompiler` has 30 functions over
140 lines and its constructor alone is 608. Files with the most oversized functions:
`JitCompiler.js` (30), `WasmJit.js` (19), `HotCallGraphRegionCompiler.js` (13),
`JvmSsaBlockRenderer.js` (11), `core/jvm.js` (10).

### F9. Documentation mixes reference and experiment log — VERIFIED
`docs/` holds 13 entries. `assembly.md`, `compiler.md`, `decompiler.md`, `ide.md`,
`jshell.md`, `lsp.md`, `tooling.md`, `workbench.md` are maintained reference.
`phase1-worker-audit.md`, `plan-linear-runtime.md`, `region-compiler-emission-plan.md`
and `sample-phase1-worker-benchmark.json` are living plans/evidence. There is no index
that says which is which, and no single page listing the supported commands.

### Unresolved / dynamic dependencies
- Dynamic `require` by computed path: there are exactly **two** in `src/` outside
  `src/jre/` -- `src/core/jni.js:67` (`require(fullPath)`, loading a native library)
  and `src/java-frontend/jreMetadata.js:66` (`require(file)`, loading a metadata
  file). Both are the "Critical dependency" warnings webpack emits on every build.
  Neither can reach a pass or a JIT module, so they do not affect any
  unreferenced-file conclusion here; those are in any case backed by an additional
  load or usage check, as in F3. An earlier draft of this page claimed there were
  none, from a grep pattern that missed `require(fullPath)`.
- `browser-runtime/` is a committed build artifact loaded by external pages. It is out
  of scope for moves.
- `src/jre/` classes are resolved through the generated JRE index
  (`scripts/generate-jre-index`), not through static requires.

## 3. Prioritised backlog

| # | Item | Area | Value | Risk |
| --- | --- | --- | --- | --- |
| WS1 | Extract the generated-source verifier (F1) | jit diagnostics | High | Low |
| WS2 | Give F2's production consumers real exports | jit | High | Low |
| WS3 | Extract the statement-IR audit from the renderer | jit diagnostics | High | Low |
| WS4 | Runtime-option inventory + one resolver (F6) | cross-cutting | High | Medium |
| WS5 | Retire the two stale `src/` duplicates, repoint the test (F3) | passes | High | Low |
| WS6 | Own the duplicated pass helpers (F5) | passes | Medium | Medium |
| WS7 | One shared `compileJavaFixture` for tests (F7) | tests | Medium | Low |
| WS8 | Document the command set; separate reference docs from logs (F9) | docs | Medium | Low |
| WS9 | Decompose `compileMethodBody` (F8) | jit | High | High |

WS9 in an earlier draft was "break the require cycles"; F4 retires it -- the
cycles are already cut by deferred requires, so there is no defect to fix.

Reviewed, no change needed: `src/parsing/`, `src/cfg/`, `src/analysis/`,
`src/instructions/`, `src/workspace/`, `src/io/`, `src/isomorphic/`, and the worker
compile/transport/linking group in `src/jit/` (`CompileWorkerClient`,
`compileWorkerThread`, `ShadowCompiler`, `WasmLinker`), which was reorganised
recently and already has a narrow contract per file.

## 4. Completed workstreams

Baseline for every comparison below: `JVM_TEST_CONTINUE_ON_FAILURE=1 npm test` on
the checkout described at the top of this page — **11995 assertions passed, exit 0,
zero failing files**, measured for this work rather than quoted from an earlier run.
Test discovery is unchanged throughout: 259 files in `test/*.test.js` before and
after, and no test file was moved.

### WS1 — the generated-source verifier has its own module

`walkJavaScriptAst`, `parseGeneratedStatements` and `unboundGeneratedSsaIdentifiers`
moved verbatim out of `src/jit/JvmSsaBlockRenderer.js` into
`src/jit/generatedSourceVerifier.js` (174 lines, one dependency: acorn). The moved
region is byte-identical to the original — verified by diffing the extracted lines
against the new file, not by inspection.

Consumers updated: `src/jit/JitCompiler.js` now imports the verifier from its owner
instead of destructuring it off the renderer's export. The renderer keeps
`module.exports.unboundGeneratedSsaIdentifiers` and `_test.unboundGeneratedSsaIdentifiers`
so `test/jitFreeNames.test.js` and the six assertions in `test/jitCompiler.test.js`
resolve unchanged.

Class of change: mechanical move plus import updates. No behaviour change is
possible: the verifier is opt-in (`JVM_JIT_VERIFY_GENERATED=1`,
`JVM_JIT_VERIFY_FREE_NAMES=1`), it is a check rather than a transformation, and
nothing the compiler emits depends on what it returns.

Focused result: `jitFreeNames` 6, `cooperativeCallSuspension` 45,
`jitCompiler` 2364 — all passing.

### WS2 — production code no longer imports through `_test`

`isNoOpExceptionHandler` already had a real owner: `src/jit/wasmShared.js` defines
and exports it, and `JitCompiler` was reaching the same function through
`WasmJit._test`. `capturesBooleanStatic` had no owner but only needs `getOp`, which
`wasmShared` owns, and it is consulted by both compilers — so it moved to
`wasmShared.js` beside the other shared bytecode predicates, and `WasmJit` now
imports it. `WasmJit._test` still re-exports it, so `test/jitCompiler.test.js`
is untouched.

`scripts/statement-ir-audit.js` was the last such consumer; WS3 gave it a real
module to import. **`src/`, `scripts/`, `tools/` and `lib/` now contain no reads of
any `_test` surface**, so `_test` means test-only again.

Class of change: module move plus import updates.

### WS3 — the statement-IR audit has its own module

The audit (`statementIrAuditIssues`, `auditStatementIrLines`,
`auditStatementIrControlFlow`, `reportStatementIrAudit`) moved verbatim into
`src/jit/statementIrAudit.js`. It needed one function from the emitters,
`partsReferences`, which is pure and now has two owners, so that moved into
`src/jit/statementParts.js` and both sides import it — no require cycle, and no
dependency injection.

Consequence worth stating: **`src/jit/JvmSsaBlockRenderer.js` no longer references
acorn at all.** Both of its JavaScript-parsing users are gone, so code emission is
now separable from generated-source diagnostics rather than sharing a file with
them.

`scripts/statement-ir-audit.js` now imports `reportStatementIrAudit` from the audit
module instead of the renderer's `_test`; the two share one cached module, so the
report still aggregates what the renderer collects. Verified by a synthetic probe
(an unrecorded line is reported) and by running the script over a rendering suite.

### WS5 — two stale duplicates retired

`src/conditionInverter.js` is gone: it was byte-identical to
`src/passes/conditionInverter.js` apart from a `require('./ast-to-cfg')` that
resolves to nothing, so `require`ing it threw `MODULE_NOT_FOUND` and nothing could
depend on it. The live copy that `scripts/jvm-cli.js` uses is untouched.

`conditionInverterCfg` had two copies and the **top-level one was the maintained
one** — it carries the two-bit `visitedStates` fix that its test pins, while the
`src/passes/` copy had the older plain `visited` set and an unused `BasicBlock`
import, with no importer anywhere. The maintained implementation moved to
`src/passes/conditionInverterCfg.js` (`git mv`, so the history follows) and
`test/conditionInverterCfg.test.js` was repointed at it. That test passes 2/2
against the promoted copy, so the shipped implementation is now the tested one.

Class of change: dead-code removal plus a move; no behaviour change, because the
surviving implementation is the one the suite already exercised.

### WS6 — descriptor parsing has an owner, without merging different rules

`src/passes/` contained 13 helpers that read a parameter list out of a method
descriptor. Hashing their bodies showed **9 distinct implementations**: an 8-copy
group, a 3-copy group, and 7 singletons. Only the exact-identity groups were
consolidated, into `src/passes/parameterDescriptors.js`, which exports both rules
under names that state the difference:

- `parameterDescriptors` returns `null` for a malformed descriptor (8 consumers);
- `parameterDescriptorsOrEmpty` returns `[]` or the parameters gathered so far and
  never scans past the closing `)` (3 consumers).

Merging them would have changed behaviour at malformed input, so they stayed two
functions rather than one with a flag. `src/parsing/typeParser.js`'s
`parseDescriptor` is a third rule again — it yields readable type names, not raw
descriptor slices — and was deliberately left out of this. The 7 singletons have
not been compared and were not touched.

The rewrite refuses to run unless every copy it is about to delete hashes to its
group's body, so the consolidation cannot silently absorb a variant.

### WS6 (continued) — label-reading rules, after one failed attempt

The first attempt moved `branchTargets`, `referencedLabels` and
`collectReferencedLabels` into a new module on the strength of byte-identical
bodies alone. It broke 12 test files with `ReferenceError` at
`labelReferences.js:48` (`cfrAdditionalFeatures`, `cfrBranchMergeRegressions`,
`cfrCatchSemanticsRegressions`, `cfrFixtures`, `cfrObfuscationGuards`,
`cfrPerformanceRegressions`, `cfrStackOrdering`, `cfrStructuredFeatures`,
`inlineSingleUseBooleanBranch`, `materializeTypedNullArgs`, `regionSplit`,
`removeDeadDupStore`), because **a body is only identical up to its free
identifiers**: `collectReferencedLabels` calls `getOp`, `trimLabel` and
`CONDITIONAL_JUMPS`, which existed in every source pass and in none of the new
module. That attempt was reverted in full.

The redo moves each body **together with its closure**. A census of the eight
passes settles what is actually duplicated and what is not:

| Helper | Definitions | Distinct implementations |
| --- | --- | --- |
| `getOp` | 3 | 1 |
| `CONDITIONAL_JUMPS` | 3 | 1 |
| `branchTargets` | 5 | 1 |
| `referencedLabels` | 3 | 1 |
| `trimLabel` | 8 | 2 |
| `collectReferencedLabels` | 5 | 2 |

The two divergences are not the same kind of thing, and were treated
differently:

- **`trimLabel` was an accidental divergence, so it is now one function.** One
  version returned `null` for a non-string argument, the other returned the
  argument unchanged; for an actual label string the two are identical (strip one
  trailing `:`). Every one of the ~80 call sites either guards with a `typeof`
  test first or discards falsy results, and `null` and `undefined` are both
  falsy, so no caller distinguishes them. Two people wrote the same helper twice.
  It is unified on the null-normalising version, so "not a label" has one
  spelling.
- **`collectReferencedLabels` is two different functions sharing a name, so it
  keeps two.** They take different arguments (`(code)` versus
  `(codeItems, protectedLabels)`) and answer different questions: the first walks
  branch targets **and the exception table**; the second walks the instruction
  list only, seeded with labels the caller wants protected. Merging them would
  change what each caller computes, so they are exported as
  `collectReferencedLabelsFromCode` and `collectReferencedLabelsFromItems`, aliased
  at each import so no call site changed.

Result: `src/passes/labelReferences.js` owns seven names; 27 local definitions
across eight passes became one module.

Open question this raised, recorded rather than fixed: the FromItems form ignores
the exception table entirely, so a label referenced only by an exception handler
is "unreferenced" unless the caller passes it in `protectedLabels`. Whether every
caller does is a behavioural question, not a cleanup one.

`assertJsonValue` (5 identical copies across `src/cfg/cfgJoin.js`,
`src/java-frontend/cfg.js`, `javaIr.js`, `jvmBytecodeIr.js` and
`serialization.js`) was deliberately **not** consolidated: its natural owner spans
`src/cfg` and `src/java-frontend`, which is an ownership decision rather than a
mechanical move, and one of the five lives in `javaIr.js`, a file with substantial
uncommitted local changes.

### WS7 — one javac fixture helper for the tests

Thirteen test files each defined their own `compileJavaFixture(t, className, source)`.
They differed only in the temp-directory prefix, in brace style, and in whether they
named a `sourcePath` local; normalising those three spellings collapses all thirteen
to one shape, so they are the same setup. `test/javaFixture.js` now owns it, as
`makeJavaFixtureCompiler(prefix)` returning the same three-argument function — so
**no call site changed**, and every suite keeps its own recognisable temp-directory
name for debugging.

The rewrite compares each body against that one shape and refuses to touch a file
that differs. `test/javaFixture.js` is not a `.test.js` file, so test discovery is
unaffected; the suite still finds 259 files.

## 5. Before and after: a representative task

*"Tighten the check that generated bodies never reference an undeclared SSA name."*

Before: the rule lived at lines 49-202 of `src/jit/JvmSsaBlockRenderer.js`, a
16,610-line file whose next 16,400 lines are the emitters, and it was reachable
from `JitCompiler` only by destructuring the renderer's module export. Reading it
meant loading the whole renderer; changing it meant editing the same file the
emitters live in, and the only way to know which of its callers mattered was to
grep for a name that the file itself uses in nine other senses.

After: the rule is `src/jit/generatedSourceVerifier.js` — 174 lines, one dependency
(acorn), three exported functions, and a test file of its own
(`test/jitFreeNames.test.js`) that imports it directly. Its two production callers
import it by name from its owner. The renderer no longer mentions acorn at all, so
the emitters and the generated-source diagnostics no longer share a file, a parser,
or a reason to be opened together.

Measured effect on the file that held all of it:

| | Before | After |
| --- | --- | --- |
| `src/jit/JvmSsaBlockRenderer.js` | 16,610 lines | 16,313 lines |
| JavaScript parser in the emitter file | acorn, 2 users | none |
| Generated-source verifier | embedded | `generatedSourceVerifier.js`, 174 lines, 1 dep |
| Statement-IR audit | embedded | `statementIrAudit.js`, 153 lines, 3 deps |
| Parts query shared with the audit | embedded | `statementParts.js`, 22 lines, 0 deps |
| Production reads of a `_test` export | 3 | 0 |

The renderer is still a 16,313-line file: WS9 (decomposing `compileMethodBody`,
14,588 lines on its own) is the work that would change that, and it is not attempted
here. What changed is that three of its responsibilities can now be read, tested and
modified without opening it.

## 5b. Final verification

Run on the finished tree, with every workstream in place:

| Check | Result |
| --- | --- |
| `JVM_TEST_CONTINUE_ON_FAILURE=1 npm test` | **11995 assertions passed, exit 0**, zero failing files -- identical to the baseline |
| `npm run build:bundle` | exit 0; `dist/jvm-debug.js` and `dist/jvm-compile-worker.js` re-emitted |
| Webpack warnings | 4, all pre-existing and in untouched files (two dynamic-require notices, two asset-size notices); none names a module introduced here |
| Test discovery | 259 `test/*.test.js` files, unchanged |
| Production reads of a `_test` export | 0 (was 3) |

## 6. Decisions to *not* change something

Two backlog items were dropped on the evidence rather than deferred:

- **A resolver for runtime options (WS4's second half).** The inventory is
  `docs/runtime-options.md`. The consolidation it was supposed to justify is not
  worth doing: of 202 options read from `src/`, 193 have exactly one consumer, and
  at the 9 multi-consumer sites the rules already agree. Routing 202 direct
  environment reads through a resolver would add indirection on paths the JIT
  consults per compile, without a defect to point at. The inventory is the part
  that was missing; the layer is not.
- **Breaking the require cycles (was WS9).** See F4: all three are already cut by
  deferred requires.

## 7. Remaining backlog

| # | Item | Evidence | Why not now |
| --- | --- | --- | --- |
| R1 | Decompose `compileMethodBody` (14,588 lines) | F8 | The largest remaining structural problem in the repo, and the only one that would materially shrink `JvmSsaBlockRenderer.js`. Needs its own programme with per-region tests. |
| R2 | One owner for `assertJsonValue` | F5 | Ownership spans `src/cfg` and `src/java-frontend`; one copy is in a file with uncommitted local changes. |
| R3 | The label-reading rules (`branchTargets`, `referencedLabels`, `collectReferencedLabels`) and the 7 singleton descriptor parsers | F5, WS6 | The attempted merge was reverted; doing it properly means deciding what the two `trimLabel` variants mean and moving each closure with its body. |
| R4 | `src/decompiler/cfr.js` (9,848 lines, 7 oversized functions) | F8 | Reviewed but untouched: no duplication or ownership defect found, only size. |
| R5 | `src/core/jvm.js` (4,709 lines, 10 oversized functions, 98 importers) | F8 | Highest fan-in in the repo; any split needs a consumer-by-consumer plan. |
| R6 | A Firefox project for the Playwright suite | workflow.md | Firefox is the target browser and no browser test covers it. This is new coverage, not cleanup. |

## 8. Splitting `compileMethodBody`

`JvmSsaBlockRenderer.js` was 16,610 lines, of which `compileMethodBody` alone was
14,588 — 88% of the file in one function. It resisted splitting for a concrete
reason, which a capture census makes visible: of the 42 nested functions it
declares that are 25 lines or more, **not one captures zero names** from the
enclosing scope. It is a single closure over shared state, so nothing can simply
be lifted out.

The census does show where the seams are, by capture set rather than by subject
matter. Two were cut.

### 8.1 Loop and local-relation analysis → `src/jit/loopRelations.js`

Thirteen functions — `affineLocalStep`, `carriedCountedLocalRelation`,
`packedAppendRelation`, `binaryLocalAssignment`, `cyclicLocalRange`,
`nestedCyclicLocalRange`, `scaledCountedLocalRelation`,
`quotientProductRecurrence`, `loopAssignmentDominates`, `loopPathExists`,
`constantInstructionValue`, `opOf`, `localIndex` — totalling 579 lines. They ask
questions *about* the bytecode and write nothing.

Their entire dependency on the rest of `compileMethodBody` is five names: `cfg`,
`items`, `labels`, `structured`, `directStaticSites`. They reference **nothing**
from the renderer's module scope and no other local. The five are captured once by
a factory rather than threaded through every call, which is safe because every
assignment to any of them happens at or before line 1735 and the binding is
created at line 2876 — checked by scanning the whole file for assignments, not
assumed.

`boundedStrideCursor` was left behind deliberately: it drags in seven further
names (`packedArrayCapacityFacts`, `boundedStrideCursorMemo`, `localWrites`,
`isZeroIntegerStore`, `itemDominates`, `matchingCursorLoopForWrite`), which is a
different and much wider contract.

All 13 bodies are byte-identical after de-indenting.

### 8.2 The statement-parts model → `src/jit/statementParts.js`

26 module-level declarations, 306 lines: the `parts*` and `skeleton*` query
family, `substituteParts`, `substituteLabelParts`, `renderParts`, the `Expr`
class and four constants. These answer questions about a rendered statement and
are pure functions of the parts handed to them.

The dividing line is not subject matter but state. `e`, `buildParts`,
`exprConcat`, `labelExpr`, `labelPart` and `appendPartValue` look like part of the
same family and are **not** moved: they read the render-scoped `activeEmittedNames`
and `activeOperandExpressions`, some only transitively (`e` → `buildParts` →
`appendPartValue`). A one-level purity check calls `e` pure and would have moved
it; the transitive closure is what says otherwise. The moved set is closed under
dependency — computing that closure is also what pulled `Expr` and the four
constants in, without which the move would have reproduced the WS6 `ReferenceError`.

All 26 declarations are byte-identical in their new home.

### Result, and what it does not do

| | Before | After |
| --- | --- | --- |
| `JvmSsaBlockRenderer.js` | 16,610 lines | 15,444 lines |
| `compileMethodBody` | 14,588 lines | 14,025 lines |
| Full suite | 11995, exit 0 | 11995, exit 0 |
| `npm run build:bundle` | exit 0 | exit 0, no new warnings |

**The function is still 14,025 lines.** 8.1 took 563 lines out of it; 8.2 shrank
the file but not the function, because it came from module scope. Honest scale:
at this rate the function does not get small, because the two clusters that remain
big are coupled to mutable emission state, not merely long:

- **Statement records** (6 functions, 435 lines) needs 9 locals — including
  `statementRecords`, `regionInsertionResult` and `regionInsertionLabel`, which are
  written during the render. A factory over those is passing the mutable render
  around under a new name, which is the coupling, not a fix for it.
- **Line specialisations** (8 functions, 410 lines) needs 15 locals and increments
  counters in place (`dominatedArithmeticGuardCount`,
  `eliminatedTerminalStructuredBreakCount`). Moving them means changing how those
  counts are returned — a semantic change, not a move.

Cutting those honestly means first giving the render its own object with named
fields instead of 200 sibling `const`s in one scope. That is a design change with
its own risk, and it should be its own piece of work rather than smuggled in as
"cleanup".

## 9. Replacing the implicit closure state

§8 stopped at "the remaining families are coupled to mutable render state".
That coupling was then made explicit rather than accepted.

### 9.1 The oracle

Generated JavaScript is the behavioural contract for this work, so it was frozen
before anything moved. `JVM_DUMP_GENERATED_DIR` writes every generated body to
disk; ten test files covering structured, restoring, checked-leaf, loop-heavy,
exception, region and field-access shapes produce **276 artifacts**. Running the
corpus twice on an unchanged tree produced byte-identical manifests, so the
oracle is deterministic and a difference means a real difference.

### 9.2 The counters became one record

29 of `compileMethodBody`'s 58 mutable siblings were counters (`init = 0`,
incremented in one to three places, read back as compile metadata). They now live
in a single `stats` record declared as the method's first statement. The rewrite
is AST-driven: only identifier references resolving to those declarations were
touched, and the one counter with a non-zero initialiser
(`dominatedArithmeticGuardCount = cfgDominatedArithmeticGuardCount`) keeps its
assignment at its original position, because it is a snapshot of another counter
at that point in the sequence rather than an initialisation.

Ownership of `stats`: created once per `compileMethodBody` call, written by the
render and by the extracted specialisations, read by the caller as metadata.
Lifetime is per-method. Nothing aliases it.

**This migration failed on its first attempt and the oracle caught it**: 7 of the
10 corpus files failed and 3 artifacts differed, one by a single call-site id
(`tryInvokeSyncAt(4)` becoming `tryInvokeSyncAt(2)`). Bisecting showed no counter
broke on its own, and an incremental prefix scan found the 29th
(`dominatedArithmeticGuardCount`) as the trigger. The cause was not semantic: it
is the only counter whose initialiser mentions another counter, so it received
two overlapping edits — the reference rewrite lengthened the text, and the
statement replacement then cut at an offset computed on the original, leaving a
stray `;Count;`. That parses, throws `ReferenceError` at run time, the compile
bails, and `getGeneratedFunction` returns null. Fixed by dropping reference edits
that fall inside a replaced declaration.

### 9.3 A previously unextractable family moved out

With the counters in a record, the line specialisations became movable: they were
welded into the closure precisely because they incremented bare `let` counters.
Seven of the eight — `canonicalCountedLoop`, `canonicalPostDecrementLoop`,
`specializeNonZeroBranch`, `specializeDeferredStaticArrayAccessLines`,
`transactionalizeAcyclicLeafLines`, `removeTerminalBreakTo` and
`groupStraightScopes` — are now `src/jit/lineSpecialisations.js`, built by a
factory taking 13 named context values plus `e`. They still mutate `stats`; that
is the point. The mutation is now an argument rather than an ambient capture.

`resumeDispatchConflicts` stayed behind for a stated reason: its context
(`resumeConflictNames`) is not declared until line 10170, and the family is first
used at 10164, so no single factory call can be placed both after all context and
before first use. Extracting it needs that binding moved first.

An ordering check gates the whole pattern: the factory is anchored immediately
after the last context declaration it captures, verified by comparing declaration
positions against the first use of any member. Getting this wrong is not
theoretical — the first attempt anchored the factory at the first family
declaration, before `deferredStaticArrayAccessByMarker` existed, and 8 assertions
failed until it was moved.

### 9.4 Before and after

| Measure | Session start | Now |
| --- | --- | --- |
| `JvmSsaBlockRenderer.js` | 16,611 lines | **15,100** |
| `compileMethodBody` | 14,588 lines | **13,679** |
| Mutable sibling locals | 58 | **28** |
| Function-valued siblings | 156 | 136 |
| Nested functions >= 25 lines | 42 | **27** |
| Captures by those functions | 365 | **280** |
| Extracted modules | — | `generatedSourceVerifier` 174, `statementIrAudit` 153, `statementParts` 394, `loopRelations` 628, `lineSpecialisations` 415 |
| Full suite | 11995, exit 0 | **11995, exit 0** |
| Frozen artifacts | 276 | **276, byte-identical** |

The mega-closure is not gone: 13,679 lines and 28 mutable siblings remain. What
changed is that the pattern for removing a family is now established and has a
working oracle — classify the state, give the family an explicit context, anchor
the factory after its context, and diff the generated corpus.
