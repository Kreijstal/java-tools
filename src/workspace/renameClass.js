const { SymbolIdentifier } = require('./symbols');

function getValueByPath(obj, path) {
  const keys = path.split('.');
  let result = obj;

  for (const key of keys) {
    if (result == null) {
      return undefined;
    }

    if (Array.isArray(result) && !isNaN(key)) {
      result = result[parseInt(key, 10)];
    } else {
      result = result[key];
    }
  }

  return result;
}

function replaceClassInDescriptor(value, oldClassName, newClassName) {
    if (typeof value !== 'string') return value;
    return value.split(`L${oldClassName};`).join(`L${newClassName};`);
}

function rewriteInstructionClassReferences(instruction, oldClassName, newClassName) {
    if (!instruction || !instruction.op) return;
    const op = instruction.op;
    const arg = instruction.arg;

    if (['new', 'anewarray', 'checkcast', 'instanceof'].includes(op)) {
        if (arg === oldClassName) {
            instruction.arg = newClassName;
        } else if (Array.isArray(arg)) {
            instruction.arg = arg.map((value) =>
                value === oldClassName ? newClassName
                    : replaceClassInDescriptor(value, oldClassName, newClassName));
        }
    } else if ((op.startsWith('invoke') || op.startsWith('get') || op.startsWith('put'))
        && Array.isArray(arg)) {
        if (arg[1] === oldClassName) arg[1] = newClassName;
        if (Array.isArray(arg[2]) && typeof arg[2][1] === 'string') {
            arg[2][1] = replaceClassInDescriptor(arg[2][1], oldClassName, newClassName);
        }
    } else if (op === 'multianewarray' && Array.isArray(arg)) {
        instruction.arg = arg.map((value) =>
            value === oldClassName ? newClassName
                : replaceClassInDescriptor(value, oldClassName, newClassName));
    }
}

function rewriteClassMetadata(value, oldClassName, newClassName, key = null) {
    if (typeof value === 'string') {
        const descriptorRewritten = replaceClassInDescriptor(value, oldClassName, newClassName);
        if (descriptorRewritten !== value) return descriptorRewritten;
        const classNameKeys = new Set([
            'className', 'superClassName', 'owner', 'catchType', 'catch_type', 'enclosingClass',
            'innerClass', 'outerClass',
        ]);
        return value === oldClassName && classNameKeys.has(key) ? newClassName : value;
    }
    if (Array.isArray(value)) {
        const classNameLists = new Set(['interfaces', 'exceptions']);
        return value.map((item) => {
            if (classNameLists.has(key) && item === oldClassName) return newClassName;
            return rewriteClassMetadata(item, oldClassName, newClassName, key);
        });
    }
    if (!value || typeof value !== 'object') return value;

    if (value.instruction) {
        rewriteInstructionClassReferences(value.instruction, oldClassName, newClassName);
    }
    for (const [childKey, childValue] of Object.entries(value)) {
        value[childKey] = rewriteClassMetadata(childValue, oldClassName, newClassName, childKey);
    }
    return value;
}

function replaceClassesInDescriptor(value, classNames) {
    if (typeof value !== 'string' || !value.includes('L')) return value;
    return value.replace(/L([^;]+);/g, (match, internalName) => {
        const replacement = classNames.get(internalName);
        return replacement ? `L${replacement};` : match;
    });
}

function rewriteInstructionClassReferencesBulk(instruction, classNames) {
    if (!instruction || !instruction.op) return;
    const op = instruction.op;
    const arg = instruction.arg;
    const mapped = (value) => classNames.get(value) || value;

    if (['new', 'anewarray', 'checkcast', 'instanceof'].includes(op)) {
        if (typeof arg === 'string') {
            instruction.arg = mapped(replaceClassesInDescriptor(arg, classNames));
        } else if (Array.isArray(arg)) {
            instruction.arg = arg.map((value) =>
                typeof value === 'string'
                    ? mapped(replaceClassesInDescriptor(value, classNames))
                    : value);
        }
    } else if ((op.startsWith('invoke') || op.startsWith('get') || op.startsWith('put'))
        && Array.isArray(arg)) {
        if (typeof arg[1] === 'string') arg[1] = mapped(arg[1]);
        if (Array.isArray(arg[2]) && typeof arg[2][1] === 'string') {
            arg[2][1] = replaceClassesInDescriptor(arg[2][1], classNames);
        }
    } else if (op === 'multianewarray' && Array.isArray(arg)) {
        instruction.arg = arg.map((value) =>
            typeof value === 'string'
                ? mapped(replaceClassesInDescriptor(value, classNames))
                : value);
    }
}

function rewriteClassMetadataBulk(value, classNames, key = null) {
    if (typeof value === 'string') {
        const descriptorRewritten = replaceClassesInDescriptor(value, classNames);
        if (descriptorRewritten !== value) return descriptorRewritten;
        const classNameKeys = new Set([
            'className', 'superClassName', 'owner', 'catchType', 'catch_type', 'enclosingClass',
            'innerClass', 'outerClass',
        ]);
        if (classNameKeys.has(key) && classNames.has(value)) return classNames.get(value);
        for (const [oldName, newName] of classNames) {
            if (value === `"${oldName}.java"`) return `"${newName}.java"`;
        }
        return value;
    }
    if (Array.isArray(value)) {
        const classNameLists = new Set(['interfaces', 'exceptions']);
        return value.map((item) => {
            if (classNameLists.has(key) && classNames.has(item)) return classNames.get(item);
            return rewriteClassMetadataBulk(item, classNames, key);
        });
    }
    if (!value || typeof value !== 'object') return value;

    if (value.instruction) {
        rewriteInstructionClassReferencesBulk(value.instruction, classNames);
    }
    for (const [childKey, childValue] of Object.entries(value)) {
        value[childKey] = rewriteClassMetadataBulk(childValue, classNames, childKey);
    }
    return value;
}

function renameClasses(workspace, renames) {
    const classNames = new Map((renames || []).map((rename) => [
        rename.oldName,
        rename.newName,
    ]));
    if (classNames.size === 0) return;
    for (const workspaceEntry of Object.values(workspace.workspaceASTs)) {
        rewriteClassMetadataBulk(workspaceEntry.ast, classNames);
    }
}

function renameClass(workspace, oldClassName, newClassName) {
    const { workspaceASTs } = workspace;

    const symbolIdentifier = new SymbolIdentifier(oldClassName);
    const references = workspace.findReferences(symbolIdentifier);

    references.forEach(ref => {
        const workspaceEntry = workspaceASTs[ref.className];
        if (!workspaceEntry) return;
        const ast = workspaceEntry.ast;

        const targetNode = getValueByPath(ast, ref.astPath);

        if (targetNode) {
            // Class definition
            if (targetNode.className === oldClassName) {
                targetNode.className = newClassName;

                // Also update the sourcefile attribute if it exists
                const sourceFileAttr = targetNode.items.find(item => item.attribute && item.attribute.type === 'sourcefile');
                if (sourceFileAttr && sourceFileAttr.attribute.value === `"${oldClassName}.java"`) {
                    sourceFileAttr.attribute.value = `"${newClassName}.java"`;
                }
            }
            // Superclass reference
            if (targetNode.superClassName === oldClassName) {
                targetNode.superClassName = newClassName;
            }
            // Interface implementation
            if (targetNode.interfaces && targetNode.interfaces.includes(oldClassName)) {
                const index = targetNode.interfaces.indexOf(oldClassName);
                targetNode.interfaces[index] = newClassName;
            }
            // Instruction using the class
            if (targetNode.instruction) {
                const instruction = targetNode.instruction;
                if ((instruction.op === 'invokespecial' || instruction.op === 'invokevirtual' || instruction.op === 'invokestatic') && Array.isArray(instruction.arg) && instruction.arg[1] === oldClassName) {
                    instruction.arg[1] = newClassName;
                } else if (instruction.arg === oldClassName) {
                    instruction.arg = newClassName;
                } else if (Array.isArray(instruction.arg) && instruction.arg.includes(oldClassName)) {
                    const index = instruction.arg.indexOf(oldClassName);
                    instruction.arg[index] = newClassName;
                }
            }
        }
    });

    // Also find and rename constructor calls
    const constructorSymbol = new SymbolIdentifier(oldClassName, '<init>');
    const constructorRefs = workspace.findReferences(constructorSymbol);
    constructorRefs.forEach(ref => {
        const workspaceEntry = workspaceASTs[ref.className];
        if (!workspaceEntry) return;
        const ast = workspaceEntry.ast;
        const targetNode = getValueByPath(ast, ref.astPath);
        if (targetNode && targetNode.instruction && targetNode.instruction.op === 'invokespecial') {
            if (targetNode.instruction.arg[1] === oldClassName) {
                targetNode.instruction.arg[1] = newClassName;
            }
        }
    });

    for (const workspaceEntry of Object.values(workspaceASTs)) {
        rewriteClassMetadata(workspaceEntry.ast, oldClassName, newClassName);
    }
}

module.exports = { renameClass, renameClasses };
