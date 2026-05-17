'use strict';

function runAddDefaultConstructorsForImplicitSupers(astRoot, options = {}) {
  const classes = (astRoot.classes || []).filter((cls) => cls && cls.className);
  const byName = new Map(classes.map((cls) => [cls.className, cls]));
  const addable = options.classesToAdd
    ? new Set([...options.classesToAdd].map(String))
    : discoverAddableConstructorSupers(classes, byName);

  let added = 0;
  for (const name of addable) {
    const cls = byName.get(name);
    if (!cls || hasConstructor(cls)) continue;
    cls.items = cls.items || [];
    const insertAt = firstMethodIndex(cls.items);
    cls.items.splice(insertAt, 0, defaultConstructor(cls.superClassName || 'java/lang/Object'));
    added += 1;
  }
  return { changed: added > 0, added };
}

function discoverAddableConstructorSupers(classes, byName) {
  const subclassNeeds = new Map();
  for (const cls of classes) {
    if (isInterface(cls) || hasConstructor(cls)) continue;
    const superName = cls.superClassName;
    if (!superName || superName === 'java/lang/Object') continue;
    if (!subclassNeeds.has(superName)) subclassNeeds.set(superName, []);
    subclassNeeds.get(superName).push(cls.className);
  }

  const addable = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const superName of subclassNeeds.keys()) {
      if (addable.has(superName)) continue;
      const cls = byName.get(superName);
      if (!cls || isInterface(cls) || hasConstructor(cls)) continue;
      const parent = cls.superClassName;
      if (parent === 'java/lang/Object' || hasNoArgConstructor(byName.get(parent)) || addable.has(parent)) {
        addable.add(superName);
        changed = true;
      }
    }
  }
  return addable;
}

function defaultConstructor(superName) {
  return {
    type: 'method',
    method: {
      flags: [],
      accessFlags: 0,
      name: '<init>',
      descriptor: '()V',
      attributes: [{
        type: 'code',
        code: {
          long: false,
          stackSize: '1',
          localsSize: '1',
          codeItems: [
            { instruction: 'aload_0' },
            { instruction: { op: 'invokespecial', arg: ['Method', superName, ['<init>', '()V']] } },
            { instruction: 'return' },
          ],
          exceptionTable: [],
          attributes: [],
        },
      }],
    },
  };
}

function firstMethodIndex(items) {
  const index = items.findIndex((item) => item && item.type === 'method');
  return index >= 0 ? index : items.length;
}

function hasConstructor(cls) {
  return !!(cls && (cls.items || []).some((item) =>
    item && item.type === 'method' && item.method && item.method.name === '<init>'));
}

function hasNoArgConstructor(cls) {
  return !!(cls && (cls.items || []).some((item) =>
    item && item.type === 'method' && item.method &&
    item.method.name === '<init>' && item.method.descriptor === '()V'));
}

function isInterface(cls) {
  return !!(cls && Array.isArray(cls.flags) && cls.flags.includes('interface'));
}

module.exports = {
  runAddDefaultConstructorsForImplicitSupers,
  discoverAddableConstructorSupers,
};
