"use strict";

// Generated code keeps the raw element storage of a Java array in a scalar
// local (see JitCompiler.arrayData).  Emit that lookup inline: a
// non-inlined helper call costs a real call plus a megamorphic property
// probe on every region entry, which dominates tiny leaf kernels such as
// one-pixel sprite blits.  Only pure operands (identifiers or constant
// index expressions) are expanded, because the operand is evaluated more
// than once; anything else keeps the helper call.
const PURE_OPERAND = /^[A-Za-z_$][\w$]*(?:\[\d+\])?$/;

function arrayDataExpression(operand) {
  const text = String(operand).trim();
  if (!PURE_OPERAND.test(text)) return `helpers.arrayData(${text})`;
  return `(${text} === null || ${text} === undefined ? null : ` +
    `${text}.elements ? ${text}.elements : ` +
    `(Array.isArray(${text}) || ArrayBuffer.isView(${text}) ? ${text} : null))`;
}

const ENTRY_ARRAY_DATA_LINE = /^(\s*)const (ssaEntryArrayData\d+) = (.+);$/;

// Recognizes a rendered positional entry-array line
// (`const ssaEntryArrayDataN = <arrayData(argumentM)>;`) in either the helper
// form or the inline form emitted by arrayDataExpression, so lexical inlining
// can feed the caller's already-extracted operand instead of re-extracting.
function matchEntryArrayDataLine(line) {
  const match = ENTRY_ARRAY_DATA_LINE.exec(line);
  if (!match) return null;
  const expression = match[3];
  let operand = null;
  const helperForm = /^helpers\.arrayData\((argument\d+)\)$/.exec(expression);
  if (helperForm) {
    operand = helperForm[1];
  } else {
    const head = /^\((argument\d+) === null/.exec(expression);
    if (head && expression === arrayDataExpression(head[1])) operand = head[1];
  }
  if (!operand) return null;
  return {
    indent: match[1],
    variable: match[2],
    argument: Number(operand.slice("argument".length)),
  };
}

module.exports = { arrayDataExpression, matchEntryArrayDataLine };
