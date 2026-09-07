'use strict';
const ssaCallStack = thread.callStack.items;
const ssaRestoringClassInitializationGuard = ssaLinkClassGuard629;
if ((!nestedEntryGuarded && (helpers.profileMethods || helpers.needsBytecodeChecks() || thread.status !== 'runnable')) || (nestedEntryGuarded !== 2 && ((ssaRestoringClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaRestoringClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaRestoringClassInitializationGuard)))) { return ssaAsyncInvoke; }
const restorationDepth = ssaCallStack.length;
let frame = null;
let locals = null;
let stack = null;
let ssaRestoredFrame = null;
let ssaEntryStaticValue0 = ssaLinkStaticCell6302.value /* b:[I */;
let ssaEntryStaticArrayData0 = (ssaEntryStaticValue0 == null ? null : ssaEntryStaticValue0.elements ? ssaEntryStaticValue0.elements : (Array.isArray(ssaEntryStaticValue0) || ArrayBuffer.isView(ssaEntryStaticValue0) ? ssaEntryStaticValue0 : null));
let local0 = ((Number(argument0)) | 0);
let local1 = ((Number(argument1)) | 0);
if (ssaEntryStaticArrayData0 === null) { return ssaAsyncInvoke; }
if (!(local0 === 2047)) {
  const ssaValue46813 = null;
  if (ssaValue46813 != null) {
    const ssaValue46814 = (typeof ssaValue46813 === "string" || ssaValue46813 instanceof String ? "java/lang/String" : (ssaValue46813._className || ssaValue46813.type));
    if (ssaValue46814 !== "[I") {
      let ssaValue46815;
      try { ssaValue46815 = helpers.tryCheckCastSourceSync(ssaValue46814, "[I"); } catch (ssaValue46816) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(275, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0)], 4, [null]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    throw ssaValue46816;
  }
      if (ssaValue46815 === ssaAsyncInvoke) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(275, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), ((Number(argument1)) | 0)], 4, [null]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.skipJitOnce(frame);
        return { deopt: true, transient: true, reason: 'cold structured SSA checkcast' };
      }
    }
  }
  ssaLinkStaticCell6301.value = null;
  if (helpers.directStaticTargets[6301].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6301]);
}
const ssaValue46820 = (local1 & 2047);
const ssaValue46821 = ssaEntryStaticValue0;
let ssaValue46822;
if (!false && ((ssaValue46822 = ssaEntryStaticArrayData0[ssaValue46820]) === undefined)) {
  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(275, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), local1], 12, [ssaValue46821, ssaValue46820]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  ssaValue46822 = helpers.arrayLoad(ssaValue46820, ssaValue46821, frame, "iaload");
} else {
  ssaValue46822 = false ? ((ssaEntryStaticArrayData0[ssaValue46820]) | 0) : ((ssaValue46822) | 0);
}
return ssaValue46822;
//# sourceURL=jvm-generated://ke/a(II)I?tier=ssa-direct-restoring-positional
