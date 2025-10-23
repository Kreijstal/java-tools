const { getStackEffect, normalizeInstruction } = require('./deadCodeEliminator')._internals;

/**
 * A set of opcodes that are considered "essential" and cannot be removed
 * because they have side effects (e.g., I/O, memory writes, control flow).
 */
const ESSENTIAL_OPCODES = new Set([
  // Method invocations
  "invokevirtual", "invokespecial", "invokestatic", "invokeinterface", "invokedynamic",
  // Field writes
  "putfield", "putstatic",
  // Array stores
  "iastore", "lastore", "fastore", "dastore", "aastore", "bastore", "castore", "sastore",
  // Synchronization
  "monitorenter", "monitorexit",
  // Exception throwing
  "athrow",
  // All control flow is inherently essential for graph structure
  "goto", "tableswitch", "lookupswitch", "jsr", "ret",
  "ifeq", "ifne", "iflt", "ifge", "ifgt", "ifle",
  "if_icmpeq", "if_icmpne", "if_icmplt", "if_icmpge", "if_icmpgt", "if_icmple",
  "if_acmpeq", "if_acmpne",
  "ifnull", "ifnonnull",
  // Returns are the final "use" of a value
  "return", "ireturn", "lreturn", "freturn", "dreturn", "areturn",
  // new is essential because it allocates memory
  "new", "newarray", "anewarray", "multianewarray",
]);


/**
 * Builds intra-block def-use chains for a method's CFG.
 * This function annotates each instruction with information about which
 * instructions produce the values it consumes.
 *
 * @param {import('./cfg').CFG} cfg - The Control Flow Graph to analyze.
 */
function buildDefUseChains(cfg) {
  for (const block of cfg.blocks.values()) {
    const stack = [];
    for (const instr of block.instructions) {
      const normalized = normalizeInstruction(instr.instruction);
      if (!normalized) continue;

      const op = normalized.op;
      const effect = getStackEffect(op, normalized);
      if (!effect) continue;

      const consumed = [];
      let remaining = effect.popSlots;
      while (remaining > 0) {
        const producer = stack.pop();
        if (!producer) break; // Should not happen in valid bytecode
        consumed.push(producer);
        remaining -= producer.width;
      }
      instr.consumes = consumed;

      if (effect.pushSlots > 0) {
        stack.push({ producer: instr, width: effect.pushSlots });
      }
    }
    // Note: This simple analysis doesn't handle stack state across blocks.
    // A full analysis would require propagating stack state through the graph.
  }
}


/**
 * Eliminates dead code from a method's CFG using a worklist algorithm.
 *
 * @param {import('./cfg').CFG} cfg - The Control Flow Graph to optimize.
 * @returns {{changed: boolean, optimizedCfg: import('./cfg').CFG}}
 */
function eliminateDeadCodeCfg(cfg) {
  buildDefUseChains(cfg);

  const liveSet = new Set();
  const worklist = [];

  // Initialize worklist with all essential instructions.
  for (const block of cfg.blocks.values()) {
    for (const instr of block.instructions) {
      const op = typeof instr.instruction === 'string' ? instr.instruction : instr.instruction?.op;
      if (op && ESSENTIAL_OPCODES.has(op)) {
        if (!liveSet.has(instr)) {
          liveSet.add(instr);
          worklist.push(instr);
        }
      }
    }
  }

  // Propagate liveness backwards.
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
    block.instructions = block.instructions.filter(instr => liveSet.has(instr));
    if (block.instructions.length < originalCount) {
      changed = true;
    }
  }

  return { changed, optimizedCfg: cfg };
}


module.exports = {
  eliminateDeadCodeCfg
};
