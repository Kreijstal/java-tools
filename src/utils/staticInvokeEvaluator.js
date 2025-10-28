const { analyzePurity, _internals: purityInternals } = require('../purityAnalyzer');
const { normalizeInstruction, parseLocalOperation } = require('./instructionUtils');

const { buildMethodSignature } = purityInternals;

const DEFAULT_LIMITS = {
  maxIterations: 20000,
  maxInstructions: 200000,
  maxTrackedValues: 100000,
};

const INT_TYPES = new Set(['int']);
const LONG_TYPES = new Set(['long']);

const LONG_MASK = (1n << 64n) - 1n;
const LONG_SIGN = 1n << 63n;

function normalizeLimit(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (value === Infinity) {
    return Infinity;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

function normalizeLimits(limits) {
  return {
    maxIterations: normalizeLimit(limits?.maxIterations, DEFAULT_LIMITS.maxIterations),
    maxInstructions: normalizeLimit(limits?.maxInstructions, DEFAULT_LIMITS.maxInstructions),
    maxTrackedValues: normalizeLimit(limits?.maxTrackedValues, DEFAULT_LIMITS.maxTrackedValues),
  };
}

function createEvaluationState(limits) {
  return {
    limits: normalizeLimits(limits || {}),
    iterations: 0,
    instructions: 0,
    values: 0,
    bailReason: null,
  };
}

function incrementIterations(state) {
  if (!state) {
    return false;
  }
  state.iterations += 1;
  const limit = state.limits.maxIterations;
  if (typeof limit === 'number' && Number.isFinite(limit) && state.iterations > limit) {
    state.bailReason = 'iterationLimit';
    return true;
  }
  return false;
}

function incrementInstructions(state, amount = 1) {
  if (!state) {
    return false;
  }
  state.instructions += amount;
  const limit = state.limits.maxInstructions;
  if (typeof limit === 'number' && Number.isFinite(limit) && state.instructions > limit) {
    state.bailReason = 'instructionLimit';
    return true;
  }
  return false;
}

function incrementValues(state, amount = 1) {
  if (!state) {
    return false;
  }
  state.values += amount;
  const limit = state.limits.maxTrackedValues;
  if (typeof limit === 'number' && Number.isFinite(limit) && state.values > limit) {
    state.bailReason = 'memoryLimit';
    return true;
  }
  return false;
}

function shouldAbort(state) {
  return Boolean(state?.bailReason);
}

function normalizeLabel(label) {
  if (typeof label !== 'string') {
    return null;
  }
  const trimmed = label.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.endsWith(':') ? trimmed.slice(0, -1) : trimmed;
}

function toInt32(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return (number << 0) | 0;
}

function toBigInt(value) {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    try {
      return BigInt(value);
    } catch (error) {
      return null;
    }
  }
  return null;
}

function normalizeLong(value) {
  const bigint = toBigInt(value);
  if (bigint === null) {
    return null;
  }
  let result = bigint & LONG_MASK;
  if (result & LONG_SIGN) {
    result -= LONG_MASK + 1n;
  }
  return result;
}

function parseType(descriptor, index) {
  if (!descriptor || index >= descriptor.length) {
    return null;
  }

  let cursor = index;
  let arrayDepth = 0;

  while (descriptor[cursor] === '[') {
    arrayDepth += 1;
    cursor += 1;
    if (cursor >= descriptor.length) {
      return null;
    }
  }

  const kindChar = descriptor[cursor];
  cursor += 1;

  if (kindChar === 'L') {
    while (cursor < descriptor.length && descriptor[cursor] !== ';') {
      cursor += 1;
    }
    if (cursor >= descriptor.length) {
      return null;
    }
    cursor += 1;
    return { kind: 'reference', width: 1, nextIndex: cursor };
  }

  if (arrayDepth > 0) {
    return { kind: 'reference', width: 1, nextIndex: cursor };
  }

  switch (kindChar) {
    case 'B':
    case 'C':
    case 'S':
    case 'Z':
    case 'I':
      return { kind: 'int', width: 1, nextIndex: cursor };
    case 'J':
      return { kind: 'long', width: 2, nextIndex: cursor };
    case 'F':
      return { kind: 'float', width: 1, nextIndex: cursor };
    case 'D':
      return { kind: 'double', width: 2, nextIndex: cursor };
    case 'V':
      return { kind: 'void', width: 0, nextIndex: cursor };
    default:
      return null;
  }
}

function parseMethodLayout(descriptor) {
  if (!descriptor || descriptor[0] !== '(') {
    return null;
  }

  const args = [];
  let cursor = 1;

  while (cursor < descriptor.length && descriptor[cursor] !== ')') {
    const type = parseType(descriptor, cursor);
    if (!type) {
      return null;
    }
    if (type.kind === 'void') {
      return null;
    }
    args.push({ kind: type.kind, width: type.width });
    cursor = type.nextIndex;
  }

  if (cursor >= descriptor.length || descriptor[cursor] !== ')') {
    return null;
  }

  const returnType = parseType(descriptor, cursor + 1);
  if (!returnType) {
    return null;
  }

  return { args, returnType: { kind: returnType.kind, width: returnType.width } };
}

function prepareInstructions(codeItems) {
  if (!Array.isArray(codeItems)) {
    return null;
  }

  const instructions = [];
  const labels = new Map();

  for (const item of codeItems) {
    if (item?.labelDef !== undefined) {
      const normalized = normalizeLabel(item.labelDef);
      if (normalized !== null && !labels.has(normalized)) {
        labels.set(normalized, instructions.length);
      }
    }

    if (!item?.instruction) {
      continue;
    }

    const normalized = normalizeInstruction(item.instruction);
    if (!normalized || !normalized.op) {
      return null;
    }

    instructions.push({ normalized, original: item.instruction });
  }

  return { instructions, labels };
}

function gatherMethods(program) {
  const methods = new Map();
  if (!program || !Array.isArray(program.classes)) {
    return methods;
  }

  for (const cls of program.classes) {
    if (!cls || !Array.isArray(cls.items)) {
      continue;
    }
    const className = cls.className || '<anonymous>';

    for (const item of cls.items) {
      if (!item || item.type !== 'method' || !item.method) {
        continue;
      }

      const method = item.method;
      const signature = buildMethodSignature(className, method.name, method.descriptor);
      const codeAttr = (method.attributes || []).find(({ type }) => type === 'code');
      if (!codeAttr || !codeAttr.code) {
        continue;
      }

      const layout = parseMethodLayout(method.descriptor);
      if (!layout) {
        continue;
      }

      const prepared = prepareInstructions(codeAttr.code.codeItems);
      if (!prepared) {
        continue;
      }

      methods.set(signature, {
        signature,
        className,
        method,
        codeAttr,
        instructions: prepared.instructions,
        labels: prepared.labels,
        argTypes: layout.args,
        returnType: layout.returnType,
      });
    }
  }

  return methods;
}

function getInvocationSignature(normalized) {
  if (!normalized || !Array.isArray(normalized.arg) || normalized.arg.length < 3) {
    return null;
  }
  const [, owner, nameDesc] = normalized.arg;
  if (!owner || !Array.isArray(nameDesc) || nameDesc.length < 2) {
    return null;
  }
  const [name, descriptor] = nameDesc;
  if (!name || !descriptor) {
    return null;
  }
  return `${owner}.${name}${descriptor}`;
}

function cloneValue(value) {
  if (!value) {
    return null;
  }
  return { type: value.type, value: value.value };
}

function pushInt(stack, value, state) {
  if (incrementValues(state)) {
    return false;
  }
  const intValue = toInt32(value);
  if (intValue === null) {
    return false;
  }
  stack.push({ type: 'int', value: intValue });
  return true;
}

function pushLong(stack, value, state) {
  if (incrementValues(state)) {
    return false;
  }
  const normalized = normalizeLong(value);
  if (normalized === null) {
    return false;
  }
  stack.push({ type: 'long', value: normalized });
  return true;
}

function pushExisting(stack, value, state) {
  if (incrementValues(state)) {
    return false;
  }
  stack.push(cloneValue(value));
  return true;
}

function pop(stack) {
  if (!Array.isArray(stack) || stack.length === 0) {
    return null;
  }
  return stack.pop();
}

function popInt(stack) {
  const value = pop(stack);
  if (!value || !INT_TYPES.has(value.type)) {
    return null;
  }
  return value.value;
}

function popLong(stack) {
  const value = pop(stack);
  if (!value || !LONG_TYPES.has(value.type)) {
    return null;
  }
  return value.value;
}

function loadLocal(frame, descriptor, state) {
  if (!descriptor) {
    return false;
  }
  const value = frame.locals.get(descriptor.index);
  if (!value) {
    return false;
  }
  return pushExisting(frame.stack, value, state);
}

function storeLocal(frame, descriptor, state) {
  if (!descriptor) {
    return false;
  }

  let value = null;
  if (descriptor.base.startsWith('i')) {
    const popped = popInt(frame.stack);
    if (popped === null) {
      return false;
    }
    value = { type: 'int', value: toInt32(popped) };
  } else if (descriptor.base.startsWith('l')) {
    const popped = popLong(frame.stack);
    if (popped === null) {
      return false;
    }
    value = { type: 'long', value: popped };
  } else {
    return false;
  }

  frame.locals.set(descriptor.index, value);
  if (descriptor.base.startsWith('l')) {
    frame.locals.set(descriptor.index + 1, value);
  }

  return true;
}

function resolveLabel(methodInfo, label) {
  if (!methodInfo?.labels) {
    return null;
  }
  const normalized = normalizeLabel(label);
  if (!normalized) {
    return null;
  }
  const index = methodInfo.labels.get(normalized);
  return index === undefined ? null : index;
}

function createFrame(methodInfo, args, state) {
  const locals = new Map();
  const stack = [];

  let localIndex = 0;
  for (let i = 0; i < methodInfo.argTypes.length; i += 1) {
    const argType = methodInfo.argTypes[i];
    const argValue = args[i];

    if (argType.kind === 'int') {
      const intValue = toInt32(argValue);
      if (intValue === null) {
        return null;
      }
      const value = { type: 'int', value: intValue };
      locals.set(localIndex, value);
      localIndex += 1;
    } else if (argType.kind === 'long') {
      const longValue = normalizeLong(argValue);
      if (longValue === null) {
        return null;
      }
      const value = { type: 'long', value: longValue };
      locals.set(localIndex, value);
      locals.set(localIndex + 1, value);
      localIndex += 2;
    } else {
      return null;
    }
  }

  return { stack, locals };
}

function evaluateMethod(methodInfo, args, state, methods, purity, callStack) {
  if (!methodInfo || !Array.isArray(args)) {
    return { status: 'unsupported' };
  }

  const flags = methodInfo.method.flags || [];
  if (!Array.isArray(flags) || !flags.includes('static')) {
    return { status: 'unsupported' };
  }

  if (methodInfo.returnType.kind === 'void') {
    return { status: 'unsupported' };
  }

  const purityInfo = purity && purity[methodInfo.signature];
  if (!purityInfo || purityInfo.pure !== true) {
    return { status: 'unsupported' };
  }

  if (incrementIterations(state) || shouldAbort(state)) {
    return { status: 'limited', reason: state.bailReason || 'iterationLimit' };
  }

  callStack.push(methodInfo.signature);
  const frame = createFrame(methodInfo, args, state);
  if (!frame) {
    callStack.pop();
    return { status: 'unsupported' };
  }

  const result = runFrame(methodInfo, frame, state, methods, purity, callStack);
  callStack.pop();
  return result;
}

function runFrame(methodInfo, frame, state, methods, purity, callStack) {
  let pc = 0;
  const instructions = methodInfo.instructions;

  while (pc < instructions.length) {
    if (incrementInstructions(state) || shouldAbort(state)) {
      return { status: 'limited', reason: state.bailReason || 'instructionLimit' };
    }

    const { normalized, original } = instructions[pc];
    const op = normalized.op;

    switch (op) {
      case 'iconst_m1':
        if (!pushInt(frame.stack, -1, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      case 'iconst_0':
      case 'iconst_1':
      case 'iconst_2':
      case 'iconst_3':
      case 'iconst_4':
      case 'iconst_5': {
        const value = Number(op.split('_')[1]);
        if (!pushInt(frame.stack, value, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      }
      case 'lconst_0':
        if (!pushLong(frame.stack, 0n, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      case 'lconst_1':
        if (!pushLong(frame.stack, 1n, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      case 'bipush':
      case 'sipush': {
        const amount = Number.parseInt(normalized.arg, 10);
        if (!Number.isInteger(amount) || !pushInt(frame.stack, amount, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      }
      case 'iload_0':
      case 'iload_1':
      case 'iload_2':
      case 'iload_3':
      case 'iload': {
        const descriptor = parseLocalOperation({ op }, original);
        if (!descriptor || !loadLocal(frame, descriptor, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      }
      case 'istore_0':
      case 'istore_1':
      case 'istore_2':
      case 'istore_3':
      case 'istore': {
        const descriptor = parseLocalOperation({ op }, original);
        if (!descriptor || !storeLocal(frame, descriptor, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      }
      case 'lload_0':
      case 'lload_1':
      case 'lload_2':
      case 'lload_3':
      case 'lload': {
        const descriptor = parseLocalOperation({ op }, original);
        if (!descriptor || !loadLocal(frame, descriptor, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      }
      case 'lstore_0':
      case 'lstore_1':
      case 'lstore_2':
      case 'lstore_3':
      case 'lstore': {
        const descriptor = parseLocalOperation({ op }, original);
        if (!descriptor || !storeLocal(frame, descriptor, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      }
      case 'iadd': {
        const right = popInt(frame.stack);
        const left = popInt(frame.stack);
        if (right === null || left === null || !pushInt(frame.stack, left + right, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      }
      case 'isub': {
        const right = popInt(frame.stack);
        const left = popInt(frame.stack);
        if (right === null || left === null || !pushInt(frame.stack, left - right, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      }
      case 'ladd': {
        const right = popLong(frame.stack);
        const left = popLong(frame.stack);
        if (right === null || left === null || !pushLong(frame.stack, left + right, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      }
      case 'lsub': {
        const right = popLong(frame.stack);
        const left = popLong(frame.stack);
        if (right === null || left === null || !pushLong(frame.stack, left - right, state)) {
          return { status: 'unsupported' };
        }
        pc += 1;
        break;
      }
      case 'iinc': {
        const { varnum, incr } = original || {};
        const index = Number.parseInt(varnum, 10);
        const amount = Number.parseInt(incr, 10);
        if (!Number.isInteger(index) || !Number.isInteger(amount)) {
          return { status: 'unsupported' };
        }
        const current = frame.locals.get(index);
        if (!current || !INT_TYPES.has(current.type)) {
          return { status: 'unsupported' };
        }
        current.value = toInt32((current.value || 0) + amount);
        frame.locals.set(index, current);
        pc += 1;
        break;
      }
      case 'ifeq':
      case 'ifne':
      case 'iflt':
      case 'ifge':
      case 'ifgt':
      case 'ifle': {
        const value = popInt(frame.stack);
        if (value === null) {
          return { status: 'unsupported' };
        }
        const target = resolveLabel(methodInfo, normalized.arg);
        if (target === null) {
          return { status: 'unsupported' };
        }
        let condition = false;
        switch (op) {
          case 'ifeq':
            condition = value === 0;
            break;
          case 'ifne':
            condition = value !== 0;
            break;
          case 'iflt':
            condition = value < 0;
            break;
          case 'ifge':
            condition = value >= 0;
            break;
          case 'ifgt':
            condition = value > 0;
            break;
          case 'ifle':
            condition = value <= 0;
            break;
          default:
            break;
        }
        pc = condition ? target : pc + 1;
        break;
      }
      case 'if_icmpeq':
      case 'if_icmpne':
      case 'if_icmplt':
      case 'if_icmpge':
      case 'if_icmpgt':
      case 'if_icmple': {
        const right = popInt(frame.stack);
        const left = popInt(frame.stack);
        if (right === null || left === null) {
          return { status: 'unsupported' };
        }
        const target = resolveLabel(methodInfo, normalized.arg);
        if (target === null) {
          return { status: 'unsupported' };
        }
        let condition = false;
        switch (op) {
          case 'if_icmpeq':
            condition = left === right;
            break;
          case 'if_icmpne':
            condition = left !== right;
            break;
          case 'if_icmplt':
            condition = left < right;
            break;
          case 'if_icmpge':
            condition = left >= right;
            break;
          case 'if_icmpgt':
            condition = left > right;
            break;
          case 'if_icmple':
            condition = left <= right;
            break;
          default:
            break;
        }
        pc = condition ? target : pc + 1;
        break;
      }
      case 'goto': {
        const target = resolveLabel(methodInfo, normalized.arg);
        if (target === null) {
          return { status: 'unsupported' };
        }
        pc = target;
        break;
      }
      case 'invokestatic': {
        const signature = getInvocationSignature(normalized);
        const callee = methods.get(signature);
        if (!signature || !callee) {
          return { status: 'unsupported' };
        }

        const purityInfo = purity && purity[signature];
        if (!purityInfo || purityInfo.pure !== true) {
          return { status: 'unsupported' };
        }

        const args = new Array(callee.argTypes.length);
        for (let i = callee.argTypes.length - 1; i >= 0; i -= 1) {
          const type = callee.argTypes[i];
          if (type.kind === 'int') {
            const value = popInt(frame.stack);
            if (value === null) {
              return { status: 'unsupported' };
            }
            args[i] = value;
          } else if (type.kind === 'long') {
            const value = popLong(frame.stack);
            if (value === null) {
              return { status: 'unsupported' };
            }
            args[i] = value;
          } else {
            return { status: 'unsupported' };
          }
        }

        const result = evaluateMethod(callee, args, state, methods, purity, callStack);
        if (!result || result.status !== 'ok') {
          return result || { status: 'unsupported' };
        }

        if (callee.returnType.kind === 'int') {
          if (!pushInt(frame.stack, result.value, state)) {
            return { status: 'unsupported' };
          }
        } else if (callee.returnType.kind === 'long') {
          if (!pushLong(frame.stack, result.value, state)) {
            return { status: 'unsupported' };
          }
        } else if (callee.returnType.kind !== 'void') {
          return { status: 'unsupported' };
        }

        pc += 1;
        break;
      }
      case 'ireturn': {
        const value = popInt(frame.stack);
        if (value === null) {
          return { status: 'unsupported' };
        }
        return { status: 'ok', type: 'int', value: toInt32(value) };
      }
      case 'lreturn': {
        const value = popLong(frame.stack);
        if (value === null) {
          return { status: 'unsupported' };
        }
        return { status: 'ok', type: 'long', value };
      }
      default:
        return { status: 'unsupported' };
    }
  }

  return { status: 'unsupported' };
}

function convertConsumedToArgs(consumed, argTypes) {
  if (!Array.isArray(consumed) || consumed.length !== argTypes.length) {
    return null;
  }

  const args = new Array(argTypes.length);

  for (let i = argTypes.length - 1, cursor = 0; i >= 0; i -= 1, cursor += 1) {
    const value = consumed[cursor];
    const type = argTypes[i];
    if (!value || value.kind !== 'constant') {
      return null;
    }
    if (type.kind === 'int') {
      if (value.type !== 'int') {
        return null;
      }
      args[i] = value.value;
    } else if (type.kind === 'long') {
      if (value.type !== 'long' && value.type !== 'int') {
        return null;
      }
      const converted = value.type === 'long' ? value.value : BigInt(value.value);
      args[i] = converted;
    } else {
      return null;
    }
  }

  return args;
}

function createStaticInvokeEvaluator(program, options = {}) {
  const methods = gatherMethods(program);
  if (methods.size === 0) {
    return null;
  }

  const purity = analyzePurity(program);
  if (!purity) {
    return null;
  }

  return function evaluateStaticInvoke(normalized, consumed) {
    const signature = getInvocationSignature(normalized);
    if (!signature) {
      return null;
    }

    const methodInfo = methods.get(signature);
    if (!methodInfo) {
      return null;
    }

    const purityInfo = purity[signature];
    if (!purityInfo || purityInfo.pure !== true) {
      return null;
    }

    const args = convertConsumedToArgs(consumed, methodInfo.argTypes);
    if (!args) {
      return null;
    }

    const state = createEvaluationState(options.limits || {});
    const result = evaluateMethod(methodInfo, args, state, methods, purity, []);
    if (!result || result.status !== 'ok') {
      return null;
    }

    return { type: result.type, value: result.value };
  };
}

module.exports = {
  createStaticInvokeEvaluator,
};

