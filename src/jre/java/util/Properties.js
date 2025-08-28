module.exports = {
  super: {
    type: 'java/util/Hashtable'
  },
  methods: {
    '<init>()V': (jvm, obj, args, thread) => {
      obj.properties = new Map();
      obj.defaults = null;
    },
    '<init>(Ljava/util/Properties;)V': (jvm, obj, args, thread) => {
      obj.properties = new Map();
      obj.defaults = args[0];
    },
    'getProperty(Ljava/lang/String;)Ljava/lang/String;': (jvm, obj, args) => {
      const key = args[0];
      let value = obj.properties.get(key);
      if (value !== undefined) {
        return jvm.internString(value);
      }
      if (obj.defaults) {
        return obj.defaults.methods['getProperty(Ljava/lang/String;)Ljava/lang/String;'](null, jvm, obj.defaults, [key]);
      }
      return null;
    },
    'getProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (jvm, obj, args) => {
      const key = args[0];
      const defaultValue = args[1];
      const value = obj.methods['getProperty(Ljava/lang/String;)Ljava/lang/String;'].call(null, jvm, obj, [key]);
      return value !== null ? value : defaultValue;
    },
    'setProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/Object;': (jvm, obj, args) => {
      const key = args[0];
      const value = args[1];
      return obj.properties.set(key, value);
    },
    'load(Ljava/io/InputStream;)V': (jvm, obj, args) => {
      // In this simple implementation, we'll just ignore the loading since we don't have file I/O
      // Real implementation would parse properties file format
      // Properties file format is key=value pairs with # comments
    },
    'store(Ljava/io/OutputStream;Ljava/lang/String;)V': (jvm, obj, args) => {
      // In this simple implementation, we'll just ignore the storing
      // Real implementation would write properties in key=value format
    },
    'size()I': (jvm, obj, args) => {
      return obj.properties.size;
    },
    'isEmpty()Z': (jvm, obj, args) => {
      return obj.properties.size === 0 ? 1 : 0;
    },
    'containsKey(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      return obj.properties.has(args[0]) ? 1 : 0;
    },
    'get(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      return obj.methods['getProperty(Ljava/lang/String;)Ljava/lang/String;'].call(null, jvm, obj, [args[0]]);
    },
    'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      return obj.methods['setProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/Object;'].call(null, jvm, obj, [args[0], args[1]]);
    },
    'stringPropertyNames()Ljava/util/Set;': (jvm, obj, args) => {
      const keyStrings = Array.from(obj.properties.keys());
      return {
        type: 'java/util/HashSet',
        items: new Set(keyStrings)
      };
    },
    'clear()V': (jvm, obj, args) => {
      obj.properties.clear();
    },
    'list(Ljava/io/PrintStream;)V': (jvm, obj, args) => {
      // In this simple implementation, we just ignore the output
      // Real implementation would print all properties to the stream
      console.log("Properties.list() called - listing properties:");
      for (let [key, value] of obj.properties) {
        console.log(key + "=" + value);
      }
    }
  },
  staticFields: {}
};