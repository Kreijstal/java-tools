const { getAST } = require('jvm_parser'); 
const { convertJson } = require('./convert_tree');
const NodeFileProvider = require('./NodeFileProvider');

// Global FileProvider instance - can be overridden for different environments
let globalFileProvider = null;

/**
 * Set the global FileProvider instance for all class loading operations
 * @param {FileProvider} provider - FileProvider implementation
 */
function setFileProvider(provider) {
  globalFileProvider = provider;
}

/**
 * Get the current FileProvider instance, creating a default Node.js one if needed
 * @returns {FileProvider} - Current FileProvider instance
 */
function getFileProvider() {
  if (!globalFileProvider) {
    globalFileProvider = new NodeFileProvider();
  }
  return globalFileProvider;
}

async function loadClass(className, classPath) {
  const fileProvider = getFileProvider();
  
  // Split the class path by ';' to handle multiple paths
  const classPaths = classPath.split(';');

  for (const cp of classPaths) {
    // Construct the class file path
    const classFilePath = fileProvider.joinPath(cp, `${className.replace(/\./g, '/')}.class`);

    // Check if the class file exists
    if (await fileProvider.exists(classFilePath)) {
      // Read the class file content
      const classFileContent = await fileProvider.readFile(classFilePath);

      // Generate the AST
      const ast = getAST(classFileContent);

      // Convert the AST
      const convertedAst = convertJson(ast.ast, ast.constantPool);

      return convertedAst;
    }
  }

  console.error(`Class file not found for class: ${className}`);
  return null;
}

async function loadClassByPath(classFilePath, options = {}) {
  const fileProvider = getFileProvider();

  if (!(await fileProvider.exists(classFilePath))) {
    console.error(`Class file not found: ${classFilePath}`);
    return null;
  }

  // Read the class file content
  const classFileContent = await fileProvider.readFile(classFilePath);

  // Generate the AST
  const ast = getAST(classFileContent);

  // Convert the AST
  const convertedAst = convertJson(ast.ast, ast.constantPool);

  return convertedAst;
}

// Synchronous versions for backwards compatibility with existing Node.js code
function loadClassByPathSync(classFilePath, options = {}) {
  const fileProvider = getFileProvider();
  
  // For Node.js FileProvider, use sync methods
  if (fileProvider.existsSync && fileProvider.readFileSync) {
    if (!fileProvider.existsSync(classFilePath)) {
      console.error(`Class file not found: ${classFilePath}`);
      return null;
    }

    // Read the class file content
    const classFileContent = fileProvider.readFileSync(classFilePath);

    // Generate the AST
    const ast = getAST(classFileContent);

    // Convert the AST
    const convertedAst = convertJson(ast.ast, ast.constantPool);

    return convertedAst;
  } else {
    throw new Error('Synchronous file operations not supported by current FileProvider');
  }
}

module.exports = { 
  loadClass, 
  loadClassByPath, 
  loadClassByPathSync, 
  setFileProvider, 
  getFileProvider 
};
