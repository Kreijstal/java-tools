module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.value = null;
    },
    '<init>(Ljava/lang/Object;)V': (jvm, obj, args) => {
      obj.value = args[0];
    },
    'get()Ljava/lang/Object;': (jvm, obj) => obj.value,
    'set(Ljava/lang/Object;)V': (jvm, obj, args) => {
      obj.value = args[0];
    },
    'lazySet(Ljava/lang/Object;)V': (jvm, obj, args) => {
      obj.value = args[0];
    },
    'getAndSet(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const previous = obj.value;
      obj.value = args[0];
      return previous;
    },
    'compareAndSet(Ljava/lang/Object;Ljava/lang/Object;)Z': (jvm, obj, args) => {
      if (obj.value !== args[0]) return 0;
      obj.value = args[1];
      return 1;
    },
    'weakCompareAndSet(Ljava/lang/Object;Ljava/lang/Object;)Z': (jvm, obj, args) => {
      if (obj.value !== args[0]) return 0;
      obj.value = args[1];
      return 1;
    },
    'toString()Ljava/lang/String;': (jvm, obj) => {
      const value = obj.value;
      if (value === null || value === undefined) return jvm.internString('null');
      if (value && Object.prototype.hasOwnProperty.call(value, 'value')) {
        return jvm.internString(String(value.value));
      }
      return jvm.internString(String(value));
    },
  },
  staticFields: {},
};
