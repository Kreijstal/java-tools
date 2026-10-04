'use strict';

// Class-level code generation: fields, constructors, <clinit>, synthetic
// members (enum, record, bridges, lambda bodies) and class file attributes.

const path = require('path');
const { F } = require('./flags');
const T = require('./types');
const { ClassFile, ByteWriter, REF } = require('./classfile');
const { Code, OP } = require('./code');
const { MethodGen, jvmKind, LOAD, STORE, RETURN, arrayLoadOp } = require('./gen');
const { unparen } = require('./attr');
const { qualifiedName } = require('./enter');

const PRIM = T.PRIM;

const CLASS_ACCESS_MASK = 0x0001 | 0x0010 | 0x0200 | 0x0400 | 0x1000 | 0x2000 | 0x4000;
const INNER_ACCESS_MASK = 0x0001 | 0x0002 | 0x0004 | 0x0008 | 0x0010 | 0x0200 | 0x0400 | 0x1000 | 0x2000 | 0x4000;
const FIELD_ACCESS_MASK = 0x0001 | 0x0002 | 0x0004 | 0x0008 | 0x0010 | 0x0040 | 0x0080 | 0x1000 | 0x4000;
const METHOD_ACCESS_MASK = 0x0001 | 0x0002 | 0x0004 | 0x0008 | 0x0010 | 0x0020 | 0x0040 | 0x0080 | 0x0100 | 0x0400 | 0x1000;

class ClassGen {
  constructor(compiler) {
    this.c = compiler;
    this.syms = compiler.syms;
    this.types = compiler.syms.types;
    this.lower = compiler.lower;
    this.gen = compiler.gen;
    this.attr = compiler.attr;
    this.enter = compiler.enter;
    this.major = compiler.options.major || 72;
  }

  hierarchy() {
    const cache = new Map();
    return (name) => {
      if (cache.has(name)) return cache.get(name);
      let sym = this.syms.classes.get(name.replace(/\//g, '.'));
      if (!sym) sym = this.syms.findClassByName(name.replace(/\//g, '.').replace(/\$/g, '.'));
      let r = null;
      if (sym) {
        this.syms.completeHeader(sym);
        r = {
          super: sym.superclass ? this.types.erasure(sym.superclass).sym.binaryName() : null,
          interfaces: (sym.interfaces || []).map((i) => this.types.erasure(i).sym.binaryName()),
          isInterface: sym.isInterface(),
        };
      }
      cache.set(name, r);
      return r;
    };
  }

  outermost(csym) {
    let c = csym;
    for (;;) {
      let o = c.owner;
      while (o && o.kind === 'method') o = o.owner;
      if (!o || o.kind !== 'class') return c;
      c = o;
    }
  }

  enclosingClass(csym) {
    let o = csym.owner;
    while (o && o.kind !== 'class') o = o.owner;
    return o;
  }

  // ---- entry point --------------------------------------------------------------
  generate(csym) {
    this.syms.completeMembers(csym);
    const tr = this.lower.trans(csym);
    const cf = new ClassFile(this.major);
    this.cf = cf;
    this.csym = csym;
    this.hier = this.hierarchy();
    const decl = csym.tree;
    // class header
    let access = csym.flags & CLASS_ACCESS_MASK;
    if (csym.flags & F.PROTECTED) access |= F.PUBLIC;
    if (csym.isInterface()) access = (access & ~F.FINAL) | F.ABSTRACT | F.INTERFACE;
    else access |= F.SUPER;
    if (csym.isLocal || csym.isAnonymous) access &= ~F.PUBLIC;
    if (csym.isAnonymous) access &= ~F.FINAL;
    if (csym.isEnum() && csym.tree && csym.tree.kind === 'enum') {
      access |= F.ENUM;
      if (csym.tree.defs.some((d) => d.tag === 'VarDecl' && d.enumConstant && d.enumConstant.body)) access &= ~F.FINAL;
    }
    if (csym.enumConstantBody) access = (access | F.FINAL | F.ENUM | F.SUPER) & ~F.ABSTRACT;
    cf.access = access & 0xffff;
    cf.thisClass = csym.binaryName();
    const sup = csym.superclass ? this.types.erasure(csym.superclass) : null;
    cf.superClass = sup ? sup.sym.binaryName() : null;
    cf.interfaces = (csym.interfaces || []).map((i) => this.types.erasure(i).sym.binaryName());

    this.prepareLambdas(csym, tr);
    this.genFields(csym, tr, cf);
    this.genMethods(csym, tr, cf);
    this.genClassAttributes(csym, tr, cf);
    return cf.toBuffer();
  }

  // ---- fields ---------------------------------------------------------------------
  genFields(csym, tr, cf) {
    const add = (f, extraAttrs) => {
      const fa = { access: f.flags & FIELD_ACCESS_MASK, name: f.name, desc: this.types.descriptor(f.type), attributes: extraAttrs || [] };
      cf.fields.push(fa);
      return fa;
    };
    if (tr.outerThis) add(tr.outerThis);
    for (const f of tr.capturedFields.values()) { f.flags |= F.PRIVATE; add(f); }
    const decl = csym.tree;
    if (csym.isRecord()) {
      for (const f of csym.recordComponents) {
        const attrs = [];
        if (this.types.needsSignature(f.type)) attrs.push(cf.attr('Signature', this.u2(cf.pool.utf8(this.types.signature(f.type)))));
        attrs.push(...this.annotationAttrs(f.tree.mods.annotations, this.enter.classEnv(csym), 'FIELD'));
        add(f, attrs);
      }
    }
    for (const d of decl.defs) {
      if (d.tag !== 'VarDecl' || !d.sym) continue;
      const f = d.sym;
      const attrs = [];
      if ((f.flags & F.STATIC) && (f.flags & F.FINAL)) {
        const cv = this.attr.constValueOf(f);
        if (cv !== null && cv !== undefined) attrs.push(cf.attr('ConstantValue', this.u2(this.constIndex(cf, cv, f.type))));
      }
      if (this.types.needsSignature(f.type)) attrs.push(cf.attr('Signature', this.u2(cf.pool.utf8(this.types.signature(f.type)))));
      attrs.push(...this.annotationAttrs(d.mods.annotations, this.enter.classEnv(csym), 'FIELD'));
      add(f, attrs);
    }
    if (csym.isEnum() && decl.kind === 'enum') {
      add({ flags: F.PRIVATE | F.STATIC | F.FINAL | F.SYNTHETIC, name: '$VALUES', type: new T.ArrayType(this.syms.erasedType(csym)) });
    }
    // interface fields must be public (JVMS 4.5)
    if (tr.usesAssert) add({ flags: F.STATIC | F.FINAL | F.SYNTHETIC | (csym.isInterface() ? F.PUBLIC : 0), name: '$assertionsDisabled', type: PRIM.boolean });
  }

  u2(v) { const w = new ByteWriter(2); w.u2(v); return w; }

  constIndex(cf, v, type) {
    const tag = type.kind === 'prim' ? type.tag : 'String';
    switch (tag) {
      case 'boolean': return cf.pool.int(v ? 1 : 0);
      case 'byte': case 'short': case 'char': case 'int': return cf.pool.int(v);
      case 'long': return cf.pool.long(v);
      case 'float': return cf.pool.float(v);
      case 'double': return cf.pool.double(v);
      default: return cf.pool.string(String(v));
    }
  }

  // ---- methods ----------------------------------------------------------------------
  newMethodGen(csym, msym, isStatic, paramDescs, name, isCtor) {
    const code = new Code(this.cf.pool, {
      owner: csym.binaryName(),
      isCtor: !!isCtor,
      isStatic,
      paramDescs,
      hierarchy: this.hier,
      methodName: name,
      maxLocals: (isStatic ? 0 : 1) + paramDescs.reduce((n, d) => n + (d === 'J' || d === 'D' ? 2 : 1), 0),
    });
    const m = new MethodGen(this.gen, csym, msym, code);
    return m;
  }

  addMethod(access, name, desc, code, extraAttrs) {
    const attrs = [];
    if (code) attrs.push({ name: this.cf.pool.utf8('Code'), data: code.finish(this.cf) });
    if (extraAttrs) attrs.push(...extraAttrs);
    this.cf.methods.push({ access: access & 0xffff, name, desc, attributes: attrs });
  }

  methodAccess(msym) {
    let a = msym.flags & METHOD_ACCESS_MASK;
    const owner = msym.owner;
    if (owner.isInterface()) {
      if (msym.flags & (F.DEFAULT)) a &= ~F.ABSTRACT;
    }
    return a;
  }

  genMethods(csym, tr, cf) {
    const decl = csym.tree;
    const cenv = this.enter.classEnv(csym);
    for (const d of decl.defs) {
      if (d.tag !== 'MethodDecl' || !d.sym) continue;
      this.genMethodDecl(csym, tr, d);
    }
    // implicit constructors
    if (csym.anonCtor) this.genAnonCtor(csym, tr, csym.anonCtor);
    else if (csym.defaultCtor) this.genCtor(csym, tr, csym.defaultCtor, null);
    for (const list of csym.members.values()) {
      for (const m of list) {
        if (m.kind !== 'method' || m.tree) continue;
        if (m === csym.defaultCtor || m === csym.anonCtor) continue;
        switch (m.syntheticKind) {
          case 'enumValues': this.genEnumValues(csym, m); break;
          case 'enumValueOf': this.genEnumValueOf(csym, m); break;
          case 'recordCanonical': this.genCtor(csym, tr, m, null); break;
          case 'recordAccessor': this.genRecordAccessor(csym, m); break;
          case 'recordObjectMethod': this.genRecordObjectMethod(csym, m); break;
          default: break;
        }
      }
    }
    for (const b of tr.bridges) this.genBridge(csym, b);
    // lambda bodies (generation of a lambda body may not add new lambdas: all were collected)
    for (const lm of tr.lambdas) this.genLambdaMethod(csym, tr, lm);
    this.genClinit(csym, tr);
    void cenv;
  }

  methodAttrs(msym, d) {
    const cf = this.cf;
    const attrs = [];
    const thrown = msym.type.thrown;
    if (thrown.length) {
      const w = new ByteWriter();
      w.u2(thrown.length);
      for (const t of thrown) w.u2(cf.pool.clazz(this.gen.internalName(t)));
      attrs.push(cf.attr('Exceptions', w));
    }
    if (this.types.needsSignature(msym.type)) attrs.push(cf.attr('Signature', this.u2(cf.pool.utf8(this.types.signature(msym.type)))));
    if (d) {
      const env = msym.env || this.enter.classEnv(msym.owner);
      attrs.push(...this.annotationAttrs(d.mods.annotations, env, 'METHOD'));
      const pann = this.parameterAnnotationAttrs(d, env);
      attrs.push(...pann);
      if (d.defaultValue) {
        const w = new ByteWriter();
        this.writeElementValue(w, d.defaultValue, msym.type.ret, env);
        attrs.push(cf.attr('AnnotationDefault', w));
      }
    }
    return attrs;
  }

  genMethodDecl(csym, tr, d) {
    const msym = d.sym;
    if (msym.isConstructor) { this.genCtor(csym, tr, msym, d); return; }
    const access = this.methodAccess(msym);
    const desc = this.types.descriptor(msym.type);
    if (!d.body) {
      this.addMethod(access, msym.name, desc, null, this.methodAttrs(msym, d));
      return;
    }
    const isStatic = (msym.flags & F.STATIC) !== 0;
    const pdescs = msym.type.params.map((p) => this.types.descriptor(p));
    const m = this.newMethodGen(csym, msym, isStatic, pdescs, msym.name, false);
    let slot = isStatic ? 0 : 1;
    for (const p of msym.params) {
      m.locals.set(p, { slot, type: p.type });
      slot += this.types.isWide(p.type) ? 2 : 1;
    }
    m.code.nextLocal = slot;
    m.returnType = msym.type.ret;
    this.gen.lineOf(m, d);
    this.gen.genStats(m, d.body.stats);
    if (m.code.alive) {
      if (m.returnType.kind === 'prim' && m.returnType.tag === 'void') m.code.op(OP.return);
      else throw new Error(`method ${csym.fullName}.${msym.name} can fall off the end`);
    }
    this.addMethod(access, msym.name, desc, m.code, this.methodAttrs(msym, d));
  }

  // ---- constructors ------------------------------------------------------------------------
  // Synthetic leading/trailing parameters and the prologue that stores them.
  setupCtorParams(m, csym, tr, msym, declaredParams) {
    const code = m.code;
    let slot = 1;
    const pdescs = [];
    if (csym.isEnum() || csym.enumConstantBody) {
      m.enumNameSlot = slot++;
      m.enumOrdinalSlot = slot++;
      pdescs.push('Ljava/lang/String;', 'I');
    } else if (tr.outerThis) {
      m.outerThisParam = slot++;
      pdescs.push(this.types.descriptor(tr.outerThis.type));
    }
    if (csym.superOuterParam && csym.isAnonymous) {
      const supTr = this.lower.trans(this.types.erasure(csym.superclass).sym);
      m.superOuterParam = slot++;
      pdescs.push(this.types.descriptor(supTr.outerThis.type));
    }
    for (const p of declaredParams) {
      if (p.sym) m.locals.set(p.sym, { slot, type: p.type });
      slot += this.types.isWide(p.type) ? 2 : 1;
      pdescs.push(this.types.descriptor(p.type));
    }
    m.capturedParams = new Map();
    for (const v of tr.captured) {
      m.capturedParams.set(v, slot);
      m.locals.set(v, { slot, type: v.type });
      slot += this.types.isWide(v.type) ? 2 : 1;
      pdescs.push(this.types.descriptor(v.type));
    }
    code.nextLocal = slot;
    if (slot > code.maxLocals) code.maxLocals = slot;
    return pdescs;
  }

  // store this$0 and val$ fields (allowed before the super constructor call)
  storeSyntheticFields(m, csym, tr) {
    const code = m.code;
    if (tr.outerThis && m.outerThisParam !== undefined) {
      code.local(OP.aload, 0);
      code.local(OP.aload, m.outerThisParam);
      code.field(OP.putfield, csym.binaryName(), 'this$0', this.types.descriptor(tr.outerThis.type));
    }
    for (const [v, f] of tr.capturedFields) {
      code.local(OP.aload, 0);
      code.local(LOAD[jvmKind(v.type)], m.capturedParams.get(v));
      code.field(OP.putfield, csym.binaryName(), f.name, this.types.descriptor(f.type));
    }
  }

  // field initializers and instance initializer blocks, in textual order
  genInstanceInits(m, csym) {
    const code = m.code;
    for (const d of csym.tree.defs) {
      if (d.tag === 'VarDecl' && d.sym && !(d.sym.flags & F.STATIC) && d.init && !d.enumConstant) {
        this.gen.lineOf(m, d);
        code.local(OP.aload, 0);
        if (d.init.tag === 'NewArray' && !d.init.elemtype) {
          d.init.type = d.init.type || d.sym.type;
          this.gen.genNewArray(m, d.init);
        } else this.gen.genExpr(m, d.init, d.sym.type);
        code.field(OP.putfield, csym.binaryName(), d.sym.name, this.types.descriptor(d.sym.type));
      } else if (d.tag === 'Block' && !d.isStatic) {
        const saved = code.nextLocal;
        this.gen.genStats(m, d.stats);
        code.nextLocal = saved;
      }
    }
  }

  // the implicit super() call
  genImplicitSuper(m, csym) {
    const code = m.code;
    const sup = csym.superclass ? this.types.erasure(csym.superclass).sym : null;
    if (!sup) return;
    code.local(OP.aload, 0);
    if (csym.isEnum() && !csym.enumConstantBody) {
      code.local(OP.aload, m.enumNameSlot);
      code.local(OP.iload, m.enumOrdinalSlot);
      code.invoke(OP.invokespecial, 'java/lang/Enum', '<init>', '(Ljava/lang/String;I)V', false);
      return;
    }
    // the no-arg constructor of the superclass (with its synthetic parameters)
    this.syms.completeMembers(sup);
    const ctor = sup.getMembers('<init>').find((c) => c.kind === 'method' && (c.params.length === 0 || ((c.flags & F.VARARGS) && c.params.length === 1)));
    if (!ctor) throw new Error(`no no-arg constructor in ${sup.fullName} for ${csym.fullName}`);
    if (sup.hasOuterThis) this.gen.loadOuterFromCtor(m, this.lower.trans(sup).outerClass);
    if (ctor.params.length === 1) { code.iconst(0); this.gen.newArrayOf(m, this.types.elemtype(this.types.erasure(ctor.params[0].type))); }
    this.gen.pushCapturedArgs(m, sup, false);
    code.invoke(OP.invokespecial, sup.binaryName(), '<init>', this.gen.ctorDescriptor(sup, ctor), false);
  }

  genCtor(csym, tr, msym, d) {
    const declaredParams = msym.params.map((p) => ({ sym: p, type: p.type }));
    const access = msym.flags & METHOD_ACCESS_MASK & ~F.STATIC;
    const m = this.newMethodGen(csym, msym, false, [], '<init>', true);
    const pdescs = this.setupCtorParams(m, csym, tr, msym, declaredParams);
    m.code.paramDescs = pdescs;
    m.returnType = PRIM.void;
    m.inCtorBeforeFields = true;
    const code = m.code;
    if (d) this.gen.lineOf(m, d);
    this.storeSyntheticFields(m, csym, tr);
    const stats = d && d.body ? d.body.stats : [];
    const callIdx = stats.findIndex((s) => s.tag === 'Exec' && unparen(s.expr).tag === 'Apply' && unparen(s.expr).ctorCall);
    const compact = !!(msym.flags & F.COMPACT_RECORD_CONSTRUCTOR);
    if (callIdx >= 0) {
      const call = unparen(stats[callIdx].expr);
      this.gen.genStats(m, stats.slice(0, callIdx));
      m.afterSuper = () => { m.inCtorBeforeFields = false; this.genInstanceInits(m, csym); };
      if (call.ctorCall === 'this') m.afterSuper = () => { m.inCtorBeforeFields = false; };
      this.gen.lineOf(m, stats[callIdx]);
      this.gen.genCtorCall(m, call);
      m.afterSuper = null;
      this.gen.genStats(m, stats.slice(callIdx + 1));
    } else {
      this.genImplicitSuper(m, csym);
      m.inCtorBeforeFields = false;
      this.genInstanceInits(m, csym);
      this.gen.genStats(m, stats);
    }
    // canonical record constructor: assign the component fields at the end
    if (csym.isRecord() && (compact || msym.syntheticKind === 'recordCanonical')) {
      if (code.alive) {
        msym.params.forEach((p, i) => {
          const f = csym.recordComponents[i];
          code.local(OP.aload, 0);
          code.local(LOAD[jvmKind(p.type)], m.locals.get(p).slot);
          code.field(OP.putfield, csym.binaryName(), f.name, this.types.descriptor(f.type));
        });
      }
    }
    if (code.alive) code.op(OP.return);
    const desc = `(${pdescs.join('')})V`;
    const attrs = this.methodAttrs(msym, d);
    // a Signature attribute must match the descriptor's declared parameters only when there are no synthetic ones
    const hasSynthetic = csym.isEnum() || csym.enumConstantBody || tr.outerThis || tr.captured.length;
    this.addMethod(access, '<init>', desc, code, hasSynthetic ? attrs.filter((a) => this.cf.pool.entries[a.name].value !== 'Signature') : attrs);
  }

  genAnonCtor(csym, tr, ctor) {
    const m = this.newMethodGen(csym, ctor, false, [], '<init>', true);
    const declaredParams = ctor.params.map((p) => ({ sym: p, type: p.type }));
    const pdescs = this.setupCtorParams(m, csym, tr, ctor, declaredParams);
    m.code.paramDescs = pdescs;
    m.returnType = PRIM.void;
    m.inCtorBeforeFields = true;
    const code = m.code;
    this.storeSyntheticFields(m, csym, tr);
    // super(args...)
    const sup = this.types.erasure(csym.superclass).sym;
    const superCtor = ctor.anonSuperCtor;
    code.local(OP.aload, 0);
    if (csym.enumConstantBody) {
      code.local(OP.aload, m.enumNameSlot);
      code.local(OP.iload, m.enumOrdinalSlot);
    } else if (m.superOuterParam !== undefined) {
      code.local(OP.aload, m.superOuterParam);
    } else if (sup.hasOuterThis) {
      this.gen.loadOuterFromCtor(m, this.lower.trans(sup).outerClass);
    }
    for (const p of ctor.params) code.local(LOAD[jvmKind(p.type)], m.locals.get(p).slot);
    this.gen.pushCapturedArgs(m, sup, false);
    code.invoke(OP.invokespecial, sup.binaryName(), '<init>', this.gen.ctorDescriptor(sup, superCtor), false);
    m.inCtorBeforeFields = false;
    this.genInstanceInits(m, csym);
    code.op(OP.return);
    this.addMethod(0, '<init>', `(${pdescs.join('')})V`, code, []);
  }

  // ---- enums -------------------------------------------------------------------------------
  genEnumValues(csym, msym) {
    const m = this.newMethodGen(csym, msym, true, [], 'values', false);
    const arr = `[L${csym.binaryName()};`;
    m.code.field(OP.getstatic, csym.binaryName(), '$VALUES', arr);
    m.code.invoke(OP.invokevirtual, arr, 'clone', '()Ljava/lang/Object;', false);
    m.code.typeOp(OP.checkcast, arr);
    m.code.op(OP.areturn);
    this.addMethod(F.PUBLIC | F.STATIC, 'values', `()${arr}`, m.code, []);
  }

  genEnumValueOf(csym, msym) {
    const m = this.newMethodGen(csym, msym, true, ['Ljava/lang/String;'], 'valueOf', false);
    const code = m.code;
    code.classConst(csym.binaryName());
    code.local(OP.aload, 0);
    code.invoke(OP.invokestatic, 'java/lang/Enum', 'valueOf', '(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Enum;', false);
    code.typeOp(OP.checkcast, csym.binaryName());
    code.op(OP.areturn);
    this.addMethod(F.PUBLIC | F.STATIC, 'valueOf', `(Ljava/lang/String;)L${csym.binaryName()};`, code, []);
  }

  // ---- records -------------------------------------------------------------------------------
  genRecordAccessor(csym, msym) {
    const f = msym.component;
    const m = this.newMethodGen(csym, msym, false, [], msym.name, false);
    m.code.local(OP.aload, 0);
    m.code.field(OP.getfield, csym.binaryName(), f.name, this.types.descriptor(f.type));
    m.code.op(RETURN[jvmKind(f.type)]);
    const attrs = [];
    if (this.types.needsSignature(msym.type)) attrs.push(this.cf.attr('Signature', this.u2(this.cf.pool.utf8(this.types.signature(msym.type)))));
    this.addMethod(F.PUBLIC, msym.name, this.types.descriptor(msym.type), m.code, attrs);
  }

  genRecordObjectMethod(csym, msym) {
    const cf = this.cf;
    const pool = cf.pool;
    const self = csym.binaryName();
    const pdescs = msym.type.params.map((p) => this.types.descriptor(p));
    const m = this.newMethodGen(csym, msym, false, pdescs, msym.name, false);
    const code = m.code;
    const bsmHandle = pool.methodHandle(REF.invokeStatic, 'java/lang/runtime/ObjectMethods', 'bootstrap',
      '(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/TypeDescriptor;Ljava/lang/Class;Ljava/lang/String;[Ljava/lang/invoke/MethodHandle;)Ljava/lang/Object;', false);
    const comps = csym.recordComponents;
    const args = [pool.clazz(self), pool.string(comps.map((c) => c.name).join(';'))];
    for (const c of comps) args.push(pool.methodHandle(REF.getField, self, c.name, this.types.descriptor(c.type), false));
    const bsm = pool.bootstrapMethod(bsmHandle, args);
    code.local(OP.aload, 0);
    let desc;
    if (msym.name === 'equals') { code.local(OP.aload, 1); desc = `(L${self};Ljava/lang/Object;)Z`; }
    else if (msym.name === 'hashCode') desc = `(L${self};)I`;
    else desc = `(L${self};)Ljava/lang/String;`;
    code.invokedynamic(bsm, msym.name, desc);
    code.op(RETURN[jvmKind(msym.type.ret)]);
    this.addMethod(F.PUBLIC | F.FINAL, msym.name, this.types.descriptor(msym.type), code, []);
  }

  // ---- bridges -------------------------------------------------------------------------------
  genBridge(csym, b) {
    const target = b.target;
    const erased = b.erased;
    const pdescs = erased.params.map((p) => this.types.descriptor(p));
    const m = this.newMethodGen(csym, null, false, pdescs, b.name, false);
    const code = m.code;
    code.local(OP.aload, 0);
    let slot = 1;
    const tparams = this.types.erasure(target.type).params;
    erased.params.forEach((p, i) => {
      code.local(LOAD[jvmKind(p)], slot);
      slot += this.types.isWide(p) ? 2 : 1;
      this.gen.coerce(m, p, tparams[i]);
    });
    const owner = csym.isInterface() ? csym : csym;
    const isIface = owner.isInterface();
    code.invoke(isIface ? OP.invokeinterface : OP.invokevirtual, owner.binaryName(), target.name, this.types.descriptor(target.type), isIface);
    const tret = this.types.erasure(target.type.ret);
    this.gen.coerce(m, tret, erased.ret);
    code.op(RETURN[jvmKind(erased.ret)]);
    let access = (target.flags & (F.PUBLIC | F.PROTECTED | F.PRIVATE)) | F.BRIDGE | F.SYNTHETIC;
    this.addMethod(access, b.name, b.desc, code, []);
  }

  // ---- lambdas --------------------------------------------------------------------------------
  prepareLambdas(csym, tr) {
    for (const lm of tr.lambdas) {
      const tree = lm.tree;
      const target = tree.finalTarget || tree.target || tree.type;
      const fn = this.attr.rs.functionType(target);
      if (!fn) throw new Error(`lambda without functional target in ${csym.fullName}`);
      lm.fn = fn;
      lm.retType = this.gen.lambdaErasure(fn.type.ret);
      lm.paramTypes = fn.type.params.map((p) => this.gen.lambdaErasure(p));
      lm.isInstance = lm.usesThis;
      lm.isPrivate = true;
      lm.name = `lambda$${lm.index}`;
      const params = [];
      if (lm.kind === 'ref') {
        lm.boundReceiver = tree.refKind === 'bound';
        if (lm.boundReceiver) {
          lm.receiverType = this.types.erasure(tree.qualType);
          params.push(lm.receiverType);
        }
      }
      for (const v of lm.captured) params.push(this.types.erasure(v.type));
      for (const p of lm.paramTypes) params.push(p);
      lm.allParams = params;
      lm.desc = `(${params.map((p) => this.types.descriptor(p)).join('')})${this.types.descriptor(lm.retType)}`;
    }
  }

  genLambdaMethod(csym, tr, lm) {
    const isStatic = !lm.isInstance;
    const pdescs = lm.allParams.map((p) => this.types.descriptor(p));
    const m = this.newMethodGen(csym, null, isStatic, pdescs, lm.name, false);
    m.isLambda = true;
    m.lambdaHasThis = lm.isInstance;
    const code = m.code;
    let slot = isStatic ? 0 : 1;
    let recvSlot = -1;
    if (lm.kind === 'ref' && lm.boundReceiver) { recvSlot = slot; slot++; }
    for (const v of lm.captured) {
      const t = this.types.erasure(v.type);
      m.locals.set(v, { slot, type: v.type });
      slot += this.types.isWide(t) ? 2 : 1;
    }
    const paramSlots = [];
    for (let i = 0; i < lm.paramTypes.length; i++) {
      paramSlots.push(slot);
      slot += this.types.isWide(lm.paramTypes[i]) ? 2 : 1;
    }
    code.nextLocal = slot;
    if (slot > code.maxLocals) code.maxLocals = slot;
    m.returnType = lm.retType;
    const tree = lm.tree;
    this.gen.lineOf(m, tree);
    if (lm.kind === 'lambda') {
      tree.params.forEach((p, i) => {
        // lambda parameters may be declared with a more specific type than the erased descriptor
        const ptype = p.sym.type;
        const st = lm.paramTypes[i];
        if (this.types.isSameType(this.types.erasure(ptype), this.types.erasure(st)) || ptype.kind === 'prim') {
          m.locals.set(p.sym, { slot: paramSlots[i], type: st.kind === 'prim' ? st : ptype });
        } else {
          // cast into a new local of the declared type
          code.local(LOAD[jvmKind(st)], paramSlots[i]);
          this.gen.coerce(m, st, ptype);
          const s = code.newLocal(this.types.isWide(ptype) ? 2 : 1);
          code.local(STORE[jvmKind(ptype)], s);
          m.locals.set(p.sym, { slot: s, type: ptype });
        }
      });
      const rt = lm.retType;
      const isVoid = rt.kind === 'prim' && rt.tag === 'void';
      if (tree.body.tag === 'Block') {
        this.gen.genStats(m, tree.body.stats);
        if (code.alive) {
          if (isVoid) code.op(OP.return);
          else throw new Error(`lambda body can complete normally in ${csym.fullName}`);
        }
      } else if (isVoid) {
        this.gen.genExecExpr(m, tree.body);
        code.op(OP.return);
      } else {
        this.gen.genExpr(m, tree.body, rt);
        code.op(RETURN[jvmKind(rt)]);
      }
    } else {
      this.genRefBody(m, lm, recvSlot, paramSlots);
    }
    this.addMethod((isStatic ? F.STATIC : 0) | F.PRIVATE | F.SYNTHETIC, lm.name, lm.desc, code, []);
  }

  // body of a synthetic method implementing a method reference
  genRefBody(m, lm, recvSlot, paramSlots) {
    const code = m.code;
    const tree = lm.tree;
    const g = this.gen;
    const ptypes = lm.paramTypes;
    const rt = lm.retType;
    const kind = tree.refKind;
    const loadParam = (i, target) => {
      code.local(LOAD[jvmKind(ptypes[i])], paramSlots[i]);
      if (target) g.coerce(m, ptypes[i], target);
    };
    // push args [from..] for method sym with instantiated mtype
    const pushArgs = (from, sym, mtype, varargs) => {
      const decl = sym.type.params;
      const inst = mtype ? mtype.params : decl;
      const n = decl.length;
      const avail = ptypes.length - from;
      if (!varargs) {
        for (let i = 0; i < avail; i++) loadParam(from + i, g.argTarget(inst[i], decl[i]));
        return;
      }
      for (let i = 0; i < n - 1; i++) loadParam(from + i, g.argTarget(inst[i], decl[i]));
      const arrT = this.types.erasure(decl[n - 1]);
      const elem = this.types.elemtype(arrT);
      const instElem = this.types.elemtype(inst[n - 1]) || elem;
      const rest = avail - (n - 1);
      code.iconst(rest);
      g.newArrayOf(m, elem);
      for (let k = 0; k < rest; k++) {
        code.op(OP.dup);
        code.iconst(k);
        loadParam(from + n - 1 + k, g.argTarget(instElem, elem));
        code.op(require('./gen').arrayStoreOp(elem));
      }
    };
    let resultType;
    if (kind === 'arrayCtor') {
      loadParam(0, PRIM.int);
      const at = this.types.erasure(tree.refReturnType);
      g.newArrayOf(m, this.types.elemtype(at));
      resultType = at;
    } else if (kind === 'ctor') {
      const csym = tree.sym.owner;
      code.typeOp(OP.new, csym.binaryName());
      code.op(OP.dup);
      if (csym.hasOuterThis) g.loadThisOf(m, this.lower.trans(csym).outerClass);
      pushArgs(0, tree.sym, tree.mtype, tree.varargs);
      g.pushCapturedArgs(m, csym, false);
      code.invoke(OP.invokespecial, csym.binaryName(), '<init>', g.ctorDescriptor(csym, tree.sym), false);
      resultType = tree.refReturnType;
    } else {
      const sym = tree.sym;
      const isStatic = (sym.flags & F.STATIC) !== 0;
      let from = 0;
      let op;
      let owner;
      if (isStatic) {
        op = OP.invokestatic;
        owner = sym.owner;
      } else if (kind === 'super') {
        code.local(OP.aload, 0);
        op = OP.invokespecial;
        owner = tree.superIface || this.types.erasure(tree.qualType).sym;
      } else {
        let recvType;
        if (kind === 'bound') {
          code.local(OP.aload, recvSlot);
          recvType = lm.receiverType;
        } else {
          // unbound: first parameter is the receiver
          recvType = this.types.erasure(tree.qualType);
          loadParam(0, tree.qualType.kind === 'array' ? tree.qualType : recvType);
          from = 1;
        }
        const re = this.types.erasure(recvType);
        if (sym.flags & F.PRIVATE) owner = sym.owner;
        else owner = re.kind === 'class' ? re.sym : this.syms.objectSym;
        if (owner.isInterface() && sym.owner === this.syms.objectSym) owner = this.syms.objectSym;
        op = owner.isInterface() ? OP.invokeinterface : (sym.flags & F.PRIVATE && owner === m.csym ? OP.invokespecial : OP.invokevirtual);
        if (tree.arrayClone || re.kind === 'array') {
          pushArgs(from, sym, tree.mtype, tree.varargs);
          code.invoke(OP.invokevirtual, this.types.descriptor(re), sym.name, this.types.descriptor(sym.type), false);
          resultType = sym.name === 'clone' ? re : this.types.erasure(sym.type.ret);
          if (sym.name === 'clone') code.typeOp(OP.checkcast, this.types.descriptor(re));
          op = null;
        }
      }
      if (op !== null) {
        pushArgs(from, sym, tree.mtype, tree.varargs);
        code.invoke(op, owner.binaryName(), sym.name, this.types.descriptor(sym.type), op === OP.invokeinterface || ((op === OP.invokestatic || op === OP.invokespecial) && owner.isInterface()));
        const declRet = this.types.erasure(sym.type.ret);
        resultType = tree.mtype ? tree.mtype.ret : sym.type.ret;
        if (declRet.kind !== 'prim') g.refCastStack(m, declRet, resultType);
        else resultType = declRet.kind === 'prim' ? sym.type.ret : resultType;
      }
    }
    const isVoid = rt.kind === 'prim' && rt.tag === 'void';
    if (isVoid) {
      g.pop(m, resultType);
      code.op(OP.return);
    } else {
      g.coerce(m, resultType, rt);
      code.op(RETURN[jvmKind(rt)]);
    }
  }

  // ---- static initializer ------------------------------------------------------------------------
  genClinit(csym, tr) {
    const decl = csym.tree;
    const isEnum = csym.isEnum() && decl.kind === 'enum';
    const needs = tr.usesAssert || isEnum || decl.defs.some((d) =>
      (d.tag === 'VarDecl' && d.sym && (d.sym.flags & F.STATIC) && d.init && !this.isConstantField(d.sym)) ||
      (d.tag === 'Block' && d.isStatic));
    if (!needs) return;
    const m = this.newMethodGen(csym, null, true, [], '<clinit>', false);
    m.returnType = PRIM.void;
    const code = m.code;
    if (tr.usesAssert) {
      const top = this.outermost(csym);
      const l1 = code.newLabel();
      const l2 = code.newLabel();
      code.classConst(top.binaryName());
      code.invoke(OP.invokevirtual, 'java/lang/Class', 'desiredAssertionStatus', '()Z', false);
      code.jump(OP.ifne, l1);
      code.iconst(1);
      code.jump(OP.goto, l2);
      code.placeTarget(l1);
      code.iconst(0);
      code.placeTarget(l2);
      code.field(OP.putstatic, csym.binaryName(), '$assertionsDisabled', 'Z');
    }
    let ordinal = 0;
    const constants = [];
    for (const d of decl.defs) {
      if (d.tag === 'VarDecl' && d.enumConstant) {
        this.gen.lineOf(m, d);
        const ec = d.enumConstant;
        const cls = ec.anonSym || csym;
        code.typeOp(OP.new, cls.binaryName());
        code.op(OP.dup);
        code.sconst(d.name);
        code.iconst(ordinal);
        this.gen.genArgs(m, ec.args, ec.ctor, ec.mtype, ec.varargs);
        let desc;
        if (ec.anonSym) {
          const parts = ['Ljava/lang/String;', 'I', ...ec.ctor.type.params.map((p) => this.types.descriptor(p))];
          desc = `(${parts.join('')})V`;
        } else desc = this.gen.ctorDescriptor(csym, ec.ctor);
        code.invoke(OP.invokespecial, cls.binaryName(), '<init>', desc, false);
        code.field(OP.putstatic, csym.binaryName(), d.name, `L${csym.binaryName()};`);
        constants.push(d.name);
        ordinal++;
        continue;
      }
      if (isEnum && constants.length && !this.valuesDone) {
        // $VALUES right after the constants
      }
      if (d.tag === 'VarDecl' && d.sym && (d.sym.flags & F.STATIC) && d.init && !this.isConstantField(d.sym)) {
        if (isEnum && !m.valuesEmitted) { this.emitValuesArray(m, csym, constants); m.valuesEmitted = true; }
        this.gen.lineOf(m, d);
        if (d.init.tag === 'NewArray' && !d.init.elemtype) {
          d.init.type = d.init.type || d.sym.type;
          this.gen.genNewArray(m, d.init);
        } else this.gen.genExpr(m, d.init, d.sym.type);
        code.field(OP.putstatic, csym.binaryName(), d.sym.name, this.types.descriptor(d.sym.type));
      } else if (d.tag === 'Block' && d.isStatic) {
        if (isEnum && !m.valuesEmitted) { this.emitValuesArray(m, csym, constants); m.valuesEmitted = true; }
        const saved = code.nextLocal;
        this.gen.genStats(m, d.stats);
        code.nextLocal = saved;
      }
    }
    if (isEnum && !m.valuesEmitted) this.emitValuesArray(m, csym, constants);
    if (code.alive) code.op(OP.return);
    this.addMethod(F.STATIC, '<clinit>', '()V', code, []);
  }

  emitValuesArray(m, csym, constants) {
    const code = m.code;
    code.iconst(constants.length);
    code.typeOp(OP.anewarray, csym.binaryName());
    constants.forEach((name, i) => {
      code.op(OP.dup);
      code.iconst(i);
      code.field(OP.getstatic, csym.binaryName(), name, `L${csym.binaryName()};`);
      code.op(OP.aastore);
    });
    code.field(OP.putstatic, csym.binaryName(), '$VALUES', `[L${csym.binaryName()};`);
  }

  isConstantField(f) {
    if (!((f.flags & F.STATIC) && (f.flags & F.FINAL))) return false;
    const cv = this.attr.constValueOf(f);
    return cv !== null && cv !== undefined;
  }

  // ---- class attributes ---------------------------------------------------------------------------
  genClassAttributes(csym, tr, cf) {
    const pool = cf.pool;
    const decl = csym.tree;
    if (csym.unit && csym.unit.file) cf.attributes.push(cf.attr('SourceFile', this.u2(pool.utf8(path.basename(csym.unit.file)))));
    // Signature
    const tps = csym.typarams || [];
    const supNeeds = (csym.superclass && this.types.needsSignature(csym.superclass)) || (csym.interfaces || []).some((i) => this.types.needsSignature(i));
    if (tps.length || supNeeds) {
      let sig = tps.length ? this.types.typeParamsSig(tps) : '';
      sig += csym.superclass ? this.types.signature(csym.superclass) : 'Ljava/lang/Object;';
      for (const i of csym.interfaces || []) sig += this.types.signature(i);
      cf.attributes.push(cf.attr('Signature', this.u2(pool.utf8(sig))));
    }
    // annotations
    if (decl && !csym.isAnonymous) {
      const env = csym.outerEnv || (csym.isLocal ? csym.localEnv : this.enter.classEnv(csym));
      cf.attributes.push(...this.annotationAttrs(decl.mods.annotations, env, 'TYPE'));
    }
    // EnclosingMethod
    if (csym.isLocal) {
      const encl = this.enclosingClass(csym);
      let meth = csym.owner && csym.owner.kind === 'method' ? csym.owner : null;
      const w = new ByteWriter();
      w.u2(pool.clazz(encl.binaryName()));
      if (meth) {
        let desc;
        if (meth.isConstructor) desc = this.gen.ctorDescriptor(encl, meth);
        else desc = this.types.descriptor(meth.type);
        w.u2(pool.nameAndType(meth.name, desc));
      } else w.u2(0);
      cf.attributes.push(cf.attr('EnclosingMethod', w));
    }
    // Record
    if (csym.isRecord()) {
      const w = new ByteWriter();
      w.u2(csym.recordComponents.length);
      for (const c of csym.recordComponents) {
        w.u2(pool.utf8(c.name));
        w.u2(pool.utf8(this.types.descriptor(c.type)));
        const attrs = [];
        if (this.types.needsSignature(c.type)) attrs.push(cf.attr('Signature', this.u2(pool.utf8(this.types.signature(c.type)))));
        attrs.push(...this.annotationAttrs(c.tree.mods.annotations, this.enter.classEnv(csym), 'RECORD_COMPONENT'));
        w.u2(attrs.length);
        for (const a of attrs) cf.writeAttr(w, a);
      }
      cf.attributes.push(cf.attr('Record', w));
    }
    // PermittedSubclasses
    let permitted = (csym.permitted || []).map((p) => this.types.erasure(p).sym);
    if ((csym.flags & F.SEALED) && !permitted.length) {
      // implicitly permitted: subclasses in the same compilation unit
      for (const c of this.syms.classes.values()) {
        if (c === csym || c.unit !== csym.unit) continue;
        this.syms.completeHeader(c);
        const direct = (c.superclass && this.types.erasure(c.superclass).sym === csym) || (c.interfaces || []).some((i) => this.types.erasure(i).sym === csym);
        if (direct) permitted.push(c);
      }
    }
    if (permitted.length && !csym.enumConstantBody && !(csym.isEnum() && decl && decl.kind === 'enum')) {
      const w = new ByteWriter();
      w.u2(permitted.length);
      for (const p of permitted) w.u2(pool.clazz(p.binaryName()));
      cf.attributes.push(cf.attr('PermittedSubclasses', w));
    }
    // nests
    const top = this.outermost(csym);
    if (top !== csym) {
      cf.attributes.push(cf.attr('NestHost', this.u2(pool.clazz(top.binaryName()))));
    } else {
      const members = [];
      for (const c of this.syms.classes.values()) {
        if (c !== csym && c.unit === csym.unit && this.outermost(c) === csym && c.tree) members.push(c);
      }
      if (members.length) {
        const w = new ByteWriter();
        w.u2(members.length);
        for (const c of members) w.u2(pool.clazz(c.binaryName()));
        cf.attributes.push(cf.attr('NestMembers', w));
      }
    }
    // InnerClasses: every nested class referenced from the constant pool, plus our members
    const inner = new Set();
    const addInner = (c) => {
      if (!c || inner.has(c)) return;
      const encl = this.enclosingClass(c);
      if (!encl) return;
      inner.add(c);
      if (!c.isLocal) addInner(encl);
    };
    if (decl) for (const d of decl.defs) if (d.tag === 'ClassDecl' && d.sym) addInner(d.sym);
    addInner(csym);
    for (let i = 1; i < pool.entries.length; i++) {
      const e = pool.entries[i];
      if (!e || e.tag !== 7) continue;
      const name = pool.entries[e.name].value;
      if (name[0] === '[' || !name.includes('$')) continue;
      const c = this.syms.classes.get(name.replace(/\//g, '.'));
      if (c) addInner(c);
    }
    if (inner.size) {
      const list = [...inner];
      // outer classes before inner ones
      list.sort((a, b) => a.flatName.length - b.flatName.length);
      const w = new ByteWriter();
      w.u2(list.length);
      for (const c of list) {
        w.u2(pool.clazz(c.binaryName()));
        const encl = this.enclosingClass(c);
        w.u2(c.isLocal ? 0 : pool.clazz(encl.binaryName()));
        w.u2(c.isAnonymous ? 0 : pool.utf8(c.name));
        let flags = c.flags & INNER_ACCESS_MASK;
        if (c.isAnonymous) flags &= ~(F.STATIC | F.FINAL);
        if (c.enumConstantBody) flags = (flags | F.FINAL | F.ENUM) & ~F.STATIC;
        if (c.isInterface()) flags |= F.ABSTRACT | F.STATIC;
        w.u2(flags & 0xffff);
      }
      cf.attributes.push(cf.attr('InnerClasses', w));
    }
  }

  // ---- annotations ---------------------------------------------------------------------------------
  annotationAttrs(annotations, env, target) {
    if (!annotations || !annotations.length) return [];
    const vis = [];
    const invis = [];
    for (const a of annotations) {
      let at;
      try { at = this.enter.resolveType(a.annotationType, env); } catch (e) { continue; }
      if (!at || at.kind !== 'class') continue;
      const asym = at.sym;
      const ret = this.retention(asym);
      if (ret === 'SOURCE') continue;
      // a type-use-only annotation on a declaration is not a declaration annotation
      if (!this.applicableTo(asym, target)) continue;
      (ret === 'RUNTIME' ? vis : invis).push({ tree: a, sym: asym });
    }
    const out = [];
    const emit = (list, name) => {
      if (!list.length) return;
      const w = new ByteWriter();
      w.u2(list.length);
      for (const x of list) this.writeAnnotation(w, x.tree, x.sym, env);
      out.push(this.cf.attr(name, w));
    };
    emit(vis, 'RuntimeVisibleAnnotations');
    emit(invis, 'RuntimeInvisibleAnnotations');
    return out;
  }

  parameterAnnotationAttrs(d, env) {
    if (!d.params || !d.params.some((p) => p.mods.annotations.length)) return [];
    const per = d.params.map((p) => {
      const vis = [];
      const invis = [];
      for (const a of p.mods.annotations) {
        let at;
        try { at = this.enter.resolveType(a.annotationType, env); } catch (e) { continue; }
        if (!at || at.kind !== 'class') continue;
        const ret = this.retention(at.sym);
        if (ret === 'SOURCE' || !this.applicableTo(at.sym, 'PARAMETER')) continue;
        (ret === 'RUNTIME' ? vis : invis).push({ tree: a, sym: at.sym });
      }
      return { vis, invis };
    });
    const out = [];
    const emit = (key, name) => {
      if (!per.some((x) => x[key].length)) return;
      const w = new ByteWriter();
      w.u1(per.length);
      for (const x of per) {
        w.u2(x[key].length);
        for (const a of x[key]) this.writeAnnotation(w, a.tree, a.sym, env);
      }
      out.push(this.cf.attr(name, w));
    };
    emit('vis', 'RuntimeVisibleParameterAnnotations');
    emit('invis', 'RuntimeInvisibleParameterAnnotations');
    return out;
  }

  metaAnnotation(asym, name) {
    if (!asym.tree) return null;
    for (const a of asym.tree.mods.annotations) {
      const n = qualifiedName(a.annotationType);
      if (n === name || n.endsWith(`.${name}`)) return a;
    }
    return null;
  }

  retention(asym) {
    if (asym.retentionCache) return asym.retentionCache;
    let r = 'CLASS';
    const a = this.metaAnnotation(asym, 'Retention');
    if (a && a.args.length) {
      const v = unparen(a.args[0].rhs);
      const name = v.tag === 'Ident' ? v.name : v.tag === 'Select' ? v.name : 'CLASS';
      r = name;
    }
    asym.retentionCache = r;
    return r;
  }

  applicableTo(asym, target) {
    const a = this.metaAnnotation(asym, 'Target');
    if (!a || !a.args.length) return true;
    const names = [];
    const collect = (v) => {
      v = unparen(v);
      if (v.tag === 'NewArray') v.elems.forEach(collect);
      else if (v.tag === 'Ident' || v.tag === 'Select') names.push(v.name);
    };
    collect(a.args[0].rhs);
    if (names.includes(target)) return true;
    if (target === 'RECORD_COMPONENT' && (names.includes('FIELD') || names.includes('METHOD') || names.includes('PARAMETER'))) return names.includes('RECORD_COMPONENT');
    if (target === 'TYPE' && names.includes('ANNOTATION_TYPE')) return true;
    return false;
  }

  writeAnnotation(w, tree, asym, env) {
    const pool = this.cf.pool;
    w.u2(pool.utf8(`L${asym.binaryName()};`));
    this.syms.completeMembers(asym);
    w.u2(tree.args.length);
    for (const arg of tree.args) {
      const name = arg.lhs.name;
      const elem = asym.getMembers(name).find((m) => m.kind === 'method');
      if (!elem) throw new Error(`annotation ${asym.fullName} has no element ${name}`);
      w.u2(pool.utf8(name));
      this.writeElementValue(w, arg.rhs, elem.type.ret, env);
    }
  }

  writeElementValue(w, v, type, env) {
    const pool = this.cf.pool;
    const u = unparen(v);
    if (type.kind === 'array') {
      const elems = u.tag === 'NewArray' && !u.elemtype ? u.elems : [u];
      w.u1(0x5b); // '['
      w.u2(elems.length);
      for (const e of elems) this.writeElementValue(w, e, type.elem, env);
      return;
    }
    if (u.tag === 'Annotation') {
      const at = this.enter.resolveType(u.annotationType, env);
      w.u1(0x40); // '@'
      this.writeAnnotation(w, u, at.sym, env);
      return;
    }
    const te = this.types.erasure(type);
    if (te.kind === 'class' && te.sym.fullName === 'java.lang.Class') {
      if (!u.type) this.attr.attribExpr(u, this.annotEnv(env), null);
      const t = u.classLiteral || (u.tag === 'Select' ? this.enter.resolveType(u.selected, env) : null);
      w.u1(0x63); // 'c'
      w.u2(pool.utf8(t.kind === 'prim' ? T.DESC[t.tag] : this.types.descriptor(t)));
      return;
    }
    if (te.kind === 'class' && this.syms.completeHeader(te.sym).isEnum()) {
      const name = u.tag === 'Ident' ? u.name : u.name;
      w.u1(0x65); // 'e'
      w.u2(pool.utf8(`L${te.sym.binaryName()};`));
      w.u2(pool.utf8(name));
      return;
    }
    if (u.constValue === undefined) this.attr.attribExpr(u, this.annotEnv(env), type);
    let cv = u.constValue;
    if (cv === undefined) throw new Error('annotation value is not a constant');
    cv = this.attr.coerceConst(cv, u.type, type);
    const tag = type.kind === 'prim' ? type.tag : 'String';
    const tagChar = { byte: 'B', char: 'C', double: 'D', float: 'F', int: 'I', long: 'J', short: 'S', boolean: 'Z', String: 's' }[tag];
    w.u1(tagChar.charCodeAt(0));
    // String element values refer to a CONSTANT_Utf8 entry (JVMS 4.7.16.1)
    if (tagChar === 's') w.u2(this.cf.pool.utf8(String(cv)));
    else w.u2(this.constIndex(this.cf, cv, type));
  }

  annotEnv(env) {
    const e = env.dup('block');
    e.info = e.info || { csym: env.clazz };
    return e;
  }
}

module.exports = { ClassGen };
