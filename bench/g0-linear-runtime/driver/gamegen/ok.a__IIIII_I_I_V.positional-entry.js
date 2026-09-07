'use strict';
const jit = plan.jit;
if (!plan.staticInitialization.initialized) return plan.asyncInvoke;
const target = plan.target;
if (target.freeFrame && jit.profileMethods) jit.syncReusedFrameCount += 1;
const child = target.freeFrame || new plan.Frame(plan.method);
target.freeFrame = null;
if (plan.clearStructuredContinuation) plan.clearStructuredContinuation(child);
child.pc = 0;
child.stack.items.length = 0;
child.jitSkipOnce = undefined;
child.jitJsDisabled = undefined;
child.jitAdaptiveEntryCounted = undefined;
child.jitGeneratedReturnParent = undefined;
child.jitGeneratedReturnType = undefined;
child.className = plan.lookupClass;
child.locals[0] = argument0;
child.locals[1] = argument1;
child.locals[2] = argument2;
child.locals[3] = argument3;
child.locals[4] = argument4;
child.locals[5] = argument5;
child.locals[6] = argument6;
const adaptiveFrameless = plan.framelessMode === 2;
const useFrameless = plan.framelessMode === 1 ||
  (adaptiveFrameless && target.preferFrameless === true);
let result;
let baseDepth = -1;
const entryDepth = thread.callStack.items.length;
let positionalTimingStarted = -1;
let positionalExclusiveTiming = null;
if (useFrameless) {
  baseDepth = thread.callStack.items.length;
  if (child.isSynchronizedMethod && !child.monitorEntered &&
      !jit.jvm.enterFrameMonitorIfNeeded(child, thread)) {
    result = { deopt: true, reason: 'synchronized monitor contended' };
  } else {
  if (plan.referenceFrameless) jit.referenceFramelessPositionalRunCount += 1;
  if (plan.compiledCallChain) jit.compiledCallChainRunCount += 1;
  if (jit.shouldBeginExclusiveTimingKey(plan.methodKey)) {
    positionalExclusiveTiming = jit.beginExclusiveTiming(plan.methodKey, plan.exclusiveTier);
  }
  if (jit.profileTimings) {
    jit.methodTimingRandomState = (Math.imul(jit.methodTimingRandomState, 1664525) + 1013904223) >>> 0;
    if (jit.methodTimingRandomState < 0x100000000 / jit.methodTimingSampleRate) {
      positionalTimingStarted = jit.monotonicNow();
    }
  }
  try {
    result = plan.framelessBody(child, thread, jit, false, true);
  } catch (error) {
    jit.endExclusiveTiming(positionalExclusiveTiming);
    if (positionalTimingStarted >= 0) {
      jit.recordMethodTiming(plan.methodKey, jit.monotonicNow() - positionalTimingStarted, plan.generated);
    }
    plan.restoreFrame(thread, baseDepth, child);
    if (adaptiveFrameless) {
      target.preferFrameless = false;
      target.framelessRejected = true;
    }
    throw error;
  }
  if (positionalTimingStarted >= 0) {
    jit.recordMethodTiming(plan.methodKey, jit.monotonicNow() - positionalTimingStarted, plan.generated);
  }
  jit.endExclusiveTiming(positionalExclusiveTiming);
  }
} else {
  thread.callStack.push(child);
  if (child.isSynchronizedMethod && !child.monitorEntered &&
      !jit.jvm.enterFrameMonitorIfNeeded(child, thread)) {
    result = { deopt: true, reason: 'synchronized monitor contended' };
  } else {
  result = jit.runGeneratedFrame(plan.canonicalGeneratedBody, child, thread, false);
  if (result && typeof result.then === 'function') {
    throw new Error('Synchronous positional method returned a Promise');
  }
  }
}
if (result && result.deopt) {
  if (jit.generatedDeoptTrace) jit.recordGeneratedDeoptTrace(child, 0, result);
  if (useFrameless) {
    plan.restoreFrame(thread, baseDepth, child);
    if (adaptiveFrameless) {
      target.preferFrameless = false;
      target.framelessRejected = true;
    }
  } else if (adaptiveFrameless && !target.framelessRejected &&
      result.reason === 'structured SSA continuation') {
    target.framelessBudgetYields = (target.framelessBudgetYields || 0) + 1;
    if (target.framelessBudgetYields >= plan.adaptiveYieldThreshold) {
      target.preferFrameless = true;
    }
  }
  result.jvmPositionalChild = child;
  return result;
}
if (thread.callStack.items.length !== entryDepth) {
  if (useFrameless) plan.restoreFrame(thread, baseDepth, child);
  if (adaptiveFrameless) {
    target.preferFrameless = false;
    target.framelessRejected = true;
  }
  result = { deopt: true, transient: true,
    reason: 'positional generated callee left active child',
    jvmPositionalChild: child };
  return result;
}
if (useFrameless && child.monitorEntered === true) {
  jit.jvm.exitFrameMonitor(child);
}
if (adaptiveFrameless && !useFrameless && !target.framelessRejected) {
  target.framelessWarmCompletions = (target.framelessWarmCompletions || 0) + 1;
  if (target.framelessWarmCompletions >= plan.adaptiveThreshold) {
    target.preferFrameless = true;
  }
}
target.freeFrame = child;
if (jit.debugPositionalDepth && thread.callStack.items.length !== entryDepth) {
  const frames = thread.callStack.items;
  console.error('[positional-depth-leak]', JSON.stringify({
    callee: plan.methodKey, useFrameless, entryDepth,
    depth: frames.length,
    leaked: frames.slice(entryDepth).map(f =>
      `${f.className}.${f.method && f.method.name}@pc${f.pc}`),
  }) + '\n' + new Error().stack.split('\n').slice(2, 12).join('\n'));
}
return plan.returnVoid;
//# sourceURL=jvm-generated://ok/a(%5BIIIII%5BI%5BI)V?tier=positional-entry
