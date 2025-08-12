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

  if (referenceObj[className].children[newMethodName]) {
    throw new Error(`Method ${newMethodName} already exists in class ${className}`);
  }

  // TODO: Handle inheritance. This implementation only renames direct references
  // and does not account for polymorphism.

  const methodRef = referenceObj[className].children[oldMethodName];
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
            if (targetClass === className && methodName === oldMethodName) {
              instruction.arg[2][0] = newMethodName;
            }
        }
      }
    }
  });

  // Update the reference object to reflect the new method name
  if (referenceObj[className].children[oldMethodName]) {
    referenceObj[className].children[newMethodName] = referenceObj[className].children[oldMethodName];
    delete referenceObj[className].children[oldMethodName];
  }

  console.log(`Renamed method ${oldMethodName} to ${newMethodName} in class ${className}`);
}

module.exports = { renameMethod };
