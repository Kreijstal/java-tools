'use strict';
const ssaCallStack = thread.callStack.items;
const ssaRestoringClassInitializationGuard = ssaLinkClassGuard631;
if ((!nestedEntryGuarded && (helpers.profileMethods || helpers.needsBytecodeChecks() || thread.status !== 'runnable')) || (nestedEntryGuarded !== 2 && ((ssaRestoringClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaRestoringClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaRestoringClassInitializationGuard)))) { return ssaAsyncInvoke; }
const restorationDepth = ssaCallStack.length;
let frame = null;
let locals = null;
let stack = null;
let ssaRestoredFrame = null;
let ssaEntryStaticValue0 = ssaLinkStaticCell6306.value /* f:[I */;
let ssaEntryStaticArrayData0 = (ssaEntryStaticValue0 == null ? null : ssaEntryStaticValue0.elements ? ssaEntryStaticValue0.elements : (Array.isArray(ssaEntryStaticValue0) || ArrayBuffer.isView(ssaEntryStaticValue0) ? ssaEntryStaticValue0 : null));
let local0 = ((Number(argument0)) | 0);
let local1 = (((Number(argument1)) << 24) >> 24);
if (ssaEntryStaticArrayData0 === null) { return ssaAsyncInvoke; }
if (!(local1 === -122)) {
  const ssaValue46824 = null;
  if (ssaValue46824 != null) {
    const ssaValue46825 = (typeof ssaValue46824 === "string" || ssaValue46824 instanceof String ? "java/lang/String" : (ssaValue46824._className || ssaValue46824.type));
    if (ssaValue46825 !== "java/lang/String") {
      let ssaValue46826;
      try { ssaValue46826 = helpers.tryCheckCastSourceSync(ssaValue46825, "java/lang/String"); } catch (ssaValue46827) {
    ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(276, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), (((Number(argument1)) << 24) >> 24)], 4, [null]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
    throw ssaValue46827;
  }
      if (ssaValue46826 === ssaAsyncInvoke) {
      ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(276, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), (((Number(argument1)) << 24) >> 24)], 4, [null]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
        helpers.skipJitOnce(frame);
        return { deopt: true, transient: true, reason: 'cold structured SSA checkcast' };
      }
    }
  }
  ssaLinkStaticCell6305.value = null;
  if (helpers.directStaticTargets[6305].versionCell.captureCaches) helpers.markStaticTargetChanged(helpers.directStaticTargets[6305]);
}
const ssaValue46831 = (local0 & 2047);
const ssaValue46832 = ssaEntryStaticValue0;
let ssaValue46833;
if (!false && ((ssaValue46833 = ssaEntryStaticArrayData0[ssaValue46831]) === undefined)) {
  ssaRestoredFrame = helpers.structuredSsa.materializeDirectFrame(276, plan, thread, restorationDepth, frame, [local0, (((Number(argument1)) << 24) >> 24)], 12, [ssaValue46832, ssaValue46831]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
  ssaValue46833 = helpers.arrayLoad(ssaValue46831, ssaValue46832, frame, "iaload");
} else {
  ssaValue46833 = false ? ((ssaEntryStaticArrayData0[ssaValue46831]) | 0) : ((ssaValue46833) | 0);
}
return ssaValue46833;
//# sourceURL=jvm-generated://h/a(IB)I?tier=ssa-direct-restoring-positional
