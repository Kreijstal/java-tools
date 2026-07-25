module.exports = {
  super: 'java/util/HashSet',
  interfaces: ['java/util/Set'],
  methods: {
    '<init>()V': (jvm, obj) => { obj.set = new Set(); obj.items = obj.set; },
    '<init>(I)V': (jvm, obj) => { obj.set = new Set(); obj.items = obj.set; },
    '<init>(IF)V': (jvm, obj) => { obj.set = new Set(); obj.items = obj.set; },
    '<init>(Ljava/util/Collection;)V': (jvm, obj, args) => {
      obj.set = new Set();
      const c = args[0];
      const values = c && c.set instanceof Set ? Array.from(c.set) :
        c && c.items instanceof Set ? Array.from(c.items) :
        c && Array.isArray(c.items) ? c.items :
        c && Array.isArray(c.array) ? c.array : [];
      for (const value of values) obj.set.add(value);
      obj.items = obj.set;
    },
  },
  staticFields: {},
};
