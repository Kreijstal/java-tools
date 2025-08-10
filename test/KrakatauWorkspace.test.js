const test = require('tape');
const path = require('path');
const { KrakatauWorkspace, SymbolIdentifier } = require('../src/KrakatauWorkspace');

test('KrakatauWorkspace basic functionality', async function(t) {
  t.plan(8);

  const sourcesPath = path.join(__dirname, '..', 'sources');
  const workspace = await KrakatauWorkspace.create(sourcesPath);

  // Test that workspace was created
  t.ok(workspace, 'Workspace should be created');

  // Test listClasses
  const classes = workspace.listClasses();
  t.ok(Array.isArray(classes), 'listClasses should return an array');
  t.ok(classes.length > 0, 'Should find some classes');

  // Test that we can find a specific class
  const testMethodsClass = classes.find(cls => cls.identifier.className === 'TestMethods');
  t.ok(testMethodsClass, 'Should find TestMethods class');

  // Test listMethods
  const methods = workspace.listMethods('TestMethods');
  t.ok(Array.isArray(methods), 'listMethods should return an array');
  t.ok(methods.length >= 4, 'TestMethods should have at least 4 methods'); // Including constructor

  // Test findSymbol
  const searchResults = workspace.findSymbol('public');
  t.ok(Array.isArray(searchResults), 'findSymbol should return an array');
  t.ok(searchResults.length > 0, 'Should find symbols containing "public"');
});

test('KrakatauWorkspace symbol tree', async function(t) {
  t.plan(4);

  const sourcesPath = path.join(__dirname, '..', 'sources');
  const workspace = await KrakatauWorkspace.create(sourcesPath);

  const symbolTree = workspace.getSymbolTree();
  t.ok(symbolTree, 'Should return a symbol tree');
  t.ok(Array.isArray(symbolTree.children), 'Symbol tree should have children');
  t.ok(symbolTree.children.length > 0, 'Symbol tree should have class children');
  
  // Find TestMethods in the tree
  const testMethodsNode = symbolTree.children.find(child => 
    child.symbol && child.symbol.identifier.className === 'TestMethods'
  );
  t.ok(testMethodsNode, 'Should find TestMethods in symbol tree');
});

test('KrakatauWorkspace findReferences', async function(t) {
  t.plan(2);

  const sourcesPath = path.join(__dirname, '..', 'sources');
  const workspace = await KrakatauWorkspace.create(sourcesPath);

  // Test finding references to a class
  const classIdentifier = new SymbolIdentifier('TestMethods');
  const classReferences = workspace.findReferences(classIdentifier);
  t.ok(Array.isArray(classReferences), 'findReferences should return an array');

  // Test finding references to a method  
  const methodIdentifier = new SymbolIdentifier('TestMethods', 'publicMethod1');
  const methodReferences = workspace.findReferences(methodIdentifier);
  t.ok(Array.isArray(methodReferences), 'findReferences for method should return an array');
});

test('KrakatauWorkspace AST and assembly', async function(t) {
  t.plan(3);

  const sourcesPath = path.join(__dirname, '..', 'sources');
  const workspace = await KrakatauWorkspace.create(sourcesPath);

  // Test getClassAST
  const ast = workspace.getClassAST('TestMethods');
  t.ok(ast, 'Should get AST for TestMethods');

  // Test toKrakatauAssembly
  const assembly = workspace.toKrakatauAssembly('TestMethods');
  t.ok(typeof assembly === 'string', 'toKrakatauAssembly should return a string');
  t.ok(assembly.includes('.class'), 'Assembly should contain .class directive');
});