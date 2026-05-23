'use strict';

const ast = require('./ast');
const { validateAstDocument } = require('./serialization');
const { typeDescriptor, methodDescriptor } = require('./compiler');

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
  if (!type || type.kind !== 'ClassType') return 'java/lang/Object';
  if (type.packageName) {
    return `${String(type.packageName).replace(/\./g, '/')}/${type.name}`;
  }
  if (type.name === 'String' || type.name === 'Object' || type.name === 'StringBuilder') {
    return `java/lang/${type.name}`;
  }
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
    if (text === ')') depth += 1;
    else if (text === '(') depth -= 1;
    else if (depth === 0 && operators.includes(text)) return i;
  }
  return -1;
}

function flattenConcatParts(value) {
  return value && value.kind === 'StringConcatValue' ? value.parts : [value];
}

function constructorOwnerFromName(name, context) {
  if ([
    'String',
    'Object',
    'StringBuilder',
    'Boolean',
    'Byte',
    'Character',
    'Short',
    'Integer',
    'Long',
    'Float',
    'Double',
  ].includes(name)) return `java/lang/${name}`;
  if (name === context.className) return context.classInternalName;
  return String(name || '').replace(/\./g, '/');
}

function arrayComponentDescriptor(arrayDescriptor) {
  if (typeof arrayDescriptor === 'string' && arrayDescriptor.startsWith('[')) {
    return arrayDescriptor.slice(1);
  }
  return null;
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

function wrapperDescriptorForPrimitive(descriptor) {
  const owner = PRIMITIVE_WRAPPER_BY_DESCRIPTOR[descriptor];
  return owner ? `L${owner};` : null;
}

function primitiveDescriptorForWrapper(descriptor) {
  return WRAPPER_PRIMITIVE_BY_DESCRIPTOR[descriptor] || null;
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
      return {
        kind: 'StringConcatValue',
        type: 'Ljava/lang/String;',
        parts: flattenConcatParts(left).concat(flattenConcatParts(right)),
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
  }
  if (normalized.length === 4
      && normalized[0].kind === 'identifier'
      && tokenText(normalized[1]) === '['
      && tokenText(normalized[3]) === ']'
      && context.localByName.has(normalized[0].text)) {
    const local = context.localByName.get(normalized[0].text);
    const component = arrayComponentDescriptor(local.descriptor);
    const index = lowerTokenExpressionToJavaIrValue([normalized[2]], context);
    if (component && index && index.type === 'I') {
      return {
        kind: 'ArrayLoadValue',
        type: component,
        array: {
          kind: 'LocalValue',
          type: local.descriptor,
          local: local.id,
          name: local.name,
        },
        index,
      };
    }
  }
  if (normalized.length === 5
      && tokenText(normalized[0]) === 'new'
      && tokenText(normalized[2]) === '['
      && tokenText(normalized[4]) === ']') {
    const typeName = tokenText(normalized[1]);
    const count = lowerTokenExpressionToJavaIrValue([normalized[3]], context);
    const primitiveDescriptor = {
      boolean: 'Z',
      byte: 'B',
      char: 'C',
      short: 'S',
      int: 'I',
      long: 'J',
      float: 'F',
      double: 'D',
    }[typeName];
    if (primitiveDescriptor && count && count.type === 'I') {
      return {
        kind: 'NewArrayValue',
        type: `[${primitiveDescriptor}`,
        component: typeName,
        count,
      };
    }
    if (!primitiveDescriptor && count && count.type === 'I') {
      const owner = constructorOwnerFromName(typeName, context);
      return {
        kind: 'NewArrayValue',
        type: `[L${owner};`,
        component: owner,
        reference: true,
        count,
      };
    }
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
  return null;
}

function methodDescriptorForInstanceCall(owner, name, args, context) {
  if (owner === 'java/lang/String') {
    if (name === 'equals' && args.length === 1) return { descriptor: '(Ljava/lang/Object;)Z', returnDescriptor: 'Z' };
    if (name === 'length' && args.length === 0) return { descriptor: '()I', returnDescriptor: 'I' };
    if (name === 'toString' && args.length === 0) return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
  }
  const wrapperPrimitive = primitiveDescriptorForWrapper(`L${owner};`);
  if (wrapperPrimitive && name === UNBOX_METHOD_BY_DESCRIPTOR[wrapperPrimitive] && args.length === 0) {
    return { descriptor: `()${wrapperPrimitive}`, returnDescriptor: wrapperPrimitive };
  }
  if (wrapperPrimitive && name === 'toString' && args.length === 0) {
    return { descriptor: '()Ljava/lang/String;', returnDescriptor: 'Ljava/lang/String;' };
  }
  if (owner === context.classInternalName && context.methodByName.has(name)) {
    const method = context.methodByName.get(name);
    if (!method.isStatic && method.parameterDescriptors.length === args.length) {
      return { descriptor: method.descriptor, returnDescriptor: method.returnDescriptor };
    }
  }
  return null;
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
    invokeKind: 'virtual',
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
      const args = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
      if (args.every(Boolean)) {
        const owner = constructorOwnerFromName(expression.name, context);
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
        : (receiverTokens.length === 1 && receiverTokens[0].kind === 'identifier'
          ? lowerStaticWrapperMethodCall(expression, context, receiverTokens[0].text)
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
        return {
          kind: 'StringConcatValue',
          type: 'Ljava/lang/String;',
          parts: flattenConcatParts(left).concat(call),
        };
      }
    }
  }
  if (expression && expression.kind === 'MethodInvocationExpression' && !expression.target && context.methodByName.has(expression.name)) {
    const method = context.methodByName.get(expression.name);
    const rawArgs = (expression.arguments || []).map((argument) => lowerExpressionToJavaIrValue(argument, context));
    const args = rawArgs.map((arg, index) => coerceValueToDescriptor(arg, method.parameterDescriptors[index]));
    if (method.isStatic && args.every(Boolean) && args.length === method.parameterDescriptors.length) {
      return {
        kind: 'MethodCallValue',
        type: method.returnDescriptor,
        owner: context.classInternalName,
        name: method.name,
        descriptor: method.descriptor,
        invokeKind: method.isStatic ? 'static' : 'virtual',
        args,
      };
    }
  }
  if (expression && expression.kind === 'MethodInvocationExpression' && expression.target && expression.target.kind === 'Identifier') {
    const call = lowerStaticWrapperMethodCall(expression, context);
    if (call) return call;
  }
  if (expression && expression.kind === 'MethodInvocationExpression' && expression.target) {
    return lowerInstanceMethodCall(expression, context);
  }
  return null;
}

function coerceValueToDescriptor(value, descriptor) {
  if (!value || !descriptor || value.type === descriptor) return value;
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

function declareContextLocal(context, name, descriptor, sourceNodeId = null) {
  if (context.localByName.has(name)) {
    return context.localByName.get(name);
  }
  const local = createJavaIrLocal(`local:${name}`, {
    name,
    descriptor,
    slotHint: context.nextSlot,
    sourceNodeId,
  });
  context.nextSlot += localSlotWidth(descriptor);
  context.locals.push(local);
  context.localByName.set(name, local);
  return local;
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
      if (assignIndex === 4
          && tokens[0].kind === 'identifier'
          && tokenText(tokens[1]) === '['
          && tokenText(tokens[3]) === ']'
          && context.localByName.has(tokens[0].text)) {
        const local = context.localByName.get(tokens[0].text);
        const component = arrayComponentDescriptor(local.descriptor);
        const index = lowerTokenExpressionToJavaIrValue([tokens[2]], context);
        const value = component
          ? coerceValueToDescriptor(lowerTokenExpressionToJavaIrValue(tokens.slice(assignIndex + 1), context), component)
          : null;
        if (component && index && index.type === 'I' && value) {
          return [createJavaIrOp('arrayStore', {
            type: component,
            value,
            args: [
              {
                kind: 'LocalValue',
                type: local.descriptor,
                local: local.id,
                name: local.name,
              },
              index,
            ],
            sourceNodeKind: statement.kind,
          })];
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
    const descriptor = typeDescriptor(statement.variableType);
    return (statement.declarators || []).flatMap((declarator) => {
      const local = declareContextLocal(context, declarator.name, descriptor);
      const ops = [createJavaIrOp('declareLocal', {
        target: local.id,
        type: descriptor,
        name: local.name,
        sourceNodeKind: statement.kind,
        meta: { slotHint: local.slotHint, hasInitializer: Boolean(declarator.initializer) },
      })];
      if (declarator.initializer) {
        const value = coerceValueToDescriptor(lowerExpressionToJavaIrValue(declarator.initializer, context), descriptor);
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

function lowerMethodToJavaIr(method, classContext, slotBase = 0) {
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
    const descriptor = typeDescriptor(parameter.parameterType);
    const id = `param:${parameter.name}`;
    const local = createJavaIrLocal(id, { name: parameter.name, descriptor, slotHint: slot });
    parameters.push({ id, name: parameter.name, descriptor, slotHint: slot });
    locals.push(local);
    localByName.set(parameter.name, local);
    slot += descriptor === 'J' || descriptor === 'D' ? 2 : 1;
  }
  const context = {
    locals,
    localByName,
    nextSlot: slot,
    methodByName: classContext.methodByName,
    fieldByName: classContext.fieldByName,
    classInternalName: classContext.classInternalName,
    className: classContext.className,
  };
  const isAbstract = classContext.isInterface || modifierNames(method.modifiers).includes('abstract');
  const ops = method.body && method.body.kind === 'BlockStatement'
    ? lowerStatementToJavaIrOps(method.body, context)
    : (isAbstract ? [] : [javaIrUnsupported(`method body unavailable for ${method.name}`, { sourceNodeKind: method.kind })]);
  const block = createJavaIrBlock('entry', {
    kind: 'EntryBlock',
    ops,
    terminator: javaIrReturn(null),
  });
  return createJavaIrMethod({
    name: method.kind === 'ConstructorDeclaration' ? '<init>' : method.name,
    descriptor: methodDescriptor(method),
    access: dedupePreservingOrder((classContext.isInterface ? ['public', 'abstract'] : []).concat(modifierNames(method.modifiers))),
    parameters,
    locals,
    blocks: [block],
    entryBlockId: 'entry',
    exitBlockId: null,
    sourceNodeKind: method.kind,
  });
}

function lowerAstToJavaIr(document, options = {}) {
  validateAstDocument(document);
  const packageName = packageNameForDocument(document);
  const classes = [];
  const unsupported = [];
  for (const declaration of document.root.typeDeclarations || []) {
    if (declaration.kind !== 'ClassDeclaration' && declaration.kind !== 'InterfaceDeclaration') {
      unsupported.push({ kind: declaration.kind, reason: 'unsupported-top-level-declaration' });
      continue;
    }
    const isInterface = declaration.kind === 'InterfaceDeclaration';
    const classIr = createJavaIrClass({
      name: declaration.name,
      packageName,
      internalName: internalNameFromClassName(declaration.name, packageName),
      access: isInterface
        ? dedupePreservingOrder(modifierNames(declaration.modifiers).concat(['interface', 'abstract']))
        : dedupePreservingOrder(modifierNames(declaration.modifiers).concat(['super'])),
      interfaces: isInterface ? (declaration.extendsTypes || []).map(classTypeInternalName) : [],
      sourceNodeKind: declaration.kind,
    });
    const methodByName = new Map();
    const fieldByName = new Map();
    for (const member of declaration.body || []) {
      if (member.kind === 'FieldDeclaration') {
        for (const declarator of member.declarators || []) {
          fieldByName.set(declarator.name, {
            name: declarator.name,
            descriptor: typeDescriptor(member.fieldType),
          });
        }
      }
    }
    for (const member of declaration.body || []) {
      if (member.kind === 'MethodDeclaration' || member.kind === 'ConstructorDeclaration') {
        const descriptor = methodDescriptor(member);
        const returnDescriptor = descriptor.slice(descriptor.indexOf(')') + 1);
        methodByName.set(member.kind === 'ConstructorDeclaration' ? '<init>' : member.name, {
          name: member.kind === 'ConstructorDeclaration' ? '<init>' : member.name,
          descriptor,
          returnDescriptor,
          parameterDescriptors: (member.parameters || []).map((parameter) => typeDescriptor(parameter.parameterType)),
          isStatic: modifierNames(member.modifiers).includes('static'),
        });
      }
    }
    const classContext = {
      className: declaration.name,
      classInternalName: classIr.internalName,
      methodByName,
      fieldByName,
      isInterface,
    };
    for (const member of declaration.body || []) {
      if (member.kind === 'FieldDeclaration') {
        for (const declarator of member.declarators || []) {
          classIr.fields.push(createJavaIrField({
            name: declarator.name,
            descriptor: typeDescriptor(member.fieldType),
            access: modifierNames(member.modifiers),
            initializer: declarator.initializer ? literalToJavaIrValue(declarator.initializer) || { kind: declarator.initializer.kind } : null,
          }));
        }
      } else if (member.kind === 'MethodDeclaration' || member.kind === 'ConstructorDeclaration') {
        classIr.methods.push(lowerMethodToJavaIr(member, classContext, member.modifiers && modifierNames(member.modifiers).includes('static') ? 0 : 1));
      } else {
        unsupported.push({ kind: member.kind, owner: declaration.name, reason: 'unsupported-member-declaration' });
      }
    }
    classes.push(classIr);
  }
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
