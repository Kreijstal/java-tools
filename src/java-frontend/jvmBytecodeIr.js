'use strict';

const {
  BYTECODE_IR_SCHEMA_ID,
  BYTECODE_IR_SCHEMA_VERSION,
  buildBytecodeIr,
} = require('./compiler');
const { validateAstDocument } = require('./serialization');
const { getAttachedJavaIrDocument, validateJavaIrDocument } = require('./javaIr');

const JVM_BYTECODE_IR_SCHEMA_ID = BYTECODE_IR_SCHEMA_ID;
const JVM_BYTECODE_IR_SCHEMA_VERSION = BYTECODE_IR_SCHEMA_VERSION;
const JVM_BYTECODE_IR_AST_META_KEY = 'javaFrontendBytecodeIr';

const PRIMITIVE_WRAPPER_BY_DESCRIPTOR = Object.freeze({
  Z: 'java/lang/Boolean',
  B: 'java/lang/Byte',
  C: 'java/lang/Character',
  S: 'java/lang/Short',
  I: 'java/lang/Integer',
  J: 'java/lang/Long',
  F: 'java/lang/Float',
  D: 'java/lang/Double',
});

const UNBOX_METHOD_BY_DESCRIPTOR = Object.freeze({
  Z: 'booleanValue',
  B: 'byteValue',
  C: 'charValue',
  S: 'shortValue',
  I: 'intValue',
  J: 'longValue',
  F: 'floatValue',
  D: 'doubleValue',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function assertJsonValue(value, path = '$', seen = new Set()) {
  const type = typeof value;
  if (value === null || type === 'string' || type === 'number' || type === 'boolean') {
    if (type === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`${path} must not contain non-finite numbers`);
    }
    return;
  }
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new TypeError(`${path} contains a non-JSON value (${type})`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${path} contains a cycle`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertJsonValue(value[i], `${path}[${i}]`, seen);
    }
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      assertJsonValue(value[key], `${path}.${key}`, seen);
    }
  } else {
    throw new TypeError(`${path} contains a non-plain object`);
  }
  seen.delete(value);
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableJsonValue(value[key]);
  }
  return out;
}

function cloneJsonValue(value) {
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value));
}

function createJvmBytecodeIrDocument(classes = [], options = {}) {
  return {
    schema: JVM_BYTECODE_IR_SCHEMA_ID,
    version: JVM_BYTECODE_IR_SCHEMA_VERSION,
    status: options.status || 'complete',
    backend: options.backend || 'jvm-stack-bytecode',
    sourceLevel: options.sourceLevel || null,
    classes,
    unsupported: options.unsupported || [],
  };
}

function createJvmBytecodeClass(fields = {}) {
  return {
    kind: 'Class',
    name: fields.name,
    packageName: fields.packageName || '',
    internalName: fields.internalName,
    sourceFile: fields.sourceFile || null,
    access: fields.access || [],
    attributes: fields.attributes || [],
    superName: fields.superName || 'java/lang/Object',
    interfaces: fields.interfaces || [],
    fields: fields.fields || [],
    methods: fields.methods || [],
  };
}

function createJvmBytecodeMethod(fields = {}) {
  return {
    kind: fields.kind || 'Method',
    name: fields.name,
    descriptor: fields.descriptor,
    access: fields.access || [],
    attributes: fields.attributes || [],
    maxStack: fields.maxStack || 0,
    maxLocals: fields.maxLocals || 0,
    returnDescriptor: fields.returnDescriptor || (fields.descriptor ? fields.descriptor.slice(fields.descriptor.indexOf(')') + 1) : 'V'),
    instructions: fields.instructions || [],
    exceptionTable: fields.exceptionTable || [],
    sourceNodeKind: fields.sourceNodeKind || null,
    meta: fields.meta || {},
  };
}

function createJvmInstruction(opcode, operands = [], fields = {}) {
  return {
    opcode,
    operands,
    ...fields,
  };
}

function slotWidthFromDescriptor(descriptor) {
  return descriptor === 'J' || descriptor === 'D' ? 2 : 1;
}

function parameterSlotCount(descriptor) {
  const start = descriptor.indexOf('(');
  const end = descriptor.indexOf(')');
  if (start < 0 || end < start) return 0;
  let count = 0;
  for (let index = start + 1; index < end; index += 1) {
    let char = descriptor[index];
    while (char === '[') {
      index += 1;
      char = descriptor[index];
    }
    if (char === 'L') {
      while (index < end && descriptor[index] !== ';') index += 1;
      count += 1;
    } else {
      count += slotWidthFromDescriptor(char);
    }
  }
  return count;
}

function loadOpcodeForDescriptor(descriptor) {
  if (descriptor === 'J') return 'lload';
  if (descriptor === 'F') return 'fload';
  if (descriptor === 'D') return 'dload';
  if (descriptor === 'I' || descriptor === 'Z' || descriptor === 'B' || descriptor === 'C' || descriptor === 'S') return 'iload';
  return 'aload';
}

function storeOpcodeForDescriptor(descriptor) {
  if (descriptor === 'J') return 'lstore';
  if (descriptor === 'F') return 'fstore';
  if (descriptor === 'D') return 'dstore';
  if (descriptor === 'I' || descriptor === 'Z' || descriptor === 'B' || descriptor === 'C' || descriptor === 'S') return 'istore';
  return 'astore';
}

function returnOpcodeForDescriptor(descriptor) {
  if (descriptor === 'V') return 'return';
  if (descriptor === 'J') return 'lreturn';
  if (descriptor === 'F') return 'freturn';
  if (descriptor === 'D') return 'dreturn';
  if (descriptor === 'I' || descriptor === 'Z' || descriptor === 'B' || descriptor === 'C' || descriptor === 'S') return 'ireturn';
  return 'areturn';
}


function arrayLoadOpcodeForDescriptor(descriptor) {
  if (descriptor === 'J') return 'laload';
  if (descriptor === 'F') return 'faload';
  if (descriptor === 'D') return 'daload';
  if (descriptor === 'B' || descriptor === 'Z') return 'baload';
  if (descriptor === 'C') return 'caload';
  if (descriptor === 'S') return 'saload';
  if (descriptor === 'I') return 'iaload';
  return 'aaload';
}

function arrayStoreOpcodeForDescriptor(descriptor) {
  if (descriptor === 'J') return 'lastore';
  if (descriptor === 'F') return 'fastore';
  if (descriptor === 'D') return 'dastore';
  if (descriptor === 'B' || descriptor === 'Z') return 'bastore';
  if (descriptor === 'C') return 'castore';
  if (descriptor === 'S') return 'sastore';
  if (descriptor === 'I') return 'iastore';
  return 'aastore';
}

function maxLocalSlots(method) {
  let max = 0;
  for (const local of method.locals || []) {
    if (typeof local.slotHint === 'number') {
      max = Math.max(max, local.slotHint + slotWidthFromDescriptor(local.descriptor));
    }
  }
  return max;
}

function integerPushInstruction(value) {
  if (value >= -1 && value <= 5) {
    return createJvmInstruction(value === -1 ? 'iconst_m1' : `iconst_${value}`);
  }
  if (value >= -128 && value <= 127) {
    return createJvmInstruction('bipush', [String(value)]);
  }
  if (value >= -32768 && value <= 32767) {
    return createJvmInstruction('sipush', [String(value)]);
  }
  return createJvmInstruction('ldc', [String(value)]);
}

function stripNumericSuffix(raw) {
  const text = String(raw).replace(/_/g, '');
  if (/^[+-]?0[xX][0-9a-fA-F]+[lL]?$/.test(text)) return text.replace(/[lL]$/, '');
  return text.replace(/[lLfFdD]$/, '');
}

function parseJavaFloatingLiteral(raw) {
  const text = stripNumericSuffix(raw);
  const match = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?[0-9]+)$/.exec(text);
  if (!match) return Number.parseFloat(text);
  const [, signText, wholeRaw, fractionRaw = '', exponentRaw] = match;
  let significand = Number.parseInt(wholeRaw || '0', 16);
  for (let index = 0; index < fractionRaw.length; index += 1) {
    significand += Number.parseInt(fractionRaw[index], 16) / (16 ** (index + 1));
  }
  return (signText === '-' ? -1 : 1) * significand * (2 ** Number.parseInt(exponentRaw, 10));
}

function parseIntegerLiteral(raw) {
  const text = String(raw).replace(/_/g, '').replace(/[lL]$/, '');
  const sign = text.startsWith('-') ? -1 : 1;
  const unsigned = text.replace(/^[+-]/, '');
  if (/^0[xX][0-9a-fA-F]+$/.test(unsigned)) return sign * Number.parseInt(unsigned.slice(2), 16);
  if (/^0[bB][01]+$/.test(unsigned)) return sign * Number.parseInt(unsigned.slice(2), 2);
  if (/^0[0-7]+$/.test(unsigned)) return sign * Number.parseInt(unsigned.slice(1), 8);
  return Number.parseInt(text, 10);
}

function longPushInstruction(value) {
  const parsed = BigInt(stripNumericSuffix(value));
  if (parsed === 0n) return createJvmInstruction('lconst_0');
  if (parsed === 1n) return createJvmInstruction('lconst_1');
  return createJvmInstruction('ldc2_w', [`${parsed.toString()}L`]);
}

function floatPushInstruction(value) {
  const parsed = parseJavaFloatingLiteral(value);
  if (Object.is(parsed, 0)) return createJvmInstruction('fconst_0');
  if (parsed === 1) return createJvmInstruction('fconst_1');
  if (parsed === 2) return createJvmInstruction('fconst_2');
  return createJvmInstruction('ldc', [`${parsed}f`]);
}

function doublePushInstruction(value) {
  const parsed = parseJavaFloatingLiteral(value);
  if (Object.is(parsed, 0)) return createJvmInstruction('dconst_0');
  if (parsed === 1) return createJvmInstruction('dconst_1');
  const text = String(parsed);
  const literal = /^[+-]?\d+$/.test(text) ? `${text}.0` : text;
  return createJvmInstruction('ldc2_w', [literal]);
}

function intCompatibleInvokeDescriptor(descriptor) {
  if (descriptor === 'B' || descriptor === 'S') return 'I';
  if (descriptor === 'Ljava/lang/String;' || descriptor === '[C') return descriptor;
  if (typeof descriptor === 'string' && (descriptor.startsWith('L') || descriptor.startsWith('['))) {
    return 'Ljava/lang/Object;';
  }
  return descriptor;
}

function escapeJasminStringLiteral(value) {
  return JSON.stringify(value === undefined || value === null ? '' : String(value));
}

function literalLoadInstruction(value) {
  if (!value || value.kind !== 'LiteralValue') {
    return null;
  }
  if (value.literalKind === 'string') {
    return {
      descriptor: 'Ljava/lang/String;',
      instruction: createJvmInstruction('ldc', [escapeJasminStringLiteral(value.value)]),
      stack: 1,
    };
  }
  if (value.literalKind === 'number') {
    if (value.type === 'J') {
      return {
        descriptor: 'J',
        instruction: longPushInstruction(value.raw || value.value),
        stack: 2,
      };
    }
    if (value.type === 'F') {
      return {
        descriptor: 'F',
        instruction: floatPushInstruction(value.raw || value.value),
        stack: 1,
      };
    }
    if (value.type === 'D') {
      return {
        descriptor: 'D',
        instruction: doublePushInstruction(value.raw || value.value),
        stack: 2,
      };
    }
    const parsed = parseIntegerLiteral(value.value);
    if (!Number.isFinite(parsed)) return null;
    return {
      descriptor: 'I',
      instruction: integerPushInstruction(parsed),
      stack: 1,
    };
  }
  if (value.literalKind === 'boolean') {
    return {
      descriptor: 'Z',
      instruction: createJvmInstruction(value.value ? 'iconst_1' : 'iconst_0'),
      stack: 1,
    };
  }
  if (value.literalKind === 'char') {
    return {
      descriptor: 'C',
      instruction: integerPushInstruction(value.value),
      stack: 1,
    };
  }
  if (value.literalKind === 'null') {
    return {
      descriptor: value.type || 'Ljava/lang/Object;',
      instruction: createJvmInstruction('aconst_null'),
      stack: 1,
    };
  }
  return null;
}

function buildLocalMap(method) {
  const locals = new Map();
  for (const local of method.locals || []) {
    locals.set(local.id, local);
  }
  return locals;
}

function emitValue(value, state) {
  if (!value) return null;
  if (value.kind === 'LiteralValue') {
    const literal = literalLoadInstruction(value);
    if (!literal) return null;
    state.instructions.push(literal.instruction);
    state.maxStack = Math.max(state.maxStack, literal.stack);
    return { descriptor: literal.descriptor, stack: literal.stack };
  }
  if (value.kind === 'LocalValue') {
    const local = state.locals.get(value.local);
    if (!local || typeof local.slotHint !== 'number') return null;
    state.instructions.push(createJvmInstruction(loadOpcodeForDescriptor(local.descriptor), [String(local.slotHint)]));
    const stack = slotWidthFromDescriptor(local.descriptor);
    state.maxStack = Math.max(state.maxStack, stack);
    return { descriptor: local.descriptor, stack };
  }
  if (value.kind === 'ArrayLengthValue') {
    const array = emitValue(value.array, state);
    if (!array || typeof array.descriptor !== 'string' || !array.descriptor.startsWith('[')) return null;
    state.instructions.push(createJvmInstruction('arraylength'));
    state.maxStack = Math.max(state.maxStack, 1);
    return { descriptor: 'I', stack: 1 };
  }
  if (value.kind === 'ArrayLoadValue') {
    const array = emitValue(value.array, state);
    const index = emitValue(value.index, state);
    if (!array || !index || !array.descriptor.startsWith('[') || index.descriptor !== 'I') return null;
    state.instructions.push(createJvmInstruction(arrayLoadOpcodeForDescriptor(value.type)));
    const stack = slotWidthFromDescriptor(value.type);
    state.maxStack = Math.max(state.maxStack, 2, stack);
    return { descriptor: value.type, stack };
  }
  if (value.kind === 'FieldValue') {
    const receiver = emitValue(value.receiver, state);
    if (!receiver) return null;
    state.instructions.push(createJvmInstruction('getfield', ['Field', value.owner, value.name, value.descriptor]));
    const stack = slotWidthFromDescriptor(value.descriptor);
    state.maxStack = Math.max(state.maxStack, receiver.stack, stack);
    return { descriptor: value.descriptor, stack };
  }
  if (value.kind === 'StaticFieldValue') {
    state.instructions.push(createJvmInstruction('getstatic', ['Field', value.owner, value.name, value.descriptor]));
    const stack = slotWidthFromDescriptor(value.descriptor);
    state.maxStack = Math.max(state.maxStack, stack);
    return { descriptor: value.descriptor, stack };
  }
  if (value.kind === 'ClassLiteralValue') {
    state.instructions.push(createJvmInstruction('ldc', ['Class', value.className]));
    state.maxStack = Math.max(state.maxStack, 1);
    return { descriptor: 'Ljava/lang/Class;', stack: 1 };
  }
  if (value.kind === 'InstanceOfValue') {
    const emitted = emitValue(value.value, state);
    if (!emitted || !(emitted.descriptor.startsWith('L') || emitted.descriptor.startsWith('['))) return null;
    state.instructions.push(createJvmInstruction('instanceof', [value.className]));
    state.maxStack = Math.max(state.maxStack, emitted.stack, 1);
    return { descriptor: 'Z', stack: 1 };
  }
  if (value.kind === 'NewArrayValue') {
    const count = emitValue(value.count, state);
    if (!count || count.descriptor !== 'I') return null;
    if (value.reference) {
      state.instructions.push(createJvmInstruction('anewarray', [value.component]));
    } else {
      state.instructions.push(createJvmInstruction('newarray', [value.component]));
    }
    state.maxStack = Math.max(state.maxStack, 1);
    return { descriptor: value.type, stack: 1 };
  }
  if (value.kind === 'MultiNewArrayValue') {
    let argStack = 0;
    for (const countValue of value.counts || []) {
      const count = emitValue(countValue, state);
      if (!count || count.descriptor !== 'I') return null;
      argStack += 1;
    }
    state.instructions.push(createJvmInstruction('multianewarray', [value.type, String((value.counts || []).length)]));
    state.maxStack = Math.max(state.maxStack, argStack, 1);
    return { descriptor: value.type, stack: 1 };
  }
  if (value.kind === 'ArrayInitializerValue') {
    if (!value.type || !value.type.startsWith('[')) return null;
    const component = value.type.slice(1);
    state.instructions.push(integerPushInstruction((value.elements || []).length));
    if (component.startsWith('L') || component.startsWith('[')) {
      state.instructions.push(createJvmInstruction('anewarray', [component.startsWith('L') && component.endsWith(';') ? component.slice(1, -1) : component]));
    } else {
      const primitiveName = {
        Z: 'boolean',
        B: 'byte',
        C: 'char',
        S: 'short',
        I: 'int',
        J: 'long',
        F: 'float',
        D: 'double',
      }[component];
      if (!primitiveName) return null;
      state.instructions.push(createJvmInstruction('newarray', [primitiveName]));
    }
    for (let index = 0; index < (value.elements || []).length; index += 1) {
      state.instructions.push(createJvmInstruction('dup'));
      state.instructions.push(integerPushInstruction(index));
      const element = emitValue(value.elements[index], state);
      if (!element || element.descriptor !== component) return null;
      state.instructions.push(createJvmInstruction(arrayStoreOpcodeForDescriptor(component)));
    }
    state.maxStack = Math.max(state.maxStack, 4);
    return { descriptor: value.type, stack: 1 };
  }
  if (value.kind === 'NewObjectValue') {
    state.instructions.push(createJvmInstruction('new', [value.owner]));
    state.instructions.push(createJvmInstruction('dup'));
    let argStack = 0;
    for (const arg of value.args || []) {
      const emitted = emitValue(arg, state);
      if (!emitted) return null;
      argStack += emitted.stack;
    }
    state.instructions.push(createJvmInstruction('invokespecial', ['Method', value.owner, '<init>', value.descriptor]));
    state.maxStack = Math.max(state.maxStack, 2 + argStack);
    return { descriptor: value.type, stack: 1 };
  }
  if (value.kind === 'StringConcatValue') {
    state.instructions.push(createJvmInstruction('new', ['java/lang/StringBuilder']));
    state.instructions.push(createJvmInstruction('dup'));
    state.instructions.push(createJvmInstruction('invokespecial', ['Method', 'java/lang/StringBuilder', '<init>', '()V']));
    state.maxStack = Math.max(state.maxStack, 2);
    for (const part of value.parts || []) {
      const emitted = emitValue(part, state);
      if (!emitted) return null;
      const descriptor = ['I', 'Z', 'C', 'J', 'F', 'D'].includes(emitted.descriptor)
        ? emitted.descriptor
        : (emitted.descriptor === 'B' || emitted.descriptor === 'S')
          ? 'I'
        : (emitted.descriptor === 'Ljava/lang/String;' ? 'Ljava/lang/String;' : 'Ljava/lang/Object;');
      state.instructions.push(createJvmInstruction('invokevirtual', [
        'Method',
        'java/lang/StringBuilder',
        'append',
        `(${descriptor})Ljava/lang/StringBuilder;`,
      ]));
      state.maxStack = Math.max(state.maxStack, 1 + emitted.stack);
    }
    state.instructions.push(createJvmInstruction('invokevirtual', [
      'Method',
      'java/lang/StringBuilder',
      'toString',
      '()Ljava/lang/String;',
    ]));
    return { descriptor: 'Ljava/lang/String;', stack: 1 };
  }
  if (value.kind === 'ConditionalValue') {
    if (!value.condition || !value.consequent || !value.alternate || value.consequent.type !== value.type || value.alternate.type !== value.type) {
      return null;
    }
    const falseLabel = `Lcond_false_${state.nextLabel++}`;
    const endLabel = `Lcond_end_${state.nextLabel++}`;
    if (!emitFalseBranch(value.condition, falseLabel, state)) return null;
    const consequent = emitValue(value.consequent, state);
    if (!consequent || consequent.descriptor !== value.type) return null;
    state.instructions.push(createJvmInstruction('goto', [endLabel]));
    state.instructions.push(createJvmInstruction('nop', [], { label: falseLabel }));
    const alternate = emitValue(value.alternate, state);
    if (!alternate || alternate.descriptor !== value.type) return null;
    state.instructions.push(createJvmInstruction('nop', [], { label: endLabel }));
    const stack = slotWidthFromDescriptor(value.type);
    state.maxStack = Math.max(state.maxStack, consequent.stack, alternate.stack, stack);
    return { descriptor: value.type, stack };
  }
  if (value.kind === 'AssignValue') {
    const local = state.locals.get(value.target);
    const emitted = emitValue(value.value, state);
    if (!local || !emitted || emitted.descriptor !== local.descriptor || typeof local.slotHint !== 'number') return null;
    state.instructions.push(createJvmInstruction(storeOpcodeForDescriptor(local.descriptor), [String(local.slotHint)]));
    state.instructions.push(createJvmInstruction(loadOpcodeForDescriptor(local.descriptor), [String(local.slotHint)]));
    const stack = slotWidthFromDescriptor(local.descriptor);
    state.maxStack = Math.max(state.maxStack, emitted.stack, stack);
    return { descriptor: local.descriptor, stack };
  }
  if (value.kind === 'PostUpdateValue') {
    const local = state.locals.get(value.target);
    if (!local || local.descriptor !== 'I' || typeof local.slotHint !== 'number') return null;
    state.instructions.push(createJvmInstruction('iload', [String(local.slotHint)]));
    state.instructions.push(createJvmInstruction('iinc', [String(local.slotHint), value.operator === '--' ? '-1' : '1']));
    state.maxStack = Math.max(state.maxStack, 1);
    return { descriptor: 'I', stack: 1 };
  }
  if (value.kind === 'BinaryValue') {
    if (value.type === 'Ljava/lang/String;' && value.operator === '+') {
      return emitValue({
        kind: 'StringConcatValue',
        type: 'Ljava/lang/String;',
        parts: [value.left, value.right],
      }, state);
    }
    const left = emitValue(value.left, state);
    const right = emitValue(value.right, state);
    const isShift = value.operator === '<<' || value.operator === '>>' || value.operator === '>>>';
    if (!left || !right || left.descriptor !== value.type || (isShift ? right.descriptor !== 'I' : right.descriptor !== value.type)) return null;
    const prefix = {
      I: 'i',
      J: 'l',
      F: 'f',
      D: 'd',
    }[value.type];
    if (!prefix) return null;
    const suffix = {
      '+': 'add',
      '-': 'sub',
      '*': 'mul',
      '/': 'div',
      '%': 'rem',
      '&': 'and',
      '|': 'or',
      '^': 'xor',
      '<<': 'shl',
      '>>': 'shr',
      '>>>': 'ushr',
    }[value.operator];
    const opcode = suffix ? `${prefix}${suffix}` : null;
    if (!opcode) return null;
    state.instructions.push(createJvmInstruction(opcode));
    state.maxStack = Math.max(state.maxStack, slotWidthFromDescriptor(value.type) * 2);
    return { descriptor: value.type, stack: slotWidthFromDescriptor(value.type) };
  }
  if (value.kind === 'UnaryValue') {
    const emitted = emitValue(value.value, state);
    if (!emitted || emitted.descriptor !== value.type) return null;
    if (value.operator === '!') {
      if (value.type !== 'Z') return null;
      const trueLabel = `Lnot_true_${state.nextLabel++}`;
      const endLabel = `Lnot_end_${state.nextLabel++}`;
      state.instructions.push(createJvmInstruction('ifeq', [trueLabel]));
      state.instructions.push(createJvmInstruction('iconst_0'));
      state.instructions.push(createJvmInstruction('goto', [endLabel]));
      state.instructions.push(createJvmInstruction('iconst_1', [], { label: trueLabel }));
      state.instructions.push(createJvmInstruction('nop', [], { label: endLabel }));
      state.maxStack = Math.max(state.maxStack, emitted.stack, 1);
      return { descriptor: 'Z', stack: 1 };
    }
    if (value.operator === '~') {
      if (value.type === 'I') {
        state.instructions.push(integerPushInstruction(-1));
        state.instructions.push(createJvmInstruction('ixor'));
        state.maxStack = Math.max(state.maxStack, 2);
        return { descriptor: 'I', stack: 1 };
      }
      if (value.type === 'J') {
        state.instructions.push(longPushInstruction('-1'));
        state.instructions.push(createJvmInstruction('lxor'));
        state.maxStack = Math.max(state.maxStack, 4);
        return { descriptor: 'J', stack: 2 };
      }
      return null;
    }
    if (value.operator !== '-') return null;
    const opcode = {
      I: 'ineg',
      J: 'lneg',
      F: 'fneg',
      D: 'dneg',
    }[value.type];
    if (!opcode) return null;
    state.instructions.push(createJvmInstruction(opcode));
    const stack = slotWidthFromDescriptor(value.type);
    state.maxStack = Math.max(state.maxStack, emitted.stack, stack);
    return { descriptor: value.type, stack };
  }
  if (value.kind === 'CompareValue') {
    const left = emitValue(value.left, state);
    const right = emitValue(value.right, state);
    if (!left || !right || left.descriptor !== right.descriptor) return null;
    const branchOpcode = (() => {
      if (left.descriptor === 'J') {
        return {
          '==': 'ifeq',
          '!=': 'ifne',
          '<': 'iflt',
          '>': 'ifgt',
          '<=': 'ifle',
          '>=': 'ifge',
        }[value.operator] || null;
      }
      if (left.descriptor === 'F' || left.descriptor === 'D') {
        return {
          '==': 'ifeq',
          '!=': 'ifne',
          '<': 'iflt',
          '>': 'ifgt',
          '<=': 'ifle',
          '>=': 'ifge',
        }[value.operator] || null;
      }
      if (left.descriptor === 'I' || left.descriptor === 'Z' || left.descriptor === 'B' || left.descriptor === 'C' || left.descriptor === 'S') {
        return {
          '==': 'if_icmpeq',
          '!=': 'if_icmpne',
          '<': 'if_icmplt',
          '>': 'if_icmpgt',
          '<=': 'if_icmple',
          '>=': 'if_icmpge',
        }[value.operator] || null;
      }
      if (typeof left.descriptor === 'string' && (left.descriptor.startsWith('L') || left.descriptor.startsWith('['))) {
        return value.operator === '==' ? 'if_acmpeq' : 'if_acmpne';
      }
      return null;
    })();
    if (!branchOpcode) return null;
    if (left.descriptor === 'J') {
      state.instructions.push(createJvmInstruction('lcmp'));
    } else if (left.descriptor === 'F' || left.descriptor === 'D') {
      const cmp = left.descriptor === 'F'
        ? (value.operator === '>' || value.operator === '>=' ? 'fcmpl' : 'fcmpg')
        : (value.operator === '>' || value.operator === '>=' ? 'dcmpl' : 'dcmpg');
      state.instructions.push(createJvmInstruction(cmp));
    }
    const trueLabel = `Lcmp_true_${state.nextLabel++}`;
    const endLabel = `Lcmp_end_${state.nextLabel++}`;
    state.instructions.push(createJvmInstruction(branchOpcode, [trueLabel]));
    state.instructions.push(createJvmInstruction('iconst_0'));
    state.instructions.push(createJvmInstruction('goto', [endLabel]));
    state.instructions.push(createJvmInstruction('iconst_1', [], { label: trueLabel }));
    state.instructions.push(createJvmInstruction('nop', [], { label: endLabel }));
    state.maxStack = Math.max(state.maxStack, left.stack + right.stack, 1);
    return { descriptor: 'Z', stack: 1 };
  }
  if (value.kind === 'CastValue') {
    const emitted = emitValue(value.value, state);
    if (!emitted) return null;
    if (emitted.descriptor === value.type) return emitted;
    if (['B', 'S', 'C', 'Z'].includes(emitted.descriptor) && value.type === 'I') {
      return { descriptor: 'I', stack: 1 };
    }
    if (['B', 'S', 'C', 'Z'].includes(emitted.descriptor) && ['J', 'F', 'D'].includes(value.type)) {
      state.instructions.push(createJvmInstruction({ J: 'i2l', F: 'i2f', D: 'i2d' }[value.type]));
      const stack = slotWidthFromDescriptor(value.type);
      state.maxStack = Math.max(state.maxStack, emitted.stack, stack);
      return { descriptor: value.type, stack };
    }
    const opcode = {
      'I:J': 'i2l',
      'I:F': 'i2f',
      'I:D': 'i2d',
      'I:B': 'i2b',
      'I:C': 'i2c',
      'I:S': 'i2s',
      'J:I': 'l2i',
      'J:F': 'l2f',
      'J:D': 'l2d',
      'F:I': 'f2i',
      'F:J': 'f2l',
      'F:D': 'f2d',
      'D:I': 'd2i',
      'D:J': 'd2l',
      'D:F': 'd2f',
    }[`${emitted.descriptor}:${value.type}`];
    if (!opcode
        && ['J', 'F', 'D'].includes(emitted.descriptor)
        && ['B', 'S', 'C'].includes(value.type)) {
      state.instructions.push(createJvmInstruction({ J: 'l2i', F: 'f2i', D: 'd2i' }[emitted.descriptor]));
      state.instructions.push(createJvmInstruction({ B: 'i2b', S: 'i2s', C: 'i2c' }[value.type]));
      state.maxStack = Math.max(state.maxStack, emitted.stack, 1);
      return { descriptor: value.type, stack: 1 };
    }
    if (!opcode
        && (emitted.descriptor.startsWith('L') || emitted.descriptor.startsWith('['))
        && (value.type.startsWith('L') || value.type.startsWith('['))) {
      const owner = value.type.startsWith('L') ? value.type.slice(1, -1) : value.type;
      state.instructions.push(createJvmInstruction('checkcast', [owner]));
      return { descriptor: value.type, stack: 1 };
    }
    if (!opcode
        && (emitted.descriptor.startsWith('L') || emitted.descriptor.startsWith('['))
        && PRIMITIVE_WRAPPER_BY_DESCRIPTOR[value.type]) {
      const wrapper = PRIMITIVE_WRAPPER_BY_DESCRIPTOR[value.type];
      const unboxMethod = UNBOX_METHOD_BY_DESCRIPTOR[value.type];
      state.instructions.push(createJvmInstruction('checkcast', [wrapper]));
      state.instructions.push(createJvmInstruction('invokevirtual', ['Method', wrapper, unboxMethod, `()${value.type}`]));
      const stack = slotWidthFromDescriptor(value.type);
      state.maxStack = Math.max(state.maxStack, emitted.stack, stack);
      return { descriptor: value.type, stack };
    }
    if (!opcode) return null;
    state.instructions.push(createJvmInstruction(opcode));
    const stack = slotWidthFromDescriptor(value.type);
    state.maxStack = Math.max(state.maxStack, emitted.stack, stack);
    return { descriptor: value.type, stack };
  }
  if (value.kind === 'MethodCallValue') {
    let argStack = 0;
    if (value.invokeKind !== 'static') {
      const receiver = emitValue(value.receiver, state);
      if (!receiver) return null;
      argStack += receiver.stack;
    }
    for (const arg of value.args || []) {
      const emitted = emitValue(arg, state);
      if (!emitted) return null;
      argStack += emitted.stack;
    }
    const opcode = value.invokeKind === 'static'
      ? 'invokestatic'
      : (value.invokeKind === 'special' ? 'invokespecial' : (value.invokeKind === 'interface' ? 'invokeinterface' : 'invokevirtual'));
    const referenceKind = opcode === 'invokeinterface' ? 'InterfaceMethod' : 'Method';
    const fields = opcode === 'invokeinterface' ? { count: String(1 + parameterSlotCount(value.descriptor)) } : {};
    state.instructions.push(createJvmInstruction(opcode, [referenceKind, value.owner, value.name, value.descriptor], fields));
    const stack = value.type === 'V' ? 0 : slotWidthFromDescriptor(value.type);
    state.maxStack = Math.max(state.maxStack, argStack, stack);
    return { descriptor: value.type, stack };
  }
  return null;
}

function falseBranchOpcodeForCompare(value, descriptor) {
  if (descriptor === 'I' || descriptor === 'Z' || descriptor === 'B' || descriptor === 'C' || descriptor === 'S') {
    return {
      '==': 'if_icmpne',
      '!=': 'if_icmpeq',
      '<': 'if_icmpge',
      '>': 'if_icmple',
      '<=': 'if_icmpgt',
      '>=': 'if_icmplt',
    }[value.operator] || null;
  }
  if (typeof descriptor === 'string' && (descriptor.startsWith('L') || descriptor.startsWith('['))) {
    return {
      '==': 'if_acmpne',
      '!=': 'if_acmpeq',
    }[value.operator] || null;
  }
  return null;
}

function emitFalseBranch(condition, falseLabel, state) {
  if (condition && condition.kind === 'CompareValue') {
    const left = emitValue(condition.left, state);
    const right = emitValue(condition.right, state);
    if (!left || !right || left.descriptor !== right.descriptor) return false;
    if (left.descriptor === 'J') {
      const branch = {
        '==': 'ifne',
        '!=': 'ifeq',
        '<': 'ifge',
        '>': 'ifle',
        '<=': 'ifgt',
        '>=': 'iflt',
      }[condition.operator];
      if (!branch) return false;
      state.instructions.push(createJvmInstruction('lcmp'));
      state.instructions.push(createJvmInstruction(branch, [falseLabel]));
      state.maxStack = Math.max(state.maxStack, 4);
      return true;
    }
    if (left.descriptor === 'F' || left.descriptor === 'D') {
      const cmp = left.descriptor === 'F'
        ? (condition.operator === '>' || condition.operator === '>=' ? 'fcmpl' : 'fcmpg')
        : (condition.operator === '>' || condition.operator === '>=' ? 'dcmpl' : 'dcmpg');
      const branch = {
        '==': 'ifne',
        '!=': 'ifeq',
        '<': 'ifge',
        '>': 'ifle',
        '<=': 'ifgt',
        '>=': 'iflt',
      }[condition.operator];
      if (!branch) return false;
      state.instructions.push(createJvmInstruction(cmp));
      state.instructions.push(createJvmInstruction(branch, [falseLabel]));
      state.maxStack = Math.max(state.maxStack, slotWidthFromDescriptor(left.descriptor) * 2);
      return true;
    }
    const branch = falseBranchOpcodeForCompare(condition, left.descriptor);
    if (!branch) return false;
    state.instructions.push(createJvmInstruction(branch, [falseLabel]));
    state.maxStack = Math.max(state.maxStack, left.stack + right.stack);
    return true;
  }
  const emitted = emitValue(condition, state);
  if (!emitted || emitted.descriptor !== 'Z') return false;
  state.instructions.push(createJvmInstruction('ifeq', [falseLabel]));
  state.maxStack = Math.max(state.maxStack, emitted.stack);
  return true;
}


function defaultConstructorMethod(classIr) {
  const instructions = [
    createJvmInstruction('aload_0'),
    createJvmInstruction('invokespecial', ['Method', classIr.superName || 'java/lang/Object', '<init>', '()V']),
  ];
  let maxStack = 1;
  for (const field of classIr.fields || []) {
    if ((field.access || []).includes('static') || !field.initializer) continue;
    const state = { instructions: [], maxStack: 0, locals: new Map() };
    const value = emitValue(field.initializer, state);
    if (!value || value.descriptor !== field.descriptor) continue;
    instructions.push(createJvmInstruction('aload_0'));
    instructions.push(...state.instructions);
    instructions.push(createJvmInstruction('putfield', ['Field', classIr.internalName, field.name, field.descriptor]));
    maxStack = Math.max(maxStack, 1 + value.stack, 1 + state.maxStack);
  }
  instructions.push(createJvmInstruction('return'));
  return createJvmBytecodeMethod({
    kind: 'Constructor',
    name: '<init>',
    descriptor: '()V',
    access: ['public'],
    maxStack,
    maxLocals: 1,
    returnDescriptor: 'V',
    instructions,
    sourceNodeKind: 'SyntheticDefaultConstructor',
  });
}

function staticInitializerMethod(classIr) {
  const instructions = [];
  const state = {
    instructions,
    maxStack: 0,
    locals: new Map(),
    nextLabel: 0,
    exceptionTable: [],
    breakLabels: [],
    continueLabels: [],
    labeledBreakLabels: new Map(),
    labeledContinueLabels: new Map(),
    nextSyntheticSlot: 0,
    maxLocals: 0,
  };
  for (const field of classIr.fields || []) {
    if (!(field.access || []).includes('static') || !field.initializer) continue;
    const value = emitValue(field.initializer, state);
    if (!value || value.descriptor !== field.descriptor) {
      return null;
    }
    instructions.push(createJvmInstruction('putstatic', ['Field', classIr.internalName, field.name, field.descriptor]));
    state.maxStack = Math.max(state.maxStack, value.stack);
  }
  if (instructions.length === 0) return null;
  instructions.push(createJvmInstruction('return'));
  return createJvmBytecodeMethod({
    kind: 'Method',
    name: '<clinit>',
    descriptor: '()V',
    access: ['static'],
    maxStack: state.maxStack,
    maxLocals: 0,
    returnDescriptor: 'V',
    instructions,
    sourceNodeKind: 'SyntheticStaticInitializer',
  });
}

function classAttributesForIr(classIr, sourceFile) {
  const attributes = [];
  if (sourceFile) attributes.push({ type: 'SourceFile', value: sourceFile });
  if (classIr.meta && classIr.meta.signature) attributes.push({ type: 'Signature', value: classIr.meta.signature });
  if (classIr.meta && Array.isArray(classIr.meta.annotations) && classIr.meta.annotations.length) {
    attributes.push({ type: 'RuntimeVisibleAnnotations', annotations: classIr.meta.annotations });
  }
  return attributes;
}

function memberAttributesForIr(member) {
  const attributes = [];
  if (member.meta && member.meta.signature) attributes.push({ type: 'Signature', value: member.meta.signature });
  if (member.meta && Array.isArray(member.meta.annotations) && member.meta.annotations.length) {
    attributes.push({ type: 'RuntimeVisibleAnnotations', annotations: member.meta.annotations });
  }
  return attributes;
}

function lowerJavaIrMethod(method, classIr = null, options = {}) {
  const returnDescriptor = method.descriptor.slice(method.descriptor.indexOf(')') + 1);
  if ((method.access || []).includes('abstract') || (method.access || []).includes('native')) {
    return {
      method: createJvmBytecodeMethod({
        name: method.name,
        descriptor: method.descriptor,
        access: method.access || [],
        maxStack: 0,
        maxLocals: 0,
        returnDescriptor,
        instructions: [],
        sourceNodeKind: method.sourceNodeKind,
        attributes: memberAttributesForIr(method),
        meta: method.meta || {},
      }),
      unsupported: [],
    };
  }
  const instructions = [];
  const state = {
    instructions,
    maxStack: 0,
    locals: buildLocalMap(method),
    nextLabel: 0,
    exceptionTable: [],
    breakLabels: [],
    continueLabels: [],
    labeledBreakLabels: new Map(),
    labeledContinueLabels: new Map(),
    nextSyntheticSlot: maxLocalSlots(method),
    maxLocals: maxLocalSlots(method),
  };
  const unsupported = [];
  let hasExplicitReturn = false;

  function emitOp(op) {
    if (op.op === 'println' || op.op === 'print') {
      let descriptor = '()V';
      let argStack = 0;
      if ((op.args || []).length === 1) {
        const buildArgFirst = op.args[0] && op.args[0].kind === 'StringConcatValue';
        if (!buildArgFirst) {
          instructions.push(createJvmInstruction('getstatic', ['Field', 'java/lang/System', 'out', 'Ljava/io/PrintStream;']));
        }
        const value = emitValue(op.args[0], state);
        if (!value) {
          unsupported.push(`unsupported ${op.op} argument in ${method.name}`);
          return;
        }
        descriptor = `(${intCompatibleInvokeDescriptor(value.descriptor)})V`;
        argStack = value.stack;
        if (buildArgFirst) {
          instructions.push(createJvmInstruction('getstatic', ['Field', 'java/lang/System', 'out', 'Ljava/io/PrintStream;']));
          instructions.push(createJvmInstruction('swap'));
        }
      } else if ((op.args || []).length > 1) {
        unsupported.push(`${op.op} with more than one argument in ${method.name}`);
        return;
      } else {
        instructions.push(createJvmInstruction('getstatic', ['Field', 'java/lang/System', 'out', 'Ljava/io/PrintStream;']));
      }
      instructions.push(createJvmInstruction('invokevirtual', ['Method', 'java/io/PrintStream', op.op, descriptor]));
      state.maxStack = Math.max(state.maxStack, 1 + argStack);
    } else if (op.op === 'declareLocal') {
      // Declarations affect the local table carried by Java IR; no stack code is emitted.
    } else if (op.op === 'assign') {
      const local = state.locals.get(op.target);
      const value = emitValue(op.value, state);
      if (!local || !value || value.descriptor !== local.descriptor || typeof local.slotHint !== 'number') {
        unsupported.push(`unsupported assignment to ${op.target} in ${method.name}`);
        return;
      }
      instructions.push(createJvmInstruction(storeOpcodeForDescriptor(local.descriptor), [String(local.slotHint)]));
    } else if (op.op === 'arrayStore') {
      const args = op.args || [];
      const array = emitValue(args[0], state);
      const index = emitValue(args[1], state);
      const value = emitValue(op.value, state);
      if (!array || !index || !value || !array.descriptor.startsWith('[') || index.descriptor !== 'I' || value.descriptor !== op.type) {
        unsupported.push(`unsupported array store in ${method.name}`);
        return;
      }
      instructions.push(createJvmInstruction(arrayStoreOpcodeForDescriptor(op.type)));
      state.maxStack = Math.max(state.maxStack, 2 + value.stack);
    } else if (op.op === 'putField') {
      const receiver = emitValue((op.args || [])[0], state);
      const value = emitValue(op.value, state);
      if (!receiver || !value || value.descriptor !== op.descriptor) {
        unsupported.push(`unsupported field store in ${method.name}`);
        return;
      }
      instructions.push(createJvmInstruction('putfield', ['Field', op.owner, op.name, op.descriptor]));
      state.maxStack = Math.max(state.maxStack, receiver.stack + value.stack);
    } else if (op.op === 'putStaticField') {
      const value = emitValue(op.value, state);
      if (!value || value.descriptor !== op.descriptor) {
        unsupported.push(`unsupported static field store in ${method.name}`);
        return;
      }
      instructions.push(createJvmInstruction('putstatic', ['Field', op.owner, op.name, op.descriptor]));
      state.maxStack = Math.max(state.maxStack, value.stack);
    } else if (op.op === 'invoke') {
      const value = emitValue(op.value, state);
      if (!value) {
        unsupported.push(`unsupported expression invocation in ${method.name}`);
        return;
      }
      if (value.descriptor !== 'V') {
        instructions.push(createJvmInstruction(value.stack === 2 ? 'pop2' : 'pop'));
      }
    } else if (op.op === 'if') {
      const elseLabel = `Lif_else_${state.nextLabel++}`;
      const endLabel = `Lif_end_${state.nextLabel++}`;
      if (!emitFalseBranch(op.condition, elseLabel, state)) {
        unsupported.push(`unsupported if condition in ${method.name}`);
        return;
      }
      for (const child of op.thenOps || []) emitOp(child);
      if ((op.elseOps || []).length > 0) {
        instructions.push(createJvmInstruction('goto', [endLabel]));
        instructions.push(createJvmInstruction('nop', [], { label: elseLabel }));
        for (const child of op.elseOps || []) emitOp(child);
        instructions.push(createJvmInstruction('nop', [], { label: endLabel }));
      } else {
        instructions.push(createJvmInstruction('nop', [], { label: elseLabel }));
      }
    } else if (op.op === 'loop') {
      const startLabel = `Lloop_start_${state.nextLabel++}`;
      const continueLabel = `Lloop_continue_${state.nextLabel++}`;
      const endLabel = `Lloop_end_${state.nextLabel++}`;
      instructions.push(createJvmInstruction('nop', [], { label: startLabel }));
      if (!emitFalseBranch(op.condition, endLabel, state)) {
        unsupported.push(`unsupported loop condition in ${method.name}`);
        return;
      }
      const previousBreakLabel = op.label ? state.labeledBreakLabels.get(op.label) : undefined;
      const previousContinueLabel = op.label ? state.labeledContinueLabels.get(op.label) : undefined;
      if (op.label) {
        state.labeledBreakLabels.set(op.label, endLabel);
        state.labeledContinueLabels.set(op.label, continueLabel);
      }
      state.breakLabels.push(endLabel);
      state.continueLabels.push(continueLabel);
      for (const child of op.bodyOps || []) emitOp(child);
      instructions.push(createJvmInstruction('nop', [], { label: continueLabel }));
      for (const child of op.updateOps || []) emitOp(child);
      state.continueLabels.pop();
      state.breakLabels.pop();
      if (op.label) {
        if (previousBreakLabel === undefined) state.labeledBreakLabels.delete(op.label);
        else state.labeledBreakLabels.set(op.label, previousBreakLabel);
        if (previousContinueLabel === undefined) state.labeledContinueLabels.delete(op.label);
        else state.labeledContinueLabels.set(op.label, previousContinueLabel);
      }
      instructions.push(createJvmInstruction('goto', [startLabel]));
      instructions.push(createJvmInstruction('nop', [], { label: endLabel }));
    } else if (op.op === 'doLoop') {
      const startLabel = `Ldo_loop_start_${state.nextLabel++}`;
      const continueLabel = `Ldo_loop_continue_${state.nextLabel++}`;
      const endLabel = `Ldo_loop_end_${state.nextLabel++}`;
      instructions.push(createJvmInstruction('nop', [], { label: startLabel }));
      const previousBreakLabel = op.label ? state.labeledBreakLabels.get(op.label) : undefined;
      const previousContinueLabel = op.label ? state.labeledContinueLabels.get(op.label) : undefined;
      if (op.label) {
        state.labeledBreakLabels.set(op.label, endLabel);
        state.labeledContinueLabels.set(op.label, continueLabel);
      }
      state.breakLabels.push(endLabel);
      state.continueLabels.push(continueLabel);
      for (const child of op.bodyOps || []) emitOp(child);
      instructions.push(createJvmInstruction('nop', [], { label: continueLabel }));
      state.continueLabels.pop();
      state.breakLabels.pop();
      if (op.label) {
        if (previousBreakLabel === undefined) state.labeledBreakLabels.delete(op.label);
        else state.labeledBreakLabels.set(op.label, previousBreakLabel);
        if (previousContinueLabel === undefined) state.labeledContinueLabels.delete(op.label);
        else state.labeledContinueLabels.set(op.label, previousContinueLabel);
      }
      if (!emitFalseBranch(op.condition, endLabel, state)) {
        unsupported.push(`unsupported do loop condition in ${method.name}`);
        return;
      }
      instructions.push(createJvmInstruction('goto', [startLabel]));
      instructions.push(createJvmInstruction('nop', [], { label: endLabel }));
    } else if (op.op === 'switch') {
      const endLabel = `Lswitch_end_${state.nextLabel++}`;
      const defaultGroup = (op.groups || []).find((group) => group.isDefault);
      const groupLabels = (op.groups || []).map(() => `Lswitch_case_${state.nextLabel++}`);
      const defaultLabel = defaultGroup ? groupLabels[(op.groups || []).indexOf(defaultGroup)] : endLabel;
      for (let groupIndex = 0; groupIndex < (op.groups || []).length; groupIndex += 1) {
        const group = op.groups[groupIndex];
        for (const caseValue of group.caseValues || []) {
          const emittedSwitchValue = emitValue(op.value, state);
          const emittedCaseValue = emitValue(caseValue, state);
          if (!emittedSwitchValue || !emittedCaseValue || emittedSwitchValue.descriptor !== 'I' || emittedCaseValue.descriptor !== 'I') {
            unsupported.push(`unsupported switch case in ${method.name}`);
            return;
          }
          instructions.push(createJvmInstruction('if_icmpeq', [groupLabels[groupIndex]]));
          state.maxStack = Math.max(state.maxStack, 2);
        }
      }
      instructions.push(createJvmInstruction('goto', [defaultLabel]));
      state.breakLabels.push(endLabel);
      for (let groupIndex = 0; groupIndex < (op.groups || []).length; groupIndex += 1) {
        instructions.push(createJvmInstruction('nop', [], { label: groupLabels[groupIndex] }));
        for (const child of op.groups[groupIndex].bodyOps || []) emitOp(child);
      }
      state.breakLabels.pop();
      instructions.push(createJvmInstruction('nop', [], { label: endLabel }));
    } else if (op.op === 'break') {
      const label = op.label ? state.labeledBreakLabels.get(op.label) : state.breakLabels[state.breakLabels.length - 1];
      if (!label) {
        unsupported.push(`unsupported break in ${method.name}`);
        return;
      }
      instructions.push(createJvmInstruction('goto', [label]));
    } else if (op.op === 'continue') {
      const label = op.label ? state.labeledContinueLabels.get(op.label) : state.continueLabels[state.continueLabels.length - 1];
      if (!label) {
        unsupported.push(`unsupported continue in ${method.name}`);
        return;
      }
      instructions.push(createJvmInstruction('goto', [label]));
    } else if (op.op === 'tryCatch') {
      const tryStart = `Ltry_start_${state.nextLabel++}`;
      const tryEnd = `Ltry_end_${state.nextLabel++}`;
      const endLabel = `Ltry_done_${state.nextLabel++}`;
      const finallyOps = op.finallyOps || [];
      const hasFinally = finallyOps.length > 0;
      const finallyHandler = hasFinally ? `Lfinally_${state.nextLabel++}` : null;
      const finallyLocalSlot = hasFinally ? state.nextSyntheticSlot++ : null;
      if (hasFinally) state.maxLocals = Math.max(state.maxLocals, state.nextSyntheticSlot);
      instructions.push(createJvmInstruction('nop', [], { label: tryStart }));
      for (const child of op.tryOps || []) emitOp(child);
      instructions.push(createJvmInstruction('nop', [], { label: tryEnd }));
      if (hasFinally) {
        for (const child of finallyOps) emitOp(child);
      }
      instructions.push(createJvmInstruction('goto', [endLabel]));
      for (const catchClause of op.catches || []) {
        state.exceptionTable.push({
          startLabel: tryStart,
          endLabel: tryEnd,
          handlerLabel: catchClause.handlerLabel || `Lcatch_pending_${state.nextLabel}`,
          catchType: catchClause.type || 'java/lang/Throwable',
        });
      }
      if (hasFinally) {
        state.exceptionTable.push({
          startLabel: tryStart,
          endLabel: tryEnd,
          handlerLabel: finallyHandler,
          catchType: 'any',
        });
      }
      for (const catchClause of op.catches || []) {
        const handlerLabel = `Lcatch_${state.nextLabel++}`;
        const catchEnd = `Lcatch_end_${state.nextLabel++}`;
        const pending = state.exceptionTable.find((entry) => entry.handlerLabel && entry.handlerLabel.startsWith('Lcatch_pending_'));
        if (pending) pending.handlerLabel = handlerLabel;
        const local = state.locals.get(catchClause.local);
        if (!local || local.descriptor !== catchClause.descriptor || typeof local.slotHint !== 'number') {
          unsupported.push(`unsupported catch local in ${method.name}`);
          return;
        }
        instructions.push(createJvmInstruction(storeOpcodeForDescriptor(local.descriptor), [String(local.slotHint)], { label: handlerLabel }));
        state.maxStack = Math.max(state.maxStack, 1);
        for (const child of catchClause.bodyOps || []) emitOp(child);
        instructions.push(createJvmInstruction('nop', [], { label: catchEnd }));
        if (hasFinally) {
          state.exceptionTable.push({
            startLabel: handlerLabel,
            endLabel: catchEnd,
            handlerLabel: finallyHandler,
            catchType: 'any',
          });
          for (const child of finallyOps) emitOp(child);
        }
        instructions.push(createJvmInstruction('goto', [endLabel]));
      }
      if (hasFinally) {
        instructions.push(createJvmInstruction('astore', [String(finallyLocalSlot)], { label: finallyHandler }));
        state.maxStack = Math.max(state.maxStack, 1);
        for (const child of finallyOps) emitOp(child);
        instructions.push(createJvmInstruction('aload', [String(finallyLocalSlot)]));
        instructions.push(createJvmInstruction('athrow'));
      }
      instructions.push(createJvmInstruction('nop', [], { label: endLabel }));
    } else if (op.op === 'synchronized') {
      const lockSlot = state.nextSyntheticSlot++;
      state.maxLocals = Math.max(state.maxLocals, state.nextSyntheticSlot);
      const lock = emitValue(op.value, state);
      if (!lock || !(lock.descriptor.startsWith('L') || lock.descriptor.startsWith('['))) {
        unsupported.push(`unsupported synchronized lock in ${method.name}`);
        return;
      }
      instructions.push(createJvmInstruction('dup'));
      instructions.push(createJvmInstruction('astore', [String(lockSlot)]));
      instructions.push(createJvmInstruction('monitorenter'));
      for (const child of op.bodyOps || []) emitOp(child);
      instructions.push(createJvmInstruction('aload', [String(lockSlot)]));
      instructions.push(createJvmInstruction('monitorexit'));
      state.maxStack = Math.max(state.maxStack, lock.stack + 1);
    } else if (op.op === 'return') {
      if (returnDescriptor === 'V' && !op.value) {
        instructions.push(createJvmInstruction('return'));
        hasExplicitReturn = true;
        return;
      }
      const value = emitValue(op.value, state);
      if (!value || value.descriptor !== returnDescriptor) {
        unsupported.push(`non-void return in ${method.name}`);
        return;
      }
      instructions.push(createJvmInstruction(returnOpcodeForDescriptor(returnDescriptor)));
      hasExplicitReturn = true;
    } else if (op.op === 'throw') {
      const value = emitValue(op.value, state);
      if (!value || typeof value.descriptor !== 'string' || !value.descriptor.startsWith('L')) {
        unsupported.push(`unsupported throw in ${method.name}`);
        return;
      }
      instructions.push(createJvmInstruction('athrow'));
      state.maxStack = Math.max(state.maxStack, value.stack);
    } else {
      unsupported.push(`unsupported Java IR op ${op.op} in ${method.name}`);
    }
  }

  for (const block of method.blocks || []) {
    for (const op of block.ops || []) {
      emitOp(op);
    }
    if (block.terminator && block.terminator.kind === 'Return' && returnDescriptor === 'V') {
      const last = instructions[instructions.length - 1];
      if (!last || last.opcode !== 'return') {
        instructions.push(createJvmInstruction('return'));
      }
    }
  }

  if (returnDescriptor === 'V') {
    const last = instructions[instructions.length - 1];
    if (!last || last.opcode !== 'return') {
      instructions.push(createJvmInstruction('return'));
    }
  } else if (!hasExplicitReturn) {
    unsupported.push(`non-void method ${method.name}`);
  }

  let finalInstructions = instructions;
  let finalExceptionTable = state.exceptionTable;
  let finalMaxStack = state.maxStack;
  let finalMeta = method.meta || {};
  if (unsupported.length) {
    finalInstructions = [createJvmInstruction('unsupported', [unsupported[0]])];
    finalExceptionTable = [];
  }

  return {
    method: createJvmBytecodeMethod({
      name: method.name,
      descriptor: method.descriptor,
      access: method.access || [],
      maxStack: finalMaxStack,
      maxLocals: state.maxLocals,
      returnDescriptor,
      instructions: finalInstructions,
      exceptionTable: finalExceptionTable,
      sourceNodeKind: method.sourceNodeKind,
      attributes: memberAttributesForIr(method),
      meta: finalMeta,
    }),
    unsupported,
  };
}

function isJvmBytecodeIrDocument(document) {
  return isPlainObject(document)
    && document.schema === JVM_BYTECODE_IR_SCHEMA_ID
    && document.version === JVM_BYTECODE_IR_SCHEMA_VERSION;
}

function validateJvmBytecodeIrDocument(document) {
  if (!isJvmBytecodeIrDocument(document)) {
    throw new TypeError(`JVM bytecode IR document schema must be ${JVM_BYTECODE_IR_SCHEMA_ID} version ${JVM_BYTECODE_IR_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(document.classes)) {
    throw new TypeError('JVM bytecode IR classes must be an array');
  }
  for (const [classIndex, classIr] of document.classes.entries()) {
    if (typeof classIr.internalName !== 'string' || classIr.internalName.length === 0) {
      throw new TypeError(`classes[${classIndex}].internalName must be a non-empty string`);
    }
    if (!Array.isArray(classIr.methods)) {
      throw new TypeError(`classes[${classIndex}].methods must be an array`);
    }
    for (const [methodIndex, method] of classIr.methods.entries()) {
      if (typeof method.name !== 'string' || method.name.length === 0) {
        throw new TypeError(`classes[${classIndex}].methods[${methodIndex}].name must be a non-empty string`);
      }
      if (typeof method.descriptor !== 'string' || method.descriptor.length === 0) {
        throw new TypeError(`classes[${classIndex}].methods[${methodIndex}].descriptor must be a non-empty string`);
      }
      if (!Array.isArray(method.instructions)) {
        throw new TypeError(`classes[${classIndex}].methods[${methodIndex}].instructions must be an array`);
      }
    }
  }
  assertJsonValue(document);
  return document;
}

function toJvmBytecodeIrJson(document, options = {}) {
  if (options.validate !== false) validateJvmBytecodeIrDocument(document);
  return stableJsonValue(document);
}

function serializeJvmBytecodeIr(document, options = {}) {
  const space = Object.prototype.hasOwnProperty.call(options, 'space') ? options.space : 2;
  return JSON.stringify(toJvmBytecodeIrJson(document, options), null, space);
}

function deserializeJvmBytecodeIr(serialized, options = {}) {
  const value = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  if (options.validate !== false) validateJvmBytecodeIrDocument(value);
  return value;
}

function cloneJvmBytecodeIr(document, options = {}) {
  return deserializeJvmBytecodeIr(serializeJvmBytecodeIr(document, options), options);
}

function attachJvmBytecodeIrDocument(astDocument, irDocument, options = {}) {
  if (options.validate !== false) validateJvmBytecodeIrDocument(irDocument);
  if (!isPlainObject(astDocument.meta)) astDocument.meta = {};
  astDocument.meta[JVM_BYTECODE_IR_AST_META_KEY] = cloneJsonValue(irDocument);
  return astDocument;
}

function getAttachedJvmBytecodeIrDocument(astDocument) {
  const ir = astDocument && astDocument.meta && astDocument.meta[JVM_BYTECODE_IR_AST_META_KEY];
  return ir ? cloneJvmBytecodeIr(ir) : null;
}

function detachJvmBytecodeIrDocument(astDocument) {
  if (astDocument && astDocument.meta) {
    delete astDocument.meta[JVM_BYTECODE_IR_AST_META_KEY];
  }
  return astDocument;
}

function javaIrToJvmBytecodeIr(javaIr, options = {}) {
  validateJavaIrDocument(javaIr);
  const unsupported = (javaIr.unsupported || []).slice();
  const classes = (javaIr.classes || []).map((classIr) => {
    const methods = [];
    let hasConstructor = false;
    for (const method of classIr.methods || []) {
      if (method.name === '<init>') hasConstructor = true;
      const lowered = lowerJavaIrMethod(method, classIr, options);
      unsupported.push(...lowered.unsupported.map((reason) => ({ owner: classIr.name, method: method.name, reason })));
      methods.push(lowered.method);
    }
    const bytecodeClass = createJvmBytecodeClass({
      name: classIr.name,
      packageName: classIr.packageName,
      internalName: classIr.internalName,
      sourceFile: options.sourceFileName || `${classIr.name}.java`,
      access: classIr.access || [],
      attributes: classAttributesForIr(classIr, options.sourceFileName || `${classIr.name}.java`),
      superName: classIr.superName || 'java/lang/Object',
      interfaces: classIr.interfaces || [],
      fields: classIr.fields || [],
      methods,
    });
    if (!hasConstructor && !(bytecodeClass.access || []).includes('interface')) {
      bytecodeClass.methods.unshift(defaultConstructorMethod(bytecodeClass));
    }
    const clinit = methods.some((method) => method.name === '<clinit>') ? null : staticInitializerMethod(bytecodeClass);
    if (clinit) bytecodeClass.methods.push(clinit);
    return bytecodeClass;
  });
  return createJvmBytecodeIrDocument(classes, {
    sourceLevel: javaIr.sourceLevel,
    status: unsupported.length ? 'partial' : 'complete',
    unsupported,
  });
}

function createEmitJvmBytecodeIrPass(options = {}) {
  return {
    name: options.name || 'frontend.emitBytecodeIr',
    phase: 'bytecode',
    description: 'Emit serializable JVM stack bytecode IR from Java IR when available, falling back to the current AST compiler.',
    dependsOn: options.dependsOn || [],
    run(document, context) {
      let bytecodeIr;
      const javaIr = getAttachedJavaIrDocument(document);
      if (javaIr && options.fromJavaIr !== false) {
        bytecodeIr = javaIrToJvmBytecodeIr(javaIr, options);
      } else {
        validateAstDocument(document);
        bytecodeIr = buildBytecodeIr(document, options);
      }
      attachJvmBytecodeIrDocument(document, bytecodeIr, options.attach || {});
      if (context && typeof context.annotate === 'function') {
        context.annotate(document.root, 'frontend.bytecodeIr.backend', {
          backend: bytecodeIr.backend,
          status: bytecodeIr.status,
          classes: bytecodeIr.classes.length,
        });
      }
      return document;
    },
  };
}

module.exports = {
  JVM_BYTECODE_IR_SCHEMA_ID,
  JVM_BYTECODE_IR_SCHEMA_VERSION,
  JVM_BYTECODE_IR_AST_META_KEY,
  createJvmBytecodeIrDocument,
  createJvmBytecodeClass,
  createJvmBytecodeMethod,
  createJvmInstruction,
  isJvmBytecodeIrDocument,
  validateJvmBytecodeIrDocument,
  toJvmBytecodeIrJson,
  serializeJvmBytecodeIr,
  deserializeJvmBytecodeIr,
  cloneJvmBytecodeIr,
  attachJvmBytecodeIrDocument,
  getAttachedJvmBytecodeIrDocument,
  detachJvmBytecodeIrDocument,
  javaIrToJvmBytecodeIr,
  createEmitJvmBytecodeIrPass,
};
