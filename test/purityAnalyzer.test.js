const test = require('tape');
const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser');
const { convertJson } = require('../src/convert_tree');
const { analyzePurity } = require('../src/purityAnalyzer');

function loadConvertedClass(classFileName) {
  const classFilePath = path.join(__dirname, '../sources', classFileName);
  const classFileContent = fs.readFileSync(classFilePath);
  const parsed = getAST(new Uint8Array(classFileContent));
  return convertJson(parsed.ast, parsed.constantPool);
}

test('purity analyzer flags pure literal return methods', (t) => {
  const converted = loadConvertedClass('A.class');
  const purity = analyzePurity(converted);

  const pureSignature = 'A.myMethod()Ljava/lang/String;';
  t.ok(purity[pureSignature], 'purity data should contain myMethod');
  t.equal(purity[pureSignature].pure, true, 'myMethod should be pure');

  const ctorSignature = 'A.<init>()V';
  t.ok(purity[ctorSignature], 'purity data should contain constructor');
  t.equal(purity[ctorSignature].pure, false, 'constructor should not be pure due to external call');
  t.match(
    purity[ctorSignature].reason,
    /java\/lang\/Object\.\<init\>\(\)V/,
    'constructor reason should mention external Object constructor',
  );

  t.end();
});

test('purity analyzer flags field writes as impure', (t) => {
  const converted = loadConvertedClass('AnnotationReflectionTest.class');
  const purity = analyzePurity(converted);

  const ctorSignature = 'AnnotationReflectionTest.<init>()V';
  t.ok(purity[ctorSignature], 'purity data should contain constructor');
  t.equal(purity[ctorSignature].pure, false, 'constructor should not be pure');
  t.match(
    purity[ctorSignature].reason,
    /putfield/,
    'constructor reason should mention putfield opcode',
  );

  t.end();
});
