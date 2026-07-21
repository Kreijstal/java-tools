#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const sourcePath = path.resolve(process.argv[2] || '');
const classpath = path.resolve(process.argv[3] || '');
const targetMethodKey = process.argv[4] || '';
const outputPath = path.resolve(process.argv[5] || '');

if (!fs.statSync(sourcePath, { throwIfNoEntry: false })?.isFile() ||
    !fs.statSync(classpath, { throwIfNoEntry: false })?.isDirectory() ||
    !targetMethodKey || !process.argv[5]) {
  console.error('Usage: node scripts/deriveDekoblokoRegionTrace.js ' +
    '<parent-trace.json> <class-directory> <target-method-key> <output.json>');
  process.exit(2);
}

function keyFor(jvm, frame) {
  const owner = frame.className || jvm.findClassNameForMethod(frame.method);
  return `${owner}.${frame.method.name}${frame.method.descriptor}`;
}

(async () => {
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (!source?.state || !source.methodKey) throw new Error('Invalid parent method-entry trace');
  source.state.classpath = [classpath];
  const jvm = new JVM({ classpath: [classpath], jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
    profileMethods: false,
    scalarLoops: false,
    scalarGuestBodies: false,
    structuredSsa: false,
    fusedRegions: false,
  } });
  await jvm.loadState(source.state);
  const restored = jvm.threads.flatMap((thread) => thread.callStack.items
    .map((frame) => ({ thread, frame })))
    .find(({ frame }) => keyFor(jvm, frame) === source.methodKey);
  if (!restored) throw new Error(`Parent entry frame ${source.methodKey} is absent`);

  const parent = new Frame(restored.frame.method);
  parent.className = restored.frame.className || jvm.findClassNameForMethod(restored.frame.method);
  parent.locals = restored.frame.locals.slice();
  const thread = {
    id: restored.thread.id,
    name: 'derive-region-trace',
    status: 'runnable',
    pendingException: null,
    callStack: new Stack(),
  };
  thread.callStack.push(parent);
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  jvm.jit.methodEntryTraceKey = targetMethodKey;

  let ticks = 0;
  while (!jvm.jit.methodEntryTrace && !thread.callStack.isEmpty()) {
    await jvm.executeTick();
    if (++ticks > 1000000) throw new Error('Child trace derivation exceeded scheduler tick limit');
  }
  const trace = jvm.jit.methodEntryTrace;
  if (!trace?.state) {
    throw new Error(trace?.error || `Parent execution never entered ${targetMethodKey}`);
  }
  fs.writeFileSync(outputPath, JSON.stringify(trace, null, 2));
  process.stdout.write(`${JSON.stringify({
    parentMethodKey: source.methodKey,
    targetMethodKey,
    ticksUntilCapture: ticks,
    output: outputPath,
    bytes: fs.statSync(outputPath).size,
    loadedClasses: trace.state.loadedClasses?.length || 0,
    graphNodes: trace.state.graph?.nodes?.length || 0,
    externalResources: trace.state.externalResources?.length || 0,
  }, null, 2)}\n`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
