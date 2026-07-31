const test = require('tape');
const babel = require('@babel/core');
const browserBabel = require('../config/browser-babel');
const webpackConfigs = require('../webpack.config');

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

test('browser bundle provides the Node os methods used by the JRE', (t) => {
  const browserConfig = webpackConfigs[0];
  const browserOs = require(browserConfig.resolve.alias.os);

  t.equal(typeof browserOs.type, 'function', 'os.type is available');
  t.equal(typeof browserOs.arch, 'function', 'os.arch is available');
  t.equal(typeof browserOs.release, 'function', 'os.release is available');
  t.equal(typeof browserOs.cpus, 'function', 'os.cpus is available');
  t.ok(browserOs.cpus().length >= 1, 'at least one browser CPU is reported');
  t.end();
});
