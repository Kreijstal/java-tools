const iterator = require('./Iterator');

module.exports = {
  isInterface: true,
  super: null,
  interfaces: ['java/util/Iterator'],
  methods: {
    ...iterator.methods,
    'hasPrevious()Z': (jvm, iter) => typeof iter.hasPrevious === 'function' ? iter.hasPrevious() : (iter.index > 0 ? 1 : 0),
    'previous()Ljava/lang/Object;': (jvm, iter) => typeof iter.previous === 'function' ? iter.previous() : iter.array[--iter.index],
    'nextIndex()I': (jvm, iter) => typeof iter.nextIndex === 'function' ? iter.nextIndex() : iter.index,
    'previousIndex()I': (jvm, iter) => typeof iter.previousIndex === 'function' ? iter.previousIndex() : iter.index - 1,
    'set(Ljava/lang/Object;)V': (jvm, iter, args) => { if (typeof iter.set === 'function') iter.set(args[0]); },
    'add(Ljava/lang/Object;)V': (jvm, iter, args) => { if (typeof iter.add === 'function') iter.add(args[0]); else { iter.array.splice(iter.index, 0, args[0]); iter.index++; } },
  },
};
