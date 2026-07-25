const { withThrows } = require('../../../helpers');

module.exports = {
  super: {
    type: 'java/lang/Enum'
  },
  staticFields: {
    TYPE: {
      name: 'TYPE',
      ordinal: 0,
      type: 'java/lang/annotation/ElementType'
    },
    FIELD: {
      name: 'FIELD',
      ordinal: 1,
      type: 'java/lang/annotation/ElementType'
    },
    METHOD: {
      name: 'METHOD',
      ordinal: 2,
      type: 'java/lang/annotation/ElementType'
    },
    PARAMETER: {
      name: 'PARAMETER',
      ordinal: 3,
      type: 'java/lang/annotation/ElementType'
    },
    CONSTRUCTOR: {
      name: 'CONSTRUCTOR',
      ordinal: 4,
      type: 'java/lang/annotation/ElementType'
    },
    LOCAL_VARIABLE: {
      name: 'LOCAL_VARIABLE',
      ordinal: 5,
      type: 'java/lang/annotation/ElementType'
    },
    ANNOTATION_TYPE: {
      name: 'ANNOTATION_TYPE',
      ordinal: 6,
      type: 'java/lang/annotation/ElementType'
    },
    PACKAGE: {
      name: 'PACKAGE',
      ordinal: 7,
      type: 'java/lang/annotation/ElementType'
    }
  },
  staticMethods: {
    'values()[Ljava/lang/annotation/ElementType;': () => {
      return [
        module.exports.staticFields.TYPE,
        module.exports.staticFields.FIELD,
        module.exports.staticFields.METHOD,
        module.exports.staticFields.PARAMETER,
        module.exports.staticFields.CONSTRUCTOR,
        module.exports.staticFields.LOCAL_VARIABLE,
        module.exports.staticFields.ANNOTATION_TYPE,
        module.exports.staticFields.PACKAGE
      ];
    },
    'valueOf(Ljava/lang/String;)Ljava/lang/annotation/ElementType;': withThrows((jvm, obj, args) => {
      const name = args[0];
      switch (name) {
        case 'TYPE': return module.exports.staticFields.TYPE;
        case 'FIELD': return module.exports.staticFields.FIELD;
        case 'METHOD': return module.exports.staticFields.METHOD;
        case 'PARAMETER': return module.exports.staticFields.PARAMETER;
        case 'CONSTRUCTOR': return module.exports.staticFields.CONSTRUCTOR;
        case 'LOCAL_VARIABLE': return module.exports.staticFields.LOCAL_VARIABLE;
        case 'ANNOTATION_TYPE': return module.exports.staticFields.ANNOTATION_TYPE;
        case 'PACKAGE': return module.exports.staticFields.PACKAGE;
        default:
          throw {
            type: 'java/lang/IllegalArgumentException',
            message: `No enum constant java.lang.annotation.ElementType.${name}`
          };
      }
    }, ['java/lang/IllegalArgumentException'])
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
