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
        // TODO: Throw ClassNotFoundException
        frame.stack.push(null);
      }
    } else {
      const value = instruction.arg.replace(/"/g, '');
      frame.stack.push(value);
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
};
