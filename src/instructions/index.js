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
  const op = typeof instruction === 'string' ? instruction : instruction.op;

  const func = instructions[op];
  if (func) {
    await func(frame, instruction, jvm, thread);
  } else {
    throw new Error(`Unknown or unimplemented instruction: ${op}`);
  }
};
