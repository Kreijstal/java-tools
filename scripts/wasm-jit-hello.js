#!/usr/bin/env node
'use strict';

// WASM JIT hello world.
//
// Translates a small verified subset of Java bytecode (int/long arithmetic,
// locals, branches — the same shape as JitCompiler's numeric hot paths) into
// a WebAssembly module emitted by hand as binary, no toolchain. Control flow
// uses the classic switch-loop dispatcher: every basic block becomes a
// br_table target, so arbitrary goto-style bytecode maps without a relooper.
//
// Compares, for each method:
//   wasm        — the WASM translation (WebAssembly.instantiate)
//   js-hand     — idiomatic hand-written JS (upper bound for any JS codegen)
//   js-jitshape — faithful replica of what JitCompiler.compileMethod evals
//                 today: AsyncFunction, switch(pc) per instruction, array
//                 operand stack, materialize after every instruction
//                 (longs done with BigInt, as any JS backend must)
//
// Usage: node scripts/wasm-jit-hello.js <path/to/HotKernel.class>

const { loadClassByPathSync } = require('../src/core/classLoader');

// ---------------------------------------------------------------------------
// binary emission helpers
// ---------------------------------------------------------------------------

function uleb(n) {
  n = Number(n);
  const out = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function sleb(value) {
  let n = BigInt(value);
  const out = [];
  for (;;) {
    const b = Number(n & 0x7fn);
    n >>= 7n;
    const signBit = (b & 0x40) !== 0;
    if ((n === 0n && !signBit) || (n === -1n && signBit)) {
      out.push(b);
      break;
    }
    out.push(b | 0x80);
  }
  return out;
}

const I32 = 0x7f;
const I64 = 0x7e;
const OP = {
  unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, end: 0x0b,
  br: 0x0c, br_table: 0x0e, return: 0x0f,
  local_get: 0x20, local_set: 0x21,
  i32_const: 0x41, i64_const: 0x42,
  i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48, i32_gt_s: 0x4a,
  i32_le_s: 0x4c, i32_ge_s: 0x4e,
  i64_lt_s: 0x53, i64_gt_s: 0x55,
  i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_div_s: 0x6d, i32_rem_s: 0x6f,
  i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
  i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e,
  i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85, i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88,
  i32_wrap_i64: 0xa7, i64_extend_i32_s: 0xac,
};

// ---------------------------------------------------------------------------
// Java bytecode -> wasm function translation
// ---------------------------------------------------------------------------

function getOp(ins) { return typeof ins === 'string' ? ins : ins.op; }

const BRANCH_COND = {
  if_icmpeq: OP.i32_eq, if_icmpne: OP.i32_ne, if_icmplt: OP.i32_lt_s,
  if_icmpge: OP.i32_ge_s, if_icmpgt: OP.i32_gt_s, if_icmple: OP.i32_le_s,
};
const BRANCH_ZERO = {
  ifeq: OP.i32_eq, ifne: OP.i32_ne, iflt: OP.i32_lt_s,
  ifge: OP.i32_ge_s, ifgt: OP.i32_gt_s, ifle: OP.i32_le_s,
};
const INT_ARITH = {
  iadd: OP.i32_add, isub: OP.i32_sub, imul: OP.i32_mul,
  iand: OP.i32_and, ior: OP.i32_or, ixor: OP.i32_xor,
  ishl: OP.i32_shl, ishr: OP.i32_shr_s, iushr: OP.i32_shr_u,
};
const LONG_ARITH = {
  ladd: OP.i64_add, lsub: OP.i64_sub, lmul: OP.i64_mul,
  land: OP.i64_and, lor: OP.i64_or, lxor: OP.i64_xor,
};
const LONG_SHIFT = { lshl: OP.i64_shl, lshr: OP.i64_shr_s, lushr: OP.i64_shr_u };
const ICONST = {
  iconst_m1: -1, iconst_0: 0, iconst_1: 1, iconst_2: 2,
  iconst_3: 3, iconst_4: 4, iconst_5: 5,
};
const LCONST = { lconst_0: 0n, lconst_1: 1n };

function parseDescriptor(descriptor) {
  const m = /^\(([IJ]*)\)([IJ])$/.exec(descriptor);
  if (!m) throw new Error(`unsupported descriptor ${descriptor} (int/long scalars only)`);
  return { params: [...m[1]], ret: m[2] };
}

// slot -> 'I' | 'J', from parameter list + load/store usage
function inferSlotTypes(items, params) {
  const slots = new Map();
  let slot = 0;
  for (const p of params) {
    slots.set(slot, p);
    slot += p === 'J' ? 2 : 1;
  }
  const claim = (s, t) => {
    const prev = slots.get(s);
    if (prev && prev !== t) throw new Error(`slot ${s} used as both ${prev} and ${t}`);
    slots.set(s, t);
  };
  for (const item of items) {
    if (!item.instruction) continue;
    const op = getOp(item.instruction);
    let m;
    if ((m = /^([il])(?:load|store)(?:_(\d))?$/.exec(op))) {
      const s = m[2] !== undefined ? Number(m[2]) : Number(item.instruction.arg);
      claim(s, m[1] === 'l' ? 'J' : 'I');
    } else if (op === 'iinc') {
      claim(Number(item.instruction.varnum), 'I');
    }
  }
  return slots;
}

function translateToWasm(method) {
  const code = method.attributes.find((a) => a.type === 'code').code;
  const items = code.codeItems;
  const { params, ret } = parseDescriptor(method.descriptor);

  const labelIndex = new Map();
  items.forEach((it, i) => {
    if (it.labelDef) labelIndex.set(it.labelDef.slice(0, -1), i);
  });
  const targetOf = (ins) => {
    const idx = labelIndex.get(ins.arg);
    if (idx === undefined) throw new Error(`unknown label ${ins.arg}`);
    return idx;
  };

  // basic-block leaders
  const leaders = new Set([0]);
  items.forEach((it, i) => {
    if (!it.instruction) return;
    const op = getOp(it.instruction);
    if (op === 'goto' || BRANCH_COND[op] || BRANCH_ZERO[op]) {
      leaders.add(targetOf(it.instruction));
      if (i + 1 < items.length) leaders.add(i + 1);
    }
  });
  const blockStarts = [...leaders].sort((a, b) => a - b);
  const blockOfItem = new Map();
  blockStarts.forEach((start, blk) => blockOfItem.set(start, blk));
  const blockOfTarget = (itemIndex) => {
    const blk = blockOfItem.get(itemIndex);
    if (blk === undefined) throw new Error(`branch into middle of block at item ${itemIndex}`);
    return blk;
  };
  const N = blockStarts.length;

  // java slot -> wasm local
  const slotTypes = inferSlotTypes(items, params);
  const slotToLocal = new Map();
  let nextLocal = 0;
  let slot = 0;
  for (const p of params) {
    slotToLocal.set(slot, nextLocal++);
    slot += p === 'J' ? 2 : 1;
  }
  const declared = []; // [type] per extra local, in index order
  const paramSlotCount = slot;
  const extraSlots = [...slotTypes.keys()].filter((s) => s >= paramSlotCount).sort((a, b) => a - b);
  for (const s of extraSlots) {
    slotToLocal.set(s, nextLocal++);
    declared.push(slotTypes.get(s) === 'J' ? I64 : I32);
  }
  const blkLocal = nextLocal++;
  declared.push(I32);
  // scratch pair for lcmp
  const scratchA = nextLocal++;
  const scratchB = nextLocal++;
  declared.push(I64, I64);

  const localOf = (s) => {
    const l = slotToLocal.get(s);
    if (l === undefined) throw new Error(`untyped local slot ${s}`);
    return l;
  };

  // code emission
  const body = [];
  const emit = (...bytes) => body.push(...bytes);
  const emitConstI32 = (v) => emit(OP.i32_const, ...sleb(v));
  const emitJump = (blk, depthToTop) => {
    emitConstI32(blk);
    emit(OP.local_set, ...uleb(blkLocal));
    emit(OP.br, ...uleb(depthToTop));
  };

  emit(OP.loop, 0x40);
  for (let i = 0; i < N; i++) emit(OP.block, 0x40); // $d0 innermost
  emit(OP.local_get, ...uleb(blkLocal));
  emit(OP.br_table, ...uleb(N));
  for (let i = 0; i < N; i++) emit(...uleb(i));
  emit(...uleb(N - 1)); // default (blk is always in range)

  for (let blk = 0; blk < N; blk++) {
    emit(OP.end); // close landing block for this region
    const depthToTop = N - 1 - blk; // br depth of the loop from region code
    const from = blockStarts[blk];
    const to = blk + 1 < N ? blockStarts[blk + 1] : items.length;
    for (let i = from; i < to; i++) {
      const ins = items[i].instruction;
      if (!ins) continue;
      const op = getOp(ins);
      const localArg = (fallback) => {
        const m = /_(\d)$/.exec(op);
        return Number(m ? m[1] : ins.arg ?? fallback);
      };
      if (op in ICONST) {
        emitConstI32(ICONST[op]);
      } else if (op in LCONST) {
        emit(OP.i64_const, ...sleb(LCONST[op]));
      } else if (op === 'bipush' || op === 'sipush') {
        emitConstI32(Number(ins.arg));
      } else if (op === 'ldc' && typeof ins.arg !== 'string') {
        emitConstI32(Number(ins.arg));
      } else if (op === 'ldc2_w' && typeof ins.arg === 'bigint') {
        emit(OP.i64_const, ...sleb(ins.arg));
      } else if (/^[il]load(_\d)?$/.test(op)) {
        emit(OP.local_get, ...uleb(localOf(localArg())));
      } else if (/^[il]store(_\d)?$/.test(op)) {
        emit(OP.local_set, ...uleb(localOf(localArg())));
      } else if (op === 'iinc') {
        const l = localOf(Number(ins.varnum));
        emit(OP.local_get, ...uleb(l));
        emitConstI32(Number(ins.incr));
        emit(OP.i32_add, OP.local_set, ...uleb(l));
      } else if (op in INT_ARITH) {
        emit(INT_ARITH[op]);
      } else if (op in LONG_ARITH) {
        emit(LONG_ARITH[op]);
      } else if (op in LONG_SHIFT) {
        emit(OP.i64_extend_i32_s, LONG_SHIFT[op]); // shift count is int in Java
      } else if (op === 'ineg') {
        emitConstI32(-1);
        emit(OP.i32_mul);
      } else if (op === 'i2l') {
        emit(OP.i64_extend_i32_s);
      } else if (op === 'l2i') {
        emit(OP.i32_wrap_i64);
      } else if (op === 'lcmp') {
        emit(OP.local_set, ...uleb(scratchB), OP.local_set, ...uleb(scratchA));
        emit(OP.local_get, ...uleb(scratchA), OP.local_get, ...uleb(scratchB), OP.i64_gt_s);
        emit(OP.local_get, ...uleb(scratchA), OP.local_get, ...uleb(scratchB), OP.i64_lt_s);
        emit(OP.i32_sub);
      } else if (BRANCH_COND[op] || BRANCH_ZERO[op]) {
        if (BRANCH_ZERO[op]) emitConstI32(0);
        emit(BRANCH_COND[op] || BRANCH_ZERO[op]);
        emit(OP.if, 0x40);
        emitJump(blockOfTarget(targetOf(ins)), depthToTop + 1);
        emit(OP.end);
      } else if (op === 'goto') {
        emitJump(blockOfTarget(targetOf(ins)), depthToTop);
      } else if (op === 'ireturn' || op === 'lreturn') {
        emit(OP.return);
      } else {
        throw new Error(`unsupported opcode ${op}`);
      }
    }
  }
  emit(OP.end);          // loop
  emit(OP.unreachable);  // loop fell through without return
  emit(OP.end);          // function body

  // module assembly
  const valType = (t) => (t === 'J' ? I64 : I32);
  const funcType = [0x60, ...uleb(params.length), ...params.map(valType), 1, valType(ret)];
  const localDecls = [...uleb(declared.length), ...declared.flatMap((t) => [1, t])];
  const funcBody = [...localDecls, ...body];
  const section = (id, content) => [id, ...uleb(content.length), ...content];
  const nameBytes = [...'run'].map((c) => c.charCodeAt(0));
  const bytes = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, ...funcType]),
    ...section(3, [1, 0]),
    ...section(7, [1, nameBytes.length, ...nameBytes, 0x00, 0]),
    ...section(10, [1, ...uleb(funcBody.length), ...funcBody]),
  ]);
  return { bytes, blocks: N };
}

// ---------------------------------------------------------------------------
// replica of the current JitCompiler output shape (AsyncFunction, switch(pc),
// array stack, materialize per instruction), with BigInt longs added
// ---------------------------------------------------------------------------

function buildJitShapeSource(method) {
  const code = method.attributes.find((a) => a.type === 'code').code;
  const items = code.codeItems;
  const labelIndex = new Map();
  items.forEach((it, i) => {
    if (it.labelDef) labelIndex.set(it.labelDef.slice(0, -1), i);
  });
  const t = (ins) => labelIndex.get(ins.arg);

  const lines = [
    '"use strict";',
    'const locals = frame.locals;',
    'const stack = frame.stack.items;',
    'let pc = frame.pc;',
    'let bytecodesUntilYield = 100000;',
    `while (pc < ${items.length}) {`,
    'if (--bytecodesUntilYield === 0) { helpers.materialize(frame, locals, stack, pc); await helpers.cooperativeYield(); bytecodesUntilYield = 100000; }',
    'switch (pc) {',
  ];
  items.forEach((item, index) => {
    lines.push(`case ${index}:`);
    const ins = item.instruction;
    if (!ins) { lines.push(`pc = ${index + 1}; break;`); return; }
    lines.push(`helpers.materialize(frame, locals, stack, ${index});`);
    const op = getOp(ins);
    const next = `pc = ${index + 1}; break;`;
    const localArg = () => {
      const m = /_(\d)$/.exec(op);
      return Number(m ? m[1] : ins.arg);
    };
    if (op in ICONST) lines.push(`stack.push(${ICONST[op]}); ${next}`);
    else if (op in LCONST) lines.push(`stack.push(${LCONST[op]}n); ${next}`);
    else if (op === 'bipush' || op === 'sipush') lines.push(`stack.push(${Number(ins.arg)}); ${next}`);
    else if (op === 'ldc2_w') lines.push(`stack.push(${ins.arg}n); ${next}`);
    else if (/^[il]load(_\d)?$/.test(op)) lines.push(`stack.push(locals[${localArg()}]); ${next}`);
    else if (/^[il]store(_\d)?$/.test(op)) lines.push(`locals[${localArg()}] = stack.pop(); ${next}`);
    else if (op === 'iinc') lines.push(`locals[${Number(ins.varnum)}] = (locals[${Number(ins.varnum)}] + ${Number(ins.incr)}) | 0; ${next}`);
    else if (op === 'iadd') lines.push(`stack.push((stack.pop() + stack.pop()) | 0); ${next}`);
    else if (op === 'isub') lines.push(`{ const b = stack.pop(); const a = stack.pop(); stack.push((a - b) | 0); } ${next}`);
    else if (op === 'imul') lines.push(`stack.push(Math.imul(stack.pop(), stack.pop())); ${next}`);
    else if (op === 'ishr') lines.push(`{ const sh = stack.pop(); stack.push(stack.pop() >> (sh & 31)); } ${next}`);
    else if (op === 'i2l') lines.push(`stack.push(BigInt(stack.pop())); ${next}`);
    else if (op === 'lxor') lines.push(`{ const b = stack.pop(); const a = stack.pop(); stack.push(BigInt.asIntN(64, a ^ b)); } ${next}`);
    else if (op === 'lmul') lines.push(`{ const b = stack.pop(); const a = stack.pop(); stack.push(BigInt.asIntN(64, a * b)); } ${next}`);
    else if (op === 'lushr') lines.push(`{ const sh = BigInt(stack.pop() & 63); const a = stack.pop(); stack.push(BigInt.asIntN(64, BigInt.asUintN(64, a) >> sh)); } ${next}`);
    else if (BRANCH_COND[op]) {
      const js = { if_icmpeq: '===', if_icmpne: '!==', if_icmplt: '<', if_icmpge: '>=', if_icmpgt: '>', if_icmple: '<=' }[op];
      lines.push(`{ const b = stack.pop(); const a = stack.pop(); pc = (a ${js} b) ? ${t(ins)} : ${index + 1}; } break;`);
    } else if (op === 'goto') lines.push(`pc = ${t(ins)}; break;`);
    else if (op === 'ireturn' || op === 'lreturn') lines.push('return stack.pop();');
    else throw new Error(`jitshape: unsupported opcode ${op}`);
  });
  lines.push('default: throw new Error("bad pc " + pc);');
  lines.push('} }');
  return lines.join('\n');
}

function instantiateJitShape(method) {
  const AsyncFunction = Object.getPrototypeOf(async function p() {}).constructor;
  const fn = new AsyncFunction('frame', 'thread', 'helpers', buildJitShapeSource(method));
  const helpers = {
    materialize(frame, locals, stack, pc) { frame.pc = pc; },
    cooperativeYield: () => new Promise((resolve) => setImmediate(resolve)),
  };
  return async (n, longSlots) => {
    const frame = { locals: [n, 0, 0, 0], stack: { items: [] }, pc: 0 };
    if (longSlots) frame.locals = [n, 0n, 0, 0]; // slot1 holds the long
    return fn(frame, null, helpers);
  };
}

// ---------------------------------------------------------------------------
// hand-written idiomatic JS references
// ---------------------------------------------------------------------------

/* eslint-disable no-new-func */
const sumIntJS = new Function('n', `
  "use strict";
  n = n | 0; let s = 0;
  for (let i = 0; i < n; i = (i + 1) | 0) {
    s = (((s + Math.imul(i, 3)) | 0) - (s >> 2)) | 0;
  }
  return s | 0;
`);
const mixLongJS = new Function('n', `
  "use strict";
  n = n | 0;
  let h = BigInt.asUintN(64, 0x9E3779B97F4A7C15n);
  const M = 0xFFFFFFFFFFFFFFFFn, C = 0x100000001B3n;
  for (let i = 0; i < n; i = (i + 1) | 0) {
    h ^= BigInt(i);
    h = (h * C) & M;
    h ^= h >> 29n;
  }
  return BigInt.asIntN(64, h);
`);

// ---------------------------------------------------------------------------
// benchmarks
// ---------------------------------------------------------------------------

function bench(label, iters, fn) {
  fn(); // warmup
  fn();
  const t0 = process.hrtime.bigint();
  const result = fn();
  const t1 = process.hrtime.bigint();
  const nsPerIter = Number(t1 - t0) / iters;
  console.log(`  ${label.padEnd(34)} ${String(result).padStart(22)}  ${nsPerIter.toFixed(2).padStart(9)} ns/iter`);
  return nsPerIter;
}

async function benchAsync(label, iters, fn) {
  await fn();
  await fn();
  const t0 = process.hrtime.bigint();
  const result = await fn();
  const t1 = process.hrtime.bigint();
  const nsPerIter = Number(t1 - t0) / iters;
  console.log(`  ${label.padEnd(34)} ${String(result).padStart(22)}  ${nsPerIter.toFixed(2).padStart(9)} ns/iter`);
  return nsPerIter;
}

async function main() {
  const classPath = process.argv[2];
  if (!classPath) {
    console.error('usage: node scripts/wasm-jit-hello.js <HotKernel.class>');
    process.exit(1);
  }
  const cls = loadClassByPathSync(classPath).classes[0];
  const methods = cls.items.filter((i) => i.type === 'method').map((i) => i.method);
  const sumInt = methods.find((m) => m.name === 'sumInt');
  const mixLong = methods.find((m) => m.name === 'mixLong');

  // --- compile both tiers, measuring one-time cost -------------------------
  console.log('== compile overhead (one-time, per method) ==');
  for (const [name, method] of [['sumInt', sumInt], ['mixLong', mixLong]]) {
    let t0 = process.hrtime.bigint();
    const { bytes, blocks } = translateToWasm(method);
    const tTranslate = Number(process.hrtime.bigint() - t0) / 1e3;
    t0 = process.hrtime.bigint();
    const module = new WebAssembly.Module(bytes);
    const tCompile = Number(process.hrtime.bigint() - t0) / 1e3;
    t0 = process.hrtime.bigint();
    const instance = new WebAssembly.Instance(module, {});
    const tInstantiate = Number(process.hrtime.bigint() - t0) / 1e3;

    t0 = process.hrtime.bigint();
    const src = buildJitShapeSource(method);
    const AsyncFunction = Object.getPrototypeOf(async function p() {}).constructor;
    new AsyncFunction('frame', 'thread', 'helpers', src);
    const tJs = Number(process.hrtime.bigint() - t0) / 1e3;
    console.log(`  ${name}: wasm ${bytes.length}B/${blocks} blocks — translate ${tTranslate.toFixed(0)}µs, Module ${tCompile.toFixed(0)}µs, Instance ${tInstantiate.toFixed(0)}µs | JS source+AsyncFunction ${tJs.toFixed(0)}µs`);
  }

  const wasmSum = new WebAssembly.Instance(new WebAssembly.Module(translateToWasm(sumInt).bytes), {}).exports.run;
  const wasmMix = new WebAssembly.Instance(new WebAssembly.Module(translateToWasm(mixLong).bytes), {}).exports.run;
  const jitSum = instantiateJitShape(sumInt);
  const jitMix = instantiateJitShape(mixLong);

  // --- correctness ----------------------------------------------------------
  console.log('\n== correctness vs real java (n=1000000) ==');
  const JAVA_SUM = 11999955;                    // from: java HotKernel 1000000
  const JAVA_MIX = -526828992450466696n;
  const n = 1000000;
  const checks = [
    ['wasm sumInt', wasmSum(n), JAVA_SUM],
    ['js-hand sumInt', sumIntJS(n), JAVA_SUM],
    ['js-jitshape sumInt', await jitSum(n), JAVA_SUM],
    ['wasm mixLong', wasmMix(n), JAVA_MIX],
    ['js-hand mixLong', mixLongJS(n), JAVA_MIX],
    ['js-jitshape mixLong', await jitMix(n, true), JAVA_MIX],
  ];
  let ok = true;
  for (const [label, got, want] of checks) {
    const pass = got === want || BigInt(got) === BigInt(want);
    if (!pass) ok = false;
    console.log(`  ${label.padEnd(24)} ${pass ? 'OK' : `MISMATCH got=${got} want=${want}`}`);
  }
  if (!ok) process.exit(2);

  // --- throughput -----------------------------------------------------------
  const NI = 50_000_000;
  console.log(`\n== throughput: sumInt, int32 loop (n=${NI.toLocaleString('en')}) ==`);
  const wI = bench('wasm', NI, () => wasmSum(NI));
  const hI = bench('js-hand (upper bound)', NI, () => sumIntJS(NI));
  const NIJ = 2_000_000;
  const jI = await benchAsync(`js-jitshape (n=${NIJ.toLocaleString('en')})`, NIJ, () => jitSum(NIJ));

  const NL = 5_000_000;
  console.log(`\n== throughput: mixLong, 64-bit loop (n=${NL.toLocaleString('en')}) ==`);
  const wL = bench('wasm (native i64)', NL, () => wasmMix(NL));
  const hL = bench('js-hand (BigInt)', NL, () => mixLongJS(NL));
  const NLJ = 1_000_000;
  const jL = await benchAsync(`js-jitshape (BigInt, n=${NLJ.toLocaleString('en')})`, NLJ, () => jitMix(NLJ, true));

  // --- call overhead (boundary cost, n=1) -----------------------------------
  const CALLS = 2_000_000;
  console.log(`\n== call overhead (n=1, ${CALLS.toLocaleString('en')} calls) ==`);
  bench('wasm sumInt (i32 boundary)', CALLS, () => { let x = 0; for (let i = 0; i < CALLS; i++) x = wasmSum(1); return x; });
  bench('js-hand sumInt', CALLS, () => { let x = 0; for (let i = 0; i < CALLS; i++) x = sumIntJS(1); return x; });
  bench('wasm mixLong (BigInt boundary)', CALLS, () => { let x = 0n; for (let i = 0; i < CALLS; i++) x = wasmMix(1); return x; });
  bench('js-hand mixLong', CALLS, () => { let x = 0n; for (let i = 0; i < CALLS; i++) x = mixLongJS(1); return x; });

  console.log('\n== summary ==');
  console.log(`  int loop:  wasm ${wI.toFixed(2)} ns/iter vs hand-JS ${hI.toFixed(2)} vs current-JIT-shape ${jI.toFixed(2)} (${(jI / wI).toFixed(0)}x)`);
  console.log(`  long loop: wasm ${wL.toFixed(2)} ns/iter vs BigInt-JS ${hL.toFixed(2)} (${(hL / wL).toFixed(1)}x) vs current-JIT-shape ${jL.toFixed(2)} (${(jL / wL).toFixed(0)}x)`);
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(1); });
