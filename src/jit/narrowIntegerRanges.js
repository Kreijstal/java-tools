'use strict';

const full = () => ({minimum:-2147483648, maximum:2147483647, excluded:new Set()});
const same = (a, b) => a.minimum === b.minimum && a.maximum === b.maximum &&
  a.excluded.size === b.excluded.size && [...a.excluded].every(x => b.excluded.has(x));

// Normal-flow must-facts for narrow integer loads and excluded constants.
// Values are snapshots of JVM locals, not facts about mutable array contents.
function narrowIntegerLoadRanges({cfg, items, opOf, localIndex, integerConstant}) {
  // Synthetic control flow and cloned bytecode need facts per rendered block,
  // rather than this analysis's instruction-index snapshots. Decline both.
  const seenItems = new Set();
  for (const block of cfg.blocks) {
    if (block?.synthetic) return new Map();
    for (const index of block?.insns || []) {
      if (seenItems.has(index)) return new Map();
      seenItems.add(index);
    }
  }
  if (!items.some(item => /^(?:baload|saload|caload|i2b|i2s|i2c)$/.test(opOf(item?.instruction)))) return new Map();
  if (items.some(item => /^(?:jsr|jsr_w|ret|wide)$/.test(opOf(item?.instruction)))) return new Map();
  const loadSlot = ins => /^iload(?:_[0-3])?$/.test(opOf(ins)) ? localIndex(ins, opOf(ins)) : null;
  const transfer = (block, input, loads) => {
    const facts = new Map(input);
    const indices = block.insns || [];
    for (let position = 0; position < indices.length; position++) {
      const index = indices[position], ins = items[index]?.instruction, op = opOf(ins);
      const loaded = loadSlot(ins);
      if (loads && loaded !== null && facts.has(loaded)) loads.set(index, facts.get(loaded));
      const store = /^([adfil])store(?:_[0-3])?$/.exec(op || '');
      if (!store && op !== 'iinc') continue;
      // Some classfile and decompiler paths retain the increment operand pair.
      // An unrecognized write must discard facts, never silently write NaN's slot.
      const incrementSlot = ins?.varnum ?? (Array.isArray(ins?.arg) ? ins.arg[0] : ins?.arg);
      const numericIncrementSlot = typeof incrementSlot === 'number' ||
        typeof incrementSlot === 'string' && /^\d+$/.test(incrementSlot)
        ? Number(incrementSlot) : NaN;
      const slot = store ? localIndex(ins, op) : numericIncrementSlot;
      if (!Number.isInteger(slot) || slot < 0 || slot > 65535) {
        facts.clear();
        continue;
      }
      let value = null;
      if (store?.[1] === 'i') {
        // An immediately preceding producer necessarily supplies the store's
        // stack top. More complex stack expressions are deliberately unknown.
        const previous = items[indices[position - 1]]?.instruction;
        const previousOp = opOf(previous);
        const constant = integerConstant(previous);
        if (constant !== null) value = {minimum:constant, maximum:constant, excluded:new Set()};
        else if (previousOp === 'baload' || previousOp === 'i2b') value = {minimum:-128, maximum:127, excluded:new Set()};
        else if (previousOp === 'saload' || previousOp === 'i2s') value = {minimum:-32768, maximum:32767, excluded:new Set()};
        else if (previousOp === 'caload' || previousOp === 'i2c') value = {minimum:0, maximum:65535, excluded:new Set()};
        else { const source = loadSlot(previous); if (source !== null) value = facts.get(source) || null; }
      }
      facts.delete(slot);
      if (store && (store[1] === 'd' || store[1] === 'l')) facts.delete(slot + 1);
      if (value) facts.set(slot, value);
    }
    return facts;
  };
  const edgeFacts = (block, facts, successor) => {
    const term = cfg.term[block.id], indices = block.insns || [];
    if (term?.kind !== 'cond' || term.taken === term.fall || indices.length < 3) return facts;
    const op = opOf(items[indices.at(-1)]?.instruction);
    if (op !== 'if_icmpeq' && op !== 'if_icmpne') return facts;
    const unequal = (successor === term.taken) === (op === 'if_icmpne');
    if (!unequal) return facts;
    const left = items[indices.at(-3)]?.instruction, right = items[indices.at(-2)]?.instruction;
    let slot = loadSlot(left), constant = integerConstant(right);
    if (slot === null || constant === null) { slot = loadSlot(right); constant = integerConstant(left); }
    if (slot === null || constant === null) return facts;
    const previous = facts.get(slot) || full();
    const result = new Map(facts);
    result.set(slot, {...previous, excluded:new Set([...previous.excluded, constant])});
    return result;
  };
  const inputs = new Map([[cfg.entry, new Map()]]), work = [cfg.entry], queued = new Set(work);
  let iterations = 0;
  for (let head = 0; head < work.length; head++) {
    // Optional optimization only: cap unusual control-flow analysis costs.
    if (++iterations > Math.max(32, cfg.blocks.length * 32)) return new Map();
    const id = work[head]; queued.delete(id);
    const block = cfg.blocks[id];
    if (!block || block.synthetic) continue;
    const output = transfer(block, inputs.get(id));
    for (const successor of cfg.succ[id] || []) {
      const incoming = edgeFacts(block, output, successor), previous = inputs.get(successor);
      const merged = previous === undefined ? new Map(incoming) : new Map();
      if (previous) for (const [slot, a] of previous) {
        const b = incoming.get(slot);
        if (b) merged.set(slot, {minimum:Math.min(a.minimum,b.minimum), maximum:Math.max(a.maximum,b.maximum),
          excluded:new Set([...a.excluded].filter(x => b.excluded.has(x)))});
      }
      if (previous === undefined || merged.size !== previous.size ||
          [...merged].some(([slot, value]) => !same(value, previous.get(slot)))) {
        inputs.set(successor, merged);
        if (!queued.has(successor)) { work.push(successor); queued.add(successor); }
      }
    }
  }
  const loads = new Map();
  for (const [id, input] of inputs) {
    const block = cfg.blocks[id];
    if (block && !block.synthetic) transfer(block, input, loads);
  }
  return loads;
}

function maskedIntegerRange(mask, input) {
  let maximum = mask;
  // For a low-bit mask, every preimage of its maximum is mask modulo mask+1.
  // Excluding -1 only helps a signed byte, not an arbitrary int (255, 511,
  // etc. still map to 255). Require the complete source interval here.
  if (input && mask > 0 && (mask & (mask + 1)) === 0) {
    const period = mask + 1;
    const first = mask + Math.ceil((input.minimum - mask) / period) * period;
    if (first > input.maximum || first + period > input.maximum && input.excluded?.has(first)) maximum--;
  }
  return {minimum:0, maximum};
}

module.exports = {narrowIntegerLoadRanges, maskedIntegerRange};
