function dateValue(value) {
  if (value && value._date instanceof Date) return value._date;
  if (value && Object.prototype.hasOwnProperty.call(value, 'time')) return new Date(Number(value.time));
  return new Date(0);
}

module.exports = {
  super: 'java/text/Format',
  staticFields: {
    'FULL:I': 0,
    'LONG:I': 1,
    'MEDIUM:I': 2,
    'SHORT:I': 3,
    'DEFAULT:I': 2,
  },
  staticMethods: {
    'getDateTimeInstance()Ljava/text/DateFormat;': () => ({ type: 'java/text/DateFormat', dateStyle: 2, timeStyle: 2 }),
    'getDateTimeInstance(II)Ljava/text/DateFormat;': (jvm, obj, args) => ({
      type: 'java/text/DateFormat',
      dateStyle: args[0],
      timeStyle: args[1],
    }),
    'getDateInstance()Ljava/text/DateFormat;': () => ({ type: 'java/text/DateFormat', dateStyle: 2 }),
    'getDateInstance(I)Ljava/text/DateFormat;': (jvm, obj, args) => ({ type: 'java/text/DateFormat', dateStyle: args[0] }),
    'getTimeInstance()Ljava/text/DateFormat;': () => ({ type: 'java/text/DateFormat', timeStyle: 2 }),
    'getTimeInstance(I)Ljava/text/DateFormat;': (jvm, obj, args) => ({ type: 'java/text/DateFormat', timeStyle: args[0] }),
  },
  methods: {
    'format(Ljava/util/Date;)Ljava/lang/String;': (jvm, obj, args) => {
      const date = dateValue(args[0]);
      const formatted = obj.dateStyle === undefined
        ? date.toLocaleTimeString()
        : obj.timeStyle === undefined
          ? date.toLocaleDateString()
          : date.toLocaleString();
      return jvm.internString(formatted);
    },
  },
};
