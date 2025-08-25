const fs = require('fs');

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/io/DataInput', 'java/io/DataOutput'],
  staticFields: {},
  methods: {
    '<init>(Ljava/io/File;Ljava/lang/String;)V': async (jvm, obj, args) => {
      const file = args[0];
      const mode = args[1];
      
      const filePath = file && file.path ? file.path : '';
      const modeStr = mode ? String(mode) : 'r';
      
      obj.path = filePath;
      obj.mode = modeStr;
      obj.position = 0;
      obj.fileHandle = null;
      
      try {
        const flags = modeStr.includes('w') ? 'w+' : 'r';
        obj.fileHandle = await jvm.fs.promises.open(filePath, flags);
      } catch (e) {
        jvm.throwException('java/io/IOException', `Cannot open file: ${filePath}`);
      }
    },
    
    '<init>(Ljava/lang/String;Ljava/lang/String;)V': async (jvm, obj, args) => {
      const fileName = args[0];
      const mode = args[1];
      
      const filePath = fileName && fileName.value ? fileName.value : '';
      const modeStr = mode && mode.value ? mode.value : 'r';
      
      obj.path = filePath;
      obj.mode = modeStr;
      obj.position = 0;
      obj.fileHandle = null;
      
      try {
        const flags = modeStr.includes('w') ? 'r+' : 'r';
        obj.fileHandle = await jvm.fs.promises.open(filePath, flags);
      } catch (e) {
        jvm.throwException('java/io/IOException', `Cannot open file: ${filePath}`);
      }
    },
    
    'read()I': async (jvm, obj, args) => {
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
    },
    
    'read([BII)I': async (jvm, obj, args) => {
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
          b[off + i] = buffer[i];
        }
        
        obj.position += bytesRead;
        return bytesRead === 0 ? -1 : bytesRead;
      } catch (e) {
        return -1;
      }
    },
    
    'write(I)V': async (jvm, obj, args) => {
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
    },
    
    'seek(J)V': (jvm, obj, args) => {
      const pos = args[0];
      if (pos < 0) {
        jvm.throwException('java/io/IOException', 'Negative seek position');
        return;
      }
      obj.position = Number(pos);
    },
    
    'length()J': async (jvm, obj, args) => {
      if (!obj.fileHandle) {
        jvm.throwException('java/io/IOException', 'File not open');
        return 0;
      }
      
      try {
        const stats = await obj.fileHandle.stat();
        return stats.size;
      } catch (e) {
        return 0;
      }
    },
    
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