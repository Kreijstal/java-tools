'use strict';

// Code generation for method bodies from attributed trees.

const { F } = require('./flags');
const T = require('./types');
const { Code, OP } = require('./code');
const { REF } = require('./classfile');
const { unparen } = require('./attr');
const CF = require('./constfold');

const PRIM = T.PRIM;

function jvmKind(t) {
  if (!t) return 'V';
  if (t.kind === 'prim') {
    switch (t.tag) {
      case 'void': return 'V';
      case 'long': return 'J';
      case 'float': return 'F';
      case 'double': return 'D';
      default: return 'I';
    }
  }
  return 'A';
}

const LOAD = { I: OP.iload, J: OP.lload, F: OP.fload, D: OP.dload, A: OP.aload };
const STORE = { I: OP.istore, J: OP.lstore, F: OP.fstore, D: OP.dstore, A: OP.astore };
const RETURN = { I: OP.ireturn, J: OP.lreturn, F: OP.freturn, D: OP.dreturn, A: OP.areturn, V: OP.return };

function arrayLoadOp(t) {
  if (t.kind !== 'prim') return OP.aaload;
  switch (t.tag) {
    case 'boolean': case 'byte': return OP.baload;
    case 'char': return OP.caload;
    case 'short': return OP.saload;
    case 'int': return OP.iaload;
    case 'long': return OP.laload;
    case 'float': return OP.faload;
    case 'double': return OP.daload;
    default: return OP.aaload;
  }
}

function arrayStoreOp(t) {
  if (t.kind !== 'prim') return OP.aastore;
  switch (t.tag) {
    case 'boolean': case 'byte': return OP.bastore;
    case 'char': return OP.castore;
    case 'short': return OP.sastore;
    case 'int': return OP.iastore;
    case 'long': return OP.lastore;
    case 'float': return OP.fastore;
    case 'double': return OP.dastore;
    default: return OP.aastore;
  }
}

const NEWARRAY_TYPE = { boolean: 4, char: 5, float: 6, double: 7, byte: 8, short: 9, int: 10, long: 11 };

const ARITH = {
  '+': { I: OP.iadd, J: OP.ladd, F: OP.fadd, D: OP.dadd },
  '-': { I: OP.isub, J: OP.lsub, F: OP.fsub, D: OP.dsub },
  '*': { I: OP.imul, J: OP.lmul, F: OP.fmul, D: OP.dmul },
  '/': { I: OP.idiv, J: OP.ldiv, F: OP.fdiv, D: OP.ddiv },
  '%': { I: OP.irem, J: OP.lrem, F: OP.frem, D: OP.drem },
  '&': { I: OP.iand, J: OP.land },
  '|': { I: OP.ior, J: OP.lor },
  '^': { I: OP.ixor, J: OP.lxor },
  '<<': { I: OP.ishl, J: OP.lshl },
  '>>': { I: OP.ishr, J: OP.lshr },
  '>>>': { I: OP.iushr, J: OP.lushr },
};

const CMP_INT = { '==': OP.if_icmpeq, '!=': OP.if_icmpne, '<': OP.if_icmplt, '>=': OP.if_icmpge, '>': OP.if_icmpgt, '<=': OP.if_icmple };
const CMP_ZERO = { '==': OP.ifeq, '!=': OP.ifne, '<': OP.iflt, '>=': OP.ifge, '>': OP.ifgt, '<=': OP.ifle };
const NEG_REL = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };

class MethodGen {
  constructor(gen, csym, msym, code) {
    this.g = gen;
    this.csym = csym;
    this.msym = msym;
    this.code = code;
    this.locals = new Map(); // VarSymbol -> {slot, type}
    this.jumps = []; // jump environments
    this.unit = csym.unit;
  }
}

class Gen {
  constructor(compiler) {
    this.c = compiler;
    this.syms = compiler.syms;
    this.types = compiler.syms.types;
    this.lower = compiler.lower;
    this.attr = compiler.attr;
  }

  // ---- naming and descriptors --------------------------------------------------
  internalName(t) {
    const e = this.types.erasure(t);
    if (e.kind === 'class') return e.sym.binaryName();
    if (e.kind === 'array') return this.types.descriptor(e);
    return 'java/lang/Object';
  }

  classInternal(csym) { return csym.binaryName(); }

  desc(t) { return this.types.descriptor(t); }

  isInterfaceType(t) {
    const e = this.types.erasure(t);
    return e.kind === 'class' && this.syms.completeHeader(e.sym).isInterface();
  }

  // ---- coercions ---------------------------------------------------------------
  // Convert the value on top of the stack from type `from` to type `to`.
  coerce(m, from, to) {
    if (!to || !from) return;
    const code = m.code;
    if (to.kind === 'prim' && to.tag === 'void') return;
    if (from.kind === 'prim' && from.tag === 'void') return;
    const types = this.types;
    if (from.kind === 'prim' && to.kind === 'prim') { this.primConvert(code, from.tag, to.tag); return; }
    if (from.kind === 'prim') {
      // boxing
      let target = types.unboxedType(to);
      let p = from.tag;
      if (target && target.tag !== p) {
        this.primConvert(code, p, target.tag);
        p = target.tag;
      }
      if (!target) target = PRIM[p];
      const box = types.boxedClass(PRIM[p]);
      code.invoke(OP.invokestatic, box.sym.binaryName(), 'valueOf', `(${T.DESC[p]})L${box.sym.binaryName()};`, false);
      return;
    }
    if (to.kind === 'prim') {
      // unboxing
      let u = types.unboxedType(from);
      if (!u) {
        u = to;
        const box = types.boxedClass(to);
        code.typeOp(OP.checkcast, box.sym.binaryName());
      } else {
        const box = types.boxedClass(u);
        const fe = types.erasure(from);
        if (!(fe.kind === 'class' && fe.sym === box.sym)) code.typeOp(OP.checkcast, box.sym.binaryName());
      }
      const box = types.boxedClass(u);
      code.invoke(OP.invokevirtual, box.sym.binaryName(), `${u.tag}Value`, `()${T.DESC[u.tag]}`, false);
      this.primConvert(code, u.tag, to.tag);
      return;
    }
    if (from.kind === 'null') return;
    this.refCast(m, from, to);
  }

  refCast(m, from, to) {
    const types = this.types;
    const te = types.erasure(to);
    if (te.kind === 'class' && te.sym === this.syms.objectSym) return;
    const fe = types.erasure(from);
    if (types.isSubtype(fe, te)) return;
    if (to.kind === 'intersection') {
      for (const b of to.bounds) {
        const be = types.erasure(b);
        if (!types.isSubtype(fe, be)) m.code.typeOp(OP.checkcast, this.internalName(be));
      }
      return;
    }
    m.code.typeOp(OP.checkcast, this.internalName(te));
  }

  primConvert(code, from, to) {
    if (from === to) return;
    if (from === 'boolean' || to === 'boolean') return;
    const k = (t) => (t === 'long' ? 'J' : t === 'float' ? 'F' : t === 'double' ? 'D' : 'I');
    const fk = k(from);
    const tk = k(to);
    if (fk !== tk) {
      const table = {
        IJ: OP.i2l, IF: OP.i2f, ID: OP.i2d, JI: OP.l2i, JF: OP.l2f, JD: OP.l2d,
        FI: OP.f2i, FJ: OP.f2l, FD: OP.f2d, DI: OP.d2i, DJ: OP.d2l, DF: OP.d2f,
      };
      code.op(table[fk + tk]);
    }
    if (tk === 'I') {
      // narrowing within int
      const rank = { byte: 1, short: 2, char: 2, int: 3, long: 4, float: 5, double: 6 };
      if (to === 'byte' && from !== 'byte') code.op(OP.i2b);
      else if (to === 'short' && from !== 'short' && from !== 'byte') code.op(OP.i2s);
      else if (to === 'char' && from !== 'char') code.op(OP.i2c);
      void rank;
    }
  }

  // ---- constants ---------------------------------------------------------------
  pushConst(m, v, type) {
    const code = m.code;
    const tag = type.kind === 'prim' ? type.tag : 'String';
    switch (tag) {
      case 'boolean': code.iconst(v ? 1 : 0); return;
      case 'byte': case 'short': case 'char': case 'int': code.iconst(v); return;
      case 'long': code.lconst(v); return;
      case 'float': code.fconst(v); return;
      case 'double': code.dconst(v); return;
      default: code.sconst(String(v)); return;
    }
  }

  // ---- locals ------------------------------------------------------------------
  defineLocal(m, sym, type) {
    const t = type || sym.type;
    const slot = m.code.newLocal(this.types.isWide(t) ? 2 : 1);
    m.locals.set(sym, { slot, type: t });
    return slot;
  }

  tempLocal(m, type) {
    return m.code.newLocal(this.types.isWide(type) ? 2 : 1);
  }

  loadLocal(m, slot, type) { m.code.local(LOAD[jvmKind(type)], slot); }
  storeLocal(m, slot, type) { m.code.local(STORE[jvmKind(type)], slot); }

  pop(m, type) {
    const k = jvmKind(type);
    if (k === 'V') return;
    m.code.op(k === 'J' || k === 'D' ? OP.pop2 : OP.pop);
  }

  dup(m, type) {
    const k = jvmKind(type);
    m.code.op(k === 'J' || k === 'D' ? OP.dup2 : OP.dup);
  }

  lineOf(m, tree) {
    if (!m.unit || !m.unit.lineCol || tree.pos === undefined) return;
    m.code.line(m.unit.lineCol(tree.pos).line);
  }

  // ---- this and outer instances -----------------------------------------------------
  // Load the instance of class `target`: the current class or a lexically
  // enclosing one. `exact` (qualified this, members found by lexical lookup)
  // requires that very class; otherwise the first enclosing class that is a
  // subclass of target is used (implicit outer instance of an inner class).
  loadThisOf(m, target, exact) {
    const code = m.code;
    let c = m.csym;
    if (m.lambdaOwnerThis === false) throw new Error(`lambda needs this but is static in ${c.fullName}`);
    code.local(OP.aload, 0);
    const found = (x) => (exact ? x === target : this.syms.isSubClass(x, target));
    while (c && !found(c)) {
      const tr = this.lower.trans(c);
      if (!tr.outerThis) throw new Error(`no outer instance of ${target.fullName} from ${m.csym.fullName}`);
      if (m.outerThisParam !== undefined && c === m.csym && m.inCtorBeforeFields) {
        code.op(OP.pop);
        code.local(OP.aload, m.outerThisParam);
      } else {
        code.field(OP.getfield, c.binaryName(), 'this$0', this.desc(tr.outerThis.type));
      }
      c = tr.outerClass;
    }
  }

  // ---- variables ---------------------------------------------------------------------
  loadVar(m, sym, tree) {
    const code = m.code;
    const loc = m.locals.get(sym);
    if (loc) { this.loadLocal(m, loc.slot, loc.type); return loc.type; }
    if (sym.isLocal) {
      // captured: from a val$ field of the current class (or an enclosing local class)
      let c = m.csym;
      code.local(OP.aload, 0);
      while (c) {
        const tr = this.lower.trans(c);
        const f = tr.capturedFields.get(sym);
        if (f) {
          code.field(OP.getfield, c.binaryName(), f.name, this.desc(f.type));
          return f.type;
        }
        if (!tr.outerThis) break;
        code.field(OP.getfield, c.binaryName(), 'this$0', this.desc(tr.outerThis.type));
        c = tr.outerClass;
      }
      throw new Error(`local variable ${sym.name} not available in ${m.csym.fullName}.${m.msym ? m.msym.name : '?'}`);
    }
    throw new Error(`not a local: ${sym.name}`);
  }

  storeVar(m, sym) {
    const loc = m.locals.get(sym);
    if (!loc) throw new Error(`store to unknown local ${sym.name}`);
    this.storeLocal(m, loc.slot, loc.type);
  }

  // field owner for a reference: the qualifying type (JLS 13.1)
  fieldOwner(sym, siteType) {
    if (siteType) {
      const e = this.types.erasure(siteType);
      if (e.kind === 'class') {
        // private fields must use the declaring class
        if (sym.flags & F.PRIVATE) return sym.owner.binaryName();
        return e.sym.binaryName();
      }
    }
    return sym.owner.binaryName();
  }

  // ---- expressions ---------------------------------------------------------------------
  // Generate the value of tree, coerced to tree.coerceTo when present.
  genExpr(m, tree, target) {
    const to = target !== undefined ? target : tree.coerceTo;
    // a reference target decides which cast a generic result needs (javac casts
    // only where the use requires it)
    const t = this.genExprRaw(m, tree, to && to.kind !== 'prim' ? { want: to } : undefined);
    if (to) this.coerce(m, t, to);
    return to || t;
  }

  // value of tree with its own type (stack holds erasure(tree.type))
  genExprRaw(m, tree, ctx) {
    if (tree.constValue !== undefined && tree.constValue !== null && tree.type && (tree.type.kind === 'prim' || this.attr.isString(tree.type))) {
      this.pushConst(m, tree.constValue, tree.type);
      return tree.type;
    }
    switch (tree.tag) {
      case 'Literal':
        if (tree.typetag === 'null') { m.code.op(OP.aconst_null); return T.NULL; }
        this.pushConst(m, tree.value, tree.type);
        return tree.type;
      case 'Parens': return this.genExprRaw(m, tree.expr, ctx);
      case 'Ident': return this.genIdent(m, tree, ctx);
      case 'Select': return this.genSelect(m, tree, ctx);
      case 'Apply': return this.genApply(m, tree, ctx);
      case 'NewClass': return this.genNewClass(m, tree);
      case 'NewArray': return this.genNewArray(m, tree);
      case 'Assign': return this.genAssign(m, tree, true);
      case 'AssignOp': return this.genAssignOp(m, tree, true);
      case 'Unary': return this.genUnary(m, tree, true);
      case 'Binary': return this.genBinary(m, tree);
      case 'Conditional': return this.genConditional(m, tree);
      case 'TypeCast': return this.genCast(m, tree);
      case 'InstanceOf': return this.genBooleanValue(m, tree);
      case 'Indexed': {
        const at = this.genExpr(m, tree.indexed, null);
        this.genExpr(m, tree.index, PRIM.int);
        const et = this.types.elemtype(at) || this.types.elemtype(tree.indexed.type);
        m.code.op(arrayLoadOp(et));
        // element of a generic array: cast to the element's static type
        if (et.kind !== 'prim') this.refCastStack(m, this.types.erasure(et), this.castWant(ctx, tree.type));
        return tree.type;
      }
      case 'Lambda': case 'Reference': return this.genLambdaIndy(m, tree);
      case 'SwitchExpression': return this.genSwitch(m, tree, true);
      default:
        throw new Error(`gen: unexpected expression ${tree.tag}`);
    }
  }

  // the type a loaded generic value has to be cast to
  castWant(ctx, type) {
    if (ctx && ctx.statement) return null;
    if (ctx && ctx.want && ctx.want.kind !== 'prim') return ctx.want;
    return type;
  }

  // after loading a value whose verifier type is erasure `stackErased`, make it erasure(type)
  refCastStack(m, stackErased, type) {
    if (!type || type.kind === 'prim' || type.kind === 'null') return;
    if (stackErased && stackErased.kind === 'prim') return; // boxing is done by coerce
    const te = this.types.erasure(type);
    if (te.kind === 'class' && te.sym === this.syms.objectSym) return;
    if (stackErased && this.types.isSubtype(stackErased, te)) return;
    m.code.typeOp(OP.checkcast, this.internalName(te));
  }

  genIdent(m, tree, ctx) {
    const sym = tree.sym;
    const code = m.code;
    if (tree.name === 'this') {
      if (m.isLambda && !m.lambdaHasThis) throw new Error('this in static lambda');
      code.local(OP.aload, 0);
      return tree.type;
    }
    if (tree.name === 'super') {
      code.local(OP.aload, 0);
      return tree.type;
    }
    if (!sym || sym.kind !== 'var') throw new Error(`gen: identifier ${tree.name} is not a variable`);
    if (sym.isLocal) {
      const t = this.loadVar(m, sym, tree);
      void t;
      return tree.type;
    }
    // field
    if (sym.flags & F.STATIC) {
      code.field(OP.getstatic, sym.owner.binaryName(), sym.name, this.desc(sym.type));
    } else {
      const envClass = tree.fieldAccess && tree.fieldAccess.envClass ? tree.fieldAccess.envClass : m.csym;
      this.loadThisOf(m, envClass, true);
      code.field(OP.getfield, this.fieldOwner(sym, this.syms.erasedType(envClass)), sym.name, this.desc(sym.type));
    }
    this.refCastStack(m, this.types.erasure(sym.type), this.castWant(ctx, tree.type));
    return tree.type;
  }

  genSelect(m, tree, ctx) {
    const code = m.code;
    if (tree.classLiteral) {
      const t = tree.classLiteral;
      if (t.kind === 'prim') {
        const box = this.types.boxedClass(t.tag === 'void' ? PRIM.void : t);
        const boxName = t.tag === 'void' ? 'java/lang/Void' : box.sym.binaryName();
        code.field(OP.getstatic, boxName, 'TYPE', 'Ljava/lang/Class;');
      } else {
        code.classConst(this.internalName(t));
      }
      return tree.type;
    }
    if (tree.outerThis) {
      this.loadThisOf(m, tree.outerThis, true);
      return tree.type;
    }
    if (tree.arrayLength) {
      this.genExpr(m, tree.selected, null);
      code.op(OP.arraylength);
      return PRIM.int;
    }
    const sym = tree.sym;
    if (!sym || sym.kind !== 'var') throw new Error(`gen: select ${tree.name} is not a field (${sym && sym.kind})`);
    const sel = tree.selected;
    if (sym.flags & F.STATIC) {
      if (!sel.isType && !sel.isPackage) {
        // evaluate and discard the qualifier
        const qt = this.genExprRaw(m, sel);
        this.pop(m, qt);
      }
      const owner = sel.isType && sel.type && sel.type.kind === 'class' && !(sym.flags & F.PRIVATE) ? sel.type.sym.binaryName() : sym.owner.binaryName();
      code.field(OP.getstatic, this.staticFieldOwner(sym, owner), sym.name, this.desc(sym.type));
    } else {
      let siteType;
      if (sel.tag === 'Ident' && sel.name === 'super') {
        code.local(OP.aload, 0);
        siteType = sel.type;
      } else if (sel.tag === 'Select' && sel.name === 'super') {
        this.loadThisOf(m, sel.qualifiedSuper || this.types.erasure(sel.selected.type).sym);
        siteType = sel.type;
      } else {
        siteType = this.genExpr(m, sel, null);
      }
      code.field(OP.getfield, this.fieldOwner(sym, siteType && siteType.kind === 'class' ? siteType : null), sym.name, this.desc(sym.type));
    }
    this.refCastStack(m, this.types.erasure(sym.type), this.castWant(ctx, tree.type));
    return tree.type;
  }

  staticFieldOwner(sym, preferred) {
    return preferred || sym.owner.binaryName();
  }

  // ---- method invocation -----------------------------------------------------------------
  isSignaturePolymorphic(sym) {
    if (!sym || sym.kind !== 'method') return false;
    const o = sym.owner.fullName;
    if (o !== 'java.lang.invoke.MethodHandle' && o !== 'java.lang.invoke.VarHandle') return false;
    if (!(sym.flags & F.NATIVE) || !(sym.flags & F.VARARGS)) return false;
    return sym.params.length === 1 && this.types.descriptor(sym.params[0].type) === '[Ljava/lang/Object;';
  }

  genApply(m, tree, ctx) {
    const code = m.code;
    const sym = tree.sym;
    if (tree.ctorCall) return this.genCtorCall(m, tree);
    const recv = tree.receiver || { kind: 'expr' };
    const isStatic = (sym.flags & F.STATIC) !== 0;
    let owner;
    let op;
    let siteType = null;
    const meth = tree.meth;
    if (isStatic) {
      if (meth.tag === 'Select' && !meth.selected.isType && !meth.selected.isPackage) {
        const qt = this.genExprRaw(m, meth.selected);
        this.pop(m, qt);
      }
      op = OP.invokestatic;
      owner = sym.owner;
      if (meth.tag === 'Select' && meth.selected.isType && meth.selected.type && meth.selected.type.kind === 'class' && !(sym.flags & F.PRIVATE)) {
        // qualifying type, unless it is an interface (static interface methods must use the declaring interface)
        const q = meth.selected.type.sym;
        if (!sym.owner.isInterface()) owner = q;
      }
    } else {
      switch (recv.kind) {
        case 'this': case 'outer':
          this.loadThisOf(m, recv.clazz, true);
          siteType = this.syms.erasedType(recv.clazz);
          break;
        case 'super':
          code.local(OP.aload, 0);
          siteType = meth.selected.type;
          break;
        case 'ifaceSuper':
          code.local(OP.aload, 0);
          siteType = this.syms.erasedType(recv.iface);
          break;
        case 'outerSuper':
          this.loadThisOf(m, recv.clazz, true);
          siteType = meth.selected.type;
          break;
        default:
          siteType = this.genExpr(m, meth.selected, null);
          break;
      }
      const se = siteType ? this.types.erasure(siteType) : null;
      if (recv.kind === 'super' || recv.kind === 'ifaceSuper' || recv.kind === 'outerSuper') {
        op = OP.invokespecial;
        owner = recv.kind === 'ifaceSuper' ? recv.iface : (se && se.kind === 'class' ? se.sym : sym.owner);
      } else if (sym.flags & F.PRIVATE) {
        owner = sym.owner;
        op = owner.isInterface() ? OP.invokeinterface : (owner === m.csym ? OP.invokespecial : OP.invokevirtual);
        if (owner.isInterface() && owner === m.csym) op = OP.invokeinterface;
      } else if (tree.arrayClone) {
        owner = null;
        op = OP.invokevirtual;
      } else {
        owner = se && se.kind === 'class' ? se.sym : sym.owner;
        if (se && se.kind === 'array') owner = this.syms.objectSym;
        // Object methods invoked through an interface type use Object as owner
        if (owner.isInterface() && sym.owner === this.syms.objectSym) owner = this.syms.objectSym;
        op = owner.isInterface() ? OP.invokeinterface : OP.invokevirtual;
      }
    }
    // arguments
    let descStr;
    if (this.isSignaturePolymorphic(sym)) {
      const argTypes = tree.args.map((a) => {
        const t = this.genExprRaw(m, a);
        if (t.kind === 'null') return this.syms.typeOf('java.lang.Void');
        return t.kind === 'prim' ? t : this.types.erasure(t);
      });
      let ret = sym.type.ret;
      if (this.types.isObject(ret)) {
        if (ctx && ctx.castTo) ret = ctx.castTo;
        else if (ctx && ctx.statement) ret = PRIM.void;
      }
      if (argTypes.some((t) => !t)) throw new Error(`polymorphic call ${sym.owner.fullName}.${sym.name} with untyped argument (${tree.args.map((a) => a.tag).join(',')})`);
      descStr = `(${argTypes.map((t) => this.desc(t)).join('')})${this.desc(ret)}`;
      code.invoke(op, owner.binaryName(), sym.name, descStr, false);
      tree.polyRet = ret;
      return ret.kind === 'prim' && ret.tag === 'void' ? PRIM.void : (ctx && ctx.castTo ? ret : tree.type);
    }
    this.genArgs(m, tree.args, sym, tree.mtype, tree.varargs);
    if (tree.arrayClone) {
      const at = this.types.erasure(siteType);
      code.invoke(OP.invokevirtual, this.desc(at), 'clone', '()Ljava/lang/Object;', false);
      code.typeOp(OP.checkcast, this.desc(at));
      return tree.type;
    }
    try { descStr = this.desc(sym.type); } catch (e) { throw new Error(`descriptor of ${sym.owner.fullName}.${sym.name} ${T.typeToString(sym.type)}: ${e.message}`); }
    code.invoke(op, owner.binaryName(), sym.name, descStr, op === OP.invokeinterface || ((op === OP.invokestatic || op === OP.invokespecial) && owner.isInterface()));
    const declRet = this.types.erasure(sym.type.ret);
    if (declRet.kind === 'prim') return sym.type.ret.kind === 'prim' && tree.type.kind === 'prim' ? tree.type : declRet;
    const want = this.castWant(ctx, tree.type);
    if (want) this.refCastStack(m, declRet, want);
    // what the stack now holds, for later coercions
    return want ? tree.type : declRet;
  }

  // Push arguments (with varargs packaging) for method sym called with instantiated mtype.
  genArgs(m, args, sym, mtype, varargs) {
    const params = mtype ? mtype.params : sym.type.params;
    const declParams = sym.type.params;
    const n = declParams.length;
    if (!varargs) {
      for (let i = 0; i < args.length; i++) {
        this.genExpr(m, args[i], this.argTarget(params[i], declParams[i]));
      }
      return;
    }
    for (let i = 0; i < n - 1; i++) this.genExpr(m, args[i], this.argTarget(params[i], declParams[i]));
    const arrType = this.types.erasure(declParams[n - 1]);
    const instElem = this.types.elemtype(params[n - 1]) || this.types.elemtype(arrType);
    const elem = this.types.elemtype(arrType);
    const rest = args.slice(n - 1);
    m.code.iconst(rest.length);
    this.newArrayOf(m, elem);
    rest.forEach((a, i) => {
      m.code.op(OP.dup);
      m.code.iconst(i);
      this.genExpr(m, a, this.argTarget(instElem, elem));
      m.code.op(arrayStoreOp(elem));
    });
  }

  // target type for an argument: the instantiated formal, but never wider than
  // what the erased declared parameter needs
  argTarget(inst, decl) {
    if (!inst) return decl;
    if (inst.kind === 'prim' || decl.kind === 'prim') return inst.kind === 'prim' && decl.kind !== 'prim' ? decl : (decl.kind === 'prim' ? decl : inst);
    const ie = this.types.erasure(inst);
    const de = this.types.erasure(decl);
    if (this.types.isSubtype(ie, de)) return inst;
    return decl;
  }

  newArrayOf(m, elem) {
    if (elem.kind === 'prim') m.code.newarray(NEWARRAY_TYPE[elem.tag]);
    else m.code.typeOp(OP.anewarray, this.internalName(elem));
  }

  // ---- constructors -----------------------------------------------------------------------
  // this(...) or super(...) inside a constructor
  genCtorCall(m, tree) {
    const code = m.code;
    const sym = tree.sym;
    const target = sym.owner;
    code.local(OP.aload, 0);
    const extra = this.ctorExtraArgs(m, target, tree.ctorCall === 'this', tree.outerInstance);
    this.genArgs(m, tree.args, sym, tree.mtype, tree.varargs);
    this.pushCapturedArgs(m, target, tree.ctorCall === 'this');
    code.invoke(OP.invokespecial, target.binaryName(), '<init>', this.ctorDescriptor(target, sym), false);
    void extra;
    if (tree.ctorCall === 'super') m.afterSuper && m.afterSuper();
    return PRIM.void;
  }

  // leading synthetic arguments of a constructor call on class target from inside a ctor of m.csym
  ctorExtraArgs(m, target, isThis, outerExpr) {
    const code = m.code;
    if (target.isEnum() && !target.enumConstantBody || (target.fullName === 'java.lang.Enum')) {
      // enum constructors take (name, ordinal)
      if (target.fullName === 'java.lang.Enum' || target.isEnum()) {
        code.local(OP.aload, 1);
        code.local(OP.iload, 2);
        return;
      }
    }
    if (target.enumConstantBody) {
      code.local(OP.aload, 1);
      code.local(OP.iload, 2);
      return;
    }
    if (target.hasOuterThis) {
      if (outerExpr) {
        this.genExpr(m, outerExpr, null);
        code.op(OP.dup);
        code.invoke(OP.invokestatic, 'java/util/Objects', 'requireNonNull', '(Ljava/lang/Object;)Ljava/lang/Object;', false);
        code.op(OP.pop);
      } else if (isThis) {
        code.local(OP.aload, m.outerThisParam);
      } else {
        // the enclosing instance of the superclass: from our outer instance chain
        const outerOfTarget = this.lower.trans(target).outerClass;
        this.loadOuterFromCtor(m, outerOfTarget);
      }
    }
  }

  // inside a constructor before this$0 is usable: load the instance of class `c`
  loadOuterFromCtor(m, c) {
    const code = m.code;
    const tr = this.lower.trans(m.csym);
    if (this.syms.isSubClass(m.csym, c) && !tr.outerThis) {
      code.local(OP.aload, 0);
      return;
    }
    if (tr.outerThis && m.outerThisParam !== undefined) {
      code.local(OP.aload, m.outerThisParam);
      let cur = tr.outerClass;
      while (cur && !this.syms.isSubClass(cur, c)) {
        const ctr = this.lower.trans(cur);
        if (!ctr.outerThis) break;
        code.field(OP.getfield, cur.binaryName(), 'this$0', this.desc(ctr.outerThis.type));
        cur = ctr.outerClass;
      }
      return;
    }
    code.local(OP.aload, 0);
  }

  // trailing captured-variable arguments for constructing local class target
  pushCapturedArgs(m, target, fromOwnCtor) {
    const tr = this.lower.trans(target);
    for (const v of tr.captured) {
      if (fromOwnCtor && m.capturedParams && m.capturedParams.has(v)) {
        m.code.local(LOAD[jvmKind(v.type)], m.capturedParams.get(v));
        continue;
      }
      if (m.capturedParams && m.capturedParams.has(v)) {
        m.code.local(LOAD[jvmKind(v.type)], m.capturedParams.get(v));
        continue;
      }
      this.loadVar(m, v);
    }
  }

  // erased descriptor of a constructor including synthetic parameters
  ctorDescriptor(csym, ctorSym) {
    const parts = [];
    if (csym.isEnum() || csym.enumConstantBody) parts.push('Ljava/lang/String;', 'I');
    else if (csym.fullName === 'java.lang.Enum') { /* declared */ }
    else if (csym.hasOuterThis) parts.push(this.desc(this.lower.trans(csym).outerThis.type));
    for (const p of ctorSym.type.params) parts.push(this.desc(p));
    for (const v of this.lower.trans(csym).captured) parts.push(this.desc(v.type));
    return `(${parts.join('')})V`;
  }

  genNewClass(m, tree) {
    const code = m.code;
    const csym = tree.anonClass || tree.sym.owner;
    const name = csym.binaryName();
    code.typeOp(OP.new, name);
    code.op(OP.dup);
    if (tree.anonClass) {
      if (csym.hasOuterThis) this.loadThisOf(m, this.lower.trans(csym).outerClass);
      if (csym.superOuterParam) {
        this.genExpr(m, tree.encl, null);
        code.op(OP.dup);
        code.invoke(OP.invokestatic, 'java/util/Objects', 'requireNonNull', '(Ljava/lang/Object;)Ljava/lang/Object;', false);
        code.op(OP.pop);
      }
    } else if (csym.hasOuterThis) {
      if (tree.encl) {
        this.genExpr(m, tree.encl, null);
        code.op(OP.dup);
        code.invoke(OP.invokestatic, 'java/util/Objects', 'requireNonNull', '(Ljava/lang/Object;)Ljava/lang/Object;', false);
        code.op(OP.pop);
      } else if (csym.isLocal) {
        // local/anonymous class: the current instance (or the outer instance in a static-like ctor prologue)
        this.loadThisOf(m, this.lower.trans(csym).outerClass);
      } else {
        this.loadThisOf(m, this.lower.trans(csym).outerClass);
      }
    }
    if (tree.anonClass) {
      const ctor = tree.sym;
      // the anonymous constructor takes the super constructor arguments (erased)
      this.genArgs(m, tree.args, tree.superCtor, tree.superMtype, tree.varargs);
      this.pushCapturedArgs(m, csym, false);
      code.invoke(OP.invokespecial, name, '<init>', this.anonCtorDescriptor(csym, tree), false);
      void ctor;
      return tree.type;
    }
    this.genArgs(m, tree.args, tree.sym, tree.mtype, tree.varargs);
    this.pushCapturedArgs(m, csym, false);
    code.invoke(OP.invokespecial, name, '<init>', this.ctorDescriptor(csym, tree.sym), false);
    return tree.type;
  }

  anonCtorDescriptor(anon, tree) {
    const parts = [];
    if (anon.hasOuterThis) parts.push(this.desc(this.lower.trans(anon).outerThis.type));
    if (anon.superOuterParam) parts.push(this.desc(this.lower.trans(this.types.erasure(anon.superclass).sym).outerThis.type));
    for (const p of tree.superCtor.type.params) parts.push(this.desc(p));
    for (const v of this.lower.trans(anon).captured) parts.push(this.desc(v.type));
    return `(${parts.join('')})V`;
  }

  genNewArray(m, tree) {
    const code = m.code;
    const type = tree.type;
    if (tree.elems) {
      const elem = this.types.elemtype(type);
      code.iconst(tree.elems.length);
      this.newArrayOf(m, this.types.erasure(elem));
      tree.elems.forEach((e, i) => {
        code.op(OP.dup);
        code.iconst(i);
        if (e.tag === 'NewArray' && !e.elemtype) {
          e.type = e.type || elem;
          this.genNewArray(m, e);
        } else this.genExpr(m, e, elem);
        code.op(arrayStoreOp(this.types.erasure(elem)));
      });
      return type;
    }
    for (const d of tree.dims) this.genExpr(m, d, PRIM.int);
    if (tree.dims.length === 1) {
      this.newArrayOf(m, this.types.erasure(this.types.elemtype(type)));
    } else {
      code.multianewarray(this.desc(type), tree.dims.length);
    }
    return type;
  }

  // ---- assignment ---------------------------------------------------------------------------
  // An lvalue: knows how to push its "prefix" (object / array+index), load and store.
  lvalue(m, tree) {
    const t = unparen(tree);
    const code = m.code;
    const g = this;
    if (t.tag === 'Ident') {
      const sym = t.sym;
      if (sym.isLocal) {
        return {
          type: sym.type,
          prefixSize: 0,
          prefix() {},
          load() { g.loadVar(m, sym); },
          store() { g.storeVar(m, sym); },
          dupPrefix() {},
          localSlot: m.locals.get(sym) ? m.locals.get(sym).slot : -1,
        };
      }
      if (sym.flags & F.STATIC) {
        const owner = sym.owner.binaryName();
        return {
          type: sym.type,
          prefixSize: 0,
          prefix() {},
          load() { code.field(OP.getstatic, owner, sym.name, g.desc(sym.type)); g.refCastStack(m, g.types.erasure(sym.type), t.type); },
          store() { code.field(OP.putstatic, owner, sym.name, g.desc(sym.type)); },
          dupPrefix() {},
        };
      }
      const envClass = t.fieldAccess && t.fieldAccess.envClass ? t.fieldAccess.envClass : m.csym;
      const owner = this.fieldOwner(sym, this.syms.erasedType(envClass));
      return {
        type: sym.type,
        prefixSize: 1,
        prefix() { g.loadThisOf(m, envClass, true); },
        load() { code.field(OP.getfield, owner, sym.name, g.desc(sym.type)); g.refCastStack(m, g.types.erasure(sym.type), t.type); },
        store() { code.field(OP.putfield, owner, sym.name, g.desc(sym.type)); },
        dupPrefix() { code.op(OP.dup); },
      };
    }
    if (t.tag === 'Select') {
      const sym = t.sym;
      if (sym.flags & F.STATIC) {
        const sel = t.selected;
        const owner = sym.owner.binaryName();
        return {
          type: sym.type,
          prefixSize: 0,
          prefix() {
            if (!sel.isType && !sel.isPackage) { const qt = g.genExprRaw(m, sel); g.pop(m, qt); }
          },
          load() { code.field(OP.getstatic, owner, sym.name, g.desc(sym.type)); g.refCastStack(m, g.types.erasure(sym.type), t.type); },
          store() { code.field(OP.putstatic, owner, sym.name, g.desc(sym.type)); },
          dupPrefix() {},
        };
      }
      let siteType = null;
      const sel = t.selected;
      return {
        type: sym.type,
        prefixSize: 1,
        prefix() {
          if (sel.tag === 'Ident' && sel.name === 'super') { code.local(OP.aload, 0); siteType = sel.type; }
          else siteType = g.genExpr(m, sel, null);
        },
        load() { code.field(OP.getfield, g.fieldOwner(sym, siteType && siteType.kind === 'class' ? siteType : null), sym.name, g.desc(sym.type)); g.refCastStack(m, g.types.erasure(sym.type), t.type); },
        store() { code.field(OP.putfield, g.fieldOwner(sym, siteType && siteType.kind === 'class' ? siteType : null), sym.name, g.desc(sym.type)); },
        dupPrefix() { code.op(OP.dup); },
      };
    }
    if (t.tag === 'Indexed') {
      let et = null;
      return {
        type: t.type,
        prefixSize: 2,
        prefix() {
          const at = g.genExpr(m, t.indexed, null);
          g.genExpr(m, t.index, PRIM.int);
          et = g.types.erasure(g.types.elemtype(at) || g.types.elemtype(t.indexed.type));
        },
        load() { code.op(arrayLoadOp(et)); if (et.kind !== 'prim') g.refCastStack(m, et, t.type); },
        store() { code.op(arrayStoreOp(et)); },
        dupPrefix() { code.op(OP.dup2); },
        get storeType() { return et; },
      };
    }
    throw new Error(`gen: not an lvalue: ${t.tag}`);
  }

  // duplicate a value of `type` placing the copy below an lvalue prefix of size n
  dupBelow(m, type, n) {
    const wide = this.types.isWide(type);
    const code = m.code;
    if (n === 0) code.op(wide ? OP.dup2 : OP.dup);
    else if (n === 1) code.op(wide ? OP.dup2_x1 : OP.dup_x1);
    else code.op(wide ? OP.dup2_x2 : OP.dup_x2);
  }

  genAssign(m, tree, valueUsed) {
    const lv = this.lvalue(m, tree.lhs);
    lv.prefix();
    const ltype = tree.lhs.type;
    const rhs = tree.rhs;
    if (rhs.tag === 'NewArray' && !rhs.elemtype) {
      rhs.type = rhs.type || ltype;
      this.genNewArray(m, rhs);
    } else this.genExpr(m, rhs, ltype);
    if (valueUsed) this.dupBelow(m, ltype, lv.prefixSize);
    lv.store();
    return valueUsed ? ltype : PRIM.void;
  }

  genAssignOp(m, tree, valueUsed) {
    const lv = this.lvalue(m, tree.lhs);
    const ltype = tree.lhs.type;
    const code = m.code;
    // int local += constant: iinc
    if (lv.localSlot >= 0 && ltype.kind === 'prim' && ltype.tag === 'int' && (tree.op === '+' || tree.op === '-') &&
        tree.rhs.constValue !== undefined && tree.rhs.type.kind === 'prim' && ['int', 'short', 'byte', 'char'].includes(tree.rhs.type.tag)) {
      const v = tree.op === '+' ? tree.rhs.constValue : -tree.rhs.constValue;
      if (v >= -32768 && v <= 32767) {
        code.iinc(lv.localSlot, v);
        if (valueUsed) lv.load();
        return valueUsed ? ltype : PRIM.void;
      }
    }
    lv.prefix();
    lv.dupPrefix();
    lv.load();
    if (tree.stringConcat) {
      this.genConcatFrom(m, ltype, [tree.rhs]);
    } else {
      const opType = tree.opType;
      this.coerce(m, ltype, opType);
      const isShift = tree.op === '<<' || tree.op === '>>' || tree.op === '>>>';
      this.genExpr(m, tree.rhs, isShift ? (this.types.unaryPromotion(tree.rhs.type).tag === 'long' ? PRIM.int : PRIM.int) : opType);
      if (isShift && this.types.unaryPromotion(tree.rhs.type).tag === 'long') { /* l2i done by coerce to int */ }
      code.op(ARITH[tree.op][jvmKind(opType)]);
      // implicit narrowing (JLS 15.26.2) and boxing back
      this.coerce(m, opType, ltype);
    }
    if (valueUsed) this.dupBelow(m, ltype, lv.prefixSize);
    lv.store();
    return valueUsed ? ltype : PRIM.void;
  }

  genUnary(m, tree, valueUsed) {
    const op = tree.op;
    const code = m.code;
    if (/^(pre|post)/.test(op)) {
      const inc = op.endsWith('inc');
      const post = op.startsWith('post');
      const lv = this.lvalue(m, tree.arg);
      const ltype = tree.arg.type;
      if (lv.localSlot >= 0 && ltype.kind === 'prim' && ltype.tag === 'int') {
        if (valueUsed && post) lv.load();
        code.iinc(lv.localSlot, inc ? 1 : -1);
        if (valueUsed && !post) lv.load();
        return valueUsed ? ltype : PRIM.void;
      }
      lv.prefix();
      lv.dupPrefix();
      lv.load();
      const pt = this.types.unaryPromotion(ltype);
      if (valueUsed && post) this.dupBelow(m, ltype, lv.prefixSize);
      this.coerce(m, ltype, pt);
      const k = jvmKind(pt);
      if (k === 'I') code.iconst(1);
      else if (k === 'J') code.lconst(1);
      else if (k === 'F') code.fconst(1);
      else code.dconst(1);
      code.op(ARITH[inc ? '+' : '-'][k]);
      this.coerce(m, pt, ltype);
      if (valueUsed && !post) this.dupBelow(m, ltype, lv.prefixSize);
      lv.store();
      return valueUsed ? ltype : PRIM.void;
    }
    if (op === 'not') return this.genBooleanValue(m, tree);
    const pt = tree.type;
    this.genExpr(m, tree.arg, pt);
    const k = jvmKind(pt);
    if (op === 'neg') code.op({ I: OP.ineg, J: OP.lneg, F: OP.fneg, D: OP.dneg }[k]);
    else if (op === 'compl') {
      if (k === 'I') { code.iconst(-1); code.op(OP.ixor); } else { code.lconst(-1); code.op(OP.lxor); }
    }
    return pt;
  }

  // ---- binary operators -----------------------------------------------------------------------
  genBinary(m, tree) {
    const op = tree.op;
    if (tree.stringConcat) return this.genConcat(m, tree);
    if (['&&', '||', '==', '!=', '<', '>', '<=', '>='].includes(op)) return this.genBooleanValue(m, tree);
    if ((op === '&' || op === '|' || op === '^') && tree.opType && tree.opType.tag === 'boolean') {
      this.genExpr(m, tree.lhs, PRIM.boolean);
      this.genExpr(m, tree.rhs, PRIM.boolean);
      m.code.op(ARITH[op].I);
      return PRIM.boolean;
    }
    const opType = tree.opType;
    const isShift = op === '<<' || op === '>>' || op === '>>>';
    this.genExpr(m, tree.lhs, opType);
    this.genExpr(m, tree.rhs, isShift ? PRIM.int : opType);
    m.code.op(ARITH[op][jvmKind(opType)]);
    return opType;
  }

  // boolean value from a condition
  genBooleanValue(m, tree) {
    const code = m.code;
    const lf = code.newLabel();
    const end = code.newLabel();
    this.genBranchFalse(m, tree, lf);
    code.iconst(1);
    code.jump(OP.goto, end);
    code.placeTarget(lf);
    code.iconst(0);
    code.placeTarget(end);
    return PRIM.boolean;
  }

  // jump to `label` if cond is false, fall through if true
  genBranchFalse(m, tree, label) { this.genCond(m, tree, label, false); }
  genBranchTrue(m, tree, label) { this.genCond(m, tree, label, true); }

  // jump to label when cond === jumpIf
  genCond(m, tree, label, jumpIf) {
    const code = m.code;
    const t = unparen(tree);
    if (t.constValue !== undefined && t.constValue !== null && typeof t.constValue === 'boolean') {
      if (t.constValue === jumpIf) code.jump(OP.goto, label);
      return;
    }
    if (t.tag === 'Unary' && t.op === 'not') { this.genCond(m, t.arg, label, !jumpIf); return; }
    if (t.tag === 'Binary') {
      const op = t.op;
      if (op === '&&' || op === '||') {
        const isAnd = op === '&&';
        if (isAnd !== jumpIf) {
          // && with jump-if-false, or || with jump-if-true: both operands jump to label
          this.genCond(m, t.lhs, label, jumpIf);
          this.genCond(m, t.rhs, label, jumpIf);
        } else {
          const skip = code.newLabel();
          this.genCond(m, t.lhs, skip, !jumpIf);
          this.genCond(m, t.rhs, label, jumpIf);
          code.placeTarget(skip);
        }
        return;
      }
      if (CMP_INT[op]) {
        const rel = jumpIf ? op : NEG_REL[op];
        const ot = t.opType;
        if (!ot) {
          // reference comparison
          const lnull = unparen(t.lhs).tag === 'Literal' && unparen(t.lhs).typetag === 'null';
          const rnull = unparen(t.rhs).tag === 'Literal' && unparen(t.rhs).typetag === 'null';
          if (rnull) { this.genExpr(m, t.lhs, null); code.jump(rel === '==' ? OP.ifnull : OP.ifnonnull, label); return; }
          if (lnull) { this.genExpr(m, t.rhs, null); code.jump(rel === '==' ? OP.ifnull : OP.ifnonnull, label); return; }
          this.genExpr(m, t.lhs, null);
          this.genExpr(m, t.rhs, null);
          code.jump(rel === '==' ? OP.if_acmpeq : OP.if_acmpne, label);
          return;
        }
        const k = jvmKind(ot);
        if (k === 'I') {
          const rc = unparen(t.rhs).constValue;
          this.genExpr(m, t.lhs, ot);
          if (rc === 0 || rc === false) { code.jump(CMP_ZERO[rel], label); return; }
          this.genExpr(m, t.rhs, ot);
          code.jump(CMP_INT[rel], label);
          return;
        }
        this.genExpr(m, t.lhs, ot);
        this.genExpr(m, t.rhs, ot);
        if (k === 'J') code.op(OP.lcmp);
        else if (k === 'F') code.op(op === '<' || op === '<=' ? OP.fcmpg : OP.fcmpl);
        else code.op(op === '<' || op === '<=' ? OP.dcmpg : OP.dcmpl);
        code.jump(CMP_ZERO[rel], label);
        return;
      }
    }
    if (t.tag === 'InstanceOf') { this.genInstanceOfCond(m, t, label, jumpIf); return; }
    if (t.tag === 'Conditional') {
      // c ? a : b as condition
      const lelse = code.newLabel();
      const end = code.newLabel();
      this.genCond(m, t.cond, lelse, false);
      this.genCond(m, t.truepart, label, jumpIf);
      code.jump(OP.goto, end);
      code.placeTarget(lelse);
      this.genCond(m, t.falsepart, label, jumpIf);
      code.placeTarget(end);
      return;
    }
    this.genExpr(m, t, PRIM.boolean);
    code.jump(jumpIf ? OP.ifne : OP.ifeq, label);
  }

  // instanceof (with optional pattern) as a condition
  genInstanceOfCond(m, t, label, jumpIf) {
    const code = m.code;
    if (!t.pattern) {
      this.genExpr(m, t.expr, null);
      code.typeOp(OP.instanceof, this.internalName(t.clazzType));
      code.jump(jumpIf ? OP.ifne : OP.ifeq, label);
      return;
    }
    // evaluate into a temp, test the pattern; bindings are assigned on success
    const et = this.genExpr(m, t.expr, null);
    const tmp = this.tempLocal(m, et);
    this.storeLocal(m, tmp, et.kind === 'null' ? this.syms.objectType : et);
    if (jumpIf) {
      const fail = code.newLabel();
      this.genPatternTest(m, t.pattern, tmp, et, fail, false);
      code.jump(OP.goto, label);
      code.placeTarget(fail);
    } else {
      this.genPatternTest(m, t.pattern, tmp, et, label, false);
    }
  }

  // Test the value in local `slot` (static type valType) against pattern p;
  // jump to `fail` on mismatch, bind variables on success.
  // `nullMatches`: an unconditional nested pattern also matches null.
  genPatternTest(m, p, slot, valType, fail, nested) {
    const code = m.code;
    switch (p.tag) {
      case 'BindingPattern': {
        const pt = p.type;
        const unconditional = nested && this.types.isSubtype(this.types.erasure(valType), this.types.erasure(pt));
        const vk = jvmKind(valType);
        if (pt.kind === 'prim' || vk !== 'A') {
          // primitive binding (record component of primitive type)
          this.loadLocal(m, slot, valType);
          this.coerce(m, valType, pt);
          const s = m.locals.has(p.var.sym) ? m.locals.get(p.var.sym).slot : this.defineLocal(m, p.var.sym, pt);
          this.storeLocal(m, s, pt);
          return;
        }
        if (!unconditional) {
          this.loadLocal(m, slot, valType);
          code.typeOp(OP.instanceof, this.internalName(pt));
          code.jump(OP.ifeq, fail);
        }
        this.loadLocal(m, slot, valType);
        this.refCast(m, valType, pt);
        const s = m.locals.has(p.var.sym) ? m.locals.get(p.var.sym).slot : this.defineLocal(m, p.var.sym, pt);
        code.local(OP.astore, s);
        return;
      }
      case 'AnyPattern':
        return;
      case 'RecordPattern': {
        const rt = p.type;
        const rname = this.internalName(rt);
        const unconditional = nested && this.types.isSubtype(this.types.erasure(valType), this.types.erasure(rt));
        this.loadLocal(m, slot, valType);
        if (!unconditional || true) {
          // record patterns never match null
          code.typeOp(OP.instanceof, rname);
          code.jump(OP.ifeq, fail);
          this.loadLocal(m, slot, valType);
        }
        code.typeOp(OP.checkcast, rname);
        const rslot = this.tempLocal(m, rt);
        code.local(OP.astore, rslot);
        p.nested.forEach((n, i) => {
          const acc = p.accessors[i];
          const ct = acc.type;
          code.local(OP.aload, rslot);
          const accSym = acc.acc;
          code.invoke(OP.invokevirtual, rname, accSym.name, this.desc(accSym.type), false);
          const declRet = this.types.erasure(accSym.type.ret);
          if (declRet.kind !== 'prim') this.refCastStack(m, declRet, ct);
          const cslot = this.tempLocal(m, ct);
          this.storeLocal(m, cslot, ct.kind === 'prim' ? ct : this.types.erasure(ct));
          this.genPatternTest(m, n, cslot, ct, fail, true);
        });
        return;
      }
      default:
        throw new Error(`gen: pattern ${p.tag}`);
    }
  }

  genConditional(m, tree) {
    const code = m.code;
    const lelse = code.newLabel();
    const end = code.newLabel();
    const type = tree.type;
    this.genBranchFalse(m, tree.cond, lelse);
    this.genExpr(m, tree.truepart, type);
    code.jump(OP.goto, end);
    code.placeTarget(lelse);
    this.genExpr(m, tree.falsepart, type);
    code.placeTarget(end);
    return type;
  }

  genCast(m, tree) {
    const ct = tree.type;
    const inner = unparen(tree.expr);
    if (inner.tag === 'Apply' && inner.sym && this.isSignaturePolymorphic(inner.sym)) {
      const r = this.genApply(m, inner, { castTo: ct.kind === 'prim' ? ct : this.types.erasure(ct) });
      return r;
    }
    const et = this.genExprRaw(m, tree.expr);
    if (ct.kind === 'prim' || et.kind === 'prim') {
      this.coerce(m, et, ct);
      return ct;
    }
    // reference cast: always check unless statically a subtype
    this.refCast(m, et, ct);
    return ct;
  }

  // ---- string concatenation ---------------------------------------------------------------------
  flattenConcat(tree, out) {
    const t = unparen(tree);
    if (t.tag === 'Binary' && t.stringConcat && t.constValue === undefined) {
      this.flattenConcat(t.lhs, out);
      this.flattenConcat(t.rhs, out);
    } else out.push(tree);
    return out;
  }

  genConcat(m, tree) {
    const parts = this.flattenConcat(tree, []);
    const code = m.code;
    code.typeOp(OP.new, 'java/lang/StringBuilder');
    code.op(OP.dup);
    code.invoke(OP.invokespecial, 'java/lang/StringBuilder', '<init>', '()V', false);
    for (const p of parts) this.genAppend(m, p);
    code.invoke(OP.invokevirtual, 'java/lang/StringBuilder', 'toString', '()Ljava/lang/String;', false);
    return this.attr.stringType;
  }

  // lhs value (of type ltype) is on the stack; append parts, leave a String
  genConcatFrom(m, ltype, parts) {
    const code = m.code;
    const tmp = this.tempLocal(m, ltype);
    this.storeLocal(m, tmp, ltype);
    code.typeOp(OP.new, 'java/lang/StringBuilder');
    code.op(OP.dup);
    code.invoke(OP.invokespecial, 'java/lang/StringBuilder', '<init>', '()V', false);
    this.loadLocal(m, tmp, ltype);
    this.appendValue(m, ltype);
    for (const p of parts) this.genAppend(m, p);
    code.invoke(OP.invokevirtual, 'java/lang/StringBuilder', 'toString', '()Ljava/lang/String;', false);
  }

  genAppend(m, p) {
    const t = this.genExprRaw(m, p);
    this.appendValue(m, t);
  }

  appendValue(m, t) {
    let d;
    if (t.kind === 'prim') {
      switch (t.tag) {
        case 'boolean': d = 'Z'; break;
        case 'char': d = 'C'; break;
        case 'long': d = 'J'; break;
        case 'float': d = 'F'; break;
        case 'double': d = 'D'; break;
        default: d = 'I';
      }
    } else if (this.attr.isString(t)) d = 'Ljava/lang/String;';
    else d = 'Ljava/lang/Object;';
    m.code.invoke(OP.invokevirtual, 'java/lang/StringBuilder', 'append', `(${d})Ljava/lang/StringBuilder;`, false);
  }

  // ---- statements ---------------------------------------------------------------------------------
  genStats(m, stats) {
    for (const s of stats) this.genStat(m, s);
  }

  genBlock(m, stats) {
    const saved = m.code.nextLocal;
    this.genStats(m, stats);
    m.code.nextLocal = saved;
  }

  genStat(m, tree) {
    const code = m.code;
    if (!code.alive && tree.tag !== 'ClassDef' && tree.tag !== 'Labelled' && tree.tag !== 'Block') {
      // unreachable statements are skipped (javac rejects them except after labels/blocks)
      return;
    }
    if (tree.tag !== 'Block' && tree.tag !== 'ClassDef') this.lineOf(m, tree);
    switch (tree.tag) {
      case 'Block': this.genBlock(m, tree.stats); return;
      case 'Skip': return;
      case 'ClassDef': return; // generated separately
      case 'VarDecl': {
        const sym = tree.sym;
        const slot = this.defineLocal(m, sym);
        if (tree.init) {
          if (tree.init.tag === 'NewArray' && !tree.init.elemtype) {
            tree.init.type = tree.init.type || sym.type;
            this.genNewArray(m, tree.init);
          } else this.genExpr(m, tree.init, sym.type);
          this.storeLocal(m, slot, sym.type);
        }
        return;
      }
      case 'Exec': this.genExecExpr(m, tree.expr); return;
      case 'If': {
        const c = unparen(tree.cond).constValue;
        if (c === true) { this.genScoped(m, tree.thenp); return; }
        if (c === false) { if (tree.elsep) this.genScoped(m, tree.elsep); return; }
        const lelse = code.newLabel();
        this.genBranchFalse(m, tree.cond, lelse);
        this.genScoped(m, tree.thenp);
        if (tree.elsep) {
          const end = code.newLabel();
          const thenAlive = code.alive;
          if (thenAlive) code.jump(OP.goto, end);
          code.placeTarget(lelse);
          this.genScoped(m, tree.elsep);
          if (thenAlive) code.placeTarget(end);
        } else {
          code.placeTarget(lelse);
        }
        return;
      }
      case 'WhileLoop': return this.genLoop(m, tree, null, tree.cond, [], tree.body, true);
      case 'DoLoop': return this.genLoop(m, tree, null, tree.cond, [], tree.body, false);
      case 'ForLoop': {
        const saved = code.nextLocal;
        for (const s of tree.init) this.genStat(m, s);
        this.genLoop(m, tree, null, tree.cond, tree.step, tree.body, true);
        code.nextLocal = saved;
        return;
      }
      case 'ForeachLoop': return this.genForeach(m, tree);
      case 'Labelled': {
        const body = tree.body;
        if (['WhileLoop', 'DoLoop', 'ForLoop', 'ForeachLoop'].includes(body.tag)) {
          body.label = tree.label;
          this.genStat(m, body);
          return;
        }
        const brk = code.newLabel();
        m.jumps.push({ kind: 'label', label: tree.label, breakLabel: brk });
        this.genStat(m, body);
        m.jumps.pop();
        if (brk.targeted) code.placeTarget(brk);
        return;
      }
      case 'Switch': this.genSwitch(m, tree, false); return;
      case 'Return': return this.genReturn(m, tree);
      case 'Throw':
        this.genExpr(m, tree.expr, null);
        code.op(OP.athrow);
        return;
      case 'Break': return this.genJump(m, tree, 'break');
      case 'Continue': return this.genJump(m, tree, 'continue');
      case 'Yield': return this.genYield(m, tree);
      case 'Try': return this.genTry(m, tree);
      case 'Synchronized': return this.genSynchronized(m, tree);
      case 'Assert': return this.genAssert(m, tree);
      default:
        throw new Error(`gen: unexpected statement ${tree.tag}`);
    }
  }

  genScoped(m, s) {
    const saved = m.code.nextLocal;
    this.genStat(m, s);
    m.code.nextLocal = saved;
  }

  // expression statement: no value left on the stack
  genExecExpr(m, e) {
    const t = unparen(e);
    switch (t.tag) {
      case 'Assign': this.genAssign(m, t, false); return;
      case 'AssignOp': this.genAssignOp(m, t, false); return;
      case 'Unary':
        if (/^(pre|post)/.test(t.op)) { this.genUnary(m, t, false); return; }
        break;
      case 'Apply': {
        const rt = this.genApply(m, t, { statement: true });
        if (t.sym && this.isSignaturePolymorphic(t.sym)) {
          if (t.polyRet && !(t.polyRet.kind === 'prim' && t.polyRet.tag === 'void')) this.pop(m, t.polyRet);
          return;
        }
        this.pop(m, rt.kind === 'prim' && rt.tag === 'void' ? rt : (t.sym.type.ret.kind === 'prim' ? t.sym.type.ret : rt));
        return;
      }
      default: break;
    }
    const rt = this.genExprRaw(m, t);
    this.pop(m, rt);
  }

  // Allocate slots for pattern bindings of a condition, so that code laid out
  // before the condition (a loop body) can use them.
  predefineBindings(m, tree) {
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.tag === 'Lambda' || n.tag === 'ClassDecl' || n.tag === 'SwitchExpression') return;
      if (n.tag === 'BindingPattern' && n.var.sym && !m.locals.has(n.var.sym)) this.defineLocal(m, n.var.sym, n.type || n.var.sym.type);
      for (const k of ['lhs', 'rhs', 'arg', 'expr', 'pattern', 'nested', 'cond', 'truepart', 'falsepart']) {
        const v = n[k];
        if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === 'object') visit(v);
      }
    };
    visit(tree);
  }

  genLoop(m, tree, init, cond, step, body, testFirst) {
    const code = m.code;
    if (cond) this.predefineBindings(m, cond);
    const top = code.newLabel();
    const cont = code.newLabel();
    const brk = code.newLabel();
    const condLabel = code.newLabel();
    const cv = cond ? unparen(cond).constValue : true;
    m.jumps.push({ kind: 'loop', label: tree.label || null, breakLabel: brk, continueLabel: cont });
    if (testFirst) {
      if (cv !== true) code.jump(OP.goto, condLabel);
      code.placeTarget(top);
      this.genScoped(m, body);
      code.placeTarget(cont);
      for (const s of step) this.genStat(m, s);
      if (cv !== true) {
        code.placeTarget(condLabel);
        if (cv !== false) this.genBranchTrue(m, cond, top);
      } else {
        code.jump(OP.goto, top);
      }
    } else {
      code.placeTarget(top);
      this.genScoped(m, body);
      code.placeTarget(cont);
      if (cv === true) code.jump(OP.goto, top);
      else if (cv !== false) this.genBranchTrue(m, cond, top);
    }
    m.jumps.pop();
    if (brk.targeted) code.placeTarget(brk);
    else if (cv === true && !code.alive) { /* infinite loop: stays dead */ }
  }

  genForeach(m, tree) {
    const code = m.code;
    const saved = code.nextLocal;
    const et = this.types.erasure(tree.expr.type);
    const varSym = tree.var.sym;
    if (et.kind === 'array') {
      const elem = this.types.elemtype(tree.expr.type);
      const arr = this.tempLocal(m, et);
      const len = this.tempLocal(m, PRIM.int);
      const idx = this.tempLocal(m, PRIM.int);
      this.genExpr(m, tree.expr, null);
      code.local(OP.astore, arr);
      code.local(OP.aload, arr);
      code.op(OP.arraylength);
      code.local(OP.istore, len);
      code.iconst(0);
      code.local(OP.istore, idx);
      const top = code.newLabel();
      const cont = code.newLabel();
      const brk = code.newLabel();
      const test = code.newLabel();
      code.jump(OP.goto, test);
      code.placeTarget(top);
      const bodySaved = code.nextLocal;
      code.local(OP.aload, arr);
      code.local(OP.iload, idx);
      code.op(arrayLoadOp(this.types.erasure(elem)));
      if (elem.kind !== 'prim') this.refCastStack(m, this.types.erasure(this.types.elemtype(et)), elem);
      this.coerce(m, elem, varSym.type);
      const vslot = this.defineLocal(m, varSym);
      this.storeLocal(m, vslot, varSym.type);
      m.jumps.push({ kind: 'loop', label: tree.label || null, breakLabel: brk, continueLabel: cont });
      this.genScoped(m, tree.body);
      m.jumps.pop();
      code.nextLocal = bodySaved;
      code.placeTarget(cont);
      code.iinc(idx, 1);
      code.placeTarget(test);
      code.local(OP.iload, idx);
      code.local(OP.iload, len);
      code.jump(OP.if_icmplt, top);
      if (brk.targeted) code.placeTarget(brk);
    } else {
      const it = this.tempLocal(m, this.syms.objectType);
      this.genExpr(m, tree.expr, null);
      const iterOwner = this.isInterfaceType(et) ? et.sym.binaryName() : (et.kind === 'class' ? et.sym.binaryName() : 'java/lang/Iterable');
      if (this.isInterfaceType(et)) code.invoke(OP.invokeinterface, iterOwner, 'iterator', '()Ljava/util/Iterator;', true);
      else code.invoke(OP.invokevirtual, iterOwner, 'iterator', '()Ljava/util/Iterator;', false);
      code.local(OP.astore, it);
      const top = code.newLabel();
      const brk = code.newLabel();
      const cont = code.newLabel();
      code.placeTarget(cont);
      code.local(OP.aload, it);
      code.invoke(OP.invokeinterface, 'java/util/Iterator', 'hasNext', '()Z', true);
      code.jump(OP.ifeq, brk);
      code.placeTarget(top);
      const bodySaved = code.nextLocal;
      code.local(OP.aload, it);
      code.invoke(OP.invokeinterface, 'java/util/Iterator', 'next', '()Ljava/lang/Object;', true);
      const elemType = tree.elemType || this.syms.objectType;
      this.refCastStack(m, this.syms.objectType, elemType);
      this.coerce(m, elemType, varSym.type);
      const vslot = this.defineLocal(m, varSym);
      this.storeLocal(m, vslot, varSym.type);
      m.jumps.push({ kind: 'loop', label: tree.label || null, breakLabel: brk, continueLabel: cont });
      this.genScoped(m, tree.body);
      m.jumps.pop();
      code.nextLocal = bodySaved;
      if (code.alive) code.jump(OP.goto, cont);
      code.placeTarget(brk);
    }
    code.nextLocal = saved;
  }

  // ---- jumps and finalizers ------------------------------------------------------------------------
  // Run the finalizers between the top of the jump stack and index `limit` (exclusive).
  runFinalizers(m, limit) {
    for (let i = m.jumps.length - 1; i >= limit; i--) {
      const j = m.jumps[i];
      if (j.kind === 'finalizer' && m.code.alive) {
        // the finalizer runs outside the protected region of its own try
        const saved = m.jumps;
        m.jumps = saved.slice(0, i);
        j.gapStart();
        j.emit();
        j.gapEnd();
        m.jumps = saved;
      }
    }
  }

  genJump(m, tree, kind) {
    const code = m.code;
    for (let i = m.jumps.length - 1; i >= 0; i--) {
      const j = m.jumps[i];
      if (j.kind === 'lambda') break;
      let match = false;
      if (kind === 'break') {
        if (tree.label) match = (j.kind === 'loop' || j.kind === 'label' || j.kind === 'switch') && j.label === tree.label;
        else match = j.kind === 'loop' || j.kind === 'switch';
      } else {
        if (tree.label) match = j.kind === 'loop' && j.label === tree.label;
        else match = j.kind === 'loop';
      }
      if (match) {
        this.runFinalizers(m, i + 1);
        if (code.alive) code.jump(OP.goto, kind === 'break' ? j.breakLabel : j.continueLabel);
        return;
      }
    }
    throw new Error(`gen: ${kind} target not found`);
  }

  genReturn(m, tree) {
    const code = m.code;
    const hasFinalizers = m.jumps.some((j) => j.kind === 'finalizer');
    const rt = m.returnType;
    if (tree.expr) {
      this.genExpr(m, tree.expr, rt);
      if (hasFinalizers) {
        const tmp = this.tempLocal(m, rt);
        this.storeLocal(m, tmp, rt);
        this.runFinalizers(m, 0);
        if (!code.alive) return;
        this.loadLocal(m, tmp, rt);
      }
      code.op(RETURN[jvmKind(rt)]);
      return;
    }
    this.runFinalizers(m, 0);
    if (code.alive) code.op(OP.return);
  }

  genYield(m, tree) {
    const code = m.code;
    for (let i = m.jumps.length - 1; i >= 0; i--) {
      const j = m.jumps[i];
      if (j.kind === 'switchExpr') {
        this.genExpr(m, tree.value, j.type);
        if (m.jumps.slice(i + 1).some((x) => x.kind === 'finalizer')) {
          const tmp = this.tempLocal(m, j.type);
          this.storeLocal(m, tmp, j.type);
          this.runFinalizers(m, i + 1);
          if (!code.alive) return;
          this.loadLocal(m, tmp, j.type);
        }
        code.jump(OP.goto, j.breakLabel);
        return;
      }
    }
    throw new Error('gen: yield outside switch expression');
  }

  // try/catch/finally
  genTry(m, tree) {
    if (tree.resources.length) return this.genTryWithResources(m, tree, 0);
    const code = m.code;
    const start = code.newLabel();
    const end = code.newLabel();
    const exit = code.newLabel();
    const gaps = []; // [startLabel, endLabel] excluded from the protected ranges
    const fin = tree.finalizer;
    let finEntry = null;
    if (fin) {
      finEntry = {
        kind: 'finalizer',
        emit: () => this.genScoped(m, fin),
        gapStart: () => { const l = code.newLabel(); code.place(l); gaps.push([l, null]); },
        gapEnd: () => { const l = code.newLabel(); code.place(l); gaps[gaps.length - 1][1] = l; },
      };
      m.jumps.push(finEntry);
    }
    code.place(start);
    this.genScoped(m, tree.body);
    code.place(end);
    const bodyGaps = gaps.slice();
    if (code.alive) {
      if (fin) {
        m.jumps.pop();
        this.genScoped(m, fin);
        m.jumps.push(finEntry);
      }
      if (code.alive) code.jump(OP.goto, exit);
    }
    const catchRanges = [];
    for (const c of tree.catchers) {
      const handler = code.newLabel();
      const types = c.param.vartype.tag === 'TypeUnion'
        ? c.param.sym.type.alternatives.map((a) => this.internalName(a))
        : [this.internalName(c.param.sym.type)];
      for (const ty of types) this.addRanges(code, start, end, bodyGaps, handler, ty);
      code.placeTarget(handler);
      const hstart = code.newLabel();
      code.place(hstart);
      const saved = code.nextLocal;
      const slot = this.defineLocal(m, c.param.sym, c.param.sym.type.kind === 'union' ? c.param.sym.type.lub : c.param.sym.type);
      code.local(OP.astore, slot);
      this.lineOf(m, c);
      this.genStats(m, c.body.stats);
      code.nextLocal = saved;
      const hend = code.newLabel();
      code.place(hend);
      catchRanges.push([hstart, hend, gaps.length]);
      if (code.alive) {
        if (fin) {
          m.jumps.pop();
          this.genScoped(m, fin);
          m.jumps.push(finEntry);
        }
        if (code.alive) code.jump(OP.goto, exit);
      }
    }
    if (fin) {
      m.jumps.pop();
      const catchAll = code.newLabel();
      this.addRanges(code, start, end, bodyGaps, catchAll, null);
      for (const [hs, he] of catchRanges) this.addRanges(code, hs, he, gaps, catchAll, null);
      code.placeTarget(catchAll);
      const saved = code.nextLocal;
      const t = this.tempLocal(m, this.syms.objectType);
      code.local(OP.astore, t);
      this.genScoped(m, fin);
      if (code.alive) {
        code.local(OP.aload, t);
        code.op(OP.athrow);
      }
      code.nextLocal = saved;
    }
    if (exit.targeted) code.placeTarget(exit);
  }

  // protected range [start, end) minus gaps
  addRanges(code, start, end, gaps, handler, type) {
    let cur = start;
    for (const [gs, ge] of gaps) {
      if (!ge) continue;
      if (gs.index < start.index || gs.index >= end.index) continue;
      if (gs.index > cur.index) code.handler(cur, gs, handler, type);
      cur = ge;
    }
    if (end.index > cur.index) code.handler(cur, end, handler, type);
  }

  // try (R r = init; ...) body catch ... finally ...
  genTryWithResources(m, tree, k) {
    const code = m.code;
    if (k === 0 && (tree.catchers.length || tree.finalizer)) {
      // try-with-resources with catch/finally: the resource part becomes the try body
      const inner = { tag: 'Try', pos: tree.pos, resources: tree.resources, body: tree.body, catchers: [], finalizer: null, synthetic: true };
      const outer = { tag: 'Try', pos: tree.pos, resources: [], body: { tag: 'Block', pos: tree.pos, stats: [inner] }, catchers: tree.catchers, finalizer: tree.finalizer };
      this.genTry(m, outer);
      return;
    }
    if (k >= tree.resources.length) { this.genScoped(m, tree.body); return; }
    const saved = code.nextLocal;
    const r = tree.resources[k];
    let rslot;
    let rtype;
    if (r.tag === 'VarDecl') {
      rtype = r.sym.type;
      rslot = this.defineLocal(m, r.sym);
      this.genExpr(m, r.init, rtype);
      code.local(OP.astore, rslot);
    } else {
      rtype = r.type;
      rslot = this.tempLocal(m, rtype);
      this.genExpr(m, r, null);
      code.local(OP.astore, rslot);
    }
    const closeOwner = this.isInterfaceType(rtype) ? this.types.erasure(rtype).sym.binaryName() : (this.types.erasure(rtype).kind === 'class' ? this.types.erasure(rtype).sym.binaryName() : 'java/lang/AutoCloseable');
    const isIface = this.isInterfaceType(rtype);
    const nonNull = r.tag === 'VarDecl' && unparen(r.init).tag === 'NewClass';
    const emitClose = () => {
      const skip = code.newLabel();
      if (!nonNull) {
        code.local(OP.aload, rslot);
        code.jump(OP.ifnull, skip);
      }
      code.local(OP.aload, rslot);
      code.invoke(isIface ? OP.invokeinterface : OP.invokevirtual, closeOwner, 'close', '()V', isIface);
      if (skip.targeted) code.placeTarget(skip);
    };
    const start = code.newLabel();
    const end = code.newLabel();
    const gaps = [];
    const finEntry = {
      kind: 'finalizer',
      emit: emitClose,
      gapStart: () => { const l = code.newLabel(); code.place(l); gaps.push([l, null]); },
      gapEnd: () => { const l = code.newLabel(); code.place(l); gaps[gaps.length - 1][1] = l; },
    };
    m.jumps.push(finEntry);
    code.place(start);
    this.genTryWithResources(m, tree, k + 1);
    code.place(end);
    m.jumps.pop();
    const exit = code.newLabel();
    if (code.alive) {
      emitClose();
      code.jump(OP.goto, exit);
    }
    // catch (Throwable t) { if (r != null) try { r.close(); } catch (Throwable x) { t.addSuppressed(x); } throw t; }
    const handler = code.newLabel();
    this.addRanges(code, start, end, gaps, handler, 'java/lang/Throwable');
    code.placeTarget(handler);
    const t = this.tempLocal(m, this.syms.objectType);
    code.local(OP.astore, t);
    const rethrow = code.newLabel();
    if (!nonNull) {
      code.local(OP.aload, rslot);
      code.jump(OP.ifnull, rethrow);
    }
    const cs = code.newLabel();
    const ce = code.newLabel();
    const ch = code.newLabel();
    code.place(cs);
    code.local(OP.aload, rslot);
    code.invoke(isIface ? OP.invokeinterface : OP.invokevirtual, closeOwner, 'close', '()V', isIface);
    code.place(ce);
    code.jump(OP.goto, rethrow);
    code.handler(cs, ce, ch, 'java/lang/Throwable');
    code.placeTarget(ch);
    const x = this.tempLocal(m, this.syms.objectType);
    code.local(OP.astore, x);
    code.local(OP.aload, t);
    code.local(OP.aload, x);
    code.invoke(OP.invokevirtual, 'java/lang/Throwable', 'addSuppressed', '(Ljava/lang/Throwable;)V', false);
    code.placeTarget(rethrow);
    code.local(OP.aload, t);
    code.op(OP.athrow);
    if (exit.targeted) code.placeTarget(exit);
    code.nextLocal = saved;
  }

  genSynchronized(m, tree) {
    const code = m.code;
    const saved = code.nextLocal;
    const lock = this.tempLocal(m, this.syms.objectType);
    this.genExpr(m, tree.lock, null);
    code.op(OP.dup);
    code.local(OP.astore, lock);
    code.op(OP.monitorenter);
    const start = code.newLabel();
    const end = code.newLabel();
    const gaps = [];
    const emitExit = () => { code.local(OP.aload, lock); code.op(OP.monitorexit); };
    m.jumps.push({
      kind: 'finalizer',
      emit: emitExit,
      gapStart: () => { const l = code.newLabel(); code.place(l); gaps.push([l, null]); },
      gapEnd: () => { const l = code.newLabel(); code.place(l); gaps[gaps.length - 1][1] = l; },
    });
    code.place(start);
    this.genScoped(m, tree.body);
    m.jumps.pop();
    const exit = code.newLabel();
    if (code.alive) {
      emitExit();
      code.place(end);
      code.jump(OP.goto, exit);
    } else code.place(end);
    const handler = code.newLabel();
    this.addRanges(code, start, end, gaps, handler, null);
    code.placeTarget(handler);
    const t = this.tempLocal(m, this.syms.objectType);
    code.local(OP.astore, t);
    const hs = code.newLabel();
    code.place(hs);
    emitExit();
    const he = code.newLabel();
    code.place(he);
    code.handler(handler, he, handler, null);
    code.local(OP.aload, t);
    code.op(OP.athrow);
    if (exit.targeted) code.placeTarget(exit);
    code.nextLocal = saved;
  }

  genAssert(m, tree) {
    const code = m.code;
    const skip = code.newLabel();
    code.field(OP.getstatic, m.csym.binaryName(), '$assertionsDisabled', 'Z');
    code.jump(OP.ifne, skip);
    this.genBranchTrue(m, tree.cond, skip);
    code.typeOp(OP.new, 'java/lang/AssertionError');
    code.op(OP.dup);
    if (tree.detail) {
      const dt = this.genExprRaw(m, tree.detail);
      let d;
      if (dt.kind === 'prim') {
        const tag = dt.tag;
        d = tag === 'byte' || tag === 'short' ? 'I' : T.DESC[tag];
        if (tag === 'byte' || tag === 'short') { /* int already */ }
      } else d = 'Ljava/lang/Object;';
      code.invoke(OP.invokespecial, 'java/lang/AssertionError', '<init>', `(${d})V`, false);
    } else {
      code.invoke(OP.invokespecial, 'java/lang/AssertionError', '<init>', '()V', false);
    }
    code.op(OP.athrow);
    code.placeTarget(skip);
  }

  // ---- switch ------------------------------------------------------------------------------------
  genSwitch(m, tree, isExpr) {
    const code = m.code;
    const saved = code.nextLocal;
    const brk = code.newLabel();
    const resultType = isExpr ? tree.resultType : null;
    const jumpEntry = isExpr
      ? { kind: 'switchExpr', breakLabel: brk, type: resultType }
      : { kind: 'switch', breakLabel: brk, label: tree.label || null };
    const kind = tree.switchKind;
    // case labels -> body labels
    const bodyLabels = tree.cases.map(() => code.newLabel());
    let defaultIndex = tree.cases.findIndex((c) => c.labels.some((l) => l.tag === 'DefaultCaseLabel' || l.tag === 'NullDefaultCaseLabel'));
    const dispatchDefault = code.newLabel();
    if (kind === 'int' || kind === 'enum' || kind === 'string') {
      const keys = [];
      const targets = [];
      if (kind === 'string') {
        this.genStringSwitchDispatch(m, tree, bodyLabels, defaultIndex >= 0 ? bodyLabels[defaultIndex] : dispatchDefault);
      } else {
        if (kind === 'enum') {
          this.genExpr(m, tree.selector, null);
          code.invoke(OP.invokevirtual, tree.enumSym.binaryName(), 'ordinal', '()I', false);
        } else {
          this.genExpr(m, tree.selector, PRIM.int);
        }
        tree.cases.forEach((c, i) => {
          for (const l of c.labels) {
            if (l.tag !== 'ConstantCaseLabel') continue;
            let v;
            if (kind === 'enum') v = this.enumOrdinal(tree.enumSym, l.enumConst);
            else v = l.value;
            if (typeof v === 'boolean') v = v ? 1 : 0;
            keys.push(v | 0);
            targets.push(bodyLabels[i]);
          }
        });
        this.emitSwitchInstr(code, keys, targets, defaultIndex >= 0 ? bodyLabels[defaultIndex] : dispatchDefault);
      }
    } else {
      this.genPatternSwitchDispatch(m, tree, bodyLabels, defaultIndex, dispatchDefault, isExpr);
    }
    // bodies
    m.jumps.push(jumpEntry);
    tree.cases.forEach((c, i) => {
      code.placeTarget(bodyLabels[i]);
      if (c.arrow) {
        const s = c.body;
        const bsaved = code.nextLocal;
        if (isExpr && s.tag === 'Exec' && s.isYieldValue) {
          this.genExpr(m, s.expr, resultType);
          code.jump(OP.goto, brk);
        } else if (s.tag === 'Exec') {
          this.genExecExpr(m, s.expr);
          if (code.alive) code.jump(OP.goto, brk);
        } else {
          this.genStat(m, s);
          if (code.alive) code.jump(OP.goto, brk);
        }
        code.nextLocal = bsaved;
      } else {
        this.genStats(m, c.stats);
      }
    });
    m.jumps.pop();
    // no matching case
    if (dispatchDefault.targeted) {
      code.placeTarget(dispatchDefault);
      if (isExpr || (kind === 'pattern' && !tree.hasDefault) || (kind === 'enum' && tree.cases.some((c) => c.arrow) && false)) {
        // exhaustive switch without default: MatchException
        code.typeOp(OP.new, 'java/lang/MatchException');
        code.op(OP.dup);
        code.op(OP.aconst_null);
        code.op(OP.aconst_null);
        code.invoke(OP.invokespecial, 'java/lang/MatchException', '<init>', '(Ljava/lang/String;Ljava/lang/Throwable;)V', false);
        code.op(OP.athrow);
      } else {
        code.jump(OP.goto, brk);
      }
    }
    if (code.alive && isExpr) code.jump(OP.goto, brk);
    if (brk.targeted) code.placeTarget(brk);
    code.nextLocal = saved;
    return resultType;
  }

  enumOrdinal(enumSym, constSym) {
    let i = 0;
    for (const d of enumSym.tree.defs) {
      if (d.tag === 'VarDecl' && d.enumConstant) {
        if (d.sym === constSym || d.name === constSym.name) return i;
        i++;
      }
    }
    throw new Error(`enum constant ${constSym.name} not found in ${enumSym.fullName}`);
  }

  emitSwitchInstr(code, keys, targets, dflt) {
    if (keys.length === 0) {
      code.op(OP.pop);
      code.jump(OP.goto, dflt);
      return;
    }
    let lo = Math.min(...keys);
    let hi = Math.max(...keys);
    const range = hi - lo + 1;
    const tableCost = 4 + range;
    const lookupCost = 3 + 2 * keys.length;
    if (range > 0 && range < 0x7fffffff && tableCost + 3 <= lookupCost + 3 * 1) {
      const labels = [];
      for (let v = lo; v <= hi; v++) {
        const k = keys.indexOf(v);
        labels.push(k >= 0 ? targets[k] : dflt);
      }
      code.tableswitch(lo, hi, dflt, labels);
    } else {
      code.lookupswitch(dflt, keys, targets);
    }
  }

  // switch on strings: hashCode dispatch to an index, then index switch
  genStringSwitchDispatch(m, tree, bodyLabels, dflt) {
    const code = m.code;
    const sel = this.tempLocal(m, this.attr.stringType);
    const idx = this.tempLocal(m, PRIM.int);
    this.genExpr(m, tree.selector, null);
    code.local(OP.astore, sel);
    code.iconst(-1);
    code.local(OP.istore, idx);
    const entries = []; // {str, caseIndex, n}
    tree.cases.forEach((c, i) => {
      for (const l of c.labels) if (l.tag === 'ConstantCaseLabel') entries.push({ str: l.value, caseIndex: i, n: entries.length });
    });
    const hash = (s) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
      return h;
    };
    const byHash = new Map();
    for (const e of entries) {
      const h = hash(e.str);
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(e);
    }
    const after = code.newLabel();
    code.local(OP.aload, sel);
    code.invoke(OP.invokevirtual, 'java/lang/String', 'hashCode', '()I', false);
    const keys = [];
    const labels = [];
    const hashLabels = [];
    for (const [h, list] of byHash) {
      const l = code.newLabel();
      keys.push(h);
      labels.push(l);
      hashLabels.push([l, list]);
    }
    this.emitSwitchInstr(code, keys, labels, after);
    for (const [l, list] of hashLabels) {
      code.placeTarget(l);
      for (const e of list) {
        const next = code.newLabel();
        code.local(OP.aload, sel);
        code.sconst(e.str);
        code.invoke(OP.invokevirtual, 'java/lang/String', 'equals', '(Ljava/lang/Object;)Z', false);
        code.jump(OP.ifeq, next);
        code.iconst(e.n);
        code.local(OP.istore, idx);
        code.jump(OP.goto, after);
        code.placeTarget(next);
      }
      code.jump(OP.goto, after);
    }
    code.placeTarget(after);
    code.local(OP.iload, idx);
    this.emitSwitchInstr(code, entries.map((e) => e.n), entries.map((e) => bodyLabels[e.caseIndex]), dflt);
  }

  // switch with patterns / null: sequential tests
  genPatternSwitchDispatch(m, tree, bodyLabels, defaultIndex, dispatchDefault, isExpr) {
    const code = m.code;
    const st = tree.selector.type;
    const selType = st.kind === 'prim' ? st : this.types.erasure(st);
    const sel = this.tempLocal(m, selType);
    this.genExpr(m, tree.selector, null);
    this.storeLocal(m, sel, selType);
    const nullCase = tree.cases.findIndex((c) => c.labels.some((l) => l.isNull || l.tag === 'NullDefaultCaseLabel'));
    if (selType.kind !== 'prim') {
      const notNull = code.newLabel();
      code.local(OP.aload, sel);
      code.jump(OP.ifnonnull, notNull);
      if (nullCase >= 0) code.jump(OP.goto, bodyLabels[nullCase]);
      else {
        code.typeOp(OP.new, 'java/lang/NullPointerException');
        code.op(OP.dup);
        code.invoke(OP.invokespecial, 'java/lang/NullPointerException', '<init>', '()V', false);
        code.op(OP.athrow);
      }
      code.placeTarget(notNull);
    }
    tree.cases.forEach((c, i) => {
      for (const l of c.labels) {
        const next = code.newLabel();
        if (l.tag === 'PatternCaseLabel') {
          this.genPatternTest(m, l.pat, sel, st, next, false);
          if (c.guard) this.genBranchFalse(m, c.guard, next);
          code.jump(OP.goto, bodyLabels[i]);
        } else if (l.tag === 'ConstantCaseLabel' && !l.isNull) {
          if (l.enumConst) {
            code.local(OP.aload, sel);
            code.field(OP.getstatic, l.enumConst.owner.binaryName(), l.enumConst.name, this.desc(l.enumConst.type));
            code.jump(OP.if_acmpne, next);
          } else if (typeof l.value === 'string') {
            code.local(OP.aload, sel);
            code.sconst(l.value);
            code.invoke(OP.invokevirtual, 'java/lang/Object', 'equals', '(Ljava/lang/Object;)Z', false);
            code.jump(OP.ifeq, next);
          } else if (selType.kind === 'prim') {
            this.loadLocal(m, sel, selType);
            this.pushConst(m, l.value, selType);
            this.emitPrimNe(code, selType, next);
          } else {
            // boxed selector with a primitive constant label
            const u = this.types.unboxedType(st) || PRIM.int;
            const box = this.types.boxedClass(u);
            code.local(OP.aload, sel);
            code.typeOp(OP.instanceof, box.sym.binaryName());
            code.jump(OP.ifeq, next);
            code.local(OP.aload, sel);
            this.coerce(m, box, u);
            this.pushConst(m, l.value, u);
            this.emitPrimNe(code, u, next);
          }
          if (c.guard) this.genBranchFalse(m, c.guard, next);
          code.jump(OP.goto, bodyLabels[i]);
        } else {
          continue;
        }
        code.placeTarget(next);
      }
    });
    if (defaultIndex >= 0) code.jump(OP.goto, bodyLabels[defaultIndex]);
    else code.jump(OP.goto, dispatchDefault);
  }

  emitPrimNe(code, t, label) {
    const k = jvmKind(t);
    if (k === 'I') code.jump(OP.if_icmpne, label);
    else {
      code.op(k === 'J' ? OP.lcmp : k === 'F' ? OP.fcmpl : OP.dcmpl);
      code.jump(OP.ifne, label);
    }
  }

  // ---- lambdas and method references --------------------------------------------------------------
  genLambdaIndy(m, tree) {
    const lm = tree.lambdaMethod;
    if (!lm) throw new Error('gen: lambda without lowering info');
    const code = m.code;
    const owner = lm.owner;
    const target = unparen(tree).finalTarget || tree.target || tree.type;
    const fn = this.c.attr.rs.functionType(target);
    if (!fn) throw new Error(`gen: no function type for ${T.typeToString(target)}`);
    const capturedTypes = [];
    // receiver for instance lambda methods
    if (lm.isInstance) {
      code.local(OP.aload, 0);
      capturedTypes.push(this.syms.erasedType(owner));
    }
    if (lm.kind === 'ref' && lm.boundReceiver) {
      // bound method reference receiver, evaluated now and null-checked
      const rt = this.genExpr(m, tree.expr, null);
      code.op(OP.dup);
      code.invoke(OP.invokestatic, 'java/util/Objects', 'requireNonNull', '(Ljava/lang/Object;)Ljava/lang/Object;', false);
      code.op(OP.pop);
      capturedTypes.push(lm.receiverType);
      void rt;
    }
    for (const v of lm.captured) {
      this.loadVar(m, v);
      capturedTypes.push(v.type);
    }
    const ifaceType = this.types.erasure(target.kind === 'intersection' ? target.bounds.find((b) => this.c.attr.rs.functionType(b)) || target.bounds[0] : target);
    const indyDesc = `(${capturedTypes.map((t) => this.desc(t)).join('')})${this.desc(ifaceType)}`;
    const pool = code.pool;
    const samDesc = this.desc(this.types.erasure(fn.sym.type));
    const instDesc = this.desc(new T.MethodType(fn.type.params.map((p) => this.lambdaErasure(p)), this.lambdaErasure(fn.type.ret), [], []));
    const implKind = lm.isInstance ? (owner.isInterface() ? REF.invokeInterface : REF.invokeVirtual) : REF.invokeStatic;
    const implHandle = pool.methodHandle(implKind === REF.invokeVirtual && lm.isPrivate ? REF.invokeVirtual : implKind, owner.binaryName(), lm.name, lm.desc, owner.isInterface());
    const serializable = this.isSerializableTarget(target);
    const markers = target.kind === 'intersection' ? target.bounds.filter((b) => this.types.erasure(b) !== ifaceType && !(this.types.erasure(b).sym === ifaceType.sym)).map((b) => this.types.erasure(b)) : [];
    const bridges = this.lambdaBridges(fn, ifaceType);
    let bsm;
    if (serializable || markers.length || bridges.length) {
      const mh = pool.methodHandle(REF.invokeStatic, 'java/lang/invoke/LambdaMetafactory', 'altMetafactory',
        '(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;[Ljava/lang/Object;)Ljava/lang/invoke/CallSite;', false);
      let flags = 0;
      if (serializable) flags |= 1;
      const realMarkers = markers.filter((mk) => !(mk.sym.fullName === 'java.io.Serializable'));
      if (realMarkers.length) flags |= 2;
      if (bridges.length) flags |= 4;
      const args = [pool.methodType(samDesc), implHandle, pool.methodType(instDesc), pool.int(flags)];
      if (realMarkers.length) { args.push(pool.int(realMarkers.length)); for (const mk of realMarkers) args.push(pool.clazz(mk.sym.binaryName())); }
      if (bridges.length) { args.push(pool.int(bridges.length)); for (const b of bridges) args.push(pool.methodType(b)); }
      bsm = pool.bootstrapMethod(mh, args);
    } else {
      const mh = pool.methodHandle(REF.invokeStatic, 'java/lang/invoke/LambdaMetafactory', 'metafactory',
        '(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;Ljava/lang/invoke/MethodType;Ljava/lang/invoke/MethodHandle;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/CallSite;', false);
      bsm = pool.bootstrapMethod(mh, [pool.methodType(samDesc), implHandle, pool.methodType(instDesc)]);
    }
    code.invokedynamic(bsm, fn.sym.name, indyDesc);
    return target;
  }

  // erasure used for lambda signatures (captured vars / intersections)
  lambdaErasure(t) {
    if (t.kind === 'wildcard') return this.types.erasure(t.bk === 'extends' ? t.bound : this.syms.objectType);
    return this.types.erasure(t);
  }

  isSerializableTarget(target) {
    const ser = this.syms.symOf('java.io.Serializable');
    const ts = target.kind === 'intersection' ? target.bounds : [target];
    return ts.some((t) => { const e = this.types.erasure(t); return e.kind === 'class' && this.syms.isSubClass(e.sym, ser); });
  }

  // other erased signatures of the functional method that need bridges in the lambda class
  lambdaBridges(fn, ifaceType) {
    const out = new Set();
    const main = this.desc(this.types.erasure(fn.sym.type));
    const csym = ifaceType.sym;
    const seen = new Set();
    const go = (s) => {
      if (!s || seen.has(s)) return;
      seen.add(s);
      this.syms.completeMembers(s);
      for (const mm of s.getMembers(fn.sym.name)) {
        if (mm.kind !== 'method' || !mm.isAbstract() || mm.params.length !== fn.sym.params.length) continue;
        const d = this.desc(this.types.erasure(mm.type));
        if (d !== main) out.add(d);
      }
      for (const i of s.interfaces || []) if (i.kind === 'class') go(i.sym);
    };
    go(csym);
    return [...out];
  }
}

module.exports = { Gen, MethodGen, jvmKind, LOAD, STORE, RETURN, arrayLoadOp, arrayStoreOp };
