module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'out:Ljava/io/PrintStream;': {
      type: 'java/io/PrintStream',
      out: {
        type: 'java/io/ConsoleOutputStream',
        fields: {}
      }
    },
  },
  methods: {
    'getProperty(Ljava/lang/String;)Ljava/lang/String;': (jvm, obj, args) => {
      const propertyName = args[0];
      // Basic system properties implementation
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
  },
};
