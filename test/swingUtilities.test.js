const test = require('tape');
const { JVM } = require('../src/core/jvm');

test('SwingUtilities.isRightMouseButton uses static JRE calling convention', (t) => {
  const jvm = new JVM({ verbose: false });
  const method = jvm._jreFindMethod(
    'javax/swing/SwingUtilities',
    'isRightMouseButton',
    '(Ljava/awt/event/MouseEvent;)Z',
  );

  t.equal(method(jvm, null, [{ type: 'java/awt/event/MouseEvent', button: 1 }]), 0,
    'left mouse button is false');
  t.equal(method(jvm, null, [{ type: 'java/awt/event/MouseEvent', button: 3 }]), 1,
    'right mouse button is true');
  t.end();
});
