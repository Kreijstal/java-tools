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
}

module.exports = { renameClass };
