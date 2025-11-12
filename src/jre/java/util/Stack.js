const { withThrows } = require('../../helpers');

module.exports = {
  super: {
    type: 'java/util/Vector'
  },
  methods: {
    '<init>()V': (jvm, obj, args, thread) => {
      obj.items = [];
      obj.size = 0;
    },
    'push(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const item = args[0];
      obj.items.push(item);
      obj.size = obj.items.length;
      return item;
    },
    'pop()Ljava/lang/Object;': withThrows((jvm, obj, args) => {
      if (obj.size === 0) {
        throw {
          type: 'java/util/EmptyStackException',
          message: 'Stack is empty'
        };
      }
      const item = obj.items.pop();
      obj.size = obj.items.length;
      return item;
    }, ['java/util/EmptyStackException']),
    'peek()Ljava/lang/Object;': withThrows((jvm, obj, args) => {
      if (obj.size === 0) {
        throw {
          type: 'java/util/EmptyStackException',
          message: 'Stack is empty'
        };
      }
      return obj.items[obj.items.length - 1];
    }, ['java/util/EmptyStackException']),
    'empty()Z': (jvm, obj, args) => {
      return obj.size === 0 ? 1 : 0; // true : false
    },
    'search(Ljava/lang/Object;)I': (jvm, obj, args) => {
      const item = args[0];
      // Search from top of stack (end of array)
      for (let i = obj.items.length - 1; i >= 0; i--) {
        if (obj.items[i] === item || (obj.items[i] && obj.items[i].equals && obj.items[i].equals(item))) {
          return obj.items.length - i;
        }
      }
      return -1;
    },
    'size()I': (jvm, obj, args) => {
      return obj.size;
    },
    'isEmpty()Z': (jvm, obj, args) => {
      return obj.size === 0 ? 1 : 0;
    },
    'clear()V': (jvm, obj, args) => {
      obj.items = [];
      obj.size = 0;
    },
    'contains(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      return obj.items.includes(args[0]) ? 1 : 0;
    },
    'iterator()Ljava/util/Iterator;': (jvm, obj, args) => {
      let index = 0;
      return {
        type: 'java/util/Iterator',
        hasNext: () => index < obj.items.length,
        next: withThrows(() => {
          if (index >= obj.items.length) {
            throw {
              type: 'java/util/NoSuchElementException',
              message: 'No more elements'
            };
          }
          return obj.items[index++];
        }, ['java/util/NoSuchElementException'])
      };
    }
  },
  staticFields: {}
};
