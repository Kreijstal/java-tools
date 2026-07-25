'use strict';

function runCastInvokeReceiversToOwners(astRoot, options = {}) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += castCode(code, options);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function castCode(code, options = {}) {
  const items = code.codeItems;
  const insertions = [];
  const stack = [];
  const maxCasts = options.maxCasts || 128;

  for (let i = 0; i < items.length; i += 1) {
    if (!items[i] || !items[i].instruction) continue;
    const itemOp = op(items[i]);
    if (itemOp === 'invokeinterface' || (options.includeVirtual && itemOp === 'invokevirtual')) {
      const insertion = receiverCastInsertion(items, i, stack, itemOp);
      if (insertion) insertions.push(insertion);
    }
    if (!applyStackEffect(stack, items[i], i)) stack.length = 0;
  }

  const unique = dedupeInsertions(insertions);
  if (unique.length === 0 || unique.length > maxCasts) return 0;
  for (const insertion of unique.sort((a, b) => b.index - a.index)) {
    items.splice(insertion.index, 0, { instruction: { op: 'checkcast', arg: insertion.owner } });
  }
  return unique.length;
}

function receiverCastInsertion(items, invokeIndex, stack, itemOp) {
  if (itemOp === 'invokestatic') return null;
  const ref = arg(items[invokeIndex]);
  const owner = Array.isArray(ref) && typeof ref[1] === 'string' ? ref[1] : null;
  const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  if (!isConcreteCastOwner(owner)) return null;
  const params = parameterDescriptors(desc);
  if (!params) return null;
  const receiverStackIndex = stack.length - params.length - 1;
  const receiver = receiverStackIndex >= 0 && stack[receiverStackIndex] && stack[receiverStackIndex].kind === 'local'
    ? stack[receiverStackIndex]
    : findReceiverLoadBackward(items, invokeIndex, params.length);
  if (!receiver || receiver.kind !== 'local') return null;
  const afterProducer = nextInstructionIndex(items, receiver.index);
  if (afterProducer < 0 || afterProducer > invokeIndex) return null;
  if (op(items[afterProducer]) === 'checkcast' && arg(items[afterProducer]) === owner) return null;
  return { index: afterProducer, owner };
}

function findReceiverLoadBackward(items, invokeIndex, argCount) {
  let remainingArgs = argCount;
  for (let i = previousInstructionIndex(items, invokeIndex); i >= 0; i = previousInstructionIndex(items, i)) {
    if (items[i] && items[i].labelDef) return null;
    if (remainingArgs > 0) {
      if (!isSimpleOneSlotProducer(items[i])) return null;
      remainingArgs -= 1;
      continue;
    }
    const local = aloadLocal(items[i]);
    return local == null ? null : { kind: 'local', index: i, local };
  }
  return null;
}

function isSimpleOneSlotProducer(item) {
  const itemOp = op(item);
  return aloadLocal(item) != null ||
    /^(?:i|f)load(?:_[0-3])?$/.test(itemOp || '') ||
    /^(?:aconst_null|iconst_m1|iconst_[0-5]|fconst_[0-2]|bipush|sipush|ldc)$/.test(itemOp || '') ||
    itemOp === 'getstatic';
}

function applyStackEffect(stack, item, index) {
  const itemOp = op(item);
  const push = (value) => {
    stack.push(value);
    return true;
  };
  const pop = (count) => {
    for (let i = 0; i < count; i += 1) {
      if (!stack.length) return false;
      stack.pop();
    }
    return true;
  };

  if (aloadLocal(item) != null) return push({ kind: 'local', index, local: aloadLocal(item) });
  if (/^(?:i|f|d|l)load(?:_[0-3])?$/.test(itemOp || '')) return push({ kind: 'value', index });
  if (/^(?:aconst_null|iconst_m1|iconst_[0-5]|fconst_[0-2]|dconst_[01]|lconst_[01]|bipush|sipush|ldc)$/.test(itemOp || '')) {
    return push({ kind: 'value', index });
  }
  if (itemOp === 'getfield') {
    if (!pop(1)) return false;
    return push({ kind: 'value', index });
  }
  if (itemOp === 'getstatic' || itemOp === 'new') return push({ kind: 'value', index });
  if (itemOp === 'checkcast') return true;
  if (itemOp === 'aaload') {
    if (!pop(2)) return false;
    return push({ kind: 'value', index });
  }
  if (/^[bcdfils]aload$/.test(itemOp || '')) {
    if (!pop(2)) return false;
    return push({ kind: 'value', index });
  }
  if (/^[bcdfilsa]store$/.test(itemOp || '')) return pop(itemOp === 'lastore' || itemOp === 'dastore' ? 4 : 3);
  if (/^(?:i|l|f|d|a)store(?:_[0-3])?$/.test(itemOp || '')) return pop(1);
  if (/^(?:i|l|f|d)(?:add|sub|mul|div|rem|and|or|xor|shl|shr|ushr)$/.test(itemOp || '')) {
    if (!pop(2)) return false;
    return push({ kind: 'value', index });
  }
  if (/^(?:i2[bcdfsl]|f2[dil]|d2[fil]|l2[dfi])$/.test(itemOp || '')) return stack.length > 0;
  if (itemOp === 'dup') {
    if (!stack.length) return false;
    stack.push(stack[stack.length - 1]);
    return true;
  }
  if (/^invoke/.test(itemOp || '')) {
    const ref = arg(item);
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    const params = parameterDescriptors(desc);
    if (!params) return false;
    const receiver = itemOp === 'invokestatic' ? 0 : 1;
    if (!pop(params.length + receiver)) return false;
    if (returnDescriptor(desc) !== 'V') return push({ kind: 'value', index });
    return true;
  }
  if (itemOp === 'pop') return pop(1);
  if (/^if/.test(itemOp || '')) {
    if (itemOp === 'ifnull' || itemOp === 'ifnonnull') return pop(1);
    if (itemOp === 'if_acmpeq' || itemOp === 'if_acmpne' || itemOp.startsWith('if_icmp')) return pop(2);
    return pop(1);
  }
  if (itemOp === 'goto' || itemOp === 'iinc' || itemOp === 'return') return true;
  return false;
}

function parameterDescriptors(desc) {
  if (typeof desc !== 'string' || desc[0] !== '(') return null;
  const out = [];
  for (let i = 1; i < desc.length && desc[i] !== ')';) {
    const start = i;
    while (desc[i] === '[') i += 1;
    if (desc[i] === 'L') {
      const end = desc.indexOf(';', i);
      if (end < 0) return null;
      out.push(desc.slice(start, end + 1));
      i = end + 1;
    } else {
      if (!desc[i]) return null;
      out.push(desc.slice(start, i + 1));
      i += 1;
    }
  }
  return out;
}

function returnDescriptor(desc) {
  if (typeof desc !== 'string') return null;
  const idx = desc.lastIndexOf(')');
  return idx >= 0 ? desc.slice(idx + 1) : null;
}

function isConcreteCastOwner(owner) {
  return typeof owner === 'string' && owner !== 'java/lang/Object' &&
    owner !== 'java/lang/Throwable' && owner !== 'java/lang/Exception' &&
    !owner.startsWith('[');
}

function dedupeInsertions(insertions) {
  const seen = new Set();
  const out = [];
  for (const insertion of insertions) {
    const key = `${insertion.index}:${insertion.owner}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(insertion);
  }
  return out;
}

function nextInstructionIndex(items, index) {
  for (let i = index + 1; i < items.length; i += 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
}

function previousInstructionIndex(items, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
}

function aloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'aload') return String(arg(item));
  const match = /^aload_([0-3])$/.exec(itemOp || '');
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
  runCastInvokeReceiversToOwners,
  castCode,
};
