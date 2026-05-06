'use strict';

function runRemoveShadowedExceptionHandlers(astRoot, options = {}) {
  const methodKeys = options.methodKeys || null;
  const removals = [];
  for (const classItem of astRoot.classes || []) {
    const className = classItem.className || 'UnknownClass';
    for (const item of classItem.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      const method = item.method;
      const methodKey = `${className}.${method.name}${method.descriptor}`;
      if (methodKeys && !methodKeys.has(methodKey)) continue;
      for (const attr of method.attributes || []) {
        if (!attr || attr.type !== 'code' || !attr.code || !Array.isArray(attr.code.exceptionTable)) continue;
        const removed = removeShadowedEntries(attr.code.exceptionTable);
        for (const removal of removed) {
          removals.push({
            className,
            methodName: method.name,
            descriptor: method.descriptor,
            ...removal,
          });
        }
      }
    }
  }
  return { changed: removals.length > 0, removed: removals.length, removals };
}

function removeShadowedEntries(exceptionTable) {
  const seen = new Map();
  const kept = [];
  const removals = [];

  for (let i = 0; i < exceptionTable.length; i += 1) {
    const entry = exceptionTable[i];
    const key = shadowKey(entry);
    if (!key) {
      kept.push(entry);
      continue;
    }

    const previous = seen.get(key);
    if (previous) {
      removals.push({
        index: i,
        shadowedByIndex: previous.index,
        startLabel: previous.startLabel,
        endLabel: previous.endLabel,
        catchType: previous.catchType,
        handlerLabel: handlerLabel(entry),
        shadowedByHandlerLabel: handlerLabel(previous.entry),
      });
      continue;
    }

    seen.set(key, {
      index: i,
      entry,
      startLabel: startLabel(entry),
      endLabel: endLabel(entry),
      catchType: catchType(entry),
    });
    kept.push(entry);
  }

  if (removals.length) {
    exceptionTable.splice(0, exceptionTable.length, ...kept);
  }
  return removals;
}

function shadowKey(entry) {
  const start = startLabel(entry);
  const end = endLabel(entry);
  if (start == null || end == null) return null;
  return `${start}->${end}:${catchType(entry)}`;
}

function startLabel(entry) {
  return entry && (entry.startLbl || entry.startLabel || entry.start || entry.from || entry.start_pc);
}

function endLabel(entry) {
  return entry && (entry.endLbl || entry.endLabel || entry.end || entry.to || entry.end_pc);
}

function handlerLabel(entry) {
  return entry && (entry.handlerLbl || entry.handlerLabel || entry.handler || entry.usingLbl || entry.handler_pc);
}

function catchType(entry) {
  return entry && (entry.catch_type || entry.catchType || entry.type || 'any');
}

module.exports = { runRemoveShadowedExceptionHandlers, removeShadowedEntries };
