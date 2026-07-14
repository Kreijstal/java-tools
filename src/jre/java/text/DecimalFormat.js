function patternText(pattern) {
  if (pattern && Object.prototype.hasOwnProperty.call(pattern, 'value')) return String(pattern.value);
  return String(pattern);
}

function fractionDigits(pattern) {
  const dot = pattern.indexOf('.');
  if (dot < 0) return 0;
  let count = 0;
  for (let index = dot + 1; index < pattern.length; index += 1) {
    if (pattern[index] !== '0' && pattern[index] !== '#') break;
    count += 1;
  }
  return count;
}

module.exports = {
  super: 'java/text/NumberFormat',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj) => { obj.pattern = ''; },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.pattern = patternText(args[0]);
      obj.fractionDigits = fractionDigits(obj.pattern);
    },
    'format(D)Ljava/lang/String;': (jvm, obj, args) => jvm.internString(Number(args[0]).toFixed(obj.fractionDigits || 0)),
    'format(J)Ljava/lang/String;': (jvm, obj, args) => jvm.internString(Number(args[0]).toFixed(obj.fractionDigits || 0)),
    'applyPattern(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.pattern = patternText(args[0]);
      obj.fractionDigits = fractionDigits(obj.pattern);
    },
  },
};
