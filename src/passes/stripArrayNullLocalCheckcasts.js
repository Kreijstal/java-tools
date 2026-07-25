'use strict';

function runStripArrayNullLocalCheckcasts(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += rewriteCode(code);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function rewriteCode(code) {
  const items = code.codeItems;
  let rewrites = 0;
  for (let i = 0; i + 2 < items.length; i += 1) {
    if (op(items[i]) !== 'aconst_null' || op(items[i + 1]) !== 'checkcast') continue;
    const desc = descriptorFromClassName(arg(items[i + 1]));
    if (!desc || !desc.startsWith('[')) continue;
    const local = astoreLocal(items[i + 2]);
    if (local == null) continue;
    if (!hasLaterConcreteArrayStore(items, i + 3, local, desc)) continue;
    removeInstructionOnly(items, i + 1);
    rewrites += 1;
  }
  return rewrites;
}

function hasLaterConcreteArrayStore(items, start, local, expectedDesc) {
  for (let i = start; i < items.length; i += 1) {
    if (astoreLocal(items[i]) !== local) continue;
    const producer = previousInstructionIndex(items, i - 1);
    const actualDesc = arrayProducerDescriptor(items[producer]);
    if (arrayDescriptorCompatible(actualDesc, expectedDesc)) return true;
  }
  return false;
}

function arrayProducerDescriptor(item) {
  const itemOp = op(item);
  if (itemOp === 'newarray') return primitiveArrayDescriptor(arg(item));
  if (itemOp === 'anewarray') return objectArrayDescriptor(arg(item));
  if (itemOp === 'multianewarray') {
    const itemArg = arg(item);
    if (Array.isArray(itemArg)) return itemArg[0];
    return typeof itemArg === 'string' ? itemArg : null;
  }
  if (itemOp === 'checkcast') return descriptorFromClassName(arg(item));
  return null;
}

function primitiveArrayDescriptor(kind) {
  const key = String(kind);
  const map = {
    boolean: '[Z',
    byte: '[B',
    char: '[C',
    short: '[S',
    int: '[I',
    long: '[J',
    float: '[F',
    double: '[D',
  };
  return map[key] || null;
}

function objectArrayDescriptor(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('[')) return `[${value}`;
  return `[L${value};`;
}

function descriptorFromClassName(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('[')) return value;
  return `L${value};`;
}

function arrayDescriptorCompatible(actual, expected) {
  if (!actual || !expected) return false;
  return actual === expected;
}

function previousInstructionIndex(items, start) {
  for (let i = start; i >= 0; i -= 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
}

function removeInstructionOnly(items, index) {
  const item = items[index];
  if (!item) return;
  if (item.labelDef || item.stackMapFrame || item.lineNumber) {
    delete item.instruction;
    delete item.pc;
  } else {
    items.splice(index, 1);
  }
}

function astoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'astore') return String(arg(item));
  const match = /^astore_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

function arg(item) {
  const insn = item && item.instruction;
  return insn && typeof insn === 'object' ? insn.arg : null;
}

module.exports = {
  runStripArrayNullLocalCheckcasts,
  rewriteCode,
};
