const { CFG, BasicBlock } = require('./cfg');

/**
 * A set of opcodes that unconditionally end a basic block.
 */
const BLOCK_END_OPCODES = new Set([
  'ret',
  'return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn',
  'athrow',
  'goto',
  'tableswitch',
  'lookupswitch',
]);

/**
 * A set of opcodes that conditionally end a basic block.
 */
const CONDITIONAL_JUMP_OPCODES = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne',
  'ifnull', 'ifnonnull',
  'jsr',
]);

/**
 * Identifies the leaders of basic blocks in a list of instructions.
 * A leader is the first instruction of a basic block.
 * @param {Array<object>} instructions - The codeItems from a method's AST.
 * @returns {Set<number>} A set of the program counters (pc) of leader instructions.
 */
function findLeaders(instructions) {
  const leaders = new Set();
  if (instructions.length === 0) {
    return leaders;
  }

  // The first instruction is always a leader.
  leaders.add(instructions[0].pc);

  // Helper to find the pc for a given label.
  const labelToPc = new Map();
  for (const instruction of instructions) {
    if (instruction.labelDef) {
      const label = instruction.labelDef.replace(':', '');
      labelToPc.set(label, instruction.pc);
    }
  }

  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];
    if (!instr.instruction) continue;
    const op = typeof instr.instruction === 'string' ? instr.instruction : instr.instruction?.op;
    if (!op) continue;

    const isUnconditionalJump = BLOCK_END_OPCODES.has(op);
    const isConditionalJump = CONDITIONAL_JUMP_OPCODES.has(op);

    if (isUnconditionalJump || isConditionalJump) {
      // The instruction *after* a jump is a leader.
      if (i + 1 < instructions.length) {
        leaders.add(instructions[i + 1].pc);
      }

      // The target of a jump is a leader.
      if (instr.instruction.arg) {
        const targetLabel = instr.instruction.arg;
        if (labelToPc.has(targetLabel)) {
          leaders.add(labelToPc.get(targetLabel));
        }
      }
    }
  }
  return leaders;
}


/**
 * Converts a method's AST into a Control Flow Graph.
 * @param {object} method - A method object from the class AST.
 * @returns {CFG} The resulting Control Flow Graph.
 */
function convertAstToCfg(method) {
  const codeAttr = method.attributes.find(attr => attr.type === 'code');
  if (!codeAttr || !codeAttr.code || !codeAttr.code.codeItems) {
    return null;
  }

  const instructions = codeAttr.code.codeItems;
  if (instructions.length === 0) {
    return null;
  }

  const leaders = findLeaders(instructions);

  const entryBlock = new BasicBlock('block_0');
  const cfg = new CFG(entryBlock.id);
  cfg.addBlock(entryBlock);

  let currentBlock = entryBlock;

  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];
    if (i > 0 && leaders.has(instr.pc)) {
        const newBlock = new BasicBlock(`block_${instr.pc}`);
        cfg.addBlock(newBlock);

        const prevInstr = instructions[i - 1];
        if (prevInstr.instruction) {
            const prevOp = typeof prevInstr.instruction === 'string' ? prevInstr.instruction : prevInstr.instruction?.op;
            if (!BLOCK_END_OPCODES.has(prevOp)) {
                cfg.addEdge(currentBlock.id, newBlock.id);
            }
        } else {
             cfg.addEdge(currentBlock.id, newBlock.id);
        }
        currentBlock = newBlock;
    }
    currentBlock.addInstruction(instr);
  }

  // Create jump edges
  for (const block of cfg.blocks.values()) {
    if (block.instructions.length === 0) continue;
    const lastInstr = block.instructions[block.instructions.length - 1];
    if (!lastInstr.instruction) continue;

    const op = typeof lastInstr.instruction === 'string' ? lastInstr.instruction : lastInstr.instruction?.op;

    if (BLOCK_END_OPCODES.has(op) || CONDITIONAL_JUMP_OPCODES.has(op)) {
      if (lastInstr.instruction.arg) {
        // Handle tableswitch/lookupswitch with multiple targets
        if (op === 'tableswitch' || op === 'lookupswitch') {
          const targetLabels = Array.isArray(lastInstr.instruction.arg) ? lastInstr.instruction.arg : [];
          for (const targetLabel of targetLabels) {
            const targetPc = instructions.find(inst => inst.labelDef === `${targetLabel}:`)?.pc;
            if (targetPc !== undefined) {
              cfg.addEdge(block.id, `block_${targetPc}`);
            }
          }
        } else {
          // Single target jump
          const targetLabel = lastInstr.instruction.arg;
          const targetPc = instructions.find(inst => inst.labelDef === `${targetLabel}:`)?.pc;
          if (targetPc !== undefined) {
            cfg.addEdge(block.id, `block_${targetPc}`);
          }
        }
      }
    }
  }

  return cfg;
}

module.exports = { convertAstToCfg, findLeaders };
