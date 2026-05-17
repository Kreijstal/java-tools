'use strict';

function runMaterializeTypedNullArgs(astRoot) {
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
  for (let i = 0; i + 1 < items.length; i += 1) {
    if (op(items[i]) !== 'aconst_null' || op(items[i + 1]) !== 'checkcast') continue;
    const target = arg(items[i + 1]);
    const desc = referenceDescriptorFromClassName(target);
    if (!desc) continue;
    const invokeIndex = findFollowingInvokeUsingDescriptor(items, i + 2, desc);
    if (invokeIndex < 0) continue;
    const fresh = allocateLocal(code);
    items.splice(
      i,
      2,
      { labelDef: items[i].labelDef, instruction: 'aconst_null' },
      { labelDef: items[i + 1].labelDef, instruction: { op: 'checkcast', arg: target } },
      { instruction: 'dup' },
      { instruction: storeRef(fresh) },
    );
    code.stackSize = String(Math.max(Number(code.stackSize || 0), 2));
    rewrites += 1;
    i += 3;
  }
  return rewrites;
}

function findFollowingInvokeUsingDescriptor(items, start, desc) {
  for (let i = start, seen = 0; i < items.length && seen < 8; i += 1, seen += 1) {
    const itemOp = op(items[i]);
    if (/^invoke/.test(itemOp || '')) {
      const ref = arg(items[i]);
      const methodDesc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
      return typeof methodDesc === 'string' && parameterDescriptors(methodDesc).includes(desc) ? i : -1;
    }
    if (!isSimpleArgumentProducer(items[i])) return -1;
  }
  return -1;
}

function isSimpleArgumentProducer(item) {
  const itemOp = op(item);
  return /^(?:a|i|l|f|d)load(?:_[0-3])?$/.test(itemOp || '') ||
    /^(?:aconst_null|iconst_m1|iconst_[0-5]|lconst_[0-1]|fconst_[0-2]|dconst_[0-1])$/.test(itemOp || '') ||
    itemOp === 'bipush' || itemOp === 'sipush' || itemOp === 'ldc' ||
    itemOp === 'getstatic' || itemOp === 'getfield';
}

function parameterDescriptors(descriptor) {
  const close = descriptor.indexOf(')');
  if (!descriptor.startsWith('(') || close < 0) return [];
  const params = [];
  for (let i = 1; i < close;) {
    const start = i;
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

function referenceDescriptorFromClassName(target) {
  if (typeof target === 'string' && /^[^[]/.test(target)) return `L${target};`;
  if (typeof target === 'string' && /^\[+(?:[ZBCSIJFD]|L[^;]+;)$/.test(target)) return target;
  return null;
}

function allocateLocal(code) {
  const current = Number(code.locals || code.localsSize || 0);
  const next = String(current + 1);
  if ('locals' in code) code.locals = next;
  else code.localsSize = next;
  return String(current);
}

function loadRef(local) {
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return `aload_${n}`;
  return { op: 'aload', arg: String(local) };
}

function storeRef(local) {
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return `astore_${n}`;
  return { op: 'astore', arg: String(local) };
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
  runMaterializeTypedNullArgs,
  rewriteCode,
};
