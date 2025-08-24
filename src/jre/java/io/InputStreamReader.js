const { TextDecoder } = require('util');

module.exports = {
  super: 'java/io/Reader',
  interfaces: [],
  methods: {
    '<init>(Ljava/io/InputStream;)V': (jvm, obj, args) => {
      const inStream = args[0];
      obj.in = inStream;
      obj.charsetName = 'UTF-8'; // Default charset
      obj.decoder = new TextDecoder(obj.charsetName, { stream: true });
      obj.byteBuffer = [];
    },

    '<init>(Ljava/io/InputStream;Ljava/lang/String;)V': (jvm, obj, args) => {
      const inStream = args[0];
      const charsetName = String(args[1]); // Convert Java string to JS string
      obj.in = inStream;
      obj.charsetName = charsetName;
      try {
        obj.decoder = new TextDecoder(obj.charsetName, { stream: true });
      } catch (e) {
        throw new jvm.java.io.UnsupportedEncodingException(charsetName);
      }
      obj.byteBuffer = [];
    },

    'read()I': (jvm, obj, args) => {
      let decoded = obj.decoder.decode(Buffer.from(obj.byteBuffer), { stream: true });
      
      while (decoded.length === 0) {
        const b = jvm._jreFindMethod(obj.in.type, 'read', '()I')(jvm, obj.in, []);
        if (b === -1) {
          // End of stream, decode any remaining bytes
          const finalDecoded = obj.decoder.decode(Buffer.from(obj.byteBuffer));
          if (finalDecoded.length > 0) {
            obj.byteBuffer = Array.from(Buffer.from(finalDecoded.substring(1)));
            return finalDecoded.charCodeAt(0);
          }
          return -1;
        }
        obj.byteBuffer.push(b);
        decoded = obj.decoder.decode(Buffer.from(obj.byteBuffer), { stream: true });
      }

      const charCode = decoded.charCodeAt(0);
      const remainingBytes = Buffer.from(decoded.substring(1), 'utf16le');
      obj.byteBuffer = Array.from(remainingBytes);
      
      return charCode;
    },

    'read([CII)I': (jvm, obj, args) => {
      const cbuf = args[0];
      const off = args[1];
      const len = args[2];

      if (len === 0) {
        return 0;
      }

      let charsRead = 0;
      const ch = jvm._jreFindMethod(obj.type, 'read', '()I')(jvm, obj, []);
      if (ch === -1) {
        return -1;
      }
      cbuf[off] = ch;
      charsRead = 1;

      if (!jvm._jreFindMethod(obj.type, 'ready', '()Z')(jvm, obj, [])) {
        return charsRead;
      }

      while (charsRead < len) {
        if (!jvm._jreFindMethod(obj.type, 'ready', '()Z')(jvm, obj, [])) {
            break;
        }
        const nextChar = jvm._jreFindMethod(obj.type, 'read', '()I')(jvm, obj, []);
        if (nextChar === -1) {
            break;
        }
        cbuf[off + charsRead] = nextChar;
        charsRead++;
      }
      
      return charsRead;
    },

    'getEncoding()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.newString(obj.charsetName);
    },

    'ready()Z': (jvm, obj, args) => {
      if (obj.byteBuffer.length > 0) {
        return true;
      }
      const availableMethod = jvm._jreFindMethod(obj.in.type, 'available', '()I');
      if (availableMethod) {
        return availableMethod(jvm, obj.in, []) > 0;
      }
      return false;
    },

    'close()V': (jvm, obj, args) => {
      const closeMethod = jvm._jreFindMethod(obj.in.type, 'close', '()V');
      if (closeMethod) {
        closeMethod(jvm, obj.in, []);
      }
    },
  },
};
