function jvm$ssa_direct_restoring_positional$ck$a_III_I_IIIIIIIIII_V(helpers,plan,argument0,argument1,argument2,argument3,argument4,argument5,argument6,argument7,argument8,argument9,argument10,argument11,argument12,argument13,thread,nestedEntryGuarded) {
'use strict';
const ssaCallStack = thread.callStack.items;
const ssaRestoringClassInitializationGuard = ssaLinkClassGuard0;
if ((!nestedEntryGuarded && (helpers.profileMethods || helpers.needsBytecodeChecks() || thread.status !== 'runnable')) || (nestedEntryGuarded !== 2 && ((ssaRestoringClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaRestoringClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaRestoringClassInitializationGuard)))) { return ssaAsyncInvoke; }
const restorationDepth = ssaCallStack.length;
let frame = null;
let locals = null;
let stack = null;
let ssaRestoredFrame = null;
let safePointBudget = 25600;
let local0 = ((Number(argument0)) | 0);
let local1 = ((Number(argument1)) | 0);
let local2 = ((Number(argument2)) | 0);
let local3 = argument3;
let local4 = argument4;
let local5 = ((Number(argument5)) | 0);
let local6 = ((Number(argument6)) | 0);
let local7 = ((Number(argument7)) | 0);
let local8 = ((Number(argument8)) | 0);
let local9 = ((Number(argument9)) | 0);
let local10 = ((Number(argument10)) | 0);
let local11 = ((Number(argument11)) | 0);
let local12 = ((Number(argument12)) | 0);
let local13 = ((Number(argument13)) | 0);
const ssaEntryArrayData3 = (local3 == null ? null : local3.elements ? local3.elements : (Array.isArray(local3) || ArrayBuffer.isView(local3) ? local3 : null));
const ssaEntryArrayData4 = (local4 == null ? null : local4.elements ? local4.elements : (Array.isArray(local4) || ArrayBuffer.isView(local4) ? local4 : null));
if (ssaEntryArrayData3 === null || ssaEntryArrayData4 === null) { return ssaAsyncInvoke; }
local8 = ((-local10) | 0);
safePointBudget = Math.min(safePointBudget, 256);
const ssaNestedAffineRange0OuterTrips = (local8 >= 0 ? 0 : (0 - local8));
const ssaNestedAffineRange0InnerTrips = ((-local9 | 0) >= 0 ? 0 : 0 - (-local9 | 0));
const ssaNestedAffineRange0RowStride = ssaNestedAffineRange0InnerTrips * 1 + local12;
const ssaNestedAffineRange0Last = local5 + (ssaNestedAffineRange0OuterTrips - 1) * ssaNestedAffineRange0RowStride + (ssaNestedAffineRange0InnerTrips - 1) * 1 + 0;
const ssaArrayRangeGuard0 = (ssaNestedAffineRange0OuterTrips === 0 || ssaNestedAffineRange0InnerTrips === 0 || (ssaNestedAffineRange0OuterTrips <= 1024 && ssaNestedAffineRange0InnerTrips <= 1024 && 1 >= 0 && local12 >= 0 && local5 + 0 >= 0 && ssaNestedAffineRange0Last < ssaEntryArrayData4.length && ssaNestedAffineRange0Last <= 2147483647));
if (!(ssaArrayRangeGuard0)) return ssaAsyncInvoke;
const ssaRuntimeCoarseTrips1 = (local8 >= 0 ? 0 : (0 - local8));
const ssaRuntimeCoarseLoop1 = ssaRuntimeCoarseTrips1 <= 1024;
if (ssaRuntimeCoarseLoop1) safePointBudget -= ssaRuntimeCoarseTrips1;
if (nestedEntryGuarded !== 2 && !ssaRuntimeCoarseLoop1) {
  ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(0, plan, thread, restorationDepth, frame, [local0, local1, local2, argument3, argument4, local5, local6, local7, local8, ((Number(argument9)) | 0), ((Number(argument10)) | 0), ((Number(argument11)) | 0), ((Number(argument12)) | 0), ((Number(argument13)) | 0)]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  stack.length = 0;
  helpers.materialize(frame, locals, stack, 3);
  helpers.skipJitOnce(frame);
  return { deopt: true, transient: true, reason: 'structured SSA coarse loop guard' };
}
L1: while (local8 < 0) {
  local6 = ((-local9) | 0);
  const ssaArrayRangeTrips3 = (local6 >= 0 ? 0 : (0 - local6));
  const ssaArrayRangeGuard1 = (ssaArrayRangeTrips3 === 0 || (ssaArrayRangeTrips3 <= 1024 && (local7 + 0) >= 0 && (local7 + ssaArrayRangeTrips3 * 1 + 0 + 1) >= (local7 + 0) && (local7 + ssaArrayRangeTrips3 * 1 + 0 + 1) <= ssaEntryArrayData3.length && (local7 + ssaArrayRangeTrips3 * 1 + 0 + 1) <= 2147483647));
  const ssaRuntimeCoarseTrips3 = (local6 >= 0 ? 0 : (0 - local6));
  const ssaRuntimeCoarseLoop3 = ssaRuntimeCoarseTrips3 <= 1024;
  if (ssaRuntimeCoarseLoop3) safePointBudget -= ssaRuntimeCoarseTrips3;
  if (ssaRuntimeCoarseLoop3 && ssaArrayRangeGuard0 && ssaArrayRangeGuard1) {
    L3: while (local6 < 0) {
      const ssaValue7 = local5;
      const ssaValue8 = (ssaValue7 + 1) | 0;
      local5 = ssaValue8;
      let ssaValue9;
      ssaValue9 = ((ssaEntryArrayData4[ssaValue7]) | 0);
      local0 = ssaValue9;
      if (ssaValue9 === 0) {
        const ssaValue36 = local7;
        const ssaValue37 = (ssaValue36 + 1) | 0;
        local7 = ssaValue37;
      } else {
        const ssaValue10 = local0;
        const ssaValue11 = (ssaValue10 & 16711935);
        const ssaValue13 = Math.imul(ssaValue11, local13);
        local1 = ssaValue13;
        const ssaValue14 = (ssaValue13 & -16711936);
        const ssaValue15 = Math.imul(ssaValue10, local13);
        const ssaValue16 = ((ssaValue15 - ssaValue13) | 0);
        const ssaValue17 = (ssaValue16 & 16711680);
        const ssaValue18 = ((ssaValue14 + ssaValue17) | 0);
        const ssaValue19 = ((ssaValue18 >>> (8 & 31)) | 0);
        local0 = ssaValue19;
        const ssaValue21 = local7;
        let ssaValue22;
        ssaValue22 = ((ssaEntryArrayData3[ssaValue21]) | 0);
        local1 = ssaValue22;
        const ssaValue23 = ((ssaValue19 + ssaValue22) | 0);
        local2 = ssaValue23;
        const ssaValue24 = (ssaValue19 & 16711935);
        const ssaValue25 = (ssaValue22 & 16711935);
        const ssaValue26 = ((ssaValue24 + ssaValue25) | 0);
        local0 = ssaValue26;
        const ssaValue27 = (ssaValue26 & 16777472);
        const ssaValue28 = ((ssaValue23 - ssaValue26) | 0);
        const ssaValue29 = (ssaValue28 & 65536);
        const ssaValue30 = ((ssaValue27 + ssaValue29) | 0);
        local1 = ssaValue30;
        const ssaValue31 = (ssaValue21 + 1) | 0;
        local7 = ssaValue31;
        const ssaValue32 = ((ssaValue23 - ssaValue30) | 0);
        const ssaValue33 = ((ssaValue30 >>> (8 & 31)) | 0);
        const ssaValue34 = ((ssaValue30 - ssaValue33) | 0);
        const ssaValue35 = (ssaValue32 | ssaValue34);
        ssaEntryArrayData3[ssaValue21] = ((ssaValue35) | 0);
      }
      const ssaValue38 = local6;
      const ssaValue39 = (ssaValue38 + 1) | 0;
      local6 = ssaValue39;
    }
    const ssaValue40 = local7;
    const ssaValue42 = ((ssaValue40 + local11) | 0);
    local7 = ssaValue42;
    const ssaValue43 = local5;
    const ssaValue45 = ((ssaValue43 + local12) | 0);
    local5 = ssaValue45;
    const ssaValue46 = local8;
    const ssaValue47 = (ssaValue46 + 1) | 0;
    local8 = ssaValue47;
    continue L1;
  } else {
    L3: while (local6 < 0) {
      if (!ssaRuntimeCoarseLoop3 && --safePointBudget <= 0) {
        if (nestedEntryGuarded === 2 || helpers.continueStructuredQuantum(thread)) { safePointBudget = 256; } else {
          ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(0, plan, thread, restorationDepth, frame, [local0, local1, local2, argument3, argument4, local5, local6, local7, local8, ((Number(argument9)) | 0), ((Number(argument10)) | 0), ((Number(argument11)) | 0), ((Number(argument12)) | 0), ((Number(argument13)) | 0)]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          stack.length = 0;
          helpers.materialize(frame, locals, stack, 8);
          helpers.structuredSsa.safePointCount += 1;
          return { deopt: true, transient: true, reason: 'structured SSA safe point' };
        }
      }
      const ssaValue7 = local5;
      const ssaValue8 = (ssaValue7 + 1) | 0;
      local5 = ssaValue8;
      let ssaValue9;
      if (!ssaArrayRangeGuard0 && ((ssaValue9 = ssaEntryArrayData4[ssaValue7]) === undefined)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 13, [local4, ssaValue7]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        ssaValue9 = helpers.arrayLoad(ssaValue7, local4, frame, "iaload");
        frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
        locals = null;
        stack = null;
      } else {
        ssaValue9 = ssaArrayRangeGuard0 ? ((ssaEntryArrayData4[ssaValue7]) | 0) : ((ssaValue9) | 0);
      }
      local0 = ssaValue9;
      if (ssaValue9 === 0) {
        const ssaValue36 = local7;
        const ssaValue37 = (ssaValue36 + 1) | 0;
        local7 = ssaValue37;
      } else {
        const ssaValue10 = local0;
        const ssaValue11 = (ssaValue10 & 16711935);
        const ssaValue13 = Math.imul(ssaValue11, local13);
        local1 = ssaValue13;
        const ssaValue14 = (ssaValue13 & -16711936);
        const ssaValue15 = Math.imul(ssaValue10, local13);
        const ssaValue16 = ((ssaValue15 - ssaValue13) | 0);
        const ssaValue17 = (ssaValue16 & 16711680);
        const ssaValue18 = ((ssaValue14 + ssaValue17) | 0);
        const ssaValue19 = ((ssaValue18 >>> (8 & 31)) | 0);
        local0 = ssaValue19;
        const ssaValue21 = local7;
        let ssaValue22;
        if (!ssaArrayRangeGuard1 && ((ssaValue22 = ssaEntryArrayData3[ssaValue21]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 39, [local3, ssaValue21]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue22 = helpers.arrayLoad(ssaValue21, local3, frame, "iaload");
          frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
          locals = null;
          stack = null;
        } else {
          ssaValue22 = ssaArrayRangeGuard1 ? ((ssaEntryArrayData3[ssaValue21]) | 0) : ((ssaValue22) | 0);
        }
        local1 = ssaValue22;
        const ssaValue23 = ((ssaValue19 + ssaValue22) | 0);
        local2 = ssaValue23;
        const ssaValue24 = (ssaValue19 & 16711935);
        const ssaValue25 = (ssaValue22 & 16711935);
        const ssaValue26 = ((ssaValue24 + ssaValue25) | 0);
        local0 = ssaValue26;
        const ssaValue27 = (ssaValue26 & 16777472);
        const ssaValue28 = ((ssaValue23 - ssaValue26) | 0);
        const ssaValue29 = (ssaValue28 & 65536);
        const ssaValue30 = ((ssaValue27 + ssaValue29) | 0);
        local1 = ssaValue30;
        const ssaValue31 = (ssaValue21 + 1) | 0;
        local7 = ssaValue31;
        const ssaValue32 = ((ssaValue23 - ssaValue30) | 0);
        const ssaValue33 = ((ssaValue30 >>> (8 & 31)) | 0);
        const ssaValue34 = ((ssaValue30 - ssaValue33) | 0);
        const ssaValue35 = (ssaValue32 | ssaValue34);
        ssaEntryArrayData3[ssaValue21] = ((ssaValue35) | 0);
      }
      const ssaValue38 = local6;
      const ssaValue39 = (ssaValue38 + 1) | 0;
      local6 = ssaValue39;
    }
    const ssaValue40 = local7;
    const ssaValue42 = ((ssaValue40 + local11) | 0);
    local7 = ssaValue42;
    const ssaValue43 = local5;
    const ssaValue45 = ((ssaValue43 + local12) | 0);
    local5 = ssaValue45;
    const ssaValue46 = local8;
    const ssaValue47 = (ssaValue46 + 1) | 0;
    local8 = ssaValue47;
    continue L1;
  }
}
return ssaReturnVoid;
//# sourceURL=jvm-generated://ck/a(III%5BI%5BIIIIIIIIII)V?tier=ssa-direct-restoring-positional
}