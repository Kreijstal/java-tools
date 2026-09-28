const { withThrows } = require('../../helpers');

function javaString(value) {
  if (value === null || value === undefined) return 'null';
  if (value && value.type === 'java/lang/String') return String(value);
  if (value && typeof value.toString === 'function') return String(value.toString());
  return String(value);
}

// Compare byte contents without copying or retaining backing buffers. Aligned
// typed views admit four-byte comparisons; ordinary or unaligned arrays keep
// the byte path. Equality is independent of the host byte order.
function byteArraysEqual(a, b) {
  if (a === b) return 1;
  if (a == null || b == null || a.length !== b.length) return 0;
  let i = 0;
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b) &&
      a.BYTES_PER_ELEMENT === 1 && b.BYTES_PER_ELEMENT === 1 &&
      (a.byteOffset & 3) === 0 && (b.byteOffset & 3) === 0) {
    const count = Math.floor(a.length / 4);
    const left = new Uint32Array(a.buffer, a.byteOffset, count);
    const right = new Uint32Array(b.buffer, b.byteOffset, count);
    for (let word = 0; word < count; word++) {
      if (left[word] !== right[word]) return 0;
    }
    i = count * 4;
  }
  for (; i < a.length; i++) {
    if ((a[i] & 255) !== (b[i] & 255)) return 0;
  }
  return 1;
}

function intArraysEqual(a, b) {
  if (a === b) return 1;
  if (a == null || b == null || a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) {
    if ((a[i] | 0) !== (b[i] | 0)) return 0;
  }
  return 1;
}

module.exports = {
  methods: {},
  staticMethods: {
    'equals([I[I)Z': (jvm, obj, args) => intArraysEqual(args[0], args[1]),
    'equals([B[B)Z': (jvm, obj, args) => byteArraysEqual(args[0], args[1]),
    'sort([I)V': (jvm, obj, args) => {
      const array = args[0];
      if (array && typeof array.sort === 'function') {
        array.sort((a, b) => a - b);
      }
    },
    'sort([Ljava/lang/Object;)V': (jvm, obj, args) => {
      const array = args[0];
      if (array && typeof array.sort === 'function') {
        array.sort();
      }
    },
    'binarySearch([II)I': (jvm, obj, args) => {
      const array = args[0];
      const key = args[1];
      if (!array || array.length === 0) return -1;

      let low = 0;
      let high = array.length - 1;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (array[mid] < key) {
          low = mid + 1;
        } else if (array[mid] > key) {
          high = mid - 1;
        } else {
          return mid;
        }
      }
      return -(low + 1);
    },
    'equals([Ljava/lang/Object;[Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const a = args[0];
      const b = args[1];

      if (a === b) return 1; // true
      if (!a || !b) return 0; // false
      if (a.length !== b.length) return 0; // false

      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return 0; // false
      }
      return 1; // true
    },
    'fill([II)V': (jvm, obj, args) => {
      const array = args[0];
      const val = args[1];

      if (array) {
        for (let i = 0; i < array.length; i++) {
          array[i] = val;
        }
      }
    },
    'fill([IIII)V': withThrows((jvm, obj, args) => {
      const [array, from, to, value] = args;
      // Java checks the array reference before range ordering, then the low
      // and high bounds. Validate everything before the first write: native
      // fill clamps indices, whereas Arrays.fill must throw for invalid ones.
      if (array === null || array === undefined) {
        throw { type: 'java/lang/NullPointerException' };
      }
      if (from > to) {
        throw { type: 'java/lang/IllegalArgumentException' };
      }
      if (from < 0 || to > array.length) {
        throw { type: 'java/lang/ArrayIndexOutOfBoundsException' };
      }
      array.fill(value | 0, from, to);
    }, ['java/lang/NullPointerException', 'java/lang/IllegalArgumentException',
      'java/lang/ArrayIndexOutOfBoundsException']),
    'fill([Ljava/lang/Object;Ljava/lang/Object;)V': (jvm, obj, args) => {
      const array = args[0];
      const val = args[1];

      if (array) {
        for (let i = 0; i < array.length; i++) {
          array[i] = val;
        }
      }
    },
    'copyOf([II)[I': (jvm, obj, args) => {
      const original = args[0];
      const newLength = args[1];

      if (!original) return [];

      const copy = new Array(newLength);
      const minLength = Math.min(original.length, newLength);

      for (let i = 0; i < minLength; i++) {
        copy[i] = original[i];
      }

      // Fill remaining with 0 for int array
      for (let i = minLength; i < newLength; i++) {
        copy[i] = 0;
      }

      return copy;
    },
    'toString([Ljava/lang/Object;)Ljava/lang/String;': (jvm, obj, args) => {
      const array = args[0];
      if (!array) return jvm.internString('null');
      return jvm.internString('[' + Array.from(array).map(javaString).join(', ') + ']');
    },
    'copyOf([Ljava/lang/Object;I)[Ljava/lang/Object;': (jvm, obj, args) => {
      const original = args[0] || [];
      const newLength = args[1];
      const copy = new Array(newLength).fill(null);
      for (let i = 0; i < Math.min(original.length, newLength); i++) copy[i] = original[i];
      copy.type = original.type || '[Ljava/lang/Object;';
      copy.elementType = original.elementType || 'java/lang/Object';
      copy.hashCode = jvm.nextHashCode++;
      return copy;
    },
    'copyOf([Ljava/lang/Object;ILjava/lang/Class;)[Ljava/lang/Object;': (jvm, obj, args) => {
      const original = args[0] || [];
      const newLength = args[1];
      const copy = new Array(newLength).fill(null);
      for (let i = 0; i < Math.min(original.length, newLength); i++) copy[i] = original[i];
      copy.type = original.type || '[Ljava/lang/Object;';
      copy.elementType = original.elementType || 'java/lang/Object';
      copy.hashCode = jvm.nextHashCode++;
      return copy;
    },
    'toString([I)Ljava/lang/String;': (jvm, obj, args) => {
      const array = args[0];
      if (!array) return "null";

      let result = "[";
      for (let i = 0; i < array.length; i++) {
        result += array[i];
        if (i < array.length - 1) result += ", ";
      }
      result += "]";

      return jvm.internString(result);
    },
    'asList([Ljava/lang/Object;)Ljava/util/List;': (jvm, obj, args) => {
      const array = args[0];
      if (!array) return null;

      // Return an ArrayList containing the elements of the array
      return {
        type: 'java/util/ArrayList',
        array: [...array],
        items: [...array],
        size: array.length
      };
    }
  },
  staticFields: {}
};
