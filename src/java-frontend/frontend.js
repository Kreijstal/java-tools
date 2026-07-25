'use strict';

const { tokenizeJava } = require('./lexer');
const { parseJava } = require('./parser');
const {
  bindJavaAst,
  resolveJavaTypes,
  resolveJavaOverloads,
  analyzeJavaControlFlow,
} = require('./semantic');
const { NotImplementedJavaFrontendError } = require('./errors');
const { compileJavaAst, compileJavaSource, buildBytecodeIr } = require('./compiler');

class JavaFrontend {
  constructor(options = {}) {
    this.options = options;
  }

  tokenize(source, options = {}) {
    return tokenizeJava(source, { ...this.options, ...options });
  }

  parse(source, options = {}) {
    return parseJava(source, { ...this.options, ...options });
  }

  bind(astDocument, options = {}) {
    return bindJavaAst(astDocument, { ...this.options, ...options });
  }

  resolveTypes(boundModel, options = {}) {
    return resolveJavaTypes(boundModel, { ...this.options, ...options });
  }

  resolveOverloads(typedModel, options = {}) {
    return resolveJavaOverloads(typedModel, { ...this.options, ...options });
  }

  analyzeControlFlow(typedModel, options = {}) {
    return analyzeJavaControlFlow(typedModel, { ...this.options, ...options });
  }

  lowerToBytecode(astDocument, options = {}) {
    return buildBytecodeIr(astDocument, { ...this.options, ...options });
  }

  compile(sourceOrAst, options = {}) {
    const mergedOptions = { ...this.options, ...options };
    if (sourceOrAst && typeof sourceOrAst === 'object' && sourceOrAst.schema) {
      return compileJavaAst(sourceOrAst, mergedOptions);
    }
    return compileJavaSource(sourceOrAst, mergedOptions);
  }
}

module.exports = {
  JavaFrontend,
};
