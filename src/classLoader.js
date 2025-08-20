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
    if (!index) return undefined;
    
    // For annotation element names, the index points directly to the UTF-8 entry
    // So we need to use 0-based indexing (no -1 adjustment)
    const entry = constantPool[index];
    if (!entry) return undefined;
    
    // Handle UTF8 entries directly
    if (entry.tag === 1) {
      return entry.info.bytes;
    }
    
    // Handle NameAndType entries that point to UTF8
    if (entry.tag === 12) {
      const nameEntry = constantPool[entry.info.name_index];
      return nameEntry?.info?.bytes;
    }
    
    return undefined;
  }
  
  // Helper function to resolve annotation element values
  function resolveAnnotationValue(tag, valueIndex) {
    // For annotation values, use 0-based indexing as well
    const entry = constantPool[valueIndex];
    if (!entry) return undefined;
    
    if (tag === 115) { // 's' - String
      return entry.tag === 1 ? entry.info.bytes : undefined;
    } else if (tag === 73) { // 'I' - Integer
      return entry.tag === 3 ? entry.info.bytes : undefined;
    }
    
    return entry.info;
  }
  
  // Helper function specifically for annotation type resolution
  function resolveAnnotationType(index) {
    // There seems to be an off-by-one issue with annotation type_index in jvm-parser
    // Try both the given index and index+1
    let entry = constantPool[index - 1];
    if (entry && entry.tag === 1 && entry.info?.bytes?.startsWith('L') && entry.info?.bytes?.endsWith(';')) {
      return entry.info.bytes.replace(/^L|;$/g, '');
    }
    
    // Try the next index
    entry = constantPool[index];
    if (entry && entry.tag === 1 && entry.info?.bytes?.startsWith('L') && entry.info?.bytes?.endsWith(';')) {
      return entry.info.bytes.replace(/^L|;$/g, '');
    }
    
    return resolveString(index);
  }
  
  // Parse class-level annotations from the new AST structure
  if (ast.ast.attributes) {
    ast.ast.attributes.forEach(attr => {
      const attrName = attr.attribute_name_index?.name?.info?.bytes;
      if (attrName === 'RuntimeVisibleAnnotations' && attr.info?.annotations) {
        result.classAnnotations = attr.info.annotations.map(annotation => {
          const typeName = resolveAnnotationType(annotation.type_index);
          const elements = {};

          if (annotation.element_value_pairs) {
            annotation.element_value_pairs.forEach(pair => {
              const elementName = resolveString(pair.element_name_index);

              // Parse element value based on tag
              const tag = pair.value.tag;
              const elementValue = resolveAnnotationValue(tag, pair.value.value.const_value_index);

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
      const attrName = attr.attribute_name_index?.name?.info?.bytes;
      if (attrName === 'RuntimeVisibleAnnotations' && attr.info?.annotations) {
        result.classAnnotations = attr.info.annotations.map(annotation => {
          const typeName = resolveAnnotationType(annotation.type_index);
          const elements = {};

          if (annotation.element_value_pairs) {
            annotation.element_value_pairs.forEach(pair => {
              const elementName = resolveString(pair.element_name_index);

              // Parse element value based on tag
              const tag = pair.value.tag;
              const elementValue = resolveAnnotationValue(tag, pair.value.value.const_value_index);

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
          const attrName = attr.attribute_name_index?.name?.info?.bytes;
          if (attrName === 'RuntimeVisibleAnnotations' && attr.info?.annotations) {
            result.fieldAnnotations[fieldName] = attr.info.annotations.map(annotation => {
              const typeName = resolveAnnotationType(annotation.type_index);
              const elements = {};
              
              if (annotation.element_value_pairs) {
                annotation.element_value_pairs.forEach(pair => {
                  const elementName = resolveString(pair.element_name_index);
                  
                  // Parse element value based on tag
                  const tag = pair.value.tag;
                  const elementValue = resolveAnnotationValue(tag, pair.value.value.const_value_index);
                  
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
          const attrName = attr.attribute_name_index?.name?.info?.bytes;
          if (attrName === 'RuntimeVisibleAnnotations' && attr.info?.annotations) {
            result.methodAnnotations[methodName] = attr.info.annotations.map(annotation => {
              const typeName = resolveAnnotationType(annotation.type_index);
              const elements = {};
              
              if (annotation.element_value_pairs) {
                annotation.element_value_pairs.forEach(pair => {
                  const elementName = resolveString(pair.element_name_index);
                  
                  const tag = pair.value.tag;
                  const elementValue = resolveAnnotationValue(tag, pair.value.value.const_value_index);
                  
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
  if (convertedAst.classes && convertedAst.classes[0] && convertedAst.classes[0].items) {
    // Old structure: classes[0].items[]
    convertedAst.classes[0].items.forEach(item => {
      if (item.type === 'field' && item.field) {
        const fieldName = item.field.name;
        if (annotations.fieldAnnotations[fieldName]) {
          item.field.annotations = annotations.fieldAnnotations[fieldName];
        }
      }
    });
  }
  
  // Add method annotations - handle both old and new AST structures
  if (convertedAst.classes && convertedAst.classes[0] && convertedAst.classes[0].items) {
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
  if (fileProvider.existsSync && fileProvider.readFileSync) {
    if (!fileProvider.existsSync(classFilePath)) {
      console.error(`Class file not found: ${classFilePath}`);
      return null;
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
