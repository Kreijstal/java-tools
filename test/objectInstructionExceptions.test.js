'use strict';

const test = require('tape');
const Stack = require('../src/core/stack');
const objectInstructions = require('../src/instructions/object');

function frameWith(...values) {
  const stack = new Stack();
  values.forEach((value) => stack.push(value));
  return { stack };
}

function isJavaNullPointerException(error) {
  return error && error.type === 'java/lang/NullPointerException';
}

test('null field receivers throw catchable Java exceptions', (t) => {
  const field = { arg: ['Field', 'Owner', ['value', 'I']] };
  t.throws(
    () => objectInstructions.getfield(frameWith(null), field, {}),
    isJavaNullPointerException,
    'getfield throws java/lang/NullPointerException',
  );
  t.throws(
    () => objectInstructions.putfield(frameWith(null, 1), field, {}),
    isJavaNullPointerException,
    'putfield throws java/lang/NullPointerException',
  );
  t.end();
});
