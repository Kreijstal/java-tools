function initialize(obj) {
  obj.map = new Map();
  obj.sizeCache = 0;
}

module.exports = {
  super: 'java/util/HashMap',
  interfaces: ['java/util/Map'],
  methods: {
    '<init>()V': (jvm, obj) => initialize(obj),
    '<init>(I)V': (jvm, obj) => initialize(obj),
    '<init>(IF)V': (jvm, obj) => initialize(obj),
    '<init>(Ljava/util/Map;)V': (jvm, obj, args) => {
      initialize(obj);
      const source = args[0] && (args[0].map || args[0].entries);
      if (!source || typeof source.entries !== 'function') return;
      for (const [key, entry] of source.entries()) {
        obj.map.set(key, entry);
      }
      obj.sizeCache = obj.map.size;
    },
  },
  staticFields: {},
};
