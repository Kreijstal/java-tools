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
  /* HARDENED: Added check for provider */
  if (!provider) {
    throw new Error('setFileProvider requires a provider object');
  }
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
 * Parse annotation data from AST with jvm-parser 0.0.11
 */
function parseAnnotationsFromAst(ast) {
  const constantPool = ast.constantPool;
  
  const result = {
    classAnnotations: [],
    fieldAnnotations: {},
    methodAnnotations: {}
  };
  
  // Helper function to resolve string from constant pool
  function resolveString(index) {
    /* HARDENED: Replaced quiet failure with an explicit error */
    if (!index) {
      throw new Error('resolveString requires an index');
    }
    
    // For annotation element names, the index points directly to the UTF-8 entry
    // So we need to use 0-based indexing (no -1 adjustment)
    const entry = constantPool[index];
    /* HARDENED: Replaced quiet failure with an explicit error */
    if (!entry) {
      throw new Error(`resolveString failed: constant pool entry not found at index ${index}`);
    }
    
    // Handle UTF8 entries directly
    if (entry.tag === 1) {
      return entry.info.bytes;
    }
    
    // Handle NameAndType entries that point to UTF8
    if (entry.tag === 12) {
      const nameEntry = constantPool[entry.info.name_index];
      /* HARDENED: Replaced defensive optional chaining with direct access */
      return nameEntry.info.bytes;
    }
    
    /* HARDENED: Replaced quiet failure with an explicit error */
    throw new Error(`resolveString failed: unhandled constant pool entry type ${entry.tag}`);
  }
  
  // Helper function to resolve annotation element values
  function resolveAnnotationValue(tag, valueIndex) {
    // For annotation values, use 0-based indexing as well
    const entry = constantPool[valueIndex];
    /* HARDENED: Replaced quiet failure with an explicit error */
    if (!entry) {
      throw new Error(`resolveAnnotationValue failed: constant pool entry not found at index ${valueIndex}`);
    }
    
    if (tag === 115) { // 's' - String
      /* HARDENED: Replaced quiet failure with an explicit error */
      if (entry.tag !== 1) {
        throw new Error(`resolveAnnotationValue failed: expected string at index ${valueIndex}, but found tag ${entry.tag}`);
      }
      return entry.info.bytes;
    } else if (tag === 73) { // 'I' - Integer
      /* HARDENED: Replaced quiet failure with an explicit error */
      if (entry.tag !== 3) {
        throw new Error(`resolveAnnotationValue failed: expected integer at index ${valueIndex}, but found tag ${entry.tag}`);
      }
      return entry.info.bytes;
    }
    
    return entry.info;
  }
  
  // Helper function specifically for annotation type resolution
  function resolveAnnotationType(index) {
    // There seems to be an off-by-one issue with annotation type_index in jvm-parser
    // Try both the given index and index+1
    let entry = constantPool[index - 1];
    /* HARDENED: Replaced defensive optional chaining with direct access */
    if (entry && entry.tag === 1 && entry.info.bytes.startsWith('L') && entry.info.bytes.endsWith(';')) {
      return entry.info.bytes.replace(/^L|;$/g, '');
    }
    
    // Try the next index
    entry = constantPool[index];
    /* HARDENED: Replaced defensive optional chaining with direct access */
    if (entry && entry.tag === 1 && entry.info.bytes.startsWith('L') && entry.info.bytes.endsWith(';')) {
      return entry.info.bytes.replace(/^L|;$/g, '');
    }
    
    return resolveString(index);
  }
  
  // Parse class-level annotations from the new AST structure
  if (ast.ast.attributes) {
    ast.ast.attributes.forEach(attr => {
      /* HARDENED: Replaced defensive optional chaining with direct access */
      const attrName = attr.attribute_name_index.name.info.bytes;
      if (attrName === 'RuntimeVisibleAnnotations' && attr.info.annotations) {
        result.classAnnotations = attr.info.annotations.map(annotation => {
          const typeName = resolveAnnotationType(annotation.type_index);
          const elements = {};

          if (annotation.element_value_pairs) {
            annotation.element_value_pairs.forEach(pair => {
              const elementName = resolveString(pair.element_name_index);

              // Parse element value based on tag
              const tag = pair.value.tag;
              let elementValue;
              if (tag === 101) { // 'e' - Enum
                elementValue = {
                  type: 'enum',
                  typeName: resolveString(pair.value.value.type_name_index),
                  constName: resolveString(pair.value.value.const_name_index),
                };
              } else {
                elementValue = resolveAnnotationValue(tag, pair.value.value.const_value_index);
              }

              if (elementName && elementValue !== undefined) {
                elements[elementName] = elementValue;
              }
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

  // Parse class-level annotations from the new AST structure
  if (ast.ast.attributes) {
    ast.ast.attributes.forEach(attr => {
      /* HARDENED: Replaced defensive optional chaining with direct access */
      const attrName = attr.attribute_name_index.name.info.bytes;
      if (attrName === 'RuntimeVisibleAnnotations' && attr.info.annotations) {
        result.classAnnotations = attr.info.annotations.map(annotation => {
          const typeName = resolveAnnotationType(annotation.type_index);
          const elements = {};

          if (annotation.element_value_pairs) {
            annotation.element_value_pairs.forEach(pair => {
              const elementName = resolveString(pair.element_name_index);

              // Parse element value based on tag
              const tag = pair.value.tag;
              let elementValue;
              if (tag === 101) { // 'e' - Enum
                elementValue = {
                  type: 'enum',
                  typeName: resolveString(pair.value.value.type_name_index),
                  constName: resolveString(pair.value.value.const_name_index),
                };
              } else {
                elementValue = resolveAnnotationValue(tag, pair.value.value.const_value_index);
              }

              if (elementName && elementValue !== undefined) {
                elements[elementName] = elementValue;
              }
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

  // Parse field annotations from the new AST structure
  if (ast.ast.fields) {
    ast.ast.fields.forEach(field => {
      const fieldName = field.name;
      
      if (field.attributes) {
        field.attributes.forEach(attr => {
          /* HARDENED: Replaced defensive optional chaining with direct access */
          const attrName = attr.attribute_name_index.name.info.bytes;
          if (attrName === 'RuntimeVisibleAnnotations' && attr.info.annotations) {
            result.fieldAnnotations[fieldName] = attr.info.annotations.map(annotation => {
              const typeName = resolveAnnotationType(annotation.type_index);
              const elements = {};
              
              if (annotation.element_value_pairs) {
                annotation.element_value_pairs.forEach(pair => {
                  const elementName = resolveString(pair.element_name_index);
                  
                  // Parse element value based on tag
                  const tag = pair.value.tag;
                  let elementValue;
                  if (tag === 101) { // 'e' - Enum
                    elementValue = {
                      type: 'enum',
                      typeName: resolveString(pair.value.value.type_name_index),
                      constName: resolveString(pair.value.value.const_name_index),
                    };
                  } else {
                    elementValue = resolveAnnotationValue(tag, pair.value.value.const_value_index);
                  }
                  
                  if (elementName && elementValue !== undefined) {
                    elements[elementName] = elementValue;
                  }
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
  
  // Parse method annotations from the new AST structure
  if (ast.ast.methods) {
    ast.ast.methods.forEach(method => {
      const methodName = method.name;
      
      if (method.attributes) {
        method.attributes.forEach(attr => {
          /* HARDENED: Replaced defensive optional chaining with direct access */
          const attrName = attr.attribute_name_index.name.info.bytes;
          if (attrName === 'RuntimeVisibleAnnotations' && attr.info.annotations) {
            result.methodAnnotations[methodName] = attr.info.annotations.map(annotation => {
              const typeName = resolveAnnotationType(annotation.type_index);
              const elements = {};
              
              if (annotation.element_value_pairs) {
                annotation.element_value_pairs.forEach(pair => {
                  const elementName = resolveString(pair.element_name_index);
                  
                  const tag = pair.value.tag;
                  let elementValue;
                  if (tag === 101) { // 'e' - Enum
                    elementValue = {
                      type: 'enum',
                      typeName: resolveString(pair.value.value.type_name_index),
                      constName: resolveString(pair.value.value.const_name_index),
                    };
                  } else {
                    elementValue = resolveAnnotationValue(tag, pair.value.value.const_value_index);
                  }
                  
                  if (elementName && elementValue !== undefined) {
                    elements[elementName] = elementValue;
                  }
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
  
  return result;
}

/**
 * Enhance convertedAst with annotation data
 */
function enhanceAstWithAnnotations(convertedAst, annotations) {
  // Add class-level annotations
  convertedAst.annotations = annotations.classAnnotations;
  
  // Add field annotations - handle both old and new AST structures
  /* HARDENED: Removed defensive check */
  // Old structure: classes[0].items[]
  convertedAst.classes[0].items.forEach(item => {
    if (item.type === 'field' && item.field) {
      const fieldName = item.field.name;
      if (annotations.fieldAnnotations[fieldName]) {
        item.field.annotations = annotations.fieldAnnotations[fieldName];
      }
    }
  });
  
  // Add method annotations - handle both old and new AST structures
  /* HARDENED: Removed defensive check */
  // Old structure: classes[0].items[]
  convertedAst.classes[0].items.forEach(item => {
    if (item.type === 'method' && item.method) {
      const methodName = item.method.name;
      if (annotations.methodAnnotations[methodName]) {
        item.method.annotations = annotations.methodAnnotations[methodName];
      }
    }
  });
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
      
      // Parse annotations from the new AST structure
      const annotations = parseAnnotationsFromAst(ast);

      // Convert the AST
      const convertedAst = convertJson(ast.ast, ast.constantPool);
      
      // Add annotation data to the converted AST
      enhanceAstWithAnnotations(convertedAst, annotations);

      return convertedAst;
    }
  }

  /* HARDENED: Replaced quiet failure with an explicit error */
  throw new Error(`Class file not found for class: ${className}`);
}

async function loadClassByPath(classFilePath, options = {}) {
  const fileProvider = getFileProvider();

  if (!(await fileProvider.exists(classFilePath))) {
    /* HARDENED: Replaced quiet failure with an explicit error */
    throw new Error(`Class file not found: ${classFilePath}`);
  }

  // Read the class file content
  const classFileContent = await fileProvider.readFile(classFilePath);

  // Generate the AST
  const ast = getAST(classFileContent);
  
  // Parse annotations from the new AST structure
  const annotations = parseAnnotationsFromAst(ast);

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
  /* HARDENED: Removed defensive check */
  if (fileProvider.existsSync && fileProvider.readFileSync) {
    if (!fileProvider.existsSync(classFilePath)) {
      /* HARDENED: Replaced quiet failure with an explicit error */
      throw new Error(`Class file not found: ${classFilePath}`);
    }

    // Read the class file content
    const classFileContent = fileProvider.readFileSync(classFilePath);

    // Generate the AST
    const ast = getAST(classFileContent);
    
    // Parse annotations from the new AST structure
    const annotations = parseAnnotationsFromAst(ast);

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
