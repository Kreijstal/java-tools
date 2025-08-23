const crc32 = require('crc-32');

module.exports = {
  'java/util/zip/CRC32': {
    '<init>()V': (thread, locals) => {
      const self = locals[0];
      self['java/util/zip/CRC32/crc'] = 0;
      thread.return();
    },
    'reset()V': (thread, locals) => {
      const self = locals[0];
      self['java/util/zip/CRC32/crc'] = 0;
      thread.return();
    },
    'update([BII)V': (thread, locals) => {
      const self = locals[0];
      const b = locals[1].array;
      const off = locals[2];
      const len = locals[3];
      const slicedB = b.slice(off, off + len);
      let crc = self['java/util/zip/CRC32/crc'];
      crc = crc32.buf(slicedB, crc);
      self['java/util/zip/CRC32/crc'] = crc;
      thread.return();
    },
    'getValue()J': (thread, locals) => {
      const self = locals[0];
      const crc = self['java/util/zip/CRC32/crc'];
      thread.pushStackLong(BigInt(crc >>> 0));
    },
  },
};
