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

const LOCAL_TYPE_INFO = {
  iload: { type: 'int', width: 1 },
  istore: { type: 'int', width: 1 },
  lload: { type: 'long', width: 2 },
  lstore: { type: 'long', width: 2 },
  fload: { type: 'float', width: 1 },
  fstore: { type: 'float', width: 1 },
  dload: { type: 'double', width: 2 },
  dstore: { type: 'double', width: 2 },
};

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

const FLOAT_VIEW = new DataView(new ArrayBuffer(4));

const LONG_MASK = (1n << 64n) - 1n;
const LONG_SIGN = 1n << 63n;

function toInt32(value) {
  return value | 0;
}

function toFloat32(value) {
  FLOAT_VIEW.setFloat32(0, value, false);
  return FLOAT_VIEW.getFloat32(0, false);
}

function normalizeLong(value) {
  let result = value & LONG_MASK;
  if (result & LONG_SIGN) {
    result -= LONG_MASK + 1n;
  }
  return result;
}

function createUnknown(width = 1) {
  return { kind: 'unknown', width, removable: false };
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
  if (!locals) {
    return new Map();
  }
  const cloned = new Map();
  for (const [index, value] of locals.entries()) {
    cloned.set(index, cloneValue(value));
  }
  return cloned;
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

function parseIntConstant(op, instruction) {
  if (!op) {
    return null;
  }
  if (op === 'iconst_m1') {
    return -1;
  }
  if (op.startsWith('iconst_')) {
    const suffix = op.slice('iconst_'.length);
    const parsed = Number.parseInt(suffix, 10);
    if (Number.isNaN(parsed)) {
      return null;
    }
    return parsed | 0;
  }
  if (op === 'bipush' || op === 'sipush') {
    return parseIntArg(instruction && instruction.arg);
  }
  if ((op === 'ldc' || op === 'ldc_w') && instruction && typeof instruction.arg === 'number') {
    return toInt32(instruction.arg);
  }
  return null;
}

function parseLongConstant(op, instruction) {
  if (!op) {
    return null;
  }
  if (op === 'lconst_0') {
    return 0n;
  }
  if (op === 'lconst_1') {
    return 1n;
  }
  if (op === 'ldc2_w' && instruction && typeof instruction.arg === 'bigint') {
    return normalizeLong(instruction.arg);
  }
  return null;
}

function parseFloatConstant(op, instruction) {
  if (!op) {
    return null;
  }
  if (op === 'fconst_0') {
    return 0;
  }
  if (op === 'fconst_1') {
    return 1;
  }
  if (op === 'fconst_2') {
    return 2;
  }
  if ((op === 'ldc' || op === 'ldc_w') && instruction && instruction.arg && instruction.arg.type === 'Float') {
    return toFloat32(instruction.arg.value);
  }
  return null;
}

function parseDoubleConstant(op, instruction) {
  if (!op) {
    return null;
  }
  if (op === 'dconst_0') {
    return 0;
  }
  if (op === 'dconst_1') {
    return 1;
  }
  if (op === 'ldc2_w' && instruction && instruction.arg && instruction.arg.type === 'Double') {
    return instruction.arg.value;
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
  return { op: 'ldc', arg: value };
}

function createLongConstantInstruction(value) {
  if (typeof value !== 'bigint') {
    return null;
  }
  if (value === 0n) {
    return { op: 'lconst_0' };
  }
  if (value === 1n) {
    return { op: 'lconst_1' };
  }
  return { op: 'ldc2_w', arg: value };
}

function createFloatConstantInstruction(value) {
  if (typeof value !== 'number') {
    return null;
  }
  const rounded = toFloat32(value);
  if (Object.is(rounded, 0)) {
    return { op: 'fconst_0' };
  }
  if (Object.is(rounded, 1)) {
    return { op: 'fconst_1' };
  }
  if (Object.is(rounded, 2)) {
    return { op: 'fconst_2' };
  }
  return { op: 'ldc', arg: { value: rounded, type: 'Float' } };
}

function createDoubleConstantInstruction(value) {
  if (typeof value !== 'number') {
    return null;
  }
  if (Object.is(value, 0)) {
    return { op: 'dconst_0' };
  }
  if (Object.is(value, 1)) {
    return { op: 'dconst_1' };
  }
  return { op: 'ldc2_w', arg: { value, type: 'Double' } };
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

    if (left.kind === 'constant' && right.kind === 'constant' && left.value === right.value) {
      const constant = createConstantValue(left.type, left.value, left.width, null, null, false);
      merged.push(constant);
      continue;
    }

    merged.push(createUnknown(left.width));
    if (left.kind !== 'unknown' || right.kind !== 'unknown') {
      changed = true;
    }
  }

  return { stack: merged, changed };
}

function valuesEqual(left, right) {
  if (!left || !right) {
    return false;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind !== 'constant') {
    return false;
  }
  if (left.type !== right.type || left.width !== right.width) {
    return false;
  }
  switch (left.type) {
    case 'float':
      return Object.is(toFloat32(left.value), toFloat32(right.value));
    case 'double':
      return Object.is(left.value, right.value);
    case 'long':
      return left.value === right.value;
    default:
      return left.value === right.value;
  }
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
    if (!left || !right) {
      if (left || right) {
        changed = true;
      }
      continue;
    }
    if (valuesEqual(left, right)) {
      merged.set(key, cloneValue(left));
    } else {
      changed = true;
    }
  }
  if (merged.size !== existing.size) {
    changed = true;
  }
  return { locals: merged, changed };
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
  const a = typeof left === 'bigint' ? normalizeLong(left) : null;
  let b;
  if (op === 'lshl' || op === 'lshr' || op === 'lushr') {
    b = Number.isInteger(right) ? toInt32(right) : null;
  } else {
    b = typeof right === 'bigint' ? normalizeLong(right) : null;
  }
  if (a === null || b === null) {
    return null;
  }

  switch (op) {
    case 'ladd':
      return normalizeLong(a + b);
    case 'lsub':
      return normalizeLong(a - b);
    case 'lmul':
      return normalizeLong(a * b);
    case 'ldiv':
      if (b === 0n) {
        return null;
      }
      return normalizeLong(a / b);
    case 'lrem':
      if (b === 0n) {
        return null;
      }
      return normalizeLong(a % b);
    case 'land':
      return normalizeLong(a & b);
    case 'lor':
      return normalizeLong(a | b);
    case 'lxor':
      return normalizeLong(a ^ b);
    case 'lshl':
      return normalizeLong(a << BigInt(b & 0x3f));
    case 'lshr':
      return normalizeLong(a >> BigInt(b & 0x3f));
    case 'lushr': {
      const masked = a & LONG_MASK;
      const shifted = masked >> BigInt(b & 0x3f);
      return normalizeLong(shifted);
    }
    default:
      return null;
  }
}

function evaluateFloatBinary(op, left, right) {
  if (typeof left !== 'number' || typeof right !== 'number') {
    return null;
  }
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
  if (typeof left !== 'number' || typeof right !== 'number') {
    return null;
  }
  switch (op) {
    case 'dadd':
      return left + right;
    case 'dsub':
      return left - right;
    case 'dmul':
      return left * right;
    case 'ddiv':
      return left / right;
    case 'drem':
      return left % right;
    default:
      return null;
  }
}

function evaluateLongCompare(left, right) {
  if (typeof left !== 'bigint' || typeof right !== 'bigint') {
    return null;
  }
  const a = normalizeLong(left);
  const b = normalizeLong(right);
  if (a > b) {
    return 1;
  }
  if (a < b) {
    return -1;
  }
  return 0;
}

function evaluateFloatCompare(op, left, right) {
  if (typeof left !== 'number' || typeof right !== 'number') {
    return null;
  }
  const a = toFloat32(left);
  const b = toFloat32(right);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return op === 'fcmpg' ? 1 : -1;
  }
  if (a > b) {
    return 1;
  }
  if (a < b) {
    return -1;
  }
  if (Object.is(a, b)) {
    return 0;
  }
  return op === 'fcmpg' ? 1 : -1;
}

function evaluateDoubleCompare(op, left, right) {
  if (typeof left !== 'number' || typeof right !== 'number') {
    return null;
  }
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return op === 'dcmpg' ? 1 : -1;
  }
  if (left > right) {
    return 1;
  }
  if (left < right) {
    return -1;
  }
  if (Object.is(left, right)) {
    return 0;
  }
  return op === 'dcmpg' ? 1 : -1;
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

    const localOp = parseLocalOperation(normalized, item.instruction);
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

    if (localOp && LOAD_BASES.has(localOp.base)) {
      const localInfo = LOCAL_TYPE_INFO[localOp.base];
      const known = localInfo ? locals.get(localOp.index) : null;
      if (known && known.kind === 'constant' && known.type === localInfo.type) {
        produced = [createConstantValue(localInfo.type, known.value, localInfo.width, blockId, item, true)];
      }
    }

    if (produced.length === 0) {
      const intConstant = parseIntConstant(normalized.op, normalized);
      const longConstant = intConstant === null ? parseLongConstant(normalized.op, normalized) : null;
      const floatConstant = intConstant === null && longConstant === null ? parseFloatConstant(normalized.op, normalized) : null;
      const doubleConstant = intConstant === null && longConstant === null && floatConstant === null
        ? parseDoubleConstant(normalized.op, normalized)
        : null;

      if (intConstant !== null) {
        produced = [createConstantValue('int', intConstant, 1, blockId, item, true)];
      } else if (longConstant !== null) {
        produced = [createConstantValue('long', longConstant, 2, blockId, item, true)];
      } else if (floatConstant !== null) {
        produced = [createConstantValue('float', toFloat32(floatConstant), 1, blockId, item, true)];
      } else if (doubleConstant !== null) {
        produced = [createConstantValue('double', doubleConstant, 2, blockId, item, true)];
      } else if (normalized.op === 'aconst_null') {
        produced = [createConstantValue('null', null, 1, blockId, item, true)];
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
          const replacement = result === null ? null : createIntConstantInstruction(result);
          const removable = Boolean(replacement) && canRemoveValue(left, blockId) && canRemoveValue(right, blockId);
          if (replacement && removable) {
            fold = { replacement, consumed: [...consumed], value: result };
            produced = [createConstantValue('int', result, 1, blockId, item, true)];
          }
        }
      } else if (LONG_BINARY_OPS.has(normalized.op)) {
        const right = consumed[0];
        const left = consumed[1];
        const rightType = normalized.op === 'lshl' || normalized.op === 'lshr' || normalized.op === 'lushr' ? 'int' : 'long';
        if (
          left &&
          right &&
          left.kind === 'constant' &&
          left.type === 'long' &&
          right.kind === 'constant' &&
          right.type === rightType
        ) {
          const result = evaluateLongBinary(
            normalized.op,
            left.value,
            rightType === 'int' ? toInt32(right.value) : right.value,
          );
          const replacement = result === null ? null : createLongConstantInstruction(result);
          const removable = Boolean(replacement) && canRemoveValue(left, blockId) && canRemoveValue(right, blockId);
          if (replacement && removable) {
            fold = { replacement, consumed: [...consumed], value: result };
            produced = [createConstantValue('long', result, 2, blockId, item, true)];
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
          const replacement = result === null ? null : createFloatConstantInstruction(result);
          const removable = Boolean(replacement) && canRemoveValue(left, blockId) && canRemoveValue(right, blockId);
          if (replacement && removable) {
            const rounded = toFloat32(result);
            fold = { replacement, consumed: [...consumed], value: rounded };
            produced = [createConstantValue('float', rounded, 1, blockId, item, true)];
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
          const replacement = result === null ? null : createDoubleConstantInstruction(result);
          const removable = Boolean(replacement) && canRemoveValue(left, blockId) && canRemoveValue(right, blockId);
          if (replacement && removable) {
            fold = { replacement, consumed: [...consumed], value: result };
            produced = [createConstantValue('double', result, 2, blockId, item, true)];
          }
        }
      } else if (normalized.op === 'lcmp') {
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
          const result = evaluateLongCompare(left.value, right.value);
          const replacement = result === null ? null : createIntConstantInstruction(result);
          const removable = Boolean(replacement) && canRemoveValue(left, blockId) && canRemoveValue(right, blockId);
          if (replacement && removable) {
            fold = { replacement, consumed: [...consumed], value: result };
            produced = [createConstantValue('int', result, 1, blockId, item, true)];
          }
        }
      } else if (normalized.op === 'fcmpl' || normalized.op === 'fcmpg') {
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
          const result = evaluateFloatCompare(normalized.op, left.value, right.value);
          const replacement = result === null ? null : createIntConstantInstruction(result);
          const removable = Boolean(replacement) && canRemoveValue(left, blockId) && canRemoveValue(right, blockId);
          if (replacement && removable) {
            fold = { replacement, consumed: [...consumed], value: result };
            produced = [createConstantValue('int', result, 1, blockId, item, true)];
          }
        }
      } else if (normalized.op === 'dcmpl' || normalized.op === 'dcmpg') {
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
          const result = evaluateDoubleCompare(normalized.op, left.value, right.value);
          const replacement = result === null ? null : createIntConstantInstruction(result);
          const removable = Boolean(replacement) && canRemoveValue(left, blockId) && canRemoveValue(right, blockId);
          if (replacement && removable) {
            fold = { replacement, consumed: [...consumed], value: result };
            produced = [createConstantValue('int', result, 1, blockId, item, true)];
          }
        }
      } else if (INT_COMPARISON_OPS.has(normalized.op)) {
        const outcome = evaluateIntComparison(normalized.op, consumed);
        if (typeof outcome === 'boolean') {
          branchFold = { outcome, consumed: [...consumed] };
        }
      } else if (NULL_COMPARISON_OPS.has(normalized.op)) {
        const outcome = evaluateNullComparison(normalized.op, consumed);
        if (typeof outcome === 'boolean') {
          branchFold = { outcome, consumed: [...consumed] };
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
    info.localOp = localOp;
    instructions.push(info);

    if (localOp && STORE_BASES.has(localOp.base)) {
      const localInfo = LOCAL_TYPE_INFO[localOp.base];
      const storedValue = consumed[0];
      if (
        localInfo &&
        storedValue &&
        storedValue.kind === 'constant' &&
        storedValue.type === localInfo.type
      ) {
        const stored = cloneValue(storedValue);
        stored.removable = false;
        stored.producerItem = null;
        stored.producerBlockId = null;
        stored.useCount = 0;
        locals.set(localOp.index, stored);
      } else if (localInfo) {
        locals.delete(localOp.index);
      } else {
        locals.delete(localOp.index);
      }
      if (localInfo && localInfo.width === 2) {
        locals.delete(localOp.index + 1);
      }
    } else if (normalized.op === 'iinc') {
      const { varnum, incr } = item.instruction || {};
      const index = Number.parseInt(varnum, 10);
      const amount = Number.parseInt(incr, 10);
      if (Number.isInteger(index) && Number.isInteger(amount)) {
        const existing = locals.get(index);
        if (existing && existing.kind === 'constant' && existing.type === 'int') {
          const updated = toInt32(existing.value + amount);
          locals.set(index, createConstantValue('int', updated, 1, null, null, false));
        } else {
          locals.delete(index);
        }
      }
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

    const state = blockStates.get(blockId) || { inStack: [], inLocals: new Map() };
    const entryStack = state.inStack ? cloneStack(state.inStack) : [];
    const entryLocals = state.inLocals ? cloneLocals(state.inLocals) : new Map();
    const { exitStack, exitLocals, instructions, failed } = simulateBlock(block, entryStack, entryLocals, blockId);

    if (failed) {
      return { changed: false, optimizedCfg: cfg };
    }

    blockInfos.set(blockId, { instructions });
    blockStates.set(blockId, {
      inStack: state.inStack || [],
      inLocals: state.inLocals || new Map(),
      outStack: exitStack,
      outLocals: exitLocals,
    });

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
      if (mergedStack.incompatible) {
        return { changed: false, optimizedCfg: cfg };
      }
      const mergedLocals = mergeLocals(existingLocals, exitLocals);
      if (mergedStack.changed || mergedLocals.changed || !successorState) {
        blockStates.set(successorId, {
          inStack: mergedStack.stack,
          inLocals: mergedLocals.locals,
        });
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
        if (value && value.kind === 'constant' && value.type === 'int') {
          const replacement = createIntConstantInstruction(value.value);
          const expectedLoadBase = LOAD_FOR_STORE[localOp.base];
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
