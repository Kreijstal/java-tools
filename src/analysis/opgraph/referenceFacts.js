'use strict';

// Compile-time facts for the shared SSA graph. Java types supplement (never
// replace) verification kinds. Bounds and exactType describe NON-NULL values;
// null remains assignable to every reference type. No class loading, VM state,
// allocation census, or application identities participate in these proofs.
// Rebuild the analysis after rewriting the SSA graph.
const UNKNOWN = Object.freeze({ nullness: 'maybe', upperBounds: Object.freeze([]), exactType: null });
const NULL = Object.freeze({ nullness: 'null', upperBounds: Object.freeze([]), exactType: null });
const MAX_BOUNDS = 8;
const ARRAY_TYPES = { boolean: '[Z', byte: '[B', char: '[C', short: '[S', int: '[I',
  long: '[J', float: '[F', double: '[D', 4: '[Z', 5: '[C', 6: '[F', 7: '[D',
  8: '[B', 9: '[S', 10: '[I', 11: '[J' };

function fact(nullness, upperBounds = [], exactType = null) {
  if (nullness === 'null') return NULL;
  const bounds = [...new Set(upperBounds.filter(type => typeof type === 'string' && type.length))].sort().slice(0, MAX_BOUNDS);
  if (typeof exactType !== 'string') exactType = null;
  if (nullness === 'maybe' && !bounds.length && !exactType) return UNKNOWN;
  return Object.freeze({ nullness, upperBounds: Object.freeze(bounds), exactType });
}

function same(a, b) {
  return a === b || !!a && !!b && a.nullness === b.nullness && a.exactType === b.exactType &&
    a.upperBounds.length === b.upperBounds.length && a.upperBounds.every((x, i) => x === b.upperBounds[i]);
}

function referenceType(descriptor) {
  if (typeof descriptor !== 'string') return null;
  if (descriptor.startsWith('[')) return descriptor;
  return descriptor.startsWith('L') && descriptor.endsWith(';') ? descriptor.slice(1, -1) : null;
}

function parameterTypes(method) {
  const descriptor = method?.descriptor || '';
  const result = [];
  const end = descriptor.indexOf(')');
  if (descriptor[0] !== '(' || end < 0) return result;
  for (let i = 1; i < end;) {
    const start = i;
    while (descriptor[i] === '[') i++;
    if (descriptor[i] === 'L') {
      const semicolon = descriptor.indexOf(';', i);
      if (semicolon < 0 || semicolon >= end) return [];
      i = semicolon + 1;
    } else i++;
    result.push(referenceType(descriptor.slice(start, i)));
  }
  return result;
}

function join(facts) {
  const ready = facts.filter(Boolean); // null internally denotes lattice bottom
  if (!ready.length) return null;
  const nullness = ready.every(f => f.nullness === ready[0].nullness) ? ready[0].nullness : 'maybe';
  const objects = ready.filter(f => f.nullness !== 'null');
  if (!objects.length) return NULL;
  const bounds = objects[0].upperBounds.filter(type => objects.every(f => f.upperBounds.includes(type)));
  const exact = objects.every(f => f.exactType === objects[0].exactType) ? objects[0].exactType : null;
  return fact(nullness, bounds, exact);
}

// A checkcast changes type knowledge but preserves reference identity. Copies
// already alias their SSA value. Phis deliberately keep a distinct identity:
// loop-carried references can change on every trip.
function createIdentityResolver() {
  const cache = new WeakMap();
  return function identity(value) {
    if (!value || value.op !== 'checkcast') return value;
    const trail = [];
    let root = value;
    while (root.op === 'checkcast' && root.args[0]) {
      const known = cache.get(root);
      if (known) { root = known; break; }
      trail.push(root); root = root.args[0];
    }
    for (const alias of trail) cache.set(alias, root);
    return root;
  };
}

function dereferenced(node) {
  return /^(getfield|putfield|arraylength|[bcsilfda]aload|[bcsilfda]astore|monitorenter|monitorexit|invokevirtual|invokeinterface|invokespecial)$/.test(node.op)
    ? node.args[0] : null;
}

function analyzeReferenceFacts(fn, options = {}) {
  const identity = createIdentityResolver();
  const values = fn.values.filter(value => value.kind === 'A');
  const facts = new Map(values.map(value => [value, null]));
  const types = parameterTypes(fn.method);
  const instance = !!fn.method && !(fn.method.flags || []).includes('static');
  if (instance) types.unshift(options.className || fn.method.className || null);
  const get = value => facts.get(value) || UNKNOWN;
  let valueComplete = true;
  const derive = value => {
    const arg = value.args[0], input = facts.get(arg);
    if (value.op === 'phi') return join(value.args.map(v => facts.has(v) ? facts.get(v) : UNKNOWN));
    if (value.op === 'param') return fact(instance && value === fn.params[0] ? 'nonnull' : 'maybe',
      [types[value.imm.index]]);
    if (value.op === 'aconst_null') return NULL;
    if (value.op === 'caught_exception') return fact('nonnull');
    if (value.op === 'checkcast') return input ? fact(input.nullness,
      [...input.upperBounds, typeof value.imm === 'string' ? value.imm : null], input.exactType) : null;
    if (value.op === 'new') return fact('nonnull', [value.imm], value.imm);
    if (value.op === 'newarray') {
      const type = ARRAY_TYPES[value.imm];
      return fact('nonnull', [type], type || null);
    }
    if (value.op === 'anewarray') {
      const type = typeof value.imm === 'string'
        ? '[' + (value.imm.startsWith('[') ? value.imm : `L${value.imm};`) : null;
      return fact('nonnull', [type], type);
    }
    if (value.op === 'multianewarray') {
      const type = Array.isArray(value.imm) ? value.imm[0] : value.imm?.type;
      return fact('nonnull', [referenceType(type)], referenceType(type));
    }
    if (value.op === 'getfield' || value.op === 'getstatic') return fact('maybe', [referenceType(value.imm?.[2]?.[1])]);
    if (value.op.startsWith('invoke')) {
      const descriptor = value.imm?.[2]?.[1];
      return fact('maybe', [referenceType(typeof descriptor === 'string' ? descriptor.slice(descriptor.indexOf(')') + 1) : null)]);
    }
    if (value.op === 'aaload') {
      if (!input) return null;
      return fact('maybe', input.upperBounds.filter(t => t.startsWith('[')).map(t => referenceType(t.slice(1))));
    }
    if (value.op === 'ldc' || value.op === 'ldc_w') {
      const literal = value.imm;
      const type = typeof literal === 'string' || literal?.type === 'String' ? 'java/lang/String'
        : literal?.type === 'Class' || Array.isArray(literal) && literal[0] === 'Class' ? 'java/lang/Class' : null;
      if (type) return fact('nonnull', [type], type);
    }
    return UNKNOWN; // opaque handler locals, unknown producers, native returns
  };
  // The shared builder already records def-use links; do not allocate a
  // second dependency graph for every consumer of reference facts.
  const queue = [...values], queued = new Set(queue);
  let work = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (++work > (options.maxValueWork ?? 200000)) {
      facts.clear(); valueComplete = false; break;
    }
    const value = queue[cursor]; queued.delete(value);
    const next = derive(value);
    if (same(facts.get(value), next)) continue;
    facts.set(value, next);
    for (const user of value.uses || []) if (facts.has(user) && !queued.has(user)) {
      queue.push(user); queued.add(user);
    }
  }

  // Sparse must-facts on normal edges. Handler entries start afresh. Facts
  // about a block's own definitions must be killed on re-entry, otherwise a
  // previous loop iteration could prove this iteration's fresh load non-null.
  let pathEntries = null, pathComplete = null;
  const events = new Map();
  const definitions = new Map();
  const nodesByItem = new Map();
  for (const node of fn.values) if (node.itemIdx != null) nodesByItem.set(node.itemIdx, node);
  const nullness = (value, state) => {
    const base = get(value).nullness;
    return base !== 'maybe' ? base : state?.get(identity(value)) || 'maybe';
  };
  const mark = (state, value, kind) => {
    const root = identity(value);
    if (root && get(root).nullness === 'maybe') state.set(root, kind);
  };
  const equalStates = (a, b) => !!a && a.size === b.size && [...a].every(([v, k]) => b.get(v) === k);
  const analyzePaths = () => {
    if (pathComplete !== null) return;
    // Consumers of global type facts need none of this edge state.
    for (const block of fn.blocks) {
      const nonnull = new Map(), defs = new Set();
      for (const node of [...block.phis, ...block.body]) {
        if (node.kind === 'A' && identity(node) === node) defs.add(node);
        const receiver = identity(dereferenced(node));
        if (receiver && node.itemIdx != null && !nonnull.has(receiver)) nonnull.set(receiver, node.itemIdx);
      }
      events.set(block.id, nonnull); definitions.set(block.id, defs);
    }
    pathEntries = new Map(); pathComplete = true;
    const edges = new Map(), pending = [...fn.reachable], waiting = new Set(pending);
    const empty = new Map(), count = fn.blocks.length;
    let entries = 0, steps = 0;
    const abort = () => { pathEntries.clear(); pathComplete = false; };
    for (let cursor = 0; cursor < pending.length; cursor++) {
      if (++steps > (options.maxPathWork ?? 200000)) { abort(); break; }
      const id = pending[cursor], block = fn.blocks[id]; waiting.delete(id);
      const inputs = block.predIds.map(pred => pred === 'entry' ? empty : edges.get(pred * count + id));
      const ready = inputs.filter(Boolean);
      if (id === fn.entry && !block.predIds.includes('entry') || block.isHandlerEntry) ready.push(empty);
      if (!ready.length) continue;
      const state = new Map([...ready[0]].filter(([v, k]) => ready.every(s => s.get(v) === k)));
      for (const value of definitions.get(id)) state.delete(value);
      for (const phi of block.phis) if (phi.kind === 'A') {
        const kinds = inputs.map((s, i) => s && nullness(phi.args[i], s)).filter(Boolean);
        if (kinds.length && kinds.every(k => k === kinds[0]) && kinds[0] !== 'maybe') mark(state, phi, kinds[0]);
      }
      const old = pathEntries.get(id);
      entries += state.size - (old?.size || 0);
      pathEntries.set(id, state);
      if (entries > (options.maxPathEntries ?? 32768)) { abort(); return; }
      const output = new Map(state);
      for (const receiver of events.get(id).keys()) mark(output, receiver, 'nonnull');
      const term = block.term;
      for (const successor of new Set(fn.cfg.succ[id] || [])) {
        const next = new Map(output);
        if (term.taken !== term.fall) {
          const taken = successor === term.taken;
          if (term.insnOp === 'ifnull' || term.insnOp === 'ifnonnull') {
            mark(next, term.args[0], taken === (term.insnOp === 'ifnull') ? 'null' : 'nonnull');
          } else if (term.insnOp === 'if_acmpeq' || term.insnOp === 'if_acmpne') {
            const [a, b] = term.args;
            const other = nullness(a, output) === 'null' ? b : nullness(b, output) === 'null' ? a : null;
            if (other) mark(next, other, taken === (term.insnOp === 'if_acmpeq') ? 'null' : 'nonnull');
          } else if ((term.insnOp === 'ifne' || term.insnOp === 'ifeq') && term.args[0]?.op === 'instanceof' &&
              taken === (term.insnOp === 'ifne')) mark(next, term.args[0].args[0], 'nonnull');
        }
        const key = id * count + successor, previous = edges.get(key);
        if (!equalStates(previous, next)) {
          entries += next.size - (previous?.size || 0);
          edges.set(key, next);
          if (entries > (options.maxPathEntries ?? 32768)) { abort(); return; }
          if (!waiting.has(successor)) { pending.push(successor); waiting.add(successor); }
        }
      }
      steps += inputs.reduce((n, s) => n + (s?.size || 0), 0) + block.phis.length;
      if (entries > (options.maxPathEntries ?? 32768)) { abort(); break; }
    }
  };

  return {
    get, identity, nodesByItem, valueComplete,
    get pathComplete() { analyzePaths(); return pathComplete; },
    // point is an SSA node, or a block id for its terminator. Do not use a
    // successful dereference to prove its OWN input safe before it executes.
    at(value, point) {
      if (!value || value.kind !== 'A') return UNKNOWN;
      const base = get(value);
      if (base.nullness !== 'maybe') return base;
      analyzePaths();
      const block = typeof point === 'number' ? point : point?.block;
      const before = typeof point === 'number' ? Infinity : point?.itemIdx ?? Infinity;
      const root = identity(value);
      let kind = nullness(value, pathEntries.get(block));
      if (base.nullness === 'maybe' && events.get(block)?.get(root) < before) kind = 'nonnull';
      return kind === base.nullness ? base : fact(kind, base.upperBounds, base.exactType);
    },
  };
}

module.exports = { analyzeReferenceFacts };
