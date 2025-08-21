module.exports = {
  isInterface: true,
  super: null,
  interfaces: [],
  methods: {
    'hasNext()Z': (jvm, iter, args) => {
      return iter.index < iter.array.length ? 1 : 0;
    },
    'next()Ljava/lang/Object;': (jvm, iter, args) => {
      if (iter.index >= iter.array.length) {
        throw {
          type: 'java/util/NoSuchElementException'
        };
      }
      return iter.array[iter.index++];
    }
  }
};
