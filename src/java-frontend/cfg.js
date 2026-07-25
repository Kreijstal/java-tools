'use strict';

const ast = require('./ast');
const {
  annotateNode,
  getNodeAnnotation,
  hasNodeAnnotation,
  removeNodeAnnotation,
} = require('./annotations');

const CFG_SCHEMA_ID = 'java-tools.java-frontend.cfg';
const CFG_SCHEMA_VERSION = 1;
const CFG_AST_META_KEY = 'javaFrontendCfg';
const CFG_NODE_ANNOTATION_KEY = 'frontend.cfg';

const CFG_GRAPH_KINDS = Object.freeze([
  'MethodCfg',
  'ConstructorCfg',
  'InitializerCfg',
  'LambdaCfg',
  'ExpressionCfg',
  'SyntheticCfg',
  'UnknownCfg',
]);

const CFG_BLOCK_KINDS = Object.freeze([
  'EntryBlock',
  'ExitBlock',
  'BasicBlock',
  'ConditionBlock',
  'SwitchDispatchBlock',
  'ExceptionDispatchBlock',
  'FinallyBlock',
  'SyntheticBlock',
  'UnsupportedBlock',
]);

const CFG_EDGE_KINDS = Object.freeze([
  'normal',
  'true',
  'false',
  'case',
  'default',
  'exception',
  'finally',
  'break',
  'continue',
  'return',
  'throw',
  'synthetic',
  'unsupported',
]);

const CFG_TERMINATOR_KINDS = Object.freeze([
  'None',
  'Goto',
  'ConditionalBranch',
  'SwitchBranch',
  'Return',
  'Throw',
  'Exit',
  'Unreachable',
  'UnsupportedTerminator',
]);

const CFG_STATEMENT_REF_KINDS = Object.freeze([
  'AstStatement',
  'AstExpression',
  'SyntheticStatement',
  'UnsupportedStatementRef',
]);

const GRAPH_KIND_SET = new Set(CFG_GRAPH_KINDS);
const BLOCK_KIND_SET = new Set(CFG_BLOCK_KINDS);
const EDGE_KIND_SET = new Set(CFG_EDGE_KINDS);
const TERMINATOR_KIND_SET = new Set(CFG_TERMINATOR_KINDS);
const STATEMENT_REF_KIND_SET = new Set(CFG_STATEMENT_REF_KINDS);

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

function createCfgDocument(graphs = [], options = {}) {
  if (!Array.isArray(graphs)) {
    throw new TypeError('CFG document graphs must be an array');
  }
  const document = {
    schema: CFG_SCHEMA_ID,
    version: CFG_SCHEMA_VERSION,
    astSchema: options.astSchema || ast.AST_SCHEMA_ID,
    astVersion: options.astVersion || ast.AST_SCHEMA_VERSION,
    graphs,
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

function createCfgGraph(id, fields = {}) {
  assertId(id, 'graph id');
  const graph = {
    id,
    kind: fields.kind || 'UnknownCfg',
    ownerNodeId: fields.ownerNodeId || null,
    ownerKind: fields.ownerKind || null,
    ownerName: fields.ownerName || null,
    entryBlockId: fields.entryBlockId || null,
    exitBlockId: fields.exitBlockId || null,
    blocks: fields.blocks || [],
    edges: fields.edges || [],
  };
  if (fields.exceptionHandlers !== undefined) {
    graph.exceptionHandlers = fields.exceptionHandlers;
  }
  if (fields.meta !== undefined) {
    graph.meta = omitUndefined(fields.meta);
  }
  return graph;
}

function createCfgBlock(id, fields = {}) {
  assertId(id, 'block id');
  const block = {
    id,
    kind: fields.kind || 'BasicBlock',
    astNodeIds: fields.astNodeIds || [],
    statements: fields.statements || [],
    terminator: hasOwn(fields, 'terminator') ? fields.terminator : null,
  };
  if (fields.label !== undefined) {
    block.label = fields.label;
  }
  if (fields.meta !== undefined) {
    block.meta = omitUndefined(fields.meta);
  }
  return block;
}

function createCfgEdge(id, from, to, fields = {}) {
  assertId(id, 'edge id');
  assertId(from, 'edge from block id');
  assertId(to, 'edge to block id');
  const edge = {
    id,
    from,
    to,
    kind: fields.kind || 'normal',
  };
  if (fields.label !== undefined) {
    edge.label = fields.label;
  }
  if (fields.sourceNodeId !== undefined) {
    edge.sourceNodeId = fields.sourceNodeId;
  }
  if (fields.conditionNodeId !== undefined) {
    edge.conditionNodeId = fields.conditionNodeId;
  }
  if (fields.caseValue !== undefined) {
    edge.caseValue = fields.caseValue;
  }
  if (fields.exceptionType !== undefined) {
    edge.exceptionType = fields.exceptionType;
  }
  if (fields.meta !== undefined) {
    edge.meta = omitUndefined(fields.meta);
  }
  return edge;
}

function createAstStatementRef(nodeId, fields = {}) {
  assertId(nodeId, 'statement node id');
  return omitUndefined({
    kind: fields.kind || 'AstStatement',
    nodeId,
    role: fields.role || null,
    text: fields.text,
    meta: fields.meta,
  });
}

function createAstExpressionRef(nodeId, fields = {}) {
  assertId(nodeId, 'expression node id');
  return omitUndefined({
    kind: 'AstExpression',
    nodeId,
    role: fields.role || null,
    text: fields.text,
    meta: fields.meta,
  });
}

function createSyntheticStatementRef(id, text = null, fields = {}) {
  assertId(id, 'synthetic statement id');
  return omitUndefined({
    kind: 'SyntheticStatement',
    id,
    text,
    role: fields.role || null,
    meta: fields.meta,
  });
}

function noneTerminator(fields = {}) {
  return omitUndefined({ kind: 'None', meta: fields.meta });
}

function gotoTerminator(target, fields = {}) {
  assertId(target, 'goto target');
  return omitUndefined({ kind: 'Goto', target, label: fields.label, meta: fields.meta });
}

function conditionalBranchTerminator(conditionNodeId, trueTarget, falseTarget, fields = {}) {
  assertId(conditionNodeId, 'conditional branch condition node id');
  assertId(trueTarget, 'conditional branch true target');
  assertId(falseTarget, 'conditional branch false target');
  return omitUndefined({
    kind: 'ConditionalBranch',
    conditionNodeId,
    trueTarget,
    falseTarget,
    inverted: Boolean(fields.inverted),
    meta: fields.meta,
  });
}

function switchBranchTerminator(discriminantNodeId, cases = [], defaultTarget = null, fields = {}) {
  assertId(discriminantNodeId, 'switch discriminant node id');
  if (!Array.isArray(cases)) {
    throw new TypeError('switch branch cases must be an array');
  }
  optionalId(defaultTarget, 'switch default target');
  return omitUndefined({
    kind: 'SwitchBranch',
    discriminantNodeId,
    cases: cases.map((entry, index) => {
      if (!isPlainObject(entry)) {
        throw new TypeError(`switch branch case ${index} must be a plain object`);
      }
      assertId(entry.target, `switch branch case ${index} target`);
      return omitUndefined({
        label: entry.label,
        caseValue: entry.caseValue,
        target: entry.target,
        sourceNodeId: entry.sourceNodeId,
      });
    }),
    defaultTarget,
    meta: fields.meta,
  });
}

function returnTerminator(expressionNodeId = null, fields = {}) {
  optionalId(expressionNodeId, 'return expression node id');
  return omitUndefined({
    kind: 'Return',
    expressionNodeId,
    target: fields.target || null,
    meta: fields.meta,
  });
}

function throwTerminator(expressionNodeId = null, fields = {}) {
  optionalId(expressionNodeId, 'throw expression node id');
  return omitUndefined({
    kind: 'Throw',
    expressionNodeId,
    target: fields.target || null,
    exceptionType: fields.exceptionType || null,
    meta: fields.meta,
  });
}

function exitTerminator(fields = {}) {
  return omitUndefined({ kind: 'Exit', meta: fields.meta });
}

function unreachableTerminator(fields = {}) {
  return omitUndefined({ kind: 'Unreachable', reason: fields.reason || null, meta: fields.meta });
}

function unsupportedTerminator(reason, fields = {}) {
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new TypeError('unsupported terminator reason must be a non-empty string');
  }
  return omitUndefined({
    kind: 'UnsupportedTerminator',
    reason,
    text: fields.text || null,
    target: fields.target || null,
    meta: fields.meta,
  });
}

function isCfgDocument(value) {
  return isPlainObject(value)
    && value.schema === CFG_SCHEMA_ID
    && value.version === CFG_SCHEMA_VERSION
    && Array.isArray(value.graphs);
}

function isCfgGraph(value) {
  return isPlainObject(value)
    && typeof value.id === 'string'
    && GRAPH_KIND_SET.has(value.kind)
    && Array.isArray(value.blocks)
    && Array.isArray(value.edges);
}

function isCfgBlock(value) {
  return isPlainObject(value)
    && typeof value.id === 'string'
    && BLOCK_KIND_SET.has(value.kind)
    && Array.isArray(value.astNodeIds)
    && Array.isArray(value.statements);
}

function isCfgEdge(value) {
  return isPlainObject(value)
    && typeof value.id === 'string'
    && typeof value.from === 'string'
    && typeof value.to === 'string'
    && EDGE_KIND_SET.has(value.kind);
}

function validateStringArray(value, path) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }
  for (let i = 0; i < value.length; i += 1) {
    assertId(value[i], `${path}[${i}]`);
  }
}

function validateStatementRef(statement, path) {
  if (!isPlainObject(statement)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  assertKnown(statement.kind, STATEMENT_REF_KIND_SET, `${path}.kind`, 'CFG statement reference kind');
  if (statement.kind === 'AstStatement' || statement.kind === 'AstExpression') {
    assertId(statement.nodeId, `${path}.nodeId`);
  }
  if (statement.kind === 'SyntheticStatement') {
    assertId(statement.id, `${path}.id`);
  }
  if (statement.kind === 'UnsupportedStatementRef' && typeof statement.reason !== 'string') {
    throw new TypeError(`${path}.reason must be a string`);
  }
}

function validateTerminator(terminator, path, blockIds) {
  if (terminator === null) {
    return;
  }
  if (!isPlainObject(terminator)) {
    throw new TypeError(`${path} must be null or a plain object`);
  }
  assertKnown(terminator.kind, TERMINATOR_KIND_SET, `${path}.kind`, 'CFG terminator kind');

  const assertTarget = (target, targetPath) => {
    assertId(target, targetPath);
    if (!blockIds.has(target)) {
      throw new TypeError(`${targetPath} references unknown block: ${target}`);
    }
  };

  switch (terminator.kind) {
    case 'None':
    case 'Exit':
    case 'Unreachable':
      break;
    case 'Goto':
      assertTarget(terminator.target, `${path}.target`);
      break;
    case 'ConditionalBranch':
      assertId(terminator.conditionNodeId, `${path}.conditionNodeId`);
      assertTarget(terminator.trueTarget, `${path}.trueTarget`);
      assertTarget(terminator.falseTarget, `${path}.falseTarget`);
      break;
    case 'SwitchBranch':
      assertId(terminator.discriminantNodeId, `${path}.discriminantNodeId`);
      if (!Array.isArray(terminator.cases)) {
        throw new TypeError(`${path}.cases must be an array`);
      }
      for (let i = 0; i < terminator.cases.length; i += 1) {
        const entry = terminator.cases[i];
        if (!isPlainObject(entry)) {
          throw new TypeError(`${path}.cases[${i}] must be a plain object`);
        }
        assertTarget(entry.target, `${path}.cases[${i}].target`);
      }
      if (terminator.defaultTarget !== null && typeof terminator.defaultTarget !== 'undefined') {
        assertTarget(terminator.defaultTarget, `${path}.defaultTarget`);
      }
      break;
    case 'Return':
      optionalId(terminator.expressionNodeId, `${path}.expressionNodeId`);
      if (terminator.target !== null && typeof terminator.target !== 'undefined') {
        assertTarget(terminator.target, `${path}.target`);
      }
      break;
    case 'Throw':
      optionalId(terminator.expressionNodeId, `${path}.expressionNodeId`);
      if (terminator.target !== null && typeof terminator.target !== 'undefined') {
        assertTarget(terminator.target, `${path}.target`);
      }
      break;
    case 'UnsupportedTerminator':
      if (typeof terminator.reason !== 'string' || terminator.reason.length === 0) {
        throw new TypeError(`${path}.reason must be a non-empty string`);
      }
      if (terminator.target !== null && typeof terminator.target !== 'undefined') {
        assertTarget(terminator.target, `${path}.target`);
      }
      break;
    default:
      throw new TypeError(`${path}.kind is not supported: ${terminator.kind}`);
  }
}

function validateCfgBlock(block, path, blockIds) {
  if (!isPlainObject(block)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  assertId(block.id, `${path}.id`);
  assertKnown(block.kind, BLOCK_KIND_SET, `${path}.kind`, 'CFG block kind');
  validateStringArray(block.astNodeIds, `${path}.astNodeIds`);
  if (!Array.isArray(block.statements)) {
    throw new TypeError(`${path}.statements must be an array`);
  }
  for (let i = 0; i < block.statements.length; i += 1) {
    validateStatementRef(block.statements[i], `${path}.statements[${i}]`);
  }
  validateTerminator(block.terminator || null, `${path}.terminator`, blockIds);
}

function validateCfgEdge(edge, path, blockIds) {
  if (!isPlainObject(edge)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  assertId(edge.id, `${path}.id`);
  assertId(edge.from, `${path}.from`);
  assertId(edge.to, `${path}.to`);
  if (!blockIds.has(edge.from)) {
    throw new TypeError(`${path}.from references unknown block: ${edge.from}`);
  }
  if (!blockIds.has(edge.to)) {
    throw new TypeError(`${path}.to references unknown block: ${edge.to}`);
  }
  assertKnown(edge.kind, EDGE_KIND_SET, `${path}.kind`, 'CFG edge kind');
  optionalId(edge.sourceNodeId, `${path}.sourceNodeId`);
  optionalId(edge.conditionNodeId, `${path}.conditionNodeId`);
}

function validateCfgGraph(graph, path = '$.graphs[0]') {
  if (!isPlainObject(graph)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  assertId(graph.id, `${path}.id`);
  assertKnown(graph.kind, GRAPH_KIND_SET, `${path}.kind`, 'CFG graph kind');
  optionalId(graph.ownerNodeId, `${path}.ownerNodeId`);
  optionalId(graph.entryBlockId, `${path}.entryBlockId`);
  optionalId(graph.exitBlockId, `${path}.exitBlockId`);

  if (!Array.isArray(graph.blocks)) {
    throw new TypeError(`${path}.blocks must be an array`);
  }
  if (!Array.isArray(graph.edges)) {
    throw new TypeError(`${path}.edges must be an array`);
  }

  const blockIds = new Set();
  for (let i = 0; i < graph.blocks.length; i += 1) {
    const block = graph.blocks[i];
    assertId(block && block.id, `${path}.blocks[${i}].id`);
    if (blockIds.has(block.id)) {
      throw new TypeError(`${path}.blocks[${i}].id duplicates block id: ${block.id}`);
    }
    blockIds.add(block.id);
  }

  if (graph.entryBlockId !== null && typeof graph.entryBlockId !== 'undefined' && !blockIds.has(graph.entryBlockId)) {
    throw new TypeError(`${path}.entryBlockId references unknown block: ${graph.entryBlockId}`);
  }
  if (graph.exitBlockId !== null && typeof graph.exitBlockId !== 'undefined' && !blockIds.has(graph.exitBlockId)) {
    throw new TypeError(`${path}.exitBlockId references unknown block: ${graph.exitBlockId}`);
  }

  for (let i = 0; i < graph.blocks.length; i += 1) {
    validateCfgBlock(graph.blocks[i], `${path}.blocks[${i}]`, blockIds);
  }

  const edgeIds = new Set();
  for (let i = 0; i < graph.edges.length; i += 1) {
    const edge = graph.edges[i];
    assertId(edge && edge.id, `${path}.edges[${i}].id`);
    if (edgeIds.has(edge.id)) {
      throw new TypeError(`${path}.edges[${i}].id duplicates edge id: ${edge.id}`);
    }
    edgeIds.add(edge.id);
    validateCfgEdge(edge, `${path}.edges[${i}]`, blockIds);
  }

  if (graph.exceptionHandlers !== undefined) {
    if (!Array.isArray(graph.exceptionHandlers)) {
      throw new TypeError(`${path}.exceptionHandlers must be an array`);
    }
    for (let i = 0; i < graph.exceptionHandlers.length; i += 1) {
      const handler = graph.exceptionHandlers[i];
      if (!isPlainObject(handler)) {
        throw new TypeError(`${path}.exceptionHandlers[${i}] must be a plain object`);
      }
      assertTargetInSet(handler.tryStartBlockId, blockIds, `${path}.exceptionHandlers[${i}].tryStartBlockId`);
      assertTargetInSet(handler.tryEndBlockId, blockIds, `${path}.exceptionHandlers[${i}].tryEndBlockId`);
      assertTargetInSet(handler.handlerBlockId, blockIds, `${path}.exceptionHandlers[${i}].handlerBlockId`);
    }
  }

  return graph;
}

function assertTargetInSet(target, set, path) {
  assertId(target, path);
  if (!set.has(target)) {
    throw new TypeError(`${path} references unknown block: ${target}`);
  }
}

function validateCfgDocument(document) {
  if (!isPlainObject(document)) {
    throw new TypeError('CFG document must be a plain object');
  }
  if (document.schema !== CFG_SCHEMA_ID) {
    throw new TypeError(`CFG document schema must be ${CFG_SCHEMA_ID}`);
  }
  if (document.version !== CFG_SCHEMA_VERSION) {
    throw new TypeError(`CFG document version must be ${CFG_SCHEMA_VERSION}`);
  }
  if (document.astSchema !== undefined && document.astSchema !== ast.AST_SCHEMA_ID) {
    throw new TypeError(`CFG document astSchema must be ${ast.AST_SCHEMA_ID}`);
  }
  if (document.astVersion !== undefined && document.astVersion !== ast.AST_SCHEMA_VERSION) {
    throw new TypeError(`CFG document astVersion must be ${ast.AST_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(document.graphs)) {
    throw new TypeError('CFG document graphs must be an array');
  }
  const graphIds = new Set();
  for (let i = 0; i < document.graphs.length; i += 1) {
    const graph = document.graphs[i];
    assertId(graph && graph.id, `$.graphs[${i}].id`);
    if (graphIds.has(graph.id)) {
      throw new TypeError(`$.graphs[${i}].id duplicates graph id: ${graph.id}`);
    }
    graphIds.add(graph.id);
    validateCfgGraph(graph, `$.graphs[${i}]`);
  }
  assertJsonValue(document, '$');
  return document;
}

function toCfgJson(document, options = {}) {
  if (options.validate !== false) {
    validateCfgDocument(document);
  }
  return stableJsonValue(document);
}

function serializeCfg(document, options = {}) {
  const space = hasOwn(options, 'space') ? options.space : 2;
  return JSON.stringify(toCfgJson(document, options), null, space);
}

function fromCfgJson(value, options = {}) {
  if (options.validate !== false) {
    validateCfgDocument(value);
  }
  return value;
}

function deserializeCfg(serialized, options = {}) {
  const value = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  return fromCfgJson(value, options);
}

function cloneCfg(document, options = {}) {
  return deserializeCfg(serializeCfg(document, options), options);
}

function ensureDocumentMeta(document) {
  if (!ast.isAstDocument(document)) {
    throw new TypeError('Expected a Java AST document');
  }
  if (!isPlainObject(document.meta)) {
    document.meta = {};
  }
  return document.meta;
}

function attachCfgDocument(astDocument, cfgDocument, options = {}) {
  const meta = ensureDocumentMeta(astDocument);
  const json = toCfgJson(cfgDocument, options);
  meta[options.key || CFG_AST_META_KEY] = options.clone === false ? json : cloneJsonValue(json);
  return astDocument;
}

function getAttachedCfgDocument(astDocument, options = {}) {
  if (!ast.isAstDocument(astDocument)) {
    throw new TypeError('Expected a Java AST document');
  }
  const key = options.key || CFG_AST_META_KEY;
  if (!isPlainObject(astDocument.meta) || !hasOwn(astDocument.meta, key)) {
    return null;
  }
  const value = astDocument.meta[key];
  if (options.validate !== false) {
    validateCfgDocument(value);
  }
  return options.clone === false ? value : cloneCfg(value, { validate: options.validate });
}

function detachCfgDocument(astDocument, options = {}) {
  if (!ast.isAstDocument(astDocument)) {
    throw new TypeError('Expected a Java AST document');
  }
  if (isPlainObject(astDocument.meta)) {
    delete astDocument.meta[options.key || CFG_AST_META_KEY];
  }
  return astDocument;
}

function annotateNodeWithCfgLocation(node, location, options = {}) {
  if (!isPlainObject(location)) {
    throw new TypeError('CFG location must be a plain object');
  }
  assertId(location.graphId, 'CFG location graphId');
  optionalId(location.blockId, 'CFG location blockId');
  optionalId(location.edgeId, 'CFG location edgeId');
  if (location.statementIndex !== undefined && (!Number.isInteger(location.statementIndex) || location.statementIndex < 0)) {
    throw new TypeError('CFG location statementIndex must be a non-negative integer');
  }
  const value = omitUndefined({
    graphId: location.graphId,
    blockId: location.blockId || null,
    edgeId: location.edgeId || null,
    statementIndex: location.statementIndex,
    role: location.role || null,
  });
  return annotateNode(node, options.key || CFG_NODE_ANNOTATION_KEY, value, options);
}

function getNodeCfgLocation(node, options = {}) {
  return getNodeAnnotation(node, options.key || CFG_NODE_ANNOTATION_KEY, null);
}

function hasNodeCfgLocation(node, options = {}) {
  return hasNodeAnnotation(node, options.key || CFG_NODE_ANNOTATION_KEY);
}

function removeNodeCfgLocation(node, options = {}) {
  return removeNodeAnnotation(node, options.key || CFG_NODE_ANNOTATION_KEY);
}

class JavaCfgBuilder {
  constructor(id, fields = {}) {
    this.graph = createCfgGraph(id, fields);
    this.nextBlockIndex = 0;
    this.nextEdgeIndex = 0;
  }

  block(kind = 'BasicBlock', fields = {}) {
    const id = fields.id || `b${this.nextBlockIndex}`;
    this.nextBlockIndex += 1;
    const block = createCfgBlock(id, { ...fields, kind });
    this.graph.blocks.push(block);
    if (kind === 'EntryBlock' && !this.graph.entryBlockId) {
      this.graph.entryBlockId = id;
    }
    if (kind === 'ExitBlock' && !this.graph.exitBlockId) {
      this.graph.exitBlockId = id;
    }
    return block;
  }

  edge(from, to, kind = 'normal', fields = {}) {
    const fromId = typeof from === 'string' ? from : from.id;
    const toId = typeof to === 'string' ? to : to.id;
    const id = fields.id || `e${this.nextEdgeIndex}`;
    this.nextEdgeIndex += 1;
    const edge = createCfgEdge(id, fromId, toId, { ...fields, kind });
    this.graph.edges.push(edge);
    return edge;
  }

  setEntry(block) {
    this.graph.entryBlockId = typeof block === 'string' ? block : block.id;
    return this;
  }

  setExit(block) {
    this.graph.exitBlockId = typeof block === 'string' ? block : block.id;
    return this;
  }

  setTerminator(block, terminator) {
    const blockId = typeof block === 'string' ? block : block.id;
    const target = this.graph.blocks.find((candidate) => candidate.id === blockId);
    if (!target) {
      throw new Error(`Cannot set terminator for unknown block: ${blockId}`);
    }
    target.terminator = terminator;
    return this;
  }

  toGraph(options = {}) {
    if (options.validate !== false) {
      validateCfgGraph(this.graph, '$.graph');
    }
    return options.clone === false ? this.graph : cloneJsonValue(this.graph);
  }
}

function createCfgBuilder(id, fields = {}) {
  return new JavaCfgBuilder(id, fields);
}

function createInitializeCfgDocumentPass(options = {}) {
  return {
    name: options.name || 'frontend.initializeCfgDocument',
    phase: 'analysis',
    description: 'Attaches an empty serializable CFG sidecar document to the Java AST document.',
    dependsOn: options.dependsOn || [],
    run(document) {
      const cfg = createCfgDocument([], {
        sourceLevel: document.sourceLevel,
        meta: options.meta || {},
      });
      attachCfgDocument(document, cfg, options.attach || {});
      return document;
    },
  };
}

module.exports = {
  CFG_SCHEMA_ID,
  CFG_SCHEMA_VERSION,
  CFG_AST_META_KEY,
  CFG_NODE_ANNOTATION_KEY,
  CFG_GRAPH_KINDS,
  CFG_BLOCK_KINDS,
  CFG_EDGE_KINDS,
  CFG_TERMINATOR_KINDS,
  CFG_STATEMENT_REF_KINDS,
  createCfgDocument,
  createCfgGraph,
  createCfgBlock,
  createCfgEdge,
  createAstStatementRef,
  createAstExpressionRef,
  createSyntheticStatementRef,
  noneTerminator,
  gotoTerminator,
  conditionalBranchTerminator,
  switchBranchTerminator,
  returnTerminator,
  throwTerminator,
  exitTerminator,
  unreachableTerminator,
  unsupportedTerminator,
  isCfgDocument,
  isCfgGraph,
  isCfgBlock,
  isCfgEdge,
  validateCfgDocument,
  validateCfgGraph,
  validateCfgBlock,
  validateCfgEdge,
  toCfgJson,
  fromCfgJson,
  serializeCfg,
  deserializeCfg,
  cloneCfg,
  attachCfgDocument,
  getAttachedCfgDocument,
  detachCfgDocument,
  annotateNodeWithCfgLocation,
  getNodeCfgLocation,
  hasNodeCfgLocation,
  removeNodeCfgLocation,
  JavaCfgBuilder,
  createCfgBuilder,
  createInitializeCfgDocumentPass,
};
