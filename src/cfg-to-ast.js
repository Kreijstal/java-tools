const { getStackEffect, normalizeInstruction } = require('./deadCodeEliminator')._internals;

/**
 * Performs a topological sort of the basic blocks in a CFG.
 * @param {import('./cfg').CFG} cfg - The Control Flow Graph to sort.
 * @returns {Array<import('./cfg').BasicBlock>} A sorted array of basic blocks.
 */
function topologicalSort(cfg) {
  const sorted = [];
  const visited = new Set();
  const recursionStack = new Set();

  function visit(blockId) {
    if (recursionStack.has(blockId)) {
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
    if (!item.instruction) continue;
    const normalized = normalizeInstruction(item.instruction);
    if (!normalized || !normalized.op) continue;

    const effect = getStackEffect(normalized.op, normalized);
    if (!effect) continue;

    currentStack -= effect.popSlots;
    if (currentStack < 0) throw new Error('Stack underflow detected during stack recalculation.');
    currentStack += effect.pushSlots;

    if (currentStack > maxStack) {
      maxStack = currentStack;
    }
  }

  return maxStack;
}

/**
 * Reconstructs a method's instruction list (codeItems) from a CFG.
 * @param {import('./cfg').CFG} cfg - The Control Flow Graph.
 * @param {object} originalMethodAst - The original method AST, used as a template.
 * @returns {object} A new method AST with the updated instruction list.
 */
function reconstructAstFromCfg(cfg, originalMethodAst) {
  const sortedBlocks = topologicalSort(cfg);

  const newCodeItems = [];
  for (const block of sortedBlocks) {
    newCodeItems.push(...block.instructions);
  }

  // Append any label-only items from the end of the original method
  const originalCodeItems = originalMethodAst.attributes.find(a => a.type === 'code').code.codeItems;
  for (let i = originalCodeItems.length - 1; i >= 0; i--) {
    const item = originalCodeItems[i];
    if (!item.instruction && item.labelDef) {
      if (!newCodeItems.find(ci => ci.labelDef === item.labelDef)) {
        newCodeItems.push(item);
      }
    } else {
      break;
    }
  }

  const newMethodAst = JSON.parse(JSON.stringify(originalMethodAst));

  const codeAttr = newMethodAst.attributes.find(attr => attr.type === 'code');
  if (codeAttr) {
    codeAttr.code.codeItems = newCodeItems;
    codeAttr.code.stackSize = String(recalculateMaxStack(newCodeItems));
  }

  return newMethodAst;
}

module.exports = {
  reconstructAstFromCfg
};
