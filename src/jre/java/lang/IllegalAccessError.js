module.exports = {
  super: {
    type: 'java/lang/IncompatibleClassChangeError'
  },
  methods: {
    '<init>()V': (jvm, obj, args, thread) => {
      obj.message = null;
      obj.hashCode = jvm.nextHashCode++;
    },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args, thread) => {
      obj.message = args[0];
      obj.hashCode = jvm.nextHashCode++;
    },
    'getMessage()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.message;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const className = obj.type.replace(/\//g, '.');
      if (obj.message) {
        return jvm.internString(className + ': ' + obj.message);
      }
      return jvm.internString(className);
    }
  },
  staticFields: {},
  interfaces: []
};