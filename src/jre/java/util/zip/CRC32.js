const table = (function () {
  let c;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    table[n] = c;
  }
  return table;
})();

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/util/zip/Checksum'],
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.crc = -1;
    },

    'reset()V': (jvm, obj, args) => {
      obj.crc = -1;
    },

    'update(I)V': (jvm, obj, args) => {
      const b = args[0];
      obj.crc = (obj.crc >>> 8) ^ table[(obj.crc ^ (b & 0xFF)) & 0xFF];
    },

    'update([BII)V': (jvm, obj, args) => {
      const b = args[0];
      const off = args[1];
      const len = args[2];

      let crc = obj.crc;
      for (let i = off; i < off + len; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ (b[i] & 0xFF)) & 0xFF];
      }
      obj.crc = crc;
    },

    'getValue()J': (jvm, obj, args) => {
      return BigInt((obj.crc ^ -1) >>> 0);
    },
  },
};
