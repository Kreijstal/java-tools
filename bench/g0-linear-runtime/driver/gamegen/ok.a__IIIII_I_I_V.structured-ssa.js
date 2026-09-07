'use strict';
const ssaCallStack = thread.callStack.items;
const locals = frame.locals;
const stack = frame.stack.items;
if ((!framelessEntry && frame.pc !== 0) || (initialBytecodeChecks === undefined ? helpers.needsBytecodeChecks() : initialBytecodeChecks)) { helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'structured SSA entry' }; }
const ssaClassInitializationGuard = ssaLinkClassGuard656;
if ((ssaClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaClassInitializationGuard)) { helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'structured SSA static entry' }; }
const ssaFastPathsOk = !helpers.profileMethods && helpers.jvm.debugManager.jitDeoptedClassCount === 0;
const ssaCallSite12 = ssaLinkCallSite10084;
const ssaCallSite15 = ssaLinkCallSite10085;
const ssaCallSite19 = ssaLinkCallSite10086;
const ssaCallSite24 = ssaLinkCallSite10087;


let safePointBudget = 256;
let local0 = locals[0];
let local1 = ((Number(locals[1])) | 0);
let local2 = ((Number(locals[2])) | 0);
let local3 = ((Number(locals[3])) | 0);
let local4 = ((Number(locals[4])) | 0);
let local5 = locals[5];
let local6 = locals[6];

const spillLocals = () => { };
function ssaMaterialize0(pc) {
  spillLocals();
  stack.length = 0;
  helpers.materialize(frame, locals, stack, pc);
}
function ssaMaterialize1(pc, operand0) {
  spillLocals();
  stack[0] = operand0;
  stack.length = 1;
  helpers.materialize(frame, locals, stack, pc);
}
function ssaMaterialize2(pc, operand0, operand1) {
  spillLocals();
  stack[0] = operand0;
  stack[1] = operand1;
  stack.length = 2;
  helpers.materialize(frame, locals, stack, pc);
}
function ssaMaterialize3(pc, operand0, operand1, operand2) {
  spillLocals();
  stack[0] = operand0;
  stack[1] = operand1;
  stack[2] = operand2;
  stack.length = 3;
  helpers.materialize(frame, locals, stack, pc);
}
function ssaMaterialize4(pc, operand0, operand1, operand2, operand3) {
  spillLocals();
  stack[0] = operand0;
  stack[1] = operand1;
  stack[2] = operand2;
  stack[3] = operand3;
  stack.length = 4;
  helpers.materialize(frame, locals, stack, pc);
}
{
  const ssaValue47898 = local5;
  if (!(ssaValue47898 === null)) {
    {
      const ssaValue47899 = ssaLinkStaticCell6567.value;
      const ssaValue47900 = ssaLinkStaticCell6568.value;
      const ssaValue47901 = ((ssaValue47899 - ssaValue47900) | 0);
      const ssaValue47902 = local5;
      if (ssaValue47902 == null) {
        ssaMaterialize2(6, ssaValue47901, ssaValue47902);
        helpers.arrayLength(ssaValue47902, frame);
      }
      const ssaValue47903 = ssaValue47902.length;
      if (!(ssaValue47901 === ssaValue47903)) {
        {
          const ssaValue47904 = helpers.newObjectSync("java/lang/IllegalStateException");
          if (ssaValue47904 === helpers.staticDeopt()) {
            ssaMaterialize0(10);
            helpers.skipJitOnce(frame);
            return { deopt: true, transient: true, reason: 'class initialization in structured SSA new' };
          }
          /*__JVM_REGION_CALL_START_12__*/
          let ssaValue47905;
          let ssaValue47907 = ssaCallStack.length;
          let ssaFastPositional12 = ssaFastPathsOk && ssaCallSite12.fastPositional ? ssaCallSite12.fastPositional : null;
          let ssaFastPositionalInvoke12 = ssaFastPositional12 === null ? null : ssaFastPositional12.invoke;
          let ssaFastPositionalRawInvoke12 = ssaFastPositional12 === null ? null : ssaFastPositional12.rawInvoke;
          let ssaFastPositionalReceiver12 = ssaFastPositional12 === null ? null : ssaFastPositional12.receiverType;
          let ssaValue47908 = false;
          if ((ssaFastPositionalRawInvoke12 || ssaFastPositionalInvoke12) && ssaValue47904 != null && ssaFastPositionalReceiver12 === null) {
            ssaValue47908 = true;
            try { ssaValue47905 = ssaFastPositionalRawInvoke12 ? ssaFastPositionalRawInvoke12(helpers, /*__JVM_CALL_ARG_12_0__*/ssaValue47904, thread, true) : ssaFastPositionalInvoke12(ssaValue47904, thread, true); } catch (ssaValue47906) {
              /*__JVM_CALL_HANDLER_START_12__*/
              if (!ssaFastPositionalInvoke12.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue47907) {
                ssaMaterialize1(13, ssaValue47904);
              } else {
                /*__JVM_CALL_RESTORE_START_12__*/
                ssaMaterialize2(12, ssaValue47904, ssaValue47904);
                /*__JVM_CALL_RESTORE_END_12__*/
              }
              throw ssaValue47906;
              /*__JVM_CALL_HANDLER_END_12__*/
            }
          }
          if (!ssaValue47908 || ssaValue47905 === ssaAsyncInvoke) {
            if (frame === null) spillLocals();
            stack[0] = ssaValue47904;
            stack[1] = ssaValue47904;
            stack.length = 2;
            try { ssaValue47905 = helpers.tryInvokeSyncAt(10084, frame, thread); } catch (ssaValue47906) {
              if (true && ssaCallStack.length > ssaValue47907) {
                ssaMaterialize1(13, ssaValue47904);
              } else {
                ssaMaterialize2(12, ssaValue47904, ssaValue47904);
              }
              throw ssaValue47906;
            }
          }
          if (ssaValue47905 === ssaAsyncInvoke || (typeof ssaValue47905 === "object" && ssaValue47905 !== null && ssaValue47905.deopt) || ssaCallStack.length > ssaValue47907 || thread.status !== 'runnable') {
            const ssaValue47909 = helpers.structuredSsa.coldCallOrdinary(frame, thread, ssaValue47905, ssaValue47907, 10084, "void", 13, true, spillLocals, [ssaValue47904, ssaValue47904], 1);
            if (ssaValue47909 !== helpers.structuredSsa.coldContinue) {
              return ssaValue47909;
            }
          }
          /*__JVM_REGION_CALL_END_12__*/
          ssaMaterialize1(13, ssaValue47904);
          throw ssaValue47904;
        }
      }
    }
  }
}
{
  /*__JVM_REGION_CALL_START_15__*/
  let ssaValue47911;
  let ssaValue47913 = ssaCallStack.length;
  let ssaFastPositional15 = ssaFastPathsOk && ssaCallSite15.fastPositional ? ssaCallSite15.fastPositional : null;
  let ssaFastPositionalInvoke15 = ssaFastPositional15 === null ? null : ssaFastPositional15.invoke;
  let ssaFastPositionalRawInvoke15 = ssaFastPositional15 === null ? null : ssaFastPositional15.rawInvoke;
  let ssaFastPositionalReceiver15 = ssaFastPositional15 === null ? null : ssaFastPositional15.receiverType;
  let ssaValue47914 = false;
  if ((ssaFastPositionalRawInvoke15 || ssaFastPositionalInvoke15) && true) {
    ssaValue47914 = true;
    try { ssaValue47911 = ssaFastPositionalRawInvoke15 ? ssaFastPositionalRawInvoke15(helpers, thread, true) : ssaFastPositionalInvoke15(thread, true); } catch (ssaValue47912) {
      /*__JVM_CALL_HANDLER_START_15__*/
      if (!ssaFastPositionalInvoke15.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue47913) {
        ssaMaterialize0(16);
      } else {
        /*__JVM_CALL_RESTORE_START_15__*/
        ssaMaterialize0(15);
        /*__JVM_CALL_RESTORE_END_15__*/
      }
      throw ssaValue47912;
      /*__JVM_CALL_HANDLER_END_15__*/
    }
  }
  if (!ssaValue47914 || ssaValue47911 === ssaAsyncInvoke) {
    if (frame === null) spillLocals();
    stack.length = 0;
    try { ssaValue47911 = helpers.tryInvokeSyncAt(10085, frame, thread); } catch (ssaValue47912) {
      if (true && ssaCallStack.length > ssaValue47913) {
        ssaMaterialize0(16);
      } else {
        ssaMaterialize0(15);
      }
      throw ssaValue47912;
    }
  }
  if (ssaValue47911 === ssaAsyncInvoke || (typeof ssaValue47911 === "object" && ssaValue47911 !== null && ssaValue47911.deopt) || ssaCallStack.length > ssaValue47913 || thread.status !== 'runnable') {
    const ssaValue47915 = helpers.structuredSsa.coldCallOrdinary(frame, thread, ssaValue47911, ssaValue47913, 10085, "void", 16, true, spillLocals, [], 0);
    if (ssaValue47915 !== helpers.structuredSsa.coldContinue) {
      return ssaValue47915;
    }
  }
  /*__JVM_REGION_CALL_END_15__*/
  const ssaValue47917 = local0;
  const ssaValue47918 = local1;
  const ssaValue47919 = local2;
  /*__JVM_REGION_CALL_START_19__*/
  let ssaValue47920;
  let ssaValue47922 = ssaCallStack.length;
  let ssaFastPositional19 = ssaFastPathsOk && ssaCallSite19.fastPositional ? ssaCallSite19.fastPositional : null;
  let ssaFastPositionalInvoke19 = ssaFastPositional19 === null ? null : ssaFastPositional19.invoke;
  let ssaFastPositionalRawInvoke19 = ssaFastPositional19 === null ? null : ssaFastPositional19.rawInvoke;
  let ssaFastPositionalReceiver19 = ssaFastPositional19 === null ? null : ssaFastPositional19.receiverType;
  let ssaValue47923 = false;
  if ((ssaFastPositionalRawInvoke19 || ssaFastPositionalInvoke19) && true) {
    ssaValue47923 = true;
    try { ssaValue47920 = ssaFastPositionalRawInvoke19 ? ssaFastPositionalRawInvoke19(helpers, /*__JVM_CALL_ARG_19_0__*/ssaValue47917, /*__JVM_CALL_ARG_19_1__*/ssaValue47918, /*__JVM_CALL_ARG_19_2__*/ssaValue47919, thread, true) : ssaFastPositionalInvoke19(ssaValue47917, ssaValue47918, ssaValue47919, thread, true); } catch (ssaValue47921) {
      /*__JVM_CALL_HANDLER_START_19__*/
      if (!ssaFastPositionalInvoke19.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue47922) {
        ssaMaterialize0(20);
      } else {
        /*__JVM_CALL_RESTORE_START_19__*/
        ssaMaterialize3(19, ssaValue47917, ssaValue47918, ssaValue47919);
        /*__JVM_CALL_RESTORE_END_19__*/
      }
      throw ssaValue47921;
      /*__JVM_CALL_HANDLER_END_19__*/
    }
  }
  if (!ssaValue47923 || ssaValue47920 === ssaAsyncInvoke) {
    if (frame === null) spillLocals();
    stack[0] = ssaValue47917;
    stack[1] = ssaValue47918;
    stack[2] = ssaValue47919;
    stack.length = 3;
    try { ssaValue47920 = helpers.tryInvokeSyncAt(10086, frame, thread); } catch (ssaValue47921) {
      if (true && ssaCallStack.length > ssaValue47922) {
        ssaMaterialize0(20);
      } else {
        ssaMaterialize3(19, ssaValue47917, ssaValue47918, ssaValue47919);
      }
      throw ssaValue47921;
    }
  }
  if (ssaValue47920 === ssaAsyncInvoke || (typeof ssaValue47920 === "object" && ssaValue47920 !== null && ssaValue47920.deopt) || ssaCallStack.length > ssaValue47922 || thread.status !== 'runnable') {
    const ssaValue47924 = helpers.structuredSsa.coldCallOrdinary(frame, thread, ssaValue47920, ssaValue47922, 10086, "void", 20, true, spillLocals, [ssaValue47917, ssaValue47918, ssaValue47919], 0);
    if (ssaValue47924 !== helpers.structuredSsa.coldContinue) {
      return ssaValue47924;
    }
  }
  /*__JVM_REGION_CALL_END_19__*/
  const ssaValue47926 = local3;
  const ssaValue47927 = local4;
  const ssaValue47928 = local5;
  const ssaValue47929 = local6;
  /*__JVM_REGION_CALL_START_24__*/
  let ssaValue47930;
  let ssaValue47932 = ssaCallStack.length;
  let ssaFastPositional24 = ssaFastPathsOk && ssaCallSite24.fastPositional ? ssaCallSite24.fastPositional : null;
  let ssaFastPositionalInvoke24 = ssaFastPositional24 === null ? null : ssaFastPositional24.invoke;
  let ssaFastPositionalRawInvoke24 = ssaFastPositional24 === null ? null : ssaFastPositional24.rawInvoke;
  let ssaFastPositionalReceiver24 = ssaFastPositional24 === null ? null : ssaFastPositional24.receiverType;
  let ssaValue47933 = false;
  if ((ssaFastPositionalRawInvoke24 || ssaFastPositionalInvoke24) && true) {
    ssaValue47933 = true;
    try { ssaValue47930 = ssaFastPositionalRawInvoke24 ? ssaFastPositionalRawInvoke24(helpers, /*__JVM_CALL_ARG_24_0__*/ssaValue47926, /*__JVM_CALL_ARG_24_1__*/ssaValue47927, /*__JVM_CALL_ARG_24_2__*/ssaValue47928, /*__JVM_CALL_ARG_24_3__*/ssaValue47929, thread, true) : ssaFastPositionalInvoke24(ssaValue47926, ssaValue47927, ssaValue47928, ssaValue47929, thread, true); } catch (ssaValue47931) {
      /*__JVM_CALL_HANDLER_START_24__*/
      if (!ssaFastPositionalInvoke24.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue47932) {
        ssaMaterialize0(25);
      } else {
        /*__JVM_CALL_RESTORE_START_24__*/
        ssaMaterialize4(24, ssaValue47926, ssaValue47927, ssaValue47928, ssaValue47929);
        /*__JVM_CALL_RESTORE_END_24__*/
      }
      throw ssaValue47931;
      /*__JVM_CALL_HANDLER_END_24__*/
    }
  }
  if (!ssaValue47933 || ssaValue47930 === ssaAsyncInvoke) {
    if (frame === null) spillLocals();
    stack[0] = ssaValue47926;
    stack[1] = ssaValue47927;
    stack[2] = ssaValue47928;
    stack[3] = ssaValue47929;
    stack.length = 4;
    try { ssaValue47930 = helpers.tryInvokeSyncAt(10087, frame, thread); } catch (ssaValue47931) {
      if (true && ssaCallStack.length > ssaValue47932) {
        ssaMaterialize0(25);
      } else {
        ssaMaterialize4(24, ssaValue47926, ssaValue47927, ssaValue47928, ssaValue47929);
      }
      throw ssaValue47931;
    }
  }
  if (ssaValue47930 === ssaAsyncInvoke || (typeof ssaValue47930 === "object" && ssaValue47930 !== null && ssaValue47930.deopt) || ssaCallStack.length > ssaValue47932 || thread.status !== 'runnable') {
    const ssaValue47934 = helpers.structuredSsa.coldCallOrdinary(frame, thread, ssaValue47930, ssaValue47932, 10087, "void", 25, true, spillLocals, [ssaValue47926, ssaValue47927, ssaValue47928, ssaValue47929], 0);
    if (ssaValue47934 !== helpers.structuredSsa.coldContinue) {
      return ssaValue47934;
    }
  }
  /*__JVM_REGION_CALL_END_24__*/
  if (framelessEntry) {
    return ssaReturnVoid;
  }
  if (thread.callStack.peek() !== frame) {
    ssaMaterialize0(25);
    helpers.skipJitOnce(frame);
    return { deopt: true, transient: true, reason: 'structured SSA return with active child' };
  }
  spillLocals();
  stack.length = 0;
  frame.pc = 27;
  thread.callStack.pop();
  return { returned: true, value: ssaReturnVoid };
}
//# sourceURL=jvm-generated://ok/a(%5BIIIII%5BI%5BI)V?tier=structured-ssa
