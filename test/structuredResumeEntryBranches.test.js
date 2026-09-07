const test = require("tape");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { JVM } = require("../src/core/jvm");
const Frame = require("../src/core/frame");
const Stack = require("../src/core/stack");

// The structurer places the loops of a loop body inside branch arms, so a
// framed body whose resume entries reached only plainly nested loops could
// re-enter at an outer header but never at an inner one: every safe point
// taken inside the inner loop finished the invocation in the resume tier.
// Resume entries now reach loops inside `if` arms and `switch` cases. The
// fixture's inner loop sits in an `if` arm of the outer loop body, and the
// switch selects a third loop; a safe point inside each is resumed exactly.
function compileFixture(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jit-resume-branches-"));
  t.teardown(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempDir, "BranchResume.java"), `
public final class BranchResume {
  static int nested(int[] values, int rows, int cols, int seed) {
    int acc = seed;
    int row = 0;
    while (row < rows) {
      int base = values[row & 255];
      if ((base & 1) == 0) {
        int col = 0;
        while (col < cols) {
          acc = acc * 31 + values[(base + col) & 255];
          col += (values[(acc >>> 4) & 255] & 1) + 1;
        }
      } else {
        acc ^= base;
      }
      row++;
    }
    return acc;
  }

  static int selected(int[] values, int rows, int cols, int seed) {
    int acc = seed;
    int row = 0;
    while (row < rows) {
      switch (values[row & 255] & 3) {
        case 0: {
          int col = 0;
          while (col < cols) {
            acc = acc * 17 + values[(row + col) & 255];
            col += (values[(acc >>> 4) & 255] & 1) + 1;
          }
          break;
        }
        case 1:
          acc += row;
          break;
        default:
          acc ^= values[row & 255];
      }
      row++;
    }
    return acc;
  }
}
`);
  execFileSync("javac", ["-g", "-d", tempDir, path.join(tempDir, "BranchResume.java")], { stdio: "inherit" });
  return tempDir;
}

function referenceNested(values, rows, cols, seed) {
  let acc = seed | 0;
  for (let row = 0; row < rows; row++) {
    const base = values[row & 255];
    if ((base & 1) === 0) {
      for (let col = 0; col < cols;) {
        acc = (Math.imul(acc, 31) + values[(base + col) & 255]) | 0;
        col += (values[(acc >>> 4) & 255] & 1) + 1;
      }
    } else {
      acc ^= base;
    }
  }
  return acc;
}

function referenceSelected(values, rows, cols, seed) {
  let acc = seed | 0;
  for (let row = 0; row < rows; row++) {
    switch (values[row & 255] & 3) {
      case 0:
        for (let col = 0; col < cols;) {
          acc = (Math.imul(acc, 17) + values[(row + col) & 255]) | 0;
          col += (values[(acc >>> 4) & 255] & 1) + 1;
        }
        break;
      case 1:
        acc = (acc + row) | 0;
        break;
      default:
        acc ^= values[row & 255];
    }
  }
  return acc;
}

async function runScenario(t, tempDir, name, reference) {
  const jvm = new JVM({ classpath: tempDir, jit: {
    warmupThreshold: 1000000, preferWholeMethodJs: true, profileMethods: false,
    scalarLoops: true, scalarGuestBodies: true, structuredSsa: true, rendererPipeline: true,
    structuredContinuations: false, structuredResumeEntry: true,
  } });
  await jvm.loadClassByName("BranchResume");
  jvm.classInitializationState.set("BranchResume", "INITIALIZED");
  const method = await jvm.findMethodInHierarchy("BranchResume", name, "([IIII)I");
  jvm.jit.resumeDispatchStats = new Map();
  const generated = jvm.jit.compileMethod(method);
  t.ok(generated, `${name}: the method compiles`);
  const fast = generated.jvmFastBody || generated;
  t.ok(fast.jvmStructuredSsa, `${name}: the fast tier is the structured body`);
  const coverage = fast.jvmStructuredResumeCoverage;
  t.ok(coverage && coverage.loops >= 2 && coverage.active === coverage.loops,
    `${name}: every loop header is a resume entry (${JSON.stringify(coverage)})`);
  t.equal(fast.jvmStructuredResumeEntryConflicts, 0, `${name}: no header was withdrawn`);
  const values = Array.from({ length: 256 }, (_u, i) => ((i * 7919) ^ (i << 3)) & 0xffff);
  const rows = 4000;
  const cols = 64;
  const seed = 12345;
  const expected = reference(values, rows, cols, seed);
  const frame = new Frame(method);
  frame.className = "BranchResume";
  frame.locals[0] = { type: "[I", elements: values.slice(), length: 256 };
  frame.locals[1] = rows;
  frame.locals[2] = cols;
  frame.locals[3] = seed;
  const callStack = new Stack();
  callStack.push(frame);
  const thread = { status: "runnable", callStack, name: "test" };
  // Every entry expires its quantum, so each run leaves the frame at the
  // next safe point; the inner loop's header is reached this way.
  const headers = new Set();
  let result = null;
  let turns = 0;
  while (turns < 100000) {
    turns += 1;
    jvm._nextEventLoopYieldAt = 0;
    result = jvm.jit.runGeneratedFrame(generated, frame, thread, false);
    if (result && result.returned === true) break;
    t.ok(result && result.deopt && result.reason === "structured SSA safe point",
      `${name}: turn ${turns} exits at a safe point (${result && (result.reason || JSON.stringify(result))})`);
    if (!(result && result.deopt)) break;
    headers.add(frame.pc);
    t.ok(fast.jvmStructuredResumePcs.has(frame.pc),
      `${name}: the frame is left at a published resume entry (pc ${frame.pc})`);
    if (turns > 3 && headers.size >= 2) {
      // Both headers have been resumed; let the rest run uninterrupted.
      jvm._nextEventLoopYieldAt = Date.now() + 60000;
      result = jvm.jit.runGeneratedFrame(generated, frame, thread, false);
      break;
    }
  }
  t.ok(headers.size >= 2, `${name}: safe points were taken at both the outer and an inner header (${[...headers]})`);
  t.ok(result && result.returned === true, `${name}: the resumed invocation returns (${result && (result.reason || JSON.stringify(Object.keys(result || {})))})`);
  t.equal(result && result.value, expected, `${name}: the resumed invocation computes the uninterrupted value`);
  const stats = [...jvm.jit.resumeDispatchStats.values()][0];
  t.ok(stats, `${name}: the resume dispatcher was consulted`);
  t.equal(stats && stats.resume, 0, `${name}: no entry fell back to the resume tier`);
}

test("a framed structured body resumes at loop headers inside branch arms", async (t) => {
  const tempDir = compileFixture(t);
  await runScenario(t, tempDir, "nested", referenceNested);
  await runScenario(t, tempDir, "selected", referenceSelected);
  t.end();
});
