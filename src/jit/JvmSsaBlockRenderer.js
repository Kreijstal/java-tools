const {
  buildCfgFromCode,
  structure,
  IrreducibleError,
  succOfTerm,
  succAllOfTerm,
} = require("../decompiler/structurer");
const { splitIrreducibleTerms } = require("../decompiler/exceptionStructurer");
const { parseDescriptor } = require("../parsing/typeParser");
const HandwrittenBilinearSampler = require("./HandwrittenBilinearSampler");
const STRUCTURED_CONTINUATION = Symbol("jvm.structuredSsaContinuation");

function isIrreducibleError(error) {
  return error instanceof IrreducibleError ||
    error?.name === "IrreducibleError" && Array.isArray(error.edges);
}

function normalizedArrayLoadExpression(raw, op, array) {
  switch (op) {
    case "baload":
      return `(${array}.type === "[Z" || ${array}.elementType === "boolean") ? ` +
        `(${raw} ? 1 : 0) : ((${raw} << 24) >> 24)`;
    case "caload": return `(${raw} & 0xffff)`;
    case "saload": return `((${raw} << 16) >> 16)`;
    case "iaload": return `((${raw}) | 0)`;
    case "faload": return `Math.fround(${raw})`;
    case "laload": return `BigInt.asIntN(64, BigInt(${raw}))`;
    case "aaload":
    case "daload":
    default:
      return raw;
  }
}

function runtimeClassNameExpression(value) {
  return `(typeof ${value} === "string" || ${value} instanceof String ` +
    `? "java/lang/String" : (${value}._className || ${value}.type))`;
}

// Makes one multiple-entry strongly connected component reducible by routing
// every edge into its entries through a synthetic single dispatcher header:
// each rerouted edge records its destination in a per-island state variable and
// jumps to a chain of state-test blocks that fans back out to the real entry.
// Unlike node splitting this adds a constant number of empty blocks, so code
// size stays linear. Entries must sit at operand-stack depth zero so the
// dispatcher carries no join slots. Setter blocks are duplicated per provenance
// (inside/outside the component) so every back edge targets a header that
// dominates it.
function dispatchIrreducibleCfg(cfg, depths, islandIndex) {
  const term = cfg.term;
  const n = term.length;
  const succ = term.map(succOfTerm);
  const index = new Array(n).fill(-1), low = new Array(n).fill(0);
  const stack = [], onStack = new Array(n).fill(false), components = [];
  let nextIndex = 0;
  const visit = (v) => {
    index[v] = low[v] = nextIndex++;
    stack.push(v); onStack[v] = true;
    for (const w of succ[v]) {
      if (w === null || w === undefined) continue;
      if (index[w] < 0) { visit(w); low[v] = Math.min(low[v], low[w]); }
      else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
    }
    if (low[v] === index[v]) {
      const component = [];
      for (;;) { const w = stack.pop(); onStack[w] = false; component.push(w); if (w === v) break; }
      components.push(component);
    }
  };
  for (let v = 0; v < n; v += 1) if (index[v] < 0) visit(v);

  let candidate = null;
  for (const component of components) {
    if (component.length === 1 && !succ[component[0]].includes(component[0])) continue;
    const inside = new Set(component), entries = [];
    for (const node of component) {
      let external = node === cfg.entry ? 1 : 0;
      for (let pred = 0; pred < n; pred += 1) {
        if (!inside.has(pred) && succ[pred].includes(node)) external += 1;
      }
      if (external) entries.push(node);
    }
    if (entries.length > 1) { candidate = { inside, entries: entries.sort((a, b) => a - b) }; break; }
  }
  if (!candidate) return null;
  const entries = candidate.entries;
  const entryDepths = [];
  for (const entry of entries) {
    const block = cfg.blocks[entry];
    if (!block || block.synthetic) return null;
    const depth = depths[block.insns[0]];
    if (!Number.isInteger(depth) || depth > 8) return null;
    entryDepths.push(depth);
  }

  const blocks = cfg.blocks.map((block) => ({ ...block }));
  const terms = term.map((descriptor) => ({ ...descriptor }));
  const stateVariable = `ssaDispatchState${islandIndex}`;
  const transferPrefix = `ssaIslandT${islandIndex}_`;
  const maxDepth = Math.max(...entryDepths);
  const entryPcs = entries.map((entry) => cfg.blocks[entry].insns[0]);
  const shared = {
    island: islandIndex, variable: stateVariable, transfer: transferPrefix,
    entryPcs, entryDepths, maxDepth,
  };
  const addBlock = (synthetic, descriptor) => {
    const id = blocks.length;
    blocks.push({ id, insns: [], synthetic });
    terms.push(descriptor);
    return id;
  };
  // Dispatcher chain: test states 0..k-2 in order; the final fall reaches the
  // last entry without a test. Chain blocks are created back to front.
  let chainNext = entries[entries.length - 1];
  for (let state = entries.length - 2; state >= 0; state -= 1) {
    chainNext = addBlock(
      { ...shared, kind: "dispatch", state },
      { kind: "cond", taken: entries[state], fall: chainNext },
    );
  }
  const dispatchHead = chainNext;
  const setterFor = new Map();
  const makeSetter = (entry, state, provenance) => addBlock(
    { ...shared, kind: "set", state, depth: entryDepths[state], provenance },
    { kind: "goto", target: dispatchHead },
  );
  entries.forEach((entry, state) => {
    setterFor.set(entry, {
      inside: makeSetter(entry, state, "inside"),
      outside: makeSetter(entry, state, "outside"),
    });
  });
  const remap = (u) => {
    const provenance = candidate.inside.has(u) ? "inside" : "outside";
    const reroute = (target) => setterFor.has(target) ? setterFor.get(target)[provenance] : target;
    const descriptor = terms[u];
    if (descriptor.kind === "goto" || descriptor.kind === "fall") {
      descriptor.target = reroute(descriptor.target);
    } else if (descriptor.kind === "cond") {
      descriptor.taken = reroute(descriptor.taken);
      descriptor.fall = reroute(descriptor.fall);
    }
  };
  for (let u = 0; u < n; u += 1) remap(u);
  const entryState = entries.indexOf(cfg.entry);
  return {
    ...cfg,
    n: blocks.length,
    blocks,
    term: terms,
    succ: terms.map(succOfTerm),
    succAll: terms.map(succAllOfTerm),
    entry: entryState >= 0 ? setterFor.get(cfg.entry).outside : cfg.entry,
  };
}

// Compiles verified reducible JVM control flow into lexical JavaScript.
// Instruction results are single-assignment values; control-flow edges feed
// live operand values into fixed successor-block join slots. Canonical Frame
// state is reconstructed only where the JVM can observe it. Acyclic regions
// use the same renderer without generator/safe-point machinery.
class JvmSsaBlockRenderer {
  constructor(jit, options = {}) {
    this.jit = jit;
    this.enabled = options.structuredSsa === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_STRUCTURED_SSA === "1");
    this.irreducibleSplittingEnabled = options.structuredIrreducibleSplitting === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_STRUCTURED_IRREDUCIBLE_SPLITTING === "1");
    this.dispatchIslandsEnabled = options.structuredDispatchIslands !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_DISPATCH_ISLANDS === "1");
    this.deferredCallMaterializationEnabled =
      options.structuredDeferredCallMaterialization !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_DEFERRED_CALL_MATERIALIZATION === "1");
    this.localValueNumberingEnabled = options.structuredLocalValueNumbering !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_LOCAL_VALUES === "1");
    this.guardedStaticBooleansEnabled = options.structuredGuardedStaticBooleans !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_STATIC_BOOLEAN_GUARDS === "1");
    this.continuationsEnabled = options.structuredContinuations !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_CONTINUATIONS === "1");
    this.coarseCountedLoopSafePointsEnabled =
      options.structuredCoarseCountedLoopSafePoints !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_COARSE_COUNTED_SAFEPOINTS === "1");
    this.atomicBoundedLoopsEnabled =
      options.structuredAtomicBoundedLoops !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_ATOMIC_BOUNDED_LOOPS === "1");
    this.dispatchIslandMethodCount = 0;
    this.dispatchIslandCount = 0;
    this.compiledLoopCount = 0;
    this.splitMethodCount = 0;
    this.splitBlockCount = 0;
    this.runCount = 0;
    this.safePointCount = 0;
    this.guardedBooleanMethodCount = 0;
    this.guardedBooleanSiteCount = 0;
    this.guardedBooleanFallbackCount = 0;
    this.restoredDirectExceptionFrameCount = 0;
    this.lastCompileError = null;
    this.lastRejectionReason = null;
  }

  compile(method) {
    this.lastCompileError = null;
    this.lastRejectionReason = null;
    const reject = (reason) => {
      this.lastRejectionReason = reason;
      return null;
    };
    if (!this.enabled || !this.jit.canCompileSynchronously(method)) {
      return reject("disabled or asynchronous");
    }
    const code = method.attributes.find((attribute) => attribute.type === "code");
    if (!code) return reject("missing code attribute");
    const items = this.jit.getCodeItems(method);
    // Throwing instructions below materialize their exact JVM PC, locals, and
    // operand stack before rethrowing. The ordinary JVM dispatcher can
    // therefore select any guest handler, and withResumeBody resumes that
    // handler in the baseline/interpreter rather than re-entering this
    // partially completed SSA invocation. Handler blocks need not be rendered
    // as part of normal control flow.
    let cfg = buildCfgFromCode(items);
    if (!cfg || cfg.term.some((term) => term.kind === "switch")) return reject("missing CFG or switch terminator");
    const labels = new Map();
    items.forEach((item, index) => {
      if (item?.labelDef) labels.set(String(item.labelDef).replace(/:$/, ""), index);
    });
    const depths = this.jit.computeStackDepths(items, labels);
    if (!depths) return reject("operand-stack verification failed");
    let structured;
    let splitBlocks = 0;
    let dispatchIslands = 0;
    try { structured = structure(cfg); } catch (error) {
      if (!isIrreducibleError(error)) {
        this.lastCompileError = error;
        return reject(`CFG structuring failed: ${error.message}`);
      }
      if (this.dispatchIslandsEnabled) {
        let current = cfg;
        for (let round = 0; round < 8 && !structured; round += 1) {
          const transformed = dispatchIrreducibleCfg(current, depths, dispatchIslands);
          if (!transformed) break;
          current = transformed;
          dispatchIslands += 1;
          try { structured = structure(current); cfg = current; } catch (retryError) {
            if (!isIrreducibleError(retryError)) break;
          }
        }
        if (!structured) dispatchIslands = 0;
      }
      if (!structured && this.irreducibleSplittingEnabled) {
        const maximumBlocks = Math.min(256, cfg.n * 2);
        const split = splitIrreducibleTerms(cfg.term, cfg.entry, { maxTerms: maximumBlocks });
        if (!split || split.terms.length > maximumBlocks) {
          this.lastCompileError = error;
          return reject(`CFG structuring failed: ${error.message}`);
        }
        const originalBlocks = cfg.blocks;
        cfg = {
          ...cfg,
          n: split.terms.length,
          term: split.terms,
          succ: split.terms.map(succOfTerm),
          succAll: split.terms.map(succAllOfTerm),
          blocks: split.origins.map((origin, id) => ({ ...originalBlocks[origin], id })),
        };
        splitBlocks = cfg.n - originalBlocks.length;
        try { structured = structure(cfg); } catch (retryError) {
          this.lastCompileError = retryError;
          return reject(`split CFG structuring failed: ${retryError.message}`);
        }
      }
      if (!structured) {
        this.lastCompileError = error;
        return reject(`CFG structuring failed: ${error.message}`);
      }
    }
    const localCount = Number(code.code.localsSize) || 0;
    const fieldSites = new Map();
    const directStaticSites = new Map();
    const directStaticOwners = new Set();
    const callSites = new Map();
    for (let index = 0; index < items.length; index += 1) {
      if (depths[index] === undefined) continue;
      const instruction = items[index]?.instruction;
      const op = typeof instruction === "string" ? instruction : instruction?.op;
      if (op === "getfield" || op === "putfield" || op === "getstatic" || op === "putstatic") {
        const fieldSite = this.jit.registerFieldSite(instruction.arg);
        fieldSites.set(index, fieldSite);
        if (op === "getstatic" || op === "putstatic") {
          const direct = this.jit.registerDirectStaticTarget(fieldSite, op === "putstatic");
          if (direct) {
            direct.variable = `ssaStaticFields${directStaticSites.size}`;
            direct.op = op;
            direct.descriptor = Array.isArray(instruction.arg?.[2])
              ? instruction.arg[2][1] : null;
            directStaticSites.set(index, direct);
            directStaticOwners.add(direct.className);
          }
        }
      } else if ((op === "invokestatic" || op === "invokevirtual" ||
          op === "invokespecial" || op === "invokeinterface") &&
          Array.isArray(instruction?.arg) && Array.isArray(instruction.arg[2])) {
        let descriptor;
        try { descriptor = parseDescriptor(instruction.arg[2][1]); } catch (_) {
          return reject(`invalid call descriptor at ${index}`);
        }
        if (!descriptor || !Array.isArray(descriptor.params)) return reject(`invalid call shape at ${index}`);
        const isStatic = op === "invokestatic";
        const directJre = this.jit.getCompileTimeDirectJre(op, instruction);
        const inline = directJre || !isStatic
          ? null : this.jit.getCompileTimeIntegerLeaf(instruction);
        const directIntrinsic = directJre || !isStatic || inline
          ? null : this.jit.getCompileTimeSynchronousIntrinsic(instruction);
        const directFused = directJre || !isStatic || inline || directIntrinsic
          ? null : this.jit.fusedRegions.getCompileTimeDirectCall(instruction);
        callSites.set(index, {
          id: directJre || inline || directIntrinsic
            ? null : this.jit.registerSyncCallSite(op, instruction),
          dynamic: op === "invokevirtual" || op === "invokeinterface",
          hasReceiver: !isStatic,
          argumentCount: descriptor.params.length + (isStatic ? 0 : 1),
          returnsVoid: descriptor.returnType === "void",
          directJre,
          inline,
          directIntrinsic,
          directFused,
        });
      }
    }
    // An initialized boolean static is a useful speculative constant when it
    // controls a large diagnostic/feature branch.  Bind only its location and
    // observed Java truth value, guard that value at entry before any guest
    // effect, and keep reading all non-boolean statics live.  A method that can
    // write the same location is deliberately excluded.  Selection uses only
    // the resolved field descriptor/location and bytecodes.
    const directTargetFor = (direct) => this.jit.directStaticTargets[direct.targetId];
    const directLocationEquals = (left, right) => {
      const a = directTargetFor(left), b = directTargetFor(right);
      return a && b && a.fields === b.fields && a.key === b.key;
    };
    const writtenStaticTargets = [...directStaticSites.values()]
      .filter((direct) => direct.op === "putstatic");
    const guardedStaticBooleanSites = new Map();
    if (this.guardedStaticBooleansEnabled) {
      for (const [index, direct] of directStaticSites) {
        if (direct.op !== "getstatic" || direct.descriptor !== "Z" ||
            this.jit.jvm.classInitializationState.get(direct.className) !== "INITIALIZED" ||
            writtenStaticTargets.some((written) => directLocationEquals(direct, written))) continue;
        const target = directTargetFor(direct);
        if (!target) continue;
        const raw = target.kind === "map" ? target.fields.get(target.key) : target.fields[target.key];
        direct.guardedBooleanValue = raw ? 1 : 0;
        guardedStaticBooleanSites.set(index, direct);
      }
    }
    let nextValue = 0;
    const value = () => `ssaValue${nextValue++}`;
    const plans = [];
    const continuationFallbacks = new Map();
    let deferredCallMaterializationCount = 0;
    let reusedLocalLoadCount = 0;
    let eliminatedLocalStoreCount = 0;
    let sentinelArrayLoadCount = 0;
    let eliminatedArrayStoreCheckCount = 0;
    const localIndex = (instruction, op) => {
      if (instruction && typeof instruction === "object" && instruction.arg !== undefined) {
        return Number(instruction.arg);
      }
      const match = /_([0-3])$/.exec(op || "");
      return match ? Number(match[1]) : NaN;
    };
    const opOf = (instruction) => !instruction ? null :
      (typeof instruction === "string" ? instruction : instruction.op);
    // A non-volatile field is stable for one synchronous generated entry when
    // the method contains neither an instance-field write nor a call that
    // could perform one. Cache repeated reads by symbolic field plus receiver
    // identity. The cache dies at a scheduler safe point, before another Java
    // thread can run. Selection is entirely bytecode/field-shape based.
    const hasUnknownFieldEffect = items.some((item) => {
      const op = opOf(item?.instruction);
      return op === "putfield" || op === "invokestatic" ||
        op === "invokevirtual" || op === "invokespecial" ||
        op === "invokeinterface";
    });
    const fieldReadCaches = new Map();
    const fieldReadCacheSites = new Map();
    if (!hasUnknownFieldEffect) {
      for (let index = 0; index < items.length; index += 1) {
        const instruction = items[index]?.instruction;
        if (opOf(instruction) !== "getfield" ||
            !this.jit.canEliminateFieldRead(instruction.arg)) continue;
        const key = JSON.stringify(instruction.arg);
        let cache = fieldReadCaches.get(key);
        if (!cache) {
          const number = fieldReadCaches.size;
          const site = fieldSites.get(index);
          cache = {
            object: `ssaFieldCache${number}Object`,
            value: `ssaFieldCache${number}Value`,
            valid: `ssaFieldCache${number}Valid`,
            data: `ssaFieldCache${number}ArrayData`,
            site,
            indexes: [],
            isArray: this.jit.fieldSites[site]?.descriptor?.startsWith("[") === true,
            directKey: this.jit.fieldSites[site]?.directInstanceKey || null,
          };
          fieldReadCaches.set(key, cache);
        }
        cache.indexes.push(index);
        fieldReadCacheSites.set(index, cache);
      }
    }
    const methodIsStatic = (method.flags || []).includes("static") ||
      (Number(method.accessFlags) & 0x0008) !== 0;
    const localZeroAssigned = items.some((item) => {
      const instruction = item?.instruction, op = opOf(instruction);
      return op === "astore_0" ||
        op === "astore" && Number(instruction?.arg) === 0;
    });
    const directlyLoadsThis = (index) => {
      const instruction = items[index - 1]?.instruction;
      const op = opOf(instruction);
      return op === "aload_0" ||
        op === "aload" && Number(instruction?.arg) === 0;
    };
    for (const cache of fieldReadCaches.values()) {
      cache.eagerThis = !methodIsStatic && !localZeroAssigned &&
        cache.indexes.every(directlyLoadsThis);
    }
    // javac has to give source-level temporaries a value before the first
    // structured try/loop join.  Decompiled methods can consequently start
    // with dozens of `iconst_0; istore` / `aconst_null; astore` pairs.  The
    // generated function already creates one JavaScript local for every JVM
    // slot, so fold a side-effect-free entry prefix into those declarations
    // instead of first reading stale Frame slots and then overwriting them.
    //
    // This is not dead-store elimination: the declared local has the exact
    // bytecode value at exceptions, scheduler safe points, and normal spills.
    // Stop at the first load, branch, field access, call, or other observable
    // instruction, and require the entire prefix to be in the unique entry
    // block so no control-flow edge can enter halfway through it.
    const entryLocalInitialValues = new Map();
    const foldedEntryStoreIndexes = new Set();
    const entryBlock = cfg.blocks[cfg.entry];
    if (entryBlock && !entryBlock.synthetic) {
      const constantStack = [];
      const literalForEntryInstruction = (instruction, op) => {
        if (op === "aconst_null") return "null";
        if (/^iconst_(?:m1|[0-5])$/.test(op)) {
          return op === "iconst_m1" ? "-1" : op.slice(-1);
        }
        if (op === "bipush" || op === "sipush") {
          const number = Number(instruction.arg);
          return Number.isInteger(number) ? String(number | 0) : null;
        }
        if (/^dconst_[01]$/.test(op) || /^fconst_[0-2]$/.test(op)) return op.slice(-1);
        if (op === "ldc" || op === "ldc_w" || op === "ldc2_w") {
          const arg = instruction && typeof instruction === "object" ? instruction.arg : undefined;
          const resolved = arg && typeof arg === "object" &&
            Object.prototype.hasOwnProperty.call(arg, "value") ? arg.value : arg;
          if (typeof resolved === "number" && Number.isFinite(resolved)) {
            if (Object.is(resolved, -0)) return "-0";
            return String(resolved);
          }
          if (typeof resolved === "bigint") return `${resolved}n`;
        }
        return null;
      };
      for (const index of entryBlock.insns) {
        const instruction = items[index]?.instruction;
        const op = opOf(instruction);
        if (!op || op === "nop") continue;
        const literal = literalForEntryInstruction(instruction, op);
        if (literal !== null) {
          constantStack.push(literal);
          continue;
        }
        if (/^[adfil]store(?:_[0-3])?$/.test(op) && constantStack.length) {
          const slot = localIndex(instruction, op);
          if (!Number.isInteger(slot) || slot < 0 || slot >= localCount) break;
          const input = constantStack.pop();
          entryLocalInitialValues.set(slot, input);
          foldedEntryStoreIndexes.add(index);
          continue;
        }
        break;
      }
    }
    const edgeLines = (target, stack) => {
      if (!Number.isInteger(target) || !cfg.blocks[target]) return null;
      const synthetic = cfg.blocks[target].synthetic;
      if (synthetic) {
        // Setter blocks receive the entry's live operands in island transfer
        // slots; dispatcher chain blocks carry nothing.
        const targetDepth = synthetic.kind === "set" ? synthetic.depth : 0;
        if (targetDepth !== stack.length) return null;
        return stack.map((expression, slot) => `${synthetic.transfer}${slot} = ${expression};`);
      }
      const targetDepth = depths[cfg.blocks[target].insns[0]];
      if (targetDepth !== stack.length) return null;
      return stack.map((expression, slot) => `ssaStack${target}_${slot} = ${expression};`);
    };
    // Frame reconstruction repeats at hundreds of sites in large bodies; the
    // locals copy is hoisted into one closure so emitted source stays small
    // enough for the engine to fully optimize the body.
    const materializeLines = (operandValues, pc) => [
      "spillLocals();",
      ...operandValues.map((expression, i) => `stack[${i}] = ${expression};`),
      `stack.length = ${operandValues.length};`,
      `helpers.materialize(frame, locals, stack, ${pc});`,
    ];
    const stageOperandLines = (operandValues) => [
      ...operandValues.map((expression, i) => `stack[${i}] = ${expression};`),
      `stack.length = ${operandValues.length};`,
    ];

    // Forward constant dataflow supplies block-entry local values after a
    // guarded static branch has made one CFG arm unreachable.  The analysis
    // is deliberately sparse: it understands constants, local transfers, and
    // branch stack effects; every other opcode produces unknown operands while
    // retaining the verifier-proven stack depth.  Stores are still emitted, so
    // exception/snapshot materialization remains byte-for-byte canonical.
    const blockEntryLocalConstants = new Map();
    if (guardedStaticBooleanSites.size && !cfg.blocks.some((block) => block.synthetic)) {
      const UNKNOWN = Symbol("unknown structured constant");
      const literal = (instruction, op) => {
        if (op === "aconst_null") return "null";
        if (/^iconst_(?:m1|[0-5])$/.test(op)) return op === "iconst_m1" ? "-1" : op.slice(-1);
        if (op === "bipush" || op === "sipush") {
          const number = Number(instruction.arg);
          return Number.isInteger(number) ? String(number | 0) : UNKNOWN;
        }
        if (/^dconst_[01]$/.test(op) || /^fconst_[0-2]$/.test(op)) return op.slice(-1);
        if (op === "ldc" || op === "ldc_w" || op === "ldc2_w") {
          const arg = instruction && typeof instruction === "object" ? instruction.arg : undefined;
          const resolved = arg && typeof arg === "object" &&
            Object.prototype.hasOwnProperty.call(arg, "value") ? arg.value : arg;
          if (typeof resolved === "number" && Number.isFinite(resolved)) {
            return Object.is(resolved, -0) ? "-0" : String(resolved);
          }
          if (typeof resolved === "bigint") return `${resolved}n`;
        }
        return UNKNOWN;
      };
      const stateAt = new Map();
      const initialDepth = depths[cfg.blocks[cfg.entry].insns[0]] || 0;
      stateAt.set(cfg.entry, {
        stack: new Array(initialDepth).fill(UNKNOWN),
        locals: new Array(localCount).fill(UNKNOWN),
      });
      const work = [cfg.entry];
      const nextDepth = (index, fallback) => {
        for (let next = index + 1; next < items.length; next += 1) {
          if (depths[next] !== undefined) return depths[next];
        }
        return fallback;
      };
      const mergeInto = (target, incoming) => {
        const previous = stateAt.get(target);
        if (!previous) {
          stateAt.set(target, {
            stack: [...incoming.stack], locals: [...incoming.locals],
          });
          return true;
        }
        let changed = false;
        for (let slot = 0; slot < previous.stack.length; slot += 1) {
          if (previous.stack[slot] !== incoming.stack[slot] && previous.stack[slot] !== UNKNOWN) {
            previous.stack[slot] = UNKNOWN; changed = true;
          }
        }
        for (let slot = 0; slot < previous.locals.length; slot += 1) {
          if (previous.locals[slot] !== incoming.locals[slot] && previous.locals[slot] !== UNKNOWN) {
            previous.locals[slot] = UNKNOWN; changed = true;
          }
        }
        return changed;
      };
      while (work.length) {
        const blockId = work.shift();
        const block = cfg.blocks[blockId], input = stateAt.get(blockId);
        if (!block || !input) continue;
        const stack = [...input.stack], localsState = [...input.locals];
        let knownCondition = null;
        const popKnown = () => stack.length ? stack.pop() : UNKNOWN;
        for (const index of block.insns) {
          const instruction = items[index]?.instruction, op = opOf(instruction);
          if (!op || op === "nop") continue;
          const constant = literal(instruction, op);
          if (constant !== UNKNOWN) stack.push(constant);
          else if (/^[adfil]load(?:_[0-3])?$/.test(op)) {
            stack.push(localsState[localIndex(instruction, op)] ?? UNKNOWN);
          } else if (/^[adfil]store(?:_[0-3])?$/.test(op)) {
            localsState[localIndex(instruction, op)] = popKnown();
          } else if (op === "iinc") {
            const slot = Number(instruction.varnum ?? instruction.arg);
            const increment = Number(instruction.incr ?? 0);
            const before = localsState[slot];
            localsState[slot] = typeof before === "string" && /^-?\d+$/.test(before)
              ? String((Number(before) + increment) | 0) : UNKNOWN;
          } else if (op === "pop") popKnown();
          else if (op === "dup") {
            const top = popKnown(); stack.push(top, top);
          } else if (op === "dup2") {
            const top = popKnown(), under = popKnown(); stack.push(under, top, under, top);
          } else if (op === "getstatic" && guardedStaticBooleanSites.has(index)) {
            stack.push(String(guardedStaticBooleanSites.get(index).guardedBooleanValue));
          } else if (op.startsWith("if")) {
            if (op.startsWith("if_icmp") || op.startsWith("if_acmp")) {
              const right = popKnown(), left = popKnown();
              if (left !== UNKNOWN && right !== UNKNOWN) {
                const a = left === "null" ? null : Number(left), b = right === "null" ? null : Number(right);
                knownCondition = op.endsWith("eq") ? a === b : op.endsWith("ne") ? a !== b
                  : op.endsWith("lt") ? a < b : op.endsWith("ge") ? a >= b
                    : op.endsWith("gt") ? a > b : a <= b;
              }
            } else {
              const inputValue = popKnown();
              if (inputValue !== UNKNOWN) {
                if (op === "ifnull" || op === "ifnonnull") {
                  knownCondition = op === "ifnull" ? inputValue === "null" : inputValue !== "null";
                } else if (/^-?\d+$/.test(inputValue)) {
                  const number = Number(inputValue);
                  knownCondition = op === "ifeq" ? number === 0 : op === "ifne" ? number !== 0
                    : op === "iflt" ? number < 0 : op === "ifge" ? number >= 0
                      : op === "ifgt" ? number > 0 : number <= 0;
                }
              }
            }
          } else if (op !== "goto" && op !== "goto_w" &&
              !/^(?:[adfil]?return|athrow)$/.test(op)) {
            stack.length = nextDepth(index, stack.length);
            stack.fill(UNKNOWN);
          }
        }
        blockEntryLocalConstants.set(blockId, input.locals.map((entry) =>
          entry === UNKNOWN ? null : entry));
        const term = cfg.term[blockId];
        let successors = cfg.succ[blockId] || [];
        if (term.kind === "cond" && knownCondition !== null) {
          successors = [knownCondition ? term.taken : term.fall];
        }
        for (const successor of successors) {
          if (!Number.isInteger(successor) || !cfg.blocks[successor]) continue;
          const targetDepth = depths[cfg.blocks[successor].insns[0]] || 0;
          const outgoing = {
            stack: stack.length === targetDepth ? [...stack] : new Array(targetDepth).fill(UNKNOWN),
            locals: [...localsState],
          };
          if (mergeInto(successor, outgoing)) work.push(successor);
        }
      }
    }

    for (const block of cfg.blocks) {
      if (block.synthetic) {
        const synthetic = block.synthetic;
        const descriptor = cfg.term[block.id];
        if (synthetic.kind === "set") {
          plans[block.id] = {
            lines: [`${synthetic.variable} = ${synthetic.state};`],
            stack: [],
          };
        } else {
          // The fan-out edge to a real entry feeds that entry's join slots
          // from the island transfer slots; edges within the chain are empty.
          const transfersFor = (target) => cfg.blocks[target]?.synthetic ? [] :
            Array.from({ length: synthetic.entryDepths[synthetic.entryPcs
              .indexOf(cfg.blocks[target].insns[0])] || 0 },
            (_unused, slot) => `${synthetic.transfer}${slot}`);
          plans[block.id] = {
            lines: [],
            condition: `${synthetic.variable} === ${synthetic.state}`,
            taken: descriptor.taken,
            fall: descriptor.fall,
            stack: [],
            takenStack: transfersFor(descriptor.taken),
            fallStack: transfersFor(descriptor.fall),
          };
        }
        continue;
      }
      const entryDepth = depths[block.insns[0]];
      if (entryDepth === undefined) { plans[block.id] = { lines: [], terminal: true }; continue; }
      const stack = Array.from({ length: entryDepth }, (_unused, slot) =>
        `ssaStack${block.id}_${slot}`);
      const lines = [];
      const arrayViews = new Map();
      // Repeated getstatic bytecodes in one straight-line block often load the
      // same framebuffer before a sequence of unrolled stores. Reuse that
      // value only within the block and only until a call/static write, so a
      // scheduler safe point or arbitrary guest effect can never stale it.
      const directStaticBlockValues = new Map();
      // A successful primitive load proves that the same array/index pair is
      // non-null and in bounds for the remainder of this straight-line basic
      // block. Java primitive arrays never contain `undefined`, so a raw
      // storage load can use it as the exceptional sentinel. A later store to
      // the identical raw view and immutable index can reuse that proof.
      //
      // Keep this block-local: calls, joins, and loop backedges must not carry
      // a proof across heap mutation or select it from the wrong predecessor.
      const checkedPrimitiveArrayAccesses = new Set();
      // JVM locals are mutable slots, but repeated loads within one basic
      // block see the same value until a store/iinc. Snapshot the first load
      // into an SSA value and reuse it. After a store the incoming stack value
      // already is immutable for the remainder of the block, so it becomes
      // the new cached value. This is deliberately block-local: carrying the
      // cache across a join would require phi construction and could otherwise
      // select a value from the wrong predecessor.
      const localValues = blockEntryLocalConstants.has(block.id)
        ? [...blockEntryLocalConstants.get(block.id)] : new Array(localCount).fill(null);
      const readLocal = (slot) => {
        const cached = localValues[slot];
        if (this.localValueNumberingEnabled && cached !== null) {
          reusedLocalLoadCount += 1;
          return cached;
        }
        const out = value();
        lines.push(`const ${out} = local${slot};`);
        if (this.localValueNumberingEnabled) localValues[slot] = out;
        return out;
      };
      let condition = null;
      let conditionConstant = null;
      let returnKind = null;
      let returnValue = null;
      let valid = true;
      let invalidAt = null;
      const pop = () => stack.length ? stack.pop() : null;
      const binary = (format) => {
        const right = pop(), left = pop();
        if (left === null || right === null) { valid = false; return; }
        const out = value(); lines.push(`const ${out} = ${format(left, right)};`); stack.push(out);
      };
      const numberLiteral = (constant) => {
        if (Object.is(constant, -0)) return "-0";
        if (constant !== constant) return "NaN";
        if (constant === Infinity) return "Infinity";
        if (constant === -Infinity) return "-Infinity";
        return String(constant);
      };
      const resolveConstant = (arg) =>
        (arg && typeof arg === "object" && Object.prototype.hasOwnProperty.call(arg, "value"))
          ? arg.value : arg;
      for (const index of block.insns) {
        const instruction = items[index]?.instruction;
        const op = opOf(instruction);
        if (!op || op === "nop") continue;
        if (/^[adfil]load(?:_[0-3])?$/.test(op)) {
          const slot = localIndex(instruction, op);
          if (!Number.isInteger(slot) || slot < 0 || slot >= localCount) valid = false;
          else stack.push(readLocal(slot));
        } else if (/^[adfil]store(?:_[0-3])?$/.test(op)) {
          const input = pop();
          const slot = localIndex(instruction, op);
          if (input === null || !Number.isInteger(slot) || slot < 0 || slot >= localCount) valid = false;
          else {
            if (foldedEntryStoreIndexes.has(index)) {
              eliminatedLocalStoreCount += 1;
            }
            else if (this.localValueNumberingEnabled && localValues[slot] === input) {
              eliminatedLocalStoreCount += 1;
            }
            else lines.push(`local${slot} = ${input};`);
            localValues[slot] = this.localValueNumberingEnabled ? input : null;
          }
        } else if (op === "aconst_null") stack.push("null");
        else if (/^iconst_(?:m1|[0-5])$/.test(op)) {
          stack.push(op === "iconst_m1" ? "-1" : op.slice(-1));
        } else if (op === "bipush" || op === "sipush") {
          const constant = Number(instruction.arg);
          if (!Number.isFinite(constant) || !Number.isInteger(constant)) valid = false;
          else stack.push(String(constant | 0));
        } else if (op === "ldc" || op === "ldc_w") {
          const resolved = resolveConstant(instruction.arg);
          if (typeof resolved === "number" && Number.isFinite(resolved) &&
              Number.isInteger(resolved) && !Object.is(resolved, -0)) {
            stack.push(String(resolved | 0));
          } else if (typeof resolved === "number") {
            stack.push(numberLiteral(resolved));
          } else if (typeof resolved === "string") {
            // Java string constants are interned once per site at runtime.
            const out = value();
            lines.push(`const ${out} = helpers.constantValue(${JSON.stringify(resolved)});`);
            stack.push(out);
          } else valid = false;
        } else if (op === "ldc2_w") {
          const resolved = resolveConstant(instruction.arg);
          if (typeof resolved === "number" && Number.isFinite(resolved)) {
            stack.push(numberLiteral(resolved));
          } else if (typeof resolved === "bigint") {
            stack.push(`${resolved}n`);
          } else valid = false;
        } else if (/^dconst_[01]$/.test(op) || /^fconst_[0-2]$/.test(op)) {
          stack.push(op.slice(-1));
        } else if (op === "dup") {
          const input = pop();
          if (input === null) valid = false;
          else {
            const out = value();
            lines.push(`const ${out} = ${input};`);
            stack.push(out, out);
            if (arrayViews.has(input)) arrayViews.set(out, arrayViews.get(input));
          }
        } else if (op === "dup2") {
          // The interpreter and generated tiers treat dup2 as the two
          // category-1 form unless the top is a BigInt long; mirror that and
          // fall back before any effect when a long is observed.
          const topInput = pop(), underInput = pop();
          if (topInput === null || underInput === null) valid = false;
          else {
            const top = value(), under = value();
            lines.push(`const ${top} = ${topInput};`, `const ${under} = ${underInput};`,
              `if (typeof ${top} === "bigint") {`,
              ...materializeLines([...stack, under, top], index).map((line) => `  ${line}`),
              "  helpers.skipJitOnce(frame);",
              "  return { deopt: true, transient: true, reason: 'category-2 dup2 in structured SSA' };", "}");
            stack.push(under, top, under, top);
          }
        } else if (op === "pop") {
          if (pop() === null) valid = false;
        } else if (op === "iadd") binary((a, b) => `((${a} + ${b}) | 0)`);
        else if (op === "isub") binary((a, b) => `((${a} - ${b}) | 0)`);
        else if (op === "imul") binary((a, b) => `Math.imul(${a}, ${b})`);
        else if (op === "iand") binary((a, b) => `(${a} & ${b})`);
        else if (op === "ior") binary((a, b) => `(${a} | ${b})`);
        else if (op === "ixor") binary((a, b) => `(${a} ^ ${b})`);
        else if (op === "ishl") binary((a, b) => `(${a} << (${b} & 31))`);
        else if (op === "ishr") binary((a, b) => `(${a} >> (${b} & 31))`);
        else if (op === "iushr") binary((a, b) => `((${a} >>> (${b} & 31)) | 0)`);
        else if (op === "dadd") binary((a, b) => `(${a} + ${b})`);
        else if (op === "dsub") binary((a, b) => `(${a} - ${b})`);
        else if (op === "dmul") binary((a, b) => `(${a} * ${b})`);
        else if (op === "ddiv") binary((a, b) => `(${a} / ${b})`);
        else if (op === "drem") binary((a, b) => `(${a} % ${b})`);
        else if (op === "fadd") binary((a, b) => `Math.fround(${a} + ${b})`);
        else if (op === "fsub") binary((a, b) => `Math.fround(${a} - ${b})`);
        else if (op === "fmul") binary((a, b) => `Math.fround(${a} * ${b})`);
        else if (op === "fdiv") binary((a, b) => `Math.fround(${a} / ${b})`);
        else if (op === "frem") binary((a, b) => `Math.fround(${a} % ${b})`);
        else if (op === "dcmpl" || op === "dcmpg" || op === "fcmpl" || op === "fcmpg") {
          const nan = op.endsWith("g") ? "1" : "-1";
          binary((a, b) => `(${a} < ${b} ? -1 : ${a} > ${b} ? 1 : ${a} === ${b} ? 0 : ${nan})`);
        }
        else if (op === "ineg" || op === "i2b" || op === "i2s" || op === "i2c" ||
            op === "dneg" || op === "fneg" || op === "i2d" || op === "f2d" ||
            op === "i2f" || op === "d2f" || op === "d2i" || op === "f2i") {
          const input = pop();
          if (input === null) valid = false;
          else {
            // Match the generated baseline tier exactly (NaN -> 0, truncate
            // toward zero, wrap): tier-consistent narrowing keeps differential
            // hashes comparable across tiers.
            const narrowed = `(Math.trunc(${input}) | 0)`;
            const expressions = {
              ineg: `(-${input}) | 0`,
              i2b: `((${input} << 24) >> 24)`,
              i2s: `((${input} << 16) >> 16)`,
              i2c: `(${input} & 0xffff)`,
              dneg: `(-${input})`,
              fneg: `Math.fround(-${input})`,
              i2d: `${input}`,
              f2d: `${input}`,
              i2f: `Math.fround(${input})`,
              d2f: `Math.fround(${input})`,
              d2i: narrowed,
              f2i: narrowed,
            };
            const out = value();
            lines.push(`const ${out} = ${expressions[op]};`);
            stack.push(out);
          }
        }
        else if (op === "idiv" || op === "irem") {
          const divisorInput = pop(), dividendInput = pop();
          if (divisorInput === null || dividendInput === null) valid = false;
          else {
            const dividend = value(), divisor = value(), out = value();
            lines.push(`const ${dividend} = ${dividendInput};`, `const ${divisor} = ${divisorInput};`);
            lines.push(`if (${divisor} === 0) {`,
              ...materializeLines([...stack, dividend, divisor], index).map((line) => `  ${line}`),
              '  throw { type: "java/lang/ArithmeticException", message: "/ by zero" };', "}");
            lines.push(`const ${out} = ((${dividend} ${op === "idiv" ? "/" : "%"} ${divisor}) | 0);`);
            stack.push(out);
          }
        }
        else if (op === "iinc") {
          const slot = Number(instruction.varnum ?? instruction.arg);
          const increment = Number(instruction.incr ?? 0);
          if (!Number.isInteger(slot) || slot < 0 || slot >= localCount || !Number.isInteger(increment)) {
            valid = false;
          } else if (!this.localValueNumberingEnabled) {
            lines.push(`local${slot} = (local${slot} + ${increment}) | 0;`);
          } else {
            const previous = readLocal(slot);
            const out = value();
            lines.push(`const ${out} = (${previous} + ${increment}) | 0;`,
              `local${slot} = ${out};`);
            localValues[slot] = out;
          }
        } else if (op === "arraylength") {
          const arrayInput = pop();
          if (arrayInput === null) valid = false;
          else {
            const array = value(), out = value();
            lines.push(`const ${array} = ${arrayInput};`);
            lines.push(`if (${array} === null || ${array} === undefined) {`,
              ...materializeLines([...stack, array], index).map((line) => `  ${line}`),
              `  helpers.arrayLength(${array}, frame);`, "}",
              `const ${out} = ${array}.length;`);
            stack.push(out);
          }
        } else if (op === "iaload" || op === "saload" || op === "aaload" ||
            op === "baload" || op === "caload" || op === "daload" ||
            op === "faload" || op === "laload") {
          const arrayIndexInput = pop(), arrayInput = pop();
          if (arrayIndexInput === null || arrayInput === null) valid = false;
          else {
            const array = value(), arrayIndex = value(), out = value();
            const arrayData = arrayViews.get(arrayInput);
            const primitiveSentinel = op !== "aaload" && arrayData;
            lines.push(`const ${array} = ${arrayInput};`, `const ${arrayIndex} = ${arrayIndexInput};`,
              `let ${out};`);
            if (primitiveSentinel) {
              const normalized = normalizedArrayLoadExpression(out, op, array);
              lines.push(
                `if (${arrayData} === null || (${out} = ${arrayData}[${arrayIndex}]) === undefined) {`,
                ...materializeLines([...stack, array, arrayIndex], index).map((line) => `  ${line}`),
                `  ${out} = helpers.arrayLoad(${arrayIndex}, ${array}, frame, ${JSON.stringify(op)});`,
                "} else {",
                `  ${out} = ${normalized};`,
                "}",
              );
              checkedPrimitiveArrayAccesses.add(`${arrayData}\0${arrayIndexInput}`);
              sentinelArrayLoadCount += 1;
            } else {
              const raw = arrayData
                ? `${arrayData} !== null ? ${arrayData}[${arrayIndex}] : ` +
                  `(${array}.elements ? ${array}.elements[${arrayIndex}] : ${array}[${arrayIndex}])`
                : `${array}.elements ? ${array}.elements[${arrayIndex}] : ${array}[${arrayIndex}]`;
              const normalized = normalizedArrayLoadExpression(raw, op, array);
              lines.push(
                `if (${array} === null || ${array} === undefined || ${arrayIndex} < 0 || ${arrayIndex} >= ${array}.length) {`,
                ...materializeLines([...stack, array, arrayIndex], index).map((line) => `  ${line}`),
                `  ${out} = helpers.arrayLoad(${arrayIndex}, ${array}, frame, ${JSON.stringify(op)});`,
                "} else {", `  ${out} = ${normalized};`, "}",
              );
            }
            stack.push(out);
          }
        } else if (op === "iastore" || op === "sastore" || op === "bastore" ||
            op === "castore" || op === "dastore" || op === "fastore" ||
            op === "lastore" || op === "aastore") {
          const storedInput = pop(), arrayIndexInput = pop(), arrayInput = pop();
          if (storedInput === null || arrayIndexInput === null || arrayInput === null) valid = false;
          else {
            const array = value(), arrayIndex = value(), stored = value();
            const arrayData = arrayViews.get(arrayInput);
            lines.push(`const ${array} = ${arrayInput};`, `const ${arrayIndex} = ${arrayIndexInput};`,
              `const ${stored} = ${storedInput};`);
            // The opcode already fixes primitive int-array narrowing; keep it
            // as an integer expression in the generated block instead of a
            // megamorphic helper call for every pixel.
            const normalizedStore = op === "iastore"
              ? `((${stored}) | 0)`
              : `helpers.normalizeArrayStore(${stored}, ${JSON.stringify(op)}, ${array})`;
            const checkedKey = arrayData && `${arrayData}\0${arrayIndexInput}`;
            if (op !== "aastore" && checkedKey &&
                checkedPrimitiveArrayAccesses.has(checkedKey)) {
              lines.push(`${arrayData}[${arrayIndex}] = ${normalizedStore};`);
              eliminatedArrayStoreCheckCount += 1;
            } else {
              lines.push(
                `if (${array} === null || ${array} === undefined || ${arrayIndex} < 0 || ${arrayIndex} >= ${array}.length) {`,
                ...materializeLines([...stack, array, arrayIndex, stored], index).map((line) => `  ${line}`),
                `  helpers.arrayStore(${stored}, ${arrayIndex}, ${array}, frame, ${JSON.stringify(op)});`,
                ...(arrayData ? [
                  `} else if (${arrayData} !== null) {`,
                  `  ${arrayData}[${arrayIndex}] = ${normalizedStore};`,
                ] : []),
                `} else if (${array}.elements) {`, `  ${array}.elements[${arrayIndex}] = ${normalizedStore};`,
                "} else {", `  ${array}[${arrayIndex}] = ${normalizedStore};`, "}",
              );
            }
          }
        } else if (op === "newarray") {
          const countInput = pop();
          if (countInput === null) valid = false;
          else {
            const count = value(), out = value(), caught = value();
            lines.push(`const ${count} = ${countInput};`, `let ${out};`,
              `try { ${out} = helpers.newPrimitiveArray(${count}, ${JSON.stringify(instruction.arg)}); } catch (${caught}) {`,
              ...materializeLines([...stack, count], index).map((line) => `  ${line}`),
              `  throw ${caught};`, "}");
            stack.push(out);
          }
        } else if (op === "anewarray") {
          const countInput = pop();
          if (countInput === null) valid = false;
          else {
            const count = value(), out = value(), caught = value();
            lines.push(`const ${count} = ${countInput};`, `let ${out};`,
              `try { ${out} = helpers.newReferenceArray(${count}, ${JSON.stringify(instruction.arg)}); } catch (${caught}) {`,
              ...materializeLines([...stack, count], index).map((line) => `  ${line}`),
              `  throw ${caught};`, "}");
            stack.push(out);
          }
        } else if (op === "checkcast") {
          const input = stack[stack.length - 1];
          if (input === undefined) valid = false;
          else {
            const castValue = value(), source = value(), checked = value(), caught = value();
            const target = JSON.stringify(instruction.arg);
            lines.push(`const ${castValue} = ${input};`,
              `if (${castValue} !== null && ${castValue} !== undefined) {`,
              `  const ${source} = ${runtimeClassNameExpression(castValue)};`,
              `  if (${source} !== ${target}) {`,
              `    let ${checked};`,
              `    try { ${checked} = helpers.tryCheckCastSourceSync(${source}, ${target}); } catch (${caught}) {`,
              ...materializeLines(stack, index).map((line) => `  ${line}`), `  throw ${caught};`, "}",
              `    if (${checked} === helpers.asyncInvokeSentinel()) {`,
              ...materializeLines(stack, index).map((line) => `    ${line}`),
              "      helpers.skipJitOnce(frame);",
              "      return { deopt: true, transient: true, reason: 'cold structured SSA checkcast' };",
              "    }",
              "  }",
              "}");
          }
        } else if (op === "getfield") {
          const objectInput = pop(), site = fieldSites.get(index);
          if (objectInput === null || site === undefined) valid = false;
          else {
            const object = value(), out = value();
            const cache = fieldReadCacheSites.get(index);
            const directKey = this.jit.fieldSites[site]?.directInstanceKey || null;
            const directRead = directKey
              ? `(${object}.fields && ${object}.fields[${JSON.stringify(directKey)}] !== undefined ? ` +
                `${object}.fields[${JSON.stringify(directKey)}] : helpers.getFieldAt(${site}, ${object}))`
              : `helpers.getFieldAt(${site}, ${object})`;
            lines.push(`const ${object} = ${objectInput};`);
            if (cache?.eagerThis) {
              lines.push(`const ${out} = ${cache.value};`);
              if (cache.isArray) arrayViews.set(out, cache.data);
            } else {
              lines.push(`if (${object} === null || ${object} === undefined) {`,
                ...materializeLines([...stack, object], index).map((line) => `  ${line}`),
                `  helpers.getFieldAt(${site}, ${object});`, "}");
            }
            if (cache && !cache.eagerThis) {
              lines.push(`let ${out};`,
                `if (${cache.valid} && ${cache.object} === ${object}) {`,
                `  ${out} = ${cache.value};`, "} else {",
                `  ${out} = ${directRead};`,
                `  ${cache.object} = ${object};`,
                `  ${cache.value} = ${out};`,
                ...(cache.isArray ? [`  ${cache.data} = helpers.arrayData(${out});`] : []),
                `  ${cache.valid} = true;`, "}");
              if (cache.isArray) arrayViews.set(out, cache.data);
            } else if (!cache) {
              lines.push(`const ${out} = ${directRead};`);
            }
            stack.push(out);
          }
        } else if (op === "putfield") {
          const storedInput = pop(), objectInput = pop(), site = fieldSites.get(index);
          if (storedInput === null || objectInput === null || site === undefined) valid = false;
          else {
            const object = value(), stored = value();
            const fieldPlan = this.jit.fieldSites[site];
            const directKey = fieldPlan?.directInstanceKey || null;
            lines.push(`const ${object} = ${objectInput};`, `const ${stored} = ${storedInput};`,
              `if (${object} === null || ${object} === undefined) {`,
              ...materializeLines([...stack, object, stored], index).map((line) => `  ${line}`),
              `  helpers.putFieldAt(${site}, ${object}, ${stored});`, "}",
              ...(directKey ? [
                `if (${object}.fields) {`,
                `  ${object}.fields[${JSON.stringify(directKey)}] = ${stored};`,
                `  ${object}[${JSON.stringify(fieldPlan.fieldName)}] = ${stored};`,
                "} else {",
                `  helpers.putFieldAt(${site}, ${object}, ${stored});`,
                "}",
              ] : [`helpers.putFieldAt(${site}, ${object}, ${stored});`]));
          }
        } else if (op === "new") {
          const out = value();
          lines.push(`const ${out} = helpers.newObjectSync(${JSON.stringify(instruction.arg)});`,
            `if (${out} === helpers.staticDeopt()) {`,
            ...materializeLines(stack, index).map((line) => `  ${line}`),
            "  helpers.skipJitOnce(frame);",
            "  return { deopt: true, transient: true, reason: 'class initialization in structured SSA new' };", "}");
          stack.push(out);
        } else if (op === "getstatic") {
          const site = fieldSites.get(index), direct = directStaticSites.get(index), out = value();
          if (site === undefined) valid = false;
          else if (direct && guardedStaticBooleanSites.has(index)) {
            stack.push(String(direct.guardedBooleanValue));
          }
          else if (direct) {
            const key = JSON.stringify(direct.key);
            const location = `${direct.className}\0${direct.key}`;
            const cached = directStaticBlockValues.get(location);
            if (cached) {
              stack.push(cached.value);
              if (cached.data) arrayViews.set(cached.value, cached.data);
            } else {
              lines.push(`const ${out} = ${direct.kind === "map"
                ? `${direct.variable}.get(${key})` : `${direct.variable}[${key}]`};`);
              stack.push(out);
              let data = null;
              if (direct.descriptor?.startsWith("[")) {
                data = value();
                lines.push(`const ${data} = helpers.arrayData(${out});`);
                arrayViews.set(out, data);
              }
              directStaticBlockValues.set(location, { value: out, data });
            }
          }
          else {
            lines.push(`const ${out} = helpers.getStaticSyncAt(${site});`,
              `if (${out} === helpers.staticDeopt()) {`,
              ...materializeLines(stack, index).map((line) => `  ${line}`),
              "  helpers.skipJitOnce(frame);",
              "  return { deopt: true, transient: true, reason: 'class initialization in structured SSA getstatic' };", "}");
            stack.push(out);
          }
        } else if (op === "putstatic") {
          directStaticBlockValues.clear();
          const input = pop(), site = fieldSites.get(index), direct = directStaticSites.get(index),
            changed = value();
          if (input === null || site === undefined) valid = false;
          else if (direct) lines.push(`${direct.variable}.set(${JSON.stringify(direct.key)}, ${input});`);
          else lines.push(`const ${changed} = helpers.putStaticSyncAt(${site}, ${input});`,
            `if (${changed} === helpers.staticDeopt()) {`,
            ...materializeLines([...stack, input], index).map((line) => `  ${line}`),
            "  helpers.skipJitOnce(frame);",
            "  return { deopt: true, transient: true, reason: 'class initialization in structured SSA putstatic' };", "}");
        } else if (op === "invokestatic" || op === "invokevirtual" ||
            op === "invokespecial" || op === "invokeinterface") {
          directStaticBlockValues.clear();
          const site = callSites.get(index);
          if (!site || stack.length < site.argumentCount) valid = false;
          else if (site.directJre) {
            const callStack = [...stack];
            const args = new Array(site.argumentCount);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const out = value(), caught = value();
              lines.push(`let ${out};`,
                `try { ${out} = helpers.directJreIntrinsics[${site.directJre.id}](${args.join(", ")}); } catch (${caught}) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                `  throw ${caught};`, "}");
              if (!site.returnsVoid) stack.push(out);
            }
          }
          else if (site.inline) {
            const args = new Array(site.inline.paramCount);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const out = value();
              const substitute = (source) => source.replace(/stack\[base \+ (\d+)\]/g,
                (_match, argument) => `(${args[Number(argument)]})`);
              lines.push(`let ${out};`, "{",
                ...site.inline.statements.map((statement) => `  ${substitute(statement)}`),
                `  ${out} = ${substitute(site.inline.result)};`, "}");
              stack.push(out);
            }
          } else if (site.directIntrinsic?.kind === "primitiveArrayCopy" &&
              site.directIntrinsic.paramCount === 5 && site.directIntrinsic.returnsVoid) {
            const callStack = [...stack];
            const args = new Array(5);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const caught = value();
              lines.push(`try { helpers.primitiveArrayCopyDirect(${args.join(", ")}); } catch (${caught}) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                `  throw ${caught};`, "}");
            }
          } else if (site.directIntrinsic?.kind === "clippedStaticSpan" &&
              site.directIntrinsic.paramCount === 4 && site.directIntrinsic.returnsVoid &&
              site.directIntrinsic.staticFieldSites?.length === 6) {
            const callStack = [...stack];
            const args = new Array(4);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const result = value(), caught = value();
              const fields = site.directIntrinsic.staticFieldSites.join(", ");
              lines.push(`let ${result};`,
                `try { ${result} = helpers.clippedStaticSpanDirectAt(${args.join(", ")}, ${fields}); } catch (${caught}) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                `  throw ${caught};`, "}",
                `if (${result} === helpers.staticDeopt()) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                "  helpers.skipJitOnce(frame);",
                "  return { deopt: true, transient: true, reason: 'class initialization in direct structured span' };", "}");
            }
          } else if (site.directIntrinsic?.kind === "clippedStaticAlphaSpan" &&
              site.directIntrinsic.paramCount === 5 && site.directIntrinsic.returnsVoid &&
              site.directIntrinsic.staticFieldSites?.length === 6) {
            const callStack = [...stack];
            const args = new Array(5);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const result = value(), caught = value();
              const fields = site.directIntrinsic.staticFieldSites.join(", ");
              lines.push(`let ${result};`,
                `try { ${result} = helpers.clippedStaticAlphaSpanDirectAt(${args.join(", ")}, ${fields}); } catch (${caught}) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                `  throw ${caught};`, "}",
                `if (${result} === helpers.staticDeopt()) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                "  helpers.skipJitOnce(frame);",
                "  return { deopt: true, transient: true, reason: 'class initialization in direct structured alpha span' };", "}");
            }
          } else if (site.directIntrinsic?.kind === "clippedStaticGradient" &&
              site.directIntrinsic.paramCount === 6 && site.directIntrinsic.returnsVoid &&
              site.directIntrinsic.staticFieldSites?.length === 6) {
            const callStack = [...stack];
            const args = new Array(6);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const result = value(), caught = value();
              const fields = site.directIntrinsic.staticFieldSites.join(", ");
              lines.push(`let ${result};`,
                `try { ${result} = helpers.clippedStaticGradientDirectAt(${args.join(", ")}, ${fields}); } catch (${caught}) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                `  throw ${caught};`, "}",
                `if (${result} === helpers.staticDeopt()) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                "  helpers.skipJitOnce(frame);",
                "  return { deopt: true, transient: true, reason: 'class initialization in direct structured gradient' };", "}");
            }
          } else if ((site.directIntrinsic?.kind === "polygonFlatRaster" ||
              site.directIntrinsic?.kind === "polygonAlphaRaster" ||
              site.directIntrinsic?.kind === "tiledIntArrayBlit" ||
              site.directIntrinsic?.kind === "perspectiveTexturedSpan") &&
              Number.isInteger(site.directIntrinsic.positionalId) &&
              site.directIntrinsic.returnsVoid) {
            const callStack = [...stack];
            const args = new Array(site.argumentCount);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const result = value(), caught = value();
              lines.push(`let ${result};`,
                `try { ${result} = helpers.directSynchronousIntrinsics[${site.directIntrinsic.positionalId}](${args.join(", ")}); } catch (${caught}) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                `  throw ${caught};`, "}",
                `if (${result} === helpers.asyncInvokeSentinel()) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                "  helpers.skipJitOnce(frame);",
                "  return { deopt: true, transient: true, reason: 'guarded polygon raster fallback' };", "}");
            }
          } else if (site.directIntrinsic?.kind === "maskedColorBlit" &&
              site.directIntrinsic.paramCount === 9 && site.directIntrinsic.returnsVoid) {
            const callStack = [...stack];
            const args = new Array(9);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const caught = value();
              lines.push(`try { helpers.maskedColorBlitDirect(${args.join(", ")}); } catch (${caught}) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                `  throw ${caught};`, "}");
            }
          } else if (site.directIntrinsic?.kind === "alphaMaskedColorBlit" &&
              site.directIntrinsic.paramCount === 10 &&
              site.directIntrinsic.returnsVoid) {
            const callStack = [...stack];
            const args = new Array(10);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const caught = value();
              if (site.directIntrinsic.initializationOwner) {
                lines.push(`if (helpers.jvm.classInitializationState.get(${
                  JSON.stringify(site.directIntrinsic.initializationOwner)
                }) !== "INITIALIZED") {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                "  helpers.skipJitOnce(frame);",
                "  return { deopt: true, transient: true, reason: 'class initialization in direct alpha-masked blit' };",
                "}");
              }
              lines.push(`try { helpers.alphaMaskedColorBlitDirect(${args.join(", ")}); } catch (${caught}) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                `  throw ${caught};`, "}");
            }
          } else if (site.directIntrinsic?.kind === "transparentIntBlit" &&
              site.directIntrinsic.paramCount === 9 &&
              site.directIntrinsic.returnsVoid) {
            const callStack = [...stack];
            const args = new Array(9);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const caught = value();
              if (site.directIntrinsic.initializationOwner) {
                lines.push(`if (helpers.jvm.classInitializationState.get(${
                  JSON.stringify(site.directIntrinsic.initializationOwner)
                }) !== "INITIALIZED") {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                "  helpers.skipJitOnce(frame);",
                "  return { deopt: true, transient: true, reason: 'class initialization in direct transparent int blit' };",
                "}");
              }
              lines.push(`try { helpers.transparentIntBlitDirect(${args.join(", ")}); } catch (${caught}) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                `  throw ${caught};`, "}");
            }
          } else if (site.directFused && site.directFused.returnsVoid &&
              site.directFused.paramCount === site.argumentCount) {
            const callStack = [...stack];
            const args = new Array(site.argumentCount);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const handled = value(), out = value(), caught = value();
              const deferMaterialization = this.deferredCallMaterializationEnabled;
              const asynchronousFallbackMarker =
                `__JVM_ASYNC_FUSED_FALLBACK_${index}_${site.id}__`;
              continuationFallbacks.set(asynchronousFallbackMarker, {
                continuation: [
                  ...materializeLines(callStack, index).map((line) => `  ${line}`),
                  "  helpers.skipJitOnce(frame);",
                  `  yield { deopt: true, transient: true, structuredResumePc: ${
                    index + 1
                  }, reason: 'asynchronous structured SSA callee' };`,
                ],
                ordinary: [
                  ...materializeLines(callStack, index).map((line) => `  ${line}`),
                  "  helpers.skipJitOnce(frame);",
                  "  return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };",
                ],
              });
              const deoptFallbackMarker =
                `__JVM_DEOPT_FUSED_FALLBACK_${index}_${site.id}__`;
              continuationFallbacks.set(deoptFallbackMarker, {
                continuation: [
                  ...(deferMaterialization
                    ? materializeLines(stack, index + 1).map((line) => `  ${line}`)
                    : []),
                  `  ${out}.structuredResumePc = ${index + 1};`,
                  `  yield ${out};`,
                ],
                ordinary: [
                  ...(deferMaterialization
                    ? materializeLines(stack, index + 1).map((line) => `  ${line}`)
                    : []),
                  `  return ${out};`,
                ],
              });
              const yieldedFallbackMarker =
                `__JVM_YIELDED_FUSED_FALLBACK_${index}_${site.id}__`;
              continuationFallbacks.set(yieldedFallbackMarker, {
                continuation: [
                  ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                  `  yield { deopt: true, transient: true, structuredResumePc: ${
                    index + 1
                  }, reason: 'thread yielded in structured SSA callee' };`,
                ],
                ordinary: [
                  ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                  "  return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee' };",
                ],
              });
              const fallbackLines = [
                ...(deferMaterialization
                  ? stageOperandLines(callStack) : materializeLines(callStack, index + 1)),
                `let ${out};`,
                `try { ${out} = helpers.tryInvokeSyncAt(${site.id}, frame, thread); } catch (${caught}) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                `  throw ${caught};`, "}",
                `if (${out} === helpers.asyncInvokeSentinel()) {`,
                asynchronousFallbackMarker, "}",
                `if (${out} && ${out}.deopt) {`,
                deoptFallbackMarker, "}",
                "if (thread.status !== 'runnable') {",
                yieldedFallbackMarker, "}",
              ];
              lines.push(`let ${handled};`,
                `try { ${handled} = helpers.fusedRegions.tryInvokeDirectAt(${site.directFused.id}, frame, thread, ${args.join(", ")}); } catch (${caught}) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                `  throw ${caught};`, "}",
                `if (!${handled}) {`,
                ...fallbackLines.map((line) => `  ${line}`),
                "}");
              if (deferMaterialization) deferredCallMaterializationCount += 1;
            }
          } else {
            const callStack = [...stack];
            const args = new Array(site.argumentCount);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (!valid) continue;
            const out = value(), caught = value();
            const deferMaterialization = this.deferredCallMaterializationEnabled;
            const resumableVoidCall = site.returnsVoid;
            const asynchronousCallMarker =
              `__JVM_ASYNC_VOID_CALL_${index}_${site.id}__`;
            if (resumableVoidCall) {
              continuationFallbacks.set(asynchronousCallMarker, {
                continuation: [
                  ...materializeLines(callStack, index).map((line) => `  ${line}`),
                  "  helpers.skipJitOnce(frame);",
                  `  yield { deopt: true, transient: true, structuredResumePc: ${
                    index + 1
                  }, reason: 'asynchronous structured SSA callee' };`,
                ],
                ordinary: [
                  ...materializeLines(callStack, index).map((line) => `  ${line}`),
                  "  helpers.skipJitOnce(frame);",
                  "  return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };",
                ],
              });
            }
            const fallbackLines = [
              ...(deferMaterialization
                ? stageOperandLines(callStack) : materializeLines(callStack, index + 1)),
              `try { ${out} = helpers.tryInvokeSyncAt(${site.id}, frame, thread); } catch (${caught}) {`,
              ...materializeLines(callStack, index).map((line) => `  ${line}`), `  throw ${caught};`, "}",
              `if (${out} === helpers.asyncInvokeSentinel()) {`,
              ...(resumableVoidCall ? [asynchronousCallMarker] : [
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                "  helpers.skipJitOnce(frame);",
                "  return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };",
              ]), "}",
            ];
            lines.push(`let ${out};`);
            if (site.id !== null && site.id !== undefined) {
              const runtimeSite = value(), positionalTarget = value();
              const receiverGuard = site.dynamic && site.argumentCount > 0
                ? `${args[0]} !== null && ${args[0]} !== undefined && ` +
                  `(${args[0]}.type || ${runtimeSite}.declaredClassName) === ` +
                  `${positionalTarget}.receiverType`
                : site.hasReceiver && site.argumentCount > 0
                  ? `${args[0]} !== null && ${args[0]} !== undefined && ` +
                    `${positionalTarget}.receiverType === null`
                  : `${positionalTarget}.receiverType === null`;
              lines.push(
                `const ${runtimeSite} = helpers.syncCallSites[${site.id}];`,
                `const ${positionalTarget} = ${runtimeSite} && ${runtimeSite}.fastPositional;`,
                `if (!helpers.profileMethods && ${positionalTarget} && ${receiverGuard} &&`,
                `    (${positionalTarget}.debugGuarded ||`,
                `      !helpers.jvm.debugManager.isClassJitDeopted(${positionalTarget}.lookupClass))) {`,
                `  try { ${out} = ${positionalTarget}.invoke(${args.join(", ")}${
                  args.length ? ", " : ""}thread); } catch (${caught}) {`,
                ...materializeLines(callStack, index).map((line) => `    ${line}`),
                `    throw ${caught};`, "  }",
                `  if (${out} === helpers.asyncInvokeSentinel()) {`,
                ...fallbackLines.map((line) => `    ${line}`),
                "  }",
                "} else {",
                ...fallbackLines.map((line) => `  ${line}`),
                "}",
              );
            } else {
              lines.push(...fallbackLines);
            }
            if (resumableVoidCall) {
              const deoptCallMarker =
                `__JVM_DEOPT_VOID_CALL_${index}_${site.id}__`;
              continuationFallbacks.set(deoptCallMarker, {
                continuation: [
                  ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                  `  ${out}.structuredResumePc = ${index + 1};`,
                  `  yield ${out};`,
                ],
                ordinary: [
                  ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                  `  return ${out};`,
                ],
              });
              lines.push(`if (${out} && ${out}.deopt) {`,
                deoptCallMarker, "}");
            } else {
              lines.push(`if (${out} && ${out}.deopt) {`,
                ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                `  return ${out};`, "}");
            }
            if (deferMaterialization) deferredCallMaterializationCount += 1;
            if (!site.returnsVoid) stack.push(out);
            if (resumableVoidCall) {
              const yieldedCallMarker =
                `__JVM_YIELDED_VOID_CALL_${index}_${site.id}__`;
              continuationFallbacks.set(yieldedCallMarker, {
                continuation: [
                  ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                  `  yield { deopt: true, transient: true, structuredResumePc: ${
                    index + 1
                  }, reason: 'thread yielded in structured SSA callee' };`,
                ],
                ordinary: [
                  ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                  "  return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee' };",
                ],
              });
              lines.push("if (thread.status !== 'runnable') {",
                yieldedCallMarker, "}");
            } else {
              lines.push("if (thread.status !== 'runnable') {",
                ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                "  return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee' };", "}");
            }
          }
        } else if (op === "goto" || op === "goto_w") {
          const edge = edgeLines(cfg.term[block.id].target, stack);
          if (!edge) valid = false; else lines.push(...edge);
        } else if (op.startsWith("if")) {
          const target = cfg.term[block.id].taken;
          const fall = cfg.term[block.id].fall;
          if (op.startsWith("if_icmp") || op.startsWith("if_acmp")) {
            const right = pop(), left = pop();
            const cmp = { if_icmpeq: "===", if_icmpne: "!==", if_icmplt: "<",
              if_icmpge: ">=", if_icmpgt: ">", if_icmple: "<=",
              if_acmpeq: "===", if_acmpne: "!==" }[op];
            if (left === null || right === null || !cmp) valid = false;
            else {
              condition = `${left} ${cmp} ${right}`;
              const literal = (expression) => /^-?\d+$/.test(expression)
                ? Number(expression) : expression === "null" ? null : undefined;
              const a = literal(left), b = literal(right);
              if (a !== undefined && b !== undefined) {
                conditionConstant = cmp === "===" ? a === b : cmp === "!==" ? a !== b
                  : cmp === "<" ? a < b : cmp === ">=" ? a >= b
                    : cmp === ">" ? a > b : a <= b;
              }
            }
          } else {
            const input = pop();
            const cmp = { ifeq: "=== 0", ifne: "!== 0", iflt: "< 0", ifge: ">= 0",
              ifgt: "> 0", ifle: "<= 0", ifnull: "=== null", ifnonnull: "!== null" }[op];
            if (input === null || !cmp) valid = false;
            else {
              condition = `${input} ${cmp}`;
              if (/^-?\d+$/.test(input)) {
                const number = Number(input);
                conditionConstant = op === "ifeq" ? number === 0 : op === "ifne" ? number !== 0
                  : op === "iflt" ? number < 0 : op === "ifge" ? number >= 0
                    : op === "ifgt" ? number > 0 : op === "ifle" ? number <= 0 : null;
              } else if (input === "null") {
                if (op === "ifnull") conditionConstant = true;
                else if (op === "ifnonnull") conditionConstant = false;
              }
            }
          }
          if (!valid || !edgeLines(target, stack) || !edgeLines(fall, stack)) valid = false;
          else plans[block.id] = {
            lines, condition, conditionConstant, taken: target, fall, stack: [...stack],
          };
        } else if (op === "athrow") {
          const thrown = pop();
          if (thrown === null) valid = false;
          else {
            lines.push(...materializeLines([...stack, thrown], index), `throw ${thrown};`);
            returnKind = "throw";
          }
        } else if (op === "ireturn" || op === "areturn" || op === "dreturn" ||
            op === "freturn" || op === "lreturn") {
          returnValue = pop();
          if (returnValue === null || stack.length !== 0) valid = false;
          else returnKind = "value";
        }
        else if (op === "return") {
          if (stack.length !== 0) valid = false; else returnKind = "void";
        }
        else valid = false;
        if (!valid) { invalidAt = { index, op }; break; }
      }
      if (!valid) return reject(`unsupported or invalid ${invalidAt?.op || "instruction"} at ${invalidAt?.index}`);
      if (!plans[block.id]) {
        const term = cfg.term[block.id];
        if (term.kind === "fall") {
          const edge = edgeLines(term.target, stack);
          if (!edge) return reject(`invalid fall edge from block ${block.id}`);
          lines.push(...edge);
        }
        plans[block.id] = { lines, returnKind, returnValue, stack: [...stack] };
      }
    }

    // Generator continuations preserve lexical SSA locals across a cooperative
    // browser yield. Guarded static constants are rechecked before resuming;
    // if another Java thread changed one, the exact materialized bytecode state
    // resumes in the baseline body instead of re-entering stale lexical state.
    let useContinuations = this.continuationsEnabled &&
      structured.loopHeaders.size > 0;
    const guardedStaticBooleanStateMatches = () => {
      for (const direct of guardedStaticBooleanSites.values()) {
        const target = directTargetFor(direct);
        if (!target) return false;
        const raw = target.kind === "map"
          ? target.fields.get(target.key) : target.fields[target.key];
        if ((raw ? 1 : 0) !== direct.guardedBooleanValue) return false;
      }
      return true;
    };
    const invalidateFieldCacheLines = [...fieldReadCaches.values()]
      .filter((cache) => !cache.eagerThis)
      .flatMap((cache) => [
        `${cache.valid} = false;`,
        `${cache.object} = null;`,
        ...(cache.isArray ? [`${cache.data} = null;`] : []),
      ]);
    const refreshEagerFieldCacheLines = [...fieldReadCaches.values()]
      .filter((cache) => cache.eagerThis)
      .flatMap((cache) => [
        `${cache.value} = ${cache.directKey
          ? `(local0.fields && local0.fields[${JSON.stringify(cache.directKey)}] !== undefined ? ` +
            `local0.fields[${JSON.stringify(cache.directKey)}] : ` +
            `helpers.getFieldAt(${cache.site}, local0))`
          : `helpers.getFieldAt(${cache.site}, local0)`};`,
        ...(cache.isArray ? [
          `${cache.data} = helpers.arrayData(${cache.value});`,
        ] : []),
      ]);
    const constantInstructionValue = (instruction) => {
      const op = opOf(instruction);
      if (/^iconst_(?:m1|[0-5])$/.test(op)) {
        return op === "iconst_m1" ? -1 : Number(op.slice(-1));
      }
      if (op === "bipush" || op === "sipush" ||
          op === "ldc" || op === "ldc_w") {
        const raw = instruction && typeof instruction === "object"
          ? instruction.arg : undefined;
        const resolved = raw && typeof raw === "object" &&
          Object.prototype.hasOwnProperty.call(raw, "value") ? raw.value : raw;
        const number = Number(resolved);
        return Number.isInteger(number) ? number | 0 : null;
      }
      return null;
    };
    const countedLoopTripCount = (node) => {
      if (!node || node.t !== "loop") return null;
      const header = Number(node.label.slice(1));
      const block = cfg.blocks[header];
      if (!block || block.synthetic || cfg.term[header]?.kind !== "cond") return null;
      const headerInstructions = block.insns
        .map((index) => items[index]?.instruction).filter(Boolean);
      if (headerInstructions.length < 3) return null;
      const branch = headerInstructions[headerInstructions.length - 1];
      const boundInstruction = headerInstructions[headerInstructions.length - 2];
      const loadInstruction = headerInstructions[headerInstructions.length - 3];
      if (opOf(branch) !== "if_icmpge") return null;
      const loadOp = opOf(loadInstruction);
      if (!/^iload(?:_[0-3])?$/.test(loadOp)) return null;
      const slot = localIndex(loadInstruction, loadOp);
      const bound = constantInstructionValue(boundInstruction);
      if (!Number.isInteger(slot) || bound === null) return null;

      const predecessors = [];
      for (let candidate = 0; candidate < cfg.n; candidate += 1) {
        if ((cfg.succ[candidate] || []).includes(header)) predecessors.push(candidate);
      }
      const headerItem = block.insns[0];
      const backedges = predecessors.filter((candidate) =>
        cfg.blocks[candidate].insns[0] >= headerItem);
      const preheaders = predecessors.filter((candidate) =>
        cfg.blocks[candidate].insns[0] < headerItem);
      if (preheaders.length !== 1 || backedges.length !== 1) return null;
      // Recover the natural-loop blocks by walking predecessors backward from
      // the unique bytecode backedge. Lexical structuring also contains exit
      // arms (for example an inner-loop exit that continues its outer loop),
      // so collecting the printed subtree would incorrectly classify exits
      // as part of the inner loop.
      const allPredecessors = Array.from({ length: cfg.n }, () => []);
      for (let candidate = 0; candidate < cfg.n; candidate += 1) {
        for (const successor of cfg.succ[candidate] || []) {
          allPredecessors[successor].push(candidate);
        }
      }
      const loopBlocks = new Set([header, backedges[0]]);
      const work = [backedges[0]];
      while (work.length) {
        const current = work.pop();
        for (const predecessor of allPredecessors[current]) {
          if (loopBlocks.has(predecessor)) continue;
          loopBlocks.add(predecessor);
          if (predecessor !== header) work.push(predecessor);
        }
      }
      const term = cfg.term[header];
      // The conservative form is `counter >= constant -> exit`, with the
      // fall-through entering the natural loop body.
      if (loopBlocks.has(term.taken) || !loopBlocks.has(term.fall)) return null;

      let initial = null;
      const preheaderInsns = cfg.blocks[preheaders[0]].insns;
      for (let position = 1; position < preheaderInsns.length; position += 1) {
        const store = items[preheaderInsns[position]]?.instruction;
        const storeOp = opOf(store);
        if (!/^istore(?:_[0-3])?$/.test(storeOp) ||
            localIndex(store, storeOp) !== slot) continue;
        initial = constantInstructionValue(
          items[preheaderInsns[position - 1]]?.instruction);
      }
      if (initial === null || initial >= bound) return null;

      let increment = null;
      let writes = 0;
      for (const loopBlock of loopBlocks) {
        for (const itemIndex of cfg.blocks[loopBlock].insns) {
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          if (op === "iinc" && Number(instruction.varnum ?? instruction.arg) === slot) {
            writes += 1;
            increment = Number(instruction.incr ?? 0);
          } else if (/^istore(?:_[0-3])?$/.test(op) &&
              localIndex(instruction, op) === slot) {
            writes += 1;
          }
        }
      }
      if (writes !== 1 || !Number.isInteger(increment) || increment <= 0) return null;
      const trips = Math.ceil((bound - initial) / increment);
      return trips > 0 && trips <= 4096 ? trips : null;
    };
    const allCountedLoops = new Map();
    const coarseCountedLoops = new Map();
    const findNestedCountedLoops = (node, loopDepth = 0) => {
      if (!node) return;
      if (node.t === "loop") {
        const trips = countedLoopTripCount(node);
        const header = Number(node.label.slice(1));
        if (trips) allCountedLoops.set(header, trips);
        if (trips && loopDepth > 0 && this.coarseCountedLoopSafePointsEnabled) {
          coarseCountedLoops.set(header, trips);
        }
        findNestedCountedLoops(node.body, loopDepth + 1);
      } else if (node.t === "seq") {
        node.body.forEach((child) => findNestedCountedLoops(child, loopDepth));
      } else if (node.t === "if") {
        findNestedCountedLoops(node.then, loopDepth);
        findNestedCountedLoops(node.els, loopDepth);
      } else if (node.t === "block") {
        findNestedCountedLoops(node.body, loopDepth);
      }
    };
    findNestedCountedLoops(structured.tree);
    const boundedIterationProduct = [...allCountedLoops.values()]
      .reduce((product, trips) => product * trips, 1);
    const hasAtomicUnsafeOperation = items.some((item) => {
      const op = opOf(item?.instruction);
      return op && (op.startsWith("invoke") || op === "monitorenter" ||
        op === "monitorexit" || op === "athrow" || op === "new" ||
        op === "newarray" || op === "anewarray" ||
        op === "multianewarray");
    });
    // Coarsening is safe for throughput only when the complete method is a
    // bounded numeric kernel. In an effectful method, one "counted" inner loop
    // can still contain a very large data-dependent unit of work (asset
    // decoding is a common example). Let those inner loops retain their own
    // scheduler polls so an outer backedge is not the first observable point
    // after hundreds of milliseconds.
    if (hasAtomicUnsafeOperation) coarseCountedLoops.clear();
    // A fully verified, call-free counted kernel has a finite upper bound and
    // no scheduler-visible operation inside it. Run it as one ordinary
    // JavaScript function so SpiderMonkey can optimize the numeric loops;
    // generators otherwise inhibit the hot-loop optimizer even when they
    // yield only at distant safe points. The one-million-iteration cap keeps
    // atomic regions bounded independently of guest names or descriptors.
    const atomicBoundedLoops = this.atomicBoundedLoopsEnabled &&
      structured.loopHeaders.size > 0 &&
      allCountedLoops.size === structured.loopHeaders.size &&
      boundedIterationProduct <= 1_000_000 &&
      (code.code.exceptionTable || []).length === 0 &&
      !hasAtomicUnsafeOperation;
    if (atomicBoundedLoops) {
      useContinuations = false;
      for (const header of structured.loopHeaders) {
        coarseCountedLoops.set(header, allCountedLoops.get(header));
      }
    }
    const maximumCoarseTripCount = Math.max(1, ...coarseCountedLoops.values());
    const invokeCount = items.reduce((count, item) => {
      const op = opOf(item?.instruction);
      return count + (op?.startsWith("invoke") ? 1 : 0);
    }, 0);
    const allocationCount = items.reduce((count, item) => {
      const op = opOf(item?.instruction);
      return count + (op === "new" || op === "newarray" ||
        op === "anewarray" || op === "multianewarray" ? 1 : 0);
    }, 0);
    // Polling every 10k backedges works for tiny arithmetic loops, but a
    // single iteration of a large call/allocation-heavy guest body can do
    // orders of magnitude more work. Scale the poll interval by verified
    // bytecode work rather than guest identity. This only reads Date.now() at
    // the resulting boundary; an actual spill/yield still occurs solely when
    // the ordinary scheduler deadline, debugger, timer, or thread state says
    // it is observable. Fully bounded call-free numeric kernels retain their
    // atomic path above.
    const loopWorkEstimate = Math.max(1,
      items.length + invokeCount * 32 + allocationCount * 16);
    const structuralPollBudget = hasAtomicUnsafeOperation
      ? Math.max(64, Math.min(10000, Math.floor(16384 / loopWorkEstimate)))
      : 10000;
    // Charge the outer safe point once per completed bounded inner loop. This
    // retains approximately the original 10k-iteration scheduler quantum
    // without executing a second branch in every inner-loop iteration.
    const safePointInitialBudget = Math.max(
      1, Math.floor(structuralPollBudget / maximumCoarseTripCount));
    const indent = (lines) => lines.map((line) => `  ${line}`);
    const expandContinuationFallbacks = (lines, continuationMode) =>
      lines.flatMap((line) => {
        const fallback = continuationFallbacks.get(line.trim());
        if (!fallback) return [line];
        const prefix = line.slice(0, line.length - line.trimStart().length);
        return (continuationMode ? fallback.continuation : fallback.ordinary)
          .map((fallbackLine) => `${prefix}${fallbackLine}`);
      });
    const render = (
      node, continuationMode = useContinuations, directPositional = false,
      loopSafePointBudget = safePointInitialBudget,
    ) => {
      if (!node) return [];
      if (node.t === "seq") {
        return node.body.flatMap((child) =>
          render(child, continuationMode, directPositional, loopSafePointBudget));
      }
      if (node.t === "straight") {
        const plan = plans[node.block];
        const lines = plan.lines.flatMap((line) => {
          const fallback = continuationFallbacks.get(line);
          if (!fallback) return [line];
          return continuationMode ? fallback.continuation : fallback.ordinary;
        });
        if (plan.returnKind && plan.returnKind !== "throw") {
          if (directPositional) {
            lines.push(plan.returnKind === "void"
              ? "return helpers.returnVoid();"
              : `return ${plan.returnValue};`);
            return lines;
          }
          // Positional generated calls can execute this body without making
          // the callee Frame scheduler-visible.  Keep the scalar SSA values
          // in JavaScript and return the Java value directly on that path;
          // the wrapper reconstructs/inserts the omitted Frame only when this
          // body deoptimizes or throws.  Ordinary scheduler entries retain the
          // canonical Frame spill/pop/result protocol below.
          lines.push("if (framelessEntry) {");
          lines.push(plan.returnKind === "void"
            ? "  return helpers.returnVoid();"
            : `  return ${plan.returnValue};`);
          lines.push("}");
          lines.push("spillLocals();");
          lines.push("stack.length = 0;");
          lines.push(`frame.pc = ${items.length};`);
          lines.push("thread.callStack.pop();");
          lines.push(plan.returnKind === "void"
            ? "return { returned: true, value: helpers.returnVoid() };"
            : `return { returned: true, value: ${plan.returnValue} };`);
        }
        return lines;
      }
      if (node.t === "if") {
        const plan = plans[node.block];
        if (plan.conditionConstant === true) {
          return ["{", ...indent([
            ...edgeLines(plan.taken, plan.takenStack ?? plan.stack),
            ...render(node.then, continuationMode, directPositional,
              loopSafePointBudget),
          ]), "}"];
        }
        if (plan.conditionConstant === false) {
          return ["{", ...indent([
            ...edgeLines(plan.fall, plan.fallStack ?? plan.stack),
            ...render(node.els, continuationMode, directPositional,
              loopSafePointBudget),
          ]), "}"];
        }
        return [`if (${plan.condition}) {`, ...indent([
          ...edgeLines(plan.taken, plan.takenStack ?? plan.stack),
          ...render(node.then, continuationMode, directPositional,
            loopSafePointBudget),
        ]), "} else {", ...indent([
          ...edgeLines(plan.fall, plan.fallStack ?? plan.stack),
          ...render(node.els, continuationMode, directPositional,
            loopSafePointBudget),
        ]), "}"];
      }
      if (node.t === "loop") {
        const header = Number(node.label.slice(1));
        const headerBlock = cfg.blocks[header];
        if (!headerBlock) throw new Error(`unknown structured loop header ${node.label}`);
        // A synthetic dispatcher header has no bytecode pc of its own; the
        // frame's JVM-visible position is the island entry the state variable
        // currently selects, whose live operands sit in the transfer slots.
        const restoreLines = headerBlock.synthetic
          ? headerBlock.synthetic.entryPcs.flatMap((pc, state) => {
            const depth = headerBlock.synthetic.entryDepths[state];
            return [
              `if (${headerBlock.synthetic.variable} === ${state}) {`,
              ...indent([
                ...Array.from({ length: depth }, (_u, slot) =>
                  `stack[${slot}] = ${headerBlock.synthetic.transfer}${slot};`),
                `stack.length = ${depth};`,
                `helpers.materialize(frame, locals, stack, ${pc});`,
              ]),
              "}",
            ];
          })
          : (() => {
            const headerDepth = depths[headerBlock.insns[0]] || 0;
            return [
              ...Array.from({ length: headerDepth }, (_u, i) => `stack[${i}] = ssaStack${header}_${i};`),
              `stack.length = ${headerDepth};`,
              `helpers.materialize(frame, locals, stack, ${headerBlock.insns[0]});`,
            ];
          })();
        const materialize = [
          `if (helpers.continueStructuredQuantum(thread)) { safePointBudget = ${loopSafePointBudget}; } else {`,
          ...indent([
            "spillLocals();",
            ...restoreLines,
            "helpers.structuredSsa.safePointCount += 1;",
            ...(continuationMode ? [
              ...invalidateFieldCacheLines,
              `safePointBudget = ${loopSafePointBudget};`,
              "yield { deopt: true, transient: true, reason: 'structured SSA continuation' };",
              ...refreshEagerFieldCacheLines,
            ] : [
              "helpers.skipJitOnce(frame);",
              "return { deopt: true, transient: true, reason: 'structured SSA safe point' };",
            ]),
          ]),
          "}",
        ];
        const coarse = coarseCountedLoops.has(header);
        return [`${node.label}: while (true) {`,
          ...(coarse ? [] : [
            "  if (--safePointBudget === 0) {",
            ...indent(indent(materialize)), "  }",
          ]),
          ...indent(render(node.body, continuationMode, directPositional,
            loopSafePointBudget)), "}"];
      }
      if (node.t === "block") {
        return [`${node.label}: {`,
          ...indent(render(node.body, continuationMode, directPositional,
            loopSafePointBudget)), "}"];
      }
      if (node.t === "break") return [`break ${node.label};`];
      if (node.t === "continue") return [`continue ${node.label};`];
      throw new Error(`unsupported structured node ${node.t}`);
    };
    const declarations = [];
    const dispatchVariables = new Map();
    for (const block of cfg.blocks) {
      if (block.synthetic) {
        const previous = dispatchVariables.get(block.synthetic.variable);
        dispatchVariables.set(block.synthetic.variable, {
          transfer: block.synthetic.transfer,
          maxDepth: Math.max(previous?.maxDepth || 0, block.synthetic.maxDepth || 0),
        });
        continue;
      }
      const depth = depths[block.insns[0]] || 0;
      for (let slot = 0; slot < depth; slot += 1) declarations.push(`let ssaStack${block.id}_${slot};`);
    }
    for (const [variable, island] of dispatchVariables) {
      declarations.push(`let ${variable} = 0;`);
      for (let slot = 0; slot < island.maxDepth; slot += 1) declarations.push(`let ${island.transfer}${slot};`);
    }
    const staticEntryGuard = directStaticOwners.size
      ? `if (${[...directStaticOwners].map((owner) =>
        `helpers.jvm.classInitializationState.get(${JSON.stringify(owner)}) !== "INITIALIZED"`).join(" || ")}) { helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'structured SSA static entry' }; }`
      : null;
    const directStaticDeclarations = [...directStaticSites.values()].map((direct) =>
      `const ${direct.variable} = helpers.directStaticTargets[${direct.targetId}].fields;`);
    const fieldReadCacheDeclarations = [...fieldReadCaches.values()].flatMap((cache) => [
      `let ${cache.object} = null;`,
      `let ${cache.value};`,
      `let ${cache.valid} = false;`,
      ...(cache.isArray ? [`let ${cache.data} = null;`] : []),
    ]);
    const fieldReadCacheInitializations = [...fieldReadCaches.values()]
      .filter((cache) => cache.eagerThis)
      .flatMap((cache) => [
        `${cache.object} = local0;`,
        `${cache.value} = ${cache.directKey
          ? `(local0.fields && local0.fields[${JSON.stringify(cache.directKey)}] !== undefined ? ` +
            `local0.fields[${JSON.stringify(cache.directKey)}] : ` +
            `helpers.getFieldAt(${cache.site}, local0))`
          : `helpers.getFieldAt(${cache.site}, local0)`};`,
        ...(cache.isArray ? [
          `${cache.data} = helpers.arrayData(${cache.value});`,
        ] : []),
        `${cache.valid} = true;`,
      ]);
    const guardedStaticBooleanEntryGuard = guardedStaticBooleanSites.size
      ? `if (${[...guardedStaticBooleanSites.values()].map((direct) => `((${
        direct.kind === "map" ? `${direct.variable}.get(${JSON.stringify(direct.key)})`
          : `${direct.variable}[${JSON.stringify(direct.key)}]`} ? 1 : 0) !== ${
        direct.guardedBooleanValue})`).join(" || ")}) { helpers.structuredSsa.guardedBooleanFallbackCount += 1; helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'structured SSA static boolean guard' }; }`
      : null;
    const renderedTree = expandContinuationFallbacks(
      render(structured.tree), useContinuations);
    const renderedLocalSlots = new Set();
    const renderedAssignedLocalSlots = new Set();
    for (const line of renderedTree) {
      for (const match of line.matchAll(/\blocal(\d+)\b/g)) {
        renderedLocalSlots.add(Number(match[1]));
      }
      const assignment = /\blocal(\d+)\s*=/.exec(line);
      if (assignment) renderedAssignedLocalSlots.add(Number(assignment[1]));
    }
    const declaredLocals = [...renderedLocalSlots].sort((a, b) => a - b);
    const immutableEntryLocals = new Set([...entryLocalInitialValues.keys()]
      .filter((slot) => !renderedAssignedLocalSlots.has(slot)));
    const spillSlots = [...new Set([
      ...entryLocalInitialValues.keys(), ...renderedAssignedLocalSlots,
    ])].sort((a, b) => a - b);
    // Small acyclic integral decision trees (character maps, classifiers,
    // clamps, flag decoders, and similar leaves) are often called once per
    // pixel/glyph.  Their frame-backed positional wrapper can cost more than
    // the guest arithmetic.  Admit a deliberately narrow, non-throwing,
    // side-effect-free opcode set and emit a second ABI that receives JVM
    // arguments directly as JavaScript scalars.  Selection depends only on
    // the verified descriptor/CFG/opcodes and resolved static locations.
    const directPositionalOps = new Set([
      "nop",
      "iload", "iload_0", "iload_1", "iload_2", "iload_3",
      "istore", "istore_0", "istore_1", "istore_2", "istore_3",
      "iconst_m1", "iconst_0", "iconst_1", "iconst_2", "iconst_3",
      "iconst_4", "iconst_5", "bipush", "sipush", "ldc", "ldc_w",
      "iadd", "isub", "imul", "iand", "ior", "ixor",
      "ishl", "ishr", "iushr", "ineg", "i2b", "i2c", "i2s", "iinc",
      "getstatic",
      "goto", "goto_w",
      "ifeq", "ifne", "iflt", "ifle", "ifgt", "ifge",
      "if_icmpeq", "if_icmpne", "if_icmplt", "if_icmple",
      "if_icmpgt", "if_icmpge",
      "ireturn",
    ]);
    let directMethodDescriptor = null;
    try { directMethodDescriptor = parseDescriptor(method.descriptor); } catch (_) {}
    const directIntegralTypes = new Set([
      "boolean", "byte", "char", "short", "int",
    ]);
    const directMethodOwner = method.className ||
      this.jit.jvm.findClassNameForMethod?.(method) || null;
    let directPositionalEligible = Boolean(
      directMethodDescriptor &&
      directIntegralTypes.has(directMethodDescriptor.returnType) &&
      directMethodDescriptor.params.every((type) => directIntegralTypes.has(type)) &&
      directMethodOwner &&
      structured.loopHeaders.size === 0 &&
      (code.code.exceptionTable || []).length === 0 &&
      fieldReadCaches.size === 0,
    );
    for (let index = 0; index < items.length && directPositionalEligible; index += 1) {
      if (depths[index] === undefined) continue;
      const instruction = items[index]?.instruction;
      const op = opOf(instruction);
      if (!op) continue;
      if (!directPositionalOps.has(op)) {
        directPositionalEligible = false;
        break;
      }
      if ((op === "ldc" || op === "ldc_w") &&
          !Number.isInteger(Number(instruction.arg?.value ?? instruction.arg))) {
        directPositionalEligible = false;
        break;
      }
      if (op === "getstatic") {
        const direct = directStaticSites.get(index);
        const descriptor = instruction.arg?.[2]?.[1];
        if (!direct || !["Z", "B", "C", "S", "I"].includes(descriptor)) {
          directPositionalEligible = false;
        }
      }
    }
    // A second direct ABI covers effectful primitive-array leaves such as
    // samplers and pixel writers.  These methods are still acyclic and
    // call-free, but getfield, array access, and integer division can throw.
    // Their normal path receives scalar arguments and creates no Frame.  Every
    // throwing instruction already emits materialization at its exact bytecode
    // PC; the direct body lazily creates and restores the omitted Frame only
    // when that exceptional path is actually taken.
    const restoringDirectPositionalOps = new Set([
      ...directPositionalOps,
      "aload", "aload_0",
      "getfield",
      "iaload", "saload", "baload", "caload",
      "iastore", "sastore", "bastore", "castore",
      "idiv", "irem",
      "return",
    ]);
    const directPrimitiveDescriptors = new Set([
      "Z", "B", "C", "S", "I",
      "[Z", "[B", "[C", "[S", "[I",
    ]);
    let restoringDirectPositionalEligible = Boolean(
      !directPositionalEligible &&
      directMethodDescriptor &&
      (directMethodDescriptor.returnType === "void" ||
        directIntegralTypes.has(directMethodDescriptor.returnType)) &&
      directMethodDescriptor.params.every((type) => directIntegralTypes.has(type)) &&
      directMethodOwner &&
      structured.loopHeaders.size === 0 &&
      (code.code.exceptionTable || []).length === 0 &&
      [...fieldReadCaches.values()].every((cache) =>
        cache.eagerThis && cache.directKey),
    );
    for (let index = 0;
      index < items.length && restoringDirectPositionalEligible;
      index += 1) {
      if (depths[index] === undefined) continue;
      const instruction = items[index]?.instruction;
      const op = opOf(instruction);
      if (!op) continue;
      if (!restoringDirectPositionalOps.has(op)) {
        restoringDirectPositionalEligible = false;
        break;
      }
      if ((op === "ldc" || op === "ldc_w") &&
          !Number.isInteger(Number(instruction.arg?.value ?? instruction.arg))) {
        restoringDirectPositionalEligible = false;
        break;
      }
      if (op === "aload" && localIndex(instruction, op) !== 0) {
        restoringDirectPositionalEligible = false;
        break;
      }
      if (op === "getfield") {
        const site = fieldSites.get(index);
        const plan = site === undefined ? null : this.jit.fieldSites[site];
        const cache = fieldReadCacheSites.get(index);
        if (!plan || !directPrimitiveDescriptors.has(plan.descriptor) ||
            !cache?.eagerThis || !cache.directKey) {
          restoringDirectPositionalEligible = false;
          break;
        }
      }
      if (op === "getstatic") {
        const direct = directStaticSites.get(index);
        const descriptor = instruction.arg?.[2]?.[1];
        if (!direct || !directPrimitiveDescriptors.has(descriptor)) {
          restoringDirectPositionalEligible = false;
          break;
        }
      }
    }
    const buildBody = (
      tree, entrySafePointBudget = safePointInitialBudget,
    ) => ["'use strict';",
      "const locals = frame.locals;", "const stack = frame.stack.items;",
      "if ((!framelessEntry && frame.pc !== 0) || (initialBytecodeChecks === undefined ? helpers.needsBytecodeChecks() : initialBytecodeChecks)) { helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'structured SSA entry' }; }",
      staticEntryGuard,
      ...directStaticDeclarations,
      guardedStaticBooleanEntryGuard,
      "helpers.structuredSsa.runCount += 1;",
      `let safePointBudget = ${entrySafePointBudget};`,
      ...declaredLocals.map((i) => `${immutableEntryLocals.has(i) ? "const" : "let"} local${i} = ${
        entryLocalInitialValues.has(i) ? entryLocalInitialValues.get(i) : `locals[${i}]`};`),
      ...fieldReadCacheDeclarations,
      ...fieldReadCacheInitializations,
      `const spillLocals = () => {${spillSlots.map((i) => ` locals[${i}] = ${
        immutableEntryLocals.has(i) ? entryLocalInitialValues.get(i) : `local${i}`};`).join("")} };`,
      ...declarations, ...tree];
    const body = buildBody(renderedTree);
    const generatedSource = body.join("\n");
    try {
      const generatedBody = this.jit.createGeneratedFunction(method, "structured-ssa",
        ["frame", "thread", "helpers", "initialBytecodeChecks", "framelessEntry"], generatedSource,
        null, false, useContinuations);
      let directPositionalBody = null;
      let directPositionalSource = null;
      if (directPositionalEligible) {
        const receiverSlots = methodIsStatic ? 0 : 1;
        const argumentCount = directMethodDescriptor.params.length + receiverSlots;
        const argumentNames = Array.from(
          { length: argumentCount }, (_unused, index) => `argument${index}`);
        const entryArguments = new Map();
        let slot = 0;
        if (!methodIsStatic) {
          entryArguments.set(0, "argument0");
          slot = 1;
        }
        for (let index = 0; index < directMethodDescriptor.params.length; index += 1) {
          entryArguments.set(slot++, `argument${index + receiverSlots}`);
        }
        const owners = [...new Set([directMethodOwner, ...directStaticOwners])];
        const directGuardConditions = [
          "helpers.needsBytecodeChecks()",
          ...owners.map((owner) =>
            `helpers.jvm.classInitializationState.get(${JSON.stringify(owner)}) !== "INITIALIZED"`),
        ];
        const directGuard = directGuardConditions.length
          ? `if (${directGuardConditions.join(" || ")}) ` +
            "{ return helpers.asyncInvokeSentinel(); }"
          : null;
        const directBooleanGuard = guardedStaticBooleanSites.size
          ? `if (${[...guardedStaticBooleanSites.values()].map((direct) => `((${
            direct.kind === "map"
              ? `${direct.variable}.get(${JSON.stringify(direct.key)})`
              : `${direct.variable}[${JSON.stringify(direct.key)}]`} ? 1 : 0) !== ${
            direct.guardedBooleanValue})`).join(" || ")}) { ` +
            "helpers.structuredSsa.guardedBooleanFallbackCount += 1; " +
            "return helpers.asyncInvokeSentinel(); }"
          : null;
        directPositionalSource = [
          "'use strict';",
          directGuard,
          ...directStaticDeclarations,
          directBooleanGuard,
          "helpers.structuredSsa.runCount += 1;",
          ...declaredLocals.map((index) =>
            `${immutableEntryLocals.has(index) ? "const" : "let"} local${index} = ${
              entryLocalInitialValues.has(index)
                ? entryLocalInitialValues.get(index)
                : entryArguments.get(index) || "undefined"};`),
          ...declarations,
          ...expandContinuationFallbacks(
            render(structured.tree, false, true), false),
        ].filter(Boolean).join("\n");
        directPositionalBody = this.jit.createGeneratedFunction(
          method,
          "ssa-direct-positional",
          ["helpers", ...argumentNames],
          directPositionalSource,
        );
      }
      let restoringDirectPositionalBody = null;
      let restoringDirectPositionalSource = null;
      if (restoringDirectPositionalEligible) {
        const receiverSlots = methodIsStatic ? 0 : 1;
        const argumentCount = directMethodDescriptor.params.length + receiverSlots;
        const argumentNames = Array.from(
          { length: argumentCount }, (_unused, index) => `argument${index}`);
        const entryArguments = new Map();
        let slot = 0;
        if (!methodIsStatic) {
          entryArguments.set(0, "argument0");
          slot = 1;
        }
        for (let index = 0; index < directMethodDescriptor.params.length; index += 1) {
          entryArguments.set(slot++, `argument${index + receiverSlots}`);
        }
        const owners = [...new Set([directMethodOwner, ...directStaticOwners])];
        const directGuardConditions = [
          "helpers.profileMethods",
          "helpers.needsBytecodeChecks()",
          "thread.status !== 'runnable'",
          ...owners.map((owner) =>
            `helpers.jvm.classInitializationState.get(${JSON.stringify(owner)}) !== "INITIALIZED"`),
        ];
        const directGuard =
          `if (${directGuardConditions.join(" || ")}) { ` +
          "return helpers.asyncInvokeSentinel(); }";
        const directBooleanGuard = guardedStaticBooleanSites.size
          ? `if (${[...guardedStaticBooleanSites.values()].map((direct) => `((${
            direct.kind === "map"
              ? `${direct.variable}.get(${JSON.stringify(direct.key)})`
              : `${direct.variable}[${JSON.stringify(direct.key)}]`} ? 1 : 0) !== ${
            direct.guardedBooleanValue})`).join(" || ")}) { ` +
            "helpers.structuredSsa.guardedBooleanFallbackCount += 1; " +
            "return helpers.asyncInvokeSentinel(); }"
          : null;
        const initializeFrame = [
          "frame = plan.target.freeFrame || new plan.Frame(plan.method);",
          "plan.target.freeFrame = null;",
          "frame.pc = 0;",
          "frame.stack.items.length = 0;",
          "delete frame.jitSkipOnce;",
          "delete frame.jitJsDisabled;",
          "delete frame.jitAdaptiveEntryCounted;",
          "frame.className = plan.lookupClass;",
          "locals = frame.locals;",
          "stack = frame.stack.items;",
          ...[...entryArguments].map(([index, argument]) =>
            `locals[${index}] = ${argument};`),
        ];
        const directBody = [
          ...directStaticDeclarations,
          directBooleanGuard,
          "helpers.structuredSsa.runCount += 1;",
          ...declaredLocals.map((index) =>
            `${immutableEntryLocals.has(index) ? "const" : "let"} local${index} = ${
              entryLocalInitialValues.has(index)
                ? entryLocalInitialValues.get(index)
                : entryArguments.get(index) || "undefined"};`),
          "function spillLocals() {",
          "  if (frame === null) {",
          ...initializeFrame.map((line) => `    ${line}`),
          "  }",
          ...spillSlots.map((index) => `  locals[${index}] = ${
            immutableEntryLocals.has(index)
              ? entryLocalInitialValues.get(index) : `local${index}`};`),
          "}",
          ...fieldReadCacheDeclarations,
          ...fieldReadCacheInitializations,
          ...declarations,
          ...expandContinuationFallbacks(
            render(structured.tree, false, true), false),
        ].filter(Boolean);
        restoringDirectPositionalSource = [
          "'use strict';",
          directGuard,
          "let frame = null;",
          "let locals = null;",
          "let stack = null;",
          "try {",
          ...directBody.map((line) => `  ${line}`),
          "} catch (error) {",
          "  if (frame !== null) {",
          "    helpers.structuredSsa.restoredDirectExceptionFrameCount += 1;",
          "    plan.restoreFrame(thread, frame);",
          "  }",
          "  throw error;",
          "}",
        ].join("\n");
        restoringDirectPositionalBody = this.jit.createGeneratedFunction(
          method,
          "ssa-direct-restoring-positional",
          ["helpers", "plan", ...argumentNames, "thread"],
          restoringDirectPositionalSource,
        );
      }
      let adaptivePositionalBody = null;
      let adaptivePositionalSource = null;
      let ordinaryAdaptive = false;
      if (useContinuations && this.jit.adaptiveFramelessPositionalEnabled) {
        const adaptiveSafePointBudget = Math.min(
          1_000_000,
          safePointInitialBudget * this.jit.adaptiveFramelessBudgetMultiplier,
        );
        ordinaryAdaptive =
          this.jit.ordinaryAdaptiveFramelessPositionalEnabled;
        const adaptiveBody = buildBody(
          expandContinuationFallbacks(
            render(structured.tree, !ordinaryAdaptive, false,
              adaptiveSafePointBudget),
            !ordinaryAdaptive),
          adaptiveSafePointBudget,
        );
        if (ordinaryAdaptive) {
          adaptiveBody.splice(1, 0,
            "helpers.ordinaryAdaptiveFramelessRunCount += 1;");
        }
        adaptivePositionalSource = adaptiveBody.join("\n");
        const adaptiveGeneratedBody = this.jit.createGeneratedFunction(
          method,
          "structured-ssa-adaptive-positional",
          ["frame", "thread", "helpers", "initialBytecodeChecks", "framelessEntry"],
          adaptivePositionalSource,
          null, false, !ordinaryAdaptive,
        );
        if (ordinaryAdaptive) {
          // Most hot browser loops finish inside the enlarged quantum. An
          // ordinary function lets SpiderMonkey optimize their numeric body;
          // the emitted non-generator safe point still materializes the exact
          // PC/locals/stack and deoptimizes if a run exceeds that quantum.
          adaptivePositionalBody = adaptiveGeneratedBody;
        } else {
          // The enlarged frameless quantum can still meet a wall-clock safe
          // point in a genuinely large guest loop. Keep its lexical iterator
          // on the lazily restored child Frame so the canonical structured
          // entry resumes the same scalar state on the next scheduler turn.
          adaptivePositionalBody = function (
            frame, thread, helpers, initialBytecodeChecks, framelessEntry,
          ) {
            let continuation = frame[STRUCTURED_CONTINUATION];
            if (continuation) {
              const bytecodeChecks = initialBytecodeChecks === undefined
                ? helpers.needsBytecodeChecks() : initialBytecodeChecks;
              const guardedStaticChanged =
                !guardedStaticBooleanStateMatches();
              if (continuation.pc !== frame.pc || bytecodeChecks ||
                  guardedStaticChanged) {
                delete frame[STRUCTURED_CONTINUATION];
                try { continuation.iterator.return(); } catch (_) {}
                if (guardedStaticChanged) {
                  helpers.structuredSsa.guardedBooleanFallbackCount += 1;
                }
                helpers.skipJitOnce(frame);
                return {
                  deopt: true, transient: true,
                  reason: "invalidated structured SSA continuation",
                };
              }
            }
            const iterator = continuation?.iterator ||
              adaptiveGeneratedBody(
                frame, thread, helpers, initialBytecodeChecks, framelessEntry);
            let step;
            try {
              step = iterator.next();
            } catch (error) {
              delete frame[STRUCTURED_CONTINUATION];
              throw error;
            }
            if (step.done) {
              delete frame[STRUCTURED_CONTINUATION];
              return step.value;
            }
            frame[STRUCTURED_CONTINUATION] = {
              iterator,
              pc: Number.isInteger(step.value?.structuredResumePc)
                ? step.value.structuredResumePc : frame.pc,
              framelessEntry: true,
            };
            return step.value;
          };
        }
        if (!ordinaryAdaptive) {
          adaptivePositionalBody.jvmSourceUrl = adaptiveGeneratedBody.jvmSourceUrl;
          adaptivePositionalBody.toString = () => adaptiveGeneratedBody.toString();
        }
      }
      const generated = useContinuations
        ? function (frame, thread, helpers, initialBytecodeChecks) {
          let continuation = frame[STRUCTURED_CONTINUATION];
          if (!continuation && ordinaryAdaptive &&
              adaptivePositionalBody) {
            return adaptivePositionalBody(
              frame, thread, helpers, initialBytecodeChecks, false);
          }
          if (continuation) {
            const bytecodeChecks = initialBytecodeChecks === undefined
              ? helpers.needsBytecodeChecks() : initialBytecodeChecks;
            const guardedStaticChanged =
              !guardedStaticBooleanStateMatches();
            if (continuation.pc !== frame.pc || bytecodeChecks ||
                guardedStaticChanged) {
              delete frame[STRUCTURED_CONTINUATION];
              try { continuation.iterator.return(); } catch (_) {}
              if (guardedStaticChanged) {
                helpers.structuredSsa.guardedBooleanFallbackCount += 1;
              }
              helpers.skipJitOnce(frame);
              return {
                deopt: true, transient: true,
                reason: "invalidated structured SSA continuation",
              };
            }
          }
          const iterator = continuation?.iterator ||
            generatedBody(frame, thread, helpers, initialBytecodeChecks);
          let step;
          try {
            step = iterator.next();
          } catch (error) {
            delete frame[STRUCTURED_CONTINUATION];
            throw error;
          }
          if (step.done) {
            delete frame[STRUCTURED_CONTINUATION];
            // A positional iterator that yielded was restored as a canonical
            // child Frame, but its lexical return path still carries the
            // original frameless-entry flag and therefore returns the Java
            // value directly. Complete the ordinary Frame protocol here once
            // that restored iterator finishes.
            if (continuation?.framelessEntry) {
              frame.stack.items.length = 0;
              frame.pc = items.length;
              thread.callStack.pop();
              return { returned: true, value: step.value };
            }
            return step.value;
          }
          frame[STRUCTURED_CONTINUATION] = {
            iterator,
            pc: Number.isInteger(step.value?.structuredResumePc)
              ? step.value.structuredResumePc : frame.pc,
          };
          return step.value;
        }
        : generatedBody;
      if (useContinuations) {
        generated.jvmSourceUrl = generatedBody.jvmSourceUrl;
        generated.jvmHasStructuredContinuation =
          (frame) => Boolean(frame?.[STRUCTURED_CONTINUATION]);
        generated.toString = () => generatedBody.toString();
      }
      generated.jvmSynchronous = true;
      generated.jvmStructuredSsa = true;
      generated.jvmStructuredContinuation = useContinuations;
      generated.jvmFramelessPositional = !useContinuations;
      generated.jvmDirectPositionalBody = directPositionalBody;
      generated.jvmDirectPositionalSource = directPositionalSource;
      if (restoringDirectPositionalBody) {
        const semanticSampler =
          HandwrittenBilinearSampler.install(this.jit, method);
        if (semanticSampler) {
          restoringDirectPositionalBody = semanticSampler.body;
          restoringDirectPositionalSource = semanticSampler.source;
          generated.jvmRestoringDirectPositionalPlan = semanticSampler.plan;
        }
      }
      generated.jvmRestoringDirectPositionalBody = restoringDirectPositionalBody;
      generated.jvmRestoringDirectPositionalSource = restoringDirectPositionalSource;
      generated.jvmAdaptivePositionalBody = adaptivePositionalBody;
      generated.jvmAdaptivePositionalSource = adaptivePositionalSource;
      generated.jvmAdaptivePositionalOrdinary =
        Boolean(adaptivePositionalBody &&
          this.jit.ordinaryAdaptiveFramelessPositionalEnabled);
      generated.jvmStructuredLoopCount = structured.loopHeaders.size;
      generated.jvmStructuredSplitBlocks = splitBlocks;
      generated.jvmStructuredDispatchIslands = dispatchIslands;
      generated.jvmStructuredDeferredCallMaterializationCount =
        deferredCallMaterializationCount;
      generated.jvmStructuredReusedLocalLoadCount = reusedLocalLoadCount;
      generated.jvmStructuredEliminatedLocalStoreCount = eliminatedLocalStoreCount;
      generated.jvmStructuredSentinelArrayLoadCount = sentinelArrayLoadCount;
      generated.jvmStructuredEliminatedArrayStoreCheckCount =
        eliminatedArrayStoreCheckCount;
      generated.jvmStructuredGuardedBooleanSiteCount = guardedStaticBooleanSites.size;
      generated.jvmStructuredDeclaredLocalCount = declaredLocals.length;
      generated.jvmStructuredSpilledLocalCount = spillSlots.length;
      generated.jvmStructuredImmutableEntryLocalCount = immutableEntryLocals.size;
      generated.jvmStructuredFieldReadCacheCount = fieldReadCaches.size;
      generated.jvmStructuredEagerThisFieldCount = [...fieldReadCaches.values()]
        .filter((cache) => cache.eagerThis).length;
      generated.jvmStructuredCoarseCountedLoopCount = coarseCountedLoops.size;
      generated.jvmStructuredSafePointBudget = safePointInitialBudget;
      generated.jvmStructuredLoopWorkEstimate = loopWorkEstimate;
      generated.jvmStructuredAtomicBoundedLoops = atomicBoundedLoops;
      generated.jvmStructuredBoundedIterationProduct =
        atomicBoundedLoops ? boundedIterationProduct : 0;
      generated.jvmStructuredSource = generatedSource;
      this.compiledLoopCount += structured.loopHeaders.size;
      if (guardedStaticBooleanSites.size) {
        this.guardedBooleanMethodCount += 1;
        this.guardedBooleanSiteCount += guardedStaticBooleanSites.size;
      }
      if (splitBlocks > 0) {
        this.splitMethodCount += 1;
        this.splitBlockCount += splitBlocks;
      }
      if (dispatchIslands > 0) {
        this.dispatchIslandMethodCount += 1;
        this.dispatchIslandCount += dispatchIslands;
      }
      return generated;
    } catch (error) {
      this.lastCompileError = error;
      return reject(`JavaScript emission failed: ${error.message}`);
    }
  }
}

module.exports = JvmSsaBlockRenderer;
module.exports._test = { isIrreducibleError };
