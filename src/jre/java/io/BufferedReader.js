module.exports = {
  'java/io/BufferedReader.<init>': (obj, args) => {
    obj.reader = args[0];
    return obj;
  },
  'java/io/BufferedReader.readLine': (obj, args, jvm) => {
    const reader = obj.reader;
    let line = '';
    let charCode;

    const readerRead = jvm._jreMethods['java/io/InputStreamReader.read'];

    while ((charCode = readerRead(reader, [], jvm)) !== -1) {
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
  }
};
