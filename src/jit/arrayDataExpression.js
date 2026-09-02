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

module.exports = { arrayDataExpression };
