const Frame = require('../../../core/frame');

function values(obj) {
  if (!(obj.values instanceof Map)) obj.values = new Map();
  return obj.values;
}

async function invokeInitialValue(jvm, supplier, thread) {
  const handle = supplier && supplier.methodHandle;
  const reference = handle && handle.reference;
  if (!handle || !reference || handle.kind !== 'newInvokeSpecial') {
    throw new Error('Unsupported ThreadLocal initial-value supplier');
  }
  const className = reference.className;
  const descriptor = reference.nameAndType.descriptor;
  const value = await jvm.createAppletInstance(className, thread);
  const classData = jvm.classes[className] || await jvm.loadClassByName(className);
  const constructor = jvm.findMethod(classData, '<init>', descriptor);
  if (!constructor) {
    throw new Error(`Missing ThreadLocal supplier constructor ${className}${descriptor}`);
  }
  const frame = new Frame(constructor);
  frame.className = className;
  frame.locals[0] = value;
  thread.callStack.push(frame);
  const constructorDepth = thread.callStack.size();
  while (thread.callStack.size() >= constructorDepth) {
    const result = await jvm.executeTick();
    if (result && result.completed) break;
  }
  return value;
}

module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'withInitial(Ljava/util/function/Supplier;)Ljava/lang/ThreadLocal;':
      (jvm, obj, args) => ({
        type: 'java/lang/ThreadLocal',
        supplier: args[0],
        values: new Map(),
      }),
  },
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.values = new Map();
      obj.supplier = null;
    },
    'get()Ljava/lang/Object;': async (jvm, obj, args, thread) => {
      const localValues = values(obj);
      if (localValues.has(thread)) return localValues.get(thread);
      const value = obj.supplier
        ? await invokeInitialValue(jvm, obj.supplier, thread)
        : null;
      localValues.set(thread, value);
      return value;
    },
    'set(Ljava/lang/Object;)V': (jvm, obj, args, thread) => {
      values(obj).set(thread, args[0]);
    },
    'remove()V': (jvm, obj, args, thread) => {
      values(obj).delete(thread);
    },
  },
};
