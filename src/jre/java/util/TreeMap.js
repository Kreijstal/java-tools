function ensureMap(obj) {
  if (!(obj.map instanceof Map)) obj.map = obj.entries instanceof Map ? obj.entries : new Map();
  obj.entries = obj.map;
  obj.sizeCache = obj.map.size;
  return obj.map;
}
function sourceEntries(src) {
  if (!src) return [];
  if (src.map instanceof Map) return Array.from(src.map.entries());
  if (src.entries instanceof Map) return Array.from(src.entries.entries());
  if (src.items instanceof Set) return Array.from(src.items).map(e => [e.key, e.value]);
  return [];
}
function unwrapComparable(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
  if (value.fields) {
    const numericField = Object.keys(value.fields).find((key) =>
      /\.(address|value)(?::[JI])?$/.test(key));
    if (numericField !== undefined) return value.fields[numericField];
  }
  if (value.type === 'java/lang/String' || value instanceof String) return String(value);
  if (typeof value.toString === 'function') return value.toString();
  return value;
}
function compareKeys(a, b) {
  const av = unwrapComparable(a);
  const bv = unwrapComparable(b);
  if (av === bv) return 0;
  if ((typeof av === 'number' || typeof av === 'bigint') &&
      (typeof bv === 'number' || typeof bv === 'bigint')) {
    if (typeof av === typeof bv) return av < bv ? -1 : 1;
    const an = typeof av === 'bigint' ? av : BigInt(av);
    const bn = typeof bv === 'bigint' ? bv : BigInt(bv);
    return an < bn ? -1 : (an > bn ? 1 : 0);
  }
  const as = String(av);
  const bs = String(bv);
  return as < bs ? -1 : (as > bs ? 1 : 0);
}
function sortedEntries(obj) {
  return Array.from(ensureMap(obj).entries()).sort((a, b) => compareKeys(a[0], b[0]));
}
function makeEntry(jvm, backing, key) {
  return {
    type: 'java/util/Map$Entry',
    key,
    value: backing.get(key),
    backingMap: backing,
    hashCode: jvm.nextHashCode++,
  };
}
function makeTreeMap(jvm, entries, comparator = null) {
  const map = new Map(entries);
  return { type: 'java/util/TreeMap', map, entries: map, sizeCache: map.size, comparator, hashCode: jvm.nextHashCode++ };
}

module.exports = {
  super: 'java/util/HashMap',
  interfaces: ['java/util/NavigableMap'],
  methods: {
    '<init>()V': (jvm, obj) => { obj.map = new Map(); obj.entries = obj.map; obj.sizeCache = 0; obj.comparator = null; },
    '<init>(Ljava/util/Comparator;)V': (jvm, obj, args) => { obj.map = new Map(); obj.entries = obj.map; obj.sizeCache = 0; obj.comparator = args[0]; },
    '<init>(Ljava/util/Map;)V': (jvm, obj, args) => {
      obj.map = new Map(); obj.entries = obj.map; obj.sizeCache = 0; obj.comparator = null;
      for (const [k, v] of sourceEntries(args[0])) obj.map.set(k, v);
      obj.sizeCache = obj.map.size;
    },
    '<init>(Ljava/util/SortedMap;)V': (jvm, obj, args) => {
      obj.map = new Map(); obj.entries = obj.map; obj.sizeCache = 0; obj.comparator = args[0] && args[0].comparator || null;
      for (const [k, v] of sourceEntries(args[0])) obj.map.set(k, v);
      obj.sizeCache = obj.map.size;
    },
    'comparator()Ljava/util/Comparator;': (jvm, obj) => obj.comparator || null,
    'firstKey()Ljava/lang/Object;': (jvm, obj) => { const e = sortedEntries(obj)[0]; return e ? e[0] : null; },
    'firstEntry()Ljava/util/Map$Entry;': (jvm, obj) => {
      const map = ensureMap(obj);
      const entry = sortedEntries(obj)[0];
      return entry ? makeEntry(jvm, map, entry[0]) : null;
    },
    'lastKey()Ljava/lang/Object;': (jvm, obj) => { const e = sortedEntries(obj); return e.length ? e[e.length - 1][0] : null; },
    'floorKey(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      let found = null;
      for (const [key] of sortedEntries(obj)) {
        if (compareKeys(key, args[0]) <= 0) found = key;
        else break;
      }
      return found;
    },
    'ceilingKey(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      for (const [key] of sortedEntries(obj)) if (compareKeys(key, args[0]) >= 0) return key;
      return null;
    },
    'floorEntry(Ljava/lang/Object;)Ljava/util/Map$Entry;': (jvm, obj, args) => {
      const map = ensureMap(obj);
      let found = null;
      for (const [key] of sortedEntries(obj)) {
        if (compareKeys(key, args[0]) <= 0) found = key;
        else break;
      }
      return found === null ? null : makeEntry(jvm, map, found);
    },
    'ceilingEntry(Ljava/lang/Object;)Ljava/util/Map$Entry;': (jvm, obj, args) => {
      const map = ensureMap(obj);
      for (const [key] of sortedEntries(obj)) if (compareKeys(key, args[0]) >= 0) return makeEntry(jvm, map, key);
      return null;
    },
    'lowerEntry(Ljava/lang/Object;)Ljava/util/Map$Entry;': (jvm, obj, args) => {
      const map = ensureMap(obj);
      let found = null;
      for (const [key] of sortedEntries(obj)) {
        if (compareKeys(key, args[0]) < 0) found = key;
        else break;
      }
      return found === null ? null : makeEntry(jvm, map, found);
    },
    'higherEntry(Ljava/lang/Object;)Ljava/util/Map$Entry;': (jvm, obj, args) => {
      const map = ensureMap(obj);
      for (const [key] of sortedEntries(obj)) if (compareKeys(key, args[0]) > 0) return makeEntry(jvm, map, key);
      return null;
    },
    'tailMap(Ljava/lang/Object;Z)Ljava/util/NavigableMap;': (jvm, obj, args) => {
      const [fromKey, inclusive] = args;
      const entries = sortedEntries(obj).filter(([key]) => inclusive ? compareKeys(key, fromKey) >= 0 : compareKeys(key, fromKey) > 0);
      return makeTreeMap(jvm, entries, obj.comparator || null);
    },
    'tailMap(Ljava/lang/Object;)Ljava/util/SortedMap;': (jvm, obj, args) => {
      const entries = sortedEntries(obj).filter(([key]) => compareKeys(key, args[0]) >= 0);
      return makeTreeMap(jvm, entries, obj.comparator || null);
    },
    'headMap(Ljava/lang/Object;Z)Ljava/util/NavigableMap;': (jvm, obj, args) => {
      const [toKey, inclusive] = args;
      const entries = sortedEntries(obj).filter(([key]) => inclusive ? compareKeys(key, toKey) <= 0 : compareKeys(key, toKey) < 0);
      return makeTreeMap(jvm, entries, obj.comparator || null);
    },
    'subMap(Ljava/lang/Object;ZLjava/lang/Object;Z)Ljava/util/NavigableMap;': (jvm, obj, args) => {
      const [fromKey, fromInclusive, toKey, toInclusive] = args;
      const entries = sortedEntries(obj).filter(([key]) => {
        const low = fromInclusive ? compareKeys(key, fromKey) >= 0 : compareKeys(key, fromKey) > 0;
        const high = toInclusive ? compareKeys(key, toKey) <= 0 : compareKeys(key, toKey) < 0;
        return low && high;
      });
      return makeTreeMap(jvm, entries, obj.comparator || null);
    },
    'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const map = ensureMap(obj);
      const existing = Array.from(map.keys()).find((key) => compareKeys(key, args[0]) === 0);
      const oldValue = existing === undefined ? null : map.get(existing);
      if (existing !== undefined) map.delete(existing);
      map.set(args[0], args[1]);
      obj.sizeCache = map.size;
      return oldValue;
    },
    'remove(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const map = ensureMap(obj);
      const existing = Array.from(map.keys()).find((key) => compareKeys(key, args[0]) === 0);
      if (existing === undefined) return null;
      const oldValue = map.get(existing);
      map.delete(existing);
      obj.sizeCache = map.size;
      return oldValue;
    },
    'remove(Ljava/lang/Object;Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const map = ensureMap(obj);
      const existing = Array.from(map.keys()).find((key) => compareKeys(key, args[0]) === 0);
      if (existing === undefined || map.get(existing) !== args[1]) return 0;
      map.delete(existing);
      obj.sizeCache = map.size;
      return 1;
    },
    'isEmpty()Z': (jvm, obj) => ensureMap(obj).size === 0 ? 1 : 0,
    'size()I': (jvm, obj) => ensureMap(obj).size,
  },
};
