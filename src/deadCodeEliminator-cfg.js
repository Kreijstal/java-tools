const { getStackEffect, normalizeInstruction } = require('./deadCodeEliminator')._internals;

const ESSENTIAL_OPCODES = new Set([
  "invokevirtual", "invokespecial", "invokestatic", "invokeinterface", "invokedynamic",
  "putfield", "putstatic",
  "iastore", "lastore", "fastore", "dastore", "aastore", "bastore", "castore", "sastore",
  "monitorenter", "monitorexit",
  "athrow",
  "goto", "tableswitch", "lookupswitch", "jsr", "ret",
  "ifeq", "ifne", "iflt", "ifge", "ifgt", "ifle",
  "if_icmpeq", "if_icmpne", "if_icmplt", "if_icmpge", "if_icmpgt", "if_icmple",
  "if_acmpeq", "if_acmpne",
  "ifnull", "ifnonnull",
  "return", "ireturn", "lreturn", "freturn", "dreturn", "areturn",
  "new", "newarray", "anewarray", "multianewarray",
]);

function buildDefUseChains(cfg) {
  for (const block of cfg.blocks.values()) {
    const stack = [];
    for (const instr of block.instructions) {
      if (!instr.instruction) continue;
      const normalized = normalizeInstruction(instr.instruction);
      if (!normalized) continue;

      const op = normalized.op;
      const effect = getStackEffect(op, normalized);
      if (!effect) continue;

      const consumed = [];
      let remaining = effect.popSlots;
      let stackUnderflow = false;
      while (remaining > 0) {
        const producer = stack.pop();
        if (!producer) {
          stackUnderflow = true;
          break;
        }
        consumed.push(producer);
        remaining -= producer.width;
      }
      if (stackUnderflow) {
        instr.unsupported = true;
        instr.error = "Stack underflow during def-use chain construction";
        continue;
      }
      instr.consumes = consumed;

      if (effect.pushSlots > 0) {
        stack.push({ producer: instr, width: effect.pushSlots });
      }
    }
  }
}

function eliminateDeadCodeCfg(cfg) {
  buildDefUseChains(cfg);

  const liveSet = new Set();
  const worklist = [];

  for (const block of cfg.blocks.values()) {
    for (const instr of block.instructions) {
      if (!instr.instruction) continue;
      const op = typeof instr.instruction === 'string' ? instr.instruction : instr.instruction?.op;
      if (op && ESSENTIAL_OPCODES.has(op) && !liveSet.has(instr)) {
            liveSet.add(instr);
            worklist.push(instr);
      }

    }
  }

  while (worklist.length > 0) {
    const current = worklist.pop();
    if (current.consumes) {
      for (const consumed of current.consumes) {
        const producer = consumed.producer;
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
    block.instructions = block.instructions.filter(instr => {
        if (!instr.instruction) return true; // keep label-only items
        return liveSet.has(instr)
    });
    if (block.instructions.length < originalCount) {
      changed = true;
    }
  }

  return { changed, optimizedCfg: cfg };
}


module.exports = {
  eliminateDeadCodeCfg
};
