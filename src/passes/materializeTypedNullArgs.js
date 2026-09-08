'use strict';

const {
  trimLabel,
  branchTargets,
  referencedLabels,
} = require('./labelReferences');

const { parameterDescriptorsOrEmpty: parameterDescriptors } =
  require('./parameterDescriptors');

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
  rewrites += materializeRawNullInvokeArgs(code);
  return rewrites;
}

function materializeRawNullInvokeArgs(code) {
  const items = code.codeItems;
  const referenced = referencedLabels(code);
  const insertions = [];
  for (let i = 0; i < items.length; i += 1) {
    if (op(items[i]) !== 'invokestatic') continue;
    const ref = arg(items[i]);
    const descriptor = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    const params = parameterDescriptors(descriptor);
    if (params.length === 0) continue;
    const invokeInsertions = [];
    let cursor = previousInstructionIndex(items, i);
    let ok = true;
    for (let p = params.length - 1; p >= 0; p -= 1) {
      if (cursor < 0 || !isOneSlotSimpleArgumentProducer(items[cursor])) {
        ok = false;
        break;
      }
      const desc = params[p];
      const nextIndex = nextInstructionIndex(items, cursor);
      if (isReferenceDescriptor(desc) &&
          op(items[cursor]) === 'aconst_null' &&
          op(items[nextIndex]) !== 'checkcast' &&
          !isReferencedLabel(items[nextIndex], referenced)) {
        invokeInsertions.push({ index: cursor + 1, desc, fresh: allocateLocal(code) });
      }
      cursor = previousInstructionIndex(items, cursor);
    }
    if (ok) insertions.push(...invokeInsertions);
  }
  for (const insertion of insertions.sort((a, b) => b.index - a.index)) {
    items.splice(
      insertion.index,
      0,
      { instruction: { op: 'checkcast', arg: checkcastArg(insertion.desc) } },
      { instruction: 'dup' },
      { instruction: storeRef(insertion.fresh) },
    );
  }
  if (insertions.length > 0) code.stackSize = String(Math.max(Number(code.stackSize || 0), 2));
  return insertions.length;
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

function isReferenceDescriptor(desc) {
  return typeof desc === 'string' && (desc.startsWith('L') || desc.startsWith('['));
}

function checkcastArg(desc) {
  return typeof desc === 'string' && /^L[^;]+;$/.test(desc) ? desc.slice(1, -1) : desc;
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

function isOneSlotSimpleArgumentProducer(item) {
  const itemOp = op(item);
  return isSimpleArgumentProducer(item) &&
    itemOp !== 'lconst_0' && itemOp !== 'lconst_1' &&
    itemOp !== 'dconst_0' && itemOp !== 'dconst_1';
}

function isReferencedLabel(item, referenced) {
  const label = trimLabel(item && item.labelDef);
  return !!label && referenced.has(label);
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
