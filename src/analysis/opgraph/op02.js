'use strict';

const {
  getStackEffect,
  normalizeInstruction,
} = require('./stackEffects');

const CONDITIONAL_BRANCH_OPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'ifnull', 'ifnonnull',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne',
  'jsr', 'jsr_w',
]);

const UNCONDITIONAL_BRANCH_OPS = new Set(['goto', 'goto_w']);
const SWITCH_OPS = new Set(['tableswitch', 'lookupswitch']);
const TERMINATOR_OPS = new Set(['return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'athrow', 'ret']);

let nextStackValueId = 1;

class Op02Node {
  constructor(id, itemIndex, item) {
    this.id = id;
    this.itemIndex = itemIndex;
    this.item = item;
    this.pc = item && item.pc;
    this.label = trimLabel(item && item.labelDef);
    this.instruction = normalizeInstruction(item && item.instruction);
    this.op = this.instruction && this.instruction.op;
    this.sources = [];
    this.targets = [];
    this.exceptionTargets = [];
    this.stackDepthBefore = null;
    this.stackDepthAfter = null;
    this.stackBeforeValues = null;
    this.stackConsumed = [];
    this.stackProduced = [];
    this.joinStack = null;
  }
}

class StackValue {
  constructor(width = 1, producer = null, kind = 'stack') {
    this.id = nextStackValueId++;
    this.width = width;
    this.producer = producer;
    this.kind = kind;
    this.mergedFrom = null;
  }
}

function buildOp02Graph(code, options = {}) {
  const items = Array.isArray(code && code.codeItems) ? code.codeItems : [];
  const nodes = [];
  const itemIndexToNode = new Map();

  for (let i = 0; i < items.length; i += 1) {
    if (!items[i] || !items[i].instruction) continue;
    const node = new Op02Node(nodes.length, i, items[i]);
    nodes.push(node);
    itemIndexToNode.set(i, node);
  }

  const graph = {
    nodes,
    entry: nodes[0] || null,
    itemIndexToNode,
    labelToNode: buildLabelToNode(items, itemIndexToNode),
    pcToNode: buildPcToNode(nodes),
    errors: [],
  };

  wireNormalEdges(graph, items);
  wireExceptionEdges(graph, code && code.exceptionTable);
  populateStackInfo(graph, options);

  return graph;
}

function wireNormalEdges(graph, items) {
  for (const node of graph.nodes) {
    const targets = instructionSuccessors(node, graph, items);
    for (const target of targets) {
      addEdge(node, target);
    }
  }
}

function instructionSuccessors(node, graph, items) {
  const op = node.op;
  if (!op) return [];

  const targets = [];
  const addLabelTarget = (label) => {
    const target = graph.labelToNode.get(trimLabel(label));
    if (target && !targets.includes(target)) targets.push(target);
  };

  if (SWITCH_OPS.has(op)) {
    for (const label of getSwitchTargets(node.instruction)) addLabelTarget(label);
    return targets;
  }

  if (UNCONDITIONAL_BRANCH_OPS.has(op)) {
    addLabelTarget(node.instruction.arg);
    return targets;
  }

  if (CONDITIONAL_BRANCH_OPS.has(op)) {
    addLabelTarget(node.instruction.arg);
    const fallthrough = nextInstructionNode(graph, items, node.itemIndex + 1);
    if (fallthrough && !targets.includes(fallthrough)) targets.push(fallthrough);
    return targets;
  }

  if (TERMINATOR_OPS.has(op)) return [];

  const fallthrough = nextInstructionNode(graph, items, node.itemIndex + 1);
  return fallthrough ? [fallthrough] : [];
}

function wireExceptionEdges(graph, exceptionTable = []) {
  const entries = normalizeExceptionEntries(exceptionTable, graph);
  for (const entry of entries) {
    if (!entry.handler) continue;
    for (const node of graph.nodes) {
      if (nodeInProtectedRange(node, entry)) {
        addExceptionEdge(node, entry.handler);
      }
    }
  }
}

function populateStackInfo(graph, options = {}) {
  if (!graph.entry) return graph;

  const work = [{ node: graph.entry, stack: [] }];
  const queued = new Set();
  // Merge-heavy CFGs can re-enqueue nodes once per fresh merged-value
  // identity; callers doing bulk sweeps bound that with maxSteps.
  const maxSteps = options.maxSteps || Infinity;
  let steps = 0;

  while (work.length > 0) {
    steps += 1;
    if (steps > maxSteps) throw new Error('op02 step budget exceeded');
    const { node, stack } = work.shift();
    queued.delete(queueKey(node, stack));
    const changed = applyStackAtNode(graph, node, stack, options);
    if (!changed) continue;

    const outStack = node.joinStack ? node.joinStack.slice() : [];
    for (const target of node.targets) {
      enqueue(work, queued, target, outStack);
    }
    for (const target of node.exceptionTargets) {
      enqueue(work, queued, target, [new StackValue(1, node, 'exception')]);
    }
  }

  return graph;
}

function applyStackAtNode(graph, node, incomingStack, options) {
  if (node.stackDepthBefore === null) {
    const result = executeNode(node, incomingStack, graph, options);
    node.stackDepthBefore = stackWidth(incomingStack);
    node.stackDepthAfter = stackWidth(result.stack);
    node.stackBeforeValues = incomingStack.slice();
    node.stackConsumed = result.consumed;
    node.stackProduced = result.produced;
    node.joinStack = result.stack;
    return true;
  }

  if (node.stackDepthBefore !== stackWidth(incomingStack)) {
    const message = `stack depth mismatch at node ${node.id}: saw ${stackWidth(incomingStack)}, expected ${node.stackDepthBefore}`;
    graph.errors.push({ node, message });
    if (!options.tolerateStackMismatches) throw new Error(message);
    return false;
  }

  const mergedIn = mergeStacks(node.stackBeforeValues || [], incomingStack);
  const inputChanged = stackIdsChanged(node.stackBeforeValues, mergedIn);
  if (!inputChanged) return false;

  const result = executeNode(node, mergedIn, graph, options);
  node.stackBeforeValues = mergedIn;
  node.stackConsumed = mergeStackValues(node.stackConsumed, result.consumed);
  node.stackProduced = mergeStackValues(node.stackProduced, result.produced);
  node.stackDepthAfter = stackWidth(result.stack);
  node.joinStack = mergeStacks(node.joinStack || [], result.stack);
  return true;
}

function executeNode(node, inputStack, graph, options) {
  const effect = getStackEffect(node.op, node.instruction);
  if (!effect) {
    const message = `unsupported opcode ${node.op || '<unknown>'} at node ${node.id}`;
    graph.errors.push({ node, message });
    if (!options.tolerateUnsupportedOpcodes) throw new Error(message);
    return { consumed: [], produced: [], stack: inputStack.slice() };
  }

  const stack = inputStack.slice();
  if (effect.special) {
    const consumed = peekSlots(stack, effect.popSlots || 0);
    const produced = applySpecialStackEffect(stack, effect.special, node);
    return { consumed, produced, stack };
  }
  const consumed = popSlots(stack, effect.popSlots || 0, node, graph, options);
  const produced = applyStackProduction(stack, effect, node);
  return { consumed, produced, stack };
}

function applyStackProduction(stack, effect, node) {
  const produced = [];
  for (let remaining = effect.pushSlots || 0; remaining > 0;) {
    const width = remaining >= 2 ? 2 : 1;
    const value = new StackValue(width, node);
    stack.push(value);
    produced.push(value);
    remaining -= width;
  }
  return produced;
}

function applySpecialStackEffect(stack, special, node) {
  const produced = [];
  const pushCopy = (value) => {
    if (!value) return;
    const copy = new StackValue(value ? value.width : 1, node);
    if (value) copy.mergedFrom = [value];
    stack.push(copy);
    produced.push(copy);
  };
  // The dup2/dup_x2 family is slot-counted, not entry-counted: a wide value
  // is ONE entry worth TWO slots, so take by slots or wide operands (e.g.
  // dup2_x1 over [ref, long]) miscount the depth.
  const takeSlots = (slots) => {
    const values = [];
    let remaining = slots;
    while (remaining > 0 && stack.length > 0) {
      const value = stack.pop();
      values.unshift(value);
      remaining -= (value && value.width) || 1;
    }
    return values;
  };
  const put = (value) => {
    if (value) stack.push(value);
  };

  if (special === 'dup') {
    const [v1] = takeSlots(1);
    put(v1);
    pushCopy(v1);
  } else if (special === 'dup_x1') {
    const [v2, v1] = takeSlots(2);
    pushCopy(v1);
    put(v2);
    put(v1);
  } else if (special === 'dup_x2') {
    const top = takeSlots(1);
    const below = takeSlots(2);
    pushCopy(top[0]);
    for (const value of below) put(value);
    put(top[0]);
  } else if (special === 'dup2') {
    const values = takeSlots(2);
    for (const value of values) put(value);
    for (const value of values) pushCopy(value);
  } else if (special === 'dup2_x1') {
    const top = takeSlots(2);
    const below = takeSlots(1);
    for (const value of top) pushCopy(value);
    for (const value of below) put(value);
    for (const value of top) put(value);
  } else if (special === 'dup2_x2') {
    const top = takeSlots(2);
    const below = takeSlots(2);
    for (const value of top) pushCopy(value);
    for (const value of below) put(value);
    for (const value of top) put(value);
  } else if (special === 'swap') {
    const [v2, v1] = takeSlots(2);
    put(v1);
    put(v2);
  }

  return produced;
}

function popSlots(stack, slots, node, graph, options) {
  const consumed = [];
  let remaining = slots;
  while (remaining > 0) {
    const value = stack.pop();
    if (!value) {
      const message = `stack underflow at node ${node.id}`;
      graph.errors.push({ node, message });
      if (!options.tolerateStackMismatches) throw new Error(message);
      break;
    }
    consumed.push(value);
    remaining -= value.width || 1;
  }
  return consumed;
}

function peekSlots(stack, slots) {
  const consumed = [];
  let remaining = slots;
  for (let i = stack.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const value = stack[i];
    consumed.push(value);
    remaining -= (value && value.width) || 1;
  }
  return consumed;
}

function mergeStacks(left, right) {
  const max = Math.max(left.length, right.length);
  const merged = [];
  for (let i = 0; i < max; i += 1) {
    merged.push(mergeValue(left[i], right[i]));
  }
  return merged.filter(Boolean);
}

function mergeStackValues(left, right) {
  const max = Math.max(left.length, right.length);
  const merged = [];
  for (let i = 0; i < max; i += 1) {
    const value = mergeValue(left[i], right[i]);
    if (value) merged.push(value);
  }
  return merged;
}

function mergeValue(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  if (left.id === right.id) return left;
  if (valueSetContains(left, right)) return left;
  if (valueSetContains(right, left)) return right;
  if (sameValueSet(left, right)) return left;
  const merged = new StackValue(Math.max(left.width || 1, right.width || 1), null, 'merge');
  const values = [];
  for (const value of [left, right]) {
    if (!value) continue;
    if (value.kind === 'merge' && Array.isArray(value.mergedFrom)) {
      values.push(...value.mergedFrom);
    } else {
      values.push(value);
    }
  }
  const seen = new Set();
  merged.mergedFrom = values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
  return merged;
}

function valueSetContains(container, candidate) {
  if (!container || !candidate || container.kind !== 'merge' || !Array.isArray(container.mergedFrom)) return false;
  return container.mergedFrom.some((value) => value && value.id === candidate.id);
}

function sameValueSet(left, right) {
  const leftIds = valueSetIds(left);
  const rightIds = valueSetIds(right);
  if (leftIds.length !== rightIds.length) return false;
  for (let i = 0; i < leftIds.length; i += 1) {
    if (leftIds[i] !== rightIds[i]) return false;
  }
  return true;
}

function valueSetIds(value) {
  const values = value && value.kind === 'merge' && Array.isArray(value.mergedFrom)
    ? value.mergedFrom
    : [value];
  return values.filter(Boolean).map((entry) => entry.id).sort((a, b) => a - b);
}

function stackIdsChanged(left = [], right = []) {
  if (!left || left.length !== right.length) return true;
  for (let i = 0; i < left.length; i += 1) {
    if (!left[i] || !right[i] || left[i].id !== right[i].id) return true;
  }
  return false;
}

function addEdge(source, target) {
  if (!source || !target) return;
  if (!source.targets.includes(target)) source.targets.push(target);
  if (!target.sources.includes(source)) target.sources.push(source);
}

function addExceptionEdge(source, target) {
  if (!source || !target) return;
  if (!source.exceptionTargets.includes(target)) source.exceptionTargets.push(target);
  if (!target.sources.includes(source)) target.sources.push(source);
}

function enqueue(work, queued, node, stack) {
  const key = queueKey(node, stack);
  if (queued.has(key)) return;
  queued.add(key);
  work.push({ node, stack: stack.slice() });
}

function queueKey(node, stack) {
  return `${node.id}:${stack.map((value) => value && value.id).join(',')}`;
}

function buildLabelToNode(items, itemIndexToNode) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const label = trimLabel(items[i] && items[i].labelDef);
    if (!label) continue;
    const node = itemIndexToNode.get(i) || nextInstructionNode({ itemIndexToNode }, items, i + 1);
    if (node) out.set(label, node);
  }
  return out;
}

function buildPcToNode(nodes) {
  const out = new Map();
  for (const node of nodes) {
    if (typeof node.pc === 'number') out.set(node.pc, node);
  }
  return out;
}

function nextInstructionNode(graph, items, start) {
  for (let i = start; i < items.length; i += 1) {
    const node = graph.itemIndexToNode.get(i);
    if (node) return node;
  }
  return null;
}

function normalizeExceptionEntries(exceptionTable = [], graph) {
  const out = [];
  for (const entry of exceptionTable || []) {
    const handler = resolveExceptionPoint(entry, graph, ['handler_pc'], ['handlerLbl', 'handlerLabel', 'handler', 'usingLbl']);
    const start = resolveExceptionPoint(entry, graph, ['start_pc'], ['startLbl', 'startLabel', 'start']);
    const end = resolveExceptionPoint(entry, graph, ['end_pc'], ['endLbl', 'endLabel', 'end']);
    if (handler && (start || end)) {
      out.push({ entry, handler, start, end });
    }
  }
  return out;
}

function resolveExceptionPoint(entry, graph, pcKeys, labelKeys) {
  for (const key of pcKeys) {
    if (typeof entry[key] === 'number') return graph.pcToNode.get(entry[key]) || null;
  }
  for (const key of labelKeys) {
    const label = trimLabel(entry[key]);
    if (label) return graph.labelToNode.get(label) || null;
  }
  return null;
}

function nodeInProtectedRange(node, entry) {
  const startIdx = entry.start ? entry.start.itemIndex : -Infinity;
  const endIdx = entry.end ? entry.end.itemIndex : Infinity;
  return node.itemIndex >= startIdx && node.itemIndex < endIdx && node !== entry.handler;
}

function getSwitchTargets(instruction) {
  if (!instruction) return [];
  if (instruction.op === 'tableswitch') {
    const labels = Array.isArray(instruction.labels) ? instruction.labels : [];
    return [...labels, instruction.defaultLbl].filter(Boolean);
  }
  const arg = instruction.arg || {};
  const pairs = Array.isArray(arg.pairs) ? arg.pairs.map((pair) => Array.isArray(pair) ? pair[1] : null) : [];
  return [...pairs, arg.defaultLabel].filter(Boolean);
}

function stackWidth(stack) {
  return stack.reduce((total, value) => total + ((value && value.width) || 1), 0);
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = {
  Op02Node,
  StackValue,
  buildOp02Graph,
  populateStackInfo,
};
