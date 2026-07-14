function formatNumber(jvm, obj, value) {
  const numeric = Number(value);
  const formatted = Number.isInteger(obj.fractionDigits)
    ? numeric.toFixed(obj.fractionDigits)
    : String(numeric);
  return jvm.internString(formatted);
}

module.exports = {
  super: 'java/text/Format',
  staticFields: {},
  staticMethods: {
    'getInstance()Ljava/text/NumberFormat;': () => ({ type: 'java/text/NumberFormat' }),
    'getNumberInstance()Ljava/text/NumberFormat;': () => ({ type: 'java/text/NumberFormat' }),
    'getIntegerInstance()Ljava/text/NumberFormat;': () => ({ type: 'java/text/NumberFormat', fractionDigits: 0 }),
  },
  methods: {
    '<init>()V': () => {},
    'format(D)Ljava/lang/String;': (jvm, obj, args) => formatNumber(jvm, obj, args[0]),
    'format(J)Ljava/lang/String;': (jvm, obj, args) => formatNumber(jvm, obj, args[0]),
    'setMaximumFractionDigits(I)V': (jvm, obj, args) => { obj.fractionDigits = args[0]; },
    'setMinimumFractionDigits(I)V': (jvm, obj, args) => { obj.fractionDigits = args[0]; },
  },
};
