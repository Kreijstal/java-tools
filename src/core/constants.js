const ASYNC_METHOD_SENTINEL = Symbol('ASYNC_METHOD_SENTINEL');
// Slot on Frame objects holding a suspended structured-SSA generator. Declared
// here (not in the renderer) so Frame can pre-declare it in its constructor.
const STRUCTURED_CONTINUATION = Symbol('jvm.structuredSsaContinuation');

const primitiveTypeDescriptors = {
  B: "byte",
  C: "char",
  D: "double",
  F: "float",
  I: "int",
  J: "long",
  S: "short",
  Z: "boolean",
  V: "void"
};

const arrayPrimitiveTypeDescriptors = { ...primitiveTypeDescriptors };
delete arrayPrimitiveTypeDescriptors.V;

module.exports = {
  ASYNC_METHOD_SENTINEL,
  STRUCTURED_CONTINUATION,
  primitiveTypeDescriptors,
  arrayPrimitiveTypeDescriptors,
};
