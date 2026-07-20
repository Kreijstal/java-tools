const Frame = require("../core/frame");
const { ASYNC_METHOD_SENTINEL } = require("../core/constants");
const { parseDescriptor } = require("../parsing/typeParser");
const { resolveInstanceFieldKey } = require("../instructions/object");
const WasmJit = require("./WasmJit");
const { isNoOpExceptionHandler } = WasmJit._test;

const RETURN_VOID = Symbol("jit.return.void");
const STATIC_DEOPT = Symbol("jit.static.deopt");
const ASYNC_INVOKE = Symbol("jit.invoke.async");

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
    this.normalizedCodeItemsCache = new WeakMap();
    this.codegenUnavailable = false;
    this.codegenCompileErrors = new WeakMap();
    this.syncCallSites = [];
    this.nextSyncCallSiteId = 1;
    this.fieldSites = [];
    this.nextFieldSiteId = 1;
    this.inlineIntegerLeafCache = new WeakMap();
    const firefoxDefault = typeof navigator !== "undefined" &&
      /Firefox\//.test(navigator.userAgent || "");
    const browserRuntime = typeof window !== "undefined" && typeof navigator !== "undefined";
    this.profileMethods = options.profileMethods ?? !browserRuntime;
    this.preferWholeMethodJs = options.preferWholeMethodJs ?? firefoxDefault;
    this.generatedRunCount = 0;
    this.syncGeneratedRunCount = 0;
    this.syncInlinedCallCount = 0;
    this.syncReusedFrameCount = 0;
    this.syncIntrinsicCallCount = 0;
    this.intrinsicArrayCopyNoopCount = 0;
    this.intrinsicArrayCopyWithinCount = 0;
    this.inlinedMethodRunCounts = new Map();
    this.intrinsicMethodRunCounts = new Map();
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
    const codeItems = this.getCodeItems(method);
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

  getCodeItems(method) {
    if (this.normalizedCodeItemsCache.has(method)) {
      return this.normalizedCodeItemsCache.get(method);
    }
    const code = method.attributes.find((attr) => attr.type === "code");
    const original = code && code.code && code.code.codeItems || [];
    let normalized = original;
    for (let index = 0; index < original.length; index += 1) {
      const item = original[index];
      const instruction = item && item.instruction;
      if (getOp(instruction) !== "wide") continue;
      const expanded = expandWideInstruction(instruction);
      if (!expanded) continue;
      if (normalized === original) normalized = original.slice();
      normalized[index] = { ...item, instruction: expanded };
    }
    this.normalizedCodeItemsCache.set(method, normalized);
    return normalized;
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
    if (this.profileMethods) {
      this.methodRunCounts.set(methodKey, (this.methodRunCounts.get(methodKey) || 0) + 1);
    }
    this.runningFrames.add(frame);
    try {
      const generated = this.getGeneratedFunction(frame.method);
      const result = generated
        ? await this.runGeneratedFrame(generated, frame, thread)
        : await this.runFrame(frame, thread);
      if (result && result.deopt) {
        if (this.profileMethods) {
          this.lastDeoptReason = result.reason;
          this.methodDeoptCounts.set(
            methodKey, (this.methodDeoptCounts.get(methodKey) || 0) + 1,
          );
          this.methodDeoptReasons.set(methodKey, result.reason || "unspecified");
        }
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
    console.error(`JIT generated=${this.generatedRunCount} sync=${this.syncGeneratedRunCount} inlined=${this.syncInlinedCallCount} intrinsics=${this.syncIntrinsicCallCount} reusedFrames=${this.syncReusedFrameCount} runner=${this.runnerRunCount}`);
    for (const [method, count] of rows) {
      const deopts = this.methodDeoptCounts.get(method) || 0;
      console.error(`  ${count.toLocaleString()} runs ${method}${deopts ? ` (${deopts} deopt)` : ""}`);
    }
    this.dumpExecutionCounts("generated callees", this.generatedMethodRunCounts, limit);
    this.dumpExecutionCounts("inlined callees", this.inlinedMethodRunCounts, limit);
    this.dumpExecutionCounts("intrinsic callees", this.intrinsicMethodRunCounts, limit);
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

  runGeneratedFrame(generated, frame, thread, initialBytecodeChecks) {
    if (this.profileMethods) {
      this.generatedRunCount += 1;
      if (generated.jvmSynchronous) this.syncGeneratedRunCount += 1;
      this.recordExecution(this.generatedMethodRunCounts, frame);
    }
    return generated(frame, thread, this, initialBytecodeChecks);
  }

  recordExecution(counts, frame) {
    if (!this.profileMethods) return;
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

    const codeItems = this.getCodeItems(method);
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

    const codeItems = this.getCodeItems(method);
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
    const codeItems = this.getCodeItems(method);
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

  materializeCached(frame, locals, stack, sp, pc) {
    stack.length = sp;
    this.materialize(frame, locals, stack, pc);
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

  skipJitOnce(frame) {
    frame.jitSkipOnce = true;
  }

  target(frame, label) {
    const index = this.getLabelMap(frame).get(label);
    if (index === undefined) {
      throw new Error(`Label ${label} not found`);
    }
    return index;
  }

  compileMethod(method) {
    const stackless = this.compileStacklessIntegerRaster(method);
    if (stackless) return stackless;

    return this.compileBaselineMethod(method);
  }

  compileBaselineMethod(method) {
    const synchronous = this.canCompileSynchronously(method);
    const GeneratedFunction = synchronous ? Function : getAsyncFunctionConstructor();
    if (!GeneratedFunction) {
      this.codegenUnavailable = true;
      return null;
    }

    const code = method.attributes.find((attr) => attr.type === "code");
    const codeItems = this.getCodeItems(method);
    this.compileLabelMap = buildLabelMap(codeItems);
    this.compileSynchronous = synchronous;
    const body = [
      '"use strict";',
      "const locals = frame.locals;",
      "const stack = frame.stack.items;",
      "let sp = stack.length;",
      "let pc = frame.pc;",
      "let bytecodesUntilYield = 10000;",
      "let bytecodeChecks = initialBytecodeChecks === undefined ? helpers.needsBytecodeChecks() : initialBytecodeChecks;",
      "let osrCountdown = 10007;",
      `while (pc < ${codeItems.length}) {`,
      "if (--osrCountdown === 0) { osrCountdown = 10007; helpers.materializeCached(frame, locals, stack, sp, pc); const osr = helpers.wasmOsrProbe(frame, thread, pc, sp); if (osr) { if (osr.returned) return { returned: true, value: osr.value }; pc = osr.resumePc; sp = stack.length; } }",
      synchronous
        ? "if (--bytecodesUntilYield === 0) { helpers.materializeCached(frame, locals, stack, sp, pc); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'synchronous generated quantum' }; }"
        : "if (--bytecodesUntilYield === 0) { helpers.materializeCached(frame, locals, stack, sp, pc); await helpers.cooperativeYield(); bytecodesUntilYield = 10000; bytecodeChecks = helpers.needsBytecodeChecks(); }",
      "if (bytecodeChecks && helpers.shouldDeopt(frame, pc)) { helpers.materializeCached(frame, locals, stack, sp, pc); return { deopt: true }; }",
      "switch (pc) {",
    ];

    try {
      codeItems.forEach((item, index) => {
        body.push(`case ${index}:`);
        const instruction = item.instruction;
        if (!instruction) {
          body.push(`if (bytecodeChecks) { pc = ${index + 1}; break; }`);
          return;
        }
        // Locals and operand stack are the frame's live arrays already. The
        // exact frame PC is only needed before an instruction that can throw
        // or deopt; control-flow edges materialize their own resume PC.
        if (this.instructionNeedsPrecisePc(instruction)) {
          body.push(`stack.length = sp; frame.pc = ${index};`);
        }
        body.push(this.emitInstruction(instruction, index));
      });
    } finally {
      this.compileLabelMap = null;
      this.compileSynchronous = false;
    }

    body.push("default: helpers.materializeCached(frame, locals, stack, sp, pc); return { deopt: true, reason: 'invalid generated pc ' + pc };");
    body.push("}");
    body.push("}");
    body.push("helpers.materializeCached(frame, locals, stack, sp, pc);");
    body.push("thread.callStack.pop();");
    body.push("return { returned: true, value: helpers.returnVoid() };");

    try {
      const generated = new GeneratedFunction("frame", "thread", "helpers", "initialBytecodeChecks", body.join("\n"));
      generated.jvmSynchronous = synchronous;
      return generated;
    } catch (err) {
      if (err && err.name === "EvalError") {
        this.codegenUnavailable = true;
      }
      throw err;
    }
  }

  compileStacklessIntegerRaster(method) {
    const rasterDescriptor = "(IIIIIIIBIIII[IIIII)V";
    const wrapperDescriptor = "(IIIIIIIIIIIIZIII)V";
    if (method.name !== "a" ||
        method.descriptor !== rasterDescriptor && method.descriptor !== wrapperDescriptor) return null;
    const code = method.attributes.find((attr) => attr.type === "code");
    const codeItems = this.getCodeItems(method);
    if (!this.canCompileSynchronously(method)) return null;

    const ops = codeItems.map((item) => getOp(item && item.instruction)).filter(Boolean);
    const hotCalls = codeItems.filter((item) => {
      const instruction = item && item.instruction;
      return getOp(instruction) === "invokestatic" && instruction &&
        Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]) &&
        instruction.arg[2][1] === (method.descriptor === rasterDescriptor
          ? "(IIIIIII[III)V" : rasterDescriptor);
    }).length;
    const rasterShape = method.descriptor === rasterDescriptor && codeItems.length >= 1000 &&
      ops.filter((op) => op === "iload").length >= 300 &&
      ops.filter((op) => op === "istore").length >= 100 && hotCalls >= 5;
    const wrapperShape = method.descriptor === wrapperDescriptor && codeItems.length >= 170 &&
      ops.filter((op) => op === "iload").length >= 80 && hotCalls >= 6;
    if (!rasterShape && !wrapperShape) {
      return null;
    }

    const labels = buildLabelMap(codeItems);
    const depths = this.computeStackDepths(codeItems, labels);
    if (!depths) return null;
    const leaders = new Set([0]);
    const terminal = new Set([
      "areturn", "athrow", "dreturn", "freturn", "ireturn", "lreturn", "return",
    ]);
    for (let index = 0; index < codeItems.length; index += 1) {
      const instruction = codeItems[index] && codeItems[index].instruction;
      const op = getOp(instruction);
      if (op === "goto" || op && op.startsWith("if")) {
        const target = branchTargetIndex(instruction, labels);
        if (target === undefined) return null;
        leaders.add(target);
        if (index + 1 < codeItems.length) leaders.add(index + 1);
      }
      if (op && op.startsWith("invoke")) {
        leaders.add(index);
        if (index + 1 < codeItems.length) leaders.add(index + 1);
      }
      if (terminal.has(op) && index + 1 < codeItems.length) leaders.add(index + 1);
    }
    const exceptionTable = code.code.exceptionTable || [];
    for (const entry of exceptionTable) {
      const handler = labels.get(entry.handlerLbl || `L${entry.handler_pc}`);
      if (handler !== undefined) leaders.add(handler);
    }

    const orderedLeaders = [...leaders].sort((a, b) => a - b);
    const nextLeader = new Map();
    orderedLeaders.forEach((leader, position) => {
      nextLeader.set(leader, orderedLeaders[position + 1] ?? codeItems.length);
    });

    let temporary = 0;
    const temp = () => `v${temporary++}`;
    const body = [
      '"use strict";',
      "const locals = frame.locals;",
      "const stack = frame.stack.items;",
      "let pc = frame.pc;",
      "let blocksUntilYield = 10000;",
      "if ((initialBytecodeChecks === undefined ? helpers.needsBytecodeChecks() : initialBytecodeChecks)) return { deopt: true, transient: true, reason: 'stackless raster debug entry' };",
      "while (true) {",
      "if (--blocksUntilYield === 0) { helpers.materialize(frame, locals, stack, pc); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'stackless raster quantum' }; }",
      "switch (pc) {",
    ];

    const saveStack = (expressions) => {
      const lines = expressions.map((expression, index) => `stack[${index}] = ${expression};`);
      lines.push(`stack.length = ${expressions.length};`);
      return lines;
    };
    const transfer = (expressions, target) => [
      ...saveStack(expressions),
      `pc = ${target};`,
      "continue;",
    ];
    const deopt = (expressions, index, reason) => [
      ...saveStack(expressions),
      `helpers.materialize(frame, locals, stack, ${index});`,
      `return { deopt: true, reason: ${JSON.stringify(reason)} };`,
    ];
    const localIndex = (instruction, op) => {
      if (instruction && typeof instruction === "object" && instruction.arg !== undefined) {
        return Number(instruction.arg);
      }
      const match = /_([0-3])$/.exec(op || "");
      return match ? Number(match[1]) : NaN;
    };
    const constant = (instruction, op) => {
      if (op === "iconst_m1") return "-1";
      if (/^iconst_[0-5]$/.test(op)) return op.slice(-1);
      return jsLiteral(Number(instruction.arg));
    };

    for (const leader of orderedLeaders) {
      const entryDepth = depths[leader];
      if (entryDepth === undefined) continue;
      body.push(`case ${leader}: {`);
      const expressions = [];
      for (let index = 0; index < entryDepth; index += 1) {
        const value = temp();
        body.push(`const ${value} = stack[${index}];`);
        expressions.push(value);
      }
      let terminated = false;
      const end = nextLeader.get(leader);

      for (let index = leader; index < end; index += 1) {
        const instruction = codeItems[index] && codeItems[index].instruction;
        const op = getOp(instruction);
        if (!op || op === "nop") continue;
        const pop = () => expressions.pop();
        const binary = (format) => {
          const right = pop();
          const left = pop();
          if (left === undefined || right === undefined) return false;
          expressions.push(format(left, right));
          return true;
        };
        let valid = true;

        if (/^[ai]load(?:_[0-3])?$/.test(op)) {
          const value = temp();
          body.push(`const ${value} = locals[${localIndex(instruction, op)}];`);
          expressions.push(value);
        } else if (/^[ai]store(?:_[0-3])?$/.test(op)) {
          const value = pop();
          if (value === undefined) valid = false;
          else body.push(`locals[${localIndex(instruction, op)}] = ${value};`);
        } else if (op === "aconst_null") {
          expressions.push("null");
        } else if (/^iconst_(?:m1|[0-5])$/.test(op) ||
                   op === "bipush" || op === "sipush" || op === "ldc" || op === "ldc_w") {
          if ((op === "ldc" || op === "ldc_w") && typeof instruction.arg !== "number") {
            const value = temp();
            body.push(`const ${value} = helpers.constantValue(${jsLiteral(instruction.arg)});`);
            expressions.push(value);
          } else {
            expressions.push(constant(instruction, op));
          }
        } else if (op === "dup") {
          const value = pop();
          if (value === undefined) valid = false;
          else {
            const duplicate = temp();
            body.push(`const ${duplicate} = ${value};`);
            expressions.push(duplicate, duplicate);
          }
        } else if (op === "pop") {
          if (pop() === undefined) valid = false;
        } else if (op === "iadd") {
          valid = binary((a, b) => `((${a} + ${b}) | 0)`);
        } else if (op === "isub") {
          valid = binary((a, b) => `((${a} - ${b}) | 0)`);
        } else if (op === "imul") {
          valid = binary((a, b) => `Math.imul(${a}, ${b})`);
        } else if (op === "ixor") {
          valid = binary((a, b) => `(${a} ^ ${b})`);
        } else if (op === "iand") {
          valid = binary((a, b) => `(${a} & ${b})`);
        } else if (op === "ior") {
          valid = binary((a, b) => `(${a} | ${b})`);
        } else if (op === "ishl") {
          valid = binary((a, b) => `(${a} << (${b} & 31))`);
        } else if (op === "ishr") {
          valid = binary((a, b) => `(${a} >> (${b} & 31))`);
        } else if (op === "iushr") {
          valid = binary((a, b) => `((${a} >>> (${b} & 31)) | 0)`);
        } else if (op === "ineg") {
          const value = pop();
          if (value === undefined) valid = false;
          else expressions.push(`((-${value}) | 0)`);
        } else if (op === "idiv" || op === "irem") {
          const divisorExpression = pop();
          const dividendExpression = pop();
          if (divisorExpression === undefined || dividendExpression === undefined) valid = false;
          else {
            const divisor = temp();
            body.push(`frame.pc = ${index}; const ${divisor} = ${divisorExpression};`);
            body.push(`if (${divisor} === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" };`);
            expressions.push(op === "idiv"
              ? `((${dividendExpression} / ${divisor}) | 0)`
              : `((${dividendExpression} % ${divisor}) | 0)`);
          }
        } else if (op === "iinc") {
          const variable = Number(instruction.varnum ?? instruction.arg);
          const increment = Number(instruction.incr ?? 0);
          body.push(`locals[${variable}] = (locals[${variable}] + ${increment}) | 0;`);
        } else if (op === "getstatic") {
          const value = temp();
          const fieldSiteId = this.registerFieldSite(instruction.arg);
          body.push(`frame.pc = ${index}; const ${value} = helpers.getStaticSyncAt(${fieldSiteId});`);
          if (expressions.length) body.push(...saveStack(expressions));
          body.push(`if (${value} === helpers.staticDeopt()) { helpers.materialize(frame, locals, stack, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "class initialization in stackless raster" }; }`);
          expressions.push(value);
        } else if (op === "iaload") {
          const arrayIndex = pop();
          const array = pop();
          if (arrayIndex === undefined || array === undefined) valid = false;
          else {
            const value = temp();
            body.push(`frame.pc = ${index}; const ${value} = helpers.arrayLoad(${arrayIndex}, ${array}, frame);`);
            expressions.push(value);
          }
        } else if (op && op.startsWith("invoke")) {
          const invokeDescriptor = instruction.arg[2][1];
          if (rasterShape && op === "invokestatic" &&
              invokeDescriptor === "(IIIIIII[III)V" && expressions.length >= 10) {
            const base = expressions.length - 10;
            const direct = temp();
            body.push(`const ${direct} = helpers.packedColorScanlineDirect(${expressions.slice(base).join(", ")}, locals[42], ${JSON.stringify(instruction.arg[1])});`);
            body.push(`if (${direct} !== helpers.asyncInvokeSentinel()) {`);
            body.push(...saveStack(expressions.slice(0, base)));
            body.push(`pc = ${index + 1}; continue;`);
            body.push("}");
          }
          const callSiteId = this.registerSyncCallSite(op, instruction);
          const parsed = parseDescriptor(instruction.arg[2][1]);
          body.push(...saveStack(expressions));
          body.push(`helpers.materialize(frame, locals, stack, ${index + 1});`);
          const value = temp();
          body.push(`const ${value} = helpers.tryInvokeSyncAt(${callSiteId}, frame, thread);`);
          body.push(`if (${value} === helpers.asyncInvokeSentinel()) { helpers.materialize(frame, locals, stack, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "asynchronous stackless raster callee" }; }`);
          body.push(`if (${value} && ${value}.deopt) return ${value};`);
          body.push(`if (${value} !== helpers.returnVoid()) stack.push(${value});`);
          body.push(`if (thread.status !== "runnable") return { deopt: true, transient: true, reason: "thread yielded in stackless raster callee" };`);
          const resultDepth = expressions.length - parsed.params.length - (op === "invokestatic" ? 0 : 1) +
            (parsed.returnType === "void" ? 0 : 1);
          body.push(`stack.length = ${resultDepth}; pc = ${index + 1}; continue;`);
          terminated = true;
        } else if (op === "goto") {
          body.push(...transfer(expressions, branchTargetIndex(instruction, labels)));
          terminated = true;
        } else if (op && op.startsWith("if")) {
          let condition;
          if (op.startsWith("if_icmp") || op.startsWith("if_acmp")) {
            const right = pop();
            const left = pop();
            const comparisons = {
              if_icmpeq: "===", if_icmpne: "!==", if_icmplt: "<", if_icmpge: ">=",
              if_icmpgt: ">", if_icmple: "<=", if_acmpeq: "===", if_acmpne: "!==",
            };
            if (left === undefined || right === undefined || !comparisons[op]) valid = false;
            else condition = `${left} ${comparisons[op]} ${right}`;
          } else {
            const value = pop();
            const comparisons = {
              ifeq: "=== 0", ifne: "!== 0", iflt: "< 0", ifge: ">= 0",
              ifgt: "> 0", ifle: "<= 0", ifnull: "=== null", ifnonnull: "!== null",
            };
            if (value === undefined || !comparisons[op]) valid = false;
            else condition = `${value} ${comparisons[op]}`;
          }
          if (valid) {
            body.push(...saveStack(expressions));
            body.push(`pc = (${condition}) ? ${branchTargetIndex(instruction, labels)} : ${index + 1}; continue;`);
            terminated = true;
          }
        } else if (op === "athrow") {
          const value = pop();
          if (value === undefined) valid = false;
          else {
            body.push(`frame.pc = ${index}; throw ${value};`);
            terminated = true;
          }
        } else if (op === "return") {
          body.push(...saveStack(expressions));
          body.push(`helpers.materialize(frame, locals, stack, ${index + 1}); thread.callStack.pop(); return { returned: true, value: helpers.returnVoid() };`);
          terminated = true;
        } else if (/^[aifdl]return$/.test(op)) {
          const value = pop();
          if (value === undefined) valid = false;
          else {
            body.push(...saveStack(expressions));
            body.push(`helpers.materialize(frame, locals, stack, ${index + 1}); thread.callStack.pop(); return { returned: true, value: ${value} };`);
            terminated = true;
          }
        } else {
          valid = false;
        }

        if (!valid) {
          body.push(...deopt(expressions, index, `unsupported stackless raster opcode ${op}`));
          terminated = true;
        }
        if (terminated) break;
      }

      if (!terminated) body.push(...transfer(expressions, end));
      body.push("}");
    }

    body.push("default: helpers.materialize(frame, locals, stack, pc); return { deopt: true, reason: 'invalid stackless raster pc ' + pc };");
    body.push("}", "}");
    try {
      const generated = new Function("frame", "thread", "helpers", "initialBytecodeChecks", body.join("\n"));
      generated.jvmSynchronous = true;
      generated.jvmStacklessRaster = true;
      return generated;
    } catch (_) {
      return null;
    }
  }

  computeStackDepths(codeItems, labels) {
    const depths = new Array(codeItems.length);
    const pending = [0];
    depths[0] = 0;
    const terminal = new Set([
      "areturn", "athrow", "dreturn", "freturn", "ireturn", "lreturn", "return",
    ]);
    while (pending.length) {
      const index = pending.pop();
      const instruction = codeItems[index] && codeItems[index].instruction;
      const op = getOp(instruction);
      const effect = stackEffect(instruction);
      if (effect === null) return null;
      const after = depths[index] + effect;
      if (after < 0) return null;
      const successors = [];
      if (op === "goto") {
        successors.push(branchTargetIndex(instruction, labels));
      } else if (op && op.startsWith("if")) {
        successors.push(index + 1, branchTargetIndex(instruction, labels));
      } else if (!terminal.has(op) && index + 1 < codeItems.length) {
        successors.push(index + 1);
      }
      for (const successor of successors) {
        if (successor === undefined || successor < 0 || successor >= codeItems.length) return null;
        if (depths[successor] === undefined) {
          depths[successor] = after;
          pending.push(successor);
        } else if (depths[successor] !== after) {
          return null;
        }
      }
    }
    return depths;
  }

  canCompileSynchronously(method) {
    const codeItems = this.getCodeItems(method);
    return codeItems.every((item) => {
      const instruction = item && item.instruction;
      const op = getOp(instruction);
      if (!op) return true;
      return !(op === "ldc" || op === "ldc_w") || !isClassConstant(instruction.arg);
    });
  }

  instructionNeedsPrecisePc(instruction) {
    const op = getOp(instruction);
    if (!op) return false;
    if (op.startsWith("invoke") || op === "athrow" || op === "checkcast" ||
        op === "getfield" || op === "putfield" || op === "getstatic" ||
        op === "putstatic" || op === "new" || op === "newarray" ||
        op === "anewarray" || op === "multianewarray" || op === "arraylength" ||
        op === "monitorenter" || op === "monitorexit" || op === "idiv" ||
        op === "irem" || op === "ldiv") return true;
    if (op.endsWith("aload") || op.endsWith("astore")) return true;
    return (op === "ldc" || op === "ldc_w") && isClassConstant(instruction.arg);
  }

  emitInstruction(instruction, index) {
    const op = getOp(instruction);
    const next = index + 1;
    // In normal execution, straight-line cases fall through to the next case
    // instead of returning to the while/switch dispatcher after every JVM
    // bytecode. Debug and breakpoint mode still redispatches each bytecode so
    // precise stepping and safe-point checks remain intact.
    const goNext = `if (bytecodeChecks) { pc = ${next}; break; }`;
    const target = (label) => this.targetInstructionIndex(instruction, label);
    const localIndex = (fallback) => Number(instruction.arg ?? fallback);

    switch (op) {
      case "aconst_null": return `stack[sp++] = null; ${goNext}`;
      case "aload": return `stack[sp++] = locals[${localIndex()}]; ${goNext}`;
      case "aload_0": return `stack[sp++] = locals[0]; ${goNext}`;
      case "aload_1": return `stack[sp++] = locals[1]; ${goNext}`;
      case "aload_2": return `stack[sp++] = locals[2]; ${goNext}`;
      case "aload_3": return `stack[sp++] = locals[3]; ${goNext}`;
      case "iload": return `stack[sp++] = locals[${localIndex()}]; ${goNext}`;
      case "iload_0": return `stack[sp++] = locals[0]; ${goNext}`;
      case "iload_1": return `stack[sp++] = locals[1]; ${goNext}`;
      case "iload_2": return `stack[sp++] = locals[2]; ${goNext}`;
      case "iload_3": return `stack[sp++] = locals[3]; ${goNext}`;
      case "dload": return `stack[sp++] = locals[${localIndex()}]; ${goNext}`;
      case "dload_0": return `stack[sp++] = locals[0]; ${goNext}`;
      case "dload_1": return `stack[sp++] = locals[1]; ${goNext}`;
      case "dload_2": return `stack[sp++] = locals[2]; ${goNext}`;
      case "dload_3": return `stack[sp++] = locals[3]; ${goNext}`;
      case "fload": return `stack[sp++] = locals[${localIndex()}]; ${goNext}`;
      case "fload_0": return `stack[sp++] = locals[0]; ${goNext}`;
      case "fload_1": return `stack[sp++] = locals[1]; ${goNext}`;
      case "fload_2": return `stack[sp++] = locals[2]; ${goNext}`;
      case "fload_3": return `stack[sp++] = locals[3]; ${goNext}`;
      case "astore": return `locals[${localIndex()}] = stack[--sp]; ${goNext}`;
      case "astore_0": return `locals[0] = stack[--sp]; ${goNext}`;
      case "astore_1": return `locals[1] = stack[--sp]; ${goNext}`;
      case "astore_2": return `locals[2] = stack[--sp]; ${goNext}`;
      case "astore_3": return `locals[3] = stack[--sp]; ${goNext}`;
      case "istore": return `locals[${localIndex()}] = stack[--sp]; ${goNext}`;
      case "istore_0": return `locals[0] = stack[--sp]; ${goNext}`;
      case "istore_1": return `locals[1] = stack[--sp]; ${goNext}`;
      case "istore_2": return `locals[2] = stack[--sp]; ${goNext}`;
      case "istore_3": return `locals[3] = stack[--sp]; ${goNext}`;
      case "dstore": return `locals[${localIndex()}] = stack[--sp]; ${goNext}`;
      case "dstore_0": return `locals[0] = stack[--sp]; ${goNext}`;
      case "dstore_1": return `locals[1] = stack[--sp]; ${goNext}`;
      case "dstore_2": return `locals[2] = stack[--sp]; ${goNext}`;
      case "dstore_3": return `locals[3] = stack[--sp]; ${goNext}`;
      case "fstore": return `locals[${localIndex()}] = stack[--sp]; ${goNext}`;
      case "fstore_0": return `locals[0] = stack[--sp]; ${goNext}`;
      case "fstore_1": return `locals[1] = stack[--sp]; ${goNext}`;
      case "fstore_2": return `locals[2] = stack[--sp]; ${goNext}`;
      case "fstore_3": return `locals[3] = stack[--sp]; ${goNext}`;
      case "iconst_0": return `stack[sp++] = 0; ${goNext}`;
      case "iconst_m1": return `stack[sp++] = -1; ${goNext}`;
      case "iconst_1": return `stack[sp++] = 1; ${goNext}`;
      case "iconst_2": return `stack[sp++] = 2; ${goNext}`;
      case "iconst_3": return `stack[sp++] = 3; ${goNext}`;
      case "iconst_4": return `stack[sp++] = 4; ${goNext}`;
      case "iconst_5": return `stack[sp++] = 5; ${goNext}`;
      case "dconst_0": return `stack[sp++] = 0.0; ${goNext}`;
      case "dconst_1": return `stack[sp++] = 1.0; ${goNext}`;
      case "fconst_0": return `stack[sp++] = 0.0; ${goNext}`;
      case "fconst_1": return `stack[sp++] = 1.0; ${goNext}`;
      case "fconst_2": return `stack[sp++] = 2.0; ${goNext}`;
      case "bipush":
      case "sipush": return `stack[sp++] = ${Number(instruction.arg)}; ${goNext}`;
      case "ldc":
      case "ldc_w":
        if (isClassConstant(instruction.arg)) {
          return `stack[sp++] = await helpers.classConstant(${JSON.stringify(instruction.arg[1])}); ${goNext}`;
        }
        return `stack[sp++] = helpers.constantValue(${jsLiteral(instruction.arg)}); ${goNext}`;
      case "ldc2_w": return `stack[sp++] = helpers.constantValue(${jsLiteral(instruction.arg)}); ${goNext}`;
      case "dup": return `stack[sp] = stack[sp - 1]; sp += 1; ${goNext}`;
      case "dup2": return `{ const value1 = stack[--sp]; if (typeof value1 === "bigint") { stack[sp++] = value1; stack[sp++] = value1; } else { const value2 = stack[--sp]; stack[sp++] = value2; stack[sp++] = value1; stack[sp++] = value2; stack[sp++] = value1; } } ${goNext}`;
      case "pop": return `sp -= 1; ${goNext}`;
      case "iadd": return `{ const b = stack[--sp]; stack[sp - 1] = (stack[sp - 1] + b) | 0; } ${goNext}`;
      case "isub": return `{ const b = stack[--sp]; stack[sp - 1] = (stack[sp - 1] - b) | 0; } ${goNext}`;
      case "imul": return `{ const b = stack[--sp]; stack[sp - 1] = Math.imul(stack[sp - 1], b); } ${goNext}`;
      case "ineg": return `stack[sp - 1] = (-stack[sp - 1]) | 0; ${goNext}`;
      case "ixor": return `{ const b = stack[--sp]; stack[sp - 1] ^= b; } ${goNext}`;
      case "iand": return `{ const b = stack[--sp]; stack[sp - 1] &= b; } ${goNext}`;
      case "ior": return `{ const b = stack[--sp]; stack[sp - 1] |= b; } ${goNext}`;
      case "irem": return `{ const b = stack[--sp]; if (b === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack[sp - 1] = (stack[sp - 1] % b) | 0; } ${goNext}`;
      case "ishl": return `{ const shift = stack[--sp]; stack[sp - 1] <<= shift & 31; } ${goNext}`;
      case "ishr": return `{ const shift = stack[--sp]; stack[sp - 1] >>= shift & 31; } ${goNext}`;
      case "iushr": return `{ const shift = stack[--sp]; stack[sp - 1] = (stack[sp - 1] >>> (shift & 31)) | 0; } ${goNext}`;
      case "idiv": return `{ const b = stack[--sp]; if (b === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack[sp - 1] = (stack[sp - 1] / b) | 0; } ${goNext}`;
      case "dadd": return `{ const b = stack[--sp]; stack[sp - 1] += b; } ${goNext}`;
      case "dsub": return `{ const b = stack[--sp]; stack[sp - 1] -= b; } ${goNext}`;
      case "dmul": return `{ const b = stack[--sp]; stack[sp - 1] *= b; } ${goNext}`;
      case "ddiv": return `{ const b = stack[--sp]; stack[sp - 1] /= b; } ${goNext}`;
      case "dneg": return `stack[sp - 1] = -stack[sp - 1]; ${goNext}`;
      case "fadd": return `{ const b = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] + b); } ${goNext}`;
      case "fsub": return `{ const b = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] - b); } ${goNext}`;
      case "fmul": return `{ const b = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] * b); } ${goNext}`;
      case "fdiv": return `{ const b = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] / b); } ${goNext}`;
      case "frem": return `{ const b = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] % b); } ${goNext}`;
      case "fneg": return `stack[sp - 1] = Math.fround(-stack[sp - 1]); ${goNext}`;
      case "i2d": return goNext;
      case "i2b": return `stack[sp - 1] = (stack[sp - 1] << 24) >> 24; ${goNext}`;
      case "i2l": return `stack[sp - 1] = BigInt(stack[sp - 1]); ${goNext}`;
      case "i2f": return `stack[sp - 1] = Math.fround(stack[sp - 1]); ${goNext}`;
      case "f2d": return goNext;
      case "d2f": return `stack[sp - 1] = Math.fround(stack[sp - 1]); ${goNext}`;
      case "f2i": return `stack[sp - 1] = helpers.floatToInt(stack[sp - 1]); ${goNext}`;
      case "d2i": return `stack[sp - 1] = Math.trunc(stack[sp - 1]) | 0; ${goNext}`;
      case "lxor": return `{ const b = stack[--sp]; stack[sp - 1] ^= b; } ${goNext}`;
      case "ldiv": return `{ const b = stack[--sp]; if (b === 0n) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack[sp - 1] /= b; } ${goNext}`;
      case "lcmp": return `{ const b = stack[--sp]; const a = stack[sp - 1]; stack[sp - 1] = a < b ? -1 : (a > b ? 1 : 0); } ${goNext}`;
      case "iinc": return `locals[${Number(instruction.varnum)}] = (locals[${Number(instruction.varnum)}] + ${Number(instruction.incr)}) | 0; ${goNext}`;
      case "dcmpg": return `{ const b = stack[--sp]; stack[sp - 1] = helpers.compareDouble(b, stack[sp - 1], 1); } ${goNext}`;
      case "dcmpl": return `{ const b = stack[--sp]; stack[sp - 1] = helpers.compareDouble(b, stack[sp - 1], -1); } ${goNext}`;
      case "newarray": return `stack[sp - 1] = helpers.newPrimitiveArray(stack[sp - 1], ${JSON.stringify(instruction.arg)}); ${goNext}`;
      case "anewarray": return `stack[sp - 1] = helpers.newReferenceArray(stack[sp - 1], ${JSON.stringify(instruction.arg)}); ${goNext}`;
      case "arraylength": return `stack[sp - 1] = helpers.arrayLength(stack[sp - 1], frame); ${goNext}`;
      case "checkcast":
        if (this.compileSynchronous) {
          return `{ const cast = helpers.tryCheckCastSync(stack[sp - 1], ${JSON.stringify(instruction.arg)}); if (cast === helpers.asyncInvokeSentinel()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "cold synchronous checkcast" }; } } ${goNext}`;
        }
        return `{ const value = stack[sp - 1]; await helpers.checkCast(value, ${JSON.stringify(instruction.arg)}); } ${goNext}`;
      case "aaload":
      case "iaload":
      case "daload":
      case "faload":
      case "baload":
      case "caload":
      case "saload": return `{ const index = stack[--sp]; stack[sp - 1] = helpers.arrayLoad(index, stack[sp - 1], frame); } ${goNext}`;
      case "aastore":
      case "iastore":
      case "dastore":
      case "fastore":
      case "bastore":
      case "castore":
      case "sastore": return `{ const value = stack[--sp]; const index = stack[--sp]; helpers.arrayStore(value, index, stack[--sp], frame); } ${goNext}`;
      case "getfield": {
        const fieldSiteId = this.registerFieldSite(instruction.arg);
        return `stack[sp - 1] = helpers.getFieldAt(${fieldSiteId}, stack[sp - 1]); ${goNext}`;
      }
      case "putfield": {
        const fieldSiteId = this.registerFieldSite(instruction.arg);
        return `{ const value = stack[--sp]; helpers.putFieldAt(${fieldSiteId}, stack[--sp], value); } ${goNext}`;
      }
      case "getstatic":
        if (this.compileSynchronous) {
          const fieldSiteId = this.registerFieldSite(instruction.arg);
          return `{ const value = helpers.getStaticSyncAt(${fieldSiteId}); if (value === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "class initialization at synchronous getstatic" }; } stack[sp++] = value; } ${goNext}`;
        }
        return `{ let value = helpers.getStatic(${JSON.stringify(instruction.arg)}, thread); if (value && typeof value.then === "function") value = await value; if (value === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, transient: true, reason: "class initialization at generated getstatic" }; } stack[sp++] = value; } ${goNext}`;
      case "putstatic":
        if (this.compileSynchronous) {
          const fieldSiteId = this.registerFieldSite(instruction.arg);
          return `{ const changed = helpers.putStaticSyncAt(${fieldSiteId}, stack[sp - 1]); if (changed === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "class initialization at synchronous putstatic" }; } sp -= 1; } ${goNext}`;
        }
        return `{ let changed = helpers.putStatic(${JSON.stringify(instruction.arg)}, stack[sp - 1], thread); if (changed && typeof changed.then === "function") changed = await changed; if (changed === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, transient: true, reason: "class initialization at generated putstatic" }; } sp -= 1; } ${goNext}`;
      case "new":
        if (this.compileSynchronous) {
          return `{ const value = helpers.newObjectSync(${JSON.stringify(instruction.arg)}); if (value === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "class initialization at synchronous new" }; } stack[sp++] = value; } ${goNext}`;
        }
        return `{ const value = await helpers.newObject(${JSON.stringify(instruction.arg)}, thread); if (value === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, transient: true, reason: "class initialization at generated new" }; } stack[sp++] = value; } ${goNext}`;
      case "monitorenter": return `{ const monitor = stack[sp - 1]; if (!helpers.monitorEnter(monitor, thread)) { helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, transient: true, reason: "contended generated monitorenter" }; } sp -= 1; } ${goNext}`;
      case "monitorexit": return `helpers.monitorExit(stack[--sp], thread); ${goNext}`;
      case "invokestatic":
      case "invokevirtual":
      case "invokeinterface":
      case "invokespecial":
        if (this.compileSynchronous) {
          const callSiteId = this.registerSyncCallSite(op, instruction);
          return `{ helpers.materializeCached(frame, locals, stack, sp, ${next}); const value = helpers.tryInvokeSyncAt(${callSiteId}, frame, thread); if (value === helpers.asyncInvokeSentinel()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "asynchronous callee from synchronous ${op}" }; } if (value && value.deopt) return value; sp = stack.length; if (value !== helpers.returnVoid()) stack[sp++] = value; if (thread.status !== "runnable") return { deopt: true, transient: true, reason: "thread yielded in synchronous ${op}" }; } ${goNext}`;
        }
        return `{ helpers.materializeCached(frame, locals, stack, sp, ${next}); let value = helpers.tryInvokeSync(${JSON.stringify(op)}, frame, ${JSON.stringify(instruction)}, thread); if (value === helpers.asyncInvokeSentinel()) value = await helpers.invoke(${JSON.stringify(op)}, frame, ${JSON.stringify(instruction)}, thread, ${index}); if (value && value.deopt) return value; sp = stack.length; if (value !== helpers.returnVoid()) stack[sp++] = value; if (thread.status !== "runnable") { helpers.materializeCached(frame, locals, stack, sp, ${next}); return { deopt: true, reason: "thread yielded in generated ${op}" }; } } ${goNext}`;
      case "goto": return `pc = ${target(instruction.arg)}; break;`;
      case "ifeq": return `if (stack[--sp] === 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifne": return `if (stack[--sp] !== 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "iflt": return `if (stack[--sp] < 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifge": return `if (stack[--sp] >= 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifgt": return `if (stack[--sp] > 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifle": return `if (stack[--sp] <= 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifnull": return `if (stack[--sp] === null) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifnonnull": return `if (stack[--sp] !== null) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "if_icmpeq": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a === b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmpne": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a !== b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmplt": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a < b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmpge": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a >= b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmpgt": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a > b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmple": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a <= b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_acmpeq": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a === b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_acmpne": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a !== b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "athrow": return `throw stack[--sp];`;
      case "return":
        return `helpers.materializeCached(frame, locals, stack, sp, ${next}); thread.callStack.pop(); return { returned: true, value: helpers.returnVoid() };`;
      case "areturn":
      case "ireturn":
      case "lreturn":
      case "freturn":
      case "dreturn":
        return `{ const ret = stack[--sp]; helpers.materializeCached(frame, locals, stack, sp, ${next}); thread.callStack.pop(); return { returned: true, value: ret }; }`;
      default:
        return `helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, reason: "unsupported generated opcode ${op}" };`;
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
    if (this.profileMethods) {
      this.runnerRunCount += 1;
      this.recordExecution(this.runnerMethodRunCounts, frame);
    }
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

  tryCheckCastSync(value, className) {
    if (value === null || value === undefined) return true;
    const source = runtimeClassName(value);
    const sourceKnown = typeof source === "string" && source.startsWith("[") ||
      this.jvm.classes[source] || this.jvm.jre[source];
    const targetKnown = className === "java/lang/Object" ||
      typeof className === "string" && className.startsWith("[") ||
      this.jvm.classes[className] || this.jvm.jre[className];
    if (!sourceKnown || !targetKnown) return ASYNC_INVOKE;
    if (!this.jvm.isInstanceOf(source, className)) {
      throw {
        type: "java/lang/ClassCastException",
        message: `${source} cannot be cast to ${className}`,
      };
    }
    return true;
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

  registerFieldSite(arg) {
    const [, className, [fieldName, descriptor]] = arg;
    const id = this.nextFieldSiteId++;
    this.fieldSites[id] = {
      arg,
      className,
      fieldName,
      descriptor,
      directKey: `${className}.${fieldName}`,
      instanceKeys: new Map(),
      staticTarget: null,
    };
    return id;
  }

  getFieldAt(id, objRef) {
    const site = this.fieldSites[id];
    if (!site) throw new Error(`Unknown generated field site ${id}`);
    if (objRef === null || objRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (!objRef.fields) {
      return objRef[site.directKey] ?? objRef[site.fieldName];
    }

    const runtimeType = objRef.type || objRef._className || site.className;
    if (Object.prototype.hasOwnProperty.call(objRef.fields, site.directKey)) {
      return objRef.fields[site.directKey];
    }
    const cachedKey = site.instanceKeys.get(runtimeType);
    if (cachedKey && Object.prototype.hasOwnProperty.call(objRef.fields, cachedKey)) {
      return objRef.fields[cachedKey];
    }
    const fieldKey = resolveInstanceFieldKey(
      this.jvm, objRef, site.className, site.fieldName,
    );
    if (fieldKey) site.instanceKeys.set(runtimeType, fieldKey);
    return fieldKey ? objRef.fields[fieldKey] : undefined;
  }

  putFieldAt(id, objRef, value) {
    const site = this.fieldSites[id];
    if (!site) throw new Error(`Unknown generated field site ${id}`);
    if (objRef === null || objRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (!objRef.fields) objRef.fields = {};
    const runtimeType = objRef.type || objRef._className || site.className;
    let fieldKey = Object.prototype.hasOwnProperty.call(objRef.fields, site.directKey)
      ? site.directKey
      : site.instanceKeys.get(runtimeType);
    if (!fieldKey || !Object.prototype.hasOwnProperty.call(objRef.fields, fieldKey)) {
      fieldKey = resolveInstanceFieldKey(this.jvm, objRef, site.className, site.fieldName)
        || site.directKey;
      site.instanceKeys.set(runtimeType, fieldKey);
    }
    objRef.fields[fieldKey] = value;
    objRef[site.fieldName] = value;
  }

  resolveStaticFieldSite(site, forWrite = false) {
    const key = `${site.fieldName}:${site.descriptor}`;
    let currentClassName = site.className;
    while (currentClassName) {
      const classData = this.jvm.classes[currentClassName];
      if (classData && classData.staticFields) {
        if (classData.staticFields.has(key)) {
          return { kind: "map", fields: classData.staticFields, key };
        }
        if (!forWrite && classData.staticFields.has(site.fieldName)) {
          return { kind: "map", fields: classData.staticFields, key: site.fieldName };
        }
        if (!forWrite) {
          for (const candidate of classData.staticFields.keys()) {
            if (typeof candidate === "string" &&
                candidate.split(":")[0].replace(/'/g, "") === site.fieldName) {
              return { kind: "map", fields: classData.staticFields, key: candidate };
            }
          }
        }
      }
      currentClassName = classData && classData.ast && classData.ast.classes[0]
        ? classData.ast.classes[0].superClassName
        : null;
    }

    if (!forWrite) {
      const jreFields = this.jvm.jre[site.className] &&
        this.jvm.jre[site.className].staticFields;
      if (jreFields) {
        for (const candidate of [
          key, `'${key}'`, `${key}'`, `'${key}`, site.fieldName, `'${site.fieldName}'`,
        ]) {
          if (Object.prototype.hasOwnProperty.call(jreFields, candidate)) {
            return { kind: "object", fields: jreFields, key: candidate };
          }
        }
      }
    }

    if (forWrite) {
      const classData = this.jvm.classes[site.className];
      if (classData && classData.staticFields) {
        return { kind: "map", fields: classData.staticFields, key };
      }
    }
    return null;
  }

  getStaticSyncAt(id) {
    const site = this.fieldSites[id];
    if (!site) throw new Error(`Unknown generated static field site ${id}`);
    if (this.jvm.classInitializationState.get(site.className) !== "INITIALIZED") {
      return STATIC_DEOPT;
    }
    let target = site.staticTarget;
    if (!target) {
      target = this.resolveStaticFieldSite(site);
      if (!target) {
        return this.getStaticInitialized(site.className, site.fieldName, site.descriptor);
      }
      site.staticTarget = target;
    }
    return target.kind === "map"
      ? target.fields.get(target.key)
      : target.fields[target.key];
  }

  putStaticSyncAt(id, value) {
    const site = this.fieldSites[id];
    if (!site) throw new Error(`Unknown generated static field site ${id}`);
    if (this.jvm.classInitializationState.get(site.className) !== "INITIALIZED") {
      return STATIC_DEOPT;
    }
    let target = site.staticTarget;
    if (!target || target.kind !== "map") {
      target = this.resolveStaticFieldSite(site, true);
      if (!target) {
        return this.putStaticInitialized(
          site.className, site.fieldName, site.descriptor, value,
        );
      }
      site.staticTarget = target;
    }
    target.fields.set(target.key, value);
    return true;
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

  getStaticSync(arg) {
    const [, className, [fieldName, descriptor]] = arg;
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED") return STATIC_DEOPT;
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

  putStaticSync(arg, value) {
    const [, className, [fieldName, descriptor]] = arg;
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED") return STATIC_DEOPT;
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

    return this.allocateObject(className);
  }

  newObjectSync(className) {
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED" ||
        !this.jvm.classes[className]) return STATIC_DEOPT;
    return this.allocateObject(className);
  }

  allocateObject(className) {
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

  asyncInvokeSentinel() {
    return ASYNC_INVOKE;
  }

  registerSyncCallSite(op, instruction) {
    const [, declaredClassName, [methodName, descriptor]] = instruction.arg;
    const id = this.nextSyncCallSiteId++;
    this.syncCallSites[id] = {
      op,
      declaredClassName,
      methodName,
      descriptor,
      ...parseDescriptor(descriptor),
      targets: new Map(),
    };
    return id;
  }

  tryInvokeSyncAt(id, frame, thread) {
    const site = this.syncCallSites[id];
    if (!site) return ASYNC_INVOKE;
    const fast = site.fastIntrinsic;
    if (fast) {
      if (this.jvm.classInitializationState.get(site.declaredClassName) !== "INITIALIZED" ||
          this.jvm.debugManager.isClassJitDeopted(fast.lookupClass)) {
        return ASYNC_INVOKE;
      }
      const base = frame.stack.items.length - site.params.length;
      const value = fast.intrinsic(frame.stack.items, base);
      if (value === ASYNC_INVOKE) return ASYNC_INVOKE;
      frame.stack.items.length = base;
      if (this.profileMethods) {
        this.syncIntrinsicCallCount += 1;
        this.intrinsicMethodRunCounts.set(
          fast.methodKey,
          (this.intrinsicMethodRunCounts.get(fast.methodKey) || 0) + 1,
        );
      }
      return value;
    }
    const target = site.fastStaticTarget;
    if (target) {
      if (this.jvm.classInitializationState.get(site.declaredClassName) !== "INITIALIZED") {
        return ASYNC_INVOKE;
      }
      return this.tryInvokeResolvedTarget(site, target, frame, thread);
    }
    return this.tryInvokeSyncSite(site, frame, thread);
  }

  tryInvokeSync(op, frame, instruction, thread) {
    const [, declaredClassName, [methodName, descriptor]] = instruction.arg;
    return this.tryInvokeSyncSite({
      op,
      declaredClassName,
      methodName,
      descriptor,
      ...parseDescriptor(descriptor),
      targets: new Map(),
    }, frame, thread);
  }

  tryInvokeSyncSite(site, frame, thread) {
    const { op, declaredClassName, methodName, descriptor, params, returnType } = site;
    if (op === "invokestatic" &&
        this.jvm.classInitializationState.get(declaredClassName) !== "INITIALIZED") {
      return ASYNC_INVOKE;
    }

    const receiverOffset = params.length + (op === "invokestatic" ? 0 : 1);
    const receiver = op === "invokestatic"
      ? null
      : frame.stack.items[frame.stack.items.length - receiverOffset];
    if (op !== "invokestatic" && (receiver === null || receiver === undefined)) {
      throw { type: "java/lang/NullPointerException", message: null };
    }

    let targetClassName = declaredClassName;
    if (op === "invokevirtual" || op === "invokeinterface") {
      targetClassName = receiver.type || declaredClassName;
    }
    let target = site.targets.get(targetClassName);
    if (!target) {
      let classData = this.jvm.classes[targetClassName];
      if (!classData) return ASYNC_INVOKE;
      let method = this.jvm.findMethod(classData, methodName, descriptor);
      let lookupClass = targetClassName;
      while (!method && (op === "invokevirtual" || op === "invokeinterface") &&
        classData && classData.ast.classes[0].superClassName) {
        lookupClass = classData.ast.classes[0].superClassName;
        classData = this.jvm.classes[lookupClass];
        if (!classData) return ASYNC_INVOKE;
        method = this.jvm.findMethod(classData, methodName, descriptor);
      }
      if (!method || !(this.isSupported(method) || this.isShortSupportedHelper(method))) {
        return ASYNC_INVOKE;
      }
      target = {
        method,
        lookupClass,
        intrinsic: op === "invokestatic"
          ? this.getSynchronousIntrinsic(method, descriptor)
          : null,
        inlineIntegerLeaf: op === "invokestatic"
          ? this.getInlineIntegerLeaf(method, params, returnType)
          : null,
      };
      if (!target.intrinsic && !target.inlineIntegerLeaf) {
        target.generated = this.getGeneratedFunction(method);
      }
      site.targets.set(targetClassName, target);
      if (op === "invokestatic" && target.intrinsic) {
        site.fastIntrinsic = {
          intrinsic: target.intrinsic,
          lookupClass,
          methodKey: `${lookupClass}.${method.name}${descriptor}`,
        };
      } else if (op === "invokestatic") {
        site.fastStaticTarget = target;
      }
    }

    return this.tryInvokeResolvedTarget(site, target, frame, thread);
  }

  tryInvokeResolvedTarget(site, target, frame, thread) {
    const { op, descriptor, params, returnType } = site;
    const { method, lookupClass, intrinsic, inlineIntegerLeaf, generated } = target;
    const receiver = op === "invokestatic"
      ? null
      : frame.stack.items[frame.stack.items.length - params.length - 1];
    if (this.jvm.debugManager.isClassJitDeopted(lookupClass)) return ASYNC_INVOKE;
    if (intrinsic) {
      const base = frame.stack.items.length - params.length;
      const value = intrinsic(frame.stack.items, base);
      if (value === ASYNC_INVOKE) return ASYNC_INVOKE;
      frame.stack.items.length = base;
      if (this.profileMethods) {
        this.syncIntrinsicCallCount += 1;
        const methodKey = `${lookupClass}.${method.name}${descriptor}`;
        this.intrinsicMethodRunCounts.set(
          methodKey, (this.intrinsicMethodRunCounts.get(methodKey) || 0) + 1,
        );
      }
      return value;
    }
    if (inlineIntegerLeaf) {
      const base = frame.stack.items.length - params.length;
      const value = inlineIntegerLeaf(frame.stack.items, base);
      frame.stack.items.length = base;
      if (this.profileMethods) {
        this.syncInlinedCallCount += 1;
        const methodKey = `${lookupClass}.${method.name}${descriptor}`;
        this.inlinedMethodRunCounts.set(
          methodKey, (this.inlinedMethodRunCounts.get(methodKey) || 0) + 1,
        );
      }
      return value;
    }
    if (!generated || !generated.jvmSynchronous) return ASYNC_INVOKE;

    const argumentBase = frame.stack.items.length - params.length;

    const child = target.freeFrame || new Frame(method);
    if (target.freeFrame && this.profileMethods) this.syncReusedFrameCount += 1;
    target.freeFrame = null;
    child.pc = 0;
    // Verified bytecode cannot read a non-parameter local before storing it, so
    // normal execution does not need to erase every slot in a recycled frame.
    // Keep the clear when debugger/breakpoint checks are active so a suspended
    // frame never exposes values left by its previous invocation.
    if (this.needsBytecodeChecks()) child.locals.fill(undefined);
    child.stack.items.length = 0;
    delete child.jitSkipOnce;
    delete child.jitJsDisabled;
    child.className = lookupClass;
    let localIndex = 0;
    if (op !== "invokestatic") {
      child.locals[0] = receiver;
      localIndex = 1;
    }
    for (let i = 0; i < params.length; i += 1) {
      child.locals[localIndex] = frame.stack.items[argumentBase + i];
      localIndex += params[i] === "long" || params[i] === "double" ? 2 : 1;
    }
    frame.stack.items.length = argumentBase - (op === "invokestatic" ? 0 : 1);
    thread.callStack.push(child);
    const result = this.runGeneratedFrame(generated, child, thread, false);
    if (result && typeof result.then === "function") {
      throw new Error("Synchronous generated method returned a Promise");
    }
    if (result.deopt) return result;
    target.freeFrame = child;
    if (returnType === "void" || result.value === RETURN_VOID) return RETURN_VOID;
    return result.value;
  }

  getSynchronousIntrinsic(method, descriptor) {
    const codeItems = this.getCodeItems(method);
    const ops = codeItems
      .map((item) => getOp(item.instruction))
      .filter(Boolean);

    if (descriptor === "([II[III)V") {
      const prefix = [
        "aload_0", "aload_2", "if_acmpne", "iload_1", "iload_3",
        "if_icmpne", "return", "iload_3", "iload_1", "if_icmple",
      ];
      if (!prefix.every((op, index) => ops[index] === op)) return null;
      const loads = ops.filter((op) => op === "iaload").length;
      const stores = ops.filter((op) => op === "iastore").length;
      if (loads < 16 || stores !== loads || ops.some((op) => op.startsWith("invoke"))) {
        return null;
      }
      return (stack, base) => {
        const src = stack[base];
        const srcPos = stack[base + 1] | 0;
        const dest = stack[base + 2];
        const destPos = stack[base + 3] | 0;
        const length = stack[base + 4] | 0;
        if (src === null || src === undefined || dest === null || dest === undefined) {
          throw { type: "java/lang/NullPointerException", message: null };
        }
        // The recognized Java implementation returns before checking length
        // when source, destination, and offsets are identical. Preserve that
        // observable order and avoid copying an already-identical range.
        if (src === dest && srcPos === destPos) {
          if (this.profileMethods) this.intrinsicArrayCopyNoopCount += 1;
          return RETURN_VOID;
        }
        if (srcPos < 0 || destPos < 0 || length < 0 ||
            srcPos + length > src.length || destPos + length > dest.length) {
          throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
        }
        if (src === dest) {
          dest.copyWithin(destPos, srcPos, srcPos + length);
          if (this.profileMethods) this.intrinsicArrayCopyWithinCount += 1;
        } else {
          for (let i = 0; i < length; i += 1) dest[destPos + i] = src[srcPos + i];
        }
        return RETURN_VOID;
      };
    }

    if (descriptor === "(IIIIIII[III)V") {
      const prefix = [
        "getstatic", "istore", "iload", "bipush", "if_icmpeq",
        "bipush", "invokestatic", "goto", "athrow", "iinc",
      ];
      if (!prefix.every((op, index) => ops[index] === op)) return null;
      const integerAndCalls = codeItems.filter((item) => {
        const instruction = item && item.instruction;
        return getOp(instruction) === "invokestatic" && instruction &&
          Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]) &&
          instruction.arg[2][1] === "(II)I";
      });
      const constants = new Set(codeItems.map((item) => {
        const instruction = item && item.instruction;
        const op = getOp(instruction);
        return instruction && typeof instruction === "object" &&
          (op === "bipush" || op === "sipush" || op === "ldc" || op === "ldc_w")
          ? Number(instruction.arg) : NaN;
      }));
      const expectedConstants = [
        9, 8355711, -852264639, 65280, -1295343735,
        1494704929, 16711680, 200866833, 255,
      ];
      if (integerAndCalls.length !== 3 ||
          !ops.includes("iaload") || !ops.includes("iastore") ||
          !expectedConstants.every((value) => constants.has(value))) return null;
      const flagField = codeItems.find((item) => getOp(item && item.instruction) === "getstatic")
        ?.instruction?.arg;
      if (!flagField) return null;
      return (stack, base) => {
        if ((stack[base + 6] | 0) !== 9) return ASYNC_INVOKE;
        const flag = this.getStaticSync(flagField);
        if (flag === STATIC_DEOPT || flag) return ASYNC_INVOKE;
        const dest = stack[base + 7];
        let index = stack[base + 1] | 0;
        const count = stack[base + 5] | 0;
        if (dest === null || dest === undefined) {
          throw { type: "java/lang/NullPointerException", message: null };
        }
        if (count <= 0) return RETURN_VOID;
        if (index < 0 || index + count > dest.length) {
          throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
        }
        let green = stack[base] | 0;
        let red = stack[base + 4] | 0;
        let blue = stack[base + 8] | 0;
        const greenStep = stack[base + 2] | 0;
        const redStep = stack[base + 3] | 0;
        const blueStep = stack[base + 9] | 0;
        for (let i = 0; i < count; i += 1) {
          dest[index] = (((dest[index] >> 1) & 8355711) +
            ((green >> 9) & 65280) + ((red >> 1) & 16711680) +
            ((blue >> 17) & 255)) | 0;
          index += 1;
          green = (green + greenStep) | 0;
          red = (red + redStep) | 0;
          blue = (blue + blueStep) | 0;
        }
        return RETURN_VOID;
      };
    }

    if (descriptor === "(IB[III)V") {
      const prefix = [
        "getstatic", "istore", "iload_1", "bipush", "if_icmpeq",
        "bipush", "bipush", "aconst_null", "checkcast", "bipush",
        "bipush", "invokestatic", "goto", "athrow", "iinc",
      ];
      if (!prefix.every((op, index) => ops[index] === op)) return null;
      const integerAndCalls = codeItems.filter((item) => {
        const instruction = item && item.instruction;
        return getOp(instruction) === "invokestatic" && instruction &&
          Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]) &&
          instruction.arg[2][1] === "(II)I";
      });
      const constants = new Set(codeItems.map((item) => {
        const instruction = item && item.instruction;
        const op = getOp(instruction);
        return instruction && typeof instruction === "object" &&
          (op === "bipush" || op === "sipush" || op === "ldc" || op === "ldc_w")
          ? Number(instruction.arg) : NaN;
      }));
      if (integerAndCalls.length !== 1 ||
          !ops.includes("iaload") || !ops.includes("iastore") ||
          ![57, 16711422, -59233087].every((value) => constants.has(value))) return null;
      const flagField = codeItems.find((item) => getOp(item && item.instruction) === "getstatic")
        ?.instruction?.arg;
      if (!flagField) return null;
      return (stack, base) => {
        if ((stack[base + 1] | 0) !== 57) return ASYNC_INVOKE;
        const flag = this.getStaticSync(flagField);
        if (flag === STATIC_DEOPT || flag) return ASYNC_INVOKE;
        let index = stack[base] | 0;
        const dest = stack[base + 2];
        const color = stack[base + 3] | 0;
        const count = stack[base + 4] | 0;
        if (dest === null || dest === undefined) {
          throw { type: "java/lang/NullPointerException", message: null };
        }
        if (count <= 0) return RETURN_VOID;
        if (index < 0 || index + count > dest.length) {
          throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
        }
        for (let i = 0; i < count; i += 1) {
          dest[index] = (color + ((dest[index] & 16711422) >> 1)) | 0;
          index += 1;
        }
        return RETURN_VOID;
      };
    }

    return null;
  }

  packedColorScanlineDirect(green, index, greenStep, redStep, red, count,
    tag, dest, blue, blueStep, guarded, owner) {
    if ((tag | 0) !== 9 || guarded ||
        this.jvm.classInitializationState.get(owner) !== "INITIALIZED") return ASYNC_INVOKE;
    index |= 0;
    count |= 0;
    if (dest === null || dest === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (count <= 0) return true;
    if (index < 0 || index + count > dest.length) {
      throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
    }
    green |= 0;
    red |= 0;
    blue |= 0;
    greenStep |= 0;
    redStep |= 0;
    blueStep |= 0;
    for (let offset = 0; offset < count; offset += 1) {
      dest[index] = (((dest[index] >> 1) & 8355711) +
        ((green >> 9) & 65280) + ((red >> 1) & 16711680) +
        ((blue >> 17) & 255)) | 0;
      index += 1;
      green = (green + greenStep) | 0;
      red = (red + redStep) | 0;
      blue = (blue + blueStep) | 0;
    }
    return true;
  }

  getInlineIntegerLeaf(method, params, returnType) {
    if (this.inlineIntegerLeafCache.has(method)) {
      return this.inlineIntegerLeafCache.get(method);
    }
    let inline = null;
    if (returnType === "int" && params.length > 0 && params.every((type) => type === "int")) {
      const instructions = this.getCodeItems(method)
        .map((item) => item.instruction)
        .filter(Boolean);
      const expressions = [];
      const pop = () => expressions.pop();
      const binary = (format) => {
        const right = pop();
        const left = pop();
        if (left === undefined || right === undefined) return false;
        expressions.push(format(left, right));
        return true;
      };
      let expression = null;
      for (const instruction of instructions) {
        const op = getOp(instruction);
        const load = op === "iload" ? Number(instruction.arg)
          : /^iload_[0-3]$/.test(op) ? Number(op.slice(-1)) : null;
        if (load !== null) {
          if (load < 0 || load >= params.length) break;
          expressions.push(`stack[base + ${load}]`);
          continue;
        }
        if (/^iconst_[0-5]$/.test(op)) {
          expressions.push(op.slice(-1));
          continue;
        }
        if (op === "iconst_m1") {
          expressions.push("-1");
          continue;
        }
        if (op === "bipush" || op === "sipush") {
          expressions.push(String(Number(instruction.arg) | 0));
          continue;
        }
        let valid = true;
        switch (op) {
          case "iadd": valid = binary((a, b) => `((${a} + ${b}) | 0)`); break;
          case "isub": valid = binary((a, b) => `((${a} - ${b}) | 0)`); break;
          case "imul": valid = binary((a, b) => `Math.imul(${a}, ${b})`); break;
          case "iand": valid = binary((a, b) => `(${a} & ${b})`); break;
          case "ior": valid = binary((a, b) => `(${a} | ${b})`); break;
          case "ixor": valid = binary((a, b) => `(${a} ^ ${b})`); break;
          case "ishl": valid = binary((a, b) => `(${a} << (${b} & 31))`); break;
          case "ishr": valid = binary((a, b) => `(${a} >> (${b} & 31))`); break;
          case "iushr": valid = binary((a, b) => `((${a} >>> (${b} & 31)) | 0)`); break;
          case "ineg": {
            const value = pop();
            valid = value !== undefined;
            if (valid) expressions.push(`((-${value}) | 0)`);
            break;
          }
          case "i2b": {
            const value = pop();
            valid = value !== undefined;
            if (valid) expressions.push(`((${value} << 24) >> 24)`);
            break;
          }
          case "ireturn":
            if (expressions.length === 1) expression = expressions[0];
            valid = false;
            break;
          default: valid = false; break;
        }
        if (!valid) break;
      }
      if (expression !== null) {
        inline = new Function("stack", "base", `return ${expression};`);
      }
    }
    this.inlineIntegerLeafCache.set(method, inline);
    return inline;
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

function expandWideInstruction(instruction) {
  const parts = String(instruction && instruction.arg ? instruction.arg : "")
    .trim().split(/\s+/).filter(Boolean);
  const op = parts[0];
  if (!op) return null;
  if (op === "iinc") {
    return { op, varnum: parts[1], incr: parts[2] };
  }
  return { op, arg: parts[1] };
}

function stackEffect(instruction) {
  const op = getOp(instruction);
  if (!op || op === "nop" || op === "goto" || op === "iinc" ||
      op === "ineg" || op === "i2b" || op === "i2d" || op === "i2f" ||
      op === "i2l" || op === "checkcast" || op === "getfield" ||
      op === "arraylength") return 0;
  if (/^[aifd]load(?:_[0-3])?$/.test(op) || op === "aconst_null" ||
      /^iconst_(?:m1|[0-5])$/.test(op) || /^fconst_[0-2]$/.test(op) ||
      /^dconst_[01]$/.test(op) || op === "bipush" || op === "sipush" ||
      op === "ldc" || op === "ldc_w" || op === "ldc2_w" ||
      op === "getstatic" || op === "new") return 1;
  if (/^[aifd]store(?:_[0-3])?$/.test(op) || op === "pop" ||
      op === "putstatic" || op === "athrow" || /^[aifdl]return$/.test(op)) return -1;
  if (op === "dup") return 1;
  if (op === "dup2") return 2;
  if (op === "putfield") return -2;
  if (op.endsWith("aload") || [
    "iadd", "isub", "imul", "idiv", "irem", "ishl", "ishr", "iushr",
    "iand", "ior", "ixor", "dadd", "dsub", "dmul", "ddiv", "fadd",
    "fsub", "fmul", "fdiv", "frem", "lxor", "ldiv", "lcmp", "dcmpg", "dcmpl",
  ].includes(op)) return -1;
  if (op.endsWith("astore")) return -3;
  if (op.startsWith("if_icmp") || op.startsWith("if_acmp")) return -2;
  if (["ifeq", "ifne", "iflt", "ifge", "ifgt", "ifle", "ifnull", "ifnonnull"].includes(op)) {
    return -1;
  }
  if (op && op.startsWith("invoke") && instruction && typeof instruction === "object" &&
      Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2])) {
    const parsed = parseDescriptor(instruction.arg[2][1]);
    return -parsed.params.length - (op === "invokestatic" ? 0 : 1) +
      (parsed.returnType === "void" ? 0 : 1);
  }
  if (op === "return") return 0;
  return null;
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
