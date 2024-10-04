const fs = require('fs');
const path = require('path');
const { getAST } = require('./astGenerator'); // Assuming this is the correct module
const { convertJson } = require('./convert_tree');

function loadClass(className, classPath) {
  console.log(`Attempt to load class ${className}`);

  // If the class name path starts with java, we ignore it for now
  if (className.startsWith('java')) {
    console.log(`Ignoring system class: ${className}`);
    return null;
  }

  // Construct the class file path
  const classFilePath = path.join(classPath, `${className.replace(/\./g, '/')}.class`);

  // Check if the class file exists
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

  console.log(`Attempt to load class ${className}`);
//if the class name path starts with java we ignore it for now
  //we look into our classpath and attempt to find the file
  const classFileContent = fs.readFileSync(classFilePath);
  const ast = getAST(new Uint8Array(classFileContent));
  const convertedAst = convertJson(ast.ast, ast.constantPool);
  return convertedAst;
}

module.exports = { loadClass };
