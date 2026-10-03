'use strict';

/**
 * loopTailMerge — re-share duplicated loop-increment back-edge tails.
 *
 * Obfuscators and bytecode normalisation passes (the pipeline's
 * `cloneSharedLoopIncrementTails`, for one) tail-duplicate a loop latch so that
 * each predecessor of the latch carries its own copy:
 *
 *   ifeq Lelse
 *   ...then...
 *   iinc 11, 1          ; copy 1
 *   goto Lhead
 *   Lelse:
 *   ...else...
 *   iinc 11, 1          ; copy 2
 *   goto Lhead
 *
 * Both copies are the same straight-line, side-effect-free code (`iinc`s only)
 * ending in the same back edge, so the method is behaviourally identical to one
 * with a single shared latch. Structuring the duplicated shape, however, gives
 * a loop with two `continue`s (one increment per arm), which javac compiles
 * back into two separate increment paths: the loop is no longer a counted loop
 * for a JIT, and the source reads worse than the original `for` loop.
 *
 * This pass finds, per loop header, all maximal `iinc* ; goto Lhead` runs whose
 * `goto` is a back edge and merges every common suffix into the last copy in
 * layout order (where javac itself places the latch): the other copies are
 * replaced by a `goto` to a label on the shared suffix. The merge is a pure CFG
 * tail-merge of identical straight-line code: no instruction is reordered,
 * added to, or removed from any execution path.
 *
 * Only `iinc` instructions form a tail, so the operand stack is never involved.
 * A label inside a duplicate's suffix (other than on its first instruction)
 * shortens the suffix so that no incoming jump is left dangling; a label on the
 * first instruction is kept on the replacement `goto`. The code item list is
 * mutated in place and keeps every item (and so every `pc`, label and
 * exception-table boundary): replaced instructions become `nop`s behind the
 * unconditional `goto`.
 */

const { collectRefdLabels } = require('./structurer');

function trimLabel(label) {
  return label ? String(label).replace(/:$/, '') : '';
}

function instructionOf(item) {
  if (!item || item.instruction === undefined) return null;
  const instruction = item.instruction;
  if (typeof instruction === 'string') return { op: instruction };
  if (instruction && instruction.op) return instruction;
  return null;
}

function labelOf(item) {
  return trimLabel(item && (item.labelDef || item.lineLabel));
}

function iincSignature(instruction) {
  const arg = instruction.arg;
  if (Array.isArray(arg)) return `iinc ${arg.map(String).join(' ')}`;
  if (arg && typeof arg === 'object') {
    return `iinc ${arg.varnum ?? arg.index} ${arg.incr ?? arg.const}`;
  }
  if (arg == null && (instruction.varnum !== undefined || instruction.index !== undefined)) {
    return `iinc ${instruction.varnum ?? instruction.index} ${instruction.incr ?? instruction.const}`;
  }
  return `iinc ${String(arg == null ? '' : arg).trim().split(/\s+/).join(' ')}`;
}

function buildLabelIndex(codeItems) {
  const labels = new Map();
  codeItems.forEach((item, index) => {
    const label = labelOf(item);
    if (label) labels.set(label, index);
  });
  return labels;
}

/**
 * For every executable item index, the label that names that instruction (its
 * own labelDef, or the labelDef of a label-only item directly before it) —
 * but only when something actually jumps to it or the exception table names
 * it. The class parser labels every instruction `L<pc>:`, so an unreferenced
 * label is not a control-flow entry and must not split a tail.
 */
function referencedLabelsByInstruction(codeItems, code) {
  const referenced = collectRefdLabels(codeItems);
  for (const entry of (code && code.exceptionTable) || []) {
    for (const key of ['startLbl', 'endLbl', 'handlerLbl', 'startLabel', 'endLabel', 'handlerLabel']) {
      if (entry[key]) referenced.add(trimLabel(entry[key]));
    }
  }
  const labels = new Map();
  let pending = '';
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const label = labelOf(item);
    if (instructionOf(item)) {
      const own = label && referenced.has(label) ? label : '';
      labels.set(i, own || pending);
      pending = '';
    } else if (label && referenced.has(label)) {
      pending = label;
    }
  }
  return labels;
}

/**
 * The label that can be used to jump to the instruction at `index`: a
 * referenced label if it has one, else its own (unreferenced) labelDef, else
 * the labelDef of a label-only item directly before it.
 */
function anyLabelAt(codeItems, index) {
  const own = labelOf(codeItems[index]);
  if (own) return own;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (instructionOf(codeItems[i])) break;
    const label = labelOf(codeItems[i]);
    if (label) return label;
  }
  return '';
}

/**
 * Collect the maximal `iinc* goto` runs ending in a back edge. Each run lists
 * the item indices of its executable instructions (goto last) and a parallel
 * list of instruction signatures.
 */
function collectTails(codeItems, labelIndex) {
  const tails = [];
  for (let i = 0; i < codeItems.length; i += 1) {
    const insn = instructionOf(codeItems[i]);
    if (!insn || (insn.op !== 'goto' && insn.op !== 'goto_w')) continue;
    const target = trimLabel(insn.arg);
    const headIndex = labelIndex.get(target);
    if (headIndex === undefined || headIndex >= i) continue; // not a back edge
    const indices = [i];
    const signatures = ['goto'];
    for (let cursor = i - 1; cursor >= 0; cursor -= 1) {
      const candidate = instructionOf(codeItems[cursor]);
      if (!candidate) continue; // label-only item: attached to the next instruction
      if (candidate.op !== 'iinc') break;
      indices.push(cursor);
      signatures.push(iincSignature(candidate));
    }
    if (indices.length < 2) continue; // need at least one iinc
    indices.reverse();
    signatures.reverse();
    tails.push({ head: target, indices, signatures, gotoIndex: i });
  }
  return tails;
}

function commonSuffixLength(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

function handlerLabels(code) {
  const labels = new Set();
  for (const entry of (code && code.exceptionTable) || []) {
    for (const key of ['handlerLbl', 'handlerLabel']) {
      if (entry[key]) labels.add(trimLabel(entry[key]));
    }
  }
  return labels;
}

/**
 * Merge duplicated loop-increment tails in `code.codeItems`. Returns the number
 * of duplicate tails that were redirected to a shared copy.
 */
function mergeDuplicateLoopIncrementTails(code) {
  const codeItems = code && code.codeItems;
  if (!Array.isArray(codeItems) || codeItems.length === 0) return 0;
  const labelIndex = buildLabelIndex(codeItems);
  const tails = collectTails(codeItems, labelIndex);
  if (tails.length < 2) return 0;
  const labelsAt = referencedLabelsByInstruction(codeItems, code);
  const handlers = handlerLabels(code);

  const byHead = new Map();
  for (const tail of tails) {
    if (!byHead.has(tail.head)) byHead.set(tail.head, []);
    byHead.get(tail.head).push(tail);
  }

  let merged = 0;
  let labelCounter = 0;
  const freshLabel = () => {
    let label;
    do {
      label = `Lsharedtail${labelCounter}`;
      labelCounter += 1;
    } while (labelIndex.has(label));
    labelIndex.set(label, -1);
    return label;
  };
  // position k counts instructions from the end of a tail: k = 0 is the goto.
  const indexFromEnd = (tail, k) => tail.indices[tail.indices.length - 1 - k];

  for (const group of byHead.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.gotoIndex - b.gotoIndex);
    const canonical = group[group.length - 1];
    for (const tail of group.slice(0, -1)) {
      let length = commonSuffixLength(tail.signatures, canonical.signatures);
      // A labelled instruction inside the suffix is a jump target of its own;
      // the shared suffix may start there but must not swallow it.
      for (let k = 0; k < length - 1; k += 1) {
        if (labelsAt.get(indexFromEnd(tail, k))) { length = k + 1; break; }
      }
      if (length < 2) continue; // at least one shared iinc plus the goto
      const startIndex = indexFromEnd(tail, length - 1);
      const startLabel = labelsAt.get(startIndex);
      if (startLabel && handlers.has(startLabel)) continue; // never rewrite a handler entry

      const canonicalStart = indexFromEnd(canonical, length - 1);
      let sharedLabel = anyLabelAt(codeItems, canonicalStart);
      if (!sharedLabel) {
        sharedLabel = freshLabel();
        codeItems[canonicalStart] = { ...codeItems[canonicalStart], labelDef: `${sharedLabel}:` };
      }
      labelsAt.set(canonicalStart, sharedLabel); // now referenced

      // The duplicate suffix's first instruction becomes the goto (keeping its
      // label, pc and other metadata); the remaining instructions become nops.
      codeItems[startIndex] = { ...codeItems[startIndex], instruction: { op: 'goto', arg: sharedLabel } };
      for (let k = 0; k < length - 1; k += 1) {
        const index = indexFromEnd(tail, k);
        codeItems[index] = { ...codeItems[index], instruction: 'nop' };
      }
      merged += 1;
    }
  }
  return merged;
}

module.exports = { mergeDuplicateLoopIncrementTails, collectTails, commonSuffixLength };
