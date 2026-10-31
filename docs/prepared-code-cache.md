# Preparation caches

## Closed-world Wasm

Browser hosts can set `jvm.jit.closedWorld.cacheIdentity` to a SHA-256 identity
of their exact compiler/runtime assets before preparation. When IndexedDB is
available, the VM automatically caches the finished Wasm binary and symbolic
binding metadata. An unchanged launch restores it before method analysis,
linking and code generation. Class loading and layout still run, and every VM
gets fresh memory, statics, strings, class mirrors, exception tags and imports.
Guest initialization and execution retain their normal semantics.

Keys cover guest bytecode/constants, native implementations/declarations,
class layouts/IDs, heap layout, stack limit and Wasm/JSPI configuration as well
as the host's runtime identity. Integrity receipts cover metadata and bytes.
Missing, stale or corrupt entries and storage failures fall back to an ordinary
build. No live VM objects, generated JavaScript, closures or SSA are stored.

The origin-local IndexedDB store permits at most eight entries and 64 MiB of
accounted storage, with a 16 MiB limit per artifact (binary bytes plus stored
metadata bytes). Large binding metadata is gzip compressed and has a separate
32 MiB decoded limit. Oldest entries are evicted using index keys;
eviction does not deserialize their payloads. These limits do not bound total
browser heap or the engine's native code memory.

The WebAssembly Web API prohibits serializing `WebAssembly.Module` for persistent
storage. Browsers therefore still compile the saved final binary on reload;
this cache removes the VM's compiler passes, rather than claiming to persist
browser machine code. A host-provided `preparationCache` backend can reuse native
Modules within a process through structured cloning. A custom section binds
such Modules to their metadata and input identity before instantiation.

`closedWorld.stats().cache` reports `stored`, `hit`, `miss`, `rejected`,
`not-stored`, `write-failed` or `unavailable`, and whether a native Module was
reused. This is separate from Java source compilation and JVM bundle caches.

Validate with:

```
/usr/bin/node --test test/closedWorldCompiler.test.js test/closedWorldPreparationCache.test.js
```

The consuming launcher's `scripts/test-closed-world-cache-browser.mjs` checks
an isolated browser bundle across full Chromium/Firefox restarts, including
fresh static state, zero warm analysis/assembly calls and exactly one browser
compilation of the saved binary.

## Per-method JavaScript (optional)

`jvm.precompileInitializedClasses({effectful: true, preparedCodeCache})` can
reuse trusted compiler output before the guest starts. This feature is off by
default. It does not cache WebAssembly preparation or support hot call graph
regions. Game preparation priorities remain the embedder's responsibility.

```js
preparedCodeCache: {
  identity: {runtime, source, patch, configuration},
  maxEntryBytes: 8 * 1024 * 1024,
  store: {
    async get(key, maxBytes) { /* return a JSON string, or null */ },
    async put(key, text) { /* persist this method's JSON string */ },
  },
}
```

All four identities must be nonempty, immutable fingerprints: matching JVM
artifacts, Java source, applied patches, and the effective runtime configuration
(including preparation policy). The embedder must invalidate entries when any
of these changes. Store only trusted compiler output; materialization executes
generated JavaScript. This is not an untrusted-code validation boundary.

The store must enforce `maxBytes` before loading the full string, for example
using separately stored size metadata. Byte accounting uses twice the JavaScript
string length. Return null for a missing or oversized record. Persist entries
atomically. Reads, compilation, and writes are sequential; the cache retains
only one entry at a time. Storage failure disables caching for the pass and
ordinary compilation continues. There is no background write queue.

Keys include the table prefix as well as the method and identities, so a body
compiled in a later fixed-point round does not displace its earlier position.
Replay checks exact table prefixes, fresh site ranges, payload staleness, and
transport accounting before installation. A rejected record disables subsequent
replay for that pass, since numbered references may have diverged. Compilation
can refresh entries. A failed materialization may already have reserved ranges;
it is not transactional, and later runs may need to recompile that prefix.

The entry allowance is capped by the remaining installed-source allowance
(default 64 MiB). Checks account conservatively for serialized and decoded
payloads plus reserved slots. They do not bound transient serialization
allocations, executable V8 memory, total heap, or persistent storage size.
Embedders must separately bound storage and measure aggregate runtime heap.

`result.report.preparedCache` reports hits, misses, writes, refusals, storage
errors, and the largest single serialized payload accounted. These are not
performance acceptance results. Validate cold and warm startup, execution,
heap, and actual presented frames before enabling a browser integration.
