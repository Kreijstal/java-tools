'use strict';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceDescriptor(descriptor, oldClass, newClass) {
  if (!descriptor || typeof descriptor !== 'string') {
    return descriptor;
  }
  const pattern = new RegExp(`L${escapeRegex(oldClass)};`, 'g');
  return descriptor.replace(pattern, `L${newClass};`);
}

function updateMemberInstruction(instr, fromClass, toClass) {
  if (!instr || !instr.arg) return false;
  const arg = instr.arg;
  if (Array.isArray(arg) && arg.length >= 2) {
    let modified = false;
    if (arg[1] === fromClass) {
      arg[1] = toClass;
      modified = true;
    }
    if (Array.isArray(arg[2]) && arg[2].length >= 2 && typeof arg[2][1] === 'string') {
      const newDesc = replaceDescriptor(arg[2][1], fromClass, toClass);
      if (newDesc !== arg[2][1]) {
        arg[2][1] = newDesc;
        modified = true;
      }
    }
    return modified;
  }
  return false;
}

function renameClassAst(astRoot, fromClass, toClass) {
  let changed = false;
  for (const classItem of astRoot.classes || []) {
    if (classItem.className === fromClass) {
      classItem.className = toClass;
      changed = true;
    }
    if (classItem.superClassName === fromClass) {
      classItem.superClassName = toClass;
      changed = true;
    }
    if (Array.isArray(classItem.interfaces)) {
      classItem.interfaces = classItem.interfaces.map((iface) =>
        iface === fromClass ? toClass : iface,
      );
    }
    for (const item of classItem.items || []) {
      if (item.type === 'field' && item.field) {
        const newDesc = replaceDescriptor(item.field.descriptor, fromClass, toClass);
        if (newDesc !== item.field.descriptor) {
          item.field.descriptor = newDesc;
          changed = true;
        }
      } else if (item.type === 'method' && item.method) {
        const method = item.method;
        const newDesc = replaceDescriptor(method.descriptor, fromClass, toClass);
        if (newDesc !== method.descriptor) {
          method.descriptor = newDesc;
          changed = true;
        }
        for (const attr of method.attributes || []) {
          if (attr.type !== 'code' || !attr.code) continue;
          for (const codeItem of attr.code.codeItems || []) {
            if (!codeItem || !codeItem.instruction) continue;
            const instr = codeItem.instruction;
            const op = instr.op;
            if (!op) continue;
            if (
              ['new', 'checkcast', 'instanceof', 'anewarray'].includes(op) &&
              instr.arg === fromClass
            ) {
              instr.arg = toClass;
              changed = true;
            } else if (op.startsWith('invoke') || op.startsWith('get') || op.startsWith('put')) {
              changed = updateMemberInstruction(instr, fromClass, toClass) || changed;
            }
          }
        }
      } else if (item.attribute && item.attribute.type === 'sourcefile') {
        const expected = `"${fromClass}.java"`;
        if (item.attribute.value === expected) {
          item.attribute.value = `"${toClass}.java"`;
          changed = true;
        }
      }
    }
  }
  return changed;
}

function renameMethodAst(astRoot, className, oldName, newName, descriptor) {
  let changed = false;
  for (const classItem of astRoot.classes || []) {
    if (classItem.className !== className) {
      continue;
    }
    for (const item of classItem.items || []) {
      if (item.type === 'method' && item.method) {
        const method = item.method;
        if (method.name === oldName && (!descriptor || descriptor === method.descriptor)) {
          method.name = newName;
          changed = true;
        }
        for (const attr of method.attributes || []) {
          if (attr.type !== 'code' || !attr.code) {
            continue;
          }
          for (const codeItem of attr.code.codeItems || []) {
            if (!codeItem || !codeItem.instruction) continue;
            const instr = codeItem.instruction;
            if (!instr.op || !instr.op.startsWith('invoke')) continue;
            const arg = instr.arg;
            if (Array.isArray(arg) && arg.length >= 3) {
              const owner = arg[1];
              if (owner !== className) continue;
              const nameAndType = arg[2];
              if (!Array.isArray(nameAndType)) continue;
              const name = nameAndType[0];
              const desc = nameAndType[1];
              if (name === oldName && (!descriptor || descriptor === desc)) {
                nameAndType[0] = newName;
                changed = true;
              }
            }
          }
        }
      }
    }
  }
  return changed;
}

module.exports = { renameClassAst, renameMethodAst };
