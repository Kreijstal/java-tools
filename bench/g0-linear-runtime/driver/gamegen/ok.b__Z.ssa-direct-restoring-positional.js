'use strict';
const ssaCallStack = thread.callStack.items;
const ssaRestoringClassInitializationGuard = ssaLinkClassGuard641;
if ((!nestedEntryGuarded && (helpers.profileMethods || helpers.needsBytecodeChecks() || thread.status !== 'runnable')) || (nestedEntryGuarded !== 2 && ((ssaRestoringClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaRestoringClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaRestoringClassInitializationGuard)))) { return ssaAsyncInvoke; }
const restorationDepth = ssaCallStack.length;
let frame = null;
let locals = null;
let stack = null;
let ssaRestoredFrame = null;
let ssaEntryStaticValue0 = ssaLinkStaticCell6398.value /* f:[I */;
let ssaEntryStaticArrayData0 = (ssaEntryStaticValue0 == null ? null : ssaEntryStaticValue0.elements ? ssaEntryStaticValue0.elements : (Array.isArray(ssaEntryStaticValue0) || ArrayBuffer.isView(ssaEntryStaticValue0) ? ssaEntryStaticValue0 : null));
const ssaFastPathsOk = !helpers.profileMethods && helpers.jvm.debugManager.jitDeoptedClassCount === 0;
const ssaCallSite145 = ssaLinkCallSite9967;
let safePointBudget = 7100;
let local0 = undefined;
let local1 = undefined;
let local2 = undefined;
let local3 = undefined;
let local4 = undefined;
let local5 = undefined;
let local6 = undefined;
let local7 = undefined;
let local8 = undefined;
let local9 = undefined;
if (ssaEntryStaticArrayData0 === null) { return ssaAsyncInvoke; }
local0 = (ssaLinkStaticCell6391.value);
local1 = (ssaLinkStaticCell6392.value);
local2 = (ssaLinkStaticCell6393.value);
safePointBudget = Math.min(safePointBudget, 71);
L1: while (true) {
  if (--safePointBudget <= 0) {
    if (nestedEntryGuarded === 2 || helpers.continueStructuredQuantum(thread)) { safePointBudget = 71; } else {
      ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8, local9]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      stack.length = 0;
      helpers.materialize(frame, locals, stack, 6);
      helpers.structuredSsa.safePointCount += 1;
      return { deopt: true, transient: true, reason: 'structured SSA safe point' };
    }
  }
  if ((local1) < (local0)) {
    const ssaValue47255 = local1;
    const ssaValue47256 = ssaEntryStaticValue0;
    let ssaValue47257;
    const ssaBlockArrayRangeGuard6 = ((((ssaValue47255) + 0) | 0) >= 0 && (((ssaValue47255) + 6) | 0) >= (((ssaValue47255) + 0) | 0) && (((ssaValue47255) + 6) | 0) < ssaEntryStaticArrayData0.length);
    if (!ssaBlockArrayRangeGuard6 && ((ssaValue47257 = ssaEntryStaticArrayData0[ssaValue47255]) === undefined)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 155, [ssaValue47256, ssaValue47255]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      ssaValue47257 = helpers.arrayLoad(ssaValue47255, ssaValue47256, frame, "iaload");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaValue47257 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47255]) | 0) : ((ssaValue47257) | 0);
    }
    ssaLinkStaticCell6418.value = ((ssaValue47257 >> (16 & 31)));
    if (helpers.directStaticTargets[6418].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6418]);
    const ssaValue47261 = ((ssaValue47255 + 4) | 0);
    const ssaValue47262 = ssaEntryStaticValue0;
    let ssaValue47263;
    if (!ssaBlockArrayRangeGuard6 && ((ssaValue47263 = ssaEntryStaticArrayData0[ssaValue47261]) === undefined)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 163, [ssaValue47262, ssaValue47261]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      ssaValue47263 = helpers.arrayLoad(ssaValue47261, ssaValue47262, frame, "iaload");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaValue47263 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47261]) | 0) : ((ssaValue47263) | 0);
    }
    ssaLinkStaticCell6420.value = ((ssaValue47263 >> (16 & 31)));
    if (helpers.directStaticTargets[6420].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6420]);
    const ssaValue47267 = ssaEntryStaticValue0;
    let ssaValue47268;
    if (!ssaBlockArrayRangeGuard6 && ((ssaValue47268 = ssaEntryStaticArrayData0[ssaValue47255]) === undefined)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 170, [ssaValue47267, ssaValue47255, ssaValue47267, ssaValue47255]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      ssaValue47268 = helpers.arrayLoad(ssaValue47255, ssaValue47267, frame, "iaload");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaValue47268 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47255]) | 0) : ((ssaValue47268) | 0);
    }
    const ssaValue47270 = ((ssaValue47255 + 2) | 0);
    const ssaValue47271 = ssaEntryStaticValue0;
    let ssaValue47272;
    if (!ssaBlockArrayRangeGuard6 && ((ssaValue47272 = ssaEntryStaticArrayData0[ssaValue47270]) === undefined)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 175, [ssaValue47267, ssaValue47255, ssaValue47268, ssaValue47271, ssaValue47270]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      ssaValue47272 = helpers.arrayLoad(ssaValue47270, ssaValue47271, frame, "iaload");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaValue47272 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47270]) | 0) : ((ssaValue47272) | 0);
    }
    ssaEntryStaticArrayData0[ssaValue47255] = (((((ssaValue47268 + ssaValue47272) | 0))) | 0);
    const ssaValue47275 = ((ssaValue47255 + 4) | 0);
    const ssaValue47276 = ssaEntryStaticValue0;
    let ssaValue47277;
    if (!ssaBlockArrayRangeGuard6 && ((ssaValue47277 = ssaEntryStaticArrayData0[ssaValue47275]) === undefined)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 183, [ssaValue47276, ssaValue47275, ssaValue47276, ssaValue47275]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      ssaValue47277 = helpers.arrayLoad(ssaValue47275, ssaValue47276, frame, "iaload");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaValue47277 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47275]) | 0) : ((ssaValue47277) | 0);
    }
    const ssaValue47279 = ((ssaValue47255 + 6) | 0);
    const ssaValue47280 = ssaEntryStaticValue0;
    let ssaValue47281;
    if (!ssaBlockArrayRangeGuard6 && ((ssaValue47281 = ssaEntryStaticArrayData0[ssaValue47279]) === undefined)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 188, [ssaValue47276, ssaValue47275, ssaValue47277, ssaValue47280, ssaValue47279]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      ssaValue47281 = helpers.arrayLoad(ssaValue47279, ssaValue47280, frame, "iaload");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaValue47281 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47279]) | 0) : ((ssaValue47281) | 0);
    }
    ssaEntryStaticArrayData0[ssaValue47275] = (((((ssaValue47277 + ssaValue47281) | 0))) | 0);
    local1 = (ssaValue47255 + 8) | 0;
    ssaLinkStaticCell6425.value = local1;
    if (helpers.directStaticTargets[6425].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6425]);
    return 1;
  } else {
    const ssaValue47164 = ((local2) + 1) | 0;
    local2 = ssaValue47164;
    ssaLinkStaticCell6394.value = ssaValue47164;
    if (helpers.directStaticTargets[6394].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6394]);
    if (ssaValue47164 < (ssaLinkStaticCell6395.value)) {
      local3 = (ssaLinkStaticCell6396.value);
      L8: while (true) {
        if (--safePointBudget <= 0) {
          if (nestedEntryGuarded === 2 || helpers.continueStructuredQuantum(thread)) { safePointBudget = 71; } else {
            ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8, local9]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
            stack.length = 0;
            helpers.materialize(frame, locals, stack, 22);
            helpers.structuredSsa.safePointCount += 1;
            return { deopt: true, transient: true, reason: 'structured SSA safe point' };
          }
        }
        if (!((local0) >= (ssaLinkStaticCell6397.value))) {
          const ssaValue47172 = (((local0) + 1) | 0);
          const ssaValue47173 = ssaEntryStaticValue0;
          let ssaValue47174;
          if (!false && ((ssaValue47174 = ssaEntryStaticArrayData0[ssaValue47172]) === undefined)) {
            ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 29, [ssaValue47173, ssaValue47172]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
            ssaValue47174 = helpers.arrayLoad(ssaValue47172, ssaValue47173, frame, "iaload");
            frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
            locals = null;
            stack = null;
          } else {
            ssaValue47174 = false ? ((ssaEntryStaticArrayData0[ssaValue47172]) | 0) : ((ssaValue47174) | 0);
          }
          local4 = ssaValue47174;
          if ((local2) >= ssaValue47174) {
            const ssaValue47177 = local0;
            const ssaValue47178 = ssaEntryStaticValue0;
            let ssaValue47179;
            const ssaBlockArrayRangeGuard0 = ((((ssaValue47177) + 0) | 0) >= 0 && (((ssaValue47177) + 3) | 0) >= (((ssaValue47177) + 0) | 0) && (((ssaValue47177) + 3) | 0) < ssaEntryStaticArrayData0.length);
            if (!ssaBlockArrayRangeGuard0 && ((ssaValue47179 = ssaEntryStaticArrayData0[ssaValue47177]) === undefined)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 38, [ssaValue47178, ssaValue47177]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              ssaValue47179 = helpers.arrayLoad(ssaValue47177, ssaValue47178, frame, "iaload");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaValue47179 = ssaBlockArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[ssaValue47177]) | 0) : ((ssaValue47179) | 0);
            }
            local5 = ssaValue47179;
            const ssaValue47181 = ((ssaValue47177 + 2) | 0);
            const ssaValue47182 = ssaEntryStaticValue0;
            let ssaValue47183;
            if (!ssaBlockArrayRangeGuard0 && ((ssaValue47183 = ssaEntryStaticArrayData0[ssaValue47181]) === undefined)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 44, [ssaValue47182, ssaValue47181]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              ssaValue47183 = helpers.arrayLoad(ssaValue47181, ssaValue47182, frame, "iaload");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaValue47183 = ssaBlockArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[ssaValue47181]) | 0) : ((ssaValue47183) | 0);
            }
            local6 = ssaValue47183;
            const ssaValue47185 = ((ssaValue47177 + 3) | 0);
            const ssaValue47186 = ssaEntryStaticValue0;
            let ssaValue47187;
            if (!ssaBlockArrayRangeGuard0 && ((ssaValue47187 = ssaEntryStaticArrayData0[ssaValue47185]) === undefined)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 50, [ssaValue47186, ssaValue47185]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              ssaValue47187 = helpers.arrayLoad(ssaValue47185, ssaValue47186, frame, "iaload");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaValue47187 = ssaBlockArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[ssaValue47185]) | 0) : ((ssaValue47187) | 0);
            }
            local7 = ssaValue47187;
            const ssaValue47189 = ((((ssaValue47183 - ssaValue47179) | 0)) << (16 & 31));
            const ssaValue47191 = ((ssaValue47187 - (local4)) | 0);
            if (ssaValue47191 === 0) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 60, [ssaValue47189, ssaValue47191]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              throw { type: "java/lang/ArithmeticException", message: "/ by zero" };
            }
            const ssaValue47192 = ((ssaValue47189 / ssaValue47191) | 0);
            local8 = ssaValue47192;
            const ssaValue47194 = ((((ssaValue47179 << (16 & 31))) + 32768) | 0);
            local9 = ssaValue47194;
            ssaEntryStaticArrayData0[ssaValue47177] = ((ssaValue47194) | 0);
            const ssaValue47198 = ((ssaValue47177 + 2) | 0);
            const ssaValue47199 = ssaEntryStaticValue0;
            if (!ssaBlockArrayRangeGuard0 && ((ssaValue47198 >>> 0) >= ssaEntryStaticArrayData0.length)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 77, [ssaValue47199, ssaValue47198, ssaValue47192]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              helpers.arrayStore(ssaValue47192, ssaValue47198, ssaValue47199, frame, "iastore");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaEntryStaticArrayData0[ssaValue47198] = ((ssaValue47192) | 0);
            }
            local0 = ((ssaValue47177 + 4) | 0);
            continue L8;
          }
        }
        local4 = (local3);
        const ssaArrayRangeGuard5 = (((local0 - local4) <= 0 ? 0 : Math.ceil((local0 - local4) / 4)) === 0 || (((local0 - local4) <= 0 ? 0 : Math.ceil((local0 - local4) / 4)) <= 1024 && (local4 + 0) >= 0 && (local4 + (((local0 - local4) <= 0 ? 0 : Math.ceil((local0 - local4) / 4)) - 1) * 4 + 3) >= (local4 + 0) && (local4 + (((local0 - local4) <= 0 ? 0 : Math.ceil((local0 - local4) / 4)) - 1) * 4 + 3) <= 2147483647 && (local4 + ((local0 - local4) <= 0 ? 0 : Math.ceil((local0 - local4) / 4)) * 4) >= local4 && (local4 + ((local0 - local4) <= 0 ? 0 : Math.ceil((local0 - local4) / 4)) * 4) <= 2147483647 && (local4 + (((local0 - local4) <= 0 ? 0 : Math.ceil((local0 - local4) / 4)) - 1) * 4 + 3) < ssaEntryStaticArrayData0.length));
        const ssaRuntimeCoarseTrips14 = (local4 >= local0 ? 0 : Math.ceil((local0 - local4) / 4));
        const ssaRuntimeCoarseLoop14 = ssaRuntimeCoarseTrips14 <= 1024 && local4 <= 2147483647 - ssaRuntimeCoarseTrips14 * 4;
        if (ssaRuntimeCoarseLoop14) safePointBudget -= ssaRuntimeCoarseTrips14;
        if (ssaRuntimeCoarseLoop14 && ssaArrayRangeGuard5) {
          L14: while (local4 < local0) {
            const ssaValue47205 = local4;
            const ssaValue47206 = ((ssaValue47205 + 3) | 0);
            const ssaValue47207 = ssaEntryStaticValue0;
            let ssaValue47208;
            ssaValue47208 = ((ssaEntryStaticArrayData0[ssaValue47206]) | 0);
            local5 = ssaValue47208;
            const ssaValue47209 = local2;
            if (!(ssaValue47209 < ssaValue47208)) {
              const ssaValue47211 = local4;
              const ssaValue47213 = local3;
              const ssaValue47214 = ssaEntryStaticValue0;
              let ssaValue47215;
              const ssaBlockArrayRangeGuard3 = ((((ssaValue47213) + 0) | 0) >= 0 && (((ssaValue47213) + 3) | 0) >= (((ssaValue47213) + 0) | 0) && (((ssaValue47213) + 3) | 0) < ssaEntryStaticArrayData0.length);
              if (!ssaBlockArrayRangeGuard3 && ((ssaValue47215 = ssaEntryStaticArrayData0[ssaValue47213]) === undefined)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, ssaValue47213, ssaValue47211, local5, local6, local7, local8, local9], 98, [ssaEntryStaticValue0, ssaValue47211, ssaValue47214, ssaValue47213]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                ssaValue47215 = helpers.arrayLoad(ssaValue47213, ssaValue47214, frame, "iaload");
              } else {
                ssaValue47215 = ssaBlockArrayRangeGuard3 ? ((ssaEntryStaticArrayData0[ssaValue47213]) | 0) : ((ssaValue47215) | 0);
              }
              const ssaValue47216 = ssaEntryStaticValue0;
              ssaEntryStaticArrayData0[ssaValue47211] = ((ssaValue47215) | 0);
              const ssaValue47218 = ((ssaValue47211 + 1) | 0);
              const ssaValue47220 = ((ssaValue47213 + 1) | 0);
              const ssaValue47221 = ssaEntryStaticValue0;
              let ssaValue47222;
              if (!ssaBlockArrayRangeGuard3 && ((ssaValue47222 = ssaEntryStaticArrayData0[ssaValue47220]) === undefined)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, ssaValue47213, ssaValue47211, local5, local6, local7, local8, local9], 108, [ssaEntryStaticValue0, ssaValue47218, ssaValue47221, ssaValue47220]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                ssaValue47222 = helpers.arrayLoad(ssaValue47220, ssaValue47221, frame, "iaload");
              } else {
                ssaValue47222 = ssaBlockArrayRangeGuard3 ? ((ssaEntryStaticArrayData0[ssaValue47220]) | 0) : ((ssaValue47222) | 0);
              }
              const ssaValue47223 = ssaEntryStaticValue0;
              ssaEntryStaticArrayData0[ssaValue47218] = ((ssaValue47222) | 0);
              const ssaValue47225 = ((ssaValue47211 + 2) | 0);
              const ssaValue47227 = ((ssaValue47213 + 2) | 0);
              const ssaValue47228 = ssaEntryStaticValue0;
              let ssaValue47229;
              if (!ssaBlockArrayRangeGuard3 && ((ssaValue47229 = ssaEntryStaticArrayData0[ssaValue47227]) === undefined)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, ssaValue47213, ssaValue47211, local5, local6, local7, local8, local9], 118, [ssaEntryStaticValue0, ssaValue47225, ssaValue47228, ssaValue47227]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                ssaValue47229 = helpers.arrayLoad(ssaValue47227, ssaValue47228, frame, "iaload");
              } else {
                ssaValue47229 = ssaBlockArrayRangeGuard3 ? ((ssaEntryStaticArrayData0[ssaValue47227]) | 0) : ((ssaValue47229) | 0);
              }
              const ssaValue47230 = ssaEntryStaticValue0;
              ssaEntryStaticArrayData0[ssaValue47225] = ((ssaValue47229) | 0);
              const ssaValue47232 = ((ssaValue47211 + 3) | 0);
              const ssaValue47234 = ((ssaValue47213 + 3) | 0);
              const ssaValue47235 = ssaEntryStaticValue0;
              let ssaValue47236;
              if (!ssaBlockArrayRangeGuard3 && ((ssaValue47236 = ssaEntryStaticArrayData0[ssaValue47234]) === undefined)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, ssaValue47213, ssaValue47211, local5, local6, local7, local8, local9], 128, [ssaEntryStaticValue0, ssaValue47232, ssaValue47235, ssaValue47234]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                ssaValue47236 = helpers.arrayLoad(ssaValue47234, ssaValue47235, frame, "iaload");
              } else {
                ssaValue47236 = ssaBlockArrayRangeGuard3 ? ((ssaEntryStaticArrayData0[ssaValue47234]) | 0) : ((ssaValue47236) | 0);
              }
              const ssaValue47237 = ssaEntryStaticValue0;
              ssaEntryStaticArrayData0[ssaValue47232] = ((ssaValue47236) | 0);
              const ssaValue47238 = (ssaValue47213 + 4) | 0;
              local3 = ssaValue47238;
            }
            const ssaValue47239 = local4;
            const ssaValue47240 = (ssaValue47239 + 4) | 0;
            local4 = ssaValue47240;
          }
          const ssaValue47241 = local3;
          const ssaValue47242 = ssaLinkStaticCell6413.value;
          if (ssaValue47241 !== ssaValue47242) {
            const ssaValue47244 = local3;
            const ssaValue47245 = local0;
            /*__JVM_REGION_CALL_START_145__*/
            let ssaValue47246;
            let ssaValue47248 = ssaCallStack.length;
            let ssaFastPositional145 = ssaFastPathsOk && ssaCallSite145.fastPositional ? ssaCallSite145.fastPositional : null;
            let ssaFastPositionalInvoke145 = ssaFastPositional145 === null ? null : ssaFastPositional145.invoke;
            let ssaFastPositionalRawInvoke145 = ssaFastPositional145 === null ? null : ssaFastPositional145.rawInvoke;
            let ssaFastPositionalReceiver145 = ssaFastPositional145 === null ? null : ssaFastPositional145.receiverType;
            let ssaValue47249 = false;
            if ((ssaFastPositionalRawInvoke145 || ssaFastPositionalInvoke145) && true) {
              ssaValue47249 = true;
              try { ssaValue47246 = ssaFastPositionalRawInvoke145 ? ssaFastPositionalRawInvoke145(helpers, /*__JVM_CALL_ARG_145_0__*/ssaValue47244, /*__JVM_CALL_ARG_145_1__*/ssaValue47245, thread, true) : ssaFastPositionalInvoke145(ssaValue47244, ssaValue47245, thread, true); } catch (ssaValue47247) {
                /*__JVM_CALL_HANDLER_START_145__*/
                if (!ssaFastPositionalInvoke145.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue47248) {
                  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                } else {
                  /*__JVM_CALL_RESTORE_START_145__*/
                  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 145, [ssaValue47244, ssaValue47245]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                  /*__JVM_CALL_RESTORE_END_145__*/
                }
                throw ssaValue47247;
                /*__JVM_CALL_HANDLER_END_145__*/
              }
            }
            if (!ssaValue47249 || ssaValue47246 === ssaAsyncInvoke) {
              if (frame === null) {
                ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8, local9]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              }
              stack[0] = ssaValue47244;
              stack[1] = ssaValue47245;
              stack.length = 2;
              try { ssaValue47246 = helpers.tryInvokeSyncAt(9967, frame, thread); } catch (ssaValue47247) {
                if (true && ssaCallStack.length > ssaValue47248) {
                  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                } else {
                  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 145, [ssaValue47244, ssaValue47245]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                }
                throw ssaValue47247;
              }
            }
            if (ssaValue47246 === ssaAsyncInvoke &&
                ssaCallStack.length > ssaValue47248) {
              if (frame === null) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              }
            }
            if (ssaValue47246 === ssaAsyncInvoke &&
                ssaCallStack.length > ssaValue47248 &&
                helpers.linkStructuredCallChild(frame, thread, ssaValue47248, "void", 9967)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee left active child', jvmPositionalChild: frame };
            }
            if (ssaValue47246 === ssaAsyncInvoke) {
              ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 145, [ssaValue47244, ssaValue47245]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              helpers.skipJitOnce(frame);
              return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };
            }
            if (ssaValue47246 && ssaValue47246.deopt) {
              if (frame === null && (ssaValue47246.jvmPositionalChild || ssaCallStack.length > ssaValue47248)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              }
              if (!helpers.linkStructuredCallChild(frame, thread, ssaValue47248, "void", undefined, ssaValue47246.jvmPositionalChild)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 145, [ssaValue47244, ssaValue47245]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                helpers.skipJitOnce(frame);
                return ssaValue47246;
              }
              ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              if (frame) ssaValue47246.jvmPositionalChild = frame;
              return ssaValue47246;
            }
            if (frame !== null) {
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            }
            if (ssaCallStack.length > ssaValue47248) {
              if (frame === null) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              }
            }
            if (ssaCallStack.length > ssaValue47248 &&
                helpers.linkStructuredCallChild(frame, thread, ssaValue47248, "void")) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                return { deopt: true, transient: true, reason: 'structured SSA callee left active child', jvmPositionalChild: frame };
            }
            if (thread.status !== 'runnable') {
              ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee', jvmPositionalChild: frame };
            }
            /*__JVM_REGION_CALL_END_145__*/
            if (frame !== null) {
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            }
            ssaLinkStaticCell6415.value = ssaValue47244;
            if (helpers.directStaticTargets[6415].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6415]);
            ssaLinkStaticCell6416.value = ssaValue47245;
            if (helpers.directStaticTargets[6416].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6416]);
            local1 = ssaValue47244;
            continue L1;
          } else {
            ssaLinkStaticCell6414.value = 0;
            if (helpers.directStaticTargets[6414].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6414]);
            return 0;
          }
        } else {
          L14: while (local4 < local0) {
            if (!ssaRuntimeCoarseLoop14 && --safePointBudget <= 0) {
              if (nestedEntryGuarded === 2 || helpers.continueStructuredQuantum(thread)) { safePointBudget = 71; } else {
                ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8, local9]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                stack.length = 0;
                helpers.materialize(frame, locals, stack, 82);
                helpers.structuredSsa.safePointCount += 1;
                return { deopt: true, transient: true, reason: 'structured SSA safe point' };
              }
            }
            const ssaValue47205 = local4;
            const ssaValue47206 = ((ssaValue47205 + 3) | 0);
            const ssaValue47207 = ssaEntryStaticValue0;
            let ssaValue47208;
            if (!ssaArrayRangeGuard5 && ((ssaValue47208 = ssaEntryStaticArrayData0[ssaValue47206]) === undefined)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 89, [ssaValue47207, ssaValue47206]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              ssaValue47208 = helpers.arrayLoad(ssaValue47206, ssaValue47207, frame, "iaload");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaValue47208 = ssaArrayRangeGuard5 ? ((ssaEntryStaticArrayData0[ssaValue47206]) | 0) : ((ssaValue47208) | 0);
            }
            local5 = ssaValue47208;
            const ssaValue47209 = local2;
            if (!(ssaValue47209 < ssaValue47208)) {
              const ssaValue47211 = local4;
              const ssaValue47213 = local3;
              const ssaValue47214 = ssaEntryStaticValue0;
              let ssaValue47215;
              const ssaBlockArrayRangeGuard3 = ((((ssaValue47213) + 0) | 0) >= 0 && (((ssaValue47213) + 3) | 0) >= (((ssaValue47213) + 0) | 0) && (((ssaValue47213) + 3) | 0) < ssaEntryStaticArrayData0.length);
              if (!ssaBlockArrayRangeGuard3 && ((ssaValue47215 = ssaEntryStaticArrayData0[ssaValue47213]) === undefined)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, ssaValue47213, ssaValue47211, local5, local6, local7, local8, local9], 98, [ssaEntryStaticValue0, ssaValue47211, ssaValue47214, ssaValue47213]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                ssaValue47215 = helpers.arrayLoad(ssaValue47213, ssaValue47214, frame, "iaload");
              } else {
                ssaValue47215 = ssaBlockArrayRangeGuard3 ? ((ssaEntryStaticArrayData0[ssaValue47213]) | 0) : ((ssaValue47215) | 0);
              }
              const ssaValue47216 = ssaEntryStaticValue0;
              if (!ssaArrayRangeGuard5 && ((ssaValue47211 >>> 0) >= ssaEntryStaticArrayData0.length)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, ssaValue47213, ssaValue47211, local5, local6, local7, local8, local9], 99, [ssaValue47216, ssaValue47211, ssaValue47215]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                helpers.arrayStore(ssaValue47215, ssaValue47211, ssaValue47216, frame, "iastore");
              } else {
                ssaEntryStaticArrayData0[ssaValue47211] = ((ssaValue47215) | 0);
              }
              const ssaValue47218 = ((ssaValue47211 + 1) | 0);
              const ssaValue47220 = ((ssaValue47213 + 1) | 0);
              const ssaValue47221 = ssaEntryStaticValue0;
              let ssaValue47222;
              if (!ssaBlockArrayRangeGuard3 && ((ssaValue47222 = ssaEntryStaticArrayData0[ssaValue47220]) === undefined)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, ssaValue47213, ssaValue47211, local5, local6, local7, local8, local9], 108, [ssaEntryStaticValue0, ssaValue47218, ssaValue47221, ssaValue47220]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                ssaValue47222 = helpers.arrayLoad(ssaValue47220, ssaValue47221, frame, "iaload");
              } else {
                ssaValue47222 = ssaBlockArrayRangeGuard3 ? ((ssaEntryStaticArrayData0[ssaValue47220]) | 0) : ((ssaValue47222) | 0);
              }
              const ssaValue47223 = ssaEntryStaticValue0;
              if (!ssaArrayRangeGuard5 && ((ssaValue47218 >>> 0) >= ssaEntryStaticArrayData0.length)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, ssaValue47213, ssaValue47211, local5, local6, local7, local8, local9], 109, [ssaValue47223, ssaValue47218, ssaValue47222]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                helpers.arrayStore(ssaValue47222, ssaValue47218, ssaValue47223, frame, "iastore");
              } else {
                ssaEntryStaticArrayData0[ssaValue47218] = ((ssaValue47222) | 0);
              }
              const ssaValue47225 = ((ssaValue47211 + 2) | 0);
              const ssaValue47227 = ((ssaValue47213 + 2) | 0);
              const ssaValue47228 = ssaEntryStaticValue0;
              let ssaValue47229;
              if (!ssaBlockArrayRangeGuard3 && ((ssaValue47229 = ssaEntryStaticArrayData0[ssaValue47227]) === undefined)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, ssaValue47213, ssaValue47211, local5, local6, local7, local8, local9], 118, [ssaEntryStaticValue0, ssaValue47225, ssaValue47228, ssaValue47227]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                ssaValue47229 = helpers.arrayLoad(ssaValue47227, ssaValue47228, frame, "iaload");
              } else {
                ssaValue47229 = ssaBlockArrayRangeGuard3 ? ((ssaEntryStaticArrayData0[ssaValue47227]) | 0) : ((ssaValue47229) | 0);
              }
              const ssaValue47230 = ssaEntryStaticValue0;
              if (!ssaArrayRangeGuard5 && ((ssaValue47225 >>> 0) >= ssaEntryStaticArrayData0.length)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, ssaValue47213, ssaValue47211, local5, local6, local7, local8, local9], 119, [ssaValue47230, ssaValue47225, ssaValue47229]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                helpers.arrayStore(ssaValue47229, ssaValue47225, ssaValue47230, frame, "iastore");
              } else {
                ssaEntryStaticArrayData0[ssaValue47225] = ((ssaValue47229) | 0);
              }
              const ssaValue47232 = ((ssaValue47211 + 3) | 0);
              const ssaValue47234 = ((ssaValue47213 + 3) | 0);
              const ssaValue47235 = ssaEntryStaticValue0;
              let ssaValue47236;
              if (!ssaBlockArrayRangeGuard3 && ((ssaValue47236 = ssaEntryStaticArrayData0[ssaValue47234]) === undefined)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, ssaValue47213, ssaValue47211, local5, local6, local7, local8, local9], 128, [ssaEntryStaticValue0, ssaValue47232, ssaValue47235, ssaValue47234]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                ssaValue47236 = helpers.arrayLoad(ssaValue47234, ssaValue47235, frame, "iaload");
              } else {
                ssaValue47236 = ssaBlockArrayRangeGuard3 ? ((ssaEntryStaticArrayData0[ssaValue47234]) | 0) : ((ssaValue47236) | 0);
              }
              const ssaValue47237 = ssaEntryStaticValue0;
              if (!ssaArrayRangeGuard5 && ((ssaValue47232 >>> 0) >= ssaEntryStaticArrayData0.length)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, ssaValue47213, ssaValue47211, local5, local6, local7, local8, local9], 129, [ssaValue47237, ssaValue47232, ssaValue47236]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                helpers.arrayStore(ssaValue47236, ssaValue47232, ssaValue47237, frame, "iastore");
              } else {
                ssaEntryStaticArrayData0[ssaValue47232] = ((ssaValue47236) | 0);
              }
              const ssaValue47238 = (ssaValue47213 + 4) | 0;
              local3 = ssaValue47238;
            }
            const ssaValue47239 = local4;
            const ssaValue47240 = (ssaValue47239 + 4) | 0;
            local4 = ssaValue47240;
          }
          const ssaValue47241 = local3;
          const ssaValue47242 = ssaLinkStaticCell6413.value;
          if (ssaValue47241 !== ssaValue47242) {
            const ssaValue47244 = local3;
            const ssaValue47245 = local0;
            /*__JVM_REGION_CALL_START_145__*/
            let ssaValue47246;
            let ssaValue47248 = ssaCallStack.length;
            let ssaFastPositional145 = ssaFastPathsOk && ssaCallSite145.fastPositional ? ssaCallSite145.fastPositional : null;
            let ssaFastPositionalInvoke145 = ssaFastPositional145 === null ? null : ssaFastPositional145.invoke;
            let ssaFastPositionalRawInvoke145 = ssaFastPositional145 === null ? null : ssaFastPositional145.rawInvoke;
            let ssaFastPositionalReceiver145 = ssaFastPositional145 === null ? null : ssaFastPositional145.receiverType;
            let ssaValue47249 = false;
            if ((ssaFastPositionalRawInvoke145 || ssaFastPositionalInvoke145) && true) {
              ssaValue47249 = true;
              try { ssaValue47246 = ssaFastPositionalRawInvoke145 ? ssaFastPositionalRawInvoke145(helpers, /*__JVM_CALL_ARG_145_0__*/ssaValue47244, /*__JVM_CALL_ARG_145_1__*/ssaValue47245, thread, true) : ssaFastPositionalInvoke145(ssaValue47244, ssaValue47245, thread, true); } catch (ssaValue47247) {
                /*__JVM_CALL_HANDLER_START_145__*/
                if (!ssaFastPositionalInvoke145.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue47248) {
                  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                } else {
                  /*__JVM_CALL_RESTORE_START_145__*/
                  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 145, [ssaValue47244, ssaValue47245]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                  /*__JVM_CALL_RESTORE_END_145__*/
                }
                throw ssaValue47247;
                /*__JVM_CALL_HANDLER_END_145__*/
              }
            }
            if (!ssaValue47249 || ssaValue47246 === ssaAsyncInvoke) {
              if (frame === null) {
                ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(281, plan, thread, restorationDepth, frame, [local0, local1, local2, local3, local4, local5, local6, local7, local8, local9]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              }
              stack[0] = ssaValue47244;
              stack[1] = ssaValue47245;
              stack.length = 2;
              try { ssaValue47246 = helpers.tryInvokeSyncAt(9967, frame, thread); } catch (ssaValue47247) {
                if (true && ssaCallStack.length > ssaValue47248) {
                  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                } else {
                  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 145, [ssaValue47244, ssaValue47245]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                }
                throw ssaValue47247;
              }
            }
            if (ssaValue47246 === ssaAsyncInvoke &&
                ssaCallStack.length > ssaValue47248) {
              if (frame === null) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              }
            }
            if (ssaValue47246 === ssaAsyncInvoke &&
                ssaCallStack.length > ssaValue47248 &&
                helpers.linkStructuredCallChild(frame, thread, ssaValue47248, "void", 9967)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee left active child', jvmPositionalChild: frame };
            }
            if (ssaValue47246 === ssaAsyncInvoke) {
              ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 145, [ssaValue47244, ssaValue47245]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              helpers.skipJitOnce(frame);
              return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };
            }
            if (ssaValue47246 && ssaValue47246.deopt) {
              if (frame === null && (ssaValue47246.jvmPositionalChild || ssaCallStack.length > ssaValue47248)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              }
              if (!helpers.linkStructuredCallChild(frame, thread, ssaValue47248, "void", undefined, ssaValue47246.jvmPositionalChild)) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 145, [ssaValue47244, ssaValue47245]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                helpers.skipJitOnce(frame);
                return ssaValue47246;
              }
              ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              if (frame) ssaValue47246.jvmPositionalChild = frame;
              return ssaValue47246;
            }
            if (frame !== null) {
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            }
            if (ssaCallStack.length > ssaValue47248) {
              if (frame === null) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              }
            }
            if (ssaCallStack.length > ssaValue47248 &&
                helpers.linkStructuredCallChild(frame, thread, ssaValue47248, "void")) {
                ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
                return { deopt: true, transient: true, reason: 'structured SSA callee left active child', jvmPositionalChild: frame };
            }
            if (thread.status !== 'runnable') {
              ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(281, plan, thread, restorationDepth, frame, [ssaValue47245, local1, local2, ssaValue47244, local4, local5, local6, local7, local8, local9], 146, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee', jvmPositionalChild: frame };
            }
            /*__JVM_REGION_CALL_END_145__*/
            if (frame !== null) {
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            }
            ssaLinkStaticCell6415.value = ssaValue47244;
            if (helpers.directStaticTargets[6415].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6415]);
            ssaLinkStaticCell6416.value = ssaValue47245;
            if (helpers.directStaticTargets[6416].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6416]);
            local1 = ssaValue47244;
            continue L1;
          } else {
            ssaLinkStaticCell6414.value = 0;
            if (helpers.directStaticTargets[6414].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6414]);
            return 0;
          }
        }
      }
    } else {
      return 0;
    }
  }
}
//# sourceURL=jvm-generated://ok/b()Z?tier=ssa-direct-restoring-positional
