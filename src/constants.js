const ASYNC_METHOD_SENTINEL = Symbol("ASYNC_METHOD_SENTINEL");

const primitiveTypeDescriptors = {
  B: "byte",
  C: "char",
  D: "double",
  F: "float",
  I: "int",
  J: "long",
  S: "short",
  Z: "boolean",
  V: "void",
};

const primitiveTypeNameToDescriptor = Object.fromEntries(
  Object.entries(primitiveTypeDescriptors).map(([descriptor, name]) => [
    name,
    descriptor,
  ]),
);

module.exports = {
  ASYNC_METHOD_SENTINEL,
  primitiveTypeDescriptors,
  primitiveTypeNameToDescriptor,
};
