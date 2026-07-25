const test = require('tape');
const { JVM } = require('../src/core/jvm');

test('concurrent class requests share one load and one static-field map', async (t) => {
  const jvm = new JVM({ classpath: ['fixture.jar'] });
  let loadCalls = 0;
  let finishLoad;
  const loadGate = new Promise((resolve) => {
    finishLoad = resolve;
  });
  const classData = {
    ast: {
      classes: [{
        className: 'race/Owner',
        superClassName: 'java/lang/Object',
        items: [],
      }],
    },
    staticFields: new Map([['d:I', 65]]),
  };

  jvm.loadClassFromJar = async (_classpath, className) => {
    loadCalls += 1;
    t.equal(className, 'race/Owner', 'class names are normalized before loading');
    await loadGate;
    return classData;
  };

  const slashRequest = jvm.loadClassByName('race/Owner');
  const dottedRequest = jvm.loadClassByName('race.Owner');
  finishLoad();
  const [slashResult, dottedResult] = await Promise.all([
    slashRequest,
    dottedRequest,
  ]);

  t.equal(loadCalls, 1, 'only one archive load runs');
  t.equal(slashResult, classData, 'first request receives the loaded class');
  t.equal(dottedResult, classData, 'concurrent request receives the same class');
  t.equal(jvm.classes['race/Owner'], classData,
    'the registry retains the single loaded class');
  t.equal(jvm.classes['race/Owner'].staticFields.get('d:I'), 65,
    'the initialized static-field map is not replaced');
  t.equal(jvm.classEpoch, 1, 'the class is registered once');
  t.equal(jvm.classLoadPromises.size, 0, 'the completed load is removed');
  t.end();
});
