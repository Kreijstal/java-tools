module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<clinit>()V': (jvm, _, args, thread) => {
      const systemClass = jvm.classes['java/lang/System'];

      // 1. Create ConsoleOutputStream for out
      const cosOut = { type: 'java/io/ConsoleOutputStream', fields: {} };
      const cosInit = jvm._jreFindMethod('java/io/ConsoleOutputStream', '<init>', '(Ljava/lang/Object;)V');
      if (cosInit) {
        const writer = (typeof process !== 'undefined' && process.stdout) ? process.stdout.write.bind(process.stdout) : () => {};
        cosInit(jvm, cosOut, [writer]);
      }

      // 2. Create PrintStream for out
      const out = { type: 'java/io/PrintStream', fields: {} };
      const psInit = jvm._jreFindMethod('java/io/PrintStream', '<init>', '(Ljava/io/OutputStream;)V');
      if (psInit) {
        psInit(jvm, out, [cosOut]);
      }
      systemClass.staticFields.set('out:Ljava/io/PrintStream;', out);

      // 3. Create ConsoleOutputStream for err
      const cosErr = { type: 'java/io/ConsoleOutputStream', fields: {} };
      if (cosInit) {
        const writer = (typeof process !== 'undefined' && process.stderr) ? process.stderr.write.bind(process.stderr) : () => {};
        cosInit(jvm, cosErr, [writer]);
      }

      // 4. Create PrintStream for err
      const err = { type: 'java/io/PrintStream', fields: {} };
      if (psInit) {
        psInit(jvm, err, [cosErr]);
      }
      systemClass.staticFields.set('err:Ljava/io/PrintStream;', err);

      // 5. Create a dummy InputStream for in
      const inStream = { type: 'java/io/InputStream', fields: {} };
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

    'exit(I)V': (jvm, obj, args) => {
        // For now, this is a no-op in the test environment
    },
  },
};
