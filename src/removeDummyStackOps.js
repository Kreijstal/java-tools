'use strict';

const { normalizeInstruction } = require('./utils/instructionUtils');

const SAFE_CONST_PREFIXES = ['iconst_', 'lconst_', 'fconst_', 'dconst_'];
const SAFE_LOAD_PREFIXES = ['iload', 'lload', 'fload', 'dload', 'aload'];
const SAFE_CONST_OPS = new Set(['aconst_null', 'bipush', 'sipush', 'ldc', 'ldc_w', 'ldc2_w']);

function isPopOp(op) {
  if (!op) {
    return { match: false, width: 0 };
  }
  if (op === 'pop') {
    return { match: true, width: 1 };
  }
  if (op === 'pop2') {
    return { match: true, width: 2 };
  }
  return { match: false, width: 0 };
}

function isHarmlessProducer(op) {
  if (!op) {
    return 0;
  }
  if (SAFE_CONST_OPS.has(op)) {
    return op === 'ldc2_w' || op.startsWith('lconst_') || op.startsWith('dconst_') ? 2 : 1;
  }
  if (SAFE_CONST_PREFIXES.some((prefix) => op.startsWith(prefix))) {
    return op.startsWith('lconst_') || op.startsWith('dconst_') ? 2 : 1;
  }
  if (SAFE_LOAD_PREFIXES.some((prefix) => op.startsWith(prefix))) {
    return op.startsWith('lload') || op.startsWith('dload') ? 2 : 1;
  }
  return 0;
}

function stripInstruction(item) {
  if (!item) {
    return null;
  }
  const clone = { ...item };
  delete clone.instruction;
  const remainingKeys = Object.keys(clone).filter((key) => key !== 'pc');
  if (remainingKeys.length === 0) {
    return null;
  }
  return clone;
}

function removePairsFromCodeItems(codeItems) {
  if (!Array.isArray(codeItems) || codeItems.length === 0) {
    return { changed: false, removedPairs: 0 };
  }

  const instructions = [];
  codeItems.forEach((item, index) => {
    if (!item || !item.instruction) {
      return;
    }
    const normalized = normalizeInstruction(item.instruction);
    if (!normalized || !normalized.op) {
      return;
    }
    instructions.push({ index, normalized });
  });

  if (instructions.length < 2) {
    return { changed: false, removedPairs: 0 };
  }

  const toRemove = new Set();
  for (let i = 1; i < instructions.length; i += 1) {
    const current = instructions[i];
    if (!current || toRemove.has(current.index)) {
      continue;
    }
    const popInfo = isPopOp(current.normalized.op);
    if (!popInfo.match) {
      continue;
    }
    let prevIdx = i - 1;
    let prev = instructions[prevIdx];
    while (prevIdx >= 0 && prev && toRemove.has(prev.index)) {
      prevIdx -= 1;
      prev = instructions[prevIdx];
    }
    if (!prev) {
      continue;
    }
    const producedWidth = isHarmlessProducer(prev.normalized.op);
    if (producedWidth === 0 || producedWidth !== popInfo.width) {
      continue;
    }
    toRemove.add(prev.index);
    toRemove.add(current.index);
  }

  if (toRemove.size === 0) {
    return { changed: false, removedPairs: 0 };
  }

  const newItems = [];
  codeItems.forEach((item, index) => {
    if (!toRemove.has(index)) {
      newItems.push(item);
      return;
    }
    const stripped = stripInstruction(item);
    if (stripped) {
      newItems.push(stripped);
    }
  });

  return { changed: true, removedPairs: toRemove.size / 2, codeItems: newItems };
}

function removeDummyStackOps(program) {
  if (!program || !Array.isArray(program.classes)) {
    return { changed: false, methods: [] };
  }

  const methods = [];
  let changed = false;

  program.classes.forEach((cls) => {
    if (!cls || !Array.isArray(cls.items)) {
      return;
    }
    const className = cls.className || 'UnknownClass';
    cls.items.forEach((item) => {
      if (!item || item.type !== 'method' || !item.method) {
        return;
      }
      const method = item.method;
      const codeAttr = (method.attributes || []).find((attr) => attr && attr.type === 'code');
      if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) {
        return;
      }
      const result = removePairsFromCodeItems(codeAttr.code.codeItems);
      if (result.changed) {
        codeAttr.code.codeItems = result.codeItems;
        changed = true;
        methods.push({
          className,
          methodName: method.name,
          descriptor: method.descriptor,
          removedPairs: result.removedPairs,
        });
      }
    });
  });

  return { changed, methods };
}

module.exports = {
  removeDummyStackOps,
};
