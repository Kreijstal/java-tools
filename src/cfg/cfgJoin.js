'use strict';

const CFG_JOIN_SCHEMA_ID = 'java-tools.cfg.join';
const CFG_JOIN_SCHEMA_VERSION = 1;
const JAVA_CFG_SCHEMA_ID = 'java-tools.java-frontend.cfg';
const JAVA_CFG_SCHEMA_VERSION = 1;
const BYTECODE_CFG_SCHEMA_ID = 'java-tools.bytecode.cfg';
const BYTECODE_CFG_SCHEMA_VERSION = 1;

const CFG_JOIN_AST_META_KEY = 'javaFrontendCfgJoin';

const CFG_JOIN_KINDS = Object.freeze([
  'MethodCfgJoin',
  'InitializerCfgJoin',
  'LambdaCfgJoin',
  'SyntheticCfgJoin',
  'UnknownCfgJoin',
]);

const CFG_CORRESPONDENCE_KINDS = Object.freeze([
  'GraphToGraph',
  'BlockToBlock',
  'NodeToInstructions',
  'StatementToInstructions',
  'ExpressionToInstructions',
  'EdgeToEdge',
  'ExceptionRegionCorrespondence',
  'SyntheticCorrespondence',
  'UnsupportedCorrespondence',
]);

const CFG_JOIN_RELATIONS = Object.freeze([
  'implements',
  'contains',
  'containedBy',
  'conditionOf',
  'trueBranchOf',
  'falseBranchOf',
  'entryOf',
  'exitOf',
  'exceptionHandlerOf',
  'synthetic',
  'unknown',
]);

const CFG_JOIN_CONFIDENCES = Object.freeze([
  'exact',
  'high',
  'medium',
  'low',
  'unknown',
]);

const JOIN_KIND_SET = new Set(CFG_JOIN_KINDS);
const CORRESPONDENCE_KIND_SET = new Set(CFG_CORRESPONDENCE_KINDS);
const RELATION_SET = new Set(CFG_JOIN_RELATIONS);
const CONFIDENCE_SET = new Set(CFG_JOIN_CONFIDENCES);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
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

function cloneJsonValue(value) {
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value));
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

function assertId(id, path = 'id') {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function optionalId(id, path = 'id') {
  if (id !== null && typeof id !== 'undefined') {
    assertId(id, path);
  }
}

function assertKnown(value, set, path, label) {
  if (typeof value !== 'string' || !set.has(value)) {
    throw new TypeError(`${path} must be a known ${label}`);
  }
}

function normalizeStringArray(value, path) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }
  for (let i = 0; i < value.length; i += 1) {
    assertId(value[i], `${path}[${i}]`);
  }
  return value.slice();
}

function normalizeNumberArray(value, path) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }
  for (let i = 0; i < value.length; i += 1) {
    if (!Number.isInteger(value[i])) {
      throw new TypeError(`${path}[${i}] must be an integer`);
    }
  }
  return value.slice();
}

function normalizeMethodKey(method = {}) {
  if (method === null) {
    return null;
  }
  if (!isPlainObject(method)) {
    throw new TypeError('method key must be null or a plain object');
  }
  return omitUndefined({
    owner: method.owner || null,
    name: method.name || null,
    descriptor: method.descriptor || null,
    sourceName: method.sourceName || null,
  });
}

function sameMethodKey(left, right) {
  if (!left || !right) {
    return false;
  }
  for (const field of ['owner', 'name', 'descriptor']) {
    const leftValue = left[field] || null;
    const rightValue = right[field] || null;
    if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
      return false;
    }
  }
  return Boolean((left.name || null) && (right.name || null) && left.name === right.name);
}

function createCfgJoinEndpoint(fields = {}) {
  if (!isPlainObject(fields)) {
    throw new TypeError('CFG join endpoint fields must be a plain object');
  }
  return omitUndefined({
    graphId: fields.graphId || null,
    blockIds: normalizeStringArray(fields.blockIds, 'endpoint.blockIds'),
    nodeIds: normalizeStringArray(fields.nodeIds, 'endpoint.nodeIds'),
    edgeIds: normalizeStringArray(fields.edgeIds, 'endpoint.edgeIds'),
    statementIndexes: normalizeNumberArray(fields.statementIndexes, 'endpoint.statementIndexes'),
    instructionOffsets: normalizeNumberArray(fields.instructionOffsets, 'endpoint.instructionOffsets'),
    roles: normalizeStringArray(fields.roles, 'endpoint.roles'),
    meta: fields.meta,
  });
}

function createCfgCorrespondence(id, fields = {}) {
  assertId(id, 'correspondence id');
  const correspondence = {
    id,
    kind: fields.kind || 'UnsupportedCorrespondence',
    java: createCfgJoinEndpoint(fields.java || {}),
    bytecode: createCfgJoinEndpoint(fields.bytecode || {}),
    relation: fields.relation || 'unknown',
    confidence: fields.confidence || 'unknown',
    evidence: fields.evidence || [],
  };
  if (fields.meta !== undefined) {
    correspondence.meta = omitUndefined(fields.meta);
  }
  return correspondence;
}

function createMethodCfgJoin(id, fields = {}) {
  assertId(id, 'CFG join id');
  const join = {
    id,
    kind: fields.kind || 'MethodCfgJoin',
    method: normalizeMethodKey(fields.method || null),
    javaGraphId: fields.javaGraphId || null,
    bytecodeGraphId: fields.bytecodeGraphId || null,
    correspondences: fields.correspondences || [],
    diagnostics: fields.diagnostics || [],
  };
  if (fields.meta !== undefined) {
    join.meta = omitUndefined(fields.meta);
  }
  return join;
}

function createCfgJoinDocument(joins = [], options = {}) {
  if (!Array.isArray(joins)) {
    throw new TypeError('CFG join document joins must be an array');
  }
  const document = {
    schema: CFG_JOIN_SCHEMA_ID,
    version: CFG_JOIN_SCHEMA_VERSION,
    javaCfg: {
      schema: options.javaCfgSchema || JAVA_CFG_SCHEMA_ID,
      version: options.javaCfgVersion || JAVA_CFG_SCHEMA_VERSION,
    },
    bytecodeCfg: {
      schema: options.bytecodeCfgSchema || BYTECODE_CFG_SCHEMA_ID,
      version: options.bytecodeCfgVersion || BYTECODE_CFG_SCHEMA_VERSION,
    },
    joins,
  };
  if (options.diagnostics !== undefined) {
    document.diagnostics = options.diagnostics;
  }
  if (options.meta !== undefined) {
    document.meta = omitUndefined(options.meta);
  }
  return document;
}

function isCfgJoinDocument(value) {
  return isPlainObject(value)
    && value.schema === CFG_JOIN_SCHEMA_ID
    && value.version === CFG_JOIN_SCHEMA_VERSION
    && Array.isArray(value.joins);
}

function validateMethodKey(method, path) {
  if (method === null || typeof method === 'undefined') {
    return;
  }
  if (!isPlainObject(method)) {
    throw new TypeError(`${path} must be null or a plain object`);
  }
  for (const field of ['owner', 'name', 'descriptor', 'sourceName']) {
    if (method[field] !== null && typeof method[field] !== 'undefined' && typeof method[field] !== 'string') {
      throw new TypeError(`${path}.${field} must be a string, null, or undefined`);
    }
  }
}

function validateEndpoint(endpoint, path) {
  if (!isPlainObject(endpoint)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  optionalId(endpoint.graphId, `${path}.graphId`);
  normalizeStringArray(endpoint.blockIds, `${path}.blockIds`);
  normalizeStringArray(endpoint.nodeIds, `${path}.nodeIds`);
  normalizeStringArray(endpoint.edgeIds, `${path}.edgeIds`);
  normalizeNumberArray(endpoint.statementIndexes, `${path}.statementIndexes`);
  normalizeNumberArray(endpoint.instructionOffsets, `${path}.instructionOffsets`);
  normalizeStringArray(endpoint.roles, `${path}.roles`);
}

function validateEvidence(evidence, path) {
  if (!Array.isArray(evidence)) {
    throw new TypeError(`${path} must be an array`);
  }
  for (let i = 0; i < evidence.length; i += 1) {
    if (!isPlainObject(evidence[i])) {
      throw new TypeError(`${path}[${i}] must be a plain object`);
    }
    if (typeof evidence[i].kind !== 'string' || evidence[i].kind.length === 0) {
      throw new TypeError(`${path}[${i}].kind must be a non-empty string`);
    }
  }
}

function validateCfgCorrespondence(correspondence, path = '$.joins[0].correspondences[0]') {
  if (!isPlainObject(correspondence)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  assertId(correspondence.id, `${path}.id`);
  assertKnown(correspondence.kind, CORRESPONDENCE_KIND_SET, `${path}.kind`, 'CFG correspondence kind');
  validateEndpoint(correspondence.java, `${path}.java`);
  validateEndpoint(correspondence.bytecode, `${path}.bytecode`);
  assertKnown(correspondence.relation, RELATION_SET, `${path}.relation`, 'CFG join relation');
  assertKnown(correspondence.confidence, CONFIDENCE_SET, `${path}.confidence`, 'CFG join confidence`');
  validateEvidence(correspondence.evidence, `${path}.evidence`);
  assertJsonValue(correspondence, path);
  return correspondence;
}

function validateCfgJoin(join, path = '$.joins[0]') {
  if (!isPlainObject(join)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  assertId(join.id, `${path}.id`);
  assertKnown(join.kind, JOIN_KIND_SET, `${path}.kind`, 'CFG join kind');
  validateMethodKey(join.method, `${path}.method`);
  optionalId(join.javaGraphId, `${path}.javaGraphId`);
  optionalId(join.bytecodeGraphId, `${path}.bytecodeGraphId`);
  if (!Array.isArray(join.correspondences)) {
    throw new TypeError(`${path}.correspondences must be an array`);
  }
  const correspondenceIds = new Set();
  for (let i = 0; i < join.correspondences.length; i += 1) {
    const correspondence = join.correspondences[i];
    validateCfgCorrespondence(correspondence, `${path}.correspondences[${i}]`);
    if (correspondenceIds.has(correspondence.id)) {
      throw new TypeError(`${path}.correspondences[${i}].id duplicates correspondence id: ${correspondence.id}`);
    }
    correspondenceIds.add(correspondence.id);
  }
  if (join.diagnostics !== undefined && !Array.isArray(join.diagnostics)) {
    throw new TypeError(`${path}.diagnostics must be an array`);
  }
  assertJsonValue(join, path);
  return join;
}

function validateCfgJoinDocument(document) {
  if (!isPlainObject(document)) {
    throw new TypeError('CFG join document must be a plain object');
  }
  if (document.schema !== CFG_JOIN_SCHEMA_ID) {
    throw new TypeError(`CFG join document schema must be ${CFG_JOIN_SCHEMA_ID}`);
  }
  if (document.version !== CFG_JOIN_SCHEMA_VERSION) {
    throw new TypeError(`CFG join document version must be ${CFG_JOIN_SCHEMA_VERSION}`);
  }
  if (!isPlainObject(document.javaCfg)) {
    throw new TypeError('CFG join document javaCfg must be a plain object');
  }
  if (!isPlainObject(document.bytecodeCfg)) {
    throw new TypeError('CFG join document bytecodeCfg must be a plain object');
  }
  if (!Array.isArray(document.joins)) {
    throw new TypeError('CFG join document joins must be an array');
  }
  const joinIds = new Set();
  for (let i = 0; i < document.joins.length; i += 1) {
    const join = document.joins[i];
    validateCfgJoin(join, `$.joins[${i}]`);
    if (joinIds.has(join.id)) {
      throw new TypeError(`$.joins[${i}].id duplicates CFG join id: ${join.id}`);
    }
    joinIds.add(join.id);
  }
  if (document.diagnostics !== undefined && !Array.isArray(document.diagnostics)) {
    throw new TypeError('CFG join document diagnostics must be an array');
  }
  assertJsonValue(document, '$');
  return document;
}

function graphIdSet(document) {
  if (!document || !Array.isArray(document.graphs)) {
    return new Set();
  }
  return new Set(document.graphs.map((graph) => graph.id));
}

function blockIdSetByGraph(document) {
  const map = new Map();
  if (!document || !Array.isArray(document.graphs)) {
    return map;
  }
  for (const graph of document.graphs) {
    map.set(graph.id, new Set(Array.isArray(graph.blocks) ? graph.blocks.map((block) => block.id) : []));
  }
  return map;
}

function edgeIdSetByGraph(document) {
  const map = new Map();
  if (!document || !Array.isArray(document.graphs)) {
    return map;
  }
  for (const graph of document.graphs) {
    map.set(graph.id, new Set(Array.isArray(graph.edges) ? graph.edges.map((edge) => edge.id) : []));
  }
  return map;
}

function validateEndpointAgainstGraph(endpoint, path, graphIds, blockIdsByGraph, edgeIdsByGraph) {
  if (!endpoint.graphId) {
    return;
  }
  if (!graphIds.has(endpoint.graphId)) {
    throw new TypeError(`${path}.graphId references unknown graph: ${endpoint.graphId}`);
  }
  const blockIds = blockIdsByGraph.get(endpoint.graphId) || new Set();
  const edgeIds = edgeIdsByGraph.get(endpoint.graphId) || new Set();
  for (let i = 0; i < endpoint.blockIds.length; i += 1) {
    if (!blockIds.has(endpoint.blockIds[i])) {
      throw new TypeError(`${path}.blockIds[${i}] references unknown block: ${endpoint.blockIds[i]}`);
    }
  }
  for (let i = 0; i < endpoint.edgeIds.length; i += 1) {
    if (!edgeIds.has(endpoint.edgeIds[i])) {
      throw new TypeError(`${path}.edgeIds[${i}] references unknown edge: ${endpoint.edgeIds[i]}`);
    }
  }
}

function validateCfgJoinAgainstDocuments(joinDocument, javaCfgDocument, bytecodeCfgDocument) {
  validateCfgJoinDocument(joinDocument);
  const javaGraphIds = graphIdSet(javaCfgDocument);
  const bytecodeGraphIds = graphIdSet(bytecodeCfgDocument);
  const javaBlockIdsByGraph = blockIdSetByGraph(javaCfgDocument);
  const bytecodeBlockIdsByGraph = blockIdSetByGraph(bytecodeCfgDocument);
  const javaEdgeIdsByGraph = edgeIdSetByGraph(javaCfgDocument);
  const bytecodeEdgeIdsByGraph = edgeIdSetByGraph(bytecodeCfgDocument);

  for (let i = 0; i < joinDocument.joins.length; i += 1) {
    const join = joinDocument.joins[i];
    if (join.javaGraphId && !javaGraphIds.has(join.javaGraphId)) {
      throw new TypeError(`$.joins[${i}].javaGraphId references unknown Java CFG graph: ${join.javaGraphId}`);
    }
    if (join.bytecodeGraphId && !bytecodeGraphIds.has(join.bytecodeGraphId)) {
      throw new TypeError(`$.joins[${i}].bytecodeGraphId references unknown bytecode CFG graph: ${join.bytecodeGraphId}`);
    }
    for (let j = 0; j < join.correspondences.length; j += 1) {
      const correspondence = join.correspondences[j];
      validateEndpointAgainstGraph(
        correspondence.java,
        `$.joins[${i}].correspondences[${j}].java`,
        javaGraphIds,
        javaBlockIdsByGraph,
        javaEdgeIdsByGraph,
      );
      validateEndpointAgainstGraph(
        correspondence.bytecode,
        `$.joins[${i}].correspondences[${j}].bytecode`,
        bytecodeGraphIds,
        bytecodeBlockIdsByGraph,
        bytecodeEdgeIdsByGraph,
      );
    }
  }
  return joinDocument;
}

function toCfgJoinJson(document, options = {}) {
  if (options.validate !== false) {
    validateCfgJoinDocument(document);
  }
  return stableJsonValue(document);
}

function fromCfgJoinJson(value, options = {}) {
  if (options.validate !== false) {
    validateCfgJoinDocument(value);
  }
  return value;
}

function serializeCfgJoin(document, options = {}) {
  const space = hasOwn(options, 'space') ? options.space : 2;
  return JSON.stringify(toCfgJoinJson(document, options), null, space);
}

function deserializeCfgJoin(serialized, options = {}) {
  const value = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  return fromCfgJoinJson(value, options);
}

function cloneCfgJoin(document, options = {}) {
  return deserializeCfgJoin(serializeCfgJoin(document, options), options);
}

function ensureAstDocumentMeta(astDocument) {
  if (!isPlainObject(astDocument)) {
    throw new TypeError('AST document must be a plain object');
  }
  if (!isPlainObject(astDocument.meta)) {
    astDocument.meta = {};
  }
  return astDocument.meta;
}

function attachCfgJoinDocument(astDocument, joinDocument, options = {}) {
  if (options.validate !== false) {
    validateCfgJoinDocument(joinDocument);
  }
  const meta = ensureAstDocumentMeta(astDocument);
  meta[options.key || CFG_JOIN_AST_META_KEY] = options.clone === false ? joinDocument : toCfgJoinJson(joinDocument);
  return astDocument;
}

function getAttachedCfgJoinDocument(astDocument, options = {}) {
  if (!isPlainObject(astDocument) || !isPlainObject(astDocument.meta)) {
    return null;
  }
  const value = astDocument.meta[options.key || CFG_JOIN_AST_META_KEY];
  return value || null;
}

function detachCfgJoinDocument(astDocument, options = {}) {
  if (isPlainObject(astDocument) && isPlainObject(astDocument.meta)) {
    delete astDocument.meta[options.key || CFG_JOIN_AST_META_KEY];
  }
  return astDocument;
}

module.exports = {
  CFG_JOIN_SCHEMA_ID,
  CFG_JOIN_SCHEMA_VERSION,
  JAVA_CFG_SCHEMA_ID,
  JAVA_CFG_SCHEMA_VERSION,
  BYTECODE_CFG_SCHEMA_ID,
  BYTECODE_CFG_SCHEMA_VERSION,
  CFG_JOIN_AST_META_KEY,
  CFG_JOIN_KINDS,
  CFG_CORRESPONDENCE_KINDS,
  CFG_JOIN_RELATIONS,
  CFG_JOIN_CONFIDENCES,
  createCfgJoinDocument,
  createMethodCfgJoin,
  createCfgCorrespondence,
  createCfgJoinEndpoint,
  normalizeMethodKey,
  sameMethodKey,
  isCfgJoinDocument,
  validateCfgJoinDocument,
  validateCfgJoin,
  validateCfgCorrespondence,
  validateCfgJoinAgainstDocuments,
  toCfgJoinJson,
  fromCfgJoinJson,
  serializeCfgJoin,
  deserializeCfgJoin,
  cloneCfgJoin,
  attachCfgJoinDocument,
  getAttachedCfgJoinDocument,
  detachCfgJoinDocument,
};
