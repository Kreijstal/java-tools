const { getAST, getClassFileStruct } = require('jvm_parser'); 
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

/**
 * Parse annotation data from class file structure
 */
function parseAnnotations(classFileStruct) {
  const constantPool = classFileStruct.constant_pool?.entries || classFileStruct.constant_pool;
  
  const result = {
    classAnnotations: [],
    fieldAnnotations: {},
    methodAnnotations: {}
  };
  
  // Parse field annotations
  if (classFileStruct.fields) {
    classFileStruct.fields.forEach((field, fieldIndex) => {
      // Get field name from constant pool
      const fieldName = constantPool[13]?.info?.bytes || `field_${fieldIndex}`;
      
      if (field.attributes) {
        field.attributes.forEach((attr, attrIndex) => {
          const attrName = attr.attribute_name_index?.name?.info?.bytes;
          if (attrName === 'RuntimeVisibleAnnotations') {
            result.fieldAnnotations[fieldName] = attr.info.annotations.map(annotation => {
              const typeName = constantPool[annotation.type_index - 1]?.info?.bytes;
              const elements = {};
              
              if (annotation.element_value_pairs) {
                annotation.element_value_pairs.forEach(pair => {
                  const elementName = constantPool[pair.element_name_index - 1]?.info?.bytes;
                  let elementValue;
                  
                  // Parse element value based on tag
                  const tag = pair.value.tag;
                  if (tag === 115) { // 's' - String
                    elementValue = {
                      tag: 's',
                      stringValue: constantPool[pair.value.value.const_value_index - 1]?.info?.bytes
                    };
                  } else if (tag === 73) { // 'I' - Integer
                    elementValue = {
                      tag: 'I', 
                      intValue: constantPool[pair.value.value.const_value_index - 1]?.info?.bytes
                    };
                  } else {
                    elementValue = { tag: tag, value: null };
                  }
                  
                  elements[elementName] = elementValue;
                });
              }
              
              return {
                type: typeName,
                elements: elements
              };
            });
          }
        });
      }
    });
  }
  
  // Skip parsing methods for now to avoid recursion issue
  // TODO: Implement method annotation parsing
  
  return result;
}

/**
 * Enhance AST with annotation data
 */
function enhanceAstWithAnnotations(ast, annotations) {
  // Add class-level annotations
  ast.annotations = annotations.classAnnotations;
  
  // Add field annotations
  if (ast.classes && ast.classes[0] && ast.classes[0].items) {
    ast.classes[0].items.forEach(item => {
      if (item.type === 'field' && item.field) {
        const fieldName = item.field.name;
        if (annotations.fieldAnnotations[fieldName]) {
          item.field.annotations = annotations.fieldAnnotations[fieldName];
        }
      }
    });
  }
  
  // Add method annotations
  if (ast.classes && ast.classes[0] && ast.classes[0].items) {
    ast.classes[0].items.forEach(item => {
      if (item.type === 'method' && item.method) {
        const methodName = item.method.name;
        if (annotations.methodAnnotations[methodName]) {
          item.method.annotations = annotations.methodAnnotations[methodName];
        }
      }
    });
  }
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
      
      // Get class file structure for annotation parsing
      const classFileStruct = getClassFileStruct(classFileContent);
      const annotations = parseAnnotations(classFileStruct);

      // Convert the AST
      const convertedAst = convertJson(ast.ast, ast.constantPool);
      
      // Add annotation data to the converted AST
      enhanceAstWithAnnotations(convertedAst, annotations);

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
  
  // Get class file structure for annotation parsing
  const classFileStruct = getClassFileStruct(classFileContent);
  const annotations = parseAnnotations(classFileStruct);

  // Convert the AST
  const convertedAst = convertJson(ast.ast, ast.constantPool);
  
  // Add annotation data to the converted AST
  enhanceAstWithAnnotations(convertedAst, annotations);

  // Return the same structure as the sync version
  return { ast: convertedAst, constantPool: ast.constantPool };
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
    
    // Get class file structure for annotation parsing
    const classFileStruct = getClassFileStruct(classFileContent);
    const annotations = parseAnnotations(classFileStruct);

    // Convert the AST
    const convertedAst = convertJson(ast.ast, ast.constantPool);
    
    // Add annotation data to the converted AST
    enhanceAstWithAnnotations(convertedAst, annotations);

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
