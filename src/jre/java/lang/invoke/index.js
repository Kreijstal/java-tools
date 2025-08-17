class MethodHandle {
  constructor(kind, reference) {
    this.kind = kind; // e.g., 'invokeStatic', 'invokeVirtual'
    this.reference = reference; // { className, nameAndType: { name, descriptor } }
    this.type = 'java/lang/invoke/MethodHandle';
    this.bound = null;
  }

  bindTo(value) {
    const newHandle = new MethodHandle(this.kind, this.reference);
    newHandle.bound = value;
    return newHandle;
  }
}

class MethodType {
  constructor(descriptor) {
    this.descriptor = descriptor; // e.g., '()V'
    this.type = 'java/lang/invoke/MethodType';
  }
}

class CallSite {
  constructor(target) {
    this.target = target; // A MethodHandle
    this.type = 'java/lang/invoke/CallSite';
  }
}

// Represents MethodHandles.Lookup
class Lookup {
  constructor() {
    this.type = 'java/lang/invoke/MethodHandles$Lookup';
  }
}

module.exports = {
  MethodHandle,
  MethodType,
  CallSite,
  Lookup,
};
