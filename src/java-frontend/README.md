# Java frontend scaffold

This directory defines the source-level Java frontend boundary for `java-tools`.
The AST schema and serialization layer are usable now, the lexer/parser cover the
current repository Java corpus, and the later compiler phases remain explicit
stubs.

Pipeline shape:

```text
Java source
  -> lexer/token stream
  -> parser
  -> serializable AST document
  -> binder / symbol table              stubbed
  -> type attribution                   stubbed
  -> overload resolution                stubbed
  -> control-flow / definite assignment stubbed
  -> lowering / bytecode emission       stubbed
```

The parser is intentionally frontend-shaped instead of CFR-output-shaped. It
parses compilation units, packages, imports, class/interface/enum/annotation and
record declarations, fields, methods, constructors, initializer blocks, common
structured statements, local declarations, try/catch/finally, try-with-resources,
switch groups, local classes, annotations, basic type syntax, and source ranges.
Hard expressions and not-yet-modeled syntax islands are preserved as
`UnsupportedExpression`, `UnsupportedStatement`, `UnsupportedDeclaration`, or
`UnsupportedType` nodes instead of blocking parsing.

The AST is a JSON-compatible document:

```js
{
  schema: 'java-tools.java-frontend.ast',
  version: 1,
  sourceLevel: 8,
  root: {
    kind: 'CompilationUnit',
    packageDeclaration: null,
    imports: [],
    typeDeclarations: [],
    moduleDeclaration: null
  }
}
```

Nodes use `kind` instead of class instances so that trees can be serialized,
deserialized, compared in tests, and exchanged with future tools. No parent
pointers or functions are stored in the tree. Source ranges, tokens, diagnostics,
and unsupported syntax islands are represented as plain JSON values.


## AST passes and annotations

The frontend includes an AST pass manager for source-to-source/frontend analysis
work without making the syntax tree non-serializable:

```js
const frontend = require('./src/java-frontend');

const document = frontend.parseJava(source, { sourceLevel: 21 });
const manager = new frontend.JavaAstPassManager({
  passes: [
    frontend.createAssignNodeIdsPass(),
    {
      name: 'example.markReturns',
      dependsOn: ['frontend.assignNodeIds'],
      run(astDocument, context) {
        context.visit(astDocument, {
          enter(node) {
            if (node.kind === 'ReturnStatement') {
              context.annotate(node, 'example.hasReturn', true);
            }
          }
        });
        return astDocument;
      }
    }
  ]
});

manager.run(document, { validateAfterEach: true });
```

Passes can be registered with names and dependencies, run as visitors, run as
transforms, emit diagnostics, and annotate nodes. Node annotations are stored in
`node.meta.annotations` so they remain plain JSON and survive
`serializeAst`/`deserializeAst`. Source-level Java annotations still use the
ordinary `annotations` fields on declarations and parameters; pass annotations
live only under `meta`.

Traversal and transform helpers are also exported directly:

```js
frontend.visitAst(document, visitor);
frontend.transformAst(document, visitor);
frontend.collectAstNodes(document, node => node.kind === 'MethodDeclaration');
```

Expansion rule: unsupported constructs should be represented with the nearest
syntax-preserving `Unsupported*` node when the parser can keep moving. Semantic
work remains separate and should happen in the binder/type/control-flow phases,
not in the parser.

## CFG sidecar documents

Control-flow graphs are represented as a separate serializable sidecar instead
of replacing or cyclically linking the AST. A CFG document has its own schema and
version and can either be passed around independently or attached to an AST
document under `document.meta.javaFrontendCfg`:

```js
const cfg = frontend.createCfgDocument([
  frontend.createCfgGraph('cfg:method:Example.f', {
    kind: 'MethodCfg',
    ownerNodeId: 'n42',
    entryBlockId: 'entry',
    exitBlockId: 'exit',
    blocks: [
      frontend.createCfgBlock('entry', {
        kind: 'EntryBlock',
        terminator: frontend.gotoTerminator('exit')
      }),
      frontend.createCfgBlock('exit', {
        kind: 'ExitBlock',
        terminator: frontend.exitTerminator()
      })
    ],
    edges: [
      frontend.createCfgEdge('e0', 'entry', 'exit')
    ]
  })
]);

const json = frontend.serializeCfg(cfg);
const restored = frontend.deserializeCfg(json);
frontend.validateCfgDocument(restored);
```

CFG nodes are plain objects too. Graphs contain blocks, blocks contain AST node
IDs and statement references, and edges/terminators describe control transfer.
The validator checks duplicate graph/block/edge IDs and rejects dangling edge or
terminator targets. AST nodes may be annotated with serializable CFG locations:

```js
frontend.annotateNodeWithCfgLocation(returnNode, {
  graphId: 'cfg:method:Example.f',
  blockId: 'body',
  statementIndex: 0,
  role: 'terminator'
});
```

This keeps the frontend expansion path open: future CFG construction passes can
build precise method-level, expression-sensitive, and exception-aware graphs
without changing the AST storage model.

## Java CFG / bytecode CFG join stubs

The Java frontend also exposes a serializable CFG-join document for connecting
source-shaped Java CFGs to instruction-shaped bytecode CFGs without merging the
two graph models. The join lives under `document.meta.javaFrontendCfgJoin` when
attached to an AST document and uses schema `java-tools.cfg.join`:

```js
const join = frontend.createCfgJoinDocument([
  frontend.createMethodCfgJoin('join:Example.add', {
    method: { owner: 'Example', name: 'add', descriptor: '(II)I' },
    javaGraphId: 'java-cfg:n42',
    bytecodeGraphId: 'bytecode-cfg:Example.add:(II)I',
    correspondences: [
      frontend.createCfgCorrespondence('corr:0', {
        kind: 'GraphToGraph',
        java: { graphId: 'java-cfg:n42' },
        bytecode: { graphId: 'bytecode-cfg:Example.add:(II)I' },
        relation: 'implements',
        confidence: 'high',
        evidence: [{ kind: 'MethodKeyMatch' }]
      })
    ]
  })
]);

const json = frontend.serializeCfgJoin(join);
const restored = frontend.deserializeCfgJoin(json);
frontend.validateCfgJoinDocument(restored);
```

The current join pipeline is intentionally stubbed, but the pass names and data
flow are fixed so later implementations can fill in precision without changing
callers:

```js
frontend.runAstPasses(astDocument, frontend.createCfgJoinStubPasses({
  normalizeBytecodeCfg: {
    bytecodeCfg: bytecodeCfgDocument
  }
}));
```

That expands to these frontend passes:

```text
frontend.assignNodeIds
frontend.initializeCfgDocument
frontend.buildJavaCfg
frontend.normalizeBytecodeCfg
frontend.resolveMethodKeys
frontend.collectCfgJoinAnchors
frontend.joinJavaBytecodeCfg
frontend.validateCfgJoin
```

`frontend.buildJavaCfg` currently creates method-level skeleton graphs with an
explicit `UnsupportedBlock`, `frontend.normalizeBytecodeCfg` converts existing
bytecode CFG objects or bytecode CFG documents into a serializable sidecar, and
`frontend.joinJavaBytecodeCfg` creates graph/anchor correspondences. Bytecode
origin annotations can already be collected as join anchors:

```js
frontend.annotateNode(returnNode, 'java-tools.bytecode-origin', {
  methodKey: { owner: 'Example', name: 'add', descriptor: '(II)I' },
  instructionOffsets: [0, 1, 2, 3],
  role: 'return'
});
```

When precise Java CFG construction and bytecode provenance are implemented, the
join pass can replace the skeleton correspondences with exact block, edge,
statement, and instruction mappings while preserving the same serialized format.

## Expected frontend pass stubs

The repository now has a full expected-pass catalog for the Java frontend. The
catalog is intentionally more complete than the current implementation: it fixes
pass names, dependency order, sidecar names, and serialization boundaries before
we fill in the real algorithms.

```js
const passes = frontend.createFullFrontendPassPipeline({
  normalizeBytecodeCfg: {
    bytecodeCfg: bytecodeCfgDocument
  }
});

const result = new frontend.JavaAstPassManager({ passes }).runWithResult(ast, {
  include: ['frontend.validateFrontendModel'],
  recordHistory: true
});
```

The terminal `frontend.validateFrontendModel` pass pulls in the complete planned
pipeline:

```text
syntax normalization / syntax validation / declaration indexing
symbol-table construction / name resolution / inheritance validation
type attribution / overload resolution / constants / override validation
Java CFG construction / expression CFG / exception/finally flow
dataflow: reachability, dominators, post-dominators, definite assignment, liveness
lowering: enhanced-for, string switch, try-with-resources, lambdas, inner classes,
          erasure, enums, records, assertions, synchronized blocks, initializers,
          synthetic bridges, backend-neutral IR
bytecode: bytecode IR, generated bytecode CFG, instruction IDs, classfile model
join: method keys, debug anchors, structural anchors, bytecode-origin anchors,
      Java-CFG to bytecode-CFG join, join validation
serialization/model validation
```

Every expected pass records serializable status metadata under
`document.meta.javaFrontendExpectedPasses`. Stub sidecars such as
`javaFrontendSymbolTable`, `javaFrontendTypeModel`, `javaFrontendDataflow`,
`javaFrontendLowering`, and `javaFrontendBytecodeIr` are plain JSON objects with
schema/version fields. Concrete scaffolds that already exist, such as node ID
assignment, CFG initialization, skeletal Java CFG construction, bytecode CFG
normalization, and CFG join validation, are included in the same catalog so the
pipeline can run end-to-end while still making stub precision explicit.

## Minimal source compiler scaffold

The frontend now includes a first concrete Java-source-to-classfile path for the
smallest useful executable subset: Hello World-style classes with `main` methods
that call `System.out.println` with literal arguments.

```js
const frontend = require('./src/java-frontend');

const result = frontend.compileJavaSource(`
public class Hello {
  public static void main(String[] args) {
    System.out.println("Hello, World!");
  }
}
`, {
  outputDir: 'out',
  sourceFileName: 'Hello.java'
});
```

This produces serializable sidecars as well as binary class files when
`outputDir` is supplied:

```text
result.bytecodeIr              // java-tools.java-frontend.bytecode-ir
result.classFileModel          // java-tools.java-frontend.classfile-model
result.classes[0].jasmin       // Jasmin used by the repository assembler
result.classes[0].outputPath   // written .class path when outputDir is set
```

The command-line wrapper accepts one or more Java source files:

```bash
node scripts/compileJava.js sources/Hello.java --out /tmp/hello-classes
node scripts/compileJava.js sources/*.java --out sources
java -cp /tmp/hello-classes Hello
```

The CLI uses the repository parser/lowering pipeline and the existing Jasmin
assembly/classfile writer only; it never shells out to `javac`. By default, the
CLI is fail-fast on unsupported constructs.
