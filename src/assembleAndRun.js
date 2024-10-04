const fs = require('fs');
const { execSync } = require('child_process');
const { unparseDataStructures } = require('./convert_tree');

function assembleClasses(root) {
  root.classes.forEach(cls => {
    const className = cls.className.replace(/\//g, '.');
    const jFileName = `${className}.j`;
    const classFileName = `${className}.class`;

    // Unparse the class to a .j file
    const jContent = unparseDataStructures(cls);
    fs.writeFileSync(jFileName, jContent);

    // Log the unparsed .j file content instead of assembling and executing
    console.log(`Unparsed content for ${className}:\n${jContent}\n`);
    // execSync(`krak2 asm ${jFileName} --out ${classFileName}`);
  });
}

function runClass(startingClassName) {
  execSync(`java ${startingClassName}`, { stdio: 'inherit' });
}

module.exports = { assembleClasses, runClass };
