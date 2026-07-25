'use strict';

const test = require('tape');
const Stack = require('../src/core/stack');
const objectInstructions = require('../src/instructions/object');
const loads = require('../src/instructions/loads');
const stores = require('../src/instructions/stores');

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
  t.throws(
    () => objectInstructions.getfield(frameWith(undefined), field, {}),
    isJavaNullPointerException,
    'an absent internal reference cannot leak a host TypeError from getfield',
  );
  t.throws(
    () => objectInstructions.putfield(frameWith(undefined, 1), field, {}),
    isJavaNullPointerException,
    'an absent internal reference cannot leak a host TypeError from putfield',
  );
  const synthetic = { type: 'Owner' };
  objectInstructions.putfield(frameWith(synthetic, 7), field, { classes: {} });
  t.equal(synthetic.fields['Owner.value'], 7,
    'synthetic Java objects lazily acquire field storage');
  t.end();
});

test('primitive array opcodes apply JVM load and store narrowing', (t) => {
  const bytes = [255];
  bytes.type = '[B';
  const booleans = [2];
  booleans.type = '[Z';
  const chars = [-1];
  chars.type = '[C';
  const shorts = [65535];
  shorts.type = '[S';

  const byteLoad = frameWith(bytes, 0);
  loads.baload(byteLoad);
  t.equal(byteLoad.stack.pop(), -1, 'baload sign-extends host byte values');
  const booleanLoad = frameWith(booleans, 0);
  loads.baload(booleanLoad);
  t.equal(booleanLoad.stack.pop(), 1, 'baload normalizes boolean arrays');
  const charLoad = frameWith(chars, 0);
  loads.caload(charLoad);
  t.equal(charLoad.stack.pop(), 65535, 'caload zero-extends char values');
  const shortLoad = frameWith(shorts, 0);
  loads.saload(shortLoad);
  t.equal(shortLoad.stack.pop(), -1, 'saload sign-extends short values');

  stores.bastore(frameWith(bytes, 0, 255));
  stores.bastore(frameWith(booleans, 0, 2));
  stores.castore(frameWith(chars, 0, -1));
  stores.sastore(frameWith(shorts, 0, 65535));
  t.equal(bytes[0], -1, 'bastore narrows to signed byte');
  t.equal(booleans[0], 0, 'bastore retains the low bit for boolean arrays');
  t.equal(chars[0], 65535, 'castore narrows to unsigned char');
  t.equal(shorts[0], -1, 'sastore narrows to signed short');
  t.end();
});
