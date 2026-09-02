"use strict";

const test = require("tape");
const {
  splitRegionModuleForFactoryHoist,
  pruneUnreachableRegionDeclarations,
} = require("../src/jit/HotCallGraphRegionCompiler");

// The region compiler assembles a module out of three regions it owns: the
// per-entry prologue, the declaration region (node functions, loop-outline
// helpers, and the partitioner's segment helpers and state arrays) and the
// entry statements. The split is a choice between those assembled texts, so
// these fixtures are declaration/entry *plans*, not module source to be
// re-parsed.
const DECLARATION_SOURCE = [
  "const jvmRegionSegmentState0 = [];",
  "function jvmRegionNode0(helpers, value, thread) {",
  "  jvmRegionSegment0_0(value, jvmRegionSegmentState0);",
  "  const doubled = jvmRegionSegmentState0[2];",
  "  return jvmRegionNode1(helpers, doubled, thread);",
  "}",
  "function jvmRegionNode1(helpers, value, thread) {",
  "  return value + helpers.bias;",
  "}",
  "function jvmRegionSegment0_0(value, state) {",
  "  state[0] = 0;",
  "  state[2] = value * 2;",
  "}",
].join("\n");

const ENTRY_SOURCES = [
  "if (!jvmRegionGuard(thread, helpers)) {\n" +
    "  return helpers.asyncInvokeSentinel();\n}",
  "return jvmRegionNode0(helpers, seed, thread);",
];

function planOf(overrides = {}) {
  return {
    hoistedSource: DECLARATION_SOURCE,
    entrySources: ENTRY_SOURCES,
    entryDeclaredNames: [],
    hoistedCount: 4,
    ...overrides,
  };
}

function instantiate(split, captures) {
  const captureNames = Object.keys(captures);
  const factory = new Function(...captureNames,
    `"use strict";\n${split.hoistedSource}\n` +
    "return function entry(helpers, seed, thread) {\n" +
    `${split.entrySource}\n};`);
  return factory(...captureNames.map((name) => captures[name]));
}

test("factory hoist separates declarations from the entry tail", (t) => {
  const split = splitRegionModuleForFactoryHoist(planOf());
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
  const split = splitRegionModuleForFactoryHoist(planOf());
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
  const split = splitRegionModuleForFactoryHoist(planOf({
    hoistedSource: [
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
    ].join("\n"),
    entrySources: ["return jvmRegionNode0(helpers, seed, thread);"],
    hoistedCount: 3,
  }));
  t.ok(split, "reentrant module splits");
  const entry = instantiate(split, {});
  const helpers = {reenter: (depth) => entry(helpers, depth, "runnable")};
  t.equal(entry(helpers, 3, "runnable"), 6,
    "nested re-entrant bursts sum 3+2+1+0 without tearing");
  t.end();
});

test("generator declarations hoist for framed modules", (t) => {
  const split = splitRegionModuleForFactoryHoist(planOf({
    hoistedSource: [
      "function* jvmRegionNode0(frame, thread, helpers, checks, frameless) {",
      "  yield 'suspend';",
      "  return frame + 1;",
      "}",
    ].join("\n"),
    entrySources: [
      "return jvmRegionNode0(frame, thread, helpers, checks, false);",
    ],
    hoistedCount: 1,
  }));
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

test("a per-entry binding aborts the split", (t) => {
  // Declarations evaluated once in the factory cannot close over a binding
  // re-created on every entry. The module-owned safe-point counter is such a
  // binding, which is why an emitted region module does not hoist today.
  t.equal(splitRegionModuleForFactoryHoist(planOf({
    entryDeclaredNames: ["safePointBudget"],
    entrySources: ["let safePointBudget = 1000;", ...ENTRY_SOURCES],
  })), null, "an entry-scope binding aborts");
  t.equal(splitRegionModuleForFactoryHoist(planOf({hoistedSource: ""})), null,
    "module without declarations does not split");
  t.equal(splitRegionModuleForFactoryHoist(planOf({entrySources: []})), null,
    "module without an entry tail does not split");
  t.equal(splitRegionModuleForFactoryHoist(null), null,
    "a missing plan aborts");
  t.end();
});

test("unreachable region declarations are pruned from the emission plan",
  (t) => {
    const declarations = [
      {name: "jvmRegionNode0", kind: "function",
        references: ["jvmRegionNode2"], text: "root"},
      {name: "jvmRegionNode1", kind: "function",
        references: ["jvmRegionNode3"], text: "dead"},
      {name: "jvmRegionNode2", kind: "function",
        references: [], text: "callee"},
      {name: "jvmRegionNode3", kind: "function",
        references: [], text: "dead-callee"},
    ];
    t.deepEqual(
      pruneUnreachableRegionDeclarations(declarations, ["jvmRegionNode0"])
        .map((declaration) => declaration.name),
      ["jvmRegionNode0", "jvmRegionNode2"],
      "only the root's transitive closure survives");
    t.deepEqual(
      pruneUnreachableRegionDeclarations(declarations, ["jvmRegionNodeX"])
        .map((declaration) => declaration.name),
      ["jvmRegionNode0", "jvmRegionNode1", "jvmRegionNode2", "jvmRegionNode3"],
      "an unknown root keeps every declaration");
    t.end();
  });

test("reference cycles terminate and stay reachable", (t) => {
  const declarations = [
    {name: "a", kind: "function", references: ["b"], text: "a"},
    {name: "b", kind: "function", references: ["a", "c"], text: "b"},
    {name: "c", kind: "function", references: ["b"], text: "c"},
    {name: "d", kind: "function", references: ["d"], text: "d"},
  ];
  t.deepEqual(
    pruneUnreachableRegionDeclarations(declarations, ["a"])
      .map((declaration) => declaration.name),
    ["a", "b", "c"], "self- and mutual recursion do not loop or leak");
  t.end();
});
