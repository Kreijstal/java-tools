const { getStackEffect, normalizeInstruction } = require('./deadCodeEliminator')._internals;
/**
 * Performs a topological sort of the basic blocks in a CFG.
 * This is necessary to flatten the graph back into a linear sequence of
 * instructions while respecting control flow.
 *

/**
 * @param {import('./cfg').CFG} cfg - The Control Flow Graph to sort.
 * @returns {Array<import('./cfg').BasicBlock>} A sorted array of basic blocks.
 */
function topologicalSort(cfg) {
  const sorted = [];
  const visited = new Set();
  const recursionStack = new Set(); // For detecting cycles

  function visit(blockId) {
    if (recursionStack.has(blockId)) {
      // This indicates a cycle, which shouldn't happen in reducible CFGs from Java bytecode,
      // but it's good practice to handle it. For our purposes, we can ignore it.
      return;
    }
    if (visited.has(blockId)) {
      return;
    }

    visited.add(blockId);
    recursionStack.add(blockId);

    const block = cfg.blocks.get(blockId);
    if (block) {
      for (const successorId of block.successors) {
        visit(successorId);
      }
    }

    recursionStack.delete(blockId);
    // Post-order traversal addition
    if (block) {
      sorted.unshift(block);
    }
  }

  visit(cfg.entryBlockId);
  return sorted;
}

/**
 * Recalculates the maximum stack height for a list of instructions.
 * @param {Array<object>} instructions - The list of codeItems.
 * @returns {number} The new maxStack value.
 */
function recalculateMaxStack(instructions) {
  let maxStack = 0;
  let currentStack = 0;

  for (const item of instructions) {
    const normalized = normalizeInstruction(item.instruction);
    if (!normalized || !normalized.op) continue;

    const effect = getStackEffect(normalized.op, normalized);
    if (!effect) continue;

    currentStack -= effect.popSlots;
    if (currentStack < 0) currentStack = 0; // Should not happen in valid code
    currentStack += effect.pushSlots;

    if (currentStack > maxStack) {
      maxStack = currentStack;
    }
  }

  return maxStack;
}

/**
 * Reconstructs a method's instruction list (codeItems) from an optimized CFG.
 *
 * @param {import('./cfg').CFG} optimizedCfg - The optimized Control Flow Graph.
 * @param {object} originalMethodAst - The original method AST, used as a template.
 * @returns {object} A new method AST with the updated instruction list.
 */
function reconstructAstFromCfg(optimizedCfg, originalMethodAst) {
  const sortedBlocks = topologicalSort(optimizedCfg);

  const newCodeItems = [];
  for (const block of sortedBlocks) {
    newCodeItems.push(...block.instructions);
  }

  // Deep clone the original method AST to avoid mutating it.
  const newMethodAst = JSON.parse(JSON.stringify(originalMethodAst));

  const codeAttr = newMethodAst.attributes.find(attr => attr.type === 'code');
  if (codeAttr) {
    codeAttr.code.codeItems = newCodeItems;
    codeAttr.code.stackSize = String(recalculateMaxStack(newCodeItems));
    // Note: maxLocals is not recalculated as this optimization does not affect it.
  }

  return newMethodAst;
}

module.exports = {
  reconstructAstFromCfg
};
