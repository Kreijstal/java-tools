'use strict';

const LEFT_OPS = {
  if_icmpgt: 'if_icmplt',
  if_icmpge: 'if_icmple',
  if_icmplt: 'if_icmpgt',
  if_icmple: 'if_icmpge',
  if_icmpeq: 'if_icmpeq',
  if_icmpne: 'if_icmpne',
};

const RIGHT_OPS = {
  if_icmpgt: 'if_icmpgt',
  if_icmpge: 'if_icmpge',
  if_icmplt: 'if_icmplt',
  if_icmple: 'if_icmple',
  if_icmpeq: 'if_icmpeq',
  if_icmpne: 'if_icmpne',
};

function runSimplifyNotCompare(astRoot, options = {}) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const codeItems = attr && attr.type === 'code' && attr.code && attr.code.codeItems;
        if (!Array.isArray(codeItems)) continue;
        const allowedLocals = options.charLocalsOnly ? collectCharLocals(codeItems, item.method) : null;
        rewrites += simplifyCodeItems(codeItems, collectUsedLabels(codeItems, attr.code.exceptionTable), allowedLocals);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function simplifyCodeItems(codeItems, usedLabels = collectUsedLabels(codeItems), allowedLocals = null) {
  let rewrites = 0;
  for (let i = 0; i <= codeItems.length - 5; i += 1) {
    const left = matchLeftNotCompare(codeItems, i, usedLabels, allowedLocals);
    if (left) {
      codeItems.splice(i, 5, ...left);
      rewrites += 1;
      i -= 1;
      continue;
    }
    const right = matchRightNotCompare(codeItems, i, usedLabels, allowedLocals);
    if (right) {
      codeItems.splice(i, 5, ...right);
      rewrites += 1;
      i -= 1;
    }
  }
  return rewrites;
}

function matchLeftNotCompare(codeItems, i, usedLabels, allowedLocals) {
  const value = codeItems[i];
  const bound = pushValue(codeItems[i + 3]);
  const branch = codeItems[i + 4];
  const branchOp = op(branch);
  if (!isAllowedIntValue(value, allowedLocals) || op(codeItems[i + 1]) !== 'iconst_m1' || op(codeItems[i + 2]) !== 'ixor') return null;
  if (bound == null || !LEFT_OPS[branchOp] || !plainRemovedItems(codeItems, i + 1, i + 2, usedLabels)) return null;
  return [
    normalizeValue(value),
    itemWithInstruction(codeItems[i + 3], pushInstruction(~bound)),
    itemWithInstruction(branch, { op: LEFT_OPS[branchOp], arg: arg(branch) }),
  ];
}

function matchRightNotCompare(codeItems, i, usedLabels, allowedLocals) {
  const bound = pushValue(codeItems[i]);
  const value = codeItems[i + 1];
  const branch = codeItems[i + 4];
  const branchOp = op(branch);
  if (bound == null || !isAllowedIntValue(value, allowedLocals) || op(codeItems[i + 2]) !== 'iconst_m1' || op(codeItems[i + 3]) !== 'ixor') return null;
  if (!RIGHT_OPS[branchOp] || !plainRemovedItems(codeItems, i + 2, i + 3, usedLabels)) return null;
  return [
    normalizeValue(value, codeItems[i]),
    { instruction: pushInstruction(~bound) },
    itemWithInstruction(branch, { op: RIGHT_OPS[branchOp], arg: arg(branch) }),
  ];
}

function plainRemovedItems(codeItems, start, end, usedLabels) {
  for (let i = start; i <= end; i += 1) {
    const item = codeItems[i];
    if (!item) return false;
    if (item.labelDef && usedLabels.has(trimLabel(item.labelDef))) return false;
    if (item.stackMapFrame || item.lineNumber) return false;
  }
  return true;
}

function normalizeValue(item, labelSource = item) {
  const out = {};
  if (labelSource && labelSource.labelDef) out.labelDef = labelSource.labelDef;
  out.instruction = isIntLoad(item) ? { op: 'iload', arg: localIndex(item) } : cloneInstruction(item.instruction);
  return out;
}

function itemWithInstruction(labelSource, instruction) {
  const out = {};
  if (labelSource && labelSource.labelDef) out.labelDef = labelSource.labelDef;
  out.instruction = instruction;
  return out;
}

function isAllowedIntValue(item, allowedLocals) {
  if (isCharProducer(item)) return true;
  return isIntLoad(item) && (!allowedLocals || allowedLocals.has(localIndex(item)));
}

function isCharProducer(item) {
  const itemOp = op(item);
  const itemArg = arg(item);
  if (itemOp === 'caload') return true;
  if ((itemOp === 'getstatic' || itemOp === 'getfield') && fieldDescriptor(itemArg) === 'C') return true;
  if ((itemOp === 'invokevirtual' || itemOp === 'invokeinterface' || itemOp === 'invokestatic') && methodReturnsChar(itemArg)) return true;
  return false;
}

function cloneInstruction(instruction) {
  if (!instruction || typeof instruction === 'string') return instruction;
  return { ...instruction };
}

function isIntLoad(item) {
  return op(item) === 'iload' || /^iload_[0-3]$/.test(op(item) || '');
}

function localIndex(item) {
  const itemOp = op(item);
  if (itemOp === 'iload') return String(arg(item));
  return itemOp.slice(-1);
}

function pushValue(item) {
  const itemOp = op(item);
  if (itemOp === 'iconst_m1') return -1;
  if (/^iconst_[0-5]$/.test(itemOp || '')) return Number(itemOp.slice(-1));
  if (itemOp === 'bipush' || itemOp === 'sipush') return Number(arg(item));
  return null;
}

function pushInstruction(value) {
  if (value === -1) return 'iconst_m1';
  if (value >= 0 && value <= 5) return `iconst_${value}`;
  if (value >= -128 && value <= 127) return { op: 'bipush', arg: String(value) };
  return { op: 'sipush', arg: String(value) };
}

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

function arg(item) {
  const insn = item && item.instruction;
  return insn && typeof insn === 'object' ? insn.arg : null;
}

function collectUsedLabels(codeItems = [], exceptionTable = []) {
  const used = new Set();
  for (const item of codeItems || []) {
    const itemArg = arg(item);
    if (typeof itemArg === 'string' && /^L/.test(itemArg)) used.add(trimLabel(itemArg));
  }
  for (const entry of exceptionTable || []) {
    for (const value of [
      entry.startLbl, entry.startLabel, entry.start, entry.from,
      entry.endLbl, entry.endLabel, entry.end, entry.to,
      entry.handlerLbl, entry.handlerLabel, entry.handler, entry.usingLbl,
    ]) {
      if (value) used.add(trimLabel(value));
    }
  }
  return used;
}

function collectCharLocals(codeItems, method = null) {
  const locals = new Set();
  for (const local of charParameterLocals(method)) locals.add(local);
  for (let i = 0; i < codeItems.length - 1; i += 1) {
    const item = codeItems[i];
    const next = codeItems[i + 1];
    const itemOp = op(item);
    if ((itemOp === 'invokevirtual' || itemOp === 'invokeinterface' || itemOp === 'invokestatic') && methodReturnsChar(arg(item)) && isIntStore(next)) {
      locals.add(storeLocalIndex(next));
    }
    if (itemOp === 'caload' && isIntStore(next)) {
      locals.add(storeLocalIndex(next));
    }
  }
  return locals;
}

function charParameterLocals(method) {
  const out = [];
  if (!method || typeof method.descriptor !== 'string') return out;
  let local = method.flags && method.flags.includes('static') ? 0 : 1;
  const params = parseParameterDescriptors(method.descriptor);
  for (const desc of params) {
    if (desc === 'C') out.push(String(local));
    local += (desc === 'J' || desc === 'D') ? 2 : 1;
  }
  return out;
}

function parseParameterDescriptors(descriptor) {
  const close = descriptor.indexOf(')');
  if (!descriptor.startsWith('(') || close < 0) return [];
  const params = [];
  for (let i = 1; i < close;) {
    let start = i;
    while (descriptor[i] === '[') i += 1;
    if (descriptor[i] === 'L') {
      const semi = descriptor.indexOf(';', i);
      if (semi < 0 || semi > close) return params;
      params.push(descriptor.slice(start, semi + 1));
      i = semi + 1;
    } else {
      params.push(descriptor.slice(start, i + 1));
      i += 1;
    }
  }
  return params;
}

function methodReturnsChar(itemArg) {
  return Array.isArray(itemArg) &&
    (itemArg[0] === 'Method' || itemArg[0] === 'InterfaceMethod') &&
    Array.isArray(itemArg[2]) &&
    typeof itemArg[2][1] === 'string' &&
    itemArg[2][1].endsWith(')C');
}

function fieldDescriptor(itemArg) {
  return Array.isArray(itemArg) &&
    itemArg[0] === 'Field' &&
    Array.isArray(itemArg[2])
    ? itemArg[2][1]
    : null;
}

function isIntStore(item) {
  return op(item) === 'istore' || /^istore_[0-3]$/.test(op(item) || '');
}

function storeLocalIndex(item) {
  const itemOp = op(item);
  if (itemOp === 'istore') return String(arg(item));
  return itemOp.slice(-1);
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : label;
}

module.exports = { runSimplifyNotCompare, simplifyCodeItems, collectCharLocals };
