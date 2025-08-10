const fs = require('fs');
const path = require('path');
const { getAST } = require('jvm_parser'); 
const { convertJson } = require('./convert_tree');

function loadClass(className, classPath) {
  console.log(`Attempt to load class ${className}`);

  // If the class name path starts with java, we ignore it for now
  if (className.startsWith('java')) {
    console.log(`Ignoring system class: ${className}`);
    return null;
  }

  // Split the class path by ';' to handle multiple paths
  const classPaths = classPath.split(';');

  for (const cp of classPaths) {
    // Construct the class file path
    const classFilePath = path.join(cp, `${className.replace(/\./g, '/')}.class`);

    // Check if the class file exists
    if (fs.existsSync(classFilePath)) {
      // Read the class file content
      const classFileContent = fs.readFileSync(classFilePath);

      // Generate the AST
      const ast = getAST(new Uint8Array(classFileContent));

      // Convert the AST
      const convertedAst = convertJson(ast.ast, ast.constantPool);

      return convertedAst;
    }
  }

  console.error(`Class file not found for class: ${className}`);
  return null;
}

function loadClassByPath(classFilePath, options = {}) {
  if (!options.silent) {
    console.log(`Attempt to load class from file: ${classFilePath}`);
  }

  if (!fs.existsSync(classFilePath)) {
    console.error(`Class file not found: ${classFilePath}`);
    return null;
  }

  // Read the class file content
  const classFileContent = fs.readFileSync(classFilePath);

  // Generate the AST
  const ast = getAST(new Uint8Array(classFileContent));

  // Convert the AST
  const convertedAst = convertJson(ast.ast, ast.constantPool);

  return convertedAst;
}

module.exports = { loadClass, loadClassByPath };
