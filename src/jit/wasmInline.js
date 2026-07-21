'use strict';

// General call inlining over krakatau code items, applied before CFG
// construction in the structured backend. No shape matching: any callee whose
// NORMAL FLOW is small, loop-free, and fully emittable by the structured
// backend is spliced into the caller — argument stores replace the invoke,
// callee locals are renumbered above the caller's frame, reachable returns
// become gotos to a per-site continuation label. The callee's exception table
// is dropped; obfuscator reporter handlers become unreachable dead items (the
// same no-op-handler equivalence the whole wasm tier is built on). Sites
// inside the caller's live handler ranges are never inlined.
//
// Static sites splice unconditionally. Instance sites (invokevirtual /
// invokeinterface / invokespecial) splice behind real-bytecode guards derived
// from the closed-world hierarchy:
//
//   astore/istore...          argument + receiver stores (renumbered slots)
//   aload recv; instanceof A; ifne ENT0     (per CHA impl, most-derived first)
//   aload recv; instanceof B; ifne ENT1
//   aconst_null; athrow                     <- deopt stub (see below)
//   ENT0: <body of A.m>   ... goto RET
//   ENT1: <body of B.m>   ... goto RET
//   RET: nop
//
// A guard miss (null receiver, class loaded after compile, stub-tainted
// receiver) reaches the deopt stub: the structured backend emits it as an
// interpreter exit that rebuilds the original operand stack [recv, args...]
// from the stored slots and resumes at the ORIGINAL call-site pc — the
// interpreter then re-executes the invoke with full semantics (dispatch,
// NPE). invokespecial is statically bound, so its only guard is ifnonnull.
//
// Interior instance calls inside a spliced body are recursively spliced
// (monomorphic only); their guard miss also deopts to the OUTER call site,
// which re-executes the whole flattened body in the interpreter. That replay
// is only sound while nothing observable has happened, so a callee is
// rejected when a heap write (putfield/putstatic/array store) can precede an
// interior guard, or when it overwrites its receiver/argument slots (the
// deopt stub's operand sources). Callee flow is forward-only (analyzeCallee
// rejects backward edges), so item order is a topological order and a
// positional scan over the flattened sequence is a sound over-approximation.
//
// checkcast/instanceof are allowed in spliced bodies: the structured backend
// compiles them (for spliced items only) as memoized imports that never
// deopt — a failed checkcast throws the guest CCE, which unwinds past the
// frame exactly like the interpreter's.
//
// Resume-pc mapping: each spliced item carries an original caller item index
// where the interpreter could equivalently resume — the call itself for the
// first argument store (arguments back on the operand stack, the call
// re-executes with no side effects done), the post-call index for the
// continuation label (the return value is on the operand stack). Interior
// items have no such pc (origIdx -1); the structured compiler retries
// without inlining if one of their blocks would need a plain exit stub.

const {
  getOp, parseMethodDescriptor, liveExceptionRanges, MATH_INTRINSICS,
} = require('./wasmShared');

const SHORT_LOCAL = /^([ilfda])(load|store)_([0-3])$/;
const LONG_LOCAL = /^([ilfda])(load|store)$/;
const RETURN_OP = /^[ilfda]?return$/;
const BRANCH_OP = /^(goto|if(eq|ne|lt|ge|gt|le|null|nonnull)|if_icmp(eq|ne|lt|ge|gt|le)|if_acmp(eq|ne))$/;
const PLAIN_OK = new RegExp('^(nop|aconst_null|iconst_(m1|[0-5])|lconst_[01]|fconst_[0-2]|dconst_[01]' +
  '|bipush|sipush|dup|dup_x1|dup_x2|dup2|dup2_x1|dup2_x2|pop|pop2|swap|arraylength' +
  '|[ilfd](add|sub|mul|div|rem|neg)|[il](shl|shr|ushr|and|or|xor)|iinc' +
  '|[ilfd]2[ilfd]|i2[bcs]|lcmp|[fd]cmp[lg]|[bcsilfda]aload|[bcsilfda]astore' +
  '|getstatic|putstatic|getfield|putfield)$');
const CAST_OK = /^(checkcast|instanceof)$/;
const INSTANCE_INVOKE = /^(invokevirtual|invokeinterface|invokespecial)$/;
const HEAP_WRITE = /^(putfield|putstatic|[bcsilfda]astore)$/;

function supportedCalleeOp(op, ins) {
  if (SHORT_LOCAL.test(op) || LONG_LOCAL.test(op) || PLAIN_OK.test(op)) return true;
  if (CAST_OK.test(op)) return typeof ins.arg === 'string';
  if (op === 'ldc' || op === 'ldc_w' || op === 'ldc2_w') {
    const a = ins.arg;
    if (typeof a === 'number' || typeof a === 'bigint') return true;
    return !!(a && typeof a === 'object' && !Array.isArray(a) &&
      ['Integer', 'Float', 'Long', 'Double'].includes(a.type));
  }
  if (op === 'invokestatic') {
    const [, cls, [name, desc]] = ins.arg;
    if (cls === 'java/lang/Math' && MATH_INTRINSICS.has(name)) return true;
    return cls === 'java/lang/System' && desc === '()J' &&
      (name === 'currentTimeMillis' || name === 'nanoTime');
  }
  return false;
}

// Walks the callee's normal flow from item 0. Returns the reachable item set,
// or null if the callee has a loop, an unknown branch target, or any
// reachable op the structured backend cannot emit. Instance invokes are
// admitted only when the caller may recursively splice them.
function analyzeCallee(code, maxItems, opts = {}) {
  const items = code.codeItems;
  if (!items || items.length > maxItems) return null;
  const labels = new Map();
  items.forEach((it, i) => { if (it.labelDef) labels.set(it.labelDef.slice(0, -1), i); });
  const reachable = new Set();
  const work = [0];
  while (work.length) {
    const i = work.pop();
    if (i >= items.length) return null; // fell off the end without a return
    if (reachable.has(i)) continue;
    reachable.add(i);
    const ins = items[i].instruction;
    const op = getOp(ins);
    if (!op) return null;
    if (RETURN_OP.test(op)) continue;
    if (BRANCH_OP.test(op)) {
      const target = labels.get(ins.arg);
      // backward edges would loop without a fuel check inside the caller
      if (target === undefined || target <= i) return null;
      work.push(target);
      if (op !== 'goto') work.push(i + 1);
      continue;
    }
    if (INSTANCE_INVOKE.test(op)) {
      if (!opts.instanceCalls) return null;
      work.push(i + 1);
      continue;
    }
    if (!supportedCalleeOp(op, ins)) return null;
    work.push(i + 1);
  }
  return reachable;
}

function renumberInstruction(item, base, prefix, isReachable, retLabel) {
  const ins = item.instruction;
  const op = getOp(ins);
  let m;
  if ((m = SHORT_LOCAL.exec(op))) {
    return { op: m[1] + m[2], arg: String(base + Number(m[3])) };
  }
  if (LONG_LOCAL.test(op) && ins && typeof ins === 'object') {
    return { ...ins, arg: String(base + Number(ins.arg)) };
  }
  if (op === 'iinc' && ins && typeof ins === 'object') {
    if (ins.varnum !== undefined) return { ...ins, varnum: String(base + Number(ins.varnum)) };
    if (Array.isArray(ins.arg)) {
      return { ...ins, arg: [String(base + Number(ins.arg[0])), ins.arg[1]] };
    }
    return ins;
  }
  // only REACHABLE returns become continuation gotos: rewriting a dead
  // reporter's return would add a bogus CFG edge into the continuation
  if (isReachable && RETURN_OP.test(op)) {
    return { op: 'goto', arg: retLabel };
  }
  if (BRANCH_OP.test(op) && ins && typeof ins === 'object') {
    return { ...ins, arg: `${prefix}${ins.arg}` };
  }
  return ins;
}

const STORE_OP = {
  I: 'istore', Z: 'istore', B: 'istore', C: 'istore', S: 'istore',
  J: 'lstore', F: 'fstore', D: 'dstore',
};

function paramSlotsOf(params, first) {
  const slots = [];
  let s = first;
  for (const p of params) { slots.push(s); s += (p === 'J' || p === 'D') ? 2 : 1; }
  return { slots, end: s };
}

// slot written by a local-store style instruction, or null
function storedSlot(ins, op) {
  let m;
  if ((m = SHORT_LOCAL.exec(op))) return m[2] === 'store' ? Number(m[3]) : null;
  if ((m = LONG_LOCAL.exec(op)) && m[2] === 'store' && ins && typeof ins === 'object') {
    return Number(ins.arg);
  }
  if (op === 'iinc' && ins && typeof ins === 'object') {
    if (ins.varnum !== undefined) return Number(ins.varnum);
    if (Array.isArray(ins.arg)) return Number(ins.arg[0]);
  }
  return null;
}

function planStaticInline(ctx, ins, base, maxItems) {
  const [, className, [name, descriptor]] = ins.arg;
  const cd = ctx.jvm.classes[className];
  const clsAst = cd && cd.ast && cd.ast.classes[0];
  if (!clsAst) return null;
  const methodAst = clsAst.items.filter((x) => x.type === 'method').map((x) => x.method)
    .find((mm) => mm.name === name && mm.descriptor === descriptor);
  if (!methodAst || !(methodAst.flags || []).includes('static')) return null;
  const codeAttr = methodAst.attributes && methodAst.attributes.find((a) => a.type === 'code');
  if (!codeAttr) return null;
  // Splicing foreign code must not bypass an observable class initializer —
  // the same gate findReadyStatic applies before linking.
  const hasClinit = clsAst.items.filter((x) => x.type === 'method')
    .some((x) => x.method.name === '<clinit>');
  if (hasClinit && ctx.jvm.classInitializationState.get(className) !== 'INITIALIZED') return null;
  const reachable = analyzeCallee(codeAttr.code, maxItems);
  if (!reachable) return null;
  for (const idx of reachable) {
    const it = codeAttr.code.codeItems[idx];
    const op2 = getOp(it.instruction);
    if (CAST_OK.test(op2)) {
      const target = it.instruction.arg;
      const known = target === 'java/lang/Object' || target.startsWith('[') ||
        ctx.jvm.classes[target] || ctx.jvm.jre[target];
      if (!known) return null; // backend could not build the verdict import
    }
  }

  const { params } = parseMethodDescriptor(descriptor);
  const { slots } = paramSlotsOf(params, 0);
  const prefix = `IN${ctx.k++}_`;
  const stores = [];
  for (let i = params.length - 1; i >= 0; i -= 1) {
    stores.push({ instruction: { op: STORE_OP[params[i]] || 'astore', arg: String(base + slots[i]) } });
  }
  const body = codeAttr.code.codeItems.map((item, idx) => ({
    labelDef: item.labelDef ? prefix + item.labelDef : undefined,
    instruction: renumberInstruction(item, base, prefix, reachable.has(idx), `${prefix}RET`),
  }));
  const localsSize = Number(codeAttr.code.localsSize) ||
    paramSlotsOf(params, 0).end;
  return { stores, body, prefix, localsSize };
}

// Splices one instance-call site. depth 0 = a site in the original caller
// (up to 2 impls); deeper sites are interior to a spliced body (monomorphic
// only, guard miss deopts to the outer call site).
function planInstanceSite(ctx, ins, op, callerClassName, alloc, depth) {
  if (!Array.isArray(ins.arg)) return null;
  const [, owner, [name, descriptor]] = ins.arg;
  if (name === '<init>' || name === '<clinit>') return null;
  let impls;
  let guards = null; // instanceof classes aligned with impls; null = ifnonnull only
  if (op === 'invokespecial') {
    const impl = ctx.hierarchy.resolveSpecial(callerClassName, owner, name, descriptor);
    if (!impl) return null;
    impls = [impl];
  } else {
    const r = ctx.hierarchy.resolveDispatch(owner, name, descriptor);
    // An incomplete cone hides receivers whose dispatch is unknown; an
    // instanceof guard would wrongly catch them, so only complete cones
    // qualify (the dispatch-map tier still serves incomplete ones).
    if (!r || !r.complete) return null;
    impls = [...r.impls.values()];
    if (impls.length < 1 || impls.length > (depth === 0 ? 2 : 1)) return null;
    // most-derived first, or a subtype's receivers would take the supertype
    // guard; then prove every loaded receiver lands on the guard owning it
    if (impls.length === 2 && ctx.jvm.isInstanceOf(impls[1].className, impls[0].className)) {
      impls.reverse();
    }
    for (const [recvClass, impl] of r.targets) {
      const g = impls.find((c) => ctx.jvm.isInstanceOf(recvClass, c.className));
      if (!g || g.className !== impl.className) return null;
    }
    guards = impls.map((c) => c.className);
    // enough to re-run this site's checks against a grown world later
    // (invokespecial needs no record: resolution walks the already-loaded
    // superclass chain, which later class loads cannot change)
    ctx.specSites.push({ owner, name, descriptor, guards });
  }

  const { params } = parseMethodDescriptor(descriptor);
  const start = alloc.next;
  const prefix = `IN${ctx.k++}_`;
  const { slots: argSlots } = paramSlotsOf(params, start + 1);
  // Both impl bodies overlay the SAME chunk (branches are mutually
  // exclusive), so receiver/args are stored once and slot reuse is safe.
  const bodies = [];
  let end = start;
  for (const impl of impls) {
    const sub = { next: start };
    const body = buildCalleeBody(ctx, impl, sub, `${prefix}RET`, depth);
    if (!body) return null;
    bodies.push(body);
    if (sub.next > end) end = sub.next;
  }
  alloc.next = end;
  if (guards) ctx.speculations += guards.length;

  const items = [];
  for (let j = params.length - 1; j >= 0; j -= 1) {
    items.push({ instruction: { op: STORE_OP[params[j]] || 'astore', arg: String(argSlots[j]) } });
  }
  items.push({ instruction: { op: 'astore', arg: String(start) } });
  if (guards) {
    guards.forEach((cls, gi) => {
      items.push({ instruction: { op: 'aload', arg: String(start) } });
      items.push({ instruction: { op: 'instanceof', arg: cls } });
      items.push({ instruction: { op: 'ifne', arg: `${prefix}E${gi}` } });
    });
  } else {
    items.push({ instruction: { op: 'aload', arg: String(start) } });
    items.push({ instruction: { op: 'ifnonnull', arg: `${prefix}E0` } });
  }
  items.push({ instruction: 'aconst_null', deoptMark: true });
  items.push({ instruction: 'athrow' });
  bodies.forEach((body, bi) => {
    items.push({ labelDef: `${prefix}E${bi}:`, instruction: 'nop' });
    for (const b of body.items) items.push(b);
  });
  return {
    items,
    prefix,
    valueSlots: [start, ...argSlots],
    hasHeapWrite: bodies.some((b) => b.hasHeapWrite),
  };
}

function buildCalleeBody(ctx, impl, alloc, retLabel, depth) {
  const { className, method } = impl;
  const flags = method.flags || [];
  if (flags.includes('static') || flags.includes('abstract') ||
      flags.includes('native') || flags.includes('synchronized')) return null;
  const codeAttr = method.attributes && method.attributes.find((a) => a.type === 'code');
  if (!codeAttr) return null;
  const code = codeAttr.code;
  const items = code.codeItems;
  if (!items) return null;
  const labelIndex = new Map();
  items.forEach((it, idx) => { if (it.labelDef) labelIndex.set(it.labelDef.slice(0, -1), idx); });
  // dropping the callee's table below is only sound for no-op/reporter
  // handlers — a live handler could observe the splice
  if (liveExceptionRanges(ctx.jvm, code, labelIndex).length) return null;
  const reachable = analyzeCallee(code, ctx.maxCalleeItems, {
    instanceCalls: depth + 1 < ctx.maxDepth,
  });
  if (!reachable) return null;

  const { params } = parseMethodDescriptor(method.descriptor);
  const { end: paramEnd } = paramSlotsOf(params, 1);
  let hasInterior = false;
  for (const idx of reachable) {
    const it = items[idx];
    const op = getOp(it.instruction);
    if (INSTANCE_INVOKE.test(op)) hasInterior = true;
    if (CAST_OK.test(op)) {
      const target = it.instruction.arg;
      const known = target === 'java/lang/Object' || target.startsWith('[') ||
        ctx.jvm.classes[target] || ctx.jvm.jre[target];
      if (!known) return null; // backend could not build the verdict import
    }
  }
  if (hasInterior) {
    // interior deopts rebuild [recv, args...] from this body's param slots
    for (const idx of reachable) {
      const it = items[idx];
      const slot = storedSlot(it.instruction, getOp(it.instruction));
      if (slot !== null && slot < paramEnd) return null;
    }
  }

  const base = alloc.next;
  alloc.next = base + (Number(code.localsSize) || paramEnd);
  const prefix = `IN${ctx.k++}_`;
  const out = [];
  let heapWrite = false;
  for (let idx = 0; idx < items.length; idx += 1) {
    const item = items[idx];
    const op = getOp(item.instruction);
    const lbl = item.labelDef ? prefix + item.labelDef : undefined;
    if (reachable.has(idx) && INSTANCE_INVOKE.test(op)) {
      // a deopt at (or inside) this interior site replays the flattened body
      // from the outer call — unsound once a heap write has happened
      if (heapWrite) return null;
      const site = planInstanceSite(ctx, item.instruction, op, className, alloc, depth + 1);
      if (!site) return null;
      site.items.forEach((s, si) => out.push(si === 0 && lbl ? { ...s, labelDef: lbl } : s));
      out.push({ labelDef: `${site.prefix}RET:`, instruction: 'nop' });
      if (site.hasHeapWrite) heapWrite = true;
      continue;
    }
    if (reachable.has(idx) && HEAP_WRITE.test(op)) heapWrite = true;
    out.push({
      labelDef: lbl,
      instruction: renumberInstruction(item, base, prefix, reachable.has(idx), retLabel),
    });
  }
  return { items: out, hasHeapWrite: heapWrite };
}

// Returns {items, origIdx, inlined, deoptStubs, speculations} with spliced
// callees, or null when no site qualified. options: {budget (extra items),
// maxCalleeItems, maxDepth, hierarchy, callerClassName}.
function inlineCalls(jvm, codeAttr, options = {}) {
  const items = codeAttr.code.codeItems;
  const ctx = {
    jvm,
    hierarchy: options.hierarchy || null,
    maxCalleeItems: options.maxCalleeItems || 96,
    maxDepth: options.maxDepth || 2,
    k: 0,
    speculations: 0,
    specSites: [],
  };
  let budget = options.budget || 512;
  const labelIndex = new Map();
  items.forEach((it, i) => { if (it.labelDef) labelIndex.set(it.labelDef.slice(0, -1), i); });
  const liveRanges = liveExceptionRanges(jvm, codeAttr.code, labelIndex);
  const inRange = (i) => liveRanges.some(([s, e]) => i >= s && i < e);
  const out = [];
  const origIdx = [];
  const deoptStubs = new Map();
  const alloc = { next: Number(codeAttr.code.localsSize) || 0 };
  let inlined = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const op = getOp(item.instruction);
    if (op === 'invokestatic' && budget > 0 && !inRange(i)) {
      const plan = planStaticInline(ctx, item.instruction, alloc.next, ctx.maxCalleeItems);
      if (plan && plan.stores.length + plan.body.length + 1 <= budget) {
        plan.stores.forEach((s, si) => {
          out.push(si === 0 && item.labelDef ? { ...s, labelDef: item.labelDef } : s);
          origIdx.push(si === 0 ? i : -1);
        });
        if (!plan.stores.length && item.labelDef) {
          // keep branch targets pointing at the (zero-arg) call site valid
          out.push({ labelDef: item.labelDef, instruction: 'nop' });
          origIdx.push(i);
        }
        for (const b of plan.body) { out.push(b); origIdx.push(-1); }
        out.push({ labelDef: `${plan.prefix}RET:`, instruction: 'nop' });
        origIdx.push(i + 1 < items.length ? i + 1 : -1);
        alloc.next += plan.localsSize;
        budget -= plan.stores.length + plan.body.length + 1;
        inlined += 1;
        continue;
      }
    } else if (ctx.hierarchy && INSTANCE_INVOKE.test(op) && budget > 0 && !inRange(i)) {
      const site = planInstanceSite(ctx, item.instruction, op, options.callerClassName, alloc, 0);
      if (site && site.items.length + 1 <= budget) {
        site.items.forEach((s, si) => {
          out.push(si === 0 && item.labelDef ? { ...s, labelDef: item.labelDef } : s);
          origIdx.push(si === 0 ? i : -1);
          if (s.deoptMark) {
            deoptStubs.set(out.length - 1, { resumeIdx: i, valueSlots: site.valueSlots });
          }
        });
        out.push({ labelDef: `${site.prefix}RET:`, instruction: 'nop' });
        origIdx.push(i + 1 < items.length ? i + 1 : -1);
        budget -= site.items.length + 1;
        inlined += 1;
        continue;
      }
    }
    out.push(item);
    origIdx.push(i);
  }
  if (!inlined) return null;
  return {
    items: out,
    origIdx,
    inlined,
    deoptStubs,
    speculations: ctx.speculations,
    specSites: ctx.specSites,
  };
}

// True when every recorded speculative dispatch site still holds in the
// current class world: the cone is still complete, the impl set is unchanged,
// and every loaded receiver still lands on the guard owning its impl (the
// exact plan-time checks in planInstanceSite). Lets an epoch bump from an
// unrelated class load keep the compiled module instead of recompiling it.
function revalidateSpeculations(jvm, hierarchy, specSites) {
  if (!hierarchy || !specSites) return false;
  for (const site of specSites) {
    const r = hierarchy.resolveDispatch(site.owner, site.name, site.descriptor);
    if (!r || !r.complete) return false;
    if (r.impls.size !== site.guards.length) return false;
    for (const cls of site.guards) {
      if (!r.impls.has(`${cls}.${site.name}${site.descriptor}`)) return false;
    }
    for (const [recvClass, impl] of r.targets) {
      const g = site.guards.find((c) => jvm.isInstanceOf(recvClass, c));
      if (!g || g !== impl.className) return false;
    }
  }
  return true;
}

module.exports = { inlineCalls, inlineStaticCalls: inlineCalls, revalidateSpeculations };
