const PURE_SAFE_OPS = new Set([
  "nop",
  "aconst_null",
  "bipush",
  "sipush",
  "ldc",
  "ldc_w",
  "ldc2_w",
  "iinc",
  "lcmp",
  "fcmpl",
  "fcmpg",
  "dcmpl",
  "dcmpg",
  "arraylength",
  "checkcast",
  "instanceof",
  "new",
  "anewarray",
  "newarray",
  "multianewarray",
  "tableswitch",
  "lookupswitch",
  "ireturn",
  "lreturn",
  "freturn",
  "dreturn",
  "areturn",
  "return",
  "dup",
  "dup_x1",
  "dup_x2",
  "dup2",
  "dup2_x1",
  "dup2_x2",
  "swap",
  "pop",
  "pop2",
  "goto",
  "goto_w",
  "jsr",
  "jsr_w",
  "ret",
  "getfield",
  "getstatic",
  "wide",
]);

const CONTROL_OPS = [
  "ifeq",
  "ifne",
  "iflt",
  "ifge",
  "ifgt",
  "ifle",
  "if_icmpeq",
  "if_icmpne",
  "if_icmplt",
  "if_icmpge",
  "if_icmpgt",
  "if_icmple",
  "if_acmpeq",
  "if_acmpne",
  "ifnull",
  "ifnonnull",
];

CONTROL_OPS.forEach((op) => PURE_SAFE_OPS.add(op));

const LOAD_PREFIXES = ["aload", "iload", "lload", "fload", "dload"];
const STORE_PREFIXES = ["astore", "istore", "lstore", "fstore", "dstore"];
const CONST_PREFIXES = ["iconst", "lconst", "fconst", "dconst"];
const CONST_SUFFIXES = {
  iconst: ["_m1", "_0", "_1", "_2", "_3", "_4", "_5"],
  lconst: ["_0", "_1"],
  fconst: ["_0", "_1", "_2"],
  dconst: ["_0", "_1"],
};

const ARRAY_LOADS = [
  "aaload",
  "baload",
  "caload",
  "daload",
  "faload",
  "iaload",
  "laload",
  "saload",
];

ARRAY_LOADS.forEach((op) => PURE_SAFE_OPS.add(op));

for (const prefix of LOAD_PREFIXES) {
  PURE_SAFE_OPS.add(prefix);
  for (let i = 0; i <= 3; i += 1) {
    PURE_SAFE_OPS.add(`${prefix}_${i}`);
  }
}

for (const prefix of STORE_PREFIXES) {
  PURE_SAFE_OPS.add(prefix);
  for (let i = 0; i <= 3; i += 1) {
    PURE_SAFE_OPS.add(`${prefix}_${i}`);
  }
}

for (const prefix of CONST_PREFIXES) {
  const suffixes = CONST_SUFFIXES[prefix];
  if (!suffixes) continue;
  suffixes.forEach((suffix) => PURE_SAFE_OPS.add(`${prefix}${suffix}`));
}

const LITERAL_OPS = ["bipush", "sipush", "ldc", "ldc_w", "ldc2_w"];
LITERAL_OPS.forEach((op) => PURE_SAFE_OPS.add(op));

const NUMERIC_PREFIXES = ["i", "l", "f", "d"];
const ARITH_SUFFIXES = ["add", "sub", "mul", "div", "rem", "neg"];
const BITWISE_SUFFIXES = ["shl", "shr", "ushr", "and", "or", "xor"];

for (const prefix of NUMERIC_PREFIXES) {
  for (const suffix of ARITH_SUFFIXES) {
    PURE_SAFE_OPS.add(`${prefix}${suffix}`);
  }
  for (const suffix of BITWISE_SUFFIXES) {
    // f/d variants do not support bitwise ops.
    if ((prefix === "f" || prefix === "d") && suffix !== "neg") {
      continue;
    }
    if (suffix === "neg" && (prefix === "i" || prefix === "l")) {
      // i/l neg handled via arithmetic suffixes above
      continue;
    }
    PURE_SAFE_OPS.add(`${prefix}${suffix}`);
  }
}

// Restore integer/long negation that was skipped in the loop above.
PURE_SAFE_OPS.add("ineg");
PURE_SAFE_OPS.add("lneg");

const SHIFT_AND_LOGICAL = [
  "ishl",
  "lshl",
  "ishr",
  "lshr",
  "iushr",
  "lushr",
  "iand",
  "land",
  "ior",
  "lor",
  "ixor",
  "lxor",
];
SHIFT_AND_LOGICAL.forEach((op) => PURE_SAFE_OPS.add(op));

const CONVERSION_OPS = [
  "i2l",
  "i2f",
  "i2d",
  "l2i",
  "l2f",
  "l2d",
  "f2i",
  "f2l",
  "f2d",
  "d2i",
  "d2l",
  "d2f",
  "i2b",
  "i2c",
  "i2s",
];
CONVERSION_OPS.forEach((op) => PURE_SAFE_OPS.add(op));

const IMPURE_OPCODE_REASONS = {
  putfield: "field write",
  putstatic: "field write",
  monitorenter: "monitor operation",
  monitorexit: "monitor operation",
  athrow: "exception throw",
  invokedynamic: "dynamic invocation",
  iastore: "array write",
  lastore: "array write",
  fastore: "array write",
  dastore: "array write",
  aastore: "array write",
  bastore: "array write",
  castore: "array write",
  sastore: "array write",
};

const INVOKE_OPS = new Set([
  "invokevirtual",
  "invokespecial",
  "invokestatic",
  "invokeinterface",
]);

function buildMethodSignature(className, methodName, descriptor) {
  return `${className}.${methodName}${descriptor}`;
}

function normalizeInstruction(instruction) {
  if (!instruction) {
    return null;
  }
  if (typeof instruction === "string") {
    return { op: instruction };
  }
  if (typeof instruction === "object" && instruction.op) {
    return instruction;
  }
  return null;
}

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

function analyzeInstructions(signature, codeItems) {
  const callees = new Set();
  const reasons = [];

  for (const item of codeItems) {
    const normalized = normalizeInstruction(item.instruction);
    if (!normalized) {
      continue;
    }

    const { op } = normalized;
    if (!op) {
      continue;
    }

    if (IMPURE_OPCODE_REASONS[op]) {
      reasons.push(`contains impure opcode ${op} (${IMPURE_OPCODE_REASONS[op]})`);
      continue;
    }

    if (INVOKE_OPS.has(op)) {
      const calleeSignature = extractInvokeTarget(normalized);
      if (!calleeSignature) {
        reasons.push(`unresolved invocation for opcode ${op}`);
        continue;
      }
      if (calleeSignature !== signature) {
        callees.add(calleeSignature);
      }
      continue;
    }

    if (!PURE_SAFE_OPS.has(op)) {
      reasons.push(`unknown opcode ${op}`);
    }
  }

  return { callees, reasons };
}

function analyzePurity(ast) {
  const classes = ast && Array.isArray(ast.classes) ? ast.classes : [];
  const methodInfo = new Map();
  const results = new Map();
  const pending = new Map();

  for (const cls of classes) {
    const {className} = cls;
    if (!className || !Array.isArray(cls.items)) {
      continue;
    }

    for (const item of cls.items) {
      if (!item || item.type !== "method" || !item.method) {
        continue;
      }

      const {method} = item;
      const signature = buildMethodSignature(
        className,
        method.name,
        method.descriptor,
      );

      const codeAttr = (method.attributes || []).find((attr) => attr.type === "code");
      if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) {
        results.set(signature, {
          pure: false,
          reason: "no code attribute",
        });
        methodInfo.set(signature, { callees: new Set() });
        continue;
      }

      const { callees, reasons } = analyzeInstructions(
        signature,
        codeAttr.code.codeItems,
      );

      methodInfo.set(signature, { callees });

      if (reasons.length > 0) {
        results.set(signature, {
          pure: false,
          reason: reasons.join("; "),
        });
      } else {
        pending.set(signature, { callees });
      }
    }
  }

  for (const [signature, data] of pending) {
    const missing = [...data.callees].filter((callee) => !methodInfo.has(callee));
    if (missing.length > 0) {
      results.set(signature, {
        pure: false,
        reason: `calls external method(s): ${missing.join(", ")}`,
      });
      pending.delete(signature);
    }
  }

  const pureSet = new Set();
  let changed = true;
  while (changed) {
    changed = false;

    for (const [signature, data] of pending) {
      let impureCallee = null;
      const unresolved = [];

      for (const callee of data.callees) {
        const calleeResult = results.get(callee);
        if (calleeResult && calleeResult.pure === false) {
          impureCallee = callee;
          break;
        }
        if (pureSet.has(callee)) {
          continue;
        }
        if (!pending.has(callee)) {
          unresolved.push(callee);
        }
      }

      if (impureCallee) {
        results.set(signature, {
          pure: false,
          reason: `calls impure method ${impureCallee}`,
        });
        pending.delete(signature);
        changed = true;
        continue;
      }

      if (unresolved.length === 0) {
        results.set(signature, { pure: true });
        pending.delete(signature);
        pureSet.add(signature);
        changed = true;
      }
    }
  }

  for (const [signature, data] of pending) {
    const unresolved = [...data.callees].filter((callee) => !pureSet.has(callee));
    const reason = unresolved.length > 0
      ? `could not prove purity; unresolved callees: ${unresolved.join(", ")}`
      : "could not prove purity";
    results.set(signature, { pure: false, reason });
  }

  const output = {};
  for (const [signature, result] of results) {
    output[signature] = result;
  }
  for (const [signature] of pending) {
    if (!output[signature]) {
      output[signature] = { pure: false };
    }
  }

  return output;
}

module.exports = {
  analyzePurity,
  _internals: {
    analyzeInstructions,
    buildMethodSignature,
  },
};
