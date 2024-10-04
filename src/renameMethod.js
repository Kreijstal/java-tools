const fs = require('fs');

function renameMethod(referenceObj, className, oldMethodName, newMethodName) {
  if (!referenceObj[className] || !referenceObj[className].children[oldMethodName]) {
    console.error(`Method ${oldMethodName} not found in class ${className}`);
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
  referenceObj[className].children[oldMethodName].referees.forEach(refereePath => {
    const pathParts = refereePath.split('.');
    const methodIndex = pathParts.findIndex(part => part === oldMethodName);
    if (methodIndex !== -1) {
      pathParts[methodIndex] = newMethodName;
      const newPath = pathParts.join('.');
      referenceObj[className].children[newMethodName].referees.push(newPath);
    }
  });

  // Remove old referees
  referenceObj[className].children[newMethodName].referees = referenceObj[className].children[newMethodName].referees.filter(refereePath => !refereePath.includes(oldMethodName));

  console.log(`Renamed method ${oldMethodName} to ${newMethodName} in class ${className}`);
}

module.exports = { renameMethod };
