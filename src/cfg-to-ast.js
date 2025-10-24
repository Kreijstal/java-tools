const { getStackEffect, normalizeInstruction } = require('./utils/instructionUtils');

/**
 * Recalculates the maximum stack height for a list of instructions.
 * @param {Array<object>} instructions - The list of codeItems.
 * @returns {number} The new maxStack value.
 */
function recalculateMaxStack(cfg) {
  const handlerBlocks = cfg.handlerBlocks instanceof Set ? cfg.handlerBlocks : new Set();
  const exceptionSuccessors = cfg.exceptionSuccessors instanceof Map ? cfg.exceptionSuccessors : new Map();
  const entryHeights = new Map();
  const worklist = [];

  entryHeights.set(cfg.entryBlockId, 0);
  worklist.push(cfg.entryBlockId);

  for (const handlerId of handlerBlocks) {
    if (!entryHeights.has(handlerId)) {
      entryHeights.set(handlerId, 1);
      worklist.push(handlerId);
    }
  }

  let maxStack = 0;

  while (worklist.length > 0) {
    const blockId = worklist.pop();
    const block = cfg.blocks.get(blockId);
    if (!block) {
      continue;
    }

    let currentStack = entryHeights.get(blockId) ?? 0;
    if (currentStack > maxStack) {
      maxStack = currentStack;
    }

    for (const item of block.instructions) {
      if (!item || !item.instruction) {
        continue;
      }
      const normalized = normalizeInstruction(item.instruction);
      if (!normalized || !normalized.op) {
        continue;
      }

      const effect = getStackEffect(normalized.op, normalized);
      if (!effect) {
        continue;
      }

      currentStack -= effect.popSlots;
      if (currentStack < 0) {
        throw new Error(`Stack underflow detected while recalculating stack height in block ${blockId}.`);
      }
      currentStack += effect.pushSlots;

      if (currentStack > maxStack) {
        maxStack = currentStack;
      }
    }

    for (const successorId of block.successors) {
      const exceptionTargets = exceptionSuccessors.get(blockId);
      const isExceptionEdge = exceptionTargets && exceptionTargets.has(successorId);
      const successorHeight = isExceptionEdge ? 1 : currentStack;
      if (!entryHeights.has(successorId) || entryHeights.get(successorId) !== successorHeight) {
        entryHeights.set(successorId, successorHeight);
        worklist.push(successorId);
      }
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
  const getBlockStart = (block) => {
    if (!block || block.id === cfg.entryBlockId) {
      return Number.NEGATIVE_INFINITY;
    }
    for (const item of block.instructions) {
      if (item && typeof item.pc === 'number') {
        return item.pc;
      }
    }
    return Number.POSITIVE_INFINITY;
  };

  const sanitizeInstructionData = (items) =>
    JSON.parse(
      JSON.stringify(items, (key, value) => {
        if (key === 'consumes' || key === 'produced' || key === 'consumers' || key === 'effect') {
          return undefined;
        }
        if (key === 'producer') {
          return undefined;
        }
        return value;
      }),
    );

  const sortedBlocks = Array.from(cfg.blocks.values()).sort((a, b) => {
    const startA = getBlockStart(a);
    const startB = getBlockStart(b);
    if (startA === startB) {
      return a.id.localeCompare(b.id);
    }
    return startA - startB;
  });

  const newCodeItems = [];
  for (const block of sortedBlocks) {
    const sanitized = sanitizeInstructionData(block.instructions);
    newCodeItems.push(...sanitized);
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

  const newMethodAst = JSON.parse(
    JSON.stringify(originalMethodAst, (key, value) => {
      if (key === 'consumes' || key === 'produced' || key === 'consumers' || key === 'effect') {
        return undefined;
      }
      if (key === 'producer') {
        return undefined;
      }
      return value;
    }),
  );

  const codeAttr = newMethodAst.attributes.find(attr => attr.type === 'code');
  if (codeAttr) {
    codeAttr.code.codeItems = newCodeItems;
    codeAttr.code.stackSize = String(recalculateMaxStack(cfg));
  }

  return newMethodAst;
}

module.exports = {
  reconstructAstFromCfg
};
