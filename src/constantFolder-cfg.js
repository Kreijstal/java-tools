const { getStackEffect, normalizeInstruction } = require('./utils/instructionUtils');

const INT_BINARY_OPS = new Set([
  'iadd',
  'isub',
  'imul',
  'idiv',
  'irem',
  'iand',
  'ior',
  'ixor',
  'ishl',
  'ishr',
  'iushr',
]);

const LONG_BINARY_OPS = new Set([
  'ladd',
  'lsub',
  'lmul',
  'ldiv',
  'lrem',
  'land',
  'lor',
  'lxor',
  'lshl',
  'lshr',
  'lushr',
]);

const FLOAT_BINARY_OPS = new Set(['fadd', 'fsub', 'fmul', 'fdiv', 'frem']);
const DOUBLE_BINARY_OPS = new Set(['dadd', 'dsub', 'dmul', 'ddiv', 'drem']);

const INT_COMPARISON_OPS = new Set([
  'ifeq',
  'ifne',
  'iflt',
  'ifge',
  'ifgt',
  'ifle',
  'if_icmpeq',
  'if_icmpne',
  'if_icmplt',
  'if_icmpge',
  'if_icmpgt',
  'if_icmple',
]);

const NULL_COMPARISON_OPS = new Set(['ifnull', 'ifnonnull']);

const STORE_BASES = new Set(['istore', 'lstore', 'fstore', 'dstore', 'astore']);
const LOAD_BASES = new Set(['iload', 'lload', 'fload', 'dload', 'aload']);
const LOAD_FOR_STORE = {
  istore: 'iload',
  lstore: 'lload',
  fstore: 'fload',
  dstore: 'dload',
  astore: 'aload',
};

const LOAD_TYPE = {
  iload: { type: 'int', width: 1 },
  lload: { type: 'long', width: 2 },
  fload: { type: 'float', width: 1 },
  dload: { type: 'double', width: 2 },
  aload: { type: 'reference', width: 1 },
};

const STORE_TYPE = {
  istore: { type: 'int', width: 1 },
  lstore: { type: 'long', width: 2 },
  fstore: { type: 'float', width: 1 },
  dstore: { type: 'double', width: 2 },
  astore: { type: 'reference', width: 1 },
};

const LONG_MASK = (1n << 64n) - 1n;
const LONG_SIGN = 1n << 63n;

function toInt32(value) {
  return value | 0;
}

function toLong(value) {
  let normalized = BigInt(value) & LONG_MASK;
  if (normalized >= LONG_SIGN) {
    normalized -= 1n << 64n;
  }
  return normalized;
}

function toFloat32(value) {
  return Math.fround(value);
}

function createUnknown(width = 1, type = 'unknown') {
  return { kind: 'unknown', width, removable: false, type };
}

function cloneValue(value) {
  if (!value) {
    return value;
  }
  return { ...value };
}

function cloneStack(stack) {
  return stack.map(cloneValue);
}

function cloneLocals(locals) {
  const result = new Map();
  if (!locals) {
    return result;
  }
  for (const [index, value] of locals.entries()) {
    result.set(index, cloneValue(value));
  }
  return result;
}

function parseIntArg(arg) {
  if (typeof arg === 'number') {
    return arg | 0;
  }
  if (typeof arg === 'string') {
    const parsed = Number.parseInt(arg, 10);
    if (Number.isNaN(parsed)) {
      return null;
    }
    return parsed | 0;
  }
  return null;
}

function createIntConstantInstruction(value) {
  if (!Number.isInteger(value)) {
    return null;
  }
  if (value >= -1 && value <= 5) {
    const suffix = value === -1 ? 'm1' : String(value);
    return { op: `iconst_${suffix}` };
  }
  if (value >= -128 && value <= 127) {
    return { op: 'bipush', arg: String(value) };
  }
  if (value >= -32768 && value <= 32767) {
    return { op: 'sipush', arg: String(value) };
  }
  return { op: 'ldc', arg: Number(value) };
}

function createLongConstantInstruction(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = toLong(value);
  if (normalized === 0n) {
    return { op: 'lconst_0' };
  }
  if (normalized === 1n) {
    return { op: 'lconst_1' };
  }
  return { op: 'ldc2_w', arg: normalized };
}

function createFloatConstantInstruction(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const floatValue = toFloat32(value);
  if (Object.is(floatValue, 0) && !Object.is(floatValue, -0)) {
    return { op: 'fconst_0' };
  }
  if (floatValue === 1) {
    return { op: 'fconst_1' };
  }
  if (floatValue === 2) {
    return { op: 'fconst_2' };
  }
  return { op: 'ldc', arg: { value: floatValue, type: 'Float' } };
}

function createDoubleConstantInstruction(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const doubleValue = Number(value);
  if (Object.is(doubleValue, 0) && !Object.is(doubleValue, -0)) {
    return { op: 'dconst_0' };
  }
  if (doubleValue === 1) {
    return { op: 'dconst_1' };
  }
  return { op: 'ldc2_w', arg: { value: doubleValue, type: 'Double' } };
}

function createNullConstantInstruction() {
  return { op: 'aconst_null' };
}

function createConstantInstructionForValue(value) {
  if (!value || value.kind !== 'constant') {
    return null;
  }
  switch (value.type) {
    case 'int':
      return createIntConstantInstruction(toInt32(value.value));
    case 'long':
      return createLongConstantInstruction(value.value);
    case 'float':
      return createFloatConstantInstruction(value.value);
    case 'double':
      return createDoubleConstantInstruction(value.value);
    case 'null':
      return createNullConstantInstruction();
    default:
      return null;
  }
}

function createLocalConstantValue(type, value, width) {
  return { kind: 'constant', type, value, width, removable: false };
}

function createConstantValue(type, value, width, blockId, item, removable) {
  return {
    kind: 'constant',
    type,
    value,
    width,
    removable,
    producerItem: item,
    producerBlockId: blockId,
    useCount: 0,
  };
}

function popValues(stack, slots) {
  const consumed = [];
  let remaining = slots;
  while (remaining > 0) {
    const value = stack.pop();
    if (!value) {
      return null;
    }
    value.useCount = (value.useCount || 0) + 1;
    consumed.push(value);
    remaining -= value.width;
  }
  if (remaining !== 0) {
    return null;
  }
  return consumed;
}

function valuesEquivalent(left, right) {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'unknown') {
    return left.width === right.width;
  }
  if (left.width !== right.width || left.type !== right.type) {
    return false;
  }
  if (left.type === 'long') {
    return BigInt(left.value) === BigInt(right.value);
  }
  if (left.type === 'float') {
    return Object.is(toFloat32(left.value), toFloat32(right.value));
  }
  if (left.type === 'double') {
    return Object.is(Number(left.value), Number(right.value));
  }
  return left.value === right.value;
}

function mergeStacks(existing, incoming) {
  if (!existing) {
    return { stack: cloneStack(incoming), changed: true };
  }
  if (existing.length !== incoming.length) {
    return { incompatible: true };
  }

  let changed = false;
  const merged = [];
  for (let i = 0; i < existing.length; i += 1) {
    const left = existing[i];
    const right = incoming[i];
    if (!left || !right || left.width !== right.width) {
      return { incompatible: true };
    }

    if (left.kind === 'constant' && right.kind === 'constant' && left.type === right.type && valuesEquivalent(left, right)) {
      merged.push(createConstantValue(left.type, left.value, left.width, null, null, false));
      continue;
    }

    const unknown = createUnknown(left.width);
    merged.push(unknown);
    if (!valuesEquivalent(left, unknown) || !valuesEquivalent(right, unknown)) {
      changed = true;
    }
  }

  return { stack: merged, changed };
}

function mergeLocals(existing, incoming) {
  if (!incoming) {
    return { locals: existing ? cloneLocals(existing) : new Map(), changed: false };
  }
  if (!existing) {
    return { locals: cloneLocals(incoming), changed: true };
  }

  const merged = new Map();
  let changed = false;
  const keys = new Set([...existing.keys(), ...incoming.keys()]);

  for (const key of keys) {
    const left = existing.get(key);
    const right = incoming.get(key);

    if (!left && !right) {
      continue;
    }

    if (!left) {
      const unknown = createUnknown(right ? right.width : 1);
      merged.set(key, unknown);
      changed = true;
      continue;
    }

    if (!right) {
      const unknown = createUnknown(left.width);
      merged.set(key, unknown);
      if (!valuesEquivalent(left, unknown)) {
        changed = true;
      }
      continue;
    }

    if (left.width !== right.width) {
      return { incompatible: true };
    }

    if (left.kind === 'constant' && right.kind === 'constant' && left.type === right.type && valuesEquivalent(left, right)) {
      const constant = createConstantValue(left.type, left.value, left.width, null, null, false);
      merged.set(key, constant);
      if (!valuesEquivalent(left, constant)) {
        changed = true;
      }
      continue;
    }

    const unknown = createUnknown(left.width);
    merged.set(key, unknown);
    if (!valuesEquivalent(left, unknown)) {
      changed = true;
    }
  }

  if (merged.size !== existing.size) {
    changed = true;
  }

  return { locals: merged, changed };
}

function extractLiteral(normalized, original) {
  if (!normalized || !normalized.op) {
    return null;
  }

  const { op } = normalized;
  if (op === 'aconst_null') {
    return { type: 'null', value: null, width: 1 };
  }

  if (op === 'iconst_m1') {
    return { type: 'int', value: -1, width: 1 };
  }

  if (op.startsWith('iconst_')) {
    const suffix = op.slice('iconst_'.length);
    const parsed = Number.parseInt(suffix, 10);
    if (!Number.isNaN(parsed)) {
      return { type: 'int', value: toInt32(parsed), width: 1 };
    }
    return null;
  }

  if (op === 'bipush' || op === 'sipush') {
    const parsed = parseIntArg(original && original.arg);
    if (parsed !== null) {
      return { type: 'int', value: toInt32(parsed), width: 1 };
    }
    return null;
  }

  if (op === 'lconst_0') {
    return { type: 'long', value: 0n, width: 2 };
  }
  if (op === 'lconst_1') {
    return { type: 'long', value: 1n, width: 2 };
  }

  if (op === 'fconst_0') {
    return { type: 'float', value: toFloat32(0), width: 1 };
  }
  if (op === 'fconst_1') {
    return { type: 'float', value: toFloat32(1), width: 1 };
  }
  if (op === 'fconst_2') {
    return { type: 'float', value: toFloat32(2), width: 1 };
  }

  if (op === 'dconst_0') {
    return { type: 'double', value: 0, width: 2 };
  }
  if (op === 'dconst_1') {
    return { type: 'double', value: 1, width: 2 };
  }

  if (op === 'ldc' || op === 'ldc_w') {
    const arg = original && typeof original === 'object' ? original.arg : undefined;
    if (typeof arg === 'number') {
      return { type: 'int', value: toInt32(arg), width: 1 };
    }
    if (arg && typeof arg === 'object') {
      if (arg.type === 'Float') {
        return { type: 'float', value: toFloat32(arg.value), width: 1 };
      }
      if (arg.type === 'Double') {
        return { type: 'double', value: Number(arg.value), width: 2 };
      }
    }
    return null;
  }

  if (op === 'ldc2_w') {
    const arg = original && typeof original === 'object' ? original.arg : undefined;
    if (typeof arg === 'bigint') {
      return { type: 'long', value: toLong(arg), width: 2 };
    }
    if (typeof arg === 'number') {
      return { type: 'long', value: toLong(BigInt(arg)), width: 2 };
    }
    if (arg && typeof arg === 'object' && arg.type === 'Double') {
      return { type: 'double', value: Number(arg.value), width: 2 };
    }
    return null;
  }

  return null;
}

function buildConstantFold(type, value, width, consumed, blockId, item) {
  const replacement = createConstantInstructionForValue({ kind: 'constant', type, value, width });
  const removable = Boolean(replacement) && consumed.every((val) => canRemoveValue(val, blockId));
  const producedValue = createConstantValue(type, value, width, blockId, item, removable);
  return {
    produced: [producedValue],
    fold: removable ? { replacement, consumed: [...consumed], value } : null,
  };
}

function canRemoveValue(value, blockId) {
  if (!value) {
    return false;
  }
  if (!value.removable) {
    return false;
  }
  if (value.producerBlockId !== blockId) {
    return false;
  }
  if (value.useCount !== 1) {
    return false;
  }
  if (!value.producerItem) {
    return false;
  }
  return true;
}

function markSourcesAsNoOp(values, blockId) {
  const seen = new Set();
  for (const value of values) {
    if (!canRemoveValue(value, blockId)) {
      return false;
    }
    if (seen.has(value.producerItem)) {
      continue;
    }
    seen.add(value.producerItem);
    value.producerItem.instruction = 'nop';
  }
  return true;
}

function evaluateIntBinary(op, left, right) {
  switch (op) {
    case 'iadd':
      return toInt32(left + right);
    case 'isub':
      return toInt32(left - right);
    case 'imul':
      return Math.imul(left, right);
    case 'idiv':
      if (right === 0) {
        return null;
      }
      return toInt32(Math.trunc(left / right));
    case 'irem':
      if (right === 0) {
        return null;
      }
      return toInt32(left % right);
    case 'iand':
      return toInt32(left & right);
    case 'ior':
      return toInt32(left | right);
    case 'ixor':
      return toInt32(left ^ right);
    case 'ishl':
      return toInt32(left << (right & 0x1f));
    case 'ishr':
      return toInt32(left >> (right & 0x1f));
    case 'iushr':
      return toInt32((left >>> (right & 0x1f)) & 0xffffffff);
    default:
      return null;
  }
}

function evaluateLongBinary(op, left, right) {
  const a = toLong(left);
  const b = toLong(right);
  switch (op) {
    case 'ladd':
      return toLong(a + b);
    case 'lsub':
      return toLong(a - b);
    case 'lmul':
      return toLong(a * b);
    case 'ldiv':
      if (b === 0n) {
        return null;
      }
      return toLong(a / b);
    case 'lrem':
      if (b === 0n) {
        return null;
      }
      return toLong(a % b);
    case 'land':
      return toLong(a & b);
    case 'lor':
      return toLong(a | b);
    case 'lxor':
      return toLong(a ^ b);
    case 'lshl':
      return toLong(a << BigInt(Number(b & 63n)));
    case 'lshr':
      return toLong(a >> BigInt(Number(b & 63n)));
    case 'lushr': {
      const shift = Number(b & 63n);
      const unsigned = (a & LONG_MASK) >> BigInt(shift);
      return toLong(unsigned);
    }
    default:
      return null;
  }
}

function evaluateFloatBinary(op, left, right) {
  const a = toFloat32(left);
  const b = toFloat32(right);
  switch (op) {
    case 'fadd':
      return toFloat32(a + b);
    case 'fsub':
      return toFloat32(a - b);
    case 'fmul':
      return toFloat32(a * b);
    case 'fdiv':
      return toFloat32(a / b);
    case 'frem':
      return toFloat32(a % b);
    default:
      return null;
  }
}

function evaluateDoubleBinary(op, left, right) {
  const a = Number(left);
  const b = Number(right);
  switch (op) {
    case 'dadd':
      return a + b;
    case 'dsub':
      return a - b;
    case 'dmul':
      return a * b;
    case 'ddiv':
      return a / b;
    case 'drem':
      return a % b;
    default:
      return null;
  }
}

function evaluateIntComparison(op, consumed) {
  if (consumed.length === 2) {
    const right = consumed[0];
    const left = consumed[1];
    if (left.kind !== 'constant' || left.type !== 'int' || right.kind !== 'constant' || right.type !== 'int') {
      return null;
    }
    const a = toInt32(left.value);
    const b = toInt32(right.value);
    switch (op) {
      case 'if_icmpeq':
        return a === b;
      case 'if_icmpne':
        return a !== b;
      case 'if_icmplt':
        return a < b;
      case 'if_icmpge':
        return a >= b;
      case 'if_icmpgt':
        return a > b;
      case 'if_icmple':
        return a <= b;
      default:
        return null;
    }
  }

  if (consumed.length === 1) {
    const [value] = consumed;
    if (value.kind !== 'constant' || value.type !== 'int') {
      return null;
    }
    const operand = toInt32(value.value);
    switch (op) {
      case 'ifeq':
        return operand === 0;
      case 'ifne':
        return operand !== 0;
      case 'iflt':
        return operand < 0;
      case 'ifge':
        return operand >= 0;
      case 'ifgt':
        return operand > 0;
      case 'ifle':
        return operand <= 0;
      default:
        return null;
    }
  }
  return null;
}

function evaluateNullComparison(op, consumed) {
  if (consumed.length !== 1) {
    return null;
  }
  const [value] = consumed;
  if (value.kind !== 'constant' || value.type !== 'null') {
    return null;
  }
  if (op === 'ifnull') {
    return true;
  }
  if (op === 'ifnonnull') {
    return false;
  }
  return null;
}

function evaluateLcmp(consumed) {
  if (consumed.length !== 2) {
    return null;
  }
  const right = consumed[0];
  const left = consumed[1];
  if (left.kind !== 'constant' || right.kind !== 'constant' || left.type !== 'long' || right.type !== 'long') {
    return null;
  }
  const a = toLong(left.value);
  const b = toLong(right.value);
  if (a > b) {
    return 1;
  }
  if (a === b) {
    return 0;
  }
  return -1;
}

function evaluateFloatComparison(op, consumed) {
  if (consumed.length !== 2) {
    return null;
  }
  const right = consumed[0];
  const left = consumed[1];
  if (left.kind !== 'constant' || right.kind !== 'constant' || left.type !== 'float' || right.type !== 'float') {
    return null;
  }
  const a = toFloat32(left.value);
  const b = toFloat32(right.value);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return op === 'fcmpg' ? 1 : -1;
  }
  if (a > b) {
    return 1;
  }
  if (a === b) {
    return 0;
  }
  return -1;
}

function evaluateDoubleComparison(op, consumed) {
  if (consumed.length !== 2) {
    return null;
  }
  const right = consumed[0];
  const left = consumed[1];
  if (left.kind !== 'constant' || right.kind !== 'constant' || left.type !== 'double' || right.type !== 'double') {
    return null;
  }
  const a = Number(left.value);
  const b = Number(right.value);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return op === 'dcmpg' ? 1 : -1;
  }
  if (a > b) {
    return 1;
  }
  if (a === b) {
    return 0;
  }
  return -1;
}

function evaluateUnaryOperation(op, value) {
  if (!value || value.kind !== 'constant') {
    return null;
  }
  switch (op) {
    case 'ineg':
      if (value.type !== 'int') {
        return null;
      }
      return { type: 'int', value: toInt32(-value.value), width: 1 };
    case 'lneg':
      if (value.type !== 'long') {
        return null;
      }
      return { type: 'long', value: toLong(-value.value), width: 2 };
    case 'fneg':
      if (value.type !== 'float') {
        return null;
      }
      return { type: 'float', value: toFloat32(-value.value), width: 1 };
    case 'dneg':
      if (value.type !== 'double') {
        return null;
      }
      return { type: 'double', value: -Number(value.value), width: 2 };
    default:
      return null;
  }
}

function evaluateConversion(op, value) {
  if (!value || value.kind !== 'constant') {
    return null;
  }
  switch (op) {
    case 'i2l':
      if (value.type !== 'int') {
        return null;
      }
      return { type: 'long', value: toLong(value.value), width: 2 };
    case 'i2f':
      if (value.type !== 'int') {
        return null;
      }
      return { type: 'float', value: toFloat32(value.value), width: 1 };
    case 'i2d':
      if (value.type !== 'int') {
        return null;
      }
      return { type: 'double', value: Number(value.value), width: 2 };
    case 'l2i':
      if (value.type !== 'long') {
        return null;
      }
      return { type: 'int', value: toInt32(Number(value.value & 0xffffffffn)), width: 1 };
    case 'l2f':
      if (value.type !== 'long') {
        return null;
      }
      return { type: 'float', value: toFloat32(Number(value.value)), width: 1 };
    case 'l2d':
      if (value.type !== 'long') {
        return null;
      }
      return { type: 'double', value: Number(value.value), width: 2 };
    case 'f2i':
      if (value.type !== 'float') {
        return null;
      }
      return { type: 'int', value: toInt32(Math.trunc(value.value)), width: 1 };
    case 'f2l':
      if (value.type !== 'float') {
        return null;
      }
      return { type: 'long', value: toLong(BigInt(Math.trunc(value.value))), width: 2 };
    case 'f2d':
      if (value.type !== 'float') {
        return null;
      }
      return { type: 'double', value: Number(value.value), width: 2 };
    case 'd2i':
      if (value.type !== 'double') {
        return null;
      }
      return { type: 'int', value: toInt32(Math.trunc(value.value)), width: 1 };
    case 'd2l':
      if (value.type !== 'double') {
        return null;
      }
      return { type: 'long', value: toLong(BigInt(Math.trunc(value.value))), width: 2 };
    case 'd2f':
      if (value.type !== 'double') {
        return null;
      }
      return { type: 'float', value: toFloat32(value.value), width: 1 };
    case 'i2b':
      if (value.type !== 'int') {
        return null;
      }
      return { type: 'int', value: toInt32((value.value << 24) >> 24), width: 1 };
    case 'i2c':
      if (value.type !== 'int') {
        return null;
      }
      return { type: 'int', value: value.value & 0xffff, width: 1 };
    case 'i2s':
      if (value.type !== 'int') {
        return null;
      }
      return { type: 'int', value: toInt32((value.value << 16) >> 16), width: 1 };
    default:
      return null;
  }
}

function buildLabelMap(cfg) {
  const map = new Map();
  for (const block of cfg.blocks.values()) {
    for (const item of block.instructions) {
      if (!item || !item.labelDef) {
        continue;
      }
      const label = typeof item.labelDef === 'string' ? item.labelDef.trim() : null;
      if (!label) {
        continue;
      }
      const normalized = label.endsWith(':') ? label.slice(0, -1) : label;
      map.set(normalized, block.id);
    }
  }
  return map;
}

function getBranchLabel(normalized) {
  if (!normalized) {
    return null;
  }
  if (typeof normalized.arg === 'string') {
    return normalized.arg;
  }
  return null;
}

function updateSuccessorsForAlwaysTrue(block, targetBlockId, exceptionTargets) {
  const keep = new Set(exceptionTargets ?? []);
  if (targetBlockId) {
    keep.add(targetBlockId);
  }
  block.successors = block.successors.filter((id) => keep.has(id));
  if (targetBlockId && !block.successors.includes(targetBlockId)) {
    block.successors.push(targetBlockId);
  }
}

function updateSuccessorsForAlwaysFalse(block, targetBlockId, exceptionTargets) {
  const keep = new Set(exceptionTargets ?? []);
  block.successors = block.successors.filter((id) => {
    if (keep.has(id)) {
      return true;
    }
    return targetBlockId ? id !== targetBlockId : true;
  });
}

function simulateBlock(block, entryStack, entryLocals, blockId) {
  const stack = cloneStack(entryStack);
  const locals = cloneLocals(entryLocals);
  const instructions = [];

  for (const item of block.instructions) {
    if (!item || !item.instruction) {
      continue;
    }
    const normalized = normalizeInstruction(item.instruction);
    if (!normalized || !normalized.op) {
      return { failed: true };
    }

    const effect = getStackEffect(normalized.op, normalized);
    if (!effect) {
      return { failed: true };
    }

    const consumed = popValues(stack, effect.popSlots || 0);
    if (consumed === null) {
      return { failed: true };
    }

    const info = { item, normalized, effect, consumed };

    if (effect.special === 'dup') {
      if (consumed.length !== 1) {
        return { failed: true };
      }
      const [top] = consumed;
      if (!top) {
        return { failed: true };
      }
      top.removable = false;
      const duplicate = cloneValue(top);
      duplicate.removable = false;
      stack.push(top);
      stack.push(duplicate);
      instructions.push(info);
      continue;
    }

    let produced = [];
    let fold = null;
    let branchFold = null;

    const localOp = parseLocalOperation(normalized, item.instruction);
    const literal = extractLiteral(normalized, item.instruction);

    if (literal) {
      produced = [createConstantValue(literal.type, literal.value, literal.width, blockId, item, true)];
    } else if (localOp && LOAD_BASES.has(localOp.base)) {
      const loadMeta = LOAD_TYPE[localOp.base] || { type: 'unknown', width: effect.pushSlots };
      const localValue = locals.get(localOp.index);
      if (localValue && localValue.kind === 'constant') {
        const valueType = localValue.type === 'null' && loadMeta.type === 'reference' ? 'null' : localValue.type;
        if (valueType === loadMeta.type || valueType === 'null') {
          const width = localValue.width || loadMeta.width;
          const { produced: p, fold: f } = buildConstantFold(valueType, localValue.value, width, [], blockId, item);
          produced = p;
          fold = f;
        }
      }
      if (produced.length === 0) {
        produced = [createUnknown(loadMeta.width, loadMeta.type)];
      }
    } else if (INT_BINARY_OPS.has(normalized.op)) {
      const right = consumed[0];
      const left = consumed[1];
      if (
        left &&
        right &&
        left.kind === 'constant' &&
        left.type === 'int' &&
        right.kind === 'constant' &&
        right.type === 'int'
      ) {
        const result = evaluateIntBinary(normalized.op, toInt32(left.value), toInt32(right.value));
        if (result !== null) {
          const folded = buildConstantFold('int', result, 1, consumed, blockId, item);
          produced = folded.produced;
          fold = folded.fold;
        }
      }
    } else if (LONG_BINARY_OPS.has(normalized.op)) {
      const right = consumed[0];
      const left = consumed[1];
      if (
        left &&
        right &&
        left.kind === 'constant' &&
        left.type === 'long' &&
        right.kind === 'constant' &&
        right.type === 'long'
      ) {
        const result = evaluateLongBinary(normalized.op, left.value, right.value);
        if (result !== null) {
          const folded = buildConstantFold('long', result, 2, consumed, blockId, item);
          produced = folded.produced;
          fold = folded.fold;
        }
      }
    } else if (FLOAT_BINARY_OPS.has(normalized.op)) {
      const right = consumed[0];
      const left = consumed[1];
      if (
        left &&
        right &&
        left.kind === 'constant' &&
        left.type === 'float' &&
        right.kind === 'constant' &&
        right.type === 'float'
      ) {
        const result = evaluateFloatBinary(normalized.op, left.value, right.value);
        if (result !== null) {
          const folded = buildConstantFold('float', result, 1, consumed, blockId, item);
          produced = folded.produced;
          fold = folded.fold;
        }
      }
    } else if (DOUBLE_BINARY_OPS.has(normalized.op)) {
      const right = consumed[0];
      const left = consumed[1];
      if (
        left &&
        right &&
        left.kind === 'constant' &&
        left.type === 'double' &&
        right.kind === 'constant' &&
        right.type === 'double'
      ) {
        const result = evaluateDoubleBinary(normalized.op, left.value, right.value);
        if (result !== null) {
          const folded = buildConstantFold('double', result, 2, consumed, blockId, item);
          produced = folded.produced;
          fold = folded.fold;
        }
      }
    }

    if (produced.length === 0) {
      if (INT_COMPARISON_OPS.has(normalized.op)) {
        const outcome = evaluateIntComparison(normalized.op, consumed);
        if (typeof outcome === 'boolean') {
          branchFold = { outcome, consumed: [...consumed] };
        }
      } else if (NULL_COMPARISON_OPS.has(normalized.op)) {
        const outcome = evaluateNullComparison(normalized.op, consumed);
        if (typeof outcome === 'boolean') {
          branchFold = { outcome, consumed: [...consumed] };
        }
      } else if (normalized.op === 'lcmp') {
        const result = evaluateLcmp(consumed);
        if (result !== null) {
          const folded = buildConstantFold('int', result, 1, consumed, blockId, item);
          produced = folded.produced;
          fold = folded.fold || fold;
        }
      } else if (normalized.op === 'fcmpl' || normalized.op === 'fcmpg') {
        const result = evaluateFloatComparison(normalized.op, consumed);
        if (result !== null) {
          const folded = buildConstantFold('int', result, 1, consumed, blockId, item);
          produced = folded.produced;
          fold = folded.fold || fold;
        }
      } else if (normalized.op === 'dcmpl' || normalized.op === 'dcmpg') {
        const result = evaluateDoubleComparison(normalized.op, consumed);
        if (result !== null) {
          const folded = buildConstantFold('int', result, 1, consumed, blockId, item);
          produced = folded.produced;
          fold = folded.fold || fold;
        }
      } else {
        const unary = consumed.length === 1 ? evaluateUnaryOperation(normalized.op, consumed[0]) : null;
        if (unary) {
          const folded = buildConstantFold(unary.type, unary.value, unary.width, consumed, blockId, item);
          produced = folded.produced;
          fold = folded.fold || fold;
        } else if (consumed.length === 1) {
          const conversion = evaluateConversion(normalized.op, consumed[0]);
          if (conversion) {
            const folded = buildConstantFold(conversion.type, conversion.value, conversion.width, consumed, blockId, item);
            produced = folded.produced;
            fold = folded.fold || fold;
          }
        }
      }
    }

    if (produced.length === 0 && effect.pushSlots > 0) {
      produced = [createUnknown(effect.pushSlots)];
    }

    for (const value of produced) {
      stack.push(value);
    }

    info.produced = produced;
    info.fold = fold;
    info.branchFold = branchFold;
    instructions.push(info);

    if (localOp && STORE_BASES.has(localOp.base)) {
      const storeMeta = STORE_TYPE[localOp.base] || { width: effect.popSlots || 1, type: 'unknown' };
      let storedValue = null;
      if (consumed.length > 0) {
        const [value] = consumed;
        if (value && value.kind === 'constant') {
          storedValue = createLocalConstantValue(value.type, value.value, value.width);
        }
      }
      if (storedValue && (storeMeta.type === 'reference' || storedValue.type === storeMeta.type || storedValue.type === 'null')) {
        locals.set(localOp.index, storedValue);
      } else {
        locals.set(localOp.index, createUnknown(storeMeta.width, storeMeta.type));
      }
    } else if (normalized.op === 'iinc' && localOp) {
      locals.set(localOp.index, createUnknown(1, 'int'));
    }
  }

  return { exitStack: stack, exitLocals: locals, instructions, failed: false };
}

function parseLocalOperation(normalized, original) {
  if (!normalized || !normalized.op) {
    return null;
  }
  const { op } = normalized;
  if (op.includes('_')) {
    const [base, suffix] = op.split('_');
    const index = Number.parseInt(suffix, 10);
    if (!Number.isInteger(index)) {
      return null;
    }
    return { base, index };
  }
  if (original && typeof original === 'object' && original.arg !== undefined) {
    const index = Number.parseInt(original.arg, 10);
    if (Number.isInteger(index)) {
      return { base: op, index };
    }
  }
  return null;
}

function constantFoldCfg(cfg) {
  if (!cfg || !cfg.blocks || cfg.blocks.size === 0) {
    return { changed: false, optimizedCfg: cfg };
  }

  const handlerBlocks = cfg.handlerBlocks instanceof Set ? cfg.handlerBlocks : new Set();
  const exceptionSuccessors = cfg.exceptionSuccessors instanceof Map ? cfg.exceptionSuccessors : new Map();

  const blockStates = new Map();
  const worklist = [cfg.entryBlockId];
  blockStates.set(cfg.entryBlockId, { inStack: [], inLocals: new Map() });

  for (const handlerId of handlerBlocks) {
    if (!blockStates.has(handlerId)) {
      blockStates.set(handlerId, { inStack: [createUnknown(1)], inLocals: new Map() });
      worklist.push(handlerId);
    }
  }

  const blockInfos = new Map();

  while (worklist.length > 0) {
    const blockId = worklist.pop();
    const block = cfg.blocks.get(blockId);
    if (!block) {
      continue;
    }

    const state = blockStates.get(blockId);
    const entryStack = state && state.inStack ? cloneStack(state.inStack) : [];
    const entryLocals = state && state.inLocals ? cloneLocals(state.inLocals) : new Map();
    const { exitStack, exitLocals, instructions, failed } = simulateBlock(block, entryStack, entryLocals, blockId);

    if (failed) {
      return { changed: false, optimizedCfg: cfg };
    }

    blockInfos.set(blockId, { instructions });
    blockStates.set(blockId, { inStack: entryStack, inLocals: entryLocals, outStack: exitStack, outLocals: exitLocals });

    for (const successorId of block.successors) {
      const exceptionTargets = exceptionSuccessors.get(blockId);
      const isExceptionEdge = exceptionTargets && exceptionTargets.has(successorId);
      if (isExceptionEdge) {
        continue;
      }
      const successorState = blockStates.get(successorId);
      const existingStack = successorState ? successorState.inStack : null;
      const existingLocals = successorState ? successorState.inLocals : null;
      const mergedStack = mergeStacks(existingStack, exitStack);
      const mergedLocals = mergeLocals(existingLocals, exitLocals);
      if (mergedStack.incompatible || mergedLocals.incompatible) {
        return { changed: false, optimizedCfg: cfg };
      }
      if (mergedStack.changed || mergedLocals.changed || !successorState) {
        blockStates.set(successorId, { inStack: mergedStack.stack, inLocals: mergedLocals.locals });
        worklist.push(successorId);
      }
    }
  }

  let changed = false;
  const labelToBlock = buildLabelMap(cfg);

  for (const [blockId, info] of blockInfos.entries()) {
    const block = cfg.blocks.get(blockId);
    if (!block) {
      continue;
    }
    const exceptionTargets = exceptionSuccessors.get(blockId);

    for (let i = 0; i < info.instructions.length; i += 1) {
      const instrInfo = info.instructions[i];
      const { item, normalized, fold, branchFold } = instrInfo;

      if (fold) {
        if (!markSourcesAsNoOp(fold.consumed, blockId)) {
          continue;
        }
        item.instruction = fold.replacement;
        changed = true;
        continue;
      }

      if (normalized.op === 'pop' || normalized.op === 'pop2') {
        if (markSourcesAsNoOp(instrInfo.consumed, blockId)) {
          item.instruction = 'nop';
          changed = true;
          continue;
        }
      }

      if (branchFold) {
        const label = getBranchLabel(normalized);
        const targetBlockId = label ? labelToBlock.get(label) : null;
        if (branchFold.outcome && !label) {
          continue;
        }
        if (!markSourcesAsNoOp(branchFold.consumed, blockId)) {
          continue;
        }
        if (branchFold.outcome) {
          item.instruction = { op: 'goto', arg: label };
          updateSuccessorsForAlwaysTrue(block, targetBlockId, exceptionTargets);
        } else {
          item.instruction = 'nop';
          updateSuccessorsForAlwaysFalse(block, targetBlockId, exceptionTargets);
        }
        changed = true;
        continue;
      }

      const localOp = parseLocalOperation(normalized, item.instruction);
      if (localOp && STORE_BASES.has(localOp.base) && instrInfo.consumed && instrInfo.consumed.length === 1) {
        const [value] = instrInfo.consumed;
        if (value && value.kind === 'constant') {
          const expectedLoadBase = LOAD_FOR_STORE[localOp.base];
          const replacement = createConstantInstructionForValue(value);
          let lookahead = null;
          if (replacement && expectedLoadBase) {
            for (let j = i + 1; j < info.instructions.length; j += 1) {
              const candidate = info.instructions[j];
              const candidateOp = candidate.normalized.op;
              if (candidateOp === 'pop' || candidateOp === 'pop2') {
                continue;
              }
              lookahead = candidate;
              break;
            }
          }

          if (lookahead) {
            const nextLocal = parseLocalOperation(lookahead.normalized, lookahead.item.instruction);
            if (nextLocal && nextLocal.base === expectedLoadBase && nextLocal.index === localOp.index) {
              if (!markSourcesAsNoOp(instrInfo.consumed, blockId)) {
                continue;
              }
              item.instruction = 'nop';
              lookahead.item.instruction = replacement;
              changed = true;
            }
          }
        }
      }
    }
  }

  return { changed, optimizedCfg: cfg };
}

module.exports = {
  constantFoldCfg,
};
