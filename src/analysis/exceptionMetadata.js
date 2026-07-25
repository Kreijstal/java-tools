'use strict';

const OPCODE_EXCEPTION_MAP = new Map([
  ['new', ['java/lang/OutOfMemoryError']],
  ['anewarray', ['java/lang/OutOfMemoryError', 'java/lang/NegativeArraySizeException']],
  ['newarray', ['java/lang/OutOfMemoryError', 'java/lang/NegativeArraySizeException']],
  ['multianewarray', ['java/lang/OutOfMemoryError', 'java/lang/NegativeArraySizeException']],
  ['athrow', ['java/lang/Throwable']],
  ['checkcast', ['java/lang/ClassCastException']],
  ['instanceof', ['java/lang/NullPointerException']],
  ['getfield', ['java/lang/NullPointerException']],
  ['putfield', ['java/lang/NullPointerException']],
  ['arraylength', ['java/lang/NullPointerException']],
  ['aaload', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['baload', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['caload', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['daload', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['faload', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['iaload', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['laload', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['saload', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['aastore', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  [
    'bastore',
    ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException', 'java/lang/ArrayStoreException'],
  ],
  ['castore', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['dastore', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['fastore', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['iastore', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['lastore', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['sastore', ['java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException']],
  ['monitorenter', ['java/lang/NullPointerException']],
  ['monitorexit', ['java/lang/NullPointerException']],
  ['invokevirtual', ['java/lang/NullPointerException', 'java/lang/Throwable']],
  ['invokeinterface', ['java/lang/NullPointerException', 'java/lang/Throwable']],
  ['invokespecial', ['java/lang/NullPointerException', 'java/lang/Throwable']],
  ['invokestatic', ['java/lang/Throwable']],
  ['invokedynamic', ['java/lang/Throwable']],
  ['idiv', ['java/lang/ArithmeticException']],
  ['ldiv', ['java/lang/ArithmeticException']],
  ['irem', ['java/lang/ArithmeticException']],
  ['lrem', ['java/lang/ArithmeticException']],
]);

function getPotentialExceptionsForInstruction(instruction) {
  if (!instruction) return null;
  const opcode = typeof instruction === 'string' ? instruction : instruction.op;
  if (!opcode) return null;
  const entry = OPCODE_EXCEPTION_MAP.get(opcode);
  return entry ? entry.slice() : null;
}

function collectExceptionMetadata(astRoot) {
  if (!astRoot || !Array.isArray(astRoot.classes)) {
    return [];
  }
  const rows = [];
  for (const classItem of astRoot.classes) {
    const className = classItem.className || 'UnknownClass';
    const members = classItem.items || [];
    for (const member of members) {
      if (!member || member.type !== 'method' || !member.method) {
        continue;
      }
      const method = member.method;
      const declared = extractDeclaredExceptions(method);
      const implicit = extractImplicitExceptions(method);
      rows.push({
        className,
        methodName: method.name,
        descriptor: method.descriptor,
        declared,
        implicit,
      });
    }
  }
  return rows;
}

function extractDeclaredExceptions(method) {
  const attr = (method.attributes || []).find((entry) => entry && entry.type === 'exceptions');
  if (!attr || !Array.isArray(attr.exceptions)) {
    return [];
  }
  return [...attr.exceptions].sort();
}

function extractImplicitExceptions(method) {
  const codeAttr = (method.attributes || []).find((entry) => entry && entry.type === 'code');
  if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) {
    return [];
  }
  const set = new Set();
  for (const item of codeAttr.code.codeItems) {
    if (!item || !item.instruction) continue;
    const potential = getPotentialExceptionsForInstruction(item.instruction);
    if (!potential) continue;
    potential.forEach((exceptionName) => set.add(exceptionName));
  }
  return Array.from(set).sort();
}

module.exports = { getPotentialExceptionsForInstruction, collectExceptionMetadata };
