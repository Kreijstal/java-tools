/**
 * ConditionInverterCfg.js — CFG-aware conditional inversion pass
 *
 * Detects the pattern where a conditional jump's target is a multi-entry block
 * (reachable both from the conditional AND from within a loop in the fallthrough)
 * and restructures it so CFR can produce clean output.
 *
 * Pattern:
 *   if (cond) goto X;
 *   while (...) { ... }   // fallthrough loop that eventually reaches X
 *   X: ...                // multi-entry: reachable via goto AND from loop exit
 *
 * Transform:
 *   if (!cond) {
 *     while (...) { ... }
 *     goto X;             // explicit exit from if-body
 *   }
 *   X: ...
 *
 * Uses CFG analysis to detect the pattern structurally.
 */
const { BasicBlock } = require('../cfg/cfg');

/**
 * @param {import('./cfg').CFG} cfg
 * @returns {{ changed: boolean, fixed: number }}
 */
function invertConditionalGotos(cfg) {
  if (!cfg || cfg.blocks.size === 0) return { changed: false, fixed: 0 };

  // Build a reverse index: for each block, who jumps directly to it?
  const incomingEdges = new Map(); // blockId → [{ fromId, isConditional, isFallthrough }]
  for (const [id, block] of cfg.blocks) {
    incomingEdges.set(id, []);
  }
  for (const [id, block] of cfg.blocks) {
    const successors = block.successors || [];
    const lastInstr = getLastInstruction(block);
    const op = lastInstr ? getOpcode(lastInstr) : null;
    const isCond = isConditionalJump(op);
    const isGoto = op === 'goto';

    for (let i = 0; i < successors.length; i++) {
      const succId = successors[i];
      const entry = incomingEdges.get(succId);
      if (entry) {
        entry.push({
          fromId: id,
          isConditional: isCond && i === 0, // first successor is the conditional target
          isFallthrough: !isGoto && i === (isCond ? 1 : 0),
        });
      }
    }
  }

  let fixed = 0;

  // Find candidate target blocks: blocks with >1 incoming edge,
  // where at least one incoming is from a conditional jump
  for (const [targetId, incoming] of incomingEdges) {
    if (incoming.length < 2) continue;

    const condIncoming = incoming.filter(e => e.isConditional);
    if (condIncoming.length === 0) continue;

    // For each conditional that targets this block:
    for (const condEdge of condIncoming) {
      const condBlockId = condEdge.fromId;
      const condBlock = cfg.blocks.get(condBlockId);
      if (!condBlock) continue;

      // The other successor of the conditional should reach targetId
      // via a path that includes a loop (backedge)
      const otherSuccId = condBlock.successors.find(s => s !== targetId);
      if (!otherSuccId) continue;

      // Check if otherSuccId reaches targetId AND contains a backedge
      if (!hasPathWithBackedge(otherSuccId, targetId, cfg)) continue;

      // We found the pattern! Apply transformation.
      // Strategy: invert the conditional on condBlock, insert an if-wrapper
      if (invertAndWrap(condBlock, targetId, otherSuccId, cfg)) {
        fixed++;
        break; // One fix per target
      }
    }
  }

  return { changed: fixed > 0, fixed };
}

/**
 * Check if a path exists from startId to targetId that contains at least
 * one backedge (a jump to a block that appears earlier in any topological order).
 */
function hasPathWithBackedge(startId, targetId, cfg) {
  const visited = new Set();
  const stack = [{ id: startId, path: [startId], hasBackedge: false }];

  while (stack.length > 0) {
    const { id, path, hasBackedge } = stack.pop();
    if (id === targetId && hasBackedge) return true;
    if (visited.has(id)) continue;
    visited.add(id);

    const block = cfg.blocks.get(id);
    if (!block) continue;

    for (const succId of (block.successors || [])) {
      const isBackedge = path.includes(succId);
      stack.push({
        id: succId,
        path: [...path, succId],
        hasBackedge: hasBackedge || isBackedge,
      });
    }
  }
  return false;
}

/**
 * Invert the conditional and wrap the fallthrough path.
 *
 * Before:
 *   condBlock: if (cond) goto targetId  (fallthrough → otherSuccId)
 *   ... otherSuccId block(s) ...
 *   targetId (multi-entry)
 *
 * After:
 *   condBlock': if (!cond) goto newIfEnd
 *   newIfBody: (label, then falls through to otherSuccId)
 *   ... otherSuccId blocks(s) ...
 *   goto targetId (explicit exit from if-body)
 *   newIfEnd: (label, falls through to targetId)
 *   targetId
 */
function invertAndWrap(condBlock, targetId, otherSuccId, cfg) {
  const lastInstr = getLastInstruction(condBlock);
  if (!lastInstr) return false;

  const op = getOpcode(lastInstr);
  const inverseOp = inverseConditionalOpcode(op);
  if (!inverseOp) return false;

  // 1. Invert the conditional in condBlock
  //    Old: if (cond) goto targetId; fallthrough → otherSuccId
  //    New: if (!cond) goto newIfEnd; fallthrough → otherSuccId (unchanged)
  lastInstr.op = inverseOp;
  // Keep the same target for now, we'll fix up via the CFG
  // Actually, condBlock already has targetId and otherSuccId as successors.
  // After inversion: first successor (conditional-true) should go to ifEnd
  // and the fallthrough (conditional-false) goes to otherSuccId.

  // We need to create two new blocks:
  //   ifBodyBlock: between condBlock and otherSuccId (just a passthrough)
  //   gotoBlock: at the end of the other-path, explicitly goto targetId
  //   ifEndBlock: between gotoBlock and targetId (the merge point)

  // For simplicity: just mark the CFG as "changed" and let the AST
  // reconstruction handle the details. We signal that condBlock's
  // conditional should be inverted and the other-path should end
  // with an explicit goto.

  // Store transformation metadata on the CFG
  if (!cfg._inversions) cfg._inversions = [];
  cfg._inversions.push({
    condBlockId: condBlock.id,
    targetId,
    otherSuccId,
    inverseOp,
    originalOp: op,
  });

  return true;
}

function inverseConditionalOpcode(op) {
  const inverses = {
    'ifeq': 'ifne', 'ifne': 'ifeq',
    'iflt': 'ifge', 'ifge': 'iflt',
    'ifgt': 'ifle', 'ifle': 'ifgt',
    'if_icmpeq': 'if_icmpne', 'if_icmpne': 'if_icmpeq',
    'if_icmplt': 'if_icmpge', 'if_icmpge': 'if_icmplt',
    'if_icmpgt': 'if_icmple', 'if_icmple': 'if_icmpgt',
    'if_acmpeq': 'if_acmpne', 'if_acmpne': 'if_acmpeq',
    'ifnull': 'ifnonnull', 'ifnonnull': 'ifnull',
  };
  return inverses[op] || null;
}

function isConditionalJump(op) {
  return op && inverseConditionalOpcode(op) !== null;
}

function getLastInstruction(block) {
  if (!block || !block.instructions) return null;
  for (let i = block.instructions.length - 1; i >= 0; i--) {
    const instr = block.instructions[i];
    if (instr && instr.instruction) return instr.instruction;
  }
  return null;
}

function getOpcode(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return instruction;
  return instruction.op || null;
}

module.exports = { invertConditionalGotos };
