'use strict';

// Class file writer (JVMS chapter 4): constant pool, fields, methods and the
// attributes the compiler emits.

class ByteWriter {
  constructor(size) {
    this.buf = Buffer.alloc(size || 256);
    this.len = 0;
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = Buffer.alloc(cap);
    this.buf.copy(nb, 0, 0, this.len);
    this.buf = nb;
  }
  u1(v) { this.ensure(1); this.buf[this.len++] = v & 0xff; }
  u2(v) { this.ensure(2); this.buf.writeUInt16BE(v & 0xffff, this.len); this.len += 2; }
  u4(v) { this.ensure(4); this.buf.writeUInt32BE(v >>> 0, this.len); this.len += 4; }
  s4(v) { this.ensure(4); this.buf.writeInt32BE(v | 0, this.len); this.len += 4; }
  bytes(b) { this.ensure(b.length); for (let i = 0; i < b.length; i++) this.buf[this.len++] = b[i]; }
  put(other) { this.ensure(other.len); other.buf.copy(this.buf, this.len, 0, other.len); this.len += other.len; }
  toBuffer() { return this.buf.subarray(0, this.len); }
}

// Modified UTF-8 (JVMS 4.4.7)
function modifiedUtf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 0 && c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

const CONST = {
  Utf8: 1, Integer: 3, Float: 4, Long: 5, Double: 6, Class: 7, String: 8, Fieldref: 9, Methodref: 10,
  InterfaceMethodref: 11, NameAndType: 12, MethodHandle: 15, MethodType: 16, Dynamic: 17, InvokeDynamic: 18,
  Module: 19, Package: 20,
};

const REF = {
  getField: 1, getStatic: 2, putField: 3, putStatic: 4, invokeVirtual: 5, invokeStatic: 6,
  invokeSpecial: 7, newInvokeSpecial: 8, invokeInterface: 9,
};

class ConstantPool {
  constructor() {
    this.entries = [null]; // index 0 unused
    this.map = new Map();
    this.bootstrap = []; // {mh, args}
    this.bootstrapMap = new Map();
  }

  add(key, entry, wide) {
    const k = this.map.get(key);
    if (k !== undefined) return k;
    const idx = this.entries.length;
    this.entries.push(entry);
    if (wide) this.entries.push(null);
    if (this.entries.length > 65535) throw new Error('constant pool overflow');
    this.map.set(key, idx);
    return idx;
  }

  utf8(s) { return this.add(`U${s}`, { tag: CONST.Utf8, value: s }); }
  int(v) { return this.add(`I${v | 0}`, { tag: CONST.Integer, value: v | 0 }); }
  float(v) {
    const b = Buffer.alloc(4);
    b.writeFloatBE(v);
    // canonical NaN
    if (Number.isNaN(v)) b.writeUInt32BE(0x7fc00000);
    const bits = b.readUInt32BE(0);
    return this.add(`F${bits}`, { tag: CONST.Float, bits });
  }
  long(v) { const b = BigInt.asIntN(64, BigInt(v)); return this.add(`J${b}`, { tag: CONST.Long, value: b }, true); }
  double(v) {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v);
    if (Number.isNaN(v)) { b.writeUInt32BE(0x7ff80000, 0); b.writeUInt32BE(0, 4); }
    const hi = b.readUInt32BE(0);
    const lo = b.readUInt32BE(4);
    return this.add(`D${hi}:${lo}`, { tag: CONST.Double, hi, lo }, true);
  }
  clazz(internalName) { return this.add(`C${internalName}`, { tag: CONST.Class, name: this.utf8(internalName) }); }
  string(s) { return this.add(`S${s}`, { tag: CONST.String, str: this.utf8(s) }); }
  nameAndType(name, desc) { return this.add(`N${name}:${desc}`, { tag: CONST.NameAndType, name: this.utf8(name), desc: this.utf8(desc) }); }
  fieldref(owner, name, desc) {
    return this.add(`f${owner}.${name}:${desc}`, { tag: CONST.Fieldref, owner: this.clazz(owner), nat: this.nameAndType(name, desc) });
  }
  methodref(owner, name, desc, itf) {
    return this.add(`${itf ? 'i' : 'm'}${owner}.${name}:${desc}`, { tag: itf ? CONST.InterfaceMethodref : CONST.Methodref, owner: this.clazz(owner), nat: this.nameAndType(name, desc) });
  }
  methodHandle(kind, owner, name, desc, itf) {
    const ref = kind <= 4 ? this.fieldref(owner, name, desc) : this.methodref(owner, name, desc, itf);
    return this.add(`H${kind}:${ref}`, { tag: CONST.MethodHandle, kind, ref });
  }
  methodType(desc) { return this.add(`T${desc}`, { tag: CONST.MethodType, desc: this.utf8(desc) }); }
  module(name) { return this.add(`M${name}`, { tag: CONST.Module, name: this.utf8(name) }); }
  packge(name) { return this.add(`P${name}`, { tag: CONST.Package, name: this.utf8(name) }); }

  // bootstrap method: mh index + static argument constant indices
  bootstrapMethod(mh, args) {
    const key = `${mh}:${args.join(',')}`;
    let idx = this.bootstrapMap.get(key);
    if (idx === undefined) {
      idx = this.bootstrap.length;
      this.bootstrap.push({ mh, args });
      this.bootstrapMap.set(key, idx);
    }
    return idx;
  }
  invokeDynamic(bsmIndex, name, desc) {
    return this.add(`Y${bsmIndex}:${name}:${desc}`, { tag: CONST.InvokeDynamic, bsm: bsmIndex, nat: this.nameAndType(name, desc) });
  }
  dynamic(bsmIndex, name, desc) {
    return this.add(`Q${bsmIndex}:${name}:${desc}`, { tag: CONST.Dynamic, bsm: bsmIndex, nat: this.nameAndType(name, desc) });
  }

  write(w) {
    w.u2(this.entries.length);
    for (let i = 1; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e) continue;
      w.u1(e.tag);
      switch (e.tag) {
        case CONST.Utf8: {
          const b = modifiedUtf8(e.value);
          if (b.length > 65535) throw new Error('UTF8 constant too long');
          w.u2(b.length);
          w.bytes(b);
          break;
        }
        case CONST.Integer: w.s4(e.value); break;
        case CONST.Float: w.u4(e.bits); break;
        case CONST.Long: {
          const u = BigInt.asUintN(64, e.value);
          w.u4(Number(u >> 32n));
          w.u4(Number(u & 0xffffffffn));
          break;
        }
        case CONST.Double: w.u4(e.hi); w.u4(e.lo); break;
        case CONST.Class: w.u2(e.name); break;
        case CONST.String: w.u2(e.str); break;
        case CONST.Fieldref: case CONST.Methodref: case CONST.InterfaceMethodref: w.u2(e.owner); w.u2(e.nat); break;
        case CONST.NameAndType: w.u2(e.name); w.u2(e.desc); break;
        case CONST.MethodHandle: w.u1(e.kind); w.u2(e.ref); break;
        case CONST.MethodType: w.u2(e.desc); break;
        case CONST.Dynamic: case CONST.InvokeDynamic: w.u2(e.bsm); w.u2(e.nat); break;
        case CONST.Module: case CONST.Package: w.u2(e.name); break;
        default: throw new Error(`bad constant tag ${e.tag}`);
      }
    }
  }
}

// An attribute is {name, data: ByteWriter | Buffer}
class ClassFile {
  constructor(major) {
    this.major = major || 72; // Java 28
    this.minor = 0;
    this.pool = new ConstantPool();
    this.access = 0;
    this.thisClass = null;
    this.superClass = null;
    this.interfaces = [];
    this.fields = [];
    this.methods = [];
    this.attributes = [];
  }

  attr(name, writer) {
    return { name: this.pool.utf8(name), data: writer };
  }

  toBuffer() {
    const body = new ByteWriter(4096);
    body.u2(this.access);
    body.u2(this.pool.clazz(this.thisClass));
    body.u2(this.superClass ? this.pool.clazz(this.superClass) : 0);
    body.u2(this.interfaces.length);
    for (const i of this.interfaces) body.u2(this.pool.clazz(i));
    const writeMembers = (list) => {
      body.u2(list.length);
      for (const m of list) {
        body.u2(m.access);
        body.u2(this.pool.utf8(m.name));
        body.u2(this.pool.utf8(m.desc));
        body.u2(m.attributes.length);
        for (const a of m.attributes) this.writeAttr(body, a);
      }
    };
    writeMembers(this.fields);
    writeMembers(this.methods);
    // BootstrapMethods must be added after all code has been generated
    if (this.pool.bootstrap.length) {
      const w = new ByteWriter();
      w.u2(this.pool.bootstrap.length);
      for (const b of this.pool.bootstrap) {
        w.u2(b.mh);
        w.u2(b.args.length);
        for (const a of b.args) w.u2(a);
      }
      this.attributes.push(this.attr('BootstrapMethods', w));
    }
    body.u2(this.attributes.length);
    for (const a of this.attributes) this.writeAttr(body, a);
    const out = new ByteWriter(body.len + 65536);
    out.u4(0xcafebabe);
    out.u2(this.minor);
    out.u2(this.major);
    this.pool.write(out);
    out.put(body);
    return out.toBuffer();
  }

  writeAttr(w, a) {
    w.u2(a.name);
    const data = a.data instanceof ByteWriter ? a.data.toBuffer() : a.data;
    w.u4(data.length);
    w.bytes(data);
  }
}

module.exports = { ByteWriter, ConstantPool, ClassFile, CONST, REF, modifiedUtf8 };
