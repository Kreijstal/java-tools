const Frame = require("../core/frame");
const { parseDescriptor } = require("../parsing/typeParser");

const RETURN_VOID = Symbol("jit.return.void");

class JitCompiler {
  constructor(jvm, options = {}) {
    this.jvm = jvm;
    this.enabled = options.enabled !== false;
    this.safePoints = options.safePoints || "bytecode";
    this.supportCache = new WeakMap();
    this.labelCache = new WeakMap();
    this.runningFrames = new WeakSet();
    this.deoptedMethods = new WeakSet();
    this.invocationCounts = new WeakMap();
    this.warmupThreshold = options.warmupThreshold ?? 2;
    this.codegenEnabled = options.codegen !== false;
    this.codegenCache = new WeakMap();
    this.codegenSupportCache = new WeakMap();
    this.codegenUnavailable = false;
    this.codegenCompileErrors = new WeakMap();
    this.generatedRunCount = 0;
    this.runnerRunCount = 0;
  }

  canRun(frame) {
    if (!this.enabled || !frame || !frame.method || !frame.instructions) {
      return false;
    }
    if (this.runningFrames.has(frame)) {
      return false;
    }
    if (this.deoptedMethods.has(frame.method)) {
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
    if (count < this.warmupThreshold) {
      return false;
    }
    return this.isSupported(frame.method);
  }

  async tryRunFrame(frame, thread) {
    if (!this.canRun(frame)) {
      return { handled: false };
    }

    this.runningFrames.add(frame);
    try {
      const generated = this.getGeneratedFunction(frame.method);
      const result = generated
        ? await this.runGeneratedFrame(generated, frame, thread)
        : await this.runFrame(frame, thread);
      if (result && result.deopt) {
        this.lastDeoptReason = result.reason;
        this.deoptedMethods.add(frame.method);
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
    return generated(frame, thread, this);
  }

  isSupported(method) {
    if (this.supportCache.has(method)) {
      return this.supportCache.get(method);
    }

    const code = method.attributes.find((attr) => attr.type === "code");
    if (!code) {
      this.supportCache.set(method, false);
      return false;
    }

    const codeItems = code.code.codeItems;
    const doubleOps = new Set([
      "d2i", "dadd", "daload", "dastore", "dcmpg", "dcmpl",
      "dconst_0", "dconst_1", "ddiv", "dload", "dload_0", "dload_1",
      "dload_2", "dload_3", "dmul", "dneg", "dreturn", "dstore",
      "dstore_0", "dstore_1", "dstore_2", "dstore_3", "dsub",
    ]);
    const hasNumericHotPath = codeItems.some((item) => {
      const op = typeof item.instruction === "string" ? item.instruction : item.instruction && item.instruction.op;
      return op && (doubleOps.has(op) || op === "i2d" || op === "newarray" && item.instruction.arg === "double");
    });
    if (!hasNumericHotPath && !this.isSimpleConstructor(method, codeItems)) {
      this.supportCache.set(method, false);
      return false;
    }

    const allowed = new Set([
      "aconst_null", "aload", "aload_0", "aload_1", "aload_2", "aload_3",
      "areturn", "astore", "astore_0", "astore_1", "astore_2", "astore_3",
      "aaload", "aastore", "anewarray", "arraylength", "bastore", "baload",
      "bipush", "d2i", "dadd", "daload", "dastore", "dcmpg", "dcmpl",
      "dconst_0", "dconst_1", "ddiv", "dload", "dload_0", "dload_1",
      "dload_2", "dload_3", "dmul", "dneg", "dreturn", "dstore",
      "dstore_0", "dstore_1", "dstore_2", "dstore_3", "dsub", "dup",
      "getfield", "getstatic", "goto", "i2d", "iadd", "iaload", "iastore", "idiv",
      "iconst_0", "iconst_1", "iconst_2", "iconst_3", "iconst_4", "iconst_5",
      "if_acmpeq", "if_acmpne", "ifeq", "ifge", "ifgt", "ificmpge",
      "if_icmpeq", "if_icmpge", "if_icmpgt", "if_icmplt", "if_icmpne",
      "ifle", "iflt", "ifne", "ifnonnull", "ifnull", "iload", "iload_0",
      "iload_1", "iload_2", "iload_3", "imul", "inc", "iinc",
      "invokespecial", "invokestatic", "invokevirtual", "istore", "istore_0",
      "istore_1", "istore_2", "istore_3", "isub", "ldc", "ldc2_w",
      "multianewarray", "new", "newarray", "pop", "putfield", "return",
      "sipush"
    ]);

    const supported = codeItems.every((item) => {
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
    const supportedOps = new Set([
      "aconst_null", "aload", "aload_0", "aload_1", "aload_2", "aload_3",
      "areturn", "astore", "astore_0", "astore_1", "astore_2", "astore_3",
      "aaload", "aastore", "arraylength", "bastore", "baload",
      "bipush", "d2i", "dadd", "daload", "dastore", "dcmpg", "dcmpl",
      "dconst_0", "dconst_1", "ddiv", "dload", "dload_0", "dload_1",
      "dload_2", "dload_3", "dmul", "dneg", "dreturn", "dstore",
      "dstore_0", "dstore_1", "dstore_2", "dstore_3", "dsub", "dup",
      "goto", "i2d", "iadd", "iaload", "iastore", "idiv",
      "iconst_0", "iconst_1", "iconst_2", "iconst_3", "iconst_4", "iconst_5",
      "ifeq", "ifge", "ifgt", "if_icmpeq", "if_icmpge", "if_icmpgt",
      "if_icmplt", "if_icmpne", "ifle", "iflt", "ifne", "ifnonnull",
      "ifnull", "iload", "iload_0", "iload_1", "iload_2", "iload_3",
      "imul", "iinc", "istore", "istore_0", "istore_1", "istore_2",
      "istore_3", "isub", "ldc", "ldc2_w", "newarray", "pop", "return",
      "sipush",
    ]);

    const hasNumericHotPath = codeItems.some((item) => {
      const op = getOp(item && item.instruction);
      return op && (
        op.startsWith("d")
        || op === "i2d"
        || op === "idiv"
        || op === "imul"
        || (op === "newarray" && item.instruction.arg === "double")
      );
    });
    const supported = hasNumericHotPath && codeItems.every((item) => {
      const op = getOp(item && item.instruction);
      return !op || supportedOps.has(op);
    });

    this.codegenSupportCache.set(method, supported);
    return supported;
  }

  isSimpleConstructor(method, codeItems) {
    if (method.name !== "<init>") {
      return false;
    }

    const allowed = new Set([
      "aload", "aload_0", "aload_1", "aload_2", "aload_3",
      "bipush", "dconst_0", "dconst_1", "iconst_0", "iconst_1",
      "iconst_2", "iconst_3", "iconst_4", "iconst_5", "invokespecial",
      "ldc", "ldc2_w", "putfield", "return", "sipush",
    ]);

    return codeItems.every((item) => {
      if (!item.instruction) return true;
      const instruction = item.instruction;
      const op = typeof instruction === "string" ? instruction : instruction.op;
      if (!allowed.has(op)) return false;
      if (op !== "invokespecial") return true;
      const [, className, [methodName, descriptor]] = instruction.arg;
      return methodName === "<init>" && descriptor === "()V" && className === "java/lang/Object";
    });
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
      `while (pc < ${codeItems.length}) {`,
      "if (helpers.shouldDeopt(frame, pc)) { helpers.materialize(frame, locals, stack, pc); return { deopt: true }; }",
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
        body.push(`helpers.materialize(frame, locals, stack, ${index});`);
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
      case "iconst_0": return `stack.push(0); ${goNext}`;
      case "iconst_1": return `stack.push(1); ${goNext}`;
      case "iconst_2": return `stack.push(2); ${goNext}`;
      case "iconst_3": return `stack.push(3); ${goNext}`;
      case "iconst_4": return `stack.push(4); ${goNext}`;
      case "iconst_5": return `stack.push(5); ${goNext}`;
      case "dconst_0": return `stack.push(0.0); ${goNext}`;
      case "dconst_1": return `stack.push(1.0); ${goNext}`;
      case "bipush":
      case "sipush": return `stack.push(${Number(instruction.arg)}); ${goNext}`;
      case "ldc":
      case "ldc2_w": return `stack.push(helpers.constantValue(${JSON.stringify(instruction.arg)})); ${goNext}`;
      case "dup": return `stack.push(stack[stack.length - 1]); ${goNext}`;
      case "pop": return `stack.pop(); ${goNext}`;
      case "iadd": return `stack.push(stack.pop() + stack.pop()); ${goNext}`;
      case "isub": return `{ const b = stack.pop(); const a = stack.pop(); stack.push(a - b); } ${goNext}`;
      case "imul": return `stack.push(stack.pop() * stack.pop()); ${goNext}`;
      case "idiv": return `{ const b = stack.pop(); const a = stack.pop(); if (b === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack.push(Math.floor(a / b)); } ${goNext}`;
      case "dadd": return `stack.push(stack.pop() + stack.pop()); ${goNext}`;
      case "dsub": return `{ const b = stack.pop(); const a = stack.pop(); stack.push(a - b); } ${goNext}`;
      case "dmul": return `stack.push(stack.pop() * stack.pop()); ${goNext}`;
      case "ddiv": return `{ const b = stack.pop(); const a = stack.pop(); stack.push(a / b); } ${goNext}`;
      case "dneg": return `stack.push(-stack.pop()); ${goNext}`;
      case "i2d": return goNext;
      case "d2i": return `stack.push(Math.trunc(stack.pop()) | 0); ${goNext}`;
      case "iinc": return `locals[${Number(instruction.varnum)}] += ${Number(instruction.incr)}; ${goNext}`;
      case "dcmpg": return `stack.push(helpers.compareDouble(stack.pop(), stack.pop(), 1)); ${goNext}`;
      case "dcmpl": return `stack.push(helpers.compareDouble(stack.pop(), stack.pop(), -1)); ${goNext}`;
      case "newarray": return `stack.push(helpers.newPrimitiveArray(stack.pop(), ${JSON.stringify(instruction.arg)})); ${goNext}`;
      case "arraylength": return `stack.push(helpers.arrayLength(stack.pop(), frame)); ${goNext}`;
      case "aaload":
      case "iaload":
      case "daload":
      case "baload": return `stack.push(helpers.arrayLoad(stack.pop(), stack.pop(), frame)); ${goNext}`;
      case "aastore":
      case "iastore":
      case "dastore":
      case "bastore": return `helpers.arrayStore(stack.pop(), stack.pop(), stack.pop(), frame); ${goNext}`;
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
      case "return":
        return `helpers.materialize(frame, locals, stack, ${next}); thread.callStack.pop(); return { returned: true, value: helpers.returnVoid() };`;
      case "areturn":
      case "ireturn":
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

  async runFrame(frame, thread) {
    this.runnerRunCount += 1;
    const locals = frame.locals;
    const stack = frame.stack.items;
    const instructions = frame.instructions;
    let pc = frame.pc;

    while (pc < instructions.length) {
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
        case "iconst_0": stack.push(0); break;
        case "iconst_1": stack.push(1); break;
        case "iconst_2": stack.push(2); break;
        case "iconst_3": stack.push(3); break;
        case "iconst_4": stack.push(4); break;
        case "iconst_5": stack.push(5); break;
        case "dconst_0": stack.push(0.0); break;
        case "dconst_1": stack.push(1.0); break;
        case "bipush":
        case "sipush": stack.push(Number(instruction.arg)); break;
        case "ldc": stack.push(this.constantValue(instruction.arg)); break;
        case "ldc2_w": stack.push(this.constantValue(instruction.arg)); break;
        case "dup": stack.push(stack[stack.length - 1]); break;
        case "pop": stack.pop(); break;
        case "iadd": stack.push(stack.pop() + stack.pop()); break;
        case "isub": { const b = stack.pop(); const a = stack.pop(); stack.push(a - b); break; }
        case "imul": stack.push(stack.pop() * stack.pop()); break;
        case "idiv": { const b = stack.pop(); const a = stack.pop(); if (b === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack.push(Math.floor(a / b)); break; }
        case "dadd": stack.push(stack.pop() + stack.pop()); break;
        case "dsub": { const b = stack.pop(); const a = stack.pop(); stack.push(a - b); break; }
        case "dmul": stack.push(stack.pop() * stack.pop()); break;
        case "ddiv": { const b = stack.pop(); const a = stack.pop(); stack.push(a / b); break; }
        case "dneg": stack.push(-stack.pop()); break;
        case "i2d": break;
        case "d2i": stack.push(Math.trunc(stack.pop()) | 0); break;
        case "iinc": locals[Number(instruction.varnum)] += Number(instruction.incr); break;
        case "dcmpg": stack.push(compareDouble(stack.pop(), stack.pop(), 1)); break;
        case "dcmpl": stack.push(compareDouble(stack.pop(), stack.pop(), -1)); break;
        case "newarray": stack.push(this.newPrimitiveArray(stack.pop(), instruction.arg)); break;
        case "anewarray": stack.push(this.newReferenceArray(stack.pop(), instruction.arg)); break;
        case "multianewarray": stack.push(this.newMultiArray(instruction.arg, stack)); break;
        case "arraylength": stack.push(this.arrayLength(stack.pop(), frame)); break;
        case "aaload":
        case "iaload":
        case "daload":
        case "baload": stack.push(this.arrayLoad(stack.pop(), stack.pop(), frame)); break;
        case "aastore":
        case "iastore":
        case "dastore":
        case "bastore": this.arrayStore(stack.pop(), stack.pop(), stack.pop(), frame); break;
        case "getfield": stack.push(this.getField(stack.pop(), instruction.arg)); break;
        case "putfield": { const value = stack.pop(); const obj = stack.pop(); this.putField(obj, instruction.arg, value); break; }
        case "getstatic": stack.push(await this.getStatic(instruction.arg, thread)); break;
        case "new": stack.push(await this.newObject(instruction.arg, thread)); break;
        case "invokestatic":
        case "invokevirtual":
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
        case "if_acmpeq": { const b = stack.pop(); const a = stack.pop(); if (a === b) pc = this.target(frame, instruction.arg); break; }
        case "if_acmpne": { const b = stack.pop(); const a = stack.pop(); if (a !== b) pc = this.target(frame, instruction.arg); break; }
        case "return":
          this.materialize(frame, locals, stack, pc);
          thread.callStack.pop();
          return { returned: true, value: RETURN_VOID };
        case "areturn":
        case "ireturn":
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

  compareDouble(value2, value1, nanValue) {
    return compareDouble(value2, value1, nanValue);
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
    if (objRef === null) throw new Error("NullPointerException");
    return objRef.fields ? objRef.fields[`${className}.${fieldName}`] : objRef[`${className}.${fieldName}`] ?? objRef[fieldName];
  }

  putField(objRef, arg, value) {
    const [, className, [fieldName]] = arg;
    if (objRef === null) throw new Error("NullPointerException");
    if (!objRef.fields) objRef.fields = {};
    objRef.fields[`${className}.${fieldName}`] = value;
    objRef[fieldName] = value;
  }

  async getStatic(arg, thread) {
    const [, className, [fieldName, descriptor]] = arg;
    const wasFramePushed = await this.jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) return undefined;
    const key = `${fieldName}:${descriptor}`;
    const classData = this.jvm.classes[className];
    if (classData && classData.staticFields && classData.staticFields.has(key)) {
      return classData.staticFields.get(key);
    }
    const jreClass = this.jvm.jre[className];
    if (jreClass && jreClass.staticFields && Object.prototype.hasOwnProperty.call(jreClass.staticFields, key)) {
      return jreClass.staticFields[key];
    }
    throw new Error(`Unresolved static field: ${className}.${fieldName}`);
  }

  async newObject(className, thread) {
    const wasFramePushed = await this.jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) {
      throw new Error(`JIT cannot allocate ${className} during class initialization`);
    }
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
      if (op === "invokevirtual") {
        targetClassName = receiver.type || declaredClassName;
      }
    }

    const jreMethod = await this.findJreMethod(targetClassName, declaredClassName, methodName, descriptor);
    if (jreMethod) {
      let result = jreMethod(this.jvm, receiver, args, thread);
      if (result && typeof result.then === "function") result = await result;
      if (returnType === "V" || result === undefined) return RETURN_VOID;
      return typeof result === "boolean" ? (result ? 1 : 0) : result;
    }

    let classData = this.jvm.classes[targetClassName] || await this.jvm.loadClassByName(targetClassName);
    let method = this.jvm.findMethod(classData, methodName, descriptor);
    let lookupClass = targetClassName;
    while (!method && op === "invokevirtual" && classData && classData.ast.classes[0].superClassName) {
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

    if (!this.isSupported(method)) {
      frame.stack.items = stackSnapshot;
      frame.pc = invokePc;
      return { deopt: true, reason: `unsupported callee ${targetClassName}.${methodName}${descriptor}` };
    }

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
    const result = await this.runFrame(child, thread);
    if (result.deopt) return result;
    if (returnType === "V" || result.value === RETURN_VOID) return RETURN_VOID;
    return result.value;
  }

  async findJreMethod(targetClassName, declaredClassName, methodName, descriptor) {
    const direct = this.jvm._jreFindMethod(targetClassName, methodName, descriptor)
      || this.jvm._jreFindMethod(declaredClassName, methodName, descriptor);
    if (direct) return direct;

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

function compareDouble(value2, value1, nanValue) {
  if (Number.isNaN(value1) || Number.isNaN(value2)) return nanValue;
  if (value1 < value2) return -1;
  if (value1 > value2) return 1;
  return 0;
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
