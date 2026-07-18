function stringValue(value) {
  if (value === null || value === undefined) return 'null';
  if (value && Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
  return String(value);
}

function append(value) {
  return (jvm, obj, args) => {
    obj.value = String(obj.value || '') + value(args[0]);
    return obj;
  };
}

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/lang/CharSequence'],
  methods: {
    '<init>()V': (jvm, obj) => { obj.value = ''; },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => { obj.value = stringValue(args[0]); },
    'append(Ljava/lang/String;)Ljava/lang/StringBuffer;': append(stringValue),
    'append(Ljava/lang/Object;)Ljava/lang/StringBuffer;': append(stringValue),
    'append(C)Ljava/lang/StringBuffer;': append((value) => String.fromCharCode(value)),
    'append(Z)Ljava/lang/StringBuffer;': append((value) => value ? 'true' : 'false'),
    'append(I)Ljava/lang/StringBuffer;': append(String),
    'append(J)Ljava/lang/StringBuffer;': append(String),
    'append(F)Ljava/lang/StringBuffer;': append(String),
    'append(D)Ljava/lang/StringBuffer;': append(String),
    'toString()Ljava/lang/String;': (jvm, obj) => jvm.newString(String(obj.value || '')),
    'length()I': (jvm, obj) => String(obj.value || '').length,
  },
};
