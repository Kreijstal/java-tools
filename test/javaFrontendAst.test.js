'use strict';

const fs = require('fs');
const path = require('path');
const test = require('tape');
const frontend = require('../src/java-frontend');

function collectJavaFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJavaFiles(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.java')) {
      out.push(fullPath);
    }
  }
  return out;
}

test('Java frontend AST serializes and deserializes as stable JSON', (t) => {
  const intType = frontend.primitiveType('int');
  const astDocument = frontend.createAstDocument(
    frontend.compilationUnit({
      packageDeclaration: frontend.packageDeclaration(frontend.qualifiedName(['example', 'demo'])),
      imports: [frontend.importDeclaration(frontend.qualifiedName(['java', 'util', 'List']))],
      typeDeclarations: [
        frontend.classDeclaration('Adder', {
          modifiers: [frontend.modifier('public')],
          body: [
            frontend.methodDeclaration('add', intType, {
              modifiers: [frontend.modifier('public')],
              parameters: [
                frontend.formalParameter('left', intType),
                frontend.formalParameter('right', intType),
              ],
              body: frontend.blockStatement([
                frontend.returnStatement(
                  frontend.binaryExpression(
                    '+',
                    frontend.identifier('left'),
                    frontend.identifier('right'),
                  ),
                ),
              ]),
            }),
          ],
        }),
      ],
    }),
    { sourceLevel: 8 },
  );

  const serialized = frontend.serializeAst(astDocument);
  const deserialized = frontend.deserializeAst(serialized);

  t.equal(typeof serialized, 'string', 'serialization returns JSON text');
  t.deepEqual(deserialized, frontend.toAstJson(astDocument), 'deserialized AST matches the canonical JSON tree');
  t.equal(frontend.serializeAst(deserialized), serialized, 'serialization is stable');
  t.end();
});

test('Java frontend AST rejects unknown node kinds', (t) => {
  t.throws(
    () => frontend.createNode('MadeUpNodeKind'),
    /Unknown Java AST node kind/,
    'factory rejects unknown node kinds',
  );
  t.end();
});

test('Java frontend AST validation rejects cyclic trees', (t) => {
  const root = frontend.compilationUnit();
  root.typeDeclarations.push(root);
  const document = {
    schema: frontend.AST_SCHEMA_ID,
    version: frontend.AST_SCHEMA_VERSION,
    root,
  };

  t.throws(
    () => frontend.serializeAst(document),
    /cycle/,
    'serializer rejects cyclic AST documents',
  );
  t.end();
});

test('Java parser returns an empty compilation unit for empty source', (t) => {
  const document = frontend.parseJava('', { sourceLevel: 21 });

  t.equal(document.schema, frontend.AST_SCHEMA_ID, 'returns a Java AST document');
  t.equal(document.sourceLevel, 21, 'preserves source level option');
  t.equal(document.root.kind, 'CompilationUnit', 'root is a compilation unit');
  t.deepEqual(document.root.typeDeclarations, [], 'empty source has no type declarations');
  t.end();
});

test('Java parser parses a simple class declaration in strict mode', (t) => {
  const source = 'package demo; import java.util.List; public class A { private int value = 1; public int get() { return value; } }';
  const document = frontend.parseJava(source, { sourceLevel: 8 });
  const type = document.root.typeDeclarations[0];

  t.equal(document.root.packageDeclaration.name.parts.join('.'), 'demo', 'package is parsed');
  t.equal(document.root.imports[0].name.parts.join('.'), 'java.util.List', 'import is parsed');
  t.equal(type.kind, 'ClassDeclaration', 'class declaration is parsed');
  t.equal(type.name, 'A', 'class name is parsed');
  t.equal(type.body[0].kind, 'FieldDeclaration', 'field member is parsed');
  t.equal(type.body[1].kind, 'MethodDeclaration', 'method member is parsed');
  t.equal(type.body[1].body.kind, 'BlockStatement', 'method body is parsed as a block');
  t.end();
});

test('Java parser structures anonymous class creation expressions', (t) => {
  const source = 'class A { void f() { Runnable r = new Runnable() { public void run() { System.out.println("x"); } }; } }';
  const document = frontend.parseJava(source);
  const serialized = frontend.serializeAst(document);

  t.ok(serialized.includes('NewClassExpression'), 'anonymous construction is represented explicitly');
  t.notOk(serialized.includes('UnsupportedExpression'), 'anonymous construction contains no expression fallback');
  t.doesNotThrow(() => frontend.deserializeAst(serialized), 'parsed source remains serializable/deserializable');
  t.end();
});

test('Java parser structures Java 7 expression forms without fallback nodes', (t) => {
  const source = `
    @SuppressWarnings({"unchecked", "rawtypes"})
    class Expressions {
      Class type = int[][].class;
      int[] values = new int[] { 1, 2, 3 };
      Object object = new String("x");
      int f(int x, int y) { return (x & y) == 0 ? values[x + 1] : -y; }
    }
  `;
  const serialized = frontend.serializeAst(frontend.parseJava(source));

  t.ok(serialized.includes('NewClassExpression'), 'object creation is structured');
  t.ok(serialized.includes('NewArrayExpression'), 'array creation is structured');
  t.ok(serialized.includes('ArrayInitializerExpression'), 'array initializer is structured');
  t.ok(serialized.includes('ClassLiteralExpression'), 'class literal is structured');
  t.ok(serialized.includes('ConditionalExpression'), 'conditional expression is structured');
  t.notOk(serialized.includes('UnsupportedExpression'), 'covered Java 7 expressions contain no fallback nodes');
  t.end();
});

test('Java parser parses every repo Java source file outside vendored dependencies', (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const files = collectJavaFiles(repoRoot)
    .map((file) => path.relative(repoRoot, file))
    .sort();

  t.ok(files.length >= 100, `Java corpus discovered (${files.length} files)`);
  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    t.doesNotThrow(() => {
      const document = frontend.parseJava(source, { sourceLevel: 21 });
      frontend.validateAstDocument(document);
    }, `parses ${file}`);
  }
  t.end();
});

test('Java frontend exposes semantic stubs and minimal compile implementation', (t) => {
  const javaFrontend = new frontend.JavaFrontend({ sourceLevel: 17 });
  const astDocument = javaFrontend.parse('', {});

  t.throws(() => javaFrontend.bind(astDocument), /bind: name binding/, 'binding phase is stubbed');
  t.throws(() => javaFrontend.resolveTypes(astDocument), /type-resolve: Java type attribution/, 'type attribution phase is stubbed');
  t.throws(() => javaFrontend.resolveOverloads(astDocument), /overload-resolve: method overload resolution/, 'overload phase is stubbed');
  t.throws(() => javaFrontend.analyzeControlFlow(astDocument), /control-flow: Java source control-flow analysis/, 'control-flow phase is stubbed');
  t.doesNotThrow(() => javaFrontend.lowerToBytecode(astDocument), 'minimal bytecode lowering accepts an empty AST document');
  t.doesNotThrow(() => javaFrontend.compile('class Empty { public static void main(String[] args) { } }'), 'minimal compile phase is implemented for simple classes');
  t.end();
});
