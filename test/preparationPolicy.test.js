const test = require('tape');
const {applyPreparationPolicy} = require('../src/jit/PreparationPolicy');

test('preparation prioritizes exact methods with stable fallback ordering', t => {
  const methods = ['cold', 'draw', 'load'].map(name => ({className: 'A', method: {name, descriptor: '()V'}}));
  t.deepEqual(applyPreparationPolicy(methods), methods);
  t.deepEqual(applyPreparationPolicy(methods, {
    priorityMethods: ['A.load()V', 'A.draw()V'], maxMethods: 2,
  }).map(entry => entry.method.name), ['load', 'draw']);
  t.equal(methods[0].method.name, 'cold', 'input and bytecode remain untouched');
  t.deepEqual(applyPreparationPolicy(methods, {maxMethods: 0}), [], 'explicit demand-only preparation');
  t.throws(() => applyPreparationPolicy(methods, {maxMethods: -1}), RangeError);
  t.throws(() => applyPreparationPolicy(methods, {priorityMethods: [null]}), TypeError);
  t.end();
});
