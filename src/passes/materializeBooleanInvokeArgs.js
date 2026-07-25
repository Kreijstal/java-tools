'use strict';

const INVOKE_OPS = new Set(['invokevirtual', 'invokeinterface', 'invokestatic', 'invokespecial']);
const TERMINATORS = new Set([
  'goto', 'goto_w', 'return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'athrow',
]);

function runMaterializeBooleanInvokeArgs(astRoot, options = {}) {
  let rewrites = 0;
  const targets = targetSet(options.targets);
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      if (!targets.has(`${cls.className}.${item.method.name}${item.method.descriptor}`)) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += rewriteCode(code, options);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function targetSet(targets) {
  if (!Array.isArray(targets)) return new Set();
  return new Set(targets.map((target) => `${target.className}.${target.methodName}${target.descriptor}`));
}

function rewriteCode(code, options = {}) {
  const items = code.codeItems;
  if (items.length > 10000) return 0;
  const maxTailInsns = Math.max(1, options.maxTailInsns || 8);
  let rewrites = 0;

  for (let invokeIndex = 0; invokeIndex < items.length; invokeIndex += 1) {
    if (!isInvokeWithTrailingBooleanArg(items[invokeIndex])) continue;
    const callLabel = trimLabel(items[invokeIndex].labelDef);
    if (!callLabel || isExceptionTableLabel(code.exceptionTable, callLabel)) continue;

    const falseIndex = previousInstructionIndex(items, invokeIndex);
    const falseLabel = trimLabel(items[falseIndex] && items[falseIndex].labelDef);
    if (!falseLabel || !isBooleanProducer(items[falseIndex])) continue;
    if (isExceptionTableLabel(code.exceptionTable, falseLabel)) continue;

    const canonicalGoto = previousInstructionIndex(items, falseIndex);
    if (canonicalGoto < 0 || op(items[canonicalGoto]) !== 'goto' || trimLabel(arg(items[canonicalGoto])) !== callLabel) continue;
    const canonicalTrueProducer = previousInstructionIndex(items, canonicalGoto);
    if (canonicalTrueProducer < 0 || !isBooleanProducer(items[canonicalTrueProducer])) continue;
    const canonicalBranch = previousInstructionIndex(items, canonicalTrueProducer);
    if (canonicalBranch < 0 || trimLabel(arg(items[canonicalBranch])) !== falseLabel) continue;

    const tail = extractTail(items, invokeIndex, maxTailInsns);
    if (!tail) continue;

    const refs = branchReferences(items, callLabel)
      .filter((ref) => ref.op === 'goto' && ref.index !== canonicalGoto && ref.index < falseIndex)
      .sort((a, b) => b.index - a.index);
    if (refs.length === 0) continue;

    for (const ref of refs) {
      const trueProducer = previousInstructionIndex(items, ref.index);
      if (trueProducer < 0 || !isBooleanProducer(items[trueProducer])) continue;
      const branch = previousInstructionIndex(items, trueProducer);
      if (branch < 0 || trimLabel(arg(items[branch])) !== falseLabel) continue;
      if (!isConditionalBranch(op(items[branch]))) continue;

      const falseClone = freshLabel(items, 'L_bool_invoke_false');
      const callClone = freshLabel(items, 'L_bool_invoke_call');
      items[branch].instruction = { ...items[branch].instruction, arg: falseClone };

      const clonedTail = cloneTail(tail.items, callLabel, callClone);
      const replacement = [
        ...clonedTail,
        { labelDef: `${falseClone}:`, instruction: 'iconst_0' },
        { instruction: { op: 'goto', arg: callClone } },
      ];
      items.splice(ref.index, 1, ...replacement);
      rewrites += 1;
    }
  }

  return rewrites;
}

function extractTail(items, invokeIndex, maxTailInsns) {
  const out = [];
  let real = 0;
  for (let i = invokeIndex; i < items.length; i += 1) {
    const item = items[i];
    if (!item || !item.instruction) continue;
    out.push(item);
    real += 1;
    if (real > maxTailInsns) return null;
    if (TERMINATORS.has(op(item))) return { items: out };
  }
  return null;
}

function cloneTail(tailItems, oldCallLabel, newCallLabel) {
  return tailItems.map((item, index) => {
    const clone = { ...item };
    if (index === 0) {
      clone.labelDef = `${newCallLabel}:`;
    } else if (clone.labelDef) {
      clone.labelDef = `${freshInternalLabel(newCallLabel, clone.labelDef)}:`;
    }
    if (clone.instruction && typeof clone.instruction === 'object') {
      const target = trimLabel(clone.instruction.arg);
      if (target === oldCallLabel) {
        clone.instruction = { ...clone.instruction, arg: newCallLabel };
      } else {
        clone.instruction = { ...clone.instruction };
      }
    }
    return clone;
  });
}

function freshInternalLabel(prefix, label) {
  return `${prefix}_${trimLabel(label)}`;
}

function isInvokeWithTrailingBooleanArg(item) {
  if (!INVOKE_OPS.has(op(item))) return false;
  const desc = methodDescriptor(arg(item));
  if (!desc) return false;
  const args = argumentDescriptors(desc);
  return args.length > 0 && args[args.length - 1] === 'Z';
}

function argumentDescriptors(desc) {
  const close = desc.indexOf(')');
  if (!desc.startsWith('(') || close < 0) return [];
  const args = [];
  for (let i = 1; i < close;) {
    const start = i;
    while (desc[i] === '[') i += 1;
    if (desc[i] === 'L') {
      const semi = desc.indexOf(';', i);
      if (semi < 0 || semi > close) return [];
      i = semi + 1;
      args.push(desc.slice(start, i));
      continue;
    }
    if ('ZBCSIJFD'.includes(desc[i])) {
      i += 1;
      args.push(desc.slice(start, i));
      continue;
    }
    return [];
  }
  return args;
}

function methodDescriptor(value) {
  if (!Array.isArray(value)) return '';
  if (value[0] !== 'Method' && value[0] !== 'InterfaceMethod') return '';
  return Array.isArray(value[2]) && typeof value[2][1] === 'string' ? value[2][1] : '';
}

function isBooleanProducer(item) {
  const itemOp = op(item);
  return itemOp === 'iconst_0' || itemOp === 'iconst_1' ||
    itemOp === 'iload' || /^iload_[0-3]$/.test(itemOp || '') ||
    itemOp === 'getstatic' && fieldDescriptor(item) === 'Z' ||
    itemOp === 'getfield' && fieldDescriptor(item) === 'Z' ||
    INVOKE_OPS.has(itemOp) && invokeReturnDescriptor(item) === 'Z';
}

function isConditionalBranch(itemOp) {
  return typeof itemOp === 'string' && itemOp.startsWith('if');
}

function branchReferences(items, label) {
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const itemOp = op(items[i]);
    const itemArg = arg(items[i]);
    if (typeof itemArg === 'string' && trimLabel(itemArg) === label) {
      out.push({ index: i, op: itemOp });
    }
  }
  return out;
}

function isExceptionTableLabel(exceptionTable, label) {
  return (exceptionTable || []).some((entry) =>
    trimLabel(entry.startLbl) === label ||
    trimLabel(entry.endLbl) === label ||
    trimLabel(entry.handlerLbl) === label);
}

function previousInstructionIndex(items, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
}

function freshLabel(items, prefix) {
  const used = new Set(items.map((item) => trimLabel(item && item.labelDef)).filter(Boolean));
  let n = 0;
  let label = prefix;
  while (used.has(label)) {
    n += 1;
    label = `${prefix}_${n}`;
  }
  return label;
}

function fieldDescriptor(item) {
  const value = arg(item);
  return Array.isArray(value) && Array.isArray(value[2]) ? value[2][1] : null;
}

function invokeReturnDescriptor(item) {
  const value = arg(item);
  const desc = methodDescriptor(value);
  const close = desc.lastIndexOf(')');
  return close >= 0 ? desc.slice(close + 1) : null;
}

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

function arg(item) {
  const insn = item && typeof item.instruction === 'object' ? item.instruction : null;
  return insn && insn.arg;
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = {
  runMaterializeBooleanInvokeArgs,
  rewriteCode,
};
