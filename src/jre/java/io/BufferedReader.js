module.exports = {
  super: "java/io/Reader",
  staticFields: {},
  methods: {
    "<init>(Ljava/io/Reader;)V": (jvm, obj, args) => {
      obj.reader = args[0];
      return obj;
    },
    "readLine()Ljava/lang/String;": (jvm, obj, args) => {
      const reader = obj.reader;
      let line = "";
      let charCode;

      const readerRead = jvm._jreFindMethod(
        "java/io/InputStreamReader",
        "read",
        "()I",
      );

      while ((charCode = readerRead(jvm, reader, [])) !== -1) {
        const char = String.fromCharCode(charCode);
        if (char === "\n") {
          break;
        }
        if (char !== "\r") {
          line += char;
        }
      }

      if (line === "" && charCode === -1) {
        return null;
      }

      return jvm.internString(line);
    },
    "close()V": (jvm, obj, args) => {
      // no-op
    },
  },
};
