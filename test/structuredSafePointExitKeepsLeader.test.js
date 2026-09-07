const test = require("tape");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { JVM } = require("../src/core/jvm");

// A structured body that cannot yield (the restoring positional variant, or a
// framed body compiled without continuations) leaves its frame at the loop
// header when the scheduler quantum has expired. It used to also request one
// canonical interpreted bytecode; that bytecode moved the frame off the
// leader, after which neither the scalar resume body nor any other compiled
// tier accepted it, and the rest of the invocation crawled through the
// interpreter with a deopt attempt per bytecode (the Jagex logo of Deko Bloko
// rendered at 0.6 fps this way). The frame at the header is exactly what the
// resume tier accepts, so the exit must not carry the skip-once marker.
function compileFixture(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jit-safepoint-"));
  t.teardown(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempDir, "SafePointHarness.java"), `
public final class SafePointHarness {
  static int[] sink = new int[256];
  static void mix(int[] values, int count, int seed) {
    int acc = seed;
    for (int i = 0; i < count; i++) {
      acc = acc * 31 + values[i & 255];
      sink[i & 255] = acc;
    }
  }
}
`);
  execFileSync("javac", ["-g", "-d", tempDir, path.join(tempDir, "SafePointHarness.java")], { stdio: "inherit" });
  return tempDir;
}

const safePointExitWithSkip =
  /helpers\.skipJitOnce\(frame\);\s*return \{ deopt: true, transient: true, reason: .structured SSA safe point. \}/;

test("non-yielding structured safe-point exits leave the frame at the loop header without a skip-once marker", async (t) => {
  const tempDir = compileFixture(t);
  for (const structuredContinuations of [true, false]) {
    const jvm = new JVM({ classpath: tempDir, jit: {
      warmupThreshold: 1000000, preferWholeMethodJs: true, profileMethods: false,
      scalarLoops: true, scalarGuestBodies: true, structuredSsa: true, rendererPipeline: true,
      structuredContinuations,
    } });
    await jvm.loadClassByName("SafePointHarness");
    jvm.classInitializationState.set("SafePointHarness", "INITIALIZED");
    const method = await jvm.findMethodInHierarchy("SafePointHarness", "mix", "([III)V");
    jvm.jit.structuredSsa.lastRejectionReason = null;
    const generated = jvm.jit.structuredSsa.compile(method);
    t.ok(generated, `structured compile succeeds with continuations=${structuredContinuations} (${jvm.jit.structuredSsa.lastRejectionReason || "no rejection"})`);
    if (!generated) continue;
    const sources = {
      structured: generated.jvmStructuredSource || "",
      restoringPositional: generated.jvmRestoringDirectPositionalSource || "",
    };
    for (const [name, source] of Object.entries(sources)) {
      const exits = (source.match(/reason: .structured SSA safe point./g) || []).length;
      const skipping = (source.match(safePointExitWithSkip) || []).length;
      t.equal(skipping, 0, `${name} (continuations=${structuredContinuations}): ${exits} safe-point exit(s), none request a canonical bytecode`);
    }
    if (!structuredContinuations) {
      t.ok(/reason: .structured SSA safe point./.test(sources.structured), "framed body without continuations has a safe-point exit to check");
    }
    t.ok(/reason: .structured SSA safe point./.test(sources.restoringPositional), `positional variant (continuations=${structuredContinuations}) has a safe-point exit to check`);
  }
  t.end();
});
