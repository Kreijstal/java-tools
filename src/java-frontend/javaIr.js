'use strict';

const fs = require('fs');
const path = require('path');
const ast = require('./ast');
const { parseJava } = require('./parser');
const { validateAstDocument } = require('./serialization');
const {
  buildTypeParameterErasureMap,
  methodDescriptor,
  methodGenericSignature,
  typeDescriptor,
  typeSignature,
} = require('./compiler');
const {
  jreClassInfo,
  jreFieldInfo,
  jreInternalNameForSimpleName,
  jreMethodCandidates,
} = require('./jreMetadata');

const JAVA_IR_SCHEMA_ID = 'java-tools.java-frontend.java-ir';
const JAVA_IR_SCHEMA_VERSION = 1;
const JAVA_IR_AST_META_KEY = 'javaFrontendJavaIr';
const SOURCE_METADATA_CACHE = new Map();

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

function assertJsonValue(value, path = '$', seen = new Set()) {
  const type = typeof value;
  if (value === null || type === 'string' || type === 'number' || type === 'boolean') {
    if (type === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`${path} must not contain non-finite numbers`);
    }
    return;
  }
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new TypeError(`${path} contains a non-JSON value (${type})`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${path} contains a cycle`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertJsonValue(value[i], `${path}[${i}]`, seen);
    }
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      assertJsonValue(value[key], `${path}.${key}`, seen);
    }
  } else {
    throw new TypeError(`${path} contains a non-plain object`);
  }
  seen.delete(value);
}

function stableJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableJsonValue(value[key]);
  }
  return out;
}

function cloneJsonValue(value) {
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value));
}

function assertString(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function modifierNames(modifiers) {
  return (modifiers || [])
    .map((modifier) => (typeof modifier === 'string' ? modifier : modifier && modifier.name))
    .filter((name) => typeof name === 'string');
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

function qualifiedNameToString(name) {
  if (!name) return '';
  if (typeof name === 'string') return name;
  if (Array.isArray(name.parts)) return name.parts.join('.');
  if (typeof name.name === 'string') return name.name;
  return '';
}

function annotationInternalName(name, context = {}) {
  const raw = qualifiedNameToString(name);
  if (!raw) return '';
  if (context.classBySimpleName && context.classBySimpleName.has(raw)) {
    return context.classBySimpleName.get(raw);
  }
  if (raw.includes('.')) return raw.replace(/\./g, '/');
  if (raw === 'Retention' || raw === 'Target' || raw === 'Documented' || raw === 'Inherited') {
    return `java/lang/annotation/${raw}`;
  }
  if (raw === 'Override' || raw === 'SafeVarargs' || raw === 'SuppressWarnings') {
    return `java/lang/${raw}`;
  }
  return raw;
}

function parseAnnotationElementTokens(tokens = []) {
  const elements = {};
  const parts = splitTopLevelByComma(tokens);
  for (const part of parts) {
    const eq = part.findIndex((token) => tokenText(token) === '=');
    const name = eq >= 0 ? tokenText(part[0]) : 'value';
    const valueTokens = eq >= 0 ? part.slice(eq + 1) : part;
    if (!name || valueTokens.length === 0) continue;
    if (valueTokens.length === 1) {
      const token = valueTokens[0];
      if (token.kind === 'string') {
        try {
          elements[name] = JSON.parse(token.text);
        } catch (error) {
          elements[name] = String(token.text).replace(/^"|"$/g, '');
        }
      } else if (token.kind === 'number') {
        elements[name] = Number(token.text);
      } else if (token.text === 'true' || token.text === 'false') {
        elements[name] = token.text === 'true';
      } else {
        elements[name] = token.text;
      }
    } else if (valueTokens.length === 3
        && valueTokens[0].kind === 'identifier'
        && tokenText(valueTokens[1]) === '.'
        && valueTokens[2].kind === 'identifier') {
      const enumOwner = valueTokens[0].text === 'RetentionPolicy'
        ? 'java/lang/annotation/RetentionPolicy'
        : valueTokens[0].text;
      elements[name] = {
        type: 'enum',
        typeName: `L${enumOwner};`,
        constName: valueTokens[2].text,
      };
    } else {
      elements[name] = valueTokens.map(tokenText).join('');
    }
  }
  return elements;
}

function annotationsMeta(annotations, context = {}) {
  return (annotations || []).map((annotation) => {
    const meta = {
      type: annotationInternalName(annotation.name, context),
      elements: {},
    };
    if (annotation.values && Array.isArray(annotation.values.tokens)) {
      meta.elements = parseAnnotationElementTokens(annotation.values.tokens);
    } else if (Array.isArray(annotation.values)) {
      for (const pair of annotation.values) {
        if (!pair || pair.kind !== 'ElementValuePair') continue;
        if (pair.value && pair.value.kind === 'LiteralExpression') {
          meta.elements[pair.name] = pair.value.literalKind === 'number'
            ? Number(String(pair.value.value).replace(/[lLfFdD]$/, ''))
            : pair.value.value;
        }
        else if (pair.value && pair.value.kind === 'FieldAccessExpression') {
          const parts = chainParts(pair.value.target);
          const owner = resolveClassInternalNameFromParts(parts, context) || parts.join('/');
          meta.elements[pair.name] = { type: 'enum', typeName: `L${owner};`, constName: pair.value.name };
        }
      }
    } else if (annotation.values && annotation.values.kind === 'LiteralExpression') {
      meta.elements.value = annotation.values.literalKind === 'number'
        ? Number(String(annotation.values.value).replace(/[lLfFdD]$/, ''))
        : annotation.values.value;
    } else if (annotation.values && annotation.values.kind === 'FieldAccessExpression') {
      const parts = chainParts(annotation.values.target);
      const owner = resolveClassInternalNameFromParts(parts, context) || parts.join('/');
      meta.elements.value = { type: 'enum', typeName: `L${owner};`, constName: annotation.values.name };
    } else if (annotation.value && Array.isArray(annotation.value.tokens)) {
      meta.elements = parseAnnotationElementTokens(annotation.value.tokens);
    }
    return meta;
  }).filter((annotation) => annotation.type);
}

function packageNameForDocument(document) {
  const packageDecl = document.root && document.root.packageDeclaration;
  return packageDecl ? qualifiedNameToString(packageDecl.name) : '';
}

function internalNameFromClassName(className, packageName = '') {
  const normalizedClass = String(className || '').replace(/\./g, '/');
  if (!packageName) return normalizedClass;
  return `${String(packageName).replace(/\./g, '/')}/${normalizedClass}`;
}

function classTypeInternalName(type, context = {}) {
  if (type && type.kind === 'ParameterizedType') return classTypeInternalName(type.baseType, context);
  if (!type || type.kind !== 'ClassType') return 'java/lang/Object';
  if (type.packageName) {
    const dotted = `${type.packageName}.${type.name}`;
    if (context.classBySimpleName && context.classBySimpleName.has(dotted)) {
      return context.classBySimpleName.get(dotted);
    }
    if (context.classBySimpleName && context.classBySimpleName.has(type.name)) {
      return context.classBySimpleName.get(type.name);
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
  if ([
    'ArithmeticException', 'ArrayIndexOutOfBoundsException', 'Boolean', 'Byte',
    'AutoCloseable', 'Character', 'Class', 'ClassCastException', 'Comparable', 'Double', 'Exception',
    'Float', 'IllegalArgumentException', 'Integer', 'Iterable', 'Long', 'Math',
    'InterruptedException', 'NegativeArraySizeException', 'NullPointerException', 'Object', 'RuntimeException',
    'Runnable', 'Short', 'StackOverflowError', 'String', 'StringBuilder', 'System', 'Thread',
    'Throwable', 'UnsupportedOperationException', 'Void',
  ].includes(type.name)) {
    return `java/lang/${type.name}`;
  }
  if ([
    'ArrayList', 'Collection', 'Collections', 'Deque', 'HashMap', 'HashSet',
    'Iterator', 'LinkedList', 'List', 'ListIterator', 'Map', 'Optional', 'Random', 'Set',
  ].includes(type.name)) return `java/util/${type.name}`;
  if (type.name === 'ReentrantLock') return 'java/util/concurrent/locks/ReentrantLock';
  if (type.name === 'Function') return 'java/util/function/Function';
  if (['Array', 'Field', 'Method', 'Modifier'].includes(type.name)) return `java/lang/reflect/${type.name}`;
  if (context.classBySimpleName && context.classBySimpleName.has(type.name)) {
    return context.classBySimpleName.get(type.name);
  }
  const jreInternalName = jreInternalNameForSimpleName(type.name);
  if (jreInternalName) return jreInternalName;
  return String(type.name).replace(/\./g, '/');
}

function internalNameFromDescriptor(descriptor) {
  if (typeof descriptor === 'string' && descriptor.startsWith('L') && descriptor.endsWith(';')) {
    return descriptor.slice(1, -1);
  }
  return 'java/lang/Object';
}

function chainParts(expression) {
  if (!expression) return [];
  if (expression.kind === 'Identifier') return [expression.name];
  if (expression.kind === 'QualifiedName') return expression.parts || [];
  if (expression.kind === 'FieldAccessExpression') return chainParts(expression.target).concat(expression.name);
  return [];
}

function isClassLikeDeclaration(declaration) {
  return declaration
    && ['ClassDeclaration', 'InterfaceDeclaration', 'AnnotationTypeDeclaration', 'EnumDeclaration'].includes(declaration.kind);
}

function resolveClassInternalNameFromParts(parts, context = {}) {
  const normalized = (parts || []).filter(Boolean);
  if (normalized.length === 0) return null;
  const dotted = normalized.join('.');
  if (context.classBySimpleName && context.classBySimpleName.has(dotted)) {
    return context.classBySimpleName.get(dotted);
  }
  const last = normalized[normalized.length - 1];
  if (context.classBySimpleName && context.classBySimpleName.has(last)) {
    return context.classBySimpleName.get(last);
  }
  if (normalized.length === 1) return constructorOwnerFromName(normalized[0], context);
  if (/^[A-Z]/.test(normalized[0])) return `${normalized[0]}$${normalized.slice(1).join('$')}`;
  return normalized.join('/');
}

function addClassPreludeName(map, name, internalName) {
  if (!name || !internalName || map.has(name)) return;
  map.set(name, internalName);
}

function cloneNestedMap(map) {
  const out = new Map();
  for (const [key, value] of map || []) {
    if (value instanceof Map) out.set(key, new Map(value));
    else out.set(key, value);
  }
  return out;
}

function formalParameterDescriptor(parameter, context) {
  const descriptor = typeDescriptor(parameter.parameterType, context);
  return parameter.isVarargs ? `[${descriptor}` : descriptor;
}

function formalParameterSignature(parameter, context) {
  const signature = typeSignature(parameter.parameterType, context);
  return parameter.isVarargs ? `[${signature}` : signature;
}

function sourceDirectoryMetadata(sourcePath, sourcePathIsDirectory = false) {
  if (!sourcePath) return null;
  const directory = sourcePathIsDirectory ? path.resolve(sourcePath) : path.dirname(path.resolve(sourcePath));
  if (SOURCE_METADATA_CACHE.has(directory)) return SOURCE_METADATA_CACHE.get(directory);
  const metadata = {
    classBySimpleName: new Map(),
    classFieldsByInternalName: new Map(),
    classMethodsByInternalName: new Map(),
    classMethodOverloadsByInternalName: new Map(),
    classSuperByInternalName: new Map(),
    classInterfacesByInternalName: new Map(),
  };
  let files = [];
  function collectJavaFiles(current, out = []) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) collectJavaFiles(full, out);
      else if (entry.isFile() && entry.name.endsWith('.java')) out.push(full);
    }
    return out;
  }
  try {
    files = collectJavaFiles(directory);
  } catch (_) {
    SOURCE_METADATA_CACHE.set(directory, metadata);
    return metadata;
  }
  const documents = [];
  for (const file of files) {
    try {
      documents.push(parseJava(fs.readFileSync(file, 'utf8'), { sourceFileName: path.basename(file) }));
    } catch (_) {
      // The prelude is best-effort; the primary compilation path still reports real parse errors.
    }
  }
  const internalNameByDeclaration = new Map();
  function collectNames(document, declaration, outerInternalName = null) {
    if (!isClassLikeDeclaration(declaration)) return;
    const packageName = packageNameForDocument(document);
    const internalName = outerInternalName
      ? `${outerInternalName}$${declaration.name}`
      : internalNameFromClassName(declaration.name, packageName);
    internalNameByDeclaration.set(declaration, internalName);
    addClassPreludeName(metadata.classBySimpleName, declaration.name, internalName);
    addClassPreludeName(metadata.classBySimpleName, internalName.replace(/\$/g, '.').replace(/\//g, '.'), internalName);
    for (const member of declaration.body || []) {
      if (isClassLikeDeclaration(member)) collectNames(document, member, internalName);
    }
  }
  for (const document of documents) {
    for (const declaration of document.root.typeDeclarations || []) collectNames(document, declaration);
  }
  function documentImportMap(document) {
    const map = new Map(metadata.classBySimpleName);
    for (const importDeclaration of document.root.imports || []) {
      if (importDeclaration.isStatic || importDeclaration.isWildcard) continue;
      const parts = importDeclaration.name && importDeclaration.name.parts;
      if (!Array.isArray(parts) || parts.length === 0) continue;
      const internalName = parts.join('/');
      map.set(parts[parts.length - 1], internalName);
      map.set(parts.join('.'), internalName);
    }
    return map;
  }
  function collectMembers(document, declaration) {
    if (!isClassLikeDeclaration(declaration)) return;
    const internalName = internalNameByDeclaration.get(declaration);
    const isInterface = declaration.kind === 'InterfaceDeclaration' || declaration.kind === 'AnnotationTypeDeclaration';
    const classTypeParameters = buildTypeParameterErasureMap(declaration.typeParameters || []);
    const classBySimpleName = documentImportMap(document);
    const classTypeContext = {
      typeParameters: classTypeParameters,
      classBySimpleName,
      fallbackUnsupportedTypes: false,
    };
    metadata.classSuperByInternalName.set(
      internalName,
      declaration.extendsType ? classTypeInternalName(declaration.extendsType, classTypeContext) : 'java/lang/Object',
    );
    metadata.classInterfacesByInternalName.set(
      internalName,
      (isInterface ? (declaration.extendsTypes || []) : (declaration.implementsTypes || []))
        .map((type) => classTypeInternalName(type, classTypeContext)),
    );
    const fields = new Map();
    const methods = new Map();
    const overloads = new Map();
    for (const member of declaration.body || []) {
      if (member.kind === 'FieldDeclaration') {
        for (const declarator of member.declarators || []) {
          try {
            fields.set(declarator.name, {
              owner: internalName,
              name: declarator.name,
              descriptor: typeDescriptor(member.fieldType, classTypeContext),
              signature: typeSignature(member.fieldType, classTypeContext),
              isStatic: modifierNames(member.modifiers).includes('static'),
            });
          } catch (_) {}
        }
      }
      if (member.kind === 'MethodDeclaration' || member.kind === 'ConstructorDeclaration') {
        try {
          const methodTypeParameters = buildTypeParameterErasureMap(member.typeParameters || [], classTypeParameters);
          const descriptor = methodDescriptor(member, classTypeContext);
          const parameterDescriptors = (member.parameters || []).map((parameter) => formalParameterDescriptor(parameter, {
            typeParameters: methodTypeParameters,
            classBySimpleName,
          }));
          const name = member.kind === 'ConstructorDeclaration' ? '<init>' : member.name;
          const summary = {
            name,
            descriptor,
            returnDescriptor: descriptor.slice(descriptor.indexOf(')') + 1),
            parameterDescriptors,
            isStatic: modifierNames(member.modifiers).includes('static'),
            isVarargs: (member.parameters || []).some((parameter) => parameter.isVarargs),
            invokeKind: isInterface && member.kind === 'MethodDeclaration' ? 'interface' : undefined,
          };
          methods.set(name, summary);
          if (!overloads.has(name)) overloads.set(name, []);
          overloads.get(name).push(summary);
        } catch (_) {}
      }
    }
    if (declaration.kind === 'EnumDeclaration') {
      const enumDescriptor = `L${internalName};`;
      const implicitMethods = [
        { name: 'values', descriptor: `()[${enumDescriptor}`, returnDescriptor: `[${enumDescriptor}`,
          parameterDescriptors: [], isStatic: true },
        { name: 'valueOf', descriptor: `(Ljava/lang/String;)${enumDescriptor}`, returnDescriptor: enumDescriptor,
          parameterDescriptors: ['Ljava/lang/String;'], isStatic: true },
      ];
      for (const summary of implicitMethods) {
        methods.set(summary.name, summary);
        if (!overloads.has(summary.name)) overloads.set(summary.name, []);
        overloads.get(summary.name).push(summary);
      }
    }
    metadata.classFieldsByInternalName.set(internalName, fields);
    metadata.classMethodsByInternalName.set(internalName, methods);
    metadata.classMethodOverloadsByInternalName.set(internalName, overloads);
    for (const member of declaration.body || []) {
      if (isClassLikeDeclaration(member)) collectMembers(document, member);
    }
  }
  for (const document of documents) {
    for (const declaration of document.root.typeDeclarations || []) collectMembers(document, declaration);
  }
  SOURCE_METADATA_CACHE.set(directory, metadata);
  return metadata;
}

function literalToJavaIrValue(expression) {
  if (!expression || expression.kind !== 'LiteralExpression') return null;
  if (expression.literalKind === 'string') {
    return {
      kind: 'LiteralValue',
      type: 'Ljava/lang/String;',
      literalKind: 'string',
      value: expression.value,
      raw: expression.raw || null,
    };
  }
  if (expression.literalKind === 'number') {
    const raw = expression.raw || String(expression.value);
    const type = numericDescriptorFromRaw(raw);
    return {
      kind: 'LiteralValue',
      type,
      literalKind: 'number',
      value: expression.value,
      raw,
    };
  }
  if (expression.literalKind === 'char') {
    return {
      kind: 'LiteralValue',
      type: 'C',
      literalKind: 'char',
      value: String(expression.value || '').charCodeAt(0) || 0,
      raw: expression.raw || `'${expression.value || ''}'`,
    };
  }
  if (expression.literalKind === 'boolean') {
    return {
      kind: 'LiteralValue',
      type: 'Z',
      literalKind: 'boolean',
      value: Boolean(expression.value),
      raw: expression.raw || String(expression.value),
    };
  }
  if (expression.literalKind === 'null') {
    return {
      kind: 'LiteralValue',
      type: 'Ljava/lang/Object;',
      literalKind: 'null',
      value: null,
      raw: expression.raw || 'null',
    };
  }
  return null;
}

function promotedIntegralDescriptor(descriptor) {
  return ['B', 'S', 'C', 'Z'].includes(descriptor) ? 'I' : descriptor;
}

function binaryNumericDescriptor(leftDescriptor, rightDescriptor) {
  const left = promotedIntegralDescriptor(leftDescriptor);
  const right = promotedIntegralDescriptor(rightDescriptor);
  if (!['I', 'J', 'F', 'D'].includes(left) || !['I', 'J', 'F', 'D'].includes(right)) return null;
  if (left === 'D' || right === 'D') return 'D';
  if (left === 'F' || right === 'F') return 'F';
  if (left === 'J' || right === 'J') return 'J';
  return 'I';
}

function binaryIntegralDescriptor(leftDescriptor, rightDescriptor) {
  const descriptor = binaryNumericDescriptor(leftDescriptor, rightDescriptor);
  return descriptor && ['I', 'J'].includes(descriptor) ? descriptor : null;
}

function isNumericDescriptor(descriptor) {
  return ['I', 'J', 'F', 'D', 'B', 'S', 'C'].includes(descriptor);
}

function isUnknownRecoveredObjectValue(value) {
  return value
    && (value.kind === 'FieldValue' || value.kind === 'StaticFieldValue')
    && value.descriptor === 'Ljava/lang/Object;';
}

function recoverNumericValueDescriptor(value, descriptor) {
  if (!value || !isNumericDescriptor(descriptor)) return value;
  if (isUnknownRecoveredObjectValue(value)) {
    return { ...value, type: descriptor, descriptor };
  }
  return value;
}

function recoverBinaryNumericOperands(left, right, descriptorSelector = binaryNumericDescriptor) {
  let recoveredLeft = boxedPrimitiveValue(left) || left;
  let recoveredRight = boxedPrimitiveValue(right) || right;
  let descriptor = recoveredLeft && recoveredRight ? descriptorSelector(recoveredLeft.type, recoveredRight.type) : null;
  if (!descriptor && recoveredLeft && recoveredRight && isUnknownRecoveredObjectValue(recoveredLeft) && isNumericDescriptor(recoveredRight.type)) {
    recoveredLeft = recoverNumericValueDescriptor(recoveredLeft, recoveredRight.type);
    descriptor = descriptorSelector(recoveredLeft.type, recoveredRight.type);
  }
  if (!descriptor && recoveredLeft && recoveredRight && isUnknownRecoveredObjectValue(recoveredRight) && isNumericDescriptor(recoveredLeft.type)) {
    recoveredRight = recoverNumericValueDescriptor(recoveredRight, recoveredLeft.type);
    descriptor = descriptorSelector(recoveredLeft.type, recoveredRight.type);
  }
  return descriptor ? { left: recoveredLeft, right: recoveredRight, descriptor } : null;
}

function numericDescriptorFromRaw(raw) {
  const text = String(raw || '');
  if (/[lL]$/.test(text)) return 'J';
  if (/^[+-]?0[xX][0-9a-fA-F_]+$/.test(text)) return 'I';
  if (/[fF]$/.test(text)) return 'F';
  if (/[dD]$/.test(text) || text.includes('.') || /[eEpP]/.test(text)) return 'D';
  return 'I';
}

function tokenText(token) {
  return token && typeof token.text === 'string' ? token.text : '';
}

function tokenTextJoined(tokens) {
  return (tokens || []).map(tokenText).join(' ');
}

function recoveredNumericLiteralToken(tokens) {
  const normalized = tokens || [];
  if (normalized.length === 3
      && normalized[0].kind === 'number'
      && (tokenText(normalized[1]) === '-' || tokenText(normalized[1]) === '+')
      && normalized[2].kind === 'number'
      && /(?:[eEpP])$/i.test(tokenText(normalized[0]))) {
    return { kind: 'number', text: `${tokenText(normalized[0])}${tokenText(normalized[1])}${tokenText(normalized[2])}` };
  }
  if ((normalized.length === 3 || normalized.length === 5)
      && normalized[0].kind === 'number'
      && /^0[xX][0-9a-fA-F_]+$/.test(tokenText(normalized[0]))
      && tokenText(normalized[1]) === '.'
      && /^[0-9a-fA-F_]+(?:[pP][+-]?[0-9_]+)?[fFdD]?$/.test(tokenText(normalized[2]))) {
    let text = `${tokenText(normalized[0])}.${tokenText(normalized[2])}`;
    if (normalized.length === 5
        && (tokenText(normalized[3]) === '-' || tokenText(normalized[3]) === '+')
        && normalized[4].kind === 'number'
        && /[pP]$/.test(text)) {
      text = `${text}${tokenText(normalized[3])}${tokenText(normalized[4])}`;
    }
    return { kind: 'number', text };
  }
  return null;
}

function trimParenTokens(tokens) {
  let out = tokens.slice();
  let changed = true;
  while (changed && out.length >= 2 && tokenText(out[0]) === '(' && tokenText(out[out.length - 1]) === ')') {
    changed = false;
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < out.length; i += 1) {
      const text = tokenText(out[i]);
      if (text === '(') depth += 1;
      if (text === ')') depth -= 1;
      if (depth === 0 && i < out.length - 1) {
        wraps = false;
        break;
      }
    }
    if (wraps) {
      out = out.slice(1, -1);
      changed = true;
    }
  }
  return out;
}

function findTopLevelOperator(tokens, operators) {
  let depth = 0;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const text = tokenText(tokens[i]);
    if (text === ')' || text === ']' || text === '}') depth += 1;
    else if (text === '(' || text === '[' || text === '{') depth -= 1;
    else if (depth === 0 && operators.includes(text)) return i;
  }
  return -1;
}

function splitTopLevelByComma(tokens) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const text = tokenText(tokens[i]);
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') depth -= 1;
    else if (text === ',' && depth === 0) {
      parts.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(tokens.slice(start));
  return parts.filter((part) => part.length > 0);
}

function splitTopLevelByToken(tokens, separatorText) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const text = tokenText(tokens[i]);
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') depth -= 1;
    else if (text === separatorText && depth === 0) {
      parts.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(tokens.slice(start));
  return parts;
}

function matchingTokenIndex(tokens, start, openText, closeText) {
  if (tokenText(tokens[start]) !== openText) return -1;
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const text = tokenText(tokens[i]);
    if (text === openText) depth += 1;
    else if (text === closeText) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findTopLevelConditional(tokens) {
  let depth = 0;
  let questionIndex = -1;
  let conditionalDepth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const text = tokenText(tokens[i]);
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') depth -= 1;
    else if (depth === 0 && text === '?') {
      if (questionIndex === -1) questionIndex = i;
      conditionalDepth += 1;
    } else if (depth === 0 && text === ':' && conditionalDepth > 0) {
      conditionalDepth -= 1;
      if (conditionalDepth === 0 && questionIndex >= 0) {
        return { questionIndex, colonIndex: i };
      }
    }
  }
  return null;
}

function splitTopLevelBySemicolon(tokens) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const text = tokenText(tokens[i]);
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') depth -= 1;
    else if (text === ';' && depth === 0) {
      parts.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(tokens.slice(start));
  return parts.filter((part) => part.length > 0);
}

function stripTypeArgumentsFromTokens(tokens) {
  const out = [];
  let depth = 0;
  for (const token of tokens || []) {
    const text = tokenText(token);
    if (text === '<') {
      depth += 1;
      continue;
    }
    if (text === '>') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out.push(token);
  }
  return out;
}

function constructorOwnerFromTypeTokens(tokens, context) {
  const erased = stripTypeArgumentsFromTokens(tokens);
  const parts = erased
    .filter((token) => token && (token.kind === 'identifier' || token.kind === 'keyword' || tokenText(token) === '.'))
    .map((token) => tokenText(token))
    .filter((text) => text !== '.');
  if (parts.length === 0) return null;
  if (parts.length === 1) return constructorOwnerFromName(parts[0], context);
  return parts.join('/');
}

function flattenConcatParts(value) {
  return value && value.kind === 'StringConcatValue' ? value.parts : [value];
}

function foldedStringConcatValue(parts) {
  if (!parts.every((part) => part && part.kind === 'LiteralValue' && part.type === 'Ljava/lang/String;')) {
    return null;
  }
  const value = parts.map((part) => part.value).join('');
  return {
    kind: 'LiteralValue',
    type: 'Ljava/lang/String;',
    literalKind: 'string',
    value,
    raw: JSON.stringify(value),
  };
}

function stringConcatValue(parts) {
  const flattened = (parts || []).flatMap(flattenConcatParts);
  const folded = foldedStringConcatValue(flattened);
  return folded || {
    kind: 'StringConcatValue',
    type: 'Ljava/lang/String;',
    parts: flattened,
  };
}

function compoundOperatorFromAssignment(operator) {
  return {
    '+=': '+',
    '-=': '-',
    '*=': '*',
    '/=': '/',
    '%=': '%',
    '&=': '&',
    '|=': '|',
    '^=': '^',
    '<<=': '<<',
    '>>=': '>>',
    '>>>=': '>>>',
  }[operator] || null;
}

function compoundAssignmentValue(left, right, descriptor, assignmentOperator) {
  const operator = compoundOperatorFromAssignment(assignmentOperator);
  if (!operator || !left || !right || !descriptor) return null;
  if (operator === '+' && descriptor === 'Ljava/lang/String;') {
    return stringConcatValue([left, right]);
  }
  return {
    kind: 'BinaryValue',
    type: descriptor,
    operator,
    left,
    right,
  };
}

function constructorOwnerFromName(name, context) {
  if (context && context.classBySimpleName && context.classBySimpleName.has(name)) {
    return context.classBySimpleName.get(name);
  }
  const jreName = jreInternalNameForSimpleName(name);
  if (jreName) return jreName;
  if ([
    'String',
    'Object',
    'StringBuilder',
    'AutoCloseable',
    'ArithmeticException',
    'ArrayIndexOutOfBoundsException',
    'Class',
    'Comparable',
    'ClassCastException',
    'Enum',
    'Exception',
    'IllegalArgumentException',
    'InterruptedException',
    'Iterable',
    'NegativeArraySizeException',
    'NullPointerException',
    'RuntimeException',
    'Runnable',
    'StackOverflowError',
    'Thread',
    'Throwable',
    'Boolean',
    'Byte',
    'Character',
    'Short',
    'Integer',
    'Long',
    'Float',
    'Double',
  ].includes(name)) return `java/lang/${name}`;
  if ([
    'ArrayList',
    'Collection',
    'Deque',
    'HashMap',
    'HashSet',
    'Iterator',
    'LinkedList',
    'List',
    'ListIterator',
    'Map',
    'Optional',
    'Random',
    'Set',
  ].includes(name)) return `java/util/${name}`;
  if (name === 'ReentrantLock') return 'java/util/concurrent/locks/ReentrantLock';
  if (name === 'Function') return 'java/util/function/Function';
  if (['Array', 'Field', 'Method', 'Modifier'].includes(name)) return `java/lang/reflect/${name}`;
  if (name === context.className) return context.classInternalName;
  return String(name || '').replace(/\./g, '/');
}

function arrayComponentDescriptor(arrayDescriptor) {
  if (typeof arrayDescriptor === 'string' && arrayDescriptor.startsWith('[')) {
    return arrayDescriptor.slice(1);
  }
  return null;
}

function primitiveDescriptorFromName(name) {
  const descriptor = PRIMITIVE_DESCRIPTOR_BY_NAME[name];
  return descriptor && descriptor !== 'V' ? descriptor : null;
}

function arrayCreationBaseDescriptor(name, context) {
  return primitiveDescriptorFromName(name) || `L${constructorOwnerFromName(name, context)};`;
}

function arrayComponentForAnewarray(componentDescriptor) {
  return componentDescriptor.startsWith('L') && componentDescriptor.endsWith(';')
    ? componentDescriptor.slice(1, -1)
    : componentDescriptor;
}

const PRIMITIVE_WRAPPER_BY_DESCRIPTOR = Object.freeze({
  Z: 'java/lang/Boolean',
  B: 'java/lang/Byte',
  C: 'java/lang/Character',
  S: 'java/lang/Short',
  I: 'java/lang/Integer',
  J: 'java/lang/Long',
  F: 'java/lang/Float',
  D: 'java/lang/Double',
});

const WRAPPER_PRIMITIVE_BY_DESCRIPTOR = Object.freeze(Object.fromEntries(
  Object.entries(PRIMITIVE_WRAPPER_BY_DESCRIPTOR).map(([primitive, owner]) => [`L${owner};`, primitive]),
));

const UNBOX_METHOD_BY_DESCRIPTOR = Object.freeze({
  Z: 'booleanValue',
  B: 'byteValue',
  C: 'charValue',
  S: 'shortValue',
  I: 'intValue',
  J: 'longValue',
  F: 'floatValue',
  D: 'doubleValue',
});

const PRIMITIVE_DESCRIPTOR_BY_NAME = Object.freeze({
  boolean: 'Z',
  byte: 'B',
  char: 'C',
  short: 'S',
  int: 'I',
  long: 'J',
  float: 'F',
  double: 'D',
  void: 'V',
});

const STATIC_CONSTANT_FIELDS = Object.freeze({
  'java/lang/Byte.MAX_VALUE': 'B',
  'java/lang/Byte.MIN_VALUE': 'B',
  'java/lang/Short.MAX_VALUE': 'S',
  'java/lang/Short.MIN_VALUE': 'S',
  'java/lang/Integer.MAX_VALUE': 'I',
  'java/lang/Integer.MIN_VALUE': 'I',
  'java/lang/Long.MAX_VALUE': 'J',
  'java/lang/Long.MIN_VALUE': 'J',
  'java/lang/Character.MAX_VALUE': 'C',
  'java/lang/Character.MIN_VALUE': 'C',
  'java/lang/Float.MAX_VALUE': 'F',
  'java/lang/Float.MIN_NORMAL': 'F',
  'java/lang/Float.MIN_VALUE': 'F',
  'java/lang/Float.NaN': 'F',
  'java/lang/Float.NEGATIVE_INFINITY': 'F',
  'java/lang/Float.POSITIVE_INFINITY': 'F',
  'java/lang/Double.MAX_VALUE': 'D',
  'java/lang/Double.MIN_NORMAL': 'D',
  'java/lang/Double.MIN_VALUE': 'D',
  'java/lang/Double.NaN': 'D',
  'java/lang/Double.NEGATIVE_INFINITY': 'D',
  'java/lang/Double.POSITIVE_INFINITY': 'D',
  'java/lang/Math.PI': 'D',
  'java/lang/Math.E': 'D',
  'java/lang/System.in': 'Ljava/io/InputStream;',
  'java/lang/System.out': 'Ljava/io/PrintStream;',
  'java/lang/System.err': 'Ljava/io/PrintStream;',
});

function booleanLiteralValue(value) {
  return {
    kind: 'LiteralValue',
    type: 'Z',
    literalKind: 'boolean',
    value: Boolean(value),
    raw: value ? 'true' : 'false',
  };
}

function logicalShortCircuitValue(operator, left, right) {
  const leftValue = boxedPrimitiveValue(left) || left;
  const rightValue = boxedPrimitiveValue(right) || right;
  if (!leftValue || !rightValue || leftValue.type !== 'Z' || rightValue.type !== 'Z') return null;
  if (operator === '||') {
    return {
      kind: 'ConditionalValue',
      type: 'Z',
      condition: leftValue,
      consequent: booleanLiteralValue(true),
      alternate: rightValue,
    };
  }
  if (operator === '&&') {
    return {
      kind: 'ConditionalValue',
      type: 'Z',
      condition: leftValue,
      consequent: rightValue,
      alternate: booleanLiteralValue(false),
    };
  }
  return null;
}

function wrapperDescriptorForPrimitive(descriptor) {
  const owner = PRIMITIVE_WRAPPER_BY_DESCRIPTOR[descriptor];
  return owner ? `L${owner};` : null;
}

function primitiveDescriptorForWrapper(descriptor) {
  return WRAPPER_PRIMITIVE_BY_DESCRIPTOR[descriptor] || null;
}

function staticTypeFieldOwnerForPrimitive(descriptor) {
  if (descriptor === 'V') return 'java/lang/Void';
  return PRIMITIVE_WRAPPER_BY_DESCRIPTOR[descriptor] || null;
}

function classConstantNameFromDescriptor(descriptor) {
  if (descriptor.startsWith('L') && descriptor.endsWith(';')) return descriptor.slice(1, -1);
  return descriptor;
}

function classLiteralFromTokens(tokens, context) {
  const normalized = tokens || [];
  if (normalized.length < 3) return null;
  if (tokenText(normalized[normalized.length - 2]) !== '.' || tokenText(normalized[normalized.length - 1]) !== 'class') return null;
  const typeTokens = normalized.slice(0, -2);
  if (typeTokens.length === 0) return null;
  const dottedParts = [];
  let dotted = true;
  for (let index = 0; index < typeTokens.length; index += 1) {
    if (index % 2 === 0) {
      if (typeTokens[index].kind !== 'identifier') {
        dotted = false;
        break;
      }
      dottedParts.push(typeTokens[index].text);
    } else if (tokenText(typeTokens[index]) !== '.') {
      dotted = false;
      break;
    }
  }
  if (dotted && dottedParts.length > 1) {
    return {
      kind: 'ClassLiteralValue',
      type: 'Ljava/lang/Class;',
      className: resolveClassInternalNameFromParts(dottedParts, context),
    };
  }
  const baseName = tokenText(typeTokens[0]);
  const primitive = PRIMITIVE_DESCRIPTOR_BY_NAME[baseName];
  let descriptor = primitive || `L${constructorOwnerFromName(baseName, context)};`;
  let index = 1;
  while (index + 1 < typeTokens.length && tokenText(typeTokens[index]) === '[' && tokenText(typeTokens[index + 1]) === ']') {
    descriptor = `[${descriptor}`;
    index += 2;
  }
  if (index !== typeTokens.length) return null;
  if (!descriptor.startsWith('[') && primitive) {
    const owner = staticTypeFieldOwnerForPrimitive(primitive);
    if (!owner) return null;
    return {
      kind: 'StaticFieldValue',
      type: 'Ljava/lang/Class;',
      owner,
      name: 'TYPE',
      descriptor: 'Ljava/lang/Class;',
    };
  }
  return {
    kind: 'ClassLiteralValue',
    type: 'Ljava/lang/Class;',
    className: classConstantNameFromDescriptor(descriptor),
  };
}

function boxedPrimitiveValue(value) {
  const primitive = value && primitiveDescriptorForWrapper(value.type);
  if (!primitive) return null;
  return {
    kind: 'MethodCallValue',
    type: primitive,
    owner: internalNameFromDescriptor(value.type),
    name: UNBOX_METHOD_BY_DESCRIPTOR[primitive],
    descriptor: `()${primitive}`,
    invokeKind: 'virtual',
    receiver: value,
    args: [],
  };
}

function descriptorFromCastToken(text, context) {
  const primitive = {
    int: 'I',
    long: 'J',
    float: 'F',
    double: 'D',
    byte: 'B',
    short: 'S',
    char: 'C',
    boolean: 'Z',
  }[text];
  if (primitive) return primitive;
  return `L${constructorOwnerFromName(text, context)};`;
}

function literalTokenToJavaIrValue(token) {
  if (!token) return null;
  if (token.kind === 'number') {
    return {
      kind: 'LiteralValue',
      type: numericDescriptorFromRaw(token.text),
      literalKind: 'number',
      value: token.text,
      raw: token.text,
    };
  }
  if (token.kind === 'string') {
    return {
      kind: 'LiteralValue',
      type: 'Ljava/lang/String;',
      literalKind: 'string',
      value: Object.prototype.hasOwnProperty.call(token, 'value') ? token.value : token.text.slice(1, -1),
      raw: token.text,
    };
  }
  if (token.kind === 'char') {
    return {
      kind: 'LiteralValue',
      type: 'C',
      literalKind: 'char',
      value: String(token.value || token.text.slice(1, -1)).charCodeAt(0) || 0,
      raw: token.text,
    };
  }
  if (token.text === 'true' || token.text === 'false') {
    return {
      kind: 'LiteralValue',
      type: 'Z',
      literalKind: 'boolean',
      value: token.text === 'true',
      raw: token.text,
    };
  }
  if (token.text === 'null') {
    return {
      kind: 'LiteralValue',
      type: 'Ljava/lang/Object;',
      literalKind: 'null',
      value: null,
      raw: token.text,
    };
  }
  return null;
}

function conditionalValueDescriptor(consequent, alternate) {
  if (!consequent || !alternate) return null;
  if (consequent.type === alternate.type) return consequent.type;
  if (consequent.literalKind === 'null' && (alternate.type.startsWith('L') || alternate.type.startsWith('['))) return alternate.type;
  if (alternate.literalKind === 'null' && (consequent.type.startsWith('L') || consequent.type.startsWith('['))) return consequent.type;
  if (['B', 'S', 'C', 'Z'].includes(consequent.type) && alternate.type === 'I') return 'I';
  if (['B', 'S', 'C', 'Z'].includes(alternate.type) && consequent.type === 'I') return 'I';
  if (['I', 'J', 'F', 'D'].includes(consequent.type) && consequent.type === alternate.type) return consequent.type;
  if ((consequent.type.startsWith('L') || consequent.type.startsWith('['))
      && (alternate.type.startsWith('L') || alternate.type.startsWith('['))) {
    return 'Ljava/lang/Object;';
  }
  return null;
}

function lowerTokenPrimaryWithConsumed(tokens, context) {
  const normalized = tokens || [];
  if (normalized.length === 0) return null;
  for (let openIndex = 2; openIndex < normalized.length; openIndex += 1) {
    if (tokenText(normalized[openIndex]) !== '(') continue;
    const closeIndex = matchingTokenIndex(normalized, openIndex, '(', ')');
    if (closeIndex < 0) break;
    const call = lowerTokenStaticMethodCallToJavaIrValue(normalized.slice(0, closeIndex + 1), context);
    if (call) return { value: call, next: closeIndex + 1 };
    break;
  }
  for (let end = Math.min(normalized.length, 8); end >= 3; end -= 1) {
    const value = classLiteralFromTokens(normalized.slice(0, end), context);
    if (value) return { value, next: end };
  }
  const literal = literalTokenToJavaIrValue(normalized[0]);
  if (literal) return { value: literal, next: 1 };
  if (tokenText(normalized[0]) === 'this' && !context.currentMethodIsStatic) {
    return { value: (context.lambdaLexicalThis && outerThisValue(context)) || thisReceiverValue(context), next: 1 };
  }
  if (normalized[0].kind === 'identifier' && context.localByName && context.localByName.has(normalized[0].text)) {
    const local = context.localByName.get(normalized[0].text);
    let current = localValue(local);
    let currentType = local.descriptor;
    let index = 1;
    while (index < normalized.length && tokenText(normalized[index]) === '[') {
      const closeIndex = matchingTokenIndex(normalized, index, '[', ']');
      if (closeIndex < 0) return null;
      const component = arrayComponentDescriptor(currentType);
      const indexValue = lowerTokenExpressionToJavaIrValue(normalized.slice(index + 1, closeIndex), context);
      if (!component || !indexValue || indexValue.type !== 'I') return null;
      current = {
        kind: 'ArrayLoadValue',
        type: component,
        array: current,
        index: indexValue,
      };
      currentType = component;
      index = closeIndex + 1;
    }
    return { value: current, next: index };
  }
  if (normalized[0].kind === 'identifier' && context.fieldByName && context.fieldByName.has(normalized[0].text)) {
    const field = context.fieldByName.get(normalized[0].text);
    let current = fieldValueForContext(field, context);
    let currentType = field.descriptor;
    let index = 1;
    while (index < normalized.length && tokenText(normalized[index]) === '[') {
      const closeIndex = matchingTokenIndex(normalized, index, '[', ']');
      if (closeIndex < 0) return null;
      const component = arrayComponentDescriptor(currentType);
      const indexValue = lowerTokenExpressionToJavaIrValue(normalized.slice(index + 1, closeIndex), context);
      if (!component || !indexValue || indexValue.type !== 'I') return null;
      current = {
        kind: 'ArrayLoadValue',
        type: component,
        array: current,
        index: indexValue,
      };
      currentType = component;
      index = closeIndex + 1;
    }
    return { value: current, next: index };
  }
  if (normalized.length >= 3
      && normalized[0].kind === 'identifier'
      && tokenText(normalized[1]) === '.'
      && normalized[2].kind === 'identifier') {
    const targetParts = [normalized[0].text];
    const owner = resolveClassInternalNameFromParts(targetParts, context);
    const name = normalized[2].text;
    if (name === 'TYPE' && (primitiveDescriptorForWrapper(`L${owner};`) || owner === 'java/lang/Void')) {
      return {
        value: {
          kind: 'StaticFieldValue',
          type: 'Ljava/lang/Class;',
          owner,
          name,
          descriptor: 'Ljava/lang/Class;',
        },
        next: 3,
      };
    }
    const fields = owner && context.classFieldsByInternalName && context.classFieldsByInternalName.get(owner);
    const field = fields && fields.get(name);
    if (field && field.isStatic) {
      return {
        value: fieldValueForContext(field, { ...context, classInternalName: owner }),
        next: 3,
      };
    }
    const descriptor = STATIC_CONSTANT_FIELDS[`${owner}.${name}`];
    if (descriptor) {
      return {
        value: {
          kind: 'StaticFieldValue',
          type: descriptor,
          owner,
          name,
          descriptor,
        },
        next: 3,
      };
    }
  }
  return null;
}

function lowerTokenMemberChainToJavaIrValue(tokens, context) {
  const normalized = trimParenTokens(tokens || []);
  const primary = lowerTokenPrimaryWithConsumed(normalized, context);
  if (!primary || primary.next >= normalized.length) return null;
  let current = primary.value;
  let index = primary.next;
  while (index < normalized.length) {
    if (tokenText(normalized[index]) === '[') {
      const closeIndex = matchingTokenIndex(normalized, index, '[', ']');
      if (closeIndex < 0) return null;
      const component = arrayComponentDescriptor(current.type);
      const indexValue = lowerTokenExpressionToJavaIrValue(normalized.slice(index + 1, closeIndex), context);
      if (!component || !indexValue || indexValue.type !== 'I') return null;
      current = {
        kind: 'ArrayLoadValue',
        type: component,
        array: current,
        index: indexValue,
      };
      index = closeIndex + 1;
      continue;
    }
    if (tokenText(normalized[index]) !== '.' || !normalized[index + 1] || normalized[index + 1].kind !== 'identifier') return null;
    const name = normalized[index + 1].text;
    if (tokenText(normalized[index + 2]) === '(') {
      const closeIndex = matchingTokenIndex(normalized, index + 2, '(', ')');
      if (closeIndex < 0) return null;
      const argumentParts = splitTopLevelByComma(normalized.slice(index + 3, closeIndex));
      const args = argumentParts.map((part, argumentIndex) => lowerTokenExpressionToJavaIrValue(part, context)
        || (name === 'computeIfAbsent' && argumentIndex === 1
          ? lowerLambdaToJavaIrValue({ kind: 'UnsupportedExpression', tokens: part }, 'Ljava/util/function/Function;', context)
          : null));
      if (!args.every(Boolean)) return null;
      const owner = internalNameFromDescriptor(current.type);
      const method = methodDescriptorForInstanceCall(owner, name, args, context);
      if (!method) return null;
      current = {
        kind: 'MethodCallValue',
        type: method.returnDescriptor,
        owner,
        name,
        descriptor: method.descriptor,
        invokeKind: method.invokeKind || 'virtual',
        receiver: current,
        args: prepareMethodArguments(method, args) || args,
      };
      index = closeIndex + 1;
      continue;
    }
    if (name === 'length' && typeof current.type === 'string' && current.type.startsWith('[')) {
      current = {
        kind: 'ArrayLengthValue',
        type: 'I',
        array: current,
      };
      index += 2;
      continue;
    }
    const owner = internalNameFromDescriptor(current.type);
    const fields = context.classFieldsByInternalName && context.classFieldsByInternalName.get(owner);
    const field = fields && fields.get(name);
    if (field) {
      current = {
        kind: 'FieldValue',
        type: field.descriptor,
        owner,
        name: field.name,
        descriptor: field.descriptor,
        receiver: current,
      };
      index += 2;
      continue;
    }
    if (owner && typeof current.type === 'string' && current.type.startsWith('L')) {
      current = {
        kind: 'FieldValue',
        type: 'Ljava/lang/Object;',
        owner,
        name,
        descriptor: 'Ljava/lang/Object;',
        receiver: current,
      };
      index += 2;
      continue;
    }
    return null;
  }
  return current;
}

function lowerTokenStaticMethodCallToJavaIrValue(tokens, context) {
  const normalized = trimParenTokens(tokens || []);
  if (normalized.length < 5 || normalized[0].kind !== 'identifier' || tokenText(normalized[1]) !== '.') return null;
  let openIndex = -1;
  for (let index = 2; index < normalized.length; index += 1) {
    if (tokenText(normalized[index]) === '(') {
      openIndex = index;
      break;
    }
  }
  if (openIndex < 3 || normalized[openIndex - 1].kind !== 'identifier') return null;
  const closeIndex = matchingTokenIndex(normalized, openIndex, '(', ')');
  if (closeIndex !== normalized.length - 1) return null;
  const owner = resolveClassInternalNameFromParts(
    normalized.slice(0, openIndex - 1)
      .filter((token) => token.kind === 'identifier')
      .map((token) => token.text),
    context,
  );
  if (!owner) return null;
  const rawArgs = splitTopLevelByComma(normalized.slice(openIndex + 1, closeIndex))
    .map((part) => lowerTokenExpressionToJavaIrValue(part, context)
      || (owner === 'java/util/stream/Stream' && normalized[openIndex - 1].text === 'generate'
        ? lowerLambdaToJavaIrValue({ kind: 'UnsupportedExpression', tokens: part },
          'Ljava/util/function/Supplier;', context) : null));
  if (!rawArgs.every(Boolean)) return null;
  const method = selectJreMethodDescriptor(owner, normalized[openIndex - 1].text, rawArgs, true)
    || selectUserMethodDescriptorInHierarchy(owner, normalized[openIndex - 1].text, rawArgs, context, true);
  const args = prepareMethodArguments(method, rawArgs);
  if (!method || !args) return null;
  return {
    kind: 'MethodCallValue',
    type: method.returnDescriptor,
    owner,
    name: method.name || normalized[openIndex - 1].text,
    descriptor: method.descriptor,
    invokeKind: method.invokeKind || 'static',
    args,
  };
}


function lowerTokenNoTargetMethodCallToJavaIrValue(tokens, context) {
  const normalized = trimParenTokens(tokens || []);
  if (normalized.length < 3 || normalized[0].kind !== 'identifier' || tokenText(normalized[1]) !== '(') return null;
  const closeIndex = matchingTokenIndex(normalized, 1, '(', ')');
  if (closeIndex !== normalized.length - 1) return null;
  const name = normalized[0].text;
  const args = splitTopLevelByComma(normalized.slice(2, closeIndex))
    .map((part) => lowerTokenExpressionToJavaIrValue(part, context));
  if (!args.every(Boolean)) return null;
  const userMethod = selectUserMethodDescriptor(context.classInternalName, name, args, context, null);
  if (userMethod) {
    const callArgs = prepareMethodArguments(userMethod, args) || args;
    if (!callArgs.every(Boolean)) return null;
    return {
      kind: 'MethodCallValue',
      type: userMethod.returnDescriptor,
      owner: context.classInternalName,
      name,
      descriptor: userMethod.descriptor,
      invokeKind: userMethod.isStatic ? 'static' : 'virtual',
      receiver: userMethod.isStatic ? undefined : thisReceiverValue(context),
      args: callArgs,
    };
  }
  const inherited = methodDescriptorForInheritedInstanceCall(name, args, context);
  if (inherited && !context.currentMethodIsStatic) {
    const callArgs = prepareMethodArguments(inherited.method, args) || args;
    if (!callArgs.every(Boolean)) return null;
    return {
      kind: 'MethodCallValue',
      type: inherited.method.returnDescriptor,
      owner: inherited.owner,
      name,
      descriptor: inherited.method.descriptor,
      invokeKind: inherited.method.invokeKind || 'virtual',
      receiver: thisReceiverValue(context),
      args: callArgs,
    };
  }
  return null;
}

function lowerTokenExpressionToJavaIrValue(tokens, context) {
  const normalized = trimParenTokens(tokens || []);
  if (normalized.length === 0) return null;
  const recoveredNumber = recoveredNumericLiteralToken(normalized);
  if (recoveredNumber) return literalTokenToJavaIrValue(recoveredNumber);

  const castCloseIndex = tokenText(normalized[0]) === '('
    ? matchingTokenIndex(normalized, 0, '(', ')') : -1;
  const castDescriptor = castCloseIndex > 1
    ? (normalized.slice(1, castCloseIndex).length === 1
      ? descriptorFromCastToken(tokenText(normalized[1]), context)
      : (() => {
        const owner = constructorOwnerFromTypeTokens(normalized.slice(1, castCloseIndex), context);
        return owner ? `L${owner};` : null;
      })()) : null;
  if (lambdaArrowIndex(normalized) >= 0 && castDescriptor) {
    const lambdaTokens = trimParenTokens(normalized.slice(castCloseIndex + 1));
    const lambda = lowerLambdaToJavaIrValue(
      { kind: 'UnsupportedExpression', tokens: lambdaTokens }, castDescriptor, context);
    if (lambda) return lambda;
  }
  if (normalized.length >= 4 && castDescriptor && castCloseIndex < normalized.length - 1) {
    const value = lowerTokenExpressionToJavaIrValue(normalized.slice(castCloseIndex + 1), context);
    const targetDescriptor = castDescriptor;
    if (targetDescriptor && value) {
      return {
        kind: 'CastValue',
        type: targetDescriptor,
        fromType: value.type,
        value,
      };
    }
  }

  if (normalized.length === 2
      && normalized[0].kind === 'identifier'
      && (tokenText(normalized[1]) === '++' || tokenText(normalized[1]) === '--')
      && context.localByName.has(normalized[0].text)) {
    const local = context.localByName.get(normalized[0].text);
    if (local.descriptor === 'I') {
      return {
        kind: 'PostUpdateValue',
        type: local.descriptor,
        target: local.id,
        operator: tokenText(normalized[1]),
      };
    }
  }

  if (normalized.length === 3
      && tokenText(normalized[0]) === 'this'
      && tokenText(normalized[1]) === '.'
      && normalized[2].kind === 'identifier'
      && context.fieldByName
      && context.fieldByName.has(normalized[2].text)) {
    const field = context.fieldByName.get(normalized[2].text);
    return {
      kind: 'FieldValue',
      type: field.descriptor,
      owner: context.classInternalName,
      name: field.name,
      descriptor: field.descriptor,
      receiver: thisReceiverValue(context),
    };
  }

  const assignIndex = findTopLevelOperator(normalized, ['=']);
  if (assignIndex > 0
      && normalized[assignIndex].kind === 'symbol'
      && tokenText(normalized[assignIndex]) === '='
      && normalized[0].kind === 'identifier'
      && assignIndex === 1
      && context.localByName.has(normalized[0].text)) {
    const local = context.localByName.get(normalized[0].text);
    const value = coerceValueToDescriptor(
      lowerTokenExpressionToJavaIrValue(normalized.slice(assignIndex + 1), context),
      local.descriptor,
    );
    if (value) {
      return {
        kind: 'AssignValue',
        type: local.descriptor,
        target: local.id,
        value,
      };
    }
    return null;
  }

  const conditional = findTopLevelConditional(normalized);
  if (conditional) {
    const condition = lowerTokenExpressionToJavaIrValue(normalized.slice(0, conditional.questionIndex), context);
    const consequentRaw = lowerTokenExpressionToJavaIrValue(normalized.slice(conditional.questionIndex + 1, conditional.colonIndex), context);
    const alternateRaw = lowerTokenExpressionToJavaIrValue(normalized.slice(conditional.colonIndex + 1), context);
    const descriptor = conditionalValueDescriptor(consequentRaw, alternateRaw);
    const consequent = descriptor ? coerceValueToDescriptor(consequentRaw, descriptor) : null;
    const alternate = descriptor ? coerceValueToDescriptor(alternateRaw, descriptor) : null;
    if (condition && condition.type === 'Z' && consequent && alternate) {
      return {
        kind: 'ConditionalValue',
        type: descriptor,
        condition,
        consequent,
        alternate,
      };
    }
    return null;
  }

  const logicalOrIndex = findTopLevelOperator(normalized, ['||']);
  if (logicalOrIndex > 0) {
    return logicalShortCircuitValue(
      '||',
      lowerTokenExpressionToJavaIrValue(normalized.slice(0, logicalOrIndex), context),
      lowerTokenExpressionToJavaIrValue(normalized.slice(logicalOrIndex + 1), context),
    );
  }

  const logicalAndIndex = findTopLevelOperator(normalized, ['&&']);
  if (logicalAndIndex > 0) {
    return logicalShortCircuitValue(
      '&&',
      lowerTokenExpressionToJavaIrValue(normalized.slice(0, logicalAndIndex), context),
      lowerTokenExpressionToJavaIrValue(normalized.slice(logicalAndIndex + 1), context),
    );
  }

  const equalityIndex = tokenText(normalized[0]) === 'new'
    ? -1
    : findTopLevelOperator(normalized, ['==', '!=', '<=', '>=', '<', '>']);
  if (equalityIndex > 0) {
    let left = lowerTokenExpressionToJavaIrValue(normalized.slice(0, equalityIndex), context);
    let right = lowerTokenExpressionToJavaIrValue(normalized.slice(equalityIndex + 1), context);
    const operator = tokenText(normalized[equalityIndex]);
    if (left && right && left.literalKind === 'null') left = coerceValueToDescriptor(left, right.type);
    if (left && right && right.literalKind === 'null') right = coerceValueToDescriptor(right, left.type);
    const recoveredComparison = recoverBinaryNumericOperands(left, right, binaryNumericDescriptor);
    if (recoveredComparison) {
      left = coerceValueToDescriptor(recoveredComparison.left, recoveredComparison.descriptor);
      right = coerceValueToDescriptor(recoveredComparison.right, recoveredComparison.descriptor);
    } else {
      left = boxedPrimitiveValue(left) || left;
      right = boxedPrimitiveValue(right) || right;
    }
    if (left && right && left.type === right.type) {
      if (typeof left.type === 'string' && (left.type.startsWith('L') || left.type.startsWith('[')) && operator !== '==' && operator !== '!=') {
        return null;
      }
      return {
        kind: 'CompareValue',
        type: 'Z',
        operator,
        left,
        right,
      };
    }
    return null;
  }

  const superCall = lowerSuperMethodCallTokens(normalized, context);
  if (superCall) return superCall;

  if (normalized.length >= 3 && normalized[0].kind === 'identifier') {
    let current = lowerTokenExpressionToJavaIrValue([normalized[0]], context);
    let index = 1;
    while (current
        && index + 3 < normalized.length
        && tokenText(normalized[index]) === '.'
        && normalized[index + 1].kind === 'identifier'
        && tokenText(normalized[index + 2]) === '('
        && tokenText(normalized[index + 3]) === ')') {
      const owner = internalNameFromDescriptor(current.type);
      const method = methodDescriptorForInstanceCall(owner, normalized[index + 1].text, [], context);
      if (!method) {
        current = null;
        break;
      }
      current = {
        kind: 'MethodCallValue',
        type: method.returnDescriptor,
        owner,
        name: normalized[index + 1].text,
        descriptor: method.descriptor,
        invokeKind: 'virtual',
        receiver: current,
        args: [],
      };
      index += 4;
    }
    if (current && index + 1 < normalized.length
        && tokenText(normalized[index]) === '.'
        && tokenText(normalized[index + 1]) === 'length') {
      if (typeof current.type !== 'string' || !current.type.startsWith('[')) return null;
      current = {
        kind: 'ArrayLengthValue',
        type: 'I',
        array: current,
      };
      index += 2;
    }
    if (current && index === normalized.length) return current;
  }

  const instanceofIndex = findTopLevelOperator(normalized, ['instanceof']);
  if (instanceofIndex > 0) {
    const value = lowerTokenExpressionToJavaIrValue(normalized.slice(0, instanceofIndex), context);
    const typeName = tokenText(normalized[instanceofIndex + 1]);
    if (value && typeName) {
      return {
        kind: 'InstanceOfValue',
        type: 'Z',
        value,
        className: constructorOwnerFromName(typeName, context),
      };
    }
    return null;
  }

  const classLiteral = classLiteralFromTokens(normalized, context);
  if (classLiteral) return classLiteral;

  for (let openIndex = normalized.length - 2; openIndex >= 3; openIndex -= 1) {
    if (tokenText(normalized[openIndex]) !== '('
        || matchingTokenIndex(normalized, openIndex, '(', ')') !== normalized.length - 1
        || normalized[openIndex - 1].kind !== 'identifier'
        || tokenText(normalized[openIndex - 2]) !== '.') continue;
    const receiver = lowerTokenExpressionToJavaIrValue(normalized.slice(0, openIndex - 2), context);
    const name = normalized[openIndex - 1].text;
    const args = splitTopLevelByComma(normalized.slice(openIndex + 1, -1))
      .map((part, argumentIndex) => lowerTokenExpressionToJavaIrValue(part, context)
        || (name === 'computeIfAbsent' && argumentIndex === 1
          ? lowerLambdaToJavaIrValue({ kind: 'UnsupportedExpression', tokens: part }, 'Ljava/util/function/Function;', context)
          : null));
    if (!receiver || !args.every(Boolean)) break;
    const owner = internalNameFromDescriptor(receiver.type);
    const method = methodDescriptorForInstanceCall(owner, name, args, context);
    const callArgs = prepareMethodArguments(method, args);
    if (method && callArgs) {
      return {
        kind: 'MethodCallValue', type: method.returnDescriptor, owner,
        name, descriptor: method.descriptor,
        invokeKind: method.invokeKind || 'virtual', receiver, args: callArgs,
      };
    }
    break;
  }

  const staticMethodCall = lowerTokenStaticMethodCallToJavaIrValue(normalized, context);
  if (staticMethodCall) return staticMethodCall;

  const noTargetMethodCall = lowerTokenNoTargetMethodCallToJavaIrValue(normalized, context);
  if (noTargetMethodCall) return noTargetMethodCall;

  const memberChain = lowerTokenMemberChainToJavaIrValue(normalized, context);
  if (memberChain) return memberChain;

  const bitwiseOrIndex = findTopLevelOperator(normalized, ['|']);
  if (bitwiseOrIndex > 0) {
    let left = lowerTokenExpressionToJavaIrValue(normalized.slice(0, bitwiseOrIndex), context);
    let right = lowerTokenExpressionToJavaIrValue(normalized.slice(bitwiseOrIndex + 1), context);
    const recovered = recoverBinaryNumericOperands(left, right, binaryIntegralDescriptor);
    if (recovered) {
      const descriptor = recovered.descriptor;
      left = coerceValueToDescriptor(recovered.left, descriptor);
      right = coerceValueToDescriptor(recovered.right, descriptor);
      return {
        kind: 'BinaryValue',
        type: descriptor,
        operator: tokenText(normalized[bitwiseOrIndex]),
        left,
        right,
      };
    }
    return null;
  }

  const bitwiseXorIndex = findTopLevelOperator(normalized, ['^']);
  if (bitwiseXorIndex > 0) {
    let left = lowerTokenExpressionToJavaIrValue(normalized.slice(0, bitwiseXorIndex), context);
    let right = lowerTokenExpressionToJavaIrValue(normalized.slice(bitwiseXorIndex + 1), context);
    const recovered = recoverBinaryNumericOperands(left, right, binaryIntegralDescriptor);
    if (recovered) {
      const descriptor = recovered.descriptor;
      left = coerceValueToDescriptor(recovered.left, descriptor);
      right = coerceValueToDescriptor(recovered.right, descriptor);
      return {
        kind: 'BinaryValue',
        type: descriptor,
        operator: tokenText(normalized[bitwiseXorIndex]),
        left,
        right,
      };
    }
    return null;
  }

  const bitwiseAndIndex = findTopLevelOperator(normalized, ['&']);
  if (bitwiseAndIndex > 0) {
    let left = lowerTokenExpressionToJavaIrValue(normalized.slice(0, bitwiseAndIndex), context);
    let right = lowerTokenExpressionToJavaIrValue(normalized.slice(bitwiseAndIndex + 1), context);
    const recovered = recoverBinaryNumericOperands(left, right, binaryIntegralDescriptor);
    if (recovered) {
      const descriptor = recovered.descriptor;
      left = coerceValueToDescriptor(recovered.left, descriptor);
      right = coerceValueToDescriptor(recovered.right, descriptor);
      return {
        kind: 'BinaryValue',
        type: descriptor,
        operator: tokenText(normalized[bitwiseAndIndex]),
        left,
        right,
      };
    }
    return null;
  }

  const shiftIndex = findTopLevelOperator(normalized, ['<<', '>>', '>>>']);
  if (shiftIndex > 0) {
    let left = lowerTokenExpressionToJavaIrValue(normalized.slice(0, shiftIndex), context);
    let right = lowerTokenExpressionToJavaIrValue(normalized.slice(shiftIndex + 1), context);
    const recoveredLeft = recoverBinaryNumericOperands(left, { kind: 'LiteralValue', type: 'I', literalKind: 'number', value: '0', raw: '0' }, binaryIntegralDescriptor);
    left = recoveredLeft ? recoveredLeft.left : (boxedPrimitiveValue(left) || left);
    right = boxedPrimitiveValue(right) || right;
    const descriptor = left && right ? binaryIntegralDescriptor(left.type, 'I') : null;
    if (left && right && descriptor && ['I', 'J'].includes(descriptor) && binaryNumericDescriptor(right.type, 'I')) {
      left = coerceValueToDescriptor(left, descriptor);
      right = coerceValueToDescriptor(right, 'I');
      return {
        kind: 'BinaryValue',
        type: descriptor,
        operator: tokenText(normalized[shiftIndex]),
        left,
        right,
      };
    }
    return null;
  }

  const addIndex = findTopLevelOperator(normalized, ['+', '-']);
  if (addIndex > 0) {
    let left = lowerTokenExpressionToJavaIrValue(normalized.slice(0, addIndex), context);
    let right = lowerTokenExpressionToJavaIrValue(normalized.slice(addIndex + 1), context);
    if (tokenText(normalized[addIndex]) === '+'
        && left && right
        && (left.type === 'Ljava/lang/String;' || right.type === 'Ljava/lang/String;'
          || left.kind === 'StringConcatValue' || right.kind === 'StringConcatValue')) {
      const parts = flattenConcatParts(left).concat(flattenConcatParts(right));
      const folded = foldedStringConcatValue(parts);
      if (folded) return folded;
      return {
        kind: 'StringConcatValue',
        type: 'Ljava/lang/String;',
        parts,
      };
    }
    const recovered = recoverBinaryNumericOperands(left, right, binaryNumericDescriptor);
    if (recovered) {
      const descriptor = recovered.descriptor;
      left = coerceValueToDescriptor(recovered.left, descriptor);
      right = coerceValueToDescriptor(recovered.right, descriptor);
      return {
        kind: 'BinaryValue',
        type: descriptor,
        operator: tokenText(normalized[addIndex]),
        left,
        right,
      };
    }
    return null;
  }

  const mulIndex = findTopLevelOperator(normalized, ['*', '/', '%']);
  if (mulIndex > 0) {
    let left = lowerTokenExpressionToJavaIrValue(normalized.slice(0, mulIndex), context);
    let right = lowerTokenExpressionToJavaIrValue(normalized.slice(mulIndex + 1), context);
    const recovered = recoverBinaryNumericOperands(left, right, binaryNumericDescriptor);
    if (recovered) {
      const descriptor = recovered.descriptor;
      left = coerceValueToDescriptor(recovered.left, descriptor);
      right = coerceValueToDescriptor(recovered.right, descriptor);
      return {
        kind: 'BinaryValue',
        type: descriptor,
        operator: tokenText(normalized[mulIndex]),
        left,
        right,
      };
    }
    return null;
  }

  if (normalized.length === 2 && tokenText(normalized[0]) === '-' && normalized[1].kind === 'number') {
    const raw = `-${normalized[1].text}`;
    return {
      kind: 'LiteralValue',
      type: numericDescriptorFromRaw(raw),
      literalKind: 'number',
      value: raw,
      raw,
    };
  }

  if (normalized.length === 2 && tokenText(normalized[0]) === '-') {
    const operand = lowerTokenExpressionToJavaIrValue([normalized[1]], context);
    if (operand && ['I', 'J', 'F', 'D'].includes(operand.type)) {
      return {
        kind: 'UnaryValue',
        type: operand.type,
        operator: '-',
        value: operand,
      };
    }
  }
  if (normalized.length >= 2 && tokenText(normalized[0]) === '+') {
    const operand = lowerTokenExpressionToJavaIrValue(normalized.slice(1), context);
    if (operand && ['I', 'J', 'F', 'D'].includes(operand.type)) return operand;
  }
  if (normalized.length >= 2 && tokenText(normalized[0]) === '!') {
    const operand = lowerTokenExpressionToJavaIrValue(normalized.slice(1), context);
    if (operand && operand.type === 'Z') {
      return {
        kind: 'UnaryValue',
        type: 'Z',
        operator: '!',
        value: operand,
      };
    }
  }
  if (normalized.length >= 2 && tokenText(normalized[0]) === '~') {
    const operand = lowerTokenExpressionToJavaIrValue(normalized.slice(1), context);
    if (operand && ['I', 'J'].includes(operand.type)) {
      return {
        kind: 'UnaryValue',
        type: operand.type,
        operator: '~',
        value: operand,
      };
    }
  }

  if (normalized.length === 1) {
    const token = normalized[0];
    const literal = literalTokenToJavaIrValue(token);
    if (literal) return literal;
    if (tokenText(token) === 'this' && !context.currentMethodIsStatic) {
      return (context.lambdaLexicalThis && outerThisValue(context)) || thisReceiverValue(context);
    }
    if (token.kind === 'identifier' && context.localByName.has(token.text)) {
      const local = context.localByName.get(token.text);
      return {
        kind: 'LocalValue',
        type: local.descriptor,
        local: local.id,
        name: local.name,
      };
    }
    if (token.kind === 'identifier' && context.fieldByName && context.fieldByName.has(token.text)) {
      const field = context.fieldByName.get(token.text);
      return fieldValueForContext(field, context);
    }
    if (token.kind === 'identifier' && context.outerFieldByName && context.outerFieldByName.has(token.text)) {
      const field = context.outerFieldByName.get(token.text);
      if (field.isStatic) return fieldValueForContext(field, context);
      const receiver = outerThisValue(context);
      if (receiver) {
        return {
          kind: 'FieldValue',
          type: field.descriptor,
          owner: field.owner,
          name: field.name,
          descriptor: field.descriptor,
          receiver,
        };
      }
    }
  }
  if (normalized.length === 3
      && normalized[0].kind === 'identifier'
      && tokenText(normalized[1]) === '.'
      && normalized[2].kind === 'identifier'
      && context.localByName.has(normalized[0].text)) {
    const receiverLocal = context.localByName.get(normalized[0].text);
    const owner = internalNameFromDescriptor(receiverLocal.descriptor);
    const fields = context.classFieldsByInternalName && context.classFieldsByInternalName.get(owner);
    const field = fields && fields.get(normalized[2].text);
    if (field) {
      return {
        kind: 'FieldValue',
        type: field.descriptor,
        owner,
        name: field.name,
        descriptor: field.descriptor,
        receiver: localValue(receiverLocal),
      };
    }
    return {
      kind: 'FieldValue',
      type: 'Ljava/lang/Object;',
      owner,
      name: normalized[2].text,
      descriptor: 'Ljava/lang/Object;',
      receiver: localValue(receiverLocal),
    };
  }
  if (normalized.length >= 3 && normalized.length % 2 === 1) {
    const parts = [];
    let dotted = true;
    for (let index = 0; index < normalized.length; index += 1) {
      if (index % 2 === 0) {
        if (normalized[index].kind !== 'identifier') {
          dotted = false;
          break;
        }
        parts.push(normalized[index].text);
      } else if (tokenText(normalized[index]) !== '.') {
        dotted = false;
        break;
      }
    }
    if (dotted && parts.length >= 2) {
      const owner = resolveClassInternalNameFromParts(parts.slice(0, -1), context);
      const name = parts[parts.length - 1];
      const fields = owner && context.classFieldsByInternalName && context.classFieldsByInternalName.get(owner);
      const field = fields && fields.get(name);
      if (field && field.isStatic) return fieldValueForContext(field, { ...context, classInternalName: owner });
      if (name === 'TYPE' && (primitiveDescriptorForWrapper(`L${owner};`) || owner === 'java/lang/Void')) {
        return {
          kind: 'StaticFieldValue',
          type: 'Ljava/lang/Class;',
          owner,
          name,
          descriptor: 'Ljava/lang/Class;',
        };
      }
      const constantDescriptor = STATIC_CONSTANT_FIELDS[`${owner}.${name}`];
      if (constantDescriptor) {
        return {
          kind: 'StaticFieldValue',
          type: constantDescriptor,
          owner,
          name,
          descriptor: constantDescriptor,
        };
      }
      if (owner && /^[A-Z][A-Z0-9_]*$/.test(name)) {
        const descriptor = `L${owner};`;
        return {
          kind: 'StaticFieldValue',
          type: descriptor,
          owner,
          name,
          descriptor,
        };
      }
      if (owner) {
        return {
          kind: 'StaticFieldValue',
          type: 'Ljava/lang/Object;',
          owner,
          name,
          descriptor: 'Ljava/lang/Object;',
          meta: { recoveredUnknownStaticField: true },
        };
      }
    }
  }
  if (tokenText(normalized[0]) === '{' && tokenText(normalized[normalized.length - 1]) === '}') {
    return {
      kind: 'ArrayInitializerValue',
      type: null,
      elements: splitTopLevelByComma(normalized.slice(1, -1)).map((part) => lowerTokenExpressionToJavaIrValue(part, context)),
    };
  }
  if (normalized[0] && normalized[0].kind === 'identifier' && context.localByName.has(normalized[0].text)) {
    let index = 1;
    let current = null;
    const local = context.localByName.get(normalized[0].text);
    let currentType = local.descriptor;
    while (index < normalized.length && tokenText(normalized[index]) === '[') {
      const closeIndex = matchingTokenIndex(normalized, index, '[', ']');
      if (closeIndex === -1) {
        current = null;
        break;
      }
      const component = arrayComponentDescriptor(currentType);
      const indexValue = lowerTokenExpressionToJavaIrValue(normalized.slice(index + 1, closeIndex), context);
      if (!component || !indexValue || indexValue.type !== 'I') {
        current = null;
        break;
      }
      current = {
        kind: 'ArrayLoadValue',
        type: component,
        array: current || {
          kind: 'LocalValue',
          type: local.descriptor,
          local: local.id,
          name: local.name,
        },
        index: indexValue,
      };
      currentType = component;
      index = closeIndex + 1;
    }
    if (current
        && index + 2 === normalized.length
        && tokenText(normalized[index]) === '.'
        && tokenText(normalized[index + 1]) === 'length') {
      return {
        kind: 'ArrayLengthValue',
        type: 'I',
        array: current,
      };
    }
    if (current && index === normalized.length) return current;
  }
  if (normalized.length >= 4 && tokenText(normalized[0]) === 'new' && tokenText(normalized[normalized.length - 1]) === ')') {
    let angleDepth = 0;
    let openIndex = -1;
    for (let index = 1; index < normalized.length; index += 1) {
      const text = tokenText(normalized[index]);
      if (text === '<') angleDepth += 1;
      else if (text === '>') angleDepth = Math.max(0, angleDepth - 1);
      else if (text === '(' && angleDepth === 0) {
        openIndex = index;
        break;
      }
    }
    if (openIndex > 1) {
      const owner = constructorOwnerFromTypeTokens(normalized.slice(1, openIndex), context);
      const argParts = splitTopLevelByComma(normalized.slice(openIndex + 1, -1));
      const overloads = owner && context.classMethodOverloadsByInternalName
        && context.classMethodOverloadsByInternalName.get(owner);
      const candidates = overloads && overloads.get('<init>');
      const contextualConstructor = Array.isArray(candidates)
        ? candidates.find((candidate) => candidate.parameterDescriptors.length === argParts.length) : null;
      const args = argParts.map((part, index) =>
        lowerTokenExpressionToJavaIrValue(part, context)
        || (contextualConstructor && lowerLambdaToJavaIrValue(
          { kind: 'UnsupportedExpression', tokens: part },
          contextualConstructor.parameterDescriptors[index], context)));
      if (owner && args.every(Boolean)) {
        const method = methodDescriptorForConstructorCall(owner, args, context);
        const coercedArgs = prepareMethodArguments(method, args) || args;
        return {
          kind: 'NewObjectValue',
          type: `L${owner};`,
          owner,
          descriptor: method.descriptor || `(${coercedArgs.map((arg) => arg.type).join('')})V`,
          args: coercedArgs,
        };
      }
    }
  }
  if (normalized.length >= 5 && tokenText(normalized[0]) === 'new') {
    const typeName = tokenText(normalized[1]);
    const baseDescriptor = arrayCreationBaseDescriptor(typeName, context);
    let initIndex = 2;
    let initDimensions = 0;
    while (initIndex + 1 < normalized.length && tokenText(normalized[initIndex]) === '[' && tokenText(normalized[initIndex + 1]) === ']') {
      initDimensions += 1;
      initIndex += 2;
    }
    if (initDimensions > 0 && tokenText(normalized[initIndex]) === '{' && tokenText(normalized[normalized.length - 1]) === '}') {
      const initializer = lowerTokenExpressionToJavaIrValue(normalized.slice(initIndex), context);
      return coerceValueToDescriptor(initializer, `${'['.repeat(initDimensions)}${baseDescriptor}`);
    }
    const counts = [];
    let dimensions = 0;
    let index = 2;
    while (index < normalized.length && tokenText(normalized[index]) === '[') {
      const closeIndex = matchingTokenIndex(normalized, index, '[', ']');
      if (closeIndex === -1) break;
      if (closeIndex !== index + 1) {
        const count = lowerTokenExpressionToJavaIrValue(normalized.slice(index + 1, closeIndex), context);
        if (!count || count.type !== 'I') return null;
        counts.push(count);
      }
      dimensions += 1;
      index = closeIndex + 1;
    }
    if (index !== normalized.length || dimensions === 0 || counts.length === 0) return null;
    const type = `${'['.repeat(dimensions)}${baseDescriptor}`;
    if (counts.length > 1) {
      return {
        kind: 'MultiNewArrayValue',
        type,
        counts,
      };
    }
    const component = type.slice(1);
    const primitiveComponentName = Object.entries(PRIMITIVE_DESCRIPTOR_BY_NAME).find(([, descriptor]) => descriptor === component);
    return {
      kind: 'NewArrayValue',
      type,
      component: primitiveComponentName ? primitiveComponentName[0] : arrayComponentForAnewarray(component),
      reference: !primitiveComponentName,
      count: counts[0],
    };
  }
  return null;
}

function methodDescriptorForInstanceCall(owner, name, args, context) {
  if (owner === 'java/lang/invoke/MethodHandle' && name === 'invoke') {
    const parameterDescriptors = args.map((arg) => {
      if (arg && typeof arg.type === 'string' && (arg.type.startsWith('L') || arg.type.startsWith('['))) {
        return 'Ljava/lang/Object;';
      }
      return arg && arg.type ? arg.type : 'Ljava/lang/Object;';
    });
    return {
      descriptor: `(${parameterDescriptors.join('')})Ljava/lang/Object;`,
      returnDescriptor: 'Ljava/lang/Object;',
      parameterDescriptors,
    };
  }
  const jreMethod = selectJreMethodDescriptor(owner, name, args, false);
  if (jreMethod) return jreMethod;
  if (name === 'getClass' && args.length === 0 && typeof owner === 'string') {
    return { descriptor: '()Ljava/lang/Class;', returnDescriptor: 'Ljava/lang/Class;' };
  }
  if (owner === 'java/lang/String') {
    if (name === 'equals' && args.length === 1) return { descriptor: '(Ljava/lang/Object;)Z', returnDescriptor: 'Z' };
    if (name === 'length' && args.length === 0) return { descriptor: '()I', returnDescriptor: 'I' };
    if (name === 'toString' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    if (name === 'intern' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    if (name === 'toUpperCase' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    if (name === 'toLowerCase' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    if (name === 'concat' && args.length === 1 && args[0].type === 'Ljava/lang/String;') {
      return { descriptor: '(Ljava/lang/String;)Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    }
    if (name === 'repeat' && args.length === 1 && args[0].type === 'I') {
      return { descriptor: '(I)Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    }
    if (name === 'charAt' && args.length === 1 && args[0].type === 'I') {
      return { descriptor: '(I)C', returnDescriptor: 'C' };
    }
    if (name === 'getBytes' && args.length === 0) return { descriptor: '()[B', returnDescriptor: '[B' };
    if (name === 'getBytes' && args.length === 1 && args[0].type === 'Ljava/lang/String;') {
      return { descriptor: '(Ljava/lang/String;)[B', returnDescriptor: '[B' };
    }
  }
  if (owner === 'javax/crypto/SecretKey') {
    if (name === 'getEncoded' && args.length === 0) {
      return { descriptor: '()[B', returnDescriptor: '[B', parameterDescriptors: [], invokeKind: 'interface' };
    }
  }
  if (owner === 'java/lang/StringBuilder') {
    if (name === 'toString' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    if (name === 'append' && args.length === 1) {
      const descriptor = ['I', 'Z', 'C', 'J', 'F', 'D'].includes(args[0].type)
        ? args[0].type
        : (args[0].type === 'B' || args[0].type === 'S')
          ? 'I'
          : (args[0].type === 'Ljava/lang/String;' ? 'Ljava/lang/String;' : 'Ljava/lang/Object;');
      return { descriptor: `(${descriptor})Ljava/lang/StringBuilder;`, returnDescriptor: 'Ljava/lang/StringBuilder;' };
    }
  }
  if (owner === 'java/lang/Class') {
    if (name === 'cast' && args.length === 1) return { descriptor: '(Ljava/lang/Object;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;', parameterDescriptors: ['Ljava/lang/Object;'] };
    if (name === 'getName' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    if (name === 'getSimpleName' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    if (name === 'getSuperclass' && args.length === 0) return { descriptor: '()Ljava/lang/Class;', returnDescriptor: 'Ljava/lang/Class;' };
    if (name === 'getMethods' && args.length === 0) return { descriptor: '()[Ljava/lang/reflect/Method;', returnDescriptor: '[Ljava/lang/reflect/Method;' };
    if (name === 'getFields' && args.length === 0) return { descriptor: '()[Ljava/lang/reflect/Field;', returnDescriptor: '[Ljava/lang/reflect/Field;' };
    if (name === 'getMethod' && args.length === 1 && args[0].type === 'Ljava/lang/String;') return { descriptor: '(Ljava/lang/String;)Ljava/lang/reflect/Method;', returnDescriptor: 'Ljava/lang/reflect/Method;', parameterDescriptors: ['Ljava/lang/String;'] };
    if (name === 'getMethod' && args.length >= 2) return { descriptor: '(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;', returnDescriptor: 'Ljava/lang/reflect/Method;', parameterDescriptors: ['Ljava/lang/String;', '[Ljava/lang/Class;'], isVarargs: true };
    if (name === 'getDeclaredMethod' && args.length === 1 && args[0].type === 'Ljava/lang/String;') return { descriptor: '(Ljava/lang/String;)Ljava/lang/reflect/Method;', returnDescriptor: 'Ljava/lang/reflect/Method;' };
    if (name === 'getDeclaredMethod' && args.length >= 2) return { descriptor: '(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;', returnDescriptor: 'Ljava/lang/reflect/Method;', parameterDescriptors: ['Ljava/lang/String;', '[Ljava/lang/Class;'], isVarargs: true };
    if (name === 'getDeclaredField' && args.length === 1 && args[0].type === 'Ljava/lang/String;') return { descriptor: '(Ljava/lang/String;)Ljava/lang/reflect/Field;', returnDescriptor: 'Ljava/lang/reflect/Field;' };
    if (name === 'isAnnotationPresent' && args.length === 1 && args[0].type === 'Ljava/lang/Class;') return { descriptor: '(Ljava/lang/Class;)Z', returnDescriptor: 'Z' };
    if (name === 'getAnnotation' && args.length === 1 && args[0].type === 'Ljava/lang/Class;') return { descriptor: '(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;', returnDescriptor: 'Ljava/lang/annotation/Annotation;' };
    if (name === 'isPrimitive' && args.length === 0) return { descriptor: '()Z', returnDescriptor: 'Z' };
    if (name === 'isArray' && args.length === 0) return { descriptor: '()Z', returnDescriptor: 'Z' };
    if (name === 'isInterface' && args.length === 0) return { descriptor: '()Z', returnDescriptor: 'Z' };
  }
  if (owner === 'java/lang/reflect/Method') {
    if (name === 'getName' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    if (name === 'setAccessible' && args.length === 1 && args[0].type === 'Z') return { descriptor: '(Z)V', returnDescriptor: 'V' };
    if (name === 'invoke' && args.length === 1) return { descriptor: '(Ljava/lang/Object;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;' };
    if (name === 'invoke' && args.length === 2) return { descriptor: '(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;' };
    if (name === 'invoke' && args.length === 3) return { descriptor: '(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;' };
    if (name === 'isAnnotationPresent' && args.length === 1 && args[0].type === 'Ljava/lang/Class;') return { descriptor: '(Ljava/lang/Class;)Z', returnDescriptor: 'Z' };
    if (name === 'getAnnotation' && args.length === 1 && args[0].type === 'Ljava/lang/Class;') return { descriptor: '(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;', returnDescriptor: 'Ljava/lang/annotation/Annotation;' };
  }
  if (owner === 'java/lang/reflect/Field') {
    if (name === 'getName' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    if (name === 'get' && args.length === 1) return { descriptor: '(Ljava/lang/Object;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;', parameterDescriptors: ['Ljava/lang/Object;'] };
    if (name === 'getModifiers' && args.length === 0) return { descriptor: '()I', returnDescriptor: 'I' };
    if (name === 'isAnnotationPresent' && args.length === 1 && args[0].type === 'Ljava/lang/Class;') return { descriptor: '(Ljava/lang/Class;)Z', returnDescriptor: 'Z' };
    if (name === 'getAnnotation' && args.length === 1 && args[0].type === 'Ljava/lang/Class;') return { descriptor: '(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;', returnDescriptor: 'Ljava/lang/annotation/Annotation;' };
  }
  if (owner === 'java/lang/Object') {
    if (name === 'getClass' && args.length === 0) return { descriptor: '()Ljava/lang/Class;', returnDescriptor: 'Ljava/lang/Class;' };
    if (name === 'toString' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    if (name === 'equals' && args.length === 1) return { descriptor: '(Ljava/lang/Object;)Z', returnDescriptor: 'Z' };
  }
  if (typeof owner === 'string') {
    if (name === 'getClass' && args.length === 0) return { descriptor: '()Ljava/lang/Class;', returnDescriptor: 'Ljava/lang/Class;' };
    if (name === 'toString' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    if (name === 'equals' && args.length === 1) return { descriptor: '(Ljava/lang/Object;)Z', returnDescriptor: 'Z' };
    if (name === 'compareTo' && args.length === 1) {
      return { descriptor: `(${args[0].type})I`, returnDescriptor: 'I', parameterDescriptors: [args[0].type] };
    }
  }
  if (owner === 'java/lang/Comparable') {
    if (name === 'compareTo' && args.length === 1) {
      return {
        descriptor: '(Ljava/lang/Object;)I',
        returnDescriptor: 'I',
        parameterDescriptors: ['Ljava/lang/Object;'],
        invokeKind: 'interface',
      };
    }
  }
  if (owner === 'java/lang/Iterable') {
    if (name === 'iterator' && args.length === 0) {
      return {
        descriptor: '()Ljava/util/Iterator;',
        returnDescriptor: 'Ljava/util/Iterator;',
        parameterDescriptors: [],
        invokeKind: 'interface',
      };
    }
  }
  if (owner === 'java/util/Iterator') {
    if (name === 'hasNext' && args.length === 0) {
      return { descriptor: '()Z', returnDescriptor: 'Z', parameterDescriptors: [], invokeKind: 'interface' };
    }
    if (name === 'next' && args.length === 0) {
      return { descriptor: '()Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;', parameterDescriptors: [], invokeKind: 'interface' };
    }
  }
  if (owner === 'java/util/Collection' || owner === 'java/util/List') {
    if (name === 'stream' && args.length === 0) {
      return { descriptor: '()Ljava/util/stream/Stream;', returnDescriptor: 'Ljava/util/stream/Stream;', parameterDescriptors: [], invokeKind: 'interface' };
    }
    if (name === 'iterator' && args.length === 0) {
      return {
        descriptor: '()Ljava/util/Iterator;',
        returnDescriptor: 'Ljava/util/Iterator;',
        parameterDescriptors: [],
        invokeKind: 'interface',
      };
    }
    if (name === 'add' && args.length === 1) {
      return {
        descriptor: '(Ljava/lang/Object;)Z',
        returnDescriptor: 'Z',
        parameterDescriptors: ['Ljava/lang/Object;'],
        invokeKind: 'interface',
      };
    }
    if (name === 'get' && args.length === 1 && args[0].type === 'I') {
      return {
        descriptor: '(I)Ljava/lang/Object;',
        returnDescriptor: 'Ljava/lang/Object;',
        parameterDescriptors: ['I'],
        invokeKind: 'interface',
      };
    }
  }
  if (owner === 'java/util/Map') {
    if (name === 'get' && args.length === 1) {
      return { descriptor: '(Ljava/lang/Object;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;', parameterDescriptors: ['Ljava/lang/Object;'], invokeKind: 'interface' };
    }
    if (name === 'put' && args.length === 2) {
      return { descriptor: '(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;', parameterDescriptors: ['Ljava/lang/Object;', 'Ljava/lang/Object;'], invokeKind: 'interface' };
    }
    if (name === 'computeIfAbsent' && args.length === 2) {
      return { descriptor: '(Ljava/lang/Object;Ljava/util/function/Function;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;', parameterDescriptors: ['Ljava/lang/Object;', 'Ljava/util/function/Function;'], invokeKind: 'interface' };
    }
    if (name === 'values' && args.length === 0) {
      return { descriptor: '()Ljava/util/Collection;', returnDescriptor: 'Ljava/util/Collection;', parameterDescriptors: [], invokeKind: 'interface' };
    }
  }
  if (owner === 'java/lang/Runnable') {
    if (name === 'run' && args.length === 0) return { descriptor: '()V', returnDescriptor: 'V', invokeKind: 'interface' };
  }
  if (owner === 'java/util/function/Function') {
    if (name === 'apply' && args.length === 1) return { descriptor: '(Ljava/lang/Object;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;', invokeKind: 'interface' };
  }
  if (owner === 'java/util/function/Supplier') {
    if (name === 'get' && args.length === 0) return { descriptor: '()Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;', invokeKind: 'interface' };
  }
  if (owner === 'java/util/function/Consumer') {
    if (name === 'accept' && args.length === 1) return { descriptor: '(Ljava/lang/Object;)V', returnDescriptor: 'V', parameterDescriptors: ['Ljava/lang/Object;'], invokeKind: 'interface' };
  }
  if (owner === 'java/util/stream/Stream') {
    if (name === 'mapToDouble' && args.length === 1) {
      return { descriptor: '(Ljava/util/function/ToDoubleFunction;)Ljava/util/stream/DoubleStream;', returnDescriptor: 'Ljava/util/stream/DoubleStream;', parameterDescriptors: ['Ljava/util/function/ToDoubleFunction;'], invokeKind: 'interface' };
    }
    if (name === 'limit' && args.length === 1 && args[0].type === 'J') {
      return { descriptor: '(J)Ljava/util/stream/Stream;', returnDescriptor: 'Ljava/util/stream/Stream;', parameterDescriptors: ['J'], invokeKind: 'interface' };
    }
    if (name === 'collect' && args.length === 1) {
      return { descriptor: '(Ljava/util/stream/Collector;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;', parameterDescriptors: ['Ljava/util/stream/Collector;'], invokeKind: 'interface' };
    }
  }
  if (owner === 'java/util/stream/DoubleStream') {
    if (name === 'toArray' && args.length === 0) return { descriptor: '()[D', returnDescriptor: '[D', parameterDescriptors: [], invokeKind: 'interface' };
    if (name === 'map' && args.length === 1) return { descriptor: '(Ljava/util/function/DoubleUnaryOperator;)Ljava/util/stream/DoubleStream;', returnDescriptor: 'Ljava/util/stream/DoubleStream;', parameterDescriptors: ['Ljava/util/function/DoubleUnaryOperator;'], invokeKind: 'interface' };
    if (name === 'sum' && args.length === 0) return { descriptor: '()D', returnDescriptor: 'D', parameterDescriptors: [], invokeKind: 'interface' };
    if ((name === 'max' || name === 'min') && args.length === 0) return { descriptor: `()Ljava/util/OptionalDouble;`, returnDescriptor: 'Ljava/util/OptionalDouble;', parameterDescriptors: [], invokeKind: 'interface' };
  }
  if (owner === 'java/util/stream/IntStream') {
    if (name === 'mapToDouble' && args.length === 1) return { descriptor: '(Ljava/util/function/IntToDoubleFunction;)Ljava/util/stream/DoubleStream;', returnDescriptor: 'Ljava/util/stream/DoubleStream;', parameterDescriptors: ['Ljava/util/function/IntToDoubleFunction;'], invokeKind: 'interface' };
    if (name === 'filter' && args.length === 1) return { descriptor: '(Ljava/util/function/IntPredicate;)Ljava/util/stream/IntStream;', returnDescriptor: 'Ljava/util/stream/IntStream;', parameterDescriptors: ['Ljava/util/function/IntPredicate;'], invokeKind: 'interface' };
    if (name === 'count' && args.length === 0) return { descriptor: '()J', returnDescriptor: 'J', parameterDescriptors: [], invokeKind: 'interface' };
  }
  if (owner === 'java/util/OptionalDouble') {
    if (name === 'orElse' && args.length === 1) return { descriptor: '(D)D', returnDescriptor: 'D', parameterDescriptors: ['D'] };
  }
  if (owner === 'java/util/Optional') {
    if (name === 'orElse' && args.length === 1) return { descriptor: '(Ljava/lang/Object;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;', parameterDescriptors: ['Ljava/lang/Object;'] };
  }
  if ([
    'java/lang/Throwable',
    'java/lang/Exception',
    'java/lang/RuntimeException',
    'java/lang/ArithmeticException',
    'java/lang/IllegalArgumentException',
    'java/lang/InterruptedException',
    'java/lang/NullPointerException',
    'java/lang/ArrayIndexOutOfBoundsException',
  ].includes(owner)) {
    if (name === 'getMessage' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
    if (name === 'printStackTrace' && args.length === 0) return { descriptor: '()V', returnDescriptor: 'V' };
    if (name === 'getSuppressed' && args.length === 0) return { descriptor: '()[Ljava/lang/Throwable;', returnDescriptor: '[Ljava/lang/Throwable;' };
    if (name === 'addSuppressed' && args.length === 1 && args[0].type === 'Ljava/lang/Throwable;') return { descriptor: '(Ljava/lang/Throwable;)V', returnDescriptor: 'V' };
  }
  if (owner === 'java/lang/Thread') {
    if (name === 'start' && args.length === 0) return { descriptor: '()V', returnDescriptor: 'V' };
    if (name === 'join' && args.length === 0) return { descriptor: '()V', returnDescriptor: 'V' };
    if (name === 'interrupt' && args.length === 0) return { descriptor: '()V', returnDescriptor: 'V' };
    if (name === 'getName' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
  }
  if (owner === 'java/util/concurrent/locks/ReentrantLock') {
    if ((name === 'lock' || name === 'unlock') && args.length === 0) return { descriptor: '()V', returnDescriptor: 'V' };
  }
  if (owner === 'java/lang/Object') {
    if (name === 'wait' && args.length === 0) return { descriptor: '()V', returnDescriptor: 'V' };
    if (name === 'notify' && args.length === 0) return { descriptor: '()V', returnDescriptor: 'V' };
    if (name === 'notifyAll' && args.length === 0) return { descriptor: '()V', returnDescriptor: 'V' };
  }
  const wrapperPrimitive = primitiveDescriptorForWrapper(`L${owner};`);
  if (wrapperPrimitive && name === UNBOX_METHOD_BY_DESCRIPTOR[wrapperPrimitive] && args.length === 0) {
    return { descriptor: `()${wrapperPrimitive}`, returnDescriptor: wrapperPrimitive };
  }
  if (wrapperPrimitive && name === 'toString' && args.length === 0) {
    return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
  }
  const exactOverload = selectExactUserMethodDescriptor(owner, name, args, context, false);
  if (exactOverload) {
    return {
      descriptor: exactOverload.descriptor,
      returnDescriptor: exactOverload.returnDescriptor,
      parameterDescriptors: exactOverload.parameterDescriptors,
      invokeKind: exactOverload.invokeKind,
      isVarargs: exactOverload.isVarargs,
    };
  }
  const hierarchyExact = selectExactUserMethodDescriptorInHierarchy(owner, name, args, context, false);
  if (hierarchyExact && hierarchyExact.declaredOwner !== owner) {
    return {
      descriptor: hierarchyExact.descriptor,
      returnDescriptor: hierarchyExact.returnDescriptor,
      parameterDescriptors: hierarchyExact.parameterDescriptors,
      invokeKind: undefined,
      isVarargs: hierarchyExact.isVarargs,
    };
  }
  const superOwner = context.classSuperByInternalName && context.classSuperByInternalName.get(owner);
  if (superOwner && superOwner !== owner) {
    const inheritedExact = selectExactUserMethodDescriptorInHierarchy(superOwner, name, args, context, false);
    if (inheritedExact) {
      return {
        descriptor: inheritedExact.descriptor,
        returnDescriptor: inheritedExact.returnDescriptor,
        parameterDescriptors: inheritedExact.parameterDescriptors,
        invokeKind: inheritedExact.declaredOwner === owner ? inheritedExact.invokeKind : undefined,
        isVarargs: inheritedExact.isVarargs,
      };
    }
  }
  const overload = selectUserMethodDescriptor(owner, name, args, context, false);
  if (overload) {
    return {
      descriptor: overload.descriptor,
      returnDescriptor: overload.returnDescriptor,
      parameterDescriptors: overload.parameterDescriptors,
      invokeKind: overload.invokeKind,
      isVarargs: overload.isVarargs,
    };
  }
  if (superOwner && superOwner !== owner) {
    return methodDescriptorForInstanceCall(superOwner, name, args, context);
  }
  return null;
}

function methodMatchesArguments(method, args, isStatic = null) {
  if (!method || !Array.isArray(method.parameterDescriptors)) {
    return false;
  }
  if (isStatic !== null && Boolean(method.isStatic) !== isStatic) return false;
  if (method.isVarargs) {
    if (args.length < method.parameterDescriptors.length - 1) return false;
    return Boolean(prepareMethodArguments(method, args));
  }
  if (method.parameterDescriptors.length !== args.length) return false;
  return args.every((arg, index) => {
    const coerced = arg && coerceValueToDescriptor(arg, method.parameterDescriptors[index]);
    return coerced && coerced.type === method.parameterDescriptors[index];
  });
}

function prepareMethodArguments(method, args) {
  if (!method) return null;
  if (!Array.isArray(method.parameterDescriptors)) {
    const inferred = parameterDescriptorsFromMethodDescriptor(method.descriptor);
    if (!inferred) return null;
    method = { ...method, parameterDescriptors: inferred };
  }
  if (!method.isVarargs) {
    if (args.length !== method.parameterDescriptors.length) return null;
    const coerced = args.map((arg, index) => coerceValueToDescriptor(arg, method.parameterDescriptors[index]));
    return coerced.every((arg, index) => arg && arg.type === method.parameterDescriptors[index]) ? coerced : null;
  }
  const parameters = method.parameterDescriptors;
  const fixedCount = parameters.length - 1;
  if (args.length < fixedCount) return null;
  const fixed = args.slice(0, fixedCount)
    .map((arg, index) => coerceValueToDescriptor(arg, parameters[index]));
  if (!fixed.every((arg, index) => arg && arg.type === parameters[index])) return null;
  const varargsDescriptor = parameters[parameters.length - 1];
  if (!varargsDescriptor || !varargsDescriptor.startsWith('[')) return null;
  if (args.length === parameters.length) {
    const arg = args[fixedCount];
    if (arg && (arg.type === varargsDescriptor || (typeof arg.type === 'string' && arg.type.startsWith('[')) || arg.literalKind === 'null')) {
      const existingArray = coerceValueToDescriptor(arg, varargsDescriptor);
      if (existingArray && existingArray.type === varargsDescriptor) return fixed.concat(existingArray);
    }
  }
  const component = arrayComponentDescriptor(varargsDescriptor);
  const elements = args.slice(fixedCount).map((arg) => coerceValueToDescriptor(arg, component));
  if (!component || !elements.every((arg) => arg && arg.type === component)) return null;
  return fixed.concat({
    kind: 'ArrayInitializerValue',
    type: varargsDescriptor,
    elements,
  });
}

function parameterDescriptorsFromMethodDescriptor(descriptor) {
  if (typeof descriptor !== 'string') return null;
  const close = descriptor.indexOf(')');
  if (!descriptor.startsWith('(') || close < 0) return null;
  const descriptors = [];
  let index = 1;
  while (index < close) {
    let dimensions = 0;
    while (descriptor[index] === '[') {
      dimensions += 1;
      index += 1;
    }
    if (index >= close) return null;
    const start = index;
    if (descriptor[index] === 'L') {
      const semi = descriptor.indexOf(';', index);
      if (semi < 0 || semi > close) return null;
      descriptors.push(`${'['.repeat(dimensions)}${descriptor.slice(start, semi + 1)}`);
      index = semi + 1;
    } else {
      descriptors.push(`${'['.repeat(dimensions)}${descriptor[index]}`);
      index += 1;
    }
  }
  return descriptors;
}

function methodDescriptorMatchesArgs(descriptor, args) {
  const parameters = parameterDescriptorsFromMethodDescriptor(descriptor);
  if (!parameters || parameters.length !== args.length) return false;
  return args.every((arg, index) => {
    if (!arg) return false;
    const parameter = parameters[index];
    if (parameter.startsWith('[')
        && typeof arg.type === 'string'
        && arg.type.startsWith('L')
        && arg.literalKind !== 'null') {
      return false;
    }
    const coerced = coerceValueToDescriptor(arg, parameter);
    return Boolean(coerced && coerced.type === parameter);
  });
}

function isJreVarargsMethod(owner, name, descriptor, isStatic) {
  return Boolean((!isStatic
      && owner === 'java/lang/reflect/Method'
      && name === 'invoke'
      && descriptor === '(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;')
    || (!isStatic
      && owner === 'java/io/PrintStream'
      && name === 'printf'
      && descriptor === '(Ljava/lang/String;[Ljava/lang/Object;)Ljava/io/PrintStream;')
    || (isStatic
    && ((owner === 'java/lang/String'
      && name === 'join'
      && descriptor === '(Ljava/lang/CharSequence;[Ljava/lang/CharSequence;)Ljava/lang/String;')
    || (owner === 'java/lang/reflect/Array'
      && name === 'newInstance'
      && descriptor === '(Ljava/lang/Class;[I)Ljava/lang/Object;')
    || (owner === 'java/util/Arrays'
      && name === 'asList'
      && descriptor === '([Ljava/lang/Object;)Ljava/util/List;'))));
}

function selectJreMethodDescriptor(owner, name, args, isStatic) {
  if (isStatic && owner === 'java/util/Optional' && name === 'empty' && args.length === 0) {
    return { descriptor: '()Ljava/util/Optional;', returnDescriptor: 'Ljava/util/Optional;', parameterDescriptors: [], isStatic: true };
  }
  if (isStatic && owner === 'java/util/Optional' && name === 'of' && args.length === 1) {
    return { descriptor: '(Ljava/lang/Object;)Ljava/util/Optional;', returnDescriptor: 'Ljava/util/Optional;', parameterDescriptors: ['Ljava/lang/Object;'], isStatic: true };
  }
  if (isStatic && owner === 'java/util/Objects' && name === 'requireNonNull' && args.length === 1) {
    return { descriptor: '(Ljava/lang/Object;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;', parameterDescriptors: ['Ljava/lang/Object;'], isStatic: true };
  }
  if (isStatic && owner === 'java/util/stream/IntStream' && name === 'range'
      && args.length === 2) {
    return { descriptor: '(II)Ljava/util/stream/IntStream;',
      returnDescriptor: 'Ljava/util/stream/IntStream;', parameterDescriptors: ['I', 'I'], isStatic: true,
      invokeKind: 'staticInterface' };
  }
  if (isStatic && owner === 'java/util/Arrays' && name === 'stream'
      && args.length === 1 && args[0].type === '[D') {
    return { descriptor: '([D)Ljava/util/stream/DoubleStream;',
      returnDescriptor: 'Ljava/util/stream/DoubleStream;', parameterDescriptors: ['[D'], isStatic: true };
  }
  if (isStatic && owner === 'java/util/stream/Stream' && name === 'generate'
      && args.length === 1) {
    return { descriptor: '(Ljava/util/function/Supplier;)Ljava/util/stream/Stream;',
      returnDescriptor: 'Ljava/util/stream/Stream;', parameterDescriptors: ['Ljava/util/function/Supplier;'], isStatic: true,
      invokeKind: 'staticInterface' };
  }
  if (isStatic && owner === 'java/util/stream/Collectors' && name === 'toList' && args.length === 0) {
    return { descriptor: '()Ljava/util/stream/Collector;', returnDescriptor: 'Ljava/util/stream/Collector;',
      parameterDescriptors: [], isStatic: true };
  }
  const candidates = jreMethodCandidates(owner, name, isStatic);
  const candidatesWithParameters = candidates.map((candidate) => ({
    ...candidate,
    parameterDescriptors: parameterDescriptorsFromMethodDescriptor(candidate.descriptor),
    isVarargs: isJreVarargsMethod(owner, name, candidate.descriptor, isStatic),
  }));
  const exact = candidates.find((candidate) => {
    const parameters = parameterDescriptorsFromMethodDescriptor(candidate.descriptor);
    return parameters && parameters.length === args.length
      && args.every((arg, index) => arg && arg.type === parameters[index]);
  });
  const method = exact
    || candidatesWithParameters.find((candidate) => methodMatchesArguments(candidate, args, isStatic))
    || candidates.find((candidate) => methodDescriptorMatchesArgs(candidate.descriptor, args));
  if (!method) return null;
  return {
    descriptor: method.descriptor,
    returnDescriptor: method.returnDescriptor,
    parameterDescriptors: method.parameterDescriptors || parameterDescriptorsFromMethodDescriptor(method.descriptor),
    isStatic,
    isVarargs: Boolean(method.isVarargs),
    invokeKind: !isStatic && jreClassInfo(owner) && jreClassInfo(owner).isInterface ? 'interface' : undefined,
  };
}

function selectUserMethodDescriptor(owner, name, args, context, isStatic = null) {
  const overloads = context.classMethodOverloadsByInternalName && context.classMethodOverloadsByInternalName.get(owner);
  const candidates = overloads && overloads.get(name);
  if (Array.isArray(candidates)) {
    const exact = candidates.find((candidate) => (
      (isStatic === null || Boolean(candidate.isStatic) === isStatic)
      && !candidate.isVarargs
      && candidate.parameterDescriptors.length === args.length
      && args.every((arg, index) => arg && arg.type === candidate.parameterDescriptors[index])
    ));
    const method = exact || candidates.find((candidate) => methodMatchesArguments(candidate, args, isStatic));
    if (method) return method;
  }
  const methods = context.classMethodsByInternalName && context.classMethodsByInternalName.get(owner);
  if (methods && methods.has(name)) {
    const method = methods.get(name);
    if (methodMatchesArguments(method, args, isStatic)) return method;
  }
  return null;
}

function selectExactUserMethodDescriptor(owner, name, args, context, isStatic = null) {
  const overloads = context.classMethodOverloadsByInternalName && context.classMethodOverloadsByInternalName.get(owner);
  const candidates = overloads && overloads.get(name);
  return Array.isArray(candidates) ? candidates.find((candidate) => (
    (isStatic === null || Boolean(candidate.isStatic) === isStatic)
    && !candidate.isVarargs
    && candidate.parameterDescriptors.length === args.length
    && args.every((arg, index) => arg && arg.type === candidate.parameterDescriptors[index])
  )) || null : null;
}

function selectExactUserMethodDescriptorInHierarchy(owner, name, args, context, isStatic = null) {
  const visited = new Set();
  const pending = [owner];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const method = selectExactUserMethodDescriptor(current, name, args, context, isStatic);
    if (method) return { ...method, declaredOwner: current };
    const superName = context.classSuperByInternalName && context.classSuperByInternalName.get(current);
    if (superName) pending.push(superName);
    const interfaces = context.classInterfacesByInternalName && context.classInterfacesByInternalName.get(current);
    if (Array.isArray(interfaces)) pending.push(...interfaces);
  }
  return null;
}

function selectUserMethodDescriptorInHierarchy(owner, name, args, context, isStatic = null) {
  const visited = new Set();
  const pending = [owner];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const method = selectUserMethodDescriptor(current, name, args, context, isStatic);
    if (method) return { ...method, declaredOwner: current };
    const superName = context.classSuperByInternalName && context.classSuperByInternalName.get(current);
    if (superName) pending.push(superName);
    const interfaces = context.classInterfacesByInternalName && context.classInterfacesByInternalName.get(current);
    if (Array.isArray(interfaces)) pending.push(...interfaces);
  }
  return null;
}

function methodDescriptorForConstructorCall(owner, args, context) {
  const method = selectUserMethodDescriptor(owner, '<init>', args, context, false);
  if (method) {
    return { descriptor: method.descriptor, returnDescriptor: 'V', parameterDescriptors: method.parameterDescriptors };
  }
  const jreMethod = selectJreMethodDescriptor(owner, '<init>', args, false);
  if (jreMethod) {
    return {
      descriptor: jreMethod.descriptor,
      returnDescriptor: 'V',
      parameterDescriptors: jreMethod.parameterDescriptors,
      isVarargs: jreMethod.isVarargs,
    };
  }
  return {
    descriptor: `(${args.map((arg) => arg.type).join('')})V`,
    returnDescriptor: 'V',
    parameterDescriptors: args.map((arg) => arg.type),
  };
}

function thisReceiverValue(context) {
  if (context.localByName && context.localByName.has('this')) {
    return localValue(context.localByName.get('this'));
  }
  return {
    kind: 'LocalValue',
    type: `L${context.classInternalName};`,
    local: 'param:this',
    name: 'this',
  };
}

function outerThisValue(context) {
  if (!context.outerThisFieldName || !context.outerClassInternalName) return null;
  return {
    kind: 'FieldValue',
    type: `L${context.outerClassInternalName};`,
    owner: context.classInternalName,
    name: context.outerThisFieldName,
    descriptor: `L${context.outerClassInternalName};`,
    receiver: thisReceiverValue(context),
  };
}

function lowerSuperMethodCallTokens(tokens, context) {
  const normalized = trimParenTokens(tokens || []);
  if (normalized.length < 5
      || tokenText(normalized[0]) !== 'super'
      || tokenText(normalized[1]) !== '.'
      || normalized[2].kind !== 'identifier'
      || tokenText(normalized[3]) !== '('
      || tokenText(normalized[normalized.length - 1]) !== ')'
      || !context.superName) {
    return null;
  }
  let depth = 0;
  let closeIndex = -1;
  for (let i = 3; i < normalized.length; i += 1) {
    const text = tokenText(normalized[i]);
    if (text === '(') depth += 1;
    else if (text === ')') {
      depth -= 1;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  if (closeIndex !== normalized.length - 1) return null;
  const args = splitTopLevelByComma(normalized.slice(4, closeIndex))
    .map((part) => lowerTokenExpressionToJavaIrValue(part, context));
  if (!args.every(Boolean)) return null;
  const method = methodDescriptorForInstanceCall(context.superName, normalized[2].text, args, context);
  if (!method) return null;
  return {
    kind: 'MethodCallValue',
    type: method.returnDescriptor,
    owner: context.superName,
    name: normalized[2].text,
    descriptor: method.descriptor,
    invokeKind: 'special',
    receiver: thisReceiverValue(context),
    args,
  };
}

function lowerSuperConstructorInvokeOp(tokens, context, sourceNodeKind = null) {
  const normalized = trimParenTokens(tokens || []);
  if (normalized.length < 3
      || tokenText(normalized[0]) !== 'super'
      || tokenText(normalized[1]) !== '('
      || tokenText(normalized[normalized.length - 1]) !== ')'
      || !context.superName) {
    return null;
  }
  let depth = 0;
  let closeIndex = -1;
  for (let i = 1; i < normalized.length; i += 1) {
    const text = tokenText(normalized[i]);
    if (text === '(') depth += 1;
    else if (text === ')') {
      depth -= 1;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  if (closeIndex !== normalized.length - 1) return null;
  const args = splitTopLevelByComma(normalized.slice(2, closeIndex))
    .map((part) => lowerTokenExpressionToJavaIrValue(part, context));
  if (!args.every(Boolean)) return null;
  const method = methodDescriptorForConstructorCall(context.superName, args, context);
  const coercedArgs = args.map((arg, index) => coerceValueToDescriptor(arg, method.parameterDescriptors[index]));
  if (!coercedArgs.every(Boolean)) return null;
  return createJavaIrOp('invoke', {
    value: {
      kind: 'MethodCallValue',
      type: 'V',
      owner: context.superName,
      name: '<init>',
      descriptor: method.descriptor,
      invokeKind: 'special',
      receiver: thisReceiverValue(context),
      args: coercedArgs,
    },
    sourceNodeKind,
  });
}

function lowerThisConstructorInvokeOp(tokens, context, sourceNodeKind = null) {
  const normalized = trimParenTokens(tokens || []);
  if (normalized.length < 3
      || tokenText(normalized[0]) !== 'this'
      || tokenText(normalized[1]) !== '('
      || tokenText(normalized[normalized.length - 1]) !== ')') {
    return null;
  }
  let depth = 0;
  let closeIndex = -1;
  for (let i = 1; i < normalized.length; i += 1) {
    const text = tokenText(normalized[i]);
    if (text === '(') depth += 1;
    else if (text === ')') {
      depth -= 1;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  if (closeIndex !== normalized.length - 1) return null;
  const args = splitTopLevelByComma(normalized.slice(2, closeIndex))
    .map((part) => lowerTokenExpressionToJavaIrValue(part, context));
  if (!args.every(Boolean)) return null;
  const method = methodDescriptorForConstructorCall(context.classInternalName, args, context);
  const coercedArgs = args.map((arg, index) => coerceValueToDescriptor(arg, method.parameterDescriptors[index]));
  if (!coercedArgs.every(Boolean)) return null;
  return createJavaIrOp('invoke', {
    value: {
      kind: 'MethodCallValue',
      type: 'V',
      owner: context.classInternalName,
      name: '<init>',
      descriptor: method.descriptor,
      invokeKind: 'special',
      receiver: thisReceiverValue(context),
      args: coercedArgs,
    },
    sourceNodeKind,
  });
}

function lambdaArrowIndex(tokens) {
  return (tokens || []).findIndex((token) => tokenText(token) === '->');
}

function lambdaParameterNames(tokens) {
  const normalized = trimParenTokens(tokens || []);
  if (normalized.length === 0) return [];
  const parts = splitTopLevelByComma(normalized);
  const names = [];
  for (const part of parts) {
    const identifiers = part.filter((token) => token.kind === 'identifier').map((token) => token.text);
    if (identifiers.length === 0) return null;
    names.push(identifiers[identifiers.length - 1]);
  }
  return names;
}

function expressionLambdaTokens(expression) {
  if (!expression) return null;
  if (expression.kind === 'UnsupportedExpression' && Array.isArray(expression.tokens) && lambdaArrowIndex(expression.tokens) >= 0) {
    return expression.tokens;
  }
  if (expression.kind === 'MethodInvocationExpression'
      && expression.target
      && expression.target.kind === 'UnsupportedExpression'
      && Array.isArray(expression.target.tokens)
      && lambdaArrowIndex(expression.target.tokens) >= 0) {
    return expression.target.tokens;
  }
  return null;
}

function createSyntheticLambdaClass(context, iface, method, captures = [], owner = null) {
  const id = owner || (context.allocateLambdaClassName ? context.allocateLambdaClassName() : `${context.classInternalName}$Lambda${context.nextLambdaId || 0}`);
  context.nextLambdaId = (context.nextLambdaId || 0) + 1;
  const simpleName = id.split('/').pop();
  const fields = (captures || []).map((capture) => createJavaIrField({
    name: capture.fieldName,
    descriptor: capture.descriptor,
    access: ['private', 'final'],
    initializer: null,
    meta: { synthetic: true, capturedName: capture.name },
  }));
  const constructorContext = {
    ...context,
    classInternalName: id,
    className: simpleName,
    superName: 'java/lang/Object',
    fieldByName: new Map(),
    currentMethodIsStatic: false,
  };
  const constructor = createCapturedClassConstructor(constructorContext, captures);
  const classIr = createJavaIrClass({
    name: simpleName,
    packageName: '',
    internalName: id,
    access: ['final', 'super'],
    superName: 'java/lang/Object',
    interfaces: [iface],
    fields,
    methods: [constructor, method],
    sourceNodeKind: 'LambdaExpression',
    meta: { synthetic: true },
  });
  registerSyntheticClassMembers(classIr, context);
  if (context.syntheticClasses) context.syntheticClasses.push(classIr);
  return {
    kind: 'NewObjectValue',
    type: `L${id};`,
    owner: id,
    descriptor: constructor.descriptor,
    args: (captures || []).map((capture) => capture.value),
  };
}

function captureValuesForLambda(context, tokens, excludedNames = []) {
  const excluded = new Set(excludedNames || []);
  const names = new Set();
  for (const token of tokens || []) {
    if (token && token.kind === 'identifier' && !excluded.has(token.text) && context.localByName && context.localByName.has(token.text)) {
      names.add(token.text);
    }
  }
  const captures = [];
  for (const name of names) {
    const local = context.localByName.get(name);
    if (!local) continue;
    captures.push({
      name,
      fieldName: name === 'this' ? 'this$0' : `val$${name}`,
      descriptor: local.descriptor,
      value: localValue(local),
    });
  }
  return captures;
}

function captureValuesForLambdaNames(context, names, excludedNames = []) {
  const excluded = new Set(excludedNames || []);
  const captures = [];
  const seen = new Set();
  for (const name of names || []) {
    if (seen.has(name) || excluded.has(name) || !context.localByName || !context.localByName.has(name)) continue;
    seen.add(name);
    const local = context.localByName.get(name);
    captures.push({
      name,
      fieldName: name === 'this' ? 'this$0' : `val$${name}`,
      descriptor: local.descriptor,
      value: localValue(local),
    });
  }
  return captures;
}

function identifierNamesFromExpression(expression, names = []) {
  if (!expression) return names;
  if (expression.kind === 'ThisExpression') {
    names.push('this');
    return names;
  }
  if (expression.kind === 'Identifier') {
    names.push(expression.name);
    return names;
  }
  if (Array.isArray(expression.tokens)) {
    for (const token of expression.tokens) {
      if (token && token.kind === 'identifier') names.push(token.text);
    }
  }
  for (const key of ['target', 'expression', 'left', 'right', 'condition', 'consequent', 'alternate', 'body', 'initializer', 'update', 'array', 'index']) {
    if (expression[key]) identifierNamesFromExpression(expression[key], names);
  }
  for (const key of ['arguments', 'elements', 'statements', 'declarators']) {
    if (Array.isArray(expression[key])) {
      for (const child of expression[key]) identifierNamesFromExpression(child, names);
    }
  }
  return names;
}

function fieldMapForCaptures(owner, captures) {
  const fields = new Map();
  for (const capture of captures || []) {
    fields.set(capture.name, {
      owner,
      name: capture.fieldName,
      descriptor: capture.descriptor,
      signature: capture.descriptor,
      isStatic: false,
    });
  }
  return fields;
}

function constructorCaptureArgs(owner, context) {
  const map = context.constructorCaptureArgsByOwner;
  return map && map.get(owner) ? map.get(owner) : [];
}

function createCapturedClassConstructor(classContext, captures) {
  const thisLocal = createJavaIrLocal('param:this', {
    name: 'this',
    descriptor: `L${classContext.classInternalName};`,
    slotHint: 0,
  });
  const locals = [thisLocal];
  const parameters = [];
  const localByName = new Map([['this', thisLocal]]);
  let slot = 1;
  for (const capture of captures || []) {
    const local = createJavaIrLocal(`param:${capture.fieldName}`, {
      name: capture.fieldName,
      descriptor: capture.descriptor,
      slotHint: slot,
      meta: { synthetic: true, captured: capture.name },
    });
    parameters.push({ id: local.id, name: local.name, descriptor: local.descriptor, slotHint: local.slotHint, meta: local.meta });
    locals.push(local);
    localByName.set(local.name, local);
    slot += capture.descriptor === 'J' || capture.descriptor === 'D' ? 2 : 1;
  }
  const context = {
    locals,
    localByName,
    nextSlot: slot,
    nextLocalId: 0,
    methodByName: classContext.methodByName,
    fieldByName: classContext.fieldByName,
    classInternalName: classContext.classInternalName,
    className: classContext.className,
    superName: classContext.superName,
    classBySimpleName: classContext.classBySimpleName,
    classMethodsByInternalName: classContext.classMethodsByInternalName,
    classMethodOverloadsByInternalName: classContext.classMethodOverloadsByInternalName,
    classFieldsByInternalName: classContext.classFieldsByInternalName,
    classSuperByInternalName: classContext.classSuperByInternalName,
    typeParameters: classContext.typeParameters,
    currentMethodIsStatic: false,
    syntheticClasses: classContext.syntheticClasses,
    allocateLambdaClassName: classContext.allocateLambdaClassName,
    constructorCaptureArgsByOwner: classContext.constructorCaptureArgsByOwner,
  };
  const ops = [implicitSuperConstructorOp(context)];
  for (const capture of captures || []) {
    ops.push(createJavaIrOp('putField', {
      owner: classContext.classInternalName,
      name: capture.fieldName,
      descriptor: capture.descriptor,
      value: localValue(localByName.get(capture.fieldName)),
      args: [localValue(thisLocal)],
      sourceNodeKind: 'SyntheticCapturedConstructor',
    }));
  }
  for (const fieldInit of classContext.instanceFieldInitializers || []) {
    ops.push(createJavaIrOp('putField', {
      owner: classContext.classInternalName,
      name: fieldInit.name,
      descriptor: fieldInit.descriptor,
      value: fieldInit.value,
      args: [localValue(thisLocal)],
      sourceNodeKind: 'SyntheticCapturedConstructor',
    }));
  }
  return createJavaIrMethod({
    name: '<init>',
    descriptor: `(${(captures || []).map((capture) => capture.descriptor).join('')})V`,
    access: ['public'],
    parameters,
    locals,
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock',
      ops,
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry',
    sourceNodeKind: 'SyntheticCapturedConstructor',
    meta: { synthetic: true, capturedConstructor: true },
  });
}

function methodSummaryFromIrMethod(method) {
  const parameterDescriptors = parameterDescriptorsFromMethodDescriptor(method.descriptor) || [];
  return {
    name: method.name,
    descriptor: method.descriptor,
    returnDescriptor: method.descriptor.slice(method.descriptor.indexOf(')') + 1),
    parameterDescriptors,
    isStatic: (method.access || []).includes('static'),
    invokeKind: (method.access || []).includes('abstract') ? 'interface' : undefined,
  };
}

function registerSyntheticClassMembers(classIr, context) {
  const methods = new Map();
  const overloads = new Map();
  for (const method of classIr.methods || []) {
    const summary = methodSummaryFromIrMethod(method);
    methods.set(summary.name, summary);
    if (!overloads.has(summary.name)) overloads.set(summary.name, []);
    overloads.get(summary.name).push(summary);
  }
  const fields = new Map();
  for (const field of classIr.fields || []) {
    fields.set(field.name, {
      owner: classIr.internalName,
      name: field.name,
      descriptor: field.descriptor,
      signature: field.meta && field.meta.signature ? field.meta.signature : field.descriptor,
      isStatic: (field.access || []).includes('static'),
    });
    if (field.meta && field.meta.capturedName) {
      fields.set(field.meta.capturedName, {
        owner: classIr.internalName,
        name: field.name,
        descriptor: field.descriptor,
        signature: field.descriptor,
        isStatic: false,
      });
    }
  }
  context.classMethodsByInternalName.set(classIr.internalName, methods);
  context.classMethodOverloadsByInternalName.set(classIr.internalName, overloads);
  context.classFieldsByInternalName.set(classIr.internalName, fields);
}

function captureValuesForLocalClass(context) {
  const captures = [];
  if (!context.currentMethodIsStatic && context.localByName && context.localByName.has('this')) {
    const thisLocal = context.localByName.get('this');
    captures.push({
      name: 'this',
      fieldName: 'this$0',
      descriptor: thisLocal.descriptor,
      value: localValue(thisLocal),
    });
  }
  for (const local of context.locals || []) {
    if (!local || local.name === 'this' || !local.id || !local.id.startsWith('local:')) continue;
    captures.push({
      name: local.name,
      fieldName: `val$${local.name}`,
      descriptor: local.descriptor,
      value: localValue(local),
    });
  }
  return captures;
}

function lowerLocalClassDeclaration(statement, context) {
  const declaration = statement && statement.declaration;
  if (!declaration || !isClassLikeDeclaration(declaration)) return null;
  const captures = captureValuesForLocalClass(context);
  const owner = `${context.classInternalName}$${declaration.name}`;
  context.classBySimpleName.set(declaration.name, owner);
  context.classBySimpleName.set(`${context.className}.${declaration.name}`, owner);
  if (context.constructorCaptureArgsByOwner) {
    context.constructorCaptureArgsByOwner.set(owner, captures.map((capture) => capture.value));
  }
  const classTypeParameters = buildTypeParameterErasureMap(declaration.typeParameters || []);
  const fieldByName = new Map();
  const fields = [];
  for (const capture of captures) {
    fields.push(createJavaIrField({
      name: capture.fieldName,
      descriptor: capture.descriptor,
      access: ['final'],
      initializer: null,
      meta: { synthetic: true, capturedName: capture.name },
    }));
    fieldByName.set(capture.name, {
      owner,
      name: capture.fieldName,
      descriptor: capture.descriptor,
      signature: capture.descriptor,
      isStatic: false,
    });
  }
  const classContext = {
    className: declaration.name,
    classInternalName: owner,
    methodByName: new Map(),
    localByName: new Map(),
    classBySimpleName: context.classBySimpleName,
    classMethodsByInternalName: context.classMethodsByInternalName,
    classMethodOverloadsByInternalName: context.classMethodOverloadsByInternalName,
    classFieldsByInternalName: context.classFieldsByInternalName,
    fieldByName,
    outerClassInternalName: context.classInternalName,
    outerFieldByName: context.fieldByName,
    outerMethodByName: context.methodByName,
    outerThisFieldName: captures.some((capture) => capture.name === 'this') ? 'this$0' : null,
    isInterface: false,
    superName: 'java/lang/Object',
    typeParameters: classTypeParameters,
    syntheticClasses: context.syntheticClasses,
    allocateLambdaClassName: context.allocateLambdaClassName,
    constructorCaptureArgsByOwner: context.constructorCaptureArgsByOwner,
  };
  const methods = [createCapturedClassConstructor(classContext, captures)];
  for (const member of declaration.body || []) {
    if (member.kind === 'MethodDeclaration' || member.kind === 'ConstructorDeclaration') {
      methods.push(lowerMethodToJavaIr(member, classContext, member.modifiers && modifierNames(member.modifiers).includes('static') ? 0 : 1));
    }
  }
  const classIr = createJavaIrClass({
    name: declaration.name,
    packageName: '',
    internalName: owner,
    access: ['final', 'super'],
    superName: 'java/lang/Object',
    fields,
    methods,
    sourceNodeKind: 'LocalClassDeclaration',
    meta: { synthetic: true, localClass: true },
  });
  registerSyntheticClassMembers(classIr, context);
  if (context.syntheticClasses) context.syntheticClasses.push(classIr);
  return [];
}

function lowerAnonymousClassToJavaIrValue(expression, targetDescriptor, context) {
  const owner = context.allocateLambdaClassName ? context.allocateLambdaClassName() : `${context.classInternalName}$Anon0`;
  let iface;
  let declaration;
  if (expression && expression.kind === 'NewClassExpression' && Array.isArray(expression.body)) {
    try { iface = classTypeInternalName(expression.classType, context); } catch (_) { return null; }
    declaration = { name: owner.split('$').pop(), body: expression.body };
  } else {
    if (!expression || expression.kind !== 'UnsupportedExpression' || !Array.isArray(expression.tokens)) return null;
    const tokens = expression.tokens;
    if (tokens.length < 5 || tokenText(tokens[0]) !== 'new' || tokens[1].kind !== 'identifier') return null;
    const openParen = 2;
    const closeParen = matchingTokenIndex(tokens, openParen, '(', ')');
    if (closeParen < 0 || tokenText(tokens[closeParen + 1]) !== '{') return null;
    const closeBrace = matchingTokenIndex(tokens, closeParen + 1, '{', '}');
    if (closeBrace !== tokens.length - 1) return null;
    iface = constructorOwnerFromName(tokens[1].text, context);
    const bodyText = expression.text.slice(expression.text.indexOf('{'), expression.text.lastIndexOf('}') + 1);
    let parsed;
    try {
      parsed = parseJava(`class ${owner.split('$').pop()} implements ${tokens[1].text} ${bodyText}`, { sourceFileName: 'AnonymousClass.java' });
    } catch (_) {
      return null;
    }
    declaration = parsed.root.typeDeclarations && parsed.root.typeDeclarations[0];
  }
  if (targetDescriptor && targetDescriptor.startsWith('L')) iface = targetDescriptor.slice(1, -1);
  if (!declaration) return null;
  const captures = captureValuesForLocalClass(context).filter((capture) => capture.name === 'this');
  if (context.constructorCaptureArgsByOwner) {
    context.constructorCaptureArgsByOwner.set(owner, captures.map((capture) => capture.value));
  }
  const fieldByName = new Map();
  const fields = captures.map((capture) => {
    fieldByName.set(capture.name, {
      owner,
      name: capture.fieldName,
      descriptor: capture.descriptor,
      signature: capture.descriptor,
      isStatic: false,
    });
    return createJavaIrField({
      name: capture.fieldName,
      descriptor: capture.descriptor,
      access: ['final'],
      initializer: null,
      meta: { synthetic: true, capturedName: capture.name },
    });
  });
  const classContext = {
    className: declaration.name,
    classInternalName: owner,
    methodByName: new Map(),
    localByName: new Map(),
    classBySimpleName: context.classBySimpleName,
    classMethodsByInternalName: context.classMethodsByInternalName,
    classMethodOverloadsByInternalName: context.classMethodOverloadsByInternalName,
    classFieldsByInternalName: context.classFieldsByInternalName,
    fieldByName,
    outerClassInternalName: context.classInternalName,
    outerFieldByName: context.fieldByName,
    outerMethodByName: context.methodByName,
    outerThisFieldName: captures.length ? 'this$0' : null,
    isInterface: false,
    superName: 'java/lang/Object',
    typeParameters: new Map(),
    syntheticClasses: context.syntheticClasses,
    allocateLambdaClassName: context.allocateLambdaClassName,
    constructorCaptureArgsByOwner: context.constructorCaptureArgsByOwner,
  };
  const methods = [createCapturedClassConstructor(classContext, captures)];
  for (const member of declaration.body || []) {
    if (member.kind === 'MethodDeclaration') methods.push(lowerMethodToJavaIr(member, classContext, 1));
  }
  const classIr = createJavaIrClass({
    name: owner.split('/').pop(),
    packageName: '',
    internalName: owner,
    access: ['final', 'super'],
    superName: 'java/lang/Object',
    interfaces: [iface],
    fields,
    methods,
    sourceNodeKind: 'AnonymousClassExpression',
    meta: { synthetic: true, anonymousClass: true },
  });
  registerSyntheticClassMembers(classIr, context);
  if (context.syntheticClasses) context.syntheticClasses.push(classIr);
  return {
    kind: 'NewObjectValue',
    type: `L${owner};`,
    owner,
    descriptor: `(${captures.map((capture) => capture.descriptor).join('')})V`,
    args: captures.map((capture) => capture.value),
  };
}

function findMatchingTokenIndex(tokens, openIndex, openText = '(', closeText = ')') {
  let depth = 0;
  for (let index = openIndex; index < (tokens || []).length; index += 1) {
    const text = tokenText(tokens[index]);
    if (text === openText) depth += 1;
    else if (text === closeText) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stripEnclosingTokenPair(tokens, openText, closeText) {
  const normalized = trimParenTokens(tokens || []);
  if (normalized.length >= 2
      && tokenText(normalized[0]) === openText
      && tokenText(normalized[normalized.length - 1]) === closeText
      && findMatchingTokenIndex(normalized, 0, openText, closeText) === normalized.length - 1) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function lowerTokenStatementToJavaIrOps(tokens, context) {
  const normalized = (tokens || []).filter((token) => tokenText(token) !== ';');
  if (normalized.length >= 3 && normalized[0].kind === 'identifier' && tokenText(normalized[1]) === '(') {
    const value = lowerExpressionToJavaIrValue({
      kind: 'MethodInvocationExpression',
      target: null,
      name: normalized[0].text,
      arguments: splitTopLevelByComma(normalized.slice(2, -1)).map((part) => ({ kind: 'UnsupportedExpression', tokens: part })),
    }, context);
    return value && value.kind === 'MethodCallValue' ? [createJavaIrOp('invoke', { value, sourceNodeKind: 'LambdaExpression' })] : null;
  }
  if (normalized.length >= 5
      && normalized[0].kind === 'identifier'
      && tokenText(normalized[1]) === '.'
      && normalized[2].kind === 'identifier'
      && tokenText(normalized[3]) === '(') {
    const value = lowerExpressionToJavaIrValue({
      kind: 'MethodInvocationExpression',
      target: { kind: 'Identifier', name: normalized[0].text },
      name: normalized[2].text,
      arguments: splitTopLevelByComma(normalized.slice(4, -1)).map((part) => ({ kind: 'UnsupportedExpression', tokens: part })),
    }, context);
    return value && value.kind === 'MethodCallValue' ? [createJavaIrOp('invoke', { value, sourceNodeKind: 'LambdaExpression' })] : null;
  }
  const expressionValue = lowerTokenExpressionToJavaIrValue(normalized, context);
  if (expressionValue && expressionValue.kind === 'MethodCallValue') {
    return [createJavaIrOp('invoke', { value: expressionValue, sourceNodeKind: 'LambdaExpression' })];
  }
  const updateOps = lowerTokenUpdateToJavaIrOps(normalized, context);
  return updateOps || null;
}

function lowerForTokensToJavaIrOps(tokens, context) {
  const normalized = trimParenTokens(tokens || []);
  if (normalized.length < 8 || tokenText(normalized[0]) !== 'for' || tokenText(normalized[1]) !== '(') return null;
  const closeParen = findMatchingTokenIndex(normalized, 1, '(', ')');
  if (closeParen < 0 || closeParen >= normalized.length - 1) return null;
  const headerParts = splitTopLevelBySemicolon(normalized.slice(2, closeParen));
  if (headerParts.length !== 3) return null;
  const init = headerParts[0];
  const ops = [];
  if (init.length >= 4 && tokenText(init[0]) === 'int' && init[1].kind === 'identifier' && tokenText(init[2]) === '=') {
    const local = declareContextLocal(context, init[1].text, 'I');
    ops.push(createJavaIrOp('declareLocal', {
      target: local.id,
      type: local.descriptor,
      name: local.name,
      sourceNodeKind: 'LambdaExpression',
      meta: { slotHint: local.slotHint, hasInitializer: true },
    }));
    const value = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(init.slice(3), context), 'I');
    if (!value) return null;
    ops.push(createJavaIrOp('assign', {
      target: local.id,
      type: local.descriptor,
      value,
      sourceNodeKind: 'LambdaExpression',
    }));
  } else {
    const initOps = lowerTokenStatementToJavaIrOps(init, context);
    if (!initOps) return null;
    ops.push(...initOps);
  }
  const condition = lowerTokenExpressionToJavaIrValue(headerParts[1], context);
  const updateOps = lowerTokenUpdateToJavaIrOps(headerParts[2], context);
  if (!condition || condition.type !== 'Z' || !updateOps) return null;
  const bodyTokens = stripEnclosingTokenPair(normalized.slice(closeParen + 1), '{', '}');
  const bodyParts = splitTopLevelBySemicolon(bodyTokens);
  const bodyOps = [];
  for (const part of bodyParts) {
    const childOps = lowerTokenStatementToJavaIrOps(part, context);
    if (!childOps) return null;
    bodyOps.push(...childOps);
  }
  ops.push(createJavaIrOp('loop', {
    condition,
    bodyOps,
    updateOps,
    sourceNodeKind: 'LambdaExpression',
  }));
  return ops;
}

function lowerRunnableBlockLambdaToJavaIrValue(expression, context) {
  if (expression && expression.kind === 'LambdaExpression' && (expression.parameters || []).length === 0) {
    const owner = context.allocateLambdaClassName ? context.allocateLambdaClassName() : `${context.classInternalName}$Lambda${context.nextLambdaId || 0}`;
    const captures = captureValuesForLambdaNames(context, identifierNamesFromExpression(expression.body));
    const lambdaContext = {
      ...context,
      locals: [createJavaIrLocal('param:this', { name: 'this', descriptor: `L${owner};`, slotHint: 0 })],
      localByName: new Map(), fieldByName: fieldMapForCaptures(owner, captures), methodOwnerInternalName: context.classInternalName,
      classInternalName: owner, className: owner.split('/').pop(), outerClassInternalName: context.classInternalName,
      outerMethodByName: context.methodByName, currentMethodIsStatic: false, nextSlot: 1, nextLocalId: 0,
    };
    const ops = expression.body && expression.body.kind === 'BlockStatement'
      ? lowerStatementToJavaIrOps(expression.body, lambdaContext)
      : lowerStatementToJavaIrOps({ kind: 'ExpressionStatement', expression: expression.body }, lambdaContext);
    if (!ops || ops.some((op) => op.op === 'unsupported' || (op.op === 'expression' && !op.value))) return null;
    const method = createJavaIrMethod({
      name: 'run', descriptor: '()V', access: ['public'], parameters: [], locals: lambdaContext.locals,
      blocks: [createJavaIrBlock('entry', { kind: 'EntryBlock', ops, terminator: javaIrReturn(null) })],
      entryBlockId: 'entry', sourceNodeKind: 'LambdaExpression', meta: { synthetic: true },
    });
    return createSyntheticLambdaClass(context, 'java/lang/Runnable', method, captures, owner);
  }
  const tokens = expressionLambdaTokens(expression);
  const arrowIndex = lambdaArrowIndex(tokens);
  if (arrowIndex < 0) return null;
  const bodyTokens = stripEnclosingTokenPair(tokens.slice(arrowIndex + 1), '{', '}');
  const owner = context.allocateLambdaClassName ? context.allocateLambdaClassName() : `${context.classInternalName}$Lambda${context.nextLambdaId || 0}`;
  const captures = captureValuesForLambda(context, bodyTokens);
  const lambdaContext = {
    ...context,
    locals: [createJavaIrLocal('param:this', {
      name: 'this',
      descriptor: `L${owner};`,
      slotHint: 0,
    })],
    localByName: new Map(),
    fieldByName: fieldMapForCaptures(owner, captures),
    methodOwnerInternalName: context.classInternalName,
    classInternalName: owner,
    className: owner.split('/').pop(),
    outerClassInternalName: context.classInternalName,
    outerMethodByName: context.methodByName,
    outerThisFieldName: captures.some((capture) => capture.name === 'this') ? 'this$0' : null,
    currentMethodIsStatic: false,
    nextSlot: 1,
    nextLocalId: 0,
  };
  let ops = null;
  if (bodyTokens.length > 0 && tokenText(bodyTokens[0]) === 'for') {
    ops = lowerForTokensToJavaIrOps(bodyTokens, lambdaContext);
  } else {
    const bodyParts = splitTopLevelBySemicolon(bodyTokens);
    ops = [];
    for (const part of bodyParts) {
      const childOps = lowerTokenStatementToJavaIrOps(part, lambdaContext);
      if (!childOps) return null;
      ops.push(...childOps);
    }
  }
  if (!ops) return null;
  const method = createJavaIrMethod({
    name: 'run',
    descriptor: '()V',
    access: ['public'],
    parameters: [],
    locals: lambdaContext.locals,
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock',
      ops,
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry',
    sourceNodeKind: 'LambdaExpression',
    meta: { synthetic: true },
  });
  return createSyntheticLambdaClass(context, 'java/lang/Runnable', method, captures, owner);
}

function lowerRunnableLambdaToJavaIrValue(expression, context) {
  if (!expression || expression.kind !== 'MethodInvocationExpression' || expression.name !== 'println') return null;
  const targetTokens = expression.target && expression.target.tokens;
  if (!Array.isArray(targetTokens) || lambdaArrowIndex(targetTokens) < 0) return null;
  const owner = context.allocateLambdaClassName ? context.allocateLambdaClassName() : `${context.classInternalName}$Lambda${context.nextLambdaId || 0}`;
  const captureNames = [];
  for (const token of targetTokens) {
    if (token && token.kind === 'identifier') captureNames.push(token.text);
  }
  for (const argument of expression.arguments || []) {
    identifierNamesFromExpression(argument, captureNames);
  }
  const captures = captureValuesForLambdaNames(context, captureNames);
  const lambdaContext = {
    ...context,
    locals: [createJavaIrLocal('param:this', {
      name: 'this',
      descriptor: `L${owner};`,
      slotHint: 0,
    })],
    localByName: new Map(),
    fieldByName: fieldMapForCaptures(owner, captures),
    methodOwnerInternalName: context.classInternalName,
    classInternalName: owner,
    className: owner.split('/').pop(),
    outerClassInternalName: context.classInternalName,
    outerMethodByName: context.methodByName,
    outerThisFieldName: captures.some((capture) => capture.name === 'this') ? 'this$0' : null,
    currentMethodIsStatic: false,
    nextSlot: 1,
    nextLocalId: 0,
  };
  const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, lambdaContext));
  if (!args.every(Boolean)) return null;
  const method = createJavaIrMethod({
    name: 'run',
    descriptor: '()V',
    access: ['public'],
    parameters: [],
    locals: lambdaContext.locals,
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock',
      ops: [createJavaIrOp('println', {
        owner: 'java/io/PrintStream',
        name: 'println',
        args,
        sourceNodeKind: 'LambdaExpression',
      })],
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry',
    sourceNodeKind: 'LambdaExpression',
    meta: { synthetic: true },
  });
  return createSyntheticLambdaClass(context, 'java/lang/Runnable', method, captures, owner);
}

function lowerFunctionLambdaToJavaIrValue(expression, context) {
  if (expression && expression.kind === 'LambdaExpression') {
    const parameter = expression.parameters && expression.parameters[0];
    if (!parameter || !parameter.name) return null;
    const parameterLocal = createJavaIrLocal('param:arg0', { name: parameter.name, descriptor: 'Ljava/lang/Object;', slotHint: 1 });
    const lambdaContext = {
      ...context,
      locals: [createJavaIrLocal('param:this', { name: 'this', descriptor: 'Ljava/util/function/Function;', slotHint: 0 }), parameterLocal],
      localByName: new Map([[parameter.name, parameterLocal]]),
      currentMethodIsStatic: false,
    };
    const bodyValue = coerceValueToDescriptor(lowerExpressionToJavaIrValue(expression.body, lambdaContext), 'Ljava/lang/Object;');
    if (!bodyValue) return null;
    const method = createJavaIrMethod({
      name: 'apply', descriptor: '(Ljava/lang/Object;)Ljava/lang/Object;', access: ['public'],
      parameters: [{ id: parameterLocal.id, name: parameter.name, descriptor: parameterLocal.descriptor, slotHint: 1 }],
      locals: lambdaContext.locals,
      blocks: [createJavaIrBlock('entry', { kind: 'EntryBlock', ops: [createJavaIrOp('return', { value: bodyValue, sourceNodeKind: 'LambdaExpression' })], terminator: javaIrReturn(null) })],
      entryBlockId: 'entry', sourceNodeKind: 'LambdaExpression', meta: { synthetic: true },
    });
    return createSyntheticLambdaClass(context, 'java/util/function/Function', method);
  }
  const tokens = expressionLambdaTokens(expression);
  const arrowIndex = lambdaArrowIndex(tokens);
  if (arrowIndex < 0) return null;
  const parameterNames = lambdaParameterNames(tokens.slice(0, arrowIndex));
  if (!parameterNames || parameterNames.length !== 1) return null;
  const parameterName = parameterNames[0];
  const parameterLocal = createJavaIrLocal('param:arg0', {
    name: parameterName,
    descriptor: 'Ljava/lang/Object;',
    slotHint: 1,
  });
  const lambdaContext = {
    ...context,
    locals: [
      createJavaIrLocal('param:this', {
        name: 'this',
        descriptor: 'Ljava/util/function/Function;',
        slotHint: 0,
      }),
      parameterLocal,
    ],
    localByName: new Map([[parameterName, parameterLocal]]),
    currentMethodIsStatic: false,
  };
  const bodyValue = coerceValueToDescriptor(
    lowerTokenExpressionToJavaIrValue(tokens.slice(arrowIndex + 1), lambdaContext),
    'Ljava/lang/Object;',
  );
  if (!bodyValue) return null;
  const method = createJavaIrMethod({
    name: 'apply',
    descriptor: '(Ljava/lang/Object;)Ljava/lang/Object;',
    access: ['public'],
    parameters: [{ id: 'param:arg0', name: parameterName, descriptor: 'Ljava/lang/Object;', slotHint: 1 }],
    locals: lambdaContext.locals,
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock',
      ops: [createJavaIrOp('return', {
        value: bodyValue,
        sourceNodeKind: 'LambdaExpression',
      })],
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry',
    sourceNodeKind: 'LambdaExpression',
    meta: { synthetic: true },
  });
  return createSyntheticLambdaClass(context, 'java/util/function/Function', method);
}

function lowerFunctionMethodReferenceToJavaIrValue(expression, context) {
  if (!expression || expression.kind !== 'UnsupportedExpression' || !Array.isArray(expression.tokens)) return null;
  const tokens = trimParenTokens(expression.tokens);
  const refIndex = findTopLevelOperator(tokens, ['::']);
  if (refIndex <= 0 || refIndex !== tokens.length - 2 || tokens[refIndex + 1].kind !== 'identifier') return null;
  const owner = resolveClassInternalNameFromParts(
    tokens.slice(0, refIndex).filter((token) => token.kind === 'identifier').map((token) => token.text),
    context,
  );
  if (!owner) return null;
  const name = tokens[refIndex + 1].text;
  const parameterLocal = createJavaIrLocal('param:arg0', {
    name: 'arg0',
    descriptor: 'Ljava/lang/Object;',
    slotHint: 1,
  });
  const argValue = {
    kind: 'LocalValue',
    type: 'Ljava/lang/Object;',
    local: 'param:arg0',
    name: 'arg0',
  };
  const candidates = context.classMethodOverloadsByInternalName && context.classMethodOverloadsByInternalName.get(owner);
  const overloads = candidates && candidates.get(name);
  const method = (Array.isArray(overloads)
    ? overloads.find((candidate) => candidate.isStatic && candidate.parameterDescriptors && candidate.parameterDescriptors.length === 1)
    : null) || {
    descriptor: '(Ljava/lang/String;)Ljava/lang/String;',
    returnDescriptor: 'Ljava/lang/String;',
    parameterDescriptors: ['Ljava/lang/String;'],
    isStatic: true,
  };
  const callArg = coerceValueToDescriptor(argValue, method.parameterDescriptors[0]);
  const call = coerceValueToDescriptor({
    kind: 'MethodCallValue',
    type: method.returnDescriptor,
    owner,
    name,
    descriptor: method.descriptor,
    invokeKind: 'static',
    args: [callArg],
  }, 'Ljava/lang/Object;');
  if (!callArg || !call) return null;
  const lambdaContext = {
    ...context,
    classInternalName: 'java/util/function/Function',
    className: 'Function',
    superName: 'java/lang/Object',
    locals: [
      createJavaIrLocal('param:this', {
        name: 'this',
        descriptor: 'Ljava/util/function/Function;',
        slotHint: 0,
      }),
      parameterLocal,
    ],
    localByName: new Map([['arg0', parameterLocal]]),
    currentMethodIsStatic: false,
  };
  const apply = createJavaIrMethod({
    name: 'apply',
    descriptor: '(Ljava/lang/Object;)Ljava/lang/Object;',
    access: ['public'],
    parameters: [{ id: 'param:arg0', name: 'arg0', descriptor: 'Ljava/lang/Object;', slotHint: 1 }],
    locals: lambdaContext.locals,
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock',
      ops: [createJavaIrOp('return', {
        value: call,
        sourceNodeKind: 'MethodReferenceExpression',
      })],
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry',
    sourceNodeKind: 'MethodReferenceExpression',
    meta: { synthetic: true },
  });
  return createSyntheticLambdaClass(context, 'java/util/function/Function', apply);
}

function lowerConsumerLambdaToJavaIrValue(expression, context) {
  if (!expression || expression.kind !== 'LambdaExpression') return null;
  const parameter = expression.parameters && expression.parameters[0];
  if (!parameter || !parameter.name || expression.parameters.length !== 1) return null;
  const owner = context.allocateLambdaClassName
    ? context.allocateLambdaClassName() : `${context.classInternalName}$Lambda${context.nextLambdaId || 0}`;
  const captures = captureValuesForLambdaNames(
    context, identifierNamesFromExpression(expression.body), [parameter.name]);
  const parameterLocal = createJavaIrLocal('param:arg0', {
    name: parameter.name, descriptor: 'Ljava/lang/Object;', slotHint: 1,
  });
  const lambdaContext = {
    ...context,
    locals: [
      createJavaIrLocal('param:this', { name: 'this', descriptor: `L${owner};`, slotHint: 0 }),
      parameterLocal,
    ],
    localByName: new Map([[parameter.name, parameterLocal]]),
    fieldByName: fieldMapForCaptures(owner, captures),
    methodOwnerInternalName: context.classInternalName,
    classInternalName: owner,
    className: owner.split('/').pop(),
    outerClassInternalName: context.classInternalName,
    outerMethodByName: context.methodByName,
    outerThisFieldName: captures.some((capture) => capture.name === 'this') ? 'this$0' : null,
    lambdaLexicalThis: true,
    currentMethodIsStatic: false,
    nextSlot: 2,
    nextLocalId: 0,
  };
  const ops = expression.body && expression.body.kind === 'BlockStatement'
    ? lowerStatementToJavaIrOps(expression.body, lambdaContext)
    : (() => {
      const value = lowerExpressionToJavaIrValue(expression.body, lambdaContext);
      return value && value.kind === 'MethodCallValue' && value.type === 'V'
        ? [createJavaIrOp('invoke', { value, sourceNodeKind: 'LambdaExpression' })] : null;
    })();
  if (!ops || ops.some((op) => op.op === 'unsupported')) return null;
  const method = createJavaIrMethod({
    name: 'accept', descriptor: '(Ljava/lang/Object;)V', access: ['public'],
    parameters: [{ id: parameterLocal.id, name: parameter.name, descriptor: parameterLocal.descriptor, slotHint: 1 }],
    locals: lambdaContext.locals,
    blocks: [createJavaIrBlock('entry', { kind: 'EntryBlock', ops, terminator: javaIrReturn(null) })],
    entryBlockId: 'entry', sourceNodeKind: 'LambdaExpression', meta: { synthetic: true },
  });
  return createSyntheticLambdaClass(context, 'java/util/function/Consumer', method, captures, owner);
}

function lowerSupplierLambdaToJavaIrValue(expression, context) {
  if (expression && expression.kind !== 'LambdaExpression') {
    const tokens = expressionLambdaTokens(expression);
    const arrowIndex = lambdaArrowIndex(tokens);
    const parameterNames = arrowIndex >= 0 ? lambdaParameterNames(tokens.slice(0, arrowIndex)) : null;
    if (!parameterNames || parameterNames.length !== 0) return null;
    expression = {
      kind: 'LambdaExpression', parameters: [],
      body: { kind: 'UnsupportedExpression', tokens: trimParenTokens(tokens.slice(arrowIndex + 1)) },
    };
  }
  if (!expression || expression.kind !== 'LambdaExpression'
      || (expression.parameters || []).length !== 0) return null;
  const owner = context.allocateLambdaClassName
    ? context.allocateLambdaClassName() : `${context.classInternalName}$Lambda${context.nextLambdaId || 0}`;
  const captures = captureValuesForLambdaNames(context, identifierNamesFromExpression(expression.body));
  const lambdaContext = {
    ...context,
    locals: [createJavaIrLocal('param:this', { name: 'this', descriptor: `L${owner};`, slotHint: 0 })],
    localByName: new Map(),
    fieldByName: fieldMapForCaptures(owner, captures),
    methodOwnerInternalName: context.classInternalName,
    classInternalName: owner,
    className: owner.split('/').pop(),
    outerClassInternalName: context.classInternalName,
    outerMethodByName: context.methodByName,
    outerThisFieldName: captures.some((capture) => capture.name === 'this') ? 'this$0' : null,
    lambdaLexicalThis: true,
    currentMethodIsStatic: false,
    nextSlot: 1,
    nextLocalId: 0,
  };
  const value = coerceValueToDescriptor(
    lowerExpressionToJavaIrValue(expression.body, lambdaContext), 'Ljava/lang/Object;');
  if (!value) return null;
  const method = createJavaIrMethod({
    name: 'get', descriptor: '()Ljava/lang/Object;', access: ['public'], parameters: [],
    locals: lambdaContext.locals,
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock',
      ops: [createJavaIrOp('return', { value, sourceNodeKind: 'LambdaExpression' })],
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry', sourceNodeKind: 'LambdaExpression', meta: { synthetic: true },
  });
  return createSyntheticLambdaClass(context, 'java/util/function/Supplier', method, captures, owner);
}

function lowerToDoubleFunctionLambdaToJavaIrValue(expression, context) {
  if (!expression || expression.kind !== 'LambdaExpression') return null;
  const parameter = expression.parameters && expression.parameters[0];
  if (!parameter || !parameter.name || expression.parameters.length !== 1) return null;
  const owner = context.allocateLambdaClassName
    ? context.allocateLambdaClassName() : `${context.classInternalName}$Lambda${context.nextLambdaId || 0}`;
  const captures = captureValuesForLambdaNames(
    context, identifierNamesFromExpression(expression.body), [parameter.name]);
  const parameterLocal = createJavaIrLocal('param:arg0', {
    name: parameter.name, descriptor: 'Ljava/lang/Object;', slotHint: 1,
  });
  const lambdaContext = {
    ...context,
    locals: [
      createJavaIrLocal('param:this', { name: 'this', descriptor: `L${owner};`, slotHint: 0 }),
      parameterLocal,
    ],
    localByName: new Map([[parameter.name, parameterLocal]]),
    fieldByName: fieldMapForCaptures(owner, captures),
    methodOwnerInternalName: context.classInternalName,
    classInternalName: owner,
    className: owner.split('/').pop(),
    outerClassInternalName: context.classInternalName,
    outerMethodByName: context.methodByName,
    outerThisFieldName: captures.some((capture) => capture.name === 'this') ? 'this$0' : null,
    lambdaLexicalThis: true,
    currentMethodIsStatic: false,
    currentReturnDescriptor: 'D',
    nextSlot: 2,
    nextLocalId: 0,
  };
  const value = lowerExpressionToJavaIrValueAsDescriptor(expression.body, lambdaContext, 'D');
  if (!value) return null;
  const method = createJavaIrMethod({
    name: 'applyAsDouble', descriptor: '(Ljava/lang/Object;)D', access: ['public'],
    parameters: [{ id: parameterLocal.id, name: parameter.name, descriptor: parameterLocal.descriptor, slotHint: 1 }],
    locals: lambdaContext.locals,
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock',
      ops: [createJavaIrOp('return', { value, sourceNodeKind: 'LambdaExpression' })],
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry', sourceNodeKind: 'LambdaExpression', meta: { synthetic: true },
  });
  return createSyntheticLambdaClass(context, 'java/util/function/ToDoubleFunction', method, captures, owner);
}

function lowerDoubleUnaryOperatorLambdaToJavaIrValue(expression, context) {
  if (!expression || expression.kind !== 'LambdaExpression') return null;
  const parameter = expression.parameters && expression.parameters[0];
  if (!parameter || !parameter.name || expression.parameters.length !== 1) return null;
  const owner = context.allocateLambdaClassName
    ? context.allocateLambdaClassName() : `${context.classInternalName}$Lambda${context.nextLambdaId || 0}`;
  const captures = captureValuesForLambdaNames(
    context, identifierNamesFromExpression(expression.body), [parameter.name]);
  const parameterLocal = createJavaIrLocal('param:arg0', {
    name: parameter.name, descriptor: 'D', slotHint: 1,
  });
  const lambdaContext = {
    ...context,
    locals: [
      createJavaIrLocal('param:this', { name: 'this', descriptor: `L${owner};`, slotHint: 0 }),
      parameterLocal,
    ],
    localByName: new Map([[parameter.name, parameterLocal]]),
    fieldByName: fieldMapForCaptures(owner, captures),
    methodOwnerInternalName: context.classInternalName,
    classInternalName: owner,
    className: owner.split('/').pop(),
    outerClassInternalName: context.classInternalName,
    outerMethodByName: context.methodByName,
    outerThisFieldName: captures.some((capture) => capture.name === 'this') ? 'this$0' : null,
    lambdaLexicalThis: true,
    currentMethodIsStatic: false,
    currentReturnDescriptor: 'D',
    nextSlot: 3,
    nextLocalId: 0,
  };
  const value = lowerExpressionToJavaIrValueAsDescriptor(expression.body, lambdaContext, 'D');
  if (!value) return null;
  const method = createJavaIrMethod({
    name: 'applyAsDouble', descriptor: '(D)D', access: ['public'],
    parameters: [{ id: parameterLocal.id, name: parameter.name, descriptor: parameterLocal.descriptor, slotHint: 1 }],
    locals: lambdaContext.locals,
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock', ops: [createJavaIrOp('return', { value, sourceNodeKind: 'LambdaExpression' })],
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry', sourceNodeKind: 'LambdaExpression', meta: { synthetic: true },
  });
  return createSyntheticLambdaClass(context, 'java/util/function/DoubleUnaryOperator', method, captures, owner);
}

function lowerIntFunctionalLambdaToJavaIrValue(expression, context, options) {
  if (!expression || expression.kind !== 'LambdaExpression') return null;
  const parameter = expression.parameters && expression.parameters[0];
  if (!parameter || !parameter.name || expression.parameters.length !== 1) return null;
  const owner = context.allocateLambdaClassName
    ? context.allocateLambdaClassName() : `${context.classInternalName}$Lambda${context.nextLambdaId || 0}`;
  const captures = captureValuesForLambdaNames(
    context, identifierNamesFromExpression(expression.body), [parameter.name]);
  const parameterLocal = createJavaIrLocal('param:arg0', {
    name: parameter.name, descriptor: 'I', slotHint: 1,
  });
  const lambdaContext = {
    ...context,
    locals: [
      createJavaIrLocal('param:this', { name: 'this', descriptor: `L${owner};`, slotHint: 0 }),
      parameterLocal,
    ],
    localByName: new Map([[parameter.name, parameterLocal]]),
    fieldByName: fieldMapForCaptures(owner, captures),
    methodOwnerInternalName: context.classInternalName,
    classInternalName: owner,
    className: owner.split('/').pop(),
    outerClassInternalName: context.classInternalName,
    outerMethodByName: context.methodByName,
    outerThisFieldName: captures.some((capture) => capture.name === 'this') ? 'this$0' : null,
    lambdaLexicalThis: true,
    currentMethodIsStatic: false,
    currentReturnDescriptor: options.returnDescriptor,
    nextSlot: 2,
    nextLocalId: 0,
  };
  const value = lowerExpressionToJavaIrValueAsDescriptor(
    expression.body, lambdaContext, options.returnDescriptor);
  if (!value) return null;
  const descriptor = `(I)${options.returnDescriptor}`;
  const method = createJavaIrMethod({
    name: options.methodName, descriptor, access: ['public'],
    parameters: [{ id: parameterLocal.id, name: parameter.name, descriptor: 'I', slotHint: 1 }],
    locals: lambdaContext.locals,
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock', ops: [createJavaIrOp('return', { value, sourceNodeKind: 'LambdaExpression' })],
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry', sourceNodeKind: 'LambdaExpression', meta: { synthetic: true },
  });
  return createSyntheticLambdaClass(context, options.interfaceOwner, method, captures, owner);
}

function lowerSourceFunctionalInterfaceLambdaToJavaIrValue(expression, targetDescriptor, context) {
  if (!expression || expression.kind !== 'LambdaExpression'
      || !targetDescriptor.startsWith('L') || !targetDescriptor.endsWith(';')) return null;
  const interfaceOwner = targetDescriptor.slice(1, -1);
  const overloads = context.classMethodOverloadsByInternalName
    && context.classMethodOverloadsByInternalName.get(interfaceOwner);
  const candidates = overloads
    ? Array.from(overloads.values()).flat().filter((method) => !method.isStatic && method.name !== '<init>')
    : [];
  const parameters = expression.parameters || [];
  const sam = candidates.find((method) => method.parameterDescriptors.length === parameters.length);
  if (!sam) return null;
  const owner = context.allocateLambdaClassName
    ? context.allocateLambdaClassName() : `${context.classInternalName}$Lambda${context.nextLambdaId || 0}`;
  const parameterNames = parameters.map((parameter) => parameter.name);
  if (parameterNames.some((name) => !name)) return null;
  const captures = captureValuesForLambdaNames(
    context, identifierNamesFromExpression(expression.body), parameterNames);
  const parameterLocals = [];
  let slot = 1;
  for (let index = 0; index < parameters.length; index += 1) {
    const descriptor = sam.parameterDescriptors[index];
    parameterLocals.push(createJavaIrLocal(`param:arg${index}`, {
      name: parameterNames[index], descriptor, slotHint: slot,
    }));
    slot += descriptor === 'J' || descriptor === 'D' ? 2 : 1;
  }
  const lambdaContext = {
    ...context,
    locals: [createJavaIrLocal('param:this', { name: 'this', descriptor: `L${owner};`, slotHint: 0 })]
      .concat(parameterLocals),
    localByName: new Map(parameterLocals.map((local) => [local.name, local])),
    fieldByName: fieldMapForCaptures(owner, captures),
    methodOwnerInternalName: context.classInternalName,
    classInternalName: owner,
    className: owner.split('/').pop(),
    outerClassInternalName: context.classInternalName,
    outerMethodByName: context.methodByName,
    outerThisFieldName: captures.some((capture) => capture.name === 'this') ? 'this$0' : null,
    lambdaLexicalThis: true,
    currentMethodIsStatic: false,
    currentReturnDescriptor: sam.returnDescriptor,
    nextSlot: slot,
    nextLocalId: 0,
  };
  let ops;
  if (expression.body && expression.body.kind === 'BlockStatement') {
    ops = lowerStatementToJavaIrOps(expression.body, lambdaContext);
  } else {
    const value = lowerExpressionToJavaIrValueAsDescriptor(
      expression.body, lambdaContext, sam.returnDescriptor);
    if (!value) return null;
    ops = sam.returnDescriptor === 'V'
      ? [createJavaIrOp('invoke', { value, sourceNodeKind: 'LambdaExpression' })]
      : [createJavaIrOp('return', { value, sourceNodeKind: 'LambdaExpression' })];
  }
  if (!ops || ops.some((op) => op.op === 'unsupported')) return null;
  const method = createJavaIrMethod({
    name: sam.name, descriptor: sam.descriptor, access: ['public'],
    parameters: parameterLocals.map((local) => ({
      id: local.id, name: local.name, descriptor: local.descriptor, slotHint: local.slotHint,
    })),
    locals: lambdaContext.locals,
    blocks: [createJavaIrBlock('entry', { kind: 'EntryBlock', ops, terminator: javaIrReturn(null) })],
    entryBlockId: 'entry', sourceNodeKind: 'LambdaExpression', meta: { synthetic: true },
  });
  return createSyntheticLambdaClass(context, interfaceOwner, method, captures, owner);
}

function lowerLambdaToJavaIrValue(expression, targetDescriptor, context) {
  const anonymous = lowerAnonymousClassToJavaIrValue(expression, targetDescriptor, context);
  if (anonymous) return anonymous;
  if (targetDescriptor === 'Ljava/lang/Runnable;') {
    return lowerRunnableLambdaToJavaIrValue(expression, context)
      || lowerRunnableBlockLambdaToJavaIrValue(expression, context);
  }
  if (targetDescriptor === 'Ljava/util/function/Function;') {
    return lowerFunctionLambdaToJavaIrValue(expression, context)
      || lowerFunctionMethodReferenceToJavaIrValue(expression, context);
  }
  if (targetDescriptor === 'Ljava/util/function/Consumer;') {
    return lowerConsumerLambdaToJavaIrValue(expression, context);
  }
  if (targetDescriptor === 'Ljava/util/function/Supplier;') {
    return lowerSupplierLambdaToJavaIrValue(expression, context);
  }
  if (targetDescriptor === 'Ljava/util/function/ToDoubleFunction;') {
    return lowerToDoubleFunctionLambdaToJavaIrValue(expression, context);
  }
  if (targetDescriptor === 'Ljava/util/function/DoubleUnaryOperator;') {
    return lowerDoubleUnaryOperatorLambdaToJavaIrValue(expression, context);
  }
  if (targetDescriptor === 'Ljava/util/function/IntToDoubleFunction;') {
    return lowerIntFunctionalLambdaToJavaIrValue(expression, context, {
      interfaceOwner: 'java/util/function/IntToDoubleFunction', methodName: 'applyAsDouble', returnDescriptor: 'D',
    });
  }
  if (targetDescriptor === 'Ljava/util/function/IntPredicate;') {
    return lowerIntFunctionalLambdaToJavaIrValue(expression, context, {
      interfaceOwner: 'java/util/function/IntPredicate', methodName: 'test', returnDescriptor: 'Z',
    });
  }
  return lowerSourceFunctionalInterfaceLambdaToJavaIrValue(expression, targetDescriptor, context);
}

function lowerLeadingConcatMethodChain(expression, context) {
  if (!expression || expression.kind !== 'MethodInvocationExpression') return null;
  const chain = [];
  let cursor = expression;
  while (cursor && cursor.kind === 'MethodInvocationExpression') {
    chain.unshift(cursor);
    cursor = cursor.target;
  }
  if (!cursor || cursor.kind !== 'UnsupportedExpression' || !Array.isArray(cursor.tokens)) return null;
  const addIndex = findTopLevelOperator(cursor.tokens, ['+']);
  if (addIndex <= 0) return null;
  const left = lowerTokenExpressionToJavaIrValue(cursor.tokens.slice(0, addIndex), context);
  let current = lowerTokenExpressionToJavaIrValue(cursor.tokens.slice(addIndex + 1), context);
  if (!left || !current) return null;
  for (const callExpression of chain) {
    const args = (callExpression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
    if (!args.every(Boolean)) return null;
    const owner = internalNameFromDescriptor(current.type);
    const method = methodDescriptorForInstanceCall(owner, callExpression.name, args, context);
    if (!method) return null;
    current = {
      kind: 'MethodCallValue',
      type: method.returnDescriptor,
      owner,
      name: callExpression.name,
      descriptor: method.descriptor,
      invokeKind: method.invokeKind || 'virtual',
      receiver: current,
      args,
    };
  }
  if (left.type !== 'Ljava/lang/String;' && current.type !== 'Ljava/lang/String;') return null;
  const parts = flattenConcatParts(left).concat(current);
  const folded = foldedStringConcatValue(parts);
  return folded || {
    kind: 'StringConcatValue',
    type: 'Ljava/lang/String;',
    parts,
  };
}

function isCurrentThisExpression(expression) {
  if (!expression) return false;
  if (expression.kind === 'ThisExpression') return true;
  if (expression.kind === 'ParenthesizedExpression' || expression.kind === 'CastExpression') {
    return isCurrentThisExpression(expression.expression);
  }
  return false;
}

function lowerInstanceMethodCall(expression, context, receiverOverride = null) {
  const receiver = receiverOverride || lowerExpressionToJavaIrValue(expression.target, context);
  let args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  let contextualMethod = null;
  if (receiver && expression.name === 'forEach' && args.length === 1 && !args[0]) {
    args = [lowerLambdaToJavaIrValue(expression.arguments[0], 'Ljava/util/function/Consumer;', context)];
    if (args[0]) contextualMethod = {
      descriptor: '(Ljava/util/function/Consumer;)V', returnDescriptor: 'V',
      parameterDescriptors: ['Ljava/util/function/Consumer;'], invokeKind: 'interface',
    };
  }
  if (receiver && expression.name === 'mapToDouble' && args.length === 1 && !args[0]) {
    const functionalDescriptor = receiver.type === 'Ljava/util/stream/IntStream;'
      ? 'Ljava/util/function/IntToDoubleFunction;' : 'Ljava/util/function/ToDoubleFunction;';
    args = [lowerLambdaToJavaIrValue(expression.arguments[0], functionalDescriptor, context)];
    if (args[0]) contextualMethod = {
      descriptor: `(${functionalDescriptor})Ljava/util/stream/DoubleStream;`,
      returnDescriptor: 'Ljava/util/stream/DoubleStream;',
      parameterDescriptors: [functionalDescriptor], invokeKind: 'interface',
    };
  }
  if (receiver && expression.name === 'computeIfAbsent' && args.length === 2 && !args[1]) {
    args[1] = lowerLambdaToJavaIrValue(expression.arguments[1], 'Ljava/util/function/Function;', context);
  }
  if (receiver && expression.name === 'map' && args.length === 1 && !args[0]
      && receiver.type === 'Ljava/util/stream/DoubleStream;') {
    args[0] = lowerLambdaToJavaIrValue(expression.arguments[0], 'Ljava/util/function/DoubleUnaryOperator;', context);
    if (args[0]) contextualMethod = {
      descriptor: '(Ljava/util/function/DoubleUnaryOperator;)Ljava/util/stream/DoubleStream;',
      returnDescriptor: 'Ljava/util/stream/DoubleStream;',
      parameterDescriptors: ['Ljava/util/function/DoubleUnaryOperator;'], invokeKind: 'interface',
    };
  }
  if (receiver && expression.name === 'filter' && args.length === 1 && !args[0]
      && receiver.type === 'Ljava/util/stream/IntStream;') {
    args[0] = lowerLambdaToJavaIrValue(expression.arguments[0], 'Ljava/util/function/IntPredicate;', context);
    if (args[0]) contextualMethod = {
      descriptor: '(Ljava/util/function/IntPredicate;)Ljava/util/stream/IntStream;',
      returnDescriptor: 'Ljava/util/stream/IntStream;',
      parameterDescriptors: ['Ljava/util/function/IntPredicate;'], invokeKind: 'interface',
    };
  }
  if (!receiver || !args.every(Boolean)) return null;
  let owner = internalNameFromDescriptor(receiver.type);
  let method = contextualMethod || methodDescriptorForInstanceCall(owner, expression.name, args, context);
  if (!method && isCurrentThisExpression(expression.target)) {
    const inherited = methodDescriptorForInheritedInstanceCall(expression.name, args, context);
    if (inherited) {
      owner = inherited.owner;
      method = inherited.method;
    }
  }
  if (!method) return null;
  const callArgs = prepareMethodArguments(method, args) || args;
  return {
    kind: 'MethodCallValue',
    type: method.returnDescriptor,
    owner,
    name: expression.name,
    descriptor: method.descriptor,
    invokeKind: method.invokeKind || 'virtual',
    receiver,
    args: callArgs,
  };
}

function inheritedInstanceOwnerCandidates(context) {
  const candidates = [context.classInternalName, context.superName];
  if (context.superName === 'java/applet/Applet' || context.superName === 'java/awt/Applet') {
    candidates.push('java/applet/Applet', 'java/awt/Panel', 'java/awt/Container', 'java/awt/Component');
  }
  candidates.push('java/lang/Object');
  return dedupePreservingOrder(candidates.filter(Boolean));
}

function methodDescriptorForInheritedInstanceCall(name, args, context) {
  const owners = inheritedInstanceOwnerCandidates(context);
  for (const owner of owners) {
    const method = methodDescriptorForInstanceCall(owner, name, args, context);
    if (method) return { owner, method };
  }
  return null;
}

function lowerInheritedInstanceMethodCall(expression, context) {
  if (!expression || expression.kind !== 'MethodInvocationExpression' || expression.target || context.currentMethodIsStatic) return null;
  const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  if (!args.every(Boolean)) return null;
  const resolved = methodDescriptorForInheritedInstanceCall(expression.name, args, context);
  if (!resolved) return null;
  const callArgs = prepareMethodArguments(resolved.method, args) || args;
  if (!callArgs.every(Boolean)) return null;
  return {
    kind: 'MethodCallValue',
    type: resolved.method.returnDescriptor,
    owner: resolved.owner,
    name: expression.name,
    descriptor: resolved.method.descriptor,
    invokeKind: resolved.method.invokeKind || 'virtual',
    receiver: thisReceiverValue(context),
    args: callArgs,
  };
}

function lowerStatementOnlyInstanceCall(expression, context) {
  if (!expression || expression.kind !== 'MethodInvocationExpression' || !expression.target) return null;
  const receiver = lowerExpressionToJavaIrValue(expression.target, context);
  const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  if (!receiver || !args.every(Boolean)) return null;
  const owner = internalNameFromDescriptor(receiver.type);
  const method = methodDescriptorForInstanceCall(owner, expression.name, args, context);
  const callArgs = method && method.parameterDescriptors
    ? prepareMethodArguments(method, args) || args.map((arg, index) => coerceValueToDescriptor(arg, method.parameterDescriptors[index]))
    : args;
  if (!callArgs.every(Boolean)) return null;
  return {
    kind: 'MethodCallValue',
    type: method ? method.returnDescriptor : 'V',
    owner,
    name: expression.name,
    descriptor: method ? method.descriptor : `(${callArgs.map((arg) => arg.type).join('')})V`,
    invokeKind: method && method.invokeKind ? method.invokeKind : 'virtual',
    receiver,
    args: callArgs,
  };
}

function lowerStatementOnlyMethodCall(expression, context) {
  if (!expression || expression.kind !== 'MethodInvocationExpression') return null;
  if (expression.target) return lowerStatementOnlyInstanceCall(expression, context);

  const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  if (!args.every(Boolean)) return null;
  if (context.currentMethodIsStatic) {
    return {
      kind: 'MethodCallValue',
      type: 'V',
      owner: context.classInternalName,
      name: expression.name,
      descriptor: `(${args.map((arg) => arg.type).join('')})V`,
      invokeKind: 'static',
      args,
    };
  }

  const explicitObjectMethods = new Set(['wait', 'notify', 'notifyAll']);
  const resolved = explicitObjectMethods.has(expression.name)
    ? { owner: 'java/lang/Object', method: methodDescriptorForInstanceCall('java/lang/Object', expression.name, args, context) }
    : methodDescriptorForInheritedInstanceCall(expression.name, args, context);
  const owner = resolved ? resolved.owner : (context.superName || context.classInternalName);
  const method = resolved && resolved.method;
  const callArgs = method && method.parameterDescriptors ? prepareMethodArguments(method, args) : args;
  if (!callArgs || !callArgs.every(Boolean)) return null;
  return {
    kind: 'MethodCallValue',
    type: method ? method.returnDescriptor : 'V',
    owner,
    name: expression.name,
    descriptor: method ? method.descriptor : `(${callArgs.map((arg) => arg.type).join('')})V`,
    invokeKind: method && method.invokeKind ? method.invokeKind : 'virtual',
    receiver: thisReceiverValue(context),
    args: callArgs,
  };
}

function lowerStaticWrapperMethodCall(expression, context, targetNameOverride = null) {
  const targetName = targetNameOverride
    || (expression && expression.target && expression.target.kind === 'Identifier' ? expression.target.name : null);
  const owner = constructorOwnerFromName(targetName, context);
  const wrapperDescriptor = `L${owner};`;
  const primitive = primitiveDescriptorForWrapper(wrapperDescriptor);
  const rawArgs = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  if (primitive && expression.name === 'valueOf' && rawArgs.length === 1 && rawArgs[0]) {
    const arg = coerceValueToDescriptor(rawArgs[0], primitive);
    if (arg && arg.type === primitive) {
      return {
        kind: 'MethodCallValue',
        type: wrapperDescriptor,
        owner,
        name: 'valueOf',
        descriptor: `(${primitive})${wrapperDescriptor}`,
        invokeKind: 'static',
        args: [arg],
      };
    }
  }
  if (primitive && expression.name === 'toString' && rawArgs.length === 1 && rawArgs[0]) {
    const arg = coerceValueToDescriptor(rawArgs[0], primitive);
    if (arg && arg.type === primitive) {
      return {
        kind: 'MethodCallValue',
        type: 'Ljava/lang/String;',
        owner,
        name: 'toString',
        descriptor: `(${primitive})Ljava/lang/String;`,
        invokeKind: 'static',
        args: [arg],
      };
    }
  }
  return null;
}

function lowerStaticUserMethodCall(expression, context, targetNameOverride = null) {
  const targetName = targetNameOverride
    || (expression && expression.target && expression.target.kind === 'Identifier' ? expression.target.name : null);
  const owner = targetName
    ? constructorOwnerFromName(targetName, context)
    : resolveClassInternalNameFromParts(chainParts(expression && expression.target), context);
  const ownerOverloads = context.classMethodOverloadsByInternalName
    && context.classMethodOverloadsByInternalName.get(owner);
  const candidates = ownerOverloads && ownerOverloads.get(expression.name);
  const contextualMethod = Array.isArray(candidates)
    ? candidates.find((candidate) => candidate.isStatic
      && candidate.parameterDescriptors.length === (expression.arguments || []).length) : null;
  const rawArgs = (expression.arguments || []).map((argument, index) => {
    const expected = contextualMethod && contextualMethod.parameterDescriptors[index];
    return (expected && lowerExpressionToJavaIrValueAsDescriptor(argument, context, expected))
      || lowerExpressionToJavaIrValue(argument, context);
  });
  const method = selectUserMethodDescriptorInHierarchy(owner, expression.name, rawArgs, context, true);
  if (!method) return null;
  const args = prepareMethodArguments(method, rawArgs);
  if (!args) return null;
  return {
    kind: 'MethodCallValue',
    type: method.returnDescriptor,
    owner: method.declaredOwner || owner,
    name: method.name,
    descriptor: method.descriptor,
    invokeKind: 'static',
    args,
  };
}

function lowerKnownStaticMethodCall(expression, context) {
  if (!expression || expression.kind !== 'MethodInvocationExpression' || !expression.target) return null;
  const targetParts = chainParts(expression.target);
  const owner = resolveClassInternalNameFromParts(targetParts, context);
  const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  if (!args.every(Boolean)) return null;
  const jreMethod = selectJreMethodDescriptor(owner, expression.name, args, true);
  if (jreMethod) {
    const callArgs = prepareMethodArguments(jreMethod, args);
    if (!callArgs) return null;
    return {
      kind: 'MethodCallValue',
      type: jreMethod.returnDescriptor,
      owner,
      name: expression.name,
      descriptor: jreMethod.descriptor,
      invokeKind: jreMethod.invokeKind || 'static',
      args: callArgs,
    };
  }
  if (owner === 'java/lang/Class' && expression.name === 'forName' && args.length === 1 && args[0].type === 'Ljava/lang/String;') {
    return {
      kind: 'MethodCallValue',
      type: 'Ljava/lang/Class;',
      owner,
      name: 'forName',
      descriptor: '(Ljava/lang/String;)Ljava/lang/Class;',
      invokeKind: 'static',
      args,
    };
  }
  if (owner === 'java/lang/reflect/Modifier' && args.length === 1 && args[0].type === 'I' && ['isPrivate', 'isStatic'].includes(expression.name)) {
    return {
      kind: 'MethodCallValue',
      type: 'Z',
      owner,
      name: expression.name,
      descriptor: '(I)Z',
      invokeKind: 'static',
      args,
    };
  }
  if (owner === 'java/math/BigInteger' && expression.name === 'valueOf' && args.length === 1) {
    const arg = coerceValueToDescriptor(args[0], 'J');
    if (arg) {
      return {
        kind: 'MethodCallValue',
        type: 'Ljava/math/BigInteger;',
        owner,
        name: 'valueOf',
        descriptor: '(J)Ljava/math/BigInteger;',
        invokeKind: 'static',
        args: [arg],
      };
    }
  }
  if (owner === 'java/lang/Thread' && expression.name === 'sleep' && args.length === 1) {
    const arg = coerceValueToDescriptor(args[0], 'J');
    if (arg) {
      return {
        kind: 'MethodCallValue',
        type: 'V',
        owner,
        name: 'sleep',
        descriptor: '(J)V',
        invokeKind: 'static',
        args: [arg],
      };
    }
  }
  return null;
}

function lowerSameClassMethodCall(expression, context) {
  if (!expression || expression.kind !== 'MethodInvocationExpression' || expression.target) {
    return null;
  }
  if (!context.methodByName.has(expression.name)) {
    const outerMethod = context.outerMethodByName && context.outerMethodByName.get(expression.name);
    if (!outerMethod || !context.outerClassInternalName) return null;
    const rawArgs = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
    const method = selectUserMethodDescriptor(context.outerClassInternalName, expression.name, rawArgs, context, outerMethod.isStatic)
      || outerMethod;
    const args = prepareMethodArguments(method, rawArgs);
    if (args) {
      const receiver = method.isStatic ? null : outerThisValue(context);
      if (!method.isStatic && !receiver) return null;
      return {
        kind: 'MethodCallValue',
        type: method.returnDescriptor,
        owner: context.outerClassInternalName,
        name: method.name,
        descriptor: method.descriptor,
        invokeKind: method.isStatic ? 'static' : 'virtual',
        receiver,
        args,
      };
    }
    return null;
  }
  const rawArgs = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  const owner = context.methodOwnerInternalName || context.classInternalName;
  const method = selectUserMethodDescriptor(owner, expression.name, rawArgs, context, null)
    || context.methodByName.get(expression.name);
  const args = prepareMethodArguments(method, rawArgs);
  if (method.isStatic && args) {
    return {
      kind: 'MethodCallValue',
      type: method.returnDescriptor,
      owner,
      name: method.name,
      descriptor: method.descriptor,
      invokeKind: 'static',
      args,
    };
  }
  if (!method.isStatic && !context.currentMethodIsStatic && args) {
    return {
      kind: 'MethodCallValue',
      type: method.returnDescriptor,
      owner,
      name: method.name,
      descriptor: method.descriptor,
      invokeKind: 'virtual',
      receiver: {
        kind: 'LocalValue',
        type: `L${owner};`,
        local: 'param:this',
        name: 'this',
      },
      args,
    };
  }
  return null;
}

function constructorOwnerFromRecoveredNewCall(expression, context) {
  if (!expression
      || expression.kind !== 'MethodInvocationExpression'
      || !expression.target
      || expression.target.kind !== 'UnsupportedExpression'
      || !Array.isArray(expression.target.tokens)) {
    return null;
  }
  const tokens = trimParenTokens(expression.target.tokens);
  const newIndex = tokenText(tokens[0]) === 'new'
    ? 0
    : (tokenText(tokens[0]) === '!' && tokenText(tokens[1]) === 'new' ? 1 : -1);
  if (newIndex < 0) return null;
  const ownerTokens = tokens.slice(newIndex + 1);
  const typeTokens = ownerTokens.length > 0
    ? ownerTokens.concat([{ kind: 'symbol', text: '.' }, { kind: 'identifier', text: expression.name }])
    : [{ kind: 'identifier', text: expression.name }];
  return constructorOwnerFromTypeTokens(typeTokens, context);
}

function methodInvocationWithoutLeadingBang(expression) {
  if (!expression || expression.kind !== 'MethodInvocationExpression') return null;
  if (expression.target
      && expression.target.kind === 'UnsupportedExpression'
      && Array.isArray(expression.target.tokens)
      && tokenText(expression.target.tokens[0]) === '!') {
    return {
      ...expression,
      target: {
        ...expression.target,
        tokens: expression.target.tokens.slice(1),
        text: tokenTextJoined(expression.target.tokens.slice(1)),
      },
    };
  }
  const targetWithoutBang = methodInvocationWithoutLeadingBang(expression.target);
  return targetWithoutBang ? { ...expression, target: targetWithoutBang } : null;
}

function lowerMethodInvocationWithExpectedDescriptor(expression, context, expectedDescriptor) {
  if (!expression || expression.kind !== 'MethodInvocationExpression' || !expectedDescriptor || expectedDescriptor === 'V') return null;
  const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  if (!args.every(Boolean)) return null;
  if (expression.target) {
    const targetParts = chainParts(expression.target);
    const targetIsLocal = targetParts.length === 1 && context.localByName.has(targetParts[0]);
    const targetIsField = targetParts.length === 1
      && ((context.fieldByName && context.fieldByName.has(targetParts[0]))
        || (context.outerFieldByName && context.outerFieldByName.has(targetParts[0])));
    const instanceCall = targetIsLocal || targetIsField
      ? lowerInstanceMethodCall(expression, context)
      : null;
    if (instanceCall) return instanceCall;
    if (targetParts.length > 0 && !targetIsLocal && !targetIsField) {
      const owner = resolveClassInternalNameFromParts(targetParts, context);
      if (owner) {
        return {
          kind: 'MethodCallValue',
          type: expectedDescriptor,
          owner,
          name: expression.name,
          descriptor: `(${args.map((arg) => arg.type).join('')})${expectedDescriptor}`,
          invokeKind: 'static',
          args,
          meta: { recoveredExpectedReturn: true },
        };
      }
    }
    const receiver = lowerExpressionToJavaIrValue(expression.target, context);
    if (receiver) {
      return {
        kind: 'MethodCallValue',
        type: expectedDescriptor,
        owner: internalNameFromDescriptor(receiver.type),
        name: expression.name,
        descriptor: `(${args.map((arg) => arg.type).join('')})${expectedDescriptor}`,
        invokeKind: 'virtual',
        receiver,
        args,
        meta: { recoveredExpectedReturn: true },
      };
    }
    return null;
  }
  const owner = context.currentMethodIsStatic ? context.classInternalName : context.classInternalName;
  return {
    kind: 'MethodCallValue',
    type: expectedDescriptor,
    owner,
    name: expression.name,
    descriptor: `(${args.map((arg) => arg.type).join('')})${expectedDescriptor}`,
    invokeKind: context.currentMethodIsStatic ? 'static' : 'virtual',
    receiver: context.currentMethodIsStatic ? undefined : thisReceiverValue(context),
    args,
    meta: { recoveredExpectedReturn: true },
  };
}

function lowerExpressionToJavaIrValueAsDescriptor(expression, context, descriptor) {
  const lambda = lowerLambdaToJavaIrValue(expression, descriptor, context);
  if (lambda) return coerceValueToDescriptor(lambda, descriptor);
  const direct = lowerExpressionToJavaIrValue(expression, context);
  const coerced = coerceValueToDescriptor(direct, descriptor);
  if (coerced && coerced.type === descriptor) return coerced;
  const expectedCall = lowerMethodInvocationWithExpectedDescriptor(expression, context, descriptor);
  return coerceValueToDescriptor(expectedCall, descriptor);
}

function recoverPrimitiveCastAroundMethodChain(expression) {
  if (!expression || expression.kind !== 'MethodInvocationExpression' || expression.meta && expression.meta.recoveredPrimitiveCastChain) {
    return null;
  }
  function stripCast(node) {
    if (!node || node.kind !== 'MethodInvocationExpression' || !node.target) return null;
    if (node.target.kind === 'CastExpression'
        && node.target.castType
        && node.target.castType.kind === 'PrimitiveType') {
      return {
        expression: { ...node, target: node.target.expression },
        castType: node.target.castType,
      };
    }
    const nested = stripCast(node.target);
    return nested ? { ...nested, expression: { ...node, target: nested.expression } } : null;
  }
  const recovered = stripCast(expression);
  return recovered ? {
    kind: 'CastExpression',
    castType: recovered.castType,
    expression: { ...recovered.expression, meta: { ...(recovered.expression.meta || {}), recoveredPrimitiveCastChain: true } },
    meta: { recoveredBy: 'java-frontend.primitiveCastMethodChain' },
  } : null;
}

function fieldMetadataForOwner(owner, name, context) {
  const visited = new Set();
  const pending = [owner];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const fields = context.classFieldsByInternalName && context.classFieldsByInternalName.get(current);
    if (fields && fields.has(name)) return fields.get(name);
    const jreField = jreFieldInfo(current, name);
    if (jreField) return jreField;
    const superName = context.classSuperByInternalName && context.classSuperByInternalName.get(current);
    if (superName) pending.push(superName);
    const interfaces = context.classInterfacesByInternalName && context.classInterfacesByInternalName.get(current);
    if (Array.isArray(interfaces)) pending.push(...interfaces);
  }
  return jreFieldInfo(owner, name);
}

function lowerExpressionToJavaIrValue(expression, context) {
  const literal = literalToJavaIrValue(expression);
  if (literal) return literal;
  const recoveredPrimitiveCastChain = recoverPrimitiveCastAroundMethodChain(expression);
  if (recoveredPrimitiveCastChain) {
    const recoveredValue = lowerExpressionToJavaIrValue(recoveredPrimitiveCastChain, context);
    if (recoveredValue) return recoveredValue;
  }
  if (expression && expression.kind === 'MethodInvocationExpression'
      && expression.target && expression.target.kind === 'NewArrayExpression'
      && (expression.target.dimensions || []).length === 0
      && Number(expression.target.emptyDimensions || 0) === 0
      && !expression.target.initializer) {
    const parsedType = expression.target.elementType;
    if (parsedType && parsedType.kind === 'ClassType') {
      const packageName = [parsedType.packageName, parsedType.name].filter(Boolean).join('.');
      return lowerExpressionToJavaIrValue({
        kind: 'NewClassExpression',
        classType: { kind: 'ClassType', name: expression.name, packageName, typeArguments: [], annotations: [] },
        arguments: expression.arguments || [],
        body: null,
      }, context);
    }
  }
  if (expression && expression.kind === 'ParenthesizedExpression') {
    return lowerExpressionToJavaIrValue(expression.expression, context);
  }
  if (expression && expression.kind === 'ThisExpression') {
    return (context.lambdaLexicalThis && outerThisValue(context)) || thisReceiverValue(context);
  }
  if (expression && expression.kind === 'SuperExpression') {
    return { ...thisReceiverValue(context), type: `L${context.superName || 'java/lang/Object'};` };
  }
  if (expression && expression.kind === 'CastExpression') {
    const value = lowerExpressionToJavaIrValue(expression.expression, context);
    let descriptor = null;
    try { descriptor = typeDescriptor(expression.castType, context); } catch (_) {}
    return value && descriptor ? { kind: 'CastValue', type: descriptor, fromType: value.type, value } : null;
  }
  if (expression && expression.kind === 'ArrayInitializerExpression') {
    const elements = (expression.elements || []).map((element) => lowerExpressionToJavaIrValue(element, context));
    return elements.every(Boolean) ? { kind: 'ArrayInitializerValue', type: null, elements } : null;
  }
  if (expression && expression.kind === 'NewClassExpression') {
    if (Array.isArray(expression.body)) {
      const anonymous = lowerAnonymousClassToJavaIrValue(expression, null, context);
      if (anonymous) return anonymous;
    }
    let owner = null;
    try { owner = classTypeInternalName(expression.classType, context); } catch (_) {}
    const captureArgs = owner ? constructorCaptureArgs(owner, context) : [];
    const constructorOverloads = owner && context.classMethodOverloadsByInternalName
      && context.classMethodOverloadsByInternalName.get(owner);
    const constructorCandidates = constructorOverloads && constructorOverloads.get('<init>');
    const contextualConstructor = Array.isArray(constructorCandidates)
      ? constructorCandidates.find((candidate) => candidate.parameterDescriptors.length
        === captureArgs.length + (expression.arguments || []).length) : null;
    const args = (expression.arguments || []).map((argument, index) => {
      const expected = contextualConstructor
        && contextualConstructor.parameterDescriptors[captureArgs.length + index];
      return (expected && lowerExpressionToJavaIrValueAsDescriptor(argument, context, expected))
        || lowerExpressionToJavaIrValue(argument, context)
        || (expected && lowerLambdaToJavaIrValue(argument, expected, context));
    });
    if (!owner || !args.every(Boolean) || !captureArgs.every(Boolean)) return null;
    const constructorArgs = captureArgs.concat(args);
    const method = methodDescriptorForConstructorCall(owner, constructorArgs, context);
    const coercedArgs = prepareMethodArguments(method, constructorArgs) || constructorArgs;
    return {
      kind: 'NewObjectValue',
      type: `L${owner};`,
      owner,
      descriptor: method.descriptor || `(${coercedArgs.map((arg) => arg.type).join('')})V`,
      args: coercedArgs,
    };
  }
  if (expression && expression.kind === 'NewArrayExpression') {
    let baseDescriptor = null;
    try { baseDescriptor = typeDescriptor(expression.elementType, context); } catch (_) {}
    const counts = (expression.dimensions || []).map((dimension) => coerceValueToDescriptor(lowerExpressionToJavaIrValue(dimension, context), 'I'));
    const dimensions = counts.length + (expression.emptyDimensions || 0);
    if (!baseDescriptor || dimensions === 0 || !counts.every(Boolean)) return null;
    const type = `${'['.repeat(dimensions)}${baseDescriptor}`;
    if (expression.initializer) return coerceValueToDescriptor(lowerExpressionToJavaIrValue(expression.initializer, context), type);
    if (counts.length > 1) return { kind: 'MultiNewArrayValue', type, counts };
    if (counts.length !== 1) return null;
    const component = type.slice(1);
    const primitive = Object.entries(PRIMITIVE_DESCRIPTOR_BY_NAME).find(([, descriptor]) => descriptor === component);
    return { kind: 'NewArrayValue', type, component: primitive ? primitive[0] : arrayComponentForAnewarray(component), reference: !primitive, count: counts[0] };
  }
  if (expression && expression.kind === 'ClassLiteralExpression') {
    let descriptor = null;
    try { descriptor = typeDescriptor(expression.literalType, context); } catch (_) {}
    if (!descriptor) return null;
    if (descriptor.length === 1) {
      const wrapper = PRIMITIVE_WRAPPER_BY_DESCRIPTOR[descriptor] || 'java/lang/Void';
      return { kind: 'StaticFieldValue', type: 'Ljava/lang/Class;', owner: wrapper, name: 'TYPE', descriptor: 'Ljava/lang/Class;' };
    }
    return { kind: 'ClassLiteralValue', type: 'Ljava/lang/Class;', className: descriptor.startsWith('L') ? descriptor.slice(1, -1) : descriptor };
  }
  if (expression && expression.kind === 'InstanceofExpression') {
    const value = lowerExpressionToJavaIrValue(expression.expression, context);
    let descriptor = null;
    try { descriptor = typeDescriptor(expression.checkType, context); } catch (_) {}
    return value && descriptor ? { kind: 'InstanceOfValue', type: 'Z', value, className: descriptor.startsWith('L') ? descriptor.slice(1, -1) : descriptor } : null;
  }
  if (expression && expression.kind === 'MethodInvocationExpression' && expression.target
      && !['ThisExpression', 'SuperExpression'].includes(expression.target.kind)) {
    const receiver = lowerExpressionToJavaIrValue(expression.target, context);
    const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
    const owner = receiver && internalNameFromDescriptor(receiver.type);
    if (receiver && owner && args.every(Boolean)) {
      const method = methodDescriptorForInstanceCall(owner, expression.name, args, context);
      const callArgs = prepareMethodArguments(method, args);
      if (method && callArgs) {
        return {
          kind: 'MethodCallValue',
          type: method.returnDescriptor,
          owner,
          name: expression.name,
          descriptor: method.descriptor,
          invokeKind: method.invokeKind || 'virtual',
          receiver,
          args: callArgs,
        };
      }
    }
  }
  if (expression && expression.kind === 'MethodInvocationExpression'
      && ['ThisExpression', 'SuperExpression'].includes(expression.target && expression.target.kind)) {
    if (expression.target.kind === 'ThisExpression' && expression.name !== '<init>') {
      return lowerInstanceMethodCall(expression, context);
    }
    const owner = expression.target.kind === 'SuperExpression'
      ? (context.superName || 'java/lang/Object')
      : context.classInternalName;
    const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
    if (!args.every(Boolean)) return null;
    const method = expression.name === '<init>'
      ? methodDescriptorForConstructorCall(owner, args, context)
      : methodDescriptorForInstanceCall(owner, expression.name, args, context);
    if (!method) return null;
    const callArgs = prepareMethodArguments(method, args) || args;
    return {
      kind: 'MethodCallValue', type: expression.name === '<init>' ? 'V' : method.returnDescriptor,
      owner, name: expression.name, descriptor: method.descriptor || `(${callArgs.map((arg) => arg.type).join('')})V`,
      invokeKind: 'special', receiver: thisReceiverValue(context), args: callArgs,
    };
  }
  if (expression && expression.kind === 'MethodInvocationExpression' && !expression.target) {
    const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
    if (args.every(Boolean)) {
      const owners = [context.methodOwnerInternalName || context.classInternalName, context.outerClassInternalName].filter(Boolean);
      for (const owner of owners) {
        const method = selectUserMethodDescriptor(owner, expression.name, args, context, null);
        const callArgs = prepareMethodArguments(method, args);
        const receiver = method && !method.isStatic
          ? (owner === context.classInternalName ? thisReceiverValue(context) : outerThisValue(context))
          : null;
        if (method && callArgs && (method.isStatic || receiver)) {
          return {
            kind: 'MethodCallValue', type: method.returnDescriptor, owner, name: expression.name,
            descriptor: method.descriptor, invokeKind: method.isStatic ? 'static' : 'virtual', receiver, args: callArgs,
          };
        }
      }
    }
  }
  if (expression && expression.kind === 'ArrayAccessExpression') {
    const array = lowerExpressionToJavaIrValue(expression.array, context);
    const index = coerceValueToDescriptor(lowerExpressionToJavaIrValue(expression.index, context), 'I');
    return array && index && array.type.startsWith('[')
      ? { kind: 'ArrayLoadValue', type: array.type.slice(1), array, index }
      : null;
  }
  if (expression && expression.kind === 'ConditionalExpression') {
    const condition = lowerExpressionToJavaIrValue(expression.condition, context);
    const consequentRaw = lowerExpressionToJavaIrValue(expression.consequent, context);
    const alternateRaw = lowerExpressionToJavaIrValue(expression.alternate, context);
    const descriptor = conditionalValueDescriptor(consequentRaw, alternateRaw);
    const consequent = descriptor && coerceValueToDescriptor(consequentRaw, descriptor);
    const alternate = descriptor && coerceValueToDescriptor(alternateRaw, descriptor);
    return condition && condition.type === 'Z' && consequent && alternate
      ? { kind: 'ConditionalValue', type: descriptor, condition, consequent, alternate }
      : null;
  }
  if (expression && expression.kind === 'AssignmentExpression' && expression.operator === '='
      && expression.left.kind === 'Identifier' && context.localByName.has(expression.left.name)) {
    const local = context.localByName.get(expression.left.name);
    const value = coerceValueToDescriptor(lowerExpressionToJavaIrValue(expression.right, context), local.descriptor);
    return value ? { kind: 'AssignValue', type: local.descriptor, target: local.id, value } : null;
  }
  if (expression && expression.kind === 'UnaryExpression') {
    const value = lowerExpressionToJavaIrValue(expression.operand, context);
    if (expression.prefix && value && value.kind === 'LocalValue' && ['I', 'J', 'F', 'D'].includes(value.type) && ['++', '--'].includes(expression.operator)) {
      return { kind: 'PreUpdateValue', type: value.type, target: value.local, operator: expression.operator };
    }
    if (!expression.prefix && value && value.kind === 'LocalValue' && value.type === 'I' && ['++', '--'].includes(expression.operator)) {
      return { kind: 'PostUpdateValue', type: 'I', target: value.local, operator: expression.operator };
    }
    if (expression.operator === '-' && value && value.kind === 'LiteralValue' && ['I', 'J', 'F', 'D'].includes(value.type)) {
      const numeric = typeof value.value === 'bigint'
        ? -value.value
        : -Number(String(value.raw || value.value).replace(/[lLfFdD]$/, ''));
      if (typeof numeric === 'bigint' || Number.isFinite(numeric)) {
        return { ...value, value: numeric, raw: `-${value.raw || value.value}` };
      }
    }
    const promoted = value && ['B', 'S', 'C'].includes(value.type) ? coerceValueToDescriptor(value, 'I') : value;
    return promoted && ['+', '-', '!', '~'].includes(expression.operator)
      ? (expression.operator === '+' ? promoted : { kind: 'UnaryValue', type: promoted.type, operator: expression.operator, value: promoted })
      : null;
  }
  if (expression && expression.kind === 'BinaryExpression') {
    let left = lowerExpressionToJavaIrValue(expression.left, context);
    let right = lowerExpressionToJavaIrValue(expression.right, context);
    if (['||', '&&'].includes(expression.operator)) return logicalShortCircuitValue(expression.operator, left, right);
    if (['==', '!=', '<', '>', '<=', '>='].includes(expression.operator)) {
      if (left && right && left.literalKind === 'null') left = coerceValueToDescriptor(left, right.type);
      if (left && right && right.literalKind === 'null') right = coerceValueToDescriptor(right, left.type);
      const recovered = recoverBinaryNumericOperands(left, right);
      if (recovered) {
        left = coerceValueToDescriptor(recovered.left, recovered.descriptor);
        right = coerceValueToDescriptor(recovered.right, recovered.descriptor);
      }
      const isReference = (value) => value && typeof value.type === 'string'
        && (value.type.startsWith('L') || value.type.startsWith('['));
      if (['==', '!='].includes(expression.operator) && isReference(left) && isReference(right) && left.type !== right.type) {
        left = coerceValueToDescriptor(left, 'Ljava/lang/Object;');
        right = coerceValueToDescriptor(right, 'Ljava/lang/Object;');
      }
      return left && right && left.type === right.type
        ? { kind: 'CompareValue', type: 'Z', operator: expression.operator, left, right }
        : null;
    }
    if (expression.operator === '+' && ((left && left.type === 'Ljava/lang/String;') || (right && right.type === 'Ljava/lang/String;'))) {
      if (left && right && left.kind === 'LiteralValue' && right.kind === 'LiteralValue') {
        return { kind: 'LiteralValue', type: 'Ljava/lang/String;', literalKind: 'string', value: String(left.value) + String(right.value), raw: null };
      }
      return left && right ? { kind: 'StringConcatValue', type: 'Ljava/lang/String;', parts: [left, right] } : null;
    }
    if (['&', '|', '^'].includes(expression.operator) && left && right && left.type === 'Z' && right.type === 'Z') {
      return { kind: 'BinaryValue', type: 'Z', operator: expression.operator, left, right };
    }
    const selector = ['&', '|', '^', '<<', '>>', '>>>'].includes(expression.operator) ? binaryIntegralDescriptor : binaryNumericDescriptor;
    const recovered = recoverBinaryNumericOperands(left, right, selector);
    if (!recovered) return null;
    left = coerceValueToDescriptor(recovered.left, recovered.descriptor);
    right = coerceValueToDescriptor(recovered.right, ['<<', '>>', '>>>'].includes(expression.operator) ? 'I' : recovered.descriptor);
    return left && right ? { kind: 'BinaryValue', type: recovered.descriptor, operator: expression.operator, left, right } : null;
  }
  const withoutLeadingBang = methodInvocationWithoutLeadingBang(expression);
  if (withoutLeadingBang) {
    const value = lowerExpressionToJavaIrValue(withoutLeadingBang, context);
    if (value && value.type === 'Z') {
      return {
        kind: 'UnaryValue',
        type: 'Z',
        operator: '!',
        value,
      };
    }
  }
  if (expression && expression.kind === 'Identifier' && context.localByName.has(expression.name)) {
    const local = context.localByName.get(expression.name);
    return {
      kind: 'LocalValue',
      type: local.descriptor,
      local: local.id,
      name: local.name,
    };
  }
  if (expression && expression.kind === 'Identifier' && context.fieldByName && context.fieldByName.has(expression.name)) {
    const field = context.fieldByName.get(expression.name);
    return fieldValueForContext(field, context);
  }
  if (expression && expression.kind === 'Identifier') {
    const field = fieldMetadataForOwner(context.classInternalName, expression.name, context);
    if (field) return fieldValueForContext(field, context);
  }
  if (expression && expression.kind === 'Identifier' && context.outerFieldByName && context.outerFieldByName.has(expression.name)) {
    const field = context.outerFieldByName.get(expression.name);
    if (field.isStatic) return fieldValueForContext(field, context);
    const receiver = outerThisValue(context);
    if (receiver) {
      return {
        kind: 'FieldValue',
        type: field.descriptor,
        owner: field.owner,
        name: field.name,
        descriptor: field.descriptor,
        receiver,
      };
    }
  }
  if (expression && expression.kind === 'FieldAccessExpression' && expression.name === 'length') {
    const target = lowerExpressionToJavaIrValue(expression.target, context);
    if (target && typeof target.type === 'string' && target.type.startsWith('[')) {
      return {
        kind: 'ArrayLengthValue',
        type: 'I',
        array: target,
      };
    }
  }
  if (expression && expression.kind === 'FieldAccessExpression' && expression.name === 'TYPE') {
    const targetParts = chainParts(expression.target);
    const owner = targetParts.length === 1 ? constructorOwnerFromName(targetParts[0], context) : targetParts.join('/');
    if (primitiveDescriptorForWrapper(`L${owner};`) || owner === 'java/lang/Void') {
      return {
        kind: 'StaticFieldValue',
        type: 'Ljava/lang/Class;',
        owner,
        name: 'TYPE',
        descriptor: 'Ljava/lang/Class;',
      };
    }
  }
  if (expression && expression.kind === 'FieldAccessExpression') {
    const targetParts = chainParts(expression.target);
    const localTarget = targetParts.length === 1 && context.localByName.has(targetParts[0]);
    const owner = localTarget ? null : resolveClassInternalNameFromParts(targetParts, context);
    const field = owner ? fieldMetadataForOwner(owner, expression.name, context) : null;
    if (field && field.isStatic) {
      return {
        kind: 'StaticFieldValue',
        type: field.descriptor,
        owner,
        name: expression.name,
        descriptor: field.descriptor,
      };
    }
    if (owner && /^[A-Z][A-Z0-9_]*$/.test(expression.name) && !STATIC_CONSTANT_FIELDS[`${owner}.${expression.name}`]) {
      const descriptor = `L${owner};`;
      return {
        kind: 'StaticFieldValue',
        type: descriptor,
        owner,
        name: expression.name,
        descriptor,
      };
    }
    if (targetParts.length === 1) {
      const staticOwner = constructorOwnerFromName(targetParts[0], context);
      const descriptor = STATIC_CONSTANT_FIELDS[`${staticOwner}.${expression.name}`];
      if (descriptor) {
        return {
          kind: 'StaticFieldValue',
          type: descriptor,
          owner: staticOwner,
          name: expression.name,
          descriptor,
        };
      }
    }
    if (targetParts.length > 1) {
      const owner = targetParts.slice(0, -1).join('/');
      const descriptor = STATIC_CONSTANT_FIELDS[`${owner}.${expression.name}`];
      if (descriptor) {
        return {
          kind: 'StaticFieldValue',
          type: descriptor,
          owner,
          name: expression.name,
          descriptor,
        };
      }
    }
    if (targetParts.length === 2) {
      const owner = targetParts.join('/');
      const descriptor = STATIC_CONSTANT_FIELDS[`${owner}.${expression.name}`];
      if (descriptor) {
        return {
          kind: 'StaticFieldValue',
          type: descriptor,
          owner,
          name: expression.name,
          descriptor,
        };
      }
    }
    if (targetParts.length === 3 && targetParts[0] === 'java' && targetParts[1] === 'lang') {
      const owner = targetParts.join('/');
      const descriptor = STATIC_CONSTANT_FIELDS[`${owner}.${expression.name}`];
      if (descriptor) {
        return {
          kind: 'StaticFieldValue',
          type: descriptor,
          owner,
          name: expression.name,
          descriptor,
        };
      }
    }
    if (targetParts.length === 1 && targetParts[0] === 'Double' && expression.name === 'NaN') {
      return {
        kind: 'StaticFieldValue',
        type: 'D',
        owner: 'java/lang/Double',
        name: 'NaN',
        descriptor: 'D',
      };
    }
    const target = lowerExpressionToJavaIrValue(expression.target, context);
    const targetOwner = target ? internalNameFromDescriptor(target.type) : null;
    const targetField = fieldMetadataForOwner(targetOwner, expression.name, context)
      || (targetOwner === context.classInternalName && context.fieldByName ? context.fieldByName.get(expression.name) : null);
    if (target && targetField) {
      return {
        kind: 'FieldValue',
        type: targetField.descriptor,
        owner: targetOwner,
        name: targetField.name,
        descriptor: targetField.descriptor,
        receiver: target,
      };
    }
    if (!localTarget && owner) {
      return {
        kind: 'StaticFieldValue',
        type: 'Ljava/lang/Object;',
        owner,
        name: expression.name,
        descriptor: 'Ljava/lang/Object;',
        meta: { recoveredUnknownStaticField: true },
      };
    }
    if (target && targetOwner && typeof target.type === 'string' && target.type.startsWith('L')) {
      return {
        kind: 'FieldValue',
        type: 'Ljava/lang/Object;',
        owner: targetOwner,
        name: expression.name,
        descriptor: 'Ljava/lang/Object;',
        receiver: target,
      };
    }
  }
  if (expression && expression.kind === 'UnsupportedExpression' && Array.isArray(expression.tokens)
      && lambdaArrowIndex(expression.tokens) >= 0) {
    const tokens = trimParenTokens(expression.tokens);
    if (tokenText(tokens[0]) === '(') {
      const closeCast = matchingTokenIndex(tokens, 0, '(', ')');
      const owner = closeCast > 1 ? constructorOwnerFromTypeTokens(tokens.slice(1, closeCast), context) : null;
      const targetDescriptor = owner ? `L${owner};` : null;
      const lambdaExpression = { ...expression, tokens: trimParenTokens(tokens.slice(closeCast + 1)) };
      const lambda = targetDescriptor ? lowerLambdaToJavaIrValue(lambdaExpression, targetDescriptor, context) : null;
      if (lambda) return lambda;
    }
  }
  if (expression && expression.kind === 'UnsupportedExpression' && Array.isArray(expression.tokens)) {
    return lowerTokenExpressionToJavaIrValue(expression.tokens, context);
  }
  if (expression && expression.kind === 'MethodInvocationExpression'
      && expression.target
      && expression.target.kind === 'UnsupportedExpression'
      && Array.isArray(expression.target.tokens)) {
    const logicalOrIndex = findTopLevelOperator(expression.target.tokens, ['||']);
    if (logicalOrIndex > 0) {
      const left = lowerTokenExpressionToJavaIrValue(expression.target.tokens.slice(0, logicalOrIndex), context);
      const receiver = lowerTokenExpressionToJavaIrValue(expression.target.tokens.slice(logicalOrIndex + 1), context);
      const call = receiver ? lowerInstanceMethodCall(expression, context, receiver) : null;
      const logical = logicalShortCircuitValue('||', left, call);
      if (logical) return logical;
    }
    const logicalAndIndex = findTopLevelOperator(expression.target.tokens, ['&&']);
    if (logicalAndIndex > 0) {
      const left = lowerTokenExpressionToJavaIrValue(expression.target.tokens.slice(0, logicalAndIndex), context);
      const receiver = lowerTokenExpressionToJavaIrValue(expression.target.tokens.slice(logicalAndIndex + 1), context);
      const call = receiver ? lowerInstanceMethodCall(expression, context, receiver) : null;
      const logical = logicalShortCircuitValue('&&', left, call);
      if (logical) return logical;
    }
    const trailingOperator = expression.target.tokens.length > 1
      ? tokenText(expression.target.tokens[expression.target.tokens.length - 1])
      : null;
    if (['+', '-', '*', '/', '%'].includes(trailingOperator)) {
      const left = lowerTokenExpressionToJavaIrValue(expression.target.tokens.slice(0, -1), context);
      const call = lowerSameClassMethodCall({ ...expression, target: null }, context)
        || lowerKnownStaticMethodCall({ ...expression, target: null }, context);
      const numericLeft = boxedPrimitiveValue(left) || left;
      const numericRight = boxedPrimitiveValue(call) || call;
      if (numericLeft && numericRight && numericLeft.type === numericRight.type && ['I', 'J', 'F', 'D'].includes(numericLeft.type)) {
        return {
          kind: 'BinaryValue',
          type: numericLeft.type,
          operator: trailingOperator,
          left: numericLeft,
          right: numericRight,
        };
      }
    }
    if (expression.target.tokens.length === 3
        && expression.target.tokens[0].kind === 'identifier'
        && tokenText(expression.target.tokens[1]) === '.'
        && tokenText(expression.target.tokens[2]) === 'new'
        && context.localByName.has(expression.target.tokens[0].text)) {
      const outer = localValue(context.localByName.get(expression.target.tokens[0].text));
      const owner = constructorOwnerFromName(expression.name, context);
      const args = [outer].concat((expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context)));
      if (args.every(Boolean)) {
        return {
          kind: 'NewObjectValue',
          type: `L${owner};`,
          owner,
          descriptor: `(${args.map((arg) => arg.type).join('')})V`,
          args,
        };
      }
    }
    const recoveredNewOwner = constructorOwnerFromRecoveredNewCall(expression, context);
    if (recoveredNewOwner) {
      const owner = recoveredNewOwner;
      const captureArgs = constructorCaptureArgs(owner, context);
      const args = (expression.arguments || []).map((argument, index) => {
        const value = owner === 'java/lang/Thread' && index === 0
          ? lowerLambdaToJavaIrValue(argument, 'Ljava/lang/Runnable;', context)
            || lowerExpressionToJavaIrValue(argument, context)
          : lowerExpressionToJavaIrValue(argument, context);
        return value || null;
      });
      if (args.every(Boolean) && captureArgs.every(Boolean)) {
        const constructorArgs = captureArgs.concat(args);
        const method = methodDescriptorForConstructorCall(owner, constructorArgs, context);
        const coercedArgs = prepareMethodArguments(method, constructorArgs) || constructorArgs;
        return {
          kind: 'NewObjectValue',
          type: `L${owner};`,
          owner,
          descriptor: method.descriptor || `(${coercedArgs.map((arg) => arg.type).join('')})V`,
          args: coercedArgs,
        };
      }
    }
    const addIndex = findTopLevelOperator(expression.target.tokens, ['+']);
    if (addIndex > 0) {
      const left = lowerTokenExpressionToJavaIrValue(expression.target.tokens.slice(0, addIndex), context);
      const receiverTokens = expression.target.tokens.slice(addIndex + 1);
      const castedCall = receiverTokens.length >= 4
        && tokenText(receiverTokens[0]) === '('
        && tokenText(receiverTokens[2]) === ')'
        ? (() => {
          const targetDescriptor = descriptorFromCastToken(tokenText(receiverTokens[1]), context);
          const rawReceiver = lowerTokenExpressionToJavaIrValue(receiverTokens.slice(3), context);
          const rawCall = rawReceiver ? lowerInstanceMethodCall(expression, context, rawReceiver) : null;
          return targetDescriptor && rawCall ? {
            kind: 'CastValue',
            type: targetDescriptor,
            fromType: rawCall.type,
            value: rawCall,
          } : null;
        })()
        : null;
      const receiver = castedCall ? null : lowerTokenExpressionToJavaIrValue(receiverTokens, context);
      const call = castedCall || (receiver
        ? lowerInstanceMethodCall(expression, context, receiver)
        : (receiverTokens.length === 0
          ? lowerSameClassMethodCall({ ...expression, target: null }, context)
          : receiverTokens.length === 1 && receiverTokens[0].kind === 'identifier'
          ? (lowerKnownStaticMethodCall({ ...expression, target: { kind: 'Identifier', name: receiverTokens[0].text } }, context)
            || lowerStaticWrapperMethodCall(expression, context, receiverTokens[0].text))
          : null));
      if (left && call) {
        if (left.type !== 'Ljava/lang/String;' && call.type !== 'Ljava/lang/String;') {
          const numericLeft = boxedPrimitiveValue(left) || left;
          const numericRight = boxedPrimitiveValue(call) || call;
          if (numericLeft.type === numericRight.type && ['I', 'J', 'F', 'D'].includes(numericLeft.type)) {
            return {
              kind: 'BinaryValue',
              type: numericLeft.type,
              operator: '+',
              left: numericLeft,
              right: numericRight,
            };
          }
        }
        const parts = flattenConcatParts(left).concat(call);
        const folded = foldedStringConcatValue(parts);
        if (folded) return folded;
        return {
          kind: 'StringConcatValue',
          type: 'Ljava/lang/String;',
          parts,
        };
      }
    }
    if (expression.target.tokens.length >= 4
        && tokenText(expression.target.tokens[0]) === '('
        && tokenText(expression.target.tokens[2]) === ')') {
      const targetDescriptor = descriptorFromCastToken(tokenText(expression.target.tokens[1]), context);
      const staticOwnerParts = expression.target.tokens.slice(3)
        .filter((token) => token.kind === 'identifier')
        .map((token) => token.text);
      const staticOwner = resolveClassInternalNameFromParts(staticOwnerParts, context);
      const staticCall = staticOwner ? lowerKnownStaticMethodCall({
        ...expression,
        target: staticOwnerParts.reduce((node, part) => (node
          ? { kind: 'FieldAccessExpression', target: node, name: part }
          : { kind: 'Identifier', name: part }), null),
      }, context) : null;
      if (targetDescriptor && staticCall) {
        return {
          kind: 'CastValue',
          type: targetDescriptor,
          fromType: staticCall.type,
          value: staticCall,
        };
      }
      const receiver = lowerTokenExpressionToJavaIrValue(expression.target.tokens.slice(3), context);
      const call = receiver ? lowerInstanceMethodCall(expression, context, receiver) : null;
      if (targetDescriptor && call) {
        return {
          kind: 'CastValue',
          type: targetDescriptor,
          fromType: call.type,
          value: call,
        };
      }
    }
  }
  const leadingConcatMethodChain = lowerLeadingConcatMethodChain(expression, context);
  if (leadingConcatMethodChain) return leadingConcatMethodChain;
  if (expression && expression.kind === 'MethodInvocationExpression' && !expression.target && context.methodByName.has(expression.name)) {
    return lowerSameClassMethodCall(expression, context);
  }
  if (expression && expression.kind === 'MethodInvocationExpression' && !expression.target) {
    const inherited = lowerInheritedInstanceMethodCall(expression, context);
    if (inherited) return inherited;
  }
  if (expression && expression.kind === 'MethodInvocationExpression' && expression.target) {
    const instanceCall = lowerInstanceMethodCall(expression, context);
    if (instanceCall) return instanceCall;
    const call = lowerKnownStaticMethodCall(expression, context)
      || lowerStaticUserMethodCall(expression, context)
      || lowerStaticWrapperMethodCall(expression, context);
    if (call) return call;
  }
  return null;
}

function isDuplicateUninitializedObjectAssignmentArtifact(tokens) {
  if (!Array.isArray(tokens)) return false;
  const assignIndex = findTopLevelOperator(tokens, ['=']);
  if (assignIndex <= 0) return false;
  if (!tokens.slice(0, assignIndex).some((token) => tokenText(token) === '[')) return false;
  const incompleteAllocations = [];
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (tokenText(tokens[index]) !== 'new' || tokens[index + 1].kind !== 'identifier') continue;
    if (index + 2 < tokens.length && tokenText(tokens[index + 2]) === '(') continue;
    incompleteAllocations.push({ index, typeName: tokens[index + 1].text });
  }
  return incompleteAllocations.length === 2
    && incompleteAllocations[0].index < assignIndex
    && incompleteAllocations[1].index > assignIndex
    && incompleteAllocations[0].typeName === incompleteAllocations[1].typeName;
}

function lowerDecompilerConstructorInvocation(expression, context) {
  if (!expression || expression.kind !== 'MethodInvocationExpression' || !expression.target) return null;
  let target = expression.target;
  while (target && target.kind === 'ParenthesizedExpression') target = target.expression;
  if (!target || target.kind !== 'CastExpression') return null;
  let descriptor = null;
  try { descriptor = typeDescriptor(target.castType, context); } catch (_) {}
  const owner = internalNameFromDescriptor(descriptor);
  if (!owner || expression.name !== owner.split('/').pop().split('$').pop()) return null;
  const rawArgs = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  if (!rawArgs.every(Boolean)) return null;
  const method = methodDescriptorForConstructorCall(owner, rawArgs, context);
  const parameters = method.parameterDescriptors || parameterDescriptorsFromMethodDescriptor(method.descriptor) || [];
  const args = rawArgs.map((rawArg, index) => {
    const parameter = parameters[index] || rawArg.type;
    const coerced = coerceValueToDescriptor(rawArg, parameter);
    const targetIsReference = typeof parameter === 'string' && (parameter.startsWith('L') || parameter.startsWith('['));
    const sourceIsReference = coerced && typeof coerced.fromType === 'string'
      && (coerced.fromType.startsWith('L') || coerced.fromType.startsWith('['));
    const invalidCast = coerced && coerced.kind === 'CastValue' && targetIsReference !== sourceIsReference;
    if (coerced && !invalidCast) return coerced;
    if (targetIsReference) {
      return { kind: 'LiteralValue', type: parameter, literalKind: 'null', value: null, raw: 'null' };
    }
    return {
      kind: 'LiteralValue',
      type: parameter,
      literalKind: parameter === 'Z' ? 'boolean' : 'number',
      value: parameter === 'Z' ? false : '0',
      raw: parameter === 'Z' ? 'false' : '0',
    };
  });
  return {
    kind: 'NewObjectValue',
    type: `L${owner};`,
    owner,
    descriptor: method.descriptor,
    args,
    meta: { recoveredDecompilerConstructorInvocation: true },
  };
}

function coerceValueToDescriptor(value, descriptor) {
  if (!value || !descriptor || value.type === descriptor) return value;
  if ((value.kind === 'FieldValue' || value.kind === 'StaticFieldValue')
      && value.descriptor === 'Ljava/lang/Object;'
      && typeof descriptor === 'string') {
    return { ...value, type: descriptor, descriptor };
  }
  if (value.kind === 'ConditionalValue') {
    const consequent = coerceValueToDescriptor(value.consequent, descriptor);
    const alternate = coerceValueToDescriptor(value.alternate, descriptor);
    if (!consequent || !alternate) return null;
    return {
      ...value,
      type: descriptor,
      consequent,
      alternate,
    };
  }
  if (value.kind === 'ArrayInitializerValue' && descriptor.startsWith('[')) {
    const component = arrayComponentDescriptor(descriptor);
    return {
      ...value,
      type: descriptor,
      elements: (value.elements || []).map((element) => coerceValueToDescriptor(element, component)),
    };
  }
  if (value.kind === 'LiteralValue' && value.literalKind === 'number' && ['I', 'J', 'F', 'D'].includes(descriptor)) {
    return { ...value, type: descriptor };
  }
  if (value.literalKind === 'null' && (descriptor.startsWith('L') || descriptor.startsWith('['))) {
    return { ...value, type: descriptor };
  }
  if (['I', 'J', 'F', 'D', 'B', 'S', 'C'].includes(value.type) && ['I', 'J', 'F', 'D', 'B', 'S', 'C'].includes(descriptor)) {
    return {
      kind: 'CastValue',
      type: descriptor,
      fromType: value.type,
      value,
    };
  }
  const wrapper = wrapperDescriptorForPrimitive(value.type);
  if (wrapper && descriptor === 'Ljava/lang/Object;') {
    return coerceValueToDescriptor({
      kind: 'MethodCallValue',
      type: wrapper,
      owner: internalNameFromDescriptor(wrapper),
      name: 'valueOf',
      descriptor: `(${value.type})${wrapper}`,
      invokeKind: 'static',
      args: [value],
    }, descriptor);
  }
  if (wrapper && descriptor === wrapper) {
    return {
      kind: 'MethodCallValue',
      type: wrapper,
      owner: internalNameFromDescriptor(wrapper),
      name: 'valueOf',
      descriptor: `(${value.type})${wrapper}`,
      invokeKind: 'static',
      args: [value],
    };
  }
  const primitive = primitiveDescriptorForWrapper(value.type);
  if (primitive && ['I', 'J', 'F', 'D', 'B', 'S', 'C', 'Z'].includes(descriptor)) {
    const unboxed = boxedPrimitiveValue(value);
    return primitive === descriptor ? unboxed : coerceValueToDescriptor(unboxed, descriptor);
  }
  const wrapperOwner = PRIMITIVE_WRAPPER_BY_DESCRIPTOR[descriptor];
  if (wrapperOwner && value.type === 'Ljava/lang/Object;') {
    return coerceValueToDescriptor({
      kind: 'CastValue',
      type: `L${wrapperOwner};`,
      fromType: value.type,
      value,
    }, descriptor);
  }
  if (typeof value.type === 'string' && typeof descriptor === 'string'
      && value.type.startsWith('L') && descriptor.startsWith('L')) {
    return {
      kind: 'CastValue',
      type: descriptor,
      fromType: value.type,
      value,
    };
  }
  if (typeof value.type === 'string' && typeof descriptor === 'string'
      && (value.type.startsWith('L') || value.type.startsWith('['))
      && (descriptor.startsWith('L') || descriptor.startsWith('['))) {
    if (descriptor.startsWith('[') && value.type.startsWith('L')) return null;
    return {
      kind: 'CastValue',
      type: descriptor,
      fromType: value.type,
      value,
    };
  }
  return value;
}

function createJavaIrDocument(classes = [], options = {}) {
  const document = {
    schema: JAVA_IR_SCHEMA_ID,
    version: JAVA_IR_SCHEMA_VERSION,
    astSchema: options.astSchema || ast.AST_SCHEMA_ID,
    astVersion: options.astVersion || ast.AST_SCHEMA_VERSION,
    sourceLevel: options.sourceLevel || null,
    status: options.status || 'complete',
    classes,
    unsupported: options.unsupported || [],
  };
  if (options.meta !== undefined) document.meta = omitUndefined(options.meta);
  if (options.diagnostics !== undefined) document.diagnostics = options.diagnostics;
  return document;
}

function createJavaIrClass(fields = {}) {
  return {
    kind: 'JavaIrClass',
    name: fields.name,
    internalName: fields.internalName,
    packageName: fields.packageName || '',
    access: fields.access || [],
    superName: fields.superName || 'java/lang/Object',
    interfaces: fields.interfaces || [],
    fields: fields.fields || [],
    methods: fields.methods || [],
    sourceNodeKind: fields.sourceNodeKind || null,
    sourceNodeId: fields.sourceNodeId || null,
    meta: omitUndefined(fields.meta || {}),
  };
}

function createJavaIrField(fields = {}) {
  return {
    kind: 'JavaIrField',
    name: fields.name,
    descriptor: fields.descriptor,
    access: fields.access || [],
    sourceNodeId: fields.sourceNodeId || null,
    initializer: fields.initializer || null,
    meta: omitUndefined(fields.meta || {}),
  };
}

function createJavaIrMethod(fields = {}) {
  return {
    kind: 'JavaIrMethod',
    name: fields.name,
    descriptor: fields.descriptor,
    access: fields.access || [],
    parameters: fields.parameters || [],
    locals: fields.locals || [],
    blocks: fields.blocks || [],
    entryBlockId: fields.entryBlockId || null,
    exitBlockId: fields.exitBlockId || null,
    sourceNodeKind: fields.sourceNodeKind || null,
    sourceNodeId: fields.sourceNodeId || null,
    meta: omitUndefined(fields.meta || {}),
  };
}

function createJavaIrLocal(id, fields = {}) {
  return {
    id,
    name: fields.name || id,
    descriptor: fields.descriptor || 'Ljava/lang/Object;',
    slotHint: fields.slotHint === undefined ? null : fields.slotHint,
    sourceNodeId: fields.sourceNodeId || null,
    meta: omitUndefined(fields.meta || {}),
  };
}

function createJavaIrBlock(id, fields = {}) {
  return {
    id,
    kind: fields.kind || 'BasicBlock',
    ops: fields.ops || [],
    terminator: fields.terminator || null,
    sourceNodeId: fields.sourceNodeId || null,
    meta: omitUndefined(fields.meta || {}),
  };
}

function createJavaIrOp(op, fields = {}) {
  return omitUndefined({
    op,
    target: fields.target,
    type: fields.type,
    condition: fields.condition,
    thenOps: fields.thenOps,
    elseOps: fields.elseOps,
    tryOps: fields.tryOps,
    catches: fields.catches,
    finallyOps: fields.finallyOps,
    bodyOps: fields.bodyOps,
    updateOps: fields.updateOps,
    groups: fields.groups,
    label: fields.label,
    value: fields.value,
    left: fields.left,
    right: fields.right,
    operator: fields.operator,
    owner: fields.owner,
    name: fields.name,
    descriptor: fields.descriptor,
    invokeKind: fields.invokeKind,
    args: fields.args,
    sourceNodeKind: fields.sourceNodeKind,
    sourceNodeId: fields.sourceNodeId,
    text: fields.text,
    meta: fields.meta,
  });
}

function fieldValueForContext(field, context) {
  const owner = field.owner || context.classInternalName;
  if (field.isStatic) {
    return {
      kind: 'StaticFieldValue',
      type: field.descriptor,
      owner,
      name: field.name,
      descriptor: field.descriptor,
    };
  }
  return {
    kind: 'FieldValue',
    type: field.descriptor,
    owner,
    name: field.name,
    descriptor: field.descriptor,
    receiver: {
      kind: 'LocalValue',
      type: `L${context.classInternalName};`,
      local: 'param:this',
      name: 'this',
    },
  };
}

function javaIrReturn(value = null) {
  return { kind: 'Return', value };
}

function javaIrGoto(target) {
  return { kind: 'Goto', target };
}

function javaIrUnsupported(reason, fields = {}) {
  return createJavaIrOp('unsupported', {
    text: reason,
    sourceNodeKind: fields.sourceNodeKind,
    sourceNodeId: fields.sourceNodeId,
    meta: fields.meta,
  });
}

function isJavaIrDocument(document) {
  return isPlainObject(document) && document.schema === JAVA_IR_SCHEMA_ID && document.version === JAVA_IR_SCHEMA_VERSION;
}

function validateJavaIrDocument(document) {
  if (!isJavaIrDocument(document)) {
    throw new TypeError(`Java IR document schema must be ${JAVA_IR_SCHEMA_ID} version ${JAVA_IR_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(document.classes)) {
    throw new TypeError('Java IR document classes must be an array');
  }
  for (const [classIndex, classIr] of document.classes.entries()) {
    assertString(classIr.kind, `classes[${classIndex}].kind`);
    if (classIr.kind !== 'JavaIrClass') {
      throw new TypeError(`classes[${classIndex}].kind must be JavaIrClass`);
    }
    assertString(classIr.name, `classes[${classIndex}].name`);
    assertString(classIr.internalName, `classes[${classIndex}].internalName`);
    if (!Array.isArray(classIr.fields) || !Array.isArray(classIr.methods)) {
      throw new TypeError(`classes[${classIndex}] fields and methods must be arrays`);
    }
    for (const [methodIndex, method] of classIr.methods.entries()) {
      if (method.kind !== 'JavaIrMethod') {
        throw new TypeError(`classes[${classIndex}].methods[${methodIndex}].kind must be JavaIrMethod`);
      }
      assertString(method.name, `classes[${classIndex}].methods[${methodIndex}].name`);
      assertString(method.descriptor, `classes[${classIndex}].methods[${methodIndex}].descriptor`);
      if (!Array.isArray(method.blocks)) {
        throw new TypeError(`classes[${classIndex}].methods[${methodIndex}].blocks must be an array`);
      }
    }
  }
  assertJsonValue(document);
  return document;
}

function toJavaIrJson(document, options = {}) {
  if (options.validate !== false) validateJavaIrDocument(document);
  return stableJsonValue(document);
}

function serializeJavaIr(document, options = {}) {
  const space = Object.prototype.hasOwnProperty.call(options, 'space') ? options.space : 2;
  return JSON.stringify(toJavaIrJson(document, options), null, space);
}

function deserializeJavaIr(serialized, options = {}) {
  const value = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  if (options.validate !== false) validateJavaIrDocument(value);
  return value;
}

function cloneJavaIr(document, options = {}) {
  return deserializeJavaIr(serializeJavaIr(document, options), options);
}

function attachJavaIrDocument(astDocument, irDocument, options = {}) {
  if (options.validate !== false) validateJavaIrDocument(irDocument);
  if (!isPlainObject(astDocument.meta)) astDocument.meta = {};
  astDocument.meta[JAVA_IR_AST_META_KEY] = cloneJsonValue(irDocument);
  return astDocument;
}

function getAttachedJavaIrDocument(astDocument) {
  const ir = astDocument && astDocument.meta && astDocument.meta[JAVA_IR_AST_META_KEY];
  return ir ? cloneJavaIr(ir) : null;
}

function detachJavaIrDocument(astDocument) {
  if (astDocument && astDocument.meta) {
    delete astDocument.meta[JAVA_IR_AST_META_KEY];
  }
  return astDocument;
}

function localSlotWidth(descriptor) {
  return descriptor === 'J' || descriptor === 'D' ? 2 : 1;
}

function declareContextLocal(context, name, descriptor, sourceNodeId = null, meta = {}) {
  if (context.localByName.has(name)) {
    return context.localByName.get(name);
  }
  const local = createJavaIrLocal(`local:${name}`, {
    name,
    descriptor,
    slotHint: context.nextSlot,
    sourceNodeId,
    meta,
  });
  context.nextSlot += localSlotWidth(descriptor);
  context.locals.push(local);
  context.localByName.set(name, local);
  return local;
}

function declareShadowingContextLocal(context, name, descriptor, sourceNodeId = null, meta = {}) {
  // Child statement contexts copy scalar counters but share the method locals
  // collection. Its length is therefore the stable method-wide identity source
  // for shadowing declarations (notably nested catches with the same name).
  const suffix = context.locals.length;
  context.nextLocalId = Math.max(context.nextLocalId || 0, suffix + 1);
  const local = createJavaIrLocal(`local:${name}$${suffix}`, {
    name,
    descriptor,
    slotHint: context.nextSlot,
    sourceNodeId,
    meta,
  });
  context.nextSlot += localSlotWidth(descriptor);
  context.locals.push(local);
  context.localByName.set(name, local);
  return local;
}

function opsEndAbruptly(ops) {
  const last = (ops || [])[ops.length - 1];
  return last && (last.op === 'return' || last.op === 'throw');
}

function stripAbruptCompletionOps(ops) {
  return (ops || []).filter((op) => op.op !== 'return' && op.op !== 'throw');
}

function integerSwitchCaseValue(label, context) {
  if (!label || label.labelKind !== 'case') return null;
  const value = lowerExpressionToJavaIrValue(label.expression, context);
  const coerced = coerceValueToDescriptor(value, 'I');
  return coerced && coerced.type === 'I' ? coerced : null;
}

function parseTryResourceDeclaration(resource, context) {
  if (!resource || resource.kind !== 'UnsupportedExpression' || !Array.isArray(resource.tokens)) return null;
  const tokens = resource.tokens;
  const assignIndex = findTopLevelOperator(tokens, ['=']);
  if (assignIndex < 2 || tokens[assignIndex - 1].kind !== 'identifier') return null;
  const name = tokens[assignIndex - 1].text;
  const typeTokens = tokens.slice(0, assignIndex - 1).filter((token) => !['final'].includes(tokenText(token)));
  if (typeTokens.length !== 1 || typeTokens[0].kind !== 'identifier') return null;
  const variableType = ast.classType(typeTokens[0].text);
  const descriptor = typeDescriptor(variableType, context);
  const value = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(tokens.slice(assignIndex + 1), context), descriptor);
  if (!value) return null;
  return { name, descriptor, value };
}

function localValue(local) {
  return {
    kind: 'LocalValue',
    type: local.descriptor,
    local: local.id,
    name: local.name,
  };
}

function nullValue(descriptor) {
  return {
    kind: 'LiteralValue',
    type: descriptor,
    literalKind: 'null',
    value: null,
    raw: 'null',
  };
}

function catchTypeDescriptors(parameterType, context) {
  const types = parameterType && parameterType.kind === 'UnionType'
    ? parameterType.alternatives || []
    : [parameterType];
  const descriptors = [];
  for (const type of types) {
    const descriptor = typeDescriptor(type, context);
    if (!descriptor.startsWith('L') || !descriptor.endsWith(';')) return null;
    descriptors.push(descriptor);
  }
  return descriptors;
}

function closeResourceInvokeOp(local) {
  return createJavaIrOp('invoke', {
    value: {
      kind: 'MethodCallValue',
      type: 'V',
      owner: internalNameFromDescriptor(local.descriptor),
      name: 'close',
      descriptor: '()V',
      invokeKind: 'virtual',
      receiver: localValue(local),
      args: [],
    },
    sourceNodeKind: 'TryStatement',
  });
}

function closeResourceWithSuppressionOp(local, primaryLocal, context) {
  const closeThrowable = declareShadowingContextLocal(context, '__closeThrowable', 'Ljava/lang/Throwable;', null, { resourceClose: true });
  return createJavaIrOp('if', {
    condition: {
      kind: 'CompareValue',
      type: 'Z',
      operator: '!=',
      left: localValue(local),
      right: nullValue(local.descriptor),
    },
    thenOps: [
      createJavaIrOp('if', {
        condition: {
          kind: 'CompareValue',
          type: 'Z',
          operator: '!=',
          left: localValue(primaryLocal),
          right: nullValue(primaryLocal.descriptor),
        },
        thenOps: [
          createJavaIrOp('tryCatch', {
            tryOps: [closeResourceInvokeOp(local)],
            catches: [{
              type: 'java/lang/Throwable',
              local: closeThrowable.id,
              name: closeThrowable.name,
              descriptor: closeThrowable.descriptor,
              bodyOps: [
                createJavaIrOp('invoke', {
                  value: {
                    kind: 'MethodCallValue',
                    type: 'V',
                    owner: 'java/lang/Throwable',
                    name: 'addSuppressed',
                    descriptor: '(Ljava/lang/Throwable;)V',
                    invokeKind: 'virtual',
                    receiver: localValue(primaryLocal),
                    args: [localValue(closeThrowable)],
                  },
                  sourceNodeKind: 'TryStatement',
                }),
              ],
            }],
            finallyOps: [],
            sourceNodeKind: 'TryStatement',
          }),
        ],
        elseOps: [closeResourceInvokeOp(local)],
        sourceNodeKind: 'TryStatement',
      }),
    ],
    elseOps: [],
    sourceNodeKind: 'TryStatement',
  });
}

function lowerTryResources(resources, context) {
  if (!resources) return { initOps: [], closeOps: [], primaryLocal: null };
  const resourceList = Array.isArray(resources)
    ? resources
    : (resources.kind === 'UnsupportedExpression' && Array.isArray(resources.tokens)
      ? splitTopLevelBySemicolon(resources.tokens).map((tokens) => ({ kind: 'UnsupportedExpression', tokens }))
      : [resources]);
  const locals = [];
  const initOps = [];
  const primaryLocal = declareShadowingContextLocal(context, '__primaryThrowable', 'Ljava/lang/Throwable;', null, { resourcePrimary: true });
  initOps.push(createJavaIrOp('declareLocal', {
    target: primaryLocal.id,
    type: primaryLocal.descriptor,
    name: primaryLocal.name,
    sourceNodeKind: 'TryStatement',
    meta: { slotHint: primaryLocal.slotHint, resourcePrimary: true },
  }));
  initOps.push(createJavaIrOp('assign', {
    target: primaryLocal.id,
    type: primaryLocal.descriptor,
    value: nullValue(primaryLocal.descriptor),
    sourceNodeKind: 'TryStatement',
  }));
  for (const resource of resourceList) {
    const parsed = parseTryResourceDeclaration(resource, context);
    if (!parsed) return null;
    const local = declareContextLocal(context, parsed.name, parsed.descriptor, null, { resource: true });
    initOps.push(createJavaIrOp('declareLocal', {
      target: local.id,
      type: parsed.descriptor,
      name: local.name,
      sourceNodeKind: 'TryStatement',
      meta: { slotHint: local.slotHint, hasInitializer: true, resource: true },
    }));
    initOps.push(createJavaIrOp('assign', {
      target: local.id,
      type: parsed.descriptor,
      value: parsed.value,
      sourceNodeKind: 'TryStatement',
    }));
    locals.push(local);
  }
  const closeOps = locals.slice().reverse().map((local) => closeResourceWithSuppressionOp(local, primaryLocal, context));
  return { initOps, closeOps, primaryLocal };
}

function localIncrementValue(local, operator) {
  return {
    kind: 'BinaryValue',
    type: local.descriptor,
    operator,
    left: {
      kind: 'LocalValue',
      type: local.descriptor,
      local: local.id,
      name: local.name,
    },
    right: {
      kind: 'LiteralValue',
      type: local.descriptor,
      literalKind: 'number',
      value: '1',
      raw: '1',
    },
  };
}

function isIterableDescriptor(descriptor) {
  return descriptor === 'Ljava/lang/Iterable;'
    || descriptor === 'Ljava/util/Collection;'
    || descriptor === 'Ljava/util/List;'
    || descriptor === 'Ljava/util/ArrayList;'
    || descriptor === 'Ljava/util/LinkedList;'
    || descriptor === 'Ljava/util/Set;'
    || descriptor === 'Ljava/util/HashSet;';
}

function numericOneValue(descriptor) {
  return {
    kind: 'LiteralValue',
    type: descriptor,
    literalKind: 'number',
    value: '1',
    raw: '1',
  };
}

function staticFieldStoreOp(field, value) {
  return createJavaIrOp('putStaticField', {
    owner: field.owner,
    name: field.name,
    descriptor: field.descriptor,
    value,
  });
}

function lowerTokenUpdateToJavaIrOps(tokens, context) {
  const normalized = trimParenTokens(tokens || []);
  if (normalized.length === 2
      && normalized[0].kind === 'identifier'
      && (tokenText(normalized[1]) === '++' || tokenText(normalized[1]) === '--')
      && context.localByName.has(normalized[0].text)) {
    const local = context.localByName.get(normalized[0].text);
    if (local.descriptor !== 'I') return null;
    return [createJavaIrOp('assign', {
      target: local.id,
      type: local.descriptor,
      value: localIncrementValue(local, tokenText(normalized[1]) === '++' ? '+' : '-'),
      sourceNodeKind: 'ForStatement',
    })];
  }
  if (normalized.length === 2
      && normalized[0].kind === 'identifier'
      && (tokenText(normalized[1]) === '++' || tokenText(normalized[1]) === '--')
      && context.fieldByName && context.fieldByName.has(normalized[0].text)) {
    const field = context.fieldByName.get(normalized[0].text);
    if (!field.isStatic || field.descriptor !== 'I') return null;
    return [staticFieldStoreOp({ ...field, owner: context.classInternalName }, {
      kind: 'BinaryValue',
      type: field.descriptor,
      operator: tokenText(normalized[1]) === '++' ? '+' : '-',
      left: fieldValueForContext(field, context),
      right: numericOneValue(field.descriptor),
    })];
  }
  if (normalized.length === 2
      && normalized[1].kind === 'identifier'
      && (tokenText(normalized[0]) === '++' || tokenText(normalized[0]) === '--')
      && context.localByName.has(normalized[1].text)) {
    const local = context.localByName.get(normalized[1].text);
    if (local.descriptor !== 'I') return null;
    return [createJavaIrOp('assign', {
      target: local.id,
      type: local.descriptor,
      value: localIncrementValue(local, tokenText(normalized[0]) === '++' ? '+' : '-'),
      sourceNodeKind: 'ForStatement',
    })];
  }
  const compoundIndex = findTopLevelOperator(normalized, ['+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);
  if (compoundIndex === 1 && normalized[0].kind === 'identifier' && context.localByName.has(normalized[0].text)) {
    const local = context.localByName.get(normalized[0].text);
    const right = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(normalized.slice(compoundIndex + 1), context), local.descriptor);
    if (!right) return null;
    const nextValue = compoundAssignmentValue({
      kind: 'LocalValue',
      type: local.descriptor,
      local: local.id,
      name: local.name,
    }, right, local.descriptor, tokenText(normalized[compoundIndex]));
    if (!nextValue) return null;
    return [createJavaIrOp('assign', {
      target: local.id,
      type: local.descriptor,
      value: nextValue,
      sourceNodeKind: 'ForStatement',
    })];
  }
  if (compoundIndex === 1 && normalized[0].kind === 'identifier' && context.fieldByName && context.fieldByName.has(normalized[0].text)) {
    const field = context.fieldByName.get(normalized[0].text);
    const right = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(normalized.slice(compoundIndex + 1), context), field.descriptor);
    if (!right) return null;
    const nextValue = compoundAssignmentValue(
      fieldValueForContext(field, context),
      right,
      field.descriptor,
      tokenText(normalized[compoundIndex]),
    );
    if (!nextValue) return null;
    if (field.isStatic) return [staticFieldStoreOp({ ...field, owner: context.classInternalName }, nextValue)];
    return [createJavaIrOp('putField', {
      owner: context.classInternalName,
      name: field.name,
      descriptor: field.descriptor,
      value: nextValue,
      args: [thisReceiverValue(context)],
      sourceNodeKind: 'ForStatement',
    })];
  }
  if (compoundIndex > 0) {
    let target = lowerTokenExpressionToJavaIrValue(normalized.slice(0, compoundIndex), context);
    const rawRight = lowerTokenExpressionToJavaIrValue(normalized.slice(compoundIndex + 1), context);
    let descriptor = target && (target.descriptor || target.type);
    if (target && descriptor === 'Ljava/lang/Object;' && rawRight && isNumericDescriptor(rawRight.type) && isUnknownRecoveredObjectValue(target)) {
      descriptor = promotedIntegralDescriptor(rawRight.type);
      target = { ...target, type: descriptor, descriptor };
    }
    const rightDescriptor = tokenText(normalized[compoundIndex]) === '>>='
      || tokenText(normalized[compoundIndex]) === '>>>='
      || tokenText(normalized[compoundIndex]) === '<<='
      ? 'I'
      : descriptor;
    const right = rightDescriptor ? coerceValueToDescriptor(rawRight, rightDescriptor) : null;
    if (target && right && target.kind === 'FieldValue') {
      const nextValue = compoundAssignmentValue(target, right, descriptor, tokenText(normalized[compoundIndex]));
      if (!nextValue) return null;
      return [createJavaIrOp('putField', {
        owner: target.owner,
        name: target.name,
        descriptor,
        value: nextValue,
        args: [target.receiver],
        sourceNodeKind: 'ForStatement',
      })];
    }
    if (target && right && target.kind === 'StaticFieldValue') {
      const nextValue = compoundAssignmentValue(target, right, descriptor, tokenText(normalized[compoundIndex]));
      if (!nextValue) return null;
      return [createJavaIrOp('putStaticField', {
        owner: target.owner,
        name: target.name,
        descriptor,
        value: nextValue,
        sourceNodeKind: 'ForStatement',
      })];
    }
  }
  const assignIndex = findTopLevelOperator(normalized, ['=']);
  if (assignIndex === 1 && normalized[0].kind === 'identifier' && context.localByName.has(normalized[0].text)) {
    const local = context.localByName.get(normalized[0].text);
    const value = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(normalized.slice(assignIndex + 1), context), local.descriptor);
    if (!value) return null;
    return [createJavaIrOp('assign', {
      target: local.id,
      type: local.descriptor,
      value,
      sourceNodeKind: 'ForStatement',
    })];
  }
  return null;
}

function lowerCompoundAssignmentMethodCall(expression, context) {
  if (!expression
      || expression.kind !== 'MethodInvocationExpression'
      || !expression.target
      || expression.target.kind !== 'UnsupportedExpression'
      || !Array.isArray(expression.target.tokens)) {
    return null;
  }
  const tokens = trimParenTokens(expression.target.tokens);
  const compoundIndex = findTopLevelOperator(tokens, ['+=', '-=']);
  if (compoundIndex !== 1 || tokens[0].kind !== 'identifier' || !context.localByName.has(tokens[0].text)) return null;
  const local = context.localByName.get(tokens[0].text);
  const receiverTokens = tokens.slice(compoundIndex + 1);
  const right = coerceValueToDescriptor(lowerInstanceMethodCall({
    ...expression,
    target: {
      kind: 'UnsupportedExpression',
      tokens: receiverTokens,
      text: tokenTextJoined(receiverTokens),
    },
  }, context), local.descriptor);
  if (!right) return null;
  return [createJavaIrOp('assign', {
    target: local.id,
    type: local.descriptor,
    value: {
      kind: 'BinaryValue',
      type: local.descriptor,
      operator: tokenText(tokens[compoundIndex]) === '+=' ? '+' : '-',
      left: localValue(local),
      right,
    },
    sourceNodeKind: 'ExpressionStatement',
    meta: { recoveredCompoundMethodAssignment: true },
  })];
}


function storeValueToTokenTargetOps(targetTokens, value, context, sourceNodeKind) {
  const normalizedTarget = trimParenTokens(targetTokens || []);
  if (normalizedTarget.length === 1
      && normalizedTarget[0].kind === 'identifier'
      && context.localByName.has(normalizedTarget[0].text)) {
    const local = context.localByName.get(normalizedTarget[0].text);
    const coerced = coerceValueToDescriptor(value, local.descriptor);
    if (!coerced) return null;
    return [createJavaIrOp('assign', {
      target: local.id,
      type: local.descriptor,
      value: coerced,
      sourceNodeKind,
    })];
  }
  const target = lowerTokenExpressionToJavaIrValue(normalizedTarget, context);
  const descriptor = target && (target.descriptor || target.type);
  const coerced = descriptor ? coerceValueToDescriptor(value, descriptor) : null;
  if (!target || !coerced) return null;
  if (target.kind === 'FieldValue') {
    return [createJavaIrOp('putField', {
      owner: target.owner,
      name: target.name,
      descriptor: target.descriptor,
      value: coerced,
      args: [target.receiver],
      sourceNodeKind,
    })];
  }
  if (target.kind === 'StaticFieldValue') {
    return [createJavaIrOp('putStaticField', {
      owner: target.owner,
      name: target.name,
      descriptor: target.descriptor,
      value: coerced,
      sourceNodeKind,
    })];
  }
  return null;
}

function lowerRecoveredAssignmentMethodInvocation(expression, context, sourceNodeKind) {
  if (!expression
      || expression.kind !== 'MethodInvocationExpression'
      || !expression.target
      || expression.target.kind !== 'UnsupportedExpression'
      || !Array.isArray(expression.target.tokens)) {
    return null;
  }
  const tokens = trimParenTokens(expression.target.tokens);
  const assignIndex = findTopLevelOperator(tokens, ['=']);
  if (assignIndex <= 0) return null;
  const targetTokens = tokens.slice(0, assignIndex);
  const receiverTokens = tokens.slice(assignIndex + 1);
  let value = null;
  if (receiverTokens.length > 0 && tokenText(receiverTokens[0]) === 'new') {
    value = lowerExpressionToJavaIrValue({
      ...expression,
      target: {
        kind: 'UnsupportedExpression',
        tokens: receiverTokens,
        text: tokenTextJoined(receiverTokens),
      },
    }, context);
  } else if (receiverTokens.length > 0) {
    const receiver = lowerTokenExpressionToJavaIrValue(receiverTokens, context);
    value = receiver ? lowerInstanceMethodCall(expression, context, receiver) : null;
  } else {
    value = lowerSameClassMethodCall({ ...expression, target: null }, context)
      || lowerInheritedInstanceMethodCall({ ...expression, target: null }, context);
  }
  return value ? storeValueToTokenTargetOps(targetTokens, value, context, sourceNodeKind) : null;
}

function lowerStructuredAssignmentMethodInvocation(expression, context, sourceNodeKind) {
  if (!expression
      || expression.kind !== 'MethodInvocationExpression'
      || !expression.target
      || expression.target.kind !== 'AssignmentExpression'
      || expression.target.operator !== '=') return null;
  const target = lowerExpressionToJavaIrValue(expression.target.left, context);
  if (!target) return null;
  const call = lowerInstanceMethodCall({ ...expression, target: expression.target.right }, context);
  const value = coerceValueToDescriptor(call, target.type);
  if (!value) return null;
  if (target.kind === 'LocalValue') {
    return [createJavaIrOp('assign', { target: target.local, type: target.type, value, sourceNodeKind,
      meta: { recoveredStructuredMethodCallAssignment: true } })];
  }
  if (target.kind === 'FieldValue') {
    return [createJavaIrOp('putField', { owner: target.owner, name: target.name, descriptor: target.descriptor,
      value, args: [target.receiver], sourceNodeKind, meta: { recoveredStructuredMethodCallAssignment: true } })];
  }
  if (target.kind === 'StaticFieldValue') {
    return [createJavaIrOp('putStaticField', { owner: target.owner, name: target.name, descriptor: target.descriptor,
      value, sourceNodeKind, meta: { recoveredStructuredMethodCallAssignment: true } })];
  }
  return null;
}

function lowerStatementToJavaIrOps(statement, context) {
  if (!statement) return [];
  if (statement.kind === 'BlockStatement') {
    return (statement.statements || []).flatMap((child) => lowerStatementToJavaIrOps(child, context));
  }
  if (statement.kind === 'UnsupportedStatement' && statement.reason === 'local-type-declaration') {
    const ops = lowerLocalClassDeclaration(statement, context);
    if (ops) return ops;
  }
  if (statement.kind === 'LabeledStatement') {
    const bodyOps = lowerStatementToJavaIrOps(statement.statement, {
      ...context,
      pendingStatementLabel: null,
    });
    if (bodyOps.length === 1 && ['loop', 'doLoop', 'switch'].includes(bodyOps[0].op)) {
      return [{ ...bodyOps[0], label: statement.label || null }];
    }
    return [createJavaIrOp('labeled', {
      label: statement.label || null,
      bodyOps,
      sourceNodeKind: statement.kind,
    })];
  }
  if (statement.kind === 'ReturnStatement') {
    const expectedReturnDescriptor = context.currentReturnDescriptor || 'V';
    const rawValue = statement.expression
      ? lowerExpressionToJavaIrValueAsDescriptor(statement.expression, context, expectedReturnDescriptor)
      : null;
    const returnValue = statement.expression && expectedReturnDescriptor !== 'V'
      ? coerceValueToDescriptor(rawValue, expectedReturnDescriptor)
      : rawValue;
    return [createJavaIrOp('return', {
      value: statement.expression ? returnValue || { kind: statement.expression.kind } : null,
      sourceNodeKind: statement.kind,
    })];
  }
  if (statement.kind === 'ThrowStatement') {
    const value = statement.expression ? lowerExpressionToJavaIrValue(statement.expression, context) : null;
    if (!value || typeof value.type !== 'string' || !value.type.startsWith('L')) {
      const expression = statement.expression;
      const expressionName = expression && (expression.name || (expression.classType && expression.classType.name));
      const expressionShape = expression
        ? `${expression.kind}${expressionName ? `(${expressionName})` : ''}`
        : 'null';
      return [javaIrUnsupported(`unsupported throw expression method=${context.currentMethodName || '<unknown>'} expression=${expressionShape} value=${value ? `${value.kind}:${value.type}` : 'null'}`, {
        sourceNodeKind: expression && expression.kind,
      })];
    }
    return [createJavaIrOp('throw', {
      value,
      sourceNodeKind: statement.kind,
    })];
  }
  if (statement.kind === 'BreakStatement') {
    return [createJavaIrOp('break', {
      label: statement.label || null,
      sourceNodeKind: statement.kind,
    })];
  }
  if (statement.kind === 'ContinueStatement') {
    return [createJavaIrOp('continue', {
      label: statement.label || null,
      sourceNodeKind: statement.kind,
    })];
  }
  if (statement.kind === 'SynchronizedStatement') {
    const lock = lowerExpressionToJavaIrValue(statement.expression, context);
    if (!lock || typeof lock.type !== 'string' || !(lock.type.startsWith('L') || lock.type.startsWith('['))) {
      return [javaIrUnsupported('unsupported synchronized expression', { sourceNodeKind: statement.expression && statement.expression.kind })];
    }
    return [createJavaIrOp('synchronized', {
      value: lock,
      bodyOps: lowerStatementToJavaIrOps(statement.body, context),
      sourceNodeKind: statement.kind,
    })];
  }
  if (statement.kind === 'IfStatement') {
    const condition = lowerExpressionToJavaIrValue(statement.condition, context);
    if (!condition || condition.type !== 'Z') {
      const describeNode = (node) => {
        if (!node) return 'null';
        const detail = node.name || node.raw || node.operator || '';
        return `${node.kind}${detail ? `(${detail})` : ''}`;
      };
      const conditionShape = statement.condition
        ? `${describeNode(statement.condition)}[left=${describeNode(statement.condition.left)},right=${describeNode(statement.condition.right)}]`
        : 'null';
      return [javaIrUnsupported(`unsupported if condition method=${context.currentMethodName || '<unknown>'} condition=${conditionShape} value=${condition ? `${condition.kind}:${condition.type}` : 'null'}`, { sourceNodeKind: statement.condition && statement.condition.kind })];
    }
    return [createJavaIrOp('if', {
      condition,
      thenOps: lowerStatementToJavaIrOps(statement.consequent, context),
      elseOps: statement.alternate ? lowerStatementToJavaIrOps(statement.alternate, context) : [],
      sourceNodeKind: statement.kind,
    })];
  }
  if (statement.kind === 'WhileStatement') {
    const condition = lowerExpressionToJavaIrValue(statement.condition, context);
    if (!condition || condition.type !== 'Z') {
      return [javaIrUnsupported('unsupported while condition', { sourceNodeKind: statement.condition && statement.condition.kind })];
    }
    return [createJavaIrOp('loop', {
      label: context.pendingStatementLabel || null,
      condition,
      bodyOps: lowerStatementToJavaIrOps(statement.body, { ...context, pendingStatementLabel: null }),
      updateOps: [],
      sourceNodeKind: statement.kind,
    })];
  }
  if (statement.kind === 'DoWhileStatement') {
    const condition = lowerExpressionToJavaIrValue(statement.condition, context);
    if (!condition || condition.type !== 'Z') {
      return [javaIrUnsupported('unsupported do while condition', { sourceNodeKind: statement.condition && statement.condition.kind })];
    }
    return [createJavaIrOp('doLoop', {
      label: context.pendingStatementLabel || null,
      condition,
      bodyOps: lowerStatementToJavaIrOps(statement.body, { ...context, pendingStatementLabel: null }),
      sourceNodeKind: statement.kind,
    })];
  }
  if (statement.kind === 'ForStatement') {
    let conditionNode = statement.condition;
    let updateNode = statement.update;
    if (!updateNode
        && conditionNode
        && conditionNode.kind === 'UnsupportedExpression'
        && Array.isArray(conditionNode.tokens)) {
      const headerParts = splitTopLevelByToken(conditionNode.tokens, ';');
      if (headerParts.length >= 2) {
        conditionNode = headerParts[0].length ? { ...conditionNode, tokens: headerParts[0], text: tokenTextJoined(headerParts[0]) } : null;
        updateNode = headerParts[1].length ? { ...conditionNode, tokens: headerParts[1], text: tokenTextJoined(headerParts[1]) } : null;
      }
    }
    const initOps = !statement.initializer ? [] : (
      statement.initializer.kind === 'LocalVariableDeclarationStatement'
        ? lowerStatementToJavaIrOps(statement.initializer, context)
        : statement.initializer.kind === 'UnsupportedExpression' && Array.isArray(statement.initializer.tokens)
          ? lowerTokenUpdateToJavaIrOps(statement.initializer.tokens, context)
          : lowerStatementToJavaIrOps({ kind: 'ExpressionStatement', expression: statement.initializer }, context)
    );
    const condition = conditionNode
      ? lowerExpressionToJavaIrValue(conditionNode, context)
      : { kind: 'LiteralValue', type: 'Z', literalKind: 'boolean', value: true, raw: 'true' };
    const updateOps = !updateNode ? [] : (
      updateNode.kind === 'UnsupportedExpression' && Array.isArray(updateNode.tokens)
        ? lowerTokenUpdateToJavaIrOps(updateNode.tokens, context)
        : lowerStatementToJavaIrOps({ kind: 'ExpressionStatement', expression: updateNode }, context)
    );
    if (!initOps || !condition || condition.type !== 'Z' || !updateOps) {
      return [javaIrUnsupported('unsupported for loop', { sourceNodeKind: statement.kind })];
    }
    return initOps.concat(createJavaIrOp('loop', {
      label: context.pendingStatementLabel || null,
      condition,
      bodyOps: lowerStatementToJavaIrOps(statement.body, { ...context, pendingStatementLabel: null }),
      updateOps,
      sourceNodeKind: statement.kind,
    }));
  }
  if (statement.kind === 'SwitchStatement') {
    const rawValue = lowerExpressionToJavaIrValue(statement.expression, context);
    if (rawValue && typeof rawValue.type === 'string' && rawValue.type.startsWith('L')) {
      return lowerEnumSwitchToJavaIrOps(statement, rawValue, context);
    }
    // JVM integer switch instructions consume an int stack value. Java permits
    // byte, short, and char selectors as well, all of which are widened here.
    const value = coerceValueToDescriptor(rawValue, 'I');
    if (!value || value.type !== 'I') {
      return [javaIrUnsupported('unsupported switch expression', { sourceNodeKind: statement.expression && statement.expression.kind })];
    }
    const groups = [];
    for (const group of statement.groups || []) {
      const caseValues = [];
      let isDefault = false;
      for (const label of group.labels || []) {
        if (label.labelKind === 'default') {
          isDefault = true;
        } else {
          const caseValue = integerSwitchCaseValue(label, context);
          if (!caseValue) {
            return [javaIrUnsupported('unsupported switch case label', { sourceNodeKind: label.expression && label.expression.kind })];
          }
          caseValues.push(caseValue);
        }
      }
      groups.push({
        caseValues,
        isDefault,
        bodyOps: (group.statements || []).flatMap((child) => lowerStatementToJavaIrOps(child, context)),
      });
    }
    return [createJavaIrOp('switch', {
      value,
      groups,
      sourceNodeKind: statement.kind,
    })];
  }
  if (statement.kind === 'EnhancedForStatement') {
    if (!statement.parameter || !statement.parameter.name || !statement.parameter.parameterType) {
      return [javaIrUnsupported('unsupported enhanced for parameter', { sourceNodeKind: statement.kind })];
    }
    const iterable = lowerExpressionToJavaIrValue(statement.iterable, context);
    if (!iterable || typeof iterable.type !== 'string') {
      return [javaIrUnsupported('unsupported enhanced for iterable', { sourceNodeKind: statement.iterable && statement.iterable.kind })];
    }
    if (!iterable.type.startsWith('[') && isIterableDescriptor(iterable.type)) {
      const parameterDescriptor = typeDescriptor(statement.parameter.parameterType, context);
      const suffix = context.nextLocalId || 0;
      const iterableOwner = internalNameFromDescriptor(iterable.type);
      const iteratorLocal = declareShadowingContextLocal(context, `__foreach_iterator${suffix}`, 'Ljava/util/Iterator;', null, { enhancedFor: true });
      const previousLocal = context.localByName.get(statement.parameter.name);
      const itemLocal = declareShadowingContextLocal(context, statement.parameter.name, parameterDescriptor, null, { enhancedFor: true });
      const nextValue = coerceValueToDescriptor({
        kind: 'MethodCallValue',
        type: 'Ljava/lang/Object;',
        owner: 'java/util/Iterator',
        name: 'next',
        descriptor: '()Ljava/lang/Object;',
        invokeKind: 'interface',
        receiver: localValue(iteratorLocal),
        args: [],
      }, parameterDescriptor);
      const bodyOps = lowerStatementToJavaIrOps(statement.body, context);
      if (previousLocal) context.localByName.set(statement.parameter.name, previousLocal);
      else context.localByName.delete(statement.parameter.name);
      return [
        createJavaIrOp('declareLocal', {
          target: iteratorLocal.id,
          type: iteratorLocal.descriptor,
          name: iteratorLocal.name,
          sourceNodeKind: statement.kind,
          meta: { slotHint: iteratorLocal.slotHint, enhancedFor: true },
        }),
        createJavaIrOp('assign', {
          target: iteratorLocal.id,
          type: iteratorLocal.descriptor,
          value: {
            kind: 'MethodCallValue',
            type: 'Ljava/util/Iterator;',
            owner: iterableOwner,
            name: 'iterator',
            descriptor: '()Ljava/util/Iterator;',
            invokeKind: 'interface',
            receiver: iterable,
            args: [],
          },
          sourceNodeKind: statement.kind,
        }),
        createJavaIrOp('declareLocal', {
          target: itemLocal.id,
          type: itemLocal.descriptor,
          name: itemLocal.name,
          sourceNodeKind: statement.kind,
          meta: { slotHint: itemLocal.slotHint, enhancedFor: true },
        }),
        createJavaIrOp('loop', {
          condition: {
            kind: 'MethodCallValue',
            type: 'Z',
            owner: 'java/util/Iterator',
            name: 'hasNext',
            descriptor: '()Z',
            invokeKind: 'interface',
            receiver: localValue(iteratorLocal),
            args: [],
          },
          bodyOps: [
            createJavaIrOp('assign', {
              target: itemLocal.id,
              type: itemLocal.descriptor,
              value: nextValue,
              sourceNodeKind: statement.kind,
            }),
          ].concat(bodyOps),
          updateOps: [],
          sourceNodeKind: statement.kind,
        }),
      ];
    }
    if (!iterable.type.startsWith('[')) {
      return [javaIrUnsupported('unsupported enhanced for iterable', { sourceNodeKind: statement.iterable && statement.iterable.kind })];
    }
    const component = arrayComponentDescriptor(iterable.type);
    const parameterDescriptor = typeDescriptor(statement.parameter.parameterType, context);
    const elementValue = coerceValueToDescriptor({
      kind: 'ArrayLoadValue',
      type: component,
      array: {
        kind: 'LocalValue',
        type: iterable.type,
        local: null,
        name: null,
      },
      index: {
        kind: 'LocalValue',
        type: 'I',
        local: null,
        name: null,
      },
    }, parameterDescriptor);
    if (!component || !elementValue) {
      return [javaIrUnsupported('unsupported enhanced for element', { sourceNodeKind: statement.kind })];
    }
    const suffix = context.nextLocalId || 0;
    const arrayLocal = declareShadowingContextLocal(context, `__foreach_array${suffix}`, iterable.type, null, { enhancedFor: true });
    const indexLocal = declareShadowingContextLocal(context, `__foreach_index${suffix}`, 'I', null, { enhancedFor: true });
    const previousLocal = context.localByName.get(statement.parameter.name);
    const itemLocal = declareShadowingContextLocal(context, statement.parameter.name, parameterDescriptor, null, { enhancedFor: true });
    const itemArrayLoad = coerceValueToDescriptor({
      kind: 'ArrayLoadValue',
      type: component,
      array: {
        kind: 'LocalValue',
        type: arrayLocal.descriptor,
        local: arrayLocal.id,
        name: arrayLocal.name,
      },
      index: {
        kind: 'LocalValue',
        type: indexLocal.descriptor,
        local: indexLocal.id,
        name: indexLocal.name,
      },
    }, parameterDescriptor);
    const bodyOps = lowerStatementToJavaIrOps(statement.body, context);
    if (previousLocal) context.localByName.set(statement.parameter.name, previousLocal);
    else context.localByName.delete(statement.parameter.name);
    return [
      createJavaIrOp('declareLocal', {
        target: arrayLocal.id,
        type: arrayLocal.descriptor,
        name: arrayLocal.name,
        sourceNodeKind: statement.kind,
        meta: { slotHint: arrayLocal.slotHint, enhancedFor: true },
      }),
      createJavaIrOp('assign', {
        target: arrayLocal.id,
        type: arrayLocal.descriptor,
        value: iterable,
        sourceNodeKind: statement.kind,
      }),
      createJavaIrOp('declareLocal', {
        target: indexLocal.id,
        type: indexLocal.descriptor,
        name: indexLocal.name,
        sourceNodeKind: statement.kind,
        meta: { slotHint: indexLocal.slotHint, enhancedFor: true },
      }),
      createJavaIrOp('assign', {
        target: indexLocal.id,
        type: indexLocal.descriptor,
        value: {
          kind: 'LiteralValue',
          type: 'I',
          literalKind: 'number',
          value: '0',
          raw: '0',
        },
        sourceNodeKind: statement.kind,
      }),
      createJavaIrOp('declareLocal', {
        target: itemLocal.id,
        type: itemLocal.descriptor,
        name: itemLocal.name,
        sourceNodeKind: statement.kind,
        meta: { slotHint: itemLocal.slotHint, enhancedFor: true },
      }),
      createJavaIrOp('loop', {
        condition: {
          kind: 'CompareValue',
          type: 'Z',
          operator: '<',
          left: {
            kind: 'LocalValue',
            type: indexLocal.descriptor,
            local: indexLocal.id,
            name: indexLocal.name,
          },
          right: {
            kind: 'ArrayLengthValue',
            type: 'I',
            array: {
              kind: 'LocalValue',
              type: arrayLocal.descriptor,
              local: arrayLocal.id,
              name: arrayLocal.name,
            },
          },
        },
        bodyOps: [
          createJavaIrOp('assign', {
            target: itemLocal.id,
            type: itemLocal.descriptor,
            value: itemArrayLoad,
            sourceNodeKind: statement.kind,
          }),
        ].concat(bodyOps),
        updateOps: [createJavaIrOp('assign', {
          target: indexLocal.id,
          type: indexLocal.descriptor,
          value: localIncrementValue(indexLocal, '+'),
          sourceNodeKind: statement.kind,
        })],
        sourceNodeKind: statement.kind,
      }),
    ];
  }
  if (statement.kind === 'TryStatement') {
    const resourceOps = lowerTryResources(statement.resources, context);
    if (!resourceOps) return [javaIrUnsupported('unsupported try resources', { sourceNodeKind: statement.kind })];
    const catches = [];
    const hasResources = resourceOps.closeOps.length > 0;
    const finallyOps = statement.finallyBlock ? lowerStatementToJavaIrOps(statement.finallyBlock, context) : [];
    const finallyOverridesCompletion = opsEndAbruptly(finallyOps);
    for (const clause of statement.catches || []) {
      if (!clause.parameter || !clause.parameter.name || !clause.parameter.parameterType) {
        return [javaIrUnsupported('unsupported catch parameter', { sourceNodeKind: clause.kind })];
      }
      const catchDescriptors = catchTypeDescriptors(clause.parameter.parameterType, context);
      if (!catchDescriptors || catchDescriptors.length === 0) {
        return [javaIrUnsupported('unsupported catch type', { sourceNodeKind: clause.parameter.parameterType.kind })];
      }
      const descriptor = clause.parameter.parameterType.kind === 'UnionType'
        ? 'Ljava/lang/Throwable;'
        : catchDescriptors[0];
      const previousLocal = context.localByName.get(clause.parameter.name);
      const local = declareShadowingContextLocal(context, clause.parameter.name, descriptor, null, { catch: true });
      const bodyOps = lowerStatementToJavaIrOps(clause.body, context);
      if (previousLocal) context.localByName.set(clause.parameter.name, previousLocal);
      else context.localByName.delete(clause.parameter.name);
      for (const catchDescriptor of catchDescriptors) {
        catches.push({
          type: catchDescriptor.slice(1, -1),
          local: local.id,
          name: local.name,
          descriptor,
          bodyOps: finallyOverridesCompletion ? stripAbruptCompletionOps(bodyOps) : bodyOps,
        });
      }
    }
    const loweredTryOps = lowerStatementToJavaIrOps(statement.block, context);
    const tryOps = finallyOverridesCompletion ? stripAbruptCompletionOps(loweredTryOps) : loweredTryOps;
    const resourcePrimaryCatch = hasResources && resourceOps.primaryLocal ? declareShadowingContextLocal(context, '__resourceThrowable', 'Ljava/lang/Throwable;', null, { resourcePrimaryCatch: true }) : null;
    const protectedTryOps = hasResources
      ? [createJavaIrOp('tryCatch', {
        tryOps,
        catches: [{
          type: 'java/lang/Throwable',
          local: resourcePrimaryCatch.id,
          name: resourcePrimaryCatch.name,
          descriptor: resourcePrimaryCatch.descriptor,
          bodyOps: [
            createJavaIrOp('assign', {
              target: resourceOps.primaryLocal.id,
              type: resourceOps.primaryLocal.descriptor,
              value: localValue(resourcePrimaryCatch),
              sourceNodeKind: statement.kind,
            }),
            createJavaIrOp('throw', {
              value: localValue(resourcePrimaryCatch),
              sourceNodeKind: statement.kind,
            }),
          ],
        }],
        finallyOps: resourceOps.closeOps,
        sourceNodeKind: statement.kind,
      })]
      : tryOps;
    if (catches.length === 0) {
      if (!statement.finallyBlock && !hasResources) {
        return [javaIrUnsupported('unsupported try without catch/finally', { sourceNodeKind: statement.kind })];
      }
      if (!statement.finallyBlock && hasResources) {
        return resourceOps.initOps.concat(protectedTryOps);
      }
    }
    return resourceOps.initOps.concat(createJavaIrOp('tryCatch', {
      tryOps: protectedTryOps,
      catches,
      finallyOps,
      sourceNodeKind: statement.kind,
    }));
  }
  if (statement.kind === 'ExpressionStatement') {
    const expression = statement.expression;
    if (expression && expression.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator)) {
      const target = lowerExpressionToJavaIrValue(expression.operand, context);
      const value = target && {
        kind: 'BinaryValue', type: target.type, operator: expression.operator === '++' ? '+' : '-',
        left: target, right: numericOneValue(target.type),
      };
      if (target && value && numericOneValue(target.type)) {
        if (target.kind === 'LocalValue') return [createJavaIrOp('assign', { target: target.local, type: target.type, value, sourceNodeKind: statement.kind })];
        if (target.kind === 'ArrayLoadValue') return [createJavaIrOp('arrayStore', { type: target.type, value, args: [target.array, target.index], sourceNodeKind: statement.kind })];
        if (target.kind === 'FieldValue') return [createJavaIrOp('putField', { owner: target.owner, name: target.name, descriptor: target.descriptor, value, args: [target.receiver], sourceNodeKind: statement.kind })];
        if (target.kind === 'StaticFieldValue') return [createJavaIrOp('putStaticField', { owner: target.owner, name: target.name, descriptor: target.descriptor, value, sourceNodeKind: statement.kind })];
      }
    }
    if (expression && expression.kind === 'AssignmentExpression') {
      const target = lowerExpressionToJavaIrValue(expression.left, context);
      const rawValue = expression.operator === '='
        ? (target ? lowerExpressionToJavaIrValueAsDescriptor(expression.right, context, target.type)
          : lowerExpressionToJavaIrValue(expression.right, context))
        : lowerExpressionToJavaIrValue({
          kind: 'BinaryExpression',
          operator: expression.operator.slice(0, -1),
          left: expression.left,
          right: expression.right,
        }, context);
      const value = target && coerceValueToDescriptor(rawValue, target.type);
      if (target && value) {
        if (target.kind === 'LocalValue') {
          return [createJavaIrOp('assign', { target: target.local, type: target.type, value, sourceNodeKind: statement.kind })];
        }
        if (target.kind === 'ArrayLoadValue') {
          return [createJavaIrOp('arrayStore', { type: target.type, value, args: [target.array, target.index], sourceNodeKind: statement.kind })];
        }
        if (target.kind === 'FieldValue') {
          return [createJavaIrOp('putField', { owner: target.owner, name: target.name, descriptor: target.descriptor, value, args: [target.receiver], sourceNodeKind: statement.kind })];
        }
        if (target.kind === 'StaticFieldValue') {
          return [createJavaIrOp('putStaticField', { owner: target.owner, name: target.name, descriptor: target.descriptor, value, sourceNodeKind: statement.kind })];
        }
      }
      const rightShape = expression.right
        ? `${expression.right.kind}${expression.right.operator ? `(${expression.right.operator})` : ''}${expression.right.name ? `(${expression.right.name},target=${expression.right.target ? expression.right.target.kind : 'implicit'})` : ''}`
        : 'null';
      const targetShape = target
        ? `${target.kind}${target.name ? `(${target.name})` : ''}`
        : `null(left=${expression.left ? `${expression.left.kind}${expression.left.name ? `(${expression.left.name})` : ''}` : 'null'})`;
      const methodShape = context.currentMethodName ? ` method=${context.currentMethodName}` : '';
      return [javaIrUnsupported(`unsupported structured assignment${methodShape} target=${targetShape} value=${rawValue ? rawValue.kind : 'null'} right=${rightShape}`, {
        sourceNodeKind: expression.kind,
      })];
    }
    if (expression && expression.kind === 'MethodInvocationExpression' && (expression.name === 'println' || expression.name === 'print')) {
      const targetParts = chainParts(expression.target);
      if (targetParts.join('.') === 'System.out') {
        const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
        if (args.every(Boolean)) {
          return [createJavaIrOp(expression.name, {
            owner: 'java/io/PrintStream',
            name: expression.name,
            args,
            sourceNodeKind: statement.kind,
          })];
        }
      }
    }
    if (expression && expression.kind === 'UnsupportedExpression' && Array.isArray(expression.tokens)) {
      const tokens = trimParenTokens(expression.tokens);
      if (isDuplicateUninitializedObjectAssignmentArtifact(tokens)) return [];
      const superConstructorInvoke = lowerSuperConstructorInvokeOp(tokens, context, statement.kind);
      if (superConstructorInvoke) return [superConstructorInvoke];
      const thisConstructorInvoke = lowerThisConstructorInvokeOp(tokens, context, statement.kind);
      if (thisConstructorInvoke) return [thisConstructorInvoke];
      const updateOps = lowerTokenUpdateToJavaIrOps(tokens, context);
      if (updateOps) return updateOps.map((op) => ({ ...op, sourceNodeKind: statement.kind }));
      const assignIndex = findTopLevelOperator(tokens, ['=']);
      if (assignIndex === 1
          && tokens[0].kind === 'identifier'
          && context.localByName.has(tokens[0].text)) {
        const local = context.localByName.get(tokens[0].text);
        const value = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(tokens.slice(assignIndex + 1), context), local.descriptor);
        if (value) {
          return [createJavaIrOp('assign', {
            target: local.id,
            type: local.descriptor,
            value,
            sourceNodeKind: statement.kind,
          })];
        }
      }
      if (assignIndex === 1
          && tokens[0].kind === 'identifier'
          && context.fieldByName
          && context.fieldByName.has(tokens[0].text)) {
        const field = context.fieldByName.get(tokens[0].text);
        const value = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(tokens.slice(assignIndex + 1), context), field.descriptor);
        if (value) {
          if (field.isStatic) {
            return [createJavaIrOp('putStaticField', {
              owner: context.classInternalName,
              name: field.name,
              descriptor: field.descriptor,
              value,
              sourceNodeKind: statement.kind,
            })];
          }
          return [createJavaIrOp('putField', {
            owner: context.classInternalName,
            name: field.name,
            descriptor: field.descriptor,
            value,
            args: [thisReceiverValue(context)],
            sourceNodeKind: statement.kind,
          })];
        }
      }
      if (assignIndex === 3
          && tokenText(tokens[0]) === 'this'
          && tokenText(tokens[1]) === '.'
          && tokens[2].kind === 'identifier'
          && context.fieldByName
          && context.fieldByName.has(tokens[2].text)) {
        const field = context.fieldByName.get(tokens[2].text);
        const value = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(tokens.slice(assignIndex + 1), context), field.descriptor);
        if (value) {
          return [createJavaIrOp('putField', {
            owner: context.classInternalName,
            name: field.name,
            descriptor: field.descriptor,
            value,
            args: [{
              kind: 'LocalValue',
              type: `L${context.classInternalName};`,
              local: 'param:this',
              name: 'this',
            }],
            sourceNodeKind: statement.kind,
          })];
        }
      }
      if (assignIndex > 0) {
        const target = lowerTokenExpressionToJavaIrValue(tokens.slice(0, assignIndex), context);
        if (target && target.kind === 'ArrayLoadValue') {
          const value = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(tokens.slice(assignIndex + 1), context), target.type);
          if (value) {
            return [createJavaIrOp('arrayStore', {
              type: target.type,
              value,
              args: [
                target.array,
                target.index,
              ],
              sourceNodeKind: statement.kind,
            })];
          }
        }
        if (target && target.kind === 'FieldValue') {
          const value = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(tokens.slice(assignIndex + 1), context), target.descriptor);
          if (value) {
            return [createJavaIrOp('putField', {
              owner: target.owner,
              name: target.name,
              descriptor: target.descriptor,
              value,
              args: [target.receiver],
              sourceNodeKind: statement.kind,
            })];
          }
        }
        if (target && target.kind === 'StaticFieldValue') {
          const value = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(tokens.slice(assignIndex + 1), context), target.descriptor);
          if (value) {
            return [createJavaIrOp('putStaticField', {
              owner: target.owner,
              name: target.name,
              descriptor: target.descriptor,
              value,
              sourceNodeKind: statement.kind,
            })];
          }
        }
      }
    }
    const structuredAssignmentMethodInvocation = lowerStructuredAssignmentMethodInvocation(expression, context, statement.kind);
    if (structuredAssignmentMethodInvocation) return structuredAssignmentMethodInvocation;
    const recoveredAssignmentMethodInvocation = lowerRecoveredAssignmentMethodInvocation(expression, context, statement.kind);
    if (recoveredAssignmentMethodInvocation) return recoveredAssignmentMethodInvocation;
    if (expression && expression.kind === 'MethodInvocationExpression'
        && expression.target
        && expression.target.kind === 'UnsupportedExpression'
        && Array.isArray(expression.target.tokens)) {
      const tokens = trimParenTokens(expression.target.tokens);
      const assignIndex = findTopLevelOperator(tokens, ['=']);
      if (assignIndex === 1
          && tokens[0].kind === 'identifier'
          && context.localByName.has(tokens[0].text)) {
        const receiver = lowerTokenExpressionToJavaIrValue(tokens.slice(assignIndex + 1), context);
        const call = receiver ? lowerInstanceMethodCall(expression, context, receiver) : null;
        const local = context.localByName.get(tokens[0].text);
        const value = coerceValueToDescriptor(call, local.descriptor);
        if (value) {
          return [createJavaIrOp('assign', {
            target: local.id,
            type: local.descriptor,
            value,
            sourceNodeKind: statement.kind,
            meta: { recoveredMethodCallAssignment: true },
          })];
        }
      }
    }
    const compoundMethodAssign = lowerCompoundAssignmentMethodCall(expression, context);
    if (compoundMethodAssign) return compoundMethodAssign;
    const recoveredConstructor = lowerDecompilerConstructorInvocation(expression, context);
    if (recoveredConstructor) {
      return [createJavaIrOp('invoke', {
        value: recoveredConstructor,
        sourceNodeKind: statement.kind,
        meta: { recoveredDecompilerConstructorInvocation: true },
      })];
    }
    const value = lowerExpressionToJavaIrValue(expression, context);
    if (value && (value.kind === 'MethodCallValue' || value.kind === 'NewObjectValue')) {
      return [createJavaIrOp('invoke', {
        value,
        sourceNodeKind: statement.kind,
      })];
    }
    const statementCall = lowerStatementOnlyMethodCall(expression, context);
    if (statementCall) {
      return [createJavaIrOp('invoke', {
        value: statementCall,
        sourceNodeKind: statement.kind,
        meta: { statementOnlyFallback: true },
      })];
    }
    return [createJavaIrOp('expression', {
      value: value || null,
      sourceNodeKind: statement.expression && statement.expression.kind,
      text: statement.expression && statement.expression.text
        ? statement.expression.text
        : `unsupported expression method=${context.currentMethodName || '<unknown>'} kind=${statement.expression ? statement.expression.kind : 'null'}${statement.expression && statement.expression.name ? ` name=${statement.expression.name}` : ''}${statement.expression && statement.expression.target ? ` target=${statement.expression.target.kind}` : ''} args=${statement.expression && Array.isArray(statement.expression.arguments) ? statement.expression.arguments.length : 0}`,
    })];
  }
  if (statement.kind === 'LocalVariableDeclarationStatement') {
    if (statement.variableType
        && statement.variableType.kind === 'UnsupportedType'
        && Array.isArray(statement.variableType.tokens)
        && (statement.declarators || []).length === 1
        && statement.declarators[0].initializer) {
      const declarator = statement.declarators[0];
      const targetTokens = statement.variableType.tokens.concat([
        { kind: 'identifier', text: declarator.name },
        { kind: 'symbol', text: ']' },
      ]);
      const target = lowerTokenExpressionToJavaIrValue(targetTokens, context);
      if (target && target.kind === 'ArrayLoadValue') {
        const value = coerceValueToDescriptor(lowerExpressionToJavaIrValue(declarator.initializer, context), target.type);
        if (value) {
          return [createJavaIrOp('arrayStore', {
            type: target.type,
            value,
            args: [
              target.array,
              target.index,
            ],
            sourceNodeKind: statement.kind,
          })];
        }
      }
    }
    const descriptor = typeDescriptor(statement.variableType, context);
    const signature = typeSignature(statement.variableType, context);
    return (statement.declarators || []).flatMap((declarator) => {
      const local = declareContextLocal(context, declarator.name, descriptor, null, { signature });
      const ops = [createJavaIrOp('declareLocal', {
        target: local.id,
        type: descriptor,
        name: local.name,
        sourceNodeKind: statement.kind,
        meta: { slotHint: local.slotHint, hasInitializer: Boolean(declarator.initializer), signature },
      })];
      if (declarator.initializer) {
        const loweredInitializer = lowerLambdaToJavaIrValue(declarator.initializer, descriptor, context)
          || lowerExpressionToJavaIrValueAsDescriptor(declarator.initializer, context, descriptor);
        const value = coerceValueToDescriptor(loweredInitializer, descriptor);
        if (!value) {
          ops.push(javaIrUnsupported(`unsupported local initializer for ${declarator.name}`, { sourceNodeKind: declarator.initializer.kind }));
        } else {
          ops.push(createJavaIrOp('assign', {
            target: local.id,
            type: descriptor,
            value,
            sourceNodeKind: statement.kind,
          }));
        }
      }
      return ops;
    });
  }
  return [javaIrUnsupported(`unsupported Java IR lowering for ${statement.kind}`, { sourceNodeKind: statement.kind })];
}

function isConstructorDelegationOp(op, context) {
  return op
    && op.op === 'invoke'
    && op.value
    && op.value.kind === 'MethodCallValue'
    && op.value.name === '<init>'
    && op.value.invokeKind === 'special'
    && (op.value.owner === context.classInternalName || op.value.owner === context.superName);
}

function implicitSuperConstructorOp(context) {
  const method = methodDescriptorForConstructorCall(context.superName || 'java/lang/Object', [], context);
  return createJavaIrOp('invoke', {
    value: {
      kind: 'MethodCallValue',
      type: 'V',
      owner: context.superName || 'java/lang/Object',
      name: '<init>',
      descriptor: method.descriptor,
      invokeKind: 'special',
      receiver: thisReceiverValue(context),
      args: [],
    },
    sourceNodeKind: 'ConstructorDeclaration',
  });
}

function enumSyntheticConstructorPrefixLocals() {
  return [
    createJavaIrLocal('param:$enum$name', {
      name: '$enum$name',
      descriptor: 'Ljava/lang/String;',
      slotHint: 1,
      meta: { synthetic: true, enumName: true },
    }),
    createJavaIrLocal('param:$enum$ordinal', {
      name: '$enum$ordinal',
      descriptor: 'I',
      slotHint: 2,
      meta: { synthetic: true, enumOrdinal: true },
    }),
  ];
}

function enumSuperConstructorOp(context) {
  return createJavaIrOp('invoke', {
    value: {
      kind: 'MethodCallValue',
      type: 'V',
      owner: 'java/lang/Enum',
      name: '<init>',
      descriptor: '(Ljava/lang/String;I)V',
      invokeKind: 'special',
      receiver: thisReceiverValue(context),
      args: [
        { kind: 'LocalValue', type: 'Ljava/lang/String;', local: 'param:$enum$name', name: '$enum$name' },
        { kind: 'LocalValue', type: 'I', local: 'param:$enum$ordinal', name: '$enum$ordinal' },
      ],
    },
    sourceNodeKind: 'ConstructorDeclaration',
    meta: { synthetic: true, enumSuper: true },
  });
}

function createEnumDefaultConstructor(classContext) {
  const thisLocal = createJavaIrLocal('param:this', {
    name: 'this',
    descriptor: `L${classContext.classInternalName};`,
    slotHint: 0,
  });
  const syntheticLocals = enumSyntheticConstructorPrefixLocals();
  const locals = [thisLocal].concat(syntheticLocals);
  const localByName = new Map([['this', thisLocal]]);
  for (const local of syntheticLocals) localByName.set(local.name, local);
  const context = {
    locals,
    localByName,
    nextSlot: 3,
    nextLocalId: 0,
    methodByName: classContext.methodByName,
    fieldByName: classContext.fieldByName,
    classInternalName: classContext.classInternalName,
    className: classContext.className,
    superName: 'java/lang/Enum',
    classBySimpleName: classContext.classBySimpleName,
    classMethodsByInternalName: classContext.classMethodsByInternalName,
    classMethodOverloadsByInternalName: classContext.classMethodOverloadsByInternalName,
    classFieldsByInternalName: classContext.classFieldsByInternalName,
    typeParameters: classContext.typeParameters,
    currentMethodIsStatic: false,
    syntheticClasses: classContext.syntheticClasses,
    allocateLambdaClassName: classContext.allocateLambdaClassName,
    constructorCaptureArgsByOwner: classContext.constructorCaptureArgsByOwner,
  };
  const block = createJavaIrBlock('entry', {
    kind: 'EntryBlock',
    ops: [enumSuperConstructorOp(context)],
    terminator: javaIrReturn(null),
  });
  return createJavaIrMethod({
    name: '<init>',
    descriptor: '(Ljava/lang/String;I)V',
    access: ['private'],
    parameters: syntheticLocals.map((local) => ({
      id: local.id,
      name: local.name,
      descriptor: local.descriptor,
      slotHint: local.slotHint,
      meta: local.meta,
    })),
    locals,
    blocks: [block],
    entryBlockId: 'entry',
    sourceNodeKind: 'EnumConstructorDeclaration',
    meta: { synthetic: true },
  });
}

function lowerEnumConstructorToJavaIr(method, classContext) {
  const typeParameters = buildTypeParameterErasureMap(method.typeParameters || [], classContext.typeParameters);
  const typeContext = { typeParameters, classBySimpleName: classContext.classBySimpleName };
  const thisLocal = createJavaIrLocal('param:this', {
    name: 'this',
    descriptor: `L${classContext.classInternalName};`,
    slotHint: 0,
  });
  const syntheticLocals = enumSyntheticConstructorPrefixLocals();
  const parameters = syntheticLocals.map((local) => ({
    id: local.id,
    name: local.name,
    descriptor: local.descriptor,
    slotHint: local.slotHint,
    meta: local.meta,
  }));
  const locals = [thisLocal].concat(syntheticLocals);
  const localByName = new Map([['this', thisLocal]]);
  for (const local of syntheticLocals) localByName.set(local.name, local);
  let slot = 3;
  const declaredDescriptors = [];
  for (const parameter of method.parameters || []) {
    const descriptor = formalParameterDescriptor(parameter, typeContext);
    const signature = formalParameterSignature(parameter, typeContext);
    const id = `param:${parameter.name}`;
    const local = createJavaIrLocal(id, { name: parameter.name, descriptor, slotHint: slot, meta: { signature } });
    parameters.push({ id, name: parameter.name, descriptor, slotHint: slot, meta: { signature } });
    locals.push(local);
    localByName.set(parameter.name, local);
    declaredDescriptors.push(descriptor);
    slot += descriptor === 'J' || descriptor === 'D' ? 2 : 1;
  }
  const context = {
    locals,
    localByName,
    nextSlot: slot,
    nextLocalId: 0,
    methodByName: classContext.methodByName,
    fieldByName: classContext.fieldByName,
    classInternalName: classContext.classInternalName,
    className: classContext.className,
    superName: 'java/lang/Enum',
    classBySimpleName: classContext.classBySimpleName,
    classMethodsByInternalName: classContext.classMethodsByInternalName,
    classMethodOverloadsByInternalName: classContext.classMethodOverloadsByInternalName,
    classFieldsByInternalName: classContext.classFieldsByInternalName,
    outerClassInternalName: classContext.outerClassInternalName,
    outerFieldByName: classContext.outerFieldByName,
    outerMethodByName: classContext.outerMethodByName,
    outerThisFieldName: classContext.outerThisFieldName,
    typeParameters,
    currentMethodIsStatic: false,
    syntheticClasses: classContext.syntheticClasses,
    allocateLambdaClassName: classContext.allocateLambdaClassName,
  };
  let ops = method.body && method.body.kind === 'BlockStatement'
    ? lowerStatementToJavaIrOps(method.body, context)
    : [javaIrUnsupported(`method body unavailable for ${method.name}`, { sourceNodeKind: method.kind })];
  if (!isConstructorDelegationOp(ops[0], context)) {
    ops = [enumSuperConstructorOp(context)].concat(ops);
  }
  const access = modifierNames(method.modifiers).filter((name) => name !== 'public' && name !== 'protected');
  if (!access.includes('private')) access.unshift('private');
  return createJavaIrMethod({
    name: '<init>',
    descriptor: `(Ljava/lang/String;I${declaredDescriptors.join('')})V`,
    access: dedupePreservingOrder(access),
    parameters,
    locals,
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock',
      ops,
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry',
    sourceNodeKind: method.kind,
    meta: {
      signature: `(Ljava/lang/String;I${(method.parameters || []).map((parameter) => formalParameterSignature(parameter, typeContext)).join('')})V`,
      annotations: annotationsMeta(method.annotations, { classBySimpleName: classContext.classBySimpleName }),
      enumConstructor: true,
    },
  });
}

function enumConstantArgumentValues(constant, context) {
  if (!constant || !constant.arguments) return [];
  const tokens = constant.arguments.tokens || [];
  if (tokens.length === 0) return [];
  return splitTopLevelByComma(tokens).map((part) => lowerTokenExpressionToJavaIrValue(part, context));
}

function createEnumClassInitializer(declaration, classContext) {
  const descriptor = `L${classContext.classInternalName};`;
  const ops = [];
  for (let index = 0; index < (declaration.constants || []).length; index += 1) {
    const constant = declaration.constants[index];
    const declaredArgs = enumConstantArgumentValues(constant, classContext);
    if (!declaredArgs.every(Boolean)) {
      ops.push(javaIrUnsupported(`unsupported enum constant arguments for ${constant.name}`, { sourceNodeKind: constant.kind }));
      continue;
    }
    const args = [
      {
        kind: 'LiteralValue',
        type: 'Ljava/lang/String;',
        literalKind: 'string',
        value: constant.name,
        raw: JSON.stringify(constant.name),
      },
      {
        kind: 'LiteralValue',
        type: 'I',
        literalKind: 'number',
        value: String(index),
        raw: String(index),
      },
    ].concat(declaredArgs);
    ops.push(staticFieldStoreOp({
      owner: classContext.classInternalName,
      name: constant.name,
      descriptor,
    }, {
      kind: 'NewObjectValue',
      type: descriptor,
      owner: classContext.classInternalName,
      descriptor: `(${args.map((arg) => arg.type).join('')})V`,
      args,
    }));
  }
  ops.push(staticFieldStoreOp({
    owner: classContext.classInternalName,
    name: '$VALUES',
    descriptor: `[${descriptor}`,
  }, {
    kind: 'ArrayInitializerValue',
    type: `[${descriptor}`,
    elements: (declaration.constants || []).map((constant) => ({
      kind: 'StaticFieldValue',
      type: descriptor,
      owner: classContext.classInternalName,
      name: constant.name,
      descriptor,
    })),
  }));
  return createJavaIrMethod({
    name: '<clinit>',
    descriptor: '()V',
    access: ['static'],
    parameters: [],
    locals: [],
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock',
      ops,
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry',
    sourceNodeKind: 'EnumClassInitializer',
    meta: { synthetic: true },
  });
}

function createEnumValuesMethod(classContext) {
  const descriptor = `L${classContext.classInternalName};`;
  return createJavaIrMethod({
    name: 'values',
    descriptor: `()[${descriptor}`,
    access: ['public', 'static'],
    parameters: [],
    locals: [],
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock',
      ops: [createJavaIrOp('return', {
        value: {
          kind: 'StaticFieldValue',
          type: `[${descriptor}`,
          owner: classContext.classInternalName,
          name: '$VALUES',
          descriptor: `[${descriptor}`,
        },
        sourceNodeKind: 'EnumValuesMethod',
      })],
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry',
    sourceNodeKind: 'EnumValuesMethod',
    meta: { synthetic: true },
  });
}

function createEnumValueOfMethod(classContext) {
  const descriptor = `L${classContext.classInternalName};`;
  const nameLocal = createJavaIrLocal('param:name', {
    name: 'name',
    descriptor: 'Ljava/lang/String;',
    slotHint: 0,
  });
  return createJavaIrMethod({
    name: 'valueOf',
    descriptor: `(Ljava/lang/String;)${descriptor}`,
    access: ['public', 'static'],
    parameters: [{ id: nameLocal.id, name: nameLocal.name, descriptor: nameLocal.descriptor, slotHint: nameLocal.slotHint }],
    locals: [nameLocal],
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock',
      ops: [createJavaIrOp('return', {
        value: {
          kind: 'CastValue',
          type: descriptor,
          fromType: 'Ljava/lang/Enum;',
          value: {
            kind: 'MethodCallValue',
            type: 'Ljava/lang/Enum;',
            owner: 'java/lang/Enum',
            name: 'valueOf',
            descriptor: '(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Enum;',
            invokeKind: 'static',
            args: [
              { kind: 'ClassLiteralValue', type: 'Ljava/lang/Class;', className: classContext.classInternalName },
              { kind: 'LocalValue', type: 'Ljava/lang/String;', local: nameLocal.id, name: nameLocal.name },
            ],
          },
        },
        sourceNodeKind: 'EnumValueOfMethod',
      })],
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry',
    sourceNodeKind: 'EnumValueOfMethod',
    meta: { synthetic: true },
  });
}

function stripBreakOps(ops) {
  return (ops || []).filter((op) => op.op !== 'break');
}

function enumCaseValue(label, enumDescriptor, context) {
  if (!label || label.labelKind !== 'case' || !enumDescriptor) return null;
  const owner = internalNameFromDescriptor(enumDescriptor);
  const fields = context.classFieldsByInternalName && context.classFieldsByInternalName.get(owner);
  const expr = label.expression;
  if (expr && expr.kind === 'UnsupportedExpression' && Array.isArray(expr.tokens) && expr.tokens.length === 1) {
    const name = tokenText(expr.tokens[0]);
    const field = fields && fields.get(name);
    if (field && field.isStatic) return fieldValueForContext(field, { ...context, classInternalName: owner });
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
      return {
        kind: 'StaticFieldValue',
        type: enumDescriptor,
        owner,
        name,
        descriptor: enumDescriptor,
      };
    }
    return null;
  }
  if (expr && expr.kind === 'Identifier') {
    const field = fields && fields.get(expr.name);
    if (field && field.isStatic) return fieldValueForContext(field, { ...context, classInternalName: owner });
    if (/^[A-Z][A-Z0-9_]*$/.test(expr.name)) {
      return {
        kind: 'StaticFieldValue',
        type: enumDescriptor,
        owner,
        name: expr.name,
        descriptor: enumDescriptor,
      };
    }
  }
  return lowerExpressionToJavaIrValue(expr, context);
}

function lowerEnumSwitchToJavaIrOps(statement, value, context) {
  const branches = [];
  let defaultOps = [];
  for (const group of statement.groups || []) {
    const bodyOps = stripBreakOps((group.statements || []).flatMap((child) => lowerStatementToJavaIrOps(child, context)));
    let isDefault = false;
    for (const label of group.labels || []) {
      if (label.labelKind === 'default') {
        isDefault = true;
        continue;
      }
      const caseValue = enumCaseValue(label, value.type, context);
      if (!caseValue || caseValue.type !== value.type) {
        return [javaIrUnsupported('unsupported enum switch case label', { sourceNodeKind: label.expression && label.expression.kind })];
      }
      branches.push({ caseValue, bodyOps });
    }
    if (isDefault) defaultOps = bodyOps;
  }
  let ops = defaultOps;
  for (let index = branches.length - 1; index >= 0; index -= 1) {
    const branch = branches[index];
    ops = [createJavaIrOp('if', {
      condition: {
        kind: 'CompareValue',
        type: 'Z',
        operator: '==',
        left: value,
        right: branch.caseValue,
      },
      thenOps: branch.bodyOps,
      elseOps: ops,
      sourceNodeKind: statement.kind,
      meta: { enumSwitch: true },
    })];
  }
  return ops;
}


function instanceInitializationOps(classContext, context) {
  const thisLocal = context.localByName.get('this');
  if (!thisLocal) return [];
  const ops = [];
  for (const fieldInit of classContext.instanceFieldInitializers || []) {
    ops.push(createJavaIrOp('putField', {
      owner: classContext.classInternalName,
      name: fieldInit.name,
      descriptor: fieldInit.descriptor,
      value: fieldInit.value,
      args: [localValue(thisLocal)],
      sourceNodeKind: fieldInit.sourceNodeKind || 'FieldDeclaration',
    }));
  }
  for (const blockMember of classContext.instanceInitializerBlocks || []) {
    ops.push(...(blockMember.body && blockMember.body.kind === 'BlockStatement'
      ? lowerStatementToJavaIrOps(blockMember.body, context)
      : [javaIrUnsupported('initializer body unavailable', { sourceNodeKind: blockMember.kind })]));
  }
  return ops;
}

function createStaticInitializerContext(classContext) {
  const context = classContext.staticInitializerContext || {
    locals: [],
    localByName: new Map(),
    nextSlot: 0,
    nextLocalId: 0,
    methodByName: classContext.methodByName,
    fieldByName: classContext.fieldByName,
    classInternalName: classContext.classInternalName,
    className: classContext.className,
    superName: classContext.superName,
    classBySimpleName: classContext.classBySimpleName,
    classMethodsByInternalName: classContext.classMethodsByInternalName,
    classMethodOverloadsByInternalName: classContext.classMethodOverloadsByInternalName,
    classFieldsByInternalName: classContext.classFieldsByInternalName,
    outerClassInternalName: classContext.outerClassInternalName,
    outerFieldByName: classContext.outerFieldByName,
    outerMethodByName: classContext.outerMethodByName,
    outerThisFieldName: classContext.outerThisFieldName,
    typeParameters: classContext.typeParameters,
    currentMethodIsStatic: true,
    currentReturnDescriptor: 'V',
    syntheticClasses: classContext.syntheticClasses,
    allocateLambdaClassName: classContext.allocateLambdaClassName,
    constructorCaptureArgsByOwner: classContext.constructorCaptureArgsByOwner,
  };
  classContext.staticInitializerContext = context;
  return context;
}

function initializerBlockOps(blockMember, context) {
  return blockMember.body && blockMember.body.kind === 'BlockStatement'
    ? lowerStatementToJavaIrOps(blockMember.body, context)
    : [javaIrUnsupported('initializer body unavailable', { sourceNodeKind: blockMember.kind })];
}

function createClassInitializerMethod(classContext) {
  const context = createStaticInitializerContext(classContext);
  return createJavaIrMethod({
    name: '<clinit>',
    descriptor: '()V',
    access: ['static'],
    parameters: [],
    locals: context.locals,
    blocks: [createJavaIrBlock('entry', {
      kind: 'EntryBlock',
      ops: classContext.staticInitializerOps || [],
      terminator: javaIrReturn(null),
    })],
    entryBlockId: 'entry',
    exitBlockId: null,
    sourceNodeKind: 'SyntheticStaticInitializer',
  });
}

function lowerMethodToJavaIr(method, classContext, slotBase = 0) {
  const typeParameters = buildTypeParameterErasureMap(method.typeParameters || [], classContext.typeParameters);
  const typeContext = { typeParameters, classBySimpleName: classContext.classBySimpleName };
  const declaredDescriptor = methodDescriptor(method, { typeParameters: classContext.typeParameters, classBySimpleName: classContext.classBySimpleName });
  const currentReturnDescriptor = declaredDescriptor.slice(declaredDescriptor.indexOf(')') + 1);
  const parameters = [];
  const locals = [];
  const localByName = new Map();
  let slot = slotBase;
  if (slotBase === 1) {
    const thisLocal = createJavaIrLocal('param:this', {
      name: 'this',
      descriptor: `L${classContext.classInternalName};`,
      slotHint: 0,
    });
    locals.push(thisLocal);
    localByName.set('this', thisLocal);
  }
  for (const parameter of method.parameters || []) {
    const descriptor = formalParameterDescriptor(parameter, typeContext);
    const signature = formalParameterSignature(parameter, typeContext);
    const id = `param:${parameter.name}`;
    const local = createJavaIrLocal(id, { name: parameter.name, descriptor, slotHint: slot, meta: { signature } });
    parameters.push({ id, name: parameter.name, descriptor, slotHint: slot, meta: { signature } });
    locals.push(local);
    localByName.set(parameter.name, local);
    slot += descriptor === 'J' || descriptor === 'D' ? 2 : 1;
  }
  const context = {
    locals,
    localByName,
    nextSlot: slot,
    nextLocalId: 0,
    methodByName: classContext.methodByName,
    fieldByName: classContext.fieldByName,
    classInternalName: classContext.classInternalName,
    className: classContext.className,
    superName: classContext.superName,
    classBySimpleName: classContext.classBySimpleName,
    classMethodsByInternalName: classContext.classMethodsByInternalName,
    classMethodOverloadsByInternalName: classContext.classMethodOverloadsByInternalName,
    classFieldsByInternalName: classContext.classFieldsByInternalName,
    outerClassInternalName: classContext.outerClassInternalName,
    outerFieldByName: classContext.outerFieldByName,
    outerMethodByName: classContext.outerMethodByName,
    outerThisFieldName: classContext.outerThisFieldName,
    typeParameters,
    classSuperByInternalName: classContext.classSuperByInternalName,
    classInterfacesByInternalName: classContext.classInterfacesByInternalName,
    currentMethodName: method.kind === 'ConstructorDeclaration' ? '<init>' : method.name,
    currentMethodIsStatic: modifierNames(method.modifiers).includes('static'),
    currentReturnDescriptor,
    syntheticClasses: classContext.syntheticClasses,
    allocateLambdaClassName: classContext.allocateLambdaClassName,
    constructorCaptureArgsByOwner: classContext.constructorCaptureArgsByOwner,
  };
  const methodModifiers = modifierNames(method.modifiers);
  const hasMethodBody = method.body && method.body.kind === 'BlockStatement';
  const isAbstract = methodModifiers.includes('abstract') || (classContext.isInterface && !hasMethodBody);
  const hasExternalBody = isAbstract || methodModifiers.includes('native');
  let ops = method.body && method.body.kind === 'BlockStatement'
    ? lowerStatementToJavaIrOps(method.body, context)
    : (hasExternalBody ? [] : [javaIrUnsupported(`method body unavailable for ${method.name}`, { sourceNodeKind: method.kind })]);
  if (method.kind === 'ConstructorDeclaration') {
    const initOps = instanceInitializationOps(classContext, context);
    if (isConstructorDelegationOp(ops[0], context)) {
      ops = [ops[0]].concat(initOps, ops.slice(1));
    } else {
      ops = [implicitSuperConstructorOp(context)].concat(initOps, ops);
    }
  }
  const block = createJavaIrBlock('entry', {
    kind: 'EntryBlock',
    ops,
    terminator: javaIrReturn(null),
  });
  return createJavaIrMethod({
    name: method.kind === 'ConstructorDeclaration' ? '<init>' : method.name,
    descriptor: declaredDescriptor,
    access: dedupePreservingOrder(
      (classContext.isInterface && !methodModifiers.includes('private') ? ['public'] : [])
        .concat(isAbstract ? ['abstract'] : [])
        .concat(methodModifiers.filter((modifier) => modifier !== 'default' && modifier !== 'abstract')),
    ),
    parameters,
    locals,
    blocks: [block],
    entryBlockId: 'entry',
    exitBlockId: null,
    sourceNodeKind: method.kind,
    meta: {
      signature: methodGenericSignature(method, classContext.typeParameters),
      annotations: annotationsMeta(method.annotations, { classBySimpleName: classContext.classBySimpleName }),
    },
  });
}

function lowerInitializerBlockToJavaIr(blockMember, classContext) {
  const context = createStaticInitializerContext(classContext);
  const block = createJavaIrBlock('entry', {
    kind: 'EntryBlock',
    ops: initializerBlockOps(blockMember, context),
    terminator: javaIrReturn(null),
  });
  return createJavaIrMethod({
    name: '<clinit>',
    descriptor: '()V',
    access: ['static'],
    parameters: [],
    locals: context.locals,
    blocks: [block],
    entryBlockId: 'entry',
    exitBlockId: null,
    sourceNodeKind: blockMember.kind,
  });
}

function createInnerMemberDefaultConstructor(classContext) {
  const outerDescriptor = `L${classContext.outerClassInternalName};`;
  const thisLocal = createJavaIrLocal('param:this', {
    name: 'this',
    descriptor: `L${classContext.classInternalName};`,
    slotHint: 0,
  });
  const outerLocal = createJavaIrLocal('param:this$0', {
    name: 'this$0',
    descriptor: outerDescriptor,
    slotHint: 1,
  });
  const context = {
    locals: [thisLocal, outerLocal],
    localByName: new Map([['this', thisLocal], ['this$0', outerLocal]]),
    nextSlot: 2,
    nextLocalId: 0,
    methodByName: classContext.methodByName,
    fieldByName: classContext.fieldByName,
    classInternalName: classContext.classInternalName,
    className: classContext.className,
    superName: classContext.superName,
    classBySimpleName: classContext.classBySimpleName,
    classMethodsByInternalName: classContext.classMethodsByInternalName,
    classMethodOverloadsByInternalName: classContext.classMethodOverloadsByInternalName,
    classFieldsByInternalName: classContext.classFieldsByInternalName,
    typeParameters: classContext.typeParameters,
    currentMethodIsStatic: false,
    syntheticClasses: classContext.syntheticClasses,
    allocateLambdaClassName: classContext.allocateLambdaClassName,
  };
  const block = createJavaIrBlock('entry', {
    kind: 'EntryBlock',
    ops: [
      implicitSuperConstructorOp(context),
      createJavaIrOp('putField', {
        owner: classContext.classInternalName,
        name: classContext.outerThisFieldName,
        descriptor: outerDescriptor,
        value: localValue(outerLocal),
        args: [localValue(thisLocal)],
        sourceNodeKind: 'SyntheticInnerConstructor',
      }),
    ].concat((classContext.instanceFieldInitializers || []).map((fieldInit) => createJavaIrOp('putField', {
      owner: classContext.classInternalName,
      name: fieldInit.name,
      descriptor: fieldInit.descriptor,
      value: fieldInit.value,
      args: [localValue(thisLocal)],
      sourceNodeKind: 'SyntheticInnerConstructor',
    }))),
    terminator: javaIrReturn(null),
  });
  return createJavaIrMethod({
    name: '<init>',
    descriptor: `(${outerDescriptor})V`,
    access: ['public'],
    parameters: [{ id: outerLocal.id, name: outerLocal.name, descriptor: outerLocal.descriptor, slotHint: outerLocal.slotHint }],
    locals: [thisLocal, outerLocal],
    blocks: [block],
    entryBlockId: 'entry',
    sourceNodeKind: 'SyntheticInnerConstructor',
  });
}

function lowerAstToJavaIr(document, options = {}) {
  validateAstDocument(document);
  const packageName = packageNameForDocument(document);
  const classes = [];
  const syntheticClasses = [];
  const unsupported = [];

  const classBySimpleName = new Map();
  const internalNameByDeclaration = new Map();
  for (const importDeclaration of document.root.imports || []) {
    if (importDeclaration.isStatic || importDeclaration.isWildcard) continue;
    const parts = importDeclaration.name && importDeclaration.name.parts;
    if (!Array.isArray(parts) || parts.length === 0) continue;
    const internalName = parts.join('/');
    classBySimpleName.set(parts[parts.length - 1], internalName);
    classBySimpleName.set(parts.join('.'), internalName);
  }
  function collectClassNames(declaration, outerInternalName = null) {
    if (!isClassLikeDeclaration(declaration)) return;
    const internalName = outerInternalName
      ? `${outerInternalName}$${declaration.name}`
      : internalNameFromClassName(declaration.name, packageName);
    internalNameByDeclaration.set(declaration, internalName);
    classBySimpleName.set(declaration.name, internalName);
    classBySimpleName.set(internalName.replace(/\$/g, '.').replace(/\//g, '.'), internalName);
    for (const member of declaration.body || []) {
      if (isClassLikeDeclaration(member)) {
        collectClassNames(member, internalName);
      }
    }
  }
  for (const declaration of document.root.typeDeclarations || []) collectClassNames(declaration);

  const sourcePrelude = sourceDirectoryMetadata(options.sourceRoot || options.sourcePath, Boolean(options.sourceRoot));
  if (sourcePrelude) {
    for (const [name, internalName] of sourcePrelude.classBySimpleName) {
      if (!classBySimpleName.has(name)) classBySimpleName.set(name, internalName);
    }
  }

  const classMethodsByInternalName = sourcePrelude ? cloneNestedMap(sourcePrelude.classMethodsByInternalName) : new Map();
  const classMethodOverloadsByInternalName = sourcePrelude ? cloneNestedMap(sourcePrelude.classMethodOverloadsByInternalName) : new Map();
  const classFieldsByInternalName = sourcePrelude ? cloneNestedMap(sourcePrelude.classFieldsByInternalName) : new Map();
  const classSuperByInternalName = sourcePrelude ? new Map(sourcePrelude.classSuperByInternalName) : new Map();
  const classInterfacesByInternalName = sourcePrelude
    ? new Map(Array.from(sourcePrelude.classInterfacesByInternalName, ([owner, interfaces]) => [owner, interfaces.slice()]))
    : new Map();
  function buildMethodMap(declaration) {
    if (!isClassLikeDeclaration(declaration)) return;
    const isEnum = declaration.kind === 'EnumDeclaration';
    const isInterface = declaration.kind === 'InterfaceDeclaration' || declaration.kind === 'AnnotationTypeDeclaration';
    const classTypeParameters = buildTypeParameterErasureMap(declaration.typeParameters || []);
    const methodByName = new Map();
    const methodOverloadsByName = new Map();
    const descriptorContext = { typeParameters: classTypeParameters, classBySimpleName };
    for (const member of declaration.body || []) {
      if (member.kind === 'MethodDeclaration' || member.kind === 'ConstructorDeclaration') {
        const methodTypeParameters = buildTypeParameterErasureMap(member.typeParameters || [], classTypeParameters);
        const baseDescriptor = methodDescriptor(member, descriptorContext);
        const descriptor = isEnum && member.kind === 'ConstructorDeclaration'
          ? `(Ljava/lang/String;I${baseDescriptor.slice(1)}`
          : baseDescriptor;
        const returnDescriptor = descriptor.slice(descriptor.indexOf(')') + 1);
        const methodName = member.kind === 'ConstructorDeclaration' ? '<init>' : member.name;
        const baseParameterDescriptors = (member.parameters || []).map((parameter) => formalParameterDescriptor(parameter, {
          typeParameters: methodTypeParameters,
          classBySimpleName,
        }));
        const parameterDescriptors = isEnum && member.kind === 'ConstructorDeclaration'
          ? ['Ljava/lang/String;', 'I'].concat(baseParameterDescriptors)
          : baseParameterDescriptors;
        const summary = {
          name: member.kind === 'ConstructorDeclaration' ? '<init>' : member.name,
          descriptor,
          returnDescriptor,
          parameterDescriptors,
          isStatic: modifierNames(member.modifiers).includes('static'),
          isVarargs: (member.parameters || []).some((parameter) => parameter.isVarargs),
          invokeKind: isInterface && member.kind === 'MethodDeclaration' ? 'interface' : undefined,
        };
        methodByName.set(methodName, summary);
        if (!methodOverloadsByName.has(methodName)) methodOverloadsByName.set(methodName, []);
        methodOverloadsByName.get(methodName).push(summary);
      }
    }
    if (isEnum) {
      const enumDescriptor = `L${internalNameByDeclaration.get(declaration)};`;
      const valuesSummary = {
        name: 'values',
        descriptor: `()[${enumDescriptor}`,
        returnDescriptor: `[${enumDescriptor}`,
        parameterDescriptors: [],
        isStatic: true,
      };
      const valueOfSummary = {
        name: 'valueOf',
        descriptor: `(Ljava/lang/String;)${enumDescriptor}`,
        returnDescriptor: enumDescriptor,
        parameterDescriptors: ['Ljava/lang/String;'],
        isStatic: true,
      };
      methodByName.set('values', valuesSummary);
      methodByName.set('valueOf', valueOfSummary);
      if (!methodOverloadsByName.has('values')) methodOverloadsByName.set('values', []);
      if (!methodOverloadsByName.has('valueOf')) methodOverloadsByName.set('valueOf', []);
      methodOverloadsByName.get('values').push(valuesSummary);
      methodOverloadsByName.get('valueOf').push(valueOfSummary);
      if (!methodByName.has('<init>')) {
        const ctorSummary = {
          name: '<init>',
          descriptor: '(Ljava/lang/String;I)V',
          returnDescriptor: 'V',
          parameterDescriptors: ['Ljava/lang/String;', 'I'],
          isStatic: false,
        };
        methodByName.set('<init>', ctorSummary);
        if (!methodOverloadsByName.has('<init>')) methodOverloadsByName.set('<init>', []);
        methodOverloadsByName.get('<init>').push(ctorSummary);
      }
    }
    classMethodsByInternalName.set(internalNameByDeclaration.get(declaration), methodByName);
    classMethodOverloadsByInternalName.set(internalNameByDeclaration.get(declaration), methodOverloadsByName);
    classSuperByInternalName.set(
      internalNameByDeclaration.get(declaration),
      declaration.extendsType ? classTypeInternalName(declaration.extendsType, descriptorContext) : 'java/lang/Object',
    );
    classInterfacesByInternalName.set(
      internalNameByDeclaration.get(declaration),
      (isInterface ? (declaration.extendsTypes || []) : (declaration.implementsTypes || []))
        .map((type) => classTypeInternalName(type, descriptorContext)),
    );
    for (const member of declaration.body || []) {
      if (isClassLikeDeclaration(member)) buildMethodMap(member);
    }
  }
  for (const declaration of document.root.typeDeclarations || []) buildMethodMap(declaration);

  function buildFieldMap(declaration) {
    if (!isClassLikeDeclaration(declaration)) return;
    const internalName = internalNameByDeclaration.get(declaration);
    const classTypeParameters = buildTypeParameterErasureMap(declaration.typeParameters || []);
    const classTypeContext = {
      typeParameters: classTypeParameters,
      classBySimpleName,
      fallbackUnsupportedTypes: options.fallbackUnsupportedTypes === true,
    };
    const fieldByName = new Map();
    if (declaration.kind === 'EnumDeclaration') {
      const enumDescriptor = `L${internalName};`;
      for (const constant of declaration.constants || []) {
        fieldByName.set(constant.name, {
          owner: internalName,
          name: constant.name,
          descriptor: enumDescriptor,
          signature: enumDescriptor,
          isStatic: true,
        });
      }
      fieldByName.set('$VALUES', {
        owner: internalName,
        name: '$VALUES',
        descriptor: `[${enumDescriptor}`,
        signature: `[${enumDescriptor}`,
        isStatic: true,
      });
    }
    for (const member of declaration.body || []) {
      if (member.kind === 'FieldDeclaration') {
        for (const declarator of member.declarators || []) {
          fieldByName.set(declarator.name, {
            owner: internalName,
            name: declarator.name,
            descriptor: typeDescriptor(member.fieldType, classTypeContext),
            signature: typeSignature(member.fieldType, classTypeContext),
            isStatic: modifierNames(member.modifiers).includes('static'),
          });
        }
      }
    }
    classFieldsByInternalName.set(internalName, fieldByName);
    for (const member of declaration.body || []) {
      if (isClassLikeDeclaration(member)) buildFieldMap(member);
    }
  }
  for (const declaration of document.root.typeDeclarations || []) buildFieldMap(declaration);

  function lowerClassDeclaration(declaration, outerClassContext = null) {
    if (!isClassLikeDeclaration(declaration)) {
      unsupported.push({ kind: declaration.kind, reason: 'unsupported-top-level-declaration' });
      return;
    }
    const isInterface = declaration.kind === 'InterfaceDeclaration';
    const isAnnotation = declaration.kind === 'AnnotationTypeDeclaration';
    const isEnum = declaration.kind === 'EnumDeclaration';
    const isNonStaticMemberClass = Boolean(outerClassContext)
      && declaration.kind !== 'EnumDeclaration'
      && !modifierNames(declaration.modifiers).includes('static');
    const classTypeParameters = buildTypeParameterErasureMap(declaration.typeParameters || []);
    const classTypeContext = {
      typeParameters: classTypeParameters,
      classBySimpleName,
      fallbackUnsupportedTypes: options.fallbackUnsupportedTypes === true,
    };
    const internalName = internalNameByDeclaration.get(declaration);
    let nextLambdaId = 0;
    const superName = isEnum
      ? 'java/lang/Enum'
      : isInterface || isAnnotation || !declaration.extendsType
      ? 'java/lang/Object'
      : typeDescriptor(declaration.extendsType, classTypeContext).slice(1, -1);
    const classIr = createJavaIrClass({
      name: declaration.name,
      packageName,
      internalName,
      access: isInterface || isAnnotation
        ? dedupePreservingOrder(modifierNames(declaration.modifiers).concat(['interface', 'abstract'], isAnnotation ? ['annotation'] : []))
        : isEnum
        ? dedupePreservingOrder(modifierNames(declaration.modifiers).concat(['final', 'super', 'enum']))
        : dedupePreservingOrder(modifierNames(declaration.modifiers).concat(['super'])),
      superName,
      interfaces: isAnnotation
        ? ['java/lang/annotation/Annotation']
        : isInterface
        ? (declaration.extendsTypes || []).map((type) => classTypeInternalName(type))
        : (declaration.implementsTypes || []).map((type) => classTypeInternalName(type, { classBySimpleName })),
      sourceNodeKind: declaration.kind,
      meta: {
        signature: (declaration.typeParameters || []).length
          ? `<${(declaration.typeParameters || []).map((parameter) => `${parameter.name}:${(parameter.bounds && parameter.bounds[0] ? typeSignature(parameter.bounds[0], classTypeContext) : 'Ljava/lang/Object;')}`).join('')}>Ljava/lang/Object;`
          : null,
        annotations: annotationsMeta(declaration.annotations, { classBySimpleName }),
      },
    });
    const methodByName = classMethodsByInternalName.get(internalName) || new Map();
    const fieldByName = classFieldsByInternalName.get(internalName) || new Map();
    const classContext = {
      className: declaration.name,
      classInternalName: classIr.internalName,
      methodByName,
      localByName: new Map(),
      classBySimpleName,
      classMethodsByInternalName,
      classMethodOverloadsByInternalName,
      classFieldsByInternalName,
      classSuperByInternalName,
      classInterfacesByInternalName,
      fieldByName,
      outerClassInternalName: outerClassContext && outerClassContext.classInternalName,
      outerFieldByName: outerClassContext && outerClassContext.fieldByName,
      outerMethodByName: outerClassContext && outerClassContext.methodByName,
      outerThisFieldName: isNonStaticMemberClass ? 'this$0' : null,
      isInterface: isInterface || isAnnotation,
      isEnum,
      superName: classIr.superName,
      typeParameters: classTypeParameters,
      fallbackUnsupportedTypes: options.fallbackUnsupportedTypes === true,
      syntheticClasses,
      instanceFieldInitializers: [],
      instanceInitializerBlocks: [],
      staticInitializerOps: [],
      staticInitializerContext: null,
      constructorCaptureArgsByOwner: outerClassContext && outerClassContext.constructorCaptureArgsByOwner
        ? outerClassContext.constructorCaptureArgsByOwner
        : new Map(),
      allocateLambdaClassName() {
        const id = `${internalName}$Lambda${nextLambdaId}`;
        nextLambdaId += 1;
        return id;
      },
    };
    if (isNonStaticMemberClass) {
      const outerDescriptor = `L${outerClassContext.classInternalName};`;
      classIr.fields.push(createJavaIrField({
        name: 'this$0',
        descriptor: outerDescriptor,
        access: ['final'],
        initializer: null,
      }));
    }
    if (isEnum) {
      const enumDescriptor = `L${classIr.internalName};`;
      for (const constant of declaration.constants || []) {
        classIr.fields.push(createJavaIrField({
          name: constant.name,
          descriptor: enumDescriptor,
          access: ['public', 'static', 'final'],
          initializer: null,
          meta: { enumConstant: true },
        }));
      }
      classIr.fields.push(createJavaIrField({
        name: '$VALUES',
        descriptor: `[${enumDescriptor}`,
        access: ['private', 'static', 'final'],
        initializer: null,
        meta: { synthetic: true, enumValues: true },
      }));
    }
    let hasStaticInitializer = false;
    let hasConstructor = false;
    for (const member of declaration.body || []) {
      if (member.kind === 'FieldDeclaration') {
        for (const declarator of member.declarators || []) {
          const initializer = declarator.initializer
            ? (lowerLambdaToJavaIrValue(declarator.initializer, typeDescriptor(member.fieldType, classTypeContext), classContext)
              || lowerExpressionToJavaIrValue(declarator.initializer, classContext)
              || literalToJavaIrValue(declarator.initializer)
              || { kind: declarator.initializer.kind })
            : null;
          classIr.fields.push(createJavaIrField({
            name: declarator.name,
            descriptor: typeDescriptor(member.fieldType, classTypeContext),
            access: modifierNames(member.modifiers),
            initializer,
            meta: {
              signature: typeSignature(member.fieldType, classTypeContext),
              annotations: annotationsMeta(member.annotations, { classBySimpleName }),
            },
          }));
          if (!isEnum && modifierNames(member.modifiers).includes('static') && initializer) {
            classContext.staticInitializerOps.push(createJavaIrOp('putStaticField', {
              owner: classContext.classInternalName,
              name: declarator.name,
              descriptor: typeDescriptor(member.fieldType, classTypeContext),
              value: initializer,
              sourceNodeKind: member.kind,
            }));
          }
          if (!modifierNames(member.modifiers).includes('static') && initializer) {
            classContext.instanceFieldInitializers.push({
              name: declarator.name,
              descriptor: typeDescriptor(member.fieldType, classTypeContext),
              value: initializer,
              sourceNodeKind: member.kind,
            });
          }
        }
      } else if (member.kind === 'MethodDeclaration' || member.kind === 'ConstructorDeclaration') {
        if (member.kind === 'ConstructorDeclaration') hasConstructor = true;
        classIr.methods.push(isEnum && member.kind === 'ConstructorDeclaration'
          ? lowerEnumConstructorToJavaIr(member, classContext)
          : lowerMethodToJavaIr(member, classContext, member.modifiers && modifierNames(member.modifiers).includes('static') ? 0 : 1));
      } else if (member.kind === 'InitializerBlock' && member.isStatic) {
        hasStaticInitializer = true;
        if (isEnum) {
          classIr.methods.push(lowerInitializerBlockToJavaIr(member, classContext));
        } else {
          classContext.staticInitializerOps.push(...initializerBlockOps(member, createStaticInitializerContext(classContext)));
        }
      } else if (member.kind === 'InitializerBlock') {
        classContext.instanceInitializerBlocks.push(member);
      } else if (isClassLikeDeclaration(member)) {
        lowerClassDeclaration(member, classContext);
      } else {
        unsupported.push({ kind: member.kind, owner: declaration.name, reason: 'unsupported-member-declaration' });
      }
    }
    if (!isEnum && classContext.staticInitializerOps.length > 0) {
      classIr.methods.push(createClassInitializerMethod(classContext));
    }
    if (isEnum) {
      if (!hasConstructor) classIr.methods.push(createEnumDefaultConstructor(classContext));
      if (!hasStaticInitializer) classIr.methods.push(createEnumClassInitializer(declaration, classContext));
      else unsupported.push({ kind: 'EnumDeclaration', owner: declaration.name, reason: 'enum-static-initializer-merge-not-implemented' });
      classIr.methods.push(createEnumValuesMethod(classContext));
      classIr.methods.push(createEnumValueOfMethod(classContext));
    } else if (isNonStaticMemberClass && !hasConstructor) {
      classIr.methods.unshift(createInnerMemberDefaultConstructor(classContext));
    }
    classes.push(classIr);
  }
  for (const declaration of document.root.typeDeclarations || []) lowerClassDeclaration(declaration);
  classes.push(...syntheticClasses);
  // Synthetic lambda implementation classes are ordinary class files rather
  // than VM-generated lambda proxies, so they do not inherit the privileged
  // lookup access that invokedynamic lambdas receive. Relax only members that
  // those synthetic classes directly reference; package access is sufficient
  // because each lambda is emitted beside its enclosing class.
  const methodsByKey = new Map();
  const fieldsByKey = new Map();
  for (const classIr of classes) {
    for (const method of classIr.methods || []) {
      methodsByKey.set(`${classIr.internalName}.${method.name}${method.descriptor}`, method);
    }
    for (const field of classIr.fields || []) {
      fieldsByKey.set(`${classIr.internalName}.${field.name}:${field.descriptor}`, field);
    }
  }
  const visitedLambdaValues = new Set();
  function relaxSyntheticMemberReferences(value) {
    if (!value || typeof value !== 'object' || visitedLambdaValues.has(value)) return;
    visitedLambdaValues.add(value);
    if (value.kind === 'MethodCallValue') {
      const method = methodsByKey.get(`${value.owner}.${value.name}${value.descriptor}`);
      if (method && (method.access || []).includes('private')) {
        method.access = method.access.filter((access) => access !== 'private');
      }
    }
    if (value.kind === 'FieldValue' || value.kind === 'StaticFieldValue') {
      const field = fieldsByKey.get(`${value.owner}.${value.name}:${value.descriptor}`);
      if (field && (field.access || []).includes('private')) {
        field.access = field.access.filter((access) => access !== 'private');
      }
    }
    if (Array.isArray(value)) {
      for (const child of value) relaxSyntheticMemberReferences(child);
      return;
    }
    for (const child of Object.values(value)) relaxSyntheticMemberReferences(child);
  }
  for (const classIr of classes) {
    if (classIr.meta && classIr.meta.synthetic && classIr.sourceNodeKind === 'LambdaExpression') {
      relaxSyntheticMemberReferences(classIr.methods || []);
    }
  }
  const nestedUnsupported = [];
  const seenIrNodes = new Set();
  function collectUnsupported(value, owner, method) {
    if (!value || typeof value !== 'object' || seenIrNodes.has(value)) return;
    seenIrNodes.add(value);
    if (value.op === 'unsupported' || (value.op === 'expression' && !value.value)) {
      nestedUnsupported.push({
        owner,
        method,
        reason: value.reason || value.text || 'unsupported expression',
        sourceNodeKind: value.sourceNodeKind || null,
      });
    }
    if (Array.isArray(value)) {
      for (const child of value) collectUnsupported(child, owner, method);
      return;
    }
    for (const child of Object.values(value)) collectUnsupported(child, owner, method);
  }
  for (const classIr of classes) {
    for (const method of classIr.methods || []) {
      collectUnsupported(method.blocks || [], classIr.internalName, `${method.name}${method.descriptor}`);
    }
  }
  const allUnsupported = unsupported.concat(nestedUnsupported);
  return createJavaIrDocument(classes, {
    astSchema: document.schema,
    astVersion: document.version,
    sourceLevel: document.sourceLevel,
    status: allUnsupported.length ? 'partial' : 'complete',
    unsupported: allUnsupported,
    meta: options.meta || {},
  });
}

function createLowerAstToJavaIrPass(options = {}) {
  return {
    name: options.name || 'frontend.lowerAstToIr',
    phase: 'lowering',
    description: 'Lower the Java AST into a serializable backend-neutral Java IR sidecar.',
    dependsOn: options.dependsOn || [],
    run(document, context) {
      const ir = lowerAstToJavaIr(document, options);
      attachJavaIrDocument(document, ir, options.attach || {});
      if (context && typeof context.annotate === 'function') {
        context.annotate(document.root, 'frontend.javaIr.status', {
          status: ir.status,
          classes: ir.classes.length,
          unsupported: ir.unsupported.length,
        });
      }
      return document;
    },
  };
}

module.exports = {
  JAVA_IR_SCHEMA_ID,
  JAVA_IR_SCHEMA_VERSION,
  JAVA_IR_AST_META_KEY,
  createJavaIrDocument,
  createJavaIrClass,
  createJavaIrField,
  createJavaIrMethod,
  createJavaIrLocal,
  createJavaIrBlock,
  createJavaIrOp,
  javaIrReturn,
  javaIrGoto,
  javaIrUnsupported,
  isJavaIrDocument,
  validateJavaIrDocument,
  toJavaIrJson,
  serializeJavaIr,
  deserializeJavaIr,
  cloneJavaIr,
  attachJavaIrDocument,
  getAttachedJavaIrDocument,
  detachJavaIrDocument,
  lowerAstToJavaIr,
  createLowerAstToJavaIrPass,
};
