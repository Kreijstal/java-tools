module.exports = {
  ldc: async (frame, instruction, jvm) => {
    if (Array.isArray(instruction.arg) && instruction.arg[0] === 'Class') {
      const className = instruction.arg[1];
      const classData = await jvm.loadClassByName(className);
      if (classData) {
        const classObj = {
          type: 'java/lang/Class',
          _classData: classData,
        };
        frame.stack.push(classObj);
      } else {
        throw {
          type: 'java/lang/ClassNotFoundException',
          message: `Class not found: ${className}`,
        };
      }
    } else {
      const constant = instruction.arg;
      if (typeof constant === 'string' || constant instanceof String) {
        frame.stack.push(jvm.internString(constant.replace(/"/g, '')));
      } else {
        frame.stack.push(constant);
      }
    }
  },
  bipush: (frame, instruction) => {
    const value = parseInt(instruction.arg, 10);
    frame.stack.push(value);
  },
  sipush: (frame, instruction) => {
    const value = parseInt(instruction.arg, 10);
    frame.stack.push(value);
  },
  iconst_m1: (frame) => {
    frame.stack.push(-1);
  },
  iconst_0: (frame) => {
    frame.stack.push(0);
  },
  iconst_1: (frame) => {
    frame.stack.push(1);
  },
  iconst_2: (frame) => {
    frame.stack.push(2);
  },
  iconst_3: (frame) => {
    frame.stack.push(3);
  },
  iconst_4: (frame) => {
    frame.stack.push(4);
  },
  iconst_5: (frame) => {
    frame.stack.push(5);
  },
  aconst_null: (frame) => {
    frame.stack.push(null);
  },
  ldc2_w: (frame, instruction) => {
    const value = instruction.arg;
    if (typeof value === 'string' && value.endsWith('L')) {
      frame.stack.push(BigInt(value.slice(0, -1)));
    } else if (typeof value === 'object' && value !== null) {
      // Handle typed constants from convert_tree.js (e.g., {value: 3.14, type: "Double"})
      frame.stack.push(value.value);
    } else {
      frame.stack.push(parseFloat(value));
    }
  },
};
