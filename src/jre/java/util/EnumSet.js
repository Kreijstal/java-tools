function valuesFromArray(array) {
  return Array.isArray(array) ? array.filter(v => v !== null && v !== undefined) : [];
}

module.exports = {
  super: 'java/util/HashSet',
  interfaces: ['java/util/Set'],
  staticMethods: {
    'noneOf(Ljava/lang/Class;)Ljava/util/EnumSet;': (jvm) => ({ type: 'java/util/EnumSet', set: new Set(), items: new Set(), hashCode: jvm.nextHashCode++ }),
    'allOf(Ljava/lang/Class;)Ljava/util/EnumSet;': (jvm, obj, args) => {
      const enumClass = args[0];
      const constantsMethod = jvm._jreFindMethod('java/lang/Class', 'getEnumConstants', '()[Ljava/lang/Object;');
      const constants = constantsMethod ? constantsMethod(jvm, enumClass, []) : [];
      const set = new Set(valuesFromArray(constants));
      return { type: 'java/util/EnumSet', set, items: set, hashCode: jvm.nextHashCode++ };
    },
    'of(Ljava/lang/Enum;)Ljava/util/EnumSet;': (jvm, obj, args) => {
      const set = new Set([args[0]]);
      return { type: 'java/util/EnumSet', set, items: set, hashCode: jvm.nextHashCode++ };
    },
    'copyOf(Ljava/util/Collection;)Ljava/util/EnumSet;': (jvm, obj, args) => {
      const src = args[0];
      const values = src && src.set instanceof Set ? Array.from(src.set) : (Array.isArray(src && src.array) ? src.array : []);
      const set = new Set(values);
      return { type: 'java/util/EnumSet', set, items: set, hashCode: jvm.nextHashCode++ };
    },
    'copyOf(Ljava/util/EnumSet;)Ljava/util/EnumSet;': (jvm, obj, args) => {
      const src = args[0];
      const values = src && src.set instanceof Set ? Array.from(src.set) : [];
      const set = new Set(values);
      return { type: 'java/util/EnumSet', set, items: set, hashCode: jvm.nextHashCode++ };
    },
  },
  methods: {
    '<init>()V': (jvm, obj) => { obj.set = new Set(); obj.items = obj.set; },
  },
};
