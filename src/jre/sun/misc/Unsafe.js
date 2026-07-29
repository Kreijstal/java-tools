const unsafe = {
  type: 'sun/misc/Unsafe',
};

const nativeLittleEndian =
  new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const offsets = new Map();
let nextOffset = 1n;

function numberOffset(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function byteStorage(base) {
  if (base && base.array) return base.array;
  return base;
}

function readStorageByte(base, offset) {
  const storage = byteStorage(base);
  if (!storage) {
    throw new Error(`Unsafe absolute address read is not available at ${offset}`);
  }
  return Number(storage[offset]) & 0xff;
}

function writeStorageByte(base, offset, value) {
  const storage = byteStorage(base);
  if (!storage) {
    throw new Error(`Unsafe absolute address write is not available at ${offset}`);
  }
  storage[offset] = value & 0xff;
}

function readPrimitive(base, offset, size, getter) {
  const bytes = new Uint8Array(size);
  const start = numberOffset(offset);
  for (let i = 0; i < size; i++) {
    bytes[i] = readStorageByte(base, start + i);
  }
  return new DataView(bytes.buffer)[getter](0, nativeLittleEndian);
}

function writePrimitive(base, offset, size, setter, value) {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer)[setter](0, value, nativeLittleEndian);
  const start = numberOffset(offset);
  for (let i = 0; i < size; i++) {
    writeStorageByte(base, start + i, bytes[i]);
  }
}

function fieldOffset(field) {
  const offset = nextOffset++;
  offsets.set(offset, {
    data: field._fieldData,
    declaringClass: field._declaringClass,
  });
  return offset;
}

function offsetField(offset) {
  const field = offsets.get(typeof offset === 'bigint' ? offset : BigInt(offset));
  if (!field) throw new Error(`Unknown Unsafe field offset ${offset}`);
  return field;
}

function fieldCandidates(field) {
  const { name, descriptor } = field.data;
  const declaringClass = field.declaringClass && field.declaringClass._classData &&
    field.declaringClass._classData.ast.classes[0].className;
  return [
    name,
    `${name}:${descriptor}`,
    `${declaringClass}.${name}`,
    `${declaringClass}.${name}:${descriptor}`,
  ];
}

function readField(base, offset) {
  const field = offsetField(offset);
  const candidates = fieldCandidates(field);
  const staticFields = base && base._classData && base._classData.staticFields;
  if (staticFields instanceof Map) {
    for (const key of candidates) {
      if (staticFields.has(key)) return staticFields.get(key);
    }
  }
  for (const key of candidates) {
    if (base && Object.prototype.hasOwnProperty.call(base, key)) return base[key];
    if (base && base.fields && Object.prototype.hasOwnProperty.call(base.fields, key)) {
      return base.fields[key];
    }
  }
  if (base && base.fields) {
    const suffix = `.${field.data.name}`;
    const descriptorSuffix = `${suffix}:${field.data.descriptor}`;
    const key = Object.keys(base.fields).find((candidate) =>
      candidate.endsWith(suffix) || candidate.endsWith(descriptorSuffix));
    if (key !== undefined) return base.fields[key];
  }
  return undefined;
}

function writeField(base, offset, value) {
  const field = offsetField(offset);
  const candidates = fieldCandidates(field);
  const staticFields = base && base._classData && base._classData.staticFields;
  if (staticFields instanceof Map) {
    const key = candidates.find((candidate) => staticFields.has(candidate)) || candidates[1];
    staticFields.set(key, value);
    return;
  }
  for (const key of candidates) {
    if (base && Object.prototype.hasOwnProperty.call(base, key)) {
      base[key] = value;
      return;
    }
    if (base && base.fields && Object.prototype.hasOwnProperty.call(base.fields, key)) {
      base.fields[key] = value;
      return;
    }
  }
  if (base && base.fields) {
    const suffix = `.${field.data.name}`;
    const descriptorSuffix = `${suffix}:${field.data.descriptor}`;
    const key = Object.keys(base.fields).find((candidate) =>
      candidate.endsWith(suffix) || candidate.endsWith(descriptorSuffix));
    base.fields[key === undefined ? candidates[2] : key] = value;
    return;
  }
  base[field.data.name] = value;
}

const primitiveMethods = {
  'getByte(Ljava/lang/Object;J)B': (jvm, obj, args) =>
    readPrimitive(args[0], args[1], 1, 'getInt8'),
  'getByteVolatile(Ljava/lang/Object;J)B': (jvm, obj, args) =>
    readPrimitive(args[0], args[1], 1, 'getInt8'),
  'putByte(Ljava/lang/Object;JB)V': (jvm, obj, args) =>
    writePrimitive(args[0], args[1], 1, 'setInt8', args[2]),
  'putByteVolatile(Ljava/lang/Object;JB)V': (jvm, obj, args) =>
    writePrimitive(args[0], args[1], 1, 'setInt8', args[2]),
  'getChar(Ljava/lang/Object;J)C': (jvm, obj, args) =>
    readPrimitive(args[0], args[1], 2, 'getUint16'),
  'getCharVolatile(Ljava/lang/Object;J)C': (jvm, obj, args) =>
    readPrimitive(args[0], args[1], 2, 'getUint16'),
  'putChar(Ljava/lang/Object;JC)V': (jvm, obj, args) =>
    writePrimitive(args[0], args[1], 2, 'setUint16', args[2]),
  'putCharVolatile(Ljava/lang/Object;JC)V': (jvm, obj, args) =>
    writePrimitive(args[0], args[1], 2, 'setUint16', args[2]),
  'getShort(Ljava/lang/Object;J)S': (jvm, obj, args) =>
    readPrimitive(args[0], args[1], 2, 'getInt16'),
  'getShortVolatile(Ljava/lang/Object;J)S': (jvm, obj, args) =>
    readPrimitive(args[0], args[1], 2, 'getInt16'),
  'putShort(Ljava/lang/Object;JS)V': (jvm, obj, args) =>
    writePrimitive(args[0], args[1], 2, 'setInt16', args[2]),
  'putShortVolatile(Ljava/lang/Object;JS)V': (jvm, obj, args) =>
    writePrimitive(args[0], args[1], 2, 'setInt16', args[2]),
  'getInt(Ljava/lang/Object;J)I': (jvm, obj, args) => {
    if (offsets.has(args[1])) return Number(readField(args[0], args[1]));
    return readPrimitive(args[0], args[1], 4, 'getInt32');
  },
  'getInt(Ljava/lang/Object;I)I': (jvm, obj, args) => {
    if (offsets.has(BigInt(args[1]))) return Number(readField(args[0], args[1]));
    return readPrimitive(args[0], args[1], 4, 'getInt32');
  },
  'getIntVolatile(Ljava/lang/Object;J)I': (jvm, obj, args) =>
    readPrimitive(args[0], args[1], 4, 'getInt32'),
  'putInt(Ljava/lang/Object;JI)V': (jvm, obj, args) =>
    writePrimitive(args[0], args[1], 4, 'setInt32', args[2]),
  'putIntVolatile(Ljava/lang/Object;JI)V': (jvm, obj, args) =>
    writePrimitive(args[0], args[1], 4, 'setInt32', args[2]),
  'getLong(Ljava/lang/Object;J)J': (jvm, obj, args) =>
    readPrimitive(args[0], args[1], 8, 'getBigInt64'),
  'getLong(Ljava/lang/Object;I)J': (jvm, obj, args) =>
    readPrimitive(args[0], args[1], 8, 'getBigInt64'),
  'getLongVolatile(Ljava/lang/Object;J)J': (jvm, obj, args) =>
    readPrimitive(args[0], args[1], 8, 'getBigInt64'),
  'putLong(Ljava/lang/Object;JJ)V': (jvm, obj, args) =>
    writePrimitive(args[0], args[1], 8, 'setBigInt64', args[2]),
  'putLong(Ljava/lang/Object;IJ)V': (jvm, obj, args) =>
    writePrimitive(args[0], args[1], 8, 'setBigInt64', args[2]),
  'putLongVolatile(Ljava/lang/Object;JJ)V': (jvm, obj, args) =>
    writePrimitive(args[0], args[1], 8, 'setBigInt64', args[2]),
};

module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'theUnsafe:Lsun/misc/Unsafe;': unsafe,
    'ARRAY_BYTE_BASE_OFFSET:I': 0,
    'ARRAY_OBJECT_BASE_OFFSET:I': 0,
  },
  staticMethods: {
    'getUnsafe()Lsun/misc/Unsafe;': () => unsafe,
  },
  methods: {
    ...primitiveMethods,
    'arrayBaseOffset(Ljava/lang/Class;)I': () => 0,
    'arrayIndexScale(Ljava/lang/Class;)I': () => 1,
    'pageSize()I': () => 4096,
    'objectFieldOffset(Ljava/lang/reflect/Field;)J': (jvm, obj, args) =>
      fieldOffset(args[0]),
    'staticFieldOffset(Ljava/lang/reflect/Field;)J': (jvm, obj, args) =>
      fieldOffset(args[0]),
    'staticFieldBase(Ljava/lang/reflect/Field;)Ljava/lang/Object;': (jvm, obj, args) =>
      args[0]._declaringClass,
    'getObject(Ljava/lang/Object;J)Ljava/lang/Object;': (jvm, obj, args) =>
      readField(args[0], args[1]),
    'getObject(Ljava/lang/Object;I)Ljava/lang/Object;': (jvm, obj, args) =>
      readField(args[0], args[1]),
    'putObject(Ljava/lang/Object;JLjava/lang/Object;)V': (jvm, obj, args) =>
      writeField(args[0], args[1], args[2]),
    'putObject(Ljava/lang/Object;ILjava/lang/Object;)V': (jvm, obj, args) =>
      writeField(args[0], args[1], args[2]),
  },
};
