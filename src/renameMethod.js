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
 /* const classObj = convertedAst.classes.find(cls => cls.className === className);
  if (classObj) {
    const methodObj = classObj.items.find(item => item.type === "method" && item.method.name === oldMethodName);
    if (methodObj) {
      methodObj.method.name = newMethodName;
    }
  }
  */
  const methodRef = referenceObj[className].children[oldMethodName];
  if (!methodRef) {
    console.error(`No referees found for method ${oldMethodName} in class ${className}`);
    return;
  }
//console.log("These are our referees",  methodRef.referees)
  methodRef.referees.forEach(refereePath => {
    var v=getValueByPath(convertedAst,refereePath);
//    console.log("path",refereePath,v)
    if("descriptor" in v && "flags" in v){
      //its a class
      v.name=newMethodName;


    }else if ("instruction" in v){
      //its an instruction
      //since we are changing a method it must be a instructon that summons method like invokevirtual or something like that
//      assert(v.instruction.op) is an invoke instruction
      v.instruction.arg[2][0]=newMethodName;

    }
    
  });

  // Rename the method in the reference object
  referenceObj[className].children[newMethodName] = methodRef;
  delete referenceObj[className].children[oldMethodName];


  // Clear old referees
  methodRef.referees = [];
  // console.log(JSON.stringify(referenceObj, null, 1));
  console.log(`Renamed method ${oldMethodName} to ${newMethodName} in class ${className}`);

}

module.exports = { renameMethod };
