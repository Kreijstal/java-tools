const { withThrows } = require('../../helpers');


function fieldStringValue(obj, fieldName) {
  if (!obj || !obj.fields) return null;
  const keys = Object.keys(obj.fields).filter((key) => key.endsWith(`.${fieldName}`));
  keys.sort((a, b) => (a.startsWith('java/lang/Enum.') ? 1 : 0) - (b.startsWith('java/lang/Enum.') ? 1 : 0));
  for (const key of keys) {
    const value = obj.fields[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') return value;
    if (value && Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
    if (value && value.type === 'java/lang/String') return String(value.valueOf ? value.valueOf() : value);
  }
  return null;
}

function valueAsString(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol") {
    return String(value);
  }
  if (value && value.type === 'java/lang/String' && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return String(value.value);
  }
  if (value && value.type === 'java/lang/String') {
    if (Object.prototype.hasOwnProperty.call(value, 'value')) {
      return String(value.value);
    }
    return String(value.valueOf ? value.valueOf() : value);
  }
  if (value && typeof value === 'object') {
    if (value.type === 'java/lang/Boolean') {
      return value.value ? 'true' : 'false';
    }
    if ((value.type === 'java/lang/Double' || value.type === 'java/lang/Float') && typeof value.toString === 'function') {
      return value.toString();
    }
    if (Object.prototype.hasOwnProperty.call(value, 'value')) {
      return String(value.value);
    }
    const fieldName = fieldStringValue(value, 'name');
    if (fieldName !== null) {
      return fieldName;
    }
    if (value.name) {
      return valueAsString(value.name);
    }
    const type = value._className || value.type;
    if (type) {
      return type.replace(/\//g, '.') + '@' + String(value.hashCode || 0).toString(16);
    }
  }
  if (value && typeof value.toString === "function") {
    try {
      const toStringValue = value.toString();
      if (typeof toStringValue === "string") {
        return toStringValue;
      }
      if (typeof toStringValue === "number" || typeof toStringValue === "boolean" || typeof toStringValue === "bigint" || typeof toStringValue === "symbol") {
        return String(toStringValue);
      }
      if (toStringValue && typeof toStringValue === "object") {
        if (toStringValue.type === "java/lang/String" && Object.prototype.hasOwnProperty.call(toStringValue, "value")) {
          return String(toStringValue.value);
        }
        if (toStringValue.type === "java/lang/String") {
          return String(toStringValue);
        }
      }
    } catch (_) {
      // fall back below
    }
  }
  return String(value);
}

module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.value = '';
      delete obj.isUninitialized;
    },
    '<init>(I)V': withThrows((jvm, obj, args) => {
      if (args[0] < 0) {
        throw { type: 'java/lang/NegativeArraySizeException' };
      }
      obj.value = '';
      obj.capacity = args[0];
      delete obj.isUninitialized;
    }, ['java/lang/NegativeArraySizeException']),
    '<init>(Ljava/lang/String;)V': withThrows((jvm, obj, args) => {
      const str = args[0];
      if (str === null) {
        throw { type: 'java/lang/NullPointerException' };
      }
      obj.value = valueAsString(str);
      delete obj.isUninitialized;
    }, ['java/lang/NullPointerException']),
    'append(Ljava/lang/String;)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      obj.value += valueAsString(args[0]);
      return obj;
    },
    'append(Ljava/lang/CharSequence;)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      obj.value += valueAsString(args[0]);
      return obj;
    },
    'append(Ljava/lang/Object;)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      obj.value += valueAsString(args[0]);
      return obj;
    },
    'append(Ljava/lang/CharSequence;II)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      const value = valueAsString(args[0]);
      obj.value += value.substring(args[1], args[2]);
      return obj;
    },
    'append(C)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      obj.value += String.fromCharCode(args[0]);
      return obj;
    },
    'append(Z)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      obj.value += args[0] ? 'true' : 'false';
      return obj;
    },
    'append(I)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      obj.value += args[0];
      return obj;
    },
    'append(J)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      obj.value += args[0].toString();
      return obj;
    },
    'append(F)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      const floatClass = jvm.classes['java/lang/Float'];
      obj.value += valueAsString(floatClass.staticMethods['toString(F)Ljava/lang/String;'](jvm, null, args));
      return obj;
    },
    'append(D)Ljava/lang/StringBuilder;': (jvm, obj, args) => {
      const doubleClass = jvm.classes['java/lang/Double'];
      obj.value += valueAsString(doubleClass.staticMethods['toString(D)Ljava/lang/String;'](jvm, null, args));
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
