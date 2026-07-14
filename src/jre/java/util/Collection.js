module.exports = {
  super: null,
  isInterface: true,
  interfaces: ['java/lang/Iterable'],
  methods: {
    'add(Ljava/lang/Object;)Z': () => 0,
    'addAll(Ljava/util/Collection;)Z': () => 0,
    'toArray()[Ljava/lang/Object;': () => [],
    'toArray([Ljava/lang/Object;)[Ljava/lang/Object;': (jvm, obj, args) => args[0] || [],
  },
};
