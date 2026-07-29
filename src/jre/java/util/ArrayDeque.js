function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection.array)) return collection.array;
  if (Array.isArray(collection.items)) return collection.items;
  if (collection.items instanceof Set) return Array.from(collection.items);
  if (collection.set instanceof Set) return Array.from(collection.set);
  return [];
}

function deque(obj) {
  if (!Array.isArray(obj.array)) obj.array = [];
  return obj.array;
}

module.exports = {
  super: 'java/util/AbstractCollection',
  interfaces: ['java/util/Deque'],
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.array = [];
    },
    '<init>(Ljava/util/Collection;)V': (jvm, obj, args) => {
      obj.array = values(args[0]).slice();
    },
    'add(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      deque(obj).push(args[0]);
      return 1;
    },
    'addAll(Ljava/util/Collection;)Z': (jvm, obj, args) => {
      const additions = values(args[0]);
      deque(obj).push(...additions);
      return additions.length === 0 ? 0 : 1;
    },
    'addFirst(Ljava/lang/Object;)V': (jvm, obj, args) => {
      deque(obj).unshift(args[0]);
    },
    'push(Ljava/lang/Object;)V': (jvm, obj, args) => {
      deque(obj).unshift(args[0]);
    },
    'poll()Ljava/lang/Object;': (jvm, obj) => {
      const array = deque(obj);
      return array.length === 0 ? null : array.shift();
    },
    'pollFirst()Ljava/lang/Object;': (jvm, obj) => {
      const array = deque(obj);
      return array.length === 0 ? null : array.shift();
    },
    'isEmpty()Z': (jvm, obj) => deque(obj).length === 0 ? 1 : 0,
    'size()I': (jvm, obj) => deque(obj).length,
    'iterator()Ljava/util/Iterator;': (jvm, obj) => ({
      type: 'java/util/Iterator',
      array: deque(obj).slice(),
      index: 0,
      lastIndex: -1,
    }),
  },
};
