module.exports = {
  super: 'java/util/AbstractCollection',
  interfaces: ['java/util/List'],
  methods: {
    '<init>()V': function(jvm, obj, args) {
      obj.array = [];
    },
    'add(Ljava/lang/Object;)Z': function(jvm, obj, args) {
      obj.array.push(args[0]);
      return 1; // Return 1 for true
    },
    'get(I)Ljava/lang/Object;': function(jvm, obj, args) {
      return obj.array[args[0]];
    },
    'size()I': function(jvm, obj, args) {
      return obj.array.length;
    },
    'iterator()Ljava/util/Iterator;': function(jvm, obj, args) {
      return {
        type: 'java/util/Iterator',
        array: obj.array,
        index: 0,
      };
    },
    'addAll(Ljava/util/Collection;)Z': function(jvm, obj, args) {
      const collection = args[0];
      if (collection.array) {
        obj.array.push(...collection.array);
        return 1;
      }
      return 0;
    },
    'toArray()[Ljava/lang/Object;': function(jvm, obj, args) {
      return obj.array;
    }
  }
};
