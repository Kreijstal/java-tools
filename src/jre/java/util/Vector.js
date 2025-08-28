module.exports = {
  super: {
    type: 'java/util/AbstractList'
  },
  methods: {
    '<init>()V': (jvm, obj, args, thread) => {
      obj.items = [];
      obj.size = 0;
    },
    '<init>(I)V': (jvm, obj, args, thread) => {
      obj.items = new Array(args[0] || 10); // initial capacity
      obj.size = 0;
    },
    '<init>(Ljava/util/Collection;)V': (jvm, obj, args, thread) => {
      const collection = args[0];
      if (collection && collection.items) {
        obj.items = [...collection.items];
        obj.size = obj.items.length;
      } else {
        obj.items = [];
        obj.size = 0;
      }
    },
    'add(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      return obj.methods['add(ILjava/lang/Object;)V'].call(null, jvm, obj, [obj.size, args[0]], thread) !== null ? 1 : 0;
    },
    'add(ILjava/lang/Object;)V': (jvm, obj, args, thread) => {
      const index = args[0];
      const element = args[1];

      if (index < 0 || index > obj.size) {
        throw {
          type: 'java/lang/ArrayIndexOutOfBoundsException',
          message: 'Index: ' + index + ', Size: ' + obj.size
        };
      }

      obj.items.splice(index, 0, element);
      obj.size++;
    },
    'get(I)Ljava/lang/Object;': (jvm, obj, args) => {
      const index = args[0];
      if (index < 0 || index >= obj.size) {
        throw {
          type: 'java/lang/ArrayIndexOutOfBoundsException',
          message: 'Index: ' + index + ', Size: ' + obj.size
        };
      }
      return obj.items[index];
    },
    'set(ILjava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const index = args[0];
      const element = args[1];

      if (index < 0 || index >= obj.size) {
        throw {
          type: 'java/lang/ArrayIndexOutOfBoundsException',
          message: 'Index: ' + index + ', Size: ' + obj.size
        };
      }

      const oldElement = obj.items[index];
      obj.items[index] = element;
      return oldElement;
    },
    'remove(I)Ljava/lang/Object;': (jvm, obj, args) => {
      const index = args[0];

      if (index < 0 || index >= obj.size) {
        throw {
          type: 'java/lang/ArrayIndexOutOfBoundsException',
          message: 'Index: ' + index + ', Size: ' + obj.size
        };
      }

      const removed = obj.items.splice(index, 1)[0];
      obj.size--;
      return removed;
    },
    'remove(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const element = args[0];
      const index = obj.items.indexOf(element);
      if (index >= 0) {
        obj.items.splice(index, 1);
        obj.size--;
        return 1; // true
      }
      return 0; // false
    },
    'size()I': (jvm, obj, args) => {
      return obj.size;
    },
    'isEmpty()Z': (jvm, obj, args) => {
      return obj.size === 0 ? 1 : 0;
    },
    'contains(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      return obj.items.includes(args[0]) ? 1 : 0;
    },
    'clear()V': (jvm, obj, args) => {
      obj.items = [];
      obj.size = 0;
    },
    'indexOf(Ljava/lang/Object;)I': (jvm, obj, args) => {
      return obj.items.indexOf(args[0]);
    },
    'lastIndexOf(Ljava/lang/Object;)I': (jvm, obj, args) => {
      return obj.items.lastIndexOf(args[0]);
    },
    'toArray()[Ljava/lang/Object;': (jvm, obj, args) => {
      return [...obj.items];
    },
    'iterator()Ljava/util/Iterator;': (jvm, obj, args) => {
      let index = 0;
      return {
        type: 'java/util/Iterator',
        hasNext: () => index < obj.size,
        next: () => {
          if (index >= obj.size) {
            throw {
              type: 'java/util/NoSuchElementException',
              message: 'No more elements'
            };
          }
          return obj.items[index++];
        }
      };
    }
  },
  staticFields: {},
  interfaces: []
};