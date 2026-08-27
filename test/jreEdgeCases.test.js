'use strict';

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');

const File = require('../src/jre/java/io/File');
const FileInputStream = require('../src/jre/java/io/FileInputStream');
const ReflectField = require('../src/jre/java/lang/reflect/Field');
const Unsafe = require('../src/jre/sun/misc/Unsafe');
const HashMap = require('../src/jre/java/util/HashMap');
const Hashtable = require('../src/jre/java/util/Hashtable');
const Pattern = require('../src/jre/java/util/regex/Pattern');
const Matcher = require('../src/jre/java/util/regex/Matcher');
const StringClass = require('../src/jre/java/lang/String');
const Character = require('../src/jre/java/lang/Character');
const CRC32 = require('../src/jre/java/util/zip/CRC32');
const SourceDataLine = require('../src/jre/javax/sound/sampled/SourceDataLine');
const AudioSystem = require('../src/jre/javax/sound/sampled/AudioSystem');
const Toolkit = require('../src/jre/java/awt/Toolkit');
const ImageClass = require('../src/jre/java/awt/Image');
const PixelGrabber = require('../src/jre/java/awt/image/PixelGrabber');
const Graphics = require('../src/jre/java/awt/Graphics');
const { setAudioOutputFactory } = require('../src/platform/audio');
const { encodePng } = require('../src/io/pngEncoder');
const jpeg = require('jpeg-js');
const Class = require('../src/jre/java/lang/Class');
const Vector = require('../src/jre/java/util/Vector');
const StringBuffer = require('../src/jre/java/lang/StringBuffer');
const Thread = require('../src/jre/java/lang/Thread');
const ThreadGroup = require('../src/jre/java/lang/ThreadGroup');
const JNI = require('../src/core/jni');
const ByteBuffer = require('../src/jre/java/nio/ByteBuffer');
const NioPath = require('../src/jre/java/nio/file/Path');
const Random = require('../src/jre/java/util/Random');
const Collectors = require('../src/jre/java/util/stream/Collectors');
const Stream = require('../src/jre/java/util/stream/Stream');
const ActionEvent = require('../src/jre/java/awt/event/ActionEvent');
const SoftReference = require('../src/jre/java/lang/ref/SoftReference');

test('SoftReference retains, returns, and clears its referent', (t) => {
  const reference = {};
  const referent = { value: 7 };
  SoftReference.methods['<init>(Ljava/lang/Object;)V'](
    null, reference, [referent]);
  const Reference = require('../src/jre/java/lang/ref/Reference');
  t.equal(Reference.methods['get()Ljava/lang/Object;'](
    null, reference), referent, 'get inherits Reference semantics');
  Reference.methods['clear()V'](null, reference);
  t.equal(Reference.methods['get()Ljava/lang/Object;'](
    null, reference), null, 'clear releases the referent');
  t.end();
});

test('Math.round(double) returns a JVM long with Java edge semantics', (t) => {
  const jvm = new JVM({verbose: false});
  const round = jvm._jreFindMethod('java/lang/Math', 'round', '(D)J');
  t.equal(typeof round, 'function', 'the exact double-to-long descriptor resolves through the JVM');
  t.equal(round(jvm, null, [1.4]), 1n, 'rounds down below the midpoint');
  t.equal(round(jvm, null, [1.5]), 2n, 'rounds up at a positive midpoint');
  t.equal(round(jvm, null, [-1.5]), -1n, 'rounds a negative midpoint toward positive infinity');
  t.equal(round(jvm, null, [-1.6]), -2n, 'rounds down below a negative midpoint');
  t.equal(round(jvm, null, [NaN]), 0n, 'converts NaN to zero');
  t.equal(round(jvm, null, [Infinity]), 9223372036854775807n,
    'saturates positive infinity to Long.MAX_VALUE');
  t.equal(round(jvm, null, [-Infinity]), -9223372036854775808n,
    'saturates negative infinity to Long.MIN_VALUE');
  t.equal(round(jvm, null, [Number.MAX_VALUE]), 9223372036854775807n,
    'saturates an out-of-range finite double to Long.MAX_VALUE');
  t.equal(round(jvm, null, [-Number.MAX_VALUE]), -9223372036854775808n,
    'saturates an out-of-range finite double to Long.MIN_VALUE');
  t.end();
});
const { decodePng } = require('../src/io/gifDecoder');
const {
  getFileProvider,
  setFileProvider,
} = require('../src/core/classLoader');
const {
  completeReflectiveCall,
} = require('../src/instructions/control');

const JAVAC_AVAILABLE = (() => {
  try {
    execFileSync('javac', ['-version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
})();

function compileHarness(directory, filename, source) {
  const sourcePath = path.join(directory, filename);
  fs.writeFileSync(sourcePath, source);
  execFileSync('javac', [
    '-source', '8', '-target', '8', '-d', directory, sourcePath,
  ], { stdio: 'ignore' });
  return sourcePath;
}

function jvmStub() {
  return {
    nextHashCode: 1,
    internString(value) {
      const str = new String(String(value));
      str.type = 'java/lang/String';
      return str;
    },
  };
}

test('Character.toTitleCase supports the char descriptor', (t) => {
  const toTitleCase = Character.staticMethods['toTitleCase(C)C'];
  t.equal(typeof toTitleCase, 'function', 'the exact JRE method is registered');
  t.equal(toTitleCase(null, null, ['a'.charCodeAt(0)]), 'A'.charCodeAt(0),
    'lowercase ASCII is converted to title case');
  t.equal(toTitleCase(null, null, ['A'.charCodeAt(0)]), 'A'.charCodeAt(0),
    'existing title case is preserved');
  t.equal(toTitleCase(null, null, [0x00b5]), 0x039c,
    'Unicode title casing follows Java for the micro sign');
  t.end();
});

test('Class.newInstance reports InstantiationException for primitive classes', async (t) => {
  let error = null;
  try {
    await Class.methods['newInstance()Ljava/lang/Object;'](
      {}, { className: 'int', _classData: null }, [], null,
    );
  } catch (caught) {
    error = caught;
  }
  t.equal(error && error.type, 'java/lang/InstantiationException');
  t.end();
});

test('Path startsWith and endsWith compare path elements', (t) => {
  const startsWith = NioPath.methods['startsWith(Ljava/nio/file/Path;)Z'];
  const endsWith = NioPath.methods['endsWith(Ljava/nio/file/Path;)Z'];
  const nioPath = (value) => ({ type: 'java/nio/file/Path', path: value });

  t.equal(startsWith(null, nioPath('/foo/barbaz'), [nioPath('/foo/bar')]), 0,
    'a partial element prefix does not match');
  t.equal(startsWith(null, nioPath('/foo/bar'), [nioPath('/foo')]), 1,
    'a complete absolute element prefix matches');
  t.equal(endsWith(null, nioPath('/foo/bar'), [nioPath('bar')]), 1,
    'an absolute path can end with a relative path');
  t.equal(endsWith(null, nioPath('/foo/bar'), [nioPath('/bar')]), 0,
    'an absolute suffix must include the complete rooted path');
  t.equal(endsWith(null, nioPath('foo/bar'), [nioPath('bar')]), 1,
    'relative suffixes compare complete elements');
  t.equal(startsWith(null, nioPath(''), [nioPath('')]), 1,
    'the empty path starts with itself');
  t.equal(startsWith(null, nioPath('foo'), [nioPath('')]), 0,
    'a non-empty path does not start with the empty path');
  t.end();
});

test('Stream toMap collector evaluates key and value mappers', async (t) => {
  const calls = [];
  const keyMapper = {
    methods: {
      'apply(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
        calls.push(`key:${args[0]}`);
        return `key-${args[0]}`;
      },
    },
  };
  const valueMapper = {
    methods: {
      'apply(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
        calls.push(`value:${args[0]}`);
        return args[0] * 10;
      },
    },
  };
  const collector = Collectors.staticMethods[
    'toMap(Ljava/util/function/Function;Ljava/util/function/Function;)Ljava/util/stream/Collector;'
  ](null, null, [keyMapper, valueMapper]);
  const result = await Stream.methods[
    'collect(Ljava/util/stream/Collector;)Ljava/lang/Object;'
  ](jvmStub(), { array: [2, 3] }, [collector], null);

  t.deepEqual(calls, ['key:2', 'value:2', 'key:3', 'value:3'],
    'both mapper functions run once per stream element');
  t.equal(HashMap.methods['get(Ljava/lang/Object;)Ljava/lang/Object;'](
    jvmStub(), result, ['key-2'],
  ), 20, 'the mapped key addresses the mapped value');
  t.equal(HashMap.methods['get(Ljava/lang/Object;)Ljava/lang/Object;'](
    jvmStub(), result, ['key-3'],
  ), 30, 'all mapped entries are retained');
  t.equal(result.map.size, 2, 'the collector returns a two-entry HashMap');
  t.end();
});

test('Stream toMap collector rejects duplicate keys', async (t) => {
  const mapper = (callback) => ({
    methods: {
      'apply(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) =>
        callback(args[0]),
    },
  });
  const collector = Collectors.staticMethods[
    'toMap(Ljava/util/function/Function;Ljava/util/function/Function;)Ljava/util/stream/Collector;'
  ](null, null, [mapper(() => 'same'), mapper((value) => value)]);
  let error = null;
  try {
    await Stream.methods[
      'collect(Ljava/util/stream/Collector;)Ljava/lang/Object;'
    ](jvmStub(), { array: [1, 2] }, [collector], null);
  } catch (caught) {
    error = caught;
  }

  t.equal(error && error.type, 'java/lang/IllegalStateException');
  t.end();
});

test('Class reflective method lookup preserves array parameter descriptors', async (t) => {
  const method = {
    name: 'mix',
    descriptor: '([II)V',
    flags: ['public'],
  };
  const owner = {
    type: 'java/lang/Class',
    _classData: {
      ast: {
        classes: [{
          className: 'AudioScheduler',
          superClassName: null,
          items: [{ type: 'method', method }],
        }],
      },
    },
  };
  const intArray = {
    type: 'java/lang/Class',
    className: '[I',
    _classData: {
      isArray: true,
      className: '[I',
      componentType: 'I',
    },
  };
  const intClass = { isPrimitive: true, name: 'int' };
  const parameters = [intArray, intClass];

  const declared = Class.methods[
    'getDeclaredMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;'
  ]({}, owner, ['mix', parameters]);
  const inherited = await Class.methods[
    'getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;'
  ]({}, owner, ['mix', parameters]);

  t.equal(declared._methodData, method,
    'declared lookup encodes int[] as [I rather than L[I;');
  t.equal(inherited._methodData, method,
    'public lookup uses the same array descriptor encoding');
  const noArgs = {
    name: 'ready', descriptor: '()V', flags: ['public'],
  };
  owner._classData.ast.classes[0].items.push({type: 'method', method: noArgs});
  const nullDeclared = Class.methods[
    'getDeclaredMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;'
  ]({}, owner, ['ready', null]);
  const nullInherited = await Class.methods[
    'getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;'
  ]({}, owner, ['ready', null]);
  t.equal(nullDeclared._methodData, noArgs,
    'declared lookup treats a null varargs array as no parameters');
  t.equal(nullInherited._methodData, noArgs,
    'public lookup treats a null varargs array as no parameters');
  let nullParameterError = null;
  try {
    Class.methods[
      'getDeclaredMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;'
    ]({}, owner, ['mix', [intClass, null]]);
  } catch (error) {
    nullParameterError = error;
  }
  t.equal(nullParameterError && nullParameterError.type,
    'java/lang/IllegalArgumentException',
  'a null parameter type cannot silently shorten a method descriptor');
  t.end();
});

test('reflective constructors run their body through nested calls', async (t) => {
  if (!JAVAC_AVAILABLE) {
    t.skip('javac is unavailable');
    t.end();
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),
    'jvm-reflective-constructor-'));
  t.teardown(() => fs.rmSync(directory, { recursive: true, force: true }));
  compileHarness(directory, 'ReflectiveConstructorHarness.java', `
public final class ReflectiveConstructorHarness {
  static int result;
  private static final class Value {
    int value;
    private Value(long wide, double fraction, boolean enabled, int input) {
      super();
      value = adjust((int) wide + (int) fraction + (enabled ? input : 0));
    }
    private int adjust(int input) {
      return input * 3;
    }
  }
  public static void main(String[] args) throws Exception {
    java.lang.reflect.Constructor<Value> constructor =
      Value.class.getDeclaredConstructor(
        long.class, double.class, boolean.class, int.class);
    constructor.setAccessible(true);
    result = constructor.newInstance(
      Long.valueOf(4L), Double.valueOf(2.0), Boolean.TRUE,
      Integer.valueOf(7)).value;
  }
}
`);
  const jvm = new JVM({ classpath: directory, jit: { enabled: false } });
  await jvm.run('ReflectiveConstructorHarness');
  t.equal(jvm.classes.ReflectiveConstructorHarness.staticFields.get('result:I'),
    39,
  'wide and boxed constructor arguments reach the requested nested body');
  t.end();
});

test('generated void methods complete reflective calls with a null result', async (t) => {
  if (!JAVAC_AVAILABLE) {
    t.skip('javac is unavailable');
    t.end();
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),
    'jvm-reflective-generated-void-'));
  t.teardown(() => fs.rmSync(directory, { recursive: true, force: true }));
  compileHarness(directory, 'ReflectiveGeneratedVoidHarness.java', `
public final class ReflectiveGeneratedVoidHarness {
  static int result;
  static int calls;
  static int valueAfter;
  static int nullResult;
  private void fill(int[] values, int increment) {
    calls++;
    values[2] += increment;
  }
  public static void main(String[] args) throws Exception {
    ReflectiveGeneratedVoidHarness owner =
      new ReflectiveGeneratedVoidHarness();
    java.lang.reflect.Method method =
      ReflectiveGeneratedVoidHarness.class.getDeclaredMethod(
        "fill", int[].class, int.class);
    method.setAccessible(true);
    int[] values = { 1, 2, 3 };
    Object returned = method.invoke(owner, values, Integer.valueOf(7));
    valueAfter = values[2];
    nullResult = returned == null ? 1 : 0;
    result = calls * 100 + nullResult * 10 + valueAfter;
  }
}
`);
  const jvm = new JVM({ classpath: directory, jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
  } });
  await jvm.run('ReflectiveGeneratedVoidHarness');
  t.equal(
    jvm.classes.ReflectiveGeneratedVoidHarness.staticFields.get('calls:I'),
    1,
    'the reflected target runs once',
  );
  t.equal(
    jvm.classes.ReflectiveGeneratedVoidHarness.staticFields.get('nullResult:I'),
    1,
    'Method.invoke observes the generated void return as null',
  );
  t.equal(
    jvm.classes.ReflectiveGeneratedVoidHarness.staticFields.get('valueAfter:I'),
    10,
    'the reflected target receives the original array and boxed integer',
  );
  t.equal(
    jvm.classes.ReflectiveGeneratedVoidHarness.staticFields.get('result:I'),
    120,
    'the generated target returns null to Method.invoke before caller pop/branch',
  );
  t.end();
});

test('reflective completion clears state before invoking its resolver', (t) => {
  const frame = {};
  const thread = {
    isAwaitingReflectiveCall: true,
    reflectiveCallFrame: frame,
    reflectiveCallResolver() {
      throw new Error('resolver failed');
    },
  };
  t.throws(() => completeReflectiveCall(thread, null), /resolver failed/);
  t.equal(thread.isAwaitingReflectiveCall, false,
    'a throwing resolver cannot leave reflective mode active');
  t.equal(thread.reflectiveCallResolver, null,
    'a throwing resolver is detached before it runs');
  t.equal(thread.reflectiveCallFrame, null,
    'a throwing resolver cannot capture the next returning frame');
  t.end();
});

test('Vector.insertElementAt inserts in order and checks its index', (t) => {
  const vector = {};
  Vector.methods['<init>()V'](null, vector, []);
  Vector.methods['insertElementAt(Ljava/lang/Object;I)V'](
    null, vector, ['tail', 0],
  );
  Vector.methods['insertElementAt(Ljava/lang/Object;I)V'](
    null, vector, ['head', 0],
  );

  t.deepEqual(vector.items, ['head', 'tail']);
  t.equal(vector.size, 2);
  let error = null;
  try {
    Vector.methods['insertElementAt(Ljava/lang/Object;I)V'](
      null, vector, ['invalid', 3],
    );
  } catch (caught) {
    error = caught;
  }
  t.equal(error && error.type, 'java/lang/ArrayIndexOutOfBoundsException');
  t.end();
});

test('StringBuffer carries the same mutators as its StringBuilder twin', (t) => {
  const methods = StringBuffer.methods;
  const buffer = {};
  methods['<init>(Ljava/lang/String;)V'](null, buffer, ['abc']);

  t.equal(methods['charAt(I)C'](null, buffer, [0]), 97,
    'charAt returns the char code, not a one-character string');

  methods['setCharAt(IC)V'](null, buffer, [1, 'Z'.charCodeAt(0)]);
  t.equal(buffer.value, 'aZc', 'setCharAt replaces in place and leaves the length alone');

  methods['reverse()Ljava/lang/StringBuffer;'](null, buffer, []);
  t.equal(buffer.value, 'cZa', 'reverse flips the whole buffer');

  methods['setLength(I)V'](null, buffer, [2]);
  t.equal(buffer.value, 'cZ', 'shrinking drops the tail');
  methods['setLength(I)V'](null, buffer, [4]);
  t.equal(buffer.value, 'cZ\0\0', 'growing pads with NUL, matching the JDK');
  t.equal(methods['length()I'](null, buffer, []), 4,
    'the padding counts towards the length');

  // Both index-taking mutators report out-of-range the same way the JDK does.
  for (const [name, args] of [['charAt(I)C', [4]], ['setCharAt(IC)V', [4, 65]],
    ['charAt(I)C', [-1]], ['setLength(I)V', [-1]]]) {
    let error = null;
    try {
      methods[name](null, { value: 'abc' }, args);
    } catch (caught) {
      error = caught;
    }
    t.equal(error && error.type, 'java/lang/StringIndexOutOfBoundsException',
      `${name} rejects index ${args[0]}`);
  }
  t.end();
});

test('Thread.setName replaces the name getName reports and rejects null', (t) => {
  const methods = Thread.methods;
  const thread = { name: 'Thread-0' };
  const jvm = { internString: (value) => value };

  methods['setName(Ljava/lang/String;)V'](jvm, thread, ['loader']);
  t.equal(methods['getName()Ljava/lang/String;'](jvm, thread, []), 'loader',
    'setName is the write half of getName');

  let error = null;
  try {
    methods['setName(Ljava/lang/String;)V'](jvm, thread, [null]);
  } catch (caught) {
    error = caught;
  }
  t.equal(error && error.type, 'java/lang/NullPointerException',
    'a null name is rejected rather than silently stored');
  t.equal(thread.name, 'loader', 'the rejected call left the old name in place');
  t.end();
});

test('Vector.setSize pads with null when it grows and drops the tail when it shrinks', (t) => {
  const vector = {};
  const methods = Vector.methods;
  methods['<init>()V'](null, vector, []);
  methods['addElement(Ljava/lang/Object;)V'](null, vector, ['kept']);

  methods['setSize(I)V'](null, vector, [3]);
  t.deepEqual(vector.items, ['kept', null, null],
    'growing fills the new slots with null, not with undefined');
  t.equal(methods['size()I'](null, vector, []), 3,
    'the padded slots count towards the logical size');

  methods['setSize(I)V'](null, vector, [1]);
  t.deepEqual(vector.items, ['kept'], 'shrinking discards the tail');
  t.equal(methods['size()I'](null, vector, []), 1);

  let error = null;
  try {
    methods['setSize(I)V'](null, vector, [-1]);
  } catch (caught) {
    error = caught;
  }
  t.equal(error && error.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'a negative size indexes below the array, as it does in the JDK');
  t.end();
});

test('Vector legacy element mutators replace, remove and report by index', (t) => {
  const vector = {};
  const methods = Vector.methods;
  methods['<init>()V'](null, vector, []);
  methods['addElement(Ljava/lang/Object;)V'](null, vector, ['first']);
  methods['addElement(Ljava/lang/Object;)V'](null, vector, ['second']);

  methods['setElementAt(Ljava/lang/Object;I)V'](null, vector, ['replaced', 1]);
  t.deepEqual(vector.items, ['first', 'replaced'],
    'setElementAt takes the element first and the index second');
  t.equal(vector.size, 2, 'replacing an element does not change the size');

  t.equal(methods['removeElement(Ljava/lang/Object;)Z'](null, vector, ['absent']), 0,
    'removeElement reports false when the element is not present');
  t.equal(methods['removeElement(Ljava/lang/Object;)Z'](null, vector, ['first']), 1);
  t.deepEqual(vector.items, ['replaced']);

  methods['removeElementAt(I)V'](null, vector, [0]);
  t.equal(methods['isEmpty()Z'](null, vector, []), 1,
    'the size counter follows the removals');

  for (const [name, args] of [
    ['setElementAt(Ljava/lang/Object;I)V', ['x', 0]],
    ['removeElementAt(I)V', [0]],
  ]) {
    let error = null;
    try {
      methods[name](null, vector, args);
    } catch (caught) {
      error = caught;
    }
    t.equal(error && error.type, 'java/lang/ArrayIndexOutOfBoundsException',
      name + ' rejects an index at or past the size');
  }
  t.end();
});

test('Vector capacity is not content and addElement appends', (t) => {
  const vector = {};
  const methods = Vector.methods;
  methods['<init>(I)V'](null, vector, [8]);
  t.equal(methods['size()I'](null, vector, []), 0,
    'capacity constructor creates an empty Vector');
  methods['addElement(Ljava/lang/Object;)V'](null, vector, ['first']);
  t.equal(methods['add(Ljava/lang/Object;)Z'](null, vector, ['second']), 1,
    'Collection.add reports success');
  t.deepEqual(methods['toArray()[Ljava/lang/Object;'](null, vector, []),
    ['first', 'second'], 'legacy and Collection append paths share logical contents');
  t.end();
});

test('current and child threads inherit a non-null system thread group', (t) => {
  const jvm = jvmStub();
  const internalThread = {
    id: 0,
    name: 'main',
    status: 'runnable',
  };
  jvm.threads = [internalThread];
  jvm.currentThreadIndex = 0;

  const main = Thread.staticMethods['currentThread()Ljava/lang/Thread;'](
    jvm, null, [],
  );
  const group = Thread.methods['getThreadGroup()Ljava/lang/ThreadGroup;'](
    jvm, main, [],
  );
  const child = {};
  Thread.methods['<init>(Ljava/lang/Runnable;)V'](
    jvm, child, [{}], internalThread,
  );
  const enumerated = new Array(4);

  t.ok(group, 'the current JVM thread has a group');
  t.equal(
    ThreadGroup.methods['getParent()Ljava/lang/ThreadGroup;'](
      jvm, group, [],
    ),
    null,
    'the synthetic system group is the root',
  );
  t.equal(child.threadGroup, group, 'new threads inherit the current group');
  t.equal(
    ThreadGroup.methods['enumerate([Ljava/lang/Thread;)I'](
      jvm, group, [enumerated],
    ),
    1,
    'enumeration includes the active main thread',
  );
  t.equal(enumerated[0], main);

  const nativeJvm = jvmStub();
  nativeJvm.threads = [{ id: 0, name: 'main', status: 'runnable' }];
  nativeJvm.currentThreadIndex = 0;
  const nativeCurrentThread = new JNI(nativeJvm).findNativeMethod(
    'java/lang/Thread', 'currentThread', '()Ljava/lang/Thread;',
  );
  const nativeMain = nativeCurrentThread(nativeJvm, null, [],
    nativeJvm.threads[0]);
  t.ok(nativeMain.threadGroup,
    'the JNI currentThread path supplies the same group semantics');
  t.end();
});

test('ByteBuffer exposes the covariant Buffer position bridge', (t) => {
  const buffer = ByteBuffer.staticMethods[
    'allocateDirect(I)Ljava/nio/ByteBuffer;'
  ](null, null, [8]);
  buffer['java/nio/Buffer/mark'] = 6;
  const result = ByteBuffer.methods[
    'position(I)Ljava/nio/Buffer;'
  ](null, buffer, [4]);

  t.equal(result, buffer);
  t.equal(buffer['java/nio/Buffer/position'], 4);
  t.equal(buffer['java/nio/Buffer/mark'], -1,
    'moving before the mark discards it');
  t.end();
});

test('Random.nextGaussian uses the JVM random state directly', (t) => {
  const random = {};
  Random.methods['<init>(J)V'](null, random, [0n]);
  const first = Random.methods['nextGaussian()D'](null, random, []);
  const second = Random.methods['nextGaussian()D'](null, random, []);

  t.ok(Number.isFinite(first));
  t.ok(Number.isFinite(second));
  t.equal(random['java/util/Random/haveNextNextGaussian'], false,
    'the second call consumes the cached Box-Muller result');
  t.end();
});

test('PNG decoder reconstructs Adam7 interlaced pixels', (t) => {
  const encoded = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAAGuTRJ+AAAAIGNIUk0AAHomAACAhAAA' +
    '+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdE' +
    'lNRQfqBxcIDQC/WA6HAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA3LTIzVDA4OjEz' +
    'OjAwKzAwOjAwuR0kogAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wNy0yM1QwODoxMz' +
    'owMCswMDowMMhAnB4AAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDctMjNUMDg6' +
    'MTM6MDArMDA6MDCfVb3BAAAAHElEQVQI1wXBAQ0AAAjAIJzFbX5BoFU3QyQVygO2Zw' +
    'x6AjvG6AAAAABJRU5ErkJggg==',
    'base64',
  );
  const image = decodePng(encoded);

  t.equal(image.width, 3);
  t.equal(image.height, 3);
  t.deepEqual(image.pixels.map((pixel) => pixel >>> 0), [
    0xffff0000, 0xff00ff00, 0xff0000ff,
    0xffffffff, 0xff000000, 0xffffff00,
    0xff00ffff, 0xffff00ff, 0xff808080,
  ]);
  t.end();
});

test('File constructors coerce Java String objects without value fields', (t) => {
  const jvm = jvmStub();
  const parent = jvm.internString('tmp');
  const child = jvm.internString('child.txt');
  const obj = {};

  File.methods['<init>(Ljava/lang/String;Ljava/lang/String;)V'](jvm, obj, [parent, child]);

  t.equal(obj.path, path.join('tmp', 'child.txt'));
  t.end();
});

test('HashMap.computeIfAbsent does not record null mapping results', async (t) => {
  const map = {};
  const fn = {
    methods: {
      'apply(Ljava/lang/Object;)Ljava/lang/Object;': () => null,
    },
  };

  HashMap.methods['<init>()V'](null, map, []);
  const value = await HashMap.methods[
    'computeIfAbsent(Ljava/lang/Object;Ljava/util/function/Function;)Ljava/lang/Object;'
  ](null, map, ['k', fn]);

  t.equal(value, null);
  t.equal(HashMap.methods['containsKey(Ljava/lang/Object;)Z'](null, map, ['k']), 0);
  t.equal(HashMap.methods['size()I'](null, map, []), 0);
  t.end();
});

test('Hashtable capacity constructors initialize storage', (t) => {
  for (const [descriptor, args] of [['<init>(I)V', [16]], ['<init>(IF)V', [16, 0.75]]]) {
    const table = {};
    Hashtable.methods[descriptor](null, table, args);
    Hashtable.methods['put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;'](
      null, table, ['key', 'value'],
    );
    t.equal(Hashtable.methods['get(Ljava/lang/Object;)Ljava/lang/Object;'](
      null, table, ['key'],
    ), 'value', `${descriptor} creates usable backing storage`);
  }
  t.end();
});

test('ActionEvent constructors retain event state', (t) => {
  const event = {};
  const source = {};
  ActionEvent.methods['<init>(Ljava/lang/Object;ILjava/lang/String;JI)V'](
    null, event, [source, 1001, 'launch', 42n, 3],
  );
  t.equal(ActionEvent.methods['getSource()Ljava/lang/Object;'](null, event), source);
  t.equal(ActionEvent.methods['getActionCommand()Ljava/lang/String;'](null, event), 'launch');
  t.equal(ActionEvent.methods['getWhen()J'](null, event), 42n);
  t.equal(ActionEvent.methods['getModifiers()I'](null, event), 3);
  t.end();
});

test('CRC32 treats signed Java bytes as unsigned octets', (t) => {
  const obj = {};

  CRC32.methods['<init>()V'](null, obj, []);
  CRC32.methods['update([BII)V'](null, obj, [[-1, 0, 127, -128], 0, 4]);

  t.equal(CRC32.methods['getValue()J'](null, obj, []), 0xba5e3ff4n);
  t.end();
});

test('FileInputStream reads browser virtual files without a Node fs backend', async (t) => {
  const previousProvider = getFileProvider();
  setFileProvider({
    async readFile(filePath) {
      t.equal(filePath, 'track.wav', 'the Java String path is normalized');
      return new Uint8Array([0, 127, 128, 255]);
    },
  });
  t.teardown(() => setFileProvider(previousProvider));
  const input = {};
  await FileInputStream.methods['<init>(Ljava/lang/String;)V'](
    null, input, [{ value: 'track.wav' }]);
  const target = [0, 0, 0, 0];
  const count = FileInputStream.methods['read([BII)I'](
    null, input, [target, 0, target.length]);
  t.equal(count, 4, 'the virtual file is readable through Java IO');
  t.deepEqual(target, [0, 127, -128, -1],
    'browser bytes preserve Java signed-byte semantics');
  t.end();
});

test('reflective fields use normal JVM instance storage', (t) => {
  const declaringClass = {
    _classData: { ast: { classes: [{ className: 'ui' }] } },
  };
  const arrayField = {
    _declaringClass: declaringClass,
    _fieldData: { name: 'y', descriptor: '[I', accessFlags: 0 },
  };
  const booleanField = {
    _declaringClass: declaringClass,
    _fieldData: { name: 'w', descriptor: 'Z', accessFlags: 0 },
  };
  const values = [3, 7, 11];
  const object = { fields: { 'ui.y': values, 'ui.w': 1 } };
  t.equal(ReflectField.methods['get(Ljava/lang/Object;)Ljava/lang/Object;'](
    null, arrayField, [object]), values,
  'Field.get reads the owner-qualified instance slot');
  ReflectField.methods['setBoolean(Ljava/lang/Object;Z)V'](
    null, booleanField, [object, 0]);
  t.equal(object.fields['ui.w'], 0,
    'Field.setBoolean writes the owner-qualified instance slot');
  t.end();
});

test('reflective and Unsafe static writes invalidate JIT capture containers',
  (t) => {
  const staticFields = new Map([['value:I', 1]]);
  const invalidated = [];
  const jvm = {
    jit: {
      markStaticContainerChanged(fields) {
        invalidated.push(fields);
      },
    },
  };
  const classData = {
    staticFields,
    ast: { classes: [{ className: 'StaticWriteHarness' }] },
  };
  const declaringClass = { _classData: classData };
  const field = {
    _declaringClass: declaringClass,
    _fieldData: { name: 'value', descriptor: 'I', accessFlags: 0x0008 },
  };

  ReflectField.methods['setInt(Ljava/lang/Object;I)V'](
    jvm, field, [null, 7]);
  t.equal(staticFields.get('value:I'), 7,
    'reflection updates the canonical descriptor-qualified static slot');
  t.equal(invalidated.shift(), staticFields,
    'reflection invalidates capture caches for the static container');

  const offset = Unsafe.methods[
    'staticFieldOffset(Ljava/lang/reflect/Field;)J'
  ](jvm, null, [field]);
  const base = Unsafe.methods[
    'staticFieldBase(Ljava/lang/reflect/Field;)Ljava/lang/Object;'
  ](jvm, null, [field]);
  Unsafe.methods['putInt(Ljava/lang/Object;JI)V'](
    jvm, null, [base, offset, 11]);
  t.equal(staticFields.get('value:I'), 11,
    'Unsafe updates the same canonical static slot');
  t.equal(invalidated.shift(), staticFields,
    'Unsafe invalidates capture caches for the static container');
  t.end();
});

test('headless SourceDataLine discard sink closes cleanly', (t) => {
  const obj = {};
  const format = {
    fields: {
      'javax/sound/sampled/AudioFormat': {},
    },
  };

  setAudioOutputFactory(() => { throw new Error('no audio device'); });
  SourceDataLine.methods['open(Ljavax/sound/sampled/AudioFormat;)V'](null, obj, [format]);
  t.doesNotThrow(() => SourceDataLine.methods['close()V'](null, obj, []));
  setAudioOutputFactory(null);
  t.end();
});

test('AudioSystem preserves DataLine.Info format for no-arg open', (t) => {
  const formatFields = {
    sampleRate: 22050,
    sampleSizeInBits: 16,
    channels: 1,
    signed: 1,
    bigEndian: 0,
  };
  const format = {
    fields: {
      'javax/sound/sampled/AudioFormat': formatFields,
    },
  };
  const info = {
    fields: {
      'javax/sound/sampled/Line$Info': {
        lineClass: {
          _classData: {
            ast: { classes: [{ className: 'javax/sound/sampled/SourceDataLine' }] },
          },
        },
      },
      'javax/sound/sampled/DataLine$Info': {
        formats: { elements: [format] },
        minBufferSize: 2048,
        maxBufferSize: 2048,
      },
    },
  };
  const jvm = { nextHashCode: 1 };
  let openedOptions = null;
  setAudioOutputFactory((options) => {
    openedOptions = options;
    return { write() {}, once(_event, callback) { callback(); }, end() {} };
  });
  t.teardown(() => setAudioOutputFactory(null));

  const line = AudioSystem.staticMethods[
    'getLine(Ljavax/sound/sampled/Line$Info;)Ljavax/sound/sampled/Line;'
  ](jvm, null, [info]);
  SourceDataLine.methods['open()V'](jvm, line, []);

  t.equal(line.requestedFormat, format,
    'getLine retains the format selected by DataLine.Info');
  t.equal(line.requestedBufferSize, 2048,
    'getLine retains the requested buffer size');
  t.deepEqual(openedOptions, {
    channels: 1,
    bitDepth: 16,
    sampleRate: 22050,
    signed: 1,
    bigEndian: 0,
    bufferSize: 2048,
  }, 'no-arg open creates the concrete output with the negotiated format');
  t.ok(line.isOpen, 'the line is open after the inherited Java Sound sequence');
  t.end();
});

test('disabled SourceDataLine applies backpressure', (t) => {
  const previous = process.env.JVM_DISABLE_AUDIO;
  process.env.JVM_DISABLE_AUDIO = '1';

  t.equal(SourceDataLine.methods['available()I'](null, {}, []), 0);

  if (previous === undefined) delete process.env.JVM_DISABLE_AUDIO;
  else process.env.JVM_DISABLE_AUDIO = previous;
  t.end();
});

test('SourceDataLine models the line draining in real time', (t) => {
  // Neither backend reports occupancy, so before this model available() always
  // claimed an empty buffer, the guest's own audio throttle never engaged, and
  // the pump spun -- 161x the pump calls and 2.4x the post-logo load on Tomb
  // Racer. 22050 Hz, 16-bit stereo is 88200 bytes/sec.
  // The runner sets JVM_DISABLE_AUDIO=1 for the whole suite, and available()
  // deliberately reports a FULL buffer in that mode -- maximum backpressure is
  // the point of headless mode, and the test above pins it. The drain model
  // only governs the enabled-audio path, so exercise that regime here.
  // Supplying the sink explicitly keeps this hermetic: no real device is
  // opened, and a sink with no available() of its own is precisely the case
  // the drain model exists to cover.
  const previousDisableAudio = process.env.JVM_DISABLE_AUDIO;
  delete process.env.JVM_DISABLE_AUDIO;
  setAudioOutputFactory(() => ({ write() {}, end() {},
    once(_event, callback) { callback(); } }));
  t.teardown(() => {
    setAudioOutputFactory(null);
    if (previousDisableAudio === undefined) delete process.env.JVM_DISABLE_AUDIO;
    else process.env.JVM_DISABLE_AUDIO = previousDisableAudio;
  });

  let millis = 1000;
  const jvm = {
    clock: { millis: () => millis },
    jre: { 'javax/sound/sampled/SourceDataLine': SourceDataLine },
  };
  const format = {
    fields: {
      'javax/sound/sampled/AudioFormat': {
        channels: 2,
        sampleSizeInBits: 16,
        sampleRate: 22050,
        signed: true,
        bigEndian: false,
      },
    },
  };
  const obj = { requestedBufferSize: 8192 };
  const available = () => SourceDataLine.methods['available()I'](jvm, obj, []);

  SourceDataLine.methods['open(Ljavax/sound/sampled/AudioFormat;I)V'](
    jvm, obj, [format, 8192]);
  t.equal(available(), 8192, 'a freshly opened line has its whole buffer free');

  const samples = new Array(8192).fill(0);
  SourceDataLine.methods['write([BII)I'](jvm, obj, [samples, 0, 8192], null);
  t.equal(available(), 0, 'a full buffer reports no space, so the guest throttles');

  millis += 46;
  t.equal(available(), 4057, 'the buffer frees at the line sample rate');

  millis += 100;
  t.equal(available(), 8192, 'the buffer never drains past empty');

  SourceDataLine.methods['write([BII)I'](jvm, obj, [samples, 0, 4096], null);
  t.equal(available(), 4096, 'a partial write leaves the remainder free');

  SourceDataLine.methods['flush()V'](jvm, obj, []);
  t.equal(available(), 8192, 'flush discards what was queued');

  SourceDataLine.methods['close()V'](jvm, obj, []);
  t.equal(obj.drainModel, null, 'closing the line drops the drain model');
  t.end();
});

test('SourceDataLine audio priority uses the scheduler clock', (t) => {
  const output = {
    write() {},
    queuedSeconds() { return 0; },
  };
  const line = { audioOutput: output, isOpen: true };
  const thread = { id: 7, status: 'runnable' };
  const jvm = {
    clock: { millis() { return 1250; } },
    _audioPriority: null,
  };
  SourceDataLine.methods['write([BII)I'](
    jvm, line, [[0, 0], 0, 2], thread,
  );
  t.equal(jvm._audioPriority.until, 1300,
    'the priority deadline is derived from the scheduler clock');
  t.equal(jvm._audioPriority.thread, thread,
    'the producing guest thread receives temporary priority');
  t.end();
});

test('suspended browser audio does not starve other JVM threads', (t) => {
  const thread = { id: 7 };
  const output = {
    context: { state: 'suspended' },
    queuedSeconds: () => 0,
    write() {},
  };
  const line = { audioOutput: output, isOpen: true, drainModel: null };
  const jvm = {
    clock: { millis: () => 1250 },
    _audioPriority: null,
  };
  SourceDataLine.methods['write([BII)I'](
    jvm, line, [[1, 2, 3, 4], 0, 4], thread);
  t.equal(jvm._audioPriority, null,
    'a suspended AudioContext cannot renew scheduler priority');
  t.end();
});

test('SourceDataLine avoids copying for outputs that accept guest slices', (t) => {
  const writes = [];
  const output = {
    acceptsGuestByteArraySlices: true,
    write(...args) { writes.push(args); },
  };
  const line = { audioOutput: output, isOpen: true };
  const samples = [-128, -1, 0, 127];

  const written = SourceDataLine.methods['write([BII)I'](
    { clock: { millis: () => 0 } }, line, [samples, 1, 2], null,
  );
  t.equal(written, 2, 'the Java Sound write count is unchanged');
  t.equal(writes[0][0], samples, 'the output receives the original guest array');
  t.deepEqual(writes[0].slice(1), [1, 2],
    'the exact offset and length accompany the unallocated slice');
  t.end();
});

test('Toolkit decodes GIF dimensions and PixelGrabber pixels', (t) => {
  const gif = Array.from(
    Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
    (value) => (value << 24) >> 24,
  );
  const image = Toolkit.methods['createImage([B)Ljava/awt/Image;'](null, null, [gif]);
  const target = [0];
  const grabber = {};

  t.equal(ImageClass.methods['getWidth(Ljava/awt/image/ImageObserver;)I'](null, image, [null]), 1);
  t.equal(ImageClass.methods['getHeight(Ljava/awt/image/ImageObserver;)I'](null, image, [null]), 1);
  PixelGrabber.methods['<init>(Ljava/awt/Image;IIII[III)V'](
    null,
    grabber,
    [image, 0, 0, 1, 1, target, 0, 1],
  );
  t.equal(PixelGrabber.methods['grabPixels()Z'](null, grabber, []), 1);
  t.equal(target[0] >>> 0, 0xffffffff);
  t.end();
});

test('Toolkit decodes PNG pixels', (t) => {
  const png = Array.from(encodePng([0x123456, 0xabcdef], 2, 1), (value) => (value << 24) >> 24);
  const image = Toolkit.methods['createImage([B)Ljava/awt/Image;'](null, null, [png]);

  t.equal(image._width, 2);
  t.equal(image._height, 1);
  t.deepEqual(image._pixels.map((pixel) => pixel >>> 0), [0xff123456, 0xffabcdef]);
  t.end();
});

test('Toolkit preserves hidden RGB channels in transparent PNG pixels', (t) => {
  const encoded = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDctMjNUMTA6MzY6NDYrMDA6MDAnzl/8AAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTA3LTIzVDEwOjM2OjQ2KzAwOjAwVpPnQAAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wNy0yM1QxMDozNjo0NiswMDowMAGGxp8AAAANSURBVAjXYxAyCWMAAAGVAJ22RGelAAAAAElFTkSuQmCC',
    'base64',
  );
  const png = Array.from(encoded, (value) => (value << 24) >> 24);
  const image = Toolkit.methods['createImage([B)Ljava/awt/Image;'](null, null, [png]);

  t.equal(image._pixels[0] >>> 0, 0x00123456,
    'transparent ARGB retains its nonzero RGB payload');
  t.end();
});

test('Toolkit decodes JPEG dimensions and pixels', (t) => {
  const encoded = jpeg.encode({
    width: 1,
    height: 1,
    data: Buffer.from([220, 40, 20, 255]),
  }, 100).data;
  const image = Toolkit.methods['createImage([B)Ljava/awt/Image;'](null, null, [encoded]);
  const pixel = image._pixels[0] >>> 0;

  t.equal(image._width, 1);
  t.equal(image._height, 1);
  t.ok((pixel >> 16 & 0xff) > 180, 'red channel survives JPEG decoding');
  t.end();
});

test('AWT producer blits coalesce dirty presentation on animation frames', (t) => {
  const previousRaf = global.requestAnimationFrame;
  const callbacks = [];
  global.requestAnimationFrame = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  const uploads = [];
  const context = {
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData(image) {
      uploads.push(Array.from(image.data));
    },
  };
  const target = {
    _width: 2,
    _height: 1,
    _canvasElement: { width: 2, height: 1, getContext: () => context },
  };
  const jvm = {};
  const graphics = { _component: target };
  const sourcePixels = [0x112233, 0xaabbcc];
  const image = {
    _producer: { width: 2, height: 1, pixels: sourcePixels },
  };
  const draw = Graphics.methods['drawImage(Ljava/awt/Image;IILjava/awt/image/ImageObserver;)Z'];

  t.equal(draw(jvm, graphics, [image, 0, 0, null]), 1,
    'software producer image is accepted');
  t.equal(draw(jvm, graphics, [image, 0, 0, null]), 1,
    'a second dirty frame is accepted before presentation');
  t.equal(callbacks.length, 1, 'dirty frames share one pending animation callback');
  t.equal(jvm._awtPresentationStats.coalesced, 1, 'coalesced frame is counted');
  t.equal(jvm._awtDroppedFrameBacklog, 1,
    'a superseded completed frame is published as presentation backpressure');
  const resumed = [];
  jvm._awtPresentationWaiters = [() => resumed.push('parked scheduler')];
  t.notEqual(target._pixels, sourcePixels, 'full-frame publication snapshots the producer buffer');
  sourcePixels[0] = 0xffffff;
  t.equal(target._pixels[0], 0x112233, 'published frame is stable while producer renders the next frame');

  callbacks.shift()(0);
  t.equal(uploads.length, 1, 'latest dirty surface is uploaded once');
  t.deepEqual(uploads[0], [0x11, 0x22, 0x33, 0xff, 0xaa, 0xbb, 0xcc, 0xff],
    'RGB producer pixels are converted to RGBA ImageData');
  t.equal(jvm._awtPresentationStats.presented, 1, 'completed upload is counted');
  t.equal(jvm._awtDroppedFrameBacklog, 0,
    'presenting the newest surface clears the dropped-frame backlog');
  t.deepEqual(resumed, ['parked scheduler'],
    'a scheduler parked on the presentation is released by the upload');

  if (previousRaf === undefined) delete global.requestAnimationFrame;
  else global.requestAnimationFrame = previousRaf;
  t.end();
});

test('AWT presentation recovers when an animation callback is starved', (t) => {
  const previousRaf = global.requestAnimationFrame;
  const callbacks = [];
  global.requestAnimationFrame = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  const uploads = [];
  const context = {
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData(image) {
      uploads.push(Array.from(image.data));
    },
  };
  const target = {
    _width: 2,
    _height: 1,
    _canvasElement: { width: 2, height: 1, getContext: () => context },
  };
  const jvm = { eventLoopYieldMs: 16 };
  const graphics = { _component: target };
  const image = {
    _producer: { width: 2, height: 1, pixels: [0x112233, 0xaabbcc] },
  };
  const draw = Graphics.methods[
    'drawImage(Ljava/awt/Image;IILjava/awt/image/ImageObserver;)Z'
  ];

  draw(jvm, graphics, [image, 0, 0, null]);
  draw(jvm, graphics, [image, 0, 0, null]);
  t.equal(callbacks.length, 1,
    'one animation callback owns the coalesced frame');
  setTimeout(() => {
    t.equal(uploads.length, 1,
      'the fallback timer uploads the latest completed surface');
    t.equal(jvm._awtPresentationStats.presented, 1,
      'the recovered upload is counted as a presentation');
    t.equal(jvm._awtPresentationStats.presentationFallbacks, 1,
      'diagnostics identify the starved-animation recovery');
    t.notOk(target._presentScheduled,
      'the fallback clears the coalescing latch');
    // A late callback from the starved queue must not upload twice or clear a
    // newer presentation token.
    callbacks.shift()(0);
    t.equal(uploads.length, 1,
      'the late animation callback is harmless');
    if (previousRaf === undefined) delete global.requestAnimationFrame;
    else global.requestAnimationFrame = previousRaf;
    t.end();
  }, 60);
});

test('headless AWT blits expose an uncapped coalesced presentation boundary', (t) => {
  const target = { _width: 2, _height: 1 };
  const jvm = {};
  const graphics = { _component: target };
  const image = {
    _producer: { width: 2, height: 1, pixels: [0x112233, 0xaabbcc] },
  };
  const draw = Graphics.methods[
    'drawImage(Ljava/awt/Image;IILjava/awt/image/ImageObserver;)Z'
  ];

  t.equal(draw(jvm, graphics, [image, 0, 0, null]), 1);
  t.equal(draw(jvm, graphics, [image, 0, 0, null]), 1);
  t.equal(jvm._awtPresentationStats.scheduled, 1,
    'one host-turn presentation is scheduled without a browser canvas');
  t.equal(jvm._awtPresentationStats.coalesced, 1,
    'multiple publications in the same turn are coalesced');
  t.equal(jvm._awtPresentationStats.presented, 0,
    'presentation is not counted before its event-loop boundary');

  setImmediate(() => {
    t.equal(jvm._awtPresentationStats.presented, 1,
      'completed headless software frame is counted');
    t.equal(target._presentedVersion, target._pixelsVersion,
      'the counted boundary observes the latest published surface');
    t.end();
  });
});

test('AWT full-frame presentation uses exact Wasm RGB swizzle', (t) => {
  const previousRaf = global.requestAnimationFrame;
  const callbacks = [];
  global.requestAnimationFrame = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  const width = 256;
  const height = 256;
  const count = width * height;
  const sourcePixels = new Int32Array(count);
  sourcePixels[0] = 0x010203;
  sourcePixels[count >> 1] = 0x7f80ff;
  sourcePixels[count - 1] = 0xfedcba;
  let uploaded = null;
  const context = {
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(image) {
      const middle = (count >> 1) * 4;
      const last = (count - 1) * 4;
      uploaded = {
        first: Array.from(image.data.subarray(0, 4)),
        middle: Array.from(image.data.subarray(middle, middle + 4)),
        last: Array.from(image.data.subarray(last, last + 4)),
      };
    },
  };
  const target = {
    _width: width,
    _height: height,
    _canvasElement: { width, height, getContext: () => context },
  };
  const jvm = {};
  const graphics = { _component: target };
  const image = { _producer: { width, height, pixels: sourcePixels } };
  const draw = Graphics.methods['drawImage(Ljava/awt/Image;IILjava/awt/image/ImageObserver;)Z'];

  t.equal(draw(jvm, graphics, [image, 0, 0, null]), 1);
  t.equal(callbacks.length, 1, 'full frame schedules one presentation');
  callbacks.shift()(0);

  t.deepEqual(uploaded, {
    first: [0x01, 0x02, 0x03, 0xff],
    middle: [0x7f, 0x80, 0xff, 0xff],
    last: [0xfe, 0xdc, 0xba, 0xff],
  }, 'Wasm conversion preserves RGB channels and supplies opaque alpha');
  t.equal(jvm._awtPresentationStats.wasmSwizzles, 1,
    'large presentation records the Wasm swizzle path');
  t.equal(jvm._awtPresentationStats.jsSwizzles, 0,
    'large presentation does not execute the scalar JS converter');

  if (previousRaf === undefined) delete global.requestAnimationFrame;
  else global.requestAnimationFrame = previousRaf;
  t.end();
});

test('String.format supports javac varargs object array hex formatting', (t) => {
  const jvm = jvmStub();
  const result = StringClass.staticMethods['format(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;'](jvm, null, [
    jvm.internString('#%02x%02x%02x'),
    [
      { type: 'java/lang/Integer', value: 255 },
      { type: 'java/lang/Integer', value: 0 },
      { type: 'java/lang/Integer', value: 0 },
    ],
  ]);

  t.equal(result.toString(), '#ff0000');
  t.end();
});

test('regex Pattern flags apply to matcher, split, and replace operations', (t) => {
  const jvm = jvmStub();
  const literalDot = Pattern.staticMethods['compile(Ljava/lang/String;I)Ljava/util/regex/Pattern;'](jvm, null, [
    jvm.internString('.'),
    Pattern.staticFields['LITERAL:I'],
  ]);
  const matcher = Pattern.methods['matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;'](jvm, literalDot, [
    jvm.internString('a.b'),
  ]);

  t.equal(Matcher.methods['find()Z'](jvm, matcher, []), 1, 'literal dot finds the actual dot');
  t.equal(Matcher.methods['group()Ljava/lang/String;'](jvm, matcher, []).toString(), '.', 'literal dot group is the dot');
  const split = Pattern.methods['split(Ljava/lang/CharSequence;)[Ljava/lang/String;'](jvm, literalDot, [jvm.internString('a.b')]);
  t.deepEqual(split.map(String), ['a', 'b'], 'split uses quoted literal pattern');

  const replaced = Matcher.methods['replaceAll(Ljava/lang/String;)Ljava/lang/String;'](jvm, matcher, [jvm.internString('X')]);
  t.equal(replaced.toString(), 'aXb', 'replaceAll uses quoted literal pattern');

  const dotAll = Pattern.staticMethods['compile(Ljava/lang/String;I)Ljava/util/regex/Pattern;'](jvm, null, [
    jvm.internString('a.b'),
    Pattern.staticFields['DOTALL:I'],
  ]);
  const dotAllMatcher = Pattern.methods['matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;'](jvm, dotAll, [
    jvm.internString('a\nb'),
  ]);
  t.equal(Matcher.methods['matches()Z'](jvm, dotAllMatcher, []), 1, 'DOTALL lets dot match newline');

  t.end();
});

test('regex Matcher reports capture-group start and end offsets', (t) => {
  const jvm = jvmStub();
  const pattern = Pattern.staticMethods['compile(Ljava/lang/String;)Ljava/util/regex/Pattern;'](jvm, null, [
    jvm.internString('a(b+)c'),
  ]);
  const matcher = Pattern.methods['matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;'](jvm, pattern, [
    jvm.internString('xxabbc'),
  ]);

  t.equal(Matcher.methods['find()Z'](jvm, matcher, []), 1);
  t.equal(Matcher.methods['start(I)I'](jvm, matcher, [1]), 3);
  t.equal(Matcher.methods['end(I)I'](jvm, matcher, [1]), 5);
  t.end();
});
