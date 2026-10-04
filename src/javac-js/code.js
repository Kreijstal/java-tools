'use strict';

// Bytecode assembler for one method: symbolic instructions with labels,
// jump relaxation (goto_w), stack map frames (computed by dataflow in
// frames.js), exception table, line numbers.

const { ByteWriter } = require('./classfile');
const { computeFrames } = require('./frames');

const OP = require('./code-ops');

const NEGATE = {
  [OP.ifeq]: OP.ifne, [OP.ifne]: OP.ifeq, [OP.iflt]: OP.ifge, [OP.ifge]: OP.iflt, [OP.ifgt]: OP.ifle, [OP.ifle]: OP.ifgt,
  [OP.if_icmpeq]: OP.if_icmpne, [OP.if_icmpne]: OP.if_icmpeq, [OP.if_icmplt]: OP.if_icmpge, [OP.if_icmpge]: OP.if_icmplt,
  [OP.if_icmpgt]: OP.if_icmple, [OP.if_icmple]: OP.if_icmpgt, [OP.if_acmpeq]: OP.if_acmpne, [OP.if_acmpne]: OP.if_acmpeq,
  [OP.ifnull]: OP.ifnonnull, [OP.ifnonnull]: OP.ifnull,
};

class Label {
  constructor(id) {
    this.id = id;
    this.index = -1; // instruction index where placed
    this.offset = -1;
    this.targeted = false;
  }
}

class Code {
  constructor(pool, opts) {
    this.pool = pool;
    this.instrs = []; // {op, ...}
    this.handlers = []; // {start, end, handler, type}
    this.labelCount = 0;
    this.maxLocals = opts.maxLocals || 0;
    this.nextLocal = opts.maxLocals || 0;
    this.alive = true;
    this.lines = []; // {index, line}
    this.owner = opts.owner; // internal name of the class
    this.isCtor = opts.isCtor;
    this.isStatic = opts.isStatic;
    this.paramDescs = opts.paramDescs || [];
    this.hierarchy = opts.hierarchy;
    this.methodName = opts.methodName;
  }

  newLabel() { return new Label(this.labelCount++); }

  place(label) {
    label.index = this.instrs.length;
    this.instrs.push({ op: -1, label });
    if (label.targeted) this.alive = true;
  }

  // place a label that is the target of earlier or later jumps (resurrects code)
  placeTarget(label) {
    label.targeted = true;
    this.place(label);
    this.alive = true;
  }

  line(n) {
    if (!this.alive) return;
    const last = this.lines[this.lines.length - 1];
    if (last && last.index === this.instrs.length) { last.line = n; return; }
    if (last && last.line === n) return;
    this.lines.push({ index: this.instrs.length, line: n });
  }

  newLocal(size) {
    const idx = this.nextLocal;
    this.nextLocal += size || 1;
    if (this.nextLocal > this.maxLocals) this.maxLocals = this.nextLocal;
    return idx;
  }

  // ---- emission ----------------------------------------------------------------
  push(ins) {
    if (!this.alive) return null;
    this.instrs.push(ins);
    const op = ins.op;
    if (op === OP.goto || op === OP.goto_w || op === OP.athrow || (op >= OP.ireturn && op <= OP.return) || op === OP.tableswitch || op === OP.lookupswitch) {
      this.alive = false;
    }
    return ins;
  }

  op(op) { return this.push({ op }); }

  local(op, idx) {
    if (idx >= this.maxLocals) this.maxLocals = idx + (op === OP.lload || op === OP.dload || op === OP.lstore || op === OP.dstore ? 2 : 1);
    return this.push({ op, local: idx });
  }

  iinc(idx, c) { return this.push({ op: OP.iinc, local: idx, inc: c }); }

  iconst(v) {
    v |= 0;
    if (v >= -1 && v <= 5) return this.op(OP.iconst_0 + v);
    if (v >= -128 && v <= 127) return this.push({ op: OP.bipush, value: v });
    if (v >= -32768 && v <= 32767) return this.push({ op: OP.sipush, value: v });
    return this.push({ op: OP.ldc, cp: this.pool.int(v), ctype: 'I' });
  }

  lconst(v) {
    v = BigInt.asIntN(64, BigInt(v));
    if (v === 0n) return this.op(OP.lconst_0);
    if (v === 1n) return this.op(OP.lconst_1);
    return this.push({ op: OP.ldc2_w, cp: this.pool.long(v), ctype: 'J' });
  }

  fconst(v) {
    if (v === 0 && !Object.is(v, -0)) return this.op(OP.fconst_0);
    if (v === 1) return this.op(OP.fconst_1);
    if (v === 2) return this.op(OP.fconst_2);
    return this.push({ op: OP.ldc, cp: this.pool.float(v), ctype: 'F' });
  }

  dconst(v) {
    if (v === 0 && !Object.is(v, -0)) return this.op(OP.dconst_0);
    if (v === 1) return this.op(OP.dconst_1);
    return this.push({ op: OP.ldc2_w, cp: this.pool.double(v), ctype: 'D' });
  }

  sconst(s) { return this.push({ op: OP.ldc, cp: this.pool.string(s), ctype: 'java/lang/String' }); }

  classConst(internalName) { return this.push({ op: OP.ldc, cp: this.pool.clazz(internalName), ctype: 'java/lang/Class' }); }

  ldcDynamic(cpIndex, desc) {
    const wide = desc === 'J' || desc === 'D';
    return this.push({ op: wide ? OP.ldc2_w : OP.ldc, cp: cpIndex, ctype: descToVType(desc) });
  }

  ldcMethodType(desc) { return this.push({ op: OP.ldc, cp: this.pool.methodType(desc), ctype: 'java/lang/invoke/MethodType' }); }

  field(op, owner, name, desc) { return this.push({ op, cp: this.pool.fieldref(owner, name, desc), owner, name, desc }); }

  invoke(op, owner, name, desc, itf) {
    return this.push({ op, cp: this.pool.methodref(owner, name, desc, op === OP.invokeinterface ? true : !!itf), owner, name, desc, itf: op === OP.invokeinterface || !!itf });
  }

  invokedynamic(bsmIndex, name, desc) {
    return this.push({ op: OP.invokedynamic, cp: this.pool.invokeDynamic(bsmIndex, name, desc), name, desc });
  }

  typeOp(op, internalName) { return this.push({ op, cp: this.pool.clazz(internalName), cls: internalName }); }

  newarray(atype) { return this.push({ op: OP.newarray, atype }); }

  multianewarray(desc, dims) { return this.push({ op: OP.multianewarray, cp: this.pool.clazz(desc), cls: desc, dims }); }

  jump(op, label) {
    label.targeted = true;
    return this.push({ op, target: label });
  }

  tableswitch(low, high, dflt, labels) {
    dflt.targeted = true;
    labels.forEach((l) => { l.targeted = true; });
    return this.push({ op: OP.tableswitch, low, high, dflt, labels });
  }

  lookupswitch(dflt, keys, labels) {
    dflt.targeted = true;
    labels.forEach((l) => { l.targeted = true; });
    return this.push({ op: OP.lookupswitch, dflt, keys, labels });
  }

  handler(start, end, handlerLabel, catchType) {
    handlerLabel.targeted = true;
    this.handlers.push({ start, end, handler: handlerLabel, type: catchType || null });
  }

  // ---- layout ------------------------------------------------------------------
  // Assign byte offsets; widen jumps that do not fit in 16 bits.
  layout() {
    const ins = this.instrs;
    let changed = true;
    let iterations = 0;
    while (changed) {
      changed = false;
      iterations++;
      let off = 0;
      for (const i of ins) {
        i.offset = off;
        if (i.op === -1) { i.label.offset = off; continue; }
        off += this.sizeOf(i, off);
      }
      this.codeLength = off;
      for (const i of ins) {
        if (i.target && !i.wide) {
          const d = i.target.offset - i.offset;
          if (d < -32768 || d > 32767) { i.wide = true; changed = true; }
        }
      }
      if (iterations > 20) throw new Error('jump relaxation did not converge');
    }
  }

  sizeOf(i, off) {
    const op = i.op;
    if (i.target) {
      if (!i.wide) return 3;
      if (op === OP.goto) return 5;
      return 8; // inverted branch (3) + goto_w (5)
    }
    switch (op) {
      case OP.bipush: case OP.newarray: return 2;
      case OP.sipush: return 3;
      case OP.ldc: return i.cp > 255 ? 3 : 2;
      case OP.ldc_w: case OP.ldc2_w: return 3;
      case OP.iload: case OP.lload: case OP.fload: case OP.dload: case OP.aload:
      case OP.istore: case OP.lstore: case OP.fstore: case OP.dstore: case OP.astore:
        if (i.local <= 3) return 1;
        return i.local > 255 ? 4 : 2;
      case OP.iinc: return (i.local > 255 || i.inc < -128 || i.inc > 127) ? 6 : 3;
      case OP.getstatic: case OP.putstatic: case OP.getfield: case OP.putfield:
      case OP.invokevirtual: case OP.invokespecial: case OP.invokestatic:
      case OP.new: case OP.anewarray: case OP.checkcast: case OP.instanceof: return 3;
      case OP.invokeinterface: case OP.invokedynamic: return 5;
      case OP.multianewarray: return 4;
      case OP.tableswitch: {
        const pad = (4 - ((off + 1) % 4)) % 4;
        return 1 + pad + 12 + 4 * i.labels.length;
      }
      case OP.lookupswitch: {
        const pad = (4 - ((off + 1) % 4)) % 4;
        return 1 + pad + 8 + 8 * i.keys.length;
      }
      default: return 1;
    }
  }

  // ---- encoding ------------------------------------------------------------------
  encode() {
    const w = new ByteWriter(this.codeLength + 16);
    for (const i of this.instrs) {
      if (i.op === -1) continue;
      if (i.deadFill) {
        // unreachable code replaced by nop...athrow of the same length
        continue;
      }
      this.encodeOne(w, i);
    }
    return w;
  }

  encodeOne(w, i) {
    const op = i.op;
    if (i.target) {
      const d = i.target.offset - i.offset;
      if (!i.wide) { w.u1(op); w.u2(d); return; }
      if (op === OP.goto) { w.u1(OP.goto_w); w.s4(d); return; }
      // if<cond> L  ==>  if<!cond> +8 ; goto_w L
      w.u1(NEGATE[op]);
      w.u2(8);
      w.u1(OP.goto_w);
      w.s4(i.target.offset - (i.offset + 3));
      return;
    }
    switch (op) {
      case OP.bipush: w.u1(op); w.u1(i.value); return;
      case OP.sipush: w.u1(op); w.u2(i.value); return;
      case OP.newarray: w.u1(op); w.u1(i.atype); return;
      case OP.ldc:
        if (i.cp > 255) { w.u1(OP.ldc_w); w.u2(i.cp); } else { w.u1(OP.ldc); w.u1(i.cp); }
        return;
      case OP.ldc_w: case OP.ldc2_w: w.u1(op); w.u2(i.cp); return;
      case OP.iload: case OP.lload: case OP.fload: case OP.dload: case OP.aload:
      case OP.istore: case OP.lstore: case OP.fstore: case OP.dstore: case OP.astore: {
        const base = op <= OP.aload ? OP.iload : OP.istore;
        const shortBase = op <= OP.aload ? 26 : 59; // iload_0 / istore_0
        if (i.local <= 3) { w.u1(shortBase + (op - base) * 4 + i.local); return; }
        if (i.local > 255) { w.u1(OP.wide); w.u1(op); w.u2(i.local); return; }
        w.u1(op); w.u1(i.local);
        return;
      }
      case OP.iinc:
        if (i.local > 255 || i.inc < -128 || i.inc > 127) { w.u1(OP.wide); w.u1(OP.iinc); w.u2(i.local); w.u2(i.inc); return; }
        w.u1(op); w.u1(i.local); w.u1(i.inc);
        return;
      case OP.getstatic: case OP.putstatic: case OP.getfield: case OP.putfield:
      case OP.invokevirtual: case OP.invokespecial: case OP.invokestatic:
      case OP.new: case OP.anewarray: case OP.checkcast: case OP.instanceof:
        w.u1(op); w.u2(i.cp);
        return;
      case OP.invokeinterface: {
        w.u1(op); w.u2(i.cp);
        w.u1(argSlots(i.desc) + 1); w.u1(0);
        return;
      }
      case OP.invokedynamic: w.u1(op); w.u2(i.cp); w.u2(0); return;
      case OP.multianewarray: w.u1(op); w.u2(i.cp); w.u1(i.dims); return;
      case OP.tableswitch: {
        w.u1(op);
        const pad = (4 - ((i.offset + 1) % 4)) % 4;
        for (let k = 0; k < pad; k++) w.u1(0);
        w.s4(i.dflt.offset - i.offset);
        w.s4(i.low);
        w.s4(i.high);
        for (const l of i.labels) w.s4(l.offset - i.offset);
        return;
      }
      case OP.lookupswitch: {
        w.u1(op);
        const pad = (4 - ((i.offset + 1) % 4)) % 4;
        for (let k = 0; k < pad; k++) w.u1(0);
        w.s4(i.dflt.offset - i.offset);
        w.s4(i.keys.length);
        const order = i.keys.map((k, idx) => idx).sort((a, b) => i.keys[a] - i.keys[b]);
        for (const idx of order) { w.s4(i.keys[idx]); w.s4(i.labels[idx].offset - i.offset); }
        return;
      }
      default:
        w.u1(op);
    }
  }

  // Build the Code attribute body.
  finish(cf) {
    // drop handlers with empty ranges
    this.handlers = this.handlers.filter((h) => h.start.index !== h.end.index);
    this.layout();
    let fr;
    try {
      fr = computeFrames(this);
    } catch (e) {
      if (process.env.JAVAC_JS_DUMP) console.error(this.dump());
      throw e;
    }
    this.maxStack = fr.maxStack;
    // dead code: replace by nop...athrow and give it a frame
    const deadRanges = fr.deadRanges;
    const codeW = this.encode();
    const bytes = codeW.toBuffer();
    for (const r of deadRanges) {
      for (let k = r.start; k < r.end - 1; k++) bytes[k] = OP.nop;
      bytes[r.end - 1] = OP.athrow;
    }
    const w = new ByteWriter(bytes.length + 64);
    w.u2(Math.max(this.maxStack, deadRanges.length ? 1 : 0));
    w.u2(this.maxLocals);
    w.u4(bytes.length);
    w.bytes(bytes);
    // exception table (split around dead ranges)
    const entries = [];
    for (const h of this.handlers) {
      let ranges = [[h.start.offset, h.end.offset]];
      for (const d of deadRanges) {
        const next = [];
        for (const [s, e] of ranges) {
          if (d.end <= s || d.start >= e) { next.push([s, e]); continue; }
          if (s < d.start) next.push([s, d.start]);
          if (d.end < e) next.push([d.end, e]);
        }
        ranges = next;
      }
      for (const [s, e] of ranges) if (s < e) entries.push({ s, e, h: h.handler.offset, t: h.type ? this.pool.clazz(h.type) : 0 });
    }
    w.u2(entries.length);
    for (const e of entries) { w.u2(e.s); w.u2(e.e); w.u2(e.h); w.u2(e.t); }
    const attrs = [];
    if (fr.frames.length) attrs.push({ name: cf.pool.utf8('StackMapTable'), data: this.encodeFrames(fr.frames) });
    if (this.lines.length) {
      const lw = new ByteWriter();
      const lines = [];
      for (const l of this.lines) {
        const ins = this.instrs[l.index];
        const off = ins ? ins.offset : this.codeLength;
        if (off >= this.codeLength) continue;
        if (lines.length && lines[lines.length - 1].off === off) lines[lines.length - 1].line = l.line;
        else lines.push({ off, line: l.line });
      }
      lw.u2(lines.length);
      for (const l of lines) { lw.u2(l.off); lw.u2(l.line); }
      attrs.push({ name: cf.pool.utf8('LineNumberTable'), data: lw });
    }
    w.u2(attrs.length);
    for (const a of attrs) cf.writeAttr(w, a);
    return w;
  }

  dump() {
    const names = {};
    for (const [k, v] of Object.entries(OP)) names[v] = k;
    const lines = [`== ${this.owner}.${this.methodName}`];
    this.instrs.forEach((i, idx) => {
      if (i.op === -1) { lines.push(`  L${i.label.id}:`); return; }
      let s = `  ${idx}: ${names[i.op] || i.op}`;
      if (i.local !== undefined) s += ` ${i.local}`;
      if (i.value !== undefined) s += ` ${i.value}`;
      if (i.owner) s += ` ${i.owner}.${i.name}${i.desc}`;
      else if (i.name) s += ` ${i.name}${i.desc}`;
      if (i.cls) s += ` ${i.cls}`;
      if (i.ctype && !i.owner) s += ` (${i.ctype})`;
      if (i.target) s += ` L${i.target.id}`;
      lines.push(s);
    });
    return lines.join('\n');
  }

  encodeFrames(frames) {
    const w = new ByteWriter();
    w.u2(frames.length);
    let prev = -1;
    for (const f of frames) {
      const delta = prev < 0 ? f.offset : f.offset - prev - 1;
      prev = f.offset;
      w.u1(255);
      w.u2(delta);
      const locals = compressLocals(f.locals);
      w.u2(locals.length);
      for (const t of locals) this.writeVType(w, t);
      w.u2(f.stack.length);
      for (const t of f.stack) this.writeVType(w, t);
    }
    return w;
  }

  writeVType(w, t) {
    switch (t) {
      case 'T': w.u1(0); return;
      case 'I': w.u1(1); return;
      case 'F': w.u1(2); return;
      case 'D': w.u1(3); return;
      case 'J': w.u1(4); return;
      case 'N': w.u1(5); return;
      case 'UT': w.u1(6); return;
      default:
        if (t.startsWith('U#')) {
          const idx = +t.slice(2);
          w.u1(8);
          w.u2(this.instrs[idx].offset);
          return;
        }
        w.u1(7);
        w.u2(this.pool.clazz(t));
    }
  }
}

// Locals array (per slot, J/D followed by 'T' filler) to verification type list.
function compressLocals(slots) {
  const out = [];
  for (let i = 0; i < slots.length; i++) {
    const t = slots[i];
    out.push(t);
    if (t === 'J' || t === 'D') i++;
  }
  while (out.length && out[out.length - 1] === 'T') out.pop();
  return out;
}

function argSlots(desc) {
  let n = 0;
  let i = 1;
  while (desc[i] !== ')') {
    const c = desc[i];
    if (c === 'J' || c === 'D') { n += 2; i++; continue; }
    if (c === 'L') { n++; i = desc.indexOf(';', i) + 1; continue; }
    if (c === '[') {
      while (desc[i] === '[') i++;
      if (desc[i] === 'L') i = desc.indexOf(';', i) + 1; else i++;
      n++;
      continue;
    }
    n++;
    i++;
  }
  return n;
}

// field/method descriptor component to verification type
function descToVType(d) {
  switch (d[0]) {
    case 'Z': case 'B': case 'C': case 'S': case 'I': return 'I';
    case 'J': return 'J';
    case 'F': return 'F';
    case 'D': return 'D';
    case 'L': return d.slice(1, -1);
    case '[': return d;
    default: return 'T';
  }
}

module.exports = { Code, Label, OP, NEGATE, argSlots, descToVType };
