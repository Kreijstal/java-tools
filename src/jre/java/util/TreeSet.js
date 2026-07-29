function ensureSet(obj) {
  if (!obj.set) {
    if (obj.items instanceof Set) obj.set = obj.items;
    else obj.set = new Set();
  }
  obj.items = obj.set;
  return obj.set;
}

function copyCollection(src) {
  if (!src) return [];
  if (src.set instanceof Set) return Array.from(src.set);
  if (src.items instanceof Set) return Array.from(src.items);
  if (Array.isArray(src.array)) return src.array.slice();
  if (Array.isArray(src.items)) return src.items.slice();
  if (Array.isArray(src) || ArrayBuffer.isView(src)) return Array.from(src);
  return [];
}

function compareValues(a, b) {
  const av = a && a.value !== undefined ? a.value : a;
  const bv = b && b.value !== undefined ? b.value : b;
  if ((typeof av === 'number' || typeof av === 'bigint') &&
      (typeof bv === 'number' || typeof bv === 'bigint')) {
    return av < bv ? -1 : (av > bv ? 1 : 0);
  }
  const as = String(av);
  const bs = String(bv);
  return as.localeCompare(bs);
}

function sortedArray(obj) {
  return Array.from(ensureSet(obj)).sort(compareValues);
}

function subset(obj, predicate) {
  const values = sortedArray(obj).filter(predicate);
  return {
    type: 'java/util/TreeSet',
    set: new Set(values),
    items: new Set(values),
    comparator: obj.comparator || null,
  };
}

module.exports = {
  super: 'java/util/HashSet',
  interfaces: ['java/util/NavigableSet'],
  methods: {
    '<init>()V': (jvm, obj) => { obj.set = new Set(); obj.items = obj.set; obj.comparator = null; },
    '<init>(Ljava/util/Comparator;)V': (jvm, obj, args) => { obj.set = new Set(); obj.items = obj.set; obj.comparator = args[0]; },
    '<init>(Ljava/util/Collection;)V': (jvm, obj, args) => { obj.set = new Set(copyCollection(args[0])); obj.items = obj.set; obj.comparator = null; },
    '<init>(Ljava/util/SortedSet;)V': (jvm, obj, args) => { obj.set = new Set(copyCollection(args[0])); obj.items = obj.set; obj.comparator = args[0] && args[0].comparator || null; },
    'comparator()Ljava/util/Comparator;': (jvm, obj) => obj.comparator || null,
    'iterator()Ljava/util/Iterator;': (jvm, obj) => ({ type: 'java/util/Iterator', array: sortedArray(obj), index: 0, lastIndex: -1 }),
    'first()Ljava/lang/Object;': (jvm, obj) => sortedArray(obj)[0] || null,
    'last()Ljava/lang/Object;': (jvm, obj) => { const a = sortedArray(obj); return a.length ? a[a.length - 1] : null; },
    'tailSet(Ljava/lang/Object;)Ljava/util/SortedSet;': (jvm, obj, args) =>
      subset(obj, (value) => compareValues(value, args[0]) >= 0),
    'headSet(Ljava/lang/Object;)Ljava/util/SortedSet;': (jvm, obj, args) =>
      subset(obj, (value) => compareValues(value, args[0]) < 0),
    'subSet(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/SortedSet;':
      (jvm, obj, args) => subset(obj, (value) =>
        compareValues(value, args[0]) >= 0 &&
        compareValues(value, args[1]) < 0),
  },
};
