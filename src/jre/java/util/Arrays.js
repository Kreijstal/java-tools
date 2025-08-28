module.exports = {
  methods: {},
  staticMethods: {
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
        items: [...array],
        size: array.length
      };
    }
  },
  staticFields: {}
};