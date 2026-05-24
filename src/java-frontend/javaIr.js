'use strict';

const ast = require('./ast');
const { validateAstDocument } = require('./serialization');
const {
  buildTypeParameterErasureMap,
  methodDescriptor,
  methodGenericSignature,
  typeDescriptor,
  typeSignature,
} = require('./compiler');

const JAVA_IR_SCHEMA_ID = 'java-tools.java-frontend.java-ir';
const JAVA_IR_SCHEMA_VERSION = 1;
const JAVA_IR_AST_META_KEY = 'javaFrontendJavaIr';

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
    else if (/[dD]$/.test(raw) || raw.includes('.') || /[eE]/.test(raw)) type = 'D';
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
  if (/[fF]$/.test(text)) return 'F';
  if (/[dD]$/.test(text) || text.includes('.') || /[eE]/.test(text)) return 'D';
  return 'I';
}

function tokenText(token) {
  return token && typeof token.text === 'string' ? token.text : '';
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
  if (context && context.classBySimpleName && context.classBySimpleName.has(name)) {
    return context.classBySimpleName.get(name);
  }
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

function lowerTokenExpressionToJavaIrValue(tokens, context) {
  const normalized = trimParenTokens(tokens || []);
  if (normalized.length === 0) return null;

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

  const equalityIndex = tokenText(normalized[0]) === 'new'
    ? -1
    : findTopLevelOperator(normalized, ['==', '!=', '<=', '>=', '<', '>']);
  if (equalityIndex > 0) {
    const left = lowerTokenExpressionToJavaIrValue(normalized.slice(0, equalityIndex), context);
    const right = lowerTokenExpressionToJavaIrValue(normalized.slice(equalityIndex + 1), context);
    const operator = tokenText(normalized[equalityIndex]);
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
      const closeIndex = index + 2;
      if (closeIndex >= normalized.length || tokenText(normalized[closeIndex]) !== ']') {
        current = null;
        break;
      }
      const component = arrayComponentDescriptor(currentType);
      const indexValue = lowerTokenExpressionToJavaIrValue([normalized[index + 1]], context);
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
      index += 3;
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
      const next = tokenText(normalized[index + 1]);
      const closeIndex = next === ']' ? index + 1 : index + 2;
      if (tokenText(normalized[closeIndex]) !== ']') break;
      if (next !== ']') {
        const count = lowerTokenExpressionToJavaIrValue([normalized[index + 1]], context);
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
    if (name === 'getMethod' && args.length === 1 && args[0].type === 'Ljava/lang/String;') return { descriptor: '(Ljava/lang/String;)Ljava/lang/reflect/Method;', returnDescriptor: 'Ljava/lang/reflect/Method;' };
    if (name === 'getMethod' && args.length === 2) return { descriptor: '(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;', returnDescriptor: 'Ljava/lang/reflect/Method;' };
    if (name === 'getDeclaredMethod' && args.length === 1 && args[0].type === 'Ljava/lang/String;') return { descriptor: '(Ljava/lang/String;)Ljava/lang/reflect/Method;', returnDescriptor: 'Ljava/lang/reflect/Method;' };
    if (name === 'getDeclaredMethod' && args.length === 2 && args[1].type === 'Ljava/lang/Class;') return { descriptor: '(Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/reflect/Method;', returnDescriptor: 'Ljava/lang/reflect/Method;' };
    if (name === 'getDeclaredMethod' && args.length === 2) return { descriptor: '(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;', returnDescriptor: 'Ljava/lang/reflect/Method;' };
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
    return { descriptor: overload.descriptor, returnDescriptor: overload.returnDescriptor };
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
        return { descriptor: method.descriptor, returnDescriptor: method.returnDescriptor };
      }
    }
  }
  return null;
}

function methodMatchesArguments(method, args, isStatic = null) {
  if (!method || !Array.isArray(method.parameterDescriptors) || method.parameterDescriptors.length !== args.length) {
    return false;
  }
  if (isStatic !== null && Boolean(method.isStatic) !== isStatic) return false;
  return args.every((arg, index) => arg && coerceValueToDescriptor(arg, method.parameterDescriptors[index]));
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

function createSyntheticLambdaClass(context, iface, method) {
  const id = context.allocateLambdaClassName ? context.allocateLambdaClassName() : `${context.classInternalName}$Lambda${context.nextLambdaId || 0}`;
  context.nextLambdaId = (context.nextLambdaId || 0) + 1;
  const simpleName = id.split('/').pop();
  const classIr = createJavaIrClass({
    name: simpleName,
    packageName: '',
    internalName: id,
    access: ['final', 'super'],
    superName: 'java/lang/Object',
    interfaces: [iface],
    methods: [method],
    sourceNodeKind: 'LambdaExpression',
    meta: { synthetic: true },
  });
  if (context.syntheticClasses) context.syntheticClasses.push(classIr);
  return {
    kind: 'NewObjectValue',
    type: `L${id};`,
    owner: id,
    descriptor: '()V',
    args: [],
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
  const lambdaContext = {
    ...context,
    locals: [createJavaIrLocal('param:this', {
      name: 'this',
      descriptor: 'Ljava/lang/Runnable;',
      slotHint: 0,
    })],
    localByName: new Map(),
    currentMethodIsStatic: false,
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
  return createSyntheticLambdaClass(context, 'java/lang/Runnable', method);
}

function lowerRunnableLambdaToJavaIrValue(expression, context) {
  if (!expression || expression.kind !== 'MethodInvocationExpression' || expression.name !== 'println') return null;
  const targetTokens = expression.target && expression.target.tokens;
  if (!Array.isArray(targetTokens) || lambdaArrowIndex(targetTokens) < 0) return null;
  const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  if (!args.every(Boolean)) return null;
  const method = createJavaIrMethod({
    name: 'run',
    descriptor: '()V',
    access: ['public'],
    parameters: [],
    locals: [createJavaIrLocal('param:this', {
      name: 'this',
      descriptor: 'Ljava/lang/Runnable;',
      slotHint: 0,
    })],
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
  return createSyntheticLambdaClass(context, 'java/lang/Runnable', method);
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
  return {
    kind: 'MethodCallValue',
    type: method.returnDescriptor,
    owner,
    name: expression.name,
    descriptor: method.descriptor,
    invokeKind: method.invokeKind || 'virtual',
    receiver,
    args,
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
  const owner = constructorOwnerFromName(targetName, context);
  const rawArgs = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  const method = selectUserMethodDescriptor(owner, expression.name, rawArgs, context, true);
  if (!method) return null;
  const args = rawArgs.map((arg, index) => coerceValueToDescriptor(arg, method.parameterDescriptors[index]));
  if (!args.every(Boolean) || args.length !== method.parameterDescriptors.length) return null;
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
  const owner = targetParts.length === 1 ? constructorOwnerFromName(targetParts[0], context) : targetParts.join('/');
  const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  if (!args.every(Boolean)) return null;
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
  if (!expression || expression.kind !== 'MethodInvocationExpression' || expression.target || !context.methodByName.has(expression.name)) {
    return null;
  }
  const rawArgs = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
  const method = selectUserMethodDescriptor(context.classInternalName, expression.name, rawArgs, context, null)
    || context.methodByName.get(expression.name);
  const args = rawArgs.map((arg, index) => coerceValueToDescriptor(arg, method.parameterDescriptors[index]));
  if (method.isStatic && args.every(Boolean) && args.length === method.parameterDescriptors.length) {
    return {
      kind: 'MethodCallValue',
      type: method.returnDescriptor,
      owner: context.classInternalName,
      name: method.name,
      descriptor: method.descriptor,
      invokeKind: 'static',
      args,
    };
  }
  if (!method.isStatic && !context.currentMethodIsStatic && args.every(Boolean) && args.length === method.parameterDescriptors.length) {
    return {
      kind: 'MethodCallValue',
      type: method.returnDescriptor,
      owner: context.classInternalName,
      name: method.name,
      descriptor: method.descriptor,
      invokeKind: 'virtual',
      receiver: {
        kind: 'LocalValue',
        type: `L${context.classInternalName};`,
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
    if (targetParts.length === 1) {
      const owner = constructorOwnerFromName(targetParts[0], context);
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
    const field = owner === context.classInternalName && context.fieldByName ? context.fieldByName.get(expression.name) : null;
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
  }
  if (expression && expression.kind === 'UnsupportedExpression' && Array.isArray(expression.tokens)) {
    return lowerTokenExpressionToJavaIrValue(expression.tokens, context);
  }
  if (expression && expression.kind === 'MethodInvocationExpression'
      && expression.target
      && expression.target.kind === 'UnsupportedExpression'
      && Array.isArray(expression.target.tokens)) {
    if (expression.target.tokens.length === 1 && tokenText(expression.target.tokens[0]) === 'new') {
      const owner = constructorOwnerFromName(expression.name, context);
      const args = (expression.arguments || []).map((argument) => {
        if (owner === 'java/lang/Thread') {
          const value = lowerLambdaToJavaIrValue(argument, 'Ljava/lang/Runnable;', context)
            || lowerExpressionToJavaIrValue(argument, context);
          return value ? coerceValueToDescriptor(value, 'Ljava/lang/Runnable;') : null;
        }
        return lowerExpressionToJavaIrValue(argument, context);
      });
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
  if (expression && expression.kind === 'MethodInvocationExpression' && expression.target && expression.target.kind === 'Identifier') {
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
  if (value.literalKind === 'null' && descriptor.startsWith('L')) {
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
  if (field.isStatic) {
    return {
      kind: 'StaticFieldValue',
      type: field.descriptor,
      owner: context.classInternalName,
      name: field.name,
      descriptor: field.descriptor,
    };
  }
  return {
    kind: 'FieldValue',
    type: field.descriptor,
    owner: context.classInternalName,
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

function lowerStatementToJavaIrOps(statement, context) {
  if (!statement) return [];
  if (statement.kind === 'BlockStatement') {
    return (statement.statements || []).flatMap((child) => lowerStatementToJavaIrOps(child, context));
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
    const initOps = !statement.initializer ? [] : (
      statement.initializer.kind === 'LocalVariableDeclarationStatement'
        ? lowerStatementToJavaIrOps(statement.initializer, context)
        : statement.initializer.kind === 'UnsupportedExpression' && Array.isArray(statement.initializer.tokens)
          ? lowerTokenUpdateToJavaIrOps(statement.initializer.tokens, context)
          : null
    );
    const condition = statement.condition
      ? lowerExpressionToJavaIrValue(statement.condition, context)
      : { kind: 'LiteralValue', type: 'Z', literalKind: 'boolean', value: true, raw: 'true' };
    const updateOps = !statement.update ? [] : (
      statement.update.kind === 'UnsupportedExpression' && Array.isArray(statement.update.tokens)
        ? lowerTokenUpdateToJavaIrOps(statement.update.tokens, context)
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
    if (!iterable || typeof iterable.type !== 'string' || !iterable.type.startsWith('[')) {
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
      const descriptor = typeDescriptor(clause.parameter.parameterType, context);
      if (!descriptor.startsWith('L') || !descriptor.endsWith(';')) {
        return [javaIrUnsupported('unsupported catch type', { sourceNodeKind: clause.parameter.parameterType.kind })];
      }
      const previousLocal = context.localByName.get(clause.parameter.name);
      const local = declareShadowingContextLocal(context, clause.parameter.name, descriptor, null, { catch: true });
      const bodyOps = lowerStatementToJavaIrOps(clause.body, context);
      if (previousLocal) context.localByName.set(clause.parameter.name, previousLocal);
      else context.localByName.delete(clause.parameter.name);
      catches.push({
        type: descriptor.slice(1, -1),
        local: local.id,
        name: local.name,
        descriptor,
        bodyOps: finallyOverridesCompletion ? stripAbruptCompletionOps(bodyOps) : bodyOps,
      });
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
      }
    }
    const value = lowerExpressionToJavaIrValue(expression, context);
    if (value && value.kind === 'MethodCallValue') {
      return [createJavaIrOp('invoke', {
        value,
        sourceNodeKind: statement.kind,
      })];
    }
    return [createJavaIrOp('expression', {
      sourceNodeKind: statement.expression && statement.expression.kind,
      text: statement.expression && statement.expression.text,
    })];
  }
  if (statement.kind === 'LocalVariableDeclarationStatement') {
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
    const descriptor = typeDescriptor(parameter.parameterType, typeContext);
    const signature = typeSignature(parameter.parameterType, typeContext);
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
    typeParameters,
    currentMethodIsStatic: modifierNames(method.modifiers).includes('static'),
    syntheticClasses: classContext.syntheticClasses,
    allocateLambdaClassName: classContext.allocateLambdaClassName,
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

function lowerAstToJavaIr(document, options = {}) {
  validateAstDocument(document);
  const packageName = packageNameForDocument(document);
  const classes = [];
  const syntheticClasses = [];
  const unsupported = [];

  const classBySimpleName = new Map();
  const internalNameByDeclaration = new Map();
  function collectClassNames(declaration, outerInternalName = null) {
    if (declaration.kind !== 'ClassDeclaration' && declaration.kind !== 'InterfaceDeclaration' && declaration.kind !== 'AnnotationTypeDeclaration') return;
    const internalName = outerInternalName
      ? `${outerInternalName}$${declaration.name}`
      : internalNameFromClassName(declaration.name, packageName);
    internalNameByDeclaration.set(declaration, internalName);
    classBySimpleName.set(declaration.name, internalName);
    for (const member of declaration.body || []) {
      if (member.kind === 'ClassDeclaration' || member.kind === 'InterfaceDeclaration' || member.kind === 'AnnotationTypeDeclaration') {
        collectClassNames(member, internalName);
      }
    }
  }
  for (const declaration of document.root.typeDeclarations || []) collectClassNames(declaration);

  const classMethodsByInternalName = new Map();
  const classMethodOverloadsByInternalName = new Map();
  function buildMethodMap(declaration) {
    if (declaration.kind !== 'ClassDeclaration' && declaration.kind !== 'InterfaceDeclaration' && declaration.kind !== 'AnnotationTypeDeclaration') return;
    const classTypeParameters = buildTypeParameterErasureMap(declaration.typeParameters || []);
    const methodByName = new Map();
    const methodOverloadsByName = new Map();
    const descriptorContext = { typeParameters: classTypeParameters, classBySimpleName };
    for (const member of declaration.body || []) {
      if (member.kind === 'MethodDeclaration' || member.kind === 'ConstructorDeclaration') {
        const methodTypeParameters = buildTypeParameterErasureMap(member.typeParameters || [], classTypeParameters);
        const descriptor = methodDescriptor(member, descriptorContext);
        const returnDescriptor = descriptor.slice(descriptor.indexOf(')') + 1);
        const methodName = member.kind === 'ConstructorDeclaration' ? '<init>' : member.name;
        const summary = {
          name: member.kind === 'ConstructorDeclaration' ? '<init>' : member.name,
          descriptor,
          returnDescriptor,
          parameterDescriptors: (member.parameters || []).map((parameter) => typeDescriptor(parameter.parameterType, {
            typeParameters: methodTypeParameters,
            classBySimpleName,
          })),
          isStatic: modifierNames(member.modifiers).includes('static'),
        };
        methodByName.set(methodName, summary);
        if (!methodOverloadsByName.has(methodName)) methodOverloadsByName.set(methodName, []);
        methodOverloadsByName.get(methodName).push(summary);
      }
    }
    classMethodsByInternalName.set(internalNameByDeclaration.get(declaration), methodByName);
    classMethodOverloadsByInternalName.set(internalNameByDeclaration.get(declaration), methodOverloadsByName);
    for (const member of declaration.body || []) {
      if (member.kind === 'ClassDeclaration' || member.kind === 'InterfaceDeclaration' || member.kind === 'AnnotationTypeDeclaration') buildMethodMap(member);
    }
  }
  for (const declaration of document.root.typeDeclarations || []) buildMethodMap(declaration);

  function lowerClassDeclaration(declaration) {
    if (declaration.kind !== 'ClassDeclaration' && declaration.kind !== 'InterfaceDeclaration' && declaration.kind !== 'AnnotationTypeDeclaration') {
      unsupported.push({ kind: declaration.kind, reason: 'unsupported-top-level-declaration' });
      return;
    }
    const isInterface = declaration.kind === 'InterfaceDeclaration';
    const isAnnotation = declaration.kind === 'AnnotationTypeDeclaration';
    const classTypeParameters = buildTypeParameterErasureMap(declaration.typeParameters || []);
    const classTypeContext = { typeParameters: classTypeParameters, classBySimpleName };
    const internalName = internalNameByDeclaration.get(declaration);
    let nextLambdaId = 0;
    const superName = isInterface || isAnnotation || !declaration.extendsType
      ? 'java/lang/Object'
      : typeDescriptor(declaration.extendsType, classTypeContext).slice(1, -1);
    const classIr = createJavaIrClass({
      name: declaration.name,
      packageName,
      internalName,
      access: isInterface || isAnnotation
        ? dedupePreservingOrder(modifierNames(declaration.modifiers).concat(['interface', 'abstract'], isAnnotation ? ['annotation'] : []))
        : dedupePreservingOrder(modifierNames(declaration.modifiers).concat(['super'])),
      superName,
      interfaces: isAnnotation
        ? ['java/lang/annotation/Annotation']
        : isInterface
        ? (declaration.extendsTypes || []).map((type) => classTypeInternalName(type))
        : (declaration.implementsTypes || []).map((type) => classTypeInternalName(type)),
      sourceNodeKind: declaration.kind,
      meta: {
        signature: (declaration.typeParameters || []).length
          ? `<${(declaration.typeParameters || []).map((parameter) => `${parameter.name}:${(parameter.bounds && parameter.bounds[0] ? typeSignature(parameter.bounds[0], classTypeContext) : 'Ljava/lang/Object;')}`).join('')}>Ljava/lang/Object;`
          : null,
        annotations: annotationsMeta(declaration.annotations, { classBySimpleName }),
      },
    });
    const methodByName = classMethodsByInternalName.get(internalName) || new Map();
    const fieldByName = new Map();
    for (const member of declaration.body || []) {
      if (member.kind === 'FieldDeclaration') {
        for (const declarator of member.declarators || []) {
          fieldByName.set(declarator.name, {
            name: declarator.name,
            descriptor: typeDescriptor(member.fieldType, classTypeContext),
            signature: typeSignature(member.fieldType, classTypeContext),
            isStatic: modifierNames(member.modifiers).includes('static'),
          });
        }
      }
    }
    const classContext = {
      className: declaration.name,
      classInternalName: classIr.internalName,
      methodByName,
      classBySimpleName,
      classMethodsByInternalName,
      classMethodOverloadsByInternalName,
      fieldByName,
      isInterface: isInterface || isAnnotation,
      superName: classIr.superName,
      typeParameters: classTypeParameters,
      syntheticClasses,
      allocateLambdaClassName() {
        const id = `${internalName}$Lambda${nextLambdaId}`;
        nextLambdaId += 1;
        return id;
      },
    };
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
        }
      } else if (member.kind === 'MethodDeclaration' || member.kind === 'ConstructorDeclaration') {
        classIr.methods.push(lowerMethodToJavaIr(member, classContext, member.modifiers && modifierNames(member.modifiers).includes('static') ? 0 : 1));
      } else if (member.kind === 'ClassDeclaration' || member.kind === 'InterfaceDeclaration' || member.kind === 'AnnotationTypeDeclaration') {
        lowerClassDeclaration(member);
      } else {
        unsupported.push({ kind: member.kind, owner: declaration.name, reason: 'unsupported-member-declaration' });
      }
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
