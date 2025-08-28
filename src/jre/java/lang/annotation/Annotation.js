module.exports = {
  super: null,
  methods: {
    '<init>()V': (jvm, obj, args) => {
      // Annotation constructor - annotations are typically marker interfaces
    },
    'annotationType()Ljava/lang/Class;': (jvm, obj, args) => {
      // Return the class object for this annotation type
      return {
        type: 'java/lang/Class',
        _classData: {
          name: obj.type,
          className: obj.type.replace(/\//g, '.')
        }
      };
    },
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const other = args[0];
      if (other === null || other.type !== obj.type) {
        return 0; // false
      }

      // Compare annotation element values
      if (obj.values && other.values) {
        for (const key of Object.keys(obj.values)) {
          if (obj.values[key] !== other.values[key]) {
            return 0; // false
          }
        }
      }

      return 1; // true
    },
    'hashCode()I': (jvm, obj, args) => {
      let hash = obj.type.hashCode();
      if (obj.values) {
        for (const [key, value] of Object.entries(obj.values)) {
          hash ^= (key.hashCode() ^ hash) + (typeof value === 'string' ? value.hashCode() : value);
        }
      }
      return hash;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const className = obj.type.replace(/\//g, '.');
      if (!obj.values || Object.keys(obj.values).length === 0) {
        return jvm.internString('@' + className);
      }

      let result = '@' + className + '(';
      const entries = Object.entries(obj.values);
      for (let i = 0; i < entries.length; i++) {
        const [key, value] = entries[i];
        result += key + '=' + value;
        if (i < entries.length - 1) {
          result += ', ';
        }
      }
      result += ')';
      return jvm.internString(result);
    }
  },
  staticFields: {},
  interfaces: []
};