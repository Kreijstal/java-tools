const IMPURE_OPCODE_REASONS = {
  putfield: 'field write',
  putstatic: 'field write',
  getstatic: 'static field read',
  monitorenter: 'monitor operation',
  monitorexit: 'monitor operation',
  athrow: 'exception throw',
  invokedynamic: 'dynamic invocation',
  iastore: 'array write',
  lastore: 'array write',
  fastore: 'array write',
  dastore: 'array write',
  aastore: 'array write',
  bastore: 'array write',
  castore: 'array write',
  sastore: 'array write',
};

const INVOKE_OPS = new Set([
  'invokevirtual',
  'invokespecial',
  'invokestatic',
  'invokeinterface',
]);

function extractInvokeTarget(instruction) {
  if (!instruction || !Array.isArray(instruction.arg)) {
    return null;
  }
  const [, owner, nameDesc] = instruction.arg;
  if (!owner || !Array.isArray(nameDesc)) {
    return null;
  }
  const [name, descriptor] = nameDesc;
  if (!name || !descriptor) {
    return null;
  }
  return `${owner}.${name}${descriptor}`;
}

/**
 * Analyzes the purity of a method based on its Control Flow Graph.
 * A method is considered pure if it has no side effects.
 *
 * @param {import('./cfg').CFG} cfg - The Control Flow Graph of the method.
 * @param {{
 *   knownPureCallees?: Set<string>,
 *   methodSignature?: string,
 *   allowSelfCall?: boolean,
 * }} [options]
 * @returns {{isPure: boolean, reason: string | null}} An object indicating if
 *   the method is pure and a reason if it is not.
 */
function analyzePurityCfg(cfg, options = {}) {
  const {
    knownPureCallees = new Set(),
    methodSignature = null,
    allowSelfCall = true,
  } = options;

  const visitedBlocks = new Set();
  const queue = [cfg.entryBlockId];
  visitedBlocks.add(cfg.entryBlockId);

  while (queue.length > 0) {
    const blockId = queue.shift();
    const block = cfg.blocks.get(blockId);
    if (!block) {
      continue;
    }

    for (const instr of block.instructions) {
      if (!instr || !instr.instruction) {
        continue;
      }
      const op = typeof instr.instruction === 'string' ? instr.instruction : instr.instruction?.op;
      if (!op) {
        continue;
      }

      if (IMPURE_OPCODE_REASONS[op]) {
        return {
          isPure: false,
          reason: `contains impure opcode ${op} (${IMPURE_OPCODE_REASONS[op]})`,
        };
      }

      if (INVOKE_OPS.has(op)) {
        const target = extractInvokeTarget(instr.instruction);
        if (!target) {
          return {
            isPure: false,
            reason: `unresolved invocation for opcode ${op}`,
          };
        }

        if (allowSelfCall && methodSignature && target === methodSignature) {
          continue;
        }

        if (knownPureCallees.has(target)) {
          continue;
        }

        return {
          isPure: false,
          reason: `calls possibly impure method ${target}`,
        };
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
