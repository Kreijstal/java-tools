const test = require('tape');
const { execSync } = require('child_process');

test('JVM instanceof with interface test', function (t) {
  try {
    const stdout = execSync('node scripts/runJvm.js -cp sources InstanceofInterfaceTest', { encoding: 'utf-8' });
    t.ok(stdout.includes('is_iiface'), 'Output should indicate CClass is instanceof IIFace');
    t.ok(stdout.includes('is_charsequence'), 'Output should indicate String is instanceof CharSequence');
    t.notOk(stdout.includes('is_not_iiface'), 'Output should not indicate CClass is NOT instanceof IIFace');
    t.pass('Execution did not fail');
  } catch (e) {
    t.fail('Execution failed');
    t.comment(e.stdout);
    t.comment(e.stderr);
  }
  t.end();
});
