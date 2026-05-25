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

function classTypeInternalName(type) {
  if (type && type.kind === 'ParameterizedType') return classTypeInternalName(type.baseType);
  if (!type || type.kind !== 'ClassType') return 'java/lang/Object';
  if (type.packageName) {
    return `${String(type.packageName).replace(/\./g, '/')}/${type.name}`;
  }
  if ([
    'ArithmeticException', 'ArrayIndexOutOfBoundsException', 'Boolean', 'Byte',
    'AutoCloseable', 'Character', 'Class', 'ClassCastException', 'Comparable', 'Double', 'Exception',
    'Float', 'IllegalArgumentException', 'Integer', 'Iterable', 'Long', 'Math',
    'InterruptedException', 'NegativeArraySizeException', 'NullPointerException', 'Object', 'RuntimeException',
    'Runnable', 'Short', 'StackOverflowError', 'String', 'StringBuilder', 'System', 'Thread',
    'Throwable', 'Void',
  ].includes(type.name)) {
    return `java/lang/${type.name}`;
  }
  if ([
    'ArrayList', 'Collection', 'Collections', 'Deque', 'HashMap', 'HashSet',
    'Iterator', 'LinkedList', 'List', 'ListIterator', 'Map', 'Random', 'Set',
  ].includes(type.name)) return `java/util/${type.name}`;
  if (type.name === 'ReentrantLock') return 'java/util/concurrent/locks/ReentrantLock';
  if (type.name === 'Function') return 'java/util/function/Function';
  if (['Array', 'Field', 'Method', 'Modifier'].includes(type.name)) return `java/lang/reflect/${type.name}`;
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

function sourceDirectoryMetadata(sourcePath) {
  if (!sourcePath) return null;
  const directory = path.dirname(path.resolve(sourcePath));
  if (SOURCE_METADATA_CACHE.has(directory)) return SOURCE_METADATA_CACHE.get(directory);
  const metadata = {
    classBySimpleName: new Map(),
    classFieldsByInternalName: new Map(),
    classMethodsByInternalName: new Map(),
    classMethodOverloadsByInternalName: new Map(),
  };
  let files = [];
  try {
    files = fs.readdirSync(directory)
      .filter((file) => file.endsWith('.java'))
      .map((file) => path.join(directory, file));
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
    const classTypeContext = { typeParameters: classTypeParameters, classBySimpleName };
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
    let type = 'I';
    if (/[lL]$/.test(raw)) type = 'J';
    else if (/[fF]$/.test(raw)) type = 'F';
    else if (/[dD]$/.test(raw) || raw.includes('.') || /[eEpP]/.test(raw)) type = 'D';
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
  'java/lang/System.out': 'Ljava/io/PrintStream;',
  'java/lang/System.err': 'Ljava/io/PrintStream;',
});

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
      value: token.text.slice(1, -1),
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
  for (let end = Math.min(normalized.length, 8); end >= 3; end -= 1) {
    const value = classLiteralFromTokens(normalized.slice(0, end), context);
    if (value) return { value, next: end };
  }
  const literal = literalTokenToJavaIrValue(normalized[0]);
  if (literal) return { value: literal, next: 1 };
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
    if (tokenText(normalized[index]) !== '.' || !normalized[index + 1] || normalized[index + 1].kind !== 'identifier') return null;
    const name = normalized[index + 1].text;
    if (tokenText(normalized[index + 2]) === '(') {
      const closeIndex = matchingTokenIndex(normalized, index + 2, '(', ')');
      if (closeIndex < 0) return null;
      const args = splitTopLevelByComma(normalized.slice(index + 3, closeIndex))
        .map((part) => lowerTokenExpressionToJavaIrValue(part, context));
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
    .map((part) => lowerTokenExpressionToJavaIrValue(part, context));
  if (!rawArgs.every(Boolean)) return null;
  const method = selectJreMethodDescriptor(owner, normalized[openIndex - 1].text, rawArgs, true)
    || selectUserMethodDescriptor(owner, normalized[openIndex - 1].text, rawArgs, context, true);
  const args = prepareMethodArguments(method, rawArgs);
  if (!method || !args) return null;
  return {
    kind: 'MethodCallValue',
    type: method.returnDescriptor,
    owner,
    name: method.name || normalized[openIndex - 1].text,
    descriptor: method.descriptor,
    invokeKind: 'static',
    args,
  };
}

function lowerTokenExpressionToJavaIrValue(tokens, context) {
  const normalized = trimParenTokens(tokens || []);
  if (normalized.length === 0) return null;
  const recoveredNumber = recoveredNumericLiteralToken(normalized);
  if (recoveredNumber) return literalTokenToJavaIrValue(recoveredNumber);

  if (normalized.length === 4
      && tokenText(normalized[0]) === '('
      && tokenText(normalized[2]) === ')') {
    const targetDescriptor = descriptorFromCastToken(tokenText(normalized[1]), context);
    const value = lowerTokenExpressionToJavaIrValue(normalized.slice(3), context);
    if (targetDescriptor && value) {
      return {
        kind: 'CastValue',
        type: targetDescriptor,
        fromType: value.type,
        value,
      };
    }
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

  const equalityIndex = tokenText(normalized[0]) === 'new'
    ? -1
    : findTopLevelOperator(normalized, ['==', '!=', '<=', '>=', '<', '>']);
  if (equalityIndex > 0) {
    let left = lowerTokenExpressionToJavaIrValue(normalized.slice(0, equalityIndex), context);
    let right = lowerTokenExpressionToJavaIrValue(normalized.slice(equalityIndex + 1), context);
    const operator = tokenText(normalized[equalityIndex]);
    if (left && right && left.literalKind === 'null') left = coerceValueToDescriptor(left, right.type);
    if (left && right && right.literalKind === 'null') right = coerceValueToDescriptor(right, left.type);
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

  const staticMethodCall = lowerTokenStaticMethodCallToJavaIrValue(normalized, context);
  if (staticMethodCall) return staticMethodCall;

  const memberChain = lowerTokenMemberChainToJavaIrValue(normalized, context);
  if (memberChain) return memberChain;

  const bitwiseOrIndex = findTopLevelOperator(normalized, ['|']);
  if (bitwiseOrIndex > 0) {
    let left = lowerTokenExpressionToJavaIrValue(normalized.slice(0, bitwiseOrIndex), context);
    let right = lowerTokenExpressionToJavaIrValue(normalized.slice(bitwiseOrIndex + 1), context);
    left = boxedPrimitiveValue(left) || left;
    right = boxedPrimitiveValue(right) || right;
    if (left && right && left.type === right.type && ['I', 'J'].includes(left.type)) {
      return {
        kind: 'BinaryValue',
        type: left.type,
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
    left = boxedPrimitiveValue(left) || left;
    right = boxedPrimitiveValue(right) || right;
    if (left && right && left.type === right.type && ['I', 'J'].includes(left.type)) {
      return {
        kind: 'BinaryValue',
        type: left.type,
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
    left = boxedPrimitiveValue(left) || left;
    right = boxedPrimitiveValue(right) || right;
    if (left && right && left.type === right.type && ['I', 'J'].includes(left.type)) {
      return {
        kind: 'BinaryValue',
        type: left.type,
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
    left = boxedPrimitiveValue(left) || left;
    right = boxedPrimitiveValue(right) || right;
    if (left && right && ['I', 'J'].includes(left.type) && right.type === 'I') {
      return {
        kind: 'BinaryValue',
        type: left.type,
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
    left = boxedPrimitiveValue(left) || left;
    right = boxedPrimitiveValue(right) || right;
    if (left && right && left.type === right.type && ['I', 'J', 'F', 'D'].includes(left.type)) {
      return {
        kind: 'BinaryValue',
        type: left.type,
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
    left = boxedPrimitiveValue(left) || left;
    right = boxedPrimitiveValue(right) || right;
    if (left && right && left.type === right.type && ['I', 'J', 'F', 'D'].includes(left.type)) {
      return {
        kind: 'BinaryValue',
        type: left.type,
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
      return thisReceiverValue(context);
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
      const args = splitTopLevelByComma(normalized.slice(openIndex + 1, -1))
        .map((part) => lowerTokenExpressionToJavaIrValue(part, context));
      if (owner && args.every(Boolean)) {
        return {
          kind: 'NewObjectValue',
          type: `L${owner};`,
          owner,
          descriptor: `(${args.map((arg) => arg.type).join('')})V`,
          args,
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
  if (owner === 'java/lang/Runnable') {
    if (name === 'run' && args.length === 0) return { descriptor: '()V', returnDescriptor: 'V', invokeKind: 'interface' };
  }
  if (owner === 'java/util/function/Function') {
    if (name === 'apply' && args.length === 1) return { descriptor: '(Ljava/lang/Object;)Ljava/lang/Object;', returnDescriptor: 'Ljava/lang/Object;', invokeKind: 'interface' };
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
  if (owner === context.classInternalName && context.methodByName.has(name)) {
    const method = context.methodByName.get(name);
    if (!method.isStatic && method.parameterDescriptors.length === args.length) {
      return { descriptor: method.descriptor, returnDescriptor: method.returnDescriptor };
    }
  }
  if (context.classMethodsByInternalName && context.classMethodsByInternalName.has(owner)) {
    const methods = context.classMethodsByInternalName.get(owner);
    if (methods && methods.has(name)) {
      const method = methods.get(name);
      if (!method.isStatic && method.parameterDescriptors.length === args.length) {
        return {
          descriptor: method.descriptor,
          returnDescriptor: method.returnDescriptor,
          parameterDescriptors: method.parameterDescriptors,
          invokeKind: method.invokeKind,
          isVarargs: method.isVarargs,
        };
      }
    }
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
  return args.every((arg, index) => arg && coerceValueToDescriptor(arg, method.parameterDescriptors[index]));
}

function prepareMethodArguments(method, args) {
  if (!method || !Array.isArray(method.parameterDescriptors)) return null;
  if (!method.isVarargs) {
    if (args.length !== method.parameterDescriptors.length) return null;
    const coerced = args.map((arg, index) => coerceValueToDescriptor(arg, method.parameterDescriptors[index]));
    return coerced.every(Boolean) ? coerced : null;
  }
  const parameters = method.parameterDescriptors;
  const fixedCount = parameters.length - 1;
  if (args.length < fixedCount) return null;
  const fixed = args.slice(0, fixedCount)
    .map((arg, index) => coerceValueToDescriptor(arg, parameters[index]));
  if (!fixed.every(Boolean)) return null;
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
  if (!component || !elements.every(Boolean)) return null;
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
    return coerceValueToDescriptor(arg, parameter);
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
    const method = candidates.find((candidate) => methodMatchesArguments(candidate, args, isStatic));
    if (method) return method;
  }
  const methods = context.classMethodsByInternalName && context.classMethodsByInternalName.get(owner);
  if (methods && methods.has(name)) {
    const method = methods.get(name);
    if (methodMatchesArguments(method, args, isStatic)) return method;
  }
  return null;
}

function methodDescriptorForConstructorCall(owner, args, context) {
  const method = selectUserMethodDescriptor(owner, '<init>', args, context, false);
  if (method) {
    return { descriptor: method.descriptor, returnDescriptor: 'V', parameterDescriptors: method.parameterDescriptors };
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
  if (expression.kind === 'Identifier') {
    names.push(expression.name);
    return names;
  }
  if (Array.isArray(expression.tokens)) {
    for (const token of expression.tokens) {
      if (token && token.kind === 'identifier') names.push(token.text);
    }
  }
  for (const key of ['target', 'expression', 'left', 'right', 'condition', 'consequent', 'alternate']) {
    if (expression[key]) identifierNamesFromExpression(expression[key], names);
  }
  for (const key of ['arguments', 'elements']) {
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
  if (!expression || expression.kind !== 'UnsupportedExpression' || !Array.isArray(expression.tokens)) return null;
  const tokens = expression.tokens;
  if (tokens.length < 5 || tokenText(tokens[0]) !== 'new' || tokens[1].kind !== 'identifier') return null;
  const openParen = 2;
  const closeParen = matchingTokenIndex(tokens, openParen, '(', ')');
  if (closeParen < 0 || tokenText(tokens[closeParen + 1]) !== '{') return null;
  const closeBrace = matchingTokenIndex(tokens, closeParen + 1, '{', '}');
  if (closeBrace !== tokens.length - 1) return null;
  const owner = context.allocateLambdaClassName ? context.allocateLambdaClassName() : `${context.classInternalName}$Anon0`;
  const iface = targetDescriptor && targetDescriptor.startsWith('L') ? targetDescriptor.slice(1, -1) : constructorOwnerFromName(tokens[1].text, context);
  const bodyText = expression.text.slice(expression.text.indexOf('{'), expression.text.lastIndexOf('}') + 1);
  let parsed;
  try {
    parsed = parseJava(`class ${owner.split('$').pop()} implements ${tokens[1].text} ${bodyText}`, { sourceFileName: 'AnonymousClass.java' });
  } catch (_) {
    return null;
  }
  const declaration = parsed.root.typeDeclarations && parsed.root.typeDeclarations[0];
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

function lowerLambdaToJavaIrValue(expression, targetDescriptor, context) {
  const anonymous = lowerAnonymousClassToJavaIrValue(expression, targetDescriptor, context);
  if (anonymous) return anonymous;
  if (targetDescriptor === 'Ljava/lang/Runnable;') {
    return lowerRunnableLambdaToJavaIrValue(expression, context)
      || lowerRunnableBlockLambdaToJavaIrValue(expression, context);
  }
  if (targetDescriptor === 'Ljava/util/function/Function;') {
    return lowerFunctionLambdaToJavaIrValue(expression, context);
  }
  return null;
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

function lowerInstanceMethodCall(expression, context, receiverOverride = null) {
  const receiver = receiverOverride || lowerExpressionToJavaIrValue(expression.target, context);
  const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  if (!receiver || !args.every(Boolean)) return null;
  const owner = internalNameFromDescriptor(receiver.type);
  const method = methodDescriptorForInstanceCall(owner, expression.name, args, context);
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

function lowerStatementOnlyInstanceCall(expression, context) {
  if (!expression || expression.kind !== 'MethodInvocationExpression' || !expression.target) return null;
  const receiver = lowerExpressionToJavaIrValue(expression.target, context);
  const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  if (!receiver || !args.every(Boolean)) return null;
  const owner = internalNameFromDescriptor(receiver.type);
  const method = methodDescriptorForInstanceCall(owner, expression.name, args, context);
  return {
    kind: 'MethodCallValue',
    type: method ? method.returnDescriptor : 'V',
    owner,
    name: expression.name,
    descriptor: method ? method.descriptor : `(${args.map((arg) => arg.type).join('')})V`,
    invokeKind: method && method.invokeKind ? method.invokeKind : 'virtual',
    receiver,
    args: method && method.parameterDescriptors
      ? args.map((arg, index) => coerceValueToDescriptor(arg, method.parameterDescriptors[index]))
      : args,
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
  const rawArgs = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  const method = selectUserMethodDescriptor(owner, expression.name, rawArgs, context, true);
  if (!method) return null;
  const args = prepareMethodArguments(method, rawArgs);
  if (!args) return null;
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
      invokeKind: 'static',
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

function lowerExpressionToJavaIrValue(expression, context) {
  const literal = literalToJavaIrValue(expression);
  if (literal) return literal;
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
    const owner = resolveClassInternalNameFromParts(targetParts, context);
    const fields = owner && context.classFieldsByInternalName && context.classFieldsByInternalName.get(owner);
    const field = fields && fields.get(expression.name);
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
  }
  if (expression && expression.kind === 'FieldAccessExpression') {
    const target = lowerExpressionToJavaIrValue(expression.target, context);
    const owner = target ? internalNameFromDescriptor(target.type) : null;
    const fields = context.classFieldsByInternalName && context.classFieldsByInternalName.get(owner);
    const field = fields ? fields.get(expression.name) : (owner === context.classInternalName && context.fieldByName ? context.fieldByName.get(expression.name) : null);
    if (target && field) {
      return {
        kind: 'FieldValue',
        type: field.descriptor,
        owner,
        name: field.name,
        descriptor: field.descriptor,
        receiver: target,
      };
    }
    if (target && owner && typeof target.type === 'string' && target.type.startsWith('L')) {
      return {
        kind: 'FieldValue',
        type: 'Ljava/lang/Object;',
        owner,
        name: expression.name,
        descriptor: 'Ljava/lang/Object;',
        receiver: target,
      };
    }
  }
  if (expression && expression.kind === 'UnsupportedExpression' && Array.isArray(expression.tokens)) {
    return lowerTokenExpressionToJavaIrValue(expression.tokens, context);
  }
  if (expression && expression.kind === 'MethodInvocationExpression'
      && expression.target
      && expression.target.kind === 'UnsupportedExpression'
      && Array.isArray(expression.target.tokens)) {
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
    if (expression.target.tokens.length === 1 && tokenText(expression.target.tokens[0]) === 'new') {
      const owner = constructorOwnerFromName(expression.name, context);
      const captureArgs = constructorCaptureArgs(owner, context);
      const args = (expression.arguments || []).map((argument) => {
        if (owner === 'java/lang/Thread') {
          const value = lowerLambdaToJavaIrValue(argument, 'Ljava/lang/Runnable;', context)
            || lowerExpressionToJavaIrValue(argument, context);
          return value ? coerceValueToDescriptor(value, 'Ljava/lang/Runnable;') : null;
        }
        return lowerExpressionToJavaIrValue(argument, context);
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
      const receiver = lowerTokenExpressionToJavaIrValue(expression.target.tokens.slice(addIndex + 1), context);
      const receiverTokens = expression.target.tokens.slice(addIndex + 1);
      const call = receiver
        ? lowerInstanceMethodCall(expression, context, receiver)
        : (receiverTokens.length === 0
          ? lowerSameClassMethodCall({ ...expression, target: null }, context)
          : receiverTokens.length === 1 && receiverTokens[0].kind === 'identifier'
          ? (lowerKnownStaticMethodCall({ ...expression, target: { kind: 'Identifier', name: receiverTokens[0].text } }, context)
            || lowerStaticWrapperMethodCall(expression, context, receiverTokens[0].text))
          : null);
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
  if (expression && expression.kind === 'MethodInvocationExpression' && expression.target) {
    const call = lowerKnownStaticMethodCall(expression, context) || lowerStaticUserMethodCall(expression, context) || lowerStaticWrapperMethodCall(expression, context);
    if (call) return call;
  }
  if (expression && expression.kind === 'MethodInvocationExpression' && expression.target) {
    return lowerInstanceMethodCall(expression, context);
  }
  return null;
}

function coerceValueToDescriptor(value, descriptor) {
  if (!value || !descriptor || value.type === descriptor) return value;
  if (value.kind === 'ConditionalValue') {
    const consequent = coerceValueToDescriptor(value.consequent, descriptor);
    const alternate = coerceValueToDescriptor(value.alternate, descriptor);
    if (!consequent || !alternate) return value;
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
  const suffix = context.nextLocalId || 0;
  context.nextLocalId = suffix + 1;
  const local = createJavaIrLocal(`local:${name}${suffix ? `$${suffix}` : ''}`, {
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
  const compoundIndex = findTopLevelOperator(normalized, ['+=', '-=']);
  if (compoundIndex === 1 && normalized[0].kind === 'identifier' && context.localByName.has(normalized[0].text)) {
    const local = context.localByName.get(normalized[0].text);
    const right = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(normalized.slice(compoundIndex + 1), context), local.descriptor);
    if (!right) return null;
    return [createJavaIrOp('assign', {
      target: local.id,
      type: local.descriptor,
      value: {
        kind: 'BinaryValue',
        type: local.descriptor,
        operator: tokenText(normalized[compoundIndex]) === '+=' ? '+' : '-',
        left: {
          kind: 'LocalValue',
          type: local.descriptor,
          local: local.id,
          name: local.name,
        },
        right,
      },
      sourceNodeKind: 'ForStatement',
    })];
  }
  if (compoundIndex === 1 && normalized[0].kind === 'identifier' && context.fieldByName && context.fieldByName.has(normalized[0].text)) {
    const field = context.fieldByName.get(normalized[0].text);
    if (!field.isStatic) return null;
    const right = coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(normalized.slice(compoundIndex + 1), context), field.descriptor);
    if (!right) return null;
    return [staticFieldStoreOp({ ...field, owner: context.classInternalName }, {
      kind: 'BinaryValue',
      type: field.descriptor,
      operator: tokenText(normalized[compoundIndex]) === '+=' ? '+' : '-',
      left: fieldValueForContext(field, context),
      right,
    })];
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

function lowerStatementToJavaIrOps(statement, context) {
  if (!statement) return [];
  if (statement.kind === 'BlockStatement') {
    return (statement.statements || []).flatMap((child) => lowerStatementToJavaIrOps(child, context));
  }
  if (statement.kind === 'UnsupportedStatement' && statement.reason === 'local-type-declaration') {
    const ops = lowerLocalClassDeclaration(statement, context);
    if (ops) return ops;
  }
  if (statement.kind === 'ReturnStatement') {
    return [createJavaIrOp('return', {
      value: statement.expression ? lowerExpressionToJavaIrValue(statement.expression, context) || { kind: statement.expression.kind } : null,
      sourceNodeKind: statement.kind,
    })];
  }
  if (statement.kind === 'ThrowStatement') {
    const value = statement.expression ? lowerExpressionToJavaIrValue(statement.expression, context) : null;
    if (!value || typeof value.type !== 'string' || !value.type.startsWith('L')) {
      return [javaIrUnsupported('unsupported throw expression', { sourceNodeKind: statement.expression && statement.expression.kind })];
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
      return [javaIrUnsupported('unsupported if condition', { sourceNodeKind: statement.condition && statement.condition.kind })];
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
      condition,
      bodyOps: lowerStatementToJavaIrOps(statement.body, context),
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
      condition,
      bodyOps: lowerStatementToJavaIrOps(statement.body, context),
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
          : null
    );
    const condition = conditionNode
      ? lowerExpressionToJavaIrValue(conditionNode, context)
      : { kind: 'LiteralValue', type: 'Z', literalKind: 'boolean', value: true, raw: 'true' };
    const updateOps = !updateNode ? [] : (
      updateNode.kind === 'UnsupportedExpression' && Array.isArray(updateNode.tokens)
        ? lowerTokenUpdateToJavaIrOps(updateNode.tokens, context)
        : null
    );
    if (!initOps || !condition || condition.type !== 'Z' || !updateOps) {
      return [javaIrUnsupported('unsupported for loop', { sourceNodeKind: statement.kind })];
    }
    return initOps.concat(createJavaIrOp('loop', {
      condition,
      bodyOps: lowerStatementToJavaIrOps(statement.body, context),
      updateOps,
      sourceNodeKind: statement.kind,
    }));
  }
  if (statement.kind === 'SwitchStatement') {
    const value = lowerExpressionToJavaIrValue(statement.expression, context);
    if (value && typeof value.type === 'string' && value.type.startsWith('L')) {
      return lowerEnumSwitchToJavaIrOps(statement, value, context);
    }
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
    const compoundMethodAssign = lowerCompoundAssignmentMethodCall(expression, context);
    if (compoundMethodAssign) return compoundMethodAssign;
    const value = lowerExpressionToJavaIrValue(expression, context);
    if (value && (value.kind === 'MethodCallValue' || value.kind === 'NewObjectValue')) {
      return [createJavaIrOp('invoke', {
        value,
        sourceNodeKind: statement.kind,
      })];
    }
    const statementCall = lowerStatementOnlyInstanceCall(expression, context);
    if (statementCall) {
      return [createJavaIrOp('invoke', {
        value: statementCall,
        sourceNodeKind: statement.kind,
        meta: { statementOnlyFallback: true },
      })];
    }
    return [createJavaIrOp('expression', {
      sourceNodeKind: statement.expression && statement.expression.kind,
      text: statement.expression && statement.expression.text,
    })];
  }
  if (statement.kind === 'LocalVariableDeclarationStatement') {
    if (statement.variableType
        && statement.variableType.kind === 'ClassType'
        && context.localByName.has(statement.variableType.name)
        && (statement.declarators || []).length === 1
        && statement.declarators[0].initializer) {
      const declarator = statement.declarators[0];
      const receiverLocal = context.localByName.get(statement.variableType.name);
      const owner = internalNameFromDescriptor(receiverLocal.descriptor);
      const fields = context.classFieldsByInternalName && context.classFieldsByInternalName.get(owner);
      const field = fields && fields.get(declarator.name);
      const value = field ? coerceValueToDescriptor(lowerExpressionToJavaIrValue(declarator.initializer, context), field.descriptor) : null;
      if (field && value) {
        return [createJavaIrOp('putField', {
          owner,
          name: field.name,
          descriptor: field.descriptor,
          value,
          args: [localValue(receiverLocal)],
          sourceNodeKind: statement.kind,
          meta: { recoveredFieldAssignment: true },
        })];
      }
    }
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
          || lowerExpressionToJavaIrValue(declarator.initializer, context);
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

function lowerMethodToJavaIr(method, classContext, slotBase = 0) {
  const typeParameters = buildTypeParameterErasureMap(method.typeParameters || [], classContext.typeParameters);
  const typeContext = { typeParameters, classBySimpleName: classContext.classBySimpleName };
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
    currentMethodIsStatic: modifierNames(method.modifiers).includes('static'),
    syntheticClasses: classContext.syntheticClasses,
    allocateLambdaClassName: classContext.allocateLambdaClassName,
    constructorCaptureArgsByOwner: classContext.constructorCaptureArgsByOwner,
  };
  const isAbstract = classContext.isInterface || modifierNames(method.modifiers).includes('abstract');
  let ops = method.body && method.body.kind === 'BlockStatement'
    ? lowerStatementToJavaIrOps(method.body, context)
    : (isAbstract ? [] : [javaIrUnsupported(`method body unavailable for ${method.name}`, { sourceNodeKind: method.kind })]);
  if (method.kind === 'ConstructorDeclaration' && !isConstructorDelegationOp(ops[0], context)) {
    ops = [implicitSuperConstructorOp(context)].concat(ops);
  }
  const block = createJavaIrBlock('entry', {
    kind: 'EntryBlock',
    ops,
    terminator: javaIrReturn(null),
  });
  return createJavaIrMethod({
    name: method.kind === 'ConstructorDeclaration' ? '<init>' : method.name,
    descriptor: methodDescriptor(method, { typeParameters: classContext.typeParameters, classBySimpleName: classContext.classBySimpleName }),
    access: dedupePreservingOrder((classContext.isInterface ? ['public', 'abstract'] : []).concat(modifierNames(method.modifiers))),
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
  const locals = [];
  const localByName = new Map();
  const context = {
    locals,
    localByName,
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
    syntheticClasses: classContext.syntheticClasses,
    allocateLambdaClassName: classContext.allocateLambdaClassName,
  };
  const block = createJavaIrBlock('entry', {
    kind: 'EntryBlock',
    ops: blockMember.body && blockMember.body.kind === 'BlockStatement'
      ? lowerStatementToJavaIrOps(blockMember.body, context)
      : [javaIrUnsupported('initializer body unavailable', { sourceNodeKind: blockMember.kind })],
    terminator: javaIrReturn(null),
  });
  return createJavaIrMethod({
    name: '<clinit>',
    descriptor: '()V',
    access: ['static'],
    parameters: [],
    locals,
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

  const sourcePrelude = sourceDirectoryMetadata(options.sourcePath);
  if (sourcePrelude) {
    for (const [name, internalName] of sourcePrelude.classBySimpleName) {
      if (!classBySimpleName.has(name)) classBySimpleName.set(name, internalName);
    }
  }

  const classMethodsByInternalName = sourcePrelude ? cloneNestedMap(sourcePrelude.classMethodsByInternalName) : new Map();
  const classMethodOverloadsByInternalName = sourcePrelude ? cloneNestedMap(sourcePrelude.classMethodOverloadsByInternalName) : new Map();
  const classFieldsByInternalName = sourcePrelude ? cloneNestedMap(sourcePrelude.classFieldsByInternalName) : new Map();
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
    for (const member of declaration.body || []) {
      if (isClassLikeDeclaration(member)) buildMethodMap(member);
    }
  }
  for (const declaration of document.root.typeDeclarations || []) buildMethodMap(declaration);

  function buildFieldMap(declaration) {
    if (!isClassLikeDeclaration(declaration)) return;
    const internalName = internalNameByDeclaration.get(declaration);
    const classTypeParameters = buildTypeParameterErasureMap(declaration.typeParameters || []);
    const classTypeContext = { typeParameters: classTypeParameters, classBySimpleName };
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
    const classTypeContext = { typeParameters: classTypeParameters, classBySimpleName };
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
        ? dedupePreservingOrder(modifierNames(declaration.modifiers).concat(['final', 'super']))
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
      fieldByName,
      outerClassInternalName: outerClassContext && outerClassContext.classInternalName,
      outerFieldByName: outerClassContext && outerClassContext.fieldByName,
      outerMethodByName: outerClassContext && outerClassContext.methodByName,
      outerThisFieldName: isNonStaticMemberClass ? 'this$0' : null,
      isInterface: isInterface || isAnnotation,
      isEnum,
      superName: classIr.superName,
      typeParameters: classTypeParameters,
      syntheticClasses,
      instanceFieldInitializers: [],
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
          if (!modifierNames(member.modifiers).includes('static') && initializer && initializer.kind === 'LiteralValue') {
            classContext.instanceFieldInitializers.push({
              name: declarator.name,
              descriptor: typeDescriptor(member.fieldType, classTypeContext),
              value: initializer,
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
        classIr.methods.push(lowerInitializerBlockToJavaIr(member, classContext));
      } else if (isClassLikeDeclaration(member)) {
        lowerClassDeclaration(member, classContext);
      } else {
        unsupported.push({ kind: member.kind, owner: declaration.name, reason: 'unsupported-member-declaration' });
      }
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
  return createJavaIrDocument(classes, {
    astSchema: document.schema,
    astVersion: document.version,
    sourceLevel: document.sourceLevel,
    status: unsupported.length ? 'partial' : 'complete',
    unsupported,
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
