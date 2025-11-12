const { withThrows } = require('../../helpers');

module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.value = '';
      delete obj.isUninitialized;
    },
    '<init>(Ljava/lang/String;)V': withThrows((jvm, obj, args) => {
      const str = args[0];
      if (str === null) {
        throw { type: 'java/lang/NullPointerException' };
      }
      obj.value = String(str);
      delete obj.isUninitialized;
    }, ['java/lang/NullPointerException']),
    'append(Ljava/lang/String;)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      const str = args[0];
      obj.value += str;
      return obj;
    },
    'append(I)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      const int = args[0];
      obj.value += int;
      return obj;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      const strObj = new String(obj.value);
      strObj.type = 'java/lang/String';
      return strObj;
    },
    'reverse()Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      // Unicode-aware reversal using Array.from to handle surrogate pairs and combining marks
      obj.value = Array.from(obj.value).reverse().join('');
      return obj;
    },
    'length()I': (jvm, obj, args) => {
      return obj.value.length;
    },
    'charAt(I)C': withThrows((jvm, obj, args) => {
      const index = args[0];
      if (index < 0 || index >= obj.value.length) {
        throw {
          type: 'java/lang/StringIndexOutOfBoundsException',
          message: `String index out of range: ${index}`,
        };
      }
      return obj.value.charCodeAt(index);
    }, ['java/lang/StringIndexOutOfBoundsException']),
    'setCharAt(IC)V': withThrows((jvm, obj, args) => {
      const index = args[0];
      const ch = args[1];
      if (index < 0 || index >= obj.value.length) {
        throw {
          type: 'java/lang/StringIndexOutOfBoundsException',
          message: `String index out of range: ${index}`,
        };
      }
      // Convert the string to an array, replace the character, and join back
      const chars = Array.from(obj.value);
      chars[index] = String.fromCharCode(ch);
      obj.value = chars.join('');
    }, ['java/lang/StringIndexOutOfBoundsException']),
    'setLength(I)V': withThrows((jvm, obj, args) => {
      const newLength = args[0];
      if (newLength < 0) {
        throw {
          type: 'java/lang/StringIndexOutOfBoundsException',
          message: `String index out of range: ${newLength}`,
        };
      }
      if (newLength > obj.value.length) {
        // Pad with null characters (char 0)
        obj.value += '\0'.repeat(newLength - obj.value.length);
      } else {
        // Truncate the string
        obj.value = obj.value.substring(0, newLength);
      }
    }, ['java/lang/StringIndexOutOfBoundsException']),
  },
};
