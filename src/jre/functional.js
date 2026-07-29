const Frame = require('../core/frame');
const { parseDescriptor } = require('../parsing/typeParser');

function assignLocals(locals, args, params, start) {
  let index = start;
  for (let i = 0; i < params.length; i++) {
    locals[index] = args[i];
    index += params[i] === 'long' || params[i] === 'double' ? 2 : 1;
  }
}

async function findMethod(jvm, className, name, descriptor) {
  let currentName = className;
  while (currentName) {
    const classData = jvm.classes[currentName] ||
      await jvm.loadClassByName(currentName);
    if (!classData || !classData.ast || !classData.ast.classes[0]) return null;
    const method = jvm.findMethod(classData, name, descriptor);
    if (method) return { className: currentName, method };
    currentName = classData.ast.classes[0].superClassName;
  }
  return null;
}

async function runGuestMethod(jvm, thread, target, receiver, args, params, returnType) {
  const parent = thread.callStack.peek();
  const parentStackSize = parent.stack.size();
  const frame = new Frame(target.method);
  frame.className = target.className;
  let localStart = 0;
  if (receiver !== null) {
    frame.locals[0] = receiver;
    localStart = 1;
  }
  assignLocals(frame.locals, args, params, localStart);
  thread.callStack.push(frame);
  const depth = thread.callStack.size();
  while (thread.callStack.size() >= depth) {
    const result = await jvm.executeTick();
    if (result && result.completed) break;
  }
  if (returnType === 'V' || returnType === 'void') return undefined;
  if (parent.stack.size() <= parentStackSize) {
    throw new Error(`Guest functional method ${target.className}.${target.method.name} returned no value`);
  }
  return parent.stack.pop();
}

async function invokeFunctional(jvm, functional, args, thread) {
  const handle = functional && functional.methodHandle;
  const reference = handle && handle.reference;
  if (!handle || !reference || !reference.nameAndType) {
    const directApply = functional && functional.methods &&
      functional.methods['apply(Ljava/lang/Object;)Ljava/lang/Object;'];
    if (typeof directApply === 'function') {
      return directApply(jvm, functional, args || [], thread);
    }
    throw new Error('Object is not a MethodHandle-backed functional interface');
  }
  const name = reference.nameAndType.name;
  const descriptor = reference.nameAndType.descriptor;
  const parsed = parseDescriptor(descriptor);
  const invocationArgs = [...(functional.capturedArgs || []), ...(args || [])];

  if (handle.kind === 'newInvokeSpecial') {
    const value = await jvm.createAppletInstance(reference.className, thread);
    const target = await findMethod(jvm, reference.className, '<init>', descriptor);
    if (!target) throw new Error(`Missing functional constructor ${reference.className}${descriptor}`);
    await runGuestMethod(
      jvm,
      thread,
      target,
      value,
      invocationArgs,
      parsed.params,
      'V',
    );
    return value;
  }

  const isStatic = handle.kind === 'invokeStatic';
  const receiver = isStatic ? null : invocationArgs.shift();
  const startClass = handle.kind === 'invokeVirtual' || handle.kind === 'invokeInterface'
    ? receiver && (receiver._className || receiver.type)
    : reference.className;
  if (typeof startClass !== 'string') {
    throw new Error(`Invalid functional receiver for ${reference.className}.${name}${descriptor}`);
  }
  const target = await findMethod(jvm, startClass, name, descriptor);
  if (!target) throw new Error(`Missing functional target ${reference.className}.${name}${descriptor}`);
  return runGuestMethod(
    jvm,
    thread,
    target,
    receiver,
    invocationArgs,
    parsed.params,
    parsed.returnType,
  );
}

module.exports = { invokeFunctional };
