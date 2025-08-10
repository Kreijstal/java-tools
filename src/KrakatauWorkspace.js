const fs = require('fs');
const path = require('path');
const { loadClassByPath } = require('./classLoader');
const { getReferenceObjFromClass } = require('./traverseAST');
const { unparseDataStructures } = require('./convert_tree');

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
    this.workspaceASTs = {}; // className -> AST
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
      const ast = loadClassByPath(classFile, { silent: true });
      if (ast) {
        const className = ast.classes[0].className;
        this.workspaceASTs[className] = ast;
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
    if (!fs.existsSync(dirPath)) {
      return;
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
    
    // For now, just create a basic structure to enable testing
    // We'll implement the full traverseAST functionality later
    Object.entries(this.workspaceASTs).forEach(([className, ast]) => {
      if (!this.referenceObj[className]) {
        this.referenceObj[className] = { children: {}, referees: [] };
      }
      
      // Add a basic reference for the class definition
      this.referenceObj[className].referees.push(`classes.0`);
      
      // Add references for methods and fields
      ast.classes[0].items.forEach((item, itemIndex) => {
        if (item.type === 'method') {
          const methodName = item.method.name;
          if (!this.referenceObj[className].children[methodName]) {
            this.referenceObj[className].children[methodName] = {
              descriptor: item.method.descriptor,
              referees: []
            };
          }
          this.referenceObj[className].children[methodName].referees.push(`classes.0.items.${itemIndex}.method`);
        } else if (item.type === 'field') {
          const fieldName = item.field.name;
          if (!this.referenceObj[className].children[fieldName]) {
            this.referenceObj[className].children[fieldName] = {
              descriptor: item.field.descriptor,
              referees: []
            };
          }
          this.referenceObj[className].children[fieldName].referees.push(`classes.0.items.${itemIndex}.field`);
        }
      });
    });
  }

  /**
   * Returns a comprehensive, hierarchical tree of all symbols in the workspace.
   * @returns {SymbolTree} The complete symbol tree of the workspace.
   */
  getSymbolTree() {
    const rootChildren = [];

    Object.entries(this.workspaceASTs).forEach(([className, ast]) => {
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

    Object.entries(this.workspaceASTs).forEach(([className, ast]) => {
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
   * Lists all methods for a given class.
   * @param {string} className - The fully qualified name of the class.
   * @returns {SymbolDefinition[]} An array of SymbolDefinitions for each method in the class.
   */
  listMethods(className) {
    const ast = this.workspaceASTs[className];
    if (!ast) {
      return [];
    }

    const methods = [];
    ast.classes[0].items.forEach((item, itemIndex) => {
      if (item.type === 'method') {
        const methodDef = new SymbolDefinition(
          new SymbolIdentifier(className, item.method.name, item.method.descriptor),
          new SymbolLocation(className, `classes.0.items.${itemIndex}.method`),
          'method',
          item.method.flags,
          item.method.descriptor
        );
        methods.push(methodDef);
      }
    });

    return methods;
  }

  /**
   * Lists all fields for a given class.
   * @param {string} className - The fully qualified name of the class.
   * @returns {SymbolDefinition[]} An array of SymbolDefinitions for each field in the class.
   */
  listFields(className) {
    const ast = this.workspaceASTs[className];
    if (!ast) {
      return [];
    }

    const fields = [];
    ast.classes[0].items.forEach((item, itemIndex) => {
      if (item.type === 'field') {
        const fieldDef = new SymbolDefinition(
          new SymbolIdentifier(className, item.field.name, item.field.descriptor),
          new SymbolLocation(className, `classes.0.items.${itemIndex}.field`),
          'field',
          item.field.flags,
          item.field.descriptor
        );
        fields.push(fieldDef);
      }
    });

    return fields;
  }

  /**
   * Retrieves the full AST for a specific class file.
   * @param {string} className - The fully qualified name of the class.
   * @returns {object|null} The parsed AST object for the class, or null if not found.
   */
  getClassAST(className) {
    return this.workspaceASTs[className] || null;
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
      const memberRef = classRef.children[symbolIdentifier.memberName];
      if (memberRef) {
        memberRef.referees.forEach(refereePath => {
          references.push(new SymbolLocation(symbolIdentifier.className, refereePath));
        });
      }
    } else {
      // Looking for class references
      classRef.referees.forEach(refereePath => {
        references.push(new SymbolLocation(symbolIdentifier.className, refereePath));
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
    const ast = this.workspaceASTs[className];
    if (!ast) {
      throw new Error(`Class ${className} not found in workspace`);
    }

    return unparseDataStructures(ast.classes[0]);
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
    Object.entries(this.workspaceASTs).forEach(([className, ast]) => {
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