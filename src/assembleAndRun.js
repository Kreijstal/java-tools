const fs = require('fs');
const { execSync } = require('child_process');
const { unparseDataStructures } = require('./convert_tree');
const path = require('path');
 
function assembleClasses(root, baseOutputDir = '.') {
  root.classes.forEach(cls => {
    const fullClassName = cls.className.replace(/\//g, '.');
    const packagePath = fullClassName.substring(0, fullClassName.lastIndexOf('.'));
    const simpleClassName = fullClassName.substring(fullClassName.lastIndexOf('.') + 1);
    
    const packageDir = path.join(baseOutputDir, ...packagePath.split('.'));
    const jFileName = path.join(packageDir, `${simpleClassName}.j`);
    const classFileName = path.join(packageDir, `${simpleClassName}.class`);

    // Ensure the package directory exists
    fs.mkdirSync(packageDir, { recursive: true });

    // Unparse the class to a .j file
    const jContent = unparseDataStructures(cls);
    fs.writeFileSync(jFileName, jContent);

    // Execute krak2 asm command with the specified output directory
    execSync(`krak2 asm ${jFileName} --out ${classFileName}`);
  });
}

function runClass(startingClassName) {
  execSync(`java ${startingClassName}`, { stdio: 'inherit' });
}

module.exports = { assembleClasses, runClass };
