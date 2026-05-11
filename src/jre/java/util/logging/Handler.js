module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.formatter = null;
      obj.level = null;
    },
    'setFormatter(Ljava/util/logging/Formatter;)V': (jvm, obj, args) => { obj.formatter = args[0]; },
    'getFormatter()Ljava/util/logging/Formatter;': (jvm, obj) => obj.formatter || null,
    'setLevel(Ljava/util/logging/Level;)V': (jvm, obj, args) => { obj.level = args[0]; },
    'getLevel()Ljava/util/logging/Level;': (jvm, obj) => obj.level || null,
    'publish(Ljava/util/logging/LogRecord;)V': () => {},
    'flush()V': () => {},
    'close()V': () => {},
  },
};
