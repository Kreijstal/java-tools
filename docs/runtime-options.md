# Runtime options

Every option is an environment variable read at the point of use. This page is
the inventory the code did not previously have: what exists, who reads it, and
which options cross module boundaries.

Method: the table lists every `JVM_*` name read through `process.env` (or a local
`env` alias) from a file under `src/`, excluding `src/jre/`. Names that appear only
in comments, documentation or test harnesses are not listed, because a mention is
not a consumer. "Also read outside `src/`" means tests, `scripts/` or `tools/` read
the same name — those readers are usually the ones that *set* it for a child
process.

Totals: **202 options read from `src/`, across 15 files.** 172 of them are also
referenced outside `src/`. Only **9 are read from more than one `src/` file**;
the other 193 have exactly one consumer each.

## Options with more than one consumer

These are the only options where two modules must agree on a rule, so they are
the only ones where a duplicated default can drift. Each is currently spelled out
independently at every site; the readings agree today, and this table is the
record of what "agree" means.

| Option | Rule at every site | Sites |
| --- | --- | --- |
| `JVM_DEBUG_ARRAY_OOB` | `=== "1"` | `instructions/utils.js` x2, `jit/JitCompiler.js` x3, `jit/StructuredWasmCompiler.js`, `jit/wasmShared.js` |
| `JVM_TRACE` | presence (truthy) | `core/jvm.js` x2, `jit/JitCompiler.js`, `jit/WasmJit.js` |
| `JVM_PROFILE_HOT_METHODS` | `=== '1'` (`!== '1'` when negated) | `core/jvm.js` x2, `jit/JitCompiler.js`, `jit/WasmJit.js` |
| `JVM_DEBUG_NULL_ARRAY` | `=== "1"` | `instructions/utils.js` x2, `jit/JitCompiler.js` |
| `JVM_DEBUG_INVOKE_TRACE` | string, default `""` | `core/callStack.js`, `jit/JitCompiler.js` |
| `JVM_DEBUG_INVOKE_FIELDS` | string, default `"f"` | `core/callStack.js`, `jit/JitCompiler.js` |
| `JVM_DEBUG_CONSTRUCTORS` | comma-separated list, default empty | `instructions/invoke.js`, `jit/JitCompiler.js` |
| `JVM_ENABLE_CHECKED_LEAF_POSITIONAL` | `=== "1"` | `jit/JitCompiler.js`, `jit/JvmSsaBlockRenderer.js` |
| `JVM_WASM_EH` | on unless `'0'` | `jit/StructuredWasmCompiler.js`, `jit/WasmJit.js` |

Note that the interpreter and the JIT deliberately read `JVM_DEBUG_ARRAY_OOB` and
`JVM_DEBUG_NULL_ARRAY` separately: each tier emits its own check, so the option is
consulted once per tier by design, not by accident.

## Precedence

There is no precedence chain to document: no option is resolved from more than one
source. Each is read directly from the environment, and a value set for the parent
process reaches a compile worker only because `CompileWorkerClient` inherits the
environment when it spawns the thread. Options that must reach the worker are
therefore ordinary environment variables, not part of the transported request.

## Status

Options are not versioned and none is deprecated in code. Treat every name below
as supported-but-internal: they exist for diagnosis and for pinning tier selection
in tests, and nothing outside this repository is expected to set them.

## Full inventory

| Option | Read from | Also read outside `src/` |
| --- | --- | --- |
| `JVM_ADAPTIVE_CONSTRUCTOR_CALLERS` | jit/JitCompiler.js | yes |
| `JVM_ADAPTIVE_FRAMELESS_BUDGET_MULTIPLIER` | jit/JitCompiler.js | yes |
| `JVM_ADAPTIVE_WHOLE_METHOD_ESCALATION_THRESHOLD` | jit/JitCompiler.js | yes |
| `JVM_AWT_PRESENTATION_BACKPRESSURE` | core/jvm.js | yes |
| `JVM_AWT_STRUCTURED_YIELD_GRACE_MS` | core/jvm.js | yes |
| `JVM_DEBUG_ARRAY_OOB` | instructions/utils.js<br>jit/JitCompiler.js<br>jit/StructuredWasmCompiler.js<br>+1 more | yes |
| `JVM_DEBUG_ARRAY_OOB_FIELDS` | jit/JitCompiler.js | yes |
| `JVM_DEBUG_ARRAY_OOB_STATICS` | jit/JitCompiler.js | yes |
| `JVM_DEBUG_CHECKCAST` | instructions/object.js | yes |
| `JVM_DEBUG_CONSTRUCTORS` | instructions/invoke.js<br>jit/JitCompiler.js | yes |
| `JVM_DEBUG_FUSE` | jit/StructuredWasmCompiler.js | yes |
| `JVM_DEBUG_GETFIELD` | core/jvm.js | yes |
| `JVM_DEBUG_IDLE` | core/jvm.js | yes |
| `JVM_DEBUG_INSERTION_VETO` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DEBUG_INVOKE_FIELDS` | core/callStack.js<br>jit/JitCompiler.js | yes |
| `JVM_DEBUG_INVOKE_TRACE` | core/callStack.js<br>jit/JitCompiler.js | yes |
| `JVM_DEBUG_JIT` | jit/JitCompiler.js | yes |
| `JVM_DEBUG_NONTOP_INVOKE` | jit/JitCompiler.js | yes |
| `JVM_DEBUG_NULL_ARRAY` | instructions/utils.js<br>jit/JitCompiler.js | yes |
| `JVM_DEBUG_OSR_SNAPSHOT_DIR` | jit/JitCompiler.js | yes |
| `JVM_DEBUG_OUTLINE_NAMES` | jit/HotCallGraphRegionCompiler.js | yes |
| `JVM_DEBUG_PARTITION` | jit/HotCallGraphRegionCompiler.js | yes |
| `JVM_DEBUG_PARTITION_DUMP` | jit/HotCallGraphRegionCompiler.js | yes |
| `JVM_DEBUG_POSITIONAL_DEPTH` | jit/JitCompiler.js | yes |
| `JVM_DEBUG_PUTFIELD` | core/jvm.js | yes |
| `JVM_DEBUG_PUTFIELD_STACK` | core/jvm.js | yes |
| `JVM_DEBUG_RESUME_CONFLICTS` | jit/JvmSsaBlockRenderer.js | no |
| `JVM_DEBUG_STATIC_WRITES` | core/jvm.js | yes |
| `JVM_DEBUG_STATIC_WRITES_EVERY` | core/jvm.js | yes |
| `JVM_DEBUG_THROW` | core/jvm.js | yes |
| `JVM_DEBUG_THROW_TYPE` | core/jvm.js | yes |
| `JVM_DEBUG_WASMJIT` | jit/WasmJit.js | yes |
| `JVM_DENSE_INSTANCE_FIELDS` | core/jvm.js | yes |
| `JVM_DISABLE_ADAPTIVE_FRAMELESS_POSITIONAL` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_AUDIO` | platform/audio.js | yes |
| `JVM_DISABLE_CALL_GRAPH_STRUCTURED_FIRST` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_COLD_LINKED_STATIC_READ_CACHE` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_DIRECT_STATIC_JRE_INTRINSICS` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_DYNAMIC_ARRAY_STRUCTURED_FIRST` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_EFFECTFUL_FIELD_POSITIONAL` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_ENTRY_STATIC_READ_CACHE` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_GENERATOR_VAR_DECLARATIONS` | jit/JitCompiler.js | no |
| `JVM_DISABLE_INLINE_LOOP_REGIONS` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_JIT` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_LARGE_ACYCLIC_CALL_TREES` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_LONG_ARITHMETIC_WASM_FIRST` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_MEMOIZED_INTEGRAL_LEAVES` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_ORDINARY_ADAPTIVE_RESUME_COVERAGE` | jit/JvmSsaBlockRenderer.js | no |
| `JVM_DISABLE_POSITIONAL_GENERATED_CALLS` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_POST_INCREMENT_HELPERS` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_READY_WASM_POSITIONAL_RELEASE` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_REFERENCE_STATIC_POSITIONAL` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_SSA_ACYCLIC_INLINE_SPILLS` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_SSA_MATERIALIZE_OUTLINING` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_SSA_UNWIND_COMPACT_MATERIALIZATION` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_ATOMIC_BOUNDED_LOOPS` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_BIT_BOUNDED_RANGES` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_COARSE_COUNTED_SAFEPOINTS` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_COMPACT_CALL_COLD_PATHS` | jit/JvmSsaBlockRenderer.js | no |
| `JVM_DISABLE_STRUCTURED_COMPACT_FIELD_CACHE_INVALIDATION` | jit/JvmSsaBlockRenderer.js | no |
| `JVM_DISABLE_STRUCTURED_CONTINUATIONS` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_DEFERRED_CALL_MATERIALIZATION` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_DIRECT_ENTRY_STATIC_LINKING` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_DISPATCH_ISLANDS` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_INLINE_ARRAY_STORES` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_LAZY_STATIC_TARGETS` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_LOCAL_VALUES` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_PER_CALL_SITE_LINKS` | jit/JvmSsaBlockRenderer.js | no |
| `JVM_DISABLE_STRUCTURED_RESUME_ENTRY` | jit/JvmSsaBlockRenderer.js | no |
| `JVM_DISABLE_STRUCTURED_RESUME_ENTRY_BRANCHES` | jit/JvmSsaBlockRenderer.js | no |
| `JVM_DISABLE_STRUCTURED_STATIC_BOOLEAN_GUARDS` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_STRAIGHT_BLOCK_SCOPES` | jit/JvmSsaBlockRenderer.js | no |
| `JVM_DISABLE_STRUCTURED_UNSAFE_CONSTRUCTOR_CALLERS` | jit/JitCompiler.js | yes |
| `JVM_DISABLE_STRUCTURED_UNSIGNED_ARRAY_BOUNDS` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_VERSIONED_ARRAY_RANGES` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_VERSIONED_ARRAY_STORES` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_STRUCTURED_VERSIONED_COARSE_LOOPS` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_DISABLE_WASM_FIELD_CACHE` | jit/WasmJit.js | yes |
| `JVM_DISABLE_WASM_LATE_INSTANCE_TARGETS` | jit/WasmJit.js | yes |
| `JVM_DISABLE_WASM_TYPED_ARRAY_STORES` | jit/WasmJit.js | yes |
| `JVM_DISABLE_ZERO_COPY_DISCARD_AUDIO` | platform/audio.js | yes |
| `JVM_DUMP_GENERATED_CAPTURES` | jit/JitCompiler.js | no |
| `JVM_DUMP_GENERATED_DIR` | jit/JitCompiler.js | yes |
| `JVM_DUMP_GENERATED_METHODS` | jit/JitCompiler.js | yes |
| `JVM_EAGER_MONOMORPHIC_CALL_MAX_CODE_ITEMS` | jit/JitCompiler.js | yes |
| `JVM_ENABLE_ARRAY_KERNEL_WASM_FIRST` | jit/JitCompiler.js | yes |
| `JVM_ENABLE_AWT_WEBGL_PRESENTATION` | core/jvm.js | yes |
| `JVM_ENABLE_CHECKED_LEAF_POSITIONAL` | jit/JitCompiler.js<br>jit/JvmSsaBlockRenderer.js | yes |
| `JVM_ENABLE_COMPILED_CALL_CHAINS` | jit/JitCompiler.js | yes |
| `JVM_ENABLE_EAGER_MONOMORPHIC_CALLS` | jit/JitCompiler.js | yes |
| `JVM_ENABLE_EFFECTFUL_MONITOR_CODEGEN` | jit/JitCompiler.js | yes |
| `JVM_ENABLE_FRAME_POSITIONAL_CALLS` | jit/JitCompiler.js | yes |
| `JVM_ENABLE_GRAPH_OWNED_STRUCTURED_CANDIDATES` | jit/JitCompiler.js | yes |
| `JVM_ENABLE_ORDINARY_ADAPTIVE_FRAMELESS` | jit/JitCompiler.js | yes |
| `JVM_ENABLE_RENDERER_PIPELINE` | jit/JitCompiler.js | yes |
| `JVM_ENABLE_SCALAR_BOUNDED_INLINE_REGIONS` | jit/JitCompiler.js | yes |
| `JVM_ENABLE_SCALAR_GUEST_BODIES` | jit/JitCompiler.js | yes |
| `JVM_ENABLE_SCALAR_SSA` | jit/JitCompiler.js | yes |
| `JVM_ENABLE_STRUCTURED_IRREDUCIBLE_SPLITTING` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_EVENT_LOOP_YIELD_MS` | core/jvm.js | yes |
| `JVM_EVENT_LOOP_YIELD_STRATEGY` | core/jvm.js | yes |
| `JVM_FAKE_TIME` | core/jvm.js | yes |
| `JVM_FAKE_TIME_REALTIME` | core/jvm.js | yes |
| `JVM_FAKE_TIME_STEP` | core/jvm.js | yes |
| `JVM_FRAME_DIR` | core/jvm.js | yes |
| `JVM_GENERATED_SCHEDULER_BURST` | core/jvm.js | yes |
| `JVM_HOT_LOOP_CONSTRUCTORS` | jit/JitCompiler.js | yes |
| `JVM_INTERPRETER_BURST` | core/jvm.js | yes |
| `JVM_JIT_ASSERT_NO_POST_MAIN_SYNC_COMPILE` | jit/JitCompiler.js | yes |
| `JVM_JIT_DENY` | jit/JitCompiler.js | yes |
| `JVM_JIT_EXPERIMENTAL_CONTROL_FLOW` | jit/JitCompiler.js | yes |
| `JVM_JIT_HOTNESS` | jit/JitCompiler.js | no |
| `JVM_JIT_HOTNESS_BYTECODE_WEIGHT` | jit/JitCompiler.js | no |
| `JVM_JIT_HOTNESS_LOOPS_ON_SIGHT` | jit/JitCompiler.js | no |
| `JVM_JIT_HOTNESS_MIN_SCORE` | jit/JitCompiler.js | no |
| `JVM_JIT_HOTNESS_TICK_MS` | jit/JitCompiler.js | no |
| `JVM_JIT_HOTNESS_TOP` | jit/JitCompiler.js | no |
| `JVM_JIT_LOOP_WARMUP` | jit/JitCompiler.js | yes |
| `JVM_JIT_REFUSE_POST_MAIN_WASM` | jit/WasmJit.js | no |
| `JVM_JIT_RESULT_CENSUS` | jit/JitCompiler.js | no |
| `JVM_JIT_SHADOW_COMPILE_REPORT` | jit/ShadowCompiler.js | no |
| `JVM_JIT_TRACE_POST_MAIN_SYNC_COMPILE` | jit/JitCompiler.js | yes |
| `JVM_JIT_VERIFY_FREE_NAMES` | jit/JitCompiler.js | no |
| `JVM_JIT_VERIFY_GENERATED` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_JIT_VERIFY_STATEMENT_IR` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_JIT_WARMUP` | jit/JitCompiler.js | yes |
| `JVM_JIT_WASM_EXECUTION_ONLY` | core/jvm.js | no |
| `JVM_MAX_STACK_DEPTH` | core/jvm.js | yes |
| `JVM_ORDINARY_ADAPTIVE_CALL_CHAIN_SAFE_POINT_BUDGET` | jit/JitCompiler.js | yes |
| `JVM_PROFILE_HOT_METHODS` | core/jvm.js<br>jit/JitCompiler.js<br>jit/WasmJit.js | yes |
| `JVM_PROFILE_HOT_METHODS_WITH_JIT` | core/jvm.js | yes |
| `JVM_PROFILE_JIT_METHODS` | jit/JitCompiler.js | yes |
| `JVM_PROFILE_SCHEDULER_TIMES` | core/jvm.js | yes |
| `JVM_SCHEDULER_STARVATION_MS` | core/jvm.js | no |
| `JVM_STRUCTURED_RESTORING_DIRECT_BUDGET_MULTIPLIER` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_TRACE` | core/jvm.js<br>jit/JitCompiler.js<br>jit/WasmJit.js | yes |
| `JVM_TRACE_EXIT` | core/jvm.js | yes |
| `JVM_TRACE_FRAME_HANDOFF` | instructions/invoke.js | yes |
| `JVM_TRACE_FRAME_HANDOFF_PC` | instructions/invoke.js | yes |
| `JVM_TRACE_JIT_METHOD` | jit/JitCompiler.js | yes |
| `JVM_TRACE_JIT_SOURCE` | jit/JitCompiler.js | yes |
| `JVM_TRACE_JIT_SOURCE_AROUND_LINE` | jit/JitCompiler.js | yes |
| `JVM_TRACE_POSITIONAL_GENERATED` | jit/JitCompiler.js | yes |
| `JVM_TRACE_REGION_SOURCE_DIR` | jit/HotCallGraphRegionCompiler.js | yes |
| `JVM_TRACE_STRUCTURED_ARRAY_RANGES` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_TRACE_STRUCTURED_ONLY` | jit/JitCompiler.js | yes |
| `JVM_TRACE_STRUCTURED_POSITIONAL` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_TRACE_STRUCTURED_RECURSIVE_ARRAY` | jit/JvmSsaBlockRenderer.js | yes |
| `JVM_TRACE_SYNC_CALLS` | jit/JitCompiler.js | yes |
| `JVM_TRACE_WASM_EXITS_ONLY` | jit/WasmJit.js | yes |
| `JVM_TRACE_WASM_METHOD` | jit/WasmJit.js | yes |
| `JVM_WASM_CENSUS` | jit/WasmJit.js | yes |
| `JVM_WASM_CENSUS_FILE` | jit/WasmJit.js | yes |
| `JVM_WASM_CENSUS_SHADOW` | jit/WasmJit.js | yes |
| `JVM_WASM_CHECKCAST` | jit/WasmJit.js | yes |
| `JVM_WASM_CLEAR_DROPPED` | jit/StructuredWasmCompiler.js | yes |
| `JVM_WASM_CTOR` | jit/WasmJit.js | no |
| `JVM_WASM_DEMOTE_BLOCKS` | jit/StructuredWasmCompiler.js | yes |
| `JVM_WASM_DEP_RECOMPILES` | jit/WasmJit.js | yes |
| `JVM_WASM_DEVIRT` | jit/WasmJit.js | yes |
| `JVM_WASM_DIRECT_INSTANCE_LINK` | jit/WasmJit.js | yes |
| `JVM_WASM_DIRECT_STATIC_LINK` | jit/WasmJit.js | yes |
| `JVM_WASM_DUMP_ACCEPT` | jit/WasmJit.js | yes |
| `JVM_WASM_DUMP_REJECT` | jit/WasmJit.js | yes |
| `JVM_WASM_EH` | jit/StructuredWasmCompiler.js<br>jit/WasmJit.js | yes |
| `JVM_WASM_FAILED_RETRY_FACTOR` | jit/WasmJit.js | yes |
| `JVM_WASM_FAILED_RETRY_MIN_MS` | jit/WasmJit.js | yes |
| `JVM_WASM_FIELDS` | core/jvm.js | yes |
| `JVM_WASM_FUEL` | jit/wasmShared.js | yes |
| `JVM_WASM_FUSE_RECEIVER` | jit/StructuredWasmCompiler.js | yes |
| `JVM_WASM_HEAP` | core/jvm.js | yes |
| `JVM_WASM_HEAP_ARRAYS` | jit/StructuredWasmCompiler.js | yes |
| `JVM_WASM_HEAP_MB` | core/jvm.js | yes |
| `JVM_WASM_HEAP_RECLAIM` | core/wasmHeap.js | yes |
| `JVM_WASM_HEAP_SAMPLE_MS` | core/jvm.js | no |
| `JVM_WASM_HEAP_SAMPLE_OUT` | core/jvm.js | no |
| `JVM_WASM_IMPORT_STATS` | jit/WasmJit.js | yes |
| `JVM_WASM_INLINE` | jit/StructuredWasmCompiler.js | yes |
| `JVM_WASM_INSTANCE_INLINE` | jit/StructuredWasmCompiler.js | yes |
| `JVM_WASM_JIT` | jit/WasmJit.js | yes |
| `JVM_WASM_JIT_RETRY_BACKOFF_MAX` | jit/WasmJit.js | yes |
| `JVM_WASM_JIT_WARMUP` | jit/WasmJit.js | yes |
| `JVM_WASM_LINK_TABLE` | jit/WasmJit.js | no |
| `JVM_WASM_LOOPFREE_WARMUP` | jit/WasmJit.js | no |
| `JVM_WASM_MAX_IMPLS` | jit/wasmShared.js | yes |
| `JVM_WASM_NO_ONDEMAND_CALLEE` | jit/WasmJit.js | no |
| `JVM_WASM_NO_OSR` | jit/WasmJit.js | yes |
| `JVM_WASM_NO_OSR_METHODS` | jit/WasmJit.js | yes |
| `JVM_WASM_PREFER_FORCE` | jit/WasmJit.js | yes |
| `JVM_WASM_PREFER_FULL_COVERAGE` | jit/WasmJit.js | yes |
| `JVM_WASM_PREFER_FULL_COVERAGE_ONLY` | jit/WasmJit.js | yes |
| `JVM_WASM_RELAXED_REF_RETURN` | jit/WasmJit.js | yes |
| `JVM_WASM_RELINK_LIMIT` | jit/WasmJit.js | no |
| `JVM_WASM_STRUCTURED` | jit/WasmJit.js | yes |
| `JVM_WASM_TRACE_ARRAYS` | jit/wasmRuntimeImports.js | yes |
| `JVM_WASM_TRACE_ARRAYS_CHUNK` | jit/wasmRuntimeImports.js | yes |
| `JVM_WASM_TRACE_ARRAYS_FROM` | jit/wasmRuntimeImports.js | yes |
| `JVM_WASM_TRACE_ARRAYS_OUT` | jit/wasmRuntimeImports.js | yes |
| `JVM_WASM_TRACE_ARRAYS_TAIL` | jit/wasmRuntimeImports.js | yes |
| `JVM_WASM_TRACE_ARRAYS_TO` | jit/wasmRuntimeImports.js | yes |
| `JVM_WASM_TRACE_COMPILE_ERRORS` | jit/WasmJit.js | no |
| `JVM_WASM_TRACE_RESUME` | jit/WasmJit.js | yes |
