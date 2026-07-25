const test = require('tape');
const babel = require('@babel/core');
const browserBabel = require('../config/browser-babel');

test('browser Babel target preserves AsyncFunction for generated JIT bodies', async (t) => {
  const source = `
    function getAsyncFunctionConstructor() {
      return Object.getPrototypeOf(async function generatedProbe() {}).constructor;
    }
    module.exports = getAsyncFunctionConstructor;
  `;
  const transformed = babel.transformSync(source, browserBabel).code;
  const fixtureModule = { exports: {} };
  new Function('module', transformed)(fixtureModule);

  const AsyncFunction = fixtureModule.exports();
  t.equal(AsyncFunction.name, 'AsyncFunction',
    'production Babel settings retain the native async constructor');

  const generated = new AsyncFunction('return await Promise.resolve(42);');
  t.equal(await generated(), 42,
    'generated JIT bodies may contain await');
  t.end();
});
