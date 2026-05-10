'use strict';

/**
 * MultiEntryLoopNormalizer — generic JS port of the ASM pass under tools/asm/.
 *
 * Targets the obfuscation pattern where a loop header label has multiple
 * incoming jumps: at least one forward edge (entry into the loop from outside)
 * and at least one backedge (jump from later in the method back to the header).
 * Decompilers like CFR emit `** GOTO` / "Unable to fully structure" on this
 * shape. The fix is to clone the header-block once per forward edge so the
 * loop has a single semantic entry while backedges keep targeting the
 * original header.
 *
 * Implementation operates on codeItems (Krakatau jasmin-style AST), like
 * conditionInverter.js: build a label/index map, classify incoming edges by
 * direction, clone instructions with fresh internal labels, redirect forward
 * jumps. No hardcoded names — purely shape-based.
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

const BLOCK_END_OPCODES = new Set([
  ...TERMINAL_OPCODES, 'goto', 'tableswitch', 'lookupswitch',
]);

function runMultiEntryLoopNormalizer(astRoot, options = {}) {
  const minIncoming = Math.max(2, options.minIncoming || 2);
  const maxCloneInsns = Math.max(1, options.maxCloneInsns || 64);
  const maxJoinCloneInsns = Math.max(1, options.maxJoinCloneInsns || 4);
  const joinSplit = options.joinSplit !== false;
  const verbose = !!options.verbose;

  let totalSplits = 0;
  let totalJoinSplits = 0;
  let totalMerges = 0;

  for (const classItem of (astRoot.classes || [])) {
    for (const item of (classItem.items || [])) {
      if (!item || item.type !== 'method' || !item.method) continue;
      const codeAttr = (item.method.attributes || []).find((a) => a.type === 'code');
      if (!codeAttr || !codeAttr.code) continue;
      const codeItems = codeAttr.code.codeItems;
      if (!Array.isArray(codeItems) || codeItems.length === 0) continue;

      const exceptionTable = Array.isArray(codeAttr.code.exceptionTable) ? codeAttr.code.exceptionTable : [];
      const result = normalizeMethod(codeItems, exceptionTable, {
        minIncoming, maxCloneInsns, maxJoinCloneInsns, joinSplit, verbose,
        owner: classItem.className, name: item.method.name, desc: item.method.descriptor,
      });
      const splits = result.splits;
      const joinSplits = result.joinSplits;
      totalSplits += splits;
      totalJoinSplits += joinSplits;
      if (splits > 0 || joinSplits > 0) {
        const merged = mergeAdjacentDuplicateBlocks(codeItems, exceptionTable);
        totalMerges += merged;
        // collapseLoopHeaderDuplicates is intentionally not invoked: the
        // duplicate header pattern is what CFR uses to structure the loop
        // for the well-behaved cases (qc/mn/le/etc). Collapsing it
        // regresses those classes back to multi-entry. Only ke-shape
        // classes benefit from collapsing, and we don't have a cheap
        // shape-only test to distinguish them yet.
      }
    }
  }

  return {
    changed: totalSplits > 0 || totalJoinSplits > 0,
    splits: totalSplits,
    joinSplits: totalJoinSplits,
    merges: totalMerges,
  };
}

// ---------------------------------------------------------------------------
// Per-method normalization
// ---------------------------------------------------------------------------

function normalizeMethod(codeItems, exceptionTable, opts) {
  const { minIncoming, maxCloneInsns, maxJoinCloneInsns, joinSplit, verbose, owner, name, desc } = opts;

  // Snapshot the incoming-jump map. We must collect candidates before mutating
  // anything, then walk them; each split shifts indexes so we re-resolve as needed.
  const incoming = collectIncomingJumps(codeItems);
  const handlerLabels = collectHandlerLabels(exceptionTable);
  const exceptionRangeLabels = collectExceptionRangeLabels(exceptionTable);

  const candidates = [];
  for (const [label, jumps] of incoming) {
    if (jumps.length < minIncoming) continue;
    if (handlerLabels.has(label)) continue;
    candidates.push({ label, jumps });
  }
  if (candidates.length === 0) {
    if (joinSplit) {
      const joinSplits = splitForwardOnlyJoins(codeItems, exceptionTable, {
        minIncoming, maxJoinCloneInsns, verbose, owner, name, desc,
        handlerLabels, exceptionRangeLabels,
      });
      return { splits: 0, joinSplits };
    }
    return { splits: 0, joinSplits: 0 };
  }

  let splits = 0;
  for (const cand of candidates) {
    // Re-resolve each loop iteration: prior splits may have moved labels.
    const targetIdx = findLabelIndex(codeItems, cand.label);
    if (targetIdx < 0) continue;

    const labelToIdx = buildLabelIndex(codeItems);
    const jumps = collectJumpsToLabel(codeItems, cand.label);

    // Classify forward vs backedge by source instruction position relative to target.
    const forward = [];
    const back = [];
    for (const j of jumps) {
      if (j.idx >= targetIdx) {
        back.push(j);
      } else {
        forward.push(j);
      }
    }
    if (back.length === 0 || forward.length === 0) continue;

    // Find the cloneable header block starting at the target label.
    const block = extractCloneableBlock(codeItems, targetIdx, maxCloneInsns);
    if (!block) continue;

    // Detect the "small guard header" risk pattern: body is small (≤5 real
    // instructions) ending in a conditional jump. In this shape, plain
    // cloning leaves CFR with two consecutive identical conditionals
    // (it emits `lbl-1000`). For these, we use a single rotated clone:
    // create ONE clone, redirect both forward edges AND backedges to it,
    // and replace the original block's duplicate body with a goto past
    // it so the original label becomes a thin shim that falls through
    // to whatever the conditional's natural fallthrough was.
    const realInsns = block.body.filter((it) => it && it.instruction);
    const lastReal = realInsns.length > 0 ? realInsns[realInsns.length - 1] : null;
    const lastOp = lastReal ? getOp(lastReal.instruction) : null;
    const isSmallGuard = false; // disabled — rotation path needs more validation

    let perCandidateSplits = 0;
    if (isSmallGuard) {
      // Single rotated clone: forward + backedge → clone, original body → goto.
      const fall = findFallthroughLabelAfter(codeItems, lastRealIndexInCodeItems(codeItems, targetIdx, realInsns.length));
      if (fall) {
        const cloneInfo = cloneBlock(codeItems, block);
        const insertAt = findLabelIndex(codeItems, cand.label);
        if (insertAt >= 0) {
          codeItems.splice(insertAt, 0, ...cloneInfo.items);
          // Replace original body's first realInsns.length instructions with `goto fall`.
          replaceFirstNRealWithGoto(codeItems, findLabelIndex(codeItems, cand.label), realInsns.length, fall);
          // Redirect every incoming jump (forward + backedge) to the clone entry.
          for (const j of [...forward, ...back]) {
            retargetJump(j.item.instruction, cand.label, cloneInfo.entryLabel);
          }
          perCandidateSplits = forward.length + back.length;
          if (verbose) {
            console.log(`  [rotate] ${owner}.${name}${desc}: small-guard rotation at ${cand.label} (body=${realInsns.length} insns, fall=${fall})`);
          }
        }
      }
    }
    if (perCandidateSplits === 0) {
      // Standard clone-and-redirect-forward approach (unchanged).
      for (const fwd of forward) {
        const cloneInfo = cloneBlock(codeItems, block);
        const insertAt = findLabelIndex(codeItems, cand.label);
        if (insertAt < 0) break;
        codeItems.splice(insertAt, 0, ...cloneInfo.items);

        const refIdx = codeItems.indexOf(fwd.item);
        if (refIdx < 0) continue;
        retargetJump(fwd.item.instruction, cand.label, cloneInfo.entryLabel);
        perCandidateSplits++;
      }
    }

    if (perCandidateSplits > 0) {
      splits += perCandidateSplits;
      if (verbose) {
        const bodyRealCount = block.body.filter((it) => it && it.instruction).length;
        const lastOp = (() => {
          for (let i = block.body.length - 1; i >= 0; i--) {
            const it = block.body[i];
            if (it && it.instruction) return getOp(it.instruction);
          }
          return '?';
        })();
        console.log(`  [split] ${owner}.${name}${desc}: ${perCandidateSplits} edges redirected, ${back.length} backedges preserved (label=${cand.label} bodyInsns=${bodyRealCount} lastOp=${lastOp})`);
      }
    }
  }

  let joinSplits = 0;
  if (joinSplit) {
    joinSplits = splitForwardOnlyJoins(codeItems, exceptionTable, {
      minIncoming, maxJoinCloneInsns, verbose, owner, name, desc,
      handlerLabels, exceptionRangeLabels,
    });
  }

  return { splits, joinSplits };
}

// ---------------------------------------------------------------------------
// Forward-only join splitting (tail duplication of fallthrough joins).
// Inspired by JoinBlockSplitter.splitFallthroughJoins in asm-tools/.
//
// Targets the dominant marker pattern: a CONDITIONAL forward jump whose
// target label ALSO has a fallthrough predecessor (i.e., the prior
// instruction in source order is not a terminator/goto and just falls
// through into this label). That's the canonical CFG diamond. We clone the
// target's body, place the clone elsewhere, and redirect just THAT
// conditional jump to its own private clone — the fallthrough path is
// unaffected. Net effect: the join at the target label is broken.
//
// Critically, this is NOT "tail-duplicate all forward predecessors": that
// approach pushes joins one level downstream and explodes marker counts.
// Cloning per-conditional-jump for fallthrough-joined targets is much
// narrower and matches what CFR can productively re-structure.
// ---------------------------------------------------------------------------

function splitForwardOnlyJoins(codeItems, exceptionTable, opts) {
  const {
    maxJoinCloneInsns, verbose, owner, name, desc,
    handlerLabels, exceptionRangeLabels,
  } = opts;

  // Snapshot conditional jumps before mutation.
  const condJumps = [];
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const op = getOp(item.instruction);
    if (!CONDITIONAL_JUMPS.has(op)) continue;
    if (typeof item.instruction.arg !== 'string') continue;
    condJumps.push({ item, op });
  }

  // Process each target label at most once: the first conditional jump
  // wins. Splitting the same target multiple times creates a fan of
  // duplicated bodies that CFR can't structure.
  const splitTargets = new Set();

  let joinSplits = 0;
  for (const cj of condJumps) {
    // Re-resolve indices each time; prior splices may have shifted things.
    const jumpIdx = codeItems.indexOf(cj.item);
    if (jumpIdx < 0) continue;
    const target = trimLabel(cj.item.instruction.arg);
    if (handlerLabels.has(target)) continue;
    if (exceptionRangeLabels.has(target)) continue;
    if (target.startsWith('_meln_')) continue;
    if (splitTargets.has(target)) continue;

    const targetIdx = findLabelIndex(codeItems, target);
    if (targetIdx <= jumpIdx) continue; // not forward

    // Require the target to have ≥2 forward predecessors total — either a
    // fallthrough plus this conditional, or this conditional plus another
    // forward jump.  Pure single-predecessor labels aren't joins.
    const hasFt = hasFallthroughPredecessor(codeItems, targetIdx);
    const allJumps = collectJumpsToLabel(codeItems, target);
    let forwardJumpCount = 0;
    let hasBack = false;
    for (const j of allJumps) {
      if (j.idx >= targetIdx) { hasBack = true; break; }
      forwardJumpCount++;
    }
    if (hasBack) continue;
    const totalPreds = forwardJumpCount + (hasFt ? 1 : 0);
    if (totalPreds < 2) continue;

    // Extract a cloneable body. The existing extractor refuses conditionals
    // and switches in the body and respects the cap.
    const block = extractCloneableBlock(codeItems, targetIdx, maxJoinCloneInsns);
    if (!block) continue;
    const realInsns = block.body.filter((it) => it && it.instruction);
    if (realInsns.length === 0) continue;
    if (realInsns.length > maxJoinCloneInsns) continue;

    // Body must end in a true terminator (goto/return/throw). Cloning
    // fallthrough-ended bodies tends to inflate CFR markers because the
    // duplicated trailing block creates new join structure CFR can't
    // recover. Only terminator bodies are conservative enough for the
    // generic pass.
    if (block.fallthroughLabel) continue;



    // Build clone, redirect just this conditional jump's target.
    const cloneInfo = cloneBlock(codeItems, block);
    // Insert at the target's "end" — the next labelDef after the target's
    // body. The clone (when its body falls through) already terminates with
    // a `goto fallthroughLabel`, so it's self-contained.  However, the
    // instruction immediately before the insertion point may itself fall
    // through into the clone.  Guard against that: if the prior real
    // instruction at insertAt is NOT a terminator / unconditional jump,
    // insert a guard `goto endLabel` before the clone so prior code skips
    // past the clone to its natural target.
    const endLabel = block.fallthroughLabel;
    let insertAt;
    if (endLabel) {
      insertAt = findLabelIndex(codeItems, endLabel);
    }
    if (insertAt == null || insertAt < 0) {
      insertAt = codeItems.length;
    }
    if (priorFallsThrough(codeItems, insertAt) && endLabel) {
      codeItems.splice(insertAt, 0, { instruction: { op: 'goto', arg: endLabel } });
      insertAt += 1;
    }
    codeItems.splice(insertAt, 0, ...cloneInfo.items);
    retargetJump(cj.item.instruction, target, cloneInfo.entryLabel);
    splitTargets.add(target);
    joinSplits += 1;
    if (verbose) {
      const lastOp = (() => {
        for (let i = block.body.length - 1; i >= 0; i--) {
          const it = block.body[i];
          if (it && it.instruction) return getOp(it.instruction);
        }
        return '?';
      })();
      console.log(`  [join-split] ${owner}.${name}${desc}: ${cj.op} forward edge cloned out of fallthrough join (label=${target} bodyInsns=${realInsns.length} lastOp=${lastOp})`);
    }
  }

  return joinSplits;
}

/**
 * Returns true iff the instruction immediately preceding `idx` (skipping
 * labels/aux items) is a non-terminator that would fall through into idx.
 * Used to decide whether a guard `goto` must be inserted before a clone
 * spliced at idx so prior code doesn't fall into the clone's body.
 */
function priorFallsThrough(codeItems, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    const item = codeItems[i];
    if (!item) continue;
    if (item.instruction) {
      const op = getOp(item.instruction);
      if (op === 'goto' || op === 'jsr') return false;
      if (TERMINAL_OPCODES.has(op)) return false;
      // Switches always end a block; control transfers via cases/default.
      if (op === 'tableswitch' || op === 'lookupswitch') return false;
      return true;
    }
    // labelDef or aux: keep scanning backwards.
  }
  return false;
}

/**
 * Returns true iff the closest preceding real instruction (before the
 * labelDef at `targetIdx`) is a non-terminator that would naturally fall
 * through into this label.  Anchors the "fallthrough join" predicate.
 */
function hasFallthroughPredecessor(codeItems, targetIdx) {
  for (let i = targetIdx - 1; i >= 0; i--) {
    const item = codeItems[i];
    if (!item) continue;
    if (item.instruction) {
      const op = getOp(item.instruction);
      if (op === 'goto' || op === 'jsr') return false;
      if (TERMINAL_OPCODES.has(op)) return false;
      if (op === 'tableswitch' || op === 'lookupswitch') return false;
      return true;
    }
    // labelDef or aux item: keep scanning backwards.
  }
  return false;
}

/**
 * Collect every label name referenced by the exception table, including
 * start/end range markers (in addition to handler entries which are
 * already protected separately). Splitting these would change the scope of
 * try-blocks and is unsafe.
 */
function collectExceptionRangeLabels(exceptionTable) {
  const set = new Set();
  for (const entry of exceptionTable || []) {
    for (const key of ['startLbl', 'startLabel', 'start', 'endLbl', 'endLabel', 'end']) {
      const v = entry[key];
      if (typeof v === 'string') set.add(trimLabel(v));
    }
  }
  return set;
}

// ---------------------------------------------------------------------------
// CFG-ish helpers (operate on codeItems, no ast-to-cfg dependency)
// ---------------------------------------------------------------------------

/** Map<label, [{item, idx}, ...]> for every direct jump (incl. switch). */
function collectIncomingJumps(codeItems) {
  const map = new Map();
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const op = getOp(item.instruction);
    if (!op) continue;
    const targets = getJumpTargets(item.instruction, op);
    for (const t of targets) {
      const trimmed = trimLabel(t);
      if (!map.has(trimmed)) map.set(trimmed, []);
      map.get(trimmed).push({ item, idx: i });
    }
  }
  return map;
}

function collectJumpsToLabel(codeItems, label) {
  const trimmed = trimLabel(label);
  const out = [];
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const op = getOp(item.instruction);
    if (!op) continue;
    const targets = getJumpTargets(item.instruction, op);
    if (targets.some((t) => trimLabel(t) === trimmed)) {
      out.push({ item, idx: i });
    }
  }
  return out;
}

function collectHandlerLabels(exceptionTable) {
  const set = new Set();
  for (const entry of exceptionTable || []) {
    const handler = entry.handlerLbl || entry.handlerLabel || entry.handler || entry.usingLbl;
    if (typeof handler === 'string') set.add(trimLabel(handler));
  }
  return set;
}

function buildLabelIndex(codeItems) {
  const map = new Map();
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (item && item.labelDef) map.set(trimLabel(item.labelDef), i);
  }
  return map;
}

function findLabelIndex(codeItems, label) {
  const trimmed = trimLabel(label);
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (item && item.labelDef && trimLabel(item.labelDef) === trimmed) return i;
  }
  return -1;
}

/**
 * Return the codeItems index of the Nth real instruction after the labelDef
 * at `labelIdx`. Used to anchor "the position right after the body" for the
 * small-guard rotation path.
 */
function lastRealIndexInCodeItems(codeItems, labelIdx, n) {
  let count = 0;
  for (let i = labelIdx + 1; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item) continue;
    if (item.labelDef) break;
    if (item.instruction) {
      count++;
      if (count === n) return i;
    }
  }
  return -1;
}

/**
 * Replace the first `n` real instructions starting after the labelDef at
 * `labelIdx` with a single `goto <gotoTarget>` instruction. Removes
 * interleaved auxiliary items (line numbers, stack maps) too.
 */
function replaceFirstNRealWithGoto(codeItems, labelIdx, n, gotoTarget) {
  if (labelIdx < 0) return;
  let removed = 0;
  let i = labelIdx + 1;
  while (i < codeItems.length && removed < n) {
    const item = codeItems[i];
    if (!item) { i++; continue; }
    if (item.labelDef) break;
    if (item.instruction) {
      codeItems.splice(i, 1);
      removed++;
      continue;
    }
    codeItems.splice(i, 1);
  }
  // Insert the replacement goto at the same position.
  codeItems.splice(labelIdx + 1, 0, { instruction: { op: 'goto', arg: gotoTarget } });
}

/**
 * Find the label of the next real instruction after position `idx` (inclusive
 * search starts at idx+1). If the next real instruction has a labelDef on it,
 * return that label name; if there's a separate labelDef item just before it,
 * return that. Returns null if we hit method end without finding a label.
 *
 * Caller treats this as the "where does this conditional fall through to"
 * signal — used by extractCloneableBlock to compute the goto target the
 * clone should append, so the clone doesn't fall into the duplicate
 * original block.
 */
function findFallthroughLabelAfter(codeItems, idx) {
  for (let i = idx + 1; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item) continue;
    if (item.labelDef) return trimLabel(item.labelDef);
    if (item.instruction) {
      // Real instruction with no preceding label — we'd need to insert one
      // to be safe. For now, return null and skip the split rather than
      // mutate the original codeItems mid-extraction.
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block extraction & cloning
// ---------------------------------------------------------------------------

/**
 * Extract a cloneable header block starting at the label at `startIdx`.
 * Stops at:
 *   - first conditional jump (header-only mode, like the ASM pass default)
 *   - terminal/throw/return
 *   - next labelDef (after the start) that isn't part of this block
 *   - tableswitch/lookupswitch (refuse to clone — too invasive)
 *   - JSR (refuse — legacy)
 * Returns null if not cloneable. The block excludes the entry label itself
 * (we generate a new one when cloning).
 */
function extractCloneableBlock(codeItems, startIdx, maxInsns) {
  const startItem = codeItems[startIdx];
  if (!startItem || !startItem.labelDef) return null;

  const body = [];
  let realCount = 0;

  // Krakatau combines the entry labelDef and the entry's first instruction
  // on a single AST item. Include that instruction in the body so the clone
  // is stack-balanced — strip the labelDef on the cloned copy (the clone
  // gets a fresh entry label).
  //
  // When the cloneable body ends with a CONDITIONAL jump, the clone MUST NOT
  // fall through to the original target's body (the original's first
  // instruction is the same as the clone's last instruction — a duplicate
  // conditional with stale stack state would crash the verifier). Find the
  // label of the instruction immediately after the conditional in the
  // original codeItems and route the clone there via an explicit goto.
  // For terminal/goto-ending bodies, no fallthrough is needed (the clone
  // never falls through). For body ending at a label boundary (no conditional),
  // fallthroughLabel is set to that label so the clone goes there.
  // Conservative: refuse to clone any body that would end in a conditional
  // jump. The clone-then-fallthrough pattern with a duplicate conditional
  // creates either invalid bytecode (no goto: stack diverges at the merge)
  // or excessive CFR markers (with goto: CFR can't structure two
  // back-to-back identical conditionals). Until we have a generic loop
  // rotation, just skip these candidates — the pass still helps for
  // bodies that end at a label boundary or at goto/return/throw.
  if (startItem.instruction) {
    const startOp = getOp(startItem.instruction);
    if (startOp === 'jsr') return null;
    if (startOp === 'tableswitch' || startOp === 'lookupswitch') return null;
    if (CONDITIONAL_JUMPS.has(startOp)) return null;
    body.push({ instruction: startItem.instruction });
    realCount++;
    if (TERMINAL_OPCODES.has(startOp) || startOp === 'goto') {
      return { startIdx, body, fallthroughLabel: null };
    }
  }

  for (let i = startIdx + 1; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item) continue;
    if (item.labelDef && body.length > 0) {
      // External jump-target label past the start = block boundary, stop here.
      return { startIdx, body, fallthroughLabel: trimLabel(item.labelDef) };
    }
    if (item.instruction) {
      const op = getOp(item.instruction);
      if (op === 'jsr') return null;
      if (op === 'tableswitch' || op === 'lookupswitch') return null;
      if (CONDITIONAL_JUMPS.has(op)) return null;
      body.push(item);
      realCount++;
      if (realCount > maxInsns) return null;
      if (TERMINAL_OPCODES.has(op) || op === 'goto') {
        return { startIdx, body, fallthroughLabel: null };
      }
      continue;
    }
    body.push(item);
  }
  if (body.length === 0) return null;
  return { startIdx, body, fallthroughLabel: null };
}

/**
 * Build a clone of `block`'s body with a fresh entry label and fresh names
 * for any *internal* labelDefs. External jump targets (anything not defined
 * in the block body) are preserved as-is.
 *
 * Returns:
 *   { items: AST nodes to splice in (entry label + cloned body), entryLabel: string }
 */
let _cloneSerial = 0;
function cloneBlock(codeItems, block) {
  _cloneSerial += 1;
  const tag = `_meln_${_cloneSerial}`;
  const entryLabel = `${tag}_entry`;

  // Determine which labels are *internal* to the body
  const internal = new Set();
  for (const it of block.body) {
    if (it && it.labelDef) internal.add(trimLabel(it.labelDef));
  }

  const renameMap = new Map();
  for (const ll of internal) renameMap.set(ll, `${tag}_${ll}`);

  const out = [];
  // Entry label for the clone
  out.push({ labelDef: `${entryLabel}:` });

  for (const it of block.body) {
    if (!it) continue;
    if (it.labelDef) {
      const orig = trimLabel(it.labelDef);
      out.push({ labelDef: `${renameMap.get(orig)}:` });
      continue;
    }
    if (it.instruction) {
      const cloned = deepCloneItem(it);
      remapInstructionLabels(cloned.instruction, renameMap);
      out.push(cloned);
      continue;
    }
    // Skip stackMapFrame entries — they'll be wrong post-clone anyway and
    // most class files in obfuscated jars don't carry valid frames already.
    // (peephole-clean already loosens these.)
  }

  // If the original block falls through (body ended at a label boundary,
  // not at a conditional/terminal/goto), append an explicit goto so the
  // clone preserves the original control-flow target instead of falling
  // into the original target label's body.
  if (block.fallthroughLabel) {
    out.push({ instruction: { op: 'goto', arg: block.fallthroughLabel } });
  }

  return { items: out, entryLabel };
}

function deepCloneItem(item) {
  return JSON.parse(JSON.stringify(item, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value));
}

function remapInstructionLabels(instruction, renameMap) {
  if (!instruction || typeof instruction !== 'object') return;
  // Direct string-arg jumps (goto/if*)
  if (typeof instruction.arg === 'string') {
    const trimmed = trimLabel(instruction.arg);
    if (renameMap.has(trimmed)) {
      instruction.arg = renameMap.get(trimmed);
    }
  } else if (instruction.arg && typeof instruction.arg === 'object') {
    // lookupswitch: { pairs: [[k, label], ...], defaultLabel }
    if (Array.isArray(instruction.arg.pairs)) {
      for (const pair of instruction.arg.pairs) {
        if (Array.isArray(pair) && typeof pair[1] === 'string') {
          const t = trimLabel(pair[1]);
          if (renameMap.has(t)) pair[1] = renameMap.get(t);
        }
      }
    }
    if (typeof instruction.arg.defaultLabel === 'string') {
      const t = trimLabel(instruction.arg.defaultLabel);
      if (renameMap.has(t)) instruction.arg.defaultLabel = renameMap.get(t);
    }
  }
  // tableswitch: { labels: [...], defaultLbl }
  if (Array.isArray(instruction.labels)) {
    for (let i = 0; i < instruction.labels.length; i++) {
      const t = trimLabel(instruction.labels[i]);
      if (renameMap.has(t)) instruction.labels[i] = renameMap.get(t);
    }
  }
  if (typeof instruction.defaultLbl === 'string') {
    const t = trimLabel(instruction.defaultLbl);
    if (renameMap.has(t)) instruction.defaultLbl = renameMap.get(t);
  }
}

function retargetJump(instruction, fromLabel, toLabel) {
  if (!instruction || typeof instruction !== 'object') return;
  const fromTrim = trimLabel(fromLabel);
  if (typeof instruction.arg === 'string' && trimLabel(instruction.arg) === fromTrim) {
    instruction.arg = toLabel;
    return;
  }
  if (instruction.arg && typeof instruction.arg === 'object') {
    if (Array.isArray(instruction.arg.pairs)) {
      for (const pair of instruction.arg.pairs) {
        if (Array.isArray(pair) && typeof pair[1] === 'string' && trimLabel(pair[1]) === fromTrim) {
          pair[1] = toLabel;
        }
      }
    }
    if (typeof instruction.arg.defaultLabel === 'string' && trimLabel(instruction.arg.defaultLabel) === fromTrim) {
      instruction.arg.defaultLabel = toLabel;
    }
  }
  if (Array.isArray(instruction.labels)) {
    for (let i = 0; i < instruction.labels.length; i++) {
      if (trimLabel(instruction.labels[i]) === fromTrim) instruction.labels[i] = toLabel;
    }
  }
  if (typeof instruction.defaultLbl === 'string' && trimLabel(instruction.defaultLbl) === fromTrim) {
    instruction.defaultLbl = toLabel;
  }
}

// ---------------------------------------------------------------------------
// Phase 3: merge adjacent duplicate blocks left over from cloning
// ---------------------------------------------------------------------------

/**
 * After cloning, two adjacent labels often start identical instruction
 * sequences with the same outgoing jump targets. CFR reads consecutive
 * conditionals-to-the-same-place as "** GOTO" / "lbl-1000". Collapse them.
 *
 * Skip protected labels: exception-handler entries, and labels that are
 * jumped to by a backedge (loop headers — those splits are intentional).
 */
function mergeAdjacentDuplicateBlocks(codeItems, exceptionTable) {
  // Collect labels in source order
  const labels = [];
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (item && item.labelDef) labels.push({ idx: i, name: trimLabel(item.labelDef) });
  }
  if (labels.length < 2) return 0;

  const handlerLabels = collectHandlerLabels(exceptionTable || []);

  // Compute which labels are backedge targets — protect them.
  const protectedLabels = new Set(handlerLabels);
  const incoming = collectIncomingJumps(codeItems);
  for (const [name, jumps] of incoming) {
    const tgtIdx = findLabelIndex(codeItems, name);
    if (tgtIdx < 0) continue;
    for (const j of jumps) {
      if (j.idx >= tgtIdx) {
        protectedLabels.add(name);
        break;
      }
    }
  }

  const replacementMap = new Map(); // dropped → kept
  for (let i = 0; i < labels.length - 1; i++) {
    const a = labels[i];
    const b = labels[i + 1];
    if (replacementMap.has(a.name) || replacementMap.has(b.name)) continue;
    if (protectedLabels.has(a.name) || protectedLabels.has(b.name)) continue;
    // Only merge when at least one label was created by this pass — we don't
    // want to collapse pre-existing aliases that may carry semantics we
    // can't see (debug info, stack maps, line numbers).
    if (!a.name.startsWith('_meln_') && !b.name.startsWith('_meln_')) continue;
    const bodyA = blockBody(codeItems, a.idx);
    if (bodyA.length === 0) continue; // refuse trivial empty-body matches
    const bodyB = blockBody(codeItems, b.idx);
    if (bodyA.length !== bodyB.length) continue;
    let same = true;
    for (let k = 0; k < bodyA.length; k++) {
      if (!sameInstruction(bodyA[k], bodyB[k])) { same = false; break; }
    }
    if (!same) continue;
    // Prefer keeping the non-cloned label so external references stay valid.
    if (a.name.startsWith('_meln_') && !b.name.startsWith('_meln_')) {
      replacementMap.set(a.name, b.name);
    } else {
      replacementMap.set(b.name, a.name);
    }
  }

  if (replacementMap.size === 0) return 0;

  // Redirect all jump targets that point to a dropped label.
  for (const item of codeItems) {
    if (!item || !item.instruction) continue;
    rewriteJumpTargets(item.instruction, replacementMap);
  }
  // Redirect exception-table targets too (handlers are protected, so this is
  // mostly a no-op, but start/end ranges may reference dropped labels).
  for (const e of exceptionTable || []) {
    rewriteExceptionEntry(e, replacementMap);
  }

  // Splice out the dropped label-defs (only if they have no instruction in the
  // same item — otherwise we'd lose code). Krakatau usually keeps labelDef
  // and instruction in separate codeItems, so this is the common case.
  for (let i = codeItems.length - 1; i >= 0; i--) {
    const item = codeItems[i];
    if (!item || !item.labelDef) continue;
    const name = trimLabel(item.labelDef);
    if (!replacementMap.has(name)) continue;
    if (item.instruction) {
      // Keep the instruction; just drop the labelDef.
      delete item.labelDef;
    } else {
      codeItems.splice(i, 1);
    }
  }

  return replacementMap.size;
}

/**
 * Smart-merge for the loop-header duplicate pattern that mergeAdjacentDuplicateBlocks
 * intentionally skips (backedge target = protected). Targets the case:
 *
 *   _meln_X_entry:                  ← clone we just created (forward entry)
 *     <body>                        ← exact duplicate of original
 *   L<N>:                           ← original target, also a backedge target
 *     <body>                        ← duplicate
 *     ... rest of method ...
 *
 * Resolution: delete the original's duplicate body and redirect all
 * backedges from L<N> to the clone. After this, the clone becomes the
 * single loop header (forward + backedge entries), the duplicate body
 * is gone, and CFR sees a normal single-entry loop instead of the
 * `lbl-1000` "two consecutive identical conditionals" pattern.
 *
 * Only fires when:
 *   - the two labels are adjacent in source order
 *   - the second label IS a backedge target (the protection case)
 *   - the first label is one we created (`_meln_*`) so we're confident
 *     this is post-clone, not a pre-existing structure
 *   - the bodies (instructions until next labelDef or block end) are identical
 *     including same number of instructions
 *
 * Returns the number of collapses performed.
 */
function collapseLoopHeaderDuplicates(codeItems, exceptionTable, opts) {
  let collapses = 0;
  // Re-scan label list because earlier merge pass may have shifted things.
  const labels = [];
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (item && item.labelDef) labels.push({ idx: i, name: trimLabel(item.labelDef) });
  }
  if (labels.length < 2) return 0;

  const handlerLabels = collectHandlerLabels(exceptionTable || []);
  const incoming = collectIncomingJumps(codeItems);

  for (let pi = 0; pi < labels.length - 1; pi++) {
    const a = labels[pi];
    const b = labels[pi + 1];
    if (!a.name.startsWith('_meln_')) continue;
    if (handlerLabels.has(a.name) || handlerLabels.has(b.name)) continue;

    const aIdx = findLabelIndex(codeItems, a.name);
    const bIdx = findLabelIndex(codeItems, b.name);
    if (aIdx < 0 || bIdx < 0 || bIdx <= aIdx) continue;

    // b must be a backedge target (incoming jump from later position)
    const bIncoming = incoming.get(b.name) || [];
    let isBackedgeTarget = false;
    for (const j of bIncoming) {
      if (j.idx >= bIdx) { isBackedgeTarget = true; break; }
    }
    if (!isBackedgeTarget) continue;

    // bodies must be identical
    const bodyA = blockBody(codeItems, aIdx);
    const bodyB = blockBody(codeItems, bIdx);
    if (bodyA.length === 0) continue;
    if (bodyA.length !== bodyB.length) continue;
    let same = true;
    for (let k = 0; k < bodyA.length; k++) {
      if (!sameInstruction(bodyA[k], bodyB[k])) { same = false; break; }
    }
    if (!same) continue;

    // Apply: delete exactly bodyB.length real instructions after b's labelDef
    // (the duplicate prefix), and redirect jumps targeting b → a.
    deleteBlockBody(codeItems, bIdx, bodyB.length);
    const replacement = new Map();
    replacement.set(b.name, a.name);
    for (const item of codeItems) {
      if (!item || !item.instruction) continue;
      rewriteJumpTargets(item.instruction, replacement);
    }
    for (const e of exceptionTable || []) rewriteExceptionEntry(e, replacement);

    collapses++;
    if (opts.verbose) {
      console.log(`  [collapse] ${opts.owner}.${opts.name}${opts.desc}: header duplicate at ${b.name} → ${a.name} (${bodyA.length} insns deleted)`);
    }
  }
  return collapses;
}

/**
 * Remove exactly `count` real instructions immediately after codeItems[startIdx]
 * (which is a labelDef). Auxiliary items (line numbers, stack maps) interleaved
 * with those instructions are also removed. Stops if a labelDef appears before
 * `count` real instructions are removed.
 */
function deleteBlockBody(codeItems, startIdx, count) {
  let removedReal = 0;
  let i = startIdx + 1;
  while (i < codeItems.length && removedReal < count) {
    const item = codeItems[i];
    if (!item) { i++; continue; }
    if (item.labelDef) break;
    if (item.instruction) {
      codeItems.splice(i, 1);
      removedReal++;
      continue;
    }
    codeItems.splice(i, 1);
  }
}

function areBlocksIdentical(codeItems, idxA, idxB) {
  // Compare instruction streams from after each label, until next labelDef
  // or method end. Identical = same opcode + same arg shape (incl. jump
  // targets, after normalizing labels).
  const bodyA = blockBody(codeItems, idxA);
  const bodyB = blockBody(codeItems, idxB);
  if (bodyA.length !== bodyB.length) return false;
  for (let i = 0; i < bodyA.length; i++) {
    if (!sameInstruction(bodyA[i], bodyB[i])) return false;
  }
  return true;
}

function blockBody(codeItems, startIdx) {
  const body = [];
  for (let i = startIdx + 1; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item) continue;
    if (item.labelDef) break;
    if (!item.instruction) continue;
    body.push(item.instruction);
    const op = getOp(item.instruction);
    if (op === 'goto' || TERMINAL_OPCODES.has(op)) break;
  }
  return body;
}

function sameInstruction(ia, ib) {
  if (!ia || !ib) return ia === ib;
  if (getOp(ia) !== getOp(ib)) return false;
  // Compare arg by JSON shape — same labels, same operands.
  const sa = JSON.stringify(normalizeArg(ia));
  const sb = JSON.stringify(normalizeArg(ib));
  return sa === sb;
}

function normalizeArg(instruction) {
  // Trim label suffix in arg values so "L1" and "L1:" compare equal.
  const arg = instruction && typeof instruction === 'object' ? instruction.arg : null;
  if (typeof arg === 'string') return trimLabel(arg);
  if (Array.isArray(arg)) return arg.map((x) => (typeof x === 'string' ? trimLabel(x) : x));
  if (arg && typeof arg === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(arg)) {
      if (typeof v === 'string') out[k] = trimLabel(v);
      else if (Array.isArray(v)) out[k] = v.map((x) => Array.isArray(x) && typeof x[1] === 'string' ? [x[0], trimLabel(x[1])] : (typeof x === 'string' ? trimLabel(x) : x));
      else out[k] = v;
    }
    return out;
  }
  // tableswitch labels live on the instruction itself
  const labels = Array.isArray(instruction.labels) ? instruction.labels.map(trimLabel) : null;
  const defaultLbl = typeof instruction.defaultLbl === 'string' ? trimLabel(instruction.defaultLbl) : null;
  return { arg, labels, defaultLbl };
}

function rewriteJumpTargets(instruction, replacementMap) {
  if (!instruction || typeof instruction !== 'object') return;
  if (typeof instruction.arg === 'string') {
    const t = trimLabel(instruction.arg);
    if (replacementMap.has(t)) instruction.arg = replacementMap.get(t);
  } else if (instruction.arg && typeof instruction.arg === 'object') {
    if (Array.isArray(instruction.arg.pairs)) {
      for (const pair of instruction.arg.pairs) {
        if (Array.isArray(pair) && typeof pair[1] === 'string') {
          const t = trimLabel(pair[1]);
          if (replacementMap.has(t)) pair[1] = replacementMap.get(t);
        }
      }
    }
    if (typeof instruction.arg.defaultLabel === 'string') {
      const t = trimLabel(instruction.arg.defaultLabel);
      if (replacementMap.has(t)) instruction.arg.defaultLabel = replacementMap.get(t);
    }
  }
  if (Array.isArray(instruction.labels)) {
    for (let i = 0; i < instruction.labels.length; i++) {
      const t = trimLabel(instruction.labels[i]);
      if (replacementMap.has(t)) instruction.labels[i] = replacementMap.get(t);
    }
  }
  if (typeof instruction.defaultLbl === 'string') {
    const t = trimLabel(instruction.defaultLbl);
    if (replacementMap.has(t)) instruction.defaultLbl = replacementMap.get(t);
  }
}

function rewriteExceptionEntry(entry, replacementMap) {
  for (const key of ['startLbl', 'startLabel', 'start', 'endLbl', 'endLabel', 'end',
                     'handlerLbl', 'handlerLabel', 'handler', 'usingLbl']) {
    if (typeof entry[key] === 'string') {
      const t = trimLabel(entry[key]);
      if (replacementMap.has(t)) entry[key] = replacementMap.get(t);
    }
  }
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function getOp(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return instruction;
  return instruction.op || null;
}

function trimLabel(label) {
  if (typeof label !== 'string') return label;
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

function getJumpTargets(instruction, op) {
  if (!op || !instruction) return [];
  if (op === 'tableswitch') {
    const targets = Array.isArray(instruction.labels) ? [...instruction.labels] : [];
    if (instruction.defaultLbl) targets.push(instruction.defaultLbl);
    return targets;
  }
  if (op === 'lookupswitch') {
    const targets = [];
    const arg = instruction.arg;
    if (arg) {
      if (Array.isArray(arg.pairs)) {
        for (const pair of arg.pairs) {
          if (Array.isArray(pair) && pair[1]) targets.push(pair[1]);
        }
      }
      if (arg.defaultLabel) targets.push(arg.defaultLabel);
    }
    return targets;
  }
  if (typeof instruction === 'object' && typeof instruction.arg === 'string') {
    // Filter to actual jump opcodes
    if (op === 'goto' || op === 'jsr' || CONDITIONAL_JUMPS.has(op)) {
      return [instruction.arg];
    }
  }
  return [];
}

module.exports = { runMultiEntryLoopNormalizer };
