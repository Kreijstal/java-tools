const {
  buildCfgFromCode,
  structure,
  IrreducibleError,
  succOfTerm,
  succAllOfTerm,
} = require("../decompiler/structurer");
const { splitIrreducibleTerms } = require("../decompiler/exceptionStructurer");
const { parseDescriptor } = require("../parsing/typeParser");
const { buildSsa } = require("../analysis/opgraph/ssa");
const { kindWidth } = require("../analysis/opgraph/ssaTypes");
const { parse: parseJavaScript } = require("acorn");
const STRUCTURED_CONTINUATION = Symbol("jvm.structuredSsaContinuation");

function isIrreducibleError(error) {
  return error instanceof IrreducibleError ||
    error?.name === "IrreducibleError" && Array.isArray(error.edges);
}

function walkJavaScriptAst(node, visit, parent = null) {
  if (!node || typeof node !== "object") return;
  visit(node, parent);
  for (const [key, child] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc" ||
        key === "range") continue;
    if (Array.isArray(child)) {
      for (const entry of child) walkJavaScriptAst(entry, visit, node);
    } else if (child && typeof child.type === "string") {
      walkJavaScriptAst(child, visit, node);
    }
  }
}

function parseGeneratedStatements(source) {
  const prefix = "function* __jvmSsaAstWrapper() {\n";
  const program = parseJavaScript(`${prefix}${source}\n}`, {
    ecmaVersion: "latest",
    ranges: true,
  });
  return {
    offset: prefix.length,
    statements: program.body[0].body.body,
    program,
  };
}

function rewriteGeneratedJavaScript(source, resolveIdentifier,
  removedStatements = []) {
  if (typeof source !== "string" || source.length === 0) return source;
  const parsed = parseGeneratedStatements(source);
  const removed = removedStatements.map((statement) => ({
    start: statement.start - parsed.offset,
    end: statement.end - parsed.offset,
  }));
  const edits = removed.map((range) => ({...range, replacement: ""}));
  walkJavaScriptAst(parsed.program, (node, parent) => {
    if (node.type !== "Identifier") return;
    if (parent?.type === "MemberExpression" && parent.property === node &&
        !parent.computed) return;
    if ((parent?.type === "Property" || parent?.type === "MethodDefinition") &&
        parent.key === node && !parent.computed && !parent.shorthand) return;
    if ((parent?.type === "LabeledStatement" ||
        parent?.type === "BreakStatement" ||
        parent?.type === "ContinueStatement") && parent.label === node) return;
    const replacement = resolveIdentifier(node.name);
    if (replacement === node.name) return;
    const start = node.start - parsed.offset;
    const end = node.end - parsed.offset;
    if (removed.some((range) => start >= range.start && end <= range.end)) return;
    edits.push({start, end, replacement});
  });
  edits.sort((left, right) => right.start - left.start || right.end - left.end);
  let rewritten = source;
  for (const edit of edits) {
    rewritten = rewritten.slice(0, edit.start) + edit.replacement +
      rewritten.slice(edit.end);
  }
  return rewritten;
}

function rewriteGeneratedExpression(source, resolveIdentifier) {
  if (typeof source !== "string" || source.length === 0) return source;
  const prefix = "function __jvmSsaExpressionWrapper() { return (";
  const program = parseJavaScript(`${prefix}${source}); }`, {
    ecmaVersion: "latest",
  });
  const edits = [];
  walkJavaScriptAst(program, (node, parent) => {
    if (node.type !== "Identifier") return;
    if (parent?.type === "MemberExpression" && parent.property === node &&
        !parent.computed) return;
    const replacement = resolveIdentifier(node.name);
    if (replacement !== node.name) {
      edits.push({
        start: node.start - prefix.length,
        end: node.end - prefix.length,
        replacement,
      });
    }
  });
  edits.sort((left, right) => right.start - left.start);
  let rewritten = source;
  for (const edit of edits) {
    rewritten = rewritten.slice(0, edit.start) + edit.replacement +
      rewritten.slice(edit.end);
  }
  return rewritten;
}

function unboundGeneratedSsaIdentifiers(source) {
  const parsed = parseGeneratedStatements(source);
  const scopes = [];
  const nodeScopes = new WeakMap();
  const declarations = new WeakSet();
  const createScope = (parent) => {
    const scope = {parent, bindings: new Set()};
    scopes.push(scope);
    return scope;
  };
  const rootScope = createScope(null);
  const children = (node) => Object.entries(node).flatMap(([key, child]) => {
    if (key === "start" || key === "end" || key === "loc" ||
        key === "range") return [];
    if (Array.isArray(child)) {
      return child.filter((entry) => entry && typeof entry.type === "string");
    }
    return child && typeof child.type === "string" ? [child] : [];
  });
  const declare = (pattern, scope) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      declarations.add(pattern);
      if (pattern.name.startsWith("ssaValue")) scope.bindings.add(pattern.name);
    } else if (pattern.type === "RestElement") {
      declare(pattern.argument, scope);
    } else if (pattern.type === "AssignmentPattern") {
      declare(pattern.left, scope);
    } else if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements) declare(element, scope);
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        declare(property.value || property.argument, scope);
      }
    }
  };
  const define = (node, scope, parent = null) => {
    if (!node || typeof node !== "object") return;
    nodeScopes.set(node, scope);
    if (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") {
      if (node.id) declare(node.id, scope);
      const functionScope = createScope(scope);
      for (const parameter of node.params) declare(parameter, functionScope);
      define(node.body, functionScope, node);
      return;
    }
    if (node.type === "BlockStatement") {
      const blockScope = createScope(scope);
      nodeScopes.set(node, blockScope);
      for (const statement of node.body) define(statement, blockScope, node);
      return;
    }
    if (node.type === "CatchClause") {
      const catchScope = createScope(scope);
      nodeScopes.set(node, catchScope);
      declare(node.param, catchScope);
      define(node.body, catchScope, node);
      return;
    }
    if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations) declare(declarator.id, scope);
    }
    for (const child of children(node)) define(child, scope, node);
  };
  define(parsed.program, rootScope);

  const unbound = new Set();
  walkJavaScriptAst(parsed.program, (node, parent) => {
    if (node.type !== "Identifier" || !node.name.startsWith("ssaValue") ||
        declarations.has(node)) return;
    if (parent?.type === "MemberExpression" && parent.property === node &&
        !parent.computed) return;
    if ((parent?.type === "Property" || parent?.type === "MethodDefinition") &&
        parent.key === node && !parent.computed && !parent.shorthand) return;
    let scope = nodeScopes.get(node) || rootScope;
    while (scope && !scope.bindings.has(node.name)) scope = scope.parent;
    if (!scope) unbound.add(node.name);
  });
  return [...unbound];
}

function normalizedArrayLoadExpression(raw, op, array, arrayKind = null) {
  switch (op) {
    case "baload":
      if (arrayKind === "[Z") return `(${raw} ? 1 : 0)`;
      if (arrayKind === "[B") return `((${raw} << 24) >> 24)`;
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

function normalizedArrayStoreExpression(value, op, array, arrayKind = null) {
  switch (op) {
    case "bastore":
      if (arrayKind === "[Z") return `((${value}) & 1)`;
      if (arrayKind === "[B") return `(((${value}) << 24) >> 24)`;
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

function compactOneUseGuardTemporaries(sourceLines) {
  let lines = [...sourceLines];
  const namePattern =
    "ssa(?:RuntimeCoarse(?:Trips|Loop)|ArrayRangeGuard)\\d+";
  for (;;) {
    const counts = new Map();
    for (const line of lines) {
      for (const match of line.matchAll(
        new RegExp(`\\b${namePattern}\\b`, "g"))) {
        counts.set(match[0], (counts.get(match[0]) || 0) + 1);
      }
    }
    let changed = false;
    for (let declarationIndex = 0;
      declarationIndex < lines.length; declarationIndex += 1) {
      const declaration = new RegExp(
        `^(\\s*)const (${namePattern}) = (.+);$`,
      ).exec(lines[declarationIndex]);
      if (!declaration || counts.get(declaration[2]) !== 2 ||
          /\bhelpers\.|\bnew\b/.test(declaration[3])) continue;
      const usePattern = new RegExp(`\\b${declaration[2]}\\b`);
      let useIndex = -1;
      for (let index = declarationIndex + 1; index < lines.length; index += 1) {
        if (usePattern.test(lines[index])) {
          useIndex = index;
          break;
        }
      }
      if (useIndex < 0) continue;
      const referencedLocals = [
        ...declaration[3].matchAll(/\blocal(\d+)\b/g),
      ].map((match) => Number(match[1]));
      const localChanged = referencedLocals.some((slot) => {
        const assignment = new RegExp(`\\blocal${slot}\\s*=(?!=)`);
        return lines.slice(declarationIndex + 1, useIndex)
          .some((line) => assignment.test(line));
      });
      if (localChanged) continue;
      lines[useIndex] = lines[useIndex].replace(
        usePattern, `(${declaration[3]})`);
      lines[declarationIndex] = "";
      changed = true;
    }
    if (!changed) return lines;
    lines = lines.filter(Boolean);
  }
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
    this.loopInlineRestoringSpillsEnabled =
      options.structuredLoopInlineRestoringSpills !== false &&
      environment.JVM_DISABLE_SSA_LOOP_INLINE_SPILLS !== "1";
    this.loopInlineRestoringSpillBudget = Math.max(0, Math.min(4096,
      Number(options.structuredLoopInlineRestoringSpillBudget ?? 512) || 0));
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
    this.dominatedFieldReceiverChecksEnabled =
      options.structuredDominatedFieldReceiverChecks !== false &&
      environment.JVM_DISABLE_STRUCTURED_DOMINATED_FIELD_RECEIVER_CHECKS !== "1";
    this.staticPrimitiveArrayKindsEnabled =
      options.structuredStaticPrimitiveArrayKinds !== false &&
      environment.JVM_DISABLE_STRUCTURED_STATIC_ARRAY_KINDS !== "1";
    this.restoringRangeGuardDeoptEnabled =
      options.structuredRestoringRangeGuardDeopt !== false &&
      environment.JVM_DISABLE_STRUCTURED_RESTORING_RANGE_DEOPT !== "1";
    this.loopInvariantDivisorGuardsEnabled =
      options.structuredLoopInvariantDivisorGuards === true ||
      environment.JVM_ENABLE_STRUCTURED_LOOP_INVARIANT_DIVISORS === "1";
    this.restoringDirectFieldLayoutsEnabled =
      options.structuredRestoringDirectFieldLayouts !== false &&
      environment.JVM_DISABLE_STRUCTURED_RESTORING_FIELD_LAYOUTS !== "1";
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
    // Restoring bodies call this table only on cold scheduler/exception
    // transfers. Keeping slot layouts out of generated source avoids either
    // a closure over every hot scalar or repeated Frame reconstruction code.
    this.restoringFrameLayouts = [];
    this.lastCompileError = null;
    this.lastRejectionReason = null;
    this.lastFailedSource = null;
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

  restoreDirectFrame(layoutId, plan, thread, restorationDepth, frame, values) {
    const slots = this.restoringFrameLayouts[layoutId];
    if (!Array.isArray(slots) || !Array.isArray(values) ||
        slots.length !== values.length) {
      throw new Error("invalid structured SSA restoring-frame layout");
    }
    if (frame === null) {
      frame = plan.target.freeFrame || new plan.Frame(plan.method);
      plan.target.freeFrame = null;
      frame.pc = 0;
      frame.stack.items.length = 0;
      delete frame.jitSkipOnce;
      delete frame.jitJsDisabled;
      delete frame.jitAdaptiveEntryCounted;
      frame.className = plan.lookupClass;
    }
    const locals = frame.locals;
    const stack = frame.stack.items;
    for (let index = 0; index < slots.length; index += 1) {
      locals[slots[index]] = values[index];
    }
    plan.restoreFrame(thread, frame, restorationDepth);
    return [frame, locals, stack];
  }

  materializeDirectFrame(layoutId, plan, thread, restorationDepth, frame,
    values, pc, operands) {
    const state = this.restoreDirectFrame(
      layoutId, plan, thread, restorationDepth, frame, values);
    const stack = state[2];
    stack.length = operands.length;
    for (let index = 0; index < operands.length; index += 1) {
      stack[index] = operands[index];
    }
    this.jit.materialize(state[0], state[1], stack, pc);
    return state;
  }

  compile(method) {
    this.lastCompileError = null;
    this.lastRejectionReason = null;
    this.lastFailedSource = null;
    const reject = (reason) => {
      this.lastRejectionReason = reason;
      return null;
    };
    const normalizeJvmScalarExpression = (expression, type) => ({
      Z: `((${expression}) ? 1 : 0)`,
      boolean: `((${expression}) ? 1 : 0)`,
      B: `(((${expression}) << 24) >> 24)`,
      byte: `(((${expression}) << 24) >> 24)`,
      C: `((${expression}) & 0xffff)`,
      char: `((${expression}) & 0xffff)`,
      S: `(((${expression}) << 16) >> 16)`,
      short: `(((${expression}) << 16) >> 16)`,
      I: `((${expression}) | 0)`,
      int: `((${expression}) | 0)`,
    })[type] || expression;
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
    let verifiedStackWidthsBefore = null;
    if (items.some((item) => {
      const instruction = item?.instruction;
      return (typeof instruction === "string"
        ? instruction.trim().split(/\s+/)[0] : instruction?.op) === "dup2";
    })) {
      const analysis = buildSsa({
        codeItems: items,
        exceptionTable: code.code.exceptionTable || [],
        method,
      });
      if (!analysis || analysis.rejected || !analysis.stackKindsBefore) {
        return reject("operand category verification failed");
      }
      verifiedStackWidthsBefore = new Map();
      for (const [index, kinds] of analysis.stackKindsBefore) {
        verifiedStackWidthsBefore.set(index, kinds.map(kindWidth));
      }
    }
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
    const checkedCallAdmissionCandidates = [];
    const selfRecursiveCallExpressions = new Map();
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
        const callOwner = instruction.arg[1];
        const callMember = instruction.arg[2];
        const callOwnerClass = typeof callOwner === "string"
          ? this.jit.jvm.classes[callOwner] : null;
        const resolvedCallMethod = isStatic && callOwnerClass
          ? this.jit.jvm.findMethod(
            callOwnerClass, callMember[0], callMember[1]) : null;
        const selfRecursive = resolvedCallMethod === method;
        const directJre = this.jit.getCompileTimeDirectJre(op, instruction);
        const inline = directJre || !isStatic
          ? null : this.jit.getCompileTimeIntegerLeaf(instruction);
        if (inline?.className) directStaticOwners.add(inline.className);
        const directIntrinsic = directJre || !isStatic || inline
          ? null : this.jit.getCompileTimeSynchronousIntrinsic(instruction);
        const directCheckedLeaf = directJre || !isStatic || inline ||
          directIntrinsic ? null :
          this.jit.getCompileTimeCheckedLeaf(instruction);
        const checkedLeafCaptureCacheId =
          Array.isArray(directCheckedLeaf?.captures) &&
          directCheckedLeaf.captures.length > 0
            ? this.jit.registerCheckedLeafCaptureCache(
              directCheckedLeaf.captures)
            : null;
        if (directCheckedLeaf) {
          directStaticOwners.add(instruction.arg[1]);
          for (const capture of directCheckedLeaf.captures || []) {
            if (capture.className) directStaticOwners.add(capture.className);
          }
        }
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
          checkedLeafCaptureCacheId,
          directFused,
          selfRecursive,
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
    const ssaValueNames = new Set();
    const value = () => {
      const name = `ssaValue${nextValue++}`;
      ssaValueNames.add(name);
      return name;
    };
    const plans = [];
    // SSA names are unique across the method. Preserve their integer
    // provenance beyond block simulation so a later, entry-guarded checked
    // leaf can prove that Java wrap operations are impossible and emit the
    // corresponding plain JavaScript arithmetic.
    const methodIntegerOrigins = new Map();
    const methodSpecializedCheckedCaptures = {};
    let hasOutlinedClippedLeaf = false;
    const specializedCheckedCapture = (cacheId, position) => {
      const name = `ssaSpecializedCheckedCapture${cacheId}_${position}`;
      const cache = this.jit.checkedLeafCaptureCaches[cacheId];
      methodSpecializedCheckedCaptures[name] =
        cache?.[`specializedValue${position}`];
      return name;
    };
    const continuationFallbacks = new Map();
    const directEntryStaticReadFallbacks = new Map();
    const directCheckedAdmissionFallbacks = new Map();
    const directEntryCheckedAdmissionDeclarations = [];
    const materializeDepths = new Set();
    let deferredCallMaterializationCount = 0;
    let reusedLocalLoadCount = 0;
    let eliminatedLocalStoreCount = 0;
    let sentinelArrayLoadCount = 0;
    let eliminatedArrayStoreCheckCount = 0;
    let specializedArrayRangeAccessCount = 0;
    const specializedArrayRangeAccesses = new Set();
    let dominatedFieldReceiverCheckCount = 0;
    const dominatedFieldReceiverChecks = new Set();
    let dominatedEntryReferenceNullBranchCount = 0;
    const dominatedEntryReferenceNullBranches = new Set();
    let eliminatedTerminalStructuredBreakCount = 0;
    let eliminatedStructuredBlockCount = 0;
    let restoringRangeGuardDeoptCount = 0;
    let restoringCoarseLoopDeoptCount = 0;
    let rangeDominatedArithmeticGuardCount = 0;
    const rangeDominatedArithmeticGuards = new Set();
    const lexicalVoidFastPathSites = new Set();
    const arrayRangeCheckCandidates = [];
    // Keep every primitive entry-array access available to whole-region
    // proofs, including affine local+constant indexes that an ordinary
    // monotonic counted-loop guard cannot prove by itself.  A later proof may
    // version a complete shrinking-window region before its first effect.
    const primitiveArrayAccessCandidates = [];
    let nextPrimitiveArrayAccessMarker = 0;
    const deferredStaticArrayAccesses = [];
    let nextDeferredStaticArrayAccessMarker = 0;
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
    const idempotentStaticReferenceStores = new Set();
    for (const [getIndex, getDirect] of directStaticSites) {
      if (getDirect.op !== "getstatic" ||
          !/^\[(?:Z|B|C|S|I|F|D|J)$/.test(getDirect.descriptor || "")) {
        continue;
      }
      const storeInstruction = items[getIndex + 1]?.instruction;
      const storeOp = opOf(storeInstruction);
      if (!/^astore(?:_[0-3])?$/.test(storeOp)) continue;
      const slot = localIndex(storeInstruction, storeOp);
      const writesToSlot = items.filter((item) => {
        const instruction = item?.instruction;
        const op = opOf(instruction);
        return /^astore(?:_[0-3])?$/.test(op) &&
          localIndex(instruction, op) === slot;
      });
      if (writesToSlot.length !== 1) continue;
      const matchingWrites = [...directStaticSites].filter(
        ([index, direct]) => direct.op === "putstatic" &&
          directLocationEquals(getDirect, direct) &&
          index > 0 && /^aload(?:_[0-3])?$/.test(
            opOf(items[index - 1]?.instruction)) &&
          localIndex(items[index - 1]?.instruction,
            opOf(items[index - 1]?.instruction)) === slot);
      if (matchingWrites.length !== 1 ||
          [...directStaticSites].some(([index, direct]) =>
            direct.op === "putstatic" && index !== matchingWrites[0][0] &&
            directLocationEquals(getDirect, direct))) continue;
      if ([...callFieldWriteSummaries.values()].some((summary) =>
        summary === null || summary?.has(getDirect.key))) continue;
      idempotentStaticReferenceStores.add(getDirect.key);
    }
    const entryStaticReadCaches = new Map();
    const entryStaticReadCacheEnabled =
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_ENTRY_STATIC_READ_CACHE === "1");
    if (entryStaticReadCacheEnabled && !hasUnknownStaticEffect) {
      for (const [index, direct] of directStaticSites) {
        if (direct.op !== "getstatic" ||
            entryStaticWriteKeys.has(direct.key) &&
              !idempotentStaticReferenceStores.has(direct.key) ||
            guardedStaticBooleanSites.has(index)) continue;
        const target = directTargetFor(direct);
        if (!target) continue;
        const key = `${direct.className}\0${direct.key}`;
        let cache = entryStaticReadCaches.get(key);
        if (!cache) {
          const number = entryStaticReadCaches.size;
          cache = {
            direct,
            descriptor: direct.descriptor,
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
          descriptor: plan.descriptor,
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
    const eagerFieldReceiverNullChecks = new Map();
    const entryReferenceLoads = new Map();
    const localLoads = new Map();
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
          descriptor: this.jit.fieldSites[site]?.descriptor || null,
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
    const entryArrayKinds = new Map();
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
          entryArrayKinds.set(entrySlot, ({
            "boolean[]": "[Z", "byte[]": "[B", "char[]": "[C",
            "short[]": "[S", "int[]": "[I", "float[]": "[F",
            "double[]": "[D", "long[]": "[J",
          })[parameterType]);
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
    // These views are rejected by an unconditional generated-entry guard.
    // Eager field arrays are added to guardedEntryArrayData below only so
    // loop preheaders may derive a conditional range proof; a field value can
    // still be null and its checked slow arm must test the raw view before
    // dereferencing it.
    const unconditionallyNonNullEntryArrayData =
      new Set(guardedEntryArrayData);
    const entryStaticArrayData = new Set(
      [...entryStaticReadCaches.values()]
        .map((cache) => cache.data).filter(Boolean));
    const entryStaticArrayLocalViews = new Map();
    const entryStaticArrayLocalInitializers = new Map();
    if ((code.code.exceptionTable || []).length === 0) {
      const entryItems = new Set(cfg.blocks[cfg.entry]?.insns || []);
      const cfgPredecessors = cfg.blocks.map(() => []);
      for (let block = 0; block < cfg.blocks.length; block += 1) {
        for (const successor of cfg.succ[block] || []) {
          if (Number.isInteger(successor)) cfgPredecessors[successor].push(block);
        }
      }
      for (const [index, direct] of directStaticSites) {
        const cache = direct.entryReadCache;
        if (direct.op !== "getstatic" || !cache?.data ||
            !entryItems.has(index) || !entryItems.has(index + 1)) continue;
        const store = items[index + 1]?.instruction;
        const storeOp = opOf(store);
        if (!/^astore(?:_[0-3])?$/.test(storeOp)) continue;
        const slot = localIndex(store, storeOp);
        const stores = [];
        const loads = [];
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          if (!normalReachableItems.has(itemIndex)) continue;
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          if (/^astore(?:_[0-3])?$/.test(op) &&
              localIndex(instruction, op) === slot) stores.push(itemIndex);
          if (/^aload(?:_[0-3])?$/.test(op) &&
              localIndex(instruction, op) === slot) loads.push(itemIndex);
        }
        if (stores.length !== 1 || stores[0] !== index + 1 ||
            !loads.length || loads.some((load) => load <= index + 1)) continue;
        const loopCandidates = [];
        for (let backedge = 0; backedge < cfg.blocks.length; backedge += 1) {
          for (const header of cfg.succ[backedge] || []) {
            const headerItem = cfg.blocks[header]?.insns?.[0];
            const backedgeItem = cfg.blocks[backedge]?.insns?.[0];
            if (Number.isInteger(headerItem) && headerItem > index + 1 &&
                Number.isInteger(backedgeItem) && backedgeItem >= headerItem) {
              loopCandidates.push({header, backedge, headerItem});
            }
          }
        }
        loopCandidates.sort((left, right) => left.headerItem - right.headerItem);
        const firstLoop = loopCandidates[0];
        if (!firstLoop) continue;
        const loopBlocks = new Set([firstLoop.header, firstLoop.backedge]);
        const pending = [firstLoop.backedge];
        while (pending.length) {
          const block = pending.pop();
          for (const predecessor of cfgPredecessors[block] || []) {
            if (loopBlocks.has(predecessor)) continue;
            loopBlocks.add(predecessor);
            if (predecessor !== firstLoop.header) pending.push(predecessor);
          }
        }
        // The local receives the entry static reference exactly once and is
        // never reassigned, so its raw primitive backing remains the same in
        // every block of this invocation even if a callee later replaces the
        // static field.  Extending the view beyond the first natural loop lets
        // the ordinary range analysis cover later state-machine loops.  Any
        // field-backed range candidate disables continuation entry below;
        // canonical scheduler fallback therefore resumes with the actual JVM
        // local instead of recomputing this entry-only cache.
        for (const candidateBlock of cfg.blocks) {
          if (candidateBlock && !candidateBlock.synthetic) {
            loopBlocks.add(candidateBlock.id);
          }
        }
        entryStaticArrayLocalViews.set(slot, {
          data: cache.data,
          descriptor: cache.descriptor,
          blocks: loopBlocks,
        });
        entryStaticArrayLocalInitializers.set(slot, {
          value: cache.value,
          storeIndex: index + 1,
        });
      }
    }
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
    const eagerFieldArrayDataByLocal = new Map();
    for (const cache of fieldReadCaches.values()) {
      if (cache.isArray && cache.eagerLocal !== null &&
          cache.eagerLocal !== undefined) {
        eagerEntryFieldArrayData.add(cache.data);
        guardedEntryArrayData.add(cache.data);
        const arrays = eagerFieldArrayDataByLocal.get(cache.eagerLocal) || [];
        arrays.push(cache.data);
        eagerFieldArrayDataByLocal.set(cache.eagerLocal, arrays);
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
    // The entry-static proof above establishes a unique astore and an
    // already-initialized, entry-cached source. Generated entries reject null
    // array parameters and unresolved classes before executing the body, so
    // this copy is observationally identical when placed in the scalar local
    // declaration. Treat it as an immutable entry value instead of carrying
    // a mutable JVM-local alias through every later loop.
    for (const [slot, initializer] of entryStaticArrayLocalInitializers) {
      entryLocalInitialValues.set(slot, initializer.value);
      foldedEntryStoreIndexes.add(initializer.storeIndex);
    }
    // Forward must-facts for local integer comparisons. This proves common
    // guarded divisions such as `(y - y0) * dx / (y1 - y0)`: either side of
    // an OR-shaped crossing predicate may establish the opposite ordering,
    // but both establish the same unordered non-equality. Facts are killed
    // by local writes and intersected at joins, so no loop-iteration or
    // predecessor-specific assumption can leak into a generated block.
    const dominatedNonZeroDivisionItems = new Set();
    const literalNonZeroDivisionItems = new Set();
    let cfgDominatedArithmeticGuardCount = 0;
    {
      const relationKey = (kind, left, right) =>
        kind === "ne" && left > right
          ? `${kind}:${right}:${left}` : `${kind}:${left}:${right}`;
      const killSlotFacts = (facts, slot) => new Set([...facts].filter((fact) => {
        const [, left, right] = fact.split(":").map((value, index) =>
          index === 0 ? value : Number(value));
        return left !== slot && right !== slot;
      }));
      const closeFacts = (facts) => {
        const slots = new Set();
        const nonEqual = new Set();
        const edges = [];
        for (const fact of facts) {
          const [kind, leftText, rightText] = fact.split(":");
          const left = Number(leftText), right = Number(rightText);
          slots.add(left); slots.add(right);
          if (kind === "ne") nonEqual.add(relationKey("ne", left, right));
          else edges.push({left, right, strict: kind === "lt"});
        }
        const values = [...slots];
        const relation = new Map();
        for (const slot of values) relation.set(`${slot}:${slot}`, false);
        for (const edge of edges) {
          const key = `${edge.left}:${edge.right}`;
          relation.set(key, Boolean(relation.get(key)) || edge.strict);
        }
        for (const middle of values) for (const left of values) {
          const leftMiddle = relation.get(`${left}:${middle}`);
          if (leftMiddle === undefined) continue;
          for (const right of values) {
            const middleRight = relation.get(`${middle}:${right}`);
            if (middleRight === undefined) continue;
            const key = `${left}:${right}`;
            const strict = leftMiddle || middleRight;
            if (!relation.has(key) || strict && !relation.get(key)) {
              relation.set(key, strict);
            }
          }
        }
        const closed = new Set(nonEqual);
        for (const [pair, strict] of relation) {
          const [left, right] = pair.split(":").map(Number);
          if (left === right) continue;
          closed.add(relationKey(strict ? "lt" : "le", left, right));
          if (strict) closed.add(relationKey("ne", left, right));
        }
        return closed;
      };
      const localLoadSlot = (instruction) => {
        const op = opOf(instruction);
        return /^iload(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const writtenLocalSlot = (instruction) => {
        const op = opOf(instruction);
        if (op === "iinc") return Number(instruction.varnum ?? instruction.arg);
        return /^istore(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const branchFacts = (block, taken) => {
        const blockItems = block.insns || [];
        const branch = items[blockItems.at(-1)]?.instruction;
        const op = opOf(branch);
        if (!/^if_icmp(?:eq|ne|lt|le|gt|ge)$/.test(op) ||
            blockItems.length < 3) return [];
        const left = localLoadSlot(items[blockItems.at(-3)]?.instruction);
        const right = localLoadSlot(items[blockItems.at(-2)]?.instruction);
        if (!Number.isInteger(left) || !Number.isInteger(right)) return [];
        const selected = taken ? op : ({
          if_icmpeq: "if_icmpne", if_icmpne: "if_icmpeq",
          if_icmplt: "if_icmpge", if_icmpge: "if_icmplt",
          if_icmpgt: "if_icmple", if_icmple: "if_icmpgt",
        })[op];
        if (selected === "if_icmpne") return [relationKey("ne", left, right)];
        if (selected === "if_icmplt") return [relationKey("lt", left, right)];
        if (selected === "if_icmple") return [relationKey("le", left, right)];
        if (selected === "if_icmpgt") return [relationKey("lt", right, left)];
        if (selected === "if_icmpge") return [relationKey("le", right, left)];
        return [];
      };
      const inputs = new Map([[cfg.entry, new Set()]]);
      const work = [cfg.entry];
      while (work.length) {
        const blockId = work.shift();
        const block = cfg.blocks[blockId];
        if (!block || block.synthetic) continue;
        let facts = new Set(inputs.get(blockId) || []);
        for (const itemIndex of block.insns || []) {
          const written = writtenLocalSlot(items[itemIndex]?.instruction);
          if (Number.isInteger(written)) facts = killSlotFacts(facts, written);
        }
        const term = cfg.term[blockId];
        for (const successor of cfg.succ[blockId] || []) {
          let outgoing = new Set(facts);
          if (term?.kind === "cond") {
            const taken = successor === term.taken;
            for (const fact of branchFacts(block, taken)) outgoing.add(fact);
            outgoing = closeFacts(outgoing);
          }
          const previous = inputs.get(successor);
          const merged = previous === undefined ? outgoing :
            new Set([...previous].filter((fact) => outgoing.has(fact)));
          if (previous === undefined || merged.size !== previous.size ||
              [...merged].some((fact) => !previous.has(fact))) {
            inputs.set(successor, merged);
            work.push(successor);
          }
        }
      }
      for (const block of cfg.blocks) {
        if (!block || block.synthetic || !inputs.has(block.id)) continue;
        let facts = new Set(inputs.get(block.id));
        const blockItems = block.insns || [];
        for (let position = 0; position < blockItems.length; position += 1) {
          const itemIndex = blockItems[position];
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          if ((op === "idiv" || op === "irem") && position >= 3 &&
              opOf(items[blockItems[position - 1]]?.instruction) === "isub") {
            const left = localLoadSlot(
              items[blockItems[position - 3]]?.instruction);
            const right = localLoadSlot(
              items[blockItems[position - 2]]?.instruction);
            if (Number.isInteger(left) && Number.isInteger(right) &&
                facts.has(relationKey("ne", left, right))) {
              dominatedNonZeroDivisionItems.add(itemIndex);
            }
          }
          const written = writtenLocalSlot(instruction);
          if (Number.isInteger(written)) facts = killSlotFacts(facts, written);
        }
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
    const materializationLocalValuesByPc = new Map();
    let currentMaterializationLocalValues = null;
    const materializeLines = (operandValues, pc) => {
      if (currentMaterializationLocalValues) {
        materializationLocalValuesByPc.set(
          pc, [...currentMaterializationLocalValues]);
      }
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

    // A scalar SSA value already records the exact value written to a JVM
    // local. In handler-free methods, a store whose slot is dead after that
    // bytecode need not also update the mutable JavaScript `localN` mirror:
    // precise cold materialization below rematerializes from the SSA value.
    // Normal-flow liveness is sufficient only when there are no exception
    // edges; methods with handlers conservatively retain every local store.
    const liveLocalsOutByBlock = cfg.blocks.map(() => null);
    if ((code.code.exceptionTable || []).length === 0 &&
        dispatchIslands === 0 && splitBlocks === 0) {
      const localUseDef = (instruction) => {
        const op = opOf(instruction);
        if (/^[adfil]load(?:_[0-3])?$/.test(op || "")) {
          return {uses: [localIndex(instruction, op)], defs: []};
        }
        if (/^[adfil]store(?:_[0-3])?$/.test(op || "")) {
          return {uses: [], defs: [localIndex(instruction, op)]};
        }
        if (op === "iinc") {
          const slot = Number(instruction.varnum ?? instruction.arg);
          return {uses: [slot], defs: [slot]};
        }
        if (op === "ret") {
          return {uses: [Number(instruction.arg)], defs: []};
        }
        return {uses: [], defs: []};
      };
      const blockUses = cfg.blocks.map(() => new Set());
      const blockDefs = cfg.blocks.map(() => new Set());
      for (const candidateBlock of cfg.blocks) {
        if (!candidateBlock || candidateBlock.synthetic) continue;
        const uses = blockUses[candidateBlock.id];
        const defs = blockDefs[candidateBlock.id];
        for (const itemIndex of candidateBlock.insns || []) {
          const flow = localUseDef(items[itemIndex]?.instruction);
          for (const slot of flow.uses) {
            if (Number.isInteger(slot) && !defs.has(slot)) uses.add(slot);
          }
          for (const slot of flow.defs) {
            if (Number.isInteger(slot)) defs.add(slot);
          }
        }
      }
      const liveIn = cfg.blocks.map(() => new Set());
      const liveOut = cfg.blocks.map(() => new Set());
      let changed = true;
      while (changed) {
        changed = false;
        for (let blockId = cfg.blocks.length - 1;
          blockId >= 0; blockId -= 1) {
          const candidateBlock = cfg.blocks[blockId];
          if (!candidateBlock || candidateBlock.synthetic) continue;
          const nextOut = new Set();
          for (const successor of cfg.succ[blockId] || []) {
            for (const slot of liveIn[successor] || []) nextOut.add(slot);
          }
          const nextIn = new Set(blockUses[blockId]);
          for (const slot of nextOut) {
            if (!blockDefs[blockId].has(slot)) nextIn.add(slot);
          }
          const differs = (left, right) => left.size !== right.size ||
            [...left].some((slot) => !right.has(slot));
          if (differs(nextOut, liveOut[blockId]) ||
              differs(nextIn, liveIn[blockId])) {
            liveOut[blockId] = nextOut;
            liveIn[blockId] = nextIn;
            changed = true;
          }
        }
      }
      for (let blockId = 0; blockId < liveOut.length; blockId += 1) {
        liveLocalsOutByBlock[blockId] = liveOut[blockId];
      }
    }
    let eliminatedDeadLocalStoreCount = 0;
    const boundedLocalDefinitionRangeMemo = new Map();
    const bytecodeIntegerConstant = (instruction) => {
      const op = opOf(instruction);
      if (op === "iconst_m1") return -1;
      const iconst = /^iconst_([0-5])$/.exec(op || "");
      if (iconst) return Number(iconst[1]);
      if (op === "bipush" || op === "sipush" ||
          op === "ldc" || op === "ldc_w") {
        const value = Number(instruction?.arg);
        return Number.isInteger(value) ? value | 0 : null;
      }
      return null;
    };
    const boundedLocalDefinitionRange = (slot, visiting = new Set()) => {
      if (boundedLocalDefinitionRangeMemo.has(slot)) {
        return boundedLocalDefinitionRangeMemo.get(slot);
      }
      if (visiting.has(slot)) return null;
      const nextVisiting = new Set(visiting);
      nextVisiting.add(slot);
      const definitions = [];
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        if (!normalReachableItems.has(itemIndex)) continue;
        const instruction = items[itemIndex]?.instruction;
        const op = opOf(instruction);
        const written = op === "iinc"
          ? Number(instruction.varnum ?? instruction.arg)
          : /^istore(?:_[0-3])?$/.test(op)
            ? localIndex(instruction, op) : null;
        if (written === slot) definitions.push({itemIndex, op});
      }
      if (definitions.length !== 1 || definitions[0].op === "iinc") {
        boundedLocalDefinitionRangeMemo.set(slot, null);
        return null;
      }
      const parseBefore = (cursor, depth = 0) => {
        if (depth > 32) return null;
        let itemIndex = cursor - 1;
        while (itemIndex >= 0 && ["nop"].includes(
          opOf(items[itemIndex]?.instruction))) itemIndex -= 1;
        if (itemIndex < 0) return null;
        const instruction = items[itemIndex]?.instruction;
        const op = opOf(instruction);
        const constant = bytecodeIntegerConstant(instruction);
        if (constant !== null) {
          return {start: itemIndex,
            range: {minimum: constant, maximum: constant}};
        }
        if (/^iload(?:_[0-3])?$/.test(op)) {
          return {
            start: itemIndex,
            range: boundedLocalDefinitionRange(
              localIndex(instruction, op), nextVisiting),
          };
        }
        if (op === "ineg") {
          const input = parseBefore(itemIndex, depth + 1);
          if (!input) return null;
          const range = input.range && input.range.minimum !== -2147483648
            ? {minimum: -input.range.maximum,
              maximum: -input.range.minimum} : null;
          return {start: input.start, range};
        }
        const binaryOps = new Set([
          "iadd", "isub", "imul", "irem", "iand",
        ]);
        if (!binaryOps.has(op)) return null;
        const right = parseBefore(itemIndex, depth + 1);
        if (!right) return null;
        const left = parseBefore(right.start, depth + 1);
        if (!left) return null;
        let range = null;
        if (op === "irem" && right.range &&
            right.range.minimum === right.range.maximum &&
            right.range.minimum !== 0) {
          const limit = Math.abs(right.range.minimum) - 1;
          range = left.range ? {
            minimum: Math.max(-limit, left.range.minimum),
            maximum: Math.min(limit, left.range.maximum),
          } : {minimum: -limit, maximum: limit};
        } else if (op === "iand") {
          const mask = left.range && left.range.minimum === left.range.maximum
            ? left.range.minimum
            : right.range && right.range.minimum === right.range.maximum
              ? right.range.minimum : null;
          if (Number.isInteger(mask) && mask >= 0) {
            range = {minimum: 0, maximum: mask};
          }
        } else if (left.range && right.range) {
          let minimum;
          let maximum;
          if (op === "iadd") {
            minimum = left.range.minimum + right.range.minimum;
            maximum = left.range.maximum + right.range.maximum;
          } else if (op === "isub") {
            minimum = left.range.minimum - right.range.maximum;
            maximum = left.range.maximum - right.range.minimum;
          } else if (op === "imul") {
            const products = [
              left.range.minimum * right.range.minimum,
              left.range.minimum * right.range.maximum,
              left.range.maximum * right.range.minimum,
              left.range.maximum * right.range.maximum,
            ];
            minimum = Math.min(...products);
            maximum = Math.max(...products);
          }
          if (minimum >= -2147483648 && maximum <= 2147483647) {
            range = {minimum, maximum};
          }
        }
        return {start: left.start, range};
      };
      const parsed = parseBefore(definitions[0].itemIndex);
      const range = parsed?.range || null;
      boundedLocalDefinitionRangeMemo.set(slot, range);
      return range;
    };

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
      const arrayKinds = new Map();
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
      currentMaterializationLocalValues = localValues;
      const readLocal = (slot) => {
        const cached = localValues[slot];
        if (this.localValueNumberingEnabled && cached !== null) {
          reusedLocalLoadCount += 1;
          // Even when the current local value already has an SSA name, this
          // bytecode load establishes the symbolic local slot used by loop
          // recurrence and range analysis.
          // A store may have assigned this block-local SSA value a more
          // precise arithmetic origin (for example, a signed shift). Preserve
          // that proof across a subsequent load; use the symbolic local only
          // when the value arrived from a join/entry without an expression.
          if (!integerOrigins.has(cached)) {
            const origin = {kind: "local", slot};
            integerOrigins.set(cached, origin);
            methodIntegerOrigins.set(cached, origin);
          }
          localLoads.set(cached, slot);
          if (entryArrayLocalSlots.has(slot)) {
            arrayViews.set(cached, entryArrayDataVariable(slot));
            if (entryArrayKinds.has(slot)) {
              arrayKinds.set(cached, entryArrayKinds.get(slot));
            }
          }
          const staticArrayView = entryStaticArrayLocalViews.get(slot);
          if (staticArrayView?.blocks.has(block.id)) {
            arrayViews.set(cached, staticArrayView.data);
            arrayKinds.set(cached, staticArrayView.descriptor);
          }
          if (entryReferenceLocalSlots.has(slot) &&
              !assignedReferenceLocals.has(slot)) {
            entryReferenceLoads.set(cached, slot);
          }
          return cached;
        }
        const out = value();
        lines.push(`const ${out} = local${slot};`);
        const origin = {kind: "local", slot};
        integerOrigins.set(out, origin);
        methodIntegerOrigins.set(out, origin);
        localLoads.set(out, slot);
        if (entryArrayLocalSlots.has(slot)) {
          arrayViews.set(out, entryArrayDataVariable(slot));
          if (entryArrayKinds.has(slot)) {
            arrayKinds.set(out, entryArrayKinds.get(slot));
          }
        }
        const staticArrayView = entryStaticArrayLocalViews.get(slot);
        if (staticArrayView?.blocks.has(block.id)) {
          arrayViews.set(out, staticArrayView.data);
          arrayKinds.set(out, staticArrayView.descriptor);
        }
        if (entryReferenceLocalSlots.has(slot) &&
            !assignedReferenceLocals.has(slot)) {
          entryReferenceLoads.set(out, slot);
        }
        if (this.localValueNumberingEnabled) localValues[slot] = out;
        return out;
      };
      const copyValueMetadata = (source, target) => {
        if (arrayViews.has(source)) {
          arrayViews.set(target, arrayViews.get(source));
        }
        if (arrayKinds.has(source)) {
          arrayKinds.set(target, arrayKinds.get(source));
        }
        if (integerOrigins.has(source)) {
          const origin = integerOrigins.get(source);
          integerOrigins.set(target, origin);
          methodIntegerOrigins.set(target, origin);
        }
        if (localLoads.has(source)) {
          localLoads.set(target, localLoads.get(source));
        }
        if (entryReferenceLoads.has(source)) {
          entryReferenceLoads.set(target, entryReferenceLoads.get(source));
        }
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
          const origin = {kind: originOp, left, right};
          integerOrigins.set(out, origin);
          methodIntegerOrigins.set(out, origin);
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
        if (origin.kind === "local") {
          return boundedLocalDefinitionRange(origin.slot);
        }
        const left = boundedIntegerRange(origin.left, new Set(visited));
        const right = boundedIntegerRange(origin.right, new Set(visited));
        if (origin.kind === "irem" && right &&
            right.minimum === right.maximum && right.minimum !== 0) {
          const magnitude = Math.abs(right.minimum);
          if (magnitude <= 2147483648) {
            const limit = magnitude - 1;
            if (left) {
              return {
                minimum: Math.max(-limit, left.minimum),
                maximum: Math.min(limit, left.maximum),
              };
            }
            return {minimum: -limit, maximum: limit};
          }
        }
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
        if (origin.kind === "ishr") {
          if (!right || right.minimum !== right.maximum) return null;
          const shift = right.minimum & 31;
          if (shift === 0) return null;
          return {
            minimum: -(2 ** (31 - shift)),
            maximum: (2 ** (31 - shift)) - 1,
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
      const affineLocalOffset = (input, visited = new Set()) => {
        if (/^-?\d+$/.test(input)) {
          const offset = Number(input);
          return Number.isSafeInteger(offset)
            ? {slot: null, offset, baseExpression: null} : null;
        }
        if (visited.has(input)) return null;
        visited.add(input);
        const origin = integerOrigins.get(input);
        if (!origin) return null;
        if (origin.kind === "local") {
          return {slot: origin.slot, offset: 0, baseExpression: input};
        }
        if (origin.kind !== "iadd" && origin.kind !== "isub") return null;
        const left = affineLocalOffset(origin.left, new Set(visited));
        const right = affineLocalOffset(origin.right, new Set(visited));
        if (!left || !right) return null;
        if (origin.kind === "isub" && right.slot !== null) return null;
        if (left.slot !== null && right.slot !== null) return null;
        const offset = origin.kind === "iadd"
          ? left.offset + right.offset : left.offset - right.offset;
        if (!Number.isSafeInteger(offset) || offset < -2147483648 ||
            offset > 2147483647) return null;
        return {
          slot: left.slot ?? right.slot,
          offset,
          baseExpression: left.slot !== null
            ? left.baseExpression : right.baseExpression,
        };
      };
      const arrayRangeMarkerFor = (
        arrayData, indexInput, itemIndex, arrayOp, store,
      ) => {
        // A loop preheader may only name storage views declared at generated
        // entry. Block-local snapshots (including non-eager field caches) are
        // not in lexical scope yet, and field-cache views can also be cleared
        // at a continuation safe point. Keep those accesses on the checked
        // sentinel path rather than emitting a preheader proof that references
        // a missing or stale SSA value.
        if (!arrayData || !guardedEntryArrayData.has(arrayData)) return "false";
        const access = {
          block: block.id,
          itemIndex,
          arrayData,
          indexInput,
          indexAffine: affineLocalOffset(indexInput),
          op: arrayOp,
          store: Boolean(store),
          marker: `__SSA_PRIMITIVE_ARRAY_ACCESS_${
            nextPrimitiveArrayAccessMarker++}__`,
        };
        primitiveArrayAccessCandidates.push(access);
        const fixedRange = this.bitBoundedArrayRangesEnabled
          ? boundedIntegerRange(indexInput) : null;
        const indexOrigin = integerOrigins.get(indexInput);
        const leftOrigin = indexOrigin?.kind === "iadd"
          ? integerOrigins.get(indexOrigin.left) : null;
        const rightOrigin = indexOrigin?.kind === "iadd"
          ? integerOrigins.get(indexOrigin.right) : null;
        // Local value numbering can retain the arithmetic provenance of a
        // value across istore/iload. Range relations still need the symbolic
        // JVM slots (for example derived + invariantOffset), which readLocal
        // records independently of that more precise arithmetic origin.
        const leftLocalSlot = indexOrigin?.kind === "iadd"
          ? localLoads.get(indexOrigin.left) ??
            (leftOrigin?.kind === "local" ? leftOrigin.slot : null)
          : null;
        const rightLocalSlot = indexOrigin?.kind === "iadd"
          ? localLoads.get(indexOrigin.right) ??
            (rightOrigin?.kind === "local" ? rightOrigin.slot : null)
          : null;
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
        } else if (Number.isInteger(leftLocalSlot) &&
            Number.isInteger(rightLocalSlot)) {
          candidate = {
            kind: "base-plus-induction",
            block: block.id,
            itemIndex,
            arrayData,
            slots: [leftLocalSlot, rightLocalSlot],
          };
        } else if (Number.isInteger(access.indexAffine?.slot)) {
          candidate = {
            kind: "affine-local",
            block: block.id,
            itemIndex,
            arrayData,
            slots: [access.indexAffine.slot],
            offset: access.indexAffine.offset,
          };
        }
        if (!candidate) return access.marker;
        Object.assign(candidate, access);
        candidate.primitiveAccess = access;
        access.rangeCandidate = candidate;
        arrayRangeCheckCandidates.push(candidate);
        return candidate.marker;
      };
      const deferredStaticArrayAccessFor = (
        arrayInput, indexInput, itemIndex, directLines,
      ) => {
        const view = entryStaticArrayLocalViews.get(
          localLoads.get(arrayInput));
        if (!view || view.blocks.has(block.id) ||
            !Number.isInteger(itemIndex)) return null;
        const marker = `__SSA_DEFERRED_STATIC_ARRAY_ACCESS_${
          nextDeferredStaticArrayAccessMarker++}__`;
        const access = {
          block: block.id,
          itemIndex,
          arrayData: view.data,
          indexAffine: affineLocalOffset(indexInput),
          marker,
          directLines,
        };
        deferredStaticArrayAccesses.push(access);
        return access;
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
            else if (liveLocalsOutByBlock[block.id] &&
                !liveLocalsOutByBlock[block.id].has(slot)) {
              eliminatedLocalStoreCount += 1;
              eliminatedDeadLocalStoreCount += 1;
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
            copyValueMetadata(input, out);
          }
        } else if (op === "dup2") {
          // The interpreter and generated tiers treat dup2 as the two
          // category-1 form unless the top is a BigInt long; mirror that and
          // fall back before any effect when a long is observed.
          const topInput = pop(), underInput = pop();
          if (topInput === null || underInput === null) valid = false;
          else {
            const top = value(), under = value();
            const widths = verifiedStackWidthsBefore?.get(index) || [];
            const categoryOnePair = widths.length >= 2 &&
              widths.at(-1) === 1 && widths.at(-2) === 1;
            lines.push(`const ${top} = ${topInput};`,
              `const ${under} = ${underInput};`);
            if (!categoryOnePair) {
              lines.push(`if (typeof ${top} === "bigint") {`,
                ...materializeLines([...stack, under, top], index)
                  .map((line) => `  ${line}`),
                "  helpers.skipJitOnce(frame);",
                "  return { deopt: true, transient: true, " +
                  "reason: 'category-2 dup2 in structured SSA' };", "}");
            }
            copyValueMetadata(topInput, top);
            copyValueMetadata(underInput, under);
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
        else if (op === "ishr") {
          binary((a, b) => `(${a} >> (${b} & 31))`, "ishr");
        }
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
            const literalDivisor = /^-?\d+$/.test(divisorInput)
              ? Number(divisorInput) : 0;
            if (literalDivisor !== 0) {
              literalNonZeroDivisionItems.add(index);
              cfgDominatedArithmeticGuardCount += 1;
            } else if (dominatedNonZeroDivisionItems.has(index)) {
              cfgDominatedArithmeticGuardCount += 1;
            } else {
              lines.push(`if (${divisor} === 0) {`,
                ...materializeLines([...stack, dividend, divisor], index).map((line) => `  ${line}`),
                '  throw { type: "java/lang/ArithmeticException", message: "/ by zero" };', "}");
            }
            lines.push(`const ${out} = ((${dividend} ${op === "idiv" ? "/" : "%"} ${divisor}) | 0);`);
            const origin = {
              kind: op,
              left: dividendInput,
              right: divisorInput,
            };
            integerOrigins.set(out, origin);
            methodIntegerOrigins.set(out, origin);
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
            lines.push(`const ${out} = (${previous} + ${increment}) | 0;`);
            if (liveLocalsOutByBlock[block.id] &&
                !liveLocalsOutByBlock[block.id].has(slot)) {
              eliminatedDeadLocalStoreCount += 1;
              eliminatedLocalStoreCount += 1;
            } else lines.push(`local${slot} = ${out};`);
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
            const deferredStaticView = !arrayData
              ? entryStaticArrayLocalViews.get(localLoads.get(arrayInput))
              : null;
            const arrayKind = this.staticPrimitiveArrayKindsEnabled
              ? arrayKinds.get(arrayInput) ||
                deferredStaticView?.descriptor || null : null;
            const primitiveSentinel = op !== "aaload" && arrayData;
            lines.push(`const ${array} = ${arrayInput};`, `const ${arrayIndex} = ${arrayIndexInput};`,
              `let ${out};`);
            if (primitiveSentinel) {
              const normalized = normalizedArrayLoadExpression(
                out, op, array, arrayKind);
              const rangeMarker =
                arrayRangeMarkerFor(
                  arrayData, arrayIndexInput, index, op, false);
              const loadFailure =
                unconditionallyNonNullEntryArrayData.has(arrayData)
                ? `((${out} = ${arrayData}[${arrayIndex}]) === undefined)`
                : `(${arrayData} === null || ` +
                  `(${out} = ${arrayData}[${arrayIndex}]) === undefined)`;
              const provenLoad = normalizedArrayLoadExpression(
                `${arrayData}[${arrayIndex}]`, op, array, arrayKind);
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
              const normalized = normalizedArrayLoadExpression(
                raw, op, array, arrayKind);
              const deferred = deferredStaticView && op !== "aaload"
                ? deferredStaticArrayAccessFor(
                  arrayInput, arrayIndexInput, index, [
                    `${out} = ${normalizedArrayLoadExpression(
                      `${deferredStaticView.data}[${arrayIndex}]`,
                      op, array, arrayKind)};`,
                  ]) : null;
              if (deferred) lines.push(`/*${deferred.marker}:start*/`);
              lines.push(
                  `if (${array} === null || ${array} === undefined || ${
                    arrayIndexOutOfBounds(arrayIndex, `${array}.length`)}) {`,
                  ...materializeLines([...stack, array, arrayIndex], index).map((line) => `  ${line}`),
                  `  ${out} = helpers.arrayLoad(${arrayIndex}, ${array}, frame, ${JSON.stringify(op)});`,
                  "} else {", `  ${out} = ${normalized};`, "}",
              );
              if (deferred) lines.push(`/*${deferred.marker}:end*/`);
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
            const deferredStaticView = !arrayData
              ? entryStaticArrayLocalViews.get(localLoads.get(arrayInput))
              : null;
            const arrayKind = this.staticPrimitiveArrayKindsEnabled
              ? arrayKinds.get(arrayInput) ||
                deferredStaticView?.descriptor || null : null;
            lines.push(`const ${array} = ${arrayInput};`, `const ${arrayIndex} = ${arrayIndexInput};`,
              `const ${stored} = ${storedInput};`);
            // The opcode fixes primitive narrowing. Keep it in the generated
            // block instead of crossing a generic helper boundary per element.
            // `bastore` retains its runtime [B/[Z distinction; all other
            // primitive kinds are determined completely by the opcode.
            const normalizedStore = this.inlinePrimitiveArrayStoresEnabled
              ? normalizedArrayStoreExpression(stored, op, array, arrayKind)
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
                arrayRangeMarkerFor(
                  arrayData, arrayIndexInput, index, op, true);
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
              const deferred = deferredStaticView && op !== "aastore"
                ? deferredStaticArrayAccessFor(
                  arrayInput, arrayIndexInput, index, [
                    `${deferredStaticView.data}[${arrayIndex}] = ` +
                      `${normalizedStore};`,
                  ]) : null;
              if (deferred) lines.push(`/*${deferred.marker}:start*/`);
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
              if (deferred) lines.push(`/*${deferred.marker}:end*/`);
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
                if (cache.isArray && cache.data) {
                  eagerFieldReceiverNullChecks.set(object, cache.data);
                }
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
              const descriptor = this.jit.fieldSites[site]?.descriptor;
              if (descriptor?.startsWith("[")) {
                arrayKinds.set(out, descriptor);
              }
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
              if (direct.descriptor?.startsWith("[")) {
                arrayKinds.set(entryCache.value, direct.descriptor);
              }
              continue;
            }
            const key = JSON.stringify(direct.key);
            const location = `${direct.className}\0${direct.key}`;
            const cached = directStaticBlockValues.get(location);
            if (cached) {
              stack.push(cached.value);
              if (cached.data) arrayViews.set(cached.value, cached.data);
              if (direct.descriptor?.startsWith("[")) {
                arrayKinds.set(cached.value, direct.descriptor);
              }
            } else {
              lines.push(`const ${out} = ${direct.kind === "map"
                ? `${direct.variable}.get(${key})` : `${direct.variable}[${key}]`};`);
              stack.push(out);
              let data = null;
              if (direct.descriptor?.startsWith("[")) {
                data = value();
                lines.push(`const ${data} = helpers.arrayData(${out});`);
                arrayViews.set(out, data);
                arrayKinds.set(out, direct.descriptor);
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
            const descriptor = this.jit.fieldSites[site]?.descriptor;
            if (descriptor?.startsWith("[")) arrayKinds.set(out, descriptor);
          }
        } else if (op === "putstatic") {
          directStaticBlockValues.clear();
          const input = pop(), site = fieldSites.get(index), direct = directStaticSites.get(index),
            changed = value();
          if (input === null || site === undefined) valid = false;
          else if (direct) lines.push(
            `${direct.variable}.set(${JSON.stringify(direct.key)}, ${input});`,
            `if (helpers.directStaticTargets[${direct.targetId}].versionCell` +
              `.captureCaches) helpers.markStaticTargetChanged(` +
              `helpers.directStaticTargets[${direct.targetId}]);`);
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
            const callStack = [...stack];
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
                ...site.inline.statements.map((statement) => `  ${substitute(statement)}`));
              if (site.inline.guards?.length) {
                const guard = site.inline.guards
                  .map((condition) => substitute(condition))
                  .join(" && ");
                lines.push(`  if (!(${guard})) {`,
                  ...materializeLines(callStack, index)
                    .map((line) => `    ${line}`),
                  "    helpers.skipJitOnce(frame);",
                  "    return { deopt: true, transient: true, reason: 'guarded inline integer leaf' };",
                  "  }");
              }
              lines.push(`  ${out} = ${substitute(site.inline.result)};`, "}");
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
          } else if (!site.selfRecursive && site.directFused &&
              site.directFused.returnsVoid &&
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
            const positionalArgumentArrayData = args.map((argument) => {
              const data = arrayViews.get(argument) ||
                entryStaticArrayLocalViews.get(
                  localLoads.get(argument))?.data || null;
              return data ? {
                data,
                nonNull: unconditionallyNonNullEntryArrayData.has(data),
              } : null;
            });
            const out = value(), caught = value();
            let inlineCheckedLeafVoidFastPath = false;
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
                checkedLeaf: ["return helpers.asyncInvokeSentinel();"],
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
            const checkedAdmissionPlan = site.returnsVoid &&
              site.directCheckedLeaf?.noThrow === true &&
              ["record-window", "clipped-affine-fill"].includes(
                site.directCheckedLeaf?.admissionPlan?.kind)
              ? site.directCheckedLeaf.admissionPlan : null;
            const checkedAdmissionStart = checkedAdmissionPlan
              ? `/*__SSA_CHECKED_ADMISSION_START_${index}__*/` : null;
            const checkedAdmissionEnd = checkedAdmissionPlan
              ? `/*__SSA_CHECKED_ADMISSION_END_${index}__*/` : null;
            if (checkedAdmissionStart) lines.push(checkedAdmissionStart);
            if (site.selfRecursive) {
              lines.push(`/*__SSA_SELF_RECURSIVE_REGION_START_${index}__*/`);
            }
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
              const directCheckedLeafNoThrow =
                site.directCheckedLeaf?.noThrow === true;
              const inlineCheckedLeafSource =
                directCheckedLeafNoThrow &&
                typeof site.directCheckedLeaf?.inlineSource === "string"
                  ? site.directCheckedLeaf.inlineSource : null;
              const inlineCheckedLeafReturnExpressions = inlineCheckedLeafSource
                ? [...inlineCheckedLeafSource.matchAll(/\breturn\s+([^;]+);/g)]
                  .map((match) => match[1].trim()) : [];
              const inlineCheckedLeafVoid = Boolean(
                inlineCheckedLeafSource && site.returnsVoid &&
                inlineCheckedLeafReturnExpressions.length > 0 &&
                inlineCheckedLeafReturnExpressions.every((expression) =>
                  expression === "helpers.returnVoid()" ||
                  expression === "helpers.asyncInvokeSentinel()"),
              );
              if (inlineCheckedLeafVoid) lexicalVoidFastPathSites.add(index);
              inlineCheckedLeafVoidFastPath = inlineCheckedLeafVoid;
              const inlineCheckedLeafLabel =
                `ssaInlineCheckedLeaf${index}`;
              const inlineCheckedLeafFallbackMarker =
                `__JVM_INLINE_CHECKED_LEAF_FALLBACK_${index}_${site.id}__`;
              const inlineCheckedLeafLines = inlineCheckedLeafSource
                ? (() => {
                  let childLines = inlineCheckedLeafSource.split("\n")
                    .filter((line) => line.trim() !== "'use strict';");
                  // The caller's initialization guard covers the child owner
                  // and every captured static owner. Avoid repeating the same
                  // epoch/debug predicate on each lexical call inside a loop.
                  if (/^const ssaRestoringClassInitializationGuard =/.test(
                    childLines[0] || "") &&
                      /^if \(.+ssaRestoringClassInitializationGuard/.test(
                        childLines[1] || "")) {
                    childLines = childLines.slice(2);
                  }
                  // Child JVM locals occupy a separate frame namespace. Give
                  // them distinct JavaScript identifiers before substituting
                  // caller arguments, so parent locals introduced by those
                  // expressions are not accidentally renamed and host SSA
                  // analysis does not have to reason about shadowed names.
                  childLines = childLines.map((line) => line.replace(
                    /\blocal(\d+)\b/g,
                    (_name, slot) => `ssaInlineLocal${index}_${slot}`));
                  const fedNonNullEntryArrays = new Set();
                  childLines = childLines.map((line) => {
                    let rewritten = line;
                    const entryArray = /^([\s]*)const (ssaEntryArrayData\d+) = helpers\.arrayData\(argument(\d+)\);$/.exec(
                      rewritten);
                    if (entryArray) {
                      const argument = Number(entryArray[3]);
                      const view = positionalArgumentArrayData[argument];
                      if (view) {
                        rewritten = entryArray[2] === view.data
                          ? ""
                          : `${entryArray[1]}const ${entryArray[2]} = ${view.data};`;
                        if (view.nonNull) {
                          fedNonNullEntryArrays.add(entryArray[2]);
                        }
                      }
                    }
                    if (!rewritten) return "";
                    const nullGuard = /^\s*if \((ssaEntryArrayData\d+) === null\) \{ return helpers\.asyncInvokeSentinel\(\); \}$/.exec(
                      rewritten);
                    if (nullGuard &&
                        fedNonNullEntryArrays.has(nullGuard[1])) return "";
                    for (let argument = args.length - 1;
                      argument >= 0; argument -= 1) {
                      rewritten = rewritten.replace(
                        new RegExp(`\\bargument${argument}\\b`, "g"),
                        `(${args[argument]})`);
                    }
                    for (let capture = positionalRawCaptures.length - 1;
                      capture >= 0; capture -= 1) {
                      rewritten = rewritten.replace(
                        new RegExp(`\\bssaCapturedStatic${capture}\\b`, "g"),
                        `(${positionalRawCaptures[capture]})`);
                    }
                    rewritten = rewritten.replace(
                      /\bnestedEntryGuarded\b/g, "true");
                    return rewritten.replace(
                      /\breturn\s+([^;]+);/g,
                      (_return, expression) => {
                        if (!inlineCheckedLeafVoid) {
                          return `{ ${out} = ${expression}; ` +
                            `break ${inlineCheckedLeafLabel}; }`;
                        }
                        const success = expression.trim() ===
                          "helpers.returnVoid()";
                        return `{ ${out} = ${success}; ` +
                          `break ${inlineCheckedLeafLabel}; }`;
                      });
                  }).filter(Boolean);
                  // Captured values already have caller-local SSA names.
                  // Substitute the child's entry aliases, and remove
                  // per-entry accounting/safe-point bookkeeping: a lexical
                  // inline is part of the parent entry and its checked loop
                  // has already been bounded before publication.
                  const aliases = new Map();
                  childLines = childLines.filter((line) => {
                    const alias = /^const (ssaEntryStatic(?:ArrayData|Value)\d+) = (.+);$/.exec(
                      line.trim());
                    if (!alias) return true;
                    aliases.set(alias[1], alias[2]);
                    return false;
                  });
                  if (aliases.size) {
                    childLines = childLines.map((line) => line.replace(
                      /\bssaEntryStatic(?:ArrayData|Value)\d+\b/g,
                      (name) => aliases.get(name) || name));
                  }
                  childLines = childLines.filter((line) =>
                    !line.includes(
                      "helpers.structuredSsa.restoringDirectRunCount += 1;") &&
                    !/^let safePointBudget = \d+;$/.test(line.trim()) &&
                    !/^if \(.+\) safePointBudget -= .+;$/.test(line.trim()));
                  return compactOneUseGuardTemporaries(childLines);
                })() : null;
              const provenInlineCheckedLeafLines =
                checkedAdmissionPlan && inlineCheckedLeafLines
                  ? (() => {
                    const trusted = [...inlineCheckedLeafLines];
                    if (checkedAdmissionPlan.kind === "record-window") {
                      const guard = checkedAdmissionPlan.guardVariable;
                      if (typeof guard !== "string") return null;
                      const guardDeclaration = trusted.findIndex((line) =>
                        new RegExp(`\\b(?:let|const) ${guard} = `).test(line));
                      const guardFailure = trusted.findIndex((line, lineIndex) =>
                        lineIndex > guardDeclaration &&
                        line.includes(`if (!${guard})`) &&
                        line.includes(`${out} = false`));
                      if (guardDeclaration < 0 || guardFailure < 0) return null;
                      let admissionStart = guardDeclaration;
                      if (guardDeclaration > 0 &&
                          /Threshold = /.test(trusted[guardDeclaration - 1])) {
                        admissionStart -= 1;
                      }
                      trusted.splice(
                        admissionStart, guardFailure - admissionStart + 1);
                    } else if (checkedAdmissionPlan.kind ===
                        "clipped-affine-fill") {
                      trusted.length = 0;
                      const x = `ssaClippedX${index}`;
                      const y = `ssaClippedY${index}`;
                      const count = `ssaClippedCount${index}`;
                      const pixel = `ssaClippedPixel${index}`;
                      const end = `ssaClippedEnd${index}`;
                      const argument = (position) =>
                        `(${args[position]})`;
                      const specializedCache =
                        this.jit.checkedLeafCaptureCaches[
                          site.checkedLeafCaptureCacheId];
                      const specialized = Boolean(
                        specializedCache?.specializationInitialized &&
                        [
                          checkedAdmissionPlan.topCapture,
                          checkedAdmissionPlan.bottomCapture,
                          checkedAdmissionPlan.leftCapture,
                          checkedAdmissionPlan.rightCapture,
                          checkedAdmissionPlan.widthCapture,
                        ].every((position) => Number.isInteger(
                          specializedCache[`specializedValue${position}`])) &&
                        specializedCache[`specializedValue${
                          checkedAdmissionPlan.arrayDataCapture}`] !== null);
                      const capture = (position) =>
                        specialized && Number.isInteger(
                          specializedCache[`specializedValue${position}`])
                          ? String(specializedCache[
                            `specializedValue${position}`] | 0)
                          // The version match proves that the ordinary entry
                          // array snapshot is the specialized array. Keep its
                          // scalar alias in the loop so the JS engine does not
                          // have to rediscover/hoist a mutable cache property.
                          : specialized && position ===
                              checkedAdmissionPlan.arrayDataCapture
                            ? specializedCheckedCapture(
                              site.checkedLeafCaptureCacheId, position)
                            : `(${positionalRawCaptures[position]})`;
                      const top = capture(checkedAdmissionPlan.topCapture);
                      const bottom = capture(
                        checkedAdmissionPlan.bottomCapture);
                      const left = capture(checkedAdmissionPlan.leftCapture);
                      const right = capture(
                        checkedAdmissionPlan.rightCapture);
                      const width = capture(
                        checkedAdmissionPlan.widthCapture);
                      const destination = capture(
                        checkedAdmissionPlan.arrayDataCapture);
                      trusted.push(
                        `let ${x} = ${argument(
                          checkedAdmissionPlan.xArgument)};`,
                        `const ${y} = ${argument(
                          checkedAdmissionPlan.yArgument)};`,
                        `let ${count} = ${argument(
                          checkedAdmissionPlan.countArgument)};`,
                        `if (${y} >= ${top} && ${y} < ${bottom}) {`,
                        `  if (${x} < ${left}) {`,
                        `    ${count} = (${count} - ` +
                          `(${left} - ${x}));`,
                        `    ${x} = ${left};`,
                        "  }",
                        `  if ((${x} + ${count}) > ${right}) ` +
                          `${count} = ${right} - ${x};`,
                        `  let ${pixel} = (${y} * ${width}) + ${x};`,
                        `  const ${end} = ${pixel} + ${count};`,
                        `  while (${pixel} < ${end}) {`,
                        `    ${destination}[${pixel}] = ${argument(
                          checkedAdmissionPlan.valueArgument)};`,
                        `    ${pixel} += 1;`,
                        "  }",
                        "}",
                      );
                    } else {
                      return null;
                    }
                    if (trusted.some((line) =>
                      line.includes(`${out} = false`))) return null;
                    return trusted.map((line) => line.replace(
                      new RegExp(`\\{ ${out} = true; break ` +
                        `${inlineCheckedLeafLabel}; \\}`, "g"),
                      `{ break ${inlineCheckedLeafLabel}; }`));
                  })() : null;
              const receiverGuard = site.dynamic && site.argumentCount > 0
                ? `${args[0]} !== null && ${args[0]} !== undefined && ` +
                  `(${args[0]}.type || ${runtimeSite}.declaredClassName) === ` +
                  positionalReceiver
                : site.hasReceiver && site.argumentCount > 0
                  ? `${args[0]} !== null && ${args[0]} !== undefined && ` +
                    `${positionalReceiver} === null`
                  : "true";
              if (inlineCheckedLeafLines) {
                continuationFallbacks.set(inlineCheckedLeafFallbackMarker, {
                  continuation: fallbackLines,
                  ordinary: [
                    ...materializeLines(callStack, index),
                    "helpers.skipJitOnce(frame);",
                    "return { deopt: true, transient: true, " +
                      "reason: 'checked leaf admission' };",
                  ],
                  // The lexically inserted child is proven non-throwing and
                  // performs no effect before its own entry bailout. A
                  // wrapper checked leaf can therefore reject directly and
                  // let its canonical caller execute the original bytecode.
                  checkedLeaf: ["return helpers.asyncInvokeSentinel();"],
                });
              }
              const positionalRawCall = `${positionalRawInvoke} ? ` +
                `${positionalRawInvoke}(helpers${args.length ? ", " : ""}` +
                `${args.join(", ")}${positionalRawCaptures.length
                  ? `${args.length ? ", " : ""}${positionalRawCaptures.join(", ")}`
                  : ""}${args.length || positionalRawCaptures.length
                  ? ", " : ", "}thread, true) : ` +
                `${positionalInvoke}(${args.join(", ")}${
                  args.length ? ", " : ""}thread, true)`;
              if (checkedAdmissionPlan) {
                const provenRawCall =
                  `${positionalRawInvoke}(helpers${args.length ? ", " : ""}` +
                  `${args.join(", ")}${positionalRawCaptures.length
                    ? `${args.length ? ", " : ""}${positionalRawCaptures.join(", ")}`
                    : ""}${args.length || positionalRawCaptures.length
                    ? ", " : ", "}thread, true);`;
                const replacement = provenInlineCheckedLeafLines
                  ? [
                    `${inlineCheckedLeafLabel}: {`,
                    ...provenInlineCheckedLeafLines.map(
                      (line) => `  ${line}`),
                    "}",
                  ] : [provenRawCall];
                checkedCallAdmissionCandidates.push({
                  block: block.id,
                  itemIndex: index,
                  startMarker: checkedAdmissionStart,
                  endMarker: checkedAdmissionEnd,
                  replacement,
                  plan: checkedAdmissionPlan,
                  args: [...args],
                  argumentRanges: args.map((argument) =>
                    boundedIntegerRange(argument)),
                  argumentArrays: positionalArgumentArrayData,
                  captureExpressions: [...positionalRawCaptures],
                  captureCacheId: site.checkedLeafCaptureCacheId,
                  captureCacheVariable: `ssaCallCaptureCache${index}`,
                });
              }
              const selfRecursiveMarker = site.selfRecursive
                ? `/*__SSA_SELF_RECURSIVE_CALL_${index}__*/` : "";
              if (site.selfRecursive) {
                selfRecursiveCallExpressions.set(index, {
                  index,
                  marker: selfRecursiveMarker,
                  ordinary: positionalRawCall,
                  args: [...args],
                  result: out,
                });
              }
              if (inlineCheckedLeafLines && receiverGuard === "true") {
                // A static lexical child has no dispatch or receiver
                // predicate: its body is already present in this generated
                // region.  Do not manufacture a `usedDirect` flag and a
                // constant `if (true)` around every loop invocation.  The
                // child's own before-effects admission result remains the
                // sole fallback predicate, preserving exact canonical
                // execution when an assumption is not satisfied.
                lines.push(
                  `${inlineCheckedLeafLabel}: {`,
                  ...inlineCheckedLeafLines.map((line) => `  ${line}`),
                  "}",
                  `if (${inlineCheckedLeafVoid
                    ? `!${out}`
                    : `${out} === helpers.asyncInvokeSentinel()`}) {`,
                  inlineCheckedLeafFallbackMarker,
                  ...(inlineCheckedLeafVoid ? [] : ["}"]));
              } else lines.push(
                `let ${usedDirect} = false;`,
                `if (${inlineCheckedLeafLines
                  ? receiverGuard
                  : `(${positionalRawInvoke} || ${positionalInvoke}) && ${receiverGuard}`}) {`,
                `  ${usedDirect} = true;`,
                ...(inlineCheckedLeafLines ? [
                  `  ${inlineCheckedLeafLabel}: {`,
                  ...inlineCheckedLeafLines.map((line) => `    ${line}`),
                  "  }",
                ] : directCheckedLeafNoThrow ? [
                  `  ${out} = ${selfRecursiveMarker}${positionalRawCall};`,
                ] : [
                  `  try { ${out} = ${selfRecursiveMarker}${
                    positionalRawCall}; } catch (${caught}) {`,
                  ...materializeCallExceptionLines(
                    callStack, stack, index,
                    site.selfRecursive ? "false" :
                      `!${positionalInvoke}.jvmRestoresExceptionFrames`,
                  ).map((line) => `    ${line}`),
                  `    throw ${caught};`, "  }",
                ]),
                "}",
                `if (!${usedDirect} || ${inlineCheckedLeafVoid
                  ? `!${out}`
                  : `${out} === helpers.asyncInvokeSentinel()`}) {`,
                ...(inlineCheckedLeafLines
                  ? [inlineCheckedLeafFallbackMarker]
                  : fallbackLines.map((line) => `  ${line}`)),
                ...(inlineCheckedLeafVoid ? [] : ["}"]));
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
                checkedLeaf: ["return helpers.asyncInvokeSentinel();"],
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
                checkedLeaf: ["return helpers.asyncInvokeSentinel();"],
              });
              lines.push("if (thread.status !== 'runnable') {",
                yieldedCallMarker, "}");
            } else {
              lines.push("if (thread.status !== 'runnable') {",
                ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                "  return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee' };", "}");
            }
            if (inlineCheckedLeafVoidFastPath) lines.push("}");
            if (checkedAdmissionEnd) lines.push(checkedAdmissionEnd);
            if (site.selfRecursive) {
              lines.push(`/*__SSA_SELF_RECURSIVE_REGION_END_${index}__*/`);
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

    // Bytecode stack staging creates immutable SSA-copy chains. Discover the
    // declarations through the JavaScript AST, then apply one method-wide
    // alias graph to normal blocks and every deferred edge. Cold async/deopt
    // continuations consume the same SSA namespace, so a per-block text
    // rewrite can otherwise delete a declaration while leaving those uses
    // behind.
    let coalescedSsaCopyCount = 0;
    const aliases = new Map();
    const removedDeclarationsByPlan = new Map();
    const resolveAlias = (name) => {
      const visited = new Set();
      let current = name;
      while (aliases.has(current) && !visited.has(current)) {
        visited.add(current);
        current = aliases.get(current);
      }
      return current;
    };
    for (const plan of plans) {
      if (!plan?.lines?.length) continue;
      const parsedPlan = parseGeneratedStatements(plan.lines.join("\n"));
      const removedDeclarations = [];
      for (const statement of parsedPlan.statements) {
        if (statement.type !== "VariableDeclaration" ||
            statement.kind !== "const" || statement.declarations.length !== 1) {
          continue;
        }
        const declaration = statement.declarations[0];
        if (declaration.id?.type !== "Identifier" ||
            declaration.init?.type !== "Identifier" ||
            !ssaValueNames.has(declaration.id.name) ||
            !ssaValueNames.has(declaration.init.name)) continue;
        aliases.set(declaration.id.name, resolveAlias(declaration.init.name));
        removedDeclarations.push(statement);
        coalescedSsaCopyCount += 1;
      }
      if (removedDeclarations.length) {
        removedDeclarationsByPlan.set(plan, removedDeclarations);
      }
    }
    if (aliases.size) {
      const rewriteStatements = (lines, removed = []) =>
        rewriteGeneratedJavaScript(
          lines.join("\n"), resolveAlias, removed,
        ).split("\n").filter(Boolean);
      const rewriteExpression = (expression) =>
        rewriteGeneratedExpression(expression, resolveAlias);
      for (const plan of plans) {
        if (!plan?.lines?.length) continue;
        plan.lines = rewriteStatements(
          plan.lines, removedDeclarationsByPlan.get(plan) || []);
        plan.condition = rewriteExpression(plan.condition);
        plan.returnValue = rewriteExpression(plan.returnValue);
        if (plan.stack) plan.stack = plan.stack.map(rewriteExpression);
        if (plan.takenStack) {
          plan.takenStack = plan.takenStack.map(rewriteExpression);
        }
        if (plan.fallStack) {
          plan.fallStack = plan.fallStack.map(rewriteExpression);
        }
      }
      for (const fallback of continuationFallbacks.values()) {
        fallback.continuation = rewriteStatements(fallback.continuation);
        fallback.ordinary = rewriteStatements(fallback.ordinary);
        if (fallback.checkedLeaf) {
          fallback.checkedLeaf = rewriteStatements(fallback.checkedLeaf);
        }
      }
      for (const fallback of directEntryStaticReadFallbacks.values()) {
        fallback.direct = rewriteStatements(fallback.direct);
        fallback.ordinary = rewriteStatements(fallback.ordinary);
      }
      for (const fallback of directCheckedAdmissionFallbacks.values()) {
        fallback.direct = rewriteStatements(fallback.direct);
        fallback.ordinary = rewriteStatements(fallback.ordinary);
      }
      for (const access of deferredStaticArrayAccesses) {
        access.directLines = rewriteStatements(access.directLines);
      }
      for (const [object, data] of [...eagerFieldReceiverNullChecks]) {
        const resolvedObject = resolveAlias(object);
        if (resolvedObject === object) continue;
        eagerFieldReceiverNullChecks.delete(object);
        eagerFieldReceiverNullChecks.set(resolvedObject, data);
      }
      for (const [reference, slot] of [...entryReferenceLoads]) {
        const resolvedReference = resolveAlias(reference);
        if (resolvedReference === reference) continue;
        entryReferenceLoads.delete(reference);
        entryReferenceLoads.set(resolvedReference, slot);
      }
      for (const [load, slot] of [...localLoads]) {
        const resolvedLoad = resolveAlias(load);
        if (resolvedLoad === load) continue;
        localLoads.delete(load);
        localLoads.set(resolvedLoad, slot);
      }
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
    const checkedLeafCoarseLoopHeaders = new Set();
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
              `${runtimeCoarseTripLimit}` +
              (info.increment === 1 ? "" :
                ` && local${info.slot} <= 2147483647 - ` +
                `ssaRuntimeCoarseTrips${header} * ${info.increment}`),
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
      const emittedCheckedLeaf = op?.startsWith("invoke") &&
        callSites.get(index)?.directCheckedLeaf?.noThrow === true &&
        typeof callSites.get(index)?.directCheckedLeaf?.inlineSource === "string";
      return op && ((!emittedIntegerLeaf && !emittedCheckedLeaf &&
        op.startsWith("invoke")) ||
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
    if (!hasAtomicUnsafeOperation && this.coarseCountedLoopSafePointsEnabled) {
      for (const [header, info] of countedLoopInfos) {
        if (coarseCountedLoops.has(header) ||
            runtimeCoarseCountedLoops.has(header)) continue;
        runtimeCoarseCountedLoops.set(header, {
          ...info,
          variable: `ssaRuntimeCoarseLoop${header}`,
          tripsVariable: `ssaRuntimeCoarseTrips${header}`,
          tripsExpression:
            `(local${info.slot} >= ${info.boundExpression} ? 0 : ` +
            (info.increment === 1
              ? `(${info.boundExpression} - local${info.slot})`
              : `Math.ceil((${info.boundExpression} - local${info.slot}) / ` +
                `${info.increment})`) + `)`,
          condition:
            `ssaRuntimeCoarseTrips${header} <= ${runtimeCoarseTripLimit}` +
            (info.increment === 1 ? "" :
              ` && local${info.slot} <= 2147483647 - ` +
              `ssaRuntimeCoarseTrips${header} * ${info.increment}`),
        });
      }
    }
    const shrinkingArrayWindowLeaf = (() => {
      if ((code.code.exceptionTable || []).length !== 0 ||
          callSites.size !== 0 || entryArrayLocalSlots.size !== 1) return null;
      const arraySlot = [...entryArrayLocalSlots][0];
      if (assignedReferenceLocals.has(arraySlot) ||
          !entryArrayKinds.has(arraySlot)) return null;
      const arrayData = entryArrayDataVariable(arraySlot);
      const primitiveArrayOps = new Set([
        "iaload", "saload", "baload", "caload", "daload", "faload",
        "laload", "iastore", "sastore", "bastore", "castore",
        "dastore", "fastore", "lastore",
      ]);
      const forbiddenOps = new Set([
        "getfield", "putfield", "getstatic", "putstatic", "arraylength",
        "idiv", "irem", "athrow", "new", "newarray", "anewarray",
        "multianewarray", "monitorenter", "monitorexit", "checkcast",
        "instanceof", "aaload", "aastore",
      ]);
      const reachablePrimitiveItems = [];
      for (let index = 0; index < items.length; index += 1) {
        if (!normalReachableItems.has(index)) continue;
        const op = opOf(items[index]?.instruction);
        if (op?.startsWith("invoke") || forbiddenOps.has(op)) return null;
        if (primitiveArrayOps.has(op)) reachablePrimitiveItems.push(index);
      }
      if (reachablePrimitiveItems.length === 0 ||
          primitiveArrayAccessCandidates.length !==
            reachablePrimitiveItems.length ||
          primitiveArrayAccessCandidates.some((access) =>
            access.arrayData !== arrayData ||
            !reachablePrimitiveItems.includes(access.itemIndex))) return null;

      const loadSlot = (instruction) => {
        const op = opOf(instruction);
        return /^iload(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const storeSlot = (instruction) => {
        const op = opOf(instruction);
        if (op === "iinc") return Number(instruction.varnum ?? instruction.arg);
        return /^istore(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const outerCandidates = [];
      for (const header of structured.loopHeaders) {
        if (countedLoopInfos.has(header)) continue;
        const block = cfg.blocks[header];
        const blockItems = block?.insns || [];
        if (blockItems.length !== 5 || cfg.term[header]?.kind !== "cond") continue;
        const upperSlot = loadSlot(items[blockItems[0]]?.instruction);
        const lowerSlot = loadSlot(items[blockItems[1]]?.instruction);
        const window = constantInstructionValue(
          items[blockItems[2]]?.instruction);
        if (!Number.isInteger(upperSlot) || !Number.isInteger(lowerSlot) ||
            upperSlot === lowerSlot || !Number.isInteger(window) ||
            window <= 0 ||
            opOf(items[blockItems[3]]?.instruction) !== "iadd" ||
            opOf(items[blockItems[4]]?.instruction) !== "if_icmplt") continue;
        const loopBlocks = naturalLoopBlocksFor(header);
        const term = cfg.term[header];
        if (!loopBlocks || loopBlocks.has(term.taken) ||
            !loopBlocks.has(term.fall)) continue;
        outerCandidates.push({
          header, upperSlot, lowerSlot, window, loopBlocks,
        });
      }
      for (const outer of outerCandidates) {
        const innerCandidates = [...countedLoopInfos.values()].filter((info) =>
          info.boundSlot === outer.upperSlot && info.increment > 0 &&
          info.initial === null && outer.loopBlocks.has(info.header) &&
          [...info.loopBlocks].every((block) => outer.loopBlocks.has(block)));
        if (innerCandidates.length !== 1) continue;
        const inner = innerCandidates[0];
        const stride = inner.increment;
        if (outer.window !== stride * 2 || outer.window > 2147483647) continue;

        const preheaderItems = cfg.blocks[inner.preheader]?.insns || [];
        let matchingInitialization = 0;
        for (let position = 3; position < preheaderItems.length; position += 1) {
          const left = items[preheaderItems[position - 3]]?.instruction;
          const right = items[preheaderItems[position - 2]]?.instruction;
          const add = items[preheaderItems[position - 1]]?.instruction;
          const store = items[preheaderItems[position]]?.instruction;
          if (loadSlot(left) === outer.lowerSlot &&
              constantInstructionValue(right) === stride &&
              opOf(add) === "iadd" && storeSlot(store) === inner.slot &&
              /^istore(?:_[0-3])?$/.test(opOf(store))) {
            matchingInitialization += 1;
          }
        }
        if (matchingInitialization !== 1) continue;

        const upperWrites = [];
        let lowerWrites = 0;
        let unexpectedInnerWrites = 0;
        for (let block = 0; block < cfg.n; block += 1) {
          if (!cfg.blocks[block] || cfg.blocks[block].synthetic) continue;
          for (const itemIndex of cfg.blocks[block].insns || []) {
            if (!normalReachableItems.has(itemIndex)) continue;
            const instruction = items[itemIndex]?.instruction;
            const op = opOf(instruction);
            const slot = storeSlot(instruction);
            if (slot === outer.lowerSlot) lowerWrites += 1;
            if (slot === outer.upperSlot) {
              upperWrites.push({block, op, increment:
                op === "iinc" ? Number(instruction.incr ?? 0) : null});
            }
            if (slot === inner.slot) {
              const isIncrement = op === "iinc" &&
                inner.loopBlocks.has(block) &&
                Number(instruction.incr ?? 0) === stride;
              const isInitialization =
                block === inner.preheader &&
                /^istore(?:_[0-3])?$/.test(op);
              if (!isIncrement && !isInitialization) unexpectedInnerWrites += 1;
            }
          }
        }
        if (lowerWrites !== 0 || unexpectedInnerWrites !== 0 ||
            upperWrites.length !== 1 || upperWrites[0].op !== "iinc" ||
            upperWrites[0].increment !== -stride ||
            inner.loopBlocks.has(upperWrites[0].block)) continue;
        const outerHeaderItem = cfg.blocks[outer.header].insns[0];
        const outerBackedges = allCfgPredecessors[outer.header].filter(
          (block) => cfg.blocks[block]?.insns?.[0] >= outerHeaderItem);
        if (outerBackedges.length !== 1 ||
            outerBackedges[0] !== upperWrites[0].block) continue;

        const accesses = primitiveArrayAccessCandidates;
        if (accesses.some((access) =>
          !inner.loopBlocks.has(access.block) ||
          access.indexAffine?.slot !== inner.slot ||
          !Number.isInteger(access.indexAffine.offset))) continue;
        const minimumOffset = Math.min(...accesses.map(
          (access) => access.indexAffine.offset));
        const maximumOffset = Math.max(...accesses.map(
          (access) => access.indexAffine.offset));
        if (minimumOffset < -stride || maximumOffset >= stride) continue;

        const storeItems = accesses.filter((access) => access.store);
        if (storeItems.length === 0 || storeItems.some((access) =>
          !inner.loopBlocks.has(access.block))) continue;
        const variable = `ssaShrinkingArrayWindowGuard${outer.header}`;
        for (const access of accesses) {
          access.structuralGuard = variable;
          if (access.rangeCandidate) {
            access.rangeCandidate.structuralGuard = variable;
          }
        }
        return {
          variable, arrayData, arraySlot,
          outerHeader: outer.header,
          innerHeader: inner.header,
          lowerSlot: outer.lowerSlot,
          upperSlot: outer.upperSlot,
          innerSlot: inner.slot,
          window: outer.window,
          stride,
          accesses,
        };
      }
      return null;
    })();
    const recursiveArrayPartitionLeaf = (() => {
      const rejectRecursive = (reason) => {
        if (typeof process !== "undefined" && process.env &&
            process.env.JVM_TRACE_STRUCTURED_RECURSIVE_ARRAY === "1") {
          console.error("[structured-recursive-array]", reason);
        }
        return null;
      };
      let recursiveDescriptor = null;
      try { recursiveDescriptor = parseDescriptor(method.descriptor); } catch (_) {}
      if (!methodIsStatic || !recursiveDescriptor ||
          recursiveDescriptor.returnType !== "void" ||
          recursiveDescriptor.params.length !== 3 ||
          !recursiveDescriptor.params[0]?.endsWith("[]") ||
          !recursiveDescriptor.params.slice(1).every((type) =>
            ["boolean", "byte", "char", "short", "int"].includes(type)) ||
          (code.code.exceptionTable || []).length !== 0 ||
          entryArrayLocalSlots.size !== 1 || callSites.size !== 2 ||
          [...callSites.values()].some((site) =>
            !site.selfRecursive || !site.returnsVoid) ||
          structured.loopHeaders.size !== 1) return rejectRecursive(
        `entry handlers=${(code.code.exceptionTable || []).length} ` +
        `arrays=${entryArrayLocalSlots.size} calls=${callSites.size} ` +
        `loops=${structured.loopHeaders.size}`);
      const arraySlot = [...entryArrayLocalSlots][0];
      if (assignedReferenceLocals.has(arraySlot) ||
          !entryArrayKinds.has(arraySlot)) return rejectRecursive("array slot");
      const arrayData = entryArrayDataVariable(arraySlot);
      const header = [...structured.loopHeaders][0];
      const loop = countedLoopInfos.get(header);
      if (!loop || !Number.isInteger(loop.boundSlot) ||
          loop.initial !== null || loop.increment <= 0) return rejectRecursive(
        `counted loop=${Boolean(loop)} initial=${loop?.initial} ` +
        `increment=${loop?.increment} bound=${loop?.boundSlot}`);
      const stride = loop.increment;
      const loadSlot = (instruction, prefix = "i") => {
        const op = opOf(instruction);
        return new RegExp(`^${prefix}load(?:_[0-3])?$`).test(op)
          ? localIndex(instruction, op) : null;
      };
      const storeSlot = (instruction) => {
        const op = opOf(instruction);
        return /^istore(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const preheaderItems = cfg.blocks[loop.preheader]?.insns || [];
      let lowerSlot = null;
      for (let position = 3; position < preheaderItems.length; position += 1) {
        const left = items[preheaderItems[position - 3]]?.instruction;
        const step = items[preheaderItems[position - 2]]?.instruction;
        const add = items[preheaderItems[position - 1]]?.instruction;
        const store = items[preheaderItems[position]]?.instruction;
        if (constantInstructionValue(step) === stride &&
            opOf(add) === "iadd" && storeSlot(store) === loop.slot) {
          lowerSlot = loadSlot(left);
        }
      }
      if (!Number.isInteger(lowerSlot) || lowerSlot === loop.boundSlot) {
        return rejectRecursive("lower slot");
      }
      let pivotSlot = null;
      const headerItem = cfg.blocks[header]?.insns?.[0] ?? 0;
      for (let index = 1; index < headerItem; index += 1) {
        if (loadSlot(items[index - 1]?.instruction) === lowerSlot) {
          const candidate = storeSlot(items[index]?.instruction);
          if (Number.isInteger(candidate) && candidate !== lowerSlot &&
              candidate !== loop.boundSlot && candidate !== loop.slot) {
            if (pivotSlot !== null && pivotSlot !== candidate) return null;
            pivotSlot = candidate;
          }
        }
      }
      if (!Number.isInteger(pivotSlot)) return rejectRecursive("pivot slot");

      const primitiveArrayOps = new Set([
        "iaload", "saload", "baload", "caload", "daload", "faload",
        "laload", "iastore", "sastore", "bastore", "castore",
        "dastore", "fastore", "lastore",
      ]);
      const forbiddenOps = new Set([
        "getfield", "putfield", "getstatic", "putstatic", "arraylength",
        "idiv", "irem", "athrow", "new", "newarray", "anewarray",
        "multianewarray", "monitorenter", "monitorexit", "checkcast",
        "instanceof", "aaload", "aastore",
      ]);
      const primitiveItems = [];
      for (let index = 0; index < items.length; index += 1) {
        if (!normalReachableItems.has(index)) continue;
        const op = opOf(items[index]?.instruction);
        if (forbiddenOps.has(op)) return rejectRecursive(`forbidden ${op}`);
        if (op?.startsWith("invoke") && !callSites.get(index)?.selfRecursive) {
          return rejectRecursive(`foreign call ${index}`);
        }
        if (primitiveArrayOps.has(op)) primitiveItems.push(index);
      }
      const allowedIndexSlots = new Set([
        lowerSlot, loop.slot, pivotSlot,
      ]);
      const accesses = primitiveArrayAccessCandidates;
      const coveredItems = new Set(accesses.map((access) => access.itemIndex));
      const implicitlyCoveredStores = primitiveItems.filter((itemIndex) =>
        !coveredItems.has(itemIndex));
      if (!primitiveItems.length || implicitlyCoveredStores.some((itemIndex) =>
        !opOf(items[itemIndex]?.instruction)?.endsWith("astore")) ||
          accesses.some((access) =>
            access.arrayData !== arrayData ||
            !primitiveItems.includes(access.itemIndex) ||
            !allowedIndexSlots.has(access.indexAffine?.slot) ||
            !Number.isInteger(access.indexAffine?.offset) ||
            access.indexAffine.offset < 0 ||
            access.indexAffine.offset >= stride)) return rejectRecursive(
        `accesses primitive=${primitiveItems.length} candidates=${accesses.length} ` +
        `slots=${[...allowedIndexSlots].join(",")}`);

      const decodeCall = (index) => {
        const highSlot = loadSlot(items[index - 1]?.instruction);
        if (!Number.isInteger(highSlot)) return null;
        const directLow = loadSlot(items[index - 2]?.instruction);
        if (Number.isInteger(directLow)) {
          const loadedArray = loadSlot(items[index - 3]?.instruction, "a");
          return loadedArray === arraySlot
            ? {lowSlot: directLow, lowOffset: 0, highSlot} : null;
        }
        if (opOf(items[index - 2]?.instruction) !== "iadd" ||
            constantInstructionValue(items[index - 3]?.instruction) !== stride) {
          return null;
        }
        const lowSlot = loadSlot(items[index - 4]?.instruction);
        const loadedArray = loadSlot(items[index - 5]?.instruction, "a");
        return loadedArray === arraySlot && Number.isInteger(lowSlot)
          ? {lowSlot, lowOffset: stride, highSlot} : null;
      };
      const recursiveCalls = [...callSites.keys()].map(decodeCall);
      if (recursiveCalls.some((call) => !call)) return rejectRecursive(
        `call decode ${JSON.stringify(recursiveCalls)}`);
      const hasLowerPartition = recursiveCalls.some((call) =>
        call.lowSlot === lowerSlot && call.lowOffset === 0 &&
        call.highSlot === pivotSlot);
      const hasUpperPartition = recursiveCalls.some((call) =>
        call.lowSlot === pivotSlot && call.lowOffset === stride &&
        call.highSlot === loop.boundSlot);
      if (!hasLowerPartition || !hasUpperPartition) return rejectRecursive(
        `partition calls ${JSON.stringify(recursiveCalls)}`);

      const variable = `ssaRecursiveArrayWindowGuard${header}`;
      for (const access of accesses) {
        access.structuralGuard = variable;
        if (access.rangeCandidate) {
          access.rangeCandidate.structuralGuard = variable;
        }
      }
      return {
        variable, arrayData, arraySlot, header, stride,
        lowerSlot, upperSlot: loop.boundSlot, accesses,
      };
    })();
    const arrayRangeGuardDeclarations = new Map();
    const arrayRangeGuardVariables = new Map();
    const arrayRangeGuardDataVariables = new Map();
    const arrayRangeGuardNonZeroLocals = new Map();
    const packedArrayCapacityFacts = [];
    const arrayRangeGuardByCondition = new Map();
    const tripBoundedArrayRangeGuards = new Set();
    const countedRangeTripValues = new Map();
    let coalescedArrayRangeGuardCount = 0;
    const loopInvariantDivisorGuards = new Map();
    const loopInvariantDivisorGuardNonZeroLocals = new Map();
    let loopInvariantDivisorGuardCount = 0;
    const sharedCountedTrips = (info, preamble) => {
      let shared = countedRangeTripValues.get(info.header);
      if (!shared) {
        const remaining = `(${info.boundExpression} - local${info.slot})`;
        shared = {
          variable: `ssaArrayRangeTrips${info.header}`,
          declaration: `const ssaArrayRangeTrips${info.header} = ` +
            `(local${info.slot} >= ${info.boundExpression} ? 0 : ` +
            (info.increment === 1 ? remaining :
              `Math.ceil(${remaining} / ${info.increment})`) + `);`,
          emitted: false,
        };
        countedRangeTripValues.set(info.header, shared);
      }
      if (!shared.emitted) {
        preamble.push(shared.declaration);
        shared.emitted = true;
      }
      return shared.variable;
    };
    // A division exception arm inside a counted loop is avoidable when its
    // divisor comes from a loop-invariant local. Version the complete loop on
    // `(zero trips || divisor != 0)`: failure restores the exact loop-header
    // state before executing the canonical bytecode, while success lets the
    // numeric loop omit every dominated arithmetic/deopt branch. This is
    // derived solely from SSA local provenance and loop writes.
    const exceptionalGuardClose = (lines, start) => {
      let depth = 0;
      for (let index = start; index < lines.length; index += 1) {
        const trimmed = lines[index].trim();
        if (trimmed.endsWith("{")) depth += 1;
        if (trimmed === "}" || trimmed.startsWith("} else")) depth -= 1;
        if (depth === 0) return index;
      }
      return -1;
    };
    for (const [header, info] of this.loopInvariantDivisorGuardsEnabled
      ? countedLoopInfos : []) {
      const slots = new Set();
      for (const block of info.loopBlocks) {
        const lines = plans[block]?.lines || [];
        for (let index = 0; index < lines.length; index += 1) {
          const zero = /^if \((ssaValue\d+) === 0\) \{$/.exec(lines[index]);
          const inline = /^if \(!\(.+\(\((ssaValue\d+)\) !== 0\).+\) \{$/.exec(
            lines[index]);
          const value = zero?.[1] || inline?.[1];
          if (!value) continue;
          const close = exceptionalGuardClose(lines, index);
          if (close < 0) continue;
          const exceptional = lines.slice(index + 1, close).some((line) =>
            line.includes("ArithmeticException") ||
            line.includes("reason: 'guarded inline integer leaf'"));
          if (!exceptional) continue;
          const slot = localLoads.get(value);
          if (Number.isInteger(slot) && !info.writtenSlots.has(slot)) {
            slots.add(slot);
          }
        }
      }
      if (!slots.size) continue;
      const variable = `ssaInvariantDivisorGuard${header}`;
      const trips = `(local${info.slot} >= ${info.boundExpression} ? 0 : ` +
        (info.increment === 1
          ? `(${info.boundExpression} - local${info.slot})`
          : `Math.ceil((${info.boundExpression} - local${info.slot}) / ` +
            `${info.increment})`) + `)`;
      loopInvariantDivisorGuards.set(header, {
        variable,
        declaration: `const ${variable} = (${trips} === 0 || ` +
          [...slots].map((slot) => `local${slot} !== 0`).join(" && ") + ");",
      });
      loopInvariantDivisorGuardNonZeroLocals.set(variable, [...slots]);
      loopInvariantDivisorGuardCount += slots.size;
    }
    const quotientProductRangePreambles = new Map();
    const cyclicArrayRangeCandidates = new Set();
    let fieldBackedArrayRangeCandidateCount = 0;
    let hoistedArrayRangeGuardCount = 0;
    const trustedHoistedRangeGuards = new Set();
    const entryDominatedRangeGuards = new Set();
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
    const carriedCountedLocalRelation = (info, candidate) => {
      if (candidate.kind !== "affine-local" || info.initial !== 0 ||
          info.increment <= 0 || candidate.slots.length !== 1) return null;
      const slot = candidate.slots[0];
      if (slot === info.slot || !Number.isInteger(info.boundSlot) ||
          !Number.isInteger(info.preheader)) return null;
      const preheaderItems = cfg.blocks[info.preheader]?.insns || [];
      let initialized = false;
      for (let position = 3; position < preheaderItems.length; position += 1) {
        const load = items[preheaderItems[position - 3]]?.instruction;
        const stride = items[preheaderItems[position - 2]]?.instruction;
        const subtract = items[preheaderItems[position - 1]]?.instruction;
        const store = items[preheaderItems[position]]?.instruction;
        const loadOp = opOf(load), storeOp = opOf(store);
        if (/^iload(?:_[0-3])?$/.test(loadOp) &&
            localIndex(load, loadOp) === info.boundSlot &&
            constantInstructionValue(stride) === info.increment &&
            opOf(subtract) === "isub" &&
            /^istore(?:_[0-3])?$/.test(storeOp) &&
            localIndex(store, storeOp) === slot) initialized = true;
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
      if (!afterAccess || (info.backedges || []).some((backedge) =>
        assignment.block !== backedge &&
        loopPathExists(info, info.header, backedge, assignment.block))) {
        return null;
      }
      return {slot, offset: candidate.indexAffine?.offset || 0};
    };
    const packedAppendRelation = (info, candidate) => {
      if (candidate.kind !== "affine-local" || info.increment <= 0 ||
          candidate.slots.length !== 1) return null;
      const slot = candidate.slots[0];
      if (slot === info.slot) return null;
      if ([...structured.loopHeaders].some((header) =>
        header !== info.header && info.loopBlocks.has(header))) return null;
      let writeCount = 0;
      const blockWeights = new Map();
      for (const block of info.loopBlocks) {
        let weight = 0;
        for (const itemIndex of cfg.blocks[block]?.insns || []) {
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          const writtenSlot = op === "iinc"
            ? Number(instruction.varnum ?? instruction.arg)
            : /^istore(?:_[0-3])?$/.test(op)
              ? localIndex(instruction, op) : null;
          if (writtenSlot !== slot) continue;
          writeCount += 1;
          if (op !== "iinc" || Number(instruction.incr) !== 1) return null;
          weight += 1;
        }
        blockWeights.set(block, weight);
      }
      if (!writeCount) return null;
      const memo = new Map();
      const visiting = new Set();
      const maximumToBackedge = (block) => {
        if (memo.has(block)) return memo.get(block);
        if (visiting.has(block)) return null;
        visiting.add(block);
        let suffix = -Infinity;
        for (const successor of cfg.succ[block] || []) {
          if (successor === info.header) {
            suffix = Math.max(suffix, 0);
          } else if (info.loopBlocks.has(successor)) {
            const candidateMaximum = maximumToBackedge(successor);
            if (candidateMaximum === null) return null;
            suffix = Math.max(suffix, candidateMaximum);
          }
        }
        visiting.delete(block);
        const maximum = suffix === -Infinity
          ? -Infinity : (blockWeights.get(block) || 0) + suffix;
        memo.set(block, maximum);
        return maximum;
      };
      let incrementsPerTrip = -Infinity;
      for (const successor of cfg.succ[info.header] || []) {
        if (!info.loopBlocks.has(successor) || successor === info.header) continue;
        const maximum = maximumToBackedge(successor);
        if (maximum === null) return null;
        incrementsPerTrip = Math.max(incrementsPerTrip, maximum);
      }
      if (!Number.isInteger(incrementsPerTrip) || incrementsPerTrip <= 0) {
        return null;
      }
      const candidateItems = cfg.blocks[candidate.block]?.insns || [];
      const candidatePosition = candidateItems.indexOf(candidate.itemIndex);
      let postIncrement = false;
      for (let position = candidatePosition - 1; position > 0; position -= 1) {
        const instruction = items[candidateItems[position]]?.instruction;
        const op = opOf(instruction);
        if (op === "iinc" &&
            Number(instruction.varnum ?? instruction.arg) === slot &&
            Number(instruction.incr) === 1) {
          postIncrement = candidateItems.slice(0, position).some((itemIndex) => {
            const load = items[itemIndex]?.instruction;
            const loadOp = opOf(load);
            return /^iload(?:_[0-3])?$/.test(loadOp) &&
              localIndex(load, loadOp) === slot;
          });
          break;
        }
      }
      return {
        slot,
        offset: candidate.indexAffine?.offset || 0,
        incrementsPerTrip,
        postIncrement,
      };
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
    // Extend a verified one-dimensional cyclic access across an enclosing
    // counted row loop.  This is the bytecode form produced for a general
    // cyclic rectangle, but the proof is expressed entirely in terms of local
    // recurrences:
    //
    //   index = index - phase + entryPhase + modulus
    //   phase = entryPhase
    //   if (++row == height) { row = 0; index -= height * modulus; }
    //
    // Once those assignments, their ordering, and all invariant inputs have
    // been verified, one entry predicate can cover the complete rectangular
    // backing store.  The generated fast loop then needs neither a per-row
    // source predicate nor a checked duplicate of its inner loop.
    const nestedCyclicLocalRange = (info, candidate, cyclic, outer) => {
      if (!outer || !outer.loopBlocks.has(info.header)) return null;
      const innerItems = new Set([...info.loopBlocks]
        .flatMap((block) => cfg.blocks[block]?.insns || []));
      const outerOnlyItems = [...outer.loopBlocks]
        .flatMap((block) => cfg.blocks[block]?.insns || [])
        .filter((itemIndex) => !innerItems.has(itemIndex))
        .sort((left, right) => left - right);
      const outerOnlySet = new Set(outerOnlyItems);
      const loadSlot = (instruction) => {
        const op = opOf(instruction);
        return /^iload(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const storeSlot = (instruction) => {
        const op = opOf(instruction);
        return /^istore(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const sequenceAt = (position, length) => {
        const indexes = Array.from(
          {length}, (_unused, offset) => position + offset);
        return indexes.every((itemIndex) => outerOnlySet.has(itemIndex))
          ? indexes.map((itemIndex) => items[itemIndex]?.instruction) : null;
      };

      let rowAdvance = null;
      for (const position of outerOnlyItems) {
        const sequence = sequenceAt(position, 10);
        if (!sequence ||
            loadSlot(sequence[0]) !== cyclic.indexSlot ||
            loadSlot(sequence[1]) !== cyclic.phaseSlot ||
            opOf(sequence[2]) !== "isub" ||
            !Number.isInteger(loadSlot(sequence[3])) ||
            opOf(sequence[4]) !== "iadd" ||
            loadSlot(sequence[5]) !== cyclic.modulusSlot ||
            opOf(sequence[6]) !== "iadd" ||
            storeSlot(sequence[7]) !== cyclic.indexSlot ||
            loadSlot(sequence[8]) !== loadSlot(sequence[3]) ||
            storeSlot(sequence[9]) !== cyclic.phaseSlot) continue;
        if (rowAdvance) return null;
        rowAdvance = {
          position,
          entryPhaseSlot: loadSlot(sequence[3]),
        };
      }
      if (!rowAdvance || outer.writtenSlots.has(rowAdvance.entryPhaseSlot)) {
        return null;
      }

      let verticalWrap = null;
      for (const position of outerOnlyItems) {
        const sequence = sequenceAt(position, 10);
        if (!sequence || opOf(sequence[0]) !== "iinc" ||
            Number(sequence[0].incr) !== 1) continue;
        const rowSlot = Number(sequence[0].varnum ?? sequence[0].arg);
        const heightSlot = loadSlot(sequence[2]);
        const cycleSlot = loadSlot(sequence[7]);
        if (loadSlot(sequence[1]) !== rowSlot ||
            !Number.isInteger(heightSlot) ||
            opOf(sequence[3]) !== "if_icmpne" ||
            opOf(sequence[4]) !== "iconst_0" ||
            storeSlot(sequence[5]) !== rowSlot ||
            loadSlot(sequence[6]) !== cyclic.indexSlot ||
            !Number.isInteger(cycleSlot) ||
            opOf(sequence[8]) !== "isub" ||
            storeSlot(sequence[9]) !== cyclic.indexSlot) continue;
        const branchTarget = sequence[3]?.arg;
        const targetIndex = typeof branchTarget === "string"
          ? labels.get(branchTarget.replace(/:$/, "")) : null;
        if (targetIndex !== position + 10) continue;
        if (verticalWrap) return null;
        verticalWrap = {position, rowSlot, heightSlot, cycleSlot};
      }
      if (!verticalWrap ||
          outer.writtenSlots.has(verticalWrap.heightSlot) ||
          outer.writtenSlots.has(verticalWrap.cycleSlot) ||
          outer.writtenSlots.has(cyclic.modulusSlot)) return null;

      const firstOuterItem = Math.min(...[...outer.loopBlocks]
        .flatMap((block) => cfg.blocks[block]?.insns || []));
      let entryPhaseInitializationCount = 0;
      let cycleInitializationCount = 0;
      for (let position = 1; position < firstOuterItem; position += 1) {
        const store = items[position]?.instruction;
        if (storeSlot(store) === rowAdvance.entryPhaseSlot &&
            loadSlot(items[position - 1]?.instruction) === cyclic.phaseSlot) {
          entryPhaseInitializationCount += 1;
        }
        if (position >= 3 &&
            storeSlot(store) === verticalWrap.cycleSlot &&
            opOf(items[position - 1]?.instruction) === "imul") {
          const left = loadSlot(items[position - 3]?.instruction);
          const right = loadSlot(items[position - 2]?.instruction);
          if ((left === verticalWrap.heightSlot &&
               right === cyclic.modulusSlot) ||
              (right === verticalWrap.heightSlot &&
               left === cyclic.modulusSlot)) {
            cycleInitializationCount += 1;
          }
        }
      }
      if (entryPhaseInitializationCount !== 1 ||
          cycleInitializationCount !== 1) return null;

      const writeCounts = new Map();
      for (const itemIndex of [...outer.loopBlocks]
        .flatMap((block) => cfg.blocks[block]?.insns || [])) {
        const instruction = items[itemIndex]?.instruction;
        const op = opOf(instruction);
        const slot = op === "iinc"
          ? Number(instruction.varnum ?? instruction.arg)
          : storeSlot(instruction);
        if (Number.isInteger(slot)) {
          writeCounts.set(slot, (writeCounts.get(slot) || 0) + 1);
        }
      }
      if (writeCounts.get(cyclic.indexSlot) !== 4 ||
          writeCounts.get(cyclic.phaseSlot) !== 3 ||
          writeCounts.get(verticalWrap.rowSlot) !== 2 ||
          writeCounts.has(rowAdvance.entryPhaseSlot) ||
          writeCounts.has(verticalWrap.heightSlot) ||
          writeCounts.has(verticalWrap.cycleSlot) ||
          writeCounts.has(cyclic.modulusSlot)) return null;

      return {
        outer,
        entryPhaseSlot: rowAdvance.entryPhaseSlot,
        rowSlot: verticalWrap.rowSlot,
        heightSlot: verticalWrap.heightSlot,
        cycleSlot: verticalWrap.cycleSlot,
      };
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
      if (candidate.structuralGuard) continue;
      const loops = [...countedLoopInfos.values()]
        .filter((info) =>
          (info.increment === 1 ||
            candidate.kind === "affine-local" && info.increment > 1) &&
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
            carriedCountedLocalRelation(loop, candidate) ||
            packedAppendRelation(loop, candidate) ||
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
      // Non-unit strides are admitted only for the direct affine induction
      // proof below. The more elaborate cyclic/nested/recurrence proofs have
      // their own unit-step algebra and remain deliberately unchanged.
      const positiveStrideCarried = info.increment !== 1 &&
        carriedCountedLocalRelation(info, candidate);
      const positiveStridePacked = info.increment !== 1 &&
        packedAppendRelation(info, candidate);
      if (info.increment !== 1 &&
          (candidate.kind !== "affine-local" || info.postDecrement ||
           outermostCountedLoop || outermostPostDecrementLoop ||
           candidate.slots[0] !== info.slot && !positiveStrideCarried &&
             !positiveStridePacked)) continue;
      const selectedPackedAppend = packedAppendRelation(info, candidate);
      if (selectedPackedAppend && hasEffectBeforeLoopHeader(info.header)) {
        continue;
      }
      const affineOffset = candidate.kind === "affine-local"
        ? candidate.offset || 0 : 0;
      if (affineOffset !== 0 &&
          (outermostCountedLoop || outermostPostDecrementLoop ||
           info.postDecrement)) continue;
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
        const carried = step === null
          ? carriedCountedLocalRelation(info, candidate) : null;
        const packed = step === null && !carried
          ? packedAppendRelation(info, candidate) : null;
        const relatedOffsets = arrayRangeCheckCandidates
          .filter((other) => other.kind === "affine-local" &&
            other.arrayData === candidate.arrayData &&
            other.slots[0] === indexSlot &&
            info.loopBlocks.has(other.block))
          .map((other) => other.offset || 0);
        const minimumAffineOffset = Math.min(
          affineOffset, ...relatedOffsets);
        const maximumAffineOffset = Math.max(
          affineOffset, ...relatedOffsets);
        const cyclic = step === null
          ? carried || packed ? null : cyclicLocalRange(info, candidate) : null;
        const nestedCyclic = cyclic && outermostCountedLoop
          ? nestedCyclicLocalRange(
            info, candidate, cyclic, outermostCountedLoop) : null;
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
        if (packed) {
          const trips = sharedCountedTrips(info, preamble);
          const first = `(local${packed.slot} + ${minimumAffineOffset})`;
          const end = `(local${packed.slot} + ${trips} * ` +
            `${packed.incrementsPerTrip} + ${maximumAffineOffset} + ` +
            `${packed.postIncrement ? 0 : 1})`;
          condition = `(${trips} === 0 || (${trips} <= ` +
            `${runtimeCoarseTripLimit} && ${first} >= 0 && ${end} >= ` +
            `${first} && ${end} <= ${candidate.arrayData}.length && ` +
            `${end} <= 2147483647))`;
        } else if (carried) {
          const trips = sharedCountedTrips(info, preamble);
          const first = minimumAffineOffset;
          const last = `(${info.boundExpression} - ${info.increment} + ` +
            `${maximumAffineOffset})`;
          condition = `(${trips} === 0 || (${trips} <= ` +
            `${runtimeCoarseTripLimit} && ${first} >= 0 && ${last} >= ` +
            `${first} && ${last} < ${candidate.arrayData}.length && ` +
            `${last} <= 2147483647))`;
        } else if (info.postDecrement && step !== null) {
          const trips = `Math.max(0, local${info.slot})`;
          const last = `(local${indexSlot} + (${trips} - 1) * ${step})`;
          condition =
            `(${trips} === 0 || (${trips} <= ` +
            `${runtimeCoarseTripLimit} && ${step} >= 0 && ` +
            `local${indexSlot} >= 0 && ${last} < ` +
            `${candidate.arrayData}.length && ${last} <= 2147483647))`;
        } else if (nestedCyclic) {
          cyclicArrayRangeCandidates.add(candidate);
          const prefix = `ssaNestedCyclicRange${candidateIndex}`;
          const product = `${prefix}Product`;
          const base = `${prefix}Base`;
          const end = `${prefix}End`;
          preamble.push(
            `const ${product} = local${nestedCyclic.heightSlot} * ` +
              `local${cyclic.modulusSlot};`,
            `const ${base} = ` +
              `(local${cyclic.indexSlot} - local${cyclic.phaseSlot}) - ` +
              `local${nestedCyclic.rowSlot} * local${cyclic.modulusSlot};`,
            `const ${end} = ${base} + ${product};`,
          );
          condition =
            `(local${cyclic.modulusSlot} > 0 && ` +
            `local${nestedCyclic.heightSlot} > 0 && ` +
            `${product} <= 2147483647 && ` +
            `local${cyclic.phaseSlot} >= 0 && ` +
            `local${cyclic.phaseSlot} < local${cyclic.modulusSlot} && ` +
            `local${nestedCyclic.rowSlot} >= 0 && ` +
            `local${nestedCyclic.rowSlot} < ` +
            `local${nestedCyclic.heightSlot} && ` +
            `${base} >= 0 && ${end} <= ${candidate.arrayData}.length && ` +
            `${end} <= 2147483647)`;
          declarationHeader = nestedCyclic.outer.header;
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
          const prefix = `ssaNestedAffineRange${candidateIndex}`;
          const outerTripsExpression =
            `(local${outermostCountedLoop.slot} >= ` +
            `${outermostCountedLoop.boundExpression} ? 0 : ` +
            `(${outermostCountedLoop.boundExpression} - ` +
            `local${outermostCountedLoop.slot}))`;
          const innerTripsExpression =
            `Math.max(0, ${info.boundExpression})`;
          const outerTrips = `${prefix}OuterTrips`;
          const innerTrips = `${prefix}InnerTrips`;
          const rowStride = `${prefix}RowStride`;
          const last = `${prefix}Last`;
          preamble.push(
            `const ${outerTrips} = ${outerTripsExpression};`,
            `const ${innerTrips} = ${innerTripsExpression};`,
            `const ${rowStride} = ` +
              `${innerTrips} * ${step} + local${countedOuterSkipSlot};`,
            `const ${last} = local${indexSlot} + (${outerTrips} - 1) * ` +
              `${rowStride} + (${innerTrips} - 1) * ${step};`,
          );
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
          const trips = sharedCountedTrips(info, preamble);
          const first = `(local${indexSlot} + ${minimumAffineOffset})`;
          const last =
            `(local${indexSlot} + ${maximumAffineOffset} + ` +
            `(${trips} - 1) * ${step})`;
          condition =
            `(${trips} === 0 || (${trips} <= ${runtimeCoarseTripLimit} && ` +
            `${step} >= 0 && ` +
            `${first} >= 0 && ${last} < ${candidate.arrayData}.length && ` +
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
          candidate.provenNonZeroSlots = [recurrence.divisorSlot];
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
            `${prefix}FirstIndex >= 0 && ${prefix}LastIndex >= 0 && ` +
            `${prefix}FirstIndex < ${candidate.arrayData}.length && ` +
            `${prefix}LastIndex < ${candidate.arrayData}.length && ` +
            `${prefix}FirstIndex <= 2147483647 && ` +
            `${prefix}LastIndex <= 2147483647))`;
        } else {
          const baseSlot = candidate.slots.find((slot) => slot !== info.slot);
          const trips = `(${info.boundExpression} - local${info.slot})`;
          const start = `((local${baseSlot} + local${info.slot}) | 0)`;
          condition =
            `(local${info.slot} >= ${info.boundExpression} || ` +
            `((${start} >>> 0) <= ${candidate.arrayData}.length - ${trips}))`;
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
      if (!unconditionallyNonNullEntryArrayData.has(candidate.arrayData)) {
        condition = `(${candidate.arrayData} !== null && ${condition})`;
      }
      if (info.increment > 1 && candidate.kind === "affine-local") {
        // The positive-stride affine guard above includes both an exact
        // ceiling trip count and the runtime trip cap, so it is also a proof
        // that this loop can execute atomically after the entry bailout.
        tripBoundedArrayRangeGuards.add(variable);
      }
      const guardKey = `${declarationHeader}\0${condition}`;
      const existingGuard = arrayRangeGuardByCondition.get(guardKey);
      if (existingGuard) {
        candidate.rangeGuardVariable = existingGuard;
        const variables = arrayRangeGuardVariables.get(info.header) || [];
        if (!variables.includes(existingGuard)) variables.push(existingGuard);
        arrayRangeGuardVariables.set(info.header, variables);
        const proven = new Set([
          ...(arrayRangeGuardNonZeroLocals.get(existingGuard) || []),
          ...(candidate.provenNonZeroSlots || []),
        ]);
        arrayRangeGuardNonZeroLocals.set(existingGuard, [...proven]);
        for (const plan of plans) {
          if (!plan?.lines) continue;
          plan.lines = plan.lines.map((line) =>
            line.replace(candidate.marker, existingGuard));
        }
        coalescedArrayRangeGuardCount += 1;
        continue;
      }
      arrayRangeGuardByCondition.set(guardKey, variable);
      candidate.rangeGuardVariable = variable;
      const declarations =
        arrayRangeGuardDeclarations.get(declarationHeader) || [];
      declarations.push(...preamble, `const ${variable} = ${condition};`);
      arrayRangeGuardDeclarations.set(declarationHeader, declarations);
      if (declarationHeader !== info.header) {
        hoistedArrayRangeGuardCount += 1;
      }
      // A guard emitted at its own first loop header is just as transactional
      // as one hoisted across nested loops when no guest effect precedes that
      // header. Version the complete entry region in either case: a failed
      // predicate returns to canonical execution before mutation, while the
      // successful arm can remove every dominated per-access check.
      const transactionalOwnHeader = declarationHeader === info.header &&
        info.increment > 1 && candidate.kind === "affine-local";
      if ((declarationHeader !== info.header || transactionalOwnHeader) &&
          !hasEffectBeforeLoopHeader(declarationHeader)) {
        trustedHoistedRangeGuards.add(variable);
        const bailouts = rangeBailoutGuardsByHeader.get(declarationHeader) || [];
        bailouts.push(variable);
        rangeBailoutGuardsByHeader.set(declarationHeader, bailouts);
      }
      if (selectedPackedAppend &&
          trustedHoistedRangeGuards.has(variable) &&
          Number.isInteger(selectedPackedAppend.slot) &&
          Number.isInteger(selectedPackedAppend.incrementsPerTrip) &&
          selectedPackedAppend.incrementsPerTrip > 0) {
        const lastItem = Math.max(...[...info.loopBlocks].flatMap(
          (loopBlock) => cfg.blocks[loopBlock]?.insns || []));
        if (!packedArrayCapacityFacts.some((fact) =>
          fact.arrayData === candidate.arrayData &&
          fact.cursorSlot === selectedPackedAppend.slot &&
          fact.lastItem === lastItem)) {
          packedArrayCapacityFacts.push({
            arrayData: candidate.arrayData,
            cursorSlot: selectedPackedAppend.slot,
            stride: selectedPackedAppend.incrementsPerTrip,
            lastItem,
            declarationHeader,
            tripsVariable: countedRangeTripValues.get(info.header)?.variable,
            guardVariable: variable,
          });
        }
      }
      const variables = arrayRangeGuardVariables.get(info.header) || [];
      variables.push(variable);
      arrayRangeGuardVariables.set(info.header, variables);
      arrayRangeGuardDataVariables.set(variable, candidate.arrayData);
      arrayRangeGuardNonZeroLocals.set(
        variable, candidate.provenNonZeroSlots || []);
      for (const plan of plans) {
        if (!plan?.lines) continue;
        plan.lines = plan.lines.map((line) =>
          line.replace(candidate.marker, variable));
      }
    }
    const provenDeferredStaticArrayAccesses = new Set();
    const itemBlocks = new Map();
    for (const candidateBlock of cfg.blocks) {
      for (const itemIndex of candidateBlock?.insns || []) {
        itemBlocks.set(itemIndex, candidateBlock.id);
      }
    }
    const localWriteSlot = (instruction) => {
      const op = opOf(instruction);
      if (op === "iinc") {
        return Number(instruction.varnum ?? instruction.arg);
      }
      return /^[a-z]store(?:_[0-3])?$/.test(op)
        ? localIndex(instruction, op) : null;
    };
    const directIntegerCopySource = (itemIndex) => {
      const instruction = items[itemIndex]?.instruction;
      const op = opOf(instruction);
      if (!/^istore(?:_[0-3])?$/.test(op)) return null;
      const blockId = itemBlocks.get(itemIndex);
      const blockItems = cfg.blocks[blockId]?.insns || [];
      const position = blockItems.indexOf(itemIndex);
      if (position <= 0) return null;
      const load = items[blockItems[position - 1]]?.instruction;
      const loadOp = opOf(load);
      return /^iload(?:_[0-3])?$/.test(loadOp)
        ? localIndex(load, loadOp) : null;
    };
    const isZeroIntegerStore = (itemIndex) => {
      const instruction = items[itemIndex]?.instruction;
      const op = opOf(instruction);
      if (!/^istore(?:_[0-3])?$/.test(op)) return false;
      const blockId = itemBlocks.get(itemIndex);
      const blockItems = cfg.blocks[blockId]?.insns || [];
      const position = blockItems.indexOf(itemIndex);
      return position > 0 && constantInstructionValue(
        items[blockItems[position - 1]]?.instruction) === 0;
    };
    const blockDominates = (candidate, target) => {
      if (candidate === target) return true;
      if (candidate === cfg.entry) return true;
      const pending = [cfg.entry];
      const visited = new Set([candidate]);
      while (pending.length) {
        const block = pending.pop();
        if (visited.has(block)) continue;
        if (block === target) return false;
        visited.add(block);
        for (const successor of cfg.succ[block] || []) {
          if (!visited.has(successor)) pending.push(successor);
        }
      }
      return true;
    };
    const itemDominates = (candidate, target) => {
      const candidateBlock = itemBlocks.get(candidate);
      const targetBlock = itemBlocks.get(target);
      if (!Number.isInteger(candidateBlock) ||
          !Number.isInteger(targetBlock)) return false;
      return candidateBlock === targetBlock
        ? candidate <= target
        : blockDominates(candidateBlock, targetBlock);
    };
    const localWrites = (slot, firstItem, lastItem = items.length - 1) => {
      const writes = [];
      for (let itemIndex = firstItem;
        itemIndex <= lastItem; itemIndex += 1) {
        if (!normalReachableItems.has(itemIndex)) continue;
        const instruction = items[itemIndex]?.instruction;
        if (localWriteSlot(instruction) === slot) {
          writes.push({itemIndex, instruction});
        }
      }
      return writes;
    };
    const matchingCursorLoopForWrite = (fact, cursorSlot, itemIndex) =>
      [...countedLoopInfos.values()].some((loop) =>
        loop.slot === cursorSlot && loop.boundSlot === fact.cursorSlot &&
        loop.increment === fact.stride && loop.loopBlocks.has(
          itemBlocks.get(itemIndex)));
    const boundedStrideCursorMemo = new Map();
    const compactingCursorFacts = [];
    const boundedStrideCursor = (fact, cursorSlot, throughItem) => {
      const key = `${packedArrayCapacityFacts.indexOf(fact)}:` +
        `${cursorSlot}:${throughItem}`;
      if (boundedStrideCursorMemo.has(key)) {
        return boundedStrideCursorMemo.get(key);
      }
      const writes = localWrites(
        cursorSlot, fact.lastItem + 1, throughItem);
      const initializations = writes.filter(({itemIndex}) =>
        isZeroIntegerStore(itemIndex));
      const increments = writes.filter(({instruction}) =>
        opOf(instruction) === "iinc" &&
        Number(instruction.incr ?? 0) === fact.stride);
      const initializedBeforeUse = initializations.length === 1 &&
        itemDominates(initializations[0].itemIndex, throughItem);
      const onlyBoundedUpdates =
        writes.length === initializations.length + increments.length &&
        increments.every(({itemIndex}) =>
          matchingCursorLoopForWrite(fact, cursorSlot, itemIndex));
      const boundChanged = localWrites(
        fact.cursorSlot, fact.lastItem + 1, throughItem).length > 0;
      const proven = initializedBeforeUse && onlyBoundedUpdates &&
        !boundChanged;
      boundedStrideCursorMemo.set(key, proven);
      return proven;
    };
    const compactingCursorRelation = (fact, access) => {
      const affine = access.indexAffine;
      if (!Number.isInteger(affine?.slot) ||
          !Number.isInteger(affine.offset) || affine.offset < 0 ||
          affine.offset >= fact.stride) return false;
      for (const scanLoop of countedLoopInfos.values()) {
        if (scanLoop.increment !== fact.stride ||
            !Number.isInteger(scanLoop.boundSlot) ||
            !scanLoop.loopBlocks.has(access.block) ||
            scanLoop.header === access.block ||
            !boundedStrideCursor(
              fact, scanLoop.boundSlot, access.itemIndex)) continue;
        const preheaderItems = cfg.blocks[scanLoop.preheader]?.insns || [];
        const scanInitializers = preheaderItems.filter((itemIndex) =>
          localWriteSlot(items[itemIndex]?.instruction) === scanLoop.slot &&
          Number.isInteger(directIntegerCopySource(itemIndex)));
        if (scanInitializers.length !== 1) continue;
        const scanInitializer = scanInitializers[0];
        const compactSlot = directIntegerCopySource(scanInitializer);
        if (!Number.isInteger(compactSlot) ||
            compactSlot === scanLoop.slot ||
            affine.slot !== scanLoop.slot && affine.slot !== compactSlot) {
          continue;
        }

        // The lagging cursor may advance once per scan iteration. Starting
        // equal to the scan cursor and using the same stride proves
        // `compact <= scan <= bound` at every loop header and
        // `compact + offset < capacity` at every marked access.
        const compactLoopWrites = [...scanLoop.loopBlocks].flatMap(
          (loopBlock) => (cfg.blocks[loopBlock]?.insns || [])
            .filter((itemIndex) =>
              localWriteSlot(items[itemIndex]?.instruction) === compactSlot));
        if (compactLoopWrites.length !== 1) continue;
        const compactIncrement =
          items[compactLoopWrites[0]]?.instruction;
        if (opOf(compactIncrement) !== "iinc" ||
            Number(compactIncrement.incr ?? 0) !== fact.stride) continue;

        const compactCopies = localWrites(
          compactSlot, fact.lastItem + 1)
          .filter(({instruction}) => opOf(instruction) !== "iinc");
        if (compactCopies.length !== 1) continue;
        const compactInitializer = compactCopies[0].itemIndex;
        const carriedSlot = directIntegerCopySource(compactInitializer);
        if (!Number.isInteger(carriedSlot) || carriedSlot === compactSlot ||
            carriedSlot === scanLoop.slot ||
            !itemDominates(compactInitializer, scanInitializer)) continue;

        const carriedZeroes = localWrites(
          carriedSlot, fact.lastItem + 1, compactInitializer)
          .filter(({itemIndex}) => isZeroIntegerStore(itemIndex));
        if (carriedZeroes.length !== 1) continue;
        const carriedZero = carriedZeroes[0].itemIndex;
        if (!itemDominates(carriedZero, compactInitializer)) continue;
        const carriedWrites = localWrites(carriedSlot, carriedZero);
        if (carriedWrites.length !== 2 ||
            !isZeroIntegerStore(carriedWrites[0].itemIndex)) continue;
        const carriedCopy = carriedWrites[1].itemIndex;
        if (directIntegerCopySource(carriedCopy) !== compactSlot) continue;

        const compactWrites = localWrites(compactSlot, carriedZero);
        if (compactWrites.length !== 2 ||
            compactWrites[0].itemIndex !== compactInitializer ||
            compactWrites[1].itemIndex !== compactLoopWrites[0]) continue;
        if (!compactingCursorFacts.some((relation) =>
          relation.fact === fact && relation.compactSlot === compactSlot &&
          relation.carriedSlot === carriedSlot &&
          relation.scanSlot === scanLoop.slot &&
          relation.boundSlot === scanLoop.boundSlot)) {
          compactingCursorFacts.push({
            fact,
            compactSlot,
            carriedSlot,
            scanSlot: scanLoop.slot,
            boundSlot: scanLoop.boundSlot,
            lastItem: Math.max(...[...scanLoop.loopBlocks].flatMap(
              (loopBlock) => cfg.blocks[loopBlock]?.insns || [])),
          });
        }
        return true;
      }
      return false;
    };
    for (const access of deferredStaticArrayAccesses) {
      const affine = access.indexAffine;
      if (!Number.isInteger(affine?.slot) ||
          !Number.isInteger(affine.offset)) continue;
      for (const fact of packedArrayCapacityFacts) {
        if (fact.arrayData !== access.arrayData ||
            fact.lastItem >= access.itemIndex || affine.offset < 0 ||
            affine.offset >= fact.stride) continue;
        const directlyBounded = [...countedLoopInfos.values()].some(
          (candidateLoop) =>
          candidateLoop.slot === affine.slot &&
          candidateLoop.boundSlot === fact.cursorSlot &&
          candidateLoop.increment === fact.stride &&
          candidateLoop.loopBlocks.has(access.block) &&
          candidateLoop.header !== access.block) &&
          boundedStrideCursor(fact, affine.slot, access.itemIndex);
        if (!directlyBounded &&
            !compactingCursorRelation(fact, access)) continue;
        provenDeferredStaticArrayAccesses.add(access.marker);
        break;
      }
    }
    // Once a packed append loop has established `cursor <= capacity`, reuse
    // that same entry-versioned predicate for later primitive accesses whose
    // cursors are structurally bounded by the packed cursor.  This is the
    // direct-view counterpart of deferred-static specialization above; the
    // proof is based on CFG/local recurrences, not field or method identity.
    for (const access of primitiveArrayAccessCandidates) {
      for (const fact of packedArrayCapacityFacts) {
        if (fact.arrayData !== access.arrayData ||
            typeof fact.guardVariable !== "string" ||
            fact.lastItem >= access.itemIndex ||
            !compactingCursorRelation(fact, access)) continue;
        for (const candidatePlan of plans) {
          if (!candidatePlan?.lines) continue;
          candidatePlan.lines = candidatePlan.lines.map((line) =>
            line.split(access.marker).join(fact.guardVariable));
        }
        access.structuralGuard = fact.guardVariable;
        if (access.rangeCandidate) {
          access.rangeCandidate.structuralGuard = fact.guardVariable;
        }
        break;
      }
    }
    let provenCheckedCallAdmissionCount = 0;
    let clippedAffineRegionAdmission = null;
    const checkedAdmissionOwnedCaptureRefreshes = new Set();
    let preflightedCheckedLeafVerifier = null;
    let preflightedCheckedLeafArgumentSlots = null;
    let preflightedCheckedLeafArgumentLimit = null;
    const argumentLocalSlot = (expression) => {
      const loaded = localLoads.get(expression);
      if (Number.isInteger(loaded)) return loaded;
      const direct = /^local(\d+)$/.exec(expression || "");
      return direct ? Number(direct[1]) : null;
    };
    for (const candidate of checkedCallAdmissionCandidates) {
      const candidateLines = plans[candidate.block]?.lines;
      if (!candidateLines) continue;
      const start = candidateLines.indexOf(candidate.startMarker);
      const end = candidateLines.indexOf(candidate.endMarker);
      if (start < 0 || end <= start) continue;
      const plan = candidate.plan;
      if (plan.kind === "clipped-affine-fill") {
        const xRange = candidate.argumentRanges[plan.xArgument];
        const countRange = candidate.argumentRanges[plan.countArgument];
        const captures = candidate.captureExpressions;
        const specializedCache = this.jit.checkedLeafCaptureCaches[
          candidate.captureCacheId];
        const specializedCaptures = Boolean(
          specializedCache?.specializationInitialized &&
          [
            plan.topCapture, plan.bottomCapture, plan.leftCapture,
            plan.rightCapture, plan.widthCapture,
          ].every((position) => Number.isInteger(
            specializedCache[`specializedValue${position}`])) &&
          specializedCache[`specializedValue${
            plan.arrayDataCapture}`] !== null);
        const captureExpression = (position) =>
          specializedCaptures && Number.isInteger(
            specializedCache[`specializedValue${position}`])
            ? String(specializedCache[`specializedValue${position}`] | 0)
            : specializedCaptures && position === plan.arrayDataCapture
              ? specializedCheckedCapture(
                candidate.captureCacheId, position)
              : captures[position];
        const indexedCaptures = [
          plan.topCapture, plan.bottomCapture, plan.leftCapture,
          plan.rightCapture, plan.widthCapture, plan.arrayDataCapture,
        ].map(captureExpression);
        const sumMinimum = xRange && countRange
          ? xRange.minimum + countRange.minimum : NaN;
        const sumMaximum = xRange && countRange
          ? xRange.maximum + countRange.maximum : NaN;
        const maximumSafeLeft = xRange && countRange
          ? Math.min(
            2147483647,
            2147483647 - countRange.maximum,
            countRange.minimum + xRange.minimum - (-2147483648),
          ) : NaN;
        if (candidate.replacement &&
            xRange && countRange && indexedCaptures.every(Boolean) &&
            Number.isInteger(candidate.captureCacheId) &&
            typeof candidate.captureCacheVariable === "string" &&
            sumMinimum >= -2147483648 && sumMaximum <= 2147483647 &&
            Number.isSafeInteger(maximumSafeLeft) &&
            Number.isInteger(plan.maximumTrips) &&
            plan.maximumTrips > 0) {
          const [top, bottom, left, right, width, arrayDataCapture] =
            indexedCaptures;
          const guard = `ssaCheckedAdmissionGuard${
            directCheckedAdmissionFallbacks.size}`;
          const derivedGuardKey =
            this.jit.registerCheckedLeafCaptureDerivedGuard(
              candidate.captureCacheId);
          const guardCondition =
            `${arrayDataCapture} !== null && ${top} >= 0 && ` +
            `${bottom} >= ${top} && ${left} >= 0 && ` +
            `${bottom} - ${top} <= ${plan.maximumTrips} && ` +
            `${left} <= ${maximumSafeLeft} && ${right} >= ${left} && ` +
            `${right} - ${left} <= ${plan.maximumTrips} && ` +
            `${width} > 0 && ${right} <= ${width} && ` +
            `${bottom} <= Math.floor(2147483647 / ${width}) && ` +
            `${bottom} <= Math.floor(${arrayDataCapture}.length / ${width})`;
          const preferOutlinedClippedLeaf =
            specializedCaptures &&
            structured.loopHeaders.size === 1 &&
            callSites.size === 1;
          if (specializedCaptures) {
            checkedAdmissionOwnedCaptureRefreshes.add(
              candidate.captureCacheId);
            const verifier = `ssaCheckedAdmissionVerifier${
              candidate.captureCacheId}_${derivedGuardKey}`;
            const cache = specializedCache;
            const jit = this.jit;
            const specializedArray = cache[
              `specializedValue${plan.arrayDataCapture}`];
            methodSpecializedCheckedCaptures[verifier] = () => {
              if (cache.dirty) {
                jit.refreshCheckedLeafCaptureCache(candidate.captureCacheId);
              }
              if (!cache.specializedMatches) return false;
              const topValue = cache[
                `specializedValue${plan.topCapture}`] | 0;
              const bottomValue = cache[
                `specializedValue${plan.bottomCapture}`] | 0;
              const leftValue = cache[
                `specializedValue${plan.leftCapture}`] | 0;
              const rightValue = cache[
                `specializedValue${plan.rightCapture}`] | 0;
              const widthValue = cache[
                `specializedValue${plan.widthCapture}`] | 0;
              const accepted = specializedArray !== null &&
                topValue >= 0 && bottomValue >= topValue &&
                leftValue >= 0 &&
                bottomValue - topValue <= plan.maximumTrips &&
                leftValue <= maximumSafeLeft &&
                rightValue >= leftValue &&
                rightValue - leftValue <= plan.maximumTrips &&
                widthValue > 0 && rightValue <= widthValue &&
                bottomValue <= Math.floor(2147483647 / widthValue) &&
                bottomValue <= Math.floor(
                  specializedArray.length / widthValue);
              cache[derivedGuardKey] = accepted;
              return accepted;
            };
            // Initial class/static resolution happened during compilation;
            // prime the versioned predicate so the first admitted execution
            // has the same one-branch entry as subsequent executions.
            methodSpecializedCheckedCaptures[verifier]();
            if (preferOutlinedClippedLeaf) {
              preflightedCheckedLeafVerifier =
                methodSpecializedCheckedCaptures[verifier];
            }
            directEntryCheckedAdmissionDeclarations.push(
              `if (${candidate.captureCacheVariable}.${derivedGuardKey} ` +
                `!== true && !${verifier}()) ` +
                "return helpers.asyncInvokeSentinel();",
            );
          } else {
            directEntryCheckedAdmissionDeclarations.push(
              `let ${guard} = ${candidate.captureCacheVariable}.` +
                `${derivedGuardKey};`,
              `if (${guard} === undefined) {`,
              `  ${guard} = (${guardCondition});`,
              `  ${candidate.captureCacheVariable}.${derivedGuardKey} = ` +
                `${guard};`,
              `}`,
              `if (!${guard}) return helpers.asyncInvokeSentinel();`,
            );
          }
          let admittedReplacement = candidate.replacement;
          if (preferOutlinedClippedLeaf) {
            const helper = `ssaCheckedClippedFill${candidate.itemIndex}`;
            hasOutlinedClippedLeaf = true;
            const topValue = specializedCache[
              `specializedValue${plan.topCapture}`] | 0;
            const bottomValue = specializedCache[
              `specializedValue${plan.bottomCapture}`] | 0;
            const leftValue = specializedCache[
              `specializedValue${plan.leftCapture}`] | 0;
            const rightValue = specializedCache[
              `specializedValue${plan.rightCapture}`] | 0;
            const widthValue = specializedCache[
              `specializedValue${plan.widthCapture}`] | 0;
            const destination = specializedCache[
              `specializedValue${plan.arrayDataCapture}`];
            methodSpecializedCheckedCaptures[helper] =
              function (x, y, count, value) {
                if (y < topValue || y >= bottomValue) return;
                if (x < leftValue) {
                  count -= leftValue - x;
                  x = leftValue;
                }
                if (x + count > rightValue) count = rightValue - x;
                if (count <= 0) return;
                let pixel = y * widthValue + x;
                for (const end = pixel + count; pixel < end; pixel += 1) {
                  destination[pixel] = value;
                }
              };
            admittedReplacement = [
              `${helper}(${[
                plan.xArgument, plan.yArgument,
                plan.countArgument, plan.valueArgument,
              ].map((position) => candidate.args[position]).join(", ")}); ` +
                "/*__SSA_SAFE_ARITHMETIC_CALL__*/",
            ];
          }
          const marker = `__JVM_DIRECT_CHECKED_ADMISSION_${
            directCheckedAdmissionFallbacks.size}__`;
          directCheckedAdmissionFallbacks.set(marker, {
            direct: admittedReplacement,
            ordinary: candidateLines.slice(start + 1, end),
          });
          candidateLines.splice(start, end - start + 1, marker);
          provenCheckedCallAdmissionCount += 1;
          clippedAffineRegionAdmission = {
            top,
            bottom,
            maximumTrips: plan.maximumTrips,
          };
        } else {
          candidateLines.splice(end, 1);
          candidateLines.splice(start, 1);
        }
        continue;
      }
      const arrayData = candidate.argumentArrays[plan.arrayArgument]?.data;
      const lowerExpression = candidate.args[plan.lowerArgument];
      const lowerSlot = argumentLocalSlot(lowerExpression);
      const upperSlot = argumentLocalSlot(
        candidate.args[plan.upperArgument]);
      const lowerIsZero = /^\(?0\)?$/.test(lowerExpression || "");
      const fact = packedArrayCapacityFacts.find((capacity) =>
        capacity.arrayData === arrayData &&
        capacity.cursorSlot === upperSlot &&
        capacity.stride === plan.stride &&
        capacity.lastItem < candidate.itemIndex &&
        localWrites(upperSlot, capacity.lastItem + 1,
          candidate.itemIndex).length === 0);
      const compactingFact = compactingCursorFacts.find((relation) => {
          const lowerWritesAfter = localWrites(
            lowerSlot, relation.lastItem + 1, candidate.itemIndex);
          const lowerPreserved = lowerWritesAfter.length === 0 ||
            lowerWritesAfter.length === 1 &&
            directIntegerCopySource(lowerWritesAfter[0].itemIndex) ===
              relation.compactSlot &&
            itemDominates(lowerWritesAfter[0].itemIndex,
              candidate.itemIndex);
          return relation.fact.arrayData === arrayData &&
            relation.fact.stride === plan.stride &&
            relation.carriedSlot === lowerSlot &&
            relation.boundSlot === upperSlot &&
            relation.lastItem < candidate.itemIndex && lowerPreserved &&
            localWrites(upperSlot, relation.lastItem + 1,
              candidate.itemIndex).length === 0;
      });
      const capacityFact = lowerIsZero && fact
        ? fact : compactingFact?.fact;
      if (capacityFact) {
        const maximumRecords = Number(plan.maximumRecords);
        const needsTighterTripGuard = Number.isInteger(maximumRecords) &&
          maximumRecords > 0 &&
          maximumRecords < runtimeCoarseTripLimit;
        if (needsTighterTripGuard &&
            Number.isInteger(capacityFact.declarationHeader) &&
            typeof capacityFact.tripsVariable === "string") {
          const guard = `ssaCheckedAdmissionGuard${
            directCheckedAdmissionFallbacks.size}`;
          const declarations = arrayRangeGuardDeclarations.get(
            capacityFact.declarationHeader) || [];
          declarations.push(`const ${guard} = ` +
            `${capacityFact.tripsVariable} <= ${maximumRecords};`);
          arrayRangeGuardDeclarations.set(
            capacityFact.declarationHeader, declarations);
          const bailouts = rangeBailoutGuardsByHeader.get(
            capacityFact.declarationHeader) || [];
          bailouts.push(guard);
          rangeBailoutGuardsByHeader.set(
            capacityFact.declarationHeader, bailouts);
          const marker = `__JVM_DIRECT_CHECKED_ADMISSION_${
            directCheckedAdmissionFallbacks.size}__`;
          directCheckedAdmissionFallbacks.set(marker, {
            direct: candidate.replacement,
            ordinary: candidateLines.slice(start + 1, end),
          });
          candidateLines.splice(start, end - start + 1, marker);
          provenCheckedCallAdmissionCount += 1;
        } else if (!needsTighterTripGuard) {
          candidateLines.splice(
            start, end - start + 1, ...candidate.replacement);
          provenCheckedCallAdmissionCount += 1;
        } else {
          candidateLines.splice(end, 1);
          candidateLines.splice(start, 1);
        }
      } else {
        candidateLines.splice(end, 1);
        candidateLines.splice(start, 1);
      }
    }
    // A fully admitted packed-record scan feeding one clipped affine writer
    // has a finite structural work bound.  Guard the conservative
    // `records² * rows` product before the first guest effect, then make every
    // loop in the admitted region scheduler-atomic. Large or unusual inputs
    // return to canonical execution; the ordinary path retains all polls.
    // This relies only on the verified capacity/compaction/callee contracts.
    if (clippedAffineRegionAdmission &&
        checkedCallAdmissionCandidates.length === callSites.size &&
        provenCheckedCallAdmissionCount === callSites.size &&
        packedArrayCapacityFacts.length === 1 &&
        compactingCursorFacts.length > 0 &&
        (code.code.exceptionTable || []).length === 0) {
      const fact = packedArrayCapacityFacts[0];
      entryDominatedRangeGuards.add(fact.guardVariable);
      const records = "ssaPackedAtomicRecords";
      const rows = "ssaPackedAtomicRows";
      directEntryCheckedAdmissionDeclarations.push(
        `const ${records} = ${fact.arrayData} === null ? ` +
          `${clippedAffineRegionAdmission.maximumTrips + 1} : ` +
          `Math.ceil(${fact.arrayData}.length / ${fact.stride});`,
        `const ${rows} = ${clippedAffineRegionAdmission.bottom} - ` +
          `${clippedAffineRegionAdmission.top};`,
        `if (${records} < 0 || ${records} > ` +
          `${clippedAffineRegionAdmission.maximumTrips} || ${rows} < 0 || ` +
          `${records} * ${records} * ${rows} > 1000000) ` +
          "return helpers.asyncInvokeSentinel();",
      );
      const regionRangeGuards = new Set();
      for (const access of primitiveArrayAccessCandidates) {
        const affine = access.indexAffine;
        if (access.arrayData !== fact.arrayData ||
            !Number.isInteger(affine?.slot) ||
            !Number.isInteger(affine.offset) || affine.offset < 0 ||
            affine.offset >= fact.stride) continue;
        const bounded = boundedStrideCursor(
          fact, affine.slot, access.itemIndex) ||
          compactingCursorRelation(fact, access);
        const variable = access.rangeCandidate?.rangeGuardVariable;
        if (bounded && typeof variable === "string" &&
            variable !== fact.guardVariable) {
          regionRangeGuards.add(variable);
        }
      }
      if (regionRangeGuards.size) {
        for (const [header, declarations] of arrayRangeGuardDeclarations) {
          arrayRangeGuardDeclarations.set(header, declarations.filter(
            (line) => ![...regionRangeGuards].some((variable) =>
              line.startsWith(`const ${variable} = `))));
        }
        for (const [header, variables] of arrayRangeGuardVariables) {
          arrayRangeGuardVariables.set(header, [...new Set(variables.map(
            (variable) => regionRangeGuards.has(variable)
              ? fact.guardVariable : variable))]);
        }
        for (const [header, variables] of rangeBailoutGuardsByHeader) {
          // The packed capacity guard already bails at its dominating
          // pre-effect header. A later loop does not need to retest it.
          rangeBailoutGuardsByHeader.set(header, [...new Set(
            variables.filter((variable) =>
              !regionRangeGuards.has(variable) &&
              !(variable === fact.guardVariable &&
                header !== fact.declarationHeader))) ]);
        }
        for (const candidatePlan of plans) {
          if (!candidatePlan?.lines) continue;
          candidatePlan.lines = candidatePlan.lines.map((line) => {
            let rewritten = line;
            for (const variable of regionRangeGuards) {
              rewritten = rewritten.replace(
                new RegExp(`\\b${variable}\\b`, "g"),
                fact.guardVariable);
            }
            return rewritten;
          });
        }
      }
      for (const header of structured.loopHeaders) {
        coarseCountedLoops.set(
          header, clippedAffineRegionAdmission.maximumTrips);
      }
    }
    // Several primitive accesses in one straight-line block commonly use
    // the same cursor with nearby fixed offsets.  Compute their joint range
    // predicate once and let every canonical access short-circuit through it.
    // If the predicate fails, each original check and its precise exception
    // materialization remain intact, so stores performed before a later
    // failure retain normal JVM semantics.  Java array lengths are immutable;
    // requiring the cursor local to be unwritten between the accesses makes
    // the shared successful proof valid for the complete group.
    let blockCoalescedArrayRangeAccessCount = 0;
    const primitiveGroups = new Map();
    for (const access of primitiveArrayAccessCandidates) {
      if (access.structuralGuard ||
          !Number.isInteger(access.indexAffine?.slot) ||
          !Number.isInteger(access.indexAffine.offset)) continue;
      const key = `${access.block}\0${access.arrayData}\0` +
        `${access.indexAffine.slot}\0${access.indexAffine.baseExpression}`;
      const group = primitiveGroups.get(key) || [];
      group.push(access);
      primitiveGroups.set(key, group);
    }
    for (const group of primitiveGroups.values()) {
      if (group.length < 2) continue;
      group.sort((left, right) => left.itemIndex - right.itemIndex);
      const first = group[0];
      const last = group[group.length - 1];
      if (typeof first.indexAffine.baseExpression !== "string") continue;
      if (localWrites(first.indexAffine.slot, first.itemIndex,
        last.itemIndex).length !== 0) continue;
      const offsets = group.map((access) => access.indexAffine.offset);
      const minimumOffset = Math.min(...offsets);
      const maximumOffset = Math.max(...offsets);
      if (!Number.isSafeInteger(minimumOffset) ||
          !Number.isSafeInteger(maximumOffset) ||
          minimumOffset < -2147483648 || maximumOffset > 2147483647) {
        continue;
      }
      const variable = `ssaBlockArrayRangeGuard${
        blockCoalescedArrayRangeAccessCount}`;
      let applied = false;
      for (const candidatePlan of plans) {
        if (!candidatePlan?.lines) continue;
        const markerIndexes = group.map((access) =>
          candidatePlan.lines.findIndex((line) =>
            line.includes(access.marker)));
        if (markerIndexes.some((lineIndex) => lineIndex < 0)) continue;
        const declarationIndex = Math.min(...markerIndexes);
        const base = first.indexAffine.baseExpression;
        const minimum = `(((${base}) + ${minimumOffset}) | 0)`;
        const maximum = `(((${base}) + ${maximumOffset}) | 0)`;
        candidatePlan.lines.splice(declarationIndex, 0,
          `const ${variable} = (${minimum} >= 0 && ${maximum} >= ` +
            `${minimum} && ${maximum} < ${first.arrayData}.length);`);
        candidatePlan.lines = candidatePlan.lines.map((line) => {
          let rewritten = line;
          for (const access of group) {
            rewritten = rewritten.split(access.marker).join(variable);
          }
          return rewritten;
        });
        applied = true;
      }
      if (applied) {
        blockCoalescedArrayRangeAccessCount += group.length - 1;
      }
    }
    for (const candidate of primitiveArrayAccessCandidates) {
      const fallback = candidate.structuralGuard
        ? `false /*${candidate.marker}*/` : "false";
      for (const plan of plans) {
        if (!plan?.lines) continue;
        plan.lines = plan.lines.map((line) =>
          line.split(candidate.marker).join(fallback));
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
      const provenArrayData = new Set(guardVariables
        .map((variable) => arrayRangeGuardDataVariables.get(variable))
        .filter(Boolean));
      const provenNonNullEntryReferences = new Set(
        [...eagerFieldArrayDataByLocal]
          .filter(([_slot, arrays]) =>
            arrays.some((data) => provenArrayData.has(data)))
          .map(([slot]) => slot));
      const provenNonZeroLocals = new Set(guardVariables.flatMap(
        (variable) => [
          ...(arrayRangeGuardNonZeroLocals.get(variable) || []),
          ...(loopInvariantDivisorGuardNonZeroLocals.get(variable) || []),
        ]));
      const specializeGuardedValue = (line) => {
        for (const variable of guardVariables) {
          const marker = ` = ${variable} ? `;
          const conditional = line.indexOf(marker);
          let alternate = -1;
          let nestedConditionalDepth = 0;
          let quote = null;
          let escaped = false;
          for (let index = conditional + marker.length;
            conditional >= 0 && index < line.length - 2; index += 1) {
            const character = line[index];
            if (quote) {
              if (escaped) escaped = false;
              else if (character === "\\") escaped = true;
              else if (character === quote) quote = null;
              continue;
            }
            if (character === '"' || character === "'" ||
                character === "`") {
              quote = character;
              continue;
            }
            if (character === "?") {
              nestedConditionalDepth += 1;
              continue;
            }
            if (line.slice(index, index + 3) !== " : ") continue;
            if (nestedConditionalDepth > 0) {
              nestedConditionalDepth -= 1;
              index += 2;
              continue;
            }
            alternate = index;
            break;
          }
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
        const zeroGuard = /^if \((ssaValue\d+) === 0\) \{$/.exec(trimmed);
        const zeroGuardSlot = zeroGuard && localLoads.get(zeroGuard[1]);
        if (Number.isInteger(zeroGuardSlot) &&
            provenNonZeroLocals.has(zeroGuardSlot)) {
          const closeLine = `${indentPrefix}}`;
          let close = index + 1;
          while (close < lines.length && lines[close] !== closeLine) close += 1;
          if (close < lines.length) {
            const key = `${zeroGuardSlot}\0${trimmed}`;
            if (!rangeDominatedArithmeticGuards.has(key)) {
              rangeDominatedArithmeticGuards.add(key);
              rangeDominatedArithmeticGuardCount += 1;
            }
            index = close;
            continue;
          }
        }
        const inlineNonZeroGuard =
          /^if \(!\(.+\(\((ssaValue\d+)\) !== 0\).+\) \{$/.exec(trimmed);
        const inlineNonZeroSlot = inlineNonZeroGuard &&
          localLoads.get(inlineNonZeroGuard[1]);
        if (Number.isInteger(inlineNonZeroSlot) &&
            provenNonZeroLocals.has(inlineNonZeroSlot)) {
          const closeLine = `${indentPrefix}}`;
          let close = index + 1;
          while (close < lines.length && lines[close] !== closeLine) close += 1;
          if (close < lines.length && lines.slice(index + 1, close).some(
            (candidate) => candidate.includes(
              "reason: 'guarded inline integer leaf'"))) {
            const key = `${inlineNonZeroSlot}\0${trimmed}`;
            if (!rangeDominatedArithmeticGuards.has(key)) {
              rangeDominatedArithmeticGuards.add(key);
              rangeDominatedArithmeticGuardCount += 1;
            }
            index = close;
            continue;
          }
        }
        const nonNullBranch =
          /^if \(!\((ssaValue\d+) === null\)\) \{$/.exec(trimmed);
        const nonNullReferenceSlot = nonNullBranch &&
          entryReferenceLoads.get(nonNullBranch[1]);
        if (this.dominatedFieldReceiverChecksEnabled &&
            Number.isInteger(nonNullReferenceSlot) &&
            provenNonNullEntryReferences.has(nonNullReferenceSlot)) {
          const closeLine = `${indentPrefix}}`;
          let close = index + 1;
          while (close < lines.length && lines[close] !== closeLine) close += 1;
          if (close < lines.length) {
            const key = `${nonNullReferenceSlot}\0${trimmed}`;
            if (!dominatedEntryReferenceNullBranches.has(key)) {
              dominatedEntryReferenceNullBranches.add(key);
              dominatedEntryReferenceNullBranchCount += 1;
            }
            const nestedPrefix = `${indentPrefix}  `;
            const nonNullLines = lines.slice(index + 1, close).map(
              (nonNullLine) => nonNullLine.startsWith(nestedPrefix)
                ? `${indentPrefix}${nonNullLine.slice(nestedPrefix.length)}`
                : nonNullLine);
            output.push(...specializeArrayRangeGuardedStores(
              nonNullLines, guardVariables));
            index = close;
            continue;
          }
        }
        const nullBranch = /^if \((ssaValue\d+) === null\) \{$/.exec(trimmed);
        const referenceSlot = nullBranch && entryReferenceLoads.get(nullBranch[1]);
        if (this.dominatedFieldReceiverChecksEnabled &&
            Number.isInteger(referenceSlot) &&
            provenNonNullEntryReferences.has(referenceSlot)) {
          const elseLine = `${indentPrefix}} else {`;
          const closeLine = `${indentPrefix}}`;
          let alternate = index + 1;
          while (alternate < lines.length && lines[alternate] !== elseLine) {
            alternate += 1;
          }
          let close = alternate + 1;
          while (close < lines.length && lines[close] !== closeLine) close += 1;
          if (alternate < lines.length && close < lines.length) {
            const key = `${referenceSlot}\0${trimmed}`;
            if (!dominatedEntryReferenceNullBranches.has(key)) {
              dominatedEntryReferenceNullBranches.add(key);
              dominatedEntryReferenceNullBranchCount += 1;
            }
            const nestedPrefix = `${indentPrefix}  `;
            const nonNullLines = lines.slice(alternate + 1, close).map(
              (nonNullLine) => nonNullLine.startsWith(nestedPrefix)
                ? `${indentPrefix}${nonNullLine.slice(nestedPrefix.length)}`
                : nonNullLine);
            output.push(...specializeArrayRangeGuardedStores(
              nonNullLines, guardVariables));
            index = close;
            continue;
          }
        }
        const receiverCheck =
          /^if \((ssaValue\d+) === null \|\| \1 === undefined\) \{$/.exec(
            trimmed);
        const receiverArrayData = receiverCheck &&
          eagerFieldReceiverNullChecks.get(receiverCheck[1]);
        if (this.dominatedFieldReceiverChecksEnabled &&
            receiverArrayData && provenArrayData.has(receiverArrayData)) {
          // The active loop version is dominated by an array-range predicate
          // whose first conjunct proves this eager field cache has non-null
          // backing data. Eager-local admission separately proves that the
          // receiver is the unchanged entry local and that no call/write can
          // invalidate the field before this access. Therefore the getfield
          // null path is impossible in this arm. Keep it verbatim in the slow
          // loop so a null receiver still materializes the exact getfield PC.
          const closeLine = `${indentPrefix}}`;
          let close = index + 1;
          while (close < lines.length && lines[close] !== closeLine) close += 1;
          if (close < lines.length) {
            const key = `${receiverArrayData}\0${trimmed}`;
            if (!dominatedFieldReceiverChecks.has(key)) {
              dominatedFieldReceiverChecks.add(key);
              dominatedFieldReceiverCheckCount += 1;
            }
            index = close;
            continue;
          }
        }
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
    let dominatedArithmeticGuardCount = cfgDominatedArithmeticGuardCount;
    const deferredStaticArrayAccessByMarker = new Map(
      deferredStaticArrayAccesses.map((access) => [access.marker, access]));
    const specializeDeferredStaticArrayAccessLines = (lines, trusted) => {
      const output = [];
      for (let index = 0; index < lines.length; index += 1) {
        const start = /^\/\*(__SSA_DEFERRED_STATIC_ARRAY_ACCESS_\d+__):start\*\/$/
          .exec(lines[index]);
        if (!start) {
          output.push(lines[index]);
          continue;
        }
        const access = deferredStaticArrayAccessByMarker.get(start[1]);
        const end = `/*${start[1]}:end*/`;
        let close = index + 1;
        while (close < lines.length && lines[close] !== end) close += 1;
        if (!access || close >= lines.length) {
          output.push(lines[index]);
          continue;
        }
        if (trusted && provenDeferredStaticArrayAccesses.has(start[1])) {
          output.push(...access.directLines);
        } else {
          output.push(...lines.slice(index + 1, close));
        }
        index = close;
      }
      return output;
    };
    const removeTerminalBreakTo = (node, label) => {
      if (!node) return node;
      if (node.t === "break" && node.label === label) {
        eliminatedTerminalStructuredBreakCount += 1;
        return {t: "seq", body: []};
      }
      if (node.t === "seq" && node.body.length) {
        const body = [...node.body];
        body[body.length - 1] = removeTerminalBreakTo(
          body[body.length - 1], label);
        return {...node, body};
      }
      if (node.t === "if") {
        return {
          ...node,
          then: removeTerminalBreakTo(node.then, label),
          els: removeTerminalBreakTo(node.els, label),
        };
      }
      if (node.t === "block") {
        return {...node, body: removeTerminalBreakTo(node.body, label)};
      }
      // A break from within a loop changes that loop's control flow even when
      // the loop node is terminal in the surrounding block.
      return node;
    };
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
        const expandLines = (sourceLines) => sourceLines.flatMap((line) => {
          const directStaticRead =
            directEntryStaticReadFallbacks.get(line);
          if (directStaticRead) {
            return directPositional
              ? directStaticRead.direct : directStaticRead.ordinary;
          }
          const checkedAdmission = directCheckedAdmissionFallbacks.get(line);
          if (checkedAdmission) {
            return directPositional && rangeBailout
              ? checkedAdmission.direct : checkedAdmission.ordinary;
          }
          const fallback = continuationFallbacks.get(line);
          if (!fallback) return [line];
          const selected = checkedLeafOnly && fallback.checkedLeaf
            ? fallback.checkedLeaf
            : continuationMode ? fallback.continuation : fallback.ordinary;
          return expandLines(selected);
        });
        const lines = expandLines(specializeDeferredStaticArrayAccessLines(
          plan.lines, directPositional && rangeBailout));
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
        if (elseLines.length === 0) {
          return [`if (${plan.condition}) {`, ...indent(thenLines), "}"];
        }
        if (thenLines.length === 0) {
          return [`if (!(${plan.condition})) {`, ...indent(elseLines), "}"];
        }
        const breakTarget = (line) =>
          /^break (L\d+);$/.exec(line)?.[1] || null;
        const thenBreak = thenLines.length === 1
          ? breakTarget(thenLines[0]) : null;
        const elseBreak = elseLines.length > 0
          ? breakTarget(elseLines[elseLines.length - 1]) : null;
        if (thenBreak && thenBreak === elseBreak) {
          return [
            `if (!(${plan.condition})) {`,
            ...indent(elseLines.slice(0, -1)),
            "}",
            `break ${thenBreak};`,
          ];
        }
        const fallBreak = elseLines.length === 1
          ? breakTarget(elseLines[0]) : null;
        const takenBreak = thenLines.length > 0
          ? breakTarget(thenLines[thenLines.length - 1]) : null;
        if (fallBreak && fallBreak === takenBreak) {
          return [
            `if (${plan.condition}) {`,
            ...indent(thenLines.slice(0, -1)),
            "}",
            `break ${fallBreak};`,
          ];
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
        const checkedLeafCoarse = checkedLeafOnly &&
          checkedLeafCoarseLoopHeaders.has(header);
        const coarse = coarseCountedLoops.has(header) || checkedLeafCoarse;
        // The checked-leaf entry has already charged and bounded the complete
        // nested region. Recomputing an inner trip count on every outer
        // iteration cannot lead to a scheduler poll and only obscures the
        // ordinary numeric loop from the host optimizer.
        const runtimeCoarse = coarse
          ? null : runtimeCoarseCountedLoops.get(header);
        const rangeGuards = this.versionedArrayRangeStoresEnabled
          ? arrayRangeGuardVariables.get(header) || [] : [];
        const invariantDivisorGuard = loopInvariantDivisorGuards.get(header);
        const specializationGuards = [
          ...rangeGuards,
          ...(invariantDivisorGuard ? [invariantDivisorGuard.variable] : []),
        ];
        const loopBody = render(node.body, continuationMode, directPositional,
          loopSafePointBudget, checkedLeafOnly, rangeBailout);
        const countedLoop = canonicalCountedLoop(header, node.label, loopBody) ||
          canonicalPostDecrementLoop(node.label, loopBody);
        const entryBailoutGuards = directPositional && rangeBailout
          ? rangeBailoutGuardsByHeader.get(header) || [] : [];
        const prefix = [
          ...(arrayRangeGuardDeclarations.get(header) || []),
          ...(invariantDivisorGuard
            ? [invariantDivisorGuard.declaration] : []),
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
        const unpolledLoop = [
          `${node.label}: while (${countedLoop
            ? countedLoop.condition : "true"}) {`,
          ...indent(countedLoop ? countedLoop.body : loopBody), "}",
          ...(countedLoop ? countedLoop.exit : []),
        ];
        // A restoring entry can transfer an unexpectedly large loop back to
        // canonical execution at the exact loop-header state. For the common
        // bounded case, turn the already-computed trip/overflow predicate
        // into an entry version instead of testing `!coarse` at every
        // backedge. This is the same scheduler behavior as the old runtime
        // branch: admitted loops were already charged once and atomic; only
        // rejected loops now reconstruct before their first iteration.
        const restoringCoarseLoopBailout = Boolean(
          directPositional && rangeBailout && runtimeCoarse && !coarse &&
          countedLoop && countedLoopInfos.get(header)?.increment > 0 &&
          this.restoringRangeGuardDeoptEnabled);
        if (restoringCoarseLoopBailout && specializationGuards.length === 0) {
          restoringCoarseLoopDeoptCount += 1;
          return [
            ...prefix,
            `if (!${runtimeCoarse.variable}) {`,
            ...indent([
              "spillLocals();",
              ...restoreLines,
              "helpers.skipJitOnce(frame);",
              "return { deopt: true, transient: true, " +
                "reason: 'structured SSA coarse loop guard' };",
            ]),
            "}",
            ...unpolledLoop,
          ];
        }
        const tripBoundedSpecialization = specializationGuards.some((guard) =>
          tripBoundedArrayRangeGuards.has(guard));
        const entryDominatedFastLoop = Boolean(
          directPositional && rangeBailout && coarse &&
          specializationGuards.length > 0 &&
          specializationGuards.every((guard) =>
            entryDominatedRangeGuards.has(guard)));
        if (entryDominatedFastLoop) {
          return [
            ...prefix,
            `${node.label}: while (${countedLoop
              ? countedLoop.condition : "true"}) {`,
            ...indent(specializeArrayRangeGuardedStores(
              countedLoop ? countedLoop.body : loopBody,
              specializationGuards)),
            "}",
            ...(countedLoop ? countedLoop.exit : []),
          ];
        }
        const rangeBailoutFastLoop = Boolean(
          directPositional && rangeBailout &&
          (coarse || runtimeCoarse || tripBoundedSpecialization) &&
          specializationGuards.length > 0 &&
          rangeGuards.every((guard) =>
            trustedHoistedRangeGuards.has(guard)) &&
          countedLoopInfos.get(header)?.initial === 0 &&
          (countedLoopInfos.get(header)?.increment === 1 ||
            tripBoundedSpecialization));
        if (rangeBailoutFastLoop) {
          return [
            ...prefix,
            `${node.label}: while (${countedLoop
              ? countedLoop.condition : "true"}) {`,
            ...indent(specializeArrayRangeGuardedStores(
              countedLoop ? countedLoop.body : loopBody,
              specializationGuards)),
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
            specializationGuards.length > 0 &&
            (coarse || runtimeCoarse && !coarse &&
              this.versionedRuntimeCoarseLoopsEnabled ||
              specializationGuards.some((guard) =>
                tripBoundedArrayRangeGuards.has(guard)))) {
          // Put the verified range predicates on the outer fast-loop edge.
          // Inside that dominated arm optimizing JavaScript engines can fold
          // every `!rangeGuard && boundsCheck` store branch away. The other
          // arm retains the exact per-store exception materialization.
          const fastLoopCondition = [
            ...(runtimeCoarse && !coarse ? [runtimeCoarse.variable] : []),
            ...specializationGuards,
          ].join(" && ");
          const fastLoopBody = specializeArrayRangeGuardedStores(
            countedLoop ? countedLoop.body : loopBody,
            specializationGuards);
          const specializedUnpolledLoop = [
            `${node.label}: while (${countedLoop
              ? countedLoop.condition : "true"}) {`,
            ...indent(fastLoopBody), "}",
            ...(countedLoop ? countedLoop.exit : []),
          ];
          if (directPositional && rangeBailout && !checkedLeafOnly &&
              this.restoringRangeGuardDeoptEnabled) {
            restoringRangeGuardDeoptCount += 1;
            return [
              ...prefix,
              `if (!(${fastLoopCondition})) {`,
              ...indent([
                "spillLocals();",
                ...restoreLines,
                "helpers.skipJitOnce(frame);",
                "return { deopt: true, transient: true, " +
                  "reason: 'structured SSA range guard' };",
              ]),
              "}",
              ...specializedUnpolledLoop,
            ];
          }
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
              ...specializedUnpolledLoop,
            ];
          }
          return [
            ...prefix,
            `if (${fastLoopCondition}) {`,
            ...indent(specializedUnpolledLoop),
            "} else {",
            ...indent(polledLoop),
            "}",
          ];
        }
        return [...prefix, ...polledLoop];
      }
      if (node.t === "block") {
        const body = removeTerminalBreakTo(node.body, node.label);
        const rendered = render(body, continuationMode, directPositional,
          loopSafePointBudget, checkedLeafOnly, rangeBailout);
        if (!rendered.some((line) =>
          line.trim() === `break ${node.label};`)) {
          eliminatedStructuredBlockCount += 1;
          return rendered;
        }
        return [`${node.label}: {`, ...indent(rendered), "}"];
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
            `let ${cache.value} = ${cache.valid} ? ` +
              `${normalizeJvmScalarExpression(read, cache.descriptor)} : undefined;`,
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
          `let ${cache.value} = ` +
            `${normalizeJvmScalarExpression(read, cache.descriptor)};`,
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
              `let ${cache.value} = ` +
                `${normalizeJvmScalarExpression(read, cache.descriptor)};`,
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
            `${cache.value} = ` +
              `${normalizeJvmScalarExpression(cache.value, cache.descriptor)};`,
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
    const positionalCallDeclarationsFor = (
      omitSelfRecursive = false,
      alwaysRefreshCaptures = false,
    ) => {
      const lines = [];
      const captureSections = [];
      for (const [index, site] of [...callSites].filter(([, candidate]) =>
        candidate.id !== null && candidate.id !== undefined &&
        !(omitSelfRecursive && candidate.selfRecursive))) {
        const compileTimeCheckedLeaf = Boolean(site.directCheckedLeaf);
        const captures = compileTimeCheckedLeaf &&
          Array.isArray(site.directCheckedLeaf.captures)
          ? site.directCheckedLeaf.captures : [];
        const captureLines = [];
        const captureArguments = [];
        let captureCacheId = null;
        let captureCacheVariable = null;
        let captureRefreshLine = null;
        if (captures.length) {
          captureCacheId = site.checkedLeafCaptureCacheId;
          captureCacheVariable = `ssaCallCaptureCache${index}`;
          captureRefreshLine = alwaysRefreshCaptures
            ? `helpers.refreshCheckedLeafCaptureCache(${captureCacheId});`
            : `if (${captureCacheVariable}.dirty) ` +
              `helpers.refreshCheckedLeafCaptureCache(${captureCacheId});`;
          captureLines.push(
            `const ${captureCacheVariable} = ` +
              `helpers.checkedLeafCaptureCaches[${captureCacheId}];`,
            captureRefreshLine);
        }
        let captureValueOffset = 0;
        for (let captureIndex = 0; captureIndex < captures.length;
          captureIndex += 1) {
          const capture = captures[captureIndex];
          const valueName =
            `ssaCallCapture${index}_${captureArguments.length}`;
          captureLines.push(`const ${valueName} = ${
            normalizeJvmScalarExpression(
              `${captureCacheVariable}.value${captureValueOffset}`,
              capture.descriptor)};`);
          captureArguments.push(valueName);
          captureValueOffset += 1;
          if (capture.data) {
            const dataName =
              `ssaCallCapture${index}_${captureArguments.length}`;
            captureLines.push(`const ${dataName} = ` +
              `${captureCacheVariable}.value${captureValueOffset};`);
            captureArguments.push(dataName);
            captureValueOffset += 1;
          }
        }
        const rawBody = `ssaFastPositionalRawBody${index}`;
        if (compileTimeCheckedLeaf) {
          lines.push(
            `const ${rawBody} = ` +
              `helpers.directCheckedLeafBodies[${site.directCheckedLeaf.id}];`,
            ...captureLines,
            `const ${positionalCallRawInvokeVariable(index)} = ${rawBody};`,
            `const ${positionalCallInvokeVariable(index)} = null;`,
            `const ${positionalCallReceiverVariable(index)} = null;`,
          );
        } else {
          lines.push(
            `const ${positionalCallSiteVariable(index)} = ` +
              `helpers.syncCallSites[${site.id}];`,
            `const ${positionalCallTargetVariable(index)} = ` +
              `!helpers.profileMethods && ` +
              `${positionalCallSiteVariable(index)} && ` +
              `${positionalCallSiteVariable(index)}.fastPositional && ` +
              `(${positionalCallSiteVariable(index)}.fastPositional.debugGuarded || ` +
              `!helpers.jvm.debugManager.isClassJitDeopted(` +
              `${positionalCallSiteVariable(index)}.fastPositional.lookupClass)) ` +
              `? ${positionalCallSiteVariable(index)}.fastPositional : null;`,
            `const ${positionalCallInvokeVariable(index)} = ` +
              `${positionalCallTargetVariable(index)} && ` +
              `${positionalCallTargetVariable(index)}.invoke;`,
            `const ${positionalCallRawInvokeVariable(index)} = ` +
              `${positionalCallTargetVariable(index)} && ` +
              `${positionalCallTargetVariable(index)}.rawInvoke;`,
            `const ${positionalCallReceiverVariable(index)} = ` +
              `${positionalCallTargetVariable(index)} && ` +
              `${positionalCallTargetVariable(index)}.receiverType;`,
          );
        }
        if (captureLines.length) {
          captureSections.push({
            cacheId: captureCacheId,
            lines: captureLines,
            refreshLine: captureRefreshLine,
          });
        }
      }
      return {lines, captureSections};
    };
    const positionalCallDeclarationSet =
      positionalCallDeclarationsFor(false, true);
    const positionalCallDeclarations = positionalCallDeclarationSet.lines;
    const directPositionalCallDeclarationSet =
      positionalCallDeclarationsFor(true);
    const directPositionalCallDeclarations =
      directPositionalCallDeclarationSet.lines;
    const directPositionalCallCaptureDeclarations =
      directPositionalCallDeclarationSet.captureSections.flatMap(
        (section) => section.lines);
    const restoringDirectPositionalCallDeclarations =
      directPositionalCallDeclarations;
    const admissionOwnedCaptureRefreshLines = new Set(
      directPositionalCallDeclarationSet.captureSections
        .filter((section) => checkedAdmissionOwnedCaptureRefreshes.has(
          section.cacheId))
        .map((section) => section.refreshLine));
    const omitAdmissionOwnedCaptureRefreshes = (lines) => lines.filter(
      (line) => !admissionOwnedCaptureRefreshLines.has(line));
    const specializeSelfRecursiveCalls = (
      source, tier, includePlan, functionNameOverride = null,
    ) => {
      if (!selfRecursiveCallExpressions.size) return source;
      const functionName = functionNameOverride ||
        this.jit.generatedSource(method, tier, "").functionName;
      let specialized = source;
      for (const call of selfRecursiveCallExpressions.values()) {
        const direct = `${functionName}(helpers, ${includePlan ? "plan, " : ""}` +
          `${call.args.join(", ")}${call.args.length ? ", " : ""}` +
          "thread, 2)";
        specialized = specialized.split(
          `${call.marker}${call.ordinary}`).join(direct);
        const site = callSites.get(call.index);
        if (site) {
          specialized = specialized.split(
            `if ((${positionalCallRawInvokeVariable(call.index)} || ` +
              `${positionalCallInvokeVariable(call.index)}) && true) {`,
          ).join("if (true) {");
        }
        specialized = specialized
          .split(`/*__SSA_SELF_RECURSIVE_REGION_START_${call.index}__*/\n`)
          .join("")
          .split(`/*__SSA_SELF_RECURSIVE_REGION_END_${call.index}__*/\n`)
          .join("");
      }
      return specialized;
    };
    const specializeCheckedLeafSelfRecursiveCalls = (
      source, tier, rawWorker = false,
    ) => {
      if (!selfRecursiveCallExpressions.size) return source;
      const functionName =
        this.jit.generatedSource(method, tier, "").functionName;
      const lines = source.split("\n");
      for (const call of [...selfRecursiveCallExpressions.values()]
        .sort((left, right) => right.index - left.index)) {
        const startMarker =
          `/*__SSA_SELF_RECURSIVE_REGION_START_${call.index}__*/`;
        const endMarker =
          `/*__SSA_SELF_RECURSIVE_REGION_END_${call.index}__*/`;
        const start = lines.findIndex((line) => line.trim() === startMarker);
        const end = lines.findIndex((line, index) =>
          index > start && line.trim() === endMarker);
        if (start < 0 || end < 0) return null;
        const indentation = /^\s*/.exec(lines[start])?.[0] || "";
        const direct = rawWorker
          ? `${functionName}(${call.args.join(", ")});`
          : `${functionName}(helpers, ${call.args.join(", ")}` +
            `${call.args.length ? ", " : ""}thread, 2);`;
        lines.splice(start, end - start + 1, `${indentation}${direct}`);
      }
      return lines.join("\n");
    };
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
    // A restoring positional entry can reject an exotic instance layout
    // before its first guest effect and let the canonical call path preserve
    // exact exceptions. For immutable entry receivers with already-resolved
    // direct keys, guard the storage object once and read each field directly
    // rather than retaining a helper-valued ternary per field. This is the
    // same generic layout fact used by transactional checked leaves.
    const restoringDirectFieldLayoutSlots = new Set();
    const restoringDirectFieldLayoutCaches = this.restoringDirectFieldLayoutsEnabled
      ? [...fieldReadCaches.values()].filter((cache) =>
        cache.eagerLocal !== null && cache.eagerLocal !== undefined &&
        cache.directKey)
      : [];
    const restoringDirectFieldCacheInitializations = [];
    for (const slot of new Set(restoringDirectFieldLayoutCaches.map(
      (cache) => cache.eagerLocal))) {
      const caches = restoringDirectFieldLayoutCaches.filter(
        (cache) => cache.eagerLocal === slot);
      restoringDirectFieldLayoutSlots.add(slot);
      restoringDirectFieldCacheInitializations.push(
        `if (local${slot} === null || local${slot} === undefined || ` +
          `!local${slot}.fields) return helpers.asyncInvokeSentinel();`,
      );
      for (const cache of caches) {
        restoringDirectFieldCacheInitializations.push(
          `${cache.object} = local${slot};`,
          `${cache.value} = ` +
            `local${slot}.fields[${JSON.stringify(cache.directKey)}];`,
        );
      }
      restoringDirectFieldCacheInitializations.push(
        `if (${caches.map((cache) => `${cache.value} === undefined`)
          .join(" || ")}) return helpers.asyncInvokeSentinel();`,
      );
      for (const cache of caches) {
        if (!cache.isArray) {
          restoringDirectFieldCacheInitializations.push(
            `${cache.value} = ${normalizeJvmScalarExpression(
              cache.value, cache.descriptor)};`,
          );
        }
        if (cache.isArray) {
          restoringDirectFieldCacheInitializations.push(
            `${cache.data} = helpers.arrayData(${cache.value});`,
          );
        }
        restoringDirectFieldCacheInitializations.push(
          `${cache.valid} = true;`,
        );
      }
    }
    const restoringDirectLayoutCacheSet =
      new Set(restoringDirectFieldLayoutCaches);
    restoringDirectFieldCacheInitializations.push(
      ...[...fieldReadCaches.values()]
        .filter((cache) => !restoringDirectLayoutCacheSet.has(cache) &&
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
          ...(cache.isArray
            ? [`  ${cache.data} = helpers.arrayData(${cache.value});`] : []),
          `  ${cache.valid} = true;`,
          "}",
        ]),
    );
    // A transactional checked leaf must never call a field helper before it
    // has a canonical Frame. Require the already-resolved direct storage
    // shape at entry and return to the ordinary implementation for exotic
    // objects. This is a structural object-layout guard, independent of the
    // guest owner or field names selected by the bytecode.
    const transactionalEagerFieldCaches = [...fieldReadCaches.values()]
      .filter((cache) =>
        cache.eagerLocal !== null && cache.eagerLocal !== undefined);
    const transactionalFieldReadCacheInitializations = [];
    for (const slot of new Set(transactionalEagerFieldCaches.map(
      (cache) => cache.eagerLocal))) {
      const caches = transactionalEagerFieldCaches.filter(
        (cache) => cache.eagerLocal === slot);
      transactionalFieldReadCacheInitializations.push(
        `if (local${slot} === null || local${slot} === undefined || ` +
          `!local${slot}.fields) return helpers.asyncInvokeSentinel();`,
      );
      for (const cache of caches) {
        transactionalFieldReadCacheInitializations.push(
          `const ${cache.value} = ` +
            `local${slot}.fields[${JSON.stringify(cache.directKey)}];`,
        );
        if (cache.isArray) {
          transactionalFieldReadCacheInitializations.push(
            `const ${cache.data} = helpers.arrayData(${cache.value});`,
          );
        }
      }
      transactionalFieldReadCacheInitializations.push(
        `if (${caches.map((cache) => `${cache.value} === undefined`)
          .join(" || ")}) return helpers.asyncInvokeSentinel();`,
      );
    }
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
    // Lexically inlined checked leaves deliberately reuse compact localN
    // names inside their own block scope. Reading assignments back from the
    // rendered text therefore confuses child locals with the caller's JVM
    // slots. Derive caller mutability from its verified bytecodes instead;
    // folded entry stores already live in the declaration and are excluded.
    const callerAssignedLocalSlots = new Set();
    for (let index = 0; index < items.length; index += 1) {
      if (!normalReachableItems.has(index) ||
          foldedEntryStoreIndexes.has(index)) continue;
      const instruction = items[index]?.instruction;
      const op = opOf(instruction);
      const slot = op === "iinc"
        ? Number(instruction.varnum ?? instruction.arg)
        : /^[adfil]store(?:_[0-3])?$/.test(op || "")
          ? localIndex(instruction, op) : null;
      if (Number.isInteger(slot)) callerAssignedLocalSlots.add(slot);
    }
    const immutableEntryLocals = new Set([...entryLocalInitialValues.keys()]
      .filter((slot) => !callerAssignedLocalSlots.has(slot)));
    const spillSlots = [...new Set([
      ...entryLocalInitialValues.keys(), ...callerAssignedLocalSlots,
    ])].sort((a, b) => a - b);
    // Every spill expression must have a lexical local even when scalar DCE
    // removed the local's last ordinary read from the rendered tree. The
    // value is still observable at a scheduler/exception materialization.
    const declaredLocals = [...new Set([
      ...renderedLocalSlots,
      ...spillSlots.filter((slot) => !immutableEntryLocals.has(slot)),
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
      "dup", "dup2", "pop",
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
    const eliminatedCheckedLeafLocalSlots = new Set();
    const compactCheckedLeafLines = (
      sourceLines, checkedLeafSemantics = true,
    ) => {
      let lines = [...sourceLines];
      const inlineCheckedLeafLineIndexes = () => {
        const indexes = new Set();
        let depth = 0;
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (depth === 0 &&
              /^\s*ssaInlineCheckedLeaf\d+: \{$/.test(line)) {
            depth = 1;
            indexes.add(index);
            continue;
          }
          if (depth === 0) continue;
          indexes.add(index);
          depth += (line.match(/\{/g) || []).length -
            (line.match(/\}/g) || []).length;
        }
        return indexes;
      };
      const initialInlineIndexes = inlineCheckedLeafLineIndexes();
      const selfRecursiveProtectedValues = new Set(lines
        .filter((line, index) =>
          line.includes("__SSA_SELF_RECURSIVE_CALL_") ||
          line.includes("__SSA_SAFE_ARITHMETIC_CALL__") ||
          initialInlineIndexes.has(index))
        .flatMap((line) => [...line.matchAll(/\bssaValue\d+\b/g)]
          .map((match) => match[0])));
      // Restoring bodies expose the coarse-loop and range predicates as
      // explicit guard sites used by deoptimization and diagnostics. Keep
      // those names stable there; checked leaves have no restoring contract
      // and may freely propagate the predicates as ordinary SSA values.
      const compactTemporaryPattern = checkedLeafSemantics
        ? "(?:ssaValue\\d+|ssaRuntimeCoarse(?:Trips|Loop)\\d+|" +
          "ssaArrayRangeGuard\\d+)"
        : "ssaValue\\d+";
      const occurrenceCounts = () => {
        const counts = new Map();
        for (const line of lines) {
          for (const match of line.matchAll(new RegExp(
            `\\b${compactTemporaryPattern}\\b`, "g"))) {
            counts.set(match[0], (counts.get(match[0]) || 0) + 1);
          }
        }
        return counts;
      };
      // Loads of locals that are never assigned in the rendered region are
      // immutable aliases. Substitute them directly; unlike mutable-local
      // snapshots, they do not need a distinct SSA register.
      const aliases = new Map();
      const removedAliases = new Set();
      const aliasInlineIndexes = inlineCheckedLeafLineIndexes();
      for (let index = 0; index < lines.length; index += 1) {
        if (aliasInlineIndexes.has(index)) continue;
        const match = /^\s*const (ssaValue\d+) = local(\d+);$/.exec(lines[index]);
        const assignedLocals = checkedLeafSemantics
          ? renderedAssignedLocalSlots : callerAssignedLocalSlots;
        if (!match || assignedLocals.has(Number(match[2]))) {
          continue;
        }
        if (selfRecursiveProtectedValues.has(match[1])) continue;
        aliases.set(match[1], `local${match[2]}`);
        removedAliases.add(index);
      }
      if (aliases.size) {
        const replacementInlineIndexes = inlineCheckedLeafLineIndexes();
        lines = lines
          .map((line, index) => replacementInlineIndexes.has(index)
            ? line : line.replace(/\bssaValue\d+\b/g,
              (name) => aliases.get(name) || name))
          .filter((_line, index) => !removedAliases.has(index));
      }

      // Inline one-use pure arithmetic snapshots when none of the referenced
      // mutable locals changes before the use. This is ordinary SSA expression
      // propagation; array loads remain ordered unless they feed the very next
      // proven raw store in a checked leaf.
      for (;;) {
        const counts = occurrenceCounts();
        const inlineIndexes = inlineCheckedLeafLineIndexes();
        let changed = false;
        for (let declarationIndex = 0;
          declarationIndex < lines.length; declarationIndex += 1) {
          if (inlineIndexes.has(declarationIndex)) continue;
          const declaration =
            new RegExp(`^(\\s*)const (${compactTemporaryPattern}) = (.+);$`)
              .exec(lines[declarationIndex]);
          if (!declaration || counts.get(declaration[2]) !== 2) continue;
          if (selfRecursiveProtectedValues.has(declaration[2])) continue;
          let useIndex = -1;
          const usePattern = new RegExp(`\\b${declaration[2]}\\b`);
          for (let index = declarationIndex + 1; index < lines.length; index += 1) {
            if (!usePattern.test(lines[index])) continue;
            useIndex = index;
            break;
          }
          if (useIndex < 0 || inlineIndexes.has(useIndex)) continue;
          const rawArrayLoad = /ssaEntry(?:Array|StaticArray)Data\d+\[/.test(
            declaration[3]);
          const immediateRawStore = rawArrayLoad &&
            useIndex === declarationIndex + 1 &&
            /ssaEntry(?:Array|StaticArray)Data\d+\[.+\] =/.test(lines[useIndex]);
          if (rawArrayLoad && !immediateRawStore ||
              !checkedLeafSemantics && /\s[\/%]\s/.test(declaration[3]) ||
              /\bhelpers\.|\bnew\b/.test(declaration[3])) continue;
          const referencedLocals = [...declaration[3].matchAll(/\blocal(\d+)\b/g)]
            .map((match) => Number(match[1]));
          const localChanged = referencedLocals.some((slot) => {
            const assignment = new RegExp(`\\blocal${slot}\\s*=(?!=)`);
            return lines.slice(declarationIndex + 1, useIndex)
              .some((line) => assignment.test(line));
          });
          if (localChanged) continue;
          lines[useIndex] = lines[useIndex].replace(
            usePattern, `(${declaration[3]})`);
          lines[declarationIndex] = '';
          changed = true;
        }
        if (!changed) break;
        lines = lines.filter(Boolean);
      }

      // A stack temporary commonly becomes a local update on the immediately
      // following line. Preserve the old local snapshot used by the array
      // access, but avoid a second one-use SSA register for the new value.
      for (;;) {
        const counts = occurrenceCounts();
        const inlineIndexes = inlineCheckedLeafLineIndexes();
        let changed = false;
        for (let index = 0; index + 1 < lines.length; index += 1) {
          if (inlineIndexes.has(index) || inlineIndexes.has(index + 1)) continue;
          const declaration = /^(\s*)const (ssaValue\d+) = (.+);$/.exec(lines[index]);
          if (!declaration || counts.get(declaration[2]) !== 2) continue;
          const assignment = new RegExp(
            `^${declaration[1]}(local\\d+) = ${declaration[2]};$`)
            .exec(lines[index + 1]);
          if (!assignment) continue;
          lines[index] = '';
          lines[index + 1] =
            `${declaration[1]}${assignment[1]} = ${declaration[3]};`;
          changed = true;
        }
        if (!changed) break;
        lines = lines.filter(Boolean);
      }

      // A javac pre-increment often survives as old/new SSA snapshots because
      // the new value feeds both the local and the following comparison.
      // Render it as a direct local update and compare the updated local.
      for (;;) {
        const counts = occurrenceCounts();
        const inlineIndexes = inlineCheckedLeafLineIndexes();
        let changed = false;
        for (let index = 0; index + 2 < lines.length; index += 1) {
          if (inlineIndexes.has(index) || inlineIndexes.has(index + 1) ||
              inlineIndexes.has(index + 2)) continue;
          const next = /^(\s*)const (ssaValue\d+) = (.+);$/.exec(lines[index]);
          if (!next || counts.get(next[2]) !== 3) continue;
          const assignment = new RegExp(
            `^${next[1]}(local\\d+) = ${next[2]};$`).exec(lines[index + 1]);
          if (!assignment || !new RegExp(`\\b${next[2]}\\b`)
            .test(lines[index + 2])) continue;
          lines[index] = '';
          lines[index + 1] =
            `${next[1]}${assignment[1]} = ${next[3]};`;
          lines[index + 2] = lines[index + 2].replace(
            new RegExp(`\\b${next[2]}\\b`, 'g'), assignment[1]);
          changed = true;
        }
        if (!changed) break;
        lines = lines.filter(Boolean);
      }

      // Fold a snapshot used only to update the same local. Java evaluates
      // the right-hand side before the assignment, so direct self-update is
      // identical and exposes a conventional induction variable to the host.
      for (;;) {
        const counts = occurrenceCounts();
        const inlineIndexes = inlineCheckedLeafLineIndexes();
        let changed = false;
        for (let index = 0; index + 1 < lines.length; index += 1) {
          if (inlineIndexes.has(index) || inlineIndexes.has(index + 1)) continue;
          const snapshot =
            /^(\s*)const (ssaValue\d+) = (local\d+);$/.exec(lines[index]);
          if (!snapshot || counts.get(snapshot[2]) !== 2) continue;
          const update = new RegExp(
            `^${snapshot[1]}${snapshot[3]} = (.+\\b${snapshot[2]}\\b.+);$`)
            .exec(lines[index + 1]);
          if (!update) continue;
          lines[index] = '';
          lines[index + 1] = `${snapshot[1]}${snapshot[3]} = ` +
            `${update[1].replace(new RegExp(`\\b${snapshot[2]}\\b`, 'g'),
              snapshot[3])};`;
          changed = true;
        }
        if (!changed) break;
        lines = lines.filter(Boolean);
      }

      // Turn a separately declared, singly assigned load result into a const
      // at its definition point. This shortens its live range and removes one
      // bytecode/register pair without moving the potentially throwing load.
      for (;;) {
        const counts = occurrenceCounts();
        const inlineIndexes = inlineCheckedLeafLineIndexes();
        let changed = false;
        for (let declarationIndex = 0;
          declarationIndex < lines.length; declarationIndex += 1) {
          if (inlineIndexes.has(declarationIndex)) continue;
          const declaration =
            /^\s*let (ssaValue\d+);$/.exec(lines[declarationIndex]);
          if (!declaration || counts.get(declaration[1]) !== 3) continue;
          const assignmentPattern = new RegExp(
            `^(\\s*)${declaration[1]} = (.+);$`);
          const assignmentIndexes = [];
          for (let index = declarationIndex + 1; index < lines.length; index += 1) {
            if (assignmentPattern.test(lines[index])) assignmentIndexes.push(index);
          }
          if (assignmentIndexes.length !== 1 ||
              inlineIndexes.has(assignmentIndexes[0])) continue;
          const earlyUse = new RegExp(`\\b${declaration[1]}\\b`);
          if (lines.slice(declarationIndex + 1, assignmentIndexes[0])
            .some((line) => earlyUse.test(line))) continue;
          const assignment = assignmentPattern.exec(lines[assignmentIndexes[0]]);
          lines[declarationIndex] = '';
          lines[assignmentIndexes[0]] =
            `${assignment[1]}const ${declaration[1]} = ${assignment[2]};`;
          changed = true;
        }
        if (!changed) break;
        lines = lines.filter(Boolean);
      }
      lines = lines.map((line) => line.replace(
        /if \(!\((.+) !== (.+)\)\) \{/,
        'if ($1 === $2) {'));

      // Branch folding above can leave a labeled block whose sole remaining
      // exit is an unconditional trailing break. SSA names are globally
      // unique, so the lexical wrapper is unnecessary once that break is
      // gone. Remove both to avoid a host control-flow node per pixel/row.
      for (;;) {
        let changed = false;
        for (let start = 0; start < lines.length; start += 1) {
          const opening = /^(\s*)(L\d+): \{$/.exec(lines[start]);
          if (!opening) continue;
          let depth = 1;
          let end = start + 1;
          for (; end < lines.length; end += 1) {
            const opens = (lines[end].match(/\{/g) || []).length;
            const closes = (lines[end].match(/\}/g) || []).length;
            depth += opens - closes;
            if (depth === 0) break;
          }
          if (end >= lines.length) continue;
          const trailing = `${opening[1]}  break ${opening[2]};`;
          if (lines[end - 1] !== trailing) continue;
          lines.splice(end - 1, 2);
          lines.splice(start, 1);
          for (let index = start; index < end - 2; index += 1) {
            if (lines[index].startsWith(`${opening[1]}  `)) {
              lines[index] = opening[1] +
                lines[index].slice(opening[1].length + 2);
            }
          }
          changed = true;
          break;
        }
        if (!changed) break;
      }
      // Transactional primitive loads use `undefined` only as the exceptional
      // sentinel. Once their cold arm has become an entry bailout, collapse
      // the renderer's assignment-in-condition/constant-ternary scaffold to
      // one raw load and one ordinary guard. This applies to any primitive
      // array view and index expression, not to a particular sampler.
      if (checkedLeafSemantics) {
        for (let index = 0; index + 5 < lines.length; index += 1) {
          const declaration = /^(\s*)let (ssaValue\d+);$/.exec(lines[index]);
          if (!declaration) continue;
          const name = declaration[2];
          const load = new RegExp(
            `^${declaration[1]}if \\(!false && \\(\\(${name} = (.+)\\) === undefined\\)\\) \\{$`,
          ).exec(lines[index + 1]);
          if (!load || lines[index + 2] !==
              `${declaration[1]}  return helpers.asyncInvokeSentinel();` ||
              lines[index + 3] !== `${declaration[1]}} else {` ||
              !new RegExp(`^${declaration[1]}  ${name} = false \\? .+ : \\(\\(${name}\\) \\| 0\\);$`)
                .test(lines[index + 4]) ||
              lines[index + 5] !== `${declaration[1]}}`) continue;
          lines.splice(index, 6,
            `${declaration[1]}const ${name} = ${load[1]};`,
            `${declaration[1]}if (${name} === undefined) ` +
              "return helpers.asyncInvokeSentinel();");
        }

        // Checked leaves have already proved that their normal path cannot
        // materialize a Frame. Source-level JVM temporaries therefore need
        // not survive merely for a hypothetical spill. Propagate a simple
        // SSA alias only when its sole textual definition dominates every
        // read inside the same lexical scope; remove write-only aliases after
        // their value-producing instruction has already executed. Loop
        // induction variables and branch-carried locals necessarily have
        // multiple definitions or reads outside that scope and are retained.
        const localDeclarations = new Map();
        const localAssignments = new Map();
        const localReads = new Map();
        for (let index = 0; index < lines.length; index += 1) {
          const declaration = /^\s*let (local\d+) = undefined;$/.exec(
            lines[index]);
          if (declaration) localDeclarations.set(declaration[1], index);
          const assignment = /^(\s*)(local\d+) = (ssaValue\d+);$/.exec(
            lines[index]);
          if (assignment) {
            const values = localAssignments.get(assignment[2]) || [];
            values.push({
              index,
              indentation: assignment[1].length,
              value: assignment[3],
            });
            localAssignments.set(assignment[2], values);
          }
          for (const match of lines[index].matchAll(/\blocal\d+\b/g)) {
            const name = match[0];
            if (declaration?.[1] === name || assignment?.[2] === name &&
                match.index === assignment[1].length) continue;
            const reads = localReads.get(name) || [];
            reads.push(index);
            localReads.set(name, reads);
          }
        }
        const removeLocalLines = new Set();
        for (const [name, assignments] of localAssignments) {
          const declarationIndex = localDeclarations.get(name);
          const reads = localReads.get(name) || [];
          if (!reads.length && assignments.length > 0) {
            if (Number.isInteger(declarationIndex)) {
              removeLocalLines.add(declarationIndex);
            }
            for (const assignment of assignments) {
              removeLocalLines.add(assignment.index);
            }
            eliminatedCheckedLeafLocalSlots.add(
              Number(name.slice("local".length)));
            continue;
          }
          if (assignments.length !== 1 || !reads.length) continue;
          const assignment = assignments[0];
          let scopeEnd = lines.length;
          for (let index = assignment.index + 1;
            index < lines.length; index += 1) {
            const trimmed = lines[index].trim();
            const indentation = lines[index].length -
              lines[index].trimStart().length;
            if (trimmed.startsWith("}") &&
                indentation < assignment.indentation) {
              scopeEnd = index;
              break;
            }
          }
          if (reads.some((index) =>
            index <= assignment.index || index >= scopeEnd)) continue;
          const readPattern = new RegExp(`\\b${name}\\b`, "g");
          for (const index of reads) {
            lines[index] = lines[index].replace(
              readPattern, assignment.value);
          }
          if (Number.isInteger(declarationIndex)) {
            removeLocalLines.add(declarationIndex);
          }
          removeLocalLines.add(assignment.index);
          eliminatedCheckedLeafLocalSlots.add(
            Number(name.slice("local".length)));
        }
        if (removeLocalLines.size) {
          lines = lines.filter((_line, index) =>
            !removeLocalLines.has(index));
        }
      }
      // Remove pure SSA declarations left without a consumer after the
      // checked-leaf rewrites above.
      for (;;) {
        const counts = occurrenceCounts();
        const inlineIndexes = inlineCheckedLeafLineIndexes();
        const previousLength = lines.length;
        lines = lines.filter((line, index) => {
          if (inlineIndexes.has(index)) return true;
          const declaration = /^\s*const (ssaValue\d+) = (.+);$/.exec(line);
          return !declaration || counts.get(declaration[1]) !== 1 ||
            /\bhelpers\.|\bnew\b|\[[^\]]+\]/.test(declaration[2]);
        });
        if (lines.length === previousLength) break;
      }
      return lines;
    };
    const strengthReduceAffineStoreLoops = (sourceLines) => {
      const lines = [...sourceLines];
      for (let index = 0; index + 4 < lines.length; index += 1) {
        const opening = /^(\s*)(L\d+): while \((local\d+) < (local\d+)\) \{$/
          .exec(lines[index]);
        if (!opening) continue;
        const indentation = opening[1];
        const induction = opening[3];
        const bound = opening[4];
        const alias = new RegExp(
          `^${indentation}  const (ssaValue\\d+) = ${induction};$`)
          .exec(lines[index + 1]);
        const store = new RegExp(
          `^${indentation}  ([A-Za-z_$][\\w$]*)\\[(.+)\\] = (.+);$`)
          .exec(lines[index + 2]);
        if (!alias || !store ||
            lines[index + 4] !== `${indentation}}`) continue;
        const update = lines[index + 3]
          .replace(/[()\s]/g, "");
        if (update !== `${induction}=${alias[1]}+1|0;`) continue;
        const normalizedIndex = store[2].replace(/[()\s]/g, "");
        const localNames = [...new Set(
          [...store[2].matchAll(/\blocal\d+\b/g)]
            .map((match) => match[0]))];
        if (localNames.length !== 1) continue;
        const base = localNames[0];
        if (base === induction || base === bound ||
            !([`${base}+${alias[1]}|0`,
              `${alias[1]}+${base}|0`].includes(normalizedIndex)) ||
            new RegExp(`\\b(?:${alias[1]}|${induction}|${base})\\b`)
              .test(store[3])) continue;
        const suffix = opening[2].slice(1);
        const end = `ssaAffineStoreEnd${suffix}`;
        lines.splice(index, 5,
          `${indentation}const ${end} = ${base} + ${bound};`,
          `${indentation}${induction} = ${base} + ${induction};`,
          `${indentation}${opening[2]}: while (${induction} < ${end}) {`,
          `${indentation}  ${store[1]}[${induction}] = ${store[3]};`,
          `${indentation}  ${induction} += 1;`,
          `${indentation}}`,
          `${indentation}${induction} -= ${base};`);
        index += 6;
      }
      return lines;
    };
    const transactionalizeAcyclicLeafLines = (sourceLines) => {
      const lines = [...sourceLines];
      const output = [];
      const braceDelta = (line) =>
        (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      for (let index = 0; index < lines.length; index += 1) {
        const opening = /^(\s*)if \(.+\) \{$/.exec(lines[index]);
        if (!opening) {
          output.push(lines[index]);
          continue;
        }
        let depth = 1;
        let boundary = -1;
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
          const trimmed = lines[cursor].trim();
          if (depth === 1 &&
              (trimmed === "}" || trimmed.startsWith("} else"))) {
            boundary = cursor;
            break;
          }
          depth += braceDelta(lines[cursor]);
        }
        if (boundary < 0) {
          output.push(lines[index]);
          continue;
        }
        const failureBody = lines.slice(index + 1, boundary).join("\n");
        const firstFailureLine = lines[index + 1]?.trim() || "";
        if (!(firstFailureLine === "if (frame === null) {" ||
              firstFailureLine === "spillLocals();" ||
              /^ssaMaterialize\d+\(/.test(firstFailureLine)) ||
            !/helpers\.(?:arrayLoad|arrayStore|arrayLength|getFieldAt)\(|java\/lang\/ArithmeticException/.test(
              failureBody)) {
          output.push(lines[index]);
          continue;
        }
        output.push(lines[index],
          `${opening[1]}  return helpers.asyncInvokeSentinel();`);
        index = boundary - 1;
      }
      return output;
    };
    // Collapse a reducible three-block crossing diamond into its direct
    // boolean form. The matcher follows only label targets and comparison
    // topology. Invert the branch comparisons algebraically instead of
    // emitting `!(a > b)`: host optimizers consistently recognize the
    // canonical `a <= b && ...` form more effectively.
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
      const createStructuredFunction = (tier, parameters, source, ...options) => {
        return this.jit.createGeneratedFunction(
          method, tier, parameters, source, ...options);
      };
      const generatedBody = createStructuredFunction("structured-ssa",
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
        const entryArgumentValue = (index) => {
          const argument = entryArguments.get(index);
          if (!argument || index < receiverSlots) return argument;
          return normalizeJvmScalarExpression(
            argument, directMethodDescriptor.params[index - receiverSlots]);
        };
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
          `(nestedEntryGuarded !== 2 && ${directInitializationCondition})`,
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
        directPositionalSource = specializeSelfRecursiveCalls([
          "'use strict';",
          directInitializationGuardDeclaration,
          directGuard,
          ...directStaticDeclarations,
          ...lazyStaticDeclarations,
          ...directEntryStaticReadDeclarations,
          ...directPositionalCallDeclarations,
          directBooleanGuard,
          this.runCountersEnabled
            ? selfRecursiveCallExpressions.size
              ? "if (nestedEntryGuarded !== 2) " +
                "helpers.structuredSsa.runCount += 1;"
              : "helpers.structuredSsa.runCount += 1;" : null,
          `let safePointBudget = ${safePointInitialBudget};`,
          ...declaredLocals.map((index) =>
            `${immutableEntryLocals.has(index) ? "const" : "let"} local${index} = ${
              entryLocalInitialValues.has(index)
                ? entryLocalInitialValues.get(index)
                : entryArgumentValue(index) || "undefined"};`),
          ...entryArrayDataDeclarations,
          directArrayDataGuard,
          ...declarations,
          ...expandContinuationFallbacks(
            render(structured.tree, false, true), false),
        ].filter(Boolean).join("\n"), "ssa-direct-positional", false);
        directPositionalBody = createStructuredFunction(
          "ssa-direct-positional",
          ["helpers", ...argumentNames, "thread", "nestedEntryGuarded"],
          directPositionalSource,
          null, false, false, methodSpecializedCheckedCaptures,
        );
      }
      let restoringDirectPositionalBody = null;
      let restoringDirectPositionalSource = null;
      let checkedLeafDirectPositionalBody = null;
      let checkedLeafDirectPositionalSource = null;
      let trustedCheckedLeafDirectPositionalBody = null;
      let trustedCheckedLeafDirectPositionalSource = null;
      let preflightedCheckedLeafDirectPositionalBody = null;
      let preflightedCheckedLeafDirectPositionalSource = null;
      let capturedCheckedLeafDirectPositionalBody = null;
      let capturedCheckedLeafDirectPositionalSource = null;
      let capturedCheckedLeafDirectPositionalPlan = null;
      let recursiveArrayWorkerBody = null;
      let recursiveArrayWorkerSource = null;
      let nestedRuntimeCountedRegion = false;
      let transactionalAcyclicCheckedLeaf = false;
      let lexicalCheckedLeafWrapper = false;
      let restoringSpillCallCount = 0;
      let restoringSpillInlineCost = 0;
      let inlinedRestoringSpills = false;
      let captureFreeRestoringSpills = false;
      let outlinedCaptureFreeRestoringSpills = false;
      let restoringFrameSlotCount = 0;
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
        const entryArgumentValue = (index) => {
          const argument = entryArguments.get(index);
          if (!argument || index < receiverSlots) return argument;
          return normalizeJvmScalarExpression(
            argument, directMethodDescriptor.params[index - receiverSlots]);
        };
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
          `(nestedEntryGuarded !== 2 && ${restoringInitializationCondition})`,
        ];
        const directGuard =
          `if (${directGuardConditions.join(" || ")}) { ` +
          "return helpers.asyncInvokeSentinel(); }";
        // Generated callers have already passed the scheduler/debug portion
        // of the public entry contract. Emit the remaining lifecycle check
        // directly for that ABI instead of specializing JavaScript source
        // after it has been rendered.
        const trustedDirectGuard =
          `if (${restoringInitializationCondition}) { ` +
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
          ...[...entryArguments].map(([index]) =>
            `locals[${index}] = ${entryArgumentValue(index)};`),
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
        const restoringRendered = expandContinuationFallbacks(
          render(structured.tree, false, true,
            restoringDirectSafePointBudget, false, true), false);
        restoringSpillCallCount = restoringRendered.reduce(
          (count, line) => count +
            (/spillLocals\(\);$/.test(line) ||
             /^\s*ssaMaterialize\d+\(.*\);$/.test(line) ? 1 : 0), 0);
        // Outlining a spill helper makes every scalar local escape into its
        // closure context, including successful loop iterations that never
        // reconstruct a Frame. Duplicate the cold restoration statements
        // when their structural expansion stays within a fixed code-size
        // budget. The decision depends only on verified loop count, live JVM
        // slots, and actual spill sites; it has no guest-method identity.
        restoringSpillInlineCost = restoringSpillCallCount *
          (spillSlots.length + initializeFrame.length + 3);
        inlinedRestoringSpills =
          this.acyclicInlineRestoringSpillsEnabled &&
            structured.loopHeaders.size === 0 && spillSlots.length <= 32 ||
          this.loopInlineRestoringSpillsEnabled &&
            structured.loopHeaders.size > 0 && spillSlots.length <= 48 &&
            restoringSpillInlineCost <= this.loopInlineRestoringSpillBudget;
        outlinedCaptureFreeRestoringSpills =
          this.loopInlineRestoringSpillsEnabled &&
          structured.loopHeaders.size > 0 && spillSlots.length <= 48 &&
          restoringSpillCallCount > 0 && !inlinedRestoringSpills;
        captureFreeRestoringSpills = structured.loopHeaders.size > 0 &&
          (inlinedRestoringSpills || outlinedCaptureFreeRestoringSpills);
        const restoringRenderedWithSpills = captureFreeRestoringSpills
          ? restoringRendered : inlineMaterializeCalls(restoringRendered);
        // Entry arguments are also ordinary JVM locals.  Do not mention a
        // slot twice in a cold restoring-frame array merely because it is
        // both an argument and subsequently assigned.  Besides avoiding
        // redundant restoration writes, the unique value list prevents the
        // host compiler from keeping duplicate materialization operands live
        // across successful hot loops.  Unused arguments remain represented
        // through entryArgumentValue(), preserving complete Frame state.
        const restoringFrameEntries = captureFreeRestoringSpills
          ? new Map([...entryArguments.keys()].map((index) => [
            index, entryArgumentValue(index),
          ])) : new Map();
        for (const index of spillSlots) {
          restoringFrameEntries.set(index, immutableEntryLocals.has(index)
            ? entryLocalInitialValues.get(index) : `local${index}`);
        }
        const restoringFrameSlots = [...restoringFrameEntries.keys()];
        const restoringFrameValues = [...restoringFrameEntries.values()];
        const restoringFrameValuesAt = (pc) => {
          const known = materializationLocalValuesByPc.get(pc);
          if (!known) return restoringFrameValues;
          return restoringFrameSlots.map((slot, index) =>
            known[slot] ?? restoringFrameValues[index]);
        };
        restoringFrameSlotCount = restoringFrameSlots.length;
        const restoringFrameLayoutId = captureFreeRestoringSpills
          ? this.restoringFrameLayouts.push(restoringFrameSlots) - 1 : -1;
        const restoreCaptureFreeFrame = (indentation) => [
          `${indentation}ssaRestoringFrameState = ` +
            `helpers.structuredSsa.restoreDirectFrame(` +
            `${restoringFrameLayoutId}, plan, thread, restorationDepth, ` +
            `frame, [${restoringFrameValues.join(", ")}]);`,
          `${indentation}frame = ssaRestoringFrameState[0];`,
          `${indentation}locals = ssaRestoringFrameState[1];`,
          `${indentation}stack = ssaRestoringFrameState[2];`,
        ];
        const inlineRestoringSpillCalls = (lines) =>
          !(inlinedRestoringSpills || outlinedCaptureFreeRestoringSpills)
            ? lines : lines.flatMap((line) => {
            const conditional = /^(\s*)if \(frame === null\) spillLocals\(\);$/.exec(line);
            if (conditional) {
              if (captureFreeRestoringSpills) {
                return [
                  `${conditional[1]}if (frame === null) {`,
                  ...restoreCaptureFreeFrame(`${conditional[1]}  `),
                  `${conditional[1]}}`,
                ];
              }
              return [
                `${conditional[1]}if (frame === null) {`,
                ...restoringSpillLines.map(
                  (spill) => `${conditional[1]}  ${spill}`),
                `${conditional[1]}}`,
              ];
            }
            const match = /^(\s*)spillLocals\(\);$/.exec(line);
            if (!match) return [line];
            if (captureFreeRestoringSpills) {
              return restoreCaptureFreeFrame(match[1]);
            }
            return restoringSpillLines.map((spill) => `${match[1]}${spill}`);
          });
        let restoringRenderedTree = inlineRestoringSpillCalls(
          restoringRenderedWithSpills);
        if (captureFreeRestoringSpills) {
          restoringRenderedTree = restoringRenderedTree.flatMap((line) => {
            const match = /^(\s*)ssaMaterialize(\d+)\((.*)\);$/.exec(line);
            if (!match) return [line];
            const depth = Number(match[2]);
            const values = match[3].split(",").map((value) => value.trim());
            if (values.length !== depth + 1) return [line];
            const [pc, ...operands] = values;
            const numericPc = Number(pc);
            const frameValues = Number.isInteger(numericPc)
              ? restoringFrameValuesAt(numericPc)
              : restoringFrameValues;
            const indentation = match[1];
            return [
              `${indentation}ssaRestoringFrameState = ` +
                `helpers.structuredSsa.materializeDirectFrame(` +
                `${restoringFrameLayoutId}, plan, thread, restorationDepth, ` +
                `frame, [${frameValues.join(", ")}], ${pc}, ` +
                `[${operands.join(", ")}]);`,
              `${indentation}frame = ssaRestoringFrameState[0];`,
              `${indentation}locals = ssaRestoringFrameState[1];`,
              `${indentation}stack = ssaRestoringFrameState[2];`,
            ];
          });
        }
        if (restoringDirectFieldLayoutSlots.size) {
          restoringRenderedTree = (() => {
            const lines = [...restoringRenderedTree];
            for (let index = 0; index < lines.length; index += 1) {
              const opening = /^([\s]*)if \((ssaValue\d+) === null \|\| (ssaValue\d+) === undefined\) \{$/.exec(
                lines[index]);
              if (!opening || opening[2] !== opening[3]) continue;
              const slot = entryReferenceLoads.get(opening[2]) ??
                localLoads.get(opening[2]);
              if (!restoringDirectFieldLayoutSlots.has(slot)) continue;
              let depth = 1;
              let close = index + 1;
              for (; close < lines.length && depth > 0; close += 1) {
                const trimmed = lines[close].trim();
                if (trimmed.endsWith("{")) depth += 1;
                if (trimmed === "}" || trimmed.startsWith("} else")) depth -= 1;
              }
              if (depth !== 0) continue;
              lines.splice(index, close - index);
              index -= 1;
            }
            return lines;
          })();
        }
        restoringRenderedTree = compactCheckedLeafLines(
          restoringRenderedTree, false);
        let directBody = [
          ...directStaticDeclarations,
          ...lazyStaticDeclarations,
          ...directEntryStaticReadDeclarations,
          ...omitAdmissionOwnedCaptureRefreshes(
            restoringDirectPositionalCallDeclarations),
          ...directEntryCheckedAdmissionDeclarations,
          directBooleanGuard,
          this.runCountersEnabled
            ? selfRecursiveCallExpressions.size
              ? "if (nestedEntryGuarded !== 2) " +
                "helpers.structuredSsa.restoringDirectRunCount += 1;"
              : "helpers.structuredSsa.restoringDirectRunCount += 1;" : null,
          `let safePointBudget = ${restoringDirectSafePointBudget};`,
          ...declaredLocals.map((index) =>
            `${immutableEntryLocals.has(index) ? "const" : "let"} local${index} = ${
              entryLocalInitialValues.has(index)
                ? entryLocalInitialValues.get(index)
                : entryArgumentValue(index) || "undefined"};`),
          ...entryArrayDataDeclarations,
          directArrayDataGuard,
          captureFreeRestoringSpills
            ? "let ssaRestoringFrameState = null;" : null,
          ...(inlinedRestoringSpills || outlinedCaptureFreeRestoringSpills
            ? [] : [
            "function spillLocals() {",
            ...restoringSpillLines.map((line) => `  ${line}`),
            "}",
          ]),
          ...fieldReadCacheDeclarations,
          ...restoringDirectFieldCacheInitializations,
          ...declarations,
          ...restoringRenderedTree,
        ].filter(Boolean);
        // Entry scaffolding is assembled before checked-call admission and
        // loop specialization.  Those later passes can make capture aliases,
        // call-target aliases, scheduler budgets, or JVM locals completely
        // unused. Remove only top-level declarations with compiler-owned,
        // side-effect-free initializers; nested guest expressions and all
        // potentially observable property reads remain untouched.
        for (;;) {
          const counts = new Map();
          for (const line of directBody) {
            for (const match of line.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
              counts.set(match[0], (counts.get(match[0]) || 0) + 1);
            }
          }
          let removed = false;
          directBody = directBody.filter((line) => {
            const declaration = /^\s*(?:const|let) ([A-Za-z_$][\w$]*) = (.+);$/
              .exec(line);
            if (!declaration || counts.get(declaration[1]) !== 1) return true;
            const initializer = declaration[2];
            const pureRangeTemporary =
              /^ssa(?:ArrayRangeTrips|RuntimeCoarse(?:Trips|Loop))\d+$/.test(
                declaration[1]);
            const pure = pureRangeTemporary ||
              /^(?:undefined|null|true|false|-?\d+)$/.test(
              initializer) ||
              /^[A-Za-z_$][\w$]*$/.test(initializer) ||
              /^helpers\.(?:directCheckedLeafBodies|checkedLeafCaptureCaches)\[\d+\]$/.test(
                initializer) ||
              /^ssaCallCaptureCache\d+\.value\d+$/.test(initializer) ||
              /^\(\(ssaCallCaptureCache\d+\.value\d+\) \| 0\)$/.test(
                initializer);
            if (!pure) return true;
            removed = true;
            return false;
          });
          if (!removed) break;
        }
        restoringDirectPositionalSource = specializeSelfRecursiveCalls([
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
        ].join("\n"), "ssa-direct-restoring-positional", true);
        const restoringSentinelCaptures = {};
        if (restoringDirectPositionalSource.includes(
          "helpers.returnVoid()")) {
          restoringDirectPositionalSource = restoringDirectPositionalSource
            .split("helpers.returnVoid()").join("ssaReturnVoid");
          restoringSentinelCaptures.ssaReturnVoid =
            this.jit.returnVoid();
        }
        if (restoringDirectPositionalSource.includes(
          "helpers.asyncInvokeSentinel()")) {
          restoringDirectPositionalSource = restoringDirectPositionalSource
            .split("helpers.asyncInvokeSentinel()").join("ssaAsyncInvoke");
          restoringSentinelCaptures.ssaAsyncInvoke =
            this.jit.asyncInvokeSentinel();
        }
        restoringDirectPositionalBody = createStructuredFunction(
          "ssa-direct-restoring-positional",
          ["helpers", "plan", ...argumentNames, "thread",
            "nestedEntryGuarded"],
          restoringDirectPositionalSource,
          null, false, false, {
            ...methodSpecializedCheckedCaptures,
            ...restoringSentinelCaptures,
          },
        );

        const singleLoopHeader = structured.loopHeaders.size === 1
          ? [...structured.loopHeaders][0] : null;
        const singleLoop = Number.isInteger(singleLoopHeader)
          ? countedLoopInfos.get(singleLoopHeader) : null;
        const countedRegionLoops = [...structured.loopHeaders]
          .map((header) => countedLoopInfos.get(header))
          .filter(Boolean)
          .sort((left, right) =>
            (countedLoopDepths.get(left.header) || 0) -
            (countedLoopDepths.get(right.header) || 0));
        nestedRuntimeCountedRegion =
          countedRegionLoops.length === structured.loopHeaders.size &&
          countedRegionLoops.length > 1 &&
          countedRegionLoops.length <= 3 &&
          countedRegionLoops.every((info, index) =>
            info.initial === 0 && info.increment === 1 &&
            (info.boundSlot === null || countedRegionLoops.every((other) =>
              !other.writtenSlots.has(info.boundSlot))) &&
            (index === 0 ||
              countedRegionLoops[index - 1].loopBlocks.has(info.header))) &&
          arrayRangeCheckCandidates.every((_candidate, index) =>
            trustedHoistedRangeGuards.has(`ssaArrayRangeGuard${index}`));
        const checkedLeafTripDeclarations = [];
        if (nestedRuntimeCountedRegion) {
          for (const info of countedRegionLoops) {
            checkedLeafCoarseLoopHeaders.add(info.header);
            checkedLeafTripDeclarations.push(
              `const ssaCheckedLeafTrips${info.header} = ` +
                `Math.max(0, ${info.boundExpression});`);
          }
          const tripVariables = countedRegionLoops.map((info) =>
            `ssaCheckedLeafTrips${info.header}`);
          checkedLeafTripDeclarations.push(
            `if (!(${tripVariables.map((variable) =>
              `${variable} <= ${runtimeCoarseTripLimit}`).join(" && ")} && ` +
              `${tripVariables.join(" * ")} <= 1000000)) ` +
              "return helpers.asyncInvokeSentinel();",
          );
        }
        if (shrinkingArrayWindowLeaf) {
          const shape = shrinkingArrayWindowLeaf;
          const prefix = `ssaShrinkingArrayWindow${shape.outerHeader}`;
          const threshold = `${prefix}Threshold`;
          const outerTrips = `${prefix}OuterTrips`;
          const innerTrips = `${prefix}InnerTrips`;
          checkedLeafCoarseLoopHeaders.add(shape.outerHeader);
          checkedLeafCoarseLoopHeaders.add(shape.innerHeader);
          arrayRangeGuardDataVariables.set(
            shape.variable, shape.arrayData);
          if (shape.window === shape.stride * 2) {
            const delta = `${prefix}Delta`;
            const maximumTrips = Math.min(
              runtimeCoarseTripLimit, Math.floor(Math.sqrt(1_000_000)));
            checkedLeafTripDeclarations.push(
              `const ${threshold} = local${shape.lowerSlot} + ` +
                `${shape.window};`,
              `let ${shape.variable} = ` +
                `local${shape.lowerSlot} <= ${2147483647 - shape.window};`,
              `if (${shape.variable} && ` +
                `local${shape.upperSlot} >= ${threshold}) {`,
              `  const ${delta} = local${shape.upperSlot} - ` +
                `local${shape.lowerSlot};`,
              `  ${shape.variable} = ` +
                `(` +
                `local${shape.lowerSlot} >= 0 && ` +
                `local${shape.upperSlot} <= ${shape.arrayData}.length && ` +
                `${delta} % ${shape.stride} === 0 && ` +
                `${delta} / ${shape.stride} - 1 <= ${maximumTrips});`,
              `}`,
              `if (!${shape.variable}) ` +
                "return helpers.asyncInvokeSentinel();",
            );
          } else checkedLeafTripDeclarations.push(
            `const ${threshold} = local${shape.lowerSlot} + ` +
              `${shape.window};`,
            `const ${outerTrips} = local${shape.upperSlot} < ${threshold} ` +
              `? 0 : Math.floor((local${shape.upperSlot} - ${threshold}) / ` +
              `${shape.stride}) + 1;`,
            `const ${innerTrips} = ${outerTrips} === 0 ? 0 : ` +
              `(local${shape.upperSlot} - local${shape.lowerSlot}) / ` +
              `${shape.stride} - 1;`,
            `const ${shape.variable} = ` +
              `(local${shape.lowerSlot} <= ${2147483647 - shape.window} && ` +
              `(${outerTrips} === 0 || (` +
              `local${shape.lowerSlot} >= 0 && ` +
              `local${shape.upperSlot} <= ${shape.arrayData}.length && ` +
              `(local${shape.upperSlot} - local${shape.lowerSlot}) % ` +
              `${shape.stride} === 0 && ${outerTrips} <= ` +
              `${runtimeCoarseTripLimit} && ${innerTrips} >= 0 && ` +
              `${innerTrips} <= ${runtimeCoarseTripLimit} && ` +
              `${outerTrips} * ${innerTrips} <= 1000000)));`,
            `if (!${shape.variable}) ` +
              "return helpers.asyncInvokeSentinel();",
          );
        }
        if (recursiveArrayPartitionLeaf) {
          const shape = recursiveArrayPartitionLeaf;
          const delta = `ssaRecursiveArrayWindow${shape.header}Delta`;
          checkedLeafCoarseLoopHeaders.add(shape.header);
          arrayRangeGuardDataVariables.set(shape.variable, shape.arrayData);
          checkedLeafTripDeclarations.push(
            `const ${delta} = local${shape.upperSlot} - ` +
              `local${shape.lowerSlot};`,
            `const ${shape.variable} = (` +
              `local${shape.lowerSlot} >= 0 && ` +
              `local${shape.upperSlot} >= local${shape.lowerSlot} && ` +
              `local${shape.upperSlot} <= ${shape.arrayData}.length && ` +
              `${delta} % ${shape.stride} === 0 && ` +
              `${delta} / ${shape.stride} <= ${runtimeCoarseTripLimit});`,
            `if (!${shape.variable}) ` +
              "return helpers.asyncInvokeSentinel();",
          );
        }
        const deepestCountedLoop = countedRegionLoops.at(-1) || null;
        const loopItems = deepestCountedLoop
          ? new Set([...deepestCountedLoop.loopBlocks].flatMap(
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
        const primitiveArrayStoreOps = new Set([
          "iastore", "sastore", "bastore", "castore",
          "dastore", "fastore", "lastore",
        ]);
        const transactionalThrowingOps = new Set([
          "idiv", "irem", "getfield", "arraylength",
          "iaload", "saload", "baload", "caload",
          "daload", "faload", "laload",
          ...primitiveArrayStoreOps,
        ]);
        const provenNonThrowingArithmeticItem = (op, index) =>
          (op === "idiv" || op === "irem") &&
          (dominatedNonZeroDivisionItems.has(index) ||
            literalNonZeroDivisionItems.has(index));
        const reachableEffectItems = items
          .map((item, index) => ({
            index,
            op: opOf(item?.instruction),
          }))
          .filter(({ index, op }) =>
            normalReachableItems.has(index) && effectOps.has(op));
        const forwardOnlyCfg = cfg.blocks.every((block) =>
          !block || block.synthetic || (cfg.succ[block.id] || []).every(
            (successor) => cfg.blocks[successor]?.synthetic ||
              cfg.blocks[successor]?.insns?.[0] >= block.insns[0]));
        const onlyEffect = reachableEffectItems.length === 1
          ? reachableEffectItems[0] : null;
        const transactionalAcyclicShape =
          structured.loopHeaders.size === 0 &&
          forwardOnlyCfg &&
          (code.code.exceptionTable || []).length === 0 &&
          callSites.size === 0 &&
          onlyEffect && primitiveArrayStoreOps.has(onlyEffect.op) &&
          items.every((item, index) => {
            const op = opOf(item?.instruction);
            if (!op || !normalReachableItems.has(index)) return true;
            if (throwingOrDynamicOps.has(op) &&
                !transactionalThrowingOps.has(op)) return false;
            return !effectOps.has(op) || index === onlyEffect.index;
          });
        const lexicalCheckedLeafWrapperShape =
          structured.loopHeaders.size === 0 &&
          forwardOnlyCfg &&
          (code.code.exceptionTable || []).length === 0 &&
          reachableEffectItems.length === 0 &&
          callSites.size === 1 &&
          [...callSites.values()].every((site) =>
            site.returnsVoid &&
            site.directCheckedLeaf?.noThrow === true &&
            typeof site.directCheckedLeaf.inlineSource === "string") &&
          items.every((item, index) => {
            const op = opOf(item?.instruction);
            if (!op || !normalReachableItems.has(index)) return true;
            return (!throwingOrDynamicOps.has(op) ||
                provenNonThrowingArithmeticItem(op, index)) &&
              !effectOps.has(op);
          });
        lexicalCheckedLeafWrapper = lexicalCheckedLeafWrapperShape;
        const allCheckedLeafCallsAdmitted = callSites.size > 0 &&
          checkedCallAdmissionCandidates.length === callSites.size &&
          provenCheckedCallAdmissionCount === callSites.size &&
          [...callSites.values()].every((site) =>
            site.returnsVoid && site.directCheckedLeaf?.noThrow === true &&
            typeof site.directCheckedLeaf.inlineSource === "string");
        const checkedLeafShape = this.checkedLeafDirectPositionalEnabled &&
          (((singleLoop && (atomicBoundedLoops ||
              runtimeCoarseCountedLoops.has(singleLoopHeader)) ||
            nestedRuntimeCountedRegion || shrinkingArrayWindowLeaf ||
            recursiveArrayPartitionLeaf) ||
            transactionalAcyclicShape) &&
            (callSites.size === 0 || allCheckedLeafCallsAdmitted ||
              recursiveArrayPartitionLeaf &&
                [...callSites.values()].every((site) => site.selfRecursive)) ||
            lexicalCheckedLeafWrapperShape) &&
          items.every((item, index) => {
            const op = opOf(item?.instruction);
            if (!op || !normalReachableItems.has(index)) return true;
            if (!transactionalAcyclicShape &&
                throwingOrDynamicOps.has(op) &&
                !provenNonThrowingArithmeticItem(op, index)) return false;
            return !effectOps.has(op) || transactionalAcyclicShape ||
              recursiveArrayPartitionLeaf ||
              loopItems.has(index);
          });
        if (recursiveArrayPartitionLeaf && typeof process !== "undefined" &&
            process.env?.JVM_TRACE_STRUCTURED_RECURSIVE_ARRAY === "1") {
          console.error("[structured-recursive-array] checked shape", {
            checkedLeafShape,
            effects: reachableEffectItems,
          });
        }
        if (checkedLeafShape) {
          let checkedLeafRenderedTree = render(
            structured.tree, false, true,
            restoringDirectSafePointBudget, true, true);
          if (shrinkingArrayWindowLeaf) {
            const guard = shrinkingArrayWindowLeaf.variable;
            checkedLeafRenderedTree = checkedLeafRenderedTree.map((line) => {
              let rewritten = line;
              for (const access of shrinkingArrayWindowLeaf.accesses) {
                rewritten = rewritten.split(
                  `false /*${access.marker}*/`).join(guard);
              }
              return rewritten;
            });
            checkedLeafRenderedTree = specializeArrayRangeGuardedStores(
              checkedLeafRenderedTree, [guard]);
          }
          if (recursiveArrayPartitionLeaf) {
            const guard = recursiveArrayPartitionLeaf.variable;
            checkedLeafRenderedTree = checkedLeafRenderedTree.map((line) => {
              let rewritten = line;
              for (const access of recursiveArrayPartitionLeaf.accesses) {
                rewritten = rewritten.split(
                  `false /*${access.marker}*/`).join(guard);
              }
              return rewritten;
            });
            checkedLeafRenderedTree = specializeArrayRangeGuardedStores(
              checkedLeafRenderedTree, [guard]);
          }
          let checkedLeafTree = compactCheckedLeafLines(
            transactionalAcyclicShape
              ? transactionalizeAcyclicLeafLines(checkedLeafRenderedTree)
              : checkedLeafRenderedTree);
          checkedLeafTree = strengthReduceAffineStoreLoops(checkedLeafTree);
          const checkedLeafSafeArithmeticGuards = [];
          // Java int multiplication/addition needs explicit wrapping for
          // arbitrary inputs. A checked leaf may use ordinary JS arithmetic
          // when one entry predicate bounds every contributing int argument
          // and interval propagation proves that the selected operations
          // cannot overflow anywhere in the finite region. The restoring
          // implementation remains the exact slow arm for guard failures.
          if ((code.code.exceptionTable || []).length === 0 &&
              hasOutlinedClippedLeaf) {
            // Wide enough to admit ordinary render/audio coordinates and
            // packed colors, while interval propagation still rejects an
            // operation whose constants could overflow at either endpoint.
            const assumedLimit = 100_000_000;
            const argumentIntSlots = new Map();
            let parameterSlot = receiverSlots;
            for (let parameter = 0;
              parameter < directMethodDescriptor.params.length;
              parameter += 1, parameterSlot += 1) {
              if (directMethodDescriptor.params[parameter] === "int" &&
                  !renderedAssignedLocalSlots.has(parameterSlot)) {
                argumentIntSlots.set(parameterSlot,
                  `argument${parameter + receiverSlots}`);
              }
            }
            const inductionRanges = new Map();
            for (const info of countedLoopInfos.values()) {
              if (!Number.isInteger(info.initial) ||
                  !Number.isInteger(info.bound) ||
                  !Number.isInteger(info.increment) ||
                  info.increment <= 0 || info.initial >= info.bound) continue;
              const trips = Math.ceil(
                (info.bound - info.initial) / info.increment);
              const maximum = info.initial + (trips - 1) * info.increment;
              if (maximum <= 2147483647) {
                inductionRanges.set(info.slot, {
                  minimum: info.initial,
                  maximum,
                  assumptions: new Set(),
                });
              }
            }
            const rangeMemo = new Map();
            const safeRange = (expression, visiting = new Set()) => {
              if (/^-?\d+$/.test(expression)) {
                const value = Number(expression);
                return Number.isSafeInteger(value) ? {
                  minimum: value, maximum: value, assumptions: new Set(),
                } : null;
              }
              if (rangeMemo.has(expression)) return rangeMemo.get(expression);
              if (visiting.has(expression)) return null;
              const origin = methodIntegerOrigins.get(expression);
              if (!origin) return null;
              const nextVisiting = new Set(visiting).add(expression);
              if (origin.kind === "local") {
                const induction = inductionRanges.get(origin.slot);
                if (induction) return induction;
                const argument = argumentIntSlots.get(origin.slot);
                if (argument) {
                  const result = {
                    minimum: -assumedLimit,
                    maximum: assumedLimit,
                    assumptions: new Set([origin.slot]),
                  };
                  rangeMemo.set(expression, result);
                  return result;
                }
                const fixed = boundedLocalDefinitionRange(origin.slot);
                return fixed ? {...fixed, assumptions: new Set()} : null;
              }
              const left = safeRange(origin.left, nextVisiting);
              const right = safeRange(origin.right, nextVisiting);
              if (!left || !right) return null;
              let minimum;
              let maximum;
              if (origin.kind === "iadd") {
                minimum = left.minimum + right.minimum;
                maximum = left.maximum + right.maximum;
              } else if (origin.kind === "isub") {
                minimum = left.minimum - right.maximum;
                maximum = left.maximum - right.minimum;
              } else if (origin.kind === "imul") {
                const products = [
                  left.minimum * right.minimum,
                  left.minimum * right.maximum,
                  left.maximum * right.minimum,
                  left.maximum * right.maximum,
                ];
                minimum = Math.min(...products);
                maximum = Math.max(...products);
              } else if (origin.kind === "irem" &&
                  right.minimum === right.maximum &&
                  right.minimum !== 0 &&
                  !(right.minimum === -1 &&
                    left.minimum === -2147483648)) {
                const limit = Math.abs(right.minimum) - 1;
                minimum = Math.max(left.minimum, -limit);
                maximum = Math.min(left.maximum, limit);
              } else return null;
              if (!Number.isSafeInteger(minimum) ||
                  !Number.isSafeInteger(maximum) ||
                  minimum < -2147483648 || maximum > 2147483647) return null;
              const result = {
                minimum,
                maximum,
                assumptions: new Set([
                  ...left.assumptions, ...right.assumptions,
                ]),
              };
              rangeMemo.set(expression, result);
              return result;
            };
            const usedAssumptions = new Set();
            const declaredArithmeticValues = new Set(checkedLeafTree
              .map((line) => /^\s*const (ssaValue\d+) = /.exec(line)?.[1])
              .filter(Boolean));
            const plainSafeExpression = (expression, root = false) => {
              if (/^-?\d+$/.test(expression)) return expression;
              if (!root && declaredArithmeticValues.has(expression)) {
                return expression;
              }
              const origin = methodIntegerOrigins.get(expression);
              if (!origin) return expression;
              if (origin.kind === "local") {
                return argumentIntSlots.get(origin.slot) ||
                  `local${origin.slot}`;
              }
              if (!["iadd", "isub", "imul", "irem"].includes(
                origin.kind) || !safeRange(expression)) return expression;
              const operator = {
                iadd: "+", isub: "-", imul: "*", irem: "%",
              }[origin.kind];
              return `(${plainSafeExpression(origin.left)} ${operator} ` +
                `${plainSafeExpression(origin.right)})`;
            };
            checkedLeafTree = checkedLeafTree.map((line) => {
              const declaration =
                /^(\s*)const (ssaValue\d+) = (.+);$/.exec(line);
              if (!declaration) return line;
              const origin = methodIntegerOrigins.get(declaration[2]);
              if (!origin || !["iadd", "isub", "imul", "irem"].includes(
                origin.kind)) return line;
              const range = safeRange(declaration[2]);
              if (!range) return line;
              for (const slot of range.assumptions) usedAssumptions.add(slot);
              return `${declaration[1]}const ${declaration[2]} = ` +
                `${plainSafeExpression(declaration[2], true)};`;
            });
            if (usedAssumptions.size) {
              const failures = [...usedAssumptions]
                .sort((left, right) => left - right)
                .map((slot) => {
                  const argument = argumentIntSlots.get(slot);
                  // Direct positional int arguments are already int32. Shift
                  // the symmetric interval into an unsigned range so one
                  // comparison proves both endpoints.
                  return `(((${argument} + ${assumedLimit}) >>> 0) > ` +
                    `${assumedLimit * 2})`;
                });
              checkedLeafSafeArithmeticGuards.push(
                `if (${failures.join(" || ")}) ` +
                  "return helpers.asyncInvokeSentinel();");
              preflightedCheckedLeafArgumentSlots =
                [...usedAssumptions].sort((left, right) => left - right)
                  .map((slot) => argumentNames.indexOf(
                    argumentIntSlots.get(slot)))
                  .filter((index) => index >= 0);
              preflightedCheckedLeafArgumentLimit = assumedLimit;
            }
          }
          const compactCheckedLeafEntryLocals = (bodyLines) => {
            const aliases = new Map([...entryArguments]
              .filter(([slot]) => !renderedAssignedLocalSlots.has(slot))
              .map(([slot]) => [`local${slot}`, entryArgumentValue(slot)]));
            const withoutEliminatedLocals = bodyLines.filter((line) => {
              const declaration =
                /^\s*(?:const|let) local(\d+) = .+;$/.exec(line);
              return !declaration ||
                !eliminatedCheckedLeafLocalSlots.has(Number(declaration[1]));
            });
            if (!aliases.size) return withoutEliminatedLocals;
            return withoutEliminatedLocals
              .filter((line) => {
                const declaration =
                  /^\s*(?:const|let) (local\d+) = .+;$/.exec(line);
                return !declaration || !aliases.has(declaration[1]);
              })
              .map((line) => line.replace(/\blocal\d+\b/g,
                (name) => aliases.get(name) || name));
          };
          if (recursiveArrayPartitionLeaf) {
            let workerBody = compactCheckedLeafEntryLocals([
              ...declaredLocals.map((index) =>
                `${immutableEntryLocals.has(index) ? "const" : "let"} local${index} = ${
                  entryLocalInitialValues.has(index)
                    ? entryLocalInitialValues.get(index)
                    : entryArgumentValue(index) || "undefined"};`),
              `const ${entryArrayDataVariable(
                recursiveArrayPartitionLeaf.arraySlot)} = argument0;`,
              ...declarations,
              ...checkedLeafTree,
            ].filter(Boolean));
            recursiveArrayWorkerSource =
              specializeCheckedLeafSelfRecursiveCalls(
                ["'use strict';", ...workerBody].join("\n"),
                "ssa-recursive-array-worker", true,
              );
            if (recursiveArrayWorkerSource) {
              recursiveArrayWorkerSource = recursiveArrayWorkerSource
                .split("helpers.returnVoid()").join("ssaReturnVoid");
              if (!recursiveArrayWorkerSource.includes("helpers.") &&
                  !recursiveArrayWorkerSource.includes("spillLocals(") &&
                  !recursiveArrayWorkerSource.includes("throw ") &&
                  !recursiveArrayWorkerSource.includes("try {")) {
                recursiveArrayWorkerBody = createStructuredFunction(
                  "ssa-recursive-array-worker",
                  argumentNames,
                  recursiveArrayWorkerSource,
                  null, false, false,
                  {ssaReturnVoid: this.jit.returnVoid()},
                );
              }
            }
          }
          const checkedLeafBodyFor = ({
            includeCallerOwnedChecks,
            includeRunCounter,
            tier,
          }) => {
            let body = recursiveArrayWorkerBody
              ? [
                includeRunCounter && this.runCountersEnabled
                  ? "if (nestedEntryGuarded !== 2) " +
                    "helpers.structuredSsa.restoringDirectRunCount += 1;"
                  : null,
                `const ${entryArrayDataVariable(
                  recursiveArrayPartitionLeaf.arraySlot)} = ` +
                  `helpers.arrayData(argument0);`,
                directArrayDataGuard,
                ...[
                  recursiveArrayPartitionLeaf.lowerSlot,
                  recursiveArrayPartitionLeaf.upperSlot,
                ].map((slot) =>
                  `const local${slot} = ${entryArgumentValue(slot)};`),
                ...checkedLeafTripDeclarations,
                `return ssaRecursiveArrayWorker(${[
                  entryArrayDataVariable(
                    recursiveArrayPartitionLeaf.arraySlot),
                  ...argumentNames.slice(1),
                ].join(", ")});`,
              ].filter(Boolean)
              : compactCheckedLeafEntryLocals([
                ...directStaticDeclarations,
                ...lazyStaticDeclarations,
                ...directEntryStaticReadDeclarations,
                // Preflighted entries are an internal ABI whose caller has
                // already verified these exact capture and argument facts.
                // Select the fragments at IR emission time; generated source
                // is never parsed to discover or remove them.
                ...(includeCallerOwnedChecks
                  ? omitAdmissionOwnedCaptureRefreshes(
                    directPositionalCallCaptureDeclarations)
                  : []),
                ...(includeCallerOwnedChecks
                  ? directEntryCheckedAdmissionDeclarations : []),
                ...(includeCallerOwnedChecks
                  ? checkedLeafSafeArithmeticGuards : []),
                directBooleanGuard,
                includeRunCounter && this.runCountersEnabled
                  ? "helpers.structuredSsa.restoringDirectRunCount += 1;"
                  : null,
                ...(atomicBoundedLoops || nestedRuntimeCountedRegion ||
                  shrinkingArrayWindowLeaf ||
                  recursiveArrayPartitionLeaf ||
                  transactionalAcyclicShape || lexicalCheckedLeafWrapperShape
                  ? [] : [
                  `let safePointBudget = ${restoringDirectSafePointBudget};`,
                ]),
                ...declaredLocals.map((index) =>
                  `${immutableEntryLocals.has(index) ? "const" : "let"} local${index} = ${
                    entryLocalInitialValues.has(index)
                      ? entryLocalInitialValues.get(index)
                      : entryArgumentValue(index) || "undefined"};`),
                ...entryArrayDataDeclarations,
                ...(transactionalAcyclicShape ? [
                  ...transactionalFieldReadCacheInitializations,
                ] : []),
                directArrayDataGuard,
                ...checkedLeafTripDeclarations,
                ...declarations,
                ...checkedLeafTree,
              ].filter(Boolean));
            // Admission and constant/static specialization can render the
            // original capture aliases dead. Remove only compiler-owned pure
            // top-level declarations; guest property reads and expressions
            // are deliberately not eligible for this DCE.
            for (;;) {
              const counts = new Map();
              for (const line of body) {
                for (const match of line.matchAll(
                  /\b[A-Za-z_$][\w$]*\b/g)) {
                  counts.set(match[0], (counts.get(match[0]) || 0) + 1);
                }
              }
              let removed = false;
              body = body.filter((line) => {
                const declaration =
                  /^\s*(?:const|let) ([A-Za-z_$][\w$]*) = (.+);$/.exec(line);
                if (!declaration || counts.get(declaration[1]) !== 1) {
                  return true;
                }
                const initializer = declaration[2];
                const pure =
                  /^(?:undefined|null|true|false|-?\d+)$/.test(initializer) ||
                  /^[A-Za-z_$][\w$]*$/.test(initializer) ||
                  /^helpers\.(?:directCheckedLeafBodies|checkedLeafCaptureCaches)\[\d+\]$/.test(
                    initializer) ||
                  /^ssaCallCaptureCache\d+\.(?:value|specializedValue)\d+$/.test(
                    initializer) ||
                  /^\(\(ssaCallCaptureCache\d+\.(?:value|specializedValue)\d+\) \| 0\)$/.test(
                    initializer);
                if (!pure) return true;
                removed = true;
                return false;
              });
              if (!removed) break;
            }
            if (recursiveArrayPartitionLeaf && !recursiveArrayWorkerBody) {
              const specialized = specializeCheckedLeafSelfRecursiveCalls(
                body.join("\n"), tier);
              if (specialized === null) return null;
              body = specialized.split("\n");
            }
            return body;
          };
          const checkedLeafBody = checkedLeafBodyFor({
            includeCallerOwnedChecks: true,
            includeRunCounter: true,
            tier: "ssa-checked-leaf-positional",
          });
          const checkedLeafRecursiveSpecialized = checkedLeafBody !== null;
          const unsafeCheckedLeafLine = !checkedLeafRecursiveSpecialized ||
            checkedLeafBody?.some((line) =>
            line.includes("spillLocals(") ||
            line.includes("helpers.materialize(") ||
            line.includes("helpers.arrayLoad(") ||
            line.includes("helpers.arrayStore(") ||
            line.includes("__SSA_PRIMITIVE_ARRAY_ACCESS_") ||
            line.includes("throw ") || line.includes("try {"));
          if (recursiveArrayPartitionLeaf && unsafeCheckedLeafLine &&
              typeof process !== "undefined" &&
              process.env?.JVM_TRACE_STRUCTURED_RECURSIVE_ARRAY === "1") {
            console.error("[structured-recursive-array] unsafe", {
              checkedLeafRecursiveSpecialized,
              lines: checkedLeafBody.filter((line) =>
                line.includes("spillLocals(") ||
                line.includes("helpers.materialize(") ||
                line.includes("helpers.arrayLoad(") ||
                line.includes("helpers.arrayStore(") ||
                line.includes("__SSA_PRIMITIVE_ARRAY_ACCESS_") ||
                line.includes("throw ") || line.includes("try {")),
            });
          }
          if (!unsafeCheckedLeafLine) {
            const trustedCheckedLeafBody = checkedLeafBodyFor({
              includeCallerOwnedChecks: true,
              includeRunCounter: false,
              tier: "ssa-trusted-checked-leaf-positional",
            });
            if (!trustedCheckedLeafBody) {
              throw new Error("failed to specialize trusted checked leaf");
            }
            checkedLeafDirectPositionalSource = [
              "'use strict';",
              restoringInitializationGuardDeclaration,
              directGuard,
              ...checkedLeafBody,
            ].join("\n");
            checkedLeafDirectPositionalBody =
              createStructuredFunction(
                "ssa-checked-leaf-positional",
                ["helpers", ...argumentNames, "thread",
                  "nestedEntryGuarded"],
                checkedLeafDirectPositionalSource,
                null, false, false,
                {
                  ...methodSpecializedCheckedCaptures,
                  ...(recursiveArrayWorkerBody
                    ? {ssaRecursiveArrayWorker: recursiveArrayWorkerBody}
                    : {}),
                },
              );
            // Positional generated callers invoke a checked child only after
            // their own scheduler/debug entry guard has succeeded. Publish a
            // second ABI for that structurally proven context so a large leaf
            // does not retain a dynamic truthiness branch merely because V8
            // declines to inline it. The child class-initialization epoch and
            // every array/range predicate remain in this entry; only the
            // already-dominated outer-entry condition is specialized.
            trustedCheckedLeafDirectPositionalSource = [
              "'use strict';",
              restoringInitializationGuardDeclaration,
              trustedDirectGuard,
              ...trustedCheckedLeafBody,
            ].join("\n");
            trustedCheckedLeafDirectPositionalBody =
              createStructuredFunction(
                "ssa-trusted-checked-leaf-positional",
                ["helpers", ...argumentNames, "thread"],
                trustedCheckedLeafDirectPositionalSource,
                null, false, false,
                {
                  ...methodSpecializedCheckedCaptures,
                  ...(recursiveArrayWorkerBody
                    ? {ssaRecursiveArrayWorker: recursiveArrayWorkerBody}
                    : {}),
                },
              );
            if (preflightedCheckedLeafVerifier &&
                preflightedCheckedLeafArgumentSlots?.length) {
              const preflightedCheckedLeafBody = checkedLeafBodyFor({
                includeCallerOwnedChecks: false,
                includeRunCounter: false,
                tier: "ssa-preflighted-checked-leaf-positional",
              });
              if (!preflightedCheckedLeafBody) {
                throw new Error("failed to specialize preflighted checked leaf");
              }
              preflightedCheckedLeafDirectPositionalSource = [
                "'use strict';",
                ...preflightedCheckedLeafBody,
              ].join("\n");
              preflightedCheckedLeafDirectPositionalBody =
                createStructuredFunction(
                  "ssa-preflighted-checked-leaf-positional",
                  ["helpers", ...argumentNames, "thread"],
                  preflightedCheckedLeafDirectPositionalSource,
                  null, false, false,
                  {
                    ...methodSpecializedCheckedCaptures,
                    ...(recursiveArrayWorkerBody
                      ? {ssaRecursiveArrayWorker: recursiveArrayWorkerBody}
                      : {}),
                  },
                );
            }
            transactionalAcyclicCheckedLeaf = transactionalAcyclicShape;
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
                  className: cache.direct.className,
                  descriptor: cache.descriptor,
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
              const capturedBody = compactCheckedLeafEntryLocals([
                ...captureDeclarations,
                this.runCountersEnabled
                  ? "helpers.structuredSsa.restoringDirectRunCount += 1;" : null,
                ...(nestedRuntimeCountedRegion || shrinkingArrayWindowLeaf ||
                  recursiveArrayPartitionLeaf ||
                  transactionalAcyclicShape || lexicalCheckedLeafWrapperShape
                  ? [] : [
                  `let safePointBudget = ${restoringDirectSafePointBudget};`,
                ]),
                ...declaredLocals.map((index) =>
                  `${immutableEntryLocals.has(index) ? "const" : "let"} local${index} = ${
                    entryLocalInitialValues.has(index)
                      ? entryLocalInitialValues.get(index)
                      : entryArgumentValue(index) || "undefined"};`),
                ...entryArrayDataDeclarations,
                ...(transactionalAcyclicShape
                  ? transactionalFieldReadCacheInitializations : []),
                directArrayDataGuard,
                ...checkedLeafTripDeclarations,
                ...declarations,
                ...checkedLeafTree,
              ].filter(Boolean));
              capturedCheckedLeafDirectPositionalSource = [
                "'use strict';",
                restoringInitializationGuardDeclaration,
                directGuard,
                ...capturedBody,
              ].join("\n");
              capturedCheckedLeafDirectPositionalBody =
                createStructuredFunction(
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
        const adaptiveGeneratedBody = createStructuredFunction(
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
      generated.jvmRestoringDirectPositionalBody = restoringDirectPositionalBody;
      generated.jvmRestoringDirectPositionalSource = restoringDirectPositionalSource;
      generated.jvmCheckedLeafDirectPositionalBody =
        checkedLeafDirectPositionalBody;
      generated.jvmCheckedLeafDirectPositionalSource =
        checkedLeafDirectPositionalSource;
      generated.jvmTrustedCheckedLeafDirectPositionalBody =
        trustedCheckedLeafDirectPositionalBody;
      generated.jvmTrustedCheckedLeafDirectPositionalSource =
        trustedCheckedLeafDirectPositionalSource;
      generated.jvmPreflightedCheckedLeafDirectPositionalBody =
        preflightedCheckedLeafDirectPositionalBody;
      generated.jvmPreflightedCheckedLeafDirectPositionalSource =
        preflightedCheckedLeafDirectPositionalSource;
      generated.jvmPreflightedCheckedLeafStaticVerifier =
        preflightedCheckedLeafVerifier;
      generated.jvmPreflightedCheckedLeafArgumentSlots =
        preflightedCheckedLeafArgumentSlots;
      generated.jvmPreflightedCheckedLeafArgumentLimit =
        preflightedCheckedLeafArgumentLimit;
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
      generated.jvmStructuredEliminatedDeadLocalStoreCount =
        eliminatedDeadLocalStoreCount;
      generated.jvmStructuredSentinelArrayLoadCount = sentinelArrayLoadCount;
      generated.jvmStructuredEliminatedArrayStoreCheckCount =
        eliminatedArrayStoreCheckCount;
      generated.jvmStructuredArrayRangeGuardCount =
        arrayRangeCheckCandidates.length;
      generated.jvmStructuredCoalescedArrayRangeGuardCount =
        coalescedArrayRangeGuardCount;
      generated.jvmStructuredBlockCoalescedArrayRangeAccessCount =
        blockCoalescedArrayRangeAccessCount;
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
      generated.jvmStructuredLexicalCheckedLeafCallCount =
        [...callSites.values()].filter((site) =>
          typeof site.directCheckedLeaf?.inlineSource === "string").length;
      generated.jvmStructuredLexicalVoidFastPathCallCount =
        lexicalVoidFastPathSites.size;
      generated.jvmStructuredLexicalCheckedLeafWrapper = Boolean(
        checkedLeafDirectPositionalBody && lexicalCheckedLeafWrapper);
      generated.jvmStructuredNestedRuntimeCheckedLeaf = Boolean(
        checkedLeafDirectPositionalBody && nestedRuntimeCountedRegion);
      generated.jvmStructuredTransactionalAcyclicCheckedLeaf = Boolean(
        checkedLeafDirectPositionalBody && transactionalAcyclicCheckedLeaf);
      generated.jvmStructuredShrinkingArrayWindowCheckedLeaf = Boolean(
        checkedLeafDirectPositionalBody && shrinkingArrayWindowLeaf);
      generated.jvmStructuredShrinkingArrayWindowAccessCount =
        shrinkingArrayWindowLeaf?.accesses.length || 0;
      generated.jvmStructuredRecursiveArrayPartitionCheckedLeaf = Boolean(
        checkedLeafDirectPositionalBody && recursiveArrayPartitionLeaf);
      generated.jvmStructuredRecursiveArrayPartitionAccessCount =
        recursiveArrayPartitionLeaf?.accesses.length || 0;
      const clippedAffineFillAdmissionPlan = (() => {
        const captures =
          capturedCheckedLeafDirectPositionalPlan?.captures;
        const source = capturedCheckedLeafDirectPositionalSource;
        if (!Array.isArray(captures) || captures.length !== 6 ||
            !directMethodDescriptor ||
            directMethodDescriptor.returnType !== "void" ||
            directMethodDescriptor.params.length !== 4 ||
            !directMethodDescriptor.params.every((type) => type === "int") ||
            structured.loopHeaders.size !== 1 || callSites.size !== 0 ||
            captures.slice(0, 5).some((capture) =>
              capture.descriptor !== "I" || capture.data) ||
            captures[5].descriptor !== "[I" || !captures[5].data ||
            typeof source !== "string") {
          return null;
        }
        const requiredFragments = [
          "((argument1) | 0) < ssaEntryStaticValue0",
          "((argument1) | 0) < ssaEntryStaticValue1",
          "(local0) >= ssaEntryStaticValue2",
          "ssaEntryStaticValue3",
          "Math.imul(((argument1) | 0), ssaEntryStaticValue4)",
          "ssaEntryStaticArrayData5.length",
          "ssaEntryStaticArrayData5[local5]",
          "((argument3) | 0)",
        ];
        if (!requiredFragments.every((fragment) => source.includes(fragment))) {
          return null;
        }
        const stores = source.match(
          /ssaEntryStaticArrayData5\[[^\]]+\]\s*=/g) || [];
        if (stores.length !== 1) return null;
        return {
          kind: "clipped-affine-fill",
          xArgument: 0,
          yArgument: 1,
          countArgument: 2,
          valueArgument: 3,
          topCapture: 0,
          bottomCapture: 1,
          leftCapture: 2,
          rightCapture: 3,
          widthCapture: 4,
          arrayCapture: 5,
          arrayDataCapture: 6,
          maximumTrips: runtimeCoarseTripLimit,
        };
      })();
      generated.jvmStructuredCheckedLeafAdmissionPlan =
        recursiveArrayPartitionLeaf ? {
          kind: "record-window",
          arraySlot: recursiveArrayPartitionLeaf.arraySlot,
          lowerSlot: recursiveArrayPartitionLeaf.lowerSlot,
          upperSlot: recursiveArrayPartitionLeaf.upperSlot,
          stride: recursiveArrayPartitionLeaf.stride,
          maximumRecords: runtimeCoarseTripLimit,
          guardVariable: recursiveArrayPartitionLeaf.variable,
        } : shrinkingArrayWindowLeaf ? {
          kind: "record-window",
          arraySlot: shrinkingArrayWindowLeaf.arraySlot,
          lowerSlot: shrinkingArrayWindowLeaf.lowerSlot,
          upperSlot: shrinkingArrayWindowLeaf.upperSlot,
          stride: shrinkingArrayWindowLeaf.stride,
          maximumRecords: Math.min(
            runtimeCoarseTripLimit,
            Math.floor(Math.sqrt(1_000_000))) + 1,
          guardVariable: shrinkingArrayWindowLeaf.variable,
        } : clippedAffineFillAdmissionPlan;
      generated.jvmStructuredRecursiveArrayPartitionWorkerSource =
        recursiveArrayWorkerBody ? recursiveArrayWorkerSource : null;
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
      generated.jvmStructuredDominatedFieldReceiverCheckCount =
        dominatedFieldReceiverCheckCount;
      generated.jvmStructuredDominatedEntryReferenceNullBranchCount =
        dominatedEntryReferenceNullBranchCount;
      generated.jvmStructuredEliminatedTerminalBreakCount =
        eliminatedTerminalStructuredBreakCount;
      generated.jvmStructuredEliminatedBlockCount =
        eliminatedStructuredBlockCount;
      generated.jvmStructuredRestoringRangeGuardDeoptCount =
        restoringRangeGuardDeoptCount;
      generated.jvmStructuredRestoringCoarseLoopDeoptCount =
        restoringCoarseLoopDeoptCount;
      generated.jvmStructuredRangeDominatedArithmeticGuardCount =
        rangeDominatedArithmeticGuardCount;
      generated.jvmStructuredLoopInvariantDivisorGuardCount =
        loopInvariantDivisorGuardCount;
      generated.jvmStructuredRestoringDirectFieldLayoutCount =
        restoringDirectFieldLayoutCaches.length;
      generated.jvmStructuredRestoringSpillCallCount =
        restoringSpillCallCount;
      generated.jvmStructuredRestoringSpillInlineCost =
        restoringSpillInlineCost;
      generated.jvmStructuredInlinedRestoringSpills =
        inlinedRestoringSpills;
      generated.jvmStructuredCaptureFreeRestoringSpills =
        captureFreeRestoringSpills;
      generated.jvmStructuredOutlinedCaptureFreeRestoringSpills =
        outlinedCaptureFreeRestoringSpills;
      generated.jvmStructuredEagerFieldReceiverNullCheckCount =
        eagerFieldReceiverNullChecks.size;
      generated.jvmStructuredRangeGuardDataVariableCount =
        arrayRangeGuardDataVariables.size;
      generated.jvmStructuredProvenDeferredStaticArrayAccessCount =
        provenDeferredStaticArrayAccesses.size;
      generated.jvmStructuredProvenCheckedCallAdmissionCount =
        provenCheckedCallAdmissionCount;
      generated.jvmStructuredGuardedBooleanSiteCount = guardedStaticBooleanSites.size;
      generated.jvmStructuredPrunedBooleanCfgBranchCount =
        prunedBooleanCfgBranches;
      generated.jvmStructuredDeclaredLocalCount = declaredLocals.length;
      generated.jvmStructuredSpilledLocalCount = spillSlots.length;
      generated.jvmStructuredRestoringFrameSlotCount =
        restoringFrameSlotCount;
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
      this.lastFailedSource = typeof generatedSource === "string"
        ? generatedSource : null;
      return reject(`JavaScript emission failed: ${error.message}`);
    }
  }
}

module.exports = JvmSsaBlockRenderer;
module.exports._test = {
  isIrreducibleError,
  unboundGeneratedSsaIdentifiers,
};
