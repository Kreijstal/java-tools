module.exports = {
  super: {
    type: 'java/lang/Enum'
  },
  staticFields: {
    SOURCE: {
      name: 'SOURCE',
      ordinal: 0,
      type: 'java/lang/annotation/RetentionPolicy'
    },
    CLASS: {
      name: 'CLASS',
      ordinal: 1,
      type: 'java/lang/annotation/RetentionPolicy'
    },
    RUNTIME: {
      name: 'RUNTIME',
      ordinal: 2,
      type: 'java/lang/annotation/RetentionPolicy'
    }
  },
  staticMethods: {
    'values()[Ljava/lang/annotation/RetentionPolicy;': () => {
      return [
        module.exports.staticFields.SOURCE,
        module.exports.staticFields.CLASS,
        module.exports.staticFields.RUNTIME
      ];
    },
    'valueOf(Ljava/lang/String;)Ljava/lang/annotation/RetentionPolicy;': (jvm, obj, args) => {
      const name = args[0];
      switch (name) {
        case 'SOURCE': return module.exports.staticFields.SOURCE;
        case 'CLASS': return module.exports.staticFields.CLASS;
        case 'RUNTIME': return module.exports.staticFields.RUNTIME;
        default:
          throw {
            type: 'java/lang/IllegalArgumentException',
            message: `No enum constant java.lang.annotation.RetentionPolicy.${name}`
          };
      }
    }
  },
  methods: {
    'name()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.name);
    },
    'ordinal()I': (jvm, obj, args) => {
      return obj.ordinal;
    },
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      return obj === args[0] ? 1 : 0;
    },
    'hashCode()I': (jvm, obj, args) => {
      return obj.hashCode || (obj.name.hashCode() ^ obj.ordinal);
    }
  },
  interfaces: []
};