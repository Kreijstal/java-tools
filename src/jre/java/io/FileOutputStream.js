const fs = require('fs');

module.exports = {
  super: 'java/io/OutputStream',
  methods: {
    '<init>(Ljava/io/File;)V': function(jvm, obj, args) {
      const file = args[0];
      const path = file.path;
      obj.fd = fs.openSync(path, 'w');
      return obj;
    },
    'write([B)V': function(jvm, obj, args) {
      const buffer = args[0];
      const data = Buffer.from(buffer.array);
      fs.writeSync(obj.fd, data);
    },
    'close()V': function(jvm, obj, args) {
      fs.closeSync(obj.fd);
    }
  }
};
