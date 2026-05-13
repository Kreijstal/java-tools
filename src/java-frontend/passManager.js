'use strict';

const ast = require('./ast');
const { validateAstDocument } = require('./serialization');
const { visitAst, transformAst } = require('./traversal');
const {
  annotateNode,
  hasNodeAnnotation,
  getNodeAnnotation,
  removeNodeAnnotation,
  listNodeAnnotations,
  clearNodeAnnotations,
} = require('./annotations');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeNameList(value, optionName) {
  if (value === undefined || value === null) {
    return null;
  }
  let names;
  if (typeof value === 'string') {
    names = [value];
  } else if (Array.isArray(value)) {
    names = value;
  } else if (value instanceof Set) {
    names = Array.from(value);
  } else {
    throw new TypeError(`${optionName} must be a string, array, Set, null, or undefined`);
  }
  for (const name of names) {
    assertPassName(name);
  }
  return new Set(names);
}

function assertPassName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('AST pass name must be a non-empty string');
  }
}

function normalizePass(pass) {
  if (!isPlainObject(pass)) {
    throw new TypeError('AST pass must be a plain object');
  }
  assertPassName(pass.name);
  if (pass.run !== undefined && typeof pass.run !== 'function') {
    throw new TypeError(`AST pass ${pass.name} run property must be a function`);
  }
  if (pass.visitor !== undefined && (typeof pass.visitor !== 'function' && !isPlainObject(pass.visitor))) {
    throw new TypeError(`AST pass ${pass.name} visitor property must be a function or a plain object`);
  }
  if (pass.run === undefined && pass.visitor === undefined) {
    throw new TypeError(`AST pass ${pass.name} must provide run or visitor`);
  }

  const dependsOn = pass.dependsOn === undefined ? [] : pass.dependsOn;
  if (!Array.isArray(dependsOn)) {
    throw new TypeError(`AST pass ${pass.name} dependsOn property must be an array`);
  }
  for (const dependency of dependsOn) {
    assertPassName(dependency);
  }

  return Object.freeze({
    name: pass.name,
    description: pass.description || '',
    phase: pass.phase || 'analysis',
    dependsOn: dependsOn.slice(),
    transform: Boolean(pass.transform),
    visitor: pass.visitor,
    run: pass.run || ((document, context) => {
      if (pass.transform) {
        return context.transform(document, pass.visitor);
      }
      context.visit(document, pass.visitor);
      return document;
    }),
  });
}

function ensureDiagnostics(document) {
  if (!Array.isArray(document.diagnostics)) {
    document.diagnostics = [];
  }
  return document.diagnostics;
}

function ensurePassHistory(document) {
  if (!isPlainObject(document.meta)) {
    document.meta = {};
  }
  if (!isPlainObject(document.meta.passManager)) {
    document.meta.passManager = { runs: [] };
  }
  if (!Array.isArray(document.meta.passManager.runs)) {
    document.meta.passManager.runs = [];
  }
  return document.meta.passManager.runs;
}

class JavaAstPassContext {
  constructor(document, pass, options = {}) {
    this.document = document;
    this.pass = pass;
    this.passName = pass.name;
    this.options = options;
    this.state = {};
  }

  visit(target, visitor, options = {}) {
    return visitAst(target || this.document, visitor, options);
  }

  transform(target, visitor, options = {}) {
    return transformAst(target || this.document, visitor, options);
  }

  annotate(node, key, value, options = {}) {
    return annotateNode(node, key, value, options);
  }

  hasAnnotation(node, key) {
    return hasNodeAnnotation(node, key);
  }

  getAnnotation(node, key, defaultValue = undefined) {
    return getNodeAnnotation(node, key, defaultValue);
  }

  removeAnnotation(node, key) {
    return removeNodeAnnotation(node, key);
  }

  listAnnotations(node) {
    return listNodeAnnotations(node);
  }

  clearAnnotations(node) {
    return clearNodeAnnotations(node);
  }

  emitDiagnostic(code, message, severity = 'warning', range = null, extra = {}) {
    const diagnostics = ensureDiagnostics(this.document);
    const diagnostic = ast.diagnostic(code, message, severity, range);
    diagnostic.pass = this.passName;
    for (const [key, value] of Object.entries(extra)) {
      diagnostic[key] = value;
    }
    diagnostics.push(diagnostic);
    return diagnostic;
  }
}

class JavaAstPassManager {
  constructor(options = {}) {
    this.options = options;
    this.passes = new Map();
    if (options.passes !== undefined) {
      for (const pass of options.passes) {
        this.register(pass);
      }
    }
  }

  register(pass) {
    const normalized = normalizePass(pass);
    if (this.passes.has(normalized.name)) {
      throw new Error(`AST pass is already registered: ${normalized.name}`);
    }
    this.passes.set(normalized.name, normalized);
    return this;
  }

  unregister(name) {
    assertPassName(name);
    this.passes.delete(name);
    return this;
  }

  has(name) {
    assertPassName(name);
    return this.passes.has(name);
  }

  get(name) {
    assertPassName(name);
    return this.passes.get(name) || null;
  }

  listPasses() {
    return Array.from(this.passes.values()).map((pass) => ({
      name: pass.name,
      phase: pass.phase,
      description: pass.description,
      dependsOn: pass.dependsOn.slice(),
      transform: pass.transform,
    }));
  }

  resolvePasses(options = {}) {
    const include = normalizeNameList(options.include, 'include');
    const exclude = normalizeNameList(options.exclude, 'exclude') || new Set();
    const includeDependencies = options.includeDependencies !== false;
    const selected = new Set();

    if (include) {
      for (const name of include) {
        assertPassName(name);
        if (!this.passes.has(name)) {
          throw new Error(`Unknown AST pass: ${name}`);
        }
        selected.add(name);
      }
    } else {
      for (const name of this.passes.keys()) {
        selected.add(name);
      }
    }

    const ordered = [];
    const visiting = new Set();
    const visited = new Set();

    const visitDependency = (name, requestedBy = null) => {
      if (visited.has(name)) {
        return;
      }
      if (exclude.has(name)) {
        const reason = requestedBy ? ` required by ${requestedBy}` : '';
        throw new Error(`AST pass is excluded${reason}: ${name}`);
      }
      const pass = this.passes.get(name);
      if (!pass) {
        const reason = requestedBy ? ` required by ${requestedBy}` : '';
        throw new Error(`Unknown AST pass${reason}: ${name}`);
      }
      if (visiting.has(name)) {
        throw new Error(`AST pass dependency cycle includes: ${name}`);
      }
      visiting.add(name);
      for (const dependency of pass.dependsOn) {
        if (includeDependencies || selected.has(dependency)) {
          visitDependency(dependency, name);
        } else {
          throw new Error(`AST pass dependency not selected: ${dependency}`);
        }
      }
      visiting.delete(name);
      visited.add(name);
      if (selected.has(name) || (include && includeDependencies)) {
        ordered.push(pass);
      }
    };

    for (const name of selected) {
      if (!exclude.has(name)) {
        visitDependency(name);
      }
    }

    if (include && includeDependencies) {
      const seen = new Set();
      return ordered.filter((pass) => {
        if (seen.has(pass.name)) {
          return false;
        }
        seen.add(pass.name);
        return true;
      });
    }
    return ordered.filter((pass) => !exclude.has(pass.name));
  }

  run(document, options = {}) {
    return this.runWithResult(document, options).document;
  }

  runWithResult(document, options = {}) {
    if (!ast.isAstDocument(document)) {
      throw new TypeError('Pass manager input must be a Java AST document');
    }
    const runOptions = { ...this.options, ...options };
    if (runOptions.validateInput !== false) {
      validateAstDocument(document);
    }
    let current = document;
    const resolvedPasses = this.resolvePasses(runOptions);
    const results = [];

    for (const pass of resolvedPasses) {
      const context = new JavaAstPassContext(current, pass, runOptions);
      const diagnosticsBefore = Array.isArray(current.diagnostics) ? current.diagnostics.length : 0;
      const returned = pass.run(current, context);
      if (returned !== undefined) {
        if (!ast.isAstDocument(returned)) {
          throw new TypeError(`AST pass ${pass.name} returned a non-document value`);
        }
        current = returned;
        context.document = current;
      }
      const diagnosticsAfter = Array.isArray(current.diagnostics) ? current.diagnostics.length : 0;
      const result = {
        name: pass.name,
        phase: pass.phase,
        diagnosticsAdded: diagnosticsAfter - diagnosticsBefore,
      };
      results.push(result);
      if (runOptions.recordHistory === true) {
        ensurePassHistory(current).push(result);
      }
      if (runOptions.validateAfterEach === true) {
        validateAstDocument(current);
      }
    }

    if (runOptions.validateOutput !== false) {
      validateAstDocument(current);
    }
    return { document: current, results };
  }
}

function runAstPasses(document, passes, options = {}) {
  const manager = new JavaAstPassManager({ passes });
  return manager.run(document, options);
}

function createAssignNodeIdsPass(options = {}) {
  const annotationKey = options.annotationKey || 'frontend.nodeId';
  const prefix = options.prefix || 'n';
  const overwrite = Boolean(options.overwrite);
  return {
    name: options.name || 'frontend.assignNodeIds',
    phase: 'annotation',
    description: 'Assigns stable traversal-order node IDs as serializable node annotations.',
    run(document, context) {
      let nextId = 0;
      context.visit(document, {
        enter(node) {
          const id = `${prefix}${nextId}`;
          nextId += 1;
          if (overwrite || !context.hasAnnotation(node, annotationKey)) {
            context.annotate(node, annotationKey, id);
          }
        },
      }, options.traversal || {});
      context.annotate(document.root, 'frontend.assignNodeIds.count', nextId);
      return document;
    },
  };
}

function createNodeKindHistogramPass(options = {}) {
  const annotationKey = options.annotationKey || 'frontend.kindHistogram';
  return {
    name: options.name || 'frontend.nodeKindHistogram',
    phase: 'analysis',
    description: 'Annotates the compilation unit with a histogram of AST node kinds.',
    dependsOn: options.dependsOn || [],
    run(document, context) {
      const counts = {};
      context.visit(document, {
        enter(node) {
          counts[node.kind] = (counts[node.kind] || 0) + 1;
        },
      }, options.traversal || {});
      context.annotate(document.root, annotationKey, counts);
      return document;
    },
  };
}

module.exports = {
  JavaAstPassManager,
  JavaAstPassContext,
  runAstPasses,
  createAssignNodeIdsPass,
  createNodeKindHistogramPass,
};
