module.exports = {
  super: {
    type: 'java/util/AbstractMap'
  },
  methods: {
    '<init>()V': (jvm, obj, args, thread) => {
      obj.map = new Map();
      obj.sizeCache = 0;
    },
    '<init>(I)V': (jvm, obj, args, thread) => {
      obj.map = new Map();
      obj.sizeCache = 0;
      // Initial capacity is ignored in this simple implementation
    },
    'size()I': (jvm, obj, args) => {
      return obj.map.size;
    },
    'isEmpty()Z': (jvm, obj, args) => {
      return obj.map.size === 0 ? 1 : 0; // true : false
    },
    'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const key = args[0];
      const value = args[1];
      const oldValue = obj.map.get(key);
      obj.map.set(key, value);
      return oldValue;
    },
    'get(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const key = args[0];
      return obj.map.get(key);
    },
    'containsKey(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const key = args[0];
      return obj.map.has(key) ? 1 : 0; // true : false
    },
    'containsValue(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const value = args[0];
      for (let v of obj.map.values()) {
        if (v === value) {
          return 1; // true
        }
      }
      return 0; // false
    },
    'remove(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const key = args[0];
      const oldValue = obj.map.get(key);
      obj.map.delete(key);
      return oldValue;
    },
    'clear()V': (jvm, obj, args) => {
      obj.map.clear();
    },
    'keySet()Ljava/util/Set;': (jvm, obj, args) => {
      const keys = Array.from(obj.map.keys());
      return {
        type: 'java/util/HashSet',
        items: new Set(keys)
      };
    },
    'values()Ljava/util/Collection;': (jvm, obj, args) => {
      const values = Array.from(obj.map.values());
      return {
        type: 'java/util/ArrayList',
        items: values,
        size: values.length
      };
    },
    'entrySet()Ljava/util/Set;': (jvm, obj, args) => {
      const entries = Array.from(obj.map.entries()).map(([key, value]) => ({
        type: 'java/util/Map$Entry',
        key: key,
        value: value
      }));
      return {
        type: 'java/util/HashSet',
        items: new Set(entries)
      };
    },
    'putIfAbsent(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const key = args[0];
      const value = args[1];

      if (!obj.map.has(key)) {
        obj.map.set(key, value);
        return null;
      }
      return obj.map.get(key);
    },
    'replace(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const key = args[0];
      const value = args[1];

      if (obj.map.has(key)) {
        const oldValue = obj.map.get(key);
        obj.map.set(key, value);
        return oldValue;
      }
      return null;
    },
    'computeIfAbsent(Ljava/lang/Object;Ljava/util/function/Function;)Ljava/lang/Object;': (jvm, obj, args) => {
      const key = args[0];
      const mappingFunction = args[1];

      if (!obj.map.has(key) && mappingFunction) {
        try {
          const newValue = mappingFunction.methods['apply(Ljava/lang/Object;)Ljava/lang/Object;'](null, mappingFunction, [key]);
          obj.map.set(key, newValue);
          return newValue;
        } catch (e) {
          return null;
        }
      }
      return obj.map.get(key);
    },
    'getOrDefault(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const key = args[0];
      const defaultValue = args[1];
      return obj.map.get(key) || defaultValue;
    }
  },
  staticFields: {
    DEFAULT_LOAD_FACTOR: 0.75,
    DEFAULT_INITIAL_CAPACITY: 16
  }
};