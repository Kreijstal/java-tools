const BIG_ENDIAN = {
  type: 'java/nio/ByteOrder',
  name: 'BIG_ENDIAN',
};

const LITTLE_ENDIAN = {
  type: 'java/nio/ByteOrder',
  name: 'LITTLE_ENDIAN',
};

function nativeByteOrder() {
  const bytes = new Uint8Array(2);
  new Uint16Array(bytes.buffer)[0] = 0x0102;
  return bytes[0] === 0x02 ? LITTLE_ENDIAN : BIG_ENDIAN;
}

module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'BIG_ENDIAN:Ljava/nio/ByteOrder;': BIG_ENDIAN,
    'LITTLE_ENDIAN:Ljava/nio/ByteOrder;': LITTLE_ENDIAN,
  },
  staticMethods: {
    'nativeOrder()Ljava/nio/ByteOrder;': () => nativeByteOrder(),
  },
  methods: {
    'toString()Ljava/lang/String;': (jvm, obj) =>
      jvm.internString(obj && obj.name ? obj.name : 'UNKNOWN'),
  },
};
