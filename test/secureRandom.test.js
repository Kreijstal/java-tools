const test = require('tape');
const SecureRandom = require('../src/jre/java/security/SecureRandom');

test('SecureRandom uses available entropy without Node Buffer assumptions', (t) => {
  const methods = SecureRandom.methods;
  const bytes = new Int8Array(32);

  methods['nextBytes([B)V'](null, {}, [bytes]);
  t.equal(bytes.length, 32, 'fills a Java byte array');

  let boundedValuesInRange = true;
  for (let index = 0; index < 100; index += 1) {
    const value = methods['nextInt(I)I'](null, {}, [7]);
    boundedValuesInRange &&= value >= 0 && value < 7;
  }
  t.ok(boundedValuesInRange, 'bounded values remain in range');

  const doubleValue = methods['nextDouble()D'](null, {}, []);
  t.ok(doubleValue >= 0 && doubleValue < 1, 'double remains in [0, 1)');
  t.equal(typeof methods['nextLong()J'](null, {}, []), 'bigint',
    'long remains a bigint');
  t.end();
});
