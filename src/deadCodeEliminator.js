const { getStackEffect, normalizeInstruction } = require('./utils/instructionUtils');
const { applyStackManipulation } = require('./utils/stackManipulation');

function buildMethodSignature(className, method) {
  return `${className}.${method.name}${method.descriptor}`;
}

function pushProducedValue(entry, stack, width) {
  const produced = { producer: entry, width };
  entry.produced.push(produced);
  stack.push(produced);
}

function handleStackManipulation(entry, effect, consumed, stack) {
  return applyStackManipulation(effect, consumed, stack, {
    pushOriginal: (value) => {
      stack.push(value);
      return true;
    },
    pushDuplicate: (value) => {
      pushProducedValue(entry, stack, value.width);
      return true;
    },
  });
}

function computeMaxStack(entries, keepSet) {
  let height = 0;
  let maxHeight = 0;
  for (const entry of entries) {
    if (!keepSet.has(entry.index)) {
      continue;
    }
    height -= entry.meta.popSlots;
    if (height < 0) {
      console.error(
        `Stack underflow detected at entry index ${entry.index} (popSlots: ${entry.meta.popSlots}).`
      );
      return null;
    }
    height += entry.meta.pushSlots;
    if (height > maxHeight) {
      maxHeight = height;
    }
  }
  return height === 0 ? maxHeight : null;
}

function eliminateDeadCode(ast) {
  const result = {};
  let changed = false;

  if (!ast || !Array.isArray(ast.classes)) {
    return { changed: false, methods: result };
  }

  for (const cls of ast.classes) {
    if (!cls || !Array.isArray(cls.items)) {
      continue;
    }
    const {className} = cls;

    for (const item of cls.items) {
      if (!item || item.type !== "method" || !item.method) {
        continue;
      }
      const {method} = item;
      const signature = buildMethodSignature(className, method);
      const codeAttr = (method.attributes || []).find((attr) => attr.type === "code");
      if (!codeAttr || !codeAttr.code || !Array.isArray(codeAttr.code.codeItems)) {
        continue;
      }

      const { code } = codeAttr;
      const entries = [];
      const entryByIndex = new Map();
      let unsupported = false;

      code.codeItems.forEach((codeItem, index) => {
        const normalized = normalizeInstruction(codeItem.instruction);
        if (!normalized) {
          return;
        }
        const { op } = normalized;
        const meta = getStackEffect(op, normalized);
        if (!meta) {
          unsupported = true;
          return;
        }
        const entry = {
          index,
          op,
          meta,
          consumes: [],
          produced: [],
          consumers: new Set(),
          terminator: Boolean(meta.terminator),
          instruction: normalized,
        };
        entries.push(entry);
        entryByIndex.set(index, entry);
      });

      if (unsupported || entries.length === 0) {
        continue;
      }

      const stack = [];
      let analysisFailed = false;

      for (const entry of entries) {
        const { popSlots, pushSlots, special } = entry.meta;
        let remaining = popSlots;
        const consumed = [];

        while (remaining > 0) {
          const value = stack.pop();
          if (!value) {
            analysisFailed = true;
            break;
          }
          consumed.push(value);
          remaining -= value.width;
        }

        if (analysisFailed || remaining !== 0) {
          analysisFailed = true;
          break;
        }

        entry.consumes = consumed;
        for (const value of consumed) {
          if (value.producer) {
            value.producer.consumers.add(entry);
          }
        }

        if (special) {
          const handled = handleStackManipulation(entry, entry.meta, consumed, stack);
          if (!handled) {
            analysisFailed = true;
          }
          continue;
        }

        if (pushSlots > 0) {
          const produced = { producer: entry, width: pushSlots };
          entry.produced.push(produced);
          stack.push(produced);
        }
      }

      if (analysisFailed) {
        continue;
      }

      const keepSet = new Set();
      const visitStack = [];

      for (const entry of entries) {
        if (entry.terminator || entry.meta.essential) {
          visitStack.push(entry);
        }
      }

      while (visitStack.length > 0) {
        const current = visitStack.pop();
        if (keepSet.has(current.index)) {
          continue;
        }
        keepSet.add(current.index);
        for (const value of current.consumes) {
          if (value.producer && !keepSet.has(value.producer.index)) {
            visitStack.push(value.producer);
          }
        }
      }

      const removedEntries = entries.filter((entry) => !keepSet.has(entry.index));
      if (removedEntries.length === 0) {
        continue;
      }

      const newMaxStack = computeMaxStack(entries, keepSet);
      if (newMaxStack === null) {
        continue;
      }

      const filteredItems = [];
      code.codeItems.forEach((codeItem, index) => {
        const entry = entryByIndex.get(index);
        if (entry && !keepSet.has(index)) {
          return;
        }
        filteredItems.push(codeItem);
      });

      code.stackSize = String(newMaxStack);
      code.codeItems = filteredItems;

      changed = true;
      result[signature] = {
        removed: removedEntries.map((entry) => entry.op),
        originalLength: entries.length,
        optimizedLength: entries.length - removedEntries.length,
        stackSize: code.stackSize,
      };
    }
  }

  return { changed, methods: result };
}

module.exports = {
  eliminateDeadCode,
};
