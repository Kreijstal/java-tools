'use strict';

function unboxReflectiveArgument(parameterType, value) {
  const boxedValue = value && typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, 'value')
    ? value.value : value;
  switch (parameterType) {
    case 'boolean': return boxedValue ? 1 : 0;
    case 'byte':
    case 'short':
    case 'char':
    case 'int':
      return Number(boxedValue) | 0;
    case 'long':
      return typeof boxedValue === 'bigint'
        ? boxedValue : BigInt(Math.trunc(Number(boxedValue)));
    case 'float':
    case 'double':
      return Number(boxedValue);
    default:
      return value;
  }
}

function assignReflectiveArguments(locals, args, params, startIndex) {
  let localIndex = startIndex;
  for (let index = 0; index < args.length; index += 1) {
    locals[localIndex] = unboxReflectiveArgument(params[index], args[index]);
    localIndex += params[index] === 'long' || params[index] === 'double'
      ? 2 : 1;
  }
}

module.exports = {
  assignReflectiveArguments,
  unboxReflectiveArgument,
};
