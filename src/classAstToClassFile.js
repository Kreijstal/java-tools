const fs = require('fs');
const path = require('path');
const { computeAccessFlags } = require('./access_flags');
const opcodeNames = require('jvm_parser/opcodeNames');

const METHOD_HANDLE_KIND_CODES = {
  getField: 1,
  getStatic: 2,
  putField: 3,
  putStatic: 4,
  invokeVirtual: 5,
  invokeStatic: 6,
  invokeSpecial: 7,
  newInvokeSpecial: 8,
  invokeInterface: 9,
};

const NEW_ARRAY_TYPE_CODES = {
  boolean: 4,
  char: 5,
  float: 6,
  double: 7,
  byte: 8,
  short: 9,
  int: 10,
  long: 11,
};

const MNEMONIC_TO_OPCODE = Object.entries(opcodeNames).reduce((map, [code, name]) => {
  map[name] = Number(code);
  return map;
}, {});

const BRANCH_16_OPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne', 'ifnull', 'ifnonnull', 'goto', 'jsr',
]);

const BRANCH_32_OPS = new Set(['goto_w', 'jsr_w']);

const LOCAL_INDEX_OPS = new Set([
  'iload', 'lload', 'fload', 'dload', 'aload',
  'istore', 'lstore', 'fstore', 'dstore', 'astore', 'ret',
]);

const ATTRIBUTE_NAMES = {
  Code: 'Code',
  Exceptions: 'Exceptions',
  LineNumberTable: 'LineNumberTable',
  SourceFile: 'SourceFile',
  BootstrapMethods: 'BootstrapMethods',
};

function parseSpecialFloatString(raw) {
  const match = /^([+-]?)(Infinity|NaN)(?:<0x([0-9a-fA-F]{8})>)?(?:[fF])?$/.exec(raw.trim());
  if (!match) {
    return null;
  }

  const [, signPart, literal, payload] = match;
  if (literal.toLowerCase() === 'nan' && payload) {
    const bits = Number.parseInt(payload, 16) >>> 0;
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32BE(bits);
    return { value: buffer.readFloatBE(), bits };
  }

  const sign = signPart === '-' ? -1 : 1;
  const numericValue = literal.toLowerCase() === 'nan' ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeFloatBE(numericValue);
  const bits = buffer.readUInt32BE();
  return { value: numericValue, bits };
}

function parseSpecialDoubleString(raw) {
  const match = /^([+-]?)(Infinity|NaN)(?:<0x([0-9a-fA-F]{16})>)?(?:[dD])?$/.exec(raw.trim());
  if (!match) {
    return null;
  }

  const [, signPart, literal, payload] = match;
  if (literal.toLowerCase() === 'nan' && payload) {
    const bits = BigInt('0x' + payload);
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeBigUInt64BE(bits);
    return { value: buffer.readDoubleBE(), bits };
  }

  const sign = signPart === '-' ? -1 : 1;
  const numericValue = literal.toLowerCase() === 'nan' ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeDoubleBE(numericValue);
  const bits = buffer.readBigUInt64BE();
  return { value: numericValue, bits };
}

function normalizeFloatConstant(input) {
  if (typeof input === 'object' && input !== null && 'numericValue' in input && 'bits' in input) {
    return input;
  }

  if (typeof input === 'string') {
    const parsed = parseSpecialFloatString(input);
    if (parsed) {
      return { numericValue: parsed.value, bits: parsed.bits };
    }
  }

  const numericValue = typeof input === 'number' ? input : Number(input);
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeFloatBE(numericValue);
  const bits = buffer.readUInt32BE();
  return { numericValue, bits };
}

function normalizeDoubleConstant(input) {
  if (typeof input === 'object' && input !== null && 'numericValue' in input && 'bits' in input) {
    return input;
  }

  if (typeof input === 'string') {
    const parsed = parseSpecialDoubleString(input);
    if (parsed) {
      return { numericValue: parsed.value, bits: parsed.bits };
    }
  }

  const numericValue = typeof input === 'number' ? input : Number(input);
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeDoubleBE(numericValue);
  const bits = buffer.readBigUInt64BE();
  return { numericValue, bits };
}

function normalizeClassName(name) {
  if (!name) {
    return name;
  }
  return String(name).replace(/\./g, '/');
}

function parseStringLiteral(raw) {
  if (typeof raw !== 'string') {
    return raw;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      return trimmed.slice(1, -1);
    }
  }
  return raw;
}

function parseInteger(value, defaultValue = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value | 0;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return defaultValue;
}

function parseBigInt(value) {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string') {
    return BigInt(value);
  }
  throw new Error(`Unable to parse BigInt value from ${value}`);
}

function ensureArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function extractLabel(labelDef) {
  if (typeof labelDef !== 'string') {
    return null;
  }
  const trimmed = labelDef.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.endsWith(':') ? trimmed.slice(0, -1) : trimmed;
}

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  writeUint8(value) {
    const buffer = Buffer.allocUnsafe(1);
    buffer.writeUInt8(value & 0xff, 0);
    this._push(buffer);
  }

  writeInt8(value) {
    const buffer = Buffer.allocUnsafe(1);
    buffer.writeInt8(value, 0);
    this._push(buffer);
  }

  writeUint16(value) {
    const buffer = Buffer.allocUnsafe(2);
    buffer.writeUInt16BE(value & 0xffff, 0);
    this._push(buffer);
  }

  writeInt16(value) {
    const buffer = Buffer.allocUnsafe(2);
    buffer.writeInt16BE(value, 0);
    this._push(buffer);
  }

  writeUint32(value) {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    this._push(buffer);
  }

  writeInt32(value) {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeInt32BE(value, 0);
    this._push(buffer);
  }

  writeFloat(value) {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeFloatBE(value, 0);
    this._push(buffer);
  }

  writeDouble(value) {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleBE(value, 0);
    this._push(buffer);
  }

  writeBytes(buffer) {
    if (!buffer || buffer.length === 0) {
      return;
    }
    this._push(Buffer.from(buffer));
  }

  _push(buffer) {
    this.chunks.push(buffer);
    this.length += buffer.length;
  }

  toBuffer() {
    return Buffer.concat(this.chunks, this.length);
  }
}

class ConstantPoolBuilder {
  constructor() {
    this.entries = [null];
    this.utf8Map = new Map();
    this.classMap = new Map();
    this.stringMap = new Map();
    this.integerMap = new Map();
    this.floatMap = new Map();
    this.longMap = new Map();
    this.doubleMap = new Map();
    this.nameAndTypeMap = new Map();
    this.fieldRefMap = new Map();
    this.methodRefMap = new Map();
    this.interfaceMethodRefMap = new Map();
    this.methodHandleMap = new Map();
    this.methodTypeMap = new Map();
    this.invokeDynamicMap = new Map();
  }

  _pushEntry(entry) {
    this.entries.push(entry);
    return this.entries.length - 1;
  }

  addUtf8(value = '') {
    const stringValue = value === null || value === undefined ? '' : String(value);
    if (this.utf8Map.has(stringValue)) {
      return this.utf8Map.get(stringValue);
    }
    const entry = {
      tag: 1,
      value: stringValue,
    };
    const index = this._pushEntry(entry);
    this.utf8Map.set(stringValue, index);
    return index;
  }

  addClass(name) {
    const normalized = normalizeClassName(name || '');
    if (this.classMap.has(normalized)) {
      return this.classMap.get(normalized);
    }
    const nameIndex = this.addUtf8(normalized);
    const entry = {
      tag: 7,
      nameIndex,
    };
    const index = this._pushEntry(entry);
    this.classMap.set(normalized, index);
    return index;
  }

  addString(value) {
    const stringValue = value === null || value === undefined ? '' : String(value);
    if (this.stringMap.has(stringValue)) {
      return this.stringMap.get(stringValue);
    }
    const utf8Index = this.addUtf8(stringValue);
    const entry = {
      tag: 8,
      stringIndex: utf8Index,
    };
    const index = this._pushEntry(entry);
    this.stringMap.set(stringValue, index);
    return index;
  }

  addInteger(value) {
    const intValue = parseInteger(value, 0);
    if (this.integerMap.has(intValue)) {
      return this.integerMap.get(intValue);
    }
    const entry = {
      tag: 3,
      value: intValue | 0,
    };
    const index = this._pushEntry(entry);
    this.integerMap.set(intValue, index);
    return index;
  }

  addFloat(value) {
    const { numericValue, bits } = normalizeFloatConstant(value);
    const key = bits.toString(16);
    if (this.floatMap.has(key)) {
      return this.floatMap.get(key);
    }
    const entry = {
      tag: 4,
      value: numericValue,
      bits,
    };
    const index = this._pushEntry(entry);
    this.floatMap.set(key, index);
    return index;
  }

  addLong(value) {
    const longValue = parseBigInt(value);
    const key = longValue.toString();
    if (this.longMap.has(key)) {
      return this.longMap.get(key);
    }
    const entry = {
      tag: 5,
      value: longValue,
    };
    const index = this._pushEntry(entry);
    this.entries.push(null);
    this.longMap.set(key, index);
    return index;
  }

  addDouble(value) {
    const { numericValue, bits } = normalizeDoubleConstant(value);
    const key = bits.toString(16);
    if (this.doubleMap.has(key)) {
      return this.doubleMap.get(key);
    }
    const entry = {
      tag: 6,
      value: numericValue,
      bits,
    };
    const index = this._pushEntry(entry);
    this.entries.push(null);
    this.doubleMap.set(key, index);
    return index;
  }

  addNameAndType(name, descriptor) {
    const key = `${name || ''}|${descriptor || ''}`;
    if (this.nameAndTypeMap.has(key)) {
      return this.nameAndTypeMap.get(key);
    }
    const nameIndex = this.addUtf8(name || '');
    const descriptorIndex = this.addUtf8(descriptor || '');
    const entry = {
      tag: 12,
      nameIndex,
      descriptorIndex,
    };
    const index = this._pushEntry(entry);
    this.nameAndTypeMap.set(key, index);
    return index;
  }

  addFieldRef(className, name, descriptor) {
    const classIndex = this.addClass(className);
    const nameAndTypeIndex = this.addNameAndType(name, descriptor);
    const key = `${classIndex}|${nameAndTypeIndex}|field`;
    if (this.fieldRefMap.has(key)) {
      return this.fieldRefMap.get(key);
    }
    const entry = {
      tag: 9,
      classIndex,
      nameAndTypeIndex,
    };
    const index = this._pushEntry(entry);
    this.fieldRefMap.set(key, index);
    return index;
  }

  addMethodRef(className, name, descriptor) {
    const classIndex = this.addClass(className);
    const nameAndTypeIndex = this.addNameAndType(name, descriptor);
    const key = `${classIndex}|${nameAndTypeIndex}|method`;
    if (this.methodRefMap.has(key)) {
      return this.methodRefMap.get(key);
    }
    const entry = {
      tag: 10,
      classIndex,
      nameAndTypeIndex,
    };
    const index = this._pushEntry(entry);
    this.methodRefMap.set(key, index);
    return index;
  }

  addInterfaceMethodRef(className, name, descriptor) {
    const classIndex = this.addClass(className);
    const nameAndTypeIndex = this.addNameAndType(name, descriptor);
    const key = `${classIndex}|${nameAndTypeIndex}|interface`;
    if (this.interfaceMethodRefMap.has(key)) {
      return this.interfaceMethodRefMap.get(key);
    }
    const entry = {
      tag: 11,
      classIndex,
      nameAndTypeIndex,
    };
    const index = this._pushEntry(entry);
    this.interfaceMethodRefMap.set(key, index);
    return index;
  }

  addMethodType(descriptor) {
    const descriptorValue = descriptor || '';
    if (this.methodTypeMap.has(descriptorValue)) {
      return this.methodTypeMap.get(descriptorValue);
    }
    const descriptorIndex = this.addUtf8(descriptorValue);
    const entry = {
      tag: 16,
      descriptorIndex,
    };
    const index = this._pushEntry(entry);
    this.methodTypeMap.set(descriptorValue, index);
    return index;
  }

  addMethodHandle(handle) {
    if (!handle) {
      throw new Error('Method handle value is required');
    }
    const key = JSON.stringify(handle);
    if (this.methodHandleMap.has(key)) {
      return this.methodHandleMap.get(key);
    }
    const { kind, reference } = handle;
    const referenceKind = METHOD_HANDLE_KIND_CODES[kind];
    if (!referenceKind) {
      throw new Error(`Unsupported method handle kind: ${kind}`);
    }
    if (!reference || !reference.className || !reference.nameAndType) {
      throw new Error('Invalid method handle reference structure');
    }
    const { className, nameAndType } = reference;
    const { name, descriptor } = nameAndType;
    let referenceIndex;
    if (kind === 'getField' || kind === 'getStatic' || kind === 'putField' || kind === 'putStatic') {
      referenceIndex = this.addFieldRef(className, name, descriptor);
    } else if (kind === 'invokeInterface') {
      referenceIndex = this.addInterfaceMethodRef(className, name, descriptor);
    } else {
      referenceIndex = this.addMethodRef(className, name, descriptor);
    }
    const entry = {
      tag: 15,
      referenceKind,
      referenceIndex,
    };
    const index = this._pushEntry(entry);
    this.methodHandleMap.set(key, index);
    return index;
  }

  addInvokeDynamic(bootstrapIndex, name, descriptor) {
    const key = `${bootstrapIndex}|${name || ''}|${descriptor || ''}`;
    if (this.invokeDynamicMap.has(key)) {
      return this.invokeDynamicMap.get(key);
    }
    const nameAndTypeIndex = this.addNameAndType(name, descriptor);
    const entry = {
      tag: 18,
      bootstrapMethodAttrIndex: bootstrapIndex,
      nameAndTypeIndex,
    };
    const index = this._pushEntry(entry);
    this.invokeDynamicMap.set(key, index);
    return index;
  }

  getEntries() {
    return this.entries;
  }
}
function primeConstantPoolFromClass(cls, builder) {
  ensureArray(cls.items).forEach((item) => {
    if (!item || item.type !== 'method' || !item.method) {
      return;
    }
    ensureArray(item.method.attributes).forEach((attribute) => {
      if (!attribute || attribute.type !== 'code' || !attribute.code) {
        return;
      }
      ensureArray(attribute.code.codeItems).forEach((codeItem) => {
        const instruction = codeItem ? codeItem.instruction : null;
        if (!instruction || typeof instruction !== 'object') {
          return;
        }
        if (instruction.op === 'ldc') {
          resolveLdcIndex(builder, instruction.arg);
        } else if (instruction.op === 'ldc2_w') {
          resolveLdc2Index(builder, instruction.arg);
        }
      });
    });
  });
}

function resolveLdcIndex(builder, arg) {
  if (Array.isArray(arg)) {
    const [kind, value] = arg;
    if (kind === 'Class') {
      return builder.addClass(value);
    }
    throw new Error(`Unsupported ldc array constant kind: ${kind}`);
  }
  if (arg && typeof arg === 'object') {
    if (arg.type === 'Float') {
      return builder.addFloat(arg.value);
    }
    if (arg.type === 'Double') {
      return builder.addDouble(arg.value);
    }
    throw new Error(`Unsupported ldc object constant type: ${arg.type}`);
  }
  if (typeof arg === 'number') {
    return builder.addInteger(arg);
  }
  if (typeof arg === 'bigint') {
    return builder.addLong(arg);
  }
  return builder.addString(arg);
}

function resolveLdc2Index(builder, arg) {
  if (arg && typeof arg === 'object' && arg.type === 'Double') {
    return builder.addDouble(arg.value);
  }
  return builder.addLong(arg);
}

function buildBootstrapMethods(rawBootstrapMethods, builder) {
  const bootstrapMethods = [];
  ensureArray(rawBootstrapMethods).forEach((entry, index) => {
    if (!entry || !entry.method_ref || !entry.method_ref.value) {
      throw new Error(`Bootstrap method at index ${index} is missing method_ref`);
    }
    const methodHandleIndex = builder.addMethodHandle(entry.method_ref.value);
    const argumentIndexes = ensureArray(entry.arguments).map((argument) => {
      if (!argument) {
        throw new Error('Bootstrap method argument cannot be null');
      }
      switch (argument.type) {
        case 'String':
          return builder.addString(argument.value);
        case 'Class':
          return builder.addClass(argument.value);
        case 'MethodType':
          return builder.addMethodType(argument.value);
        case 'MethodHandle':
          return builder.addMethodHandle(argument.value);
        default:
          throw new Error(`Unsupported bootstrap method argument type: ${argument.type}`);
      }
    });
    bootstrapMethods.push({ methodHandleIndex, argumentIndexes });
  });
  return bootstrapMethods;
}

function buildFieldInfo(field, builder) {
  const flags = ensureArray(field.flags);
  const accessFlags = computeAccessFlags(flags, 'field');
  const nameIndex = builder.addUtf8(field.name || '');
  const descriptorIndex = builder.addUtf8(field.descriptor || '');
  return {
    accessFlags,
    nameIndex,
    descriptorIndex,
    attributes: [],
  };
}

function buildExceptionsAttribute(attribute, builder) {
  const exceptionNames = ensureArray(attribute.exceptions);
  const bodyWriter = new ByteWriter();
  bodyWriter.writeUint16(exceptionNames.length);
  exceptionNames.forEach((name) => {
    bodyWriter.writeUint16(builder.addClass(name));
  });
  return {
    nameIndex: builder.addUtf8(ATTRIBUTE_NAMES.Exceptions),
    info: bodyWriter.toBuffer(),
  };
}

function buildLineNumberTableAttribute(attribute, labelOffsets, builder) {
  const entries = ensureArray(attribute.lines).map((line) => {
    const label = line ? line.label : null;
    const offset = labelOffsets.get(label);
    if (offset === undefined) {
      throw new Error(`Unknown label "${label}" in LineNumberTable`);
    }
    const lineNumber = parseInteger(line.lineNumber, 0);
    return { offset, lineNumber };
  });
  const bodyWriter = new ByteWriter();
  bodyWriter.writeUint16(entries.length);
  entries.forEach((entry) => {
    bodyWriter.writeUint16(entry.offset);
    bodyWriter.writeUint16(entry.lineNumber);
  });
  return {
    nameIndex: builder.addUtf8(ATTRIBUTE_NAMES.LineNumberTable),
    info: bodyWriter.toBuffer(),
  };
}
function prepareInstruction(instruction, builder, currentOffset, bootstrapMethodCount) {
  if (typeof instruction === 'string') {
    const opcode = MNEMONIC_TO_OPCODE[instruction];
    if (opcode === undefined) {
      throw new Error(`Unknown opcode: ${instruction}`);
    }
    return {
      type: 'simple',
      op: instruction,
      opcode,
      length: 1,
      offset: currentOffset,
    };
  }

  const op = instruction.op;
  const opcode = MNEMONIC_TO_OPCODE[op];
  if (opcode === undefined) {
    throw new Error(`Unsupported opcode: ${op}`);
  }

  if (op === 'bipush') {
    const value = parseInteger(instruction.arg, 0);
    return { type: 'int8', op, opcode, value, length: 2, offset: currentOffset };
  }

  if (op === 'sipush') {
    const value = parseInteger(instruction.arg, 0);
    return { type: 'int16', op, opcode, value, length: 3, offset: currentOffset };
  }

  if (op === 'ldc') {
    const cpIndex = resolveLdcIndex(builder, instruction.arg);
    if (cpIndex > 0xff) {
      throw new Error(`ldc constant pool index out of range: ${cpIndex}`);
    }
    return { type: 'cp_u8', op, opcode, cpIndex, length: 2, offset: currentOffset };
  }

  if (op === 'ldc2_w' || op === 'ldc_w') {
    const cpIndex = op === 'ldc2_w' ? resolveLdc2Index(builder, instruction.arg) : resolveLdcIndex(builder, instruction.arg);
    return { type: 'cp_u16', op, opcode, cpIndex, length: 3, offset: currentOffset };
  }

  if (LOCAL_INDEX_OPS.has(op)) {
    const arg = instruction.arg != null ? instruction.arg : instruction.index;
    const index = parseInteger(arg, 0);
    if (index < 0 || index > 0xff) {
      throw new Error(`Local variable index out of range for ${op}: ${index}`);
    }
    return { type: 'local', op, opcode, index, length: 2, offset: currentOffset };
  }

  if (op === 'iinc') {
    const index = parseInteger(instruction.varnum != null ? instruction.varnum : instruction.index, 0);
    const constant = parseInteger(instruction.incr != null ? instruction.incr : instruction.const, 0);
    if (index < 0 || index > 0xff) {
      throw new Error(`iinc index out of range: ${index}`);
    }
    if (constant < -128 || constant > 127) {
      throw new Error(`iinc constant out of range: ${constant}`);
    }
    return { type: 'iinc', op, opcode, index, constant, length: 3, offset: currentOffset };
  }

  if (BRANCH_16_OPS.has(op)) {
    const target = String(instruction.arg);
    return { type: 'branch16', op, opcode, target, length: 3, offset: currentOffset };
  }

  if (BRANCH_32_OPS.has(op)) {
    const target = String(instruction.arg);
    return { type: 'branch32', op, opcode, target, length: 5, offset: currentOffset };
  }

  if (op === 'tableswitch') {
    const low = parseInteger(instruction.low, 0);
    const labels = ensureArray(instruction.labels).map((label) => String(label));
    const defaultLabel = instruction.defaultLbl != null ? String(instruction.defaultLbl) : String(instruction.defaultLabel);
    const padding = (4 - ((currentOffset + 1) % 4)) % 4;
    const length = 1 + padding + 12 + 4 * labels.length;
    return { type: 'tableswitch', op, opcode, low, labels, defaultLabel, padding, length, offset: currentOffset };
  }

  if (op === 'lookupswitch') {
    const arg = instruction.arg || {};
    const defaultLabel = arg.defaultLabel != null ? String(arg.defaultLabel) : String(arg.defaultLbl);
    const pairs = ensureArray(arg.pairs).map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) {
        throw new Error('Invalid lookupswitch pair');
      }
      return { match: parseInteger(pair[0], 0), label: String(pair[1]) };
    });
    const padding = (4 - ((currentOffset + 1) % 4)) % 4;
    const length = 1 + padding + 8 + 8 * pairs.length;
    return { type: 'lookupswitch', op, opcode, defaultLabel, pairs, padding, length, offset: currentOffset };
  }

  if (op === 'getstatic' || op === 'putstatic' || op === 'getfield' || op === 'putfield') {
    const [kind, owner, nameAndType] = instruction.arg || [];
    if (kind !== 'Field' || !owner || !Array.isArray(nameAndType) || nameAndType.length < 2) {
      throw new Error(`Invalid field reference for ${op}`);
    }
    const [name, descriptor] = nameAndType;
    const cpIndex = builder.addFieldRef(owner, name, descriptor);
    return { type: 'cp_u16', op, opcode, cpIndex, length: 3, offset: currentOffset };
  }

  if (op === 'invokespecial' || op === 'invokevirtual' || op === 'invokestatic') {
    const [kind, owner, nameAndType] = instruction.arg || [];
    if (!owner || !Array.isArray(nameAndType) || nameAndType.length < 2) {
      throw new Error(`Invalid method reference for ${op}`);
    }
    const [name, descriptor] = nameAndType;
    const cpIndex = builder.addMethodRef(owner, name, descriptor);
    return { type: 'cp_u16', op, opcode, cpIndex, length: 3, offset: currentOffset };
  }

  if (op === 'invokeinterface') {
    const [kind, owner, nameAndType] = instruction.arg || [];
    if (!owner || !Array.isArray(nameAndType) || nameAndType.length < 2) {
      throw new Error('Invalid interface method reference');
    }
    const [name, descriptor] = nameAndType;
    const cpIndex = builder.addInterfaceMethodRef(owner, name, descriptor);
    const count = parseInteger(instruction.count, 0);
    return { type: 'invokeinterface', op, opcode, cpIndex, count, length: 5, offset: currentOffset };
  }

  if (op === 'invokedynamic') {
    const arg = instruction.arg || {};
    const bootstrapIndex = parseInteger(arg.bootstrap_method_attr_index, 0);
    if (bootstrapIndex < 0 || bootstrapIndex >= bootstrapMethodCount) {
      throw new Error(`invokedynamic references invalid bootstrap method index ${bootstrapIndex}`);
    }
    const nameAndType = arg.nameAndType || {};
    const cpIndex = builder.addInvokeDynamic(bootstrapIndex, nameAndType.name || '', nameAndType.descriptor || '');
    return { type: 'invokedynamic', op, opcode, cpIndex, length: 5, offset: currentOffset };
  }

  if (op === 'new' || op === 'checkcast' || op === 'instanceof' || op === 'anewarray') {
    const className = instruction.arg;
    const cpIndex = builder.addClass(className);
    return { type: 'cp_u16', op, opcode, cpIndex, length: 3, offset: currentOffset };
  }

  if (op === 'multianewarray') {
    const arg = instruction.arg || [];
    const className = arg[0];
    const dimensions = parseInteger(arg[1], 0);
    const cpIndex = builder.addClass(className);
    return { type: 'multianewarray', op, opcode, cpIndex, dimensions, length: 4, offset: currentOffset };
  }

  if (op === 'newarray') {
    const typeName = String(instruction.arg || '').toLowerCase();
    const typeCode = NEW_ARRAY_TYPE_CODES[typeName];
    if (typeCode === undefined) {
      throw new Error(`Unsupported newarray type: ${instruction.arg}`);
    }
    return { type: 'newarray', op, opcode, typeCode, length: 2, offset: currentOffset };
  }

  if (op === 'wide') {
    const argString = String(instruction.arg || '').trim();
    const parts = argString.split(/\s+/);
    const baseOp = parts[0];
    const baseOpcode = MNEMONIC_TO_OPCODE[baseOp];
    if (baseOpcode === undefined) {
      throw new Error(`Unsupported wide target opcode: ${baseOp}`);
    }
    const index = parseInteger(parts[1], 0);
    if (baseOp === 'iinc') {
      const constant = parseInteger(parts[2], 0);
      return {
        type: 'wide_iinc',
        op,
        opcode,
        baseOpcode,
        index,
        constant,
        length: 6,
        offset: currentOffset,
      };
    }
    return {
      type: 'wide_local',
      op,
      opcode,
      baseOpcode,
      index,
      length: 4,
      offset: currentOffset,
    };
  }

  if (!MNEMONIC_TO_OPCODE.hasOwnProperty(op)) {
    throw new Error(`Unhandled opcode during preparation: ${op}`);
  }

  return { type: 'simple', op, opcode, length: 1, offset: currentOffset };
}
function encodeInstructions(codeItems, builder, bootstrapMethodCount) {
  const labelOffsets = new Map();
  const preparedInstructions = [];
  let offset = 0;

  ensureArray(codeItems).forEach((item) => {
    const label = item ? extractLabel(item.labelDef) : null;
    if (label) {
      labelOffsets.set(label, offset);
    }
    const instruction = item ? item.instruction : null;
    if (instruction === null || instruction === undefined) {
      return;
    }
    const prepared = prepareInstruction(instruction, builder, offset, bootstrapMethodCount);
    preparedInstructions.push(prepared);
    offset += prepared.length;
  });

  const writer = new ByteWriter();
  preparedInstructions.forEach((inst) => {
    writer.writeUint8(inst.opcode);
    switch (inst.type) {
      case 'simple':
        break;
      case 'int8':
        writer.writeInt8(inst.value);
        break;
      case 'int16':
        writer.writeInt16(inst.value);
        break;
      case 'cp_u8':
        writer.writeUint8(inst.cpIndex);
        break;
      case 'cp_u16':
        writer.writeUint16(inst.cpIndex);
        break;
      case 'local':
        writer.writeUint8(inst.index);
        break;
      case 'iinc':
        writer.writeUint8(inst.index);
        writer.writeInt8(inst.constant);
        break;
      case 'branch16': {
        const targetOffset = labelOffsets.get(inst.target);
        if (targetOffset === undefined) {
          throw new Error(`Unknown branch target: ${inst.target}`);
        }
        const branchOffset = targetOffset - inst.offset;
        writer.writeInt16(branchOffset);
        break;
      }
      case 'branch32': {
        const targetOffset = labelOffsets.get(inst.target);
        if (targetOffset === undefined) {
          throw new Error(`Unknown branch target: ${inst.target}`);
        }
        const branchOffset = targetOffset - inst.offset;
        writer.writeInt32(branchOffset);
        break;
      }
      case 'tableswitch': {
        for (let i = 0; i < inst.padding; i++) {
          writer.writeUint8(0);
        }
        const defaultOffset = labelOffsets.get(inst.defaultLabel);
        if (defaultOffset === undefined) {
          throw new Error(`Unknown tableswitch default label: ${inst.defaultLabel}`);
        }
        writer.writeInt32(defaultOffset - inst.offset);
        writer.writeInt32(inst.low);
        const high = inst.low + inst.labels.length - 1;
        writer.writeInt32(high);
        inst.labels.forEach((label) => {
          const targetOffset = labelOffsets.get(label);
          if (targetOffset === undefined) {
            throw new Error(`Unknown tableswitch label: ${label}`);
          }
          writer.writeInt32(targetOffset - inst.offset);
        });
        break;
      }
      case 'lookupswitch': {
        for (let i = 0; i < inst.padding; i++) {
          writer.writeUint8(0);
        }
        const defaultOffset = labelOffsets.get(inst.defaultLabel);
        if (defaultOffset === undefined) {
          throw new Error(`Unknown lookupswitch default label: ${inst.defaultLabel}`);
        }
        writer.writeInt32(defaultOffset - inst.offset);
        writer.writeInt32(inst.pairs.length);
        inst.pairs.forEach((pair) => {
          const targetOffset = labelOffsets.get(pair.label);
          if (targetOffset === undefined) {
            throw new Error(`Unknown lookupswitch label: ${pair.label}`);
          }
          writer.writeInt32(pair.match);
          writer.writeInt32(targetOffset - inst.offset);
        });
        break;
      }
      case 'invokeinterface':
        writer.writeUint16(inst.cpIndex);
        writer.writeUint8(inst.count);
        writer.writeUint8(0);
        break;
      case 'invokedynamic':
        writer.writeUint16(inst.cpIndex);
        writer.writeUint8(0);
        writer.writeUint8(0);
        break;
      case 'multianewarray':
        writer.writeUint16(inst.cpIndex);
        writer.writeUint8(inst.dimensions);
        break;
      case 'newarray':
        writer.writeUint8(inst.typeCode);
        break;
      case 'wide_iinc':
        writer.writeUint8(inst.baseOpcode);
        writer.writeUint16(inst.index);
        writer.writeInt16(inst.constant);
        break;
      case 'wide_local':
        writer.writeUint8(inst.baseOpcode);
        writer.writeUint16(inst.index);
        break;
      default:
        throw new Error(`Unhandled prepared instruction type: ${inst.type}`);
    }
  });

  return { buffer: writer.toBuffer(), labelOffsets };
}

function buildCodeAttribute(code, builder, bootstrapMethods) {
  const maxStack = parseInteger(code.stackSize, 0);
  const maxLocals = parseInteger(code.localsSize, 0);
  const { buffer, labelOffsets } = encodeInstructions(code.codeItems || [], builder, bootstrapMethods.length);

  const bodyWriter = new ByteWriter();
  bodyWriter.writeUint16(maxStack);
  bodyWriter.writeUint16(maxLocals);
  bodyWriter.writeUint32(buffer.length);
  bodyWriter.writeBytes(buffer);
  bodyWriter.writeUint16(0);

  const codeAttributes = [];
  ensureArray(code.attributes).forEach((attribute) => {
    if (!attribute) {
      return;
    }
    if (attribute.type === 'linenumbertable') {
      codeAttributes.push(buildLineNumberTableAttribute(attribute, labelOffsets, builder));
    }
  });

  bodyWriter.writeUint16(codeAttributes.length);
  codeAttributes.forEach((attr) => {
    bodyWriter.writeUint16(attr.nameIndex);
    bodyWriter.writeUint32(attr.info.length);
    bodyWriter.writeBytes(attr.info);
  });

  return {
    nameIndex: builder.addUtf8(ATTRIBUTE_NAMES.Code),
    info: bodyWriter.toBuffer(),
  };
}

function buildMethodInfo(method, builder, bootstrapMethods) {
  const flags = ensureArray(method.flags);
  const accessFlags = computeAccessFlags(flags, 'method');
  const nameIndex = builder.addUtf8(method.name || '');
  const descriptorIndex = builder.addUtf8(method.descriptor || '');

  const attributes = [];
  ensureArray(method.attributes).forEach((attribute) => {
    if (!attribute) {
      return;
    }
    if (attribute.type === 'code') {
      attributes.push(buildCodeAttribute(attribute.code || {}, builder, bootstrapMethods));
    } else if (attribute.type === 'exceptions') {
      attributes.push(buildExceptionsAttribute(attribute, builder));
    }
  });

  return {
    accessFlags,
    nameIndex,
    descriptorIndex,
    attributes,
  };
}

function buildClassAttributes(rawAttributes, builder, bootstrapMethods) {
  const attributes = [];
  ensureArray(rawAttributes).forEach((attribute) => {
    if (!attribute) {
      return;
    }
    if (attribute.type === 'sourcefile') {
      const value = parseStringLiteral(attribute.value);
      const sourceFileIndex = builder.addUtf8(value);
      const bodyWriter = new ByteWriter();
      bodyWriter.writeUint16(sourceFileIndex);
      attributes.push({
        nameIndex: builder.addUtf8(ATTRIBUTE_NAMES.SourceFile),
        info: bodyWriter.toBuffer(),
      });
    }
  });

  if (bootstrapMethods.length > 0) {
    const bodyWriter = new ByteWriter();
    bodyWriter.writeUint16(bootstrapMethods.length);
    bootstrapMethods.forEach((method) => {
      bodyWriter.writeUint16(method.methodHandleIndex);
      bodyWriter.writeUint16(method.argumentIndexes.length);
      method.argumentIndexes.forEach((index) => {
        bodyWriter.writeUint16(index);
      });
    });
    attributes.push({
      nameIndex: builder.addUtf8(ATTRIBUTE_NAMES.BootstrapMethods),
      info: bodyWriter.toBuffer(),
    });
  }

  return attributes;
}
function writeConstantPool(writer, entries) {
  writer.writeUint16(entries.length);
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    writer.writeUint8(entry.tag);
    switch (entry.tag) {
      case 1: { // Utf8
        const bytes = Buffer.from(entry.value, 'utf8');
        writer.writeUint16(bytes.length);
        writer.writeBytes(bytes);
        break;
      }
      case 3: // Integer
        writer.writeInt32(entry.value);
        break;
      case 4: { // Float
        writer.writeUint32(entry.bits >>> 0);
        break;
      }
      case 5: { // Long
        const value = entry.value;
        const buffer = Buffer.allocUnsafe(8);
        buffer.writeBigInt64BE(BigInt(value));
        writer.writeBytes(buffer);
        break;
      }
      case 6: { // Double
        const buffer = Buffer.allocUnsafe(8);
        buffer.writeBigUInt64BE(entry.bits);
        writer.writeBytes(buffer);
        break;
      }
      case 7: // Class
        writer.writeUint16(entry.nameIndex);
        break;
      case 8: // String
        writer.writeUint16(entry.stringIndex);
        break;
      case 9: // Fieldref
      case 10: // Methodref
      case 11: // InterfaceMethodref
        writer.writeUint16(entry.classIndex);
        writer.writeUint16(entry.nameAndTypeIndex);
        break;
      case 12: // NameAndType
        writer.writeUint16(entry.nameIndex);
        writer.writeUint16(entry.descriptorIndex);
        break;
      case 15: // MethodHandle
        writer.writeUint8(entry.referenceKind);
        writer.writeUint16(entry.referenceIndex);
        break;
      case 16: // MethodType
        writer.writeUint16(entry.descriptorIndex);
        break;
      case 18: // InvokeDynamic
        writer.writeUint16(entry.bootstrapMethodAttrIndex);
        writer.writeUint16(entry.nameAndTypeIndex);
        break;
      default:
        throw new Error(`Unsupported constant pool tag: ${entry.tag}`);
    }
  }
}

function writeFieldInfo(writer, field) {
  writer.writeUint16(field.accessFlags);
  writer.writeUint16(field.nameIndex);
  writer.writeUint16(field.descriptorIndex);
  writer.writeUint16(field.attributes.length);
  field.attributes.forEach((attribute) => {
    writer.writeUint16(attribute.nameIndex);
    writer.writeUint32(attribute.info.length);
    writer.writeBytes(attribute.info);
  });
}

function writeMethodInfo(writer, method) {
  writer.writeUint16(method.accessFlags);
  writer.writeUint16(method.nameIndex);
  writer.writeUint16(method.descriptorIndex);
  writer.writeUint16(method.attributes.length);
  method.attributes.forEach((attribute) => {
    writer.writeUint16(attribute.nameIndex);
    writer.writeUint32(attribute.info.length);
    writer.writeBytes(attribute.info);
  });
}

function assembleClass(cls) {
  const builder = new ConstantPoolBuilder();
  primeConstantPoolFromClass(cls, builder);
  const bootstrapMethods = buildBootstrapMethods(cls.bootstrapMethods || [], builder);

  const fields = [];
  const methods = [];
  const classAttributes = [];

  ensureArray(cls.items).forEach((item) => {
    if (!item) {
      return;
    }
    if (item.type === 'field' && item.field) {
      fields.push(buildFieldInfo(item.field, builder));
    } else if (item.type === 'method' && item.method) {
      methods.push(buildMethodInfo(item.method, builder, bootstrapMethods));
    } else if (item.type === 'attribute' && item.attribute) {
      classAttributes.push(item.attribute);
    }
  });

  const classAttrs = buildClassAttributes(classAttributes, builder, bootstrapMethods);

  const versionInfo = ensureArray(cls.version)[0] || {};
  const majorVersion = parseInteger(versionInfo.major, 52);
  const minorVersion = parseInteger(versionInfo.minor, 0);

  const accessFlags = computeAccessFlags(cls.flags || [], 'class');
  const thisClassIndex = builder.addClass(cls.className || '');
  const superClassName = cls.superClassName ? normalizeClassName(cls.superClassName) : null;
  const superClassIndex = superClassName ? builder.addClass(superClassName) : 0;

  const interfaceIndexes = ensureArray(cls.interfaces).map((iface) => builder.addClass(iface));

  const entries = builder.getEntries();
  const writer = new ByteWriter();

  writer.writeUint32(0xcafebabe);
  writer.writeUint16(minorVersion);
  writer.writeUint16(majorVersion);
  writeConstantPool(writer, entries);
  writer.writeUint16(accessFlags);
  writer.writeUint16(thisClassIndex);
  writer.writeUint16(superClassIndex);
  writer.writeUint16(interfaceIndexes.length);
  interfaceIndexes.forEach((index) => writer.writeUint16(index));

  writer.writeUint16(fields.length);
  fields.forEach((field) => writeFieldInfo(writer, field));

  writer.writeUint16(methods.length);
  methods.forEach((method) => writeMethodInfo(writer, method));

  writer.writeUint16(classAttrs.length);
  classAttrs.forEach((attribute) => {
    writer.writeUint16(attribute.nameIndex);
    writer.writeUint32(attribute.info.length);
    writer.writeBytes(attribute.info);
  });

  return writer.toBuffer();
}

function writeClassAstToClassFile(classAstInput, outputClassPath, options = {}) {
  if (!classAstInput) {
    throw new Error('classAstInput is required');
  }
  const cls = classAstInput.classes ? classAstInput.classes[0] : classAstInput;
  if (!cls) {
    throw new Error('No class definition found in class AST');
  }

  const buffer = assembleClass(cls);
  fs.mkdirSync(path.dirname(outputClassPath), { recursive: true });
  fs.writeFileSync(outputClassPath, buffer);
  return { constantPool: null };
}

function writeClassAstRootToDirectory(root, outputDir, options = {}) {
  if (!root || !Array.isArray(root.classes)) {
    throw new Error('Root class AST must include a classes array');
  }
  return root.classes.map((cls) => {
    const internalName = cls.className || 'Class';
    const segments = internalName.split('/');
    const simpleName = segments.pop();
    const classDir = path.join(outputDir, ...segments);
    const classFilePath = path.join(classDir, `${simpleName}.class`);
    writeClassAstToClassFile(cls, classFilePath, options);
    return classFilePath;
  });
}

module.exports = {
  writeClassAstToClassFile,
  writeClassAstRootToDirectory,
};
