'use strict';
const ssaCallStack = thread.callStack.items;
const ssaRestoringClassInitializationGuard = ssaLinkClassGuard639;
if ((!nestedEntryGuarded && (helpers.profileMethods || helpers.needsBytecodeChecks() || thread.status !== 'runnable')) || (nestedEntryGuarded !== 2 && ((ssaRestoringClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaRestoringClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaRestoringClassInitializationGuard)))) { return ssaAsyncInvoke; }
const restorationDepth = ssaCallStack.length;
let frame = null;
let locals = null;
let stack = null;
let ssaRestoredFrame = null;
let ssaEntryStaticValue0 = ssaLinkStaticCell6367.value /* f:[I */;
let ssaEntryStaticArrayData0 = (ssaEntryStaticValue0 == null ? null : ssaEntryStaticValue0.elements ? ssaEntryStaticValue0.elements : (Array.isArray(ssaEntryStaticValue0) || ArrayBuffer.isView(ssaEntryStaticValue0) ? ssaEntryStaticValue0 : null));
let safePointBudget = 7500;
let local0 = ((Number(argument0)) | 0);
let local1 = ((Number(argument1)) | 0);
let local2 = undefined;
let local3 = undefined;
let local4 = undefined;
let local5 = undefined;
let local6 = undefined;
let local7 = undefined;
let local8 = undefined;
if (ssaEntryStaticArrayData0 === null) { return ssaAsyncInvoke; }
if (local1 > (((local0 + 4) | 0))) {
  local2 = local0;
  const ssaValue47054 = ssaEntryStaticValue0;
  let ssaValue47055;
  const ssaBlockArrayRangeGuard0 = ((((local0) + 0) | 0) >= 0 && (((local0) + 3) | 0) >= (((local0) + 0) | 0) && (((local0) + 3) | 0) < ssaEntryStaticArrayData0.length);
  if (!ssaBlockArrayRangeGuard0 && ((ssaValue47055 = ssaEntryStaticArrayData0[local0]) === undefined)) {
    ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 11, [ssaValue47054, local0]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    ssaValue47055 = helpers.arrayLoad(local0, ssaValue47054, frame, "iaload");
    frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
    locals = null;
    stack = null;
  } else {
    ssaValue47055 = ssaBlockArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[local0]) | 0) : ((ssaValue47055) | 0);
  }
  local3 = ssaValue47055;
  const ssaValue47057 = ((local0 + 1) | 0);
  const ssaValue47058 = ssaEntryStaticValue0;
  let ssaValue47059;
  if (!ssaBlockArrayRangeGuard0 && ((ssaValue47059 = ssaEntryStaticArrayData0[ssaValue47057]) === undefined)) {
    ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 17, [ssaValue47058, ssaValue47057]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    ssaValue47059 = helpers.arrayLoad(ssaValue47057, ssaValue47058, frame, "iaload");
    frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
    locals = null;
    stack = null;
  } else {
    ssaValue47059 = ssaBlockArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[ssaValue47057]) | 0) : ((ssaValue47059) | 0);
  }
  local4 = ssaValue47059;
  const ssaValue47061 = ((local0 + 2) | 0);
  const ssaValue47062 = ssaEntryStaticValue0;
  let ssaValue47063;
  if (!ssaBlockArrayRangeGuard0 && ((ssaValue47063 = ssaEntryStaticArrayData0[ssaValue47061]) === undefined)) {
    ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 23, [ssaValue47062, ssaValue47061]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    ssaValue47063 = helpers.arrayLoad(ssaValue47061, ssaValue47062, frame, "iaload");
    frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
    locals = null;
    stack = null;
  } else {
    ssaValue47063 = ssaBlockArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[ssaValue47061]) | 0) : ((ssaValue47063) | 0);
  }
  local5 = ssaValue47063;
  const ssaValue47065 = ((local0 + 3) | 0);
  const ssaValue47066 = ssaEntryStaticValue0;
  let ssaValue47067;
  if (!ssaBlockArrayRangeGuard0 && ((ssaValue47067 = ssaEntryStaticArrayData0[ssaValue47065]) === undefined)) {
    ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 29, [ssaValue47066, ssaValue47065]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    ssaValue47067 = helpers.arrayLoad(ssaValue47065, ssaValue47066, frame, "iaload");
    frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
    locals = null;
    stack = null;
  } else {
    ssaValue47067 = ssaBlockArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[ssaValue47065]) | 0) : ((ssaValue47067) | 0);
  }
  local6 = ssaValue47067;
  local7 = (((local0 + 4) | 0));
  safePointBudget = Math.min(safePointBudget, 75);
  const ssaArrayRangeGuard4 = (((local1 - (local0 + 4 | 0)) <= 0 ? 0 : Math.ceil((local1 - (local0 + 4 | 0)) / 4)) === 0 || (((local1 - (local0 + 4 | 0)) <= 0 ? 0 : Math.ceil((local1 - (local0 + 4 | 0)) / 4)) <= 1024 && ((local0 + 4 | 0) + 0) >= 0 && ((local0 + 4 | 0) + (((local1 - (local0 + 4 | 0)) <= 0 ? 0 : Math.ceil((local1 - (local0 + 4 | 0)) / 4)) - 1) * 4 + 3) >= ((local0 + 4 | 0) + 0) && ((local0 + 4 | 0) + (((local1 - (local0 + 4 | 0)) <= 0 ? 0 : Math.ceil((local1 - (local0 + 4 | 0)) / 4)) - 1) * 4 + 3) <= 2147483647 && ((local0 + 4 | 0) + ((local1 - (local0 + 4 | 0)) <= 0 ? 0 : Math.ceil((local1 - (local0 + 4 | 0)) / 4)) * 4) >= (local0 + 4 | 0) && ((local0 + 4 | 0) + ((local1 - (local0 + 4 | 0)) <= 0 ? 0 : Math.ceil((local1 - (local0 + 4 | 0)) / 4)) * 4) <= 2147483647 && ((local0 + 4 | 0) + (((local1 - (local0 + 4 | 0)) <= 0 ? 0 : Math.ceil((local1 - (local0 + 4 | 0)) / 4)) - 1) * 4 + 3) < ssaEntryStaticArrayData0.length));
  const ssaRuntimeCoarseTrips4 = (local7 >= local1 ? 0 : Math.ceil((local1 - local7) / 4));
  const ssaRuntimeCoarseLoop4 = ssaRuntimeCoarseTrips4 <= 1024 && local7 <= 2147483647 - ssaRuntimeCoarseTrips4 * 4;
  if (ssaRuntimeCoarseLoop4) safePointBudget -= ssaRuntimeCoarseTrips4;
  if (ssaRuntimeCoarseLoop4 && ssaArrayRangeGuard4) {
    L4: while (local7 < local1) {
      const ssaValue47072 = local7;
      const ssaValue47073 = ((ssaValue47072 + 1) | 0);
      const ssaValue47074 = ssaEntryStaticValue0;
      let ssaValue47075;
      ssaValue47075 = ((ssaEntryStaticArrayData0[ssaValue47073]) | 0);
      local8 = ssaValue47075;
      const ssaValue47076 = local4;
      if (!(ssaValue47075 >= ssaValue47076)) {
        const ssaValue47078 = local2;
        const ssaValue47080 = local7;
        const ssaValue47081 = ssaEntryStaticValue0;
        let ssaValue47082;
        ssaValue47082 = ((ssaEntryStaticArrayData0[ssaValue47080]) | 0);
        const ssaValue47083 = ssaEntryStaticValue0;
        const ssaBlockArrayRangeGuard3 = ((((ssaValue47078) + 0) | 0) >= 0 && (((ssaValue47078) + 3) | 0) >= (((ssaValue47078) + 0) | 0) && (((ssaValue47078) + 3) | 0) < ssaEntryStaticArrayData0.length);
        if (!ssaBlockArrayRangeGuard3 && ((ssaValue47078 >>> 0) >= ssaEntryStaticArrayData0.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47078, local3, local4, local5, local6, ssaValue47080, local8], 52, [ssaValue47083, ssaValue47078, ssaValue47082]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue47082, ssaValue47078, ssaValue47083, frame, "iastore");
        } else {
          ssaEntryStaticArrayData0[ssaValue47078] = ((ssaValue47082) | 0);
        }
        const ssaValue47085 = ((ssaValue47078 + 1) | 0);
        const ssaValue47086 = local8;
        const ssaValue47087 = ssaEntryStaticValue0;
        if (!ssaBlockArrayRangeGuard3 && ((ssaValue47085 >>> 0) >= ssaEntryStaticArrayData0.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47078, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 58, [ssaValue47087, ssaValue47085, ssaValue47086]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue47086, ssaValue47085, ssaValue47087, frame, "iastore");
        } else {
          ssaEntryStaticArrayData0[ssaValue47085] = ((ssaValue47086) | 0);
        }
        const ssaValue47089 = ((ssaValue47078 + 2) | 0);
        const ssaValue47091 = ((ssaValue47080 + 2) | 0);
        const ssaValue47092 = ssaEntryStaticValue0;
        let ssaValue47093;
        ssaValue47093 = ((ssaEntryStaticArrayData0[ssaValue47091]) | 0);
        const ssaValue47094 = ssaEntryStaticValue0;
        if (!ssaBlockArrayRangeGuard3 && ((ssaValue47089 >>> 0) >= ssaEntryStaticArrayData0.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47078, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 68, [ssaValue47094, ssaValue47089, ssaValue47093]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue47093, ssaValue47089, ssaValue47094, frame, "iastore");
        } else {
          ssaEntryStaticArrayData0[ssaValue47089] = ((ssaValue47093) | 0);
        }
        const ssaValue47096 = ((ssaValue47078 + 3) | 0);
        const ssaValue47098 = ((ssaValue47080 + 3) | 0);
        const ssaValue47099 = ssaEntryStaticValue0;
        let ssaValue47100;
        ssaValue47100 = ((ssaEntryStaticArrayData0[ssaValue47098]) | 0);
        const ssaValue47101 = ssaEntryStaticValue0;
        if (!ssaBlockArrayRangeGuard3 && ((ssaValue47096 >>> 0) >= ssaEntryStaticArrayData0.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47078, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 78, [ssaValue47101, ssaValue47096, ssaValue47100]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue47100, ssaValue47096, ssaValue47101, frame, "iastore");
        } else {
          ssaEntryStaticArrayData0[ssaValue47096] = ((ssaValue47100) | 0);
        }
        const ssaValue47102 = (ssaValue47078 + 4) | 0;
        local2 = ssaValue47102;
        const ssaValue47105 = ssaEntryStaticValue0;
        let ssaValue47106;
        const ssaBlockArrayRangeGuard6 = ((((ssaValue47102) + 0) | 0) >= 0 && (((ssaValue47102) + 3) | 0) >= (((ssaValue47102) + 0) | 0) && (((ssaValue47102) + 3) | 0) < ssaEntryStaticArrayData0.length);
        if (!ssaBlockArrayRangeGuard6 && ((ssaValue47106 = ssaEntryStaticArrayData0[ssaValue47102]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47102, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 84, [ssaEntryStaticValue0, ssaValue47080, ssaValue47105, ssaValue47102]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47106 = helpers.arrayLoad(ssaValue47102, ssaValue47105, frame, "iaload");
        } else {
          ssaValue47106 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47102]) | 0) : ((ssaValue47106) | 0);
        }
        const ssaValue47107 = ssaEntryStaticValue0;
        ssaEntryStaticArrayData0[ssaValue47080] = ((ssaValue47106) | 0);
        const ssaValue47109 = ((ssaValue47080 + 1) | 0);
        const ssaValue47111 = ((ssaValue47102 + 1) | 0);
        const ssaValue47112 = ssaEntryStaticValue0;
        let ssaValue47113;
        if (!ssaBlockArrayRangeGuard6 && ((ssaValue47113 = ssaEntryStaticArrayData0[ssaValue47111]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47102, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 94, [ssaEntryStaticValue0, ssaValue47109, ssaValue47112, ssaValue47111]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47113 = helpers.arrayLoad(ssaValue47111, ssaValue47112, frame, "iaload");
        } else {
          ssaValue47113 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47111]) | 0) : ((ssaValue47113) | 0);
        }
        const ssaValue47114 = ssaEntryStaticValue0;
        ssaEntryStaticArrayData0[ssaValue47109] = ((ssaValue47113) | 0);
        const ssaValue47116 = ((ssaValue47080 + 2) | 0);
        const ssaValue47118 = ((ssaValue47102 + 2) | 0);
        const ssaValue47119 = ssaEntryStaticValue0;
        let ssaValue47120;
        if (!ssaBlockArrayRangeGuard6 && ((ssaValue47120 = ssaEntryStaticArrayData0[ssaValue47118]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47102, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 104, [ssaEntryStaticValue0, ssaValue47116, ssaValue47119, ssaValue47118]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47120 = helpers.arrayLoad(ssaValue47118, ssaValue47119, frame, "iaload");
        } else {
          ssaValue47120 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47118]) | 0) : ((ssaValue47120) | 0);
        }
        const ssaValue47121 = ssaEntryStaticValue0;
        ssaEntryStaticArrayData0[ssaValue47116] = ((ssaValue47120) | 0);
        const ssaValue47123 = ((ssaValue47080 + 3) | 0);
        const ssaValue47125 = ((ssaValue47102 + 3) | 0);
        const ssaValue47126 = ssaEntryStaticValue0;
        let ssaValue47127;
        if (!ssaBlockArrayRangeGuard6 && ((ssaValue47127 = ssaEntryStaticArrayData0[ssaValue47125]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47102, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 114, [ssaEntryStaticValue0, ssaValue47123, ssaValue47126, ssaValue47125]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47127 = helpers.arrayLoad(ssaValue47125, ssaValue47126, frame, "iaload");
        } else {
          ssaValue47127 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47125]) | 0) : ((ssaValue47127) | 0);
        }
        const ssaValue47128 = ssaEntryStaticValue0;
        ssaEntryStaticArrayData0[ssaValue47123] = ((ssaValue47127) | 0);
      }
      const ssaValue47129 = local7;
      const ssaValue47130 = (ssaValue47129 + 4) | 0;
      local7 = ssaValue47130;
    }
    const ssaValue47132 = local2;
    const ssaValue47133 = local3;
    const ssaValue47134 = ssaEntryStaticValue0;
    const ssaBlockArrayRangeGuard9 = ((((ssaValue47132) + 0) | 0) >= 0 && (((ssaValue47132) + 3) | 0) >= (((ssaValue47132) + 0) | 0) && (((ssaValue47132) + 3) | 0) < ssaEntryStaticArrayData0.length);
    if (!ssaBlockArrayRangeGuard9 && ((ssaValue47132 >>> 0) >= ssaEntryStaticArrayData0.length)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 123, [ssaValue47134, ssaValue47132, ssaValue47133]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.arrayStore(ssaValue47133, ssaValue47132, ssaValue47134, frame, "iastore");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaEntryStaticArrayData0[ssaValue47132] = ((ssaValue47133) | 0);
    }
    const ssaValue47136 = ((ssaValue47132 + 1) | 0);
    const ssaValue47137 = local4;
    const ssaValue47138 = ssaEntryStaticValue0;
    if (!ssaBlockArrayRangeGuard9 && ((ssaValue47136 >>> 0) >= ssaEntryStaticArrayData0.length)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 129, [ssaValue47138, ssaValue47136, ssaValue47137]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.arrayStore(ssaValue47137, ssaValue47136, ssaValue47138, frame, "iastore");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaEntryStaticArrayData0[ssaValue47136] = ((ssaValue47137) | 0);
    }
    const ssaValue47140 = ((ssaValue47132 + 2) | 0);
    const ssaValue47141 = local5;
    const ssaValue47142 = ssaEntryStaticValue0;
    if (!ssaBlockArrayRangeGuard9 && ((ssaValue47140 >>> 0) >= ssaEntryStaticArrayData0.length)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 135, [ssaValue47142, ssaValue47140, ssaValue47141]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.arrayStore(ssaValue47141, ssaValue47140, ssaValue47142, frame, "iastore");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaEntryStaticArrayData0[ssaValue47140] = ((ssaValue47141) | 0);
    }
    const ssaValue47144 = ((ssaValue47132 + 3) | 0);
    const ssaValue47145 = local6;
    const ssaValue47146 = ssaEntryStaticValue0;
    if (!ssaBlockArrayRangeGuard9 && ((ssaValue47144 >>> 0) >= ssaEntryStaticArrayData0.length)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 141, [ssaValue47146, ssaValue47144, ssaValue47145]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.arrayStore(ssaValue47145, ssaValue47144, ssaValue47146, frame, "iastore");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaEntryStaticArrayData0[ssaValue47144] = ((ssaValue47145) | 0);
    }
    const ssaValue47147 = local0;
        /*__JVM_REGION_CALL_START_144__*/
    let ssaValue47148;
    let ssaValue47150 = ssaCallStack.length;
    let ssaValue47151 = false;
    if (true) {
      ssaValue47151 = true;
      try { ssaValue47148 = jvm$ssa_direct_restoring_positional$ok$a_II_V(helpers, plan, ssaValue47147, ssaValue47132, thread, 2); } catch (ssaValue47149) {
        /*__JVM_CALL_HANDLER_START_144__*/
        if (false && ssaCallStack.length > ssaValue47150) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        } else {
          /*__JVM_CALL_RESTORE_START_144__*/
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 144, [ssaValue47147, ssaValue47132]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          /*__JVM_CALL_RESTORE_END_144__*/
        }
        throw ssaValue47149;
        /*__JVM_CALL_HANDLER_END_144__*/
      }
    }
    if (!ssaValue47151 || ssaValue47148 === ssaAsyncInvoke) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), local2, local3, local4, local5, local6, local7, local8]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
      stack[0] = ssaValue47147;
      stack[1] = ssaValue47132;
      stack.length = 2;
      try { ssaValue47148 = helpers.tryInvokeSyncAt(9963, frame, thread); } catch (ssaValue47149) {
        if (true && ssaCallStack.length > ssaValue47150) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        } else {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 144, [ssaValue47147, ssaValue47132]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        }
        throw ssaValue47149;
      }
    }
    if (ssaValue47148 === ssaAsyncInvoke &&
        ssaCallStack.length > ssaValue47150) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
    }
    if (ssaValue47148 === ssaAsyncInvoke &&
        ssaCallStack.length > ssaValue47150 &&
        helpers.linkStructuredCallChild(frame, thread, ssaValue47150, "void", 9963)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee left active child', jvmPositionalChild: frame };
    }
    if (ssaValue47148 === ssaAsyncInvoke) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 144, [ssaValue47147, ssaValue47132]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.skipJitOnce(frame);
      return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };
    }
    if (ssaValue47148 && ssaValue47148.deopt) {
      if (frame === null && (ssaValue47148.jvmPositionalChild || ssaCallStack.length > ssaValue47150)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
      if (!helpers.linkStructuredCallChild(frame, thread, ssaValue47150, "void", undefined, ssaValue47148.jvmPositionalChild)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 144, [ssaValue47147, ssaValue47132]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.skipJitOnce(frame);
        return ssaValue47148;
      }
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      if (frame) ssaValue47148.jvmPositionalChild = frame;
      return ssaValue47148;
    }
    if (frame !== null) {
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    }
    if (ssaCallStack.length > ssaValue47150) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
    }
    if (ssaCallStack.length > ssaValue47150 &&
        helpers.linkStructuredCallChild(frame, thread, ssaValue47150, "void")) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        return { deopt: true, transient: true, reason: 'structured SSA callee left active child', jvmPositionalChild: frame };
    }
    if (thread.status !== 'runnable') {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee', jvmPositionalChild: frame };
    }
    /*__JVM_REGION_CALL_END_144__*/
    if (frame !== null) {
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    }
        const ssaValue47152 = ((ssaValue47132 + 4) | 0);
    const ssaValue47153 = local1;
        /*__JVM_REGION_CALL_START_149__*/
    let ssaValue47154;
    let ssaValue47156 = ssaCallStack.length;
    let ssaValue47157 = false;
    if (true) {
      ssaValue47157 = true;
      try { ssaValue47154 = jvm$ssa_direct_restoring_positional$ok$a_II_V(helpers, plan, ssaValue47152, ssaValue47153, thread, 2); } catch (ssaValue47155) {
        /*__JVM_CALL_HANDLER_START_149__*/
        if (false && ssaCallStack.length > ssaValue47156) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        } else {
          /*__JVM_CALL_RESTORE_START_149__*/
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 149, [ssaValue47152, ssaValue47153]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          /*__JVM_CALL_RESTORE_END_149__*/
        }
        throw ssaValue47155;
        /*__JVM_CALL_HANDLER_END_149__*/
      }
    }
    if (!ssaValue47157 || ssaValue47154 === ssaAsyncInvoke) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), local2, local3, local4, local5, local6, local7, local8]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
      stack[0] = ssaValue47152;
      stack[1] = ssaValue47153;
      stack.length = 2;
      try { ssaValue47154 = helpers.tryInvokeSyncAt(9964, frame, thread); } catch (ssaValue47155) {
        if (true && ssaCallStack.length > ssaValue47156) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        } else {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 149, [ssaValue47152, ssaValue47153]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        }
        throw ssaValue47155;
      }
    }
    if (ssaValue47154 === ssaAsyncInvoke &&
        ssaCallStack.length > ssaValue47156) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
    }
    if (ssaValue47154 === ssaAsyncInvoke &&
        ssaCallStack.length > ssaValue47156 &&
        helpers.linkStructuredCallChild(frame, thread, ssaValue47156, "void", 9964)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee left active child', jvmPositionalChild: frame };
    }
    if (ssaValue47154 === ssaAsyncInvoke) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 149, [ssaValue47152, ssaValue47153]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.skipJitOnce(frame);
      return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };
    }
    if (ssaValue47154 && ssaValue47154.deopt) {
      if (frame === null && (ssaValue47154.jvmPositionalChild || ssaCallStack.length > ssaValue47156)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
      if (!helpers.linkStructuredCallChild(frame, thread, ssaValue47156, "void", undefined, ssaValue47154.jvmPositionalChild)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 149, [ssaValue47152, ssaValue47153]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.skipJitOnce(frame);
        return ssaValue47154;
      }
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      if (frame) ssaValue47154.jvmPositionalChild = frame;
      return ssaValue47154;
    }
    if (frame !== null) {
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    }
    if (ssaCallStack.length > ssaValue47156) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
    }
    if (ssaCallStack.length > ssaValue47156 &&
        helpers.linkStructuredCallChild(frame, thread, ssaValue47156, "void")) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        return { deopt: true, transient: true, reason: 'structured SSA callee left active child', jvmPositionalChild: frame };
    }
    if (thread.status !== 'runnable') {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee', jvmPositionalChild: frame };
    }
    /*__JVM_REGION_CALL_END_149__*/
    if (frame !== null) {
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    }
        return ssaReturnVoid;
  } else {
    L4: while (local7 < local1) {
      if (!ssaRuntimeCoarseLoop4 && --safePointBudget <= 0) {
        if (nestedEntryGuarded === 2 || helpers.continueStructuredQuantum(thread)) { safePointBudget = 75; } else {
          ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), local2, local3, local4, local5, local6, local7, local8]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          stack.length = 0;
          helpers.materialize(frame, locals, stack, 35);
          helpers.structuredSsa.safePointCount += 1;
          return { deopt: true, transient: true, reason: 'structured SSA safe point' };
        }
      }
      const ssaValue47072 = local7;
      const ssaValue47073 = ((ssaValue47072 + 1) | 0);
      const ssaValue47074 = ssaEntryStaticValue0;
      let ssaValue47075;
      if (!ssaArrayRangeGuard4 && ((ssaValue47075 = ssaEntryStaticArrayData0[ssaValue47073]) === undefined)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 42, [ssaValue47074, ssaValue47073]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        ssaValue47075 = helpers.arrayLoad(ssaValue47073, ssaValue47074, frame, "iaload");
        frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
        locals = null;
        stack = null;
      } else {
        ssaValue47075 = ssaArrayRangeGuard4 ? ((ssaEntryStaticArrayData0[ssaValue47073]) | 0) : ((ssaValue47075) | 0);
      }
      local8 = ssaValue47075;
      const ssaValue47076 = local4;
      if (!(ssaValue47075 >= ssaValue47076)) {
        const ssaValue47078 = local2;
        const ssaValue47080 = local7;
        const ssaValue47081 = ssaEntryStaticValue0;
        let ssaValue47082;
        if (!ssaArrayRangeGuard4 && ((ssaValue47082 = ssaEntryStaticArrayData0[ssaValue47080]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47078, local3, local4, local5, local6, ssaValue47080, local8], 51, [ssaEntryStaticValue0, ssaValue47078, ssaValue47081, ssaValue47080]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47082 = helpers.arrayLoad(ssaValue47080, ssaValue47081, frame, "iaload");
        } else {
          ssaValue47082 = ssaArrayRangeGuard4 ? ((ssaEntryStaticArrayData0[ssaValue47080]) | 0) : ((ssaValue47082) | 0);
        }
        const ssaValue47083 = ssaEntryStaticValue0;
        const ssaBlockArrayRangeGuard3 = ((((ssaValue47078) + 0) | 0) >= 0 && (((ssaValue47078) + 3) | 0) >= (((ssaValue47078) + 0) | 0) && (((ssaValue47078) + 3) | 0) < ssaEntryStaticArrayData0.length);
        if (!ssaBlockArrayRangeGuard3 && ((ssaValue47078 >>> 0) >= ssaEntryStaticArrayData0.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47078, local3, local4, local5, local6, ssaValue47080, local8], 52, [ssaValue47083, ssaValue47078, ssaValue47082]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue47082, ssaValue47078, ssaValue47083, frame, "iastore");
        } else {
          ssaEntryStaticArrayData0[ssaValue47078] = ((ssaValue47082) | 0);
        }
        const ssaValue47085 = ((ssaValue47078 + 1) | 0);
        const ssaValue47086 = local8;
        const ssaValue47087 = ssaEntryStaticValue0;
        if (!ssaBlockArrayRangeGuard3 && ((ssaValue47085 >>> 0) >= ssaEntryStaticArrayData0.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47078, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 58, [ssaValue47087, ssaValue47085, ssaValue47086]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue47086, ssaValue47085, ssaValue47087, frame, "iastore");
        } else {
          ssaEntryStaticArrayData0[ssaValue47085] = ((ssaValue47086) | 0);
        }
        const ssaValue47089 = ((ssaValue47078 + 2) | 0);
        const ssaValue47091 = ((ssaValue47080 + 2) | 0);
        const ssaValue47092 = ssaEntryStaticValue0;
        let ssaValue47093;
        if (!ssaArrayRangeGuard4 && ((ssaValue47093 = ssaEntryStaticArrayData0[ssaValue47091]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47078, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 67, [ssaEntryStaticValue0, ssaValue47089, ssaValue47092, ssaValue47091]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47093 = helpers.arrayLoad(ssaValue47091, ssaValue47092, frame, "iaload");
        } else {
          ssaValue47093 = ssaArrayRangeGuard4 ? ((ssaEntryStaticArrayData0[ssaValue47091]) | 0) : ((ssaValue47093) | 0);
        }
        const ssaValue47094 = ssaEntryStaticValue0;
        if (!ssaBlockArrayRangeGuard3 && ((ssaValue47089 >>> 0) >= ssaEntryStaticArrayData0.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47078, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 68, [ssaValue47094, ssaValue47089, ssaValue47093]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue47093, ssaValue47089, ssaValue47094, frame, "iastore");
        } else {
          ssaEntryStaticArrayData0[ssaValue47089] = ((ssaValue47093) | 0);
        }
        const ssaValue47096 = ((ssaValue47078 + 3) | 0);
        const ssaValue47098 = ((ssaValue47080 + 3) | 0);
        const ssaValue47099 = ssaEntryStaticValue0;
        let ssaValue47100;
        if (!ssaArrayRangeGuard4 && ((ssaValue47100 = ssaEntryStaticArrayData0[ssaValue47098]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47078, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 77, [ssaEntryStaticValue0, ssaValue47096, ssaValue47099, ssaValue47098]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47100 = helpers.arrayLoad(ssaValue47098, ssaValue47099, frame, "iaload");
        } else {
          ssaValue47100 = ssaArrayRangeGuard4 ? ((ssaEntryStaticArrayData0[ssaValue47098]) | 0) : ((ssaValue47100) | 0);
        }
        const ssaValue47101 = ssaEntryStaticValue0;
        if (!ssaBlockArrayRangeGuard3 && ((ssaValue47096 >>> 0) >= ssaEntryStaticArrayData0.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47078, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 78, [ssaValue47101, ssaValue47096, ssaValue47100]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue47100, ssaValue47096, ssaValue47101, frame, "iastore");
        } else {
          ssaEntryStaticArrayData0[ssaValue47096] = ((ssaValue47100) | 0);
        }
        const ssaValue47102 = (ssaValue47078 + 4) | 0;
        local2 = ssaValue47102;
        const ssaValue47105 = ssaEntryStaticValue0;
        let ssaValue47106;
        const ssaBlockArrayRangeGuard6 = ((((ssaValue47102) + 0) | 0) >= 0 && (((ssaValue47102) + 3) | 0) >= (((ssaValue47102) + 0) | 0) && (((ssaValue47102) + 3) | 0) < ssaEntryStaticArrayData0.length);
        if (!ssaBlockArrayRangeGuard6 && ((ssaValue47106 = ssaEntryStaticArrayData0[ssaValue47102]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47102, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 84, [ssaEntryStaticValue0, ssaValue47080, ssaValue47105, ssaValue47102]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47106 = helpers.arrayLoad(ssaValue47102, ssaValue47105, frame, "iaload");
        } else {
          ssaValue47106 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47102]) | 0) : ((ssaValue47106) | 0);
        }
        const ssaValue47107 = ssaEntryStaticValue0;
        ssaEntryStaticArrayData0[ssaValue47080] = ((ssaValue47106) | 0);
        const ssaValue47109 = ((ssaValue47080 + 1) | 0);
        const ssaValue47111 = ((ssaValue47102 + 1) | 0);
        const ssaValue47112 = ssaEntryStaticValue0;
        let ssaValue47113;
        if (!ssaBlockArrayRangeGuard6 && ((ssaValue47113 = ssaEntryStaticArrayData0[ssaValue47111]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47102, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 94, [ssaEntryStaticValue0, ssaValue47109, ssaValue47112, ssaValue47111]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47113 = helpers.arrayLoad(ssaValue47111, ssaValue47112, frame, "iaload");
        } else {
          ssaValue47113 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47111]) | 0) : ((ssaValue47113) | 0);
        }
        const ssaValue47114 = ssaEntryStaticValue0;
        if (!ssaArrayRangeGuard4 && ((ssaValue47109 >>> 0) >= ssaEntryStaticArrayData0.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47102, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 95, [ssaValue47114, ssaValue47109, ssaValue47113]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue47113, ssaValue47109, ssaValue47114, frame, "iastore");
        } else {
          ssaEntryStaticArrayData0[ssaValue47109] = ((ssaValue47113) | 0);
        }
        const ssaValue47116 = ((ssaValue47080 + 2) | 0);
        const ssaValue47118 = ((ssaValue47102 + 2) | 0);
        const ssaValue47119 = ssaEntryStaticValue0;
        let ssaValue47120;
        if (!ssaBlockArrayRangeGuard6 && ((ssaValue47120 = ssaEntryStaticArrayData0[ssaValue47118]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47102, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 104, [ssaEntryStaticValue0, ssaValue47116, ssaValue47119, ssaValue47118]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47120 = helpers.arrayLoad(ssaValue47118, ssaValue47119, frame, "iaload");
        } else {
          ssaValue47120 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47118]) | 0) : ((ssaValue47120) | 0);
        }
        const ssaValue47121 = ssaEntryStaticValue0;
        if (!ssaArrayRangeGuard4 && ((ssaValue47116 >>> 0) >= ssaEntryStaticArrayData0.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47102, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 105, [ssaValue47121, ssaValue47116, ssaValue47120]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue47120, ssaValue47116, ssaValue47121, frame, "iastore");
        } else {
          ssaEntryStaticArrayData0[ssaValue47116] = ((ssaValue47120) | 0);
        }
        const ssaValue47123 = ((ssaValue47080 + 3) | 0);
        const ssaValue47125 = ((ssaValue47102 + 3) | 0);
        const ssaValue47126 = ssaEntryStaticValue0;
        let ssaValue47127;
        if (!ssaBlockArrayRangeGuard6 && ((ssaValue47127 = ssaEntryStaticArrayData0[ssaValue47125]) === undefined)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47102, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 114, [ssaEntryStaticValue0, ssaValue47123, ssaValue47126, ssaValue47125]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          ssaValue47127 = helpers.arrayLoad(ssaValue47125, ssaValue47126, frame, "iaload");
        } else {
          ssaValue47127 = ssaBlockArrayRangeGuard6 ? ((ssaEntryStaticArrayData0[ssaValue47125]) | 0) : ((ssaValue47127) | 0);
        }
        const ssaValue47128 = ssaEntryStaticValue0;
        if (!ssaArrayRangeGuard4 && ((ssaValue47123 >>> 0) >= ssaEntryStaticArrayData0.length)) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), ssaValue47102, local3, local4, local5, local6, ssaValue47080, ssaValue47086], 115, [ssaValue47128, ssaValue47123, ssaValue47127]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          helpers.arrayStore(ssaValue47127, ssaValue47123, ssaValue47128, frame, "iastore");
        } else {
          ssaEntryStaticArrayData0[ssaValue47123] = ((ssaValue47127) | 0);
        }
      }
      const ssaValue47129 = local7;
      const ssaValue47130 = (ssaValue47129 + 4) | 0;
      local7 = ssaValue47130;
    }
    const ssaValue47132 = local2;
    const ssaValue47133 = local3;
    const ssaValue47134 = ssaEntryStaticValue0;
    const ssaBlockArrayRangeGuard9 = ((((ssaValue47132) + 0) | 0) >= 0 && (((ssaValue47132) + 3) | 0) >= (((ssaValue47132) + 0) | 0) && (((ssaValue47132) + 3) | 0) < ssaEntryStaticArrayData0.length);
    if (!ssaBlockArrayRangeGuard9 && ((ssaValue47132 >>> 0) >= ssaEntryStaticArrayData0.length)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 123, [ssaValue47134, ssaValue47132, ssaValue47133]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.arrayStore(ssaValue47133, ssaValue47132, ssaValue47134, frame, "iastore");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaEntryStaticArrayData0[ssaValue47132] = ((ssaValue47133) | 0);
    }
    const ssaValue47136 = ((ssaValue47132 + 1) | 0);
    const ssaValue47137 = local4;
    const ssaValue47138 = ssaEntryStaticValue0;
    if (!ssaBlockArrayRangeGuard9 && ((ssaValue47136 >>> 0) >= ssaEntryStaticArrayData0.length)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 129, [ssaValue47138, ssaValue47136, ssaValue47137]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.arrayStore(ssaValue47137, ssaValue47136, ssaValue47138, frame, "iastore");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaEntryStaticArrayData0[ssaValue47136] = ((ssaValue47137) | 0);
    }
    const ssaValue47140 = ((ssaValue47132 + 2) | 0);
    const ssaValue47141 = local5;
    const ssaValue47142 = ssaEntryStaticValue0;
    if (!ssaBlockArrayRangeGuard9 && ((ssaValue47140 >>> 0) >= ssaEntryStaticArrayData0.length)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 135, [ssaValue47142, ssaValue47140, ssaValue47141]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.arrayStore(ssaValue47141, ssaValue47140, ssaValue47142, frame, "iastore");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaEntryStaticArrayData0[ssaValue47140] = ((ssaValue47141) | 0);
    }
    const ssaValue47144 = ((ssaValue47132 + 3) | 0);
    const ssaValue47145 = local6;
    const ssaValue47146 = ssaEntryStaticValue0;
    if (!ssaBlockArrayRangeGuard9 && ((ssaValue47144 >>> 0) >= ssaEntryStaticArrayData0.length)) {
      ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 141, [ssaValue47146, ssaValue47144, ssaValue47145]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.arrayStore(ssaValue47145, ssaValue47144, ssaValue47146, frame, "iastore");
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    } else {
      ssaEntryStaticArrayData0[ssaValue47144] = ((ssaValue47145) | 0);
    }
    const ssaValue47147 = local0;
        /*__JVM_REGION_CALL_START_144__*/
    let ssaValue47148;
    let ssaValue47150 = ssaCallStack.length;
    let ssaValue47151 = false;
    if (true) {
      ssaValue47151 = true;
      try { ssaValue47148 = jvm$ssa_direct_restoring_positional$ok$a_II_V(helpers, plan, ssaValue47147, ssaValue47132, thread, 2); } catch (ssaValue47149) {
        /*__JVM_CALL_HANDLER_START_144__*/
        if (false && ssaCallStack.length > ssaValue47150) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        } else {
          /*__JVM_CALL_RESTORE_START_144__*/
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 144, [ssaValue47147, ssaValue47132]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          /*__JVM_CALL_RESTORE_END_144__*/
        }
        throw ssaValue47149;
        /*__JVM_CALL_HANDLER_END_144__*/
      }
    }
    if (!ssaValue47151 || ssaValue47148 === ssaAsyncInvoke) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), local2, local3, local4, local5, local6, local7, local8]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
      stack[0] = ssaValue47147;
      stack[1] = ssaValue47132;
      stack.length = 2;
      try { ssaValue47148 = helpers.tryInvokeSyncAt(9963, frame, thread); } catch (ssaValue47149) {
        if (true && ssaCallStack.length > ssaValue47150) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        } else {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 144, [ssaValue47147, ssaValue47132]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        }
        throw ssaValue47149;
      }
    }
    if (ssaValue47148 === ssaAsyncInvoke &&
        ssaCallStack.length > ssaValue47150) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
    }
    if (ssaValue47148 === ssaAsyncInvoke &&
        ssaCallStack.length > ssaValue47150 &&
        helpers.linkStructuredCallChild(frame, thread, ssaValue47150, "void", 9963)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee left active child', jvmPositionalChild: frame };
    }
    if (ssaValue47148 === ssaAsyncInvoke) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 144, [ssaValue47147, ssaValue47132]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.skipJitOnce(frame);
      return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };
    }
    if (ssaValue47148 && ssaValue47148.deopt) {
      if (frame === null && (ssaValue47148.jvmPositionalChild || ssaCallStack.length > ssaValue47150)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
      if (!helpers.linkStructuredCallChild(frame, thread, ssaValue47150, "void", undefined, ssaValue47148.jvmPositionalChild)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 144, [ssaValue47147, ssaValue47132]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.skipJitOnce(frame);
        return ssaValue47148;
      }
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      if (frame) ssaValue47148.jvmPositionalChild = frame;
      return ssaValue47148;
    }
    if (frame !== null) {
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    }
    if (ssaCallStack.length > ssaValue47150) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
    }
    if (ssaCallStack.length > ssaValue47150 &&
        helpers.linkStructuredCallChild(frame, thread, ssaValue47150, "void")) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        return { deopt: true, transient: true, reason: 'structured SSA callee left active child', jvmPositionalChild: frame };
    }
    if (thread.status !== 'runnable') {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ((Number(argument1)) | 0), ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 145, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee', jvmPositionalChild: frame };
    }
    /*__JVM_REGION_CALL_END_144__*/
    if (frame !== null) {
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    }
        const ssaValue47152 = ((ssaValue47132 + 4) | 0);
    const ssaValue47153 = local1;
        /*__JVM_REGION_CALL_START_149__*/
    let ssaValue47154;
    let ssaValue47156 = ssaCallStack.length;
    let ssaValue47157 = false;
    if (true) {
      ssaValue47157 = true;
      try { ssaValue47154 = jvm$ssa_direct_restoring_positional$ok$a_II_V(helpers, plan, ssaValue47152, ssaValue47153, thread, 2); } catch (ssaValue47155) {
        /*__JVM_CALL_HANDLER_START_149__*/
        if (false && ssaCallStack.length > ssaValue47156) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        } else {
          /*__JVM_CALL_RESTORE_START_149__*/
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 149, [ssaValue47152, ssaValue47153]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
          /*__JVM_CALL_RESTORE_END_149__*/
        }
        throw ssaValue47155;
        /*__JVM_CALL_HANDLER_END_149__*/
      }
    }
    if (!ssaValue47157 || ssaValue47154 === ssaAsyncInvoke) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(280, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0), local2, local3, local4, local5, local6, local7, local8]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
      stack[0] = ssaValue47152;
      stack[1] = ssaValue47153;
      stack.length = 2;
      try { ssaValue47154 = helpers.tryInvokeSyncAt(9964, frame, thread); } catch (ssaValue47155) {
        if (true && ssaCallStack.length > ssaValue47156) {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        } else {
          ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 149, [ssaValue47152, ssaValue47153]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        }
        throw ssaValue47155;
      }
    }
    if (ssaValue47154 === ssaAsyncInvoke &&
        ssaCallStack.length > ssaValue47156) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
    }
    if (ssaValue47154 === ssaAsyncInvoke &&
        ssaCallStack.length > ssaValue47156 &&
        helpers.linkStructuredCallChild(frame, thread, ssaValue47156, "void", 9964)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee left active child', jvmPositionalChild: frame };
    }
    if (ssaValue47154 === ssaAsyncInvoke) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 149, [ssaValue47152, ssaValue47153]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      helpers.skipJitOnce(frame);
      return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };
    }
    if (ssaValue47154 && ssaValue47154.deopt) {
      if (frame === null && (ssaValue47154.jvmPositionalChild || ssaCallStack.length > ssaValue47156)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
      if (!helpers.linkStructuredCallChild(frame, thread, ssaValue47156, "void", undefined, ssaValue47154.jvmPositionalChild)) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 149, [ssaValue47152, ssaValue47153]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.skipJitOnce(frame);
        return ssaValue47154;
      }
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      if (frame) ssaValue47154.jvmPositionalChild = frame;
      return ssaValue47154;
    }
    if (frame !== null) {
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    }
    if (ssaCallStack.length > ssaValue47156) {
      if (frame === null) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      }
    }
    if (ssaCallStack.length > ssaValue47156 &&
        helpers.linkStructuredCallChild(frame, thread, ssaValue47156, "void")) {
        ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        return { deopt: true, transient: true, reason: 'structured SSA callee left active child', jvmPositionalChild: frame };
    }
    if (thread.status !== 'runnable') {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(280, plan, thread, restorationDepth, frame, [ssaValue47147, ssaValue47153, ssaValue47132, ssaValue47133, ssaValue47137, ssaValue47141, ssaValue47145, local7, local8], 150, []); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      return { deopt: true, transient: true, reason: 'thread yielded in structured SSA callee', jvmPositionalChild: frame };
    }
    /*__JVM_REGION_CALL_END_149__*/
    if (frame !== null) {
      frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
      locals = null;
      stack = null;
    }
        return ssaReturnVoid;
  }
} else {
  return ssaReturnVoid;
}
//# sourceURL=jvm-generated://ok/a(II)V?tier=ssa-direct-restoring-positional
