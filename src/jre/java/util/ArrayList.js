function backingArray(obj) {
  if (!obj.array) {
    if (obj.items && Array.isArray(obj.items)) obj.array = obj.items;
    else if (obj.list && Array.isArray(obj.list)) obj.array = obj.list;
    else obj.array = [];
  }
  obj.items = obj.array;
  obj.size = obj.array.length;
  return obj.array;
}

function collectionToArray(collection) {
  if (!collection) return [];
  if (Array.isArray(collection.array)) return collection.array;
  if (Array.isArray(collection.items)) return collection.items;
  if (Array.isArray(collection.list)) return collection.list;
  if (collection.set instanceof Set) return Array.from(collection.set);
  if (collection.map instanceof Map) return Array.from(collection.map.values());
  return [];
}

function classNameOf(obj) { return obj && (obj._className || obj.type); }
function fieldValue(obj, fieldName) {
  if (!obj) return undefined;
  if (obj.fields) {
    const key = Object.keys(obj.fields).find(k => k.endsWith(`.${fieldName}`));
    if (key) return obj.fields[key];
  }
  return obj[fieldName];
}
function bitSetEquals(a, b) {
  const ab = a && a.bits instanceof Set ? a.bits : null;
  const bb = b && b.bits instanceof Set ? b.bits : null;
  if (!ab || !bb || ab.size !== bb.size) return false;
  for (const v of ab) if (!bb.has(v)) return false;
  return true;
}
function javaEquals(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const av = Object.prototype.hasOwnProperty.call(a, 'value') ? a.value : undefined;
  const bv = Object.prototype.hasOwnProperty.call(b, 'value') ? b.value : undefined;
  if (av !== undefined || bv !== undefined) return av === bv;
  if ((a.type === 'java/lang/String' || a instanceof String) && (b.type === 'java/lang/String' || b instanceof String)) return String(a) === String(b);
  const at = classNameOf(a), bt = classNameOf(b);
  if (at !== bt) return false;
  if (at === 'java/util/BitSet') return bitSetEquals(a, b);
  if (at === 'org/benf/cfr/reader/bytecode/analysis/parse/utils/SSAIdent') return javaEquals(fieldValue(a, 'val'), fieldValue(b, 'val'));
  if (at === 'org/benf/cfr/reader/bytecode/analysis/variables/Slot') return fieldValue(a, 'idx') === fieldValue(b, 'idx');
  if (at === 'org/benf/cfr/reader/bytecode/analysis/parse/utils/Pair') return javaEquals(fieldValue(a, 'x'), fieldValue(b, 'x')) && javaEquals(fieldValue(a, 'y'), fieldValue(b, 'y'));
  return false;
}
function findIndexJava(array, target) { return array.findIndex(value => javaEquals(value, target)); }

function iteratorFor(jvm, array) {
  return {
    type: 'java/util/Iterator',
    array,
    index: 0,
    lastIndex: -1,
    hasNext() { return this.index < this.array.length ? 1 : 0; },
    next() {
      if (this.index >= this.array.length) throw { type: 'java/util/NoSuchElementException' };
      this.lastIndex = this.index;
      return this.array[this.index++];
    },
    remove() {
      if (this.lastIndex < 0) throw { type: 'java/lang/IllegalStateException' };
      this.array.splice(this.lastIndex, 1);
      if (this.lastIndex < this.index) this.index--;
      this.lastIndex = -1;
    },
  };
}

module.exports = {
  super: 'java/util/AbstractCollection',
  interfaces: ['java/util/List', 'java/util/RandomAccess'],
  methods: {
    '<init>()V': (jvm, obj) => { obj.array = []; obj.items = obj.array; obj.size = 0; },
    '<init>(I)V': (jvm, obj) => { obj.array = []; obj.items = obj.array; obj.size = 0; },
    '<init>(Ljava/util/Collection;)V': (jvm, obj, args) => {
      obj.array = collectionToArray(args[0]).slice();
      obj.items = obj.array;
      obj.size = obj.array.length;
    },
    'ensureCapacity(I)V': (jvm, obj) => { backingArray(obj); },
    'trimToSize()V': (jvm, obj) => { backingArray(obj); },
    'add(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const a = backingArray(obj);
      a.push(args[0]);
      obj.size = a.length;
      return 1;
    },
    'add(ILjava/lang/Object;)V': (jvm, obj, args) => {
      const a = backingArray(obj);
      a.splice(args[0], 0, args[1]);
      obj.size = a.length;
    },
    'addAll(Ljava/util/Collection;)Z': (jvm, obj, args) => {
      const a = backingArray(obj);
      const values = collectionToArray(args[0]);
      if (values.length === 0) return 0;
      a.push(...values);
      obj.size = a.length;
      return 1;
    },
    'addAll(ILjava/util/Collection;)Z': (jvm, obj, args) => {
      const a = backingArray(obj);
      const values = collectionToArray(args[1]);
      if (values.length === 0) return 0;
      a.splice(args[0], 0, ...values);
      obj.size = a.length;
      return 1;
    },
    'get(I)Ljava/lang/Object;': (jvm, obj, args) => backingArray(obj)[args[0]],
    'set(ILjava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const a = backingArray(obj);
      const old = a[args[0]];
      a[args[0]] = args[1];
      return old;
    },
    'remove(I)Ljava/lang/Object;': (jvm, obj, args) => {
      const a = backingArray(obj);
      const old = a.splice(args[0], 1)[0];
      obj.size = a.length;
      return old === undefined ? null : old;
    },
    'remove(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const a = backingArray(obj);
      const i = findIndexJava(a, args[0]);
      if (i < 0) return 0;
      a.splice(i, 1);
      obj.size = a.length;
      return 1;
    },
    'removeAll(Ljava/util/Collection;)Z': (jvm, obj, args) => {
      const a = backingArray(obj);
      const remove = collectionToArray(args[0]);
      const before = a.length;
      for (let i = a.length - 1; i >= 0; i--) {
        if (remove.some(value => javaEquals(value, a[i]))) a.splice(i, 1);
      }
      obj.size = a.length;
      return a.length !== before ? 1 : 0;
    },
    'retainAll(Ljava/util/Collection;)Z': (jvm, obj, args) => {
      const a = backingArray(obj);
      const retain = collectionToArray(args[0]);
      const before = a.length;
      for (let i = a.length - 1; i >= 0; i--) {
        if (!retain.some(value => javaEquals(value, a[i]))) a.splice(i, 1);
      }
      obj.size = a.length;
      return a.length !== before ? 1 : 0;
    },
    'clear()V': (jvm, obj) => { const a = backingArray(obj); a.length = 0; obj.size = 0; },
    'size()I': (jvm, obj) => backingArray(obj).length,
    'isEmpty()Z': (jvm, obj) => backingArray(obj).length === 0 ? 1 : 0,
    'contains(Ljava/lang/Object;)Z': (jvm, obj, args) => findIndexJava(backingArray(obj), args[0]) >= 0 ? 1 : 0,
    'containsAll(Ljava/util/Collection;)Z': (jvm, obj, args) => {
      const a = backingArray(obj);
      return collectionToArray(args[0]).every(v => findIndexJava(a, v) >= 0) ? 1 : 0;
    },
    'indexOf(Ljava/lang/Object;)I': (jvm, obj, args) => findIndexJava(backingArray(obj), args[0]),
    'lastIndexOf(Ljava/lang/Object;)I': (jvm, obj, args) => {
      const a = backingArray(obj);
      for (let i = a.length - 1; i >= 0; i--) if (javaEquals(a[i], args[0])) return i;
      return -1;
    },
    'iterator()Ljava/util/Iterator;': (jvm, obj) => iteratorFor(jvm, backingArray(obj)),
    'listIterator()Ljava/util/ListIterator;': (jvm, obj) => iteratorFor(jvm, backingArray(obj)),
    'toArray()[Ljava/lang/Object;': (jvm, obj) => {
      const out = backingArray(obj).slice();
      out.type = '[Ljava/lang/Object;';
      out.elementType = 'java/lang/Object';
      out.hashCode = jvm.nextHashCode++;
      return out;
    },
    'toArray([Ljava/lang/Object;)[Ljava/lang/Object;': (jvm, obj, args) => {
      const values = backingArray(obj);
      const out = args[0] && args[0].length >= values.length ? args[0] : new Array(values.length);
      for (let i = 0; i < values.length; i++) out[i] = values[i];
      if (out.length > values.length) out[values.length] = null;
      out.type = args[0] && args[0].type ? args[0].type : '[Ljava/lang/Object;';
      out.elementType = args[0] && args[0].elementType ? args[0].elementType : 'java/lang/Object';
      return out;
    },
    'sort(Ljava/util/Comparator;)V': (jvm, obj, args) => {
      const comparator = args[0];
      const a = backingArray(obj);
      if (!comparator) a.sort();
      else a.sort((x, y) => {
        const method = jvm._jreFindMethod(comparator.type, 'compare', '(Ljava/lang/Object;Ljava/lang/Object;)I');
        return method ? method(jvm, comparator, [x, y]) : 0;
      });
    },
    'equals(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const other = collectionToArray(args[0]);
      const a = backingArray(obj);
      if (a.length !== other.length) return 0;
      for (let i = 0; i < a.length; i++) if (!javaEquals(a[i], other[i])) return 0;
      return 1;
    },
  },
};
