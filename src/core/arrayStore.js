'use strict';
// aastore and System.arraycopy store into a reference array only values the
// array's runtime element type accepts (arrays are covariant: an Object[]
// variable may hold a String[]); anything else is ArrayStoreException.

function runtimeClassOf(value) {
  if (typeof value === 'string' || value instanceof String) return 'java/lang/String';
  return value && (value._className || value.type) || null;
}

function javaName(className) {
  return className ? className.replace(/\//g, '.') : 'java.lang.Object';
}

// The element class as an internal name ('Sprite', '[I'). multianewarray
// rows record the descriptor form ('LSprite;'), other arrays the internal
// name.
function elementTypeOf(array) {
  const recorded = array.elementType;
  if (typeof recorded === 'string') {
    return recorded[0] === 'L' && recorded[recorded.length - 1] === ';' ? recorded.slice(1, -1) : recorded;
  }
  if (recorded !== undefined) return recorded;
  const type = array.type;
  if (typeof type !== 'string' || type[0] !== '[') return undefined;
  if (type[1] === 'L') return type.slice(2, -1);
  return type[1] === '[' ? type.slice(1) : undefined;
}

// True when `array` (a reference array) can hold `value`.
function arrayStoreOk(jvm, array, value) {
  if (value === null || value === undefined) return true;
  const element = elementTypeOf(array);
  if (element === undefined || element === 'java/lang/Object') return true;
  const valueClass = runtimeClassOf(value);
  if (valueClass === element) return true;
  if (!valueClass) return true;
  const cache = jvm._arrayStoreCache || (jvm._arrayStoreCache = new Map());
  const key = `${element}\0${valueClass}`;
  let ok = cache.get(key);
  if (ok === undefined) {
    ok = !!jvm.isInstanceOf(valueClass, element);
    cache.set(key, ok);
  }
  return ok;
}

function checkArrayStore(jvm, array, value) {
  if (!arrayStoreOk(jvm, array, value)) {
    throw { type: 'java/lang/ArrayStoreException', message: jvm.internString(javaName(runtimeClassOf(value))) };
  }
}

module.exports = { arrayStoreOk, checkArrayStore, runtimeClassOf, elementTypeOf };
