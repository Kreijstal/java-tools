const fs = require('fs');

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/io/DataInput', 'java/io/DataOutput'],
  staticFields: {},
  methods: {
    '<init>(Ljava/io/File;Ljava/lang/String;)V': (jvm, obj, args) => {
      const file = args[0];
      const mode = args[1];
      
      const filePath = file && file.path ? file.path : '';
      const modeStr = mode && mode.value ? mode.value : 'r';
      
      obj.path = filePath;
      obj.mode = modeStr;
      obj.position = 0;
      obj.fd = null;
      
      try {
        const flags = modeStr.includes('w') ? 'r+' : 'r';
        obj.fd = fs.openSync(filePath, flags);
      } catch (e) {
        jvm.throwException('java/io/IOException', `Cannot open file: ${filePath}`);
      }
    },
    
    '<init>(Ljava/lang/String;Ljava/lang/String;)V': (jvm, obj, args) => {
      const fileName = args[0];
      const mode = args[1];
      
      const filePath = fileName && fileName.value ? fileName.value : '';
      const modeStr = mode && mode.value ? mode.value : 'r';
      
      obj.path = filePath;
      obj.mode = modeStr;
      obj.position = 0;
      obj.fd = null;
      
      try {
        const flags = modeStr.includes('w') ? 'r+' : 'r';
        obj.fd = fs.openSync(filePath, flags);
      } catch (e) {
        jvm.throwException('java/io/IOException', `Cannot open file: ${filePath}`);
      }
    },
    
    'read()I': (jvm, obj, args) => {
      if (!obj.fd) {
        jvm.throwException('java/io/IOException', 'File not open');
        return -1;
      }
      
      try {
        const buffer = Buffer.alloc(1);
        const bytesRead = fs.readSync(obj.fd, buffer, 0, 1, obj.position);
        if (bytesRead === 0) {
          return -1;
        }
        obj.position += bytesRead;
        return buffer[0] & 0xFF;
      } catch (e) {
        return -1;
      }
    },
    
    'read([BII)I': (jvm, obj, args) => {
      const b = args[0];
      const off = args[1];
      const len = args[2];
      
      if (!obj.fd) {
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
        const bytesRead = fs.readSync(obj.fd, buffer, 0, len, obj.position);
        
        for (let i = 0; i < bytesRead; i++) {
          b[off + i] = buffer[i];
        }
        
        obj.position += bytesRead;
        return bytesRead === 0 ? -1 : bytesRead;
      } catch (e) {
        return -1;
      }
    },
    
    'write(I)V': (jvm, obj, args) => {
      const b = args[0];
      
      if (!obj.fd) {
        jvm.throwException('java/io/IOException', 'File not open');
        return;
      }
      
      try {
        const buffer = Buffer.from([b & 0xFF]);
        fs.writeSync(obj.fd, buffer, 0, 1, obj.position);
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
      obj.position = pos;
    },
    
    'length()J': (jvm, obj, args) => {
      if (!obj.fd) {
        jvm.throwException('java/io/IOException', 'File not open');
        return 0;
      }
      
      try {
        const stats = fs.fstatSync(obj.fd);
        return stats.size;
      } catch (e) {
        return 0;
      }
    },
    
    'close()V': (jvm, obj, args) => {
      if (obj.fd !== null) {
        try {
          fs.closeSync(obj.fd);
        } catch (e) {
          // Ignore close errors
        }
        obj.fd = null;
      }
    }
  }
};