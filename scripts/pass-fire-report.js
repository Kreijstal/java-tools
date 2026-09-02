const path = require("path");
const renderer = require(path.join(__dirname, "..", "src/jit/JvmSsaBlockRenderer.js"));
process.on("exit", () => {
  console.error("\npass fires:");
  for (const [name, count] of renderer._test.reportPassFires()) {
    console.error(`${String(count).padStart(8)}  ${name}`);
  }
});
for (const file of process.argv.slice(2)) require(path.resolve(file));
