'use strict';

const { isNode } = require('./ast');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function assertJsonAnnotationValue(value, path = 'annotation', seen = new Set()) {
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
      assertJsonAnnotationValue(value[i], `${path}[${i}]`, seen);
    }
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      assertJsonAnnotationValue(value[key], `${path}.${key}`, seen);
    }
  } else {
    throw new TypeError(`${path} contains a non-plain object`);
  }
  seen.delete(value);
}

function cloneJsonValue(value) {
  assertJsonAnnotationValue(value);
  return JSON.parse(JSON.stringify(value));
}

function assertNode(node) {
  if (!isNode(node)) {
    throw new TypeError('Expected a Java AST node');
  }
}

function assertAnnotationKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('Annotation key must be a non-empty string');
  }
}

function ensureNodeMeta(node) {
  assertNode(node);
  if (!isPlainObject(node.meta)) {
    node.meta = {};
  }
  return node.meta;
}

function ensureNodeAnnotations(node) {
  const meta = ensureNodeMeta(node);
  if (!isPlainObject(meta.annotations)) {
    meta.annotations = {};
  }
  return meta.annotations;
}

function annotateNode(node, key, value, options = {}) {
  assertNode(node);
  assertAnnotationKey(key);
  assertJsonAnnotationValue(value);
  const annotations = ensureNodeAnnotations(node);
  annotations[key] = options.clone === false ? value : cloneJsonValue(value);
  return node;
}

function hasNodeAnnotation(node, key) {
  assertNode(node);
  assertAnnotationKey(key);
  return isPlainObject(node.meta)
    && isPlainObject(node.meta.annotations)
    && Object.prototype.hasOwnProperty.call(node.meta.annotations, key);
}

function getNodeAnnotation(node, key, defaultValue = undefined) {
  return hasNodeAnnotation(node, key) ? node.meta.annotations[key] : defaultValue;
}

function removeNodeAnnotation(node, key) {
  assertNode(node);
  assertAnnotationKey(key);
  if (isPlainObject(node.meta) && isPlainObject(node.meta.annotations)) {
    delete node.meta.annotations[key];
  }
  return node;
}

function listNodeAnnotations(node) {
  assertNode(node);
  if (!isPlainObject(node.meta) || !isPlainObject(node.meta.annotations)) {
    return {};
  }
  return cloneJsonValue(node.meta.annotations);
}

function clearNodeAnnotations(node) {
  assertNode(node);
  if (isPlainObject(node.meta)) {
    delete node.meta.annotations;
  }
  return node;
}

function mergeNodeAnnotations(node, annotations, options = {}) {
  assertNode(node);
  if (!isPlainObject(annotations)) {
    throw new TypeError('Annotations must be a plain object');
  }
  for (const [key, value] of Object.entries(annotations)) {
    if (!options.overwrite && hasNodeAnnotation(node, key)) {
      continue;
    }
    annotateNode(node, key, value, options);
  }
  return node;
}

module.exports = {
  annotateNode,
  hasNodeAnnotation,
  getNodeAnnotation,
  removeNodeAnnotation,
  listNodeAnnotations,
  clearNodeAnnotations,
  mergeNodeAnnotations,
  ensureNodeMeta,
  ensureNodeAnnotations,
  assertJsonAnnotationValue,
};
