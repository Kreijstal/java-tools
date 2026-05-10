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

module.exports = {
  SymbolIdentifier,
  SymbolLocation,
  SymbolDefinition,
  SymbolTree,
  WorkspaceEdit,
  RefactorOperation,
  Diagnostic
};
