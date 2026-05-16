'use strict';

function runCastReferenceArrayAssignmentsToDeclaredTypes(astRoot, options = {}) {
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
  const locals = initialLocalDescriptors(method);
  const parameterLocals = new Set(locals.keys());
  const insertions = [];
  let aliasRewrites = 0;
  const maxCasts = options.maxCasts || 64;

  for (let i = 0; i < items.length; i += 1) {
    const itemOp = op(items[i]);
    if (!itemOp) continue;
    const collapsed = collapseImmediateCastedAlias(items, i, locals);
    if (collapsed) {
      insertions.push(...collapsed.insertions);
      aliasRewrites += 1;
      locals.set(collapsed.targetLocal, collapsed.desc);
      locals.set(collapsed.sourceLocal, null);
      i = collapsed.endIndex;
      continue;
    }
    const collapsedCopy = collapseImmediateArrayAlias(items, i, locals, parameterLocals, method);
    if (collapsedCopy) {
      aliasRewrites += collapsedCopy.rewrites;
      locals.set(collapsedCopy.targetLocal, collapsedCopy.desc);
      locals.set(collapsedCopy.sourceLocal, null);
      i = collapsedCopy.endIndex;
      continue;
    }
    const store = astoreLocal(items[i]);
    if (store != null) {
      const prev = previousInstructionIndex(items, i);
      const expected = locals.get(store);
      const source = prev >= 0 ? aloadLocal(items[prev]) : null;
      const produced = producerDescriptor(items, prev, locals);
      if (isConcreteReferenceArrayDescriptor(expected) &&
          (produced === expected || (source != null && locals.get(source) === expected)) &&
          op(items[prev]) !== 'checkcast') {
        insertions.push({ index: i, desc: expected });
      }
      locals.set(store, produced || null);
      continue;
    }
    if (itemOp === 'putfield' || itemOp === 'putstatic') {
      const expected = fieldDescriptor(arg(items[i]));
      const prev = previousInstructionIndex(items, i);
      const source = prev >= 0 ? aloadLocal(items[prev]) : null;
      if (isConcreteReferenceArrayDescriptor(expected) && source != null &&
          locals.get(source) === expected && op(items[prev]) !== 'checkcast') {
        insertions.push({ index: i, desc: expected });
      }
    }
    const primitive = primitiveStoreLocal(items[i]);
    if (primitive != null) locals.set(primitive, null);
  }

  const unique = dedupeInsertions(insertions);
  if (unique.length > maxCasts) return 0;
  for (const insertion of unique.sort((a, b) => b.index - a.index)) {
    items.splice(insertion.index, 0, { instruction: { op: 'checkcast', arg: insertion.desc } });
  }
  return unique.length + aliasRewrites;
}

function collapseImmediateArrayAlias(items, index, locals, parameterLocals = new Set(), method = {}) {
  if (returnDescriptor(method.descriptor) !== '[Ljava/lang/Object;') return null;
  const sourceLocal = astoreLocal(items[index]);
  if (sourceLocal == null) return null;
  const loadIndex = nextInstructionIndex(items, index);
  const targetStoreIndex = loadIndex >= 0 ? nextInstructionIndex(items, loadIndex) : -1;
  if (loadIndex < 0 || targetStoreIndex < 0) return null;
  if (aloadLocal(items[loadIndex]) !== sourceLocal) return null;
  const targetLocal = astoreLocal(items[targetStoreIndex]);
  if (targetLocal == null || targetLocal === sourceLocal) return null;
  if (parameterLocals.has(targetLocal)) return null;
  const produced = producerDescriptor(items, previousInstructionIndex(items, index), locals);
  if (!isConcreteReferenceArrayDescriptor(produced)) return null;
  const expected = locals.get(targetLocal);
  if (expected && expected !== produced) return null;
  items[index].instruction = storeRef(targetLocal);
  items[loadIndex].instruction = loadRef(targetLocal);
  const rewrites = 1 + rewriteAliasLoads(items, targetStoreIndex + 1, sourceLocal, targetLocal);
  return { sourceLocal, targetLocal, desc: produced, endIndex: targetStoreIndex, rewrites };
}

function collapseImmediateCastedAlias(items, index, locals) {
  const sourceLocal = astoreLocal(items[index]);
  if (sourceLocal == null) return null;
  const loadIndex = nextInstructionIndex(items, index);
  const castIndex = loadIndex >= 0 ? nextInstructionIndex(items, loadIndex) : -1;
  const targetStoreIndex = castIndex >= 0 ? nextInstructionIndex(items, castIndex) : -1;
  if (loadIndex < 0 || castIndex < 0 || targetStoreIndex < 0) return null;
  if (aloadLocal(items[loadIndex]) !== sourceLocal || op(items[castIndex]) !== 'checkcast') return null;
  const targetLocal = astoreLocal(items[targetStoreIndex]);
  if (targetLocal == null || targetLocal === sourceLocal) return null;
  const desc = referenceDescriptorFromClassName(arg(items[castIndex]));
  if (!isConcreteReferenceArrayDescriptor(desc)) return null;
  const expected = locals.get(targetLocal);
  if (expected && expected !== desc) return null;
  items[index].instruction = storeRef(targetLocal);
  items[loadIndex].instruction = loadRef(targetLocal);
  return { sourceLocal, targetLocal, desc, endIndex: targetStoreIndex, insertions: [] };
}

function rewriteAliasLoads(items, startIndex, sourceLocal, targetLocal) {
  let rewrites = 0;
  for (let i = startIndex; i < items.length; i += 1) {
    if (!items[i] || !items[i].instruction) continue;
    if (astoreLocal(items[i]) === sourceLocal) break;
    if (aloadLocal(items[i]) !== sourceLocal) continue;
    items[i].instruction = loadRef(targetLocal);
    rewrites += 1;
  }
  return rewrites;
}

function initialLocalDescriptors(method) {
  const locals = new Map();
  let slot = method.flags && method.flags.includes('static') ? 0 : 1;
  for (const desc of parameterDescriptors(method.descriptor) || []) {
    if (isReferenceDescriptor(desc)) locals.set(String(slot), desc);
    slot += desc === 'J' || desc === 'D' ? 2 : 1;
  }
  return locals;
}

function producerDescriptor(items, index, locals) {
  if (index < 0) return null;
  const itemOp = op(items[index]);
  if (itemOp === 'checkcast') return referenceDescriptorFromClassName(arg(items[index]));
  if (itemOp === 'anewarray') return arrayDescriptorFromClassName(arg(items[index]));
  if (itemOp === 'getfield' || itemOp === 'getstatic') return fieldDescriptor(arg(items[index]));
  if (/^invoke/.test(itemOp || '')) {
    const ref = arg(items[index]);
    const desc = Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
    return returnDescriptor(desc);
  }
  const source = aloadLocal(items[index]);
  if (source != null) return locals.get(source) || null;
  return null;
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

function isConcreteReferenceArrayDescriptor(desc) {
  return typeof desc === 'string' && /^\[L[^;]+;$/.test(desc) && desc !== '[Ljava/lang/Object;';
}

function isReferenceDescriptor(desc) {
  return typeof desc === 'string' && (desc.startsWith('L') || desc.startsWith('['));
}

function referenceDescriptorFromClassName(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('[')) return value;
  return `L${value};`;
}

function arrayDescriptorFromClassName(value) {
  return typeof value === 'string' && !value.startsWith('[') ? `[L${value};` : value;
}

function fieldDescriptor(ref) {
  return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
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

function aloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'aload') return String(arg(item));
  const match = /^aload_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function astoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'astore') return String(arg(item));
  const match = /^astore_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function primitiveStoreLocal(item) {
  const itemOp = op(item);
  if (/^[ilfd]store$/.test(itemOp || '')) return String(arg(item));
  const match = /^[ilfd]store_([0-3])$/.exec(itemOp || '');
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
  runCastReferenceArrayAssignmentsToDeclaredTypes,
  castCode,
};
