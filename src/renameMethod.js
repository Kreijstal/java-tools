const fs = require('fs');

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

function renameMethod(workspaceAsts, referenceObj, className, oldMethodName, newMethodName) {
  if (!referenceObj[className]) {
    throw new Error(`Class ${className} not found in referenceObj`);
  }

  // Handle both Map and plain object structures
  const children = referenceObj[className].children;
  const isMap = children instanceof Map;
  
  if (isMap ? children.has(newMethodName) : children[newMethodName]) {
    throw new Error(`Method ${newMethodName} already exists in class ${className}`);
  }

  // TODO: Handle inheritance. This implementation only renames direct references
  // and does not account for polymorphism.
  // Basic inheritance support: check if method calls on superclasses should also be renamed
  function shouldRenameMethodCall(callTargetClass, callMethodName, renameTargetClass, renameMethodName) {
    // Direct match
    if (callTargetClass === renameTargetClass && callMethodName === renameMethodName) {
      return true;
    }
    
    // For now, we could add basic superclass checking here, but it requires
    // access to the workspace hierarchy which isn't available in this context.
    // A full implementation would need the workspace reference to check inheritance.
    return false;
  }

  const methodRef = isMap ? children.get(oldMethodName) : children[oldMethodName];
  if (!methodRef) {
    throw new Error(`Method ${oldMethodName} not found in class ${className}`);
  }

  if (!methodRef.referees) {
    console.error(`No referees found for method ${oldMethodName} in class ${className}`);
    return;
  }

  methodRef.referees.forEach(referee => {
    const ast = workspaceAsts[referee.className];
    if (!ast) {
      console.warn(`AST for class ${referee.className} not found.`);
      return;
    }

    const targetNode = getValueByPath(ast, referee.astPath);
    if (!targetNode) {
      console.warn(`Value not found at path ${referee.astPath} in class ${referee.className}`);
      return;
    }

    // Case 1: Method definition
    // The path points to a method object: { name, descriptor, flags, ... }
    if (targetNode.name === oldMethodName && 'descriptor' in targetNode && 'flags' in targetNode) {
        targetNode.name = newMethodName;
    }
    // Case 2: Method call (instruction)
    // The path points to a codeItem object: { instruction, ... }
    else if (targetNode.instruction) {
      const instruction = targetNode.instruction;
      if (instruction.op && instruction.op.startsWith('invoke') && instruction.arg && Array.isArray(instruction.arg)) {
        const targetClass = instruction.arg[1];
        if (Array.isArray(instruction.arg[2])) {
            const [methodName, descriptor] = instruction.arg[2];
            if (shouldRenameMethodCall(targetClass, methodName, className, oldMethodName)) {
              instruction.arg[2][0] = newMethodName;
            }
        }
      }
    }
  });

  // Update the reference object to reflect the new method name
  if (isMap) {
    if (children.has(oldMethodName)) {
      const methodData = children.get(oldMethodName);
      children.set(newMethodName, methodData);
      children.delete(oldMethodName);
    }
  } else {
    if (children[oldMethodName]) {
      children[newMethodName] = children[oldMethodName];
      delete children[oldMethodName];
    }
  }

  console.log(`Renamed method ${oldMethodName} to ${newMethodName} in class ${className}`);
}

module.exports = { renameMethod };
