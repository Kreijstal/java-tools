'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ast = require('../src/java-frontend/ast');
const parser = require('../src/java-frontend/parser');

// Retain the original defensive-copy construction as an independent parser
// oracle. Grammar and lexer inputs are identical; only construction differs.
const filename = path.resolve(__dirname, '../src/java-frontend/parser.js');
const legacyModule = new Module(filename, module);
legacyModule.filename = filename;
legacyModule.paths = Module._nodeModulePaths(path.dirname(filename));
const ordinaryRequire = legacyModule.require.bind(legacyModule);
legacyModule.require = name => name === './ast' ? {...ast,
  _createParserFactory: () => ({...ast, _finishTree: value => value}),
} : ordinaryRequire(name);
legacyModule._compile(fs.readFileSync(filename, 'utf8'), filename);
const legacy = legacyModule.exports;

test('public factories retain defensive copies and omit undefined fields', () => {
  const child = ast.identifier('original');
  const metadata = {nested: {present: 7, absent: undefined}};
  const result = ast.createNode('BinaryExpression', {operator: '+', left: child, right: child, absent: undefined}, metadata);
  child.name = 'changed';metadata.nested.present = 11;
  assert.equal(result.left.name, 'original');assert.equal(result.right.name, 'original');
  assert.notEqual(result.left, result.right);assert.equal(result.meta.nested.present, 7);
  assert.ok(!Object.hasOwn(result, 'absent'));assert.ok(!Object.hasOwn(result.meta.nested, 'absent'));
  assert.equal(require('../src/java-frontend')._createParserFactory, undefined);
});

test('parser-owned sharing is detached before the result escapes', () => {
  const owned = ast._createParserFactory();const child = owned.identifier('value');
  const expression = owned.binaryExpression('+', child, child);
  assert.equal(expression.left, child);assert.equal(expression.right, child);
  const result = owned._finishTree(expression);
  assert.notEqual(result.left, child);assert.notEqual(result.right, child);assert.notEqual(result.left, result.right);
  result.left.name = 'changed';assert.equal(result.right.name, 'value');assert.equal(child.name, 'value');
});

test('all implemented parser entry points preserve the original JSON tree', () => {
  const cases = [
    ['parsePackageDeclaration', 'package sample.deep;'],
    ['parseImportDeclaration', 'import static java.util.Collections.*;'],
    ['parseTypeDeclaration', 'class Example<T extends Number> { T value; }'],
    ['parseClassDeclaration', 'public class Example { int first=1,second=2; void run(){if(first>0)second++;else second--;} }'],
    ['parseInterfaceDeclaration', 'interface Example<T> extends Runnable { default int value(){return 7;} }'],
    ['parseEnumDeclaration', 'enum Example { FIRST(1), SECOND(2); Example(int value){} }'],
    ['parseRecordDeclaration', 'record Example<T>(T value, int count) implements Runnable { public void run(){} }'],
    ['parseAnnotation', '@Example(value={1,2}, name="text")'],
    ['parseType', 'java.util.Map<String,java.util.List<? extends Number>>[][]'],
    ['parseExpression', 'factory().<java.util.List<String>>make(value).size() + (int)(offset * 3L)'],
    ['parseStatement', 'outer: while(ready()){try{synchronized(lock){if(test())break outer;step();}}catch(RuntimeException error){throw error;}finally{finish();}}'],
    ['parseStatement', 'switch(value){case 1: case 2: return left(); default: return right();}'],
  ];
  for (const [method, source] of cases) {
    const options = {sourceLevel: 21};
    const before = new legacy.JavaParser(options)[method](source);
    const after = new parser.JavaParser(options)[method](source);
    assert.equal(JSON.stringify(after), JSON.stringify(before), method + ': ' + source);
  }
  const units = [
    '', 'package demo; import java.util.*; class Example { int x; }',
    '@Deprecated package sample.deep; class Example {}',
    '@Deprecated public class Example<T> { @Deprecated private final List<T> values=null; int run(int n){int x=0;for(int i=0;i<n;i++){if((i&1)==0)x+=i;else x-=i;}return x;} }',
    'class Example { int run(int x){try{while(x>0){if(x==3)break;x--;}}catch(IllegalArgumentException|IllegalStateException error){return -1;}finally{x+=2;}return x;} }',
    'record Example(String name,int count) { public Example { if(count<0)throw new IllegalArgumentException(); } }',
  ];
  for (const source of units)
    assert.equal(JSON.stringify(parser.parseJava(source, {sourceLevel: 21})),
      JSON.stringify(legacy.parseJava(source, {sourceLevel: 21})), source);
});

test('long expression prefixes have linear copying work', () => {
  function construct(factory, size) {
    const entries = Object.entries;let visits = 0;
    Object.entries = value => {visits++;return entries(value);};
    try {
      let expression = factory.identifier('value');
      for (let i=0;i<size;i++) expression = factory.binaryExpression('+', expression, factory.literalExpression(i, 'number', String(i)));
      return {tree: factory._finishTree ? factory._finishTree(expression) : expression, visits};
    } finally {Object.entries = entries;}
  }
  const old = construct(ast, 128), first = construct(ast._createParserFactory(), 128);
  const second = construct(ast._createParserFactory(), 256);
  assert.deepEqual(first.tree, old.tree);
  assert.ok(first.visits < 40*128, 'bounded object visits per output node');
  assert.ok(second.visits < 3*first.visits, 'doubling the input cannot quadruple copying');
  assert.ok(old.visits > 10*first.visits, 'the regression oracle demonstrates repeated prefix copying');
});

test('deep ordinary expressions detach without recursive cloning overflow', () => {
  const count = 4000;const source = Array.from({length: count}, (_, index) => 'value'+index).join(' + ');
  let expression = new parser.JavaParser().parseExpression(source);let operators = 0;
  while (expression.kind === 'BinaryExpression') {assert.equal(expression.operator, '+');operators++;expression=expression.left;}
  assert.equal(operators, count-1);assert.equal(expression.name, 'value0');
});
