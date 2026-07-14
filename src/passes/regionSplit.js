'use strict';

/**
 * regionSplit — controlled node splitting for irreducible loops.
 *
 * The single-block splitter (tailDuplicateJoin) removes an awkward *join*: it
 * clones one block for a redirected jump. That is enough for reducible-but-ugly
 * forward diamonds, but it cannot fix an *irreducible loop* — a loop entered at
 * more than one block. There the whole strongly-connected region has to be
 * duplicated so that each entry gets its own private copy that it alone enters;
 * the original then keeps a single entry and becomes reducible, which is what a
 * decompiler can actually structure. This is the classic controlled-node-
 * splitting transform (Janssen & Corporaal), specialised to "clone the entire
 * SCC once per secondary entry".
 *
 * Soundness is the same argument as block splitting, lifted to a region: every
 * clone block is byte-identical to its original; internal edges are rewired to
 * the matching clone block; edges that leave the region keep pointing at the
 * shared originals; and a secondary entry's *external* predecessors are the only
 * edges redirected into the clone. Any path that used to run
 * `p -> S -> ...region... -> exit` now runs `p -> S' -> ...clone... -> exit`
 * through byte-identical code with identical operand-stack states, so the
 * observable behaviour is unchanged. Only the CFG shape (multi-entry ->
 * single-entry) changes.
 *
 * Entry points:
 *   - listRegionSplitCandidates(astRoot): every method with a multi-entry SCC
 *     that can be split soundly (all-but-one entry reachable only by explicit
 *     jumps, region clear of exception ranges, region within a size cap).
 *   - applyRegionSplit(astRoot, {owner,name,desc,header}): clone the SCC whose
 *     primary entry is `header`, once per secondary entry.
 *
 * No names are hardcoded; every gate is shape-based. A driver confirms with the
 * fast irreducibility oracle (and ultimately CFR) that a split actually helps.
 */

const CONDITIONAL_JUMPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne',
  'ifnull', 'ifnonnull',
]);
const TERMINAL_OPCODES = new Set([
  'ret', 'return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'athrow',
]);

let _cloneSerial = 0;

function eachMethod(astRoot, fn) {
  for (const classItem of (astRoot.classes || [])) {
    for (const item of (classItem.items || [])) {
      if (!item || item.type !== 'method' || !item.method) continue;
      const codeAttr = (item.method.attributes || []).find((a) => a.type === 'code');
      if (!codeAttr || !codeAttr.code) continue;
      const codeItems = codeAttr.code.codeItems;
      if (!Array.isArray(codeItems) || codeItems.length === 0) continue;
      const exceptionTable = Array.isArray(codeAttr.code.exceptionTable) ? codeAttr.code.exceptionTable : [];
      fn({
        owner: classItem.className, name: item.method.name, desc: item.method.descriptor,
        codeItems, exceptionTable,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Block CFG over codeItems. Every instruction item carries its own offset
// labelDef (e.g. "L33:"); only *referenced* labels are true block boundaries.
// ---------------------------------------------------------------------------

/**
 * Split codeItems into basic blocks. Returns:
 *   blocks: [{ id, insns:[itemIdx...], entryLabel|null, headLabel, termOp,
 *              jumpTargets:[label...], succ:[blockId...] }]
 *   byLabel: Map(referenced entryLabel -> blockId)
 * entryLabel is the block's first instruction label iff it is referenced (only
 * then can a jump name the block); headLabel is always the first instruction's
 * offset label (always present, usable as a goto target once referenced).
 */
function buildBlocks(codeItems, referenced) {
  const insnIdx = [];
  for (let i = 0; i < codeItems.length; i++) {
    if (codeItems[i] && codeItems[i].instruction) insnIdx.push(i);
  }
  const n = insnIdx.length;
  if (n === 0) return null;

  const labelOf = (ii) => (codeItems[ii].labelDef ? trimLabel(codeItems[ii].labelDef) : null);
  const opOf = (ii) => getOp(codeItems[ii].instruction);

  // Leaders: first insn; any referenced-label insn; any insn after a block-ender.
  const isLeader = new Array(n).fill(false);
  isLeader[0] = true;
  for (let k = 0; k < n; k++) {
    const lbl = labelOf(insnIdx[k]);
    if (lbl && referenced.has(lbl)) isLeader[k] = true;
    const op = opOf(insnIdx[k]);
    if (isEnder(op) && k + 1 < n) isLeader[k + 1] = true;
  }

  const blocks = [];
  let cur = null;
  const kOfInsnIdx = new Map();
  for (let k = 0; k < n; k++) {
    if (isLeader[k]) {
      cur = { id: blocks.length, insns: [], termOp: null };
      blocks.push(cur);
    }
    cur.insns.push(insnIdx[k]);
    kOfInsnIdx.set(insnIdx[k], k);
  }

  const byLabel = new Map();
  for (const b of blocks) {
    const firstIi = b.insns[0];
    const firstLbl = labelOf(firstIi);
    b.headLabel = firstLbl;
    b.entryLabel = firstLbl && referenced.has(firstLbl) ? firstLbl : null;
    if (b.entryLabel) byLabel.set(b.entryLabel, b.id);
    const lastIi = b.insns[b.insns.length - 1];
    b.termOp = opOf(lastIi);
    b.lastInsnIdx = lastIi;
  }

  // Successor edges.
  for (const b of blocks) {
    b.succ = [];
    b.jumpTargets = [];
    const lastIi = b.insns[b.insns.length - 1];
    const insn = codeItems[lastIi].instruction;
    const op = b.termOp;
    const targets = targetsOf(insn, op);
    if (op === 'goto') {
      for (const t of targets) { pushSucc(b, byLabel.get(trimLabel(t))); b.jumpTargets.push(trimLabel(t)); }
    } else if (CONDITIONAL_JUMPS.has(op)) {
      for (const t of targets) { pushSucc(b, byLabel.get(trimLabel(t))); b.jumpTargets.push(trimLabel(t)); }
      pushSucc(b, b.id + 1 < blocks.length ? b.id + 1 : undefined); // fallthrough
      b.fallsThrough = true;
    } else if (op === 'tableswitch' || op === 'lookupswitch') {
      for (const t of targets) { pushSucc(b, byLabel.get(trimLabel(t))); b.jumpTargets.push(trimLabel(t)); }
    } else if (TERMINAL_OPCODES.has(op)) {
      // no successors
    } else {
      pushSucc(b, b.id + 1 < blocks.length ? b.id + 1 : undefined); // plain fallthrough
      b.fallsThrough = true;
    }
  }
  return { blocks, byLabel, codeItems };
}

function pushSucc(b, sid) { if (sid != null && !b.succ.includes(sid)) b.succ.push(sid); }

/** Predecessor lists (block ids) for a built CFG. */
function buildPreds(cfg) {
  const preds = cfg.blocks.map(() => []);
  for (const b of cfg.blocks) for (const s of b.succ) preds[s].push(b.id);
  return preds;
}

// ---------------------------------------------------------------------------
// SCCs (Tarjan, iterative). A nontrivial SCC (size > 1, or a self-looping
// single block) is a loop; a loop with >= 2 entry blocks is irreducible.
// ---------------------------------------------------------------------------

function tarjanSCC(cfg) {
  const N = cfg.blocks.length;
  const index = new Array(N).fill(-1);
  const low = new Array(N).fill(0);
  const onStack = new Array(N).fill(false);
  const stack = [];
  const sccOf = new Array(N).fill(-1);
  const sccs = [];
  let idx = 0;

  for (let s = 0; s < N; s++) {
    if (index[s] !== -1) continue;
    const work = [[s, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame[0];
      if (frame[1] === 0) { index[v] = low[v] = idx++; stack.push(v); onStack[v] = true; }
      let recurse = false;
      const succ = cfg.blocks[v].succ;
      while (frame[1] < succ.length) {
        const w = succ[frame[1]];
        if (index[w] === -1) { work.push([w, 0]); frame[1]++; recurse = true; break; }
        if (onStack[w] && index[w] < low[v]) low[v] = index[w];
        frame[1]++;
      }
      if (recurse) continue;
      if (low[v] === index[v]) {
        const comp = [];
        for (;;) { const w = stack.pop(); onStack[w] = false; sccOf[w] = sccs.length; comp.push(w); if (w === v) break; }
        sccs.push(comp);
      }
      work.pop();
      if (work.length) { const p = work[work.length - 1][0]; if (low[v] < low[p]) low[p] = low[v]; }
    }
  }
  return { sccs, sccOf };
}

/**
 * List every multi-entry SCC that can be split soundly. Entry = an SCC block
 * with a predecessor outside the SCC (block 0 counts as entered "from outside").
 * A secondary entry must be reachable only by explicit jumps (no external
 * fall-through), so its predecessors can be redirected into a clone. Regions
 * touching an exception range, or larger than the size cap, are refused.
 */
function listRegionSplitCandidates(astRoot, options = {}) {
  const maxRegionBlocks = Math.max(2, options.maxRegionBlocks || 60);
  const out = [];
  eachMethod(astRoot, (m) => {
    const cands = methodRegionCandidates(m, maxRegionBlocks);
    for (const c of cands) out.push({ owner: m.owner, name: m.name, desc: m.desc, ...c });
  });
  return out;
}

function methodRegionCandidates(m, maxRegionBlocks) {
  const protectedLabels = collectProtectedLabels(m.exceptionTable);
  const referenced = collectReferencedLabels(m.codeItems, protectedLabels);
  const cfg = buildBlocks(m.codeItems, referenced);
  if (!cfg) return [];
  const preds = buildPreds(cfg);
  const { sccs, sccOf } = tarjanSCC(cfg);
  const inTryItem = buildExceptionRangeTest(m.codeItems, m.exceptionTable);
  const out = [];

  for (const comp of sccs) {
    if (comp.length < 1) continue;
    const isLoop = comp.length > 1 || cfg.blocks[comp[0]].succ.includes(comp[0]);
    if (!isLoop) continue;
    if (comp.length > maxRegionBlocks) continue;
    const inScc = new Set(comp);

    // Region must be clear of exception ranges (clones append at method end,
    // outside all ranges, so a covered region would silently lose coverage).
    let touchesTry = false;
    for (const bid of comp) for (const ii of cfg.blocks[bid].insns) if (inTryItem(ii)) { touchesTry = true; break; }
    if (touchesTry) continue;

    // Classify entries.
    const entries = [];
    for (const bid of comp) {
      const externalPreds = preds[bid].filter((p) => !inScc.has(p));
      const isMethodEntry = bid === 0;
      if (externalPreds.length === 0 && !isMethodEntry) continue; // interior block
      const b = cfg.blocks[bid];
      // A predecessor is a redirectable jump iff it ends in goto/conditional
      // that names this block's entryLabel. A fall-through external pred (the
      // physically-preceding block flowing in) or method entry cannot be
      // redirected without reordering, so such an entry is "forced".
      let hasExternalFallthrough = isMethodEntry;
      for (const p of externalPreds) {
        const pb = cfg.blocks[p];
        const namesUs = b.entryLabel && pb.jumpTargets.includes(b.entryLabel);
        if (!namesUs) hasExternalFallthrough = true; // reaches us by fall-through
      }
      const redirectable = !hasExternalFallthrough && !!b.entryLabel && externalPreds.length > 0;
      entries.push({ bid, label: b.entryLabel, externalPreds: externalPreds.length, redirectable });
    }
    if (entries.length < 2) continue;

    const forced = entries.filter((e) => !e.redirectable);
    if (forced.length > 1) continue; // >1 non-redirectable entry: cannot split cleanly
    const primary = forced.length === 1
      ? forced[0]
      : entries.slice().sort((a, b) => b.externalPreds - a.externalPreds)[0];
    const secondaries = entries.filter((e) => e !== primary);
    if (secondaries.some((e) => !e.redirectable)) continue;
    if (secondaries.length === 0) continue;

    out.push({
      header: primary.label || cfg.blocks[primary.bid].headLabel,
      headerBid: primary.bid,
      secondaryLabels: secondaries.map((e) => e.label),
      regionBlocks: comp.length,
      entries: entries.length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apply.
// ---------------------------------------------------------------------------

function applyRegionSplit(astRoot, opts) {
  const maxRegionBlocks = Math.max(2, opts.maxRegionBlocks || 60);
  let clonedRegions = 0;
  eachMethod(astRoot, (m) => {
    if (m.owner !== opts.owner || m.name !== opts.name || m.desc !== opts.desc) return;
    const protectedLabels = collectProtectedLabels(m.exceptionTable);
    const referenced = collectReferencedLabels(m.codeItems, protectedLabels);
    const cfg = buildBlocks(m.codeItems, referenced);
    if (!cfg) return;
    const preds = buildPreds(cfg);
    const { sccs } = tarjanSCC(cfg);

    // Find the SCC whose chosen primary entry is opts.header.
    const target = methodRegionCandidates(m, maxRegionBlocks)
      .find((c) => c.header === opts.header);
    if (!target) return;
    const comp = sccs.find((s) => s.some((bid) => cfg.blocks[bid].headLabel === target.header || cfg.blocks[bid].entryLabel === target.header));
    if (!comp) return;
    const inScc = new Set(comp);

    // Labels of SCC blocks that are jump-nameable (referenced entry labels),
    // for rewriting internal jump targets.
    const sccEntryLabels = new Set();
    for (const bid of comp) if (cfg.blocks[bid].entryLabel) sccEntryLabels.add(cfg.blocks[bid].entryLabel);

    for (const secLabel of target.secondaryLabels) {
      const secBid = cfg.blocks.findIndex((b) => b.entryLabel === secLabel);
      if (secBid < 0) continue;

      // Fresh clone label per SCC block. The 8_000_000 base keeps region-split
      // labels disjoint from tailDuplicateJoin's 9xxxxx clone labels and from any
      // real offset label (method size < 65536), and the *1000 stride keeps the
      // per-secondary blocks (region <= maxRegionBlocks) from overlapping.
      _cloneSerial += 1;
      const base = 8000000 + _cloneSerial * 1000;
      const cloneLabelOfBid = new Map();
      comp.forEach((bid, k) => cloneLabelOfBid.set(bid, `L9${base + k}`));
      const cloneLabelForEntry = (lbl) => {
        const bid = cfg.byLabel.get(lbl);
        return bid != null && inScc.has(bid) ? cloneLabelOfBid.get(bid) : null;
      };

      // Emit the cloned region at method end.
      const appended = [];
      for (const bid of comp) {
        const b = cfg.blocks[bid];
        const cloneLbl = cloneLabelOfBid.get(bid);
        for (let j = 0; j < b.insns.length; j++) {
          const insn = deepCloneInstruction(m.codeItems[b.insns[j]].instruction);
          rewriteInternalTargets(insn, cloneLabelForEntry);
          const outItem = { instruction: insn };
          if (j === 0) outItem.labelDef = `${cloneLbl}:`;
          appended.push(outItem);
        }
        // Preserve fall-through / not-taken edges explicitly (clone order is
        // arbitrary, so nothing may be relied on to physically follow).
        if (b.fallsThrough) {
          const fallBid = bid + 1;
          const fallBlock = cfg.blocks[fallBid];
          if (fallBlock) {
            const dst = inScc.has(fallBid) ? cloneLabelOfBid.get(fallBid) : gotoTargetLabel(fallBlock, m.codeItems, referenced);
            appended.push({ instruction: { op: 'goto', arg: dst } });
          }
        }
      }

      // Redirect the secondary entry's EXTERNAL jump predecessors into the clone.
      const cloneEntry = cloneLabelOfBid.get(secBid);
      const sccItemIdx = new Set();
      for (const bid of comp) for (const ii of cfg.blocks[bid].insns) sccItemIdx.add(ii);
      let redirected = 0;
      for (let i = 0; i < m.codeItems.length; i++) {
        if (sccItemIdx.has(i)) continue; // internal edge: leave pointing at original
        const it = m.codeItems[i];
        if (!it || !it.instruction) continue;
        if (retargetJump(it.instruction, secLabel, cloneEntry)) redirected++;
      }
      if (redirected === 0) continue; // nothing external actually pointed in

      m.codeItems.push(...appended);
      clonedRegions++;
    }
  });
  return { changed: clonedRegions > 0, clonedRegions };
}

/** Rewrite a cloned instruction's jump/branch/switch targets: any target that
 * names an SCC block becomes that block's clone label; external targets keep
 * their original label (shared exits). */
function rewriteInternalTargets(insn, cloneLabelForEntry) {
  if (!insn || typeof insn !== 'object') return;
  const op = getOp(insn);
  if (op === 'goto' || op === 'jsr' || CONDITIONAL_JUMPS.has(op)) {
    if (typeof insn.arg === 'string') {
      const c = cloneLabelForEntry(trimLabel(insn.arg));
      if (c) insn.arg = c;
    }
  } else if (op === 'tableswitch') {
    if (Array.isArray(insn.labels)) insn.labels = insn.labels.map((l) => cloneLabelForEntry(trimLabel(l)) || l);
    if (typeof insn.defaultLbl === 'string') insn.defaultLbl = cloneLabelForEntry(trimLabel(insn.defaultLbl)) || insn.defaultLbl;
  } else if (op === 'lookupswitch' && insn.arg && typeof insn.arg === 'object') {
    for (const pair of (insn.arg.pairs || [])) {
      if (Array.isArray(pair) && typeof pair[1] === 'string') pair[1] = cloneLabelForEntry(trimLabel(pair[1])) || pair[1];
    }
    if (typeof insn.arg.defaultLabel === 'string') insn.arg.defaultLabel = cloneLabelForEntry(trimLabel(insn.arg.defaultLabel)) || insn.arg.defaultLabel;
  }
}

/** A label usable as an explicit goto target for a block: its referenced entry
 * label if it has one, else its first instruction's offset label (always
 * present in this AST, and preserved by the writer). */
function gotoTargetLabel(block, codeItems, referenced) {
  if (block.entryLabel) return block.entryLabel;
  return block.headLabel;
}

// ---------------------------------------------------------------------------
// Shared helpers (mirrors tailDuplicateJoin.js).
// ---------------------------------------------------------------------------

function isEnder(op) {
  return op === 'goto' || op === 'jsr' || op === 'tableswitch' || op === 'lookupswitch'
    || CONDITIONAL_JUMPS.has(op) || TERMINAL_OPCODES.has(op);
}

function targetsOf(insn, op) {
  if (op === 'goto' || op === 'jsr' || CONDITIONAL_JUMPS.has(op)) {
    return typeof insn.arg === 'string' ? [insn.arg] : [];
  }
  if (op === 'tableswitch') {
    const out = Array.isArray(insn.labels) ? insn.labels.slice() : [];
    if (typeof insn.defaultLbl === 'string') out.push(insn.defaultLbl);
    return out;
  }
  if (op === 'lookupswitch' && insn.arg && typeof insn.arg === 'object') {
    const out = [];
    for (const pair of (insn.arg.pairs || [])) if (Array.isArray(pair) && typeof pair[1] === 'string') out.push(pair[1]);
    if (typeof insn.arg.defaultLabel === 'string') out.push(insn.arg.defaultLabel);
    return out;
  }
  return [];
}

function buildExceptionRangeTest(codeItems, exceptionTable) {
  const ranges = [];
  for (const entry of exceptionTable || []) {
    const s = entry.startLbl || entry.startLabel || entry.start;
    const e = entry.endLbl || entry.endLabel || entry.end;
    if (typeof s !== 'string' || typeof e !== 'string') continue;
    const si = findLabelIndex(codeItems, trimLabel(s));
    const ei = findLabelIndex(codeItems, trimLabel(e));
    if (si >= 0 && ei >= 0) ranges.push([si, ei]);
  }
  if (ranges.length === 0) return () => false;
  return (idx) => ranges.some(([s, e]) => idx >= s && idx < e);
}

function collectProtectedLabels(exceptionTable) {
  const set = new Set();
  for (const entry of exceptionTable || []) {
    for (const key of ['startLbl', 'startLabel', 'start', 'endLbl', 'endLabel', 'end',
      'handlerLbl', 'handlerLabel', 'handler', 'usingLbl']) {
      const v = entry[key];
      if (typeof v === 'string') set.add(trimLabel(v));
    }
  }
  return set;
}

function collectReferencedLabels(codeItems, protectedLabels) {
  const set = new Set(protectedLabels);
  for (const item of codeItems) {
    if (!item || !item.instruction) continue;
    const insn = item.instruction;
    const op = getOp(insn);
    if (op === 'goto' || op === 'jsr' || CONDITIONAL_JUMPS.has(op)) {
      if (typeof insn.arg === 'string') set.add(trimLabel(insn.arg));
    } else if (op === 'tableswitch') {
      for (const l of (insn.labels || [])) set.add(trimLabel(l));
      if (typeof insn.defaultLbl === 'string') set.add(trimLabel(insn.defaultLbl));
    } else if (op === 'lookupswitch' && insn.arg && typeof insn.arg === 'object') {
      for (const pair of (insn.arg.pairs || [])) {
        if (Array.isArray(pair) && typeof pair[1] === 'string') set.add(trimLabel(pair[1]));
      }
      if (typeof insn.arg.defaultLabel === 'string') set.add(trimLabel(insn.arg.defaultLabel));
    }
  }
  return set;
}

function findLabelIndex(codeItems, label) {
  const trimmed = trimLabel(label);
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (item && item.labelDef && trimLabel(item.labelDef) === trimmed) return i;
  }
  return -1;
}

function retargetJump(instruction, fromLabel, toLabel) {
  if (!instruction || typeof instruction !== 'object') return false;
  const op = getOp(instruction);
  if (op !== 'goto' && !CONDITIONAL_JUMPS.has(op)) return false;
  if (typeof instruction.arg === 'string' && trimLabel(instruction.arg) === trimLabel(fromLabel)) {
    instruction.arg = toLabel;
    return true;
  }
  return false;
}

function deepCloneInstruction(instruction) {
  return JSON.parse(JSON.stringify(instruction, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value));
}

function getOp(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return instruction;
  return instruction.op || null;
}

function trimLabel(label) {
  if (typeof label !== 'string') return label;
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

module.exports = { listRegionSplitCandidates, applyRegionSplit };
