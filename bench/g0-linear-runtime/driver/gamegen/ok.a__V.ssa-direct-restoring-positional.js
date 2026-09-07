'use strict';
const ssaCallStack = thread.callStack.items;
const ssaRestoringClassInitializationGuard = ssaLinkClassGuard637;
if ((!nestedEntryGuarded && (helpers.profileMethods || helpers.needsBytecodeChecks() || thread.status !== 'runnable')) || (nestedEntryGuarded !== 2 && ((ssaRestoringClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaRestoringClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaRestoringClassInitializationGuard)))) { return ssaAsyncInvoke; }
const restorationDepth = ssaCallStack.length;
let frame = null;
let locals = null;
let stack = null;
let ssaRestoredFrame = null;
let ssaEntryStaticValue0 = ((Number(ssaLinkStaticCell6347.value /* d:I */)) | 0);
let ssaEntryStaticValue1 = ssaLinkStaticCell6353.value /* f:[I */;
let ssaEntryStaticArrayData1 = (ssaEntryStaticValue1 == null ? null : ssaEntryStaticValue1.elements ? ssaEntryStaticValue1.elements : (Array.isArray(ssaEntryStaticValue1) || ArrayBuffer.isView(ssaEntryStaticValue1) ? ssaEntryStaticValue1 : null));
const ssaFastPathsOk = !helpers.profileMethods && helpers.jvm.debugManager.jitDeoptedClassCount === 0;
const ssaCallSite14 = ssaLinkCallSite9961;
let safePointBudget = 12000;
let local0 = undefined;
let local1 = undefined;
let local2 = undefined;
let local3 = undefined;
let local4 = undefined;
let local5 = undefined;
let local6 = undefined;
let local7 = undefined;
let local8 = undefined;
if (ssaEntryStaticArrayData1 === null) { return ssaAsyncInvoke; }
if (ssaEntryStaticValue0 >= 0) {
  /*__JVM_REGION_CALL_START_14__*/
  let ssaValue46992;
  let ssaValue46994 = ssaCallStack.length;
  let ssaFastPositional14 = ssaFastPathsOk && ssaCallSite14.fastPositional ? ssaCallSite14.fastPositional : null;
  let ssaFastPositionalInvoke14 = ssaFastPositional14 === null ? null : ssaFastPositional14.invoke;
  let ssaFastPositionalRawInvoke14 = ssaFastPositional14 === null ? null : ssaFastPositional14.rawInvoke;
  let ssaFastPositionalReceiver14 = ssaFastPositional14 === null ? null : ssaFastPositional14.receiverType;
  let ssaValue46995 = false;
  if ((ssaFastPositionalRawInvoke14 || ssaFastPositionalInvoke14) && true) {
    ssaValue46995 = true;
    try { ssaValue46992 = ssaFastPositionalRawInvoke14 ? ssaFastPositionalRawInvoke14(helpers, /*__JVM_CALL_ARG_14_0__*/0, /*__JVM_CALL_ARG_14_1__*/ssaEntryStaticValue0, thread, true) : ssaFastPositionalInvoke14(0, ssaEntryStaticValue0, thread, true); } catch (ssaValue46993) {
      /*__JVM_CALL_HANDLER_START_14__*/
      if (!ssaFastPositionalInvoke14.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue46994) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 15, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      } else {
        /*__JVM_CALL_RESTORE_START_14__*/
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 14, [0, ssaEntryStaticValue0]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        /*__JVM_CALL_RESTORE_END_14__*/
      }
      throw ssaValue46993;
      /*__JVM_CALL_HANDLER_END_14__*/
    }
  }
  if (!ssaValue46995 || ssaValue46992 === ssaAsyncInvoke) {
    if (frame === null) {
      ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    }
    stack[0] = 0;
    stack[1] = ssaEntryStaticValue0;
    stack.length = 2;
    try { ssaValue46992 = helpers.tryInvokeSyncAt(9961, frame, thread); } catch (ssaValue46993) {
      if (true && ssaCallStack.length > ssaValue46994) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 15, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      } else {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 14, [0, ssaEntryStaticValue0]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
      throw ssaValue46993;
    }
  }
  if (ssaValue46992 === ssaAsyncInvoke &&
      ssaCallStack.length > ssaValue46994) {
    if (frame === null) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 15, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    }
  }
  if (ssaValue46992 === ssaAsyncInvoke &&
      ssaCallStack.length > ssaValue46994 &&
      helpers.linkStructuredCallChild(frame, thread, ssaValue46994, "void", 9961)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 15, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee left active child', jvmPositionalChild: frame };
  }
  if (ssaValue46992 === ssaAsyncInvoke) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 14, [0, ssaEntryStaticValue0]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    helpers.skipJitOnce(frame);
    return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };
  }
  if (ssaValue46992 && ssaValue46992.deopt) {
    if (frame === null && (ssaValue46992.jvmPositionalChild || ssaCallStack.length > ssaValue46994)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 15, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    }
    if (!helpers.linkStructuredCallChild(frame, thread, ssaValue46994, "void", undefined, ssaValue46992.jvmPositionalChild)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 14, [0, ssaEntryStaticValue0]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.skipJitOnce(frame);
      return ssaValue46992;
    }
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 15, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    if (frame) ssaValue46992.jvmPositionalChild = frame;
    return ssaValue46992;
  }
  if (frame !== null) {
    frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
    locals = null;
    stack = null;
  }
  if (ssaCallStack.length > ssaValue46994) {
    if (frame === null) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 15, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    }
  }
  if (ssaCallStack.length > ssaValue46994 &&
      helpers.linkStructuredCallChild(frame, thread, ssaValue46994, "void")) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 15, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      return { deopt: true, transient: true, reason: 'structured SSA callee left active child', jvmPositionalChild: frame };
  }
  if (thread.status !== 'runnable') {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8], 15, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee', jvmPositionalChild: frame };
  }
  /*__JVM_REGION_CALL_END_14__*/
  if (frame !== null) {
    frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
    locals = null;
    stack = null;
  }
  const ssaValue46999 = ssaEntryStaticValue1;
  const ssaValue47001 = 1;
  let ssaValue47000;
  if (!false && ((ssaValue47000 = ssaEntryStaticArrayData1[ssaValue47001]) === undefined)) {
    ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 17, [ssaValue46999, ssaValue47001]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    ssaValue47000 = helpers.arrayLoad(ssaValue47001, ssaValue46999, frame, "iaload");
    frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
    locals = null;
    stack = null;
  } else {
    ssaValue47000 = false ? ((ssaEntryStaticArrayData1[ssaValue47001]) | 0) : ((ssaValue47000) | 0);
  }
  local0 = ssaValue47000;
  if (!(ssaValue47000 >= (ssaLinkStaticCell6354.value))) {
    local0 = (ssaLinkStaticCell6355.value);
  }
  local1 = 0;
  local2 = 0;
  safePointBudget = Math.min(safePointBudget, 120);
  const ssaArrayRangeGuard1 = (((ssaEntryStaticValue0 - 0) <= 0 ? 0 : Math.ceil((ssaEntryStaticValue0 - 0) / 4)) === 0 || (((ssaEntryStaticValue0 - 0) <= 0 ? 0 : Math.ceil((ssaEntryStaticValue0 - 0) / 4)) <= 1024 && (0 + 0) >= 0 && (0 + (((ssaEntryStaticValue0 - 0) <= 0 ? 0 : Math.ceil((ssaEntryStaticValue0 - 0) / 4)) - 1) * 4 + 3) >= (0 + 0) && (0 + (((ssaEntryStaticValue0 - 0) <= 0 ? 0 : Math.ceil((ssaEntryStaticValue0 - 0) / 4)) - 1) * 4 + 3) <= 2147483647 && (0 + (((ssaEntryStaticValue0 - 0) <= 0 ? 0 : Math.ceil((ssaEntryStaticValue0 - 0) / 4)) - 1) * 4 + 3) < ssaEntryStaticArrayData1.length));
  const ssaRuntimeCoarseTrips6 = (local2 >= ssaEntryStaticValue0 ? 0 : Math.ceil((ssaEntryStaticValue0 - local2) / 4));
  const ssaRuntimeCoarseLoop6 = ssaRuntimeCoarseTrips6 <= 1024 && local2 <= 2147483647 - ssaRuntimeCoarseTrips6 * 4;
  if (ssaRuntimeCoarseLoop6) safePointBudget -= ssaRuntimeCoarseTrips6;
  if (ssaRuntimeCoarseLoop6 && ssaArrayRangeGuard1) {
    L6: while (true) {
      const ssaValue47004 = local2;
      if (!(ssaValue47004 >= ssaEntryStaticValue0)) {
        const ssaValue47007 = local2;
        const ssaValue47008 = ((ssaValue47007 + 1) | 0);
        const ssaValue47009 = ssaEntryStaticValue1;
        let ssaValue47010;
        ssaValue47010 = ((ssaEntryStaticArrayData1[ssaValue47008]) | 0);
        local3 = ssaValue47010;
        const ssaValue47011 = local0;
        if (ssaValue47011 >= ssaValue47010) {
          const ssaValue47013 = local2;
          const ssaValue47014 = ssaEntryStaticValue1;
          let ssaValue47015;
          ssaValue47015 = ((ssaEntryStaticArrayData1[ssaValue47013]) | 0);
          local4 = ssaValue47015;
          const ssaValue47017 = ((ssaValue47013 + 2) | 0);
          const ssaValue47018 = ssaEntryStaticValue1;
          let ssaValue47019;
          ssaValue47019 = ((ssaEntryStaticArrayData1[ssaValue47017]) | 0);
          local5 = ssaValue47019;
          const ssaValue47021 = ((ssaValue47013 + 3) | 0);
          const ssaValue47022 = ssaEntryStaticValue1;
          let ssaValue47023;
          ssaValue47023 = ((ssaEntryStaticArrayData1[ssaValue47021]) | 0);
          local6 = ssaValue47023;
          const ssaValue47024 = ((ssaValue47019 - ssaValue47015) | 0);
          const ssaValue47025 = (ssaValue47024 << (16 & 31));
          const ssaValue47026 = local3;
          const ssaValue47027 = ((ssaValue47023 - ssaValue47026) | 0);
          if (ssaValue47027 === 0) {
            ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 66, [ssaValue47025, ssaValue47027]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
            throw { type: "java/lang/ArithmeticException", message: "/ by zero" };
          }
          const ssaValue47028 = ((ssaValue47025 / ssaValue47027) | 0);
          local7 = ssaValue47028;
          const ssaValue47029 = (ssaValue47015 << (16 & 31));
          const ssaValue47030 = ((ssaValue47029 + 32768) | 0);
          local8 = ssaValue47030;
          const ssaValue47032 = local0;
          const ssaValue47033 = ((ssaValue47032 - ssaValue47026) | 0);
          const ssaValue47034 = Math.imul(ssaValue47033, ssaValue47028);
          const ssaValue47035 = ((ssaValue47030 + ssaValue47034) | 0);
          const ssaValue47036 = ssaEntryStaticValue1;
          ssaEntryStaticArrayData1[ssaValue47013] = ((ssaValue47035) | 0);
          const ssaValue47038 = ((ssaValue47013 + 2) | 0);
          const ssaValue47039 = ssaEntryStaticValue1;
          ssaEntryStaticArrayData1[ssaValue47038] = ((ssaValue47028) | 0);
          const ssaValue47040 = (ssaValue47013 + 4) | 0;
          local2 = ssaValue47040;
          continue L6;
        }
      }
      const ssaValue47041 = local1;
      ssaLinkStaticCell6363.value = ssaValue47041;
      if (helpers.directStaticTargets[6363].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6363]);
      const ssaValue47043 = local2;
      ssaLinkStaticCell6364.value = ssaValue47043;
      if (helpers.directStaticTargets[6364].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6364]);
      ssaLinkStaticCell6365.value = ssaValue47043;
      if (helpers.directStaticTargets[6365].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6365]);
      const ssaValue47046 = local0;
      const ssaValue47047 = ((ssaValue47046 - 1) | 0);
      ssaLinkStaticCell6366.value = ssaValue47047;
      if (helpers.directStaticTargets[6366].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6366]);
      return ssaReturnVoid;
    }
  } else {
    L6: while (true) {
      if (!ssaRuntimeCoarseLoop6 && --safePointBudget <= 0) {
        if (nestedEntryGuarded === 2 || helpers.continueStructuredQuantum(thread)) { safePointBudget = 120; } else {
          ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(279, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          stack.length = 0;
          helpers.materialize(frame, locals, stack, 28);
          helpers.structuredSsa.safePointCount += 1;
          return { deopt: true, transient: true, reason: 'structured SSA safe point' };
        }
      }
      const ssaValue47004 = local2;
      if (!(ssaValue47004 >= ssaEntryStaticValue0)) {
        const ssaValue47007 = local2;
        const ssaValue47008 = ((ssaValue47007 + 1) | 0);
        const ssaValue47009 = ssaEntryStaticValue1;
        let ssaValue47010;
        if (!ssaArrayRangeGuard1 && ((ssaValue47010 = ssaEntryStaticArrayData1[ssaValue47008]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 35, [ssaValue47009, ssaValue47008]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47010 = helpers.arrayLoad(ssaValue47008, ssaValue47009, frame, "iaload");
          frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
          locals = null;
          stack = null;
        } else {
          ssaValue47010 = ssaArrayRangeGuard1 ? ((ssaEntryStaticArrayData1[ssaValue47008]) | 0) : ((ssaValue47010) | 0);
        }
        local3 = ssaValue47010;
        const ssaValue47011 = local0;
        if (ssaValue47011 >= ssaValue47010) {
          const ssaValue47013 = local2;
          const ssaValue47014 = ssaEntryStaticValue1;
          let ssaValue47015;
          if (!ssaArrayRangeGuard1 && ((ssaValue47015 = ssaEntryStaticArrayData1[ssaValue47013]) === undefined)) {
            ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 44, [ssaValue47014, ssaValue47013]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
            ssaValue47015 = helpers.arrayLoad(ssaValue47013, ssaValue47014, frame, "iaload");
            frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
            locals = null;
            stack = null;
          } else {
            ssaValue47015 = ssaArrayRangeGuard1 ? ((ssaEntryStaticArrayData1[ssaValue47013]) | 0) : ((ssaValue47015) | 0);
          }
          local4 = ssaValue47015;
          const ssaValue47017 = ((ssaValue47013 + 2) | 0);
          const ssaValue47018 = ssaEntryStaticValue1;
          let ssaValue47019;
          if (!ssaArrayRangeGuard1 && ((ssaValue47019 = ssaEntryStaticArrayData1[ssaValue47017]) === undefined)) {
            ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 50, [ssaValue47018, ssaValue47017]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
            ssaValue47019 = helpers.arrayLoad(ssaValue47017, ssaValue47018, frame, "iaload");
            frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
            locals = null;
            stack = null;
          } else {
            ssaValue47019 = ssaArrayRangeGuard1 ? ((ssaEntryStaticArrayData1[ssaValue47017]) | 0) : ((ssaValue47019) | 0);
          }
          local5 = ssaValue47019;
          const ssaValue47021 = ((ssaValue47013 + 3) | 0);
          const ssaValue47022 = ssaEntryStaticValue1;
          let ssaValue47023;
          if (!ssaArrayRangeGuard1 && ((ssaValue47023 = ssaEntryStaticArrayData1[ssaValue47021]) === undefined)) {
            ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 56, [ssaValue47022, ssaValue47021]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
            ssaValue47023 = helpers.arrayLoad(ssaValue47021, ssaValue47022, frame, "iaload");
            frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
            locals = null;
            stack = null;
          } else {
            ssaValue47023 = ssaArrayRangeGuard1 ? ((ssaEntryStaticArrayData1[ssaValue47021]) | 0) : ((ssaValue47023) | 0);
          }
          local6 = ssaValue47023;
          const ssaValue47024 = ((ssaValue47019 - ssaValue47015) | 0);
          const ssaValue47025 = (ssaValue47024 << (16 & 31));
          const ssaValue47026 = local3;
          const ssaValue47027 = ((ssaValue47023 - ssaValue47026) | 0);
          if (ssaValue47027 === 0) {
            ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 66, [ssaValue47025, ssaValue47027]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
            throw { type: "java/lang/ArithmeticException", message: "/ by zero" };
          }
          const ssaValue47028 = ((ssaValue47025 / ssaValue47027) | 0);
          local7 = ssaValue47028;
          const ssaValue47029 = (ssaValue47015 << (16 & 31));
          const ssaValue47030 = ((ssaValue47029 + 32768) | 0);
          local8 = ssaValue47030;
          const ssaValue47032 = local0;
          const ssaValue47033 = ((ssaValue47032 - ssaValue47026) | 0);
          const ssaValue47034 = Math.imul(ssaValue47033, ssaValue47028);
          const ssaValue47035 = ((ssaValue47030 + ssaValue47034) | 0);
          const ssaValue47036 = ssaEntryStaticValue1;
          ssaEntryStaticArrayData1[ssaValue47013] = ((ssaValue47035) | 0);
          const ssaValue47038 = ((ssaValue47013 + 2) | 0);
          const ssaValue47039 = ssaEntryStaticValue1;
          if (!ssaArrayRangeGuard1 && ((ssaValue47038 >>> 0) >= ssaEntryStaticArrayData1.length)) {
            ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 89, [ssaValue47039, ssaValue47038, ssaValue47028]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
            helpers.arrayStore(ssaValue47028, ssaValue47038, ssaValue47039, frame, "iastore");
            frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
            locals = null;
            stack = null;
          } else {
            ssaEntryStaticArrayData1[ssaValue47038] = ((ssaValue47028) | 0);
          }
          const ssaValue47040 = (ssaValue47013 + 4) | 0;
          local2 = ssaValue47040;
          continue L6;
        }
      }
      const ssaValue47041 = local1;
      ssaLinkStaticCell6363.value = ssaValue47041;
      if (helpers.directStaticTargets[6363].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6363]);
      const ssaValue47043 = local2;
      ssaLinkStaticCell6364.value = ssaValue47043;
      if (helpers.directStaticTargets[6364].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6364]);
      ssaLinkStaticCell6365.value = ssaValue47043;
      if (helpers.directStaticTargets[6365].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6365]);
      const ssaValue47046 = local0;
      const ssaValue47047 = ((ssaValue47046 - 1) | 0);
      ssaLinkStaticCell6366.value = ssaValue47047;
      if (helpers.directStaticTargets[6366].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6366]);
      return ssaReturnVoid;
    }
  }
} else {
  ssaLinkStaticCell6348.value = 0;
  if (helpers.directStaticTargets[6348].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6348]);
  ssaLinkStaticCell6349.value = 0;
  if (helpers.directStaticTargets[6349].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6349]);
  ssaLinkStaticCell6350.value = 0;
  if (helpers.directStaticTargets[6350].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6350]);
  ssaLinkStaticCell6351.value = 2147483646;
  if (helpers.directStaticTargets[6351].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6351]);
  return ssaReturnVoid;
}
//# sourceURL=jvm-generated://ok/a()V?tier=ssa-direct-restoring-positional
