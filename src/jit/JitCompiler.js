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
    if (this.jvm.debugManager.debugMode) {
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
      const result = await this.runFrame(frame, thread);
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

  shouldDeopt(frame, pc) {
    if (this.safePoints !== "bytecode") {
      return false;
    }
    const debug = this.jvm.debugManager;
    if (debug.debugMode) {
      return true;
    }
    if (debug.breakpoints.size === 0) {
      return false;
    }
    const item = frame.instructions[pc];
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

  async runFrame(frame, thread) {
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

module.exports = JitCompiler;
