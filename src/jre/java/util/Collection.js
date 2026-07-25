module.exports = {
  super: null,
  isInterface: true,
  interfaces: ['java/lang/Iterable'],
  methods: {
    'add(Ljava/lang/Object;)Z': () => 0,
    'addAll(Ljava/util/Collection;)Z': () => 0,
    'contains(Ljava/lang/Object;)Z': () => 0,
    'isEmpty()Z': () => 1,
    'size()I': () => 0,
    'iterator()Ljava/util/Iterator;': () => null,
    'toArray()[Ljava/lang/Object;': () => [],
    'toArray([Ljava/lang/Object;)[Ljava/lang/Object;': (jvm, obj, args) => args[0] || [],
  },
};
