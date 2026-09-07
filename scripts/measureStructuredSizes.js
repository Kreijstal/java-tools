// Compile every method of a jar with the structured SSA renderer and report
// generated source sizes, per top-level function unit.
// Usage: node scripts/measureStructuredSizes.js <jar> [--top N] [--json out] [--opts '{"structuredLoopOutlining":true}']
const fs = require("fs");
const { execFileSync } = require("child_process");
const { JVM } = require("../src/core/jvm");
const args = process.argv.slice(2);
const jar = args[0];
const topN = Number(args[args.indexOf("--top") + 1]) || 15;
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const dumpDir = args.includes("--dump") ? args[args.indexOf("--dump") + 1] : null;
if (dumpDir) fs.mkdirSync(dumpDir, {recursive: true});
const jitOpts = args.includes("--opts") ? JSON.parse(args[args.indexOf("--opts") + 1]) : {};
const names = execFileSync("unzip", ["-Z1", jar], {encoding: "utf8"}).split("\n")
  .filter((n) => n.endsWith(".class")).map((n) => n.slice(0, -6));
(async () => {
  const jvm = new JVM({classpath: [jar], jit: {warmupThreshold: 0, ...jitOpts}});
  const jit = jvm.jit;
  const rows = [];
  let failed = 0, rejected = 0;
  for (const name of names) {
    let cls;
    try { cls = await jvm.loadClassByName(name); } catch (e) { failed += 1; continue; }
    const ast = cls?.ast || jvm.classes?.[name]?.ast;
    const items = ast?.classes?.[0]?.items || [];
    for (const item of items) {
      const method = item.method;
      if (!method || !method.attributes) continue;
      let generated = null;
      try { generated = jit.structuredSsa.compile(method); } catch (e) { failed += 1; continue; }
      if (!generated) { rejected += 1; continue; }
      const source = generated.jvmStructuredSource || String(generated);
      if (dumpDir) fs.writeFileSync(dumpDir + "/" + `${name}.${method.name}${method.descriptor}`.replace(/[^\w.$()-]/g, "_") + ".js", source);
      const code = method.attributes.find((a) => a.type === "code" || a.code)?.code;
      const bytecodes = (code?.codeItems || code?.items || []).length;
      // Split into top-level function units so outlined or partitioned
      // helpers count separately from the body that calls them.
      const starts = [...source.matchAll(/^(?:async )?function\*? [\w$]+\(/gm)].map((m) => m.index);
      const units = starts.map((start, i) => (starts[i + 1] ?? source.length) - start);
      const largest = units.length ? Math.max(...units) : source.length;
      rows.push({name: `${name}.${method.name}${method.descriptor}`, bytes: source.length, largest,
        units: units.length, bytecodes, flavour: generated.jvmStructuredContinuation ? "continuation" : "framed"});
    }
  }
  rows.sort((a, b) => b.largest - a.largest);
  const total = rows.reduce((s, r) => s + r.bytes, 0);
  const over = (limit) => rows.filter((r) => r.largest > limit).length;
  console.log(`methods compiled ${rows.length}, rejected ${rejected}, failed ${failed}`);
  console.log(`total generated ${(total / 1e6).toFixed(2)} MB; median largest-unit ${rows[rows.length >> 1]?.largest} B; largest unit > 256 KB: ${over(262144)}; > 128 KB: ${over(131072)}; > 64 KB: ${over(65536)}`);
  for (const r of rows.slice(0, topN)) console.log(`  ${String(r.bytes).padStart(9)} B total ${String(r.largest).padStart(9)} B largest ${String(r.units).padStart(3)} units ${String(r.bytecodes).padStart(5)} bc  ${r.flavour.padEnd(12)} ${r.name}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows));
})().catch((e) => { console.error(e); process.exit(1); });
