const constants = require('./constants');
const loads = require('./loads');
const stores = require('./stores');
const stack = require('./stack');
const math = require('./math');
const control = require('./control');
const invoke = require('./invoke');
const object = require('./object');
const conversions = require('./conversions');

const instructions = {
  ...constants,
  ...loads,
  ...stores,
  ...stack,
  ...math,
  ...control,
  ...invoke,
  ...object,
  ...conversions,
};

function expandWideInstruction(instruction) {
  if (!instruction || typeof instruction.arg !== 'string') {
    throw new Error('Invalid wide instruction format');
  }

  const parts = instruction.arg.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`Invalid wide instruction operands: ${instruction.arg}`);
  }

  const [baseOp, ...operands] = parts;

  switch (baseOp) {
    case 'iinc': {
      if (operands.length !== 2) {
        throw new Error(`Invalid wide iinc operands: ${instruction.arg}`);
      }
      const [index, amount] = operands;
      return {
        op: baseOp,
        varnum: index,
        incr: amount,
      };
    }
    case 'iload':
    case 'lload':
    case 'fload':
    case 'dload':
    case 'aload':
    case 'istore':
    case 'lstore':
    case 'fstore':
    case 'dstore':
    case 'astore':
    case 'ret': {
      if (operands.length !== 1) {
        throw new Error(`Invalid wide ${baseOp} operands: ${instruction.arg}`);
      }
      const [index] = operands;
      return {
        op: baseOp,
        arg: index,
      };
    }
    default:
      throw new Error(`Unsupported wide instruction target: ${baseOp}`);
  }
}

module.exports = async function dispatch(frame, instruction, jvm, thread) {
  if (jvm.verbose) {
    const threadId = thread ? thread.id : 'main';
    let pc = -1;
    if (frame.pc < frame.instructions.length) {
      const instructionItem = frame.instructions[frame.pc - 1];
      if (instructionItem) {
        const label = instructionItem.labelDef;
        pc = label ? parseInt(label.substring(1, label.length - 1)) : -1;
      }
    }
    const threadStates = jvm.threads.map(t => t.status.slice(0, 1).toUpperCase()).join('');
    const stackSize = frame.stack.size();
    const threadStatus = jvm.threads.map((t, i) => `  Thread ${i}: ${t.status}`).join('\n');

    const className = jvm.findClassNameForMethod(frame.method);
    console.log(`[${threadStates}] [thread:${threadId}, pc:${className}.${frame.method.name} ${pc}, stack:${stackSize}]`, instruction);
  }
  let currentInstruction = instruction;
  let op = typeof currentInstruction === 'string' ? currentInstruction : currentInstruction.op;

  if (op === 'wide') {
    currentInstruction = expandWideInstruction(currentInstruction);
    op = currentInstruction.op;
  }

  const func = instructions[op];
  if (func) {
    await func(frame, currentInstruction, jvm, thread);
  } else {
    throw new Error(`Unknown or unimplemented instruction: ${op}`);
  }
};
