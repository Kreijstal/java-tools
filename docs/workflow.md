# Working on this repository

Everything routine is one of the commands below. Anything not listed here is an
experiment, not a supported workflow.

## Build

| Command | What it does |
| --- | --- |
| `npm install` | Dependencies. |
| `npm run build:java` | Compiles the Java sources under `sources/` with the real `javac`. |
| `npm run generate` | Regenerates data tables (`scripts/generateData.js`). |
| `npm run build:bundle` | Regenerates the JRE index, then webpack production build. |
| `npm run build` | `generate` + `build:bundle` + `scripts/buildSite.js`. |
| `npm run clean` | Deletes `sources/**/*.class` and `dist/`. |

`npm run build:bundle` produces `dist/jvm-debug.js`, `dist/jvm-compile-worker.js`,
`dist/ide-ui.js` and the lazy chunks. It does **not** produce
`dist/browser-ui-enhancements.js` or `dist/workbench-ui.js`: those are copied out of
`src/platform/` by `scripts/buildSite.js` (lines 158-166), which only `npm run build`
runs. Editing either of those two files and rebuilding just the bundle leaves the old
copy in `dist/` -- which is what the Playwright suite then tests.

There are three webpack entry graphs, and only these three:
`src/platform/browser-entry.js`, `src/platform/ide/main.js`, and
`src/jit/compileWorkerThread.js`.

## Tests

There are two suites with confusingly similar directory names:

| Suite | Location | Runner | Command |
| --- | --- | --- | --- |
| Unit/integration (Node) | `test/*.test.js` (259 files) | tape | `npm test` |
| Browser end-to-end | `tests/playwright/*.spec.js` (15 files) | Playwright | `npm run test:playwright` |

`npm test` runs `scripts/run-tests.js` -> `run-tests.sh`, which globs
`test/*.test.js` and runs each file in its own `node tape` process under a
`timeout`. The default budget is 15 s per file; `run-tests.sh` holds the explicit
exceptions (600 s for `jitCompiler`, 120 s for `breakpointLocations`,
`hotCallGraphRegion`, `structuredWasm`, `wasmHeapArrays`, `wasmInstanceInline`,
`wasmInstanceLink` and `javaFrontendIr`, 180 s for `javaFrontendAllJavaCompile`,
60 s for `data-zip-download` and `hierarchyRename`, and no timeout for
`roundtrip`, which enforces its own).

Useful invocations:

```bash
npm test                                    # whole suite; STOPS at the first failing FILE
JVM_TEST_CONTINUE_ON_FAILURE=1 npm test     # whole suite; runs everything, lists failures
bash run-tests.sh test/jitFreeNames.test.js # one file
bash run-tests.sh jitFreeNames              # same file, by test name
bash run-tests.sh --skip 'wasm*' -- ...     # skip by glob (or JVM_TEST_SKIP=...)
npm run test:cfr                            # the six CFR suites
npm run test:java-frontend                  # the eight java-frontend suites
npm run test:all                            # npm test && npm run test:playwright
```

Default `npm test` exits at the first failing *file*, so a run that fails early
covers only part of the suite. Use `JVM_TEST_CONTINUE_ON_FAILURE=1` whenever you
are comparing against a baseline.

### What the suites do and do not cover

- `npm test` forces `JVM_DISABLE_AUDIO=1` (set in `scripts/run-tests.js`), so no
  Node test exercises real audio output. Audio behaviour is covered only by
  `test/webAudio.test.js`'s own fakes.
- Playwright runs **Chromium only**: `playwright.config.js` declares a single
  project. There is no Firefox or WebKit project, so no browser test in this
  repository covers Firefox, even though Firefox is the target browser for the
  performance work. Firefox behaviour is measured out-of-tree.
- The Playwright suite starts its own server (`npm run serve`) and reuses an
  already-running one outside CI, so a stale server on the same port silently
  serves an old bundle.
- Worker/preparation modes are covered in-process by `test/jitCompileWorker`,
  `test/workerEquivalence`, `test/jitShadowCompile` and `test/jitWarmthTransport`
  rather than by spawning real workers, except where those files say otherwise.

## Benchmarks

`benchmarks/*.java` are the workloads; `scripts/benchmark*.js` are the drivers,
each exposed as an `npm run benchmark:*` script (`benchmark:jvm:intermethod`,
`benchmark:jvm:hot-call-graph`, `benchmark:jvm:ssa-fixed-point`,
`benchmark:jvm:ssa-span-kernel`, `benchmark:jit:fields`, `benchmark:phase1-worker`,
and the Firefox-driven `benchmark:awt:firefox`, `benchmark:ceiling:firefox`,
`benchmark:canvas:firefox`, `benchmark:pcm-push:firefox`).
`bench/g0-linear-runtime/` is retained evidence from the linear-runtime gate, not
a runnable benchmark.

Benchmarks are timing measurements: run them one at a time on an otherwise idle
machine, and never concurrently with a test suite or a build.

## Other entry points

| Command | Purpose |
| --- | --- |
| `npm run serve` | Development server for the browser debugger/IDE. |
| `npm run jshell` | Interactive Java snippet runner. |
| `npm run run:jar` | Runs a jar on the JS JVM. |
| `npm run cfr -- <class>` | The JavaScript CFR-style decompiler. |
| `npm run lint:jasmin` | Jasmin lint/fix CLI. |
| `node scripts/jvm-cli.js` | Unified CLI (highest fan-out entry point in the repo). |
| `npm run health-check` | Environment sanity check. |
| `npm run ci` | `build` + `test`, what CI runs. |

## Runtime options

Options are environment variables read at the point of use. The inventory —
which exist, who reads them, and which ones cross module boundaries — is
[docs/runtime-options.md](runtime-options.md).

## Documentation

Maintained reference, kept current with the code:

- [assembly.md](assembly.md) — assembler and disassembler
- [compiler.md](compiler.md) — the Java source compiler
- [decompiler.md](decompiler.md) — structured, goto-free decompilation
- [ide.md](ide.md) / [workbench.md](workbench.md) — the two browser UIs
- [jshell.md](jshell.md) — interactive shell
- [lsp.md](lsp.md) / [tooling.md](tooling.md) — LSP, MCP and CLI integration
- [runtime-options.md](runtime-options.md) — environment options inventory
- [repository-map.md](repository-map.md) — structure, ownership and backlog
- [workflow.md](workflow.md) — this page

Plans and experiment records, which keep their original claims and dates and are
**not** updated to match current behaviour:

- [plan-linear-runtime.md](plan-linear-runtime.md) — background compiler, linear
  memory and wide Wasm; phase gates and their measured results
- [region-compiler-emission-plan.md](region-compiler-emission-plan.md)
- [phase1-worker-audit.md](phase1-worker-audit.md) and
  `sample-phase1-worker-benchmark.json`
