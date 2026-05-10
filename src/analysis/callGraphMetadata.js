'use strict';

const INVOKE_OPS = new Set([
  'invokevirtual',
  'invokespecial',
  'invokestatic',
  'invokeinterface',
]);

function makeMethodKey(className, methodName, descriptor) {
  return `${className}#${methodName}${descriptor}`;
}

function extractCallee(instruction) {
  if (!instruction || typeof instruction !== 'object') return null;
  if (!INVOKE_OPS.has(instruction.op)) {
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
  const methodName = nameDesc[0];
  const descriptor = nameDesc[1];
  if (!owner || !methodName || !descriptor) {
    return null;
  }
  return { className: owner, methodName, descriptor };
}

function collectMethodCallers(astRoot) {
  if (!astRoot || !Array.isArray(astRoot.classes)) {
    return [];
  }
  const entries = [];
  const methodMap = new Map();

  for (const classItem of astRoot.classes) {
    const className = classItem.className || 'UnknownClass';
    for (const member of classItem.items || []) {
      if (!member || member.type !== 'method' || !member.method) continue;
      const method = member.method;
      const entry = {
        className,
        methodName: method.name,
        descriptor: method.descriptor,
        callers: [],
      };
      entries.push(entry);
      methodMap.set(makeMethodKey(className, method.name, method.descriptor), entry);
      method.callers = entry.callers;
    }
  }

  const seen = new Map();
  for (const classItem of astRoot.classes) {
    const className = classItem.className || 'UnknownClass';
    for (const member of classItem.items || []) {
      if (!member || member.type !== 'method' || !member.method) continue;
      const method = member.method;
      const callerInfo = {
        className,
        methodName: method.name,
        descriptor: method.descriptor,
      };
      const codeAttr = (method.attributes || []).find((attr) => attr && attr.type === 'code');
      if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) continue;
      for (const item of codeAttr.code.codeItems) {
        if (!item || !item.instruction) continue;
        const callee = extractCallee(item.instruction);
        if (!callee) continue;
        const calleeKey = makeMethodKey(callee.className, callee.methodName, callee.descriptor);
        const calleeEntry = methodMap.get(calleeKey);
        if (!calleeEntry) continue;
        const dedupeKey = `${calleeKey}<-${makeMethodKey(
          callerInfo.className,
          callerInfo.methodName,
          callerInfo.descriptor,
        )}`;
        if (seen.has(dedupeKey)) continue;
        seen.set(dedupeKey, true);
        calleeEntry.callers.push(callerInfo);
      }
    }
  }

  return entries;
}

module.exports = { collectMethodCallers };
