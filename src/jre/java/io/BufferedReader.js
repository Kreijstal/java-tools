module.exports = {
  'java/io/BufferedReader.<init>(Ljava/io/Reader;)V': (jvm, obj, args) => {
    obj.reader = args[0];
    return obj;
  },
  'java/io/BufferedReader.readLine()Ljava/lang/String;': (jvm, obj, args) => {
    const reader = obj.reader;
    let line = '';
    let charCode;

    const readerRead = jvm._jreMethods['java/io/InputStreamReader.read()I'];

    while ((charCode = readerRead(jvm, reader, [])) !== -1) {
      const char = String.fromCharCode(charCode);
      if (char === '\n') {
        break;
      }
      if (char !== '\r') {
        line += char;
      }
    }

    if (line === '' && charCode === -1) {
      return null;
    }

    return jvm.internString(line);
  },
  'java/io/BufferedReader.close()V': (jvm, obj, args) => {
    // no-op
  }
};
