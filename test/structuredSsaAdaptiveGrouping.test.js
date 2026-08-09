const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

test('adaptive SSA preserves destructive two-phase indexing across yields',
  async (t) => {
    const directory = fs.mkdtempSync(path.join(
      os.tmpdir(), 'adaptive-ssa-grouping-'));
    t.teardown(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = path.join(directory, 'AdaptiveGroupingHarness.java');
    fs.writeFileSync(source, `
public final class AdaptiveGroupingHarness {
  static int sink;

  static final class State {
    int[] tags;
    int[][] groups;

    void index() {
      if (tags == null) return;
      int[] counts = new int[256];
      int maximum = 0;
      for (int index = 0; index < tags.length; index++) {
        int tag = tags[index];
        counts[tag] = counts[tag] + 1;
        if (tag > maximum) maximum = tag;
      }
      groups = new int[maximum + 1][];
      for (int tag = 0; tag <= maximum; tag++) {
        groups[tag] = new int[counts[tag]];
        counts[tag] = 0;
      }
      for (int index = 0; index < tags.length; index++) {
        int tag = tags[index];
        int offset = counts[tag];
        counts[tag] = offset + 1;
        int[] group = groups[tag];
        group[offset] = index;
      }
      tags = null;
    }
  }

  static void prepare(State state) {
    state.index();
    sink = state.groups.length * 10000 + state.groups[3].length;
    state.index();
  }
}
`);
    execFileSync('javac', ['-g', '-d', directory, source]);

    const jvm = new JVM({classpath: [directory], interpreterBurst: 256, jit: {
      warmupThreshold: 0,
      structuredSsa: true,
      adaptiveFramelessPositional: true,
      adaptiveFramelessBudgetMultiplier: 1,
      profileMethods: false,
    }});
    const owner = await jvm.loadClassByName('AdaptiveGroupingHarness');
    await jvm.loadClassByName('AdaptiveGroupingHarness$State');
    jvm.classInitializationState.set(
      'AdaptiveGroupingHarness', 'INITIALIZED');
    jvm.classInitializationState.set(
      'AdaptiveGroupingHarness$State', 'INITIALIZED');
    owner.staticFields.set('sink:I', 0);

    const prepare = jvm.findMethod(
      owner, 'prepare', '(LAdaptiveGroupingHarness$State;)V');
    const index = await jvm.findMethodInHierarchy(
      'AdaptiveGroupingHarness$State', 'index', '()V');
    const thread = {
      id: 0,
      name: 'adaptive-grouping',
      callStack: new Stack(),
      status: 'runnable',
      pendingException: null,
    };
    jvm.threads = [thread];
    jvm.currentThreadIndex = 0;

    let finalState = null;
    for (let run = 0; run < 7; run++) {
      const tags = Array.from(
        {length: 1177}, (_unused, indexValue) =>
          (indexValue * 17 + indexValue / 11 | 0) % 43);
      tags.type = '[I';
      const state = {
        type: 'AdaptiveGroupingHarness$State',
        _className: 'AdaptiveGroupingHarness$State',
        fields: {
          'AdaptiveGroupingHarness$State.tags': tags,
          'AdaptiveGroupingHarness$State.groups': null,
        },
        hashCode: jvm.nextHashCode++,
      };
      const frame = new Frame(prepare);
      frame.className = 'AdaptiveGroupingHarness';
      frame.locals[0] = state;
      thread.status = 'runnable';
      thread.pendingException = null;
      thread.callStack.push(frame);
      while (!thread.callStack.isEmpty()) {
        // Exercise the materialized iterator path on every available poll.
        jvm._nextEventLoopYieldAt = 0;
        await jvm.executeTick({allowBurst: true});
      }
      t.equal(thread.pendingException, null,
        `promoted invocation ${run + 1} completes without a guest exception`);
      finalState = state;
    }

    const expectedCount = Array.from(
      {length: 1177}, (_unused, indexValue) =>
        (indexValue * 17 + indexValue / 11 | 0) % 43)
      .filter((tag) => tag === 3).length;
    t.equal(owner.staticFields.get('sink:I'), 430000 + expectedCount,
      'the nested caller observes the complete grouping result');
    t.equal(finalState.fields[
      'AdaptiveGroupingHarness$State.groups'].length, 43,
    'the maximum group is not confused with the 256-entry scratch table');
    t.equal(finalState.fields['AdaptiveGroupingHarness$State.tags'], null,
      'the source array is cleared only after all indexed reads complete');
    const generated = jvm.jit.structuredSsa.compile(index);
    if (!generated) {
      t.comment(`structured rejection: ${
        jvm.jit.structuredSsa.lastRejectionReason}`);
    }
    t.ok(generated?.jvmStructuredSsa &&
      typeof generated.jvmAdaptivePositionalBody === 'function',
    'the regression exercises the generic adaptive structured tier' +
      (generated ? '' : ` (${jvm.jit.structuredSsa.lastRejectionReason})`));
    t.ok(jvm.jit.structuredSsa.safePointCount > 0,
      'the fixture crosses scheduler-safe resumptions');
    t.end();
  });
