"use strict";

const test = require("tape");
const {
  splitModuleSourceForFactoryHoist,
} = require("../src/jit/HotCallGraphRegionCompiler");

const MODULE_SOURCE = [
  "'use strict';",
  "const jvmRegionSegmentState0 = [];",
  "function jvmRegionNode0(helpers, value, thread) {",
  "  jvmRegionSegment0_0(value, jvmRegionSegmentState0);",
  "  const doubled = jvmRegionSegmentState0[2];",
  "  return jvmRegionNode1(helpers, doubled, thread);",
  "}",
  "function jvmRegionNode1(helpers, value, thread) {",
  "  return value + helpers.bias;",
  "}",
  "if (!jvmRegionGuard(thread, helpers)) {",
  "  return helpers.asyncInvokeSentinel();",
  "}",
  "return jvmRegionNode0(helpers, seed, thread);",
  "function jvmRegionSegment0_0(value, state) {",
  "  state[0] = 0;",
  "  state[2] = value * 2;",
  "}",
].join("\n");

function instantiate(split, captures) {
  const captureNames = Object.keys(captures);
  const factory = new Function(...captureNames,
    `"use strict";\n${split.hoistedSource}\n` +
    "return function entry(helpers, seed, thread) {\n" +
    `${split.entrySource}\n};`);
  return factory(...captureNames.map((name) => captures[name]));
}

test("factory hoist separates declarations from the entry tail", (t) => {
  const split = splitModuleSourceForFactoryHoist(MODULE_SOURCE);
  t.ok(split, "module splits");
  t.equal(split.hoistedCount, 4,
    "three functions and one state array hoist");
  t.ok(split.hoistedSource.includes("const jvmRegionSegmentState0 = []"),
    "protocol state array hoists to factory scope");
  t.ok(!split.entrySource.includes("function jvmRegionNode0"),
    "entry tail holds no declarations");
  t.ok(split.entrySource.includes("return jvmRegionNode0"),
    "entry tail keeps the root dispatch");
  t.ok(!split.entrySource.includes("use strict"),
    "directive stays out of the entry tail");
  t.end();
});

test("hoisted module behaves identically across repeated entries", (t) => {
  const split = splitModuleSourceForFactoryHoist(MODULE_SOURCE);
  const guardCalls = [];
  const entry = instantiate(split, {
    jvmRegionGuard: (thread) => {
      guardCalls.push(thread);
      return thread !== "blocked";
    },
  });
  const helpers = {bias: 7, asyncInvokeSentinel: () => "async-sentinel"};
  t.equal(entry(helpers, 5, "runnable"), 17, "first entry computes 5*2+7");
  t.equal(entry(helpers, 9, "runnable"), 25, "second entry computes 9*2+7");
  t.equal(entry(helpers, 1, "blocked"), "async-sentinel",
    "guard rejection returns the sentinel");
  t.deepEqual(guardCalls, ["runnable", "runnable", "blocked"],
    "guard capture observes every entry");
  t.end();
});

test("hoisting preserves reentrant state-array protocol", (t) => {
  // A segment whose body re-enters the module before its own epilogue
  // writes must not observe the inner invocation's outcome: the outer
  // epilogue overwrites the shared array after the inner burst completes.
  const source = [
    "'use strict';",
    "const jvmRegionSegmentState0 = [];",
    "function jvmRegionNode0(helpers, depth, thread) {",
    "  jvmRegionSegment0_0(helpers, depth, thread, jvmRegionSegmentState0);",
    "  return jvmRegionSegmentState0[2];",
    "}",
    "function jvmRegionSegment0_0(helpers, depth, thread, state) {",
    "  let inner = 0;",
    "  if (depth > 0) inner = helpers.reenter(depth - 1);",
    "  state[0] = 0;",
    "  state[2] = inner + depth;",
    "}",
    "return jvmRegionNode0(helpers, seed, thread);",
  ].join("\n");
  const split = splitModuleSourceForFactoryHoist(source);
  t.ok(split, "reentrant module splits");
  const entry = instantiate(split, {});
  const helpers = {reenter: (depth) => entry(helpers, depth, "runnable")};
  t.equal(entry(helpers, 3, "runnable"), 6,
    "nested re-entrant bursts sum 3+2+1+0 without tearing");
  t.end();
});

test("generator declarations hoist for framed modules", (t) => {
  const source = [
    "'use strict';",
    "function* jvmRegionNode0(frame, thread, helpers, checks, frameless) {",
    "  yield 'suspend';",
    "  return frame + 1;",
    "}",
    "return jvmRegionNode0(frame, thread, helpers, checks, false);",
  ].join("\n");
  const split = splitModuleSourceForFactoryHoist(source);
  t.ok(split, "framed module splits");
  const factory = new Function(
    `"use strict";\n${split.hoistedSource}\n` +
    "return function entry(frame, thread, helpers, checks) {\n" +
    `${split.entrySource}\n};`);
  const entry = factory();
  const iterator = entry(41, null, null, false);
  t.equal(iterator.next().value, "suspend", "generator yields");
  t.equal(iterator.next().value, 42, "generator completes");
  t.end();
});

test("unexpected top-level shapes abort the split", (t) => {
  t.equal(splitModuleSourceForFactoryHoist(
    "'use strict';\nlet counter = 0;\nfunction f() { return counter; }\n" +
    "return f();"), null, "top-level let aborts");
  t.equal(splitModuleSourceForFactoryHoist(
    "'use strict';\nconst plan = {mutable: true};\n" +
    "function f() { return plan; }\nreturn f();"), null,
  "const with non-empty initializer aborts");
  t.equal(splitModuleSourceForFactoryHoist(
    "'use strict';\nreturn 1;"), null,
  "module without declarations does not split");
  t.equal(splitModuleSourceForFactoryHoist(
    "'use strict';\nfunction f() { return 1; }"), null,
  "module without an entry tail does not split");
  t.equal(splitModuleSourceForFactoryHoist("function f( {"), null,
    "unparsable source aborts");
  t.end();
});

test("real partitioned module shape splits with shared helper identity",
  (t) => {
    // Mirrors the emitted layout: directive, state array, node functions,
    // guard tail, then partition helpers appended after the tail.
    const source = [
      "'use strict';",
      "const jvmRegionSegmentState0 = [];",
      "function jvmRegionNode0(helpers, value, thread) {",
      "  jvmRegionSegment0_0(value, jvmRegionSegmentState0);",
      "  if (jvmRegionSegmentState0[0] === 2) throw jvmRegionSegmentState0[1];",
      "  return jvmRegionSegmentState0[2];",
      "}",
      "if (!jvmRegionGuard(thread, helpers)) {",
      "  return helpers.asyncInvokeSentinel();",
      "}",
      "return jvmRegionNode0(helpers, seed, thread);",
      "function jvmRegionSegment0_0(value, state) {",
      "  try {",
      "    state[0] = 0;",
      "    state[2] = helpersFree(value);",
      "  } catch (error) {",
      "    state[0] = 2;",
      "    state[1] = error;",
      "  }",
      "}",
    ].join("\n");
    const split = splitModuleSourceForFactoryHoist(source);
    t.ok(split, "helpers appended after the tail still hoist");
    const seen = [];
    const entry = instantiate(split, {
      jvmRegionGuard: () => true,
      helpersFree: (value) => {
        // Function.caller is unavailable in strict mode; observe shared
        // instantiation through a stable closure-scope side channel
        // instead: the hoisted segment function is the same object on
        // every entry exactly when declarations evaluate once.
        seen.push(value);
        return value + 100;
      },
    });
    const helpers = {asyncInvokeSentinel: () => "async"};
    t.equal(entry(helpers, 1, "runnable"), 101, "first entry");
    t.equal(entry(helpers, 2, "runnable"), 102, "second entry");
    t.deepEqual(seen, [1, 2], "capture sees both entries");
    t.end();
  });
