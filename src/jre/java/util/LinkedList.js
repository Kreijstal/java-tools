function backingArray(obj) {
  if (!obj.array) {
    if (Array.isArray(obj.items)) obj.array = obj.items;
    else obj.array = [];
  }
  obj.items = obj.array;
  obj.size = obj.array.length;
  return obj.array;
}
function copyCollection(src) {
  if (!src) return [];
  if (Array.isArray(src.array)) return src.array.slice();
  if (Array.isArray(src.items)) return src.items.slice();
  if (src.set instanceof Set) return Array.from(src.set);
  return [];
}
function iterator(array) {
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
function listIterator(array, start = 0) {
  return {
    type: 'java/util/ListIterator',
    array,
    index: start,
    lastIndex: -1,
    hasNext() { return this.index < this.array.length ? 1 : 0; },
    next() {
      if (this.index >= this.array.length) throw { type: 'java/util/NoSuchElementException' };
      this.lastIndex = this.index;
      return this.array[this.index++];
    },
    hasPrevious() { return this.index > 0 ? 1 : 0; },
    previous() {
      if (this.index <= 0) throw { type: 'java/util/NoSuchElementException' };
      this.lastIndex = --this.index;
      return this.array[this.index];
    },
    nextIndex() { return this.index; },
    previousIndex() { return this.index - 1; },
    remove() {
      if (this.lastIndex < 0) throw { type: 'java/lang/IllegalStateException' };
      this.array.splice(this.lastIndex, 1);
      if (this.lastIndex < this.index) this.index--;
      this.lastIndex = -1;
    },
    set(value) {
      if (this.lastIndex < 0) throw { type: 'java/lang/IllegalStateException' };
      this.array[this.lastIndex] = value;
    },
    add(value) {
      this.array.splice(this.index, 0, value);
      this.index++;
      this.lastIndex = -1;
    },
  };
}

module.exports = {
  super: 'java/util/AbstractSequentialList',
  interfaces: ['java/util/List', 'java/util/Deque'],
  methods: {
    '<init>()V': (jvm, obj) => { obj.array = []; obj.items = obj.array; obj.size = 0; },
    '<init>(Ljava/util/Collection;)V': (jvm, obj, args) => { obj.array = copyCollection(args[0]); obj.items = obj.array; obj.size = obj.array.length; },
    'size()I': (jvm, obj) => backingArray(obj).length,
    'isEmpty()Z': (jvm, obj) => backingArray(obj).length === 0 ? 1 : 0,
    'add(Ljava/lang/Object;)Z': (jvm, obj, args) => { const a = backingArray(obj); a.push(args[0]); obj.size = a.length; return 1; },
    'add(ILjava/lang/Object;)V': (jvm, obj, args) => { const a = backingArray(obj); a.splice(args[0], 0, args[1]); obj.size = a.length; },
    'addAll(Ljava/util/Collection;)Z': (jvm, obj, args) => { const a = backingArray(obj); const values = copyCollection(args[0]); if (values.length === 0) return 0; a.push(...values); obj.size = a.length; return 1; },
    'addAll(ILjava/util/Collection;)Z': (jvm, obj, args) => { const a = backingArray(obj); const values = copyCollection(args[1]); if (values.length === 0) return 0; a.splice(args[0], 0, ...values); obj.size = a.length; return 1; },
    'addFirst(Ljava/lang/Object;)V': (jvm, obj, args) => { const a = backingArray(obj); a.unshift(args[0]); obj.size = a.length; },
    'addLast(Ljava/lang/Object;)V': (jvm, obj, args) => { const a = backingArray(obj); a.push(args[0]); obj.size = a.length; },
    'offer(Ljava/lang/Object;)Z': (jvm, obj, args) => { const a = backingArray(obj); a.push(args[0]); obj.size = a.length; return 1; },
    'push(Ljava/lang/Object;)V': (jvm, obj, args) => { const a = backingArray(obj); a.unshift(args[0]); obj.size = a.length; },
    'pop()Ljava/lang/Object;': (jvm, obj) => { const a = backingArray(obj); obj.size = Math.max(0, a.length - 1); return a.shift() || null; },
    'poll()Ljava/lang/Object;': (jvm, obj) => { const a = backingArray(obj); const v = a.shift(); obj.size = a.length; return v === undefined ? null : v; },
    'remove()Ljava/lang/Object;': (jvm, obj) => { const a = backingArray(obj); const v = a.shift(); obj.size = a.length; return v === undefined ? null : v; },
    'removeFirst()Ljava/lang/Object;': (jvm, obj) => { const a = backingArray(obj); const v = a.shift(); obj.size = a.length; return v === undefined ? null : v; },
    'removeLast()Ljava/lang/Object;': (jvm, obj) => { const a = backingArray(obj); const v = a.pop(); obj.size = a.length; return v === undefined ? null : v; },
    'get(I)Ljava/lang/Object;': (jvm, obj, args) => backingArray(obj)[args[0]],
    'getFirst()Ljava/lang/Object;': (jvm, obj) => backingArray(obj)[0] || null,
    'getLast()Ljava/lang/Object;': (jvm, obj) => { const a = backingArray(obj); return a.length ? a[a.length - 1] : null; },
    'peek()Ljava/lang/Object;': (jvm, obj) => backingArray(obj)[0] || null,
    'set(ILjava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => { const a = backingArray(obj); const old = a[args[0]]; a[args[0]] = args[1]; return old; },
    'remove(I)Ljava/lang/Object;': (jvm, obj, args) => { const a = backingArray(obj); const old = a.splice(args[0], 1)[0]; obj.size = a.length; return old === undefined ? null : old; },
    'remove(Ljava/lang/Object;)Z': (jvm, obj, args) => { const a = backingArray(obj); const i = a.indexOf(args[0]); if (i < 0) return 0; a.splice(i, 1); obj.size = a.length; return 1; },
    'clear()V': (jvm, obj) => { const a = backingArray(obj); a.length = 0; obj.size = 0; },
    'contains(Ljava/lang/Object;)Z': (jvm, obj, args) => backingArray(obj).includes(args[0]) ? 1 : 0,
    'containsAll(Ljava/util/Collection;)Z': (jvm, obj, args) => { const a = backingArray(obj); return copyCollection(args[0]).every(v => a.includes(v)) ? 1 : 0; },
    'indexOf(Ljava/lang/Object;)I': (jvm, obj, args) => backingArray(obj).indexOf(args[0]),
    'lastIndexOf(Ljava/lang/Object;)I': (jvm, obj, args) => backingArray(obj).lastIndexOf(args[0]),
    'iterator()Ljava/util/Iterator;': (jvm, obj) => iterator(backingArray(obj)),
    'listIterator()Ljava/util/ListIterator;': (jvm, obj) => listIterator(backingArray(obj)),
    'listIterator(I)Ljava/util/ListIterator;': (jvm, obj, args) => listIterator(backingArray(obj), args[0]),
    'descendingIterator()Ljava/util/Iterator;': (jvm, obj) => iterator(backingArray(obj).slice().reverse()),
    'toArray()[Ljava/lang/Object;': (jvm, obj) => { const out = backingArray(obj).slice(); out.type = '[Ljava/lang/Object;'; out.elementType = 'java/lang/Object'; out.hashCode = jvm.nextHashCode++; return out; },
    'toArray([Ljava/lang/Object;)[Ljava/lang/Object;': (jvm, obj, args) => { const values = backingArray(obj); const out = args[0] && args[0].length >= values.length ? args[0] : new Array(values.length); for (let i = 0; i < values.length; i++) out[i] = values[i]; if (out.length > values.length) out[values.length] = null; out.type = args[0] && args[0].type ? args[0].type : '[Ljava/lang/Object;'; out.elementType = args[0] && args[0].elementType ? args[0].elementType : 'java/lang/Object'; return out; },
  },
};
