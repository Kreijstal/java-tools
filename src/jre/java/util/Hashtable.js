module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/util/Map'],
  methods: {
    '<init>()V': function(jvm, obj, args) {
      obj.map = new Map();
    },
    'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': function(jvm, obj, args) {
      const key = args[0];
      const value = args[1];
      const old = obj.map.get(key);
      obj.map.set(key, value);
      return old;
    },
    'containsKey(Ljava/lang/Object;)Z': function(jvm, obj, args) {
      const key = args[0];
      return obj.map.has(key) ? 1 : 0;
    }
  }
};
