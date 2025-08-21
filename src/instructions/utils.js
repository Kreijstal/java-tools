function _aload(frame) {
  const index = frame.stack.pop();
  const arrayRef = frame.stack.pop();

  if (arrayRef === null) {
    throw {
      type: "java/lang/NullPointerException",
      message: "",
    };
  }

  if (index < 0 || index >= arrayRef.length) {
    throw {
      type: "java/lang/ArrayIndexOutOfBoundsException",
      message: `Index ${index} out of bounds for length ${arrayRef.length}`,
    };
  }

  const value = arrayRef.elements ? arrayRef.elements[index] : arrayRef[index];
  frame.stack.push(value);
}

function _astore(frame) {
  const value = frame.stack.pop();
  const index = frame.stack.pop();
  const arrayRef = frame.stack.pop();

  if (arrayRef === null) {
    throw {
      type: "java/lang/NullPointerException",
      message: "",
    };
  }

  if (index < 0 || index >= arrayRef.length) {
    throw {
      type: "java/lang/ArrayIndexOutOfBoundsException",
      message: `Index ${index} out of bounds for length ${arrayRef.length}`,
    };
  }

  arrayRef[index] = value;
}

module.exports = {
  _aload,
  _astore,
};
