const { invokeFunctional } = require('../../functional');

const debugIds = new WeakMap();
let nextDebugId = 1;

function debugMap(operation, obj, key) {
  if (typeof process === 'undefined' || !process.env ||
      process.env.JVM_DEBUG_IDENTITY_HASHMAP !== '1') return;
  let id = String(key);
  if (key !== null && (typeof key === 'object' || typeof key === 'function')) {
    if (!debugIds.has(key)) debugIds.set(key, nextDebugId++);
    id = `object:${debugIds.get(key)}`;
  }
  console.error(`[identity-hashmap] ${operation} key=${id} size=${ensureMap(obj).size}`);
}

function ensureMap(obj) {
  if (!(obj.map instanceof Map)) obj.map = new Map();
  return obj.map;
}

function put(obj, key, value) {
  const map = ensureMap(obj);
  const entry = map.get(key);
  map.set(key, { type: 'java/util/Map$Entry', key, value, backingMap: obj });
  return entry ? entry.value : null;
}

module.exports = {
  super: 'java/util/HashMap',
  interfaces: ['java/util/Map'],
  methods: {
    '<init>()V': (jvm, obj) => { obj.map = new Map(); obj.entries = obj.map; obj.sizeCache = 0; },
    '<init>(I)V': (jvm, obj) => { obj.map = new Map(); obj.entries = obj.map; obj.sizeCache = 0; },
    '<init>(Ljava/util/Map;)V': (jvm, obj, args) => {
      obj.map = new Map(); obj.entries = obj.map; obj.sizeCache = 0;
      const src = args[0];
      if (src && src.map instanceof Map) {
        for (const [k, v] of src.map.entries()) obj.map.set(k, v);
      }
      obj.sizeCache = obj.map.size;
    },
    'size()I': (jvm, obj) => ensureMap(obj).size,
    'isEmpty()Z': (jvm, obj) => ensureMap(obj).size === 0 ? 1 : 0,
    'containsKey(Ljava/lang/Object;)Z': (jvm, obj, args) =>
      ensureMap(obj).has(args[0]) ? 1 : 0,
    'get(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const entry = ensureMap(obj).get(args[0]);
      debugMap(entry ? 'get-hit' : 'get-miss', obj, args[0]);
      return entry ? entry.value : null;
    },
    'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) =>
      put(obj, args[0], args[1]),
    'remove(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const map = ensureMap(obj);
      const entry = map.get(args[0]);
      map.delete(args[0]);
      debugMap(entry ? 'remove-hit' : 'remove-miss', obj, args[0]);
      return entry ? entry.value : null;
    },
    'clear()V': (jvm, obj) => {
      ensureMap(obj).clear();
      debugMap('clear', obj, null);
    },
    'compute(Ljava/lang/Object;Ljava/util/function/BiFunction;)Ljava/lang/Object;':
      async (jvm, obj, args, thread) => {
        const map = ensureMap(obj);
        const key = args[0];
        const entry = map.get(key);
        const newValue = await invokeFunctional(
          jvm, args[1], [key, entry ? entry.value : null], thread,
        );
        if (newValue === null || newValue === undefined) {
          map.delete(key);
          debugMap('compute-remove', obj, key);
          return null;
        }
        put(obj, key, newValue);
        debugMap(entry ? 'compute-update' : 'compute-insert', obj, key);
        return newValue;
      },
  },
};
