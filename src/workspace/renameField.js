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

function renameField(workspace, className, oldFieldName, newFieldName, descriptor = null,
    rebuildReferenceGraph = true) {
    const { workspaceASTs } = workspace;

    const symbolIdentifier = new SymbolIdentifier(className, oldFieldName, descriptor);
    const references = workspace.findReferences(symbolIdentifier);

    references.forEach(ref => {
        const workspaceEntry = workspaceASTs[ref.className];
        if (!workspaceEntry) return;
        const ast = workspaceEntry.ast;

        const targetNode = getValueByPath(ast, ref.astPath);

        if (targetNode) {
            if (targetNode.name === oldFieldName && 'descriptor' in targetNode
                && (descriptor === null || targetNode.descriptor === descriptor)) { // Definition
                targetNode.name = newFieldName;
            } else if (targetNode.instruction) { // Access site
                const instruction = targetNode.instruction;
                if (instruction.op && (instruction.op.startsWith('get') || instruction.op.startsWith('put'))) {
                    if (instruction.arg && Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2])) {
                        const [fieldName, fieldDescriptor] = instruction.arg[2];
                        if (fieldName === oldFieldName
                            && (descriptor === null || fieldDescriptor === descriptor)) {
                            instruction.arg[2][0] = newFieldName;
                        }
                    }
                }
            }
        }
    });

    if (rebuildReferenceGraph) workspace._buildBasicReferenceGraph();
}

function fieldKey(owner, name, descriptor) {
    return `${owner}\u0000${name}\u0000${descriptor}`;
}

function resolveFieldOwner(workspace, owner, name, descriptor, visited = new Set()) {
    if (!owner || visited.has(owner)) return null;
    visited.add(owner);
    const entry = workspace.workspaceASTs[owner];
    if (!entry) return null;
    const cls = entry.ast.classes[0];
    const definedHere = (cls.items || []).some((item) =>
        item && item.type === 'field' && item.field
        && item.field.name === name && item.field.descriptor === descriptor);
    if (definedHere) return owner;
    for (const interfaceName of cls.interfaces || []) {
        const resolved = resolveFieldOwner(
            workspace, interfaceName, name, descriptor, visited,
        );
        if (resolved) return resolved;
    }
    return resolveFieldOwner(workspace, cls.superClassName, name, descriptor, visited);
}

function rewriteFieldAccesses(value, workspace, renames) {
    if (!value || typeof value !== 'object') return;
    if (value.instruction) {
        const instruction = value.instruction;
        if (instruction.op && (instruction.op.startsWith('get') || instruction.op.startsWith('put'))
            && Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2])) {
            const declaringOwner = resolveFieldOwner(
                workspace,
                instruction.arg[1],
                instruction.arg[2][0],
                instruction.arg[2][1],
            );
            const replacement = declaringOwner && renames.get(fieldKey(
                declaringOwner, instruction.arg[2][0], instruction.arg[2][1],
            ));
            if (replacement) instruction.arg[2][0] = replacement;
        }
    }
    for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
            rewriteFieldAccesses(child, workspace, renames);
        }
    }
}

function renameFields(workspace, mappings) {
    const renames = new Map((mappings || []).map((mapping) => [
        fieldKey(mapping.owner, mapping.name, mapping.descriptor),
        mapping.newName,
    ]));
    if (renames.size === 0) return;

    for (const workspaceEntry of Object.values(workspace.workspaceASTs)) {
        rewriteFieldAccesses(workspaceEntry.ast, workspace, renames);
    }
    for (const workspaceEntry of Object.values(workspace.workspaceASTs)) {
        const cls = workspaceEntry.ast.classes[0];
        for (const item of cls.items || []) {
            if (!item || item.type !== 'field' || !item.field) continue;
            const replacement = renames.get(fieldKey(
                cls.className,
                item.field.name,
                item.field.descriptor,
            ));
            if (replacement) item.field.name = replacement;
        }
    }
}

module.exports = { renameField, renameFields };
