const test = require('tape');
const { JVM } = require('../src/core/jvm');
const Stack = require('../src/core/stack');

function method(name) {
  return {
    name,
    descriptor: '()V',
    attributes: [{
      type: 'code',
      code: {
        localsSize: '1',
        codeItems: [],
        exceptionTable: [],
      },
    }],
  };
}

function classData(className, superClassName, methods) {
  return {
    ast: {
      classes: [{
        className,
        superClassName,
        items: methods.map(item => ({type: 'method', method: item})),
      }],
    },
    staticFields: new Map(),
  };
}

test('applet lifecycle resolves inherited init and start methods', async (t) => {
  const jvm = new JVM();
  const constructor = method('<init>');
  const inheritedInit = method('init');
  const inheritedStart = method('start');
  jvm.classes.ChildApplet = classData('ChildApplet', 'GameShell', [constructor]);
  jvm.classes.GameShell = classData(
    'GameShell',
    null,
    [inheritedInit, inheritedStart],
  );

  const thread = {
    id: 0,
    name: 'main',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  const invoked = [];
  jvm.executeUntilStackBelow = async currentThread => {
    invoked.push(currentThread.callStack.pop().method);
  };
  jvm.jre['java/applet/Applet'].methods['repaint()V'] = () => {};

  await jvm.executeAppletLifecycle(
    'ChildApplet',
    thread,
    {type: 'ChildApplet', fields: {}},
  );

  t.deepEqual(
    invoked,
    [constructor, inheritedInit, inheritedStart],
    'constructor stays leaf-local while virtual lifecycle methods search superclasses',
  );
  t.end();
});
