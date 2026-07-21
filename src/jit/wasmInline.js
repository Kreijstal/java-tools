'use strict';

// General static-call inlining over krakatau code items, applied before CFG
// construction in the structured backend. No shape matching: any static
// callee whose NORMAL FLOW is small, loop-free, and fully emittable by the
// structured backend is spliced into the caller — argument stores replace
// the invokestatic, callee locals are renumbered above the caller's frame,
// reachable returns become gotos to a per-site continuation label. The
// callee's exception table is dropped; obfuscator reporter handlers become
// unreachable dead items (the same no-op-handler equivalence the whole wasm
// tier is built on). Sites inside the caller's live handler ranges are never
// inlined.
//
// Resume-pc mapping: each spliced item carries an original caller item index
// where the interpreter could equivalently resume — the call itself for the
// first argument store (arguments back on the operand stack, the call
// re-executes with no side effects done), the post-call index for the
// continuation label (the return value is on the operand stack). Interior
// callee items have no such pc (origIdx -1); the structured compiler retries
// without inlining if one of their blocks would need an exit stub.

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

function supportedCalleeOp(op, ins) {
  if (SHORT_LOCAL.test(op) || LONG_LOCAL.test(op) || PLAIN_OK.test(op)) return true;
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
// reachable op the structured backend cannot emit.
function analyzeCallee(code, maxItems) {
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
    if (!supportedCalleeOp(op, ins)) return null;
    work.push(i + 1);
  }
  return reachable;
}

function renumberInstruction(item, base, prefix, isReachable) {
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
    return { op: 'goto', arg: `${prefix}RET` };
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

function planInline(jvm, ins, k, base, maxItems) {
  const [, className, [name, descriptor]] = ins.arg;
  const cd = jvm.classes[className];
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
  if (hasClinit && jvm.classInitializationState.get(className) !== 'INITIALIZED') return null;
  const reachable = analyzeCallee(codeAttr.code, maxItems);
  if (!reachable) return null;

  const { params } = parseMethodDescriptor(descriptor);
  const slots = [];
  let slot = 0;
  for (const p of params) { slots.push(slot); slot += (p === 'J' || p === 'D') ? 2 : 1; }
  const prefix = `IN${k}_`;
  const stores = [];
  for (let i = params.length - 1; i >= 0; i -= 1) {
    stores.push({ instruction: { op: STORE_OP[params[i]] || 'astore', arg: String(base + slots[i]) } });
  }
  const body = codeAttr.code.codeItems.map((item, idx) => ({
    labelDef: item.labelDef ? prefix + item.labelDef : undefined,
    instruction: renumberInstruction(item, base, prefix, reachable.has(idx)),
  }));
  return { stores, body, prefix, localsSize: Number(codeAttr.code.localsSize) || slot };
}

// Returns {items, origIdx, inlined} with spliced callees, or null when no
// site qualified. options: {budget (extra items), maxCalleeItems}.
function inlineStaticCalls(jvm, codeAttr, options = {}) {
  const items = codeAttr.code.codeItems;
  const maxCalleeItems = options.maxCalleeItems || 96;
  let budget = options.budget || 512;
  const labelIndex = new Map();
  items.forEach((it, i) => { if (it.labelDef) labelIndex.set(it.labelDef.slice(0, -1), i); });
  const liveRanges = liveExceptionRanges(jvm, codeAttr.code, labelIndex);
  const inRange = (i) => liveRanges.some(([s, e]) => i >= s && i < e);
  const out = [];
  const origIdx = [];
  let base = Number(codeAttr.code.localsSize) || 0;
  let k = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (getOp(item.instruction) === 'invokestatic' && budget > 0 && !inRange(i)) {
      const plan = planInline(jvm, item.instruction, k, base, maxCalleeItems);
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
        base += plan.localsSize;
        budget -= plan.stores.length + plan.body.length + 1;
        k += 1;
        continue;
      }
    }
    out.push(item);
    origIdx.push(i);
  }
  if (!k) return null;
  return { items: out, origIdx, inlined: k };
}

module.exports = { inlineStaticCalls };
