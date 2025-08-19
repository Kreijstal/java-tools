module.exports = {
  super: 'java/io/FilterOutputStream',
  interfaces: ['java/lang/Appendable'],
  methods: {
    '<init>(Ljava/io/OutputStream;)V': (jvm, obj, args) => {
      const out = args[0];
      const superClass = jvm.jre[obj.type].super;
      const superInit = jvm._jreFindMethod(superClass, '<init>', '(Ljava/io/OutputStream;)V');
      if (superInit) {
        superInit(jvm, obj, [out]);
      }
    },

    'println(D)V': (jvm, obj, args) => {
      const output = String(args[0]) + '\n';
      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeByteMethod) {
        for (let i = 0; i < output.length; i++) {
          writeByteMethod(jvm, obj, [output.charCodeAt(i)]);
        }
      }
    },

    'println(F)V': (jvm, obj, args) => {
      const output = String(args[0]) + '\n';
      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeByteMethod) {
        for (let i = 0; i < output.length; i++) {
          writeByteMethod(jvm, obj, [output.charCodeAt(i)]);
        }
      }
    },

    'println(J)V': (jvm, obj, args) => {
      const output = String(args[0]) + '\n';
      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeByteMethod) {
        for (let i = 0; i < output.length; i++) {
          writeByteMethod(jvm, obj, [output.charCodeAt(i)]);
        }
      }
    },

    'write(I)V': (jvm, obj, args) => {
      // Delegate to the superclass (FilterOutputStream)
      const superClass = jvm.jre[obj.type].super;
      const superWrite = jvm._jreFindMethod(superClass, 'write', '(I)V');
      if (superWrite) {
        superWrite(jvm, obj, args);
      }
    },

    'println(Ljava/lang/String;)V': (jvm, obj, args) => {
      const str = args[0];
      const toPrint = (str === null ? "null" : String(str)) + '\n';
      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeByteMethod) {
        for (let i = 0; i < toPrint.length; i++) {
          writeByteMethod(jvm, obj, [toPrint.charCodeAt(i)]);
        }
      }
    },

    'println(I)V': (jvm, obj, args) => {
      const output = String(args[0]) + '\n';
      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeByteMethod) {
        for (let i = 0; i < output.length; i++) {
          writeByteMethod(jvm, obj, [output.charCodeAt(i)]);
        }
      }
    },

    'println([C)V': (jvm, obj, args) => {
      const chars = args[0];
      if (chars === null) {
        const printlnStr = jvm._jreFindMethod(obj.type, 'println', '(Ljava/lang/String;)V');
        if (printlnStr) {
          printlnStr(jvm, obj, [null]);
        }
        return;
      }
      const output = String.fromCharCode.apply(null, chars) + '\n';
      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeByteMethod) {
        for (let i = 0; i < output.length; i++) {
          writeByteMethod(jvm, obj, [output.charCodeAt(i)]);
        }
      }
    },

    'println(Ljava/lang/Object;)V': (jvm, obj, args) => {
      const val = args[0];
      const str = (val === null) ? "null" : val.toString();
      const output = str + '\n';
      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeByteMethod) {
        for (let i = 0; i < output.length; i++) {
          writeByteMethod(jvm, obj, [output.charCodeAt(i)]);
        }
      }
    },

    'println()V': (jvm, obj, args) => {
      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeByteMethod) {
        writeByteMethod(jvm, obj, ['\n'.charCodeAt(0)]);
      }
    },

    'println(Z)V': (jvm, obj, args) => {
      const output = (args[0] === 1 ? 'true' : 'false') + '\n';
      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeByteMethod) {
        for (let i = 0; i < output.length; i++) {
          writeByteMethod(jvm, obj, [output.charCodeAt(i)]);
        }
      }
    },

    'print(Ljava/lang/String;)V': (jvm, obj, args) => {
      const message = args[0];
      if (message !== null) {
        const toPrint = String(message);
        const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
        if (writeByteMethod) {
          for (let i = 0; i < toPrint.length; i++) {
            writeByteMethod(jvm, obj, [toPrint.charCodeAt(i)]);
          }
        }
      }
    },

    'append(C)Ljava/lang/Appendable;': (jvm, obj, args) => {
      const charCode = args[0];
      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeByteMethod) {
        writeByteMethod(jvm, obj, [charCode]);
      }
      return obj;
    },

    'append(Ljava/lang/CharSequence;)Ljava/lang/Appendable;': (jvm, obj, args) => {
      const csq = args[0];
      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');
      if (writeByteMethod) {
        if (csq === null) {
          const nullStr = "null";
          for (let i = 0; i < nullStr.length; i++) {
            writeByteMethod(jvm, obj, [nullStr.charCodeAt(i)]);
          }
        } else {
          const str = csq.toString();
          for (let i = 0; i < str.length; i++) {
            writeByteMethod(jvm, obj, [str.charCodeAt(i)]);
          }
        }
      }
      return obj;
    },

    'append(Ljava/lang/CharSequence;II)Ljava/lang/Appendable;': (jvm, obj, args) => {
      const csq = args[0];
      const start = args[1];
      const end = args[2];
      const writeByteMethod = jvm._jreFindMethod(obj.type, 'write', '(I)V');

      if (writeByteMethod) {
        if (csq === null) {
          const nullStr = "null".substring(start, end);
          for (let i = 0; i < nullStr.length; i++) {
            writeByteMethod(jvm, obj, [nullStr.charCodeAt(i)]);
          }
        } else {
          const str = csq.toString().substring(start, end);
          for (let i = 0; i < str.length; i++) {
            writeByteMethod(jvm, obj, [str.charCodeAt(i)]);
          }
        }
      }
      return obj;
    },
  },
};
