const test = require('tape');
const DebugController = require('../src/debug/debugController');
const { evaluateInLiveJvm } = require('../src/debug/evaluator');
const { JVM } = require('../src/core/jvm');
const { compileJavaSource } = require('../src/java-frontend');
const { assembleJasminBytes } = require('../src/utils/jasminAssembly');
const { convertJson } = require('../src/parsing/convert_tree');
const { getAST } = require('jvm_parser');

// Install a genuinely compiled class into a live JVM, the same way an
// applet's classes arrive.
function installSource(jvm, source) {
  const compiled = compileJavaSource(source, { sourceLevel: 8 });
  for (const classModel of compiled.classFileModel.classes) {
    const raw = getAST(assembleJasminBytes(classModel.jasmin, {}));
    const classData = {
      ast: convertJson(raw.ast, raw.constantPool),
      constantPool: raw.constantPool,
      staticFields: new Map(),
    };
    jvm.classes[classData.ast.classes[0].className] = classData;
  }
}

test('evaluate is refused unless debug mode is enabled', async (t) => {
  const jvm = new JVM({ jit: { enabled: false } });
  try {
    await evaluateInLiveJvm(jvm, '1 + 1');
    t.fail('evaluation should be refused without debug mode');
  } catch (error) {
    t.ok(/debug mode/i.test(error.message),
      'refused with a debug-mode message: ' + error.message);
  }
  t.end();
});

test('evaluate returns the value of an expression snippet', async (t) => {
  const controller = new DebugController({ jit: { enabled: false } });
  controller.jvm.debugManager.enable();

  const sum = await controller.evaluate('2 + 3 * 4');
  t.equal(sum.status, 'ok', 'expression evaluated');
  t.equal(sum.value, 14, '2 + 3 * 4 === 14');
  t.equal(sum.kind, 'expression', 'classified as an expression');

  const bool = await controller.evaluate('5 > 2');
  t.equal(Boolean(bool.value), true, 'boolean expression evaluates to true');

  t.end();
});

test('evaluate observes static state of a class already in the live JVM',
  async (t) => {
    const controller = new DebugController({ jit: { enabled: false } });
    const jvm = controller.jvm;
    jvm.debugManager.enable();

    // A real compiled class, already resident, as a debugged applet's are.
    // A hand-built AST would not carry field descriptors, and the compiler
    // would then widen `ticks` to Object rather than resolving it as int.
    installSource(jvm, 'public class LiveCounter { public static int ticks; }');
    jvm.classes['LiveCounter'].staticFields.set('ticks:I', 41);
    jvm.classInitializationState.set('LiveCounter', 'INITIALIZED');

    const before = await controller.evaluate('LiveCounter.ticks');
    t.equal(before.value, 41, 'reads live static field');

    // The frontend cannot type a field of a class it did not compile, so a
    // write would land in a phantom `ticks:Ljava/lang/Object;` entry and leave
    // the program untouched.  That must be refused, not silently accepted.
    try {
      await controller.evaluate('LiveCounter.ticks = LiveCounter.ticks + 1;');
      t.fail('an unresolvable cross-class write should be refused');
    } catch (error) {
      t.ok(/cannot resolve the type of LiveCounter\.ticks/.test(error.message),
        'refused with an explanatory message: ' + error.message);
    }
    t.equal(jvm.classes['LiveCounter'].staticFields.get('ticks:I'), 41,
      'the live field is left untouched by the refused snippet');
    t.equal(jvm.classes['LiveCounter'].staticFields
      .has('ticks:Ljava/lang/Object;'), false, 'no phantom field was created');

    t.end();
  });

test('evaluate leaves the debugger paused and the thread list intact',
  async (t) => {
    const controller = new DebugController({ jit: { enabled: false } });
    const jvm = controller.jvm;
    jvm.debugManager.enable();
    jvm.debugManager.pause();

    const appThread = { id: 7, name: 'app', callStack: { isEmpty: () => true },
      status: 'runnable' };
    jvm.threads = [appThread];
    jvm.currentThreadIndex = 0;

    await controller.evaluate('1 + 1');

    t.equal(jvm.threads.length, 1, 'thread list restored');
    t.equal(jvm.threads[0], appThread, 'the application thread is untouched');
    t.equal(jvm.currentThreadIndex, 0, 'current thread index restored');
    t.equal(jvm.debugManager.isPaused, true, 'still paused after evaluating');
    t.end();
  });
