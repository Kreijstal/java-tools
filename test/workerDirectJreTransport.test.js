const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('worker-direct-jre-');

const SOURCE = `
public class ProtectedMath {
  static int score(int x) {
    try { return (int)Math.pow(2.0, x); }
    catch (RuntimeException e) { return -1; }
  }
  public static void main(String[] args) { System.out.println(score(5)); }
}`;

function makeJvm(classpath) {
  const jvm = new JVM({classpath});
  jvm.jre = {...jvm.jre,
    'java/lang/Math': {...jvm.jre['java/lang/Math'], methods: {...jvm.jre['java/lang/Math'].methods}},
    'java/io/PrintStream': {...jvm.jre['java/io/PrintStream'], methods: {...jvm.jre['java/io/PrintStream'].methods}},
  };
  const out = {text: ''};
  jvm.registerJreMethods({'java/io/PrintStream': {
    'println(I)V': (_jvm, _receiver, args) => { out.text += args[0] + ','; },
  }});
  return {jvm, out};
}

test('a Math.pow call inside try returns its value', async t => {
  const classpath = compileFixture(t, 'ProtectedMath', SOURCE);
  const {jvm, out} = makeJvm(classpath);
  await jvm.run('ProtectedMath');
  t.equal(out.text, '32,', 'intrinsic return preserves the result');
  t.end();
});

test('a replaced Math.pow that throws reaches the Java catch handler', async t => {
  const classpath = compileFixture(t, 'ProtectedMath', SOURCE);
  const {jvm, out} = makeJvm(classpath);
  let calls = 0;
  jvm.registerJreOverrides({'java/lang/Math': {methods: {
    'pow(DD)D': () => { calls++; throw {type: 'java/lang/RuntimeException'}; },
  }}});
  await jvm.run('ProtectedMath');
  t.equal(out.text, '-1,', 'replacement exception reaches the Java handler');
  t.equal(calls, 1, 'the replaced native is invoked exactly once');
  t.end();
});
