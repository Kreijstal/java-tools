'use strict';
var ssaCallStack = thread.callStack.items;
var locals = frame.locals;
var stack = frame.stack.items;
var ssaResumePc = !framelessEntry && frame.pc !== 0 && (frame.pc === 12) ? frame.pc : 0;
if ((!framelessEntry && frame.pc !== 0 && ssaResumePc === 0) || (initialBytecodeChecks === undefined ? helpers.needsBytecodeChecks() : initialBytecodeChecks)) { helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'structured SSA entry' }; }
var ssaClassInitializationGuard = ssaLinkClassGuard627;
if ((ssaClassInitializationGuard.classEpoch !== (helpers.jvm.classEpoch || 0) || ssaClassInitializationGuard.initializationEpoch !== (helpers.jvm.classInitializationEpoch || 0)) && !helpers.structuredSsa.verifyClassInitializationGuard(ssaClassInitializationGuard)) { helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'structured SSA static entry' }; }
var ssaFastPathsOk = !helpers.profileMethods && helpers.jvm.debugManager.jitDeoptedClassCount === 0;
var ssaCallSite67 = ssaLinkCallSite9915;
var ssaCallSite73 = ssaLinkCallSite9916;
var ssaCallSite81 = ssaLinkCallSite9917;
var ssaCallSite89 = ssaLinkCallSite9918;
var ssaCallSite148 = ssaLinkCallSite9919;
var ssaCallSite156 = ssaLinkCallSite9920;
if (((ssaLinkStaticCell6287.value ? 1 : 0) !== 0)) { helpers.structuredSsa.guardedBooleanFallbackCount += 1; helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'structured SSA static boolean guard' }; }

var safePointBudget = 64;
var local0 = ((Number(locals[0])) | 0);
var local1 = ((Number(locals[1])) | 0);
var local2 = ((Number(locals[2])) ? 1 : 0);
var local3 = ((Number(locals[3])) | 0);
var local4 = locals[4];
var local5 = locals[5];
var local6 = locals[6];
var local7 = locals[7];
var local8 = locals[8];
var local9 = locals[9];
var local10 = locals[10];
var local11 = locals[11];
var local12 = locals[12];
var local13 = locals[13];
var local14 = locals[14];
var local15 = locals[15];
var local16 = locals[16];
var local17 = locals[17];
if (ssaResumePc !== 0) {
  local0 = locals[0];
  local1 = locals[1];
  local2 = locals[2];
  local3 = locals[3];
  local4 = locals[4];
  local5 = locals[5];
  local6 = locals[6];
  local7 = locals[7];
  local8 = locals[8];
  local9 = locals[9];
  local10 = locals[10];
  local11 = locals[11];
  local12 = locals[12];
  local13 = locals[13];
  local14 = locals[14];
  local15 = locals[15];
  local16 = locals[16];
  local17 = locals[17];
}

var spillLocals = () => { locals[4] = local4; locals[5] = local5; locals[6] = local6; locals[7] = local7; locals[8] = local8; locals[9] = local9; locals[10] = local10; locals[11] = local11; locals[12] = local12; locals[13] = local13; locals[14] = local14; locals[15] = local15; locals[16] = local16; locals[17] = local17; };
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
switch (ssaResumePc) {
case 0:
  local17 = 0;
  var ssaValue46710 = local2;
case 12:
  if (ssaResumePc === 0 ? (ssaValue46710 === 1) : (ssaResumePc === 12)) {
    switch (ssaResumePc) {
    case 0:
      local4 = 320;
      local5 = 490;
      local6 = 0;
    case 12:
      if (ssaResumePc === 12) {
        ssaResumePc = 0;
      }
      L3: while (true) {
        if (--safePointBudget <= 0) {
          if (helpers.continueStructuredQuantum(thread)) { safePointBudget = 64; } else {
            spillLocals();
            stack.length = 0;
            helpers.materialize(frame, locals, stack, 12);
            helpers.structuredSsa.safePointCount += 1;
            safePointBudget = 64;
            yield { deopt: true, transient: true, reason: 'structured SSA continuation' };
          }
        }
        var ssaValue46711 = local6;
        var ssaValue46712 = (ssaValue46711 ^ -1);
        var ssaValue46713 = ssaLinkStaticCell6288.value;
        var ssaValue46714 = (ssaValue46713 == null ? null : ssaValue46713.elements ? ssaValue46713.elements : (Array.isArray(ssaValue46713) || ArrayBuffer.isView(ssaValue46713) ? ssaValue46713 : null));
        if (ssaValue46713 == null) {
          ssaMaterialize2(16, ssaValue46712, ssaValue46713);
          helpers.arrayLength(ssaValue46713, frame);
        }
        var ssaValue46715 = ssaValue46713.length;
        var ssaValue46716 = (ssaValue46715 ^ -1);
        if (ssaValue46712 <= ssaValue46716) {
          if (framelessEntry) {
            return ssaReturnVoid;
          }
          if (thread.callStack.peek() !== frame) {
            ssaMaterialize0(189);
            helpers.skipJitOnce(frame);
            return { deopt: true, transient: true, reason: 'structured SSA return with active child' };
          }
          spillLocals();
          stack.length = 0;
          frame.pc = 191;
          thread.callStack.pop();
          return { returned: true, value: ssaReturnVoid };
        } else {
          var ssaValue46717 = ssaLinkStaticCell6289.value;
          var ssaValue46718 = (ssaValue46717 == null ? null : ssaValue46717.elements ? ssaValue46717.elements : (Array.isArray(ssaValue46717) || ArrayBuffer.isView(ssaValue46717) ? ssaValue46717 : null));
          var ssaValue46719 = local6;
          var ssaValue46720;
          if (!false && (ssaValue46718 === null || (ssaValue46720 = ssaValue46718[ssaValue46719]) === undefined)) {
            ssaMaterialize2(22, ssaValue46717, ssaValue46719);
            ssaValue46720 = helpers.arrayLoad(ssaValue46719, ssaValue46717, frame, "iaload");
          } else {
            ssaValue46720 = false ? ((ssaValue46718[ssaValue46719]) | 0) : ((ssaValue46720) | 0);
          }
          var ssaValue46721 = (ssaValue46720 >> (1058191496 & 31));
          var ssaValue46722 = (ssaValue46721 & 255);
          local7 = ssaValue46722;
          var ssaValue46724;
          if (!false && (ssaValue46718 === null || (ssaValue46724 = ssaValue46718[ssaValue46719]) === undefined)) {
            ssaMaterialize3(31, 255, ssaValue46717, ssaValue46719);
            ssaValue46724 = helpers.arrayLoad(ssaValue46719, ssaValue46717, frame, "iaload");
          } else {
            ssaValue46724 = false ? ((ssaValue46718[ssaValue46719]) | 0) : ((ssaValue46724) | 0);
          }
          var ssaValue46725 = (ssaValue46724 >> (-496612168 & 31));
          var ssaValue46726 = (255 & ssaValue46725);
          local8 = ssaValue46726;
          var ssaValue46727 = Math.imul(2048, ssaValue46722);
          var ssaValue46728 = (ssaValue46727 >> (-208576440 & 31));
          var ssaValue46729 = ssaLinkStaticCell6291.value;
          var ssaValue46730 = ((1 + ssaValue46726) | 0);
          var ssaValue46731 = Math.imul(ssaValue46729, ssaValue46730);
          var ssaValue46732 = (ssaValue46731 >> (-1499643386 & 31));
          var ssaValue46733 = (-ssaValue46732) | 0;
          var ssaValue46734 = ((ssaValue46728 - ssaValue46733) | 0);
          local9 = ssaValue46734;
          var ssaValue46736;
          if (!false && (ssaValue46718 === null || (ssaValue46736 = ssaValue46718[ssaValue46719]) === undefined)) {
            ssaMaterialize2(53, ssaValue46717, ssaValue46719);
            ssaValue46736 = helpers.arrayLoad(ssaValue46719, ssaValue46717, frame, "iaload");
          } else {
            ssaValue46736 = false ? ((ssaValue46718[ssaValue46719]) | 0) : ((ssaValue46736) | 0);
          }
          var ssaValue46737 = (ssaValue46736 >> (-226715728 & 31));
          var ssaValue46738 = (ssaValue46737 & 255);
          local10 = ssaValue46738;
          var ssaValue46740;
          if (!false && (ssaValue46718 === null || (ssaValue46740 = ssaValue46718[ssaValue46719]) === undefined)) {
            ssaMaterialize3(62, 255, ssaValue46717, ssaValue46719);
            ssaValue46740 = helpers.arrayLoad(ssaValue46719, ssaValue46717, frame, "iaload");
          } else {
            ssaValue46740 = false ? ((ssaValue46718[ssaValue46719]) | 0) : ((ssaValue46740) | 0);
          }
          var ssaValue46741 = (255 & ssaValue46740);
          local11 = ssaValue46741;
          /*__JVM_REGION_CALL_START_67__*/
          var ssaValue46742;
          var ssaValue46744 = ssaCallStack.length;
          var ssaFastPositional67 = ssaFastPathsOk && ssaCallSite67.fastPositional ? ssaCallSite67.fastPositional : null;
          var ssaFastPositionalInvoke67 = ssaFastPositional67 === null ? null : ssaFastPositional67.invoke;
          var ssaFastPositionalRawInvoke67 = ssaFastPositional67 === null ? null : ssaFastPositional67.rawInvoke;
          var ssaFastPositionalReceiver67 = ssaFastPositional67 === null ? null : ssaFastPositional67.receiverType;
          var ssaValue46745 = false;
          if ((ssaFastPositionalRawInvoke67 || ssaFastPositionalInvoke67) && true) {
            ssaValue46745 = true;
            try { ssaValue46742 = ssaFastPositionalRawInvoke67 ? ssaFastPositionalRawInvoke67(helpers, /*__JVM_CALL_ARG_67_0__*/2047, /*__JVM_CALL_ARG_67_1__*/ssaValue46734, thread, true) : ssaFastPositionalInvoke67(2047, ssaValue46734, thread, true); } catch (ssaValue46743) {
              /*__JVM_CALL_HANDLER_START_67__*/
              if (!ssaFastPositionalInvoke67.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue46744) {
                ssaMaterialize0(68);
              } else {
                /*__JVM_CALL_RESTORE_START_67__*/
                ssaMaterialize2(67, 2047, ssaValue46734);
                /*__JVM_CALL_RESTORE_END_67__*/
              }
              throw ssaValue46743;
              /*__JVM_CALL_HANDLER_END_67__*/
            }
          }
          if (!ssaValue46745 || ssaValue46742 === ssaAsyncInvoke) {
            if (frame === null) spillLocals();
            stack[0] = 2047;
            stack[1] = ssaValue46734;
            stack.length = 2;
            try { ssaValue46742 = helpers.tryInvokeSyncAt(9915, frame, thread); } catch (ssaValue46743) {
              if (true && ssaCallStack.length > ssaValue46744) {
                ssaMaterialize0(68);
              } else {
                ssaMaterialize2(67, 2047, ssaValue46734);
              }
              throw ssaValue46743;
            }
          }
          if (ssaValue46742 === ssaAsyncInvoke || (typeof ssaValue46742 === "object" && ssaValue46742 !== null && ssaValue46742.deopt) || ssaCallStack.length > ssaValue46744 || thread.status !== 'runnable') {
            var ssaValue46746 = helpers.structuredSsa.coldCallContinuation(frame, thread, ssaValue46742, ssaValue46744, 9915, "int", 68, false, spillLocals, [2047, ssaValue46734], 0);
            var ssaValue46747 = ssaValue46746.next();
            while (!ssaValue46747.done) {
              yield ssaValue46747.value;
              ssaValue46747 = ssaValue46746.next();
            }
            ssaValue46742 = ssaValue46747.value;
            if (ssaValue46742 === helpers.structuredSsa.coldExit) {
              return helpers.structuredSsa.coldExitValue;
            }
          }
          /*__JVM_REGION_CALL_END_67__*/
          var ssaValue46748 = (ssaValue46742 >> (-200783770 & 31));
          local12 = ssaValue46748;
          /*__JVM_REGION_CALL_START_73__*/
          var ssaValue46749;
          var ssaValue46751 = ssaCallStack.length;
          var ssaFastPositional73 = ssaFastPathsOk && ssaCallSite73.fastPositional ? ssaCallSite73.fastPositional : null;
          var ssaFastPositionalInvoke73 = ssaFastPositional73 === null ? null : ssaFastPositional73.invoke;
          var ssaFastPositionalRawInvoke73 = ssaFastPositional73 === null ? null : ssaFastPositional73.rawInvoke;
          var ssaFastPositionalReceiver73 = ssaFastPositional73 === null ? null : ssaFastPositional73.receiverType;
          var ssaValue46752 = false;
          if ((ssaFastPositionalRawInvoke73 || ssaFastPositionalInvoke73) && true) {
            ssaValue46752 = true;
            try { ssaValue46749 = ssaFastPositionalRawInvoke73 ? ssaFastPositionalRawInvoke73(helpers, /*__JVM_CALL_ARG_73_0__*/ssaValue46734, /*__JVM_CALL_ARG_73_1__*/-122, thread, true) : ssaFastPositionalInvoke73(ssaValue46734, -122, thread, true); } catch (ssaValue46750) {
              /*__JVM_CALL_HANDLER_START_73__*/
              if (!ssaFastPositionalInvoke73.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue46751) {
                ssaMaterialize0(74);
              } else {
                /*__JVM_CALL_RESTORE_START_73__*/
                ssaMaterialize2(73, ssaValue46734, -122);
                /*__JVM_CALL_RESTORE_END_73__*/
              }
              throw ssaValue46750;
              /*__JVM_CALL_HANDLER_END_73__*/
            }
          }
          if (!ssaValue46752 || ssaValue46749 === ssaAsyncInvoke) {
            if (frame === null) spillLocals();
            stack[0] = ssaValue46734;
            stack[1] = -122;
            stack.length = 2;
            try { ssaValue46749 = helpers.tryInvokeSyncAt(9916, frame, thread); } catch (ssaValue46750) {
              if (true && ssaCallStack.length > ssaValue46751) {
                ssaMaterialize0(74);
              } else {
                ssaMaterialize2(73, ssaValue46734, -122);
              }
              throw ssaValue46750;
            }
          }
          if (ssaValue46749 === ssaAsyncInvoke || (typeof ssaValue46749 === "object" && ssaValue46749 !== null && ssaValue46749.deopt) || ssaCallStack.length > ssaValue46751 || thread.status !== 'runnable') {
            var ssaValue46753 = helpers.structuredSsa.coldCallContinuation(frame, thread, ssaValue46749, ssaValue46751, 9916, "int", 74, false, spillLocals, [ssaValue46734, -122], 0);
            var ssaValue46754 = ssaValue46753.next();
            while (!ssaValue46754.done) {
              yield ssaValue46754.value;
              ssaValue46754 = ssaValue46753.next();
            }
            ssaValue46749 = ssaValue46754.value;
            if (ssaValue46749 === helpers.structuredSsa.coldExit) {
              return helpers.structuredSsa.coldExitValue;
            }
          }
          /*__JVM_REGION_CALL_END_73__*/
          var ssaValue46755 = (ssaValue46749 >> (-1071707034 & 31));
          local13 = ssaValue46755;
          var ssaValue46756 = ((ssaValue46741 + ssaValue46734) | 0);
          /*__JVM_REGION_CALL_START_81__*/
          var ssaValue46757;
          var ssaValue46759 = ssaCallStack.length;
          var ssaFastPositional81 = ssaFastPathsOk && ssaCallSite81.fastPositional ? ssaCallSite81.fastPositional : null;
          var ssaFastPositionalInvoke81 = ssaFastPositional81 === null ? null : ssaFastPositional81.invoke;
          var ssaFastPositionalRawInvoke81 = ssaFastPositional81 === null ? null : ssaFastPositional81.rawInvoke;
          var ssaFastPositionalReceiver81 = ssaFastPositional81 === null ? null : ssaFastPositional81.receiverType;
          var ssaValue46760 = false;
          if ((ssaFastPositionalRawInvoke81 || ssaFastPositionalInvoke81) && true) {
            ssaValue46760 = true;
            try { ssaValue46757 = ssaFastPositionalRawInvoke81 ? ssaFastPositionalRawInvoke81(helpers, /*__JVM_CALL_ARG_81_0__*/2047, /*__JVM_CALL_ARG_81_1__*/ssaValue46756, thread, true) : ssaFastPositionalInvoke81(2047, ssaValue46756, thread, true); } catch (ssaValue46758) {
              /*__JVM_CALL_HANDLER_START_81__*/
              if (!ssaFastPositionalInvoke81.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue46759) {
                ssaMaterialize0(82);
              } else {
                /*__JVM_CALL_RESTORE_START_81__*/
                ssaMaterialize2(81, 2047, ssaValue46756);
                /*__JVM_CALL_RESTORE_END_81__*/
              }
              throw ssaValue46758;
              /*__JVM_CALL_HANDLER_END_81__*/
            }
          }
          if (!ssaValue46760 || ssaValue46757 === ssaAsyncInvoke) {
            if (frame === null) spillLocals();
            stack[0] = 2047;
            stack[1] = ssaValue46756;
            stack.length = 2;
            try { ssaValue46757 = helpers.tryInvokeSyncAt(9917, frame, thread); } catch (ssaValue46758) {
              if (true && ssaCallStack.length > ssaValue46759) {
                ssaMaterialize0(82);
              } else {
                ssaMaterialize2(81, 2047, ssaValue46756);
              }
              throw ssaValue46758;
            }
          }
          if (ssaValue46757 === ssaAsyncInvoke || (typeof ssaValue46757 === "object" && ssaValue46757 !== null && ssaValue46757.deopt) || ssaCallStack.length > ssaValue46759 || thread.status !== 'runnable') {
            var ssaValue46761 = helpers.structuredSsa.coldCallContinuation(frame, thread, ssaValue46757, ssaValue46759, 9917, "int", 82, false, spillLocals, [2047, ssaValue46756], 0);
            var ssaValue46762 = ssaValue46761.next();
            while (!ssaValue46762.done) {
              yield ssaValue46762.value;
              ssaValue46762 = ssaValue46761.next();
            }
            ssaValue46757 = ssaValue46762.value;
            if (ssaValue46757 === helpers.structuredSsa.coldExit) {
              return helpers.structuredSsa.coldExitValue;
            }
          }
          /*__JVM_REGION_CALL_END_81__*/
          var ssaValue46763 = (ssaValue46757 >> (-1246657338 & 31));
          local14 = ssaValue46763;
          var ssaValue46764 = ((ssaValue46734 + ssaValue46741) | 0);
          /*__JVM_REGION_CALL_START_89__*/
          var ssaValue46765;
          var ssaValue46767 = ssaCallStack.length;
          var ssaFastPositional89 = ssaFastPathsOk && ssaCallSite89.fastPositional ? ssaCallSite89.fastPositional : null;
          var ssaFastPositionalInvoke89 = ssaFastPositional89 === null ? null : ssaFastPositional89.invoke;
          var ssaFastPositionalRawInvoke89 = ssaFastPositional89 === null ? null : ssaFastPositional89.rawInvoke;
          var ssaFastPositionalReceiver89 = ssaFastPositional89 === null ? null : ssaFastPositional89.receiverType;
          var ssaValue46768 = false;
          if ((ssaFastPositionalRawInvoke89 || ssaFastPositionalInvoke89) && true) {
            ssaValue46768 = true;
            try { ssaValue46765 = ssaFastPositionalRawInvoke89 ? ssaFastPositionalRawInvoke89(helpers, /*__JVM_CALL_ARG_89_0__*/ssaValue46764, /*__JVM_CALL_ARG_89_1__*/-122, thread, true) : ssaFastPositionalInvoke89(ssaValue46764, -122, thread, true); } catch (ssaValue46766) {
              /*__JVM_CALL_HANDLER_START_89__*/
              if (!ssaFastPositionalInvoke89.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue46767) {
                ssaMaterialize0(90);
              } else {
                /*__JVM_CALL_RESTORE_START_89__*/
                ssaMaterialize2(89, ssaValue46764, -122);
                /*__JVM_CALL_RESTORE_END_89__*/
              }
              throw ssaValue46766;
              /*__JVM_CALL_HANDLER_END_89__*/
            }
          }
          if (!ssaValue46768 || ssaValue46765 === ssaAsyncInvoke) {
            if (frame === null) spillLocals();
            stack[0] = ssaValue46764;
            stack[1] = -122;
            stack.length = 2;
            try { ssaValue46765 = helpers.tryInvokeSyncAt(9918, frame, thread); } catch (ssaValue46766) {
              if (true && ssaCallStack.length > ssaValue46767) {
                ssaMaterialize0(90);
              } else {
                ssaMaterialize2(89, ssaValue46764, -122);
              }
              throw ssaValue46766;
            }
          }
          if (ssaValue46765 === ssaAsyncInvoke || (typeof ssaValue46765 === "object" && ssaValue46765 !== null && ssaValue46765.deopt) || ssaCallStack.length > ssaValue46767 || thread.status !== 'runnable') {
            var ssaValue46769 = helpers.structuredSsa.coldCallContinuation(frame, thread, ssaValue46765, ssaValue46767, 9918, "int", 90, false, spillLocals, [ssaValue46764, -122], 0);
            var ssaValue46770 = ssaValue46769.next();
            while (!ssaValue46770.done) {
              yield ssaValue46770.value;
              ssaValue46770 = ssaValue46769.next();
            }
            ssaValue46765 = ssaValue46770.value;
            if (ssaValue46765 === helpers.structuredSsa.coldExit) {
              return helpers.structuredSsa.coldExitValue;
            }
          }
          /*__JVM_REGION_CALL_END_89__*/
          var ssaValue46771 = (ssaValue46765 >> (-1683979834 & 31));
          local15 = ssaValue46771;
          var ssaValue46772 = 6;
          var ssaValue46773;
          try { ssaValue46773 = helpers.newPrimitiveArray(ssaValue46772, "int"); } catch (ssaValue46774) {
            ssaMaterialize1(94, ssaValue46772);
            throw ssaValue46774;
          }
          var ssaValue46775 = local3;
          var ssaValue46776 = ((320 + ssaValue46775) | 0);
          var ssaValue46777 = 0;
          if (ssaValue46773 == null || ((ssaValue46777 >>> 0) >= ssaValue46773.length)) {
            ssaMaterialize4(100, ssaValue46773, ssaValue46773, ssaValue46777, ssaValue46776);
            helpers.arrayStore(ssaValue46776, ssaValue46777, ssaValue46773, frame, "iastore");
          } else if (ssaValue46773.elements) {
            ssaValue46773.elements[ssaValue46777] = ((ssaValue46776) | 0);
          } else {
            ssaValue46773[ssaValue46777] = ((ssaValue46776) | 0);
          }
          var ssaValue46778 = local0;
          var ssaValue46779 = (-490) | 0;
          var ssaValue46780 = ((ssaValue46778 - ssaValue46779) | 0);
          var ssaValue46781 = 1;
          if (ssaValue46773 == null || ((ssaValue46781 >>> 0) >= ssaValue46773.length)) {
            ssaMaterialize4(107, ssaValue46773, ssaValue46773, ssaValue46781, ssaValue46780);
            helpers.arrayStore(ssaValue46780, ssaValue46781, ssaValue46773, frame, "iastore");
          } else if (ssaValue46773.elements) {
            ssaValue46773.elements[ssaValue46781] = ((ssaValue46780) | 0);
          } else {
            ssaValue46773[ssaValue46781] = ((ssaValue46780) | 0);
          }
          var ssaValue46782 = ((ssaValue46748 + ssaValue46775) | 0);
          var ssaValue46783 = 2;
          if (ssaValue46773 == null || ((ssaValue46783 >>> 0) >= ssaValue46773.length)) {
            ssaMaterialize4(113, ssaValue46773, ssaValue46773, ssaValue46783, ssaValue46782);
            helpers.arrayStore(ssaValue46782, ssaValue46783, ssaValue46773, frame, "iastore");
          } else if (ssaValue46773.elements) {
            ssaValue46773.elements[ssaValue46783] = ((ssaValue46782) | 0);
          } else {
            ssaValue46773[ssaValue46783] = ((ssaValue46782) | 0);
          }
          var ssaValue46784 = ((ssaValue46778 + ssaValue46755) | 0);
          var ssaValue46785 = 3;
          if (ssaValue46773 == null || ((ssaValue46785 >>> 0) >= ssaValue46773.length)) {
            ssaMaterialize4(119, ssaValue46773, ssaValue46773, ssaValue46785, ssaValue46784);
            helpers.arrayStore(ssaValue46784, ssaValue46785, ssaValue46773, frame, "iastore");
          } else if (ssaValue46773.elements) {
            ssaValue46773.elements[ssaValue46785] = ((ssaValue46784) | 0);
          } else {
            ssaValue46773[ssaValue46785] = ((ssaValue46784) | 0);
          }
          var ssaValue46786 = (-ssaValue46763) | 0;
          var ssaValue46787 = ((ssaValue46775 - ssaValue46786) | 0);
          var ssaValue46788 = 4;
          if (ssaValue46773 == null || ((ssaValue46788 >>> 0) >= ssaValue46773.length)) {
            ssaMaterialize4(126, ssaValue46773, ssaValue46773, ssaValue46788, ssaValue46787);
            helpers.arrayStore(ssaValue46787, ssaValue46788, ssaValue46773, frame, "iastore");
          } else if (ssaValue46773.elements) {
            ssaValue46773.elements[ssaValue46788] = ((ssaValue46787) | 0);
          } else {
            ssaValue46773[ssaValue46788] = ((ssaValue46787) | 0);
          }
          var ssaValue46789 = ((ssaValue46771 + ssaValue46778) | 0);
          var ssaValue46790 = 5;
          if (ssaValue46773 == null || ((ssaValue46790 >>> 0) >= ssaValue46773.length)) {
            ssaMaterialize4(132, ssaValue46773, ssaValue46773, ssaValue46790, ssaValue46789);
            helpers.arrayStore(ssaValue46789, ssaValue46790, ssaValue46773, frame, "iastore");
          } else if (ssaValue46773.elements) {
            ssaValue46773.elements[ssaValue46790] = ((ssaValue46789) | 0);
          } else {
            ssaValue46773[ssaValue46790] = ((ssaValue46789) | 0);
          }
          local16 = ssaValue46773;
          var ssaValue46791 = local1;
          if (256 === ssaValue46791) {
            var ssaValue46802 = local16;
            var ssaValue46803 = local10;
            /*__JVM_REGION_CALL_START_156__*/
            var ssaValue46804;
            var ssaValue46806 = ssaCallStack.length;
            var ssaFastPositional156 = ssaFastPathsOk && ssaCallSite156.fastPositional ? ssaCallSite156.fastPositional : null;
            var ssaFastPositionalInvoke156 = ssaFastPositional156 === null ? null : ssaFastPositional156.invoke;
            var ssaFastPositionalRawInvoke156 = ssaFastPositional156 === null ? null : ssaFastPositional156.rawInvoke;
            var ssaFastPositionalReceiver156 = ssaFastPositional156 === null ? null : ssaFastPositional156.receiverType;
            var ssaValue46807 = false;
            if ((ssaFastPositionalRawInvoke156 || ssaFastPositionalInvoke156) && true) {
              ssaValue46807 = true;
              try { ssaValue46804 = ssaFastPositionalRawInvoke156 ? ssaFastPositionalRawInvoke156(helpers, /*__JVM_CALL_ARG_156_0__*/ssaValue46802, /*__JVM_CALL_ARG_156_1__*/16777215, /*__JVM_CALL_ARG_156_2__*/ssaValue46803, thread, true) : ssaFastPositionalInvoke156(ssaValue46802, 16777215, ssaValue46803, thread, true); } catch (ssaValue46805) {
                /*__JVM_CALL_HANDLER_START_156__*/
                if (!ssaFastPositionalInvoke156.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue46806) {
                  ssaMaterialize0(157);
                } else {
                  /*__JVM_CALL_RESTORE_START_156__*/
                  ssaMaterialize3(156, ssaValue46802, 16777215, ssaValue46803);
                  /*__JVM_CALL_RESTORE_END_156__*/
                }
                throw ssaValue46805;
                /*__JVM_CALL_HANDLER_END_156__*/
              }
            }
            if (!ssaValue46807 || ssaValue46804 === ssaAsyncInvoke) {
              if (frame === null) spillLocals();
              stack[0] = ssaValue46802;
              stack[1] = 16777215;
              stack[2] = ssaValue46803;
              stack.length = 3;
              try { ssaValue46804 = helpers.tryInvokeSyncAt(9920, frame, thread); } catch (ssaValue46805) {
                if (true && ssaCallStack.length > ssaValue46806) {
                  ssaMaterialize0(157);
                } else {
                  ssaMaterialize3(156, ssaValue46802, 16777215, ssaValue46803);
                }
                throw ssaValue46805;
              }
            }
            if (ssaValue46804 === ssaAsyncInvoke || (typeof ssaValue46804 === "object" && ssaValue46804 !== null && ssaValue46804.deopt) || ssaCallStack.length > ssaValue46806 || thread.status !== 'runnable') {
              var ssaValue46808 = helpers.structuredSsa.coldCallContinuation(frame, thread, ssaValue46804, ssaValue46806, 9920, "void", 157, true, spillLocals, [ssaValue46802, 16777215, ssaValue46803], 0);
              var ssaValue46809 = ssaValue46808.next();
              while (!ssaValue46809.done) {
                yield ssaValue46809.value;
                ssaValue46809 = ssaValue46808.next();
              }
              ssaValue46804 = ssaValue46809.value;
              if (ssaValue46804 === helpers.structuredSsa.coldExit) {
                return helpers.structuredSsa.coldExitValue;
              }
            }
            /*__JVM_REGION_CALL_END_156__*/
          } else {
            var ssaValue46792 = local16;
            var ssaValue46793 = local10;
            var ssaValue46794 = Math.imul(ssaValue46793, 256);
            var ssaValue46795 = (ssaValue46794 >> (431644137 & 31));
            /*__JVM_REGION_CALL_START_148__*/
            var ssaValue46796;
            var ssaValue46798 = ssaCallStack.length;
            var ssaFastPositional148 = ssaFastPathsOk && ssaCallSite148.fastPositional ? ssaCallSite148.fastPositional : null;
            var ssaFastPositionalInvoke148 = ssaFastPositional148 === null ? null : ssaFastPositional148.invoke;
            var ssaFastPositionalRawInvoke148 = ssaFastPositional148 === null ? null : ssaFastPositional148.rawInvoke;
            var ssaFastPositionalReceiver148 = ssaFastPositional148 === null ? null : ssaFastPositional148.receiverType;
            var ssaValue46799 = false;
            if ((ssaFastPositionalRawInvoke148 || ssaFastPositionalInvoke148) && true) {
              ssaValue46799 = true;
              try { ssaValue46796 = ssaFastPositionalRawInvoke148 ? ssaFastPositionalRawInvoke148(helpers, /*__JVM_CALL_ARG_148_0__*/ssaValue46792, /*__JVM_CALL_ARG_148_1__*/16777215, /*__JVM_CALL_ARG_148_2__*/ssaValue46795, thread, true) : ssaFastPositionalInvoke148(ssaValue46792, 16777215, ssaValue46795, thread, true); } catch (ssaValue46797) {
                /*__JVM_CALL_HANDLER_START_148__*/
                if (!ssaFastPositionalInvoke148.jvmRestoresExceptionFrames && ssaCallStack.length > ssaValue46798) {
                  ssaMaterialize0(149);
                } else {
                  /*__JVM_CALL_RESTORE_START_148__*/
                  ssaMaterialize3(148, ssaValue46792, 16777215, ssaValue46795);
                  /*__JVM_CALL_RESTORE_END_148__*/
                }
                throw ssaValue46797;
                /*__JVM_CALL_HANDLER_END_148__*/
              }
            }
            if (!ssaValue46799 || ssaValue46796 === ssaAsyncInvoke) {
              if (frame === null) spillLocals();
              stack[0] = ssaValue46792;
              stack[1] = 16777215;
              stack[2] = ssaValue46795;
              stack.length = 3;
              try { ssaValue46796 = helpers.tryInvokeSyncAt(9919, frame, thread); } catch (ssaValue46797) {
                if (true && ssaCallStack.length > ssaValue46798) {
                  ssaMaterialize0(149);
                } else {
                  ssaMaterialize3(148, ssaValue46792, 16777215, ssaValue46795);
                }
                throw ssaValue46797;
              }
            }
            if (ssaValue46796 === ssaAsyncInvoke || (typeof ssaValue46796 === "object" && ssaValue46796 !== null && ssaValue46796.deopt) || ssaCallStack.length > ssaValue46798 || thread.status !== 'runnable') {
              var ssaValue46800 = helpers.structuredSsa.coldCallContinuation(frame, thread, ssaValue46796, ssaValue46798, 9919, "void", 149, true, spillLocals, [ssaValue46792, 16777215, ssaValue46795], 0);
              var ssaValue46801 = ssaValue46800.next();
              while (!ssaValue46801.done) {
                yield ssaValue46801.value;
                ssaValue46801 = ssaValue46800.next();
              }
              ssaValue46796 = ssaValue46801.value;
              if (ssaValue46796 === helpers.structuredSsa.coldExit) {
                return helpers.structuredSsa.coldExitValue;
              }
            }
            /*__JVM_REGION_CALL_END_148__*/
          }
          var ssaValue46810 = local6;
          var ssaValue46811 = (ssaValue46810 + 1) | 0;
          local6 = ssaValue46811;
          continue L3;
        }
      }
    }
  } else {
    if (framelessEntry) {
      return ssaReturnVoid;
    }
    if (thread.callStack.peek() !== frame) {
      ssaMaterialize0(5);
      helpers.skipJitOnce(frame);
      return { deopt: true, transient: true, reason: 'structured SSA return with active child' };
    }
    spillLocals();
    stack.length = 0;
    frame.pc = 191;
    thread.callStack.pop();
    return { returned: true, value: ssaReturnVoid };
  }
}
//# sourceURL=jvm-generated://fh/a(IIZI)V?tier=structured-ssa
