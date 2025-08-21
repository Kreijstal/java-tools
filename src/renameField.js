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

function renameField(workspace, className, oldFieldName, newFieldName) {
    const { workspaceASTs } = workspace;

    const symbolIdentifier = new SymbolIdentifier(className, oldFieldName);
    const references = workspace.findReferences(symbolIdentifier);

    references.forEach(ref => {
        const workspaceEntry = workspaceASTs[ref.className];
        if (!workspaceEntry) return;
        const ast = workspaceEntry.ast;

        const targetNode = getValueByPath(ast, ref.astPath);

        if (targetNode) {
            if (targetNode.name === oldFieldName && 'descriptor' in targetNode) { // Definition
                targetNode.name = newFieldName;
            } else if (targetNode.instruction) { // Access site
                const instruction = targetNode.instruction;
                if (instruction.op && (instruction.op.startsWith('get') || instruction.op.startsWith('put'))) {
                    if (instruction.arg && Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2])) {
                        const [fieldName] = instruction.arg[2];
                        if (fieldName === oldFieldName) {
                            instruction.arg[2][0] = newFieldName;
                        }
                    }
                }
            }
        }
    });

    workspace._buildBasicReferenceGraph();
}

module.exports = { renameField };
