'use strict';

function runIntizeBooleanParameters(astRoot, options = {}) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    const className = cls && cls.className;
    if (!className) continue;
    const changes = [];
    for (const item of cls.items || []) {
      const method = item && item.type === 'method' && item.method;
      if (!method || method.name === '<init>' || method.name === '<clinit>') continue;
      if (!isPrivate(method) && !options.allowNonPrivate) continue;
      const code = codeOf(method);
      if (!code || !Array.isArray(code.codeItems)) continue;
      const params = parameterDescriptors(method.descriptor);
      if (!params.includes('Z')) continue;
      const boolParams = parameterLocalMap(method).filter((param) => param.desc === 'Z');
      const mixed = boolParams.filter((param) => hasIntegerUse(code.codeItems, param.local));
      if (mixed.length === 0) continue;
      const newDescriptor = replaceParamDescriptors(method.descriptor, new Set(mixed.map((param) => param.index)), 'I');
      if (newDescriptor === method.descriptor) continue;
      changes.push({ name: method.name, oldDescriptor: method.descriptor, newDescriptor });
      method.descriptor = newDescriptor;
      rewrites += booleanizeCopiedParameterStores(code, new Set(mixed.map((param) => param.local)));
      rewrites += 1;
    }
    for (const change of changes) {
      rewrites += rewriteInvokes(cls, className, change);
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function booleanizeCopiedParameterStores(code, intParamLocals) {
  const items = code.codeItems;
  const referenced = referencedLabels(code);
  let rewrites = 0;
  for (let i = 0; i < items.length - 1; i += 1) {
    const sourceLocal = iloadLocal(items[i]);
    if (!intParamLocals.has(sourceLocal)) continue;
    const store = nextInstruction(items, i);
    if (!store || store.index !== i + 1) continue;
    const targetLocal = istoreLocal(store.item);
    if (targetLocal == null) continue;
    if (isReferencedLabel(items[i], referenced) || isReferencedLabel(store.item, referenced)) continue;
    if (hasIntegerUseBeforeOverwrite(items, targetLocal, store.index)) continue;

    const falseLabel = freshLabel(items, 'L_bool_param_false');
    const storeLabel = freshLabel(items, 'L_bool_param_store');
    const storeInstruction = store.item.instruction;
    items.splice(
      i + 1,
      1,
      { instruction: { op: 'ifeq', arg: falseLabel } },
      { instruction: 'iconst_1' },
      { instruction: { op: 'goto', arg: storeLabel } },
      { labelDef: `${falseLabel}:`, instruction: 'iconst_0' },
      { labelDef: `${storeLabel}:`, instruction: storeInstruction },
    );
    rewrites += 1;
    i += 5;
  }
  return rewrites;
}

function hasIntegerUseBeforeOverwrite(items, local, storeIndex) {
  for (let i = storeIndex + 1; i < items.length; i += 1) {
    if (istoreLocal(items[i]) === local) return false;
    if (iloadLocal(items[i]) !== local) continue;
    const next = nextInstruction(items, i);
    if (!next) continue;
    const nextOp = op(next.item);
    if (isIntegerUseOp(nextOp)) return true;
    if (nextOp === 'invokestatic' || nextOp === 'invokevirtual' || nextOp === 'invokeinterface' || nextOp === 'invokespecial') {
      const expected = expectedDescriptorForTopArgument(next.item);
      if (expected && expected !== 'Z') return true;
    }
  }
  return false;
}

function isPrivate(method) {
  return Array.isArray(method.flags) && method.flags.includes('private');
}

function codeOf(method) {
  const attr = (method.attributes || []).find((item) => item && item.type === 'code');
  return attr && attr.code;
}

function parameterLocalMap(method) {
  const params = parameterDescriptors(method.descriptor);
  const out = [];
  let local = isStatic(method) ? 0 : 1;
  for (let index = 0; index < params.length; index += 1) {
    const desc = params[index];
    out.push({ index, desc, local: String(local) });
    local += desc === 'J' || desc === 'D' ? 2 : 1;
  }
  return out;
}

function isStatic(method) {
  return Array.isArray(method.flags) && method.flags.includes('static');
}

function hasIntegerUse(items, local) {
  for (let i = 0; i < items.length; i += 1) {
    if (iloadLocal(items[i]) !== local) continue;
    const next = nextInstruction(items, i);
    if (!next) continue;
    const nextOp = op(next.item);
    if (isIntegerUseOp(nextOp)) return true;
    if (nextOp === 'invokestatic' || nextOp === 'invokevirtual' || nextOp === 'invokeinterface' || nextOp === 'invokespecial') {
      const expected = expectedDescriptorForTopArgument(next.item);
      if (expected && expected !== 'Z') return true;
    }
  }
  return false;
}

function hasBooleanUse(items, local) {
  for (let i = 0; i < items.length; i += 1) {
    if (iloadLocal(items[i]) !== local) continue;
    const next = nextInstruction(items, i);
    if (!next) continue;
    const nextOp = op(next.item);
    if (nextOp === 'ifeq' || nextOp === 'ifne') return true;
    const expected = expectedTypeFromNextInvoke(items, i);
    if (expected === 'Z') return true;
  }
  return false;
}

function isIntegerUseOp(itemOp) {
  return itemOp === 'istore' || /^istore_[0-3]$/.test(itemOp || '') ||
    itemOp === 'iadd' || itemOp === 'isub' || itemOp === 'imul' || itemOp === 'idiv' ||
    itemOp === 'irem' || itemOp === 'iand' || itemOp === 'ior' || itemOp === 'ixor' ||
    itemOp === 'ishl' || itemOp === 'ishr' || itemOp === 'iushr' ||
    itemOp === 'i2b' || itemOp === 'i2c' || itemOp === 'i2s' || itemOp === 'i2l' ||
    itemOp === 'i2f' || itemOp === 'i2d' || itemOp === 'iastore';
}

function expectedDescriptorForTopArgument(item) {
  const ref = arg(item);
  const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  const params = parameterDescriptors(desc);
  return params.length ? params[params.length - 1] : null;
}

function expectedTypeFromNextInvoke(items, loadIndex) {
  for (let i = nextInstructionIndex(items, loadIndex), seen = 0; i >= 0 && seen < 32; i = nextInstructionIndex(items, i), seen += 1) {
    if (/^invoke/.test(op(items[i]) || '')) return expectedTypeFromInvokeUse(items, loadIndex, i);
  }
  return null;
}

function expectedTypeFromInvokeUse(items, loadIndex, invokeIndex) {
  const ref = arg(items[invokeIndex]);
  const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
  const args = parameterDescriptors(desc);
  if (!args.length) return null;
  const marker = { marker: true };
  const stack = [marker];
  for (let i = nextInstructionIndex(items, loadIndex); i >= 0 && i < invokeIndex; i = nextInstructionIndex(items, i)) {
    if (!simulateStackEffect(items[i], stack)) return null;
  }
  for (let argIndex = args.length - 1, stackIndex = stack.length - 1; argIndex >= 0 && stackIndex >= 0; argIndex -= 1, stackIndex -= 1) {
    if (stack[stackIndex] === marker) return args[argIndex];
  }
  return null;
}

function simulateStackEffect(item, stack) {
  const itemOp = op(item);
  const push = () => {
    stack.push('?');
    return true;
  };
  const pop = (count) => {
    for (let i = 0; i < count; i += 1) {
      if (!stack.length) return false;
      stack.pop();
    }
    return true;
  };
  if (/^(?:i|a|f|d|l)load(?:_[0-3])?$/.test(itemOp || '')) return push();
  if (/^(?:aconst_null|iconst_m1|iconst_[0-5]|fconst_[0-2]|dconst_[01]|lconst_[01]|bipush|sipush|ldc)$/.test(itemOp || '')) return push();
  if (itemOp === 'getstatic') return push();
  if (itemOp === 'getfield') return pop(1) && push();
  if (/^[bcdfils]aload$/.test(itemOp || '') || itemOp === 'aaload') return pop(2) && push();
  if (/^(?:i|f|l|d)(?:add|sub|mul|div|rem|and|or|xor|shl|shr|ushr)$/.test(itemOp || '')) return pop(2) && push();
  if (/^(?:i2[bcdfsl]|f2[dil]|d2[fil]|l2[dfi])$/.test(itemOp || '')) return stack.length > 0;
  if (itemOp === 'dup') {
    if (!stack.length) return false;
    stack.push(stack[stack.length - 1]);
    return true;
  }
  if (itemOp === 'checkcast') return stack.length > 0;
  return false;
}

function rewriteInvokes(cls, className, change) {
  let rewrites = 0;
  for (const item of cls.items || []) {
    const method = item && item.type === 'method' && item.method;
    const code = method && codeOf(method);
    if (!code || !Array.isArray(code.codeItems)) continue;
    for (const codeItem of code.codeItems) {
      const insn = codeItem && codeItem.instruction;
      const itemOp = op(codeItem);
      if (!/^invoke/.test(itemOp || '')) continue;
      const ref = insn && typeof insn === 'object' && insn.arg;
      if (!Array.isArray(ref) || ref[1] !== className || !Array.isArray(ref[2])) continue;
      if (ref[2][0] !== change.name || ref[2][1] !== change.oldDescriptor) continue;
      ref[2] = [ref[2][0], change.newDescriptor];
      rewrites += 1;
    }
  }
  return rewrites;
}

function replaceParamDescriptors(descriptor, indexes, replacement) {
  const params = parameterDescriptors(descriptor);
  if (params.length === 0) return descriptor;
  const close = descriptor.indexOf(')');
  const ret = descriptor.slice(close + 1);
  const next = params.map((desc, index) => indexes.has(index) ? replacement : desc);
  return `(${next.join('')})${ret}`;
}

function parameterDescriptors(descriptor) {
  if (typeof descriptor !== 'string' || descriptor[0] !== '(') return [];
  const out = [];
  let i = 1;
  while (i < descriptor.length && descriptor[i] !== ')') {
    const start = i;
    while (descriptor[i] === '[') i += 1;
    if (descriptor[i] === 'L') {
      const semi = descriptor.indexOf(';', i);
      if (semi < 0) return [];
      i = semi + 1;
      out.push(descriptor.slice(start, i));
    } else {
      i += 1;
      out.push(descriptor.slice(start, i));
    }
  }
  return out;
}

function nextInstruction(items, index) {
  for (let i = index + 1; i < items.length; i += 1) {
    if (items[i] && items[i].instruction) return { index: i, item: items[i] };
  }
  return null;
}

function nextInstructionIndex(items, index) {
  const next = nextInstruction(items, index);
  return next ? next.index : -1;
}

function iloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'iload') return String(arg(item));
  if (/^iload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function istoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'istore') return String(arg(item));
  if (/^istore_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function referencedLabels(code) {
  const out = new Set();
  for (const item of code.codeItems || []) {
    const insn = item && item.instruction;
    if (insn && typeof insn === 'object' && typeof insn.arg === 'string') out.add(trimLabel(insn.arg));
  }
  for (const entry of code.exceptionTable || []) {
    for (const label of [entry.startLbl, entry.endLbl, entry.handlerLbl]) out.add(trimLabel(label));
  }
  out.delete(null);
  return out;
}

function isReferencedLabel(item, referenced) {
  const label = trimLabel(item && item.labelDef);
  return !!label && referenced.has(label);
}

function freshLabel(items, prefix) {
  const used = new Set(items.map((item) => trimLabel(item && item.labelDef)).filter(Boolean));
  let n = 0;
  let label = prefix;
  while (used.has(label)) {
    n += 1;
    label = `${prefix}_${n}`;
  }
  return label;
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
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
  runIntizeBooleanParameters,
  parameterDescriptors,
};
