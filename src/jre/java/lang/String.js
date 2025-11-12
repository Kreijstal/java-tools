const { withThrows } = require('../../helpers');

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
      if (value && typeof value.toString === "function") {
        return jvm.internString(value.toString());
      }
      return jvm.internString(String(value));
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
      if (typeof obj !== 'string') {
        obj.value = "";
        obj.toString = function() { return this.value; };
      }
    },
    "<init>(Ljava/lang/String;)V": (jvm, obj, args) => {
      // String constructor with another string
      const sourceString = args[0];
      if (typeof obj !== 'string') {
        obj.value = sourceString ? sourceString.toString() : "";
        obj.toString = function() { return this.value; };
      }
    },
    "<init>([C)V": (jvm, obj, args) => {
      // String constructor with char array
      const charArray = args[0];
      if (typeof obj !== 'string') {
        obj.value = charArray ? String.fromCharCode.apply(null, charArray) : "";
        obj.toString = function() { return this.value; };
      }
    },
    '<init>([BII)V': withThrows((jvm, obj, args) => {
      const bytes = args[0];
      const offset = args[1];
      const length = args[2];

      let byteArray;
      if (bytes && bytes.array) {
        byteArray = bytes.array;
      } else if (Array.isArray(bytes)) {
        byteArray = bytes;
      } else {
        throw {
          type: 'java/lang/IllegalArgumentException',
          message: 'Invalid byte array format for String constructor',
        };
      }

      const relevantBytes = byteArray.slice(offset, offset + length);

      // In a real implementation, we would use a CharsetDecoder.
      // For now, assume default platform encoding (which is what this does).
      let str = '';
      for (let i = 0; i < relevantBytes.length; i++) {
        str += String.fromCharCode(relevantBytes[i]);
      }

      if (typeof obj !== 'string') {
        obj.value = str;
        obj.toString = function() { return this.value; };
      }
    }, ['java/lang/IllegalArgumentException']),
    "concat(Ljava/lang/String;)Ljava/lang/String;": (jvm, obj, args) => {
      return jvm.internString(obj + args[0]);
    },
    "toUpperCase()Ljava/lang/String;": (jvm, obj, args) => {
      return jvm.internString(obj.toUpperCase());
    },
    "toLowerCase()Ljava/lang/String;": (jvm, obj, args) => {
      return jvm.internString(obj.toLowerCase());
    },
    "repeat(I)Ljava/lang/String;": (jvm, obj, args) => {
      const count = args[0];
      return jvm.internString(obj.repeat(count));
    },
    "length()I": (jvm, obj, args) => {
      return obj.length;
    },
    "charAt(I)C": withThrows((jvm, obj, args) => {
      const index = args[0];
      if (index < 0 || index >= obj.length) {
        throw {
          type: 'java/lang/StringIndexOutOfBoundsException',
          message: `String index out of range: ${index}`,
        };
      }
      return obj.charCodeAt(index);
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
      const result = obj.substring(startIndex, endIndex);
      return jvm.internString(result);
    },
    "compareTo(Ljava/lang/String;)I": (jvm, obj, args) => {
      const otherString = args[0];
      return obj.localeCompare(otherString);
    },
    "compareTo(Ljava/lang/Object;)I": (jvm, obj, args) => {
      const otherString = args[0];
      return obj.localeCompare(otherString);
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
      let hash = 0;
      for (let i = 0; i < obj.length; i++) {
        hash = (31 * hash + obj.charCodeAt(i)) | 0;
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
      const parts = obj
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
      return jvm.internString(obj.toString());
    },
    "indexOf(I)I": (jvm, obj, args) => {
      const ch = args[0];
      const char = String.fromCharCode(ch);
      return obj.indexOf(char);
    },
    "lastIndexOf(I)I": (jvm, obj, args) => {
      const ch = args[0];
      const char = String.fromCharCode(ch);
      return obj.lastIndexOf(char);
    },
    "trim()Ljava/lang/String;": (jvm, obj, args) => {
      return jvm.internString(obj.trim());
    },
    "startsWith(Ljava/lang/String;)Z": withThrows((jvm, obj, args) => {
      const prefix = args[0];
      if (prefix === null) {
        throw { type: 'java/lang/NullPointerException' };
      }
      return obj.startsWith(prefix.toString()) ? 1 : 0;
    }, ['java/lang/NullPointerException']),
    "endsWith(Ljava/lang/String;)Z": withThrows((jvm, obj, args) => {
      const suffix = args[0];
      if (suffix === null) {
        throw { type: 'java/lang/NullPointerException' };
      }
      return obj.endsWith(suffix.toString()) ? 1 : 0;
    }, ['java/lang/NullPointerException']),
    "replace(CC)Ljava/lang/String;": (jvm, obj, args) => {
      const oldChar = String.fromCharCode(args[0]);
      const newChar = String.fromCharCode(args[1]);
      // Replace all occurrences of oldChar with newChar
      const result = obj.split(oldChar).join(newChar);
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
          toffset + len > obj.length || 
          ooffset + len > other.length) {
        return 0;
      }
      
      // Compare the regions
      const thisRegion = obj.substring(toffset, toffset + len);
      const otherRegion = other.toString().substring(ooffset, ooffset + len);
      return thisRegion === otherRegion ? 1 : 0;
    }, ['java/lang/NullPointerException']),
    "getBytes(Ljava/nio/charset/Charset;)[B": (jvm, obj, args) => {
      const charset = args[0];
      // For simplicity, we'll use UTF-8 encoding regardless of charset
      // In a full implementation, we'd need to handle different charsets
      const encoder = new TextEncoder();
      const bytes = encoder.encode(obj.toString());
      
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
      const bytes = encoder.encode(obj.toString());
      
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
      const bytes = encoder.encode(obj.toString());
      
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
