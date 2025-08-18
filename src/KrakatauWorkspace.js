const fs = require('fs');
const path = require('path');
const { loadClassByPathSync } = require('./classLoader');
const { getReferenceObjFromClass } = require('./traverseAST');
const { unparseDataStructures } = require('./convert_tree');
const { assembleClasses } = require('./assembleAndRun');
const { renameMethod } = require('./renameMethod');

/**
 * Represents a unique identifier for a symbol (class, method, field)
 */
class SymbolIdentifier {
  constructor(className, memberName = null, descriptor = null) {
    this.className = className;
    this.memberName = memberName;
    this.descriptor = descriptor;
  }

  toString() {
    if (this.memberName) {
      return `${this.className}.${this.memberName}${this.descriptor ? `(${this.descriptor})` : ''}`;
    }
    return this.className;
  }
}

/**
 * Represents a location in the AST where a symbol is defined or referenced
 */
class SymbolLocation {
  constructor(className, astPath, line = null, column = null) {
    this.className = className;
    this.astPath = astPath;
    this.line = line;
    this.column = column;
  }
}

/**
 * Represents the definition of a symbol with its properties
 */
class SymbolDefinition {
  constructor(identifier, location, kind, flags = [], descriptor = null) {
    this.identifier = identifier;
    this.location = location;
    this.kind = kind; // 'class', 'method', 'field', 'interface'
    this.flags = flags; // ['public', 'static', etc.]
    this.descriptor = descriptor;
  }
}

/**
 * Hierarchical tree structure for organizing symbols
 */
class SymbolTree {
  constructor(symbol, children = []) {
    this.symbol = symbol;
    this.children = children;
  }
}

/**
 * Represents a single refactoring operation
 */
class RefactorOperation {
  constructor(className, astPath, operationType, newValue) {
    this.className = className;
    this.astPath = astPath;
    this.operationType = operationType; // 'rename', 'move', 'delete', etc.
    this.newValue = newValue;
  }
}

/**
 * Represents a collection of refactoring operations
 */
class WorkspaceEdit {
  constructor(operations = []) {
    this.operations = operations;
  }

  addOperation(operation) {
    this.operations.push(operation);
  }
}

/**
 * Represents a diagnostic issue found in the workspace
 */
class Diagnostic {
  constructor(location, message, severity = 'error') {
    this.location = location;
    this.message = message;
    this.severity = severity; // 'error', 'warning', 'info'
  }
}

/**
 * Main workspace class for Java bytecode analysis and refactoring
 */
class KrakatauWorkspace {
  constructor() {
    this.workspaceASTs = {}; // className -> { ast, constantPool }
    this.referenceObj = {}; // Master reference graph
    this.classFilePaths = {}; // className -> file path
  }

  /**
   * Creates and initializes a workspace instance.
   * @param {string|string[]} classPath - A single path or an array of paths to search for .class files.
   * @returns {Promise<KrakatauWorkspace>} A fully initialized KrakatauWorkspace instance.
   */
  static async create(classPath) {
    const workspace = new KrakatauWorkspace();
    await workspace._initialize(classPath);
    return workspace;
  }

  /**
   * Internal method to initialize the workspace
   * @private
   */
  async _initialize(classPath) {
    const classPaths = Array.isArray(classPath) ? classPath : [classPath];
    const classFiles = [];

    // Find all .class files in the provided paths
    for (const cp of classPaths) {
      this._findClassFiles(cp, classFiles);
    }

    // Load all class files
    for (const classFile of classFiles) {
      // We need to get the raw parser output before it's converted
      // but loadClassByPathSync does both. Let's get the raw content and parse it here.
      const fs = require('fs');
      const { getAST } = require('jvm_parser');
      const { convertJson } = require('./convert_tree');

      const classFileContent = fs.readFileSync(classFile);
      const rawAst = getAST(classFileContent);
      const convertedAst = convertJson(rawAst.ast, rawAst.constantPool);

      if (convertedAst) {
        const className = convertedAst.classes[0].className;
        this.workspaceASTs[className] = {
          ast: convertedAst,
          constantPool: rawAst.constantPool,
        };
        this.classFilePaths[className] = classFile;
      }
    }

    // Build a basic reference object without using traverseAST for now
    this._buildBasicReferenceGraph();
  }

  /**
   * Recursively finds all .class files in a directory
   * @private
   */
  _findClassFiles(dirPath, classFiles) {
    // Skip filesystem operations in browser environment
    if (typeof window !== 'undefined') {
      // In browser environment, this method should not be called
      // as we work with virtual file system instead
      console.warn('_findClassFiles called in browser environment - using virtual file system instead');
      return;
    }

    if (!fs.existsSync(dirPath)) {
      throw new Error(`Class path entry ${dirPath} does not exist`);
    }

    const stats = fs.statSync(dirPath);
    if (stats.isFile() && dirPath.endsWith('.class')) {
      classFiles.push(dirPath);
    } else if (stats.isDirectory()) {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        this._findClassFiles(path.join(dirPath, file), classFiles);
      }
    }
  }

  /**
   * Builds a basic reference graph for all loaded classes
   * @private
   */
  _buildBasicReferenceGraph() {
    this.referenceObj = {};
    
    // First, initialize the basic structure for all known classes
    Object.keys(this.workspaceASTs).forEach(className => {
      if (!this.referenceObj[className]) {
        this.referenceObj[className] = { children: new Map(), referees: [] };
      }
    });
    
    // Build comprehensive reference graph using traverseAST functionality
    // Process each class in the workspace to find all cross-references
    Object.entries(this.workspaceASTs).forEach(([className, workspaceEntry]) => {
      this._buildReferencesForClass(className, workspaceEntry.ast);
    });
  }

  _addBasicReferencesForClass(className, ast) {
    // Fallback method that adds basic references when full traversal fails
    if (!this.referenceObj[className]) {
      this.referenceObj[className] = { children: new Map(), referees: [] };
    }
    
    // Add a basic reference for the class definition
    this.referenceObj[className].referees.push({ className, astPath: `classes.0` });
    
    // Add references for methods and fields
    ast.classes[0].items.forEach((item, itemIndex) => {
      if (item.type === 'method') {
        const methodName = item.method.name;
        if (!this.referenceObj[className].children.has(methodName)) {
          this.referenceObj[className].children.set(methodName, {
            descriptor: item.method.descriptor,
            referees: []
          });
        }
        this.referenceObj[className].children.get(methodName).referees.push({
          className, 
          astPath: `classes.0.items.${itemIndex}.method` 
        });
      } else if (item.type === 'field') {
        const fieldName = item.field.name;
        if (!this.referenceObj[className].children.has(fieldName)) {
          this.referenceObj[className].children.set(fieldName, {
            descriptor: item.field.descriptor,
            referees: []
          });
        }
        this.referenceObj[className].children.get(fieldName).referees.push({
          className, 
          astPath: `classes.0.items.${itemIndex}.field` 
        });
      }
    });
  }

  /**
   * Builds references for a single class with proper context tracking
   * @private
   */
  _buildReferencesForClass(className, ast) {
    const cls = ast.classes[0];
    const classIndex = 0; // Always 0 since each AST contains one class
    
    // Initialize reference object for this class
    if (!this.referenceObj[cls.className]) {
      this.referenceObj[cls.className] = { children: new Map(), referees: [] };
    }
        this.referenceObj[cls.className].referees.push({
          className: cls.className,
          astPath: `classes.${classIndex}`
    });

    cls.items.forEach((item, itemIndex) => {
      if (item.type === 'method') {
        const methodName = item.method.name;
        const methodDescriptor = item.method.descriptor;

        if (!this.referenceObj[cls.className].children.has(methodName)) {
          this.referenceObj[cls.className].children.set(methodName, {
            descriptor: methodDescriptor,
            referees: []
          });
        }
        this.referenceObj[cls.className].children.get(methodName).referees.push({
          className: cls.className,
          astPath: `classes.${classIndex}.items.${itemIndex}.method`
        });

        item.method.attributes.forEach((attr, attrIndex) => {
          if (attr.type === "code") {
            attr.code.codeItems.forEach((codeItem, codeItemIndex) => {
              if (codeItem.instruction && codeItem.instruction.arg) {
                const arg = codeItem.instruction.arg;
                if (Array.isArray(arg) && arg.length > 2 && Array.isArray(arg[2]) && arg[2].length >= 2) {
                  const [fieldNameOrMethodName, descriptor] = arg[2];
                  const parentClass = arg[1];

                  if (!this.referenceObj[parentClass]) {
                    this.referenceObj[parentClass] = { children: new Map(), referees: [] };
                  }
                  if (!this.referenceObj[parentClass].children.has(fieldNameOrMethodName)) {
                    this.referenceObj[parentClass].children.set(fieldNameOrMethodName, {
                      descriptor: descriptor,
                      referees: []
                    });
                  }
                  
                  // Double-check the structure exists before adding reference
                  const targetRef = this.referenceObj[parentClass].children.get(fieldNameOrMethodName);
                  if (targetRef && Array.isArray(targetRef.referees)) {
                    // Store the reference with the className context (where the reference occurs)
                    targetRef.referees.push({ 
                      className: cls.className, // This is the class making the reference
                      astPath: `classes.${classIndex}.items.${itemIndex}.method.attributes.${attrIndex}.code.codeItems.${codeItemIndex}`
                    });
                  }
                }
              }
            });
          }
        });
      }
    });
  }

  /**
   * Returns a comprehensive, hierarchical tree of all symbols in the workspace.
   * @returns {SymbolTree} The complete symbol tree of the workspace.
   */
  getSymbolTree() {
    const rootChildren = [];

    Object.entries(this.workspaceASTs).forEach(([className, workspaceEntry]) => {
      const ast = workspaceEntry.ast;
      const classSymbol = new SymbolDefinition(
        new SymbolIdentifier(className),
        new SymbolLocation(className, `classes.0`),
        'class',
        ast.classes[0].flags
      );

      const methodChildren = [];
      const fieldChildren = [];

      ast.classes[0].items.forEach((item, itemIndex) => {
        if (item.type === 'method') {
          const methodSymbol = new SymbolDefinition(
            new SymbolIdentifier(className, item.method.name, item.method.descriptor),
            new SymbolLocation(className, `classes.0.items.${itemIndex}.method`),
            'method',
            item.method.flags,
            item.method.descriptor
          );
          methodChildren.push(new SymbolTree(methodSymbol));
        } else if (item.type === 'field') {
          const fieldSymbol = new SymbolDefinition(
            new SymbolIdentifier(className, item.field.name, item.field.descriptor),
            new SymbolLocation(className, `classes.0.items.${itemIndex}.field`),
            'field',
            item.field.flags,
            item.field.descriptor
          );
          fieldChildren.push(new SymbolTree(fieldSymbol));
        }
      });

      const classTree = new SymbolTree(classSymbol, [...methodChildren, ...fieldChildren]);
      rootChildren.push(classTree);
    });

    return new SymbolTree(null, rootChildren);
  }

  /**
   * Lists all classes and interfaces defined within the workspace.
   * @returns {SymbolDefinition[]} An array of SymbolDefinitions, one for each class/interface.
   */
  listClasses() {
    const classes = [];

    Object.entries(this.workspaceASTs).forEach(([className, workspaceEntry]) => {
      const ast = workspaceEntry.ast;
      const classDef = new SymbolDefinition(
        new SymbolIdentifier(className),
        new SymbolLocation(className, `classes.0`),
        ast.classes[0].flags.includes('interface') ? 'interface' : 'class',
        ast.classes[0].flags
      );
      classes.push(classDef);
    });

    return classes;
  }

  /**
   * Private helper method to list symbols of a specific type from a class.
   * @private
   * @param {string} className - The fully qualified name of the class.
   * @param {string} itemType - The type of item to look for ('method' or 'field').
   * @param {string} symbolKind - The kind of symbol for the SymbolDefinition.
   * @returns {SymbolDefinition[]} An array of SymbolDefinitions for each symbol of the specified type.
   */
  _listSymbols(className, itemType, symbolKind) {
    const workspaceEntry = this.workspaceASTs[className];
    if (!workspaceEntry) {
      return [];
    }
    const ast = workspaceEntry.ast;

    const symbols = [];
    ast.classes[0].items.forEach((item, itemIndex) => {
      if (item.type === itemType) {
        const member = item[itemType]; // e.g., item.method or item.field
        const symbol = new SymbolDefinition(
          new SymbolIdentifier(className, member.name, member.descriptor),
          new SymbolLocation(className, `classes.0.items.${itemIndex}.${itemType}`),
          symbolKind,
          member.flags,
          member.descriptor
        );
        symbols.push(symbol);
      }
    });
    
    return symbols;
  }

  /**
   * Lists all methods for a given class.
   * @param {string} className - The fully qualified name of the class.
   * @returns {SymbolDefinition[]} An array of SymbolDefinitions for each method in the class.
   */
  listMethods(className) {
    return this._listSymbols(className, 'method', 'method');
  }

  /**
   * Lists all fields for a given class.
   * @param {string} className - The fully qualified name of the class.
   * @returns {SymbolDefinition[]} An array of SymbolDefinitions for each field in the class.
   */
  listFields(className) {
    return this._listSymbols(className, 'field', 'field');
  }

  /**
   * Retrieves the full AST for a specific class file.
   * @param {string} className - The fully qualified name of the class.
   * @returns {object|null} The parsed AST object for the class, or null if not found.
   */
  getClassAST(className) {
    const workspaceEntry = this.workspaceASTs[className];
    if (!workspaceEntry) {
      throw new Error(`Class ${className} not found in workspace`);
    }
    return workspaceEntry.ast;
  }

  /**
   * Finds all references (callers) for a given symbol.
   * @param {SymbolIdentifier} symbolIdentifier - The symbol to find references for.
   * @returns {SymbolLocation[]} An array of SymbolLocations where the symbol is used.
   */
  findReferences(symbolIdentifier) {
    const references = [];
    
    // Look up the symbol in the reference object
    const classRef = this.referenceObj[symbolIdentifier.className];
    if (!classRef) {
      return references;
    }

    if (symbolIdentifier.memberName) {
      // Looking for method or field references
      const memberRef = classRef.children.get(symbolIdentifier.memberName);
      if (memberRef) {
        memberRef.referees.forEach(referee => {
          // Handle both old format (string) and new format (object with className)
          if (typeof referee === 'string') {
            references.push(new SymbolLocation(symbolIdentifier.className, referee));
          } else {
            references.push(new SymbolLocation(referee.className, referee.astPath));
          }
        });
      }
    } else {
      // Looking for class references
      classRef.referees.forEach(referee => {
        // Handle both old format (string) and new format (object with className)
        if (typeof referee === 'string') {
          references.push(new SymbolLocation(symbolIdentifier.className, referee));
        } else {
          references.push(new SymbolLocation(referee.className, referee.astPath));
        }
      });
    }

    return references;
  }

  /**
   * Retrieves the definition of a symbol at a specific AST location.
   * @param {SymbolLocation} location - The AST location of a symbol reference.
   * @returns {SymbolDefinition|null} The SymbolDefinition of the symbol being referenced, or null if unresolved.
   */
  getDefinitionAt(location) {
    // This is a complex operation that would need to traverse the AST at the given path
    // and determine what symbol is being referenced there
    // For now, return null - this would be implemented based on the specific AST structure
    return null;
  }

  /**
   * Serializes the current (potentially modified) state of a class's AST
   * back into Krakatau assembly format (.j file content).
   * @param {string} className - The class to serialize.
   * @returns {string} The string content for the .j file.
   */
  toKrakatauAssembly(className) {
    const workspaceEntry = this.workspaceASTs[className];
    if (!workspaceEntry) {
      throw new Error(`Class ${className} not found in workspace`);
    }
    return unparseDataStructures(workspaceEntry.ast.classes[0], workspaceEntry.constantPool);
  }

  /**
   * Finds all direct dependencies (callees) for a given method.
   * @param {SymbolIdentifier} methodIdentifier - An identifier for the method to analyze.
   * @returns {SymbolDefinition[]} An array of SymbolDefinitions for every method and field called by the target method.
   */
  findCallees(methodIdentifier) {
    const callees = [];
    const workspaceEntry = this.workspaceASTs[methodIdentifier.className];
    if (!workspaceEntry) {
      return callees;
    }
    const ast = workspaceEntry.ast;

    // Find the method in the AST
    const methodItem = ast.classes[0].items.find(item => 
      item.type === 'method' && 
      item.method.name === methodIdentifier.memberName &&
      (methodIdentifier.descriptor ? item.method.descriptor === methodIdentifier.descriptor : true)
    );

    if (!methodItem) {
      return callees;
    }

    // Look for code attribute
    const codeAttribute = methodItem.method.attributes.find(attr => attr.type === 'code');
    if (!codeAttribute) {
      return callees;
    }

    // Traverse code items to find method and field references
    codeAttribute.code.codeItems.forEach(codeItem => {
      if (codeItem.instruction && codeItem.instruction.arg) {
        const instruction = codeItem.instruction;
        
        // Check for method invocations
        if (instruction.op && instruction.op.includes('invoke')) {
          if (Array.isArray(instruction.arg) && instruction.arg.length >= 3) {
            const targetClass = instruction.arg[1];
            const [methodName, descriptor] = instruction.arg[2];
            
            const callee = new SymbolDefinition(
              new SymbolIdentifier(targetClass, methodName, descriptor),
              new SymbolLocation(targetClass, 'method_call'), // This would need to be more specific
              'method',
              [], // We don't have flags information from the call site
              descriptor
            );
            callees.push(callee);
          }
        }
        
        // Check for field access
        if (instruction.op && (instruction.op.includes('getfield') || instruction.op.includes('putfield') || 
                              instruction.op.includes('getstatic') || instruction.op.includes('putstatic'))) {
          if (Array.isArray(instruction.arg) && instruction.arg.length >= 3) {
            const targetClass = instruction.arg[1];
            const [fieldName, descriptor] = instruction.arg[2];
            
            const callee = new SymbolDefinition(
              new SymbolIdentifier(targetClass, fieldName, descriptor),
              new SymbolLocation(targetClass, 'field_access'),
              'field',
              [],
              descriptor
            );
            callees.push(callee);
          }
        }
      }
    });

    return callees;
  }

  /**
   * Finds the inheritance hierarchy for a given class (supertypes).
   * @param {string} className - The fully qualified name of the class.
   * @returns {SymbolDefinition[]} An ordered array of SymbolDefinitions from the immediate superclass to java/lang/Object.
   */
  getSupertypeHierarchy(className) {
    const hierarchy = [];
    let currentClass = className;

    while (currentClass) {
        const workspaceEntry = this.workspaceASTs[currentClass];
        if (!workspaceEntry) {
            if (currentClass !== className) {
                hierarchy.push(new SymbolDefinition(new SymbolIdentifier(currentClass), null, 'class', []));
            }
            break;
        }
        const ast = workspaceEntry.ast;
        const superClass = ast.classes[0].superClassName;
        if (!superClass) {
            break;
        }

        const superWorkspaceEntry = this.workspaceASTs[superClass];
        const superAst = superWorkspaceEntry ? superWorkspaceEntry.ast : null;
        hierarchy.push(new SymbolDefinition(
            new SymbolIdentifier(superClass),
            superAst ? new SymbolLocation(superClass, 'classes.0') : null,
            'class',
            superAst ? superAst.classes[0].flags : []
        ));

        if (!superAst) {
            break;
        }

        currentClass = superClass;
    }

    return hierarchy;
  }

  /**
   * Finds all known subtypes for a given class or interface within the workspace.
   * @param {string} className - The fully qualified name of the class or interface.
   * @returns {SymbolDefinition[]} An array of SymbolDefinitions for all classes that extend or implement the given type.
   */
  getSubtypeHierarchy(className) {
    const subtypes = [];

    Object.entries(this.workspaceASTs).forEach(([subClassName, workspaceEntry]) => {
      if (subClassName === className) {
        return; // Skip self
      }

      const cls = workspaceEntry.ast.classes[0];
      
      // Check if this class extends the target class
      if (cls.superClass === className) {
        subtypes.push(new SymbolDefinition(
          new SymbolIdentifier(subClassName),
          new SymbolLocation(subClassName, 'classes.0'),
          'class',
          cls.flags
        ));
      }

      // Check if this class implements the target interface
      if (cls.interfaces && cls.interfaces.includes(className)) {
        subtypes.push(new SymbolDefinition(
          new SymbolIdentifier(subClassName),
          new SymbolLocation(subClassName, 'classes.0'),
          'class',
          cls.flags
        ));
      }
    });

    return subtypes;
  }

  /**
   * Builds a complete call graph for the entire workspace.
   * @returns {Map<SymbolIdentifier, SymbolIdentifier[]>} A map where keys are method SymbolIdentifiers and values are arrays of callee SymbolIdentifiers.
   */
  getCallGraph() {
    const callGraph = new Map();

    Object.entries(this.workspaceASTs).forEach(([className, workspaceEntry]) => {
      workspaceEntry.ast.classes[0].items.forEach(item => {
        if (item.type === 'method') {
          const methodId = new SymbolIdentifier(className, item.method.name, item.method.descriptor);
          const callees = this.findCallees(methodId);
          callGraph.set(methodId, callees.map(callee => callee.identifier));
        }
      });
    });

    return callGraph;
  }

  /**
   * Performs a fuzzy search for symbols across the entire workspace.
   * @param {string} query - The search string.
   * @returns {SymbolDefinition[]} An array of matching SymbolDefinitions.
   */
  findSymbol(query) {
    const results = [];
    const lowerQuery = query.toLowerCase();

    // Search through all classes
    Object.entries(this.workspaceASTs).forEach(([className, workspaceEntry]) => {
      const ast = workspaceEntry.ast;
      // Check class name
      if (className.toLowerCase().includes(lowerQuery)) {
        results.push(new SymbolDefinition(
          new SymbolIdentifier(className),
          new SymbolLocation(className, 'classes.0'),
          'class',
          ast.classes[0].flags
        ));
      }

      // Check methods and fields
      ast.classes[0].items.forEach((item, itemIndex) => {
        if (item.type === 'method' && item.method.name.toLowerCase().includes(lowerQuery)) {
          results.push(new SymbolDefinition(
            new SymbolIdentifier(className, item.method.name, item.method.descriptor),
            new SymbolLocation(className, `classes.0.items.${itemIndex}.method`),
            'method',
            item.method.flags,
            item.method.descriptor
          ));
        } else if (item.type === 'field' && item.field.name.toLowerCase().includes(lowerQuery)) {
          results.push(new SymbolDefinition(
            new SymbolIdentifier(className, item.field.name, item.field.descriptor),
            new SymbolLocation(className, `classes.0.items.${itemIndex}.field`),
            'field',
            item.field.flags,
            item.field.descriptor
          ));
        }
      });
    });

    return results;
  }

  /**
   * Calculates all necessary changes to rename a symbol across the entire workspace.
   * @param {SymbolIdentifier} symbolIdentifier - The symbol to be renamed.
   * @param {string} newName - The desired new name for the symbol.
   * @returns {WorkspaceEdit} A WorkspaceEdit object detailing all the changes required.
   */
  prepareRename(symbolIdentifier, newName) {
    const edit = new WorkspaceEdit();

    // Find all references to the symbol
    const references = this.findReferences(symbolIdentifier);

    // Add operation to rename the definition
    if (symbolIdentifier.memberName) {
      // Renaming a method or field
      const defLocation = this._findSymbolDefinitionLocation(symbolIdentifier);
      if (defLocation) {
        edit.addOperation(new RefactorOperation(
          symbolIdentifier.className,
          defLocation.astPath + '.name',
          'rename',
          newName
        ));
      }
    } else {
      // Renaming a class (not implemented in basic version)
      throw new Error('Class renaming not yet implemented');
    }

    // Add operations for all references
    references.forEach(ref => {
      // This would need to analyze the specific AST path to determine what to update
      // For now, we'll create a generic operation
      edit.addOperation(new RefactorOperation(
        ref.className,
        ref.astPath,
        'rename',
        newName
      ));
    });

    return edit;
  }

  /**
   * Applies a set of refactoring operations to the in-memory ASTs of the workspace.
   * @param {WorkspaceEdit} edit - The WorkspaceEdit plan to apply.
   */
  applyEdit(edit) {
    edit.operations.forEach(operation => {
      const ast = this.getClassAST(operation.className);

      // Navigate to the AST node and apply the change
      this._applyOperationToAST(ast, operation);
    });

    // Rebuild the reference graph after applying changes
    this._buildBasicReferenceGraph();
  }

  /**
   * Applies a rename refactoring to a symbol and saves the modified class files.
   * This is a high-level workflow that handles loading, modification, and reassembly.
   * @param {SymbolIdentifier} symbolIdentifier - The symbol to rename.
   * @param {string} newName - The new name for the symbol.
   * @param {string} outputDir - The directory to save the modified .class files.
   */
  applyRenameAndSave(symbolIdentifier, newName, outputDir = '.') {
    // Step 1: Identify which class files will be modified by finding all references.
    const modifiedClasses = new Set([symbolIdentifier.className]);
    const refs = this.findReferences(symbolIdentifier);
    refs.forEach(ref => modifiedClasses.add(ref.className));

    // Step 2: Apply the rename operation to the in-memory ASTs.
    renameMethod(this, symbolIdentifier.className, symbolIdentifier.memberName, newName);

    // Step 3: Reassemble only the affected classes
    const modifiedAsts = { classes: [], constantPools: [] };
    for (const className of modifiedClasses) {
      if (this.workspaceASTs[className]) {
        modifiedAsts.classes.push(this.workspaceASTs[className].ast.classes[0]);
        modifiedAsts.constantPools.push(this.workspaceASTs[className].constantPool);
      }
    }
    
    // Assemble the modified classes
    assembleClasses(modifiedAsts, outputDir);

    console.log(`Successfully renamed ${symbolIdentifier.memberName} to ${newName} and saved ${modifiedClasses.size} affected files.`);
  }

  /**
   * Finds all symbols that are defined but never used within the workspace.
   * @returns {SymbolDefinition[]} An array of SymbolDefinitions for unused private methods and fields.
   */
  findUnusedSymbols() {
    const unusedSymbols = [];

    Object.entries(this.workspaceASTs).forEach(([className, workspaceEntry]) => {
      workspaceEntry.ast.classes[0].items.forEach((item, itemIndex) => {
        if (item.type === 'method' && item.method.flags.includes('private')) {
          const methodId = new SymbolIdentifier(className, item.method.name, item.method.descriptor);
          const references = this.findReferences(methodId);
          
          // If only one reference (the definition itself), it's unused
          if (references.length <= 1) {
            unusedSymbols.push(new SymbolDefinition(
              methodId,
              new SymbolLocation(className, `classes.0.items.${itemIndex}.method`),
              'method',
              item.method.flags,
              item.method.descriptor
            ));
          }
        } else if (item.type === 'field' && item.field.flags.includes('private')) {
          const fieldId = new SymbolIdentifier(className, item.field.name, item.field.descriptor);
          const references = this.findReferences(fieldId);
          
          // If only one reference (the definition itself), it's unused
          if (references.length <= 1) {
            unusedSymbols.push(new SymbolDefinition(
              fieldId,
              new SymbolLocation(className, `classes.0.items.${itemIndex}.field`),
              'field',
              item.field.flags,
              item.field.descriptor
            ));
          }
        }
      });
    });

    return unusedSymbols;
  }

  /**
   * Finds all method references that cannot be resolved to a definition in the workspace.
   * @returns {SymbolIdentifier[]} An array of SymbolIdentifiers for each unresolved method.
   */
  findUnresolvedMethods() {
    const unresolvedMethods = [];
    for (const className in this.referenceObj) {
      const classRef = this.referenceObj[className];

      for (const [memberName, memberRef] of classRef.children.entries()) {
        // A method descriptor will always start with '('.
        if (memberRef.descriptor && memberRef.descriptor.startsWith('(')) {
          let isDefined = false;
          let classToInspect = className;

          while (classToInspect) {
            const ast = this.workspaceASTs[classToInspect];
            if (ast) {
              isDefined = ast.classes[0].items.some(item =>
                item.type === 'method' &&
                item.method.name === memberName &&
                item.method.descriptor === memberRef.descriptor
              );
              if (isDefined) {
                break;
              }
              classToInspect = ast.classes[0].superClassName;
            } else {
              classToInspect = null;
            }
          }

          if (!isDefined) {
            unresolvedMethods.push(new SymbolIdentifier(className, memberName, memberRef.descriptor));
          }
        }
      }
    }
    return unresolvedMethods;
  }

  /**
   * Validates the entire workspace and reports potential issues.
   * @returns {Diagnostic[]} An array of diagnostic objects, each detailing a problem.
   */
  validateWorkspace() {
    const diagnostics = [];

    // Check for missing class dependencies
    Object.entries(this.referenceObj).forEach(([className, classRef]) => {
      if (!this.workspaceASTs[className] && !className.startsWith('java/')) {
        diagnostics.push(new Diagnostic(
          new SymbolLocation(className, 'undefined'),
          `Referenced class ${className} is not found in workspace`,
          'warning'
        ));
      }
    });

    return diagnostics;
  }

  /**
   * Reloads and re-analyzes a specific class file from disk.
   * @param {string} filePath - The path to the .class file that has changed.
   */
  async reloadFile(filePath) {
    // This needs to be updated to match the logic in _initialize
    const fs = require('fs');
    const { getAST } = require('jvm_parser');
    const { convertJson } = require('./convert_tree');

    const classFileContent = fs.readFileSync(filePath);
    const rawAst = getAST(classFileContent);
    const convertedAst = convertJson(rawAst.ast, rawAst.constantPool);

    if (convertedAst) {
      const className = convertedAst.classes[0].className;
      this.workspaceASTs[className] = {
        ast: convertedAst,
        constantPool: rawAst.constantPool,
      };
      this.classFilePaths[className] = filePath;
      
      // Rebuild the reference graph
      this._buildBasicReferenceGraph();
    }
  }

  // Helper methods

  /**
   * Finds the AST location of a symbol definition
   * @private
   */
  _findSymbolDefinitionLocation(symbolIdentifier) {
    const ast = this.workspaceASTs[symbolIdentifier.className];
    if (!ast) {
      return null;
    }

    const itemIndex = ast.classes[0].items.findIndex(item => {
      if (item.type === 'method') {
        return item.method.name === symbolIdentifier.memberName &&
               (symbolIdentifier.descriptor ? item.method.descriptor === symbolIdentifier.descriptor : true);
      } else if (item.type === 'field') {
        return item.field.name === symbolIdentifier.memberName &&
               (symbolIdentifier.descriptor ? item.field.descriptor === symbolIdentifier.descriptor : true);
      }
      return false;
    });

    if (itemIndex >= 0) {
      const item = ast.classes[0].items[itemIndex];
      return new SymbolLocation(
        symbolIdentifier.className,
        `classes.0.items.${itemIndex}.${item.type}`
      );
    }

    return null;
  }

  /**
   * Calculates the changes needed to move a static method from one class to another.
   * @param {SymbolIdentifier} methodIdentifier - The static method to move.
   * @param {string} targetClassName - The destination class.
   * @returns {WorkspaceEdit} A WorkspaceEdit detailing the removal from source, addition to target, and updates to all call sites.
   */
  prepareMoveStaticMethod(methodIdentifier, targetClassName) {
    const edit = new WorkspaceEdit();
    
    // Check if method is static
    const sourceAst = this.workspaceASTs[methodIdentifier.className];
    if (!sourceAst) {
      throw new Error(`Source class ${methodIdentifier.className} not found`);
    }
    
    const methodItem = sourceAst.classes[0].items.find(item =>
      item.type === 'method' && 
      item.method.name === methodIdentifier.memberName &&
      (methodIdentifier.descriptor ? item.method.descriptor === methodIdentifier.descriptor : true)
    );
    
    if (!methodItem) {
      throw new Error(`Method ${methodIdentifier.memberName} not found in ${methodIdentifier.className}`);
    }
    
    if (!methodItem.method.flags.includes('static')) {
      throw new Error(`Method ${methodIdentifier.memberName} is not static and cannot be moved`);
    }
    
    // Check if target class exists
    if (!this.workspaceASTs[targetClassName]) {
      throw new Error(`Target class ${targetClassName} not found`);
    }
    
    // For now, just return a placeholder edit - full implementation would involve:
    // 1. Remove method from source class
    // 2. Add method to target class  
    // 3. Update all call sites to reference new location
    edit.addOperation(new RefactorOperation(
      methodIdentifier.className,
      'method_removal',
      'move',
      targetClassName
    ));
    
    return edit;
  }

  /**
   * Calculates the changes to make a method static, if possible.
   * @param {SymbolIdentifier} methodIdentifier - The instance method to make static.
   * @returns {WorkspaceEdit} A WorkspaceEdit with the necessary changes.
   */
  prepareMakeMethodStatic(methodIdentifier) {
    const edit = new WorkspaceEdit();
    
    const ast = this.workspaceASTs[methodIdentifier.className];
    if (!ast) {
      throw new Error(`Class ${methodIdentifier.className} not found`);
    }
    
    const methodItem = ast.classes[0].items.find(item =>
      item.type === 'method' && 
      item.method.name === methodIdentifier.memberName &&
      (methodIdentifier.descriptor ? item.method.descriptor === methodIdentifier.descriptor : true)
    );
    
    if (!methodItem) {
      throw new Error(`Method ${methodIdentifier.memberName} not found`);
    }
    
    if (methodItem.method.flags.includes('static')) {
      throw new Error(`Method ${methodIdentifier.memberName} is already static`);
    }
    
    // Check if method uses 'this' (simplified check)
    const codeAttribute = methodItem.method.attributes.find(attr => attr.type === 'code');
    if (codeAttribute) {
      const usesThis = codeAttribute.code.codeItems.some(codeItem => {
        if (codeItem.instruction) {
          const instr = codeItem.instruction;
          // Look for aload_0 (loading 'this') or getfield/putfield instructions
          return instr === 'aload_0' || 
                 (instr.op && (instr.op === 'getfield' || instr.op === 'putfield'));
        }
        return false;
      });
      
      if (usesThis) {
        throw new Error(`Method ${methodIdentifier.memberName} uses 'this' and cannot be made static`);
      }
    }
    
    // Add static flag to method
    edit.addOperation(new RefactorOperation(
      methodIdentifier.className,
      `method.${methodIdentifier.memberName}.flags`,
      'add_flag',
      'static'
    ));
    
    return edit;
  }

  /**
   * Retrieves the definition of a symbol at a specific AST location.
   * This is the reverse of findReferences. Useful for "Go to Definition".
   * @param {SymbolLocation} location - The AST location of a symbol reference.
   * @returns {SymbolDefinition|null} The SymbolDefinition of the symbol being referenced, or null if unresolved.
   */
  getDefinitionAt(location) {
    // This is a complex operation that would analyze the AST at the given path
    // to determine what symbol is being referenced
    
    const ast = this.workspaceASTs[location.className];
    if (!ast) {
      return null;
    }
    
    // For now, return null - full implementation would traverse the AST path
    // and determine the referenced symbol based on the instruction type and operands
    return null;
  }

  // Helper methods

  /**
   * Finds the AST location of a symbol definition
   * @private
   */
  _findSymbolDefinitionLocation(symbolIdentifier) {
    const ast = this.workspaceASTs[symbolIdentifier.className];
    if (!ast) {
      return null;
    }

    const itemIndex = ast.classes[0].items.findIndex(item => {
      if (item.type === 'method') {
        return item.method.name === symbolIdentifier.memberName &&
               (symbolIdentifier.descriptor ? item.method.descriptor === symbolIdentifier.descriptor : true);
      } else if (item.type === 'field') {
        return item.field.name === symbolIdentifier.memberName &&
               (symbolIdentifier.descriptor ? item.field.descriptor === symbolIdentifier.descriptor : true);
      }
      return false;
    });

    if (itemIndex >= 0) {
      const item = ast.classes[0].items[itemIndex];
      return new SymbolLocation(
        symbolIdentifier.className,
        `classes.0.items.${itemIndex}.${item.type}`
      );
    }

    return null;
  }

  /**
   * Applies a single refactor operation to an AST
   * @private
   */
  _applyOperationToAST(ast, operation) {
    // This is a simplified implementation
    // In a real implementation, you'd need to parse the AST path and navigate to the correct node
    const pathParts = operation.astPath.split('.');
    let current = ast;

    // Navigate to the parent of the target node
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (current && typeof current === 'object') {
        current = current[part];
      } else {
        console.warn(`Could not navigate AST path: ${operation.astPath}`);
        return;
      }
    }

    // Apply the change to the final property
    const finalProperty = pathParts[pathParts.length - 1];
    if (current && typeof current === 'object' && finalProperty in current) {
      if (operation.operationType === 'rename') {
        current[finalProperty] = operation.newValue;
      }
    }
  }
}

module.exports = {
  KrakatauWorkspace,
  SymbolIdentifier,
  SymbolLocation,
  SymbolDefinition,
  SymbolTree,
  WorkspaceEdit,
  RefactorOperation,
  Diagnostic
};