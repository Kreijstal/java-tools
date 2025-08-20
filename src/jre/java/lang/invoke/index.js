const { parseDescriptor, descriptorToString } = require('/app/src/typeParser');

class MethodHandle {
  constructor(kind, reference, type) {
    this.kind = kind; // e.g., 'invokeStatic', 'invokeVirtual', 'getField', 'putField'
    this.reference = reference; // { className, nameAndType: { name, descriptor } }
    this.type = 'java/lang/invoke/MethodHandle';
    this.methodType = kind.startsWith('invoke') ? type : null;
    this.fieldType = kind.endsWith('Field') ? type : null;
    this.bound = null;
  }

  bindTo(value) {
    const newHandle = new MethodHandle(this.kind, this.reference, this.methodType || this.fieldType);
    newHandle.bound = value;
    return newHandle;
  }
}

class MethodType {
  constructor(ptypes, rtype) {
    this.ptypes = ptypes;
    this.rtype = rtype;
    this.type = 'java/lang/invoke/MethodType';
  }

  static fromDescriptor(descriptor) {
    const { params, returnType } = parseDescriptor(descriptor);
    return new MethodType(params, returnType);
  }

  toDescriptor() {
    return `(${this.ptypes.join('')})${this.rtype}`;
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
