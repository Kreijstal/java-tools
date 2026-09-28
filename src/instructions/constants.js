const SYNC_FALLBACK = require('./syncFallback');

function wideConstant(frame, instruction) {
  let constant = instruction.arg;
  // Converted operands are normally values; retain the legacy pool-index form.
  if (typeof constant === 'string' && /^\d+$/.test(constant) && frame.method.constantPool) {
    const index = parseInt(constant, 10);
    if (index >= 1 && index < frame.method.constantPool.length) {
      constant = frame.method.constantPool[index];
    }
  }
  return constant;
}

function pushConstantSync(frame, constant, jvm) {
  if (Array.isArray(constant) && constant[0] === 'Class') {
    const mirror = jvm.getClassObjectSync?.(constant[1]);
    if (!mirror) return SYNC_FALLBACK;
    frame.stack.push(mirror);
  } else if (typeof constant === 'string' || constant instanceof String) {
    frame.stack.push(jvm.internString(constant));
  } else if (constant !== null && typeof constant === 'object' &&
      Object.prototype.hasOwnProperty.call(constant, 'value')) {
    frame.stack.push(constant.value);
  } else {
    frame.stack.push(constant);
  }
}

async function loadConstant(frame, constant, jvm) {
  if (pushConstantSync(frame, constant, jvm) === SYNC_FALLBACK) {
    frame.stack.push(await jvm.getClassObject(constant[1]));
  }
}

module.exports = {
  ldc: (frame, instruction, jvm) => loadConstant(frame, instruction.arg, jvm),
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
  ldc_w: (frame, instruction, jvm) => loadConstant(frame, wideConstant(frame, instruction), jvm),
};

module.exports.ldcSync = (frame, instruction, jvm) =>
  pushConstantSync(frame, instruction.arg, jvm);
module.exports.ldcWideSync = (frame, instruction, jvm) =>
  pushConstantSync(frame, wideConstant(frame, instruction), jvm);
