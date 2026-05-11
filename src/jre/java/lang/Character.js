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
    "isJavaIdentifierStart(C)Z": (jvm, obj, args) => {
      const ch = String.fromCharCode(args[0]);
      return /[A-Za-z_$]/.test(ch) ? 1 : 0;
    },
    "isJavaIdentifierStart(I)Z": (jvm, obj, args) => {
      const ch = String.fromCodePoint(args[0]);
      return /[A-Za-z_$]/.test(ch) ? 1 : 0;
    },
    "isJavaIdentifierPart(C)Z": (jvm, obj, args) => {
      const ch = String.fromCharCode(args[0]);
      return /[A-Za-z0-9_$]/.test(ch) ? 1 : 0;
    },
    "isJavaIdentifierPart(I)Z": (jvm, obj, args) => {
      const ch = String.fromCodePoint(args[0]);
      return /[A-Za-z0-9_$]/.test(ch) ? 1 : 0;
    },
    "isDigit(C)Z": (jvm, obj, args) => /[0-9]/.test(String.fromCharCode(args[0])) ? 1 : 0,
    "isLetter(C)Z": (jvm, obj, args) => /[A-Za-z]/.test(String.fromCharCode(args[0])) ? 1 : 0,
    "isLetterOrDigit(C)Z": (jvm, obj, args) => /[A-Za-z0-9]/.test(String.fromCharCode(args[0])) ? 1 : 0,
    "isIdentifierIgnorable(C)Z": (jvm, obj, args) => {
      const ch = args[0];
      return ((ch >= 0 && ch <= 8) || (ch >= 14 && ch <= 27) || (ch >= 127 && ch <= 159)) ? 1 : 0;
    },
    "isIdentifierIgnorable(I)Z": (jvm, obj, args) => {
      const ch = args[0];
      return ((ch >= 0 && ch <= 8) || (ch >= 14 && ch <= 27) || (ch >= 127 && ch <= 159)) ? 1 : 0;
    },
  },
};
