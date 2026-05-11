const { withThrows } = require('../../helpers');

function arrayForCollection(obj) {
  if (!obj) return null;
  if (Array.isArray(obj.array)) return obj.array;
  if (Array.isArray(obj.items)) { obj.array = obj.items; return obj.array; }
  if (Array.isArray(obj.list)) { obj.array = obj.list; return obj.array; }
  if (obj.set instanceof Set) return obj.set;
  return null;
}


function classNameOf(obj) {
  return obj && (obj._className || obj.type);
}

function fieldValue(obj, name) {
  if (!obj) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  if (!obj.fields) return undefined;
  for (const key of Object.keys(obj.fields)) {
    if (key.endsWith(`.${name}`) || key === name) return obj.fields[key];
  }
  return undefined;
}

function instrIndexRelative(indexObj) {
  const tempList = fieldValue(indexObj, 'tempList');
  if (!tempList) return 0;
  const rels = fieldValue(tempList, 'rels');
  const array = arrayForCollection(rels);
  if (!array) return 0;
  const idx = Array.from(array).indexOf(indexObj);
  return idx < 0 ? 0 : idx;
}

function instrIndexKey(indexObj) {
  return [Number(fieldValue(indexObj, 'index') || 0), instrIndexRelative(indexObj)];
}

function compareInstrIndex(a, b) {
  const ka = instrIndexKey(a);
  const kb = instrIndexKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  return ka[1] - kb[1];
}

function compareOp03ByIndex(a, b, asc) {
  const result = compareInstrIndex(fieldValue(a, 'index'), fieldValue(b, 'index'));
  return asc ? result : -result;
}

function comparatorFor(comparator) {
  const comparatorClass = classNameOf(comparator);
  if (comparatorClass === 'org/benf/cfr/reader/bytecode/analysis/opgraph/op3rewriters/CompareByIndex') {
    const asc = fieldValue(comparator, 'asc') !== 0;
    return (a, b) => compareOp03ByIndex(a, b, asc);
  }
  if (comparatorClass === 'org/benf/cfr/reader/entities/exceptions/ExceptionAggregator$CompareExceptionTablesByRange') {
    return (a, b) => naturalCompare(a, b);
  }
  return null;
}

function comparableKey(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof String) return String(value);
  if (Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
  if (value.name !== undefined) return String(value.name);
  if (value.index !== undefined) return value.index;
  if (value.idx !== undefined) return value.idx;
  return String(value);
}

function naturalCompare(a, b) {
  const ka = comparableKey(a);
  const kb = comparableKey(b);
  if (ka === kb) return 0;
  if (ka === null || ka === undefined) return -1;
  if (kb === null || kb === undefined) return 1;
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return 0;
}

function binarySearchArray(array, key, comparator) {
  let low = 0;
  let high = array.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const midVal = array[mid];
    const cmp = comparator ? comparator(midVal, key) : naturalCompare(midVal, key);
    if (cmp < 0) {
      low = mid + 1;
    } else if (cmp > 0) {
      high = mid - 1;
    } else {
      return mid;
    }
  }
  return -(low + 1);
}

module.exports = {
  methods: {},
  staticMethods: {
    'addAll(Ljava/util/Collection;[Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const collection = args[0];
      const values = args[1] || [];
      const target = arrayForCollection(collection);
      if (!target) return 0;
      let changed = false;
      for (const value of values) {
        if (target instanceof Set) target.add(value);
        else target.push(value);
        changed = true;
      }
      if (collection && !(target instanceof Set)) {
        collection.array = target;
        collection.items = target;
        collection.size = target.length;
      }
      return changed ? 1 : 0;
    },
    'unmodifiableMap(Ljava/util/Map;)Ljava/util/Map;': (jvm, obj, args) => args[0],
    'newSetFromMap(Ljava/util/Map;)Ljava/util/Set;': (jvm, obj, args) => {
      const backing = args[0];
      if (!backing.map) backing.map = new Map();
      backing.entries = backing.map;
      const set = new Set(backing.map.keys());
      return {
        type: 'java/util/HashSet',
        _className: 'java/util/HashSet',
        set,
        items: set,
        backingMap: backing.map,
        hashCode: jvm.nextHashCode++,
      };
    },
    'singleton(Ljava/lang/Object;)Ljava/util/Set;': (jvm, obj, args) => {
      const set = new Set([args[0]]);
      return { type: 'java/util/HashSet', set, items: set, hashCode: jvm.nextHashCode++ };
    },
    'emptyList()Ljava/util/List;': () => {
      return {
        type: 'java/util/ArrayList',
        items: [],
        size: 0
      };
    },
    'emptySet()Ljava/util/Set;': () => {
      return {
        type: 'java/util/HashSet',
        items: new Set()
      };
    },
    'emptyMap()Ljava/util/Map;': () => {
      return {
        type: 'java/util/HashMap',
        map: new Map()
      };
    },
    'singletonList(Ljava/lang/Object;)Ljava/util/List;': (jvm, obj, args) => {
      const item = args[0];
      return {
        type: 'java/util/ArrayList',
        items: [item],
        size: 1
      };
    },
    'singletonMap(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/Map;': (jvm, obj, args) => {
      return {
        type: 'java/util/HashMap',
        map: new Map([[args[0], args[1]]])
      };
    },
    'unmodifiableList(Ljava/util/List;)Ljava/util/List;': (jvm, obj, args) => {
      const list = args[0];
      // Create a proxy that prevents modification
      return new Proxy(list, {
        get(target, prop) {
          if (prop === 'add' || prop === 'remove' || prop === 'clear') {
            throw {
              type: 'java/lang/UnsupportedOperationException',
              message: 'Collection is unmodifiable'
            };
          }
          return target[prop];
        }
      });
    },
    'unmodifiableSet(Ljava/util/Set;)Ljava/util/Set;': (jvm, obj, args) => {
      const set = args[0];
      return new Proxy(set, {
        get(target, prop) {
          if (prop === 'add' || prop === 'remove' || prop === 'clear') {
            throw {
              type: 'java/lang/UnsupportedOperationException',
              message: 'Collection is unmodifiable'
            };
          }
          return target[prop];
        }
      });
    },
    'binarySearch(Ljava/util/List;Ljava/lang/Object;)I': (jvm, obj, args) => {
      const collection = args[0];
      const key = args[1];
      const array = arrayForCollection(collection);
      return binarySearchArray(Array.from(array || []), key, null);
    },
    'binarySearch(Ljava/util/List;Ljava/lang/Object;Ljava/util/Comparator;)I': (jvm, obj, args) => {
      const collection = args[0];
      const key = args[1];
      const comparator = args[2];
      const array = Array.from(arrayForCollection(collection) || []);
      let compare = null;
      if (comparator && comparator.methods && comparator.methods['compare(Ljava/lang/Object;Ljava/lang/Object;)I']) {
        compare = (a, b) => comparator.methods['compare(Ljava/lang/Object;Ljava/lang/Object;)I'](jvm, comparator, [a, b]);
      }
      return binarySearchArray(array, key, compare);
    },
    'sort(Ljava/util/List;)V': (jvm, obj, args) => {
      const list = args[0];
      if (list && list.items && typeof list.items.sort === 'function') {
        list.items.sort();
      }
    },
    'sort(Ljava/util/List;Ljava/util/Comparator;)V': (jvm, obj, args) => {
      const list = args[0];
      const comparator = args[1];
      const array = arrayForCollection(list);
      if (!array || typeof array.sort !== 'function') return;
      const compare = comparatorFor(comparator);
      if (compare) {
        array.sort(compare);
      } else {
        array.sort((a, b) => naturalCompare(a, b));
      }
      if (list && !(array instanceof Set)) {
        list.array = array;
        list.items = array;
        list.size = array.length;
      }
    },
    'reverse(Ljava/util/List;)V': (jvm, obj, args) => {
      const list = args[0];
      if (list && list.items) {
        list.items.reverse();
      }
    },
    'shuffle(Ljava/util/List;)V': (jvm, obj, args) => {
      const list = args[0];
      if (list && list.items) {
        // Fisher-Yates shuffle algorithm
        for (let i = list.items.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [list.items[i], list.items[j]] = [list.items[j], list.items[i]];
        }
      }
    },
    'max(Ljava/util/Collection;)Ljava/lang/Object;': withThrows((jvm, obj, args) => {
      const collection = args[0];
      if (!collection || !collection.items || collection.items.length === 0) {
        throw {
          type: 'java/util/NoSuchElementException',
          message: 'Collection is empty'
        };
      }

      let max = collection.items[0];
      for (let i = 1; i < collection.items.length; i++) {
        if (collection.items[i] > max) {
          max = collection.items[i];
        }
      }
      return max;
    }, ['java/util/NoSuchElementException']),
    'min(Ljava/util/Collection;)Ljava/lang/Object;': withThrows((jvm, obj, args) => {
      const collection = args[0];
      if (!collection || !collection.items || collection.items.length === 0) {
        throw {
          type: 'java/util/NoSuchElementException',
          message: 'Collection is empty'
        };
      }

      let min = collection.items[0];
      for (let i = 1; i < collection.items.length; i++) {
        if (collection.items[i] < min) {
          min = collection.items[i];
        }
      }
      return min;
    }, ['java/util/NoSuchElementException'])
  },
  staticFields: {
    EMPTY_LIST: {
      type: 'java/util/ArrayList',
      items: [],
      size: 0
    },
    EMPTY_SET: {
      type: 'java/util/HashSet',
      items: new Set()
    }
  }
};
