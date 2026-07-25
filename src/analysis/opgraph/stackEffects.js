'use strict';

// Shared per-opcode stack-effect knowledge for the opgraph analyses and the
// SSA builder. Slot arithmetic (pop/push counts, dup/swap specials) lives in
// utils/instructionUtils.getStackEffect; this module re-exports it as the
// shared home and adds the kind layer (I/J/F/D/A per pushed value) that SSA
// construction needs and plain depth verification does not.

const {
  getStackEffect,
  normalizeInstruction,
  parseLocalOperation,
} = require('../../utils/instructionUtils');
const {
  kindFromDescriptor,
  returnKindFromMethodDescriptor,
} = require('./ssaTypes');

const LETTER_KIND = { i: 'I', l: 'J', f: 'F', d: 'D', a: 'A' };
const ARRAY_LOAD_KIND = {
  iaload: 'I', baload: 'I', caload: 'I', saload: 'I',
  laload: 'J', faload: 'F', daload: 'D', aaload: 'A',
};
const BINARY_NUMERIC = /^([ilfd])(add|sub|mul|div|rem|and|or|xor|shl|shr|ushr)$/;
const CONVERSION = /^([ilfd])2([ilfdbcs])$/;
// Ops whose JVM semantics can raise (coarse; used to pin values across
// exception-observable points, not to prove absence of throws).
const MAY_THROW = /^(invoke|get|put|.aload|.astore|arraylength|athrow|checkcast|monitor|new|idiv|irem|ldiv|lrem|multianewarray)/;

function memberDescriptor(instruction) {
  const arg = instruction && instruction.arg;
  if (!Array.isArray(arg)) return null;
  const nameDesc = arg[2];
  return Array.isArray(nameDesc) ? nameDesc[1] : null;
}

function ldcKind(op, arg) {
  if (op === 'ldc2_w') {
    if (typeof arg === 'bigint') return 'J';
    if (typeof arg === 'number') return 'D';
    if (arg && typeof arg === 'object') {
      if (arg.type === 'Long') return 'J';
      if (arg.type === 'Double') return 'D';
    }
    if (typeof arg === 'string') {
      // Krakatau may leave the literal textual: integers are longs, the rest
      // (decimal/exponent forms) are doubles.
      return /^[+-]?\d+L?$/.test(arg.replace(/^["']|["']$/g, '')) ? 'J' : 'D';
    }
    return null;
  }
  if (typeof arg === 'number') return 'I';
  if (typeof arg === 'string') return 'A';
  if (Array.isArray(arg) && arg[0] === 'Class') return 'A';
  if (arg && typeof arg === 'object') {
    if (arg.type === 'Integer') return 'I';
    if (arg.type === 'Float') return 'F';
    if (arg.type === 'String' || arg.type === 'Class') return 'A';
  }
  return null;
}

// Kinds of the values an instruction pushes, outermost last (stack order).
// Returns null when the kind cannot be determined — callers must treat that
// as unsupported. Special (dup/swap) ops return null too: their outputs are
// copies of inputs and take their kinds from the live stack.
function pushKinds(op, instruction) {
  const effect = getStackEffect(op, instruction);
  if (!effect || effect.special) return null;
  if (!effect.pushSlots) return [];

  if (op === 'aconst_null' || op === 'new' || op === 'newarray'
    || op === 'anewarray' || op === 'multianewarray' || op === 'checkcast') return ['A'];
  if (op === 'instanceof' || op === 'arraylength'
    || op === 'lcmp' || op === 'fcmpl' || op === 'fcmpg'
    || op === 'dcmpl' || op === 'dcmpg') return ['I'];
  if (op === 'bipush' || op === 'sipush') return ['I'];
  if (op === 'ldc' || op === 'ldc_w' || op === 'ldc2_w') {
    const kind = ldcKind(op, instruction && instruction.arg);
    return kind ? [kind] : null;
  }
  if (ARRAY_LOAD_KIND[op]) return [ARRAY_LOAD_KIND[op]];

  const first = op[0];
  if (/^[ilfda](load|const)(_|$)/.test(op)) return [LETTER_KIND[first]];
  if (/^[ilfd]neg$/.test(op)) return [LETTER_KIND[first]];
  const binary = BINARY_NUMERIC.exec(op);
  if (binary) return [LETTER_KIND[binary[1]]];
  const conversion = CONVERSION.exec(op);
  if (conversion) return [LETTER_KIND[conversion[2]] || 'I'];

  if (op === 'getstatic' || op === 'getfield') {
    const kind = kindFromDescriptor(memberDescriptor(instruction));
    return kind && kind !== 'V' ? [kind] : null;
  }
  if (op.startsWith('invoke')) {
    const descriptor = op === 'invokedynamic'
      ? instruction && instruction.arg && instruction.arg.nameAndType
        && instruction.arg.nameAndType.descriptor
      : memberDescriptor(instruction);
    const kind = returnKindFromMethodDescriptor(descriptor);
    if (kind === 'V') return [];
    return kind ? [kind] : null;
  }
  return null;
}

function mayThrowOp(op) {
  return typeof op === 'string' && MAY_THROW.test(op);
}

// Full kinded effect: instructionUtils' slot effect plus push kinds and a
// coarse mayThrow flag. Returns null for unsupported/unkindable ops (jsr and
// friends included — getStackEffect knows jsr's slots but SSA rejects
// subroutines, so kinding stops there).
function kindedStackEffect(op, instruction = null) {
  if (op === 'jsr' || op === 'jsr_w' || op === 'ret') return null;
  const effect = getStackEffect(op, instruction);
  if (!effect) return null;
  if (effect.special) {
    return { ...effect, pushKinds: null, mayThrow: false };
  }
  const kinds = pushKinds(op, instruction);
  if (kinds === null && effect.pushSlots > 0) return null;
  return { ...effect, pushKinds: kinds || [], mayThrow: mayThrowOp(op) };
}

module.exports = {
  getStackEffect,
  normalizeInstruction,
  parseLocalOperation,
  kindedStackEffect,
  pushKinds,
  mayThrowOp,
};
