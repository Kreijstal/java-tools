const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('worker-intrinsic-transport-');

test('worker transports a verified primitive-copy intrinsic without generated source', async t => {
 const copyForward = 'dst[d++] = src[s++];'.repeat(4);
 const copyBackward = 'dst[--d] = src[--s];'.repeat(4);
 const classpath = compileFixture(t, 'IntrinsicTransport', `
public class IntrinsicTransport {
 public static void copy(int[] src, int s, int[] dst, int d, int n) {
   if (src == dst && s == d) return;
   if (src == dst && d > s && d < s + n) {
     s += n; d += n;
     while (n >= 4) { ${copyBackward} n -= 4; }
     while (n-- > 0) dst[--d] = src[--s];
   } else {
     while (n >= 4) { ${copyForward} n -= 4; }
     while (n-- > 0) dst[d++] = src[s++];
   }
 }
}`);
 const jvm = new JVM({classpath, jit:{compileWorker:true, warmupThreshold:0, retainCompilerDiagnostics:false}});
 const jit = jvm.jit;
 t.teardown(()=>jit.compileWorker.dispose());
 await jvm.preloadClasspathClasses();
 const method = await jvm.findMethodInHierarchy('IntrinsicTransport','copy','([II[III)V');
 t.ok(jit.getSynchronousIntrinsic(method,method.descriptor), 'real compiled bytecode is recognized');
 jit.compileWorker.enqueue(method,{});
 await jit.compileWorker.whenIdle();
 t.ok(jit.compileWorker.installedMethods.has(method), 'worker intrinsic installs');
 t.equal(jit.compileWorker.stats.refused,0,'closure is not refused as unserializable');
 const body = jit.codegenCache.get(method);
 if (body) {
   const payload = jit.serializeGeneratedResult(body);
   t.equal(payload.kind,'direct-intrinsic','transport carries a descriptor');
   t.notOk(payload.bodies,'no JavaScript source is transported');
   t.equal(jit.materializeGeneratedResult({...payload,intrinsicKind:'unknown'},method),null,'kind mismatch is refused');
   t.equal(jit.materializeGeneratedResult(payload,{...method,attributes:[]}),null,'receiver revalidates the bytecode');
   const data = new Int32Array([1,2,3,4,5]);
   const frame = {pc:0, instructions:[{}], locals:[data,0,data,1,4]};
   const items = [frame], thread = {callStack:{items,pop:()=>items.pop()}};
   t.ok(body(frame,thread,jit).returned,'installed entry returns');
   t.deepEqual([...data],[1,1,2,3,4],'overlap behavior survives transport');
   const bad = {...frame,pc:0,locals:[data,-1,new Int32Array(5),0,2]};
   t.throws(()=>body(bad,thread,jit),e=>e.type==='java/lang/ArrayIndexOutOfBoundsException','bounds exceptions survive transport');
 }
 t.end();
});
