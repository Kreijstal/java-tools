const { getStackEffect, normalizeInstruction } = require('./utils/instructionUtils');

/**
 * Recalculates the maximum stack height for a list of instructions.
 * @param {Array<object>} instructions - The list of codeItems.
 * @returns {number} The new maxStack value.
 */
const DEBUG_STACK_PROP = process.env.DCE_DEBUG_STACK === '1';
const DEBUG_STACK_METHOD = process.env.DCE_DEBUG_METHOD || null;

function recalculateMaxStack(cfg) {
  const ctx = cfg && cfg.context;
  const contextLabel = ctx
    ? `${ctx.className || 'Unknown'}.${ctx.methodName || '?'}${ctx.descriptor || ''}`
    : null;
  const debugEnabled = DEBUG_STACK_PROP && (!DEBUG_STACK_METHOD || DEBUG_STACK_METHOD === contextLabel);
  const handlerBlocks = cfg.handlerBlocks instanceof Set ? cfg.handlerBlocks : new Set();
  const exceptionSuccessors = cfg.exceptionSuccessors instanceof Map ? cfg.exceptionSuccessors : new Map();
  const entryHeights = new Map();
  const worklist = [];
  const visitCounts = new Map();
  const MAX_VISITS = 100000;

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
    const visitCount = (visitCounts.get(blockId) || 0) + 1;
    visitCounts.set(blockId, visitCount);
    if (visitCount > MAX_VISITS) {
      const prefix = contextLabel ? `[${contextLabel}] ` : '';
      throw new Error(
        `${prefix}Stack height propagation did not converge for block ${blockId}.`,
      );
    }
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
        const prefix = contextLabel ? `[${contextLabel}] ` : '';
        throw new Error(
          `${prefix}Stack underflow detected while recalculating stack height in block ${blockId}.`,
        );
      }
      currentStack += effect.pushSlots;

      if (currentStack > maxStack) {
        maxStack = currentStack;
      }
    }

    for (const successorId of block.successors) {
      const exceptionTargets = exceptionSuccessors.get(blockId);
      const isExceptionEdge =
        (exceptionTargets && exceptionTargets.has(successorId)) || handlerBlocks.has(successorId);
      const successorHeight = isExceptionEdge ? 1 : currentStack;
      if (!entryHeights.has(successorId) || entryHeights.get(successorId) !== successorHeight) {
        if (debugEnabled) {
          console.error(
            `[stack] ${contextLabel || '?'} ${blockId} -> ${successorId} height ${successorHeight}`,
          );
        }
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
        if (key === 'consumes' || key === 'produced' || key === 'consumers' || key === 'effect' || key === 'loc') {
          return undefined;
        }
        if (key === 'producer') {
          return undefined;
        }
        if (typeof value === 'bigint') {
          return value.toString();
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

  removeEmptyCounterLoops(newCodeItems);

  const newMethodAst = JSON.parse(
    JSON.stringify(originalMethodAst, (key, value) => {
      if (key === 'consumes' || key === 'produced' || key === 'consumers' || key === 'effect' || key === 'loc') {
        return undefined;
      }
      if (key === 'producer') {
        return undefined;
      }
      if (typeof value === 'bigint') {
        return value.toString();
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

function normalizeLabelValue(label) {
  if (typeof label !== 'string') return null;
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

function getLocalIndexFromOp(op, arg) {
  if (!op) return null;
  const suffixPattern = /^(?:[ailfd]?store|astore|[ailfd]?load|aload)_(\d+)$/;
  const match = op.match(suffixPattern);
  if (match) {
    return Number(match[1]);
  }
  const baseMatch = op.match(/^(istore|iload|lstore|lload|fstore|fload|dstore|dload|astore|aload)$/);
  if (baseMatch) {
    if (typeof arg === 'number') return arg;
    if (typeof arg === 'string' && arg.length) return Number(arg);
  }
  return null;
}

function referencesLocal(item, varIndex) {
  if (!item || !item.instruction) return false;
  const normalized = normalizeInstruction(item.instruction);
  if (!normalized || !normalized.op) return false;
  const op = normalized.op;
  if (op.startsWith('iinc')) {
    const varnum = normalized.varnum ?? normalized.index ?? normalized.arg;
    return Number(varnum) === varIndex;
  }
  const idx = getLocalIndexFromOp(op, normalized.arg);
  return idx === varIndex;
}

function isConstantOp(op) {
  return (
    op.startsWith('iconst') ||
    op.startsWith('bipush') ||
    op.startsWith('sipush') ||
    op === 'aconst_null'
  );
}

function loopBodyIsTrivial(codeItems, startIdx, incIdx, loopVar) {
  const localsWritten = new Set();
  for (let j = startIdx + 3; j < incIdx; j += 1) {
    const item = codeItems[j];
    if (!item || !item.instruction) {
      return null;
    }
    const normalized = normalizeInstruction(item.instruction);
    if (!normalized || !normalized.op) {
      return null;
    }
    const op = normalized.op;
    if (isConstantOp(op)) {
      continue;
    }
    if (op.startsWith('iload')) {
      const idx = getLocalIndexFromOp(op, normalized.arg);
      if (idx !== loopVar && !localsWritten.has(idx)) {
        return null;
      }
      continue;
    }
    if (op.startsWith('istore')) {
      const idx = getLocalIndexFromOp(op, normalized.arg);
      if (idx == null || idx === loopVar) {
        return null;
      }
      localsWritten.add(idx);
      continue;
    }
    return null;
  }
  return { localsWritten };
}

function localsUsedAfter(codeItems, startIndex, locals) {
  for (let j = startIndex; j < codeItems.length; j += 1) {
    if (j > startIndex && codeItems[j].labelDef) {
      break;
    }
    for (const local of locals) {
      if (referencesLocal(codeItems[j], local)) {
        return true;
      }
    }
  }
  return false;
}

function removeEmptyCounterLoops(codeItems) {
  let changed = true;
  while (changed) {
    changed = false;
    const labelToIndex = new Map();
    const labelUseCount = new Map();
    codeItems.forEach((item, idx) => {
      if (item && item.labelDef) {
        labelToIndex.set(normalizeLabelValue(item.labelDef), idx);
      }
      const norm = normalizeInstruction(item && item.instruction);
      if (norm && typeof norm.arg === 'string') {
        const label = normalizeLabelValue(norm.arg);
        if (label) {
          labelUseCount.set(label, (labelUseCount.get(label) || 0) + 1);
        }
      }
    });

    for (let idx = 0; idx < codeItems.length; idx += 1) {
      const gotoNorm = normalizeInstruction(codeItems[idx] && codeItems[idx].instruction);
      if (!gotoNorm || gotoNorm.op !== 'goto') {
        continue;
      }
      const startLabel = normalizeLabelValue(gotoNorm.arg);
      if (!startLabel || labelUseCount.get(startLabel) !== 1) {
        continue;
      }
      const startIdx = labelToIndex.get(startLabel);
      if (startIdx == null || startIdx >= idx) {
        continue;
      }
      const incIdx = idx - 1;
      const incNorm = normalizeInstruction(codeItems[incIdx] && codeItems[incIdx].instruction);
      if (!incNorm || incNorm.op !== 'iinc') {
        continue;
      }
      const loopVar = Number(incNorm.varnum ?? incNorm.index ?? incNorm.arg);
      if (!Number.isFinite(loopVar)) {
        continue;
      }
      const branchItem = codeItems[startIdx + 2];
      if (!branchItem) {
        continue;
      }
      const branchNorm = normalizeInstruction(branchItem.instruction);
      if (!branchNorm || branchNorm.op !== 'if_icmpge') {
        continue;
      }
      const exitLabel = normalizeLabelValue(branchNorm.arg);
      if (!exitLabel || !labelToIndex.has(exitLabel)) {
        continue;
      }
      const exitIdx = labelToIndex.get(exitLabel);
      if (exitIdx <= idx) {
        continue;
      }
      const startLoad = normalizeInstruction(codeItems[startIdx] && codeItems[startIdx].instruction);
      if (!startLoad || getLocalIndexFromOp(startLoad.op, startLoad.arg) !== loopVar) {
        continue;
      }
      const limitNorm = normalizeInstruction(codeItems[startIdx + 1] && codeItems[startIdx + 1].instruction);
      if (
        !limitNorm ||
        !(
          limitNorm.op.startsWith('iload') ||
          limitNorm.op.startsWith('iconst') ||
          limitNorm.op.startsWith('bipush') ||
          limitNorm.op.startsWith('sipush')
        )
      ) {
        continue;
      }
      const bodyHasInstructions = startIdx + 3 < incIdx;
      if (bodyHasInstructions) {
        const bodyInfo = loopBodyIsTrivial(codeItems, startIdx, incIdx, loopVar);
        if (!bodyInfo) {
          continue;
        }
        if (localsUsedAfter(codeItems, exitIdx, bodyInfo.localsWritten)) {
          continue;
        }
      } else {
        if (referencesLocal(codeItems[exitIdx], loopVar)) {
          continue;
        }
      }

      if (bodyHasInstructions && referencesLocal(codeItems[exitIdx], loopVar)) {
        continue;
      }
      const initStoreIdx = startIdx - 1;
      const initLoadIdx = startIdx - 2;
      if (initLoadIdx < 0) {
        continue;
      }
      const initStoreNorm = normalizeInstruction(codeItems[initStoreIdx] && codeItems[initStoreIdx].instruction);
      const initLoadNorm = normalizeInstruction(codeItems[initLoadIdx] && codeItems[initLoadIdx].instruction);
      if (!initStoreNorm || getLocalIndexFromOp(initStoreNorm.op, initStoreNorm.arg) !== loopVar) {
        continue;
      }
      if (
        !initLoadNorm ||
        !(
          initLoadNorm.op.startsWith('iload') ||
          initLoadNorm.op.startsWith('iconst') ||
          initLoadNorm.op.startsWith('bipush') ||
          initLoadNorm.op.startsWith('sipush')
        )
      ) {
        continue;
      }
      codeItems.splice(initLoadIdx, idx - initLoadIdx + 1);
      changed = true;
      break;
    }
  }
}
