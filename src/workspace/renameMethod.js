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

function renameMethod(workspace, className, oldMethodName, newMethodName) {
    const { workspaceASTs } = workspace;

    const symbolIdentifier = new SymbolIdentifier(className, oldMethodName);
    const references = workspace.findReferences(symbolIdentifier);

    references.forEach(ref => {
        const workspaceEntry = workspaceASTs[ref.className];
        if (!workspaceEntry) return;
        const ast = workspaceEntry.ast;

        const targetNode = getValueByPath(ast, ref.astPath);

        if (targetNode) {
            if (targetNode.name === oldMethodName && 'descriptor' in targetNode) { // Definition
                targetNode.name = newMethodName;
            } else if (targetNode.instruction) { // Call site
                const instruction = targetNode.instruction;
                if (instruction.op && instruction.op.startsWith('invoke') && instruction.arg && Array.isArray(instruction.arg)) {
                    if (Array.isArray(instruction.arg[2])) {
                        const [methodName] = instruction.arg[2];
                        if (methodName === oldMethodName) {
                            instruction.arg[2][0] = newMethodName;
                        }
                    }
                }
            }
        }
    });

    workspace._buildBasicReferenceGraph();
}

module.exports = { renameMethod };
