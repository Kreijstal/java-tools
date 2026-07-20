const constants = require('./constants');
const loads = require('./loads');
const stores = require('./stores');
const stack = require('./stack');
const math = require('./math');
const control = require('./control');
const invoke = require('./invoke');
const object = require('./object');
const conversions = require('./conversions');

const instructions = {
  ...constants,
  ...loads,
  ...stores,
  ...stack,
  ...math,
  ...control,
  ...invoke,
  ...object,
  ...conversions,
};
// Babel lowers async functions to ordinary functions that return Promises.
// Classify the bytecodes explicitly so production browser bundles never send
// a lowered async handler through the synchronous burst dispatcher.
const asyncInstructionOps = new Set([
  'ldc',
  'ldc_w',
  'new',
  'getstatic',
  'putstatic',
  'instanceof',
  'checkcast',
  'invokevirtual',
  'invokestatic',
  'invokespecial',
  'invokedynamic',
  'invokeinterface',
]);
const syncInstructions = Object.fromEntries(Object.entries(instructions)
  .filter(([op, func]) => !asyncInstructionOps.has(op) &&
    func.constructor.name !== 'AsyncFunction'));
const syncCodePrepared = Symbol('syncCodePrepared');
const syncHandler = Symbol('syncHandler');
const syncInstruction = Symbol('syncInstruction');

function expandWideInstruction(instruction) {
  const parts = String(instruction && instruction.arg ? instruction.arg : '').trim().split(/\s+/).filter(Boolean);
  const baseOp = parts[0];
  if (!baseOp) return null;
  if (baseOp === 'iinc') {
    return {
      op: 'iinc',
      varnum: parts[1],
      incr: parts[2],
    };
  }
  return {
    op: baseOp,
    arg: parts[1],
  };
}

// Resolve opcode handlers once for each method body. Code items are shared by
// every Frame for that method, so this removes the string lookup and `wide`
// decoding from the interpreter's hottest loop without increasing per-frame
// memory. Symbol properties stay out of AST serialization and debugger views.
function prepareSyncInstructions(codeItems) {
  if (!codeItems || codeItems[syncCodePrepared]) return;

  for (const item of codeItems) {
    if (!item) continue;
    const instruction = item && item.instruction;
    const op = typeof instruction === 'string' ? instruction : instruction && instruction.op;
    const expanded = op === 'wide' ? expandWideInstruction(instruction) : instruction;
    const expandedOp = op === 'wide' && expanded ? expanded.op : op;
    Object.defineProperties(item, {
      [syncHandler]: {
        configurable: false,
        enumerable: false,
        value: expandedOp ? syncInstructions[expandedOp] || null : null,
      },
      [syncInstruction]: {
        configurable: false,
        enumerable: false,
        value: expanded,
      },
    });
  }

  Object.defineProperty(codeItems, syncCodePrepared, {
    configurable: false,
    enumerable: false,
    value: true,
  });
}

function dispatch(frame, instruction, jvm, thread) {
  if (jvm.verbose) {
    const threadId = thread ? thread.id : 'main';
    let pc = -1;
    if (frame.pc < frame.instructions.length) {
      const instructionItem = frame.instructions[frame.pc - 1];
      if (instructionItem) {
        const label = instructionItem.labelDef;
        pc = label ? parseInt(label.substring(1, label.length - 1)) : -1;
      }
    }
    const threadStates = jvm.threads.map(t => t.status.slice(0, 1).toUpperCase()).join('');
    const stackSize = frame.stack.size();
    const threadStatus = jvm.threads.map((t, i) => `  Thread ${i}: ${t.status}`).join('\n');

    const className = jvm.findClassNameForMethod(frame.method);
    console.log(`[${threadStates}] [thread:${threadId}, pc:${className}.${frame.method.name} ${pc}, stack:${stackSize}]`, instruction);
  }
  const op = typeof instruction === 'string' ? instruction : instruction.op;

  if (op === 'wide') {
    const expanded = expandWideInstruction(instruction);
    const wideFunc = expanded && instructions[expanded.op];
    if (!wideFunc) {
      throw new Error(`Unknown or unimplemented wide instruction: ${instruction.arg}`);
    }
    return wideFunc(frame, expanded, jvm, thread);
  }

  const func = instructions[op];
  if (func) {
    return func(frame, instruction, jvm, thread);
  } else {
    throw new Error(`Unknown or unimplemented instruction: ${op}`);
  }
}

// Fast path used by the interpreter's bounded execution quantum. Most JVM
// bytecodes are implemented by ordinary synchronous handlers; routing each
// one through an async dispatcher creates two Promises per instruction even
// though no suspension is possible. Async handlers (class loading, invokes,
// allocation, casts, and class literals) deliberately remain on dispatch().
function dispatchSync(frame, instruction, jvm, thread) {
  if (jvm.verbose) return false;
  const op = typeof instruction === 'string' ? instruction : instruction.op;
  const expanded = op === 'wide' ? expandWideInstruction(instruction) : instruction;
  const expandedOp = op === 'wide' && expanded ? expanded.op : op;
  const func = expandedOp && syncInstructions[expandedOp];
  if (!func) return false;
  const result = func(frame, expanded, jvm, thread);
  if (result && typeof result.then === 'function') {
    throw new Error(`Synchronous instruction handler returned a Promise: ${expandedOp}`);
  }
  return true;
}

module.exports = dispatch;
module.exports.dispatchSync = dispatchSync;
module.exports.prepareSyncInstructions = prepareSyncInstructions;
module.exports.syncHandler = syncHandler;
module.exports.syncInstruction = syncInstruction;
