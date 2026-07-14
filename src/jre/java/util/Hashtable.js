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
      return old === undefined ? null : old;
    },
    'get(Ljava/lang/Object;)Ljava/lang/Object;': function(jvm, obj, args) {
      const value = obj.map.get(args[0]);
      return value === undefined ? null : value;
    },
    'containsKey(Ljava/lang/Object;)Z': function(jvm, obj, args) {
      const key = args[0];
      return obj.map.has(key) ? 1 : 0;
    },
    'isEmpty()Z': function(jvm, obj) {
      return obj.map.size === 0 ? 1 : 0;
    },
    'keys()Ljava/util/Enumeration;': function(jvm, obj) {
      return { type: 'java/util/Enumeration', values: Array.from(obj.map.keys()), index: 0 };
    },
  }
};
