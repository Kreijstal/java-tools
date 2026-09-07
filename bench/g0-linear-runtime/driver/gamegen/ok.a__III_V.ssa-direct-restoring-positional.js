'use strict';
const ssaCallStack = thread.callStack.items;
const ssaRestoringClassInitializationGuard = ssaLinkClassGuard642;
if ((!nestedEntryGuarded && (helpers.profileMethods || helpers.needsBytecodeChecks() || thread.status !== 'runnable')) || (nestedEntryGuarded !== 2 && ((ssaRestoringClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaRestoringClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaRestoringClassInitializationGuard)))) { return ssaAsyncInvoke; }
const restorationDepth = ssaCallStack.length;
let frame = null;
let locals = null;
let stack = null;
let ssaRestoredFrame = null;
const ssaFastPathsOk = !helpers.profileMethods && helpers.jvm.debugManager.jitDeoptedClassCount === 0;
const ssaCallSite8 = ssaLinkCallSite9970;
let local0 = argument0;
let local1 = ((Number(argument1)) | 0);
let local2 = ((Number(argument2)) | 0);
if (local0 == null) {
  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), ((Number(argument2)) | 0)], 3, [local0, 0, local0]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  helpers.arrayLength(local0, frame);
}
const ssaValue47286 = local0.length;
/*__JVM_REGION_CALL_START_8__*/
let ssaValue47289;
let ssaValue47291 = ssaCallStack.length;
let ssaFastPositional8 = ssaFastPathsOk && ssaCallSite8.fastPositional ? ssaCallSite8.fastPositional : null;
let ssaFastPositionalInvoke8 = ssaFastPositional8 === null ? null : ssaFastPositional8.invoke;
let ssaFastPositionalRawInvoke8 = ssaFastPositional8 === null ? null : ssaFastPositional8.rawInvoke;
let ssaFastPositionalReceiver8 = ssaFastPositional8 === null ? null : ssaFastPositional8.receiverType;
let ssaValue47292 = false;
if ((ssaFastPositionalRawInvoke8 || ssaFastPositionalInvoke8) && true) {
  ssaValue47292 = true;
  try { ssaValue47289 = ssaFastPositionalRawInvoke8 ? ssaFastPositionalRawInvoke8(helpers, /*__JVM_CALL_ARG_8_0__*/local0, /*__JVM_CALL_ARG_8_1__*/0, /*__JVM_CALL_ARG_8_2__*/ssaValue47286, /*__JVM_CALL_ARG_8_3__*/local1, /*__JVM_CALL_ARG_8_4__*/local2, /*__JVM_CALL_ARG_8_5__*/null, /*__JVM_CALL_ARG_8_6__*/null, thread, true) : ssaFastPositionalInvoke8(local0, 0, ssaValue47286, local1, local2, null, null, thread, true); } catch (ssaValue47290) {
    /*__JVM_CALL_HANDLER_START_8__*/
    if (!ssaFastPositionalInvoke8.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue47291) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 9, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    } else {
      /*__JVM_CALL_RESTORE_START_8__*/
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 8, [local0, 0, ssaValue47286, local1, local2, null, null]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      /*__JVM_CALL_RESTORE_END_8__*/
    }
    throw ssaValue47290;
    /*__JVM_CALL_HANDLER_END_8__*/
  }
}
if (!ssaValue47292 || ssaValue47289 === ssaAsyncInvoke) {
  if (frame === null) {
    ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(282, plan, thread, restorationDepth, frame, [argument0, ((Number(argument1)) | 0), ((Number(argument2)) | 0)]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  }
  stack[0] = local0;
  stack[1] = 0;
  stack[2] = ssaValue47286;
  stack[3] = local1;
  stack[4] = local2;
  stack[5] = null;
  stack[6] = null;
  stack.length = 7;
  try { ssaValue47289 = helpers.tryInvokeSyncAt(9970, frame, thread); } catch (ssaValue47290) {
    if (true && ssaCallStack.length > ssaValue47291) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 9, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    } else {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 8, [local0, 0, ssaValue47286, local1, local2, null, null]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    }
    throw ssaValue47290;
  }
}
if (ssaValue47289 === ssaAsyncInvoke &&
    ssaCallStack.length > ssaValue47291) {
  if (frame === null) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 9, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  }
}
if (ssaValue47289 === ssaAsyncInvoke &&
    ssaCallStack.length > ssaValue47291 &&
    helpers.linkStructuredCallChild(frame, thread, ssaValue47291, "void", 9970)) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 9, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee left active child', jvmPositionalChild: frame };
}
if (ssaValue47289 === ssaAsyncInvoke) {
  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 8, [local0, 0, ssaValue47286, local1, local2, null, null]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  helpers.skipJitOnce(frame);
  return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };
}
if (ssaValue47289 && ssaValue47289.deopt) {
  if (frame === null && (ssaValue47289.jvmPositionalChild || ssaCallStack.length > ssaValue47291)) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 9, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  }
  if (!helpers.linkStructuredCallChild(frame, thread, ssaValue47291, "void", undefined, ssaValue47289.jvmPositionalChild)) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 8, [local0, 0, ssaValue47286, local1, local2, null, null]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    helpers.skipJitOnce(frame);
    return ssaValue47289;
  }
  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 9, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  if (frame) ssaValue47289.jvmPositionalChild = frame;
  return ssaValue47289;
}
if (frame !== null) {
  frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
  locals = null;
  stack = null;
}
if (ssaCallStack.length > ssaValue47291) {
  if (frame === null) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 9, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  }
}
if (ssaCallStack.length > ssaValue47291 &&
    helpers.linkStructuredCallChild(frame, thread, ssaValue47291, "void")) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 9, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    return { deopt: true, transient: true, reason: 'structured SSA callee left active child', jvmPositionalChild: frame };
}
if (thread.status !== 'runnable') {
  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(282, plan, thread, restorationDepth, frame, [local0, local1, local2], 9, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee', jvmPositionalChild: frame };
}
/*__JVM_REGION_CALL_END_8__*/
if (frame !== null) {
  frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
  locals = null;
  stack = null;
}
return ssaReturnVoid;
//# sourceURL=jvm-generated://ok/a(%5BIII)V?tier=ssa-direct-restoring-positional
