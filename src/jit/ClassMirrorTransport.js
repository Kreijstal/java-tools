'use strict';

// Incremental structured data transport for class ASTs. The ordinary worker
// protocol clones a whole AST synchronously; even one large class can consume
// several frames. Each packet here contains a bounded number of shallow
// records, including for a single large method or constant pool. References
// preserve sharing and cycles without retaining a second graph on the sender.
// A record occupies four consecutive cells (opcode, target, key/type, value).
// Low opcode bits select create/property/map/set; bits 4 and 8 mark references.
// Flat records avoid allocating an array for every AST property and reference.
function isReference(value) { return value !== null && typeof value === "object"; }

class ClassMirrorEncoder {
  constructor(value) {
    this.ids = new WeakMap();
    this.objects = [];
    this.records = [];
    this.cursor = 0;
    this.current = null;
    this.state = {};
    this.rootReference = value !== null && typeof value === "object";
    this.root = this.reference(value);
  }

  reference(value) {
    if (value === null || typeof value !== 'object') return value;
    let id = this.ids.get(value);
    if (id !== undefined) return id;
    id = this.objects.length / 2;
    this.ids.set(value, id);
    let kind = 'object';
    if (Array.isArray(value)) kind = 'array';
    else if (value instanceof Map) kind = 'map';
    else if (value instanceof Set) kind = 'set';
    else if (ArrayBuffer.isView(value)) kind = 'view';
    else if (Object.prototype.toString.call(value) !== '[object Object]') kind = 'atomic';
    this.objects.push(value, kind);
    if (kind === 'view') {
      const buffer = this.reference(value.buffer);
      this.records.push(0, id, kind, [buffer,
        Object.prototype.toString.call(value).slice(8, -1), value.byteOffset,
        value instanceof DataView ? value.byteLength : value.length]);
      return id;
    }
    this.records.push(0, id, kind,
      kind === 'array' ? value.length : kind === 'atomic' ? value : undefined);
    return id;
  }

  next(maxRecords = 1024, maxMs = 2) {
    const start = performance.now();
    const packet = this.records;
    let steps = 0;
    while (packet.length < maxRecords * 4 &&
        (steps++ % 32 !== 0 || performance.now() - start < maxMs)) {
      if (!this.current) {
        if (this.cursor === this.objects.length) break;
        const id = this.cursor / 2;
        const value = this.objects[this.cursor], kind = this.objects[this.cursor + 1];
        this.objects[this.cursor++] = null;
        this.objects[this.cursor++] = null;
        if (kind === 'atomic' || kind === 'view') continue;
        const state = this.state;
        state.id = id;
        state.value = value;
        state.kind = kind;
        state.index = 0;
        state.keys = kind === 'object' || kind === 'array' ? Object.keys(value) : null;
        state.iterator = kind === 'map' || kind === 'set' ? value.entries() : null;
        this.current = state;
      }
      const state = this.current;
      if (state.keys) {
        if (state.index === state.keys.length) { this.current = null; continue; }
        const key = state.keys[state.index++];
        const raw = state.value[key];
        const value = this.reference(raw);
        packet.push(raw !== null && typeof raw === "object" ? 5 : 1, state.id, key, value);
      } else {
        const next = state.iterator.next();
        if (next.done) { this.current = null; continue; }
        const key = this.reference(next.value[0]);
        if (state.kind === 'map') {
          const value = this.reference(next.value[1]);
          const op = 2 | (isReference(next.value[0]) ? 4 : 0) | (isReference(next.value[1]) ? 8 : 0);
          packet.push(op, state.id, key, value);
        } else packet.push(isReference(next.value[0]) ? 7 : 3, state.id, key, undefined);
      }
    }
    this.records = [];
    return { records: packet, root: this.root, rootReference: this.rootReference,
      done: !this.current && this.cursor === this.objects.length };
  }
}

class ClassMirrorDecoder {
  constructor() { this.objects = []; }
  accept(packet) {
    const records = packet.records;
    for (let index = 0; index < records.length; index += 4) {
      const op = records[index], id = records[index + 1];
      const key = records[index + 2], value = records[index + 3];
      if (op === 0) {
        if (key === 'view') {
          const [buffer, name, offset, length] = value;
          const constructors = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array,
            Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
            BigInt64Array, BigUint64Array, DataView };
          this.objects[id] = new constructors[name](this.objects[buffer], offset, length);
          continue;
        }
        this.objects[id] = key === 'array' ? new Array(value) :
          key === 'map' ? new Map() : key === 'set' ? new Set() :
            key === 'atomic' ? value : {};
      } else if ((op & 3) === 1) {
        const decoded = op & 4 ? this.objects[value] : value;
        // Copy __proto__ as data, without mutating the object's prototype.
        if (key === '__proto__') Object.defineProperty(this.objects[id], key,
          { value: decoded, enumerable: true, writable: true, configurable: true });
        else this.objects[id][key] = decoded;
      } else if ((op & 3) === 2) {
        this.objects[id].set(op & 4 ? this.objects[key] : key,
          op & 8 ? this.objects[value] : value);
      } else if ((op & 3) === 3) this.objects[id].add(op & 4 ? this.objects[key] : key);
    }
    if (!packet.done) return undefined;
    const result = packet.rootReference ? this.objects[packet.root] : packet.root;
    this.objects = [];
    return result;
  }
}

module.exports = { ClassMirrorEncoder, ClassMirrorDecoder };
