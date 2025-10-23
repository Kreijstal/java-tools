const IMPURE_OPCODE_REASONS = {
  putfield: "field write",
  putstatic: "field write",
  monitorenter: "monitor operation",
  monitorexit: "monitor operation",
  athrow: "exception throw",
  invokedynamic: "dynamic invocation",
  iastore: "array write",
  lastore: "array write",
  fastore: "array write",
  dastore: "array write",
  aastore: "array write",
  bastore: "array write",
  castore: "array write",
  sastore: "array write",
};

const INVOKE_OPS = new Set([
  "invokevirtual",
  "invokespecial",
  "invokestatic",
  "invokeinterface",
]);

/**
 * Analyzes the purity of a method based on its Control Flow Graph.
 * A method is considered pure if it has no side effects.
 *
 * @param {import('./cfg').CFG} cfg - The Control Flow Graph of the method.
 * @returns {{isPure: boolean, reason: string | null}} An object indicating if
 *   the method is pure and a reason if it is not.
 */
function analyzePurityCfg(cfg) {
  const visitedBlocks = new Set();
  const queue = [cfg.entryBlockId];
  visitedBlocks.add(cfg.entryBlockId);

  while (queue.length > 0) {
    const blockId = queue.shift();
    const block = cfg.blocks.get(blockId);

    for (const instr of block.instructions) {
      if (!instr.instruction) continue;
      const op = typeof instr.instruction === 'string' ? instr.instruction : instr.instruction?.op;
      if (!op) continue;

      if (IMPURE_OPCODE_REASONS[op]) {
        return { isPure: false, reason: `contains impure opcode ${op} (${IMPURE_OPCODE_REASONS[op]})` };
      }

      if (INVOKE_OPS.has(op)) {
         return { isPure: false, reason: `calls another method (${op}), which is potentially impure` };
      }
    }

    for (const successorId of block.successors) {
      if (!visitedBlocks.has(successorId)) {
        visitedBlocks.add(successorId);
        queue.push(successorId);
      }
    }
  }

  return { isPure: true, reason: null };
}

module.exports = {
  analyzePurityCfg,
};
