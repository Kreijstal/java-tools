const { withThrows } = require('../../helpers');

module.exports = {
  isInterface: true,
  super: null,
  interfaces: [],
  methods: {
    'hasNext()Z': (jvm, iter, args) => {
      if (iter && typeof iter.hasNext === 'function') return iter.hasNext();
      return iter.index < iter.array.length ? 1 : 0;
    },
    'next()Ljava/lang/Object;': withThrows((jvm, iter, args) => {
      if (iter && typeof iter.next === 'function') return iter.next();
      if (iter.index >= iter.array.length) {
        throw {
          type: 'java/util/NoSuchElementException'
        };
      }
      iter.lastIndex = iter.index;
      return iter.array[iter.index++];
    }, ['java/util/NoSuchElementException']),
    'remove()V': (jvm, iter, args) => {
      if (typeof iter.remove === 'function') {
        iter.remove();
        return;
      }
      if (iter.lastIndex === undefined || iter.lastIndex < 0) throw { type: 'java/lang/IllegalStateException' };
      iter.array.splice(iter.lastIndex, 1);
      if (iter.lastIndex < iter.index) iter.index--;
      iter.lastIndex = -1;
    }
  }
};
