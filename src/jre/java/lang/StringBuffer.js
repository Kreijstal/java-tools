const { withThrows } = require('../../helpers');

function stringValue(value) {
  if (value === null || value === undefined) return 'null';
  if (value && Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
  return String(value);
}

function append(value) {
  return (jvm, obj, args) => {
    obj.value = String(obj.value || '') + value(args[0]);
    return obj;
  };
}

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/lang/CharSequence'],
  methods: {
    '<init>()V': (jvm, obj) => { obj.value = ''; },
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => { obj.value = stringValue(args[0]); },
    'append(Ljava/lang/String;)Ljava/lang/StringBuffer;': append(stringValue),
    'append(Ljava/lang/Object;)Ljava/lang/StringBuffer;': append(stringValue),
    'append(C)Ljava/lang/StringBuffer;': append((value) => String.fromCharCode(value)),
    'append(Z)Ljava/lang/StringBuffer;': append((value) => value ? 'true' : 'false'),
    'append(I)Ljava/lang/StringBuffer;': append(String),
    'append(J)Ljava/lang/StringBuffer;': append(String),
    'append(F)Ljava/lang/StringBuffer;': append(String),
    'append(D)Ljava/lang/StringBuffer;': append(String),
    // The append family above already mirrors StringBuilder; these four close the
    // gap. java/lang/StringBuffer is a closed JDK class, so a name this model
    // does not carry cannot be added by the compilation that calls it - the
    // frontend refuses to guess the descriptor and fails the compile instead,
    // which is how zombiedawnmulti's setCharAt surfaced.
    'charAt(I)C': withThrows((jvm, obj, args) => {
      const value = String(obj.value || '');
      const index = args[0];
      if (index < 0 || index >= value.length) {
        throw {
          type: 'java/lang/StringIndexOutOfBoundsException',
          message: `String index out of range: ${index}`,
        };
      }
      return value.charCodeAt(index);
    }, ['java/lang/StringIndexOutOfBoundsException']),
    'setCharAt(IC)V': withThrows((jvm, obj, args) => {
      const value = String(obj.value || '');
      const index = args[0];
      if (index < 0 || index >= value.length) {
        throw {
          type: 'java/lang/StringIndexOutOfBoundsException',
          message: `String index out of range: ${index}`,
        };
      }
      const chars = Array.from(value);
      chars[index] = String.fromCharCode(args[1]);
      obj.value = chars.join('');
    }, ['java/lang/StringIndexOutOfBoundsException']),
    // Growing pads with NUL and shrinking discards the tail, so the length is
    // the character count either way.
    'setLength(I)V': withThrows((jvm, obj, args) => {
      const value = String(obj.value || '');
      const newLength = args[0];
      if (newLength < 0) {
        throw {
          type: 'java/lang/StringIndexOutOfBoundsException',
          message: `String index out of range: ${newLength}`,
        };
      }
      obj.value = newLength > value.length
        ? value + '\0'.repeat(newLength - value.length)
        : value.slice(0, newLength);
    }, ['java/lang/StringIndexOutOfBoundsException']),
    'reverse()Ljava/lang/StringBuffer;': (jvm, obj) => {
      // Array.from iterates by code point, so surrogate pairs survive the flip.
      obj.value = Array.from(String(obj.value || '')).reverse().join('');
      return obj;
    },
    'toString()Ljava/lang/String;': (jvm, obj) => jvm.newString(String(obj.value || '')),
    'length()I': (jvm, obj) => String(obj.value || '').length,
  },
};
