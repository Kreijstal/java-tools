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

function normalizedArrayStoreExpression(value, op, array) {
  switch (op) {
    case "bastore":
      return `(${array}.type === "[Z" || ${array}.elementType === "boolean") ? ` +
        `((${value}) & 1) : (((${value}) << 24) >> 24)`;
    case "castore": return `((${value}) & 0xffff)`;
    case "sastore": return `(((${value}) << 16) >> 16)`;
    case "iastore": return `((${value}) | 0)`;
    case "fastore": return `Math.fround(${value})`;
    case "lastore": return `BigInt.asIntN(64, BigInt(${value}))`;
    case "aastore":
    case "dastore":
    default:
      return value;
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
    const environment = typeof process !== "undefined" && process.env
      ? process.env : {};
    const explicitlyEnabled = options.structuredSsa === true ||
      environment.JVM_ENABLE_STRUCTURED_SSA === "1";
    this._enabled = options.structuredSsa !== false &&
      environment.JVM_DISABLE_STRUCTURED_SSA !== "1";
    // Verified primitive-array loop bodies are the part of this tier with a
    // repeatable steady-state payoff, and compile() already rejects
    // unsupported CFGs and opcodes before emitting code. Enable that
    // conservative subset by default. Explicit structuredSsa=true retains the
    // broader acyclic-region experiment used by positional-call benchmarks.
    this.arrayLoopsOnly = !explicitlyEnabled;
    Object.defineProperty(this, "enabled", {
      configurable: true,
      enumerable: true,
      get: () => this._enabled,
      set: (value) => {
        this._enabled = Boolean(value);
        // Runtime probe switches historically toggled .enabled directly to
        // request the complete tier. Preserve that API while keeping only the
        // array-loop subset enabled in an untouched default runtime.
        if (value) this.arrayLoopsOnly = false;
      },
    });
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
    this.versionedRuntimeCoarseLoopsEnabled =
      options.structuredVersionedRuntimeCoarseLoops !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_VERSIONED_COARSE_LOOPS === "1");
    this.versionedArrayRangesEnabled =
      options.structuredVersionedArrayRanges !== false &&
      options.structuredVersionedArrayRangeStores !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_VERSIONED_ARRAY_RANGES === "1") &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_VERSIONED_ARRAY_STORES === "1");
    // Retain the old runtime probe property while range versioning expands
    // from stores to structurally proven primitive loads.
    this.versionedArrayRangeStoresEnabled =
      this.versionedArrayRangesEnabled;
    this.bitBoundedArrayRangesEnabled =
      this.versionedArrayRangesEnabled &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_BIT_BOUNDED_RANGES === "1");
    this.directEntryStaticLinkingEnabled =
      options.structuredDirectEntryStaticLinking !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_DIRECT_ENTRY_STATIC_LINKING === "1");
    this.atomicBoundedLoopsEnabled =
      options.structuredAtomicBoundedLoops !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_ATOMIC_BOUNDED_LOOPS === "1");
    this.materializeOutliningEnabled =
      options.structuredMaterializeOutlining !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_SSA_MATERIALIZE_OUTLINING === "1");
    this.acyclicInlineRestoringSpillsEnabled =
      options.structuredAcyclicInlineRestoringSpills !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_SSA_ACYCLIC_INLINE_SPILLS === "1");
    this.checkedLeafDirectPositionalEnabled =
      options.checkedLeafDirectPositional === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_CHECKED_LEAF_POSITIONAL === "1");
    this.unsignedArrayBoundsEnabled =
      options.structuredUnsignedArrayBounds !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_UNSIGNED_ARRAY_BOUNDS === "1");
    this.inlinePrimitiveArrayStoresEnabled =
      options.structuredInlinePrimitiveArrayStores !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_INLINE_ARRAY_STORES === "1");
    this.runCountersEnabled =
      options.structuredRunCounters !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_RUN_COUNTERS === "1");
    this.restoringDirectBudgetMultiplier = Math.max(1, Math.min(100,
      Number(options.structuredRestoringDirectBudgetMultiplier ??
        (typeof process !== "undefined" && process.env &&
          process.env.JVM_STRUCTURED_RESTORING_DIRECT_BUDGET_MULTIPLIER) ??
        100) || 100));
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
    this.restoringDirectRunCount = 0;
    this.lazyStaticTargetLinkCount = 0;
    // Generated bodies retain only an index into this table. A successful
    // proof is reusable until either class lifecycle epoch advances.
    this.classInitializationGuards = [];
    this.lastCompileError = null;
    this.lastRejectionReason = null;
  }

  registerClassInitializationGuard(owners) {
    const guard = {
      owners: [...new Set(owners)],
      classEpoch: -1,
      initializationEpoch: -1,
    };
    const id = this.classInitializationGuards.length;
    this.classInitializationGuards.push(guard);
    return id;
  }

  get totalRunCount() {
    // Restoring positional entries are tracked separately so a tiny child
    // kernel does not perform two property writes per call. Add the disjoint
    // counters only when diagnostics are sampled or reported.
    return this.runCount + this.restoringDirectRunCount;
  }

  verifyClassInitializationGuard(guard) {
    if (!guard) return false;
    for (const owner of guard.owners) {
      if (this.jit.jvm.classInitializationState.get(owner) !== "INITIALIZED") {
        return false;
      }
    }
    guard.classEpoch = this.jit.jvm.classEpoch || 0;
    guard.initializationEpoch = this.jit.jvm.classInitializationEpoch || 0;
    return true;
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
    if (this.arrayLoopsOnly) {
      const items = this.jit.getCodeItems(method);
      const primitiveArrayOperation = items.some((item) => {
        const instruction = item?.instruction;
        const op = typeof instruction === "string"
          ? instruction.trim().split(/\s+/)[0]
          : instruction?.op;
        return op === "arraylength" ||
          /^(?:[bcdfils]aload|[bcdfils]astore)$/.test(op);
      });
      if (!this.jit.hasBackwardBranch(method) || !primitiveArrayOperation) {
        return reject("default policy requires a primitive-array loop");
      }
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
    const depths = this.jit.computeStackDepths(items, labels, method);
    if (!depths) return reject("operand-stack verification failed");
    let prunedBooleanCfgBranches = 0;
    const prunedBooleanBranchTargets = new Map();
    const prunedBooleanReadIndexes = new Set();
    if (this.guardedStaticBooleansEnabled) {
      const instructionOp = (instruction) => !instruction ? null
        : typeof instruction === "string" ? instruction : instruction.op;
      const localSlot = (instruction, op) => {
        if (instruction && typeof instruction === "object" &&
            instruction.arg !== undefined) return Number(instruction.arg);
        const match = /_([0-3])$/.exec(op || "");
        return match ? Number(match[1]) : NaN;
      };
      for (let index = 0; index + 1 < items.length; index += 1) {
        const read = items[index]?.instruction;
        if (instructionOp(read) !== "getstatic" ||
            read.arg?.[2]?.[1] !== "Z") continue;
        const [, owner, [fieldName, descriptor]] = read.arg;
        if (this.jit.jvm.classInitializationState.get(owner) !==
            "INITIALIZED") continue;
        const fieldKey = JSON.stringify(read.arg);
        if (items.some((item) =>
          instructionOp(item?.instruction) === "putstatic" &&
          JSON.stringify(item.instruction.arg) === fieldKey)) continue;
        const store = items[index + 1]?.instruction;
        const storeOp = instructionOp(store);
        if (!/^istore(?:_[0-3])?$/.test(storeOp)) continue;
        const slot = localSlot(store, storeOp);
        if (!Number.isInteger(slot)) continue;
        let writes = 0;
        for (const item of items) {
          const instruction = item?.instruction;
          const op = instructionOp(instruction);
          if ((op === "iinc" &&
              Number(instruction.varnum ?? instruction.arg) === slot) ||
              (/^istore(?:_[0-3])?$/.test(op) &&
              localSlot(instruction, op) === slot)) writes += 1;
        }
        if (writes !== 1) continue;
        const target = this.jit.resolveStaticFieldSite({
          className: owner, fieldName, descriptor,
        }, false);
        if (!target) continue;
        const raw = target.kind === "map"
          ? target.fields.get(target.key) : target.fields[target.key];
        const booleanValue = raw ? 1 : 0;
        for (const block of cfg.blocks) {
          const blockItems = block.insns || [];
          if (blockItems.length < 2) continue;
          const branchIndex = blockItems[blockItems.length - 1];
          const loadIndex = blockItems[blockItems.length - 2];
          const branch = items[branchIndex]?.instruction;
          const branchOp = instructionOp(branch);
          const load = items[loadIndex]?.instruction;
          const loadOp = instructionOp(load);
          if ((branchOp !== "ifeq" && branchOp !== "ifne") ||
              !/^iload(?:_[0-3])?$/.test(loadOp) ||
              localSlot(load, loadOp) !== slot ||
              cfg.term[block.id]?.kind !== "cond") continue;
          const take = branchOp === "ifeq"
            ? booleanValue === 0 : booleanValue !== 0;
          const term = cfg.term[block.id];
          cfg.term[block.id] = {
            kind: "goto",
            target: take ? term.taken : term.fall,
          };
          prunedBooleanBranchTargets.set(
            branchIndex, cfg.term[block.id].target);
          prunedBooleanReadIndexes.add(index);
          prunedBooleanCfgBranches += 1;
        }
      }
      if (prunedBooleanCfgBranches > 0) {
        cfg.succ = cfg.term.map(succOfTerm);
        cfg.succAll = cfg.term.map(succAllOfTerm);
      }
    }
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
    // Exception handlers are entered by the JVM dispatcher after a throwing
    // operation has materialized the precise frame. They are deliberately not
    // successors in the normal CFG and must not make the normal positional
    // region look as though it allocates, invokes diagnostic builders, or
    // contains unsupported reference operations.
    const normalReachableItems = new Set();
    const reachableBlocks = new Set();
    const reachableWork = [cfg.entry];
    while (reachableWork.length) {
      const blockId = reachableWork.pop();
      if (!Number.isInteger(blockId) || reachableBlocks.has(blockId) ||
          !cfg.blocks[blockId]) continue;
      reachableBlocks.add(blockId);
      for (const itemIndex of cfg.blocks[blockId].insns || []) {
        normalReachableItems.add(itemIndex);
      }
      for (const successor of cfg.succ[blockId] || []) {
        if (!reachableBlocks.has(successor)) reachableWork.push(successor);
      }
    }
    const localCount = Number(code.code.localsSize) || 0;
    const fieldSites = new Map();
    const directStaticSites = new Map();
    const lazyStaticSites = new Map();
    const directStaticOwners = new Set();
    const callSites = new Map();
    const positionalCallSiteVariable = (index) => `ssaCallSite${index}`;
    const positionalCallTargetVariable = (index) =>
      `ssaFastPositional${index}`;
    const positionalCallInvokeVariable = (index) =>
      `ssaFastPositionalInvoke${index}`;
    const positionalCallRawInvokeVariable = (index) =>
      `ssaFastPositionalRawInvoke${index}`;
    const positionalCallReceiverVariable = (index) =>
      `ssaFastPositionalReceiver${index}`;
    for (let index = 0; index < items.length; index += 1) {
      if (depths[index] === undefined || !normalReachableItems.has(index)) continue;
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
          } else if (op === "getstatic" &&
              !(typeof process !== "undefined" && process.env &&
                process.env.JVM_DISABLE_STRUCTURED_LAZY_STATIC_TARGETS === "1")) {
            const plan = this.jit.fieldSites[fieldSite];
            const lazy = {
              site: fieldSite,
              variable: `ssaLazyStaticTarget${lazyStaticSites.size}`,
              className: plan.className,
            };
            lazyStaticSites.set(index, lazy);
            // The direct location can be learned only after initialization,
            // so give cold-compiled methods the same before-effects class
            // lifecycle guard as locations resolved during compilation.
            directStaticOwners.add(plan.className);
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
        const directCheckedLeaf = directJre || !isStatic || inline ||
          directIntrinsic ? null :
          this.jit.getCompileTimeCheckedLeaf(instruction);
        const directFused = directJre || !isStatic || inline || directIntrinsic ||
          directCheckedLeaf
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
          directCheckedLeaf,
          directFused,
        });
      }
    }
    // A protected non-void call can suspend after consuming its arguments.
    // Its ordinary framed entry therefore still needs the baseline return
    // handoff. Continue rendering the method, however: a separately verified
    // restoring positional entry is synchronous on its normal path and can
    // reconstruct the omitted child frame at the precise throwing operation.
    // JitCompiler uses this shape bit to select the baseline only for the
    // ordinary framed entry while retaining that generic positional kernel.
    const requiresBaselineFramedEntry =
      (code.code.exceptionTable || []).length > 0 &&
      [...callSites.values()].some((site) =>
        !site.returnsVoid && site.id !== null && site.id !== undefined);
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
    for (const index of prunedBooleanReadIndexes) {
      if (!guardedStaticBooleanSites.has(index)) {
        return reject("pruned boolean CFG branch lacks an entry guard");
      }
    }
    let nextValue = 0;
    const value = () => `ssaValue${nextValue++}`;
    const plans = [];
    const continuationFallbacks = new Map();
    const directEntryStaticReadFallbacks = new Map();
    const materializeDepths = new Set();
    let deferredCallMaterializationCount = 0;
    let reusedLocalLoadCount = 0;
    let eliminatedLocalStoreCount = 0;
    let sentinelArrayLoadCount = 0;
    let eliminatedArrayStoreCheckCount = 0;
    let specializedArrayRangeAccessCount = 0;
    const specializedArrayRangeAccesses = new Set();
    const arrayRangeCheckCandidates = [];
    const localIndex = (instruction, op) => {
      if (instruction && typeof instruction === "object" && instruction.arg !== undefined) {
        return Number(instruction.arg);
      }
      const match = /_([0-3])$/.exec(op || "");
      return match ? Number(match[1]) : NaN;
    };
    const opOf = (instruction) => !instruction ? null :
      (typeof instruction === "string" ? instruction : instruction.op);
    const arrayIndexOutOfBounds = (index, length) =>
      this.unsignedArrayBoundsEnabled
        ? `((${index} >>> 0) >= ${length})`
        : `(${index} < 0 || ${index} >= ${length})`;
    const methodIsStatic = (method.flags || []).includes("static") ||
      (Number(method.accessFlags) & 0x0008) !== 0;
    // In the single-threaded cooperative runtime, another Java thread can
    // mutate a static only after this generated entry yields. A call-free
    // method with no putstatic therefore sees one stable value for every
    // resolved getstatic location during the entry. Hoist that value (and a
    // primitive array's raw storage view) once. Any scheduler yield exits the
    // generated entry, so resumption observes a fresh value.
    // Reuse the generic transitive bytecode write summary already maintained
    // by the Wasm tier. A call that writes no static location cannot invalidate
    // a caller's cached clip bound or framebuffer reference. Summaries use the
    // conservative name:descriptor kill key (rather than assuming unrelated
    // owners never alias through inheritance); unresolved or dynamic calls
    // still invalidate everything.
    let hasUnknownStaticEffect = false;
    const entryStaticWriteKeys = new Set();
    const callFieldWriteSummaries = new Map();
    for (let index = 0; index < items.length; index += 1) {
      if (!normalReachableItems.has(index)) continue;
      const instruction = items[index]?.instruction;
      const op = opOf(instruction);
      if (op === "putstatic" || op === "putfield") {
        const member = instruction?.arg?.[2];
        if (!Array.isArray(member)) {
          hasUnknownStaticEffect = true;
          break;
        }
        entryStaticWriteKeys.add(`${member[0]}:${member[1]}`);
      } else if (op === "invokestatic") {
        const owner = instruction?.arg?.[1];
        const member = instruction?.arg?.[2];
        const summary = typeof owner === "string" && Array.isArray(member)
          ? this.jit.wasmJit?.staticWriteSummary(
            owner, member[0], member[1])
          : null;
        if (summary === null || summary === undefined) {
          callFieldWriteSummaries.set(index, null);
          hasUnknownStaticEffect = true;
          break;
        }
        callFieldWriteSummaries.set(index, summary);
        for (const key of summary) entryStaticWriteKeys.add(key);
      } else if (op === "invokespecial") {
        const owner = instruction?.arg?.[1];
        const member = instruction?.arg?.[2];
        const summary = typeof owner === "string" && Array.isArray(member)
          ? this.jit.wasmJit?.instanceWriteSummary(
            owner, member[0], member[1])
          : null;
        callFieldWriteSummaries.set(index, summary || null);
        if (summary === null || summary === undefined) {
          hasUnknownStaticEffect = true;
          break;
        }
        for (const key of summary) entryStaticWriteKeys.add(key);
      } else if (op === "invokevirtual") {
        const owner = instruction?.arg?.[1];
        const member = instruction?.arg?.[2];
        const classData = typeof owner === "string"
          ? this.jit.jvm.classes[owner] : null;
        const classNode = classData?.ast?.classes?.[0];
        const targetMethod = classData && Array.isArray(member)
          ? this.jit.jvm.findMethod(classData, member[0], member[1]) : null;
        const monomorphic = Boolean(
          classNode?.flags?.includes("final") ||
          targetMethod?.flags?.includes("final") ||
          targetMethod?.flags?.includes("private"));
        const summary = monomorphic
          ? this.jit.wasmJit?.instanceWriteSummary(
            owner, member[0], member[1])
          : null;
        callFieldWriteSummaries.set(index, summary || null);
        if (summary === null || summary === undefined) {
          hasUnknownStaticEffect = true;
          break;
        }
        for (const key of summary) entryStaticWriteKeys.add(key);
      } else if (op === "invokeinterface" || op === "invokedynamic") {
        callFieldWriteSummaries.set(index, null);
        hasUnknownStaticEffect = true;
        break;
      }
    }
    const entryStaticReadCaches = new Map();
    const entryStaticReadCacheEnabled =
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_ENTRY_STATIC_READ_CACHE === "1");
    if (entryStaticReadCacheEnabled && !hasUnknownStaticEffect) {
      for (const [index, direct] of directStaticSites) {
        if (direct.op !== "getstatic" ||
            entryStaticWriteKeys.has(direct.key) ||
            guardedStaticBooleanSites.has(index)) continue;
        const target = directTargetFor(direct);
        if (!target) continue;
        const key = `${direct.className}\0${direct.key}`;
        let cache = entryStaticReadCaches.get(key);
        if (!cache) {
          const number = entryStaticReadCaches.size;
          cache = {
            direct,
            value: `ssaEntryStaticValue${number}`,
            data: direct.descriptor?.startsWith("[")
              ? `ssaEntryStaticArrayData${number}` : null,
          };
          entryStaticReadCaches.set(key, cache);
        }
        direct.entryReadCache = cache;
      }
      // Cold-compiled sites do not receive a direct target until their first
      // initialized access. Snapshot an already-linked, non-volatile target
      // at each later generated entry. If it is still unresolved, the normal
      // bytecode read below performs linkage; the next invocation can hoist.
      const coldLinkedStaticReadCacheEnabled =
        !(typeof process !== "undefined" && process.env &&
          process.env.JVM_DISABLE_COLD_LINKED_STATIC_READ_CACHE === "1");
      const lexicalLoopBlocks = new Set();
      const collectLoopBlocks = (node, insideLoop = false) => {
        if (!node) return;
        const nested = insideLoop || node.t === "loop";
        if (node.t === "straight" && nested) {
          lexicalLoopBlocks.add(node.block);
        }
        if (node.t === "seq") {
          node.body.forEach((child) => collectLoopBlocks(child, nested));
        } else if (node.t === "if") {
          collectLoopBlocks(node.then, nested);
          collectLoopBlocks(node.els, nested);
        } else if (node.t === "loop" || node.t === "block") {
          collectLoopBlocks(node.body, nested);
        }
      };
      collectLoopBlocks(structured.tree);
      const itemBlock = new Map();
      for (const block of cfg.blocks) {
        for (const index of block.insns || []) itemBlock.set(index, block.id);
      }
      for (const [index, lazy] of lazyStaticSites) {
        if (!coldLinkedStaticReadCacheEnabled) break;
        const plan = this.jit.fieldSites[lazy.site];
        const fieldKey = plan && `${plan.fieldName}:${plan.descriptor}`;
        if (!plan || !fieldKey || entryStaticWriteKeys.has(fieldKey) ||
            !this.jit.canEliminateFieldRead(plan.arg) ||
            (plan.descriptor?.startsWith("[") ||
              plan.descriptor?.startsWith("L")) &&
            !lexicalLoopBlocks.has(itemBlock.get(index))) continue;
        const location = `${plan.className}\0${fieldKey}`;
        const existing = entryStaticReadCaches.get(location);
        if (existing) {
          lazy.entryReadCache = existing;
          continue;
        }
        const number = entryStaticReadCaches.size;
        const cache = {
          lazy,
          value: `ssaEntryStaticValue${number}`,
          valid: `ssaEntryStaticValid${number}`,
          data: plan.descriptor?.startsWith("[")
            ? `ssaEntryStaticArrayData${number}` : null,
        };
        entryStaticReadCaches.set(location, cache);
        lazy.entryReadCache = cache;
      }
    }
    // A non-volatile field is stable for one synchronous generated entry when
    // the method contains neither an instance-field write nor a call that
    // could perform one. Cache repeated reads by symbolic field plus receiver
    // identity. The cache dies at a scheduler safe point, before another Java
    // thread can run. Selection is entirely bytecode/field-shape based.
    const fieldReadCaches = new Map();
    const fieldReadCacheSites = new Map();
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
          killKey: this.jit.fieldSites[site]
            ? `${this.jit.fieldSites[site].fieldName}:` +
              `${this.jit.fieldSites[site].descriptor}`
            : null,
        };
        fieldReadCaches.set(key, cache);
      }
      cache.indexes.push(index);
      fieldReadCacheSites.set(index, cache);
    }
    const entryArrayLocalSlots = new Set(
      method.jvmStructuredEntryArrayLocals || []);
    const entryReferenceLocalSlots = new Set(methodIsStatic ? [] : [0]);
    // Keep primitive-array parameter storage in one scalar view for the
    // lifetime of a synchronous generated entry. This is descriptor-driven:
    // the Java array reference remains canonical in the JVM local, while the
    // raw view is only an unobservable cache used by checked load/store
    // emission. `undefined` remains the exceptional sentinel, so null and
    // bounds failures still materialize the precise bytecode state.
    try {
      const entryDescriptor = parseDescriptor(method.descriptor);
      let entrySlot = methodIsStatic ? 0 : 1;
      for (const parameterType of entryDescriptor.params) {
        if (!["boolean", "byte", "char", "short", "int",
          "long", "float", "double"].includes(parameterType)) {
          entryReferenceLocalSlots.add(entrySlot);
        }
        if (["boolean[]", "byte[]", "char[]", "short[]", "int[]",
          "float[]", "double[]", "long[]"].includes(parameterType)) {
          entryArrayLocalSlots.add(entrySlot);
        }
        entrySlot += parameterType === "long" || parameterType === "double"
          ? 2 : 1;
      }
    } catch (_) {
      // Descriptor validation elsewhere will reject malformed methods.
    }
    const entryArrayDataVariable = (slot) => `ssaEntryArrayData${slot}`;
    const guardedEntryArrayData = new Set([
      ...[...entryArrayLocalSlots].map(entryArrayDataVariable),
      ...[...entryStaticReadCaches.values()]
        .filter((cache) => !cache.lazy)
        .map((cache) => cache.data).filter(Boolean),
    ]);
    const entryStaticArrayData = new Set(
      [...entryStaticReadCaches.values()]
        .map((cache) => cache.data).filter(Boolean));
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
    const assignedReferenceLocals = new Set();
    for (const item of items) {
      const instruction = item?.instruction;
      const op = opOf(instruction);
      if (/^astore(?:_[0-3])?$/.test(op)) {
        assignedReferenceLocals.add(localIndex(instruction, op));
      }
    }
    const directlyLoadsEntryReference = (index) => {
      const instruction = items[index - 1]?.instruction;
      const op = opOf(instruction);
      if (!/^aload(?:_[0-3])?$/.test(op)) return null;
      const slot = localIndex(instruction, op);
      return entryReferenceLocalSlots.has(slot) &&
        !assignedReferenceLocals.has(slot) ? slot : null;
    };
    for (const cache of fieldReadCaches.values()) {
      cache.eagerThis = !hasUnknownStaticEffect &&
        cache.killKey && !entryStaticWriteKeys.has(cache.killKey) &&
        !methodIsStatic && !localZeroAssigned &&
        cache.indexes.every(directlyLoadsThis);
      const entrySlots = cache.indexes.map(directlyLoadsEntryReference);
      cache.eagerLocal = !hasUnknownStaticEffect &&
        cache.killKey && !entryStaticWriteKeys.has(cache.killKey) &&
        entrySlots[0] !== null &&
        entrySlots.every((slot) => slot === entrySlots[0])
        ? entrySlots[0] : null;
    }
    // Eager primitive-array fields are loaded before the generated body and
    // remain stable for one synchronous entry under the same write-summary
    // proof as their scalar field cache. Make those raw views available to
    // loop range analysis as well. A method that actually yields is handled
    // below by disabling lexical continuation for field-backed range guards;
    // the baseline resume then refreshes both the field and the proof.
    const eagerEntryFieldArrayData = new Set();
    for (const cache of fieldReadCaches.values()) {
      if (cache.isArray && cache.eagerLocal !== null &&
          cache.eagerLocal !== undefined) {
        eagerEntryFieldArrayData.add(cache.data);
        guardedEntryArrayData.add(cache.data);
      }
    }
    const invalidateFieldReadCaches = (writeKeys = null) =>
      [...fieldReadCaches.values()]
        .filter((cache) => !writeKeys ||
          !cache.killKey || writeKeys.has(cache.killKey))
        .flatMap((cache) => [
        `${cache.valid} = false;`,
        ...(cache.isArray ? [`${cache.data} = null;`] : []),
      ]);
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
    const materializeLines = (operandValues, pc) => {
      if (!this.materializeOutliningEnabled) {
        return [
          "spillLocals();",
          ...operandValues.map((expression, index) =>
            `stack[${index}] = ${expression};`),
          `stack.length = ${operandValues.length};`,
          `helpers.materialize(frame, locals, stack, ${pc});`,
        ];
      }
      materializeDepths.add(operandValues.length);
      return [
        `ssaMaterialize${operandValues.length}(${
          [pc, ...operandValues].join(", ")});`,
      ];
    };
    // A synchronous guest call can throw after installing its child Frame.
    // If that child catches the exception, its eventual return must resume
    // this frame after the invoke with only the operands below the arguments.
    // If no child was installed (for example, a direct JRE intrinsic threw),
    // the exception belongs to this frame and must retain the invoke pc and
    // complete pre-call stack for normal handler dispatch.
    const materializeCallExceptionLines = (
      preCallValues, postCallValues, pc, childCanResume = "true",
    ) => [
      `if (${childCanResume} && thread.callStack.items.length && ` +
        "thread.callStack.peek() !== frame) {",
      ...materializeLines(postCallValues, pc + 1).map((line) => `  ${line}`),
      "} else {",
      ...materializeLines(preCallValues, pc).map((line) => `  ${line}`),
      "}",
    ];
    const stageOperandLines = (operandValues) => [
      "if (frame === null) spillLocals();",
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
      const integerOrigins = new Map();
      // Repeated getstatic bytecodes in one straight-line block often load the
      // same framebuffer before a sequence of unrolled stores. Reuse that
      // value only within the block and only until a call/static write, so a
      // scheduler safe point or arbitrary guest effect can never stale it.
      const directStaticBlockValues = new Map();
      const fieldArraySnapshots = new Map();
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
          // Even when the current local value already has an SSA name, this
          // bytecode load establishes the symbolic local slot used by loop
          // recurrence and range analysis.
          integerOrigins.set(cached, {kind: "local", slot});
          if (entryArrayLocalSlots.has(slot)) {
            arrayViews.set(cached, entryArrayDataVariable(slot));
          }
          return cached;
        }
        const out = value();
        lines.push(`const ${out} = local${slot};`);
        integerOrigins.set(out, {kind: "local", slot});
        if (entryArrayLocalSlots.has(slot)) {
          arrayViews.set(out, entryArrayDataVariable(slot));
        }
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
      const binary = (format, originOp = null) => {
        const right = pop(), left = pop();
        if (left === null || right === null) { valid = false; return; }
        const out = value(); lines.push(`const ${out} = ${format(left, right)};`); stack.push(out);
        if (originOp) {
          integerOrigins.set(out, {kind: originOp, left, right});
        }
      };
      const boundedIntegerRange = (input, visited = new Set()) => {
        if (/^-?\d+$/.test(input)) {
          const constant = Number(input);
          return Number.isSafeInteger(constant) &&
            constant >= -2147483648 && constant <= 2147483647
            ? {minimum: constant, maximum: constant} : null;
        }
        if (visited.has(input)) return null;
        visited.add(input);
        const origin = integerOrigins.get(input);
        if (!origin) return null;
        const left = boundedIntegerRange(origin.left, new Set(visited));
        const right = boundedIntegerRange(origin.right, new Set(visited));
        if (origin.kind === "iand") {
          const mask = left && left.minimum === left.maximum &&
              left.minimum >= 0 ? left.minimum
            : right && right.minimum === right.maximum &&
              right.minimum >= 0 ? right.minimum : null;
          return Number.isInteger(mask)
            ? {minimum: 0, maximum: mask} : null;
        }
        if (origin.kind === "iushr") {
          if (!right || right.minimum !== right.maximum) return null;
          const shift = right.minimum & 31;
          if (shift === 0) return null;
          return {
            minimum: 0,
            maximum: (2 ** (32 - shift)) - 1,
          };
        }
        if ((origin.kind === "iadd" || origin.kind === "isub") &&
            left && right) {
          const minimum = origin.kind === "iadd"
            ? left.minimum + right.minimum
            : left.minimum - right.maximum;
          const maximum = origin.kind === "iadd"
            ? left.maximum + right.maximum
            : left.maximum - right.minimum;
          // Java integer arithmetic wraps. An interval is valid only when no
          // member of either operand range can overflow this operation.
          if (minimum < -2147483648 || maximum > 2147483647) return null;
          return {minimum, maximum};
        }
        return null;
      };
      const arrayRangeMarkerFor = (arrayData, indexInput, itemIndex) => {
        // A loop preheader may only name storage views declared at generated
        // entry. Block-local snapshots (including non-eager field caches) are
        // not in lexical scope yet, and field-cache views can also be cleared
        // at a continuation safe point. Keep those accesses on the checked
        // sentinel path rather than emitting a preheader proof that references
        // a missing or stale SSA value.
        if (!arrayData || !guardedEntryArrayData.has(arrayData)) return "false";
        const fixedRange = this.bitBoundedArrayRangesEnabled
          ? boundedIntegerRange(indexInput) : null;
        const indexOrigin = integerOrigins.get(indexInput);
        const leftOrigin = indexOrigin?.kind === "iadd"
          ? integerOrigins.get(indexOrigin.left) : null;
        const rightOrigin = indexOrigin?.kind === "iadd"
          ? integerOrigins.get(indexOrigin.right) : null;
        const exactInteger = (expression) => {
          const range = boundedIntegerRange(expression);
          return range && range.minimum === range.maximum
            ? range.minimum : null;
        };
        const scaledLocal = (expression, offset = 0) => {
          const origin = integerOrigins.get(expression);
          if (origin?.kind !== "ishl") return null;
          const left = integerOrigins.get(origin.left);
          const shift = exactInteger(origin.right);
          if (left?.kind !== "local" || !Number.isInteger(shift)) return null;
          const normalizedShift = shift & 31;
          // Shifts by 31 are sign-changing rather than monotonically scaled.
          if (normalizedShift > 30) return null;
          return {
            slot: left.slot,
            scale: 2 ** normalizedShift,
            offset,
          };
        };
        let scaled = scaledLocal(indexInput);
        if (!scaled && indexOrigin?.kind === "iadd") {
          const leftConstant = exactInteger(indexOrigin.left);
          const rightConstant = exactInteger(indexOrigin.right);
          scaled = leftConstant !== null
            ? scaledLocal(indexOrigin.right, leftConstant)
            : rightConstant !== null
              ? scaledLocal(indexOrigin.left, rightConstant) : null;
        }
        let candidate = null;
        if (fixedRange && fixedRange.minimum >= 0) {
          candidate = {
            kind: "bounded-index",
            block: block.id,
            itemIndex,
            arrayData,
            slots: [],
            ...fixedRange,
          };
        } else if (scaled) {
          candidate = {
            kind: "scaled-local",
            block: block.id,
            itemIndex,
            arrayData,
            slots: [scaled.slot],
            scale: scaled.scale,
            offset: scaled.offset,
          };
        } else if (leftOrigin?.kind === "local" &&
            rightOrigin?.kind === "local") {
          candidate = {
            kind: "base-plus-induction",
            block: block.id,
            itemIndex,
            arrayData,
            slots: [leftOrigin.slot, rightOrigin.slot],
          };
        } else if (indexOrigin?.kind === "local") {
          candidate = {
            kind: "affine-local",
            block: block.id,
            itemIndex,
            arrayData,
            slots: [indexOrigin.slot],
          };
        }
        if (!candidate) return "false";
        candidate.marker =
          `__SSA_ARRAY_RANGE_GUARD_${arrayRangeCheckCandidates.length}__`;
        arrayRangeCheckCandidates.push(candidate);
        return candidate.marker;
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
        } else if (op === "iadd") {
          binary((a, b) => `((${a} + ${b}) | 0)`, "iadd");
        }
        else if (op === "isub") {
          binary((a, b) => `((${a} - ${b}) | 0)`, "isub");
        }
        else if (op === "imul") {
          binary((a, b) => `Math.imul(${a}, ${b})`, "imul");
        }
        else if (op === "iand") binary((a, b) => `(${a} & ${b})`, "iand");
        else if (op === "ior") binary((a, b) => `(${a} | ${b})`);
        else if (op === "ixor") binary((a, b) => `(${a} ^ ${b})`);
        else if (op === "ishl") {
          binary((a, b) => `(${a} << (${b} & 31))`, "ishl");
        }
        else if (op === "ishr") binary((a, b) => `(${a} >> (${b} & 31))`);
        else if (op === "iushr") {
          binary((a, b) => `((${a} >>> (${b} & 31)) | 0)`, "iushr");
        }
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
              const rangeMarker =
                arrayRangeMarkerFor(arrayData, arrayIndexInput, index);
              const loadFailure = guardedEntryArrayData.has(arrayData)
                ? `((${out} = ${arrayData}[${arrayIndex}]) === undefined)`
                : `(${arrayData} === null || ` +
                  `(${out} = ${arrayData}[${arrayIndex}]) === undefined)`;
              const provenLoad = normalizedArrayLoadExpression(
                `${arrayData}[${arrayIndex}]`, op, array);
              const successfulLoad =
                `${out} = ${rangeMarker} ? ${provenLoad} : ${normalized};`;
              lines.push(
                `if (!${rangeMarker} && ${loadFailure}) {`,
                ...materializeLines([...stack, array, arrayIndex], index).map((line) => `  ${line}`),
                `  ${out} = helpers.arrayLoad(${arrayIndex}, ${array}, frame, ${JSON.stringify(op)});`,
                "} else {",
                `  ${successfulLoad}`,
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
                `if (${array} === null || ${array} === undefined || ${
                  arrayIndexOutOfBounds(arrayIndex, `${array}.length`)}) {`,
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
            // The opcode fixes primitive narrowing. Keep it in the generated
            // block instead of crossing a generic helper boundary per element.
            // `bastore` retains its runtime [B/[Z distinction; all other
            // primitive kinds are determined completely by the opcode.
            const normalizedStore = this.inlinePrimitiveArrayStoresEnabled
              ? normalizedArrayStoreExpression(stored, op, array)
              : op === "iastore"
                ? `((${stored}) | 0)`
                : `helpers.normalizeArrayStore(${stored}, ${
                  JSON.stringify(op)}, ${array})`;
            const checkedKey = arrayData && `${arrayData}\0${arrayIndexInput}`;
            if (op !== "aastore" && checkedKey &&
                checkedPrimitiveArrayAccesses.has(checkedKey)) {
              lines.push(`${arrayData}[${arrayIndex}] = ${normalizedStore};`);
              eliminatedArrayStoreCheckCount += 1;
            } else if (op !== "aastore" && arrayData &&
                guardedEntryArrayData.has(arrayData)) {
              const rangeMarker =
                arrayRangeMarkerFor(arrayData, arrayIndexInput, index);
              lines.push(
                `if (!${rangeMarker} && ` +
                  `${arrayIndexOutOfBounds(
                    arrayIndex, `${arrayData}.length`)}) {`,
                ...materializeLines([...stack, array, arrayIndex, stored], index)
                  .map((line) => `  ${line}`),
                `  helpers.arrayStore(${stored}, ${arrayIndex}, ${array}, frame, ${JSON.stringify(op)});`,
                "} else {",
                `  ${arrayData}[${arrayIndex}] = ${normalizedStore};`,
                "}",
              );
            } else {
              lines.push(
                `if (${array} === null || ${array} === undefined || ${
                  arrayIndexOutOfBounds(arrayIndex, `${array}.length`)}) {`,
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
            if (cache?.eagerLocal !== null &&
                cache?.eagerLocal !== undefined) {
              if (!cache.eagerThis) {
                lines.push(`if (${object} === null || ${object} === undefined) {`,
                  ...materializeLines([...stack, object], index).map((line) => `  ${line}`),
                  `  helpers.getFieldAt(${site}, ${object});`, "}");
              }
              lines.push(`const ${out} = ${cache.value};`);
            } else {
              lines.push(`if (${object} === null || ${object} === undefined) {`,
                ...materializeLines([...stack, object], index).map((line) => `  ${line}`),
                `  helpers.getFieldAt(${site}, ${object});`, "}");
            }
            if (cache && (cache.eagerLocal === null ||
                cache.eagerLocal === undefined)) {
              lines.push(`let ${out};`,
                `if (${cache.valid} && ${cache.object} === ${object}) {`,
                `  ${out} = ${cache.value};`, "} else {",
                `  ${out} = ${directRead};`,
                `  ${cache.object} = ${object};`,
                `  ${cache.value} = ${out};`,
                ...(cache.isArray ? [`  ${cache.data} = helpers.arrayData(${out});`] : []),
                `  ${cache.valid} = true;`, "}");
            } else if (!cache) {
              lines.push(`const ${out} = ${directRead};`);
            }
            if (cache?.isArray) {
              if (cache.eagerLocal !== null &&
                  cache.eagerLocal !== undefined) {
                // Transitive field-write analysis proved this entry reference
                // and field stable until the next scheduler boundary. Keep
                // its raw array view in the entry-scoped cache variable so a
                // natural-loop range guard can name it outside the block.
                arrayViews.set(out, cache.data);
                stack.push(out);
                continue;
              }
              // The field cache may be invalidated or rebound by a later
              // guest call/write while this earlier array reference remains
              // live on the SSA operand stack. Snapshot its storage companion
              // so future cache maintenance cannot retarget this value.
              let dataSnapshot = fieldArraySnapshots.get(cache);
              if (!dataSnapshot) {
                dataSnapshot = value();
                lines.push(`const ${dataSnapshot} = ${cache.data};`);
                fieldArraySnapshots.set(cache, dataSnapshot);
              }
              arrayViews.set(out, dataSnapshot);
            }
            stack.push(out);
          }
        } else if (op === "putfield") {
          fieldArraySnapshots.clear();
          const storedInput = pop(), objectInput = pop(), site = fieldSites.get(index);
          if (storedInput === null || objectInput === null || site === undefined) valid = false;
          else {
            const object = value(), stored = value();
            const fieldPlan = this.jit.fieldSites[site];
            const directKey = fieldPlan?.directInstanceKey || null;
            const writeKeys = fieldPlan
              ? new Set([`${fieldPlan.fieldName}:${fieldPlan.descriptor}`])
              : null;
            lines.push(...invalidateFieldReadCaches(writeKeys),
              `const ${object} = ${objectInput};`, `const ${stored} = ${storedInput};`,
              `if (${object} === null || ${object} === undefined) {`,
              ...materializeLines([...stack, object, stored], index).map((line) => `  ${line}`),
              `  helpers.putFieldAt(${site}, ${object}, ${stored});`, "}",
              ...(directKey ? [
                `if (${object}.fields) {`,
                `  ${object}.fields[${JSON.stringify(directKey)}] = ${stored};`,
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
            const entryCache = direct.entryReadCache;
            if (entryCache) {
              stack.push(entryCache.value);
              if (entryCache.data) {
                arrayViews.set(entryCache.value, entryCache.data);
              }
              continue;
            }
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
            const lazy = lazyStaticSites.get(index);
            if (lazy) {
              const cache = lazy.entryReadCache;
              const emitted = cache &&
                  this.directEntryStaticLinkingEnabled ? [] : lines;
              const prefix = cache ? "  " : "";
              emitted.push(`let ${out};`);
              if (cache) {
                emitted.push(`if (${cache.valid}) {`,
                  `  ${out} = ${cache.value};`,
                  "} else {");
              }
              emitted.push(`${prefix}if (${lazy.variable}) {`,
                `${prefix}  ${out} = ${lazy.variable}.kind === "map" ? ` +
                  `${lazy.variable}.fields.get(${lazy.variable}.key) : ` +
                  `${lazy.variable}.fields[${lazy.variable}.key];`,
                `${prefix}} else {`,
                `${prefix}  ${out} = helpers.getStaticSyncAt(${site});`,
                `${prefix}  if (${out} === helpers.staticDeopt()) {`,
                ...materializeLines(stack, index).map(
                  (line) => `${prefix}    ${line}`),
                `${prefix}    helpers.skipJitOnce(frame);`,
                `${prefix}    return { deopt: true, transient: true, reason: 'class initialization in structured SSA getstatic' };`,
                `${prefix}  }`,
                `${prefix}  ${lazy.variable} = helpers.fieldSites[${site}].staticTarget;`,
                `${prefix}  if (${lazy.variable}) helpers.structuredSsa.lazyStaticTargetLinkCount += 1;`,
                `${prefix}}`);
              if (cache) emitted.push("}");
              if (emitted !== lines) {
                const marker =
                  `__JVM_DIRECT_ENTRY_STATIC_READ_${index}_${site}__`;
                directEntryStaticReadFallbacks.set(marker, {
                  direct: [`const ${out} = ${cache.value};`],
                  ordinary: emitted,
                });
                lines.push(marker);
              }
            } else {
              lines.push(`const ${out} = helpers.getStaticSyncAt(${site});`,
              `if (${out} === helpers.staticDeopt()) {`,
              ...materializeLines(stack, index).map((line) => `  ${line}`),
              "  helpers.skipJitOnce(frame);",
              "  return { deopt: true, transient: true, reason: 'class initialization in structured SSA getstatic' };", "}");
            }
            stack.push(out);
            const lazyCache = lazy?.entryReadCache;
            if (lazyCache?.data) {
              arrayViews.set(out, lazyCache.data);
            }
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
          fieldArraySnapshots.clear();
          lines.push(...invalidateFieldReadCaches(
            callFieldWriteSummaries.get(index)));
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
              site.directIntrinsic?.kind === "perspectiveTexturedSpan" ||
              site.directIntrinsic?.kind === "affineSpriteRaster") &&
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
                "  return { deopt: true, transient: true, reason: 'guarded direct raster fallback' };", "}");
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
                ...materializeCallExceptionLines(callStack, stack, index)
                  .map((line) => `  ${line}`),
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
              ...materializeCallExceptionLines(callStack, stack, index)
                .map((line) => `  ${line}`),
              `  throw ${caught};`, "}",
            ];
            lines.push(`let ${out};`);
            if (site.id !== null && site.id !== undefined) {
              const usedDirect = value();
              const runtimeSite = positionalCallSiteVariable(index);
              const positionalTarget = positionalCallTargetVariable(index);
              const positionalInvoke = positionalCallInvokeVariable(index);
              const positionalRawInvoke =
                positionalCallRawInvokeVariable(index);
              const positionalRawCaptures =
                (site.directCheckedLeaf?.captures || []).flatMap(
                  (capture, captureIndex, captures) => {
                    let offset = 0;
                    for (let earlier = 0; earlier < captureIndex; earlier += 1) {
                      offset += captures[earlier].data ? 2 : 1;
                    }
                    const values = [`ssaCallCapture${index}_${offset}`];
                    if (capture.data) {
                      values.push(`ssaCallCapture${index}_${offset + 1}`);
                    }
                    return values;
                  });
              const positionalReceiver =
                positionalCallReceiverVariable(index);
              const receiverGuard = site.dynamic && site.argumentCount > 0
                ? `${args[0]} !== null && ${args[0]} !== undefined && ` +
                  `(${args[0]}.type || ${runtimeSite}.declaredClassName) === ` +
                  positionalReceiver
                : site.hasReceiver && site.argumentCount > 0
                  ? `${args[0]} !== null && ${args[0]} !== undefined && ` +
                    `${positionalReceiver} === null`
                  : "true";
              lines.push(
                `let ${usedDirect} = false;`,
                `if ((${positionalRawInvoke} || ${positionalInvoke}) && ${receiverGuard}) {`,
                `  ${usedDirect} = true;`,
                `  try { ${out} = ${positionalRawInvoke} ? ` +
                  `${positionalRawInvoke}(helpers${args.length ? ", " : ""}` +
                  `${args.join(", ")}${positionalRawCaptures.length
                    ? `${args.length ? ", " : ""}${positionalRawCaptures.join(", ")}`
                    : ""}${args.length || positionalRawCaptures.length
                    ? ", " : ", "}thread, true) : ` +
                  `${positionalInvoke}(${args.join(", ")}${
                    args.length ? ", " : ""}thread, true); } catch (${caught}) {`,
                ...materializeCallExceptionLines(
                  callStack, stack, index,
                  `!${positionalInvoke}.jvmRestoresExceptionFrames`,
                )
                  .map((line) => `    ${line}`),
                `    throw ${caught};`, "  }", "}",
                `if (!${usedDirect} || ${out} === helpers.asyncInvokeSentinel()) {`,
                ...fallbackLines.map((line) => `  ${line}`),
                "}",
              );
            } else {
              lines.push(...fallbackLines);
            }
            lines.push(`if (${out} === helpers.asyncInvokeSentinel()) {`,
              ...(resumableVoidCall ? [asynchronousCallMarker] : [
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                "  helpers.skipJitOnce(frame);",
                "  return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };",
              ]), "}");
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
          if (prunedBooleanBranchTargets.has(index)) {
            const input = pop();
            const target = prunedBooleanBranchTargets.get(index);
            const edge = input === null ? null : edgeLines(target, stack);
            if (!edge) valid = false;
            else {
              lines.push(...edge);
              plans[block.id] = {
                lines, returnKind, returnValue, stack: [...stack],
              };
            }
            continue;
          }
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

    // Bytecode stack staging can create long chains such as
    // `const v7 = v3; const v9 = v7;`. Both names are immutable SSA values,
    // so retaining the aliases only enlarges the optimizing compiler's graph
    // and increases register pressure in numeric kernels. Coalesce only
    // exact, top-level SSA-to-SSA declarations; locals, transfer slots, field
    // caches, and nested lexical declarations are intentionally excluded.
    // This is ordinary SSA copy propagation and is independent of guest
    // identity or algorithm shape.
    let coalescedSsaCopyCount = 0;
    for (const plan of plans) {
      if (!plan?.lines?.length) continue;
      const aliases = new Map();
      const resolveAlias = (name) => {
        const visited = new Set();
        let current = name;
        while (aliases.has(current) && !visited.has(current)) {
          visited.add(current);
          current = aliases.get(current);
        }
        return current;
      };
      const removed = new Set();
      for (let index = 0; index < plan.lines.length; index += 1) {
        const match = /^const (ssaValue\d+) = (ssaValue\d+);$/.exec(
          plan.lines[index]);
        if (!match) continue;
        aliases.set(match[1], resolveAlias(match[2]));
        removed.add(index);
        coalescedSsaCopyCount += 1;
      }
      if (!aliases.size) continue;
      const substitute = (source) => {
        if (typeof source !== "string") return source;
        return source.replace(/\bssaValue\d+\b/g,
          (name) => resolveAlias(name));
      };
      plan.lines = plan.lines
        .filter((_line, index) => !removed.has(index))
        .map(substitute);
      plan.condition = substitute(plan.condition);
      plan.returnValue = substitute(plan.returnValue);
      if (plan.stack) plan.stack = plan.stack.map(substitute);
      if (plan.takenStack) plan.takenStack = plan.takenStack.map(substitute);
      if (plan.fallStack) plan.fallStack = plan.fallStack.map(substitute);
    }

    // Generator continuations preserve lexical SSA locals across a cooperative
    // browser yield. Guarded static constants are rechecked before resuming;
    // if another Java thread changed one, the exact materialized bytecode state
    // resumes in the baseline body instead of re-entering stale lexical state.
    let useContinuations = this.continuationsEnabled &&
      structured.loopHeaders.size > 0;
    if ([...callSites.values()].some((site) =>
      Array.isArray(site.directCheckedLeaf?.captures) &&
      site.directCheckedLeaf.captures.length > 0)) {
      // Captured non-volatile child statics are stable for one synchronous
      // scheduler slice. If this caller reaches a safe point, resume through
      // the canonical frame so the next execution snapshots fresh values.
      useContinuations = false;
    }
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
      .filter((cache) =>
        cache.eagerLocal === null || cache.eagerLocal === undefined)
      .flatMap((cache) => [
        `${cache.valid} = false;`,
        `${cache.object} = null;`,
        ...(cache.isArray ? [`${cache.data} = null;`] : []),
      ]);
    const refreshEagerFieldCacheLines = [...fieldReadCaches.values()]
      .filter((cache) =>
        cache.eagerLocal !== null && cache.eagerLocal !== undefined)
      .flatMap((cache) => [
        `if (local${cache.eagerLocal} !== null && ` +
          `local${cache.eagerLocal} !== undefined) {`,
        `  ${cache.value} = ${cache.directKey
          ? `(local${cache.eagerLocal}.fields && ` +
            `local${cache.eagerLocal}.fields[${JSON.stringify(cache.directKey)}] !== undefined ? ` +
            `local${cache.eagerLocal}.fields[${JSON.stringify(cache.directKey)}] : ` +
            `helpers.getFieldAt(${cache.site}, local${cache.eagerLocal}))`
          : `helpers.getFieldAt(${cache.site}, local${cache.eagerLocal})`};`,
        ...(cache.isArray ? [
          `  ${cache.data} = helpers.arrayData(${cache.value});`,
        ] : []),
        "}",
      ]);
    const refreshEntryStaticCacheLines =
      [...entryStaticReadCaches.values()].flatMap((cache) => {
        if (cache.lazy) {
          const lazy = cache.lazy;
          const read = `${lazy.variable}.kind === "map" ? ` +
            `${lazy.variable}.fields.get(${lazy.variable}.key) : ` +
            `${lazy.variable}.fields[${lazy.variable}.key]`;
          return [
            `${lazy.variable} = helpers.fieldSites[${lazy.site}].staticTarget;`,
            `${cache.valid} = Boolean(${lazy.variable});`,
            `${cache.value} = ${cache.valid} ? ${read} : undefined;`,
            ...(cache.data
              ? [`${cache.data} = ${cache.valid} ? ` +
                `helpers.arrayData(${cache.value}) : null;`]
              : []),
          ];
        }
        const direct = cache.direct;
        const fields =
          `helpers.directStaticTargets[${direct.targetId}].fields`;
        const read = direct.kind === "map"
          ? `${fields}.get(${JSON.stringify(direct.key)})`
          : `${fields}[${JSON.stringify(direct.key)}]`;
        return [
          `${cache.value} = ${read};`,
          ...(cache.data
            ? [`${cache.data} = helpers.arrayData(${cache.value});`]
            : []),
        ];
      });
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
    const countedLoopInfo = (node) => {
      if (!node || node.t !== "loop") return null;
      const header = Number(node.label.slice(1));
      const block = cfg.blocks[header];
      if (!block || block.synthetic || cfg.term[header]?.kind !== "cond") return null;
      const headerInstructions = block.insns
        .map((index) => items[index]?.instruction).filter(Boolean);
      if (headerInstructions.length < 2) return null;
      const branch = headerInstructions[headerInstructions.length - 1];
      const branchOp = opOf(branch);
      let bound = null;
      let boundSlot = null;
      let boundExpression = null;
      let loadInstruction = null;
      if (branchOp === "ifge") {
        bound = 0;
        boundExpression = "0";
        loadInstruction = headerInstructions[headerInstructions.length - 2];
      } else if (branchOp === "if_icmpge" &&
          headerInstructions.length >= 3) {
        const boundItemIndex =
          block.insns[block.insns.length - 2];
        const boundInstruction =
          headerInstructions[headerInstructions.length - 2];
        bound = constantInstructionValue(boundInstruction);
        if (bound !== null) {
          boundExpression = String(bound);
        } else {
          const boundOp = opOf(boundInstruction);
          if (/^iload(?:_[0-3])?$/.test(boundOp)) {
            boundSlot = localIndex(boundInstruction, boundOp);
            if (!Number.isInteger(boundSlot)) return null;
            boundExpression = `local${boundSlot}`;
          } else if (boundOp === "getstatic") {
            // An entry-snapshotted, read-only scalar static is as invariant
            // as an unmodified bound local for this generated invocation.
            // This admits ordinary raster/codec row loops whose dimensions
            // javac reads directly from a static field at the header.
            const direct = directStaticSites.get(boundItemIndex);
            if (!direct?.entryReadCache?.value ||
                direct.descriptor !== "I") return null;
            boundExpression = direct.entryReadCache.value;
          } else {
            return null;
          }
        }
        loadInstruction = headerInstructions[headerInstructions.length - 3];
      } else {
        return null;
      }
      const loadOp = opOf(loadInstruction);
      if (!/^iload(?:_[0-3])?$/.test(loadOp)) return null;
      const slot = localIndex(loadInstruction, loadOp);
      if (!Number.isInteger(slot) || !boundExpression ||
          boundSlot === slot) return null;

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
      let increment = null;
      let writes = 0;
      let incrementBlock = null;
      let boundWrites = 0;
      const writtenSlots = new Set();
      for (const loopBlock of loopBlocks) {
        for (const itemIndex of cfg.blocks[loopBlock].insns) {
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          const writtenSlot = op === "iinc"
            ? Number(instruction.varnum ?? instruction.arg)
            : /^istore(?:_[0-3])?$/.test(op)
              ? localIndex(instruction, op) : null;
          if (Number.isInteger(writtenSlot)) writtenSlots.add(writtenSlot);
          if (boundSlot !== null && writtenSlot === boundSlot) {
            boundWrites += 1;
          }
          if (op === "iinc" && Number(instruction.varnum ?? instruction.arg) === slot) {
            writes += 1;
            increment = Number(instruction.incr ?? 0);
            incrementBlock = loopBlock;
          } else if (/^istore(?:_[0-3])?$/.test(op) &&
              localIndex(instruction, op) === slot) {
            writes += 1;
          }
        }
      }
      // Obfuscator guards often put a side-effect-free branch between the
      // unique induction update and the literal CFG backedge. Require the
      // update to dominate every backedge path inside the natural loop,
      // rather than requiring both bytecodes to share one basic block.
      const reachesBackedgeWithoutIncrement = (backedge) => {
        if (incrementBlock === header || incrementBlock === backedge) {
          return false;
        }
        const pending = [header];
        const visited = new Set();
        while (pending.length) {
          const current = pending.pop();
          if (current === incrementBlock || visited.has(current)) continue;
          if (current === backedge) return true;
          visited.add(current);
          for (const successor of cfg.succ[current] || []) {
            if (loopBlocks.has(successor)) pending.push(successor);
          }
        }
        return false;
      };
      const incrementDominatesBackedges =
        Number.isInteger(incrementBlock) &&
        backedges.every((backedge) =>
          !reachesBackedgeWithoutIncrement(backedge));
      if (writes !== 1 || !incrementDominatesBackedges ||
          boundWrites !== 0 || !Number.isInteger(increment) ||
          increment <= 0) return null;
      return {
        header, slot, bound, boundSlot, boundExpression, increment, initial,
        loopBlocks, writtenSlots, backedges, preheader: preheaders[0],
      };
    };
    const countedLoopTripCount = (node) => {
      const info = countedLoopInfo(node);
      if (!info || !Number.isInteger(info.bound) ||
          info.initial === null || info.initial >= info.bound) {
        return null;
      }
      const {bound, initial, increment} = info;
      const trips = Math.ceil((bound - initial) / increment);
      return trips > 0 && trips <= 4096 ? trips : null;
    };
    const allCountedLoops = new Map();
    const countedLoopInfos = new Map();
    const countedLoopDepths = new Map();
    const coarseCountedLoops = new Map();
    const runtimeCoarseCountedLoops = new Map();
    // A scanline, codec row, audio block, or similar counted inner loop often
    // has several hundred iterations. Charge its verified runtime trip count
    // once against the shared scheduler budget, then omit the branch from the
    // loop body. The 1024-trip ceiling itself bounds the largest branch-free
    // chunk. It may exceed the remaining abstract backedge budget; charging
    // it makes the next eligible loop poll immediately without fragmenting a
    // small scanline/audio block into hundreds of generator resumptions.
    const runtimeCoarseTripLimit = 1024;
    const containsLoop = (node) => {
      if (!node) return false;
      if (node.t === "loop") return true;
      if (node.t === "seq") return node.body.some(containsLoop);
      if (node.t === "if") {
        return containsLoop(node.then) || containsLoop(node.els);
      }
      if (node.t === "block") return containsLoop(node.body);
      return false;
    };
    const findNestedCountedLoops = (node, loopDepth = 0) => {
      if (!node) return;
      if (node.t === "loop") {
        const info = countedLoopInfo(node);
        const trips = countedLoopTripCount(node);
        const header = Number(node.label.slice(1));
        countedLoopDepths.set(header, loopDepth);
        if (info) countedLoopInfos.set(header, info);
        if (trips) allCountedLoops.set(header, trips);
        if (trips && loopDepth > 0 && this.coarseCountedLoopSafePointsEnabled) {
          coarseCountedLoops.set(header, trips);
        } else if (info &&
            (loopDepth > 0 || !containsLoop(node.body)) &&
            this.coarseCountedLoopSafePointsEnabled) {
          runtimeCoarseCountedLoops.set(header, {
            ...info,
            variable: `ssaRuntimeCoarseLoop${header}`,
            tripsVariable: `ssaRuntimeCoarseTrips${header}`,
            tripsExpression:
              `(local${info.slot} >= ${info.boundExpression} ? 0 : ` +
              (info.increment === 1
                ? `(${info.boundExpression} - local${info.slot})`
                : `Math.ceil((${info.boundExpression} - local${info.slot}) / ` +
                  `${info.increment})`) +
              `)`,
            condition:
              `ssaRuntimeCoarseTrips${header} <= ` +
              `${runtimeCoarseTripLimit} && ` +
              `local${info.slot} <= 2147483647 - ` +
              `ssaRuntimeCoarseTrips${header} * ${info.increment}`,
          });
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
    const allCfgPredecessors = Array.from({length: cfg.n}, () => []);
    for (let block = 0; block < cfg.n; block += 1) {
      for (const successor of cfg.succ[block] || []) {
        allCfgPredecessors[successor].push(block);
      }
    }
    const naturalLoopBlocksFor = (header) => {
      const headerItem = cfg.blocks[header]?.insns?.[0];
      if (!Number.isInteger(headerItem)) return null;
      const backedges = allCfgPredecessors[header].filter((predecessor) =>
        cfg.blocks[predecessor]?.insns?.[0] >= headerItem);
      if (backedges.length !== 1) return null;
      const loopBlocks = new Set([header, backedges[0]]);
      const pending = [backedges[0]];
      while (pending.length) {
        const current = pending.pop();
        for (const predecessor of allCfgPredecessors[current]) {
          if (loopBlocks.has(predecessor)) continue;
          loopBlocks.add(predecessor);
          if (predecessor !== header) pending.push(predecessor);
        }
      }
      return loopBlocks;
    };
    const postDecrementLoopInfos = new Map();
    for (const header of structured.loopHeaders) {
      const block = cfg.blocks[header];
      const blockItems = block?.insns || [];
      if (blockItems.length < 3 || cfg.term[header]?.kind !== "cond") continue;
      const load = items[blockItems[blockItems.length - 3]]?.instruction;
      const decrement = items[blockItems[blockItems.length - 2]]?.instruction;
      const branch = items[blockItems[blockItems.length - 1]]?.instruction;
      const loadOp = opOf(load);
      const slot = /^iload(?:_[0-3])?$/.test(loadOp)
        ? localIndex(load, loadOp) : null;
      if (!Number.isInteger(slot) || opOf(decrement) !== "iinc" ||
          Number(decrement.varnum ?? decrement.arg) !== slot ||
          Number(decrement.incr ?? 0) !== -1 || opOf(branch) !== "ifle") {
        continue;
      }
      const loopBlocks = naturalLoopBlocksFor(header);
      const term = cfg.term[header];
      if (!loopBlocks || loopBlocks.has(term.taken) ||
          !loopBlocks.has(term.fall)) continue;
      const writtenSlots = new Set();
      for (const loopBlock of loopBlocks) {
        for (const itemIndex of cfg.blocks[loopBlock]?.insns || []) {
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          const writtenSlot = op === "iinc"
            ? Number(instruction.varnum ?? instruction.arg)
            : /^istore(?:_[0-3])?$/.test(op)
              ? localIndex(instruction, op) : null;
          if (Number.isInteger(writtenSlot)) writtenSlots.add(writtenSlot);
        }
      }
      postDecrementLoopInfos.set(header, {
        header, slot, loopBlocks, writtenSlots,
        postDecrement: true, increment: 1, initial: null,
        bound: 0, boundSlot: null, boundExpression: "0",
      });
      if (this.coarseCountedLoopSafePointsEnabled) {
        runtimeCoarseCountedLoops.set(header, {
          header, slot, loopBlocks, writtenSlots, postDecrement: true,
          variable: `ssaRuntimeCoarseLoop${header}`,
          tripsVariable: `ssaRuntimeCoarseTrips${header}`,
          tripsExpression: `Math.max(0, local${slot})`,
          condition: `ssaRuntimeCoarseTrips${header} <= ` +
            `${runtimeCoarseTripLimit}`,
        });
      }
    }
    const boundedIterationProduct = [...allCountedLoops.values()]
      .reduce((product, trips) => product * trips, 1);
    const isAtomicUnsafeOperation = (item, index) => {
      if (!normalReachableItems.has(index)) return false;
      const op = opOf(item?.instruction);
      // A verified integer leaf is emitted as straight-line scalar
      // JavaScript; it creates no child frame, scheduler boundary, heap
      // effect, or throwing operation. Do not let its original invoke
      // bytecode fragment an otherwise bounded numeric loop.
      const emittedIntegerLeaf = op?.startsWith("invoke") &&
        Boolean(callSites.get(index)?.inline);
      return op && ((!emittedIntegerLeaf && op.startsWith("invoke")) ||
        op === "monitorenter" ||
        op === "monitorexit" || op === "athrow" || op === "new" ||
        op === "newarray" || op === "anewarray" ||
        op === "multianewarray");
    };
    const hasAtomicUnsafeOperation = items.some(isAtomicUnsafeOperation);
    const loopHasAtomicUnsafeOperation = (info) =>
      [...info.loopBlocks].some((block) =>
        cfg.blocks[block].insns.some((index) =>
          isAtomicUnsafeOperation(items[index], index)));
    // Coarsening is safe for throughput only when the complete method is a
    // bounded numeric kernel. In an effectful method, one "counted" inner loop
    // can still contain a very large data-dependent unit of work (asset
    // decoding is a common example). Let those inner loops retain their own
    // scheduler polls so an outer backedge is not the first observable point
    // after hundreds of milliseconds.
    if (hasAtomicUnsafeOperation) {
      for (const header of coarseCountedLoops.keys()) {
        const info = countedLoopInfos.get(header);
        if (!info || loopHasAtomicUnsafeOperation(info)) {
          coarseCountedLoops.delete(header);
        }
      }
      for (const [header, info] of runtimeCoarseCountedLoops) {
        if (loopHasAtomicUnsafeOperation(info)) {
          runtimeCoarseCountedLoops.delete(header);
        }
      }
    }
    const arrayRangeGuardDeclarations = new Map();
    const arrayRangeGuardVariables = new Map();
    const quotientProductRangePreambles = new Map();
    const cyclicArrayRangeCandidates = new Set();
    let fieldBackedArrayRangeCandidateCount = 0;
    let hoistedArrayRangeGuardCount = 0;
    const trustedHoistedRangeGuards = new Set();
    const rangeBailoutGuardsByHeader = new Map();
    const hasEffectBeforeLoopHeader = (header) => {
      const first = cfg.blocks[header]?.insns?.[0];
      if (!Number.isInteger(first)) return true;
      for (let index = 0; index < first; index += 1) {
        if (!normalReachableItems.has(index)) continue;
        const op = opOf(items[index]?.instruction);
        if (!op || /^(?:[ai]load(?:_[0-3])?|[ai]store(?:_[0-3])?|iinc|iconst_(?:m1|[0-5])|bipush|sipush|ldc|ldc_w|iadd|isub|imul|idiv|irem|iand|ior|ixor|ishl|ishr|iushr|ineg|arraylength|getstatic|goto|goto_w|if.*|return|ireturn)$/.test(op)) {
          continue;
        }
        return true;
      }
      return false;
    };
    const affineLocalStep = (info, slot) => {
      let result = null;
      let writes = 0;
      for (const block of info.loopBlocks) {
        const blockItems = cfg.blocks[block].insns;
        for (let position = 0; position < blockItems.length; position += 1) {
          const itemIndex = blockItems[position];
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          const writtenSlot = /^istore(?:_[0-3])?$/.test(op)
            ? localIndex(instruction, op)
            : op === "iinc" ? Number(instruction.varnum ?? instruction.arg)
              : null;
          if (writtenSlot !== slot) continue;
          writes += 1;
          if (op === "iinc") {
            const increment = Number(instruction.incr ?? 0);
            if (Number.isInteger(increment)) result = String(increment);
            continue;
          }
          if (position < 3) continue;
          const load = items[blockItems[position - 3]]?.instruction;
          const stepLoad = items[blockItems[position - 2]]?.instruction;
          const add = items[blockItems[position - 1]]?.instruction;
          const loadOp = opOf(load);
          if (!/^iload(?:_[0-3])?$/.test(loadOp) ||
              localIndex(load, loadOp) !== slot ||
              opOf(add) !== "iadd") continue;
          const constantStep = constantInstructionValue(stepLoad);
          if (Number.isInteger(constantStep)) {
            result = String(constantStep);
            continue;
          }
          if (opOf(stepLoad) === "getstatic") {
            const direct = directStaticSites.get(blockItems[position - 2]);
            if (direct?.entryReadCache?.value) {
              result = direct.entryReadCache.value;
            }
          }
        }
      }
      return writes === 1 ? result : null;
    };
    const binaryLocalAssignment = (info, targetSlot, binaryOp) => {
      let result = null;
      let writes = 0;
      for (const block of info.loopBlocks) {
        const blockItems = cfg.blocks[block].insns;
        for (let position = 0; position < blockItems.length; position += 1) {
          const itemIndex = blockItems[position];
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          const writtenSlot = /^istore(?:_[0-3])?$/.test(op)
            ? localIndex(instruction, op)
            : op === "iinc" ? Number(instruction.varnum ?? instruction.arg)
              : null;
          if (writtenSlot !== targetSlot) continue;
          writes += 1;
          if (position < 3 || op === "iinc") continue;
          const left = items[blockItems[position - 3]]?.instruction;
          const right = items[blockItems[position - 2]]?.instruction;
          const binary = items[blockItems[position - 1]]?.instruction;
          const leftOp = opOf(left);
          const rightOp = opOf(right);
          if (!/^iload(?:_[0-3])?$/.test(leftOp) ||
              !/^iload(?:_[0-3])?$/.test(rightOp) ||
              opOf(binary) !== binaryOp) continue;
          result = {
            left: localIndex(left, leftOp),
            right: localIndex(right, rightOp),
            block,
            itemIndex,
          };
        }
      }
      return writes === 1 ? result : null;
    };
    const cyclicLocalRange = (info, candidate) => {
      if (candidate.kind !== "affine-local" ||
          candidate.slots.length !== 1) return null;
      const indexSlot = candidate.slots[0];
      const candidateIndex = candidate.itemIndex;
      const sampledLoad = items[candidateIndex - 2]?.instruction;
      const sampledIncrement = items[candidateIndex - 1]?.instruction;
      const sampledLoadOp = opOf(sampledLoad);
      if (!/^iload(?:_[0-3])?$/.test(sampledLoadOp) ||
          localIndex(sampledLoad, sampledLoadOp) !== indexSlot ||
          opOf(sampledIncrement) !== "iinc" ||
          Number(sampledIncrement.varnum ?? sampledIncrement.arg) !== indexSlot ||
          Number(sampledIncrement.incr) !== 1) return null;
      const loopItems = [...info.loopBlocks]
        .flatMap((block) => cfg.blocks[block].insns || []);
      const loopItemSet = new Set(loopItems);
      const writtenSlots = new Map();
      for (const itemIndex of loopItems) {
        const instruction = items[itemIndex]?.instruction;
        const op = opOf(instruction);
        const slot = /^istore(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op)
          : op === "iinc"
            ? Number(instruction.varnum ?? instruction.arg) : null;
        if (Number.isInteger(slot)) {
          writtenSlots.set(slot, (writtenSlots.get(slot) || 0) + 1);
        }
      }
      for (let position = 0; position + 9 < items.length; position += 1) {
        const sequence = Array.from(
          {length: 10}, (_unused, offset) =>
            items[position + offset]?.instruction);
        if (sequence.some((_instruction, offset) =>
            !loopItemSet.has(position + offset))) continue;
        const phaseIncrement = sequence[0];
        if (opOf(phaseIncrement) !== "iinc" ||
            Number(phaseIncrement.incr) !== 1) continue;
        const phaseSlot =
          Number(phaseIncrement.varnum ?? phaseIncrement.arg);
        const phaseLoadOp = opOf(sequence[1]);
        const modulusLoadOp = opOf(sequence[2]);
        const indexLoadOp = opOf(sequence[4]);
        const secondModulusLoadOp = opOf(sequence[5]);
        const indexStoreOp = opOf(sequence[7]);
        const phaseStoreOp = opOf(sequence[9]);
        if (!/^iload(?:_[0-3])?$/.test(phaseLoadOp) ||
            localIndex(sequence[1], phaseLoadOp) !== phaseSlot ||
            !/^iload(?:_[0-3])?$/.test(modulusLoadOp) ||
            !/^iload(?:_[0-3])?$/.test(indexLoadOp) ||
            localIndex(sequence[4], indexLoadOp) !== indexSlot ||
            !/^iload(?:_[0-3])?$/.test(secondModulusLoadOp) ||
            opOf(sequence[3]) !== "if_icmpne" ||
            opOf(sequence[6]) !== "isub" ||
            !/^istore(?:_[0-3])?$/.test(indexStoreOp) ||
            localIndex(sequence[7], indexStoreOp) !== indexSlot ||
            opOf(sequence[8]) !== "iconst_0" ||
            !/^istore(?:_[0-3])?$/.test(phaseStoreOp) ||
            localIndex(sequence[9], phaseStoreOp) !== phaseSlot) continue;
        const modulusSlot = localIndex(sequence[2], modulusLoadOp);
        if (localIndex(sequence[5], secondModulusLoadOp) !== modulusSlot ||
            info.writtenSlots.has(modulusSlot) ||
            (writtenSlots.get(indexSlot) || 0) !== 2 ||
            (writtenSlots.get(phaseSlot) || 0) !== 2) continue;
        const branchTarget = sequence[3]?.arg;
        const targetIndex = typeof branchTarget === "string"
          ? labels.get(branchTarget.replace(/:$/, "")) : null;
        if (targetIndex !== position + 10) continue;
        return {indexSlot, phaseSlot, modulusSlot};
      }
      return null;
    };
    // Recognize a general integer recurrence used by affine samplers:
    //
    //   recurrence += invariantStep
    //   quotient = recurrence / invariantDivisor
    //   derived = quotient * invariantMultiplier
    //   index = derived + invariantOffset
    //
    // The proof is deliberately local to one natural counted loop. Runtime
    // endpoint checks reject division by zero, every possible int32 overflow,
    // null storage, and an out-of-range first/last index. With those excluded,
    // truncating division and multiplication are monotone over the finite
    // recurrence, so all intermediate indexes are in range as well. The
    // original checked loop remains the complete slow arm.
    const loopPathExists = (info, start, target, blocked = null) => {
      if (start === blocked) return false;
      const pending = [start];
      const visited = new Set();
      while (pending.length) {
        const block = pending.pop();
        if (block === blocked || visited.has(block)) continue;
        if (block === target) return true;
        visited.add(block);
        for (const successor of cfg.succ[block] || []) {
          // Crossing the natural-loop backedge starts the next iteration and
          // cannot establish ordering within the current one.
          if (successor === info.header ||
              !info.loopBlocks.has(successor)) continue;
          pending.push(successor);
        }
      }
      return false;
    };
    const loopAssignmentDominates = (info, assignment, candidate) => {
      if (assignment.block === candidate.block) {
        return assignment.itemIndex < candidate.itemIndex;
      }
      if (assignment.block === info.header) return true;
      return !loopPathExists(
        info, info.header, candidate.block, assignment.block);
    };
    // A polygon/edge walker and many table decoders carry the previous
    // induction value in a second local:
    //
    //   previous = bound - 1;
    //   for (current = 0; current < bound; current++) {
    //     array[(previous << shift) + offset];
    //     previous = current;
    //   }
    //
    // Verify the initialization, unique assignment, ordering, and every
    // backedge structurally. Both locals then share [0, bound - 1], allowing
    // one loop-entry range guard for scaled array indexes.
    const scaledCountedLocalRelation = (info, candidate) => {
      if (candidate.kind !== "scaled-local" || info.increment !== 1 ||
          info.initial !== 0 || candidate.slots.length !== 1) return null;
      const slot = candidate.slots[0];
      if (slot === info.slot) return {kind: "induction"};
      if (!Number.isInteger(info.boundSlot) ||
          !Number.isInteger(info.preheader)) return null;
      const preheaderItems = cfg.blocks[info.preheader]?.insns || [];
      let initialized = false;
      for (let position = 3; position < preheaderItems.length; position += 1) {
        const load = items[preheaderItems[position - 3]]?.instruction;
        const one = items[preheaderItems[position - 2]]?.instruction;
        const subtract = items[preheaderItems[position - 1]]?.instruction;
        const store = items[preheaderItems[position]]?.instruction;
        const loadOp = opOf(load), storeOp = opOf(store);
        if (/^iload(?:_[0-3])?$/.test(loadOp) &&
            localIndex(load, loadOp) === info.boundSlot &&
            constantInstructionValue(one) === 1 &&
            opOf(subtract) === "isub" &&
            /^istore(?:_[0-3])?$/.test(storeOp) &&
            localIndex(store, storeOp) === slot) {
          initialized = true;
        }
      }
      if (!initialized) return null;

      let assignment = null;
      let writes = 0;
      for (const loopBlock of info.loopBlocks) {
        const blockItems = cfg.blocks[loopBlock]?.insns || [];
        for (let position = 1; position < blockItems.length; position += 1) {
          const storeIndex = blockItems[position];
          const store = items[storeIndex]?.instruction;
          const storeOp = opOf(store);
          if (!/^istore(?:_[0-3])?$/.test(storeOp) ||
              localIndex(store, storeOp) !== slot) continue;
          writes += 1;
          const load = items[blockItems[position - 1]]?.instruction;
          const loadOp = opOf(load);
          if (/^iload(?:_[0-3])?$/.test(loadOp) &&
              localIndex(load, loadOp) === info.slot) {
            assignment = {block: loopBlock, itemIndex: storeIndex};
          }
        }
      }
      if (writes !== 1 || !assignment) return null;
      const afterAccess = assignment.block === candidate.block
        ? assignment.itemIndex > candidate.itemIndex
        : loopPathExists(info, candidate.block, assignment.block);
      if (!afterAccess) return null;
      if ((info.backedges || []).some((backedge) =>
          assignment.block !== backedge &&
          loopPathExists(info, info.header, backedge, assignment.block))) {
        return null;
      }
      return {kind: "carried"};
    };
    const quotientProductRecurrence = (info, candidate) => {
      const slots = candidate.slots;
      for (let derivedIndex = 0; derivedIndex < slots.length;
        derivedIndex += 1) {
        const derivedSlot = slots[derivedIndex];
        const offsetSlot = slots[1 - derivedIndex];
        if (info.writtenSlots.has(offsetSlot)) continue;
        const multiply = binaryLocalAssignment(info, derivedSlot, "imul");
        if (!multiply) continue;
        for (const [quotientSlot, multiplierSlot] of [
          [multiply.left, multiply.right],
          [multiply.right, multiply.left],
        ]) {
          if (info.writtenSlots.has(multiplierSlot)) continue;
          const divide =
            binaryLocalAssignment(info, quotientSlot, "idiv");
          if (!divide || info.writtenSlots.has(divide.right)) continue;
          const recurrenceSlot = divide.left;
          const recurrence =
            binaryLocalAssignment(info, recurrenceSlot, "iadd");
          if (!recurrence) continue;
          const stepSlot = recurrence.left === recurrenceSlot
            ? recurrence.right
            : recurrence.right === recurrenceSlot
              ? recurrence.left : null;
          if (!Number.isInteger(stepSlot) ||
              info.writtenSlots.has(stepSlot)) continue;
          if (!loopAssignmentDominates(info, divide, candidate) ||
              !loopAssignmentDominates(info, multiply, candidate)) continue;
          // The recurrence update must occur exactly once on every path to a
          // backedge and after this access in the current iteration. This
          // excludes conditionally updated or update-before-sample loops whose
          // endpoint formula would require a different starting value.
          if ((info.backedges || []).some((backedge) =>
              recurrence.block !== backedge &&
              loopPathExists(
                info, info.header, backedge, recurrence.block))) continue;
          const updatePrecedesCandidate =
            recurrence.block === candidate.block
              ? recurrence.itemIndex < candidate.itemIndex
              : loopPathExists(
                info, recurrence.block, candidate.block);
          if (updatePrecedesCandidate) continue;
          return {
            recurrenceSlot,
            stepSlot,
            divisorSlot: divide.right,
            multiplierSlot,
            offsetSlot,
          };
        }
      }
      return null;
    };
    for (let candidateIndex = 0;
      candidateIndex < arrayRangeCheckCandidates.length;
      candidateIndex += 1) {
      const candidate = arrayRangeCheckCandidates[candidateIndex];
      const loops = [...countedLoopInfos.values()]
        .filter((info) =>
          info.increment === 1 &&
          !loopHasAtomicUnsafeOperation(info) &&
          info.loopBlocks.has(candidate.block) &&
          (candidate.kind === "bounded-index" ||
            candidate.kind === "affine-local" ||
            candidate.kind === "scaled-local" ||
            candidate.slots.includes(info.slot) ||
            Boolean(quotientProductRecurrence(info, candidate))))
        .sort((left, right) =>
          left.loopBlocks.size - right.loopBlocks.size);
      let info = candidate.kind === "bounded-index"
        ? loops[0]
        : candidate.kind === "affine-local"
        ? loops.find((loop) =>
          Boolean(affineLocalStep(loop, candidate.slots[0]) ||
            cyclicLocalRange(loop, candidate)))
        : candidate.kind === "scaled-local"
        ? loops.find((loop) =>
          Boolean(scaledCountedLocalRelation(loop, candidate)))
        : loops.find((loop) => {
          if (quotientProductRecurrence(loop, candidate)) return true;
          const baseSlot = candidate.slots.find((slot) => slot !== loop.slot);
          return Number.isInteger(baseSlot) &&
            !loop.writtenSlots.has(baseSlot);
        });
      if (!info && (candidate.kind === "bounded-index" ||
          candidate.kind === "affine-local")) {
        info = [...postDecrementLoopInfos.values()]
          .filter((loop) => loop.loopBlocks.has(candidate.block))
          .sort((left, right) =>
            left.loopBlocks.size - right.loopBlocks.size)[0] || null;
      }
      if (!info) continue;
      const enclosingCountedLoops = [...countedLoopInfos.values()]
        .filter((loop) => loop.header !== info.header &&
          loop.loopBlocks.has(info.header))
        .sort((left, right) => right.loopBlocks.size - left.loopBlocks.size);
      const outermostCountedLoop = enclosingCountedLoops[0] || null;
      const enclosingPostDecrementLoops = [...postDecrementLoopInfos.values()]
        .filter((loop) => loop.loopBlocks.has(info.header))
        .sort((left, right) =>
          right.loopBlocks.size - left.loopBlocks.size);
      const outermostPostDecrementLoop =
        enclosingPostDecrementLoops[0] || null;
      const variable = `ssaArrayRangeGuard${candidateIndex}`;
      let condition;
      let preamble = [];
      let declarationHeader = info.header;
      if (candidate.kind === "bounded-index") {
        condition =
          `(${candidate.minimum} >= 0 && ${candidate.maximum} < ` +
          `${candidate.arrayData}.length)`;
        const outer = outermostCountedLoop || outermostPostDecrementLoop;
        if (outer) {
          declarationHeader = outer.header;
        }
      } else if (candidate.kind === "affine-local") {
        const indexSlot = candidate.slots[0];
        const step = affineLocalStep(info, indexSlot);
        const cyclic = step === null
          ? cyclicLocalRange(info, candidate) : null;
        const postDecrementOuter = !info.postDecrement && !cyclic && step !== null &&
          outermostPostDecrementLoop && info.initial === 0 &&
          Number.isInteger(info.bound) && info.bound > 0
          ? outermostPostDecrementLoop : null;
        let countedOuterSkipSlot = null;
        if (!info.postDecrement && !cyclic && step !== null &&
            outermostCountedLoop && info.initial === 0) {
          const outerOnlyWrites = [];
          for (const loopBlock of outermostCountedLoop.loopBlocks) {
            if (info.loopBlocks.has(loopBlock)) continue;
            const blockItems = cfg.blocks[loopBlock]?.insns || [];
            for (let position = 3; position < blockItems.length; position += 1) {
              const store = items[blockItems[position]]?.instruction;
              const storeOp = opOf(store);
              if (!/^istore(?:_[0-3])?$/.test(storeOp) ||
                  localIndex(store, storeOp) !== indexSlot) continue;
              const left = items[blockItems[position - 3]]?.instruction;
              const right = items[blockItems[position - 2]]?.instruction;
              const add = items[blockItems[position - 1]]?.instruction;
              const leftOp = opOf(left), rightOp = opOf(right);
              if (!/^iload(?:_[0-3])?$/.test(leftOp) ||
                  localIndex(left, leftOp) !== indexSlot ||
                  !/^iload(?:_[0-3])?$/.test(rightOp) ||
                  opOf(add) !== "iadd") continue;
              outerOnlyWrites.push(localIndex(right, rightOp));
            }
          }
          if (outerOnlyWrites.length === 1 &&
              !outermostCountedLoop.writtenSlots.has(outerOnlyWrites[0])) {
            countedOuterSkipSlot = outerOnlyWrites[0];
          }
        }
        const writesInPostDecrementOuter = postDecrementOuter
          ? [...postDecrementOuter.loopBlocks].flatMap((block) =>
            cfg.blocks[block]?.insns || []).filter((itemIndex) => {
            const instruction = items[itemIndex]?.instruction;
            const op = opOf(instruction);
            return op === "iinc"
              ? Number(instruction.varnum ?? instruction.arg) === indexSlot
              : /^istore(?:_[0-3])?$/.test(op) &&
                localIndex(instruction, op) === indexSlot;
          }).length : 0;
        if (info.postDecrement && step !== null) {
          const trips = `Math.max(0, local${info.slot})`;
          const last = `(local${indexSlot} + (${trips} - 1) * ${step})`;
          condition =
            `(${trips} === 0 || (${trips} <= ` +
            `${runtimeCoarseTripLimit} && ${step} >= 0 && ` +
            `local${indexSlot} >= 0 && ${last} < ` +
            `${candidate.arrayData}.length && ${last} <= 2147483647))`;
        } else if (cyclic) {
          cyclicArrayRangeCandidates.add(candidate);
          const base =
            `(local${cyclic.indexSlot} - local${cyclic.phaseSlot})`;
          const end = `(${base} + local${cyclic.modulusSlot})`;
          condition =
            `(local${cyclic.modulusSlot} > 0 && ` +
            `local${cyclic.phaseSlot} >= 0 && ` +
            `local${cyclic.phaseSlot} < local${cyclic.modulusSlot} && ` +
            `${base} >= 0 && ${end} <= ${candidate.arrayData}.length && ` +
            `${end} <= 2147483647)`;
        } else if (Number.isInteger(countedOuterSkipSlot)) {
          const outerTrips =
            `(local${outermostCountedLoop.slot} >= ` +
            `${outermostCountedLoop.boundExpression} ? 0 : ` +
            `(${outermostCountedLoop.boundExpression} - ` +
            `local${outermostCountedLoop.slot}))`;
          const innerTrips =
            `Math.max(0, ${info.boundExpression})`;
          const rowStride =
            `(${innerTrips} * ${step} + local${countedOuterSkipSlot})`;
          const last = `(local${indexSlot} + (${outerTrips} - 1) * ` +
            `${rowStride} + (${innerTrips} - 1) * ${step})`;
          condition =
            `(${outerTrips} === 0 || ${innerTrips} === 0 || (` +
            `${outerTrips} <= ${runtimeCoarseTripLimit} && ` +
            `${innerTrips} <= ${runtimeCoarseTripLimit} && ${step} >= 0 && ` +
            `local${countedOuterSkipSlot} >= 0 && ` +
            `local${indexSlot} >= 0 && ${last} < ` +
            `${candidate.arrayData}.length && ${last} <= 2147483647))`;
          declarationHeader = outermostCountedLoop.header;
        } else if (postDecrementOuter && writesInPostDecrementOuter === 1) {
          const outerTrips =
            `Math.max(0, local${postDecrementOuter.slot})`;
          const totalTrips = `(${outerTrips} * ${info.bound})`;
          const last =
            `(local${indexSlot} + (${totalTrips} - 1) * ${step})`;
          condition =
            `(${totalTrips} === 0 || (${outerTrips} <= ` +
            `${runtimeCoarseTripLimit} && ${step} >= 0 && ` +
            `local${indexSlot} >= 0 && ${last} < ` +
            `${candidate.arrayData}.length && ${last} <= 2147483647))`;
          declarationHeader = postDecrementOuter.header;
        } else {
          const trips =
            `(local${info.slot} >= ${info.boundExpression} ? 0 : ` +
            `(${info.boundExpression} - local${info.slot}))`;
          const last =
            `(local${indexSlot} + (${trips} - 1) * ${step})`;
          condition =
            `(${trips} === 0 || (${trips} <= ${runtimeCoarseTripLimit} && ` +
            `${step} >= 0 && ` +
            `local${indexSlot} >= 0 && ${last} < ${candidate.arrayData}.length && ` +
            `${last} <= 2147483647))`;
        }
      } else if (candidate.kind === "scaled-local") {
        const relation = scaledCountedLocalRelation(info, candidate);
        if (!relation) continue;
        const boundInvariantInOuterLoops =
          info.boundSlot === null || enclosingCountedLoops.every((loop) =>
            !loop.writtenSlots.has(info.boundSlot));
        const hoistScaledGuard = Boolean(
          outermostCountedLoop && info.initial === 0 &&
          boundInvariantInOuterLoops);
        const trips = hoistScaledGuard
          ? `Math.max(0, ${info.boundExpression})`
          : `(local${info.slot} >= ${info.boundExpression} ? 0 : ` +
            `(${info.boundExpression} - local${info.slot}))`;
        const firstCounter = relation.kind === "carried"
          ? "0" : hoistScaledGuard ? "0" : `local${info.slot}`;
        const first = `(${firstCounter} * ${candidate.scale} + ` +
          `${candidate.offset})`;
        const last = `((${info.boundExpression} - 1) * ` +
          `${candidate.scale} + ${candidate.offset})`;
        condition =
          `(${trips} === 0 || (${trips} <= ${runtimeCoarseTripLimit} && ` +
          `${first} >= 0 && ${last} >= ${first} && ` +
          `${last} <= 2147483647 && ` +
          `${last} < ${candidate.arrayData}.length))`;
        if (hoistScaledGuard) declarationHeader = outermostCountedLoop.header;
      } else {
        const recurrence =
          quotientProductRecurrence(info, candidate);
        if (recurrence) {
          const recurrenceKey = [
            info.header,
            recurrence.recurrenceSlot,
            recurrence.stepSlot,
            recurrence.divisorSlot,
            recurrence.multiplierSlot,
          ].join(":");
          let shared = quotientProductRangePreambles.get(recurrenceKey);
          if (!shared) {
            const prefix =
              `ssaArrayRangeRecurrence${quotientProductRangePreambles.size}`;
            const trips =
              `(local${info.slot} >= ${info.boundExpression} ? 0 : ` +
              `(${info.boundExpression} - local${info.slot}))`;
            shared = {
              prefix,
              declarations: [
                `const ${prefix}Trips = ${trips};`,
                `const ${prefix}Last = local${recurrence.recurrenceSlot} + ` +
                  `(${prefix}Trips - 1) * local${recurrence.stepSlot};`,
                `const ${prefix}FirstQuotientRaw = ` +
                  `local${recurrence.recurrenceSlot} / ` +
                  `local${recurrence.divisorSlot};`,
                `const ${prefix}LastQuotientRaw = ${prefix}Last / ` +
                  `local${recurrence.divisorSlot};`,
                `const ${prefix}FirstProduct = ` +
                  `Math.trunc(${prefix}FirstQuotientRaw) * ` +
                  `local${recurrence.multiplierSlot};`,
                `const ${prefix}LastProduct = ` +
                  `Math.trunc(${prefix}LastQuotientRaw) * ` +
                  `local${recurrence.multiplierSlot};`,
                `const ${prefix}Valid = ${prefix}Trips <= ` +
                  `${runtimeCoarseTripLimit} && ` +
                  `local${recurrence.divisorSlot} !== 0 && ` +
                  `${prefix}Last >= -2147483648 && ` +
                  `${prefix}Last <= 2147483647 && ` +
                  `${prefix}FirstQuotientRaw >= -2147483648 && ` +
                  `${prefix}FirstQuotientRaw <= 2147483647 && ` +
                  `${prefix}LastQuotientRaw >= -2147483648 && ` +
                  `${prefix}LastQuotientRaw <= 2147483647 && ` +
                  `${prefix}FirstProduct >= -2147483648 && ` +
                  `${prefix}FirstProduct <= 2147483647 && ` +
                  `${prefix}LastProduct >= -2147483648 && ` +
                  `${prefix}LastProduct <= 2147483647;`,
              ],
            };
            quotientProductRangePreambles.set(recurrenceKey, shared);
            preamble.push(...shared.declarations);
          }
          const prefix = `ssaArrayRangeInterval${candidateIndex}`;
          preamble.push(
            `const ${prefix}FirstIndex = ${shared.prefix}FirstProduct + ` +
              `local${recurrence.offsetSlot};`,
            `const ${prefix}LastIndex = ${shared.prefix}LastProduct + ` +
              `local${recurrence.offsetSlot};`,
          );
          condition =
            `(${shared.prefix}Trips === 0 || (` +
            `${shared.prefix}Valid && ` +
            `${candidate.arrayData} !== null && ` +
            `Math.min(${prefix}FirstIndex, ${prefix}LastIndex) >= 0 && ` +
            `Math.max(${prefix}FirstIndex, ${prefix}LastIndex) < ` +
              `${candidate.arrayData}.length && ` +
            `${prefix}FirstIndex >= -2147483648 && ` +
            `${prefix}FirstIndex <= 2147483647 && ` +
            `${prefix}LastIndex >= -2147483648 && ` +
            `${prefix}LastIndex <= 2147483647))`;
        } else {
          const baseSlot = candidate.slots.find((slot) => slot !== info.slot);
          const start = `(local${baseSlot} + local${info.slot})`;
          const end = `(local${baseSlot} + ${info.boundExpression})`;
          condition =
            `(local${info.slot} >= ${info.boundExpression} || ` +
            `(${start} >= 0 && ${end} <= ${candidate.arrayData}.length && ` +
            `${end} <= 2147483647))`;
        }
      }
      if (eagerEntryFieldArrayData.has(candidate.arrayData) ||
          entryStaticArrayData.has(candidate.arrayData) &&
          (countedLoopDepths.get(info.header) || 0) > 0) {
        // A lexical generator continuation could observe a different array
        // field after another Java thread runs. The normal no-continuation
        // safe point exits to the canonical frame instead, so resumed
        // baseline execution performs checked accesses. The next entry from
        // bytecode PC zero recomputes both the cached view and its range
        // guard. This applies equally to already-direct and first-use-linked
        // static locations.
        fieldBackedArrayRangeCandidateCount += 1;
      }
      condition = `(${candidate.arrayData} !== null && ${condition})`;
      const declarations =
        arrayRangeGuardDeclarations.get(declarationHeader) || [];
      declarations.push(...preamble, `const ${variable} = ${condition};`);
      arrayRangeGuardDeclarations.set(declarationHeader, declarations);
      if (declarationHeader !== info.header) {
        hoistedArrayRangeGuardCount += 1;
        if (!hasEffectBeforeLoopHeader(declarationHeader)) {
          trustedHoistedRangeGuards.add(variable);
          const bailouts = rangeBailoutGuardsByHeader.get(declarationHeader) || [];
          bailouts.push(variable);
          rangeBailoutGuardsByHeader.set(declarationHeader, bailouts);
        }
      }
      const variables = arrayRangeGuardVariables.get(info.header) || [];
      variables.push(variable);
      arrayRangeGuardVariables.set(info.header, variables);
      for (const plan of plans) {
        if (!plan?.lines) continue;
        plan.lines = plan.lines.map((line) =>
          line.replace(candidate.marker, variable));
      }
    }
    for (const candidate of arrayRangeCheckCandidates) {
      for (const plan of plans) {
        if (!plan?.lines) continue;
        plan.lines = plan.lines.map((line) =>
          line.replace(candidate.marker, "false"));
      }
    }
    if (fieldBackedArrayRangeCandidateCount > 0) {
      useContinuations = false;
    }
    // A fully verified, call-free counted kernel has a finite upper bound and
    // no scheduler-visible operation inside it. Run it as one ordinary
    // JavaScript function so SpiderMonkey can optimize the numeric loops;
    // generators otherwise inhibit the hot-loop optimizer even when they
    // yield only at distant safe points. The one-million-iteration cap keeps
    // atomic regions bounded independently of guest names or descriptors.
    const guardedAtomicRegionLimit =
      Number(method.jvmStructuredAtomicRegionMaxIterations) || 0;
    const atomicBoundedLoops = this.atomicBoundedLoopsEnabled &&
      structured.loopHeaders.size > 0 &&
      (code.code.exceptionTable || []).length === 0 &&
      !hasAtomicUnsafeOperation &&
      (allCountedLoops.size === structured.loopHeaders.size &&
        boundedIterationProduct <= 1_000_000 ||
        guardedAtomicRegionLimit > 0);
    if (atomicBoundedLoops) {
      useContinuations = false;
      for (const header of structured.loopHeaders) {
        coarseCountedLoops.set(header,
          allCountedLoops.get(header) || guardedAtomicRegionLimit);
      }
    }
    const maximumCoarseTripCount =
      Math.max(1, ...coarseCountedLoops.values());
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
    const specializeArrayRangeGuardedStores = (lines, guardVariables) => {
      if (!guardVariables.length) return lines;
      const specializeGuardedValue = (line) => {
        for (const variable of guardVariables) {
          const marker = ` = ${variable} ? `;
          const conditional = line.indexOf(marker);
          const alternate = line.lastIndexOf(" : ");
          if (conditional < 0 || alternate <= conditional + marker.length) {
            continue;
          }
          // This arm is dominated by `variable === true`. The successful
          // checked-load expression is the text before the conditional's
          // alternate separator; retaining the ternary costs one branch per
          // pixel and prevents the engine from seeing an ordinary typed-array
          // loop. Emission controls this single-line expression shape, so no
          // guest syntax or identity participates in the rewrite.
          return `${line.slice(0, conditional)} = ` +
            `${line.slice(conditional + marker.length, alternate)};`;
        }
        return line;
      };
      const output = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const indentPrefix = /^\s*/.exec(line)?.[0] || "";
        const trimmed = line.slice(indentPrefix.length);
        const guarded = guardVariables.some((variable) =>
          trimmed.startsWith(`if (!${variable} && `));
        if (!guarded) {
          output.push(line);
          continue;
        }
        const elseLine = `${indentPrefix}} else {`;
        const closeLine = `${indentPrefix}}`;
        let alternate = index + 1;
        while (alternate < lines.length && lines[alternate] !== elseLine) {
          alternate += 1;
        }
        let close = alternate + 1;
        while (close < lines.length && lines[close] !== closeLine) close += 1;
        if (alternate >= lines.length || close >= lines.length) {
          output.push(line);
          continue;
        }
        const specializationKey = trimmed;
        if (!specializedArrayRangeAccesses.has(specializationKey)) {
          specializedArrayRangeAccesses.add(specializationKey);
          specializedArrayRangeAccessCount += 1;
        }
        // This version is reached only after the exact range predicate above
        // succeeded. Keep the emitted successful-store arm; the slow loop
        // retains the complete materialization and exception path.
        for (const successLine of lines.slice(alternate + 1, close)) {
          const nestedPrefix = `${indentPrefix}  `;
          const unindented = successLine.startsWith(nestedPrefix)
            ? `${indentPrefix}${successLine.slice(nestedPrefix.length)}`
            : successLine;
          output.push(specializeGuardedValue(unindented));
        }
        index = close;
      }
      return output;
    };
    // `structure()` represents a natural counted loop as an infinite labelled
    // loop whose first node branches to either the exit or the body. That is a
    // convenient CFG-preserving form, but it leaves optimizing JavaScript
    // engines with an extra branch, two SSA aliases, and an explicit continue
    // on every guest iteration. Recover the ordinary while-loop form when the
    // counted-loop proof and the emitted header agree exactly. This is a
    // generated-source canonicalization: it is driven only by the verified
    // induction slot/bound and never by a guest owner, method, or descriptor.
    const canonicalCountedLoop = (header, label, lines) => {
      const info = countedLoopInfos.get(header);
      if (!info || !Number.isInteger(info.slot) || !info.boundExpression ||
          lines.length < 5) return null;
      const first = /^const (ssaValue\d+) = local(\d+);$/.exec(lines[0]);
      if (!first || Number(first[2]) !== info.slot) return null;
      const second = /^const (ssaValue\d+) = (.+);$/.exec(lines[1]);
      let conditionLine;
      let conditionIndex;
      if (second && second[2] === info.boundExpression &&
          lines[2] === `if (${first[1]} >= ${second[1]}) {`) {
        conditionLine = `local${info.slot} < ${info.boundExpression}`;
        conditionIndex = 2;
      } else if (lines[1] ===
          `if (${first[1]} >= ${info.boundExpression}) {`) {
        conditionLine = `local${info.slot} < ${info.boundExpression}`;
        conditionIndex = 1;
      } else {
        return null;
      }
      let alternate = -1;
      let depth = 0;
      for (let index = conditionIndex; index < lines.length; index += 1) {
        const trimmed = lines[index].trim();
        if (index > conditionIndex && depth === 1 && trimmed === "} else {") {
          alternate = index;
          break;
        }
        if (trimmed.endsWith("{")) depth += 1;
        if (trimmed === "}" || trimmed.startsWith("} else")) depth -= 1;
      }
      if (alternate < 0 || lines[lines.length - 1] !== "}") return null;
      const unindentOne = (line) => line.startsWith("  ")
        ? line.slice(2) : line;
      const exit = lines.slice(conditionIndex + 1, alternate).map(unindentOne);
      const body = lines.slice(alternate + 1, -1).map(unindentOne);
      if (body[body.length - 1]?.trim() === `continue ${label};`) body.pop();
      return {
        condition: conditionLine,
        body,
        exit,
      };
    };
    // Javac lowers `while (remaining-- > 0)` to load/iinc/ifle at the loop
    // header. It is not an increasing counted loop, but it is still a common
    // finite numeric-loop shape. Preserve the post-decrement value and move
    // the header test into JavaScript's while condition, eliminating the
    // infinite-loop/if/continue scaffold without assuming a trip bound.
    const canonicalPostDecrementLoop = (label, lines) => {
      if (lines.length < 8) return null;
      const oldValue = /^const (ssaValue\d+) = local(\d+);$/.exec(lines[0]);
      if (!oldValue) return null;
      const nextValue = new RegExp(
        `^const (ssaValue\\d+) = \\(${oldValue[1]} \\+ -1\\) \\| 0;$`,
      ).exec(lines[1]);
      if (!nextValue || lines[2] !==
          `local${oldValue[2]} = ${nextValue[1]};` ||
          lines[3] !== `if (${oldValue[1]} <= 0) {`) return null;
      let alternate = -1;
      let depth = 0;
      for (let index = 3; index < lines.length; index += 1) {
        const trimmed = lines[index].trim();
        if (index > 3 && depth === 1 && trimmed === "} else {") {
          alternate = index;
          break;
        }
        if (trimmed.endsWith("{")) depth += 1;
        if (trimmed === "}" || trimmed.startsWith("} else")) depth -= 1;
      }
      if (alternate < 0 || lines[lines.length - 1] !== "}") return null;
      const unindentOne = (line) => line.startsWith("  ")
        ? line.slice(2) : line;
      const exit = lines.slice(4, alternate).map(unindentOne);
      const body = [
        ...lines.slice(0, 3),
        ...lines.slice(alternate + 1, -1).map(unindentOne),
      ];
      if (body[body.length - 1]?.trim() === `continue ${label};`) body.pop();
      return {
        condition: `local${oldValue[2]} > 0`,
        body,
        exit,
      };
    };
    let dominatedArithmeticGuardCount = 0;
    const specializeNonZeroBranch = (plan, lines) => {
      const match = /^(ssaValue\d+) !== 0$/.exec(plan.condition || "");
      if (!match) return lines;
      const equivalent = new Set([match[1]]);
      const learnAlias = (line) => {
        const declaration = /^\s*const (ssaValue\d+) = ([A-Za-z_$][\w$]*);$/.exec(line);
        const assignment = /^\s*(local\d+) = ([A-Za-z_$][\w$]*);$/.exec(line);
        const alias = declaration || assignment;
        if (!alias || !equivalent.has(alias[2])) return false;
        const size = equivalent.size;
        equivalent.add(alias[1]);
        return equivalent.size !== size;
      };
      // The conditional plan commonly stores the tested stack value into a
      // local immediately before branching; seed that equivalence before
      // walking the selected successor.
      let changed = true;
      while (changed) {
        changed = false;
        for (const line of plan.lines || []) changed = learnAlias(line) || changed;
      }
      const output = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        learnAlias(line);
        const zeroCheck = /^([\s]*)if \(([A-Za-z_$][\w$]*) === 0\) \{$/.exec(line);
        if (!zeroCheck || !equivalent.has(zeroCheck[2])) {
          output.push(line);
          continue;
        }
        let depth = 1;
        let close = index + 1;
        for (; close < lines.length && depth > 0; close += 1) {
          const trimmed = lines[close].trim();
          if (trimmed.endsWith("{")) depth += 1;
          if (trimmed === "}") depth -= 1;
          if (trimmed.startsWith("} else")) break;
        }
        if (depth !== 0) {
          output.push(line);
          continue;
        }
        // This is the renderer-owned idiv/irem exceptional arm. The branch
        // edge proved the divisor nonzero, so retaining it only bloats and
        // inhibits the surrounding numeric region.
        dominatedArithmeticGuardCount += 1;
        index = close - 1;
      }
      return output;
    };
    const render = (
      node, continuationMode = useContinuations, directPositional = false,
      loopSafePointBudget = safePointInitialBudget,
      checkedLeafOnly = false,
      rangeBailout = false,
    ) => {
      if (!node) return [];
      if (node.t === "seq") {
        return node.body.flatMap((child) =>
          render(child, continuationMode, directPositional,
            loopSafePointBudget, checkedLeafOnly, rangeBailout));
      }
      if (node.t === "straight") {
        const plan = plans[node.block];
        const lines = plan.lines.flatMap((line) => {
          const directStaticRead =
            directEntryStaticReadFallbacks.get(line);
          if (directStaticRead) {
            return directPositional
              ? directStaticRead.direct : directStaticRead.ordinary;
          }
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
          if (method.jvmStructuredRegionSpillOnReturn) {
            lines.push("  spillLocals();");
          }
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
        const thenLines = specializeNonZeroBranch(plan, [
          ...edgeLines(plan.taken, plan.takenStack ?? plan.stack),
          ...render(node.then, continuationMode, directPositional,
            loopSafePointBudget, checkedLeafOnly, rangeBailout),
        ]);
        const elseLines = [
          ...edgeLines(plan.fall, plan.fallStack ?? plan.stack),
          ...render(node.els, continuationMode, directPositional,
            loopSafePointBudget, checkedLeafOnly, rangeBailout),
        ];
        if (plan.conditionConstant === true) {
          return ["{", ...indent(thenLines), "}"];
        }
        if (plan.conditionConstant === false) {
          return ["{", ...indent(elseLines), "}"];
        }
        if (thenLines.length === elseLines.length &&
            thenLines.every((line, index) => line === elseLines[index])) {
          return ["{", ...indent(thenLines), "}"];
        }
        return [`if (${plan.condition}) {`, ...indent(thenLines),
          "} else {", ...indent(elseLines), "}"];
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
              ...refreshEntryStaticCacheLines,
              ...refreshEagerFieldCacheLines,
            ] : [
              "helpers.skipJitOnce(frame);",
              "return { deopt: true, transient: true, reason: 'structured SSA safe point' };",
            ]),
          ]),
          "}",
        ];
        const coarse = coarseCountedLoops.has(header);
        const runtimeCoarse = runtimeCoarseCountedLoops.get(header);
        const rangeGuards = this.versionedArrayRangeStoresEnabled
          ? arrayRangeGuardVariables.get(header) || [] : [];
        const loopBody = render(node.body, continuationMode, directPositional,
          loopSafePointBudget, checkedLeafOnly, rangeBailout);
        const countedLoop = canonicalCountedLoop(header, node.label, loopBody) ||
          canonicalPostDecrementLoop(node.label, loopBody);
        const entryBailoutGuards = directPositional && rangeBailout
          ? rangeBailoutGuardsByHeader.get(header) || [] : [];
        const prefix = [
          ...(arrayRangeGuardDeclarations.get(header) || []),
          ...(entryBailoutGuards.length
            ? [`if (!(${entryBailoutGuards.join(" && ")})) ` +
              "return helpers.asyncInvokeSentinel();"]
            : []),
          ...(runtimeCoarse
            ? [
              `const ${runtimeCoarse.tripsVariable} = ` +
                `${runtimeCoarse.tripsExpression};`,
              `const ${runtimeCoarse.variable} = ${runtimeCoarse.condition};`,
              `if (${runtimeCoarse.variable}) safePointBudget -= ` +
                `${runtimeCoarse.tripsVariable};`,
            ]
            : []),
        ];
        const polledLoop = [
          `${node.label}: while (${countedLoop
            ? countedLoop.condition : "true"}) {`,
          ...(coarse ? [] : [
            `  if (${runtimeCoarse
              ? `!${runtimeCoarse.variable} && ` : ""}` +
              "--safePointBudget === 0) {",
            ...indent(indent(materialize)), "  }",
          ]),
          ...indent(countedLoop ? countedLoop.body : loopBody), "}",
          ...(countedLoop ? countedLoop.exit : []),
        ];
        const rangeBailoutFastLoop = Boolean(
          directPositional && rangeBailout && (coarse || runtimeCoarse) &&
          rangeGuards.length > 0 &&
          rangeGuards.every((guard) =>
            trustedHoistedRangeGuards.has(guard)) &&
          countedLoopInfos.get(header)?.initial === 0 &&
          countedLoopInfos.get(header)?.increment === 1);
        if (rangeBailoutFastLoop) {
          return [
            ...prefix,
            `${node.label}: while (${countedLoop
              ? countedLoop.condition : "true"}) {`,
            ...indent(specializeArrayRangeGuardedStores(
              countedLoop ? countedLoop.body : loopBody, rangeGuards)),
            "}",
            ...(countedLoop ? countedLoop.exit : []),
          ];
        }
        // A runtime-bounded direct callee normally takes the verified coarse
        // path, but a combined `!coarse && --budget` test still executes once
        // per guest backedge. Emit two ordinary JavaScript loops so optimizing
        // engines see a branch-free numeric hot loop. The slow arm retains the
        // exact scheduler poll and restoration behavior. Selection depends
        // solely on the verified trip-count/overflow proof above.
        if ((directPositional || !continuationMode) &&
            rangeGuards.length > 0 &&
            (coarse || runtimeCoarse && !coarse &&
              this.versionedRuntimeCoarseLoopsEnabled)) {
          // Put the verified range predicates on the outer fast-loop edge.
          // Inside that dominated arm optimizing JavaScript engines can fold
          // every `!rangeGuard && boundsCheck` store branch away. The other
          // arm retains the exact per-store exception materialization.
          const fastLoopCondition = [
            ...(runtimeCoarse && !coarse ? [runtimeCoarse.variable] : []),
            ...rangeGuards,
          ].join(" && ");
          const fastLoopBody = specializeArrayRangeGuardedStores(
            countedLoop ? countedLoop.body : loopBody, rangeGuards);
          const unpolledLoop = [
            `${node.label}: while (${countedLoop
              ? countedLoop.condition : "true"}) {`,
            ...indent(fastLoopBody), "}",
            ...(countedLoop ? countedLoop.exit : []),
          ];
          if (checkedLeafOnly) {
            // This entry is published only for a single, bounded, call-free
            // loop whose guest effects are all dominated by these predicates.
            // A failed predicate returns to the ordinary call path before the
            // first effect; the successful body contains no Frame or cold
            // exception machinery and is small enough for a caller engine to
            // inline as an ordinary JavaScript leaf.
            return [
              ...prefix,
              `if (!(${fastLoopCondition})) ` +
                "return helpers.asyncInvokeSentinel();",
              ...unpolledLoop,
            ];
          }
          return [
            ...prefix,
            `if (${fastLoopCondition}) {`,
            ...indent(unpolledLoop),
            "} else {",
            ...indent(polledLoop),
            "}",
          ];
        }
        return [...prefix, ...polledLoop];
      }
      if (node.t === "block") {
        return [`${node.label}: {`,
          ...indent(render(node.body, continuationMode, directPositional,
            loopSafePointBudget, checkedLeafOnly, rangeBailout)), "}"];
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
    const staticInitializationGuardId = directStaticOwners.size
      ? this.registerClassInitializationGuard(directStaticOwners) : -1;
    const staticInitializationGuardDeclaration = staticInitializationGuardId >= 0
      ? `const ssaClassInitializationGuard = helpers.structuredSsa.classInitializationGuards[${staticInitializationGuardId}];`
      : null;
    const staticEntryGuard = staticInitializationGuardId >= 0
      ? "if ((ssaClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || " +
        "ssaClassInitializationGuard.initializationEpoch !== " +
        "(helpers.jvm.classInitializationEpoch || 0)) && " +
        "!helpers.structuredSsa.verifyClassInitializationGuard(" +
        "ssaClassInitializationGuard)) { helpers.skipJitOnce(frame); " +
        "return { deopt: true, transient: true, reason: 'structured SSA static entry' }; }"
      : null;
    const directStaticDeclarations = [...directStaticSites.values()]
      .filter((direct) => !direct.entryReadCache)
      .map((direct) =>
      `const ${direct.variable} = helpers.directStaticTargets[${direct.targetId}].fields;`);
    const lazyStaticDeclarations = [...lazyStaticSites.values()].map((lazy) =>
      `let ${lazy.variable} = helpers.fieldSites[${lazy.site}].staticTarget;`);
    const entryStaticReadDeclarations =
      [...entryStaticReadCaches.values()].flatMap((cache) => {
        if (cache.lazy) {
          const lazy = cache.lazy;
          const read = `${lazy.variable}.kind === "map" ? ` +
            `${lazy.variable}.fields.get(${lazy.variable}.key) : ` +
            `${lazy.variable}.fields[${lazy.variable}.key]`;
          return [
            `let ${cache.valid} = Boolean(${lazy.variable});`,
            `let ${cache.value} = ${cache.valid} ? ${read} : undefined;`,
            ...(cache.data
              ? [`let ${cache.data} = ${cache.valid} ? ` +
                `helpers.arrayData(${cache.value}) : null;`]
              : []),
          ];
        }
        const direct = cache.direct;
        const fields =
          `helpers.directStaticTargets[${direct.targetId}].fields`;
        const read = direct.kind === "map"
          ? `${fields}.get(${JSON.stringify(direct.key)})`
          : `${fields}[${JSON.stringify(direct.key)}]`;
        return [
          `let ${cache.value} = ${read};`,
          ...(cache.data
            ? [`let ${cache.data} = helpers.arrayData(${cache.value});`]
            : []),
        ];
      });
    // Scalar positional regions have already passed the all-owner
    // initialization guard and have not performed a guest effect yet. Resolve
    // any cold getstatic location at that entry edge, snapshot its current
    // value, and let the generated body use the scalar directly. This removes
    // linkage/value-validity branches from nested pixel, codec, and mixer
    // loops while retaining canonical class initialization on the fallback
    // path. The ordinary frame-backed entry keeps its lazy per-bytecode logic.
    const directEntryStaticReadDeclarations =
      !this.directEntryStaticLinkingEnabled
        ? entryStaticReadDeclarations
        : [...entryStaticReadCaches.values()].flatMap((cache) => {
          if (!cache.lazy) {
            const direct = cache.direct;
            const fields =
              `helpers.directStaticTargets[${direct.targetId}].fields`;
            const read = direct.kind === "map"
              ? `${fields}.get(${JSON.stringify(direct.key)})`
              : `${fields}[${JSON.stringify(direct.key)}]`;
            return [
              `let ${cache.value} = ${read};`,
              ...(cache.data
                ? [`let ${cache.data} = helpers.arrayData(${cache.value});`]
                : []),
            ];
          }
          const lazy = cache.lazy;
          const read = `${lazy.variable}.kind === "map" ? ` +
            `${lazy.variable}.fields.get(${lazy.variable}.key) : ` +
            `${lazy.variable}.fields[${lazy.variable}.key]`;
          return [
            `let ${cache.value};`,
            `if (${lazy.variable}) {`,
            `  ${cache.value} = ${read};`,
            "} else {",
            `  ${cache.value} = helpers.getStaticSyncAt(${lazy.site});`,
            `  if (${cache.value} === helpers.staticDeopt()) ` +
              "{ return helpers.asyncInvokeSentinel(); }",
            `  ${lazy.variable} = helpers.fieldSites[${lazy.site}].staticTarget;`,
            `  if (${lazy.variable}) ` +
              "helpers.structuredSsa.lazyStaticTargetLinkCount += 1;",
            "}",
            ...(cache.data
              ? [`let ${cache.data} = helpers.arrayData(${cache.value});`]
              : []),
          ];
        });
    // A sync call site may publish a positional target after the caller was
    // compiled. Snapshot the current monomorphic record once per generated
    // entry instead of reloading the site table and target object in every
    // loop iteration. A cold snapshot simply uses the canonical linker for
    // this entry; the next entry observes the published target. The target's
    // own class/debug/epoch guards remain authoritative.
    const positionalParentOwner = method.className ||
      this.jit.jvm.findClassNameForMethod?.(method) || null;
    const positionalCallDeclarationsFor = () => [...callSites]
      .filter(([, site]) => site.id !== null && site.id !== undefined)
      .flatMap(([index, site]) => {
        const trustedCapturedLeaf =
          Array.isArray(site.directCheckedLeaf?.captures) &&
          site.directCheckedLeaf.captures.length > 0;
        const captures = trustedCapturedLeaf &&
          Array.isArray(site.directCheckedLeaf?.captures)
          ? site.directCheckedLeaf.captures : [];
        const captureLines = [];
        const captureArguments = [];
        for (let captureIndex = 0; captureIndex < captures.length;
          captureIndex += 1) {
          const capture = captures[captureIndex];
          const fields =
            `helpers.directStaticTargets[${capture.targetId}].fields`;
          const valueName =
            `ssaCallCapture${index}_${captureArguments.length}`;
          captureLines.push(`const ${valueName} = ${capture.kind === "map"
            ? `${fields}.get(${JSON.stringify(capture.key)})`
            : `${fields}[${JSON.stringify(capture.key)}]`};`);
          captureArguments.push(valueName);
          if (capture.data) {
            const dataName =
              `ssaCallCapture${index}_${captureArguments.length}`;
            captureLines.push(
              `const ${dataName} = helpers.arrayData(${valueName});`);
            captureArguments.push(dataName);
          }
        }
        const rawBody = `ssaFastPositionalRawBody${index}`;
        const directRawLines = site.directCheckedLeaf && trustedCapturedLeaf
          ? [
            `const ${rawBody} = ` +
              `helpers.directCheckedLeafBodies[${site.directCheckedLeaf.id}];`,
            ...captureLines,
            `const ${positionalCallRawInvokeVariable(index)} = ${rawBody};`,
          ]
          : [
            `const ${positionalCallRawInvokeVariable(index)} = ` +
              `${positionalCallTargetVariable(index)} && ` +
              `${positionalCallTargetVariable(index)}.rawInvoke;`,
          ];
        return [
        `const ${positionalCallSiteVariable(index)} = ` +
          `helpers.syncCallSites[${site.id}];`,
        `const ${positionalCallTargetVariable(index)} = ` +
          `!helpers.profileMethods && ${positionalCallSiteVariable(index)} && ` +
          `${positionalCallSiteVariable(index)}.fastPositional && ` +
          `(${positionalCallSiteVariable(index)}.fastPositional.debugGuarded || ` +
          `!helpers.jvm.debugManager.isClassJitDeopted(` +
          `${positionalCallSiteVariable(index)}.fastPositional.lookupClass)) ` +
          `? ${positionalCallSiteVariable(index)}.fastPositional : null;`,
        `const ${positionalCallInvokeVariable(index)} = ` +
          `${positionalCallTargetVariable(index)} && ` +
          `${positionalCallTargetVariable(index)}.invoke;`,
        ...directRawLines,
        `const ${positionalCallReceiverVariable(index)} = ` +
          `${positionalCallTargetVariable(index)} && ` +
          `${positionalCallTargetVariable(index)}.receiverType;`,
        ];
      });
    const positionalCallDeclarations =
      positionalCallDeclarationsFor();
    const directPositionalCallDeclarations =
      positionalCallDeclarations;
    const fieldReadCacheDeclarations = [...fieldReadCaches.values()].flatMap((cache) => [
      `let ${cache.object} = null;`,
      `let ${cache.value};`,
      `let ${cache.valid} = false;`,
      ...(cache.isArray ? [`let ${cache.data} = null;`] : []),
    ]);
    const fieldReadCacheInitializations = [...fieldReadCaches.values()]
      .filter((cache) =>
        cache.eagerLocal !== null && cache.eagerLocal !== undefined)
      .flatMap((cache) => [
        `if (local${cache.eagerLocal} !== null && ` +
          `local${cache.eagerLocal} !== undefined) {`,
        `  ${cache.object} = local${cache.eagerLocal};`,
        `  ${cache.value} = ${cache.directKey
          ? `(local${cache.eagerLocal}.fields && ` +
            `local${cache.eagerLocal}.fields[${JSON.stringify(cache.directKey)}] !== undefined ? ` +
            `local${cache.eagerLocal}.fields[${JSON.stringify(cache.directKey)}] : ` +
            `helpers.getFieldAt(${cache.site}, local${cache.eagerLocal}))`
          : `helpers.getFieldAt(${cache.site}, local${cache.eagerLocal})`};`,
        ...(cache.isArray ? [
          `  ${cache.data} = helpers.arrayData(${cache.value});`,
        ] : []),
        `  ${cache.valid} = true;`,
        "}",
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
    const renderedTreeSource = renderedTree.join("\n");
    const entryArrayDataDeclarations = [...entryArrayLocalSlots]
      .filter((slot) =>
        declaredLocals.includes(slot) &&
        renderedTreeSource.includes(entryArrayDataVariable(slot)))
      .map((slot) =>
        `const ${entryArrayDataVariable(slot)} = helpers.arrayData(local${slot});`);
    const guardedArrayDataVariables = [
      ...entryArrayDataDeclarations.map((line) =>
        /^const ([A-Za-z0-9_$]+)/.exec(line)?.[1]).filter(Boolean),
      ...[...entryStaticReadCaches.values()]
        .filter((cache) => !cache.lazy)
        .map((cache) => cache.data).filter(Boolean),
    ];
    const guardedArrayDataCondition = guardedArrayDataVariables.length
      ? guardedArrayDataVariables.map((data) => `${data} === null`).join(" || ")
      : null;
    const framedArrayDataGuard = guardedArrayDataCondition
      ? `if (${guardedArrayDataCondition}) { helpers.skipJitOnce(frame); ` +
        "return { deopt: true, transient: true, reason: " +
        "'non-canonical primitive array storage' }; }"
      : null;
    const directArrayDataGuard = guardedArrayDataCondition
      ? `if (${guardedArrayDataCondition}) { ` +
        "return helpers.asyncInvokeSentinel(); }"
      : null;
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
    const directMethodOwner = positionalParentOwner;
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
      if (depths[index] === undefined || !normalReachableItems.has(index)) continue;
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
    // A second direct ABI covers effectful primitive-array regions such as
    // samplers, pixel writers, codecs, and mixers. It may contain structured
    // loops and static calls; neither property requires a child Frame on the
    // normal path. Every safe point or throwing instruction already
    // materializes its exact bytecode PC, locals, and operand stack. The
    // direct body lazily creates and restores the omitted Frame only when one
    // of those uncommon paths is actually taken.
    const restoringDirectPositionalOps = new Set([
      ...directPositionalOps,
      "aconst_null",
      "aload", "aload_0", "aload_1", "aload_2", "aload_3",
      "astore", "astore_0", "astore_1", "astore_2", "astore_3",
      "getfield",
      "putstatic",
      "arraylength",
      "iaload", "saload", "baload", "caload",
      "iastore", "sastore", "bastore", "castore",
      "ifnull", "ifnonnull", "if_acmpeq", "if_acmpne",
      "idiv", "irem",
      "invokestatic", "invokevirtual",
      "return",
    ]);
    const directPrimitiveDescriptors = new Set([
      "Z", "B", "C", "S", "I",
      "[Z", "[B", "[C", "[S", "[I",
    ]);
    const restoringDirectParameterType = (type) =>
      directIntegralTypes.has(type) ||
      ["boolean[]", "byte[]", "char[]", "short[]", "int[]"].includes(type) ||
      typeof type === "string" &&
        !["void", "long", "float", "double"].includes(type);
    const referenceStaticPositionalEnabled =
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_REFERENCE_STATIC_POSITIONAL === "1");
    const effectfulFieldPositionalEnabled =
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_EFFECTFUL_FIELD_POSITIONAL === "1");
    let restoringDirectRejection = null;
    let restoringDirectPositionalEligible = Boolean(
      !directPositionalEligible &&
      directMethodDescriptor &&
      (directMethodDescriptor.returnType === "void" ||
        directIntegralTypes.has(directMethodDescriptor.returnType)) &&
      directMethodDescriptor.params.every(restoringDirectParameterType) &&
      directMethodOwner &&
      [...fieldReadCaches.values()].every((cache) =>
        cache.directKey &&
        (effectfulFieldPositionalEnabled ||
          cache.eagerLocal !== null && cache.eagerLocal !== undefined)),
    );
    if (!restoringDirectPositionalEligible) {
      restoringDirectRejection = directPositionalEligible
        ? "non-restoring direct entry already selected"
        : "descriptor, owner, return type, or field-cache shape";
    }
    for (let index = 0;
      index < items.length && restoringDirectPositionalEligible;
      index += 1) {
      if (depths[index] === undefined || !normalReachableItems.has(index)) continue;
      const instruction = items[index]?.instruction;
      const op = opOf(instruction);
      if (!op) continue;
      if (!restoringDirectPositionalOps.has(op)) {
        restoringDirectPositionalEligible = false;
        restoringDirectRejection = `unsupported normal opcode ${op} at ${index}`;
        break;
      }
      if ((op === "ldc" || op === "ldc_w") &&
          !Number.isInteger(Number(instruction.arg?.value ?? instruction.arg))) {
        restoringDirectPositionalEligible = false;
        restoringDirectRejection = `non-integral constant at ${index}`;
        break;
      }
      if (op === "getfield") {
        const site = fieldSites.get(index);
        const plan = site === undefined ? null : this.jit.fieldSites[site];
        const cache = fieldReadCacheSites.get(index);
        if (!plan || !directPrimitiveDescriptors.has(plan.descriptor) ||
            !cache?.directKey ||
            (!effectfulFieldPositionalEnabled &&
              (cache.eagerLocal === null || cache.eagerLocal === undefined))) {
          restoringDirectPositionalEligible = false;
          restoringDirectRejection = `unresolved primitive instance field at ${index}`;
          break;
        }
      }
      if (op === "getstatic") {
        const direct = directStaticSites.get(index);
        const lazy = lazyStaticSites.get(index);
        const descriptor = instruction.arg?.[2]?.[1];
        const scalarOrReference = directPrimitiveDescriptors.has(descriptor) ||
          referenceStaticPositionalEnabled &&
          typeof descriptor === "string" &&
          (descriptor.startsWith("L") || descriptor.startsWith("["));
        if ((!direct && !lazy) || !scalarOrReference) {
          restoringDirectPositionalEligible = false;
          restoringDirectRejection =
            `unresolved direct or linkable static field at ${index}`;
          break;
        }
      }
    }
    const structuredPositionalTrace = typeof process !== "undefined" &&
      process.env ? process.env.JVM_TRACE_STRUCTURED_POSITIONAL || "" : "";
    const structuredMethodKey =
      `${directMethodOwner || "?"}.${method.name}${method.descriptor}`;
    if (structuredPositionalTrace &&
        structuredMethodKey.includes(structuredPositionalTrace)) {
      console.error("[structured-positional]", JSON.stringify({
        method: structuredMethodKey,
        loops: structured.loopHeaders.size,
        normalItems: normalReachableItems.size,
        direct: directPositionalEligible,
        restoring: restoringDirectPositionalEligible,
        rejection: restoringDirectPositionalEligible
          ? null : restoringDirectRejection,
      }));
    }
    const materializeHelperDeclarations = () =>
      [...materializeDepths].sort((left, right) => left - right)
        .flatMap((depth) => {
          const operands = Array.from(
            {length: depth}, (_unused, index) => `operand${index}`);
          return [
            `function ssaMaterialize${depth}(pc${
              operands.length ? `, ${operands.join(", ")}` : ""}) {`,
            "  spillLocals();",
            ...operands.map((operand, index) =>
              `  stack[${index}] = ${operand};`),
            `  stack.length = ${depth};`,
            "  helpers.materialize(frame, locals, stack, pc);",
            "}",
          ];
        });
    const inlineMaterializeCalls = (lines) =>
      lines.flatMap((line) => {
        const match =
          /^(\s*)ssaMaterialize(\d+)\((.*)\);$/.exec(line);
        if (!match) return [line];
        const prefix = match[1];
        const depth = Number(match[2]);
        const values = match[3].split(",").map((value) => value.trim());
        if (values.length !== depth + 1) return [line];
        const [pc, ...operands] = values;
        return [
          `${prefix}spillLocals();`,
          ...operands.map((operand, index) =>
            `${prefix}stack[${index}] = ${operand};`),
          `${prefix}stack.length = ${depth};`,
          `${prefix}helpers.materialize(frame, locals, stack, ${pc});`,
        ];
      });
    const buildBody = (
      tree, entrySafePointBudget = safePointInitialBudget,
    ) => ["'use strict';",
      "const locals = frame.locals;", "const stack = frame.stack.items;",
      "if ((!framelessEntry && frame.pc !== 0) || (initialBytecodeChecks === undefined ? helpers.needsBytecodeChecks() : initialBytecodeChecks)) { helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'structured SSA entry' }; }",
      staticInitializationGuardDeclaration,
      staticEntryGuard,
      ...directStaticDeclarations,
      ...lazyStaticDeclarations,
      ...entryStaticReadDeclarations,
      ...positionalCallDeclarations,
      guardedStaticBooleanEntryGuard,
      this.runCountersEnabled
        ? "helpers.structuredSsa.runCount += 1;" : null,
      `let safePointBudget = ${entrySafePointBudget};`,
      ...declaredLocals.map((i) => `${immutableEntryLocals.has(i) ? "const" : "let"} local${i} = ${
        entryLocalInitialValues.has(i) ? entryLocalInitialValues.get(i) : `locals[${i}]`};`),
      ...entryArrayDataDeclarations,
      ...fieldReadCacheDeclarations,
      ...fieldReadCacheInitializations,
      framedArrayDataGuard,
      `const spillLocals = () => {${spillSlots.map((i) => ` locals[${i}] = ${
        immutableEntryLocals.has(i) ? entryLocalInitialValues.get(i) : `local${i}`};`).join("")} };`,
      ...materializeHelperDeclarations(),
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
        const directInitializationGuardId =
          this.registerClassInitializationGuard(owners);
        const directInitializationGuardDeclaration =
          `const ssaDirectClassInitializationGuard = ` +
          `helpers.structuredSsa.classInitializationGuards[${directInitializationGuardId}];`;
        const directInitializationCondition =
          "((ssaDirectClassInitializationGuard.classEpoch !== " +
          "(helpers.jvm.classEpoch || 0) || " +
          "ssaDirectClassInitializationGuard.initializationEpoch !== " +
          "(helpers.jvm.classInitializationEpoch || 0)) && " +
          "!helpers.structuredSsa.verifyClassInitializationGuard(" +
          "ssaDirectClassInitializationGuard))";
        const directGuardConditions = [
          "(!nestedEntryGuarded && helpers.needsBytecodeChecks())",
          directInitializationCondition,
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
          directInitializationGuardDeclaration,
          directGuard,
          ...directStaticDeclarations,
          ...lazyStaticDeclarations,
          ...directEntryStaticReadDeclarations,
          ...directPositionalCallDeclarations,
          directBooleanGuard,
          this.runCountersEnabled
            ? "helpers.structuredSsa.runCount += 1;" : null,
          `let safePointBudget = ${safePointInitialBudget};`,
          ...declaredLocals.map((index) =>
            `${immutableEntryLocals.has(index) ? "const" : "let"} local${index} = ${
              entryLocalInitialValues.has(index)
                ? entryLocalInitialValues.get(index)
                : entryArguments.get(index) || "undefined"};`),
          ...entryArrayDataDeclarations,
          directArrayDataGuard,
          ...declarations,
          ...expandContinuationFallbacks(
            render(structured.tree, false, true), false),
        ].filter(Boolean).join("\n");
        directPositionalBody = this.jit.createGeneratedFunction(
          method,
          "ssa-direct-positional",
          ["helpers", ...argumentNames, "thread", "nestedEntryGuarded"],
          directPositionalSource,
        );
      }
      let restoringDirectPositionalBody = null;
      let restoringDirectPositionalSource = null;
      let checkedLeafDirectPositionalBody = null;
      let checkedLeafDirectPositionalSource = null;
      let capturedCheckedLeafDirectPositionalBody = null;
      let capturedCheckedLeafDirectPositionalSource = null;
      let capturedCheckedLeafDirectPositionalPlan = null;
      if (restoringDirectPositionalEligible) {
        // A restoring entry is an already-verified synchronous intermethod
        // region. Give it a larger scalar quantum than a scheduler-owned
        // Frame: nested calls retain their own guards and safe points, while
        // an unusually large local loop still restores the exact JVM state
        // when this finite budget expires.
        const restoringDirectSafePointBudget = Math.min(
          1_000_000,
          safePointInitialBudget * this.restoringDirectBudgetMultiplier,
        );
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
        const restoringInitializationGuardId =
          this.registerClassInitializationGuard(owners);
        const restoringInitializationGuardDeclaration =
          `const ssaRestoringClassInitializationGuard = ` +
          `helpers.structuredSsa.classInitializationGuards[${restoringInitializationGuardId}];`;
        const restoringInitializationCondition =
          "((ssaRestoringClassInitializationGuard.classEpoch !== " +
          "(helpers.jvm.classEpoch || 0) || " +
          "ssaRestoringClassInitializationGuard.initializationEpoch !== " +
          "(helpers.jvm.classInitializationEpoch || 0)) && " +
          "!helpers.structuredSsa.verifyClassInitializationGuard(" +
          "ssaRestoringClassInitializationGuard))";
        const directGuardConditions = [
          "(!nestedEntryGuarded && (helpers.profileMethods || " +
            "helpers.needsBytecodeChecks() || thread.status !== 'runnable'))",
          restoringInitializationCondition,
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
        const restoringSpillLines = [
          "if (frame === null) {",
          ...initializeFrame.map((line) => `  ${line}`),
          "}",
          ...spillSlots.map((index) => `locals[${index}] = ${
            immutableEntryLocals.has(index)
              ? entryLocalInitialValues.get(index) : `local${index}`};`),
          "plan.restoreFrame(thread, frame, restorationDepth);",
        ];
        // An acyclic scalar kernel cannot hit a scheduler backedge. Its spill
        // path exists only for an exceptional operation or guarded fallback,
        // so avoid allocating a closure on every successful invocation. The
        // reconstruction statements are duplicated into those cold arms;
        // larger loop bodies keep the outlined closure to control code size.
        const inlineRestoringSpills =
          this.acyclicInlineRestoringSpillsEnabled &&
          structured.loopHeaders.size === 0 && spillSlots.length <= 32;
        const inlineRestoringSpillCalls = (lines) =>
          !inlineRestoringSpills ? lines : lines.flatMap((line) => {
            const conditional = /^(\s*)if \(frame === null\) spillLocals\(\);$/.exec(line);
            if (conditional) {
              return [
                `${conditional[1]}if (frame === null) {`,
                ...restoringSpillLines.map(
                  (spill) => `${conditional[1]}  ${spill}`),
                `${conditional[1]}}`,
              ];
            }
            const match = /^(\s*)spillLocals\(\);$/.exec(line);
            if (!match) return [line];
            return restoringSpillLines.map((spill) => `${match[1]}${spill}`);
          });
        const restoringRenderedTree = inlineRestoringSpillCalls(
          inlineMaterializeCalls(expandContinuationFallbacks(
            render(structured.tree, false, true,
              restoringDirectSafePointBudget, false, true), false)),
        );
        const directBody = [
          ...directStaticDeclarations,
          ...lazyStaticDeclarations,
          ...directEntryStaticReadDeclarations,
          ...directPositionalCallDeclarations,
          directBooleanGuard,
          this.runCountersEnabled
            ? "helpers.structuredSsa.restoringDirectRunCount += 1;" : null,
          `let safePointBudget = ${restoringDirectSafePointBudget};`,
          ...declaredLocals.map((index) =>
            `${immutableEntryLocals.has(index) ? "const" : "let"} local${index} = ${
              entryLocalInitialValues.has(index)
                ? entryLocalInitialValues.get(index)
                : entryArguments.get(index) || "undefined"};`),
          ...entryArrayDataDeclarations,
          directArrayDataGuard,
          ...(inlineRestoringSpills ? [] : [
            "function spillLocals() {",
            ...restoringSpillLines.map((line) => `  ${line}`),
            "}",
          ]),
          ...fieldReadCacheDeclarations,
          ...fieldReadCacheInitializations,
          ...declarations,
          ...restoringRenderedTree,
        ].filter(Boolean);
        restoringDirectPositionalSource = [
          "'use strict';",
          restoringInitializationGuardDeclaration,
          directGuard,
          "const restorationDepth = thread.callStack.items.length;",
          "let frame = null;",
          "let locals = null;",
          "let stack = null;",
          "try {",
          ...directBody.map((line) => `  ${line}`),
          "} catch (error) {",
          "  if (frame !== null) {",
          "    helpers.structuredSsa.restoredDirectExceptionFrameCount += 1;",
          "    plan.restoreFrame(thread, frame, restorationDepth);",
          "  }",
          "  throw error;",
          "}",
        ].join("\n");
        restoringDirectPositionalBody = this.jit.createGeneratedFunction(
          method,
          "ssa-direct-restoring-positional",
          ["helpers", "plan", ...argumentNames, "thread",
            "nestedEntryGuarded"],
          restoringDirectPositionalSource,
        );

        const singleLoopHeader = structured.loopHeaders.size === 1
          ? [...structured.loopHeaders][0] : null;
        const singleLoop = Number.isInteger(singleLoopHeader)
          ? countedLoopInfos.get(singleLoopHeader) : null;
        const loopItems = singleLoop
          ? new Set([...singleLoop.loopBlocks].flatMap(
            (block) => cfg.blocks[block]?.insns || []))
          : new Set();
        const effectOps = new Set([
          "putfield", "putstatic",
          "iastore", "sastore", "bastore", "castore",
          "dastore", "fastore", "lastore", "aastore",
        ]);
        const throwingOrDynamicOps = new Set([
          "idiv", "irem", "getfield", "arraylength", "athrow",
          "new", "newarray", "anewarray", "multianewarray",
          "monitorenter", "monitorexit", "checkcast", "instanceof",
        ]);
        const checkedLeafShape = this.checkedLeafDirectPositionalEnabled &&
          singleLoop &&
          (atomicBoundedLoops ||
            runtimeCoarseCountedLoops.has(singleLoopHeader)) &&
          callSites.size === 0 &&
          items.every((item, index) => {
            const op = opOf(item?.instruction);
            if (!op || !normalReachableItems.has(index)) return true;
            if (throwingOrDynamicOps.has(op)) return false;
            return !effectOps.has(op) || loopItems.has(index);
          });
        if (checkedLeafShape) {
          const checkedLeafTree = render(
            structured.tree, false, true,
            restoringDirectSafePointBudget, true);
          const checkedLeafBody = [
            ...directStaticDeclarations,
            ...lazyStaticDeclarations,
            ...directEntryStaticReadDeclarations,
            directBooleanGuard,
            this.runCountersEnabled
              ? "helpers.structuredSsa.restoringDirectRunCount += 1;" : null,
            `let safePointBudget = ${restoringDirectSafePointBudget};`,
            ...declaredLocals.map((index) =>
              `${immutableEntryLocals.has(index) ? "const" : "let"} local${index} = ${
                entryLocalInitialValues.has(index)
                  ? entryLocalInitialValues.get(index)
                  : entryArguments.get(index) || "undefined"};`),
            ...entryArrayDataDeclarations,
            directArrayDataGuard,
            ...declarations,
            ...checkedLeafTree,
          ].filter(Boolean);
          const unsafeCheckedLeafLine = checkedLeafBody.some((line) =>
            line.includes("spillLocals(") ||
            line.includes("helpers.materialize(") ||
            line.includes("helpers.arrayLoad(") ||
            line.includes("helpers.arrayStore(") ||
            line.includes("throw ") || line.includes("try {"));
          if (!unsafeCheckedLeafLine) {
            checkedLeafDirectPositionalSource = [
              "'use strict';",
              restoringInitializationGuardDeclaration,
              directGuard,
              ...checkedLeafBody,
            ].join("\n");
            checkedLeafDirectPositionalBody =
              this.jit.createGeneratedFunction(
                method,
                "ssa-checked-leaf-positional",
                ["helpers", ...argumentNames, "thread",
                  "nestedEntryGuarded"],
                checkedLeafDirectPositionalSource,
              );
            const capturedCaches = [...entryStaticReadCaches.values()];
            if (capturedCaches.length > 0 &&
                capturedCaches.every((cache) => cache.direct) &&
                lazyStaticSites.size === 0 &&
                guardedStaticBooleanSites.size === 0) {
              const captureArguments = [];
              const captureDeclarations = [];
              const captures = [];
              for (const cache of capturedCaches) {
                const valueArgument =
                  `ssaCapturedStatic${captureArguments.length}`;
                captureArguments.push(valueArgument);
                captureDeclarations.push(
                  `const ${cache.value} = ${valueArgument};`);
                const capture = {
                  targetId: cache.direct.targetId,
                  kind: cache.direct.kind,
                  key: cache.direct.key,
                  data: Boolean(cache.data),
                };
                if (cache.data) {
                  const dataArgument =
                    `ssaCapturedStatic${captureArguments.length}`;
                  captureArguments.push(dataArgument);
                  captureDeclarations.push(
                    `const ${cache.data} = ${dataArgument};`);
                }
                captures.push(capture);
              }
              const capturedBody = [
                ...captureDeclarations,
                this.runCountersEnabled
                  ? "helpers.structuredSsa.restoringDirectRunCount += 1;" : null,
                `let safePointBudget = ${restoringDirectSafePointBudget};`,
                ...declaredLocals.map((index) =>
                  `${immutableEntryLocals.has(index) ? "const" : "let"} local${index} = ${
                    entryLocalInitialValues.has(index)
                      ? entryLocalInitialValues.get(index)
                      : entryArguments.get(index) || "undefined"};`),
                ...entryArrayDataDeclarations,
                directArrayDataGuard,
                ...declarations,
                ...checkedLeafTree,
              ].filter(Boolean);
              capturedCheckedLeafDirectPositionalSource = [
                "'use strict';",
                restoringInitializationGuardDeclaration,
                directGuard,
                ...capturedBody,
              ].join("\n");
              capturedCheckedLeafDirectPositionalBody =
                this.jit.createGeneratedFunction(
                  method,
                  "ssa-captured-checked-leaf-positional",
                  ["helpers", ...argumentNames, ...captureArguments,
                    "thread", "nestedEntryGuarded"],
                  capturedCheckedLeafDirectPositionalSource,
                );
              capturedCheckedLeafDirectPositionalPlan = {
                captures,
              };
            }
          }
        }
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
      generated.jvmStructuredRequiresBaselineFramedEntry =
        requiresBaselineFramedEntry;
      generated.jvmStructuredContinuation = useContinuations;
      generated.jvmFramelessPositional = !useContinuations;
      generated.jvmDirectPositionalBody = directPositionalBody;
      generated.jvmDirectPositionalSource = directPositionalSource;
      if (restoringDirectPositionalBody &&
          this.jit.guestKernelOraclesEnabled) {
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
      generated.jvmCheckedLeafDirectPositionalBody =
        checkedLeafDirectPositionalBody;
      generated.jvmCheckedLeafDirectPositionalSource =
        checkedLeafDirectPositionalSource;
      generated.jvmCapturedCheckedLeafDirectPositionalBody =
        capturedCheckedLeafDirectPositionalBody;
      generated.jvmCapturedCheckedLeafDirectPositionalSource =
        capturedCheckedLeafDirectPositionalSource;
      generated.jvmCapturedCheckedLeafDirectPositionalPlan =
        capturedCheckedLeafDirectPositionalPlan;
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
      generated.jvmStructuredArrayRangeGuardCount =
        arrayRangeCheckCandidates.length;
      generated.jvmStructuredHoistedArrayRangeGuardCount =
        hoistedArrayRangeGuardCount;
      generated.jvmStructuredCoalescedSsaCopyCount =
        coalescedSsaCopyCount;
      generated.jvmStructuredDominatedArithmeticGuardCount =
        dominatedArithmeticGuardCount;
      generated.jvmStructuredCapturedCheckedLeafCallCount =
        [...callSites.values()].filter((site) =>
          Array.isArray(site.directCheckedLeaf?.captures) &&
          site.directCheckedLeaf.captures.length > 0).length;
      generated.jvmStructuredBoundedIndexRangeCount =
        arrayRangeCheckCandidates.filter(
          (candidate) => candidate.kind === "bounded-index").length;
      generated.jvmStructuredScaledIndexRangeCount =
        arrayRangeCheckCandidates.filter(
          (candidate) => candidate.kind === "scaled-local").length;
      generated.jvmStructuredRecurrenceRangeCount =
        quotientProductRangePreambles.size;
      generated.jvmStructuredCyclicRangeCount =
        cyclicArrayRangeCandidates.size;
      generated.jvmStructuredSpecializedArrayRangeAccessCount =
        specializedArrayRangeAccessCount;
      generated.jvmStructuredGuardedBooleanSiteCount = guardedStaticBooleanSites.size;
      generated.jvmStructuredPrunedBooleanCfgBranchCount =
        prunedBooleanCfgBranches;
      generated.jvmStructuredDeclaredLocalCount = declaredLocals.length;
      generated.jvmStructuredSpilledLocalCount = spillSlots.length;
      generated.jvmStructuredImmutableEntryLocalCount = immutableEntryLocals.size;
      generated.jvmStructuredFieldReadCacheCount = fieldReadCaches.size;
      generated.jvmStructuredEagerThisFieldCount = [...fieldReadCaches.values()]
        .filter((cache) => cache.eagerThis).length;
      generated.jvmStructuredEagerEntryFieldCount = [...fieldReadCaches.values()]
        .filter((cache) =>
          cache.eagerLocal !== null && cache.eagerLocal !== undefined).length;
      generated.jvmStructuredCoarseCountedLoopCount = coarseCountedLoops.size;
      generated.jvmStructuredCountedLoopCount = countedLoopInfos.size;
      generated.jvmStructuredSafePointBudget = safePointInitialBudget;
      generated.jvmStructuredRestoringDirectSafePointBudget =
        restoringDirectPositionalEligible
          ? Math.min(1_000_000, safePointInitialBudget *
            this.restoringDirectBudgetMultiplier)
          : 0;
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
