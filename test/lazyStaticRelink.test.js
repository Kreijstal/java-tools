const test = require('tape');
const {JVM} = require('../src/core/jvm');

// Static reads in a method that main() calls before and after the owners'
// initializers run, and after main() replaces their values.
test('static initializers run at first active use and later static writes are observed', async t => {
  const {makeJavaFixtureCompiler} = require('./javaFixture');
  const compile = makeJavaFixtureCompiler('static-variant-');
  const directory = compile(t, 'StaticVariantMain', `
class InitTrace { static int value; }
class LeftStorage {
  static int[] data = new int[]{7, 9};
  static { InitTrace.value = InitTrace.value * 10 + 1; }
}
class RightStorage {
  static int scale = 3;
  static { InitTrace.value = InitTrace.value * 10 + 2; }
}
class ConditionalReader {
  static int read(boolean enabled) {
    if (!enabled) return 41;
    int sum = 0;
    for (int i=0; i<LeftStorage.data.length; i++)
      sum += LeftStorage.data[i] * RightStorage.scale;
    return sum;
  }
}
public class StaticVariantMain {
  static int cold, traceBefore, first, second, traceAfter;
  public static void main(String[] args) throws Exception {
    cold=ConditionalReader.read(false); traceBefore=InitTrace.value;
    first=ConditionalReader.read(true);
    Thread.sleep(1);
    LeftStorage.data = new int[]{2, 5}; RightStorage.scale = 4;
    second=ConditionalReader.read(true); traceAfter=InitTrace.value;
  }
}`);
  const jvm = new JVM({classpath: directory});
  await jvm.run('StaticVariantMain');
  const fields = jvm.classes.StaticVariantMain.staticFields;
  t.equal(fields.get('cold:I'), 41, 'untaken cold branch returns normally');
  t.equal(fields.get('traceBefore:I'), 0, 'neither initializer ran before its first active use');
  t.equal(fields.get('first:I'), 48, 'initializers run before the first actual static read');
  t.equal(fields.get('second:I'), 28, 'later reads see the replaced array and the rewritten scalar');
  t.equal(fields.get('traceAfter:I'), 12, 'initializers ran once in Java access order');
  t.end();
});

test('a JRE static (System.out) read is initialized before use, cold branch or not', async t => {
  const compile=require('./javaFixture').makeJavaFixtureCompiler('static-jre-variant-');
  const classpath=compile(t,'JreStaticVariant',`
public class JreStaticVariant {
  static int cold, warm;
  static int check(boolean enabled) {
    if(!enabled) return 7;
    return System.out == null ? -1 : 11;
  }
  public static void main(String[] args) throws Exception {
    cold=check(false); warm=check(true); Thread.sleep(1); warm+=check(true);
  }
}`);
  const j=new JVM({classpath});
  await j.run('JreStaticVariant');
  t.equal(j.classes.JreStaticVariant.staticFields.get('cold:I'),7,'the branch without the JRE static read returns normally');
  t.equal(j.classes.JreStaticVariant.staticFields.get('warm:I'),22,'System.out is non-null on both reads');
  t.end();
});
