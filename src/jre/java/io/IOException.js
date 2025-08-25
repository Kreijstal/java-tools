module.exports = {
  super: 'java/lang/Exception',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.message = null;
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.message = args[0];
    },
    'getMessage()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.message;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const message = obj.message;
      const className = obj.type.replace(/\//g, '.');
      if (message) {
        return jvm.internString(`${className}: ${String(message)}`);
      } else {
        return jvm.internString(className);
      }
    },
    'printStackTrace()V': (jvm, obj, args) => {
      // Print stack trace to System.err
      const toStringMethod = jvm._jreFindMethod(obj.type, 'toString', '()Ljava/lang/String;');
      let errorStr = obj.type.replace(/\//g, '.');
      if (toStringMethod) {
        const result = toStringMethod(jvm, obj, []);
        if (result && result.value) {
          errorStr = result.value;
        }
      }
      
      // Find System.err
      const systemClass = jvm.jre['java/lang/System'];
      if (systemClass && systemClass.staticFields) {
        const err = systemClass.staticFields.get('err:Ljava/io/PrintStream;');
        if (err) {
          const printlnMethod = jvm._jreFindMethod(err.type, 'println', '(Ljava/lang/String;)V');
          if (printlnMethod) {
            printlnMethod(jvm, err, [jvm.internString(errorStr)]);
          }
        }
      }
    },
  },
};