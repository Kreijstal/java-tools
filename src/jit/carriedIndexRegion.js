'use strict';

// Affine carried-index analysis over a tree of counted loops.
//
// The FunOrb sprite blit -- and most row/column raster kernels javac emits --
// index their arrays with a *carried counter* rather than with the loop's own
// induction variable:
//
//   for (y = -h; y < 0; y++) {            // root
//     for (q = quads; q < 0; q++) {       // child A (4x unrolled pixel loop)
//       v = src[srcOff++]; if (v != 0) dst[dstOff] = v; dstOff++;   (x4)
//     }
//     for (r = rem; r < 0; r++) {         // child B (remainder loop)
//       v = src[srcOff++]; if (v != 0) dst[dstOff] = v; dstOff++;
//     }
//     dstOff += dstStep; srcOff += srcStep;
//   }
//
// `srcOff` and `dstOff` are never compared against anything; they only ever
// advance, by a constant or by a value the region never writes. Their value
// at any access is therefore an affine function of how many iterations each
// enclosing loop has completed:
//
//   value = entry + SUM_j (i_j * stride_j) + constant(access)
//
// where `entry` is the slot's value when the root loop is first entered, `i_j`
// the 0-based iteration count of the j-th loop on the access's chain
// (root .. innermost), `stride_j` the amount the slot advances per completed
// iteration of that loop, and `constant(access)` the amount accumulated on
// the path from each loop's header to the access within the current
// iteration. A stride is itself a sum: the writes on the loop's own path plus,
// for every child loop the path completes, `trips(child) * stride(child)`.
//
// The model is built with a small dataflow over each loop's blocks in which a
// child loop is collapsed into one node worth `trips(child) * stride(child)`.
// It is deliberately conservative: a slot qualifies only if EVERY write to it
// inside the root's natural loop is `iinc slot k`, `slot = slot +/- k`, or
// `slot = slot +/- t` / `slot = t + slot` with `t` a slot the region never
// writes, and only if every block is reached with the same accumulated amount
// on every path (so `if (v != 0) dst[dstOff++] = v; else dstOff++;` is fine,
// a conditional skip of an increment is not). Any other write, a loop exited
// anywhere but through its header test, a child loop that some paths skip, or
// a loop whose start or bound is not expressible from region-invariant values
// makes the analysis give up (`null`), and the caller keeps the loop-local
// guards it has today.
//
// Values are linear forms over a small atom alphabet:
//   `s<slot>`   a region-invariant local read at the root's preheader,
//   `T<header>` the product trips(child) * stride(child) of a completed child,
// so the caller can emit each stride as its own declaration and reference the
// products by name -- nested rather than expanded, which keeps every emitted
// double exact below 2^53 for the trip caps the callers already enforce.
//
// The analysis never emits anything; it answers questions about the bytecode.

const CONSTANT_KEY = "";

const linearConstant = (value) => new Map(value === 0 ? [] : [[CONSTANT_KEY, value]]);
const linearAtom = (atom, coefficient = 1) => new Map([[atom, coefficient]]);
const linearAdd = (left, right) => {
  const sum = new Map(left);
  for (const [key, coefficient] of right) {
    const total = (sum.get(key) || 0) + coefficient;
    if (total === 0) sum.delete(key);
    else sum.set(key, total);
  }
  return sum;
};
const linearEqual = (left, right) => {
  if (left.size !== right.size) return false;
  for (const [key, coefficient] of left) {
    if (right.get(key) !== coefficient) return false;
  }
  return true;
};
const linearConstantValue = (form) =>
  form.size === 0 ? 0
    : form.size === 1 && form.has(CONSTANT_KEY) ? form.get(CONSTANT_KEY) : null;

function createCarriedIndexRegionAnalysis({ cfg, items, opOf, localIndex, constantInstructionValue }) {
  const isIload = (op) => /^iload(?:_[0-3])?$/.test(op);
  const isIstore = (op) => /^istore(?:_[0-3])?$/.test(op);
  // The slots any store-like bytecode writes, whatever the type: a slot
  // reused for a reference is no longer the counter the model follows, and a
  // long or double store also clobbers the slot above its own.
  const writtenSlotsOf = (instruction) => {
    const op = opOf(instruction);
    if (op === "iinc") return [Number(instruction.varnum ?? instruction.arg)];
    if (!/^[adfil]store(?:_[0-3])?$/.test(op)) return [];
    const slot = localIndex(instruction, op);
    return /^[dl]store/.test(op) ? [slot, slot + 1] : [slot];
  };

  // Every slot any bytecode inside `blocks` writes.
  const slotsWrittenIn = (blocks) => {
    const written = new Set();
    for (const block of blocks) {
      for (const itemIndex of cfg.blocks[block]?.insns || []) {
        for (const slot of writtenSlotsOf(items[itemIndex]?.instruction)) {
          written.add(slot);
        }
      }
    }
    return written;
  };

  // The writes to `slot` inside one block, in order, each as
  // {itemIndex, amount} with `amount` a linear form, or null when a write is
  // not of a modelled shape.
  const blockWrites = (block, slot, invariant) => {
    const insns = cfg.blocks[block]?.insns || [];
    const writes = [];
    for (let position = 0; position < insns.length; position += 1) {
      const itemIndex = insns[position];
      const instruction = items[itemIndex]?.instruction;
      if (!writtenSlotsOf(instruction).includes(slot)) continue;
      const op = opOf(instruction);
      if (op !== "iinc" && !isIstore(op)) return null;
      if (op === "iinc") {
        const increment = Number(instruction.incr ?? 0);
        if (!Number.isInteger(increment)) return null;
        writes.push({itemIndex, amount: linearConstant(increment)});
        continue;
      }
      // istore slot, preceded by: iload slot; <constant | iload t>; iadd|isub
      // or: iload t; iload slot; iadd
      if (position < 3) return null;
      const first = items[insns[position - 3]]?.instruction;
      const second = items[insns[position - 2]]?.instruction;
      const binary = opOf(items[insns[position - 1]]?.instruction);
      const firstOp = opOf(first), secondOp = opOf(second);
      if (binary !== "iadd" && binary !== "isub") return null;
      let amount = null;
      if (isIload(firstOp) && localIndex(first, firstOp) === slot) {
        const constant = constantInstructionValue(second);
        if (constant !== null) {
          amount = linearConstant(binary === "iadd" ? constant : -constant);
        } else if (isIload(secondOp)) {
          const other = localIndex(second, secondOp);
          if (other === slot || !invariant(other)) return null;
          amount = linearAtom(`s${other}`, binary === "iadd" ? 1 : -1);
        }
      } else if (binary === "iadd" && isIload(secondOp) &&
          localIndex(second, secondOp) === slot) {
        const constant = constantInstructionValue(first);
        if (constant !== null) {
          amount = linearConstant(constant);
        } else if (isIload(firstOp)) {
          const other = localIndex(first, firstOp);
          if (other === slot || !invariant(other)) return null;
          amount = linearAtom(`s${other}`);
        }
      }
      if (!amount) return null;
      writes.push({itemIndex, amount});
    }
    return writes;
  };

  // Build the region model for one root and one slot. Returns null when the
  // slot is not a modelled carried counter, otherwise:
  //   {
  //     strides: Map<header, linear>       advance per completed iteration,
  //     entries: Map<block, linear>        value at block entry relative to
  //                                        the innermost loop's header,
  //     childEntries: Map<header, linear>  value at a child's header relative
  //                                        to its parent's header,
  //     writes: Map<block, [{itemIndex, amount}]>,
  //   }
  const modelSlot = (tree, slot) => {
    const {loops, children, root, invariant} = tree;
    const writes = new Map();
    for (const block of root.loopBlocks) {
      const modelled = blockWrites(block, slot, invariant);
      if (modelled === null) return null;
      writes.set(block, modelled);
    }
    const blockAmount = (block) => (writes.get(block) || []).reduce(
      (sum, write) => linearAdd(sum, write.amount), linearConstant(0));
    const strides = new Map();
    const entries = new Map();
    const childEntries = new Map();
    // Innermost first: a parent's dataflow needs its children's strides.
    const order = [];
    const visit = (loop) => {
      for (const child of children.get(loop.header) || []) visit(child);
      order.push(loop);
    };
    visit(root);
    for (const loop of order) {
      const ownChildren = children.get(loop.header) || [];
      const childByBlock = new Map();
      for (const child of ownChildren) {
        for (const block of child.loopBlocks) childByBlock.set(block, child);
      }
      const localEntries = new Map([[loop.header, linearConstant(0)]]);
      let stride = null;
      const pending = [loop.header];
      const arrive = (block, value) => {
        const known = localEntries.get(block);
        if (known) return linearEqual(known, value);
        localEntries.set(block, value);
        pending.push(block);
        return true;
      };
      while (pending.length) {
        const block = pending.pop();
        const child = childByBlock.get(block);
        let value;
        let successors;
        if (child) {
          // Only the child's header may be entered, and the child may only be
          // left through its own header test.
          if (block !== child.header) return null;
          childEntries.set(child.header, localEntries.get(block));
          value = linearAdd(localEntries.get(block), linearAtom(`T${child.header}`));
          successors = (cfg.succ[child.header] || []).filter((successor) =>
            !child.loopBlocks.has(successor));
          if (successors.length !== 1) return null;
        } else {
          value = linearAdd(localEntries.get(block), blockAmount(block));
          successors = cfg.succ[block] || [];
        }
        for (const successor of successors) {
          if (successor === loop.header) {
            if (stride && !linearEqual(stride, value)) return null;
            stride = value;
          } else if (!loop.loopBlocks.has(successor)) {
            // An exit anywhere but the header test ends the loop early, so
            // the trip count would no longer describe how far the slot moved.
            if (block !== loop.header) return null;
          } else if (!arrive(successor, value)) {
            return null;
          }
        }
      }
      if (!stride) return null;
      strides.set(loop.header, stride);
      for (const [block, value] of localEntries) {
        if (!childByBlock.has(block)) entries.set(block, value);
      }
    }
    return {strides, entries, childEntries, writes};
  };

  // Every loop exits only through its header, and every block of the region
  // belongs to the natural loop of exactly the loops on its chain.
  const buildTree = (loops, root) => {
    const contained = loops.filter((loop) =>
      loop === root || root.loopBlocks.has(loop.header));
    const parents = new Map();
    const children = new Map();
    for (const loop of contained) {
      if (loop === root) {
        parents.set(loop.header, null);
        continue;
      }
      const enclosing = contained.filter((other) =>
        other !== loop && other.loopBlocks.has(loop.header))
        .sort((left, right) => left.loopBlocks.size - right.loopBlocks.size);
      if (!enclosing.length) return null;
      const parent = enclosing[0];
      // Natural loops nest or are disjoint; a header shared between two
      // otherwise unrelated loops is not a tree.
      if (!enclosing.every((other) => other === parent ||
          other.loopBlocks.has(parent.header))) return null;
      parents.set(loop.header, parent);
      children.set(parent.header,
        [...(children.get(parent.header) || []), loop]);
    }
    for (const loop of contained) {
      if (!Number.isInteger(loop.increment) || loop.increment <= 0) return null;
      if ((loop.backedges || []).length !== 1) return null;
    }
    const written = slotsWrittenIn(root.loopBlocks);
    return {
      loops: contained,
      root,
      parents,
      children,
      written,
      invariant: (slot) => Number.isInteger(slot) && !written.has(slot),
      chainOf: (loop) => {
        const chain = [];
        for (let current = loop; current; current = parents.get(current.header)) {
          chain.unshift(current);
        }
        return chain;
      },
      innermostContaining: (block) => contained
        .filter((loop) => loop.loopBlocks.has(block))
        .sort((left, right) => left.loopBlocks.size - right.loopBlocks.size)[0] || null,
    };
  };

  // The model of one access: its chain of loops (root first), and the amount
  // the slot has accumulated relative to the root's entry that does not
  // depend on any iteration count (as a linear form). `versionItem` is the
  // item at which the access's index value was read from (or written to)
  // the slot inside `block`; the writes at or before it are the ones that
  // already happened.
  const accessConstant = (tree, model, block, versionItem, offset) => {
    const leaf = tree.innermostContaining(block);
    if (!leaf) return null;
    const chain = tree.chainOf(leaf);
    let constant = linearConstant(offset);
    for (let position = 1; position < chain.length; position += 1) {
      const entry = model.childEntries.get(chain[position].header);
      if (!entry) return null;
      constant = linearAdd(constant, entry);
    }
    const entry = model.entries.get(block);
    if (!entry) return null;
    constant = linearAdd(constant, entry);
    const insns = cfg.blocks[block]?.insns || [];
    if (!insns.includes(versionItem)) return null;
    for (const write of model.writes.get(block) || []) {
      if (write.itemIndex <= versionItem) {
        constant = linearAdd(constant, write.amount);
      }
    }
    return {chain, constant};
  };

  return {
    buildTree,
    modelSlot,
    accessConstant,
    linearConstantValue,
    linearAdd,
    linearConstant,
  };
}

module.exports = { createCarriedIndexRegionAnalysis };
