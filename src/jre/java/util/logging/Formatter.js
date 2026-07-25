module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': () => {},
    'format(Ljava/util/logging/LogRecord;)Ljava/lang/String;': (jvm, obj, args) => {
      const record = args[0];
      return record && record.message ? record.message : jvm.internString('');
    },
  },
};
