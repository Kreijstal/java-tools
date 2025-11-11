const { getStackEffect, normalizeInstruction } = require('./utils/instructionUtils');
const { applyStackManipulation } = require('./utils/stackManipulation');

function pruneUnreachableBlocks(cfg) {
  if (!cfg || !cfg.entryBlockId) {
    return false;
  }

  const reachable = new Set();
  const worklist = [cfg.entryBlockId];

  while (worklist.length > 0) {
    const blockId = worklist.pop();
    if (reachable.has(blockId)) {
      continue;
    }
    const block = cfg.blocks.get(blockId);
    if (!block) {
      continue;
    }
    reachable.add(blockId);
    for (const successorId of block.successors) {
      if (!reachable.has(successorId)) {
        worklist.push(successorId);
      }
    }
  }

  const unreachable = [];
  for (const id of cfg.blocks.keys()) {
    if (!reachable.has(id)) {
      unreachable.push(id);
    }
  }

  if (unreachable.length === 0) {
    return false;
  }

  for (const block of cfg.blocks.values()) {
    block.successors = block.successors.filter((succ) => reachable.has(succ));
    block.predecessors = block.predecessors.filter((pred) => reachable.has(pred));
  }

  for (const id of unreachable) {
    cfg.blocks.delete(id);
  }

  if (cfg.handlerBlocks instanceof Set) {
    for (const id of unreachable) {
      cfg.handlerBlocks.delete(id);
    }
  }

  if (cfg.exceptionSuccessors instanceof Map) {
    for (const [blockId, targets] of cfg.exceptionSuccessors.entries()) {
      if (!reachable.has(blockId)) {
        cfg.exceptionSuccessors.delete(blockId);
        continue;
      }
      for (const id of unreachable) {
        targets.delete(id);
      }
      if (targets.size === 0) {
        cfg.exceptionSuccessors.delete(blockId);
      }
    }
  }

  return true;
}

function getOpcodeFromInstruction(instruction) {
  if (!instruction) {
    return null;
  }
  if (typeof instruction === 'string') {
    return instruction;
  }
  if (typeof instruction === 'object' && instruction.op) {
    return instruction.op;
  }
  return null;
}

function findLastInstructionIndex(block) {
  if (!block || !Array.isArray(block.instructions)) {
    return -1;
  }
  for (let i = block.instructions.length - 1; i >= 0; i -= 1) {
    const entry = block.instructions[i];
    if (entry && entry.instruction) {
      return i;
    }
  }
  return -1;
}

function getBlockStart(block, entryId) {
  if (!block) {
    return Number.POSITIVE_INFINITY;
  }
  if (block.id === entryId) {
    return Number.NEGATIVE_INFINITY;
  }
  for (const entry of block.instructions) {
    if (entry && typeof entry.pc === 'number') {
      return entry.pc;
    }
  }
  return Number.POSITIVE_INFINITY;
}

function simplifyTrivialGotos(cfg) {
  if (!cfg || cfg.blocks.size === 0) {
    return false;
  }

  const orderedBlocks = Array.from(cfg.blocks.values()).sort(
    (a, b) => getBlockStart(a, cfg.entryBlockId) - getBlockStart(b, cfg.entryBlockId),
  );
  const blockOrder = new Map();
  orderedBlocks.forEach((block, index) => {
    blockOrder.set(block.id, index);
  });

  const exceptionSuccessors =
    cfg.exceptionSuccessors instanceof Map ? cfg.exceptionSuccessors : new Map();

  let changed = false;

  for (const block of orderedBlocks) {
    const lastIndex = findLastInstructionIndex(block);
    if (lastIndex === -1) {
      continue;
    }
    const entry = block.instructions[lastIndex];
    const opcode = getOpcodeFromInstruction(entry.instruction);
    if (opcode !== 'goto') {
      continue;
    }

    const exceptionTargets = exceptionSuccessors.get(block.id);
    const normalSuccessors = block.successors.filter(
      (succ) => !exceptionTargets || !exceptionTargets.has(succ),
    );
    if (normalSuccessors.length !== 1) {
      continue;
    }

    const targetId = normalSuccessors[0];
    const nextBlock = orderedBlocks[blockOrder.get(block.id) + 1];
    if (!nextBlock || nextBlock.id !== targetId) {
      continue;
    }

    block.instructions.splice(lastIndex, 1);
    changed = true;
  }

  return changed;
}

const ESSENTIAL_OPCODES = new Set([
  'invokevirtual', 'invokespecial', 'invokestatic', 'invokeinterface', 'invokedynamic',
  'putfield', 'putstatic', 'getstatic',
  'iastore', 'lastore', 'fastore', 'dastore', 'aastore', 'bastore', 'castore', 'sastore',
  'monitorenter', 'monitorexit',
  'athrow',
  'goto', 'tableswitch', 'lookupswitch', 'jsr', 'ret',
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne',
  'ifnull', 'ifnonnull',
  'return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn',
  'new', 'newarray', 'anewarray', 'multianewarray',
]);

function createValueEntry(width, sources = []) {
  return { width, sources: new Set(sources) };
}

function cloneValueEntry(entry) {
  return createValueEntry(entry.width, entry.sources);
}

function cloneStack(stack) {
  return stack.map(cloneValueEntry);
}

function mergeStacks(existing, incoming) {
  if (!existing) {
    return { stack: cloneStack(incoming), changed: true };
  }
  if (existing.length !== incoming.length) {
    return { incompatible: true };
  }

  let changed = false;
  const merged = [];
  for (let i = 0; i < existing.length; i += 1) {
    const current = existing[i];
    const next = incoming[i];
    if (!current || !next || current.width !== next.width) {
      return { incompatible: true };
    }
    const sources = new Set(current.sources);
    for (const source of next.sources) {
      if (!sources.has(source)) {
        sources.add(source);
        changed = true;
      }
    }
    merged.push(createValueEntry(current.width, sources));
  }

  return { stack: merged, changed };
}

function markBlockUnsupported(block, reason) {
  for (const instr of block.instructions) {
    if (!instr || !instr.instruction) {
      continue;
    }
    instr.unsupported = true;
    instr.error = reason;
  }
}

function pushProducedValue(instr, stack, width) {
  const producedValue = { producer: instr, width };
  instr.produced.push(producedValue);
  stack.push(createValueEntry(width, [producedValue]));
}

function handleStackManipulation(instr, effect, consumed, stack) {
  return applyStackManipulation(effect, consumed, stack, {
    pushOriginal: (value) => {
      stack.push(value);
      return true;
    },
    pushDuplicate: (value) => {
      pushProducedValue(instr, stack, value.width);
      return true;
    },
  });
}

function buildDefUseChains(cfg) {
  const blockStates = new Map();
  const failedBlocks = new Set();
  const worklist = [cfg.entryBlockId];

  blockStates.set(cfg.entryBlockId, { inStack: [] });

  const handlerBlocks = cfg.handlerBlocks instanceof Set ? cfg.handlerBlocks : new Set();
  const exceptionSuccessors = cfg.exceptionSuccessors instanceof Map ? cfg.exceptionSuccessors : new Map();
  for (const handlerId of handlerBlocks) {
    if (!blockStates.has(handlerId)) {
      blockStates.set(handlerId, { inStack: [createValueEntry(1)] });
    }
    if (handlerId !== cfg.entryBlockId) {
      worklist.push(handlerId);
    }
  }

  while (worklist.length > 0) {
    const blockId = worklist.pop();
    if (failedBlocks.has(blockId)) {
      continue;
    }

    const block = cfg.blocks.get(blockId);
    if (!block) {
      continue;
    }

    const state = blockStates.get(blockId);
    const entryStack = state && state.inStack ? cloneStack(state.inStack) : [];
    const stack = entryStack;

    let blockFailed = false;

    for (const instr of block.instructions) {
      if (!instr) {
        continue;
      }

      instr.consumes = [];
      instr.produced = [];
      delete instr.unsupported;
      delete instr.error;

      if (!instr.instruction) {
        continue;
      }

      const normalized = normalizeInstruction(instr.instruction);
      if (!normalized || !normalized.op) {
        instr.unsupported = true;
        instr.error = 'Unsupported instruction format';
        blockFailed = true;
        continue;
      }

      const effect = getStackEffect(normalized.op, normalized);
      if (!effect) {
        instr.unsupported = true;
        instr.error = `Unsupported opcode ${normalized.op}`;
        blockFailed = true;
        continue;
      }

      instr.effect = effect;

      const consumed = [];
      let remaining = effect.popSlots;
      let underflow = false;

      while (remaining > 0) {
        const value = stack.pop();
        if (!value) {
          underflow = true;
          break;
        }
        consumed.push(value);
        remaining -= value.width;
      }

      if (underflow || remaining !== 0) {
        instr.unsupported = true;
        instr.error = 'Stack underflow during def-use chain construction';
        blockFailed = true;
        continue;
      }

      instr.consumes = consumed;

      if (effect.special) {
        const handled = handleStackManipulation(instr, effect, consumed, stack);
        if (!handled) {
          instr.unsupported = true;
          instr.error = `Unsupported stack manipulation for ${effect.special}`;
          blockFailed = true;
        }
        continue;
      }

      if (effect.pushSlots > 0) {
        const producedValue = { producer: instr, width: effect.pushSlots };
        instr.produced.push(producedValue);
        stack.push(createValueEntry(effect.pushSlots, [producedValue]));
      }
    }

    if (blockFailed) {
      failedBlocks.add(blockId);
      markBlockUnsupported(block, 'Def-use analysis failed');
      continue;
    }

    const exitStack = stack;
    for (const successorId of block.successors) {
      const successorBlock = cfg.blocks.get(successorId);
      if (!successorBlock || failedBlocks.has(successorId)) {
        continue;
      }

      const exceptionTargets = exceptionSuccessors.get(block.id);
      const isExceptionEdge = exceptionTargets && exceptionTargets.has(successorId);
      if (isExceptionEdge) {
        if (!blockStates.has(successorId)) {
          blockStates.set(successorId, { inStack: [createValueEntry(1)] });
          worklist.push(successorId);
        }
        continue;
      }

      const successorState = blockStates.get(successorId);
      const existingStack = successorState ? successorState.inStack : null;
      const merged = mergeStacks(existingStack, exitStack);

      if (merged.incompatible) {
        failedBlocks.add(successorId);
        markBlockUnsupported(successorBlock, 'Incompatible stack shapes at block entry');
        continue;
      }

      if (merged.changed || !successorState) {
        blockStates.set(successorId, { inStack: merged.stack });
        worklist.push(successorId);
      }
    }
  }
}

function eliminateDeadCodeCfg(cfg) {
  const removedBlocks = pruneUnreachableBlocks(cfg);
  buildDefUseChains(cfg);

  const liveSet = new Set();
  const worklist = [];

  for (const block of cfg.blocks.values()) {
    for (const instr of block.instructions) {
      if (!instr || !instr.instruction) {
        continue;
      }
      if (instr.unsupported) {
        liveSet.add(instr);
        continue;
      }
      const op = typeof instr.instruction === 'string' ? instr.instruction : instr.instruction?.op;
      if (op && ESSENTIAL_OPCODES.has(op) && !liveSet.has(instr)) {
        liveSet.add(instr);
        worklist.push(instr);
      }
    }
  }

  while (worklist.length > 0) {
    const current = worklist.pop();
    if (!current.consumes) {
      continue;
    }
    for (const consumed of current.consumes) {
      if (!consumed || !consumed.sources) {
        continue;
      }
      for (const producedValue of consumed.sources) {
        const producer = producedValue && producedValue.producer;
        if (producer && !liveSet.has(producer)) {
          liveSet.add(producer);
          worklist.push(producer);
        }
      }
    }
  }

  let changed = false;
  for (const block of cfg.blocks.values()) {
    const originalCount = block.instructions.length;
    block.instructions = block.instructions.filter((instr) => {
      if (!instr || !instr.instruction) {
        return true;
      }
      return liveSet.has(instr);
    });
    if (block.instructions.length < originalCount) {
      changed = true;
    }
  }

  const simplifiedGoto = simplifyTrivialGotos(cfg);

  return { changed: changed || removedBlocks || simplifiedGoto, optimizedCfg: cfg };
}

module.exports = {
  eliminateDeadCodeCfg,
};
