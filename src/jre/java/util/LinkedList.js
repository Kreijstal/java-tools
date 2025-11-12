const { withThrows } = require('../../helpers');

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/util/List'],
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.list = [];
    },
    'iterator()Ljava/util/Iterator;': withThrows((jvm, obj, args) => {
      const iteratorClassName = 'java/util/LinkedList$ListIterator';
      const iteratorObj = {
        type: iteratorClassName,
        hashCode: jvm.nextHashCode++,
      };
      const constructor = jvm._jreFindMethod(iteratorClassName, '<init>', '(Ljava/util/LinkedList;)V');
      if (constructor) {
        constructor(jvm, iteratorObj, [obj]);
      } else {
        throw { type: 'java/lang/NoSuchMethodError', message: 'Constructor for iterator not found' };
      }
      return iteratorObj;
    }, ['java/lang/NoSuchMethodError']),
    'size()I': (jvm, obj, args) => {
      return obj.list.length;
    },
    'add(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      obj.list.push(args[0]);
      return 1; // True
    },
    'removeFirst()Ljava/lang/Object;': (jvm, obj, args) => {
      return obj.list.shift();
    },
    'get(I)Ljava/lang/Object;': withThrows((jvm, obj, args) => {
      const index = args[0];
      if (index < 0 || index >= obj.list.length) {
        throw {
          type: 'java/lang/IndexOutOfBoundsException',
          message: `Index: ${index}, Size: ${obj.list.length}`
        };
      }
      return obj.list[index];
    }, ['java/lang/IndexOutOfBoundsException']),
  },
};
