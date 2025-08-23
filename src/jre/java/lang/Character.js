module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'char',
    },
  },
  methods: {},
  staticMethods: {
    "toUpperCase(C)C": (jvm, obj, args) => {
      const ch = args[0];
      const charStr = String.fromCharCode(ch);
      return charStr.toUpperCase().charCodeAt(0);
    },
    "toLowerCase(C)C": (jvm, obj, args) => {
      const ch = args[0];
      const charStr = String.fromCharCode(ch);
      return charStr.toLowerCase().charCodeAt(0);
    },
    "isISOControl(C)Z": (jvm, obj, args) => {
      const ch = args[0];
      // ISO control characters are in ranges [0, 31] and [127, 159]
      return ((ch >= 0 && ch <= 31) || (ch >= 127 && ch <= 159)) ? 1 : 0;
    },
  },
};
