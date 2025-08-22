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
    "valueOf(D)Ljava/lang/String;": (jvm, obj, args) => {
      // Defer to Double.toString for proper formatting
      const doubleClass = jvm.getStatic('java/lang/Double');
      return doubleClass.staticMethods['toString(D)Ljava/lang/String;'](jvm, null, args);
    },
    "valueOf(I)Ljava/lang/String;": (jvm, obj, args) => {
      // Defer to Integer.toString for proper formatting
      const integerClass = jvm.getStatic('java/lang/Integer');
      return integerClass.staticMethods['toString(I)Ljava/lang/String;'](jvm, null, args);
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
    "concat(Ljava/lang/String;)Ljava/lang/String;": (jvm, obj, args) => {
      return jvm.internString(obj + args[0]);
    },
    "toUpperCase()Ljava/lang/String;": (jvm, obj, args) => {
      return jvm.internString(obj.toUpperCase());
    },
    "toLowerCase()Ljava/lang/String;": (jvm, obj, args) => {
      return jvm.internString(obj.toLowerCase());
    },
    "length()I": (jvm, obj, args) => {
      return obj.length;
    },
    "charAt(I)C": (jvm, obj, args) => {
      const index = args[0];
      if (index < 0 || index >= obj.length) {
        throw {
          type: 'java/lang/StringIndexOutOfBoundsException',
          message: `String index out of range: ${index}`,
        };
      }
      return obj.charCodeAt(index);
    },
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
  },
};
