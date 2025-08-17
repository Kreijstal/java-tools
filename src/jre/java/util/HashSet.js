module.exports = {
  super: 'java/util/AbstractSet',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.set = new Set();
    },
    'add(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const value = args[0];
      const hadValue = obj.set.has(value);
      obj.set.add(value);
      return hadValue ? 0 : 1; // return true if the set did not already contain the element
    },
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const other = args[0];
      if (!other || !other.set) {
        return 0;
      }
      if (obj.set.size !== other.set.size) {
        return 0;
      }
      for (const item of obj.set) {
        if (!other.set.has(item)) {
          return 0;
        }
      }
      return 1;
    },
  },
};
