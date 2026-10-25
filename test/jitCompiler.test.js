const test = require('tape');
const { makeJavaFixtureCompiler } = require('./javaFixture');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const awt = require('../src/platform/awt');
const { readField, writeField } = require('../src/core/objectModel');

const compileJavaFixture = makeJavaFixtureCompiler('jit-fixture-');
async function invoke(jvm, thread, className, methodName, descriptor, locals) {
  const method = await jvm.findMethodInHierarchy(className, methodName, descriptor);
  const frame = new Frame(method);
  frame.className = className;
  locals.forEach((value, index) => {
    frame.locals[index] = value;
  });
  const before = thread.callStack.size();
  thread.callStack.push(frame);
  let ticks = 0;
  while (thread.callStack.size() > before) {
    const result = await jvm.executeTick();
    ticks += 1;
    if (result.completed) break;
    if (ticks > 50000000) throw new Error('tick limit');
  }
  return ticks;
}

function attachThread(jvm, name = 'jit-test') {
  const thread = {
    id: 0, name, callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return thread;
}

async function createPyramidHarness(jitOptions) {
  const jvm = new JVM({ classpath: 'sources', jit: jitOptions });
  await jvm.loadClassByName('PyramidApplet');
  const thread = attachThread(jvm);
  const applet = await jvm.createAppletInstance('PyramidApplet');
  await invoke(jvm, thread, 'PyramidApplet', '<init>', '()V', [applet]);
  jvm._jreFindMethod('java/awt/Component', 'setSize', '(II)V')(jvm, applet, [800, 600]);
  await invoke(jvm, thread, 'PyramidApplet', 'init', '()V', [applet]);
  return { jvm, thread, applet };
}

function typedArray(type, values) {
  const array = values.slice();
  array.type = type;
  return array;
}

test('reference-field cursor helpers update links and static effects', async (t) => {
  const classpath = compileJavaFixture(t, 'ReferenceCursorHarness', `
public class ReferenceCursorHarness {
  static int diagnostic;
  ReferenceCursorHarness head;
  ReferenceCursorHarness cursor;
  ReferenceCursorHarness step(int mode) {
    if (mode != 1) return null;
    ReferenceCursorHarness value = cursor;
    if (value == head) {
      cursor = null;
      return null;
    }
    cursor = value.cursor;
    if (mode != 0) diagnostic = -122;
    return value;
  }
  void unlink(boolean keep) {
    if (keep || cursor == null) return;
    cursor.cursor = null;
    cursor = null;
  }
  void clear(int mode) {
    head = null;
    cursor = null;
    if (mode != 0) diagnostic = 41;
  }
}
`);
  const jvm = new JVM({classpath});
  const classData = await jvm.loadClassByName('ReferenceCursorHarness');
  classData.staticFieldsInitialized = true;
  classData.staticFields.set('diagnostic:I', 0);
  jvm.classInitializationState.set('ReferenceCursorHarness', 'INITIALIZED');
  const tail = {type: 'ReferenceCursorHarness', fields: {
    'ReferenceCursorHarness.cursor': null,
  }};
  const value = {type: 'ReferenceCursorHarness', fields: {
    'ReferenceCursorHarness.cursor': tail,
  }};
  const head = {type: 'ReferenceCursorHarness', fields: {}};
  const receiver = {type: 'ReferenceCursorHarness', fields: {
    'ReferenceCursorHarness.head': head,
    'ReferenceCursorHarness.cursor': value,
  }};
  const thread = attachThread(jvm, 'reference-cursor');
  await invoke(jvm, thread, 'ReferenceCursorHarness', 'step',
    '(I)LReferenceCursorHarness;', [receiver, 1]);
  t.equal(readField(receiver.fields, 'ReferenceCursorHarness.cursor'), tail,
    'step advances the reference link');
  t.equal(classData.staticFields.get('diagnostic:I'), -122,
    'step preserves its primitive static side effect');
  writeField(receiver.fields, 'ReferenceCursorHarness.cursor', value);
  writeField(value.fields, 'ReferenceCursorHarness.cursor', tail);
  await invoke(jvm, thread, 'ReferenceCursorHarness', 'unlink', '(Z)V',
    [receiver, 0]);
  t.equal(readField(receiver.fields, 'ReferenceCursorHarness.cursor'), null,
    'unlink clears the receiver link');
  t.equal(readField(value.fields, 'ReferenceCursorHarness.cursor'), null,
    'unlink clears the nested link');
  writeField(receiver.fields, 'ReferenceCursorHarness.head', head);
  writeField(receiver.fields, 'ReferenceCursorHarness.cursor', value);
  await invoke(jvm, thread, 'ReferenceCursorHarness', 'clear', '(I)V',
    [receiver, 1]);
  t.equal(readField(receiver.fields, 'ReferenceCursorHarness.head'), null,
    'clear clears its first reference field');
  t.equal(readField(receiver.fields, 'ReferenceCursorHarness.cursor'), null,
    'clear clears its second reference field');
  t.equal(classData.staticFields.get('diagnostic:I'), 41,
    'clear preserves its primitive static side effect');
  t.end();
});

test('byte, boolean and float array loops preserve Java narrowing', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredByteArrays', `
public class StructuredByteArrays {
  static void sumInto(byte[] values, int[] out) {
    int sum = 0;
    for (int i = 0; i < values.length; i++) sum += values[i];
    out[0] = sum;
  }
  static void fill(byte[] values, int value) {
    for (int i = 0; i < values.length; i++) values[i] = (byte)value;
  }
  static void fillFloats(float[] values, float value) {
    for (int i = 0; i < values.length; i++) values[i] = value;
  }
  static void countTrue(boolean[] values, int[] out) {
    int count = 0;
    for (int i = 0; i < values.length; i++) if (values[i]) count++;
    out[0] = count;
  }
  static void fillBooleans(boolean[] values, int value) {
    for (int i = 0; i < values.length; i++) values[i] = value != 0;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('StructuredByteArrays');
  jvm.classInitializationState.set('StructuredByteArrays', 'INITIALIZED');
  const thread = attachThread(jvm, 'structured-byte-arrays');

  const input = typedArray('[B', [255, 128, 127]);
  const sum = typedArray('[I', [0]);
  await invoke(jvm, thread, 'StructuredByteArrays', 'sumInto', '([B[I)V', [input, sum]);
  t.equal(sum[0], -2, 'baload sign-extends bytes');
  sum[0] = 0;
  await invoke(jvm, thread, 'StructuredByteArrays', 'sumInto', '([B[I)V', [input, sum]);
  t.equal(sum[0], -2, 'a repeated call keeps byte-load semantics');

  const output = typedArray('[B', [0, 0, 0]);
  await invoke(jvm, thread, 'StructuredByteArrays', 'fill', '([BI)V', [output, 255]);
  t.deepEqual(output.slice(), [-1, -1, -1], 'bastore narrows values to signed bytes');

  const booleans = typedArray('[Z', [0, 1, 2, 0]);
  const trueCount = typedArray('[I', [0]);
  await invoke(jvm, thread, 'StructuredByteArrays', 'countTrue', '([Z[I)V',
    [booleans, trueCount]);
  t.equal(trueCount[0], 2, 'boolean baload treats every nonzero element as true');
  await invoke(jvm, thread, 'StructuredByteArrays', 'fillBooleans', '([ZI)V',
    [booleans, 0]);
  t.deepEqual(booleans.slice(), [0, 0, 0, 0],
    'boolean bastore preserves zero/one normalization');
  const floats = typedArray('[F', [0, 0, 0]);
  await invoke(jvm, thread, 'StructuredByteArrays',
    'fillFloats', '([FF)V', [floats, 1 / 3]);
  t.deepEqual(floats.slice(), new Array(3).fill(Math.fround(1 / 3)),
    'fastore preserves Java float32 narrowing');
  t.end();
});

test('array conversion loops saturate, narrow and resume the enclosing handler', async (t) => {
  const classpath = compileJavaFixture(t, 'InlineArrayRegionHarness', `
public class InlineArrayRegionHarness {
  static int touches;
  static int result;
  static void touch() { touches++; }
  static void convert(int[] mixed, byte[] pcm, int hash) {
    touch();
    try {
      for (int frame = 0; frame < mixed.length; frame++) {
        int sample = mixed[frame] >> 8;
        if (sample < -32768) sample = -32768;
        if (sample > 32767) sample = 32767;
        int offset = frame * 2;
        pcm[offset] = (byte) sample;
        pcm[offset + 1] = (byte) (sample >> 8);
        hash = hash * 31 + pcm[offset];
        hash = hash * 31 + pcm[offset + 1];
      }
      touch();
      result = hash;
    } catch (ArrayIndexOutOfBoundsException exception) {
      result = -77;
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('InlineArrayRegionHarness');
  jvm.classInitializationState.set('InlineArrayRegionHarness', 'INITIALIZED');
  const fields = jvm.classes.InlineArrayRegionHarness.staticFields;
  fields.set('touches:I', 0);
  fields.set('result:I', 0);
  const thread = attachThread(jvm, 'inline-array-region');
  const mixed = typedArray('[I', [0x123400, -0x123400, 0x7fffffff, -0x80000000]);
  const pcm = typedArray('[B', new Array(8).fill(0));

  await invoke(jvm, thread, 'InlineArrayRegionHarness',
    'convert', '([I[BI)V', [mixed, pcm, 17]);
  t.deepEqual(pcm.slice(), [52, 18, -52, -19, -1, 127, 0, -128],
    'stores preserve signed byte narrowing and saturation');
  const expectedHash = pcm.reduce((hash, value) =>
    (Math.imul(hash, 31) + value) | 0, 17);
  t.equal(fields.get('result:I'), expectedHash, 'the loop hash is stored');
  t.equal(fields.get('touches:I'), 2,
    'calls before and after the loop retain their effects');

  const shortPcm = typedArray('[B', new Array(2).fill(0));
  await invoke(jvm, thread, 'InlineArrayRegionHarness',
    'convert', '([I[BI)V', [mixed, shortPcm, 17]);
  t.equal(fields.get('result:I'), -77,
    'an array exception resumes in the surrounding handler');
  t.end();
});

test('class literals in loops preserve identity without initializing the target', async (t) => {
  const classpath = compileJavaFixture(t, 'ClassLiteralLoopHarness', `
class ArbitraryLiteralTarget {
  static int initialized;
  static { initialized = 1; }
}
public class ClassLiteralLoopHarness {
  static Class<?> seen;
  static int visit(int count) {
    int value = 0;
    for (int index = 0; index < count; index++) value += index;
    seen = ArbitraryLiteralTarget.class;
    return value;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('ClassLiteralLoopHarness');
  jvm.classInitializationState.set('ClassLiteralLoopHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'class-literal-loop');
  await invoke(jvm, thread, 'ClassLiteralLoopHarness', 'visit', '(I)I', [8]);
  const fields = jvm.classes.ClassLiteralLoopHarness.staticFields;
  const classObject = fields.get('seen:Ljava/lang/Class;');
  t.equal(classObject, jvm.getClassObjectSync('ArbitraryLiteralTarget'),
    'the class literal is the loaded Class object');
  t.notEqual(
    jvm.classInitializationState.get('ArbitraryLiteralTarget'), 'INITIALIZED',
    'resolving the class literal does not initialize its target');
  fields.set('seen:Ljava/lang/Class;', null);
  await invoke(jvm, thread, 'ClassLiteralLoopHarness', 'visit', '(I)I', [8]);
  t.equal(fields.get('seen:Ljava/lang/Class;'), classObject,
    'a repeated call yields the same Class identity');
  t.end();
});

test('array casts inside loops preserve copied values', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredCastHarness', `
public class StructuredCastHarness {
  static void copy(Object input, int[] output) {
    for (int i = 0; i < output.length; i++) {
      output[i] = ((int[])input)[i];
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('StructuredCastHarness');
  jvm.classInitializationState.set('StructuredCastHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'structured-cast');
  const input = typedArray('[I', [3, 5, 8, 13]);
  const output = typedArray('[I', [0, 0, 0, 0]);
  await invoke(jvm, thread, 'StructuredCastHarness', 'copy',
    '(Ljava/lang/Object;[I)V', [input, output]);
  t.deepEqual(output.slice(), [3, 5, 8, 13], 'the array cast preserves values');
  output.fill(0);
  await invoke(jvm, thread, 'StructuredCastHarness', 'copy',
    '(Ljava/lang/Object;[I)V', [input, output]);
  t.deepEqual(output.slice(), [3, 5, 8, 13], 'a repeated call stays correct');
  t.end();
});

test('constructed readers in array loops decode and resume the guest handler',
  async (t) => {
  const classpath = compileJavaFixture(t, 'ConstructedReaderLoopHarness', `
public final class ConstructedReaderLoopHarness {
  static final class Reader {
    final byte[] bytes;
    int position;

    Reader(byte[] bytes) {
      this.bytes = normalize(bytes);
    }

    private static byte[] normalize(byte[] bytes) {
      return bytes;
    }

    synchronized int read() {
      return bytes[position++] & 255;
    }
  }

  static int decode(byte[] bytes, int[] output) {
    Reader reader = new Reader(bytes);
    int sum = 0;
    try {
      for (int index = 0; index < output.length; index++) {
        int value = reader.read();
        output[index] = value;
        sum += value;
      }
      return sum;
    } catch (ArrayIndexOutOfBoundsException error) {
      output[0] = -7;
      return -1;
    }
  }

  static int repeat(byte[] bytes, int[] output, int passes) {
    int result = 0;
    for (int pass = 0; pass < passes; pass++) result += decode(bytes, output);
    return result;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('ConstructedReaderLoopHarness');
  await jvm.loadClassByName('ConstructedReaderLoopHarness$Reader');
  const thread = attachThread(jvm, 'constructed-reader-loop');
  const bytes = typedArray('[B', [3, 5, 7, 11]);
  const output = typedArray('[I', [0, 0, 0, 0]);
  await invoke(jvm, thread, 'ConstructedReaderLoopHarness',
    'decode', '([B[I)I', [bytes, output]);
  t.deepEqual(Array.from(output), [3, 5, 7, 11],
    'decode writes every value exactly once');
  await invoke(jvm, thread, 'ConstructedReaderLoopHarness',
    'repeat', '([B[II)I', [bytes, output, 8]);
  const shortBytes = typedArray('[B', [9]);
  const exceptionalOutput = typedArray('[I', [0, 0]);
  await invoke(jvm, thread,
    'ConstructedReaderLoopHarness', 'repeat', '([B[II)I',
    [shortBytes, exceptionalOutput, 8]);
  t.deepEqual(Array.from(exceptionalOutput), [-7, 0],
    'a child bounds failure resumes the guest handler');
  t.end();
});

test('primitive-array save/restore helpers round-trip static state', async (t) => {
  const classpath = compileJavaFixture(t, 'ArbitraryArrayStateLeaf', `
public class ArbitraryArrayStateLeaf {
  static int a, b, c, d;
  static void save(int[] out) {
    out[0] = a; out[1] = b; out[2] = c; out[3] = d;
  }
  static void restore(int[] in) {
    a = in[0]; b = in[1]; c = in[2]; d = in[3];
  }
  public static void roundTrip(int[] state) {
    save(state);
    a = b = c = d = 0;
    restore(state);
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('ArbitraryArrayStateLeaf');
  jvm.classInitializationState.set('ArbitraryArrayStateLeaf', 'INITIALIZED');
  const owner = jvm.classes.ArbitraryArrayStateLeaf;
  owner.staticFields.set('a:I', 11);
  owner.staticFields.set('b:I', 22);
  owner.staticFields.set('c:I', 33);
  owner.staticFields.set('d:I', 44);
  const thread = attachThread(jvm, 'short-array-leaf');
  const state = typedArray('[I', [0, 0, 0, 0]);
  await invoke(jvm, thread, 'ArbitraryArrayStateLeaf', 'roundTrip', '([I)V', [state]);
  t.deepEqual(state.slice(), [11, 22, 33, 44], 'save stores every field');
  t.deepEqual([
    owner.staticFields.get('a:I'), owner.staticFields.get('b:I'),
    owner.staticFields.get('c:I'), owner.staticFields.get('d:I'),
  ], [11, 22, 33, 44], 'restore writes every field back');
  t.end();
});

test('conditional static-field helpers apply every taken write', async (t) => {
  const classpath = compileJavaFixture(t, 'ArbitraryConditionalStateLeaf', `
public class ArbitraryConditionalStateLeaf {
  static int left, top, right, bottom;
  static void narrow(int nextLeft, int nextTop, int nextRight, int nextBottom) {
    if (left < nextLeft) left = nextLeft;
    if (top < nextTop) top = nextTop;
    if (right > nextRight) right = nextRight;
    if (bottom > nextBottom) bottom = nextBottom;
  }
  public static void run() {
    narrow(10, 20, 90, 80);
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('ArbitraryConditionalStateLeaf');
  jvm.classInitializationState.set('ArbitraryConditionalStateLeaf', 'INITIALIZED');
  const owner = jvm.classes.ArbitraryConditionalStateLeaf;
  owner.staticFields.set('left:I', 0);
  owner.staticFields.set('top:I', 0);
  owner.staticFields.set('right:I', 100);
  owner.staticFields.set('bottom:I', 100);
  const thread = attachThread(jvm, 'short-conditional-leaf');
  await invoke(jvm, thread, 'ArbitraryConditionalStateLeaf', 'run', '()V', []);
  t.deepEqual([
    owner.staticFields.get('left:I'), owner.staticFields.get('top:I'),
    owner.staticFields.get('right:I'), owner.staticFields.get('bottom:I'),
  ], [10, 20, 90, 80], 'all conditional static writes execute');
  t.end();
});

test('pure JRE intrinsics inside instance-field loops keep the Java result',
  async (t) => {
  const className = 'ArbitraryPureIntrinsicFieldLoop';
  const classpath = compileJavaFixture(t, className, `
public final class ArbitraryPureIntrinsicFieldLoop {
  static int out;
  int stable = 7;

  public int compute(int rounds) {
    int total = 0;
    for (int index = -rounds; index < rounds; index++) {
      total += stable + Math.abs(index);
    }
    return total + stable;
  }

  static void run(int rounds) {
    out = new ArbitraryPureIntrinsicFieldLoop().compute(rounds);
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName(className);
  const thread = attachThread(jvm, 'pure-intrinsic-field-test');
  await invoke(jvm, thread, className, 'run', '(I)V', [4]);
  t.equal(jvm.classes[className].staticFields.get('out:I'), 79,
    'the loop computes the Java result');
  t.end();
});

test('nested raster loops with a helper call fill every pixel', async (t) => {
  const className = 'NestedRasterShape';
  const classpath = compileJavaFixture(t, className, `
public final class NestedRasterShape {
  static int clamp(int value, int maximum) {
    return value < maximum ? value : maximum;
  }

  static void raster(int[] destination, int rows, int columns) {
    for (int row = 0; row < rows; row++) {
      int base = row * columns;
      int limit = clamp(columns, destination.length - base);
      for (int column = 0; column < limit; column++) {
        destination[base + column] = row + column;
      }
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const destination = typedArray('[I', new Array(24).fill(-1));
  const thread = attachThread(jvm, 'nested-raster');
  await invoke(jvm, thread, className, 'raster', '([III)V',
    [destination, 3, 8]);
  t.deepEqual(destination.slice(), [
    0, 1, 2, 3, 4, 5, 6, 7,
    1, 2, 3, 4, 5, 6, 7, 8,
    2, 3, 4, 5, 6, 7, 8, 9,
  ], 'the nested raster result is exact');
  t.end();
});

test('pure integral leaves observe changes to their static dependencies', async (t) => {
  const classpath = compileJavaFixture(t, 'ArbitraryPureIntegralLeaf', `
public class ArbitraryPureIntegralLeaf {
  static boolean alternate;
  static int sideEffects;
  static int observed;

  static byte transform(char value, byte tag) {
    int bias = alternate ? 7 : 3;
    if (value == 101) bias += 1;
    if (value == 102) bias += 2;
    if (value == 103) bias += 3;
    if (value == 104) bias += 4;
    if (value == 105) bias += 5;
    if (value == 106) bias += 6;
    if (value == 107) bias += 7;
    if (value == 108) bias += 8;
    if (value == 109) bias += 9;
    if (value == 110) bias += 10;
    return (byte) (value + tag + bias);
  }

  static byte impure(char value, byte tag) {
    sideEffects++;
    return (byte) (value + tag);
  }

  public static int repeat(int count, char value) {
    int result = 0;
    for (int index = 0; index < count; index++) {
      result += transform(value, (byte) 28);
    }
    return result;
  }

  public static void run(int count, char value) {
    observed = repeat(count, value);
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('ArbitraryPureIntegralLeaf');
  const owner = jvm.classes.ArbitraryPureIntegralLeaf;
  jvm.classInitializationState.set('ArbitraryPureIntegralLeaf', 'INITIALIZED');
  owner.staticFields.set('alternate:Z', 0);
  owner.staticFields.set('sideEffects:I', 0);
  owner.staticFields.set('observed:I', 0);
  const thread = attachThread(jvm, 'memoized-integral-leaf');
  await invoke(jvm, thread, 'ArbitraryPureIntegralLeaf', 'run', '(IC)V', [100, 65]);
  t.equal(owner.staticFields.get('observed:I'), 9600,
    'the first dependency state produces its result');
  owner.staticFields.set('alternate:Z', 1);
  await invoke(jvm, thread, 'ArbitraryPureIntegralLeaf', 'run', '(IC)V', [100, 65]);
  t.equal(owner.staticFields.get('observed:I'), 10000,
    'a changed static dependency changes the result');
  t.equal(owner.staticFields.get('sideEffects:I'), 0,
    'the uncalled impure sibling never runs');
  t.end();
});

test('static array targets are re-read after a call replaces them', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredStaticArrayHarness', `
public class StructuredStaticArrayHarness {
  static int[] pixels;
  static int[] replacement;

  static void swap() {
    pixels = replacement;
  }

  public static void writeAcrossCall() {
    pixels[0] = 1;
    swap();
    pixels[0] = 2;
    for (int i = 1; i < 2; i++) pixels[i] = 3;
  }

  public static void observe(int[] out) {
    int[] original = new int[2];
    int[] next = new int[2];
    pixels = original;
    replacement = next;
    writeAcrossCall();
    out[0] = original[0];
    out[1] = original[1];
    out[2] = next[0];
    out[3] = next[1];
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('StructuredStaticArrayHarness');
  const thread = attachThread(jvm, 'structured-static-array');
  const out = typedArray('[I', [9, 9, 9, 9]);
  await invoke(jvm, thread, 'StructuredStaticArrayHarness', 'observe', '([I)V', [out]);
  t.deepEqual(out.slice(0, 2), [1, 0],
    'stores before the call target the original array');
  t.deepEqual(out.slice(2, 4), [2, 3],
    'stores after the call target the replacement array');
  t.end();
});

// closed-world bug: on Node 24+ (closed-world Wasm module active) host JS
// arrays installed into a class's staticFields map are replaced by copies.
// Guest writes land in the copy, the host arrays stay [0, 0], and
// staticFields.get('pixels:[I') is no longer the host `replacement` array.
// Java-side reads stay consistent (see the test above); host identity does not.
test.skip('host arrays installed in static fields receive guest writes', async (t) => {
  const classpath = compileJavaFixture(t, 'HostStaticArrayHarness', `
public class HostStaticArrayHarness {
  static int[] pixels;
  static int[] replacement;

  static void swap() {
    pixels = replacement;
  }

  public static void writeAcrossCall() {
    pixels[0] = 1;
    swap();
    pixels[0] = 2;
    for (int i = 1; i < 2; i++) pixels[i] = 3;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('HostStaticArrayHarness');
  const owner = jvm.classes.HostStaticArrayHarness;
  jvm.classInitializationState.set('HostStaticArrayHarness', 'INITIALIZED');
  const original = typedArray('[I', [0, 0]);
  const replacement = typedArray('[I', [0, 0]);
  owner.staticFields.set('pixels:[I', original);
  owner.staticFields.set('replacement:[I', replacement);
  const thread = attachThread(jvm, 'host-static-array');
  await invoke(jvm, thread, 'HostStaticArrayHarness', 'writeAcrossCall', '()V', []);
  t.deepEqual(original.slice(), [1, 0],
    'stores before the call target the original host array');
  t.deepEqual(replacement.slice(), [2, 3],
    'stores after the call target the replacement host array');
  t.equal(owner.staticFields.get('pixels:[I'), replacement,
    'the static field holds the host replacement array');
  t.end();
});

test('integer division helpers keep rounding, side effects and ArithmeticException',
  async (t) => {
  const className = 'GuardedIntegerLeafHarness';
  const classpath = compileJavaFixture(t, className, `
public final class GuardedIntegerLeafHarness {
  static int diagnostic;

  static int rounded(int tag, int denominator, int numerator) {
    int sign = numerator >>> 31;
    if (tag != 23841) diagnostic = tag;
    return ((numerator + sign) / denominator) - sign;
  }

  static void fill(int[] destination, int tag, int denominator) {
    for (int index = 0; index < destination.length; index++) {
      destination[index] = rounded(tag, denominator, index - 4);
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  const classData = await jvm.loadClassByName(className);
  classData.staticFieldsInitialized = true;
  classData.staticFields.set('diagnostic:I', 0);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = attachThread(jvm, 'guarded-integer-leaf');

  const valid = typedArray('[I', new Array(8).fill(99));
  await invoke(jvm, thread, className, 'fill', '([III)V',
    [valid, 23841, 3]);
  t.deepEqual(valid.slice(), [-2, -1, -1, -1, 0, 0, 0, 1],
    'signed rounded division results are exact');
  t.equal(classData.staticFields.get('diagnostic:I'), 0,
    'the untaken diagnostic branch has no effect');

  const diagnostic = typedArray('[I', [0, 0]);
  await invoke(jvm, thread, className, 'fill', '([III)V',
    [diagnostic, 17, 2]);
  t.equal(classData.staticFields.get('diagnostic:I'), 17,
    'the taken diagnostic branch writes its static');
  t.deepEqual(diagnostic.slice(), [-2, -2], 'the results for the other tag are exact');

  const arithmetic = typedArray('[I', [73, 73]);
  let thrown = null;
  try {
    await invoke(jvm, thread, className, 'fill', '([III)V',
      [arithmetic, 23841, 0]);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/ArithmeticException',
    'a zero divisor throws ArithmeticException');
  t.deepEqual(arithmetic.slice(), [73, 73],
    'the division fails before the caller stores anything');
  t.end();
});

test('float-to-byte conversion loops preserve Java float conversion', async (t) => {
  const classpath = compileJavaFixture(t, 'FloatByteConversionHarness', `
public class FloatByteConversionHarness {
  static float[] samples(float[] values) { return values; }
  static void convert(float[] values, byte[] output) {
    float[] decoded = samples(values);
    int length = decoded.length;
    if (length > output.length) length = output.length;
    for (int index = 0; index < length; index++) {
      int sample = (int) (128.0f + decoded[index] * 128.0f);
      if ((sample & -256) != 0) sample = ~sample >> 31;
      output[index] = (byte) (sample - 128);
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('FloatByteConversionHarness');
  jvm.classInitializationState.set(
    'FloatByteConversionHarness', 'INITIALIZED');
  const values = typedArray('[F', [0.0, 0.5, -1.0, 2.0, -3.0]);
  const output = new Int8Array(values.length);
  output.type = '[B';
  const thread = attachThread(jvm, 'float-byte-conversion-test');
  await invoke(jvm, thread, 'FloatByteConversionHarness', 'convert',
    '([F[B)V', [values, output]);
  t.deepEqual(Array.from(output), [0, 64, -128, 127, -128],
    'float conversion and byte narrowing are exact');
  t.end();
});

test('nested reference-array call chains count and propagate NullPointerException',
  async (t) => {
  const className = 'ArbitraryCompiledCallChain';
  const classpath = compileJavaFixture(t, className, `
public final class ArbitraryCompiledCallChain {
  static int last;
  static Object identity(Object value) { return value; }

  static int scan(Object[] values, int passes) {
    int count = 0;
    for (int pass = 0; pass < passes; pass++) {
      for (int index = 0; index < values.length; index++) {
        if (identity(values[index]) != null) count++;
      }
    }
    return count;
  }

  static int repeat(Object[] values) {
    int count = 0;
    for (int pass = 0; pass < 8; pass++) count += scan(values, 1);
    last = count;
    return last;
  }

  static int caught(Object[] values) {
    try { return repeat(values); }
    catch (NullPointerException error) { last = -7; return last; }
  }
}
`);
  const jvm = new JVM({ classpath });
  const classData = await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = attachThread(jvm, 'compiled-call-chain');
  const values = typedArray('[Ljava/lang/Object;', [
    { type: 'java/lang/Object', fields: {} }, null,
    { type: 'java/lang/Object', fields: {} }, null,
  ]);
  await invoke(jvm, thread, className, 'repeat',
    '([Ljava/lang/Object;)I', [values]);
  await invoke(jvm, thread, className, 'repeat',
    '([Ljava/lang/Object;)I', [values]);
  t.equal(classData.staticFields.get('last:I'), 16,
    'the nested loops count every non-null element');
  await invoke(jvm, thread, className, 'caught',
    '([Ljava/lang/Object;)I', [null]);
  t.equal(classData.staticFields.get('last:I'), -7,
    'a null array reaches the guest NullPointerException handler');
  t.equal(thread.callStack.size(), 0,
    'exception completion leaves no frame behind');
  t.end();
});

test('consecutive counted loops over one array sum and bounds-check every index',
  async (t) => {
  const className = 'StructuredConsecutiveLoopRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredConsecutiveLoopRangeHarness {
  static int result;
  static int sum(int[] values, int split, int limit) {
    int total = 0;
    int index = 0;
    for (; index < split; index++) total += values[index];
    for (; index < limit; index++) total += values[index];
    return total;
  }
  static void run(int[] values, int split, int limit) {
    result = sum(values, split, limit);
  }
}
`);
  const jvm = new JVM({ classpath });
  const classData = await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = attachThread(jvm, 'consecutive-loops');
  await invoke(jvm, thread, className, 'run', '([III)V',
    [typedArray('[I', [2, 3, 5, 7, 11]), 2, 5]);
  t.equal(classData.staticFields.get('result:I'), 28,
    'both loops load every element');
  let thrown = null;
  try {
    await invoke(jvm, thread, className, 'run', '([III)V',
      [typedArray('[I', [2, 3, 5, 7]), 2, 5]);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'an index past the end in the second loop throws');
  t.end();
});

test('indirect field-array gathers copy values and fail at the bad index',
  async (t) => {
  const className = 'StructuredIndirectFieldArrayHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredIndirectFieldArrayHarness {
  static int result;
  short[] indexes;
  int[] values;
  int[] output;

  static int gather(StructuredIndirectFieldArrayHarness self, int passes) {
    short[] indexes = self.indexes;
    int[] values = self.values;
    int[] output = self.output;
    int checksum = 0;
    for (int pass = 0; pass < passes; pass++) {
      for (int index = 0; index < indexes.length; index++) {
        int value = values[indexes[index]];
        output[index] = value;
        checksum = checksum * 31 + value;
      }
    }
    return checksum;
  }

  static void run(StructuredIndirectFieldArrayHarness self, int passes) {
    result = gather(self, passes);
  }
}
`);
  const jvm = new JVM({ classpath });
  const classData = await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = attachThread(jvm, 'indirect-gather');
  const values = typedArray('[I', [10, 20, 30, 40]);
  const output = typedArray('[I', [0, 0, 0, 0]);
  const receiver = {
    type: className,
    fields: {
      [`${className}.indexes`]: typedArray('[S', [2, 0, 3, 1]),
      [`${className}.values`]: values,
      [`${className}.output`]: output,
    },
  };
  await invoke(jvm, thread, className, 'run', `(L${className};I)V`, [receiver, 3]);
  t.deepEqual(output.slice(), [30, 10, 40, 20], 'the gather copies every indexed value');
  let expected = 0;
  for (let pass = 0; pass < 3; pass++) {
    for (const value of [30, 10, 40, 20]) expected = (Math.imul(expected, 31) + value) | 0;
  }
  t.equal(classData.staticFields.get('result:I'), expected,
    'the checksum matches Java int arithmetic');

  const invalidOutput = typedArray('[I', [0, 0, 0, 0]);
  let thrown = null;
  try {
    await invoke(jvm, thread, className, 'run', `(L${className};I)V`, [{
      type: className,
      fields: {
        [`${className}.indexes`]: typedArray('[S', [2, 9, 3, 1]),
        [`${className}.values`]: values,
        [`${className}.output`]: invalidOutput,
      },
    }, 3]);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'an out-of-range indirect index throws');
  t.deepEqual(invalidOutput.slice(), [30, 0, 0, 0],
    'stores before the bad index are retained');
  t.end();
});

test('field arrays loaded from two receivers keep their own storage',
  async (t) => {
  const className = 'StructuredFieldArrayAliasHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredFieldArrayAliasHarness {
  Object[] values;

  static void compare(StructuredFieldArrayAliasHarness first,
      StructuredFieldArrayAliasHarness second, int[] out) {
    out[0] = first.values[0] == second.values[1] ? 1 : 0;
    out[1] = second.values[1] == null ? -1 : 7;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = attachThread(jvm, 'field-array-alias');
  const shared = { type: 'java/lang/Object', fields: {} };
  const first = {
    type: className,
    fields: { [`${className}.values`]: typedArray('[Ljava/lang/Object;', [shared]) },
  };
  const second = {
    type: className,
    fields: { [`${className}.values`]: typedArray('[Ljava/lang/Object;',
      [{ type: 'java/lang/Object', fields: {} }, shared]) },
  };
  const out = typedArray('[I', [0, 0]);
  await invoke(jvm, thread, className, 'compare',
    `(L${className};L${className};[I)V`, [first, second, out]);
  t.deepEqual(out.slice(), [1, 7],
    'each loaded array keeps the backing storage of its own receiver');
  t.end();
});

test('nested integral helper calls in a loop transform every element',
  async (t) => {
  const className = 'StructuredInlineScopeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredInlineScopeHarness {
  static int mask(int value, int bits) {
    return value & bits;
  }

  static void transform(int[] values) {
    for (int index = 0; index < values.length; index++) {
      int low = mask(values[index], 255);
      values[index] = mask(low, 127);
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = attachThread(jvm, 'inline-scope');
  const values = typedArray('[I', [0x1234, 0x80ff, 0x7f, -1]);
  await invoke(jvm, thread, className, 'transform', '([I)V', [values]);
  t.deepEqual(values.slice(), [0x34, 0x7f, 0x7f, 0x7f],
    'every transformed value is exact');
  t.end();
});

test('bounded nested loops mutate every element and stop at the bad index', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredAtomicHarness', `
public class StructuredAtomicHarness {
  int[] values;
  public void transform() {
    int index = 0;
    for (int y = 0; y < 4; y++) {
      for (int x = 0; x < 8; x++) {
        int old = values[index];
        values[index++] = old + 1;
      }
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('StructuredAtomicHarness');
  jvm.classInitializationState.set('StructuredAtomicHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'structured-atomic-counted-test');
  const values = typedArray('[I', new Array(32).fill(7));
  await invoke(jvm, thread, 'StructuredAtomicHarness', 'transform', '()V', [{
    type: 'StructuredAtomicHarness',
    fields: { 'StructuredAtomicHarness.values': values },
  }]);
  t.deepEqual(values.slice(), new Array(32).fill(8),
    'the nested loop increments every element once');
  const shortValues = typedArray('[I', new Array(5).fill(3));
  let thrown = null;
  try {
    await invoke(jvm, thread, 'StructuredAtomicHarness', 'transform', '()V', [{
      type: 'StructuredAtomicHarness',
      fields: { 'StructuredAtomicHarness.values': shortValues },
    }]);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'a short array throws ArrayIndexOutOfBoundsException');
  t.deepEqual(shortValues.slice(), new Array(5).fill(4),
    'elements before the bad index are incremented exactly once');
  t.end();
});

test('loops over arrays, fields, statics and calls preserve their results', async (t) => {
  const classpath = compileJavaFixture(t, 'ScalarFeatureHarness', `
public class ScalarFeatureHarness {
  static int staticBias = 3;
  static class Box { int[] values; int bias; volatile int changing; }
  static void record(int[] out, int index, int value) { out[index] = value; }
  static int adjust(int value) { return value * 3 + 1; }
  static int branchedAdjust(int value, int threshold) {
    int mixed = (value ^ (value >>> 16)) + 13;
    if (mixed < threshold) mixed = threshold - mixed;
    return (mixed & 255) * 65793;
  }
  static void inlineInto(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = adjust(i);
  }
  static void inlineBranchInto(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = branchedAdjust(i - 20, 7);
  }
  static void clearPostIncrement(int[] out) {
    int index = 0;
    while (index < out.length) out[index++] = 0;
  }
  static void repeatedReads(Box box, int[] out) {
    for (int i = 0; i < out.length; i++) {
      out[i] = box.bias + box.bias + box.values.length + box.values.length;
    }
  }
  static void volatileReads(Box box, int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = box.changing + box.changing;
  }
  public static void compute(Box box, int rounds, int[] out) {
    try {
      int sum = 0;
      for (int i = 0; i < rounds; i++) {
        int[] values = box.values;
        sum += values[i % values.length] + box.bias + staticBias;
        record(out, i, sum);
      }
      out[rounds] = sum;
    } catch (RuntimeException error) {
      throw error;
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  for (const className of ['ScalarFeatureHarness', 'ScalarFeatureHarness$Box']) {
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
  }
  const statics = jvm.classes.ScalarFeatureHarness.staticFields;
  statics.set('staticBias:I', 3);
  const thread = attachThread(jvm, 'scalar-features');
  const box = { type: 'ScalarFeatureHarness$Box', fields: {
    'ScalarFeatureHarness$Box.values': typedArray('[I', [2, 4]),
    'ScalarFeatureHarness$Box.bias': 8,
    'ScalarFeatureHarness$Box.changing': 6,
  } };
  const computeDescriptor = '(LScalarFeatureHarness$Box;I[I)V';
  const out = typedArray('[I', [0, 0, 0, 0]);
  await invoke(jvm, thread, 'ScalarFeatureHarness', 'compute',
    computeDescriptor, [box, 3, out]);
  t.deepEqual(out.slice(), [13, 28, 41, 41],
    'instance/static fields and record calls preserve results');
  const postIncrement = typedArray('[I', [9, 8, 7, 6]);
  await invoke(jvm, thread, 'ScalarFeatureHarness', 'clearPostIncrement',
    '([I)V', [postIncrement]);
  t.deepEqual(postIncrement.slice(), [0, 0, 0, 0],
    'post-increment array stores reach every index');
  const repeated = typedArray('[I', [0, 0]);
  await invoke(jvm, thread, 'ScalarFeatureHarness', 'repeatedReads',
    '(LScalarFeatureHarness$Box;[I)V', [box, repeated]);
  t.deepEqual(repeated.slice(), [20, 20],
    'repeated field and length reads preserve their values');
  const volatileOut = typedArray('[I', [0, 0]);
  await invoke(jvm, thread, 'ScalarFeatureHarness', 'volatileReads',
    '(LScalarFeatureHarness$Box;[I)V', [box, volatileOut]);
  t.deepEqual(volatileOut.slice(), [12, 12], 'volatile field reads preserve their values');
  const inlineOut = typedArray('[I', [0, 0, 0, 0]);
  await invoke(jvm, thread, 'ScalarFeatureHarness', 'inlineInto', '([I)V', [inlineOut]);
  t.deepEqual(inlineOut.slice(), [1, 4, 7, 10], 'an integer leaf call in a loop is exact');
  const inlineBranchOut = typedArray('[I', new Array(32).fill(0));
  await invoke(jvm, thread, 'ScalarFeatureHarness', 'inlineBranchInto', '([I)V',
    [inlineBranchOut]);
  const expectedBranch = Array.from({ length: 32 }, (_unused, i) => {
    const value = i - 20;
    let mixed = ((value ^ (value >>> 16)) + 13) | 0;
    if (mixed < 7) mixed = (7 - mixed) | 0;
    return Math.imul(mixed & 255, 65793);
  });
  t.deepEqual(inlineBranchOut.slice(), expectedBranch,
    'a forward-branching integer leaf call in a loop is exact');

  statics.set('staticBias:I', 9);
  const changedStaticOut = typedArray('[I', [0, 0]);
  await invoke(jvm, thread, 'ScalarFeatureHarness', 'compute',
    computeDescriptor, [box, 1, changedStaticOut]);
  t.deepEqual(changedStaticOut.slice(), [19, 19],
    'a later static change is observed by the next call');

  const nullBox = { type: 'ScalarFeatureHarness$Box', fields: {
    'ScalarFeatureHarness$Box.values': null,
    'ScalarFeatureHarness$Box.bias': 8,
  } };
  let thrown = null;
  try {
    await invoke(jvm, thread, 'ScalarFeatureHarness', 'compute',
      computeDescriptor, [nullBox, 1, typedArray('[I', [0, 0])]);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/NullPointerException',
    'a null field array raises NullPointerException');
  t.end();
});

test('float comparisons follow JVM NaN and signed-zero ordering', async (t) => {
  const classpath = compileJavaFixture(t, 'FloatCompareHarness', `
public class FloatCompareHarness {
  static void compare(float a, float b, int[] out) {
    out[0] = a < b ? 1 : 0;
    out[1] = a > b ? 1 : 0;
    out[2] = a <= b ? 1 : 0;
    out[3] = a >= b ? 1 : 0;
    out[4] = a == b ? 1 : 0;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('FloatCompareHarness');
  jvm.classInitializationState.set('FloatCompareHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'float-compare');
  const run = async (left, right) => {
    const out = typedArray('[I', [9, 9, 9, 9, 9]);
    await invoke(jvm, thread, 'FloatCompareHarness', 'compare', '(FF[I)V',
      [Math.fround(left), Math.fround(right), out]);
    return out.slice();
  };
  t.deepEqual(await run(Number.NaN, 1), [0, 0, 0, 0, 0],
    'every comparison with NaN on the left is false');
  t.deepEqual(await run(1, Number.NaN), [0, 0, 0, 0, 0],
    'every comparison with NaN on the right is false');
  t.deepEqual(await run(1, 2), [1, 0, 1, 0, 0], 'less-than ordering is preserved');
  t.deepEqual(await run(2, 1), [0, 1, 0, 1, 0], 'greater-than ordering is preserved');
  t.deepEqual(await run(-0, 0), [0, 0, 1, 1, 1], 'signed zeros compare equal');
  t.end();
});

test('an ArithmeticException in a loop resumes at the guest handler', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredCatchHarness', `
public class StructuredCatchHarness {
  static int effects;
  static int observed;

  public static int compute(int[] values) {
    int total = 0;
    try {
      for (int index = 0; index < values.length; index++) {
        effects++;
        total += 100 / values[index];
      }
    } catch (ArithmeticException expected) {
      total += 7;
    }
    observed = total;
    return total;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('StructuredCatchHarness');
  jvm.classInitializationState.set('StructuredCatchHarness', 'INITIALIZED');
  const statics = jvm.classes.StructuredCatchHarness.staticFields;
  statics.set('effects:I', 0);
  statics.set('observed:I', 0);
  const thread = attachThread(jvm, 'structured-catch');
  await invoke(jvm, thread, 'StructuredCatchHarness', 'compute', '([I)I',
    [typedArray('[I', [2, 0, 5])]);
  t.equal(statics.get('effects:I'), 2,
    'effects before the throwing division execute exactly once');
  t.equal(statics.get('observed:I'), 57,
    'the handler resumes with the partial total');
  t.end();
});

test('PyramidApplet paint emits the same graphics operations as the interpreter', async (t) => {
  const interpreted = await createPyramidHarness({ enabled: false });
  const jitted = await createPyramidHarness();
  const interpretedGraphics = { type: 'java/awt/Graphics', _awtGraphics: new awt.MockGraphics() };
  const jittedGraphics = { type: 'java/awt/Graphics', _awtGraphics: new awt.MockGraphics() };
  await invoke(interpreted.jvm, interpreted.thread, 'PyramidApplet', 'paint',
    '(Ljava/awt/Graphics;)V', [interpreted.applet, interpretedGraphics]);
  await invoke(jitted.jvm, jitted.thread, 'PyramidApplet', 'paint',
    '(Ljava/awt/Graphics;)V', [jitted.applet, jittedGraphics]);
  t.ok(interpretedGraphics._awtGraphics.operations.length > 0,
    'the interpreter emits graphics operations');
  t.deepEqual(jittedGraphics._awtGraphics.operations,
    interpretedGraphics._awtGraphics.operations,
    'the default configuration and the interpreter emit identical operations');
  t.end();
});

test('integer and double arithmetic stores exact results', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedNumericHarness', `
public class GeneratedNumericHarness {
  public static void compute(int[] out, int a, int b) {
    out[0] = a * b + 3;
    double x = (double) out[0] / 2.0;
    out[1] = (int) x;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedNumericHarness');
  const thread = attachThread(jvm, 'generated-numeric-test');
  const out = typedArray('[I', [0, 0]);
  await invoke(jvm, thread, 'GeneratedNumericHarness', 'compute', '([III)V', [out, 4, 5]);
  t.deepEqual(out.slice(0, 2), [23, 11], 'numeric results are exact');
  t.end();
});

test('getfield through a subclass reads the inherited field', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedInheritedFieldHarness', `
class GeneratedInheritedFieldBase {
  int cursor;
}
public class GeneratedInheritedFieldHarness extends GeneratedInheritedFieldBase {
  int output;
  public void sync() {
    output = 8 * cursor;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedInheritedFieldHarness');
  await jvm.loadClassByName('GeneratedInheritedFieldBase');
  const thread = attachThread(jvm, 'generated-inherited-field-test');
  const object = {
    type: 'GeneratedInheritedFieldHarness',
    _className: 'GeneratedInheritedFieldHarness',
    fields: {
      'GeneratedInheritedFieldBase.cursor': 7,
      'GeneratedInheritedFieldHarness.output': 0,
    },
  };
  await invoke(jvm, thread, 'GeneratedInheritedFieldHarness', 'sync', '()V', [object]);
  t.equal(readField(object.fields, 'GeneratedInheritedFieldHarness.output'), 56,
    'the subclass reference reads the inherited storage slot');
  t.end();
});

test('integer bitwise loops preserve Java semantics', async (t) => {
  const classpath = compileJavaFixture(t, 'IntegerLoopJitHarness', `
public class IntegerLoopJitHarness {
  public static void compute(int[] out, int n) {
    for (int i = 0; i < n; i++) {
      out[i] = -((i ^ -1) >> 1);
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('IntegerLoopJitHarness');
  const thread = attachThread(jvm, 'integer-loop-jit-test');
  const out = typedArray('[I', [0, 0, 0, 0]);
  await invoke(jvm, thread, 'IntegerLoopJitHarness', 'compute', '([II)V', [out, 4]);
  t.deepEqual(out.slice(0, 4), [1, 1, 2, 2], 'the bitwise loop result is exact');
  t.end();
});

test('wide local increments accumulate exactly', async (t) => {
  const classpath = compileJavaFixture(t, 'WideIncrementJitHarness', `
public class WideIncrementJitHarness {
  public static void compute(int[] out) {
    int value = 0;
    for (int i = 0; i < out.length; i++) {
      value += 3171;
      out[i] = value;
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('WideIncrementJitHarness');
  const thread = attachThread(jvm, 'wide-increment-jit-test');
  const out = typedArray('[I', [0, 0, 0, 0]);
  await invoke(jvm, thread, 'WideIncrementJitHarness', 'compute', '([I)V', [out]);
  t.deepEqual(out.slice(), [3171, 6342, 9513, 12684],
    'wide iinc preserves Java integer loop results');
  t.end();
});

test('a loop calling a private static helper stores every result', async (t) => {
  const classpath = compileJavaFixture(t, 'NestedGeneratedJitHarness', `
public class NestedGeneratedJitHarness {
  private static int scale(int value) { return value * 3; }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = scale(i);
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('NestedGeneratedJitHarness');
  const thread = attachThread(jvm, 'nested-generated-jit-test');
  const out = typedArray('[I', [0, 0, 0, 0]);
  await invoke(jvm, thread, 'NestedGeneratedJitHarness', 'compute', '([I)V', [out]);
  t.deepEqual(out.slice(), [0, 3, 6, 9], 'nested calls preserve results');
  t.end();
});

test('the scheduler runs a pushed frame to completion twice', async (t) => {
  const classpath = compileJavaFixture(t, 'SynchronousExecuteHarness', `
public class SynchronousExecuteHarness {
  public static void compute(int[] out) {
    int value = 0;
    for (int i = 0; i < 100; i++) value += i;
    out[0] = value;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('SynchronousExecuteHarness');
  jvm.classInitializationState.set(
    'SynchronousExecuteHarness', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    'SynchronousExecuteHarness', 'compute', '([I)V');
  const out = typedArray('[I', [0]);
  for (const name of ['first-execute', 'second-execute']) {
    out[0] = 0;
    const frame = new Frame(method);
    frame.className = 'SynchronousExecuteHarness';
    frame.locals[0] = out;
    const thread = attachThread(jvm, name);
    thread.callStack.push(frame);
    const result = await jvm.execute();
    t.equal(out[0], 4950, `${name}: the loop result is exact`);
    t.ok(result.completed, `${name}: the scheduler completes normally`);
  }
  t.end();
});

test('integer leaf calls with guarded branches compute exact sums', async (t) => {
  const classpath = compileJavaFixture(t, 'DirectIntegerInlineHarness', `
class DirectIntegerLeafTarget {
  static int transform(int value) {
    return ((value + 7) * 3) ^ (value >>> 5);
  }
  static int guarded(int value) {
    if ((value & 63) == 63) return "abc".length() + value;
    return value * 3;
  }
  static int scopedGuarded(int value) {
    int selected = value;
    if ((value & 1) != 0) selected = (value + 5) * 3;
    if ((selected & 63) == 63) return "abc".length() + selected;
    return selected * 7;
  }
}
public class DirectIntegerInlineHarness {
  public static void compute(int[] out) {
    int value = 1;
    for (int i = 0; i < 100; i++) {
      value = DirectIntegerLeafTarget.transform(value + i);
    }
    out[0] = value;
  }
  public static void computeGuarded(int[] out) {
    int sum = 0;
    for (int i = 0; i < 128; i++) sum += DirectIntegerLeafTarget.guarded(i);
    out[0] = sum;
  }
  public static void computeScopedGuarded(int[] out) {
    int sum = 0;
    for (int i = 0; i < 128; i++) {
      sum += DirectIntegerLeafTarget.scopedGuarded(i);
    }
    out[0] = sum;
  }
}
`);
  const jvm = new JVM({ classpath });
  for (const className of ['DirectIntegerInlineHarness', 'DirectIntegerLeafTarget']) {
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
  }
  const thread = attachThread(jvm, 'direct-integer-inline-test');
  const out = typedArray('[I', [0]);
  await invoke(jvm, thread, 'DirectIntegerInlineHarness', 'compute', '([I)V', [out]);
  let expected = 1;
  for (let i = 0; i < 100; i++) {
    const input = (expected + i) | 0;
    expected = (Math.imul((input + 7) | 0, 3) ^ (input >>> 5)) | 0;
  }
  t.equal(out[0], expected, 'the leaf expression preserves Java integer semantics');

  const guardedOut = typedArray('[I', [0]);
  await invoke(jvm, thread, 'DirectIntegerInlineHarness',
    'computeGuarded', '([I)V', [guardedOut]);
  let guardedExpected = 0;
  for (let i = 0; i < 128; i++) {
    guardedExpected = (guardedExpected +
      ((i & 63) === 63 ? i + 3 : Math.imul(i, 3))) | 0;
  }
  t.equal(guardedOut[0], guardedExpected, 'the rare String-length branch is exact');

  const scopedGuardedOut = typedArray('[I', [0]);
  await invoke(jvm, thread, 'DirectIntegerInlineHarness',
    'computeScopedGuarded', '([I)V', [scopedGuardedOut]);
  let scopedGuardedExpected = 0;
  for (let i = 0; i < 128; i++) {
    const selected = (i & 1) !== 0 ? Math.imul((i + 5) | 0, 3) : i;
    const value = (selected & 63) === 63
      ? (selected + 3) | 0 : Math.imul(selected, 7);
    scopedGuardedExpected = (scopedGuardedExpected + value) | 0;
  }
  t.equal(scopedGuardedOut[0], scopedGuardedExpected,
    'branch-local values remain available to later conditions and results');
  t.end();
});

test('static, virtual and interface call chains compute the same exact value', async (t) => {
  const classpath = compileJavaFixture(t, 'IntermethodCallJitHarness', `
public class IntermethodCallJitHarness {
  public abstract static class Base { public abstract int apply(int value); }
  public interface Contract { int apply(int value); }
  public static final class Worker extends Base implements Contract {
    public int apply(int value) { return chain(value); }
  }
  static int add(int value) { return value + 1; }
  static int multiply(int value) { return value * 3; }
  static int mix(int value) { return value ^ 7; }
  static int chain(int value) {
    value = add(value);
    value = multiply(value);
    return mix(value);
  }
  public static void runStatic(int[] out) {
    int value = 5;
    for (int i = 0; i < 20; i++) value = chain(value + i);
    out[0] = value;
  }
  public static void runVirtual(Base worker, int[] out) {
    int value = 5;
    for (int i = 0; i < 20; i++) value = worker.apply(value + i);
    out[1] = value;
  }
  public static void runInterface(Contract worker, int[] out) {
    int value = 5;
    for (int i = 0; i < 20; i++) value = worker.apply(value + i);
    out[2] = value;
  }
}
`);
  const jvm = new JVM({ classpath });
  for (const className of [
    'IntermethodCallJitHarness',
    'IntermethodCallJitHarness$Base',
    'IntermethodCallJitHarness$Contract',
    'IntermethodCallJitHarness$Worker',
  ]) {
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
  }
  const thread = attachThread(jvm, 'intermethod-call-jit-test');
  const out = typedArray('[I', [0, 0, 0]);
  const worker = { type: 'IntermethodCallJitHarness$Worker', fields: {} };
  await invoke(jvm, thread, 'IntermethodCallJitHarness', 'runStatic', '([I)V', [out]);
  await invoke(jvm, thread, 'IntermethodCallJitHarness', 'runVirtual',
    '(LIntermethodCallJitHarness$Base;[I)V', [worker, out]);
  await invoke(jvm, thread, 'IntermethodCallJitHarness', 'runInterface',
    '(LIntermethodCallJitHarness$Contract;[I)V', [worker, out]);
  t.deepEqual(out.slice(), [945874715, 945874715, 945874715],
    'static, virtual, and interface dispatch produce the exact value');
  t.end();
});

test('a loop calling a switch-based helper stores every result', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedTransientCallJitHarness', `
public class GeneratedTransientCallJitHarness {
  private static int selected(int value) {
    switch (value) {
      case 0: return 10;
      case 1: return 20;
      default: return 30;
    }
  }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = selected(i) + 1;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedTransientCallJitHarness');
  const thread = attachThread(jvm, 'transient-call-generated-jit-test');
  const out = typedArray('[I', [0, 0, 0]);
  await invoke(jvm, thread, 'GeneratedTransientCallJitHarness', 'compute', '([I)V', [out]);
  t.deepEqual(out.slice(0, 3), [11, 21, 31], 'the switch helper results are exact');
  t.end();
});

test('clone() on an int array inside a loop returns distinct typed copies', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedArrayCloneJitHarness', `
public class GeneratedArrayCloneJitHarness {
  public static void copy(int[] input, int[][] out) {
    for (int i = 0; i < out.length; i++) out[i] = (int[]) input.clone();
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedArrayCloneJitHarness');
  const thread = attachThread(jvm, 'array-clone-generated-jit-test');
  const input = typedArray('[I', [3, 5, 8]);
  const out = typedArray('[[I', [null]);
  await invoke(jvm, thread, 'GeneratedArrayCloneJitHarness', 'copy',
    '([I[[I)V', [input, out]);
  t.deepEqual(Array.from(out[0]), [3, 5, 8], 'the clone preserves its elements');
  t.notEqual(out[0], input, 'the clone is a distinct array');
  t.equal(out[0].type, '[I', 'the clone keeps its runtime array type');
  t.end();
});

test('invokeinterface accessors in a loop return the implementation field', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedInterfaceJitHarness', `
public class GeneratedInterfaceJitHarness {
  interface Value { int get(); }
  static class Fixed implements Value {
    private final int value;
    Fixed(int value) { this.value = value; }
    public int get() { return value; }
  }
  public static void compute(int[] out, Value value) {
    for (int i = 0; i < out.length; i++) out[i] = value.get();
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedInterfaceJitHarness');
  await jvm.loadClassByName('GeneratedInterfaceJitHarness$Fixed');
  const thread = attachThread(jvm, 'interface-generated-jit-test');
  const out = typedArray('[I', [0, 0, 0, 0]);
  const value = {
    type: 'GeneratedInterfaceJitHarness$Fixed',
    fields: { 'GeneratedInterfaceJitHarness$Fixed.value': 7 },
  };
  await invoke(jvm, thread, 'GeneratedInterfaceJitHarness', 'compute',
    '([ILGeneratedInterfaceJitHarness$Value;)V', [out, value]);
  t.deepEqual(out.slice(), [7, 7, 7, 7], 'interface dispatch returns the field value');
  t.end();
});

test('an integer getter observes writes made between calls', async (t) => {
  const classpath = compileJavaFixture(t, 'InlineGetterFieldHarness', `
public class InlineGetterFieldHarness {
  interface Value { int get(); }
  static class Counter implements Value {
    int value;
    public int get() { return value; }
    void bump(int by) { value = value + by; }
  }
  public static void compute(int[] out, Value value) {
    Counter counter = (Counter) value;
    for (int i = 0; i < out.length; i++) {
      out[i] = counter.get();
      counter.bump(2);
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('InlineGetterFieldHarness');
  await jvm.loadClassByName('InlineGetterFieldHarness$Counter');
  const thread = attachThread(jvm, 'inline-getter-field-test');
  const out = typedArray('[I', [0, 0, 0, 0]);
  const value = {
    type: 'InlineGetterFieldHarness$Counter',
    fields: { 'InlineGetterFieldHarness$Counter.value': 5 },
  };
  await invoke(jvm, thread, 'InlineGetterFieldHarness', 'compute',
    '([ILInlineGetterFieldHarness$Value;)V', [out, value]);
  t.deepEqual(out.slice(), [5, 7, 9, 11], 'each read observes the preceding write');
  t.equal(readField(value.fields, 'InlineGetterFieldHarness$Counter.value'), 13,
    'the field ends at its final written value');
  t.end();
});

test('byte-array loops preserve int overflow and truncating division', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedIntegerArrayLoopHarness', `
public class GeneratedIntegerArrayLoopHarness {
  public static void compute(int[] out, byte[][] left, byte[][] right, int length) {
    int score = 100;
    for (int i = 0; i < length; i++) {
      int value = left[0][i] + right[1][i];
      if (value < score) score = value;
    }
    out[0] = -score;
    out[1] = 2147483647 + length;
    out[2] = -7 / length;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedIntegerArrayLoopHarness');
  const thread = attachThread(jvm, 'generated-integer-array-loop-test');
  const out = typedArray('[I', [0, 0, 0]);
  const left = typedArray('[[B', [typedArray('[B', [5, 4, 3])]);
  const right = typedArray('[[B', [typedArray('[B', [0, 0, 0]), typedArray('[B', [2, 1, 0])]);
  await invoke(jvm, thread, 'GeneratedIntegerArrayLoopHarness', 'compute', '([I[[B[[BI)V',
    [out, left, right, 3]);
  t.deepEqual(out.slice(), [-3, -2147483646, -2],
    'int overflow and truncating division are exact');
  t.end();
});

test('short-array loads and a checked array cast compute the exact sum', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedShortArrayJitHarness', `
public class GeneratedShortArrayJitHarness {
  public static void compute(int[] out, short[] values, Object checked) {
    int sum = 0;
    for (int i = 0; i < values.length; i++) sum += values[i];
    out[0] = sum + ((int[]) checked).length;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedShortArrayJitHarness');
  const thread = attachThread(jvm, 'short-array-generated-jit-test');
  const out = typedArray('[I', [0]);
  await invoke(jvm, thread, 'GeneratedShortArrayJitHarness', 'compute',
    '([I[SLjava/lang/Object;)V',
    [out, typedArray('[S', [300, -20, 7]), typedArray('[I', [1, 2])]);
  t.equal(out[0], 289, 'short loads and a valid array cast preserve results');
  t.end();
});

test('long division, xor and comparison follow JVM semantics', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedLongJitHarness', `
public class GeneratedLongJitHarness {
  public static void compute(int[] out, int value) {
    out[0] = ((((long) value / 3L) ^ -1L) == -5L) ? 1 : 0;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedLongJitHarness');
  const thread = attachThread(jvm, 'long-generated-jit-test');
  const out = typedArray('[I', [0]);
  await invoke(jvm, thread, 'GeneratedLongJitHarness', 'compute', '([II)V', [out, 12]);
  t.equal(out[0], 1, 'the long expression is exact');
  t.end();
});

test('float array loops round to float32 after every operation', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedFloatLoopHarness', `
public class GeneratedFloatLoopHarness {
  public static float mix(float[] values, int rounds) {
    float total = 0.0f;
    for (int round = 0; round < rounds; round++) {
      for (int i = 0; i < values.length; i++) {
        values[i] = values[i] * 1.25f - 0.5f;
        total += values[i];
      }
    }
    return total;
  }
}
`);
  async function run(jit) {
    const jvm = new JVM({ classpath, jit });
    await jvm.loadClassByName('GeneratedFloatLoopHarness');
    const thread = attachThread(jvm, 'generated-float-loop-test');
    const values = typedArray('[F', [0.1, -2.25, 3.5].map(Math.fround));
    await invoke(jvm, thread, 'GeneratedFloatLoopHarness', 'mix', '([FI)F',
      [values, 4]);
    return values.slice();
  }
  const expected = [0.1, -2.25, 3.5].map((start) => {
    let value = Math.fround(start);
    for (let round = 0; round < 4; round++) {
      value = Math.fround(Math.fround(value * 1.25) - 0.5);
    }
    return value;
  });
  t.deepEqual(await run({ enabled: false }), expected,
    'the interpreter rounds every operation to float32');
  t.deepEqual(await run(undefined), expected,
    'the default configuration rounds every operation to float32');
  t.end();
});

test('long values merged across a conditional are preserved', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmLongCarryHarness', `
public class WasmLongCarryHarness {
  public static void compute(long[] out, long[] state, long[] input) {
    for (int i = 0; i < out.length; i++) {
      out[i] = state[i] > input[i] ? state[i] : input[i];
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('WasmLongCarryHarness');
  jvm.classInitializationState.set('WasmLongCarryHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'wasm-long-carry-test');
  const out = typedArray('[J', [0n, 0n, 0n]);
  await invoke(jvm, thread, 'WasmLongCarryHarness', 'compute', '([J[J[J)V',
    [out, typedArray('[J', [1n, 2n, 3n]), typedArray('[J', [4n, 6n, 7n])]);
  t.deepEqual(out.slice(0, 3), [4n, 6n, 7n], 'merged long branch values are preserved');
  t.end();
});

test('field reads observe same-loop writes and receiver reassignment', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmFieldCacheHarness', `
public class WasmFieldCacheHarness {
  static int bias;
  int scale;
  public static int compute(int[] out) {
    bias = 1;
    WasmFieldCacheHarness h = new WasmFieldCacheHarness();
    h.scale = 2;
    int sum = 0;
    for (int i = 0; i < out.length; i++) {
      sum += bias + h.scale;
      if (i == 1) { bias = 5; h.scale = 9; }
      sum += bias + h.scale;
    }
    out[0] = sum;
    return sum;
  }
  public static int swapAlias(int[] out) {
    WasmFieldCacheHarness p = new WasmFieldCacheHarness();
    WasmFieldCacheHarness q = new WasmFieldCacheHarness();
    p.scale = 1;
    q.scale = 100;
    int sum = 0;
    for (int i = 0; i < out.length; i++) {
      sum += p.scale;
      WasmFieldCacheHarness t = p; p = q; q = t;
      sum += p.scale;
    }
    out[0] = sum;
    return sum;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('WasmFieldCacheHarness');
  jvm.classInitializationState.set('WasmFieldCacheHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'wasm-field-cache-test');
  const out = typedArray('[I', [0, 0, 0, 0]);
  await invoke(jvm, thread, 'WasmFieldCacheHarness', 'compute', '([I)I', [out]);
  t.equal(out[0], 79, 'putstatic and putfield are observed mid-loop');
  const swapped = typedArray('[I', [0, 0, 0]);
  await invoke(jvm, thread, 'WasmFieldCacheHarness', 'swapAlias', '([I)I', [swapped]);
  t.equal(swapped[0], 303, 'reassigning a receiver local reads the new object');
  t.end();
});

test('static writes in a callee are observed while pure callees leave fields intact', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmWriteSummaryHarness', `
public class WasmWriteSummaryHarness {
  static int base;
  static int scale;
  static int pure(int v) { return v * 2 + 1; }
  static int pureNested(int v) { return pure(v) + Math.abs(v); }
  static void bump(int d) { scale += d; }
  public static int drive(int[] out, int n) {
    base = 7;
    scale = 3;
    int sum = 0;
    for (int i = 0; i < n; i++) {
      sum += base + pureNested(i);
      if (i == n / 2) { bump(2); }
      sum += scale * base;
    }
    out[0] = sum;
    return sum;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('WasmWriteSummaryHarness');
  jvm.classInitializationState.set('WasmWriteSummaryHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'wasm-write-summary-test');
  const out = typedArray('[I', [0]);
  await invoke(jvm, thread, 'WasmWriteSummaryHarness', 'drive', '([II)I', [out, 12]);
  t.equal(out[0], 630, 'the callee write to scale is observed by the caller');
  t.end();
});

test('a helper whose diagnostic branch toggles mid-loop keeps exact results', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmPartialLinkHarness', `
public class WasmPartialLinkHarness {
  static boolean diag;
  static int mix(int v, int[] log) {
    if (diag) { log[0] = ("v=" + v).length(); }
    return v * 3 + 1;
  }
  public static int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
      int t = mix(i, out);
      sum += t;
      if (i == 5) { diag = true; }
      if (i == 7) { diag = false; }
    }
    out[1] = sum;
    return sum;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('WasmPartialLinkHarness');
  jvm.classInitializationState.set('WasmPartialLinkHarness', 'INITIALIZED');
  jvm.classes.WasmPartialLinkHarness.staticFields.set('diag:Z', false);
  const thread = attachThread(jvm, 'wasm-partial-link-test');
  const out = typedArray('[I', [0, 0]);
  await invoke(jvm, thread, 'WasmPartialLinkHarness', 'drive', '([II)I', [out, 10]);
  // sum of 3i+1 for i in 0..9 = 145; the flag is true for i=6,7 so the
  // diagnostic path last logs "v=7".length() = 3
  t.equal(out[1], 145, 'the loop result is exact');
  t.equal(out[0], 3, 'the diagnostic path ran with the correct value');
  t.end();
});

test('a static helper reading the caller array computes exact integers', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmLinkedHelperHarness', `
public class WasmLinkedHelperHarness {
  private static int mix(int[] values, int index, int salt) {
    int value = values[index];
    return (value * 31 + salt) ^ (value >>> 3);
  }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = mix(out, i, i + 7);
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('WasmLinkedHelperHarness');
  jvm.classInitializationState.set('WasmLinkedHelperHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'wasm-linked-helper-test');
  const out = typedArray('[I', [3, 5, 8]);
  await invoke(jvm, thread, 'WasmLinkedHelperHarness', 'compute', '([I)V', [out]);
  t.deepEqual(out.slice(0, 3), [100, 163, 256], 'the helper results are exact');
  t.end();
});

test('a helper with a wrap-and-rethrow handler returns normal results', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmLinkedReporterHelperHarness', `
public class WasmLinkedReporterHelperHarness {
  private static int mix(int value) {
    try {
      return value * 31 + 7;
    } catch (RuntimeException failure) {
      throw new IllegalStateException("mix(" + value + ")", failure);
    }
  }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = mix(out[i]);
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('WasmLinkedReporterHelperHarness');
  jvm.classInitializationState.set('WasmLinkedReporterHelperHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'wasm-linked-reporter-helper-test');
  const out = typedArray('[I', [2, 4, 6]);
  await invoke(jvm, thread, 'WasmLinkedReporterHelperHarness', 'compute', '([I)V', [out]);
  t.deepEqual(out.slice(0, 3), [69, 131, 193], 'normal-flow results are exact');
  t.end();
});

test('protected loops return normally and recover from an out-of-bounds index', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmReporterHarness', `
public class WasmReporterHarness {
  public static void compute(int[] out, String site) {
    try {
      for (int i = 0; i < out.length; i++) out[i] = out[i] * 3 + i;
    } catch (RuntimeException failure) {
      String detail = site == null ? "null" : "{...}";
      throw new IllegalStateException("compute(" + detail + ")", failure);
    }
  }

  public static void recover(int[] out) {
    try {
      for (int i = 0; i <= out.length; i++) out[i]++;
    } catch (RuntimeException failure) {
      out[0] = 42;
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('WasmReporterHarness');
  jvm.classInitializationState.set('WasmReporterHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'wasm-reporter-test');
  const out = typedArray('[I', [2, 4, 6]);
  await invoke(jvm, thread, 'WasmReporterHarness', 'compute',
    '([ILjava/lang/String;)V', [out, null]);
  t.deepEqual(out.slice(0, 3), [6, 13, 20], 'the protected loop results are exact');
  const recovered = typedArray('[I', [10, 20, 30]);
  await invoke(jvm, thread, 'WasmReporterHarness', 'recover', '([I)V', [recovered]);
  t.deepEqual(recovered.slice(0, 3), [42, 21, 31],
    'the handler runs after the out-of-bounds increment');
  t.end();
});

test('loops protected only by checked-exception handlers recover correctly', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmCheckedHandlerHarness', `
import java.io.IOException;

public class WasmCheckedHandlerHarness {
  private static void maybeFail(boolean fail) throws IOException {
    if (fail) throw new IOException("expected");
  }

  public static void checked(int[] out, boolean fail) {
    try {
      for (int i = 0; i < out.length; i++) out[i] = out[i] * 3 + i;
      maybeFail(fail);
    } catch (IOException expected) {
      out[0] = 42;
    }
  }

  public static void broad(int[] out) {
    try {
      for (int i = 0; i <= out.length; i++) out[i]++;
    } catch (Exception expected) {
      out[0] = 99;
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('WasmCheckedHandlerHarness');
  jvm.classInitializationState.set('WasmCheckedHandlerHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'wasm-checked-handler-test');
  const success = typedArray('[I', [2, 4, 6]);
  await invoke(jvm, thread, 'WasmCheckedHandlerHarness', 'checked', '([IZ)V', [success, 0]);
  t.deepEqual(success.slice(0, 3), [6, 13, 20], 'the protected loop result is exact');
  const failure = typedArray('[I', [1, 2, 3]);
  await invoke(jvm, thread, 'WasmCheckedHandlerHarness', 'checked', '([IZ)V', [failure, 1]);
  t.deepEqual(failure.slice(0, 3), [42, 7, 11],
    'a checked exception from the callee reaches its handler');
  const recovered = typedArray('[I', [5, 6, 7]);
  await invoke(jvm, thread, 'WasmCheckedHandlerHarness', 'broad', '([I)V', [recovered]);
  t.deepEqual(recovered.slice(0, 3), [99, 7, 8],
    'a broad Exception handler catches the out-of-bounds index');
  t.end();
});

test('a child loop with a rethrow-only handler returns to its caller', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmBeforeDeoptHarness', `
public class WasmBeforeDeoptHarness {
  private static int increment(int value) {
    return value + 1;
  }

  private static void wrappedLoop(int[] out) {
    try {
      for (int i = 0; i < out.length; i++) out[i] = increment(out[i]);
    } catch (RuntimeException failure) {
      throw failure;
    }
  }

  public static void caller(int[] out) {
    wrappedLoop(out);
    out[0] += 10;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('WasmBeforeDeoptHarness');
  jvm.classInitializationState.set('WasmBeforeDeoptHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'wasm-before-deopt-test');
  const out = typedArray('[I', [1, 2, 3]);
  await invoke(jvm, thread, 'WasmBeforeDeoptHarness', 'caller', '([I)V', [out]);
  t.deepEqual(out.slice(0, 3), [12, 3, 4], 'child and caller effects are exact');
  t.end();
});

test('Java exceptions are routed through exception tables', async (t) => {
  const classpath = compileJavaFixture(t, 'JitExceptionHarness', `
public class JitExceptionHarness {
  static class Box { int value; }

  public static void catchDivide(int[] out, int a, int b) {
    try {
      out[0] = a / b;
    } catch (ArithmeticException e) {
      out[0] = 42;
    }

    double x = (double) a + 1.0;
    out[1] = (int) x;
  }

  public static void catchNull(int[] out, Box box) {
    try {
      out[0] = box.value;
    } catch (NullPointerException e) {
      out[0] = 77;
    }
    double x = 3.0;
    out[1] = (int) x;
  }

  public static void catchExplicit(int[] out, RuntimeException failure) {
    try {
      if (failure != null) throw failure;
    } catch (RuntimeException e) {
      out[0] = 91;
    }
    for (int i = 1; i < out.length; i++) out[i] = i + 10;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('JitExceptionHarness');
  const thread = attachThread(jvm, 'jit-exception-test');
  const out = typedArray('[I', [0, 0]);
  await invoke(jvm, thread, 'JitExceptionHarness', 'catchDivide', '([III)V', [out, 10, 0]);
  t.deepEqual(out.slice(0, 2), [42, 11], 'ArithmeticException is caught and execution continues');
  const nullOut = typedArray('[I', [0, 0]);
  await invoke(jvm, thread, 'JitExceptionHarness', 'catchNull',
    '([ILJitExceptionHarness$Box;)V', [nullOut, null]);
  t.deepEqual(nullOut.slice(0, 2), [77, 3],
    'getfield on null throws a catchable NullPointerException');
  const explicitOut = typedArray('[I', [0, 0]);
  await invoke(jvm, thread, 'JitExceptionHarness', 'catchExplicit',
    '([ILjava/lang/RuntimeException;)V', [explicitOut, { type: 'java/lang/RuntimeException' }]);
  t.deepEqual(explicitOut.slice(0, 2), [91, 11],
    'athrow routes through the method exception table');
  t.end();
});

test('repeated constructor callers keep allocation and handler effects', async (t) => {
  const classpath = compileJavaFixture(t, 'AdaptiveConstructorCallerHarness', `
public class AdaptiveConstructorCallerHarness {
  static class Box {
    int value;
  }

  public static void compute(int[] out, int value) {
    Box box = new Box();
    box.value = value;
    out[0] = box.value * 3;
  }

  static int read(Box box) {
    return box.value;
  }

  public static void guarded(int[] out, Box box) {
    try {
      out[0] = read(box) * 5;
    } catch (RuntimeException failure) {
      if (out.length == 0) throw failure;
      out[0] = 91;
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('AdaptiveConstructorCallerHarness');
  await jvm.loadClassByName('AdaptiveConstructorCallerHarness$Box');
  const thread = attachThread(jvm, 'adaptive-constructor-caller');
  const out = typedArray('[I', [0]);
  await invoke(jvm, thread, 'AdaptiveConstructorCallerHarness', 'compute',
    '([II)V', [out, 4]);
  t.equal(out[0], 12, 'the first call computes through the new object');
  await invoke(jvm, thread, 'AdaptiveConstructorCallerHarness', 'compute',
    '([II)V', [out, 7]);
  t.equal(out[0], 21, 'a repeated call computes through the new object');
  for (let call = 0; call < 2; call += 1) {
    out[0] = 0;
    await invoke(jvm, thread, 'AdaptiveConstructorCallerHarness', 'guarded',
      '([ILAdaptiveConstructorCallerHarness$Box;)V', [out, null]);
    t.equal(out[0], 91,
      `call ${call + 1}: an exception from the child resumes the recovery handler`);
  }
  t.end();
});

test('a constructor with a multidimensional-array initializer runs repeatedly', async (t) => {
  const classpath = compileJavaFixture(t, 'AdaptiveComplexConstructorHarness', `
public class AdaptiveComplexConstructorHarness {
  static class ComplexBox {
    int[][][] values = new int[2][2][4];
  }

  ComplexBox box;

  public void build(int[] out) {
    int sum = 0;
    for (int i = 0; i < out.length; i++) sum += out[i];
    box = new ComplexBox();
    out[0] = sum;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('AdaptiveComplexConstructorHarness');
  await jvm.loadClassByName('AdaptiveComplexConstructorHarness$ComplexBox');
  const thread = attachThread(jvm, 'adaptive-complex-constructor');
  const owner = jvm.jit.allocateObject('AdaptiveComplexConstructorHarness');
  const out = typedArray('[I', [1, 2, 3, 4]);
  for (let invocation = 0; invocation < 8; invocation += 1) {
    await invoke(jvm, thread, 'AdaptiveComplexConstructorHarness', 'build',
      '([I)V', [owner, out]);
    t.equal(out[0], 10 + invocation * 9,
      `invocation ${invocation + 1}: the array sum is exact`);
    const values = readField(readField(owner.fields,
      'AdaptiveComplexConstructorHarness.box').fields,
    'AdaptiveComplexConstructorHarness$ComplexBox.values');
    t.equal(values?.length, 2,
      `invocation ${invocation + 1}: the field initializer allocated the array`);
  }
  t.end();
});

test('instanceof in a loop answers for null, Object and the marker class', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredInstanceofHarness', `
public class StructuredInstanceofHarness {
  static class Marker {}

  public static void count(Object value, int[] out) {
    int result = 0;
    for (int index = 0; index < 8; index++) {
      if (value instanceof Marker) result++;
    }
    out[0] = result;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('StructuredInstanceofHarness');
  jvm.classInitializationState.set(
    'StructuredInstanceofHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'structured-instanceof');
  const out = typedArray('[I', [-1]);
  await invoke(jvm, thread, 'StructuredInstanceofHarness', 'count',
    '(Ljava/lang/Object;[I)V', [null, out]);
  t.equal(out[0], 0, 'null is never an instance');
  await invoke(jvm, thread, 'StructuredInstanceofHarness', 'count',
    '(Ljava/lang/Object;[I)V', [jvm.jit.allocateObject('java/lang/Object'), out]);
  t.equal(out[0], 0, 'a plain Object is not a Marker');
  await invoke(jvm, thread, 'StructuredInstanceofHarness', 'count',
    '(Ljava/lang/Object;[I)V',
    [jvm.jit.allocateObject('StructuredInstanceofHarness$Marker'), out]);
  t.equal(out[0], 8, 'a Marker is an instance on every iteration');
  t.end();
});

test('loop constructors with superclass chains and handlers initialize fields', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedLoopConstructorHarness', `
public class GeneratedLoopConstructorHarness {
  static class Base {
  }

  static class Values extends Base {
    int sum;

    Values(int limit) {
      for (int i = 0; i < limit; i++) sum += i;
    }
  }

  static class RethrowingValues extends Base {
    int sum;

    RethrowingValues(int[] values) {
      for (int i = 0; i < values.length; i++) {
        try {
          sum += values[i];
        } catch (RuntimeException error) {
          throw error;
        }
      }
    }
  }

  static class WrappedAssignment extends Base {
    Object value;

    WrappedAssignment(Object value) {
      try {
        this.value = value;
      } catch (RuntimeException error) {
        throw new IllegalStateException(error);
      }
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedLoopConstructorHarness$Values');
  await jvm.loadClassByName('GeneratedLoopConstructorHarness$Base');
  const thread = attachThread(jvm, 'generated-loop-constructor');
  const receiver = jvm.jit.allocateObject('GeneratedLoopConstructorHarness$Values');
  await invoke(jvm, thread, 'GeneratedLoopConstructorHarness$Values',
    '<init>', '(I)V', [receiver, 100]);
  t.equal(readField(receiver.fields, 'GeneratedLoopConstructorHarness$Values.sum'), 4950,
    'the loop constructor accumulates its field');

  await jvm.loadClassByName('GeneratedLoopConstructorHarness$WrappedAssignment');
  const wrappedReceiver = jvm.jit.allocateObject(
    'GeneratedLoopConstructorHarness$WrappedAssignment');
  const wrappedValue = jvm.jit.allocateObject('java/lang/Object');
  await invoke(jvm, thread,
    'GeneratedLoopConstructorHarness$WrappedAssignment', '<init>',
    '(Ljava/lang/Object;)V', [wrappedReceiver, wrappedValue]);
  t.equal(readField(wrappedReceiver.fields,
    'GeneratedLoopConstructorHarness$WrappedAssignment.value'), wrappedValue,
  'the exception-wrapped constructor stores its field');

  await jvm.loadClassByName('GeneratedLoopConstructorHarness$RethrowingValues');
  const rethrowingReceiver = jvm.jit.allocateObject(
    'GeneratedLoopConstructorHarness$RethrowingValues');
  await invoke(jvm, thread,
    'GeneratedLoopConstructorHarness$RethrowingValues', '<init>', '([I)V',
    [rethrowingReceiver, typedArray('[I', [3, 5, 7, 11])]);
  t.equal(readField(rethrowingReceiver.fields,
    'GeneratedLoopConstructorHarness$RethrowingValues.sum'), 26,
  'the protected loop constructor accumulates its field');
  t.end();
});

test('dup_x2 array-store expressions keep array, index and value order', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedDupX2Harness', `
public class GeneratedDupX2Harness {
  public static void compute(Object[][] out, int[] result, int index, int length) {
    Object[] value = out[index] = new Object[length + 1];
    result[0] = value.length;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedDupX2Harness');
  const thread = attachThread(jvm, 'generated-dup-x2');
  const out = typedArray('[[Ljava/lang/Object;', [null, null]);
  const result = typedArray('[I', [0]);
  await invoke(jvm, thread, 'GeneratedDupX2Harness', 'compute',
    '([[Ljava/lang/Object;[III)V', [out, result, 1, 4]);
  t.equal(result[0], 5, 'the assigned array value is the expression result');
  t.equal(out[1].length, 5, 'the new array is stored at the requested index');
  t.end();
});

test('dup2_x2 long array-store expressions keep array, index and value order',
  async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedDup2X2Harness', `
public final class GeneratedDup2X2Harness {
  static long update(long[] values, int index, long mask) {
    long assigned = values[index] = mask;
    return assigned;
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedDup2X2Harness');
  const thread = attachThread(jvm, 'generated-dup2-x2');
  const values = typedArray('[J', [0x123456789abcdef0n, 7n]);
  await invoke(jvm, thread, 'GeneratedDup2X2Harness', 'update',
    '([JIJ)J', [values, 0, 0x00ff00ff00ff00ffn]);
  t.equal(values[0], 0x00ff00ff00ff00ffn, 'the long is stored at the requested index');
  t.equal(values[1], 7n, 'the other element is untouched');
  t.end();
});

test('compound array assignment in a loop updates every element once', async (t) => {
  const classpath = compileJavaFixture(t, 'RenamedDup2AliasHarness', `
public final class RenamedDup2AliasHarness {
  static void change(int[] values, int delta) {
    for (int index = 0; index < values.length; index++) {
      values[index] += delta;
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('RenamedDup2AliasHarness');
  const thread = attachThread(jvm, 'renamed-dup2-alias');
  const values = typedArray('[I', [41, 7]);
  await invoke(jvm, thread, 'RenamedDup2AliasHarness', 'change',
    '([II)V', [values, 1]);
  t.deepEqual(values.slice(), [42, 8], 'each element is incremented once');
  t.end();
});

test('post-increment field reads with an optional call update the receiver', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedPostIncrementCallHarness', `
public class GeneratedPostIncrementCallHarness {
  int index;
  int calls;

  void touch() {
    calls++;
  }

  int read(byte[] values, boolean call) {
    if (call) touch();
    return values[index++];
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedPostIncrementCallHarness');
  const thread = attachThread(jvm, 'generated-post-increment-call');
  const instance = {
    type: 'GeneratedPostIncrementCallHarness',
    fields: {
      'GeneratedPostIncrementCallHarness.index': 0,
      'GeneratedPostIncrementCallHarness.calls': 0,
    },
  };
  const values = typedArray('[B', [11, 22]);
  await invoke(jvm, thread, 'GeneratedPostIncrementCallHarness', 'read',
    '([BZ)I', [instance, values, 0]);
  await invoke(jvm, thread, 'GeneratedPostIncrementCallHarness', 'read',
    '([BZ)I', [instance, values, 1]);
  t.equal(readField(instance.fields, 'GeneratedPostIncrementCallHarness.index'), 2,
    'post-increment updates the receiver exactly once per read');
  t.equal(readField(instance.fields, 'GeneratedPostIncrementCallHarness.calls'), 1,
    'the call branch executes exactly once');
  t.end();
});

test('synchronized loops update the array and release the monitor', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedMonitorJitHarness', `
public class GeneratedMonitorJitHarness {
  public static void compute(int[] out, int value) {
    try {
      synchronized (out) {
        for (int i = 0; i < out.length; i++) out[i] += value;
      }
    } catch (RuntimeException failure) {
      throw new IllegalStateException(
        new StringBuilder().append("compute(").append(out).append(")").toString(),
        failure);
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('GeneratedMonitorJitHarness');
  const thread = attachThread(jvm, 'monitor-generated-jit-test');
  const out = typedArray('[I', [1, 2, 3]);
  await invoke(jvm, thread, 'GeneratedMonitorJitHarness', 'compute', '([II)V', [out, 4]);
  t.deepEqual(out.slice(0, 3), [5, 6, 7], 'the synchronized loop results are exact');
  t.notOk(out.isLocked, 'monitorexit releases the monitor');
  t.equal(out.lockOwner ?? null, null, 'the released monitor has no owner');
  t.end();
});

test('synchronized regions calling a switch helper keep results and release the monitor',
  async (t) => {
  const classpath = compileJavaFixture(t, 'MonitorCallIslandHarness', `
public class MonitorCallIslandHarness {
  private static int opaque(int value) {
    switch (value) {
      case 1: return 7;
      case 2: return 11;
      case 3: return 13;
      default: return value * 3;
    }
  }

  public static void compute(int[] out) {
    synchronized (out) {
      for (int i = 0; i < out.length; i++) out[i] = opaque(out[i]) + i;
    }
  }

  public static void one(int[] out) {
    synchronized (out) {
      out[0] = opaque(out[0]);
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('MonitorCallIslandHarness');
  jvm.classInitializationState.set('MonitorCallIslandHarness', 'INITIALIZED');
  const thread = attachThread(jvm, 'monitor-call-island-test');
  const out = typedArray('[I', [1, 2, 3, 4]);
  await invoke(jvm, thread, 'MonitorCallIslandHarness', 'compute', '([I)V', [out]);
  t.deepEqual(out.slice(0, 4), [7, 12, 15, 15], 'the loop results are exact');
  t.notOk(out.isLocked, 'the loop releases the monitor');
  const single = typedArray('[I', [3]);
  await invoke(jvm, thread, 'MonitorCallIslandHarness', 'one', '([I)V', [single]);
  t.deepEqual(single.slice(), [13], 'the single call result is exact');
  t.notOk(single.isLocked, 'the single call releases the monitor');
  t.end();
});

test('class literals of native-only JRE interfaces become Class objects', async (t) => {
  const classpath = compileJavaFixture(t, 'JitClassLiteralHarness', `
public class JitClassLiteralHarness {
  public static void store(Object[] out) {
    for (int i = 0; i < out.length; i++) {
      out[i] = javax.sound.sampled.SourceDataLine.class;
    }
  }
}
`);
  const jvm = new JVM({ classpath });
  await jvm.loadClassByName('JitClassLiteralHarness');
  const thread = attachThread(jvm, 'jit-class-literal-test');
  const out = typedArray('[Ljava/lang/Object;', [null, null]);
  await invoke(jvm, thread, 'JitClassLiteralHarness', 'store', '([Ljava/lang/Object;)V', [out]);
  await invoke(jvm, thread, 'JitClassLiteralHarness', 'store', '([Ljava/lang/Object;)V', [out]);
  t.equal(out[0]._classData.ast.classes[0].className,
    'javax/sound/sampled/SourceDataLine', 'the literal names SourceDataLine');
  t.equal(out[1], out[0], 'every iteration stores the same Class object');
  t.end();
});
