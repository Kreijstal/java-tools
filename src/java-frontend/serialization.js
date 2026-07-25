'use strict';

const {
  AST_SCHEMA_ID,
  AST_SCHEMA_VERSION,
  ALL_NODE_KINDS,
  isNode,
  isAstDocument,
} = require('./ast');

const NODE_KIND_SET = new Set(ALL_NODE_KINDS);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
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

function validateAstNode(node, path = '$.root', seen = new Set()) {
  if (seen.has(node)) {
    throw new TypeError(`${path} contains a cycle`);
  }
  if (!isPlainObject(node)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  seen.add(node);
  if (typeof node.kind !== 'string') {
    throw new TypeError(`${path}.kind must be a string`);
  }
  if (!NODE_KIND_SET.has(node.kind)) {
    throw new TypeError(`${path}.kind is not part of the Java AST schema: ${node.kind}`);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'kind') {
      continue;
    }
    validateAstValue(value, `${path}.${key}`, seen);
  }
  seen.delete(node);
}

function validateAstValue(value, path, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      validateAstValue(value[i], `${path}[${i}]`, seen);
    }
    return;
  }
  if (isNode(value)) {
    validateAstNode(value, path, seen);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      validateAstValue(child, `${path}.${key}`, seen);
    }
    return;
  }
  throw new TypeError(`${path} contains a non-serializable AST value`);
}

function validateAstDocument(document) {
  if (!isPlainObject(document)) {
    throw new TypeError('AST document must be a plain object');
  }
  if (document.schema !== AST_SCHEMA_ID) {
    throw new TypeError(`AST document schema must be ${AST_SCHEMA_ID}`);
  }
  if (document.version !== AST_SCHEMA_VERSION) {
    throw new TypeError(`AST document version must be ${AST_SCHEMA_VERSION}`);
  }
  validateAstNode(document.root, '$.root', new Set());
  assertJsonValue(document, '$');
  return document;
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

function toAstJson(document, options = {}) {
  if (options.validate !== false) {
    validateAstDocument(document);
  }
  return stableJsonValue(document);
}

function serializeAst(document, options = {}) {
  const space = Object.prototype.hasOwnProperty.call(options, 'space') ? options.space : 2;
  return JSON.stringify(toAstJson(document, options), null, space);
}

function fromAstJson(value, options = {}) {
  if (options.validate !== false) {
    validateAstDocument(value);
  }
  return value;
}

function deserializeAst(serialized, options = {}) {
  const value = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  return fromAstJson(value, options);
}

function cloneAst(document, options = {}) {
  return deserializeAst(serializeAst(document, options), options);
}

module.exports = {
  validateAstDocument,
  validateAstNode,
  toAstJson,
  fromAstJson,
  serializeAst,
  deserializeAst,
  cloneAst,
};
