const { withThrows } = require('../../helpers');

module.exports = {
  super: "java/io/Reader",
  staticFields: {},
  methods: {
    "<init>(Ljava/io/Reader;)V": (jvm, obj, args) => {
      obj.reader = args[0];
      return obj;
    },
    "readLine()Ljava/lang/String;": withThrows((jvm, obj, args) => {
      const reader = obj.reader;
      if (!reader) {
        jvm.throwException('java/io/IOException', 'Stream closed');
        return;
      }

      const readMethod = jvm._jreFindMethod(reader.type, 'read', '()I');
      if (!readMethod) {
        jvm.throwException('java/io/IOException', 'Read method not found on reader');
        return;
      }

      let line = "";
      let charCode;

      while ((charCode = readMethod(jvm, reader, [])) !== -1) {
        const char = String.fromCharCode(charCode);
        if (char === '\n') {
          break;
        }
        if (char !== '\r') {
          line += char;
        }
      }

      if (line === "" && charCode === -1) {
        return null;
      }

      return jvm.internString(line);
    }, ['java/io/IOException']),
    "close()V": (jvm, obj, args) => {
      const reader = obj.reader;
      if (reader) {
        const closeMethod = jvm._jreFindMethod(reader.type, 'close', '()V');
        if (closeMethod) {
          closeMethod(jvm, reader, []);
        }
        obj.reader = null;
      }
    },
  },
};
