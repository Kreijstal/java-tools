// Verification of finished generated JavaScript.
//
// This module is a check, never a transformation: nothing in the compiler
// reads back the JavaScript it has emitted in order to decide what to emit.
// It parses a finished body and answers one question about it, so it owns the
// only acorn dependency in the JIT's emission path and is the natural place
// for further generated-source audits.
//
// Consumers:
//   * JvmSsaBlockRenderer, behind JVM_JIT_VERIFY_GENERATED=1;
//   * JitCompiler's free-name report, behind JVM_JIT_VERIFY_FREE_NAMES=1;
//   * tests, which call unboundGeneratedSsaIdentifiers directly.
const { parse: parseJavaScript } = require("acorn");

function walkJavaScriptAst(node, visit, parent = null) {
  if (!node || typeof node !== "object") return;
  const pending = [{node, parent}];
  while (pending.length) {
    const current = pending.pop();
    visit(current.node, current.parent);
    // The verifier's question is per-identifier and order independent. Avoid
    // Object.entries(), flatMap(), and a host call frame per AST node for
    // generated bodies containing hundreds of thousands of nodes.
    for (const key in current.node) {
      if (key === "start" || key === "end" || key === "loc" ||
          key === "range") continue;
      const child = current.node[key];
      if (Array.isArray(child)) {
        for (let index = 0; index < child.length; index += 1) {
          const entry = child[index];
          if (entry && typeof entry.type === "string") {
            pending.push({node: entry, parent: current.node});
          }
        }
      } else if (child && typeof child.type === "string") {
        pending.push({node: child, parent: current.node});
      }
    }
  }
}

function parseGeneratedStatements(source) {
  // The verifier below parses a finished body; wrapping it in a generator
  // keeps `yield` and top-level `return` legal for the parser.
  return parseJavaScript(`function* __jvmSsaAstWrapper() {\n${source}\n}`, {
    ecmaVersion: "latest",
  });
}

// Opt-in verifier. The generated body must never reference an SSA name that
// no enclosing scope declares; the emitters are responsible for that by
// construction, and this parse only re-checks the result when
// JVM_JIT_VERIFY_GENERATED=1 asks for it (or when a test calls it directly).
// It is a check, never a transformation: nothing in the compiler reads back
// the JavaScript it has emitted in order to decide what to emit.
function unboundGeneratedSsaIdentifiers(source, candidates = null,
  externallyBound = null) {
  const program = parseGeneratedStatements(source);
  const nodeScopes = new WeakMap();
  const declarationIdentifiers = new WeakSet();
  const createScope = (parent) => ({parent, bindings: new Set()});
  const rootScope = createScope(null);
  // Names the finished body does not declare because its caller supplies
  // them: the generated function's own parameters and its captures.
  if (externallyBound) for (const name of externallyBound) {
    rootScope.bindings.add(name);
  }
  const isCandidate = (name) => typeof candidates === "function"
    ? candidates(name)
    : candidates ? candidates.has(name) : name.startsWith("ssaValue");
  const visitChildren = (node, visit) => {
    for (const key in node) {
      if (key === "start" || key === "end" || key === "loc" ||
          key === "range") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (let index = 0; index < child.length; index += 1) {
          const entry = child[index];
          if (entry && typeof entry.type === "string") visit(entry);
        }
      } else if (child && typeof child.type === "string") {
        visit(child);
      }
    }
  };
  const declarePattern = (pattern, scope) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      declarationIdentifiers.add(pattern);
      if (isCandidate(pattern.name)) scope.bindings.add(pattern.name);
      return;
    }
    if (pattern.type === "RestElement") {
      declarePattern(pattern.argument, scope);
    } else if (pattern.type === "AssignmentPattern") {
      declarePattern(pattern.left, scope);
    } else if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements) declarePattern(element, scope);
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        declarePattern(property.value || property.argument, scope);
      }
    }
  };
  const define = (node, scope) => {
    if (!node || typeof node !== "object") return;
    nodeScopes.set(node, scope);
    if (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") {
      if (node.id) declarePattern(node.id, scope);
      const functionScope = createScope(scope);
      for (const parameter of node.params) {
        declarePattern(parameter, functionScope);
      }
      define(node.body, functionScope);
      return;
    }
    if (node.type === "BlockStatement") {
      const blockScope = createScope(scope);
      nodeScopes.set(node, blockScope);
      for (const statement of node.body) define(statement, blockScope);
      return;
    }
    if (node.type === "CatchClause") {
      const catchScope = createScope(scope);
      nodeScopes.set(node, catchScope);
      declarePattern(node.param, catchScope);
      define(node.body, catchScope);
      return;
    }
    if (node.type === "ForStatement" || node.type === "ForInStatement" ||
        node.type === "ForOfStatement" || node.type === "SwitchStatement") {
      const controlScope = createScope(scope);
      nodeScopes.set(node, controlScope);
      visitChildren(node, (child) => define(child, controlScope));
      return;
    }
    if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations) {
        declarePattern(declarator.id, scope);
      }
    }
    visitChildren(node, (child) => define(child, scope));
  };
  define(program, rootScope);

  const unbound = new Set();
  walkJavaScriptAst(program, (node, parent) => {
    if (node.type !== "Identifier" || !isCandidate(node.name) ||
        declarationIdentifiers.has(node)) return;
    if (parent?.type === "MemberExpression" && parent.property === node &&
        !parent.computed) return;
    if ((parent?.type === "Property" || parent?.type === "MethodDefinition") &&
        parent.key === node && !parent.computed && !parent.shorthand) return;
    if ((parent?.type === "LabeledStatement" ||
        parent?.type === "BreakStatement" ||
        parent?.type === "ContinueStatement") && parent.label === node) return;
    let bound = false;
    for (let scope = nodeScopes.get(node) || rootScope; scope && !bound;
      scope = scope.parent) {
      bound = scope.bindings.has(node.name);
    }
    if (!bound) unbound.add(node.name);
  });
  return [...unbound];
}


module.exports = {
  walkJavaScriptAst,
  parseGeneratedStatements,
  unboundGeneratedSsaIdentifiers,
};
