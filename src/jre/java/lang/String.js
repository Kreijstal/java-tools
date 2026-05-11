const { withThrows } = require('../../helpers');

function stringValue(obj) {
  if (obj === null || obj === undefined) {
    return '';
  }
  if (obj && obj.type === 'java/lang/String' && Object.prototype.hasOwnProperty.call(obj, 'value')) {
    return String(obj.value);
  }
  return String(obj);
}

function setStringValue(obj, value) {
  obj.value = String(value);
  obj.toString = function() { return String(this.value); };
}

function byteArrayValue(bytes) {
  if (bytes && bytes.array) {
    return bytes.array;
  }
  if (Array.isArray(bytes)) {
    return bytes;
  }
  throw {
    type: 'java/lang/IllegalArgumentException',
    message: 'Invalid byte array format for String constructor',
  };
}

function bytesToString(bytes, offset, length) {
  const relevantBytes = byteArrayValue(bytes).slice(offset, offset + length).map((b) => b & 0xff);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(relevantBytes).toString('utf8');
  }
  let str = '';
  for (let i = 0; i < relevantBytes.length; i++) {
    str += String.fromCharCode(relevantBytes[i]);
  }
  return str;
}

module.exports = {
  super: "java/lang/Object",
  interfaces: [
    "java/lang/CharSequence",
    "java/io/Serializable",
    "java/lang/Comparable",
  ],
  staticFields: {},
  staticMethods: {
    "valueOf(Ljava/lang/Object;)Ljava/lang/String;": (jvm, obj, args) => {
      const value = args[0];
      if (value === null) {
        return jvm.internString("null");
      }
      if (typeof value === "string") {
        return value; // Already a string
      }
      return jvm.internString(stringValue(value));
    },
    "valueOf(C)Ljava/lang/String;": (jvm, obj, args) => {
      const charCode = args[0];
      const charStr = String.fromCharCode(charCode);
      return jvm.internString(charStr);
    },
  },
  methods: {
    "<init>()V": (jvm, obj, args) => {
      // Default constructor - creates empty string
      // The obj should already be a String object, just ensure it has the right value
      setStringValue(obj, '');
    },
    "<init>(Ljava/lang/String;)V": (jvm, obj, args) => {
      // String constructor with another string
      const sourceString = args[0];
      setStringValue(obj, sourceString ? stringValue(sourceString) : '');
    },
    "<init>([C)V": (jvm, obj, args) => {
      // String constructor with char array
      const charArray = args[0];
      setStringValue(obj, charArray ? String.fromCharCode.apply(null, charArray) : '');
    },
    '<init>([B)V': withThrows((jvm, obj, args) => {
      const bytes = args[0];
      setStringValue(obj, bytesToString(bytes, 0, byteArrayValue(bytes).length));
    }, ['java/lang/IllegalArgumentException']),
    '<init>([BII)V': withThrows((jvm, obj, args) => {
      const bytes = args[0];
      const offset = args[1];
      const length = args[2];
      setStringValue(obj, bytesToString(bytes, offset, length));
    }, ['java/lang/IllegalArgumentException']),
    '<init>([BIILjava/lang/String;)V': withThrows((jvm, obj, args) => {
      const bytes = args[0];
      const offset = args[1];
      const length = args[2];
      setStringValue(obj, bytesToString(bytes, offset, length));
    }, ['java/lang/IllegalArgumentException']),
    '<init>([BIILjava/nio/charset/Charset;)V': withThrows((jvm, obj, args) => {
      const bytes = args[0];
      const offset = args[1];
      const length = args[2];
      setStringValue(obj, bytesToString(bytes, offset, length));
    }, ['java/lang/IllegalArgumentException']),
    '<init>([BLjava/lang/String;)V': withThrows((jvm, obj, args) => {
      const bytes = args[0];
      setStringValue(obj, bytesToString(bytes, 0, byteArrayValue(bytes).length));
    }, ['java/lang/IllegalArgumentException']),
    '<init>([BLjava/nio/charset/Charset;)V': withThrows((jvm, obj, args) => {
      const bytes = args[0];
      setStringValue(obj, bytesToString(bytes, 0, byteArrayValue(bytes).length));
    }, ['java/lang/IllegalArgumentException']),
    '<init>([CII)V': withThrows((jvm, obj, args) => {
      const charArray = args[0];
      const offset = args[1];
      const count = args[2];
      setStringValue(obj, String.fromCharCode.apply(null, charArray.slice(offset, offset + count)));
    }, ['java/lang/IndexOutOfBoundsException']),
    '<init>(Ljava/lang/StringBuilder;)V': (jvm, obj, args) => {
      setStringValue(obj, stringValue(args[0]));
    },
    '<init>(Ljava/lang/StringBuffer;)V': (jvm, obj, args) => {
      setStringValue(obj, stringValue(args[0]));
    },
    "toString()Ljava/lang/String;": (jvm, obj, args) => {
      return obj && obj.type === 'java/lang/String' ? obj : jvm.internString(stringValue(obj));
    },
    "concat(Ljava/lang/String;)Ljava/lang/String;": (jvm, obj, args) => {
      return jvm.internString(stringValue(obj) + stringValue(args[0]));
    },
    "toUpperCase()Ljava/lang/String;": (jvm, obj, args) => {
      return jvm.internString(stringValue(obj).toUpperCase());
    },
    "toLowerCase()Ljava/lang/String;": (jvm, obj, args) => {
      return jvm.internString(stringValue(obj).toLowerCase());
    },
    "repeat(I)Ljava/lang/String;": (jvm, obj, args) => {
      const count = args[0];
      return jvm.internString(stringValue(obj).repeat(count));
    },
    "length()I": (jvm, obj, args) => {
      return stringValue(obj).length;
    },
    "charAt(I)C": withThrows((jvm, obj, args) => {
      const value = stringValue(obj);
      const index = args[0];
      if (index < 0 || index >= value.length) {
        throw {
          type: 'java/lang/StringIndexOutOfBoundsException',
          message: `String index out of range: ${index}`,
        };
      }
      return value.charCodeAt(index);
    }, ['java/lang/StringIndexOutOfBoundsException']),
    "equals(Ljava/lang/Object;)Z": (jvm, obj, args) => {
      const other = args[0];
      if (other === null) return 0;
      if (other === obj) return 1; // Same reference

      // Check if the other object is a String
      if (typeof other === 'string') {
        return obj.toString() === other ? 1 : 0;
      }

      // If it's a String object, compare the string values
      if (other.type === 'java/lang/String' || other instanceof String) {
        return obj.toString() === other.toString() ? 1 : 0;
      }

      return 0;
    },
    "substring(II)Ljava/lang/String;": (jvm, obj, args) => {
      const startIndex = args[0];
      const endIndex = args[1];
      const result = stringValue(obj).substring(startIndex, endIndex);
      return jvm.internString(result);
    },
    "compareTo(Ljava/lang/String;)I": (jvm, obj, args) => {
      const otherString = args[0];
      return stringValue(obj).localeCompare(stringValue(otherString));
    },
    "compareTo(Ljava/lang/Object;)I": (jvm, obj, args) => {
      const otherString = args[0];
      return stringValue(obj).localeCompare(stringValue(otherString));
    },
    "getClass()Ljava/lang/Class;": (jvm, obj, args) => {
      return {
        type: "java/lang/Class",
        className: "java.lang.String",
        getSimpleName: function () {
          return jvm.internString("String");
        },
      };
    },
    "hashCode()I": (jvm, obj, args) => {
      const value = stringValue(obj);
      let hash = 0;
      for (let i = 0; i < value.length; i++) {
        hash = (31 * hash + value.charCodeAt(i)) | 0;
      }
      return hash;
    },
    "split(Ljava/lang/String;)[Ljava/lang/String;": (jvm, obj, args) => {
      const separator = args[0];

      // Handle Java regex patterns - convert to JavaScript regex
      let regexPattern = separator;

      // Special handling for common Java patterns
      if (separator === "\\s+") {
        // Split on whitespace - use JavaScript whitespace regex
        regexPattern = "\\s+";
      } else if (separator === "\\s") {
        // Split on single whitespace character
        regexPattern = "\\s";
      } else if (separator === "\\.") {
        // Split on literal dot
        regexPattern = "\\.";
      } else {
        // For other patterns, use as-is but handle Java escape sequences
        // Java uses double backslashes for regex patterns in strings
        regexPattern = separator.replace(/\\\\/g, "\\");
      }

      // Trim empty strings from the result to match Java behavior
      const parts = stringValue(obj)
        .split(new RegExp(regexPattern))
        .filter((part) => part !== "");

      // Create a Java string array
      const array = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        array[i] = jvm.internString(parts[i]);
      }

      // Set array type for proper runtime behavior
      array.type = "[Ljava/lang/String;";
      array.elementType = "java/lang/String";
      array.length = parts.length;
      array.hashCode = jvm.nextHashCode++;

      return array;
    },
    "intern()Ljava/lang/String;": (jvm, obj, args) => {
      // Return the interned version of this string
      return jvm.internString(stringValue(obj));
    },
    "indexOf(I)I": (jvm, obj, args) => {
      const ch = args[0];
      const char = String.fromCharCode(ch);
      return stringValue(obj).indexOf(char);
    },
    "lastIndexOf(I)I": (jvm, obj, args) => {
      const ch = args[0];
      const char = String.fromCharCode(ch);
      return stringValue(obj).lastIndexOf(char);
    },
    "trim()Ljava/lang/String;": (jvm, obj, args) => {
      return jvm.internString(stringValue(obj).trim());
    },
    "startsWith(Ljava/lang/String;)Z": withThrows((jvm, obj, args) => {
      const prefix = args[0];
      if (prefix === null) {
        throw { type: 'java/lang/NullPointerException' };
      }
      return stringValue(obj).startsWith(prefix.toString()) ? 1 : 0;
    }, ['java/lang/NullPointerException']),
    "endsWith(Ljava/lang/String;)Z": withThrows((jvm, obj, args) => {
      const suffix = args[0];
      if (suffix === null) {
        throw { type: 'java/lang/NullPointerException' };
      }
      return stringValue(obj).endsWith(suffix.toString()) ? 1 : 0;
    }, ['java/lang/NullPointerException']),
    "replace(CC)Ljava/lang/String;": (jvm, obj, args) => {
      const oldChar = String.fromCharCode(args[0]);
      const newChar = String.fromCharCode(args[1]);
      // Replace all occurrences of oldChar with newChar
      const result = stringValue(obj).split(oldChar).join(newChar);
      return jvm.internString(result);
    },
    "regionMatches(ILjava/lang/String;II)Z": withThrows((jvm, obj, args) => {
      const toffset = args[0];
      const other = args[1];
      const ooffset = args[2];
      const len = args[3];

      if (other === null) {
        throw { type: 'java/lang/NullPointerException' };
      }

      // Check bounds
      if (toffset < 0 || ooffset < 0 ||
          toffset + len > stringValue(obj).length ||
          ooffset + len > other.length) {
        return 0;
      }

      // Compare the regions
      const thisRegion = stringValue(obj).substring(toffset, toffset + len);
      const otherRegion = other.toString().substring(ooffset, ooffset + len);
      return thisRegion === otherRegion ? 1 : 0;
    }, ['java/lang/NullPointerException']),
    "getBytes(Ljava/nio/charset/Charset;)[B": (jvm, obj, args) => {
      const charset = args[0];
      // For simplicity, we'll use UTF-8 encoding regardless of charset
      // In a full implementation, we'd need to handle different charsets
      const encoder = new TextEncoder();
      const bytes = encoder.encode(stringValue(obj));

      // Create a Java byte array
      const byteArray = Array.from(bytes);
      byteArray.type = "[B";
      byteArray.elementType = "byte";
      byteArray.length = bytes.length;
      byteArray.hashCode = jvm.nextHashCode++;

      return byteArray;
    },
    "getBytes()[B": (jvm, obj, args) => {
      // Default getBytes() method - uses UTF-8 encoding
      const encoder = new TextEncoder();
      const bytes = encoder.encode(stringValue(obj));

      // Create a Java byte array
      const byteArray = Array.from(bytes);
      byteArray.type = "[B";
      byteArray.elementType = "byte";
      byteArray.length = bytes.length;
      byteArray.hashCode = jvm.nextHashCode++;

      return byteArray;
    },
    "getBytes(Ljava/lang/String;)[B": (jvm, obj, args) => {
      const charsetName = args[0];
      // For simplicity, we'll use UTF-8 encoding regardless of charset name
      // In a full implementation, we'd need to handle different charsets
      const encoder = new TextEncoder();
      const bytes = encoder.encode(stringValue(obj));

      // Create a Java byte array
      const byteArray = Array.from(bytes);
      byteArray.type = "[B";
      byteArray.elementType = "byte";
      byteArray.length = bytes.length;
      byteArray.hashCode = jvm.nextHashCode++;

      return byteArray;
    },
  },
};
