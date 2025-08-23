'use strict';
const process = require('process');
module.exports = {
  super: 'java/lang/Object',
  staticFields: new Map(),
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
    },
    'getProperty(Ljava/lang/String;)Ljava/lang/String;': (jvm, obj, args) => {
      const key = jvm.stringify(args[0]);
      const value = module.exports.staticFields.get('props').get(key);
      return value ? jvm.internString(value) : null;
    },
    'setProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (jvm, obj, args) => {
      const key = jvm.stringify(args[0]);
      const value = jvm.stringify(args[1]);
      const props = module.exports.staticFields.get('props');
      const old = props.get(key);
      props.set(key, value);
      return old ? jvm.internString(old) : null;
    },
    'exit(I)V': (jvm, obj, args) => {
      const status = args[0];
      console.log(`System.exit(${status}) called.`);
      // In a real JVM, this would terminate the process.
      // Here we can just stop the JVM loop.
      jvm.exit(status);
    },
    'nanoTime()J': (jvm, obj, args) => {
      return BigInt(Math.floor(performance.now() * 1000000));
    },
    'currentTimeMillis()J': (jvm, obj, args) => {
      return BigInt(Date.now());
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

      // Initialize properties
      const props = new Map();
      props.set('java.version', '1.8.0');
      props.set('java.vendor', 'JVM Tools Mock');
      props.set('os.name', 'Linux');
      props.set('user.dir', '/tmp');
      props.set('file.separator', '/');
      props.set('path.separator', ':');
      props.set('line.separator', '\n');
      module.exports.staticFields.set('props', props);
    }
  }
};
