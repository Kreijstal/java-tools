module.exports = {
  super: "java/lang/Object",
  staticMethods: {
    'forName(Ljava/lang/String;)Ljava/nio/charset/Charset;': (jvm, obj, args) => {
      const charsetName = args[0]; // This is a native JavaScript string
      // A real implementation would have a map of supported charsets and throw
      // UnsupportedCharsetException for invalid names.
      // For now, we'll just create a representation for any given name.
      const charset = {
        type: 'java/nio/charset/Charset',
        'java/nio/charset/Charset/name': charsetName,
      };
      return charset;
    },
  },
};
