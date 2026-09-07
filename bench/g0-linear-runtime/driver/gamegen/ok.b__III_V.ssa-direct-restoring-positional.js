'use strict';
const ssaCallStack = thread.callStack.items;
const ssaRestoringClassInitializationGuard = ssaLinkClassGuard633;
if ((!nestedEntryGuarded && (helpers.profileMethods || helpers.needsBytecodeChecks() || thread.status !== 'runnable')) || (nestedEntryGuarded !== 2 && ((ssaRestoringClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaRestoringClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaRestoringClassInitializationGuard)))) { return ssaAsyncInvoke; }
const restorationDepth = ssaCallStack.length;
let frame = null;
let locals = null;
let stack = null;
let ssaRestoredFrame = null;
let safePointBudget = 10100;
let local0 = argument0;
let local1 = ((Number(argument1)) | 0);
let local2 = ((Number(argument2)) | 0);
let local3 = undefined;
let local4 = undefined;
let local5 = undefined;
let local6 = undefined;
let local7 = undefined;
const ssaEntryArrayData0 = (local0 == null ? null : local0.elements ? local0.elements : (Array.isArray(local0) || ArrayBuffer.isView(local0) ? local0 : null));
if (ssaEntryArrayData0 === null) { return ssaAsyncInvoke; }
L9: {
  local3 = ((((ssaLinkStaticCell6309.value) + (((local2) << (1 & 31)))) | 0));
  const ssaValue46838 = ssaLinkStaticCell6310.value;
  if (!(ssaValue46838 === null)) {
    const ssaValue46840 = ssaLinkStaticCell6311.value;
    if (ssaValue46840 == null) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [argument0, ((Number(argument1)) | 0), local2, local3, local4, local5, local6, local7], 9, [ssaValue46840]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.arrayLength(ssaValue46840, frame);
    }
    if ((ssaValue46840.length) >= (local3)) {
      break L9;
    }
  }
  const ssaValue46844 = local3;
  let ssaValue46845;
  try { ssaValue46845 = helpers.newPrimitiveArray(ssaValue46844, "int"); } catch (ssaValue46846) {
    ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 15, [ssaValue46844]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    throw ssaValue46846;
  }
  local4 = ssaValue46845;
  local5 = 0;
  safePointBudget = Math.min(safePointBudget, 101);
  L5: while (true) {
    if (--safePointBudget <= 0) {
      if (nestedEntryGuarded === 2 || helpers.continueStructuredQuantum(thread)) { safePointBudget = 101; } else {
        ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(277, plan, thread, restorationDepth, frame, [argument0, ((Number(argument1)) | 0), local2, local3, local4, local5, local6, local7]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        stack.length = 0;
        helpers.materialize(frame, locals, stack, 19);
        helpers.structuredSsa.safePointCount += 1;
        return { deopt: true, transient: true, reason: 'structured SSA safe point' };
      }
    }
    if ((local5) >= (ssaLinkStaticCell6312.value)) {
      ssaLinkStaticCell6314.value = (local4);
      if (helpers.directStaticTargets[6314].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6314]);
      break L9;
    } else {
      const ssaValue46849 = local4;
      const ssaValue46850 = local5;
      const ssaValue46851 = ssaLinkStaticCell6313.value;
      const ssaValue46852 = (ssaValue46851 == null ? null : ssaValue46851.elements ? ssaValue46851.elements : (Array.isArray(ssaValue46851) || ArrayBuffer.isView(ssaValue46851) ? ssaValue46851 : null));
      let ssaValue46853;
      if (!false && (ssaValue46852 === null || (ssaValue46853 = ssaValue46852[ssaValue46850]) === undefined)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [argument0, ((Number(argument1)) | 0), local2, local3, ssaValue46849, ssaValue46850, local6, local7], 26, [ssaValue46849, ssaValue46850, ssaValue46851, ssaValue46850]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        ssaValue46853 = helpers.arrayLoad(ssaValue46850, ssaValue46851, frame, "iaload");
      } else {
        ssaValue46853 = false ? ((ssaValue46852[ssaValue46850]) | 0) : ((ssaValue46853) | 0);
      }
      if (ssaValue46849 == null || ((ssaValue46850 >>> 0) >= ssaValue46849.length)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [argument0, ((Number(argument1)) | 0), local2, local3, ssaValue46849, ssaValue46850, local6, local7], 27, [ssaValue46849, ssaValue46850, ssaValue46853]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.arrayStore(ssaValue46853, ssaValue46850, ssaValue46849, frame, "iastore");
      } else if (ssaValue46849.elements) {
        ssaValue46849.elements[ssaValue46850] = ((ssaValue46853) | 0);
      } else {
        ssaValue46849[ssaValue46850] = ((ssaValue46853) | 0);
      }
      local5 = ((ssaValue46850 + 1) | 0);
      continue L5;
    }
  }
}
local2 = (((local2) + local1) | 0);
local4 = (((local2 - 2) | 0));
local5 = local1;
safePointBudget = Math.min(safePointBudget, 101);
const ssaArrayRangeGuard1 = (((local2 - local5) <= 0 ? 0 : Math.ceil((local2 - local5) / 2)) === 0 || (((local2 - local5) <= 0 ? 0 : Math.ceil((local2 - local5) / 2)) <= 1024 && (local5 + 0) >= 0 && (local5 + (((local2 - local5) <= 0 ? 0 : Math.ceil((local2 - local5) / 2)) - 1) * 2 + 1) >= (local5 + 0) && (local5 + (((local2 - local5) <= 0 ? 0 : Math.ceil((local2 - local5) / 2)) - 1) * 2 + 1) <= 2147483647 && (local5 + ((local2 - local5) <= 0 ? 0 : Math.ceil((local2 - local5) / 2)) * 2) >= local5 && (local5 + ((local2 - local5) <= 0 ? 0 : Math.ceil((local2 - local5) / 2)) * 2) <= 2147483647 && (local5 + (((local2 - local5) <= 0 ? 0 : Math.ceil((local2 - local5) / 2)) - 1) * 2 + 1) < ssaEntryArrayData0.length));
const ssaRuntimeCoarseTrips10 = (local5 >= local2 ? 0 : Math.ceil((local2 - local5) / 2));
const ssaRuntimeCoarseLoop10 = ssaRuntimeCoarseTrips10 <= 1024 && local5 <= 2147483647 - ssaRuntimeCoarseTrips10 * 2;
if (ssaRuntimeCoarseLoop10) safePointBudget -= ssaRuntimeCoarseTrips10;
if (ssaRuntimeCoarseLoop10 && ssaArrayRangeGuard1) {
  L10: while (local5 < local2) {
    const ssaValue46864 = local4;
    const ssaValue46865 = ((ssaValue46864 + 1) | 0);
    let ssaValue46866;
    if (!false && ((ssaValue46866 = ssaEntryArrayData0[ssaValue46865]) === undefined)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 50, [local0, ssaValue46865]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      ssaValue46866 = helpers.arrayLoad(ssaValue46865, local0, frame, "iaload");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaValue46866 = false ? ((ssaEntryArrayData0[ssaValue46865]) | 0) : ((ssaValue46866) | 0);
    }
    local6 = ssaValue46866;
    const ssaValue46867 = local5;
    const ssaValue46868 = ((ssaValue46867 + 1) | 0);
    let ssaValue46869;
    ssaValue46869 = ((ssaEntryArrayData0[ssaValue46868]) | 0);
    local7 = ssaValue46869;
    if (ssaValue46866 >= ssaValue46869) {
      const ssaValue46897 = local7;
      const ssaValue46898 = local6;
      if (!(ssaValue46897 >= ssaValue46898)) {
        const ssaValue46899 = ssaLinkStaticCell6327.value;
        const ssaValue46900 = (ssaValue46899 == null ? null : ssaValue46899.elements ? ssaValue46899.elements : (Array.isArray(ssaValue46899) || ArrayBuffer.isView(ssaValue46899) ? ssaValue46899 : null));
        const ssaValue46901 = ssaLinkStaticCell6328.value;
        const ssaValue46902 = ((ssaValue46901 + 1) | 0);
        ssaLinkStaticCell6329.value = ssaValue46902;
        if (helpers.directStaticTargets[6329].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6329]);
        const ssaValue46905 = local5;
        let ssaValue46906;
        ssaValue46906 = ((ssaEntryArrayData0[ssaValue46905]) | 0);
        if (ssaValue46899 == null || ((ssaValue46901 >>> 0) >= ssaValue46899.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, local4, ssaValue46905, local6, local7], 111, [ssaValue46899, ssaValue46901, ssaValue46906]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue46906, ssaValue46901, ssaValue46899, frame, "iastore");
        } else if (ssaValue46900 !== null) {
          ssaValue46900[ssaValue46901] = ((ssaValue46906) | 0);
        } else if (ssaValue46899.elements) {
          ssaValue46899.elements[ssaValue46901] = ((ssaValue46906) | 0);
        } else {
          ssaValue46899[ssaValue46901] = ((ssaValue46906) | 0);
        }
        const ssaValue46907 = ssaLinkStaticCell6330.value;
        const ssaValue46908 = (ssaValue46907 == null ? null : ssaValue46907.elements ? ssaValue46907.elements : (Array.isArray(ssaValue46907) || ArrayBuffer.isView(ssaValue46907) ? ssaValue46907 : null));
        const ssaValue46909 = ssaLinkStaticCell6331.value;
        const ssaValue46910 = ((ssaValue46909 + 1) | 0);
        ssaLinkStaticCell6332.value = ssaValue46910;
        if (helpers.directStaticTargets[6332].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6332]);
        const ssaValue46912 = local7;
        if (ssaValue46907 == null || ((ssaValue46909 >>> 0) >= ssaValue46907.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, local4, ssaValue46905, local6, ssaValue46912], 119, [ssaValue46907, ssaValue46909, ssaValue46912]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue46912, ssaValue46909, ssaValue46907, frame, "iastore");
        } else if (ssaValue46908 !== null) {
          ssaValue46908[ssaValue46909] = ((ssaValue46912) | 0);
        } else if (ssaValue46907.elements) {
          ssaValue46907.elements[ssaValue46909] = ((ssaValue46912) | 0);
        } else {
          ssaValue46907[ssaValue46909] = ((ssaValue46912) | 0);
        }
        const ssaValue46913 = ssaLinkStaticCell6333.value;
        const ssaValue46914 = (ssaValue46913 == null ? null : ssaValue46913.elements ? ssaValue46913.elements : (Array.isArray(ssaValue46913) || ArrayBuffer.isView(ssaValue46913) ? ssaValue46913 : null));
        const ssaValue46915 = ssaLinkStaticCell6334.value;
        const ssaValue46916 = ((ssaValue46915 + 1) | 0);
        ssaLinkStaticCell6335.value = ssaValue46916;
        if (helpers.directStaticTargets[6335].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6335]);
        const ssaValue46918 = local4;
        let ssaValue46919;
        if (!false && ((ssaValue46919 = ssaEntryArrayData0[ssaValue46918]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46918, ssaValue46905, local6, ssaValue46912], 128, [ssaValue46913, ssaValue46915, local0, ssaValue46918]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue46919 = helpers.arrayLoad(ssaValue46918, local0, frame, "iaload");
        } else {
          ssaValue46919 = false ? ((ssaEntryArrayData0[ssaValue46918]) | 0) : ((ssaValue46919) | 0);
        }
        if (ssaValue46913 == null || ((ssaValue46915 >>> 0) >= ssaValue46913.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46918, ssaValue46905, local6, ssaValue46912], 129, [ssaValue46913, ssaValue46915, ssaValue46919]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue46919, ssaValue46915, ssaValue46913, frame, "iastore");
        } else if (ssaValue46914 !== null) {
          ssaValue46914[ssaValue46915] = ((ssaValue46919) | 0);
        } else if (ssaValue46913.elements) {
          ssaValue46913.elements[ssaValue46915] = ((ssaValue46919) | 0);
        } else {
          ssaValue46913[ssaValue46915] = ((ssaValue46919) | 0);
        }
        const ssaValue46920 = ssaLinkStaticCell6336.value;
        const ssaValue46921 = (ssaValue46920 == null ? null : ssaValue46920.elements ? ssaValue46920.elements : (Array.isArray(ssaValue46920) || ArrayBuffer.isView(ssaValue46920) ? ssaValue46920 : null));
        const ssaValue46922 = ssaLinkStaticCell6337.value;
        const ssaValue46923 = ((ssaValue46922 + 1) | 0);
        ssaLinkStaticCell6338.value = ssaValue46923;
        if (helpers.directStaticTargets[6338].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6338]);
        const ssaValue46925 = local6;
        if (ssaValue46920 == null || ((ssaValue46922 >>> 0) >= ssaValue46920.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46918, ssaValue46905, ssaValue46925, ssaValue46912], 137, [ssaValue46920, ssaValue46922, ssaValue46925]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue46925, ssaValue46922, ssaValue46920, frame, "iastore");
        } else if (ssaValue46921 !== null) {
          ssaValue46921[ssaValue46922] = ((ssaValue46925) | 0);
        } else if (ssaValue46920.elements) {
          ssaValue46920.elements[ssaValue46922] = ((ssaValue46925) | 0);
        } else {
          ssaValue46920[ssaValue46922] = ((ssaValue46925) | 0);
        }
      }
    } else {
      const ssaValue46870 = ssaLinkStaticCell6315.value;
      const ssaValue46871 = (ssaValue46870 == null ? null : ssaValue46870.elements ? ssaValue46870.elements : (Array.isArray(ssaValue46870) || ArrayBuffer.isView(ssaValue46870) ? ssaValue46870 : null));
      const ssaValue46872 = ssaLinkStaticCell6316.value;
      const ssaValue46873 = ((ssaValue46872 + 1) | 0);
      ssaLinkStaticCell6317.value = ssaValue46873;
      if (helpers.directStaticTargets[6317].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6317]);
      const ssaValue46876 = local4;
      let ssaValue46877;
      if (!false && ((ssaValue46877 = ssaEntryArrayData0[ssaValue46876]) === undefined)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46876, local5, local6, local7], 69, [ssaValue46870, ssaValue46872, local0, ssaValue46876]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        ssaValue46877 = helpers.arrayLoad(ssaValue46876, local0, frame, "iaload");
      } else {
        ssaValue46877 = false ? ((ssaEntryArrayData0[ssaValue46876]) | 0) : ((ssaValue46877) | 0);
      }
      if (ssaValue46870 == null || ((ssaValue46872 >>> 0) >= ssaValue46870.length)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46876, local5, local6, local7], 70, [ssaValue46870, ssaValue46872, ssaValue46877]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.arrayStore(ssaValue46877, ssaValue46872, ssaValue46870, frame, "iastore");
      } else if (ssaValue46871 !== null) {
        ssaValue46871[ssaValue46872] = ((ssaValue46877) | 0);
      } else if (ssaValue46870.elements) {
        ssaValue46870.elements[ssaValue46872] = ((ssaValue46877) | 0);
      } else {
        ssaValue46870[ssaValue46872] = ((ssaValue46877) | 0);
      }
      const ssaValue46878 = ssaLinkStaticCell6318.value;
      const ssaValue46879 = (ssaValue46878 == null ? null : ssaValue46878.elements ? ssaValue46878.elements : (Array.isArray(ssaValue46878) || ArrayBuffer.isView(ssaValue46878) ? ssaValue46878 : null));
      const ssaValue46880 = ssaLinkStaticCell6319.value;
      const ssaValue46881 = ((ssaValue46880 + 1) | 0);
      ssaLinkStaticCell6320.value = ssaValue46881;
      if (helpers.directStaticTargets[6320].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6320]);
      const ssaValue46883 = local6;
      if (ssaValue46878 == null || ((ssaValue46880 >>> 0) >= ssaValue46878.length)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46876, local5, ssaValue46883, local7], 78, [ssaValue46878, ssaValue46880, ssaValue46883]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.arrayStore(ssaValue46883, ssaValue46880, ssaValue46878, frame, "iastore");
      } else if (ssaValue46879 !== null) {
        ssaValue46879[ssaValue46880] = ((ssaValue46883) | 0);
      } else if (ssaValue46878.elements) {
        ssaValue46878.elements[ssaValue46880] = ((ssaValue46883) | 0);
      } else {
        ssaValue46878[ssaValue46880] = ((ssaValue46883) | 0);
      }
      const ssaValue46884 = ssaLinkStaticCell6321.value;
      const ssaValue46885 = (ssaValue46884 == null ? null : ssaValue46884.elements ? ssaValue46884.elements : (Array.isArray(ssaValue46884) || ArrayBuffer.isView(ssaValue46884) ? ssaValue46884 : null));
      const ssaValue46886 = ssaLinkStaticCell6322.value;
      const ssaValue46887 = ((ssaValue46886 + 1) | 0);
      ssaLinkStaticCell6323.value = ssaValue46887;
      if (helpers.directStaticTargets[6323].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6323]);
      const ssaValue46889 = local5;
      let ssaValue46890;
      ssaValue46890 = ((ssaEntryArrayData0[ssaValue46889]) | 0);
      if (ssaValue46884 == null || ((ssaValue46886 >>> 0) >= ssaValue46884.length)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46876, ssaValue46889, ssaValue46883, local7], 88, [ssaValue46884, ssaValue46886, ssaValue46890]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.arrayStore(ssaValue46890, ssaValue46886, ssaValue46884, frame, "iastore");
      } else if (ssaValue46885 !== null) {
        ssaValue46885[ssaValue46886] = ((ssaValue46890) | 0);
      } else if (ssaValue46884.elements) {
        ssaValue46884.elements[ssaValue46886] = ((ssaValue46890) | 0);
      } else {
        ssaValue46884[ssaValue46886] = ((ssaValue46890) | 0);
      }
      const ssaValue46891 = ssaLinkStaticCell6324.value;
      const ssaValue46892 = (ssaValue46891 == null ? null : ssaValue46891.elements ? ssaValue46891.elements : (Array.isArray(ssaValue46891) || ArrayBuffer.isView(ssaValue46891) ? ssaValue46891 : null));
      const ssaValue46893 = ssaLinkStaticCell6325.value;
      const ssaValue46894 = ((ssaValue46893 + 1) | 0);
      ssaLinkStaticCell6326.value = ssaValue46894;
      if (helpers.directStaticTargets[6326].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6326]);
      const ssaValue46896 = local7;
      if (ssaValue46891 == null || ((ssaValue46893 >>> 0) >= ssaValue46891.length)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46876, ssaValue46889, ssaValue46883, ssaValue46896], 96, [ssaValue46891, ssaValue46893, ssaValue46896]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.arrayStore(ssaValue46896, ssaValue46893, ssaValue46891, frame, "iastore");
      } else if (ssaValue46892 !== null) {
        ssaValue46892[ssaValue46893] = ((ssaValue46896) | 0);
      } else if (ssaValue46891.elements) {
        ssaValue46891.elements[ssaValue46893] = ((ssaValue46896) | 0);
      } else {
        ssaValue46891[ssaValue46893] = ((ssaValue46896) | 0);
      }
    }
    const ssaValue46926 = local5;
    local4 = ssaValue46926;
    const ssaValue46927 = (ssaValue46926 + 2) | 0;
    local5 = ssaValue46927;
  }
  return ssaReturnVoid;
} else {
  L10: while (local5 < local2) {
    if (!ssaRuntimeCoarseLoop10 && --safePointBudget <= 0) {
      if (nestedEntryGuarded === 2 || helpers.continueStructuredQuantum(thread)) { safePointBudget = 101; } else {
        ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(277, plan, thread, restorationDepth, frame, [argument0, ((Number(argument1)) | 0), local2, local3, local4, local5, local6, local7]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        stack.length = 0;
        helpers.materialize(frame, locals, stack, 43);
        helpers.structuredSsa.safePointCount += 1;
        return { deopt: true, transient: true, reason: 'structured SSA safe point' };
      }
    }
    const ssaValue46864 = local4;
    const ssaValue46865 = ((ssaValue46864 + 1) | 0);
    let ssaValue46866;
    if (!false && ((ssaValue46866 = ssaEntryArrayData0[ssaValue46865]) === undefined)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 50, [local0, ssaValue46865]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      ssaValue46866 = helpers.arrayLoad(ssaValue46865, local0, frame, "iaload");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaValue46866 = false ? ((ssaEntryArrayData0[ssaValue46865]) | 0) : ((ssaValue46866) | 0);
    }
    local6 = ssaValue46866;
    const ssaValue46867 = local5;
    const ssaValue46868 = ((ssaValue46867 + 1) | 0);
    let ssaValue46869;
    if (!ssaArrayRangeGuard1 && ((ssaValue46869 = ssaEntryArrayData0[ssaValue46868]) === undefined)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 56, [local0, ssaValue46868]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      ssaValue46869 = helpers.arrayLoad(ssaValue46868, local0, frame, "iaload");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaValue46869 = ssaArrayRangeGuard1 ? ((ssaEntryArrayData0[ssaValue46868]) | 0) : ((ssaValue46869) | 0);
    }
    local7 = ssaValue46869;
    if (ssaValue46866 >= ssaValue46869) {
      const ssaValue46897 = local7;
      const ssaValue46898 = local6;
      if (!(ssaValue46897 >= ssaValue46898)) {
        const ssaValue46899 = ssaLinkStaticCell6327.value;
        const ssaValue46900 = (ssaValue46899 == null ? null : ssaValue46899.elements ? ssaValue46899.elements : (Array.isArray(ssaValue46899) || ArrayBuffer.isView(ssaValue46899) ? ssaValue46899 : null));
        const ssaValue46901 = ssaLinkStaticCell6328.value;
        const ssaValue46902 = ((ssaValue46901 + 1) | 0);
        ssaLinkStaticCell6329.value = ssaValue46902;
        if (helpers.directStaticTargets[6329].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6329]);
        const ssaValue46905 = local5;
        let ssaValue46906;
        if (!ssaArrayRangeGuard1 && ((ssaValue46906 = ssaEntryArrayData0[ssaValue46905]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, local4, ssaValue46905, local6, local7], 110, [ssaValue46899, ssaValue46901, local0, ssaValue46905]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue46906 = helpers.arrayLoad(ssaValue46905, local0, frame, "iaload");
        } else {
          ssaValue46906 = ssaArrayRangeGuard1 ? ((ssaEntryArrayData0[ssaValue46905]) | 0) : ((ssaValue46906) | 0);
        }
        if (ssaValue46899 == null || ((ssaValue46901 >>> 0) >= ssaValue46899.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, local4, ssaValue46905, local6, local7], 111, [ssaValue46899, ssaValue46901, ssaValue46906]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue46906, ssaValue46901, ssaValue46899, frame, "iastore");
        } else if (ssaValue46900 !== null) {
          ssaValue46900[ssaValue46901] = ((ssaValue46906) | 0);
        } else if (ssaValue46899.elements) {
          ssaValue46899.elements[ssaValue46901] = ((ssaValue46906) | 0);
        } else {
          ssaValue46899[ssaValue46901] = ((ssaValue46906) | 0);
        }
        const ssaValue46907 = ssaLinkStaticCell6330.value;
        const ssaValue46908 = (ssaValue46907 == null ? null : ssaValue46907.elements ? ssaValue46907.elements : (Array.isArray(ssaValue46907) || ArrayBuffer.isView(ssaValue46907) ? ssaValue46907 : null));
        const ssaValue46909 = ssaLinkStaticCell6331.value;
        const ssaValue46910 = ((ssaValue46909 + 1) | 0);
        ssaLinkStaticCell6332.value = ssaValue46910;
        if (helpers.directStaticTargets[6332].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6332]);
        const ssaValue46912 = local7;
        if (ssaValue46907 == null || ((ssaValue46909 >>> 0) >= ssaValue46907.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, local4, ssaValue46905, local6, ssaValue46912], 119, [ssaValue46907, ssaValue46909, ssaValue46912]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue46912, ssaValue46909, ssaValue46907, frame, "iastore");
        } else if (ssaValue46908 !== null) {
          ssaValue46908[ssaValue46909] = ((ssaValue46912) | 0);
        } else if (ssaValue46907.elements) {
          ssaValue46907.elements[ssaValue46909] = ((ssaValue46912) | 0);
        } else {
          ssaValue46907[ssaValue46909] = ((ssaValue46912) | 0);
        }
        const ssaValue46913 = ssaLinkStaticCell6333.value;
        const ssaValue46914 = (ssaValue46913 == null ? null : ssaValue46913.elements ? ssaValue46913.elements : (Array.isArray(ssaValue46913) || ArrayBuffer.isView(ssaValue46913) ? ssaValue46913 : null));
        const ssaValue46915 = ssaLinkStaticCell6334.value;
        const ssaValue46916 = ((ssaValue46915 + 1) | 0);
        ssaLinkStaticCell6335.value = ssaValue46916;
        if (helpers.directStaticTargets[6335].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6335]);
        const ssaValue46918 = local4;
        let ssaValue46919;
        if (!false && ((ssaValue46919 = ssaEntryArrayData0[ssaValue46918]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46918, ssaValue46905, local6, ssaValue46912], 128, [ssaValue46913, ssaValue46915, local0, ssaValue46918]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue46919 = helpers.arrayLoad(ssaValue46918, local0, frame, "iaload");
        } else {
          ssaValue46919 = false ? ((ssaEntryArrayData0[ssaValue46918]) | 0) : ((ssaValue46919) | 0);
        }
        if (ssaValue46913 == null || ((ssaValue46915 >>> 0) >= ssaValue46913.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46918, ssaValue46905, local6, ssaValue46912], 129, [ssaValue46913, ssaValue46915, ssaValue46919]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue46919, ssaValue46915, ssaValue46913, frame, "iastore");
        } else if (ssaValue46914 !== null) {
          ssaValue46914[ssaValue46915] = ((ssaValue46919) | 0);
        } else if (ssaValue46913.elements) {
          ssaValue46913.elements[ssaValue46915] = ((ssaValue46919) | 0);
        } else {
          ssaValue46913[ssaValue46915] = ((ssaValue46919) | 0);
        }
        const ssaValue46920 = ssaLinkStaticCell6336.value;
        const ssaValue46921 = (ssaValue46920 == null ? null : ssaValue46920.elements ? ssaValue46920.elements : (Array.isArray(ssaValue46920) || ArrayBuffer.isView(ssaValue46920) ? ssaValue46920 : null));
        const ssaValue46922 = ssaLinkStaticCell6337.value;
        const ssaValue46923 = ((ssaValue46922 + 1) | 0);
        ssaLinkStaticCell6338.value = ssaValue46923;
        if (helpers.directStaticTargets[6338].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6338]);
        const ssaValue46925 = local6;
        if (ssaValue46920 == null || ((ssaValue46922 >>> 0) >= ssaValue46920.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46918, ssaValue46905, ssaValue46925, ssaValue46912], 137, [ssaValue46920, ssaValue46922, ssaValue46925]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue46925, ssaValue46922, ssaValue46920, frame, "iastore");
        } else if (ssaValue46921 !== null) {
          ssaValue46921[ssaValue46922] = ((ssaValue46925) | 0);
        } else if (ssaValue46920.elements) {
          ssaValue46920.elements[ssaValue46922] = ((ssaValue46925) | 0);
        } else {
          ssaValue46920[ssaValue46922] = ((ssaValue46925) | 0);
        }
      }
    } else {
      const ssaValue46870 = ssaLinkStaticCell6315.value;
      const ssaValue46871 = (ssaValue46870 == null ? null : ssaValue46870.elements ? ssaValue46870.elements : (Array.isArray(ssaValue46870) || ArrayBuffer.isView(ssaValue46870) ? ssaValue46870 : null));
      const ssaValue46872 = ssaLinkStaticCell6316.value;
      const ssaValue46873 = ((ssaValue46872 + 1) | 0);
      ssaLinkStaticCell6317.value = ssaValue46873;
      if (helpers.directStaticTargets[6317].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6317]);
      const ssaValue46876 = local4;
      let ssaValue46877;
      if (!false && ((ssaValue46877 = ssaEntryArrayData0[ssaValue46876]) === undefined)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46876, local5, local6, local7], 69, [ssaValue46870, ssaValue46872, local0, ssaValue46876]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        ssaValue46877 = helpers.arrayLoad(ssaValue46876, local0, frame, "iaload");
      } else {
        ssaValue46877 = false ? ((ssaEntryArrayData0[ssaValue46876]) | 0) : ((ssaValue46877) | 0);
      }
      if (ssaValue46870 == null || ((ssaValue46872 >>> 0) >= ssaValue46870.length)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46876, local5, local6, local7], 70, [ssaValue46870, ssaValue46872, ssaValue46877]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.arrayStore(ssaValue46877, ssaValue46872, ssaValue46870, frame, "iastore");
      } else if (ssaValue46871 !== null) {
        ssaValue46871[ssaValue46872] = ((ssaValue46877) | 0);
      } else if (ssaValue46870.elements) {
        ssaValue46870.elements[ssaValue46872] = ((ssaValue46877) | 0);
      } else {
        ssaValue46870[ssaValue46872] = ((ssaValue46877) | 0);
      }
      const ssaValue46878 = ssaLinkStaticCell6318.value;
      const ssaValue46879 = (ssaValue46878 == null ? null : ssaValue46878.elements ? ssaValue46878.elements : (Array.isArray(ssaValue46878) || ArrayBuffer.isView(ssaValue46878) ? ssaValue46878 : null));
      const ssaValue46880 = ssaLinkStaticCell6319.value;
      const ssaValue46881 = ((ssaValue46880 + 1) | 0);
      ssaLinkStaticCell6320.value = ssaValue46881;
      if (helpers.directStaticTargets[6320].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6320]);
      const ssaValue46883 = local6;
      if (ssaValue46878 == null || ((ssaValue46880 >>> 0) >= ssaValue46878.length)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46876, local5, ssaValue46883, local7], 78, [ssaValue46878, ssaValue46880, ssaValue46883]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.arrayStore(ssaValue46883, ssaValue46880, ssaValue46878, frame, "iastore");
      } else if (ssaValue46879 !== null) {
        ssaValue46879[ssaValue46880] = ((ssaValue46883) | 0);
      } else if (ssaValue46878.elements) {
        ssaValue46878.elements[ssaValue46880] = ((ssaValue46883) | 0);
      } else {
        ssaValue46878[ssaValue46880] = ((ssaValue46883) | 0);
      }
      const ssaValue46884 = ssaLinkStaticCell6321.value;
      const ssaValue46885 = (ssaValue46884 == null ? null : ssaValue46884.elements ? ssaValue46884.elements : (Array.isArray(ssaValue46884) || ArrayBuffer.isView(ssaValue46884) ? ssaValue46884 : null));
      const ssaValue46886 = ssaLinkStaticCell6322.value;
      const ssaValue46887 = ((ssaValue46886 + 1) | 0);
      ssaLinkStaticCell6323.value = ssaValue46887;
      if (helpers.directStaticTargets[6323].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6323]);
      const ssaValue46889 = local5;
      let ssaValue46890;
      if (!ssaArrayRangeGuard1 && ((ssaValue46890 = ssaEntryArrayData0[ssaValue46889]) === undefined)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46876, ssaValue46889, ssaValue46883, local7], 87, [ssaValue46884, ssaValue46886, local0, ssaValue46889]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        ssaValue46890 = helpers.arrayLoad(ssaValue46889, local0, frame, "iaload");
      } else {
        ssaValue46890 = ssaArrayRangeGuard1 ? ((ssaEntryArrayData0[ssaValue46889]) | 0) : ((ssaValue46890) | 0);
      }
      if (ssaValue46884 == null || ((ssaValue46886 >>> 0) >= ssaValue46884.length)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46876, ssaValue46889, ssaValue46883, local7], 88, [ssaValue46884, ssaValue46886, ssaValue46890]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.arrayStore(ssaValue46890, ssaValue46886, ssaValue46884, frame, "iastore");
      } else if (ssaValue46885 !== null) {
        ssaValue46885[ssaValue46886] = ((ssaValue46890) | 0);
      } else if (ssaValue46884.elements) {
        ssaValue46884.elements[ssaValue46886] = ((ssaValue46890) | 0);
      } else {
        ssaValue46884[ssaValue46886] = ((ssaValue46890) | 0);
      }
      const ssaValue46891 = ssaLinkStaticCell6324.value;
      const ssaValue46892 = (ssaValue46891 == null ? null : ssaValue46891.elements ? ssaValue46891.elements : (Array.isArray(ssaValue46891) || ArrayBuffer.isView(ssaValue46891) ? ssaValue46891 : null));
      const ssaValue46893 = ssaLinkStaticCell6325.value;
      const ssaValue46894 = ((ssaValue46893 + 1) | 0);
      ssaLinkStaticCell6326.value = ssaValue46894;
      if (helpers.directStaticTargets[6326].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6326]);
      const ssaValue46896 = local7;
      if (ssaValue46891 == null || ((ssaValue46893 >>> 0) >= ssaValue46891.length)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(277, plan, thread, restorationDepth, frame, [local0, ((Number(argument1)) | 0), local2, local3, ssaValue46876, ssaValue46889, ssaValue46883, ssaValue46896], 96, [ssaValue46891, ssaValue46893, ssaValue46896]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.arrayStore(ssaValue46896, ssaValue46893, ssaValue46891, frame, "iastore");
      } else if (ssaValue46892 !== null) {
        ssaValue46892[ssaValue46893] = ((ssaValue46896) | 0);
      } else if (ssaValue46891.elements) {
        ssaValue46891.elements[ssaValue46893] = ((ssaValue46896) | 0);
      } else {
        ssaValue46891[ssaValue46893] = ((ssaValue46896) | 0);
      }
    }
    const ssaValue46926 = local5;
    local4 = ssaValue46926;
    const ssaValue46927 = (ssaValue46926 + 2) | 0;
    local5 = ssaValue46927;
  }
  return ssaReturnVoid;
}
//# sourceURL=jvm-generated://ok/b(%5BIII)V?tier=ssa-direct-restoring-positional
