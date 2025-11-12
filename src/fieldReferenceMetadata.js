'use strict';

const FIELD_OPS = new Set(['getstatic', 'putstatic', 'getfield', 'putfield']);

function makeFieldKey(className, fieldName, descriptor) {
  return `${className}#${fieldName}:${descriptor}`;
}

function extractFieldRef(instruction) {
  if (!instruction || typeof instruction !== 'object') {
    return null;
  }
  if (!FIELD_OPS.has(instruction.op)) {
    return null;
  }
  const arg = instruction.arg;
  if (!Array.isArray(arg) || arg.length < 3) {
    return null;
  }
  const owner = arg[1];
  const nameDesc = arg[2];
  if (!Array.isArray(nameDesc) || nameDesc.length < 2) {
    return null;
  }
  return {
    className: owner,
    fieldName: nameDesc[0],
    descriptor: nameDesc[1],
    op: instruction.op,
  };
}

function collectFieldReferences(astRoot) {
  if (!astRoot || !Array.isArray(astRoot.classes)) {
    return [];
  }
  const fieldMap = new Map();
  const result = [];

  for (const classItem of astRoot.classes) {
    const className = classItem.className || 'UnknownClass';
    for (const item of classItem.items || []) {
      if (!item) continue;
      if (item.type === 'field' && item.field) {
        const { name, descriptor, flags } = item.field;
        const entry = {
          className,
          fieldName: name,
          descriptor,
          flags: flags || [],
          references: [],
        };
        result.push(entry);
        fieldMap.set(makeFieldKey(className, name, descriptor), entry);
        item.field.references = entry.references;
      }
    }
  }

  for (const classItem of astRoot.classes) {
    const className = classItem.className || 'UnknownClass';
    for (const member of classItem.items || []) {
      if (!member || member.type !== 'method' || !member.method) continue;
      const method = member.method;
      const codeAttr = (method.attributes || []).find((attr) => attr && attr.type === 'code');
      if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) continue;
      for (const item of codeAttr.code.codeItems) {
        if (!item || !item.instruction) continue;
        const ref = extractFieldRef(item.instruction);
        if (!ref) continue;
        const key = makeFieldKey(ref.className, ref.fieldName, ref.descriptor);
        const entry = fieldMap.get(key);
        if (!entry) continue;
        entry.references.push({
          className,
          methodName: method.name,
          descriptor: method.descriptor,
          op: ref.op,
        });
      }
    }
  }

  return result;
}

module.exports = { collectFieldReferences };
