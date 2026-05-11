function ensureSet(obj) {
  if (!(obj.set instanceof Set)) {
    if (obj.items instanceof Set) obj.set = obj.items;
    else if (Array.isArray(obj.items)) obj.set = new Set(obj.items);
    else if (Array.isArray(obj.array)) obj.set = new Set(obj.array);
    else obj.set = new Set();
  }
  obj.items = obj.set;
  return obj.set;
}



function classNameOf(obj) {
  return obj && (obj._className || obj.type);
}

function classEquals(jvm, className, a, b) {
  const equals = jvm && jvm.jre && jvm.jre[className] &&
    jvm.jre[className].methods &&
    jvm.jre[className].methods['equals(Ljava/lang/Object;)Z'];
  return equals ? equals(jvm, a, [b]) !== 0 : null;
}

function javaEquals(jvm, a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;

  const av = a && Object.prototype.hasOwnProperty.call(a, 'value') ? a.value : undefined;
  const bv = b && Object.prototype.hasOwnProperty.call(b, 'value') ? b.value : undefined;
  if (av !== undefined || bv !== undefined) return av === bv;

  if ((a.type === 'java/lang/String' || a instanceof String) && (b.type === 'java/lang/String' || b instanceof String)) {
    return String(a) === String(b);
  }

  const at = classNameOf(a);
  const bt = classNameOf(b);
  if (at !== bt) return false;

  const classResult = classEquals(jvm, at, a, b);
  if (classResult !== null) return classResult;

  return false;
}

function includesValue(jvm, values, target) {
  return values.some(value => javaEquals(jvm, value, target));
}

function collectionValues(collection) {
  if (!collection) return [];
  if (collection.set instanceof Set) return Array.from(collection.set);
  if (collection.items instanceof Set) return Array.from(collection.items);
  if (Array.isArray(collection.items)) return collection.items;
  if (Array.isArray(collection.array)) return collection.array;
  return [];
}

module.exports = {
  super: 'java/util/AbstractSet',
  interfaces: ['java/util/Set'],
  staticFields: {},
  methods: {
    '<init>()V': (jvm, obj) => { obj.set = new Set(); obj.items = obj.set; },
    '<init>(Ljava/util/Collection;)V': (jvm, obj, args) => { obj.set = new Set(collectionValues(args[0])); obj.items = obj.set; },
    '<init>(I)V': (jvm, obj) => { obj.set = new Set(); obj.items = obj.set; },
    '<init>(IF)V': (jvm, obj) => { obj.set = new Set(); obj.items = obj.set; },
    'add(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const set = ensureSet(obj);
      for (const value of set) if (javaEquals(jvm, value, args[0])) return 0;
      set.add(args[0]);
      return 1;
    },
    'addAll(Ljava/util/Collection;)Z': (jvm, obj, args) => {
      const set = ensureSet(obj);
      let changed = 0;
      for (const value of collectionValues(args[0])) {
        if (!Array.from(set).some(existing => javaEquals(jvm, existing, value))) {
          set.add(value);
          changed = 1;
        }
      }
      return changed;
    },
    'contains(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const set = ensureSet(obj);
      if (set.has(args[0])) return 1;
      return Array.from(set).some(value => javaEquals(jvm, value, args[0])) ? 1 : 0;
    },
    'containsAll(Ljava/util/Collection;)Z': (jvm, obj, args) => {
      const values = Array.from(ensureSet(obj));
      return collectionValues(args[0]).every(value => includesValue(jvm, values, value)) ? 1 : 0;
    },
    'remove(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const set = ensureSet(obj);
      if (set.delete(args[0])) return 1;
      for (const value of Array.from(set)) {
        if (javaEquals(jvm, value, args[0])) { set.delete(value); return 1; }
      }
      return 0;
    },
    'removeAll(Ljava/util/Collection;)Z': (jvm, obj, args) => {
      const set = ensureSet(obj);
      const remove = collectionValues(args[0]);
      let changed = 0;
      for (const value of Array.from(set)) {
        if (includesValue(jvm, remove, value)) { set.delete(value); changed = 1; }
      }
      return changed;
    },
    'retainAll(Ljava/util/Collection;)Z': (jvm, obj, args) => {
      const set = ensureSet(obj);
      const retain = collectionValues(args[0]);
      let changed = 0;
      for (const value of Array.from(set)) {
        if (!includesValue(jvm, retain, value)) { set.delete(value); changed = 1; }
      }
      return changed;
    },
    'clear()V': (jvm, obj) => ensureSet(obj).clear(),
    'size()I': (jvm, obj) => ensureSet(obj).size,
    'isEmpty()Z': (jvm, obj) => ensureSet(obj).size === 0 ? 1 : 0,
    'iterator()Ljava/util/Iterator;': (jvm, obj) => ({
      type: 'java/util/Iterator',
      array: Array.from(ensureSet(obj)),
      index: 0,
      lastIndex: -1,
    }),
    'toArray()[Ljava/lang/Object;': (jvm, obj) => {
      const array = Array.from(ensureSet(obj));
      array.type = '[Ljava/lang/Object;';
      array.elementType = 'java/lang/Object';
      array.hashCode = jvm.nextHashCode++;
      return array;
    },
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const set = ensureSet(obj);
      const other = collectionValues(args[0]);
      if (set.size !== other.length) return 0;
      for (const item of set) if (!other.some(value => javaEquals(jvm, item, value))) return 0;
      return 1;
    },
  },
};
