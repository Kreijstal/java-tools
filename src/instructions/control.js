module.exports = {
  return: (frame, instruction, jvm, thread) => {
    thread.callStack.pop();
    if (thread.isAwaitingReflectiveCall) {
      thread.reflectiveCallResolver(null);
      thread.isAwaitingReflectiveCall = false;
    }
  },
  ireturn: (frame, instruction, jvm, thread) => {
    const returnValue = frame.stack.pop();
    thread.callStack.pop();
    if (thread.isAwaitingReflectiveCall) {
      thread.reflectiveCallResolver(returnValue);
      thread.isAwaitingReflectiveCall = false;
    } else if (!thread.callStack.isEmpty()) {
      thread.callStack.peek().stack.push(returnValue);
    }
  },
  areturn: (frame, instruction, jvm, thread) => {
    const returnValue = frame.stack.pop();
    thread.callStack.pop();
    if (thread.isAwaitingReflectiveCall) {
      thread.reflectiveCallResolver(returnValue);
      thread.isAwaitingReflectiveCall = false;
    } else if (!thread.callStack.isEmpty()) {
      thread.callStack.peek().stack.push(returnValue);
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
  if_icmpeq: (frame, instruction) => {
    const label = instruction.arg;
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (value1 === value2) {
      const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${label}:`);
      if (targetPc !== -1) {
        frame.pc = targetPc;
      } else {
        throw new Error(`Label ${label} not found`);
      }
    }
  },
  ifnull: (frame, instruction) => {
    const label = instruction.arg;
    const value = frame.stack.pop();
    if (value === null) {
      const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${label}:`);
      if (targetPc !== -1) {
        frame.pc = targetPc;
      } else {
        throw new Error(`Label ${label} not found`);
      }
    }
  },
  if_icmpgt: (frame, instruction) => {
    const label = instruction.arg;
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
  if_icmpge: (frame, instruction) => {
    const label = instruction.arg;
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    console.log(`if_icmpge: comparing ${value1} >= ${value2}`);
    if (value1 >= value2) {
      console.log('if_icmpge: jumping');
      const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${label}:`);
      if (targetPc !== -1) {
        frame.pc = targetPc;
      } else {
        throw new Error(`Label ${label} not found`);
      }
    } else {
      console.log('if_icmpge: not jumping');
    }
  },
  ifeq: (frame, instruction) => {
    const label = instruction.arg;
    const value = frame.stack.pop();
    if (value === 0) {
      const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${label}:`);
      if (targetPc !== -1) {
        frame.pc = targetPc;
      } else {
        throw new Error(`Label ${label} not found`);
      }
    }
  },
};
