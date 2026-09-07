# G0: linear-memory object model, deciding measurement

Reproduces the two G0 measurements of docs/plan-linear-runtime.md in the
SpiderMonkey shell (Ion). Get a shell with
`curl -sfLO https://archive.mozilla.org/pub/firefox/releases/153.0/jsshell/jsshell-linux-x86_64.zip`.

    js kernel/bench_blit.js kernel A1     # jvm.js restoring-positional tier, plain Array (linear heap off)
    js kernel/bench_blit.js kernel A2     # same tier, Int32Array (linear heap on)
    js kernel/bench_blit.js kernel B2     # hand JS over Int32Array
    js kernel/bench_blit.js kernel C      # hand Wasm reading linear memory (blit.wat)
    js driver/bench_driver.js driver A1   # jvm.js tiers of fh.a + ke.a, h.a, ok.*, hk.c, linked as the runtime links them
    js driver/bench_driver.js driver B    # hand JS, direct calls
    js driver/bench_driver.js driver C    # hand Wasm, direct calls (driver.wat)
    js driver/bench_swap.js driver A1     # jvm.js chain with only the hk.c span leaf replaced by hand JS

Run one variant per process: a body that has seen both array kinds goes
polymorphic and no game build has both. Every variant checks the raster
checksum against the others.

kernel/blit.generated_*.js is the restoring-positional body jvm.js emits for
ck.a(III[I[IIIIIIIIII)V (dump-tiers.js against dekobloko.jar). driver/gamegen/
holds the bodies the booted game compiled, with the capture sidecars written
by JVM_DUMP_GENERATED_DIR=... JVM_DUMP_GENERATED_CAPTURES=1.
