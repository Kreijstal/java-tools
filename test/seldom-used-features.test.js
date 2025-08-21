const test = require('tape');
const { runTest } = require('./test-helpers');

const SELDOM_USED_FEATURE_TESTS = [
  {
    name: 'MethodHandlesTest',
    description: 'MethodHandles and MethodType - should fail gracefully',
    shouldFail: true
  },
  {
    name: 'AnnotationReflectionTest',
    description: 'Annotation processing with reflection - should fail gracefully',
    shouldFail: true
  },
  {
    name: 'TryWithResourcesTest',
    description: 'Try-with-resources and suppressed exceptions - should fail gracefully',
    shouldFail: true
  },
  {
    name: 'MultiCatchTest',
    description: 'Multi-catch exception handling - should pass',
    shouldFail: false
  },
  {
    name: 'VarargsGenericTest',
    description: 'Varargs with generic types - should pass',
    shouldFail: false
  },
  {
    name: 'StaticInitializationTest',
    description: 'Static initialization block ordering - should pass',
    shouldFail: false
  },
  {
    name: 'JaggedArrayTest',
    description: 'Jagged (non-rectangular) multi-dimensional arrays - should pass',
    shouldFail: false
  }
];

test('Seldom-used Java Features', async function(t) {
  for (const testCase of SELDOM_USED_FEATURE_TESTS) {
    await runTest(testCase.name, undefined, t, { shouldFail: testCase.shouldFail });
  }
  t.end();
});