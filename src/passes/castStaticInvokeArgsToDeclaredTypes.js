'use strict';

function runCastStaticInvokeArgsToDeclaredTypes(astRoot, options = {}) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += castCode(code, item.method, options);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function castCode(code, method = {}, options = {}) {
  const items = code.codeItems;
  const insertions = [];
  const stack = [];
  const locals = initialLocals(method);
  const maxCasts = options.maxCasts || 64;

  for (let i = 0; i < items.length; i += 1) {
    if (!items[i] || !items[i].instruction) continue;
    const itemOp = op(items[i]);
    if (itemOp === 'invokestatic') {
      for (const insertion of staticArgumentCastInsertions(items, i, stack)) {
        insertions.push(insertion);
      }
    }
    if (!applyStackEffect(stack, locals, items[i], i)) {
      stack.length = 0;
    }
  }

  const unique = dedupeInsertions(insertions);
  if (unique.length === 0 || unique.length > maxCasts) return 0;
  for (const insertion of unique) {
    insertion.local = allocateLocal(code);
  }
  for (const insertion of unique.sort((a, b) => b.index - a.index)) {
    items.splice(
      insertion.index,
      0,
      { instruction: { op: 'checkcast', arg: checkcastArg(insertion.desc) } },
      { instruction: storeRef(insertion.local) },
      { instruction: loadRef(insertion.local) },
    );
  }
  return unique.length;
}

function staticArgumentCastInsertions(items, invokeIndex, stack) {
  const ref = arg(items[invokeIndex]);
  const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  const params = parameterDescriptors(desc);
  if (!params || params.length === 0 || stack.length < params.length) return [];
  const out = [];
  const start = stack.length - params.length;
  for (let p = 0; p < params.length; p += 1) {
    const expected = params[p];
    if (!isUsefulReferenceCast(expected)) continue;
    const value = stack[start + p];
    if (!value || !isUsefulReferenceCast(value.desc) || value.desc === expected) continue;
    if (hasExistingCastAfter(items, value.index, invokeIndex, expected)) continue;
    if (!canInsertAfterProducer(items, value.index, invokeIndex)) continue;
    out.push({ index: nextInstructionIndex(items, value.index), desc: expected });
  }
  return out;
}

function applyStackEffect(stack, locals, item, index) {
  const itemOp = op(item);
  const push = (value) => {
    stack.push(value);
    return true;
  };
  const pop = (count) => {
    if (stack.length < count) return false;
    stack.splice(stack.length - count, count);
    return true;
  };

  const load = loadLocal(item);
  if (load) return push({ kind: 'local', index, desc: locals.get(load.local) || null });
  if (intLoadLocal(item) != null || /^(?:f|d|l)load(?:_[0-3])?$/.test(itemOp || '')) {
    return push({ kind: 'value', index, desc: null });
  }
  if (/^(?:aconst_null|iconst_m1|iconst_[0-5]|fconst_[0-2]|dconst_[01]|lconst_[01]|bipush|sipush|ldc|ldc_w|ldc2_w)$/.test(itemOp || '')) {
    return push({ kind: 'value', index, desc: literalDescriptor(item) });
  }
  if (itemOp === 'getstatic') return push({ kind: 'value', index, desc: fieldDescriptor(arg(item)) });
  if (itemOp === 'getfield') {
    if (!pop(1)) return false;
    return push({ kind: 'value', index, desc: fieldDescriptor(arg(item)) });
  }
  if (itemOp === 'new') return push({ kind: 'value', index, desc: referenceDescriptorFromClassName(arg(item)) });
  if (itemOp === 'checkcast') {
    if (!stack.length) return false;
    stack[stack.length - 1] = { ...stack[stack.length - 1], index, desc: referenceDescriptorFromClassName(arg(item)) };
    return true;
  }
  if (itemOp === 'dup') {
    if (!stack.length) return false;
    stack.push({ ...stack[stack.length - 1] });
    return true;
  }
  if (itemOp === 'aaload') {
    if (!pop(2)) return false;
    return push({ kind: 'value', index, desc: null });
  }
  if (/^[bcdfils]aload$/.test(itemOp || '')) {
    if (!pop(2)) return false;
    return push({ kind: 'value', index, desc: null });
  }
  if (/^[bcdfilsa]store$/.test(itemOp || '')) return pop(itemOp === 'lastore' || itemOp === 'dastore' ? 4 : 3);
  const store = storeLocal(item);
  if (store) {
    if (!stack.length) return false;
    const value = stack.pop();
    locals.set(store.local, store.kind === 'a' ? value.desc || null : null);
    return true;
  }
  if (/^(?:i|l|f|d)(?:add|sub|mul|div|rem|and|or|xor|shl|shr|ushr)$/.test(itemOp || '')) {
    if (!pop(2)) return false;
    return push({ kind: 'value', index, desc: null });
  }
  if (/^(?:i2[bcdfsl]|f2[dil]|d2[fil]|l2[dfi])$/.test(itemOp || '')) return stack.length > 0;
  if (/^invoke/.test(itemOp || '')) {
    const ref = arg(item);
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    const params = parameterDescriptors(desc);
    if (!params) return false;
    const receiver = itemOp === 'invokestatic' ? 0 : 1;
    if (!pop(params.length + receiver)) return false;
    const ret = returnDescriptor(desc);
    if (ret && ret !== 'V') return push({ kind: 'value', index, desc: isReferenceDescriptor(ret) ? ret : null });
    return true;
  }
  if (itemOp === 'pop') return pop(1);
  if (/^if/.test(itemOp || '')) {
    if (itemOp === 'ifnull' || itemOp === 'ifnonnull') return pop(1);
    if (itemOp === 'if_acmpeq' || itemOp === 'if_acmpne' || itemOp.startsWith('if_icmp')) return pop(2);
    return pop(1);
  }
  if (itemOp === 'goto' || itemOp === 'iinc' || itemOp === 'return' ||
      /^(?:i|l|f|d|a)?return$/.test(itemOp || '')) {
    return true;
  }
  return false;
}

function initialLocals(method) {
  const locals = new Map();
  let slot = method.flags && method.flags.includes('static') ? 0 : 1;
  for (const desc of parameterDescriptors(method.descriptor) || []) {
    if (isReferenceDescriptor(desc)) locals.set(String(slot), desc);
    slot += desc === 'J' || desc === 'D' ? 2 : 1;
  }
  return locals;
}

function canInsertAfterProducer(items, producerIndex, invokeIndex) {
  const insertAt = nextInstructionIndex(items, producerIndex);
  return insertAt >= 0 && insertAt <= invokeIndex;
}

function hasExistingCastAfter(items, producerIndex, invokeIndex, desc) {
  const next = nextInstructionIndex(items, producerIndex);
  return next >= 0 && next < invokeIndex && op(items[next]) === 'checkcast' &&
    referenceDescriptorFromClassName(arg(items[next])) === desc;
}

function dedupeInsertions(insertions) {
  const seen = new Set();
  const out = [];
  for (const insertion of insertions) {
    const key = `${insertion.index}:${insertion.desc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(insertion);
  }
  return out;
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

function isUsefulReferenceCast(desc) {
  return isReferenceDescriptor(desc) && desc !== 'Ljava/lang/Object;';
}

function isReferenceDescriptor(desc) {
  return typeof desc === 'string' && (desc.startsWith('L') || desc.startsWith('['));
}

function referenceDescriptorFromClassName(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('[')) return value;
  return `L${value};`;
}

function checkcastArg(desc) {
  return desc && desc.startsWith('L') && desc.endsWith(';') ? desc.slice(1, -1) : desc;
}

function allocateLocal(code) {
  const current = Number(code.locals || code.localsSize || 0);
  const next = String(current + 1);
  if ('locals' in code) code.locals = next;
  else code.localsSize = next;
  return String(current);
}

function storeRef(local) {
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return `astore_${n}`;
  return { op: 'astore', arg: String(local) };
}

function loadRef(local) {
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return `aload_${n}`;
  return { op: 'aload', arg: String(local) };
}

function fieldDescriptor(ref) {
  return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
}

function literalDescriptor(item) {
  const value = arg(item);
  return typeof value === 'string' ? 'Ljava/lang/String;' : null;
}

function nextInstructionIndex(items, index) {
  for (let i = index + 1; i < items.length; i += 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
}

function loadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'aload') return { kind: 'a', local: String(arg(item)) };
  const match = /^aload_([0-3])$/.exec(itemOp || '');
  return match ? { kind: 'a', local: match[1] } : null;
}

function intLoadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'iload') return String(arg(item));
  const match = /^iload_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function storeLocal(item) {
  const itemOp = op(item);
  if (/^[ailfd]store$/.test(itemOp || '')) return { kind: itemOp[0], local: String(arg(item)) };
  const match = /^([ailfd])store_([0-3])$/.exec(itemOp || '');
  return match ? { kind: match[1], local: match[2] } : null;
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
  runCastStaticInvokeArgsToDeclaredTypes,
  castCode,
};
