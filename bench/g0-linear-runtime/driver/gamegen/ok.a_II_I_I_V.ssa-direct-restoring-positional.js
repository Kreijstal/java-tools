'use strict';
const ssaCallStack = thread.callStack.items;
const ssaRestoringClassInitializationGuard = ssaLinkClassGuard635;
if ((!nestedEntryGuarded && (helpers.profileMethods || helpers.needsBytecodeChecks() || thread.status !== 'runnable')) || (nestedEntryGuarded !== 2 && ((ssaRestoringClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaRestoringClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaRestoringClassInitializationGuard)))) { return ssaAsyncInvoke; }
const restorationDepth = ssaCallStack.length;
let frame = null;
let locals = null;
let stack = null;
let ssaRestoredFrame = null;
const ssaFastPathsOk = !helpers.profileMethods && helpers.jvm.debugManager.jitDeoptedClassCount === 0;
const ssaCallSite0 = ssaLinkCallSite9955;
const ssaCallSite1 = ssaLinkCallSite9956;
const ssaCallSite56 = ssaLinkCallSite9957;
let safePointBudget = 10500;
let local0 = ((Number(argument0)) | 0);
let local1 = ((Number(argument1)) | 0);
let local2 = argument2;
let local3 = argument3;
let local4 = undefined;
let local5 = undefined;
let local6 = undefined;
let local7 = undefined;
/*__JVM_REGION_CALL_START_0__*/
let ssaValue46928;
let ssaValue46930 = ssaCallStack.length;
let ssaFastPositional0 = ssaFastPathsOk && ssaCallSite0.fastPositional ? ssaCallSite0.fastPositional : null;
let ssaFastPositionalInvoke0 = ssaFastPositional0 === null ? null : ssaFastPositional0.invoke;
let ssaFastPositionalRawInvoke0 = ssaFastPositional0 === null ? null : ssaFastPositional0.rawInvoke;
let ssaFastPositionalReceiver0 = ssaFastPositional0 === null ? null : ssaFastPositional0.receiverType;
let ssaValue46931 = false;
if ((ssaFastPositionalRawInvoke0 || ssaFastPositionalInvoke0) && true) {
  ssaValue46931 = true;
  try { ssaValue46928 = ssaFastPositionalRawInvoke0 ? ssaFastPositionalRawInvoke0(helpers, thread, true) : ssaFastPositionalInvoke0(thread, true); } catch (ssaValue46929) {
    /*__JVM_CALL_HANDLER_START_0__*/
    if (!ssaFastPositionalInvoke0.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue46930) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    } else {
      /*__JVM_CALL_RESTORE_START_0__*/
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 0, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      /*__JVM_CALL_RESTORE_END_0__*/
    }
    throw ssaValue46929;
    /*__JVM_CALL_HANDLER_END_0__*/
  }
}
if (!ssaValue46931 || ssaValue46928 === ssaAsyncInvoke) {
  if (frame === null) {
    ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  }
  stack.length = 0;
  try { ssaValue46928 = helpers.tryInvokeSyncAt(9955, frame, thread); } catch (ssaValue46929) {
    if (true && ssaCallStack.length > ssaValue46930) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    } else {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 0, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    }
    throw ssaValue46929;
  }
}
if (ssaValue46928 === ssaAsyncInvoke &&
    ssaCallStack.length > ssaValue46930) {
  if (frame === null) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  }
}
if (ssaValue46928 === ssaAsyncInvoke &&
    ssaCallStack.length > ssaValue46930 &&
    helpers.linkStructuredCallChild(frame, thread, ssaValue46930, "void", 9955)) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee left active child', jvmPositionalChild: frame };
}
if (ssaValue46928 === ssaAsyncInvoke) {
  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 0, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  helpers.skipJitOnce(frame);
  return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };
}
if (ssaValue46928 && ssaValue46928.deopt) {
  if (frame === null && (ssaValue46928.jvmPositionalChild || ssaCallStack.length > ssaValue46930)) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  }
  if (!helpers.linkStructuredCallChild(frame, thread, ssaValue46930, "void", undefined, ssaValue46928.jvmPositionalChild)) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 0, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    helpers.skipJitOnce(frame);
    return ssaValue46928;
  }
  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  if (frame) ssaValue46928.jvmPositionalChild = frame;
  return ssaValue46928;
}
if (frame !== null) {
  frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
  locals = null;
  stack = null;
}
if (ssaCallStack.length > ssaValue46930) {
  if (frame === null) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  }
}
if (ssaCallStack.length > ssaValue46930 &&
    helpers.linkStructuredCallChild(frame, thread, ssaValue46930, "void")) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    return { deopt: true, transient: true, reason: 'structured SSA callee left active child', jvmPositionalChild: frame };
}
if (thread.status !== 'runnable') {
  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee', jvmPositionalChild: frame };
}
/*__JVM_REGION_CALL_END_0__*/
if (frame !== null) {
  frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
  locals = null;
  stack = null;
}
safePointBudget = Math.min(safePointBudget, 105);
L1: while (true) {
  if (--safePointBudget <= 0) {
    if (nestedEntryGuarded === 2 || helpers.continueStructuredQuantum(thread)) { safePointBudget = 105; } else {
      ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      stack.length = 0;
      helpers.materialize(frame, locals, stack, 1);
      helpers.structuredSsa.safePointCount += 1;
      return { deopt: true, transient: true, reason: 'structured SSA safe point' };
    }
  }
  /*__JVM_REGION_CALL_START_1__*/
  let ssaValue46934;
  let ssaValue46936 = ssaCallStack.length;
  let ssaFastPositional1 = ssaFastPathsOk && ssaCallSite1.fastPositional ? ssaCallSite1.fastPositional : null;
  let ssaFastPositionalInvoke1 = ssaFastPositional1 === null ? null : ssaFastPositional1.invoke;
  let ssaFastPositionalRawInvoke1 = ssaFastPositional1 === null ? null : ssaFastPositional1.rawInvoke;
  let ssaFastPositionalReceiver1 = ssaFastPositional1 === null ? null : ssaFastPositional1.receiverType;
  let ssaValue46937 = false;
  if ((ssaFastPositionalRawInvoke1 || ssaFastPositionalInvoke1) && true) {
    ssaValue46937 = true;
    try { ssaValue46934 = ssaFastPositionalRawInvoke1 ? ssaFastPositionalRawInvoke1(helpers, thread, true) : ssaFastPositionalInvoke1(thread, true); } catch (ssaValue46935) {
      /*__JVM_CALL_HANDLER_START_1__*/
      if (!ssaFastPositionalInvoke1.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue46936) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 2, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      } else {
        /*__JVM_CALL_RESTORE_START_1__*/
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        /*__JVM_CALL_RESTORE_END_1__*/
      }
      throw ssaValue46935;
      /*__JVM_CALL_HANDLER_END_1__*/
    }
  }
  if (!ssaValue46937 || ssaValue46934 === ssaAsyncInvoke) {
    if (frame === null) {
      ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    }
    stack.length = 0;
    try { ssaValue46934 = helpers.tryInvokeSyncAt(9956, frame, thread); } catch (ssaValue46935) {
      if (true && ssaCallStack.length > ssaValue46936) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 2, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      } else {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
      throw ssaValue46935;
    }
  }
  if (ssaValue46934 === ssaAsyncInvoke &&
      ssaCallStack.length > ssaValue46936) {
    if (frame === null) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 2, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    }
  }
  if (ssaValue46934 === ssaAsyncInvoke &&
      ssaCallStack.length > ssaValue46936 &&
      helpers.linkStructuredCallChild(frame, thread, ssaValue46936, "boolean", 9956)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 2, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee left active child', jvmPositionalChild: frame };
  }
  if (ssaValue46934 === ssaAsyncInvoke) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    helpers.skipJitOnce(frame);
    return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };
  }
  if (ssaValue46934 && ssaValue46934.deopt) {
    if (frame === null && (ssaValue46934.jvmPositionalChild || ssaCallStack.length > ssaValue46936)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 2, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    }
    if (!helpers.linkStructuredCallChild(frame, thread, ssaValue46936, "boolean", undefined, ssaValue46934.jvmPositionalChild)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 1, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.skipJitOnce(frame);
      return ssaValue46934;
    }
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 2, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    if (frame) ssaValue46934.jvmPositionalChild = frame;
    return ssaValue46934;
  }
  if (frame !== null) {
    frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
    locals = null;
    stack = null;
  }
  if (ssaCallStack.length > ssaValue46936) {
    if (frame === null) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 2, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    }
  }
  if (ssaCallStack.length > ssaValue46936 &&
      helpers.linkStructuredCallChild(frame, thread, ssaValue46936, "boolean")) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 2, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      return { deopt: true, transient: true, reason: 'structured SSA callee left active child', jvmPositionalChild: frame };
  }
  if (thread.status !== 'runnable') {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7], 2, [ssaValue46934]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee', jvmPositionalChild: frame };
  }
  /*__JVM_REGION_CALL_END_1__*/
  if (frame !== null) {
    frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
    locals = null;
    stack = null;
  }
  if (ssaValue46934 === 0) {
    return ssaReturnVoid;
  } else {
    local4 = (ssaLinkStaticCell6339.value);
    local5 = (ssaLinkStaticCell6340.value);
    local6 = (ssaLinkStaticCell6341.value);
    if (!(local2 === null)) {
      const ssaValue46946 = (((local6) - (ssaLinkStaticCell6342.value)) | 0);
      local7 = ssaValue46946;
      const ssaValue46947 = local4;
      let ssaValue46949;
      if (local2 == null || ((ssaValue46946 >>> 0) >= local2.length)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 18, [ssaValue46947, local2, ssaValue46946]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        ssaValue46949 = helpers.arrayLoad(ssaValue46946, local2, frame, "iaload");
        frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
        locals = null;
        stack = null;
      } else {
        ssaValue46949 = ((local2.elements ? local2.elements[ssaValue46946] : local2[ssaValue46946]) | 0);
      }
      if (!(ssaValue46947 >= (((ssaValue46949 + (ssaLinkStaticCell6343.value)) | 0)))) {
        const ssaValue46953 = local7;
        let ssaValue46954;
        if (local2 == null || ((ssaValue46953 >>> 0) >= local2.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 24, [local2, ssaValue46953]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue46954 = helpers.arrayLoad(ssaValue46953, local2, frame, "iaload");
          frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
          locals = null;
          stack = null;
        } else {
          ssaValue46954 = ((local2.elements ? local2.elements[ssaValue46953] : local2[ssaValue46953]) | 0);
        }
        local4 = (((ssaValue46954 + (ssaLinkStaticCell6344.value)) | 0));
      }
      const ssaValue46957 = local5;
      const ssaValue46959 = local7;
      let ssaValue46960;
      if (local2 == null || ((ssaValue46959 >>> 0) >= local2.length)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 31, [ssaValue46957, local2, ssaValue46959]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        ssaValue46960 = helpers.arrayLoad(ssaValue46959, local2, frame, "iaload");
        frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
        locals = null;
        stack = null;
      } else {
        ssaValue46960 = ((local2.elements ? local2.elements[ssaValue46959] : local2[ssaValue46959]) | 0);
      }
      let ssaValue46962;
      if (local3 == null || ((ssaValue46959 >>> 0) >= local3.length)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 34, [ssaValue46957, ssaValue46960, local3, ssaValue46959]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        ssaValue46962 = helpers.arrayLoad(ssaValue46959, local3, frame, "iaload");
        frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
        locals = null;
        stack = null;
      } else {
        ssaValue46962 = ((local3.elements ? local3.elements[ssaValue46959] : local3[ssaValue46959]) | 0);
      }
      if (!(ssaValue46957 <= ((((((ssaValue46960 + ssaValue46962) | 0)) + (ssaLinkStaticCell6345.value)) | 0)))) {
        const ssaValue46967 = local7;
        let ssaValue46968;
        if (local2 == null || ((ssaValue46967 >>> 0) >= local2.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 41, [local2, ssaValue46967]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue46968 = helpers.arrayLoad(ssaValue46967, local2, frame, "iaload");
          frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
          locals = null;
          stack = null;
        } else {
          ssaValue46968 = ((local2.elements ? local2.elements[ssaValue46967] : local2[ssaValue46967]) | 0);
        }
        let ssaValue46970;
        if (local3 == null || ((ssaValue46967 >>> 0) >= local3.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 44, [ssaValue46968, local3, ssaValue46967]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue46970 = helpers.arrayLoad(ssaValue46967, local3, frame, "iaload");
          frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
          locals = null;
          stack = null;
        } else {
          ssaValue46970 = ((local3.elements ? local3.elements[ssaValue46967] : local3[ssaValue46967]) | 0);
        }
        local5 = ((((((ssaValue46968 + ssaValue46970) | 0)) + (ssaLinkStaticCell6346.value)) | 0));
      }
    }
    const ssaValue46974 = local4;
    const ssaValue46975 = local6;
    const ssaValue46976 = local5;
    const ssaValue46977 = ((ssaValue46976 - ssaValue46974) | 0);
    /*__JVM_REGION_CALL_START_56__*/
    let ssaValue46980;
    let ssaValue46982 = ssaCallStack.length;
    let ssaFastPositional56 = ssaFastPathsOk && ssaCallSite56.fastPositional ? ssaCallSite56.fastPositional : null;
    let ssaFastPositionalInvoke56 = ssaFastPositional56 === null ? null : ssaFastPositional56.invoke;
    let ssaFastPositionalRawInvoke56 = ssaFastPositional56 === null ? null : ssaFastPositional56.rawInvoke;
    let ssaFastPositionalReceiver56 = ssaFastPositional56 === null ? null : ssaFastPositional56.receiverType;
    let ssaValue46983 = false;
    if ((ssaFastPositionalRawInvoke56 || ssaFastPositionalInvoke56) && true) {
      ssaValue46983 = true;
      try { ssaValue46980 = ssaFastPositionalRawInvoke56 ? ssaFastPositionalRawInvoke56(helpers, /*__JVM_CALL_ARG_56_0__*/ssaValue46974, /*__JVM_CALL_ARG_56_1__*/ssaValue46975, /*__JVM_CALL_ARG_56_2__*/ssaValue46977, /*__JVM_CALL_ARG_56_3__*/local0, /*__JVM_CALL_ARG_56_4__*/local1, thread, true) : ssaFastPositionalInvoke56(ssaValue46974, ssaValue46975, ssaValue46977, local0, local1, thread, true); } catch (ssaValue46981) {
        /*__JVM_CALL_HANDLER_START_56__*/
        if (!ssaFastPositionalInvoke56.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue46982) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 57, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        } else {
          /*__JVM_CALL_RESTORE_START_56__*/
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 56, [ssaValue46974, ssaValue46975, ssaValue46977, local0, local1]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          /*__JVM_CALL_RESTORE_END_56__*/
        }
        throw ssaValue46981;
        /*__JVM_CALL_HANDLER_END_56__*/
      }
    }
    if (!ssaValue46983 || ssaValue46980 === ssaAsyncInvoke) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(278, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), argument2, argument3, local4, local5, local6, local7]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
      stack[0] = ssaValue46974;
      stack[1] = ssaValue46975;
      stack[2] = ssaValue46977;
      stack[3] = local0;
      stack[4] = local1;
      stack.length = 5;
      try { ssaValue46980 = helpers.tryInvokeSyncAt(9957, frame, thread); } catch (ssaValue46981) {
        if (true && ssaCallStack.length > ssaValue46982) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 57, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        } else {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 56, [ssaValue46974, ssaValue46975, ssaValue46977, local0, local1]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        }
        throw ssaValue46981;
      }
    }
    if (ssaValue46980 === ssaAsyncInvoke &&
        ssaCallStack.length > ssaValue46982) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 57, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
    }
    if (ssaValue46980 === ssaAsyncInvoke &&
        ssaCallStack.length > ssaValue46982 &&
        helpers.linkStructuredCallChild(frame, thread, ssaValue46982, "void", 9957)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 57, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee left active child', jvmPositionalChild: frame };
    }
    if (ssaValue46980 === ssaAsyncInvoke) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 56, [ssaValue46974, ssaValue46975, ssaValue46977, local0, local1]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.skipJitOnce(frame);
      return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };
    }
    if (ssaValue46980 && ssaValue46980.deopt) {
      if (frame === null && (ssaValue46980.jvmPositionalChild || ssaCallStack.length > ssaValue46982)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 57, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
      if (!helpers.linkStructuredCallChild(frame, thread, ssaValue46982, "void", undefined, ssaValue46980.jvmPositionalChild)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 56, [ssaValue46974, ssaValue46975, ssaValue46977, local0, local1]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.skipJitOnce(frame);
        return ssaValue46980;
      }
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 57, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      if (frame) ssaValue46980.jvmPositionalChild = frame;
      return ssaValue46980;
    }
    if (frame !== null) {
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    }
    if (ssaCallStack.length > ssaValue46982) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 57, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
    }
    if (ssaCallStack.length > ssaValue46982 &&
        helpers.linkStructuredCallChild(frame, thread, ssaValue46982, "void")) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 57, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        return { deopt: true, transient: true, reason: 'structured SSA callee left active child', jvmPositionalChild: frame };
    }
    if (thread.status !== 'runnable') {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(278, plan, thread, restorationDepth, frame, [local0, local1, argument2, argument3, ssaValue46974, ssaValue46976, ssaValue46975, local7], 57, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee', jvmPositionalChild: frame };
    }
    /*__JVM_REGION_CALL_END_56__*/
    if (frame !== null) {
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    }
    continue L1;
  }
}
//# sourceURL=jvm-generated://ok/a(II%5BI%5BI)V?tier=ssa-direct-restoring-positional
