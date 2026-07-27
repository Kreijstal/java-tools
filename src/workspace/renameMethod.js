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

function renameMethod(workspace, className, oldMethodName, newMethodName, descriptor = null,
    rebuildReferenceGraph = true) {
    const { workspaceASTs } = workspace;

    const symbolIdentifier = new SymbolIdentifier(className, oldMethodName, descriptor);
    const references = workspace.findReferences(symbolIdentifier);

    references.forEach(ref => {
        const workspaceEntry = workspaceASTs[ref.className];
        if (!workspaceEntry) return;
        const ast = workspaceEntry.ast;

        const targetNode = getValueByPath(ast, ref.astPath);

        if (targetNode) {
            if (targetNode.name === oldMethodName && 'descriptor' in targetNode
                && (descriptor === null || targetNode.descriptor === descriptor)) { // Definition
                targetNode.name = newMethodName;
            } else if (targetNode.instruction) { // Call site
                const instruction = targetNode.instruction;
                if (instruction.op && instruction.op.startsWith('invoke') && instruction.arg && Array.isArray(instruction.arg)) {
                    if (Array.isArray(instruction.arg[2])) {
                        const [methodName, methodDescriptor] = instruction.arg[2];
                        if (methodName === oldMethodName
                            && (descriptor === null || methodDescriptor === descriptor)) {
                            instruction.arg[2][0] = newMethodName;
                        }
                    }
                }
            }
        }
    });

    if (rebuildReferenceGraph) workspace._buildBasicReferenceGraph();
}

function methodKey(owner, name, descriptor) {
    return `${owner}\u0000${name}\u0000${descriptor}`;
}

function resolveMethodRename(workspace, owner, name, descriptor, renames, visited = new Set()) {
    if (!owner || visited.has(owner)) return null;
    visited.add(owner);
    const direct = renames.get(methodKey(owner, name, descriptor));
    if (direct) return direct;
    const entry = workspace.workspaceASTs[owner];
    if (!entry) return null;
    const cls = entry.ast.classes[0];
    for (const interfaceName of cls.interfaces || []) {
        const inherited = resolveMethodRename(
            workspace, interfaceName, name, descriptor, renames, visited,
        );
        if (inherited) return inherited;
    }
    return resolveMethodRename(
        workspace, cls.superClassName, name, descriptor, renames, visited,
    );
}

function rewriteMethodCalls(value, workspace, renames) {
    if (!value || typeof value !== 'object') return;
    if (value.instruction) {
        const instruction = value.instruction;
        if (instruction.op && instruction.op.startsWith('invoke')
            && Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2])) {
            const replacement = resolveMethodRename(
                workspace,
                instruction.arg[1],
                instruction.arg[2][0],
                instruction.arg[2][1],
                renames,
            );
            if (replacement) instruction.arg[2][0] = replacement;
        }
    }
    for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
            rewriteMethodCalls(child, workspace, renames);
        }
    }
}

function renameMethods(workspace, mappings) {
    const renames = new Map((mappings || []).map((mapping) => [
        methodKey(mapping.owner, mapping.name, mapping.descriptor),
        mapping.newName,
    ]));
    if (renames.size === 0) return;

    for (const workspaceEntry of Object.values(workspace.workspaceASTs)) {
        const cls = workspaceEntry.ast.classes[0];
        for (const item of cls.items || []) {
            if (!item || item.type !== 'method' || !item.method) continue;
            const replacement = resolveMethodRename(
                workspace,
                cls.className,
                item.method.name,
                item.method.descriptor,
                renames,
            );
            if (replacement) item.method.name = replacement;
        }
        rewriteMethodCalls(workspaceEntry.ast, workspace, renames);
    }
}

module.exports = { renameMethod, renameMethods };
