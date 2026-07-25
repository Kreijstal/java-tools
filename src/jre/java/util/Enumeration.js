module.exports = {
  isInterface: true,
  super: null,
  interfaces: [],
  methods: {
    'hasMoreElements()Z': (jvm, obj) => (obj.index < obj.array.length ? 1 : 0),
    'nextElement()Ljava/lang/Object;': (jvm, obj) => {
      if (obj.index >= obj.array.length) {
        jvm.throwException('java/util/NoSuchElementException');
      }
      return obj.array[obj.index++];
    },
  },
};
