module.exports = {
  super: 'java/util/HashMap',
  interfaces: ['java/util/Map'],
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.map = new Map();
      obj.order = [];
    },
    '<init>(I)V': (jvm, obj) => {
      obj.map = new Map();
      obj.order = [];
    },
    '<init>(IF)V': (jvm, obj) => {
      obj.map = new Map();
      obj.order = [];
    },
    '<init>(IFZ)V': (jvm, obj) => {
      obj.map = new Map();
      obj.order = [];
    },
    '<init>(Ljava/util/Map;)V': (jvm, obj, args) => {
      obj.map = new Map();
      obj.order = [];
      const other = args[0];
      const source = other && (other.map || other.entries);
      if (source) {
        for (const [key, value] of source.entries()) {
          if (!obj.map.has(key)) obj.order.push(key);
          obj.map.set(key, value);
        }
      }
    },
  },
  staticFields: {},
};
