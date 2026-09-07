const test = require("tape");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { JVM } = require("../src/core/jvm");
const Frame = require("../src/core/frame");
const Stack = require("../src/core/stack");

// A structured body that cannot yield (a framed body compiled without
// continuations, or the restoring positional variant a structured caller
// invokes) leaves its frame at a loop header when the scheduler quantum
// expires. The framed body used to accept a frame only at pc 0, so the rest
// of that invocation ran in the scalar/baseline resume tier, whose calls go
// through generic dispatch (the Deko Bloko logo spent most of its frame time
// there). The framed body now re-enters at the loop headers it materializes.
function compileFixture(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jit-resume-entry-"));
  t.teardown(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempDir, "ResumeHarness.java"), `
public final class ResumeHarness {
  static int mix(int[] values, int count, int seed) {
    int acc = seed;
    int i = 0;
    while (i < count) {
      acc = acc * 31 + values[i & 255];
      i += (values[i & 255] & 1) + 1;
    }
    return acc;
  }
}
`);
  execFileSync("javac", ["-g", "-d", tempDir, path.join(tempDir, "ResumeHarness.java")], { stdio: "inherit" });
  return tempDir;
}

function reference(values, count, seed) {
  let acc = seed | 0;
  let i = 0;
  while (i < count) {
    acc = (Math.imul(acc, 31) + values[i & 255]) | 0;
    i += (values[i & 255] & 1) + 1;
  }
  return acc;
}

async function runScenario(t, tempDir, structuredResumeEntry) {
  const jvm = new JVM({ classpath: tempDir, jit: {
    warmupThreshold: 1000000, preferWholeMethodJs: true, profileMethods: false,
    scalarLoops: true, scalarGuestBodies: true, structuredSsa: true, rendererPipeline: true,
    structuredContinuations: false, structuredResumeEntry,
  } });
  await jvm.loadClassByName("ResumeHarness");
  jvm.classInitializationState.set("ResumeHarness", "INITIALIZED");
  const method = await jvm.findMethodInHierarchy("ResumeHarness", "mix", "([III)I");
  // The dispatcher captures the statistics map when it is built.
  jvm.jit.resumeDispatchStats = new Map();
  const generated = jvm.jit.compileMethod(method);
  t.ok(generated, "the loop compiles");
  const fast = generated.jvmFastBody || generated;
  t.ok(fast.jvmStructuredSsa, "the fast tier is the structured body");
  const label = structuredResumeEntry ? "with resume entry" : "without resume entry";
  const values = Array.from({ length: 256 }, (_u, i) => ((i * 7919) ^ (i << 3)) & 0xffff);
  const count = 20000;
  const seed = 12345;
  const expected = reference(values, count, seed);
  const frame = new Frame(method);
  frame.className = "ResumeHarness";
  frame.locals[0] = { type: "[I", elements: values.slice(), length: 256 };
  frame.locals[1] = count;
  frame.locals[2] = seed;
  const callStack = new Stack();
  callStack.push(frame);
  const thread = { status: "runnable", callStack, name: "test" };
  // An expired quantum: the first safe point leaves the frame at the header.
  jvm._nextEventLoopYieldAt = 0;
  const first = jvm.jit.runGeneratedFrame(generated, frame, thread, false);
  t.ok(first && first.deopt && first.reason === "structured SSA safe point",
    `${label}: the expired quantum exits at a safe point (${first && (first.reason || JSON.stringify(first))})`);
  t.ok(frame.pc !== 0, `${label}: the frame is left at a loop header (pc ${frame.pc})`);
  t.ok(callStack.peek() === frame, `${label}: the frame stays on the call stack`);
  if (structuredResumeEntry) {
    t.ok(fast.jvmStructuredResumePcs instanceof Set && fast.jvmStructuredResumePcs.has(frame.pc),
      `${label}: the body publishes that header as a resume entry (${[...(fast.jvmStructuredResumePcs || [])]})`);
    t.equal(fast.jvmStructuredResumeEntryConflicts, 0, `${label}: no header was withdrawn for a skipped declaration`);
  } else {
    t.equal(fast.jvmStructuredResumePcs, null, `${label}: no resume entries are published`);
  }
  // A fresh quantum: the frame continues from the header.
  jvm._nextEventLoopYieldAt = Date.now() + 60000;
  const second = jvm.jit.runGeneratedFrame(generated, frame, thread, false);
  t.ok(second && second.returned === true, `${label}: the resumed invocation returns (${second && (second.reason || JSON.stringify(Object.keys(second)))})`);
  t.equal(second && second.value, expected, `${label}: the resumed invocation computes the same value as an uninterrupted run`);
  const stats = [...jvm.jit.resumeDispatchStats.values()][0];
  t.ok(stats, `${label}: the resume dispatcher was consulted`);
  if (structuredResumeEntry) {
    t.equal(stats && stats.resume, 0, `${label}: the header entry went to the structured body, not the resume tier`);
    t.equal(stats && stats.fast, 2, `${label}: both entries ran the structured body`);
  } else {
    t.equal(stats && stats.resume, 1, `${label}: the header entry fell back to the resume tier`);
  }
}

test("a framed structured body resumes at the loop header it left at a safe point", async (t) => {
  const tempDir = compileFixture(t);
  await runScenario(t, tempDir, true);
  await runScenario(t, tempDir, false);
  t.end();
});
