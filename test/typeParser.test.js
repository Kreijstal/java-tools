const test = require('tape');
const { parseDescriptor, descriptorToString } = require('../src/typeParser');

test('parseDescriptor should correctly parse method descriptors', (t) => {
  t.plan(3);

  const descriptor1 = '()V';
  const expectedAST1 = { params: [], returnType: 'void' };
  t.deepEqual(parseDescriptor(descriptor1), expectedAST1, 'Parses void() correctly');

  const descriptor2 = '(Ljava/lang/String;I)V';
  const expectedAST2 = { params: ['java.lang.String', 'int'], returnType: 'void' };
  t.deepEqual(parseDescriptor(descriptor2), expectedAST2, 'Parses (Ljava/lang/String;I)V correctly');

  const descriptor3 = '([I[[Ljava/lang/String;)Ljava/util/List;';
  const expectedAST3 = { params: ['int[]', 'java.lang.String[][]'], returnType: 'java.util.List' };
  t.deepEqual(parseDescriptor(descriptor3), expectedAST3, 'Parses ([I[[Ljava/lang/String;)Ljava/util/List; correctly');
});

test('descriptorToString should correctly convert AST to string', (t) => {
  t.plan(2);

  const ast1 = { params: [], returnType: 'void' };
  const expectedString1 = 'void()';
  t.equal(descriptorToString(ast1), expectedString1, 'Converts AST to void() correctly');

  const ast2 = { params: ['java.lang.String', 'int'], returnType: 'void' };
  const expectedString2 = 'void(java.lang.String, int)';
  t.equal(descriptorToString(ast2), expectedString2, 'Converts AST to void(java.lang.String, int) correctly');
});
