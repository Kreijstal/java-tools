'use strict';

const { getPotentialExceptionsForInstruction } = require('./exceptionMetadata');

const INVOKE_OPS = new Set(['invokevirtual', 'invokespecial', 'invokestatic', 'invokeinterface']);

function makeMethodKey(className, methodName, descriptor) {
  return `${className}#${methodName}${descriptor}`;
}

function isInvokeInstruction(instruction) {
  return instruction && typeof instruction === 'object' && INVOKE_OPS.has(instruction.op);
}

function extractInvokeTarget(instruction) {
  if (!instruction || typeof instruction !== 'object') return null;
  if (!INVOKE_OPS.has(instruction.op)) return null;
  const arg = instruction.arg;
  if (!Array.isArray(arg) || arg.length < 3) {
    return null;
  }
  const owner = arg[1];
  const nameAndDesc = arg[2];
  if (!Array.isArray(nameAndDesc) || nameAndDesc.length < 2) {
    return null;
  }
  return {
    className: owner,
    methodName: nameAndDesc[0],
    descriptor: nameAndDesc[1],
  };
}

function isHarmlessStackOp(op) {
  if (!op) return false;
  if (op === 'nop') return true;
  if (/^(?:[ailfd]?load(?:_\d)?|[ailfd]?store(?:_\d)?|aload(?:_\d)?|astore(?:_\d)?)$/.test(op)) {
    return true;
  }
  if (/^(?:iconst_m1|iconst_[0-5]|lconst_[01]|fconst_[0-2]|dconst_[01])$/.test(op)) {
    return true;
  }
  if (/^(?:bipush|sipush|ldc(?:2?_w)?)$/.test(op)) {
    return true;
  }
  if (/^(?:dup(?:2)?(?:_x[12])?|dup2_x[12]|dup_x[12]|pop2?|swap)$/.test(op)) {
    return true;
  }
  if (/^(?:aconst_null|iinc)$/.test(op)) {
    return true;
  }
  return false;
}

function computeMethodEffects(astRoot) {
  const classes = (astRoot && astRoot.classes) || [];
  const methodInfos = new Map();

  function recordImpureReason(info, reason) {
    if (!info.impureReasons) {
      info.impureReasons = new Set();
    }
    info.impureReasons.add(reason);
  }

  function describeFieldArg(arg) {
    if (Array.isArray(arg) && arg.length >= 3) {
      const owner = arg[1];
      const nameDesc = arg[2];
      if (Array.isArray(nameDesc) && nameDesc.length >= 1) {
        return `${owner}.${nameDesc[0]}${nameDesc[1] || ''}`;
      }
    }
    return JSON.stringify(arg);
  }

  // First pass: register methods with declared exceptions
  classes.forEach((cls) => {
    const className = cls.className || 'UnknownClass';
    (cls.items || []).forEach((item) => {
      if (!item || item.type !== 'method' || !item.method) return;
      const method = item.method;
      const key = makeMethodKey(className, method.name, method.descriptor);
      if (methodInfos.has(key)) return;
      const info = {
        className,
        methodName: method.name,
        descriptor: method.descriptor,
        flags: method.flags || [],
        hasCode: false,
        implicitThrows: new Set(),
        callees: new Set(),
        throwsUnknown: false,
        hasSideEffects: false,
        pureCandidate: !method.flags || !(method.flags.includes('abstract') || method.flags.includes('native')),
        impureReasons: new Set(),
      };
      methodInfos.set(key, info);
    });
  });

  // Second pass: analyze code bodies
  classes.forEach((cls) => {
    const className = cls.className || 'UnknownClass';
    (cls.items || []).forEach((item) => {
      if (!item || item.type !== 'method' || !item.method) return;
      const method = item.method;
      const key = makeMethodKey(className, method.name, method.descriptor);
      const info = methodInfos.get(key);
      if (!info) return;
      const codeAttr = (method.attributes || []).find((attr) => attr && attr.type === 'code');
      if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) {
        return;
      }
      info.hasCode = true;
      (codeAttr.code.codeItems || []).forEach((item) => {
        if (!item || !item.instruction) return;
        let potential = getPotentialExceptionsForInstruction(item.instruction);
        if (potential && isInvokeInstruction(item.instruction)) {
          potential = potential.filter((exc) => exc !== 'java/lang/Throwable');
        }
        if (potential) {
          potential.forEach((exc) => info.implicitThrows.add(exc));
        }
        const callee = extractInvokeTarget(item.instruction);
        if (callee) {
          const calleeKey = makeMethodKey(callee.className, callee.methodName, callee.descriptor);
          info.callees.add(calleeKey);
          if (!methodInfos.has(calleeKey)) {
            info.throwsUnknown = true;
            info.hasSideEffects = true;
            recordImpureReason(
              info,
              `calls unresolved method ${callee.className}.${callee.methodName}${callee.descriptor}`,
            );
          }
        }
        if (!isInvokeInstruction(item.instruction) && !potential) {
          const op = typeof item.instruction === 'string' ? item.instruction : item.instruction.op;
          if (op) {
            let reason = null;
            if (op === 'putstatic' || op === 'putfield') {
              reason = `writes field ${describeFieldArg(item.instruction.arg)}`;
            } else if (op === 'getstatic') {
              reason = `reads static field ${describeFieldArg(item.instruction.arg)}`;
            } else if (!isHarmlessStackOp(op) && !/^return|[ildfa]return$/.test(op)) {
              reason = `executes effectful opcode ${op}`;
            }
            if (reason) {
              info.hasSideEffects = true;
              recordImpureReason(info, reason);
            }
          }
        }
      });
    });
  });

  // Initialize effect map
  const effects = new Map();
  methodInfos.forEach((info, key) => {
    const canBecomePure =
      info.hasCode && info.pureCandidate && !info.hasSideEffects && !info.throwsUnknown;
    effects.set(key, {
      className: info.className,
      methodName: info.methodName,
      descriptor: info.descriptor,
      flags: info.flags,
      hasCode: info.hasCode,
      throws: new Set(info.implicitThrows),
      throwsUnknown: info.throwsUnknown,
      pure: false,
      hasSideEffects: info.hasSideEffects,
      callees: info.callees,
      pureUnknown: canBecomePure,
      impureReasons: new Set(info.impureReasons || []),
    });
  });

  // Fixpoint propagate throws through call graph
  let changed = true;
  while (changed) {
    changed = false;
    effects.forEach((effect) => {
      if (!effect.throwsUnknown) {
        effect.callees.forEach((calleeKey) => {
          const callee = effects.get(calleeKey);
          if (!callee || callee.throwsUnknown) {
            if (!effect.throwsUnknown) {
              effect.throwsUnknown = true;
              if (!callee) {
                effect.impureReasons.add(`calls unresolved method ${calleeKey}`);
              } else {
                effect.impureReasons.add(
                  `calls ${callee.className}.${callee.methodName}${callee.descriptor}, which may throw`,
                );
              }
              changed = true;
            }
            return;
          }
          callee.throws.forEach((exc) => {
            if (!effect.throws.has(exc)) {
              effect.throws.add(exc);
              changed = true;
            }
          });
        });
      }

      if (!effect.pure && effect.pureUnknown) {
        let calleeImpure = false;
        effect.callees.forEach((calleeKey) => {
          const callee = effects.get(calleeKey);
          if (!callee || !callee.pure) {
            calleeImpure = true;
            if (callee && callee.impureReasons && callee.impureReasons.size) {
              callee.impureReasons.forEach((reason) => {
                effect.impureReasons.add(
                  `calls ${callee.className}.${callee.methodName}${callee.descriptor}: ${reason}`,
                );
              });
            } else {
              effect.impureReasons.add(`calls non-pure method ${calleeKey}`);
            }
          }
        });
        if (!effect.hasSideEffects && !effect.throwsUnknown && !calleeImpure) {
          effect.pure = true;
          effect.pureUnknown = false;
          changed = true;
        }
      }
    });
  }

  // Clean up to hide callees in final result
  effects.forEach((effect) => delete effect.callees);

  return effects;
}

module.exports = {
  computeMethodEffects,
  makeMethodKey,
  extractInvokeTarget,
  isInvokeInstruction,
};
