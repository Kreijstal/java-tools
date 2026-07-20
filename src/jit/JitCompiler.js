const Frame = require("../core/frame");
const { ASYNC_METHOD_SENTINEL } = require("../core/constants");
const { parseDescriptor } = require("../parsing/typeParser");
const { resolveInstanceFieldKey } = require("../instructions/object");
const WasmJit = require("./WasmJit");
const { isNoOpExceptionHandler } = WasmJit._test;

const RETURN_VOID = Symbol("jit.return.void");
const STATIC_DEOPT = Symbol("jit.static.deopt");

class JitCompiler {
  constructor(jvm, options = {}) {
    this.jvm = jvm;
    this.enabled = options.enabled !== false &&
      !(typeof process !== "undefined" && process.env && process.env.JVM_DISABLE_JIT === "1");
    this.safePoints = options.safePoints || "bytecode";
    this.supportCache = new WeakMap();
    this.labelCache = new WeakMap();
    this.runningFrames = new WeakSet();
    this.deoptedMethods = new WeakSet();
    this.invocationCounts = new WeakMap();
    this.backwardBranchCache = new WeakMap();
    this.warmupThreshold = options.warmupThreshold ?? 2;
    this.codegenEnabled = options.codegen !== false;
    this.codegenCache = new WeakMap();
    this.codegenSupportCache = new WeakMap();
    this.codegenUnavailable = false;
    this.codegenCompileErrors = new WeakMap();
    const firefoxDefault = typeof navigator !== "undefined" &&
      /Firefox\//.test(navigator.userAgent || "");
    this.preferWholeMethodJs = options.preferWholeMethodJs ?? firefoxDefault;
    this.generatedRunCount = 0;
    this.runnerRunCount = 0;
    this.methodRunCounts = new Map();
    this.generatedMethodRunCounts = new Map();
    this.runnerMethodRunCounts = new Map();
    this.methodDeoptCounts = new Map();
    this.methodDeoptReasons = new Map();
    this.experimentalControlFlow = options.experimentalControlFlow ?? (
      typeof process !== "undefined" && process.env
        ? process.env.JVM_JIT_EXPERIMENTAL_CONTROL_FLOW === "1"
        : false
    );
    this.wasmJit = new WasmJit(jvm, this);
  }

  canRun(frame) {
    if (!this.enabled || !frame || !frame.method || !frame.instructions) {
      return false;
    }
    if (this.runningFrames.has(frame)) {
      return false;
    }
    if (frame.jitSkipOnce) {
      delete frame.jitSkipOnce;
      return false;
    }
    if (this.deoptedMethods.has(frame.method)) {
      frame.jitJsDisabled = true;
      return false;
    }
    // Tracing/profiling must observe every interpreted bytecode. Debug stepping
    // is handled below through DebugManager; these environment modes are used
    // by the headless runner and need the same one-instruction semantics.
    if (typeof process !== "undefined" && process.env &&
      (process.env.JVM_TRACE || process.env.JVM_PROFILE_HOT_METHODS === "1")) {
      return false;
    }
    const debug = this.jvm.debugManager;
    if (debug.debugMode && debug.runMode !== "continuing") {
      return false;
    }
    if (debug.isClassJitDeopted(this.getFrameClassName(frame))) {
      return false;
    }
    const count = (this.invocationCounts.get(frame.method) || 0) + 1;
    this.invocationCounts.set(frame.method, count);
    if (count < this.warmupThreshold && !this.hasBackwardBranch(frame.method)) {
      return false;
    }
    const supported = this.isSupported(frame.method);
    if (!supported) frame.jitJsDisabled = true;
    return supported;
  }

  hasBackwardBranch(method) {
    if (this.backwardBranchCache.has(method)) return this.backwardBranchCache.get(method);
    const code = method.attributes.find((attr) => attr.type === "code");
    const codeItems = code && code.code && code.code.codeItems || [];
    const labels = buildLabelMap(codeItems);
    const backward = codeItems.some((item, index) => {
      const instruction = item && item.instruction;
      const op = getOp(instruction);
      if (!op || (op !== "goto" && !op.startsWith("if"))) return false;
      const target = instruction && typeof instruction === "object" ? labels.get(instruction.arg) : undefined;
      return target !== undefined && target <= index;
    });
    this.backwardBranchCache.set(method, backward);
    return backward;
  }

  async tryRunFrame(frame, thread) {
    // SpiderMonkey pays a high cost for frequent Wasm -> JS -> Wasm exits.
    // When the whole method has a generated implementation, prefer that
    // single tier over partial Wasm. Compilation is intentionally allowed to
    // cost more up front so animation/render loops remain in one engine tier.
    let canRunGenerated = null;
    if (this.preferWholeMethodJs && !this.runningFrames.has(frame) &&
        !frame.jitJsDisabled && this.isCodegenSupported(frame.method)) {
      canRunGenerated = this.canRun(frame);
    }

    if (!canRunGenerated && this.wasmJit.enabled && !this.runningFrames.has(frame)) {
      const wasmResult = this.wasmJit.tryRunFrame(frame, thread);
      if (wasmResult.handled) {
        if (wasmResult.returned) return { handled: true };
        // A partial-Wasm exit has already materialized locals, operand stack,
        // and the exact resume pc. Let executeTick interpret the unsupported
        // island immediately instead of consuming an otherwise empty thread
        // turn; the next tick can re-enter Wasm at the following eligible
        // block. Do not probe the JS tier in between these two regions.
        return { handled: false, wasmExited: true };
      }
    }
    // Structural rejection and permanent deoptimization are method-stable.
    // Remember them on the frame so interpreted bytecodes do not repeat the
    // full JS-JIT policy check on every scheduler tick. The Wasm tier still
    // gets its probe above because it can compile supported regions of a
    // method that the JS tier rejects as a whole.
    if (frame.jitJsDisabled) {
      return { handled: false };
    }
    if ((canRunGenerated === null && !this.canRun(frame)) || canRunGenerated === false) {
      return { handled: false };
    }

    const methodKey = `${this.getFrameClassName(frame)}.${frame.method.name}${frame.method.descriptor}`;
    this.methodRunCounts.set(methodKey, (this.methodRunCounts.get(methodKey) || 0) + 1);
    this.runningFrames.add(frame);
    try {
      const generated = this.getGeneratedFunction(frame.method);
      const result = generated
        ? await this.runGeneratedFrame(generated, frame, thread)
        : await this.runFrame(frame, thread);
      if (result && result.deopt) {
        this.lastDeoptReason = result.reason;
        this.methodDeoptCounts.set(methodKey, (this.methodDeoptCounts.get(methodKey) || 0) + 1);
        this.methodDeoptReasons.set(methodKey, result.reason || "unspecified");
        if (!result.transient) {
          this.deoptedMethods.add(frame.method);
          frame.jitJsDisabled = true;
        }
        return { handled: true };
      }
      if (result && result.returned && result.value !== RETURN_VOID && !thread.callStack.isEmpty()) {
        thread.callStack.peek().stack.push(result.value);
      }
      return { handled: true };
    } finally {
      this.runningFrames.delete(frame);
    }
  }

  dumpStats(limit = 10) {
    const rows = [...this.methodRunCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, limit));
    console.error(`JIT generated=${this.generatedRunCount} runner=${this.runnerRunCount}`);
    for (const [method, count] of rows) {
      const deopts = this.methodDeoptCounts.get(method) || 0;
      console.error(`  ${count.toLocaleString()} runs ${method}${deopts ? ` (${deopts} deopt)` : ""}`);
    }
    this.dumpExecutionCounts("generated callees", this.generatedMethodRunCounts, limit);
    this.dumpExecutionCounts("runner callees", this.runnerMethodRunCounts, limit);
    const deopts = [...this.methodDeoptCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, limit));
    if (deopts.length) console.error("JIT deoptimizations:");
    for (const [method, count] of deopts) {
      console.error(`  ${count.toLocaleString()} deopt ${method}: ${this.methodDeoptReasons.get(method)}`);
    }
    if (this.lastDeoptReason) console.error(`  last deopt: ${this.lastDeoptReason}`);
    if (this.wasmJit.enabled) this.wasmJit.dumpStats();
  }

  getGeneratedFunction(method) {
    if (!this.codegenEnabled || this.codegenUnavailable || !this.isCodegenSupported(method)) {
      return null;
    }
    if (this.codegenCache.has(method)) {
      return this.codegenCache.get(method);
    }
    try {
      const generated = this.compileMethod(method);
      this.codegenCache.set(method, generated);
      return generated;
    } catch (err) {
      this.codegenCompileErrors.set(method, err);
      return null;
    }
  }

  async runGeneratedFrame(generated, frame, thread) {
    this.generatedRunCount += 1;
    this.recordExecution(this.generatedMethodRunCounts, frame);
    return generated(frame, thread, this);
  }

  recordExecution(counts, frame) {
    const method = frame && frame.method;
    if (!method) return;
    const methodKey = `${this.getFrameClassName(frame)}.${method.name}${method.descriptor}`;
    counts.set(methodKey, (counts.get(methodKey) || 0) + 1);
  }

  dumpExecutionCounts(label, counts, limit) {
    const rows = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, limit));
    if (!rows.length) return;
    console.error(`JIT ${label}:`);
    for (const [method, count] of rows) {
      console.error(`  ${count.toLocaleString()} runs ${method}`);
    }
  }

  isSupported(method) {
    if (this.supportCache.has(method)) {
      return this.supportCache.get(method);
    }

    if (method.name === "<init>" || method.name === "<clinit>") {
      this.supportCache.set(method, false);
      return false;
    }

    const code = method.attributes.find((attr) => attr.type === "code");
    if (!code) {
      this.supportCache.set(method, false);
      return false;
    }

    const codeItems = code.code.codeItems;
    if (hasExperimentalControlFlow(codeItems) && !this.experimentalControlFlow &&
      !this.hasJitSafeControlFlow(method, codeItems)) {
      this.supportCache.set(method, false);
      return false;
    }
    if (hasMonitorBytecode(codeItems) && !this.hasJitSafeMonitorBody(codeItems)) {
      this.supportCache.set(method, false);
      return false;
    }
    const doubleOps = new Set([
      "d2i", "dadd", "daload", "dastore", "dcmpg", "dcmpl",
      "dconst_0", "dconst_1", "ddiv", "dload", "dload_0", "dload_1",
      "dload_2", "dload_3", "dmul", "dneg", "dreturn", "dstore",
      "dstore_0", "dstore_1", "dstore_2", "dstore_3", "dsub",
    ]);
    const floatOps = new Set([
      "d2f", "f2d", "f2i", "fadd", "faload", "fastore", "fcmpg", "fcmpl",
      "fconst_0", "fconst_1", "fconst_2", "fdiv", "fload", "fload_0",
      "fload_1", "fload_2", "fload_3", "fmul", "fneg", "frem", "freturn",
      "fstore", "fstore_0", "fstore_1", "fstore_2", "fstore_3", "fsub", "i2f",
    ]);
    const integerOps = new Set([
      "i2b", "iadd", "iand", "idiv", "imul", "ineg", "ior", "irem",
      "ishl", "ishr", "isub", "ixor",
    ]);
    const longOps = new Set(["i2l", "lcmp", "ldiv", "lxor"]);
    const hasNumericHotPath = codeItems.some((item) => {
      const op = typeof item.instruction === "string" ? item.instruction : item.instruction && item.instruction.op;
      return op && (doubleOps.has(op) || floatOps.has(op) || integerOps.has(op) || longOps.has(op) || op === "i2d" ||
        op === "newarray" && (item.instruction.arg === "double" || item.instruction.arg === "float" || item.instruction.arg === "int"));
    });
    const eligibleShape = hasNumericHotPath || this.hasBackwardBranch(method);

    const allowed = new Set([
      "aconst_null", "aload", "aload_0", "aload_1", "aload_2", "aload_3",
      "areturn", "astore", "astore_0", "astore_1", "astore_2", "astore_3", "athrow",
      "aaload", "aastore", "anewarray", "arraylength", "bastore", "baload", "caload", "castore", "checkcast",
      "bipush", "d2i", "dadd", "daload", "dastore", "dcmpg", "dcmpl",
      "dconst_0", "dconst_1", "ddiv", "dload", "dload_0", "dload_1",
      "dload_2", "dload_3", "dmul", "dneg", "dreturn", "dstore",
      "dstore_0", "dstore_1", "dstore_2", "dstore_3", "dsub", "dup", "dup2",
      "d2f", "f2d", "f2i", "fadd", "faload", "fastore", "fcmpg", "fcmpl",
      "fconst_0", "fconst_1", "fconst_2", "fdiv", "fload", "fload_0",
      "fload_1", "fload_2", "fload_3", "fmul", "fneg", "frem", "freturn",
      "fstore", "fstore_0", "fstore_1", "fstore_2", "fstore_3", "fsub", "i2f",
      "getfield", "getstatic", "goto", "i2b", "i2d", "i2l", "iadd", "iaload", "iand", "iastore", "idiv",
      "iconst_m1", "iconst_0", "iconst_1", "iconst_2", "iconst_3", "iconst_4", "iconst_5",
      "if_acmpeq", "if_acmpne", "ifeq", "ifge", "ifgt", "ificmpge",
      "if_icmpeq", "if_icmpge", "if_icmpgt", "if_icmple", "if_icmplt", "if_icmpne",
      "ifle", "iflt", "ifne", "ifnonnull", "ifnull", "iload", "iload_0",
      "iload_1", "iload_2", "iload_3", "imul", "inc", "iinc",
      "invokeinterface", "invokespecial", "invokestatic", "invokevirtual", "istore", "istore_0",
      "ior", "irem", "ireturn", "ishl", "istore_1", "istore_2", "istore_3", "ineg", "ishr", "iushr", "isub", "ixor", "lcmp", "ldc", "ldc_w", "ldc2_w", "ldiv", "lreturn", "lxor",
      "monitorenter", "monitorexit", "multianewarray", "new", "newarray", "pop", "putfield", "putstatic", "return", "saload", "sastore",
      "sipush"
    ]);

    const supported = eligibleShape && codeItems.every((item) => {
        if (!item.instruction) return true;
        const op = typeof item.instruction === "string" ? item.instruction : item.instruction.op;
        return allowed.has(op);
      });

    this.supportCache.set(method, supported);
    return supported;
  }

  isCodegenSupported(method) {
    if (this.codegenSupportCache.has(method)) {
      return this.codegenSupportCache.get(method);
    }

    const code = method.attributes.find((attr) => attr.type === "code");
    if (!code) {
      this.codegenSupportCache.set(method, false);
      return false;
    }

    const codeItems = code.code.codeItems;
    if (hasExperimentalControlFlow(codeItems) && !this.experimentalControlFlow &&
      !this.hasJitSafeControlFlow(method, codeItems)) {
      this.codegenSupportCache.set(method, false);
      return false;
    }
    if (hasMonitorBytecode(codeItems) && !this.hasJitSafeMonitorBody(codeItems)) {
      this.codegenSupportCache.set(method, false);
      return false;
    }
    const supportedOps = new Set([
      "aconst_null", "aload", "aload_0", "aload_1", "aload_2", "aload_3",
      "areturn", "astore", "astore_0", "astore_1", "astore_2", "astore_3", "athrow",
      "aaload", "aastore", "anewarray", "arraylength", "bastore", "baload", "caload", "castore", "checkcast",
      "bipush", "d2i", "dadd", "daload", "dastore", "dcmpg", "dcmpl",
      "dconst_0", "dconst_1", "ddiv", "dload", "dload_0", "dload_1",
      "dload_2", "dload_3", "dmul", "dneg", "dreturn", "dstore",
      "dstore_0", "dstore_1", "dstore_2", "dstore_3", "dsub", "dup", "dup2",
      "d2f", "f2d", "f2i", "fadd", "faload", "fastore", "fcmpg", "fcmpl",
      "fconst_0", "fconst_1", "fconst_2", "fdiv", "fload", "fload_0",
      "fload_1", "fload_2", "fload_3", "fmul", "fneg", "frem", "freturn",
      "fstore", "fstore_0", "fstore_1", "fstore_2", "fstore_3", "fsub", "i2f",
      "getfield", "getstatic", "goto", "i2b", "i2d", "iadd", "iaload", "iastore", "idiv",
      "iconst_m1", "iconst_0", "iconst_1", "iconst_2", "iconst_3", "iconst_4", "iconst_5",
      "if_acmpeq", "if_acmpne", "ifeq", "ifge", "ifgt", "if_icmpeq", "if_icmpge", "if_icmpgt",
      "if_icmple",
      "if_icmplt", "if_icmpne", "ifle", "iflt", "ifne", "ifnonnull",
      "ifnull", "iload", "iload_0", "iload_1", "iload_2", "iload_3",
      "iand", "imul", "ineg", "iinc", "invokeinterface", "invokespecial", "invokestatic", "invokevirtual",
      "i2l", "ior", "irem", "ireturn", "ishl", "ishr", "iushr", "istore", "istore_0", "istore_1", "istore_2",
      "istore_3", "isub", "ixor", "lcmp", "ldc", "ldc_w", "ldc2_w", "ldiv", "lreturn", "lxor", "new", "newarray", "pop", "putfield", "putstatic", "return",
      "monitorenter", "monitorexit", "saload", "sastore", "sipush",
    ]);

    const hasNumericHotPath = codeItems.some((item) => {
      const op = getOp(item && item.instruction);
      return op && (
        op.startsWith("d")
        || op.startsWith("f")
        || op === "i2d"
        || op === "i2f"
        || op === "i2l"
        || op === "i2b"
        || op === "iadd"
        || op === "iand"
        || op === "idiv"
        || op === "imul"
        || op === "ineg"
        || op === "ior"
        || op === "irem"
        || op === "ishl"
        || op === "ishr"
        || op === "isub"
        || op === "iushr"
        || op === "ixor"
        || op === "lcmp"
        || op === "ldiv"
        || op === "lxor"
        || (op === "newarray" && (item.instruction.arg === "double" || item.instruction.arg === "float"))
      );
    });
    const supported = (hasNumericHotPath || this.hasBackwardBranch(method) ||
      this.isShortSupportedHelper(method)) && codeItems.every((item) => {
      const op = getOp(item && item.instruction);
      return !op || supportedOps.has(op);
    });

    this.codegenSupportCache.set(method, supported);
    return supported;
  }

  hasJitSafeMonitorBody(codeItems) {
    // A compiled frame may run across many interpreter scheduler ticks. Do
    // not keep it compiled across JVM operations that can park the current
    // thread while a Java monitor is in scope. Ordinary synchronized blocks
    // remain eligible; wait/join/sleep/park methods resume in the interpreter.
    return !codeItems.some((item) => {
      const instruction = item && item.instruction;
      const op = getOp(instruction);
      if (!op || !op.startsWith("invoke") || !instruction || typeof instruction !== "object") {
        return false;
      }
      const arg = instruction.arg;
      if (!Array.isArray(arg) || !Array.isArray(arg[2])) return false;
      const owner = arg[1];
      const name = arg[2][0];
      return owner === "java/lang/Object" && name === "wait"
        || owner === "java/lang/Thread" && (name === "join" || name === "sleep" || name === "yield")
        || owner === "java/util/concurrent/locks/LockSupport" && String(name).startsWith("park");
    });
  }

  hasJitSafeControlFlow(method, codeItems) {
    // A generated frame runs until it returns or deoptimizes, whereas the
    // interpreter rotates threads between bytecodes. Restrict automatic
    // exception/monitor compilation to leaf normal-flow regions so it cannot
    // move a call (and its arbitrary scheduling effects) across that boundary.
    // Invokes that exist only in an exception handler do not disqualify a
    // compute body: the generated exception table preserves those paths.
    if (method.name === "<init>" || method.name === "<clinit>" || method.name === "run") {
      return false;
    }
    if (this.hasOnlyNoOpExceptionHandlers(method, codeItems)) {
      return true;
    }
    if (hasMonitorBytecode(codeItems)) {
      // Generated monitorenter/exit keep frame.pc and frame locals live. Calls
      // that cannot run in a JIT tier yield as interpreted child frames, so
      // the parent can resume after the call without abandoning its compiled
      // numeric regions. Parking primitives remain excluded above.
      if (!this.hasJitSafeMonitorBody(codeItems)) return false;
      return !normalFlowContains(codeItems, (instruction, op) =>
        op === 'invokespecial' && instruction &&
          Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]) &&
          instruction.arg[2][0] === '<init>');
    }
    return !normalFlowContainsInvoke(codeItems);
  }

  hasOnlyNoOpExceptionHandlers(method, codeItems) {
    const codeAttr = method.attributes.find((attr) => attr.type === "code");
    const table = codeAttr && codeAttr.code && codeAttr.code.exceptionTable || [];
    if (!table.length) return false;
    const labels = buildLabelMap(codeItems);
    return table.every((entry) => {
      const label = entry.handlerLbl || `L${entry.handler_pc}`;
      const handler = labels.get(label);
      return handler !== undefined && isNoOpExceptionHandler(codeItems, handler, labels);
    });
  }

  isShortSupportedHelper(method) {
    const code = method.attributes.find((attr) => attr.type === "code");
    const codeItems = code && code.code && code.code.codeItems || [];
    if (codeItems.filter((item) => item.instruction).length > 16) return false;
    const allowed = new Set([
      "aaload", "aload", "aload_0", "aload_1", "aload_2", "aload_3", "areturn",
      "arraylength", "freturn", "getfield", "getstatic", "iconst_0", "iconst_1",
      "iload", "iload_0", "iload_1", "iload_2", "iload_3", "invokeinterface", "invokevirtual",
      "ireturn", "putfield", "putstatic", "return",
    ]);
    return codeItems.every((item) => !item.instruction || allowed.has(getOp(item.instruction)));
  }

  getLabelMap(frame) {
    if (this.labelCache.has(frame.method)) {
      return this.labelCache.get(frame.method);
    }
    const labels = new Map();
    frame.instructions.forEach((item, index) => {
      if (item.labelDef) {
        const label = item.labelDef.endsWith(":") ? item.labelDef.slice(0, -1) : item.labelDef;
        labels.set(label, index);
      }
    });
    this.labelCache.set(frame.method, labels);
    return labels;
  }

  materialize(frame, locals, stack, pc) {
    frame.locals = locals;
    frame.stack.items = stack;
    frame.pc = pc;
  }

  getFrameClassName(frame) {
    if (!frame) {
      return null;
    }
    return frame.className || (
      typeof this.jvm.findClassNameForMethod === "function"
        ? this.jvm.findClassNameForMethod(frame.method)
        : null
    );
  }

  shouldDeopt(frame, pc) {
    if (this.safePoints !== "bytecode") {
      return false;
    }
    const debug = this.jvm.debugManager;
    if (debug.debugMode && debug.runMode !== "continuing") {
      return true;
    }
    if (debug.hasLocatedBreakpoints() && !debug.isClassJitDeopted(this.getFrameClassName(frame))) {
      return false;
    }
    if (debug.breakpoints.size === 0) {
      return false;
    }
    const item = frame.instructions[pc - 1];
    if (!item || !item.labelDef) {
      return false;
    }
    const numericPc = parseInt(item.labelDef.substring(1, item.labelDef.length - 1), 10);
    return debug.breakpoints.has(numericPc);
  }

  needsBytecodeChecks() {
    const debug = this.jvm.debugManager;
    return Boolean(debug && (debug.debugMode || debug.breakpoints.size > 0));
  }

  target(frame, label) {
    const index = this.getLabelMap(frame).get(label);
    if (index === undefined) {
      throw new Error(`Label ${label} not found`);
    }
    return index;
  }

  compileMethod(method) {
    const AsyncFunction = getAsyncFunctionConstructor();
    if (!AsyncFunction) {
      this.codegenUnavailable = true;
      return null;
    }

    const code = method.attributes.find((attr) => attr.type === "code");
    const codeItems = code.code.codeItems;
    this.compileLabelMap = buildLabelMap(codeItems);
    const body = [
      '"use strict";',
      "const locals = frame.locals;",
      "const stack = frame.stack.items;",
      "let pc = frame.pc;",
      "let bytecodesUntilYield = 100000;",
      "let bytecodeChecks = helpers.needsBytecodeChecks();",
      "let osrCountdown = 10007;",
      `while (pc < ${codeItems.length}) {`,
      "if (--osrCountdown === 0) { osrCountdown = 10007; helpers.materialize(frame, locals, stack, pc); const osr = helpers.wasmOsrProbe(frame, thread, pc, stack.length); if (osr) { if (osr.returned) return { returned: true, value: osr.value }; pc = osr.resumePc; } }",
      "if (--bytecodesUntilYield === 0) { helpers.materialize(frame, locals, stack, pc); await helpers.cooperativeYield(); bytecodesUntilYield = 100000; bytecodeChecks = helpers.needsBytecodeChecks(); }",
      "if (bytecodeChecks && helpers.shouldDeopt(frame, pc)) { helpers.materialize(frame, locals, stack, pc); return { deopt: true }; }",
      "switch (pc) {",
    ];

    try {
      codeItems.forEach((item, index) => {
        body.push(`case ${index}:`);
        const instruction = item.instruction;
        if (!instruction) {
          body.push(`pc = ${index + 1}; break;`);
          return;
        }
        // Locals and operand stack are the frame's live arrays already. Keep
        // only the bytecode PC current here so exception dispatch and save
        // states remain precise without a helper call on every instruction.
        body.push(`frame.pc = ${index};`);
        body.push(this.emitInstruction(instruction, index));
      });
    } finally {
      this.compileLabelMap = null;
    }

    body.push("default: helpers.materialize(frame, locals, stack, pc); return { deopt: true, reason: 'invalid generated pc ' + pc };");
    body.push("}");
    body.push("}");
    body.push("helpers.materialize(frame, locals, stack, pc);");
    body.push("thread.callStack.pop();");
    body.push("return { returned: true, value: helpers.returnVoid() };");

    try {
      return new AsyncFunction("frame", "thread", "helpers", body.join("\n"));
    } catch (err) {
      if (err && err.name === "EvalError") {
        this.codegenUnavailable = true;
      }
      throw err;
    }
  }

  emitInstruction(instruction, index) {
    const op = getOp(instruction);
    const next = index + 1;
    const goNext = `pc = ${next}; break;`;
    const target = (label) => this.targetInstructionIndex(instruction, label);
    const localIndex = (fallback) => Number(instruction.arg ?? fallback);

    switch (op) {
      case "aconst_null": return `stack.push(null); ${goNext}`;
      case "aload": return `stack.push(locals[${localIndex()}]); ${goNext}`;
      case "aload_0": return `stack.push(locals[0]); ${goNext}`;
      case "aload_1": return `stack.push(locals[1]); ${goNext}`;
      case "aload_2": return `stack.push(locals[2]); ${goNext}`;
      case "aload_3": return `stack.push(locals[3]); ${goNext}`;
      case "iload": return `stack.push(locals[${localIndex()}]); ${goNext}`;
      case "iload_0": return `stack.push(locals[0]); ${goNext}`;
      case "iload_1": return `stack.push(locals[1]); ${goNext}`;
      case "iload_2": return `stack.push(locals[2]); ${goNext}`;
      case "iload_3": return `stack.push(locals[3]); ${goNext}`;
      case "dload": return `stack.push(locals[${localIndex()}]); ${goNext}`;
      case "dload_0": return `stack.push(locals[0]); ${goNext}`;
      case "dload_1": return `stack.push(locals[1]); ${goNext}`;
      case "dload_2": return `stack.push(locals[2]); ${goNext}`;
      case "dload_3": return `stack.push(locals[3]); ${goNext}`;
      case "fload": return `stack.push(locals[${localIndex()}]); ${goNext}`;
      case "fload_0": return `stack.push(locals[0]); ${goNext}`;
      case "fload_1": return `stack.push(locals[1]); ${goNext}`;
      case "fload_2": return `stack.push(locals[2]); ${goNext}`;
      case "fload_3": return `stack.push(locals[3]); ${goNext}`;
      case "astore": return `locals[${localIndex()}] = stack.pop(); ${goNext}`;
      case "astore_0": return `locals[0] = stack.pop(); ${goNext}`;
      case "astore_1": return `locals[1] = stack.pop(); ${goNext}`;
      case "astore_2": return `locals[2] = stack.pop(); ${goNext}`;
      case "astore_3": return `locals[3] = stack.pop(); ${goNext}`;
      case "istore": return `locals[${localIndex()}] = stack.pop(); ${goNext}`;
      case "istore_0": return `locals[0] = stack.pop(); ${goNext}`;
      case "istore_1": return `locals[1] = stack.pop(); ${goNext}`;
      case "istore_2": return `locals[2] = stack.pop(); ${goNext}`;
      case "istore_3": return `locals[3] = stack.pop(); ${goNext}`;
      case "dstore": return `locals[${localIndex()}] = stack.pop(); ${goNext}`;
      case "dstore_0": return `locals[0] = stack.pop(); ${goNext}`;
      case "dstore_1": return `locals[1] = stack.pop(); ${goNext}`;
      case "dstore_2": return `locals[2] = stack.pop(); ${goNext}`;
      case "dstore_3": return `locals[3] = stack.pop(); ${goNext}`;
      case "fstore": return `locals[${localIndex()}] = stack.pop(); ${goNext}`;
      case "fstore_0": return `locals[0] = stack.pop(); ${goNext}`;
      case "fstore_1": return `locals[1] = stack.pop(); ${goNext}`;
      case "fstore_2": return `locals[2] = stack.pop(); ${goNext}`;
      case "fstore_3": return `locals[3] = stack.pop(); ${goNext}`;
      case "iconst_0": return `stack.push(0); ${goNext}`;
      case "iconst_m1": return `stack.push(-1); ${goNext}`;
      case "iconst_1": return `stack.push(1); ${goNext}`;
      case "iconst_2": return `stack.push(2); ${goNext}`;
      case "iconst_3": return `stack.push(3); ${goNext}`;
      case "iconst_4": return `stack.push(4); ${goNext}`;
      case "iconst_5": return `stack.push(5); ${goNext}`;
      case "dconst_0": return `stack.push(0.0); ${goNext}`;
      case "dconst_1": return `stack.push(1.0); ${goNext}`;
      case "fconst_0": return `stack.push(0.0); ${goNext}`;
      case "fconst_1": return `stack.push(1.0); ${goNext}`;
      case "fconst_2": return `stack.push(2.0); ${goNext}`;
      case "bipush":
      case "sipush": return `stack.push(${Number(instruction.arg)}); ${goNext}`;
      case "ldc":
      case "ldc_w":
        if (isClassConstant(instruction.arg)) {
          return `stack.push(await helpers.classConstant(${JSON.stringify(instruction.arg[1])})); ${goNext}`;
        }
        return `stack.push(helpers.constantValue(${jsLiteral(instruction.arg)})); ${goNext}`;
      case "ldc2_w": return `stack.push(helpers.constantValue(${jsLiteral(instruction.arg)})); ${goNext}`;
      case "dup": return `stack.push(stack[stack.length - 1]); ${goNext}`;
      case "dup2": return `{ const value1 = stack.pop(); if (typeof value1 === "bigint") { stack.push(value1, value1); } else { const value2 = stack.pop(); stack.push(value2, value1, value2, value1); } } ${goNext}`;
      case "pop": return `stack.pop(); ${goNext}`;
      case "iadd": return `stack.push((stack.pop() + stack.pop()) | 0); ${goNext}`;
      case "isub": return `{ const b = stack.pop(); const a = stack.pop(); stack.push((a - b) | 0); } ${goNext}`;
      case "imul": return `stack.push(Math.imul(stack.pop(), stack.pop())); ${goNext}`;
      case "ineg": return `stack.push((-stack.pop()) | 0); ${goNext}`;
      case "ixor": return `{ const b = stack.pop(); const a = stack.pop(); stack.push(a ^ b); } ${goNext}`;
      case "iand": return `stack.push(stack.pop() & stack.pop()); ${goNext}`;
      case "ior": return `stack.push(stack.pop() | stack.pop()); ${goNext}`;
      case "irem": return `{ const b = stack.pop(); const a = stack.pop(); if (b === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack.push((a % b) | 0); } ${goNext}`;
      case "ishl": return `{ const shift = stack.pop(); const value = stack.pop(); stack.push(value << (shift & 31)); } ${goNext}`;
      case "ishr": return `{ const shift = stack.pop(); const value = stack.pop(); stack.push(value >> (shift & 31)); } ${goNext}`;
      case "iushr": return `{ const shift = stack.pop(); const value = stack.pop(); stack.push((value >>> (shift & 31)) | 0); } ${goNext}`;
      case "idiv": return `{ const b = stack.pop(); const a = stack.pop(); if (b === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack.push((a / b) | 0); } ${goNext}`;
      case "dadd": return `stack.push(stack.pop() + stack.pop()); ${goNext}`;
      case "dsub": return `{ const b = stack.pop(); const a = stack.pop(); stack.push(a - b); } ${goNext}`;
      case "dmul": return `stack.push(stack.pop() * stack.pop()); ${goNext}`;
      case "ddiv": return `{ const b = stack.pop(); const a = stack.pop(); stack.push(a / b); } ${goNext}`;
      case "dneg": return `stack.push(-stack.pop()); ${goNext}`;
      case "fadd": return `stack.push(Math.fround(stack.pop() + stack.pop())); ${goNext}`;
      case "fsub": return `{ const b = stack.pop(); const a = stack.pop(); stack.push(Math.fround(a - b)); } ${goNext}`;
      case "fmul": return `stack.push(Math.fround(stack.pop() * stack.pop())); ${goNext}`;
      case "fdiv": return `{ const b = stack.pop(); const a = stack.pop(); stack.push(Math.fround(a / b)); } ${goNext}`;
      case "frem": return `{ const b = stack.pop(); const a = stack.pop(); stack.push(Math.fround(a % b)); } ${goNext}`;
      case "fneg": return `stack.push(Math.fround(-stack.pop())); ${goNext}`;
      case "i2d": return goNext;
      case "i2b": return `stack.push((stack.pop() << 24) >> 24); ${goNext}`;
      case "i2l": return `stack.push(BigInt(stack.pop())); ${goNext}`;
      case "i2f": return `stack.push(Math.fround(stack.pop())); ${goNext}`;
      case "f2d": return goNext;
      case "d2f": return `stack.push(Math.fround(stack.pop())); ${goNext}`;
      case "f2i": return `stack.push(helpers.floatToInt(stack.pop())); ${goNext}`;
      case "d2i": return `stack.push(Math.trunc(stack.pop()) | 0); ${goNext}`;
      case "lxor": return `{ const b = stack.pop(); const a = stack.pop(); stack.push(a ^ b); } ${goNext}`;
      case "ldiv": return `{ const b = stack.pop(); const a = stack.pop(); if (b === 0n) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack.push(a / b); } ${goNext}`;
      case "lcmp": return `{ const b = stack.pop(); const a = stack.pop(); stack.push(a < b ? -1 : (a > b ? 1 : 0)); } ${goNext}`;
      case "iinc": return `locals[${Number(instruction.varnum)}] = (locals[${Number(instruction.varnum)}] + ${Number(instruction.incr)}) | 0; ${goNext}`;
      case "dcmpg": return `stack.push(helpers.compareDouble(stack.pop(), stack.pop(), 1)); ${goNext}`;
      case "dcmpl": return `stack.push(helpers.compareDouble(stack.pop(), stack.pop(), -1)); ${goNext}`;
      case "newarray": return `stack.push(helpers.newPrimitiveArray(stack.pop(), ${JSON.stringify(instruction.arg)})); ${goNext}`;
      case "anewarray": return `stack.push(helpers.newReferenceArray(stack.pop(), ${JSON.stringify(instruction.arg)})); ${goNext}`;
      case "arraylength": return `stack.push(helpers.arrayLength(stack.pop(), frame)); ${goNext}`;
      case "checkcast": return `{ const value = stack[stack.length - 1]; await helpers.checkCast(value, ${JSON.stringify(instruction.arg)}); } ${goNext}`;
      case "aaload":
      case "iaload":
      case "daload":
      case "faload":
      case "baload":
      case "caload":
      case "saload": return `stack.push(helpers.arrayLoad(stack.pop(), stack.pop(), frame)); ${goNext}`;
      case "aastore":
      case "iastore":
      case "dastore":
      case "fastore":
      case "bastore":
      case "castore":
      case "sastore": return `helpers.arrayStore(stack.pop(), stack.pop(), stack.pop(), frame); ${goNext}`;
      case "getfield": return `stack.push(helpers.getField(stack.pop(), ${JSON.stringify(instruction.arg)})); ${goNext}`;
      case "putfield": return `{ const value = stack.pop(); const obj = stack.pop(); helpers.putField(obj, ${JSON.stringify(instruction.arg)}, value); } ${goNext}`;
      case "getstatic": return `{ let value = helpers.getStatic(${JSON.stringify(instruction.arg)}, thread); if (value && typeof value.then === "function") value = await value; if (value === helpers.staticDeopt()) { helpers.materialize(frame, locals, stack, ${index}); return { deopt: true, transient: true, reason: "class initialization at generated getstatic" }; } stack.push(value); } ${goNext}`;
      case "putstatic": return `{ let changed = helpers.putStatic(${JSON.stringify(instruction.arg)}, stack[stack.length - 1], thread); if (changed && typeof changed.then === "function") changed = await changed; if (changed === helpers.staticDeopt()) { helpers.materialize(frame, locals, stack, ${index}); return { deopt: true, transient: true, reason: "class initialization at generated putstatic" }; } stack.pop(); } ${goNext}`;
      case "new": return `{ const value = await helpers.newObject(${JSON.stringify(instruction.arg)}, thread); if (value === helpers.staticDeopt()) { helpers.materialize(frame, locals, stack, ${index}); return { deopt: true, transient: true, reason: "class initialization at generated new" }; } stack.push(value); } ${goNext}`;
      case "monitorenter": return `{ const monitor = stack[stack.length - 1]; if (!helpers.monitorEnter(monitor, thread)) { helpers.materialize(frame, locals, stack, ${index}); return { deopt: true, transient: true, reason: "contended generated monitorenter" }; } stack.pop(); } ${goNext}`;
      case "monitorexit": return `helpers.monitorExit(stack.pop(), thread); ${goNext}`;
      case "invokestatic":
      case "invokevirtual":
      case "invokeinterface":
      case "invokespecial": return `{ helpers.materialize(frame, locals, stack, ${next}); const value = await helpers.invoke(${JSON.stringify(op)}, frame, ${JSON.stringify(instruction)}, thread, ${index}); if (value && value.deopt) return value; if (value !== helpers.returnVoid()) stack.push(value); if (thread.status !== "runnable") { helpers.materialize(frame, locals, stack, ${next}); return { deopt: true, reason: "thread yielded in generated ${op}" }; } } ${goNext}`;
      case "goto": return `pc = ${target(instruction.arg)}; break;`;
      case "ifeq": return `if (stack.pop() === 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifne": return `if (stack.pop() !== 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "iflt": return `if (stack.pop() < 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifge": return `if (stack.pop() >= 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifgt": return `if (stack.pop() > 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifle": return `if (stack.pop() <= 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifnull": return `if (stack.pop() === null) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifnonnull": return `if (stack.pop() !== null) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "if_icmpeq": return `{ const b = stack.pop(); const a = stack.pop(); if (a === b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmpne": return `{ const b = stack.pop(); const a = stack.pop(); if (a !== b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmplt": return `{ const b = stack.pop(); const a = stack.pop(); if (a < b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmpge": return `{ const b = stack.pop(); const a = stack.pop(); if (a >= b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmpgt": return `{ const b = stack.pop(); const a = stack.pop(); if (a > b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmple": return `{ const b = stack.pop(); const a = stack.pop(); if (a <= b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_acmpeq": return `{ const b = stack.pop(); const a = stack.pop(); if (a === b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_acmpne": return `{ const b = stack.pop(); const a = stack.pop(); if (a !== b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "athrow": return `throw stack.pop();`;
      case "return":
        return `helpers.materialize(frame, locals, stack, ${next}); thread.callStack.pop(); return { returned: true, value: helpers.returnVoid() };`;
      case "areturn":
      case "ireturn":
      case "lreturn":
      case "freturn":
      case "dreturn":
        return `{ const ret = stack.pop(); helpers.materialize(frame, locals, stack, ${next}); thread.callStack.pop(); return { returned: true, value: ret }; }`;
      default:
        return `helpers.materialize(frame, locals, stack, ${index}); return { deopt: true, reason: "unsupported generated opcode ${op}" };`;
    }
  }

  targetInstructionIndex(instruction, label) {
    const labels = this.compileLabelMap;
    const index = labels && labels.get(label);
    if (index === undefined) {
      throw new Error(`Label ${label} not found`);
    }
    return index;
  }

  // OSR probe shared by the runner and generated code: a frame that has been
  // interpreting for thousands of bytecodes is exactly the kind the wasm tier
  // wants (single-invocation loop monsters like va.d never re-enter through
  // invoke()). prepare() warms/compiles regardless of position; entering
  // mid-method is only sound at a supported block leader with an empty
  // operand stack.
  wasmOsrProbe(frame, thread, pc, stackLength) {
    if (!this.wasmJit.enabled) return null;
    frame.pc = pc;
    const prep = this.wasmJit.prepare(frame);
    if (!prep || stackLength !== 0) return null;
    const result = this.wasmJit.execute(frame, thread, prep.st, prep.blk, true);
    if (result.returned) {
      return {
        returned: true,
        value: prep.st.meta.retChar === "V" ? RETURN_VOID : prep.st.meta.box.ret,
      };
    }
    return { resumePc: frame.pc };
  }

  async runFrame(frame, thread) {
    this.runnerRunCount += 1;
    this.recordExecution(this.runnerMethodRunCounts, frame);
    const locals = frame.locals;
    const stack = frame.stack.items;
    const instructions = frame.instructions;
    let pc = frame.pc;
    let bytecodesUntilYield = 100000;
    // Prime stride so successive probes land on different pcs of a loop body —
    // a fixed multiple of the body length would hit the same (possibly
    // non-leader, non-empty-stack) offset forever.
    let bytecodesUntilOsrProbe = 10007;

    while (pc < instructions.length) {
      bytecodesUntilYield -= 1;
      bytecodesUntilOsrProbe -= 1;
      if (bytecodesUntilOsrProbe === 0) {
        bytecodesUntilOsrProbe = 10007;
        this.materialize(frame, locals, stack, pc);
        const osr = this.wasmOsrProbe(frame, thread, pc, stack.length);
        if (osr) {
          if (osr.returned) return { returned: true, value: osr.value };
          pc = osr.resumePc; // transient exit: resume interpreting there
        }
      }
      if (bytecodesUntilYield === 0) {
        this.materialize(frame, locals, stack, pc);
        await yieldToEventLoop();
        bytecodesUntilYield = 100000;
      }
      if (this.shouldDeopt(frame, pc)) {
        this.materialize(frame, locals, stack, pc);
        return { deopt: true };
      }

      const item = instructions[pc];
      const instruction = item.instruction;
      pc += 1;
      if (!instruction) {
        continue;
      }

      const op = typeof instruction === "string" ? instruction : instruction.op;
      this.materialize(frame, locals, stack, pc - 1);
      switch (op) {
        case "aconst_null": stack.push(null); break;
        case "aload": stack.push(locals[Number(instruction.arg)]); break;
        case "aload_0": stack.push(locals[0]); break;
        case "aload_1": stack.push(locals[1]); break;
        case "aload_2": stack.push(locals[2]); break;
        case "aload_3": stack.push(locals[3]); break;
        case "iload": stack.push(locals[Number(instruction.arg)]); break;
        case "iload_0": stack.push(locals[0]); break;
        case "iload_1": stack.push(locals[1]); break;
        case "iload_2": stack.push(locals[2]); break;
        case "iload_3": stack.push(locals[3]); break;
        case "dload": stack.push(locals[Number(instruction.arg)]); break;
        case "dload_0": stack.push(locals[0]); break;
        case "dload_1": stack.push(locals[1]); break;
        case "dload_2": stack.push(locals[2]); break;
        case "dload_3": stack.push(locals[3]); break;
        case "fload": stack.push(locals[Number(instruction.arg)]); break;
        case "fload_0": stack.push(locals[0]); break;
        case "fload_1": stack.push(locals[1]); break;
        case "fload_2": stack.push(locals[2]); break;
        case "fload_3": stack.push(locals[3]); break;
        case "astore": locals[Number(instruction.arg)] = stack.pop(); break;
        case "astore_0": locals[0] = stack.pop(); break;
        case "astore_1": locals[1] = stack.pop(); break;
        case "astore_2": locals[2] = stack.pop(); break;
        case "astore_3": locals[3] = stack.pop(); break;
        case "istore": locals[Number(instruction.arg)] = stack.pop(); break;
        case "istore_0": locals[0] = stack.pop(); break;
        case "istore_1": locals[1] = stack.pop(); break;
        case "istore_2": locals[2] = stack.pop(); break;
        case "istore_3": locals[3] = stack.pop(); break;
        case "dstore": locals[Number(instruction.arg)] = stack.pop(); break;
        case "dstore_0": locals[0] = stack.pop(); break;
        case "dstore_1": locals[1] = stack.pop(); break;
        case "dstore_2": locals[2] = stack.pop(); break;
        case "dstore_3": locals[3] = stack.pop(); break;
        case "fstore": locals[Number(instruction.arg)] = stack.pop(); break;
        case "fstore_0": locals[0] = stack.pop(); break;
        case "fstore_1": locals[1] = stack.pop(); break;
        case "fstore_2": locals[2] = stack.pop(); break;
        case "fstore_3": locals[3] = stack.pop(); break;
        case "iconst_0": stack.push(0); break;
        case "iconst_1": stack.push(1); break;
        case "iconst_2": stack.push(2); break;
        case "iconst_3": stack.push(3); break;
        case "iconst_4": stack.push(4); break;
        case "iconst_5": stack.push(5); break;
        case "iconst_m1": stack.push(-1); break;
        case "dconst_0": stack.push(0.0); break;
        case "dconst_1": stack.push(1.0); break;
        case "fconst_0": stack.push(0.0); break;
        case "fconst_1": stack.push(1.0); break;
        case "fconst_2": stack.push(2.0); break;
        case "bipush":
        case "sipush": stack.push(Number(instruction.arg)); break;
        case "ldc":
        case "ldc_w":
          stack.push(isClassConstant(instruction.arg)
            ? await this.classConstant(instruction.arg[1])
            : this.constantValue(instruction.arg));
          break;
        case "ldc2_w": stack.push(this.constantValue(instruction.arg)); break;
        case "dup": stack.push(stack[stack.length - 1]); break;
        case "dup2": {
          const value1 = stack.pop();
          if (typeof value1 === "bigint") stack.push(value1, value1);
          else {
            const value2 = stack.pop();
            stack.push(value2, value1, value2, value1);
          }
          break;
        }
        case "pop": stack.pop(); break;
        case "iadd": stack.push((stack.pop() + stack.pop()) | 0); break;
        case "isub": { const b = stack.pop(); const a = stack.pop(); stack.push((a - b) | 0); break; }
        case "imul": stack.push(Math.imul(stack.pop(), stack.pop())); break;
        case "ineg": stack.push((-stack.pop()) | 0); break;
        case "ixor": { const b = stack.pop(); const a = stack.pop(); stack.push(a ^ b); break; }
        case "ishr": { const shift = stack.pop(); const value = stack.pop(); stack.push(value >> (shift & 31)); break; }
        case "idiv": { const b = stack.pop(); const a = stack.pop(); if (b === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack.push((a / b) | 0); break; }
        case "dadd": stack.push(stack.pop() + stack.pop()); break;
        case "dsub": { const b = stack.pop(); const a = stack.pop(); stack.push(a - b); break; }
        case "dmul": stack.push(stack.pop() * stack.pop()); break;
        case "ddiv": { const b = stack.pop(); const a = stack.pop(); stack.push(a / b); break; }
        case "dneg": stack.push(-stack.pop()); break;
        case "fadd": stack.push(Math.fround(stack.pop() + stack.pop())); break;
        case "fsub": { const b = stack.pop(); const a = stack.pop(); stack.push(Math.fround(a - b)); break; }
        case "fmul": stack.push(Math.fround(stack.pop() * stack.pop())); break;
        case "fdiv": { const b = stack.pop(); const a = stack.pop(); stack.push(Math.fround(a / b)); break; }
        case "frem": { const b = stack.pop(); const a = stack.pop(); stack.push(Math.fround(a % b)); break; }
        case "fneg": stack.push(Math.fround(-stack.pop())); break;
        case "i2d": break;
        case "i2l": stack.push(BigInt(stack.pop())); break;
        case "i2f": stack.push(Math.fround(stack.pop())); break;
        case "f2d": break;
        case "d2f": stack.push(Math.fround(stack.pop())); break;
        case "f2i": stack.push(floatToInt(stack.pop())); break;
        case "i2b": stack.push((stack.pop() << 24) >> 24); break;
        case "d2i": stack.push(Math.trunc(stack.pop()) | 0); break;
        case "lxor": { const b = stack.pop(); const a = stack.pop(); stack.push(a ^ b); break; }
        case "ldiv": {
          const b = stack.pop();
          const a = stack.pop();
          if (b === 0n) throw { type: "java/lang/ArithmeticException", message: "/ by zero" };
          stack.push(a / b);
          break;
        }
        case "lcmp": { const b = stack.pop(); const a = stack.pop(); stack.push(a < b ? -1 : (a > b ? 1 : 0)); break; }
        case "iand": stack.push(stack.pop() & stack.pop()); break;
        case "ior": stack.push(stack.pop() | stack.pop()); break;
        case "irem": {
          const b = stack.pop();
          const a = stack.pop();
          if (b === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" };
          stack.push((a % b) | 0);
          break;
        }
        case "ishl": { const shift = stack.pop(); const value = stack.pop(); stack.push(value << (shift & 31)); break; }
        case "iushr": { const shift = stack.pop(); const value = stack.pop(); stack.push((value >>> (shift & 31)) | 0); break; }
        case "iinc": {
          const index = Number(instruction.varnum);
          locals[index] = (locals[index] + Number(instruction.incr)) | 0;
          break;
        }
        case "dcmpg": stack.push(compareDouble(stack.pop(), stack.pop(), 1)); break;
        case "dcmpl": stack.push(compareDouble(stack.pop(), stack.pop(), -1)); break;
        case "newarray": stack.push(this.newPrimitiveArray(stack.pop(), instruction.arg)); break;
        case "anewarray": stack.push(this.newReferenceArray(stack.pop(), instruction.arg)); break;
        case "multianewarray": stack.push(this.newMultiArray(instruction.arg, stack)); break;
        case "arraylength": stack.push(this.arrayLength(stack.pop(), frame)); break;
        case "checkcast": {
          const value = stack[stack.length - 1];
          if (value !== null && !await this.jvm.isInstanceOfAsync(runtimeClassName(value), instruction.arg)) {
            throw {
              type: "java/lang/ClassCastException",
              message: `${runtimeClassName(value)} cannot be cast to ${instruction.arg}`,
            };
          }
          break;
        }
        case "aaload":
        case "iaload":
        case "daload":
        case "faload":
        case "baload": stack.push(this.arrayLoad(stack.pop(), stack.pop(), frame)); break;
        case "caload":
        case "saload": stack.push(this.arrayLoad(stack.pop(), stack.pop(), frame)); break;
        case "aastore":
        case "iastore":
        case "dastore":
        case "fastore":
        case "bastore":
        case "castore":
        case "sastore": this.arrayStore(stack.pop(), stack.pop(), stack.pop(), frame); break;
        case "getfield": stack.push(this.getField(stack.pop(), instruction.arg)); break;
        case "putfield": { const value = stack.pop(); const obj = stack.pop(); this.putField(obj, instruction.arg, value); break; }
        case "getstatic": {
          const value = await this.getStatic(instruction.arg, thread);
          if (value === STATIC_DEOPT) {
            this.materialize(frame, locals, stack, pc - 1);
            return { deopt: true, transient: true, reason: "class initialization at getstatic" };
          }
          stack.push(value);
          break;
        }
        case "putstatic": {
          const changed = await this.putStatic(instruction.arg, stack[stack.length - 1], thread);
          if (changed === STATIC_DEOPT) {
            this.materialize(frame, locals, stack, pc - 1);
            return { deopt: true, transient: true, reason: "class initialization at putstatic" };
          }
          stack.pop();
          break;
        }
        case "new": {
          const value = await this.newObject(instruction.arg, thread);
          if (value === STATIC_DEOPT) {
            this.materialize(frame, locals, stack, pc - 1);
            return { deopt: true, transient: true, reason: "class initialization at new" };
          }
          stack.push(value);
          break;
        }
        case "monitorenter": {
          const monitor = stack[stack.length - 1];
          if (!this.monitorEnter(monitor, thread)) {
            this.materialize(frame, locals, stack, pc - 1);
            return { deopt: true, transient: true, reason: "contended monitorenter" };
          }
          stack.pop();
          break;
        }
        case "monitorexit": this.monitorExit(stack.pop(), thread); break;
        case "invokestatic":
        case "invokevirtual":
        case "invokeinterface":
        case "invokespecial": {
          const invokePc = pc - 1;
          this.materialize(frame, locals, stack, pc);
          const value = await this.invoke(op, frame, instruction, thread, invokePc);
          if (value && value.deopt) return value;
          if (value !== RETURN_VOID) stack.push(value);
          if (thread.status !== "runnable") {
            this.materialize(frame, locals, stack, pc);
            return { deopt: true, reason: `thread yielded in ${frame.className || ""}.${frame.method.name}` };
          }
          break;
        }
        case "goto": pc = this.target(frame, instruction.arg); break;
        case "ifeq": if (stack.pop() === 0) pc = this.target(frame, instruction.arg); break;
        case "ifne": if (stack.pop() !== 0) pc = this.target(frame, instruction.arg); break;
        case "iflt": if (stack.pop() < 0) pc = this.target(frame, instruction.arg); break;
        case "ifge": if (stack.pop() >= 0) pc = this.target(frame, instruction.arg); break;
        case "ifgt": if (stack.pop() > 0) pc = this.target(frame, instruction.arg); break;
        case "ifle": if (stack.pop() <= 0) pc = this.target(frame, instruction.arg); break;
        case "ifnull": if (stack.pop() === null) pc = this.target(frame, instruction.arg); break;
        case "ifnonnull": if (stack.pop() !== null) pc = this.target(frame, instruction.arg); break;
        case "if_icmpeq": { const b = stack.pop(); const a = stack.pop(); if (a === b) pc = this.target(frame, instruction.arg); break; }
        case "if_icmpne": { const b = stack.pop(); const a = stack.pop(); if (a !== b) pc = this.target(frame, instruction.arg); break; }
        case "if_icmplt": { const b = stack.pop(); const a = stack.pop(); if (a < b) pc = this.target(frame, instruction.arg); break; }
        case "if_icmpge": { const b = stack.pop(); const a = stack.pop(); if (a >= b) pc = this.target(frame, instruction.arg); break; }
        case "if_icmpgt": { const b = stack.pop(); const a = stack.pop(); if (a > b) pc = this.target(frame, instruction.arg); break; }
        case "if_icmple": { const b = stack.pop(); const a = stack.pop(); if (a <= b) pc = this.target(frame, instruction.arg); break; }
        case "if_acmpeq": { const b = stack.pop(); const a = stack.pop(); if (a === b) pc = this.target(frame, instruction.arg); break; }
        case "if_acmpne": { const b = stack.pop(); const a = stack.pop(); if (a !== b) pc = this.target(frame, instruction.arg); break; }
        case "athrow": throw stack.pop();
        case "return":
          this.materialize(frame, locals, stack, pc);
          thread.callStack.pop();
          return { returned: true, value: RETURN_VOID };
        case "areturn":
        case "ireturn":
        case "lreturn":
        case "freturn":
        case "dreturn": {
          const ret = stack.pop();
          this.materialize(frame, locals, stack, pc);
          thread.callStack.pop();
          return { returned: true, value: ret };
        }
        default:
          this.materialize(frame, locals, stack, pc - 1);
          return { deopt: true, reason: `unsupported opcode ${op} in ${frame.className || ""}.${frame.method.name}` };
      }
    }

    this.materialize(frame, locals, stack, pc);
    thread.callStack.pop();
    return { returned: true, value: RETURN_VOID };
  }

  returnVoid() {
    return RETURN_VOID;
  }

  staticDeopt() {
    return STATIC_DEOPT;
  }

  cooperativeYield() {
    return yieldToEventLoop();
  }

  compareDouble(value2, value1, nanValue) {
    return compareDouble(value2, value1, nanValue);
  }

  floatToInt(value) {
    return floatToInt(value);
  }

  constantValue(arg) {
    if (arg && typeof arg === "object" && Object.prototype.hasOwnProperty.call(arg, "value")) {
      return arg.value;
    }
    if (typeof arg === "string") {
      return this.jvm.internString(arg);
    }
    return arg;
  }

  async classConstant(className) {
    return this.jvm.getClassObject(className);
  }

  newPrimitiveArray(count, type) {
    const defaultValue = type === "double" || type === "float" ? 0.0 : 0;
    const array = new Array(count).fill(defaultValue);
    array.type = primitiveArrayType(type);
    array.length = count;
    array.hashCode = this.jvm.nextHashCode++;
    return array;
  }

  newReferenceArray(count, elementType) {
    const array = new Array(count).fill(null);
    array.type = elementType.startsWith("[") ? `[${elementType}` : `[L${elementType};`;
    array.elementType = elementType;
    array.length = count;
    array.hashCode = this.jvm.nextHashCode++;
    return array;
  }

  newMultiArray(arg, stack) {
    const [className, dimensions] = arg;
    const counts = [];
    for (let i = 0; i < dimensions; i += 1) {
      counts.unshift(stack.pop());
    }
    const baseType = className.replace(/^\[+/, "");
    const leafDefault = baseType.startsWith("L") ? null : 0;
    const make = (depth) => {
      const count = counts[depth];
      const arr = new Array(count);
      arr.type = className.slice(depth);
      arr.hashCode = this.jvm.nextHashCode++;
      if (depth === counts.length - 1) {
        arr.fill(leafDefault);
      } else {
        for (let i = 0; i < count; i += 1) arr[i] = make(depth + 1);
      }
      return arr;
    };
    return make(0);
  }

  arrayLength(arrayRef, frame) {
    if (arrayRef === null || arrayRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: `Attempted to get length of null array in ${frame.method.name}` };
    }
    return arrayRef.length;
  }

  async checkCast(value, className) {
    if (value === null || value === undefined) return;
    if (!await this.jvm.isInstanceOfAsync(runtimeClassName(value), className)) {
      throw {
        type: "java/lang/ClassCastException",
        message: `${runtimeClassName(value)} cannot be cast to ${className}`,
      };
    }
  }

  monitorEnter(monitor, thread) {
    if (monitor === null || monitor === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (!monitor.isLocked) {
      monitor.isLocked = true;
      monitor.lockOwner = thread.id;
      monitor.lockCount = 1;
      delete thread.blockingOn;
      return true;
    }
    if (monitor.lockOwner === thread.id) {
      monitor.lockCount += 1;
      return true;
    }
    thread.status = "BLOCKED";
    thread.blockingOn = monitor;
    return false;
  }

  monitorExit(monitor, thread) {
    if (monitor === null || monitor === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (monitor.lockOwner !== thread.id) {
      throw { type: "java/lang/IllegalMonitorStateException", message: null };
    }
    monitor.lockCount -= 1;
    if (monitor.lockCount === 0) {
      monitor.isLocked = false;
      monitor.lockOwner = null;
    }
  }

  arrayLoad(index, arrayRef, frame) {
    if (arrayRef === null || arrayRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: `Attempted to load from null array in ${frame.method.name}` };
    }
    if (index < 0 || index >= arrayRef.length) {
      throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: `Index ${index} out of bounds for length ${arrayRef.length}` };
    }
    return arrayRef.elements ? arrayRef.elements[index] : arrayRef[index];
  }

  arrayStore(value, index, arrayRef, frame) {
    if (arrayRef === null || arrayRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: `Attempted to store into null array in ${frame.method.name}` };
    }
    if (index < 0 || index >= arrayRef.length) {
      throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: `Index ${index} out of bounds for length ${arrayRef.length}` };
    }
    arrayRef[index] = value;
  }

  getField(objRef, arg) {
    const [, className, [fieldName]] = arg;
    if (objRef === null || objRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (objRef.fields) {
      const fieldKey = resolveInstanceFieldKey(this.jvm, objRef, className, fieldName);
      return fieldKey ? objRef.fields[fieldKey] : undefined;
    }
    return objRef[`${className}.${fieldName}`] ?? objRef[fieldName];
  }

  putField(objRef, arg, value) {
    const [, className, [fieldName]] = arg;
    if (objRef === null || objRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (!objRef.fields) objRef.fields = {};
    const fieldKey = resolveInstanceFieldKey(this.jvm, objRef, className, fieldName) || `${className}.${fieldName}`;
    objRef.fields[fieldKey] = value;
    objRef[fieldName] = value;
  }

  getStatic(arg, thread) {
    const [, className, [fieldName, descriptor]] = arg;
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED") {
      return this.getStaticCold(arg, thread);
    }
    return this.getStaticInitialized(className, fieldName, descriptor);
  }

  async getStaticCold(arg, thread) {
    const [, className, [fieldName, descriptor]] = arg;
    const wasFramePushed = await this.jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) return STATIC_DEOPT;
    return this.getStaticInitialized(className, fieldName, descriptor);
  }

  getStaticInitialized(className, fieldName, descriptor) {
    const key = `${fieldName}:${descriptor}`;
    let currentClassName = className;
    while (currentClassName) {
      const classData = this.jvm.classes[currentClassName];
      if (classData && classData.staticFields) {
        if (classData.staticFields.has(key)) return classData.staticFields.get(key);
        if (classData.staticFields.has(fieldName)) return classData.staticFields.get(fieldName);
        for (const [candidate, value] of classData.staticFields.entries()) {
          if (typeof candidate === "string" && candidate.split(":")[0].replace(/'/g, "") === fieldName) {
            return value;
          }
        }
      }
      currentClassName = classData && classData.ast && classData.ast.classes[0]
        ? classData.ast.classes[0].superClassName
        : null;
    }
    const jreClass = this.jvm.jre[className];
    if (jreClass && jreClass.staticFields) {
      for (const candidate of [key, `'${key}'`, `${key}'`, `'${key}`, fieldName, `'${fieldName}'`]) {
        if (Object.prototype.hasOwnProperty.call(jreClass.staticFields, candidate)) {
          return jreClass.staticFields[candidate];
        }
      }
    }
    throw new Error(`Unresolved static field: ${className}.${fieldName}`);
  }

  putStatic(arg, value, thread) {
    const [, className, [fieldName, descriptor]] = arg;
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED") {
      return this.putStaticCold(arg, value, thread);
    }
    return this.putStaticInitialized(className, fieldName, descriptor, value);
  }

  async putStaticCold(arg, value, thread) {
    const [, className, [fieldName, descriptor]] = arg;
    const wasFramePushed = await this.jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) return STATIC_DEOPT;
    return this.putStaticInitialized(className, fieldName, descriptor, value);
  }

  putStaticInitialized(className, fieldName, descriptor, value) {
    const key = `${fieldName}:${descriptor}`;
    let currentClassName = className;
    while (currentClassName) {
      const classData = this.jvm.classes[currentClassName];
      if (classData && classData.staticFields && classData.staticFields.has(key)) {
        classData.staticFields.set(key, value);
        return true;
      }
      currentClassName = classData && classData.ast && classData.ast.classes[0]
        ? classData.ast.classes[0].superClassName
        : null;
    }
    const classData = this.jvm.classes[className];
    if (classData && classData.staticFields) {
      classData.staticFields.set(key, value);
      return true;
    }
    throw new Error(`Unsupported putstatic: ${className}.${fieldName}`);
  }

  async newObject(className, thread) {
    const wasFramePushed = await this.jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) return STATIC_DEOPT;
    await this.jvm.loadClassByName(className).catch(() => null);

    const fields = {};
    let currentClassName = className;
    while (currentClassName) {
      const currentClassData = this.jvm.classes[currentClassName];
      if (!currentClassData || !currentClassData.ast || !currentClassData.ast.classes[0]) break;
      const classFields = currentClassData.ast.classes[0].items.filter((item) => item.type === "field");
      for (const field of classFields) {
        const descriptor = field.field.descriptor;
        let defaultValue = null;
        if (descriptor === "I" || descriptor === "B" || descriptor === "S" || descriptor === "Z" || descriptor === "C") defaultValue = 0;
        else if (descriptor === "J") defaultValue = BigInt(0);
        else if (descriptor === "F" || descriptor === "D") defaultValue = 0.0;
        fields[`${currentClassName}.${field.field.name}`] = defaultValue;
      }
      currentClassName = currentClassData.ast.classes[0].superClassName;
    }
    return {
      type: className,
      fields,
      hashCode: this.jvm.nextHashCode++,
      isLocked: false,
      lockOwner: null,
      lockCount: 0,
      waitSet: [],
    };
  }

  async invoke(op, frame, instruction, thread, invokePc) {
    const [, declaredClassName, [methodName, descriptor]] = instruction.arg;
    const { params, returnType } = parseDescriptor(descriptor);
    const stackSnapshot = frame.stack.items.slice();
    if (op === "invokestatic") {
      const wasFramePushed = await this.jvm.initializeClassIfNeeded(declaredClassName, thread);
      if (wasFramePushed) {
        frame.pc = invokePc;
        return {
          deopt: true,
          transient: true,
          reason: `class initialization at invokestatic ${declaredClassName}.${methodName}${descriptor}`,
        };
      }
    }
    const args = [];
    for (let i = 0; i < params.length; i += 1) {
      args.unshift(frame.stack.items.pop());
    }

    let receiver = null;
    let targetClassName = declaredClassName;
    if (op !== "invokestatic") {
      receiver = frame.stack.items.pop();
      if (receiver === null || receiver === undefined) {
        throw { type: "java/lang/NullPointerException", message: null };
      }
      if (op === "invokevirtual" || op === "invokeinterface") {
        targetClassName = receiver.type || declaredClassName;
      }
    }

    const jreMethod = await this.findJreMethod(targetClassName, declaredClassName, methodName, descriptor);
    if (jreMethod) {
      let result = jreMethod(this.jvm, receiver, args, thread);
      if (result && typeof result.then === "function") result = await result;
      if (result === ASYNC_METHOD_SENTINEL) {
        // Some JRE shims (notably Method.invoke) install a Java child frame
        // and use the sentinel to tell the interpreter not to push a result.
        // Yield the compiled caller when that happened; its post-invoke PC is
        // already materialized and the child will supply the eventual value.
        if (!thread.callStack.isEmpty() && thread.callStack.peek() !== frame) {
          return {
            deopt: true,
            transient: true,
            reason: `async JRE handoff ${targetClassName}.${methodName}${descriptor}`,
          };
        }
        return RETURN_VOID;
      }
      if (returnType === "V" || result === undefined) return RETURN_VOID;
      return typeof result === "boolean" ? (result ? 1 : 0) : result;
    }

    let classData = this.jvm.classes[targetClassName] || await this.jvm.loadClassByName(targetClassName);
    let method = this.jvm.findMethod(classData, methodName, descriptor);
    let lookupClass = targetClassName;
    while (!method && (op === "invokevirtual" || op === "invokeinterface") &&
      classData && classData.ast.classes[0].superClassName) {
      lookupClass = classData.ast.classes[0].superClassName;
      classData = this.jvm.classes[lookupClass] || await this.jvm.loadClassByName(lookupClass);
      method = this.jvm.findMethod(classData, methodName, descriptor);
    }
    if (!method) {
      if (methodName === "<init>") return RETURN_VOID;
      frame.stack.items = stackSnapshot;
      frame.pc = invokePc;
      throw new Error(`Unsupported ${op}: ${targetClassName}.${methodName}${descriptor}`);
    }
    const jsChildSupported = this.isSupported(method) || this.isShortSupportedHelper(method);

    const child = new Frame(method);
    child.className = lookupClass;
    let localIndex = 0;
    if (op !== "invokestatic") {
      child.locals[0] = receiver;
      localIndex = 1;
    }
    for (let i = 0; i < params.length; i += 1) {
      child.locals[localIndex] = args[i];
      localIndex += params[i] === "long" || params[i] === "double" ? 2 : 1;
    }
    thread.callStack.push(child);
    if (this.wasmJit.enabled) {
      // Ask the Wasm tier before rejecting the child on JS-JIT policy. Wasm
      // can prove numeric loops covered by a wrap-and-rethrow diagnostic
      // handler even when the whole-method JS tier conservatively rejects the
      // same exceptional call graph. This ordering is important for callers
      // such as rasterizers: permanently deoptimizing the parent first meant a
      // child compiled successfully later but could no longer help it.
      const wasmResult = this.wasmJit.runNested(child, thread, {
        // A JS-policy-rejected child has no in-call runner fallback. Execute it
        // speculatively only when every normally reachable block is compiled;
        // handler-only diagnostic blocks may remain outside Wasm.
        requireNormalFlowFullyCompiled: !jsChildSupported,
      });
      if (wasmResult.returned) {
        if (returnType === "V" || wasmResult.isVoid) return RETURN_VOID;
        return wasmResult.value;
      }
      if (wasmResult.exited && !jsChildSupported) {
        // The child remains on the Java call stack at its materialized exit
        // PC. Yield the generated parent transiently; executeTick will resume
        // the child through the normal scheduler and then continue the parent
        // at the already-materialized post-invoke PC.
        return {
          deopt: true,
          transient: true,
          reason: `wasm callee exit ${targetClassName}.${methodName}${descriptor}`,
        };
      }
    }
    if (!jsChildSupported) {
      // The generated caller materializes its post-invoke pc and operand stack
      // before entering this helper. Keep the initialized child on the Java
      // call stack so the interpreter can finish only that unsupported call;
      // its return instruction supplies any result to the caller's materialized
      // stack, after which the hot caller resumes generated execution. This is
      // also exception-safe: propagation uses parent.pc - 1 as the invoke site.
      return {
        deopt: true,
        transient: true,
        reason: `interpreted callee ${targetClassName}.${methodName}${descriptor}`,
      };
    }
    const generated = this.getGeneratedFunction(method);
    const result = generated
      ? await this.runGeneratedFrame(generated, child, thread)
      : await this.runFrame(child, thread);
    if (result.deopt) return result;
    if (returnType === "V" || result.value === RETURN_VOID) return RETURN_VOID;
    return result.value;
  }

  async findJreMethod(targetClassName, declaredClassName, methodName, descriptor) {
    const direct = this.jvm._jreFindMethod(targetClassName, methodName, descriptor)
      || this.jvm._jreFindMethod(declaredClassName, methodName, descriptor);
    if (direct) return direct;

    // Arrays implement Object's virtual methods even though they do not have
    // ordinary class metadata to walk. Keep generated invokevirtual behavior
    // aligned with the interpreter (notably for array clone()).
    if (typeof targetClassName === "string" && targetClassName.startsWith("[")) {
      const objectMethod = this.jvm._jreFindMethod(
        "java/lang/Object", methodName, descriptor,
      );
      if (objectMethod) return objectMethod;
    }

    let currentClassName = targetClassName;
    while (currentClassName) {
      const classData = this.jvm.classes[currentClassName] || await this.jvm.loadClassByName(currentClassName);
      if (!classData || !classData.ast || !classData.ast.classes[0]) break;
      currentClassName = classData.ast.classes[0].superClassName;
      const method = this.jvm._jreFindMethod(currentClassName, methodName, descriptor);
      if (method) return method;
    }
    return null;
  }

}

function isClassConstant(arg) {
  return Array.isArray(arg) && arg[0] === 'Class' && typeof arg[1] === 'string';
}

function compareDouble(value2, value1, nanValue) {
  if (Number.isNaN(value1) || Number.isNaN(value2)) return nanValue;
  if (value1 < value2) return -1;
  if (value1 > value2) return 1;
  return 0;
}

function floatToInt(value) {
  if (Number.isNaN(value)) return 0;
  if (value >= 2147483647) return 2147483647;
  if (value <= -2147483648) return -2147483648;
  return Math.trunc(value) | 0;
}

function runtimeClassName(value) {
  if (typeof value === "string" || value instanceof String) return "java/lang/String";
  return value && (value._className || value.type);
}

function yieldToEventLoop() {
  return new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

function primitiveArrayType(type) {
  switch (type) {
    case "double": return "[D";
    case "float": return "[F";
    case "boolean": return "[Z";
    case "byte": return "[B";
    case "char": return "[C";
    case "short": return "[S";
    case "long": return "[J";
    case "int":
    default: return "[I";
  }
}

function getOp(instruction) {
  if (!instruction) return null;
  return typeof instruction === "string" ? instruction : instruction.op;
}

function hasMonitorBytecode(codeItems) {
  return codeItems.some((item) => {
    const op = getOp(item && item.instruction);
    return op === "monitorenter" || op === "monitorexit";
  });
}

function hasExperimentalControlFlow(codeItems) {
  return codeItems.some((item) => {
    const op = getOp(item && item.instruction);
    return op === "athrow" || op === "monitorenter" || op === "monitorexit";
  });
}

function normalFlowContainsInvoke(codeItems) {
  return normalFlowContains(codeItems, (_instruction, op) =>
    Boolean(op && op.startsWith("invoke")));
}

function normalFlowContains(codeItems, predicate) {
  const labels = buildLabelMap(codeItems);
  const pending = [0];
  const visited = new Set();

  while (pending.length) {
    const index = pending.pop();
    if (index < 0 || index >= codeItems.length || visited.has(index)) continue;
    visited.add(index);

    const instruction = codeItems[index] && codeItems[index].instruction;
    const op = getOp(instruction);
    if (predicate(instruction, op)) return true;

    if (op === "athrow" || op === "return" || op === "areturn" ||
      op === "dreturn" || op === "freturn" || op === "ireturn" || op === "lreturn") {
      continue;
    }
    if (op === "goto" || op === "goto_w") {
      const target = branchTargetIndex(instruction, labels);
      if (target === undefined) {
        return codeItems.some((item) => {
          const candidate = item && item.instruction;
          return predicate(candidate, getOp(candidate));
        });
      }
      pending.push(target);
      continue;
    }
    if (op && op.startsWith("if")) {
      const target = branchTargetIndex(instruction, labels);
      if (target === undefined) {
        return codeItems.some((item) => {
          const candidate = item && item.instruction;
          return predicate(candidate, getOp(candidate));
        });
      }
      pending.push(target);
    }
    // Label-only entries and ordinary instructions both fall through.
    pending.push(index + 1);
  }

  return false;
}

function branchTargetIndex(instruction, labels) {
  if (!instruction || typeof instruction !== "object") return undefined;
  const arg = Array.isArray(instruction.arg) ? instruction.arg[0] : instruction.arg;
  return labels.get(arg);
}

function jsLiteral(value) {
  if (typeof value === "bigint") return `${value}n`;
  return JSON.stringify(value);
}

function buildLabelMap(codeItems) {
  const labels = new Map();
  codeItems.forEach((item, index) => {
    if (item && item.labelDef) {
      const label = item.labelDef.endsWith(":") ? item.labelDef.slice(0, -1) : item.labelDef;
      labels.set(label, index);
    }
  });
  return labels;
}

function getAsyncFunctionConstructor() {
  try {
    return Object.getPrototypeOf(async function generatedProbe() {}).constructor;
  } catch (_) {
    return null;
  }
}

module.exports = JitCompiler;
