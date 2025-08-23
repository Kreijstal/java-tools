module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    'clone()Ljava/lang/Object;': (jvm, obj, args) => {
      // Array cloning implementation for int arrays
      if (Array.isArray(obj) || (obj.type && obj.type === '[I')) {
        const cloned = [...obj]; // Shallow copy of array elements
        cloned.type = '[I';
        cloned.length = obj.length;
        cloned.hashCode = jvm.nextHashCode++;
        return cloned;
      }
      
      // Fallback - shouldn't happen for int arrays
      return Object.assign({}, obj);
    },
  },
};