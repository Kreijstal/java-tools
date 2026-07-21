const {
  buildCfgFromCode,
  structure,
  IrreducibleError,
  succOfTerm,
  succAllOfTerm,
} = require("../decompiler/structurer");
const { splitIrreducibleTerms } = require("../decompiler/exceptionStructurer");
const { parseDescriptor } = require("../parsing/typeParser");

function isIrreducibleError(error) {
  return error instanceof IrreducibleError ||
    error?.name === "IrreducibleError" && Array.isArray(error.edges);
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

// Compiles verified reducible JVM loops into lexical JavaScript control flow.
// Instruction results are single-assignment values; control-flow edges feed
// live operand values into fixed successor-block join slots. Canonical Frame
// state is reconstructed only where the JVM can observe it.
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
    this.dispatchIslandMethodCount = 0;
    this.dispatchIslandCount = 0;
    this.compiledLoopCount = 0;
    this.splitMethodCount = 0;
    this.splitBlockCount = 0;
    this.runCount = 0;
    this.safePointCount = 0;
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
    if (!this.enabled || !this.jit.canCompileSynchronously(method) ||
        !this.jit.hasBackwardBranch(method)) return reject("disabled, asynchronous, or no backedge");
    const code = method.attributes.find((attribute) => attribute.type === "code");
    if (!code) return reject("missing code attribute");
    const items = this.jit.getCodeItems(method);
    if ((code.code.exceptionTable || []).length &&
        !this.jit.hasOnlyNoOpExceptionHandlers(method, items)) return reject("unsupported exception handler");
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
        const inline = isStatic ? this.jit.getCompileTimeIntegerLeaf(instruction) : null;
        const directIntrinsic = !isStatic || inline
          ? null : this.jit.getCompileTimeSynchronousIntrinsic(instruction);
        callSites.set(index, {
          id: inline || directIntrinsic ? null : this.jit.registerSyncCallSite(op, instruction),
          argumentCount: descriptor.params.length + (isStatic ? 0 : 1),
          returnsVoid: descriptor.returnType === "void",
          inline,
          directIntrinsic,
        });
      }
    }
    let nextValue = 0;
    const value = () => `ssaValue${nextValue++}`;
    const plans = [];
    const localIndex = (instruction, op) => {
      if (instruction && typeof instruction === "object" && instruction.arg !== undefined) {
        return Number(instruction.arg);
      }
      const match = /_([0-3])$/.exec(op || "");
      return match ? Number(match[1]) : NaN;
    };
    const opOf = (instruction) => !instruction ? null :
      (typeof instruction === "string" ? instruction : instruction.op);
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
      let condition = null;
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
          else { const out = value(); lines.push(`const ${out} = local${slot};`); stack.push(out); }
        } else if (/^[adfil]store(?:_[0-3])?$/.test(op)) {
          const input = pop();
          const slot = localIndex(instruction, op);
          if (input === null || !Number.isInteger(slot) || slot < 0 || slot >= localCount) valid = false;
          else lines.push(`local${slot} = ${input};`);
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
          else { const out = value(); lines.push(`const ${out} = ${input};`); stack.push(out, out); }
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
          } else lines.push(`local${slot} = (local${slot} + ${increment}) | 0;`);
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
            lines.push(`const ${array} = ${arrayInput};`, `const ${arrayIndex} = ${arrayIndexInput};`,
              `let ${out};`,
              `if (${array} === null || ${array} === undefined || ${arrayIndex} < 0 || ${arrayIndex} >= ${array}.length) {`,
              ...materializeLines([...stack, array, arrayIndex], index).map((line) => `  ${line}`),
              `  ${out} = helpers.arrayLoad(${arrayIndex}, ${array}, frame);`,
              "} else {", `  ${out} = ${array}.elements ? ${array}.elements[${arrayIndex}] : ${array}[${arrayIndex}];`, "}");
            stack.push(out);
          }
        } else if (op === "iastore" || op === "sastore" || op === "bastore" ||
            op === "castore" || op === "dastore" || op === "fastore" ||
            op === "lastore" || op === "aastore") {
          const storedInput = pop(), arrayIndexInput = pop(), arrayInput = pop();
          if (storedInput === null || arrayIndexInput === null || arrayInput === null) valid = false;
          else {
            const array = value(), arrayIndex = value(), stored = value();
            lines.push(`const ${array} = ${arrayInput};`, `const ${arrayIndex} = ${arrayIndexInput};`,
              `const ${stored} = ${storedInput};`,
              `if (${array} === null || ${array} === undefined || ${arrayIndex} < 0 || ${arrayIndex} >= ${array}.length) {`,
              ...materializeLines([...stack, array, arrayIndex, stored], index).map((line) => `  ${line}`),
              `  helpers.arrayStore(${stored}, ${arrayIndex}, ${array}, frame);`,
              `} else if (${array}.elements) {`, `  ${array}.elements[${arrayIndex}] = ${stored};`,
              "} else {", `  ${array}[${arrayIndex}] = ${stored};`, "}");
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
        } else if (op === "checkcast") {
          const input = stack[stack.length - 1];
          if (input === undefined) valid = false;
          else {
            const checked = value(), caught = value();
            lines.push(`let ${checked};`,
              `try { ${checked} = helpers.tryCheckCastSync(${input}, ${JSON.stringify(instruction.arg)}); } catch (${caught}) {`,
              ...materializeLines(stack, index).map((line) => `  ${line}`), `  throw ${caught};`, "}",
              `if (${checked} === helpers.asyncInvokeSentinel()) {`,
              ...materializeLines(stack, index).map((line) => `  ${line}`),
              "  helpers.skipJitOnce(frame);",
              "  return { deopt: true, transient: true, reason: 'cold structured SSA checkcast' };", "}");
          }
        } else if (op === "getfield") {
          const objectInput = pop(), site = fieldSites.get(index);
          if (objectInput === null || site === undefined) valid = false;
          else {
            const object = value(), out = value();
            lines.push(`const ${object} = ${objectInput};`,
              `if (${object} === null || ${object} === undefined) {`,
              ...materializeLines([...stack, object], index).map((line) => `  ${line}`),
              `  helpers.getFieldAt(${site}, ${object});`, "}",
              `const ${out} = helpers.getFieldAt(${site}, ${object});`);
            stack.push(out);
          }
        } else if (op === "putfield") {
          const storedInput = pop(), objectInput = pop(), site = fieldSites.get(index);
          if (storedInput === null || objectInput === null || site === undefined) valid = false;
          else {
            const object = value(), stored = value();
            lines.push(`const ${object} = ${objectInput};`, `const ${stored} = ${storedInput};`,
              `if (${object} === null || ${object} === undefined) {`,
              ...materializeLines([...stack, object, stored], index).map((line) => `  ${line}`),
              `  helpers.putFieldAt(${site}, ${object}, ${stored});`, "}",
              `helpers.putFieldAt(${site}, ${object}, ${stored});`);
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
          else if (direct) {
            const key = JSON.stringify(direct.key);
            lines.push(`const ${out} = ${direct.kind === "map"
              ? `${direct.variable}.get(${key})` : `${direct.variable}[${key}]`};`);
            stack.push(out);
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
          const site = callSites.get(index);
          if (!site || stack.length < site.argumentCount) valid = false;
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
          } else {
            const callStack = [...stack];
            const base = stack.length - site.argumentCount;
            stack.length = base;
            const out = value(), caught = value();
            lines.push(...materializeLines(callStack, index + 1), `let ${out};`,
              `try { ${out} = helpers.tryInvokeSyncAt(${site.id}, frame, thread); } catch (${caught}) {`,
              ...materializeLines(callStack, index).map((line) => `  ${line}`), `  throw ${caught};`, "}",
              `if (${out} === helpers.asyncInvokeSentinel()) {`,
              ...materializeLines(callStack, index).map((line) => `  ${line}`),
              "  helpers.skipJitOnce(frame);",
              "  return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };", "}",
              `if (${out} && ${out}.deopt) return ${out};`);
            if (!site.returnsVoid) stack.push(out);
            lines.push("if (thread.status !== 'runnable') {",
              ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
              "  return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee' };", "}");
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
            else condition = `${left} ${cmp} ${right}`;
          } else {
            const input = pop();
            const cmp = { ifeq: "=== 0", ifne: "!== 0", iflt: "< 0", ifge: ">= 0",
              ifgt: "> 0", ifle: "<= 0", ifnull: "=== null", ifnonnull: "!== null" }[op];
            if (input === null || !cmp) valid = false; else condition = `${input} ${cmp}`;
          }
          if (!valid || !edgeLines(target, stack) || !edgeLines(fall, stack)) valid = false;
          else plans[block.id] = { lines, condition, taken: target, fall, stack: [...stack] };
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

    const indent = (lines) => lines.map((line) => `  ${line}`);
    const render = (node) => {
      if (!node) return [];
      if (node.t === "seq") return node.body.flatMap(render);
      if (node.t === "straight") {
        const plan = plans[node.block];
        const lines = [...plan.lines];
        if (plan.returnKind && plan.returnKind !== "throw") {
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
        return [`if (${plan.condition}) {`, ...indent([
          ...edgeLines(plan.taken, plan.takenStack ?? plan.stack), ...render(node.then),
        ]), "} else {", ...indent([
          ...edgeLines(plan.fall, plan.fallStack ?? plan.stack), ...render(node.els),
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
          "if (helpers.continueQuantum(thread)) { safePointBudget = 10000; } else {",
          ...indent([
            "spillLocals();",
            ...restoreLines,
            "helpers.structuredSsa.safePointCount += 1;",
            "helpers.skipJitOnce(frame);",
            "return { deopt: true, transient: true, reason: 'structured SSA safe point' };",
          ]),
          "}",
        ];
        return [`${node.label}: while (true) {`, "  if (--safePointBudget === 0) {",
          ...indent(indent(materialize)), "  }", ...indent(render(node.body)), "}"];
      }
      if (node.t === "block") return [`${node.label}: {`, ...indent(render(node.body)), "}"];
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
    const body = ["'use strict';", "const locals = frame.locals;", "const stack = frame.stack.items;",
      "if (frame.pc !== 0 || (initialBytecodeChecks === undefined ? helpers.needsBytecodeChecks() : initialBytecodeChecks)) { helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'structured SSA entry' }; }",
      staticEntryGuard,
      ...directStaticDeclarations,
      "helpers.structuredSsa.runCount += 1;",
      "let safePointBudget = 10000;",
      ...Array.from({ length: localCount }, (_u, i) => `let local${i} = locals[${i}];`),
      `const spillLocals = () => {${Array.from({ length: localCount },
        (_u, i) => ` locals[${i}] = local${i};`).join("")} };`,
      ...declarations, ...render(structured.tree)];
    try {
      const generated = this.jit.createGeneratedFunction(method, "structured-ssa",
        ["frame", "thread", "helpers", "initialBytecodeChecks"], body.join("\n"));
      generated.jvmSynchronous = true;
      generated.jvmStructuredSsa = true;
      generated.jvmStructuredLoopCount = structured.loopHeaders.size;
      generated.jvmStructuredSplitBlocks = splitBlocks;
      generated.jvmStructuredDispatchIslands = dispatchIslands;
      generated.jvmStructuredSource = body.join("\n");
      this.compiledLoopCount += structured.loopHeaders.size;
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
