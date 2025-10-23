const TERMINATOR_OPS = new Set([
  "return",
  "ireturn",
  "lreturn",
  "freturn",
  "dreturn",
  "areturn",
  "athrow",
]);

const LOAD_PREFIXES = ["iload", "lload", "fload", "dload", "aload"];
const STORE_PREFIXES = ["istore", "lstore", "fstore", "dstore", "astore"];
const CONST_PREFIXES = ["iconst", "lconst", "fconst", "dconst"];
const CONST_SPECIAL = new Set([
  "aconst_null",
  "bipush",
  "sipush",
  "ldc",
  "ldc_w",
  "ldc2_w",
]);

const NUMERIC_PREFIXES = ["i", "l", "f", "d"];
const BINARY_SUFFIXES = [
  "add",
  "sub",
  "mul",
  "div",
  "rem",
  "and",
  "or",
  "xor",
  "shl",
  "shr",
  "ushr",
];

const BRANCH_OPS = new Set([
  "ifeq",
  "ifne",
  "iflt",
  "ifge",
  "ifgt",
  "ifle",
  "ifnull",
  "ifnonnull",
  "if_icmpeq",
  "if_icmpne",
  "if_icmplt",
  "if_icmpge",
  "if_icmpgt",
  "if_icmple",
  "if_acmpeq",
  "if_acmpne",
]);

const CONTROL_FLOW_OPS = new Set(["goto", "tableswitch", "lookupswitch", "jsr", "ret"]);

function parseTypeDescriptor(descriptor, startIndex = 0) {
  if (!descriptor || startIndex >= descriptor.length) {
    return null;
  }

  let cursor = startIndex;
  let isArray = false;

  while (descriptor[cursor] === "[") {
    isArray = true;
    cursor += 1;
  }

  if (cursor >= descriptor.length) {
    return null;
  }

  const kind = descriptor[cursor];
  cursor += 1;

  if (kind === "L") {
    while (cursor < descriptor.length && descriptor[cursor] !== ";") {
      cursor += 1;
    }
    if (cursor >= descriptor.length) {
      return null;
    }
    cursor += 1;
  }

  let width;
  if (kind === "V") {
    width = 0;
  } else if (kind === "J" || kind === "D") {
    width = 2;
  } else {
    width = 1;
  }

  if (isArray) {
    width = 1;
  }

  return { width, nextIndex: cursor };
}

function parseMethodDescriptor(descriptor) {
  if (!descriptor || descriptor[0] !== "(") {
    return null;
  }

  const argWidths = [];
  let cursor = 1;

  while (cursor < descriptor.length && descriptor[cursor] !== ")") {
    const type = parseTypeDescriptor(descriptor, cursor);
    if (!type) {
      return null;
    }
    argWidths.push(type.width);
    cursor = type.nextIndex;
  }

  if (cursor >= descriptor.length || descriptor[cursor] !== ")") {
    return null;
  }

  const returnType = parseTypeDescriptor(descriptor, cursor + 1);
  if (!returnType) {
    return null;
  }

  return { argWidths, returnWidth: returnType.width };
}

function parseFieldDescriptor(descriptor) {
  const result = parseTypeDescriptor(descriptor, 0);
  if (!result) {
    return null;
  }
  return { width: result.width };
}

function sum(argWidths) {
  return argWidths.reduce((total, width) => total + width, 0);
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

function getTypeWidth(prefix) {
  return prefix === "l" || prefix === "d" ? 2 : 1;
}

function getConstWidth(op) {
  if (op === "ldc2_w" || op.startsWith("lconst") || op.startsWith("dconst")) {
    return 2;
  }
  return 1;
}

function getStackEffect(op, instruction = null) {
  if (!op) {
    return null;
  }

  if (TERMINATOR_OPS.has(op)) {
    const popSlots =
      op === "return"
        ? 0
        : op === "lreturn" || op === "dreturn"
          ? 2
          : 1;
    return { popSlots, pushSlots: 0, terminator: true, essential: true };
  }

  if (op === "pop") {
    return { popSlots: 1, pushSlots: 0 };
  }
  if (op === "pop2") {
    return { popSlots: 2, pushSlots: 0 };
  }

  if (op === "dup") {
    return { popSlots: 1, pushSlots: 2, special: "dup" };
  }

  if (CONST_SPECIAL.has(op)) {
    return { popSlots: 0, pushSlots: getConstWidth(op) };
  }

  for (const prefix of LOAD_PREFIXES) {
    if (op === prefix || op.startsWith(`${prefix}_`)) {
      const width = getTypeWidth(prefix[0]);
      return { popSlots: 0, pushSlots: width };
    }
  }

  for (const prefix of CONST_PREFIXES) {
    if (op === prefix || op.startsWith(`${prefix}_`)) {
      return { popSlots: 0, pushSlots: getConstWidth(op) };
    }
  }

  for (const prefix of STORE_PREFIXES) {
    if (op === prefix || op.startsWith(`${prefix}_`)) {
      const width = getTypeWidth(prefix[0]);
      return { popSlots: width, pushSlots: 0, essential: true };
    }
  }

  if (op === "iinc") {
    return { popSlots: 0, pushSlots: 0, essential: true };
  }

  if (BRANCH_OPS.has(op)) {
    const popSlots = op.includes("cmp") || op.includes("acmp") ? 2 : 1;
    return { popSlots, pushSlots: 0, essential: true };
  }

  if (CONTROL_FLOW_OPS.has(op)) {
    const popSlots = op === "tableswitch" || op === "lookupswitch" ? 1 : 0;
    return { popSlots, pushSlots: 0, essential: true };
  }

  if (op === "monitorenter" || op === "monitorexit") {
    return { popSlots: 1, pushSlots: 0, essential: true };
  }

  if (op === "checkcast" || op === "instanceof") {
    return { popSlots: 1, pushSlots: 1 };
  }

  if (op === "arraylength") {
    return { popSlots: 1, pushSlots: 1 };
  }

  if (op === "new") {
    return { popSlots: 0, pushSlots: 1, essential: true };
  }

  if (op === "newarray" || op === "anewarray") {
    return { popSlots: 1, pushSlots: 1, essential: true };
  }

  if (op === "multianewarray") {
    if (!instruction || !Array.isArray(instruction.arg)) {
      return null;
    }
    const dimensions = Number.parseInt(instruction.arg[1], 10);
    if (!Number.isInteger(dimensions) || dimensions < 0) {
      return null;
    }
    return { popSlots: dimensions, pushSlots: 1, essential: true };
  }

  if (
    op === "invokestatic" ||
    op === "invokevirtual" ||
    op === "invokespecial" ||
    op === "invokeinterface"
  ) {
    if (!instruction || !Array.isArray(instruction.arg)) {
      return null;
    }
    const [, , nameDesc] = instruction.arg;
    if (!nameDesc || !Array.isArray(nameDesc) || !nameDesc[1]) {
      return null;
    }
    const descriptor = nameDesc[1];
    const layout = parseMethodDescriptor(descriptor);
    if (!layout) {
      return null;
    }
    const receiverSlots = op === "invokestatic" ? 0 : 1;
    const popSlots = sum(layout.argWidths) + receiverSlots;
    return {
      popSlots,
      pushSlots: layout.returnWidth,
      essential: true,
    };
  }

  if (op === "invokedynamic") {
    if (!instruction || !instruction.arg || !instruction.arg.nameAndType) {
      return null;
    }
    const {descriptor} = instruction.arg.nameAndType;
    const layout = parseMethodDescriptor(descriptor);
    if (!layout) {
      return null;
    }
    return {
      popSlots: sum(layout.argWidths),
      pushSlots: layout.returnWidth,
      essential: true,
    };
  }

  if (
    op === "getstatic" ||
    op === "putstatic" ||
    op === "getfield" ||
    op === "putfield"
  ) {
    if (!instruction || !Array.isArray(instruction.arg)) {
      return null;
    }
    const [, , nameDesc] = instruction.arg;
    if (!nameDesc || !Array.isArray(nameDesc) || !nameDesc[1]) {
      return null;
    }
    const descriptor = nameDesc[1];
    const field = parseFieldDescriptor(descriptor);
    if (!field) {
      return null;
    }

    if (op === "getstatic") {
      return { popSlots: 0, pushSlots: field.width, essential: true };
    }
    if (op === "putstatic") {
      return { popSlots: field.width, pushSlots: 0, essential: true };
    }
    if (op === "getfield") {
      return { popSlots: 1, pushSlots: field.width, essential: true };
    }
    return { popSlots: 1 + field.width, pushSlots: 0, essential: true };
  }

  const unaryNumeric = new Set(["ineg", "lneg", "fneg", "dneg"]);
  if (unaryNumeric.has(op)) {
    const type = op[0];
    const width = getTypeWidth(type);
    return { popSlots: width, pushSlots: width };
  }

  if (op === "lcmp") {
    return { popSlots: 4, pushSlots: 1 };
  }
  if (op === "fcmpl" || op === "fcmpg") {
    return { popSlots: 2, pushSlots: 1 };
  }
  if (op === "dcmpl" || op === "dcmpg") {
    return { popSlots: 4, pushSlots: 1 };
  }

  for (const prefix of NUMERIC_PREFIXES) {
    for (const suffix of BINARY_SUFFIXES) {
      if (op === `${prefix}${suffix}`) {
        const width = getTypeWidth(prefix);
        const rightWidth = suffix === "shl" || suffix === "shr" || suffix === "ushr"
          ? 1
          : width;
        const popSlots = width + rightWidth;
        return { popSlots, pushSlots: width };
      }
    }
  }

  const convMatch = op.match(/^([ilfd])2([ilfd])/);
  if (convMatch) {
    const [, from, to] = convMatch;
    return { popSlots: getTypeWidth(from), pushSlots: getTypeWidth(to) };
  }

  if (op === "nop") {
    return { popSlots: 0, pushSlots: 0 };
  }

  return null;
}

function buildMethodSignature(className, method) {
  return `${className}.${method.name}${method.descriptor}`;
}

function computeMaxStack(entries, keepSet) {
  let height = 0;
  let maxHeight = 0;
  for (const entry of entries) {
    if (!keepSet.has(entry.index)) {
      continue;
    }
    height -= entry.meta.popSlots;
    if (height < 0) {
      return null;
    }
    height += entry.meta.pushSlots;
    if (height > maxHeight) {
      maxHeight = height;
    }
  }
  return height === 0 ? maxHeight : null;
}

function eliminateDeadCode(ast) {
  const result = {};
  let changed = false;

  if (!ast || !Array.isArray(ast.classes)) {
    return { changed: false, methods: result };
  }

  for (const cls of ast.classes) {
    if (!cls || !Array.isArray(cls.items)) {
      continue;
    }
    const {className} = cls;

    for (const item of cls.items) {
      if (!item || item.type !== "method" || !item.method) {
        continue;
      }
      const {method} = item;
      const signature = buildMethodSignature(className, method);
      const codeAttr = (method.attributes || []).find((attr) => attr.type === "code");
      if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) {
        continue;
      }

      const { code } = codeAttr;
      const entries = [];
      const entryByIndex = new Map();
      let unsupported = false;

      code.codeItems.forEach((codeItem, index) => {
        const normalized = normalizeInstruction(codeItem.instruction);
        if (!normalized) {
          return;
        }
        const { op } = normalized;
        const meta = getStackEffect(op, normalized);
        if (!meta) {
          unsupported = true;
          return;
        }
        const entry = {
          index,
          op,
          meta,
          consumes: [],
          produced: [],
          consumers: new Set(),
          terminator: Boolean(meta.terminator),
          instruction: normalized,
        };
        entries.push(entry);
        entryByIndex.set(index, entry);
      });

      if (unsupported || entries.length === 0) {
        continue;
      }

      const stack = [];
      let analysisFailed = false;

      for (const entry of entries) {
        const { popSlots, pushSlots, special } = entry.meta;
        let remaining = popSlots;
        const consumed = [];

        while (remaining > 0) {
          const value = stack.pop();
          if (!value) {
            analysisFailed = true;
            break;
          }
          consumed.push(value);
          remaining -= value.width;
        }

        if (analysisFailed || remaining !== 0) {
          analysisFailed = true;
          break;
        }

        entry.consumes = consumed;
        for (const value of consumed) {
          if (value.producer) {
            value.producer.consumers.add(entry);
          }
        }

        if (special === "dup") {
          if (consumed.length !== 1) {
            analysisFailed = true;
            break;
          }
          const [top] = consumed;
          stack.push(top);
          const produced = { producer: entry, width: top.width };
          entry.produced.push(produced);
          stack.push(produced);
          continue;
        }

        if (pushSlots > 0) {
          const produced = { producer: entry, width: pushSlots };
          entry.produced.push(produced);
          stack.push(produced);
        }
      }

      if (analysisFailed) {
        continue;
      }

      const keepSet = new Set();
      const visitStack = [];

      for (const entry of entries) {
        if (entry.terminator || entry.meta.essential) {
          visitStack.push(entry);
        }
      }

      while (visitStack.length > 0) {
        const current = visitStack.pop();
        if (keepSet.has(current.index)) {
          continue;
        }
        keepSet.add(current.index);
        for (const value of current.consumes) {
          if (value.producer && !keepSet.has(value.producer.index)) {
            visitStack.push(value.producer);
          }
        }
      }

      const removedEntries = entries.filter((entry) => !keepSet.has(entry.index));
      if (removedEntries.length === 0) {
        continue;
      }

      const newMaxStack = computeMaxStack(entries, keepSet);
      if (newMaxStack === null) {
        continue;
      }

      const filteredItems = [];
      code.codeItems.forEach((codeItem, index) => {
        const entry = entryByIndex.get(index);
        if (entry && !keepSet.has(index)) {
          return;
        }
        filteredItems.push(codeItem);
      });

      code.stackSize = String(newMaxStack);
      code.codeItems = filteredItems;

      changed = true;
      result[signature] = {
        removed: removedEntries.map((entry) => entry.op),
        originalLength: entries.length,
        optimizedLength: entries.length - removedEntries.length,
        stackSize: code.stackSize,
      };
    }
  }

  return { changed, methods: result };
}

module.exports = {
  eliminateDeadCode,
  _internals: {
    normalizeInstruction,
    getStackEffect,
  },
};
