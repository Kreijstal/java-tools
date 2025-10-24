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
  LocalVariableTable: 'LocalVariableTable',
  LocalVariableTypeTable: 'LocalVariableTypeTable',
  StackMapTable: 'StackMapTable',
  SourceFile: 'SourceFile',
  BootstrapMethods: 'BootstrapMethods',
  ConstantValue: 'ConstantValue',
  Signature: 'Signature',
  Deprecated: 'Deprecated',
  Synthetic: 'Synthetic',
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
    const trimmed = input.trim();
    const parsed = parseSpecialFloatString(trimmed);
    if (parsed) {
      return { numericValue: parsed.value, bits: parsed.bits };
    }
    const normalized = /[fF]$/.test(trimmed) ? trimmed.slice(0, -1) : trimmed;
    input = normalized;
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
    const trimmed = input.trim();
    const parsed = parseSpecialDoubleString(trimmed);
    if (parsed) {
      return { numericValue: parsed.value, bits: parsed.bits };
    }
    const normalized = /[dD]$/.test(trimmed) ? trimmed.slice(0, -1) : trimmed;
    input = normalized;
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

const SIMPLE_JAVA_STRING_ESCAPES = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  '\\': '\\',
  '"': '"',
  "'": "'",
  '0': '\0',
};

function unescapeJavaStringLiteral(body) {
  if (!body) {
    return '';
  }

  return body
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\([btnfr"'\\0])/g, (_, ch) => SIMPLE_JAVA_STRING_ESCAPES[ch] ?? ch)
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
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
      return unescapeJavaStringLiteral(trimmed.slice(1, -1));
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

function resolveBootstrapArgumentIndex(argument, builder) {
  if (argument == null) {
    throw new Error('Bootstrap method argument cannot be null');
  }

  if (typeof argument === 'object' && 'type' in argument) {
    switch (argument.type) {
      case 'String':
        return builder.addString(argument.value);
      case 'Class':
        return builder.addClass(argument.value);
      case 'MethodType':
        return builder.addMethodType(argument.value);
      case 'MethodHandle':
        return builder.addMethodHandle(argument.value);
      case 'Integer':
      case 'Int':
      case 'int':
        return builder.addInteger(parseInteger(argument.value, 0));
      case 'Long':
      case 'long':
        return builder.addLong(parseBigInt(argument.value));
      case 'Float':
      case 'float':
        return builder.addFloat(argument.value);
      case 'Double':
      case 'double':
        return builder.addDouble(argument.value);
      case 'Boolean':
      case 'boolean':
        return builder.addInteger(argument.value ? 1 : 0);
      default:
        break;
    }
  }

  if (typeof argument === 'string') {
    const trimmed = argument.trim();
    if (/^[-+]?\d+$/.test(trimmed)) {
      return builder.addInteger(Number.parseInt(trimmed, 10));
    }
    if (/^[-+]?\d+[lL]$/.test(trimmed)) {
      return builder.addLong(BigInt(trimmed.slice(0, -1)));
    }
    if (/^[-+]?\d*\.\d+(?:[eE][-+]?\d+)?[fF]$/.test(trimmed)) {
      return builder.addFloat(normalizeFloatConstant(trimmed));
    }
    if (/^[-+]?\d*\.\d+(?:[eE][-+]?\d+)?[dD]?$/.test(trimmed)) {
      return builder.addDouble(normalizeDoubleConstant(trimmed));
    }
    return builder.addString(parseStringLiteral(trimmed));
  }

  if (typeof argument === 'number') {
    if (Number.isInteger(argument)) {
      return builder.addInteger(argument);
    }
    return builder.addDouble(normalizeDoubleConstant(argument));
  }

  if (typeof argument === 'bigint') {
    return builder.addLong(argument);
  }

  throw new Error(`Unsupported bootstrap method argument: ${JSON.stringify(argument)}`);
}

function buildBootstrapMethods(rawBootstrapMethods, builder) {
  const bootstrapMethods = [];
  ensureArray(rawBootstrapMethods).forEach((entry, index) => {
    if (!entry || !entry.method_ref || !entry.method_ref.value) {
      throw new Error(`Bootstrap method at index ${index} is missing method_ref`);
    }
    const methodHandleIndex = builder.addMethodHandle(entry.method_ref.value);
    const argumentIndexes = ensureArray(entry.arguments).map((argument) =>
      resolveBootstrapArgumentIndex(argument, builder)
    );
    bootstrapMethods.push({ methodHandleIndex, argumentIndexes });
  });
  return bootstrapMethods;
}

function normalizeConstantValue(rawValue, descriptor) {
  if (rawValue === undefined || rawValue === null) {
    throw new Error('ConstantValue attribute requires a non-null value');
  }

  const normalizedDescriptor = descriptor ? String(descriptor) : '';

  if (Array.isArray(rawValue) && rawValue.length > 0) {
    const [tag, ...rest] = rawValue;
    const payload = rest.length === 1 ? rest[0] : rest;
    if (tag === 'Int') {
      return { kind: 'int', value: Number.parseInt(String(payload), 10) };
    }
    if (tag === 'Long') {
      const text = String(payload).replace(/[lL]$/, '');
      return { kind: 'long', value: BigInt(text) };
    }
    if (tag === 'Float') {
      return { kind: 'float', value: String(payload) };
    }
    if (tag === 'Double') {
      return { kind: 'double', value: String(payload) };
    }
    if (tag === 'String') {
      return { kind: 'string', value: parseStringLiteral(String(payload)) };
    }
  }

  if (typeof rawValue === 'object' && rawValue !== null) {
    if (rawValue.type === 'Float') {
      return { kind: 'float', value: rawValue.value };
    }
    if (rawValue.type === 'Double') {
      return { kind: 'double', value: rawValue.value };
    }
    if (rawValue.type === 'Long') {
      return { kind: 'long', value: parseBigInt(rawValue.value) };
    }
    if (rawValue.type === 'Integer') {
      return { kind: 'int', value: parseInteger(rawValue.value, 0) };
    }
    if (rawValue.type === 'String') {
      return { kind: 'string', value: parseStringLiteral(rawValue.value) };
    }
    if ('numericValue' in rawValue && 'bits' in rawValue && normalizedDescriptor === 'F') {
      return { kind: 'float', value: rawValue };
    }
    if ('numericValue' in rawValue && 'bits' in rawValue && normalizedDescriptor === 'D') {
      return { kind: 'double', value: rawValue };
    }
  }

  if (typeof rawValue === 'bigint') {
    return { kind: 'long', value: rawValue };
  }

  if (typeof rawValue === 'number') {
    if (normalizedDescriptor === 'J') {
      return { kind: 'long', value: BigInt(rawValue) };
    }
    if (normalizedDescriptor === 'F') {
      return { kind: 'float', value: rawValue };
    }
    if (normalizedDescriptor === 'D') {
      return { kind: 'double', value: rawValue };
    }
    return { kind: 'int', value: rawValue | 0 };
  }

  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return { kind: 'string', value: '' };
    }

    if (/^(true|false)$/i.test(trimmed)) {
      return { kind: 'int', value: trimmed.toLowerCase() === 'true' ? 1 : 0 };
    }

    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return { kind: 'string', value: parseStringLiteral(trimmed) };
    }

    if (normalizedDescriptor === 'Ljava/lang/String;') {
      return { kind: 'string', value: parseStringLiteral(trimmed) };
    }

    if (/^[-+]?0x[0-9a-fA-F]+$/.test(trimmed)) {
      if (normalizedDescriptor === 'J') {
        return { kind: 'long', value: BigInt(trimmed) };
      }
      return { kind: 'int', value: Number.parseInt(trimmed, 16) };
    }

    if (/^[-+]?\d+[lL]$/.test(trimmed)) {
      return { kind: 'long', value: BigInt(trimmed.slice(0, -1)) };
    }

    if (/^[-+]?\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (normalizedDescriptor === 'J') {
        return { kind: 'long', value: BigInt(parsed) };
      }
      return { kind: 'int', value: parsed };
    }

    if (normalizedDescriptor === 'F' || /[fF]$/.test(trimmed)) {
      return { kind: 'float', value: trimmed };
    }

    if (normalizedDescriptor === 'D' || /[dD]$/.test(trimmed) || trimmed.includes('.') || trimmed.includes('e') || trimmed.includes('E')) {
      return { kind: 'double', value: trimmed };
    }

    if (normalizedDescriptor === 'C') {
      if (trimmed.startsWith('\\u') && trimmed.length >= 6) {
        return { kind: 'int', value: Number.parseInt(trimmed.slice(2), 16) };
      }
      if (trimmed.length === 1) {
        return { kind: 'int', value: trimmed.charCodeAt(0) };
      }
    }
  }

  throw new Error(`Unsupported constant value ${JSON.stringify(rawValue)} for descriptor ${descriptor}`);
}

function buildConstantValueAttribute(rawValue, descriptor, builder) {
  const normalized = normalizeConstantValue(rawValue, descriptor);
  let constantPoolIndex;
  switch (normalized.kind) {
    case 'int':
      constantPoolIndex = builder.addInteger(normalized.value);
      break;
    case 'long':
      constantPoolIndex = builder.addLong(normalized.value);
      break;
    case 'float':
      constantPoolIndex = builder.addFloat(normalized.value);
      break;
    case 'double':
      constantPoolIndex = builder.addDouble(normalized.value);
      break;
    case 'string':
      constantPoolIndex = builder.addString(normalized.value);
      break;
    default:
      throw new Error(`Unsupported normalized constant value kind: ${normalized.kind}`);
  }

  const bodyWriter = new ByteWriter();
  bodyWriter.writeUint16(constantPoolIndex);
  return {
    nameIndex: builder.addUtf8(ATTRIBUTE_NAMES.ConstantValue),
    info: bodyWriter.toBuffer(),
  };
}

function buildFieldAttributes(field, builder) {
  const attributes = [];
  const descriptor = field.descriptor || '';
  let hasConstantValue = false;
  let constantValueSource = null;

  if (field.value !== undefined && field.value !== null) {
    attributes.push(buildConstantValueAttribute(field.value, descriptor, builder));
    hasConstantValue = true;
    constantValueSource = 'field.value';
  }

  const rawAttributes = [];
  if (field.attrs && Array.isArray(field.attrs.attributes)) {
    rawAttributes.push(...field.attrs.attributes);
  }
  if (Array.isArray(field.attributes)) {
    rawAttributes.push(...field.attributes);
  }

  rawAttributes.forEach((attribute) => {
    if (!attribute) {
      return;
    }
    switch (attribute.type) {
      case 'constantvalue':
        if (hasConstantValue) {
          throw new Error(
            `Field "${field.name}" defines multiple ConstantValue sources (${constantValueSource} and attribute)`
          );
        }
        attributes.push(buildConstantValueAttribute(attribute.value, descriptor, builder));
        hasConstantValue = true;
        constantValueSource = 'attribute';
        break;
      case 'signature': {
        const signature = parseStringLiteral(attribute.sig || attribute.value || '');
        const bodyWriter = new ByteWriter();
        bodyWriter.writeUint16(builder.addUtf8(signature));
        attributes.push({
          nameIndex: builder.addUtf8(ATTRIBUTE_NAMES.Signature),
          info: bodyWriter.toBuffer(),
        });
        break;
      }
      case 'deprecated':
        attributes.push({
          nameIndex: builder.addUtf8(ATTRIBUTE_NAMES.Deprecated),
          info: Buffer.alloc(0),
        });
        break;
      case 'synthetic':
        attributes.push({
          nameIndex: builder.addUtf8(ATTRIBUTE_NAMES.Synthetic),
          info: Buffer.alloc(0),
        });
        break;
      default:
        throw new Error(`Unsupported field attribute type: ${attribute.type}`);
    }
  });

  return attributes;
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
    attributes: buildFieldAttributes(field, builder),
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

function resolveLabelOffset(label, labelOffsets, attributeName) {
  const normalized = extractLabel(label) || (label != null ? String(label) : null);
  const offset = labelOffsets.get(normalized);
  if (offset === undefined) {
    throw new Error(`Unknown label "${label}" in ${attributeName}`);
  }
  return offset;
}

function buildLocalVariableTableAttribute(attribute, labelOffsets, builder) {
  const variables = ensureArray(attribute.vars);
  const bodyWriter = new ByteWriter();
  bodyWriter.writeUint16(variables.length);
  variables.forEach((variable, index) => {
    if (!variable) {
      throw new Error(`LocalVariableTable entry at index ${index} is missing`);
    }
    const startOffset = resolveLabelOffset(variable.startLbl ?? variable.startLabel ?? variable.start, labelOffsets, 'LocalVariableTable');
    const endOffset = resolveLabelOffset(variable.endLbl ?? variable.endLabel ?? variable.end, labelOffsets, 'LocalVariableTable');
    const length = endOffset - startOffset;
    if (length < 0) {
      throw new Error(`LocalVariableTable entry "${variable.name}" has negative length`);
    }
    const nameIndex = builder.addUtf8(parseStringLiteral(variable.name));
    const descriptorIndex = builder.addUtf8(variable.descriptor || '');
    const slotIndex = parseInteger(variable.index, 0);
    bodyWriter.writeUint16(startOffset);
    bodyWriter.writeUint16(length);
    bodyWriter.writeUint16(nameIndex);
    bodyWriter.writeUint16(descriptorIndex);
    bodyWriter.writeUint16(slotIndex);
  });
  return {
    nameIndex: builder.addUtf8(ATTRIBUTE_NAMES.LocalVariableTable),
    info: bodyWriter.toBuffer(),
  };
}

function buildLocalVariableTypeTableAttribute(attribute, labelOffsets, builder) {
  const variables = ensureArray(attribute.vars);
  const bodyWriter = new ByteWriter();
  bodyWriter.writeUint16(variables.length);
  variables.forEach((variable, index) => {
    if (!variable) {
      throw new Error(`LocalVariableTypeTable entry at index ${index} is missing`);
    }
    const startOffset = resolveLabelOffset(variable.startLbl ?? variable.startLabel ?? variable.start, labelOffsets, 'LocalVariableTypeTable');
    const endOffset = resolveLabelOffset(variable.endLbl ?? variable.endLabel ?? variable.end, labelOffsets, 'LocalVariableTypeTable');
    const length = endOffset - startOffset;
    if (length < 0) {
      throw new Error(`LocalVariableTypeTable entry "${variable.name}" has negative length`);
    }
    const nameIndex = builder.addUtf8(parseStringLiteral(variable.name));
    const signatureIndex = builder.addUtf8(variable.descriptor || '');
    const slotIndex = parseInteger(variable.index, 0);
    bodyWriter.writeUint16(startOffset);
    bodyWriter.writeUint16(length);
    bodyWriter.writeUint16(nameIndex);
    bodyWriter.writeUint16(signatureIndex);
    bodyWriter.writeUint16(slotIndex);
  });
  return {
    nameIndex: builder.addUtf8(ATTRIBUTE_NAMES.LocalVariableTypeTable),
    info: bodyWriter.toBuffer(),
  };
}

function buildExceptionTableEntries(code, labelOffsets, builder) {
  const entries = ensureArray(code.exceptionTable);
  return entries.map((entry, index) => {
    if (!entry) {
      throw new Error(`Exception table entry at index ${index} is missing`);
    }
    const startLabel = entry.startLbl ?? entry.startLabel ?? entry.start;
    const endLabel = entry.endLbl ?? entry.endLabel ?? entry.end;
    const handlerLabel = entry.handlerLbl ?? entry.handlerLabel ?? entry.handler;

    const startPc = resolveLabelOffset(startLabel, labelOffsets, 'ExceptionTable');
    const endPc = resolveLabelOffset(endLabel, labelOffsets, 'ExceptionTable');
    const handlerPc = resolveLabelOffset(handlerLabel, labelOffsets, 'ExceptionTable');

    if (endPc < startPc) {
      throw new Error(`Exception handler at index ${index} has end before start`);
    }

    let catchTypeIndex = 0;
    const catchType = entry.catchType ?? entry.type;
    if (catchType && catchType !== 'any' && catchType !== 0) {
      if (typeof catchType === 'object') {
        if (catchType.type === 'Class') {
          catchTypeIndex = builder.addClass(catchType.value);
        } else if ('value' in catchType) {
          catchTypeIndex = builder.addClass(catchType.value);
        } else if ('name' in catchType) {
          catchTypeIndex = builder.addClass(catchType.name);
        } else {
          throw new Error(`Unsupported catch type object in exception table: ${JSON.stringify(catchType)}`);
        }
      } else if (typeof catchType === 'string') {
        const normalized = catchType.trim();
        if (normalized === '' || normalized === '0') {
          catchTypeIndex = 0;
        } else {
          catchTypeIndex = builder.addClass(normalized);
        }
      } else if (typeof catchType === 'number') {
        catchTypeIndex = catchType | 0;
      } else {
        throw new Error(`Unsupported catch type in exception table: ${JSON.stringify(catchType)}`);
      }
    }

    return { startPc, endPc, handlerPc, catchTypeIndex };
  });
}

const VERIFICATION_TYPE_TAGS = new Map([
  ['top', 0],
  ['integer', 1],
  ['int', 1],
  ['float', 2],
  ['double', 3],
  ['long', 4],
  ['null', 5],
  ['uninitializedthis', 6],
]);

function canonicalizeIdentifier(value) {
  return String(value).replace(/[\s_-]+/g, '').toLowerCase();
}

function resolveOffsetDelta(rawValue, labelOffsets) {
  if (rawValue == null) {
    throw new Error('StackMapTable frame is missing offset_delta');
  }

  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed === '') {
      throw new Error('StackMapTable frame offset_delta cannot be empty');
    }
    if (/^-?\d+$/.test(trimmed)) {
      return parseInteger(trimmed, 0);
    }
    return resolveLabelOffset(trimmed, labelOffsets, 'StackMapTable');
  }

  return parseInteger(rawValue, 0);
}

function normalizeVerificationType(entry, labelOffsets, builder) {
  if (entry == null) {
    throw new Error('Verification type entry is missing');
  }

  if (typeof entry === 'number') {
    if (!Number.isInteger(entry) || entry < 0 || entry > 8) {
      throw new Error(`Unsupported verification type tag: ${entry}`);
    }
    if (entry === 7 || entry === 8) {
      throw new Error('Object and uninitialized verification types require additional metadata');
    }
    return { tag: entry };
  }

  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new Error('Verification type entry cannot be an empty string');
    }

    const canonical = canonicalizeIdentifier(trimmed);
    if (VERIFICATION_TYPE_TAGS.has(canonical)) {
      return { tag: VERIFICATION_TYPE_TAGS.get(canonical) };
    }

    const objectMatch = /^object\s*(?::|=)?\s*(.+)$/i.exec(trimmed);
    if (objectMatch) {
      const className = normalizeClassName(objectMatch[1]);
      return { tag: 7, poolIndex: builder.addClass(className) };
    }

    const uninitMatch = /^uninitialized\s*(?::|=)?\s*(.+)$/i.exec(trimmed);
    if (uninitMatch) {
      const offset = resolveOffsetDelta(uninitMatch[1], labelOffsets);
      return { tag: 8, offset };
    }

    if (/^[A-Za-z0-9_$/\.]+$/.test(trimmed)) {
      const className = normalizeClassName(trimmed);
      return { tag: 7, poolIndex: builder.addClass(className) };
    }

    throw new Error(`Unsupported verification type literal: ${entry}`);
  }

  if (typeof entry === 'object') {
    const rawTag = entry.tag ?? entry.type ?? entry.kind;
    let tag;
    if (typeof rawTag === 'number') {
      tag = rawTag;
    } else if (typeof rawTag === 'string') {
      const canonical = canonicalizeIdentifier(rawTag);
      if (canonical === 'object') {
        tag = 7;
      } else if (canonical === 'uninitialized') {
        tag = 8;
      } else if (VERIFICATION_TYPE_TAGS.has(canonical)) {
        tag = VERIFICATION_TYPE_TAGS.get(canonical);
      }
    }

    if (tag == null) {
      throw new Error(`Unable to determine verification type tag for entry: ${JSON.stringify(entry)}`);
    }

    if (tag === 7) {
      const className = entry.class ?? entry.className ?? entry.name ?? entry.value ?? entry.descriptor ?? entry.internalName;
      if (!className) {
        throw new Error('Object verification type requires a class name');
      }
      return { tag, poolIndex: builder.addClass(normalizeClassName(className)) };
    }

    if (tag === 8) {
      let offsetSource = entry.offset ?? entry.offsetDelta ?? entry.start ?? entry.pc;
      if (offsetSource == null) {
        const label = entry.label ?? entry.lbl ?? entry.startLbl ?? entry.startLabel;
        if (label != null) {
          offsetSource = resolveLabelOffset(label, labelOffsets, 'StackMapTable');
        }
      }
      if (offsetSource == null) {
        throw new Error('Uninitialized verification type requires an offset or label');
      }
      const offset = resolveOffsetDelta(offsetSource, labelOffsets);
      return { tag, offset };
    }

    return { tag };
  }

  throw new Error(`Unsupported verification type entry: ${entry}`);
}

const STACK_MAP_KIND_ALIASES = {
  same: 'same',
  sameframe: 'same',
  'same_locals_1_stack_item': 'same_locals_1_stack_item',
  'samlocals1stackitem': 'same_locals_1_stack_item',
  'same_locals_1_stack_item_frame': 'same_locals_1_stack_item',
  'samestack': 'same_locals_1_stack_item',
  'same_locals_1_stack_item_extended': 'same_locals_1_stack_item_extended',
  'sameextended': 'same_extended',
  'same_frame_extended': 'same_extended',
  append: 'append',
  appendframe: 'append',
  chop: 'chop',
  chopframe: 'chop',
  full: 'full',
  fullframe: 'full',
};

function normalizeStackMapFrame(frame, labelOffsets, builder, index) {
  if (!frame) {
    throw new Error(`StackMapTable frame at index ${index} is missing`);
  }

  const frameData = frame.data ?? frame.info?.data ?? frame.info ?? {};
  const rawType = frame.frameType ?? frame.frame_type ?? frame.type ?? frame.kind ?? frameData.type;
  let frameType = null;
  let kind = null;
  let offsetDelta = frame.offsetDelta ?? frame.offset_delta ?? frame.delta ?? frame.offset ?? frameData.offset_delta ?? frameData.offsetDelta ?? frameData.offset;
  let localsRaw = frame.locals ?? frame.localTypes ?? frame.localsTypes ?? frameData.locals;
  let stackRaw = frame.stack ?? frame.stackItems ?? frame.stack_types ?? frameData.stack ?? frameData.stack_items;
  let chopCount = frame.chop ?? frame.localsToDrop ?? frame.chopped ?? frame.count ?? frameData.chop ?? frameData.locals_to_drop ?? frameData.localsToDrop;

  if (typeof rawType === 'number') {
    frameType = rawType;
    if (frameType >= 0 && frameType <= 63) {
      kind = 'same';
      offsetDelta = frameType;
    } else if (frameType >= 64 && frameType <= 127) {
      kind = 'same_locals_1_stack_item';
      offsetDelta = frameType - 64;
    } else if (frameType === 247) {
      kind = 'same_locals_1_stack_item_extended';
    } else if (frameType >= 248 && frameType <= 250) {
      kind = 'chop';
      chopCount = 251 - frameType;
    } else if (frameType === 251) {
      kind = 'same_extended';
    } else if (frameType >= 252 && frameType <= 254) {
      kind = 'append';
      const expected = frameType - 251;
      if (localsRaw && ensureArray(localsRaw).length !== expected) {
        throw new Error(`Append frame at index ${index} must provide exactly ${expected} locals`);
      }
    } else if (frameType === 255) {
      kind = 'full';
    }
  } else if (rawType != null) {
    const canonical = canonicalizeIdentifier(rawType);
    kind = STACK_MAP_KIND_ALIASES[canonical] ?? null;
  }

  if (!kind) {
    throw new Error(`Unsupported StackMapTable frame type: ${rawType}`);
  }

  if (kind === 'same') {
    const delta = resolveOffsetDelta(offsetDelta ?? 0, labelOffsets);
    if (frameType == null) {
      if (delta < 0 || delta > 0xffff) {
        throw new Error(`same_frame offset_delta out of range: ${delta}`);
      }
      if (delta <= 63) {
        frameType = delta;
        offsetDelta = delta;
      } else {
        kind = 'same_extended';
        frameType = 251;
        offsetDelta = delta;
      }
    } else {
      offsetDelta = delta;
    }
    return { frameType, kind, offsetDelta, locals: [], stack: [] };
  }

  if (kind === 'same_locals_1_stack_item') {
    const stackEntries = ensureArray(stackRaw ?? frame.stack ?? frameData.stack);
    if (stackEntries.length !== 1) {
      throw new Error('same_locals_1_stack_item frame requires exactly one stack entry');
    }
    const normalizedStack = [normalizeVerificationType(stackEntries[0], labelOffsets, builder)];
    const delta = resolveOffsetDelta(offsetDelta ?? (frameType != null ? frameType - 64 : 0), labelOffsets);
    if (frameType == null) {
      if (delta < 0 || delta > 0xffff) {
        throw new Error(`same_locals_1_stack_item offset_delta out of range: ${delta}`);
      }
      if (delta <= 63) {
        frameType = 64 + delta;
      } else {
        return {
          frameType: 247,
          kind: 'same_locals_1_stack_item_extended',
          offsetDelta: delta,
          locals: [],
          stack: normalizedStack,
        };
      }
    }
    return { frameType, kind, offsetDelta: delta, locals: [], stack: normalizedStack };
  }

  if (kind === 'same_locals_1_stack_item_extended') {
    const stackEntries = ensureArray(stackRaw ?? frameData.stack);
    if (stackEntries.length !== 1) {
      throw new Error('same_locals_1_stack_item_extended frame requires exactly one stack entry');
    }
    const normalizedStack = [normalizeVerificationType(stackEntries[0], labelOffsets, builder)];
    const delta = resolveOffsetDelta(offsetDelta, labelOffsets);
    return { frameType: frameType ?? 247, kind, offsetDelta: delta, locals: [], stack: normalizedStack };
  }

  if (kind === 'same_extended') {
    const delta = resolveOffsetDelta(offsetDelta, labelOffsets);
    return { frameType: frameType ?? 251, kind, offsetDelta: delta, locals: [], stack: [] };
  }

  if (kind === 'append') {
    const locals = ensureArray(localsRaw ?? frameData.locals);
    if (locals.length < 1 || locals.length > 3) {
      throw new Error('append frame must specify between 1 and 3 locals');
    }
    const normalizedLocals = locals.map((local) => normalizeVerificationType(local, labelOffsets, builder));
    const delta = resolveOffsetDelta(offsetDelta, labelOffsets);
    return {
      frameType: frameType ?? 251 + normalizedLocals.length,
      kind,
      offsetDelta: delta,
      locals: normalizedLocals,
      stack: [],
    };
  }

  if (kind === 'chop') {
    const count = parseInteger(chopCount ?? 1, 1);
    if (count < 1 || count > 3) {
      throw new Error('chop frame must drop between 1 and 3 locals');
    }
    const delta = resolveOffsetDelta(offsetDelta, labelOffsets);
    return {
      frameType: frameType ?? 251 - count,
      kind,
      offsetDelta: delta,
      locals: [],
      stack: [],
      chop: count,
    };
  }

  if (kind === 'full') {
    const locals = ensureArray(localsRaw ?? frameData.locals ?? []);
    const stack = ensureArray(stackRaw ?? frameData.stack ?? []);
    const normalizedLocals = locals.map((local) => normalizeVerificationType(local, labelOffsets, builder));
    const normalizedStack = stack.map((entry) => normalizeVerificationType(entry, labelOffsets, builder));
    const delta = resolveOffsetDelta(offsetDelta, labelOffsets);
    return {
      frameType: frameType ?? 255,
      kind,
      offsetDelta: delta,
      locals: normalizedLocals,
      stack: normalizedStack,
    };
  }

  throw new Error(`Unsupported StackMapTable frame kind: ${kind}`);
}

function encodeVerificationType(writer, info) {
  writer.writeUint8(info.tag);
  if (info.tag === 7) {
    writer.writeUint16(info.poolIndex);
  } else if (info.tag === 8) {
    writer.writeUint16(info.offset);
  }
}

function buildStackMapTableAttribute(attribute, labelOffsets, builder) {
  const frames = ensureArray(attribute.frames ?? attribute.entries ?? attribute.frameList);
  const bodyWriter = new ByteWriter();
  bodyWriter.writeUint16(frames.length);
  frames.forEach((frame, index) => {
    const normalized = normalizeStackMapFrame(frame, labelOffsets, builder, index);
    bodyWriter.writeUint8(normalized.frameType);
    switch (normalized.kind) {
      case 'same':
        break;
      case 'same_locals_1_stack_item':
        encodeVerificationType(bodyWriter, normalized.stack[0]);
        break;
      case 'same_locals_1_stack_item_extended':
        bodyWriter.writeUint16(normalized.offsetDelta);
        encodeVerificationType(bodyWriter, normalized.stack[0]);
        break;
      case 'same_extended':
        bodyWriter.writeUint16(normalized.offsetDelta);
        break;
      case 'append':
        bodyWriter.writeUint16(normalized.offsetDelta);
        normalized.locals.forEach((local) => encodeVerificationType(bodyWriter, local));
        break;
      case 'chop':
        bodyWriter.writeUint16(normalized.offsetDelta);
        break;
      case 'full':
        bodyWriter.writeUint16(normalized.offsetDelta);
        bodyWriter.writeUint16(normalized.locals.length);
        normalized.locals.forEach((local) => encodeVerificationType(bodyWriter, local));
        bodyWriter.writeUint16(normalized.stack.length);
        normalized.stack.forEach((entry) => encodeVerificationType(bodyWriter, entry));
        break;
      default:
        throw new Error(`Unsupported StackMapTable frame kind: ${normalized.kind}`);
    }
  });
  return {
    nameIndex: builder.addUtf8(ATTRIBUTE_NAMES.StackMapTable),
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
      const wideOpcode = MNEMONIC_TO_OPCODE.ldc_w;
      if (wideOpcode === undefined) {
        throw new Error('Opcode mapping missing for ldc_w');
      }
      return {
        type: 'cp_u16',
        op: 'ldc_w',
        opcode: wideOpcode,
        cpIndex,
        length: 3,
        offset: currentOffset,
      };
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
  const exceptionTableEntries = buildExceptionTableEntries(code, labelOffsets, builder);
  bodyWriter.writeUint16(exceptionTableEntries.length);
  exceptionTableEntries.forEach((entry) => {
    bodyWriter.writeUint16(entry.startPc);
    bodyWriter.writeUint16(entry.endPc);
    bodyWriter.writeUint16(entry.handlerPc);
    bodyWriter.writeUint16(entry.catchTypeIndex);
  });

  const codeAttributes = [];
  ensureArray(code.attributes).forEach((attribute) => {
    if (!attribute) {
      return;
    }
    switch (attribute.type) {
      case 'linenumbertable':
        codeAttributes.push(buildLineNumberTableAttribute(attribute, labelOffsets, builder));
        break;
      case 'localvariabletable':
        codeAttributes.push(buildLocalVariableTableAttribute(attribute, labelOffsets, builder));
        break;
      case 'localvariabletypetable':
        codeAttributes.push(buildLocalVariableTypeTableAttribute(attribute, labelOffsets, builder));
        break;
      case 'stackmaptable':
        codeAttributes.push(buildStackMapTableAttribute(attribute, labelOffsets, builder));
        break;
      default:
        throw new Error(`Unsupported code attribute type: ${attribute.type}`);
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
        buffer.writeBigInt64BE(value);
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

  let buffer;
  try {
    buffer = assembleClass(cls);
  } catch (err) {
    const wrapped = new Error(`Failed to assemble class ${cls.className || '<anonymous>'}: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }

  const directory = path.dirname(outputClassPath);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (err) {
    const wrapped = new Error(`Failed to create directory for class file at "${directory}": ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }

  try {
    fs.writeFileSync(outputClassPath, buffer);
  } catch (err) {
    const wrapped = new Error(`Failed to write class file to "${outputClassPath}": ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }
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
