module.exports = {
  super: 'java/lang/RuntimeException',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.message = null;
      obj.cause = null;
      obj.suppressedExceptions = [];
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.message = args[0];
      obj.cause = null;
      obj.suppressedExceptions = [];
    },
    'getMessage()Ljava/lang/String;': (jvm, obj, args) => {
      if (obj.message) {
        return obj.message;
      }

      if (obj.context) {
        const { frame, pc, className, methodName } = obj.context;
        let message = `Cannot invoke "${className.substring(
          className.lastIndexOf("/") + 1,
        )}.${methodName}()" because the object reference is null`;

        const getPcFromItem = (item) => {
          if (!item || !item.labelDef) return -1;
          return parseInt(item.labelDef.substring(1, item.labelDef.length - 1));
        };

        const currentInstructionIndex = frame.instructions.findIndex(item => getPcFromItem(item) === pc);

        if (currentInstructionIndex > 0) {
          const prevInstruction = frame.instructions[currentInstructionIndex - 1].instruction;
          if (prevInstruction) {
            const op = prevInstruction.op;
            if (op === 'aload') {
              const index = prevInstruction.arg;
              message = `Cannot invoke "${className.substring(
                className.lastIndexOf("/") + 1,
              )}.${methodName}()" because "<local${index}>" is null`;
            } else if (op === 'aload_0') {
              message = `Cannot invoke "${className.substring(
                className.lastIndexOf("/") + 1,
              )}.${methodName}()" because "<local0>" is null`;
            } else if (op === 'aload_1') {
              message = `Cannot invoke "${className.substring(
                className.lastIndexOf("/") + 1,
              )}.${methodName}()" because "<local1>" is null`;
            } else if (op === 'aload_2') {
              message = `Cannot invoke "${className.substring(
                className.lastIndexOf("/") + 1,
              )}.${methodName}()" because "<local2>" is null`;
            } else if (op === 'aload_3') {
              message = `Cannot invoke "${className.substring(
                className.lastIndexOf("/") + 1,
              )}.${methodName}()" because "<local3>" is null`;
            }
          }
        }
        obj.message = jvm.internString(message);
        return obj.message;
      }

      return null;
    },
    'getClass()Ljava/lang/Class;': (jvm, obj, args) => {
      // Return a Class object representing NullPointerException
      return {
        type: 'java/lang/Class',
        className: 'java.lang.NullPointerException',
        getSimpleName: function() {
          return jvm.internString('NullPointerException');
        }
      };
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const getMessage = jvm._jreFindMethod(obj.type, 'getMessage', '()Ljava/lang/String;');
      const message = getMessage(jvm, obj, []);
      const className = 'java.lang.NullPointerException';
      if (message && message.value) {
        return jvm.internString(`${className}: ${message.value}`);
      } else {
        return jvm.internString(className);
      }
    },
  },
};