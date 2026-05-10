const { CFG, BasicBlock } = require('./cfg');

const BLOCK_END_OPCODES = new Set([
  'ret',
  'return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn',
  'athrow',
  'goto',
  'tableswitch',
  'lookupswitch',
]);

const CONDITIONAL_JUMP_OPCODES = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne',
  'ifnull', 'ifnonnull',
  'jsr',
]);

function normalizeLabelName(label) {
  if (typeof label !== 'string') {
    return null;
  }
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

function getOpcode(instruction) {
  if (!instruction) {
    return null;
  }
  if (typeof instruction === 'string') {
    return instruction;
  }
  return instruction.op || null;
}

function getJumpTargets(opcode, instruction) {
  if (!opcode || !instruction) {
    return [];
  }

  if (opcode === 'tableswitch') {
    const targets = [];
    if (Array.isArray(instruction.labels)) {
      targets.push(...instruction.labels);
    }
    if (instruction.defaultLbl) {
      targets.push(instruction.defaultLbl);
    }
    return targets;
  }

  if (opcode === 'lookupswitch') {
    const targets = [];
    const { arg } = instruction;
    if (arg) {
      if (Array.isArray(arg.pairs)) {
        for (const pair of arg.pairs) {
          if (Array.isArray(pair) && pair[1]) {
            targets.push(pair[1]);
          }
        }
      }
      if (arg.defaultLabel) {
        targets.push(arg.defaultLabel);
      }
    }
    return targets;
  }

  if (typeof instruction.arg === 'string') {
    return [instruction.arg];
  }

  return [];
}

function findLastInstruction(block) {
  for (let i = block.instructions.length - 1; i >= 0; i -= 1) {
    const candidate = block.instructions[i];
    if (candidate && candidate.instruction) {
      return candidate;
    }
  }
  return null;
}

function findLeaders(instructions, exceptionTable = []) {
  const leaders = new Set();
  const labelToPc = new Map();
  const pcToInstruction = new Map();

  for (const instruction of instructions) {
    if (instruction.labelDef) {
      const labelName = normalizeLabelName(instruction.labelDef);
      if (labelName !== null && instruction.pc !== undefined) {
        labelToPc.set(labelName, instruction.pc);
      }
    }
    if (instruction.pc !== undefined) {
      pcToInstruction.set(instruction.pc, instruction);
    }
  }

  if (instructions.length > 0 && instructions[0].pc !== undefined) {
    leaders.add(instructions[0].pc);
  }

  const addLeaderByLabel = (label) => {
    const labelName = normalizeLabelName(label);
    if (!labelName) {
      return;
    }
    const targetPc = labelToPc.get(labelName);
    if (targetPc !== undefined) {
      leaders.add(targetPc);
    }
  };

  const addFallthroughLeader = (startIndex) => {
    for (let cursor = startIndex; cursor < instructions.length; cursor += 1) {
      const candidate = instructions[cursor];
      if (candidate && candidate.pc !== undefined) {
        leaders.add(candidate.pc);
        break;
      }
    }
  };

  for (let i = 0; i < instructions.length; i += 1) {
    const item = instructions[i];
    if (!item || !item.instruction) {
      continue;
    }
    const opcode = getOpcode(item.instruction);
    if (!opcode) {
      continue;
    }

    const isUnconditionalJump = BLOCK_END_OPCODES.has(opcode);
    const isConditionalJump = CONDITIONAL_JUMP_OPCODES.has(opcode);

    if (isUnconditionalJump || isConditionalJump) {
      addFallthroughLeader(i + 1);

      const targets = getJumpTargets(opcode, item.instruction);
      for (const target of targets) {
        addLeaderByLabel(target);
      }
    }
  }

  for (const entry of exceptionTable) {
    if (!entry || typeof entry.handler_pc !== 'number') {
      continue;
    }
    const handlerInstruction = pcToInstruction.get(entry.handler_pc);
    if (handlerInstruction && handlerInstruction.pc !== undefined) {
      leaders.add(handlerInstruction.pc);
    }
  }

  return { leaders, labelToPc, pcToInstruction };
}

function convertAstToCfg(method) {
  const codeAttr = method.attributes.find((attr) => attr.type === 'code');
  if (!codeAttr || !codeAttr.code) {
    return null;
  }

  const { code } = codeAttr;
  const instructions = Array.isArray(code.codeItems) ? code.codeItems : [];
  const exceptionTable = Array.isArray(code.exceptionTable) ? code.exceptionTable : [];

  const entryBlock = new BasicBlock('block_0');
  const cfg = new CFG(entryBlock.id);
  cfg.handlerBlocks = new Set();
  cfg.exceptionSuccessors = new Map();
  cfg.addBlock(entryBlock);

  if (instructions.length === 0) {
    return cfg;
  }

  const { leaders, labelToPc, pcToInstruction } = findLeaders(instructions, exceptionTable);

  let currentBlock = entryBlock;
  const pcToBlockId = new Map();

  for (let i = 0; i < instructions.length; i += 1) {
    const instr = instructions[i];
    if (i === 0) {
      // entry block already created
    } else if (instr.pc !== undefined && leaders.has(instr.pc)) {
      const previousBlock = currentBlock;
      const newBlock = new BasicBlock(`block_${instr.pc}`);
      cfg.addBlock(newBlock);
      currentBlock = newBlock;

      const prevInstruction = instructions[i - 1];
      const prevOpcode = prevInstruction && getOpcode(prevInstruction.instruction);
      if (!prevInstruction || !prevInstruction.instruction || !BLOCK_END_OPCODES.has(prevOpcode)) {
        cfg.addEdge(previousBlock.id, newBlock.id);
      }
    }

    currentBlock.addInstruction(instr);

    if (instr.pc !== undefined) {
      pcToBlockId.set(instr.pc, currentBlock.id);
    }
  }

  const resolveLabelToBlock = (label) => {
    const labelName = normalizeLabelName(label);
    if (!labelName) {
      return null;
    }
    const targetPc = labelToPc.get(labelName);
    if (targetPc === undefined) {
      return null;
    }
    return pcToBlockId.get(targetPc) || null;
  };

  const addJumpEdges = (fromBlock, instruction) => {
    const targets = getJumpTargets(getOpcode(instruction), instruction);
    for (const target of targets) {
      const blockId = resolveLabelToBlock(target);
      if (blockId) {
        cfg.addEdge(fromBlock.id, blockId);
      }
    }
  };

  for (const block of cfg.blocks.values()) {
    if (!block || !Array.isArray(block.instructions)) {
      continue;
    }
    for (const entry of block.instructions) {
      if (!entry || !entry.instruction) {
        continue;
      }
      const opcode = getOpcode(entry.instruction);
      if (!opcode) {
        continue;
      }
      if (CONDITIONAL_JUMP_OPCODES.has(opcode)) {
        addJumpEdges(block, entry.instruction);
        continue;
      }
      if (BLOCK_END_OPCODES.has(opcode)) {
        addJumpEdges(block, entry.instruction);
        break;
      }
    }
  }

  const handlerEntries = [];
  for (const entry of exceptionTable) {
    if (!entry || typeof entry.start_pc !== 'number' || typeof entry.end_pc !== 'number') {
      continue;
    }
    const handlerInstruction = pcToInstruction.get(entry.handler_pc);
    if (!handlerInstruction || handlerInstruction.pc === undefined) {
      continue;
    }
    const handlerBlockId = pcToBlockId.get(handlerInstruction.pc);
    if (!handlerBlockId) {
      continue;
    }
    cfg.handlerBlocks.add(handlerBlockId);
    handlerEntries.push({
      start: entry.start_pc,
      end: entry.end_pc,
      handlerBlockId,
    });
  }

  const blockRanges = [];
  for (const block of cfg.blocks.values()) {
    if (!block || block.instructions.length === 0) {
      continue;
    }
    const blockStart = block.instructions[0].pc;
    const blockEndInstruction = findLastInstruction(block);
    const blockEnd = blockEndInstruction ? blockEndInstruction.pc : blockStart;
    blockRanges.push({ block, start: blockStart, end: blockEnd });
  }

  for (const { block, start, end } of blockRanges) {
    if (!block || start === undefined || end === undefined) {
      continue;
    }
    for (const handler of handlerEntries) {
      if (
        handler &&
        handler.start !== undefined &&
        handler.end !== undefined &&
        handler.handlerBlockId &&
        end >= handler.start &&
        start < handler.end
      ) {
        const handlerBlockId = handler.handlerBlockId;
        cfg.addEdge(block.id, handlerBlockId);
        let targets = cfg.exceptionSuccessors.get(block.id);
        if (!targets) {
          targets = new Set();
          cfg.exceptionSuccessors.set(block.id, targets);
        }
        targets.add(handlerBlockId);
      }
    }
  }

  return cfg;
}

module.exports = { convertAstToCfg, findLeaders };
