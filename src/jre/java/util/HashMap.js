function javaString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (value && Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
  return String(value);
}

function classNameOf(obj) {
  return obj && (obj._className || obj.type);
}

function fieldValue(obj, name) {
  if (!obj) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  if (obj.fields) {
    const exact = Object.keys(obj.fields).find((key) => key.endsWith(`.${name}`));
    if (exact) return obj.fields[exact];
  }
  return undefined;
}

function bitSetKey(obj) {
  const bits = obj && obj.bits instanceof Set ? Array.from(obj.bits) : [];
  bits.sort((a, b) => a - b);
  return bits.join(',');
}

function canonicalKey(key) {
  if (key === null || key === undefined) return 'null';
  if (typeof key === 'number') return `number:${key}`;
  if (typeof key === 'bigint') return `bigint:${key.toString()}`;
  if (typeof key === 'boolean') return `boolean:${key ? 1 : 0}`;
  if (typeof key === 'string') return `string:${key}`;

  const type = classNameOf(key);
  if (type === 'java/lang/String' || key instanceof String) return `java/lang/String:${String(key.value !== undefined ? key.value : key)}`;

  switch (type) {
    case 'org/benf/cfr/reader/bytecode/analysis/parse/utils/Pair':
      return `${type}:${canonicalKey(fieldValue(key, 'x'))}:${canonicalKey(fieldValue(key, 'y'))}`;
    case 'org/benf/cfr/reader/bytecode/analysis/variables/Slot':
      return `${type}:${String(fieldValue(key, 'idx'))}`;
    case 'org/benf/cfr/reader/bytecode/analysis/variables/Ident':
      return `${type}:${String(fieldValue(key, 'stackpos'))}:${String(fieldValue(key, 'idx'))}`;
    case 'org/benf/cfr/reader/bytecode/analysis/parse/utils/SSAIdent':
      return `${type}:${canonicalKey(fieldValue(key, 'val'))}`;
    case 'org/benf/cfr/reader/bytecode/analysis/variables/NamedVariableDefault':
      return `${type}:${javaString(fieldValue(key, 'name'))}`;
    case 'org/benf/cfr/reader/bytecode/analysis/variables/NamedVariableFromHint':
      return `${type}:${javaString(fieldValue(key, 'name'))}:${String(fieldValue(key, 'slot'))}:${String(fieldValue(key, 'idx'))}`;
    case 'org/benf/cfr/reader/bytecode/analysis/parse/lvalue/LocalVariable':
      return `${type}:${canonicalKey(fieldValue(key, 'name'))}:${String(fieldValue(key, 'idx'))}:${canonicalKey(fieldValue(key, 'ident'))}`;
    case 'org/benf/cfr/reader/bytecode/analysis/parse/lvalue/SentinelLocalClassLValue':
      return `${type}:${canonicalKey(fieldValue(key, 'localClassType'))}`;
    case 'org/benf/cfr/reader/bytecode/analysis/types/JavaRefTypeInstance':
      return `${type}:${javaString(fieldValue(key, 'className'))}`;
    case 'org/benf/cfr/reader/bytecode/analysis/types/RawJavaType':
      return `${type}:${javaString(fieldValue(key, 'name'))}`;
    case 'java/util/BitSet':
      return `${type}:${bitSetKey(key)}`;
    default:
      break;
  }

  if (type && type.endsWith('$SentinelNV')) {
    return `${type}:${canonicalKey(fieldValue(key, 'typeInstance'))}`;
  }

  if (Object.prototype.hasOwnProperty.call(key, 'value')) {
    switch (type) {
      case 'java/lang/Integer':
      case 'java/lang/Long':
      case 'java/lang/Short':
      case 'java/lang/Byte':
      case 'java/lang/Character':
      case 'java/lang/Boolean':
      case 'java/lang/Float':
      case 'java/lang/Double':
        return `${type}:${String(key.value)}`;
      default:
        break;
    }
  }

  if (!Object.prototype.hasOwnProperty.call(key, '__hashMapIdentity')) {
    Object.defineProperty(key, '__hashMapIdentity', {
      value: HashMapIdentity.next++,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return `object:${key.__hashMapIdentity}`;
}

const HashMapIdentity = { next: 1 };

function javaEquals(jvm, a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (canonicalKey(a) === canonicalKey(b)) return true;

  const at = classNameOf(a);
  if (at && at === classNameOf(b)) {
    const equals = jvm && jvm.jre && jvm.jre[at] && jvm.jre[at].methods && jvm.jre[at].methods['equals(Ljava/lang/Object;)Z'];
    if (equals) return equals(jvm, a, [b]) !== 0;
  }
  return false;
}

function ensureMap(obj) {
  if (!(obj.map instanceof Map)) {
    obj.map = new Map();
  }
  return obj.map;
}

function entriesFrom(collection) {
  if (!collection) return [];
  if (collection.map instanceof Map) {
    return Array.from(collection.map.values()).map((entry) => {
      if (entry && Object.prototype.hasOwnProperty.call(entry, 'key')) return entry;
      return null;
    }).filter(Boolean);
  }
  if (collection.items instanceof Set) {
    return Array.from(collection.items).filter((entry) => entry && Object.prototype.hasOwnProperty.call(entry, 'key'));
  }
  if (Array.isArray(collection.items)) {
    return collection.items.filter((entry) => entry && Object.prototype.hasOwnProperty.call(entry, 'key'));
  }
  return [];
}

function putEntry(jvm, obj, key, value) {
  const map = ensureMap(obj);
  const ckey = canonicalKey(key);
  const existing = map.get(ckey);
  const oldValue = existing ? existing.value : undefined;
  map.set(ckey, { type: 'java/util/Map$Entry', key, value, backingMap: obj });
  return oldValue === undefined ? null : oldValue;
}

function copyEntries(jvm, target, source) {
  for (const entry of entriesFrom(source)) {
    putEntry(jvm, target, entry.key, entry.value);
  }
}

function mapValues(obj) {
  return Array.from(ensureMap(obj).values());
}

module.exports = {
  super: {
    type: 'java/util/AbstractMap'
  },
  interfaces: ['java/util/Map'],
  methods: {
    '<init>()V': (jvm, obj, args, thread) => {
      obj.map = new Map();
      obj.sizeCache = 0;
    },
    '<init>(I)V': (jvm, obj, args, thread) => {
      obj.map = new Map();
      obj.sizeCache = 0;
    },
    '<init>(IF)V': (jvm, obj, args, thread) => {
      obj.map = new Map();
      obj.sizeCache = 0;
    },
    '<init>(Ljava/util/Map;)V': (jvm, obj, args) => {
      obj.map = new Map();
      copyEntries(jvm, obj, args[0]);
      obj.sizeCache = obj.map.size;
    },
    'size()I': (jvm, obj, args) => ensureMap(obj).size,
    'isEmpty()Z': (jvm, obj, args) => ensureMap(obj).size === 0 ? 1 : 0,
    'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => putEntry(jvm, obj, args[0], args[1]),
    'get(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const entry = ensureMap(obj).get(canonicalKey(args[0]));
      return entry ? entry.value : null;
    },
    'containsKey(Ljava/lang/Object;)Z': (jvm, obj, args) => ensureMap(obj).has(canonicalKey(args[0])) ? 1 : 0,
    'containsValue(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const value = args[0];
      return mapValues(obj).some((entry) => javaEquals(jvm, entry.value, value)) ? 1 : 0;
    },
    'remove(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const map = ensureMap(obj);
      const ckey = canonicalKey(args[0]);
      const entry = map.get(ckey);
      map.delete(ckey);
      return entry ? entry.value : null;
    },
    'clear()V': (jvm, obj, args) => ensureMap(obj).clear(),
    'putAll(Ljava/util/Map;)V': (jvm, obj, args) => {
      copyEntries(jvm, obj, args[0]);
    },
    'keySet()Ljava/util/Set;': (jvm, obj, args) => ({
      type: 'java/util/HashSet',
      items: new Set(mapValues(obj).map((entry) => entry.key)),
    }),
    'values()Ljava/util/Collection;': (jvm, obj, args) => {
      const values = mapValues(obj).map((entry) => entry.value);
      return {
        type: 'java/util/ArrayList',
        items: values,
        array: values,
        size: values.length,
      };
    },
    'entrySet()Ljava/util/Set;': (jvm, obj, args) => ({
      type: 'java/util/HashSet',
      items: new Set(mapValues(obj)),
    }),
    'putIfAbsent(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const key = args[0];
      const map = ensureMap(obj);
      const ckey = canonicalKey(key);
      const existing = map.get(ckey);
      if (!existing) {
        map.set(ckey, { type: 'java/util/Map$Entry', key, value: args[1], backingMap: obj });
        return null;
      }
      return existing.value;
    },
    'replace(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const map = ensureMap(obj);
      const ckey = canonicalKey(args[0]);
      const entry = map.get(ckey);
      if (!entry) return null;
      const oldValue = entry.value;
      entry.value = args[1];
      return oldValue;
    },
    'computeIfAbsent(Ljava/lang/Object;Ljava/util/function/Function;)Ljava/lang/Object;': (jvm, obj, args) => {
      const key = args[0];
      const mappingFunction = args[1];
      const map = ensureMap(obj);
      const ckey = canonicalKey(key);
      const existing = map.get(ckey);
      if (existing) return existing.value;
      if (!mappingFunction) return null;
      const newValue = mappingFunction.methods['apply(Ljava/lang/Object;)Ljava/lang/Object;'](null, mappingFunction, [key]);
      if (newValue === null || newValue === undefined) return null;
      map.set(ckey, { type: 'java/util/Map$Entry', key, value: newValue, backingMap: obj });
      return newValue;
    },
    'getOrDefault(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const entry = ensureMap(obj).get(canonicalKey(args[0]));
      return entry ? entry.value : args[1];
    },
  },
  staticFields: {
    DEFAULT_LOAD_FACTOR: 0.75,
    DEFAULT_INITIAL_CAPACITY: 16,
  },
};
