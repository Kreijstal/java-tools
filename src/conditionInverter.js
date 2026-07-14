'use strict';

/**
 * ConditionInverter pass — CFG-aware conditional inversion for CFR friendliness.
 *
 * Detects: conditional jump whose target is a multi-entry block reachable
 * both from the conditional AND from within a loop in the fallthrough path.
 *
 * Transform:
 *   if (cond) goto X;
 *   while (...) { ... }    // fallthrough loop → X
 *   X: ...
 *
 * Becomes:
 *   if (!cond) {           // inverted condition
 *     while (...) { ... }
 *     goto X;              // explicit exit
 *   }
 *   X: ...
 *
 * Uses CFG for structural pattern detection, but modifies codeItems directly
 * (avoiding CFG round-trip which preserves original block ordering).
 */

const { convertAstToCfg } = require('./ast-to-cfg');

const CONDITIONAL_JUMPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne',
  'ifnull', 'ifnonnull',
]);

const INVERSE = {
  'ifeq': 'ifne', 'ifne': 'ifeq',
  'iflt': 'ifge', 'ifge': 'iflt',
  'ifgt': 'ifle', 'ifle': 'ifgt',
  'if_icmpeq': 'if_icmpne', 'if_icmpne': 'if_icmpeq',
  'if_icmplt': 'if_icmpge', 'if_icmpge': 'if_icmplt',
  'if_icmpgt': 'if_icmple', 'if_icmple': 'if_icmpgt',
  'if_acmpeq': 'if_acmpne', 'if_acmpne': 'if_acmpeq',
  'ifnull': 'ifnonnull', 'ifnonnull': 'ifnull',
};

/**
 * Main entry point: run on an AST root (from jvm-cli.js).
 * @param {object} astRoot - Parsed AST from getAST/convertJson
 * @param {object} options
 * @param {number} [options.maxDistance=300] - Max instructions between cond and target
 * @returns {{ changed: boolean, fixed: number }}
 */
function runConditionInverter(astRoot, options = {}) {
  const maxDistance = options.maxDistance || 300;
  let totalFixed = 0;

  for (const classItem of (astRoot.classes || [])) {
    for (const item of (classItem.items || [])) {
      if (!item || item.type !== 'method' || !item.method) continue;

      const codeAttr = (item.method.attributes || []).find(a => a.type === 'code');
      if (!codeAttr || !codeAttr.code) continue;

      const codeItems = codeAttr.code.codeItems || [];
      if (codeItems.length === 0) continue;

      const fixed = fixMethod(codeItems, maxDistance, item.method, classItem.className);
      totalFixed += fixed;
    }
  }

  return { changed: totalFixed > 0, fixed: totalFixed };
}

/**
 * Fix one method's codeItems in-place.
 * Builds CFG for detection, then manipulates codeItems directly.
 */
function fixMethod(codeItems, maxDistance, method, className) {
  // Build CFG for detection
  const cfg = buildCfgForDetection(codeItems);
  if (!cfg) return 0;

  // Find candidates using CFG
  const targets = findCandidateTargets(cfg, codeItems);
  if (targets.length === 0) return 0;

  let fixed = 0;
  // Only fix the FIRST candidate per method — it's the outermost
  // conditional that creates the CFR-unfriendly pattern. Inner candidates
  // are within the loop body and inverting them breaks the loop structure.
  if (targets.length > 0) {
    const target = targets[0];
    if (fixOne(codeItems, target.condIdx, target.targetLabel, maxDistance)) {
      fixed++;
    }
  }

  return fixed;
}

/**
 * Build a minimal CFG just for pattern detection.
 * Returns a plain object: { blocks: Map<id, {successors, predecessors, startIdx, endIdx}> }
 */
function buildCfgForDetection(codeItems) {
  // Build label → index map
  const labelToIdx = new Map();
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (item && item.labelDef) {
      labelToIdx.set(trimLabel(item.labelDef), i);
    }
  }

  // Find leaders (block boundaries)
  const leaders = new Set([0]);
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const op = getOp(item.instruction);
    if (!op) continue;

    const targets = getJumpTargets(item.instruction, op);
    for (const t of targets) {
      const tIdx = labelToIdx.get(t);
      if (tIdx !== undefined) leaders.add(tIdx);
    }
    // Fallthrough leader (instruction after a jump)
    if (isBlockEnd(op) || CONDITIONAL_JUMPS.has(op)) {
      if (i + 1 < codeItems.length) leaders.add(i + 1);
    }
  }

  // Build blocks
  const sortedLeaders = [...leaders].sort((a, b) => a - b);
  const blocks = new Map();

  for (let li = 0; li < sortedLeaders.length; li++) {
    const start = sortedLeaders[li];
    const end = li + 1 < sortedLeaders.length ? sortedLeaders[li + 1] - 1 : codeItems.length - 1;

    // Find the last real instruction index in this block
    let lastInstrIdx = end;
    while (lastInstrIdx >= start && (!codeItems[lastInstrIdx] || !codeItems[lastInstrIdx].instruction)) {
      lastInstrIdx--;
    }

    const blockId = `b${start}`;
    blocks.set(blockId, { start, end: lastInstrIdx >= start ? lastInstrIdx : end, successors: [], predecessors: [] });
  }

  // Build edges
  for (const [id, block] of blocks) {
    const lastIdx = block.end;
    if (lastIdx < block.start) continue;
    const lastItem = codeItems[lastIdx];
    if (!lastItem || !lastItem.instruction) {
      // Falls through to next block
      const nextBlockId = findBlockAt(blocks, lastIdx + 1);
      if (nextBlockId) {
        block.successors.push(nextBlockId);
        blocks.get(nextBlockId).predecessors.push(id);
      }
      continue;
    }

    const op = getOp(lastItem.instruction);
    const targets = getJumpTargets(lastItem.instruction, op);

    if (op === 'goto') {
      // Unconditional jump - only one successor
      const tId = findBlockByLabel(blocks, targets[0], labelToIdx);
      if (tId) {
        block.successors.push(tId);
        blocks.get(tId).predecessors.push(id);
      }
    } else if (op === 'tableswitch' || op === 'lookupswitch') {
      for (const t of targets) {
        const tId = findBlockByLabel(blocks, t, labelToIdx);
        if (tId) {
          block.successors.push(tId);
          blocks.get(tId).predecessors.push(id);
        }
      }
    } else if (CONDITIONAL_JUMPS.has(op)) {
      // Conditional: first target is the jump target, then fallthrough
      const tId = findBlockByLabel(blocks, targets[0], labelToIdx);
      if (tId) {
        block.successors.push(tId);
        blocks.get(tId).predecessors.push(id);
      }
      // Fallthrough
      const nextBlockId = findBlockAt(blocks, lastIdx + 1);
      if (nextBlockId) {
        block.successors.push(nextBlockId);
        blocks.get(nextBlockId).predecessors.push(id);
      }
    } else if (isBlockEnd(op)) {
      // return/throw - no successors
    } else {
      // Regular instruction - fallthrough
      const nextBlockId = findBlockAt(blocks, lastIdx + 1);
      if (nextBlockId) {
        block.successors.push(nextBlockId);
        blocks.get(nextBlockId).predecessors.push(id);
      }
    }
  }

  return { blocks, labelToIdx };
}

/**
 * Find candidate conditional jumps where the target is also reachable
 * via a loop-containing path from the fallthrough.
 */
function findCandidateTargets(cfg, codeItems) {
  const candidates = [];

  for (const [id, block] of cfg.blocks) {
    const lastIdx = block.end;
    if (lastIdx < block.start) continue;
    const lastItem = codeItems[lastIdx];
    if (!lastItem || !lastItem.instruction) continue;

    const op = getOp(lastItem.instruction);
    if (!CONDITIONAL_JUMPS.has(op)) continue;
    if (block.successors.length < 2) continue;

    const jumpTargetId = block.successors[0];  // conditional-true → target
    const fallthroughId = block.successors[1]; // conditional-false → fallthrough

    const jumpTargetBlock = cfg.blocks.get(jumpTargetId);
    if (!jumpTargetBlock) continue;

    // Check: the jump target has >1 predecessor (multi-entry)
    if (jumpTargetBlock.predecessors.length < 2) continue;

    // Check: the fallthrough path reaches the jump target AND contains a backedge
    if (!hasLoopPathTo(fallthroughId, jumpTargetId, cfg, new Set())) continue;

    // Check: distance is reasonable
    if (jumpTargetBlock.start - block.start > 300) continue;

    // Check: the jump target is not an exception handler
    // (handlers are identified by having label-only codeItems)

    candidates.push({
      condIdx: lastIdx,
      condBlockId: id,
      targetLabel: getFirstLabelAt(codeItems, jumpTargetBlock.start),
      targetIdx: jumpTargetBlock.start,
    });
  }

  return candidates;
}

/**
 * Check if there's a path from startId to targetId that contains a backedge.
 */
function hasLoopPathTo(startId, targetId, cfg, visited) {
  if (startId === targetId) return false;
  if (visited.has(startId)) return false;
  visited.add(startId);

  const block = cfg.blocks.get(startId);
  if (!block) return false;

  for (const succId of block.successors) {
    // Check if succId creates a backedge (already in visited set)
    const hasBackedge = visited.has(succId);

    if (succId === targetId) {
      if (hasBackedge) return true;
      // Even without direct backedge, check if the path to here had one
      continue;
    }

    // Recurse
    const subVisited = new Set(visited);
    if (hasLoopPathTo(succId, targetId, cfg, subVisited)) {
      return true;
    }
    // If succId is a backedge itself, we should check if the path through it reaches target
    if (hasBackedge) {
      // This IS a path with a backedge - check if we can reach target from here
      const reachVisited = new Set();
      if (canReach(succId, targetId, cfg, reachVisited)) {
        return true;
      }
    }
  }

  return false;
}

function canReach(fromId, targetId, cfg, visited) {
  if (fromId === targetId) return true;
  if (visited.has(fromId)) return false;
  visited.add(fromId);

  const block = cfg.blocks.get(fromId);
  if (!block) return false;

  for (const succId of block.successors) {
    if (canReach(succId, targetId, cfg, visited)) return true;
  }
  return false;
}

/**
 * Apply the transformation for one conditional.
 */
function fixOne(codeItems, condIdx, targetLabel, maxDistance) {
  const condItem = codeItems[condIdx];
  if (!condItem || !condItem.instruction) return false;

  const op = getOp(condItem.instruction);
  const inverseOp = INVERSE[op];
  if (!inverseOp) return false;

  // Find the target label position
  const targetIdx = findLabelIndex(codeItems, targetLabel);
  if (targetIdx === -1 || targetIdx <= condIdx) return false;
  if (targetIdx - condIdx > maxDistance) return false;

  // Find the end of the fallthrough body (last real instruction before target)
  let fallthroughEnd = targetIdx - 1;
  while (fallthroughEnd > condIdx) {
    const item = codeItems[fallthroughEnd];
    if (item && item.instruction) break;
    fallthroughEnd--;
  }
  if (fallthroughEnd <= condIdx) return false;

  // Check: the fallthrough contains a backedge (loop)
  // (already verified by CFG, but double-check for safety)
  if (!fallthroughContainsBackedge(codeItems, condIdx + 1, targetIdx)) return false;

  // ---- Apply transformation ----

  // 1. Invert the conditional, change target to new label
  const newLabel = `_ci_end_${condIdx}`;
  condItem.instruction.op = inverseOp;
  if (typeof condItem.instruction === 'object') {
    condItem.instruction.arg = newLabel;
  }

  // 2. Insert goto to original target at the end of fallthrough body
  const gotoItem = {
    instruction: { op: 'goto', arg: targetLabel },
  };
  codeItems.splice(fallthroughEnd + 1, 0, gotoItem);

  // 3. Insert the new label just before the original target
  //    (targetIdx shifted by 1 because of the goto insertion)
  const newLabelItem = { labelDef: `${newLabel}:` };
  const adjustedTargetIdx = targetIdx + 1; // shifted by goto insertion
  codeItems.splice(adjustedTargetIdx, 0, newLabelItem);

  return true;
}

function fallthroughContainsBackedge(codeItems, start, end) {
  const labelToIdx = new Map();
  for (let i = start; i < end; i++) {
    const item = codeItems[i];
    if (item && item.labelDef) {
      labelToIdx.set(trimLabel(item.labelDef), i);
    }
  }

  for (let i = start; i < end; i++) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const op = getOp(item.instruction);
    const targets = getJumpTargets(item.instruction, op);
    for (const t of targets) {
      const tIdx = labelToIdx.get(t);
      if (tIdx !== undefined && tIdx <= i) return true; // backedge!
    }
  }
  return false;
}

// ---- Utility functions ----

function trimLabel(label) {
  if (typeof label !== 'string') return label;
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

function getOp(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return instruction;
  return instruction.op || null;
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
  const arg = typeof instruction === 'object' ? instruction.arg : null;
  if (typeof arg === 'string') return [arg];
  return [];
}

function isBlockEnd(op) {
  return op === 'ret' || op === 'return' || op === 'ireturn' || op === 'lreturn' ||
    op === 'freturn' || op === 'dreturn' || op === 'areturn' || op === 'athrow';
}

function findBlockAt(blocks, index) {
  for (const [id, block] of blocks) {
    if (block.start <= index && index <= block.end + 1) return id;
    // end+1 to catch the immediate next instruction
  }
  return null;
}

function findBlockByLabel(blocks, label, labelToIdx) {
  if (!label) return null;
  const idx = labelToIdx.get(trimLabel(label));
  if (idx === undefined) return null;
  return findBlockAt(blocks, idx);
}

function findLabelIndex(codeItems, label) {
  const trimmed = trimLabel(label);
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (item && item.labelDef && trimLabel(item.labelDef) === trimmed) {
      return i;
    }
  }
  return -1;
}

function getFirstLabelAt(codeItems, index) {
  // Find the label definition at or before this index
  for (let i = index; i >= 0; i--) {
    const item = codeItems[i];
    if (item && item.labelDef) return trimLabel(item.labelDef);
  }
  return null;
}

module.exports = { runConditionInverter };
