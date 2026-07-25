'use strict';

function runNormalizeBooleanSinks(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += rewriteCode(code, item.method);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function rewriteCode(code, method = null) {
  const items = code.codeItems;
  const referenced = referencedLabels(code);
  const booleanArrays = collectBooleanArrayLocals(items, method);
  let rewrites = 0;

  for (let i = 0; i < items.length; i += 1) {
    const itemOp = op(items[i]);
    if ((itemOp === 'putfield' || itemOp === 'putstatic') && fieldDescriptor(arg(items[i])) === 'Z') {
      const valueIndex = previousInstructionIndex(items, i);
      if (valueIndex >= 0 && iloadLocal(items[valueIndex]) != null && !hasReferencedLabel(items[valueIndex], referenced)) {
        const falseLabel = freshLabel(items, 'L_bool_sink_false');
        const storeLabel = freshLabel(items, 'L_bool_sink_store');
        const valueItem = cloneWithoutLabel(items[valueIndex]);
        items.splice(
          valueIndex,
          1,
          valueItem,
          { instruction: { op: 'ifeq', arg: falseLabel } },
          { instruction: 'iconst_1' },
          { instruction: { op: 'goto', arg: storeLabel } },
          { labelDef: `${falseLabel}:`, instruction: 'iconst_0' },
          { labelDef: `${storeLabel}:`, instruction: 'nop' },
        );
        rewrites += 1;
        i += 5;
      }
      continue;
    }

    if (itemOp !== 'bastore') continue;
    const valueIndex = previousInstructionIndex(items, i);
    if (valueIndex < 0 || op(items[valueIndex]) !== 'i2b') continue;
    const rawValueIndex = previousInstructionIndex(items, valueIndex);
    if (rawValueIndex < 0 || !isIntBooleanValue(items[rawValueIndex])) continue;
    if (!hasImmediateBooleanArraySink(items, rawValueIndex, booleanArrays)) continue;
    if (hasReferencedLabel(items[valueIndex], referenced)) continue;
    removeInstructionOnly(items, valueIndex);
    rewrites += 1;
  }

  return rewrites;
}

function collectBooleanArrayLocals(items, method) {
  const locals = new Set(parameterLocals(method, '[Z'));
  for (let i = 0; i < items.length - 1; i += 1) {
    if (isBooleanArrayProducer(items[i]) && astoreLocal(items[i + 1]) != null) {
      locals.add(astoreLocal(items[i + 1]));
    }
  }
  return locals;
}

function hasImmediateBooleanArraySink(items, valueIndex, knownLocals) {
  const indexIndex = previousInstructionIndex(items, valueIndex);
  if (indexIndex < 0 || !isIntValue(items[indexIndex])) return false;
  const arrayIndex = previousInstructionIndex(items, indexIndex);
  if (arrayIndex < 0) return false;
  if (isBooleanArrayProducer(items[arrayIndex])) return true;
  const local = aloadLocal(items[arrayIndex]);
  return local != null && knownLocals.has(local);
}

function isBooleanArrayProducer(item) {
  const itemOp = op(item);
  if (itemOp === 'newarray' && arg(item) === 'boolean') return true;
  if ((itemOp === 'getstatic' || itemOp === 'getfield') && fieldDescriptor(arg(item)) === '[Z') return true;
  if (/^invoke/.test(itemOp || '') && returnDescriptor(methodDescriptor(arg(item))) === '[Z') return true;
  return false;
}

function isIntBooleanValue(item) {
  const itemOp = op(item);
  return itemOp === 'iconst_0' || itemOp === 'iconst_1' || iloadLocal(item) != null;
}

function isIntValue(item) {
  const itemOp = op(item);
  return /^iconst_/.test(itemOp || '')
    || /^(bipush|sipush)$/.test(itemOp || '')
    || iloadLocal(item) != null;
}

function referencedLabels(code) {
  const out = new Set();
  for (const item of code.codeItems || []) {
    const itemOp = op(item);
    if ((itemOp && itemOp.startsWith('if')) || itemOp === 'goto' || itemOp === 'jsr') out.add(trimLabel(arg(item)));
    if (itemOp === 'tableswitch' || itemOp === 'lookupswitch') {
      const itemArg = arg(item);
      if (itemArg && typeof itemArg === 'object') {
        out.add(trimLabel(itemArg.default));
        for (const target of Object.values(itemArg.labels || {})) out.add(trimLabel(target));
      }
    }
  }
  for (const entry of code.exceptionTable || []) {
    out.add(trimLabel(entry.startLbl));
    out.add(trimLabel(entry.endLbl));
    out.add(trimLabel(entry.handlerLbl));
  }
  out.delete(null);
  return out;
}

function hasReferencedLabel(item, referenced) {
  return referenced.has(trimLabel(item && item.labelDef));
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

function removeInstructionOnly(items, index) {
  if (items[index].labelDef || items[index].stackMapFrame || items[index].lineNumber) {
    delete items[index].instruction;
    delete items[index].pc;
  } else {
    items.splice(index, 1);
  }
}

function cloneWithoutLabel(item) {
  return { instruction: cloneInstruction(item) };
}

function cloneInstruction(item) {
  const insn = item && item.instruction;
  return insn && typeof insn === 'object' ? { ...insn } : insn;
}

function parameterLocals(method, descriptor) {
  const out = [];
  if (!method || typeof method.descriptor !== 'string') return out;
  let local = method.flags && method.flags.includes('static') ? 0 : 1;
  for (const desc of parameterDescriptors(method.descriptor)) {
    if (desc === descriptor) out.push(String(local));
    local += desc === 'J' || desc === 'D' ? 2 : 1;
  }
  return out;
}

function parameterDescriptors(desc) {
  if (typeof desc !== 'string' || desc[0] !== '(') return [];
  const out = [];
  for (let i = 1; i < desc.length && desc[i] !== ')';) {
    const start = i;
    while (desc[i] === '[') i += 1;
    if (desc[i] === 'L') {
      const end = desc.indexOf(';', i);
      if (end < 0) return out;
      out.push(desc.slice(start, end + 1));
      i = end + 1;
    } else {
      out.push(desc.slice(start, i + 1));
      i += 1;
    }
  }
  return out;
}

function methodDescriptor(value) {
  return Array.isArray(value) && Array.isArray(value[2]) ? value[2][1] : null;
}

function returnDescriptor(desc) {
  if (typeof desc !== 'string') return null;
  const idx = desc.lastIndexOf(')');
  return idx >= 0 ? desc.slice(idx + 1) : null;
}

function fieldDescriptor(ref) {
  return Array.isArray(ref) && ref[0] === 'Field' && Array.isArray(ref[2]) ? ref[2][1] : null;
}

function previousInstructionIndex(items, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i] && items[i].instruction) return i;
  }
  return -1;
}

function aloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'aload') return String(arg(item));
  const match = /^aload_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function astoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'astore') return String(arg(item));
  const match = /^astore_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function iloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'iload') return String(arg(item));
  const match = /^iload_([0-3])$/.exec(itemOp || '');
  return match ? match[1] : null;
}

function op(item) {
  const insn = item && item.instruction;
  return typeof insn === 'string' ? insn : insn && insn.op;
}

function arg(item) {
  const insn = item && item.instruction;
  return insn && typeof insn === 'object' ? insn.arg : null;
}

function trimLabel(label) {
  return typeof label === 'string' ? label.replace(/:$/, '') : null;
}

module.exports = { runNormalizeBooleanSinks, rewriteCode };
