module.exports = {
  'java/io/BufferedReader.<init>': (jvm, obj, args) => {
    obj.reader = args[0];
    return obj;
  },
  'java/io/BufferedReader.readLine': (jvm, obj, args) => {
    const reader = obj.reader;
    let line = '';
    let charCode;

    const readerRead = jvm._jreMethods['java/io/InputStreamReader.read'];

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
  'java/io/BufferedReader.close': (jvm, obj, args) => {
    // no-op
  }
};
