const test = require('tape');
const { JVM } = require('../src/core/jvm');

test('StringBuilder.append(CharSequence) appends and returns the receiver', (t) => {
  const jvm = new JVM({ verbose: false });
  const append = jvm._jreFindMethod(
    'java/lang/StringBuilder',
    'append',
    '(Ljava/lang/CharSequence;)Ljava/lang/StringBuilder;',
  );
  const builder = { type: 'java/lang/StringBuilder', value: 'Deko ' };
  const sequence = new String('Bloko');
  sequence.type = 'java/lang/String';

  t.equal(append(jvm, builder, [sequence]), builder, 'returns the receiver');
  t.equal(builder.value, 'Deko Bloko', 'appends the CharSequence contents');
  t.end();
});
