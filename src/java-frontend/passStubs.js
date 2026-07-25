'use strict';

const { createAssignNodeIdsPass, createNodeKindHistogramPass } = require('./passManager');
const { createInitializeCfgDocumentPass } = require('./cfg');
const {
  createBuildJavaCfgPass,
  createNormalizeBytecodeCfgPass,
  createResolveMethodKeysPass,
  createCollectCfgJoinAnchorsPass,
  createJoinJavaBytecodeCfgPass,
  createValidateCfgJoinPass,
} = require('./cfgJoinPasses');
const {
  createEmitBytecodeIrPass,
  createEmitClassFileModelPass,
  createValidateClassFileModelPass,
} = require('./compiler');
const { createLowerAstToJavaIrPass } = require('./javaIr');
const { createEmitJvmBytecodeIrPass } = require('./jvmBytecodeIr');

const FRONTEND_PASS_STUBS_SCHEMA_ID = 'java-tools.java-frontend.expected-passes';
const FRONTEND_PASS_STUBS_SCHEMA_VERSION = 1;
const FRONTEND_PASS_STUBS_AST_META_KEY = 'javaFrontendExpectedPasses';

const DEFAULT_NODE_ANNOTATION_PREFIX = 'frontend.passStatus.';

const PASS_STATUS = Object.freeze({
  IMPLEMENTED: 'implemented',
  SCAFFOLD: 'scaffold',
  STUB: 'stub',
});

function freezeDefinitions(definitions) {
  return Object.freeze(definitions.map((definition) => Object.freeze({
    ...definition,
    dependsOn: Object.freeze((definition.dependsOn || []).slice()),
    consumes: Object.freeze((definition.consumes || []).slice()),
    produces: Object.freeze((definition.produces || []).slice()),
  })));
}

const FRONTEND_EXPECTED_PASS_DEFINITIONS = freezeDefinitions([
  {
    name: 'frontend.normalizeAstDocument',
    phase: 'syntax',
    category: 'syntax',
    status: PASS_STATUS.STUB,
    description: 'Normalize AST document defaults, metadata containers, and parser diagnostics before later passes.',
    dependsOn: [],
    produces: ['javaFrontendSyntaxIndex'],
  },
  {
    name: 'frontend.assignNodeIds',
    phase: 'annotation',
    category: 'infrastructure',
    status: PASS_STATUS.IMPLEMENTED,
    description: 'Assign stable traversal-order node IDs as serializable node annotations.',
    dependsOn: [],
    produces: ['node.annotations.frontend.nodeId'],
    factory: 'assignNodeIds',
  },
  {
    name: 'frontend.validateSyntaxTree',
    phase: 'validation',
    category: 'syntax',
    status: PASS_STATUS.STUB,
    description: 'Validate frontend-level syntax invariants beyond raw AST schema validation.',
    dependsOn: ['frontend.normalizeAstDocument'],
    consumes: ['javaFrontendSyntaxIndex'],
  },
  {
    name: 'frontend.indexSourceRanges',
    phase: 'analysis',
    category: 'syntax',
    status: PASS_STATUS.STUB,
    description: 'Index AST source ranges, token spans, and unsupported syntax islands.',
    dependsOn: ['frontend.assignNodeIds', 'frontend.validateSyntaxTree'],
    produces: ['javaFrontendSourceIndex'],
  },
  {
    name: 'frontend.indexDeclarations',
    phase: 'analysis',
    category: 'declarations',
    status: PASS_STATUS.STUB,
    description: 'Index packages, imports, top-level declarations, nested declarations, and method-like bodies.',
    dependsOn: ['frontend.indexSourceRanges'],
    produces: ['javaFrontendDeclarationIndex'],
  },
  {
    name: 'frontend.nodeKindHistogram',
    phase: 'analysis',
    category: 'diagnostics',
    status: PASS_STATUS.IMPLEMENTED,
    description: 'Collect a simple AST node-kind histogram for diagnostics and fixture sanity checks.',
    dependsOn: ['frontend.assignNodeIds'],
    produces: ['node.annotations.frontend.kindHistogram'],
    factory: 'nodeKindHistogram',
  },

  {
    name: 'frontend.buildPackageIndex',
    phase: 'symbols',
    category: 'symbols',
    status: PASS_STATUS.STUB,
    description: 'Build package and compilation-unit namespace indexes.',
    dependsOn: ['frontend.indexDeclarations'],
    consumes: ['javaFrontendDeclarationIndex'],
    produces: ['javaFrontendSymbolTable'],
  },
  {
    name: 'frontend.buildImportTable',
    phase: 'symbols',
    category: 'symbols',
    status: PASS_STATUS.STUB,
    description: 'Resolve explicit imports, wildcard imports, static imports, and implicit java.lang imports.',
    dependsOn: ['frontend.buildPackageIndex'],
    consumes: ['javaFrontendDeclarationIndex'],
    produces: ['javaFrontendSymbolTable'],
  },
  {
    name: 'frontend.buildTypeSymbolTable',
    phase: 'symbols',
    category: 'symbols',
    status: PASS_STATUS.STUB,
    description: 'Create type symbols for classes, interfaces, enums, records, annotation types, and type parameters.',
    dependsOn: ['frontend.buildImportTable'],
    produces: ['javaFrontendSymbolTable'],
  },
  {
    name: 'frontend.buildMemberSymbolTable',
    phase: 'symbols',
    category: 'symbols',
    status: PASS_STATUS.STUB,
    description: 'Create field, method, constructor, initializer, enum-constant, and nested-type symbols.',
    dependsOn: ['frontend.buildTypeSymbolTable'],
    produces: ['javaFrontendSymbolTable'],
  },
  {
    name: 'frontend.buildLocalScopeTree',
    phase: 'symbols',
    category: 'symbols',
    status: PASS_STATUS.STUB,
    description: 'Create lexical scopes for parameters, locals, catch variables, resources, patterns, and loop variables.',
    dependsOn: ['frontend.buildMemberSymbolTable'],
    produces: ['javaFrontendSymbolTable'],
  },
  {
    name: 'frontend.resolveNames',
    phase: 'symbols',
    category: 'symbols',
    status: PASS_STATUS.STUB,
    description: 'Resolve identifiers, qualified names, this/super references, and static/member selections to symbols.',
    dependsOn: ['frontend.buildLocalScopeTree'],
    consumes: ['javaFrontendSymbolTable'],
    produces: ['node.annotations.frontend.symbol'],
  },
  {
    name: 'frontend.resolveAnnotationNames',
    phase: 'symbols',
    category: 'symbols',
    status: PASS_STATUS.STUB,
    description: 'Resolve annotation type names and annotation element names.',
    dependsOn: ['frontend.resolveNames'],
    consumes: ['javaFrontendSymbolTable'],
  },
  {
    name: 'frontend.resolveInheritance',
    phase: 'symbols',
    category: 'symbols',
    status: PASS_STATUS.STUB,
    description: 'Resolve extends/implements/permits clauses and produce class/interface hierarchy edges.',
    dependsOn: ['frontend.resolveNames'],
    consumes: ['javaFrontendSymbolTable'],
    produces: ['javaFrontendTypeModel'],
  },
  {
    name: 'frontend.detectInheritanceCycles',
    phase: 'validation',
    category: 'symbols',
    status: PASS_STATUS.STUB,
    description: 'Detect cyclic inheritance, repeated interfaces, and illegal hierarchy relationships.',
    dependsOn: ['frontend.resolveInheritance'],
    consumes: ['javaFrontendTypeModel'],
  },
  {
    name: 'frontend.validateSymbols',
    phase: 'validation',
    category: 'symbols',
    status: PASS_STATUS.STUB,
    description: 'Validate symbol-table completeness, duplicate declarations, and unresolved-name diagnostics.',
    dependsOn: ['frontend.resolveAnnotationNames', 'frontend.detectInheritanceCycles'],
    consumes: ['javaFrontendSymbolTable'],
  },

  {
    name: 'frontend.resolveTypeNames',
    phase: 'types',
    category: 'types',
    status: PASS_STATUS.STUB,
    description: 'Resolve syntactic type nodes to type model IDs.',
    dependsOn: ['frontend.resolveInheritance'],
    consumes: ['javaFrontendSymbolTable'],
    produces: ['javaFrontendTypeModel'],
  },
  {
    name: 'frontend.attributeExpressionTypes',
    phase: 'types',
    category: 'types',
    status: PASS_STATUS.STUB,
    description: 'Attribute expression, statement, pattern, and initializer types.',
    dependsOn: ['frontend.resolveTypeNames'],
    consumes: ['javaFrontendTypeModel'],
    produces: ['node.annotations.frontend.type'],
  },
  {
    name: 'frontend.resolveGenerics',
    phase: 'types',
    category: 'types',
    status: PASS_STATUS.STUB,
    description: 'Resolve type variables, bounds, captures, wildcards, generic substitutions, and erasure metadata.',
    dependsOn: ['frontend.attributeExpressionTypes'],
    consumes: ['javaFrontendTypeModel'],
    produces: ['javaFrontendTypeModel'],
  },
  {
    name: 'frontend.resolveMethodOverloads',
    phase: 'types',
    category: 'types',
    status: PASS_STATUS.STUB,
    description: 'Resolve overload sets, applicability, invocation conversions, and chosen executable symbols.',
    dependsOn: ['frontend.resolveGenerics'],
    consumes: ['javaFrontendTypeModel'],
    produces: ['node.annotations.frontend.overload'],
  },
  {
    name: 'frontend.resolveFieldAccesses',
    phase: 'types',
    category: 'types',
    status: PASS_STATUS.STUB,
    description: 'Resolve field selections, enum constants, array length, and static-vs-instance access rules.',
    dependsOn: ['frontend.resolveMethodOverloads'],
    consumes: ['javaFrontendTypeModel'],
  },
  {
    name: 'frontend.resolveConversions',
    phase: 'types',
    category: 'types',
    status: PASS_STATUS.STUB,
    description: 'Resolve primitive, reference, boxing, unboxing, string, numeric, and assignment conversions.',
    dependsOn: ['frontend.resolveMethodOverloads'],
    consumes: ['javaFrontendTypeModel'],
    produces: ['node.annotations.frontend.conversion'],
  },
  {
    name: 'frontend.resolveOverrides',
    phase: 'types',
    category: 'types',
    status: PASS_STATUS.STUB,
    description: 'Resolve overriding, implementation, bridge-method needs, default methods, and covariant returns.',
    dependsOn: ['frontend.resolveInheritance', 'frontend.resolveMethodOverloads'],
    consumes: ['javaFrontendTypeModel'],
  },
  {
    name: 'frontend.resolveConstants',
    phase: 'types',
    category: 'types',
    status: PASS_STATUS.STUB,
    description: 'Evaluate Java constant expressions and attach serializable constant-value annotations.',
    dependsOn: ['frontend.resolveConversions'],
    consumes: ['javaFrontendTypeModel'],
    produces: ['node.annotations.frontend.constantValue'],
  },
  {
    name: 'frontend.validateTypes',
    phase: 'validation',
    category: 'types',
    status: PASS_STATUS.STUB,
    description: 'Validate type compatibility, accessibility, throws clauses, generics, and conversion diagnostics.',
    dependsOn: ['frontend.resolveFieldAccesses', 'frontend.resolveOverrides', 'frontend.resolveConstants'],
    consumes: ['javaFrontendTypeModel'],
  },

  {
    name: 'frontend.initializeCfgDocument',
    phase: 'cfg',
    category: 'java-cfg',
    status: PASS_STATUS.SCAFFOLD,
    description: 'Attach an empty serializable Java CFG sidecar document.',
    dependsOn: [],
    produces: ['javaFrontendCfg'],
    factory: 'initializeCfgDocument',
  },
  {
    name: 'frontend.buildJavaCfg',
    phase: 'cfg',
    category: 'java-cfg',
    status: PASS_STATUS.STUB,
    description: 'Build method/constructor/initializer Java CFG graphs from statement bodies.',
    dependsOn: ['frontend.assignNodeIds', 'frontend.initializeCfgDocument'],
    consumes: ['node.annotations.frontend.nodeId'],
    produces: ['javaFrontendCfg'],
    factory: 'buildJavaCfg',
  },
  {
    name: 'frontend.expandExpressionCfg',
    phase: 'cfg',
    category: 'java-cfg',
    status: PASS_STATUS.STUB,
    description: 'Expand short-circuit, ternary, lambda, switch-expression, and expression-level control flow.',
    dependsOn: ['frontend.buildJavaCfg', 'frontend.attributeExpressionTypes'],
    consumes: ['javaFrontendCfg'],
    produces: ['javaFrontendCfg'],
  },
  {
    name: 'frontend.modelExceptionFlow',
    phase: 'cfg',
    category: 'java-cfg',
    status: PASS_STATUS.STUB,
    description: 'Add exception edges for throw, method calls, field/array access, casts, monitors, and catch handlers.',
    dependsOn: ['frontend.expandExpressionCfg'],
    consumes: ['javaFrontendCfg'],
    produces: ['javaFrontendCfg'],
  },
  {
    name: 'frontend.modelFinallyFlow',
    phase: 'cfg',
    category: 'java-cfg',
    status: PASS_STATUS.STUB,
    description: 'Model finally blocks, try-with-resources cleanup, suppressed exceptions, and abrupt completion rewrites.',
    dependsOn: ['frontend.modelExceptionFlow'],
    consumes: ['javaFrontendCfg'],
    produces: ['javaFrontendCfg'],
  },
  {
    name: 'frontend.computeReachability',
    phase: 'dataflow',
    category: 'dataflow',
    status: PASS_STATUS.STUB,
    description: 'Compute statement/block reachability and unreachable-code diagnostics.',
    dependsOn: ['frontend.modelFinallyFlow'],
    consumes: ['javaFrontendCfg'],
    produces: ['javaFrontendDataflow'],
  },
  {
    name: 'frontend.computeDominators',
    phase: 'dataflow',
    category: 'dataflow',
    status: PASS_STATUS.STUB,
    description: 'Compute dominator trees for Java CFG graphs.',
    dependsOn: ['frontend.modelFinallyFlow'],
    consumes: ['javaFrontendCfg'],
    produces: ['javaFrontendDataflow'],
  },
  {
    name: 'frontend.computePostDominators',
    phase: 'dataflow',
    category: 'dataflow',
    status: PASS_STATUS.STUB,
    description: 'Compute post-dominator trees for Java CFG graphs.',
    dependsOn: ['frontend.modelFinallyFlow'],
    consumes: ['javaFrontendCfg'],
    produces: ['javaFrontendDataflow'],
  },
  {
    name: 'frontend.computeDefiniteAssignment',
    phase: 'dataflow',
    category: 'dataflow',
    status: PASS_STATUS.STUB,
    description: 'Compute Java definite-assignment and definite-unassignment facts.',
    dependsOn: ['frontend.computeReachability', 'frontend.attributeExpressionTypes'],
    consumes: ['javaFrontendCfg', 'javaFrontendTypeModel'],
    produces: ['javaFrontendDataflow'],
  },
  {
    name: 'frontend.computeLiveness',
    phase: 'dataflow',
    category: 'dataflow',
    status: PASS_STATUS.STUB,
    description: 'Compute local/stack liveness facts for optimization and bytecode lowering.',
    dependsOn: ['frontend.computeReachability', 'frontend.resolveNames'],
    consumes: ['javaFrontendCfg', 'javaFrontendSymbolTable'],
    produces: ['javaFrontendDataflow'],
  },
  {
    name: 'frontend.validateControlFlow',
    phase: 'validation',
    category: 'dataflow',
    status: PASS_STATUS.STUB,
    description: 'Validate return completeness, break/continue targets, checked exceptions, and dataflow requirements.',
    dependsOn: ['frontend.computeDefiniteAssignment', 'frontend.computeLiveness', 'frontend.computeDominators', 'frontend.computePostDominators'],
    consumes: ['javaFrontendCfg', 'javaFrontendDataflow'],
  },

  {
    name: 'frontend.desugarEnhancedFor',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Lower enhanced-for loops over arrays and Iterable into explicit loop forms.',
    dependsOn: ['frontend.validateTypes', 'frontend.validateControlFlow'],
    produces: ['javaFrontendLowering'],
  },
  {
    name: 'frontend.desugarStringSwitch',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Lower string switch constructs into hash/equality dispatch representation.',
    dependsOn: ['frontend.desugarEnhancedFor'],
    produces: ['javaFrontendLowering'],
  },
  {
    name: 'frontend.desugarTryWithResources',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Lower try-with-resources into explicit close/finally/suppressed-exception structure.',
    dependsOn: ['frontend.desugarStringSwitch'],
    produces: ['javaFrontendLowering'],
  },
  {
    name: 'frontend.lowerLambdas',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Lower lambdas and method references to invokedynamic metadata or synthetic methods.',
    dependsOn: ['frontend.desugarTryWithResources'],
    produces: ['javaFrontendLowering'],
  },
  {
    name: 'frontend.lowerInnerClasses',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Lower nested, local, and anonymous classes plus captured variables and this references.',
    dependsOn: ['frontend.lowerLambdas'],
    produces: ['javaFrontendLowering'],
  },
  {
    name: 'frontend.lowerGenericsErasure',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Apply Java generic erasure, casts, bridge metadata, and signature attributes.',
    dependsOn: ['frontend.lowerInnerClasses', 'frontend.resolveGenerics'],
    produces: ['javaFrontendLowering'],
  },
  {
    name: 'frontend.lowerEnums',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Lower enum constants, values/valueOf methods, synthetic arrays, and enum constructors.',
    dependsOn: ['frontend.lowerGenericsErasure'],
    produces: ['javaFrontendLowering'],
  },
  {
    name: 'frontend.lowerRecords',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Lower record components, accessors, canonical constructors, and record attributes.',
    dependsOn: ['frontend.lowerEnums'],
    produces: ['javaFrontendLowering'],
  },
  {
    name: 'frontend.lowerAssertions',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Lower assert statements into assertion-status checks and AssertionError construction.',
    dependsOn: ['frontend.lowerRecords'],
    produces: ['javaFrontendLowering'],
  },
  {
    name: 'frontend.lowerSynchronized',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Lower synchronized methods/blocks to monitorenter/monitorexit-safe control flow.',
    dependsOn: ['frontend.lowerAssertions'],
    produces: ['javaFrontendLowering'],
  },
  {
    name: 'frontend.lowerInitializers',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Lower field initializers, instance initializers, static initializers, and constructor chaining.',
    dependsOn: ['frontend.lowerSynchronized'],
    produces: ['javaFrontendLowering'],
  },
  {
    name: 'frontend.lowerSyntheticBridges',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Plan synthetic bridge/accessor methods and synthetic classfile members.',
    dependsOn: ['frontend.lowerInitializers', 'frontend.resolveOverrides'],
    produces: ['javaFrontendLowering'],
  },
  {
    name: 'frontend.lowerAstToIr',
    phase: 'lowering',
    category: 'lowering',
    status: PASS_STATUS.SCAFFOLD,
    description: 'Lower AST/semantic model into a backend-neutral Java IR.',
    dependsOn: ['frontend.lowerSyntheticBridges'],
    produces: ['javaFrontendLowering'],
    factory: 'lowerAstToIr',
  },
  {
    name: 'frontend.validateLoweredIr',
    phase: 'validation',
    category: 'lowering',
    status: PASS_STATUS.STUB,
    description: 'Validate lowered IR ownership, CFG compatibility, and semantic annotations.',
    dependsOn: ['frontend.lowerAstToIr'],
    consumes: ['javaFrontendLowering'],
  },

  {
    name: 'frontend.emitBytecodeIr',
    phase: 'bytecode',
    category: 'bytecode',
    status: PASS_STATUS.SCAFFOLD,
    description: 'Emit stack-machine bytecode IR from lowered Java IR. The current scaffold emits minimal bytecode for Hello World-style classes.',
    dependsOn: ['frontend.validateLoweredIr'],
    produces: ['javaFrontendBytecodeIr'],
    factory: 'emitBytecodeIr',
  },
  {
    name: 'frontend.buildGeneratedBytecodeCfg',
    phase: 'bytecode',
    category: 'bytecode',
    status: PASS_STATUS.STUB,
    description: 'Build bytecode CFGs from generated bytecode IR before classfile emission.',
    dependsOn: ['frontend.emitBytecodeIr'],
    consumes: ['javaFrontendBytecodeIr'],
    produces: ['javaFrontendGeneratedBytecodeCfg'],
  },
  {
    name: 'frontend.assignBytecodeInstructionIds',
    phase: 'bytecode',
    category: 'bytecode',
    status: PASS_STATUS.STUB,
    description: 'Assign stable IDs and offsets to generated bytecode instructions.',
    dependsOn: ['frontend.emitBytecodeIr'],
    consumes: ['javaFrontendBytecodeIr'],
  },
  {
    name: 'frontend.normalizeBytecodeCfg',
    phase: 'bytecode',
    category: 'bytecode-cfg',
    status: PASS_STATUS.SCAFFOLD,
    description: 'Normalize existing bytecode CFG inputs into a serializable bytecode CFG sidecar.',
    dependsOn: [],
    produces: ['javaFrontendBytecodeCfg'],
    factory: 'normalizeBytecodeCfg',
  },
  {
    name: 'frontend.validateBytecodeModel',
    phase: 'validation',
    category: 'bytecode',
    status: PASS_STATUS.STUB,
    description: 'Validate generated bytecode IR, generated bytecode CFGs, and normalized bytecode CFG sidecars.',
    dependsOn: ['frontend.buildGeneratedBytecodeCfg', 'frontend.assignBytecodeInstructionIds', 'frontend.normalizeBytecodeCfg'],
    consumes: ['javaFrontendBytecodeIr', 'javaFrontendGeneratedBytecodeCfg', 'javaFrontendBytecodeCfg'],
  },
  {
    name: 'frontend.emitClassFileModel',
    phase: 'bytecode',
    category: 'bytecode',
    status: PASS_STATUS.SCAFFOLD,
    description: 'Emit serializable classfile model objects before binary classfile serialization. The current scaffold includes Jasmin for supported minimal classes.',
    dependsOn: ['frontend.validateBytecodeModel'],
    produces: ['javaFrontendClassFileModel'],
    factory: 'emitClassFileModel',
  },
  {
    name: 'frontend.validateClassFileModel',
    phase: 'validation',
    category: 'bytecode',
    status: PASS_STATUS.SCAFFOLD,
    description: 'Validate constant pools, attributes, method descriptors, instruction offsets, and stack-map prerequisites for produced classfile models.',
    dependsOn: ['frontend.emitClassFileModel'],
    consumes: ['javaFrontendClassFileModel'],
    factory: 'validateClassFileModel',
  },

  {
    name: 'frontend.resolveMethodKeys',
    phase: 'join',
    category: 'cfg-join',
    status: PASS_STATUS.STUB,
    description: 'Attach bytecode-style method keys to Java CFG graphs.',
    dependsOn: ['frontend.buildJavaCfg'],
    produces: ['javaFrontendCfg'],
    factory: 'resolveMethodKeys',
  },
  {
    name: 'frontend.collectDebugAnchors',
    phase: 'join',
    category: 'cfg-join',
    status: PASS_STATUS.STUB,
    description: 'Collect LineNumberTable, LocalVariableTable, SourceFile, and source-range anchors.',
    dependsOn: ['frontend.resolveMethodKeys', 'frontend.normalizeBytecodeCfg'],
    produces: ['javaFrontendCfgJoinDebugAnchors'],
  },
  {
    name: 'frontend.collectStructuralAnchors',
    phase: 'join',
    category: 'cfg-join',
    status: PASS_STATUS.STUB,
    description: 'Collect CFG shape, constants, field/method refs, branch, return, and switch anchors for heuristic joins.',
    dependsOn: ['frontend.collectDebugAnchors'],
    produces: ['javaFrontendCfgJoinStructuralAnchors'],
  },
  {
    name: 'frontend.collectCfgJoinAnchors',
    phase: 'join',
    category: 'cfg-join',
    status: PASS_STATUS.SCAFFOLD,
    description: 'Collect bytecode-origin annotations into a serializable join-anchor sidecar.',
    dependsOn: ['frontend.collectStructuralAnchors', 'frontend.assignNodeIds'],
    produces: ['javaFrontendCfgJoinAnchors'],
    factory: 'collectCfgJoinAnchors',
  },
  {
    name: 'frontend.joinJavaBytecodeCfg',
    phase: 'join',
    category: 'cfg-join',
    status: PASS_STATUS.STUB,
    description: 'Create graph, node, edge, statement, instruction, and exception-region correspondences between Java and bytecode CFGs.',
    dependsOn: ['frontend.buildJavaCfg', 'frontend.normalizeBytecodeCfg', 'frontend.resolveMethodKeys', 'frontend.collectCfgJoinAnchors'],
    consumes: ['javaFrontendCfg', 'javaFrontendBytecodeCfg', 'javaFrontendCfgJoinAnchors'],
    produces: ['javaFrontendCfgJoin'],
    factory: 'joinJavaBytecodeCfg',
  },
  {
    name: 'frontend.validateCfgJoin',
    phase: 'validation',
    category: 'cfg-join',
    status: PASS_STATUS.SCAFFOLD,
    description: 'Validate CFG-join sidecar references against Java CFG and bytecode CFG documents.',
    dependsOn: ['frontend.joinJavaBytecodeCfg'],
    consumes: ['javaFrontendCfgJoin'],
    factory: 'validateCfgJoin',
  },

  {
    name: 'frontend.validateAstSerializable',
    phase: 'validation',
    category: 'serialization',
    status: PASS_STATUS.STUB,
    description: 'Round-trip validate AST JSON serialization and deserialization.',
    dependsOn: ['frontend.validateSyntaxTree'],
    consumes: ['ast'],
  },
  {
    name: 'frontend.validateCfgSerializable',
    phase: 'validation',
    category: 'serialization',
    status: PASS_STATUS.STUB,
    description: 'Round-trip validate Java CFG and bytecode CFG JSON sidecars.',
    dependsOn: ['frontend.buildJavaCfg', 'frontend.normalizeBytecodeCfg'],
    consumes: ['javaFrontendCfg', 'javaFrontendBytecodeCfg'],
  },
  {
    name: 'frontend.validatePassAnnotations',
    phase: 'validation',
    category: 'serialization',
    status: PASS_STATUS.STUB,
    description: 'Validate pass annotations and sidecars remain JSON-compatible and non-cyclic.',
    dependsOn: ['frontend.nodeKindHistogram'],
    consumes: ['node.annotations'],
  },
  {
    name: 'frontend.validateFrontendSerializable',
    phase: 'validation',
    category: 'serialization',
    status: PASS_STATUS.STUB,
    description: 'Validate all frontend sidecars, pass metadata, node annotations, CFGs, joins, and diagnostics are serializable.',
    dependsOn: ['frontend.validateAstSerializable', 'frontend.validateCfgSerializable', 'frontend.validateCfgJoin', 'frontend.validatePassAnnotations'],
  },
  {
    name: 'frontend.validateFrontendModel',
    phase: 'validation',
    category: 'pipeline',
    status: PASS_STATUS.STUB,
    description: 'Terminal umbrella validation pass for the expected Java frontend pipeline.',
    dependsOn: [
      'frontend.validateSymbols',
      'frontend.validateTypes',
      'frontend.validateControlFlow',
      'frontend.validateClassFileModel',
      'frontend.validateFrontendSerializable',
    ],
  },
]);

const SIDE_CAR_TEMPLATES = Object.freeze({
  javaFrontendSyntaxIndex: Object.freeze({
    schema: 'java-tools.java-frontend.syntax-index',
    version: 1,
    status: 'stub',
    sourceFiles: [],
    unsupportedNodes: [],
  }),
  javaFrontendSourceIndex: Object.freeze({
    schema: 'java-tools.java-frontend.source-index',
    version: 1,
    status: 'stub',
    ranges: [],
    tokens: [],
  }),
  javaFrontendDeclarationIndex: Object.freeze({
    schema: 'java-tools.java-frontend.declaration-index',
    version: 1,
    status: 'stub',
    declarations: [],
    owners: [],
  }),
  javaFrontendSymbolTable: Object.freeze({
    schema: 'java-tools.java-frontend.symbol-table',
    version: 1,
    status: 'stub',
    packages: [],
    imports: [],
    types: [],
    members: [],
    locals: [],
    scopes: [],
  }),
  javaFrontendTypeModel: Object.freeze({
    schema: 'java-tools.java-frontend.type-model',
    version: 1,
    status: 'stub',
    types: [],
    conversions: [],
    constants: [],
    overrides: [],
    hierarchy: [],
  }),
  javaFrontendDataflow: Object.freeze({
    schema: 'java-tools.java-frontend.dataflow',
    version: 1,
    status: 'stub',
    analyses: {},
  }),
  javaFrontendLowering: Object.freeze({
    schema: 'java-tools.java-frontend.lowering',
    version: 1,
    status: 'stub',
    stages: [],
    artifacts: [],
  }),
  javaFrontendBytecodeIr: Object.freeze({
    schema: 'java-tools.java-frontend.bytecode-ir',
    version: 1,
    status: 'stub',
    classes: [],
  }),
  javaFrontendGeneratedBytecodeCfg: Object.freeze({
    schema: 'java-tools.java-frontend.generated-bytecode-cfg',
    version: 1,
    status: 'stub',
    graphs: [],
  }),
  javaFrontendClassFileModel: Object.freeze({
    schema: 'java-tools.java-frontend.classfile-model',
    version: 1,
    status: 'stub',
    classes: [],
  }),
  javaFrontendCfgJoinDebugAnchors: Object.freeze({
    schema: 'java-tools.cfg.join.debug-anchors',
    version: 1,
    status: 'stub',
    anchors: [],
  }),
  javaFrontendCfgJoinStructuralAnchors: Object.freeze({
    schema: 'java-tools.cfg.join.structural-anchors',
    version: 1,
    status: 'stub',
    anchors: [],
  }),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDocumentMeta(document) {
  if (!isPlainObject(document.meta)) {
    document.meta = {};
  }
  return document.meta;
}

function compactDefinition(definition) {
  const out = {
    name: definition.name,
    phase: definition.phase,
    category: definition.category,
    status: definition.status,
    description: definition.description,
    dependsOn: (definition.dependsOn || []).slice(),
  };
  if (definition.consumes && definition.consumes.length) {
    out.consumes = definition.consumes.slice();
  }
  if (definition.produces && definition.produces.length) {
    out.produces = definition.produces.slice();
  }
  if (definition.factory) {
    out.factory = definition.factory;
  }
  return out;
}

function attachFrontendPassStubState(document, state, options = {}) {
  const meta = ensureDocumentMeta(document);
  meta[options.key || FRONTEND_PASS_STUBS_AST_META_KEY] = options.clone === false ? state : cloneJsonValue(state);
  return document;
}

function getAttachedFrontendPassStubState(document, options = {}) {
  if (!isPlainObject(document) || !isPlainObject(document.meta)) {
    return null;
  }
  return document.meta[options.key || FRONTEND_PASS_STUBS_AST_META_KEY] || null;
}

function detachFrontendPassStubState(document, options = {}) {
  if (isPlainObject(document) && isPlainObject(document.meta)) {
    delete document.meta[options.key || FRONTEND_PASS_STUBS_AST_META_KEY];
  }
  return document;
}

function createEmptyFrontendPassStubState() {
  return {
    schema: FRONTEND_PASS_STUBS_SCHEMA_ID,
    version: FRONTEND_PASS_STUBS_SCHEMA_VERSION,
    definitions: {},
    runs: [],
  };
}

function ensureFrontendPassStubState(document) {
  const meta = ensureDocumentMeta(document);
  if (!isPlainObject(meta[FRONTEND_PASS_STUBS_AST_META_KEY])) {
    meta[FRONTEND_PASS_STUBS_AST_META_KEY] = createEmptyFrontendPassStubState();
  }
  const state = meta[FRONTEND_PASS_STUBS_AST_META_KEY];
  if (state.schema !== FRONTEND_PASS_STUBS_SCHEMA_ID) {
    state.schema = FRONTEND_PASS_STUBS_SCHEMA_ID;
  }
  if (state.version !== FRONTEND_PASS_STUBS_SCHEMA_VERSION) {
    state.version = FRONTEND_PASS_STUBS_SCHEMA_VERSION;
  }
  if (!isPlainObject(state.definitions)) {
    state.definitions = {};
  }
  if (!Array.isArray(state.runs)) {
    state.runs = [];
  }
  return state;
}

function recordExpectedPassRun(document, definition, options = {}) {
  const state = ensureFrontendPassStubState(document);
  const definitionRecord = compactDefinition(definition);
  state.definitions[definition.name] = definitionRecord;
  const run = {
    name: definition.name,
    phase: definition.phase,
    category: definition.category,
    status: options.status || definition.status || PASS_STATUS.STUB,
    order: state.runs.length,
    produces: (definition.produces || []).slice(),
    consumes: (definition.consumes || []).slice(),
  };
  if (options.note) {
    run.note = options.note;
  }
  state.runs.push(run);
  return run;
}

function ensureSidecar(document, key, passName) {
  const template = SIDE_CAR_TEMPLATES[key];
  if (!template) {
    return null;
  }
  const meta = ensureDocumentMeta(document);
  if (!isPlainObject(meta[key])) {
    meta[key] = cloneJsonValue(template);
  }
  if (!Array.isArray(meta[key].producers)) {
    meta[key].producers = [];
  }
  if (!meta[key].producers.includes(passName)) {
    meta[key].producers.push(passName);
  }
  return meta[key];
}

function runGenericStubPass(document, context, definition, options = {}) {
  for (const produced of definition.produces || []) {
    ensureSidecar(document, produced, definition.name);
  }
  if (options.annotateRoot !== false && document.root && context && typeof context.annotate === 'function') {
    context.annotate(document.root, `${options.annotationPrefix || DEFAULT_NODE_ANNOTATION_PREFIX}${definition.name}`, {
      status: definition.status || PASS_STATUS.STUB,
      phase: definition.phase,
      category: definition.category,
    });
  }
  if (options.emitDiagnostics === true && context && typeof context.emitDiagnostic === 'function') {
    context.emitDiagnostic(
      'FRONTEND_EXPECTED_PASS_STUB',
      `${definition.name} is registered as an expected frontend pass stub.`,
      'info',
      null,
      { expectedPass: compactDefinition(definition) },
    );
  }
  recordExpectedPassRun(document, definition, { note: options.note });
  return document;
}

function passOptionsForDefinition(definition, options = {}) {
  const byName = options.passes && options.passes[definition.name] ? options.passes[definition.name] : {};
  const byFactory = definition.factory && options[definition.factory] ? options[definition.factory] : {};
  return {
    ...(options.defaultPassOptions || {}),
    ...byFactory,
    ...byName,
  };
}

function createConcretePass(definition, options = {}) {
  const passOptions = {
    ...options,
    name: definition.name,
    dependsOn: (definition.dependsOn || []).slice(),
  };
  switch (definition.factory) {
    case 'assignNodeIds':
      return createAssignNodeIdsPass(passOptions);
    case 'nodeKindHistogram':
      return createNodeKindHistogramPass(passOptions);
    case 'initializeCfgDocument':
      return createInitializeCfgDocumentPass(passOptions);
    case 'buildJavaCfg':
      return createBuildJavaCfgPass(passOptions);
    case 'normalizeBytecodeCfg':
      return createNormalizeBytecodeCfgPass(passOptions);
    case 'resolveMethodKeys':
      return createResolveMethodKeysPass(passOptions);
    case 'collectCfgJoinAnchors':
      return createCollectCfgJoinAnchorsPass(passOptions);
    case 'joinJavaBytecodeCfg':
      return createJoinJavaBytecodeCfgPass(passOptions);
    case 'validateCfgJoin':
      return createValidateCfgJoinPass(passOptions);
    case 'lowerAstToIr':
      return createLowerAstToJavaIrPass(passOptions);
    case 'emitBytecodeIr':
      return passOptions.fromJavaIr === true
        ? createEmitJvmBytecodeIrPass(passOptions)
        : createEmitBytecodeIrPass(passOptions);
    case 'emitClassFileModel':
      return createEmitClassFileModelPass(passOptions);
    case 'validateClassFileModel':
      return createValidateClassFileModelPass(passOptions);
    default:
      return null;
  }
}

function wrapExpectedPass(definition, pass, options = {}) {
  return {
    name: definition.name,
    phase: definition.phase,
    description: definition.description,
    dependsOn: (definition.dependsOn || []).slice(),
    run(document, context) {
      let current = document;
      if (pass && typeof pass.run === 'function') {
        const returned = pass.run.call(pass, current, context);
        if (returned !== undefined) {
          current = returned;
        }
      } else {
        current = runGenericStubPass(current, context, definition, options);
        return current;
      }

      for (const produced of definition.produces || []) {
        ensureSidecar(current, produced, definition.name);
      }
      if (options.annotateRoot !== false && current.root && context && typeof context.annotate === 'function') {
        context.annotate(current.root, `${options.annotationPrefix || DEFAULT_NODE_ANNOTATION_PREFIX}${definition.name}`, {
          status: definition.status || PASS_STATUS.STUB,
          phase: definition.phase,
          category: definition.category,
        });
      }
      recordExpectedPassRun(current, definition);
      return current;
    },
  };
}

function createFrontendPassStub(definitionOrName, options = {}) {
  const definition = typeof definitionOrName === 'string'
    ? getExpectedFrontendPassDefinition(definitionOrName)
    : definitionOrName;
  if (!definition) {
    throw new Error(`Unknown expected frontend pass: ${definitionOrName}`);
  }
  const passOptions = passOptionsForDefinition(definition, options);
  const concrete = definition.factory ? createConcretePass(definition, passOptions) : null;
  return wrapExpectedPass(definition, concrete, passOptions);
}

function createExpectedFrontendPasses(options = {}) {
  const include = options.include ? new Set(Array.isArray(options.include) ? options.include : [options.include]) : null;
  const exclude = new Set(options.exclude ? (Array.isArray(options.exclude) ? options.exclude : [options.exclude]) : []);
  return FRONTEND_EXPECTED_PASS_DEFINITIONS
    .filter((definition) => (!include || include.has(definition.name)) && !exclude.has(definition.name))
    .map((definition) => createFrontendPassStub(definition, options));
}

function createExpectedFrontendPassStubs(options = {}) {
  return createExpectedFrontendPasses(options)
    .filter((pass) => {
      const definition = getExpectedFrontendPassDefinition(pass.name);
      return definition && definition.status !== PASS_STATUS.IMPLEMENTED;
    });
}

function createFullFrontendPassPipeline(options = {}) {
  return createExpectedFrontendPasses(options);
}

function getExpectedFrontendPassDefinitions(options = {}) {
  const includeImplemented = options.includeImplemented !== false;
  return FRONTEND_EXPECTED_PASS_DEFINITIONS
    .filter((definition) => includeImplemented || definition.status !== PASS_STATUS.IMPLEMENTED)
    .map(compactDefinition);
}

function getExpectedFrontendPassDefinition(name) {
  return FRONTEND_EXPECTED_PASS_DEFINITIONS.find((definition) => definition.name === name) || null;
}

function validateExpectedFrontendPassDefinitions(definitions = FRONTEND_EXPECTED_PASS_DEFINITIONS) {
  const names = new Set();
  for (const definition of definitions) {
    if (!isPlainObject(definition)) {
      throw new TypeError('Expected frontend pass definition must be a plain object');
    }
    if (typeof definition.name !== 'string' || definition.name.length === 0) {
      throw new TypeError('Expected frontend pass definition name must be a non-empty string');
    }
    if (names.has(definition.name)) {
      throw new Error(`Duplicate expected frontend pass: ${definition.name}`);
    }
    names.add(definition.name);
    if (!Array.isArray(definition.dependsOn)) {
      throw new TypeError(`Expected frontend pass ${definition.name} dependsOn must be an array`);
    }
  }
  for (const definition of definitions) {
    for (const dependency of definition.dependsOn) {
      if (!names.has(dependency)) {
        throw new Error(`Expected frontend pass ${definition.name} depends on unknown pass: ${dependency}`);
      }
    }
  }
  return definitions;
}

function validateFrontendPassStubState(state) {
  if (!isPlainObject(state)) {
    throw new TypeError('Frontend pass stub state must be a plain object');
  }
  if (state.schema !== FRONTEND_PASS_STUBS_SCHEMA_ID) {
    throw new TypeError(`Frontend pass stub state schema must be ${FRONTEND_PASS_STUBS_SCHEMA_ID}`);
  }
  if (state.version !== FRONTEND_PASS_STUBS_SCHEMA_VERSION) {
    throw new TypeError(`Frontend pass stub state version must be ${FRONTEND_PASS_STUBS_SCHEMA_VERSION}`);
  }
  if (!isPlainObject(state.definitions)) {
    throw new TypeError('Frontend pass stub state definitions must be an object');
  }
  if (!Array.isArray(state.runs)) {
    throw new TypeError('Frontend pass stub state runs must be an array');
  }
  for (const [name, definition] of Object.entries(state.definitions)) {
    if (!isPlainObject(definition) || definition.name !== name) {
      throw new TypeError(`Frontend pass stub definition entry is invalid: ${name}`);
    }
  }
  for (const [index, run] of state.runs.entries()) {
    if (!isPlainObject(run) || typeof run.name !== 'string' || run.name.length === 0) {
      throw new TypeError(`Frontend pass stub run ${index} is invalid`);
    }
    if (typeof run.order !== 'number' || run.order !== index) {
      throw new TypeError(`Frontend pass stub run ${index} has invalid order`);
    }
  }
  JSON.stringify(state);
  return state;
}

module.exports = {
  FRONTEND_PASS_STUBS_SCHEMA_ID,
  FRONTEND_PASS_STUBS_SCHEMA_VERSION,
  FRONTEND_PASS_STUBS_AST_META_KEY,
  FRONTEND_EXPECTED_PASS_DEFINITIONS,
  PASS_STATUS,
  attachFrontendPassStubState,
  getAttachedFrontendPassStubState,
  detachFrontendPassStubState,
  createEmptyFrontendPassStubState,
  ensureFrontendPassStubState,
  recordExpectedPassRun,
  createFrontendPassStub,
  createExpectedFrontendPasses,
  createExpectedFrontendPassStubs,
  createFullFrontendPassPipeline,
  getExpectedFrontendPassDefinitions,
  getExpectedFrontendPassDefinition,
  validateExpectedFrontendPassDefinitions,
  validateFrontendPassStubState,
};
