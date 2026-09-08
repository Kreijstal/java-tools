// Opt-in audit of the statement IR.
//
// A test oracle, never a compilation step: it re-checks a finished body and
// nothing the compiler emits depends on what it finds. It is separate from the
// emitters for that reason -- and separate from the generated-source verifier
// because it checks the compiler's own records against the text, not the
// scoping of the text alone.
const { parse: parseJavaScript } = require("acorn");
const { walkJavaScriptAst } = require("./generatedSourceVerifier");
const { partsReferences } = require("./statementParts");

// Opt-in audit of the statement IR (JVM_JIT_VERIFY_STATEMENT_IR=1). Like the
// generated-scope verifier it only re-checks a finished body: it scans the
// rendered text for names the compile minted and reports any line the emitters
// did not record, or whose record disagrees with the operands actually
// present. Nothing in the compiler decides what to emit from this scan; the
// passes read the records, never the characters.
const statementIrAuditIssues = new Map();
function auditStatementIrLines(lines, records, names, label) {
  const note = (issue, line) => {
    const key = `${issue}: ${line}`;
    statementIrAuditIssues.set(key,
      (statementIrAuditIssues.get(key) || 0) + 1);
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const record = records.get(trimmed);
    if (!record) { note(`${label} unrecorded`, trimmed); continue; }
    if (record.foreign) continue;
    const present = [];
    for (const match of trimmed.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (names.has(match[0])) present.push(match[0]);
    }
    const declared = partsReferences(record.parts).sort();
    present.sort();
    if (declared.length !== present.length ||
        declared.some((name, index) => present[index] !== name)) {
      note(`${label} operand mismatch [${declared.join(",")}] vs [` +
        `${present.join(",")}]`, trimmed);
    }
  }
  auditStatementIrControlFlow(lines, records, label, note);
}

// The second half of the audit: the control flow every statement *declared*,
// cross-checked against what an acorn parse of the finished body actually
// finds there. `returnStmt` states an exit, `jumpStmt` states a break or a
// continue, a label emitter states the label it wrote and the emitters that
// write `yield` say so; nothing in the compiler recovers any of it from the
// text, so this is the check that an emitter which grows a new exit, jump,
// label or yield form is noticed instead of silently escaping the routing.
//
// Like the operand check it is a test oracle: opt-in, never a compilation
// step, and nothing the compiler emits depends on it.
function auditStatementIrControlFlow(lines, records, label, note) {
  // A body a caller inserts breaks out of a label the *caller* declares, so
  // the parser needs those labels wrapped around it. Which labels those are
  // is read off the records; a record that names the wrong one shows up as a
  // parse failure.
  const declared = new Set();
  const targets = new Set();
  for (const line of lines) {
    const record = records.get(line.trim());
    if (!record || record.foreign) continue;
    if (record.declaresLabel && record.label) declared.add(record.label);
    if (record.jump && record.jump.label) targets.add(record.jump.label);
  }
  const wrappers = [...targets].filter((name) => !declared.has(name));
  const body = lines.join("\n");
  const source = wrappers.length
    ? `${wrappers.map((name) => `${name}: {`).join("\n")}\n${body}\n${
      wrappers.map(() => "}").join("\n")}`
    : body;
  const offset = wrappers.length;
  let program = null;
  try {
    program = parseJavaScript(`function* __jvmSsaAuditWrapper() {\n${
      source}\n}`, {ecmaVersion: "latest", locations: true});
  } catch (error) {
    note(`${label} audit parse failed`, String(error.message));
    return;
  }
  // Line 1 is the wrapper, then the label wrappers, then `lines[0]`.
  const found = lines.map(() => ({
    exit: 0, jump: null, jumps: 0, label: null, labels: 0, yields: 0,
  }));
  const at = (node) => {
    const index = node.loc.start.line - 2 - offset;
    return index >= 0 && index < found.length ? found[index] : null;
  };
  walkJavaScriptAst(program, (node) => {
    const seen = at(node);
    if (!seen) return;
    if (node.type === "ReturnStatement") seen.exit += 1;
    else if (node.type === "YieldExpression") seen.yields += 1;
    else if (node.type === "BreakStatement" ||
        node.type === "ContinueStatement") {
      seen.jumps += 1;
      seen.jump = {
        kind: node.type === "BreakStatement" ? "break" : "continue",
        label: node.label ? node.label.name : null,
      };
    } else if (node.type === "LabeledStatement") {
      seen.labels += 1;
      seen.label = node.label.name;
    }
  });
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "") continue;
    const record = records.get(trimmed);
    if (!record || record.foreign) continue;
    const seen = found[index];
    const declaredExit = record.exit ? 1 : 0;
    if (seen.exit !== declaredExit) {
      note(`${label} exit declared ${declaredExit} found ${seen.exit}`,
        trimmed);
    }
    const declaredYields = record.yields ? 1 : 0;
    if ((seen.yields > 0 ? 1 : 0) !== declaredYields) {
      note(`${label} yield declared ${declaredYields} found ${seen.yields}`,
        trimmed);
    }
    const declaredJumps = record.jump ? 1 : 0;
    if (seen.jumps !== declaredJumps) {
      note(`${label} jump declared ${declaredJumps} found ${seen.jumps}`,
        trimmed);
    } else if (record.jump && (record.jump.kind !== seen.jump.kind ||
        (record.jump.label || null) !== seen.jump.label)) {
      note(`${label} jump ${record.jump.kind} ${record.jump.label} vs ` +
        `${seen.jump.kind} ${seen.jump.label}`, trimmed);
    }
    const declaresLabel = record.declaresLabel && record.label ? 1 : 0;
    if (seen.labels !== declaresLabel) {
      note(`${label} label declared ${declaresLabel} found ${seen.labels}`,
        trimmed);
    } else if (declaresLabel && record.label !== seen.label) {
      note(`${label} label ${record.label} vs ${seen.label}`, trimmed);
    }
  }
}

function reportStatementIrAudit() {
  return [...statementIrAuditIssues.entries()]
    .sort((left, right) => right[1] - left[1]);
}

module.exports = {
  auditStatementIrLines,
  auditStatementIrControlFlow,
  reportStatementIrAudit,
};
