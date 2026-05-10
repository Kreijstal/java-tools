'use strict';

/**
 * deadStaticBoolFlag — eliminate a static always-zero guard pattern.
 *
 * The obfuscator inserts a static boolean field (default value: false) that is
 * loaded into a local and consulted throughout to gate dead branches. Some
 * old clients use the same shape with an int zero flag; that case is opt-in
 * via allowIntFlags. Concretely, the entry pattern is:
 *
 *     L0: getstatic Field FOO X Z
 *     L3: istore N
 *
 * and later:
 *
 *     ... iload N; ifne FAR     // never branches, since N==0
 *     ... iload N; ifeq FAR     // always branches, since N==0
 *
 * This pass identifies "always-false" static boolean fields (per the caller-
 * supplied list) and eliminates the dead conditional within each method
 * that loads such a field into a local at entry.
 *
 * Safety constraints:
 *
 *   1. The local N must be FRESH-NEVER-MUTATED after the entry istore. We
 *      scan the whole codeItems list for any other write to N (istore N,
 *      iinc N, store N) — if found, ABORT for that local entirely. The
 *      pass is conservative; we don't try liveness analysis.
 *   2. The `iload N; if{ne,eq} TGT` pair must be flat sequential — the iload
 *      and the conditional must be adjacent in source order, and no labelDef
 *      may sit between them (otherwise some other path could reach the if
 *      with a different value on the stack).
 *   3. The pass NEVER touches the entry `getstatic; istore` itself; later
 *      passes / liveness can clean that up. We just rewrite the consumer.
 *   4. We refuse to rewrite if the iload sits at a labelDef AND any other
 *      jump targets that label (we'd need to preserve the label, but not
 *      the instruction at it). The simple form: the labelDef sits on the
 *      iload; we keep the labelDef and just delete the instruction off it.
 *
 * Rewrite per case:
 *   iload N; ifne TGT  -> delete both (always falls through)
 *   iload N; ifeq TGT  -> delete iload, replace ifeq with goto TGT
 *
 * Stack effect:
 *   Before: iload(+1) ifne(-1) = 0   →  After: nothing = 0 ✓
 *   Before: iload(+1) ifeq(-1) = 0   →  After: goto = 0 ✓
 */

const DEFAULT_ALWAYS_FALSE_FIELDS = [];

const LOAD_OPS = {
  iload: { numbered: ['iload_0', 'iload_1', 'iload_2', 'iload_3'], generic: 'iload' },
};

const STORE_OPS = new Set([
  'istore', 'istore_0', 'istore_1', 'istore_2', 'istore_3',
  'lstore', 'lstore_0', 'lstore_1', 'lstore_2', 'lstore_3',
  'fstore', 'fstore_0', 'fstore_1', 'fstore_2', 'fstore_3',
  'dstore', 'dstore_0', 'dstore_1', 'dstore_2', 'dstore_3',
  'astore', 'astore_0', 'astore_1', 'astore_2', 'astore_3',
]);

const ISTORE_OPS = new Set([
  'istore', 'istore_0', 'istore_1', 'istore_2', 'istore_3',
]);

const ILOAD_OPS = new Set([
  'iload', 'iload_0', 'iload_1', 'iload_2', 'iload_3',
]);

function parseFieldList(spec) {
  if (!spec) return new Set(DEFAULT_ALWAYS_FALSE_FIELDS);
  const out = new Set();
  for (const tok of spec.split(',')) {
    const t = tok.trim();
    if (!t) continue;
    out.add(t);
  }
  return out;
}

function getOp(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return instruction;
  return instruction.op || null;
}

function getArg(instruction) {
  if (!instruction || typeof instruction !== 'object') return null;
  return instruction.arg;
}

function localOf(op, arg) {
  // Map opcode + arg to a numeric local index (or null if not a local-indexed
  // load/store). Both numbered (istore_2) and generic (istore N) forms supported.
  if (!op) return null;
  if (op.length > 2 && op[op.length - 2] === '_') {
    const n = parseInt(op.slice(-1), 10);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof arg === 'number') return arg;
  if (typeof arg === 'string') {
    const n = parseInt(arg, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function fieldRefOf(arg) {
  // getstatic/putstatic args are arrays: ["Field", "ClassName", ["fieldName", "descriptor"]]
  // Returns { cls, name, desc } or null.
  if (!Array.isArray(arg) || arg.length < 3) return null;
  if (arg[0] !== 'Field') return null;
  const cls = arg[1];
  const inner = arg[2];
  if (!Array.isArray(inner) || inner.length < 2) return null;
  return { cls, name: inner[0], desc: inner[1] };
}

function fieldKey(ref) {
  return `${ref.cls}.${ref.name}`;
}

function trimLabel(label) {
  if (typeof label !== 'string') return label;
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

function isLocalRewritten(codeItems, local, allowedSites) {
  // Return true if any STORE to `local` exists outside the allowedSites set
  // (which holds the indices we already know about — the entry istore).
  for (let i = 0; i < codeItems.length; i += 1) {
    if (allowedSites.has(i)) continue;
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const op = getOp(item.instruction);
    if (op === 'iinc') {
      // iinc operand: { local, increment } or arg "n by k"
      const arg = getArg(item.instruction);
      let l = null;
      if (arg && typeof arg === 'object' && typeof arg.local === 'number') l = arg.local;
      else if (typeof arg === 'string') {
        const m = /^(\d+)\b/.exec(arg);
        if (m) l = parseInt(m[1], 10);
      } else if (typeof arg === 'number') l = arg;
      if (l === local) return true;
      continue;
    }
    if (!STORE_OPS.has(op)) continue;
    const l = localOf(op, getArg(item.instruction));
    if (l === local) return true;
  }
  return false;
}

function findEntryStoreSites(codeItems, alwaysFalseFields, opts = {}) {
  // Returns { sites: Set of istore-codeItem-indices to exclude from
  // rewritten-checks, bindingDetails: [{ getstaticIdx, istoreIdx, local }] }.
  const sites = new Set();
  const bindingDetails = [];
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const op = getOp(item.instruction);
    if (op !== 'getstatic') continue;
    const ref = fieldRefOf(getArg(item.instruction));
    if (!ref || (ref.desc !== 'Z' && !(opts.allowIntFlags && ref.desc === 'I'))) continue;
    if (!alwaysFalseFields.has(`${ref.cls}.${ref.name}`)) continue;
    // Find next real instruction (a labelDef-only item is OK between them).
    let j = i + 1;
    while (j < codeItems.length) {
      const nx = codeItems[j];
      if (nx && nx.instruction) break;
      j += 1;
    }
    if (j >= codeItems.length) continue;
    const next = codeItems[j];
    const nextOp = getOp(next.instruction);
    if (!ISTORE_OPS.has(nextOp)) continue;
    const local = localOf(nextOp, getArg(next.instruction));
    if (local === null) continue;
    sites.add(j);
    bindingDetails.push({ getstaticIdx: i, istoreIdx: j, local });
  }
  return { sites, bindingDetails };
}

function eliminateInMethod(code, opts) {
  const codeItems = code.codeItems;
  if (!Array.isArray(codeItems) || codeItems.length === 0) return 0;
  const { sites, bindingDetails } = findEntryStoreSites(codeItems, opts.alwaysFalseFields, opts);
  if (bindingDetails.length === 0) return 0;
  // Determine which locals are "clean" (never re-stored).
  const cleanLocals = new Set();
  for (const b of bindingDetails) {
    if (!isLocalRewritten(codeItems, b.local, sites)) {
      cleanLocals.add(b.local);
    }
  }
  if (cleanLocals.size === 0) return 0;

  // Walk and rewrite. We collect rewrites first (avoid reindexing during scan)
  // and apply in descending order.
  const rewrites = []; // { iloadIdx, ifIdx, ifKind, target, ifLabelDef }
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const op = getOp(item.instruction);
    if (!ILOAD_OPS.has(op)) continue;
    const local = localOf(op, getArg(item.instruction));
    if (local === null || !cleanLocals.has(local)) continue;
    // Find next instruction; must be ifne/ifeq with no labelDef between.
    let j = i + 1;
    let labelBetween = false;
    while (j < codeItems.length) {
      const nx = codeItems[j];
      if (!nx) { j += 1; continue; }
      if (nx.instruction) break;
      if (nx.labelDef) labelBetween = true; // a labelDef on a separate item between iload and if
      j += 1;
    }
    if (j >= codeItems.length) continue;
    if (labelBetween) continue;
    const next = codeItems[j];
    const nop = getOp(next.instruction);
    if (nop !== 'ifne' && nop !== 'ifeq') continue;
    const target = getArg(next.instruction);
    if (typeof target !== 'string') continue;
    rewrites.push({ iloadIdx: i, ifIdx: j, ifKind: nop, target });
  }

  if (rewrites.length === 0) return 0;

  // Apply rewrites. We keep labelDefs intact: if the iload codeItem has a
  // labelDef, we delete only the instruction (not the labelDef). Same for
  // the if codeItem. For ifeq we replace its instruction with `goto TGT`.
  // Iterate in DESCENDING index order so earlier indexes remain valid; but
  // since we never splice (we only mutate fields), the order doesn't matter.
  for (const r of rewrites) {
    const iloadItem = codeItems[r.iloadIdx];
    const ifItem = codeItems[r.ifIdx];
    // Delete the iload instruction.
    delete iloadItem.instruction;
    delete iloadItem.pc;
    if (r.ifKind === 'ifne') {
      // Always falls through; delete the conditional too.
      delete ifItem.instruction;
      delete ifItem.pc;
    } else {
      // ifeq: condition is always true, replace with unconditional goto.
      ifItem.instruction = { op: 'goto', arg: r.target };
    }
  }

  // Now both items may be empty (no instruction, no labelDef, no stackMapFrame).
  // Splice empties from the back.
  for (let k = codeItems.length - 1; k >= 0; k -= 1) {
    const it = codeItems[k];
    if (!it) { codeItems.splice(k, 1); continue; }
    if (!it.instruction && !it.labelDef && !it.stackMapFrame && !it.pc && !it.lineNumber) {
      codeItems.splice(k, 1);
    }
  }

  if (opts.verbose) {
    console.log(`  [dead-flag] ${opts.owner}.${opts.name}${opts.desc}: eliminated ${rewrites.length} dead conditional(s) from ${cleanLocals.size} clean local(s)`);
  }
  return rewrites.length;
}

function runDeadStaticBoolFlag(astRoot, options = {}) {
  const alwaysFalseFields = parseFieldList(options.flags);
  const verbose = !!options.verbose;
  const allowIntFlags = !!options.allowIntFlags;
  let totalEliminated = 0;
  let totalMethods = 0;
  let methodsAffected = 0;

  for (const classItem of astRoot.classes || []) {
    for (const item of classItem.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        if (!attr || attr.type !== 'code' || !attr.code) continue;
        totalMethods += 1;
        const eliminated = eliminateInMethod(attr.code, {
          alwaysFalseFields,
          allowIntFlags,
          verbose,
          owner: classItem.className,
          name: item.method.name,
          desc: item.method.descriptor,
        });
        if (eliminated > 0) {
          methodsAffected += 1;
          totalEliminated += eliminated;
        }
      }
    }
  }

  return {
    changed: totalEliminated > 0,
    eliminated: totalEliminated,
    methodsAffected,
    totalMethods,
  };
}

function discoverDeadStaticFlags(astRoot, options = {}) {
  const allowIntFlags = !!options.allowIntFlags;
  const candidates = collectZeroStaticFields(astRoot, { allowIntFlags });
  const writesByField = collectStaticWrites(astRoot, candidates);
  const deps = new Map();
  const rejected = new Set();

  for (const key of candidates.keys()) deps.set(key, new Set());

  for (const [key, writes] of writesByField) {
    for (const write of writes) {
      const guard = findNonZeroGuard(write.codeItems, write.index, candidates);
      if (!guard) {
        rejected.add(key);
        continue;
      }
      deps.get(key).add(guard);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, keyDeps] of deps) {
      if (rejected.has(key)) continue;
      for (const dep of keyDeps) {
        if (!deps.has(dep) || rejected.has(dep)) {
          rejected.add(key);
          changed = true;
          break;
        }
      }
    }
  }

  const consumerFields = collectSentinelConsumerFields(astRoot, candidates);
  const fields = [...candidates.keys()]
    .filter((key) => !rejected.has(key) && consumerFields.has(key))
    .sort();
  return { fields, rejected: [...rejected].sort(), dependencies: deps };
}

function collectZeroStaticFields(astRoot, opts) {
  const out = new Map();
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'field' || !item.field) continue;
      const field = item.field;
      if (!field.flags || !field.flags.includes('static')) continue;
      if (field.descriptor !== 'Z' && !(opts.allowIntFlags && field.descriptor === 'I')) continue;
      if (!isDefaultZeroValue(field.value)) continue;
      out.set(`${cls.className}.${field.name}`, {
        cls: cls.className,
        name: field.name,
        desc: field.descriptor,
      });
    }
  }
  return out;
}

function isDefaultZeroValue(value) {
  if (value == null) return true;
  if (value === false || value === 0 || value === '0') return true;
  if (typeof value === 'object' && (value.value === false || value.value === 0 || value.value === '0')) return true;
  return false;
}

function collectStaticWrites(astRoot, candidates) {
  const writes = new Map();
  for (const key of candidates.keys()) writes.set(key, []);
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        const codeItems = code && code.codeItems;
        if (!Array.isArray(codeItems)) continue;
        for (let i = 0; i < codeItems.length; i += 1) {
          const insn = codeItems[i] && codeItems[i].instruction;
          if (getOp(insn) !== 'putstatic') continue;
          const ref = fieldRefOf(getArg(insn));
          if (!ref) continue;
          const key = fieldKey(ref);
          if (!candidates.has(key)) continue;
          writes.get(key).push({
            codeItems,
            index: i,
            owner: cls.className,
            method: item.method.name,
            desc: item.method.descriptor,
          });
        }
      }
    }
  }
  return writes;
}

function collectSentinelConsumerFields(astRoot, candidates) {
  const out = new Set();
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        const codeItems = code && code.codeItems;
        if (!Array.isArray(codeItems)) continue;
        for (const key of findConsumedFieldsInMethod(codeItems, candidates)) {
          out.add(key);
        }
      }
    }
  }
  return out;
}

function findConsumedFieldsInMethod(codeItems, candidates) {
  const out = new Set();
  for (const key of candidates.keys()) {
    const { bindingDetails } = findEntryStoreSites(codeItems, new Set([key]), { allowIntFlags: true });
    for (const binding of bindingDetails) {
      if (hasFlatIloadBranchConsumer(codeItems, binding.local)) out.add(key);
    }
  }
  return out;
}

function hasFlatIloadBranchConsumer(codeItems, local) {
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const op = getOp(item.instruction);
    if (!ILOAD_OPS.has(op)) continue;
    if (localOf(op, getArg(item.instruction)) !== local) continue;
    let j = i + 1;
    while (j < codeItems.length && codeItems[j] && !codeItems[j].instruction && !codeItems[j].labelDef) j += 1;
    if (j >= codeItems.length) continue;
    if (codeItems[j] && codeItems[j].labelDef && !codeItems[j].instruction) continue;
    const nextOp = getOp(codeItems[j] && codeItems[j].instruction);
    if (nextOp === 'ifeq' || nextOp === 'ifne') return true;
  }
  return false;
}

function findNonZeroGuard(codeItems, writeIdx, candidates) {
  const labels = collectLabelIndices(codeItems);
  for (let i = writeIdx - 1; i >= 0; i -= 1) {
    const item = codeItems[i];
    const insn = item && item.instruction;
    if (!insn) continue;
    if (getOp(insn) !== 'ifeq') continue;
    const target = trimLabel(getArg(insn));
    const targetIdx = labels.get(target);
    if (targetIdx == null || targetIdx <= writeIdx) continue;
    const source = findPreviousStackSource(codeItems, i, candidates);
    if (source) return source;
  }
  return null;
}

function findPreviousStackSource(codeItems, ifIdx, candidates) {
  const prev = previousInstruction(codeItems, ifIdx);
  if (!prev) return null;
  const insn = prev.item.instruction;
  if (getOp(insn) === 'getstatic') {
    const ref = fieldRefOf(getArg(insn));
    if (ref && candidates.has(fieldKey(ref))) return fieldKey(ref);
    return null;
  }
  if (!ILOAD_OPS.has(getOp(insn))) return null;
  const local = localOf(getOp(insn), getArg(insn));
  if (local == null) return null;
  return localFieldBindingAt(codeItems, local, prev.index, candidates);
}

function localFieldBindingAt(codeItems, local, useIdx, candidates) {
  for (let i = useIdx - 1; i >= 0; i -= 1) {
    const item = codeItems[i];
    const insn = item && item.instruction;
    if (!insn) continue;
    const op = getOp(insn);
    if (op === 'iinc' && localOfIinc(getArg(insn)) === local) return null;
    if (!ISTORE_OPS.has(op)) continue;
    const storedLocal = localOf(op, getArg(insn));
    if (storedLocal !== local) continue;
    const prev = previousInstruction(codeItems, i);
    if (!prev || getOp(prev.item.instruction) !== 'getstatic') return null;
    const ref = fieldRefOf(getArg(prev.item.instruction));
    if (ref && candidates.has(fieldKey(ref))) return fieldKey(ref);
    return null;
  }
  return null;
}

function localOfIinc(arg) {
  if (arg && typeof arg === 'object' && typeof arg.local === 'number') return arg.local;
  if (typeof arg === 'string') {
    const m = /^(\d+)\b/.exec(arg);
    if (m) return parseInt(m[1], 10);
  }
  if (typeof arg === 'number') return arg;
  return null;
}

function previousInstruction(codeItems, idx) {
  for (let i = idx - 1; i >= 0; i -= 1) {
    const item = codeItems[i];
    if (item && item.instruction) return { item, index: i };
  }
  return null;
}

function collectLabelIndices(codeItems) {
  const labels = new Map();
  for (let i = 0; i < codeItems.length; i += 1) {
    const label = codeItems[i] && codeItems[i].labelDef;
    if (label) labels.set(trimLabel(label), i);
  }
  return labels;
}

module.exports = {
  runDeadStaticBoolFlag,
  discoverDeadStaticFlags,
  DEFAULT_ALWAYS_FALSE_FIELDS,
};
