function queue(obj) {
  if (!Array.isArray(obj.array)) obj.array = [];
  return obj.array;
}

function addToCollection(collection, value) {
  if (Array.isArray(collection.array)) {
    collection.array.push(value);
    collection.items = collection.array;
    collection.size = collection.array.length;
    return;
  }
  if (Array.isArray(collection.items)) {
    collection.items.push(value);
    collection.size = collection.items.length;
    return;
  }
  if (collection.items instanceof Set) {
    collection.items.add(value);
  }
}

module.exports = {
  super: 'java/util/AbstractQueue',
  interfaces: ['java/util/concurrent/BlockingQueue'],
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.array = [];
    },
    'size()I': (jvm, obj) => queue(obj).length,
    'clear()V': (jvm, obj) => {
      queue(obj).length = 0;
    },
    'add(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      queue(obj).push(args[0]);
      return 1;
    },
    'offer(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      queue(obj).push(args[0]);
      return 1;
    },
    'poll()Ljava/lang/Object;': (jvm, obj) => {
      const values = queue(obj);
      return values.length === 0 ? null : values.shift();
    },
    'drainTo(Ljava/util/Collection;I)I': (jvm, obj, args) => {
      const source = queue(obj);
      const count = Math.min(source.length, Math.max(0, args[1]));
      for (let i = 0; i < count; i++) addToCollection(args[0], source.shift());
      return count;
    },
  },
};
