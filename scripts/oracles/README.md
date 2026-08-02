# Historical kernel oracles

These modules preserve retired handwritten implementations solely for
differential correctness and relative-performance regression tests.

Production code under `src/` must never import this directory. The browser
bundle therefore contains only bytecode-derived JIT implementations. The
`fusedHotLoopRegression` test enforces that the production JVM dependency
graph loads no oracle module and exposes no historical-kernel selection gate.

The primary fast comparison is:

```sh
SSA_KERNEL_TARGET_ITERATIONS=10000 \
SSA_KERNEL_TARGET_ROUNDS=5 \
SSA_KERNEL_TARGET_WARMUPS=4 \
node scripts/benchmarkSsaHandwrittenKernelTargets.js
```

CI uses the corresponding failing gate (normally about three seconds):

```sh
npm run test:performance:jvm-kernel-proxy
```

Each paired result must first match its destination checksum. Timing uses
alternating generic/oracle order and the median paired ratio, so machine speed
and most process-wide noise cancel out. The slower three-process acceptance
measurement remains the authority for the strict `generic/oracle <= 1.01`
retirement threshold.

The real-bytecode gradient/flat differential is:

```sh
node scripts/differentialFusedRenderers.js /path/to/classes 200
```
