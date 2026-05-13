'use strict';

const { NotImplementedJavaFrontendError } = require('./errors');

class JavaSymbolTable {
  constructor() {
    this.packages = new Map();
    this.types = new Map();
    this.members = new Map();
    this.locals = new Map();
  }

  toJSON() {
    return {
      packages: Array.from(this.packages.keys()).sort(),
      types: Array.from(this.types.keys()).sort(),
      members: Array.from(this.members.keys()).sort(),
      locals: Array.from(this.locals.keys()).sort(),
    };
  }
}

function bindJavaAst() {
  throw new NotImplementedJavaFrontendError('bind', 'name binding and scope construction');
}

function resolveJavaTypes() {
  throw new NotImplementedJavaFrontendError('type-resolve', 'Java type attribution');
}

function resolveJavaOverloads() {
  throw new NotImplementedJavaFrontendError('overload-resolve', 'method overload resolution');
}

function analyzeJavaControlFlow() {
  throw new NotImplementedJavaFrontendError('control-flow', 'Java source control-flow analysis');
}

module.exports = {
  JavaSymbolTable,
  bindJavaAst,
  resolveJavaTypes,
  resolveJavaOverloads,
  analyzeJavaControlFlow,
};
