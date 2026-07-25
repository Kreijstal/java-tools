const fs = require('fs');

function loadFile(obj, filePath) {
  obj.path = String(filePath);
  obj.buffer = fs.readFileSync(obj.path);
  obj.pos = 0;
  obj.closed = false;
}

function ensureOpen(jvm, obj) {
  if (obj.closed) {
    jvm.throwException('java/io/IOException', 'Stream closed');
  }
}

module.exports = {
  super: 'java/io/InputStream',
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      loadFile(obj, args[0]);
    },

    '<init>(Ljava/io/File;)V': (jvm, obj, args) => {
      loadFile(obj, args[0].path);
    },

    'read()I': (jvm, obj, args) => {
      ensureOpen(jvm, obj);
      if (obj.pos >= obj.buffer.length) {
        return -1;
      }
      return obj.buffer[obj.pos++];
    },

    'read([BII)I': (jvm, obj, args) => {
      ensureOpen(jvm, obj);
      const target = args[0];
      const off = args[1];
      const len = args[2];

      if (target === null) {
        jvm.throwException('java/lang/NullPointerException');
      }
      if (off < 0 || len < 0 || off + len > target.length) {
        jvm.throwException('java/lang/IndexOutOfBoundsException');
      }
      if (len === 0) {
        return 0;
      }
      if (obj.pos >= obj.buffer.length) {
        return -1;
      }

      const actualLen = Math.min(len, obj.buffer.length - obj.pos);
      for (let i = 0; i < actualLen; i++) {
        // obj.buffer is a Node Buffer (unsigned); Java byte arrays hold signed bytes.
        target[off + i] = (obj.buffer[obj.pos + i] << 24) >> 24;
      }
      obj.pos += actualLen;
      return actualLen;
    },

    'skip(J)J': (jvm, obj, args) => {
      ensureOpen(jvm, obj);
      const requested = Number(args[0]);
      const skipped = Math.max(0, Math.min(requested, obj.buffer.length - obj.pos));
      obj.pos += skipped;
      return BigInt(skipped);
    },

    'available()I': (jvm, obj, args) => {
      ensureOpen(jvm, obj);
      return obj.buffer.length - obj.pos;
    },

    'close()V': (jvm, obj, args) => {
      obj.closed = true;
    }
  }
};
