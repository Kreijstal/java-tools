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

// Only the parser can construct through this private ownership context. Public
// factories retain their defensive copies; parser results are detached once at
// the API boundary instead of recopying every completed expression prefix.
const parserFactories = new WeakMap();

function cleanOwnedFields(value, owned) {
  if (owned.has(value)) return value;
  if (Array.isArray(value)) return value.map(child => cleanOwnedFields(child, owned));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) out[key] = cleanOwnedFields(child, owned);
  }
  return out;
}

function detachParsedTree(value) {
  const container = item => Array.isArray(item) ? new Array(item.length) : isPlainObject(item) ? {} : item;
  const root = container(value);
  if (root === value) return value;
  const work = [[value, root]];
  while (work.length) {
    const [input, output] = work.pop();
    const entries = Array.isArray(input)
      ? Array.from({length: input.length}, (_, index) => index).filter(index => index in input).map(index => [index, input[index]])
      : Object.entries(input).filter(([, child]) => child !== undefined);
    for (const [key, child] of entries) {
      const copy = container(child);
      output[key] = copy;
      if (copy !== child) work.push([child, copy]);
    }
  }
  return root;
}

function createNode(kind, fields = {}, meta = undefined) {
  assertKnownKind(kind);
  if (!isPlainObject(fields)) {
    throw new TypeError('AST node fields must be a plain object');
  }
  if (hasOwn(fields, 'kind')) {
    throw new TypeError('AST node fields must not contain a kind property');
  }

  const owned = parserFactories.get(this);
  const clean = owned ? value => cleanOwnedFields(value, owned) : omitUndefined;
  const node = { kind, ...clean(fields) };
  if (typeof meta !== 'undefined') {
    if (!isPlainObject(meta)) {
      throw new TypeError('AST node metadata must be a plain object');
    }
    node.meta = clean(meta);
  }
  if (owned) owned.add(node);
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
  return createNode.call(this, 'SourceRange', {
    startOffset,
    endOffset,
    start,
    end,
  });
}

function diagnostic(code, message, severity = 'error', sourceRange = null) {
  return createNode.call(this, 'Diagnostic', {
    code,
    message,
    severity,
    range: sourceRange,
  });
}

function modifier(name) {
  return createNode.call(this, 'Modifier', { name });
}

function unsupportedNode(fields = {}) {
  return createNode.call(this, 'UnsupportedNode', {
    reason: fields.reason || null,
    phase: fields.phase || null,
    feature: fields.feature || null,
    text: fields.text || null,
    range: fields.range || null,
    tokens: fields.tokens || [],
  });
}

function compilationUnit(fields = {}) {
  return createNode.call(this, 'CompilationUnit', {
    packageDeclaration: fields.packageDeclaration || null,
    imports: fields.imports || [],
    typeDeclarations: fields.typeDeclarations || [],
    moduleDeclaration: fields.moduleDeclaration || null,
  }, fields.meta);
}

function packageDeclaration(name, annotations = []) {
  return createNode.call(this, 'PackageDeclaration', { name, annotations });
}

function importDeclaration(name, fields = {}) {
  return createNode.call(this, 'ImportDeclaration', {
    name,
    isStatic: Boolean(fields.isStatic),
    isWildcard: Boolean(fields.isWildcard),
  });
}

function classDeclaration(name, fields = {}) {
  return createNode.call(this, 'ClassDeclaration', {
    name,
    modifiers: fields.modifiers || [],
    annotations: fields.annotations || [],
    typeParameters: fields.typeParameters || [],
    extendsType: fields.extendsType || null,
    implementsTypes: fields.implementsTypes || [],
    permitsTypes: fields.permitsTypes || [],
    body: fields.body || [],
    // Kept so a synthesised default constructor can be attributed to the class
    // declaration line the way javac attributes it; nothing else reads it.
    range: fields.range,
  }, fields.meta);
}

function interfaceDeclaration(name, fields = {}) {
  return createNode.call(this, 'InterfaceDeclaration', {
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
  return createNode.call(this, 'EnumDeclaration', {
    name,
    modifiers: fields.modifiers || [],
    annotations: fields.annotations || [],
    implementsTypes: fields.implementsTypes || [],
    constants: fields.constants || [],
    body: fields.body || [],
  }, fields.meta);
}

function recordDeclaration(name, fields = {}) {
  return createNode.call(this, 'RecordDeclaration', {
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
  return createNode.call(this, 'FieldDeclaration', {
    modifiers: fields.modifiers || [],
    annotations: fields.annotations || [],
    fieldType,
    declarators,
  }, fields.meta);
}

function variableDeclarator(name, fields = {}) {
  return createNode.call(this, 'VariableDeclarator', {
    name,
    dimensions: fields.dimensions || 0,
    initializer: fields.initializer || null,
  }, fields.meta);
}

function methodDeclaration(name, returnType, fields = {}) {
  return createNode.call(this, 'MethodDeclaration', {
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
  return createNode.call(this, 'ConstructorDeclaration', {
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
  return createNode.call(this, 'FormalParameter', {
    name,
    parameterType,
    modifiers: fields.modifiers || [],
    annotations: fields.annotations || [],
    isVarargs: Boolean(fields.isVarargs),
  }, fields.meta);
}

function primitiveType(name, annotations = []) {
  return createNode.call(this, 'PrimitiveType', { name, annotations });
}

function voidType(annotations = []) {
  return createNode.call(this, 'VoidType', { annotations });
}

function classType(name, fields = {}) {
  return createNode.call(this, 'ClassType', {
    name,
    packageName: fields.packageName || null,
    enclosingType: fields.enclosingType || null,
    typeArguments: fields.typeArguments || [],
    annotations: fields.annotations || [],
  }, fields.meta);
}

function arrayType(componentType, dimensions = 1, annotations = []) {
  return createNode.call(this, 'ArrayType', { componentType, dimensions, annotations });
}

function typeVariable(name, fields = {}) {
  return createNode.call(this, 'TypeVariable', {
    name,
    bounds: fields.bounds || [],
    annotations: fields.annotations || [],
  }, fields.meta);
}

function wildcardType(fields = {}) {
  return createNode.call(this, 'WildcardType', {
    boundKind: fields.boundKind || null,
    boundType: fields.boundType || null,
    annotations: fields.annotations || [],
  }, fields.meta);
}

function blockStatement(statements = []) {
  return createNode.call(this, 'BlockStatement', { statements });
}

function returnStatement(expression = null) {
  return createNode.call(this, 'ReturnStatement', { expression });
}

function expressionStatement(expression) {
  return createNode.call(this, 'ExpressionStatement', { expression });
}

function identifier(name) {
  return createNode.call(this, 'Identifier', { name });
}

function qualifiedName(parts) {
  return createNode.call(this, 'QualifiedName', { parts });
}

function literalExpression(value, literalKind, raw = null) {
  return createNode.call(this, 'LiteralExpression', { value, literalKind, raw });
}

function binaryExpression(operator, left, right) {
  return createNode.call(this, 'BinaryExpression', { operator, left, right });
}

function methodInvocationExpression(fields = {}) {
  return createNode.call(this, 'MethodInvocationExpression', {
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

// Non-enumerable so the public frontend's AST factory exports stay unchanged.
Object.defineProperty(module.exports, '_createParserFactory', {value() {
  const factory = {...module.exports};
  parserFactories.set(factory, new WeakSet());
  Object.defineProperty(factory, '_finishTree', {value: detachParsedTree});
  return factory;
}});
