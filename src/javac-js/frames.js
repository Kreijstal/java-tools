'use strict';

// Stack map frame computation by abstract interpretation of the generated
// bytecode (in the spirit of ASM's COMPUTE_FRAMES). Verification types are
// strings: 'T' top, 'I', 'F', 'J', 'D', 'N' null, 'UT' uninitializedThis,
// 'U#<instr index>' uninitialized, otherwise an internal class name or an
// array descriptor.

const OPS = require('./code-ops');

function isCat2(t) { return t === 'J' || t === 'D'; }

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

function parseMethodDesc(desc) {
  const params = [];
  let i = 1;
  while (desc[i] !== ')') {
    const start = i;
    while (desc[i] === '[') i++;
    if (desc[i] === 'L') i = desc.indexOf(';', i) + 1;
    else i++;
    params.push(desc.slice(start, i));
  }
  const ret = desc.slice(i + 1);
  return { params, ret };
}

// element verification type of an array type
function elemOf(arr) {
  if (arr === 'N') return 'N';
  if (!arr || arr[0] !== '[') return 'java/lang/Object';
  return descToVType(arr.slice(1));
}

function isRef(t) {
  return !(t === 'T' || t === 'I' || t === 'F' || t === 'J' || t === 'D' || t === 'UT' || t.startsWith('U#'));
}

class FrameComputer {
  constructor(code) {
    this.code = code;
    this.ins = code.instrs;
    this.hier = code.hierarchy;
    this.mergeCache = new Map();
  }

  // ---- type lattice -------------------------------------------------------------
  merge(a, b) {
    if (a === b) return a;
    if (a === 'T' || b === 'T') return 'T';
    if (!isRef(a) || !isRef(b)) return 'T';
    if (a === 'N') return b;
    if (b === 'N') return a;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let r = this.mergeCache.get(key);
    if (r === undefined) {
      r = this.mergeRefs(a, b);
      this.mergeCache.set(key, r);
    }
    return r;
  }

  mergeRefs(a, b) {
    const OBJ = 'java/lang/Object';
    if (a[0] === '[' || b[0] === '[') {
      if (a[0] === '[' && b[0] === '[') {
        const ea = a.slice(1);
        const eb = b.slice(1);
        const refA = ea[0] === 'L' || ea[0] === '[';
        const refB = eb[0] === 'L' || eb[0] === '[';
        if (refA && refB) {
          const m = this.merge(descToVType(ea), descToVType(eb));
          if (m === 'T') return OBJ;
          return '[' + (m[0] === '[' ? m : `L${m};`);
        }
      }
      return OBJ;
    }
    // classes: common superclass; interfaces merge to Object
    if (this.isAssignable(b, a)) return a;
    if (this.isAssignable(a, b)) return b;
    const ia = this.hier(a);
    const ib = this.hier(b);
    if (!ia || !ib || ia.isInterface || ib.isInterface) return OBJ;
    const supersA = [];
    for (let c = a; c; c = (this.hier(c) || {}).super) supersA.push(c);
    for (let c = b; c; c = (this.hier(c) || {}).super) if (supersA.includes(c)) return c;
    return OBJ;
  }

  // is class `from` assignable to class `to` (both class names)?
  isAssignable(from, to) {
    if (from === to || to === 'java/lang/Object') return true;
    const seen = new Set();
    const go = (c) => {
      if (!c || seen.has(c)) return false;
      if (c === to) return true;
      seen.add(c);
      const h = this.hier(c);
      if (!h) return false;
      if (go(h.super)) return true;
      for (const i of h.interfaces || []) if (go(i)) return true;
      return false;
    };
    return go(from);
  }

  mergeFrame(old, nw) {
    let changed = false;
    const n = Math.max(old.locals.length, nw.locals.length);
    const locals = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = i < old.locals.length ? old.locals[i] : 'T';
      const b = i < nw.locals.length ? nw.locals[i] : 'T';
      const m = this.merge(a, b);
      locals[i] = m;
      if (m !== a) changed = true;
    }
    // a cat2 local whose second half became something else is invalid
    for (let i = 0; i < n; i++) {
      if (isCat2(locals[i]) && (i + 1 >= n || locals[i + 1] !== 'T')) { locals[i] = 'T'; changed = true; }
    }
    if (old.stack.length !== nw.stack.length) {
      throw new Error(`stack height mismatch at merge in ${this.code.owner}.${this.code.methodName}: ${old.stack.join(',')} vs ${nw.stack.join(',')}`);
    }
    const stack = old.stack.map((a, i) => {
      const m = this.merge(a, nw.stack[i]);
      if (m !== a) changed = true;
      return m;
    });
    return { changed, frame: { locals, stack } };
  }

  // ---- interpretation ---------------------------------------------------------------
  run() {
    const code = this.code;
    const ins = this.ins;
    const n = ins.length;
    // initial frame
    const locals = [];
    if (!code.isStatic) locals.push(code.isCtor ? 'UT' : code.owner);
    for (const d of code.paramDescs) {
      const t = descToVType(d);
      locals.push(t);
      if (isCat2(t)) locals.push('T');
    }
    // handler coverage: instruction index -> [handler]
    this.cover = new Array(n).fill(null);
    for (const h of code.handlers) {
      for (let i = h.start.index; i < h.end.index; i++) {
        if (!this.cover[i]) this.cover[i] = [];
        this.cover[i].push(h);
      }
    }
    this.inFrames = new Array(n).fill(null); // at merge points (labels and 0)
    this.reached = new Uint8Array(n);
    this.maxStack = 0;
    const work = [];
    const enqueue = (idx, frame) => {
      if (idx >= n) return;
      const old = this.inFrames[idx];
      if (!old) {
        this.inFrames[idx] = { locals: frame.locals.slice(), stack: frame.stack.slice() };
        work.push(idx);
        return;
      }
      const { changed, frame: m } = this.mergeFrame(old, frame);
      if (changed) {
        this.inFrames[idx] = m;
        work.push(idx);
      }
    };
    this.enqueue = enqueue;
    enqueue(0, { locals, stack: [] });
    let guard = 0;
    while (work.length) {
      if (++guard > 2000000) throw new Error('frame computation did not converge');
      const start = work.pop();
      const f = this.inFrames[start];
      this.runBlock(start, { locals: f.locals.slice(), stack: f.stack.slice() });
    }
    return this.result();
  }

  runBlock(start, f) {
    const ins = this.ins;
    let i = start;
    while (i < ins.length) {
      const x = ins[i];
      if (x.op === -1) {
        if (i !== start) {
          // flow into the next merge point
          this.enqueue(i, f);
          return;
        }
        this.reached[i] = 1;
        i++;
        continue;
      }
      this.reached[i] = 1;
      // exception edges use the locals before the instruction
      if (this.cover[i]) {
        for (const h of this.cover[i]) {
          this.enqueue(h.handler.index, { locals: f.locals.slice(), stack: [h.type || 'java/lang/Throwable'] });
        }
      }
      const next = this.exec(x, f, i);
      // exception edges also see the locals after a store
      if (this.cover[i] && isStore(x.op)) {
        for (const h of this.cover[i]) this.enqueue(h.handler.index, { locals: f.locals.slice(), stack: [h.type || 'java/lang/Throwable'] });
      }
      if (next === 'stop') return;
      i++;
    }
  }

  push(f, t) {
    f.stack.push(t);
    let d = 0;
    for (const s of f.stack) d += isCat2(s) ? 2 : 1;
    if (d > this.maxStack) this.maxStack = d;
  }

  pop(f, n) {
    let r;
    const count = n === undefined ? 1 : n;
    for (let k = 0; k < count; k++) {
      if (!f.stack.length) throw new Error(`stack underflow in ${this.code.owner}.${this.code.methodName}`);
      r = f.stack.pop();
    }
    return r;
  }

  setLocal(f, idx, t) {
    while (f.locals.length <= idx + (isCat2(t) ? 1 : 0)) f.locals.push('T');
    if (idx > 0 && isCat2(f.locals[idx - 1])) f.locals[idx - 1] = 'T';
    if (isCat2(f.locals[idx]) && idx + 1 < f.locals.length) f.locals[idx + 1] = 'T';
    f.locals[idx] = t;
    if (isCat2(t)) f.locals[idx + 1] = 'T';
  }

  exec(x, f, idx) {
    const O = OPS;
    const op = x.op;
    switch (op) {
      case O.nop: return null;
      case O.aconst_null: this.push(f, 'N'); return null;
      case O.iconst_m1: case O.iconst_0: case O.iconst_1: case O.iconst_2: case O.iconst_3: case O.iconst_4: case O.iconst_5:
      case O.bipush: case O.sipush:
        this.push(f, 'I'); return null;
      case O.lconst_0: case O.lconst_1: this.push(f, 'J'); return null;
      case O.fconst_0: case O.fconst_1: case O.fconst_2: this.push(f, 'F'); return null;
      case O.dconst_0: case O.dconst_1: this.push(f, 'D'); return null;
      case O.ldc: case O.ldc_w: case O.ldc2_w: this.push(f, x.ctype); return null;
      case O.iload: this.push(f, 'I'); return null;
      case O.lload: this.push(f, 'J'); return null;
      case O.fload: this.push(f, 'F'); return null;
      case O.dload: this.push(f, 'D'); return null;
      case O.aload: {
        const t = f.locals[x.local];
        if (t === undefined || t === 'T' || !isRef(t) && t !== 'UT' && !t.startsWith('U#')) {
          throw new Error(`aload of non-reference local ${x.local} (${t}) in ${this.code.owner}.${this.code.methodName}`);
        }
        this.push(f, t);
        return null;
      }
      case O.iaload: case O.baload: case O.caload: case O.saload: this.pop(f, 2); this.push(f, 'I'); return null;
      case O.laload: this.pop(f, 2); this.push(f, 'J'); return null;
      case O.faload: this.pop(f, 2); this.push(f, 'F'); return null;
      case O.daload: this.pop(f, 2); this.push(f, 'D'); return null;
      case O.aaload: { this.pop(f); const a = this.pop(f); this.push(f, elemOf(a)); return null; }
      case O.istore: this.pop(f); this.setLocal(f, x.local, 'I'); return null;
      case O.lstore: this.pop(f); this.setLocal(f, x.local, 'J'); return null;
      case O.fstore: this.pop(f); this.setLocal(f, x.local, 'F'); return null;
      case O.dstore: this.pop(f); this.setLocal(f, x.local, 'D'); return null;
      case O.astore: { const t = this.pop(f); this.setLocal(f, x.local, t); return null; }
      case O.iastore: case O.lastore: case O.fastore: case O.dastore: case O.aastore:
      case O.bastore: case O.castore: case O.sastore:
        this.pop(f, 3); return null;
      case O.pop: this.pop(f); return null;
      case O.pop2: { const t = this.pop(f); if (!isCat2(t)) this.pop(f); return null; }
      case O.dup: { const t = f.stack[f.stack.length - 1]; this.push(f, t); return null; }
      case O.dup_x1: { const a = this.pop(f); const b = this.pop(f); this.push(f, a); this.push(f, b); this.push(f, a); return null; }
      case O.dup_x2: {
        const a = this.pop(f); const b = this.pop(f);
        if (isCat2(b)) { this.push(f, a); this.push(f, b); this.push(f, a); return null; }
        const c = this.pop(f); this.push(f, a); this.push(f, c); this.push(f, b); this.push(f, a); return null;
      }
      case O.dup2: {
        const a = f.stack[f.stack.length - 1];
        if (isCat2(a)) { this.push(f, a); return null; }
        const b = f.stack[f.stack.length - 2];
        this.push(f, b); this.push(f, a); return null;
      }
      case O.dup2_x1: {
        const a = this.pop(f);
        if (isCat2(a)) { const b = this.pop(f); this.push(f, a); this.push(f, b); this.push(f, a); return null; }
        const b = this.pop(f); const c = this.pop(f);
        this.push(f, b); this.push(f, a); this.push(f, c); this.push(f, b); this.push(f, a); return null;
      }
      case O.dup2_x2: {
        const a = this.pop(f);
        if (isCat2(a)) {
          const b = this.pop(f);
          if (isCat2(b)) { this.push(f, a); this.push(f, b); this.push(f, a); return null; }
          const c = this.pop(f); this.push(f, a); this.push(f, c); this.push(f, b); this.push(f, a); return null;
        }
        const b = this.pop(f); const c = this.pop(f);
        if (isCat2(c)) { this.push(f, b); this.push(f, a); this.push(f, c); this.push(f, b); this.push(f, a); return null; }
        const d = this.pop(f);
        this.push(f, b); this.push(f, a); this.push(f, d); this.push(f, c); this.push(f, b); this.push(f, a); return null;
      }
      case O.swap: { const a = this.pop(f); const b = this.pop(f); this.push(f, a); this.push(f, b); return null; }
      case O.iadd: case O.isub: case O.imul: case O.idiv: case O.irem: case O.ishl: case O.ishr: case O.iushr:
      case O.iand: case O.ior: case O.ixor:
        this.pop(f, 2); this.push(f, 'I'); return null;
      case O.ladd: case O.lsub: case O.lmul: case O.ldiv: case O.lrem: case O.land: case O.lor: case O.lxor:
        this.pop(f, 2); this.push(f, 'J'); return null;
      case O.lshl: case O.lshr: case O.lushr: this.pop(f, 2); this.push(f, 'J'); return null;
      case O.fadd: case O.fsub: case O.fmul: case O.fdiv: case O.frem: this.pop(f, 2); this.push(f, 'F'); return null;
      case O.dadd: case O.dsub: case O.dmul: case O.ddiv: case O.drem: this.pop(f, 2); this.push(f, 'D'); return null;
      case O.ineg: case O.lneg: case O.fneg: case O.dneg: return null;
      case O.iinc: return null;
      case O.i2l: case O.f2l: case O.d2l: this.pop(f); this.push(f, 'J'); return null;
      case O.i2f: case O.l2f: case O.d2f: this.pop(f); this.push(f, 'F'); return null;
      case O.i2d: case O.l2d: case O.f2d: this.pop(f); this.push(f, 'D'); return null;
      case O.l2i: case O.f2i: case O.d2i: case O.i2b: case O.i2c: case O.i2s: this.pop(f); this.push(f, 'I'); return null;
      case O.lcmp: case O.fcmpl: case O.fcmpg: case O.dcmpl: case O.dcmpg: this.pop(f, 2); this.push(f, 'I'); return null;
      case O.ifeq: case O.ifne: case O.iflt: case O.ifge: case O.ifgt: case O.ifle: case O.ifnull: case O.ifnonnull:
        this.pop(f);
        this.enqueue(x.target.index, f);
        return null;
      case O.if_icmpeq: case O.if_icmpne: case O.if_icmplt: case O.if_icmpge: case O.if_icmpgt: case O.if_icmple:
      case O.if_acmpeq: case O.if_acmpne:
        this.pop(f, 2);
        this.enqueue(x.target.index, f);
        return null;
      case O.goto: case O.goto_w:
        this.enqueue(x.target.index, f);
        return 'stop';
      case O.tableswitch: case O.lookupswitch:
        this.pop(f);
        this.enqueue(x.dflt.index, f);
        for (const l of x.labels) this.enqueue(l.index, f);
        return 'stop';
      case O.ireturn: case O.lreturn: case O.freturn: case O.dreturn: case O.areturn:
        this.pop(f); return 'stop';
      case O.return: return 'stop';
      case O.getstatic: this.push(f, descToVType(x.desc)); return null;
      case O.putstatic: this.pop(f); return null;
      case O.getfield: this.pop(f); this.push(f, descToVType(x.desc)); return null;
      case O.putfield: this.pop(f, 2); return null;
      case O.invokevirtual: case O.invokespecial: case O.invokestatic: case O.invokeinterface: case O.invokedynamic: {
        const { params, ret } = parseMethodDesc(x.desc);
        this.pop(f, params.length);
        if (op !== O.invokestatic && op !== O.invokedynamic) {
          const recv = this.pop(f);
          if (op === O.invokespecial && x.name === '<init>') {
            let init;
            if (recv === 'UT') init = this.code.owner;
            else if (recv.startsWith('U#')) init = this.ins[+recv.slice(2)].cls;
            else init = null;
            if (init) {
              for (let k = 0; k < f.locals.length; k++) if (f.locals[k] === recv) f.locals[k] = init;
              for (let k = 0; k < f.stack.length; k++) if (f.stack[k] === recv) f.stack[k] = init;
            }
          }
        }
        if (ret !== 'V') this.push(f, descToVType(ret));
        return null;
      }
      case O.new: this.push(f, `U#${idx}`); return null;
      case O.newarray: {
        this.pop(f);
        const d = { 4: '[Z', 5: '[C', 6: '[F', 7: '[D', 8: '[B', 9: '[S', 10: '[I', 11: '[J' }[x.atype];
        this.push(f, d);
        return null;
      }
      case O.anewarray: this.pop(f); this.push(f, x.cls[0] === '[' ? `[${x.cls}` : `[L${x.cls};`); return null;
      case O.multianewarray: this.pop(f, x.dims); this.push(f, x.cls); return null;
      case O.arraylength: this.pop(f); this.push(f, 'I'); return null;
      case O.athrow: this.pop(f); return 'stop';
      case O.checkcast: this.pop(f); this.push(f, x.cls); return null;
      case O.instanceof: this.pop(f); this.push(f, 'I'); return null;
      case O.monitorenter: case O.monitorexit: this.pop(f); return null;
      default:
        throw new Error(`frames: unhandled opcode ${op}`);
    }
  }

  result() {
    const ins = this.ins;
    const frames = [];
    // frames at targeted labels (one per offset: the last label at that offset)
    const byOffset = new Map();
    const targeted = new Set();
    for (const x of ins) {
      if (x.target) targeted.add(x.target);
      if (x.dflt) { targeted.add(x.dflt); x.labels.forEach((l) => targeted.add(l)); }
    }
    for (const h of this.code.handlers) targeted.add(h.handler);
    const needFrameAt = new Set();
    for (const l of targeted) if (l.index >= 0) needFrameAt.add(l.offset);
    for (let i = 0; i < ins.length; i++) {
      const x = ins[i];
      if (x.op !== -1) continue;
      if (!this.inFrames[i]) continue;
      if (needFrameAt.has(x.label.offset)) byOffset.set(x.label.offset, this.inFrames[i]);
    }
    // dead code ranges (byte offsets)
    const deadRanges = [];
    let cur = null;
    for (let i = 0; i < ins.length; i++) {
      const x = ins[i];
      if (x.op === -1) continue;
      const size = this.code.sizeOf(x, x.offset);
      if (!this.reached[i]) {
        if (cur && cur.end === x.offset) cur.end = x.offset + size;
        else { cur = { start: x.offset, end: x.offset + size }; deadRanges.push(cur); }
      } else cur = null;
    }
    for (const r of deadRanges) {
      byOffset.set(r.start, { locals: [], stack: ['java/lang/Throwable'], dead: true });
    }
    const codeLength = this.code.codeLength;
    for (const [offset, fr] of [...byOffset.entries()].sort((a, b) => a[0] - b[0])) {
      if (offset >= codeLength) continue;
      frames.push({ offset, locals: fr.locals, stack: fr.stack });
    }
    return { frames, maxStack: this.maxStack, deadRanges };
  }
}

function isStore(op) {
  return (op >= OPS.istore && op <= OPS.astore);
}

function computeFrames(code) {
  return new FrameComputer(code).run();
}

module.exports = { computeFrames, descToVType, parseMethodDesc };
