const { parse } = require("acorn");
const Frame = require("../core/frame");

function opOf(instruction) {
  return typeof instruction === "string"
    ? instruction.trim().split(/\s+/)[0]
    : instruction?.op || null;
}

function methodCode(method) {
  return method?.attributes?.find((attribute) => attribute.type === "code")
    ?.code || null;
}

function methodKey(jvm, method) {
  const owner = method?.className || jvm.findClassNameForMethod?.(method) ||
    "<unknown>";
  return `${owner}.${method?.name || "<unknown>"}${method?.descriptor || ""}`;
}

function hasRestoringTransientDeopt(generated) {
  // Coarse-loop admission is guarded by `nestedEntryGuarded !== 2`; a local
  // region edge always enters with marker 2 and therefore cannot take that
  // exit. Range guards are independent of the marker and may materialize a
  // child after the regional host call stack has already been omitted.
  return (generated?.jvmStructuredRestoringRangeGuardDeoptCount || 0) > 0;
}

function walkAst(node, visit, parent = null) {
  if (!node || typeof node !== "object") return;
  visit(node, parent);
  for (const [key, child] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc" ||
        key === "range") continue;
    if (Array.isArray(child)) {
      for (const entry of child) {
        if (entry?.type) walkAst(entry, visit, node);
      }
    } else if (child?.type) {
      walkAst(child, visit, node);
    }
  }
}

function identifierIsPropertyName(node, parent) {
  return Boolean(
    parent?.type === "MemberExpression" && parent.property === node &&
      !parent.computed ||
    (parent?.type === "Property" || parent?.type === "MethodDefinition") &&
      parent.key === node && !parent.computed && !parent.shorthand);
}

function collectPatternNames(pattern, output) {
  if (!pattern) return;
  if (pattern.type === "Identifier") {
    output.add(pattern.name);
  } else if (pattern.type === "RestElement") {
    collectPatternNames(pattern.argument, output);
  } else if (pattern.type === "AssignmentPattern") {
    collectPatternNames(pattern.left, output);
  } else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) collectPatternNames(element, output);
  } else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      collectPatternNames(property.value || property.argument, output);
    }
  }
}

function applySourceEdits(source, edits) {
  // Single forward pass over the source: per-edit slice-and-concat is
  // O(edits x source) and dominated the whole partition pipeline on
  // megabyte-sized framed modules.
  const ordered = [...edits].sort((left, right) =>
    left.start - right.start || left.end - right.end);
  const chunks = [];
  let cursor = 0;
  for (const edit of ordered) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) ||
        edit.start < 0 || edit.end < edit.start ||
        edit.start < cursor || edit.end > source.length) return null;
    chunks.push(source.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  chunks.push(source.slice(cursor));
  return chunks.join("");
}

function pureGeneratedExpression(node) {
  if (!node) return true;
  switch (node.type) {
    case "Literal":
    case "Identifier":
    case "ThisExpression":
      return true;
    case "UnaryExpression":
      return node.operator !== "delete" &&
        pureGeneratedExpression(node.argument);
    case "BinaryExpression":
    case "LogicalExpression":
      return pureGeneratedExpression(node.left) &&
        pureGeneratedExpression(node.right);
    case "ConditionalExpression":
      return pureGeneratedExpression(node.test) &&
        pureGeneratedExpression(node.consequent) &&
        pureGeneratedExpression(node.alternate);
    case "MemberExpression":
      return pureGeneratedExpression(node.object) &&
        (!node.computed || pureGeneratedExpression(node.property));
    case "ArrayExpression":
      return node.elements.every((element) =>
        !element || pureGeneratedExpression(element));
    case "ObjectExpression":
      return node.properties.every((property) =>
        property.type === "Property" && property.kind === "init" &&
        !property.method && pureGeneratedExpression(property.value));
    default:
      return false;
  }
}

/**
 * Remove compiler-published call bindings after their entire call operation
 * has been replaced in the region IR. The exact binding names come from the
 * renderer metadata; no generated-source spelling or guest identity is used.
 */
function removeUnusedRegionBindings(source, candidateNames) {
  if (!candidateNames?.size) return source;
  const prefix = "function __jvmRegionDce() {\n";
  let program;
  try {
    program = parse(`${prefix}${source}\n}`, {
      ecmaVersion: "latest", ranges: true,
    });
  } catch (_) {
    return source;
  }
  const declarations = new Map();
  const dependencies = new Map();
  const externalReferences = new Set();
  const ancestors = [];
  const visit = (node, parent = null) => {
    if (!node || typeof node !== "object") return;
    ancestors.push(node);
    if (node.type === "VariableDeclarator" &&
        node.id?.type === "Identifier" &&
        candidateNames.has(node.id.name)) {
      const entries = declarations.get(node.id.name) || [];
      entries.push(node);
      declarations.set(node.id.name, entries);
    }
    if (node.type === "Identifier" && !identifierIsPropertyName(node, parent)) {
      const declaration = parent?.type === "VariableDeclarator" &&
        parent.id === node ? parent : null;
      if (!declaration && candidateNames.has(node.name)) {
        let owner = null;
        for (let index = ancestors.length - 2; index >= 0; index -= 1) {
          const candidate = ancestors[index];
          if (candidate.type === "VariableDeclarator" &&
              candidate.init && node.start >= candidate.init.start &&
              node.end <= candidate.init.end &&
              candidate.id?.type === "Identifier" &&
              candidateNames.has(candidate.id.name)) {
            owner = candidate.id.name;
            break;
          }
        }
        if (owner) {
          const values = dependencies.get(owner) || new Set();
          values.add(node.name);
          dependencies.set(owner, values);
        } else {
          externalReferences.add(node.name);
        }
      }
    }
    for (const key in node) {
      if (key === "start" || key === "end" || key === "loc" ||
          key === "range") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const entry of child) {
          if (entry && typeof entry.type === "string") visit(entry, node);
        }
      } else if (child && typeof child.type === "string") {
        visit(child, node);
      }
    }
    ancestors.pop();
  };
  visit(program);
  const live = new Set(externalReferences);
  for (const [name, entries] of declarations) {
    if (entries.length !== 1 || !pureGeneratedExpression(entries[0].init)) {
      live.add(name);
    }
  }
  const pending = [...live];
  while (pending.length) {
    const name = pending.pop();
    for (const dependency of dependencies.get(name) || []) {
      if (live.has(dependency)) continue;
      live.add(dependency);
      pending.push(dependency);
    }
  }
  const edits = [];
  for (const [name, entries] of declarations) {
    if (live.has(name) || entries.length !== 1) continue;
    const declaration = entries[0];
    // Renderer call bindings are deliberately one declarator per statement.
    // Refuse to alter a combined declaration rather than regenerating syntax.
    let statement = null;
    const findParent = (node, parent = null) => {
      if (!node || statement) return;
      if (node === declaration) {
        if (parent?.type === "VariableDeclaration" &&
            parent.declarations.length === 1) statement = parent;
        return;
      }
      for (const key in node) {
        if (key === "start" || key === "end" || key === "loc" ||
            key === "range") continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const entry of child) {
            if (entry && typeof entry.type === "string") {
              findParent(entry, node);
            }
          }
        } else if (child && typeof child.type === "string") {
          findParent(child, node);
        }
      }
    };
    findParent(program);
    if (statement) {
      edits.push({
        start: statement.start - prefix.length,
        end: statement.end - prefix.length,
        replacement: "",
      });
    }
  }
  return applySourceEdits(source, edits) || source;
}

/**
 * Convert one verified call-free positional SSA body into a caller-owned
 * block. Arguments are bound once from the caller's SSA operands, every
 * callee binding and label is alpha-renamed, and Java returns feed one join
 * value. This is an interprocedural SSA operation performed before backend
 * source assembly, not a textual method-name substitution.
 */
function inlineAtomicPositionalSource(source, argumentSources, resultName,
  namespace, declareResult = true, diagnostic = null) {
  const reject = (reason) => {
    if (diagnostic) diagnostic.reason = reason;
    return null;
  };
  if (typeof source !== "string" || !Array.isArray(argumentSources)) {
    return reject("missing-source-or-arguments");
  }
  const parameterNames = ["helpers",
    ...argumentSources.map((_value, index) => `argument${index}`),
    "thread", "nestedEntryGuarded"];
  const prefix = `function __jvmRegionInline(${parameterNames.join(",")}) {\n`;
  let program;
  try {
    program = parse(`${prefix}${source}\n}`, {
      ecmaVersion: "latest", ranges: true,
    });
  } catch (_) {
    return reject("source-parse-failed");
  }
  const body = program.body[0]?.body;
  if (!body) return reject("missing-function-body");
  const declared = new Set();
  const labelNames = new Set();
  const returns = [];
  const identifierNodes = [];
  let unsupported = false;
  const visit = (node, parent = null, functionDepth = 0) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "WithStatement" || node.type === "YieldExpression" ||
        node.type === "AwaitExpression" ||
        node.type === "Property" && node.shorthand) unsupported = true;
    if (node.type === "VariableDeclarator") {
      collectPatternNames(node.id, declared);
    } else if (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") {
      if (node.id) collectPatternNames(node.id, declared);
      for (const parameter of node.params || []) {
        collectPatternNames(parameter, declared);
      }
    } else if (node.type === "CatchClause") {
      collectPatternNames(node.param, declared);
    } else if (node.type === "ClassDeclaration" && node.id) {
      declared.add(node.id.name);
    } else if (node.type === "LabeledStatement") {
      labelNames.add(node.label.name);
    }
    if (node.type === "ReturnStatement" && functionDepth === 0) {
      returns.push(node);
    }
    if (node.type === "Identifier") identifierNodes.push({node, parent});
    const childFunctionDepth = node !== body &&
      (node.type === "FunctionDeclaration" ||
       node.type === "FunctionExpression" ||
       node.type === "ArrowFunctionExpression")
      ? functionDepth + 1 : functionDepth;
    for (const key in node) {
      if (key === "start" || key === "end" || key === "loc" ||
          key === "range") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const entry of child) {
          if (entry && typeof entry.type === "string") {
            visit(entry, node, childFunctionDepth);
          }
        }
      } else if (child && typeof child.type === "string") {
        visit(child, node, childFunctionDepth);
      }
    }
  };
  visit(body);
  if (unsupported) return reject("unsupported-ast-node");
  if (returns.length === 0) return reject("missing-return");
  const names = new Map();
  for (const name of declared) {
    names.set(name, `${namespace}${name}`);
  }
  for (const name of labelNames) {
    names.set(name, `${namespace}${name}`);
  }
  for (let index = 0; index < argumentSources.length; index += 1) {
    names.set(`argument${index}`, `${namespace}argument${index}`);
  }
  names.set("nestedEntryGuarded", `${namespace}nestedEntryGuarded`);
  const returnRanges = returns.map((node) => ({
    start: node.start, end: node.end,
  }));
  const identifierEdits = [];
  for (const {node, parent} of identifierNodes) {
    if (identifierIsPropertyName(node, parent)) continue;
    const replacement = names.get(node.name);
    if (!replacement) continue;
    identifierEdits.push({
      start: node.start - prefix.length,
      end: node.end - prefix.length,
      replacement,
    });
  }
  const rewriteRange = (start, end) => {
    const relativeStart = start - prefix.length;
    const relativeEnd = end - prefix.length;
    const fragment = source.slice(relativeStart, relativeEnd);
    const edits = identifierEdits.filter((edit) =>
      edit.start >= relativeStart && edit.end <= relativeEnd).map((edit) => ({
      start: edit.start - relativeStart,
      end: edit.end - relativeStart,
      replacement: edit.replacement,
    }));
    return applySourceEdits(fragment, edits);
  };
  const edits = identifierEdits.filter((edit) => !returnRanges.some(
    (range) => edit.start + prefix.length >= range.start &&
      edit.end + prefix.length <= range.end));
  const label = `${namespace}return`;
  for (const node of returns) {
    const value = node.argument
      ? rewriteRange(node.argument.start, node.argument.end) : "ssaReturnVoid";
    if (value === null) return reject("return-rewrite-failed");
    edits.push({
      start: node.start - prefix.length,
      end: node.end - prefix.length,
      replacement: `{ ${resultName} = ${value}; break ${label}; }`,
    });
  }
  const rewritten = applySourceEdits(source, edits);
  if (rewritten === null) return reject("overlapping-ast-edits");
  const argumentBindings = argumentSources.map((argument, index) =>
    `const ${namespace}argument${index} = ${argument};`);
  return [
    declareResult ? `let ${resultName};` : null,
    `${label}: {`,
    ...argumentBindings.map((line) => `  ${line}`),
    `  const ${namespace}nestedEntryGuarded = 2;`,
    ...rewritten.split("\n").map((line) => `  ${line}`),
    "}",
  ].filter(Boolean).join("\n");
}

function removeUnreachableRegionFunctions(source, rootName) {
  let program;
  try {
    program = parse(source, {
      ecmaVersion: "latest", ranges: true, allowReturnOutsideFunction: true,
    });
  } catch (_) {
    return source;
  }
  const declarations = new Map(program.body
    .filter((statement) => statement.type === "FunctionDeclaration" &&
      statement.id?.type === "Identifier")
    .map((statement) => [statement.id.name, statement]));
  if (!declarations.has(rootName)) return source;
  const dependencies = new Map();
  for (const [name, declaration] of declarations) {
    const values = new Set();
    walkAst(declaration.body, (node, parent) => {
      if (node.type !== "Identifier" || !declarations.has(node.name) ||
          identifierIsPropertyName(node, parent)) return;
      values.add(node.name);
    });
    dependencies.set(name, values);
  }
  const reachable = new Set([rootName]);
  const pending = [rootName];
  while (pending.length) {
    for (const dependency of dependencies.get(pending.pop()) || []) {
      if (reachable.has(dependency)) continue;
      reachable.add(dependency);
      pending.push(dependency);
    }
  }
  return applySourceEdits(source, [...declarations]
    .filter(([name]) => !reachable.has(name))
    .map(([_name, declaration]) => ({
      start: declaration.start,
      end: declaration.end,
      replacement: "",
    }))) || source;
}

/**
 * Split a region module into factory-scope declarations and a per-call entry.
 *
 * Every module-level helper is parameter-complete by construction (helpers,
 * arguments, thread, and state arrays all arrive as parameters), so the
 * function declarations never capture per-invocation bindings and can be
 * instantiated once in the enclosing factory instead of on every module
 * entry.  The protocol state arrays (`const jvmRegionSegmentState* = []`)
 * are also safe to share across invocations: every segment writes its
 * outcome only in its terminal epilogue and the caller consumes it
 * immediately after the call returns, so no guest call, scheduler yield, or
 * re-entrant module invocation can interleave between a write and its read.
 *
 * Anything unexpected at the top level (a `let`, a non-empty initializer, a
 * class) aborts the split and the module keeps its per-invocation shape.
 */
function splitModuleSourceForFactoryHoist(moduleSource) {
  let program;
  try {
    program = parse(moduleSource, {
      ecmaVersion: "latest", allowReturnOutsideFunction: true,
    });
  } catch (_) {
    return null;
  }
  const hoisted = [];
  const entry = [];
  for (const statement of program.body) {
    if (statement.type === "FunctionDeclaration" &&
        statement.id?.type === "Identifier") {
      hoisted.push(statement);
      continue;
    }
    if (statement.type === "ExpressionStatement" &&
        statement.directive === "use strict") {
      continue;
    }
    if (statement.type === "VariableDeclaration") {
      if (statement.kind === "const" && statement.declarations.every(
        (declarator) => declarator.id.type === "Identifier" &&
          declarator.init?.type === "ArrayExpression" &&
          declarator.init.elements.length === 0)) {
        hoisted.push(statement);
        continue;
      }
      return null;
    }
    if (statement.type === "ClassDeclaration") return null;
    entry.push(statement);
  }
  if (!hoisted.length || !entry.length) return null;
  const sliceOf = (node) => moduleSource.slice(node.start, node.end);
  return {
    hoistedSource: hoisted.map(sliceOf).join("\n"),
    entrySource: entry.map(sliceOf).join("\n"),
    hoistedCount: hoisted.length,
  };
}

/**
 * Split oversized structured loops into ordinary nested JavaScript functions.
 *
 * The renderer has already proved the Java CFG and SSA joins before this pass
 * runs.  A nested function therefore keeps scalar locals as lexical bindings,
 * while V8/SpiderMonkey receive a separate optimization unit for the loop.
 * Java returns are explicitly forwarded to the containing region.  We reject
 * source constructs whose meaning would change across a function boundary;
 * this is intentionally a structural AST pass, never a guest-name heuristic.
 */
function outlineLargeRegionLoops(source, options = {}) {
  const minimumSourceBytes = Math.max(512,
    Number(options.minimumSourceBytes) || 32768);
  const maximumOutlines = Math.max(0,
    Math.min(64, Number(options.maximumOutlines) || 16));
  const numericNamespace = Number(options.namespace);
  const namespace = Number.isSafeInteger(numericNamespace) &&
    numericNamespace >= 0 ? String(numericNamespace) : "0";
  let rewritten = source;
  let outlineCount = 0;
  let outlinedSourceBytes = 0;
  let largestOutlinedSourceBytes = 0;
  const helperSources = [];
  const helperNames = new Set();
  const sharedStateName = `jvmRegionOutlinedState${namespace}`;
  const generator = options.generator === true;

  const childrenOf = (node) => {
    const children = [];
    for (const [key, child] of Object.entries(node || {})) {
      if (key === "start" || key === "end" || key === "loc" ||
          key === "range") continue;
      if (Array.isArray(child)) {
        for (const entry of child) if (entry?.type) children.push(entry);
      } else if (child?.type) {
        children.push(child);
      }
    }
    return children;
  };
  const isFunction = (node) => node && (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression");
  const isLoop = (node) => node && (
    node.type === "WhileStatement" || node.type === "DoWhileStatement" ||
    node.type === "ForStatement" || node.type === "ForInStatement" ||
    node.type === "ForOfStatement");

  while (outlineCount < maximumOutlines) {
    let program;
    try {
      program = parse(rewritten, {
        ecmaVersion: "latest", ranges: true, allowReturnOutsideFunction: true,
      });
    } catch (_) {
      break;
    }
    const candidates = [];
    const visit = (node, parent = null, currentFunction = null,
      loopDepth = 0) => {
      if (!node?.type) return;
      const nextFunction = isFunction(node) ? node : currentFunction;
      const currentIsLoop = isLoop(node);
      if (currentIsLoop) {
        const outlinedOwner = currentFunction?.type === "FunctionDeclaration" &&
          currentFunction.id?.name?.startsWith("jvmRegionOutlinedLoop");
        // The first loop is the payload of a helper created by this pass.
        // Its nested loops may still be split, but wrapping the payload again
        // would only add an infinite chain of equivalent helper functions.
        if (!(outlinedOwner && loopDepth === 0)) {
          const region = parent?.type === "LabeledStatement" &&
            parent.body === node ? parent : node;
          let nestedFunctionBytes = 0;
          const measure = (entry, functionDepth = 0) => {
            for (const child of childrenOf(entry)) {
              if (isFunction(child)) {
                if (functionDepth === 0 && child.type === "FunctionDeclaration" &&
                    child.id?.name?.startsWith("jvmRegionOutlinedLoop")) {
                  nestedFunctionBytes += child.end - child.start;
                }
                continue;
              }
              measure(child, functionDepth);
            }
          };
          measure(region);
          const executableBytes = region.end - region.start -
            nestedFunctionBytes;
          if (executableBytes >= minimumSourceBytes) {
            candidates.push({node, region, executableBytes});
          }
        }
      }
      for (const child of childrenOf(node)) {
        visit(child, node, nextFunction,
          loopDepth + (currentIsLoop ? 1 : 0));
      }
    };
    visit(program);
    if (!candidates.length) break;

    // Rewrite only candidates that contain no other candidate in this pass.
    // The next parse sees the new helper as a distinct lexical function and
    // may then split its parent.  This keeps all source edits non-overlapping.
    const innermost = candidates.filter((candidate) => !candidates.some(
      (other) => other !== candidate &&
        other.region.start > candidate.region.start &&
        other.region.end < candidate.region.end));
    const edits = [];
    for (const candidate of innermost.slice(
      0, maximumOutlines - outlineCount)) {
      const labels = new Set();
      const returns = [];
      const declared = new Set();
      const referenced = [];
      const written = new Set();
      let unsupported = false;
      let hasYield = false;
      const audit = (node, parent = null, functionDepth = 0) => {
        if (!node?.type) return;
        if (node.type === "LabeledStatement") labels.add(node.label.name);
        if (node.type === "VariableDeclarator") {
          collectPatternNames(node.id, declared);
        } else if (isFunction(node)) {
          if (node.id) collectPatternNames(node.id, declared);
          for (const parameter of node.params || []) {
            collectPatternNames(parameter, declared);
          }
        } else if (node.type === "CatchClause") {
          collectPatternNames(node.param, declared);
        }
        if (functionDepth === 0 && node.type === "ReturnStatement") {
          returns.push(node);
        }
        if (node.type === "AssignmentExpression") {
          collectPatternNames(node.left, written);
        } else if (node.type === "UpdateExpression" &&
            node.argument?.type === "Identifier") {
          written.add(node.argument.name);
        }
        if (node.type === "Identifier" &&
            !identifierIsPropertyName(node, parent)) {
          referenced.push(node);
        }
        if (functionDepth === 0) {
          if (node.type === "YieldExpression") {
            if (generator) hasYield = true;
            else unsupported = true;
          } else if (
              node.type === "AwaitExpression" ||
              node.type === "ThisExpression" ||
              node.type === "Super" ||
              node.type === "MetaProperty" ||
              node.type === "VariableDeclaration" && node.kind === "var" ||
              node.type === "Identifier" && node.name === "arguments" ||
              node.type === "CallExpression" &&
                node.callee?.type === "Identifier" &&
                node.callee.name === "eval") unsupported = true;
        }
        for (const child of childrenOf(node)) {
          audit(child, node, functionDepth +
            (isFunction(child) && child !== node ? 1 : 0));
        }
      };
      audit(candidate.region);
      const auditJumps = (node, functionDepth = 0) => {
        if (!node?.type) return;
        if (functionDepth === 0 &&
            (node.type === "BreakStatement" ||
              node.type === "ContinueStatement") &&
            node.label && !labels.has(node.label.name)) unsupported = true;
        for (const child of childrenOf(node)) {
          auditJumps(child, functionDepth + (isFunction(child) ? 1 : 0));
        }
      };
      auditJumps(candidate.region);
      if (unsupported) continue;

      const id = outlineCount++;
      const helperName = `jvmRegionOutlinedLoop${namespace}_${id}`;
      const caughtName = `jvmRegionOutlinedError${namespace}_${id}`;
      const outputName = `jvmRegionOutlinedOutput${namespace}_${id}`;
      // Generated SSA names are unique within the containing function. The
      // complete declaration set (including nested outlined helpers) lets us
      // compute a positional live-in ABI without making every scalar escape
      // through a closure context. Global/captured constants are legal
      // positional operands too and are resolved once at the call site.
      const freeNames = [];
      const seenFreeNames = new Set();
      for (const identifier of referenced) {
        const name = identifier.name;
        if (declared.has(name) || labels.has(name) ||
            helperNames.has(name) ||
            seenFreeNames.has(name)) continue;
        seenFreeNames.add(name);
        freeNames.push(name);
      }
      const liveOutNames = freeNames.filter((name) => written.has(name));
      const fragmentStart = candidate.region.start;
      let fragment = rewritten.slice(fragmentStart, candidate.region.end);
      // Braces keep the multi-statement replacement a single statement: the
      // original return may be an unbraced if-consequent.
      const returnEdits = returns.map((entry) => ({
        start: entry.start - fragmentStart,
        end: entry.end - fragmentStart,
        replacement: [
          `{ ${outputName}[0] = 1;`,
          `${outputName}[1] = ${entry.argument
            ? rewritten.slice(entry.argument.start, entry.argument.end)
            : "undefined"};`,
          ...liveOutNames.map((name, index) =>
            `${outputName}[${index + 2}] = ${name};`),
          "return; }",
        ].join(" "),
      }));
      fragment = applySourceEdits(fragment, returnEdits);
      if (fragment === null) {
        outlineCount -= 1;
        continue;
      }
      const assignLiveOuts = liveOutNames.map((name, index) =>
        `  ${name} = ${sharedStateName}[${index + 2}];`);
      helperNames.add(helperName);
      helperSources.push([
        `function${hasYield ? "*" : ""} ${helperName}(${[
          ...freeNames, outputName].join(",")}) {`,
        "  try {",
        ...fragment.split("\n").map((line) => `    ${line}`),
        `    ${outputName}[0] = 0;`,
        `    ${outputName}[1] = undefined;`,
        ...liveOutNames.map((name, index) =>
          `    ${outputName}[${index + 2}] = ${name};`),
        `  } catch (${caughtName}) {`,
        `    ${outputName}[0] = 2;`,
        `    ${outputName}[1] = ${caughtName};`,
        ...liveOutNames.map((name, index) =>
          `    ${outputName}[${index + 2}] = ${name};`),
        "  }",
        "}",
      ].join("\n"));
      edits.push({
        start: candidate.region.start,
        end: candidate.region.end,
        replacement: [
          "{",
          `  ${hasYield ? "yield* " : ""}${helperName}(${[
            ...freeNames, sharedStateName].join(",")});`,
          ...assignLiveOuts,
          `  if (${sharedStateName}[0] === 1) ` +
            `return ${sharedStateName}[1];`,
          `  if (${sharedStateName}[0] === 2) ` +
            `throw ${sharedStateName}[1];`,
          "}",
        ].join("\n"),
      });
      outlinedSourceBytes += candidate.executableBytes;
      largestOutlinedSourceBytes = Math.max(
        largestOutlinedSourceBytes, candidate.executableBytes);
    }
    if (!edits.length) break;
    const next = applySourceEdits(rewritten, edits);
    if (next === null) break;
    rewritten = next;
  }
  return {
    source: outlineCount > 0
      ? `const ${sharedStateName} = [];\n${rewritten}` : rewritten,
    helperSources,
    count: outlineCount,
    outlinedSourceBytes,
    largestOutlinedSourceBytes,
  };
}

/**
 * Partition oversized straight-line statement runs into helper functions.
 *
 * outlineLargeRegionLoops splits at loop granularity; region bodies dominated
 * by flat statement bulk (thousands of small statements plus embedded
 * conditionals) still exceed the engines' per-function optimization budgets.
 * This pass walks every module function whose executable self-size exceeds
 * maximumUnitBytes and extracts maximal consecutive statement runs into
 * module-level helpers with the loop outliner's positional live-in/live-out
 * ABI.  A run executes exactly once per arrival at its block position, so the
 * call overhead is amortized over ~targetSegmentBytes of straight-line work —
 * unlike fine-grained loop outlining, which pays the ABI inside hot
 * iterations.  Single statements larger than a segment recurse into their
 * nested statement lists, innermost lists partitioning first.
 *
 * Protocol extensions over the loop outliner:
 *  - outcome 3 carries an outward-jump table index: break/continue statements
 *    whose target lies outside the run are re-established verbatim at the
 *    call site, which occupies the run's original block position and
 *    therefore sees the identical label environment.
 *  - let/const declarations at a run's own statement level are visible to the
 *    remainder of the enclosing block; when any of their bindings is
 *    referenced outside the run they are hoisted: declared at the call site,
 *    rewritten to plain assignments inside the helper (with a helper-preamble
 *    `let` so early protocol exits never read a TDZ binding), and written
 *    back as live-outs.
 *  - a run is rejected when a nested function inside it references any name
 *    the run does not declare: extraction would rebind that capture to the
 *    helper's parameter copy.
 */
const childrenOf = (node) => {
  const children = [];
  for (const [key, child] of Object.entries(node || {})) {
    if (key === "start" || key === "end" || key === "loc" ||
        key === "range") continue;
    if (Array.isArray(child)) {
      for (const entry of child) if (entry?.type) children.push(entry);
    } else if (child?.type) {
      children.push(child);
    }
  }
  return children;
};
const isFunction = (node) => node && (
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression");
const isLoop = (node) => node && (
  node.type === "WhileStatement" || node.type === "DoWhileStatement" ||
  node.type === "ForStatement" || node.type === "ForInStatement" ||
  node.type === "ForOfStatement");
const jumpLabelIdentifier = (node, parent) => Boolean(parent &&
  (parent.type === "LabeledStatement" || parent.type === "BreakStatement" ||
    parent.type === "ContinueStatement") && parent.label === node);

// Collects every function whose own body (nested functions excluded) exceeds
// the unit budget, skipping partitioner-emitted segment helpers, then keeps
// only the innermost so queued source edits never overlap.
function collectOversizedUnits(program, maximumUnitBytes) {
  const units = [];
  const collect = (node) => {
    if (isFunction(node) && node.body?.type === "BlockStatement" &&
        !(node.type === "FunctionDeclaration" &&
          node.id?.name?.startsWith("jvmRegionSegment"))) {
      let nestedFunctionBytes = 0;
      const measure = (entry) => {
        for (const child of childrenOf(entry)) {
          if (isFunction(child)) {
            nestedFunctionBytes += child.end - child.start;
            continue;
          }
          measure(child);
        }
      };
      measure(node.body);
      if (node.end - node.start - nestedFunctionBytes > maximumUnitBytes) {
        units.push(node);
      }
    }
    for (const child of childrenOf(node)) collect(child);
  };
  collect(program);
  return units.filter((unit) => !units.some((other) =>
    other !== unit && other.start > unit.start && other.end < unit.end));
}

/**
 * Rewrites the stable function-scoped locals of oversized functions into one
 * per-invocation environment array. A framed region body declares hundreds of
 * call-site caches and scalar locals at its top level that are referenced
 * throughout; partitioning such a body under a positional ABI re-plumbs that
 * whole name set through every segment boundary and grows the source faster
 * than it shrinks the units. After this pass a segment's free-name set
 * collapses to the environment array plus the unit parameters, so a call
 * site stays a few dozen bytes regardless of how many locals cross the cut.
 *
 * Only names with exactly one declaration site in the unit are lifted (the
 * generated SSA namespace is shadow-free; anything else stays a local), and
 * only from `let`/`const` declarations in the unit body's top statement list,
 * so per-iteration block scoping is never disturbed. Lifting a `const` into
 * a mutable slot is safe because generated code never reassigns and never
 * relies on TDZ. Nested functions keep working: they capture the environment
 * array itself.
 */
function liftOversizedUnitLocalsToEnvironment(source, options = {}) {
  const maximumUnitBytes = Math.max(16384,
    Number(options.maximumUnitBytes) || 49152);
  const namespace = String(options.namespace ?? "0")
    .replace(/[^A-Za-z0-9_]/g, "") || "0";
  let program;
  try {
    program = parse(source, {
      ecmaVersion: "latest", ranges: true, allowReturnOutsideFunction: true,
    });
  } catch (_) {
    return {source, liftedNames: 0, units: 0};
  }
  const edits = [];
  let liftedNames = 0;
  let liftedUnits = 0;
  const units = collectOversizedUnits(program, maximumUnitBytes);
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const unit = units[unitIndex];
    const envName = `jvmRegionEnv${namespace}_${unitIndex}`;
    // One declaration site per name across the whole unit, or it stays local.
    const declarationCounts = new Map();
    const bump = (name) => declarationCounts.set(
      name, (declarationCounts.get(name) || 0) + 1);
    const bumpPattern = (pattern) => {
      const names = new Set();
      collectPatternNames(pattern, names);
      for (const name of names) bump(name);
    };
    let unsupportedUnit = false;
    for (const parameter of unit.params || []) bumpPattern(parameter);
    walkAst(unit.body, (node) => {
      if (node.type === "VariableDeclarator") bumpPattern(node.id);
      else if (isFunction(node)) {
        if (node.id) bump(node.id.name);
        for (const parameter of node.params || []) bumpPattern(parameter);
      } else if (node.type === "CatchClause" && node.param) {
        bumpPattern(node.param);
      } else if (node.type === "WithStatement" ||
          node.type === "CallExpression" &&
            node.callee?.type === "Identifier" &&
            node.callee.name === "eval" ||
          node.type === "Identifier" && node.name === envName) {
        unsupportedUnit = true;
      }
    });
    if (unsupportedUnit) continue;
    const forbidden = new Set(
      ["arguments", "eval", "undefined", "NaN", "Infinity", envName]);
    const slotIndex = new Map();
    const liftedDeclarations = [];
    for (const statement of unit.body.body) {
      if (statement.type !== "VariableDeclaration" ||
          statement.kind === "var") continue;
      if (!statement.declarations.every((declarator) =>
        declarator.id.type === "Identifier" &&
        declarationCounts.get(declarator.id.name) === 1 &&
        !forbidden.has(declarator.id.name))) continue;
      liftedDeclarations.push(statement);
      for (const declarator of statement.declarations) {
        if (!slotIndex.has(declarator.id.name)) {
          slotIndex.set(declarator.id.name, slotIndex.size);
        }
      }
    }
    if (!slotIndex.size) continue;
    // Declaration statements become in-place slot assignments. Only the
    // declaration prefix and the inter-declarator separators are replaced,
    // so initializer expressions keep their own positions and their inner
    // references are rewritten by the ordinary reference edits below.
    for (const declaration of liftedDeclarations) {
      const withInitializer = declaration.declarations
        .filter((declarator) => declarator.init);
      if (!withInitializer.length) {
        edits.push({start: declaration.start, end: declaration.end,
          replacement: ";"});
        continue;
      }
      edits.push({
        start: declaration.start,
        end: withInitializer[0].init.start,
        replacement: `${envName}[${
          slotIndex.get(withInitializer[0].id.name)}] = `,
      });
      for (let k = 1; k < withInitializer.length; k += 1) {
        edits.push({
          start: withInitializer[k - 1].init.end,
          end: withInitializer[k].init.start,
          replacement: `; ${envName}[${
            slotIndex.get(withInitializer[k].id.name)}] = `,
        });
      }
      edits.push({
        start: withInitializer[withInitializer.length - 1].init.end,
        end: declaration.end,
        replacement: ";",
      });
    }
    const liftedDeclarationSet = new Set(liftedDeclarations);
    const shorthandEditStarts = new Set();
    walkAst(unit.body, (node, parent) => {
      if (node.type !== "Identifier" || !slotIndex.has(node.name)) return;
      if (identifierIsPropertyName(node, parent) ||
          jumpLabelIdentifier(node, parent)) return;
      if (parent?.type === "VariableDeclarator" && parent.id === node) return;
      if (isFunction(parent) && parent.body !== node) return;
      if (parent?.type === "CatchClause" && parent.param === node) return;
      if (parent?.type === "Property" && parent.shorthand) {
        // {x} would become {env[i]}; expand the shorthand instead. Acorn
        // aliases key and value to one node, so dedupe by position.
        if (shorthandEditStarts.has(parent.start)) return;
        shorthandEditStarts.add(parent.start);
        edits.push({start: parent.start, end: parent.end,
          replacement: `${node.name}: ${envName}[${
            slotIndex.get(node.name)}]`});
        return;
      }
      edits.push({start: node.start, end: node.end,
        replacement: `${envName}[${slotIndex.get(node.name)}]`});
    });
    const firstStatement = unit.body.body[0];
    const insertAt = firstStatement &&
      firstStatement.type === "ExpressionStatement" &&
      firstStatement.expression.type === "Literal" &&
      typeof firstStatement.expression.value === "string"
      ? firstStatement.end : unit.body.start + 1;
    edits.push({start: insertAt, end: insertAt,
      replacement: `\nconst ${envName} = new Array(${
        slotIndex.size}).fill(undefined);`});
    liftedNames += slotIndex.size;
    liftedUnits += 1;
  }
  if (!liftedNames) return {source, liftedNames: 0, units: 0};
  const rewritten = applySourceEdits(source, edits);
  if (rewritten === null) return {source, liftedNames: 0, units: 0};
  return {source: rewritten, liftedNames, units: liftedUnits};
}

function partitionOversizedLinearBlocks(source, options = {}) {
  const maximumUnitBytes = Math.max(16384,
    Number(options.maximumUnitBytes) || 49152);
  const targetSegmentBytes = Math.max(4096, Math.min(maximumUnitBytes,
    Number(options.targetSegmentBytes) || 32768));
  const minimumSegmentBytes = Math.max(1024, Math.min(targetSegmentBytes,
    Number(options.minimumSegmentBytes) || 8192));
  const maximumSegments = Math.max(0, Math.min(512,
    Number(options.maximumSegments) || 128));
  const maximumRounds = 6;
  const namespace = String(options.namespace ?? "0")
    .replace(/[^A-Za-z0-9_]/g, "") || "0";
  const sharedStateName = `jvmRegionSegmentState${namespace}`;
  const rootProgramGenerator = options.rootProgramGenerator === true;
  let rewritten = source;
  let segmentCount = 0;
  let partitionedSourceBytes = 0;
  let appendedHelperCount = 0;
  const helperSources = [];
  let attemptedRuns = 0;
  let oversizedStatements = 0;

  for (let round = 0; round < maximumRounds &&
    segmentCount < maximumSegments; round += 1) {
    let program;
    try {
      // A standalone structured source is a generator *body*, not a complete
      // program. Acorn correctly rejects its top-level yield tokens. Replace
      // them only in the analysis copy with same-width unary expressions so
      // every AST offset still indexes the untouched emitted source.
      const parseable = rootProgramGenerator
        ? rewritten.replace(/\byield\*/g, "void  ")
          .replace(/\byield\b/g, "void ")
        : rewritten;
      program = parse(parseable, {
        ecmaVersion: "latest", ranges: true, allowReturnOutsideFunction: true,
      });
    } catch (_) {
      break;
    }
    // Segment helpers are terminal (skipped inside the collector):
    // re-partitioning one only re-plumbs its full live-name set through
    // another ABI layer and grows the source. Innermost-only per round,
    // mirroring the loop outliner: queued source edits stay non-overlapping
    // and shrunken parents re-qualify on the next round's reparse.
    const innermost = rootProgramGenerator
      ? [] : collectOversizedUnits(program, maximumUnitBytes);
    if (rootProgramGenerator && rewritten.length > maximumUnitBytes) {
      innermost.push({
        type: "FunctionExpression",
        generator: true,
        params: [],
        start: 0,
        end: rewritten.length,
        body: {
          type: "BlockStatement",
          start: 0,
          end: rewritten.length,
          body: program.body,
        },
      });
    }
    if (!innermost.length) break;

    const edits = [];
    for (const unit of innermost) {
      const unitIsGenerator = unit.generator === true;
      // Per-unit reference index: generated SSA names are unique within a
      // function, so name-keyed positions decide whether a run-level
      // declaration escapes the run.  A duplicate-name false positive only
      // hoists an extra binding, which preserves semantics.
      const referencePositionsByName = new Map();
      walkAst(unit.body, (node, parent) => {
        if (node.type !== "Identifier" ||
            identifierIsPropertyName(node, parent) ||
            jumpLabelIdentifier(node, parent)) return;
        let positions = referencePositionsByName.get(node.name);
        if (!positions) {
          positions = [];
          referencePositionsByName.set(node.name, positions);
        }
        positions.push(node.start);
      });

      const tryExtractRun = (runStatements) => {
        if (segmentCount >= maximumSegments) return;
        attemptedRuns += 1;
        const runStartPosition = runStatements[0].start;
        const runEndPosition = runStatements[runStatements.length - 1].end;
        if (process.env.JVM_DEBUG_PARTITION === "1") {
          console.error("[partition] round=" + round + " seg=" + segmentCount +
            " stmts=" + runStatements.length +
            " span=" + (runEndPosition - runStartPosition));
        }
        const labels = new Set();
        const declared = new Set();
        const written = new Set();
        const returns = [];
        const outwardJumps = [];
        const referenced = [];
        let unsupported = false;
        let runHasYield = false;
        const audit = (node, parent, functionDepth, loopDepth,
          breakableDepth) => {
          if (!node?.type) return;
          if (node.type === "LabeledStatement") labels.add(node.label.name);
          if (node.type === "VariableDeclarator") {
            collectPatternNames(node.id, declared);
          } else if (isFunction(node)) {
            if (node.id) collectPatternNames(node.id, declared);
            for (const parameter of node.params || []) {
              collectPatternNames(parameter, declared);
            }
          } else if (node.type === "CatchClause" && node.param) {
            collectPatternNames(node.param, declared);
          }
          if (functionDepth === 0 && node.type === "ReturnStatement") {
            returns.push(node);
          }
          if (functionDepth === 0 &&
              (node.type === "BreakStatement" ||
                node.type === "ContinueStatement")) {
            const isBreak = node.type === "BreakStatement";
            // A labeled jump may only target an enclosing label, which the
            // pre-order walk has already recorded when it lies in the run.
            const outward = node.label
              ? !labels.has(node.label.name)
              : (isBreak ? breakableDepth === 0 : loopDepth === 0);
            if (outward) {
              outwardJumps.push({node, kind: isBreak ? "break" : "continue",
                label: node.label ? node.label.name : null});
            }
          }
          if (node.type === "AssignmentExpression") {
            collectPatternNames(node.left, written);
          } else if (node.type === "UpdateExpression" &&
              node.argument?.type === "Identifier") {
            written.add(node.argument.name);
          }
          if (node.type === "Identifier" &&
              !identifierIsPropertyName(node, parent) &&
              !jumpLabelIdentifier(node, parent)) {
            referenced.push({name: node.name, functionDepth});
          }
          if (functionDepth === 0) {
            // In a generator unit a depth-0 yield may move into a generator
            // helper reached through yield*: delegation forwards the yielded
            // value, the argument-less next() resume, and abandonment via
            // iterator.return() unchanged, so the driver cannot observe the
            // split.
            if (node.type === "YieldExpression") {
              if (unitIsGenerator) runHasYield = true;
              else unsupported = true;
            }
            if (unitIsGenerator && node.type === "UnaryExpression" &&
                node.operator === "void" &&
                rewritten.slice(node.start, node.start + 5) === "yield") {
              runHasYield = true;
            }
            if (node.type === "AwaitExpression" ||
                node.type === "ThisExpression" ||
                node.type === "Super" ||
                node.type === "MetaProperty" ||
                node.type === "VariableDeclaration" && node.kind === "var" ||
                node.type === "Identifier" && node.name === "arguments" ||
                node.type === "CallExpression" &&
                  node.callee?.type === "Identifier" &&
                  node.callee.name === "eval") unsupported = true;
          }
          for (const child of childrenOf(node)) {
            audit(child, node,
              functionDepth + (isFunction(child) ? 1 : 0),
              isFunction(child) ? 0 : loopDepth + (isLoop(node) ? 1 : 0),
              isFunction(child) ? 0 : breakableDepth +
                (isLoop(node) || node.type === "SwitchStatement" ? 1 : 0));
          }
        };
        for (const statement of runStatements) {
          // Block-level function declarations hoist to the whole enclosing
          // block, including statements before the run.
          if (statement.type === "FunctionDeclaration") return;
          audit(statement, null, 0, 0, 0);
        }
        if (unsupported) return;
        for (const entry of referenced) {
          if (entry.functionDepth > 0 && !declared.has(entry.name)) return;
        }

        const hoistDeclarations = [];
        const hoistNames = [];
        for (const statement of runStatements) {
          if (statement.type !== "VariableDeclaration") continue;
          const names = new Set();
          for (const declarator of statement.declarations) {
            collectPatternNames(declarator.id, names);
          }
          const escapes = [...names].some((name) =>
            (referencePositionsByName.get(name) || []).some((position) =>
              position < runStartPosition || position >= runEndPosition));
          if (!escapes) continue;
          for (const declarator of statement.declarations) {
            if (declarator.id.type !== "Identifier") return;
          }
          hoistDeclarations.push(statement);
          hoistNames.push(...names);
        }

        const freeNames = [];
        const seenFreeNames = new Set(["undefined", "NaN", "Infinity"]);
        for (const entry of referenced) {
          if (declared.has(entry.name) || seenFreeNames.has(entry.name)) {
            continue;
          }
          seenFreeNames.add(entry.name);
          freeNames.push(entry.name);
        }
        const liveOutNames = [
          ...freeNames.filter((name) => written.has(name)),
          ...hoistNames,
        ];

        const id = segmentCount;
        const helperName = `jvmRegionSegment${namespace}_${id}`;
        const outputName = `jvmRegionSegmentOutput${namespace}_${id}`;
        const caughtName = `jvmRegionSegmentError${namespace}_${id}`;
        const bodyLabel = `jvmRegionSegmentBody${namespace}_${id}`;
        const jumpTable = [];
        const jumpIndex = (kind, label) => {
          const existing = jumpTable.findIndex((entry) =>
            entry.kind === kind && entry.label === label);
          if (existing >= 0) return existing;
          jumpTable.push({kind, label});
          return jumpTable.length - 1;
        };
        const liveOutWrites = () => liveOutNames.map((name, index) =>
          `${outputName}[${index + 2}] = ${name};`);
        const fragmentStart = runStartPosition;
        const fragmentEdits = [];
        // Protocol exits jump to the shared epilogue rather than inlining the
        // live-out write-back: a run with many exits and many live-outs would
        // otherwise re-grow past the optimization budget the pass exists to
        // meet.
        // Braces keep the multi-statement replacement a single statement:
        // the original exit may be an unbraced if-consequent.
        for (const entry of returns) {
          fragmentEdits.push({
            start: entry.start - fragmentStart,
            end: entry.end - fragmentStart,
            replacement: [
              `{ ${outputName}[0] = 1;`,
              `${outputName}[1] = ${entry.argument
                ? rewritten.slice(entry.argument.start, entry.argument.end)
                : "undefined"};`,
              `break ${bodyLabel}; }`,
            ].join(" "),
          });
        }
        for (const jump of outwardJumps) {
          fragmentEdits.push({
            start: jump.node.start - fragmentStart,
            end: jump.node.end - fragmentStart,
            replacement: [
              `{ ${outputName}[0] = 3;`,
              `${outputName}[1] = ${jumpIndex(jump.kind, jump.label)};`,
              `break ${bodyLabel}; }`,
            ].join(" "),
          });
        }
        for (const declaration of hoistDeclarations) {
          const assignments = declaration.declarations
            .filter((declarator) => declarator.init)
            .map((declarator) => `${declarator.id.name} = ${
              rewritten.slice(declarator.init.start, declarator.init.end)};`);
          fragmentEdits.push({
            start: declaration.start - fragmentStart,
            end: declaration.end - fragmentStart,
            replacement: assignments.join(" ") || ";",
          });
        }
        const fragment = applySourceEdits(
          rewritten.slice(fragmentStart, runEndPosition), fragmentEdits);
        if (fragment === null) return;

        helperSources.push([
          `function${runHasYield ? "*" : ""} ${helperName}(${
            [...freeNames, outputName].join(",")}) {`,
          hoistNames.length ? `  let ${hoistNames.join(", ")};` : null,
          "  try {",
          `    ${bodyLabel}: {`,
          ...fragment.split("\n").map((line) => `      ${line}`),
          `      ${outputName}[0] = 0;`,
          `      ${outputName}[1] = undefined;`,
          "    }",
          `  } catch (${caughtName}) {`,
          `    ${outputName}[0] = 2;`,
          `    ${outputName}[1] = ${caughtName};`,
          "  }",
          ...liveOutWrites().map((line) => `  ${line}`),
          "}",
        ].filter((line) => line !== null).join("\n"));
        const callLines = [
          hoistNames.length ? `let ${hoistNames.join(", ")};` : null,
          // A yield-bearing helper suspends inside the delegation, so the
          // shared state array is only written by whichever helper exits, and
          // its protocol reads below run in the same synchronous burst.
          `${runHasYield ? "yield* " : ""}${helperName}(${
            [...freeNames, sharedStateName].join(",")});`,
          ...liveOutNames.map((name, index) =>
            `${name} = ${sharedStateName}[${index + 2}];`),
          `if (${sharedStateName}[0] === 1) return ${sharedStateName}[1];`,
          `if (${sharedStateName}[0] === 2) throw ${sharedStateName}[1];`,
        ].filter((line) => line !== null);
        if (jumpTable.length) {
          callLines.push(`if (${sharedStateName}[0] === 3) {`);
          jumpTable.forEach((entry, index) => {
            callLines.push(`  if (${sharedStateName}[1] === ${index}) ` +
              `${entry.kind}${entry.label ? ` ${entry.label}` : ""};`);
          });
          callLines.push("}");
        }
        edits.push({
          start: runStartPosition,
          end: runEndPosition,
          replacement: callLines.join("\n"),
        });
        segmentCount += 1;
        partitionedSourceBytes += runEndPosition - runStartPosition;
      };

      const recurseIntoStatement = (statement) => {
        const gather = (node) => {
          if (!node?.type || isFunction(node)) return;
          if (node.type === "BlockStatement") {
            walkList(node.body);
            return;
          }
          for (const child of childrenOf(node)) gather(child);
        };
        for (const child of childrenOf(statement)) gather(child);
      };

      const walkList = (statements) => {
        let runStart = 0;
        let runBytes = 0;
        const flush = (endIndex) => {
          if (endIndex > runStart && runBytes >= minimumSegmentBytes) {
            tryExtractRun(statements.slice(runStart, endIndex));
          }
          runBytes = 0;
        };
        for (let index = 0; index < statements.length; index += 1) {
          const statement = statements[index];
          const bytes = statement.end - statement.start;
          if (bytes > targetSegmentBytes) {
            oversizedStatements += 1;
            flush(index);
            runStart = index + 1;
            recurseIntoStatement(statement);
            continue;
          }
          if (runBytes + bytes > targetSegmentBytes &&
              runBytes >= minimumSegmentBytes) {
            flush(index);
            runStart = index;
          }
          runBytes += bytes;
        }
        flush(statements.length);
      };
      walkList(unit.body.body);
    }
    if (!edits.length) break;
    const next = applySourceEdits(rewritten, edits);
    if (next === null) break;
    rewritten = next;
    // Helpers are terminal (never re-collected as units), so they stay out
    // of the working source until the end: re-parsing a megabyte of emitted
    // helpers every round dominated the pass cost on framed-sized modules.
  }
  if (helperSources.length > appendedHelperCount) {
    rewritten += `\n${helperSources.slice(appendedHelperCount).join("\n")}`;
    appendedHelperCount = helperSources.length;
  }

  if (segmentCount > 0) {
    // Keep a leading directive prologue in directive position.
    const directive = /^(['"]use strict['"];\n?)/.exec(rewritten);
    const prologue = `const ${sharedStateName} = [];\n`;
    rewritten = directive
      ? directive[1] + prologue + rewritten.slice(directive[1].length)
      : prologue + rewritten;
  }
  return {
    source: rewritten,
    count: segmentCount,
    partitionedSourceBytes,
    attemptedRuns,
    oversizedStatements,
  };
}

/**
 * Discovers and compiles bounded, runtime-closed call-graph regions.
 *
 * No guest identity participates in admission. Nodes are loaded Method
 * identities, edges come from structured-renderer call metadata, and source
 * composition edits only AST VariableDeclarator initializers named explicitly
 * by that metadata. The ordinary per-method JIT remains the canonical fallback.
 */
class HotCallGraphRegionCompiler {
  constructor(jit, options = {}) {
    this.jit = jit;
    this.jvm = jit.jvm;
    const environment = typeof process !== "undefined" && process.env
      ? process.env : {};
    this.enabled = options.hotCallGraphRegions === true ||
      environment.JVM_ENABLE_HOT_CALL_GRAPH_REGIONS === "1";
    this.maxMethods = Math.max(2, Math.min(128,
      Number(options.hotCallGraphMaxMethods ??
        environment.JVM_HOT_CALL_GRAPH_MAX_METHODS) || 24));
    this.maxCodeItems = Math.max(64, Math.min(1_000_000,
      Number(options.hotCallGraphMaxCodeItems ??
        environment.JVM_HOT_CALL_GRAPH_MAX_CODE_ITEMS) || 20_000));
    this.directSafePointBudget = Math.max(32, Math.min(1_000_000,
      Number(options.hotCallGraphDirectSafePointBudget ??
        environment.JVM_HOT_CALL_GRAPH_DIRECT_SAFE_POINT_BUDGET) ||
        1_000_000));
    this.inlineCodeItemBudget = Math.max(0, Math.min(16_384,
      Number(options.hotCallGraphInlineCodeItemBudget ??
        environment.JVM_HOT_CALL_GRAPH_INLINE_CODE_ITEM_BUDGET) || 512));
    this.maxInlineSitesPerTarget = Math.max(1, Math.min(64,
      Number(options.hotCallGraphMaxInlineSitesPerTarget ??
        environment.JVM_HOT_CALL_GRAPH_MAX_INLINE_SITES_PER_TARGET) || 8));
    this.inlineSourceByteBudget = Math.max(16_384, Math.min(4_194_304,
      Number(options.hotCallGraphInlineSourceByteBudget ??
        environment.JVM_HOT_CALL_GRAPH_INLINE_SOURCE_BYTE_BUDGET) ||
        262_144));
    // The region tier itself is opt-in and is selected only after the caller
    // has already demonstrated loop heat.  Once a previously open edge gains
    // a stable generated target, delaying graph expansion for dozens of
    // additional region entries strands long-running invocations in the
    // canonical method-at-a-time fallback.  Keep the threshold configurable
    // for compile-cost experiments, but expand on the first subsequent hot
    // entry by default.
    this.expansionEntryThreshold = Math.max(1, Math.min(1_000_000,
      Number(options.hotCallGraphExpansionEntryThreshold ??
        environment.JVM_HOT_CALL_GRAPH_EXPANSION_ENTRY_THRESHOLD) || 1));
    const configuredExpansionProbeInterval = Number(
      options.hotCallGraphExpansionProbeInterval ??
        environment.JVM_HOT_CALL_GRAPH_EXPANSION_PROBE_INTERVAL);
    // Target publication and the captured boundary state are the primary
    // invalidation signals. Blind periodic recompilation is an explicit
    // diagnostic fallback only: a stable open graph can otherwise rebuild
    // hundreds of identical megabyte-scale modules during one guest loop.
    this.expansionProbeInterval =
      Number.isFinite(configuredExpansionProbeInterval) &&
        configuredExpansionProbeInterval > 0
        ? Math.max(1, Math.min(1_000_000,
          Math.floor(configuredExpansionProbeInterval)))
        : 0;
    this.expansionProbeCounts = new WeakMap();
    this.dirtyExpansionCount = 0;
    this.stateExpansionCount = 0;
    this.periodicExpansionCount = 0;
    this.minRootCodeItems = Math.max(0,
      Number(options.hotCallGraphMinRootCodeItems ??
        environment.JVM_HOT_CALL_GRAPH_MIN_ROOT_CODE_ITEMS) || 0);
    const configuredMaxRootCodeItems = Number(
      options.hotCallGraphMaxRootCodeItems ??
      environment.JVM_HOT_CALL_GRAPH_MAX_ROOT_CODE_ITEMS ?? 2048);
    this.maxRootCodeItems = Number.isFinite(configuredMaxRootCodeItems) &&
      configuredMaxRootCodeItems > 0
      ? configuredMaxRootCodeItems : Number.POSITIVE_INFINITY;
    this.cache = new WeakMap();
    this.compiling = new WeakSet();
    // Expanding a graph changes its linked edges, not the already generated
    // method sources. Cache each source's AST-derived binding index so an
    // evolving region does not parse and traverse the same large body for
    // every newly closed edge.
    this.callBindingIndexes = new WeakMap();
    this.callBindingIndexBuildCount = 0;
    this.callBindingIndexReuseCount = 0;
    this.lastExpansionAttempts = new WeakMap();
    this.dependentRootsByMethod = new WeakMap();
    this.dirtyRoots = new WeakSet();
    this.guardEpoch = 0;
    this.compiledRegionSummaries = [];
    this.profileRuns = environment.JVM_PROFILE_HOT_CALL_GRAPH_REGIONS === "1";
    this.traceDeopts =
      environment.JVM_TRACE_HOT_CALL_GRAPH_DEOPTS === "1";
    this.traceSource =
      environment.JVM_TRACE_HOT_CALL_GRAPH_SOURCE === "1";
    // Diagnostic escape hatch for differential testing of the AST-selected
    // closed-edge lowering. The region tier remains active when disabled, so
    // this isolates call compaction from graph discovery and guarding.
    this.compactClosedInternalCalls =
      environment.JVM_DISABLE_HOT_CALL_GRAPH_COMPACT_INTERNAL_CALLS !== "1";
    // Post-render outlining is retained as a differential experiment. The
    // Regression measurement showed that even a positional live-in/live-out
    // ABI does not recover the cost of already-expanded cold JVM paths. The
    // production refactor must split verified CFG/SSA before source emission.
    this.loopOutliningEnabled =
      options.hotCallGraphLoopOutlining === true ||
      environment.JVM_ENABLE_HOT_CALL_GRAPH_LOOP_OUTLINING === "1";
    this.loopOutlineSourceBytes = Math.max(4096, Math.min(262144,
      Number(options.hotCallGraphLoopOutlineSourceBytes ??
        environment.JVM_HOT_CALL_GRAPH_LOOP_OUTLINE_SOURCE_BYTES) || 32768));
    this.maxOutlinedLoopsPerNode = Math.max(1, Math.min(64,
      Number(options.hotCallGraphMaxOutlinedLoopsPerNode ??
        environment.JVM_HOT_CALL_GRAPH_MAX_OUTLINED_LOOPS_PER_NODE) || 16));
    // Straight-line partitioning of whatever oversized flat bodies remain
    // after loop outlining. Opt-in while under differential measurement.
    this.linearPartitionEnabled =
      options.hotCallGraphLinearPartition === true ||
      environment.JVM_ENABLE_HOT_CALL_GRAPH_LINEAR_PARTITION === "1";
    this.linearPartitionUnitBytes = Math.max(16384, Math.min(262144,
      Number(options.hotCallGraphLinearPartitionUnitBytes ??
        environment.JVM_HOT_CALL_GRAPH_LINEAR_PARTITION_UNIT_BYTES) ||
        49152));
    this.linearPartitionSegmentBytes = Math.max(4096, Math.min(131072,
      Number(options.hotCallGraphLinearPartitionSegmentBytes ??
        environment.JVM_HOT_CALL_GRAPH_LINEAR_PARTITION_SEGMENT_BYTES) ||
        32768));
    this.linearPartitionMaxSegments = Math.max(1, Math.min(512,
      Number(options.hotCallGraphLinearPartitionMaxSegments ??
        environment.JVM_HOT_CALL_GRAPH_LINEAR_PARTITION_MAX_SEGMENTS) ||
        128));
    // Framed modules carry a generator root whose yields previously made
    // every run unsplittable. Separately gated so the framed and positional
    // partitioners can be measured independently.
    this.framedPartitionEnabled =
      options.hotCallGraphFramedPartition === true ||
      environment.JVM_ENABLE_HOT_CALL_GRAPH_FRAMED_PARTITION === "1";
    // Module-level function declarations and protocol state arrays are
    // invocation-independent by construction (every helper is
    // parameter-complete). Evaluating them once in the factory scope stops
    // every module entry from re-instantiating each helper closure and
    // re-allocating the segment state array.
    this.factoryHoistEnabled =
      options.hotCallGraphFactoryHoist === true ||
      environment.JVM_ENABLE_HOT_CALL_GRAPH_FACTORY_HOIST === "1";
    this.factoryHoistedModuleCount = 0;
    this.factoryHoistedDeclarationCount = 0;
    this.partitionedSegmentCount = 0;
    this.partitionedSegmentSourceBytes = 0;
    this.framedPartitionedSegmentCount = 0;
    this.liftedEnvironmentNameCount = 0;
    this.partitionPassMillis = 0;
    this.compileCount = 0;
    this.moduleCompileCount = 0;
    this.lexicallyInlinedEdgeCount = 0;
    this.exceptionalInlinedEdgeCount = 0;
    this.compactInternalEdgeCount = 0;
    this.guardedInternalEdgeCount = 0;
    this.outlinedLoopCount = 0;
    this.outlinedLoopSourceBytes = 0;
    this.runCount = 0;
    this.rejectionCount = 0;
    this.rejectionSummaries = new Map();
    this.genericCallSiteCounts = new Map();
    this.guardFallbackCount = 0;
    this.lastRejectionReason = null;
  }

  recordRejection(rootMethod, reason) {
    const root = methodKey(this.jvm, rootMethod);
    const key = `${root}\u0000${reason}`;
    const current = this.rejectionSummaries.get(key);
    if (current) {
      current.count += 1;
      return;
    }
    // Diagnostics must remain bounded even when a workload loads thousands
    // of distinct methods. The aggregate counter still records every
    // rejection after this representative table reaches its limit.
    if (this.rejectionSummaries.size < 256) {
      this.rejectionSummaries.set(key, {root, reason, count: 1});
    }
  }

  getRejectionSummaries(limit = 64) {
    return [...this.rejectionSummaries.values()]
      .sort((left, right) => right.count - left.count)
      .slice(0, Math.max(0, limit));
  }

  recordGenericCallSite(id, frame = null) {
    if (!this.profileRuns || !Number.isInteger(id)) return;
    const site = this.jit.syncCallSites[id];
    let entry = this.genericCallSiteCounts.get(id);
    if (!entry) {
      entry = {count: 0, receiverTypes: new Map()};
      this.genericCallSiteCounts.set(id, entry);
    }
    entry.count += 1;
    if (site && site.op !== "invokestatic" && frame?.stack?.items) {
      const receiver = frame.stack.items[
        frame.stack.items.length - site.params.length - 1];
      const type = receiver === null || receiver === undefined
        ? String(receiver) : receiver.type || site.declaredClassName;
      entry.receiverTypes.set(type,
        (entry.receiverTypes.get(type) || 0) + 1);
    }
  }

  getGenericCallSiteSummaries(limit = 64) {
    return [...this.genericCallSiteCounts.entries()]
      .sort((left, right) => right[1].count - left[1].count)
      .slice(0, Math.max(0, limit))
      .map(([id, entry]) => {
        const site = this.jit.syncCallSites[id];
        return {
          id,
          count: entry.count,
          caller: site?.callerMethod
            ? methodKey(this.jvm, site.callerMethod) : null,
          pc: site?.callerPc ?? null,
          op: site?.op || null,
          declaredTarget: site
            ? `${site.declaredClassName}.${site.methodName}${site.descriptor}`
            : null,
          fastReceiverType:
            site?.fastDynamicTarget?.targetClassName || null,
          receiverTypes: [...entry.receiverTypes.entries()]
            .sort((left, right) => right[1] - left[1])
            .slice(0, 8)
            .map(([type, count]) => ({type, count})),
        };
      });
  }

  expandableBoundaryCount(plan) {
    if (!plan?.nodes) return false;
    const included = new Set(plan.nodes.map((node) => node.method));
    let expandable = 0;
    for (const node of plan.nodes) {
      for (const boundary of node.boundaries) {
        if (!boundary.site || boundary.reason === "method-budget" ||
            boundary.reason === "code-budget") continue;
        const target = this.resolveMetadataEdge(boundary.site);
        if (!target) continue;
        // A newly resolved edge to an already included node still changes the
        // module: its call site can now use the local region ABI.
        if (included.has(target.method)) {
          expandable += 1;
          continue;
        }
        const generated = this.jit.codegenCache.get(target.method);
        if (generated?.jvmStructuredSsa &&
            this.jit.canCompileSynchronously(target.method)) expandable += 1;
      }
    }
    return expandable;
  }

  canExpand(plan) {
    if (!this.hasExpandableBoundaryChange(plan)) return false;
    const expandable = this.expandableBoundaryCount(plan);
    if (!expandable) return false;
    const dynamicBoundaries = plan.nodes.reduce((count, node) => count +
      node.boundaries.filter((boundary) => boundary.site?.dynamic).length, 0);
    return expandable >= Math.min(8, Math.max(1, dynamicBoundaries));
  }

  boundaryExpansionState(boundary) {
    const target = this.resolveMetadataEdge(boundary?.site);
    if (!target?.method) return null;
    const generated = this.jit.codegenCache.get(target.method) || null;
    const runtimeSite = target.runtimeSite || null;
    const fastPositional = runtimeSite?.fastPositional || null;
    const positionalTargets = runtimeSite?.fastPositionalTargets || null;
    return {
      method: target.method,
      generated,
      structured: generated?.jvmStructuredSsa === true,
      directSource: generated?.jvmDirectPositionalSource || null,
      restoringSource: generated?.jvmRestoringDirectPositionalSource || null,
      fastInvoke: fastPositional?.invoke || null,
      fastRawInvoke: fastPositional?.rawInvoke || null,
      fastReceiverType: fastPositional?.receiverType || null,
      positionalTargetCount: positionalTargets
        ? Object.keys(positionalTargets).length : 0,
    };
  }

  captureExpandableBoundaryStates(plan) {
    const states = [];
    for (const node of plan?.nodes || []) {
      for (const boundary of node.boundaries) {
        states.push({
          site: boundary.site,
          state: this.boundaryExpansionState(boundary),
        });
      }
    }
    return states;
  }

  sameExpandableBoundaryStates(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) ||
        left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const before = left[index];
      const after = right[index];
      if (before.site !== after.site) return false;
      const beforeState = before.state;
      const afterState = after.state;
      if (beforeState === null || afterState === null) {
        if (beforeState !== afterState) return false;
        continue;
      }
      if (beforeState.method !== afterState.method ||
          beforeState.generated !== afterState.generated ||
          beforeState.structured !== afterState.structured ||
          beforeState.directSource !== afterState.directSource ||
          beforeState.restoringSource !== afterState.restoringSource ||
          beforeState.fastInvoke !== afterState.fastInvoke ||
          beforeState.fastRawInvoke !== afterState.fastRawInvoke ||
          beforeState.fastReceiverType !== afterState.fastReceiverType ||
          beforeState.positionalTargetCount !==
            afterState.positionalTargetCount) {
        return false;
      }
    }
    return true;
  }

  hasExpandableBoundaryChange(plan) {
    if (!plan?.root?.method) return false;
    if (this.dirtyRoots.has(plan.root.method)) return true;
    const attempted = this.lastExpansionAttempts.get(plan.root.method);
    const current = this.captureExpandableBoundaryStates(plan);
    return !this.sameExpandableBoundaryStates(attempted, current);
  }

  isPlanDirty(plan) {
    return Boolean(plan?.root?.method &&
      this.dirtyRoots.has(plan.root.method));
  }

  registerPlanDependencies(plan) {
    const dependencies = new Set(plan.nodes.map((node) => node.method));
    for (const node of plan.nodes) {
      for (const boundary of node.boundaries) {
        const target = this.resolveMetadataEdge(boundary.site);
        if (target?.method) dependencies.add(target.method);
      }
    }
    for (const method of dependencies) {
      let roots = this.dependentRootsByMethod.get(method);
      if (!roots) {
        roots = new Set();
        this.dependentRootsByMethod.set(method, roots);
      }
      roots.add(plan.root.method);
    }
  }

  markGeneratedTargetUpgrade(method) {
    this.guardEpoch += 1;
    for (const root of this.dependentRootsByMethod.get(method) || []) {
      this.dirtyRoots.add(root);
    }
  }

  markMethodDeoptimized(method) {
    this.guardEpoch += 1;
    for (const root of this.dependentRootsByMethod.get(method) || []) {
      this.dirtyRoots.add(root);
    }
  }

  markCallSiteFeedback(site) {
    const callerMethod = site?.callerMethod;
    if (!callerMethod) return;
    this.guardEpoch += 1;
    // Receiver feedback does not publish a new generated Method body, so it
    // cannot flow through markGeneratedTargetUpgrade(). Mark the caller and
    // every enclosing region explicitly. Rebuilding is deferred until the
    // next canonical root entry because the currently active module cannot
    // switch its generated body in the middle of an activation.
    this.dirtyRoots.add(callerMethod);
    for (const root of this.dependentRootsByMethod.get(callerMethod) || []) {
      this.dirtyRoots.add(root);
    }
  }

  sameGraphTopology(left, right) {
    if (!left || !right || left.nodes.length !== right.nodes.length) {
      return false;
    }
    for (let index = 0; index < left.nodes.length; index += 1) {
      const before = left.nodes[index];
      const after = right.nodes[index];
      if (before.method !== after.method ||
          before.edges.length !== after.edges.length ||
          before.boundaries.length !== after.boundaries.length) return false;
      for (let edge = 0; edge < before.edges.length; edge += 1) {
        if (before.edges[edge].site !== after.edges[edge].site ||
            before.edges[edge].method !== after.edges[edge].method) {
          return false;
        }
      }
      for (let boundary = 0; boundary < before.boundaries.length;
        boundary += 1) {
        if (before.boundaries[boundary].site !==
              after.boundaries[boundary].site ||
            before.boundaries[boundary].reason !==
              after.boundaries[boundary].reason) return false;
      }
    }
    return true;
  }

  summarizeEffects(method, items) {
    const code = methodCode(method);
    const arrayLoads = new Set([
      "aaload", "baload", "caload", "daload", "faload", "iaload",
      "laload", "saload",
    ]);
    const arrayStores = new Set([
      "aastore", "bastore", "castore", "dastore", "fastore", "iastore",
      "lastore", "sastore",
    ]);
    const effects = {
      allocates: false,
      invokes: false,
      synchronizes: (method?.flags || []).includes("synchronized"),
      throws: Boolean(code?.exceptionTable?.length),
      loops: this.jit.hasBackwardBranch(method),
      writesHeap: false,
      writesStatic: false,
      instanceWriteKeys: new Set(),
      unknownInstanceWrites: false,
    };
    for (const item of items) {
      const op = opOf(item?.instruction);
      if (!op) continue;
      if (op.startsWith("invoke")) effects.invokes = true;
      if (op === "new" || op === "newarray" || op === "anewarray" ||
          op === "multianewarray") effects.allocates = true;
      if (op === "monitorenter" || op === "monitorexit") {
        effects.synchronizes = true;
      }
      if (op === "athrow" || op === "idiv" || op === "irem" ||
          op === "ldiv" || op === "lrem" || op === "checkcast" ||
          op === "arraylength" || arrayLoads.has(op) || arrayStores.has(op)) {
        effects.throws = true;
      }
      if (op === "putfield" || arrayStores.has(op)) effects.writesHeap = true;
      if (op === "putfield") {
        const member = item?.instruction?.arg?.[2];
        if (Array.isArray(member)) {
          effects.instanceWriteKeys.add(`${member[0]}:${member[1]}`);
        } else {
          effects.unknownInstanceWrites = true;
        }
      }
      if (op === "putstatic") effects.writesStatic = true;
    }
    return effects;
  }

  resolveMetadataEdge(site) {
    if (!site || site.directBoundary) return null;
    if (site.exactTarget && site.resolvedMethod) {
      if (site.dynamic && Number.isInteger(site.id)) {
        const runtimeSite = this.jit.syncCallSites[site.id];
        const dynamic = runtimeSite?.fastDynamicTarget;
        if (!dynamic?.target?.method ||
            dynamic.target.method !== site.resolvedMethod) return null;
        return {
          method: site.resolvedMethod,
          proof: "runtime-monomorphic",
          runtimeSite,
          receiverType: dynamic.targetClassName,
        };
      }
      return {
        method: site.resolvedMethod,
        proof: "bytecode-exact",
        runtimeSite: null,
      };
    }
    if (!site.dynamic || !Number.isInteger(site.id)) return null;
    const runtimeSite = this.jit.syncCallSites[site.id];
    const dynamic = runtimeSite?.fastDynamicTarget;
    if (!dynamic?.target?.method) return null;
    return {
      method: dynamic.target.method,
      proof: "runtime-monomorphic",
      runtimeSite,
      receiverType: dynamic.targetClassName,
    };
  }

  stronglyConnectedComponents(nodes) {
    let nextIndex = 0;
    const stack = [];
    const indexes = new Map();
    const lowLinks = new Map();
    const onStack = new Set();
    const components = [];
    const visit = (node) => {
      indexes.set(node, nextIndex);
      lowLinks.set(node, nextIndex);
      nextIndex += 1;
      stack.push(node);
      onStack.add(node);
      for (const edge of node.edges) {
        const target = edge.node;
        if (!target) continue;
        if (!indexes.has(target)) {
          visit(target);
          lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
        } else if (onStack.has(target)) {
          lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(target)));
        }
      }
      if (lowLinks.get(node) !== indexes.get(node)) return;
      const component = [];
      for (;;) {
        const member = stack.pop();
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      components.push(component);
    };
    for (const node of nodes) if (!indexes.has(node)) visit(node);
    return components;
  }

  rewriteCallBindings(source, edges, functionNames, internalNode = false,
    generatorSource = false, cacheOwner = null,
    compactClosedInternalCalls = false, inlineEdges = null,
    inlineSources = null, fallbackInlineEdges = null) {
    const prefix = generatorSource
      ? "function* __jvmRegionNode() {\n"
      : "function __jvmRegionNode() {\n";
    let ownerIndexes = cacheOwner && this.callBindingIndexes.get(cacheOwner);
    const cachedIndex = ownerIndexes?.get(source);
    let program;
    const comments = [];
    if (!cachedIndex) {
      try {
        program = parse(`${prefix}${source}\n}`, {
          ecmaVersion: "latest",
          ranges: true,
          onComment: comments,
        });
      } catch (error) {
        return {error: `region AST parse failed: ${error.message}`};
      }
      this.callBindingIndexBuildCount += 1;
    } else {
      this.callBindingIndexReuseCount += 1;
    }
    const replacements = new Map();
    for (const edge of edges) {
      const identifiers = edge.site.identifiers || {};
      const functionName = functionNames.get(edge.method);
      if (!functionName || !identifiers.rawInvoke) {
        return {error: "missing structured call-binding metadata"};
      }
      replacements.set(identifiers.rawInvoke, functionName);
      if (identifiers.invoke) {
        replacements.set(identifiers.invoke, "jvmRegionRestoringCall");
      }
      // Dynamic sites must retain their runtime metadata so a later receiver
      // class can select another guarded positional target. Only bytecode-
      // exact static/special edges can discard the call-site object.
      const runtimeDynamic = edge.proof === "runtime-monomorphic";
      if (identifiers.site && !runtimeDynamic) {
        replacements.set(identifiers.site, "null");
      }
      if (identifiers.target) replacements.set(identifiers.target, "null");
      if (identifiers.lateLink) replacements.set(identifiers.lateLink, "false");
      if (identifiers.receiver) {
        replacements.set(identifiers.receiver, JSON.stringify(
          runtimeDynamic ? edge.receiverType : null));
      }
    }
    const edits = [];
    const replaced = new Set();
    const loweredRanges = [];
    let lexicallyInlinedEdges = 0;
    let exceptionalInlinedEdges = 0;
    let compactInternalEdges = 0;
    let guardedInternalEdges = 0;
    const inlineFailureReasons = [];
    const elidedFieldCacheInvalidations = 0;
    const eliminatedBindingNames = new Set();
    const memberPath = (node) => {
      const parts = [];
      let current = node;
      while (current?.type === "MemberExpression" && !current.computed &&
          current.property?.type === "Identifier") {
        parts.unshift(current.property.name);
        current = current.object;
      }
      if (current?.type === "Identifier") parts.unshift(current.name);
      return parts.join(".");
    };
    // Index the large generated AST once. Region roots can contain hundreds
    // of call edges; walking the whole tree independently for every marker is
    // quadratic and can monopolize a Node/browser event loop for minutes.
    let commentsByValue = cachedIndex?.commentsByValue;
    let callsByCallee = cachedIndex?.callsByCallee;
    const edgesByRawCallee = new Map(edges.map((edge) =>
      [edge.site.identifiers?.rawInvoke, edge]));
    let assignmentExpressions = cachedIndex?.assignmentExpressions;
    let assignmentStatements = cachedIndex?.assignmentStatements;
    let variableDeclarators = cachedIndex?.variableDeclarators;
    let callExpressions = cachedIndex?.callExpressions;
    let tryStatements = cachedIndex?.tryStatements;
    if (!cachedIndex) {
      commentsByValue = new Map();
      for (const comment of comments) {
        const value = comment.value.trim();
        const entries = commentsByValue.get(value) || [];
        entries.push({start: comment.start, end: comment.end});
        commentsByValue.set(value, entries);
      }
      callsByCallee = new Map();
      assignmentExpressions = [];
      assignmentStatements = [];
      variableDeclarators = [];
      callExpressions = [];
      tryStatements = [];
      walkAst(program, (node, parent) => {
        if (node.type === "CallExpression") {
          const call = {
            start: node.start,
            end: node.end,
            calleeName: node.callee?.type === "Identifier"
              ? node.callee.name : null,
            arguments: node.arguments.map((argument) => ({
              start: argument.start,
              end: argument.end,
              type: argument.type,
              value: argument.type === "Literal"
                ? argument.value : undefined,
            })),
          };
          callExpressions.push(call);
          if (node.callee?.type === "Identifier") {
            const entries = callsByCallee.get(node.callee.name) || [];
            entries.push(call);
            callsByCallee.set(node.callee.name, entries);
          }
        } else if (node.type === "AssignmentExpression") {
          assignmentExpressions.push({
            start: node.start,
            end: node.end,
            leftName: node.left?.type === "Identifier"
              ? node.left.name : null,
            rightStart: node.right.start,
            rightEnd: node.right.end,
          });
        } else if (node.type === "ExpressionStatement" &&
            node.expression?.type === "AssignmentExpression") {
          assignmentStatements.push({
            start: node.start,
            end: node.end,
            operator: node.expression.operator,
            leftPath: memberPath(node.expression.left),
          });
        } else if (node.type === "VariableDeclarator") {
          variableDeclarators.push({
            name: node.id?.type === "Identifier" ? node.id.name : null,
            initStart: node.init?.start,
            initEnd: node.init?.end,
            statementStart: parent?.type === "VariableDeclaration" &&
              parent.declarations.length === 1 ? parent.start : null,
            statementEnd: parent?.type === "VariableDeclaration" &&
              parent.declarations.length === 1 ? parent.end : null,
            initPath: node.init ? memberPath(node.init) : null,
          });
        } else if (node.type === "TryStatement" && node.handler?.body) {
          const handlerStatements = node.handler.body.body || [];
          const restoringBranch = handlerStatements.find((statement) =>
            statement.type === "IfStatement" &&
              statement.alternate?.type === "BlockStatement");
          const rethrow = handlerStatements.find((statement) =>
            statement.type === "ThrowStatement");
          tryStatements.push({
            blockStart: node.block?.start,
            blockEnd: node.block?.end,
            parameter: node.handler.param?.type === "Identifier"
              ? node.handler.param.name : null,
            handlerStart: node.handler?.body?.start,
            handlerEnd: node.handler?.body?.end,
            restoringStart: restoringBranch?.alternate?.start,
            restoringEnd: restoringBranch?.alternate?.end,
            throwStart: rethrow?.start,
            throwEnd: rethrow?.end,
          });
        }
      });
      if (cacheOwner) {
        if (!ownerIndexes) {
          ownerIndexes = new Map();
          this.callBindingIndexes.set(cacheOwner, ownerIndexes);
        }
        ownerIndexes.set(source, {
          commentsByValue,
          callsByCallee,
          assignmentExpressions,
          assignmentStatements,
          variableDeclarators,
          callExpressions,
          tryStatements,
        });
      }
    }
    if (internalNode) {
      for (const node of assignmentStatements) {
        if (node.operator !== "+=") continue;
        if (node.leftPath !== "helpers.structuredSsa.runCount" &&
            node.leftPath !==
              "helpers.structuredSsa.restoringDirectRunCount") continue;
        edits.push({
          start: node.start - prefix.length,
          end: node.end - prefix.length,
          replacement: "",
        });
      }
    }
    for (const edge of edges) {
      const markers = edge.site.regionMarkers;
      const rawName = edge.site.identifiers?.rawInvoke;
      if (!markers?.start || !markers?.end || !rawName) continue;
      const startComment = commentsByValue.get(markers.start)?.[0];
      const endComment = commentsByValue.get(markers.end)?.find(
        (comment) => !startComment || comment.start > startComment.end);
      if (!startComment || !endComment) continue;
      const rawCall = (callsByCallee.get(rawName) || []).find((node) =>
        node.start >= startComment.end && node.end <= endComment.start);
      const assignments = assignmentExpressions.filter((node) =>
        node.start >= startComment.end && node.end <= endComment.start &&
        node.leftName);
      if (!rawCall || rawCall.arguments.length < 3) continue;
      const assignment = assignments
        .filter((candidate) => candidate.rightStart <= rawCall.start &&
          candidate.rightEnd >= rawCall.end)
        .sort((left, right) =>
          (left.end - left.start) - (right.end - right.start))[0];
      if (!assignment) continue;
      const guardedRuntimeTarget = edge.proof === "runtime-monomorphic" &&
        typeof edge.receiverType === "string" && edge.receiverType.length > 0;
      const compactInternal = Boolean(
        compactClosedInternalCalls && internalNode &&
        (edge.site.exactTarget || guardedRuntimeTarget) && !edge.node?.atomic &&
        !hasRestoringTransientDeopt(edge.node?.generated) &&
        Number.isInteger(edge.site.id));
      if (compactInternal) {
        const fastTry = tryStatements
          .filter((candidate) =>
            candidate.blockStart <= rawCall.start &&
              candidate.blockEnd >= rawCall.end &&
              Number.isInteger(candidate.restoringStart) &&
              Number.isInteger(candidate.restoringEnd) &&
              candidate.parameter)
          .sort((left, right) =>
            (left.blockEnd - left.blockStart) -
              (right.blockEnd - right.blockStart))[0];
        if (fastTry) {
          const callArguments = rawCall.arguments.slice(1, -2).map(
            (argument) => source.slice(
              argument.start - prefix.length,
              argument.end - prefix.length));
          const functionName = functionNames.get(edge.method);
          // The alternate branch of the generated fast-call catch is the
          // exact call-PC restoration path. Reuse that AST-selected block for
          // the cold exception/deopt arms while the normal path becomes one
          // local scalar call. Closed graphs have no canonical child boundary,
          // and nested-entry marker 2 suppresses independent scheduler yields.
          const restoring = source.slice(
            fastTry.restoringStart + 1 - prefix.length,
            fastTry.restoringEnd - 1 - prefix.length);
          const receiver = edge.site.dynamic ? callArguments[0] : null;
          const coldResult = `jvmRegionColdResult${edge.pc}`;
          const admission = receiver
            ? `${receiver} !== null && ${receiver} !== undefined && ` +
              `((${receiver}.type || ${JSON.stringify(
                edge.site.declaredOwner || "")}) === ${JSON.stringify(
                edge.receiverType)})`
            : "true";
          const replacement = [
            `let ${assignment.leftName};`,
            `if (${admission}) {`,
            `try { ${assignment.leftName} = ${functionName}(` +
              `helpers${callArguments.length
                ? `,${callArguments.join(",")}` : ""},thread,2); } ` +
              `catch (${fastTry.parameter}) {`,
            restoring,
            `throw ${fastTry.parameter};`,
            "}",
            "} else {",
            `${assignment.leftName} = ssaAsyncInvoke;`,
            "}",
            `if (${assignment.leftName} === ssaAsyncInvoke) {`,
            restoring,
            `const ${coldResult} = helpers.tryInvokeSyncAt(` +
              `${edge.site.id}, frame, thread);`,
            `if (${coldResult} === ssaAsyncInvoke || (` +
              `${coldResult} && ${coldResult}.deopt)) {`,
            "return {deopt: true, transient: true, " +
              "reason: 'closed region canonical child'};",
            "}",
            "thread.callStack.items.splice(restorationDepth, 1);",
            "plan.target.freeFrame = frame;",
            "frame = null; locals = null; stack = null;",
            `${assignment.leftName} = ${coldResult};`,
            "}",
            `if (${assignment.leftName} && ${assignment.leftName}.deopt) {`,
            restoring,
            `return ${assignment.leftName};`,
            "}",
          ].filter(Boolean).join("\n");
          const range = {
            start: startComment.start - prefix.length,
            end: endComment.end - prefix.length,
          };
          loweredRanges.push(range);
          edits.push({...range, replacement});
          replaced.add(rawName);
          compactInternalEdges += 1;
          if (guardedRuntimeTarget) guardedInternalEdges += 1;
          for (const identifier of Object.values(
            edge.site.identifiers || {})) {
            if (identifier) eliminatedBindingNames.add(identifier);
          }
          continue;
        }
      }
      // A framed region root already has its canonical JVM Frame on the call
      // stack. Its locally linked children run with the regional scheduler
      // marker, so loop polling remains owned by that root; if a child throws,
      // the child's restoring ABI appends its omitted frames beneath the
      // existing root and the exception propagates through the bare call.
      //
      // A transient DEOPT RETURN does not propagate that way. A non-atomic
      // child's restoring body can return the async sentinel (entry guard) or
      // a {deopt} object (nested asynchronous callee, class initialization,
      // thread yield) after restoring its omitted frames onto the call stack.
      // A bare-call lowering discards that result, so the root would keep
      // executing past the call while the suspended child chain sits on the
      // stack; the regression ran a consumer before its producer and read a
      // stale pq.f/aia.t (596-face leftovers against a 124-face model). Only
      // atomic children (or exceptional-inline edges, whose guarded fallback
      // re-runs the original checked span) may lose the scaffold; everyone
      // else keeps the full result-checked call, still direct via the
      // rawInvoke -> region-node redirection.
      if (!edge.node?.atomic && !fallbackInlineEdges?.has(edge)) continue;
      const callArguments = rawCall.arguments.slice(1, -2).map((argument) =>
        source.slice(argument.start - prefix.length,
          argument.end - prefix.length));
      const functionName = functionNames.get(edge.method);
      const inlineDiagnostic = {};
      const inlineSource = inlineEdges?.has(edge)
        ? inlineAtomicPositionalSource(
          inlineSources?.get(edge) ||
            edge.node.generated.jvmInternalRegionPositionalSource,
          callArguments,
          assignment.leftName,
          `jvmRegionInline${edge.pc}_`, true, inlineDiagnostic)
        : null;
      if (inlineEdges?.has(edge) && !inlineSource) {
        inlineFailureReasons.push({edge, reason:
          inlineDiagnostic.reason || "unknown-inline-rejection"});
      }
      let guardedFallbackInline = null;
      const needsInlineFallback = edge.proof === "runtime-monomorphic" ||
        fallbackInlineEdges?.has(edge);
      if (inlineSource && needsInlineFallback &&
          (edge.proof !== "runtime-monomorphic" ||
            callArguments.length > 0)) {
        const resultDeclaration = variableDeclarators.find((declaration) =>
          declaration.name === assignment.leftName &&
          Number.isInteger(declaration.statementStart) &&
          declaration.statementStart >= startComment.end &&
          declaration.statementEnd <= endComment.start);
        if (resultDeclaration) {
          const regionStart = startComment.start - prefix.length;
          const regionEnd = endComment.end - prefix.length;
          const declarationStart = resultDeclaration.statementStart -
            prefix.length;
          const declarationEnd = resultDeclaration.statementEnd -
            prefix.length;
          const originalWithoutDeclaration = source.slice(
            regionStart, declarationStart) + source.slice(
            declarationEnd, regionEnd);
          const guardedBody = inlineAtomicPositionalSource(
            inlineSources?.get(edge) ||
              edge.node.generated.jvmInternalRegionPositionalSource,
            callArguments, assignment.leftName,
            `jvmRegionInline${edge.pc}_`, false);
          let guardedExecution = guardedBody;
          if (fallbackInlineEdges?.has(edge)) {
            const throwingTry = tryStatements
              .filter((candidate) => candidate.blockStart <= rawCall.start &&
                candidate.blockEnd >= rawCall.end && candidate.parameter &&
                Number.isInteger(candidate.handlerStart) &&
                Number.isInteger(candidate.handlerEnd))
              .sort((left, right) =>
                (left.blockEnd - left.blockStart) -
                  (right.blockEnd - right.blockStart))[0];
            const depthDeclaration = variableDeclarators.find(
              (declaration) => declaration.initPath ===
                  "thread.callStack.items.length" &&
                Number.isInteger(declaration.statementStart) &&
                declaration.statementStart >= startComment.end &&
                declaration.statementEnd <= endComment.start);
            if (!throwingTry || !depthDeclaration) {
              inlineFailureReasons.push({edge,
                reason: "missing-exception-restoration-ast"});
              guardedExecution = null;
            } else {
              const handler = source.slice(
                throwingTry.handlerStart + 1 - prefix.length,
                throwingTry.handlerEnd - 1 - prefix.length);
              guardedExecution = [
                `const ${depthDeclaration.name} = ` +
                  "thread.callStack.items.length;",
                "try {",
                guardedBody,
                `} catch (${throwingTry.parameter}) {`,
                handler,
                "}",
              ].join("\n");
            }
          }
          const receiver = callArguments[0];
          const declaredOwner = JSON.stringify(edge.site.declaredOwner || "");
          const receiverType = JSON.stringify(edge.receiverType);
          const admission = edge.proof === "runtime-monomorphic"
            ? `${receiver} !== null && ${receiver} !== undefined && ` +
              `((${receiver}.type || ${declaredOwner}) === ${receiverType})`
            : "true";
          const completed = `jvmRegionInline${edge.pc}_completed`;
          guardedFallbackInline = guardedExecution && [
            `let ${assignment.leftName};`,
            `let ${completed} = false;`,
            `if (${admission}) {`,
            guardedExecution,
            `${completed} = ${assignment.leftName} !== ssaAsyncInvoke && ` +
              `!(${assignment.leftName} && ${assignment.leftName}.deopt);`,
            "}",
            `if (!${completed}) {`,
            originalWithoutDeclaration,
            "}",
          ].join("\n");
        }
      }
      const effectiveInlineSource = needsInlineFallback
        ? guardedFallbackInline : inlineSource;
      const replacement = effectiveInlineSource ||
        `let ${assignment.leftName} = ${functionName}(` +
          `helpers${callArguments.length
            ? `,${callArguments.join(",")}` : ""},thread,2);`;
      if (effectiveInlineSource) {
        lexicallyInlinedEdges += 1;
        if (fallbackInlineEdges?.has(edge)) exceptionalInlinedEdges += 1;
      }
      const range = {
        start: startComment.start - prefix.length,
        end: endComment.end - prefix.length,
      };
      loweredRanges.push(range);
      edits.push({...range, replacement});
      replaced.add(rawName);
      if (!needsInlineFallback) {
        for (const identifier of Object.values(edge.site.identifiers || {})) {
          if (identifier) eliminatedBindingNames.add(identifier);
        }
      }
    }
    for (const node of callExpressions) {
      if (node.calleeName) {
        const edge = edgesByRawCallee.get(node.calleeName);
        const nested = node.arguments[node.arguments.length - 1];
        const start = nested?.start - prefix.length;
        const end = nested?.end - prefix.length;
        if (edge && nested?.type === "Literal" && nested.value === true &&
            !loweredRanges.some((range) =>
              start >= range.start && end <= range.end)) {
          edits.push({start, end, replacement: "2"});
        }
      }
    }
    for (const node of variableDeclarators) {
      if (!node.name || !Number.isInteger(node.initStart) ||
          !Number.isInteger(node.initEnd)) continue;
      const replacement = replacements.get(node.name);
      if (replacement === undefined) continue;
      const start = node.initStart - prefix.length;
      const end = node.initEnd - prefix.length;
      if (loweredRanges.some((range) =>
        start >= range.start && end <= range.end)) continue;
      edits.push({
        start,
        end,
        replacement,
      });
      replaced.add(node.name);
    }
    for (const edge of edges) {
      if (!replaced.has(edge.site.identifiers.rawInvoke)) {
        return {error: `missing raw call binding at bytecode ${edge.pc}`};
      }
    }
    edits.sort((left, right) => left.start - right.start ||
      right.end - left.end);
    const rewrittenParts = [];
    let sourceCursor = 0;
    for (const edit of edits) {
      if (edit.start < sourceCursor) {
        if (edit.end <= sourceCursor) continue;
        return {error: "overlapping region AST edits"};
      }
      rewrittenParts.push(source.slice(sourceCursor, edit.start),
        edit.replacement);
      sourceCursor = edit.end;
    }
    rewrittenParts.push(source.slice(sourceCursor));
    const rewritten = removeUnusedRegionBindings(
      rewrittenParts.join(""), eliminatedBindingNames);
    return {
      source: rewritten,
      lexicallyInlinedEdges,
      exceptionalInlinedEdges,
      compactInternalEdges,
      guardedInternalEdges,
      elidedFieldCacheInvalidations,
      inlineFailureReasons,
    };
  }

  restorationPlan(node) {
    const target = {
      method: node.method,
      lookupClass: node.owner,
      generated: node.generated,
      freeFrame: null,
    };
    return {
      target,
      Frame,
      method: node.method,
      lookupClass: node.owner,
      semantic: node.generated.jvmRestoringDirectPositionalPlan || null,
      restoreFrame: (thread, child, restorationDepth) => {
        const frames = thread.callStack.items;
        if (frames.includes(child)) return;
        const insertion = Number.isInteger(restorationDepth)
          ? Math.max(0, Math.min(restorationDepth, frames.length))
          : frames.length;
        frames.splice(insertion, 0, child);
      },
    };
  }

  compileModule(plan, framedRoot = false) {
    if (framedRoot && typeof plan.root.generated
      .jvmHotCallGraphFramedSource !== "string") return null;
    const functionNames = new Map(plan.nodes.map((node, index) =>
      [node.method, `jvmRegionNode${index}`]));
    // First collapse acyclic, non-throwing subgraphs bottom-up. A node becomes
    // a single internal SSA body only after every outgoing edge has itself
    // become such a body. This is the graph-level fixed point that permits a
    // root -> wrapper -> leaf chain to cross both Method boundaries, rather
    // than merely substituting terminal leaves into otherwise independent
    // generated functions.
    const composedInternalSources = new Map();
    const composedInternalCosts = new Map();
    const composedInlineCounts = new Map();
    let compositionChanged = true;
    while (compositionChanged) {
      compositionChanged = false;
      for (const node of plan.nodes) {
        if (composedInternalSources.has(node) || !node.atomic ||
            hasRestoringTransientDeopt(node.generated) ||
            node.generated.jvmStructuredGuardedBooleanSiteCount > 0 ||
            typeof node.generated.jvmInternalRegionPositionalSource !==
              "string") continue;
        if (node.edges.length === 0) {
          composedInternalSources.set(node,
            node.generated.jvmInternalRegionPositionalSource);
          composedInternalCosts.set(node, node.codeItems);
          composedInlineCounts.set(node, 0);
          compositionChanged = true;
          continue;
        }
        if (node.edges.some((edge) => edge.proof !== "bytecode-exact" ||
            edge.site.op !== "invokestatic" ||
            !composedInternalSources.has(edge.node))) continue;
        const sitesByTarget = new Map();
        for (const edge of node.edges) {
          sitesByTarget.set(edge.method,
            (sitesByTarget.get(edge.method) || 0) + 1);
        }
        if ([...sitesByTarget.values()].some((count) =>
          count > this.maxInlineSitesPerTarget)) continue;
        const expandedCost = node.codeItems + node.edges.reduce(
          (sum, edge) => sum + composedInternalCosts.get(edge.node), 0);
        if (expandedCost > this.inlineCodeItemBudget) continue;
        const edgeSources = new Map(node.edges.map((edge) =>
          [edge, composedInternalSources.get(edge.node)]));
        const rewritten = this.rewriteCallBindings(
          node.generated.jvmInternalRegionPositionalSource,
          node.edges, functionNames, true, false, node.generated,
          false, new Set(node.edges), edgeSources);
        if (!rewritten.source) continue;
        if (rewritten.source.length > this.inlineSourceByteBudget) continue;
        composedInternalSources.set(node, rewritten.source);
        composedInternalCosts.set(node, expandedCost);
        composedInlineCounts.set(node, node.edges.reduce(
          (sum, edge) => sum + 1 +
            (composedInlineCounts.get(edge.node) || 0), 0));
        compositionChanged = true;
      }
    }
    const exceptionalInlineSources = new Map();
    const exceptionalInlineCosts = new Map();
    const exceptionalInlineCounts = new Map();
    const exceptionalInlinePlanNames = new Map();
    for (let index = 0; index < plan.nodes.length; index += 1) {
      const node = plan.nodes[index];
      if (!node.effects.throws || node.effects.allocates ||
          node.effects.synchronizes || node.edges.length !== 0 ||
          hasRestoringTransientDeopt(node.generated) ||
          node.generated.jvmStructuredGuardedBooleanSiteCount > 0 ||
          typeof node.generated.jvmRestoringDirectPositionalSource !==
            "string") continue;
      const planName = `jvmRegionInlinePlan${index}`;
      exceptionalInlinePlanNames.set(node, planName);
      exceptionalInlineSources.set(node,
        `const plan = ${planName};\n` +
        node.generated.jvmRestoringDirectPositionalSource);
      exceptionalInlineCosts.set(node, node.codeItems);
      exceptionalInlineCounts.set(node, 0);
    }
    let exceptionalCompositionChanged = true;
    while (exceptionalCompositionChanged) {
      exceptionalCompositionChanged = false;
      for (let index = 0; index < plan.nodes.length; index += 1) {
        const node = plan.nodes[index];
        if (exceptionalInlineSources.has(node) ||
            node.effects.allocates || node.effects.synchronizes ||
            node.boundaries.length !== 0 || node.edges.length === 0 ||
            hasRestoringTransientDeopt(node.generated) ||
            node.generated.jvmStructuredGuardedBooleanSiteCount > 0 ||
            typeof node.generated.jvmRestoringDirectPositionalSource !==
              "string" || node.edges.some((edge) =>
              edge.proof !== "bytecode-exact" ||
              edge.site.op !== "invokestatic" ||
              !exceptionalInlineSources.has(edge.node))) continue;
        const sitesByTarget = new Map();
        for (const edge of node.edges) {
          sitesByTarget.set(edge.method,
            (sitesByTarget.get(edge.method) || 0) + 1);
        }
        if ([...sitesByTarget.values()].some((count) =>
          count > this.maxInlineSitesPerTarget)) continue;
        const expandedCost = node.codeItems + node.edges.reduce(
          (sum, edge) => sum + exceptionalInlineCosts.get(edge.node), 0);
        if (expandedCost > this.inlineCodeItemBudget) continue;
        const planName = `jvmRegionInlinePlan${index}`;
        exceptionalInlinePlanNames.set(node, planName);
        const source = `const plan = ${planName};\n` +
          node.generated.jvmRestoringDirectPositionalSource;
        const rewritten = this.rewriteCallBindings(
          source, node.edges, functionNames, true, false, node.generated,
          false, new Set(node.edges), new Map(node.edges.map((edge) =>
            [edge, exceptionalInlineSources.get(edge.node)])),
          new Set(node.edges));
        if (!rewritten.source) continue;
        if (rewritten.source.length > this.inlineSourceByteBudget) continue;
        exceptionalInlineSources.set(node, rewritten.source);
        exceptionalInlineCosts.set(node, expandedCost);
        exceptionalInlineCounts.set(node, node.edges.reduce(
          (sum, edge) => sum + 1 +
            (exceptionalInlineCounts.get(edge.node) || 0), 0));
        exceptionalCompositionChanged = true;
      }
    }
    const inlineSourceForNode = (node) =>
      exceptionalInlineSources.get(node) || composedInternalSources.get(node);
    const inlineCostForNode = (node) =>
      exceptionalInlineSources.has(node)
        ? exceptionalInlineCosts.get(node) : composedInternalCosts.get(node);
    const inlineAdmissionReasons = new Map();
    const inlineAdmissionReason = (edge) => {
      const exceptional = exceptionalInlineSources.has(edge.node);
      if (!edge.node?.atomic && !exceptional) {
        if (edge.node?.effects.throws) return "target-may-throw";
        if (edge.node?.effects.allocates) return "target-allocates";
        if (edge.node?.effects.synchronizes) return "target-synchronizes";
        if (edge.node?.effects.loops) return "target-loops";
        return "target-has-non-atomic-descendant";
      }
      if (hasRestoringTransientDeopt(edge.node.generated)) {
        return "target-restoring-deopt";
      }
      if (edge.node.generated.jvmStructuredGuardedBooleanSiteCount > 0) {
        return "target-guarded-static-boolean";
      }
      if (!inlineSourceForNode(edge.node)) {
        return "target-without-internal-region-ir";
      }
      const staticExact = edge.proof === "bytecode-exact" &&
        edge.site.op === "invokestatic";
      const guardedVirtualLeaf = edge.proof === "runtime-monomorphic" &&
        edge.node.edges.length === 0 && Boolean(edge.receiverType);
      if (!staticExact && !guardedVirtualLeaf) {
        return edge.proof === "runtime-monomorphic"
          ? "non-leaf-runtime-target" : "unsupported-dispatch-proof";
      }
      return "eligible";
    };
    for (const caller of plan.nodes) {
      for (const edge of caller.edges) {
        inlineAdmissionReasons.set(edge, inlineAdmissionReason(edge));
      }
    }
    // Bound code growth over the whole graph, not one call site at a time.
    // Repeating a tiny leaf hundreds of times creates a much larger host
    // function and can be slower than one locally linked function. Grouping
    // by Method identity makes that trade-off explicit in the region IR.
    const inlineGroups = new Map();
    for (const caller of plan.nodes) {
      for (const edge of caller.edges) {
        if (inlineAdmissionReasons.get(edge) !== "eligible") continue;
        const entries = inlineGroups.get(edge.method) || [];
        entries.push(edge);
        inlineGroups.set(edge.method, entries);
      }
    }
    const inlineEdges = new Set();
    const fallbackInlineEdges = new Set();
    let remainingInlineCodeItems = this.inlineCodeItemBudget;
    let remainingInlineSourceBytes = this.inlineSourceByteBudget;
    const orderedInlineGroups = [...inlineGroups.entries()].sort(
      (left, right) => {
        const leftCost = left[1].length *
          inlineSourceForNode(left[1][0].node).length;
        const rightCost = right[1].length *
          inlineSourceForNode(right[1][0].node).length;
        return leftCost - rightCost;
      });
    for (const [_method, edges] of orderedInlineGroups) {
      const cost = edges.length * inlineCostForNode(edges[0].node);
      const sourceCost = edges.length *
        inlineSourceForNode(edges[0].node).length;
      if (edges.length > this.maxInlineSitesPerTarget) {
        for (const edge of edges) {
          inlineAdmissionReasons.set(edge, "target-site-budget");
        }
        continue;
      }
      if (cost > remainingInlineCodeItems) {
        for (const edge of edges) {
          inlineAdmissionReasons.set(edge, "region-code-budget");
        }
        continue;
      }
      if (sourceCost > remainingInlineSourceBytes) {
        for (const edge of edges) {
          inlineAdmissionReasons.set(edge, "region-source-byte-budget");
        }
        continue;
      }
      for (const edge of edges) inlineEdges.add(edge);
      for (const edge of edges) {
        if (exceptionalInlineSources.has(edge.node)) {
          fallbackInlineEdges.add(edge);
        }
      }
      for (const edge of edges) inlineAdmissionReasons.set(edge, "selected");
      remainingInlineCodeItems -= cost;
      remainingInlineSourceBytes -= sourceCost;
    }
    const captures = {
      jvmRegionGuard: (thread) => this.enter(plan, thread),
      jvmRegionRestoringCall: {jvmRestoresExceptionFrames: true},
      ssaAsyncInvoke: this.jit.asyncInvokeSentinel(),
      ssaReturnVoid: this.jit.returnVoid(),
    };
    for (const [node, planName] of exceptionalInlinePlanNames) {
      captures[planName] = this.restorationPlan(node);
    }
    const declarations = [];
    const closedRestoringNodes = new Set();
    if (plan.closed) {
      for (const caller of plan.nodes) {
        for (const edge of caller.edges) {
          if (edge.node && !edge.node.atomic && edge.site.exactTarget &&
              edge.node.generated.jvmDirectPositionalSource) {
            closedRestoringNodes.add(edge.node);
          }
        }
      }
    }
    let lexicallyInlinedEdges = 0;
    let exceptionalInlinedEdges = 0;
    let compactInternalEdges = 0;
    let guardedInternalEdges = 0;
    let outlinedLoops = 0;
    let outlinedLoopSourceBytes = 0;
    let largestOutlinedLoopSourceBytes = 0;
    let elidedFieldCacheInvalidations = 0;
    const inlineFailures = [];
    for (let index = 0; index < plan.nodes.length; index += 1) {
      const node = plan.nodes[index];
      const argumentsList = node.generated.jvmStructuredRegionArgumentNames;
      if (!Array.isArray(argumentsList)) {
        this.lastRejectionReason = `missing positional arguments ${node.key}`;
        return null;
      }
      if (plan.standaloneRecursiveNodes?.has(node)) {
        const bodyName = `jvmRegionRecursiveBody${index}`;
        const planName = `jvmRegionPlan${index}`;
        captures[bodyName] = node.generated.jvmRestoringDirectPositionalBody;
        captures[planName] = this.restorationPlan(node);
        const parameters = ["helpers", ...argumentsList, "thread",
          "nestedEntryGuarded"];
        declarations.push(
          `function ${functionNames.get(node.method)}(${parameters.join(",")}) {`,
          `return ${bodyName}(helpers,${planName},${
            argumentsList.join(",")}${argumentsList.length ? "," : ""}` +
            "thread,nestedEntryGuarded);",
          "}",
        );
        continue;
      }
      const restoringSource =
        node.generated.jvmRestoringDirectPositionalSource;
      const directSource = node.generated.jvmDirectPositionalSource;
      // Checked-leaf sources deliberately omit general field-cache storage;
      // their compact field path is valid only for entry-owned transactional
      // receivers. A value loaded from a resolved reference table can become
      // a different receiver at each invocation, so retain the full restoring
      // source whenever the renderer reports any field-read cache.
      const checkedSource = node === plan.root ||
        node.generated.jvmStructuredFieldReadCacheCount > 0 ? null :
          node.generated.jvmTrustedCheckedLeafDirectPositionalSource ||
          node.generated.jvmCheckedLeafDirectPositionalSource;
      const framedSource = node === plan.root && framedRoot
        ? node.generated.jvmHotCallGraphFramedSource : null;
      // Match the ordinary positional tier's preference: a direct source has
      // already proven that it can complete without omitted-frame recovery.
      // Use the larger restoring source only when that proof was unavailable.
      const source = framedSource ||
        (node !== plan.root
          ? (node.edges.length > 0
            ? exceptionalInlineSources.get(node) : null) ||
            composedInternalSources.get(node)
          : null) ||
        (closedRestoringNodes.has(node) ? restoringSource : null) ||
        directSource || checkedSource || restoringSource;
      if (typeof source !== "string") {
        this.lastRejectionReason = `missing positional source ${node.key}`;
        return null;
      }
      const sourceAlreadyComposed = node !== plan.root && node.edges.length > 0 &&
        (source === composedInternalSources.get(node) ||
          source === exceptionalInlineSources.get(node));
      const rewritten = sourceAlreadyComposed
        ? {source, lexicallyInlinedEdges:
          exceptionalInlineCounts.get(node) ||
            composedInlineCounts.get(node) || 0,
        exceptionalInlinedEdges: source === exceptionalInlineSources.get(node)
          ? exceptionalInlineCounts.get(node) || 0 : 0,
        elidedFieldCacheInvalidations: 0}
        : this.rewriteCallBindings(
          source, node.edges, functionNames, node !== plan.root,
          Boolean(framedSource), node.generated,
          this.compactClosedInternalCalls, inlineEdges,
          new Map([...inlineEdges].map((edge) =>
            [edge, inlineSourceForNode(edge.node)])), fallbackInlineEdges);
      if (!rewritten.source) {
        this.lastRejectionReason = rewritten.error;
        return null;
      }
      const outlined = this.loopOutliningEnabled && !framedSource
        ? outlineLargeRegionLoops(rewritten.source, {
          minimumSourceBytes: this.loopOutlineSourceBytes,
          maximumOutlines: this.maxOutlinedLoopsPerNode,
          namespace: index,
        })
        : {source: rewritten.source, count: 0, outlinedSourceBytes: 0,
          largestOutlinedSourceBytes: 0, helperSources: []};
      // A fused graph is one scheduler execution unit. Per-method generated
      // sources normally own their counter, but retaining those declarations
      // here resets the quantum at every internal edge and lets a deep graph
      // run for N independent budgets. Remove only the renderer's exact
      // declaration; every node then closes over the module-owned counter.
      const emittedSource = outlined.source.replace(
        /(^|\n)([ \t]*)let safePointBudget = \d+;(?=\n|$)/g,
        "$1$2");
      outlinedLoops += outlined.count;
      outlinedLoopSourceBytes += outlined.outlinedSourceBytes;
      largestOutlinedLoopSourceBytes = Math.max(
        largestOutlinedLoopSourceBytes,
        outlined.largestOutlinedSourceBytes);
      lexicallyInlinedEdges += rewritten.lexicallyInlinedEdges || 0;
      exceptionalInlinedEdges += rewritten.exceptionalInlinedEdges || 0;
      compactInternalEdges += rewritten.compactInternalEdges || 0;
      guardedInternalEdges += rewritten.guardedInternalEdges || 0;
      inlineFailures.push(...(rewritten.inlineFailureReasons || []));
      elidedFieldCacheInvalidations +=
        rewritten.elidedFieldCacheInvalidations || 0;
      const functionName = functionNames.get(node.method);
      declarations.push(...outlined.helperSources);
      if (framedSource) {
        declarations.push(
          `function* ${functionName}(` +
            "frame,thread,helpers,initialBytecodeChecks,framelessEntry) {",
          emittedSource,
          "}",
        );
        continue;
      }
      const parameters = ["helpers", ...argumentsList, "thread",
        "nestedEntryGuarded"];
      if (source === restoringSource) {
        const planName = `jvmRegionPlan${index}`;
        captures[planName] = this.restorationPlan(node);
        declarations.push(
          `function ${functionName}(${parameters.join(",")}) {`,
          `const plan = ${planName};`,
          emittedSource,
          "}",
        );
      } else {
        declarations.push(
          `function ${functionName}(${parameters.join(",")}) {`,
          emittedSource,
          "}",
        );
      }
    }
    const rootArguments = plan.root.generated
      .jvmStructuredRegionArgumentNames;
    const rootName = functionNames.get(plan.root.method);
    const rootNeedsReceiver = !(
      (plan.root.method.flags || []).includes("static") ||
      (Number(plan.root.method.accessFlags) & 0x0008) !== 0);
    // A positional graph entry is optional. Prove that its receiver still has
    // reference shape before any fused guest effect: stale/rebound call-site
    // feedback must fall back to canonical invocation, never reinterpret a
    // primitive operand as local0 and corrupt instance fields.
    const rootReceiverGuard = !framedRoot && rootNeedsReceiver
      ? "if (argument0 === null || (typeof argument0 !== 'object' && " +
        "typeof argument0 !== 'string' && typeof argument0 !== 'function')) " +
        "return ssaAsyncInvoke;"
      : null;
    const unprunedModuleSource = [
      "'use strict';",
      `let safePointBudget = ${this.directSafePointBudget};`,
      ...declarations,
      framedRoot
        ? `return ${rootName}(` +
          "frame,thread,helpers,initialBytecodeChecks,false);"
        : "if (!jvmRegionGuard(thread, helpers)) {",
      framedRoot ? null : "  return helpers.asyncInvokeSentinel();",
      framedRoot ? null : "}",
      rootReceiverGuard,
      framedRoot ? null :
        `return ${rootName}(helpers,${rootArguments.join(",")}${
          rootArguments.length ? "," : ""}thread,2);`,
    ].filter(Boolean).join("\n");
    // A framed root shares one function-scoped local namespace across the
    // whole body; lift it into an environment array first so partitioning
    // does not re-plumb hundreds of names through every segment boundary.
    const partitionStarted = this.jit.monotonicNow();
    const lifted = framedRoot && this.framedPartitionEnabled
      ? liftOversizedUnitLocalsToEnvironment(unprunedModuleSource, {
        maximumUnitBytes: this.linearPartitionUnitBytes,
        namespace: "0",
      })
      : {source: unprunedModuleSource, liftedNames: 0, units: 0};
    this.liftedEnvironmentNameCount += lifted.liftedNames;
    const partitioned = (framedRoot
      ? this.framedPartitionEnabled : this.linearPartitionEnabled)
      ? partitionOversizedLinearBlocks(lifted.source, {
        maximumUnitBytes: this.linearPartitionUnitBytes,
        targetSegmentBytes: this.linearPartitionSegmentBytes,
        maximumSegments: this.linearPartitionMaxSegments,
        namespace: "0",
      })
      : {source: unprunedModuleSource, count: 0, partitionedSourceBytes: 0};
    this.partitionPassMillis += this.jit.monotonicNow() - partitionStarted;
    this.partitionedSegmentCount += partitioned.count;
    this.partitionedSegmentSourceBytes += partitioned.partitionedSourceBytes;
    if (framedRoot) this.framedPartitionedSegmentCount += partitioned.count;
    if (partitioned.count > 0 && process.env.JVM_DEBUG_PARTITION_DUMP) {
      require("fs").writeFileSync(
        `${process.env.JVM_DEBUG_PARTITION_DUMP}/partitioned-${
          this.moduleCompileCount}-${plan.root.method.name}.js`,
        partitioned.source);
    }
    const moduleSource = removeUnreachableRegionFunctions(
      partitioned.source, rootName);
    const factorySplit = this.factoryHoistEnabled
      ? splitModuleSourceForFactoryHoist(moduleSource) : null;
    if (factorySplit) {
      this.factoryHoistedModuleCount += 1;
      this.factoryHoistedDeclarationCount += factorySplit.hoistedCount;
    }
    let body;
    try {
      body = this.jit.createGeneratedFunction(
        plan.root.method,
        framedRoot ? "hot-call-graph-framed-region" :
          "hot-call-graph-region",
        framedRoot
          ? ["frame", "thread", "helpers", "initialBytecodeChecks"]
          : ["helpers", ...rootArguments, "thread", "nestedEntryGuarded"],
        factorySplit ? factorySplit.entrySource : moduleSource,
        null, false, false, captures,
        factorySplit ? factorySplit.hoistedSource : null);
    } catch (error) {
      this.lastRejectionReason = `region module compile failed: ${
        error.message || error}`;
      return null;
    }
    if (!framedRoot && this.traceDeopts) {
      const unprofiledBody = body;
      body = function hotCallGraphDeoptProbe() {
        const result = unprofiledBody.apply(null, arguments);
        if (result?.deopt) {
          plan.deoptCount += 1;
          const reason = result.reason || "unspecified";
          plan.deoptReasons.set(reason,
            (plan.deoptReasons.get(reason) || 0) + 1);
          if (plan.summary) {
            plan.summary.deopts = plan.deoptCount;
            plan.summary.deoptReasons = [...plan.deoptReasons.entries()]
              .sort((left, right) => right[1] - left[1])
              .slice(0, 8)
              .map(([deoptReason, count]) => ({reason: deoptReason, count}));
          }
        }
        return result;
      };
    }
    if (framedRoot) {
      const fallback = plan.root.generated;
      const compiled = plan.root.generated
        .jvmHotCallGraphWrapGenerator?.(body);
      if (typeof compiled !== "function") {
        this.lastRejectionReason = "missing framed continuation wrapper";
        return null;
      }
      body = function hotCallGraphFramedEntry(
        frame, thread, helpers, initialBytecodeChecks,
      ) {
        const refreshed = this.jit.refreshHotCallGraphRegionAtEntry(
          plan.root.generated, frame);
        const latest = refreshed?.jvmHotCallGraphFramedBody;
        if (typeof latest === "function" && latest !== body) {
          return latest(frame, thread, helpers, initialBytecodeChecks);
        }
        return plan.guard(thread, helpers) &&
            (frame.pc === 0 || fallback.jvmHotCallGraphHasContinuation?.(frame))
          ? (this.runCount += 1,
            plan.entryCount += 1,
            this.profileRuns && plan.summary && (plan.summary.runs += 1),
            compiled(frame, thread, helpers, initialBytecodeChecks))
          : (this.guardFallbackCount += 1,
            fallback(frame, thread, helpers, initialBytecodeChecks));
      }.bind(this);
      body.jvmSynchronous = true;
      body.jvmStructuredSsa = true;
      body.jvmHotCallGraphFramedRegion = true;
      body.jvmHotCallGraphRegionSource = moduleSource;
    }
    body.jvmHotCallGraphRegion = true;
    body.jvmHotCallGraphRegionPlan = plan;
    body.jvmHotCallGraphRegionNodeCount = plan.nodes.length;
    body.jvmHotCallGraphLexicallyInlinedEdgeCount = lexicallyInlinedEdges;
    body.jvmHotCallGraphExceptionalInlinedEdgeCount =
      exceptionalInlinedEdges;
    body.jvmHotCallGraphCompactInternalEdgeCount = compactInternalEdges;
    body.jvmHotCallGraphGuardedInternalEdgeCount = guardedInternalEdges;
    body.jvmHotCallGraphOutlinedLoopCount = outlinedLoops;
    body.jvmHotCallGraphOutlinedLoopSourceBytes = outlinedLoopSourceBytes;
    body.jvmHotCallGraphLargestOutlinedLoopSourceBytes =
      largestOutlinedLoopSourceBytes;
    body.jvmHotCallGraphPartitionedSegmentCount = partitioned.count;
    body.jvmHotCallGraphPartitionedSegmentSourceBytes =
      partitioned.partitionedSourceBytes;
    body.jvmHotCallGraphInlineAdmissionReasons =
      [...inlineAdmissionReasons.values()].reduce((counts, reason) => {
        counts[reason] = (counts[reason] || 0) + 1;
        return counts;
      }, {});
    if (this.traceSource) {
      body.jvmHotCallGraphInlineAdmissionEdges = plan.nodes.flatMap((caller) =>
        caller.edges.map((edge) => ({
          caller: caller.key,
          pc: edge.pc,
          op: edge.site.op,
          proof: edge.proof,
          target: edge.node?.key || null,
          targetCodeItems: edge.node?.codeItems || 0,
          reason: inlineAdmissionReasons.get(edge) || "not-considered",
        })));
      body.jvmHotCallGraphInlineFailures = inlineFailures.map(
        ({edge, reason}) => ({
          caller: plan.nodes.find((node) => node.edges.includes(edge))?.key ||
            null,
          pc: edge.pc,
          target: edge.node?.key || null,
          reason,
        }));
    }
    body.jvmHotCallGraphElidedFieldCacheInvalidationCount =
      elidedFieldCacheInvalidations;
    body.jvmHotCallGraphRegionSource = moduleSource;
    if (typeof process !== "undefined" && process.env &&
        process.env.JVM_TRACE_REGION_SOURCE_DIR) {
      try {
        const fs = require("fs");
        const rootKey = plan.root.key.replace(/[^A-Za-z0-9._-]/g, "_");
        fs.writeFileSync(`${process.env.JVM_TRACE_REGION_SOURCE_DIR}/region-${
          rootKey}-${this.moduleCompileCount}.js`, moduleSource);
      } catch (_) {}
    }
    this.moduleCompileCount += 1;
    this.outlinedLoopCount += outlinedLoops;
    this.outlinedLoopSourceBytes += outlinedLoopSourceBytes;
    return body;
  }

  compile(rootMethod, options = {}) {
    this.lastRejectionReason = null;
    if (!this.enabled || !rootMethod || this.compiling.has(rootMethod)) {
      return null;
    }
    const rootCodeItems = this.jit.getCodeItems(rootMethod).length;
    if (rootCodeItems < this.minRootCodeItems ||
        rootCodeItems > this.maxRootCodeItems) return null;
    const cached = this.cache.get(rootMethod);
    const expandsCached = cached?.backendEligible && cached.guard() &&
      (options.forceExpansion
        ? (options.ignoreExpansionAttempt ||
            this.hasExpandableBoundaryChange(cached)) &&
          (this.isPlanDirty(cached) ||
            this.expandableBoundaryCount(cached) > 0)
        : this.canExpand(cached));
    if (cached?.backendEligible && cached.guard() && !expandsCached) {
      return cached;
    }
    if (expandsCached) {
      this.dirtyRoots.delete(rootMethod);
      this.lastExpansionAttempts.set(rootMethod,
        this.captureExpandableBoundaryStates(cached));
    }
    if (cached) this.cache.delete(rootMethod);
    const reject = (reason) => {
      this.lastRejectionReason = reason;
      this.rejectionCount += 1;
      this.recordRejection(rootMethod, reason);
      return null;
    };
    this.compiling.add(rootMethod);
    try {
      const nodesByMethod = new Map();
      const pending = [rootMethod];
      let totalCodeItems = 0;
      while (pending.length) {
        const method = pending.shift();
        if (nodesByMethod.has(method)) continue;
        if (nodesByMethod.size >= this.maxMethods) {
          return reject("method budget exceeded");
        }
        if (!this.jit.canCompileSynchronously(method)) {
          return reject(`asynchronous node ${methodKey(this.jvm, method)}`);
        }
        const canonicalGenerated = this.jit.getGeneratedFunction(method);
        const generated = this.jit.getStructuredRegionCandidate(
          method, canonicalGenerated);
        if (!generated?.jvmStructuredSsa) {
          return reject(`uncompiled structured node ${methodKey(
            this.jvm, method)}`);
        }
        const items = this.jit.getCodeItems(method);
        totalCodeItems += items.length;
        if (totalCodeItems > this.maxCodeItems) {
          return reject("bytecode budget exceeded");
        }
        const node = {
          method,
          key: methodKey(this.jvm, method),
          owner: method.className || this.jvm.findClassNameForMethod?.(method),
          codeItems: items.length,
          effects: this.summarizeEffects(method, items),
          edges: [],
          boundaries: [],
          generated,
          canonicalGenerated,
        };
        nodesByMethod.set(method, node);
        const callSites = generated.jvmStructuredRegionCallSites;
        if (!Array.isArray(callSites)) {
          return reject(`missing structured call metadata ${node.key}`);
        }
        const resolvedCallTargets = new Map();
        for (const site of callSites) {
          if (site.directBoundary) continue;
          const resolved = this.resolveMetadataEdge(site);
          resolvedCallTargets.set(site, resolved);
        }
        for (const site of callSites) {
          if (site.directBoundary) continue;
          const target = resolvedCallTargets.get(site);
          if (!target) {
            node.boundaries.push({
              pc: site.pc,
              op: site.op,
              reason: "unresolved-or-polymorphic",
              site,
            });
            continue;
          }
          // Keep a fully compiled, productive Wasm child behind a canonical
          // Frame boundary.  Lexically embedding its structured JavaScript
          // body would bypass normal tier selection for the lifetime of this
          // fused module and is especially costly for large numeric kernels.
          if (this.jit.hasReadyFullWasm(target.method)) {
            node.boundaries.push({
              pc: site.pc,
              op: site.op,
              reason: "productive-wasm-target",
              site,
            });
            continue;
          }
          if (!this.jit.canCompileSynchronously(target.method)) {
            node.boundaries.push({
              pc: site.pc,
              op: site.op,
              reason: "asynchronous-target",
              site,
            });
            continue;
          }
          const targetCanonicalGenerated = this.jit.getGeneratedFunction(
            target.method);
          const targetGenerated = this.jit.getStructuredRegionCandidate(
            target.method, targetCanonicalGenerated);
          if (!targetGenerated?.jvmStructuredSsa) {
            node.boundaries.push({
              pc: site.pc,
              op: site.op,
              reason: "uncompiled-structured-target",
              site,
            });
            continue;
          }
          // A target that can restore a canonical child on a speculative
          // range/coarse-loop failure remains part of the region, but its call
          // scaffold must survive module composition. That scaffold carries
          // the deopt result through each omitted caller, links an active
          // child to its exact return PC, and reconstructs canonical Frames.
          // rewriteCallBindings consults the same published capability before
          // deciding whether an AST-selected call region may be compacted.
          // A non-root region node is called through the scalar ABI. Some
          // perfectly valid structured methods intentionally retain only a
          // canonical Frame entry (constructors, reference-heavy methods, or
          // unsupported restoration shapes). Including such a node makes the
          // backend reject the entire graph later. Keep the call as an
          // explicit canonical boundary instead, allowing the surrounding
          // closed numeric subgraph to compile and resume around it.
          if (typeof targetGenerated.jvmDirectPositionalSource !== "string" &&
              typeof targetGenerated.jvmRestoringDirectPositionalSource !==
                "string") {
            node.boundaries.push({
              pc: site.pc,
              op: site.op,
              reason: "target-without-positional-region-abi",
              site,
            });
            continue;
          }
          const edge = {pc: site.pc, site, ...target, node: null};
          node.edges.push(edge);
          if (!nodesByMethod.has(target.method)) pending.push(target.method);
        }
      }
      const nodes = [...nodesByMethod.values()];
      for (const node of nodes) {
        for (const edge of node.edges) {
          edge.node = nodesByMethod.get(edge.method);
        }
      }
      // Compute a conservative fixed point over the admitted graph. Exact
      // child calls contribute their bytecode writes; a boundary contributes
      // a finite set only when its implementation explicitly published one.
      // The key intentionally matches the renderer's inheritance-safe
      // name:descriptor cache kill key.
      for (const node of nodes) {
        node.transitiveInstanceWriteKeys = new Set(
          node.effects.instanceWriteKeys);
        node.transitiveUnknownInstanceWrites =
          node.effects.unknownInstanceWrites || node.boundaries.length > 0;
        for (const site of node.generated.jvmStructuredRegionCallSites) {
          if (!site.directBoundary) continue;
          if (!Array.isArray(site.directFieldWriteKeys)) {
            node.transitiveUnknownInstanceWrites = true;
            continue;
          }
          for (const key of site.directFieldWriteKeys) {
            node.transitiveInstanceWriteKeys.add(key);
          }
        }
      }
      let writeEffectsChanged = true;
      while (writeEffectsChanged) {
        writeEffectsChanged = false;
        for (const node of nodes) {
          for (const edge of node.edges) {
            if (!edge.node) continue;
            if (edge.node.transitiveUnknownInstanceWrites &&
                !node.transitiveUnknownInstanceWrites) {
              node.transitiveUnknownInstanceWrites = true;
              writeEffectsChanged = true;
            }
            for (const key of edge.node.transitiveInstanceWriteKeys) {
              if (node.transitiveInstanceWriteKeys.has(key)) continue;
              node.transitiveInstanceWriteKeys.add(key);
              writeEffectsChanged = true;
            }
          }
        }
      }
      const components = this.stronglyConnectedComponents(nodes);
      const recursiveComponents = components.filter((component) =>
        component.length > 1 || component[0].edges.some((edge) =>
          edge.node === component[0]));
      // The structured renderer already publishes a self-recursive restoring
      // scalar body for a singleton SCC. If that node has no outgoing region
      // edges except itself, capture that verified body as one local module
      // node. Larger or mutually recursive SCCs still require shared SSA and
      // remain outside this bounded backend.
      const standaloneRecursiveNodes = new Set(recursiveComponents
        .filter((component) => component.length === 1 &&
          component[0].edges.every((edge) => edge.node === component[0]) &&
          typeof component[0].generated
            .jvmRestoringDirectPositionalBody === "function")
        .map((component) => component[0]));
      for (const node of nodes) node.atomic = false;
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of nodes) {
          if (node.atomic || node.effects.throws || node.effects.allocates ||
              node.effects.synchronizes || node.effects.loops) continue;
          if (node.edges.every((edge) => edge.node?.atomic)) {
            node.atomic = true;
            changed = true;
          }
        }
      }
      const plan = {
        root: nodesByMethod.get(rootMethod),
        nodes,
        components,
        recursiveComponents,
        standaloneRecursiveNodes,
        totalCodeItems,
        closed: nodes.every((node) => node.boundaries.length === 0),
        guards: nodes.map((node) => ({
          method: node.method,
          generated: node.canonicalGenerated,
          owner: node.owner,
        })),
        entryCount: 0,
        deoptCount: 0,
        deoptReasons: new Map(),
        validatedGuardEpoch: -1,
        validatedClassInitializationEpoch: -1,
      };
      plan.guard = (thread = null, helpers = this.jit) => {
        const debug = this.jvm.debugManager;
        if (debug?.debugMode || debug?.breakpoints?.size > 0 ||
            this.jit.profileMethods || this.jit.profileTimings ||
            this.jit._envInstrumented ||
            thread && thread.status !== "runnable" ||
            helpers?.needsBytecodeChecks?.()) return false;
        // Loaded classes cannot become uninitialized, and generated Method/PIC
        // identities change only through the publication/feedback hooks above.
        // A continuation may enter this guard millions of times; one epoch
        // comparison preserves the exact proof without rescanning the graph.
        const classInitializationEpoch =
          this.jvm.classInitializationEpoch || 0;
        if (plan.validatedGuardEpoch === this.guardEpoch &&
            plan.validatedClassInitializationEpoch ===
              classInitializationEpoch) return true;
        for (const guard of plan.guards) {
          if (this.jit.codegenCache.get(guard.method) !== guard.generated ||
              this.jit.deoptedMethods.has(guard.method) ||
              guard.owner && this.jvm.classInitializationState.get(
                guard.owner) !== "INITIALIZED") return false;
        }
        for (const node of nodes) {
          for (const edge of node.edges) {
            if (edge.proof !== "runtime-monomorphic") continue;
            const dynamic = edge.runtimeSite?.fastDynamicTarget;
            if (dynamic?.target?.method !== edge.method ||
                dynamic.targetClassName !== edge.receiverType) return false;
          }
        }
        plan.validatedGuardEpoch = this.guardEpoch;
        plan.validatedClassInitializationEpoch = classInitializationEpoch;
        return true;
      };
      const loweredEdgeCount = nodes.reduce((count, node) => count +
        node.edges.filter((edge) => edge.node?.atomic &&
          edge.proof === "bytecode-exact").length, 0);
      const connectedEdgeCount = nodes.reduce((count, node) =>
        count + node.edges.filter((edge) => Boolean(edge.node)).length, 0);
      const targetEdgeCounts = new Map();
      for (const node of nodes) {
        for (const edge of node.edges) {
          targetEdgeCounts.set(edge.method,
            (targetEdgeCounts.get(edge.method) || 0) + 1);
        }
      }
      const repeatedEdgeCount = nodes.reduce((count, node) => count +
        node.edges.filter((edge) =>
          (targetEdgeCounts.get(edge.method) || 0) >= 2 &&
          edge.node?.codeItems <= 96).length, 0);
      plan.loweredEdgeCount = loweredEdgeCount;
      plan.connectedEdgeCount = connectedEdgeCount;
      plan.repeatedEdgeCount = repeatedEdgeCount;
      plan.backendEligible = recursiveComponents.every((component) =>
        component.length === 1 &&
          standaloneRecursiveNodes.has(component[0])) &&
        nodes.length > 1 &&
        connectedEdgeCount > 0;
      if (plan.backendEligible) {
        const hasPositionalRoot = Boolean(
          plan.root.generated.jvmDirectPositionalSource ||
          plan.root.generated.jvmRestoringDirectPositionalSource);
        plan.positionalBody = hasPositionalRoot
          ? this.compileModule(plan, false) : null;
        plan.framedBody = this.compileModule(plan, true);
        plan.body = plan.positionalBody || plan.framedBody;
        plan.lexicallyInlinedEdgeCount = Number((plan.positionalBody ||
          plan.framedBody)?.jvmHotCallGraphLexicallyInlinedEdgeCount || 0);
        plan.elidedFieldCacheInvalidationCount = Number((plan.positionalBody ||
          plan.framedBody)
          ?.jvmHotCallGraphElidedFieldCacheInvalidationCount || 0);
        plan.exceptionalInlinedEdgeCount = Number((plan.positionalBody ||
          plan.framedBody)?.jvmHotCallGraphExceptionalInlinedEdgeCount || 0);
        this.lexicallyInlinedEdgeCount += plan.lexicallyInlinedEdgeCount;
        this.exceptionalInlinedEdgeCount +=
          plan.exceptionalInlinedEdgeCount;
        this.compactInternalEdgeCount += Number((plan.positionalBody ||
          plan.framedBody)?.jvmHotCallGraphCompactInternalEdgeCount || 0);
        this.guardedInternalEdgeCount += Number((plan.positionalBody ||
          plan.framedBody)?.jvmHotCallGraphGuardedInternalEdgeCount || 0);
        plan.backendEligible = Boolean(plan.body);
        if (!plan.backendEligible) {
          this.rejectionCount += 1;
          this.recordRejection(rootMethod,
            this.lastRejectionReason || "region backend unavailable");
        }
      } else {
        plan.body = null;
        plan.positionalBody = null;
        plan.framedBody = null;
      }
      if (plan.root.generated) {
        plan.root.generated.jvmHotCallGraphRegionPlan = plan;
        plan.root.generated.jvmHotCallGraphBackendEligible =
          plan.backendEligible;
        plan.root.generated.jvmHotCallGraphFramedBody = plan.framedBody;
        plan.root.generated.jvmHotCallGraphDirectPositionalBody =
          plan.positionalBody;
        if (plan.backendEligible) {
          // Calls may have linked this method before receiver feedback closed
          // the region. Rebuild those adapters through the normal generated-
          // target publication path so they observe the jointly lowered
          // positional entry without embedding any caller or callee identity.
          this.jit.publishGeneratedTargetUpgrade(
            rootMethod, plan.root.generated, {regionEntryOnly: true});
        }
      }
      const summary = {
        root: plan.root.key,
        nodes: plan.nodes.length,
        atomicNodes: plan.nodes.filter((node) => node.atomic).length,
        connectedEdges: plan.connectedEdgeCount,
        // Every connected edge has its AST-declared raw target rebound to a
        // function in this module. `loweredEdges` is the narrower count where
        // the complete exception-restoration scaffold was also proven dead.
        locallyLinkedEdges: plan.connectedEdgeCount,
        loweredEdges: plan.loweredEdgeCount,
        scaffoldElidedEdges: plan.loweredEdgeCount,
        repeatedEdges: plan.repeatedEdgeCount,
        lexicallyInlinedEdges: plan.lexicallyInlinedEdgeCount || 0,
        exceptionalInlinedEdges: plan.exceptionalInlinedEdgeCount || 0,
        compactInternalEdges: Number((plan.positionalBody || plan.framedBody)
          ?.jvmHotCallGraphCompactInternalEdgeCount || 0),
        guardedInternalEdges: Number((plan.positionalBody || plan.framedBody)
          ?.jvmHotCallGraphGuardedInternalEdgeCount || 0),
        outlinedLoops: Number((plan.positionalBody || plan.framedBody)
          ?.jvmHotCallGraphOutlinedLoopCount || 0),
        partitionedSegments: Number((plan.positionalBody || plan.framedBody)
          ?.jvmHotCallGraphPartitionedSegmentCount || 0),
        outlinedLoopSourceBytes: Number((plan.positionalBody || plan.framedBody)
          ?.jvmHotCallGraphOutlinedLoopSourceBytes || 0),
        largestOutlinedLoopSourceBytes: Number(
          (plan.positionalBody || plan.framedBody)
            ?.jvmHotCallGraphLargestOutlinedLoopSourceBytes || 0),
        inlineAdmissionReasons: Object.entries((plan.positionalBody ||
          plan.framedBody)?.jvmHotCallGraphInlineAdmissionReasons || {})
          .map(([reason, count]) => ({reason, count})),
        elidedFieldCacheInvalidations:
          plan.elidedFieldCacheInvalidationCount || 0,
        boundaryEdges: plan.nodes.reduce((count, node) =>
          count + node.boundaries.length, 0),
        boundaryReasons: [...plan.nodes.reduce((counts, node) => {
          for (const boundary of node.boundaries) {
            counts.set(boundary.reason,
              (counts.get(boundary.reason) || 0) + 1);
          }
          return counts;
        }, new Map()).entries()].map(([reason, count]) => ({reason, count})),
        codeItems: plan.totalCodeItems,
        sourceBytes: (plan.positionalBody?.jvmHotCallGraphRegionSource.length ||
          0) + (plan.framedBody?.jvmHotCallGraphRegionSource.length || 0),
        runs: 0,
        deopts: 0,
        deoptReasons: [],
        sourceTracing: this.traceSource,
      };
      const tracedBody = plan.positionalBody || plan.framedBody;
      if (this.traceSource && tracedBody) {
        summary.source = tracedBody.jvmHotCallGraphRegionSource;
        summary.inlineAdmissionEdges =
          tracedBody.jvmHotCallGraphInlineAdmissionEdges || [];
        summary.inlineFailures =
          tracedBody.jvmHotCallGraphInlineFailures || [];
        summary.boundaries = plan.nodes.flatMap((node) =>
          node.boundaries.map((boundary) => ({
            caller: node.key,
            pc: boundary.pc,
            op: boundary.op,
            reason: boundary.reason,
            target: this.resolveMetadataEdge(boundary.site)?.method
              ? methodKey(this.jvm,
                this.resolveMetadataEdge(boundary.site).method) : null,
          })));
      }
      plan.summary = summary;
      this.registerPlanDependencies(plan);
      this.compiledRegionSummaries.push(summary);
      this.cache.set(rootMethod, plan);
      // Installing the region republishes the root's own generated target so
      // existing callers see its new entry. That publication is already
      // represented by this module and must not invalidate it again. A later
      // child/root tier-up occurs after this acknowledgement and will mark the
      // dependent graph dirty through markGeneratedTargetUpgrade().
      this.dirtyRoots.delete(rootMethod);
      this.lastExpansionAttempts.set(rootMethod,
        this.captureExpandableBoundaryStates(plan));
      this.compileCount += 1;
      return plan;
    } finally {
      this.compiling.delete(rootMethod);
    }
  }

  enter(plan, thread = null) {
    if (!plan || !plan.guard(thread, this.jit)) {
      this.guardFallbackCount += 1;
      return false;
    }
    this.runCount += 1;
    plan.entryCount += 1;
    if (this.profileRuns && plan.summary) plan.summary.runs += 1;
    return true;
  }
}

module.exports = HotCallGraphRegionCompiler;
// Exposed for structural tests; not a public API.
module.exports.partitionOversizedLinearBlocks =
  partitionOversizedLinearBlocks;
module.exports.outlineLargeRegionLoops = outlineLargeRegionLoops;
module.exports.liftOversizedUnitLocalsToEnvironment =
  liftOversizedUnitLocalsToEnvironment;
module.exports.splitModuleSourceForFactoryHoist =
  splitModuleSourceForFactoryHoist;
