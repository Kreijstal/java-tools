'use strict';
const ssaCallStack = thread.callStack.items;
const ssaRestoringClassInitializationGuard = ssaLinkClassGuard653;
if ((!nestedEntryGuarded && (helpers.profileMethods || helpers.needsBytecodeChecks() || thread.status !== 'runnable')) || (nestedEntryGuarded !== 2 && ((ssaRestoringClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaRestoringClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaRestoringClassInitializationGuard)))) { return ssaAsyncInvoke; }
const restorationDepth = ssaCallStack.length;
let frame = null;
let locals = null;
let stack = null;
let ssaRestoredFrame = null;
let ssaEntryStaticValue0 = ssaLinkStaticCell6543.value /* f:[I */;
let ssaEntryStaticArrayData0 = (ssaEntryStaticValue0 == null ? null : ssaEntryStaticValue0.elements ? ssaEntryStaticValue0.elements : (Array.isArray(ssaEntryStaticValue0) || ArrayBuffer.isView(ssaEntryStaticValue0) ? ssaEntryStaticValue0 : null));
let safePointBudget = 25600;
let local0 = ((Number(argument0)) | 0);
let local1 = ((Number(argument1)) | 0);
let local2 = undefined;
let local3 = undefined;
let local4 = undefined;
let local5 = undefined;
if (ssaEntryStaticArrayData0 === null) { return ssaAsyncInvoke; }
safePointBudget = Math.min(safePointBudget, 256);
L0: while (true) {
  if (--safePointBudget <= 0) {
    if (nestedEntryGuarded === 2 || helpers.continueStructuredQuantum(thread)) { safePointBudget = 256; } else {
      ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(287, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), local1, local2, local3, local4, local5]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
      stack.length = 0;
      helpers.materialize(frame, locals, stack, 0);
      helpers.structuredSsa.safePointCount += 1;
      return { deopt: true, transient: true, reason: 'structured SSA safe point' };
    }
  }
  L10: {
    if (!((local1) < (((local0 + 8) | 0)))) {
      local2 = 1;
      local3 = (((local0 + 4) | 0));
      const ssaArrayRangeGuard0 = (((local1 - local3) <= 0 ? 0 : Math.ceil((local1 - local3) / 4)) === 0 || (((local1 - local3) <= 0 ? 0 : Math.ceil((local1 - local3) / 4)) <= 1024 && (local3 + -4) >= 0 && (local3 + (((local1 - local3) <= 0 ? 0 : Math.ceil((local1 - local3) / 4)) - 1) * 4 + 3) >= (local3 + -4) && (local3 + (((local1 - local3) <= 0 ? 0 : Math.ceil((local1 - local3) / 4)) - 1) * 4 + 3) <= 2147483647 && (local3 + ((local1 - local3) <= 0 ? 0 : Math.ceil((local1 - local3) / 4)) * 4) >= local3 && (local3 + ((local1 - local3) <= 0 ? 0 : Math.ceil((local1 - local3) / 4)) * 4) <= 2147483647 && (local3 + (((local1 - local3) <= 0 ? 0 : Math.ceil((local1 - local3) / 4)) - 1) * 4 + 3) < ssaEntryStaticArrayData0.length));
      if (!(ssaArrayRangeGuard0)) return ssaAsyncInvoke;
      const ssaRuntimeCoarseTrips2 = (local3 >= local1 ? 0 : Math.ceil((local1 - local3) / 4));
      const ssaRuntimeCoarseLoop2 = ssaRuntimeCoarseTrips2 <= 1024 && local3 <= 2147483647 - ssaRuntimeCoarseTrips2 * 4;
      if (ssaRuntimeCoarseLoop2) safePointBudget -= ssaRuntimeCoarseTrips2;
      if (ssaRuntimeCoarseLoop2 && ssaArrayRangeGuard0) {
        L2: while (local3 < local1) {
          const ssaValue47776 = local3;
          const ssaValue47777 = ((ssaValue47776 - 4) | 0);
          const ssaValue47778 = ssaEntryStaticValue0;
          let ssaValue47779;
          ssaValue47779 = ((ssaEntryStaticArrayData0[ssaValue47777]) | 0);
          local4 = ssaValue47779;
          const ssaValue47781 = ssaEntryStaticValue0;
          let ssaValue47782;
          ssaValue47782 = ((ssaEntryStaticArrayData0[ssaValue47776]) | 0);
          local5 = ssaValue47782;
          if (!(ssaValue47779 <= ssaValue47782)) {
            local2 = 0;
            const ssaValue47784 = local3;
            const ssaValue47785 = ((ssaValue47784 - 4) | 0);
            const ssaValue47786 = local5;
            const ssaValue47787 = ssaEntryStaticValue0;
            ssaEntryStaticArrayData0[ssaValue47785] = ((ssaValue47786) | 0);
            const ssaValue47789 = local4;
            const ssaValue47790 = ssaEntryStaticValue0;
            ssaEntryStaticArrayData0[ssaValue47784] = ((ssaValue47789) | 0);
            const ssaValue47792 = ((ssaValue47784 - 2) | 0);
            const ssaValue47793 = ssaEntryStaticValue0;
            let ssaValue47794;
            ssaValue47794 = ((ssaEntryStaticArrayData0[ssaValue47792]) | 0);
            local4 = ssaValue47794;
            const ssaValue47796 = ((ssaValue47784 - 2) | 0);
            const ssaValue47798 = ((ssaValue47784 + 2) | 0);
            const ssaValue47799 = ssaEntryStaticValue0;
            let ssaValue47800;
            ssaValue47800 = ((ssaEntryStaticArrayData0[ssaValue47798]) | 0);
            const ssaValue47801 = ssaEntryStaticValue0;
            ssaEntryStaticArrayData0[ssaValue47796] = ((ssaValue47800) | 0);
            const ssaValue47803 = ((ssaValue47784 + 2) | 0);
            const ssaValue47804 = ssaEntryStaticValue0;
            ssaEntryStaticArrayData0[ssaValue47803] = ((ssaValue47794) | 0);
            const ssaValue47806 = ((ssaValue47784 - 1) | 0);
            const ssaValue47807 = ssaEntryStaticValue0;
            let ssaValue47808;
            ssaValue47808 = ((ssaEntryStaticArrayData0[ssaValue47806]) | 0);
            local4 = ssaValue47808;
            const ssaValue47810 = ((ssaValue47784 - 1) | 0);
            const ssaValue47812 = ((ssaValue47784 + 3) | 0);
            const ssaValue47813 = ssaEntryStaticValue0;
            let ssaValue47814;
            ssaValue47814 = ((ssaEntryStaticArrayData0[ssaValue47812]) | 0);
            const ssaValue47815 = ssaEntryStaticValue0;
            ssaEntryStaticArrayData0[ssaValue47810] = ((ssaValue47814) | 0);
            const ssaValue47817 = ((ssaValue47784 + 3) | 0);
            const ssaValue47818 = ssaEntryStaticValue0;
            ssaEntryStaticArrayData0[ssaValue47817] = ((ssaValue47808) | 0);
          }
          const ssaValue47819 = local3;
          const ssaValue47820 = (ssaValue47819 + 4) | 0;
          local3 = ssaValue47820;
        }
        const ssaValue47821 = local2;
        if (ssaValue47821 === 0) {
          const ssaValue47822 = local1;
          const ssaValue47823 = (ssaValue47822 + -4) | 0;
          local1 = ssaValue47823;
          continue L0;
        } else {
          break L10;
        }
      } else {
        L2: while (local3 < local1) {
          if (!ssaRuntimeCoarseLoop2 && --safePointBudget <= 0) {
            if (nestedEntryGuarded === 2 || helpers.continueStructuredQuantum(thread)) { safePointBudget = 256; } else {
              ssaRestoredFrame = helpers.structuredSsa.restoreDirectFrame(287, plan, thread, restorationDepth, frame, [((Number(argument0)) | 0), local1, local2, local3, local4, local5]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              stack.length = 0;
              helpers.materialize(frame, locals, stack, 11);
              helpers.structuredSsa.safePointCount += 1;
              return { deopt: true, transient: true, reason: 'structured SSA safe point' };
            }
          }
          const ssaValue47776 = local3;
          const ssaValue47777 = ((ssaValue47776 - 4) | 0);
          const ssaValue47778 = ssaEntryStaticValue0;
          let ssaValue47779;
          if (!ssaArrayRangeGuard0 && ((ssaValue47779 = ssaEntryStaticArrayData0[ssaValue47777]) === undefined)) {
            ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 18, [ssaValue47778, ssaValue47777]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
            ssaValue47779 = helpers.arrayLoad(ssaValue47777, ssaValue47778, frame, "iaload");
            frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
            locals = null;
            stack = null;
          } else {
            ssaValue47779 = ssaArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[ssaValue47777]) | 0) : ((ssaValue47779) | 0);
          }
          local4 = ssaValue47779;
          const ssaValue47781 = ssaEntryStaticValue0;
          let ssaValue47782;
          if (!ssaArrayRangeGuard0 && ((ssaValue47782 = ssaEntryStaticArrayData0[ssaValue47776]) === undefined)) {
            ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 22, [ssaValue47781, ssaValue47776]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
            ssaValue47782 = helpers.arrayLoad(ssaValue47776, ssaValue47781, frame, "iaload");
            frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
            locals = null;
            stack = null;
          } else {
            ssaValue47782 = ssaArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[ssaValue47776]) | 0) : ((ssaValue47782) | 0);
          }
          local5 = ssaValue47782;
          if (!(ssaValue47779 <= ssaValue47782)) {
            local2 = 0;
            const ssaValue47784 = local3;
            const ssaValue47785 = ((ssaValue47784 - 4) | 0);
            const ssaValue47786 = local5;
            const ssaValue47787 = ssaEntryStaticValue0;
            if (!ssaArrayRangeGuard0 && ((ssaValue47785 >>> 0) >= ssaEntryStaticArrayData0.length)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 34, [ssaValue47787, ssaValue47785, ssaValue47786]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              helpers.arrayStore(ssaValue47786, ssaValue47785, ssaValue47787, frame, "iastore");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaEntryStaticArrayData0[ssaValue47785] = ((ssaValue47786) | 0);
            }
            const ssaValue47789 = local4;
            const ssaValue47790 = ssaEntryStaticValue0;
            if (!ssaArrayRangeGuard0 && ((ssaValue47784 >>> 0) >= ssaEntryStaticArrayData0.length)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 38, [ssaValue47790, ssaValue47784, ssaValue47789]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              helpers.arrayStore(ssaValue47789, ssaValue47784, ssaValue47790, frame, "iastore");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaEntryStaticArrayData0[ssaValue47784] = ((ssaValue47789) | 0);
            }
            const ssaValue47792 = ((ssaValue47784 - 2) | 0);
            const ssaValue47793 = ssaEntryStaticValue0;
            let ssaValue47794;
            if (!ssaArrayRangeGuard0 && ((ssaValue47794 = ssaEntryStaticArrayData0[ssaValue47792]) === undefined)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 43, [ssaValue47793, ssaValue47792]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              ssaValue47794 = helpers.arrayLoad(ssaValue47792, ssaValue47793, frame, "iaload");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaValue47794 = ssaArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[ssaValue47792]) | 0) : ((ssaValue47794) | 0);
            }
            local4 = ssaValue47794;
            const ssaValue47796 = ((ssaValue47784 - 2) | 0);
            const ssaValue47798 = ((ssaValue47784 + 2) | 0);
            const ssaValue47799 = ssaEntryStaticValue0;
            let ssaValue47800;
            if (!ssaArrayRangeGuard0 && ((ssaValue47800 = ssaEntryStaticArrayData0[ssaValue47798]) === undefined)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 53, [ssaEntryStaticValue0, ssaValue47796, ssaValue47799, ssaValue47798]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              ssaValue47800 = helpers.arrayLoad(ssaValue47798, ssaValue47799, frame, "iaload");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaValue47800 = ssaArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[ssaValue47798]) | 0) : ((ssaValue47800) | 0);
            }
            const ssaValue47801 = ssaEntryStaticValue0;
            if (!ssaArrayRangeGuard0 && ((ssaValue47796 >>> 0) >= ssaEntryStaticArrayData0.length)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 54, [ssaValue47801, ssaValue47796, ssaValue47800]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              helpers.arrayStore(ssaValue47800, ssaValue47796, ssaValue47801, frame, "iastore");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaEntryStaticArrayData0[ssaValue47796] = ((ssaValue47800) | 0);
            }
            const ssaValue47803 = ((ssaValue47784 + 2) | 0);
            const ssaValue47804 = ssaEntryStaticValue0;
            if (!ssaArrayRangeGuard0 && ((ssaValue47803 >>> 0) >= ssaEntryStaticArrayData0.length)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 60, [ssaValue47804, ssaValue47803, ssaValue47794]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              helpers.arrayStore(ssaValue47794, ssaValue47803, ssaValue47804, frame, "iastore");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaEntryStaticArrayData0[ssaValue47803] = ((ssaValue47794) | 0);
            }
            const ssaValue47806 = ((ssaValue47784 - 1) | 0);
            const ssaValue47807 = ssaEntryStaticValue0;
            let ssaValue47808;
            if (!ssaArrayRangeGuard0 && ((ssaValue47808 = ssaEntryStaticArrayData0[ssaValue47806]) === undefined)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 65, [ssaValue47807, ssaValue47806]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              ssaValue47808 = helpers.arrayLoad(ssaValue47806, ssaValue47807, frame, "iaload");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaValue47808 = ssaArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[ssaValue47806]) | 0) : ((ssaValue47808) | 0);
            }
            local4 = ssaValue47808;
            const ssaValue47810 = ((ssaValue47784 - 1) | 0);
            const ssaValue47812 = ((ssaValue47784 + 3) | 0);
            const ssaValue47813 = ssaEntryStaticValue0;
            let ssaValue47814;
            if (!ssaArrayRangeGuard0 && ((ssaValue47814 = ssaEntryStaticArrayData0[ssaValue47812]) === undefined)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 75, [ssaEntryStaticValue0, ssaValue47810, ssaValue47813, ssaValue47812]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              ssaValue47814 = helpers.arrayLoad(ssaValue47812, ssaValue47813, frame, "iaload");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaValue47814 = ssaArrayRangeGuard0 ? ((ssaEntryStaticArrayData0[ssaValue47812]) | 0) : ((ssaValue47814) | 0);
            }
            const ssaValue47815 = ssaEntryStaticValue0;
            if (!ssaArrayRangeGuard0 && ((ssaValue47810 >>> 0) >= ssaEntryStaticArrayData0.length)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 76, [ssaValue47815, ssaValue47810, ssaValue47814]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              helpers.arrayStore(ssaValue47814, ssaValue47810, ssaValue47815, frame, "iastore");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaEntryStaticArrayData0[ssaValue47810] = ((ssaValue47814) | 0);
            }
            const ssaValue47817 = ((ssaValue47784 + 3) | 0);
            const ssaValue47818 = ssaEntryStaticValue0;
            if (!ssaArrayRangeGuard0 && ((ssaValue47817 >>> 0) >= ssaEntryStaticArrayData0.length)) {
              ssaRestoredFrame = helpers.structuredSsa.materializeUnwindFrame(plan, thread, restorationDepth, frame, 82, [ssaValue47818, ssaValue47817, ssaValue47808]); frame = ssaRestoredFrame[0]; locals = ssaRestoredFrame[1]; stack = ssaRestoredFrame[2];
              helpers.arrayStore(ssaValue47808, ssaValue47817, ssaValue47818, frame, "iastore");
              frame = helpers.structuredSsa.releaseUnwindFrame(plan, thread, frame);
              locals = null;
              stack = null;
            } else {
              ssaEntryStaticArrayData0[ssaValue47817] = ((ssaValue47808) | 0);
            }
          }
          const ssaValue47819 = local3;
          const ssaValue47820 = (ssaValue47819 + 4) | 0;
          local3 = ssaValue47820;
        }
        const ssaValue47821 = local2;
        if (ssaValue47821 === 0) {
          const ssaValue47822 = local1;
          const ssaValue47823 = (ssaValue47822 + -4) | 0;
          local1 = ssaValue47823;
          continue L0;
        } else {
          break L10;
        }
      }
    }
  }
  return ssaReturnVoid;
}
//# sourceURL=jvm-generated://ok/b(II)V?tier=ssa-direct-restoring-positional
