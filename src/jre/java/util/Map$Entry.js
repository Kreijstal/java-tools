module.exports = {
  super: null,
  isInterface: true,
  interfaces: [],
  methods: {
    'getKey()Ljava/lang/Object;': (jvm, obj) => obj.key,
    'getValue()Ljava/lang/Object;': (jvm, obj) => obj.value,
    'setValue(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const old = obj.value;
      obj.value = args[0];
      if (obj.backingMap) obj.backingMap.set(obj.key, args[0]);
      return old;
    },
  },
};
