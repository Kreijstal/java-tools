function text(value) {
  return value && Object.prototype.hasOwnProperty.call(value, 'value')
    ? String(value.value)
    : String(value || '');
}

function parseDate(value, pattern) {
  const source = text(value);
  if (/^d{1,2}\.M{1,2}\.y{2,4}$/.test(pattern || '')) {
    const match = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(source);
    if (match) {
      let year = Number(match[3]);
      if (year < 100) year += year >= 70 ? 1900 : 2000;
      return new Date(year, Number(match[2]) - 1, Number(match[1]));
    }
  }
  const millis = Date.parse(source);
  return Number.isNaN(millis) ? null : new Date(millis);
}

module.exports = {
  super: 'java/text/DateFormat',
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.pattern = text(args[0]);
    },
    'parse(Ljava/lang/String;)Ljava/util/Date;': (jvm, obj, args) => {
      const parsed = parseDate(args[0], obj.pattern);
      if (!parsed) throw { type: 'java/text/ParseException' };
      return {
        type: 'java/util/Date',
        _date: parsed,
        time: BigInt(parsed.getTime()),
      };
    },
  },
};
