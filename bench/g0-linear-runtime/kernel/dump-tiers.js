const fs = require("fs");
const { JVM } = require("/home/kreijstal/git/java-tools/src/core/jvm");
(async () => {
  const jar = "/home/kreijstal/git/dekobloko-work/dekobloko.jar";
  const jvm = new JVM({classpath: [jar], jit: {warmupThreshold: 0}});
  const jit = jvm.jit;
  const target = process.argv[2];
  const outPrefix = process.argv[3];
  const cn = target.slice(0, target.indexOf(".")), rest = target.slice(target.indexOf(".") + 1);
  const mname = rest.slice(0, rest.indexOf("(")), desc = rest.slice(rest.indexOf("("));
  const cls = await jvm.loadClassByName(cn);
  const ast = cls?.ast || jvm.classes?.[cn]?.ast;
  const item = ast.classes[0].items.find((i) => i.method && i.method.name === mname && i.method.descriptor === desc);
  const generated = jit.structuredSsa.compile(item.method);
  const seen = new Set();
  const visit = (name, v, depth) => {
    if (depth > 2 || v === null || (typeof v !== "function" && typeof v !== "object") || seen.has(v)) return;
    seen.add(v);
    if (typeof v === "function") {
      const src = v.jvmGeneratedSource || v.jvmStructuredSource;
      console.log(`${name}: function ${v.name} params=${v.length} src=${src ? src.length : 0}`);
      if (src) fs.writeFileSync(`${outPrefix}.${name.replace(/[^\w]/g, "_")}.js`, src);
      fs.writeFileSync(`${outPrefix}.${name.replace(/[^\w]/g, "_")}.full.js`, String(v));
    }
    for (const k of Object.keys(v)) {
      if (/[Bb]ody|[Ss]ource|positional|Positional|entry|Entry|restoring/.test(k) || typeof v[k] === "function") visit(`${name}.${k}`, v[k], depth + 1);
    }
  };
  visit("generated", generated, 0);
  console.log("top keys:", Object.keys(generated).join(", "));
})().catch((e) => { console.error(e); process.exit(1); });
