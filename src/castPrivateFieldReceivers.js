'use strict';

function runCastPrivateFieldReceivers(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    const className = cls.className;
    const privateFields = collectPrivateFields(cls);
    if (!className || privateFields.size === 0) continue;
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        code.methodFlags = item.method.flags || [];
        rewrites += rewriteCode(code, className, privateFields);
        delete code.methodFlags;
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function rewriteCode(code, className, privateFields) {
  const items = code.codeItems;
  if (!code.methodFlags || !code.methodFlags.includes('static')) return 0;
  const insertions = [];
  for (let i = 0; i < items.length; i += 1) {
    const itemOp = op(items[i]);
    if (itemOp !== 'getfield' && itemOp !== 'putfield') continue;
    const ref = arg(items[i]);
    if (!isPrivateFieldRef(ref, className, privateFields)) continue;
    const receiverIndex = itemOp === 'getfield'
      ? previousInstructionIndex(items, i)
      : putfieldReceiverIndex(items, i, ref[2][1]);
    const receiverLocal = aloadLocal(items[receiverIndex]);
    if (receiverIndex < 0 || receiverLocal == null || receiverLocal === '0') continue;
    if (op(items[nextInstructionIndex(items, receiverIndex)]) === 'checkcast') continue;
    insertions.push(receiverIndex + 1);
  }
  for (const index of [...new Set(insertions)].sort((a, b) => b - a)) {
    items.splice(index, 0, { instruction: { op: 'checkcast', arg: className } });
  }
  return new Set(insertions).size;
}

function collectPrivateFields(cls) {
  const out = new Set();
  for (const item of cls.items || []) {
    if (!item || item.type !== 'field' || !item.field) continue;
    if (!Array.isArray(item.field.flags) || !item.field.flags.includes('private')) continue;
    out.add(`${item.field.name}:${item.field.descriptor}`);
  }
  return out;
}

function isPrivateFieldRef(ref, className, privateFields) {
  return Array.isArray(ref) && ref[1] === className && Array.isArray(ref[2]) &&
    privateFields.has(`${ref[2][0]}:${ref[2][1]}`);
}

function putfieldReceiverIndex(items, putfieldIndex, valueDesc) {
  const needed = 1 + categorySize(valueDesc);
  for (let start = Math.max(0, putfieldIndex - 24); start < putfieldIndex; start += 1) {
    if (aloadLocal(items[start]) == null) continue;
    let depth = 0;
    let ok = true;
    for (let i = start; i < putfieldIndex; i += 1) {
      const effect = stackEffect(items[i]);
      if (!effect) {
        ok = false;
        break;
      }
      if (depth < effect.pop) {
        ok = false;
        break;
      }
      depth += effect.push - effect.pop;
    }
    if (ok && depth === needed) return start;
  }
  return -1;
}

function stackEffect(item) {
  const itemOp = op(item);
  if (!itemOp) return null;
  if (/^(?:a|i|f)load(?:_[0-3])?$/.test(itemOp)) return { pop: 0, push: 1 };
  if (/^(?:l|d)load(?:_[0-3])?$/.test(itemOp)) return { pop: 0, push: 2 };
  if (/^(?:aconst_null|iconst_m1|iconst_[0-5]|fconst_[0-2])$/.test(itemOp)) return { pop: 0, push: 1 };
  if (/^(?:lconst_[0-1]|dconst_[0-1])$/.test(itemOp)) return { pop: 0, push: 2 };
  if (itemOp === 'bipush' || itemOp === 'sipush' || itemOp === 'ldc' || itemOp === 'newarray' ||
      itemOp === 'anewarray' || itemOp === 'new' || itemOp === 'getstatic') return { pop: 0, push: 1 };
  if (itemOp === 'dup') return { pop: 1, push: 2 };
  if (itemOp === 'iadd' || itemOp === 'isub' || itemOp === 'imul' || itemOp === 'idiv' ||
      itemOp === 'iand' || itemOp === 'ior' || itemOp === 'ixor') return { pop: 2, push: 1 };
  if (itemOp === 'ineg') return { pop: 1, push: 1 };
  if (itemOp === 'getfield') {
    const ref = arg(item);
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    return { pop: 1, push: categorySize(desc) };
  }
  return null;
}

function categorySize(desc) {
  return desc === 'J' || desc === 'D' ? 2 : 1;
}

function previousInstructionIndex(items, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
}

function nextInstructionIndex(items, index) {
  for (let i = index + 1; i < items.length; i += 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
}

function aloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'aload') return String(arg(item));
  if (/^aload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
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
  runCastPrivateFieldReceivers,
  rewriteCode,
};
