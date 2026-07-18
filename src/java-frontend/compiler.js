'use strict';

const fs = require('fs');
const path = require('path');
const ast = require('./ast');
const { parseJava } = require('./parser');
const { validateAstDocument } = require('./serialization');
const { JavaFrontendError, UnsupportedJavaSyntaxError } = require('./errors');
const { assembleJasminSource } = require('../utils/jasminAssembly');
const { jreCanonicalInternalName, jreClassInfo, jreInternalNameForSimpleName } = require('./jreMetadata');

const COMPILE_RESULT_SCHEMA_ID = 'java-tools.java-frontend.compile-result';
const COMPILE_RESULT_SCHEMA_VERSION = 1;
const BYTECODE_IR_SCHEMA_ID = 'java-tools.java-frontend.bytecode-ir';
const BYTECODE_IR_SCHEMA_VERSION = 1;
const CLASSFILE_MODEL_SCHEMA_ID = 'java-tools.java-frontend.classfile-model';
const CLASSFILE_MODEL_SCHEMA_VERSION = 1;

const PRIMITIVE_DESCRIPTORS = Object.freeze({
  void: 'V',
  boolean: 'Z',
  byte: 'B',
  char: 'C',
  short: 'S',
  int: 'I',
  long: 'J',
  float: 'F',
  double: 'D',
});

const JAVA_LANG_TYPES = new Set([
  'ArithmeticException', 'ArrayIndexOutOfBoundsException', 'Boolean', 'Byte',
  'Character', 'Class', 'ClassCastException', 'Double', 'Exception', 'Float',
  'IllegalArgumentException', 'Integer', 'InterruptedException', 'Long', 'NegativeArraySizeException',
  'NullPointerException', 'RuntimeException', 'StackOverflowError', 'Throwable', 'UnsupportedOperationException',
  'Comparable', 'Enum', 'Iterable', 'Math', 'Object', 'Runnable', 'Short', 'String', 'StringBuilder',
  'System', 'Thread', 'Void',
]);

const JAVA_UTIL_TYPES = new Set([
  'ArrayList', 'Collection', 'Collections', 'Deque', 'HashMap', 'HashSet',
  'Iterator', 'LinkedList', 'List', 'ListIterator', 'Map', 'Optional', 'Random', 'Set',
]);

const ACCESS_MODIFIERS = new Set([
  'public', 'protected', 'private', 'abstract', 'static', 'final', 'native',
  'synchronized', 'strictfp', 'transient', 'volatile', 'default', 'super',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function ensureMeta(document) {
  if (!isPlainObject(document.meta)) {
    document.meta = {};
  }
  return document.meta;
}

function modifierNames(modifiers) {
  return (modifiers || [])
    .map((modifier) => (typeof modifier === 'string' ? modifier : modifier && modifier.name))
    .filter((name) => typeof name === 'string' && ACCESS_MODIFIERS.has(name));
}

function hasModifier(node, name) {
  return modifierNames(node.modifiers).includes(name);
}

function dedupePreservingOrder(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function normalizeAccessFlags(modifiers, defaults = []) {
  return dedupePreservingOrder(defaults.concat(modifierNames(modifiers)));
}

function qualifiedNameToString(name) {
  if (!name) {
    return '';
  }
  if (typeof name === 'string') {
    return name;
  }
  if (Array.isArray(name.parts)) {
    return name.parts.join('.');
  }
  if (typeof name.name === 'string') {
    return name.name;
  }
  return '';
}

function packageNameForDocument(document) {
  const packageDecl = document.root && document.root.packageDeclaration;
  return packageDecl ? qualifiedNameToString(packageDecl.name) : '';
}

function internalNameFromClassName(className, packageName = '') {
  const normalizedClass = String(className || '').replace(/\./g, '/');
  if (!packageName) {
    return normalizedClass;
  }
  return `${String(packageName).replace(/\./g, '/')}/${normalizedClass}`;
}

function classTypeInternalName(type, context = {}) {
  if (type && type.kind === 'ParameterizedType') {
    return classTypeInternalName(type.baseType, context);
  }
  if (!type || type.kind !== 'ClassType') {
    throw new JavaFrontendError('Expected a ClassType node for class descriptor conversion', {
      phase: 'compile',
      details: { type },
    });
  }
  if (type.packageName) {
    const qualifiedName = `${type.packageName}.${type.name}`;
    if (context.classBySimpleName && context.classBySimpleName.has(qualifiedName)) {
      const mapped = context.classBySimpleName.get(qualifiedName);
      return jreCanonicalInternalName(mapped) || mapped;
    }
    if (/^[A-Z]/.test(String(type.packageName))) {
      return `${String(type.packageName).replace(/\./g, '$')}$${type.name}`;
    }
    const direct = `${String(type.packageName).replace(/\./g, '/')}/${type.name}`;
    if (jreClassInfo(direct)) return direct;
    const parts = String(type.packageName).split('.');
    for (let boundary = parts.length - 1; boundary > 0; boundary -= 1) {
      const packagePrefix = parts.slice(0, boundary).join('/');
      const memberSuffix = parts.slice(boundary).concat(type.name).join('$');
      const nested = `${packagePrefix}/${memberSuffix}`;
      if (jreClassInfo(nested)) return nested;
    }
    return direct;
  }
  if (JAVA_LANG_TYPES.has(type.name)) {
    return `java/lang/${type.name}`;
  }
  if (type.name === 'Function') {
    return 'java/util/function/Function';
  }
  if (['Array', 'Field', 'Method', 'Modifier'].includes(type.name)) {
    return `java/lang/reflect/${type.name}`;
  }
  if (type.name === 'ReentrantLock') {
    return 'java/util/concurrent/locks/ReentrantLock';
  }
  if (JAVA_UTIL_TYPES.has(type.name)) {
    return `java/util/${type.name}`;
  }
  if (context.classBySimpleName && context.classBySimpleName.has(type.name)) {
    return context.classBySimpleName.get(type.name);
  }
  const jreName = jreInternalNameForSimpleName(type.name);
  if (jreName) return jreName;
  return String(type.name).replace(/\./g, '/');
}

function typeVariableErasure(type, context = {}) {
  const map = context.typeParameters;
  if (map && typeof map.get === 'function' && map.has(type.name)) {
    return map.get(type.name);
  }
  if (Array.isArray(type.bounds) && type.bounds.length > 0) {
    return typeDescriptor(type.bounds[0], context);
  }
  return 'Ljava/lang/Object;';
}

function typeDescriptor(type, context = {}) {
  if (!type || typeof type.kind !== 'string') {
    throw new JavaFrontendError('Cannot derive a JVM descriptor for a missing type node', { phase: 'compile' });
  }
  if (type.kind === 'VoidType') {
    return 'V';
  }
  if (type.kind === 'PrimitiveType') {
    const descriptor = PRIMITIVE_DESCRIPTORS[type.name];
    if (!descriptor || descriptor === 'V') {
      throw new JavaFrontendError(`Unsupported primitive type for descriptor: ${type.name}`, { phase: 'compile' });
    }
    return descriptor;
  }
  if (type.kind === 'ArrayType') {
    return '['.repeat(type.dimensions || 1) + typeDescriptor(type.componentType, context);
  }
  if (type.kind === 'ClassType') {
    if (context.typeParameters && context.typeParameters.has(type.name)) {
      return context.typeParameters.get(type.name);
    }
    return `L${classTypeInternalName(type, context)};`;
  }
  if (type.kind === 'ParameterizedType') {
    return typeDescriptor(type.baseType, context);
  }
  if (type.kind === 'TypeVariable') {
    return typeVariableErasure(type, context);
  }
  if (type.kind === 'UnionType') {
    return 'Ljava/lang/Throwable;';
  }
  if (type.kind === 'UnsupportedType' && context.fallbackUnsupportedTypes === true) {
    return 'Ljava/lang/Object;';
  }
  throw new JavaFrontendError(`Unsupported type node for JVM descriptor: ${type.kind}`, {
    phase: 'compile',
    details: { type },
  });
}

function buildTypeParameterErasureMap(typeParameters = [], parent = null) {
  const map = new Map(parent ? Array.from(parent.entries()) : []);
  for (const parameter of typeParameters || []) {
    const context = { typeParameters: map };
    const descriptor = parameter.bounds && parameter.bounds.length
      ? typeDescriptor(parameter.bounds[0], context)
      : 'Ljava/lang/Object;';
    map.set(parameter.name, descriptor);
  }
  return map;
}

function methodTypeContext(method, parent = null) {
  const parentTypeParameters = parent && parent.typeParameters ? parent.typeParameters : parent;
  return {
    ...(parent && parent.typeParameters ? parent : {}),
    typeParameters: buildTypeParameterErasureMap(method.typeParameters || [], parentTypeParameters),
  };
}

function typeSignature(type, context = {}) {
  if (!type || typeof type.kind !== 'string') return null;
  if (type.kind === 'VoidType') return 'V';
  if (type.kind === 'PrimitiveType') return PRIMITIVE_DESCRIPTORS[type.name] || null;
  if (type.kind === 'ArrayType') {
    const component = typeSignature(type.componentType, context);
    return component ? `${'['.repeat(type.dimensions || 1)}${component}` : null;
  }
  if (type.kind === 'ClassType') {
    if (context.typeParameters && context.typeParameters.has(type.name)) return `T${type.name};`;
    return `L${classTypeInternalName(type, context)};`;
  }
  if (type.kind === 'TypeVariable') return `T${type.name};`;
  if (type.kind === 'UnsupportedType' && context.fallbackUnsupportedTypes === true) return 'Ljava/lang/Object;';
  if (type.kind === 'ParameterizedType') {
    const base = type.baseType;
    if (!base || base.kind !== 'ClassType') return typeSignature(base, context);
    const owner = classTypeInternalName(base, context);
    const args = (type.typeArguments || []).map((arg) => typeArgumentSignature(arg, context)).join('');
    return `L${owner}<${args}>;`;
  }
  if (type.kind === 'WildcardType') {
    return typeArgumentSignature(type, context);
  }
  return null;
}

function typeArgumentSignature(type, context = {}) {
  if (!type || type.kind === 'WildcardType' && !type.boundKind) return '*';
  if (type.kind === 'WildcardType') {
    const bound = typeSignature(type.boundType, context) || 'Ljava/lang/Object;';
    return type.boundKind === 'super' ? `-${bound}` : `+${bound}`;
  }
  return typeSignature(type, context) || '*';
}

function typeParameterSignature(parameter, context = {}) {
  const bounds = parameter.bounds && parameter.bounds.length ? parameter.bounds : [ast.classType('Object')];
  return `${parameter.name}:${bounds.map((bound) => typeSignature(bound, context) || 'Ljava/lang/Object;').join(':')}`;
}

function methodGenericSignature(method, parent = null) {
  const context = methodTypeContext(method, parent);
  const typeParams = (method.typeParameters || []).map((parameter) => typeParameterSignature(parameter, context)).join('');
  const params = (method.parameters || []).map((parameter) => {
    const signature = typeSignature(parameter.parameterType, context);
    return parameter.isVarargs ? `[${signature}` : signature;
  }).join('');
  const ret = method.kind === 'ConstructorDeclaration'
    ? 'V'
    : typeSignature(method.returnType || ast.voidType(), context);
  const prefix = typeParams ? `<${typeParams}>` : '';
  return `${prefix}(${params})${ret}`;
}

function methodDescriptor(method, parentTypeParameters = null) {
  const context = methodTypeContext(method, parentTypeParameters);
  const parameterDescriptors = (method.parameters || [])
    .map((parameter) => {
      const descriptor = typeDescriptor(parameter.parameterType, context);
      return parameter.isVarargs ? `[${descriptor}` : descriptor;
    })
    .join('');
  const returnDescriptor = method.kind === 'ConstructorDeclaration'
    ? 'V'
    : typeDescriptor(method.returnType || ast.voidType(), context);
  return `(${parameterDescriptors})${returnDescriptor}`;
}

function slotWidthFromDescriptor(descriptor) {
  return descriptor === 'J' || descriptor === 'D' ? 2 : 1;
}

function localSlotCountForMethod(method, parentTypeParameters = null) {
  const context = methodTypeContext(method, parentTypeParameters);
  const parameterSlots = (method.parameters || [])
    .map((parameter) => {
      const descriptor = typeDescriptor(parameter.parameterType, context);
      return slotWidthFromDescriptor(parameter.isVarargs ? `[${descriptor}` : descriptor);
    })
    .reduce((sum, width) => sum + width, 0);
  return parameterSlots + (hasModifier(method, 'static') ? 0 : 1);
}

function jasminAccess(flags) {
  return flags.length ? `${flags.join(' ')} ` : '';
}

function escapeJasminStringLiteral(value) {
  return JSON.stringify(value === undefined || value === null ? '' : String(value))
    .split('\\b').join('\\u0008')
    .split('\\f').join('\\u000c');
}

function annotationElementType(value) {
  if (value && typeof value === 'object' && value.type === 'enum') return `enum ${value.typeName}`;
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function annotationElementValue(value) {
  if (value && typeof value === 'object' && value.type === 'enum') return value.constName;
  if (typeof value === 'string') return escapeJasminStringLiteral(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

function annotationAttributeLines(attribute) {
  if (!attribute || attribute.type !== 'RuntimeVisibleAnnotations' || !Array.isArray(attribute.annotations) || attribute.annotations.length === 0) {
    return [];
  }
  const lines = ['.runtime visible annotations'];
  for (const annotation of attribute.annotations) {
    lines.push(`L${annotation.type};`);
    for (const [name, value] of Object.entries(annotation.elements || {})) {
      lines.push(`${name} = ${annotationElementType(value)} ${annotationElementValue(value)}`);
    }
    lines.push('.endannotation');
  }
  lines.push('.end annotations');
  return lines;
}

function attributeLines(attributes = []) {
  const lines = [];
  for (const attribute of attributes || []) {
    if (attribute.type === 'RuntimeVisibleAnnotations') {
      lines.push(...annotationAttributeLines(attribute));
    } else if (attribute.type === 'Signature' && attribute.value) {
      lines.push(`.signature ${escapeJasminStringLiteral(attribute.value)}`);
    } else if (attribute.type === 'SourceFile' && attribute.value) {
      lines.push(`.sourcefile ${escapeJasminStringLiteral(attribute.value)}`);
    } else if (attribute.type === 'exceptions' && Array.isArray(attribute.exceptions) && attribute.exceptions.length) {
      lines.push(`.exceptions ${attribute.exceptions.join(' ')}`);
    }
  }
  return lines;
}

function memberAttributesFromMeta(meta = {}) {
  const attributes = [];
  if (meta && meta.signature) attributes.push({ type: 'Signature', value: meta.signature });
  if (meta && Array.isArray(meta.exceptions) && meta.exceptions.length) {
    attributes.push({ type: 'exceptions', exceptions: meta.exceptions.slice() });
  }
  if (meta && Array.isArray(meta.annotations) && meta.annotations.length) {
    attributes.push({ type: 'RuntimeVisibleAnnotations', annotations: meta.annotations });
  }
  return attributes;
}

function literalValueFromExpression(expression) {
  if (!expression) {
    return null;
  }
  if (expression.kind === 'LiteralExpression') {
    return {
      literalKind: expression.literalKind,
      value: expression.value,
      raw: expression.raw,
    };
  }
  if (expression.kind === 'UnsupportedExpression' && Array.isArray(expression.tokens) && expression.tokens.length === 1) {
    const token = expression.tokens[0];
    if (token.kind === 'string') {
      return { literalKind: 'string', value: parseJavaStringToken(token.text), raw: token.text };
    }
    if (token.kind === 'number') {
      return { literalKind: 'number', value: token.text, raw: token.text };
    }
    if (token.text === 'true' || token.text === 'false') {
      return { literalKind: 'boolean', value: token.text === 'true', raw: token.text };
    }
    if (token.text === 'null') {
      return { literalKind: 'null', value: null, raw: token.text };
    }
  }
  return null;
}

function parseJavaStringToken(raw) {
  if (typeof raw !== 'string') {
    return raw;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      return trimmed.slice(1, -1)
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  }
  return raw;
}

function loadLiteralInstructions(literal) {
  if (!literal) {
    throw new UnsupportedJavaSyntaxError('only literal println arguments are supported by the minimal compiler', {
      phase: 'compile',
    });
  }
  if (literal.literalKind === 'string') {
    return {
      descriptor: 'Ljava/lang/String;',
      instructions: [{ opcode: 'ldc', operands: [escapeJasminStringLiteral(literal.value)] }],
      stack: 1,
    };
  }
  if (literal.literalKind === 'number') {
    const parsed = Number.parseInt(String(literal.value).replace(/_/g, ''), 10);
    if (!Number.isFinite(parsed)) {
      throw new UnsupportedJavaSyntaxError(`unsupported numeric literal: ${literal.raw || literal.value}`, { phase: 'compile' });
    }
    return {
      descriptor: 'I',
      instructions: integerPushInstructions(parsed),
      stack: 1,
    };
  }
  if (literal.literalKind === 'boolean') {
    return {
      descriptor: 'Z',
      instructions: [{ opcode: literal.value ? 'iconst_1' : 'iconst_0', operands: [] }],
      stack: 1,
    };
  }
  throw new UnsupportedJavaSyntaxError(`unsupported literal kind: ${literal.literalKind}`, { phase: 'compile' });
}

function integerPushInstructions(value) {
  if (value >= -1 && value <= 5) {
    return [{ opcode: value === -1 ? 'iconst_m1' : `iconst_${value}`, operands: [] }];
  }
  if (value >= -128 && value <= 127) {
    return [{ opcode: 'bipush', operands: [String(value)] }];
  }
  if (value >= -32768 && value <= 32767) {
    return [{ opcode: 'sipush', operands: [String(value)] }];
  }
  return [{ opcode: 'ldc', operands: [String(value)] }];
}

function chainParts(expression) {
  if (!expression) {
    return [];
  }
  if (expression.kind === 'Identifier') {
    return [expression.name];
  }
  if (expression.kind === 'QualifiedName') {
    return expression.parts || [];
  }
  if (expression.kind === 'FieldAccessExpression') {
    return chainParts(expression.target).concat(expression.name);
  }
  if (expression.kind === 'UnsupportedExpression' && typeof expression.text === 'string') {
    return expression.text.split('.').filter(Boolean);
  }
  return [];
}

function parseUnsupportedPrintlnText(expression) {
  if (!expression || expression.kind !== 'UnsupportedExpression' || typeof expression.text !== 'string') {
    return null;
  }
  const trimmed = expression.text.trim();
  const match = /^System\.out\.println\s*\((.*)\)$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const argumentText = match[1].trim();
  if (argumentText.length === 0) {
    return { arguments: [] };
  }
  if (argumentText.startsWith('"') && argumentText.endsWith('"')) {
    return {
      arguments: [ast.literalExpression(parseJavaStringToken(argumentText), 'string', argumentText)],
    };
  }
  if (/^-?\d+$/.test(argumentText)) {
    return {
      arguments: [ast.literalExpression(argumentText, 'number', argumentText)],
    };
  }
  if (argumentText === 'true' || argumentText === 'false') {
    return {
      arguments: [ast.literalExpression(argumentText === 'true', 'boolean', argumentText)],
    };
  }
  return null;
}

function getSystemOutPrintlnArguments(expression) {
  if (expression && expression.kind === 'MethodInvocationExpression' && expression.name === 'println') {
    const targetParts = chainParts(expression.target);
    if (targetParts.join('.') === 'System.out') {
      return expression.arguments || [];
    }
  }
  const fallback = parseUnsupportedPrintlnText(expression);
  if (fallback) {
    return fallback.arguments;
  }
  return null;
}

function compileExpressionStatement(statement, classIr, methodIr, options) {
  const args = getSystemOutPrintlnArguments(statement.expression);
  if (!args) {
    throw unsupportedCompileNode(statement.expression, 'only System.out.println(...) expression statements are supported');
  }
  methodIr.instructions.push({
    opcode: 'getstatic',
    operands: ['Field', 'java/lang/System', 'out', 'Ljava/io/PrintStream;'],
  });
  let descriptor;
  let argStack = 0;
  if (args.length === 0) {
    descriptor = '()V';
  } else if (args.length === 1) {
    const literalLoad = loadLiteralInstructions(literalValueFromExpression(args[0]));
    descriptor = `(${literalLoad.descriptor})V`;
    argStack = literalLoad.stack;
    methodIr.instructions.push(...literalLoad.instructions);
  } else {
    throw new UnsupportedJavaSyntaxError('minimal compiler supports at most one println argument', { phase: 'compile' });
  }
  methodIr.instructions.push({
    opcode: 'invokevirtual',
    operands: ['Method', 'java/io/PrintStream', 'println', descriptor],
  });
  methodIr.maxStack = Math.max(methodIr.maxStack, 1 + argStack);
}

function unsupportedCompileNode(node, message) {
  return new UnsupportedJavaSyntaxError(message || `unsupported Java node: ${node && node.kind}`, {
    phase: 'compile',
    range: node && node.range ? node.range : null,
    details: node || null,
  });
}

function compileStatement(statement, classIr, methodIr, options = {}) {
  if (!statement) {
    return;
  }
  switch (statement.kind) {
    case 'BlockStatement':
      for (const child of statement.statements || []) {
        compileStatement(child, classIr, methodIr, options);
      }
      return;
    case 'EmptyStatement':
      return;
    case 'ExpressionStatement':
      compileExpressionStatement(statement, classIr, methodIr, options);
      return;
    case 'ReturnStatement':
      if (methodIr.returnDescriptor === 'V' && !statement.expression) {
        methodIr.instructions.push({ opcode: 'return', operands: [] });
        methodIr.hasExplicitReturn = true;
        return;
      }
      throw unsupportedCompileNode(statement, 'minimal compiler only supports bare return; in void methods');
    default:
      throw unsupportedCompileNode(statement, `minimal compiler does not support ${statement.kind}`);
  }
}

function compileMethodDeclaration(method, classIr, options = {}) {
  const descriptor = methodDescriptor(method, classIr._typeParameters || null);
  const returnDescriptor = descriptor.slice(descriptor.indexOf(')') + 1);
  const methodIr = {
    kind: method.kind === 'ConstructorDeclaration' ? 'Constructor' : 'Method',
    name: method.kind === 'ConstructorDeclaration' ? '<init>' : method.name,
    descriptor,
    access: normalizeAccessFlags(method.modifiers, []),
    maxStack: 0,
    maxLocals: localSlotCountForMethod(method, classIr._typeParameters || null),
    returnDescriptor,
    instructions: [],
    sourceNodeKind: method.kind,
  };

  if (method.kind === 'ConstructorDeclaration') {
    methodIr.instructions.push({ opcode: 'aload_0', operands: [] });
    methodIr.instructions.push({
      opcode: 'invokespecial',
      operands: ['Method', classIr.superName, '<init>', '()V'],
    });
    methodIr.maxStack = Math.max(methodIr.maxStack, 1);
  }

  if (!method.body || method.body.kind !== 'BlockStatement') {
    if (methodIr.returnDescriptor === 'V') {
      methodIr.instructions.push({ opcode: 'return', operands: [] });
      return methodIr;
    }
    throw unsupportedCompileNode(method, `minimal compiler requires a body for non-void method ${method.name}`);
  }

  compileStatement(method.body, classIr, methodIr, options);
  if (methodIr.returnDescriptor === 'V' && !methodIr.hasExplicitReturn) {
    methodIr.instructions.push({ opcode: 'return', operands: [] });
  } else if (methodIr.returnDescriptor !== 'V') {
    throw unsupportedCompileNode(method, `minimal compiler does not yet emit non-void returns for ${method.name}`);
  }
  return methodIr;
}

function defaultConstructorIr(classIr) {
  return {
    kind: 'Constructor',
    name: '<init>',
    descriptor: '()V',
    access: ['public'],
    maxStack: 1,
    maxLocals: 1,
    returnDescriptor: 'V',
    instructions: [
      { opcode: 'aload_0', operands: [] },
      { opcode: 'invokespecial', operands: ['Method', classIr.superName, '<init>', '()V'] },
      { opcode: 'return', operands: [] },
    ],
    syntheticDefaultConstructor: true,
  };
}

function compileFieldDeclaration(field, options = {}) {
  const declarators = (field.declarators || []).map((declarator) => {
    if (declarator.initializer) {
      throw unsupportedCompileNode(declarator, 'minimal compiler does not support field initializers yet');
    }
    return {
      name: declarator.name,
      dimensions: declarator.dimensions || 0,
      initializer: null,
      initializerUnsupported: Boolean(declarator.initializer),
    };
  });
  return {
    kind: 'Field',
    access: normalizeAccessFlags(field.modifiers, []),
    descriptor: typeDescriptor(field.fieldType, {
      typeParameters: options.typeParameters || null,
      fallbackUnsupportedTypes: options.fallbackUnsupportedTypes === true,
    }),
    declarators,
  };
}

function compileClassDeclaration(classNode, document, options = {}) {
  if (classNode.kind !== 'ClassDeclaration') {
    throw unsupportedCompileNode(classNode, `minimal compiler only supports class declarations, not ${classNode.kind}`);
  }
  const packageName = packageNameForDocument(document);
  const internalName = internalNameFromClassName(classNode.name, packageName);
  const typeParameters = buildTypeParameterErasureMap(classNode.typeParameters || []);
  const superName = classNode.extendsType && (classNode.extendsType.kind === 'ClassType' || classNode.extendsType.kind === 'ParameterizedType')
    ? classTypeInternalName(classNode.extendsType)
    : 'java/lang/Object';
  const classIr = {
    kind: 'Class',
    name: classNode.name,
    packageName,
    internalName,
    sourceFile: options.sourceFileName || `${classNode.name}.java`,
    access: normalizeAccessFlags(classNode.modifiers, ['super']),
    superName,
    interfaces: (classNode.implementsTypes || []).map(classTypeInternalName),
    fields: [],
    methods: [],
  };
  Object.defineProperty(classIr, '_typeParameters', {
    value: typeParameters,
    enumerable: false,
    configurable: true,
  });

  let hasConstructor = false;
  for (const member of classNode.body || []) {
    if (member.kind === 'FieldDeclaration') {
      classIr.fields.push(compileFieldDeclaration(member, { ...options, typeParameters }));
    } else if (member.kind === 'MethodDeclaration' || member.kind === 'ConstructorDeclaration') {
      if (member.kind === 'ConstructorDeclaration') {
        hasConstructor = true;
      }
      classIr.methods.push(compileMethodDeclaration(member, classIr, options));
    } else if (member.kind === 'InitializerBlock') {
      throw unsupportedCompileNode(member, 'minimal compiler does not support initializer blocks yet');
    } else if (member.kind && member.kind.endsWith('Declaration')) {
      throw unsupportedCompileNode(member, `minimal compiler does not support nested/member ${member.kind}`);
    }
  }
  if (!hasConstructor) {
    classIr.methods.unshift(defaultConstructorIr(classIr));
  }
  return classIr;
}

function buildBytecodeIr(document, options = {}) {
  validateAstDocument(document);
  const classes = [];
  const unsupported = [];
  for (const declaration of document.root.typeDeclarations || []) {
    try {
      if (declaration.kind === 'ClassDeclaration') {
        classes.push(compileClassDeclaration(declaration, document, options));
      } else {
        throw unsupportedCompileNode(declaration, `minimal compiler only supports top-level classes, not ${declaration.kind}`);
      }
    } catch (error) {
      unsupported.push({
        kind: declaration.kind,
        reason: error.message,
        code: error.code || 'JAVA_FRONTEND_COMPILE_ERROR',
      });
      break;
    }
  }
  if (unsupported.length) {
    return {
      schema: BYTECODE_IR_SCHEMA_ID,
      version: BYTECODE_IR_SCHEMA_VERSION,
      status: 'partial',
      backend: 'minimal-jvm-bytecode',
      sourceLevel: document.sourceLevel || null,
      classes,
      unsupported,
    };
  }
  return {
    schema: BYTECODE_IR_SCHEMA_ID,
    version: BYTECODE_IR_SCHEMA_VERSION,
    status: unsupported.length ? 'partial' : 'complete',
    backend: 'minimal-jvm-bytecode',
    sourceLevel: document.sourceLevel || null,
    classes,
    unsupported,
  };
}

function formatInstruction(instruction, index) {
  const localIndexOpcodes = new Set([
    'iload', 'lload', 'fload', 'dload', 'aload',
    'istore', 'lstore', 'fstore', 'dstore', 'astore',
    'ret',
  ]);
  const operandsList = instruction.operands || [];
  if (localIndexOpcodes.has(instruction.opcode) && operandsList.length === 1) {
    const localIndex = Number(operandsList[0]);
    if (Number.isInteger(localIndex) && localIndex > 0xff) {
      const body = `wide ${instruction.opcode} ${localIndex}`;
      if (instruction.label) return `${instruction.label}:     ${body}`;
      if (typeof instruction.offset === 'number') return `L${instruction.offset}:     ${body}`;
      return `L${index}:     ${body}`;
    }
  }
  if (instruction.opcode === 'iinc' && operandsList.length >= 2) {
    const localIndex = Number(operandsList[0]);
    const increment = Number(operandsList[1]);
    if (Number.isInteger(localIndex)
        && Number.isInteger(increment)
        && (localIndex > 0xff || increment < -128 || increment > 127)) {
      const body = `wide iinc ${localIndex} ${increment}`;
      if (instruction.label) return `${instruction.label}:     ${body}`;
      if (typeof instruction.offset === 'number') return `L${instruction.offset}:     ${body}`;
      return `L${index}:     ${body}`;
    }
  }
  const operands = instruction.opcode === 'invokeinterface' && instruction.count !== undefined
    ? (instruction.operands || []).concat([instruction.count]).join(' ')
    : (instruction.operands || []).join(' ');
  const body = operands ? `${instruction.opcode} ${operands}` : instruction.opcode;
  if (instruction.label) {
    return `${instruction.label}:     ${body}`;
  }
  if (typeof instruction.offset === 'number') {
    return `L${instruction.offset}:     ${body}`;
  }
  return `L${index}:     ${body}`;
}

function fieldLines(field) {
  const lines = [];
  if (field.name && field.descriptor) {
    const access = jasminAccess(field.access || []);
    const attrs = attributeLines((field.attributes && field.attributes.length) ? field.attributes : memberAttributesFromMeta(field.meta));
    if (attrs.length) {
      lines.push(`.field ${access}${field.name} ${field.descriptor}.fieldattributes`);
      lines.push(...attrs);
      lines.push('.end fieldattributes');
    } else {
      lines.push(`.field ${access}${field.name} ${field.descriptor}`);
    }
    return lines;
  }
  for (const declarator of field.declarators || []) {
    const access = jasminAccess(field.access || []);
    let descriptor = field.descriptor;
    if (declarator.dimensions) {
      descriptor = '['.repeat(declarator.dimensions) + descriptor;
    }
    if (declarator.initializer) {
      throw unsupportedCompileNode(declarator, 'minimal classfile model does not support field initializers yet');
    }
    lines.push(`.field ${access}${declarator.name} ${descriptor}`);
  }
  return lines;
}

function methodLines(method) {
  const lines = [];
  const access = jasminAccess(method.access || []);
  lines.push(`.method ${access}${method.name} : ${method.descriptor}`);
  const attrs = attributeLines((method.attributes || []).filter((attribute) => attribute.type !== 'Signature'));
  lines.push(...attrs);
  if (!(method.access || []).includes('abstract') && !(method.access || []).includes('native')) {
    lines.push(`    .code stack ${Math.max(0, method.maxStack || 0)} locals ${Math.max(0, method.maxLocals || 0)}`);
    (method.instructions || []).forEach((instruction, index) => {
      lines.push(formatInstruction(instruction, index));
    });
    for (const entry of method.exceptionTable || []) {
      const catchType = entry.catchType || entry.catch_type || 'any';
      lines.push(`    .catch ${catchType} from ${entry.startLabel} to ${entry.endLabel} using ${entry.handlerLabel}`);
    }
    lines.push('    .end code');
  }
  lines.push('.end method');
  return lines;
}

function jasminFromClassIr(classIr) {
  const lines = [];
  lines.push('.version 52 0');
  lines.push(`.class ${jasminAccess(classIr.access || [])}${classIr.internalName}`);
  lines.push(`.super ${classIr.superName || 'java/lang/Object'}`);
  for (const iface of classIr.interfaces || []) {
    lines.push(`.implements ${iface}`);
  }
  const classAttrLines = attributeLines((classIr.attributes || []).filter((attribute) => attribute.type !== 'SourceFile' && attribute.type !== 'Signature'));
  if (classAttrLines.length) {
    lines.push(...classAttrLines);
  }
  lines.push('');
  for (const field of classIr.fields || []) {
    lines.push(...fieldLines(field));
  }
  if ((classIr.fields || []).length) {
    lines.push('');
  }
  for (const method of classIr.methods || []) {
    lines.push(...methodLines(method));
    lines.push('');
  }
  if (classIr.sourceFile) {
    lines.push(`.sourcefile ${escapeJasminStringLiteral(classIr.sourceFile)}`);
  }
  lines.push('.end class');
  return lines.join('\n');
}

function classAttributesFromIr(classIr) {
  const attributes = Array.isArray(classIr.attributes) ? classIr.attributes.map((attribute) => ({ ...attribute })) : [];
  if (classIr.sourceFile && !attributes.some((attribute) => attribute.type === 'SourceFile')) {
    attributes.push({ type: 'SourceFile', value: classIr.sourceFile });
  }
  return attributes;
}

function buildClassFileModelFromIr(bytecodeIr, options = {}) {
  const classes = (bytecodeIr.classes || []).map((classIr) => ({
    kind: 'ClassFileModel',
    internalName: classIr.internalName,
    binaryName: classIr.internalName.replace(/\//g, '.'),
    sourceFile: classIr.sourceFile || null,
    superName: classIr.superName || 'java/lang/Object',
    access: (classIr.access || []).slice(),
    attributes: classAttributesFromIr(classIr),
    fields: (classIr.fields || []).map((field) => ({
      access: (field.access || []).slice(),
      descriptor: field.descriptor,
      declarators: (field.declarators || []).map((declarator) => ({ ...declarator })),
      name: field.name,
      initializer: field.initializer || null,
      attributes: memberAttributesFromMeta(field.meta),
    })),
    methods: (classIr.methods || []).map((method) => ({
      name: method.name,
      descriptor: method.descriptor,
      access: (method.access || []).slice(),
      maxStack: method.maxStack || 0,
      maxLocals: method.maxLocals || 0,
      instructionCount: (method.instructions || []).length,
      attributes: Array.isArray(method.attributes) ? method.attributes.map((attribute) => ({ ...attribute })) : [],
    })),
    jasmin: jasminFromClassIr(classIr),
  }));
  return {
    schema: CLASSFILE_MODEL_SCHEMA_ID,
    version: CLASSFILE_MODEL_SCHEMA_VERSION,
    status: bytecodeIr.status || 'complete',
    backend: 'jasmin-assembler',
    classes,
  };
}

function outputPathForClass(outputDir, internalName) {
  return path.join(outputDir, `${internalName}.class`);
}

function writeClassFilesFromModel(classFileModel, outputDir, options = {}) {
  if (!outputDir) {
    throw new TypeError('outputDir is required to write class files');
  }
  const written = [];
  fs.mkdirSync(outputDir, { recursive: true });
  for (const classModel of classFileModel.classes || []) {
    const outputPath = outputPathForClass(outputDir, classModel.internalName);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    assembleJasminSource(classModel.jasmin, outputPath, options.assembly || {});
    written.push({
      internalName: classModel.internalName,
      binaryName: classModel.binaryName,
      outputPath,
    });
  }
  return written;
}

function compileJavaAst(document, options = {}) {
  const { lowerAstToJavaIr } = require('./javaIr');
  const { javaIrToJvmBytecodeIr } = require('./jvmBytecodeIr');
  const javaIr = lowerAstToJavaIr(document, options);
  const bytecodeIr = javaIrToJvmBytecodeIr(javaIr, options);
  if (bytecodeIr.status !== 'complete') {
    const firstUnsupported = bytecodeIr.unsupported && bytecodeIr.unsupported[0];
    const reason = firstUnsupported && firstUnsupported.reason ? firstUnsupported.reason : 'unsupported Java IR';
    throw new UnsupportedJavaSyntaxError(`minimal compiler does not support ${reason}`, { phase: 'compile' });
  }
  const classFileModel = buildClassFileModelFromIr(bytecodeIr, options);
  const classes = classFileModel.classes.map((classModel) => ({
    internalName: classModel.internalName,
    binaryName: classModel.binaryName,
    sourceFile: classModel.sourceFile,
    jasmin: classModel.jasmin,
    methods: classModel.methods,
  }));
  let written = [];
  if (options.outputDir) {
    written = writeClassFilesFromModel(classFileModel, options.outputDir, options);
    for (const classEntry of classes) {
      const match = written.find((item) => item.internalName === classEntry.internalName);
      if (match) {
        classEntry.outputPath = match.outputPath;
      }
    }
  }
  return {
    schema: COMPILE_RESULT_SCHEMA_ID,
    version: COMPILE_RESULT_SCHEMA_VERSION,
    astSchema: document.schema,
    astVersion: document.version,
    sourceLevel: document.sourceLevel || null,
    javaIr,
    bytecodeIr,
    classFileModel,
    classes,
    written,
  };
}

function compileJavaSource(source, options = {}) {
  const document = parseJava(source, options);
  return compileJavaAst(document, options);
}

function createEmitBytecodeIrPass(options = {}) {
  return {
    name: options.name || 'frontend.emitBytecodeIr',
    phase: 'bytecode',
    description: 'Emit minimal stack-machine bytecode IR for supported Java frontend AST nodes.',
    dependsOn: options.dependsOn || [],
    run(document, context) {
      const meta = ensureMeta(document);
      meta.javaFrontendBytecodeIr = buildBytecodeIr(document, options);
      if (context && typeof context.annotate === 'function') {
        context.annotate(document.root, 'frontend.bytecodeIr.backend', {
          backend: meta.javaFrontendBytecodeIr.backend,
          status: meta.javaFrontendBytecodeIr.status,
          classes: meta.javaFrontendBytecodeIr.classes.length,
        });
      }
      return document;
    },
  };
}

function createEmitClassFileModelPass(options = {}) {
  return {
    name: options.name || 'frontend.emitClassFileModel',
    phase: 'bytecode',
    description: 'Emit a serializable minimal classfile model and Jasmin source for supported Java AST nodes.',
    dependsOn: options.dependsOn || [],
    run(document, context) {
      const meta = ensureMeta(document);
      const bytecodeIr = meta.javaFrontendBytecodeIr || buildBytecodeIr(document, options);
      meta.javaFrontendBytecodeIr = bytecodeIr;
      meta.javaFrontendClassFileModel = buildClassFileModelFromIr(bytecodeIr, options);
      if (context && typeof context.annotate === 'function') {
        context.annotate(document.root, 'frontend.classFileModel.backend', {
          backend: meta.javaFrontendClassFileModel.backend,
          status: meta.javaFrontendClassFileModel.status,
          classes: meta.javaFrontendClassFileModel.classes.length,
        });
      }
      return document;
    },
  };
}

function createValidateClassFileModelPass(options = {}) {
  return {
    name: options.name || 'frontend.validateClassFileModel',
    phase: 'validation',
    description: 'Validate the minimal classfile model sidecar shape.',
    dependsOn: options.dependsOn || [],
    run(document, context) {
      const model = document.meta && document.meta.javaFrontendClassFileModel;
      if (!model || model.schema !== CLASSFILE_MODEL_SCHEMA_ID) {
        if (context && typeof context.emitDiagnostic === 'function') {
          context.emitDiagnostic('JAVA_FRONTEND_CLASSFILE_MODEL_MISSING', 'No minimal classfile model sidecar was produced.', 'warning');
        }
        return document;
      }
      for (const classModel of model.classes || []) {
        if (typeof classModel.internalName !== 'string' || !classModel.internalName) {
          throw new JavaFrontendError('Invalid classfile model: class internalName is required', { phase: 'validate' });
        }
        if (typeof classModel.jasmin !== 'string' || !classModel.jasmin.includes('.end class')) {
          throw new JavaFrontendError(`Invalid classfile model for ${classModel.internalName}: Jasmin source is missing`, { phase: 'validate' });
        }
      }
      if (context && typeof context.annotate === 'function') {
        context.annotate(document.root, 'frontend.validateClassFileModel.status', {
          status: 'validated',
          classes: (model.classes || []).length,
        });
      }
      return document;
    },
  };
}

function compileJavaFile(inputPath, options = {}) {
  const source = fs.readFileSync(inputPath, 'utf8');
  return compileJavaSource(source, {
    ...options,
    sourcePath: inputPath,
    sourceFileName: options.sourceFileName || path.basename(inputPath),
  });
}

const CLASS_LIKE_DECLARATION_KINDS = new Set([
  'ClassDeclaration',
  'InterfaceDeclaration',
  'AnnotationTypeDeclaration',
  'EnumDeclaration',
  'RecordDeclaration',
]);

function collectDeclaredInternalNames(document) {
  const packageName = packageNameForDocument(document);
  const names = [];
  function visit(declaration, outerInternalName = null) {
    if (!declaration || !CLASS_LIKE_DECLARATION_KINDS.has(declaration.kind)) {
      return;
    }
    const internalName = outerInternalName
      ? `${outerInternalName}$${declaration.name}`
      : internalNameFromClassName(declaration.name, packageName);
    names.push(internalName);
    for (const member of declaration.body || []) {
      visit(member, internalName);
    }
  }
  for (const declaration of document.root.typeDeclarations || []) {
    visit(declaration);
  }
  return names;
}

function conflictOutputDir(outputDir, inputPath, index) {
  const relative = path.relative(process.cwd(), path.resolve(inputPath));
  const safe = (relative || path.basename(inputPath))
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '') || `input_${index}`;
  return path.join(outputDir, '.java-frontend-conflicts', `${index}_${safe}`);
}

function duplicateOutputIndexes(inputPaths, outputDir, options = {}) {
  if (!outputDir) return new Set();
  const outputOwners = new Map();
  for (const [index, inputPath] of inputPaths.entries()) {
    const source = fs.readFileSync(inputPath, 'utf8');
    const document = parseJava(source, {
      ...options,
      sourcePath: inputPath,
      sourceFileName: path.basename(inputPath),
    });
    for (const internalName of collectDeclaredInternalNames(document)) {
      const outputPath = path.resolve(outputPathForClass(outputDir, internalName));
      if (!outputOwners.has(outputPath)) {
        outputOwners.set(outputPath, new Set());
      }
      outputOwners.get(outputPath).add(index);
    }
  }
  const duplicateIndexes = new Set();
  for (const owners of outputOwners.values()) {
    if (owners.size <= 1) continue;
    for (const index of owners) {
      duplicateIndexes.add(index);
    }
  }
  return duplicateIndexes;
}

function compileJavaFiles(inputPaths, options = {}) {
  if (!Array.isArray(inputPaths)) {
    throw new TypeError('compileJavaFiles expects an array of .java input paths');
  }
  if (inputPaths.length === 0) {
    throw new TypeError('compileJavaFiles requires at least one .java input path');
  }
  const duplicateIndexes = duplicateOutputIndexes(inputPaths, options.outputDir, options);
  const resolvedDirectories = inputPaths.map((inputPath) => path.dirname(path.resolve(inputPath)));
  let sourceRoot = resolvedDirectories[0];
  for (const directory of resolvedDirectories.slice(1)) {
    while (directory !== sourceRoot && !directory.startsWith(`${sourceRoot}${path.sep}`)) {
      const parent = path.dirname(sourceRoot);
      if (parent === sourceRoot) break;
      sourceRoot = parent;
    }
  }
  const results = [];
  const classes = [];
  const written = [];
  const unsupported = [];
  for (const [index, inputPath] of inputPaths.entries()) {
    const outputDir = duplicateIndexes.has(index)
      ? conflictOutputDir(options.outputDir, inputPath, index)
      : options.outputDir;
    const fileOptions = {
      ...options,
      sourceRoot: options.sourceRoot || sourceRoot,
      outputDir,
      sourcePath: inputPath,
      sourceFileName: path.basename(inputPath),
    };
    let result;
    try {
      result = compileJavaFile(inputPath, fileOptions);
    } catch (error) {
      error.message = `${inputPath}: ${error.message}`;
      throw error;
    }
    results.push({
      inputPath,
      sourceFileName: fileOptions.sourceFileName,
      outputDir,
      status: result.bytecodeIr && result.bytecodeIr.status ? result.bytecodeIr.status : 'complete',
      classes: result.classes,
      written: result.written,
      unsupported: result.bytecodeIr && Array.isArray(result.bytecodeIr.unsupported) ? result.bytecodeIr.unsupported : [],
    });
    classes.push(...(result.classes || []));
    written.push(...(result.written || []));
    if (result.bytecodeIr && Array.isArray(result.bytecodeIr.unsupported)) {
      unsupported.push(...result.bytecodeIr.unsupported.map((entry) => ({
        ...entry,
        sourcePath: inputPath,
      })));
    }
  }
  return {
    schema: COMPILE_RESULT_SCHEMA_ID,
    version: COMPILE_RESULT_SCHEMA_VERSION,
    sourceLevel: options.sourceLevel || null,
    status: unsupported.length ? 'partial' : 'complete',
    backend: 'java-frontend',
    classes,
    written,
    unsupported,
    results,
  };
}

module.exports = {
  COMPILE_RESULT_SCHEMA_ID,
  COMPILE_RESULT_SCHEMA_VERSION,
  BYTECODE_IR_SCHEMA_ID,
  BYTECODE_IR_SCHEMA_VERSION,
  CLASSFILE_MODEL_SCHEMA_ID,
  CLASSFILE_MODEL_SCHEMA_VERSION,
  typeDescriptor,
  typeSignature,
  methodGenericSignature,
  buildTypeParameterErasureMap,
  methodDescriptor,
  buildBytecodeIr,
  buildClassFileModelFromIr,
  jasminFromClassIr,
  writeClassFilesFromModel,
  compileJavaAst,
  compileJavaSource,
  compileJavaFile,
  compileJavaFiles,
  createEmitBytecodeIrPass,
  createEmitClassFileModelPass,
  createValidateClassFileModelPass,
};
