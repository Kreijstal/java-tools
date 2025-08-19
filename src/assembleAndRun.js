const fs = require('fs');
const { execSync, execFileSync } = require('child_process');
const { unparseDataStructures } = require('./convert_tree');
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

    // Find Krakatau binary relative to project root
    const krak2Path = path.resolve(__dirname, '../tools/krakatau/Krakatau/target/release/krak2');
    if (!fs.existsSync(krak2Path)) {
      throw new Error(`Krakatau binary not found at ${krak2Path}`);
    }
    // Execute Krakatau asm command with the specified output directory
    // Use execFileSync to avoid shell interpretation of special characters like $
    execFileSync(krak2Path, ['asm', jFileName, '--out', classFileName]);
  });
}

function runClass(startingClassName) {
  execSync(`java ${startingClassName}`, { stdio: 'inherit' });
}

module.exports = { assembleClasses, runClass };
