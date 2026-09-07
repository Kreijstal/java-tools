'use strict';
const ssaCallStack = thread.callStack.items;
const ssaRestoringClassInitializationGuard = ssaLinkClassGuard655;
if ((!nestedEntryGuarded && (helpers.profileMethods || helpers.needsBytecodeChecks() || thread.status !== 'runnable')) || (nestedEntryGuarded !== 2 && ((ssaRestoringClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaRestoringClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaRestoringClassInitializationGuard)))) { return ssaAsyncInvoke; }
const restorationDepth = ssaCallStack.length;
let frame = null;
let locals = null;
let stack = null;
let ssaRestoredFrame = null;
let ssaEntryStaticValue0 = ((Number(ssaLinkStaticCell6555.value /* h:I */)) | 0);
let ssaEntryStaticValue1 = ((Number(ssaLinkStaticCell6556.value /* b:I */)) | 0);
let ssaEntryStaticValue2 = ((Number(ssaLinkStaticCell6557.value /* c:I */)) | 0);
let ssaEntryStaticValue3 = ((Number(ssaLinkStaticCell6560.value /* g:I */)) | 0);
let ssaEntryStaticValue4 = ((Number(ssaLinkStaticCell6562.value /* j:I */)) | 0);
let ssaEntryStaticValue5 = ssaLinkStaticCell6563.value /* l:[I */;
let ssaEntryStaticArrayData5 = (ssaEntryStaticValue5 == null ? null : ssaEntryStaticValue5.elements ? ssaEntryStaticValue5.elements : (Array.isArray(ssaEntryStaticValue5) || ArrayBuffer.isView(ssaEntryStaticValue5) ? ssaEntryStaticValue5 : null));
let safePointBudget = 25600;
let local0 = ((Number(argument0)) | 0);
let local1 = ((Number(argument1)) | 0);
let local2 = ((Number(argument2)) | 0);
let local3 = ((Number(argument3)) | 0);
let local4 = ((Number(argument4)) | 0);
let local5 = undefined;
let local6 = undefined;
let local7 = undefined;
let local8 = undefined;
let local9 = undefined;
let local10 = undefined;
let local11 = undefined;
let local12 = undefined;
let local13 = undefined;
let local14 = undefined;
if (ssaEntryStaticArrayData5 === null) { return ssaAsyncInvoke; }
if (!(local1 < ssaEntryStaticValue0)) {
  if (local1 < ssaEntryStaticValue1) {
    if (!((local0) >= ssaEntryStaticValue2)) {
      local2 = ((((local2) - (((ssaEntryStaticValue2 - (local0)) | 0))) | 0));
      local0 = ssaEntryStaticValue2;
    }
    if (!(((((local0) + (local2)) | 0)) <= ssaEntryStaticValue3)) {
      local2 = (((ssaEntryStaticValue3 - (local0)) | 0));
    }
    local5 = (((256 - local4) | 0));
    local6 = (Math.imul(((((local3 >> (16 & 31))) & 255)), local4));
    local7 = (Math.imul(((((local3 >> (8 & 31))) & 255)), local4));
    local8 = (Math.imul(((local3 & 255)), local4));
    local12 = ((((local0) + (Math.imul(local1, ssaEntryStaticValue4))) | 0));
    local13 = 0;
    safePointBudget = Math.min(safePointBudget, 256);
    const ssaArrayRangeTrips8 = (local13 >= local2 ? 0 : (local2 - local13));
    const ssaArrayRangeGuard0 = (ssaArrayRangeTrips8 === 0 || (ssaArrayRangeTrips8 <= 1024 && 1 >= 0 && (local12 + 0) >= 0 && (local12 + 0 + (ssaArrayRangeTrips8 - 1) * 1) < ssaEntryStaticArrayData5.length && (local12 + 0 + (ssaArrayRangeTrips8 - 1) * 1) <= 2147483647));
    const ssaRuntimeCoarseTrips8 = (local13 >= local2 ? 0 : (local2 - local13));
    const ssaRuntimeCoarseLoop8 = ssaRuntimeCoarseTrips8 <= 1024;
    if (ssaRuntimeCoarseLoop8) safePointBudget -= ssaRuntimeCoarseTrips8;
    if (ssaRuntimeCoarseLoop8 && ssaArrayRangeGuard0) {
      L8: while (local13 < local2) {
        const ssaValue47862 = local12;
        const ssaValue47863 = ssaEntryStaticValue5;
        let ssaValue47864;
        ssaValue47864 = ((ssaEntryStaticArrayData5[ssaValue47862]) | 0);
        const ssaValue47865 = (ssaValue47864 >> (16 & 31));
        const ssaValue47866 = (ssaValue47865 & 255);
        const ssaValue47867 = local5;
        const ssaValue47868 = Math.imul(ssaValue47866, ssaValue47867);
        local9 = ssaValue47868;
        const ssaValue47870 = ssaEntryStaticValue5;
        let ssaValue47871;
        ssaValue47871 = ((ssaEntryStaticArrayData5[ssaValue47862]) | 0);
        const ssaValue47872 = (ssaValue47871 >> (8 & 31));
        const ssaValue47873 = (ssaValue47872 & 255);
        const ssaValue47874 = Math.imul(ssaValue47873, ssaValue47867);
        local10 = ssaValue47874;
        const ssaValue47876 = ssaEntryStaticValue5;
        let ssaValue47877;
        ssaValue47877 = ((ssaEntryStaticArrayData5[ssaValue47862]) | 0);
        const ssaValue47878 = (ssaValue47877 & 255);
        const ssaValue47879 = Math.imul(ssaValue47878, ssaValue47867);
        local11 = ssaValue47879;
        const ssaValue47880 = local6;
        const ssaValue47881 = ((ssaValue47880 + ssaValue47868) | 0);
        const ssaValue47882 = (ssaValue47881 >> (8 & 31));
        const ssaValue47883 = (ssaValue47882 << (16 & 31));
        const ssaValue47884 = local7;
        const ssaValue47885 = ((ssaValue47884 + ssaValue47874) | 0);
        const ssaValue47886 = (ssaValue47885 >> (8 & 31));
        const ssaValue47887 = (ssaValue47886 << (8 & 31));
        const ssaValue47888 = ((ssaValue47883 + ssaValue47887) | 0);
        const ssaValue47889 = local8;
        const ssaValue47890 = ((ssaValue47889 + ssaValue47879) | 0);
        const ssaValue47891 = (ssaValue47890 >> (8 & 31));
        const ssaValue47892 = ((ssaValue47888 + ssaValue47891) | 0);
        local14 = ssaValue47892;
        const ssaValue47894 = (ssaValue47862 + 1) | 0;
        local12 = ssaValue47894;
        const ssaValue47895 = ssaEntryStaticValue5;
        ssaEntryStaticArrayData5[ssaValue47862] = ((ssaValue47892) | 0);
        const ssaValue47896 = local13;
        const ssaValue47897 = (ssaValue47896 + 1) | 0;
        local13 = ssaValue47897;
      }
      return ssaReturnVoid;
    } else {
      L8: while (local13 < local2) {
        if (!ssaRuntimeCoarseLoop8 && --safePointBudget <= 0) {
          if (nestedEntryGuarded === 2 || helpers.continueStructuredQuantum(thread)) { safePointBudget = 256; } else {
            ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(288, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, ((Number(argument3)) | 0), ((Number(argument4)) | 0), local5, local6, local7, local8, local9, local10, local11, local12, local13, local14]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
            stack.length = 0;
            helpers.materialize(frame, locals, stack, 61);
            helpers.structuredSsa.safePointCount += 1;
            return { deopt: true, transient: true, reason: 'structured SSA safe point' };
          }
        }
        const ssaValue47862 = local12;
        const ssaValue47863 = ssaEntryStaticValue5;
        let ssaValue47864;
        if (!ssaArrayRangeGuard0 && ((ssaValue47864 = ssaEntryStaticArrayData5[ssaValue47862]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 66, [ssaValue47863, ssaValue47862]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47864 = helpers.arrayLoad(ssaValue47862, ssaValue47863, frame, "iaload");
          frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
          locals = null;
          stack = null;
        } else {
          ssaValue47864 = ssaArrayRangeGuard0 ? ((ssaEntryStaticArrayData5[ssaValue47862]) | 0) : ((ssaValue47864) | 0);
        }
        const ssaValue47865 = (ssaValue47864 >> (16 & 31));
        const ssaValue47866 = (ssaValue47865 & 255);
        const ssaValue47867 = local5;
        const ssaValue47868 = Math.imul(ssaValue47866, ssaValue47867);
        local9 = ssaValue47868;
        const ssaValue47870 = ssaEntryStaticValue5;
        let ssaValue47871;
        if (!ssaArrayRangeGuard0 && ((ssaValue47871 = ssaEntryStaticArrayData5[ssaValue47862]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 76, [ssaValue47870, ssaValue47862]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47871 = helpers.arrayLoad(ssaValue47862, ssaValue47870, frame, "iaload");
          frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
          locals = null;
          stack = null;
        } else {
          ssaValue47871 = ssaArrayRangeGuard0 ? ((ssaEntryStaticArrayData5[ssaValue47862]) | 0) : ((ssaValue47871) | 0);
        }
        const ssaValue47872 = (ssaValue47871 >> (8 & 31));
        const ssaValue47873 = (ssaValue47872 & 255);
        const ssaValue47874 = Math.imul(ssaValue47873, ssaValue47867);
        local10 = ssaValue47874;
        const ssaValue47876 = ssaEntryStaticValue5;
        let ssaValue47877;
        if (!ssaArrayRangeGuard0 && ((ssaValue47877 = ssaEntryStaticArrayData5[ssaValue47862]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 86, [ssaValue47876, ssaValue47862]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47877 = helpers.arrayLoad(ssaValue47862, ssaValue47876, frame, "iaload");
          frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
          locals = null;
          stack = null;
        } else {
          ssaValue47877 = ssaArrayRangeGuard0 ? ((ssaEntryStaticArrayData5[ssaValue47862]) | 0) : ((ssaValue47877) | 0);
        }
        const ssaValue47878 = (ssaValue47877 & 255);
        const ssaValue47879 = Math.imul(ssaValue47878, ssaValue47867);
        local11 = ssaValue47879;
        const ssaValue47880 = local6;
        const ssaValue47881 = ((ssaValue47880 + ssaValue47868) | 0);
        const ssaValue47882 = (ssaValue47881 >> (8 & 31));
        const ssaValue47883 = (ssaValue47882 << (16 & 31));
        const ssaValue47884 = local7;
        const ssaValue47885 = ((ssaValue47884 + ssaValue47874) | 0);
        const ssaValue47886 = (ssaValue47885 >> (8 & 31));
        const ssaValue47887 = (ssaValue47886 << (8 & 31));
        const ssaValue47888 = ((ssaValue47883 + ssaValue47887) | 0);
        const ssaValue47889 = local8;
        const ssaValue47890 = ((ssaValue47889 + ssaValue47879) | 0);
        const ssaValue47891 = (ssaValue47890 >> (8 & 31));
        const ssaValue47892 = ((ssaValue47888 + ssaValue47891) | 0);
        local14 = ssaValue47892;
        const ssaValue47894 = (ssaValue47862 + 1) | 0;
        local12 = ssaValue47894;
        const ssaValue47895 = ssaEntryStaticValue5;
        ssaEntryStaticArrayData5[ssaValue47862] = ((ssaValue47892) | 0);
        const ssaValue47896 = local13;
        const ssaValue47897 = (ssaValue47896 + 1) | 0;
        local13 = ssaValue47897;
      }
      return ssaReturnVoid;
    }
  }
}
return ssaReturnVoid;
//# sourceURL=jvm-generated://hk/c(IIIII)V?tier=ssa-direct-restoring-positional
