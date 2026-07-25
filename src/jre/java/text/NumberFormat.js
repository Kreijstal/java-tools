function formatNumber(jvm, obj, value) {
  const numeric = Number(value);
  const formatted = Number.isInteger(obj.fractionDigits)
    ? numeric.toFixed(obj.fractionDigits)
    : String(numeric);
  return jvm.internString(formatted);
}

function text(value) {
  return value && Object.prototype.hasOwnProperty.call(value, 'value') ? String(value.value) : String(value || '');
}

module.exports = {
  super: 'java/text/Format',
  staticFields: {},
  staticMethods: {
    'getInstance()Ljava/text/NumberFormat;': () => ({ type: 'java/text/NumberFormat' }),
    'getInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;': () => ({ type: 'java/text/NumberFormat' }),
    'getNumberInstance()Ljava/text/NumberFormat;': () => ({ type: 'java/text/NumberFormat' }),
    'getIntegerInstance()Ljava/text/NumberFormat;': () => ({ type: 'java/text/NumberFormat', fractionDigits: 0 }),
  },
  methods: {
    '<init>()V': () => {},
    'format(D)Ljava/lang/String;': (jvm, obj, args) => formatNumber(jvm, obj, args[0]),
    'format(J)Ljava/lang/String;': (jvm, obj, args) => formatNumber(jvm, obj, args[0]),
    'parse(Ljava/lang/String;Ljava/text/ParsePosition;)Ljava/lang/Number;': (jvm, obj, args) => {
      const source = text(args[0]);
      const position = args[1];
      const start = position && Number.isInteger(position.index) ? position.index : 0;
      const match = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(start));
      if (!match) {
        if (position) position.errorIndex = start;
        return null;
      }
      if (position) position.index = start + match[0].length;
      const number = Number(match[0]);
      if (Number.isInteger(number) && Number.isSafeInteger(number)) {
        return { type: 'java/lang/Long', value: BigInt(number) };
      }
      return { type: 'java/lang/Double', value: number };
    },
    'setGroupingUsed(Z)V': (jvm, obj, args) => { obj.groupingUsed = args[0] !== 0; },
    'setMaximumFractionDigits(I)V': (jvm, obj, args) => { obj.fractionDigits = args[0]; },
    'setMinimumFractionDigits(I)V': (jvm, obj, args) => { obj.fractionDigits = args[0]; },
  },
};
