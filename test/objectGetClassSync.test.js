const test = require('tape');
const {JVM} = require('../src/core/jvm');
const getClass = require('../src/jre/java/lang/Object').methods['getClass()Ljava/lang/Class;'];

test('Object.getClass returns the loaded mirror synchronously without initializing it', async t => {
  const jvm = new JVM({jit: {compileWorker: false}});
  const data = {ast: {classes: [{className: 'Loaded', items: []}]}, initialized: false};
  jvm.classes.Loaded = data;
  const mirror = getClass(jvm, {_className: 'Loaded'}, []);
  t.equal(mirror, jvm.getClassObjectSync('Loaded'), 'preserves canonical Class identity');
  t.notOk(mirror && typeof mirror.then === 'function', 'loaded lookup does not allocate a Promise');
  t.equal(data.initialized, false, 'lookup does not initialize the represented class');
  t.equal(getClass(jvm, {type: 'Loaded'}, []), mirror, 'legacy receiver type is supported');
  const linked = jvm.jit.resolveSynchronousJreMethod('java/lang/Object', 'java/lang/Object',
    'getClass', '()Ljava/lang/Class;');
  t.equal(typeof linked, 'function', 'compiled calls admit the synchronous shim');
  t.equal(linked(jvm, {_className: 'Loaded'}, []), mirror,
    'linked shim also returns the canonical mirror synchronously');
  t.end();
});

test('Object.getClass keeps the asynchronous cold-mirror path', async t => {
  const mirror = {type: 'java/lang/Class'};
  let requested;
  const jvm = {
    getClassObjectSync: () => null,
    getClassObject: async name => { requested = name; return mirror; },
  };
  const result = getClass(jvm, {type: '[I'}, []);
  t.equal(typeof result.then, 'function', 'cold lookup retains asynchronous resolution');
  t.equal(await result, mirror, 'resolved mirror is returned');
  t.equal(requested, '[I', 'array descriptors are passed through unchanged');
  t.end();
});
