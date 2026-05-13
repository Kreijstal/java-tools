'use strict';

const ast = require('./ast');
const { visitAst } = require('./traversal');
const { annotateNode, getNodeAnnotation, hasNodeAnnotation } = require('./annotations');
const {
  createCfgDocument,
  createCfgGraph,
  createCfgBlock,
  createCfgEdge,
  createAstStatementRef,
  createSyntheticStatementRef,
  gotoTerminator,
  exitTerminator,
  unsupportedTerminator,
  validateCfgDocument,
  attachCfgDocument,
  getAttachedCfgDocument,
  annotateNodeWithCfgLocation,
} = require('./cfg');
const {
  BYTECODE_CFG_SCHEMA_ID,
  BYTECODE_CFG_SCHEMA_VERSION,
  CFG_JOIN_AST_META_KEY,
  createCfgJoinDocument,
  createMethodCfgJoin,
  createCfgCorrespondence,
  normalizeMethodKey,
  sameMethodKey,
  validateCfgJoinDocument,
  validateCfgJoinAgainstDocuments,
  attachCfgJoinDocument,
  getAttachedCfgJoinDocument,
} = require('../cfg/cfgJoin');
const { createAssignNodeIdsPass } = require('./passManager');

const BYTECODE_CFG_AST_META_KEY = 'javaFrontendBytecodeCfg';
const CFG_JOIN_ANCHORS_AST_META_KEY = 'javaFrontendCfgJoinAnchors';
const BYTECODE_ORIGIN_ANNOTATION_KEY = 'java-tools.bytecode-origin';
const NODE_ID_ANNOTATION_KEY = 'frontend.nodeId';

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

function ensureDocumentMeta(document) {
  if (!isPlainObject(document.meta)) {
    document.meta = {};
  }
  return document.meta;
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function addDiagnostic(context, code, message, severity = 'warning', extra = {}) {
  if (context && typeof context.emitDiagnostic === 'function') {
    return context.emitDiagnostic(code, message, severity, null, extra);
  }
  return null;
}

function sanitizeGraphIdPart(value) {
  return String(value || 'anonymous')
    .replace(/[^A-Za-z0-9_$./:-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'anonymous';
}

function getAnnotatedNodeId(node, annotationKey = NODE_ID_ANNOTATION_KEY) {
  return getNodeAnnotation(node, annotationKey, null);
}

function statementRefForNode(node, fallbackId, role, annotationKey = NODE_ID_ANNOTATION_KEY) {
  const nodeId = getAnnotatedNodeId(node, annotationKey);
  return nodeId
    ? createAstStatementRef(nodeId, { role })
    : createSyntheticStatementRef(fallbackId, null, { role });
}

function ownerGraphKind(node) {
  if (node.kind === 'ConstructorDeclaration') {
    return 'ConstructorCfg';
  }
  if (node.kind === 'InitializerBlock') {
    return 'InitializerCfg';
  }
  return 'MethodCfg';
}

function ownerName(node) {
  if (node.kind === 'InitializerBlock') {
    return node.isStatic ? '<clinit>' : '<init-block>';
  }
  return node.name || '<anonymous>';
}

function methodNameForGraph(graph) {
  if (graph.ownerKind === 'ConstructorDeclaration') {
    return '<init>';
  }
  if (graph.ownerKind === 'InitializerBlock') {
    return graph.ownerName === '<clinit>' ? '<clinit>' : '<init-block>';
  }
  return graph.ownerName || null;
}

function createSkeletonGraphForBody(node, options = {}) {
  const annotationKey = options.annotationKey || NODE_ID_ANNOTATION_KEY;
  const ownerNodeId = getAnnotatedNodeId(node, annotationKey) || `owner:${sanitizeGraphIdPart(ownerName(node))}`;
  const name = ownerName(node);
  const graphId = options.graphIdForNode
    ? options.graphIdForNode(node, ownerNodeId)
    : `java-cfg:${ownerNodeId}`;
  const body = node.body || null;
  const bodyNodeId = body ? getAnnotatedNodeId(body, annotationKey) : null;
  const graph = createCfgGraph(graphId, {
    kind: ownerGraphKind(node),
    ownerNodeId,
    ownerKind: node.kind,
    ownerName: name,
    blocks: [
      createCfgBlock('entry', {
        kind: 'EntryBlock',
        astNodeIds: [ownerNodeId],
        terminator: gotoTerminator('body'),
      }),
      createCfgBlock('body', {
        kind: 'UnsupportedBlock',
        astNodeIds: bodyNodeId ? [bodyNodeId] : [ownerNodeId],
        statements: [statementRefForNode(body || node, `synthetic:${graphId}:body`, 'body', annotationKey)],
        terminator: unsupportedTerminator('statement-level Java CFG construction is stubbed', {
          target: 'exit',
          meta: {
            stub: true,
            ownerKind: node.kind,
          },
        }),
      }),
      createCfgBlock('exit', {
        kind: 'ExitBlock',
        terminator: exitTerminator(),
      }),
    ],
    edges: [
      createCfgEdge('entry-body', 'entry', 'body', { kind: 'normal' }),
      createCfgEdge('body-exit', 'body', 'exit', { kind: 'unsupported', sourceNodeId: bodyNodeId || ownerNodeId }),
    ],
    entryBlockId: 'entry',
    exitBlockId: 'exit',
    meta: {
      stub: true,
      status: 'skeleton',
    },
  });
  return graph;
}

function graphOwnerIds(cfgDocument) {
  const ids = new Set();
  if (!cfgDocument || !Array.isArray(cfgDocument.graphs)) {
    return ids;
  }
  for (const graph of cfgDocument.graphs) {
    if (graph.ownerNodeId) {
      ids.add(graph.ownerNodeId);
    }
  }
  return ids;
}

function createBuildJavaCfgPass(options = {}) {
  return {
    name: options.name || 'frontend.buildJavaCfg',
    phase: 'analysis',
    description: 'Stub pass that creates one skeletal Java CFG graph per method-like AST owner.',
    dependsOn: options.dependsOn || ['frontend.assignNodeIds', 'frontend.initializeCfgDocument'],
    run(document, context) {
      let cfgDocument = getAttachedCfgDocument(document);
      if (!cfgDocument || options.overwrite === true) {
        cfgDocument = createCfgDocument([], {
          sourceLevel: document.sourceLevel,
          meta: {
            stub: true,
            createdBy: this.name,
          },
        });
      }

      if (!Array.isArray(cfgDocument.graphs)) {
        cfgDocument.graphs = [];
      }

      const existingOwnerIds = options.overwrite === true ? new Set() : graphOwnerIds(cfgDocument);
      if (options.overwrite === true) {
        cfgDocument.graphs = [];
      }

      let created = 0;
      visitAst(document, {
        enter(node) {
          if (
            (node.kind === 'MethodDeclaration' || node.kind === 'ConstructorDeclaration' || node.kind === 'InitializerBlock')
            && node.body
          ) {
            const ownerNodeId = getAnnotatedNodeId(node, options.annotationKey || NODE_ID_ANNOTATION_KEY)
              || `owner:${sanitizeGraphIdPart(ownerName(node))}`;
            if (existingOwnerIds.has(ownerNodeId)) {
              return;
            }
            const graph = createSkeletonGraphForBody(node, options);
            cfgDocument.graphs.push(graph);
            existingOwnerIds.add(ownerNodeId);
            created += 1;
            annotateNodeWithCfgLocation(node, {
              graphId: graph.id,
              blockId: 'entry',
              role: 'owner',
            });
          }
        },
      });

      if (!isPlainObject(cfgDocument.meta)) {
        cfgDocument.meta = {};
      }
      cfgDocument.meta.buildJavaCfg = {
        status: 'stub',
        createdGraphs: created,
        precision: 'method-skeleton',
      };
      attachCfgDocument(document, cfgDocument, { validate: options.validate !== false });
      addDiagnostic(
        context,
        'JAVA_CFG_STUB',
        'Java CFG construction is currently a method-level skeleton stub.',
        'info',
        { createdGraphs: created },
      );
      return document;
    },
  };
}

function createBytecodeCfgDocument(graphs = [], options = {}) {
  if (!Array.isArray(graphs)) {
    throw new TypeError('bytecode CFG document graphs must be an array');
  }
  const document = {
    schema: BYTECODE_CFG_SCHEMA_ID,
    version: BYTECODE_CFG_SCHEMA_VERSION,
    graphs,
  };
  if (options.meta !== undefined) {
    document.meta = omitUndefined(options.meta);
  }
  if (options.diagnostics !== undefined) {
    document.diagnostics = options.diagnostics;
  }
  return document;
}

function instructionOffset(instruction, fallback) {
  if (instruction && typeof instruction.pc === 'number') {
    return instruction.pc;
  }
  if (instruction && typeof instruction.offset === 'number') {
    return instruction.offset;
  }
  return fallback;
}

function normalizeLegacyBytecodeCfgGraph(input, index = 0, options = {}) {
  const id = input.id || (input.context
    ? `bytecode-cfg:${sanitizeGraphIdPart(input.context.className)}.${sanitizeGraphIdPart(input.context.methodName)}${sanitizeGraphIdPart(input.context.descriptor || '')}`
    : `bytecode-cfg:${index}`);
  const blocks = [];
  const edges = [];
  const edgeIds = new Set();
  const methodKey = input.methodKey || (input.context ? {
    owner: input.context.className || null,
    name: input.context.methodName || null,
    descriptor: input.context.descriptor || null,
  } : options.methodKey || null);

  for (const block of input.blocks.values()) {
    const offsets = [];
    const instructions = Array.isArray(block.instructions) ? block.instructions : [];
    for (let i = 0; i < instructions.length; i += 1) {
      offsets.push(instructionOffset(instructions[i], i));
    }
    blocks.push({
      id: block.id,
      kind: 'BasicBlock',
      instructionOffsets: offsets,
      firstOffset: offsets.length ? offsets[0] : null,
      lastOffset: offsets.length ? offsets[offsets.length - 1] : null,
      instructionCount: instructions.length,
      successors: Array.isArray(block.successors) ? block.successors.slice() : [],
      predecessors: Array.isArray(block.predecessors) ? block.predecessors.slice() : [],
      meta: {
        normalizedFrom: 'legacy-cfg',
      },
    });
    for (const successor of block.successors || []) {
      const edgeId = `edge:${block.id}->${successor}`;
      if (edgeIds.has(edgeId)) {
        continue;
      }
      edgeIds.add(edgeId);
      edges.push({
        id: edgeId,
        from: block.id,
        to: successor,
        kind: 'normal',
      });
    }
  }

  return omitUndefined({
    id,
    kind: 'BytecodeMethodCfg',
    methodKey: normalizeMethodKey(methodKey),
    entryBlockId: input.entryBlockId || null,
    exitBlockId: input.exitBlockId || null,
    blocks,
    edges,
    meta: {
      normalizedFrom: 'legacy-cfg',
    },
  });
}

function normalizeBytecodeCfgGraph(input, index = 0, options = {}) {
  if (input && input.blocks instanceof Map) {
    return normalizeLegacyBytecodeCfgGraph(input, index, options);
  }
  if (!isPlainObject(input)) {
    throw new TypeError(`bytecode CFG graph ${index} must be a plain object or legacy CFG object`);
  }
  if (!input.id) {
    throw new TypeError(`bytecode CFG graph ${index} must have an id`);
  }
  return omitUndefined({
    id: input.id,
    kind: input.kind || 'BytecodeMethodCfg',
    methodKey: normalizeMethodKey(input.methodKey || options.methodKey || null),
    entryBlockId: input.entryBlockId || null,
    exitBlockId: input.exitBlockId || null,
    blocks: Array.isArray(input.blocks) ? cloneJsonValue(input.blocks) : [],
    edges: Array.isArray(input.edges) ? cloneJsonValue(input.edges) : [],
    exceptionHandlers: input.exceptionHandlers ? cloneJsonValue(input.exceptionHandlers) : undefined,
    meta: input.meta ? cloneJsonValue(input.meta) : undefined,
  });
}

function normalizeBytecodeCfgDocument(input, options = {}) {
  if (input === undefined || input === null) {
    return createBytecodeCfgDocument([], {
      meta: {
        stub: true,
        missingInput: true,
      },
    });
  }
  if (input.schema === BYTECODE_CFG_SCHEMA_ID && input.version === BYTECODE_CFG_SCHEMA_VERSION) {
    return createBytecodeCfgDocument(
      input.graphs.map((graph, index) => normalizeBytecodeCfgGraph(graph, index, options)),
      {
        meta: input.meta || {},
        diagnostics: input.diagnostics || [],
      },
    );
  }
  if (Array.isArray(input)) {
    return createBytecodeCfgDocument(input.map((graph, index) => normalizeBytecodeCfgGraph(graph, index, options)));
  }
  if (input.blocks instanceof Map || Array.isArray(input.blocks)) {
    return createBytecodeCfgDocument([normalizeBytecodeCfgGraph(input, 0, options)]);
  }
  if (Array.isArray(input.graphs)) {
    return createBytecodeCfgDocument(input.graphs.map((graph, index) => normalizeBytecodeCfgGraph(graph, index, options)));
  }
  throw new TypeError('bytecode CFG input must be a document, graph array, graph, or legacy CFG');
}

function attachBytecodeCfgDocument(astDocument, bytecodeCfgDocument, options = {}) {
  const meta = ensureDocumentMeta(astDocument);
  meta[options.key || BYTECODE_CFG_AST_META_KEY] = options.clone === false
    ? bytecodeCfgDocument
    : cloneJsonValue(bytecodeCfgDocument);
  return astDocument;
}

function getAttachedBytecodeCfgDocument(astDocument, options = {}) {
  if (!isPlainObject(astDocument) || !isPlainObject(astDocument.meta)) {
    return null;
  }
  return astDocument.meta[options.key || BYTECODE_CFG_AST_META_KEY] || null;
}

function detachBytecodeCfgDocument(astDocument, options = {}) {
  if (isPlainObject(astDocument) && isPlainObject(astDocument.meta)) {
    delete astDocument.meta[options.key || BYTECODE_CFG_AST_META_KEY];
  }
  return astDocument;
}

function createNormalizeBytecodeCfgPass(options = {}) {
  return {
    name: options.name || 'frontend.normalizeBytecodeCfg',
    phase: 'analysis',
    description: 'Stub pass that normalizes bytecode CFG inputs into a serializable bytecode CFG sidecar.',
    dependsOn: options.dependsOn || [],
    run(document, context) {
      const input = Object.prototype.hasOwnProperty.call(options, 'bytecodeCfg')
        ? options.bytecodeCfg
        : getAttachedBytecodeCfgDocument(document);
      const bytecodeCfgDocument = normalizeBytecodeCfgDocument(input, options);
      attachBytecodeCfgDocument(document, bytecodeCfgDocument, options.attach || {});
      if (bytecodeCfgDocument.graphs.length === 0) {
        addDiagnostic(
          context,
          'BYTECODE_CFG_MISSING',
          'No bytecode CFG input was provided; attached an empty bytecode CFG sidecar.',
          options.requireBytecode ? 'error' : 'info',
        );
      }
      return document;
    },
  };
}

function createResolveMethodKeysPass(options = {}) {
  return {
    name: options.name || 'frontend.resolveMethodKeys',
    phase: 'analysis',
    description: 'Stub pass that attaches bytecode-style method key placeholders to Java CFG graphs.',
    dependsOn: options.dependsOn || ['frontend.buildJavaCfg'],
    run(document, context) {
      const cfgDocument = getAttachedCfgDocument(document);
      if (!cfgDocument) {
        addDiagnostic(context, 'JAVA_CFG_MISSING', 'Cannot resolve method keys without an attached Java CFG document.', 'warning');
        return document;
      }
      let resolved = 0;
      for (const graph of cfgDocument.graphs) {
        if (!isPlainObject(graph.meta)) {
          graph.meta = {};
        }
        if (!graph.meta.methodKey || options.overwrite === true) {
          const key = options.resolver
            ? options.resolver(graph, document)
            : {
              owner: options.owner || null,
              name: methodNameForGraph(graph),
              descriptor: options.descriptor || null,
              sourceName: graph.ownerName || null,
            };
          graph.meta.methodKey = normalizeMethodKey(key);
          resolved += 1;
        }
      }
      cfgDocument.meta = cfgDocument.meta || {};
      cfgDocument.meta.resolveMethodKeys = {
        status: 'stub',
        resolvedGraphs: resolved,
      };
      attachCfgDocument(document, cfgDocument);
      addDiagnostic(
        context,
        'METHOD_KEYS_STUB',
        'Method-key resolution is currently descriptor-incomplete unless a resolver is supplied.',
        'info',
        { resolvedGraphs: resolved },
      );
      return document;
    },
  };
}

function normalizeOriginAnnotation(origin) {
  if (!isPlainObject(origin)) {
    return null;
  }
  const instructionOffsets = Array.isArray(origin.instructionOffsets)
    ? origin.instructionOffsets.filter(Number.isInteger)
    : [];
  const bytecodeBlockIds = Array.isArray(origin.bytecodeBlockIds)
    ? origin.bytecodeBlockIds.filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  return omitUndefined({
    methodKey: normalizeMethodKey(origin.methodKey || null),
    instructionOffsets,
    bytecodeBlockIds,
    role: origin.role || null,
    confidence: origin.confidence || 'exact',
  });
}

function createCollectCfgJoinAnchorsPass(options = {}) {
  const originKey = options.originAnnotationKey || BYTECODE_ORIGIN_ANNOTATION_KEY;
  const nodeIdKey = options.nodeIdAnnotationKey || NODE_ID_ANNOTATION_KEY;
  return {
    name: options.name || 'frontend.collectCfgJoinAnchors',
    phase: 'analysis',
    description: 'Collects bytecode-origin annotations into a serializable join-anchor sidecar.',
    dependsOn: options.dependsOn || ['frontend.assignNodeIds'],
    run(document, context) {
      const anchors = [];
      visitAst(document, {
        enter(node) {
          if (!hasNodeAnnotation(node, originKey)) {
            return;
          }
          const origin = normalizeOriginAnnotation(getNodeAnnotation(node, originKey));
          if (!origin) {
            return;
          }
          anchors.push({
            id: `anchor:${anchors.length}`,
            nodeId: getNodeAnnotation(node, nodeIdKey, null),
            nodeKind: node.kind,
            methodKey: origin.methodKey,
            instructionOffsets: origin.instructionOffsets,
            bytecodeBlockIds: origin.bytecodeBlockIds,
            role: origin.role,
            confidence: origin.confidence,
          });
        },
      });
      const meta = ensureDocumentMeta(document);
      meta[options.key || CFG_JOIN_ANCHORS_AST_META_KEY] = {
        schema: 'java-tools.cfg.join.anchors',
        version: 1,
        anchors,
      };
      addDiagnostic(context, 'CFG_JOIN_ANCHORS_COLLECTED', 'Collected CFG join anchors.', 'info', { anchors: anchors.length });
      return document;
    },
  };
}

function getAttachedCfgJoinAnchors(astDocument, options = {}) {
  if (!isPlainObject(astDocument) || !isPlainObject(astDocument.meta)) {
    return null;
  }
  return astDocument.meta[options.key || CFG_JOIN_ANCHORS_AST_META_KEY] || null;
}

function blockIdsForBytecodeOffsets(bytecodeGraph, instructionOffsets) {
  const targets = new Set();
  const offsetSet = new Set(instructionOffsets || []);
  if (!bytecodeGraph || offsetSet.size === 0 || !Array.isArray(bytecodeGraph.blocks)) {
    return [];
  }
  for (const block of bytecodeGraph.blocks) {
    const offsets = Array.isArray(block.instructionOffsets) ? block.instructionOffsets : [];
    if (offsets.some((offset) => offsetSet.has(offset))) {
      targets.add(block.id);
    }
  }
  return Array.from(targets);
}

function findMatchingBytecodeGraph(javaGraph, bytecodeCfgDocument, options = {}) {
  if (!bytecodeCfgDocument || !Array.isArray(bytecodeCfgDocument.graphs)) {
    return null;
  }
  if (options.matchGraph) {
    return options.matchGraph(javaGraph, bytecodeCfgDocument) || null;
  }
  const methodKey = javaGraph && javaGraph.meta ? javaGraph.meta.methodKey : null;
  if (methodKey) {
    for (const graph of bytecodeCfgDocument.graphs) {
      if (sameMethodKey(methodKey, graph.methodKey)) {
        return graph;
      }
    }
  }
  if (bytecodeCfgDocument.graphs.length === 1) {
    return bytecodeCfgDocument.graphs[0];
  }
  return null;
}

function createGraphCorrespondence(javaGraph, bytecodeGraph, index) {
  return createCfgCorrespondence(`corr:${index}:graph`, {
    kind: 'GraphToGraph',
    java: {
      graphId: javaGraph.id,
    },
    bytecode: {
      graphId: bytecodeGraph.id,
    },
    relation: 'implements',
    confidence: sameMethodKey(javaGraph.meta && javaGraph.meta.methodKey, bytecodeGraph.methodKey) ? 'high' : 'low',
    evidence: [{ kind: 'MethodKeyOrSingletonGraphMatch' }],
  });
}

function anchorMatchesGraph(anchor, javaGraph) {
  if (!anchor || !javaGraph) {
    return false;
  }
  if (!anchor.methodKey) {
    return true;
  }
  return sameMethodKey(anchor.methodKey, javaGraph.meta && javaGraph.meta.methodKey);
}

function createJoinJavaBytecodeCfgPass(options = {}) {
  return {
    name: options.name || 'frontend.joinJavaBytecodeCfg',
    phase: 'analysis',
    description: 'Stub pass that creates a serializable Java-CFG to bytecode-CFG join sidecar.',
    dependsOn: options.dependsOn || [
      'frontend.buildJavaCfg',
      'frontend.normalizeBytecodeCfg',
      'frontend.resolveMethodKeys',
      'frontend.collectCfgJoinAnchors',
    ],
    run(document, context) {
      const javaCfgDocument = getAttachedCfgDocument(document);
      const bytecodeCfgDocument = getAttachedBytecodeCfgDocument(document);
      const anchorsDocument = getAttachedCfgJoinAnchors(document) || { anchors: [] };
      const joins = [];
      const diagnostics = [];
      const anchors = Array.isArray(anchorsDocument.anchors) ? anchorsDocument.anchors : [];

      if (!javaCfgDocument) {
        diagnostics.push(ast.diagnostic('JAVA_CFG_MISSING', 'Cannot join CFGs without a Java CFG sidecar.', 'warning'));
      }

      for (const javaGraph of (javaCfgDocument && javaCfgDocument.graphs) || []) {
        const bytecodeGraph = findMatchingBytecodeGraph(javaGraph, bytecodeCfgDocument, options);
        const correspondences = [];
        if (bytecodeGraph) {
          correspondences.push(createGraphCorrespondence(javaGraph, bytecodeGraph, correspondences.length));
        } else {
          diagnostics.push(ast.diagnostic(
            'BYTECODE_CFG_GRAPH_MISSING',
            `No bytecode CFG graph matched Java CFG graph ${javaGraph.id}.`,
            options.requireMatches ? 'error' : 'warning',
          ));
        }

        for (const anchor of anchors) {
          if (!anchorMatchesGraph(anchor, javaGraph)) {
            continue;
          }
          const bytecodeBlockIds = anchor.bytecodeBlockIds.length > 0
            ? anchor.bytecodeBlockIds
            : blockIdsForBytecodeOffsets(bytecodeGraph, anchor.instructionOffsets);
          correspondences.push(createCfgCorrespondence(`corr:${correspondences.length}:anchor:${anchor.id}`, {
            kind: 'NodeToInstructions',
            java: {
              graphId: javaGraph.id,
              nodeIds: anchor.nodeId ? [anchor.nodeId] : [],
              roles: anchor.role ? [anchor.role] : [],
            },
            bytecode: {
              graphId: bytecodeGraph ? bytecodeGraph.id : null,
              blockIds: bytecodeBlockIds,
              instructionOffsets: anchor.instructionOffsets,
            },
            relation: 'implements',
            confidence: anchor.confidence || 'exact',
            evidence: [{ kind: 'BytecodeOriginAnnotation', anchorId: anchor.id }],
          }));
        }

        joins.push(createMethodCfgJoin(`join:${javaGraph.id}`, {
          method: javaGraph.meta && javaGraph.meta.methodKey ? javaGraph.meta.methodKey : null,
          javaGraphId: javaGraph.id,
          bytecodeGraphId: bytecodeGraph ? bytecodeGraph.id : null,
          correspondences,
          diagnostics: [],
          meta: {
            stub: true,
            status: 'correspondence-skeleton',
          },
        }));
      }

      const joinDocument = createCfgJoinDocument(joins, {
        diagnostics,
        meta: {
          stub: true,
          createdBy: this.name,
          anchors: anchors.length,
        },
      });
      attachCfgJoinDocument(document, joinDocument, options.attach || {});
      addDiagnostic(
        context,
        'CFG_JOIN_STUB',
        'CFG join is currently a graph/anchor correspondence stub.',
        'info',
        { joins: joins.length, diagnostics: diagnostics.length },
      );
      return document;
    },
  };
}

function createValidateCfgJoinPass(options = {}) {
  return {
    name: options.name || 'frontend.validateCfgJoin',
    phase: 'validation',
    description: 'Validates the attached CFG join sidecar and cross-checks graph/block references where available.',
    dependsOn: options.dependsOn || ['frontend.joinJavaBytecodeCfg'],
    run(document, context) {
      const joinDocument = getAttachedCfgJoinDocument(document);
      if (!joinDocument) {
        addDiagnostic(context, 'CFG_JOIN_MISSING', 'No CFG join sidecar is attached.', 'warning');
        return document;
      }
      const javaCfgDocument = getAttachedCfgDocument(document);
      const bytecodeCfgDocument = getAttachedBytecodeCfgDocument(document);
      if (options.crossCheck === false || !javaCfgDocument || !bytecodeCfgDocument) {
        validateCfgJoinDocument(joinDocument);
      } else {
        validateCfgJoinAgainstDocuments(joinDocument, javaCfgDocument, bytecodeCfgDocument);
      }
      addDiagnostic(context, 'CFG_JOIN_VALIDATED', 'CFG join sidecar validated.', 'info', {
        joins: joinDocument.joins.length,
      });
      return document;
    },
  };
}

function createCfgJoinStubPasses(options = {}) {
  return [
    createAssignNodeIdsPass(options.assignNodeIds || {}),
    require('./cfg').createInitializeCfgDocumentPass(options.initializeJavaCfg || {}),
    createBuildJavaCfgPass(options.buildJavaCfg || {}),
    createNormalizeBytecodeCfgPass(options.normalizeBytecodeCfg || { bytecodeCfg: options.bytecodeCfg }),
    createResolveMethodKeysPass(options.resolveMethodKeys || {}),
    createCollectCfgJoinAnchorsPass(options.collectAnchors || {}),
    createJoinJavaBytecodeCfgPass(options.join || {}),
    createValidateCfgJoinPass(options.validateJoin || {}),
  ];
}

module.exports = {
  BYTECODE_CFG_AST_META_KEY,
  CFG_JOIN_ANCHORS_AST_META_KEY,
  BYTECODE_ORIGIN_ANNOTATION_KEY,
  NODE_ID_ANNOTATION_KEY,
  createBuildJavaCfgPass,
  createBytecodeCfgDocument,
  normalizeBytecodeCfgDocument,
  attachBytecodeCfgDocument,
  getAttachedBytecodeCfgDocument,
  detachBytecodeCfgDocument,
  createNormalizeBytecodeCfgPass,
  createResolveMethodKeysPass,
  createCollectCfgJoinAnchorsPass,
  getAttachedCfgJoinAnchors,
  createJoinJavaBytecodeCfgPass,
  createValidateCfgJoinPass,
  createCfgJoinStubPasses,
  CFG_JOIN_AST_META_KEY,
};
