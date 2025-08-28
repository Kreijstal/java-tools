module.exports = {
  super: {
    type: 'java/lang/Exception'
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
    '<init>(Ljava/lang/String;Ljava/lang/Throwable;)V': (jvm, obj, args, thread) => {
      obj.message = args[0];
      obj.cause = args[1];
      obj.hashCode = jvm.nextHashCode++;
    },
    'getMessage()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.message;
    },
    'getCause()Ljava/lang/Throwable;': (jvm, obj, args) => {
      return obj.cause;
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