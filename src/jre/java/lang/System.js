module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<clinit>()V': (jvm, _, args, thread) => {
      const systemClass = jvm.classes['java/lang/System'];

      // Detect environment and create appropriate writers
      function createBrowserWriter(type = 'stdout') {
        return (char) => {
          // Browser environment - output to browser UI
          if (typeof document !== 'undefined') {
            const output = document.getElementById('output');
            if (output) {
              // Find or create system output div
              let systemOutput = document.getElementById('systemOutput');
              if (!systemOutput) {
                systemOutput = document.createElement('div');
                systemOutput.id = 'systemOutput';
                systemOutput.className = 'system-output';
                const style = type === 'stderr' ? 
                  'background: #2d3748; color: #f56565; padding: 8px; margin: 4px 0; border-left: 4px solid #f56565; font-family: monospace; white-space: pre-wrap;' :
                  'background: #2d3748; color: #68d391; padding: 8px; margin: 4px 0; border-left: 4px solid #68d391; font-family: monospace; white-space: pre-wrap;';
                systemOutput.style.cssText = style;
                output.appendChild(systemOutput);
              }
              
              // Append character to system output
              systemOutput.textContent += char;
              output.scrollTop = output.scrollHeight;
            }
            
            // Also log to browser console for debugging
            if (typeof console !== 'undefined' && console.log && char === '\n') {
              console.log(`[JVM System.${type === 'stderr' ? 'err' : 'out'}]`);
            }
          }
        };
      }

      function createNodeWriter(stream) {
        return (typeof process !== 'undefined' && stream) ? stream.write.bind(stream) : () => {};
      }

      // Determine environment and create writers
      const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
      const outWriter = isBrowser ? createBrowserWriter('stdout') : createNodeWriter(process.stdout);
      const errWriter = isBrowser ? createBrowserWriter('stderr') : createNodeWriter(process.stderr);

      // 1. Create ConsoleOutputStream for out
      const cosOut = { type: 'java/io/ConsoleOutputStream', fields: {} };
      const cosInit = jvm._jreFindMethod('java/io/ConsoleOutputStream', '<init>', '(Ljava/lang/Object;)V');
      if (cosInit) {
        cosInit(jvm, cosOut, [outWriter]);
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
        cosInit(jvm, cosErr, [errWriter]);
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
