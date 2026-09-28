# GeoBlox memory and stall investigation checkpoint

This branch preserves the accumulated JVM source and regression fixtures used by the GeoBlox investigation, including preparation root filtering. It is a work-in-progress checkpoint, not a performance-approved release. The isolated Deko v29 diagnostic removes an observed audio-transition compilation chain, but measured gameplay submissions remain below target. AWT submissions are not verified presented frames. Normal GitHub loading, five launches, ten-minute stability, catalog checks and phone verification remain open.

Focused validation:

```sh
node scripts/generate-jre-index.js
node node_modules/tape/bin/tape test/preparationWasmRoots.test.js test/preparedWasmCallees.test.js test/prepareWasmPreparedUpgradesOnly.test.js
```

All 61 assertions passed in the isolated checkpoint. This does not establish that the full accumulated regression suite passes. The initial direct test invocation needed the generated JRE index; generating it resolved that setup error.

Detailed measurements and rejected approaches are recorded in the cloner repository's JVM-MEMORY-VALIDATION.md on fix/jvm-measurement. Deko profiles on perf/geoblox-decoder-preparation are diagnostic-only and are not enabled by the launcher.
