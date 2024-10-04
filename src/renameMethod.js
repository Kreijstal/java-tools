const fs = require('fs');

function renameMethod(convertedAst, referenceObj, className, oldMethodName, newMethodName) {
  if (!referenceObj[className]) {
    console.error(`Class ${className} not found in referenceObj`);
    return;
  }
  
  if (!referenceObj[className].children[oldMethodName]) {
    console.error(`Method ${oldMethodName} not found in class ${className}`);
    console.log(`Available methods: ${Object.keys(referenceObj[className].children).join(', ')}`);
    return;
  }

  // Rename the method in the convertedAst
  const classObj = convertedAst.classes.find(cls => cls.className === className);
  if (classObj) {
    const methodObj = classObj.items.find(item => item.type === "method" && item.method.name === oldMethodName);
    if (methodObj) {
      methodObj.method.name = newMethodName;
    }
  }
  referenceObj[className].children[newMethodName] = referenceObj[className].children[oldMethodName];
  delete referenceObj[className].children[oldMethodName];

  // Rename the method in the reference object
  const methodRef = referenceObj[className].children[oldMethodName];
  if (!methodRef) {
    console.error(`No referees found for method ${oldMethodName} in class ${className}`);
    return;
  }

  methodRef.referees.forEach(refereePath => {
    const pathParts = refereePath.split('.');
    const methodIndex = pathParts.findIndex(part => part === oldMethodName);
    if (methodIndex !== -1) {
      pathParts[methodIndex] = newMethodName;
      const newPath = pathParts.join('.');
      referenceObj[className].children[newMethodName].referees.push(newPath);

      // Update the method name in the convertedAst using the referee path
      let current = convertedAst;
      for (const part of pathParts) {
        if (current && typeof current === 'object') {
          current = current[part];
        }
      }
      if (current && current.method) {
        current.method.name = newMethodName;
      }
    }
  });

  // Remove old referees
  referenceObj[className].children[newMethodName].referees = referenceObj[className].children[newMethodName].referees.filter(refereePath => !refereePath.includes(oldMethodName));

  console.log(`Renamed method ${oldMethodName} to ${newMethodName} in class ${className}`);
}

module.exports = { renameMethod };
