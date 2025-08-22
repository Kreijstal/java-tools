const ASYNC_METHOD_SENTINEL = Symbol('ASYNC_METHOD_SENTINEL');

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
  primitiveTypeDescriptors,
  arrayPrimitiveTypeDescriptors,
};
