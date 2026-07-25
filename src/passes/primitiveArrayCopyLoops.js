'use strict';

const ARRAYCOPY = ['Method', 'java/lang/System', ['arraycopy', '(Ljava/lang/Object;ILjava/lang/Object;II)V']];

function runPrimitiveArrayCopyLoops(astRoot) {
  let rewrites = 0;
  for (const cls of astRoot.classes || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        const code = attr && attr.type === 'code' && attr.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        rewrites += rewriteCode(code);
      }
    }
  }
  return { changed: rewrites > 0, rewrites };
}

function rewriteCode(code) {
  let rewrites = 0;
  for (let i = 0; i < code.codeItems.length; i += 1) {
    const match = matchCopyLoop(code.codeItems, i);
    if (!match) continue;
    const replacement = [
      ...cloneItems(match.srcExpr),
      insn('iconst_0'),
      ...cloneItems(match.dstExpr),
      insn('iconst_0'),
      loadInt(match.lenLocal),
      { instruction: { op: 'invokestatic', arg: ARRAYCOPY } },
    ];
    code.codeItems.splice(match.replaceStart, match.replaceEnd - match.replaceStart, ...replacement);
    code.stackSize = String(Math.max(Number(code.stackSize || 0), 5));
    rewrites += 1;
    i = match.replaceStart + replacement.length - 1;
  }
  return rewrites;
}

function matchCopyLoop(items, start) {
  const srcExpr = readArrayExpr(items, start);
  if (!srcExpr) return null;
  let i = srcExpr.end;
  if (op(items[i]) !== 'arraylength') return null;
  const lenLocal = intStoreLocal(items[i + 1]);
  if (lenLocal == null) return null;
  if (op(items[i + 2]) !== 'iconst_0') return null;
  const idxLocal = intStoreLocal(items[i + 3]);
  if (idxLocal == null) return null;

  const header = i + 4;
  if (intLoadLocal(items[header]) !== idxLocal) return null;
  if (intLoadLocal(items[header + 1]) !== lenLocal) return null;
  if (op(items[header + 2]) !== 'if_icmpge') return null;

  const dstExpr = readArrayExpr(items, header + 3);
  if (!dstExpr) return null;
  if (dstExpr.descriptor !== srcExpr.descriptor || !primitiveArrayDescriptor(srcExpr.descriptor)) return null;
  i = dstExpr.end;
  if (intLoadLocal(items[i]) !== idxLocal) return null;

  const srcExpr2 = readArrayExpr(items, i + 1);
  if (!srcExpr2 || !sameExpr(srcExpr.items, srcExpr2.items) || srcExpr2.descriptor !== srcExpr.descriptor) return null;
  i = srcExpr2.end;
  if (intLoadLocal(items[i]) !== idxLocal) return null;
  if (op(items[i + 1]) !== loadOpFor(srcExpr.descriptor)) return null;
  if (op(items[i + 2]) !== storeOpFor(srcExpr.descriptor)) return null;
  if (!sameIinc(items[i + 3], idxLocal)) return null;
  if (op(items[i + 4]) !== 'goto') return null;
  if (!branchTargetsItem(items[i + 4], items[header])) return null;
  if (!branchTargetsItem(items[header + 2], items[i + 5])) return null;

  return {
    replaceStart: iOf(items, start, 'zero-init', start) ?? start + srcExpr.items.length + 2,
    replaceEnd: i + 5,
    srcExpr: srcExpr.items,
    dstExpr: dstExpr.items,
    lenLocal,
  };
}

function iOf(items, start, _name) {
  const srcExpr = readArrayExpr(items, start);
  return srcExpr ? srcExpr.end + 2 : null;
}

function readArrayExpr(items, start) {
  const one = items[start];
  const two = items[start + 1];
  if (op(one) === 'getstatic') {
    const descriptor = fieldDescriptor(arg(one));
    return descriptor ? { items: [one], end: start + 1, descriptor } : null;
  }
  if (aloadLocal(one) != null && op(two) === 'getfield') {
    const descriptor = fieldDescriptor(arg(two));
    return descriptor ? { items: [one, two], end: start + 2, descriptor } : null;
  }
  return null;
}

function sameExpr(a, b) {
  return JSON.stringify(a.map((item) => item.instruction)) === JSON.stringify(b.map((item) => item.instruction));
}

function primitiveArrayDescriptor(desc) {
  return /^\[[ZBCSIJFD]$/.test(desc || '');
}

function loadOpFor(desc) {
  return ({ '[Z': 'baload', '[B': 'baload', '[C': 'caload', '[S': 'saload', '[I': 'iaload', '[J': 'laload', '[F': 'faload', '[D': 'daload' })[desc] || null;
}

function storeOpFor(desc) {
  return ({ '[Z': 'bastore', '[B': 'bastore', '[C': 'castore', '[S': 'sastore', '[I': 'iastore', '[J': 'lastore', '[F': 'fastore', '[D': 'dastore' })[desc] || null;
}

function sameIinc(item, local) {
  if (op(item) !== 'iinc') return false;
  const itemArg = arg(item);
  if (Array.isArray(itemArg)) return String(itemArg[0]) === local && Number(itemArg[1]) === 1;
  const insnValue = item && item.instruction;
  return insnValue && typeof insnValue === 'object' &&
    String(insnValue.varnum) === local &&
    Number(insnValue.incr) === 1;
}

function branchTargetsItem(branch, target) {
  const targetLabel = trimLabel(arg(branch));
  return targetLabel != null && target && trimLabel(target.labelDef) === targetLabel;
}

function cloneItems(items) {
  return items.map((item) => ({ instruction: clone(item.instruction) }));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function insn(instruction) {
  return { instruction };
}

function loadInt(local) {
  const n = Number(local);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return insn(`iload_${n}`);
  return { instruction: { op: 'iload', arg: String(local) } };
}

function intLoadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'iload') return String(arg(item));
  if (/^iload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function intStoreLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'istore') return String(arg(item));
  if (/^istore_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function aloadLocal(item) {
  const itemOp = op(item);
  if (itemOp === 'aload') return String(arg(item));
  if (/^aload_[0-3]$/.test(itemOp || '')) return itemOp.slice(-1);
  return null;
}

function fieldDescriptor(itemArg) {
  return Array.isArray(itemArg) && itemArg[0] === 'Field' && Array.isArray(itemArg[2]) ? itemArg[2][1] : null;
}

function op(item) {
  const insnValue = item && item.instruction;
  return typeof insnValue === 'string' ? insnValue : insnValue && insnValue.op;
}

function arg(item) {
  const insnValue = item && item.instruction;
  return insnValue && typeof insnValue === 'object' ? insnValue.arg : null;
}

function trimLabel(label) {
  return typeof label === 'string' && label.endsWith(':') ? label.slice(0, -1) : label;
}

module.exports = { runPrimitiveArrayCopyLoops, rewriteCode, matchCopyLoop };
