'use strict';

// Shared typed SSA IR over the structurer's CFG. One builder for every
// consumer (wasm tiers, JS tier, decompiler): blocks are the structurer's
// blocks, values are typed SSA defs, locals are SSA (phis at joins), the
// operand stack is symbolic. Exception handlers are supported opaquely:
// a handler block starts from a caught_exception value and fresh opaque
// handler_local defs — no SSA facts flow across the throw edge in v1.
//
// buildSsa(...) never throws on unsupported input; it returns
// { rejected: <reason> } so tier ladders can fall back cheaply.

const { buildCfgFromCode } = require('../../decompiler/structurer');
const {
  kindedStackEffect,
  normalizeInstruction,
  parseLocalOperation,
} = require('./stackEffects');
const {
  CONFLICT,
  kindWidth,
  kindFromDescriptor,
  paramKindsFromMethodDescriptor,
  mergeKind,
} = require('./ssaTypes');

const LETTER_KIND = { i: 'I', l: 'J', f: 'F', d: 'D', a: 'A' };
const LOCAL_LOAD = /^[ilfda]load$/;
const LOCAL_STORE = /^[ilfda]store$/;

// Krakatau renders wide-prefixed instructions as {op:'wide', arg:'iinc 8 128'}
// (inner mnemonic + operands in one string); unwrap to the inner form.
function unwrapWide(instruction) {
  if (!instruction || instruction.op !== 'wide' || typeof instruction.arg !== 'string') {
    return instruction;
  }
  const [innerOp, ...operands] = instruction.arg.trim().split(/\s+/);
  if (innerOp === 'iinc') return { op: 'iinc', arg: [operands[0], operands[1]] };
  return { op: innerOp, arg: operands[0] };
}

// Krakatau emits iinc as {op, varnum, incr}; assembled/synthetic forms may
// use arg pairs instead.
function iincOperands(instruction) {
  if (instruction.varnum !== undefined) {
    return { slot: Number(instruction.varnum), delta: Number(instruction.incr) };
  }
  const arg = Array.isArray(instruction.arg) ? instruction.arg : [instruction.arg, 1];
  return { slot: Number(arg[0]), delta: Number(arg[1]) };
}

// parseLocalOperation parses ANY op with an index-like arg (ldc included);
// only accept real local load/store bases here.
function localOperation(normalized, original) {
  const parsed = parseLocalOperation(normalized, original);
  if (!parsed || !Number.isInteger(parsed.index) || parsed.index < 0) return null;
  if (LOCAL_LOAD.test(parsed.base)) return { ...parsed, isLoad: true };
  if (LOCAL_STORE.test(parsed.base)) return { ...parsed, isLoad: false };
  return null;
}

class Rejection {
  constructor(reason) { this.reason = reason; }
}

class IrValue {
  constructor(id, op, kind, args = [], imm = null) {
    this.id = id;
    this.op = op;            // bytecode op, or 'param'|'phi'|'undef'|'caught_exception'|'handler_local'|'iinc'
    this.kind = kind;        // I/J/F/D/A/V, CONFLICT, or null (opaque, not yet imposed)
    this.args = args;        // IrValue refs (phi args aligned to block.predIds)
    this.imm = imm;          // op-specific immediate (instruction arg, slot, …)
    this.block = null;
    this.itemIdx = null;
    this.pc = null;
    this.effects = null;     // { mayThrow } for effectful body nodes
    this.origin = null;      // phis: { slot } | { stackDepth }
    this.uses = [];
  }
}

class IrBlock {
  constructor(id) {
    this.id = id;
    this.phis = [];
    this.body = [];          // pinned order: every value/effect node created in this block
    this.entryStack = [];    // IrValues on the operand stack at entry
    this.exitStack = null;   // IrValues at exit (same for every successor edge)
    this.slotDefsOut = null; // Map slot -> IrValue reaching the block end (frame materialization)
    this.term = null;        // structurer term + { insnOp, args: [IrValue] }
    this.predIds = [];       // dedup'd reachable predecessors, ascending id (phi arg order)
    this.isHandlerEntry = false;
    this.handlers = [];      // exception entries protecting instructions in this block
  }
}

function buildSsa(input, options = {}) {
  try {
    return buildSsaOrThrow(input, options);
  } catch (error) {
    if (error instanceof Rejection) return { rejected: error.reason };
    throw error;
  }
}

function reject(reason) { throw new Rejection(reason); }

function buildSsaOrThrow(input, options) {
  const items = Array.isArray(input && input.codeItems) ? input.codeItems : [];
  const exceptionTable = (input && input.exceptionTable) || [];
  const method = input && input.method;

  const labelToItem = new Map();
  const pcToItem = new Map();
  items.forEach((item, index) => {
    if (item && item.labelDef) labelToItem.set(trim(item.labelDef), index);
    if (item && typeof item.pc === 'number') pcToItem.set(item.pc, index);
  });

  const handlerEntries = resolveHandlers(exceptionTable, labelToItem, pcToItem);

  const cfg = options.cfg || buildCfgFromCode(
    items,
    handlerEntries.map((h) => h.handlerLabel).filter(Boolean),
    handlerEntries.flatMap((h) => [h.handlerPc, h.startPc, h.endPc]).filter((pc) => pc != null),
  );
  if (!cfg) reject('empty or malformed code');

  const blockOfItem = new Map();
  cfg.blocks.forEach((block, id) => {
    for (const itemIdx of block.insns) blockOfItem.set(itemIdx, id);
  });

  const handlerBlocks = new Map(); // blockId -> [handler entries]
  for (const handler of handlerEntries) {
    const blockId = blockOfItem.get(handler.handlerItemIdx);
    if (blockId === undefined) reject('exception handler outside instruction stream');
    if (cfg.blocks[blockId].insns[0] !== handler.handlerItemIdx) {
      reject('exception handler entry is not a block leader');
    }
    if (!handlerBlocks.has(blockId)) handlerBlocks.set(blockId, []);
    handlerBlocks.get(blockId).push(handler);
  }

  const roots = [cfg.entry, ...handlerBlocks.keys()];
  const reachable = findReachable(cfg, roots);
  const preds = computePreds(cfg, reachable);
  for (const blockId of handlerBlocks.keys()) {
    if ((preds[blockId] || []).length > 0) reject('exception handler is also a normal branch target');
  }

  const rpo = reversePostorder(cfg, roots, reachable);
  const rpoIndex = new Map(rpo.map((blockId, index) => [blockId, index]));

  // Phase A: entry-stack kind shapes. Kinds either agree at joins or the
  // bytecode is invalid — no lattice iteration needed, one pass + checks.
  const entryShapes = computeEntryShapes(cfg, items, rpo, preds, handlerBlocks);

  const { paramValues, paramSlots, localsSize } = layoutParams(method, items);

  const fn = {
    method: method || null,
    cfg,
    entry: cfg.entry,
    blocks: [],
    values: [...paramValues],
    params: paramValues,
    localsSize,
    reachable,
    depthBefore: new Map(), // itemIdx -> operand slots before the instruction (op02 differential)
    facts: options.facts || null,
    handlerEntries,
  };
  let nextId = paramValues.length;
  const makeValue = (op, kind, args = [], imm = null) => {
    const value = new IrValue(nextId++, op, kind, args, imm);
    fn.values.push(value);
    return value;
  };

  const blocks = cfg.blocks.map((_, id) => new IrBlock(id));
  fn.blocks = blocks;
  for (const [blockId, list] of handlerBlocks) {
    blocks[blockId].isHandlerEntry = true;
    blocks[blockId].handlers = list;
  }
  for (let id = 0; id < cfg.n; id += 1) blocks[id].predIds = (preds[id] || []).slice();

  const isJoin = (blockId) => blocks[blockId].predIds.length >= 2
    || (blockId === cfg.entry && blocks[blockId].predIds.length >= 1);

  // Pre-create entry values for every reachable block.
  const entryLocals = new Map(); // blockId -> Map(slot -> IrValue)
  for (const blockId of rpo) {
    const block = blocks[blockId];
    if (block.isHandlerEntry) {
      const caught = makeValue('caught_exception', 'A');
      caught.block = blockId;
      block.entryStack = [caught];
      block.body.push(caught);
      const locals = new Map();
      for (let slot = 0; slot < localsSize; slot += 1) {
        const opaque = makeValue('handler_local', null, [], { slot });
        opaque.block = blockId;
        locals.set(slot, opaque);
      }
      entryLocals.set(blockId, locals);
    } else if (blockId === cfg.entry && block.predIds.length === 0) {
      block.entryStack = [];
      const locals = new Map();
      paramValues.forEach((param, index) => locals.set(paramSlots[index], param));
      entryLocals.set(blockId, locals);
    } else if (isJoin(blockId)) {
      const shape = entryShapes.get(blockId) || [];
      block.entryStack = shape.map((kind, depth) => {
        const phi = makeValue('phi', kind);
        phi.block = blockId;
        phi.origin = { stackDepth: depth };
        block.phis.push(phi);
        return phi;
      });
      const locals = new Map();
      for (let slot = 0; slot < localsSize; slot += 1) {
        const phi = makeValue('phi', null, [], { slot });
        phi.block = blockId;
        phi.origin = { slot };
        block.phis.push(phi);
        locals.set(slot, phi);
      }
      if (blockId === cfg.entry) {
        // Loop back to the method entry: parameters join with the back edge.
        block.entryParamSeed = new Map();
        paramValues.forEach((param, index) => block.entryParamSeed.set(paramSlots[index], param));
      }
      entryLocals.set(blockId, locals);
    }
    // Single-pred blocks inherit at simulation time.
  }

  // Phase B: simulate each block over IrValues.
  for (const blockId of rpo) {
    const block = blocks[blockId];
    let stack;
    let locals;
    if (entryLocals.has(blockId)) {
      stack = block.entryStack.slice();
      locals = new Map(entryLocals.get(blockId));
    } else {
      const predId = block.predIds[0];
      const pred = blocks[predId];
      if (pred.exitStack === null) reject('predecessor not simulated before successor');
      stack = pred.exitStack.slice();
      locals = new Map(pred.slotDefsOut);
      block.entryStack = stack.slice();
    }
    block.slotDefsIn = new Map(locals);

    simulateBlock({
      fn, cfg, items, block, stack, locals, makeValue, imposeKind,
    });
  }

  fillPhiArgs(blocks, rpo, isJoin, makeValue, paramSlots);
  pruneTrivialPhis(fn);
  recordUses(fn);

  return fn;
}

function imposeKind(value, kind, what) {
  if (value.kind === null) { value.kind = kind; return; }
  if (value.kind === kind) return;
  if (value.kind === CONFLICT) reject(`${what} reads a kind-conflicted slot`);
  reject(`${what} expects ${kind} but value ${value.id} is ${value.kind}`);
}

function simulateBlock(context) {
  const { fn, cfg, items, block, stack, locals, makeValue } = context;
  const blockId = block.id;

  const popValues = (slots, what) => {
    const popped = [];
    let remaining = slots;
    while (remaining > 0) {
      const value = stack.pop();
      if (!value) reject(`stack underflow at ${what}`);
      const width = kindWidth(value.kind) || 1;
      if (width > remaining) reject(`wide value split at ${what}`);
      popped.push(value);
      remaining -= width;
    }
    return popped.reverse(); // argument order, deepest first
  };

  for (const itemIdx of cfg.blocks[blockId].insns) {
    const item = items[itemIdx];
    const instruction = unwrapWide(normalizeInstruction(item.instruction));
    const op = instruction && instruction.op;
    if (!op) continue;
    fn.depthBefore.set(itemIdx, stack.reduce((total, v) => total + (kindWidth(v.kind) || 1), 0));

    const local = localOperation(instruction, instruction);
    if (local && local.isLoad) {
      const kind = LETTER_KIND[local.base[0]];
      const value = locals.get(local.index);
      if (!value || value.op === 'undef') reject(`load of undefined local ${local.index}`);
      imposeKind(value, kind, op);
      stack.push(value);
      continue;
    }
    if (local && !local.isLoad) {
      const kind = LETTER_KIND[local.base[0]];
      const [value] = popValues(kindWidth(kind), op);
      imposeKind(value, kind, op);
      locals.set(local.index, value);
      if (kindWidth(kind) === 2) locals.delete(local.index + 1);
      continue;
    }
    if (op === 'iinc') {
      const { slot, delta } = iincOperands(instruction);
      if (!Number.isInteger(slot)) reject('unparseable iinc');
      const previous = locals.get(slot);
      if (!previous || previous.op === 'undef') reject('iinc of undefined local');
      imposeKind(previous, 'I', op);
      const value = makeValue('iinc', 'I', [previous], { slot, delta });
      annotate(value, blockId, itemIdx, item);
      block.body.push(value);
      locals.set(slot, value);
      continue;
    }

    const effect = kindedStackEffect(op, instruction);
    if (!effect) reject(`unsupported opcode ${op}`);

    if (effect.special) {
      applySpecial(stack, effect.special, op);
      continue;
    }

    const terminal = effect.terminator || cfgTermOp(cfg, block, itemIdx);
    const args = popValues(effect.popSlots || 0, op);

    if (terminal || isBranch(op)) {
      block.term = { ...cfg.term[blockId], insnOp: op, args };
      annotateTermThrow(block, op);
      if (block.term.mayThrow) {
        block.term.itemIdx = itemIdx;
        block.term.slotState = new Map(locals);
      }
      continue;
    }

    const kinds = effect.pushKinds;
    if (kinds.length === 0) {
      if (effect.essential || effect.mayThrow) {
        const node = makeValue(op, 'V', args, instruction.arg ?? null);
        annotate(node, blockId, itemIdx, item);
        node.effects = { mayThrow: effect.mayThrow };
        // Locals reaching a throwing op: an exception handler observes the
        // frame's locals as of the throw, so backends that catch in compiled
        // code need this exact state to spill (operand stack is discarded).
        if (effect.mayThrow) {
          node.slotState = new Map(locals);
          // A call-site deopt resumes the interpreter AT or AFTER the invoke,
          // which needs the operand stack beneath the call's arguments too.
          if (op.startsWith('invoke')) node.stackUnder = stack.slice();
        }
        block.body.push(node);
      }
      continue;
    }
    if (kinds.length !== 1) reject(`multi-push opcode ${op}`);
    const value = makeValue(op, kinds[0], args, instruction.arg ?? null);
    annotate(value, blockId, itemIdx, item);
    if (effect.essential || effect.mayThrow) {
      value.effects = { mayThrow: effect.mayThrow };
      if (effect.mayThrow) {
        value.slotState = new Map(locals);
        if (op.startsWith('invoke')) value.stackUnder = stack.slice();
      }
      block.body.push(value);
    } else {
      block.body.push(value); // pinned order keeps provenance simple in v1
    }
    stack.push(value);
  }

  if (!block.term) block.term = { ...cfg.term[blockId], insnOp: null, args: [] };
  block.exitStack = stack;
  block.slotDefsOut = locals;
}

function annotate(value, blockId, itemIdx, item) {
  value.block = blockId;
  value.itemIdx = itemIdx;
  value.pc = item && typeof item.pc === 'number' ? item.pc : null;
}

function annotateTermThrow(block, op) {
  if (op === 'athrow') block.term.mayThrow = true;
}

function isBranch(op) {
  return /^(if|goto|tableswitch|lookupswitch)/.test(op);
}

function cfgTermOp(cfg, block, itemIdx) {
  const insns = cfg.blocks[block.id].insns;
  return itemIdx === insns[insns.length - 1]
    && cfg.term[block.id] && cfg.term[block.id].kind === 'return';
}

function applySpecial(stack, special, op) {
  const take = (count) => {
    if (stack.length < count) reject(`stack underflow at ${op}`);
    return stack.splice(stack.length - count, count);
  };
  // Copies alias the same IrValue — dup is not a computation in SSA.
  if (special === 'dup') {
    const [v1] = take(1); stack.push(v1, v1);
  } else if (special === 'dup_x1') {
    const [v2, v1] = take(2); stack.push(v1, v2, v1);
  } else if (special === 'dup_x2') {
    const [v3, v2, v1] = take(3); stack.push(v1, v3, v2, v1);
  } else if (special === 'dup2') {
    const top = take(1)[0];
    if (kindWidth(top.kind) === 2) { stack.push(top, top); }
    else { const [v2] = take(1); stack.push(v2, top, v2, top); }
  } else if (special === 'dup2_x1') {
    const top = take(1)[0];
    if (kindWidth(top.kind) === 2) { const [v2] = take(1); stack.push(top, v2, top); }
    else { const [v3, v2] = take(2); stack.push(v2, top, v3, v2, top); }
  } else if (special === 'dup2_x2') {
    const top = take(1)[0];
    if (kindWidth(top.kind) === 2) {
      const below = take(1)[0];
      if (kindWidth(below.kind) === 2) { stack.push(top, below, top); }
      else { const [v3] = take(1); stack.push(top, v3, below, top); }
    } else {
      const [v2] = take(1);
      const v3 = take(1)[0];
      if (kindWidth(v3.kind) === 2) { stack.push(v2, top, v3, v2, top); }
      else { const [v4] = take(1); stack.push(v2, top, v4, v3, v2, top); }
    }
  } else if (special === 'swap') {
    const [v2, v1] = take(2); stack.push(v1, v2);
  } else {
    reject(`unsupported stack special ${special}`);
  }
}

function fillPhiArgs(blocks, rpo, isJoin, makeValue, paramSlots) {
  const undefValue = () => {
    const value = makeValue('undef', null);
    return value;
  };
  for (const blockId of rpo) {
    const block = blocks[blockId];
    if (!isJoin(blockId) || block.isHandlerEntry) continue;
    const sources = block.predIds.map((predId) => blocks[predId]);
    const seed = block.entryParamSeed || null;
    for (const phi of block.phis) {
      if (phi.origin.stackDepth !== undefined) {
        const depth = phi.origin.stackDepth;
        phi.args = sources.map((pred) => {
          const value = pred.exitStack && pred.exitStack[depth];
          if (!value) reject('phi predecessor missing stack value');
          return value;
        });
        if (seed) phi.args.unshift(block.entryStackSeed ? block.entryStackSeed[depth] : null);
        if (phi.args.some((arg) => !arg)) reject('entry loop with non-empty stack');
      } else {
        const slot = phi.origin.slot;
        phi.args = sources.map((pred) => pred.slotDefsOut.get(slot) || undefValue());
        if (seed) phi.args.unshift(seed.get(slot) || undefValue());
        const merged = phi.args.reduce((kind, arg) => mergeKind(kind, arg.kind), null);
        if (phi.kind === null) phi.kind = merged;
        else if (merged !== null && merged !== phi.kind) {
          reject(`local phi kind mismatch: loaded as ${phi.kind}, joins to ${merged}`);
        }
      }
    }
    if (seed) block.predIds = ['entry', ...block.predIds];
  }
}

function pruneTrivialPhis(fn) {
  let changed = true;
  const replacements = new Map();
  const resolve = (value) => {
    let current = value;
    while (replacements.has(current)) current = replacements.get(current);
    return current;
  };
  while (changed) {
    changed = false;
    for (const block of fn.blocks) {
      for (const phi of block.phis) {
        if (replacements.has(phi)) continue;
        const distinct = new Set(phi.args.map(resolve).filter((arg) => arg !== phi));
        if (distinct.size === 1) {
          replacements.set(phi, [...distinct][0]);
          changed = true;
        }
      }
    }
  }
  if (replacements.size === 0) return;
  const map = (value) => (value ? resolve(value) : value);
  for (const value of fn.values) {
    value.args = value.args.map(map);
    if (value.slotState) {
      for (const [slot, v] of value.slotState) value.slotState.set(slot, map(v));
    }
    if (value.stackUnder) value.stackUnder = value.stackUnder.map(map);
  }
  for (const block of fn.blocks) {
    block.phis = block.phis.filter((phi) => !replacements.has(phi));
    block.entryStack = block.entryStack.map(map);
    if (block.exitStack) block.exitStack = block.exitStack.map(map);
    if (block.slotDefsOut) {
      for (const [slot, value] of block.slotDefsOut) block.slotDefsOut.set(slot, map(value));
    }
    if (block.slotDefsIn) {
      for (const [slot, value] of block.slotDefsIn) block.slotDefsIn.set(slot, map(value));
    }
    if (block.term && block.term.args) block.term.args = block.term.args.map(map);
    if (block.term && block.term.slotState) {
      for (const [slot, v] of block.term.slotState) block.term.slotState.set(slot, map(v));
    }
    block.body = block.body.filter((node) => !replacements.has(node));
  }
  fn.values = fn.values.filter((value) => !replacements.has(value));
  fn.params = fn.params.map(map);
}

function recordUses(fn) {
  for (const value of fn.values) value.uses = [];
  for (const value of fn.values) {
    for (const arg of value.args) if (arg) arg.uses.push(value);
  }
  for (const block of fn.blocks) {
    if (block.term && block.term.args) {
      for (const arg of block.term.args) if (arg) arg.uses.push(block.term);
    }
  }
}

// ---- phase A: entry-stack kind shapes -------------------------------------

function computeEntryShapes(cfg, items, rpo, preds, handlerBlocks) {
  const shapes = new Map();
  const exitShapes = new Map();
  shapes.set(cfg.entry, []);
  for (const blockId of handlerBlocks.keys()) shapes.set(blockId, ['A']);

  for (const blockId of rpo) {
    let shape = shapes.get(blockId);
    if (shape === undefined) {
      const predId = (preds[blockId] || [])[0];
      if (predId === undefined) reject('reachable block with no entry shape');
      shape = exitShapes.get(predId);
      if (shape === undefined) reject('predecessor shape missing');
      shapes.set(blockId, shape);
    }
    const exit = simulateShape(shape, cfg.blocks[blockId].insns, items);
    exitShapes.set(blockId, exit);
    for (const succ of cfg.succ[blockId]) {
      const existing = shapes.get(succ);
      if (existing === undefined) { shapes.set(succ, exit); continue; }
      if (existing.length !== exit.length) reject('stack depth mismatch at join');
      for (let i = 0; i < exit.length; i += 1) {
        if (existing[i] !== exit[i]) reject('stack kind mismatch at join');
      }
    }
  }
  return shapes;
}

function simulateShape(entryShape, insns, items) {
  const stack = entryShape.slice();
  for (const itemIdx of insns) {
    const item = items[itemIdx];
    const instruction = unwrapWide(normalizeInstruction(item.instruction));
    const op = instruction && instruction.op;
    if (!op) continue;

    const local = localOperation(instruction, instruction);
    if (local && local.isLoad) { stack.push(LETTER_KIND[local.base[0]]); continue; }
    if (local && !local.isLoad) {
      shapePop(stack, kindWidth(LETTER_KIND[local.base[0]]), op);
      continue;
    }
    if (op === 'iinc') continue;

    const effect = kindedStackEffect(op, instruction);
    if (!effect) reject(`unsupported opcode ${op}`);
    if (effect.special) { applySpecialShape(stack, effect.special, op); continue; }
    shapePop(stack, effect.popSlots || 0, op);
    for (const kind of effect.pushKinds) stack.push(kind);
  }
  return stack;
}

function shapePop(stack, slots, op) {
  let remaining = slots;
  while (remaining > 0) {
    const kind = stack.pop();
    if (kind === undefined) reject(`stack underflow at ${op}`);
    const width = kindWidth(kind) || 1;
    if (width > remaining) reject(`wide value split at ${op}`);
    remaining -= width;
  }
}

function applySpecialShape(stack, special, op) {
  // Shapes reuse the value-level shuffles; kinds are plain strings so the
  // aliasing the value path relies on is irrelevant here.
  const fake = stack.map((kind) => ({ kind }));
  applySpecial(fake, special, op);
  stack.length = 0;
  for (const entry of fake) stack.push(entry.kind);
}

// ---- helpers ---------------------------------------------------------------

function layoutParams(method, items) {
  const descriptor = method && method.descriptor;
  const isStatic = Boolean(method && (method.flags || []).includes('static'));
  const kinds = descriptor ? paramKindsFromMethodDescriptor(descriptor) : [];
  if (kinds === null) reject('unparseable method descriptor');
  const allKinds = isStatic || !method ? kinds : ['A', ...kinds];

  const paramValues = [];
  const paramSlots = [];
  let slot = 0;
  let id = 0;
  for (const kind of allKinds) {
    const value = new IrValue(id, 'param', kind, [], { index: id, slot });
    id += 1;
    paramValues.push(value);
    paramSlots.push(slot);
    slot += kindWidth(kind);
  }

  let maxSlot = slot;
  for (const item of items) {
    const instruction = item && unwrapWide(normalizeInstruction(item.instruction));
    if (!instruction) continue;
    const local = localOperation(instruction, instruction);
    if (local) {
      const width = kindWidth(LETTER_KIND[local.base[0]]) || 1;
      maxSlot = Math.max(maxSlot, local.index + width);
    } else if (instruction.op === 'iinc') {
      const { slot } = iincOperands(instruction);
      if (Number.isInteger(slot)) maxSlot = Math.max(maxSlot, slot + 1);
    }
  }
  return { paramValues, paramSlots, localsSize: maxSlot };
}

function resolveHandlers(exceptionTable, labelToItem, pcToItem) {
  const out = [];
  for (const entry of exceptionTable || []) {
    const point = (pcKeys, labelKeys) => {
      for (const key of pcKeys) {
        if (typeof entry[key] === 'number') {
          return { itemIdx: pcToItem.get(entry[key]), pc: entry[key], label: null };
        }
      }
      for (const key of labelKeys) {
        const label = trim(entry[key]);
        if (label) return { itemIdx: labelToItem.get(label), pc: null, label };
      }
      return null;
    };
    const handler = point(['handler_pc'], ['handlerLbl', 'handlerLabel', 'handler', 'usingLbl']);
    const start = point(['start_pc'], ['startLbl', 'startLabel', 'start']);
    const end = point(['end_pc'], ['endLbl', 'endLabel', 'end']);
    if (!handler || handler.itemIdx === undefined) reject('unresolvable exception handler');
    out.push({
      entry,
      handlerItemIdx: handler.itemIdx,
      handlerLabel: handler.label,
      handlerPc: handler.pc,
      startPc: start && start.pc,
      endPc: end && end.pc,
      startItemIdx: start && start.itemIdx,
      endItemIdx: end && end.itemIdx,
      catchType: entry.catchType || entry.catch_type || null,
    });
  }
  return out;
}

function findReachable(cfg, roots) {
  const reachable = new Set();
  const work = [...roots];
  while (work.length) {
    const blockId = work.pop();
    if (reachable.has(blockId)) continue;
    reachable.add(blockId);
    for (const succ of cfg.succ[blockId]) work.push(succ);
  }
  return reachable;
}

function computePreds(cfg, reachable) {
  const preds = cfg.succ.map(() => []);
  for (let blockId = 0; blockId < cfg.n; blockId += 1) {
    if (!reachable.has(blockId)) continue;
    for (const succ of cfg.succ[blockId]) {
      if (!preds[succ].includes(blockId)) preds[succ].push(blockId);
    }
  }
  for (const list of preds) list.sort((a, b) => a - b);
  return preds;
}

function reversePostorder(cfg, roots, reachable) {
  const visited = new Set();
  const order = [];
  const visit = (start) => {
    const stack = [[start, 0]];
    if (visited.has(start)) return;
    visited.add(start);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const [blockId] = frame;
      const succs = cfg.succ[blockId];
      if (frame[1] < succs.length) {
        const next = succs[frame[1]];
        frame[1] += 1;
        if (!visited.has(next) && reachable.has(next)) {
          visited.add(next);
          stack.push([next, 0]);
        }
      } else {
        order.push(blockId);
        stack.pop();
      }
    }
  };
  for (const root of roots) visit(root);
  return order.reverse();
}

function trim(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = { buildSsa, IrValue, IrBlock };
