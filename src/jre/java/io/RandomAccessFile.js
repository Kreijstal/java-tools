const fs = require('fs');
const { withThrows } = require('../../helpers');

const DEBUG = typeof process !== 'undefined' && process.env && process.env.JVM_DEBUG_RAF;

// Java RandomAccessFile modes never truncate: "r" is read-only, "rw"/"rws"/"rwd"
// read+write and CREATE the file if missing. Node's 'w+' truncates, so open
// existing files with 'r+' and fall back to 'w+' only when the file does not
// exist yet (where truncation is a no-op).
async function openJavaMode(jvm, obj, filePath, modeStr) {
  obj.path = filePath;
  obj.mode = modeStr;
  obj.position = 0;
  obj.fileHandle = null;
  const writable = modeStr.includes('w');
  try {
    obj.fileHandle = await jvm.fs.promises.open(filePath, writable ? 'r+' : 'r');
  } catch (e) {
    if (writable && e && e.code === 'ENOENT') {
      try {
        obj.fileHandle = await jvm.fs.promises.open(filePath, 'w+');
      } catch (e2) {
        if (DEBUG) console.error(`[raf] open FAIL ${filePath} mode=${modeStr}: ${e2.message}`);
        jvm.throwException('java/io/IOException', `Cannot open file: ${filePath}`);
        return;
      }
    } else {
      if (DEBUG) console.error(`[raf] open FAIL ${filePath} mode=${modeStr}: ${e.message}`);
      jvm.throwException('java/io/IOException', `Cannot open file: ${filePath}`);
      return;
    }
  }
  if (DEBUG) console.error(`[raf] open ${filePath} mode=${modeStr}`);
}

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/io/DataInput', 'java/io/DataOutput'],
  staticFields: {},
  methods: {
    '<init>(Ljava/io/File;Ljava/lang/String;)V': withThrows(async (jvm, obj, args) => {
      const file = args[0];
      const mode = args[1];
      const filePath = file && file.path ? file.path : '';
      const modeStr = mode ? String(mode) : 'r';
      await openJavaMode(jvm, obj, filePath, modeStr);
    }, ['java/io/IOException']),

    '<init>(Ljava/lang/String;Ljava/lang/String;)V': withThrows(async (jvm, obj, args) => {
      const fileName = args[0];
      const mode = args[1];
      const filePath = fileName && fileName.value ? fileName.value : '';
      const modeStr = mode && mode.value ? mode.value : 'r';
      await openJavaMode(jvm, obj, filePath, modeStr);
    }, ['java/io/IOException']),
    
    'read()I': withThrows(async (jvm, obj, args) => {
      if (!obj.fileHandle) {
        jvm.throwException('java/io/IOException', 'File not open');
        return -1;
      }
      
      try {
        const buffer = Buffer.alloc(1);
        const { bytesRead } = await obj.fileHandle.read(buffer, 0, 1, obj.position);
        if (bytesRead === 0) {
          return -1;
        }
        obj.position += bytesRead;
        return buffer[0] & 0xFF;
      } catch (e) {
        return -1;
      }
    }, ['java/io/IOException']),
    
    'read([BII)I': withThrows(async (jvm, obj, args) => {
      const b = args[0];
      const off = args[1];
      const len = args[2];
      
      if (!obj.fileHandle) {
        jvm.throwException('java/io/IOException', 'File not open');
        return -1;
      }
      
      if (b === null) {
        jvm.throwException('java/lang/NullPointerException');
        return -1;
      }
      
      if (off < 0 || len < 0 || off + len > b.length) {
        jvm.throwException('java/lang/IndexOutOfBoundsException');
        return -1;
      }
      
      if (len === 0) {
        return 0;
      }
      
      try {
        const buffer = Buffer.alloc(len);
        const { bytesRead } = await obj.fileHandle.read(buffer, 0, len, obj.position);

        for (let i = 0; i < bytesRead; i++) {
          // Java byte arrays hold signed bytes.
          b[off + i] = (buffer[i] << 24) >> 24;
        }

        if (DEBUG) console.error(`[raf] read ${obj.path} pos=${obj.position} len=${len} got=${bytesRead}`);
        obj.position += bytesRead;
        return bytesRead === 0 ? -1 : bytesRead;
      } catch (e) {
        if (DEBUG) console.error(`[raf] read FAIL ${obj.path} pos=${obj.position} len=${len}: ${e.message}`);
        return -1;
      }
    }, ['java/io/IOException', 'java/lang/NullPointerException', 'java/lang/IndexOutOfBoundsException']),
    
    'write(I)V': withThrows(async (jvm, obj, args) => {
      const b = args[0];
      if (!obj.fileHandle) {
        jvm.throwException('java/io/IOException', 'File not open');
        return;
      }
      
      try {
        const buffer = Buffer.from([b & 0xFF]);
        await obj.fileHandle.write(buffer, 0, 1, obj.position);
        obj.position += 1;
      } catch (e) {
        jvm.throwException('java/io/IOException', 'Write failed');
      }
    }, ['java/io/IOException']),
    
    'write([B)V': withThrows(async (jvm, obj, args) => {
      const arr = args[0] || [];
      return module.exports.methods['write([BII)V'](jvm, obj, [arr, 0, arr.length]);
    }, ['java/io/IOException']),

    'write([BII)V': withThrows(async (jvm, obj, args) => {
      const arr = args[0] || [];
      const off = args[1] | 0;
      const len = args[2] | 0;
      if (!obj.fileHandle) {
        jvm.throwException('java/io/IOException', 'File not open');
        return;
      }
      try {
        const buffer = Buffer.alloc(len);
        for (let i = 0; i < len; i++) buffer[i] = arr[off + i] & 0xff;
        await obj.fileHandle.write(buffer, 0, len, obj.position);
        if (DEBUG) console.error(`[raf] write ${obj.path} pos=${obj.position} len=${len}`);
        obj.position += len;
      } catch (e) {
        if (DEBUG) console.error(`[raf] write FAIL ${obj.path} pos=${obj.position} len=${len}: ${e.message}`);
        jvm.throwException('java/io/IOException', 'Write failed');
      }
    }, ['java/io/IOException']),

    'seek(J)V': withThrows((jvm, obj, args) => {
      const pos = args[0];
      if (pos < 0) {
        jvm.throwException('java/io/IOException', 'Negative seek position');
        return;
      }
      obj.position = Number(pos);
    }, ['java/io/IOException']),
    
    'length()J': withThrows(async (jvm, obj, args) => {
      if (!obj.fileHandle) {
        jvm.throwException('java/io/IOException', 'File not open');
        return BigInt(0);
      }
      
      try {
        const stats = await obj.fileHandle.stat();
        return BigInt(stats.size);
      } catch (e) {
        return BigInt(0);
      }
    }, ['java/io/IOException']),
    
    'close()V': async (jvm, obj, args) => {
      if (obj.fileHandle !== null) {
        try {
          await obj.fileHandle.close();
        } catch (e) {
          // Ignore close errors
        }
        obj.fileHandle = null;
      }
    }
  }
};
