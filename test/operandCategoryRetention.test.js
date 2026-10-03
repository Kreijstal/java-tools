const test = require('tape');
const {JVM} = require('../src/core/jvm');

test('compact operand metadata preserves category-one, category-two and rejection results', t => {
  const full = new JVM({jit: {compileWorker:false, retainCompilerDiagnostics:true}}).jit;
  const compact = new JVM({jit: {compileWorker:false, retainCompilerDiagnostics:false}}).jit;
  for (const [descriptor, ops] of [
    ['()I', ['iconst_1','iconst_2','dup2','iadd','iadd','iadd','ireturn']],
    ['()J', ['lconst_1','dup2','ladd','lreturn']],
    ['()V', ['dup2','return']],
  ]) {
    const items = ops.map(instruction => ({instruction}));
    const method = {name:'probe', descriptor, flags:['static'], attributes:[]};
    const expected = full.ssaOperandCategories(items,method);
    const actual = compact.ssaOperandCategories(items,method);
    t.equal(actual.rejected, expected.rejected, 'admission result is preserved');
    t.equal(actual.reason, expected.reason, 'rejection reason is preserved');
    t.deepEqual(actual.stackKindsBefore, expected.stackKindsBefore, 'verification categories are preserved');
    t.deepEqual(Object.keys(actual).sort(), ['reason','rejected','stackKindsBefore'], 'full SSA graph is not retained');
    t.equal(compact.ssaOperandCategories(items,method), actual, 'cache avoids rebuilding the analysis');
  }
  t.end();
});
