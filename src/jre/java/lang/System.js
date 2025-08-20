'use strict';
const process = require('process');
module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V': (jvm, _, args) => {
      const [src, srcPos, dest, destPos, length] = args;
      if (src === null || dest === null) {
        throw {
          type: 'java/lang/NullPointerException'
        };
      }
      if (srcPos < 0 || destPos < 0 || length < 0 || srcPos + length > src.length || destPos + length > dest.length) {
        throw {
          type: 'java/lang/ArrayIndexOutOfBoundsException'
        };
      }
      if (src === dest) {
        const srcCopy = [...src];
        for (let i = 0; i < length; i++) {
          dest[destPos + i] = srcCopy[srcPos + i];
        }
      } else {
        for (let i = 0; i < length; i++) {
          dest[destPos + i] = src[srcPos + i];
        }
      }
    }
  },
  methods: {
    '<clinit>()V': (jvm, _, args, thread) => {
      const systemClass = jvm.classes['java/lang/System'];
      const cosOut = {
        type: 'java/io/ConsoleOutputStream',
        fields: {}
      };
      const cosInit = jvm._jreFindMethod('java/io/ConsoleOutputStream', '<init>', '(Ljava/lang/Object;)V');
      if (cosInit) {
        const writer = typeof process !== 'undefined' && process.stdout ? process.stdout.write.bind(process.stdout) : () => {};
        cosInit(jvm, cosOut, [writer]);
      }
      const out = {
        type: 'java/io/PrintStream',
        fields: {}
      };
      const psInit = jvm._jreFindMethod('java/io/PrintStream', '<init>', '(Ljava/io/OutputStream;)V');
      if (psInit) {
        psInit(jvm, out, [cosOut]);
      }
      systemClass.staticFields.set('out:Ljava/io/PrintStream;', out);
      const cosErr = {
        type: 'java/io/ConsoleOutputStream',
        fields: {}
      };
      if (cosInit) {
        const writer = typeof process !== 'undefined' && process.stderr ? process.stderr.write.bind(process.stderr) : () => {};
        cosInit(jvm, cosErr, [writer]);
      }
      const err = {
        type: 'java/io/PrintStream',
        fields: {}
      };
      if (psInit) {
        psInit(jvm, err, [cosErr]);
      }
      systemClass.staticFields.set('err:Ljava/io/PrintStream;', err);
      const inStream = {
        type: 'java/io/InputStream',
        fields: {}
      };
      systemClass.staticFields.set('in:Ljava/io/InputStream;', inStream);
    },
    'getProperty(Ljava/lang/String;)Ljava/lang/String;': (jvm, obj, args) => {
      const propertyName = args[0];
      const systemProperties = {
        'java.version': '1.8.0',
        'java.vendor': 'JVM Tools Mock',
        'os.name': 'Linux',
        'user.dir': '/tmp',
        'file.separator': '/',
        'path.separator': ':',
        'line.separator': '\n'
      };
      const value = systemProperties[propertyName] || null;
      return value ? jvm.internString(value) : null;
    },
    'exit(I)V': (jvm, obj, args) => {}
  }
};
