module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'TYPE:Ljava/lang/Class;': {
      type: 'java/lang/Class',
      isPrimitive: true,
      name: 'char',
    },
    'MAX_VALUE:C': 65535,
    'MIN_VALUE:C': 0,
  },
  methods: {
    "charValue()C": (jvm, obj) => obj.value,
    "toString()Ljava/lang/String;": (jvm, obj) => jvm.newString(String.fromCharCode(obj.value)),
  },
  staticMethods: {
    "valueOf(C)Ljava/lang/Character;": (jvm, obj, args) => ({
      type: 'java/lang/Character',
      value: args[0],
      toString() {
        return String.fromCharCode(this.value);
      },
    }),
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
    "forDigit(II)C": (jvm, obj, args) => {
      const digit = args[0];
      const radix = args[1];
      if (radix < 2 || radix > 36 || digit < 0 || digit >= radix) return 0;
      return (digit < 10 ? 48 + digit : 97 + digit - 10);
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
    "isLowerCase(C)Z": (jvm, obj, args) => {
      const value = String.fromCharCode(args[0]);
      return value.toLowerCase() === value && value.toUpperCase() !== value ? 1 : 0;
    },
    "isLowerCase(I)Z": (jvm, obj, args) => {
      const value = String.fromCodePoint(args[0]);
      return value.toLowerCase() === value && value.toUpperCase() !== value ? 1 : 0;
    },
    "isUpperCase(C)Z": (jvm, obj, args) => {
      const value = String.fromCharCode(args[0]);
      return value.toUpperCase() === value && value.toLowerCase() !== value ? 1 : 0;
    },
    "isUpperCase(I)Z": (jvm, obj, args) => {
      const value = String.fromCodePoint(args[0]);
      return value.toUpperCase() === value && value.toLowerCase() !== value ? 1 : 0;
    },
    "isSpaceChar(C)Z": (jvm, obj, args) => {
      const value = args[0];
      return value === 0x20 || value === 0xa0 || value === 0x1680
        || (value >= 0x2000 && value <= 0x200a)
        || value === 0x2028 || value === 0x2029 || value === 0x202f
        || value === 0x205f || value === 0x3000 ? 1 : 0;
    },
    "isSpaceChar(I)Z": (jvm, obj, args) => module.exports.staticMethods['isSpaceChar(C)Z'](jvm, obj, args),
    "isWhitespace(C)Z": (jvm, obj, args) => String.fromCharCode(args[0]).trim().length === 0 ? 1 : 0,
    "isWhitespace(I)Z": (jvm, obj, args) => String.fromCodePoint(args[0]).trim().length === 0 ? 1 : 0,
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
