// Developer helper: run a test file with JVM_JIT_VERIFY_STATEMENT_IR=1 and
// print the statement-IR audit report collected by the renderer.
process.env.JVM_JIT_VERIFY_STATEMENT_IR = "1";
const path = require("path");
const renderer = require(path.join(__dirname, "..", "src/jit/JvmSsaBlockRenderer.js"));
process.on("exit", () => {
  const issues = renderer._test.reportStatementIrAudit();
  const total = issues.reduce((sum, [, count]) => sum + count, 0);
  console.error(`\nstatement-ir audit: ${total} occurrences, ${issues.length} distinct`);
  for (const [issue, count] of issues.slice(0, Number(process.env.AUDIT_LIMIT || 60))) {
    console.error(`${String(count).padStart(6)}  ${issue}`);
  }
});
for (const file of process.argv.slice(2)) require(path.resolve(file));
