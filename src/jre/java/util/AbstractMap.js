module.exports = {
  super: {
    type: 'java/lang/Object'
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.entries = new Map();
    },
    'size()I': (jvm, obj, args) => {
      return obj.entries.size;
    },
    'isEmpty()Z': (jvm, obj, args) => {
      return obj.entries.size === 0 ? 1 : 0;
    },
    'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const key = args[0];
      const value = args[1];
      const oldValue = obj.entries.get(key);
      obj.entries.set(key, value);
      return oldValue;
    },
    'get(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      return obj.entries.get(args[0]);
    },
    'containsKey(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      return obj.entries.has(args[0]) ? 1 : 0;
    },
    'remove(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const oldValue = obj.entries.get(args[0]);
      obj.entries.delete(args[0]);
      return oldValue;
    },
    'clear()V': (jvm, obj, args) => {
      obj.entries.clear();
    },
    'entrySet()Ljava/util/Set;': (jvm, obj, args) => {
      const entries = Array.from(obj.entries.entries()).map(([key, value]) => ({
        type: 'java/util/Map$Entry',
        key: key,
        value: value,
        getKey: () => key,
        getValue: () => value,
        setValue: (newValue) => {
          obj.entries.set(key, newValue);
          return value;
        }
      }));

      return {
        type: 'java/util/HashSet',
        items: new Set(entries)
      };
    },
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const other = args[0];
      if (other === obj) return 1;

      if (!other || other.type !== obj.type) return 0;

      if (obj.entries.size !== other.entries.size) return 0;

      for (let [key, value] of obj.entries) {
        if (!other.entries.has(key)) return 0;
        if (other.entries.get(key) !== value) return 0;
      }

      return 1;
    },
    'hashCode()I': (jvm, obj, args) => {
      let hash = 0;
      for (let [key, value] of obj.entries) {
        hash ^= (key ? key.hashCode() : 0) + (value ? value.toString().length : 0);
      }
      return hash;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      if (obj.entries.size === 0) {
        return jvm.internString("{}");
      }

      let result = "{";
      let first = true;
      for (let [key, value] of obj.entries) {
        if (!first) result += ", ";
        result += (key || "null") + "=" + (value || "null");
        first = false;
      }
      result += "}";

      return jvm.internString(result);
    },
    'keySet()Ljava/util/Set;': (jvm, obj, args) => {
      return {
        type: 'java/util/HashSet',
        items: new Set(obj.entries.keys())
      };
    },
    'values()Ljava/util/Collection;': (jvm, obj, args) => {
      return {
        type: 'java/util/ArrayList',
        items: Array.from(obj.entries.values()),
        size: obj.entries.size
      };
    }
  },
  staticFields: {}
};