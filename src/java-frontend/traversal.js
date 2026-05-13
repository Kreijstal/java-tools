'use strict';

const { isNode, isAstDocument } = require('./ast');
const { cloneAst } = require('./serialization');

const SKIP_CHILDREN = Symbol('java-tools.java-frontend.traversal.skipChildren');
const REMOVE_NODE = Symbol('java-tools.java-frontend.traversal.removeNode');

const DEFAULT_SKIPPED_KEYS = new Set(['kind', 'meta', 'range', 'tokens']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeVisitor(visitor) {
  if (typeof visitor === 'function') {
    return { enter: visitor };
  }
  if (!isPlainObject(visitor)) {
    throw new TypeError('AST visitor must be a function or a plain object');
  }
  return visitor;
}

function shouldSkipField(key, options) {
  if (key === 'kind') {
    return true;
  }
  if (key === 'meta' && options.includeMeta !== true) {
    return true;
  }
  if (key === 'range' && options.includeRanges !== true) {
    return true;
  }
  if (key === 'tokens' && options.includeTokens !== true) {
    return true;
  }
  if (options.skipKeys && options.skipKeys.has(key)) {
    return true;
  }
  return false;
}

function childFieldEntries(node, options = {}) {
  const entries = [];
  const skippedKeys = options.skipKeys instanceof Set
    ? options.skipKeys
    : new Set(options.skipKeys || []);
  const effectiveOptions = { ...options, skipKeys: skippedKeys };
  for (const [key, value] of Object.entries(node)) {
    if (shouldSkipField(key, effectiveOptions)) {
      continue;
    }
    if (isNode(value) || Array.isArray(value) || (options.traversePlainObjects === true && isPlainObject(value))) {
      entries.push([key, value]);
    }
  }
  return entries;
}

function makeTraversalContext(state, node) {
  return {
    node,
    parent: state.parent,
    key: state.key,
    index: state.index,
    path: state.path.slice(),
    depth: state.depth,
    root: state.root,
    document: state.document,
  };
}

function visitArray(value, visitor, state, options) {
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (isNode(item)) {
      visitNode(item, visitor, {
        parent: value,
        key: state.key,
        index: i,
        path: state.path.concat(i),
        depth: state.depth,
        root: state.root,
        document: state.document,
      }, options);
    } else if (Array.isArray(item)) {
      visitArray(item, visitor, {
        parent: value,
        key: i,
        index: null,
        path: state.path.concat(i),
        depth: state.depth,
        root: state.root,
        document: state.document,
      }, options);
    } else if (options.traversePlainObjects === true && isPlainObject(item)) {
      visitPlainObject(item, visitor, {
        parent: value,
        key: i,
        index: null,
        path: state.path.concat(i),
        depth: state.depth,
        root: state.root,
        document: state.document,
      }, options);
    }
  }
}

function visitPlainObject(value, visitor, state, options) {
  for (const [key, child] of Object.entries(value)) {
    if (isNode(child)) {
      visitNode(child, visitor, {
        parent: value,
        key,
        index: null,
        path: state.path.concat(key),
        depth: state.depth,
        root: state.root,
        document: state.document,
      }, options);
    } else if (Array.isArray(child)) {
      visitArray(child, visitor, {
        parent: value,
        key,
        index: null,
        path: state.path.concat(key),
        depth: state.depth,
        root: state.root,
        document: state.document,
      }, options);
    } else if (options.traversePlainObjects === true && isPlainObject(child)) {
      visitPlainObject(child, visitor, {
        parent: value,
        key,
        index: null,
        path: state.path.concat(key),
        depth: state.depth,
        root: state.root,
        document: state.document,
      }, options);
    }
  }
}

function visitNode(node, visitor, state, options) {
  const context = makeTraversalContext(state, node);
  if (typeof visitor.enter === 'function') {
    const result = visitor.enter(node, context);
    if (result === SKIP_CHILDREN) {
      if (typeof visitor.leave === 'function') {
        visitor.leave(node, context);
      }
      return;
    }
  }

  for (const [key, value] of childFieldEntries(node, options)) {
    const childState = {
      parent: node,
      key,
      index: null,
      path: state.path.concat(key),
      depth: state.depth + 1,
      root: state.root,
      document: state.document,
    };
    if (isNode(value)) {
      visitNode(value, visitor, childState, options);
    } else if (Array.isArray(value)) {
      visitArray(value, visitor, childState, options);
    } else if (options.traversePlainObjects === true && isPlainObject(value)) {
      visitPlainObject(value, visitor, childState, options);
    }
  }

  if (typeof visitor.leave === 'function') {
    visitor.leave(node, context);
  }
}

function visitAst(target, visitorInput, options = {}) {
  const visitor = normalizeVisitor(visitorInput);
  const document = isAstDocument(target) ? target : null;
  const root = document ? document.root : target;
  if (!isNode(root)) {
    throw new TypeError('visitAst target must be an AST document or AST node');
  }
  visitNode(root, visitor, {
    parent: document,
    key: document ? 'root' : null,
    index: null,
    path: document ? ['root'] : [],
    depth: 0,
    root,
    document,
  }, options);
  return target;
}

function transformArray(value, visitor, state, options) {
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    let replacement = item;
    if (isNode(item)) {
      replacement = transformNode(item, visitor, {
        parent: value,
        key: state.key,
        index: i,
        path: state.path.concat(i),
        depth: state.depth,
        root: state.root,
        document: state.document,
      }, options);
    } else if (Array.isArray(item)) {
      replacement = transformArray(item, visitor, {
        parent: value,
        key: i,
        index: null,
        path: state.path.concat(i),
        depth: state.depth,
        root: state.root,
        document: state.document,
      }, options);
    } else if (options.traversePlainObjects === true && isPlainObject(item)) {
      replacement = transformPlainObject(item, visitor, {
        parent: value,
        key: i,
        index: null,
        path: state.path.concat(i),
        depth: state.depth,
        root: state.root,
        document: state.document,
      }, options);
    }

    if (replacement === REMOVE_NODE) {
      value.splice(i, 1);
      i -= 1;
    } else if (replacement !== item) {
      value[i] = replacement;
    }
  }
  return value;
}

function transformPlainObject(value, visitor, state, options) {
  for (const [key, child] of Object.entries(value)) {
    let replacement = child;
    if (isNode(child)) {
      replacement = transformNode(child, visitor, {
        parent: value,
        key,
        index: null,
        path: state.path.concat(key),
        depth: state.depth,
        root: state.root,
        document: state.document,
      }, options);
    } else if (Array.isArray(child)) {
      replacement = transformArray(child, visitor, {
        parent: value,
        key,
        index: null,
        path: state.path.concat(key),
        depth: state.depth,
        root: state.root,
        document: state.document,
      }, options);
    } else if (options.traversePlainObjects === true && isPlainObject(child)) {
      replacement = transformPlainObject(child, visitor, {
        parent: value,
        key,
        index: null,
        path: state.path.concat(key),
        depth: state.depth,
        root: state.root,
        document: state.document,
      }, options);
    }

    if (replacement === REMOVE_NODE) {
      delete value[key];
    } else if (replacement !== child) {
      value[key] = replacement;
    }
  }
  return value;
}

function applyReplacementResult(result, current) {
  if (result === undefined || result === SKIP_CHILDREN) {
    return current;
  }
  if (result === REMOVE_NODE) {
    return REMOVE_NODE;
  }
  if (!isNode(result)) {
    throw new TypeError('AST transform visitors must return AST nodes, SKIP_CHILDREN, REMOVE_NODE, or undefined');
  }
  return result;
}

function transformNode(node, visitor, state, options) {
  let current = node;
  const enterContext = makeTraversalContext(state, current);
  let skipChildren = false;
  if (typeof visitor.enter === 'function') {
    const enterResult = visitor.enter(current, enterContext);
    if (enterResult === SKIP_CHILDREN) {
      skipChildren = true;
    } else {
      const replacement = applyReplacementResult(enterResult, current);
      if (replacement === REMOVE_NODE) {
        return REMOVE_NODE;
      }
      current = replacement;
    }
  }

  if (!skipChildren) {
    for (const [key, value] of childFieldEntries(current, options)) {
      const childState = {
        parent: current,
        key,
        index: null,
        path: state.path.concat(key),
        depth: state.depth + 1,
        root: state.root,
        document: state.document,
      };
      let replacement = value;
      if (isNode(value)) {
        replacement = transformNode(value, visitor, childState, options);
      } else if (Array.isArray(value)) {
        replacement = transformArray(value, visitor, childState, options);
      } else if (options.traversePlainObjects === true && isPlainObject(value)) {
        replacement = transformPlainObject(value, visitor, childState, options);
      }

      if (replacement === REMOVE_NODE) {
        delete current[key];
      } else if (replacement !== value) {
        current[key] = replacement;
      }
    }
  }

  if (typeof visitor.leave === 'function') {
    const leaveContext = makeTraversalContext({ ...state, parent: state.parent }, current);
    const leaveResult = visitor.leave(current, leaveContext);
    const replacement = applyReplacementResult(leaveResult, current);
    if (replacement === REMOVE_NODE) {
      return REMOVE_NODE;
    }
    current = replacement;
  }

  return current;
}

function transformAst(target, visitorInput, options = {}) {
  const visitor = normalizeVisitor(visitorInput);
  const working = options.clone ? cloneAst(target, { validate: options.validateClone !== false }) : target;
  const document = isAstDocument(working) ? working : null;
  const root = document ? document.root : working;
  if (!isNode(root)) {
    throw new TypeError('transformAst target must be an AST document or AST node');
  }
  const replacement = transformNode(root, visitor, {
    parent: document,
    key: document ? 'root' : null,
    index: null,
    path: document ? ['root'] : [],
    depth: 0,
    root,
    document,
  }, options);
  if (replacement === REMOVE_NODE) {
    throw new TypeError('AST transform cannot remove the root node');
  }
  if (document) {
    document.root = replacement;
    return document;
  }
  return replacement;
}

function collectAstNodes(target, predicate = () => true, options = {}) {
  const nodes = [];
  visitAst(target, {
    enter(node, context) {
      if (predicate(node, context)) {
        nodes.push(node);
      }
    },
  }, options);
  return nodes;
}

module.exports = {
  SKIP_CHILDREN,
  REMOVE_NODE,
  visitAst,
  transformAst,
  collectAstNodes,
  childFieldEntries,
};
