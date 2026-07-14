'use strict';

/**
 * loopGuardEntrySplit — de-join a loop whose guard test is entered from
 * outside the loop by an unconditional `goto` (the classic multi-entry-loop
 * obfuscation that CFR emits as `** GOTO` / "Unable to fully structure code").
 *
 * Shape targeted (starcannon k(byte), and similar):
 *
 *     Ltop:                      ← real loop header (backedge target)
 *        <recompute guard operands>
 *     Ltest:                     ← guard test, also jumped to from OUTSIDE
 *        if_icmpXX Lexit         ← taken → leave loop
 *        <body>                  ← not-taken → loop body (straight line)
 *        goto Ltop               ← backedge
 *     ...
 *     ; somewhere before the loop:
 *        <push guard operands>
 *        goto Ltest              ← EXTERNAL entry: jumps into the guard test
 *
 * CFR cannot structure a loop entered at its test from outside. The fix is
 * pure tail duplication: for each external `goto Ltest`, clone the guard
 * block `[if_icmpXX Lexit; body; goto Ltop]` and redirect the external goto
 * to its private copy. Redirecting a jump to a byte-identical copy of its
 * target can never change semantics, so this transform is always sound; it
 * only removes the join at Ltest so the loop becomes single-entry (Ltop is
 * then the sole header). Whether CFR benefits is decided downstream by the
 * marker oracle — this pass never asserts an improvement, it only exposes a
 * structurable shape.
 *
 * No class/method/game names are hardcoded; every gate is shape-based.
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

function runLoopGuardEntrySplit(astRoot, options = {}) {
  const maxBodyInsns = Math.max(1, options.maxBodyInsns || 48);
  const maxClonesPerMethod = Math.max(1, options.maxClonesPerMethod || 16);
  const verbose = !!options.verbose;

  let totalSplits = 0;
  for (const classItem of (astRoot.classes || [])) {
    for (const item of (classItem.items || [])) {
      if (!item || item.type !== 'method' || !item.method) continue;
      const codeAttr = (item.method.attributes || []).find((a) => a.type === 'code');
      if (!codeAttr || !codeAttr.code) continue;
      const codeItems = codeAttr.code.codeItems;
      if (!Array.isArray(codeItems) || codeItems.length === 0) continue;
      const exceptionTable = Array.isArray(codeAttr.code.exceptionTable) ? codeAttr.code.exceptionTable : [];
      const splits = normalizeMethod(codeItems, exceptionTable, {
        maxBodyInsns, maxClonesPerMethod, verbose,
        owner: classItem.className, name: item.method.name, desc: item.method.descriptor,
      });
      totalSplits += splits;
    }
  }
  return { changed: totalSplits > 0, splits: totalSplits };
}

function normalizeMethod(codeItems, exceptionTable, opts) {
  const { maxBodyInsns, maxClonesPerMethod, verbose, owner, name, desc } = opts;
  const protectedLabels = collectProtectedLabels(exceptionTable);
  // A label is a "real" boundary only when some jump/switch/exception edge
  // references it. This AST tags every instruction with an offset labelDef,
  // so unreferenced labels are noise and safe to clone through/drop.
  const referenced = collectReferencedLabels(codeItems, protectedLabels);

  // Snapshot candidate guard labels before mutating. Each guard label that
  // begins a conditional-headed loop-guard block and carries at least one
  // external `goto` entry is a candidate.
  const candidates = findGuardCandidates(codeItems, protectedLabels, referenced, maxBodyInsns);
  if (candidates.length === 0) return 0;

  let splits = 0;
  for (const cand of candidates) {
    if (splits >= maxClonesPerMethod) break;
    // Re-resolve everything: prior splices shifted indices.
    const testIdx = findLabelIndex(codeItems, cand.label);
    if (testIdx < 0) continue;
    const block = extractGuardBlock(codeItems, testIdx, maxBodyInsns, referenced);
    if (!block) continue;
    const topIdx = findLabelIndex(codeItems, block.backTarget);
    if (topIdx < 0 || topIdx >= testIdx) continue; // backedge target must precede the test

    // External entries: unconditional `goto <test>` whose source lies before
    // the loop top (i.e. outside the loop body). Gotos between topIdx and
    // testIdx are the loop's own internal pre-test merges — leave them.
    const externals = [];
    for (const j of collectGotosToLabel(codeItems, cand.label)) {
      if (j.idx < topIdx) externals.push(j);
    }
    if (externals.length === 0) continue;

    for (const ext of externals) {
      if (splits >= maxClonesPerMethod) break;
      // Insert the clone right after the block's terminating backedge goto,
      // which is unconditional, so nothing falls through into the clone.
      const freshTestIdx = findLabelIndex(codeItems, cand.label);
      const freshBlock = extractGuardBlock(codeItems, freshTestIdx, maxBodyInsns, referenced);
      if (!freshBlock) break;
      const cloneInfo = buildClone(freshBlock);
      codeItems.splice(freshBlock.endIdx + 1, 0, ...cloneInfo.items);
      // Redirect this external goto to the clone entry.
      if (retargetGoto(ext.item.instruction, cand.label, cloneInfo.entryLabel)) {
        splits += 1;
        if (verbose) {
          console.log(`  [guard-split] ${owner}.${name}${desc}: external entry -> clone of guard ${cand.label} (body=${freshBlock.bodyInsns} insns, backedge=${freshBlock.backTarget})`);
        }
      }
    }
  }
  return splits;
}

/**
 * A guard candidate is a labelDef whose block begins with a conditional jump
 * and whose not-taken fallthrough is a straight-line body ending in an
 * unconditional backedge `goto`, and which is targeted by at least one plain
 * `goto`. Returns [{label}].
 */
function findGuardCandidates(codeItems, protectedLabels, referenced, maxBodyInsns) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item || !item.labelDef) continue;
    const label = trimLabel(item.labelDef);
    if (seen.has(label)) continue;
    if (protectedLabels.has(label)) continue;
    const block = extractGuardBlock(codeItems, i, maxBodyInsns, referenced);
    if (!block) continue;
    // Must be a backedge (loop) and have an external goto entry.
    const topIdx = findLabelIndex(codeItems, block.backTarget);
    if (topIdx < 0 || topIdx >= i) continue;
    const gotos = collectGotosToLabel(codeItems, label);
    if (!gotos.some((j) => j.idx < topIdx)) continue;
    seen.add(label);
    out.push({ label });
  }
  return out;
}

/**
 * Extract the guard block starting at the labelDef at `startIdx`:
 *   [conditional jump] [straight-line body ...] [goto backTarget]
 * Returns { instrItems, backTarget, endIdx, bodyInsns } or null.
 *
 * Refuses (returns null) unless:
 *   - the first real instruction is a conditional jump,
 *   - every following real instruction up to the terminating goto is neither
 *     a conditional, switch, jsr, nor terminal (return/throw),
 *   - the block terminates in an unconditional `goto` within maxBodyInsns,
 *   - no labelDef other than the start appears inside the block (no foreign
 *     join lands in the middle — keeps the clone a self-contained straight
 *     line with no external inbound edges to preserve),
 *   - no instruction in the block is a protected (exception-table) label.
 */
function extractGuardBlock(codeItems, startIdx, maxBodyInsns, referenced) {
  const start = codeItems[startIdx];
  if (!start || !start.labelDef) return null;

  const instrItems = [];
  let bodyInsns = 0;
  let cond = null;

  // The start item carries the entry labelDef and (usually) the first
  // instruction. That first instruction must be the conditional.
  if (start.instruction) {
    const op = getOp(start.instruction);
    if (!CONDITIONAL_JUMPS.has(op)) return null;
    cond = start.instruction;
    instrItems.push({ instruction: start.instruction });
    bodyInsns++;
  }

  for (let i = startIdx + 1; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item) continue;
    // A *referenced* interior label means a foreign edge lands in the middle
    // of the block — cloning it would drop that inbound edge. Refuse. Bare
    // offset labels (unreferenced) are noise; clone through them.
    if (item.labelDef && bodyInsns > 0 && referenced.has(trimLabel(item.labelDef))) {
      return null;
    }
    if (!item.instruction) {
      if (!item.labelDef) instrItems.push(item);
      continue;
    }
    const op = getOp(item.instruction);
    if (!cond) {
      if (!CONDITIONAL_JUMPS.has(op)) return null;
      cond = item.instruction;
      instrItems.push(item);
      bodyInsns++;
      continue;
    }
    if (op === 'jsr' || op === 'tableswitch' || op === 'lookupswitch') return null;
    if (CONDITIONAL_JUMPS.has(op)) return null;
    if (TERMINAL_OPCODES.has(op)) return null;
    instrItems.push(item);
    bodyInsns++;
    if (bodyInsns > maxBodyInsns) return null;
    if (op === 'goto') {
      const backTarget = trimLabel(item.instruction.arg);
      if (typeof backTarget !== 'string') return null;
      return { instrItems, backTarget, endIdx: i, bodyInsns };
    }
  }
  return null;
}

/**
 * Build a byte-identical clone of the guard block with a fresh entry label.
 * The block is a self-contained straight line (guard extraction refuses any
 * internal labelDef), so only a new entry label is needed; every jump target
 * inside (the conditional's exit target and the trailing backedge) is
 * external and preserved as-is.
 */
function buildClone(block) {
  _cloneSerial += 1;
  const entryLabel = `L9${900000 + _cloneSerial}`;
  // Fresh standalone entry label, then instruction-only copies. The original
  // offset labelDefs are stripped (they are unreferenced — the referenced-label
  // gate guarantees it — so nothing points at them, and keeping them would
  // duplicate a label name). Only the conditional's exit target and the
  // trailing backedge remain as instruction args, both external and preserved.
  const items = [{ labelDef: `${entryLabel}:` }];
  for (const it of block.instrItems) {
    if (it && it.instruction) {
      items.push({ instruction: deepCloneInstruction(it.instruction) });
    }
  }
  return { items, entryLabel };
}

/**
 * All labels targeted by a jump/switch instruction or the exception table.
 * Everything else in `codeItems` is a bare offset label with no inbound edge.
 */
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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

function collectGotosToLabel(codeItems, label) {
  const trimmed = trimLabel(label);
  const out = [];
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    if (getOp(item.instruction) !== 'goto') continue;
    if (trimLabel(item.instruction.arg) === trimmed) out.push({ item, idx: i });
  }
  return out;
}

function findLabelIndex(codeItems, label) {
  const trimmed = trimLabel(label);
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (item && item.labelDef && trimLabel(item.labelDef) === trimmed) return i;
  }
  return -1;
}

function retargetGoto(instruction, fromLabel, toLabel) {
  if (!instruction || typeof instruction !== 'object') return false;
  if (getOp(instruction) !== 'goto') return false;
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

module.exports = { runLoopGuardEntrySplit };
