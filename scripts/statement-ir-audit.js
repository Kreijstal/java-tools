// Developer helper: run a test file with JVM_JIT_VERIFY_STATEMENT_IR=1 and
// print the statement-IR audit report collected by the renderer.
process.env.JVM_JIT_VERIFY_STATEMENT_IR = "1";
const path = require("path");
// The audit collects into its own module, so this reads the report from its
// owner rather than reaching through the renderer's test surface. Requiring the
// renderer here is unnecessary: the test files loaded below pull it in, and
// both they and this script share the one cached audit module.
const { reportStatementIrAudit } =
  require(path.join(__dirname, "..", "src/jit/statementIrAudit.js"));
process.on("exit", () => {
  const issues = reportStatementIrAudit();
  const total = issues.reduce((sum, [, count]) => sum + count, 0);
  console.error(`\nstatement-ir audit: ${total} occurrences, ${issues.length} distinct`);
  for (const [issue, count] of issues.slice(0, Number(process.env.AUDIT_LIMIT || 60))) {
    console.error(`${String(count).padStart(6)}  ${issue}`);
  }
});
for (const file of process.argv.slice(2)) require(path.resolve(file));
