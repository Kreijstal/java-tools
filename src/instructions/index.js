const constants = require('./constants');
const loads = require('./loads');
const stores = require('./stores');
const stack = require('./stack');
const math = require('./math');
const control = require('./control');
const invoke = require('./invoke');
const object = require('./object');
const conversions = require('./conversions');
const { buildSsa } = require('../analysis/opgraph/ssa');
const { kindWidth } = require('../analysis/opgraph/ssaTypes');
const { stackWidthsBefore } = require('./stackMetadata');

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
// getstatic is asynchronous only while class initialization/loading is cold.
// Its warm initialized-field path is safe inside the synchronous quantum.
syncInstructions.getstatic = object.getstaticSync;
syncInstructions.invokevirtual = invoke.invokevirtualSync;
syncInstructions.invokestatic = invoke.invokestaticSync;
syncInstructions.invokespecial = invoke.invokespecialSync;
syncInstructions.invokeinterface = invoke.invokeinterfaceSync;
const syncCodePrepared = Symbol('syncCodePrepared');
const syncHandler = Symbol('syncHandler');
const syncInstruction = Symbol('syncInstruction');
const categorySensitiveStackOps = new Set([
  'pop2', 'dup_x2', 'dup2', 'dup2_x1', 'dup2_x2',
]);

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
function prepareSyncInstructions(codeItems, method = null, exceptionTable = null) {
  if (!codeItems || codeItems[syncCodePrepared]) return;

  const needsStackKinds = method && codeItems.some((item) => {
    const instruction = item && item.instruction;
    const op = typeof instruction === 'string' ? instruction : instruction && instruction.op;
    return categorySensitiveStackOps.has(op);
  });
  if (needsStackKinds) {
    const analysis = buildSsa({
      codeItems,
      exceptionTable: exceptionTable || [],
      method,
    });
    if (analysis && !analysis.rejected && analysis.stackKindsBefore) {
      for (const [itemIndex, kinds] of analysis.stackKindsBefore) {
        const item = codeItems[itemIndex];
        if (!item || !categorySensitiveStackOps.has(
          typeof item.instruction === 'string'
            ? item.instruction
            : item.instruction && item.instruction.op,
        )) continue;
        Object.defineProperty(item, stackWidthsBefore, {
          configurable: false,
          enumerable: false,
          value: kinds.map(kindWidth),
        });
      }
    }
  }

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
// though no suspension is possible. Invoke/getstatic sites add guarded warm
// handlers and return a fallback sentinel for cold loading/initialization;
// allocation, casts, class literals, and actual Promises remain asynchronous.
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
module.exports.syncFallback = object.SYNC_STATIC_FALLBACK;
module.exports.syncInvokeFallback = invoke.SYNC_INVOKE_FALLBACK;
module.exports.expandWideInstruction = expandWideInstruction;
