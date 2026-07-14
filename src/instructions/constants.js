module.exports = {
  ldc: async (frame, instruction, jvm) => {
    if (Array.isArray(instruction.arg) && instruction.arg[0] === "Class") {
      const className = instruction.arg[1];
      const classObj = await jvm.getClassObject(className);
      frame.stack.push(classObj);
    } else {
      const constant = instruction.arg;
      if (typeof constant === "string" || constant instanceof String) {
        frame.stack.push(jvm.internString(constant));
      } else if (
        typeof constant === "object" &&
        constant !== null &&
        constant.hasOwnProperty("value")
      ) {
        // Handle typed constants from convert_tree.js (e.g., {value: 3.14, type: "Float"})
        frame.stack.push(constant.value);
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

  lconst_0: (frame) => {
    frame.stack.push(BigInt(0));
  },
  lconst_1: (frame) => {
    frame.stack.push(BigInt(1));
  },

  fconst_0: (frame) => {
    frame.stack.push(0.0);
  },
  fconst_1: (frame) => {
    frame.stack.push(1.0);
  },
  fconst_2: (frame) => {
    frame.stack.push(2.0);
  },

  dconst_0: (frame) => {
    frame.stack.push(0.0);
  },
  dconst_1: (frame) => {
    frame.stack.push(1.0);
  },

  aconst_null: (frame) => {
    frame.stack.push(null);
  },
  ldc2_w: (frame, instruction) => {
    const value = instruction.arg;
    // Long constants arrive as a BigInt (or {value:BigInt|string, type:"Long"}).
    // They MUST stay BigInt — routing them through Number/parseFloat silently
    // rounds any value above 2^53 (breaks 64-bit hashing like Whirlpool).
    if (typeof value === "bigint") {
      frame.stack.push(value);
    } else if (typeof value === "string" && value.endsWith("L")) {
      frame.stack.push(BigInt(value.slice(0, -1)));
    } else if (typeof value === "object" && value !== null) {
      if (value.type === "Long") {
        frame.stack.push(typeof value.value === "bigint" ? value.value : BigInt(value.value));
      } else {
        // Typed floating constants from convert_tree.js, e.g. {value:3.14, type:"Double"}
        frame.stack.push(value.value);
      }
    } else if (typeof value === "string" && /^-?\d+$/.test(value)) {
      frame.stack.push(BigInt(value));
    } else {
      frame.stack.push(parseFloat(value));
    }
  },
    ldc_w: async (frame, instruction, jvm) => {
      let constant = instruction.arg;

      // jvm_parser/convertJson resolves many ldc_w operands to their constant
      // value already (for example strings).  Some callers may still supply a
      // raw constant-pool index, so keep supporting that representation too.
      if (typeof constant === 'string' && /^\d+$/.test(constant) && frame.method.constantPool) {
        const index = parseInt(constant, 10); // 16-bit constant pool index
        const constantPool = frame.method.constantPool;
        if (index < constantPool.length && index >= 1) {
          constant = constantPool[index];
        }
      }

      if (Array.isArray(constant) && constant[0] === "Class") {
        const className = constant[1];
        const classObj = await jvm.getClassObject(className);
        frame.stack.push(classObj);
      } else if (typeof constant === "string" || constant instanceof String) {
        frame.stack.push(jvm.internString(constant));
      } else if (
        typeof constant === "object" &&
        constant !== null &&
        constant.hasOwnProperty("value")
      ) {
        frame.stack.push(constant.value);
      } else {
        frame.stack.push(constant);
      }
    },
};
