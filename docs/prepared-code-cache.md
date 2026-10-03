# Optional preparation cache

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
