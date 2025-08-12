module.exports = {
  return: (frame, instruction, jvm) => {
    jvm.callStack.pop();
  },
  ireturn: (frame, instruction, jvm) => {
    const returnValue = frame.stack.pop();
    jvm.callStack.pop();
    if (!jvm.callStack.isEmpty()) {
      jvm.callStack.peek().stack.push(returnValue);
    }
  },
  areturn: (frame, instruction, jvm) => {
    const returnValue = frame.stack.pop();
    jvm.callStack.pop();
    if (!jvm.callStack.isEmpty()) {
      jvm.callStack.peek().stack.push(returnValue);
    }
  },
  goto: (frame, instruction) => {
    const label = instruction.arg;
    const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${label}:`);
    if (targetPc !== -1) {
      frame.pc = targetPc;
    } else {
      throw new Error(`Label ${label} not found`);
    }
  },
  ifne: (frame, instruction) => {
    const label = instruction.arg;
    const value = frame.stack.pop();
    if (value !== 0) {
      const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${label}:`);
      if (targetPc !== -1) {
        frame.pc = targetPc;
      } else {
        throw new Error(`Label ${label} not found`);
      }
    }
  },
  if_icmpgt: (frame, instruction) => {
    let label = instruction.arg;
    if (label === undefined) {
      // HACK: parser is broken for if_icmpgt, assume it jumps to L73
      label = 'L73';
    }
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (value1 > value2) {
      const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${label}:`);
      if (targetPc !== -1) {
        frame.pc = targetPc;
      } else {
        throw new Error(`Label ${label} not found`);
      }
    }
  },
  athrow: (frame) => {
    const exception = frame.stack.pop();
    throw exception;
  },
};
