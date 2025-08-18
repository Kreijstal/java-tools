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
    if (value1 >= value2) {
      const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${label}:`);
      if (targetPc !== -1) {
        frame.pc = targetPc;
      } else {
        throw new Error(`Label ${label} not found`);
      }
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
  if_icmpne: (frame, instruction) => {
    const label = instruction.arg;
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (value1 !== value2) {
      const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${label}:`);
      if (targetPc !== -1) {
        frame.pc = targetPc;
      } else {
        throw new Error(`Label ${label} not found`);
      }
    }
  },
  if_acmpeq: (frame, instruction) => {
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
  if_acmpne: (frame, instruction) => {
    const label = instruction.arg;
    const value2 = frame.stack.pop();
    const value1 = frame.stack.pop();
    if (value1 !== value2) {
      const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${label}:`);
      if (targetPc !== -1) {
        frame.pc = targetPc;
      } else {
        throw new Error(`Label ${label} not found`);
      }
    }
  },
  tableswitch: (frame, instruction) => {
    const index = frame.stack.pop();
    
    const defaultLabel = instruction.defaultLbl;
    const low = parseInt(instruction.low);
    const high = low + instruction.labels.length - 1;
    const labels = instruction.labels;
    
    let targetLabel;
    if (index >= low && index <= high) {
      const labelIndex = index - low;
      targetLabel = labels[labelIndex];
    } else {
      targetLabel = defaultLabel;
    }
    
    const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${targetLabel}:`);
    if (targetPc !== -1) {
      frame.pc = targetPc;
    } else {
      throw new Error(`Label ${targetLabel} not found`);
    }
  },
  lookupswitch: (frame, instruction) => {
    const key = frame.stack.pop();
    const { defaultLabel, pairs } = instruction.arg;
    
    let targetLabel = defaultLabel;
    for (const [matchKey, label] of pairs) {
      if (key === matchKey) {
        targetLabel = label;
        break;
      }
    }
    
    const targetPc = frame.instructions.findIndex(inst => inst.labelDef === `${targetLabel}:`);
    if (targetPc !== -1) {
      frame.pc = targetPc;
    } else {
      throw new Error(`Label ${targetLabel} not found`);
    }
  },
};
