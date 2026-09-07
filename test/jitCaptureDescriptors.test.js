// Phase 1.2 protocol (docs/plan-linear-runtime.md): a generated body plus a
// symbolic description of its captured link records is enough to rebuild an
// equivalent function on a JIT — the shape a compile worker hands back.
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const frontend = require('../src/java-frontend');

function compileProbe(t) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jit-captures-'));
  t.teardown(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  frontend.compileJavaFile(path.resolve(__dirname, '../sources/CaptureProbe.java'), {
    outputDir, sourceFileName: 'CaptureProbe.java',
  });
  return outputDir;
}

function methodsOf(jvm, className) {
  const byName = {};
  for (const item of jvm.classes[className]?.ast?.classes?.[0]?.items || []) if (item.method) byName[item.method.name] = item.method;
  return byName;
}

test('every capture of a compiled game-shaped method is describable and re-internable', async (t) => {
  const classpath = compileProbe(t);
  const jvm = new JVM({ classpath, jit: { profileMethods: true, warmupThreshold: 0 } });
  let out = '';
  jvm.registerJreMethods({ 'java/io/PrintStream': { 'println(I)V': (_j, _o, args) => { out += `${args[0]}\n`; } } });
  await jvm.run('CaptureProbe');
  const jit = jvm.jit;
  const m = methodsOf(jvm, 'CaptureProbe');
  const generated = jit.codegenCache.get(m.walk);
  t.ok(generated, 'walk() compiled');
  const body = generated.jvmRestoringDirectPositionalBody || generated;
  const descriptors = body.jvmCaptureDescriptors;
  t.ok(descriptors, 'the body carries capture descriptors');
  const kinds = {};
  for (const d of Object.values(descriptors)) kinds[d.kind] = (kinds[d.kind] || 0) + 1;
  t.comment(`tier=${body.jvmTier} kinds=${JSON.stringify(kinds)}`);
  t.notOk(kinds.unknown, 'no capture of unknown kind');
  // Which capture kind carries a static access depends on the tier: with lazy
  // static targets on (the default) a getstatic is reached through a field
  // site link record, not a direct static cell. This test is about every
  // capture being describable, so accept either form - the next test proves
  // the rebuilt body really does mutate the same statics.
  t.ok((kinds.staticCell || 0) + (kinds.fieldSite || 0) >= 1,
    `static access described (calls, table): ${JSON.stringify(kinds)}`);
  t.ok(kinds.callSite >= 1, 'call site described (bump)');
  t.ok(kinds.classGuard >= 1, 'class guard described');
  const { captures } = jit.internLinkRecords(descriptors, m.walk);
  t.equal(Object.keys(captures).length, Object.keys(descriptors).length, 'every descriptor interned');
  for (const [name, d] of Object.entries(descriptors)) {
    if (d.kind === 'staticCell') {
      const store = jvm.classes[d.className].staticFields;
      t.equal(captures[name], store.cell(d.key), `${name} interns to the live cell of ${d.className}.${d.key}`);
    }
  }
  t.end();
});

test('a body rebuilt from text + descriptors computes the same result and mutates the same statics', async (t) => {
  const classpath = compileProbe(t);
  const jvm = new JVM({ classpath, jit: { profileMethods: true, warmupThreshold: 0 } });
  jvm.registerJreMethods({ 'java/io/PrintStream': { 'println(I)V': () => {} } });
  await jvm.run('CaptureProbe');
  const jit = jvm.jit;
  const m = methodsOf(jvm, 'CaptureProbe');
  const generated = jit.codegenCache.get(m.walk);
  const body = generated.jvmRestoringDirectPositionalBody;
  if (!body) { t.skip('walk() has no restoring positional body on this tree'); t.end(); return; }
  const rebound = jit.rebindGeneratedFunction(body, m.walk);
  t.equal(typeof rebound, 'function', 'rebound is a function');
  const store = jvm.classes.CaptureProbe.staticFields;
  const callsCell = store.cell('calls:I');
  const thread = { status: 'runnable', callStack: { items: [], peek() { return this.items[this.items.length - 1]; }, push(f) { this.items.push(f); }, pop() { return this.items.pop(); } } };
  const receiver = { type: 'CaptureProbe', _className: 'CaptureProbe', fields: {} };
  const probeInstance = (() => { const r = { type: 'CaptureProbe', _className: 'CaptureProbe', fields: {} }; return r; })();
  const plan = { target: {}, Frame, method: m.walk, lookupClass: 'CaptureProbe', restoreFrame() {}, clearStructuredContinuation: null, semantic: generated.jvmRestoringDirectPositionalPlan || null };
  const before = callsCell.value;
  const a = body(jit, plan, receiver, 16, thread, true);
  const afterOriginal = callsCell.value;
  const b = rebound(jit, plan, probeInstance, 16, thread, true);
  const afterRebound = callsCell.value;
  t.comment(`original=${JSON.stringify(a)} rebound=${JSON.stringify(b)} calls ${before}->${afterOriginal}->${afterRebound}`);
  t.ok(typeof a === 'number' && typeof b === 'number', 'both bodies ran on the fast path');
  t.equal(b, a, 'same result');
  t.equal(afterRebound - afterOriginal, afterOriginal - before, 'the rebound body bumps the same static cell by the same amount');
  t.end();
});
