module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  staticMethods: {
    'valueOf(Ljava/lang/Object;)Ljava/lang/String;': (jvm, obj, args) => {
      const value = args[0];
      if (value === null) {
        return jvm.internString('null');
      }
      if (typeof value === 'string') {
        return value; // Already a string
      }
      if (value && typeof value.toString === 'function') {
        return jvm.internString(value.toString());
      }
      return jvm.internString(String(value));
    },
  },
  methods: {
    'concat(Ljava/lang/String;)Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj + args[0]);
    },
    'toUpperCase()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.toUpperCase());
    },
    'toLowerCase()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.toLowerCase());
    },
    'length()I': (jvm, obj, args) => {
      return obj.length;
    },
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      return obj === args[0] ? 1 : 0;
    },
    'substring(II)Ljava/lang/String;': (jvm, obj, args) => {
        const startIndex = args[0];
        const endIndex = args[1];
        const result = obj.substring(startIndex, endIndex);
        return jvm.internString(result);
    },
    'getClass()Ljava/lang/Class;': (jvm, obj, args) => {
      return {
        type: 'java/lang/Class',
        className: 'java.lang.String',
        getSimpleName: function() {
          return jvm.internString('String');
        }
      };
    },
  },
};
