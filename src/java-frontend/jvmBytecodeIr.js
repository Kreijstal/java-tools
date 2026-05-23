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
    maxStack: fields.maxStack || 0,
    maxLocals: fields.maxLocals || 0,
    returnDescriptor: fields.returnDescriptor || (fields.descriptor ? fields.descriptor.slice(fields.descriptor.indexOf(')') + 1) : 'V'),
    instructions: fields.instructions || [],
    sourceNodeKind: fields.sourceNodeKind || null,
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
  return String(raw).replace(/_/g, '').replace(/[lLfFdD]$/, '');
}

function longPushInstruction(value) {
  const parsed = BigInt(stripNumericSuffix(value));
  if (parsed === 0n) return createJvmInstruction('lconst_0');
  if (parsed === 1n) return createJvmInstruction('lconst_1');
  return createJvmInstruction('ldc2_w', [`${parsed.toString()}L`]);
}

function floatPushInstruction(value) {
  const parsed = Number.parseFloat(stripNumericSuffix(value));
  if (Object.is(parsed, 0)) return createJvmInstruction('fconst_0');
  if (parsed === 1) return createJvmInstruction('fconst_1');
  if (parsed === 2) return createJvmInstruction('fconst_2');
  return createJvmInstruction('ldc', [`${stripNumericSuffix(value)}f`]);
}

function doublePushInstruction(value) {
  const parsed = Number.parseFloat(stripNumericSuffix(value));
  if (Object.is(parsed, 0)) return createJvmInstruction('dconst_0');
  if (parsed === 1) return createJvmInstruction('dconst_1');
  return createJvmInstruction('ldc2_w', [stripNumericSuffix(value)]);
}

function intCompatibleInvokeDescriptor(descriptor) {
  return descriptor === 'B' || descriptor === 'S' ? 'I' : descriptor;
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
    const parsed = Number.parseInt(stripNumericSuffix(value.value), 10);
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
  if (value.kind === 'BinaryValue') {
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
  if (value.kind === 'CastValue') {
    const emitted = emitValue(value.value, state);
    if (!emitted) return null;
    if (emitted.descriptor === value.type) return emitted;
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
    if (!opcode && emitted.descriptor.startsWith('L') && value.type.startsWith('L')) {
      const owner = value.type.slice(1, -1);
      state.instructions.push(createJvmInstruction('checkcast', [owner]));
      return { descriptor: value.type, stack: 1 };
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
    const opcode = value.invokeKind === 'static' ? 'invokestatic' : 'invokevirtual';
    state.instructions.push(createJvmInstruction(opcode, ['Method', value.owner, value.name, value.descriptor]));
    const stack = value.type === 'V' ? 0 : slotWidthFromDescriptor(value.type);
    state.maxStack = Math.max(state.maxStack, argStack, stack);
    return { descriptor: value.type, stack };
  }
  return null;
}

function defaultConstructorMethod(classIr) {
  const instructions = [
    createJvmInstruction('aload_0'),
    createJvmInstruction('invokespecial', ['Method', classIr.superName || 'java/lang/Object', '<init>', '()V']),
  ];
  let maxStack = 1;
  for (const field of classIr.fields || []) {
    if (!field.initializer || field.initializer.kind !== 'LiteralValue') continue;
    const state = { instructions: [], maxStack: 0, locals: new Map() };
    const literal = emitValue(field.initializer, state);
    if (!literal || literal.descriptor !== field.descriptor) continue;
    instructions.push(createJvmInstruction('aload_0'));
    instructions.push(...state.instructions);
    instructions.push(createJvmInstruction('putfield', ['Field', classIr.internalName, field.name, field.descriptor]));
    maxStack = Math.max(maxStack, 1 + literal.stack);
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

function lowerJavaIrMethod(method) {
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
      }),
      unsupported: [],
    };
  }
  const instructions = [];
  const state = {
    instructions,
    maxStack: 0,
    locals: buildLocalMap(method),
  };
  const unsupported = [];
  let hasExplicitReturn = false;

  for (const block of method.blocks || []) {
    for (const op of block.ops || []) {
      if (op.op === 'println' || op.op === 'print') {
        instructions.push(createJvmInstruction('getstatic', ['Field', 'java/lang/System', 'out', 'Ljava/io/PrintStream;']));
        let descriptor = '()V';
        let argStack = 0;
        if ((op.args || []).length === 1) {
          const value = emitValue(op.args[0], state);
          if (!value) {
            unsupported.push(`unsupported ${op.op} argument in ${method.name}`);
            continue;
          }
          descriptor = `(${intCompatibleInvokeDescriptor(value.descriptor)})V`;
          argStack = value.stack;
        } else if ((op.args || []).length > 1) {
          unsupported.push(`${op.op} with more than one argument in ${method.name}`);
          continue;
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
          continue;
        }
        instructions.push(createJvmInstruction(storeOpcodeForDescriptor(local.descriptor), [String(local.slotHint)]));
      } else if (op.op === 'arrayStore') {
        const args = op.args || [];
        const array = emitValue(args[0], state);
        const index = emitValue(args[1], state);
        const value = emitValue(op.value, state);
        if (!array || !index || !value || !array.descriptor.startsWith('[') || index.descriptor !== 'I' || value.descriptor !== op.type) {
          unsupported.push(`unsupported array store in ${method.name}`);
          continue;
        }
        instructions.push(createJvmInstruction(arrayStoreOpcodeForDescriptor(op.type)));
        state.maxStack = Math.max(state.maxStack, 2 + value.stack);
      } else if (op.op === 'putField') {
        const receiver = emitValue((op.args || [])[0], state);
        const value = emitValue(op.value, state);
        if (!receiver || !value || value.descriptor !== op.descriptor) {
          unsupported.push(`unsupported field store in ${method.name}`);
          continue;
        }
        instructions.push(createJvmInstruction('putfield', ['Field', op.owner, op.name, op.descriptor]));
        state.maxStack = Math.max(state.maxStack, receiver.stack + value.stack);
      } else if (op.op === 'invoke') {
        const value = emitValue(op.value, state);
        if (!value || value.descriptor !== 'V') {
          unsupported.push(`unsupported expression invocation in ${method.name}`);
          continue;
        }
      } else if (op.op === 'return') {
        if (returnDescriptor === 'V' && !op.value) {
          instructions.push(createJvmInstruction('return'));
          hasExplicitReturn = true;
          continue;
        }
        const value = emitValue(op.value, state);
        if (!value || value.descriptor !== returnDescriptor) {
          unsupported.push(`non-void return in ${method.name}`);
          continue;
        }
        instructions.push(createJvmInstruction(returnOpcodeForDescriptor(returnDescriptor)));
        hasExplicitReturn = true;
      } else {
        unsupported.push(`unsupported Java IR op ${op.op} in ${method.name}`);
      }
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

  return {
    method: createJvmBytecodeMethod({
      name: method.name,
      descriptor: method.descriptor,
      access: method.access || [],
      maxStack: state.maxStack,
      maxLocals: maxLocalSlots(method),
      returnDescriptor,
      instructions: unsupported.length ? [createJvmInstruction('unsupported', [unsupported[0]])] : instructions,
      sourceNodeKind: method.sourceNodeKind,
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
      const lowered = lowerJavaIrMethod(method);
      unsupported.push(...lowered.unsupported.map((reason) => ({ owner: classIr.name, method: method.name, reason })));
      methods.push(lowered.method);
    }
    const bytecodeClass = createJvmBytecodeClass({
      name: classIr.name,
      packageName: classIr.packageName,
      internalName: classIr.internalName,
      sourceFile: options.sourceFileName || `${classIr.name}.java`,
      access: classIr.access || [],
      superName: classIr.superName || 'java/lang/Object',
      interfaces: classIr.interfaces || [],
      fields: classIr.fields || [],
      methods,
    });
    if (!hasConstructor && !(bytecodeClass.access || []).includes('interface')) {
      bytecodeClass.methods.unshift(defaultConstructorMethod(bytecodeClass));
    }
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
        bytecodeIr = buildBytecodeIr(document, { ...options, tolerant: options.tolerant !== false });
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
