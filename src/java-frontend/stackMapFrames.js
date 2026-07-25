'use strict';

const TOP = 'Top';
const TOP2 = 'Top2';
const INTEGER = 'Integer';
const FLOAT = 'Float';
const LONG = 'Long';
const DOUBLE = 'Double';
const NULL = 'Null';
const UNINITIALIZED_THIS = 'UninitializedThis';

function objectType(name) {
  return { type: 'Object', cls: name };
}

function uninitializedType(label, cls) {
  return { type: 'Uninitialized', lbl: label, cls };
}

function isObject(value) {
  return value && typeof value === 'object' && value.type === 'Object';
}

function isUninitialized(value) {
  return value && typeof value === 'object' && value.type === 'Uninitialized';
}

function sameType(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  return left.type === right.type && left.cls === right.cls && left.lbl === right.lbl;
}

function verificationTypeForDescriptor(descriptor) {
  if (['Z', 'B', 'C', 'S', 'I'].includes(descriptor)) return INTEGER;
  if (descriptor === 'F') return FLOAT;
  if (descriptor === 'J') return LONG;
  if (descriptor === 'D') return DOUBLE;
  if (descriptor && descriptor.startsWith('L')) return objectType(descriptor.slice(1, -1));
  if (descriptor && descriptor.startsWith('[')) return objectType(descriptor);
  return TOP;
}

function descriptorParameters(descriptor) {
  const result = [];
  const end = descriptor.indexOf(')');
  for (let index = descriptor.indexOf('(') + 1; index > 0 && index < end;) {
    const start = index;
    while (descriptor[index] === '[') index += 1;
    if (descriptor[index] === 'L') {
      index = descriptor.indexOf(';', index) + 1;
    } else {
      index += 1;
    }
    result.push(descriptor.slice(start, index));
  }
  return result;
}

function descriptorReturn(descriptor) {
  return descriptor.slice(descriptor.indexOf(')') + 1);
}

function typeWidth(type) {
  return type === LONG || type === DOUBLE ? 2 : 1;
}

function cloneType(type) {
  return type && typeof type === 'object' ? { ...type } : type;
}

function cloneFrame(frame) {
  return {
    locals: frame.locals.map(cloneType),
    stack: frame.stack.map(cloneType),
  };
}

function initialFrame(method, classIr) {
  const locals = Array(Math.max(0, method.maxLocals || 0)).fill(TOP);
  let slot = 0;
  if (!(method.access || []).includes('static')) {
    locals[slot++] = method.name === '<init>' ? UNINITIALIZED_THIS : objectType(classIr.internalName);
  }
  for (const descriptor of descriptorParameters(method.descriptor)) {
    const type = verificationTypeForDescriptor(descriptor);
    locals[slot++] = type;
    if (typeWidth(type) === 2) locals[slot++] = TOP2;
  }
  return { locals, stack: [] };
}

function localIndex(opcode, operands) {
  const suffix = /_(\d)$/.exec(opcode);
  return suffix ? Number(suffix[1]) : Number(operands[0]);
}

function pop(frame, count = 1) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    if (!frame.stack.length) throw new Error('operand stack underflow while computing StackMapTable');
    values.push(frame.stack.pop());
  }
  return values;
}

function pushDescriptor(frame, descriptor) {
  if (descriptor && descriptor !== 'V') frame.stack.push(verificationTypeForDescriptor(descriptor));
}

function replaceInitialized(frame, source, replacement) {
  frame.locals = frame.locals.map((value) => sameType(value, source) ? replacement : value);
  frame.stack = frame.stack.map((value) => sameType(value, source) ? replacement : value);
}

function memberDescriptor(instruction) {
  const operands = instruction.operands || [];
  return String(operands[operands.length - 1] || '');
}

function transfer(instruction, input, index, classIr) {
  const frame = cloneFrame(input);
  const opcode = instruction.opcode;
  const operands = instruction.operands || [];
  if (opcode === 'nop') return frame;
  if (opcode === 'aconst_null') frame.stack.push(NULL);
  else if (/^(?:iconst_|bipush|sipush)/.test(opcode)) frame.stack.push(INTEGER);
  else if (/^lconst_/.test(opcode)) frame.stack.push(LONG);
  else if (/^fconst_/.test(opcode)) frame.stack.push(FLOAT);
  else if (/^dconst_/.test(opcode)) frame.stack.push(DOUBLE);
  else if (opcode === 'ldc' || opcode === 'ldc_w') {
    const literal = String(operands[0] || '');
    if (operands[0] === 'Class') frame.stack.push(objectType('java/lang/Class'));
    else if (literal.startsWith('"')) frame.stack.push(objectType('java/lang/String'));
    else if (/[fF]$/.test(literal)) frame.stack.push(FLOAT);
    else frame.stack.push(INTEGER);
  } else if (opcode === 'ldc2_w') {
    frame.stack.push(/[lL]$/.test(String(operands[0] || '')) ? LONG : DOUBLE);
  } else if (/^[ialfd]load(?:_\d)?$/.test(opcode)) {
    frame.stack.push(frame.locals[localIndex(opcode, operands)]);
  } else if (/^[ialfd]store(?:_\d)?$/.test(opcode)) {
    const slot = localIndex(opcode, operands);
    const [value] = pop(frame);
    frame.locals[slot] = value;
    if (typeWidth(value) === 2) frame.locals[slot + 1] = TOP2;
  } else if (opcode === 'iinc') {
    frame.locals[Number(operands[0])] = INTEGER;
  } else if (opcode === 'pop') pop(frame);
  else if (opcode === 'pop2') {
    const [first] = pop(frame);
    if (typeWidth(first) !== 2) pop(frame);
  } else if (opcode === 'dup') {
    const [value] = pop(frame);
    frame.stack.push(value, cloneType(value));
  } else if (opcode === 'dup_x1') {
    const [one, two] = pop(frame, 2);
    frame.stack.push(one, two, cloneType(one));
  } else if (opcode === 'dup_x2') {
    const [one, two] = pop(frame, 2);
    if (typeWidth(two) === 2) frame.stack.push(one, two, cloneType(one));
    else {
      const [three] = pop(frame);
      frame.stack.push(one, three, two, cloneType(one));
    }
  } else if (opcode === 'swap') {
    const [one, two] = pop(frame, 2);
    frame.stack.push(one, two);
  } else if (opcode === 'new') {
    frame.stack.push(uninitializedType(instruction.label || `L${index}`, String(operands[0])));
  } else if (opcode === 'newarray' || opcode === 'anewarray') {
    pop(frame);
    if (opcode === 'anewarray') {
      const component = String(operands[0]);
      frame.stack.push(objectType(`[${component.startsWith('[') ? component : `L${component};`}`));
    } else {
      const descriptors = { boolean: 'Z', byte: 'B', char: 'C', short: 'S', int: 'I', long: 'J', float: 'F', double: 'D' };
      frame.stack.push(objectType(`[${descriptors[String(operands[0])] || 'I'}`));
    }
  } else if (opcode === 'multianewarray') {
    pop(frame, Number(operands[1]));
    frame.stack.push(objectType(String(operands[0])));
  } else if (opcode === 'arraylength') {
    pop(frame);
    frame.stack.push(INTEGER);
  } else if (/^[ialfdbcs]aload$/.test(opcode)) {
    pop(frame, 2);
    const types = { iaload: INTEGER, baload: INTEGER, caload: INTEGER, saload: INTEGER, laload: LONG, faload: FLOAT, daload: DOUBLE };
    if (opcode === 'aaload') frame.stack.push(objectType('java/lang/Object'));
    else frame.stack.push(types[opcode]);
  } else if (/^[ialfdbcs]astore$/.test(opcode)) pop(frame, 3);
  else if (opcode === 'getstatic') pushDescriptor(frame, memberDescriptor(instruction));
  else if (opcode === 'putstatic') pop(frame);
  else if (opcode === 'getfield') {
    pop(frame);
    pushDescriptor(frame, memberDescriptor(instruction));
  } else if (opcode === 'putfield') pop(frame, 2);
  else if (opcode === 'checkcast') {
    pop(frame);
    const name = String(operands[0]);
    frame.stack.push(objectType(name));
  } else if (opcode === 'instanceof') {
    pop(frame);
    frame.stack.push(INTEGER);
  } else if (/^invoke(?:virtual|interface|static|special)$/.test(opcode)) {
    const descriptor = memberDescriptor(instruction);
    pop(frame, descriptorParameters(descriptor).length);
    let receiver = null;
    if (opcode !== 'invokestatic') [receiver] = pop(frame);
    const name = String(operands[2] || '');
    const owner = String(operands[1] || 'java/lang/Object');
    if (opcode === 'invokespecial' && name === '<init>' && receiver) {
      const replacement = objectType(receiver === UNINITIALIZED_THIS ? classIr.internalName : owner);
      replaceInitialized(frame, receiver, replacement);
    }
    pushDescriptor(frame, descriptorReturn(descriptor));
  } else if (/^[ilfd](?:add|sub|mul|div|rem|and|or|xor)$/.test(opcode)) {
    pop(frame, 2);
    frame.stack.push({ i: INTEGER, l: LONG, f: FLOAT, d: DOUBLE }[opcode[0]]);
  } else if (/^[il](?:shl|shr|ushr)$/.test(opcode)) {
    pop(frame, 2);
    frame.stack.push(opcode[0] === 'l' ? LONG : INTEGER);
  } else if (/^[ilfd]neg$/.test(opcode)) {
    const [value] = pop(frame);
    frame.stack.push(value);
  } else if (/^[ifld]2[ifldbcs]$/.test(opcode)) {
    pop(frame);
    frame.stack.push({ i: INTEGER, b: INTEGER, c: INTEGER, s: INTEGER, l: LONG, f: FLOAT, d: DOUBLE }[opcode[2]]);
  } else if (['lcmp', 'fcmpl', 'fcmpg', 'dcmpl', 'dcmpg'].includes(opcode)) {
    pop(frame, 2);
    frame.stack.push(INTEGER);
  } else if (/^if_icmp/.test(opcode) || /^if_acmp/.test(opcode)) pop(frame, 2);
  else if (/^if(?:eq|ne|lt|le|gt|ge|null|nonnull)$/.test(opcode)) pop(frame);
  else if (opcode === 'lookupswitch') pop(frame);
  else if (opcode === 'monitorenter' || opcode === 'monitorexit' || opcode === 'athrow') pop(frame);
  else if (opcode === 'ireturn' || opcode === 'lreturn' || opcode === 'freturn' || opcode === 'dreturn' || opcode === 'areturn') pop(frame);
  else if (opcode === 'return' || opcode === 'goto') { /* no stack effect */ }
  else throw new Error(`unsupported opcode ${opcode} while computing StackMapTable`);
  return frame;
}

function mergeType(left, right, declared) {
  if (sameType(left, right)) return cloneType(left);
  if (left === TOP || right === TOP || left === TOP2 || right === TOP2) return TOP;
  if (left === NULL && isObject(right)) return cloneType(right);
  if (right === NULL && isObject(left)) return cloneType(left);
  if (isObject(left) && isObject(right)) {
    if (isObject(declared)) return cloneType(declared);
    return objectType('java/lang/Object');
  }
  throw new Error(`incompatible verification types ${JSON.stringify(left)} and ${JSON.stringify(right)}`);
}

function mergeFrame(current, incoming, declaredLocals) {
  if (!current) return { frame: cloneFrame(incoming), changed: true };
  if (current.stack.length !== incoming.stack.length) {
    throw new Error(`incompatible operand stack heights ${current.stack.length} and ${incoming.stack.length}`);
  }
  const merged = cloneFrame(current);
  let changed = false;
  for (let index = 0; index < merged.locals.length; index += 1) {
    const value = mergeType(current.locals[index], incoming.locals[index], declaredLocals[index]);
    if (!sameType(value, current.locals[index])) { merged.locals[index] = value; changed = true; }
  }
  for (let index = 0; index < merged.stack.length; index += 1) {
    const value = mergeType(current.stack[index], incoming.stack[index], null);
    if (!sameType(value, current.stack[index])) { merged.stack[index] = value; changed = true; }
  }
  return { frame: merged, changed };
}

function declaredLocalTypes(method) {
  const result = Array(Math.max(0, method.maxLocals || 0)).fill(TOP);
  for (const local of method.meta && method.meta.locals || []) {
    if (typeof local.slotHint !== 'number') continue;
    const type = verificationTypeForDescriptor(local.descriptor);
    result[local.slotHint] = type;
    if (typeWidth(type) === 2) result[local.slotHint + 1] = TOP2;
  }
  return result;
}

function frameLocalsForAttribute(locals) {
  let end = locals.length;
  while (end > 0 && (locals[end - 1] === TOP || locals[end - 1] === TOP2)) end -= 1;
  const result = [];
  for (let index = 0; index < end; index += 1) {
    if (locals[index] !== TOP2) result.push(cloneType(locals[index]));
  }
  return result;
}

function computeStackMapFrames(method, classIr) {
  const instructions = method.instructions || [];
  if (!instructions.length) return [];
  const labels = new Map();
  instructions.forEach((instruction, index) => labels.set(instruction.label || `L${index}`, index));
  const targets = new Set();
  const branch = /^(?:goto|if)/;
  instructions.forEach((instruction) => {
    if (branch.test(instruction.opcode) && instruction.operands && instruction.operands[0]) {
      targets.add(labels.get(String(instruction.operands[0])));
    }
    if (instruction.opcode === 'lookupswitch') {
      targets.add(labels.get(String(instruction.defaultLabel)));
      for (const pair of instruction.pairs || []) {
        const label = Array.isArray(pair) ? pair[1] : pair && (pair.label || pair.lbl);
        targets.add(labels.get(String(label)));
      }
    }
  });
  for (const entry of method.exceptionTable || []) targets.add(labels.get(entry.handlerLabel));
  const structuralTargets = new Set(targets);
  const terminalOpcodes = new Set(['goto', 'lookupswitch', 'return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'athrow']);
  instructions.forEach((instruction, index) => {
    if (terminalOpcodes.has(instruction.opcode) && index + 1 < instructions.length
      && !structuralTargets.has(index + 1)) targets.add(index + 1);
  });
  targets.delete(undefined);
  targets.delete(0);
  if (!targets.size) return [];

  const declared = declaredLocalTypes(method);
  const inputs = Array(instructions.length).fill(null);
  inputs[0] = initialFrame(method, classIr);
  const queue = [0];
  const queued = new Set(queue);
  const enqueue = (index, incoming) => {
    if (index == null || index < 0 || index >= instructions.length) return;
    let merged;
    try {
      merged = mergeFrame(inputs[index], incoming, declared);
    } catch (error) {
      error.message = `${error.message} at instruction ${index} (${instructions[index].label || `L${index}`})`;
      throw error;
    }
    if (merged.changed) {
      inputs[index] = merged.frame;
      if (!queued.has(index)) { queue.push(index); queued.add(index); }
    }
  };
  while (queue.length) {
    const index = queue.shift();
    queued.delete(index);
    const input = inputs[index];
    const instruction = instructions[index];
    const output = transfer(instruction, input, index, classIr);
    const opcode = instruction.opcode;
    if (/^if/.test(opcode)) {
      enqueue(labels.get(String(instruction.operands[0])), output);
      enqueue(index + 1, output);
    } else if (opcode === 'lookupswitch') {
      enqueue(labels.get(String(instruction.defaultLabel)), output);
      for (const pair of instruction.pairs || []) {
        const label = Array.isArray(pair) ? pair[1] : pair && (pair.label || pair.lbl);
        enqueue(labels.get(String(label)), output);
      }
      if (!structuralTargets.has(index + 1)) enqueue(index + 1, output);
    } else if (opcode === 'goto') {
      enqueue(labels.get(String(instruction.operands[0])), output);
      if (!structuralTargets.has(index + 1)) enqueue(index + 1, output);
    } else if (['return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'athrow'].includes(opcode)) {
      if (!structuralTargets.has(index + 1)) enqueue(index + 1, output);
    } else if (!['return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'athrow'].includes(opcode)) {
      enqueue(index + 1, output);
    }
    for (const entry of method.exceptionTable || []) {
      const start = labels.get(entry.startLabel);
      const end = labels.get(entry.endLabel);
      if (start != null && end != null && index >= start && index < end) {
        const handler = cloneFrame(input);
        handler.stack = [objectType(entry.catchType && entry.catchType !== 'any' ? entry.catchType : 'java/lang/Throwable')];
        enqueue(labels.get(entry.handlerLabel), handler);
      }
    }
  }
  return [...targets].sort((a, b) => a - b).filter((index) => inputs[index]).map((index) => ({
    label: instructions[index].label || `L${index}`,
    locals: frameLocalsForAttribute(inputs[index].locals),
    stack: inputs[index].stack.map(cloneType),
  }));
}

module.exports = { computeStackMapFrames };
