const resolvedClassInitializationToken = Symbol('resolvedClassInitializationToken');

function classInitializationTokenFor(jvm, instruction, className) {
  let initialization =
    instruction && instruction[resolvedClassInitializationToken];
  if (!initialization || initialization.jvm !== jvm) {
    initialization = {
      jvm,
      token: jvm.getClassInitializationToken(className),
    };
    if (instruction && typeof instruction === 'object') {
      try {
        Object.defineProperty(instruction, resolvedClassInitializationToken, {
          configurable: true,
          writable: true,
          value: initialization,
        });
      } catch (_) {
        // Frozen diagnostic fixtures retain the uncached token lookup.
      }
    }
  }
  return initialization.token;
}

function normalizeArrayLoad(value, kind, arrayRef) {
  if (!kind) {
    kind = arrayRef.type === "[B" || arrayRef.type === "[Z" ? "baload"
      : arrayRef.type === "[C" ? "caload"
        : arrayRef.type === "[S" ? "saload"
          : arrayRef.type === "[I" ? "iaload"
            : arrayRef.type === "[F" ? "faload"
              : arrayRef.type === "[J" ? "laload" : null;
  }
  if (kind === "baload") {
    if (arrayRef.type === "[Z" || arrayRef.elementType === "boolean") {
      return value ? 1 : 0;
    }
    return (Number(value) << 24) >> 24;
  }
  if (kind === "caload") return Number(value) & 0xffff;
  if (kind === "saload") return (Number(value) << 16) >> 16;
  if (kind === "iaload") return Number(value) | 0;
  if (kind === "faload") return Math.fround(Number(value));
  if (kind === "laload") return BigInt.asIntN(64, BigInt(value));
  return value;
}

function normalizeArrayStore(value, kind, arrayRef) {
  if (!kind) {
    kind = arrayRef.type === "[B" || arrayRef.type === "[Z" ? "bastore"
      : arrayRef.type === "[C" ? "castore"
        : arrayRef.type === "[S" ? "sastore"
          : arrayRef.type === "[I" ? "iastore"
            : arrayRef.type === "[F" ? "fastore"
              : arrayRef.type === "[J" ? "lastore" : null;
  }
  if (kind === "bastore") {
    if (arrayRef.type === "[Z" || arrayRef.elementType === "boolean") {
      return Number(value) & 1;
    }
    return (Number(value) << 24) >> 24;
  }
  if (kind === "castore") return Number(value) & 0xffff;
  if (kind === "sastore") return (Number(value) << 16) >> 16;
  if (kind === "iastore") return Number(value) | 0;
  if (kind === "fastore") return Math.fround(Number(value));
  if (kind === "lastore") return BigInt.asIntN(64, BigInt(value));
  return value;
}

function _aload(frame, kind) {
  const index = frame.stack.pop();
  const arrayRef = frame.stack.pop();

  if (arrayRef === null || arrayRef === undefined) {
    if (typeof process !== "undefined" && process.env &&
        process.env.JVM_DEBUG_NULL_ARRAY === "1") {
      const receiver = frame.locals && frame.locals[0];
      const fields = receiver && receiver.fields
        ? Object.fromEntries(Object.entries(receiver.fields).map(([key, fieldValue]) => [
          key,
          diagnosticScalar(fieldValue),
        ]))
        : null;
      console.error("[null-array-load]", JSON.stringify({
        owner: diagnosticScalar(frame.className),
        method: `${frame.method && frame.method.name}${frame.method && frame.method.descriptor || ""}`,
        pc: frame.pc - 1,
        index: diagnosticScalar(index),
        receiverType: diagnosticScalar(receiver && receiver.type),
        fields,
        locals: (frame.locals || []).map(diagnosticScalar),
      }));
    }
    throw {
      type: "java/lang/NullPointerException",
      message: `Attempted to load from null array in ${frame.method.name}`,
    };
  }

  if (index < 0 || index >= arrayRef.length) {
    if (typeof process !== "undefined" && process.env &&
        process.env.JVM_DEBUG_ARRAY_OOB === "1") {
      console.error("[array-load-oob]", JSON.stringify({
        owner: diagnosticScalar(frame.className),
        method: `${frame.method && frame.method.name}${frame.method && frame.method.descriptor || ""}`,
        pc: frame.pc - 1,
        index: diagnosticScalar(index),
        length: arrayRef.length,
        locals: (frame.locals || []).map(diagnosticScalar),
      }));
    }
    throw {
      type: "java/lang/ArrayIndexOutOfBoundsException",
      message: `Index ${index} out of bounds for length ${arrayRef.length}`,
    };
  }

  const raw = arrayRef.elements ? arrayRef.elements[index] : arrayRef[index];
  const value = normalizeArrayLoad(raw, kind, arrayRef);
  frame.stack.push(value);
}

function diagnosticScalar(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean" || typeof value === "bigint") {
    return typeof value === "bigint" ? `${value}n` : value;
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return `[${value.length}]`;
  }
  if (typeof value === "object") {
    const type = typeof value.type === "string" ? value.type : null;
    return type ? `<${type}>` : `<${value.constructor && value.constructor.name || "object"}>`;
  }
  return typeof value;
}

function _astore(frame, kind) {
  const value = frame.stack.pop();
  const index = frame.stack.pop();
  const arrayRef = frame.stack.pop();

  if (arrayRef === null || arrayRef === undefined) {
    if (typeof process !== "undefined" && process.env &&
        process.env.JVM_DEBUG_NULL_ARRAY === "1") {
      const receiver = frame.locals && frame.locals[0];
      const fields = receiver && receiver.fields
        ? Object.fromEntries(Object.entries(receiver.fields).map(([key, fieldValue]) => [
          key,
          diagnosticScalar(fieldValue),
        ]))
        : null;
      console.error("[null-array-store]", JSON.stringify({
        owner: diagnosticScalar(frame.className),
        method: `${frame.method && frame.method.name}${frame.method && frame.method.descriptor || ""}`,
        pc: frame.pc - 1,
        index: diagnosticScalar(index),
        receiverType: diagnosticScalar(receiver && receiver.type),
        fields,
      }));
    }
    throw {
      type: "java/lang/NullPointerException",
      message: `Attempted to store into null array in ${frame.method.name}`,
    };
  }

  if (index < 0 || index >= arrayRef.length) {
    if (typeof process !== "undefined" && process.env &&
        process.env.JVM_DEBUG_ARRAY_OOB === "1") {
      console.error("[array-store-oob]", JSON.stringify({
        owner: diagnosticScalar(frame.className),
        method: `${frame.method && frame.method.name}${frame.method && frame.method.descriptor || ""}`,
        pc: frame.pc - 1,
        index: diagnosticScalar(index),
        length: arrayRef.length,
        locals: (frame.locals || []).map(diagnosticScalar),
      }));
    }
    throw {
      type: "java/lang/ArrayIndexOutOfBoundsException",
      message: `Index ${index} out of bounds for length ${arrayRef.length}`,
    };
  }

  const narrowed = normalizeArrayStore(value, kind, arrayRef);
  if (arrayRef.elements) arrayRef.elements[index] = narrowed;
  else arrayRef[index] = narrowed;
}

module.exports = {
  classInitializationTokenFor,
  _aload,
  _astore,
  normalizeArrayLoad,
  normalizeArrayStore,
};
