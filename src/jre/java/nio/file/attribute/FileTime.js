function millis(value) {
  return typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
}

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/lang/Comparable'],
  staticMethods: {
    'fromMillis(J)Ljava/nio/file/attribute/FileTime;': (jvm, obj, args) => ({
      type: 'java/nio/file/attribute/FileTime',
      millis: millis(args[0]),
    }),
  },
  methods: {
    'toMillis()J': (jvm, obj) => obj.millis,
    'compareTo(Ljava/nio/file/attribute/FileTime;)I': (jvm, obj, args) =>
      obj.millis < args[0].millis ? -1 : (obj.millis > args[0].millis ? 1 : 0),
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) =>
      args[0] && args[0].millis !== undefined && obj.millis === args[0].millis ? 1 : 0,
    'hashCode()I': (jvm, obj) => Number(BigInt.asIntN(32, obj.millis ^ (obj.millis >> 32n))),
    'toString()Ljava/lang/String;': (jvm, obj) =>
      jvm.internString(new Date(Number(obj.millis)).toISOString()),
  },
};
