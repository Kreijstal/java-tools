const { getStackEffect, normalizeInstruction } = require('./utils/instructionUtils');
const { applyStackManipulation } = require('./utils/stackManipulation');

const INVOKE_OPS = new Set(['invokevirtual', 'invokespecial', 'invokestatic', 'invokeinterface']);

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
  const handlerBlocks = cfg.handlerBlocks instanceof Set ? cfg.handlerBlocks : new Set();

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
    const normalSuccessors = block.successors.filter((succ) => {
      const isException = exceptionTargets && exceptionTargets.has(succ);
      const isHandler = handlerBlocks.has(succ);
      return !isException && !isHandler;
    });
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

function cloneLocalsMap(locals) {
  if (!locals) {
    return new Map();
  }
  const cloned = new Map();
  locals.forEach((value, key) => {
    cloned.set(key, new Set(value));
  });
  return cloned;
}

function getLocalIndexFromOpcode(op, arg, kind) {
  if (!op) return null;
  const suffixPattern =
    kind === 'store'
      ? /^(?:[ailfd]?store|astore)_(\d+)$/
      : /^(?:[ailfd]?load|aload)_(\d+)$/;
  const baseOps =
    kind === 'store'
      ? new Set(['istore', 'lstore', 'fstore', 'dstore', 'astore'])
      : new Set(['iload', 'lload', 'fload', 'dload', 'aload']);
  const match = op.match(suffixPattern);
  if (match) {
    return Number(match[1]);
  }
  if (baseOps.has(op)) {
    if (typeof arg === 'number') return arg;
    if (typeof arg === 'string' && arg.length) return Number(arg);
  }
  return null;
}

function getLocalStoreIndex(normalized) {
  if (!normalized || !normalized.op) return null;
  if (normalized.op === 'iinc') {
    const varnum = normalized.varnum ?? normalized.index ?? normalized.arg;
    if (typeof varnum === 'number') return varnum;
    if (typeof varnum === 'string' && varnum.length) return Number(varnum);
    return null;
  }
  return getLocalIndexFromOpcode(normalized.op, normalized.arg, 'store');
}

function getLocalLoadIndex(normalized) {
  return getLocalIndexFromOpcode(normalized.op, normalized.arg, 'load');
}

function createLocalConsumeEntry(producer) {
  const pseudoValue = { producer };
  return { width: 0, sources: new Set([pseudoValue]) };
}

const DEBUG_DCE = process.env.DCE_DEBUG === '1';
const DEBUG_DCE_METHOD = process.env.DCE_DEBUG_METHOD || null;

function buildDefUseChains(cfg) {
  const debugKey =
    cfg && cfg.context
      ? `${cfg.context.className || 'Unknown'}.${cfg.context.methodName || '?'}${cfg.context.descriptor || ''}`
      : null;
  const debugEnabled = DEBUG_DCE && (!DEBUG_DCE_METHOD || DEBUG_DCE_METHOD === debugKey);
  const iterationCounts = debugEnabled ? new Map() : null;
  const blockStates = new Map();
  const failedBlocks = new Set();
  const worklist = [cfg.entryBlockId];
  let totalIterations = 0;

  blockStates.set(cfg.entryBlockId, { inStack: [], locals: new Map() });

  const handlerBlocks = cfg.handlerBlocks instanceof Set ? cfg.handlerBlocks : new Set();
  const exceptionSuccessors = cfg.exceptionSuccessors instanceof Map ? cfg.exceptionSuccessors : new Map();
  for (const handlerId of handlerBlocks) {
    if (!blockStates.has(handlerId)) {
      blockStates.set(handlerId, { inStack: [createValueEntry(1)], locals: new Map() });
    }
    if (handlerId !== cfg.entryBlockId) {
      worklist.push(handlerId);
    }
  }

  while (worklist.length > 0) {
    const blockId = worklist.pop();
    totalIterations += 1;
    if (debugEnabled) {
      const currentCount = (iterationCounts.get(blockId) || 0) + 1;
      iterationCounts.set(blockId, currentCount);
      if (currentCount === 1 || currentCount % 100 === 0) {
        console.error(
          `[DCE] visiting ${debugKey} block=${blockId} (#${currentCount}, total ${totalIterations})`,
        );
      }
      if (currentCount > 10000) {
        throw new Error(
          `Def-use analysis appears stuck in ${debugKey} (block ${blockId} exceeded 10000 visits)`,
        );
      }
    }
    if (failedBlocks.has(blockId)) {
      continue;
    }

    const block = cfg.blocks.get(blockId);
    if (!block) {
      continue;
    }

    const state = blockStates.get(blockId);
    const entryStack = state && state.inStack ? cloneStack(state.inStack) : [];
    const entryLocals = state && state.locals ? cloneLocalsMap(state.locals) : new Map();
    const stack = entryStack;
    const locals = entryLocals;

    let blockFailed = false;

    for (const instr of block.instructions) {
      if (!instr) {
        continue;
      }

      instr.consumes = [];
      instr.produced = [];
      if (instr.consumers && typeof instr.consumers.clear === 'function') {
        instr.consumers.clear();
      } else {
        instr.consumers = new Set();
      }
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

      const loadIndex = getLocalLoadIndex(normalized);
      if (loadIndex !== null) {
        const producers = locals.get(loadIndex);
        if (producers) {
          producers.forEach((producer) => {
            if (producer && producer.consumers instanceof Set) {
              producer.consumers.add(instr);
            }
            if (producer) {
              instr.consumes.push(createLocalConsumeEntry(producer));
            }
          });
        }
      }

      const storeIndex = getLocalStoreIndex(normalized);
      if (storeIndex !== null) {
        const previousSet = locals.get(storeIndex);
        if (normalized.op === 'iinc' && previousSet) {
          previousSet.forEach((producer) => {
            if (producer && producer.consumers instanceof Set) {
              producer.consumers.add(instr);
            }
            if (producer) {
              instr.consumes.push(createLocalConsumeEntry(producer));
            }
          });
        }
        locals.set(storeIndex, new Set([instr]));
      }
    }

    if (blockFailed) {
      failedBlocks.add(blockId);
      markBlockUnsupported(block, 'Def-use analysis failed');
      continue;
    }

    const exitStack = stack;
    const exitLocals = locals;
    for (const successorId of block.successors) {
      const successorBlock = cfg.blocks.get(successorId);
      if (!successorBlock || failedBlocks.has(successorId)) {
        continue;
      }

      const exceptionTargets = exceptionSuccessors.get(block.id);
      const isExceptionEdge =
        (exceptionTargets && exceptionTargets.has(successorId)) || handlerBlocks.has(successorId);
      if (isExceptionEdge) {
        if (!blockStates.has(successorId)) {
          blockStates.set(successorId, {
            inStack: [createValueEntry(1)],
            locals: cloneLocalsMap(exitLocals),
          });
          worklist.push(successorId);
        }
        continue;
      }

      const successorState = blockStates.get(successorId);
      const existingStack = successorState ? successorState.inStack : null;
      const mergedStack = mergeStacks(existingStack, exitStack);

      if (mergedStack.incompatible) {
        failedBlocks.add(successorId);
        markBlockUnsupported(successorBlock, 'Incompatible stack shapes at block entry');
        continue;
      }

      const existingLocals = successorState ? successorState.locals : null;
      let localsChanged = false;
      let mergedLocals;
      if (!existingLocals) {
        mergedLocals = cloneLocalsMap(exitLocals);
        localsChanged = true;
      } else {
        mergedLocals = cloneLocalsMap(existingLocals);
        exitLocals.forEach((value, key) => {
          let target = mergedLocals.get(key);
          if (!target) {
            mergedLocals.set(key, new Set(value));
            localsChanged = true;
            return;
          }
          const sizeBefore = target.size;
          value.forEach((producer) => target.add(producer));
          if (target.size !== sizeBefore) {
            localsChanged = true;
          }
        });
      }

      if (mergedStack.changed || localsChanged || !successorState) {
        blockStates.set(successorId, { inStack: mergedStack.stack, locals: mergedLocals });
        worklist.push(successorId);
      }
    }
  }
}

function blockNeedsForcedLiveness(block) {
  if (!block || !Array.isArray(block.instructions)) {
    return false;
  }
  for (const instr of block.instructions) {
    if (!instr || !instr.instruction) {
      continue;
    }
    const normalized = normalizeInstruction(instr.instruction);
    if (!normalized || !normalized.op) {
      continue;
    }
    const effect = getStackEffect(normalized.op, normalized);
    if (!effect || effect.popSlots <= 0) {
      continue;
    }
    if (!Array.isArray(instr.consumes) || instr.consumes.length === 0) {
      return true;
    }
    const hasSources = instr.consumes.every(
      (entry) => entry && entry.sources instanceof Set && entry.sources.size > 0,
    );
    if (!hasSources) {
      return true;
    }
  }
  return false;
}

function eliminateDeadCodeCfg(cfg, options = {}) {
  const removedBlocks = pruneUnreachableBlocks(cfg);
  buildDefUseChains(cfg);
  linkConsumers(cfg);

  const forceLiveBlocks = new Set();
  for (const block of cfg.blocks.values()) {
    if (blockNeedsForcedLiveness(block)) {
      forceLiveBlocks.add(block);
    }
  }

  const liveSet = new Set();
  const worklist = [];

  const handlerBlocks = cfg.handlerBlocks instanceof Set ? cfg.handlerBlocks : new Set();

  for (const block of cfg.blocks.values()) {
    const isHandlerBlock = handlerBlocks.has(block.id);
    for (const instr of block.instructions) {
      if (!instr || !instr.instruction) {
        continue;
      }
      if (isHandlerBlock) {
        liveSet.add(instr);
        worklist.push(instr);
        enqueueConsumers(instr, liveSet, worklist);
        continue;
      }
      if (instr.unsupported) {
        liveSet.add(instr);
        continue;
      }
      const op = typeof instr.instruction === 'string' ? instr.instruction : instr.instruction?.op;
      const isInvoke = op && INVOKE_OPS.has(op);
      const invokeSignature = isInvoke ? getInvocationSignature(instr.instruction) : null;
      const pureInvoke =
        isInvoke &&
        typeof options.isInvocationPure === 'function' &&
        invokeSignature &&
        options.isInvocationPure(invokeSignature);
      if (op && ESSENTIAL_OPCODES.has(op) && !pureInvoke) {
        if (!liveSet.has(instr)) {
          liveSet.add(instr);
          worklist.push(instr);
          enqueueConsumers(instr, liveSet, worklist);
        }
        continue;
      }
    }
  }

  if (forceLiveBlocks.size > 0) {
    for (const block of forceLiveBlocks) {
      if (!block || !Array.isArray(block.instructions)) {
        continue;
      }
      for (const instr of block.instructions) {
        if (!instr || !instr.instruction || liveSet.has(instr)) {
          continue;
        }
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
          enqueueConsumers(producer, liveSet, worklist);
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
      const live = liveSet.has(instr);
      instr.__live = live;
      return live;
    });
    if (block.instructions.length < originalCount) {
      changed = true;
    }
  }

  const simplifiedGoto = simplifyTrivialGotos(cfg);

  return { changed: changed || removedBlocks || simplifiedGoto, optimizedCfg: cfg };
}

function linkConsumers(cfg) {
  for (const block of cfg.blocks.values()) {
    for (const instr of block.instructions) {
      if (!instr || !Array.isArray(instr.consumes)) {
        continue;
      }
      for (const consumed of instr.consumes) {
        if (!consumed || !consumed.sources) {
          continue;
        }
        for (const producedValue of consumed.sources) {
          const producer = producedValue && producedValue.producer;
          if (producer && producer.consumers instanceof Set) {
            producer.consumers.add(instr);
          }
        }
      }
    }
  }
}

function enqueueConsumers(instr, liveSet, worklist) {
  if (!instr || !(instr.consumers instanceof Set)) {
    return;
  }
  instr.consumers.forEach((consumer) => {
    if (consumer && !liveSet.has(consumer)) {
      liveSet.add(consumer);
      worklist.push(consumer);
    }
  });
}

function getInvocationSignature(instruction) {
  if (!instruction || typeof instruction !== 'object') {
    return null;
  }
  const arg = instruction.arg;
  if (!Array.isArray(arg) || arg.length < 3) {
    return null;
  }
  const owner = arg[1];
  const nameDesc = arg[2];
  if (!owner || !Array.isArray(nameDesc) || nameDesc.length < 2) {
    return null;
  }
  const [name, descriptor] = nameDesc;
  if (!name || !descriptor) {
    return null;
  }
  return `${owner}.${name}${descriptor}`;
}

module.exports = {
  eliminateDeadCodeCfg,
};
