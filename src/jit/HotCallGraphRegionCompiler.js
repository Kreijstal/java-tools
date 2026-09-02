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

function unionLinkedNames(...groups) {
  const merged = new Set();
  for (const group of groups) {
    if (!group) continue;
    if (Array.isArray(group)) {
      for (const nested of group) {
        if (!nested) continue;
        for (const name of nested) merged.add(name);
      }
      continue;
    }
    for (const name of group) merged.add(name);
  }
  return merged;
}

/**
 * Drop the region declarations no entry statement can reach.
 *
 * This is a walk over the compiler's own emission plan, not over emitted
 * text: every declaration entry carries the module-level names it was linked
 * against (`references`, recorded by `rewriteCallBindings` as it lowered each
 * call site and propagated through composed bodies), so reachability is a
 * list operation. `references` may over-approximate -- an over-approximation
 * only retains a declaration that could have been dropped, never unbinds a
 * name.
 */
function pruneUnreachableRegionDeclarations(declarations, rootNames) {
  const byName = new Map();
  for (const declaration of declarations) {
    if (declaration.name) byName.set(declaration.name, declaration);
  }
  const roots = [...rootNames].filter((name) => byName.has(name));
  if (!roots.length) return declarations;
  const reachable = new Set(roots);
  const pending = [...roots];
  while (pending.length) {
    const declaration = byName.get(pending.pop());
    for (const reference of declaration.references || []) {
      if (reachable.has(reference) || !byName.has(reference)) continue;
      reachable.add(reference);
      pending.push(reference);
    }
  }
  return declarations.filter((declaration) =>
    !declaration.name || reachable.has(declaration.name));
}

/**
 * Split an assembled region module plan into factory-scope declarations and a
 * per-call entry.
 *
 * Every module-level helper is parameter-complete by construction (helpers,
 * arguments, thread, and state arrays all arrive as parameters), so the
 * function declarations never capture per-invocation bindings and can be
 * instantiated once in the enclosing factory instead of on every module
 * entry.  The protocol state arrays (`const jvmRegionSegmentState* = []`)
 * that the linear partitioner prepends to the declaration region are also
 * safe to share across invocations: every segment writes its outcome only in
 * its terminal epilogue and the caller consumes it immediately after the call
 * returns, so no guest call, scheduler yield, or re-entrant module invocation
 * can interleave between a write and its read.
 *
 * The split is a choice between two text regions the compiler assembled
 * itself, not a recovery of top-level statement boundaries from the emitted
 * module: `plan.hoistedSource` is the declaration region, `plan.entrySources`
 * are the per-invocation statements in emission order, and
 * `plan.entryDeclaredNames` are the bindings those statements introduce.
 *
 * A declaration evaluated once in the factory cannot close over a binding
 * that is created again on every entry, so any entry-scope binding aborts the
 * split and the module keeps its per-invocation shape. The fused module's
 * safe-point counter (`let safePointBudget = N;`) is exactly such a binding
 * and every node function reads it -- stage C made the module own that
 * counter deliberately -- so the hoist is not taken for a region module as it
 * is emitted today. The predicate is kept structural rather than deleted so
 * that removing the module-scoped counter re-enables the hoist without
 * reintroducing a parse.
 */
function splitRegionModuleForFactoryHoist(plan) {
  const hoistedSource = plan?.hoistedSource;
  const entrySources = (plan?.entrySources || []).filter(Boolean);
  if (typeof hoistedSource !== "string" || !hoistedSource.trim()) return null;
  if (!entrySources.length) return null;
  if ((plan.entryDeclaredNames || []).length) return null;
  return {
    hoistedSource,
    entrySource: entrySources.join("\n"),
    hoistedCount: Math.max(0, Number(plan.hoistedCount) || 0),
  };
}

/**
 * Structured region bodies.
 *
 * The renderer publishes each positional body as an ordered list of
 * fragments, and each fragment as the statement records its emitter built:
 * the parts list, the operand names the statement reads and writes, the block
 * nesting it opens or closes, the label it introduces, the jump it is, and
 * how a `return` it carries splits around its returned value. The emitter
 * states all of that; none of it is recovered from the emitted text. The three structural
 * passes below -- loop outlining, environment lifting and straight-line
 * partitioning -- are selections and rewrites over those records.
 *
 * Nothing here reads emitted JavaScript. A statement is relocated by moving
 * its record; a statement is rewritten by substituting operand references in
 * its parts list and rendering it again, which is the same operation the
 * renderer's own passes perform through `rerenderStatement`; and a statement
 * this compiler emits itself states its own facts, because it wrote the text.
 */

// Render a published parts list. A reference may render as something other
// than its name while a later stage still owns it, exactly as in the
// renderer.
function renderRegionParts(parts) {
  let text = "";
  for (const part of parts) {
    text += typeof part === "string" ? part
      : part.label !== undefined ? part.label
        : part.text !== undefined ? part.text : part.ref;
  }
  return text;
}

// Replace operand references by parts lists. This is the only way one of
// these passes rewrites a statement.
function substituteRegionParts(parts, replacements) {
  const out = [];
  for (const part of parts) {
    // A label part names a statement, not a value: no operand substitution
    // replaces one.
    if (typeof part === "string" || part.label !== undefined) {
      out.push(part);
      continue;
    }
    const replacement = replacements.get(part.ref);
    if (replacement === undefined) { out.push(part); continue; }
    for (const piece of replacement) out.push(piece);
  }
  return out;
}

const REGION_STATEMENT_DEFAULTS = {
  parts: null, kind: "regionOwned", def: null, write: null, delta: 0,
  writes: null,
  label: null, jump: null, exit: null, yields: false, opens: null,
  continuesBlock: false, relocatable: true,
  // Extra names one emitted statement introduces beyond `def`: the call-site
  // `let a, b;` a hoisted run declaration becomes.
  declares: null,
};

/**
 * A statement this compiler emits itself.
 *
 * The caller states what the statement reads, writes and opens because it
 * built the text from its own templates; none of it is recovered from the
 * characters. `reads: null` marks a statement whose names are unknown -- the
 * opaque result of a composition edit -- and disqualifies every region that
 * contains it.
 */
function ownStatement(text, facts = {}) {
  const trimmedStart = text.length - text.trimStart().length;
  return {
    ...REGION_STATEMENT_DEFAULTS,
    ...facts,
    text,
    indent: text.slice(0, trimmedStart),
    reads: facts.reads === null ? null : facts.reads || [],
    writes: facts.writes || (facts.write ? [facts.write] : []),
  };
}

// Statement text with an operand substitution applied. Indentation is applied
// by the assembler and is not part of a statement's identity, so it is
// re-attached to the re-rendered statement.
function renderRegionStatement(statement, replacements = null) {
  if (!statement.parts || !replacements || replacements.size === 0) {
    return statement.text;
  }
  return `${statement.indent}${renderRegionParts(
    substituteRegionParts(statement.parts, replacements)).trim()}`;
}

/**
 * The top-level statements of a statement list.
 *
 * A statement that opens a block owns every statement up to its matching
 * close, and a block continuation (`} else {`, `} catch (error) {`) keeps the
 * construct it continues inside the same group -- its nesting delta is zero,
 * so the walk needs no special case for it. Returns null when the deltas the
 * emitters recorded do not balance, which makes every pass decline the body
 * rather than guess at its structure.
 */
function statementGroups(statements, from = 0, to = statements.length) {
  const groups = [];
  let index = from;
  while (index < to) {
    const start = index;
    let depth = statements[index].delta;
    if (depth < 0) return null;
    index += 1;
    while (depth > 0 && index < to) {
      depth += statements[index].delta;
      if (depth < 0) return null;
      index += 1;
    }
    if (depth !== 0) return null;
    groups.push({start, end: index});
  }
  return groups;
}

function statementBytes(statements, from, to) {
  let bytes = 0;
  for (let index = from; index < to; index += 1) {
    bytes += statements[index].text.length + 1;
  }
  return bytes > 0 ? bytes - 1 : 0;
}

/**
 * The block scope each statement of a range sits in.
 *
 * A statement belongs to the scope that is open before it runs, and the
 * nesting it opens or closes -- the delta its emitter recorded -- starts and
 * ends the scopes inside it. A block continuation (`} else {`, `} catch (e)
 * {`) ends one scope and starts a sibling of it, which its zero delta does
 * not say on its own.
 *
 * Returns null when the deltas do not balance over the range, which makes
 * every caller decline it rather than guess at its structure.
 */
function regionScopes(statements, from, to) {
  const parents = [null];
  const scopeOf = [];
  const stack = [0];
  for (let index = from; index < to; index += 1) {
    const statement = statements[index];
    scopeOf.push(stack[stack.length - 1]);
    const delta = statement.delta;
    if (delta > 0) {
      for (let step = 0; step < delta; step += 1) {
        parents.push(stack[stack.length - 1]);
        stack.push(parents.length - 1);
      }
    } else if (delta < 0) {
      for (let step = 0; step < -delta; step += 1) {
        if (stack.length <= 1) return null;
        stack.pop();
      }
    } else if (statement.continuesBlock && stack.length > 1) {
      // The arm this statement opens is a sibling of the one it closes, so a
      // name the previous arm declared is not in scope in it.
      const parent = parents[stack[stack.length - 1]];
      stack.pop();
      parents.push(parent);
      stack.push(parents.length - 1);
    }
  }
  if (stack.length !== 1) return null;
  return {parents, scopeOf};
}

/**
 * The names a statement range introduces, reads from an enclosing scope and
 * assigns there, in first-appearance order.
 *
 * Declarations are resolved by block scope, not by a flat name set. A body a
 * composition spliced a callee into carries the callee's own `local<slot>` /
 * `ssaValue<n>` declarations inside a nested block, where they *shadow* the
 * caller's names of the same spelling rather than colliding with them; a flat
 * set would report such a name as bound for the whole range and hand a
 * relocated statement the wrong binding -- or, for a name the callee alone
 * declares, hand the call site a parameter that does not exist there.
 *
 * Returns null when the range contains a statement whose names are unknown or
 * that may not be relocated, or when its nesting does not balance: a region
 * whose free-variable set cannot be stated exactly is never extracted.
 */
function regionNames(statements, from, to) {
  const scopes = regionScopes(statements, from, to);
  if (!scopes) return null;
  const declaredIn = new Map();
  for (let index = from; index < to; index += 1) {
    const statement = statements[index];
    if (!statement.relocatable || statement.reads === null) return null;
    const scope = scopes.scopeOf[index - from];
    for (const name of [...(statement.def ? [statement.def] : []),
      ...(statement.declares || [])]) {
      if (!declaredIn.has(name)) declaredIn.set(name, new Set());
      declaredIn.get(name).add(scope);
    }
  }
  // A name is bound where it is used when some scope enclosing that use
  // declares it. The range's own scope is 0, so a name declared there is
  // bound everywhere in the range, exactly as before.
  const boundAt = (name, scope) => {
    const sites = declaredIn.get(name);
    if (!sites) return false;
    for (let at = scope; at !== null; at = scopes.parents[at]) {
      if (sites.has(at)) return true;
    }
    return false;
  };
  const declared = new Set(
    [...declaredIn.keys()].filter((name) => declaredIn.get(name).has(0)));
  const free = [];
  const seen = new Set();
  const written = new Set();
  for (let index = from; index < to; index += 1) {
    const statement = statements[index];
    const scope = scopes.scopeOf[index - from];
    for (const name of statement.reads) {
      if (boundAt(name, scope) || seen.has(name)) continue;
      seen.add(name);
      free.push(name);
    }
    for (const write of statement.writes || []) {
      if (boundAt(write, scope)) continue;
      written.add(write);
      if (seen.has(write)) continue;
      seen.add(write);
      free.push(write);
    }
  }
  return {declared, free, written};
}

// The labels a statement range introduces.
function regionLabels(statements, from, to) {
  const labels = new Set();
  for (let index = from; index < to; index += 1) {
    if (statements[index].label) labels.add(statements[index].label);
  }
  return labels;
}

/**
 * Every jump in a statement range that leaves it.
 *
 * A labeled jump targets an enclosing label, so it stays inside the range
 * exactly when the range introduces that label. An unlabeled jump binds to
 * the innermost loop or switch, so it stays inside when the statement sits
 * below one the range contains. `null` is returned when the range carries a
 * jump the emitter did not write in a relocatable shape.
 */
function regionOutwardJumps(statements, from, to) {
  const labels = regionLabels(statements, from, to);
  const jumps = [];
  let loopDepth = 0;
  let breakableDepth = 0;
  const openings = [];
  for (let index = from; index < to; index += 1) {
    const statement = statements[index];
    if (statement.jump) {
      const outward = statement.jump.label
        ? !labels.has(statement.jump.label)
        : (statement.jump.kind === "break"
          ? breakableDepth === 0 : loopDepth === 0);
      if (outward) jumps.push({index, ...statement.jump});
    }
    for (let step = 0; step < statement.delta; step += 1) {
      openings.push(step === 0 ? statement.opens : "block");
      if (statement.opens === "loop" && step === 0) {
        loopDepth += 1;
        breakableDepth += 1;
      } else if (statement.opens === "switch" && step === 0) {
        breakableDepth += 1;
      }
    }
    for (let step = 0; step < -statement.delta; step += 1) {
      const opened = openings.pop();
      if (opened === "loop") { loopDepth -= 1; breakableDepth -= 1; }
      else if (opened === "switch") breakableDepth -= 1;
    }
  }
  return jumps;
}

/**
 * Re-establish, through a helper's protocol, every `return` a relocated
 * statement range carries.
 *
 * Each such statement published how it splits around its own `return`: the
 * parts before it, its returned value's parts, and the parts after it. The
 * exit becomes a block that records the outcome and leaves the helper, spliced
 * back between those two halves -- so an exit the emitter wrote as the
 * consequent of a one-line guard stays that guard's consequent. Returns null
 * when the range carries an exit in a shape the emitter did not publish.
 */
function rewriteRegionExits(statements, from, to, buildExit) {
  const rewritten = [];
  for (let index = from; index < to; index += 1) {
    const statement = statements[index];
    if (!statement.exit) { rewritten.push(statement); continue; }
    const argument = statement.exit.value
      ? renderRegionParts(statement.exit.value) : "undefined";
    const text = `${renderRegionParts(statement.exit.before)}${
      buildExit(argument)}${renderRegionParts(statement.exit.after)}`;
    rewritten.push(ownStatement(`${statement.indent}${text.trim()}`, {
      reads: statement.reads,
      delta: statement.delta,
      relocatable: false,
    }));
  }
  return rewritten;
}

function regionRangeCarriesYield(statements, from, to) {
  for (let index = from; index < to; index += 1) {
    if (statements[index].yields) return true;
  }
  return false;
}

/**
 * A compilation unit the structural passes rewrite: a function the region
 * compiler emits, its body held as the statement records the renderer
 * published for it.
 */
function regionUnit(fields) {
  return {
    name: fields.name || null,
    headerLines: fields.headerLines || [],
    footerLines: fields.footerLines || [],
    statements: fields.statements || [],
    generator: fields.generator === true,
    partitionable: fields.partitionable !== false,
  };
}

// A module region the compiler emits as finished text: it holds no statement
// records and no pass touches it.
function rawRegionUnit(text) {
  return regionUnit({headerLines: [text], partitionable: false});
}

function renderRegionUnit(unit) {
  return [
    ...unit.headerLines,
    ...unit.statements.map((statement) => statement.text),
    ...unit.footerLines,
  ].join("\n");
}

function regionUnitBytes(unit) {
  return renderRegionUnit(unit).length;
}

/**
 * The statement records of one published positional body.
 *
 * The renderer publishes the body as fragments and each fragment as the
 * records behind its lines, so the flat statement list is a concatenation.
 * The `'use strict';` directive is the one line the region compiler keeps
 * outside the fragments, and the joined result is checked against the source
 * the compiler is about to emit: a body whose records do not reproduce it
 * exactly publishes nothing usable and every pass declines it.
 */
function regionStatementsFromFragments(source, fragments) {
  if (typeof source !== "string" || !Array.isArray(fragments)) return null;
  const statements = [];
  if (source.startsWith(REGION_SOURCE_DIRECTIVE)) {
    statements.push(ownStatement(REGION_SOURCE_DIRECTIVE.trimEnd(),
      {kind: "directive"}));
  }
  for (const fragment of fragments) {
    if (!Array.isArray(fragment.statements)) return null;
    for (const statement of fragment.statements) statements.push(statement);
  }
  return statements.map((statement) => statement.text).join("\n") === source
    ? statements : null;
}

const REGION_SOURCE_DIRECTIVE = "'use strict';\n";

// Which published positional variant a node body came from, so its fragments
// can be looked up. The comparison is on identity with the string the
// renderer published, never on the body's content.
function variantNameOfSource(generated, source) {
  if (source === generated.jvmDirectPositionalSource) {
    return "jvmDirectPositionalSource";
  }
  if (source === generated.jvmInternalRegionPositionalSource) {
    return "jvmInternalRegionPositionalSource";
  }
  if (source === generated.jvmRestoringDirectPositionalSource) {
    return "jvmRestoringDirectPositionalSource";
  }
  return null;
}

/**
 * Keep a body's statement records in step with the edits that lowered its
 * call sites.
 *
 * `rewriteCallBindings` links a node by splicing text it built itself into
 * spans the renderer delimited with compiler-owned markers. The same edits
 * are applied here to the statement list: a statement an edit rewrote, and
 * every statement a multi-line edit spanned, become one opaque record whose
 * names are unknown, so no later pass relocates it or anything containing
 * it. An edit that deletes a statement outright -- an eliminated call binding
 * or a dropped run counter -- leaves an empty record instead, which is exactly
 * as relocatable as the blank line it emits.
 *
 * A merged record keeps the nesting delta of the statements it replaced: a
 * lowered call span and its replacement are both complete constructs. If that
 * ever stopped holding, the deltas would no longer balance and
 * `statementGroups` would decline the body rather than mis-group it.
 *
 * The rewritten text is the caller's own result, so the record's new text is
 * the slice of it the block now occupies rather than a second splice.
 */
function applyRegionStatementEdits(statements, edits, rewrittenSource) {
  if (!statements) return null;
  if (!edits.length) return statements;
  const starts = [];
  let cursor = 0;
  for (const statement of statements) {
    starts.push(cursor);
    cursor += statement.text.length + 1;
  }
  const endOf = (index) => starts[index] + statements[index].text.length;
  const locate = (offset) => {
    let low = 0;
    let high = statements.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (offset < starts[middle]) high = middle - 1;
      else if (offset > endOf(middle)) low = middle + 1;
      else return middle;
    }
    return -1;
  };
  // The blocks of statements the edits touch, with the offset each one moves
  // to in the rewritten text. Nothing is spliced a second time: the caller
  // already applied these edits, so a block's new text is the slice of that
  // result the block now occupies.
  const blocks = [];
  let shift = 0;
  for (const edit of [...edits].sort((left, right) =>
    left.start - right.start)) {
    const first = locate(edit.start);
    const last = locate(edit.end);
    if (first < 0 || last < 0 || last < first) return null;
    const growth = edit.replacement.length - (edit.end - edit.start);
    const previous = blocks[blocks.length - 1];
    if (previous && previous.last >= first) {
      previous.last = Math.max(previous.last, last);
      previous.growth += growth;
    } else {
      blocks.push({first, last, shift, growth});
    }
    shift += growth;
  }
  const output = [];
  let index = 0;
  for (const block of blocks) {
    while (index < block.first) output.push(statements[index++]);
    const from = starts[block.first] + block.shift;
    const to = endOf(block.last) + block.shift + block.growth;
    if (from < 0 || to < from || to > rewrittenSource.length) return null;
    const text = rewrittenSource.slice(from, to);
    let delta = 0;
    for (let entry = block.first; entry <= block.last; entry += 1) {
      delta += statements[entry].delta;
    }
    output.push(text.trim() === ""
      ? ownStatement(text, {delta})
      : ownStatement(text, {delta, reads: null, relocatable: false}));
    index = block.last + 1;
  }
  while (index < statements.length) output.push(statements[index++]);
  return output;
}

/**
 * Remove the renderer's exact per-method safe-point budget declarations.
 *
 * A fused graph is one scheduler execution unit, so every node closes over
 * the module-owned counter instead of resetting the quantum at each internal
 * edge. The declaration is removed by the exact text the renderer published
 * for it, from the statement that carries it.
 */
function stripRegionSafePointBudgets(statements, declarations) {
  if (!declarations || !declarations.length) return statements;
  return statements.map((statement) => {
    let text = statement.text;
    for (const declaration of declarations) {
      text = text.split(declaration).join("");
    }
    if (text === statement.text) return statement;
    return ownStatement(text, {
      delta: statement.delta,
      reads: text.trim() === "" ? [] : null,
      relocatable: text.trim() === "",
    });
  });
}

/**
 * Split oversized structured loops into ordinary nested JavaScript functions.
 *
 * The renderer has already proved the Java CFG and SSA joins before this pass
 * runs. A nested function therefore keeps scalar locals as lexical bindings,
 * while V8/SpiderMonkey receive a separate optimization unit for the loop.
 * Java returns are explicitly forwarded to the containing region.
 *
 * A loop is a fragment the renderer published, and the names crossing its
 * boundary are the ones its statements recorded, so the pass selects loops
 * and joins statements; it never recovers a loop from emitted text. A loop
 * whose statements are not all relocatable -- an exit the emitter wrote in an
 * unrecognized shape, an opaque range a composition edit produced, a nested
 * function whose captures extraction would rebind -- is left alone.
 */
function outlineLargeRegionLoops(unit, options = {}) {
  const minimumSourceBytes = Math.max(512,
    Number(options.minimumSourceBytes) || 32768);
  const maximumOutlines = Math.max(0,
    Math.min(64, Number(options.maximumOutlines) || 16));
  const numericNamespace = Number(options.namespace);
  const namespace = Number.isSafeInteger(numericNamespace) &&
    numericNamespace >= 0 ? String(numericNamespace) : "0";
  const empty = {
    unit, helpers: [], count: 0, outlinedSourceBytes: 0,
    largestOutlinedSourceBytes: 0,
  };
  if (!unit || !Array.isArray(unit.statements)) return empty;
  let statements = unit.statements;
  const sharedStateName = `jvmRegionOutlinedState${namespace}`;
  const generator = unit.generator === true;
  const helpers = [];
  const helperNames = new Set();
  let outlineCount = 0;
  let outlinedSourceBytes = 0;
  let largestOutlinedSourceBytes = 0;

  // Every loop in the body, innermost last, with the range it occupies.
  const collectLoops = (from, to, into) => {
    const groups = statementGroups(statements, from, to);
    if (!groups) return false;
    for (const group of groups) {
      const head = statements[group.start];
      if (head.opens === "loop") into.push(group);
      if (group.end - group.start > 2) {
        if (!collectLoops(group.start + 1, group.end - 1, into)) return false;
      }
    }
    return true;
  };

  while (outlineCount < maximumOutlines) {
    const loops = [];
    if (!collectLoops(0, statements.length, loops)) break;
    const candidates = loops.filter((loop) =>
      statementBytes(statements, loop.start, loop.end) >= minimumSourceBytes);
    if (!candidates.length) break;
    // Rewrite only candidates that contain no other candidate: the next round
    // sees the new helper call in place of the inner loop and may then split
    // its parent, which keeps every edit non-overlapping.
    const innermost = candidates.filter((candidate) => !candidates.some(
      (other) => other !== candidate &&
        other.start >= candidate.start && other.end <= candidate.end &&
        (other.start !== candidate.start || other.end !== candidate.end)));
    const edits = [];
    for (const candidate of innermost.slice(
      0, maximumOutlines - outlineCount)) {
      const names = regionNames(statements, candidate.start, candidate.end);
      if (!names) continue;
      const outward = regionOutwardJumps(
        statements, candidate.start, candidate.end);
      if (outward.length) continue;
      const hasYield = regionRangeCarriesYield(
        statements, candidate.start, candidate.end);
      if (hasYield && !generator) continue;

      const id = outlineCount;
      const helperName = `jvmRegionOutlinedLoop${namespace}_${id}`;
      const caughtName = `jvmRegionOutlinedError${namespace}_${id}`;
      const outputName = `jvmRegionOutlinedOutput${namespace}_${id}`;
      // Generated SSA names are unique within the containing function, so a
      // positional live-in ABI is exact: every free name becomes a parameter
      // and every free name the range assigns is written back. The helpers
      // this pass emits are module-level and need no parameter; the shared
      // state array is declared inside the body, so an outer loop that
      // encloses an earlier helper's call site does receive it.
      const freeNames = names.free.filter((name) => !helperNames.has(name));
      const liveOutNames = freeNames.filter((name) => names.written.has(name));
      const body = rewriteRegionExits(statements, candidate.start,
        candidate.end, (argument) => [
          `{ ${outputName}[0] = 1;`,
          `${outputName}[1] = ${argument};`,
          ...liveOutNames.map((name, index) =>
            `${outputName}[${index + 2}] = ${name};`),
          "return; }",
        ].join(" "));
      outlineCount += 1;
      helperNames.add(helperName);
      helpers.push(regionUnit({
        name: helperName,
        generator: hasYield,
        headerLines: [
          `function${hasYield ? "*" : ""} ${helperName}(${[
            ...freeNames, outputName].join(",")}) {`,
          "  try {",
        ],
        statements: [
          ...body.map((statement) => ownStatement(
            `    ${statement.text}`, {
              reads: statement.reads, write: statement.write,
              writes: statement.writes,
              def: statement.def, delta: statement.delta,
              label: statement.label, jump: statement.jump,
              opens: statement.opens, yields: statement.yields,
              continuesBlock: statement.continuesBlock,
              parts: statement.parts, kind: statement.kind,
              declares: statement.declares,
              relocatable: statement.relocatable,
            })),
          ownStatement(`    ${outputName}[0] = 0;`),
          ownStatement(`    ${outputName}[1] = undefined;`),
          ...liveOutNames.map((name, index) => ownStatement(
            `    ${outputName}[${index + 2}] = ${name};`)),
        ],
        footerLines: [
          `  } catch (${caughtName}) {`,
          `    ${outputName}[0] = 2;`,
          `    ${outputName}[1] = ${caughtName};`,
          ...liveOutNames.map((name, index) =>
            `    ${outputName}[${index + 2}] = ${name};`),
          "  }",
          "}",
        ],
      }));
      const callReads = [...freeNames, sharedStateName, helperName];
      edits.push({
        start: candidate.start,
        end: candidate.end,
        replacement: [
          ownStatement("{", {delta: 1, opens: "block", reads: callReads}),
          ownStatement(`  ${hasYield ? "yield* " : ""}${helperName}(${[
            ...freeNames, sharedStateName].join(",")});`,
          {reads: callReads, yields: hasYield}),
          ...liveOutNames.map((name, index) => ownStatement(
            `  ${name} = ${sharedStateName}[${index + 2}];`,
            {reads: [sharedStateName], write: name})),
          ownStatement(
            `  if (${sharedStateName}[0] === 1) return ${sharedStateName}[1];`,
            {
              reads: [sharedStateName],
              exit: {
                before: [`if (${sharedStateName}[0] === 1) `],
                value: [`${sharedStateName}[1]`],
                after: [],
              },
            }),
          ownStatement(
            `  if (${sharedStateName}[0] === 2) throw ${sharedStateName}[1];`,
            {reads: [sharedStateName]}),
          ownStatement("}", {delta: -1}),
        ],
      });
      const bytes = statementBytes(statements, candidate.start, candidate.end);
      outlinedSourceBytes += bytes;
      largestOutlinedSourceBytes = Math.max(
        largestOutlinedSourceBytes, bytes);
    }
    if (!edits.length) break;
    const next = statements.slice();
    for (const edit of [...edits].sort((left, right) =>
      right.start - left.start)) {
      next.splice(edit.start, edit.end - edit.start, ...edit.replacement);
    }
    statements = next;
  }
  if (outlineCount === 0) return empty;
  return {
    unit: regionUnit({
      ...unit,
      statements: [
        ownStatement(`const ${sharedStateName} = [];`,
          {kind: "const", def: sharedStateName}),
        ...statements,
      ],
    }),
    helpers,
    count: outlineCount,
    outlinedSourceBytes,
    largestOutlinedSourceBytes,
  };
}

/**
 * Rewrite the stable function-scoped locals of oversized units into one
 * per-invocation environment array.
 *
 * A framed region body declares hundreds of call-site caches and scalar
 * locals at its top level that are referenced throughout; partitioning such a
 * body under a positional ABI re-plumbs that whole name set through every
 * segment boundary and grows the source faster than it shrinks the units.
 * After this pass a segment's free-name set collapses to the environment
 * array plus the unit parameters.
 *
 * The names come from the renderer's published declaration list, and a
 * reference is rewritten by substituting the operand in the statement's own
 * parts list and rendering it again -- the same operation the renderer
 * performs on its own statements. Only names declared exactly once in the
 * unit's top statement list are lifted, so per-iteration block scoping is
 * never disturbed. Lifting a `const` into a mutable slot is safe because
 * generated code never reassigns and never relies on TDZ.
 */
function liftOversizedUnitLocalsToEnvironment(units, options = {}) {
  const maximumUnitBytes = Math.max(16384,
    Number(options.maximumUnitBytes) || 49152);
  const namespace = String(options.namespace ?? "0")
    .replace(/[^A-Za-z0-9_]/g, "") || "0";
  let liftedNames = 0;
  let liftedUnits = 0;
  const rewrittenUnits = units.map((unit, unitIndex) => {
    if (!unit.partitionable || !unit.statements.length) return unit;
    if (regionUnitBytes(unit) <= maximumUnitBytes) return unit;
    const envName = `jvmRegionEnv${namespace}_${unitIndex}`;
    const groups = statementGroups(unit.statements);
    if (!groups) return unit;
    // One declaration site per name across the whole unit, or it stays local;
    // and every statement has to be rewritable, or a reference could be left
    // spelled the old way.
    const declarationCounts = new Map();
    for (const statement of unit.statements) {
      if (!statement.parts || statement.reads === null) return unit;
      if (statement.def) {
        declarationCounts.set(statement.def,
          (declarationCounts.get(statement.def) || 0) + 1);
      }
    }
    const slotIndex = new Map();
    for (const group of groups) {
      if (group.end !== group.start + 1) continue;
      const statement = unit.statements[group.start];
      if (statement.kind !== "const" && statement.kind !== "let" &&
          statement.kind !== "letUninitialized" &&
          statement.kind !== "safePointBudgetDeclaration") continue;
      if (!statement.def || statement.def === envName) continue;
      if (declarationCounts.get(statement.def) !== 1) continue;
      if (!slotIndex.has(statement.def)) {
        slotIndex.set(statement.def, slotIndex.size);
      }
    }
    if (!slotIndex.size) return unit;
    const replacements = new Map();
    for (const [name, slot] of slotIndex) {
      replacements.set(name, [`${envName}[${slot}]`]);
    }
    const rewritten = [];
    for (const statement of unit.statements) {
      if (slotIndex.has(statement.def)) {
        // The declaration becomes an in-place slot assignment: the
        // initializer keeps its own operands, which the same substitution
        // rewrites.
        const initializer = statement.parts.slice(
          statement.parts.findIndex((part) =>
            typeof part !== "string" && part.ref === statement.def) + 1);
        const assignment = renderRegionParts(
          substituteRegionParts(initializer, replacements)).trim();
        rewritten.push(ownStatement(`${statement.indent}${
          assignment.startsWith("=")
            ? `${envName}[${slotIndex.get(statement.def)}] ${assignment}`
            : ";"}`, {
          reads: [...statement.reads.filter((name) => !slotIndex.has(name)),
            envName],
          writes: (statement.writes || []).filter(
            (name) => !slotIndex.has(name)),
          delta: statement.delta,
        }));
        continue;
      }
      const text = renderRegionStatement(statement, replacements);
      if (text === statement.text) { rewritten.push(statement); continue; }
      rewritten.push({
        ...statement,
        text,
        parts: substituteRegionParts(statement.parts, replacements),
        // A statement's published exit split is derived from its parts, so it
        // is substituted with them: a later partition of this unit splices the
        // lifted argument, not the name it used to be spelled with.
        exit: statement.exit ? {
          before: substituteRegionParts(statement.exit.before, replacements),
          value: statement.exit.value
            ? substituteRegionParts(statement.exit.value, replacements)
            : null,
          after: substituteRegionParts(statement.exit.after, replacements),
        } : null,
        def: statement.def,
        write: slotIndex.has(statement.write) ? null : statement.write,
        writes: (statement.writes || []).filter(
          (name) => !slotIndex.has(name)),
        reads: [...statement.reads.filter((name) => !slotIndex.has(name)),
          envName],
      });
    }
    liftedNames += slotIndex.size;
    liftedUnits += 1;
    // A directive prologue has to stay first, or the body silently stops
    // being strict.
    const prologue = rewritten.length && rewritten[0].kind === "directive"
      ? 1 : 0;
    return regionUnit({
      ...unit,
      statements: [
        ...rewritten.slice(0, prologue),
        ownStatement(`const ${envName} = new Array(${
          slotIndex.size}).fill(undefined);`,
        {kind: "const", def: envName}),
        ...rewritten.slice(prologue),
      ],
    });
  });
  if (!liftedNames) return {units, liftedNames: 0, liftedUnits: 0};
  return {units: rewrittenUnits, liftedNames, liftedUnits};
}

/**
 * Partition oversized straight-line statement runs into helper functions.
 *
 * outlineLargeRegionLoops splits at loop granularity; region bodies dominated
 * by flat statement bulk (thousands of small statements plus embedded
 * conditionals) still exceed the engines' per-function optimization budgets.
 * This pass walks every unit whose executable self-size exceeds
 * maximumUnitBytes and extracts maximal consecutive statement runs into
 * module-level helpers with the loop outliner's positional live-in/live-out
 * ABI. A run executes exactly once per arrival at its block position, so the
 * call overhead is amortized over ~targetSegmentBytes of straight-line work.
 * A statement larger than a segment recurses into its own nested statement
 * lists, innermost lists partitioning first.
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
 *  - a run carrying a statement that may not be relocated is rejected: an
 *    exit in a shape the emitter did not publish, a nested function whose
 *    captures extraction would rebind, or an opaque range a composition edit
 *    produced.
 */
function partitionOversizedLinearBlocks(units, options = {}) {
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
  let segmentCount = 0;
  let partitionedSourceBytes = 0;
  let attemptedRuns = 0;
  let oversizedStatements = 0;
  const helperUnits = [];
  const working = units.slice();

  for (let round = 0; round < maximumRounds &&
    segmentCount < maximumSegments; round += 1) {
    let roundChanged = false;
    for (let unitIndex = 0; unitIndex < working.length; unitIndex += 1) {
      const unit = working[unitIndex];
      if (!unit.partitionable || !unit.statements.length) continue;
      if (regionUnitBytes(unit) <= maximumUnitBytes) continue;
      const statements = unit.statements;
      const edits = [];

      const tryExtractRun = (from, to, topLevelStarts) => {
        if (segmentCount >= maximumSegments) return;
        attemptedRuns += 1;
        if (process.env.JVM_DEBUG_PARTITION === "1") {
          console.error("[partition] round=" + round + " seg=" + segmentCount +
            " stmts=" + (to - from) +
            " span=" + statementBytes(statements, from, to));
        }
        const names = regionNames(statements, from, to);
        if (!names) return;
        const outward = regionOutwardJumps(statements, from, to);
        const runHasYield = regionRangeCarriesYield(statements, from, to);
        if (runHasYield && !unit.generator) return;

        // A run-level declaration whose binding is read after the run has to
        // survive the extraction: it is declared at the call site and written
        // back, and the helper assigns it instead of declaring it.
        const hoistNames = [];
        for (const index of topLevelStarts) {
          const statement = statements[index];
          if (statement.kind !== "const" && statement.kind !== "let" &&
              statement.kind !== "letUninitialized" &&
              statement.kind !== "safePointBudgetDeclaration") continue;
          // A declaration introduces `def`, or the list of names an
          // uninitialized multi-name declaration the compiler emitted itself
          // carries.
          const introduced = statement.def
            ? [statement.def] : statement.declares || [];
          if (!introduced.length) continue;
          let escapes = false;
          for (let other = 0; other < statements.length && !escapes; other++) {
            if (other >= from && other < to) continue;
            const outside = statements[other];
            if (outside.reads === null) { escapes = true; break; }
            escapes = introduced.some((name) =>
              outside.reads.includes(name) ||
              (outside.writes || []).includes(name));
          }
          if (escapes) hoistNames.push(...introduced);
        }

        const freeNames = names.free.filter((name) =>
          name !== sharedStateName);
        const liveOutNames = [
          ...freeNames.filter((name) => names.written.has(name)),
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
        // Protocol exits jump to the shared epilogue rather than inlining the
        // live-out write-back: a run with many exits and many live-outs would
        // otherwise re-grow past the optimization budget the pass exists to
        // meet.
        const outwardIndexes = new Map(
          outward.map((jump) => [jump.index, jump]));
        const hoistNameSet = new Set(hoistNames);
        const body = [];
        for (const statement of rewriteRegionExits(statements, from, to,
          (argument) => [
            `{ ${outputName}[0] = 1;`,
            `${outputName}[1] = ${argument};`,
            `break ${bodyLabel}; }`,
          ].join(" "))) {
          body.push(statement);
        }
        for (let index = from; index < to; index += 1) {
          const position = index - from;
          const jump = outwardIndexes.get(index);
          if (jump) {
            // The jump is re-established at the call site, which occupies the
            // run's original block position and therefore sees the identical
            // label environment. Inside the helper it becomes a table index,
            // spliced into the statement between the parts the emitter
            // published around its own jump.
            const statement = statements[index];
            if (!statement.jump || !statement.jump.before) return;
            const jumpText = `${renderRegionParts(statement.jump.before)}{ ${
              outputName}[0] = 3; ${outputName}[1] = ${
              jumpIndex(jump.kind, jump.label)}; break ${bodyLabel}; }${
              renderRegionParts(statement.jump.after)}`;
            body[position] = ownStatement(
              `${statement.indent}${jumpText.trim()}`,
              {reads: statement.reads, delta: statement.delta,
                relocatable: false});
            continue;
          }
          const statement = statements[index];
          const introduced = statement.def
            ? [statement.def] : statement.declares || [];
          if (!introduced.some((name) => hoistNameSet.has(name))) continue;
          // The declaration becomes an assignment; the binding itself is
          // declared at the call site and in the helper preamble. A
          // declaration that introduces no value at all just goes away.
          if (!statement.def) {
            if (statement.kind !== "letUninitialized") return;
            body[position] = ownStatement(`${statement.indent};`,
              {reads: [], relocatable: false});
            continue;
          }
          const initializer = statement.parts
            ? statement.parts.slice(statement.parts.findIndex((part) =>
              typeof part !== "string" && part.ref === statement.def) + 1)
            : null;
          if (!initializer) return;
          const assignment = renderRegionParts(initializer).trim();
          body[position] = ownStatement(`${statement.indent}${
            assignment.startsWith("=")
              ? `${statement.def} ${assignment}` : ";"}`,
          {reads: statement.reads, write: statement.def,
            delta: statement.delta, relocatable: false});
        }

        helperUnits.push(regionUnit({
          name: helperName,
          partitionable: false,
          generator: runHasYield,
          headerLines: [
            `function${runHasYield ? "*" : ""} ${helperName}(${
              [...freeNames, outputName].join(",")}) {`,
            ...(hoistNames.length ? [`  let ${hoistNames.join(", ")};`] : []),
            "  try {",
            `    ${bodyLabel}: {`,
          ],
          statements: body.map((statement) => ownStatement(
            `      ${statement.text}`, {reads: statement.reads,
              delta: statement.delta, relocatable: false})),
          footerLines: [
            `      ${outputName}[0] = 0;`,
            `      ${outputName}[1] = undefined;`,
            "    }",
            `  } catch (${caughtName}) {`,
            `    ${outputName}[0] = 2;`,
            `    ${outputName}[1] = ${caughtName};`,
            "  }",
            ...liveOutNames.map((name, index) =>
              `  ${outputName}[${index + 2}] = ${name};`),
            "}",
          ],
        }));

        const callReads = [...freeNames, sharedStateName, helperName];
        const callStatements = [];
        if (hoistNames.length) {
          callStatements.push(ownStatement(
            `let ${hoistNames.join(", ")};`,
            {kind: "letUninitialized", declares: hoistNames}));
        }
        // A yield-bearing helper suspends inside the delegation, so the
        // shared state array is only written by whichever helper exits, and
        // its protocol reads below run in the same synchronous burst.
        callStatements.push(ownStatement(
          `${runHasYield ? "yield* " : ""}${helperName}(${
            [...freeNames, sharedStateName].join(",")});`,
          {reads: callReads, yields: runHasYield}));
        for (let index = 0; index < liveOutNames.length; index += 1) {
          callStatements.push(ownStatement(
            `${liveOutNames[index]} = ${sharedStateName}[${index + 2}];`,
            {reads: [sharedStateName], write: liveOutNames[index]}));
        }
        callStatements.push(ownStatement(
          `if (${sharedStateName}[0] === 1) return ${sharedStateName}[1];`,
          {
            reads: [sharedStateName],
            exit: {
              before: [`if (${sharedStateName}[0] === 1) `],
              value: [`${sharedStateName}[1]`],
              after: [],
            },
          }));
        callStatements.push(ownStatement(
          `if (${sharedStateName}[0] === 2) throw ${sharedStateName}[1];`,
          {reads: [sharedStateName]}));
        if (jumpTable.length) {
          callStatements.push(ownStatement(
            `if (${sharedStateName}[0] === 3) {`,
            {reads: [sharedStateName], delta: 1, opens: "block"}));
          jumpTable.forEach((entry, index) => {
            callStatements.push(ownStatement(
              `  if (${sharedStateName}[1] === ${index}) ${entry.kind}${
                entry.label ? ` ${entry.label}` : ""};`,
              {reads: [sharedStateName], relocatable: false}));
          });
          callStatements.push(ownStatement("}", {delta: -1}));
        }
        edits.push({start: from, end: to, replacement: callStatements});
        segmentCount += 1;
        partitionedSourceBytes += statementBytes(statements, from, to);
      };

      const walkList = (from, to) => {
        const groups = statementGroups(statements, from, to);
        if (!groups) return;
        let runStart = 0;
        let runBytes = 0;
        const flush = (endIndex) => {
          if (endIndex > runStart && runBytes >= minimumSegmentBytes) {
            tryExtractRun(groups[runStart].start, groups[endIndex - 1].end,
              groups.slice(runStart, endIndex).map((entry) => entry.start));
          }
          runBytes = 0;
        };
        for (let index = 0; index < groups.length; index += 1) {
          const group = groups[index];
          const head = statements[group.start];
          const bytes = statementBytes(statements, group.start, group.end);
          if (head.continuesBlock || !head.relocatable ||
              head.reads === null) {
            flush(index);
            runStart = index + 1;
            continue;
          }
          if (bytes > targetSegmentBytes) {
            oversizedStatements += 1;
            flush(index);
            runStart = index + 1;
            recurseIntoGroup(group);
            continue;
          }
          if (runBytes + bytes > targetSegmentBytes &&
              runBytes >= minimumSegmentBytes) {
            flush(index);
            runStart = index;
          }
          runBytes += bytes;
        }
        flush(groups.length);
      };

      // The nested statement lists a group owns. A block continuation ends
      // one list and starts the next, so a run never spans an `else` arm.
      const recurseIntoGroup = (group) => {
        if (group.end - group.start <= 2) return;
        let start = group.start + 1;
        for (let index = start; index < group.end - 1; index += 1) {
          if (!statements[index].continuesBlock) continue;
          walkList(start, index);
          start = index + 1;
        }
        walkList(start, group.end - 1);
      };

      walkList(0, statements.length);
      if (!edits.length) continue;
      const next = statements.slice();
      for (const edit of [...edits].sort((left, right) =>
        right.start - left.start)) {
        next.splice(edit.start, edit.end - edit.start, ...edit.replacement);
      }
      working[unitIndex] = regionUnit({...unit, statements: next});
      roundChanged = true;
    }
    if (!roundChanged) break;
  }

  if (segmentCount === 0) {
    return {units, count: 0, partitionedSourceBytes: 0, attemptedRuns,
      oversizedStatements};
  }
  return {
    units: [
      rawRegionUnit(`const ${sharedStateName} = [];`),
      ...working,
      ...helperUnits,
    ],
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
    // Call-site linking is driven by published emission data. Nothing in
    // region composition parses a generated source; this stays at zero and is
    // asserted by the suite so a regression cannot reintroduce a parse.
    this.callBindingParseCount = 0;
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

  /**
   * Link one node's published positional source into the region module.
   *
   * Nothing here reads syntax out of generated JavaScript. Every call site
   * the renderer emitted publishes a `regionLowering` record naming the
   * result and depth it declared, the operand expressions it passed, its raw
   * call in both nested-entry forms, and its catch parameter with that
   * catch's restoring and rethrowing bodies. The region locates a site by the
   * compiler-owned marker pair that brackets it and then *selects* between
   * published forms; a call binding is replaced by the exact declaration text
   * the renderer published for it. Both are late-bound compiler-owned tokens
   * expanded by identity, not recovered structure.
   */
  rewriteCallBindings(source, edges, functionNames, internalNode = false,
    generatorSource = false, generated = null,
    compactClosedInternalCalls = false, inlineEdges = null,
    inlineInsertions = null, fallbackInlineEdges = null) {
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
    const bindingDeclarations =
      generated?.jvmStructuredRegionCallBindingDeclarations || {};
    // A site whose raw target is also read by a loop-invariant declaration
    // outside its own span keeps every binding it declared.
    const invariantPositionalCallIndices = new Set(
      generated?.jvmStructuredRegionInvariantPositionalCallIndices || []);
    const edits = [];
    const replaced = new Set();
    const loweredRanges = [];
    // Module-level region function names this body still references after
    // lowering. The compiler records them as it links them; module-level
    // reachability is therefore a walk over its own emission plan and never
    // a re-parse of the emitted text.
    const linkedFunctionNames = new Set();
    const regionFunctionNames = new Set(functionNames.values());
    let lexicallyInlinedEdges = 0;
    let exceptionalInlinedEdges = 0;
    let compactInternalEdges = 0;
    let guardedInternalEdges = 0;
    const inlineFailureReasons = [];
    const elidedFieldCacheInvalidations = 0;
    const eliminatedBindingNames = new Set();
    const claimed = [];
    const claim = (start, end) => {
      for (const range of claimed) {
        if (start < range.end && end > range.start) return false;
      }
      claimed.push({start, end});
      return true;
    };
    const editEveryOccurrence = (text, replacement) => {
      if (!text) return 0;
      let cursor = 0;
      let count = 0;
      for (;;) {
        const start = source.indexOf(text, cursor);
        if (start < 0) return count;
        const end = start + text.length;
        cursor = end;
        if (!claim(start, end)) continue;
        edits.push({start, end, replacement});
        count += 1;
      }
    };
    // Every occurrence of a call's raw invocation, wherever the emitted body
    // finally carried it.
    const rawCallSuffixPositions = (lowering) => {
      const positions = [];
      let scan = 0;
      for (;;) {
        const at = source.indexOf(lowering.rawCallPrefix, scan);
        if (at < 0) return positions;
        const suffix = source.indexOf(
          lowering.rawCallSuffix, at + lowering.rawCallPrefix.length);
        if (suffix < 0) return positions;
        positions.push(suffix);
        scan = suffix + lowering.rawCallSuffix.length;
      }
    };
    if (internalNode) {
      // A fused graph is one scheduler execution unit. Member entries must
      // not each record an independent run; the renderer publishes the exact
      // accounting statements it emitted, longest form first so a guarded
      // statement is claimed before its bare assignment.
      for (const statement of
        generated?.jvmStructuredRegionRunCounterStatements || []) {
        editEveryOccurrence(statement, "");
      }
    }
    for (const edge of edges) {
      const markers = edge.site.regionMarkers;
      const lowering = edge.site.regionLowering;
      const rawName = edge.site.identifiers?.rawInvoke;
      if (!markers?.start || !markers?.end || !rawName || !lowering) continue;
      const startToken = `/*${markers.start}*/`;
      const endToken = `/*${markers.end}*/`;
      const markerStart = source.indexOf(startToken);
      if (markerStart < 0) continue;
      const markerEnd = source.indexOf(
        endToken, markerStart + startToken.length);
      if (markerEnd < 0) continue;
      const range = {start: markerStart, end: markerEnd + endToken.length};
      // Bindings may only be dropped when this call was emitted once: a
      // duplicated span still reads them.
      const dropsBindings = !invariantPositionalCallIndices.has(edge.pc) &&
        source.indexOf(startToken, markerStart + startToken.length) < 0;
      const regionText = source.slice(range.start, range.end);
      // A source this node publishes may have been specialized after the call
      // was emitted (self-recursive direct calls, partitioning). Its tokens
      // are then gone; leave the site canonical rather than guessing, which
      // is exactly the outcome the previous AST search produced when it could
      // not match the call shape.
      const prefixAt = regionText.indexOf(lowering.rawCallPrefix);
      if (prefixAt < 0) continue;
      const suffixAt = regionText.indexOf(
        lowering.rawCallSuffix, prefixAt + lowering.rawCallPrefix.length);
      if (suffixAt < 0) continue;
      const operandTokens = lowering.operandTokens || [];
      const operandStarts = [];
      let operandScan = prefixAt + lowering.rawCallPrefix.length;
      for (const token of operandTokens) {
        const at = regionText.indexOf(token, operandScan);
        if (at < 0 || at >= suffixAt) break;
        operandScan = at + token.length;
        operandStarts.push(operandScan);
      }
      if (operandStarts.length !== operandTokens.length) continue;
      // Each operand runs from its own token to the ", " in front of the next
      // token, or in front of the call's trailing `thread, <guard>)`.
      const callArguments = operandStarts.map((start, position) =>
        regionText.slice(start, (position + 1 < operandStarts.length
          ? operandStarts[position + 1] - operandTokens[position + 1].length
          : suffixAt) - 2));
      const resultName = lowering.resultName;
      const blockBetween = (markers) => {
        if (!markers?.start || !markers?.end) return null;
        const open = `/*${markers.start}*/`;
        const close = `/*${markers.end}*/`;
        const at = regionText.indexOf(open);
        if (at < 0) return null;
        const to = regionText.indexOf(close, at + open.length);
        if (to < 0) return null;
        return regionText.slice(at + open.length, to);
      };
      const restoringSource = lowering.fastCall
        ? blockBetween(lowering.fastCall.restoreMarkers) : null;
      const handlerSource = lowering.fastCall
        ? blockBetween(lowering.fastCall.handlerMarkers) : null;
      const fastCall = lowering.fastCall && restoringSource !== null &&
        handlerSource !== null ? lowering.fastCall : null;
      const guardedRuntimeTarget = edge.proof === "runtime-monomorphic" &&
        typeof edge.receiverType === "string" && edge.receiverType.length > 0;
      const compactInternal = Boolean(
        compactClosedInternalCalls && internalNode &&
        (edge.site.exactTarget || guardedRuntimeTarget) && !edge.node?.atomic &&
        !hasRestoringTransientDeopt(edge.node?.generated) &&
        Number.isInteger(edge.site.id));
      if (compactInternal && fastCall) {
        const functionName = functionNames.get(edge.method);
        // The restoring arm of the generated fast-call catch is the exact
        // call-PC restoration path. Reuse that bracketed block for the cold
        // exception/deopt arms while the normal path becomes one local scalar
        // call. Closed graphs have no canonical child boundary, and
        // nested-entry marker 2 suppresses independent scheduler yields.
        const restoring = restoringSource;
        const caught = fastCall.caught;
        const receiver = edge.site.dynamic ? callArguments[0] : null;
        const coldResult = `jvmRegionColdResult${edge.pc}`;
        const admission = receiver
          ? `${receiver} !== null && ${receiver} !== undefined && ` +
            `((${receiver}.type || ${JSON.stringify(
              edge.site.declaredOwner || "")}) === ${JSON.stringify(
              edge.receiverType)})`
          : "true";
        const replacement = [
          `let ${resultName};`,
          `if (${admission}) {`,
          `try { ${resultName} = ${functionName}(` +
            `helpers${callArguments.length
              ? `,${callArguments.join(",")}` : ""},thread,2); } ` +
            `catch (${caught}) {`,
          restoring,
          `throw ${caught};`,
          "}",
          "} else {",
          `${resultName} = ssaAsyncInvoke;`,
          "}",
          `if (${resultName} === ssaAsyncInvoke) {`,
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
          `${resultName} = ${coldResult};`,
          "}",
          `if (${resultName} && ${resultName}.deopt) {`,
          restoring,
          `return ${resultName};`,
          "}",
        ].filter(Boolean).join("\n");
        if (claim(range.start, range.end)) {
          loweredRanges.push(range);
          edits.push({...range, replacement});
          replaced.add(rawName);
          linkedFunctionNames.add(functionName);
          compactInternalEdges += 1;
          if (guardedRuntimeTarget) guardedInternalEdges += 1;
          if (dropsBindings) {
            for (const identifier of Object.values(
              edge.site.identifiers || {})) {
              if (identifier) eliminatedBindingNames.add(identifier);
            }
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
      const functionName = functionNames.get(edge.method);
      // The callee is inserted by declaration, not by rewriting its text:
      // the renderer published a body whose exits already assign one result
      // token and break one label token, and the names it declares
      // (`argument<n>`, its entry guard, its own `local<slot>` / `ssaValue<n>`)
      // are bound inside the inserted block, where they shadow the caller's
      // rather than colliding with them.
      // Which body the callee contributes is a composition decision, so the
      // insertion always comes from the map the composition built. There is no
      // fallback to the callee's own published internal-region insertion: a
      // node composed through the exceptional path contributes its restoring
      // body instead, and guessing would insert the wrong one.
      const insertion = inlineEdges?.has(edge)
        ? inlineInsertions?.get(edge) || null : null;
      // The names this insertion introduces in the caller -- its exit label
      // and the staging slots for its arguments -- carry both the call site
      // and the callee's compile serial. The call site separates two
      // insertions of the same callee; the serial separates an insertion from
      // the ones already embedded in the body being inserted, which a
      // composed callee brings with it at the same call pc.
      const namespace = insertion
        ? `jvmRegionInline${edge.pc}_${insertion.serial}_` : null;
      const insertBody = (declareResult) => insertion?.assemble ? (
        insertion.assemble({
          source: insertion.source,
          argumentValues: callArguments,
          resultName,
          exitLabel: `${namespace}return`,
          namespace,
          declareResult,
        })) : null;
      const inlineSource = insertBody(true);
      if (inlineEdges?.has(edge) && !inlineSource) {
        inlineFailureReasons.push({edge, reason: insertion
          ? "insertion-assembly-rejected" : "missing-published-insertion"});
      }
      let guardedFallbackInline = null;
      const needsInlineFallback = edge.proof === "runtime-monomorphic" ||
        fallbackInlineEdges?.has(edge);
      if (inlineSource && needsInlineFallback &&
          (edge.proof !== "runtime-monomorphic" ||
            callArguments.length > 0)) {
        const declarationAt = regionText.indexOf(lowering.resultDeclaration);
        if (declarationAt >= 0) {
          const originalWithoutDeclaration =
            regionText.slice(0, declarationAt) +
            regionText.slice(
              declarationAt + lowering.resultDeclaration.length);
          const guardedBody = insertBody(false);
          let guardedExecution = guardedBody;
          if (fallbackInlineEdges?.has(edge)) {
            if (!fastCall || !lowering.depthName) {
              inlineFailureReasons.push({edge,
                reason: "missing-exception-restoration-ast"});
              guardedExecution = null;
            } else {
              guardedExecution = [
                `const ${lowering.depthName} = ` +
                  "thread.callStack.items.length;",
                "try {",
                guardedBody,
                `} catch (${fastCall.caught}) {`,
                handlerSource,
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
          const completed = `${namespace}completed`;
          guardedFallbackInline = guardedExecution && [
            `let ${resultName};`,
            `let ${completed} = false;`,
            `if (${admission}) {`,
            guardedExecution,
            `${completed} = ${resultName} !== ssaAsyncInvoke && ` +
              `!(${resultName} && ${resultName}.deopt);`,
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
        `let ${resultName} = ${functionName}(` +
          `helpers${callArguments.length
            ? `,${callArguments.join(",")}` : ""},thread,2);`;
      if (!claim(range.start, range.end)) continue;
      if (effectiveInlineSource) {
        lexicallyInlinedEdges += 1;
        if (fallbackInlineEdges?.has(edge)) exceptionalInlinedEdges += 1;
      } else {
        linkedFunctionNames.add(functionName);
      }
      loweredRanges.push(range);
      edits.push({...range, replacement});
      replaced.add(rawName);
      if (!needsInlineFallback && dropsBindings) {
        for (const identifier of Object.values(edge.site.identifiers || {})) {
          if (identifier) eliminatedBindingNames.add(identifier);
        }
      }
    }
    // A site the region did not lower keeps its published call, but its
    // callee is now a region-local node function entered under the region's
    // own scheduler marker: select the nested-entry form of the same call.
    for (const edge of edges) {
      const lowering = edge.site.regionLowering;
      if (!lowering?.rawCallPrefix || !lowering.nestedRawCallSuffix) continue;
      for (const position of rawCallSuffixPositions(lowering)) {
        const end = position + lowering.rawCallSuffix.length;
        if (!claim(position, end)) continue;
        edits.push({start: position, end,
          replacement: lowering.nestedRawCallSuffix});
      }
    }
    // A binding whose entire call operation was lowered is not emitted at
    // all. The renderer publishes each binding's exact declaration and
    // declaration kind, so this is a decision taken while composing the
    // module -- not dead-code elimination over a re-parsed result.
    for (const [name, replacement] of replacements) {
      const eliminated = eliminatedBindingNames.has(name);
      for (const declaration of bindingDeclarations[name] || []) {
        if (editEveryOccurrence(declaration.text, eliminated
          ? "" : `${declaration.kind} ${name} = ${replacement};`) > 0) {
          replaced.add(name);
          if (!eliminated && regionFunctionNames.has(replacement)) {
            linkedFunctionNames.add(replacement);
          }
        }
      }
    }
    for (const name of eliminatedBindingNames) {
      if (replacements.has(name)) continue;
      for (const declaration of bindingDeclarations[name] || []) {
        editEveryOccurrence(declaration.text, "");
      }
    }
    for (const edge of edges) {
      if (!replaced.has(edge.site.identifiers.rawInvoke)) {
        return {error: `missing raw call binding at bytecode ${edge.pc}`};
      }
    }
    edits.sort((left, right) => left.start - right.start ||
      right.end - left.end);
    const rewrittenParts = [];
    const appliedEdits = [];
    let sourceCursor = 0;
    for (const edit of edits) {
      if (edit.start < sourceCursor) {
        if (edit.end <= sourceCursor) continue;
        return {error: "overlapping region AST edits"};
      }
      rewrittenParts.push(source.slice(sourceCursor, edit.start),
        edit.replacement);
      appliedEdits.push(edit);
      sourceCursor = edit.end;
    }
    rewrittenParts.push(source.slice(sourceCursor));
    return {
      source: rewrittenParts.join(""),
      // The same edits, so a caller that holds the body's statement records
      // can keep them in step with the text instead of recovering them from
      // it again.
      appliedEdits,
      linkedFunctionNames,
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

  /**
   * The insertable form of one composed body. Composition inserts each callee
   * at its call site, so it is performed over the callee's *insertable* base
   * exactly as it is performed over its standalone base: the parent's own
   * exits already carry the insertion tokens, and every callee it embeds is a
   * self-contained labeled block whose exits break out of that block only.
   * Nothing rewrites an emitted return, so the composed body remains
   * insertable by construction; when any callee has no insertable form, the
   * parent gets none either and is linked as a region function instead.
   */
  composeInsertion(base, prefix, node, functionNames, insertions,
    fallbackInlineEdges = null) {
    if (!base) return null;
    const edgeInsertions = new Map();
    for (const edge of node.edges) {
      const insertion = insertions.get(edge.node);
      if (!insertion) return null;
      edgeInsertions.set(edge, insertion);
    }
    const rewritten = this.rewriteCallBindings(
      `${prefix}${base.source}`, node.edges, functionNames, true, false,
      node.generated, false, new Set(node.edges), edgeInsertions,
      fallbackInlineEdges);
    if (!rewritten.source) return null;
    return {...base, source: rewritten.source};
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
    // The statement records behind each composed body, kept in step with the
    // text by the same edits that produced it. A body that cannot keep them
    // carries null and is simply never outlined or partitioned.
    const composedInternalStatements = new Map();
    // The same composed bodies in the form a caller inserts. A node has one
    // exactly when the renderer published an insertable body for it and every
    // callee it embedded has one too, so the composed insertion is closed
    // under composition: its own exits already carry the insertion tokens and
    // each embedded callee is a self-contained labeled block.
    const composedInternalInsertions = new Map();
    const composedInternalCosts = new Map();
    const composedInlineCounts = new Map();
    // Which module-level node functions a composed body still calls. Composed
    // bodies embed their callees' composed text, so the set is the union of
    // what this body linked and what every embedded body linked.
    const composedInternalLinkedNames = new Map();
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
          composedInternalStatements.set(node, regionStatementsFromFragments(
            node.generated.jvmInternalRegionPositionalSource,
            node.generated.jvmStructuredRegionFragments
              ?.jvmInternalRegionPositionalSource));
          composedInternalInsertions.set(node,
            node.generated.jvmInternalRegionPositionalInsertion || null);
          composedInternalCosts.set(node, node.codeItems);
          composedInlineCounts.set(node, 0);
          composedInternalLinkedNames.set(node, new Set());
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
        const edgeInsertions = new Map(node.edges.map((edge) =>
          [edge, composedInternalInsertions.get(edge.node)]));
        const rewritten = this.rewriteCallBindings(
          node.generated.jvmInternalRegionPositionalSource,
          node.edges, functionNames, true, false, node.generated,
          false, new Set(node.edges), edgeInsertions);
        if (!rewritten.source) continue;
        if (rewritten.source.length > this.inlineSourceByteBudget) continue;
        composedInternalSources.set(node, rewritten.source);
        composedInternalStatements.set(node, applyRegionStatementEdits(
          regionStatementsFromFragments(
            node.generated.jvmInternalRegionPositionalSource,
            node.generated.jvmStructuredRegionFragments
              ?.jvmInternalRegionPositionalSource),
          rewritten.appliedEdits, rewritten.source));
        composedInternalInsertions.set(node, this.composeInsertion(
          node.generated.jvmInternalRegionPositionalInsertion, "",
          node, functionNames, composedInternalInsertions));
        composedInternalLinkedNames.set(node, unionLinkedNames(
          rewritten.linkedFunctionNames,
          node.edges.map((edge) =>
            composedInternalLinkedNames.get(edge.node))));
        composedInternalCosts.set(node, expandedCost);
        composedInlineCounts.set(node, node.edges.reduce(
          (sum, edge) => sum + 1 +
            (composedInlineCounts.get(edge.node) || 0), 0));
        compositionChanged = true;
      }
    }
    // `const plan = <planName>;` is a statement the region compiler emits in
    // front of a restoring body it inlines, so it states its own facts.
    const restoringInlineStatements = (node, planName) => {
      const body = regionStatementsFromFragments(
        node.generated.jvmRestoringDirectPositionalSource,
        node.generated.jvmStructuredRegionFragments
          ?.jvmRestoringDirectPositionalSource);
      return body ? [ownStatement(`const plan = ${planName};`,
        {kind: "const", def: "plan"}), ...body] : null;
    };
    const exceptionalInlineSources = new Map();
    const exceptionalInlineStatements = new Map();
    const exceptionalInlineInsertions = new Map();
    const exceptionalInlineCosts = new Map();
    const exceptionalInlineCounts = new Map();
    const exceptionalInlinePlanNames = new Map();
    const exceptionalInlineLinkedNames = new Map();
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
      exceptionalInlineStatements.set(node, restoringInlineStatements(
        node, planName));
      // The restoring tier receives its restoration plan as a parameter; an
      // inserted copy binds it by declaration inside its own block, where it
      // shadows the caller's rather than colliding with it.
      const restoringInsertion =
        node.generated.jvmRestoringDirectPositionalInsertion;
      exceptionalInlineInsertions.set(node, restoringInsertion ? {
        ...restoringInsertion,
        source: `const plan = ${planName};\n${restoringInsertion.source}`,
      } : null);
      exceptionalInlineLinkedNames.set(node, new Set());
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
            [edge, exceptionalInlineInsertions.get(edge.node)])),
          new Set(node.edges));
        if (!rewritten.source) continue;
        if (rewritten.source.length > this.inlineSourceByteBudget) continue;
        exceptionalInlineSources.set(node, rewritten.source);
        exceptionalInlineStatements.set(node, applyRegionStatementEdits(
          restoringInlineStatements(node, planName), rewritten.appliedEdits,
          rewritten.source));
        exceptionalInlineInsertions.set(node, this.composeInsertion(
          node.generated.jvmRestoringDirectPositionalInsertion,
          `const plan = ${planName};\n`,
          node, functionNames, exceptionalInlineInsertions,
          new Set(node.edges)));
        exceptionalInlineLinkedNames.set(node, unionLinkedNames(
          rewritten.linkedFunctionNames,
          node.edges.map((edge) =>
            exceptionalInlineLinkedNames.get(edge.node))));
        exceptionalInlineCosts.set(node, expandedCost);
        exceptionalInlineCounts.set(node, node.edges.reduce(
          (sum, edge) => sum + 1 +
            (exceptionalInlineCounts.get(edge.node) || 0), 0));
        exceptionalCompositionChanged = true;
      }
    }
    const inlineSourceForNode = (node) =>
      exceptionalInlineSources.get(node) || composedInternalSources.get(node);
    const inlineInsertionForNode = (node) =>
      (exceptionalInlineSources.has(node)
        ? exceptionalInlineInsertions.get(node)
        : composedInternalInsertions.get(node)) || null;
    const inlineLinkedNamesForNode = (node) =>
      (exceptionalInlineSources.has(node)
        ? exceptionalInlineLinkedNames.get(node)
        : composedInternalLinkedNames.get(node)) || null;
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
      // Inlining consumes the insertable form of the body. A body whose
      // emitter grew an exit the insertion cannot route, or whose composition
      // embedded such a body, is linked as a region function instead.
      if (!inlineInsertionForNode(edge.node)) {
        return "target-without-insertable-body";
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
    // The module's own emission plan: one entry per emitted module-level
    // declaration group, carrying the name it declares and the module names
    // it links against. Module-level reachability and the factory-hoist split
    // are list operations over this plan.
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
        const recursiveName = functionNames.get(node.method);
        declarations.push({
          name: recursiveName,
          kind: "function",
          references: [],
          units: [rawRegionUnit([
            `function ${recursiveName}(${parameters.join(",")}) {`,
            `return ${bodyName}(helpers,${planName},${
              argumentsList.join(",")}${argumentsList.length ? "," : ""}` +
              "thread,nestedEntryGuarded);",
            "}",
          ].join("\n"))],
        });
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
        ? {source, appliedEdits: [], lexicallyInlinedEdges:
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
            [edge, inlineInsertionForNode(edge.node)])), fallbackInlineEdges);
      if (!rewritten.source) {
        this.lastRejectionReason = rewritten.error;
        return null;
      }
      // Which module functions this node's emitted body still calls. A
      // composed body carries the set recorded when it was composed; a body
      // lowered here carries what this lowering linked, plus what every
      // lexically inlined callee body had already linked. Loop outlining
      // moves statements from this body into helpers emitted alongside it,
      // so the node and its helpers share one reachability group and one
      // reference set.
      const nodeReferences = sourceAlreadyComposed
        ? unionLinkedNames(source === exceptionalInlineSources.get(node)
          ? exceptionalInlineLinkedNames.get(node)
          : composedInternalLinkedNames.get(node))
        : unionLinkedNames(rewritten.linkedFunctionNames,
          node.edges.filter((edge) => inlineEdges.has(edge))
            .map((edge) => inlineLinkedNamesForNode(edge.node)));
      // The statement records behind this node's emitted body. A composed
      // body carries the records the composition kept; a body lowered here
      // takes the records the renderer published for the variant it came
      // from and applies this lowering's own edits to them. When neither is
      // available -- a framed root, a checked-leaf source, a body whose
      // records could not be kept -- the node is emitted as finished text
      // and no structural pass touches it.
      const nodeStatements = sourceAlreadyComposed
        ? (source === exceptionalInlineSources.get(node)
          ? exceptionalInlineStatements.get(node)
          : composedInternalStatements.get(node)) || null
        : applyRegionStatementEdits(
          regionStatementsFromFragments(source,
            node.generated.jvmStructuredRegionFragments?.[
              variantNameOfSource(node.generated, source)]),
          rewritten.appliedEdits, rewritten.source);
      const outlined = this.loopOutliningEnabled && nodeStatements
        ? outlineLargeRegionLoops(regionUnit({statements: nodeStatements}), {
          minimumSourceBytes: this.loopOutlineSourceBytes,
          maximumOutlines: this.maxOutlinedLoopsPerNode,
          namespace: index,
        })
        : {unit: null, count: 0, outlinedSourceBytes: 0,
          largestOutlinedSourceBytes: 0, helpers: []};
      // A fused graph is one scheduler execution unit. Per-method generated
      // sources normally own their counter, but retaining those declarations
      // here resets the quantum at every internal edge and lets a deep graph
      // run for N independent budgets. Remove only the renderer's exact
      // declaration; every node then closes over the module-owned counter.
      const budgetDeclarations =
        node.generated.jvmStructuredSafePointBudgetDeclarations || [];
      const bodyStatements = outlined.unit
        ? outlined.unit.statements : nodeStatements;
      const emittedStatements = bodyStatements
        ? stripRegionSafePointBudgets(bodyStatements, budgetDeclarations)
        : null;
      let emittedSource = rewritten.source;
      if (emittedStatements) {
        emittedSource = emittedStatements
          .map((statement) => statement.text).join("\n");
      } else {
        for (const declaration of budgetDeclarations) {
          emittedSource = emittedSource.split(declaration).join("");
        }
      }
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
      // The node and the helpers loop outlining moved out of it are one
      // declaration entry: they share a reachability group and a reference
      // set, and the assembler emits the helpers in front of the node.
      const pushNodeDeclaration = (headerLines, prologueStatements = []) => {
        declarations.push({
          name: functionName,
          kind: "function",
          references: [...nodeReferences],
          units: [
            ...outlined.helpers,
            regionUnit({
              name: functionName,
              headerLines,
              statements: emittedStatements
                ? [...prologueStatements, ...emittedStatements] : [],
              footerLines: emittedStatements ? ["}"]
                : [...prologueStatements.map(
                  (statement) => statement.text), emittedSource, "}"],
              partitionable: Boolean(emittedStatements),
            }),
          ],
        });
      };
      if (framedSource) {
        pushNodeDeclaration([
          `function* ${functionName}(` +
            "frame,thread,helpers,initialBytecodeChecks,framelessEntry) {",
        ]);
        continue;
      }
      const parameters = ["helpers", ...argumentsList, "thread",
        "nestedEntryGuarded"];
      if (source === restoringSource) {
        const planName = `jvmRegionPlan${index}`;
        captures[planName] = this.restorationPlan(node);
        pushNodeDeclaration(
          [`function ${functionName}(${parameters.join(",")}) {`],
          [ownStatement(`const plan = ${planName};`,
            {kind: "const", def: "plan"})]);
      } else {
        pushNodeDeclaration(
          [`function ${functionName}(${parameters.join(",")}) {`]);
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
    // The module is assembled from three regions the compiler owns: the
    // per-entry safe-point counter, the declaration region, and the entry
    // statements. Keeping them apart is what lets the factory-hoist split be
    // a choice between two assembled texts instead of a re-parse of the
    // finished module, and the directive prologue is attached at the end
    // rather than located in the source passes' output.
    const entryPrologueSource =
      `let safePointBudget = ${this.directSafePointBudget};`;
    const entryTailSource = [
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
    // Only the entry statements enter the module from outside, and they call
    // exactly one node. Everything the root cannot reach through its recorded
    // links is dropped before the source passes run, so no dead declaration
    // is lifted, partitioned or measured.
    const reachableDeclarations =
      pruneUnreachableRegionDeclarations(declarations, [rootName]);
    const declarationUnits = reachableDeclarations
      .flatMap((declaration) => declaration.units);
    // A framed root shares one function-scoped local namespace across the
    // whole body; lift it into an environment array first so partitioning
    // does not re-plumb hundreds of names through every segment boundary.
    const partitionStarted = this.jit.monotonicNow();
    const lifted = framedRoot && this.framedPartitionEnabled
      ? liftOversizedUnitLocalsToEnvironment(declarationUnits, {
        maximumUnitBytes: this.linearPartitionUnitBytes,
        namespace: "0",
      })
      : {units: declarationUnits, liftedNames: 0, liftedUnits: 0};
    this.liftedEnvironmentNameCount += lifted.liftedNames;
    const partitionedUnits = (framedRoot
      ? this.framedPartitionEnabled : this.linearPartitionEnabled)
      ? partitionOversizedLinearBlocks(lifted.units, {
        maximumUnitBytes: this.linearPartitionUnitBytes,
        targetSegmentBytes: this.linearPartitionSegmentBytes,
        maximumSegments: this.linearPartitionMaxSegments,
        namespace: "0",
      })
      : {units: lifted.units, count: 0, partitionedSourceBytes: 0};
    const partitioned = {
      ...partitionedUnits,
      source: partitionedUnits.units.map(renderRegionUnit).join("\n"),
    };
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
    const moduleSource = `'use strict';\n${entryPrologueSource}\n${
      partitioned.source}\n${entryTailSource}`;
    const factorySplit = this.factoryHoistEnabled
      ? splitRegionModuleForFactoryHoist({
        hoistedSource: partitioned.source,
        entrySources: [entryPrologueSource, entryTailSource],
        entryDeclaredNames: ["safePointBudget"],
        hoistedCount: partitionedUnits.units.length,
      }) : null;
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
module.exports.splitRegionModuleForFactoryHoist =
  splitRegionModuleForFactoryHoist;
module.exports.regionUnit = regionUnit;
module.exports.rawRegionUnit = rawRegionUnit;
module.exports.renderRegionUnit = renderRegionUnit;
module.exports.ownStatement = ownStatement;
module.exports.regionStatementsFromFragments = regionStatementsFromFragments;
module.exports.applyRegionStatementEdits = applyRegionStatementEdits;
module.exports.pruneUnreachableRegionDeclarations =
  pruneUnreachableRegionDeclarations;
