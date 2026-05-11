module.exports = {
  super: 'java/util/HashMap',
  interfaces: ['java/util/Map'],
  methods: {
    '<init>()V': (jvm, obj) => { obj.map = new Map(); obj.entries = obj.map; obj.sizeCache = 0; },
    '<init>(I)V': (jvm, obj) => { obj.map = new Map(); obj.entries = obj.map; obj.sizeCache = 0; },
    '<init>(Ljava/util/Map;)V': (jvm, obj, args) => {
      obj.map = new Map(); obj.entries = obj.map; obj.sizeCache = 0;
      const src = args[0];
      if (src && src.map instanceof Map) {
        for (const [k, v] of src.map.entries()) obj.map.set(k, v);
      }
      obj.sizeCache = obj.map.size;
    },
  },
};
