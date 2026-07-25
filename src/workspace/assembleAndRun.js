const fs = require('fs');
const { execSync } = require('child_process');
const { unparseDataStructures } = require('../parsing/convert_tree');
const { writeClassAstToClassFile } = require('../parsing/classAstToClassFile');
const path = require('path');
 
function assembleClasses(root, baseOutputDir = '.') {
  root.classes.forEach((cls, index) => {
    const fullClassName = cls.className.replace(/\//g, '.');
    const packagePath = fullClassName.substring(0, fullClassName.lastIndexOf('.'));
    const simpleClassName = fullClassName.substring(fullClassName.lastIndexOf('.') + 1);
    
    const packageDir = path.join(baseOutputDir, ...packagePath.split('.'));
    const jFileName = path.join(packageDir, `${simpleClassName}.j`);
    const classFileName = path.join(packageDir, `${simpleClassName}.class`);

    // Ensure the package directory exists
    fs.mkdirSync(packageDir, { recursive: true });

    // Unparse the class to a .j file, using the corresponding constant pool
    const constantPool = root.constantPools && root.constantPools[index] ? root.constantPools[index] : null;
    const jContent = unparseDataStructures(cls, constantPool);
    fs.writeFileSync(jFileName, jContent);

    // Assemble using the repository's JavaScript class writer.
    writeClassAstToClassFile(cls, classFileName);
  });
}

function runClass(startingClassName) {
  execSync(`java ${startingClassName}`, { stdio: 'inherit' });
}

module.exports = { assembleClasses, runClass };
