'use strict';

const AST_SCHEMA_ID = 'java-tools.java-frontend.ast';
const AST_SCHEMA_VERSION = 1;

const NODE_KINDS = Object.freeze({
  root: [
    'CompilationUnit',
    'ModuleDeclaration',
  ],

  declaration: [
    'PackageDeclaration',
    'ImportDeclaration',
    'ClassDeclaration',
    'InterfaceDeclaration',
    'EnumDeclaration',
    'AnnotationTypeDeclaration',
    'RecordDeclaration',
    'FieldDeclaration',
    'VariableDeclarator',
    'MethodDeclaration',
    'ConstructorDeclaration',
    'CompactConstructorDeclaration',
    'InitializerBlock',
    'EnumConstantDeclaration',
    'RecordComponent',
    'TypeParameter',
    'FormalParameter',
    'ReceiverParameter',
    'AnnotationDeclaration',
    'AnnotationElementDeclaration',
    'ModuleRequiresDirective',
    'ModuleExportsDirective',
    'ModuleOpensDirective',
    'ModuleUsesDirective',
    'ModuleProvidesDirective',
    'UnsupportedDeclaration',
  ],

  type: [
    'VoidType',
    'PrimitiveType',
    'ClassType',
    'ArrayType',
    'ParameterizedType',
    'TypeVariable',
    'WildcardType',
    'IntersectionType',
    'UnionType',
    'AnnotatedType',
    'UnsupportedType',
  ],

  statement: [
    'BlockStatement',
    'LocalVariableDeclarationStatement',
    'EmptyStatement',
    'ExpressionStatement',
    'ReturnStatement',
    'ThrowStatement',
    'IfStatement',
    'WhileStatement',
    'DoWhileStatement',
    'ForStatement',
    'EnhancedForStatement',
    'BreakStatement',
    'ContinueStatement',
    'SwitchStatement',
    'SwitchRule',
    'SwitchBlockStatementGroup',
    'SwitchLabel',
    'TryStatement',
    'CatchClause',
    'SynchronizedStatement',
    'AssertStatement',
    'LabeledStatement',
    'YieldStatement',
    'UnsupportedStatement',
  ],

  expression: [
    'Identifier',
    'QualifiedName',
    'LiteralExpression',
    'ThisExpression',
    'SuperExpression',
    'ClassLiteralExpression',
    'UnaryExpression',
    'BinaryExpression',
    'AssignmentExpression',
    'ConditionalExpression',
    'ParenthesizedExpression',
    'CastExpression',
    'InstanceofExpression',
    'PatternExpression',
    'FieldAccessExpression',
    'MethodInvocationExpression',
    'ArrayAccessExpression',
    'NewClassExpression',
    'NewArrayExpression',
    'LambdaExpression',
    'MethodReferenceExpression',
    'ArrayInitializerExpression',
    'UnsupportedExpression',
  ],

  pattern: [
    'TypePattern',
    'RecordPattern',
    'ParenthesizedPattern',
    'UnnamedPattern',
    'UnsupportedPattern',
  ],

  annotation: [
    'Annotation',
    'MarkerAnnotation',
    'SingleElementAnnotation',
    'NormalAnnotation',
    'ElementValuePair',
    'ElementValueArrayInitializer',
  ],

  support: [
    'Modifier',
    'SourceRange',
    'Diagnostic',
    'UnsupportedNode',
  ],
});

const ALL_NODE_KINDS = Object.freeze(
  Object.values(NODE_KINDS).flat().sort(),
);
const NODE_KIND_SET = new Set(ALL_NODE_KINDS);

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function omitUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(omitUndefined);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== 'undefined') {
      out[key] = omitUndefined(child);
    }
  }
  return out;
}

function assertKnownKind(kind) {
  if (!NODE_KIND_SET.has(kind)) {
    throw new TypeError(`Unknown Java AST node kind: ${kind}`);
  }
}

function createNode(kind, fields = {}, meta = undefined) {
  assertKnownKind(kind);
  if (!isPlainObject(fields)) {
    throw new TypeError('AST node fields must be a plain object');
  }
  if (hasOwn(fields, 'kind')) {
    throw new TypeError('AST node fields must not contain a kind property');
  }

  const node = { kind, ...omitUndefined(fields) };
  if (typeof meta !== 'undefined') {
    if (!isPlainObject(meta)) {
      throw new TypeError('AST node metadata must be a plain object');
    }
    node.meta = omitUndefined(meta);
  }
  return node;
}

function createAstDocument(root, options = {}) {
  if (!isNode(root)) {
    throw new TypeError('AST document root must be a Java AST node');
  }
  const document = {
    schema: AST_SCHEMA_ID,
    version: AST_SCHEMA_VERSION,
    root,
  };
  if (options.sourceLevel !== undefined) {
    document.sourceLevel = options.sourceLevel;
  }
  if (options.diagnostics !== undefined) {
    document.diagnostics = options.diagnostics;
  }
  if (options.meta !== undefined) {
    document.meta = omitUndefined(options.meta);
  }
  return document;
}

function isNode(value) {
  return isPlainObject(value) && typeof value.kind === 'string' && NODE_KIND_SET.has(value.kind);
}

function isAstDocument(value) {
  return isPlainObject(value)
    && value.schema === AST_SCHEMA_ID
    && value.version === AST_SCHEMA_VERSION
    && isNode(value.root);
}

function range(startOffset, endOffset, start = null, end = null) {
  return createNode('SourceRange', {
    startOffset,
    endOffset,
    start,
    end,
  });
}

function diagnostic(code, message, severity = 'error', sourceRange = null) {
  return createNode('Diagnostic', {
    code,
    message,
    severity,
    range: sourceRange,
  });
}

function modifier(name) {
  return createNode('Modifier', { name });
}

function unsupportedNode(fields = {}) {
  return createNode('UnsupportedNode', {
    reason: fields.reason || null,
    phase: fields.phase || null,
    feature: fields.feature || null,
    text: fields.text || null,
    range: fields.range || null,
    tokens: fields.tokens || [],
  });
}

function compilationUnit(fields = {}) {
  return createNode('CompilationUnit', {
    packageDeclaration: fields.packageDeclaration || null,
    imports: fields.imports || [],
    typeDeclarations: fields.typeDeclarations || [],
    moduleDeclaration: fields.moduleDeclaration || null,
  }, fields.meta);
}

function packageDeclaration(name, annotations = []) {
  return createNode('PackageDeclaration', { name, annotations });
}

function importDeclaration(name, fields = {}) {
  return createNode('ImportDeclaration', {
    name,
    isStatic: Boolean(fields.isStatic),
    isWildcard: Boolean(fields.isWildcard),
  });
}

function classDeclaration(name, fields = {}) {
  return createNode('ClassDeclaration', {
    name,
    modifiers: fields.modifiers || [],
    annotations: fields.annotations || [],
    typeParameters: fields.typeParameters || [],
    extendsType: fields.extendsType || null,
    implementsTypes: fields.implementsTypes || [],
    permitsTypes: fields.permitsTypes || [],
    body: fields.body || [],
  }, fields.meta);
}

function interfaceDeclaration(name, fields = {}) {
  return createNode('InterfaceDeclaration', {
    name,
    modifiers: fields.modifiers || [],
    annotations: fields.annotations || [],
    typeParameters: fields.typeParameters || [],
    extendsTypes: fields.extendsTypes || [],
    permitsTypes: fields.permitsTypes || [],
    body: fields.body || [],
  }, fields.meta);
}

function enumDeclaration(name, fields = {}) {
  return createNode('EnumDeclaration', {
    name,
    modifiers: fields.modifiers || [],
    annotations: fields.annotations || [],
    implementsTypes: fields.implementsTypes || [],
    constants: fields.constants || [],
    body: fields.body || [],
  }, fields.meta);
}

function recordDeclaration(name, fields = {}) {
  return createNode('RecordDeclaration', {
    name,
    modifiers: fields.modifiers || [],
    annotations: fields.annotations || [],
    typeParameters: fields.typeParameters || [],
    components: fields.components || [],
    implementsTypes: fields.implementsTypes || [],
    body: fields.body || [],
  }, fields.meta);
}

function fieldDeclaration(fieldType, declarators, fields = {}) {
  return createNode('FieldDeclaration', {
    modifiers: fields.modifiers || [],
    annotations: fields.annotations || [],
    fieldType,
    declarators,
  }, fields.meta);
}

function variableDeclarator(name, fields = {}) {
  return createNode('VariableDeclarator', {
    name,
    dimensions: fields.dimensions || 0,
    initializer: fields.initializer || null,
  }, fields.meta);
}

function methodDeclaration(name, returnType, fields = {}) {
  return createNode('MethodDeclaration', {
    name,
    modifiers: fields.modifiers || [],
    annotations: fields.annotations || [],
    typeParameters: fields.typeParameters || [],
    returnType,
    parameters: fields.parameters || [],
    receiverParameter: fields.receiverParameter || null,
    throwsTypes: fields.throwsTypes || [],
    body: Object.prototype.hasOwnProperty.call(fields, 'body') ? fields.body : null,
  }, fields.meta);
}

function constructorDeclaration(name, fields = {}) {
  return createNode('ConstructorDeclaration', {
    name,
    modifiers: fields.modifiers || [],
    annotations: fields.annotations || [],
    typeParameters: fields.typeParameters || [],
    parameters: fields.parameters || [],
    receiverParameter: fields.receiverParameter || null,
    throwsTypes: fields.throwsTypes || [],
    body: Object.prototype.hasOwnProperty.call(fields, 'body') ? fields.body : null,
  }, fields.meta);
}

function formalParameter(name, parameterType, fields = {}) {
  return createNode('FormalParameter', {
    name,
    parameterType,
    modifiers: fields.modifiers || [],
    annotations: fields.annotations || [],
    isVarargs: Boolean(fields.isVarargs),
  }, fields.meta);
}

function primitiveType(name, annotations = []) {
  return createNode('PrimitiveType', { name, annotations });
}

function voidType(annotations = []) {
  return createNode('VoidType', { annotations });
}

function classType(name, fields = {}) {
  return createNode('ClassType', {
    name,
    packageName: fields.packageName || null,
    enclosingType: fields.enclosingType || null,
    typeArguments: fields.typeArguments || [],
    annotations: fields.annotations || [],
  }, fields.meta);
}

function arrayType(componentType, dimensions = 1, annotations = []) {
  return createNode('ArrayType', { componentType, dimensions, annotations });
}

function typeVariable(name, fields = {}) {
  return createNode('TypeVariable', {
    name,
    bounds: fields.bounds || [],
    annotations: fields.annotations || [],
  }, fields.meta);
}

function wildcardType(fields = {}) {
  return createNode('WildcardType', {
    boundKind: fields.boundKind || null,
    boundType: fields.boundType || null,
    annotations: fields.annotations || [],
  }, fields.meta);
}

function blockStatement(statements = []) {
  return createNode('BlockStatement', { statements });
}

function returnStatement(expression = null) {
  return createNode('ReturnStatement', { expression });
}

function expressionStatement(expression) {
  return createNode('ExpressionStatement', { expression });
}

function identifier(name) {
  return createNode('Identifier', { name });
}

function qualifiedName(parts) {
  return createNode('QualifiedName', { parts });
}

function literalExpression(value, literalKind, raw = null) {
  return createNode('LiteralExpression', { value, literalKind, raw });
}

function binaryExpression(operator, left, right) {
  return createNode('BinaryExpression', { operator, left, right });
}

function methodInvocationExpression(fields = {}) {
  return createNode('MethodInvocationExpression', {
    target: fields.target || null,
    typeArguments: fields.typeArguments || [],
    name: fields.name,
    arguments: fields.arguments || [],
  }, fields.meta);
}

module.exports = {
  AST_SCHEMA_ID,
  AST_SCHEMA_VERSION,
  NODE_KINDS,
  ALL_NODE_KINDS,
  createNode,
  createAstDocument,
  isNode,
  isAstDocument,
  range,
  diagnostic,
  modifier,
  unsupportedNode,
  compilationUnit,
  packageDeclaration,
  importDeclaration,
  classDeclaration,
  interfaceDeclaration,
  enumDeclaration,
  recordDeclaration,
  fieldDeclaration,
  variableDeclarator,
  methodDeclaration,
  constructorDeclaration,
  formalParameter,
  primitiveType,
  voidType,
  classType,
  arrayType,
  typeVariable,
  wildcardType,
  blockStatement,
  returnStatement,
  expressionStatement,
  identifier,
  qualifiedName,
  literalExpression,
  binaryExpression,
  methodInvocationExpression,
};
