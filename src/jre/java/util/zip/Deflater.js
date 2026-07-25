const zlib = require('zlib');
const { withThrows } = require('../../../helpers');

const PREFIX = 'java/util/zip/Deflater/';

function byteArray(value, message) {
  if (value && value.array) return value.array;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value;
  throw { type: 'java/lang/IllegalArgumentException', message };
}

function initialize(obj, level, nowrap) {
  obj[`${PREFIX}level`] = level;
  obj[`${PREFIX}nowrap`] = Boolean(nowrap);
  obj[`${PREFIX}input`] = Buffer.alloc(0);
  obj[`${PREFIX}compressed`] = null;
  obj[`${PREFIX}outputOffset`] = 0;
  obj[`${PREFIX}finishRequested`] = false;
  obj[`${PREFIX}ended`] = false;
  obj[`${PREFIX}totalIn`] = 0;
}

function ensureOpen(obj) {
  if (obj[`${PREFIX}ended`]) {
    throw { type: 'java/lang/IllegalStateException', message: 'Deflater has been ended' };
  }
}

function compressedBytes(obj) {
  if (obj[`${PREFIX}compressed`]) return obj[`${PREFIX}compressed`];
  const options = {};
  const level = obj[`${PREFIX}level`];
  if (level >= -1 && level <= 9) options.level = level;
  obj[`${PREFIX}compressed`] = obj[`${PREFIX}nowrap`]
    ? zlib.deflateRawSync(obj[`${PREFIX}input`], options)
    : zlib.deflateSync(obj[`${PREFIX}input`], options);
  return obj[`${PREFIX}compressed`];
}

module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'DEFAULT_COMPRESSION:I': -1,
    'NO_COMPRESSION:I': 0,
    'BEST_SPEED:I': 1,
    'BEST_COMPRESSION:I': 9,
  },
  methods: {
    '<init>()V': (jvm, obj) => initialize(obj, -1, false),
    '<init>(I)V': (jvm, obj, args) => initialize(obj, args[0], false),
    '<init>(IZ)V': (jvm, obj, args) => initialize(obj, args[0], args[1]),
    'setInput([B)V': withThrows((jvm, obj, args) => {
      const source = byteArray(args[0], 'Invalid byte array format');
      ensureOpen(obj);
      const chunk = Buffer.from(source);
      obj[`${PREFIX}input`] = Buffer.concat([obj[`${PREFIX}input`], chunk]);
      obj[`${PREFIX}totalIn`] += chunk.length;
      obj[`${PREFIX}compressed`] = null;
      obj[`${PREFIX}outputOffset`] = 0;
    }, ['java/lang/IllegalArgumentException', 'java/lang/IllegalStateException']),
    'setInput([BII)V': withThrows((jvm, obj, args) => {
      const source = byteArray(args[0], 'Invalid byte array format');
      const offset = args[1] | 0;
      const length = args[2] | 0;
      if (offset < 0 || length < 0 || offset + length > source.length) {
        throw { type: 'java/lang/ArrayIndexOutOfBoundsException', message: 'Invalid input range' };
      }
      ensureOpen(obj);
      const chunk = Buffer.from(source.slice(offset, offset + length));
      obj[`${PREFIX}input`] = Buffer.concat([obj[`${PREFIX}input`], chunk]);
      obj[`${PREFIX}totalIn`] += chunk.length;
      obj[`${PREFIX}compressed`] = null;
      obj[`${PREFIX}outputOffset`] = 0;
    }, ['java/lang/IllegalArgumentException', 'java/lang/ArrayIndexOutOfBoundsException', 'java/lang/IllegalStateException']),
    'finish()V': (jvm, obj) => {
      ensureOpen(obj);
      obj[`${PREFIX}finishRequested`] = true;
    },
    'finished()Z': (jvm, obj) => {
      if (!obj[`${PREFIX}finishRequested`] || !obj[`${PREFIX}compressed`]) return 0;
      return obj[`${PREFIX}outputOffset`] >= obj[`${PREFIX}compressed`].length ? 1 : 0;
    },
    'needsInput()Z': (jvm, obj) => obj[`${PREFIX}input`].length === 0 ? 1 : 0,
    'deflate([B)I': withThrows((jvm, obj, args) => {
      const target = byteArray(args[0], 'Invalid output byte array format');
      return module.exports.methods['deflate([BII)I'](jvm, obj, [args[0], 0, target.length]);
    }, ['java/lang/IllegalArgumentException', 'java/lang/IllegalStateException']),
    'deflate([BII)I': withThrows((jvm, obj, args) => {
      const target = byteArray(args[0], 'Invalid output byte array format');
      const offset = args[1] | 0;
      const length = args[2] | 0;
      if (offset < 0 || length < 0 || offset + length > target.length) {
        throw { type: 'java/lang/ArrayIndexOutOfBoundsException', message: 'Invalid output range' };
      }
      ensureOpen(obj);
      const compressed = compressedBytes(obj);
      const start = obj[`${PREFIX}outputOffset`];
      const count = Math.min(length, compressed.length - start);
      for (let index = 0; index < count; index += 1) target[offset + index] = compressed[start + index];
      obj[`${PREFIX}outputOffset`] += count;
      return count;
    }, ['java/lang/IllegalArgumentException', 'java/lang/ArrayIndexOutOfBoundsException', 'java/lang/IllegalStateException']),
    'getTotalIn()I': (jvm, obj) => obj[`${PREFIX}totalIn`] | 0,
    'reset()V': (jvm, obj) => {
      ensureOpen(obj);
      initialize(obj, obj[`${PREFIX}level`], obj[`${PREFIX}nowrap`]);
    },
    'end()V': (jvm, obj) => {
      obj[`${PREFIX}ended`] = true;
      obj[`${PREFIX}input`] = Buffer.alloc(0);
      obj[`${PREFIX}compressed`] = null;
    },
  },
};
