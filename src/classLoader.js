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
  const constantPool = classFileStruct.constant_pool;
  
  // Helper function to resolve constant pool entries
  function resolveConstant(index) {
    if (index === 0 || !constantPool[index - 1]) return null;
    const entry = constantPool[index - 1];
    
    switch (entry.tag) {
      case 1: // Utf8
        return entry.info.bytes;
      case 3: // Integer
        return entry.info.bytes;
      case 8: // String ref
        return resolveConstant(entry.info.string_index);
      default:
        return null;
    }
  }
  
  // Parse annotation structure
  function parseAnnotation(annotation) {
    const typeName = resolveConstant(annotation.type_index);
    const elements = {};
    
    if (annotation.element_value_pairs) {
      annotation.element_value_pairs.forEach(pair => {
        const elementName = resolveConstant(pair.element_name_index);
        const elementValue = parseElementValue(pair.value);
        elements[elementName] = elementValue;
      });
    }
    
    return {
      type: typeName,
      elements: elements
    };
  }
  
  // Parse element value based on tag
  function parseElementValue(elementValue) {
    const tag = elementValue.tag;
    
    switch (tag) {
      case 115: // 's' - String
        return {
          tag: 's',
          stringValue: resolveConstant(elementValue.value.const_value_index)
        };
      case 73: // 'I' - Integer
        return {
          tag: 'I', 
          intValue: resolveConstant(elementValue.value.const_value_index)
        };
      case 90: // 'Z' - Boolean
        return {
          tag: 'Z',
          booleanValue: resolveConstant(elementValue.value.const_value_index) !== 0
        };
      default:
        return { tag: tag, value: null };
    }
  }
  
  const result = {
    classAnnotations: [],
    fieldAnnotations: {},
    methodAnnotations: {}
  };
  
  // Parse field annotations
  if (classFileStruct.fields) {
    classFileStruct.fields.forEach((field, fieldIndex) => {
      if (field.attributes) {
        field.attributes.forEach(attr => {
          if (attr.attribute_name_index?.name?.info?.bytes === 'RuntimeVisibleAnnotations') {
            const fieldName = resolveConstant(field.name_index);
            result.fieldAnnotations[fieldName] = attr.info.annotations.map(parseAnnotation);
          }
        });
      }
    });
  }
  
  // Parse method annotations  
  if (classFileStruct.methods) {
    classFileStruct.methods.forEach((method, methodIndex) => {
      if (method.attributes) {
        method.attributes.forEach(attr => {
          if (attr.attribute_name_index?.name?.info?.bytes === 'RuntimeVisibleAnnotations') {
            const methodName = resolveConstant(method.name_index);
            result.methodAnnotations[methodName] = attr.info.annotations.map(parseAnnotation);
          }
        });
      }
    });
  }
  
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
