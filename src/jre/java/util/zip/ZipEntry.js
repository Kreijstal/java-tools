function javaString(value) {
  if (value === null || value === undefined) return '';
  if (value && value.type === 'java/lang/String' && Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
  return String(value);
}

module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.name = javaString(args[0]);
      obj.size = BigInt(-1);
      obj.directory = obj.name.endsWith('/');
      obj.zipObject = null;
    },
    'getName()Ljava/lang/String;': (jvm, obj) => jvm.internString(obj.name || ''),
    'getSize()J': (jvm, obj) => BigInt(obj.size === undefined ? -1 : obj.size),
    'isDirectory()Z': (jvm, obj) => (obj.directory ? 1 : 0),
    'toString()Ljava/lang/String;': (jvm, obj) => jvm.internString(obj.name || ''),
  },
};
