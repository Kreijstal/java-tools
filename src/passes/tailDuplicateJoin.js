'use strict';

/**
 * tailDuplicateJoin — generic node-splitting primitive for CFR-oracle-guided
 * goto elimination.
 *
 * A block that is reached by more than one control-flow edge is a "join".
 * When a join cannot be expressed structurally (an edge into the middle of a
 * loop, or a forward diamond with too many predecessors) CFR emits `** GOTO`
 * / "Unable to fully structure code". Node splitting removes the join by
 * cloning the block once per incoming `goto` edge and redirecting that edge to
 * its private copy — the fallthrough predecessor keeps the original. Because a
 * clone is byte-identical to its source and is entered by the very same jump
 * (same stack state), redirecting can never change semantics; it only changes
 * which structural shape the decompiler sees.
 *
 * This module exposes two entry points used by the greedy search driver:
 *   - listJoinCandidates(astRoot): every (method,label) whose block is a safe,
 *     cloneable join with at least one goto predecessor.
 *   - applyJoinSplit(astRoot, {owner,name,desc,label,perEdge}): clone the block
 *     at `label` for its goto predecessors.
 *
 * No names are hardcoded; every gate is shape-based. The driver decides which
 * candidates to keep by asking CFR whether markers dropped.
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

function listJoinCandidates(astRoot, options = {}) {
  const maxBodyInsns = Math.max(1, options.maxBodyInsns || 40);
  const out = [];
  eachMethod(astRoot, (m) => {
    const protectedLabels = collectProtectedLabels(m.exceptionTable);
    const referenced = collectReferencedLabels(m.codeItems, protectedLabels);
    const inTry = buildExceptionRangeTest(m.codeItems, m.exceptionTable);
    for (let i = 0; i < m.codeItems.length; i++) {
      const item = m.codeItems[i];
      if (!item || !item.labelDef) continue;
      const label = trimLabel(item.labelDef);
      if (protectedLabels.has(label)) continue;
      const block = extractBlock(m.codeItems, i, maxBodyInsns, referenced);
      if (!block) continue;
      // A block that needs a successor goto is cloned to method end, dropping it
      // out of every exception range — refuse if it sat inside a try. A
      // self-terminating block is cloned in place and keeps its coverage.
      if (block.successorLabel !== null && inTry(i)) continue;
      const jumpPreds = collectJumpPreds(m.codeItems, label);
      if (jumpPreds.length === 0) continue;
      const allPreds = countAllPreds(m.codeItems, label, i);
      const hasCondHead = block.instrItems.length > 0 && CONDITIONAL_JUMPS.has(getOp(block.instrItems[0].instruction));
      const hasCondPred = jumpPreds.some((p) => p.op !== 'goto');
      out.push({
        owner: m.owner, name: m.name, desc: m.desc, label,
        jumpPreds: jumpPreds.length, allPreds, hasCondHead, hasCondPred, bodyInsns: block.bodyInsns,
      });
    }
  });
  return out;
}

function applyJoinSplit(astRoot, opts) {
  const maxBodyInsns = Math.max(1, opts.maxBodyInsns || 40);
  let splits = 0;
  eachMethod(astRoot, (m) => {
    if (m.owner !== opts.owner || m.name !== opts.name || m.desc !== opts.desc) return;
    const protectedLabels = collectProtectedLabels(m.exceptionTable);
    const referenced = collectReferencedLabels(m.codeItems, protectedLabels);
    const inTry = buildExceptionRangeTest(m.codeItems, m.exceptionTable);
    const startIdx = findLabelIndex(m.codeItems, opts.label);
    if (startIdx < 0) return;
    // Snapshot jump predecessors (goto + conditional) before mutation.
    const preds = collectJumpPreds(m.codeItems, opts.label);
    if (preds.length === 0) return;
    for (const pred of preds) {
      const freshIdx = findLabelIndex(m.codeItems, opts.label);
      if (freshIdx < 0) break;
      const block = extractBlock(m.codeItems, freshIdx, maxBodyInsns, referenced);
      if (!block) break;
      const cloneInfo = buildClone(block);
      if (block.successorLabel === null) {
        // Self-terminating block (goto/return/throw): insert the clone in place,
        // right after the block's terminator. Nothing falls into it, and it
        // stays in whatever exception range the original block sat in, so its
        // exception coverage is preserved.
        m.codeItems.splice(block.endIdx + 1, 0, ...cloneInfo.items);
      } else {
        // Block ends by conditional/fall-through: the clone carries an appended
        // successor goto and must live where nothing falls into it — the method
        // end. That drops it out of every exception range, so refuse if the
        // original block was inside a try (cloning would change its coverage).
        if (inTry(freshIdx)) break;
        m.codeItems.push(...cloneInfo.items);
      }
      if (retargetJump(pred.item.instruction, opts.label, cloneInfo.entryLabel)) {
        splits += 1;
      }
    }
  });
  return { changed: splits > 0, splits };
}

/**
 * Extract the single basic block starting at the labelDef at startIdx — every
 * instruction from the entry up to (and including) the block's terminator,
 * whatever it is. A block ends at:
 *   - an unconditional terminator (goto / return / throw): included; the clone
 *     inherits it, so no successor edge needs synthesising.
 *   - a conditional jump: included; the clone must then `goto` the conditional's
 *     fall-through label so the not-taken edge still reaches the original
 *     successor (`successorLabel`).
 *   - the next *referenced* label (a foreign edge lands there, so the block
 *     falls through into it): NOT included; the clone must `goto` that label.
 * Refuses switches and jsr (successor rewiring is fiddly and rarely helps).
 *
 * This clones one basic block, not a region: the clone's out-edges point at the
 * original block's successors (shared), so it is pure node splitting regardless
 * of what those successors contain (nested ifs, loops, …). Correct by
 * construction; the CFR oracle decides whether it helps.
 */
function extractBlock(codeItems, startIdx, maxBodyInsns, referenced) {
  const start = codeItems[startIdx];
  if (!start || !start.labelDef) return null;

  const labelAtOrAfter = (idx) => {
    for (let k = idx; k < codeItems.length; k++) {
      if (codeItems[k] && codeItems[k].labelDef) return trimLabel(codeItems[k].labelDef);
    }
    return null;
  };

  const instrItems = [];
  let bodyInsns = 0;
  let lastInsnIdx = startIdx;
  for (let i = startIdx; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item) continue;
    // A referenced label past the entry is the block's fall-through boundary.
    if (i > startIdx && item.labelDef && referenced.has(trimLabel(item.labelDef))) {
      if (bodyInsns === 0) return null;
      return { instrItems, successorLabel: trimLabel(item.labelDef), bodyInsns, endIdx: lastInsnIdx };
    }
    if (!item.instruction) continue;
    const op = getOp(item.instruction);
    if (op === 'jsr' || op === 'tableswitch' || op === 'lookupswitch') return null;
    if (bodyInsns >= maxBodyInsns) return null;
    instrItems.push({ instruction: item.instruction });
    bodyInsns++;
    lastInsnIdx = i;
    if (op === 'goto' || TERMINAL_OPCODES.has(op)) {
      return { instrItems, successorLabel: null, bodyInsns, endIdx: i };
    }
    if (CONDITIONAL_JUMPS.has(op)) {
      const fall = labelAtOrAfter(i + 1);
      if (!fall) return null;
      return { instrItems, successorLabel: fall, bodyInsns, endIdx: i };
    }
  }
  return null;
}

function buildClone(block) {
  _cloneSerial += 1;
  const entryLabel = `L9${900000 + _cloneSerial}`;
  const items = [{ labelDef: `${entryLabel}:` }];
  for (const it of block.instrItems) {
    if (it && it.instruction) items.push({ instruction: deepCloneInstruction(it.instruction) });
  }
  // Preserve the block's fall-through / not-taken successor explicitly, since
  // the clone is appended at the method end and cannot rely on physical
  // fall-through. Blocks ending in goto/return/throw carry their own edge.
  if (block.successorLabel) {
    items.push({ instruction: { op: 'goto', arg: block.successorLabel } });
  }
  return { items, entryLabel };
}

/** Count every predecessor edge into `label`: all jumps/switch targets plus a
 * fallthrough from the preceding real instruction if it is not a terminator. */
function countAllPreds(codeItems, label, labelIdx) {
  const trimmed = trimLabel(label);
  let n = 0;
  for (const item of codeItems) {
    if (!item || !item.instruction) continue;
    const op = getOp(item.instruction);
    if (op === 'goto' || op === 'jsr' || CONDITIONAL_JUMPS.has(op)) {
      if (typeof item.instruction.arg === 'string' && trimLabel(item.instruction.arg) === trimmed) n++;
    } else if (op === 'tableswitch') {
      for (const l of (item.instruction.labels || [])) if (trimLabel(l) === trimmed) n++;
      if (typeof item.instruction.defaultLbl === 'string' && trimLabel(item.instruction.defaultLbl) === trimmed) n++;
    } else if (op === 'lookupswitch' && item.instruction.arg && typeof item.instruction.arg === 'object') {
      for (const pair of (item.instruction.arg.pairs || [])) {
        if (Array.isArray(pair) && typeof pair[1] === 'string' && trimLabel(pair[1]) === trimmed) n++;
      }
      if (typeof item.instruction.arg.defaultLabel === 'string' && trimLabel(item.instruction.arg.defaultLabel) === trimmed) n++;
    }
  }
  // fallthrough predecessor
  for (let i = labelIdx - 1; i >= 0; i--) {
    const item = codeItems[i];
    if (!item) continue;
    if (item.instruction) {
      const op = getOp(item.instruction);
      if (op !== 'goto' && op !== 'jsr' && op !== 'tableswitch' && op !== 'lookupswitch' && !TERMINAL_OPCODES.has(op)) n++;
      break;
    }
    if (item.labelDef) continue;
  }
  return n;
}

/** Predecessors that reach `label` via an explicit jump — an unconditional
 * `goto` or a conditional branch whose taken target is `label`. Both can be
 * redirected to a private clone (the conditional's fallthrough is untouched),
 * so both are splittable. Switch predecessors are excluded (redirecting one
 * case label is safe but rarely helps CFR and complicates arg rewriting). */
function collectJumpPreds(codeItems, label) {
  const trimmed = trimLabel(label);
  const out = [];
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const op = getOp(item.instruction);
    if (op !== 'goto' && !CONDITIONAL_JUMPS.has(op)) continue;
    if (typeof item.instruction.arg === 'string' && trimLabel(item.instruction.arg) === trimmed) {
      out.push({ item, idx: i, op });
    }
  }
  return out;
}

/**
 * Returns isInTry(idx): true if codeItems[idx] lies within any exception
 * table [start, end) range. Used to refuse cloning a block whose exception
 * coverage would be lost when the clone is appended outside all ranges.
 */
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

module.exports = { listJoinCandidates, applyJoinSplit };
