const {
  buildCfgFromCode,
  structure,
  IrreducibleError,
  succOfTerm,
  succAllOfTerm,
} = require("../decompiler/structurer");
const { splitIrreducibleTerms } = require("../decompiler/exceptionStructurer");
const { parseDescriptor } = require("../parsing/typeParser");
const { arrayDataExpression } = require("./arrayDataExpression");
const { inlineIntegerArgumentName } = require("./inlineIntegerNames");
const { buildSsa } = require("../analysis/opgraph/ssa");
const { kindWidth } = require("../analysis/opgraph/ssaTypes");
const { parse: parseJavaScript } = require("acorn");
const {
  outlineLargeRegionLoops,
  partitionOversizedLinearBlocks,
  regionUnit,
  renderRegionUnit,
} = require("./HotCallGraphRegionCompiler");
const STRUCTURED_CONTINUATION = Symbol("jvm.structuredSsaContinuation");
const STRUCTURED_LONG_OPCODES = new Set([
  "lconst_0", "lconst_1",
  "i2l", "f2l", "d2l", "l2i", "l2f", "l2d",
  "ladd", "lsub", "lmul", "ldiv", "lrem", "lneg",
  "lshl", "lshr", "lushr", "land", "lor", "lxor", "lcmp",
]);
const PRIMITIVE_ARRAY_ACCESS_OPCODES = new Set([
  "baload", "bastore", "caload", "castore", "daload", "dastore",
  "faload", "fastore", "iaload", "iastore", "laload", "lastore",
  "saload", "sastore",
]);

function opcodeOf(instruction) {
  if (!instruction) return null;
  if (typeof instruction !== "string") return instruction.op || null;
  const value = instruction.trim();
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 32) return value.slice(0, index);
  }
  return value;
}

function isIrreducibleError(error) {
  return error instanceof IrreducibleError ||
    error?.name === "IrreducibleError" && Array.isArray(error.edges);
}

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
function unboundGeneratedSsaIdentifiers(source, candidates = null) {
  const program = parseGeneratedStatements(source);
  const nodeScopes = new WeakMap();
  const declarationIdentifiers = new WeakSet();
  const createScope = (parent) => ({parent, bindings: new Set()});
  const rootScope = createScope(null);
  const isCandidate = (name) => candidates
    ? candidates.has(name) : name.startsWith("ssaValue");
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

function normalizedArrayLoadExpression(raw, op, array, arrayKind = null) {
  switch (op) {
    case "baload":
      if (arrayKind === "[Z") return e`(${raw} ? 1 : 0)`;
      if (arrayKind === "[B") return e`((${raw} << 24) >> 24)`;
      return exprConcat(
        e`(${array}.type === "[Z" || ${array}.elementType === "boolean") ? `,
        e`(${raw} ? 1 : 0) : ((${raw} << 24) >> 24)`);
    case "caload": return e`(${raw} & 0xffff)`;
    case "saload": return e`((${raw} << 16) >> 16)`;
    case "iaload": return e`((${raw}) | 0)`;
    case "faload": return e`Math.fround(${raw})`;
    case "laload": return e`BigInt.asIntN(64, BigInt(${raw}))`;
    case "aaload":
    case "daload":
    default:
      return raw;
  }
}

function normalizedArrayStoreExpression(value, op, array, arrayKind = null) {
  switch (op) {
    case "bastore":
      if (arrayKind === "[Z") return e`((${value}) & 1)`;
      if (arrayKind === "[B") return e`(((${value}) << 24) >> 24)`;
      return exprConcat(
        e`(${array}.type === "[Z" || ${array}.elementType === "boolean") ? `,
        e`((${value}) & 1) : (((${value}) << 24) >> 24)`);
    case "castore": return e`((${value}) & 0xffff)`;
    case "sastore": return e`(((${value}) << 16) >> 16)`;
    case "iastore": return e`((${value}) | 0)`;
    case "fastore": return e`Math.fround(${value})`;
    case "lastore": return e`BigInt.asIntN(64, BigInt(${value}))`;
    case "aastore":
    case "dastore":
    default:
      return value;
  }
}

function runtimeClassNameExpression(value) {
  return exprConcat(
    e`(typeof ${value} === "string" || ${value} instanceof String `,
    e`? "java/lang/String" : (${value}._className || ${value}.type))`);
}

// ---------------------------------------------------------------------------
// Statement IR
//
// The renderer emits JavaScript source text, and several optimizations used to
// run over that text with regular expressions. They are ordinary compiler
// passes -- copy propagation, alias substitution, dead-code elimination, load
// folding, strength reduction -- so they belong on the compiler's own
// representation instead.
//
// Every emitted statement is therefore built from a *parts list*: an ordered
// sequence of opaque literal chunks and `{ref: name}` operand references. The
// parts list is the statement's representation; rendering it is the last step.
// A pass asks the record which names a statement defines and reads, and
// produces a new statement by substituting operand references -- never by
// matching or rewriting the rendered characters.
//
// Records are keyed by the trimmed rendered text, the same late-bound identity
// idiom `methodIntegerOriginLines` and `checkedLeafOmittableLines` already use;
// indentation is applied by the assembler and is not part of the identity.
class Expr {
  constructor(parts) { this.parts = parts; }
  toString() { return renderParts(this.parts); }
}

function renderParts(parts) {
  let text = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    // A reference may render as something other than its name while a later
    // stage still owns it: an array-range access token renders as
    // `false /*token*/` until a proof replaces the whole reference by a guard.
    text += typeof part === "string" ? part
      : part.text !== undefined ? part.text : part.ref;
  }
  return text;
}

// The set of names the compile currently being rendered has minted. Only the
// compiler's own names become operand references; anything else an emitter
// interpolates is an opaque literal chunk. The renderer compiles one method at
// a time, exactly like `currentMaterializationLocalValues` below.
let activeEmittedNames = null;
// Names every generated tier declares in its outermost scope. They are never
// operands of a statement: no pass renames, propagates or removes one, and an
// outlined unit always receives them.
const AMBIENT_GENERATED_NAMES = [
  "helpers", "frame", "locals", "stack", "thread", "plan",
  "restorationDepth", "safePointBudget", "nestedEntryGuarded",
  "framelessEntry",
];

// Composite operands the simulator stages on the bytecode operand stack stay
// strings, because the simulator compares and keys them by identity. Their
// parts list is remembered here so an emitter that interpolates one keeps its
// operand references instead of flattening it into characters.
let activeOperandExpressions = null;

function appendPartValue(parts, value) {
  if (value instanceof Expr) {
    for (let index = 0; index < value.parts.length; index += 1) {
      parts.push(value.parts[index]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      appendPartValue(parts, value[index]);
    }
    return;
  }
  const text = typeof value === "string" ? value : String(value);
  if (text === "") return;
  if (activeEmittedNames !== null && activeEmittedNames.has(text)) {
    parts.push({ref: text});
    return;
  }
  const staged = activeOperandExpressions !== null
    ? activeOperandExpressions.get(text) : undefined;
  if (staged !== undefined) {
    for (let index = 0; index < staged.length; index += 1) {
      parts.push(staged[index]);
    }
    return;
  }
  parts.push(text);
}

function buildParts(strings, values) {
  const parts = [];
  for (let index = 0; index < strings.length; index += 1) {
    if (strings[index] !== "") parts.push(strings[index]);
    if (index < values.length) appendPartValue(parts, values[index]);
  }
  return parts;
}

// Tagged template for an expression: `e`${a} + ${b}`` records the operand
// references instead of flattening them into characters.
function e(strings, ...values) {
  return new Expr(buildParts(strings, values));
}

// Concatenation of expression pieces. `+` on two tagged templates would
// stringify both and lose their operand references.
function exprConcat(...pieces) {
  const parts = [];
  for (let index = 0; index < pieces.length; index += 1) {
    appendPartValue(parts, pieces[index]);
  }
  return new Expr(parts);
}

function partsReferences(parts) {
  const names = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (typeof part !== "string") names.push(part.ref);
  }
  return names;
}

// Replace operand references by parts lists. This is the only way a pass may
// rewrite a statement.
function substituteParts(parts, replacements) {
  const out = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (typeof part === "string") { out.push(part); continue; }
    const replacement = replacements.get(part.ref);
    if (replacement === undefined) { out.push(part); continue; }
    const replacementParts = replacement instanceof Expr
      ? replacement.parts : replacement;
    for (let position = 0; position < replacementParts.length; position += 1) {
      out.push(replacementParts[position]);
    }
  }
  return out;
}

// The syntactic properties the checked-leaf passes ask a statement about.
// Each is read off the parts list through its *skeleton*: the literal chunks
// the emitter wrote, with every operand reference replaced by one placeholder
// character. An operand is a name, so it can neither contribute an operator,
// a bracket or a keyword nor split one; the skeleton therefore answers these
// questions on the statement the compiler built, not on a rendered body.
const PARTS_OPERAND_PLACEHOLDER = "\u0000";

function partsSkeleton(parts) {
  let text = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    text += typeof part === "string" ? part : PARTS_OPERAND_PLACEHOLDER;
  }
  return text;
}

function isPartsWordCharacter(character) {
  return character !== undefined && character !== "" &&
    (character >= "a" && character <= "z" ||
      character >= "A" && character <= "Z" ||
      character >= "0" && character <= "9" ||
      character === "_" || character === "$");
}

function partsWriteImpureCall(parts) {
  const skeleton = partsSkeleton(parts);
  if (skeleton.includes("helpers.")) return true;
  let position = skeleton.indexOf("new");
  while (position >= 0) {
    if (!isPartsWordCharacter(skeleton[position - 1]) &&
        !isPartsWordCharacter(skeleton[position + 3])) return true;
    position = skeleton.indexOf("new", position + 1);
  }
  return false;
}

// The ambient names a statement mentions. They are declared by the tier's
// outermost scope rather than by any statement, so they are not operands; an
// outlined unit still has to receive them.
function partsAmbientNames(parts) {
  const skeleton = partsSkeleton(parts);
  const found = [];
  for (let index = 0; index < AMBIENT_GENERATED_NAMES.length; index += 1) {
    const name = AMBIENT_GENERATED_NAMES[index];
    let position = skeleton.indexOf(name);
    while (position >= 0) {
      if (!isPartsWordCharacter(skeleton[position - 1]) &&
          !isPartsWordCharacter(skeleton[position + name.length])) {
        found.push(name);
        break;
      }
      position = skeleton.indexOf(name, position + 1);
    }
  }
  return found;
}

// Names a generated tier declares once in its own body prologue and then
// calls from ordinary statements: the local spill helper and the frame
// materialization helpers. Unlike an SSA value they are literal text in the
// statement the emitter wrote rather than operands, so they never appear in
// `reads` -- but a unit outlined out of the body still has to receive them.
const BODY_HELPER_NAME_PREFIXES = ["ssaMaterialize"];

function partsBodyHelperNames(parts) {
  const skeleton = partsSkeleton(parts);
  const found = [];
  let position = skeleton.indexOf("spillLocals");
  if (position >= 0 && !isPartsWordCharacter(skeleton[position - 1])) {
    found.push("spillLocals");
  }
  for (const prefix of BODY_HELPER_NAME_PREFIXES) {
    position = skeleton.indexOf(prefix);
    while (position >= 0) {
      if (!isPartsWordCharacter(skeleton[position - 1])) {
        let end = position + prefix.length;
        while (isPartsWordCharacter(skeleton[end])) end += 1;
        const name = skeleton.slice(position, end);
        if (name !== prefix && !found.includes(name)) found.push(name);
      }
      position = skeleton.indexOf(prefix, position + 1);
    }
  }
  return found;
}

// Which characters of a skeleton are code rather than the contents of a
// string literal or a comment the emitter wrote. Operands are already blanked
// to one placeholder character, so what is left is the emitter's own literal
// text: a `;` inside `'/ by zero'` or a keyword inside `/*__JVM_...__*/` must
// not be read as syntax.
function skeletonCodeMask(skeleton) {
  const mask = new Array(skeleton.length).fill(true);
  let index = 0;
  while (index < skeleton.length) {
    const character = skeleton[index];
    if (character === "'" || character === "\"" || character === "`") {
      mask[index] = false;
      index += 1;
      while (index < skeleton.length) {
        mask[index] = false;
        if (skeleton[index] === "\\") { index += 2; continue; }
        if (skeleton[index] === character) { index += 1; break; }
        index += 1;
      }
      continue;
    }
    if (character === "/" && skeleton[index + 1] === "/") {
      while (index < skeleton.length) mask[index++] = false;
      continue;
    }
    if (character === "/" && skeleton[index + 1] === "*") {
      mask[index] = false;
      mask[index + 1] = false;
      index += 2;
      while (index < skeleton.length) {
        mask[index] = false;
        if (skeleton[index] === "*" && skeleton[index + 1] === "/") {
          mask[index + 1] = false;
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return mask;
}

// A keyword the emitter wrote, as opposed to the same characters inside an
// operand, a string or a comment: operands are one placeholder character in
// the skeleton, so a word-boundary test on the code positions answers about
// the emitted statement.
function skeletonKeywordPositions(skeleton, keyword, mask = null) {
  const codeMask = mask || skeletonCodeMask(skeleton);
  const positions = [];
  let position = skeleton.indexOf(keyword);
  while (position >= 0) {
    if (codeMask[position] &&
        !isPartsWordCharacter(skeleton[position - 1]) &&
        !isPartsWordCharacter(skeleton[position + keyword.length])) {
      positions.push(position);
    }
    position = skeleton.indexOf(keyword, position + 1);
  }
  return positions;
}

// Where the statement starting at `from` ends: the first `;` the emitter
// wrote outside every bracket it opened after that point. Returns -1 when the
// statement's own block closes first, which means the shape is not one
// terminated by a semicolon.
function skeletonStatementEnd(skeleton, from, mask) {
  let depth = 0;
  for (let index = from; index < skeleton.length; index += 1) {
    if (!mask[index]) continue;
    const character = skeleton[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (character === ";" && depth === 0) return index;
  }
  return -1;
}

// The sub-list of `parts` covering the skeleton range [start, end). An
// operand reference occupies exactly one skeleton character and is therefore
// either wholly inside the range or wholly outside it; a literal chunk is
// sliced. This is a slice of the compiler's own parts list, not of emitted
// text.
function partsSliceBySkeleton(parts, start, end) {
  const slice = [];
  let cursor = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const width = typeof part === "string" ? part.length : 1;
    const from = cursor;
    cursor += width;
    if (cursor <= start || from >= end) continue;
    if (typeof part !== "string") { slice.push(part); continue; }
    const text = part.slice(Math.max(0, start - from),
      Math.min(width, end - from));
    if (text !== "") slice.push(text);
  }
  return slice;
}

// How a statement that leaves the enclosing function through `return` is
// split, so a consumer that relocates the statement into a helper can
// re-establish the exit through the helper's protocol instead of rewriting
// emitted characters. `before` and `after` are the parts around the whole
// `return <argument>;`, `argument` is its operand list (null for `return;`).
//
// Only two shapes are recognized, both of which the consumer can wrap in a
// block: the statement *is* the return, or the return is the single
// statement of a guard the emitter wrote on one line. Anything else -- more
// than one `;`, more than one `return`, a quote the emitted guard could hide
// a keyword behind -- is reported as unrecognized, and the consumer then
// leaves the statement where it is.
function partsReturnSplit(parts) {
  const skeleton = partsSkeleton(parts);
  const mask = skeletonCodeMask(skeleton);
  const returns = skeletonKeywordPositions(skeleton, "return", mask);
  if (!returns.length) return null;
  if (returns.length > 1) return {recognized: false};
  const start = returns[0];
  const end = skeletonStatementEnd(skeleton, start + "return".length, mask);
  if (end < 0) return {recognized: false};
  let argumentStart = start + "return".length;
  while (skeleton[argumentStart] === " ") argumentStart += 1;
  return {
    recognized: true,
    before: partsSliceBySkeleton(parts, 0, start),
    argument: argumentStart >= end
      ? null : partsSliceBySkeleton(parts, argumentStart, end),
    after: partsSliceBySkeleton(parts, end + 1, skeleton.length),
  };
}

// The `break` / `continue` a statement carries, split the same way a return
// is: the parts before the jump, its label, and the parts after it. A jump is
// always a complete statement, so replacing its own range by a block is valid
// wherever the emitter wrote it. A statement carrying more than one is
// reported unrecognized and stays where it is.
function partsJumpStatement(parts) {
  const skeleton = partsSkeleton(parts);
  const mask = skeletonCodeMask(skeleton);
  const breaks = skeletonKeywordPositions(skeleton, "break", mask);
  const continues = skeletonKeywordPositions(skeleton, "continue", mask);
  if (!breaks.length && !continues.length) return null;
  if (breaks.length + continues.length > 1) return {recognized: false};
  const kind = breaks.length ? "break" : "continue";
  const start = breaks.length ? breaks[0] : continues[0];
  let cursor = start + kind.length;
  while (skeleton[cursor] === " ") cursor += 1;
  const labelStart = cursor;
  while (isPartsWordCharacter(skeleton[cursor])) cursor += 1;
  const label = cursor > labelStart
    ? skeleton.slice(labelStart, cursor) : null;
  while (skeleton[cursor] === " ") cursor += 1;
  if (skeleton[cursor] !== ";" || !mask[cursor]) {
    return {recognized: false};
  }
  return {
    recognized: true,
    kind,
    label,
    before: partsSliceBySkeleton(parts, 0, start),
    after: partsSliceBySkeleton(parts, cursor + 1, skeleton.length),
  };
}

// The label a statement introduces (`L1: while (true) {`). `case`/`default`
// are excluded: they are not labels and a consumer must not treat them as
// one.
// A block a consumer must not relocate or reason about structurally: the
// emitter opened a construct whose jump semantics (`switch`) or scoping
// (`function`, `class`, `with`) differ from the ordinary statement nesting
// the fragment walk tracks.
function partsOpensNamedConstruct(parts) {
  const skeleton = partsSkeleton(parts).trimStart();
  for (const keyword of ["switch", "function", "class", "with", "var"]) {
    if (skeleton.startsWith(keyword) &&
        !isPartsWordCharacter(skeleton[keyword.length])) return keyword;
  }
  return null;
}

// Whether the statement carries a nested function. Moving such a statement
// into a helper would rebind its captures to the helper's parameter copies,
// so a consumer leaves it where it is.
function partsCarriesNestedFunction(parts) {
  const skeleton = partsSkeleton(parts);
  return skeleton.includes("=>") ||
    skeletonKeywordPositions(skeleton, "function").length > 0;
}

// Constructs whose meaning depends on the activation they were written in.
const RELOCATION_HOSTILE_KEYWORDS = ["this", "super", "await", "arguments",
  "eval", "var", "new.target"];

function partsRelocationHostile(parts) {
  const skeleton = partsSkeleton(parts);
  for (const keyword of RELOCATION_HOSTILE_KEYWORDS) {
    if (skeletonKeywordPositions(skeleton, keyword).length) return true;
  }
  return false;
}

// The ambient names a statement assigns.
//
// An ambient name is declared by the tier's outermost scope rather than by
// any statement, so it is not an operand and no `write` record names it -- but
// a unit outlined out of the body still has to write it back. The assignment
// is read off the statement's own skeleton: the name followed by `=`, by a
// compound assignment operator, or by `++`/`--` on either side, and the
// destructuring target the frame materialization writes
// (`[frame, locals, stack] = ...`).
function partsAmbientWrites(parts) {
  const skeleton = partsSkeleton(parts);
  const mask = skeletonCodeMask(skeleton);
  const found = [];
  // The one destructuring target the emitters write: a bracketed list at the
  // head of the statement, assigned as a whole.
  let destructuringEnd = -1;
  const head = skeleton.length - skeleton.trimStart().length;
  if (skeleton[head] === "[" && mask[head]) {
    let depth = 0;
    for (let index = head; index < skeleton.length; index += 1) {
      if (!mask[index]) continue;
      if (skeleton[index] === "[") depth += 1;
      else if (skeleton[index] === "]") {
        depth -= 1;
        if (depth === 0) {
          let after = index + 1;
          while (skeleton[after] === " ") after += 1;
          if (skeleton[after] === "=" && skeleton[after + 1] !== "=") {
            destructuringEnd = index;
          }
          break;
        }
      }
    }
  }
  const assignsAt = (position, length) => {
    if (destructuringEnd > 0 && position > head &&
        position + length <= destructuringEnd) return true;
    let before = position - 1;
    while (skeleton[before] === " ") before -= 1;
    if (before >= 1 && (skeleton[before] === "+" || skeleton[before] === "-") &&
        skeleton[before - 1] === skeleton[before]) return true;
    let after = position + length;
    while (skeleton[after] === " ") after += 1;
    if ((skeleton[after] === "+" || skeleton[after] === "-") &&
        skeleton[after + 1] === skeleton[after]) return true;
    let operators = 0;
    while (operators < 3 &&
      "+-*/%&|^<>".includes(skeleton[after + operators])) operators += 1;
    return skeleton[after + operators] === "=" &&
      skeleton[after + operators + 1] !== "=" &&
      (operators > 0 || skeleton[after + 1] !== ">");
  };
  for (const name of AMBIENT_GENERATED_NAMES) {
    for (const position of skeletonKeywordPositions(skeleton, name, mask)) {
      if (!assignsAt(position, name.length)) continue;
      found.push(name);
      break;
    }
  }
  return found;
}

// Whether the statement declares an ambient name in its own scope
// (`let frame = null;`). Such a statement may not be relocated: the unit it
// would move into already receives that name as a parameter, and a
// declaration of a parameter's name is not even legal there.
function partsDeclaresAmbient(parts) {
  const skeleton = partsSkeleton(parts).trimStart();
  for (const keyword of ["let ", "const ", "var "]) {
    if (!skeleton.startsWith(keyword)) continue;
    let start = keyword.length;
    while (skeleton[start] === " ") start += 1;
    let end = start;
    while (isPartsWordCharacter(skeleton[end])) end += 1;
    return AMBIENT_GENERATED_NAMES.includes(skeleton.slice(start, end));
  }
  return false;
}

// Whether the statement continues the block it closes (`} else {`,
// `} catch (error) {`, `} finally {`). Its nesting delta is zero, but a
// consumer must not treat it as an ordinary statement: it belongs to the
// construct around it and can never be relocated on its own.
function partsContinuesBlock(parts) {
  const skeleton = partsSkeleton(parts).trim();
  return skeleton.startsWith("}") && skeleton.endsWith("{");
}

function partsYields(parts) {
  return skeletonKeywordPositions(partsSkeleton(parts), "yield").length > 0;
}

function partsLabelName(parts) {
  const skeleton = partsSkeleton(parts).trimStart();
  let end = 0;
  while (end < skeleton.length && isPartsWordCharacter(skeleton[end])) {
    end += 1;
  }
  if (end === 0 || skeleton[end] !== ":") return null;
  const name = skeleton.slice(0, end);
  if (name === "case" || name === "default") return null;
  if (skeleton[0] >= "0" && skeleton[0] <= "9") return null;
  return name;
}

// Whether the statement the emitter wrote is a conditional that opens a
// block: `if (<condition>) {`.
function partsOpenCondition(parts) {
  const skeleton = partsSkeleton(parts);
  return skeleton.trimStart().startsWith("if (") && skeleton.endsWith(") {");
}

// Whether the emitter opened a `try` or wrote a `throw` in this statement.
function partsWriteThrowOrTry(parts) {
  const skeleton = partsSkeleton(parts);
  return skeleton.includes("throw ") || skeleton.includes("try {");
}

// Every `return` a statement leaves its activation through, located in the
// statement's own literal chunks. An operand reference contributes exactly one
// placeholder character to the skeleton, so it can neither supply nor split the
// keyword, and the scan skips rendered string literals, so the deopt reason
// `'structured SSA return with active child'` is not one. Anything else that
// reads as a `return` is reported, including a shape no exit emitter is known
// to produce: the caller must either route it or reject the whole variant.
function partsReturnPositions(parts) {
  const skeleton = partsSkeleton(parts);
  const positions = [];
  let quote = null;
  for (let at = 0; at + 6 <= skeleton.length; at += 1) {
    const character = skeleton[at];
    if (quote) {
      if (character === "\\") { at += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character !== "r" || !skeleton.startsWith("return", at)) continue;
    if (isPartsWordCharacter(skeleton[at - 1]) ||
        isPartsWordCharacter(skeleton[at + 6])) continue;
    positions.push(at);
  }
  return positions;
}

// One skeleton range of a parts list, as a parts list. A range boundary that
// falls inside an operand reference has no parts representation, so the caller
// gets null rather than a split name.
function slicePartsRange(parts, start, end) {
  const out = [];
  let offset = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const length = typeof part === "string" ? part.length : 1;
    const partEnd = offset + length;
    if (partEnd > start && offset < end) {
      if (typeof part === "string") {
        const chunk = part.slice(
          Math.max(0, start - offset), Math.min(length, end - offset));
        if (chunk !== "") out.push(chunk);
      } else {
        if (offset < start || partEnd > end) return null;
        out.push(part);
      }
    }
    offset = partEnd;
  }
  return out;
}

// Split `<before>return <value>;<after>` out of one statement's parts. Null
// when the statement carries no return, more than one, or a return whose value
// cannot be delimited -- the caller then keeps the statement or rejects the
// whole insertable variant.
function splitReturnParts(parts) {
  const positions = partsReturnPositions(parts);
  if (positions.length !== 1) return null;
  const skeleton = partsSkeleton(parts);
  const at = positions[0];
  // The statement terminator, outside any rendered string literal.
  let end = -1;
  let quote = null;
  for (let index = at + 6; index < skeleton.length; index += 1) {
    const character = skeleton[index];
    if (quote) {
      if (character === "\\") { index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === ";") { end = index; break; }
  }
  if (end < 0) return null;
  const valueStart = skeleton[at + 6] === ";" ? end : at + 7;
  const before = slicePartsRange(parts, 0, at);
  const value = slicePartsRange(parts, valueStart, end);
  const after = slicePartsRange(parts, end + 1, skeleton.length);
  if (!before || !value || !after) return null;
  return {before, value, after};
}

function partsWriteDivision(parts) {
  const skeleton = partsSkeleton(parts);
  return skeleton.includes(" / ") || skeleton.includes(" % ");
}

function partsWriteIndex(parts) {
  const skeleton = partsSkeleton(parts);
  let open = -1;
  for (let index = 0; index < skeleton.length; index += 1) {
    const character = skeleton[index];
    if (character === "[") { open = index; continue; }
    if (character !== "]" || open < 0) continue;
    if (index > open + 1) return true;
    open = -1;
  }
  return false;
}

function partsLoadEntryArrayElement(parts, entryArrayDataNames) {
  for (let index = 0; index + 1 < parts.length; index += 1) {
    const part = parts[index];
    if (typeof part === "string" || !entryArrayDataNames.has(part.ref)) {
      continue;
    }
    const next = parts[index + 1];
    if (typeof next === "string" && next.startsWith("[")) return true;
  }
  return false;
}

// Opt-in audit of the statement IR (JVM_JIT_VERIFY_STATEMENT_IR=1). Like the
// generated-scope verifier it only re-checks a finished body: it scans the
// rendered text for names the compile minted and reports any line the emitters
// did not record, or whose record disagrees with the operands actually
// present. Nothing in the compiler decides what to emit from this scan; the
// passes read the records, never the characters.
const statementIrAuditIssues = new Map();
function auditStatementIrLines(lines, records, names, label) {
  const note = (issue, line) => {
    const key = `${issue}: ${line}`;
    statementIrAuditIssues.set(key,
      (statementIrAuditIssues.get(key) || 0) + 1);
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const record = records.get(trimmed);
    if (!record) { note(`${label} unrecorded`, trimmed); continue; }
    if (record.foreign) continue;
    const present = [];
    for (const match of trimmed.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (names.has(match[0])) present.push(match[0]);
    }
    const declared = partsReferences(record.parts).sort();
    present.sort();
    if (declared.length !== present.length ||
        declared.some((name, index) => present[index] !== name)) {
      note(`${label} operand mismatch [${declared.join(",")}] vs [` +
        `${present.join(",")}]`, trimmed);
    }
  }
}

function reportStatementIrAudit() {
  return [...statementIrAuditIssues.entries()]
    .sort((left, right) => right[1] - left[1]);
}

// A checked leaf leaves its body through one compiler-owned statement. When
// the body is inserted lexically into a caller, that statement is late-bound
// to the caller-visible result slot and exit label of the inserted scope.
const CHECKED_LEAF_BAIL = "return helpers.asyncInvokeSentinel();";

function retargetCheckedLeafBails(lines, target) {
  const replacement = `{ ${target.result} = ${
    target.returnsVoid ? "false" : "helpers.asyncInvokeSentinel()"}; ` +
    `break ${target.label}; }`;
  let bails = 0;
  const retargeted = lines.map((line) => {
    // Exact-identity expansion of the compiler-owned bail statement.
    const around = line.split(CHECKED_LEAF_BAIL);
    if (around.length === 1) return line;
    bails += 1;
    return around.join(replacement);
  });
  return { lines: retargeted, bails };
}

// Makes one multiple-entry strongly connected component reducible by routing
// every edge into its entries through a synthetic single dispatcher header:
// each rerouted edge records its destination in a per-island state variable and
// jumps to a chain of state-test blocks that fans back out to the real entry.
// Unlike node splitting this adds a constant number of empty blocks, so code
// size stays linear. Entries must sit at operand-stack depth zero so the
// dispatcher carries no join slots. Setter blocks are duplicated per provenance
// (inside/outside the component) so every back edge targets a header that
// dominates it.
function dispatchIrreducibleCfg(cfg, depths, islandIndex) {
  const term = cfg.term;
  const n = term.length;
  const succ = term.map(succOfTerm);
  const index = new Array(n).fill(-1), low = new Array(n).fill(0);
  const stack = [], onStack = new Array(n).fill(false), components = [];
  let nextIndex = 0;
  const visit = (v) => {
    index[v] = low[v] = nextIndex++;
    stack.push(v); onStack[v] = true;
    for (const w of succ[v]) {
      if (w === null || w === undefined) continue;
      if (index[w] < 0) { visit(w); low[v] = Math.min(low[v], low[w]); }
      else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
    }
    if (low[v] === index[v]) {
      const component = [];
      for (;;) { const w = stack.pop(); onStack[w] = false; component.push(w); if (w === v) break; }
      components.push(component);
    }
  };
  for (let v = 0; v < n; v += 1) if (index[v] < 0) visit(v);

  let candidate = null;
  for (const component of components) {
    if (component.length === 1 && !succ[component[0]].includes(component[0])) continue;
    const inside = new Set(component), entries = [];
    for (const node of component) {
      let external = node === cfg.entry ? 1 : 0;
      for (let pred = 0; pred < n; pred += 1) {
        if (!inside.has(pred) && succ[pred].includes(node)) external += 1;
      }
      if (external) entries.push(node);
    }
    if (entries.length > 1) { candidate = { inside, entries: entries.sort((a, b) => a - b) }; break; }
  }
  if (!candidate) return null;
  const entries = candidate.entries;
  const entryDepths = [];
  for (const entry of entries) {
    const block = cfg.blocks[entry];
    if (!block || block.synthetic) return null;
    const depth = depths[block.insns[0]];
    if (!Number.isInteger(depth) || depth > 8) return null;
    entryDepths.push(depth);
  }

  const blocks = cfg.blocks.map((block) => ({ ...block }));
  const terms = term.map((descriptor) => ({ ...descriptor }));
  const stateVariable = `ssaDispatchState${islandIndex}`;
  const transferPrefix = `ssaIslandT${islandIndex}_`;
  const maxDepth = Math.max(...entryDepths);
  const entryPcs = entries.map((entry) => cfg.blocks[entry].insns[0]);
  const shared = {
    island: islandIndex, variable: stateVariable, transfer: transferPrefix,
    entryPcs, entryDepths, maxDepth,
  };
  const addBlock = (synthetic, descriptor) => {
    const id = blocks.length;
    blocks.push({ id, insns: [], synthetic });
    terms.push(descriptor);
    return id;
  };
  // Dispatcher chain: test states 0..k-2 in order; the final fall reaches the
  // last entry without a test. Chain blocks are created back to front.
  let chainNext = entries[entries.length - 1];
  for (let state = entries.length - 2; state >= 0; state -= 1) {
    chainNext = addBlock(
      { ...shared, kind: "dispatch", state },
      { kind: "cond", taken: entries[state], fall: chainNext },
    );
  }
  const dispatchHead = chainNext;
  const setterFor = new Map();
  const makeSetter = (entry, state, provenance) => addBlock(
    { ...shared, kind: "set", state, depth: entryDepths[state], provenance },
    { kind: "goto", target: dispatchHead },
  );
  entries.forEach((entry, state) => {
    setterFor.set(entry, {
      inside: makeSetter(entry, state, "inside"),
      outside: makeSetter(entry, state, "outside"),
    });
  });
  const remap = (u) => {
    const provenance = candidate.inside.has(u) ? "inside" : "outside";
    const reroute = (target) => setterFor.has(target) ? setterFor.get(target)[provenance] : target;
    const descriptor = terms[u];
    if (descriptor.kind === "goto" || descriptor.kind === "fall") {
      descriptor.target = reroute(descriptor.target);
    } else if (descriptor.kind === "cond") {
      descriptor.taken = reroute(descriptor.taken);
      descriptor.fall = reroute(descriptor.fall);
    }
  };
  for (let u = 0; u < n; u += 1) remap(u);
  const entryState = entries.indexOf(cfg.entry);
  return {
    ...cfg,
    n: blocks.length,
    blocks,
    term: terms,
    succ: terms.map(succOfTerm),
    succAll: terms.map(succAllOfTerm),
    entry: entryState >= 0 ? setterFor.get(cfg.entry).outside : cfg.entry,
  };
}

// Compiles verified reducible JVM control flow into lexical JavaScript.
// Instruction results are single-assignment values; control-flow edges feed
// live operand values into fixed successor-block join slots. Canonical Frame
// state is reconstructed only where the JVM can observe it. Acyclic regions
// use the same renderer without generator/safe-point machinery.
class JvmSsaBlockRenderer {
  constructor(jit, options = {}) {
    this.jit = jit;
    // Development assertion: re-parse each finished tier and confirm that no
    // SSA name is referenced outside a scope that declares it. Emission is
    // responsible for that by construction, so this is off in production.
    this.verifyGeneratedScopes = (typeof process !== "undefined" &&
      process.env && process.env.JVM_JIT_VERIFY_GENERATED === "1") || false;
    // SSA operand names are drawn from one counter for the lifetime of the
    // renderer so that no two compiles ever mint the same name. Checked
    // leaves are inserted lexically into their callers, and every name-keyed
    // record in a compile (integer provenance, the generated-scope audit)
    // would otherwise conflate a child's value with an identically named
    // value of the caller.
    this.nextSsaValue = 0;
    const environment = typeof process !== "undefined" && process.env
      ? process.env : {};
    const explicitlyEnabled = options.structuredSsa === true ||
      environment.JVM_ENABLE_STRUCTURED_SSA === "1";
    this._enabled = options.structuredSsa !== false &&
      environment.JVM_DISABLE_STRUCTURED_SSA !== "1";
    // Verified primitive-array loop bodies are the part of this tier with a
    // repeatable steady-state payoff, and compile() already rejects
    // unsupported CFGs and opcodes before emitting code. Enable that
    // conservative subset by default. Explicit structuredSsa=true retains the
    // broader acyclic-region experiment used by positional-call benchmarks.
    this.arrayLoopsOnly = !explicitlyEnabled;
    Object.defineProperty(this, "enabled", {
      configurable: true,
      enumerable: true,
      get: () => this._enabled,
      set: (value) => {
        this._enabled = Boolean(value);
        // Runtime probe switches historically toggled .enabled directly to
        // request the complete tier. Preserve that API while keeping only the
        // array-loop subset enabled in an untouched default runtime.
        if (value) this.arrayLoopsOnly = false;
      },
    });
    this.irreducibleSplittingEnabled = options.structuredIrreducibleSplitting === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_STRUCTURED_IRREDUCIBLE_SPLITTING === "1");
    this.dispatchIslandsEnabled = options.structuredDispatchIslands !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_DISPATCH_ISLANDS === "1");
    this.deferredCallMaterializationEnabled =
      options.structuredDeferredCallMaterialization !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_DEFERRED_CALL_MATERIALIZATION === "1");
    this.localValueNumberingEnabled = options.structuredLocalValueNumbering !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_LOCAL_VALUES === "1");
    this.guardedStaticBooleansEnabled = options.structuredGuardedStaticBooleans !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_STATIC_BOOLEAN_GUARDS === "1");
    this.continuationsEnabled = options.structuredContinuations !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_CONTINUATIONS === "1");
    this.coarseCountedLoopSafePointsEnabled =
      options.structuredCoarseCountedLoopSafePoints !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_COARSE_COUNTED_SAFEPOINTS === "1");
    this.versionedRuntimeCoarseLoopsEnabled =
      options.structuredVersionedRuntimeCoarseLoops !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_VERSIONED_COARSE_LOOPS === "1");
    this.versionedArrayRangesEnabled =
      options.structuredVersionedArrayRanges !== false &&
      options.structuredVersionedArrayRangeStores !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_VERSIONED_ARRAY_RANGES === "1") &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_VERSIONED_ARRAY_STORES === "1");
    // Retain the old runtime probe property while range versioning expands
    // from stores to structurally proven primitive loads.
    this.versionedArrayRangeStoresEnabled =
      this.versionedArrayRangesEnabled;
    this.bitBoundedArrayRangesEnabled =
      this.versionedArrayRangesEnabled &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_BIT_BOUNDED_RANGES === "1");
    this.directEntryStaticLinkingEnabled =
      options.structuredDirectEntryStaticLinking !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_DIRECT_ENTRY_STATIC_LINKING === "1");
    this.atomicBoundedLoopsEnabled =
      options.structuredAtomicBoundedLoops !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_ATOMIC_BOUNDED_LOOPS === "1");
    this.materializeOutliningEnabled =
      options.structuredMaterializeOutlining !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_SSA_MATERIALIZE_OUTLINING === "1");
    this.unwindCompactMaterializationDisabled =
      options.structuredUnwindCompactMaterialization === false ||
      (typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_SSA_UNWIND_COMPACT_MATERIALIZATION === "1");
    this.acyclicInlineRestoringSpillsEnabled =
      options.structuredAcyclicInlineRestoringSpills !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_SSA_ACYCLIC_INLINE_SPILLS === "1");
    this.loopInlineRestoringSpillsEnabled =
      options.structuredLoopInlineRestoringSpills !== false &&
      environment.JVM_DISABLE_SSA_LOOP_INLINE_SPILLS !== "1";
    this.loopInlineRestoringSpillBudget = Math.max(0, Math.min(4096,
      Number(options.structuredLoopInlineRestoringSpillBudget ?? 512) || 0));
    this.checkedLeafDirectPositionalEnabled =
      options.checkedLeafDirectPositional === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_CHECKED_LEAF_POSITIONAL === "1");
    this.unsignedArrayBoundsEnabled =
      options.structuredUnsignedArrayBounds !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_UNSIGNED_ARRAY_BOUNDS === "1");
    this.inlinePrimitiveArrayStoresEnabled =
      options.structuredInlinePrimitiveArrayStores !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_INLINE_ARRAY_STORES === "1");
    this.dominatedFieldReceiverChecksEnabled =
      options.structuredDominatedFieldReceiverChecks !== false &&
      environment.JVM_DISABLE_STRUCTURED_DOMINATED_FIELD_RECEIVER_CHECKS !== "1";
    this.staticPrimitiveArrayKindsEnabled =
      options.structuredStaticPrimitiveArrayKinds !== false &&
      environment.JVM_DISABLE_STRUCTURED_STATIC_ARRAY_KINDS !== "1";
    this.loopInvariantStaticArrayViewsEnabled =
      options.structuredLoopInvariantStaticArrayViews === true ||
      environment.JVM_ENABLE_STRUCTURED_LOOP_STATIC_ARRAY_VIEWS === "1";
    // Dynamic per-block arrayData() snapshots are useful for source-shape
    // experiments but can cost more than the representation branch they
    // replace when the host does not inline the helper. Keep the proven
    // entry/static views as the production path; this broader experiment is
    // opt-in until its end-to-end throughput exceeds that baseline.
    this.blockArrayDataViewsEnabled =
      options.structuredBlockArrayDataViews === true ||
      environment.JVM_ENABLE_STRUCTURED_BLOCK_ARRAY_DATA_VIEWS === "1";
    this.fieldArrayLocalViewsEnabled =
      options.structuredFieldArrayLocalViews !== false &&
      environment.JVM_DISABLE_STRUCTURED_FIELD_ARRAY_LOCAL_VIEWS !== "1";
    this.producedArrayLocalViewsEnabled =
      options.structuredProducedArrayLocalViews === true ||
      environment.JVM_ENABLE_STRUCTURED_PRODUCED_ARRAY_LOCAL_VIEWS === "1";
    this.indirectArrayRangesEnabled =
      options.structuredIndirectArrayRanges !== false &&
      environment.JVM_DISABLE_STRUCTURED_INDIRECT_ARRAY_RANGES !== "1";
    this.longOpcodesEnabled = options.structuredLongOpcodes !== false &&
      environment.JVM_DISABLE_STRUCTURED_LONG_OPCODES !== "1";
    this.fixedPointScalarizationEnabled =
      options.structuredFixedPointScalarization !== false &&
      environment.JVM_DISABLE_STRUCTURED_FIXED_POINT_SCALARIZATION !== "1";
    this.perLoopPollBudgetsEnabled =
      options.structuredPerLoopPollBudgets === true ||
      environment.JVM_ENABLE_STRUCTURED_PER_LOOP_POLL_BUDGETS === "1";
    this.linearPartitionEnabled =
      options.structuredLinearPartition === true ||
      environment.JVM_ENABLE_STRUCTURED_LINEAR_PARTITION === "1";
    this.linearPartitionUnitBytes = Math.max(16384, Math.min(262144,
      Number(options.structuredLinearPartitionUnitBytes ??
        environment.JVM_STRUCTURED_LINEAR_PARTITION_UNIT_BYTES) || 49152));
    this.linearPartitionSegmentBytes = Math.max(4096, Math.min(131072,
      Number(options.structuredLinearPartitionSegmentBytes ??
        environment.JVM_STRUCTURED_LINEAR_PARTITION_SEGMENT_BYTES) || 32768));
    this.linearPartitionMinimumSegmentBytes = Math.max(1024, Math.min(32768,
      Number(options.structuredLinearPartitionMinimumSegmentBytes ??
        environment.JVM_STRUCTURED_LINEAR_PARTITION_MINIMUM_SEGMENT_BYTES) ||
        8192));
    this.loopOutliningEnabled =
      options.structuredLoopOutlining === true ||
      environment.JVM_ENABLE_STRUCTURED_LOOP_OUTLINING === "1";
    this.loopOutlineSourceBytes = Math.max(512, Math.min(262144,
      Number(options.structuredLoopOutlineSourceBytes ??
        environment.JVM_STRUCTURED_LOOP_OUTLINE_SOURCE_BYTES) || 16384));
    this.switchesEnabled = options.structuredSwitches !== false &&
      environment.JVM_DISABLE_STRUCTURED_SWITCHES !== "1";
    this.restoringRangeGuardDeoptEnabled =
      options.structuredRestoringRangeGuardDeopt !== false &&
      environment.JVM_DISABLE_STRUCTURED_RESTORING_RANGE_DEOPT !== "1";
    this.loopInvariantDivisorGuardsEnabled =
      options.structuredLoopInvariantDivisorGuards === true ||
      environment.JVM_ENABLE_STRUCTURED_LOOP_INVARIANT_DIVISORS === "1";
    this.restoringDirectFieldLayoutsEnabled =
      options.structuredRestoringDirectFieldLayouts !== false &&
      environment.JVM_DISABLE_STRUCTURED_RESTORING_FIELD_LAYOUTS !== "1";
    // Per-invocation global mutations are profiling, not execution semantics.
    // They are particularly hostile to host inlining across a hot call graph,
    // so production leaves them out of emitted code. Focused diagnostics and
    // the counter-asserting test suite opt in explicitly.
    this.runCountersEnabled = options.structuredRunCounters !== false &&
      (options.structuredRunCounters === true ||
        environment.JVM_ENABLE_STRUCTURED_RUN_COUNTERS === "1" ||
        environment.JVM_PROFILE_JIT_METHODS === "1");
    this.restoringDirectBudgetMultiplier = Math.max(1, Math.min(100,
      Number(options.structuredRestoringDirectBudgetMultiplier ??
        (typeof process !== "undefined" && process.env &&
          process.env.JVM_STRUCTURED_RESTORING_DIRECT_BUDGET_MULTIPLIER) ??
        100) || 100));
    this.dispatchIslandMethodCount = 0;
    this.dispatchIslandCount = 0;
    this.compiledLoopCount = 0;
    this.splitMethodCount = 0;
    this.splitBlockCount = 0;
    this.runCount = 0;
    this.safePointCount = 0;
    this.guardedBooleanMethodCount = 0;
    this.guardedBooleanSiteCount = 0;
    this.guardedBooleanFallbackCount = 0;
    this.fieldBackedArrayContinuationFallbackCount = 0;
    this.restoredDirectExceptionFrameCount = 0;
    this.restoringDirectRunCount = 0;
    this.lazyStaticTargetLinkCount = 0;
    this.persistentProducedArrayLocalViewCompileCount = 0;
    this.loopInvariantStaticArrayViewCompileCount = 0;
    // Generated bodies retain only an index into this table. A successful
    // proof is reusable until either class lifecycle epoch advances.
    this.classInitializationGuards = [];
    // Restoring bodies call this table only on cold scheduler/exception
    // transfers. Keeping slot layouts out of generated source avoids either
    // a closure over every hot scalar or repeated Frame reconstruction code.
    this.restoringFrameLayouts = [];
    this.lastCompileError = null;
    this.lastRejectionReason = null;
    this.lastFailedSource = null;
  }

  registerClassInitializationGuard(owners) {
    const guard = {
      // A cold owner has no direct initialized state to preserve. Its
      // generated getstatic/putstatic/invokestatic site retains the exact
      // initialization-token check and materializing fallback at that
      // bytecode. Guarding it at method entry would reject unrelated paths
      // and make safe class preloading useless. Owners whose initialized
      // storage or links were observed while compiling remain guarded.
      owners: [...new Set(owners)].filter((owner) =>
        this.jit.jvm.classInitializationState.get(owner) === "INITIALIZED"),
      classEpoch: -1,
      initializationEpoch: -1,
    };
    const id = this.classInitializationGuards.length;
    this.classInitializationGuards.push(guard);
    return id;
  }

  get totalRunCount() {
    // Restoring positional entries are tracked separately so a tiny child
    // kernel does not perform two property writes per call. Add the disjoint
    // counters only when diagnostics are sampled or reported.
    return this.runCount + this.restoringDirectRunCount;
  }

  verifyClassInitializationGuard(guard) {
    if (!guard) return false;
    for (const owner of guard.owners) {
      if (this.jit.jvm.classInitializationState.get(owner) !== "INITIALIZED") {
        return false;
      }
    }
    guard.classEpoch = this.jit.jvm.classEpoch || 0;
    guard.initializationEpoch = this.jit.jvm.classInitializationEpoch || 0;
    return true;
  }

  restoreDirectFrame(layoutId, plan, thread, restorationDepth, frame, values) {
    const slots = this.restoringFrameLayouts[layoutId];
    if (!Array.isArray(slots) || !Array.isArray(values) ||
        slots.length !== values.length) {
      throw new Error("invalid structured SSA restoring-frame layout");
    }
    if (frame === null) {
      frame = plan.target.freeFrame || new plan.Frame(plan.method);
      plan.target.freeFrame = null;
      plan.clearStructuredContinuation?.(frame);
      frame.pc = 0;
      frame.stack.items.length = 0;
      delete frame.jitSkipOnce;
      delete frame.jitJsDisabled;
      delete frame.jitAdaptiveEntryCounted;
      frame.className = plan.lookupClass;
    }
    const locals = frame.locals;
    const stack = frame.stack.items;
    for (let index = 0; index < slots.length; index += 1) {
      locals[slots[index]] = values[index];
    }
    plan.restoreFrame(thread, frame, restorationDepth);
    return [frame, locals, stack];
  }

  materializeDirectFrame(layoutId, plan, thread, restorationDepth, frame,
    values, pc, operands) {
    const state = this.restoreDirectFrame(
      layoutId, plan, thread, restorationDepth, frame, values);
    const stack = state[2];
    stack.length = operands.length;
    for (let index = 0; index < operands.length; index += 1) {
      stack[index] = operands[index];
    }
    this.jit.materialize(state[0], state[1], stack, pc);
    return state;
  }

  // A throwing site whose pc is covered by no in-method exception handler
  // only needs a frame for unwinding: the method is popped during dispatch
  // and its locals are never consulted again. Emitting the full live-locals
  // array at hundreds of such sites is what pushes large restoring bodies
  // past the host engine's optimized-bytecode budget, so those sites
  // materialize a locals-free frame instead. Locals are cleared rather than
  // left stale so recycled frames cannot leak old values into diagnostics.
  materializeUnwindFrame(plan, thread, restorationDepth, frame, pc,
    operands) {
    if (frame === null) {
      frame = plan.target.freeFrame || new plan.Frame(plan.method);
      plan.target.freeFrame = null;
      plan.clearStructuredContinuation?.(frame);
      frame.pc = 0;
      frame.stack.items.length = 0;
      delete frame.jitSkipOnce;
      delete frame.jitJsDisabled;
      delete frame.jitAdaptiveEntryCounted;
      frame.className = plan.lookupClass;
    }
    const locals = frame.locals;
    locals.fill(undefined);
    const stack = frame.stack.items;
    plan.restoreFrame(thread, frame, restorationDepth);
    stack.length = operands.length;
    for (let index = 0; index < operands.length; index += 1) {
      stack[index] = operands[index];
    }
    this.jit.materialize(frame, locals, stack, pc);
    return [frame, locals, stack];
  }

  // If the helper following an unwind-only materialization returns instead
  // of throwing (a tolerant diagnostic mode, or a value the sentinel guard
  // misclassified), the locals-free frame must not remain live: a later
  // "frame === null" restoration guard would skip it and resume with empty
  // locals. Withdraw the frame and restore the frameless invariant.
  releaseUnwindFrame(plan, thread, frame) {
    if (frame !== null) {
      const frames = thread.callStack.items;
      const index = frames.lastIndexOf(frame);
      if (index >= 0) frames.splice(index, 1);
      if (plan.target.freeFrame === null) plan.target.freeFrame = frame;
    }
    return null;
  }

  compile(method) {
    // One method is rendered at a time; a nested compile (a checked leaf's
    // own body) must not leave the outer compile's name registry active.
    const previousEmittedNames = activeEmittedNames;
    const previousOperandExpressions = activeOperandExpressions;
    try {
      return this.compileMethodBody(method);
    } finally {
      activeEmittedNames = previousEmittedNames;
      activeOperandExpressions = previousOperandExpressions;
    }
  }

  compileMethodBody(method) {
    this.lastCompileError = null;
    this.lastRejectionReason = null;
    this.lastFailedSource = null;
    const reject = (reason) => {
      this.lastRejectionReason = reason;
      return null;
    };
    const compiledMethodIdentity =
      `${this.jit.jvm.findClassNameForMethod?.(method) || method.className || "?"}.` +
      `${method.name}${method.descriptor}`;
    // Every compile owns a serial. The names a checked-leaf body exposes to a
    // lexical caller (its result slot and exit label) and the names a caller
    // stages for an inserted body carry it, so no insertion collides with the
    // enclosing body or with another inserted body at any nesting depth.
    this.compileSerial = (this.compileSerial || 0) + 1;
    const compileSerial = this.compileSerial;
    const checkedLeafResultVariable = `ssaInlineResult${compileSerial}`;
    const checkedLeafBodyLabel = `ssaInlineBody${compileSerial}`;
    const guardedStaticBooleanSpecializationEnabled =
      this.guardedStaticBooleansEnabled &&
      !this.jit.effectfulPreparationActive &&
      !this.jit.nonSpeculativeStaticBooleanMethods?.has(method);
    const normalizeJvmScalarExpression = (expression, type) => ({
      Z: e`((Number(${expression})) ? 1 : 0)`,
      boolean: e`((Number(${expression})) ? 1 : 0)`,
      B: e`(((Number(${expression})) << 24) >> 24)`,
      byte: e`(((Number(${expression})) << 24) >> 24)`,
      C: e`((Number(${expression})) & 0xffff)`,
      char: e`((Number(${expression})) & 0xffff)`,
      S: e`(((Number(${expression})) << 16) >> 16)`,
      short: e`(((Number(${expression})) << 16) >> 16)`,
      I: e`((Number(${expression})) | 0)`,
      int: e`((Number(${expression})) | 0)`,
      J: e`BigInt.asIntN(64, BigInt(${expression}))`,
      long: e`BigInt.asIntN(64, BigInt(${expression}))`,
      F: e`Math.fround(Number(${expression}))`,
      float: e`Math.fround(Number(${expression}))`,
      D: e`Number(${expression})`,
      double: e`Number(${expression})`,
    })[type] || expression;
    if (!this.enabled || !this.jit.canCompileSynchronously(method)) {
      return reject("disabled or asynchronous");
    }
    if (this.arrayLoopsOnly &&
        !this.jit.isCallGraphStructuredFirstMethod(method)) {
      const items = this.jit.getCodeItems(method);
      const primitiveArrayOperation = items.some((item) => {
        const instruction = item?.instruction;
        const op = opcodeOf(instruction);
        return op === "arraylength" ||
          PRIMITIVE_ARRAY_ACCESS_OPCODES.has(op);
      });
      if (!this.jit.hasBackwardBranch(method) || !primitiveArrayOperation) {
        return reject("default policy requires a primitive-array loop");
      }
    }
    const code = method.attributes.find((attribute) => attribute.type === "code");
    if (!code) return reject("missing code attribute");
    const items = this.jit.getCodeItems(method);
    if (!this.longOpcodesEnabled && items.some((item) =>
      STRUCTURED_LONG_OPCODES.has(opOf(item?.instruction)))) {
      return reject("structured long opcodes disabled");
    }
    // Throwing instructions below materialize their exact JVM PC, locals, and
    // operand stack before rethrowing. The ordinary JVM dispatcher can
    // therefore select any guest handler, and withResumeBody resumes that
    // handler in the baseline/interpreter rather than re-entering this
    // partially completed SSA invocation. Handler blocks need not be rendered
    // as part of normal control flow.
    let cfg = buildCfgFromCode(items);
    if (!cfg) return reject("missing CFG");
    if (!this.switchesEnabled && cfg.term.some((term) =>
      term?.kind === "switch")) {
      return reject("structured switches disabled");
    }
    const labels = new Map();
    items.forEach((item, index) => {
      if (item?.labelDef) labels.set(String(item.labelDef).replace(/:$/, ""), index);
    });
    const depths = this.jit.computeStackDepths(items, labels, method);
    if (!depths) return reject("operand-stack verification failed");
    let verifiedStackWidthsBefore = null;
    if (items.some((item) => {
      const instruction = item?.instruction;
      const op = typeof instruction === "string"
        ? instruction.trim().split(/\s+/)[0] : instruction?.op;
      return op === "dup2" || op === "dup_x1" || op === "dup_x2";
    })) {
      const analysis = buildSsa({
        codeItems: items,
        exceptionTable: code.code.exceptionTable || [],
        method,
      });
      if (!analysis || analysis.rejected || !analysis.stackKindsBefore) {
        return reject("operand category verification failed");
      }
      verifiedStackWidthsBefore = new Map();
      for (const [index, kinds] of analysis.stackKindsBefore) {
        verifiedStackWidthsBefore.set(index, kinds.map(kindWidth));
      }
    }
    let prunedBooleanCfgBranches = 0;
    const prunedBooleanBranchTargets = new Map();
    const prunedBooleanReadIndexes = new Set();
    if (guardedStaticBooleanSpecializationEnabled) {
      const instructionOp = (instruction) => !instruction ? null
        : typeof instruction === "string" ? instruction : instruction.op;
      const localSlot = (instruction, op) => {
        if (instruction && typeof instruction === "object" &&
            instruction.arg !== undefined) return Number(instruction.arg);
        const match = /_([0-3])$/.exec(op || "");
        return match ? Number(match[1]) : NaN;
      };
      for (let index = 0; index + 1 < items.length; index += 1) {
        const read = items[index]?.instruction;
        if (instructionOp(read) !== "getstatic" ||
            read.arg?.[2]?.[1] !== "Z") continue;
        const [, owner, [fieldName, descriptor]] = read.arg;
        if (this.jit.jvm.classInitializationState.get(owner) !==
            "INITIALIZED") continue;
        const fieldKey = JSON.stringify(read.arg);
        if (items.some((item) =>
          instructionOp(item?.instruction) === "putstatic" &&
          JSON.stringify(item.instruction.arg) === fieldKey)) continue;
        const store = items[index + 1]?.instruction;
        const storeOp = instructionOp(store);
        if (!/^istore(?:_[0-3])?$/.test(storeOp)) continue;
        const slot = localSlot(store, storeOp);
        if (!Number.isInteger(slot)) continue;
        let writes = 0;
        for (const item of items) {
          const instruction = item?.instruction;
          const op = instructionOp(instruction);
          if ((op === "iinc" &&
              Number(instruction.varnum ?? instruction.arg) === slot) ||
              (/^istore(?:_[0-3])?$/.test(op) &&
              localSlot(instruction, op) === slot)) writes += 1;
        }
        if (writes !== 1) continue;
        const target = this.jit.resolveStaticFieldSite({
          className: owner, fieldName, descriptor,
        }, false);
        if (!target) continue;
        const raw = target.kind === "map"
          ? target.fields.get(target.key) : target.fields[target.key];
        const booleanValue = raw ? 1 : 0;
        for (const block of cfg.blocks) {
          const blockItems = block.insns || [];
          if (blockItems.length < 2) continue;
          const branchIndex = blockItems[blockItems.length - 1];
          const loadIndex = blockItems[blockItems.length - 2];
          const branch = items[branchIndex]?.instruction;
          const branchOp = instructionOp(branch);
          const load = items[loadIndex]?.instruction;
          const loadOp = instructionOp(load);
          if ((branchOp !== "ifeq" && branchOp !== "ifne") ||
              !/^iload(?:_[0-3])?$/.test(loadOp) ||
              localSlot(load, loadOp) !== slot ||
              cfg.term[block.id]?.kind !== "cond") continue;
          const take = branchOp === "ifeq"
            ? booleanValue === 0 : booleanValue !== 0;
          const term = cfg.term[block.id];
          cfg.term[block.id] = {
            kind: "goto",
            target: take ? term.taken : term.fall,
          };
          prunedBooleanBranchTargets.set(
            branchIndex, cfg.term[block.id].target);
          prunedBooleanReadIndexes.add(index);
          prunedBooleanCfgBranches += 1;
        }
      }
      if (prunedBooleanCfgBranches > 0) {
        cfg.succ = cfg.term.map(succOfTerm);
        cfg.succAll = cfg.term.map(succAllOfTerm);
      }
    }
    let structured;
    let splitBlocks = 0;
    let dispatchIslands = 0;
    try { structured = structure(cfg); } catch (error) {
      if (!isIrreducibleError(error)) {
        this.lastCompileError = error;
        return reject(`CFG structuring failed: ${error.message}`);
      }
      if (this.dispatchIslandsEnabled) {
        let current = cfg;
        for (let round = 0; round < 8 && !structured; round += 1) {
          const transformed = dispatchIrreducibleCfg(current, depths, dispatchIslands);
          if (!transformed) break;
          current = transformed;
          dispatchIslands += 1;
          try { structured = structure(current); cfg = current; } catch (retryError) {
            if (!isIrreducibleError(retryError)) break;
          }
        }
        if (!structured) dispatchIslands = 0;
      }
      if (!structured && this.irreducibleSplittingEnabled) {
        const maximumBlocks = Math.min(256, cfg.n * 2);
        const split = splitIrreducibleTerms(cfg.term, cfg.entry, { maxTerms: maximumBlocks });
        if (!split || split.terms.length > maximumBlocks) {
          this.lastCompileError = error;
          return reject(`CFG structuring failed: ${error.message}`);
        }
        const originalBlocks = cfg.blocks;
        cfg = {
          ...cfg,
          n: split.terms.length,
          term: split.terms,
          succ: split.terms.map(succOfTerm),
          succAll: split.terms.map(succAllOfTerm),
          blocks: split.origins.map((origin, id) => ({ ...originalBlocks[origin], id })),
        };
        splitBlocks = cfg.n - originalBlocks.length;
        try { structured = structure(cfg); } catch (retryError) {
          this.lastCompileError = retryError;
          return reject(`split CFG structuring failed: ${retryError.message}`);
        }
      }
      if (!structured) {
        this.lastCompileError = error;
        return reject(`CFG structuring failed: ${error.message}`);
      }
    }
    // Exception handlers are entered by the JVM dispatcher after a throwing
    // operation has materialized the precise frame. They are deliberately not
    // successors in the normal CFG and must not make the normal positional
    // region look as though it allocates, invokes diagnostic builders, or
    // contains unsupported reference operations.
    const normalReachableItems = new Set();
    const reachableBlocks = new Set();
    const reachableWork = [cfg.entry];
    while (reachableWork.length) {
      const blockId = reachableWork.pop();
      if (!Number.isInteger(blockId) || reachableBlocks.has(blockId) ||
          !cfg.blocks[blockId]) continue;
      reachableBlocks.add(blockId);
      for (const itemIndex of cfg.blocks[blockId].insns || []) {
        normalReachableItems.add(itemIndex);
      }
      for (const successor of cfg.succ[blockId] || []) {
        if (!reachableBlocks.has(successor)) reachableWork.push(successor);
      }
    }
    const localCount = Number(code.code.localsSize) || 0;
    // `frame`, `locals`, `stack`, `thread`, `helpers`, `plan`,
    // `restorationDepth`, `safePointBudget`, `nestedEntryGuarded` and
    // `framelessEntry` are ambient: every generated tier declares them in its
    // outermost scope and no pass ever renames, propagates or eliminates one.
    // They are deliberately not operands. `AMBIENT_GENERATED_NAMES` records
    // them for the published fragments, whose consumer needs the free-variable
    // set of an outlined unit.
    const emittedNames = new Set([checkedLeafResultVariable]);
    for (let slot = 0; slot < localCount; slot += 1) {
      emittedNames.add(`local${slot}`);
    }
    for (let index = 0; index < 64; index += 1) {
      emittedNames.add(`argument${index}`);
    }
    const operandExpressions = new Map();
    activeEmittedNames = emittedNames;
    activeOperandExpressions = operandExpressions;
    // Renders a composite operand once and remembers its parts, so that every
    // later interpolation of the same operand text carries the same operand
    // references.
    const operand = (expression) => {
      const text = String(expression);
      if (expression instanceof Expr && !operandExpressions.has(text)) {
        operandExpressions.set(text, expression.parts);
      }
      return text;
    };
    const named = (name) => { emittedNames.add(name); return name; };
    const primitiveArrayAccessMarker = (name) => {
      primitiveArrayAccessMarkers.add(named(name));
      return name;
    };
    const entryArrayDataName = (name) => {
      entryArrayDataNames.add(named(name));
      return name;
    };
    const localNameSlots = new Map();
    for (let slot = 0; slot < localCount; slot += 1) {
      localNameSlots.set(`local${slot}`, slot);
    }
    const localName = (slot) => `local${slot}`;
    const fieldSites = new Map();
    const directStaticSites = new Map();
    const lazyStaticSites = new Map();
    const directStaticOwners = new Set();
    const loopInvariantStaticArrayViewsByItem = new Map();
    const loopInvariantStaticArrayViewsByHeader = new Map();
    const directStaticEmissionsByItem = new Map();
    const callSites = new Map();
    const checkedCallAdmissionCandidates = [];
    const selfRecursiveCallExpressions = new Map();
    const positionalCallSiteVariable = (index) => `ssaCallSite${index}`;
    const positionalCallTargetVariable = (index) =>
      `ssaFastPositional${index}`;
    const positionalCallInvokeVariable = (index) =>
      `ssaFastPositionalInvoke${index}`;
    const positionalCallRawInvokeVariable = (index) =>
      `ssaFastPositionalRawInvoke${index}`;
    const positionalCallReceiverVariable = (index) =>
      `ssaFastPositionalReceiver${index}`;
    const positionalCallLateLinkVariable = (index) =>
      `ssaLateLinkPositional${index}`;
    const invariantPositionalRawVariable = (index) =>
      named(`ssaInvariantPositionalRaw${index}`);
    for (let index = 0; index < items.length; index += 1) {
      if (depths[index] === undefined || !normalReachableItems.has(index)) continue;
      const instruction = items[index]?.instruction;
      const op = typeof instruction === "string" ? instruction : instruction?.op;
      if (op === "getfield" || op === "putfield" || op === "getstatic" || op === "putstatic") {
        const fieldSite = this.jit.registerFieldSite(instruction.arg);
        fieldSites.set(index, fieldSite);
        if (op === "getstatic" || op === "putstatic") {
          const direct = this.jit.registerDirectStaticTarget(fieldSite, op === "putstatic");
          if (direct) {
            direct.variable = named(
              `ssaStaticFields${directStaticSites.size}`);
            direct.op = op;
            direct.descriptor = Array.isArray(instruction.arg?.[2])
              ? instruction.arg[2][1] : null;
            directStaticSites.set(index, direct);
            directStaticOwners.add(direct.className);
          } else if (op === "getstatic" &&
              !(typeof process !== "undefined" && process.env &&
                process.env.JVM_DISABLE_STRUCTURED_LAZY_STATIC_TARGETS === "1")) {
            const plan = this.jit.fieldSites[fieldSite];
            const lazy = {
              site: fieldSite,
              variable: named(`ssaLazyStaticTarget${lazyStaticSites.size}`),
              className: plan.className,
            };
            lazyStaticSites.set(index, lazy);
            // The direct location can be learned only after initialization,
            // so give cold-compiled methods the same before-effects class
            // lifecycle guard as locations resolved during compilation.
            directStaticOwners.add(plan.className);
          }
        }
      } else if ((op === "invokestatic" || op === "invokevirtual" ||
          op === "invokespecial" || op === "invokeinterface") &&
          Array.isArray(instruction?.arg) && Array.isArray(instruction.arg[2])) {
        let descriptor;
        try { descriptor = parseDescriptor(instruction.arg[2][1]); } catch (_) {
          return reject(`invalid call descriptor at ${index}`);
        }
        if (!descriptor || !Array.isArray(descriptor.params)) return reject(`invalid call shape at ${index}`);
        const isStatic = op === "invokestatic";
        const callOwner = instruction.arg[1];
        const callMember = instruction.arg[2];
        const callOwnerClass = typeof callOwner === "string"
          ? this.jit.jvm.classes[callOwner] : null;
        const resolvedCallMethod = callOwnerClass
          ? this.jit.jvm.findMethod(
            callOwnerClass, callMember[0], callMember[1]) : null;
        const ownerDefinition = callOwnerClass?.ast?.classes?.[0] || null;
        const ownerIsFinal = (ownerDefinition?.flags || []).includes("final") ||
          (Number(ownerDefinition?.accessFlags) & 0x0010) !== 0;
        const resolvedFlags = resolvedCallMethod?.flags || [];
        const targetCannotOverride = isStatic || op === "invokespecial" ||
          ownerIsFinal || resolvedFlags.includes("final") ||
          resolvedFlags.includes("private") ||
          (Number(resolvedCallMethod?.accessFlags) & (0x0010 | 0x0002)) !== 0;
        const selfRecursive = resolvedCallMethod === method &&
          targetCannotOverride;
        const directJre = this.jit.getCompileTimeDirectJre(op, instruction);
        const inline = directJre || !isStatic
          ? null : this.jit.getCompileTimeIntegerLeaf(instruction, true);
        if (inline?.className) directStaticOwners.add(inline.className);
        const directIntrinsic = directJre || !isStatic || inline
          ? null : this.jit.getCompileTimeSynchronousIntrinsic(instruction);
        const directCheckedLeaf = directJre || !isStatic || inline ||
          directIntrinsic ? null :
          this.jit.getCompileTimeCheckedLeaf(instruction);
        const checkedLeafCaptureCacheId =
          Array.isArray(directCheckedLeaf?.captures) &&
          directCheckedLeaf.captures.length > 0
            ? this.jit.registerCheckedLeafCaptureCache(
              directCheckedLeaf.captures)
            : null;
        if (directCheckedLeaf) {
          directStaticOwners.add(instruction.arg[1]);
          for (const capture of directCheckedLeaf.captures || []) {
            if (capture.className) directStaticOwners.add(capture.className);
          }
        }
        const callSiteId = directJre || inline || directIntrinsic
          ? null : this.jit.registerSyncCallSite(
            op, instruction, method, index);
        callSites.set(index, {
          id: callSiteId,
          pc: index,
          op,
          declaredOwner: callOwner,
          memberName: callMember[0],
          descriptor: callMember[1],
          resolvedMethod: resolvedCallMethod,
          exactTarget: targetCannotOverride,
          dynamic: op === "invokevirtual" || op === "invokeinterface",
          hasReceiver: !isStatic,
          argumentCount: descriptor.params.length + (isStatic ? 0 : 1),
          returnType: descriptor.returnType,
          returnsVoid: descriptor.returnType === "void",
          directJre,
          inline,
          directIntrinsic,
          directCheckedLeaf,
          checkedLeafCaptureCacheId,
          selfRecursive,
          identifiers: {
            site: positionalCallSiteVariable(index),
            target: positionalCallTargetVariable(index),
            invoke: positionalCallInvokeVariable(index),
            rawInvoke: positionalCallRawInvokeVariable(index),
            receiver: positionalCallReceiverVariable(index),
            lateLink: positionalCallLateLinkVariable(index),
          },
          regionMarkers: {
            start: `__JVM_REGION_CALL_START_${index}__`,
            end: `__JVM_REGION_CALL_END_${index}__`,
          },
        });
        if (callSiteId !== null && targetCannotOverride &&
            resolvedCallMethod && !directCheckedLeaf) {
          this.jit.primeMonomorphicSyncCallSite(
            callSiteId, resolvedCallMethod, callOwner);
        }
      }
    }
    // A protected non-void call can suspend after consuming its arguments.
    // Record that requirement here. A generator continuation can retain the
    // exact post-invoke lexical state and feed the child's returned operand
    // back into SSA; a non-continuation framed entry must retain the baseline
    // handoff. The separately verified restoring positional entry remains
    // synchronous on its normal path and can reconstruct an omitted child at
    // the precise throwing operation.
    const requiresBaselineFramedEntry =
      (code.code.exceptionTable || []).length > 0 &&
      [...callSites.values()].some((site) =>
        !site.returnsVoid && site.id !== null && site.id !== undefined);
    const hasSelfRecursiveCall = [...callSites.values()].some(
      (site) => site.selfRecursive);
    const hasIndependentlySuspendableCall = [...callSites.values()].some(
      (site) => !site.selfRecursive &&
        site.id !== null && site.id !== undefined);
    // An initialized boolean static is a useful speculative constant when it
    // controls a large diagnostic/feature branch.  Bind only its location and
    // observed Java truth value, guard that value at entry before any guest
    // effect, and keep reading all non-boolean statics live.  A method that can
    // write the same location is deliberately excluded.  Selection uses only
    // the resolved field descriptor/location and bytecodes.
    const directTargetFor = (direct) => this.jit.directStaticTargets[direct.targetId];
    const directLocationEquals = (left, right) => {
      const a = directTargetFor(left), b = directTargetFor(right);
      return a && b && a.fields === b.fields && a.key === b.key;
    };
    const writtenStaticTargets = [...directStaticSites.values()]
      .filter((direct) => direct.op === "putstatic");
    const guardedStaticBooleanSites = new Map();
    if (guardedStaticBooleanSpecializationEnabled) {
      for (const [index, direct] of directStaticSites) {
        if (direct.op !== "getstatic" || direct.descriptor !== "Z" ||
            this.jit.jvm.classInitializationState.get(direct.className) !== "INITIALIZED" ||
            writtenStaticTargets.some((written) => directLocationEquals(direct, written))) continue;
        const target = directTargetFor(direct);
        if (!target) continue;
        const raw = target.kind === "map" ? target.fields.get(target.key) : target.fields[target.key];
        direct.guardedBooleanValue = raw ? 1 : 0;
        guardedStaticBooleanSites.set(index, direct);
      }
    }
    for (const index of prunedBooleanReadIndexes) {
      if (!guardedStaticBooleanSites.has(index)) {
        return reject("pruned boolean CFG branch lacks an entry guard");
      }
    }
    const ssaValueNames = new Set();
    // Operand SSA names allocated by this compile, without the compiler-owned
    // call/PIC identifiers below. A lexically inserted child body carries the
    // SSA names of its own compile, so membership here is what distinguishes
    // "a value this compile produced" from "a name that merely looks like
    // one". The renderer-wide counter keeps the two disjoint by construction.
    const ownSsaValueNames = new Set();
    // The final scope audit covers compiler-owned call/PIC identifiers as
    // well as ordinary operand SSA values.  A specialization can remove a
    // prologue declaration while leaving a cold or polymorphic edge behind;
    // parsing successfully is not sufficient because that would fail only
    // when the rare edge executes.
    for (const site of callSites.values()) {
      for (const identifier of Object.values(site.identifiers || {})) {
        ssaValueNames.add(identifier);
      }
    }
    // Every operand name this compile mints. `e`/`s` interpolations that are
    // one of these become operand references in the statement IR; everything
    // else is an opaque literal chunk. The registry only ever grows, and a
    // missing entry costs an optimization, never correctness: an interpolated
    // name the registry does not know stays inside a literal chunk and the
    // statement is then treated as opaque by every pass.
    for (const identifier of ssaValueNames) emittedNames.add(identifier);
    // Besides ordinary operand values, a checked leaf may also propagate the
    // coarse-loop and array-range predicates: it has no restoring contract
    // that has to expose them as named guard sites.
    const checkedLeafCompactableNames = new Set();
    // Loop trip/predicate temporaries. They are pure by construction, so an
    // entry scaffold that no longer reads one may drop its declaration.
    const pureRangeTemporaryNames = new Set();
    const pureRangeTemporary = (name) =>
      pureRangeTemporaryNames.add(name) && name;
    // Raw entry-array storage views. A store through one of these is the
    // proven form an ordered array load may be propagated into.
    const entryArrayDataNames = new Set();
    // Array-range access tokens that are still unresolved in a body make it
    // unsafe as a trusted checked leaf.
    const primitiveArrayAccessMarkers = new Set();
    const compactable = (name) =>
      checkedLeafCompactableNames.add(name) && name;
    // A comma-separated operand list keeps each operand's references.
    const argumentListExpression = (values) => exprConcat(
      ...values.flatMap((argument, position) =>
        position === 0 ? [e`${argument}`] : [", ", e`${argument}`]));
    // Expression form of `arrayDataExpression`: the operand is a compiler
    // value (an SSA name or a staged expression), so the same purity choice is
    // made on the compiler's own operand, and the result keeps its operand
    // references instead of being flattened into characters.
    const arrayDataExpr = (operand) => {
      const parts = [];
      appendPartValue(parts, operand);
      const value = new Expr(parts);
      // The operand is evaluated more than once, so only an operand
      // reference -- a name this compile minted -- may be expanded inline.
      if (parts.length !== 1 || typeof parts[0] === "string") {
        const helperCall = e`helpers.arrayData(${value})`;
        helperCall.pure = false;
        return helperCall;
      }
      const inline = exprConcat(
        e`(${value} === null || ${value} === undefined ? null : `,
        e`${value}.elements ? ${value}.elements : `,
        e`(Array.isArray(${value}) || ArrayBuffer.isView(${value}) ? `,
        e`${value} : null))`);
      inline.pure = true;
      return inline;
    };
    // Statement records for every line this compile emits, keyed by the
    // trimmed rendered text. Indentation is applied by the assembler and is
    // not part of a statement's identity, exactly as the existing
    // `checkedLeafOmittableLines` / `methodIntegerOriginLines` consumers
    // already assume.
    const statementRecords = new Map();
    const recordStatement = (parts, meta) => {
      const text = renderParts(parts);
      const key = text.trim();
      // The universal block terminators are recognized by the exact text the
      // emitter produced for them, whichever emitter that was: they carry no
      // operand and every one of them is the same statement.
      const structuralKind = key === "}" ? "blockEnd"
        : key === "} else {" ? "elseArm"
          : key === "{" ? "blockStart" : null;
      const record = {
        ...(meta || {}),
        key,
        parts,
        kind: meta?.kind || structuralKind || "statement",
        def: meta?.def || null,
        write: meta?.write || null,
        exprParts: meta?.exprParts || null,
        // A statement rendered by another plan (an inline integer leaf) or a
        // token whose text a later expansion owns. Its operands are not this
        // compile's, so no pass may rewrite it and the audit ignores it.
        foreign: meta?.foreign === true,
        pinned: meta?.pinned === true,
      };
      record.reads = record.foreign
        ? [] : partsReferences(record.exprParts || record.parts);
      // Properties of the operators and brackets the emitter itself wrote.
      // They are read off the statement's own parts -- operand references are
      // names and contribute no operator, bracket or keyword -- and they are
      // what the propagation and dead-declaration passes ask about.
      const subject = record.exprParts || parts;
      record.pure = !partsWriteImpureCall(subject);
      record.division = partsWriteDivision(subject);
      record.indexed = partsWriteIndex(subject);
      record.rawArrayLoad = partsLoadEntryArrayElement(
        subject, entryArrayDataNames);
      record.throwsOrTries = partsWriteThrowOrTry(parts);
      record.conditional = partsOpenCondition(parts);
      record.opensTry = partsSkeleton(parts).trimStart().startsWith("try {") ||
        partsSkeleton(parts).trimStart().startsWith("try ");
      // `safePointBudget` is ambient rather than an operand, so the entry
      // scaffold's sweep asks the statement whether it mentions the budget.
      record.usesSafePointBudget =
        partsSkeleton(parts).includes("safePointBudget");
      // `helpers.returnVoid()` is late-bound to a captured constant before a
      // capture-free body is created, so it is not a runtime helper call.
      record.callsRuntimeHelper = partsSkeleton(parts)
        .split("helpers.returnVoid()").join("").includes("helpers.");
      record.ambientReads = partsAmbientNames(parts);
      // The lexical nesting this statement opens or closes. It is a property
      // of the statement the emitter built, measured on the literal chunks it
      // wrote itself: operand references are names and never contain braces.
      let delta = 0;
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (typeof part !== "string") continue;
        for (let position = 0; position < part.length; position += 1) {
          if (part[position] === "{") delta += 1;
          else if (part[position] === "}") delta -= 1;
        }
      }
      record.blockDelta = delta;
      if (!record.exprParts && record.def) {
        record.reads = record.reads.filter((name) => name !== record.def);
      }
      const existing = statementRecords.get(key);
      // Identical text is the same statement; a genuinely ambiguous key would
      // have to disagree about what it defines, and that never happens because
      // the names are unique. Keep the first record and mark a disagreement
      // ambiguous so the passes leave it alone.
      if (existing && (existing.kind !== record.kind ||
          existing.def !== record.def || existing.write !== record.write ||
          existing.reads.length !== record.reads.length ||
          existing.reads.some((name, index) => record.reads[index] !== name))) {
        existing.ambiguous = true;
        return text;
      }
      if (!existing) statementRecords.set(key, record);
      return text;
    };
    // Indentation is applied by the assembler and is not part of a
    // statement's identity; `recordOf` looks a rendered line up by that
    // identity and `indentationOf` recovers the prefix to re-apply.
    const indentationOf = (line) =>
      line.slice(0, line.length - line.trimStart().length);
    const recordOf = (line) => statementRecords.get(line.trim());
    // The JVM slot a name denotes, or null when the name is not a local.
    const localSlotOfName = (name) => {
      const slot = localNameSlots.get(name);
      return slot === undefined ? null : slot;
    };
    // `local<slot> = <ssa value>;`, the shape both the local-update folds and
    // the checked-leaf local sinking look for.
    const isLocalCopy = (record, value) => record?.kind === "store" &&
      localSlotOfName(record.write) !== null &&
      record.exprParts?.length === 1 &&
      typeof record.exprParts[0] !== "string" &&
      record.exprParts[0].ref === value;
    // Re-emit a recorded statement with some of its operand references
    // replaced. This is the only way a pass may rewrite a statement: the
    // operands are substituted in the parts list and the statement is
    // rendered again through the same recording path, so the result carries
    // the same kind and metadata as the original.
    const substituteExpressionMeta = (value, replacements) => {
      if (value instanceof Expr) {
        return new Expr(substituteParts(value.parts, replacements));
      }
      if (Array.isArray(value)) {
        return value.map((entry) =>
          substituteExpressionMeta(entry, replacements));
      }
      if (typeof value === "string" && replacements.has(value)) {
        const replacement = replacements.get(value);
        const parts = replacement instanceof Expr
          ? replacement.parts : replacement;
        // A metadata operand keeps its reference identity: a token that still
        // renders as `false /*token*/` is still that token, so a later proof
        // can replace it again.
        if (parts.length === 1 && typeof parts[0] !== "string") {
          return parts[0].ref;
        }
        return renderParts(parts);
      }
      return value;
    };
    const rerenderStatement = (record, replacements, overrides = null) => {
      const meta = {};
      for (const key of Object.keys(record)) {
        if (key === "key" || key === "parts" || key === "reads") continue;
        meta[key] = substituteExpressionMeta(record[key], replacements);
      }
      if (record.exprParts) {
        meta.exprParts = substituteParts(record.exprParts, replacements);
      }
      return recordStatement(
        substituteParts(record.parts, replacements),
        overrides ? {...meta, ...overrides} : meta);
    };
    // Replace operand references throughout a rendered line list.
    const substituteInLines = (lines, replacements) => lines.map((line) => {
      const record = recordOf(line);
      if (!record || record.foreign) return line;
      if (!partsReferences(record.parts)
        .some((name) => replacements.has(name))) return line;
      // `indentationOf` already covers the statement's own leading spaces,
      // so the re-rendered statement contributes its trimmed identity.
      return `${indentationOf(line)}${
        rerenderStatement(record, replacements).trim()}`;
    });
    // The checked-leaf exit statement. A checked leaf leaves its body through
    // this one compiler-owned statement.
    const leafBailStatement = (indentation = "") =>
      `${indentation}${recordStatement([CHECKED_LEAF_BAIL],
        {kind: "leafBail"})}`;
    // What one emitted line of an assembled body is, for a consumer that
    // relocates statements into helper functions. Everything here is read off
    // the record the emitter wrote -- its parts list, its operand references
    // and the properties derived from its own skeleton -- so a consumer never
    // has to look at the assembled text. `parts` is the statement's own parts
    // list: a consumer re-renders it with operand substitutions, exactly the
    // way `rerenderStatement` does inside this renderer.
    const regionStatementOf = (line) => {
      const record = recordOf(line);
      if (!record) return null;
      const parts = record.parts;
      const jump = partsJumpStatement(parts);
      const exit = partsReturnSplit(parts);
      const named = partsOpensNamedConstruct(parts);
      const delta = record.blockDelta || 0;
      const reads = [];
      for (const name of [...record.reads, ...record.ambientReads,
        ...partsBodyHelperNames(parts)]) {
        if (!reads.includes(name)) reads.push(name);
      }
      return {
        text: line,
        indent: indentationOf(line),
        parts,
        kind: record.kind,
        def: record.def || null,
        write: record.write || null,
        // Every name the statement assigns in an enclosing scope: its operand
        // target and the ambient names it writes.
        writes: [...(record.write ? [record.write] : []),
          ...partsAmbientWrites(parts).filter(
            (name) => name !== record.write)],
        reads,
        delta,
        label: partsLabelName(parts),
        jump: jump && jump.recognized
          ? {kind: jump.kind, label: jump.label,
            before: jump.before, after: jump.after} : null,
        exit: exit && exit.recognized ? {
          before: exit.before, argument: exit.argument, after: exit.after,
        } : null,
        yields: partsYields(parts),
        continuesBlock: partsContinuesBlock(parts),
        opens: delta > 0
          ? (record.kind === "loopHeader" ? "loop"
            : record.opensTry ? "try" : named || "block")
          : null,
        // A statement a consumer may move into a helper function. Every
        // exit it carries has to be re-establishable through the helper's
        // protocol, and nothing in it may depend on the activation or the
        // scope it was written in.
        relocatable: record.foreign !== true &&
          !(jump && !jump.recognized) && !(exit && !exit.recognized) &&
          !(jump && exit) &&
          named === null && !partsCarriesNestedFunction(parts) &&
          !partsRelocationHostile(parts) && !partsDeclaresAmbient(parts),
      };
    };
    // Statement-level fragments of an assembled positional body: an ordered
    // list whose lines, joined back together, are exactly the body. A loop and
    // a try/catch are each one fragment, so a consumer that outlines or
    // partitions a body selects fragments instead of byte ranges, and each
    // fragment states the names it introduces, reads and writes.
    const regionFragmentsOf = (bodyLines) => {
      const fragments = [];
      if (bodyLines.some((line) => !recordOf(line))) return null;
      const deltaAt = (index) => recordOf(bodyLines[index]).blockDelta || 0;
      const isDeclaration = (record) => record.kind === "const" ||
        record.kind === "let" || record.kind === "letUninitialized" ||
        record.kind === "safePointBudgetDeclaration";
      const describe = (kind, from, to) => {
        if (to <= from) return;
        const lines = bodyLines.slice(from, to);
        const declares = [];
        const reads = [];
        const writes = [];
        const declared = new Set();
        for (const line of lines) {
          const record = recordOf(line);
          if (record.def && !declared.has(record.def)) {
            declared.add(record.def);
            declares.push(record.def);
          }
        }
        const seenRead = new Set();
        const seenWrite = new Set();
        for (const line of lines) {
          const record = recordOf(line);
          for (const name of [...record.reads, ...record.ambientReads]) {
            if (declared.has(name) || seenRead.has(name)) continue;
            seenRead.add(name);
            reads.push(name);
          }
          for (const written of [...(record.write ? [record.write] : []),
            ...partsAmbientWrites(record.parts)]) {
            if (declared.has(written)) continue;
            if (!seenWrite.has(written)) {
              seenWrite.add(written);
              writes.push(written);
            }
            // A unit that assigns an enclosing name still has to bind it.
            if (!seenRead.has(written)) {
              seenRead.add(written);
              reads.push(written);
            }
          }
        }
        fragments.push({
          id: fragments.length, kind, lines, declares, reads, writes,
          statements: lines.map((line) => regionStatementOf(line)),
        });
      };
      // Loops and try/catch are relocatable units, so each is one fragment
      // wherever it sits. Every other construct stays with the statements
      // around it: the fragments are a partition of the body in order, so
      // joining them reproduces it exactly.
      let index = 0;
      let runStart = 0;
      let depth = 0;
      while (index < bodyLines.length) {
        const record = recordOf(bodyLines[index]);
        const delta = deltaAt(index);
        if (delta > 0 && (record.kind === "loopHeader" || record.opensTry)) {
          describe("linear", runStart, index);
          let nested = delta;
          let end = index + 1;
          for (; end < bodyLines.length && nested > 0; end += 1) {
            nested += deltaAt(end);
          }
          if (nested !== 0) return null;
          describe(record.kind === "loopHeader" ? "loop" : "try", index, end);
          index = end;
          runStart = index;
          depth = depth;
          continue;
        }
        if (depth === 0 && delta === 0 && isDeclaration(record)) {
          describe("linear", runStart, index);
          describe("declaration", index, index + 1);
          index += 1;
          runStart = index;
          continue;
        }
        depth += delta;
        if (depth < 0) return null;
        index += 1;
      }
      if (depth !== 0) return null;
      describe("linear", runStart, bodyLines.length);
      return fragments;
    };
    // The function-scoped declarations of an assembled body, in order.
    const regionLocalNamesOf = (fragments) => {
      const declared = [];
      const kinds = {};
      for (const fragment of fragments || []) {
        if (fragment.kind !== "declaration") continue;
        const record = recordOf(fragment.lines[0]);
        if (!record.def || kinds[record.def]) continue;
        declared.push(record.def);
        kinds[record.def] = record.kind === "const" ? "const" : "let";
      }
      return {declared, kinds};
    };
    // A body a caller inserts lexically must not leave the caller's
    // activation. Every statement through which a positional body returns is
    // re-recorded as an assignment to one compiler-owned result slot followed
    // by a break out of one compiler-owned labeled block; the caller
    // late-binds both tokens, by exact identity, to the names it chose for
    // this insertion. `compileSerial` makes them unique against the enclosing
    // body and against any other insertion at any nesting depth, exactly as it
    // does for the checked-leaf body's own result and label.
    const regionInsertionResult =
      named(`ssaRegionInlineResult${compileSerial}`);
    const regionInsertionLabel = named(`ssaRegionInlineBody${compileSerial}`);
    const insertableExitStatement = (before, value, after) => recordStatement([
      ...before, "{ ", {ref: regionInsertionResult}, " = ",
      ...(value.length ? value : ["undefined"]),
      "; break ", {ref: regionInsertionLabel}, "; }", ...after,
    ], {kind: "insertableExit"});
    // The insertable form of an assembled body. Statements are examined as the
    // records their emitters produced, never as characters: an exit is a
    // statement whose own parts carry a `return`, and it is replaced by a
    // statement recorded through the same recorder, so the result is statement
    // IR like every other body and the audit covers it.
    //
    // The variant is rejected outright when a line was never recorded (a
    // hand-assembled nested function, whose returns belong to it and not to
    // this activation) or when an exit cannot be represented as one
    // assignment-and-break. An emitter that grows a new exit form therefore
    // loses inlining instead of escaping the caller.
    const insertableBodyOf = (bodyLines) => {
      const lines = [];
      let exits = 0;
      const veto = (why, line) => {
        if (process.env.JVM_DEBUG_INSERTION_VETO) {
          require("fs").appendFileSync(process.env.JVM_DEBUG_INSERTION_VETO,
            `VETO ${why}: ${String(line).trim()}\n`);
        }
        return null;
      };
      // A guest loop or block label is named after its header pc, so two
      // unrelated bodies routinely declare the same one and inserting one into
      // the other would nest two identical labels. The inserted copy therefore
      // renames every label it declares and every reference to it, keyed by
      // this compile's serial. The rename is driven by the label each
      // statement recorded; a statement that mentions one of these labels
      // without having recorded it rejects the whole variant, because its
      // reference would be left pointing at the caller's label.
      const declaredLabels = new Set();
      for (const line of bodyLines) {
        const record = recordOf(line);
        if (typeof record?.label === "string" && record.label) {
          declaredLabels.add(record.label);
        }
      }
      // A label is not an operand: it names a statement, not a value, so the
      // renamed label stays a literal chunk of the statement that declares or
      // jumps to it and is not registered as an emitted name.
      const renamedLabel = (label) => `${label}_ssaInline${compileSerial}`;
      const labelPattern = declaredLabels.size
        ? new RegExp(`(?:^|[^A-Za-z0-9_$])(${[...declaredLabels]
          .map((label) => label.replace(/[^A-Za-z0-9_$]/g, "\\$&"))
          .join("|")})(?![A-Za-z0-9_$])`)
        : null;
      const relabelParts = (parts, label) => parts.map((part) =>
        typeof part === "string"
          ? part.replace(
            new RegExp(`(^|[^A-Za-z0-9_$])${label}(?![A-Za-z0-9_$])`, "g"),
            `$1${renamedLabel(label)}`)
          : part);
      for (const line of bodyLines) {
        if (line.trim() === "") { lines.push(line); continue; }
        const record = recordOf(line);
        if (!record || record.foreign) return veto("unrecorded", line);
        // A generator body cannot be inserted into a caller's activation.
        // `yield` as a whole word, so a deopt reason that names a yielded
        // thread is not mistaken for one.
        if (/(?:^|[^A-Za-z0-9_$])yield(?![A-Za-z0-9_$])/
          .test(partsSkeleton(record.parts))) return veto("yield", line);
        let parts = record.parts;
        if (typeof record.label === "string" && record.label) {
          parts = relabelParts(parts, record.label);
        } else if (labelPattern?.test(partsSkeleton(parts))) {
          return veto("unrecorded-label-reference", line);
        }
        const positions = partsReturnPositions(parts);
        if (positions.length === 0) {
          lines.push(parts === record.parts ? line
            : `${indentationOf(line)}${recordStatement(parts,
              {...record, label: renamedLabel(record.label)}).trim()}`);
          continue;
        }
        const split = splitReturnParts(parts);
        if (!split) return veto("unsplittable-return", line);
        exits += 1;
        lines.push(`${indentationOf(line)}${insertableExitStatement(
          split.before, split.value, split.after).trim()}`);
      }
      if (exits === 0) return veto("no-exits", "");
      return {lines, exits};
    };
    // What a consumer needs to insert one positional body: the body itself
    // with its exits carrying the two tokens, the names it expects its
    // arguments and entry guard to be bound to, and an assembler that binds
    // them by declaration inside the labeled block. The callee's own
    // `local<slot>` / `ssaValue<n>` names are declared in that block too, so
    // they shadow the caller's rather than colliding with them and nothing is
    // renamed. Argument values are evaluated by the caller before the block is
    // entered, because inside it every name the body declares is in its
    // temporal dead zone.
    const publishInsertion = (body, argumentNames) => {
      if (!body) return null;
      const published = {
        serial: compileSerial,
        source: body.lines.join("\n"),
        exitCount: body.exits,
        resultToken: regionInsertionResult,
        labelToken: regionInsertionLabel,
        argumentNames: [...argumentNames],
        entryGuardName: "nestedEntryGuarded",
        entryGuardValue: "2",
      };
      published.assemble = ({
        source = published.source, argumentValues, resultName, exitLabel,
        namespace, declareResult = true,
      }) => {
        if (typeof source !== "string" || typeof resultName !== "string" ||
            typeof exitLabel !== "string" ||
            typeof namespace !== "string") return null;
        if (!Array.isArray(argumentValues) ||
            argumentValues.length !== published.argumentNames.length ||
            argumentValues.some((value) => typeof value !== "string")) {
          return null;
        }
        // Late-bound compiler-owned tokens, expanded by exact identity: both
        // names carry this compile's serial and occur nowhere else.
        const retargeted = source
          .split(published.resultToken).join(resultName)
          .split(published.labelToken).join(exitLabel);
        return [
          declareResult ? `let ${resultName};` : null,
          // Staged in the caller's scope. An argument may be spelled with one
          // of the names the inserted block declares, and inside that block
          // every one of them is in its temporal dead zone.
          ...argumentValues.map((value, index) =>
            `const ${namespace}a${index} = ${value};`),
          `${exitLabel}: {`,
          ...published.argumentNames.map((name, index) =>
            `  const ${name} = ${namespace}a${index};`),
          `  const ${published.entryGuardName} = ${published.entryGuardValue};`,
          ...retargeted.split("\n").map((line) => `  ${line}`),
          "}",
        ].filter((line) => line !== null).join("\n");
      };
      return published;
    };
    const spillStatement = () =>
      recordStatement(["spillLocals();"], {kind: "spill"});
    // The universal block terminators. Their kind is what the structural
    // passes match on; the indentation is applied by the assembler and stays
    // outside the statement's identity.
    const blockEnd = (indentation = "") =>
      `${indentation}${recordStatement(["}"], {kind: "blockEnd"})}`;
    const elseArm = (indentation = "") =>
      `${indentation}${recordStatement(["} else {"], {kind: "elseArm"})}`;
    const blockStart = (indentation = "") =>
      `${indentation}${recordStatement(["{"], {kind: "blockStart"})}`;
    // Generic statement: operand references are the interpolations the
    // registry recognizes; the rest of the template is opaque text.
    const st = (strings, ...values) =>
      recordStatement(buildParts(strings, values), null);
    // Statement built from an already-assembled expression, for the emitters
    // that compose a long line out of several pieces.
    const stmt = (expression, meta = null) => recordStatement(
      expression instanceof Expr
        ? expression.parts : buildParts(["", ""], [expression]), meta);
    // A statement that introduces a binding. `pure` marks a right-hand side
    // with no side effect that cannot throw, which is what makes propagation
    // and dead-declaration removal legal.
    const constDecl = (name, expression, meta = null) => {
      const exprParts = expression instanceof Expr
        ? expression.parts : buildParts(["", ""], [expression]);
      return recordStatement(
        [`const `, {ref: name}, " = ", ...exprParts, ";"],
        {...(meta || {}), kind: "const", def: name, exprParts});
    };
    const letDecl = (name, expression = null, meta = null) => {
      if (expression === null) {
        return recordStatement([`let `, {ref: name}, ";"],
          {kind: "letUninitialized", def: name, exprParts: []});
      }
      const exprParts = expression instanceof Expr
        ? expression.parts : buildParts(["", ""], [expression]);
      return recordStatement(
        [`let `, {ref: name}, " = ", ...exprParts, ";"],
        {...(meta || {}), kind: "let", def: name, exprParts});
    };
    const storeLocal = (name, expression, meta = null) => {
      const exprParts = expression instanceof Expr
        ? expression.parts : buildParts(["", ""], [expression]);
      return recordStatement(
        [{ref: name}, " = ", ...exprParts, ";"],
        {...(meta || {}), kind: "store", write: name, exprParts});
    };
    const value = () => {
      // SSA operand names are unique across every compile this renderer
      // performs, not merely within one method. A checked leaf is inserted
      // lexically into its caller's body, so two compiles that both started
      // numbering at zero would put identically named, unrelated values in
      // one function; every name-keyed record here (integer provenance,
      // staged-copy reuse, the generated-scope audit) would then conflate
      // them.
      const name = `ssaValue${this.nextSsaValue++}`;
      ssaValueNames.add(name);
      ownSsaValueNames.add(name);
      emittedNames.add(name);
      return name;
    };
    // Bytecode stack staging would otherwise bind an operand that is already
    // an immutable SSA value to a second name: `const ssaValueA = ssaValueB;`.
    // Such a declaration carries no information, so reuse the existing name at
    // the point of emission instead of emitting the copy and coalescing it
    // out of the rendered text afterwards. Only names this compile allocated
    // qualify; block entry slots (`ssaStackN_M`) and locals are reassigned,
    // and an inserted child's names belong to another compile.
    let coalescedSsaCopyCount = 0;
    const stagedValue = (input, lines) => {
      if (ownSsaValueNames.has(input)) {
        coalescedSsaCopyCount += 1;
        return input;
      }
      const out = value();
      lines.push(constDecl(out, e`${input}`, {pure: true}));
      return out;
    };
    const plans = [];
    // SSA names are unique across the method. Preserve their integer
    // provenance beyond block simulation so a later, entry-guarded checked
    // leaf can prove that Java wrap operations are impossible and emit the
    // corresponding plain JavaScript arithmetic.
    const methodIntegerOrigins = new Map();
    // The exact line the emitter rendered for an integer arithmetic value,
    // together with the same operation written without its int32 mask.
    // Interval analysis selects the lines it has proven cannot overflow by
    // this identity, so nothing has to recognize arithmetic in rendered text.
    const methodIntegerOriginLines = new Map();
    const methodSpecializedCheckedCaptures = {};
    let hasOutlinedClippedLeaf = false;
    const specializedCheckedCapture = (cacheId, position) => {
      const name = named(`ssaSpecializedCheckedCapture${cacheId}_${position}`);
      const cache = this.jit.checkedLeafCaptureCaches[cacheId];
      methodSpecializedCheckedCaptures[name] =
        cache?.[`specializedValue${position}`];
      return name;
    };
    const continuationFallbacks = new Map();
    const directPositionalLineAlternatives = new Map();
    const directEntryStaticReadFallbacks = new Map();
    const directCheckedAdmissionFallbacks = new Map();
    const directEntryCheckedAdmissionDeclarations = [];
    // Lines a lexical insertion may omit are recorded by identity as they are
    // emitted: the caller either proves a guard or owns the safe-point budget,
    // and the inserted body then drops exactly those lines.
    const checkedLeafOmittableLines = new Map();
    const recordCheckedLeafLine = (kind, line, guards = null) => {
      checkedLeafOmittableLines.set(line, { kind, guards });
      return line;
    };
    const materializeDepths = new Set();
    const materializeUnwindDepths = new Set();
    let deferredCallMaterializationCount = 0;
    let reusedLocalLoadCount = 0;
    let eliminatedLocalStoreCount = 0;
    let sentinelArrayLoadCount = 0;
    let blockArrayDataViewCount = 0;
    let fixedPointScalarizationCount = 0;
    let eliminatedArrayStoreCheckCount = 0;
    // Record only `aaload` sites whose SSA operand has a known nested
    // primitive-array descriptor. Such a load merely selects a primitive row
    // for subsequent numeric access. Object/reference element loads retain
    // the virtual-Frame ABI because their values can cross arbitrary dynamic
    // object operations.
    const verifiedNestedPrimitiveAaloads = new Set();
    // Descriptor-only reference-array parameters are not enough to omit a
    // Frame. A directly resolved static array is stronger: its initialized
    // storage identity is guarded at region entry, so an element can safely
    // feed checked field/call operations while retaining exact restoration.
    const verifiedResolvedStaticReferenceAaloads = new Set();
    const resolvedStaticReferenceArrayValues = new Set();
    let specializedArrayRangeAccessCount = 0;
    const specializedArrayRangeAccesses = new Set();
    let dominatedFieldReceiverCheckCount = 0;
    const dominatedFieldReceiverChecks = new Set();
    let dominatedEntryReferenceNullBranchCount = 0;
    const dominatedEntryReferenceNullBranches = new Set();
    let eliminatedTerminalStructuredBreakCount = 0;
    let eliminatedStructuredBlockCount = 0;
    let restoringRangeGuardDeoptCount = 0;
    let restoringCoarseLoopDeoptCount = 0;
    let rangeDominatedArithmeticGuardCount = 0;
    const rangeDominatedArithmeticGuards = new Set();
    const lexicalVoidFastPathSites = new Set();
    const arrayRangeCheckCandidates = [];
    // Keep every primitive entry-array access available to whole-region
    // proofs, including affine local+constant indexes that an ordinary
    // monotonic counted-loop guard cannot prove by itself.  A later proof may
    // version a complete shrinking-window region before its first effect.
    const primitiveArrayAccessCandidates = [];
    let nextPrimitiveArrayAccessMarker = 0;
    const deferredStaticArrayAccesses = [];
    let nextDeferredStaticArrayAccessMarker = 0;
    const localIndex = (instruction, op) => {
      if (instruction && typeof instruction === "object" && instruction.arg !== undefined) {
        return Number(instruction.arg);
      }
      const match = /_([0-3])$/.exec(op || "");
      return match ? Number(match[1]) : NaN;
    };
    const opOf = (instruction) => !instruction ? null :
      (typeof instruction === "string" ? instruction : instruction.op);
    const hasReachableIntArrayStore = items.some((item, index) =>
      normalReachableItems.has(index) && opOf(item?.instruction) === "iastore");
    const arrayIndexOutOfBounds = (index, length) =>
      this.unsignedArrayBoundsEnabled
        ? e`((${index} >>> 0) >= ${length})`
        : e`(${index} < 0 || ${index} >= ${length})`;
    const methodIsStatic = (method.flags || []).includes("static") ||
      (Number(method.accessFlags) & 0x0008) !== 0;
    // In the single-threaded cooperative runtime, another Java thread can
    // mutate a static only after this generated entry yields. A call-free
    // method with no putstatic therefore sees one stable value for every
    // resolved getstatic location during the entry. Hoist that value (and a
    // primitive array's raw storage view) once. Any scheduler yield exits the
    // generated entry, so resumption observes a fresh value.
    // Reuse the generic transitive bytecode write summary already maintained
    // by the Wasm tier. A call that writes no static location cannot invalidate
    // a caller's cached clip bound or framebuffer reference. Summaries use the
    // conservative name:descriptor kill key (rather than assuming unrelated
    // owners never alias through inheritance); unresolved or dynamic calls
    // still invalidate everything.
    let hasUnknownStaticEffect = false;
    const entryStaticWriteKeys = new Set();
    const callFieldWriteSummaries = new Map();
    for (let index = 0; index < items.length; index += 1) {
      if (!normalReachableItems.has(index)) continue;
      const instruction = items[index]?.instruction;
      const op = opOf(instruction);
      if (op === "putstatic" || op === "putfield") {
        const member = instruction?.arg?.[2];
        if (!Array.isArray(member)) {
          hasUnknownStaticEffect = true;
          break;
        }
        entryStaticWriteKeys.add(`${member[0]}:${member[1]}`);
      } else if (op.startsWith("invoke") &&
          Array.isArray(callSites.get(index)?.directJre?.fieldWriteKeys)) {
        const summary = new Set(
          callSites.get(index).directJre.fieldWriteKeys);
        callFieldWriteSummaries.set(index, summary);
        for (const key of summary) entryStaticWriteKeys.add(key);
      } else if (op === "invokestatic") {
        const owner = instruction?.arg?.[1];
        const member = instruction?.arg?.[2];
        const summary = typeof owner === "string" && Array.isArray(member)
          ? this.jit.wasmJit?.staticWriteSummary(
            owner, member[0], member[1])
          : null;
        if (summary === null || summary === undefined) {
          callFieldWriteSummaries.set(index, null);
          hasUnknownStaticEffect = true;
          break;
        }
        callFieldWriteSummaries.set(index, summary);
        for (const key of summary) entryStaticWriteKeys.add(key);
      } else if (op === "invokespecial") {
        const owner = instruction?.arg?.[1];
        const member = instruction?.arg?.[2];
        const summary = typeof owner === "string" && Array.isArray(member)
          ? this.jit.wasmJit?.instanceWriteSummary(
            owner, member[0], member[1])
          : null;
        callFieldWriteSummaries.set(index, summary || null);
        if (summary === null || summary === undefined) {
          hasUnknownStaticEffect = true;
          break;
        }
        for (const key of summary) entryStaticWriteKeys.add(key);
      } else if (op === "invokevirtual") {
        const owner = instruction?.arg?.[1];
        const member = instruction?.arg?.[2];
        const classData = typeof owner === "string"
          ? this.jit.jvm.classes[owner] : null;
        const classNode = classData?.ast?.classes?.[0];
        const targetMethod = classData && Array.isArray(member)
          ? this.jit.jvm.findMethod(classData, member[0], member[1]) : null;
        const monomorphic = Boolean(
          classNode?.flags?.includes("final") ||
          targetMethod?.flags?.includes("final") ||
          targetMethod?.flags?.includes("private"));
        const summary = monomorphic
          ? this.jit.wasmJit?.instanceWriteSummary(
            owner, member[0], member[1])
          : null;
        callFieldWriteSummaries.set(index, summary || null);
        if (summary === null || summary === undefined) {
          hasUnknownStaticEffect = true;
          break;
        }
        for (const key of summary) entryStaticWriteKeys.add(key);
      } else if (op === "invokeinterface" || op === "invokedynamic") {
        callFieldWriteSummaries.set(index, null);
        hasUnknownStaticEffect = true;
        break;
      }
    }
    const idempotentStaticReferenceStores = new Set();
    for (const [getIndex, getDirect] of directStaticSites) {
      if (getDirect.op !== "getstatic" ||
          !/^\[(?:Z|B|C|S|I|F|D|J)$/.test(getDirect.descriptor || "")) {
        continue;
      }
      const storeInstruction = items[getIndex + 1]?.instruction;
      const storeOp = opOf(storeInstruction);
      if (!/^astore(?:_[0-3])?$/.test(storeOp)) continue;
      const slot = localIndex(storeInstruction, storeOp);
      const writesToSlot = items.filter((item) => {
        const instruction = item?.instruction;
        const op = opOf(instruction);
        return /^astore(?:_[0-3])?$/.test(op) &&
          localIndex(instruction, op) === slot;
      });
      if (writesToSlot.length !== 1) continue;
      const matchingWrites = [...directStaticSites].filter(
        ([index, direct]) => direct.op === "putstatic" &&
          directLocationEquals(getDirect, direct) &&
          index > 0 && /^aload(?:_[0-3])?$/.test(
            opOf(items[index - 1]?.instruction)) &&
          localIndex(items[index - 1]?.instruction,
            opOf(items[index - 1]?.instruction)) === slot);
      if (matchingWrites.length !== 1 ||
          [...directStaticSites].some(([index, direct]) =>
            direct.op === "putstatic" && index !== matchingWrites[0][0] &&
            directLocationEquals(getDirect, direct))) continue;
      if ([...callFieldWriteSummaries.values()].some((summary) =>
        summary === null || summary?.has(getDirect.key))) continue;
      idempotentStaticReferenceStores.add(getDirect.key);
    }
    const entryStaticReadCaches = new Map();
    // A nullable static array can be a guest control flag: javac commonly
    // lowers `array == null` to getstatic, aconst_null, if_acmp*. Its raw data
    // view may still be cached at entry, but null must reach the guest branch
    // instead of tripping an unconditional "non-canonical storage" guard.
    const nullComparedStaticArrayLocations = new Set();
    for (const [index, direct] of directStaticSites) {
      if (direct.op !== "getstatic" ||
          !direct.descriptor?.startsWith("[")) continue;
      const previousOp = opOf(items[index - 1]?.instruction);
      const nextOp = opOf(items[index + 1]?.instruction);
      const followingOp = opOf(items[index + 2]?.instruction);
      const nullCompared =
        nextOp === "ifnull" || nextOp === "ifnonnull" ||
        nextOp === "aconst_null" &&
          (followingOp === "if_acmpeq" || followingOp === "if_acmpne") ||
        previousOp === "aconst_null" &&
          (nextOp === "if_acmpeq" || nextOp === "if_acmpne");
      if (nullCompared) {
        nullComparedStaticArrayLocations.add(
          `${direct.className}\0${direct.key}`);
      }
    }
    const entryStaticReadCacheEnabled =
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_ENTRY_STATIC_READ_CACHE === "1");
    if (entryStaticReadCacheEnabled && !hasUnknownStaticEffect) {
      for (const [index, direct] of directStaticSites) {
        if (direct.op !== "getstatic" ||
            entryStaticWriteKeys.has(direct.key) &&
              !idempotentStaticReferenceStores.has(direct.key) ||
            guardedStaticBooleanSites.has(index)) continue;
        const target = directTargetFor(direct);
        if (!target) continue;
        const key = `${direct.className}\0${direct.key}`;
        let cache = entryStaticReadCaches.get(key);
        if (!cache) {
          const number = entryStaticReadCaches.size;
          cache = {
            direct,
            descriptor: direct.descriptor,
            value: named(`ssaEntryStaticValue${number}`),
            data: direct.descriptor?.startsWith("[")
              ? entryArrayDataName(`ssaEntryStaticArrayData${number}`) : null,
            nullableTested: nullComparedStaticArrayLocations.has(key),
          };
          entryStaticReadCaches.set(key, cache);
        } else if (nullComparedStaticArrayLocations.has(key)) {
          cache.nullableTested = true;
        }
        direct.entryReadCache = cache;
      }
      // Cold-compiled sites do not receive a direct target until their first
      // initialized access. Snapshot an already-linked, non-volatile target
      // at each later generated entry. If it is still unresolved, the normal
      // bytecode read below performs linkage; the next invocation can hoist.
      const coldLinkedStaticReadCacheEnabled =
        !(typeof process !== "undefined" && process.env &&
          process.env.JVM_DISABLE_COLD_LINKED_STATIC_READ_CACHE === "1");
      const lexicalLoopBlocks = new Set();
      const collectLoopBlocks = (node, insideLoop = false) => {
        if (!node) return;
        const nested = insideLoop || node.t === "loop";
        if (node.t === "straight" && nested) {
          lexicalLoopBlocks.add(node.block);
        }
        if (node.t === "seq") {
          node.body.forEach((child) => collectLoopBlocks(child, nested));
        } else if (node.t === "if") {
          collectLoopBlocks(node.then, nested);
          collectLoopBlocks(node.els, nested);
        } else if (node.t === "switch") {
          node.cases.forEach((entry) => collectLoopBlocks(entry.body, nested));
          collectLoopBlocks(node.dflt, nested);
        } else if (node.t === "loop" || node.t === "block") {
          collectLoopBlocks(node.body, nested);
        }
      };
      collectLoopBlocks(structured.tree);
      const itemBlock = new Map();
      for (const block of cfg.blocks) {
        for (const index of block.insns || []) itemBlock.set(index, block.id);
      }
      for (const [index, lazy] of lazyStaticSites) {
        if (!coldLinkedStaticReadCacheEnabled) break;
        const plan = this.jit.fieldSites[lazy.site];
        const fieldKey = plan && `${plan.fieldName}:${plan.descriptor}`;
        if (!plan || !fieldKey || entryStaticWriteKeys.has(fieldKey) ||
            !this.jit.canEliminateFieldRead(plan.arg) ||
            (plan.descriptor?.startsWith("[") ||
              plan.descriptor?.startsWith("L")) &&
            !lexicalLoopBlocks.has(itemBlock.get(index))) continue;
        const location = `${plan.className}\0${fieldKey}`;
        const existing = entryStaticReadCaches.get(location);
        if (existing) {
          lazy.entryReadCache = existing;
          continue;
        }
        const number = entryStaticReadCaches.size;
        const cache = {
          lazy,
          descriptor: plan.descriptor,
          value: named(`ssaEntryStaticValue${number}`),
          valid: named(`ssaEntryStaticValid${number}`),
          data: plan.descriptor?.startsWith("[")
            ? entryArrayDataName(`ssaEntryStaticArrayData${number}`) : null,
        };
        entryStaticReadCaches.set(location, cache);
        lazy.entryReadCache = cache;
      }
    }
    const hasNullableStaticArrayControl =
      nullComparedStaticArrayLocations.size > 0;
    // A non-volatile field is stable for one synchronous generated entry when
    // the method contains neither an instance-field write nor a call that
    // could perform one. Cache repeated reads by symbolic field plus receiver
    // identity. The cache dies at a scheduler safe point, before another Java
    // thread can run. Selection is entirely bytecode/field-shape based.
    const fieldReadCaches = new Map();
    const fieldReadCacheSites = new Map();
    const eagerFieldReceiverNullChecks = new Map();
    const entryReferenceLoads = new Map();
    const localLoads = new Map();
    const invariantPositionalReceiverSlots = new Map();
    for (let index = 0; index < items.length; index += 1) {
      const instruction = items[index]?.instruction;
      if (opOf(instruction) !== "getfield" ||
          !this.jit.canEliminateFieldRead(instruction.arg)) continue;
      const key = JSON.stringify(instruction.arg);
      let cache = fieldReadCaches.get(key);
      if (!cache) {
        const number = fieldReadCaches.size;
        const site = fieldSites.get(index);
        cache = {
          object: named(`ssaFieldCache${number}Object`),
          value: named(`ssaFieldCache${number}Value`),
          valid: named(`ssaFieldCache${number}Valid`),
          data: named(`ssaFieldCache${number}ArrayData`),
          site,
          indexes: [],
          descriptor: this.jit.fieldSites[site]?.descriptor || null,
          isArray: this.jit.fieldSites[site]?.descriptor?.startsWith("[") === true,
          directKey: this.jit.fieldSites[site]?.directInstanceKey || null,
          denseSlot: this.jit.fieldSites[site]?.denseSlot ?? null,
          killKey: this.jit.fieldSites[site]
            ? `${this.jit.fieldSites[site].fieldName}:` +
              `${this.jit.fieldSites[site].descriptor}`
            : null,
        };
        fieldReadCaches.set(key, cache);
      }
      cache.indexes.push(index);
      fieldReadCacheSites.set(index, cache);
    }
    const entryArrayLocalSlots = new Set(
      method.jvmStructuredEntryArrayLocals || []);
    const entryArrayKinds = new Map();
    const entryScalarKinds = new Map();
    const entryReferenceLocalSlots = new Set(methodIsStatic ? [] : [0]);
    // Keep primitive-array parameter storage in one scalar view for the
    // lifetime of a synchronous generated entry. This is descriptor-driven:
    // the Java array reference remains canonical in the JVM local, while the
    // raw view is only an unobservable cache used by checked load/store
    // emission. `undefined` remains the exceptional sentinel, so null and
    // bounds failures still materialize the precise bytecode state.
    try {
      const entryDescriptor = parseDescriptor(method.descriptor);
      let entrySlot = methodIsStatic ? 0 : 1;
      for (const parameterType of entryDescriptor.params) {
        if (["boolean", "byte", "char", "short", "int", "long",
          "float", "double"].includes(parameterType)) {
          entryScalarKinds.set(entrySlot, parameterType);
        }
        if (!["boolean", "byte", "char", "short", "int",
          "long", "float", "double"].includes(parameterType)) {
          entryReferenceLocalSlots.add(entrySlot);
        }
        if (["boolean[]", "byte[]", "char[]", "short[]", "int[]",
          "float[]", "double[]", "long[]"].includes(parameterType)) {
          entryArrayLocalSlots.add(entrySlot);
          entryArrayKinds.set(entrySlot, ({
            "boolean[]": "[Z", "byte[]": "[B", "char[]": "[C",
            "short[]": "[S", "int[]": "[I", "float[]": "[F",
            "double[]": "[D", "long[]": "[J",
          })[parameterType]);
        }
        entrySlot += parameterType === "long" || parameterType === "double"
          ? 2 : 1;
      }
    } catch (_) {
      // Descriptor validation elsewhere will reject malformed methods.
    }
    const entryArrayDataVariable = (slot) => {
      const name = named(`ssaEntryArrayData${slot}`);
      entryArrayDataNames.add(name);
      return name;
    };
    const guardedEntryArrayData = new Set([
      ...[...entryArrayLocalSlots].map(entryArrayDataVariable),
      ...[...entryStaticReadCaches.values()]
        .filter((cache) => !cache.lazy &&
          !hasNullableStaticArrayControl)
        .map((cache) => cache.data).filter(Boolean),
    ]);
    // These views are rejected by an unconditional generated-entry guard.
    // Eager field arrays are added to guardedEntryArrayData below only so
    // loop preheaders may derive a conditional range proof; a field value can
    // still be null and its checked slow arm must test the raw view before
    // dereferencing it.
    const unconditionallyNonNullEntryArrayData =
      new Set(guardedEntryArrayData);
    const entryStaticArrayData = new Set(
      [...entryStaticReadCaches.values()]
        .filter(() => !hasNullableStaticArrayControl)
        .map((cache) => cache.data).filter(Boolean));
    const entryStaticArrayLocalViews = new Map();
    const entryStaticArrayLocalInitializers = new Map();
    const persistentStaticArrayLocalViews = new Map();
    const persistentStaticArrayStoreViews = new Map();
    const persistentProducedArrayLocalViews = new Map();
    const persistentProducedArrayStoreViews = new Map();
    const entryFieldArrayLocalViews = new Map();
    if (this.fieldArrayLocalViewsEnabled &&
        (code.code.exceptionTable || []).length === 0) {
      const entryItems = new Set(cfg.blocks[cfg.entry]?.insns || []);
      const cfgPredecessors = cfg.blocks.map(() => []);
      for (let block = 0; block < cfg.blocks.length; block += 1) {
        for (const successor of cfg.succ[block] || []) {
          if (Number.isInteger(successor)) cfgPredecessors[successor].push(block);
        }
      }
      for (const [index, direct] of directStaticSites) {
        const cache = direct.entryReadCache;
        if (direct.op !== "getstatic" || !cache?.data ||
            !entryItems.has(index) || !entryItems.has(index + 1)) continue;
        const store = items[index + 1]?.instruction;
        const storeOp = opOf(store);
        if (!/^astore(?:_[0-3])?$/.test(storeOp)) continue;
        const slot = localIndex(store, storeOp);
        const stores = [];
        const loads = [];
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          if (!normalReachableItems.has(itemIndex)) continue;
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          if (/^astore(?:_[0-3])?$/.test(op) &&
              localIndex(instruction, op) === slot) stores.push(itemIndex);
          if (/^aload(?:_[0-3])?$/.test(op) &&
              localIndex(instruction, op) === slot) loads.push(itemIndex);
        }
        if (stores.length !== 1 || stores[0] !== index + 1 ||
            !loads.length || loads.some((load) => load <= index + 1)) continue;
        const loopCandidates = [];
        for (let backedge = 0; backedge < cfg.blocks.length; backedge += 1) {
          for (const header of cfg.succ[backedge] || []) {
            const headerItem = cfg.blocks[header]?.insns?.[0];
            const backedgeItem = cfg.blocks[backedge]?.insns?.[0];
            if (Number.isInteger(headerItem) && headerItem > index + 1 &&
                Number.isInteger(backedgeItem) && backedgeItem >= headerItem) {
              loopCandidates.push({header, backedge, headerItem});
            }
          }
        }
        loopCandidates.sort((left, right) => left.headerItem - right.headerItem);
        const firstLoop = loopCandidates[0];
        if (!firstLoop) continue;
        const loopBlocks = new Set([firstLoop.header, firstLoop.backedge]);
        const pending = [firstLoop.backedge];
        while (pending.length) {
          const block = pending.pop();
          for (const predecessor of cfgPredecessors[block] || []) {
            if (loopBlocks.has(predecessor)) continue;
            loopBlocks.add(predecessor);
            if (predecessor !== firstLoop.header) pending.push(predecessor);
          }
        }
        // The local receives the entry static reference exactly once and is
        // never reassigned, so its raw primitive backing remains the same in
        // every block of this invocation even if a callee later replaces the
        // static field.  Extending the view beyond the first natural loop lets
        // the ordinary range analysis cover later state-machine loops. A
        // field-backed range candidate records and verifies the referenced
        // array at every continuation boundary below, so canonical fallback
        // resumes with this actual JVM local after a concurrent rebind.
        for (const candidateBlock of cfg.blocks) {
          if (candidateBlock && !candidateBlock.synthetic) {
            loopBlocks.add(candidateBlock.id);
          }
        }
        entryStaticArrayLocalViews.set(slot, {
          data: cache.data,
          descriptor: cache.descriptor,
          blocks: loopBlocks,
        });
        entryStaticArrayLocalInitializers.set(slot, {
          value: cache.value,
          storeIndex: index + 1,
        });
      }

      // A primitive static array is often copied into a JVM local only after
      // setup calls or branches. The block-local SSA view created by
      // getstatic used to disappear at that astore, forcing every later
      // access back through representation and bounds checks. Preserve a raw
      // companion when bytecode facts prove that the assignment is unique and
      // dominates every read of the slot. The Java reference remains the
      // canonical local; the companion is updated from that exact reference,
      // so a later static-field rebind cannot retarget it.
      //
      // This is descriptor/CFG driven. It deliberately excludes exception
      // tables: a handler can enter with verifier-specific local state that
      // would need a separate phi for the companion.
      const reachableBlocks = cfg.blocks
        .filter((block) => block && !block.synthetic &&
          (block.insns || []).some((itemIndex) =>
            normalReachableItems.has(itemIndex)))
        .map((block) => block.id);
      const reachableBlockSet = new Set(reachableBlocks);
      const itemBlocks = new Map();
      for (const block of cfg.blocks) {
        for (const itemIndex of block?.insns || []) {
          itemBlocks.set(itemIndex, block.id);
        }
      }
      const dominators = new Map();
      for (const block of reachableBlocks) {
        dominators.set(block, block === cfg.entry
          ? new Set([block]) : new Set(reachableBlocks));
      }
      let dominatorsChanged = true;
      while (dominatorsChanged) {
        dominatorsChanged = false;
        for (const block of reachableBlocks) {
          if (block === cfg.entry) continue;
          const predecessors = cfgPredecessors[block]
            .filter((candidate) => reachableBlockSet.has(candidate));
          if (!predecessors.length) continue;
          let next = new Set(dominators.get(predecessors[0]) || []);
          for (const predecessor of predecessors.slice(1)) {
            const predecessorDominators = dominators.get(predecessor) || new Set();
            next = new Set([...next].filter((candidate) =>
              predecessorDominators.has(candidate)));
          }
          next.add(block);
          const previous = dominators.get(block);
          if (previous.size !== next.size ||
              [...previous].some((candidate) => !next.has(candidate))) {
            dominators.set(block, next);
            dominatorsChanged = true;
          }
        }
      }
      for (const [index, direct] of directStaticSites) {
        if (direct.op !== "getstatic" ||
            direct.entryReadCache ||
            !/^\[(?:Z|B|C|S|I|F|D|J)$/.test(direct.descriptor || "") ||
            entryItems.has(index)) continue;
        const storeIndex = index + 1;
        const store = items[storeIndex]?.instruction;
        const storeOp = opOf(store);
        if (!/^astore(?:_[0-3])?$/.test(storeOp)) continue;
        const slot = localIndex(store, storeOp);
        const stores = [];
        const loads = [];
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          if (!normalReachableItems.has(itemIndex)) continue;
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          if (/^astore(?:_[0-3])?$/.test(op) &&
              localIndex(instruction, op) === slot) stores.push(itemIndex);
          if (/^aload(?:_[0-3])?$/.test(op) &&
              localIndex(instruction, op) === slot) loads.push(itemIndex);
        }
        if (stores.length !== 1 || stores[0] !== storeIndex || !loads.length) {
          continue;
        }
        const storeBlock = itemBlocks.get(storeIndex);
        if (!Number.isInteger(storeBlock) || loads.some((loadIndex) => {
          const loadBlock = itemBlocks.get(loadIndex);
          if (!Number.isInteger(loadBlock)) return true;
          return loadBlock === storeBlock
            ? loadIndex <= storeIndex
            : !dominators.get(loadBlock)?.has(storeBlock);
        })) continue;
        const view = {
          data: named(`ssaStaticArrayLocalData${slot}`),
          descriptor: direct.descriptor,
          storeIndex,
        };
        persistentStaticArrayLocalViews.set(slot, view);
        persistentStaticArrayStoreViews.set(storeIndex, view);
      }
      // Preserve a raw companion for a primitive array created by `newarray`
      // or returned by a call and then stored into one dominated JVM local.
      // The producer bytecode may execute repeatedly (for example once per
      // outer-loop iteration); the companion is refreshed by that same
      // astore before every dominated use.  This lets inner numeric loops use
      // one stable raw view instead of repeating representation selection on
      // every load/store.  Admission is descriptor/CFG based and does not
      // depend on any guest identity.
      const primitiveArrayDescriptorForType = (type) => ({
        "boolean[]": "[Z", "byte[]": "[B", "char[]": "[C",
        "short[]": "[S", "int[]": "[I", "float[]": "[F",
        "double[]": "[D", "long[]": "[J",
      })[type] || null;
      const primitiveArrayDescriptorForProducer = (producerIndex) => {
        const producer = items[producerIndex]?.instruction;
        const producerOp = opOf(producer);
        if (producerOp === "newarray") {
          return primitiveArrayDescriptorForType(`${producer.arg}[]`);
        }
        if (producerOp?.startsWith("invoke")) {
          return primitiveArrayDescriptorForType(
            callSites.get(producerIndex)?.returnType);
        }
        return null;
      };
      for (let storeIndex = 1;
        this.producedArrayLocalViewsEnabled && storeIndex < items.length;
        storeIndex += 1) {
        if (!normalReachableItems.has(storeIndex)) continue;
        const store = items[storeIndex]?.instruction;
        const storeOp = opOf(store);
        if (!/^astore(?:_[0-3])?$/.test(storeOp)) continue;
        const descriptor = primitiveArrayDescriptorForProducer(storeIndex - 1);
        if (!descriptor) continue;
        const slot = localIndex(store, storeOp);
        if (persistentStaticArrayLocalViews.has(slot)) continue;
        const stores = [];
        const loads = [];
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          if (!normalReachableItems.has(itemIndex)) continue;
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          if (/^astore(?:_[0-3])?$/.test(op) &&
              localIndex(instruction, op) === slot) stores.push(itemIndex);
          if (/^aload(?:_[0-3])?$/.test(op) &&
              localIndex(instruction, op) === slot) loads.push(itemIndex);
        }
        if (stores.length !== 1 || stores[0] !== storeIndex || !loads.length) {
          continue;
        }
        const storeBlock = itemBlocks.get(storeIndex);
        if (!Number.isInteger(storeBlock) || loads.some((loadIndex) => {
          const loadBlock = itemBlocks.get(loadIndex);
          if (!Number.isInteger(loadBlock)) return true;
          return loadBlock === storeBlock
            ? loadIndex <= storeIndex
            : !dominators.get(loadBlock)?.has(storeBlock);
        })) continue;
        const view = {
          data: named(`ssaProducedArrayLocalData${slot}`),
          descriptor,
          storeIndex,
        };
        persistentProducedArrayLocalViews.set(slot, view);
        persistentProducedArrayStoreViews.set(storeIndex, view);
      }
      for (const view of persistentStaticArrayLocalViews.values()) {
        // The companion is declared at generated entry and assigned before
        // every dominated use, so loop preheaders may name it. Unlike entry
        // parameters it is not unconditionally non-null; each range predicate
        // must retain its explicit null arm.
        guardedEntryArrayData.add(view.data);
      }
      for (const view of persistentProducedArrayLocalViews.values()) {
        guardedEntryArrayData.add(view.data);
      }
    }
    const localZeroAssigned = items.some((item) => {
      const instruction = item?.instruction, op = opOf(instruction);
      return op === "astore_0" ||
        op === "astore" && Number(instruction?.arg) === 0;
    });
    const directlyLoadsThis = (index) => {
      const instruction = items[index - 1]?.instruction;
      const op = opOf(instruction);
      return op === "aload_0" ||
        op === "aload" && Number(instruction?.arg) === 0;
    };
    const assignedReferenceLocals = new Set();
    for (const item of items) {
      const instruction = item?.instruction;
      const op = opOf(instruction);
      if (/^astore(?:_[0-3])?$/.test(op)) {
        assignedReferenceLocals.add(localIndex(instruction, op));
      }
    }
    const directlyLoadsEntryReference = (index) => {
      const instruction = items[index - 1]?.instruction;
      const op = opOf(instruction);
      if (!/^aload(?:_[0-3])?$/.test(op)) return null;
      const slot = localIndex(instruction, op);
      return entryReferenceLocalSlots.has(slot) &&
        !assignedReferenceLocals.has(slot) ? slot : null;
    };
    for (const cache of fieldReadCaches.values()) {
      cache.eagerThis = !hasUnknownStaticEffect &&
        cache.killKey && !entryStaticWriteKeys.has(cache.killKey) &&
        !methodIsStatic && !localZeroAssigned &&
        cache.indexes.every(directlyLoadsThis);
      const entrySlots = cache.indexes.map(directlyLoadsEntryReference);
      cache.eagerLocal = !hasUnknownStaticEffect &&
        cache.killKey && !entryStaticWriteKeys.has(cache.killKey) &&
        entrySlots[0] !== null &&
        entrySlots.every((slot) => slot === entrySlots[0])
        ? entrySlots[0] : null;
    }
    // Eager primitive-array fields are loaded before the generated body and
    // remain stable for one synchronous entry under the same write-summary
    // proof as their scalar field cache. Make those raw views available to
    // loop range analysis as well. A method that yields snapshots these array
    // identities in its continuation; a changed field invalidates before the
    // existing range proof can execute again.
    const eagerEntryFieldArrayData = new Set();
    const eagerFieldArrayDataByLocal = new Map();
    for (const cache of fieldReadCaches.values()) {
      if (cache.isArray && cache.eagerLocal !== null &&
          cache.eagerLocal !== undefined) {
        eagerEntryFieldArrayData.add(cache.data);
        // This membership enables field-backed range and continuation
        // versioning. It is added after unconditionallyNonNullEntryArrayData
        // is snapshotted above, so actual accesses still retain their null
        // slow arm; it is not an entry non-null assertion.
        guardedEntryArrayData.add(cache.data);
        const arrays = eagerFieldArrayDataByLocal.get(cache.eagerLocal) || [];
        arrays.push(cache.data);
        eagerFieldArrayDataByLocal.set(cache.eagerLocal, arrays);
      }
    }
    // javac commonly snapshots stable primitive-array fields into locals
    // before entering a numeric loop. Preserve the cache's raw storage view
    // through that unique astore. The same eager-field proof already shows
    // that the receiver and field binding survive this synchronous entry;
    // unique-store/dominance checks below show that the local cannot be
    // rebound on another CFG path. No owner or member identity participates.
    if ((code.code.exceptionTable || []).length === 0) {
      const entryItems = new Set(cfg.blocks[cfg.entry]?.insns || []);
      for (const cache of fieldReadCaches.values()) {
        if (!cache.isArray || cache.eagerLocal === null ||
            cache.eagerLocal === undefined || !cache.data) continue;
        for (const fieldIndex of cache.indexes) {
          if (!entryItems.has(fieldIndex) ||
              !entryItems.has(fieldIndex + 1)) continue;
          const store = items[fieldIndex + 1]?.instruction;
          const storeOp = opOf(store);
          if (!/^astore(?:_[0-3])?$/.test(storeOp)) continue;
          const slot = localIndex(store, storeOp);
          const stores = [];
          const loads = [];
          for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
            if (!normalReachableItems.has(itemIndex)) continue;
            const instruction = items[itemIndex]?.instruction;
            const op = opOf(instruction);
            if (/^astore(?:_[0-3])?$/.test(op) &&
                localIndex(instruction, op) === slot) stores.push(itemIndex);
            if (/^aload(?:_[0-3])?$/.test(op) &&
                localIndex(instruction, op) === slot) loads.push(itemIndex);
          }
          if (stores.length !== 1 || stores[0] !== fieldIndex + 1 ||
              !loads.length || loads.some((load) => load <= fieldIndex + 1)) {
            continue;
          }
          entryFieldArrayLocalViews.set(slot, {
            data: cache.data,
            descriptor: cache.descriptor,
          });
          break;
        }
      }
    }
    const invalidateFieldReadCaches = (writeKeys = null) =>
      [...fieldReadCaches.values()]
        .filter((cache) => !writeKeys ||
          !cache.killKey || writeKeys.has(cache.killKey))
        .flatMap((cache) => [
        st`${cache.valid} = false;`,
        ...(cache.isArray ? [st`${cache.data} = null;`] : []),
      ]);
    // javac has to give source-level temporaries a value before the first
    // structured try/loop join.  Decompiled methods can consequently start
    // with dozens of `iconst_0; istore` / `aconst_null; astore` pairs.  The
    // generated function already creates one JavaScript local for every JVM
    // slot, so fold a side-effect-free entry prefix into those declarations
    // instead of first reading stale Frame slots and then overwriting them.
    //
    // This is not dead-store elimination: the declared local has the exact
    // bytecode value at exceptions, scheduler safe points, and normal spills.
    // Stop at the first load, branch, field access, call, or other observable
    // instruction, and require the entire prefix to be in the unique entry
    // block so no control-flow edge can enter halfway through it.
    const entryLocalInitialValues = new Map();
    const foldedEntryStoreIndexes = new Set();
    const entryBlock = cfg.blocks[cfg.entry];
    if (entryBlock && !entryBlock.synthetic) {
      const constantStack = [];
      const literalForEntryInstruction = (instruction, op) => {
        if (op === "aconst_null") return "null";
        if (/^iconst_(?:m1|[0-5])$/.test(op)) {
          return op === "iconst_m1" ? "-1" : op.slice(-1);
        }
        if (op === "bipush" || op === "sipush") {
          const number = Number(instruction.arg);
          return Number.isInteger(number) ? String(number | 0) : null;
        }
        if (/^dconst_[01]$/.test(op) || /^fconst_[0-2]$/.test(op)) return op.slice(-1);
        if (op === "ldc" || op === "ldc_w" || op === "ldc2_w") {
          const arg = instruction && typeof instruction === "object" ? instruction.arg : undefined;
          const resolved = arg && typeof arg === "object" &&
            Object.prototype.hasOwnProperty.call(arg, "value") ? arg.value : arg;
          if (typeof resolved === "number" && Number.isFinite(resolved)) {
            if (Object.is(resolved, -0)) return "-0";
            return String(resolved);
          }
          if (typeof resolved === "bigint") return `${resolved}n`;
        }
        return null;
      };
      for (const index of entryBlock.insns) {
        const instruction = items[index]?.instruction;
        const op = opOf(instruction);
        if (!op || op === "nop") continue;
        const literal = literalForEntryInstruction(instruction, op);
        if (literal !== null) {
          constantStack.push(literal);
          continue;
        }
        if (/^[adfil]store(?:_[0-3])?$/.test(op) && constantStack.length) {
          const slot = localIndex(instruction, op);
          if (!Number.isInteger(slot) || slot < 0 || slot >= localCount) break;
          const input = constantStack.pop();
          entryLocalInitialValues.set(slot, input);
          foldedEntryStoreIndexes.add(index);
          continue;
        }
        break;
      }
    }
    // The entry-static proof above establishes a unique astore and an
    // already-initialized, entry-cached source. Generated entries reject null
    // array parameters and unresolved classes before executing the body, so
    // this copy is observationally identical when placed in the scalar local
    // declaration. Treat it as an immutable entry value instead of carrying
    // a mutable JVM-local alias through every later loop.
    for (const [slot, initializer] of entryStaticArrayLocalInitializers) {
      entryLocalInitialValues.set(slot, initializer.value);
      foldedEntryStoreIndexes.add(initializer.storeIndex);
    }
    // Forward must-facts for local integer comparisons. This proves common
    // guarded divisions such as `(y - y0) * dx / (y1 - y0)`: either side of
    // an OR-shaped crossing predicate may establish the opposite ordering,
    // but both establish the same unordered non-equality. Facts are killed
    // by local writes and intersected at joins, so no loop-iteration or
    // predecessor-specific assumption can leak into a generated block.
    const dominatedNonZeroDivisionItems = new Set();
    const literalNonZeroDivisionItems = new Set();
    let cfgDominatedArithmeticGuardCount = 0;
    {
      const relationKey = (kind, left, right) =>
        kind === "ne" && left > right
          ? `${kind}:${right}:${left}` : `${kind}:${left}:${right}`;
      const killSlotFacts = (facts, slot) => new Set([...facts].filter((fact) => {
        const [, left, right] = fact.split(":").map((value, index) =>
          index === 0 ? value : Number(value));
        return left !== slot && right !== slot;
      }));
      const closeFacts = (facts) => {
        const slots = new Set();
        const nonEqual = new Set();
        const edges = [];
        for (const fact of facts) {
          const [kind, leftText, rightText] = fact.split(":");
          const left = Number(leftText), right = Number(rightText);
          slots.add(left); slots.add(right);
          if (kind === "ne") nonEqual.add(relationKey("ne", left, right));
          else edges.push({left, right, strict: kind === "lt"});
        }
        const values = [...slots];
        const relation = new Map();
        for (const slot of values) relation.set(`${slot}:${slot}`, false);
        for (const edge of edges) {
          const key = `${edge.left}:${edge.right}`;
          relation.set(key, Boolean(relation.get(key)) || edge.strict);
        }
        for (const middle of values) for (const left of values) {
          const leftMiddle = relation.get(`${left}:${middle}`);
          if (leftMiddle === undefined) continue;
          for (const right of values) {
            const middleRight = relation.get(`${middle}:${right}`);
            if (middleRight === undefined) continue;
            const key = `${left}:${right}`;
            const strict = leftMiddle || middleRight;
            if (!relation.has(key) || strict && !relation.get(key)) {
              relation.set(key, strict);
            }
          }
        }
        const closed = new Set(nonEqual);
        for (const [pair, strict] of relation) {
          const [left, right] = pair.split(":").map(Number);
          if (left === right) continue;
          closed.add(relationKey(strict ? "lt" : "le", left, right));
          if (strict) closed.add(relationKey("ne", left, right));
        }
        return closed;
      };
      const localLoadSlot = (instruction) => {
        const op = opOf(instruction);
        return /^iload(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const writtenLocalSlot = (instruction) => {
        const op = opOf(instruction);
        if (op === "iinc") return Number(instruction.varnum ?? instruction.arg);
        return /^istore(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const branchFacts = (block, taken) => {
        const blockItems = block.insns || [];
        const branch = items[blockItems.at(-1)]?.instruction;
        const op = opOf(branch);
        if (!/^if_icmp(?:eq|ne|lt|le|gt|ge)$/.test(op) ||
            blockItems.length < 3) return [];
        const left = localLoadSlot(items[blockItems.at(-3)]?.instruction);
        const right = localLoadSlot(items[blockItems.at(-2)]?.instruction);
        if (!Number.isInteger(left) || !Number.isInteger(right)) return [];
        const selected = taken ? op : ({
          if_icmpeq: "if_icmpne", if_icmpne: "if_icmpeq",
          if_icmplt: "if_icmpge", if_icmpge: "if_icmplt",
          if_icmpgt: "if_icmple", if_icmple: "if_icmpgt",
        })[op];
        if (selected === "if_icmpne") return [relationKey("ne", left, right)];
        if (selected === "if_icmplt") return [relationKey("lt", left, right)];
        if (selected === "if_icmple") return [relationKey("le", left, right)];
        if (selected === "if_icmpgt") return [relationKey("lt", right, left)];
        if (selected === "if_icmpge") return [relationKey("le", right, left)];
        return [];
      };
      const inputs = new Map([[cfg.entry, new Set()]]);
      const work = [cfg.entry];
      while (work.length) {
        const blockId = work.shift();
        const block = cfg.blocks[blockId];
        if (!block || block.synthetic) continue;
        let facts = new Set(inputs.get(blockId) || []);
        for (const itemIndex of block.insns || []) {
          const written = writtenLocalSlot(items[itemIndex]?.instruction);
          if (Number.isInteger(written)) facts = killSlotFacts(facts, written);
        }
        const term = cfg.term[blockId];
        for (const successor of cfg.succ[blockId] || []) {
          let outgoing = new Set(facts);
          if (term?.kind === "cond") {
            const taken = successor === term.taken;
            for (const fact of branchFacts(block, taken)) outgoing.add(fact);
            outgoing = closeFacts(outgoing);
          }
          const previous = inputs.get(successor);
          const merged = previous === undefined ? outgoing :
            new Set([...previous].filter((fact) => outgoing.has(fact)));
          if (previous === undefined || merged.size !== previous.size ||
              [...merged].some((fact) => !previous.has(fact))) {
            inputs.set(successor, merged);
            work.push(successor);
          }
        }
      }
      for (const block of cfg.blocks) {
        if (!block || block.synthetic || !inputs.has(block.id)) continue;
        let facts = new Set(inputs.get(block.id));
        const blockItems = block.insns || [];
        for (let position = 0; position < blockItems.length; position += 1) {
          const itemIndex = blockItems[position];
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          if ((op === "idiv" || op === "irem") && position >= 3 &&
              opOf(items[blockItems[position - 1]]?.instruction) === "isub") {
            const left = localLoadSlot(
              items[blockItems[position - 3]]?.instruction);
            const right = localLoadSlot(
              items[blockItems[position - 2]]?.instruction);
            if (Number.isInteger(left) && Number.isInteger(right) &&
                facts.has(relationKey("ne", left, right))) {
              dominatedNonZeroDivisionItems.add(itemIndex);
            }
          }
          const written = writtenLocalSlot(instruction);
          if (Number.isInteger(written)) facts = killSlotFacts(facts, written);
        }
      }
    }
    const edgeLines = (target, stack) => {
      if (!Number.isInteger(target) || !cfg.blocks[target]) return null;
      const synthetic = cfg.blocks[target].synthetic;
      if (synthetic) {
        // Setter blocks receive the entry's live operands in island transfer
        // slots; dispatcher chain blocks carry nothing.
        const targetDepth = synthetic.kind === "set" ? synthetic.depth : 0;
        if (targetDepth !== stack.length) return null;
        return stack.map((expression, slot) => stmt(
          e`${named(`${synthetic.transfer}${slot}`)} = ${expression};`,
          {kind: "assign", write: `${synthetic.transfer}${slot}`}));
      }
      const targetDepth = depths[cfg.blocks[target].insns[0]];
      if (targetDepth !== stack.length) return null;
      return stack.map((expression, slot) => stmt(
          e`${named(`ssaStack${target}_${slot}`)} = ${expression};`,
          {kind: "assign", write: `ssaStack${target}_${slot}`}));
    };
    // Frame reconstruction repeats at hundreds of sites in large bodies; the
    // locals copy is hoisted into one closure so emitted source stays small
    // enough for the engine to fully optimize the body.
    const materializationLocalValuesByPc = new Map();
    let currentMaterializationLocalValues = null;
    // Item indexes covered by any exception-table entry. A throw at an
    // uncovered index cannot be handled in this method, so its materialized
    // frame exists only to unwind and needs no locals. Unresolvable range
    // labels conservatively cover the whole method.
    const exceptionUncoveredItemIndex = (() => {
      if (this.unwindCompactMaterializationDisabled) return () => false;
      const table = code.code.exceptionTable || [];
      if (!table.length) return () => true;
      const labelToItem = new Map();
      const pcToItem = new Map();
      items.forEach((item, itemIndex) => {
        if (item && item.labelDef) {
          const label = String(item.labelDef).trim().replace(/:$/, "");
          labelToItem.set(label, itemIndex);
        }
        if (item && typeof item.pc === "number") {
          pcToItem.set(item.pc, itemIndex);
        }
      });
      const point = (entry, pcKeys, labelKeys) => {
        for (const key of pcKeys) {
          if (typeof entry[key] === "number") {
            return pcToItem.get(entry[key]);
          }
        }
        for (const key of labelKeys) {
          if (entry[key]) {
            const label = String(entry[key]).trim().replace(/:$/, "");
            return labelToItem.get(label);
          }
        }
        return undefined;
      };
      const ranges = [];
      for (const entry of table) {
        const start = point(entry, ["start_pc"],
          ["startLbl", "startLabel", "start"]);
        if (start === undefined) return () => false;
        const end = point(entry, ["end_pc"], ["endLbl", "endLabel", "end"]);
        ranges.push([start, end === undefined ? items.length : end]);
      }
      return (pc) => ranges.every(([from, to]) => pc < from || pc >= to);
    })();
    let lastMaterializeWasUnwindCompact = false;
    const materializeLines = (operandValues, pc, unwindOnly = false) => {
      if (currentMaterializationLocalValues) {
        materializationLocalValuesByPc.set(
          pc, [...currentMaterializationLocalValues]);
      }
      lastMaterializeWasUnwindCompact = false;
      if (!this.materializeOutliningEnabled) {
        return [
          spillStatement(),
          ...operandValues.map((expression, index) =>
            stmt(e`stack[${index}] = ${expression};`, {kind: "spillStack"})),
          st`stack.length = ${operandValues.length};`,
          stmt(e`helpers.materialize(frame, locals, stack, ${pc});`,
            {kind: "materializeSpill"}),
        ];
      }
      // The expansion regex splits marker operands on commas, so compaction
      // admits only comma-free operand expressions.
      if (unwindOnly && exceptionUncoveredItemIndex(pc) &&
          operandValues.every((expression) => !expression.includes(","))) {
        materializeUnwindDepths.add(operandValues.length);
        lastMaterializeWasUnwindCompact = true;
        return [
          stmt(exprConcat(e`ssaMaterializeUnwind${operandValues.length}(`,
            argumentListExpression([pc, ...operandValues]), e`);`),
          {kind: "materialize", unwind: true, pc,
            operands: operandValues.map((expression) => e`${expression}`)}),
        ];
      }
      lastMaterializeWasUnwindCompact = false;
      materializeDepths.add(operandValues.length);
      return [
        stmt(exprConcat(e`ssaMaterialize${operandValues.length}(`,
          argumentListExpression([pc, ...operandValues]), e`);`),
        {kind: "materialize", unwind: false, pc,
          operands: operandValues.map((expression) => e`${expression}`)}),
      ];
    };
    // Placed after the helper call of a compacted arm; expands to nothing in
    // spill-based outputs and to a frame withdrawal in capture-free output.
    // Emitted only when the arm's materialization actually compacted, so no
    // output can reference the marker without its declaration.
    const materializeUnwindReleaseLines = (indentation) =>
      lastMaterializeWasUnwindCompact
        ? [stmt(e`${indentation}ssaMaterializeUnwindRelease();`,
          {kind: "materializeRelease"})] : [];
    // A synchronous guest call can throw after installing its child Frame.
    // If that child catches the exception, its eventual return must resume
    // this frame after the invoke with only the operands below the arguments.
    // If no child was installed (for example, a direct JRE intrinsic threw),
    // the exception belongs to this frame and must retain the invoke pc and
    // complete pre-call stack for normal handler dispatch.
    const materializeCallExceptionLines = (
      preCallValues, postCallValues, pc, callStackDepth,
      childCanResume = "true", restoreMarkers = null,
    ) => [
      stmt(e`if (${childCanResume} && thread.callStack.items.length > ${
        callStackDepth}) {`),
      ...materializeLines(postCallValues, pc + 1).map((line) => `  ${line}`),
      elseArm(""),
      // A caller that lowers this call into a region reuses the exact
      // call-pc restoration arm. Bracket it with a compiler-owned token pair
      // so the arm can be taken by identity from whatever this body was
      // finally emitted as, rather than located by parsing the result.
      ...(restoreMarkers ? [st`  /*${restoreMarkers.start}*/`] : []),
      ...materializeLines(preCallValues, pc).map((line) => `  ${line}`),
      ...(restoreMarkers ? [st`  /*${restoreMarkers.end}*/`] : []),
      blockEnd(""),
    ];
    const stageOperandLines = (operandValues) => [
      recordStatement(["if (frame === null) spillLocals();"],
        {kind: "conditionalSpill"}),
      ...operandValues.map((expression, i) =>
        stmt(e`stack[${i}] = ${expression};`, {kind: "spillStack"})),
      st`stack.length = ${operandValues.length};`,
    ];

    // Forward constant dataflow supplies block-entry local values after a
    // guarded static branch has made one CFG arm unreachable.  The analysis
    // is deliberately sparse: it understands constants, local transfers, and
    // branch stack effects; every other opcode produces unknown operands while
    // retaining the verifier-proven stack depth.  Stores are still emitted, so
    // exception/snapshot materialization remains byte-for-byte canonical.
    const blockEntryLocalConstants = new Map();
    if (guardedStaticBooleanSites.size && !cfg.blocks.some((block) => block.synthetic)) {
      const UNKNOWN = Symbol("unknown structured constant");
      const literal = (instruction, op) => {
        if (op === "aconst_null") return "null";
        if (/^iconst_(?:m1|[0-5])$/.test(op)) return op === "iconst_m1" ? "-1" : op.slice(-1);
        if (op === "bipush" || op === "sipush") {
          const number = Number(instruction.arg);
          return Number.isInteger(number) ? String(number | 0) : UNKNOWN;
        }
        if (/^dconst_[01]$/.test(op) || /^fconst_[0-2]$/.test(op)) return op.slice(-1);
        if (op === "ldc" || op === "ldc_w" || op === "ldc2_w") {
          const arg = instruction && typeof instruction === "object" ? instruction.arg : undefined;
          const resolved = arg && typeof arg === "object" &&
            Object.prototype.hasOwnProperty.call(arg, "value") ? arg.value : arg;
          if (typeof resolved === "number" && Number.isFinite(resolved)) {
            return Object.is(resolved, -0) ? "-0" : String(resolved);
          }
          if (typeof resolved === "bigint") return `${resolved}n`;
        }
        return UNKNOWN;
      };
      const stateAt = new Map();
      const initialDepth = depths[cfg.blocks[cfg.entry].insns[0]] || 0;
      stateAt.set(cfg.entry, {
        stack: new Array(initialDepth).fill(UNKNOWN),
        locals: new Array(localCount).fill(UNKNOWN),
      });
      const work = [cfg.entry];
      const nextDepth = (index, fallback) => {
        for (let next = index + 1; next < items.length; next += 1) {
          if (depths[next] !== undefined) return depths[next];
        }
        return fallback;
      };
      const mergeInto = (target, incoming) => {
        const previous = stateAt.get(target);
        if (!previous) {
          stateAt.set(target, {
            stack: [...incoming.stack], locals: [...incoming.locals],
          });
          return true;
        }
        let changed = false;
        for (let slot = 0; slot < previous.stack.length; slot += 1) {
          if (previous.stack[slot] !== incoming.stack[slot] && previous.stack[slot] !== UNKNOWN) {
            previous.stack[slot] = UNKNOWN; changed = true;
          }
        }
        for (let slot = 0; slot < previous.locals.length; slot += 1) {
          if (previous.locals[slot] !== incoming.locals[slot] && previous.locals[slot] !== UNKNOWN) {
            previous.locals[slot] = UNKNOWN; changed = true;
          }
        }
        return changed;
      };
      while (work.length) {
        const blockId = work.shift();
        const block = cfg.blocks[blockId], input = stateAt.get(blockId);
        if (!block || !input) continue;
        const stack = [...input.stack], localsState = [...input.locals];
        let knownCondition = null;
        const popKnown = () => stack.length ? stack.pop() : UNKNOWN;
        for (const index of block.insns) {
          const instruction = items[index]?.instruction, op = opOf(instruction);
          if (!op || op === "nop") continue;
          const constant = literal(instruction, op);
          if (constant !== UNKNOWN) stack.push(constant);
          else if (/^[adfil]load(?:_[0-3])?$/.test(op)) {
            stack.push(localsState[localIndex(instruction, op)] ?? UNKNOWN);
          } else if (/^[adfil]store(?:_[0-3])?$/.test(op)) {
            localsState[localIndex(instruction, op)] = popKnown();
          } else if (op === "iinc") {
            const slot = Number(instruction.varnum ?? instruction.arg);
            const increment = Number(instruction.incr ?? 0);
            const before = localsState[slot];
            localsState[slot] = typeof before === "string" && /^-?\d+$/.test(before)
              ? String((Number(before) + increment) | 0) : UNKNOWN;
          } else if (op === "pop") popKnown();
          else if (op === "dup") {
            const top = popKnown(); stack.push(top, top);
          } else if (op === "dup_x1") {
            const top = popKnown(), under = popKnown();
            stack.push(top, under, top);
          } else if (op === "dup_x2") {
            const widths = verifiedStackWidthsBefore?.get(index) || [];
            const top = popKnown(), under = popKnown();
            if (widths.at(-2) === 2) {
              stack.push(top, under, top);
            } else {
              const bottom = popKnown();
              stack.push(top, bottom, under, top);
            }
          } else if (op === "dup2") {
            const top = popKnown(), under = popKnown(); stack.push(under, top, under, top);
          } else if (op === "getstatic" && guardedStaticBooleanSites.has(index)) {
            stack.push(String(guardedStaticBooleanSites.get(index).guardedBooleanValue));
          } else if (op.startsWith("if")) {
            if (op.startsWith("if_icmp") || op.startsWith("if_acmp")) {
              const right = popKnown(), left = popKnown();
              if (left !== UNKNOWN && right !== UNKNOWN) {
                const a = left === "null" ? null : Number(left), b = right === "null" ? null : Number(right);
                knownCondition = op.endsWith("eq") ? a === b : op.endsWith("ne") ? a !== b
                  : op.endsWith("lt") ? a < b : op.endsWith("ge") ? a >= b
                    : op.endsWith("gt") ? a > b : a <= b;
              }
            } else {
              const inputValue = popKnown();
              if (inputValue !== UNKNOWN) {
                if (op === "ifnull" || op === "ifnonnull") {
                  knownCondition = op === "ifnull" ? inputValue === "null" : inputValue !== "null";
                } else if (/^-?\d+$/.test(inputValue)) {
                  const number = Number(inputValue);
                  knownCondition = op === "ifeq" ? number === 0 : op === "ifne" ? number !== 0
                    : op === "iflt" ? number < 0 : op === "ifge" ? number >= 0
                      : op === "ifgt" ? number > 0 : number <= 0;
                }
              }
            }
          } else if (op !== "goto" && op !== "goto_w" &&
              !/^(?:[adfil]?return|athrow)$/.test(op)) {
            stack.length = nextDepth(index, stack.length);
            stack.fill(UNKNOWN);
          }
        }
        blockEntryLocalConstants.set(blockId, input.locals.map((entry) =>
          entry === UNKNOWN ? null : entry));
        const term = cfg.term[blockId];
        let successors = cfg.succ[blockId] || [];
        if (term.kind === "cond" && knownCondition !== null) {
          successors = [knownCondition ? term.taken : term.fall];
        }
        for (const successor of successors) {
          if (!Number.isInteger(successor) || !cfg.blocks[successor]) continue;
          const targetDepth = depths[cfg.blocks[successor].insns[0]] || 0;
          const outgoing = {
            stack: stack.length === targetDepth ? [...stack] : new Array(targetDepth).fill(UNKNOWN),
            locals: [...localsState],
          };
          if (mergeInto(successor, outgoing)) work.push(successor);
        }
      }
    }

    // A scalar SSA value already records the exact value written to a JVM
    // local. In handler-free methods, a store whose slot is dead after that
    // bytecode need not also update the mutable JavaScript `localN` mirror:
    // precise cold materialization below rematerializes from the SSA value.
    // Normal-flow liveness is sufficient only when there are no exception
    // edges; methods with handlers conservatively retain every local store.
    const liveLocalsOutByBlock = cfg.blocks.map(() => null);
    if ((code.code.exceptionTable || []).length === 0 &&
        dispatchIslands === 0 && splitBlocks === 0) {
      const localUseDef = (instruction) => {
        const op = opOf(instruction);
        if (/^[adfil]load(?:_[0-3])?$/.test(op || "")) {
          return {uses: [localIndex(instruction, op)], defs: []};
        }
        if (/^[adfil]store(?:_[0-3])?$/.test(op || "")) {
          return {uses: [], defs: [localIndex(instruction, op)]};
        }
        if (op === "iinc") {
          const slot = Number(instruction.varnum ?? instruction.arg);
          return {uses: [slot], defs: [slot]};
        }
        if (op === "ret") {
          return {uses: [Number(instruction.arg)], defs: []};
        }
        return {uses: [], defs: []};
      };
      const blockUses = cfg.blocks.map(() => new Set());
      const blockDefs = cfg.blocks.map(() => new Set());
      for (const candidateBlock of cfg.blocks) {
        if (!candidateBlock || candidateBlock.synthetic) continue;
        const uses = blockUses[candidateBlock.id];
        const defs = blockDefs[candidateBlock.id];
        for (const itemIndex of candidateBlock.insns || []) {
          const flow = localUseDef(items[itemIndex]?.instruction);
          for (const slot of flow.uses) {
            if (Number.isInteger(slot) && !defs.has(slot)) uses.add(slot);
          }
          for (const slot of flow.defs) {
            if (Number.isInteger(slot)) defs.add(slot);
          }
        }
      }
      const liveIn = cfg.blocks.map(() => new Set());
      const liveOut = cfg.blocks.map(() => new Set());
      let changed = true;
      while (changed) {
        changed = false;
        for (let blockId = cfg.blocks.length - 1;
          blockId >= 0; blockId -= 1) {
          const candidateBlock = cfg.blocks[blockId];
          if (!candidateBlock || candidateBlock.synthetic) continue;
          const nextOut = new Set();
          for (const successor of cfg.succ[blockId] || []) {
            for (const slot of liveIn[successor] || []) nextOut.add(slot);
          }
          const nextIn = new Set(blockUses[blockId]);
          for (const slot of nextOut) {
            if (!blockDefs[blockId].has(slot)) nextIn.add(slot);
          }
          const differs = (left, right) => left.size !== right.size ||
            [...left].some((slot) => !right.has(slot));
          if (differs(nextOut, liveOut[blockId]) ||
              differs(nextIn, liveIn[blockId])) {
            liveOut[blockId] = nextOut;
            liveIn[blockId] = nextIn;
            changed = true;
          }
        }
      }
      for (let blockId = 0; blockId < liveOut.length; blockId += 1) {
        liveLocalsOutByBlock[blockId] = liveOut[blockId];
      }
    }
    let eliminatedDeadLocalStoreCount = 0;
    const boundedLocalDefinitionRangeMemo = new Map();
    const bytecodeIntegerConstant = (instruction) => {
      const op = opOf(instruction);
      if (op === "iconst_m1") return -1;
      const iconst = /^iconst_([0-5])$/.exec(op || "");
      if (iconst) return Number(iconst[1]);
      if (op === "bipush" || op === "sipush" ||
          op === "ldc" || op === "ldc_w") {
        const value = Number(instruction?.arg);
        return Number.isInteger(value) ? value | 0 : null;
      }
      return null;
    };
    const boundedLocalDefinitionRange = (slot, visiting = new Set()) => {
      if (boundedLocalDefinitionRangeMemo.has(slot)) {
        return boundedLocalDefinitionRangeMemo.get(slot);
      }
      if (visiting.has(slot)) return null;
      const nextVisiting = new Set(visiting);
      nextVisiting.add(slot);
      const definitions = [];
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        if (!normalReachableItems.has(itemIndex)) continue;
        const instruction = items[itemIndex]?.instruction;
        const op = opOf(instruction);
        const written = op === "iinc"
          ? Number(instruction.varnum ?? instruction.arg)
          : /^istore(?:_[0-3])?$/.test(op)
            ? localIndex(instruction, op) : null;
        if (written === slot) definitions.push({itemIndex, op});
      }
      if (definitions.length !== 1 || definitions[0].op === "iinc") {
        boundedLocalDefinitionRangeMemo.set(slot, null);
        return null;
      }
      const parseBefore = (cursor, depth = 0) => {
        if (depth > 32) return null;
        let itemIndex = cursor - 1;
        while (itemIndex >= 0 && ["nop"].includes(
          opOf(items[itemIndex]?.instruction))) itemIndex -= 1;
        if (itemIndex < 0) return null;
        const instruction = items[itemIndex]?.instruction;
        const op = opOf(instruction);
        const constant = bytecodeIntegerConstant(instruction);
        if (constant !== null) {
          return {start: itemIndex,
            range: {minimum: constant, maximum: constant}};
        }
        if (/^iload(?:_[0-3])?$/.test(op)) {
          return {
            start: itemIndex,
            range: boundedLocalDefinitionRange(
              localIndex(instruction, op), nextVisiting),
          };
        }
        if (op === "ineg") {
          const input = parseBefore(itemIndex, depth + 1);
          if (!input) return null;
          const range = input.range && input.range.minimum !== -2147483648
            ? {minimum: -input.range.maximum,
              maximum: -input.range.minimum} : null;
          return {start: input.start, range};
        }
        const binaryOps = new Set([
          "iadd", "isub", "imul", "irem", "iand",
        ]);
        if (!binaryOps.has(op)) return null;
        const right = parseBefore(itemIndex, depth + 1);
        if (!right) return null;
        const left = parseBefore(right.start, depth + 1);
        if (!left) return null;
        let range = null;
        if (op === "irem" && right.range &&
            right.range.minimum === right.range.maximum &&
            right.range.minimum !== 0) {
          const limit = Math.abs(right.range.minimum) - 1;
          range = left.range ? {
            minimum: Math.max(-limit, left.range.minimum),
            maximum: Math.min(limit, left.range.maximum),
          } : {minimum: -limit, maximum: limit};
        } else if (op === "iand") {
          const mask = left.range && left.range.minimum === left.range.maximum
            ? left.range.minimum
            : right.range && right.range.minimum === right.range.maximum
              ? right.range.minimum : null;
          if (Number.isInteger(mask) && mask >= 0) {
            range = {minimum: 0, maximum: mask};
          }
        } else if (left.range && right.range) {
          let minimum;
          let maximum;
          if (op === "iadd") {
            minimum = left.range.minimum + right.range.minimum;
            maximum = left.range.maximum + right.range.maximum;
          } else if (op === "isub") {
            minimum = left.range.minimum - right.range.maximum;
            maximum = left.range.maximum - right.range.minimum;
          } else if (op === "imul") {
            const products = [
              left.range.minimum * right.range.minimum,
              left.range.minimum * right.range.maximum,
              left.range.maximum * right.range.minimum,
              left.range.maximum * right.range.maximum,
            ];
            minimum = Math.min(...products);
            maximum = Math.max(...products);
          }
          if (minimum >= -2147483648 && maximum <= 2147483647) {
            range = {minimum, maximum};
          }
        }
        return {start: left.start, range};
      };
      const parsed = parseBefore(definitions[0].itemIndex);
      const range = parsed?.range || null;
      boundedLocalDefinitionRangeMemo.set(slot, range);
      return range;
    };

    for (const block of cfg.blocks) {
      if (block.synthetic) {
        const synthetic = block.synthetic;
        const descriptor = cfg.term[block.id];
        if (synthetic.kind === "set") {
          plans[block.id] = {
            lines: [`${synthetic.variable} = ${synthetic.state};`],
            stack: [],
          };
        } else {
          // The fan-out edge to a real entry feeds that entry's join slots
          // from the island transfer slots; edges within the chain are empty.
          const transfersFor = (target) => cfg.blocks[target]?.synthetic ? [] :
            Array.from({ length: synthetic.entryDepths[synthetic.entryPcs
              .indexOf(cfg.blocks[target].insns[0])] || 0 },
            (_unused, slot) => `${synthetic.transfer}${slot}`);
          plans[block.id] = {
            lines: [],
            condition: operand(
              e`${named(synthetic.variable)} === ${synthetic.state}`),
            taken: descriptor.taken,
            fall: descriptor.fall,
            stack: [],
            takenStack: transfersFor(descriptor.taken),
            fallStack: transfersFor(descriptor.fall),
          };
        }
        continue;
      }
      const entryDepth = depths[block.insns[0]];
      if (entryDepth === undefined) { plans[block.id] = { lines: [], terminal: true }; continue; }
      const stack = Array.from({ length: entryDepth }, (_unused, slot) =>
        named(`ssaStack${block.id}_${slot}`));
      const lines = [];
      const arrayViews = new Map();
      const arrayKinds = new Map();
      const dynamicBlockArrayViews = new Set();
      const integerOrigins = new Map();
      // Keep i2l conversions as exact, side-effect-free expressions until a
      // consumer actually needs a Java long.  Besides avoiding pointless
      // temporaries, this lets the typed SSA renderer recognize the common
      // fixed-point graph
      //
      //   l2i(lshr(lmul(i2l(a), i2l(b)), 16))
      //
      // and lower it to exact 32-bit Math.imul arithmetic.  The maps contain
      // SSA values, not generated-source text patterns, and are deliberately
      // block-local so an opaque call or control-flow join cannot invalidate
      // their provenance.
      const intToLongOrigins = new Map();
      const fixedPointProducts = new Map();
      const fixedPointShiftedProducts = new Map();
      // Repeated getstatic bytecodes in one straight-line block often load the
      // same framebuffer before a sequence of unrolled stores. Reuse that
      // value only within the block and only until a call/static write, so a
      // scheduler safe point or arbitrary guest effect can never stale it.
      const directStaticBlockValues = new Map();
      // A successful primitive load proves that the same array/index pair is
      // non-null and in bounds for the remainder of this straight-line basic
      // block. Java primitive arrays never contain `undefined`, so a raw
      // storage load can use it as the exceptional sentinel. A later store to
      // the identical raw view and immutable index can reuse that proof.
      //
      // Keep this block-local: calls, joins, and loop backedges must not carry
      // a proof across heap mutation or select it from the wrong predecessor.
      const checkedPrimitiveArrayAccesses = new Set();
      // JVM locals are mutable slots, but repeated loads within one basic
      // block see the same value until a store/iinc. Snapshot the first load
      // into an SSA value and reuse it. After a store the incoming stack value
      // already is immutable for the remainder of the block, so it becomes
      // the new cached value. This is deliberately block-local: carrying the
      // cache across a join would require phi construction and could otherwise
      // select a value from the wrong predecessor.
      const localValues = blockEntryLocalConstants.has(block.id)
        ? [...blockEntryLocalConstants.get(block.id)] : new Array(localCount).fill(null);
      currentMaterializationLocalValues = localValues;
      const readLocal = (slot) => {
        const cached = localValues[slot];
        if (this.localValueNumberingEnabled && cached !== null) {
          reusedLocalLoadCount += 1;
          // Even when the current local value already has an SSA name, this
          // bytecode load establishes the symbolic local slot used by loop
          // recurrence and range analysis.
          // A store may have assigned this block-local SSA value a more
          // precise arithmetic origin (for example, a signed shift). Preserve
          // that proof across a subsequent load; use the symbolic local only
          // when the value arrived from a join/entry without an expression.
          if (!integerOrigins.has(cached)) {
            const origin = {kind: "local", slot};
            integerOrigins.set(cached, origin);
            methodIntegerOrigins.set(cached, origin);
          }
          localLoads.set(cached, slot);
          if (entryArrayLocalSlots.has(slot)) {
            arrayViews.set(cached, entryArrayDataVariable(slot));
            if (entryArrayKinds.has(slot)) {
              arrayKinds.set(cached, entryArrayKinds.get(slot));
            }
          }
          const staticArrayView = persistentProducedArrayLocalViews.get(slot) ||
            persistentStaticArrayLocalViews.get(slot) ||
            entryStaticArrayLocalViews.get(slot) ||
            entryFieldArrayLocalViews.get(slot);
          if (staticArrayView &&
              (!staticArrayView.blocks || staticArrayView.blocks.has(block.id))) {
            arrayViews.set(cached, staticArrayView.data);
            arrayKinds.set(cached, staticArrayView.descriptor);
          }
          if (entryReferenceLocalSlots.has(slot) &&
              !assignedReferenceLocals.has(slot)) {
            entryReferenceLoads.set(cached, slot);
          }
          return cached;
        }
        const out = value();
        lines.push(constDecl(out, e`${localName(slot)}`,
          {pure: true, localSnapshot: slot}));
        const origin = {kind: "local", slot};
        integerOrigins.set(out, origin);
        methodIntegerOrigins.set(out, origin);
        localLoads.set(out, slot);
        if (entryArrayLocalSlots.has(slot)) {
          arrayViews.set(out, entryArrayDataVariable(slot));
          if (entryArrayKinds.has(slot)) {
            arrayKinds.set(out, entryArrayKinds.get(slot));
          }
        }
        const staticArrayView = persistentProducedArrayLocalViews.get(slot) ||
          persistentStaticArrayLocalViews.get(slot) ||
          entryStaticArrayLocalViews.get(slot) ||
          entryFieldArrayLocalViews.get(slot);
        if (staticArrayView &&
            (!staticArrayView.blocks || staticArrayView.blocks.has(block.id))) {
          arrayViews.set(out, staticArrayView.data);
          arrayKinds.set(out, staticArrayView.descriptor);
        }
        if (entryReferenceLocalSlots.has(slot) &&
            !assignedReferenceLocals.has(slot)) {
          entryReferenceLoads.set(out, slot);
        }
        if (this.localValueNumberingEnabled) localValues[slot] = out;
        return out;
      };
      const copyValueMetadata = (source, target) => {
        if (arrayViews.has(source)) {
          arrayViews.set(target, arrayViews.get(source));
        }
        if (arrayKinds.has(source)) {
          arrayKinds.set(target, arrayKinds.get(source));
        }
        if (integerOrigins.has(source)) {
          const origin = integerOrigins.get(source);
          integerOrigins.set(target, origin);
          methodIntegerOrigins.set(target, origin);
        }
        if (localLoads.has(source)) {
          localLoads.set(target, localLoads.get(source));
        }
        if (entryReferenceLoads.has(source)) {
          entryReferenceLoads.set(target, entryReferenceLoads.get(source));
        }
        if (intToLongOrigins.has(source)) {
          intToLongOrigins.set(target, intToLongOrigins.get(source));
        }
        if (fixedPointProducts.has(source)) {
          fixedPointProducts.set(target, fixedPointProducts.get(source));
        }
        if (fixedPointShiftedProducts.has(source)) {
          fixedPointShiftedProducts.set(
            target, fixedPointShiftedProducts.get(source));
        }
      };
      let condition = null;
      // The algebraic negation of `condition`, when the emitter can write it
      // without a leading `!`. Only the equality pair is inverted: `<`/`>=`
      // and friends are not exact inverses for every JavaScript value, and
      // later passes recognize the `!(a === b)` shape of a null test.
      let negatedCondition = null;
      // The comparison a branch encodes, as data rather than as the
      // characters of its condition.
      let comparison = null;
      let negatedComparison = null;
      let conditionConstant = null;
      let returnKind = null;
      let returnValue = null;
      let returnIndex = null;
      let valid = true;
      let invalidAt = null;
      const pop = () => stack.length ? stack.pop() : null;
      const binary = (format, originOp = null, plainFormat = null) => {
        const right = pop(), left = pop();
        if (left === null || right === null) { valid = false; return; }
        const out = value();
        const line = constDecl(out, format(left, right), {pure: true});
        lines.push(line); stack.push(out);
        if (originOp) {
          const origin = {kind: originOp, left, right};
          integerOrigins.set(out, origin);
          methodIntegerOrigins.set(out, origin);
          if (plainFormat) {
            methodIntegerOriginLines.set(line, {
              name: out,
              plain: constDecl(out, plainFormat(left, right), {pure: true}),
            });
          }
        }
      };
      const boundedIntegerRange = (input, visited = new Set()) => {
        if (/^-?\d+$/.test(input)) {
          const constant = Number(input);
          return Number.isSafeInteger(constant) &&
            constant >= -2147483648 && constant <= 2147483647
            ? {minimum: constant, maximum: constant} : null;
        }
        if (visited.has(input)) return null;
        visited.add(input);
        const origin = integerOrigins.get(input);
        if (!origin) return null;
        if (origin.kind === "local") {
          return boundedLocalDefinitionRange(origin.slot);
        }
        const left = boundedIntegerRange(origin.left, new Set(visited));
        const right = boundedIntegerRange(origin.right, new Set(visited));
        if (origin.kind === "irem" && right &&
            right.minimum === right.maximum && right.minimum !== 0) {
          const magnitude = Math.abs(right.minimum);
          if (magnitude <= 2147483648) {
            const limit = magnitude - 1;
            if (left) {
              return {
                minimum: Math.max(-limit, left.minimum),
                maximum: Math.min(limit, left.maximum),
              };
            }
            return {minimum: -limit, maximum: limit};
          }
        }
        if (origin.kind === "iand") {
          const mask = left && left.minimum === left.maximum &&
              left.minimum >= 0 ? left.minimum
            : right && right.minimum === right.maximum &&
              right.minimum >= 0 ? right.minimum : null;
          return Number.isInteger(mask)
            ? {minimum: 0, maximum: mask} : null;
        }
        if (origin.kind === "iushr") {
          if (!right || right.minimum !== right.maximum) return null;
          const shift = right.minimum & 31;
          if (shift === 0) return null;
          return {
            minimum: 0,
            maximum: (2 ** (32 - shift)) - 1,
          };
        }
        if (origin.kind === "ishr") {
          if (!right || right.minimum !== right.maximum) return null;
          const shift = right.minimum & 31;
          if (shift === 0) return null;
          return {
            minimum: -(2 ** (31 - shift)),
            maximum: (2 ** (31 - shift)) - 1,
          };
        }
        if ((origin.kind === "iadd" || origin.kind === "isub") &&
            left && right) {
          const minimum = origin.kind === "iadd"
            ? left.minimum + right.minimum
            : left.minimum - right.maximum;
          const maximum = origin.kind === "iadd"
            ? left.maximum + right.maximum
            : left.maximum - right.minimum;
          // Java integer arithmetic wraps. An interval is valid only when no
          // member of either operand range can overflow this operation.
          if (minimum < -2147483648 || maximum > 2147483647) return null;
          return {minimum, maximum};
        }
        return null;
      };
      const affineLocalOffset = (input, visited = new Set()) => {
        if (/^-?\d+$/.test(input)) {
          const offset = Number(input);
          return Number.isSafeInteger(offset)
            ? {slot: null, offset, baseExpression: null} : null;
        }
        if (visited.has(input)) return null;
        visited.add(input);
        const origin = integerOrigins.get(input);
        if (!origin) return null;
        if (origin.kind === "local") {
          return {slot: origin.slot, offset: 0, baseExpression: input};
        }
        if (origin.kind !== "iadd" && origin.kind !== "isub") return null;
        const left = affineLocalOffset(origin.left, new Set(visited));
        const right = affineLocalOffset(origin.right, new Set(visited));
        if (!left || !right) return null;
        if (origin.kind === "isub" && right.slot !== null) return null;
        if (left.slot !== null && right.slot !== null) return null;
        const offset = origin.kind === "iadd"
          ? left.offset + right.offset : left.offset - right.offset;
        if (!Number.isSafeInteger(offset) || offset < -2147483648 ||
            offset > 2147483647) return null;
        return {
          slot: left.slot ?? right.slot,
          offset,
          baseExpression: left.slot !== null
            ? left.baseExpression : right.baseExpression,
        };
      };
      const arrayRangeMarkerFor = (
        arrayData, indexInput, itemIndex, arrayOp, store,
      ) => {
        // A loop preheader may only name storage views declared at generated
        // entry. Block-local snapshots (including non-eager field caches) are
        // not in lexical scope yet, and field-cache views can also be cleared
        // at a continuation safe point. Keep those accesses on the checked
        // sentinel path rather than emitting a preheader proof that references
        // a missing or stale SSA value.
        if (!arrayData || !guardedEntryArrayData.has(arrayData)) return "false";
        const access = {
          block: block.id,
          itemIndex,
          arrayData,
          indexInput,
          indexAffine: affineLocalOffset(indexInput),
          op: arrayOp,
          store: Boolean(store),
          marker: primitiveArrayAccessMarker(
            `__SSA_PRIMITIVE_ARRAY_ACCESS_${
              nextPrimitiveArrayAccessMarker++}__`),
        };
        primitiveArrayAccessCandidates.push(access);
        const fixedRange = this.bitBoundedArrayRangesEnabled
          ? boundedIntegerRange(indexInput) : null;
        const indexOrigin = integerOrigins.get(indexInput);
        const leftOrigin = indexOrigin?.kind === "iadd"
          ? integerOrigins.get(indexOrigin.left) : null;
        const rightOrigin = indexOrigin?.kind === "iadd"
          ? integerOrigins.get(indexOrigin.right) : null;
        // Local value numbering can retain the arithmetic provenance of a
        // value across istore/iload. Range relations still need the symbolic
        // JVM slots (for example derived + invariantOffset), which readLocal
        // records independently of that more precise arithmetic origin.
        const leftLocalSlot = indexOrigin?.kind === "iadd"
          ? localLoads.get(indexOrigin.left) ??
            (leftOrigin?.kind === "local" ? leftOrigin.slot : null)
          : null;
        const rightLocalSlot = indexOrigin?.kind === "iadd"
          ? localLoads.get(indexOrigin.right) ??
            (rightOrigin?.kind === "local" ? rightOrigin.slot : null)
          : null;
        const exactInteger = (expression) => {
          const range = boundedIntegerRange(expression);
          return range && range.minimum === range.maximum
            ? range.minimum : null;
        };
        const scaledLocal = (expression, offset = 0) => {
          const origin = integerOrigins.get(expression);
          if (origin?.kind !== "ishl") return null;
          const left = integerOrigins.get(origin.left);
          const shift = exactInteger(origin.right);
          if (left?.kind !== "local" || !Number.isInteger(shift)) return null;
          const normalizedShift = shift & 31;
          // Shifts by 31 are sign-changing rather than monotonically scaled.
          if (normalizedShift > 30) return null;
          return {
            slot: left.slot,
            scale: 2 ** normalizedShift,
            offset,
          };
        };
        let scaled = scaledLocal(indexInput);
        if (!scaled && indexOrigin?.kind === "iadd") {
          const leftConstant = exactInteger(indexOrigin.left);
          const rightConstant = exactInteger(indexOrigin.right);
          scaled = leftConstant !== null
            ? scaledLocal(indexOrigin.right, leftConstant)
            : rightConstant !== null
              ? scaledLocal(indexOrigin.left, rightConstant) : null;
        }
        let candidate = null;
        if (fixedRange && fixedRange.minimum >= 0) {
          candidate = {
            kind: "bounded-index",
            block: block.id,
            itemIndex,
            arrayData,
            slots: [],
            ...fixedRange,
          };
        } else if (this.indirectArrayRangesEnabled &&
            indexOrigin?.kind === "entry-array-load" &&
            Number.isInteger(indexOrigin.indexAffine?.slot) &&
            indexOrigin.indexAffine.offset === 0 &&
            guardedEntryArrayData.has(indexOrigin.arrayData) &&
            ["iaload", "saload", "baload", "caload"].includes(
              indexOrigin.op)) {
          candidate = {
            kind: "indirect-entry-array",
            block: block.id,
            itemIndex,
            arrayData,
            slots: [indexOrigin.indexAffine.slot],
            sourceArrayData: indexOrigin.arrayData,
            sourceDescriptor: indexOrigin.descriptor,
            sourceOp: indexOrigin.op,
          };
        } else if (scaled) {
          candidate = {
            kind: "scaled-local",
            block: block.id,
            itemIndex,
            arrayData,
            slots: [scaled.slot],
            scale: scaled.scale,
            offset: scaled.offset,
          };
        } else if (Number.isInteger(leftLocalSlot) &&
            Number.isInteger(rightLocalSlot)) {
          candidate = {
            kind: "base-plus-induction",
            block: block.id,
            itemIndex,
            arrayData,
            slots: [leftLocalSlot, rightLocalSlot],
          };
        } else if (Number.isInteger(access.indexAffine?.slot)) {
          candidate = {
            kind: "affine-local",
            block: block.id,
            itemIndex,
            arrayData,
            slots: [access.indexAffine.slot],
            offset: access.indexAffine.offset,
          };
        }
        if (!candidate) return access.marker;
        Object.assign(candidate, access);
        candidate.primitiveAccess = access;
        access.rangeCandidate = candidate;
        arrayRangeCheckCandidates.push(candidate);
        return candidate.marker;
      };
      const deferredStaticArrayAccessFor = (
        arrayInput, indexInput, itemIndex, directLines,
      ) => {
        const localSlot = localLoads.get(arrayInput);
        const view = persistentStaticArrayLocalViews.get(localSlot) ||
          entryStaticArrayLocalViews.get(localSlot) ||
          entryFieldArrayLocalViews.get(localSlot);
        if (!view || !view.blocks || view.blocks.has(block.id) ||
            !Number.isInteger(itemIndex)) return null;
        const marker = named(`__SSA_DEFERRED_STATIC_ARRAY_ACCESS_${
          nextDeferredStaticArrayAccessMarker++}__`);
        const access = {
          block: block.id,
          itemIndex,
          arrayData: view.data,
          indexAffine: affineLocalOffset(indexInput),
          marker,
          directLines,
        };
        deferredStaticArrayAccesses.push(access);
        return access;
      };
      const numberLiteral = (constant) => {
        if (Object.is(constant, -0)) return "-0";
        if (constant !== constant) return "NaN";
        if (constant === Infinity) return "Infinity";
        if (constant === -Infinity) return "-Infinity";
        return String(constant);
      };
      const resolveConstant = (arg) =>
        (arg && typeof arg === "object" && Object.prototype.hasOwnProperty.call(arg, "value"))
          ? arg.value : arg;
      const opcodeAtBlockOffset = (offset) => {
        const itemIndex = block.insns[offset];
        return itemIndex === undefined
          ? null : opOf(items[itemIndex]?.instruction);
      };
      for (let instructionOffset = 0;
        instructionOffset < block.insns.length; instructionOffset += 1) {
        const index = block.insns[instructionOffset];
        const instruction = items[index]?.instruction;
        const op = opOf(instruction);
        if (!op || op === "nop") continue;
        if (/^[adfil]load(?:_[0-3])?$/.test(op)) {
          const slot = localIndex(instruction, op);
          if (!Number.isInteger(slot) || slot < 0 || slot >= localCount) valid = false;
          else stack.push(readLocal(slot));
        } else if (/^[adfil]store(?:_[0-3])?$/.test(op)) {
          const input = pop();
          const slot = localIndex(instruction, op);
          if (input === null || !Number.isInteger(slot) || slot < 0 || slot >= localCount) valid = false;
          else {
            if (foldedEntryStoreIndexes.has(index)) {
              eliminatedLocalStoreCount += 1;
            }
            else if (this.localValueNumberingEnabled && localValues[slot] === input) {
              eliminatedLocalStoreCount += 1;
            }
            else lines.push(storeLocal(localName(slot), e`${input}`));
            const persistentArrayView =
              persistentProducedArrayStoreViews.get(index) ||
              persistentStaticArrayStoreViews.get(index);
            if (persistentArrayView) {
              lines.push(st`${persistentArrayView.data} = ${
                arrayViews.get(input) || arrayDataExpr(input)};`);
            }
            localValues[slot] = this.localValueNumberingEnabled ? input : null;
          }
        } else if (op === "aconst_null") stack.push("null");
        else if (/^iconst_(?:m1|[0-5])$/.test(op)) {
          stack.push(op === "iconst_m1" ? "-1" : op.slice(-1));
        } else if (/^lconst_[01]$/.test(op)) {
          stack.push(`${op.slice(-1)}n`);
        } else if (op === "bipush" || op === "sipush") {
          const constant = Number(instruction.arg);
          if (!Number.isFinite(constant) || !Number.isInteger(constant)) valid = false;
          else stack.push(String(constant | 0));
        } else if (op === "ldc" || op === "ldc_w") {
          const resolved = resolveConstant(instruction.arg);
          if (typeof resolved === "number" && Number.isFinite(resolved) &&
              Number.isInteger(resolved) && !Object.is(resolved, -0)) {
            stack.push(String(resolved | 0));
          } else if (typeof resolved === "number") {
            stack.push(numberLiteral(resolved));
          } else if (typeof resolved === "string") {
            // Java string constants are interned once per site at runtime.
            const out = value();
            lines.push(constDecl(out,
              e`helpers.constantValue(${JSON.stringify(resolved)})`));
            stack.push(out);
          } else valid = false;
        } else if (op === "ldc2_w") {
          const resolved = resolveConstant(instruction.arg);
          if (typeof resolved === "number" && Number.isFinite(resolved)) {
            stack.push(numberLiteral(resolved));
          } else if (typeof resolved === "bigint") {
            stack.push(`${resolved}n`);
          } else valid = false;
        } else if (/^dconst_[01]$/.test(op) || /^fconst_[0-2]$/.test(op)) {
          stack.push(op.slice(-1));
        } else if (op === "dup") {
          const input = pop();
          if (input === null) valid = false;
          else {
            const out = stagedValue(input, lines);
            stack.push(out, out);
            copyValueMetadata(input, out);
          }
        } else if (op === "dup_x1") {
          const topInput = pop(), underInput = pop();
          const widths = verifiedStackWidthsBefore?.get(index) || [];
          const categoryOnePair = widths.length >= 2 &&
            widths.at(-1) === 1 && widths.at(-2) === 1;
          if (topInput === null || underInput === null || !categoryOnePair) {
            valid = false;
          } else {
            const top = stagedValue(topInput, lines);
            const under = stagedValue(underInput, lines);
            copyValueMetadata(topInput, top);
            copyValueMetadata(underInput, under);
            stack.push(top, under, top);
          }
        } else if (op === "dup_x2") {
          const widths = verifiedStackWidthsBefore?.get(index) || [];
          const topInput = pop(), underInput = pop();
          const topCategoryOne = widths.at(-1) === 1;
          const underCategoryTwo = widths.at(-2) === 2;
          const bottomInput = underCategoryTwo ? null : pop();
          const categoryOneTriple = !underCategoryTwo &&
            widths.at(-2) === 1 && widths.at(-3) === 1;
          if (topInput === null || underInput === null || !topCategoryOne ||
              (!underCategoryTwo &&
                (!categoryOneTriple || bottomInput === null))) {
            valid = false;
          } else {
            const top = stagedValue(topInput, lines);
            const under = stagedValue(underInput, lines);
            copyValueMetadata(topInput, top);
            copyValueMetadata(underInput, under);
            if (underCategoryTwo) {
              stack.push(top, under, top);
            } else {
              const bottom = stagedValue(bottomInput, lines);
              copyValueMetadata(bottomInput, bottom);
              stack.push(top, bottom, under, top);
            }
          }
        } else if (op === "dup2") {
          // The interpreter and generated tiers treat dup2 as the two
          // category-1 form unless the top is a BigInt long; mirror that and
          // fall back before any effect when a long is observed.
          const topInput = pop(), underInput = pop();
          if (topInput === null || underInput === null) valid = false;
          else {
            const widths = verifiedStackWidthsBefore?.get(index) || [];
            const categoryOnePair = widths.length >= 2 &&
              widths.at(-1) === 1 && widths.at(-2) === 1;
            const top = stagedValue(topInput, lines);
            const under = stagedValue(underInput, lines);
            if (!categoryOnePair) {
              lines.push(st`if (typeof ${top} === "bigint") {`,
                ...materializeLines([...stack, under, top], index)
                  .map((line) => `  ${line}`),
                st`  helpers.skipJitOnce(frame);`,
                stmt(exprConcat(e`  return { deopt: true, transient: true, `,
                  e`reason: 'category-2 dup2 in structured SSA' };`)),
                blockEnd(""));
            }
            copyValueMetadata(topInput, top);
            copyValueMetadata(underInput, under);
            stack.push(under, top, under, top);
          }
        } else if (op === "pop") {
          if (pop() === null) valid = false;
        } else if (op === "iadd") {
          binary((a, b) => e`((${a} + ${b}) | 0)`, "iadd",
            (a, b) => e`(${a} + ${b})`);
        }
        else if (op === "isub") {
          binary((a, b) => e`((${a} - ${b}) | 0)`, "isub",
            (a, b) => e`(${a} - ${b})`);
        }
        else if (op === "imul") {
          binary((a, b) => e`Math.imul(${a}, ${b})`, "imul",
            (a, b) => e`(${a} * ${b})`);
        }
        else if (op === "iand") binary((a, b) => e`(${a} & ${b})`, "iand");
        else if (op === "ior") binary((a, b) => e`(${a} | ${b})`);
        else if (op === "ixor") binary((a, b) => e`(${a} ^ ${b})`);
        else if (op === "ishl") {
          binary((a, b) => e`(${a} << (${b} & 31))`, "ishl");
        }
        else if (op === "ishr") {
          binary((a, b) => e`(${a} >> (${b} & 31))`, "ishr");
        }
        else if (op === "iushr") {
          binary((a, b) => e`((${a} >>> (${b} & 31)) | 0)`, "iushr");
        }
        else if (op === "ladd" || op === "lsub" || op === "lmul" ||
            op === "land" || op === "lor" || op === "lxor") {
          const operator = {
            ladd: "+", lsub: "-", lmul: "*", land: "&", lor: "|", lxor: "^",
          }[op];
          const right = pop(), left = pop();
          if (left === null || right === null) valid = false;
          else if (this.fixedPointScalarizationEnabled && op === "lmul" &&
              intToLongOrigins.has(left) &&
              intToLongOrigins.has(right) &&
              opcodeAtBlockOffset(instructionOffset + 1) === "bipush" &&
              Number(items[block.insns[instructionOffset + 1]]
                ?.instruction?.arg) === 16 &&
              opcodeAtBlockOffset(instructionOffset + 2) === "lshr" &&
              opcodeAtBlockOffset(instructionOffset + 3) === "l2i") {
            // lmul/lshr/l2i cannot throw.  Carry an internal SSA token across
            // the three adjacent nodes and emit a real JavaScript value only
            // at l2i.  It therefore never appears in deoptimization state.
            const out = value();
            fixedPointProducts.set(out, {
              left: intToLongOrigins.get(left),
              right: intToLongOrigins.get(right),
            });
            fixedPointScalarizationCount += 1;
            stack.push(out);
          } else {
            const out = value();
            lines.push(constDecl(out, e`BigInt.asIntN(64, ` +
              e`BigInt(${left}) ${operator} BigInt(${right}))`, {pure: true}));
            stack.push(out);
          }
        }
        else if (op === "lshl" || op === "lshr" || op === "lushr") {
          const shiftInput = pop(), longInput = pop();
          if (shiftInput === null || longInput === null) valid = false;
          else if (op === "lshr" && shiftInput === "16" &&
              fixedPointProducts.has(longInput) &&
              opcodeAtBlockOffset(instructionOffset + 1) === "l2i") {
            const out = value();
            fixedPointShiftedProducts.set(
              out, fixedPointProducts.get(longInput));
            stack.push(out);
          }
          else {
            const out = value();
            const shifted = op === "lushr"
              ? exprConcat(
                e`BigInt.asUintN(64, BigInt(${longInput})) >> `,
                e`(BigInt(${shiftInput}) & 63n)`)
              : exprConcat(
                e`BigInt(${longInput}) ${op === "lshl" ? "<<" : ">>"} `,
                e`(BigInt(${shiftInput}) & 63n)`);
            lines.push(constDecl(out, e`BigInt.asIntN(64, ${shifted})`,
              {pure: true}));
            stack.push(out);
          }
        }
        else if (op === "lcmp") {
          binary((a, b) => {
            const left = e`BigInt(${a})`, right = e`BigInt(${b})`;
            return e`(${left} < ${right} ? -1 : ${left} > ${right} ? 1 : 0)`;
          });
        }
        else if (op === "ldiv" || op === "lrem") {
          const divisorInput = pop(), dividendInput = pop();
          if (divisorInput === null || dividendInput === null) valid = false;
          else {
            const dividend = value(), divisor = value(), out = value();
            lines.push(constDecl(dividend, e`BigInt(${dividendInput})`,
              {pure: true}),
              constDecl(divisor, e`BigInt(${divisorInput})`, {pure: true}),
              st`if (${divisor} === 0n) {`,
              ...materializeLines([...stack, dividend, divisor], index, true)
                .map((line) => `  ${line}`),
              stmt(e`  throw { type: "java/lang/ArithmeticException", message: "/ by zero" };`,
                {deoptEffect: true, arithmeticException: true}),
              blockEnd(""),
              constDecl(out, e`BigInt.asIntN(64, ${dividend} ${
                op === "ldiv" ? "/" : "%"} ${divisor})`, {pure: true}));
            stack.push(out);
          }
        }
        else if (op === "dadd") binary((a, b) => e`(${a} + ${b})`);
        else if (op === "dsub") binary((a, b) => e`(${a} - ${b})`);
        else if (op === "dmul") binary((a, b) => e`(${a} * ${b})`);
        else if (op === "ddiv") binary((a, b) => e`(${a} / ${b})`);
        else if (op === "drem") binary((a, b) => e`(${a} % ${b})`);
        else if (op === "fadd") binary((a, b) => e`Math.fround(${a} + ${b})`);
        else if (op === "fsub") binary((a, b) => e`Math.fround(${a} - ${b})`);
        else if (op === "fmul") binary((a, b) => e`Math.fround(${a} * ${b})`);
        else if (op === "fdiv") binary((a, b) => e`Math.fround(${a} / ${b})`);
        else if (op === "frem") binary((a, b) => e`Math.fround(${a} % ${b})`);
        else if (op === "dcmpl" || op === "dcmpg" || op === "fcmpl" || op === "fcmpg") {
          const nan = op.endsWith("g") ? "1" : "-1";
          binary((a, b) => e`(${a} < ${b} ? -1 : ${a} > ${b} ? 1 : ${a} === ${b} ? 0 : ${nan})`);
        }
        else if (op === "ineg" || op === "i2b" || op === "i2s" || op === "i2c" ||
            op === "dneg" || op === "fneg" || op === "i2d" || op === "f2d" ||
            op === "i2f" || op === "d2f" || op === "d2i" || op === "f2i" ||
            op === "i2l" || op === "l2i" || op === "l2d" || op === "l2f" ||
            op === "lneg") {
          const input = pop();
          if (input === null) valid = false;
          else {
            // Match the generated baseline tier exactly (NaN -> 0, truncate
            // toward zero, wrap): tier-consistent narrowing keeps differential
            // hashes comparable across tiers.
            const narrowed = operand(e`(Math.trunc(${input}) | 0)`);
            const expressions = {
              ineg: operand(e`(-${input}) | 0`),
              i2b: operand(e`((${input} << 24) >> 24)`),
              i2s: operand(e`((${input} << 16) >> 16)`),
              i2c: operand(e`(${input} & 0xffff)`),
              dneg: operand(e`(-${input})`),
              fneg: operand(e`Math.fround(-${input})`),
              i2d: operand(e`${input}`),
              f2d: operand(e`${input}`),
              i2f: operand(e`Math.fround(${input})`),
              d2f: operand(e`Math.fround(${input})`),
              d2i: narrowed,
              f2i: narrowed,
              // BigInt conversion is pure.  Leaving it lazy preserves the
              // exact Java long representation for arbitrary consumers and
              // exception materialization while allowing a later typed SSA
              // node to eliminate it.
              i2l: operand(e`BigInt(${input})`),
              l2i: operand(e`Number(BigInt.asIntN(32, BigInt(${input})))`),
              l2d: operand(e`Number(${input})`),
              l2f: operand(e`Math.fround(Number(${input}))`),
              lneg: operand(e`BigInt.asIntN(64, -BigInt(${input}))`),
            };
            if (op === "i2l") {
              const expression = expressions[op];
              intToLongOrigins.set(expression, input);
              stack.push(expression);
            } else if (op === "l2i" &&
                fixedPointShiftedProducts.has(input)) {
              const {left, right} = fixedPointShiftedProducts.get(input);
              const out = value();
              // For signed int a,b, split each into a signed high half and an
              // unsigned low half.  These four imul terms are exactly the low
              // 32 bits of (long)a*b >> 16, including negative products.
              lines.push(constDecl(out, exprConcat(
                e`((`,
                e`Math.imul((${left}) >> 16, (${right}) >> 16) << 16) + `,
                e`Math.imul((${left}) >> 16, (${right}) & 65535) + `,
                e`Math.imul((${left}) & 65535, (${right}) >> 16) + `,
                e`(Math.imul((${left}) & 65535, (${right}) & 65535) >>> 16)) | 0`),
                {pure: true}));
              stack.push(out);
            } else {
              // `i2d` and `f2d` are representationally the identity here, so
              // their expression is the operand itself; staging reuses the
              // existing SSA value instead of binding a second name to it.
              stack.push(stagedValue(expressions[op], lines));
            }
          }
        }
        else if (op === "idiv" || op === "irem") {
          const divisorInput = pop(), dividendInput = pop();
          if (divisorInput === null || dividendInput === null) valid = false;
          else {
            const dividend = stagedValue(dividendInput, lines);
            const divisor = stagedValue(divisorInput, lines);
            const out = value();
            const literalDivisor = /^-?\d+$/.test(divisorInput)
              ? Number(divisorInput) : 0;
            if (literalDivisor !== 0) {
              literalNonZeroDivisionItems.add(index);
              cfgDominatedArithmeticGuardCount += 1;
            } else if (dominatedNonZeroDivisionItems.has(index)) {
              cfgDominatedArithmeticGuardCount += 1;
            } else {
              lines.push(stmt(e`if (${divisor} === 0) {`,
                {kind: "if", comparison: {input: divisor, cmp: "=== 0"}}),
                ...materializeLines([...stack, dividend, divisor], index, true).map((line) => `  ${line}`),
                stmt(e`  throw { type: "java/lang/ArithmeticException", message: "/ by zero" };`,
                {deoptEffect: true, arithmeticException: true}),
                blockEnd(""));
            }
            const line = constDecl(out, e`((${dividend} ${
              op === "idiv" ? "/" : "%"} ${divisor}) | 0)`,
            {pure: true, division: true});
            lines.push(line);
            const origin = {
              kind: op,
              left: dividendInput,
              right: divisorInput,
            };
            integerOrigins.set(out, origin);
            methodIntegerOrigins.set(out, origin);
            if (op === "irem") {
              methodIntegerOriginLines.set(line, {
                name: out,
                plain: constDecl(out, e`(${dividend} % ${divisor})`,
                  {pure: true, division: true}),
              });
            }
            stack.push(out);
          }
        }
        else if (op === "iinc") {
          const slot = Number(instruction.varnum ?? instruction.arg);
          const increment = Number(instruction.incr ?? 0);
          if (!Number.isInteger(slot) || slot < 0 || slot >= localCount || !Number.isInteger(increment)) {
            valid = false;
          } else if (!this.localValueNumberingEnabled) {
            lines.push(storeLocal(localName(slot),
              e`(${localName(slot)} + ${increment}) | 0`));
          } else {
            const previous = readLocal(slot);
            const out = value();
            lines.push(constDecl(out, e`(${previous} + ${increment}) | 0`,
              {pure: true, iincSource: previous, iincIncrement: increment}));
            lines.push(storeLocal(localName(slot), e`${out}`));
            localValues[slot] = out;
          }
        } else if (op === "arraylength") {
          const arrayInput = pop();
          if (arrayInput === null) valid = false;
          else {
            const array = stagedValue(arrayInput, lines);
            const out = value();
            lines.push(stmt(e`if (${array} === null || ${array} === undefined) {`,
              {kind: "nullCheck", value: array}),
              ...materializeLines([...stack, array], index, true).map((line) => `  ${line}`),
              stmt(e`  helpers.arrayLength(${array}, frame);`, {deoptEffect: true}), blockEnd(""),
              constDecl(out, e`${array}.length`, {pure: true}));
            stack.push(out);
          }
        } else if (op === "iaload" || op === "saload" || op === "aaload" ||
            op === "baload" || op === "caload" || op === "daload" ||
            op === "faload" || op === "laload") {
          const arrayIndexInput = pop(), arrayInput = pop();
          if (arrayIndexInput === null || arrayInput === null) valid = false;
          else {
            const array = stagedValue(arrayInput, lines);
            const out = value();
            let arrayData = arrayViews.get(arrayInput);
            const deferredStaticView = !arrayData
              ? persistentProducedArrayLocalViews.get(
                localLoads.get(arrayInput)) ||
                persistentStaticArrayLocalViews.get(localLoads.get(arrayInput)) ||
                entryStaticArrayLocalViews.get(localLoads.get(arrayInput)) ||
                entryFieldArrayLocalViews.get(localLoads.get(arrayInput))
              : null;
            const arrayKind = this.staticPrimitiveArrayKindsEnabled
              ? arrayKinds.get(arrayInput) ||
                deferredStaticView?.descriptor || null : null;
            if (!arrayData && op !== "aaload" &&
                this.blockArrayDataViewsEnabled) {
              arrayData = value();
              const arrayDataView = arrayDataExpr(array);
              lines.push(constDecl(arrayData, arrayDataView,
                {pure: arrayDataView.pure === true}));
              arrayViews.set(arrayInput, arrayData);
              arrayViews.set(array, arrayData);
              dynamicBlockArrayViews.add(arrayData);
              blockArrayDataViewCount += 1;
            }
            const primitiveSentinel = op !== "aaload" && arrayData;
            const arrayIndex = stagedValue(arrayIndexInput, lines);
            lines.push(letDecl(out));
            if (primitiveSentinel) {
              const normalized = normalizedArrayLoadExpression(
                out, op, array, arrayKind);
              const rangeMarker = dynamicBlockArrayViews.has(arrayData)
                ? "false" : arrayRangeMarkerFor(
                  arrayData, arrayIndexInput, index, op, false);
              const loadFailure =
                unconditionallyNonNullEntryArrayData.has(arrayData)
                ? e`((${out} = ${arrayData}[${arrayIndex}]) === undefined)`
                : exprConcat(e`(${arrayData} === null || `,
                  e`(${out} = ${arrayData}[${arrayIndex}]) === undefined)`);
              const provenLoad = normalizedArrayLoadExpression(
                e`${arrayData}[${arrayIndex}]`, op, array, arrayKind);
              lines.push(
                stmt(e`if (!${rangeMarker} && ${loadFailure}) {`,
                  {kind: "rangeGuardedAccess", guard: rangeMarker,
                    // The transactional fold needs the raw load itself; it is
                    // only available when the storage is proven non-null, the
                    // shape whose failure test is exactly the sentinel probe.
                    rawLoad: unconditionallyNonNullEntryArrayData.has(arrayData)
                      ? e`${arrayData}[${arrayIndex}]` : null,
                    loadTarget: out}),
                ...materializeLines([...stack, array, arrayIndex], index, true).map((line) => `  ${line}`),
                stmt(e`  ${out} = helpers.arrayLoad(${arrayIndex}, ${array}, frame, ${JSON.stringify(op)});`,
                  {kind: "assign", write: out, deoptEffect: true,
                    guestArrayHelper: true}),
                ...materializeUnwindReleaseLines("  "),
                elseArm(""),
                stmt(e`  ${out} = ${rangeMarker} ? ${provenLoad} : ${
                  normalized};`, {kind: "guardedLoad", write: out,
                  guard: rangeMarker, target: out,
                  proven: provenLoad, ordinary: normalized}),
                blockEnd(""),
              );
              checkedPrimitiveArrayAccesses.add(`${arrayData}\0${arrayIndexInput}`);
              sentinelArrayLoadCount += 1;
            } else {
              const raw = arrayData
                ? exprConcat(
                  e`${arrayData} !== null ? ${arrayData}[${arrayIndex}] : `,
                  e`(${array}.elements ? ${array}.elements[${arrayIndex}] : ${array}[${arrayIndex}])`)
                : e`${array}.elements ? ${array}.elements[${arrayIndex}] : ${array}[${arrayIndex}]`;
              const normalized = normalizedArrayLoadExpression(
                raw, op, array, arrayKind);
              const deferred = deferredStaticView && op !== "aaload"
                ? deferredStaticArrayAccessFor(
                  arrayInput, arrayIndexInput, index, [
                    stmt(e`${out} = ${normalizedArrayLoadExpression(
                      e`${deferredStaticView.data}[${arrayIndex}]`,
                      op, array, arrayKind)};`,
                    {kind: "assign", write: out}),
                  ]) : null;
              if (deferred) {
                lines.push(stmt(e`/*${deferred.marker}:start*/`,
                  {kind: "deferredStaticStart", marker: deferred.marker}));
              }
              lines.push(
                  stmt(e`if (${array} === null || ${array} === undefined || ${
                    arrayIndexOutOfBounds(arrayIndex, e`${array}.length`)}) {`),
                  ...materializeLines([...stack, array, arrayIndex], index, true).map((line) => `  ${line}`),
                  stmt(e`  ${out} = helpers.arrayLoad(${arrayIndex}, ${array}, frame, ${JSON.stringify(op)});`,
                  {kind: "assign", write: out, deoptEffect: true,
                    guestArrayHelper: true}),
                  ...materializeUnwindReleaseLines("  "),
                  elseArm(""),
                  stmt(e`  ${out} = ${normalized};`,
                    {kind: "assign", write: out}), blockEnd(""),
              );
              if (deferred) {
                lines.push(stmt(e`/*${deferred.marker}:end*/`,
                  {kind: "deferredStaticEnd", marker: deferred.marker}));
              }
            }
            if (op === "aaload" && typeof arrayKind === "string") {
              let dimensions = 0;
              while (arrayKind[dimensions] === "[") dimensions += 1;
              const primitiveElement = dimensions >= 2 &&
                dimensions + 1 === arrayKind.length &&
                "ZBCSIFDJ".includes(arrayKind[dimensions]);
              if (primitiveElement) {
                verifiedNestedPrimitiveAaloads.add(index);
                arrayKinds.set(out, arrayKind.slice(1));
              }
              const componentDescriptor = arrayKind.slice(1);
              if (resolvedStaticReferenceArrayValues.has(arrayInput) &&
                  (componentDescriptor.startsWith("L") ||
                    componentDescriptor.startsWith("["))) {
                verifiedResolvedStaticReferenceAaloads.add(index);
                if (componentDescriptor.startsWith("[")) {
                  arrayKinds.set(out, componentDescriptor);
                  resolvedStaticReferenceArrayValues.add(out);
                }
              }
            }
            if (primitiveSentinel &&
                ["iaload", "saload", "baload", "caload"].includes(op)) {
              const origin = {
                kind: "entry-array-load",
                arrayData,
                descriptor: arrayKind,
                indexInput: arrayIndexInput,
                indexAffine: affineLocalOffset(arrayIndexInput),
                op,
              };
              integerOrigins.set(out, origin);
              methodIntegerOrigins.set(out, origin);
            }
            stack.push(out);
          }
        } else if (op === "iastore" || op === "sastore" || op === "bastore" ||
            op === "castore" || op === "dastore" || op === "fastore" ||
            op === "lastore" || op === "aastore") {
          const storedInput = pop(), arrayIndexInput = pop(), arrayInput = pop();
          if (storedInput === null || arrayIndexInput === null || arrayInput === null) valid = false;
          else {
            const array = stagedValue(arrayInput, lines);
            let arrayData = arrayViews.get(arrayInput);
            const deferredStaticView = !arrayData
              ? persistentProducedArrayLocalViews.get(
                localLoads.get(arrayInput)) ||
                persistentStaticArrayLocalViews.get(localLoads.get(arrayInput)) ||
                entryStaticArrayLocalViews.get(localLoads.get(arrayInput)) ||
                entryFieldArrayLocalViews.get(localLoads.get(arrayInput))
              : null;
            const arrayKind = this.staticPrimitiveArrayKindsEnabled
              ? arrayKinds.get(arrayInput) ||
                deferredStaticView?.descriptor || null : null;
            if (!arrayData && op !== "aastore" &&
                this.blockArrayDataViewsEnabled) {
              arrayData = value();
              const arrayDataView = arrayDataExpr(array);
              lines.push(constDecl(arrayData, arrayDataView,
                {pure: arrayDataView.pure === true}));
              arrayViews.set(arrayInput, arrayData);
              arrayViews.set(array, arrayData);
              dynamicBlockArrayViews.add(arrayData);
              blockArrayDataViewCount += 1;
            }
            const arrayIndex = stagedValue(arrayIndexInput, lines);
            const stored = stagedValue(storedInput, lines);
            // The opcode fixes primitive narrowing. Keep it in the generated
            // block instead of crossing a generic helper boundary per element.
            // `bastore` retains its runtime [B/[Z distinction; all other
            // primitive kinds are determined completely by the opcode.
            const normalizedStore = this.inlinePrimitiveArrayStoresEnabled
              ? normalizedArrayStoreExpression(stored, op, array, arrayKind)
              : op === "iastore"
                ? e`((${stored}) | 0)`
                : e`helpers.normalizeArrayStore(${stored}, ${
                  JSON.stringify(op)}, ${array})`;
            const checkedKey = arrayData && `${arrayData}\0${arrayIndexInput}`;
            if (op !== "aastore" && checkedKey &&
                checkedPrimitiveArrayAccesses.has(checkedKey)) {
              lines.push(stmt(
                e`${arrayData}[${arrayIndex}] = ${normalizedStore};`,
                {kind: "arrayStore", storeTarget: arrayData,
                  storeIndex: e`${arrayIndex}`,
                  storeValue: e`${normalizedStore}`}));
              eliminatedArrayStoreCheckCount += 1;
            } else if (op !== "aastore" && arrayData &&
                guardedEntryArrayData.has(arrayData)) {
              const rangeMarker =
                arrayRangeMarkerFor(
                  arrayData, arrayIndexInput, index, op, true);
              lines.push(
                stmt(exprConcat(e`if (!${rangeMarker} && `,
                  e`${arrayIndexOutOfBounds(
                    arrayIndex, e`${arrayData}.length`)}) {`),
                {kind: "rangeGuardedAccess", guard: rangeMarker}),
                ...materializeLines([...stack, array, arrayIndex, stored], index, true)
                  .map((line) => `  ${line}`),
                stmt(e`  helpers.arrayStore(${stored}, ${arrayIndex}, ${array}, frame, ${JSON.stringify(op)});`,
                  {deoptEffect: true, guestArrayHelper: true}),
                ...materializeUnwindReleaseLines("  "),
                elseArm(""),
                stmt(e`  ${arrayData}[${arrayIndex}] = ${normalizedStore};`,
                  {kind: "arrayStore", storeTarget: arrayData,
                    storeIndex: e`${arrayIndex}`,
                    storeValue: e`${normalizedStore}`}),
                blockEnd(""),
              );
            } else {
              const deferred = deferredStaticView && op !== "aastore"
                ? deferredStaticArrayAccessFor(
                  arrayInput, arrayIndexInput, index, [
                    stmt(exprConcat(
                      e`${deferredStaticView.data}[${arrayIndex}] = `,
                      e`${normalizedStore};`),
                    {kind: "arrayStore",
                      storeTarget: deferredStaticView.data}),
                  ]) : null;
              if (deferred) {
                lines.push(stmt(e`/*${deferred.marker}:start*/`,
                  {kind: "deferredStaticStart", marker: deferred.marker}));
              }
              lines.push(
                stmt(e`if (${array} === null || ${array} === undefined || ${
                  arrayIndexOutOfBounds(arrayIndex, e`${array}.length`)}) {`),
                ...materializeLines([...stack, array, arrayIndex, stored], index, true).map((line) => `  ${line}`),
                stmt(e`  helpers.arrayStore(${stored}, ${arrayIndex}, ${array}, frame, ${JSON.stringify(op)});`,
                  {deoptEffect: true, guestArrayHelper: true}),
                ...materializeUnwindReleaseLines("  "),
                ...(arrayData ? [
                  stmt(e`} else if (${arrayData} !== null) {`,
                    {kind: "elseIfArm"}),
                  stmt(e`  ${arrayData}[${arrayIndex}] = ${normalizedStore};`,
                    {kind: "arrayStore", storeTarget: arrayData,
                    storeIndex: e`${arrayIndex}`,
                    storeValue: e`${normalizedStore}`}),
                ] : []),
                stmt(e`} else if (${array}.elements) {`,
                  {kind: "elseIfArm"}),
                stmt(e`  ${array}.elements[${arrayIndex}] = ${
                  normalizedStore};`, {kind: "arrayStore"}),
                elseArm(""),
                stmt(e`  ${array}[${arrayIndex}] = ${normalizedStore};`,
                  {kind: "arrayStore"}), blockEnd(""),
              );
              if (deferred) {
                lines.push(stmt(e`/*${deferred.marker}:end*/`,
                  {kind: "deferredStaticEnd", marker: deferred.marker}));
              }
            }
          }
        } else if (op === "newarray") {
          const countInput = pop();
          if (countInput === null) valid = false;
          else {
            const count = stagedValue(countInput, lines);
            const out = value(), caught = value();
            lines.push(letDecl(out),
              st`try { ${out} = helpers.newPrimitiveArray(${count}, ${JSON.stringify(instruction.arg)}); } catch (${caught}) {`,
              ...materializeLines([...stack, count], index, true).map((line) => `  ${line}`),
              st`  throw ${caught};`, blockEnd(""));
            stack.push(out);
          }
        } else if (op === "anewarray") {
          const countInput = pop();
          if (countInput === null) valid = false;
          else {
            const count = stagedValue(countInput, lines);
            const out = value(), caught = value();
            lines.push(letDecl(out),
              st`try { ${out} = helpers.newReferenceArray(${count}, ${JSON.stringify(instruction.arg)}); } catch (${caught}) {`,
              ...materializeLines([...stack, count], index, true).map((line) => `  ${line}`),
              st`  throw ${caught};`, blockEnd(""));
            stack.push(out);
          }
        } else if (op === "monitorenter") {
          const monitorInput = pop();
          if (monitorInput === null) valid = false;
          else {
            const monitor = stagedValue(monitorInput, lines);
            const caught = value();
            lines.push(
              st`try {`,
              st`  if (!helpers.monitorEnter(${monitor}, thread)) {`,
              ...materializeLines([...stack, monitor], index)
                .map((line) => `    ${line}`),
              st`    helpers.skipJitOnce(frame);`,
              stmt(exprConcat(e`    return { deopt: true, transient: true, `,
                e`reason: 'contended structured SSA monitorenter' };`)),
              blockEnd("  "),
              st`} catch (${caught}) {`,
              ...materializeLines([...stack, monitor], index)
                .map((line) => `  ${line}`),
              st`  throw ${caught};`,
              blockEnd(""),
            );
          }
        } else if (op === "monitorexit") {
          const monitorInput = pop();
          if (monitorInput === null) valid = false;
          else {
            const monitor = stagedValue(monitorInput, lines);
            const caught = value();
            lines.push(
              st`try {`,
              st`  helpers.monitorExit(${monitor}, thread);`,
              st`} catch (${caught}) {`,
              ...materializeLines([...stack, monitor], index)
                .map((line) => `  ${line}`),
              st`  throw ${caught};`,
              blockEnd(""),
            );
          }
        } else if (op === "checkcast") {
          const input = stack[stack.length - 1];
          if (input === undefined) valid = false;
          else {
            const castValue = stagedValue(input, lines);
            const source = value(), checked = value(), caught = value();
            const target = JSON.stringify(instruction.arg);
            lines.push(
              st`if (${castValue} !== null && ${castValue} !== undefined) {`,
              stmt(e`  const ${source} = ${
                runtimeClassNameExpression(castValue)};`,
              {kind: "const", def: source}),
              st`  if (${source} !== ${target}) {`,
              st`    let ${checked};`,
              st`    try { ${checked} = helpers.tryCheckCastSourceSync(${source}, ${target}); } catch (${caught}) {`,
              ...materializeLines(stack, index).map((line) => `  ${line}`),
              st`  throw ${caught};`, blockEnd(""),
              st`    if (${checked} === helpers.asyncInvokeSentinel()) {`,
              ...materializeLines(stack, index).map((line) => `    ${line}`),
              st`      helpers.skipJitOnce(frame);`,
              st`      return { deopt: true, transient: true, reason: 'cold structured SSA checkcast' };`,
              blockEnd("    "),
              blockEnd("  "),
              blockEnd(""));
          }
        } else if (op === "instanceof") {
          const input = pop();
          if (input === null) valid = false;
          else {
            const candidate = stagedValue(input, lines);
            const out = value();
            const target = JSON.stringify(instruction.arg);
            lines.push(
              constDecl(out,
                e`helpers.tryInstanceOfSync(${candidate}, ${target})`),
              st`if (${out} === helpers.asyncInvokeSentinel()) {`,
              ...materializeLines([...stack, candidate], index)
                .map((line) => `  ${line}`),
              st`  helpers.skipJitOnce(frame);`,
              stmt(exprConcat(e`  return { deopt: true, transient: true, `,
                e`reason: 'cold structured SSA instanceof' };`)),
              blockEnd(""),
            );
            stack.push(out);
          }
        } else if (op === "getfield") {
          const objectInput = pop(), site = fieldSites.get(index);
          if (objectInput === null || site === undefined) valid = false;
          else {
            const object = stagedValue(objectInput, lines);
            const out = value();
            const cache = fieldReadCacheSites.get(index);
            const fieldPlan = this.jit.fieldSites[site];
            const directKey = fieldPlan?.directInstanceKey || null;
            const denseSlot = fieldPlan?.denseSlot;
            const directRead = Number.isInteger(denseSlot)
              ? exprConcat(
                e`(Array.isArray(${object}.fields) ? `,
                e`${object}.fields[${denseSlot}] : `,
                e`(${object}.fields && `,
                e`${object}.fields[${JSON.stringify(directKey)}] !== undefined ? `,
                e`${object}.fields[${JSON.stringify(directKey)}] : `,
                e`helpers.getFieldAt(${site}, ${object})))`)
              : directKey
              ? exprConcat(
                e`(${object}.fields && `,
                e`${object}.fields[${JSON.stringify(directKey)}] !== undefined ? `,
                e`${object}.fields[${JSON.stringify(directKey)}] : `,
                e`helpers.getFieldAt(${site}, ${object}))`)
              : e`helpers.getFieldAt(${site}, ${object})`;
            if (cache?.eagerLocal !== null &&
                cache?.eagerLocal !== undefined) {
              if (!cache.eagerThis) {
                if (cache.isArray && cache.data) {
                  eagerFieldReceiverNullChecks.set(object, cache.data);
                }
                lines.push(stmt(e`if (${object} === null || ${object} === undefined) {`,
              {kind: "nullCheck", value: object}),
                  ...materializeLines([...stack, object], index, true).map((line) => `  ${line}`),
                  stmt(e`  helpers.getFieldAt(${site}, ${object});`, {deoptEffect: true}), blockEnd(""));
              }
              lines.push(constDecl(out, e`${cache.value}`, {pure: true}));
            } else {
              lines.push(stmt(e`if (${object} === null || ${object} === undefined) {`,
              {kind: "nullCheck", value: object}),
                ...materializeLines([...stack, object], index, true).map((line) => `  ${line}`),
                stmt(e`  helpers.getFieldAt(${site}, ${object});`, {deoptEffect: true}), blockEnd(""));
            }
            if (cache && (cache.eagerLocal === null ||
                cache.eagerLocal === undefined)) {
              lines.push(letDecl(out),
                st`if (${cache.valid} && ${cache.object} === ${object}) {`,
                st`  ${out} = ${cache.value};`, elseArm(""),
                stmt(e`  ${out} = ${directRead};`,
                  {kind: "assign", write: out}),
                st`  ${cache.object} = ${object};`,
                st`  ${cache.value} = ${out};`,
                ...(cache.isArray
                  ? [stmt(e`  ${cache.data} = ${arrayDataExpr(out)};`)] : []),
                st`  ${cache.valid} = true;`, blockEnd(""));
            } else if (!cache) {
              lines.push(constDecl(out, directRead));
            }
            if (cache?.isArray) {
              const descriptor = this.jit.fieldSites[site]?.descriptor;
              if (descriptor?.startsWith("[")) {
                arrayKinds.set(out, descriptor);
              }
              if (cache.eagerLocal !== null &&
                  cache.eagerLocal !== undefined) {
                // Transitive field-write analysis proved this entry reference
                // and field stable until the next scheduler boundary. Keep
                // its raw array view in the entry-scoped cache variable so a
                // natural-loop range guard can name it outside the block.
                arrayViews.set(out, cache.data);
                stack.push(out);
                continue;
              }
              // The field cache may be invalidated or rebound by a later
              // guest call/write while this earlier array reference remains
              // live on the SSA operand stack. Snapshot its storage companion
              // so future cache maintenance cannot retarget this value.
              const dataSnapshot = value();
              lines.push(constDecl(dataSnapshot, e`${cache.data}`,
                {pure: true}));
              arrayViews.set(out, dataSnapshot);
            }
            stack.push(out);
          }
        } else if (op === "putfield") {
          const storedInput = pop(), objectInput = pop(), site = fieldSites.get(index);
          if (storedInput === null || objectInput === null || site === undefined) valid = false;
          else {
            const fieldPlan = this.jit.fieldSites[site];
            const directKey = fieldPlan?.directInstanceKey || null;
            const denseSlot = fieldPlan?.denseSlot;
            const writeKeys = fieldPlan
              ? new Set([`${fieldPlan.fieldName}:${fieldPlan.descriptor}`])
              : null;
            lines.push(...invalidateFieldReadCaches(writeKeys));
            const object = stagedValue(objectInput, lines);
            const stored = stagedValue(storedInput, lines);
            lines.push(
              stmt(e`if (${object} === null || ${object} === undefined) {`,
              {kind: "nullCheck", value: object}),
              ...materializeLines([...stack, object, stored], index, true).map((line) => `  ${line}`),
              st`  helpers.putFieldAt(${site}, ${object}, ${stored});`, blockEnd(""),
              ...(Number.isInteger(denseSlot) ? [
                st`if (Array.isArray(${object}.fields)) {`,
                st`  ${object}.fields[${denseSlot}] = ${stored};`,
                stmt(e`} else if (${object}.fields) {`,
                  {kind: "elseIfArm"}),
                st`  ${object}.fields[${JSON.stringify(directKey)}] = ${stored};`,
                elseArm(""),
                st`  helpers.putFieldAt(${site}, ${object}, ${stored});`,
                blockEnd(""),
              ] : directKey ? [
                st`if (${object}.fields) {`,
                st`  ${object}.fields[${JSON.stringify(directKey)}] = ${stored};`,
                elseArm(""),
                st`  helpers.putFieldAt(${site}, ${object}, ${stored});`,
                blockEnd(""),
              ] : [st`helpers.putFieldAt(${site}, ${object}, ${stored});`]));
          }
        } else if (op === "new") {
          const out = value();
          lines.push(constDecl(out,
            e`helpers.newObjectSync(${JSON.stringify(instruction.arg)})`),
            st`if (${out} === helpers.staticDeopt()) {`,
            ...materializeLines(stack, index).map((line) => `  ${line}`),
            st`  helpers.skipJitOnce(frame);`,
            st`  return { deopt: true, transient: true, reason: 'class initialization in structured SSA new' };`,
            blockEnd(""));
          stack.push(out);
        } else if (op === "getstatic") {
          const site = fieldSites.get(index), direct = directStaticSites.get(index), out = value();
          if (site === undefined) valid = false;
          else if (direct && guardedStaticBooleanSites.has(index)) {
            stack.push(String(direct.guardedBooleanValue));
          }
          else if (direct) {
            const entryCache = direct.entryReadCache;
            if (entryCache) {
              stack.push(entryCache.value);
              if (entryCache.data) {
                arrayViews.set(entryCache.value, entryCache.data);
              }
              if (direct.descriptor?.startsWith("[")) {
                arrayKinds.set(entryCache.value, direct.descriptor);
              }
              if (direct.descriptor?.startsWith("[L") ||
                  direct.descriptor?.startsWith("[[")) {
                resolvedStaticReferenceArrayValues.add(entryCache.value);
              }
              continue;
            }
            const location = `${direct.className}\0${direct.key}`;
            const cached = directStaticBlockValues.get(location);
            if (cached) {
              stack.push(cached.value);
              if (cached.data) arrayViews.set(cached.value, cached.data);
              if (direct.descriptor?.startsWith("[")) {
                arrayKinds.set(cached.value, direct.descriptor);
              }
              if (direct.descriptor?.startsWith("[L") ||
                  direct.descriptor?.startsWith("[[")) {
                resolvedStaticReferenceArrayValues.add(cached.value);
              }
            } else {
              const emissionStart = lines.length;
              const key = JSON.stringify(direct.key);
              lines.push(constDecl(out, direct.kind === "map"
                ? e`${direct.variable}.get(${key})`
                : e`${direct.variable}[${key}]`,
              {pure: true, indexed: direct.kind !== "map"}));
              stack.push(out);
              let data = null;
              if (direct.descriptor?.startsWith("[")) {
                data = value();
                const producedView = arrayDataExpr(out);
                lines.push(constDecl(data, producedView,
                  {pure: producedView.pure === true}));
                arrayViews.set(out, data);
                arrayKinds.set(out, direct.descriptor);
              }
              directStaticEmissionsByItem.set(index, {
                lines, start: emissionStart, value: out, data,
              });
              if (direct.descriptor?.startsWith("[L") ||
                  direct.descriptor?.startsWith("[[")) {
                resolvedStaticReferenceArrayValues.add(out);
              }
              directStaticBlockValues.set(location, { value: out, data });
            }
          }
          else {
            const lazy = lazyStaticSites.get(index);
            if (lazy) {
              const cache = lazy.entryReadCache;
              const emitted = cache &&
                  this.directEntryStaticLinkingEnabled ? [] : lines;
              const prefix = cache ? "  " : "";
              emitted.push(letDecl(out));
              if (cache) {
                emitted.push(st`if (${cache.valid}) {`,
                  st`  ${out} = ${cache.value};`,
                  elseArm(""));
              }
              emitted.push(st`${prefix}if (${lazy.variable}) {`,
                stmt(exprConcat(
                  e`${prefix}  ${out} = ${lazy.variable}.kind === "map" ? `,
                  e`${lazy.variable}.fields.get(${lazy.variable}.key) : `,
                  e`${lazy.variable}.fields[${lazy.variable}.key];`),
                {kind: "assign", write: out}),
                st`${prefix}} else {`,
                st`${prefix}  ${out} = helpers.getStaticSyncAt(${site});`,
                st`${prefix}  if (${out} === helpers.staticDeopt()) {`,
                ...materializeLines(stack, index).map(
                  (line) => `${prefix}    ${line}`),
                st`${prefix}    helpers.skipJitOnce(frame);`,
                st`${prefix}    return { deopt: true, transient: true, reason: 'class initialization in structured SSA getstatic' };`,
                st`${prefix}  }`,
                st`${prefix}  ${lazy.variable} = helpers.fieldSites[${site}].staticTarget;`,
                st`${prefix}  if (${lazy.variable}) helpers.structuredSsa.lazyStaticTargetLinkCount += 1;`,
                st`${prefix}}`);
              if (cache) {
                // A whole-class preparation can compile this method before
                // the static owner initializes. Once the ordinary framed
                // entry links the field, refresh every part of the entry
                // cache together. Leaving the raw primitive-array companion
                // at its pre-link null value makes a later proven store use
                // stale storage even though the Java reference resolved.
                emitted.push(
                  stmt(e`  ${cache.value} = ${normalizeJvmScalarExpression(
                    out, cache.descriptor)};`),
                  ...(cache.data
                    ? [stmt(e`  ${cache.data} = ${arrayDataExpr(out)};`)]
                    : []),
                  st`  ${cache.valid} = Boolean(${lazy.variable});`,
                  blockEnd(""),
                );
              }
              if (emitted !== lines) {
                const marker = named(
                  `__JVM_DIRECT_ENTRY_STATIC_READ_${index}_${site}__`);
                directEntryStaticReadFallbacks.set(marker, {
                  direct: [constDecl(out, e`${cache.value}`, {pure: true})],
                  ordinary: emitted,
                });
                lines.push(st`${marker}`);
              }
            } else {
              lines.push(
              constDecl(out, e`helpers.getStaticSyncAt(${site})`),
              st`if (${out} === helpers.staticDeopt()) {`,
              ...materializeLines(stack, index).map((line) => `  ${line}`),
              st`  helpers.skipJitOnce(frame);`,
              st`  return { deopt: true, transient: true, reason: 'class initialization in structured SSA getstatic' };`,
              blockEnd(""));
            }
            stack.push(out);
            const lazyCache = lazy?.entryReadCache;
            if (lazyCache?.data) {
              arrayViews.set(out, lazyCache.data);
            }
            const descriptor = this.jit.fieldSites[site]?.descriptor;
            if (descriptor?.startsWith("[")) arrayKinds.set(out, descriptor);
            // A linkable static read either resolves before producing its
            // value or returns the existing materializing deopt above. Thus
            // its successful reference-array value has the same provenance
            // as an entry-resolved direct target.
            if (descriptor?.startsWith("[L") || descriptor?.startsWith("[[")) {
              resolvedStaticReferenceArrayValues.add(out);
            }
          }
        } else if (op === "putstatic") {
          directStaticBlockValues.clear();
          const input = pop(), site = fieldSites.get(index), direct = directStaticSites.get(index),
            changed = value();
          if (input === null || site === undefined) valid = false;
          else if (direct) lines.push(
            st`${direct.variable}.set(${JSON.stringify(direct.key)}, ${input});`,
            stmt(exprConcat(
              e`if (helpers.directStaticTargets[${direct.targetId}].versionCell`,
              e`.captureCaches) helpers.markStaticTargetChanged(`,
              e`helpers.directStaticTargets[${direct.targetId}]);`)));
          else lines.push(
            constDecl(changed, e`helpers.putStaticSyncAt(${site}, ${input})`),
            st`if (${changed} === helpers.staticDeopt()) {`,
            ...materializeLines([...stack, input], index).map((line) => `  ${line}`),
            st`  helpers.skipJitOnce(frame);`,
            st`  return { deopt: true, transient: true, reason: 'class initialization in structured SSA putstatic' };`,
            blockEnd(""));
        } else if (op === "invokestatic" || op === "invokevirtual" ||
            op === "invokespecial" || op === "invokeinterface") {
          directStaticBlockValues.clear();
          const site = callSites.get(index);
          lines.push(...invalidateFieldReadCaches(
            callFieldWriteSummaries.get(index)));
          if (!site || stack.length < site.argumentCount) valid = false;
          else if (site.directJre) {
            const callStack = [...stack];
            const args = new Array(site.argumentCount);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const out = value(), caught = value();
              lines.push(...(site.directJre.isStatic ? [
                st`if (!helpers.directJreInitializationTokens[${site.directJre.id}].initialized) {`,
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                st`  helpers.skipJitOnce(frame);`,
                st`  return { deopt: true, transient: true, reason: 'class initialization at direct structured JRE call' };`,
                blockEnd(""),
              ] : []), letDecl(out),
              stmt(exprConcat(
                e`try { ${out} = helpers.directJreIntrinsics[${
                  site.directJre.id}](`,
                argumentListExpression(args), e`); } catch (${caught}) {`)),
              ...materializeLines(callStack, index).map((line) => `  ${line}`),
              st`  throw ${caught};`, blockEnd(""));
              if (!site.returnsVoid) stack.push(out);
            }
          }
          else if (site.inline) {
            const callStack = [...stack];
            const args = new Array(site.inline.paramCount);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const out = value();
              // The plan is rendered once against fixed parameter names;
              // each site binds those names to its operands inside the block.
              lines.push(letDecl(out), blockStart(""),
                // The inline plan's own statements are foreign, but the
                // bindings that feed them are this compile's statements: the
                // operand each one reads is an ordinary operand reference.
                ...args.map((argument, position) => stmt(
                  e`  const ${inlineIntegerArgumentName(position)} = ${
                    argument};`)),
                ...site.inline.statements.map((statement) =>
                  stmt(`  ${statement}`, {foreign: true})));
              if (site.inline.guards?.length) {
                const guard = site.inline.guards.join(" && ");
                lines.push(stmt(`  if (!(${guard})) {`, {foreign: true}),
                  ...materializeLines(callStack, index)
                    .map((line) => `    ${line}`),
                  st`    helpers.skipJitOnce(frame);`,
                  st`    return { deopt: true, transient: true, reason: 'guarded inline integer leaf' };`,
                  blockEnd("  "));
              }
              lines.push(stmt(e`  ${out} = ${site.inline.result};`),
                blockEnd(""));
              stack.push(out);
            }
          } else if (site.directIntrinsic?.kind === "primitiveArrayCopy" &&
              site.directIntrinsic.paramCount === 5 && site.directIntrinsic.returnsVoid) {
            const callStack = [...stack];
            const args = new Array(5);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (valid) {
              const caught = value();
              lines.push(stmt(exprConcat(
                e`try { helpers.primitiveArrayCopyDirect(`,
                argumentListExpression(args), e`); } catch (${caught}) {`)),
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                st`  throw ${caught};`, blockEnd(""));
            }
          } else {
            const callStack = [...stack];
            const args = new Array(site.argumentCount);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (!valid) continue;
            const invariantReceiverSlot = site.dynamic && args.length > 0
              ? localLoads.get(args[0]) : null;
            if (Number.isInteger(invariantReceiverSlot) &&
                !assignedReferenceLocals.has(invariantReceiverSlot)) {
              invariantPositionalReceiverSlots.set(
                index, invariantReceiverSlot);
            }
            const positionalArgumentArrayData = args.map((argument) => {
              const argumentSlot = localLoads.get(argument);
              const data = arrayViews.get(argument) ||
                persistentProducedArrayLocalViews.get(argumentSlot)?.data ||
                persistentStaticArrayLocalViews.get(argumentSlot)?.data ||
                entryStaticArrayLocalViews.get(argumentSlot)?.data ||
                entryFieldArrayLocalViews.get(argumentSlot)?.data || null;
              return data ? {
                data,
                nonNull: unconditionallyNonNullEntryArrayData.has(data),
              } : null;
            });
            const out = value(), caught = value();
            const callStackDepth = value();
            let inlineCheckedLeafVoidFastPath = false;
            const deferMaterialization = this.deferredCallMaterializationEnabled;
            const resumableVoidCall = site.returnsVoid;
            const activeChildCallMarker = named(
              `__JVM_ACTIVE_CHILD_CALL_${index}_${site.id}__`);
            continuationFallbacks.set(activeChildCallMarker, {
              continuation: [
                ...materializeLines(stack, index + 1).map((line) => `    ${line}`),
                st`    yield { deopt: true, transient: true, structuredResumePc: ${
                  index + 1
                }, structuredResumeOwnsFrame: true, reason: 'active child in structured SSA callee' };`,
                st`    ${callStackDepth} = thread.callStack.items.length;`,
                ...(site.returnsVoid ? [] : [
                  st`    ${out} = frame.stack.items.pop();`,
                ]),
              ],
              ordinary: [
                ...materializeLines(stack, index + 1).map((line) => `    ${line}`),
                stmt(exprConcat(e`    return { deopt: true, transient: true, `,
                  e`reason: 'asynchronous structured SSA callee left active child', `,
                  e`jvmPositionalChild: frame };`)),
              ],
              checkedLeaf: [leafBailStatement("    ")],
            });
            const asynchronousCallMarker = named(
              `__JVM_ASYNC_VOID_CALL_${index}_${site.id}__`);
            if (resumableVoidCall) {
              continuationFallbacks.set(asynchronousCallMarker, {
                continuation: [
                  ...materializeLines(callStack, index).map((line) => `  ${line}`),
                  st`  helpers.skipJitOnce(frame);`,
                  st`  yield { deopt: true, transient: true, structuredResumePc: ${
                    index + 1
                  }, reason: 'asynchronous structured SSA callee' };`,
                ],
                ordinary: [
                  ...materializeLines(callStack, index).map((line) => `  ${line}`),
                  st`  helpers.skipJitOnce(frame);`,
                  st`  return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };`,
                ],
                checkedLeaf: [leafBailStatement()],
              });
            }
            const fallbackLines = [
              ...(deferMaterialization
                ? stageOperandLines(callStack) : materializeLines(callStack, index + 1)),
              st`try { ${out} = helpers.tryInvokeSyncAt(${site.id}, frame, thread); } catch (${caught}) {`,
              ...materializeCallExceptionLines(
                callStack, stack, index, callStackDepth)
                .map((line) => `  ${line}`),
              st`  throw ${caught};`, blockEnd(""),
            ];
            // A restoring-direct body begins without a physical caller
            // Frame. A fast positional callee can suspend before the fallback
            // above ever restores one, leaving only its child (or a visible
            // descendant) on the scheduler stack. Linkage needs the real
            // caller identity, and the caller must already describe the
            // post-invoke state before that child can return a value into it.
            // Materialize that state only on the cold active-child path. If
            // linkage subsequently rejects the handoff, the ordinary replay
            // arm below rewrites the same Frame to the invoke pc and operands.
            const materializeOmittedCallerForChild = (indentation) => [
              st`${indentation}if (frame === null) {`,
              ...materializeLines(stack, index + 1)
                .map((line) => `${indentation}  ${line}`),
              st`${indentation}}`,
            ];
            const asynchronousActiveChildLines = [
              st`if (${out} === helpers.asyncInvokeSentinel() &&`,
              st`    thread.callStack.items.length > ${callStackDepth}) {`,
              ...materializeOmittedCallerForChild("  "),
              blockEnd(""),
              st`if (${out} === helpers.asyncInvokeSentinel() &&`,
              st`    thread.callStack.items.length > ${callStackDepth} &&`,
              st`    helpers.linkStructuredCallChild(frame, thread, ${
                callStackDepth}, ${JSON.stringify(site.returnType)}, ${site.id})) {`,
              st`${activeChildCallMarker}`,
              blockEnd(""),
            ];
            const checkedAdmissionPlan = site.returnsVoid &&
              site.directCheckedLeaf?.noThrow === true &&
              ["record-window", "clipped-affine-fill"].includes(
                site.directCheckedLeaf?.admissionPlan?.kind)
              ? site.directCheckedLeaf.admissionPlan : null;
            const checkedAdmissionStart = checkedAdmissionPlan
              ? st`/*__SSA_CHECKED_ADMISSION_START_${index}__*/` : null;
            const checkedAdmissionEnd = checkedAdmissionPlan
              ? st`/*__SSA_CHECKED_ADMISSION_END_${index}__*/` : null;
            if (checkedAdmissionStart) lines.push(checkedAdmissionStart);
            if (site.selfRecursive) {
              lines.push(st`/*__SSA_SELF_RECURSIVE_REGION_START_${index}__*/`);
            }
            lines.push(st`/*${site.regionMarkers.start}*/`, letDecl(out),
              letDecl(callStackDepth, e`thread.callStack.items.length`));
            if (site.id !== null && site.id !== undefined) {
              const usedDirect = value();
              const runtimeSite = positionalCallSiteVariable(index);
              const positionalTarget = positionalCallTargetVariable(index);
              const positionalInvoke = positionalCallInvokeVariable(index);
              const positionalRawInvoke =
                positionalCallRawInvokeVariable(index);
              const positionalRawCaptures =
                (site.directCheckedLeaf?.captures || []).flatMap(
                  (capture, captureIndex, captures) => {
                    let offset = 0;
                    for (let earlier = 0; earlier < captureIndex; earlier += 1) {
                      offset += captures[earlier].data ? 2 : 1;
                    }
                    const values = [named(`ssaCallCapture${index}_${offset}`)];
                    if (capture.data) {
                      values.push(named(`ssaCallCapture${index}_${offset + 1}`));
                    }
                    return values;
                  });
              const positionalReceiver =
                positionalCallReceiverVariable(index);
              const positionalLateLink =
                positionalCallLateLinkVariable(index);
              const polymorphicPositionalLinkLines = site.dynamic &&
                site.argumentCount > 0 && !site.selfRecursive ? (() => {
                const receiverType = named(`ssaReceiverType${index}`);
                const picTarget = named(`ssaPicTarget${index}`);
                return [
                  stmt(exprConcat(
                    e`if (!helpers.profileMethods && ${args[0]} !== null && `,
                    e`${args[0]} !== undefined && ${runtimeSite}) {`)),
                  stmt(exprConcat(e`  const ${receiverType} = `,
                    e`(${args[0]}.type || ${runtimeSite}.declaredClassName);`),
                  {kind: "const", def: receiverType}),
                  st`  if (${receiverType} !== ${positionalReceiver}) {`,
                  stmt(exprConcat(e`    const ${picTarget} = `,
                    e`${runtimeSite}.fastPositionalTargets && `,
                    e`${runtimeSite}.fastPositionalTargets[`,
                    e`${receiverType}];`), {kind: "const", def: picTarget}),
                  stmt(exprConcat(e`    if (${picTarget} && `,
                    e`(${picTarget}.debugGuarded || `,
                    e`!helpers.jvm.debugManager.isClassJitDeopted(`,
                    e`${picTarget}.lookupClass))) {`)),
                  st`      ${positionalTarget} = ${picTarget};`,
                  st`      ${positionalInvoke} = ${picTarget}.invoke;`,
                  stmt(exprConcat(e`      ${positionalRawInvoke} = `,
                    e`${picTarget}.rawInvoke;`)),
                  st`      ${positionalReceiver} = ${picTarget}.receiverType;`,
                  blockEnd("    "),
                  blockEnd("  "),
                  blockEnd(""),
                ];
              })() : [];
              // A long-lived structured activation can enter before a cold
              // child site has linked its monomorphic positional target. The
              // canonical first call publishes that target, but an immutable
              // prologue snapshot otherwise keeps allocating child Frames for
              // every later loop iteration until the entire parent returns.
              // Refresh once after linkage, then retain the scalar function
              // locals for the rest of this activation.
              const latePositionalLinkLines =
                site.directCheckedLeaf || site.selfRecursive ? [] : [
                stmt(exprConcat(
                  e`if (${positionalLateLink} && !(${positionalRawInvoke} || `,
                  e`${positionalInvoke}) && !helpers.profileMethods && `,
                  e`${runtimeSite} && ${runtimeSite}.fastPositional && `,
                  e`(${runtimeSite}.fastPositional.debugGuarded || `,
                  e`!helpers.jvm.debugManager.isClassJitDeopted(`,
                  e`${runtimeSite}.fastPositional.lookupClass))) {`)),
                st`  ${positionalTarget} = ${runtimeSite}.fastPositional;`,
                st`  ${positionalInvoke} = ${positionalTarget}.invoke;`,
                st`  ${positionalRawInvoke} = ${positionalTarget}.rawInvoke;`,
                st`  ${positionalReceiver} = ${positionalTarget}.receiverType;`,
                blockEnd(""),
              ];
              const invariantPositionalRaw =
                !site.selfRecursive &&
                invariantPositionalReceiverSlots.has(index)
                  ? invariantPositionalRawVariable(index) : null;
              const directCheckedLeafNoThrow =
                site.directCheckedLeaf?.noThrow === true;
              const inlineCheckedLeafBody =
                directCheckedLeafNoThrow && site.directCheckedLeaf?.inlineBody
                  ? site.directCheckedLeaf.inlineBody : null;
              const inlineCheckedLeafVoid = Boolean(
                inlineCheckedLeafBody && site.returnsVoid &&
                inlineCheckedLeafBody.returnsVoid);
              if (inlineCheckedLeafVoid) lexicalVoidFastPathSites.add(index);
              inlineCheckedLeafVoidFastPath = inlineCheckedLeafVoid;
              const inlineCheckedLeafLabel =
                `ssaInlineCheckedLeaf${compileSerial}_${index}`;
              const inlineCheckedLeafFallbackMarker = named(
                `__JVM_INLINE_CHECKED_LEAF_FALLBACK_${index}_${site.id}__`);
              // Lexical insertion binds by declaration. The caller stages its
              // operands, captures, and array views into caller-unique names
              // before the inserted scope opens; inside that scope the child's
              // own parameter, capture, and local names shadow the caller's
              // without reading through a temporal dead zone, and the child
              // leaves its result in the slot its labeled body owns.
              const inlineCheckedLeafStage = (kind, position) =>
                named(`ssaInline${compileSerial}_${index}_${kind}${position}`);
              const inlineCheckedLeafLinesFor = (provenGuards) => {
                if (!inlineCheckedLeafBody ||
                    inlineCheckedLeafBody.argumentNames.length !==
                      args.length ||
                    inlineCheckedLeafBody.captureArguments.length !==
                      positionalRawCaptures.length) return null;
                const feeds = new Map();
                positionalArgumentArrayData.forEach((view, argument) => {
                  if (!view) return;
                  feeds.set(argument, {
                    expression: inlineCheckedLeafStage("v", argument),
                    nonNull: view.nonNull,
                  });
                });
                const assembled = inlineCheckedLeafBody.assemble({
                  feeds, provenGuards, exitLabel: inlineCheckedLeafLabel,
                });
                if (!assembled) return null;
                return {
                  bails: assembled.bails,
                  lines: [
                    ...args.map((argument, position) => constDecl(
                      inlineCheckedLeafStage("a", position), e`${argument}`,
                      {pure: true})),
                    ...positionalRawCaptures.map((capture, position) =>
                      constDecl(inlineCheckedLeafStage("c", position),
                        e`${capture}`, {pure: true})),
                    ...[...feeds.keys()].map((argument) => constDecl(
                      inlineCheckedLeafStage("v", argument),
                      e`${positionalArgumentArrayData[argument].data}`,
                      {pure: true})),
                    blockStart(""),
                    ...inlineCheckedLeafBody.argumentNames.map(
                      (name, position) => stmt(
                        e`  const ${name} = ${
                          inlineCheckedLeafStage("a", position)};`)),
                    ...inlineCheckedLeafBody.captureArguments.map(
                      (name, position) => stmt(
                        e`  const ${name} = ${
                          inlineCheckedLeafStage("c", position)};`)),
                    stmt("  const nestedEntryGuarded = true;",
                      {foreign: true}),
                    ...assembled.lines.map((line) =>
                      stmt(`  ${line}`, {foreign: true})),
                    stmt(e`  ${out} = ${inlineCheckedLeafBody.result};`),
                    blockEnd(""),
                  ],
                };
              };
              const inlineCheckedLeafLines =
                inlineCheckedLeafLinesFor(new Set())?.lines || null;
              const provenInlineCheckedLeafLines =
                checkedAdmissionPlan && inlineCheckedLeafLines
                  ? (() => {
                    if (checkedAdmissionPlan.kind === "record-window") {
                      const guard = checkedAdmissionPlan.guardVariable;
                      if (typeof guard !== "string") return null;
                      const proven =
                        inlineCheckedLeafLinesFor(new Set([guard]));
                      // The caller's admission proof must have removed every
                      // exit; a body that can still reject is not proven.
                      if (!proven || proven.bails > 0) return null;
                      return proven.lines;
                    }
                    if (checkedAdmissionPlan.kind !== "clipped-affine-fill") {
                      return null;
                    }
                    const trusted = [];
                    const x = named(`ssaClippedX${index}`);
                    const y = named(`ssaClippedY${index}`);
                    const count = named(`ssaClippedCount${index}`);
                    const pixel = named(`ssaClippedPixel${index}`);
                    const end = named(`ssaClippedEnd${index}`);
                    const argument = (position) =>
                      operand(e`(${args[position]})`);
                    const specializedCache =
                      this.jit.checkedLeafCaptureCaches[
                        site.checkedLeafCaptureCacheId];
                    if (specializedCache?.dirty &&
                        specializedCache.specializationInitialized) {
                      this.jit.refreshCheckedLeafCaptureCache(
                        site.checkedLeafCaptureCacheId);
                    }
                    const specialized = Boolean(
                      specializedCache?.specializationInitialized &&
                      specializedCache.specializedMatches === true &&
                      [
                        checkedAdmissionPlan.topCapture,
                        checkedAdmissionPlan.bottomCapture,
                        checkedAdmissionPlan.leftCapture,
                        checkedAdmissionPlan.rightCapture,
                        checkedAdmissionPlan.widthCapture,
                      ].every((position) => Number.isInteger(
                        specializedCache[`specializedValue${position}`])) &&
                      specializedCache[`specializedValue${
                        checkedAdmissionPlan.arrayDataCapture}`] !== null);
                    const capture = (position) =>
                      specialized && Number.isInteger(
                        specializedCache[`specializedValue${position}`])
                        ? String(specializedCache[
                          `specializedValue${position}`] | 0)
                        // The version match proves that the ordinary entry
                        // array snapshot is the specialized array. Keep its
                        // scalar alias in the loop so the JS engine does not
                        // have to rediscover/hoist a mutable cache property.
                        : specialized && position ===
                            checkedAdmissionPlan.arrayDataCapture
                          ? specializedCheckedCapture(
                            site.checkedLeafCaptureCacheId, position)
                          : operand(e`(${positionalRawCaptures[position]})`);
                    const top = capture(checkedAdmissionPlan.topCapture);
                    const bottom = capture(
                      checkedAdmissionPlan.bottomCapture);
                    const left = capture(checkedAdmissionPlan.leftCapture);
                    const right = capture(
                      checkedAdmissionPlan.rightCapture);
                    const width = capture(
                      checkedAdmissionPlan.widthCapture);
                    const destination = capture(
                      checkedAdmissionPlan.arrayDataCapture);
                    trusted.push(
                      letDecl(x, e`${argument(
                        checkedAdmissionPlan.xArgument)}`),
                      constDecl(y, e`${argument(
                        checkedAdmissionPlan.yArgument)}`, {pure: true}),
                      letDecl(count, e`${argument(
                        checkedAdmissionPlan.countArgument)}`),
                      st`if (${y} >= ${top} && ${y} < ${bottom}) {`,
                      st`  if (${x} < ${left}) {`,
                      stmt(exprConcat(e`    ${count} = (${count} - `,
                        e`(${left} - ${x}));`), {kind: "assign", write: count}),
                      st`    ${x} = ${left};`,
                      blockEnd("  "),
                      stmt(exprConcat(e`  if ((${x} + ${count}) > ${right}) `,
                        e`${count} = ${right} - ${x};`)),
                      letDecl(pixel, e`(${y} * ${width}) + ${x}`),
                      constDecl(end, e`${pixel} + ${count}`, {pure: true}),
                      st`  while (${pixel} < ${end}) {`,
                      stmt(e`    ${destination}[${pixel}] = ${argument(
                        checkedAdmissionPlan.valueArgument)};`,
                      {kind: "arrayStore"}),
                      st`    ${pixel} += 1;`,
                      blockEnd("  "),
                      blockEnd(""),
                    );
                    return trusted;
                  })() : null;
              const receiverGuard = site.dynamic && site.argumentCount > 0
                ? operand(exprConcat(
                  e`${args[0]} !== null && ${args[0]} !== undefined && `,
                  e`(${args[0]}.type || ${runtimeSite}.declaredClassName) === `,
                  e`${positionalReceiver}`))
                : site.hasReceiver && site.argumentCount > 0
                  ? operand(exprConcat(
                    e`${args[0]} !== null && ${args[0]} !== undefined && `,
                    e`${positionalReceiver} === null`))
                  : "true";
              if (inlineCheckedLeafLines) {
                continuationFallbacks.set(inlineCheckedLeafFallbackMarker, {
                  continuation: fallbackLines,
                  ordinary: [
                    ...materializeLines(callStack, index),
                    st`helpers.skipJitOnce(frame);`,
                    stmt(exprConcat(e`return { deopt: true, transient: true, `,
                      e`reason: 'checked leaf admission' };`)),
                  ],
                  // The lexically inserted child is proven non-throwing and
                  // performs no effect before its own entry bailout. A
                  // wrapper checked leaf can therefore reject directly and
                  // let its canonical caller execute the original bytecode.
                  checkedLeaf: [leafBailStatement()],
                });
              }
              // Rendered against the nested-entry argument so a region that
              // links this site can select the already-guarded form by
              // identity instead of locating the call in emitted text, and
              // with one compiler-owned token in front of each operand. Later
              // line passes rewrite operand expressions freely (SSA aliasing,
              // one-use inlining); the tokens are what survives, so a caller
              // takes each operand from between them instead of re-deriving
              // the argument list from the emitted call.
              const regionOperandTokens = [...args, ...positionalRawCaptures]
                .map((_operand, position) =>
                  `/*__JVM_CALL_ARG_${index}_${position}__*/`);
              const regionMarkedOperands = [...args, ...positionalRawCaptures]
                .map((value, position) =>
                  e`${regionOperandTokens[position]}${value}`);
              const positionalRawCallFor = (nestedEntryGuarded) =>
                operand(exprConcat(
                  e`${positionalRawInvoke} ? `,
                  e`${positionalRawInvoke}(helpers, `,
                  regionMarkedOperands.length
                    ? exprConcat(argumentListExpression(regionMarkedOperands),
                      ", ") : "",
                  e`thread, ${nestedEntryGuarded}) : `,
                  e`${positionalInvoke}(`,
                  argumentListExpression(args),
                  args.length ? ", " : "", e`thread, true)`));
              const positionalRawCall = positionalRawCallFor("true");
              const regionRestoreMarkers = {
                start: `__JVM_CALL_RESTORE_START_${index}__`,
                end: `__JVM_CALL_RESTORE_END_${index}__`,
              };
              const regionHandlerMarkers = {
                start: `__JVM_CALL_HANDLER_START_${index}__`,
                end: `__JVM_CALL_HANDLER_END_${index}__`,
              };
              const invariantPositionalRawCall = invariantPositionalRaw
                ? operand(exprConcat(
                  e`${invariantPositionalRaw}(helpers`,
                  args.length ? ", " : "",
                  argumentListExpression(args), e`)`))
                : null;
              if (checkedAdmissionPlan) {
                const provenRawCall = stmt(exprConcat(
                  e`${positionalRawInvoke}(helpers`,
                  args.length ? ", " : "",
                  argumentListExpression(args),
                  positionalRawCaptures.length
                    ? exprConcat(args.length ? ", " : "",
                      argumentListExpression(positionalRawCaptures))
                    : "",
                  args.length || positionalRawCaptures.length ? ", " : ", ",
                  e`thread, true);`));
                const replacement = provenInlineCheckedLeafLines
                  ? [
                    `${recordStatement([`${inlineCheckedLeafLabel}: {`],
                    {kind: "inlineLeafLabel", label: inlineCheckedLeafLabel})}`,
                    ...provenInlineCheckedLeafLines.map(
                      (line) => `  ${line}`),
                    blockEnd(""),
                  ] : [provenRawCall];
                checkedCallAdmissionCandidates.push({
                  block: block.id,
                  itemIndex: index,
                  startMarker: checkedAdmissionStart,
                  endMarker: checkedAdmissionEnd,
                  replacement,
                  plan: checkedAdmissionPlan,
                  args: [...args],
                  argumentRanges: args.map((argument) =>
                    boundedIntegerRange(argument)),
                  argumentArrays: positionalArgumentArrayData,
                  captureExpressions: [...positionalRawCaptures],
                  captureCacheId: site.checkedLeafCaptureCacheId,
                  captureCacheVariable: named(`ssaCallCaptureCache${index}`),
                });
              }
              const selfRecursiveMarker = site.selfRecursive
                ? `/*__SSA_SELF_RECURSIVE_CALL_${index}__*/` : "";
              const positionalQuantumMarker = named(
                `__JVM_POSITIONAL_QUANTUM_${index}_${site.id}__`);
              if (this.jit.positionalCallSafePointPollingEnabled &&
                  structured.loopHeaders.size > 0) {
                continuationFallbacks.set(positionalQuantumMarker, {
                  continuation: [
                    st`safePointBudget = Math.min(safePointBudget, ${
                      this.jit.positionalCallSafePointPollBudget});`,
                    stmt(exprConcat(
                      e`safePointBudget -= ((${positionalRawInvoke} || `,
                      e`${positionalInvoke}).jvmSafePointCharge || 0);`)),
                    st`if (safePointBudget <= 0) {`,
                    st`  if (helpers.continueStructuredQuantum(thread)) {`,
                    st`    safePointBudget = ${
                      this.jit.positionalCallSafePointPollBudget};`,
                    elseArm("  "),
                    ...materializeLines(callStack, index)
                      .map((line) => `    ${line}`),
                    st`    helpers.structuredSsa.safePointCount += 1;`,
                    st`    safePointBudget = ${
                      this.jit.positionalCallSafePointPollBudget};`,
                    stmt(exprConcat(
                      e`    yield { deopt: true, transient: true, `,
                      e`reason: 'structured SSA positional quantum' };`)),
                    // A frameless positional caller is restored onto the JVM
                    // stack while this generator is suspended. The depth
                    // captured before the safe point therefore no longer
                    // describes the call boundary after resume. Refresh it
                    // before invoking the child so the caller itself cannot
                    // be mistaken for a scheduler-visible callee.
                    st`    ${callStackDepth} = thread.callStack.items.length;`,
                    blockEnd("  "),
                    blockEnd(""),
                  ],
                  ordinary: [],
                  checkedLeaf: [],
                });
              }
              let selfRecursiveGuardLine = null;
              if (site.selfRecursive) {
                selfRecursiveCallExpressions.set(index, {
                  index,
                  marker: selfRecursiveMarker,
                  ordinary: positionalRawCall,
                  args: [...args],
                  result: out,
                });
                const ordinaryGuard = stmt(exprConcat(
                  e`if ((${positionalRawInvoke} || ${positionalInvoke}) && `,
                  e`${receiverGuard}) {`));
                selfRecursiveGuardLine = ordinaryGuard;
                directPositionalLineAlternatives.set(ordinaryGuard,
                  site.hasReceiver
                    ? st`if (${args[0]} !== null && ${args[0]} !== undefined) {`
                    : st`if (true) {`);
              }
              lines.push(...latePositionalLinkLines);
              lines.push(...polymorphicPositionalLinkLines);
              if (inlineCheckedLeafLines && receiverGuard === "true") {
                // A static lexical child has no dispatch or receiver
                // predicate: its body is already present in this generated
                // region.  Do not manufacture a `usedDirect` flag and a
                // constant `if (true)` around every loop invocation.  The
                // child's own before-effects admission result remains the
                // sole fallback predicate, preserving exact canonical
                // execution when an assumption is not satisfied.
                lines.push(
                  `${recordStatement([`${inlineCheckedLeafLabel}: {`],
                    {kind: "inlineLeafLabel", label: inlineCheckedLeafLabel})}`,
                  ...inlineCheckedLeafLines.map((line) => `  ${line}`),
                  blockEnd(""),
                  stmt(e`if (${inlineCheckedLeafVoid
                    ? e`!${out}`
                    : e`${out} === helpers.asyncInvokeSentinel()`}) {`),
                  st`${inlineCheckedLeafFallbackMarker}`,
                  ...(inlineCheckedLeafVoid ? [] : [blockEnd("")]));
              } else lines.push(
                letDecl(usedDirect, e`false`),
                ...(invariantPositionalRaw ? [
                  st`if (${invariantPositionalRaw}) {`,
                  st`  ${usedDirect} = true;`,
                  stmt(e`  ${out} = ${invariantPositionalRawCall};`,
                    {kind: "assign", write: out}),
                  stmt(e`} else if (${inlineCheckedLeafLines
                    ? e`${receiverGuard}`
                    : e`(${positionalRawInvoke} || ${positionalInvoke}) && ${
                      receiverGuard}`}) {`),
                ] : [
                  selfRecursiveGuardLine ||
                    stmt(e`if (${inlineCheckedLeafLines
                      ? e`${receiverGuard}`
                      : e`(${positionalRawInvoke} || ${positionalInvoke}) && ${
                        receiverGuard}`}) {`),
                ]),
                st`  ${usedDirect} = true;`,
                ...(this.jit.positionalCallSafePointPollingEnabled &&
                    structured.loopHeaders.size > 0
                  ? [st`${positionalQuantumMarker}`] : []),
                ...(inlineCheckedLeafLines ? [
                  `  ${recordStatement([`${inlineCheckedLeafLabel}: {`],
                    {kind: "inlineLeafLabel", label: inlineCheckedLeafLabel})}`,
                  ...inlineCheckedLeafLines.map((line) => `    ${line}`),
                  blockEnd("  "),
                ] : directCheckedLeafNoThrow ? [
                  stmt(e`  ${out} = ${selfRecursiveMarker}${
                    positionalRawCall};`,
                  // A self-recursive call is respecialized into a direct call
                  // to the generated body after these passes run, against the
                  // operand names recorded here, so those operands are pinned.
                  {kind: "assign", write: out, pinned: site.selfRecursive}),
                ] : [
                  stmt(e`  try { ${out} = ${selfRecursiveMarker}${
                    positionalRawCall}; } catch (${caught}) {`,
                  {pinned: site.selfRecursive}),
                  st`    /*${regionHandlerMarkers.start}*/`,
                  ...materializeCallExceptionLines(
                    callStack, stack, index,
                    callStackDepth,
                    site.selfRecursive ? "false" :
                      operand(e`!${positionalInvoke}.jvmRestoresExceptionFrames`),
                    regionRestoreMarkers,
                  ).map((line) => `    ${line}`),
                  st`    throw ${caught};`,
                  st`    /*${regionHandlerMarkers.end}*/`, blockEnd("  "),
                ]),
                blockEnd(""),
                stmt(e`if (!${usedDirect} || ${inlineCheckedLeafVoid
                  ? e`!${out}`
                  : e`${out} === helpers.asyncInvokeSentinel()`}) {`),
                ...(inlineCheckedLeafLines
                  ? [st`${inlineCheckedLeafFallbackMarker}`]
                  : fallbackLines.map((line) => `  ${line}`)),
                ...(inlineCheckedLeafVoid ? [] : [blockEnd("")]));
              // Publish what a fused hot call-graph region needs in order to
              // link this call site, as compiler-owned tokens rather than as
              // structure to be recovered from the emitted JavaScript. The
              // names below are stable through every later line pass; the
              // operand list and the two exception arms are delimited by
              // token pairs this call emitted, so they are taken by identity
              // from whichever specialized body finally carries them.
              if (!(inlineCheckedLeafLines && receiverGuard === "true")) {
                site.regionLowering = {
                  resultName: out,
                  resultDeclaration: letDecl(out),
                  depthName: callStackDepth,
                  rawCallPrefix: `${positionalRawInvoke}(helpers, `,
                  rawCallSuffix: "thread, true)",
                  nestedRawCallSuffix: "thread, 2)",
                  operandTokens: [...regionOperandTokens],
                  fastCall: inlineCheckedLeafLines || directCheckedLeafNoThrow
                    ? null : {
                      caught,
                      restoreMarkers: {...regionRestoreMarkers},
                      handlerMarkers: {...regionHandlerMarkers},
                    },
                };
              }
            } else {
              lines.push(...fallbackLines);
            }
            lines.push(...asynchronousActiveChildLines,
              st`if (${out} === helpers.asyncInvokeSentinel()) {`,
              ...(resumableVoidCall ? [st`${asynchronousCallMarker}`] : [
                ...materializeLines(callStack, index).map((line) => `  ${line}`),
                st`  helpers.skipJitOnce(frame);`,
                st`  return { deopt: true, transient: true, reason: 'asynchronous structured SSA callee' };`,
              ]), blockEnd(""));
            const deoptCallMarker = named(
              `__JVM_DEOPT_CALL_${index}_${site.id}__`);
            continuationFallbacks.set(deoptCallMarker, {
              continuation: [
                ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                st`  ${out}.structuredResumePc = ${index + 1};`,
                st`  ${out}.structuredResumeOwnsFrame = true;`,
                st`  yield ${out};`,
                st`  ${callStackDepth} = thread.callStack.items.length;`,
                ...(site.returnsVoid ? [] : [
                  st`  ${out} = frame.stack.items.pop();`,
                ]),
              ],
              ordinary: [
                ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                st`  if (frame) ${out}.jvmPositionalChild = frame;`,
                st`  return ${out};`,
              ],
              checkedLeaf: [leafBailStatement()],
            });
            lines.push(st`if (${out} && ${out}.deopt) {`,
              stmt(exprConcat(
                e`  if (frame === null && (${out}.jvmPositionalChild || `,
                e`thread.callStack.items.length > ${callStackDepth})) {`)),
              ...materializeLines(stack, index + 1)
                .map((line) => `    ${line}`),
              blockEnd("  "),
              stmt(exprConcat(
                e`  if (!helpers.linkStructuredCallChild(frame, thread, ${
                  callStackDepth}, ${JSON.stringify(site.returnType)}, `,
                e`undefined, ${out}.jvmPositionalChild)) {`)),
              ...materializeLines(callStack, index).map((line) => `    ${line}`),
              st`    helpers.skipJitOnce(frame);`,
              st`    return ${out};`,
              blockEnd("  "),
              st`${deoptCallMarker}`, blockEnd(""));
            // A callee that left a frame on the stack has not run to
            // completion, whatever it returned. The check above it is reached
            // only for the async sentinel and the one before that only for an
            // explicit deopt, so a callee that pushed its frame and returned
            // an ordinary value fell through every guard: the caller carried
            // on and pushed its next call on top of the untouched child, which
            // then ran against state the later call had already overwritten.
            // The synchronous tier has always checked this unconditionally.
            const leftActiveChildMarker = named(
              `__JVM_LEFT_ACTIVE_CHILD_${index}_${site.id}__`);
            continuationFallbacks.set(leftActiveChildMarker, {
              continuation: [
                ...materializeLines(stack, index + 1).map((line) => `    ${line}`),
                st`    yield { deopt: true, transient: true, structuredResumePc: ${
                  index + 1
                }, structuredResumeOwnsFrame: true, reason: 'structured SSA callee left active child' };`,
                st`    ${callStackDepth} = thread.callStack.items.length;`,
                ...(site.returnsVoid ? [] : [
                  st`    ${out} = frame.stack.items.pop();`,
                ]),
              ],
              ordinary: [
                ...materializeLines(stack, index + 1).map((line) => `    ${line}`),
                stmt(exprConcat(e`    return { deopt: true, transient: true, `,
                  e`reason: 'structured SSA callee left active child', `,
                  e`jvmPositionalChild: frame };`)),
              ],
              checkedLeaf: [leafBailStatement("    ")],
            });
            lines.push(
              stmt(e`/*__JVM_LEFT_ACTIVE_CHILD_WITHDRAW_${index}_${site.id}__*/`,
                {kind: "leftActiveChildWithdraw", pc: index}),
              st`if (thread.callStack.items.length > ${callStackDepth}) {`,
              ...materializeOmittedCallerForChild("  "),
              blockEnd(""),
              st`if (thread.callStack.items.length > ${callStackDepth} &&`,
              st`    helpers.linkStructuredCallChild(frame, thread, ${
                callStackDepth}, ${JSON.stringify(site.returnType)})) {`,
              st`${leftActiveChildMarker}`, blockEnd(""));
            if (deferMaterialization) deferredCallMaterializationCount += 1;
            if (!site.returnsVoid) stack.push(out);
            const yieldedCallMarker = named(
              `__JVM_YIELDED_CALL_${index}_${site.id}__`);
            continuationFallbacks.set(yieldedCallMarker, {
              continuation: [
                ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                st`  yield { deopt: true, transient: true, structuredResumePc: ${
                  index + 1
                }, reason: 'thread yielded in structured SSA callee' };`,
              ],
              ordinary: [
                ...materializeLines(stack, index + 1).map((line) => `  ${line}`),
                stmt(exprConcat(e`  return { deopt: true, transient: true, `,
                  e`reason: 'thread yielded in structured SSA callee', `,
                  e`jvmPositionalChild: frame };`)),
              ],
              checkedLeaf: [leafBailStatement()],
            });
            lines.push(st`if (thread.status !== 'runnable') {`,
              st`${yieldedCallMarker}`, blockEnd(""));
            lines.push(stmt(e`/*${site.regionMarkers.end}*/`,
              {kind: "regionCallEnd", pc: index}));
            if (inlineCheckedLeafVoidFastPath) lines.push(blockEnd(""));
            if (checkedAdmissionEnd) lines.push(checkedAdmissionEnd);
            if (site.selfRecursive) {
              lines.push(st`/*__SSA_SELF_RECURSIVE_REGION_END_${index}__*/`);
            }
          }
        } else if (op === "tableswitch" || op === "lookupswitch") {
          const selector = pop();
          const term = cfg.term[block.id];
          if (selector === null || term?.kind !== "switch" ||
              term.default === null || term.default === undefined ||
              term.cases.some((entry) =>
                entry.target === null || entry.target === undefined) ||
              !edgeLines(term.default, stack) ||
              term.cases.some((entry) => !edgeLines(entry.target, stack))) {
            valid = false;
          } else {
            plans[block.id] = {
              lines, selector, cases: term.cases,
              defaultTarget: term.default, stack: [...stack],
            };
          }
        } else if (op === "goto" || op === "goto_w") {
          const edge = edgeLines(cfg.term[block.id].target, stack);
          if (!edge) valid = false; else lines.push(...edge);
        } else if (op.startsWith("if")) {
          if (prunedBooleanBranchTargets.has(index)) {
            const input = pop();
            const target = prunedBooleanBranchTargets.get(index);
            const edge = input === null ? null : edgeLines(target, stack);
            if (!edge) valid = false;
            else {
              lines.push(...edge);
              plans[block.id] = {
                lines, returnKind, returnValue, stack: [...stack],
              };
            }
            continue;
          }
          const target = cfg.term[block.id].taken;
          const fall = cfg.term[block.id].fall;
          if (op.startsWith("if_icmp") || op.startsWith("if_acmp")) {
            const right = pop(), left = pop();
            const cmp = { if_icmpeq: "===", if_icmpne: "!==", if_icmplt: "<",
              if_icmpge: ">=", if_icmpgt: ">", if_icmple: "<=",
              if_acmpeq: "===", if_acmpne: "!==" }[op];
            if (left === null || right === null || !cmp) valid = false;
            else {
              condition = operand(e`${left} ${cmp} ${right}`);
              comparison = {left, right, cmp};
              if (cmp === "!==") {
                negatedCondition = operand(e`${left} === ${right}`);
                negatedComparison = {left, right, cmp: "==="};
              }
              const literal = (expression) => /^-?\d+$/.test(expression)
                ? Number(expression) : expression === "null" ? null : undefined;
              const a = literal(left), b = literal(right);
              if (a !== undefined && b !== undefined) {
                conditionConstant = cmp === "===" ? a === b : cmp === "!==" ? a !== b
                  : cmp === "<" ? a < b : cmp === ">=" ? a >= b
                    : cmp === ">" ? a > b : a <= b;
              }
            }
          } else {
            const input = pop();
            const cmp = { ifeq: "=== 0", ifne: "!== 0", iflt: "< 0", ifge: ">= 0",
              ifgt: "> 0", ifle: "<= 0", ifnull: "=== null", ifnonnull: "!== null" }[op];
            if (input === null || !cmp) valid = false;
            else {
              condition = operand(e`${input} ${cmp}`);
              comparison = {input, cmp};
              if (op === "ifne") {
                negatedCondition = operand(e`${input} === 0`);
                negatedComparison = {input, cmp: "=== 0"};
              } else if (op === "ifnonnull") {
                negatedCondition = operand(e`${input} === null`);
                negatedComparison = {input, cmp: "=== null"};
              }
              if (/^-?\d+$/.test(input)) {
                const number = Number(input);
                conditionConstant = op === "ifeq" ? number === 0 : op === "ifne" ? number !== 0
                  : op === "iflt" ? number < 0 : op === "ifge" ? number >= 0
                    : op === "ifgt" ? number > 0 : op === "ifle" ? number <= 0 : null;
              } else if (input === "null") {
                if (op === "ifnull") conditionConstant = true;
                else if (op === "ifnonnull") conditionConstant = false;
              }
            }
          }
          if (!valid || !edgeLines(target, stack) || !edgeLines(fall, stack)) valid = false;
          else plans[block.id] = {
            lines, condition, negatedCondition, conditionConstant,
            comparison, negatedComparison,
            taken: target, fall, stack: [...stack],
          };
        } else if (op === "athrow") {
          const thrown = pop();
          if (thrown === null) valid = false;
          else {
            lines.push(...materializeLines([...stack, thrown], index),
              st`throw ${thrown};`);
            returnKind = "throw";
          }
        } else if (op === "ireturn" || op === "areturn" || op === "dreturn" ||
            op === "freturn" || op === "lreturn") {
          returnValue = pop();
          if (returnValue === null || stack.length !== 0) valid = false;
          else {
            returnKind = "value";
            returnIndex = index;
          }
        }
        else if (op === "return") {
          if (stack.length !== 0) valid = false;
          else {
            returnKind = "void";
            returnIndex = index;
          }
        }
        else valid = false;
        if (!valid) { invalidAt = { index, op }; break; }
      }
      if (!valid) return reject(`unsupported or invalid ${invalidAt?.op || "instruction"} at ${invalidAt?.index}`);
      if (!plans[block.id]) {
        const term = cfg.term[block.id];
        if (term.kind === "fall") {
          const edge = edgeLines(term.target, stack);
          if (!edge) return reject(`invalid fall edge from block ${block.id}`);
          lines.push(...edge);
        }
        plans[block.id] = {
          lines, returnKind, returnValue, returnIndex, stack: [...stack],
        };
      }
    }

    // Generator continuations preserve lexical SSA locals across a cooperative
    // browser yield. Guarded static constants are rechecked before resuming;
    // if another Java thread changed one, the exact materialized bytecode state
    // resumes in the baseline body instead of re-entering stale lexical state.
    let useContinuations = this.continuationsEnabled &&
      structured.loopHeaders.size > 0;
    if ([...callSites.values()].some((site) =>
      Array.isArray(site.directCheckedLeaf?.captures) &&
      site.directCheckedLeaf.captures.length > 0)) {
      // Captured non-volatile child statics are stable for one synchronous
      // scheduler slice. If this caller reaches a safe point, resume through
      // the canonical frame so the next execution snapshots fresh values.
      useContinuations = false;
    }
    const guardedStaticBooleanStateMatches = () => {
      for (const direct of guardedStaticBooleanSites.values()) {
        const target = directTargetFor(direct);
        if (!target) return false;
        const raw = target.kind === "map"
          ? target.fields.get(target.key) : target.fields[target.key];
        if ((raw ? 1 : 0) !== direct.guardedBooleanValue) return false;
      }
      return true;
    };
    const readEagerArrayField = (cache, object) => {
      if (object === null || object === undefined) return undefined;
      if (Number.isInteger(cache.denseSlot) && Array.isArray(object.fields)) {
        return object.fields[cache.denseSlot];
      }
      if (cache.directKey && object.fields &&
          object.fields[cache.directKey] !== undefined) {
        return object.fields[cache.directKey];
      }
      try {
        return this.jit.getFieldAt(cache.site, object);
      } catch (_) {
        return undefined;
      }
    };
    const readEntryStaticArray = (cache) => {
      const target = cache.direct
        ? this.jit.directStaticTargets[cache.direct.targetId]
        : this.jit.fieldSites[cache.lazy?.site]?.staticTarget;
      if (!target) return { target: null, value: undefined };
      const value = target.kind === "map"
        ? target.fields.get(target.key) : target.fields[target.key];
      return { target, value };
    };
    const directFieldValueExpression = (cache, object) =>
      Number.isInteger(cache.denseSlot)
        ? exprConcat(
          e`(Array.isArray(${object}.fields) ? `,
          e`${object}.fields[${cache.denseSlot}] : `,
          e`${object}.fields[${JSON.stringify(cache.directKey)}])`)
        : e`${object}.fields[${JSON.stringify(cache.directKey)}]`;
    const guardedDirectFieldReadExpression = (cache, object) => exprConcat(
      e`(${object}.fields && `,
      e`(Array.isArray(${object}.fields) || `,
      e`${object}.fields[${JSON.stringify(cache.directKey)}] !== undefined) ? `,
      e`${directFieldValueExpression(cache, object)} : `,
      e`helpers.getFieldAt(${cache.site}, ${object}))`);
    const fieldBackedArrayGuards = [
      ...[...fieldReadCaches.values()]
        .filter((cache) => cache.isArray &&
          cache.eagerLocal !== null && cache.eagerLocal !== undefined)
        .map((cache) => ({ kind: "field", cache })),
      ...[...entryStaticReadCaches.values()]
        .filter((cache) => cache.data)
        .map((cache) => ({ kind: "static", cache })),
    ];
    const captureFieldBackedArrayState = (frame) => {
      if (fieldBackedArrayRangeCandidateCount === 0) return null;
      return fieldBackedArrayGuards.map((guard) => {
        if (guard.kind === "field") {
          const object = frame.locals[guard.cache.eagerLocal];
          return { object, value: readEagerArrayField(guard.cache, object) };
        }
        return readEntryStaticArray(guard.cache);
      });
    };
    const fieldBackedArrayStateMatches = (state) => {
      if (fieldBackedArrayRangeCandidateCount === 0) return true;
      if (!Array.isArray(state) ||
          state.length !== fieldBackedArrayGuards.length) return false;
      return fieldBackedArrayGuards.every((guard, index) => {
        const expected = state[index];
        if (guard.kind === "field") {
          const object = expected?.object;
          return object !== null && object !== undefined &&
            readEagerArrayField(guard.cache, object) === expected.value;
        }
        const current = readEntryStaticArray(guard.cache);
        return current.target === expected?.target &&
          current.value === expected?.value;
      });
    };
    const invalidateFieldCacheLines = [...fieldReadCaches.values()]
      .filter((cache) =>
        cache.eagerLocal === null || cache.eagerLocal === undefined)
      .flatMap((cache) => [
        st`${cache.valid} = false;`,
        st`${cache.object} = null;`,
        ...(cache.isArray ? [st`${cache.data} = null;`] : []),
      ]);
    const refreshEagerFieldCacheLines = [...fieldReadCaches.values()]
      .filter((cache) =>
        cache.eagerLocal !== null && cache.eagerLocal !== undefined)
      .flatMap((cache) => [
        stmt(exprConcat(
          e`if (${localName(cache.eagerLocal)} !== null && `,
          e`${localName(cache.eagerLocal)} !== undefined) {`)),
        stmt(e`  ${cache.value} = ${cache.directKey
          ? guardedDirectFieldReadExpression(
            cache, localName(cache.eagerLocal))
          : e`helpers.getFieldAt(${cache.site}, ${
            localName(cache.eagerLocal)})`};`),
        ...(cache.isArray ? [
          stmt(e`  ${cache.data} = ${arrayDataExpr(cache.value)};`),
        ] : []),
        blockEnd(""),
      ]);
    const refreshEntryStaticCacheLines =
      [...entryStaticReadCaches.values()].flatMap((cache) => {
        if (cache.lazy) {
          const lazy = cache.lazy;
          const read = exprConcat(
            e`${lazy.variable}.cell ? ${lazy.variable}.cell.value : `,
            e`${lazy.variable}.kind === "map" ? `,
            e`${lazy.variable}.fields.get(${lazy.variable}.key) : `,
            e`${lazy.variable}.fields[${lazy.variable}.key]`);
          return [
            st`${lazy.variable} = helpers.fieldSites[${lazy.site}].staticTarget;`,
            st`${cache.valid} = Boolean(${lazy.variable});`,
            stmt(e`${cache.value} = ${cache.valid} ? ${read} : undefined;`),
            ...(cache.data
              ? [stmt(exprConcat(e`${cache.data} = ${cache.valid} ? `,
                e`${arrayDataExpr(cache.value)} : null;`))]
              : []),
          ];
        }
        const direct = cache.direct;
        const fields =
          e`helpers.directStaticTargets[${direct.targetId}].fields`;
        const read = direct.cell
          ? exprConcat(
            e`helpers.directStaticTargets[${direct.targetId}].cell.value`,
            e` /* ${direct.key} */`)
          : direct.kind === "map"
            ? e`${fields}.get(${JSON.stringify(direct.key)})`
            : e`${fields}[${JSON.stringify(direct.key)}]`;
        return [
          stmt(e`${cache.value} = ${read};`),
          ...(cache.data
            ? [stmt(e`${cache.data} = ${arrayDataExpr(cache.value)};`)]
            : []),
        ];
      });
    const constantInstructionValue = (instruction) => {
      const op = opOf(instruction);
      if (/^iconst_(?:m1|[0-5])$/.test(op)) {
        return op === "iconst_m1" ? -1 : Number(op.slice(-1));
      }
      if (op === "bipush" || op === "sipush" ||
          op === "ldc" || op === "ldc_w") {
        const raw = instruction && typeof instruction === "object"
          ? instruction.arg : undefined;
        const resolved = raw && typeof raw === "object" &&
          Object.prototype.hasOwnProperty.call(raw, "value") ? raw.value : raw;
        const number = Number(resolved);
        return Number.isInteger(number) ? number | 0 : null;
      }
      return null;
    };
    const countedLoopInfo = (node) => {
      if (!node || node.t !== "loop") return null;
      const header = Number(node.label.slice(1));
      const block = cfg.blocks[header];
      if (!block || block.synthetic || cfg.term[header]?.kind !== "cond") return null;
      const headerInstructions = block.insns
        .map((index) => items[index]?.instruction).filter(Boolean);
      if (headerInstructions.length < 2) return null;
      const branch = headerInstructions[headerInstructions.length - 1];
      const branchOp = opOf(branch);
      let bound = null;
      let boundSlot = null;
      let boundExpression = null;
      let loadInstruction = null;
      const bodyOnTaken = branchOp === "iflt" || branchOp === "if_icmplt";
      if (branchOp === "ifge" || branchOp === "iflt") {
        bound = 0;
        boundExpression = "0";
        loadInstruction = headerInstructions[headerInstructions.length - 2];
      } else if ((branchOp === "if_icmpge" || branchOp === "if_icmplt") &&
          headerInstructions.length >= 3) {
        const boundItemIndex =
          block.insns[block.insns.length - 2];
        const boundInstruction =
          headerInstructions[headerInstructions.length - 2];
        bound = constantInstructionValue(boundInstruction);
        if (bound !== null) {
          boundExpression = String(bound);
        } else {
        const boundOp = opOf(boundInstruction);
        if (/^iload(?:_[0-3])?$/.test(boundOp)) {
            boundSlot = localIndex(boundInstruction, boundOp);
            if (!Number.isInteger(boundSlot)) return null;
            boundExpression = localName(boundSlot);
          } else if (boundOp === "getstatic") {
            // An entry-snapshotted, read-only scalar static is as invariant
            // as an unmodified bound local for this generated invocation.
            // This admits ordinary raster/codec row loops whose dimensions
            // javac reads directly from a static field at the header.
            const direct = directStaticSites.get(boundItemIndex);
            if (!direct?.entryReadCache?.value ||
                direct.descriptor !== "I") return null;
            boundExpression = direct.entryReadCache.value;
          } else if (boundOp === "arraylength" &&
              headerInstructions.length >= 4) {
            const arrayInstruction =
              headerInstructions[headerInstructions.length - 3];
            const arrayOp = opOf(arrayInstruction);
            if (!/^aload(?:_[0-3])?$/.test(arrayOp)) return null;
            const arraySlot = localIndex(arrayInstruction, arrayOp);
            const view = entryFieldArrayLocalViews.get(arraySlot);
            if (!Number.isInteger(arraySlot) ||
                assignedReferenceLocals.has(arraySlot) && !view) return null;
            const arrayData = entryArrayLocalSlots.has(arraySlot)
              ? entryArrayDataVariable(arraySlot) : view?.data;
            if (!arrayData || !guardedEntryArrayData.has(arrayData)) {
              return null;
            }
            boundExpression = unconditionallyNonNullEntryArrayData.has(arrayData)
              ? operand(e`${arrayData}.length`)
              : operand(
                e`(${arrayData} === null ? 0 : ${arrayData}.length)`);
            loadInstruction =
              headerInstructions[headerInstructions.length - 4];
          } else {
            return null;
          }
        }
        if (!loadInstruction) {
          loadInstruction = headerInstructions[headerInstructions.length - 3];
        }
      } else {
        return null;
      }
      const loadOp = opOf(loadInstruction);
      if (!/^iload(?:_[0-3])?$/.test(loadOp)) return null;
      const slot = localIndex(loadInstruction, loadOp);
      if (!Number.isInteger(slot) || !boundExpression ||
          boundSlot === slot) return null;

      const predecessors = [];
      for (let candidate = 0; candidate < cfg.n; candidate += 1) {
        if ((cfg.succ[candidate] || []).includes(header)) predecessors.push(candidate);
      }
      const headerItem = block.insns[0];
      const backedges = predecessors.filter((candidate) =>
        cfg.blocks[candidate].insns[0] >= headerItem);
      const preheaders = predecessors.filter((candidate) =>
        cfg.blocks[candidate].insns[0] < headerItem);
      if (preheaders.length !== 1 || backedges.length !== 1) return null;
      // Recover the natural-loop blocks by walking predecessors backward from
      // the unique bytecode backedge. Lexical structuring also contains exit
      // arms (for example an inner-loop exit that continues its outer loop),
      // so collecting the printed subtree would incorrectly classify exits
      // as part of the inner loop.
      const allPredecessors = Array.from({ length: cfg.n }, () => []);
      for (let candidate = 0; candidate < cfg.n; candidate += 1) {
        for (const successor of cfg.succ[candidate] || []) {
          allPredecessors[successor].push(candidate);
        }
      }
      const loopBlocks = new Set([header, backedges[0]]);
      const work = [backedges[0]];
      while (work.length) {
        const current = work.pop();
        for (const predecessor of allPredecessors[current]) {
          if (loopBlocks.has(predecessor)) continue;
          loopBlocks.add(predecessor);
          if (predecessor !== header) work.push(predecessor);
        }
      }
      const term = cfg.term[header];
      // Accept both equivalent layouts emitted by javac. Small exit arms are
      // normally `counter >= bound -> exit`; when the exit arm is much larger
      // than the loop body javac inverts it to `counter < bound -> body` and
      // places the exit on fall-through. The induction proof is identical.
      if (bodyOnTaken
        ? (!loopBlocks.has(term.taken) || loopBlocks.has(term.fall))
        : (loopBlocks.has(term.taken) || !loopBlocks.has(term.fall))) {
        return null;
      }

      let initial = null;
      const preheaderInsns = cfg.blocks[preheaders[0]].insns;
      for (let position = 1; position < preheaderInsns.length; position += 1) {
        const store = items[preheaderInsns[position]]?.instruction;
        const storeOp = opOf(store);
        if (!/^istore(?:_[0-3])?$/.test(storeOp) ||
            localIndex(store, storeOp) !== slot) continue;
        initial = constantInstructionValue(
          items[preheaderInsns[position - 1]]?.instruction);
      }
      let increment = null;
      let writes = 0;
      let incrementBlock = null;
      let boundWrites = 0;
      const writtenSlots = new Set();
      for (const loopBlock of loopBlocks) {
        for (const itemIndex of cfg.blocks[loopBlock].insns) {
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          const writtenSlot = op === "iinc"
            ? Number(instruction.varnum ?? instruction.arg)
            : /^istore(?:_[0-3])?$/.test(op)
              ? localIndex(instruction, op) : null;
          if (Number.isInteger(writtenSlot)) writtenSlots.add(writtenSlot);
          if (boundSlot !== null && writtenSlot === boundSlot) {
            boundWrites += 1;
          }
          if (op === "iinc" && Number(instruction.varnum ?? instruction.arg) === slot) {
            writes += 1;
            increment = Number(instruction.incr ?? 0);
            incrementBlock = loopBlock;
          } else if (/^istore(?:_[0-3])?$/.test(op) &&
              localIndex(instruction, op) === slot) {
            writes += 1;
          }
        }
      }
      // Obfuscator guards often put a side-effect-free branch between the
      // unique induction update and the literal CFG backedge. Require the
      // update to dominate every backedge path inside the natural loop,
      // rather than requiring both bytecodes to share one basic block.
      const reachesBackedgeWithoutIncrement = (backedge) => {
        if (incrementBlock === header || incrementBlock === backedge) {
          return false;
        }
        const pending = [header];
        const visited = new Set();
        while (pending.length) {
          const current = pending.pop();
          if (current === incrementBlock || visited.has(current)) continue;
          if (current === backedge) return true;
          visited.add(current);
          for (const successor of cfg.succ[current] || []) {
            if (loopBlocks.has(successor)) pending.push(successor);
          }
        }
        return false;
      };
      const incrementDominatesBackedges =
        Number.isInteger(incrementBlock) &&
        backedges.every((backedge) =>
          !reachesBackedgeWithoutIncrement(backedge));
      if (writes !== 1 || !incrementDominatesBackedges ||
          boundWrites !== 0 || !Number.isInteger(increment) ||
          increment <= 0) return null;
      return {
        header, slot, bound, boundSlot, boundExpression, increment, initial,
        loopBlocks, writtenSlots, backedges, preheader: preheaders[0],
        bodyOnTaken,
      };
    };
    const countedLoopTripCount = (node) => {
      const info = countedLoopInfo(node);
      if (!info || !Number.isInteger(info.bound) ||
          info.initial === null || info.initial >= info.bound) {
        return null;
      }
      const {bound, initial, increment} = info;
      const trips = Math.ceil((bound - initial) / increment);
      return trips > 0 && trips <= 4096 ? trips : null;
    };
    const allCountedLoops = new Map();
    const countedLoopInfos = new Map();
    const countedLoopDepths = new Map();
    const coarseCountedLoops = new Map();
    const runtimeCoarseCountedLoops = new Map();
    const checkedLeafCoarseLoopHeaders = new Set();
    // A scanline, codec row, audio block, or similar counted inner loop often
    // has several hundred iterations. Charge its verified runtime trip count
    // once against the shared scheduler budget, then omit the branch from the
    // loop body. The 1024-trip ceiling itself bounds the largest branch-free
    // chunk. It may exceed the remaining abstract backedge budget; charging
    // it makes the next eligible loop poll immediately without fragmenting a
    // small scanline/audio block into hundreds of generator resumptions.
    // A method that can become the root of a bounded call-graph region has a
    // much larger, independently finite operation quantum. Do not reject a
    // verified call-free subloop merely because its runtime trip count is
    // larger than the method-at-a-time scanline limit: that rejection
    // materializes the whole graph and permanently resumes the activation in
    // the fallback tier. Calls and effectful loops retain their ordinary poll
    // analysis below; only the already-proven counted subloop uses this limit.
    const runtimeCoarseTripLimit =
      this.jit.hotCallGraphRegions?.enabled && callSites.size > 0 &&
        !hasSelfRecursiveCall
        ? this.jit.hotCallGraphRegions.directSafePointBudget
        : 1024;
    // A float-sample to byte-array conversion is a common boundary between a
    // decoder and an audio/image consumer.  Once its counted bounds and array
    // accesses have been proven, polling every scalar iteration is much more
    // expensive than the conversion itself and can materialize an otherwise
    // compiled caller at a mid-method PC.  Admit a finite, larger atomic
    // quantum for this bytecode shape without relying on guest class names.
    const runtimeCoarseTripLimitFor = (info) => {
      if (!info?.loopBlocks) return runtimeCoarseTripLimit;
      const ops = new Set();
      for (const block of info.loopBlocks) {
        for (const itemIndex of cfg.blocks[block]?.insns || []) {
          ops.add(opOf(items[itemIndex]?.instruction));
        }
      }
      return ops.has("faload") && ops.has("f2i") && ops.has("bastore")
        ? Math.max(runtimeCoarseTripLimit, 1_000_000)
        : runtimeCoarseTripLimit;
    };
    const containsLoop = (node) => {
      if (!node) return false;
      if (node.t === "loop") return true;
      if (node.t === "seq") return node.body.some(containsLoop);
      if (node.t === "if") {
        return containsLoop(node.then) || containsLoop(node.els);
      }
      if (node.t === "switch") {
        return node.cases.some((entry) => containsLoop(entry.body)) ||
          containsLoop(node.dflt);
      }
      if (node.t === "block") return containsLoop(node.body);
      return false;
    };
    const findNestedCountedLoops = (node, loopDepth = 0) => {
      if (!node) return;
      if (node.t === "loop") {
        const info = countedLoopInfo(node);
        const trips = countedLoopTripCount(node);
        const header = Number(node.label.slice(1));
        countedLoopDepths.set(header, loopDepth);
        if (info) countedLoopInfos.set(header, info);
        if (trips) allCountedLoops.set(header, trips);
        if (trips && loopDepth > 0 && this.coarseCountedLoopSafePointsEnabled) {
          coarseCountedLoops.set(header, trips);
        } else if (info &&
            (loopDepth > 0 || !containsLoop(node.body)) &&
            this.coarseCountedLoopSafePointsEnabled) {
          const tripLimit = runtimeCoarseTripLimitFor(info);
          runtimeCoarseCountedLoops.set(header, {
            ...info,
            variable: pureRangeTemporary(
              compactable(named(`ssaRuntimeCoarseLoop${header}`))),
            tripsVariable: pureRangeTemporary(
              compactable(named(`ssaRuntimeCoarseTrips${header}`))),
            tripsExpression: operand(exprConcat(
              e`(${localName(info.slot)} >= ${info.boundExpression} ? 0 : `,
              info.increment === 1
                ? e`(${info.boundExpression} - ${localName(info.slot)})`
                : exprConcat(
                  e`Math.ceil((${info.boundExpression} - ${
                    localName(info.slot)}) / `,
                  e`${info.increment})`),
              e`)`)),
            condition: operand(exprConcat(
              e`${pureRangeTemporary(compactable(named(
                `ssaRuntimeCoarseTrips${header}`)))} <= `,
              e`${tripLimit}`,
              info.increment === 1 ? "" : exprConcat(
                e` && ${localName(info.slot)} <= 2147483647 - `,
                e`${pureRangeTemporary(compactable(named(
                `ssaRuntimeCoarseTrips${header}`)))} * ${
                  info.increment}`))),
          });
        }
        findNestedCountedLoops(node.body, loopDepth + 1);
      } else if (node.t === "seq") {
        node.body.forEach((child) => findNestedCountedLoops(child, loopDepth));
      } else if (node.t === "if") {
        findNestedCountedLoops(node.then, loopDepth);
        findNestedCountedLoops(node.els, loopDepth);
      } else if (node.t === "switch") {
        node.cases.forEach((entry) =>
          findNestedCountedLoops(entry.body, loopDepth));
        findNestedCountedLoops(node.dflt, loopDepth);
      } else if (node.t === "block") {
        findNestedCountedLoops(node.body, loopDepth);
      }
    };
    findNestedCountedLoops(structured.tree);
    const allCfgPredecessors = Array.from({length: cfg.n}, () => []);
    for (let block = 0; block < cfg.n; block += 1) {
      for (const successor of cfg.succ[block] || []) {
        allCfgPredecessors[successor].push(block);
      }
    }
    const naturalLoopBlocksFor = (header) => {
      const headerItem = cfg.blocks[header]?.insns?.[0];
      if (!Number.isInteger(headerItem)) return null;
      const backedges = allCfgPredecessors[header].filter((predecessor) =>
        cfg.blocks[predecessor]?.insns?.[0] >= headerItem);
      if (backedges.length !== 1) return null;
      const loopBlocks = new Set([header, backedges[0]]);
      const pending = [backedges[0]];
      while (pending.length) {
        const current = pending.pop();
        for (const predecessor of allCfgPredecessors[current]) {
          if (loopBlocks.has(predecessor)) continue;
          loopBlocks.add(predecessor);
          if (predecessor !== header) pending.push(predecessor);
        }
      }
      return loopBlocks;
    };
    const postDecrementLoopInfos = new Map();
    for (const header of structured.loopHeaders) {
      const block = cfg.blocks[header];
      const blockItems = block?.insns || [];
      if (blockItems.length < 3 || cfg.term[header]?.kind !== "cond") continue;
      const load = items[blockItems[blockItems.length - 3]]?.instruction;
      const decrement = items[blockItems[blockItems.length - 2]]?.instruction;
      const branch = items[blockItems[blockItems.length - 1]]?.instruction;
      const loadOp = opOf(load);
      const slot = /^iload(?:_[0-3])?$/.test(loadOp)
        ? localIndex(load, loadOp) : null;
      if (!Number.isInteger(slot) || opOf(decrement) !== "iinc" ||
          Number(decrement.varnum ?? decrement.arg) !== slot ||
          Number(decrement.incr ?? 0) !== -1 || opOf(branch) !== "ifle") {
        continue;
      }
      const loopBlocks = naturalLoopBlocksFor(header);
      const term = cfg.term[header];
      if (!loopBlocks || loopBlocks.has(term.taken) ||
          !loopBlocks.has(term.fall)) continue;
      const writtenSlots = new Set();
      for (const loopBlock of loopBlocks) {
        for (const itemIndex of cfg.blocks[loopBlock]?.insns || []) {
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          const writtenSlot = op === "iinc"
            ? Number(instruction.varnum ?? instruction.arg)
            : /^istore(?:_[0-3])?$/.test(op)
              ? localIndex(instruction, op) : null;
          if (Number.isInteger(writtenSlot)) writtenSlots.add(writtenSlot);
        }
      }
      postDecrementLoopInfos.set(header, {
        header, slot, loopBlocks, writtenSlots,
        postDecrement: true, increment: 1, initial: null,
        bound: 0, boundSlot: null, boundExpression: "0",
      });
      if (this.coarseCountedLoopSafePointsEnabled) {
        runtimeCoarseCountedLoops.set(header, {
          header, slot, loopBlocks, writtenSlots, postDecrement: true,
          variable: pureRangeTemporary(
            compactable(named(`ssaRuntimeCoarseLoop${header}`))),
          tripsVariable: pureRangeTemporary(
            compactable(named(`ssaRuntimeCoarseTrips${header}`))),
          tripsExpression: operand(e`Math.max(0, ${localName(slot)})`),
          condition: operand(exprConcat(
            e`${pureRangeTemporary(compactable(named(
              `ssaRuntimeCoarseTrips${header}`)))} <= `,
            e`${runtimeCoarseTripLimit}`)),
        });
      }
    }
    const boundedIterationProduct = [...allCountedLoops.values()]
      .reduce((product, trips) => product * trips, 1);
    const isAtomicUnsafeOperation = (item, index) => {
      if (!normalReachableItems.has(index)) return false;
      const op = opOf(item?.instruction);
      // A verified integer leaf is emitted as straight-line scalar
      // JavaScript; it creates no child frame, scheduler boundary, heap
      // effect, or throwing operation. Do not let its original invoke
      // bytecode fragment an otherwise bounded numeric loop.
      const emittedIntegerLeaf = op?.startsWith("invoke") &&
        Boolean(callSites.get(index)?.inline);
      const emittedCheckedLeaf = op?.startsWith("invoke") &&
        callSites.get(index)?.directCheckedLeaf?.noThrow === true &&
        Boolean(callSites.get(index)?.directCheckedLeaf?.inlineBody);
      return op && ((!emittedIntegerLeaf && !emittedCheckedLeaf &&
        op.startsWith("invoke")) ||
        op === "monitorenter" ||
        op === "monitorexit" || op === "athrow" || op === "new" ||
        op === "newarray" || op === "anewarray" ||
        op === "multianewarray");
    };
    const hasAtomicUnsafeOperation = items.some(isAtomicUnsafeOperation);
    const loopHasAtomicUnsafeOperation = (info) =>
      [...info.loopBlocks].some((block) =>
        cfg.blocks[block].insns.some((index) =>
          isAtomicUnsafeOperation(items[index], index)));
    // Coarsening is safe for throughput only when the complete method is a
    // bounded numeric kernel. In an effectful method, one "counted" inner loop
    // can still contain a very large data-dependent unit of work (asset
    // decoding is a common example). Let those inner loops retain their own
    // scheduler polls so an outer backedge is not the first observable point
    // after hundreds of milliseconds.
    if (hasAtomicUnsafeOperation) {
      for (const header of coarseCountedLoops.keys()) {
        const info = countedLoopInfos.get(header);
        if (!info || loopHasAtomicUnsafeOperation(info)) {
          coarseCountedLoops.delete(header);
        }
      }
      for (const [header, info] of runtimeCoarseCountedLoops) {
        if (loopHasAtomicUnsafeOperation(info)) {
          runtimeCoarseCountedLoops.delete(header);
        }
      }
    }
    if (!hasAtomicUnsafeOperation && this.coarseCountedLoopSafePointsEnabled) {
      for (const [header, info] of countedLoopInfos) {
        if (coarseCountedLoops.has(header) ||
            runtimeCoarseCountedLoops.has(header)) continue;
        runtimeCoarseCountedLoops.set(header, {
          ...info,
          variable: pureRangeTemporary(
            compactable(named(`ssaRuntimeCoarseLoop${header}`))),
          tripsVariable: pureRangeTemporary(
            compactable(named(`ssaRuntimeCoarseTrips${header}`))),
          tripsExpression: operand(exprConcat(
            e`(${localName(info.slot)} >= ${info.boundExpression} ? 0 : `,
            info.increment === 1
              ? e`(${info.boundExpression} - ${localName(info.slot)})`
              : exprConcat(
                e`Math.ceil((${info.boundExpression} - ${
                  localName(info.slot)}) / `,
                e`${info.increment})`),
            e`)`)),
          condition: operand(exprConcat(
            e`${pureRangeTemporary(compactable(named(
              `ssaRuntimeCoarseTrips${header}`)))} <= ${
              runtimeCoarseTripLimit}`,
            info.increment === 1 ? "" : exprConcat(
              e` && ${localName(info.slot)} <= 2147483647 - `,
              e`${pureRangeTemporary(compactable(named(
                `ssaRuntimeCoarseTrips${header}`)))} * ${
                info.increment}`))),
        });
      }
    }
    // Method-wide static caching must stop at an unknown call, but that does
    // not make every nested numeric loop unsafe.  For a verified counted loop
    // that executes atomically and contains no call or matching putstatic,
    // snapshot an initialized primitive-array reference and its raw storage in
    // the loop preheader.  The snapshot is refreshed on every outer entry, so
    // calls before or after the loop retain ordinary Java visibility.  This is
    // loop/effect analysis over resolved field identities; guest names and
    // generated-source text do not participate.
    if (this.loopInvariantStaticArrayViewsEnabled) {
      const atomicLoopInfos = [...new Set([
        ...coarseCountedLoops.keys(),
        ...runtimeCoarseCountedLoops.keys(),
      ])].map((header) => [header, countedLoopInfos.get(header) ||
        postDecrementLoopInfos.get(header) ||
        runtimeCoarseCountedLoops.get(header)]).filter(([, info]) =>
        info?.loopBlocks);
      const loopContainsInvalidation = (info, direct) => {
        for (const block of info.loopBlocks) {
          for (const itemIndex of cfg.blocks[block]?.insns || []) {
            const instruction = items[itemIndex]?.instruction;
            const op = opOf(instruction);
            if (op?.startsWith("invoke") || op === "monitorenter" ||
                op === "monitorexit" || op === "athrow") return true;
            if (op !== "putstatic") continue;
            const write = directStaticSites.get(itemIndex);
            if (!write || directLocationEquals(direct, write)) return true;
          }
        }
        return false;
      };
      let nextLoopStaticView = 0;
      for (const [itemIndex, direct] of directStaticSites) {
        if (direct.op !== "getstatic" ||
            direct.entryReadCache ||
            !directStaticEmissionsByItem.has(itemIndex) ||
            !/^\[(?:Z|B|C|S|I|F|D|J)$/.test(direct.descriptor || "") ||
            !this.jit.canEliminateFieldRead(
              items[itemIndex]?.instruction?.arg)) continue;
        const candidates = atomicLoopInfos.filter(([, info]) =>
          [...info.loopBlocks].some((block) =>
            (cfg.blocks[block]?.insns || []).includes(itemIndex)) &&
          !loopContainsInvalidation(info, direct)).sort((left, right) =>
          left[1].loopBlocks.size - right[1].loopBlocks.size);
        if (!candidates.length) continue;
        const [header] = candidates[0];
        const location = `${direct.className}\0${direct.key}`;
        let views = loopInvariantStaticArrayViewsByHeader.get(header);
        if (!views) {
          views = new Map();
          loopInvariantStaticArrayViewsByHeader.set(header, views);
        }
        let view = views.get(location);
        if (!view) {
          const number = nextLoopStaticView++;
          view = {
            direct,
            descriptor: direct.descriptor,
            value: named(`ssaLoopStaticArrayValue${number}`),
            data: named(`ssaLoopStaticArrayData${number}`),
          };
          views.set(location, view);
        }
        loopInvariantStaticArrayViewsByItem.set(itemIndex, view);
      }
      for (const [itemIndex, view] of loopInvariantStaticArrayViewsByItem) {
        const emission = directStaticEmissionsByItem.get(itemIndex);
        if (!emission) continue;
        emission.lines[emission.start] =
          constDecl(emission.value, e`${view.value}`);
        if (emission.data) {
          emission.lines[emission.start + 1] =
            constDecl(emission.data, e`${view.data}`);
        }
      }
    }
    const shrinkingArrayWindowLeaf = (() => {
      if ((code.code.exceptionTable || []).length !== 0 ||
          callSites.size !== 0 || entryArrayLocalSlots.size !== 1) return null;
      const arraySlot = [...entryArrayLocalSlots][0];
      if (assignedReferenceLocals.has(arraySlot) ||
          !entryArrayKinds.has(arraySlot)) return null;
      const arrayData = entryArrayDataVariable(arraySlot);
      const primitiveArrayOps = new Set([
        "iaload", "saload", "baload", "caload", "daload", "faload",
        "laload", "iastore", "sastore", "bastore", "castore",
        "dastore", "fastore", "lastore",
      ]);
      const forbiddenOps = new Set([
        "getfield", "putfield", "getstatic", "putstatic", "arraylength",
        "idiv", "irem", "athrow", "new", "newarray", "anewarray",
        "multianewarray", "monitorenter", "monitorexit", "checkcast",
        "instanceof", "aaload", "aastore",
      ]);
      const reachablePrimitiveItems = [];
      for (let index = 0; index < items.length; index += 1) {
        if (!normalReachableItems.has(index)) continue;
        const op = opOf(items[index]?.instruction);
        if (op?.startsWith("invoke") || forbiddenOps.has(op)) return null;
        if (primitiveArrayOps.has(op)) reachablePrimitiveItems.push(index);
      }
      if (reachablePrimitiveItems.length === 0 ||
          primitiveArrayAccessCandidates.length !==
            reachablePrimitiveItems.length ||
          primitiveArrayAccessCandidates.some((access) =>
            access.arrayData !== arrayData ||
            !reachablePrimitiveItems.includes(access.itemIndex))) return null;

      const loadSlot = (instruction) => {
        const op = opOf(instruction);
        return /^iload(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const storeSlot = (instruction) => {
        const op = opOf(instruction);
        if (op === "iinc") return Number(instruction.varnum ?? instruction.arg);
        return /^istore(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const outerCandidates = [];
      for (const header of structured.loopHeaders) {
        if (countedLoopInfos.has(header)) continue;
        const block = cfg.blocks[header];
        const blockItems = block?.insns || [];
        if (blockItems.length !== 5 || cfg.term[header]?.kind !== "cond") continue;
        const upperSlot = loadSlot(items[blockItems[0]]?.instruction);
        const lowerSlot = loadSlot(items[blockItems[1]]?.instruction);
        const window = constantInstructionValue(
          items[blockItems[2]]?.instruction);
        if (!Number.isInteger(upperSlot) || !Number.isInteger(lowerSlot) ||
            upperSlot === lowerSlot || !Number.isInteger(window) ||
            window <= 0 ||
            opOf(items[blockItems[3]]?.instruction) !== "iadd" ||
            opOf(items[blockItems[4]]?.instruction) !== "if_icmplt") continue;
        const loopBlocks = naturalLoopBlocksFor(header);
        const term = cfg.term[header];
        if (!loopBlocks || loopBlocks.has(term.taken) ||
            !loopBlocks.has(term.fall)) continue;
        outerCandidates.push({
          header, upperSlot, lowerSlot, window, loopBlocks,
        });
      }
      for (const outer of outerCandidates) {
        const innerCandidates = [...countedLoopInfos.values()].filter((info) =>
          info.boundSlot === outer.upperSlot && info.increment > 0 &&
          info.initial === null && outer.loopBlocks.has(info.header) &&
          [...info.loopBlocks].every((block) => outer.loopBlocks.has(block)));
        if (innerCandidates.length !== 1) continue;
        const inner = innerCandidates[0];
        const stride = inner.increment;
        if (outer.window !== stride * 2 || outer.window > 2147483647) continue;

        const preheaderItems = cfg.blocks[inner.preheader]?.insns || [];
        let matchingInitialization = 0;
        for (let position = 3; position < preheaderItems.length; position += 1) {
          const left = items[preheaderItems[position - 3]]?.instruction;
          const right = items[preheaderItems[position - 2]]?.instruction;
          const add = items[preheaderItems[position - 1]]?.instruction;
          const store = items[preheaderItems[position]]?.instruction;
          if (loadSlot(left) === outer.lowerSlot &&
              constantInstructionValue(right) === stride &&
              opOf(add) === "iadd" && storeSlot(store) === inner.slot &&
              /^istore(?:_[0-3])?$/.test(opOf(store))) {
            matchingInitialization += 1;
          }
        }
        if (matchingInitialization !== 1) continue;

        const upperWrites = [];
        let lowerWrites = 0;
        let unexpectedInnerWrites = 0;
        for (let block = 0; block < cfg.n; block += 1) {
          if (!cfg.blocks[block] || cfg.blocks[block].synthetic) continue;
          for (const itemIndex of cfg.blocks[block].insns || []) {
            if (!normalReachableItems.has(itemIndex)) continue;
            const instruction = items[itemIndex]?.instruction;
            const op = opOf(instruction);
            const slot = storeSlot(instruction);
            if (slot === outer.lowerSlot) lowerWrites += 1;
            if (slot === outer.upperSlot) {
              upperWrites.push({block, op, increment:
                op === "iinc" ? Number(instruction.incr ?? 0) : null});
            }
            if (slot === inner.slot) {
              const isIncrement = op === "iinc" &&
                inner.loopBlocks.has(block) &&
                Number(instruction.incr ?? 0) === stride;
              const isInitialization =
                block === inner.preheader &&
                /^istore(?:_[0-3])?$/.test(op);
              if (!isIncrement && !isInitialization) unexpectedInnerWrites += 1;
            }
          }
        }
        if (lowerWrites !== 0 || unexpectedInnerWrites !== 0 ||
            upperWrites.length !== 1 || upperWrites[0].op !== "iinc" ||
            upperWrites[0].increment !== -stride ||
            inner.loopBlocks.has(upperWrites[0].block)) continue;
        const outerHeaderItem = cfg.blocks[outer.header].insns[0];
        const outerBackedges = allCfgPredecessors[outer.header].filter(
          (block) => cfg.blocks[block]?.insns?.[0] >= outerHeaderItem);
        if (outerBackedges.length !== 1 ||
            outerBackedges[0] !== upperWrites[0].block) continue;

        const accesses = primitiveArrayAccessCandidates;
        if (accesses.some((access) =>
          !inner.loopBlocks.has(access.block) ||
          access.indexAffine?.slot !== inner.slot ||
          !Number.isInteger(access.indexAffine.offset))) continue;
        const minimumOffset = Math.min(...accesses.map(
          (access) => access.indexAffine.offset));
        const maximumOffset = Math.max(...accesses.map(
          (access) => access.indexAffine.offset));
        if (minimumOffset < -stride || maximumOffset >= stride) continue;

        const storeItems = accesses.filter((access) => access.store);
        if (storeItems.length === 0 || storeItems.some((access) =>
          !inner.loopBlocks.has(access.block))) continue;
        const variable = `ssaShrinkingArrayWindowGuard${outer.header}`;
        for (const access of accesses) {
          access.structuralGuard = variable;
          if (access.rangeCandidate) {
            access.rangeCandidate.structuralGuard = variable;
          }
        }
        return {
          variable, arrayData, arraySlot,
          outerHeader: outer.header,
          innerHeader: inner.header,
          lowerSlot: outer.lowerSlot,
          upperSlot: outer.upperSlot,
          innerSlot: inner.slot,
          window: outer.window,
          stride,
          accesses,
        };
      }
      return null;
    })();
    const recursiveArrayPartitionLeaf = (() => {
      const rejectRecursive = (reason) => {
        if (typeof process !== "undefined" && process.env &&
            process.env.JVM_TRACE_STRUCTURED_RECURSIVE_ARRAY === "1") {
          console.error("[structured-recursive-array]", reason);
        }
        return null;
      };
      let recursiveDescriptor = null;
      try { recursiveDescriptor = parseDescriptor(method.descriptor); } catch (_) {}
      if (!methodIsStatic || !recursiveDescriptor ||
          recursiveDescriptor.returnType !== "void" ||
          recursiveDescriptor.params.length !== 3 ||
          !recursiveDescriptor.params[0]?.endsWith("[]") ||
          !recursiveDescriptor.params.slice(1).every((type) =>
            ["boolean", "byte", "char", "short", "int"].includes(type)) ||
          (code.code.exceptionTable || []).length !== 0 ||
          entryArrayLocalSlots.size !== 1 || callSites.size !== 2 ||
          [...callSites.values()].some((site) =>
            !site.selfRecursive || !site.returnsVoid) ||
          structured.loopHeaders.size !== 1) return rejectRecursive(
        `entry handlers=${(code.code.exceptionTable || []).length} ` +
        `arrays=${entryArrayLocalSlots.size} calls=${callSites.size} ` +
        `loops=${structured.loopHeaders.size}`);
      const arraySlot = [...entryArrayLocalSlots][0];
      if (assignedReferenceLocals.has(arraySlot) ||
          !entryArrayKinds.has(arraySlot)) return rejectRecursive("array slot");
      const arrayData = entryArrayDataVariable(arraySlot);
      const header = [...structured.loopHeaders][0];
      const loop = countedLoopInfos.get(header);
      if (!loop || !Number.isInteger(loop.boundSlot) ||
          loop.initial !== null || loop.increment <= 0) return rejectRecursive(
        `counted loop=${Boolean(loop)} initial=${loop?.initial} ` +
        `increment=${loop?.increment} bound=${loop?.boundSlot}`);
      const stride = loop.increment;
      const loadSlot = (instruction, prefix = "i") => {
        const op = opOf(instruction);
        return new RegExp(`^${prefix}load(?:_[0-3])?$`).test(op)
          ? localIndex(instruction, op) : null;
      };
      const storeSlot = (instruction) => {
        const op = opOf(instruction);
        return /^istore(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const preheaderItems = cfg.blocks[loop.preheader]?.insns || [];
      let lowerSlot = null;
      for (let position = 3; position < preheaderItems.length; position += 1) {
        const left = items[preheaderItems[position - 3]]?.instruction;
        const step = items[preheaderItems[position - 2]]?.instruction;
        const add = items[preheaderItems[position - 1]]?.instruction;
        const store = items[preheaderItems[position]]?.instruction;
        if (constantInstructionValue(step) === stride &&
            opOf(add) === "iadd" && storeSlot(store) === loop.slot) {
          lowerSlot = loadSlot(left);
        }
      }
      if (!Number.isInteger(lowerSlot) || lowerSlot === loop.boundSlot) {
        return rejectRecursive("lower slot");
      }
      let pivotSlot = null;
      const headerItem = cfg.blocks[header]?.insns?.[0] ?? 0;
      for (let index = 1; index < headerItem; index += 1) {
        if (loadSlot(items[index - 1]?.instruction) === lowerSlot) {
          const candidate = storeSlot(items[index]?.instruction);
          if (Number.isInteger(candidate) && candidate !== lowerSlot &&
              candidate !== loop.boundSlot && candidate !== loop.slot) {
            if (pivotSlot !== null && pivotSlot !== candidate) return null;
            pivotSlot = candidate;
          }
        }
      }
      if (!Number.isInteger(pivotSlot)) return rejectRecursive("pivot slot");

      const primitiveArrayOps = new Set([
        "iaload", "saload", "baload", "caload", "daload", "faload",
        "laload", "iastore", "sastore", "bastore", "castore",
        "dastore", "fastore", "lastore",
      ]);
      const forbiddenOps = new Set([
        "getfield", "putfield", "getstatic", "putstatic", "arraylength",
        "idiv", "irem", "athrow", "new", "newarray", "anewarray",
        "multianewarray", "monitorenter", "monitorexit", "checkcast",
        "instanceof", "aaload", "aastore",
      ]);
      const primitiveItems = [];
      for (let index = 0; index < items.length; index += 1) {
        if (!normalReachableItems.has(index)) continue;
        const op = opOf(items[index]?.instruction);
        if (forbiddenOps.has(op)) return rejectRecursive(`forbidden ${op}`);
        if (op?.startsWith("invoke") && !callSites.get(index)?.selfRecursive) {
          return rejectRecursive(`foreign call ${index}`);
        }
        if (primitiveArrayOps.has(op)) primitiveItems.push(index);
      }
      const allowedIndexSlots = new Set([
        lowerSlot, loop.slot, pivotSlot,
      ]);
      const accesses = primitiveArrayAccessCandidates;
      const coveredItems = new Set(accesses.map((access) => access.itemIndex));
      const implicitlyCoveredStores = primitiveItems.filter((itemIndex) =>
        !coveredItems.has(itemIndex));
      if (!primitiveItems.length || implicitlyCoveredStores.some((itemIndex) =>
        !opOf(items[itemIndex]?.instruction)?.endsWith("astore")) ||
          accesses.some((access) =>
            access.arrayData !== arrayData ||
            !primitiveItems.includes(access.itemIndex) ||
            !allowedIndexSlots.has(access.indexAffine?.slot) ||
            !Number.isInteger(access.indexAffine?.offset) ||
            access.indexAffine.offset < 0 ||
            access.indexAffine.offset >= stride)) return rejectRecursive(
        `accesses primitive=${primitiveItems.length} candidates=${accesses.length} ` +
        `slots=${[...allowedIndexSlots].join(",")}`);

      const decodeCall = (index) => {
        const highSlot = loadSlot(items[index - 1]?.instruction);
        if (!Number.isInteger(highSlot)) return null;
        const directLow = loadSlot(items[index - 2]?.instruction);
        if (Number.isInteger(directLow)) {
          const loadedArray = loadSlot(items[index - 3]?.instruction, "a");
          return loadedArray === arraySlot
            ? {lowSlot: directLow, lowOffset: 0, highSlot} : null;
        }
        if (opOf(items[index - 2]?.instruction) !== "iadd" ||
            constantInstructionValue(items[index - 3]?.instruction) !== stride) {
          return null;
        }
        const lowSlot = loadSlot(items[index - 4]?.instruction);
        const loadedArray = loadSlot(items[index - 5]?.instruction, "a");
        return loadedArray === arraySlot && Number.isInteger(lowSlot)
          ? {lowSlot, lowOffset: stride, highSlot} : null;
      };
      const recursiveCalls = [...callSites.keys()].map(decodeCall);
      if (recursiveCalls.some((call) => !call)) return rejectRecursive(
        `call decode ${JSON.stringify(recursiveCalls)}`);
      const hasLowerPartition = recursiveCalls.some((call) =>
        call.lowSlot === lowerSlot && call.lowOffset === 0 &&
        call.highSlot === pivotSlot);
      const hasUpperPartition = recursiveCalls.some((call) =>
        call.lowSlot === pivotSlot && call.lowOffset === stride &&
        call.highSlot === loop.boundSlot);
      if (!hasLowerPartition || !hasUpperPartition) return rejectRecursive(
        `partition calls ${JSON.stringify(recursiveCalls)}`);

      const variable = `ssaRecursiveArrayWindowGuard${header}`;
      for (const access of accesses) {
        access.structuralGuard = variable;
        if (access.rangeCandidate) {
          access.rangeCandidate.structuralGuard = variable;
        }
      }
      return {
        variable, arrayData, arraySlot, header, stride,
        lowerSlot, upperSlot: loop.boundSlot, accesses,
      };
    })();
    const arrayRangeGuardDeclarations = new Map();
    const arrayRangeGuardVariables = new Map();
    const arrayRangeGuardDataVariables = new Map();
    const arrayRangeGuardNonZeroLocals = new Map();
    const packedArrayCapacityFacts = [];
    const arrayRangeGuardByCondition = new Map();
    const tripBoundedArrayRangeGuards = new Set();
    const countedRangeTripValues = new Map();
    let coalescedArrayRangeGuardCount = 0;
    const loopInvariantDivisorGuards = new Map();
    const loopInvariantDivisorGuardNonZeroLocals = new Map();
    let loopInvariantDivisorGuardCount = 0;
    const sharedCountedTrips = (info, preamble) => {
      let shared = countedRangeTripValues.get(info.header);
      if (!shared) {
        const remaining =
          e`(${info.boundExpression} - ${localName(info.slot)})`;
        const variable =
          pureRangeTemporary(named(`ssaArrayRangeTrips${info.header}`));
        shared = {
          variable,
          declaration: constDecl(variable, exprConcat(
            e`(${localName(info.slot)} >= ${info.boundExpression} ? 0 : `,
            info.increment === 1 ? remaining
              : e`Math.ceil(${remaining} / ${info.increment})`, e`)`),
          {pure: true}),
          emitted: false,
        };
        countedRangeTripValues.set(info.header, shared);
      }
      if (!shared.emitted) {
        preamble.push(shared.declaration);
        shared.emitted = true;
      }
      return shared.variable;
    };
    // A division exception arm inside a counted loop is avoidable when its
    // divisor comes from a loop-invariant local. Version the complete loop on
    // `(zero trips || divisor != 0)`: failure restores the exact loop-header
    // state before executing the canonical bytecode, while success lets the
    // numeric loop omit every dominated arithmetic/deopt branch. This is
    // derived solely from SSA local provenance and loop writes.
    const exceptionalGuardClose = (lines, start) => {
      let depth = 0;
      for (let index = start; index < lines.length; index += 1) {
        depth += recordOf(lines[index])?.blockDelta || 0;
        if (depth === 0) return index;
      }
      return -1;
    };
    for (const [header, info] of this.loopInvariantDivisorGuardsEnabled
      ? countedLoopInfos : []) {
      const slots = new Set();
      for (const block of info.loopBlocks) {
        const lines = plans[block]?.lines || [];
        for (let index = 0; index < lines.length; index += 1) {
          const record = recordOf(lines[index]);
          const value = record?.kind === "if" && !record.negated &&
            record.comparison?.cmp === "=== 0"
            ? record.comparison.input : null;
          if (!value || !ownSsaValueNames.has(value)) continue;
          const close = exceptionalGuardClose(lines, index);
          if (close < 0) continue;
          // The arm exists only to raise the guest arithmetic exception, so
          // the divisor is non-zero on every other path.
          const exceptional = lines.slice(index + 1, close).some((line) =>
            recordOf(line)?.arithmeticException === true);
          if (!exceptional) continue;
          const slot = localLoads.get(value);
          if (Number.isInteger(slot) && !info.writtenSlots.has(slot)) {
            slots.add(slot);
          }
        }
      }
      if (!slots.size) continue;
      const variable = named(`ssaInvariantDivisorGuard${header}`);
      const trips = exprConcat(
        e`(${localName(info.slot)} >= ${info.boundExpression} ? 0 : `,
        info.increment === 1
          ? e`(${info.boundExpression} - ${localName(info.slot)})`
          : exprConcat(
            e`Math.ceil((${info.boundExpression} - ${
              localName(info.slot)}) / `,
            e`${info.increment})`),
        e`)`);
      loopInvariantDivisorGuards.set(header, {
        variable,
        declaration: constDecl(variable, exprConcat(
          e`(${trips} === 0 || `,
          ...[...slots].flatMap((slot, position) => [
            position === 0 ? "" : " && ",
            e`${localName(slot)} !== 0`,
          ]), e`)`), {pure: true}),
      });
      loopInvariantDivisorGuardNonZeroLocals.set(variable, [...slots]);
      loopInvariantDivisorGuardCount += slots.size;
    }
    const quotientProductRangePreambles = new Map();
    const indirectArrayRangePreambles = new Map();
    const cyclicArrayRangeCandidates = new Set();
    let fieldBackedArrayRangeCandidateCount = 0;
    let hoistedArrayRangeGuardCount = 0;
    const trustedHoistedRangeGuards = new Set();
    const entryDominatedRangeGuards = new Set();
    const rangeBailoutGuardsByHeader = new Map();
    const hasEffectBeforeLoopHeader = (header) => {
      const first = cfg.blocks[header]?.insns?.[0];
      if (!Number.isInteger(first)) return true;
      for (let index = 0; index < first; index += 1) {
        if (!normalReachableItems.has(index)) continue;
        const op = opOf(items[index]?.instruction);
        if (!op || /^(?:[ai]load(?:_[0-3])?|[ai]store(?:_[0-3])?|iinc|iconst_(?:m1|[0-5])|bipush|sipush|ldc|ldc_w|iadd|isub|imul|idiv|irem|iand|ior|ixor|ishl|ishr|iushr|ineg|arraylength|getstatic|goto|goto_w|if.*|return|ireturn)$/.test(op)) {
          continue;
        }
        return true;
      }
      return false;
    };
    const affineLocalStep = (info, slot) => {
      let result = null;
      let writes = 0;
      for (const block of info.loopBlocks) {
        const blockItems = cfg.blocks[block].insns;
        for (let position = 0; position < blockItems.length; position += 1) {
          const itemIndex = blockItems[position];
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          const writtenSlot = /^istore(?:_[0-3])?$/.test(op)
            ? localIndex(instruction, op)
            : op === "iinc" ? Number(instruction.varnum ?? instruction.arg)
              : null;
          if (writtenSlot !== slot) continue;
          writes += 1;
          if (op === "iinc") {
            const increment = Number(instruction.incr ?? 0);
            if (Number.isInteger(increment)) result = String(increment);
            continue;
          }
          if (position < 3) continue;
          const load = items[blockItems[position - 3]]?.instruction;
          const stepLoad = items[blockItems[position - 2]]?.instruction;
          const add = items[blockItems[position - 1]]?.instruction;
          const loadOp = opOf(load);
          if (!/^iload(?:_[0-3])?$/.test(loadOp) ||
              localIndex(load, loadOp) !== slot ||
              opOf(add) !== "iadd") continue;
          const constantStep = constantInstructionValue(stepLoad);
          if (Number.isInteger(constantStep)) {
            result = String(constantStep);
            continue;
          }
          if (opOf(stepLoad) === "getstatic") {
            const direct = directStaticSites.get(blockItems[position - 2]);
            if (direct?.entryReadCache?.value) {
              result = direct.entryReadCache.value;
            }
          }
        }
      }
      return writes === 1 ? result : null;
    };
    const carriedCountedLocalRelation = (info, candidate) => {
      if (candidate.kind !== "affine-local" || info.initial !== 0 ||
          info.increment <= 0 || candidate.slots.length !== 1) return null;
      const slot = candidate.slots[0];
      if (slot === info.slot || !Number.isInteger(info.boundSlot) ||
          !Number.isInteger(info.preheader)) return null;
      const preheaderItems = cfg.blocks[info.preheader]?.insns || [];
      let initialized = false;
      for (let position = 3; position < preheaderItems.length; position += 1) {
        const load = items[preheaderItems[position - 3]]?.instruction;
        const stride = items[preheaderItems[position - 2]]?.instruction;
        const subtract = items[preheaderItems[position - 1]]?.instruction;
        const store = items[preheaderItems[position]]?.instruction;
        const loadOp = opOf(load), storeOp = opOf(store);
        if (/^iload(?:_[0-3])?$/.test(loadOp) &&
            localIndex(load, loadOp) === info.boundSlot &&
            constantInstructionValue(stride) === info.increment &&
            opOf(subtract) === "isub" &&
            /^istore(?:_[0-3])?$/.test(storeOp) &&
            localIndex(store, storeOp) === slot) initialized = true;
      }
      if (!initialized) return null;
      let assignment = null;
      let writes = 0;
      for (const loopBlock of info.loopBlocks) {
        const blockItems = cfg.blocks[loopBlock]?.insns || [];
        for (let position = 1; position < blockItems.length; position += 1) {
          const storeIndex = blockItems[position];
          const store = items[storeIndex]?.instruction;
          const storeOp = opOf(store);
          if (!/^istore(?:_[0-3])?$/.test(storeOp) ||
              localIndex(store, storeOp) !== slot) continue;
          writes += 1;
          const load = items[blockItems[position - 1]]?.instruction;
          const loadOp = opOf(load);
          if (/^iload(?:_[0-3])?$/.test(loadOp) &&
              localIndex(load, loadOp) === info.slot) {
            assignment = {block: loopBlock, itemIndex: storeIndex};
          }
        }
      }
      if (writes !== 1 || !assignment) return null;
      const afterAccess = assignment.block === candidate.block
        ? assignment.itemIndex > candidate.itemIndex
        : loopPathExists(info, candidate.block, assignment.block);
      if (!afterAccess || (info.backedges || []).some((backedge) =>
        assignment.block !== backedge &&
        loopPathExists(info, info.header, backedge, assignment.block))) {
        return null;
      }
      return {slot, offset: candidate.indexAffine?.offset || 0};
    };
    const packedAppendRelation = (info, candidate) => {
      if (candidate.kind !== "affine-local" || info.increment <= 0 ||
          candidate.slots.length !== 1) return null;
      const slot = candidate.slots[0];
      if (slot === info.slot) return null;
      if ([...structured.loopHeaders].some((header) =>
        header !== info.header && info.loopBlocks.has(header))) return null;
      let writeCount = 0;
      const blockWeights = new Map();
      for (const block of info.loopBlocks) {
        let weight = 0;
        for (const itemIndex of cfg.blocks[block]?.insns || []) {
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          const writtenSlot = op === "iinc"
            ? Number(instruction.varnum ?? instruction.arg)
            : /^istore(?:_[0-3])?$/.test(op)
              ? localIndex(instruction, op) : null;
          if (writtenSlot !== slot) continue;
          writeCount += 1;
          if (op !== "iinc" || Number(instruction.incr) !== 1) return null;
          weight += 1;
        }
        blockWeights.set(block, weight);
      }
      if (!writeCount) return null;
      const memo = new Map();
      const visiting = new Set();
      const maximumToBackedge = (block) => {
        if (memo.has(block)) return memo.get(block);
        if (visiting.has(block)) return null;
        visiting.add(block);
        let suffix = -Infinity;
        for (const successor of cfg.succ[block] || []) {
          if (successor === info.header) {
            suffix = Math.max(suffix, 0);
          } else if (info.loopBlocks.has(successor)) {
            const candidateMaximum = maximumToBackedge(successor);
            if (candidateMaximum === null) return null;
            suffix = Math.max(suffix, candidateMaximum);
          }
        }
        visiting.delete(block);
        const maximum = suffix === -Infinity
          ? -Infinity : (blockWeights.get(block) || 0) + suffix;
        memo.set(block, maximum);
        return maximum;
      };
      let incrementsPerTrip = -Infinity;
      for (const successor of cfg.succ[info.header] || []) {
        if (!info.loopBlocks.has(successor) || successor === info.header) continue;
        const maximum = maximumToBackedge(successor);
        if (maximum === null) return null;
        incrementsPerTrip = Math.max(incrementsPerTrip, maximum);
      }
      if (!Number.isInteger(incrementsPerTrip) || incrementsPerTrip <= 0) {
        return null;
      }
      const candidateItems = cfg.blocks[candidate.block]?.insns || [];
      const candidatePosition = candidateItems.indexOf(candidate.itemIndex);
      let postIncrement = false;
      for (let position = candidatePosition - 1; position > 0; position -= 1) {
        const instruction = items[candidateItems[position]]?.instruction;
        const op = opOf(instruction);
        if (op === "iinc" &&
            Number(instruction.varnum ?? instruction.arg) === slot &&
            Number(instruction.incr) === 1) {
          postIncrement = candidateItems.slice(0, position).some((itemIndex) => {
            const load = items[itemIndex]?.instruction;
            const loadOp = opOf(load);
            return /^iload(?:_[0-3])?$/.test(loadOp) &&
              localIndex(load, loadOp) === slot;
          });
          break;
        }
      }
      return {
        slot,
        offset: candidate.indexAffine?.offset || 0,
        incrementsPerTrip,
        postIncrement,
      };
    };
    const binaryLocalAssignment = (info, targetSlot, binaryOp) => {
      let result = null;
      let writes = 0;
      for (const block of info.loopBlocks) {
        const blockItems = cfg.blocks[block].insns;
        for (let position = 0; position < blockItems.length; position += 1) {
          const itemIndex = blockItems[position];
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          const writtenSlot = /^istore(?:_[0-3])?$/.test(op)
            ? localIndex(instruction, op)
            : op === "iinc" ? Number(instruction.varnum ?? instruction.arg)
              : null;
          if (writtenSlot !== targetSlot) continue;
          writes += 1;
          if (position < 3 || op === "iinc") continue;
          const left = items[blockItems[position - 3]]?.instruction;
          const right = items[blockItems[position - 2]]?.instruction;
          const binary = items[blockItems[position - 1]]?.instruction;
          const leftOp = opOf(left);
          const rightOp = opOf(right);
          if (!/^iload(?:_[0-3])?$/.test(leftOp) ||
              !/^iload(?:_[0-3])?$/.test(rightOp) ||
              opOf(binary) !== binaryOp) continue;
          result = {
            left: localIndex(left, leftOp),
            right: localIndex(right, rightOp),
            block,
            itemIndex,
          };
        }
      }
      return writes === 1 ? result : null;
    };
    const cyclicLocalRange = (info, candidate) => {
      if (candidate.kind !== "affine-local" ||
          candidate.slots.length !== 1) return null;
      const indexSlot = candidate.slots[0];
      const candidateIndex = candidate.itemIndex;
      const sampledLoad = items[candidateIndex - 2]?.instruction;
      const sampledIncrement = items[candidateIndex - 1]?.instruction;
      const sampledLoadOp = opOf(sampledLoad);
      if (!/^iload(?:_[0-3])?$/.test(sampledLoadOp) ||
          localIndex(sampledLoad, sampledLoadOp) !== indexSlot ||
          opOf(sampledIncrement) !== "iinc" ||
          Number(sampledIncrement.varnum ?? sampledIncrement.arg) !== indexSlot ||
          Number(sampledIncrement.incr) !== 1) return null;
      const loopItems = [...info.loopBlocks]
        .flatMap((block) => cfg.blocks[block].insns || []);
      const loopItemSet = new Set(loopItems);
      const writtenSlots = new Map();
      for (const itemIndex of loopItems) {
        const instruction = items[itemIndex]?.instruction;
        const op = opOf(instruction);
        const slot = /^istore(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op)
          : op === "iinc"
            ? Number(instruction.varnum ?? instruction.arg) : null;
        if (Number.isInteger(slot)) {
          writtenSlots.set(slot, (writtenSlots.get(slot) || 0) + 1);
        }
      }
      for (let position = 0; position + 9 < items.length; position += 1) {
        const sequence = Array.from(
          {length: 10}, (_unused, offset) =>
            items[position + offset]?.instruction);
        if (sequence.some((_instruction, offset) =>
            !loopItemSet.has(position + offset))) continue;
        const phaseIncrement = sequence[0];
        if (opOf(phaseIncrement) !== "iinc" ||
            Number(phaseIncrement.incr) !== 1) continue;
        const phaseSlot =
          Number(phaseIncrement.varnum ?? phaseIncrement.arg);
        const phaseLoadOp = opOf(sequence[1]);
        const modulusLoadOp = opOf(sequence[2]);
        const indexLoadOp = opOf(sequence[4]);
        const secondModulusLoadOp = opOf(sequence[5]);
        const indexStoreOp = opOf(sequence[7]);
        const phaseStoreOp = opOf(sequence[9]);
        if (!/^iload(?:_[0-3])?$/.test(phaseLoadOp) ||
            localIndex(sequence[1], phaseLoadOp) !== phaseSlot ||
            !/^iload(?:_[0-3])?$/.test(modulusLoadOp) ||
            !/^iload(?:_[0-3])?$/.test(indexLoadOp) ||
            localIndex(sequence[4], indexLoadOp) !== indexSlot ||
            !/^iload(?:_[0-3])?$/.test(secondModulusLoadOp) ||
            opOf(sequence[3]) !== "if_icmpne" ||
            opOf(sequence[6]) !== "isub" ||
            !/^istore(?:_[0-3])?$/.test(indexStoreOp) ||
            localIndex(sequence[7], indexStoreOp) !== indexSlot ||
            opOf(sequence[8]) !== "iconst_0" ||
            !/^istore(?:_[0-3])?$/.test(phaseStoreOp) ||
            localIndex(sequence[9], phaseStoreOp) !== phaseSlot) continue;
        const modulusSlot = localIndex(sequence[2], modulusLoadOp);
        if (localIndex(sequence[5], secondModulusLoadOp) !== modulusSlot ||
            info.writtenSlots.has(modulusSlot) ||
            (writtenSlots.get(indexSlot) || 0) !== 2 ||
            (writtenSlots.get(phaseSlot) || 0) !== 2) continue;
        const branchTarget = sequence[3]?.arg;
        const targetIndex = typeof branchTarget === "string"
          ? labels.get(branchTarget.replace(/:$/, "")) : null;
        if (targetIndex !== position + 10) continue;
        return {indexSlot, phaseSlot, modulusSlot};
      }
      return null;
    };
    // Extend a verified one-dimensional cyclic access across an enclosing
    // counted row loop.  This is the bytecode form produced for a general
    // cyclic rectangle, but the proof is expressed entirely in terms of local
    // recurrences:
    //
    //   index = index - phase + entryPhase + modulus
    //   phase = entryPhase
    //   if (++row == height) { row = 0; index -= height * modulus; }
    //
    // Once those assignments, their ordering, and all invariant inputs have
    // been verified, one entry predicate can cover the complete rectangular
    // backing store.  The generated fast loop then needs neither a per-row
    // source predicate nor a checked duplicate of its inner loop.
    const nestedCyclicLocalRange = (info, candidate, cyclic, outer) => {
      if (!outer || !outer.loopBlocks.has(info.header)) return null;
      const innerItems = new Set([...info.loopBlocks]
        .flatMap((block) => cfg.blocks[block]?.insns || []));
      const outerOnlyItems = [...outer.loopBlocks]
        .flatMap((block) => cfg.blocks[block]?.insns || [])
        .filter((itemIndex) => !innerItems.has(itemIndex))
        .sort((left, right) => left - right);
      const outerOnlySet = new Set(outerOnlyItems);
      const loadSlot = (instruction) => {
        const op = opOf(instruction);
        return /^iload(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const storeSlot = (instruction) => {
        const op = opOf(instruction);
        return /^istore(?:_[0-3])?$/.test(op)
          ? localIndex(instruction, op) : null;
      };
      const sequenceAt = (position, length) => {
        const indexes = Array.from(
          {length}, (_unused, offset) => position + offset);
        return indexes.every((itemIndex) => outerOnlySet.has(itemIndex))
          ? indexes.map((itemIndex) => items[itemIndex]?.instruction) : null;
      };

      let rowAdvance = null;
      for (const position of outerOnlyItems) {
        const sequence = sequenceAt(position, 10);
        if (!sequence ||
            loadSlot(sequence[0]) !== cyclic.indexSlot ||
            loadSlot(sequence[1]) !== cyclic.phaseSlot ||
            opOf(sequence[2]) !== "isub" ||
            !Number.isInteger(loadSlot(sequence[3])) ||
            opOf(sequence[4]) !== "iadd" ||
            loadSlot(sequence[5]) !== cyclic.modulusSlot ||
            opOf(sequence[6]) !== "iadd" ||
            storeSlot(sequence[7]) !== cyclic.indexSlot ||
            loadSlot(sequence[8]) !== loadSlot(sequence[3]) ||
            storeSlot(sequence[9]) !== cyclic.phaseSlot) continue;
        if (rowAdvance) return null;
        rowAdvance = {
          position,
          entryPhaseSlot: loadSlot(sequence[3]),
        };
      }
      if (!rowAdvance || outer.writtenSlots.has(rowAdvance.entryPhaseSlot)) {
        return null;
      }

      let verticalWrap = null;
      for (const position of outerOnlyItems) {
        const sequence = sequenceAt(position, 10);
        if (!sequence || opOf(sequence[0]) !== "iinc" ||
            Number(sequence[0].incr) !== 1) continue;
        const rowSlot = Number(sequence[0].varnum ?? sequence[0].arg);
        const heightSlot = loadSlot(sequence[2]);
        const cycleSlot = loadSlot(sequence[7]);
        if (loadSlot(sequence[1]) !== rowSlot ||
            !Number.isInteger(heightSlot) ||
            opOf(sequence[3]) !== "if_icmpne" ||
            opOf(sequence[4]) !== "iconst_0" ||
            storeSlot(sequence[5]) !== rowSlot ||
            loadSlot(sequence[6]) !== cyclic.indexSlot ||
            !Number.isInteger(cycleSlot) ||
            opOf(sequence[8]) !== "isub" ||
            storeSlot(sequence[9]) !== cyclic.indexSlot) continue;
        const branchTarget = sequence[3]?.arg;
        const targetIndex = typeof branchTarget === "string"
          ? labels.get(branchTarget.replace(/:$/, "")) : null;
        if (targetIndex !== position + 10) continue;
        if (verticalWrap) return null;
        verticalWrap = {position, rowSlot, heightSlot, cycleSlot};
      }
      if (!verticalWrap ||
          outer.writtenSlots.has(verticalWrap.heightSlot) ||
          outer.writtenSlots.has(verticalWrap.cycleSlot) ||
          outer.writtenSlots.has(cyclic.modulusSlot)) return null;

      const firstOuterItem = Math.min(...[...outer.loopBlocks]
        .flatMap((block) => cfg.blocks[block]?.insns || []));
      let entryPhaseInitializationCount = 0;
      let cycleInitializationCount = 0;
      for (let position = 1; position < firstOuterItem; position += 1) {
        const store = items[position]?.instruction;
        if (storeSlot(store) === rowAdvance.entryPhaseSlot &&
            loadSlot(items[position - 1]?.instruction) === cyclic.phaseSlot) {
          entryPhaseInitializationCount += 1;
        }
        if (position >= 3 &&
            storeSlot(store) === verticalWrap.cycleSlot &&
            opOf(items[position - 1]?.instruction) === "imul") {
          const left = loadSlot(items[position - 3]?.instruction);
          const right = loadSlot(items[position - 2]?.instruction);
          if ((left === verticalWrap.heightSlot &&
               right === cyclic.modulusSlot) ||
              (right === verticalWrap.heightSlot &&
               left === cyclic.modulusSlot)) {
            cycleInitializationCount += 1;
          }
        }
      }
      if (entryPhaseInitializationCount !== 1 ||
          cycleInitializationCount !== 1) return null;

      const writeCounts = new Map();
      for (const itemIndex of [...outer.loopBlocks]
        .flatMap((block) => cfg.blocks[block]?.insns || [])) {
        const instruction = items[itemIndex]?.instruction;
        const op = opOf(instruction);
        const slot = op === "iinc"
          ? Number(instruction.varnum ?? instruction.arg)
          : storeSlot(instruction);
        if (Number.isInteger(slot)) {
          writeCounts.set(slot, (writeCounts.get(slot) || 0) + 1);
        }
      }
      if (writeCounts.get(cyclic.indexSlot) !== 4 ||
          writeCounts.get(cyclic.phaseSlot) !== 3 ||
          writeCounts.get(verticalWrap.rowSlot) !== 2 ||
          writeCounts.has(rowAdvance.entryPhaseSlot) ||
          writeCounts.has(verticalWrap.heightSlot) ||
          writeCounts.has(verticalWrap.cycleSlot) ||
          writeCounts.has(cyclic.modulusSlot)) return null;

      return {
        outer,
        entryPhaseSlot: rowAdvance.entryPhaseSlot,
        rowSlot: verticalWrap.rowSlot,
        heightSlot: verticalWrap.heightSlot,
        cycleSlot: verticalWrap.cycleSlot,
      };
    };
    // Recognize a general integer recurrence used by affine samplers:
    //
    //   recurrence += invariantStep
    //   quotient = recurrence / invariantDivisor
    //   derived = quotient * invariantMultiplier
    //   index = derived + invariantOffset
    //
    // The proof is deliberately local to one natural counted loop. Runtime
    // endpoint checks reject division by zero, every possible int32 overflow,
    // null storage, and an out-of-range first/last index. With those excluded,
    // truncating division and multiplication are monotone over the finite
    // recurrence, so all intermediate indexes are in range as well. The
    // original checked loop remains the complete slow arm.
    const loopPathExists = (info, start, target, blocked = null) => {
      if (start === blocked) return false;
      const pending = [start];
      const visited = new Set();
      while (pending.length) {
        const block = pending.pop();
        if (block === blocked || visited.has(block)) continue;
        if (block === target) return true;
        visited.add(block);
        for (const successor of cfg.succ[block] || []) {
          // Crossing the natural-loop backedge starts the next iteration and
          // cannot establish ordering within the current one.
          if (successor === info.header ||
              !info.loopBlocks.has(successor)) continue;
          pending.push(successor);
        }
      }
      return false;
    };
    const loopAssignmentDominates = (info, assignment, candidate) => {
      if (assignment.block === candidate.block) {
        return assignment.itemIndex < candidate.itemIndex;
      }
      if (assignment.block === info.header) return true;
      return !loopPathExists(
        info, info.header, candidate.block, assignment.block);
    };
    // A polygon/edge walker and many table decoders carry the previous
    // induction value in a second local:
    //
    //   previous = bound - 1;
    //   for (current = 0; current < bound; current++) {
    //     array[(previous << shift) + offset];
    //     previous = current;
    //   }
    //
    // Verify the initialization, unique assignment, ordering, and every
    // backedge structurally. Both locals then share [0, bound - 1], allowing
    // one loop-entry range guard for scaled array indexes.
    const scaledCountedLocalRelation = (info, candidate) => {
      if (candidate.kind !== "scaled-local" || info.increment !== 1 ||
          info.initial !== 0 || candidate.slots.length !== 1) return null;
      const slot = candidate.slots[0];
      if (slot === info.slot) return {kind: "induction"};
      if (!Number.isInteger(info.boundSlot) ||
          !Number.isInteger(info.preheader)) return null;
      const preheaderItems = cfg.blocks[info.preheader]?.insns || [];
      let initialized = false;
      for (let position = 3; position < preheaderItems.length; position += 1) {
        const load = items[preheaderItems[position - 3]]?.instruction;
        const one = items[preheaderItems[position - 2]]?.instruction;
        const subtract = items[preheaderItems[position - 1]]?.instruction;
        const store = items[preheaderItems[position]]?.instruction;
        const loadOp = opOf(load), storeOp = opOf(store);
        if (/^iload(?:_[0-3])?$/.test(loadOp) &&
            localIndex(load, loadOp) === info.boundSlot &&
            constantInstructionValue(one) === 1 &&
            opOf(subtract) === "isub" &&
            /^istore(?:_[0-3])?$/.test(storeOp) &&
            localIndex(store, storeOp) === slot) {
          initialized = true;
        }
      }
      if (!initialized) return null;

      let assignment = null;
      let writes = 0;
      for (const loopBlock of info.loopBlocks) {
        const blockItems = cfg.blocks[loopBlock]?.insns || [];
        for (let position = 1; position < blockItems.length; position += 1) {
          const storeIndex = blockItems[position];
          const store = items[storeIndex]?.instruction;
          const storeOp = opOf(store);
          if (!/^istore(?:_[0-3])?$/.test(storeOp) ||
              localIndex(store, storeOp) !== slot) continue;
          writes += 1;
          const load = items[blockItems[position - 1]]?.instruction;
          const loadOp = opOf(load);
          if (/^iload(?:_[0-3])?$/.test(loadOp) &&
              localIndex(load, loadOp) === info.slot) {
            assignment = {block: loopBlock, itemIndex: storeIndex};
          }
        }
      }
      if (writes !== 1 || !assignment) return null;
      const afterAccess = assignment.block === candidate.block
        ? assignment.itemIndex > candidate.itemIndex
        : loopPathExists(info, candidate.block, assignment.block);
      if (!afterAccess) return null;
      if ((info.backedges || []).some((backedge) =>
          assignment.block !== backedge &&
          loopPathExists(info, info.header, backedge, assignment.block))) {
        return null;
      }
      return {kind: "carried"};
    };
    const quotientProductRecurrence = (info, candidate) => {
      const slots = candidate.slots;
      for (let derivedIndex = 0; derivedIndex < slots.length;
        derivedIndex += 1) {
        const derivedSlot = slots[derivedIndex];
        const offsetSlot = slots[1 - derivedIndex];
        if (info.writtenSlots.has(offsetSlot)) continue;
        const multiply = binaryLocalAssignment(info, derivedSlot, "imul");
        if (!multiply) continue;
        for (const [quotientSlot, multiplierSlot] of [
          [multiply.left, multiply.right],
          [multiply.right, multiply.left],
        ]) {
          if (info.writtenSlots.has(multiplierSlot)) continue;
          const divide =
            binaryLocalAssignment(info, quotientSlot, "idiv");
          if (!divide || info.writtenSlots.has(divide.right)) continue;
          const recurrenceSlot = divide.left;
          const recurrence =
            binaryLocalAssignment(info, recurrenceSlot, "iadd");
          if (!recurrence) continue;
          const stepSlot = recurrence.left === recurrenceSlot
            ? recurrence.right
            : recurrence.right === recurrenceSlot
              ? recurrence.left : null;
          if (!Number.isInteger(stepSlot) ||
              info.writtenSlots.has(stepSlot)) continue;
          if (!loopAssignmentDominates(info, divide, candidate) ||
              !loopAssignmentDominates(info, multiply, candidate)) continue;
          // The recurrence update must occur exactly once on every path to a
          // backedge and after this access in the current iteration. This
          // excludes conditionally updated or update-before-sample loops whose
          // endpoint formula would require a different starting value.
          if ((info.backedges || []).some((backedge) =>
              recurrence.block !== backedge &&
              loopPathExists(
                info, info.header, backedge, recurrence.block))) continue;
          const updatePrecedesCandidate =
            recurrence.block === candidate.block
              ? recurrence.itemIndex < candidate.itemIndex
              : loopPathExists(
                info, recurrence.block, candidate.block);
          if (updatePrecedesCandidate) continue;
          return {
            recurrenceSlot,
            stepSlot,
            divisorSlot: divide.right,
            multiplierSlot,
            offsetSlot,
          };
        }
      }
      return null;
    };
    for (let candidateIndex = 0;
      candidateIndex < arrayRangeCheckCandidates.length;
      candidateIndex += 1) {
      const candidate = arrayRangeCheckCandidates[candidateIndex];
      if (candidate.structuralGuard) continue;
      const loops = [...countedLoopInfos.values()]
        .filter((info) =>
          (info.increment === 1 ||
            candidate.kind === "affine-local" && info.increment > 1) &&
          !loopHasAtomicUnsafeOperation(info) &&
          info.loopBlocks.has(candidate.block) &&
          (candidate.kind === "bounded-index" ||
            candidate.kind === "affine-local" ||
            candidate.kind === "scaled-local" ||
            candidate.kind === "indirect-entry-array" ||
            candidate.slots.includes(info.slot) ||
            Boolean(quotientProductRecurrence(info, candidate))))
        .sort((left, right) =>
          left.loopBlocks.size - right.loopBlocks.size);
      let info = candidate.kind === "bounded-index"
        ? loops[0]
        : candidate.kind === "affine-local"
        ? loops.find((loop) =>
          candidate.slots[0] === loop.slot ||
          Boolean(affineLocalStep(loop, candidate.slots[0]) ||
            carriedCountedLocalRelation(loop, candidate) ||
            packedAppendRelation(loop, candidate) ||
            cyclicLocalRange(loop, candidate)))
        : candidate.kind === "scaled-local"
        ? loops.find((loop) =>
          Boolean(scaledCountedLocalRelation(loop, candidate)))
        : candidate.kind === "indirect-entry-array"
        ? loops.find((loop) =>
          candidate.slots[0] === loop.slot)
        : loops.find((loop) => {
          if (quotientProductRecurrence(loop, candidate)) return true;
          const baseSlot = candidate.slots.find((slot) => slot !== loop.slot);
          return Number.isInteger(baseSlot) &&
            !loop.writtenSlots.has(baseSlot);
        });
      if (!info && (candidate.kind === "bounded-index" ||
          candidate.kind === "affine-local")) {
        info = [...postDecrementLoopInfos.values()]
          .filter((loop) => loop.loopBlocks.has(candidate.block))
          .sort((left, right) =>
            left.loopBlocks.size - right.loopBlocks.size)[0] || null;
      }
      if (!info) continue;
      const enclosingCountedLoops = [...countedLoopInfos.values()]
        .filter((loop) => loop.header !== info.header &&
          loop.loopBlocks.has(info.header))
        .sort((left, right) => right.loopBlocks.size - left.loopBlocks.size);
      const outermostCountedLoop = enclosingCountedLoops[0] || null;
      const enclosingPostDecrementLoops = [...postDecrementLoopInfos.values()]
        .filter((loop) => loop.loopBlocks.has(info.header))
        .sort((left, right) =>
          right.loopBlocks.size - left.loopBlocks.size);
      const outermostPostDecrementLoop =
        enclosingPostDecrementLoops[0] || null;
      // Non-unit strides are admitted only for the direct affine induction
      // proof below. The more elaborate cyclic/nested/recurrence proofs have
      // their own unit-step algebra and remain deliberately unchanged.
      const positiveStrideCarried = info.increment !== 1 &&
        carriedCountedLocalRelation(info, candidate);
      const positiveStridePacked = info.increment !== 1 &&
        packedAppendRelation(info, candidate);
      if (info.increment !== 1 &&
          (candidate.kind !== "affine-local" || info.postDecrement ||
           outermostCountedLoop || outermostPostDecrementLoop ||
           candidate.slots[0] !== info.slot && !positiveStrideCarried &&
             !positiveStridePacked)) continue;
      const selectedPackedAppend = packedAppendRelation(info, candidate);
      if (selectedPackedAppend && hasEffectBeforeLoopHeader(info.header)) {
        continue;
      }
      const affineOffset = candidate.kind === "affine-local"
        ? candidate.offset || 0 : 0;
      if (affineOffset !== 0 &&
          (outermostCountedLoop || outermostPostDecrementLoop ||
           info.postDecrement)) continue;
      const variable =
        compactable(named(`ssaArrayRangeGuard${candidateIndex}`));
      let condition;
      let preamble = [];
      let declarationHeader = info.header;
      if (candidate.kind === "indirect-entry-array") {
        const matchingStore = {
          iaload: "iastore",
          saload: "sastore",
          baload: "bastore",
          caload: "castore",
        }[candidate.sourceOp];
        const sourceMayBeWritten = !matchingStore || items.some(
          (item, itemIndex) => normalReachableItems.has(itemIndex) &&
            opOf(item?.instruction) === matchingStore);
        if (sourceMayBeWritten || info.initial !== 0 ||
            info.increment !== 1) continue;
        const outer = outermostCountedLoop || outermostPostDecrementLoop;
        if (outer) declarationHeader = outer.header;
        const sharedKey = [
          declarationHeader,
          info.header,
          candidate.sourceArrayData,
          candidate.sourceOp,
          candidate.sourceDescriptor || "",
          info.boundExpression,
        ].join("\0");
        let shared = indirectArrayRangePreambles.get(sharedKey);
        if (!shared) {
          const prefix =
            `ssaIndirectArrayRange${indirectArrayRangePreambles.size}`;
          const cursor = named(`${prefix}Index`);
          const raw = named(`${prefix}Raw`);
          const valid = named(`${prefix}Valid`);
          const minimum = named(`${prefix}Minimum`);
          const maximum = named(`${prefix}Maximum`);
          const element = named(`${prefix}Value`);
          const loaded = candidate.sourceOp === "saload"
            ? e`((${raw} << 16) >> 16)`
            : candidate.sourceOp === "baload"
              ? candidate.sourceDescriptor === "[Z"
                ? e`(${raw} ? 1 : 0)`
                : e`((${raw} << 24) >> 24)`
              : candidate.sourceOp === "caload"
                ? e`(${raw} & 0xffff)` : e`(${raw} | 0)`;
          shared = {
            valid, minimum, maximum,
            declarations: [
              letDecl(valid, exprConcat(
                e`${candidate.sourceArrayData} !== null && `,
                e`${info.boundExpression} >= 0 && `,
                e`${info.boundExpression} <= ${runtimeCoarseTripLimit} && `,
                e`${candidate.sourceArrayData}.length >= `,
                e`${info.boundExpression}`)),
              letDecl(minimum, e`2147483647`),
              letDecl(maximum, e`-2147483648`),
              stmt(exprConcat(
                e`for (let ${cursor} = 0; ${valid} && ${cursor} < `,
                e`${info.boundExpression}; ${cursor} += 1) {`)),
              stmt(e`  const ${raw} = ${candidate.sourceArrayData}[${
                cursor}];`, {kind: "const", def: raw, indexed: true}),
              stmt(exprConcat(e`  if (${raw} === undefined) { ${valid} = false; `,
                e`continue; }`)),
              stmt(e`  const ${element} = ${loaded};`,
                {kind: "const", def: element}),
              stmt(exprConcat(e`  if (${element} < ${minimum}) `,
                e`${minimum} = ${element};`)),
              stmt(exprConcat(e`  if (${element} > ${maximum}) `,
                e`${maximum} = ${element};`)),
              blockEnd(""),
            ],
          };
          indirectArrayRangePreambles.set(sharedKey, shared);
          preamble.push(...shared.declarations);
        }
        condition = operand(exprConcat(
          e`(${info.boundExpression} <= 0 || (`,
          e`${shared.valid} && ${shared.minimum} >= 0 && `,
          e`${shared.maximum} < ${candidate.arrayData}.length))`));
      } else if (candidate.kind === "bounded-index") {
        condition = operand(exprConcat(
          e`(${candidate.minimum} >= 0 && ${candidate.maximum} < `,
          e`${candidate.arrayData}.length)`));
        const outer = outermostCountedLoop || outermostPostDecrementLoop;
        if (outer) {
          declarationHeader = outer.header;
        }
      } else if (candidate.kind === "affine-local") {
        const indexSlot = candidate.slots[0];
        const directCountedInduction = indexSlot === info.slot;
        const step = directCountedInduction
          ? String(info.increment) : affineLocalStep(info, indexSlot);
        const stepExpression = step === null ? null : e`${step}`;
        const carried = step === null
          ? carriedCountedLocalRelation(info, candidate) : null;
        const packed = step === null && !carried
          ? packedAppendRelation(info, candidate) : null;
        const relatedOffsets = arrayRangeCheckCandidates
          .filter((other) => other.kind === "affine-local" &&
            other.arrayData === candidate.arrayData &&
            other.slots[0] === indexSlot &&
            info.loopBlocks.has(other.block))
          .map((other) => other.offset || 0);
        const minimumAffineOffset = Math.min(
          affineOffset, ...relatedOffsets);
        const maximumAffineOffset = Math.max(
          affineOffset, ...relatedOffsets);
        const cyclic = step === null
          ? carried || packed ? null : cyclicLocalRange(info, candidate) : null;
        const nestedCyclic = cyclic && outermostCountedLoop
          ? nestedCyclicLocalRange(
            info, candidate, cyclic, outermostCountedLoop) : null;
        const postDecrementOuter = !info.postDecrement && !cyclic && step !== null &&
          outermostPostDecrementLoop && info.initial === 0 &&
          Number.isInteger(info.bound) && info.bound > 0
          ? outermostPostDecrementLoop : null;
        let countedOuterSkipSlot = null;
        if (!info.postDecrement && !cyclic && step !== null &&
            outermostCountedLoop && info.initial === 0) {
          const outerOnlyWrites = [];
          for (const loopBlock of outermostCountedLoop.loopBlocks) {
            if (info.loopBlocks.has(loopBlock)) continue;
            const blockItems = cfg.blocks[loopBlock]?.insns || [];
            for (let position = 3; position < blockItems.length; position += 1) {
              const store = items[blockItems[position]]?.instruction;
              const storeOp = opOf(store);
              if (!/^istore(?:_[0-3])?$/.test(storeOp) ||
                  localIndex(store, storeOp) !== indexSlot) continue;
              const left = items[blockItems[position - 3]]?.instruction;
              const right = items[blockItems[position - 2]]?.instruction;
              const add = items[blockItems[position - 1]]?.instruction;
              const leftOp = opOf(left), rightOp = opOf(right);
              if (!/^iload(?:_[0-3])?$/.test(leftOp) ||
                  localIndex(left, leftOp) !== indexSlot ||
                  !/^iload(?:_[0-3])?$/.test(rightOp) ||
                  opOf(add) !== "iadd") continue;
              outerOnlyWrites.push(localIndex(right, rightOp));
            }
          }
          if (outerOnlyWrites.length === 1 &&
              !outermostCountedLoop.writtenSlots.has(outerOnlyWrites[0])) {
            countedOuterSkipSlot = outerOnlyWrites[0];
          }
        }
        const writesInPostDecrementOuter = postDecrementOuter
          ? [...postDecrementOuter.loopBlocks].flatMap((block) =>
            cfg.blocks[block]?.insns || []).filter((itemIndex) => {
            const instruction = items[itemIndex]?.instruction;
            const op = opOf(instruction);
            return op === "iinc"
              ? Number(instruction.varnum ?? instruction.arg) === indexSlot
              : /^istore(?:_[0-3])?$/.test(op) &&
                localIndex(instruction, op) === indexSlot;
          }).length : 0;
        if (directCountedInduction) {
          // javac commonly carries one induction local through consecutive
          // loops.  The second loop then has no literal store in its immediate
          // preheader even though the counted-loop proof still establishes the
          // unique positive update and invariant bound.  Snapshot that live
          // local at this loop header and guard its exact runtime interval.
          // This is deliberately a loop-local version: unlike a literal zero
          // start it must not be hoisted across an enclosing loop.
          const literalInitial = Number.isInteger(info.initial);
          const inductionStart = literalInitial
            ? e`${info.initial}` : e`${localName(info.slot)}`;
          const remaining =
            e`(${info.boundExpression} - ${inductionStart})`;
          const trips = exprConcat(e`(${remaining} <= 0 ? 0 : `,
            e`Math.ceil(${remaining} / ${info.increment}))`);
          const first = e`(${inductionStart} + ${minimumAffineOffset})`;
          const last = exprConcat(e`(${inductionStart} + (${trips} - 1) * `,
            e`${info.increment} + ${maximumAffineOffset})`);
          const next = e`(${inductionStart} + ${trips} * ${info.increment})`;
          const runtimeTerminationGuard = literalInitial ? "" : exprConcat(
            e`${next} >= ${inductionStart} && `,
            e`${next} <= 2147483647 && `);
          condition = operand(exprConcat(
            e`(${trips} === 0 || (${trips} <= `,
            e`${runtimeCoarseTripLimit} && ${first} >= 0 && `,
            e`${last} >= ${first} && ${last} <= 2147483647 && `,
            runtimeTerminationGuard,
            e`${last} < ${candidate.arrayData}.length))`));
          if (literalInitial && outermostCountedLoop && info.initial === 0) {
            declarationHeader = outermostCountedLoop.header;
          }
        } else if (packed) {
          const trips = sharedCountedTrips(info, preamble);
          const first = e`(${localName(packed.slot)} + ${
            minimumAffineOffset})`;
          const end = exprConcat(
            e`(${localName(packed.slot)} + ${trips} * `,
            e`${packed.incrementsPerTrip} + ${maximumAffineOffset} + `,
            e`${packed.postIncrement ? 0 : 1})`);
          condition = operand(exprConcat(
            e`(${trips} === 0 || (${trips} <= `,
            e`${runtimeCoarseTripLimit} && ${first} >= 0 && ${end} >= `,
            e`${first} && ${end} <= ${candidate.arrayData}.length && `,
            e`${end} <= 2147483647))`));
        } else if (carried) {
          const trips = sharedCountedTrips(info, preamble);
          const first = e`${minimumAffineOffset}`;
          const last = exprConcat(
            e`(${info.boundExpression} - ${info.increment} + `,
            e`${maximumAffineOffset})`);
          condition = operand(exprConcat(
            e`(${trips} === 0 || (${trips} <= `,
            e`${runtimeCoarseTripLimit} && ${first} >= 0 && ${last} >= `,
            e`${first} && ${last} < ${candidate.arrayData}.length && `,
            e`${last} <= 2147483647))`));
        } else if (info.postDecrement && step !== null) {
          const trips = e`Math.max(0, ${localName(info.slot)})`;
          const last = e`(${localName(indexSlot)} + (${trips} - 1) * ${
            stepExpression})`;
          condition = operand(exprConcat(
            e`(${trips} === 0 || (${trips} <= `,
            e`${runtimeCoarseTripLimit} && ${stepExpression} >= 0 && `,
            e`${localName(indexSlot)} >= 0 && ${last} < `,
            e`${candidate.arrayData}.length && ${last} <= 2147483647))`));
        } else if (nestedCyclic) {
          cyclicArrayRangeCandidates.add(candidate);
          const prefix = `ssaNestedCyclicRange${candidateIndex}`;
          const product = named(`${prefix}Product`);
          const base = named(`${prefix}Base`);
          const end = named(`${prefix}End`);
          preamble.push(
            constDecl(product, e`${localName(nestedCyclic.heightSlot)} * ${
              localName(cyclic.modulusSlot)}`, {pure: true}),
            constDecl(base, exprConcat(
              e`(${localName(cyclic.indexSlot)} - ${
                localName(cyclic.phaseSlot)}) - `,
              e`${localName(nestedCyclic.rowSlot)} * ${
                localName(cyclic.modulusSlot)}`), {pure: true}),
            constDecl(end, e`${base} + ${product}`, {pure: true}),
          );
          condition = operand(exprConcat(
            e`(${localName(cyclic.modulusSlot)} > 0 && `,
            e`${localName(nestedCyclic.heightSlot)} > 0 && `,
            e`${product} <= 2147483647 && `,
            e`${localName(cyclic.phaseSlot)} >= 0 && `,
            e`${localName(cyclic.phaseSlot)} < ${
              localName(cyclic.modulusSlot)} && `,
            e`${localName(nestedCyclic.rowSlot)} >= 0 && `,
            e`${localName(nestedCyclic.rowSlot)} < `,
            e`${localName(nestedCyclic.heightSlot)} && `,
            e`${base} >= 0 && ${end} <= ${candidate.arrayData}.length && `,
            e`${end} <= 2147483647)`));
          declarationHeader = nestedCyclic.outer.header;
        } else if (cyclic) {
          cyclicArrayRangeCandidates.add(candidate);
          const base = e`(${localName(cyclic.indexSlot)} - ${
            localName(cyclic.phaseSlot)})`;
          const end = e`(${base} + ${localName(cyclic.modulusSlot)})`;
          condition = operand(exprConcat(
            e`(${localName(cyclic.modulusSlot)} > 0 && `,
            e`${localName(cyclic.phaseSlot)} >= 0 && `,
            e`${localName(cyclic.phaseSlot)} < ${
              localName(cyclic.modulusSlot)} && `,
            e`${base} >= 0 && ${end} <= ${candidate.arrayData}.length && `,
            e`${end} <= 2147483647)`));
        } else if (Number.isInteger(countedOuterSkipSlot)) {
          const prefix = `ssaNestedAffineRange${candidateIndex}`;
          const outerTripsExpression = exprConcat(
            e`(${localName(outermostCountedLoop.slot)} >= `,
            e`${outermostCountedLoop.boundExpression} ? 0 : `,
            e`(${outermostCountedLoop.boundExpression} - `,
            e`${localName(outermostCountedLoop.slot)}))`);
          const innerTripsExpression =
            e`Math.max(0, ${info.boundExpression})`;
          const outerTrips = named(`${prefix}OuterTrips`);
          const innerTrips = named(`${prefix}InnerTrips`);
          const rowStride = named(`${prefix}RowStride`);
          const last = named(`${prefix}Last`);
          preamble.push(
            constDecl(outerTrips, outerTripsExpression, {pure: true}),
            constDecl(innerTrips, innerTripsExpression, {pure: true}),
            constDecl(rowStride, e`${innerTrips} * ${stepExpression} + ${
              localName(countedOuterSkipSlot)}`, {pure: true}),
            constDecl(last, exprConcat(
              e`${localName(indexSlot)} + (${outerTrips} - 1) * `,
              e`${rowStride} + (${innerTrips} - 1) * ${stepExpression}`),
            {pure: true}),
          );
          condition = operand(exprConcat(
            e`(${outerTrips} === 0 || ${innerTrips} === 0 || (`,
            e`${outerTrips} <= ${runtimeCoarseTripLimit} && `,
            e`${innerTrips} <= ${runtimeCoarseTripLimit} && ${
              stepExpression} >= 0 && `,
            e`${localName(countedOuterSkipSlot)} >= 0 && `,
            e`${localName(indexSlot)} >= 0 && ${last} < `,
            e`${candidate.arrayData}.length && ${last} <= 2147483647))`));
          declarationHeader = outermostCountedLoop.header;
        } else if (postDecrementOuter && writesInPostDecrementOuter === 1) {
          const outerTrips =
            e`Math.max(0, ${localName(postDecrementOuter.slot)})`;
          const totalTrips = e`(${outerTrips} * ${info.bound})`;
          const last = e`(${localName(indexSlot)} + (${totalTrips} - 1) * ${
            stepExpression})`;
          condition = operand(exprConcat(
            e`(${totalTrips} === 0 || (${outerTrips} <= `,
            e`${runtimeCoarseTripLimit} && ${stepExpression} >= 0 && `,
            e`${localName(indexSlot)} >= 0 && ${last} < `,
            e`${candidate.arrayData}.length && ${last} <= 2147483647))`));
          declarationHeader = postDecrementOuter.header;
        } else {
          const trips = sharedCountedTrips(info, preamble);
          const first = e`(${localName(indexSlot)} + ${
            minimumAffineOffset})`;
          const last = exprConcat(
            e`(${localName(indexSlot)} + ${maximumAffineOffset} + `,
            e`(${trips} - 1) * ${stepExpression})`);
          condition = operand(exprConcat(
            e`(${trips} === 0 || (${trips} <= ${runtimeCoarseTripLimit} && `,
            e`${stepExpression} >= 0 && `,
            e`${first} >= 0 && ${last} < ${candidate.arrayData}.length && `,
            e`${last} <= 2147483647))`));
        }
      } else if (candidate.kind === "scaled-local") {
        const relation = scaledCountedLocalRelation(info, candidate);
        if (!relation) continue;
        const boundInvariantInOuterLoops =
          info.boundSlot === null || enclosingCountedLoops.every((loop) =>
            !loop.writtenSlots.has(info.boundSlot));
        const hoistScaledGuard = Boolean(
          outermostCountedLoop && info.initial === 0 &&
          boundInvariantInOuterLoops);
        const trips = hoistScaledGuard
          ? e`Math.max(0, ${info.boundExpression})`
          : exprConcat(
            e`(${localName(info.slot)} >= ${info.boundExpression} ? 0 : `,
            e`(${info.boundExpression} - ${localName(info.slot)}))`);
        const firstCounter = relation.kind === "carried"
          ? e`0` : hoistScaledGuard ? e`0` : e`${localName(info.slot)}`;
        const first = exprConcat(
          e`(${firstCounter} * ${candidate.scale} + `,
          e`${candidate.offset})`);
        const last = exprConcat(
          e`((${info.boundExpression} - 1) * `,
          e`${candidate.scale} + ${candidate.offset})`);
        condition = operand(exprConcat(
          e`(${trips} === 0 || (${trips} <= ${runtimeCoarseTripLimit} && `,
          e`${first} >= 0 && ${last} >= ${first} && `,
          e`${last} <= 2147483647 && `,
          e`${last} < ${candidate.arrayData}.length))`));
        if (hoistScaledGuard) declarationHeader = outermostCountedLoop.header;
      } else {
        const recurrence =
          quotientProductRecurrence(info, candidate);
        if (recurrence) {
          candidate.provenNonZeroSlots = [recurrence.divisorSlot];
          const recurrenceKey = [
            info.header,
            recurrence.recurrenceSlot,
            recurrence.stepSlot,
            recurrence.divisorSlot,
            recurrence.multiplierSlot,
          ].join(":");
          let shared = quotientProductRangePreambles.get(recurrenceKey);
          if (!shared) {
            const prefix =
              `ssaArrayRangeRecurrence${quotientProductRangePreambles.size}`;
            const trips = exprConcat(
              e`(${localName(info.slot)} >= ${info.boundExpression} ? 0 : `,
              e`(${info.boundExpression} - ${localName(info.slot)}))`);
            const tripsName = named(`${prefix}Trips`);
            const lastName = named(`${prefix}Last`);
            const firstQuotient = named(`${prefix}FirstQuotientRaw`);
            const lastQuotient = named(`${prefix}LastQuotientRaw`);
            const firstProduct = named(`${prefix}FirstProduct`);
            const lastProduct = named(`${prefix}LastProduct`);
            const validName = named(`${prefix}Valid`);
            shared = {
              prefix,
              declarations: [
                constDecl(tripsName, trips, {pure: true}),
                constDecl(lastName, exprConcat(
                  e`${localName(recurrence.recurrenceSlot)} + `,
                  e`(${tripsName} - 1) * ${
                    localName(recurrence.stepSlot)}`), {pure: true}),
                constDecl(firstQuotient, exprConcat(
                  e`${localName(recurrence.recurrenceSlot)} / `,
                  e`${localName(recurrence.divisorSlot)}`), {pure: true}),
                constDecl(lastQuotient, e`${lastName} / ${
                  localName(recurrence.divisorSlot)}`, {pure: true}),
                constDecl(firstProduct, exprConcat(
                  e`Math.trunc(${firstQuotient}) * `,
                  e`${localName(recurrence.multiplierSlot)}`), {pure: true}),
                constDecl(lastProduct, exprConcat(
                  e`Math.trunc(${lastQuotient}) * `,
                  e`${localName(recurrence.multiplierSlot)}`), {pure: true}),
                constDecl(validName, exprConcat(
                  e`${tripsName} <= `,
                  e`${runtimeCoarseTripLimit} && `,
                  e`${localName(recurrence.divisorSlot)} !== 0 && `,
                  e`${lastName} >= -2147483648 && `,
                  e`${lastName} <= 2147483647 && `,
                  e`${firstProduct} >= -2147483648 && `,
                  e`${firstProduct} <= 2147483647 && `,
                  e`${lastProduct} >= -2147483648 && `,
                  e`${lastProduct} <= 2147483647`), {pure: true}),
              ],
            };
            quotientProductRangePreambles.set(recurrenceKey, shared);
            preamble.push(...shared.declarations);
          }
          const prefix = `ssaArrayRangeInterval${candidateIndex}`;
          const firstIndex = named(`${prefix}FirstIndex`);
          const lastIndex = named(`${prefix}LastIndex`);
          preamble.push(
            constDecl(firstIndex, exprConcat(
              e`${named(`${shared.prefix}FirstProduct`)} + `,
              e`${localName(recurrence.offsetSlot)}`), {pure: true}),
            constDecl(lastIndex, exprConcat(
              e`${named(`${shared.prefix}LastProduct`)} + `,
              e`${localName(recurrence.offsetSlot)}`), {pure: true}),
          );
          condition = operand(exprConcat(
            e`(${named(`${shared.prefix}Trips`)} === 0 || (`,
            e`${named(`${shared.prefix}Valid`)} && `,
            e`${firstIndex} >= 0 && ${lastIndex} >= 0 && `,
            e`${firstIndex} < ${candidate.arrayData}.length && `,
            e`${lastIndex} < ${candidate.arrayData}.length && `,
            e`${firstIndex} <= 2147483647 && `,
            e`${lastIndex} <= 2147483647))`));
        } else {
          const baseSlot = candidate.slots.find((slot) => slot !== info.slot);
          const trips = e`(${info.boundExpression} - ${
            localName(info.slot)})`;
          const start = e`((${localName(baseSlot)} + ${
            localName(info.slot)}) | 0)`;
          condition = operand(exprConcat(
            e`(${localName(info.slot)} >= ${info.boundExpression} || `,
            e`((${start} >>> 0) <= ${candidate.arrayData}.length - ${
              trips}))`));
        }
      }
      if (eagerEntryFieldArrayData.has(candidate.arrayData) ||
          entryStaticArrayData.has(candidate.arrayData) &&
          (countedLoopDepths.get(info.header) || 0) > 0) {
        // A lexical generator continuation could otherwise reuse this range
        // proof after another Java thread rebinds the array. Mark the method
        // so its wrapper snapshots and verifies all contributing array
        // locations before resuming lexical state. This applies equally to
        // already-direct and first-use-linked static locations.
        fieldBackedArrayRangeCandidateCount += 1;
      }
      if (!unconditionallyNonNullEntryArrayData.has(candidate.arrayData)) {
        condition = operand(
          e`(${candidate.arrayData} !== null && ${condition})`);
      }
      if (info.increment > 1 && candidate.kind === "affine-local") {
        // The positive-stride affine guard above includes both an exact
        // ceiling trip count and the runtime trip cap, so it is also a proof
        // that this loop can execute atomically after the entry bailout.
        tripBoundedArrayRangeGuards.add(variable);
      }
      const guardKey = `${declarationHeader}\0${condition}`;
      const existingGuard = arrayRangeGuardByCondition.get(guardKey);
      if (existingGuard) {
        candidate.rangeGuardVariable = existingGuard;
        const variables = arrayRangeGuardVariables.get(info.header) || [];
        if (!variables.includes(existingGuard)) variables.push(existingGuard);
        arrayRangeGuardVariables.set(info.header, variables);
        const proven = new Set([
          ...(arrayRangeGuardNonZeroLocals.get(existingGuard) || []),
          ...(candidate.provenNonZeroSlots || []),
        ]);
        arrayRangeGuardNonZeroLocals.set(existingGuard, [...proven]);
        for (const plan of plans) {
          if (!plan?.lines) continue;
          plan.lines = substituteInLines(plan.lines,
            new Map([[candidate.marker, [{ref: existingGuard}]]]));
        }
        coalescedArrayRangeGuardCount += 1;
        continue;
      }
      arrayRangeGuardByCondition.set(guardKey, variable);
      candidate.rangeGuardVariable = variable;
      const declarations =
        arrayRangeGuardDeclarations.get(declarationHeader) || [];
      declarations.push(...preamble.map((line) =>
        recordCheckedLeafLine("guardDeclaration", line, [variable])),
      recordCheckedLeafLine("guardDeclaration",
        constDecl(variable, e`${condition}`, {pure: true}), [variable]));
      arrayRangeGuardDeclarations.set(declarationHeader, declarations);
      if (declarationHeader !== info.header) {
        hoistedArrayRangeGuardCount += 1;
      }
      // A guard emitted at its own first loop header is just as transactional
      // as one hoisted across nested loops when no guest effect precedes that
      // header. Version the complete entry region in either case: a failed
      // predicate returns to canonical execution before mutation, while the
      // successful arm can remove every dominated per-access check.
      const transactionalOwnHeader = declarationHeader === info.header &&
        info.increment > 1 && candidate.kind === "affine-local";
      if ((declarationHeader !== info.header || transactionalOwnHeader) &&
          !hasEffectBeforeLoopHeader(declarationHeader)) {
        trustedHoistedRangeGuards.add(variable);
        const bailouts = rangeBailoutGuardsByHeader.get(declarationHeader) || [];
        bailouts.push(variable);
        rangeBailoutGuardsByHeader.set(declarationHeader, bailouts);
      }
      if (selectedPackedAppend &&
          trustedHoistedRangeGuards.has(variable) &&
          Number.isInteger(selectedPackedAppend.slot) &&
          Number.isInteger(selectedPackedAppend.incrementsPerTrip) &&
          selectedPackedAppend.incrementsPerTrip > 0) {
        const lastItem = Math.max(...[...info.loopBlocks].flatMap(
          (loopBlock) => cfg.blocks[loopBlock]?.insns || []));
        if (!packedArrayCapacityFacts.some((fact) =>
          fact.arrayData === candidate.arrayData &&
          fact.cursorSlot === selectedPackedAppend.slot &&
          fact.lastItem === lastItem)) {
          packedArrayCapacityFacts.push({
            arrayData: candidate.arrayData,
            cursorSlot: selectedPackedAppend.slot,
            stride: selectedPackedAppend.incrementsPerTrip,
            lastItem,
            declarationHeader,
            tripsVariable: countedRangeTripValues.get(info.header)?.variable,
            guardVariable: variable,
          });
        }
      }
      const variables = arrayRangeGuardVariables.get(info.header) || [];
      variables.push(variable);
      arrayRangeGuardVariables.set(info.header, variables);
      arrayRangeGuardDataVariables.set(variable, candidate.arrayData);
      arrayRangeGuardNonZeroLocals.set(
        variable, candidate.provenNonZeroSlots || []);
      for (const plan of plans) {
        if (!plan?.lines) continue;
        plan.lines = substituteInLines(plan.lines,
          new Map([[candidate.marker, [{ref: variable}]]]));
      }
    }
    if (typeof process !== "undefined" &&
        process.env?.JVM_TRACE_STRUCTURED_ARRAY_RANGES === "1" &&
        (countedLoopInfos.size > 0 || arrayRangeCheckCandidates.length > 0)) {
      console.error("[structured-array-ranges]", JSON.stringify({
        method: `${this.jit.jvm.findClassNameForMethod?.(method) || "?"}.` +
          `${method.name}${method.descriptor}`,
        loops: [...countedLoopInfos.values()].map((info) => ({
          header: info.header,
          slot: info.slot,
          initial: info.initial,
          increment: info.increment,
          bound: info.boundExpression,
          blocks: [...info.loopBlocks],
          unsafe: loopHasAtomicUnsafeOperation(info),
        })),
        candidates: arrayRangeCheckCandidates.map((candidate) => ({
          kind: candidate.kind,
          block: candidate.block,
          slot: candidate.slots?.[0] ?? null,
          guarded: Boolean(candidate.rangeGuardVariable),
        })),
      }));
    }
    const provenDeferredStaticArrayAccesses = new Set();
    const itemBlocks = new Map();
    for (const candidateBlock of cfg.blocks) {
      for (const itemIndex of candidateBlock?.insns || []) {
        itemBlocks.set(itemIndex, candidateBlock.id);
      }
    }
    const localWriteSlot = (instruction) => {
      const op = opOf(instruction);
      if (op === "iinc") {
        return Number(instruction.varnum ?? instruction.arg);
      }
      return /^[a-z]store(?:_[0-3])?$/.test(op)
        ? localIndex(instruction, op) : null;
    };
    const directIntegerCopySource = (itemIndex) => {
      const instruction = items[itemIndex]?.instruction;
      const op = opOf(instruction);
      if (!/^istore(?:_[0-3])?$/.test(op)) return null;
      const blockId = itemBlocks.get(itemIndex);
      const blockItems = cfg.blocks[blockId]?.insns || [];
      const position = blockItems.indexOf(itemIndex);
      if (position <= 0) return null;
      const load = items[blockItems[position - 1]]?.instruction;
      const loadOp = opOf(load);
      return /^iload(?:_[0-3])?$/.test(loadOp)
        ? localIndex(load, loadOp) : null;
    };
    const isZeroIntegerStore = (itemIndex) => {
      const instruction = items[itemIndex]?.instruction;
      const op = opOf(instruction);
      if (!/^istore(?:_[0-3])?$/.test(op)) return false;
      const blockId = itemBlocks.get(itemIndex);
      const blockItems = cfg.blocks[blockId]?.insns || [];
      const position = blockItems.indexOf(itemIndex);
      return position > 0 && constantInstructionValue(
        items[blockItems[position - 1]]?.instruction) === 0;
    };
    const blockDominates = (candidate, target) => {
      if (candidate === target) return true;
      if (candidate === cfg.entry) return true;
      const pending = [cfg.entry];
      const visited = new Set([candidate]);
      while (pending.length) {
        const block = pending.pop();
        if (visited.has(block)) continue;
        if (block === target) return false;
        visited.add(block);
        for (const successor of cfg.succ[block] || []) {
          if (!visited.has(successor)) pending.push(successor);
        }
      }
      return true;
    };
    const itemDominates = (candidate, target) => {
      const candidateBlock = itemBlocks.get(candidate);
      const targetBlock = itemBlocks.get(target);
      if (!Number.isInteger(candidateBlock) ||
          !Number.isInteger(targetBlock)) return false;
      return candidateBlock === targetBlock
        ? candidate <= target
        : blockDominates(candidateBlock, targetBlock);
    };
    const localWrites = (slot, firstItem, lastItem = items.length - 1) => {
      const writes = [];
      for (let itemIndex = firstItem;
        itemIndex <= lastItem; itemIndex += 1) {
        if (!normalReachableItems.has(itemIndex)) continue;
        const instruction = items[itemIndex]?.instruction;
        if (localWriteSlot(instruction) === slot) {
          writes.push({itemIndex, instruction});
        }
      }
      return writes;
    };
    const matchingCursorLoopForWrite = (fact, cursorSlot, itemIndex) =>
      [...countedLoopInfos.values()].some((loop) =>
        loop.slot === cursorSlot && loop.boundSlot === fact.cursorSlot &&
        loop.increment === fact.stride && loop.loopBlocks.has(
          itemBlocks.get(itemIndex)));
    const boundedStrideCursorMemo = new Map();
    const compactingCursorFacts = [];
    const boundedStrideCursor = (fact, cursorSlot, throughItem) => {
      const key = `${packedArrayCapacityFacts.indexOf(fact)}:` +
        `${cursorSlot}:${throughItem}`;
      if (boundedStrideCursorMemo.has(key)) {
        return boundedStrideCursorMemo.get(key);
      }
      const writes = localWrites(
        cursorSlot, fact.lastItem + 1, throughItem);
      const initializations = writes.filter(({itemIndex}) =>
        isZeroIntegerStore(itemIndex));
      const increments = writes.filter(({instruction}) =>
        opOf(instruction) === "iinc" &&
        Number(instruction.incr ?? 0) === fact.stride);
      const initializedBeforeUse = initializations.length === 1 &&
        itemDominates(initializations[0].itemIndex, throughItem);
      const onlyBoundedUpdates =
        writes.length === initializations.length + increments.length &&
        increments.every(({itemIndex}) =>
          matchingCursorLoopForWrite(fact, cursorSlot, itemIndex));
      const boundChanged = localWrites(
        fact.cursorSlot, fact.lastItem + 1, throughItem).length > 0;
      const proven = initializedBeforeUse && onlyBoundedUpdates &&
        !boundChanged;
      boundedStrideCursorMemo.set(key, proven);
      return proven;
    };
    const compactingCursorRelation = (fact, access) => {
      const affine = access.indexAffine;
      if (!Number.isInteger(affine?.slot) ||
          !Number.isInteger(affine.offset) || affine.offset < 0 ||
          affine.offset >= fact.stride) return false;
      for (const scanLoop of countedLoopInfos.values()) {
        if (scanLoop.increment !== fact.stride ||
            !Number.isInteger(scanLoop.boundSlot) ||
            !scanLoop.loopBlocks.has(access.block) ||
            scanLoop.header === access.block ||
            !boundedStrideCursor(
              fact, scanLoop.boundSlot, access.itemIndex)) continue;
        const preheaderItems = cfg.blocks[scanLoop.preheader]?.insns || [];
        const scanInitializers = preheaderItems.filter((itemIndex) =>
          localWriteSlot(items[itemIndex]?.instruction) === scanLoop.slot &&
          Number.isInteger(directIntegerCopySource(itemIndex)));
        if (scanInitializers.length !== 1) continue;
        const scanInitializer = scanInitializers[0];
        const compactSlot = directIntegerCopySource(scanInitializer);
        if (!Number.isInteger(compactSlot) ||
            compactSlot === scanLoop.slot ||
            affine.slot !== scanLoop.slot && affine.slot !== compactSlot) {
          continue;
        }

        // The lagging cursor may advance once per scan iteration. Starting
        // equal to the scan cursor and using the same stride proves
        // `compact <= scan <= bound` at every loop header and
        // `compact + offset < capacity` at every marked access.
        const compactLoopWrites = [...scanLoop.loopBlocks].flatMap(
          (loopBlock) => (cfg.blocks[loopBlock]?.insns || [])
            .filter((itemIndex) =>
              localWriteSlot(items[itemIndex]?.instruction) === compactSlot));
        if (compactLoopWrites.length !== 1) continue;
        const compactIncrement =
          items[compactLoopWrites[0]]?.instruction;
        if (opOf(compactIncrement) !== "iinc" ||
            Number(compactIncrement.incr ?? 0) !== fact.stride) continue;

        const compactCopies = localWrites(
          compactSlot, fact.lastItem + 1)
          .filter(({instruction}) => opOf(instruction) !== "iinc");
        if (compactCopies.length !== 1) continue;
        const compactInitializer = compactCopies[0].itemIndex;
        const carriedSlot = directIntegerCopySource(compactInitializer);
        if (!Number.isInteger(carriedSlot) || carriedSlot === compactSlot ||
            carriedSlot === scanLoop.slot ||
            !itemDominates(compactInitializer, scanInitializer)) continue;

        const carriedZeroes = localWrites(
          carriedSlot, fact.lastItem + 1, compactInitializer)
          .filter(({itemIndex}) => isZeroIntegerStore(itemIndex));
        if (carriedZeroes.length !== 1) continue;
        const carriedZero = carriedZeroes[0].itemIndex;
        if (!itemDominates(carriedZero, compactInitializer)) continue;
        const carriedWrites = localWrites(carriedSlot, carriedZero);
        if (carriedWrites.length !== 2 ||
            !isZeroIntegerStore(carriedWrites[0].itemIndex)) continue;
        const carriedCopy = carriedWrites[1].itemIndex;
        if (directIntegerCopySource(carriedCopy) !== compactSlot) continue;

        const compactWrites = localWrites(compactSlot, carriedZero);
        if (compactWrites.length !== 2 ||
            compactWrites[0].itemIndex !== compactInitializer ||
            compactWrites[1].itemIndex !== compactLoopWrites[0]) continue;
        if (!compactingCursorFacts.some((relation) =>
          relation.fact === fact && relation.compactSlot === compactSlot &&
          relation.carriedSlot === carriedSlot &&
          relation.scanSlot === scanLoop.slot &&
          relation.boundSlot === scanLoop.boundSlot)) {
          compactingCursorFacts.push({
            fact,
            compactSlot,
            carriedSlot,
            scanSlot: scanLoop.slot,
            boundSlot: scanLoop.boundSlot,
            lastItem: Math.max(...[...scanLoop.loopBlocks].flatMap(
              (loopBlock) => cfg.blocks[loopBlock]?.insns || [])),
          });
        }
        return true;
      }
      return false;
    };
    for (const access of deferredStaticArrayAccesses) {
      const affine = access.indexAffine;
      if (!Number.isInteger(affine?.slot) ||
          !Number.isInteger(affine.offset)) continue;
      for (const fact of packedArrayCapacityFacts) {
        if (fact.arrayData !== access.arrayData ||
            fact.lastItem >= access.itemIndex || affine.offset < 0 ||
            affine.offset >= fact.stride) continue;
        const directlyBounded = [...countedLoopInfos.values()].some(
          (candidateLoop) =>
          candidateLoop.slot === affine.slot &&
          candidateLoop.boundSlot === fact.cursorSlot &&
          candidateLoop.increment === fact.stride &&
          candidateLoop.loopBlocks.has(access.block) &&
          candidateLoop.header !== access.block) &&
          boundedStrideCursor(fact, affine.slot, access.itemIndex);
        if (!directlyBounded &&
            !compactingCursorRelation(fact, access)) continue;
        provenDeferredStaticArrayAccesses.add(access.marker);
        break;
      }
    }
    // Once a packed append loop has established `cursor <= capacity`, reuse
    // that same entry-versioned predicate for later primitive accesses whose
    // cursors are structurally bounded by the packed cursor.  This is the
    // direct-view counterpart of deferred-static specialization above; the
    // proof is based on CFG/local recurrences, not field or method identity.
    for (const access of primitiveArrayAccessCandidates) {
      for (const fact of packedArrayCapacityFacts) {
        if (fact.arrayData !== access.arrayData ||
            typeof fact.guardVariable !== "string" ||
            fact.lastItem >= access.itemIndex ||
            !compactingCursorRelation(fact, access)) continue;
        for (const candidatePlan of plans) {
          if (!candidatePlan?.lines) continue;
          candidatePlan.lines = substituteInLines(candidatePlan.lines,
            new Map([[access.marker, [{ref: fact.guardVariable}]]]));
        }
        access.structuralGuard = fact.guardVariable;
        if (access.rangeCandidate) {
          access.rangeCandidate.structuralGuard = fact.guardVariable;
        }
        break;
      }
    }
    let provenCheckedCallAdmissionCount = 0;
    let clippedAffineRegionAdmission = null;
    const checkedAdmissionOwnedCaptureRefreshes = new Set();
    let preflightedCheckedLeafVerifier = null;
    let preflightedCheckedLeafArgumentSlots = null;
    let preflightedCheckedLeafArgumentLimit = null;
    const argumentLocalSlot = (expression) => {
      const loaded = localLoads.get(expression);
      if (Number.isInteger(loaded)) return loaded;
      const direct = /^local(\d+)$/.exec(expression || "");
      return direct ? Number(direct[1]) : null;
    };
    for (const candidate of checkedCallAdmissionCandidates) {
      const candidateLines = plans[candidate.block]?.lines;
      if (!candidateLines) continue;
      const start = candidateLines.indexOf(candidate.startMarker);
      const end = candidateLines.indexOf(candidate.endMarker);
      if (start < 0 || end <= start) continue;
      const plan = candidate.plan;
      if (plan.kind === "clipped-affine-fill") {
        const xRange = candidate.argumentRanges[plan.xArgument];
        const countRange = candidate.argumentRanges[plan.countArgument];
        const captures = candidate.captureExpressions;
        const specializedCache = this.jit.checkedLeafCaptureCaches[
          candidate.captureCacheId];
        if (specializedCache?.dirty &&
            specializedCache.specializationInitialized) {
          this.jit.refreshCheckedLeafCaptureCache(candidate.captureCacheId);
        }
        const specializedCaptures = Boolean(
          specializedCache?.specializationInitialized &&
          specializedCache.specializedMatches === true &&
          [
            plan.topCapture, plan.bottomCapture, plan.leftCapture,
            plan.rightCapture, plan.widthCapture,
          ].every((position) => Number.isInteger(
            specializedCache[`specializedValue${position}`])) &&
          specializedCache[`specializedValue${
            plan.arrayDataCapture}`] !== null);
        const captureExpression = (position) =>
          specializedCaptures && Number.isInteger(
            specializedCache[`specializedValue${position}`])
            ? String(specializedCache[`specializedValue${position}`] | 0)
            : specializedCaptures && position === plan.arrayDataCapture
              ? specializedCheckedCapture(
                candidate.captureCacheId, position)
              : captures[position];
        const indexedCaptures = [
          plan.topCapture, plan.bottomCapture, plan.leftCapture,
          plan.rightCapture, plan.widthCapture, plan.arrayDataCapture,
        ].map(captureExpression);
        const sumMinimum = xRange && countRange
          ? xRange.minimum + countRange.minimum : NaN;
        const sumMaximum = xRange && countRange
          ? xRange.maximum + countRange.maximum : NaN;
        const maximumSafeLeft = xRange && countRange
          ? Math.min(
            2147483647,
            2147483647 - countRange.maximum,
            countRange.minimum + xRange.minimum - (-2147483648),
          ) : NaN;
        if (candidate.replacement &&
            xRange && countRange && indexedCaptures.every(Boolean) &&
            Number.isInteger(candidate.captureCacheId) &&
            typeof candidate.captureCacheVariable === "string" &&
            sumMinimum >= -2147483648 && sumMaximum <= 2147483647 &&
            Number.isSafeInteger(maximumSafeLeft) &&
            Number.isInteger(plan.maximumTrips) &&
            plan.maximumTrips > 0) {
          const [top, bottom, left, right, width, arrayDataCapture] =
            indexedCaptures;
          const guard = `ssaCheckedAdmissionGuard${
            directCheckedAdmissionFallbacks.size}`;
          const derivedGuardKey =
            this.jit.registerCheckedLeafCaptureDerivedGuard(
              candidate.captureCacheId);
          const guardCondition =
            `${arrayDataCapture} !== null && ${top} >= 0 && ` +
            `${bottom} >= ${top} && ${left} >= 0 && ` +
            `${bottom} - ${top} <= ${plan.maximumTrips} && ` +
            `${left} <= ${maximumSafeLeft} && ${right} >= ${left} && ` +
            `${right} - ${left} <= ${plan.maximumTrips} && ` +
            `${width} > 0 && ${right} <= ${width} && ` +
            `${bottom} <= Math.floor(2147483647 / ${width}) && ` +
            `${bottom} <= Math.floor(${arrayDataCapture}.length / ${width})`;
          const preferOutlinedClippedLeaf =
            specializedCaptures &&
            structured.loopHeaders.size === 1 &&
            callSites.size === 1;
          if (specializedCaptures) {
            checkedAdmissionOwnedCaptureRefreshes.add(
              candidate.captureCacheId);
            const verifier = `ssaCheckedAdmissionVerifier${
              candidate.captureCacheId}_${derivedGuardKey}`;
            const cache = specializedCache;
            const jit = this.jit;
            const specializedArray = cache[
              `specializedValue${plan.arrayDataCapture}`];
            methodSpecializedCheckedCaptures[verifier] = () => {
              if (cache.dirty) {
                jit.refreshCheckedLeafCaptureCache(candidate.captureCacheId);
              }
              if (!cache.specializedMatches) return false;
              const topValue = cache[
                `specializedValue${plan.topCapture}`] | 0;
              const bottomValue = cache[
                `specializedValue${plan.bottomCapture}`] | 0;
              const leftValue = cache[
                `specializedValue${plan.leftCapture}`] | 0;
              const rightValue = cache[
                `specializedValue${plan.rightCapture}`] | 0;
              const widthValue = cache[
                `specializedValue${plan.widthCapture}`] | 0;
              const accepted = specializedArray !== null &&
                topValue >= 0 && bottomValue >= topValue &&
                leftValue >= 0 &&
                bottomValue - topValue <= plan.maximumTrips &&
                leftValue <= maximumSafeLeft &&
                rightValue >= leftValue &&
                rightValue - leftValue <= plan.maximumTrips &&
                widthValue > 0 && rightValue <= widthValue &&
                bottomValue <= Math.floor(2147483647 / widthValue) &&
                bottomValue <= Math.floor(
                  specializedArray.length / widthValue);
              cache[derivedGuardKey] = accepted;
              return accepted;
            };
            // Initial class/static resolution happened during compilation;
            // prime the versioned predicate so the first admitted execution
            // has the same one-branch entry as subsequent executions.
            methodSpecializedCheckedCaptures[verifier]();
            if (preferOutlinedClippedLeaf) {
              preflightedCheckedLeafVerifier =
                methodSpecializedCheckedCaptures[verifier];
            }
            directEntryCheckedAdmissionDeclarations.push(
              `if (${candidate.captureCacheVariable}.${derivedGuardKey} ` +
                `!== true && !${verifier}()) ` +
                "return helpers.asyncInvokeSentinel();",
            );
          } else {
            directEntryCheckedAdmissionDeclarations.push(
              `let ${guard} = ${candidate.captureCacheVariable}.` +
                `${derivedGuardKey};`,
              `if (${guard} === undefined) {`,
              `  ${guard} = (${guardCondition});`,
              `  ${candidate.captureCacheVariable}.${derivedGuardKey} = ` +
                `${guard};`,
              `}`,
              `if (!${guard}) return helpers.asyncInvokeSentinel();`,
            );
          }
          let admittedReplacement = candidate.replacement;
          if (preferOutlinedClippedLeaf) {
            const helper = `ssaCheckedClippedFill${candidate.itemIndex}`;
            hasOutlinedClippedLeaf = true;
            const topValue = specializedCache[
              `specializedValue${plan.topCapture}`] | 0;
            const bottomValue = specializedCache[
              `specializedValue${plan.bottomCapture}`] | 0;
            const leftValue = specializedCache[
              `specializedValue${plan.leftCapture}`] | 0;
            const rightValue = specializedCache[
              `specializedValue${plan.rightCapture}`] | 0;
            const widthValue = specializedCache[
              `specializedValue${plan.widthCapture}`] | 0;
            const destination = specializedCache[
              `specializedValue${plan.arrayDataCapture}`];
            methodSpecializedCheckedCaptures[helper] =
              function (x, y, count, value) {
                if (y < topValue || y >= bottomValue) return;
                if (x < leftValue) {
                  count -= leftValue - x;
                  x = leftValue;
                }
                if (x + count > rightValue) count = rightValue - x;
                if (count <= 0) return;
                let pixel = y * widthValue + x;
                for (const end = pixel + count; pixel < end; pixel += 1) {
                  destination[pixel] = value;
                }
              };
            admittedReplacement = [
              stmt(exprConcat(
                e`${helper}(`,
                argumentListExpression([
                  plan.xArgument, plan.yArgument,
                  plan.countArgument, plan.valueArgument,
                ].map((position) => candidate.args[position])),
                e`); /*__SSA_SAFE_ARITHMETIC_CALL__*/`), {pinned: true}),
            ];
          }
          const marker = named(`__JVM_DIRECT_CHECKED_ADMISSION_${
            directCheckedAdmissionFallbacks.size}__`);
          directCheckedAdmissionFallbacks.set(marker, {
            direct: admittedReplacement,
            ordinary: candidateLines.slice(start + 1, end),
          });
          candidateLines.splice(start, end - start + 1, st`${marker}`);
          provenCheckedCallAdmissionCount += 1;
          clippedAffineRegionAdmission = {
            top,
            bottom,
            maximumTrips: plan.maximumTrips,
          };
        } else {
          candidateLines.splice(end, 1);
          candidateLines.splice(start, 1);
        }
        continue;
      }
      const arrayData = candidate.argumentArrays[plan.arrayArgument]?.data;
      const lowerExpression = candidate.args[plan.lowerArgument];
      const lowerSlot = argumentLocalSlot(lowerExpression);
      const upperSlot = argumentLocalSlot(
        candidate.args[plan.upperArgument]);
      const lowerIsZero = /^\(?0\)?$/.test(lowerExpression || "");
      const fact = packedArrayCapacityFacts.find((capacity) =>
        capacity.arrayData === arrayData &&
        capacity.cursorSlot === upperSlot &&
        capacity.stride === plan.stride &&
        capacity.lastItem < candidate.itemIndex &&
        localWrites(upperSlot, capacity.lastItem + 1,
          candidate.itemIndex).length === 0);
      const compactingFact = compactingCursorFacts.find((relation) => {
          const lowerWritesAfter = localWrites(
            lowerSlot, relation.lastItem + 1, candidate.itemIndex);
          const lowerPreserved = lowerWritesAfter.length === 0 ||
            lowerWritesAfter.length === 1 &&
            directIntegerCopySource(lowerWritesAfter[0].itemIndex) ===
              relation.compactSlot &&
            itemDominates(lowerWritesAfter[0].itemIndex,
              candidate.itemIndex);
          return relation.fact.arrayData === arrayData &&
            relation.fact.stride === plan.stride &&
            relation.carriedSlot === lowerSlot &&
            relation.boundSlot === upperSlot &&
            relation.lastItem < candidate.itemIndex && lowerPreserved &&
            localWrites(upperSlot, relation.lastItem + 1,
              candidate.itemIndex).length === 0;
      });
      const capacityFact = lowerIsZero && fact
        ? fact : compactingFact?.fact;
      if (capacityFact) {
        const maximumRecords = Number(plan.maximumRecords);
        const needsTighterTripGuard = Number.isInteger(maximumRecords) &&
          maximumRecords > 0 &&
          maximumRecords < runtimeCoarseTripLimit;
        if (needsTighterTripGuard &&
            Number.isInteger(capacityFact.declarationHeader) &&
            typeof capacityFact.tripsVariable === "string") {
          const guard = `ssaCheckedAdmissionGuard${
            directCheckedAdmissionFallbacks.size}`;
          const declarations = arrayRangeGuardDeclarations.get(
            capacityFact.declarationHeader) || [];
          declarations.push(recordCheckedLeafLine("guardDeclaration",
            `const ${guard} = ` +
            `${capacityFact.tripsVariable} <= ${maximumRecords};`, [guard]));
          arrayRangeGuardDeclarations.set(
            capacityFact.declarationHeader, declarations);
          const bailouts = rangeBailoutGuardsByHeader.get(
            capacityFact.declarationHeader) || [];
          bailouts.push(guard);
          rangeBailoutGuardsByHeader.set(
            capacityFact.declarationHeader, bailouts);
          const marker = named(`__JVM_DIRECT_CHECKED_ADMISSION_${
            directCheckedAdmissionFallbacks.size}__`);
          directCheckedAdmissionFallbacks.set(marker, {
            direct: candidate.replacement,
            ordinary: candidateLines.slice(start + 1, end),
          });
          candidateLines.splice(start, end - start + 1, st`${marker}`);
          provenCheckedCallAdmissionCount += 1;
        } else if (!needsTighterTripGuard) {
          candidateLines.splice(
            start, end - start + 1, ...candidate.replacement);
          provenCheckedCallAdmissionCount += 1;
        } else {
          candidateLines.splice(end, 1);
          candidateLines.splice(start, 1);
        }
      } else {
        candidateLines.splice(end, 1);
        candidateLines.splice(start, 1);
      }
    }
    // A fully admitted packed-record scan feeding one clipped affine writer
    // has a finite structural work bound.  Guard the conservative
    // `records² * rows` product before the first guest effect, then make every
    // loop in the admitted region scheduler-atomic. Large or unusual inputs
    // return to canonical execution; the ordinary path retains all polls.
    // This relies only on the verified capacity/compaction/callee contracts.
    if (clippedAffineRegionAdmission &&
        checkedCallAdmissionCandidates.length === callSites.size &&
        provenCheckedCallAdmissionCount === callSites.size &&
        packedArrayCapacityFacts.length === 1 &&
        compactingCursorFacts.length > 0 &&
        (code.code.exceptionTable || []).length === 0) {
      const fact = packedArrayCapacityFacts[0];
      entryDominatedRangeGuards.add(fact.guardVariable);
      const records = "ssaPackedAtomicRecords";
      const rows = "ssaPackedAtomicRows";
      directEntryCheckedAdmissionDeclarations.push(
        `const ${records} = ${fact.arrayData} === null ? ` +
          `${clippedAffineRegionAdmission.maximumTrips + 1} : ` +
          `Math.ceil(${fact.arrayData}.length / ${fact.stride});`,
        `const ${rows} = ${clippedAffineRegionAdmission.bottom} - ` +
          `${clippedAffineRegionAdmission.top};`,
        `if (${records} < 0 || ${records} > ` +
          `${clippedAffineRegionAdmission.maximumTrips} || ${rows} < 0 || ` +
          `${records} * ${records} * ${rows} > 1000000) ` +
          "return helpers.asyncInvokeSentinel();",
      );
      const regionRangeGuards = new Set();
      for (const access of primitiveArrayAccessCandidates) {
        const affine = access.indexAffine;
        if (access.arrayData !== fact.arrayData ||
            !Number.isInteger(affine?.slot) ||
            !Number.isInteger(affine.offset) || affine.offset < 0 ||
            affine.offset >= fact.stride) continue;
        const bounded = boundedStrideCursor(
          fact, affine.slot, access.itemIndex) ||
          compactingCursorRelation(fact, access);
        const variable = access.rangeCandidate?.rangeGuardVariable;
        if (bounded && typeof variable === "string" &&
            variable !== fact.guardVariable) {
          regionRangeGuards.add(variable);
        }
      }
      if (regionRangeGuards.size) {
        for (const [header, declarations] of arrayRangeGuardDeclarations) {
          // The guard's own declaration is the record whose definition is
          // that guard; its preamble records define other names and stay.
          arrayRangeGuardDeclarations.set(header, declarations.filter(
            (line) => !regionRangeGuards.has(recordOf(line)?.def)));
        }
        for (const [header, variables] of arrayRangeGuardVariables) {
          arrayRangeGuardVariables.set(header, [...new Set(variables.map(
            (variable) => regionRangeGuards.has(variable)
              ? fact.guardVariable : variable))]);
        }
        for (const [header, variables] of rangeBailoutGuardsByHeader) {
          // The packed capacity guard already bails at its dominating
          // pre-effect header. A later loop does not need to retest it.
          rangeBailoutGuardsByHeader.set(header, [...new Set(
            variables.filter((variable) =>
              !regionRangeGuards.has(variable) &&
              !(variable === fact.guardVariable &&
                header !== fact.declarationHeader))) ]);
        }
        // Every superseded guard is an emitted name, so each mention is an
        // operand reference in its statement's parts list and is retargeted
        // by substitution, not by matching the rendered text.
        const guardReplacements = new Map([...regionRangeGuards].map(
          (variable) => [variable, [{ref: fact.guardVariable}]]));
        for (const candidatePlan of plans) {
          if (!candidatePlan?.lines) continue;
          candidatePlan.lines = substituteInLines(
            candidatePlan.lines, guardReplacements);
        }
      }
      for (const header of structured.loopHeaders) {
        coarseCountedLoops.set(
          header, clippedAffineRegionAdmission.maximumTrips);
      }
    }
    // Several primitive accesses in one straight-line block commonly use
    // the same cursor with nearby fixed offsets.  Compute their joint range
    // predicate once and let every canonical access short-circuit through it.
    // If the predicate fails, each original check and its precise exception
    // materialization remain intact, so stores performed before a later
    // failure retain normal JVM semantics.  Java array lengths are immutable;
    // requiring the cursor local to be unwritten between the accesses makes
    // the shared successful proof valid for the complete group.
    let blockCoalescedArrayRangeAccessCount = 0;
    const primitiveGroups = new Map();
    for (const access of primitiveArrayAccessCandidates) {
      if (access.structuralGuard ||
          !Number.isInteger(access.indexAffine?.slot) ||
          !Number.isInteger(access.indexAffine.offset)) continue;
      const key = `${access.block}\0${access.arrayData}\0` +
        `${access.indexAffine.slot}\0${access.indexAffine.baseExpression}`;
      const group = primitiveGroups.get(key) || [];
      group.push(access);
      primitiveGroups.set(key, group);
    }
    for (const group of primitiveGroups.values()) {
      if (group.length < 2) continue;
      group.sort((left, right) => left.itemIndex - right.itemIndex);
      const first = group[0];
      const last = group[group.length - 1];
      if (typeof first.indexAffine.baseExpression !== "string") continue;
      if (localWrites(first.indexAffine.slot, first.itemIndex,
        last.itemIndex).length !== 0) continue;
      const offsets = group.map((access) => access.indexAffine.offset);
      const minimumOffset = Math.min(...offsets);
      const maximumOffset = Math.max(...offsets);
      if (!Number.isSafeInteger(minimumOffset) ||
          !Number.isSafeInteger(maximumOffset) ||
          minimumOffset < -2147483648 || maximumOffset > 2147483647) {
        continue;
      }
      const variable = named(`ssaBlockArrayRangeGuard${
        blockCoalescedArrayRangeAccessCount}`);
      let applied = false;
      for (const candidatePlan of plans) {
        if (!candidatePlan?.lines) continue;
        const markerIndexes = group.map((access) =>
          candidatePlan.lines.findIndex((line) =>
            partsReferences(recordOf(line)?.parts || [])
              .includes(access.marker)));
        if (markerIndexes.some((lineIndex) => lineIndex < 0)) continue;
        const declarationIndex = Math.min(...markerIndexes);
        const base = first.indexAffine.baseExpression;
        const minimum = e`(((${base}) + ${minimumOffset}) | 0)`;
        const maximum = e`(((${base}) + ${maximumOffset}) | 0)`;
        candidatePlan.lines.splice(declarationIndex, 0,
          constDecl(variable, exprConcat(
            e`(${minimum} >= 0 && ${maximum} >= `,
            e`${minimum} && ${maximum} < ${first.arrayData}.length)`),
          {pure: true}));
        candidatePlan.lines = substituteInLines(candidatePlan.lines,
          new Map(group.map((access) =>
            [access.marker, [{ref: variable}]])));
        applied = true;
      }
      if (applied) {
        blockCoalescedArrayRangeAccessCount += group.length - 1;
      }
    }
    for (const candidate of primitiveArrayAccessCandidates) {
      // An access with a structural guard keeps its token: it renders as
      // `false` for now, and a later proof replaces the whole reference with
      // its guard variable.
      const fallback = candidate.structuralGuard
        ? [{ref: candidate.marker, text: `false /*${candidate.marker}*/`}]
        : ["false"];
      for (const plan of plans) {
        if (!plan?.lines) continue;
        plan.lines = substituteInLines(plan.lines,
          new Map([[candidate.marker, fallback]]));
      }
    }
    // A fully verified, call-free counted kernel has a finite upper bound and
    // no scheduler-visible operation inside it. Run it as one ordinary
    // JavaScript function so SpiderMonkey can optimize the numeric loops;
    // generators otherwise inhibit the hot-loop optimizer even when they
    // yield only at distant safe points. The one-million-iteration cap keeps
    // atomic regions bounded independently of guest names or descriptors.
    const guardedAtomicRegionLimit =
      Number(method.jvmStructuredAtomicRegionMaxIterations) || 0;
    const atomicBoundedLoops = this.atomicBoundedLoopsEnabled &&
      structured.loopHeaders.size > 0 &&
      (code.code.exceptionTable || []).length === 0 &&
      !hasAtomicUnsafeOperation &&
      (allCountedLoops.size === structured.loopHeaders.size &&
        boundedIterationProduct <= 1_000_000 ||
        guardedAtomicRegionLimit > 0);
    if (atomicBoundedLoops) {
      useContinuations = false;
      for (const header of structured.loopHeaders) {
        coarseCountedLoops.set(header,
          allCountedLoops.get(header) || guardedAtomicRegionLimit);
      }
    }
    // Polling every 10k backedges works for tiny arithmetic loops, but a
    // single iteration of a large call/allocation-heavy guest body can do
    // orders of magnitude more work. Scale each poll interval by the verified
    // body of that natural loop, not by the size of its containing method. A
    // large decoder can contain dozens of small numeric loops; charging every
    // one for every cold block in the method turns the wall-clock check itself
    // into a hot operation.
    //
    // Nested-loop blocks are charged to their own poll. The outer loop retains
    // its direct blocks and clamps the shared counter on entry, so crossing
    // between differently sized loops cannot postpone a scheduler boundary.
    // This only reads Date.now() at the resulting boundary; an actual
    // spill/yield still occurs solely when the ordinary scheduler deadline,
    // debugger, timer, or thread state says it is observable.
    let methodInvokeCount = 0;
    let methodAllocationCount = 0;
    for (const item of items) {
      const op = opOf(item?.instruction);
      if (op?.startsWith("invoke")) methodInvokeCount += 1;
      if (op === "new" || op === "newarray" || op === "anewarray" ||
          op === "multianewarray") methodAllocationCount += 1;
    }
    const methodLoopWorkEstimate = Math.max(1,
      items.length + methodInvokeCount * 32 + methodAllocationCount * 16);
    const maxPollBudget = this.jit.structuredLoopSafePointMaxBudget;
    const methodPollBudget = hasAtomicUnsafeOperation
      ? Math.max(64, Math.min(maxPollBudget,
        Math.floor(16384 / methodLoopWorkEstimate)))
      : maxPollBudget;
    const naturalBlocksByLoop = new Map([...structured.loopHeaders].map(
      (header) => [header,
        naturalLoopBlocksFor(header) || new Set([header])],
    ));
    const loopPollBudgets = new Map();
    const loopWorkEstimates = new Map();
    for (const [header, naturalBlocks] of naturalBlocksByLoop) {
      const directBlocks = new Set(naturalBlocks);
      for (const [nestedHeader, nestedBlocks] of naturalBlocksByLoop) {
        if (nestedHeader === header || !naturalBlocks.has(nestedHeader) ||
            nestedBlocks.size >= naturalBlocks.size) continue;
        if ([...nestedBlocks].every((block) => naturalBlocks.has(block))) {
          for (const block of nestedBlocks) directBlocks.delete(block);
        }
      }
      const directItems = [...directBlocks].flatMap(
        (block) => cfg.blocks[block]?.insns || []);
      let invokeCount = 0;
      let allocationCount = 0;
      for (const index of directItems) {
        const op = opOf(items[index]?.instruction);
        if (op?.startsWith("invoke")) invokeCount += 1;
        if (op === "new" || op === "newarray" || op === "anewarray" ||
            op === "multianewarray") allocationCount += 1;
      }
      const perLoopWork = Math.max(1,
        directItems.length + invokeCount * 32 + allocationCount * 16);
      const work = this.perLoopPollBudgetsEnabled
        ? perLoopWork : methodLoopWorkEstimate;
      loopWorkEstimates.set(header, work);
      loopPollBudgets.set(header, this.perLoopPollBudgetsEnabled &&
        hasAtomicUnsafeOperation
        ? Math.max(64, Math.min(maxPollBudget, Math.floor(16384 / work)))
        : methodPollBudget);
    }
    const loopWorkEstimate = Math.max(1, ...loopWorkEstimates.values());
    const structuralPollBudget = Math.min(maxPollBudget,
      ...loopPollBudgets.values());
    // Keep the shared counter in guest-iteration units. Each admitted coarse
    // loop charges its verified trip count once; unrelated later loops must not
    // inherit a globally divided budget merely because an earlier loop happened
    // to be large. Poll sites use <= 0 so a coarse charge may cross the boundary
    // without losing the next scheduler check.
    const safePointInitialBudget = structuralPollBudget;
    // Recursive SCCs remain standalone restoring nodes; publishing the root
    // IR lets the graph compiler fuse the surrounding acyclic portion.
    const hotCallGraph = this.jit.hotCallGraphRegions;
    const regionCallGraphCandidate = useContinuations &&
      callSites.size > 0 && hotCallGraph?.enabled &&
      items.length >= hotCallGraph.minRootCodeItems &&
      items.length <= hotCallGraph.maxRootCodeItems;
    const indent = (lines) => lines.map((line) => `  ${line}`);
    // `a && b && c` over compiler-owned guard names, keeping each as an
    // operand reference.
    const guardConjunction = (guards) => exprConcat(
      ...guards.flatMap((guard, position) =>
        position === 0 ? [e`${guard}`] : [" && ", e`${guard}`]));
    // `negated` records that the emitted test is the logical negation of the
    // comparison it carries, which is how the branch was rendered when the
    // compiler had no algebraic negation for it.
    const conditionLine = (condition, comparison = null, negated = false) =>
      stmt(e`if (${condition}) {`,
        {kind: "if", condition, comparison, negated});
    const breakStatement = (label) => recordStatement(
      [`break ${label};`], {kind: "break", label});
    const expandContinuationFallbacks = (lines, continuationMode) =>
      lines.flatMap((line) => {
        const fallback = continuationFallbacks.get(line.trim());
        if (!fallback) return [line];
        const prefix = line.slice(0, line.length - line.trimStart().length);
        return (continuationMode ? fallback.continuation : fallback.ordinary)
          .map((fallbackLine) => `${prefix}${fallbackLine}`);
      });
    const specializeArrayRangeGuardedStores = (lines, guardVariables) => {
      if (!guardVariables.length) return lines;
      const guards = new Set(guardVariables);
      const provenArrayData = new Set(guardVariables
        .map((variable) => arrayRangeGuardDataVariables.get(variable))
        .filter(Boolean));
      const provenNonNullEntryReferences = new Set(
        [...eagerFieldArrayDataByLocal]
          .filter(([_slot, arrays]) =>
            arrays.some((data) => provenArrayData.has(data)))
          .map(([slot]) => slot));
      const provenNonZeroLocals = new Set(guardVariables.flatMap(
        (variable) => [
          ...(arrayRangeGuardNonZeroLocals.get(variable) || []),
          ...(loopInvariantDivisorGuardNonZeroLocals.get(variable) || []),
        ]));
      // This arm is dominated by `guard === true`, so the guarded load keeps
      // only its proven expression. The statement recorded both arms, so the
      // specialization re-emits it instead of cutting the ternary out of the
      // rendered characters.
      const specializeGuardedValue = (line) => {
        const record = recordOf(line);
        if (record?.kind !== "guardedLoad" || !guards.has(record.guard)) {
          return line;
        }
        return `${indentationOf(line)}${stmt(
          e`${record.target} = ${record.proven};`,
          {kind: "assign", write: record.target}).trim()}`;
      };
      const closeAt = (from, indentation, kind = "blockEnd") => {
        for (let index = from; index < lines.length; index += 1) {
          const record = recordOf(lines[index]);
          if (record?.kind === kind &&
              indentationOf(lines[index]) === indentation) return index;
        }
        return lines.length;
      };
      const output = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const indentPrefix = indentationOf(line);
        const trimmed = line.slice(indentPrefix.length);
        const record = recordOf(line);
        const comparison = record?.kind === "if" ? record.comparison : null;
        const zeroGuardValue = comparison?.cmp === "=== 0" &&
          comparison.input !== undefined ? comparison.input : null;
        const zeroGuardSlot = zeroGuardValue === null
          ? null : localLoads.get(zeroGuardValue);
        if (Number.isInteger(zeroGuardSlot) &&
            provenNonZeroLocals.has(zeroGuardSlot)) {
          const close = closeAt(index + 1, indentPrefix);
          if (close < lines.length) {
            const key = `${zeroGuardSlot}\0${trimmed}`;
            if (!rangeDominatedArithmeticGuards.has(key)) {
              rangeDominatedArithmeticGuards.add(key);
              rangeDominatedArithmeticGuardCount += 1;
            }
            index = close;
            continue;
          }
        }
        const nonNullValue = comparison?.cmp === "=== null" &&
          record.negated === true ? comparison.input : null;
        const nonNullReferenceSlot = nonNullValue === undefined ||
          nonNullValue === null ? null : entryReferenceLoads.get(nonNullValue);
        if (this.dominatedFieldReceiverChecksEnabled &&
            Number.isInteger(nonNullReferenceSlot) &&
            provenNonNullEntryReferences.has(nonNullReferenceSlot)) {
          const close = closeAt(index + 1, indentPrefix);
          if (close < lines.length) {
            const key = `${nonNullReferenceSlot}\0${trimmed}`;
            if (!dominatedEntryReferenceNullBranches.has(key)) {
              dominatedEntryReferenceNullBranches.add(key);
              dominatedEntryReferenceNullBranchCount += 1;
            }
            const nestedPrefix = `${indentPrefix}  `;
            const nonNullLines = lines.slice(index + 1, close).map(
              (nonNullLine) => nonNullLine.startsWith(nestedPrefix)
                ? `${indentPrefix}${nonNullLine.slice(nestedPrefix.length)}`
                : nonNullLine);
            output.push(...specializeArrayRangeGuardedStores(
              nonNullLines, guardVariables));
            index = close;
            continue;
          }
        }
        const nullValue = comparison?.cmp === "=== null" &&
          record.negated !== true ? comparison.input : null;
        const referenceSlot = nullValue === undefined || nullValue === null
          ? null : entryReferenceLoads.get(nullValue);
        if (this.dominatedFieldReceiverChecksEnabled &&
            Number.isInteger(referenceSlot) &&
            provenNonNullEntryReferences.has(referenceSlot)) {
          const alternate = closeAt(index + 1, indentPrefix, "elseArm");
          const close = closeAt(alternate + 1, indentPrefix);
          if (alternate < lines.length && close < lines.length) {
            const key = `${referenceSlot}\0${trimmed}`;
            if (!dominatedEntryReferenceNullBranches.has(key)) {
              dominatedEntryReferenceNullBranches.add(key);
              dominatedEntryReferenceNullBranchCount += 1;
            }
            const nestedPrefix = `${indentPrefix}  `;
            const nonNullLines = lines.slice(alternate + 1, close).map(
              (nonNullLine) => nonNullLine.startsWith(nestedPrefix)
                ? `${indentPrefix}${nonNullLine.slice(nestedPrefix.length)}`
                : nonNullLine);
            output.push(...specializeArrayRangeGuardedStores(
              nonNullLines, guardVariables));
            index = close;
            continue;
          }
        }
        const receiverArrayData = record?.kind === "nullCheck"
          ? eagerFieldReceiverNullChecks.get(record.value) : null;
        if (this.dominatedFieldReceiverChecksEnabled &&
            receiverArrayData && provenArrayData.has(receiverArrayData)) {
          // The active loop version is dominated by an array-range predicate
          // whose first conjunct proves this eager field cache has non-null
          // backing data. Eager-local admission separately proves that the
          // receiver is the unchanged entry local and that no call/write can
          // invalidate the field before this access. Therefore the getfield
          // null path is impossible in this arm. Keep it verbatim in the slow
          // loop so a null receiver still materializes the exact getfield PC.
          const close = closeAt(index + 1, indentPrefix);
          if (close < lines.length) {
            const key = `${receiverArrayData}\0${trimmed}`;
            if (!dominatedFieldReceiverChecks.has(key)) {
              dominatedFieldReceiverChecks.add(key);
              dominatedFieldReceiverCheckCount += 1;
            }
            index = close;
            continue;
          }
        }
        if (record?.kind !== "rangeGuardedAccess" ||
            !guards.has(record.guard)) {
          output.push(line);
          continue;
        }
        const alternate = closeAt(index + 1, indentPrefix, "elseArm");
        const close = closeAt(alternate + 1, indentPrefix);
        if (alternate >= lines.length || close >= lines.length) {
          output.push(line);
          continue;
        }
        const specializationKey = trimmed;
        if (!specializedArrayRangeAccesses.has(specializationKey)) {
          specializedArrayRangeAccesses.add(specializationKey);
          specializedArrayRangeAccessCount += 1;
        }
        // This version is reached only after the exact range predicate above
        // succeeded. Keep the emitted successful-store arm; the slow loop
        // retains the complete materialization and exception path.
        for (const successLine of lines.slice(alternate + 1, close)) {
          const nestedPrefix = `${indentPrefix}  `;
          const unindented = successLine.startsWith(nestedPrefix)
            ? `${indentPrefix}${successLine.slice(nestedPrefix.length)}`
            : successLine;
          output.push(specializeGuardedValue(unindented));
        }
        index = close;
      }
      return output;
    };
    // `structure()` represents a natural counted loop as an infinite labelled
    // loop whose first node branches to either the exit or the body. That is a
    // convenient CFG-preserving form, but it leaves optimizing JavaScript
    // engines with an extra branch, two SSA aliases, and an explicit continue
    // on every guest iteration. Recover the ordinary while-loop form when the
    // counted-loop proof and the emitted header agree exactly. This is a
    // generated-source canonicalization: it is driven only by the verified
    // induction slot/bound and never by a guest owner, method, or descriptor.
    const canonicalCountedLoop = (header, label, lines) => {
      const info = countedLoopInfos.get(header);
      if (!info || !Number.isInteger(info.slot) || !info.boundExpression ||
          lines.length < 5) return null;
      const first = recordOf(lines[0]);
      if (first?.kind !== "const" || first.localSnapshot !== info.slot) {
        return null;
      }
      const second = recordOf(lines[1]);
      const secondIsBound = second?.kind === "const" &&
        renderParts(second.exprParts) === String(info.boundExpression);
      const headerComparison = (line, left, right) => {
        const record = recordOf(line);
        const comparison = record?.kind === "if" ? record.comparison : null;
        if (!comparison) return null;
        if (comparison.left !== undefined) {
          return comparison.left === left && comparison.right === right
            ? comparison.cmp : null;
        }
        // A bytecode `ifge`/`iflt` compares against zero directly, so its
        // comparison carries one operand and the zero is part of the operator.
        if (comparison.input !== left || right !== "0") return null;
        return comparison.cmp === ">= 0" ? ">="
          : comparison.cmp === "< 0" ? "<" : null;
      };
      const loopCondition = operand(
        e`${localName(info.slot)} < ${info.boundExpression}`);
      let conditionIndex;
      let bodyOnThen = false;
      const twoValueCmp = secondIsBound
        ? headerComparison(lines[2], first.def, second.def) : null;
      const boundCmp = headerComparison(
        lines[1], first.def, String(info.boundExpression));
      if (twoValueCmp === ">=") {
        conditionIndex = 2;
      } else if (twoValueCmp === "<") {
        conditionIndex = 2;
        bodyOnThen = true;
      } else if (boundCmp === ">=") {
        conditionIndex = 1;
      } else if (boundCmp === "<") {
        conditionIndex = 1;
        bodyOnThen = true;
      } else {
        return null;
      }
      let alternate = -1;
      let depth = 0;
      for (let index = conditionIndex; index < lines.length; index += 1) {
        const record = recordOf(lines[index]);
        const closesToElse = record?.kind === "elseArm";
        if (index > conditionIndex && depth === 1 && closesToElse) {
          alternate = index;
          break;
        }
        depth += record?.blockDelta || 0;
      }
      if (alternate < 0 ||
          recordOf(lines[lines.length - 1])?.kind !== "blockEnd") return null;
      const unindentOne = (line) => line.startsWith("  ")
        ? line.slice(2) : line;
      const thenLines = lines.slice(conditionIndex + 1, alternate).map(unindentOne);
      const elseLines = lines.slice(alternate + 1, -1).map(unindentOne);
      const exit = bodyOnThen ? elseLines : thenLines;
      const body = bodyOnThen ? thenLines : elseLines;
      const lastRecord = recordOf(body[body.length - 1] || "");
      if (lastRecord?.kind === "continue" && lastRecord.label === label) {
        body.pop();
      }
      return {
        condition: loopCondition,
        inductionLocal: localName(info.slot),
        bound: String(info.boundExpression),
        body,
        exit,
      };
    };
    // Javac lowers `while (remaining-- > 0)` to load/iinc/ifle at the loop
    // header. It is not an increasing counted loop, but it is still a common
    // finite numeric-loop shape. Preserve the post-decrement value and move
    // the header test into JavaScript's while condition, eliminating the
    // infinite-loop/if/continue scaffold without assuming a trip bound.
    const canonicalPostDecrementLoop = (label, lines) => {
      if (lines.length < 8) return null;
      const oldValue = recordOf(lines[0]);
      if (oldValue?.kind !== "const" ||
          !Number.isInteger(oldValue.localSnapshot)) return null;
      const nextValue = recordOf(lines[1]);
      if (nextValue?.kind !== "const" ||
          nextValue.iincSource !== oldValue.def ||
          nextValue.iincIncrement !== -1) return null;
      const store = recordOf(lines[2]);
      if (store?.kind !== "store" ||
          store.write !== localName(oldValue.localSnapshot) ||
          renderParts(store.exprParts) !== nextValue.def) return null;
      const test = recordOf(lines[3]);
      if (test?.kind !== "if" || test.comparison?.input !== oldValue.def ||
          test.comparison?.cmp !== "<= 0") return null;
      let alternate = -1;
      let depth = 0;
      for (let index = 3; index < lines.length; index += 1) {
        const record = recordOf(lines[index]);
        if (index > 3 && depth === 1 && record?.kind === "elseArm") {
          alternate = index;
          break;
        }
        depth += record?.blockDelta || 0;
      }
      if (alternate < 0 ||
          recordOf(lines[lines.length - 1])?.kind !== "blockEnd") return null;
      const unindentOne = (line) => line.startsWith("  ")
        ? line.slice(2) : line;
      const exit = lines.slice(4, alternate).map(unindentOne);
      const body = [
        ...lines.slice(0, 3),
        ...lines.slice(alternate + 1, -1).map(unindentOne),
      ];
      const lastRecord = recordOf(body[body.length - 1] || "");
      if (lastRecord?.kind === "continue" && lastRecord.label === label) {
        body.pop();
      }
      return {
        condition: operand(
          e`${localName(oldValue.localSnapshot)} > 0`),
        body,
        exit,
      };
    };
    let dominatedArithmeticGuardCount = cfgDominatedArithmeticGuardCount;
    const deferredStaticArrayAccessByMarker = new Map(
      deferredStaticArrayAccesses.map((access) => [access.marker, access]));
    const specializeDeferredStaticArrayAccessLines = (lines, trusted) => {
      const output = [];
      for (let index = 0; index < lines.length; index += 1) {
        const start = recordOf(lines[index]);
        if (start?.kind !== "deferredStaticStart") {
          output.push(lines[index]);
          continue;
        }
        const access = deferredStaticArrayAccessByMarker.get(start.marker);
        let close = index + 1;
        while (close < lines.length) {
          const record = recordOf(lines[close]);
          if (record?.kind === "deferredStaticEnd" &&
              record.marker === start.marker) break;
          close += 1;
        }
        if (!access || close >= lines.length) {
          output.push(lines[index]);
          continue;
        }
        if (trusted && provenDeferredStaticArrayAccesses.has(start.marker)) {
          output.push(...access.directLines);
        } else {
          output.push(...lines.slice(index + 1, close));
        }
        index = close;
      }
      return output;
    };
    const removeTerminalBreakTo = (node, label) => {
      if (!node) return node;
      if (node.t === "break" && node.label === label) {
        eliminatedTerminalStructuredBreakCount += 1;
        return {t: "seq", body: []};
      }
      if (node.t === "seq" && node.body.length) {
        const body = [...node.body];
        body[body.length - 1] = removeTerminalBreakTo(
          body[body.length - 1], label);
        return {...node, body};
      }
      if (node.t === "if") {
        return {
          ...node,
          then: removeTerminalBreakTo(node.then, label),
          els: removeTerminalBreakTo(node.els, label),
        };
      }
      if (node.t === "switch") {
        return {
          ...node,
          cases: node.cases.map((entry) => ({
            ...entry,
            body: removeTerminalBreakTo(entry.body, label),
          })),
          dflt: removeTerminalBreakTo(node.dflt, label),
        };
      }
      if (node.t === "block") {
        return {...node, body: removeTerminalBreakTo(node.body, label)};
      }
      // A break from within a loop changes that loop's control flow even when
      // the loop node is terminal in the surrounding block.
      return node;
    };
    const specializeNonZeroBranch = (plan, lines) => {
      const comparison = plan.comparison;
      if (!comparison || comparison.cmp !== "!== 0" ||
          !ownSsaValueNames.has(comparison.input)) return lines;
      const equivalent = new Set([comparison.input]);
      // A copy of a value known non-zero is known non-zero. The record says
      // what a statement defines or writes and what its right-hand side is,
      // so the equivalence walk needs no line matching.
      const learnAlias = (line) => {
        const record = recordOf(line);
        if (!record || record.kind !== "const" && record.kind !== "store") {
          return false;
        }
        const target = record.def || record.write;
        const source = record.exprParts?.length === 1 &&
          typeof record.exprParts[0] !== "string"
          ? record.exprParts[0].ref : null;
        if (!target || !source || !equivalent.has(source)) return false;
        const size = equivalent.size;
        equivalent.add(target);
        return equivalent.size !== size;
      };
      // The conditional plan commonly stores the tested stack value into a
      // local immediately before branching; seed that equivalence before
      // walking the selected successor.
      let changed = true;
      while (changed) {
        changed = false;
        for (const line of plan.lines || []) changed = learnAlias(line) || changed;
      }
      const output = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        learnAlias(line);
        const record = recordOf(line);
        const zeroCheck = record?.kind === "if" &&
          record.comparison?.cmp === "=== 0" && !record.negated
          ? record.comparison.input : null;
        if (!zeroCheck || !equivalent.has(zeroCheck)) {
          output.push(line);
          continue;
        }
        let depth = 1;
        let close = index + 1;
        for (; close < lines.length && depth > 0; close += 1) {
          const closeRecord = recordOf(lines[close]);
          if (closeRecord?.kind === "elseArm") break;
          depth += closeRecord?.blockDelta || 0;
        }
        if (depth !== 0) {
          output.push(line);
          continue;
        }
        // This is the renderer-owned idiv/irem exceptional arm. The branch
        // edge proved the divisor nonzero, so retaining it only bloats and
        // inhibits the surrounding numeric region.
        dominatedArithmeticGuardCount += 1;
        index = close - 1;
      }
      return output;
    };
    const render = (
      node, continuationMode = useContinuations, directPositional = false,
      loopSafePointBudget = safePointInitialBudget,
      checkedLeafOnly = false,
      rangeBailout = false,
      loopSafePointBudgetOverrides = null,
    ) => {
      if (!node) return [];
      if (node.t === "seq") {
        return node.body.flatMap((child) =>
          render(child, continuationMode, directPositional,
            loopSafePointBudget, checkedLeafOnly, rangeBailout,
            loopSafePointBudgetOverrides));
      }
      if (node.t === "straight") {
        const plan = plans[node.block];
        const expandLines = (sourceLines) => sourceLines.flatMap((line) => {
          const directAlternative = directPositional && !checkedLeafOnly
            ? directPositionalLineAlternatives.get(line) : null;
          if (directAlternative) return [directAlternative];
          const directStaticRead =
            directEntryStaticReadFallbacks.get(line);
          if (directStaticRead) {
            return directPositional
              ? directStaticRead.direct : directStaticRead.ordinary;
          }
          const checkedAdmission = directCheckedAdmissionFallbacks.get(line);
          if (checkedAdmission) {
            return directPositional && rangeBailout
              ? checkedAdmission.direct : checkedAdmission.ordinary;
          }
          const fallback = continuationFallbacks.get(line);
          if (!fallback) return [line];
          const selected = checkedLeafOnly && fallback.checkedLeaf
            ? fallback.checkedLeaf
            : continuationMode ? fallback.continuation : fallback.ordinary;
          return expandLines(selected);
        });
        const lines = expandLines(specializeDeferredStaticArrayAccessLines(
          plan.lines, directPositional && rangeBailout));
        if (plan.returnKind && plan.returnKind !== "throw") {
          if (directPositional) {
            if (checkedLeafOnly && !recursiveArrayPartitionLeaf) {
              // A checked leaf completes through its labeled body, so the
              // same lines serve the standalone entry and a lexical
              // insertion without rewriting any return statement.
              lines.push(stmt(exprConcat(
                e`{ ${checkedLeafResultVariable} = ${
                  plan.returnKind === "void" ? "true" : plan.returnValue}; `,
                e`break ${checkedLeafBodyLabel}; }`),
              {kind: "leafReturn"}));
              return lines;
            }
            lines.push(plan.returnKind === "void"
              ? st`return helpers.returnVoid();`
              : stmt(e`return ${plan.returnValue};`, {kind: "return"}));
            return lines;
          }
          // Positional generated calls can execute this body without making
          // the callee Frame scheduler-visible.  Keep the scalar SSA values
          // in JavaScript and return the Java value directly on that path;
          // the wrapper reconstructs/inserts the omitted Frame only when this
          // body deoptimizes or throws.  Ordinary scheduler entries retain the
          // canonical Frame spill/pop/result protocol below.
          lines.push(st`if (framelessEntry) {`);
          if (method.jvmStructuredRegionSpillOnReturn) {
            lines.push(`  ${spillStatement()}`);
          }
          lines.push(plan.returnKind === "void"
            ? st`  return helpers.returnVoid();`
            : stmt(e`  return ${plan.returnValue};`, {kind: "return"}));
          lines.push(blockEnd(""));
          lines.push(st`if (thread.callStack.peek() !== frame) {`);
          lines.push(...materializeLines(
            plan.returnKind === "void" ? [] : [plan.returnValue],
            plan.returnIndex,
          ).map((line) => `  ${line}`));
          lines.push(st`  helpers.skipJitOnce(frame);`);
          lines.push(st`  return { deopt: true, transient: true, reason: 'structured SSA return with active child' };`);
          lines.push(blockEnd(""));
          lines.push(spillStatement());
          lines.push(st`stack.length = 0;`);
          lines.push(st`frame.pc = ${items.length};`);
          lines.push(st`thread.callStack.pop();`);
          lines.push(plan.returnKind === "void"
            ? st`return { returned: true, value: helpers.returnVoid() };`
            : stmt(e`return { returned: true, value: ${plan.returnValue} };`,
              {kind: "return"}));
        }
        return lines;
      }
      if (node.t === "if") {
        const plan = plans[node.block];
        const thenLines = specializeNonZeroBranch(plan, [
          ...edgeLines(plan.taken, plan.takenStack ?? plan.stack),
          ...render(node.then, continuationMode, directPositional,
            loopSafePointBudget, checkedLeafOnly, rangeBailout,
            loopSafePointBudgetOverrides),
        ]);
        const elseLines = [
          ...edgeLines(plan.fall, plan.fallStack ?? plan.stack),
          ...render(node.els, continuationMode, directPositional,
            loopSafePointBudget, checkedLeafOnly, rangeBailout,
            loopSafePointBudgetOverrides),
        ];
        if (plan.conditionConstant === true) {
          return [blockStart(""), ...indent(thenLines), blockEnd("")];
        }
        if (plan.conditionConstant === false) {
          return [blockStart(""), ...indent(elseLines), blockEnd("")];
        }
        if (thenLines.length === elseLines.length &&
            thenLines.every((line, index) => line === elseLines[index])) {
          return [blockStart(""), ...indent(thenLines), blockEnd("")];
        }
        if (elseLines.length === 0) {
          return [conditionLine(plan.condition, plan.comparison),
            ...indent(thenLines), blockEnd("")];
        }
        // Emit the compiler's own negation of the branch condition when it
        // has one, instead of leaving `!(a !== b)` for a later text pass.
        const negated = plan.negatedCondition || e`!(${plan.condition})`;
        // With an algebraic negation the comparison is the negated one; the
        // `!(...)` wrapper keeps the original comparison and marks it negated.
        const negatedComparison = plan.negatedCondition
          ? plan.negatedComparison : plan.comparison;
        const negatedIsWrapped = !plan.negatedCondition;
        if (thenLines.length === 0) {
          return [conditionLine(negated, negatedComparison, negatedIsWrapped),
            ...indent(elseLines), blockEnd("")];
        }
        // The break a branch arm ends in is a compiler-owned statement; ask
        // its record for the label instead of matching the rendered line.
        const breakTarget = (line) => {
          const record = statementRecords.get(line.trim());
          return record?.kind === "break" ? record.label : null;
        };
        const thenBreak = thenLines.length === 1
          ? breakTarget(thenLines[0]) : null;
        const elseBreak = elseLines.length > 0
          ? breakTarget(elseLines[elseLines.length - 1]) : null;
        if (thenBreak && thenBreak === elseBreak) {
          return [
            conditionLine(negated, negatedComparison, negatedIsWrapped),
            ...indent(elseLines.slice(0, -1)),
            blockEnd(""),
            breakStatement(thenBreak),
          ];
        }
        const fallBreak = elseLines.length === 1
          ? breakTarget(elseLines[0]) : null;
        const takenBreak = thenLines.length > 0
          ? breakTarget(thenLines[thenLines.length - 1]) : null;
        if (fallBreak && fallBreak === takenBreak) {
          return [
            conditionLine(plan.condition, plan.comparison),
            ...indent(thenLines.slice(0, -1)),
            blockEnd(""),
            breakStatement(fallBreak),
          ];
        }
        return [conditionLine(plan.condition, plan.comparison),
          ...indent(thenLines),
          elseArm(""), ...indent(elseLines), blockEnd("")];
      }
      if (node.t === "switch") {
        const plan = plans[node.block];
        if (!plan || plan.selector === undefined) {
          throw new Error(`missing structured switch plan for block ${node.block}`);
        }
        const output = [st`switch (${plan.selector}) {`];
        for (let index = 0; index < node.cases.length; index += 1) {
          const entry = node.cases[index];
          const target = plan.cases[index]?.target;
          if (target === undefined) {
            throw new Error(`missing structured switch target ${index}`);
          }
          const body = [
            ...edgeLines(target, plan.stack),
            ...render(entry.body, continuationMode, directPositional,
              loopSafePointBudget, checkedLeafOnly, rangeBailout,
              loopSafePointBudgetOverrides),
            st`break;`,
          ];
          output.push(st`case ${JSON.stringify(entry.key)}: {`,
            ...indent(body), blockEnd(""));
        }
        const defaultBody = [
          ...edgeLines(plan.defaultTarget, plan.stack),
          ...render(node.dflt, continuationMode, directPositional,
            loopSafePointBudget, checkedLeafOnly, rangeBailout,
            loopSafePointBudgetOverrides),
          st`break;`,
        ];
        output.push(st`default: {`, ...indent(defaultBody), blockEnd(""), blockEnd(""));
        return output;
      }
      if (node.t === "loop") {
        const header = Number(node.label.slice(1));
        const currentLoopSafePointBudget =
          loopSafePointBudgetOverrides?.get(header) ||
          loopPollBudgets.get(header) || loopSafePointBudget;
        const headerBlock = cfg.blocks[header];
        if (!headerBlock) throw new Error(`unknown structured loop header ${node.label}`);
        // A synthetic dispatcher header has no bytecode pc of its own; the
        // frame's JVM-visible position is the island entry the state variable
        // currently selects, whose live operands sit in the transfer slots.
        const restoreLines = headerBlock.synthetic
          ? headerBlock.synthetic.entryPcs.flatMap((pc, state) => {
            const depth = headerBlock.synthetic.entryDepths[state];
            return [
              st`if (${headerBlock.synthetic.variable} === ${state}) {`,
              ...indent([
                ...Array.from({ length: depth }, (_u, slot) => stmt(
                  e`stack[${slot}] = ${named(
                    `${headerBlock.synthetic.transfer}${slot}`)};`,
                  {kind: "spillStack"})),
                st`stack.length = ${depth};`,
                stmt(e`helpers.materialize(frame, locals, stack, ${pc});`,
            {kind: "materializeSpill"}),
              ]),
              blockEnd(""),
            ];
          })
          : (() => {
            const headerDepth = depths[headerBlock.insns[0]] || 0;
            return [
              ...Array.from({ length: headerDepth }, (_u, i) => stmt(
                e`stack[${i}] = ${named(`ssaStack${header}_${i}`)};`,
                {kind: "spillStack"})),
              st`stack.length = ${headerDepth};`,
              stmt(e`helpers.materialize(frame, locals, stack, ${
                headerBlock.insns[0]});`, {kind: "materializeSpill"}),
            ];
          })();
        const materialize = [
          // A jointly lowered call-graph region has one scheduler owner: its
          // continuation-capable root.  Internal scalar nodes use the numeric
          // nested-entry marker `2`; letting one of those nodes independently
          // deopt would discard the shared region path and resume the child
          // through generic JVM dispatch.  Keep precise throwing-operation
          // restoration in the node, but charge/yield at the root boundary.
          st`if (${directPositional ? "nestedEntryGuarded === 2 || " : ""}helpers.continueStructuredQuantum(thread)) { safePointBudget = ${currentLoopSafePointBudget}; } else {`,
          ...indent([
            spillStatement(),
            ...restoreLines,
            st`helpers.structuredSsa.safePointCount += 1;`,
            ...(continuationMode ? [
              ...invalidateFieldCacheLines,
              st`safePointBudget = ${currentLoopSafePointBudget};`,
              st`yield { deopt: true, transient: true, reason: 'structured SSA continuation' };`,
              ...refreshEntryStaticCacheLines,
              ...refreshEagerFieldCacheLines,
            ] : [
              st`helpers.skipJitOnce(frame);`,
              st`return { deopt: true, transient: true, reason: 'structured SSA safe point' };`,
            ]),
          ]),
          blockEnd(""),
        ];
        const checkedLeafCoarse = checkedLeafOnly &&
          checkedLeafCoarseLoopHeaders.has(header);
        const coarse = coarseCountedLoops.has(header) || checkedLeafCoarse;
        // The checked-leaf entry has already charged and bounded the complete
        // nested region. Recomputing an inner trip count on every outer
        // iteration cannot lead to a scheduler poll and only obscures the
        // ordinary numeric loop from the host optimizer.
        const runtimeCoarse = coarse
          ? null : runtimeCoarseCountedLoops.get(header);
        const rangeGuards = this.versionedArrayRangeStoresEnabled
          ? arrayRangeGuardVariables.get(header) || [] : [];
        const invariantDivisorGuard = loopInvariantDivisorGuards.get(header);
        const specializationGuards = [
          ...rangeGuards,
          ...(invariantDivisorGuard ? [invariantDivisorGuard.variable] : []),
        ];
        const loopBody = render(node.body, continuationMode, directPositional,
          currentLoopSafePointBudget, checkedLeafOnly, rangeBailout,
          loopSafePointBudgetOverrides);
        const countedLoop = canonicalCountedLoop(header, node.label, loopBody) ||
          canonicalPostDecrementLoop(node.label, loopBody);
        const emittedLoopBody = countedLoop ? countedLoop.body : loopBody;
        const entryBailoutGuards = directPositional && rangeBailout
          ? rangeBailoutGuardsByHeader.get(header) || [] : [];
        const prefix = [
          ...(!coarse && currentLoopSafePointBudget !== loopSafePointBudget
            ? [recordCheckedLeafLine("safePoint", stmt(exprConcat(
              e`safePointBudget = Math.min(safePointBudget, `,
              e`${currentLoopSafePointBudget});`)))]
            : []),
          ...[...(loopInvariantStaticArrayViewsByHeader.get(header)
            ?.values() || [])].flatMap((view) => {
            const key = JSON.stringify(view.direct.key);
            const read = view.direct.kind === "map"
              ? e`${view.direct.variable}.get(${key})`
              : e`${view.direct.variable}[${key}]`;
            return [
              constDecl(view.value, read,
                {pure: true, indexed: view.direct.kind !== "map"}),
              (() => {
                const loopView = arrayDataExpr(view.value);
                return constDecl(view.data, loopView,
                  {pure: loopView.pure === true});
              })(),
            ];
          }),
          ...(arrayRangeGuardDeclarations.get(header) || []),
          ...(invariantDivisorGuard
            ? [invariantDivisorGuard.declaration] : []),
          ...(entryBailoutGuards.length
            ? [recordCheckedLeafLine("rangeBailout", stmt(exprConcat(
              e`if (!(`, guardConjunction(entryBailoutGuards),
              e`)) ${CHECKED_LEAF_BAIL}`), {kind: "rangeBailout"}),
            [...entryBailoutGuards])]
            : []),
          ...(coarse && !checkedLeafOnly
            ? [st`safePointBudget -= ${coarseCountedLoops.get(header)};`]
            : []),
          ...(runtimeCoarse
            ? [
              constDecl(runtimeCoarse.tripsVariable,
                e`${runtimeCoarse.tripsExpression}`, {pure: true}),
              constDecl(runtimeCoarse.variable, e`${runtimeCoarse.condition}`,
                {pure: true}),
              recordCheckedLeafLine("safePoint", stmt(exprConcat(
                e`if (${runtimeCoarse.variable}) safePointBudget -= `,
                e`${runtimeCoarse.tripsVariable};`))),
            ]
            : []),
        ];
        const loopHeaderLine = () => stmt(
          e`${node.label}: while (${countedLoop
            ? countedLoop.condition : "true"}) {`,
          {kind: "loopHeader", label: node.label,
            inductionLocal: countedLoop?.inductionLocal || null,
            bound: countedLoop?.bound || null});
        const polledLoop = [
          loopHeaderLine(),
          ...(coarse ? [] : [
            stmt(exprConcat(e`  if (`, runtimeCoarse
              ? e`!${runtimeCoarse.variable} && ` : "",
            e`--safePointBudget <= 0) {`)),
            ...indent(indent(materialize)), blockEnd("  "),
          ]),
          ...indent(emittedLoopBody), blockEnd(""),
          ...(countedLoop ? countedLoop.exit : []),
        ];
        const unpolledLoop = [
          loopHeaderLine(),
          ...indent(emittedLoopBody), blockEnd(""),
          ...(countedLoop ? countedLoop.exit : []),
        ];
        // A restoring entry can transfer an unexpectedly large loop back to
        // canonical execution at the exact loop-header state. For the common
        // bounded case, turn the already-computed trip/overflow predicate
        // into an entry version instead of testing `!coarse` at every
        // backedge. This is the same scheduler behavior as the old runtime
        // branch: admitted loops were already charged once and atomic; only
        // rejected loops now reconstruct before their first iteration.
        const restoringCoarseLoopBailout = Boolean(
          directPositional && rangeBailout && runtimeCoarse && !coarse &&
          countedLoop && countedLoopInfos.get(header)?.increment > 0 &&
          this.restoringRangeGuardDeoptEnabled);
        if (restoringCoarseLoopBailout && specializationGuards.length === 0) {
          restoringCoarseLoopDeoptCount += 1;
          return [
            ...prefix,
            st`if (nestedEntryGuarded !== 2 && !${runtimeCoarse.variable}) {`,
            ...indent([
              spillStatement(),
              ...restoreLines,
              st`helpers.skipJitOnce(frame);`,
              stmt(exprConcat(e`return { deopt: true, transient: true, `,
                e`reason: 'structured SSA coarse loop guard' };`)),
            ]),
            blockEnd(""),
            ...unpolledLoop,
          ];
        }
        const tripBoundedSpecialization = specializationGuards.some((guard) =>
          tripBoundedArrayRangeGuards.has(guard));
        const entryDominatedFastLoop = Boolean(
          directPositional && rangeBailout && coarse &&
          specializationGuards.length > 0 &&
          specializationGuards.every((guard) =>
            entryDominatedRangeGuards.has(guard)));
        if (entryDominatedFastLoop) {
          return [
            ...prefix,
            loopHeaderLine(),
            ...indent(specializeArrayRangeGuardedStores(
              emittedLoopBody,
              specializationGuards)),
            blockEnd(""),
            ...(countedLoop ? countedLoop.exit : []),
          ];
        }
        const rangeBailoutFastLoop = Boolean(
          directPositional && rangeBailout &&
          (coarse || runtimeCoarse || tripBoundedSpecialization) &&
          specializationGuards.length > 0 &&
          rangeGuards.every((guard) =>
            trustedHoistedRangeGuards.has(guard)) &&
          countedLoopInfos.get(header)?.initial === 0 &&
          (countedLoopInfos.get(header)?.increment === 1 ||
            tripBoundedSpecialization));
        if (rangeBailoutFastLoop) {
          return [
            ...prefix,
            loopHeaderLine(),
            ...indent(specializeArrayRangeGuardedStores(
              emittedLoopBody,
              specializationGuards)),
            blockEnd(""),
            ...(countedLoop ? countedLoop.exit : []),
          ];
        }
        // A runtime-bounded direct callee normally takes the verified coarse
        // path, but a combined `!coarse && --budget` test still executes once
        // per guest backedge. Emit two ordinary JavaScript loops so optimizing
        // engines see a branch-free numeric hot loop. The slow arm retains the
        // exact scheduler poll and restoration behavior. Selection depends
        // solely on the verified trip-count/overflow proof above.
        if ((directPositional || !continuationMode) &&
            specializationGuards.length > 0 &&
            (coarse || runtimeCoarse && !coarse &&
              this.versionedRuntimeCoarseLoopsEnabled ||
              specializationGuards.some((guard) =>
                tripBoundedArrayRangeGuards.has(guard)))) {
          // Put the verified range predicates on the outer fast-loop edge.
          // Inside that dominated arm optimizing JavaScript engines can fold
          // every `!rangeGuard && boundsCheck` store branch away. The other
          // arm retains the exact per-store exception materialization.
          const fastLoopCondition = guardConjunction([
            ...(runtimeCoarse && !coarse ? [runtimeCoarse.variable] : []),
            ...specializationGuards,
          ]);
          const fastLoopBody = specializeArrayRangeGuardedStores(
            emittedLoopBody,
            specializationGuards);
          const specializedUnpolledLoop = [
            loopHeaderLine(),
            ...indent(fastLoopBody), blockEnd(""),
            ...(countedLoop ? countedLoop.exit : []),
          ];
          // A failed array-range specialization used to reconstruct the frame
          // and deopt here. That is only correct, never cheap: the guard is a
          // property of the *arguments*, so a kernel whose real arrays never
          // satisfy it deopts on essentially every invocation, and each deopt
          // costs a frame restore, one canonical interpreter bytecode, and --
          // because canRun then declines the frame -- a handoff of the rest of
          // the loop to whatever other tier claims it. The slow arm below is
          // an ordinary polled JavaScript loop that executes the same guest
          // semantics, so prefer it and keep the invocation in one tier.
          // (`restoringRangeGuardDeoptCount` stays exported at 0 for the
          // published-metadata consumers.)
          if (coarse && directPositional && rangeBailout && !checkedLeafOnly &&
              this.restoringRangeGuardDeoptEnabled) {
            restoringRangeGuardDeoptCount += 1;
            return [
              ...prefix,
              st`if (!(${fastLoopCondition})) {`,
              ...indent([
                spillStatement(),
                ...restoreLines,
                st`helpers.skipJitOnce(frame);`,
                stmt(exprConcat(e`return { deopt: true, transient: true, `,
                  e`reason: 'structured SSA range guard' };`)),
              ]),
              blockEnd(""),
              ...specializedUnpolledLoop,
            ];
          }
          if (checkedLeafOnly) {
            // This entry is published only for a single, bounded, call-free
            // loop whose guest effects are all dominated by these predicates.
            // A failed predicate returns to the ordinary call path before the
            // first effect; the successful body contains no Frame or cold
            // exception machinery and is small enough for a caller engine to
            // inline as an ordinary JavaScript leaf.
            return [
              ...prefix,
              stmt(exprConcat(e`if (!(${fastLoopCondition})) `,
                e`return helpers.asyncInvokeSentinel();`)),
              ...specializedUnpolledLoop,
            ];
          }
          return [
            ...prefix,
            st`if (${fastLoopCondition}) {`,
            ...indent(specializedUnpolledLoop),
            elseArm(""),
            ...indent(polledLoop),
            blockEnd(""),
          ];
        }
        return [...prefix, ...polledLoop];
      }
      if (node.t === "block") {
        const body = removeTerminalBreakTo(node.body, node.label);
        const rendered = render(body, continuationMode, directPositional,
          loopSafePointBudget, checkedLeafOnly, rangeBailout,
          loopSafePointBudgetOverrides);
        if (!rendered.some((line) => {
          const record = statementRecords.get(line.trim());
          return record?.kind === "break" && record.label === node.label;
        })) {
          eliminatedStructuredBlockCount += 1;
          return rendered;
        }
        return [
          recordStatement([`${node.label}: {`],
            {kind: "blockLabel", label: node.label}),
          ...indent(rendered), blockEnd(""),
        ];
      }
      if (node.t === "break") return [breakStatement(node.label)];
      if (node.t === "continue") return [
        recordStatement([`continue ${node.label};`],
          {kind: "continue", label: node.label}),
      ];
      throw new Error(`unsupported structured node ${node.t}`);
    };
    const declarations = [];
    const dispatchVariables = new Map();
    for (const block of cfg.blocks) {
      if (block.synthetic) {
        const previous = dispatchVariables.get(block.synthetic.variable);
        dispatchVariables.set(block.synthetic.variable, {
          transfer: block.synthetic.transfer,
          maxDepth: Math.max(previous?.maxDepth || 0, block.synthetic.maxDepth || 0),
        });
        continue;
      }
      const depth = depths[block.insns[0]] || 0;
      for (let slot = 0; slot < depth; slot += 1) {
        declarations.push(letDecl(named(`ssaStack${block.id}_${slot}`)));
      }
    }
    for (const [variable, island] of dispatchVariables) {
      declarations.push(letDecl(named(variable), e`0`));
      for (let slot = 0; slot < island.maxDepth; slot += 1) {
        declarations.push(letDecl(named(`${island.transfer}${slot}`)));
      }
    }
    const staticInitializationGuardId = directStaticOwners.size
      ? this.registerClassInitializationGuard(directStaticOwners) : -1;
    const staticInitializationGuardDeclaration = staticInitializationGuardId >= 0
      ? constDecl(named("ssaClassInitializationGuard"),
        e`helpers.structuredSsa.classInitializationGuards[${
          staticInitializationGuardId}]`)
      : null;
    const staticEntryGuard = staticInitializationGuardId >= 0
      ? stmt(exprConcat(
        e`if ((${named("ssaClassInitializationGuard")}.classEpoch !== (helpers.jvm.classEpoch || 0) || `,
        e`${named("ssaClassInitializationGuard")}.initializationEpoch !== `,
        e`(helpers.jvm.classInitializationEpoch || 0)) && `,
        e`!helpers.structuredSsa.verifyClassInitializationGuard(`,
        e`${named("ssaClassInitializationGuard")})) { helpers.skipJitOnce(frame); `,
        e`return { deopt: true, transient: true, reason: 'structured SSA static entry' }; }`))
      : null;
    const directStaticDeclarations = [...directStaticSites.values()]
      .filter((direct) => !direct.entryReadCache)
      .map((direct) => constDecl(named(direct.variable),
        e`helpers.directStaticTargets[${direct.targetId}].fields`));
    const lazyStaticDeclarations = [...lazyStaticSites.values()].map((lazy) =>
      letDecl(named(lazy.variable),
        e`helpers.fieldSites[${lazy.site}].staticTarget`));
    const entryStaticReadDeclarations =
      [...entryStaticReadCaches.values()].flatMap((cache) => {
        if (cache.lazy) {
          const lazy = cache.lazy;
          const read = exprConcat(
            e`${lazy.variable}.cell ? ${lazy.variable}.cell.value : `,
            e`${lazy.variable}.kind === "map" ? `,
            e`${lazy.variable}.fields.get(${lazy.variable}.key) : `,
            e`${lazy.variable}.fields[${lazy.variable}.key]`);
          return [
            letDecl(cache.valid, e`Boolean(${lazy.variable})`),
            letDecl(cache.value, exprConcat(e`${cache.valid} ? `,
              e`${normalizeJvmScalarExpression(read, cache.descriptor)}`,
              e` : undefined`)),
            ...(cache.data
              ? [letDecl(cache.data, exprConcat(e`${cache.valid} ? `,
                e`${arrayDataExpr(cache.value)} : null`))]
              : []),
          ];
        }
        const direct = cache.direct;
        const fields =
          e`helpers.directStaticTargets[${direct.targetId}].fields`;
        const read = direct.cell
          ? exprConcat(
            e`helpers.directStaticTargets[${direct.targetId}].cell.value`,
            e` /* ${direct.key} */`)
          : direct.kind === "map"
            ? e`${fields}.get(${JSON.stringify(direct.key)})`
            : e`${fields}[${JSON.stringify(direct.key)}]`;
        return [
          letDecl(cache.value,
            e`${normalizeJvmScalarExpression(read, cache.descriptor)}`),
          ...(cache.data
            ? [letDecl(cache.data, arrayDataExpr(cache.value))]
            : []),
        ];
      });
    // Scalar positional regions have already passed the all-owner
    // initialization guard and have not performed a guest effect yet. Resolve
    // any cold getstatic location at that entry edge, snapshot its current
    // value, and let the generated body use the scalar directly. This removes
    // linkage/value-validity branches from nested pixel, codec, and mixer
    // loops while retaining canonical class initialization on the fallback
    // path. The ordinary frame-backed entry keeps its lazy per-bytecode logic.
    const directEntryStaticReadDeclarations =
      !this.directEntryStaticLinkingEnabled
        ? entryStaticReadDeclarations
        : [...entryStaticReadCaches.values()].flatMap((cache) => {
          if (!cache.lazy) {
            const direct = cache.direct;
            const fields =
              e`helpers.directStaticTargets[${direct.targetId}].fields`;
            const read = direct.cell
              ? exprConcat(
                e`helpers.directStaticTargets[${direct.targetId}].cell.value`,
                e` /* ${direct.key} */`)
              : direct.kind === "map"
                ? e`${fields}.get(${JSON.stringify(direct.key)})`
                : e`${fields}[${JSON.stringify(direct.key)}]`;
            return [
              letDecl(cache.value,
                e`${normalizeJvmScalarExpression(read, cache.descriptor)}`),
              ...(cache.data
                ? [letDecl(cache.data, arrayDataExpr(cache.value))]
                : []),
            ];
          }
          const lazy = cache.lazy;
          const read = exprConcat(
            e`${lazy.variable}.cell ? ${lazy.variable}.cell.value : `,
            e`${lazy.variable}.kind === "map" ? `,
            e`${lazy.variable}.fields.get(${lazy.variable}.key) : `,
            e`${lazy.variable}.fields[${lazy.variable}.key]`);
          return [
            letDecl(cache.value),
            st`if (${lazy.variable}) {`,
            stmt(e`  ${cache.value} = ${read};`),
            elseArm(""),
            st`  ${cache.value} = helpers.getStaticSyncAt(${lazy.site});`,
            stmt(exprConcat(
              e`  if (${cache.value} === helpers.staticDeopt()) `,
              e`{ ${leafBailStatement()} }`)),
            st`  ${lazy.variable} = helpers.fieldSites[${lazy.site}].staticTarget;`,
            stmt(exprConcat(e`  if (${lazy.variable}) `,
              e`helpers.structuredSsa.lazyStaticTargetLinkCount += 1;`)),
            blockEnd(""),
            stmt(e`${cache.value} = ${
              normalizeJvmScalarExpression(cache.value, cache.descriptor)};`),
            ...(cache.data
              ? [letDecl(cache.data, arrayDataExpr(cache.value))]
              : []),
          ];
        });
    // A sync call site may publish a positional target after the caller was
    // compiled. Snapshot the current monomorphic record once per generated
    // entry instead of reloading the site table and target object in every
    // loop iteration. A cold snapshot simply uses the canonical linker for
    // this entry; the next entry observes the published target. The target's
    // own class/debug/epoch guards remain authoritative.
    const positionalParentOwner = method.className ||
      this.jit.jvm.findClassNameForMethod?.(method) || null;
    const positionalCallDeclarationsFor = (
      omitSelfRecursive = false,
      alwaysRefreshCaptures = false,
      forceCanonicalCalls = false,
    ) => {
      const lines = [];
      const captureSections = [];
      // Each call binding is emitted through `declare` so its exact
      // declaration text and declaration kind can be published. A region that
      // links the site replaces the whole declaration by identity instead of
      // parsing the module to find the declarator's initializer.
      const declarationsByName = new Map();
      const declare = (kind, name, initializer,
        removableWhenUnused = false) => {
        const meta = removableWhenUnused ? {removableWhenUnused: true} : null;
        const text = kind === "const"
          ? constDecl(named(name), e`${initializer}`, meta)
          : letDecl(named(name), e`${initializer}`, meta);
        declarationsByName.set(name, {kind, text});
        return text;
      };
      for (const [index, site] of [...callSites].filter(([, candidate]) =>
        candidate.id !== null && candidate.id !== undefined &&
        !(omitSelfRecursive && candidate.selfRecursive))) {
        const compileTimeCheckedLeaf = Boolean(site.directCheckedLeaf);
        const captures = compileTimeCheckedLeaf &&
          Array.isArray(site.directCheckedLeaf.captures)
          ? site.directCheckedLeaf.captures : [];
        const captureLines = [];
        const captureArguments = [];
        let captureCacheId = null;
        let captureCacheVariable = null;
        let captureRefreshLine = null;
        if (captures.length) {
          captureCacheId = site.checkedLeafCaptureCacheId;
          captureCacheVariable = named(`ssaCallCaptureCache${index}`);
          captureRefreshLine = alwaysRefreshCaptures
            ? st`helpers.refreshCheckedLeafCaptureCache(${captureCacheId});`
            : stmt(exprConcat(e`if (${captureCacheVariable}.dirty) `,
              e`helpers.refreshCheckedLeafCaptureCache(${captureCacheId});`));
          captureLines.push(
            constDecl(captureCacheVariable,
              e`helpers.checkedLeafCaptureCaches[${captureCacheId}]`,
              {removableWhenUnused: true}),
            captureRefreshLine);
        }
        let captureValueOffset = 0;
        for (let captureIndex = 0; captureIndex < captures.length;
          captureIndex += 1) {
          const capture = captures[captureIndex];
          const valueName =
            named(`ssaCallCapture${index}_${captureArguments.length}`);
          captureLines.push(constDecl(valueName,
            normalizeJvmScalarExpression(
              e`${captureCacheVariable}.value${captureValueOffset}`,
              capture.descriptor), {removableWhenUnused: true}));
          captureArguments.push(valueName);
          captureValueOffset += 1;
          if (capture.data) {
            const dataName =
              named(`ssaCallCapture${index}_${captureArguments.length}`);
            captureLines.push(constDecl(dataName,
              e`${captureCacheVariable}.value${captureValueOffset}`,
              {removableWhenUnused: true}));
            captureArguments.push(dataName);
            captureValueOffset += 1;
          }
        }
        const rawBody = named(`ssaFastPositionalRawBody${index}`);
        if (forceCanonicalCalls) {
          lines.push(
            declare("const", positionalCallSiteVariable(index),
              e`helpers.syncCallSites[${site.id}]`),
            ...captureLines,
            declare("const", positionalCallLateLinkVariable(index), "false"),
            declare("let", positionalCallTargetVariable(index), "null"),
            declare("let", positionalCallInvokeVariable(index), "null"),
            declare("let", positionalCallRawInvokeVariable(index), "null"),
            declare("let", positionalCallReceiverVariable(index), "null"),
          );
        } else if (compileTimeCheckedLeaf) {
          lines.push(
            declare("const", rawBody,
              e`helpers.directCheckedLeafBodies[${
                site.directCheckedLeaf.id}]`, true),
            ...captureLines,
            declare("const", positionalCallRawInvokeVariable(index), rawBody),
            declare("const", positionalCallInvokeVariable(index), "null"),
            declare("const", positionalCallReceiverVariable(index), "null"),
          );
        } else {
          lines.push(
            declare("const", positionalCallSiteVariable(index),
              e`helpers.syncCallSites[${site.id}]`),
            declare("const", positionalCallLateLinkVariable(index), "true"),
            declare("let", positionalCallTargetVariable(index), exprConcat(
              e`!helpers.profileMethods && `,
              e`${positionalCallSiteVariable(index)} && `,
              e`${positionalCallSiteVariable(index)}.fastPositional && `,
              e`(${positionalCallSiteVariable(index)}.fastPositional.debugGuarded || `,
              e`!helpers.jvm.debugManager.isClassJitDeopted(`,
              e`${positionalCallSiteVariable(index)}.fastPositional.lookupClass)) `,
              e`? ${positionalCallSiteVariable(index)}.fastPositional : null`)),
            declare("let", positionalCallInvokeVariable(index), exprConcat(
              e`${positionalCallTargetVariable(index)} && `,
              e`${positionalCallTargetVariable(index)}.invoke`)),
            declare("let", positionalCallRawInvokeVariable(index), exprConcat(
              e`${positionalCallTargetVariable(index)} && `,
              e`${positionalCallTargetVariable(index)}.rawInvoke`)),
            declare("let", positionalCallReceiverVariable(index), exprConcat(
              e`${positionalCallTargetVariable(index)} && `,
              e`${positionalCallTargetVariable(index)}.receiverType`)),
          );
        }
        if (captureLines.length) {
          captureSections.push({
            cacheId: captureCacheId,
            lines: captureLines,
            refreshLine: captureRefreshLine,
          });
        }
      }
      return {lines, captureSections, declarationsByName};
    };
    // A continuation that owns both recursive calls and independent scheduler
    // handoffs cannot safely mix lexical continuation state with nested
    // positional children.  The method's own Frame was already retained for
    // this shape; keep its child calls canonical as well so every non-void
    // return has one unambiguous JVM operand-stack owner.  This is derived
    // entirely from resolved call identities and CFG shape.
    const canonicalNestedCalls = useContinuations &&
      hasSelfRecursiveCall && hasIndependentlySuspendableCall;
    const positionalCallDeclarationSet =
      positionalCallDeclarationsFor(false, true, canonicalNestedCalls);
    const positionalCallDeclarations = positionalCallDeclarationSet.lines;
    const directPositionalCallDeclarationSet =
      positionalCallDeclarationsFor(true);
    const directPositionalCallDeclarations =
      directPositionalCallDeclarationSet.lines;
    const directPositionalCallCaptureDeclarations =
      directPositionalCallDeclarationSet.captureSections.flatMap(
        (section) => section.lines);
    const restoringDirectPositionalCallDeclarations =
      directPositionalCallDeclarations;
    const admissionOwnedCaptureRefreshLines = new Set(
      directPositionalCallDeclarationSet.captureSections
        .filter((section) => checkedAdmissionOwnedCaptureRefreshes.has(
          section.cacheId))
        .map((section) => section.refreshLine));
    const omitAdmissionOwnedCaptureRefreshes = (lines) => lines.filter(
      (line) => !admissionOwnedCaptureRefreshLines.has(line));
    const specializeSelfRecursiveCalls = (
      source, tier, includePlan, functionNameOverride = null,
    ) => {
      if (!selfRecursiveCallExpressions.size) return source;
      const functionName = functionNameOverride ||
        this.jit.generatedSource(method, tier, "").functionName;
      let specialized = source;
      for (const call of selfRecursiveCallExpressions.values()) {
        const direct = `${functionName}(helpers, ${includePlan ? "plan, " : ""}` +
          `${call.args.join(", ")}${call.args.length ? ", " : ""}` +
          "thread, 2)";
        specialized = specialized.split(
          `${call.marker}${call.ordinary}`).join(direct);
        const site = callSites.get(call.index);
        if (site) {
          specialized = specialized.split(
            `if ((${positionalCallRawInvokeVariable(call.index)} || ` +
              `${positionalCallInvokeVariable(call.index)}) && true) {`,
          ).join("if (true) {");
        }
        specialized = specialized
          .split(`/*__SSA_SELF_RECURSIVE_REGION_START_${call.index}__*/\n`)
          .join("")
          .split(`/*__SSA_SELF_RECURSIVE_REGION_END_${call.index}__*/\n`)
          .join("");
      }
      return specialized;
    };
    const specializeCheckedLeafSelfRecursiveCalls = (
      source, tier, rawWorker = false,
    ) => {
      if (!selfRecursiveCallExpressions.size) return source;
      const functionName =
        this.jit.generatedSource(method, tier, "").functionName;
      const lines = source.split("\n");
      for (const call of [...selfRecursiveCallExpressions.values()]
        .sort((left, right) => right.index - left.index)) {
        const startMarker =
          `/*__SSA_SELF_RECURSIVE_REGION_START_${call.index}__*/`;
        const endMarker =
          `/*__SSA_SELF_RECURSIVE_REGION_END_${call.index}__*/`;
        const start = lines.findIndex((line) => line.trim() === startMarker);
        const end = lines.findIndex((line, index) =>
          index > start && line.trim() === endMarker);
        if (start < 0 || end < 0) return null;
        const indentation = indentationOf(lines[start]);
        const direct = rawWorker
          ? stmt(exprConcat(e`${functionName}(`,
            argumentListExpression(call.args), e`);`))
          : stmt(exprConcat(e`${functionName}(helpers, `,
            argumentListExpression(call.args),
            call.args.length ? ", " : "", e`thread, 2);`));
        lines.splice(start, end - start + 1, `${indentation}${direct}`);
      }
      return lines.join("\n");
    };
    const fieldReadCacheDeclarations = [...fieldReadCaches.values()].flatMap((cache) => [
      letDecl(cache.object, e`null`),
      letDecl(cache.value),
      letDecl(cache.valid, e`false`),
      ...(cache.isArray ? [letDecl(cache.data, e`null`)] : []),
    ]);
    const fieldReadCacheInitializations = [...fieldReadCaches.values()]
      .filter((cache) =>
        cache.eagerLocal !== null && cache.eagerLocal !== undefined)
      .flatMap((cache) => [
        `if (local${cache.eagerLocal} !== null && ` +
          `local${cache.eagerLocal} !== undefined) {`,
        `  ${cache.object} = local${cache.eagerLocal};`,
        `  ${cache.value} = ${cache.directKey
          ? guardedDirectFieldReadExpression(
            cache, `local${cache.eagerLocal}`)
          : `helpers.getFieldAt(${cache.site}, local${cache.eagerLocal})`};`,
        ...(cache.isArray ? [
          `  ${cache.data} = ${arrayDataExpression(cache.value)};`,
        ] : []),
        `  ${cache.valid} = true;`,
        "}",
      ]);
    // A restoring positional entry can reject an exotic instance layout
    // before its first guest effect and let the canonical call path preserve
    // exact exceptions. For immutable entry receivers with already-resolved
    // direct keys, guard the storage object once and read each field directly
    // rather than retaining a helper-valued ternary per field. This is the
    // same generic layout fact used by transactional checked leaves.
    const restoringDirectFieldLayoutSlots = new Set();
    const restoringDirectFieldLayoutCaches = this.restoringDirectFieldLayoutsEnabled
      ? [...fieldReadCaches.values()].filter((cache) =>
        cache.eagerLocal !== null && cache.eagerLocal !== undefined &&
        cache.directKey)
      : [];
    const restoringDirectFieldCacheInitializations = [];
    for (const slot of new Set(restoringDirectFieldLayoutCaches.map(
      (cache) => cache.eagerLocal))) {
      const caches = restoringDirectFieldLayoutCaches.filter(
        (cache) => cache.eagerLocal === slot);
      restoringDirectFieldLayoutSlots.add(slot);
      restoringDirectFieldCacheInitializations.push(
        stmt(exprConcat(
          e`if (${localName(slot)} === null || ${
            localName(slot)} === undefined || `,
          e`!${localName(slot)}.fields) `,
          e`${leafBailStatement()}`)),
      );
      for (const cache of caches) {
        restoringDirectFieldCacheInitializations.push(
          stmt(e`${cache.object} = ${localName(slot)};`),
          stmt(exprConcat(e`${cache.value} = `,
            e`${directFieldValueExpression(cache, localName(slot))};`)),
        );
      }
      // allocateObject may leave never-assigned Java fields absent from the
      // sparse host map. A resolved direct slot still has ordinary JVM
      // default-value semantics: zero for primitives and null for references.
      // Treating absence as an exotic-layout bailout sends common optional
      // fields through generic dispatch on every invocation.
      for (const cache of caches) {
        const defaultValue = typeof cache.descriptor === "string" &&
          (cache.descriptor.startsWith("L") ||
            cache.descriptor.startsWith("[")) ? "null" : "0";
        restoringDirectFieldCacheInitializations.push(
          stmt(e`if (${cache.value} === undefined) ${cache.value} = ${
            defaultValue};`),
        );
      }
      for (const cache of caches) {
        if (!cache.isArray) {
          restoringDirectFieldCacheInitializations.push(
            stmt(e`${cache.value} = ${normalizeJvmScalarExpression(
              cache.value, cache.descriptor)};`),
          );
        }
        if (cache.isArray) {
          restoringDirectFieldCacheInitializations.push(
            stmt(e`${cache.data} = ${arrayDataExpr(cache.value)};`),
          );
        }
        restoringDirectFieldCacheInitializations.push(
          stmt(e`${cache.valid} = true;`),
        );
      }
    }
    const restoringDirectLayoutCacheSet =
      new Set(restoringDirectFieldLayoutCaches);
    restoringDirectFieldCacheInitializations.push(
      ...[...fieldReadCaches.values()]
        .filter((cache) => !restoringDirectLayoutCacheSet.has(cache) &&
          cache.eagerLocal !== null && cache.eagerLocal !== undefined)
        .flatMap((cache) => [
          stmt(exprConcat(
            e`if (${localName(cache.eagerLocal)} !== null && `,
            e`${localName(cache.eagerLocal)} !== undefined) {`)),
          stmt(e`  ${cache.object} = ${localName(cache.eagerLocal)};`),
          stmt(e`  ${cache.value} = ${cache.directKey
            ? guardedDirectFieldReadExpression(
              cache, localName(cache.eagerLocal))
            : e`helpers.getFieldAt(${cache.site}, ${
              localName(cache.eagerLocal)})`};`),
          ...(cache.isArray
            ? [stmt(e`  ${cache.data} = ${arrayDataExpr(cache.value)};`)] : []),
          stmt(e`  ${cache.valid} = true;`),
          blockEnd(""),
        ]),
    );
    // A transactional checked leaf must never call a field helper before it
    // has a canonical Frame. Require the already-resolved direct storage
    // shape at entry and return to the ordinary implementation for exotic
    // objects. This is a structural object-layout guard, independent of the
    // guest owner or field names selected by the bytecode.
    const transactionalEagerFieldCaches = [...fieldReadCaches.values()]
      .filter((cache) =>
        cache.eagerLocal !== null && cache.eagerLocal !== undefined);
    const transactionalFieldReadCacheInitializations = [];
    for (const slot of new Set(transactionalEagerFieldCaches.map(
      (cache) => cache.eagerLocal))) {
      const caches = transactionalEagerFieldCaches.filter(
        (cache) => cache.eagerLocal === slot);
      transactionalFieldReadCacheInitializations.push(
        stmt(exprConcat(
          e`if (${localName(slot)} === null || ${
            localName(slot)} === undefined || `,
          e`!${localName(slot)}.fields) `,
          e`${leafBailStatement()}`)),
      );
      for (const cache of caches) {
        transactionalFieldReadCacheInitializations.push(
          constDecl(cache.value,
            directFieldValueExpression(cache, localName(slot))),
        );
        if (cache.isArray) {
          transactionalFieldReadCacheInitializations.push(
            constDecl(cache.data, arrayDataExpr(cache.value)),
          );
        }
      }
      transactionalFieldReadCacheInitializations.push(
        stmt(exprConcat(e`if (`,
          ...caches.flatMap((cache, position) => [
            position === 0 ? "" : " || ",
            e`${cache.value} === undefined`,
          ]),
          e`) ${leafBailStatement()}`)),
      );
    }
    const guardedStaticBooleanConditions = (direct) => exprConcat(
      e`((`,
      direct.kind === "map"
        ? e`${direct.variable}.get(${JSON.stringify(direct.key)})`
        : e`${direct.variable}[${JSON.stringify(direct.key)}]`,
      e` ? 1 : 0) !== ${direct.guardedBooleanValue})`);
    const guardedStaticBooleanEntryGuard = guardedStaticBooleanSites.size
      ? stmt(exprConcat(e`if (`,
        ...[...guardedStaticBooleanSites.values()].flatMap(
          (direct, position) => [
            position === 0 ? "" : " || ",
            guardedStaticBooleanConditions(direct),
          ]),
        e`) { helpers.structuredSsa.guardedBooleanFallbackCount += 1; helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'structured SSA static boolean guard' }; }`))
      : null;
    let renderedTree = expandContinuationFallbacks(
      render(structured.tree), useContinuations);
    // Which JVM slots the rendered tree reads and which it assigns. Both come
    // from the statements themselves: a slot is read where a statement
    // references its name and assigned where a statement writes it.
    const renderedLocalSlots = new Set();
    const renderedAssignedLocalSlots = new Set();
    const renderedEntryArrayDataNames = new Set();
    for (const line of renderedTree) {
      const record = recordOf(line);
      if (!record) continue;
      for (const name of partsReferences(record.parts)) {
        const slot = localSlotOfName(name);
        if (slot !== null) renderedLocalSlots.add(slot);
        if (entryArrayDataNames.has(name)) {
          renderedEntryArrayDataNames.add(name);
        }
      }
      const written = localSlotOfName(record.write || "");
      if (written !== null) renderedAssignedLocalSlots.add(written);
    }
    // Lexically inlined checked leaves deliberately reuse compact localN
    // names inside their own block scope. Reading assignments back from the
    // rendered text therefore confuses child locals with the caller's JVM
    // slots. Derive caller mutability from its verified bytecodes instead;
    // folded entry stores already live in the declaration and are excluded.
    const callerAssignedLocalSlots = new Set();
    for (let index = 0; index < items.length; index += 1) {
      if (!normalReachableItems.has(index) ||
          foldedEntryStoreIndexes.has(index)) continue;
      const instruction = items[index]?.instruction;
      const op = opOf(instruction);
      const slot = op === "iinc"
        ? Number(instruction.varnum ?? instruction.arg)
        : /^[adfil]store(?:_[0-3])?$/.test(op || "")
          ? localIndex(instruction, op) : null;
      if (Number.isInteger(slot)) callerAssignedLocalSlots.add(slot);
    }
    const immutableEntryLocals = new Set([...entryLocalInitialValues.keys()]
      .filter((slot) => !callerAssignedLocalSlots.has(slot)));
    const spillSlots = [...new Set([
      ...entryLocalInitialValues.keys(), ...callerAssignedLocalSlots,
    ])].sort((a, b) => a - b);
    // Every spill expression must have a lexical local even when scalar DCE
    // removed the local's last ordinary read from the rendered tree. The
    // value is still observable at a scheduler/exception materialization.
    const declaredLocals = [...new Set([
      ...renderedLocalSlots,
      ...spillSlots.filter((slot) => !immutableEntryLocals.has(slot)),
    ])].sort((a, b) => a - b);
    const entryArrayDataSlots = [...entryArrayLocalSlots]
      .filter((slot) =>
        declaredLocals.includes(slot) &&
        renderedEntryArrayDataNames.has(entryArrayDataVariable(slot)));
    // One JVM slot's entry declaration: `const` when the region proves the
    // slot immutable, `let` otherwise.
    const entryLocalDeclaration = (index, entryArgumentValue) => {
      const initializer = e`${entryLocalInitialValues.has(index)
        ? entryLocalInitialValues.get(index)
        : entryArgumentValue(index) || "undefined"}`;
      return immutableEntryLocals.has(index)
        ? constDecl(localName(index), initializer)
        : letDecl(localName(index), initializer);
    };
    const entryArrayDataDeclarationFor = (slot) => constDecl(
      entryArrayDataVariable(slot), arrayDataExpr(localName(slot)));
    const entryArrayDataDeclarations = entryArrayDataSlots.map(
      entryArrayDataDeclarationFor);
    const persistentStaticArrayDataDeclarations =
      [...persistentStaticArrayLocalViews.values(),
        ...persistentProducedArrayLocalViews.values()].map((view) =>
        letDecl(named(view.data), e`null`));
    const guardedArrayDataVariables = [
      ...entryArrayDataSlots.map(entryArrayDataVariable),
      ...[...entryStaticReadCaches.values()]
        .filter((cache) => !cache.lazy &&
          !hasNullableStaticArrayControl)
        .map((cache) => cache.data).filter(Boolean),
    ];
    const nullArrayDataConjunction = (variables) => exprConcat(
      ...variables.flatMap((data, position) => [
        position === 0 ? "" : " || ",
        e`${data} === null`,
      ]));
    const guardedArrayDataCondition = guardedArrayDataVariables.length
      ? operand(nullArrayDataConjunction(guardedArrayDataVariables))
      : null;
    const framedArrayDataGuard = guardedArrayDataCondition
      ? stmt(exprConcat(
        e`if (${guardedArrayDataCondition}) { helpers.skipJitOnce(frame); `,
        e`return { deopt: true, transient: true, reason: `,
        e`${JSON.stringify(`non-canonical primitive array storage in ${
          compiledMethodIdentity}`)} }; }`))
      : null;
    const directGuardedArrayDataCondition = guardedArrayDataVariables.length
      ? operand(nullArrayDataConjunction(guardedArrayDataVariables)) : "";
    const directArrayDataGuard = directGuardedArrayDataCondition
      ? stmt(exprConcat(
        e`if (${directGuardedArrayDataCondition}) { `,
        e`${leafBailStatement()}`, e` }`))
      : null;
    // Small acyclic integral decision trees (character maps, classifiers,
    // clamps, flag decoders, and similar leaves) are often called once per
    // pixel/glyph.  Their frame-backed positional wrapper can cost more than
    // the guest arithmetic.  Admit a deliberately narrow, non-throwing,
    // side-effect-free opcode set and emit a second ABI that receives JVM
    // arguments directly as JavaScript scalars.  Selection depends only on
    // the verified descriptor/CFG/opcodes and resolved static locations.
    const directPositionalOps = new Set([
      "nop",
      "iload", "iload_0", "iload_1", "iload_2", "iload_3",
      "istore", "istore_0", "istore_1", "istore_2", "istore_3",
      "iconst_m1", "iconst_0", "iconst_1", "iconst_2", "iconst_3",
      "iconst_4", "iconst_5", "bipush", "sipush", "ldc", "ldc_w",
      "iadd", "isub", "imul", "iand", "ior", "ixor",
      "ishl", "ishr", "iushr", "ineg", "i2b", "i2c", "i2s", "iinc",
      "getstatic",
      "goto", "goto_w",
      "ifeq", "ifne", "iflt", "ifle", "ifgt", "ifge",
      "if_icmpeq", "if_icmpne", "if_icmplt", "if_icmple",
      "if_icmpgt", "if_icmpge",
      "ireturn",
    ]);
    let directMethodDescriptor = null;
    try { directMethodDescriptor = parseDescriptor(method.descriptor); } catch (_) {}
    const directIntegralTypes = new Set([
      "boolean", "byte", "char", "short", "int",
    ]);
    const directMethodOwner = positionalParentOwner;
    const directPositionalBaseEligible = Boolean(
      directMethodDescriptor &&
      directIntegralTypes.has(directMethodDescriptor.returnType) &&
      directMethodDescriptor.params.every((type) => directIntegralTypes.has(type)) &&
      directMethodOwner &&
      structured.loopHeaders.size === 0 &&
      (code.code.exceptionTable || []).length === 0 &&
      fieldReadCaches.size === 0,
    );
    let directPositionalEligible = directPositionalBaseEligible;
    let internalRegionPositionalEligible = directPositionalBaseEligible;
    for (let index = 0; index < items.length &&
      (directPositionalEligible || internalRegionPositionalEligible);
      index += 1) {
      if (depths[index] === undefined || !normalReachableItems.has(index)) continue;
      const instruction = items[index]?.instruction;
      const op = opOf(instruction);
      if (!op) continue;
      if (!directPositionalOps.has(op)) {
        directPositionalEligible = false;
        if (op !== "invokestatic") internalRegionPositionalEligible = false;
      }
      if ((op === "ldc" || op === "ldc_w") &&
          !Number.isInteger(Number(instruction.arg?.value ?? instruction.arg))) {
        directPositionalEligible = false;
        internalRegionPositionalEligible = false;
      }
      if (op === "getstatic") {
        const direct = directStaticSites.get(index);
        const descriptor = instruction.arg?.[2]?.[1];
        if (!direct || !["Z", "B", "C", "S", "I"].includes(descriptor)) {
          directPositionalEligible = false;
          internalRegionPositionalEligible = false;
        }
      }
    }
    // A second direct ABI covers effectful primitive-array regions such as
    // samplers, pixel writers, codecs, and mixers. It may contain structured
    // loops and static calls; neither property requires a child Frame on the
    // normal path. Every safe point or throwing instruction already
    // materializes its exact bytecode PC, locals, and operand stack. The
    // direct body lazily creates and restores the omitted Frame only when one
    // of those uncommon paths is actually taken.
    const restoringDirectPositionalOps = new Set([
      ...directPositionalOps,
      "aconst_null",
      "dup", "dup_x1", "dup_x2", "dup2", "pop",
      "aload", "aload_0", "aload_1", "aload_2", "aload_3",
      "astore", "astore_0", "astore_1", "astore_2", "astore_3",
      "getfield", "putfield",
      "putstatic",
      "i2d", "d2i",
      "dconst_0", "dadd", "dmul", "ddiv",
      "dload", "dload_0", "dload_1", "dload_2", "dload_3",
      "dstore", "dstore_0", "dstore_1", "dstore_2", "dstore_3",
      "i2f", "f2i", "d2f", "f2d", "fadd", "fsub", "fmul", "fdiv", "fneg",
      "fconst_0", "fconst_1", "fconst_2",
      "fload", "fload_0", "fload_1", "fload_2", "fload_3",
      "fstore", "fstore_0", "fstore_1", "fstore_2", "fstore_3",
      "i2l", "l2i", "lmul", "lshr",
      "ldc2_w",
      "new", "newarray", "anewarray",
      "arraylength",
      "iaload", "saload", "baload", "caload", "faload", "aaload",
      "iastore", "sastore", "bastore", "castore", "fastore", "aastore",
      "ifnull", "ifnonnull", "if_acmpeq", "if_acmpne",
      "idiv", "irem",
      "checkcast",
      "invokestatic", "invokevirtual", "invokeinterface", "invokespecial",
      "ireturn", "freturn", "areturn", "return",
    ]);
    const directPrimitiveDescriptors = new Set([
      "Z", "B", "C", "S", "I", "F",
      "[Z", "[B", "[C", "[S", "[I", "[F",
    ]);
    const restoringDirectScalarTypes = new Set([
      ...directIntegralTypes, "float",
    ]);
    const restoringDirectParameterType = (type) =>
      restoringDirectScalarTypes.has(type) ||
      ["boolean[]", "byte[]", "char[]", "short[]", "int[]", "float[]"]
        .includes(type) ||
      typeof type === "string" &&
        !["void", "long", "float", "double"].includes(type);
    const referenceStaticPositionalEnabled =
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_REFERENCE_STATIC_POSITIONAL === "1");
    const effectfulFieldPositionalEnabled =
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_EFFECTFUL_FIELD_POSITIONAL === "1");
    const restoringDirectReturnsReference = directMethodDescriptor &&
      directMethodDescriptor.returnType !== "void" &&
      !restoringDirectScalarTypes.has(directMethodDescriptor.returnType);
    const restoringDirectReturnsArray = directMethodDescriptor &&
      typeof directMethodDescriptor.returnType === "string" &&
      directMethodDescriptor.returnType.endsWith("[]");
    let restoringDirectRejection = null;
    let restoringDirectPositionalEligible = Boolean(
      directMethodDescriptor &&
      (directMethodDescriptor.returnType === "void" ||
        restoringDirectParameterType(directMethodDescriptor.returnType)) &&
      directMethodDescriptor.params.every(restoringDirectParameterType) &&
      (!restoringDirectReturnsReference ||
        restoringDirectReturnsArray && structured.loopHeaders.size > 0) &&
      directMethodOwner &&
      [...fieldReadCaches.values()].every((cache) =>
        cache.directKey &&
        (effectfulFieldPositionalEnabled ||
          cache.eagerLocal !== null && cache.eagerLocal !== undefined)),
    );
    // A constructor's leading invokespecial is an initialization boundary,
    // not an ordinary effectful leaf call. If that superclass initializer
    // needs a scheduler-visible fallback, restoring an omitted constructor
    // below its caller allows the allocating loop to resume before the
    // constructor Frame runs. Repeated allocations then accumulate dormant
    // constructor Frames and observe partially initialized objects. Keep the
    // constructor itself on the canonical call stack; its loop body may still
    // use structured SSA once the scheduler enters that Frame.
    if (restoringDirectPositionalEligible && method.name === "<init>") {
      restoringDirectPositionalEligible = false;
      restoringDirectRejection =
        "constructor initialization boundary requires a canonical frame";
    }
    // A synchronized method's Frame owns monitor acquisition/release and can
    // become scheduler-visible while contended. It may still use structured
    // SSA after canonical entry, but it cannot omit that Frame through the
    // restoring scalar ABI.
    if (restoringDirectPositionalEligible &&
        ((method.flags || []).includes("synchronized") ||
          (Number(method.accessFlags) & 0x0020) !== 0)) {
      restoringDirectPositionalEligible = false;
      restoringDirectRejection =
        "synchronized entry requires a canonical frame";
    }
    // A handler-protected ordinary method with a non-void child needs the
    // canonical caller Frame to own the child's eventual return operand.  The
    // same proof already selects the baseline framed entry above; publishing
    // a restoring positional entry would bypass that decision and can resume
    // the caller with the invoke operands shifted after a scheduler handoff.
    if (restoringDirectPositionalEligible &&
        requiresBaselineFramedEntry &&
        !this.jit.isJitSafeConstructor(method, items)) {
      restoringDirectPositionalEligible = false;
      restoringDirectRejection =
        "handler-protected non-void call requires a canonical caller frame";
    }
    // Direct self-recursion omits one JVM Frame per recursive level. That is
    // safe for a closed recursive kernel: any scalar deopt unwinds through
    // every generated invocation and restores the omitted levels in order.
    // It is not safe when the same method can suspend in an independently
    // dispatched child. The scheduler may complete that child before an
    // omitted recursive caller is resumed, leaving the caller at its
    // post-invoke PC without the child whose return owns that transition.
    // Keep this mixed call graph on the ordinary Frame-backed positional ABI.
    // This proof is solely over resolved call-site structure; names and guest
    // identities never participate.
    if (restoringDirectPositionalEligible && hasSelfRecursiveCall &&
        hasIndependentlySuspendableCall) {
      restoringDirectPositionalEligible = false;
      restoringDirectRejection =
        "self recursion mixed with independently suspendable calls";
    }
    if (!restoringDirectPositionalEligible) {
      restoringDirectRejection ||=
        "descriptor, owner, return type, or field-cache shape";
    }
    for (let index = 0;
      index < items.length && restoringDirectPositionalEligible;
      index += 1) {
      if (depths[index] === undefined || !normalReachableItems.has(index)) continue;
      const instruction = items[index]?.instruction;
      const op = opOf(instruction);
      if (!op) continue;
      if (!restoringDirectPositionalOps.has(op)) {
        restoringDirectPositionalEligible = false;
        restoringDirectRejection = `unsupported normal opcode ${op} at ${index}`;
        break;
      }
      // The scalar caller does not omit a constructor Frame. If a constructor
      // cannot complete through a proven synchronous target, the ordinary
      // call-site path restores this caller at the invokespecial PC and lets
      // canonical scheduling own the constructor. The already allocated
      // receiver remains on the restored operand stack, so the allocation is
      // neither lost nor replayed.
      // `aaload` may feed a primitive sub-array into a numeric loop without
      // becoming the method's return value (for example, a row of a matrix).
      // The renderer already preserves its null/bounds checks and exact
      // materialization state, so return-type shape is not an admission
      // invariant for intermediate references.
      if (op === "aaload" &&
          !verifiedNestedPrimitiveAaloads.has(index) &&
          !verifiedResolvedStaticReferenceAaloads.has(index) &&
          !restoringDirectReturnsArray &&
          !this.jit.isJitSafeConstructor(method, items)) {
        restoringDirectPositionalEligible = false;
        restoringDirectRejection =
          `unverified reference-array element at ${index}`;
        break;
      }
      if (op === "checkcast" &&
          restoringDirectReturnsReference &&
          !directPrimitiveDescriptors.has(instruction.arg)) {
        restoringDirectPositionalEligible = false;
        restoringDirectRejection =
          `non-primitive-array reference-return checkcast at ${index}`;
        break;
      }
      const constantValue = Number(instruction.arg?.value ?? instruction.arg);
      if ((op === "ldc" || op === "ldc_w") &&
          !Number.isFinite(constantValue)) {
        restoringDirectPositionalEligible = false;
        restoringDirectRejection = `non-integral constant at ${index}`;
        break;
      }
      if (op === "getfield") {
        const site = fieldSites.get(index);
        const plan = site === undefined ? null : this.jit.fieldSites[site];
        const scalarOrReference = plan &&
          (directPrimitiveDescriptors.has(plan.descriptor) ||
            referenceStaticPositionalEnabled &&
            typeof plan.descriptor === "string" &&
            (plan.descriptor.startsWith("L") ||
              plan.descriptor.startsWith("[")));
        if (!scalarOrReference ||
            (!effectfulFieldPositionalEnabled &&
              !fieldReadCacheSites.get(index)?.directKey)) {
          restoringDirectPositionalEligible = false;
          restoringDirectRejection =
            `unsupported primitive instance field at ${index}`;
          break;
        }
      }
      if (op === "getstatic") {
        const direct = directStaticSites.get(index);
        const lazy = lazyStaticSites.get(index);
        const descriptor = instruction.arg?.[2]?.[1];
        const scalarOrReference = directPrimitiveDescriptors.has(descriptor) ||
          referenceStaticPositionalEnabled &&
          typeof descriptor === "string" &&
          (descriptor.startsWith("L") || descriptor.startsWith("["));
        if ((!direct && !lazy) || !scalarOrReference) {
          restoringDirectPositionalEligible = false;
          restoringDirectRejection =
            `unresolved direct or linkable static field at ${index}`;
          break;
        }
      }
    }
    const structuredPositionalTrace = typeof process !== "undefined" &&
      process.env ? process.env.JVM_TRACE_STRUCTURED_POSITIONAL || "" : "";
    const structuredMethodKey =
      `${directMethodOwner || "?"}.${method.name}${method.descriptor}`;
    if (structuredPositionalTrace &&
        structuredMethodKey.includes(structuredPositionalTrace)) {
      console.error("[structured-positional]", JSON.stringify({
        method: structuredMethodKey,
        loops: structured.loopHeaders.size,
        normalItems: normalReachableItems.size,
        direct: directPositionalEligible,
        restoring: restoringDirectPositionalEligible,
        rejection: restoringDirectPositionalEligible
          ? null : restoringDirectRejection,
      }));
    }
    // Unwind markers behave identically to plain materializations in every
    // spill-based output; only the capture-free restoring expansion treats
    // them specially. The release marker is a no-op outside that expansion.
    const materializeHelperDeclarations = () => [
      ...[...materializeDepths, ...materializeUnwindDepths]
        .filter((depth, position, all) => all.indexOf(depth) === position)
        .sort((left, right) => left - right)
        .flatMap((depth) => {
          const operands = Array.from(
            {length: depth}, (_unused, index) => `operand${index}`);
          const declared = [];
          if (materializeDepths.has(depth)) declared.push("");
          if (materializeUnwindDepths.has(depth)) declared.push("Unwind");
          return declared.flatMap((variant) => [
            `function ssaMaterialize${variant}${depth}(pc${
              operands.length ? `, ${operands.join(", ")}` : ""}) {`,
            "  spillLocals();",
            ...operands.map((operand, index) =>
              `  stack[${index}] = ${operand};`),
            `  stack.length = ${depth};`,
            "  helpers.materialize(frame, locals, stack, pc);",
            "}",
          ]);
        }),
      ...(materializeUnwindDepths.size
        ? ["function ssaMaterializeUnwindRelease() {}"] : []),
    ];
    const inlineMaterializeCalls = (lines) =>
      lines.flatMap((line) => {
        const record = recordOf(line);
        if (record?.kind === "materializeRelease") return [];
        if (record?.kind !== "materialize") return [line];
        const prefix = indentationOf(line);
        return [
          `${prefix}${spillStatement()}`,
          ...record.operands.map((operandExpression, index) =>
            `${prefix}${stmt(e`stack[${index}] = ${operandExpression};`,
              {kind: "spillStack"})}`),
          `${prefix}${st`stack.length = ${record.operands.length};`}`,
          `${prefix}${stmt(e`helpers.materialize(frame, locals, stack, ${
            record.pc});`, {kind: "materializeSpill"})}`,
        ];
      });
    const eliminatedCheckedLeafLocalSlots = new Set();
    const compactCheckedLeafLines = (
      sourceLines, checkedLeafSemantics = true,
    ) => {
      if (process.env.JVM_JIT_VERIFY_STATEMENT_IR) {
        auditStatementIrLines(sourceLines, statementRecords, emittedNames,
          checkedLeafSemantics ? "leaf" : "restoring");
      }
      // Every pass below reasons about which names a statement defines and
      // reads. A line the emitters did not record has an unknown read set, so
      // the whole body is left alone rather than optimized on a guess.
      if (sourceLines.some(
        (line) => line.trim() !== "" && !recordOf(line))) {
        return [...sourceLines];
      }
      let lines = [...sourceLines];
      const recordAt = (index) => recordOf(lines[index]);
      const refsAt = (index) => partsReferences(recordAt(index)?.parts || []);
      // A self-recursive call and a specialized safe-arithmetic call pin the
      // operands they read.
      //
      // A lexically inserted checked leaf needs no such pinning. Its own
      // statements reference only names it declares inside its block, and the
      // caller-side bindings that feed it are ordinary statements of this
      // compile, so substituting an immutable local alias or an unassigned SSA
      // value into one is exactly as sound there as anywhere else. (The text
      // version tried to exclude those lines with
      // `/^\s*ssaInlineCheckedLeaf\d+: \{$/`, which never matched the
      // `ssaInlineCheckedLeaf<serial>_<pc>` labels the emitter produces, so
      // that exclusion never affected a generated body.)
      const selfRecursiveProtectedValues = new Set(lines
        .flatMap((_line, index) =>
          recordAt(index)?.pinned === true ? refsAt(index) : [])
        .filter((name) => ownSsaValueNames.has(name)));
      // Restoring bodies expose the coarse-loop and range predicates as
      // explicit guard sites used by deoptimization and diagnostics. Keep
      // those names stable there; checked leaves have no restoring contract
      // and may freely propagate the predicates as ordinary SSA values.
      const isCompactable = (name) => ownSsaValueNames.has(name) ||
        checkedLeafSemantics && checkedLeafCompactableNames.has(name);
      const occurrenceCounts = () => {
        const counts = new Map();
        for (let index = 0; index < lines.length; index += 1) {
          for (const name of refsAt(index)) {
            if (!isCompactable(name)) continue;
            counts.set(name, (counts.get(name) || 0) + 1);
          }
        }
        return counts;
      };
      // Loads of locals that are never assigned in the rendered region are
      // immutable aliases. Substitute them directly; unlike mutable-local
      // snapshots, they do not need a distinct SSA register.
      const aliases = new Map();
      const removedAliases = new Set();
      const assignedLocals = checkedLeafSemantics
        ? renderedAssignedLocalSlots : callerAssignedLocalSlots;
      for (let index = 0; index < lines.length; index += 1) {
        const record = recordAt(index);
        if (record?.kind !== "const" ||
            !Number.isInteger(record.localSnapshot) ||
            assignedLocals.has(record.localSnapshot)) continue;
        if (selfRecursiveProtectedValues.has(record.def)) continue;
        aliases.set(record.def, [{ref: localName(record.localSnapshot)}]);
        removedAliases.add(index);
      }
      if (aliases.size) {
        lines = substituteInLines(lines, aliases)
          .filter((_line, index) => !removedAliases.has(index));
      }

      // Inline one-use pure arithmetic snapshots when none of the referenced
      // mutable locals changes before the use. This is ordinary SSA expression
      // propagation; array loads remain ordered unless they feed the very next
      // proven raw store in a checked leaf.
      for (;;) {
        const counts = occurrenceCounts();
        let changed = false;
        for (let declarationIndex = 0;
          declarationIndex < lines.length; declarationIndex += 1) {
          const declaration = recordAt(declarationIndex);
          if (declaration?.kind !== "const" ||
              !isCompactable(declaration.def) ||
              counts.get(declaration.def) !== 2) continue;
          if (selfRecursiveProtectedValues.has(declaration.def)) continue;
          let useIndex = -1;
          for (let index = declarationIndex + 1; index < lines.length; index += 1) {
            if (!refsAt(index).includes(declaration.def)) continue;
            useIndex = index;
            break;
          }
          if (useIndex < 0) continue;
          const use = recordAt(useIndex);
          const immediateRawStore = declaration.rawArrayLoad &&
            useIndex === declarationIndex + 1 &&
            use?.kind === "arrayStore" &&
            entryArrayDataNames.has(use.storeTarget);
          if (declaration.rawArrayLoad && !immediateRawStore ||
              !checkedLeafSemantics && declaration.division ||
              !declaration.pure) continue;
          const referencedLocals = partsReferences(declaration.exprParts)
            .filter((name) => localSlotOfName(name) !== null);
          const localChanged = referencedLocals.some((name) =>
            lines.slice(declarationIndex + 1, useIndex).some((line) =>
              recordOf(line)?.write === name));
          if (localChanged) continue;
          lines[useIndex] = `${indentationOf(lines[useIndex])}${
            rerenderStatement(use, new Map([[declaration.def,
              ["(", ...declaration.exprParts, ")"]]])).trim()}`;
          lines[declarationIndex] = '';
          changed = true;
        }
        if (!changed) break;
        lines = lines.filter(Boolean);
      }

      // A stack temporary commonly becomes a local update on the immediately
      // following line. Preserve the old local snapshot used by the array
      // access, but avoid a second one-use SSA register for the new value.
      for (;;) {
        const counts = occurrenceCounts();
        let changed = false;
        for (let index = 0; index + 1 < lines.length; index += 1) {
          const declaration = recordAt(index);
          if (declaration?.kind !== "const" ||
              !ownSsaValueNames.has(declaration.def) ||
              counts.get(declaration.def) !== 2) continue;
          const assignment = recordAt(index + 1);
          if (!isLocalCopy(assignment, declaration.def) ||
              indentationOf(lines[index]) !==
                indentationOf(lines[index + 1])) continue;
          lines[index] = '';
          lines[index + 1] = `${indentationOf(lines[index + 1])}${
            storeLocal(assignment.write, new Expr(declaration.exprParts),
              {pure: declaration.pure, division: declaration.division,
                rawArrayLoad: declaration.rawArrayLoad})}`;
          changed = true;
        }
        if (!changed) break;
        lines = lines.filter(Boolean);
      }

      // A javac pre-increment often survives as old/new SSA snapshots because
      // the new value feeds both the local and the following comparison.
      // Render it as a direct local update and compare the updated local.
      for (;;) {
        const counts = occurrenceCounts();
        let changed = false;
        for (let index = 0; index + 2 < lines.length; index += 1) {
          const next = recordAt(index);
          if (next?.kind !== "const" || !ownSsaValueNames.has(next.def) ||
              counts.get(next.def) !== 3) continue;
          const assignment = recordAt(index + 1);
          if (!isLocalCopy(assignment, next.def) ||
              indentationOf(lines[index]) !==
                indentationOf(lines[index + 1])) continue;
          if (!refsAt(index + 2).includes(next.def)) continue;
          lines[index] = '';
          lines[index + 1] = `${indentationOf(lines[index + 1])}${
            storeLocal(assignment.write, new Expr(next.exprParts),
              {pure: next.pure, division: next.division,
                rawArrayLoad: next.rawArrayLoad})}`;
          lines[index + 2] = `${indentationOf(lines[index + 2])}${
            rerenderStatement(recordAt(index + 2),
              new Map([[next.def, [{ref: assignment.write}]]])).trim()}`;
          changed = true;
        }
        if (!changed) break;
        lines = lines.filter(Boolean);
      }

      // Fold a snapshot used only to update the same local. Java evaluates
      // the right-hand side before the assignment, so direct self-update is
      // identical and exposes a conventional induction variable to the host.
      for (;;) {
        const counts = occurrenceCounts();
        let changed = false;
        for (let index = 0; index + 1 < lines.length; index += 1) {
          const snapshot = recordAt(index);
          if (snapshot?.kind !== "const" ||
              !ownSsaValueNames.has(snapshot.def) ||
              !Number.isInteger(snapshot.localSnapshot) ||
              counts.get(snapshot.def) !== 2) continue;
          const target = localName(snapshot.localSnapshot);
          const update = recordAt(index + 1);
          if (update?.kind !== "store" || update.write !== target ||
              !partsReferences(update.exprParts).includes(snapshot.def) ||
              indentationOf(lines[index]) !==
                indentationOf(lines[index + 1])) continue;
          lines[index] = '';
          lines[index + 1] = `${indentationOf(lines[index + 1])}${
            rerenderStatement(update,
              new Map([[snapshot.def, [{ref: target}]]])).trim()}`;
          changed = true;
        }
        if (!changed) break;
        lines = lines.filter(Boolean);
      }

      // Branch folding above can leave a labeled block whose sole remaining
      // exit is an unconditional trailing break. SSA names are globally
      // unique, so the lexical wrapper is unnecessary once that break is
      // gone. Remove both to avoid a host control-flow node per pixel/row.
      for (;;) {
        let changed = false;
        for (let start = 0; start < lines.length; start += 1) {
          const opening = recordAt(start);
          if (opening?.kind !== "blockLabel") continue;
          const indentation = indentationOf(lines[start]);
          let depth = 1;
          let end = start + 1;
          for (; end < lines.length; end += 1) {
            depth += recordAt(end)?.blockDelta || 0;
            if (depth === 0) break;
          }
          if (end >= lines.length) continue;
          const trailing = recordAt(end - 1);
          if (trailing?.kind !== "break" ||
              trailing.label !== opening.label ||
              indentationOf(lines[end - 1]) !== `${indentation}  `) continue;
          lines.splice(end - 1, 2);
          lines.splice(start, 1);
          for (let index = start; index < end - 2; index += 1) {
            if (lines[index].startsWith(`${indentation}  `)) {
              lines[index] = indentation +
                lines[index].slice(indentation.length + 2);
            }
          }
          changed = true;
          break;
        }
        if (!changed) break;
      }
      // Transactional primitive loads use `undefined` only as the exceptional
      // sentinel. Once their cold arm has become an entry bailout, collapse
      // the renderer's assignment-in-condition/constant-ternary scaffold to
      // one raw load and one ordinary guard. This applies to any primitive
      // array view and index expression, not to a particular sampler.
      if (checkedLeafSemantics) {
        for (let index = 0; index + 5 < lines.length; index += 1) {
          const declaration = recordAt(index);
          if (declaration?.kind !== "letUninitialized") continue;
          const name = declaration.def;
          const indentation = indentationOf(lines[index]);
          const load = recordAt(index + 1);
          if (load?.kind !== "rangeGuardedAccess" || load.guard !== "false" ||
              !load.rawLoad || load.loadTarget !== name ||
              indentationOf(lines[index + 1]) !== indentation) continue;
          const bail = recordAt(index + 2);
          const alternate = recordAt(index + 3);
          const success = recordAt(index + 4);
          const close = recordAt(index + 5);
          if (bail?.kind !== "leafBail" ||
              lines[index + 2] !== `${indentation}  ${bail.key}` ||
              alternate?.kind !== "elseArm" ||
              indentationOf(lines[index + 3]) !== indentation ||
              success?.kind !== "guardedLoad" || success.guard !== "false" ||
              success.target !== name ||
              renderParts(success.ordinary.parts) !== `((${name}) | 0)` ||
              indentationOf(lines[index + 4]) !== `${indentation}  ` ||
              close?.kind !== "blockEnd" ||
              indentationOf(lines[index + 5]) !== indentation) continue;
          lines.splice(index, 6,
            `${indentation}${constDecl(name, load.rawLoad,
              {pure: true, rawArrayLoad: true})}`,
            `${indentation}${stmt(exprConcat(
              e`if (${name} === undefined) `,
              e`${leafBailStatement()}`))}`);
        }

        // Checked leaves have already proved that their normal path cannot
        // materialize a Frame. Source-level JVM temporaries therefore need
        // not survive merely for a hypothetical spill. Propagate a simple
        // SSA alias only when its sole textual definition dominates every
        // read inside the same lexical scope; remove write-only aliases after
        // their value-producing instruction has already executed. Loop
        // induction variables and branch-carried locals necessarily have
        // multiple definitions or reads outside that scope and are retained.
        const localDeclarations = new Map();
        const localAssignments = new Map();
        const localReads = new Map();
        for (let index = 0; index < lines.length; index += 1) {
          const record = recordAt(index);
          if (record?.kind === "letUndefinedLocal") {
            localDeclarations.set(record.def, index);
          }
          if (record?.kind === "store" &&
              localSlotOfName(record.write) !== null &&
              record.exprParts?.length === 1 &&
              typeof record.exprParts[0] !== "string" &&
              ownSsaValueNames.has(record.exprParts[0].ref)) {
            const values = localAssignments.get(record.write) || [];
            values.push({
              index,
              indentation: indentationOf(lines[index]).length,
              value: record.exprParts[0].ref,
            });
            localAssignments.set(record.write, values);
          }
          // Every occurrence of a local is a read, except the name a
          // `let local<slot> = undefined;` introduces and the target of a
          // plain `local<slot> = <ssa value>;` copy. A self-update such as
          // `local3 = (local3 + 1) | 0;` reads the slot on both sides.
          const occurrences = partsReferences(record?.parts || []);
          if (record?.kind === "letUndefinedLocal") {
            const at = occurrences.indexOf(record.def);
            if (at >= 0) occurrences.splice(at, 1);
          } else if (record?.kind === "store" &&
              localSlotOfName(record.write) !== null &&
              record.exprParts?.length === 1 &&
              typeof record.exprParts[0] !== "string" &&
              ownSsaValueNames.has(record.exprParts[0].ref)) {
            const at = occurrences.indexOf(record.write);
            if (at >= 0) occurrences.splice(at, 1);
          }
          for (const name of occurrences) {
            if (localSlotOfName(name) === null) continue;
            const reads = localReads.get(name) || [];
            reads.push(index);
            localReads.set(name, reads);
          }
        }
        const removeLocalLines = new Set();
        for (const [name, assignments] of localAssignments) {
          const declarationIndex = localDeclarations.get(name);
          const reads = localReads.get(name) || [];
          if (!reads.length && assignments.length > 0) {
            if (Number.isInteger(declarationIndex)) {
              removeLocalLines.add(declarationIndex);
            }
            for (const assignment of assignments) {
              removeLocalLines.add(assignment.index);
            }
            eliminatedCheckedLeafLocalSlots.add(localSlotOfName(name));
            continue;
          }
          if (assignments.length !== 1 || !reads.length) continue;
          const assignment = assignments[0];
          let scopeEnd = lines.length;
          for (let index = assignment.index + 1;
            index < lines.length; index += 1) {
            const record = recordAt(index);
            const closes = record?.kind === "blockEnd" ||
              record?.kind === "elseArm" || record?.kind === "elseIfArm";
            const indentation = indentationOf(lines[index]).length;
            if (closes && indentation < assignment.indentation) {
              scopeEnd = index;
              break;
            }
          }
          if (reads.some((index) =>
            index <= assignment.index || index >= scopeEnd)) continue;
          const replacement = new Map([[name, [{ref: assignment.value}]]]);
          for (const index of reads) {
            lines[index] = `${indentationOf(lines[index])}${
              rerenderStatement(recordAt(index), replacement).trim()}`;
          }
          if (Number.isInteger(declarationIndex)) {
            removeLocalLines.add(declarationIndex);
          }
          removeLocalLines.add(assignment.index);
          eliminatedCheckedLeafLocalSlots.add(localSlotOfName(name));
        }
        if (removeLocalLines.size) {
          lines = lines.filter((_line, index) =>
            !removeLocalLines.has(index));
        }
      }
      // Remove pure SSA declarations left without a consumer after the
      // checked-leaf rewrites above.
      for (;;) {
        const counts = occurrenceCounts();
        const previousLength = lines.length;
        lines = lines.filter((line) => {
          const record = recordOf(line);
          if (record?.kind !== "const" ||
              !ownSsaValueNames.has(record.def)) {
            return true;
          }
          return counts.get(record.def) !== 1 || !record.pure ||
            record.indexed === true;
        });
        if (lines.length === previousLength) break;
      }
      return lines;
    };
    const strengthReduceAffineStoreLoops = (sourceLines) => {
      const lines = [...sourceLines];
      for (let index = 0; index + 4 < lines.length; index += 1) {
        const opening = recordOf(lines[index]);
        if (opening?.kind !== "loopHeader" || !opening.inductionLocal ||
            localSlotOfName(opening.bound) === null) continue;
        const indentation = indentationOf(lines[index]);
        const induction = opening.inductionLocal;
        const bound = opening.bound;
        const alias = recordOf(lines[index + 1]);
        const store = recordOf(lines[index + 2]);
        const update = recordOf(lines[index + 3]);
        const close = recordOf(lines[index + 4]);
        if (alias?.kind !== "const" ||
            localSlotOfName(induction) !== alias.localSnapshot ||
            indentationOf(lines[index + 1]) !== `${indentation}  ` ||
            store?.kind !== "arrayStore" || !store.storeTarget ||
            indentationOf(lines[index + 2]) !== `${indentation}  ` ||
            close?.kind !== "blockEnd" ||
            indentationOf(lines[index + 4]) !== indentation) continue;
        // The increment is either the emitter's masked int32 form or the
        // unmasked form interval analysis proved cannot overflow.
        const updateText = update?.kind === "store" &&
          update.write === induction &&
          indentationOf(lines[index + 3]) === `${indentation}  `
          ? renderParts(update.exprParts) : null;
        if (updateText !== `(${alias.def} + 1) | 0` &&
            updateText !== `(${alias.def} + 1)`) continue;
        // The index must be `base + i` over exactly one loop-invariant local.
        const indexText = renderParts(store.storeIndex.parts);
        const localNames = [...new Set(
          partsReferences(store.storeIndex.parts)
            .filter((name) => localSlotOfName(name) !== null))];
        if (localNames.length !== 1) continue;
        const base = localNames[0];
        if (base === induction || base === bound ||
            ![`((${base} + ${alias.def}) | 0)`,
              `((${alias.def} + ${base}) | 0)`,
              `(${base} + ${alias.def}) | 0`,
              `(${alias.def} + ${base}) | 0`].includes(indexText) ||
            partsReferences(store.storeValue.parts).some((name) =>
              name === alias.def || name === induction ||
              name === base)) continue;
        const suffix = opening.label.slice(1);
        const end = named(`ssaAffineStoreEnd${suffix}`);
        lines.splice(index, 5,
          `${indentation}${constDecl(end, e`${base} + ${bound}`)}`,
          `${indentation}${storeLocal(induction, e`${base} + ${induction}`)}`,
          `${indentation}${stmt(e`${opening.label}: while (${
            induction} < ${end}) {`, {kind: "loopHeader",
            label: opening.label, inductionLocal: null, bound: null})}`,
          `${indentation}  ${stmt(e`${store.storeTarget}[${induction}] = ${
            store.storeValue};`, {kind: "arrayStore",
            storeTarget: store.storeTarget, storeIndex: e`${induction}`,
            storeValue: store.storeValue})}`,
          `${indentation}  ${stmt(e`${induction} += 1;`)}`,
          blockEnd(indentation),
          `${indentation}${stmt(e`${induction} -= ${base};`)}`);
        index += 6;
      }
      return lines;
    };
    const transactionalizeAcyclicLeafLines = (sourceLines) => {
      const lines = [...sourceLines];
      const output = [];
      for (let index = 0; index < lines.length; index += 1) {
        const opening = recordOf(lines[index]);
        if (opening?.conditional !== true) {
          output.push(lines[index]);
          continue;
        }
        let depth = 1;
        let boundary = -1;
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
          const record = recordOf(lines[cursor]);
          if (depth === 1 && (record?.kind === "blockEnd" ||
              record?.kind === "elseArm" || record?.kind === "elseIfArm")) {
            boundary = cursor;
            break;
          }
          depth += record?.blockDelta || 0;
        }
        if (boundary < 0) {
          output.push(lines[index]);
          continue;
        }
        // The arm is a cold reconstruct-and-throw arm: it opens with the
        // frame reconstruction the emitter writes there, and it performs an
        // operation whose only purpose is to raise the guest exception.
        const first = recordOf(lines[index + 1] || "");
        const opensReconstruction = first?.kind === "conditionalSpill" ||
          first?.kind === "spill" || first?.kind === "materialize";
        const raises = lines.slice(index + 1, boundary).some((line) =>
          recordOf(line)?.deoptEffect === true);
        if (!opensReconstruction || !raises) {
          output.push(lines[index]);
          continue;
        }
        output.push(lines[index],
          leafBailStatement(`${indentationOf(lines[index])}  `));
        index = boundary - 1;
      }
      return output;
    };
    // Collapse a reducible three-block crossing diamond into its direct
    // boolean form. The matcher follows only label targets and comparison
    // topology. Invert the branch comparisons algebraically instead of
    // emitting `!(a > b)`: host optimizers consistently recognize the
    // canonical `a <= b && ...` form more effectively.
    const invariantPositionalCallDeclarationsFor = (
      omitSelfRecursive = false,
    ) => [...invariantPositionalReceiverSlots]
      .filter(([index]) => !omitSelfRecursive ||
        !callSites.get(index)?.selfRecursive)
      .map(([index, slot]) => constDecl(
        invariantPositionalRawVariable(index), exprConcat(
          e`${positionalCallRawInvokeVariable(index)} && `,
          e`${positionalCallRawInvokeVariable(index)}.jvmInlineInteger === true && `,
          e`${localName(slot)} !== null && ${localName(slot)} !== undefined && `,
          e`(${localName(slot)}.type || ${
            positionalCallSiteVariable(index)}.declaredClassName) === `,
          e`${positionalCallReceiverVariable(index)} ? `,
          e`${positionalCallRawInvokeVariable(index)} : null`)));
    const invariantPositionalCallDeclarations =
      invariantPositionalCallDeclarationsFor(false);
    const directInvariantPositionalCallDeclarations =
      invariantPositionalCallDeclarationsFor(true);
    for (const index of invariantPositionalReceiverSlots.keys()) {
      ssaValueNames.add(invariantPositionalRawVariable(index));
    }
    const buildBody = (
      tree, entrySafePointBudget = safePointInitialBudget,
    ) => ["'use strict';",
      "const locals = frame.locals;", "const stack = frame.stack.items;",
      "if ((!framelessEntry && frame.pc !== 0) || (initialBytecodeChecks === undefined ? helpers.needsBytecodeChecks() : initialBytecodeChecks)) { helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'structured SSA entry' }; }",
      staticInitializationGuardDeclaration,
      staticEntryGuard,
      ...directStaticDeclarations,
      ...lazyStaticDeclarations,
      ...entryStaticReadDeclarations,
      ...positionalCallDeclarations,
      guardedStaticBooleanEntryGuard,
      this.runCountersEnabled
        ? "helpers.structuredSsa.runCount += 1;" : null,
      stmt(e`let safePointBudget = ${entrySafePointBudget};`,
        {kind: "safePointBudgetDeclaration"}),
      ...declaredLocals.map((i) => {
        const initial = entryLocalInitialValues.has(i)
          ? entryLocalInitialValues.get(i) : `locals[${i}]`;
        const value = !entryLocalInitialValues.has(i) && entryScalarKinds.has(i)
          ? normalizeJvmScalarExpression(initial, entryScalarKinds.get(i))
          : initial;
        return `${immutableEntryLocals.has(i) ? "const" : "let"} local${i} = ${value};`;
      }),
      ...invariantPositionalCallDeclarations,
      ...entryArrayDataDeclarations,
      ...persistentStaticArrayDataDeclarations,
      ...fieldReadCacheDeclarations,
      ...fieldReadCacheInitializations,
      framedArrayDataGuard,
      `const spillLocals = () => {${spillSlots.map((i) => ` locals[${i}] = ${
        immutableEntryLocals.has(i) ? entryLocalInitialValues.get(i) : `local${i}`};`).join("")} };`,
      ...materializeHelperDeclarations(),
      ...declarations, ...tree];
    const body = buildBody(renderedTree);
    const canonicalGeneratedSource = body.join("\n");
    // Loop outlining and straight-line partitioning of the continuation tier
    // are selections over the statement records the emitters wrote, so they
    // need the canonical body as a fragment list. The body's prologue still
    // carries lines no emitter recorded -- the entry scaffold, the local
    // declarations, the spill helper and the frame materialization helpers --
    // so `regionFragmentsOf` declines it and both passes are inert here until
    // those emitters record what they write. They stay wired: nothing about
    // them is specific to the region tier.
    const canonicalFragments = this.loopOutliningEnabled ||
      this.linearPartitionEnabled
      ? regionFragmentsOf(body.filter((line) => typeof line === "string"))
      : null;
    const canonicalStatements = canonicalFragments
      ? canonicalFragments.flatMap((fragment) => fragment.statements) : null;
    const outlinedGenerated = this.loopOutliningEnabled && useContinuations &&
      canonicalStatements
      ? outlineLargeRegionLoops(
        regionUnit({statements: canonicalStatements, generator: true}), {
          minimumSourceBytes: this.loopOutlineSourceBytes,
          maximumOutlines: 32,
          namespace: 97,
        })
      : {unit: null, helpers: [], count: 0, outlinedSourceBytes: 0};
    const outlinedGeneratedUnits = outlinedGenerated.count > 0
      ? [outlinedGenerated.unit, ...outlinedGenerated.helpers]
      : (canonicalStatements
        ? [regionUnit({statements: canonicalStatements, generator: true})]
        : null);
    const outlinedGeneratedSource = outlinedGeneratedUnits
      ? outlinedGeneratedUnits.map(renderRegionUnit).join("\n")
      : canonicalGeneratedSource;
    const partitionedGenerated = this.linearPartitionEnabled &&
      useContinuations && outlinedGeneratedUnits &&
      outlinedGeneratedSource.length > this.linearPartitionUnitBytes
      ? partitionOversizedLinearBlocks(outlinedGeneratedUnits, {
        maximumUnitBytes: this.linearPartitionUnitBytes,
        targetSegmentBytes: this.linearPartitionSegmentBytes,
        minimumSegmentBytes: this.linearPartitionMinimumSegmentBytes,
        namespace: "structured",
      })
      : {units: outlinedGeneratedUnits, count: 0, partitionedSourceBytes: 0};
    const generatedSource = partitionedGenerated.count > 0 ||
      outlinedGenerated.count > 0
      ? partitionedGenerated.units.map(renderRegionUnit).join("\n")
      : canonicalGeneratedSource;
    try {
      const positionalAstRejections = [];
      const createStructuredFunction = (tier, parameters, source, ...options) => {
        // Every SSA name a tier can reference is bound by the emitter that
        // produced it: operand names come from one renderer-wide counter, and
        // a lexical insertion binds the inserted body's own parameter and
        // capture names by declaration rather than renaming the child's text.
        // Nothing here reads the emitted JavaScript back to decide what to
        // install. JVM_JIT_VERIFY_GENERATED=1 re-checks that property by
        // parsing the finished source; it is a development assertion, not a
        // compilation step.
        if (this.verifyGeneratedScopes) {
          const unbound = unboundGeneratedSsaIdentifiers(source, ssaValueNames);
          if (unbound.length) {
            if (tier === "structured-ssa") {
              throw new Error(
                `unbound structured SSA identifiers: ${unbound.join(", ")}`);
            }
            positionalAstRejections.push({ tier, unbound });
            return null;
          }
        }
        return this.jit.createGeneratedFunction(
          method, tier, parameters, source, ...options);
      };
      const generatedBody = createStructuredFunction("structured-ssa",
        ["frame", "thread", "helpers", "initialBytecodeChecks", "framelessEntry"], generatedSource,
        null, false, useContinuations);
      let directPositionalBody = null;
      let directPositionalSource = null;
      let internalRegionPositionalSource = null;
      let internalRegionPositionalInsertion = null;
      let restoringDirectPositionalInsertion = null;
      // Statement-level fragments of each positional variant, published for a
      // consumer that outlines, partitions or env-lifts a body. They are only
      // published when the assembled lines survive to the published source
      // unchanged; the self-recursive respecialization below is a text splice
      // over the joined module, so a body that needs it publishes none.
      const regionFragments = {};
      if (directPositionalEligible || internalRegionPositionalEligible) {
        const receiverSlots = methodIsStatic ? 0 : 1;
        const argumentCount = directMethodDescriptor.params.length + receiverSlots;
        const argumentNames = Array.from(
          { length: argumentCount }, (_unused, index) => `argument${index}`);
        const entryArguments = new Map();
        let slot = 0;
        if (!methodIsStatic) {
          entryArguments.set(0, "argument0");
          slot = 1;
        }
        for (let index = 0; index < directMethodDescriptor.params.length; index += 1) {
          entryArguments.set(slot++, `argument${index + receiverSlots}`);
        }
        const entryArgumentValue = (index) => {
          const argument = entryArguments.get(index);
          if (!argument || index < receiverSlots) return argument;
          return normalizeJvmScalarExpression(
            argument, directMethodDescriptor.params[index - receiverSlots]);
        };
        const owners = [...new Set([directMethodOwner, ...directStaticOwners])];
        const directInitializationGuardId =
          this.registerClassInitializationGuard(owners);
        const directInitializationGuardDeclaration =
          `const ssaDirectClassInitializationGuard = ` +
          `helpers.structuredSsa.classInitializationGuards[${directInitializationGuardId}];`;
        const directInitializationCondition =
          "((ssaDirectClassInitializationGuard.classEpoch !== " +
          "(helpers.jvm.classEpoch || 0) || " +
          "ssaDirectClassInitializationGuard.initializationEpoch !== " +
          "(helpers.jvm.classInitializationEpoch || 0)) && " +
          "!helpers.structuredSsa.verifyClassInitializationGuard(" +
          "ssaDirectClassInitializationGuard))";
        const directGuardConditions = [
          "(!nestedEntryGuarded && helpers.needsBytecodeChecks())",
          `(nestedEntryGuarded !== 2 && ${directInitializationCondition})`,
        ];
        const directGuard = directGuardConditions.length
          ? `if (${directGuardConditions.join(" || ")}) ` +
            "{ return helpers.asyncInvokeSentinel(); }"
          : null;
        const directBooleanGuard = guardedStaticBooleanSites.size
          ? `if (${[...guardedStaticBooleanSites.values()].map((direct) => `((${
            direct.kind === "map"
              ? `${direct.variable}.get(${JSON.stringify(direct.key)})`
              : `${direct.variable}[${JSON.stringify(direct.key)}]`} ? 1 : 0) !== ${
            direct.guardedBooleanValue})`).join(" || ")}) { ` +
            "helpers.structuredSsa.guardedBooleanFallbackCount += 1; " +
            "return helpers.asyncInvokeSentinel(); }"
          : null;
        const directRenderedTree = expandContinuationFallbacks(
          render(structured.tree, false, true), false);
        if (directPositionalEligible) {
          const directPositionalLines = [
            directInitializationGuardDeclaration,
            directGuard,
            ...directStaticDeclarations,
            ...lazyStaticDeclarations,
            ...directEntryStaticReadDeclarations,
            ...directPositionalCallDeclarations,
            directBooleanGuard,
            this.runCountersEnabled
              ? selfRecursiveCallExpressions.size
                ? stmt(exprConcat(e`if (nestedEntryGuarded !== 2) `,
                  e`helpers.structuredSsa.runCount += 1;`))
                : st`helpers.structuredSsa.runCount += 1;` : null,
            stmt(e`let safePointBudget = ${regionCallGraphCandidate
              ? this.jit.hotCallGraphRegions.directSafePointBudget
              : safePointInitialBudget};`,
            {kind: "safePointBudgetDeclaration"}),
            ...declaredLocals.map((index) =>
              entryLocalDeclaration(index, entryArgumentValue)),
            ...directInvariantPositionalCallDeclarations,
            ...entryArrayDataDeclarations,
            ...persistentStaticArrayDataDeclarations,
            directArrayDataGuard,
            ...declarations,
            ...directRenderedTree,
          ].filter(Boolean);
          directPositionalSource = specializeSelfRecursiveCalls(
            ["'use strict';", ...directPositionalLines].join("\n"),
            "ssa-direct-positional", false);
          if (!selfRecursiveCallExpressions.size) {
            regionFragments.jvmDirectPositionalSource =
              regionFragmentsOf(directPositionalLines);
          }
        }
        const internalRegionPositionalLines = [
          ...directStaticDeclarations,
          ...lazyStaticDeclarations,
          ...directEntryStaticReadDeclarations,
          ...directPositionalCallDeclarations,
          directBooleanGuard,
          structured.loopHeaders.size > 0
            ? stmt(e`let safePointBudget = ${regionCallGraphCandidate
              ? this.jit.hotCallGraphRegions.directSafePointBudget
              : safePointInitialBudget};`,
            {kind: "safePointBudgetDeclaration"})
            : null,
          ...declaredLocals.map((index) =>
              entryLocalDeclaration(index, entryArgumentValue)),
          ...directInvariantPositionalCallDeclarations,
          ...entryArrayDataDeclarations,
          ...persistentStaticArrayDataDeclarations,
          directArrayDataGuard,
          ...declarations,
          ...directRenderedTree,
        ].filter(Boolean);
        internalRegionPositionalSource = specializeSelfRecursiveCalls(
          ["'use strict';", ...internalRegionPositionalLines].join("\n"),
          "ssa-internal-region-positional", false);
        if (!selfRecursiveCallExpressions.size) {
          regionFragments.jvmInternalRegionPositionalSource =
            regionFragmentsOf(internalRegionPositionalLines);
          // The same body in the form a caller inserts. It is assembled from
          // the same statement list, so the two variants differ only in how
          // the body leaves: a standalone entry returns, an inserted copy
          // assigns the caller's result slot and breaks out of the caller's
          // labeled block. A respecialized body publishes none, exactly as it
          // publishes no fragments: that specialization is a text splice over
          // the joined module and the statements no longer describe it.
          const insertable = insertableBodyOf(internalRegionPositionalLines);
          if (process.env.JVM_DEBUG_INSERTION_VETO && !insertable) {
            require("fs").appendFileSync(process.env.JVM_DEBUG_INSERTION_VETO,
              "VETO internal-body-rejected\n");
          }
          if (process.env.JVM_JIT_VERIFY_STATEMENT_IR && insertable) {
            auditStatementIrLines(insertable.lines, statementRecords,
              emittedNames, "internal-region-insertion");
          }
          internalRegionPositionalInsertion =
            publishInsertion(insertable, argumentNames);
        }
        if (directPositionalEligible) {
          directPositionalBody = createStructuredFunction(
            "ssa-direct-positional",
            ["helpers", ...argumentNames, "thread", "nestedEntryGuarded"],
            directPositionalSource,
            null, false, false, methodSpecializedCheckedCaptures,
          );
        }
      }
      let restoringDirectPositionalBody = null;
      let restoringDirectPositionalSource = null;
      let checkedLeafDirectPositionalBody = null;
      let checkedLeafDirectPositionalSource = null;
      let trustedCheckedLeafDirectPositionalBody = null;
      let trustedCheckedLeafDirectPositionalSource = null;
      let preflightedCheckedLeafDirectPositionalBody = null;
      let preflightedCheckedLeafDirectPositionalSource = null;
      let capturedCheckedLeafDirectPositionalBody = null;
      let capturedCheckedLeafDirectPositionalSource = null;
      let capturedCheckedLeafDirectPositionalPlan = null;
      let checkedLeafInlineBody = null;
      let capturedCheckedLeafCaptureArguments = null;
      let capturedCheckedLeafBodyFor = null;
      let recursiveArrayWorkerBody = null;
      let recursiveArrayWorkerSource = null;
      let nestedRuntimeCountedRegion = false;
      let transactionalAcyclicCheckedLeaf = false;
      let lexicalCheckedLeafWrapper = false;
      let restoringSpillCallCount = 0;
      let restoringSpillInlineCost = 0;
      let inlinedRestoringSpills = false;
      let captureFreeRestoringSpills = false;
      let outlinedCaptureFreeRestoringSpills = false;
      let restoringFrameSlotCount = 0;
      // The preferred direct entry can still be rejected by the final AST
      // scope audit after specialization. Prove restoring eligibility
      // independently above and emit it only when no direct body survived,
      // so a valid fallback is not lost because an earlier candidate existed.
      if (restoringDirectPositionalEligible &&
          (requiresBaselineFramedEntry || !directPositionalBody)) {
        // A restoring entry is an already-verified synchronous intermethod
        // region. Give it a larger scalar quantum than a scheduler-owned
        // Frame: nested calls retain their own guards and safe points, while
        // an unusually large local loop still restores the exact JVM state
        // when this finite budget expires.
        const restoringDirectSafePointBudget = Math.min(
          1_000_000,
          regionCallGraphCandidate
            ? this.jit.hotCallGraphRegions.directSafePointBudget
            : safePointInitialBudget * this.restoringDirectBudgetMultiplier,
        );
        const receiverSlots = methodIsStatic ? 0 : 1;
        const argumentCount = directMethodDescriptor.params.length + receiverSlots;
        const argumentNames = Array.from(
          { length: argumentCount }, (_unused, index) => `argument${index}`);
        const entryArguments = new Map();
        let slot = 0;
        if (!methodIsStatic) {
          entryArguments.set(0, "argument0");
          slot = 1;
        }
        for (let index = 0; index < directMethodDescriptor.params.length; index += 1) {
          entryArguments.set(slot++, `argument${index + receiverSlots}`);
        }
        const entryArgumentValue = (index) => {
          const argument = entryArguments.get(index);
          if (!argument || index < receiverSlots) return argument;
          return normalizeJvmScalarExpression(
            argument, directMethodDescriptor.params[index - receiverSlots]);
        };
        const owners = [...new Set([directMethodOwner, ...directStaticOwners])];
        const restoringInitializationGuardId =
          this.registerClassInitializationGuard(owners);
        const restoringGuardVariable =
          named("ssaRestoringClassInitializationGuard");
        const restoringInitializationGuardDeclaration = constDecl(
          restoringGuardVariable,
          e`helpers.structuredSsa.classInitializationGuards[${
            restoringInitializationGuardId}]`);
        const restoringInitializationCondition = operand(exprConcat(
          e`((${restoringGuardVariable}.classEpoch !== `,
          e`(helpers.jvm.classEpoch || 0) || `,
          e`${restoringGuardVariable}.initializationEpoch !== `,
          e`(helpers.jvm.classInitializationEpoch || 0)) && `,
          e`!helpers.structuredSsa.verifyClassInitializationGuard(`,
          e`${restoringGuardVariable}))`));
        const directGuardConditions = [
          exprConcat(
            e`(!nestedEntryGuarded && (helpers.profileMethods || `,
            e`helpers.needsBytecodeChecks() || thread.status !== 'runnable'))`),
          e`(nestedEntryGuarded !== 2 && ${restoringInitializationCondition})`,
        ];
        const directGuard = stmt(exprConcat(
          e`if (`,
          ...directGuardConditions.flatMap((condition, position) =>
            position === 0 ? [condition] : [" || ", condition]),
          e`) { ${leafBailStatement()} }`));
        // Generated callers have already passed the scheduler/debug portion
        // of the public entry contract. Emit the remaining lifecycle check
        // directly for that ABI instead of specializing JavaScript source
        // after it has been rendered.
        const trustedDirectGuard = stmt(exprConcat(
          e`if (${restoringInitializationCondition}) { `,
          e`${leafBailStatement()} }`));
        const directBooleanGuard = guardedStaticBooleanSites.size
          ? `if (${[...guardedStaticBooleanSites.values()].map((direct) => `((${
            direct.kind === "map"
              ? `${direct.variable}.get(${JSON.stringify(direct.key)})`
              : `${direct.variable}[${JSON.stringify(direct.key)}]`} ? 1 : 0) !== ${
            direct.guardedBooleanValue})`).join(" || ")}) { ` +
            "helpers.structuredSsa.guardedBooleanFallbackCount += 1; " +
            "return helpers.asyncInvokeSentinel(); }"
          : null;
        const initializeFrame = [
          st`frame = plan.target.freeFrame || new plan.Frame(plan.method);`,
          st`plan.target.freeFrame = null;`,
          st`if (plan.clearStructuredContinuation) plan.clearStructuredContinuation(frame);`,
          st`frame.pc = 0;`,
          st`frame.stack.items.length = 0;`,
          st`delete frame.jitSkipOnce;`,
          st`delete frame.jitJsDisabled;`,
          st`delete frame.jitAdaptiveEntryCounted;`,
          st`frame.className = plan.lookupClass;`,
          st`locals = frame.locals;`,
          st`stack = frame.stack.items;`,
          ...[...entryArguments].map(([index]) =>
            stmt(e`locals[${index}] = ${entryArgumentValue(index)};`,
              {kind: "spillLocal", slot: index})),
        ];
        const restoringSpillLines = [
          st`if (frame === null) {`,
          ...initializeFrame.map((line) => `  ${line}`),
          blockEnd(""),
          ...spillSlots.map((index) => stmt(e`locals[${index}] = ${
            immutableEntryLocals.has(index)
              ? entryLocalInitialValues.get(index) : localName(index)};`,
          {kind: "spillLocal", slot: index})),
          st`plan.restoreFrame(thread, frame, restorationDepth);`,
        ];
        const restoringRendered = expandContinuationFallbacks(
          render(structured.tree, false, true,
            restoringDirectSafePointBudget, false, true), false);
        restoringSpillCallCount = restoringRendered.reduce(
          (count, line) => {
            const kind = recordOf(line)?.kind;
            return count + (kind === "spill" || kind === "conditionalSpill" ||
              kind === "materialize" ? 1 : 0);
          }, 0);
        // Outlining a spill helper makes every scalar local escape into its
        // closure context, including successful loop iterations that never
        // reconstruct a Frame. Duplicate the cold restoration statements
        // when their structural expansion stays within a fixed code-size
        // budget. The decision depends only on verified loop count, live JVM
        // slots, and actual spill sites; it has no guest-method identity.
        restoringSpillInlineCost = restoringSpillCallCount *
          (spillSlots.length + initializeFrame.length + 3);
        inlinedRestoringSpills =
          this.acyclicInlineRestoringSpillsEnabled &&
            structured.loopHeaders.size === 0 && spillSlots.length <= 32 ||
          this.loopInlineRestoringSpillsEnabled &&
            structured.loopHeaders.size > 0 && spillSlots.length <= 48 &&
            restoringSpillInlineCost <= this.loopInlineRestoringSpillBudget;
        outlinedCaptureFreeRestoringSpills =
          this.loopInlineRestoringSpillsEnabled &&
          structured.loopHeaders.size > 0 && spillSlots.length <= 48 &&
          restoringSpillCallCount > 0 && !inlinedRestoringSpills;
        captureFreeRestoringSpills = structured.loopHeaders.size > 0 &&
          (inlinedRestoringSpills || outlinedCaptureFreeRestoringSpills);
        const restoringRenderedWithSpills = captureFreeRestoringSpills
          ? restoringRendered : inlineMaterializeCalls(restoringRendered);
        // Entry arguments are also ordinary JVM locals.  Do not mention a
        // slot twice in a cold restoring-frame array merely because it is
        // both an argument and subsequently assigned.  Besides avoiding
        // redundant restoration writes, the unique value list prevents the
        // host compiler from keeping duplicate materialization operands live
        // across successful hot loops.  Unused arguments remain represented
        // through entryArgumentValue(), preserving complete Frame state.
        const restoringFrameEntries = captureFreeRestoringSpills
          ? new Map([...entryArguments.keys()].map((index) => [
            index, entryArgumentValue(index),
          ])) : new Map();
        for (const index of spillSlots) {
          restoringFrameEntries.set(index, immutableEntryLocals.has(index)
            ? entryLocalInitialValues.get(index) : `local${index}`);
        }
        const restoringFrameSlots = [...restoringFrameEntries.keys()];
        const restoringFrameValues = [...restoringFrameEntries.values()];
        const restoringFrameValuesAt = (pc) => {
          const known = materializationLocalValuesByPc.get(pc);
          if (!known) return restoringFrameValues;
          return restoringFrameSlots.map((slot, index) =>
            known[slot] ?? restoringFrameValues[index]);
        };
        restoringFrameSlotCount = restoringFrameSlots.length;
        const restoringFrameLayoutId = captureFreeRestoringSpills
          ? this.restoringFrameLayouts.push(restoringFrameSlots) - 1 : -1;
        const restoreCaptureFreeFrame = (indentation) => [
          `${indentation}${stmt(exprConcat(
            e`[frame, locals, stack] = `,
            e`helpers.structuredSsa.restoreDirectFrame(`,
            e`${restoringFrameLayoutId}, plan, thread, restorationDepth, `,
            e`frame, [`, argumentListExpression(restoringFrameValues),
            e`]);`))}`,
        ];
        const inlineRestoringSpillCalls = (lines) =>
          !(inlinedRestoringSpills || outlinedCaptureFreeRestoringSpills)
            ? lines : lines.flatMap((line) => {
            const record = recordOf(line);
            const prefix = indentationOf(line);
            if (record?.kind === "conditionalSpill") {
              if (captureFreeRestoringSpills) {
                return [
                  `${prefix}${st`if (frame === null) {`}`,
                  ...restoreCaptureFreeFrame(`${prefix}  `),
                  `${prefix}${blockEnd("")}`,
                ];
              }
              return [
                `${prefix}${st`if (frame === null) {`}`,
                ...restoringSpillLines.map(
                  (spill) => `${prefix}  ${spill}`),
                `${prefix}${blockEnd("")}`,
              ];
            }
            if (record?.kind !== "spill") return [line];
            if (captureFreeRestoringSpills) {
              return restoreCaptureFreeFrame(prefix);
            }
            return restoringSpillLines.map((spill) => `${prefix}${spill}`);
          });
        let restoringRenderedTree = inlineRestoringSpillCalls(
          restoringRenderedWithSpills);
        if (captureFreeRestoringSpills) {
          restoringRenderedTree = restoringRenderedTree.flatMap((line) => {
            const record = recordOf(line);
            const prefix = indentationOf(line);
            if (record?.kind === "materializeRelease") {
              return [
                `${prefix}${stmt(exprConcat(e`frame = `,
                  e`helpers.structuredSsa.releaseUnwindFrame(`,
                  e`plan, thread, frame);`))}`,
                `${prefix}${st`locals = null;`}`,
                `${prefix}${st`stack = null;`}`,
              ];
            }
            if (record?.kind !== "materialize") return [line];
            if (record.unwind) {
              return [
                `${prefix}${stmt(exprConcat(
                  e`[frame, locals, stack] = `,
                  e`helpers.structuredSsa.materializeUnwindFrame(`,
                  e`plan, thread, restorationDepth, `,
                  e`frame, ${record.pc}, [`,
                  argumentListExpression(record.operands), e`]);`))}`,
              ];
            }
            const frameValues = Number.isInteger(record.pc)
              ? restoringFrameValuesAt(record.pc)
              : restoringFrameValues;
            return [
              `${prefix}${stmt(exprConcat(
                e`[frame, locals, stack] = `,
                e`helpers.structuredSsa.materializeDirectFrame(`,
                e`${restoringFrameLayoutId}, plan, thread, restorationDepth, `,
                e`frame, [`, argumentListExpression(frameValues),
                e`], ${record.pc}, `,
                e`[`, argumentListExpression(record.operands), e`]);`))}`,
            ];
          });
        }
        if (restoringDirectFieldLayoutSlots.size) {
          restoringRenderedTree = (() => {
            const lines = [...restoringRenderedTree];
            for (let index = 0; index < lines.length; index += 1) {
              const record = recordOf(lines[index]);
              if (record?.kind !== "nullCheck") continue;
              const slot = entryReferenceLoads.get(record.value) ??
                localLoads.get(record.value);
              if (!restoringDirectFieldLayoutSlots.has(slot)) continue;
              let depth = 1;
              let close = index + 1;
              for (; close < lines.length && depth > 0; close += 1) {
                const trimmed = lines[close].trim();
                if (trimmed.endsWith("{")) depth += 1;
                if (trimmed === "}" || trimmed.startsWith("} else")) depth -= 1;
              }
              if (depth !== 0) continue;
              lines.splice(index, close - index);
              index -= 1;
            }
            return lines;
          })();
        }
        // A sync-fallback call site restores the omitted frame (spliced at
        // restorationDepth, pc 0) so the canonical child protocol has a
        // caller Frame. When that call completes synchronously, every deopt/
        // sentinel arm falls through and the body keeps executing — but
        // nothing withdrew the restored frame, so a normal return stranded a
        // pc-0 Frame on the call stack. The scheduler would later run that
        // frame from scratch (re-executing the method) while the real caller
        // had already continued; the regression re-ran a completed callee
        // moved on and desynchronized the render pipeline. Withdraw the frame
        // as soon as a call block completes normally; any later throwing or
        // spilling site re-restores it through its own `frame === null`
        // guard, and the propagating deopt/exception arms return before this
        // line so a legitimately suspended frame stays put.
        // The left-active-child guard counts every Frame above the depth the
        // call site sampled. In a restoring body the Frame this fallback
        // spliced in itself sits there, so the guard has to be preceded by the
        // same withdrawal the region end performs -- otherwise a normally
        // completed call reads its own caller Frame as a stranded callee and
        // deopts. Withdrawing twice is a no-op: the second is behind the same
        // `frame !== null`.
        const withdrawRestoredFrame = (indent) => [
          `${indent}${st`if (frame !== null) {`}`,
          `${indent}  ${stmt(exprConcat(e`frame = helpers.structuredSsa`,
            e`.releaseUnwindFrame(plan, thread, frame);`))}`,
          `${indent}  ${st`locals = null;`}`,
          `${indent}  ${st`stack = null;`}`,
          `${indent}${blockEnd("")}`,
        ];
        restoringRenderedTree = restoringRenderedTree.flatMap((line) => {
          const kind = recordOf(line)?.kind;
          if (kind === "regionCallEnd") {
            return [line, ...withdrawRestoredFrame(indentationOf(line))];
          }
          if (kind === "leftActiveChildWithdraw") {
            return withdrawRestoredFrame(indentationOf(line));
          }
          return [line];
        });
        restoringRenderedTree = compactCheckedLeafLines(
          restoringRenderedTree, false);
        let directBody = [
          ...directStaticDeclarations,
          ...lazyStaticDeclarations,
          ...directEntryStaticReadDeclarations,
          ...omitAdmissionOwnedCaptureRefreshes(
            restoringDirectPositionalCallDeclarations),
          ...directEntryCheckedAdmissionDeclarations,
          directBooleanGuard,
          this.runCountersEnabled
            ? selfRecursiveCallExpressions.size
              ? stmt(exprConcat(e`if (nestedEntryGuarded !== 2) `,
                e`helpers.structuredSsa.restoringDirectRunCount += 1;`))
              : st`helpers.structuredSsa.restoringDirectRunCount += 1;` : null,
          stmt(e`let safePointBudget = ${restoringDirectSafePointBudget};`,
          {kind: "safePointBudgetDeclaration"}),
          ...declaredLocals.map((index) =>
              entryLocalDeclaration(index, entryArgumentValue)),
          ...directInvariantPositionalCallDeclarations,
          ...entryArrayDataDeclarations,
          ...persistentStaticArrayDataDeclarations,
          ...(inlinedRestoringSpills || outlinedCaptureFreeRestoringSpills
            ? [] : [
            "function spillLocals() {",
            ...restoringSpillLines.map((line) => `  ${line}`),
            "}",
          ]),
          ...fieldReadCacheDeclarations,
          ...restoringDirectFieldCacheInitializations,
          directArrayDataGuard,
          ...declarations,
          ...restoringRenderedTree,
        ].filter(Boolean);
        if (process.env.JVM_JIT_VERIFY_STATEMENT_IR) {
          auditStatementIrLines(directBody, statementRecords, emittedNames,
            "restoring-body");
        }
        // Entry scaffolding is assembled before checked-call admission and
        // loop specialization.  Those later passes can make capture aliases,
        // call-target aliases, scheduler budgets, or JVM locals completely
        // unused. Remove only top-level declarations with compiler-owned,
        // side-effect-free initializers; nested guest expressions and all
        // potentially observable property reads remain untouched.
        // A declaration may go when nothing reads the name and its
        // initializer is compiler-owned and side-effect free: a literal, a
        // copy of another name, a loop trip/predicate temporary, or one of the
        // capture-cache reads the emitter marked removable. Whether a name is
        // read is a question about the statements, and every one of them is
        // recorded, so the sweep is a use count over their operands.
        const removableDeclaration = (record) => {
          if (record?.kind !== "const" && record?.kind !== "let") return false;
          if (pureRangeTemporaryNames.has(record.def)) return true;
          if (record.removableWhenUnused === true) return true;
          if (record.exprParts?.length !== 1) return false;
          const initializer = record.exprParts[0];
          if (typeof initializer !== "string") return true;
          return initializer === "undefined" || initializer === "null" ||
            initializer === "true" || initializer === "false" ||
            /^-?\d+$/.test(initializer);
        };
        for (;;) {
          if (directBody.some((line) => !recordOf(line))) break;
          const counts = new Map();
          for (const line of directBody) {
            for (const name of partsReferences(recordOf(line).parts)) {
              counts.set(name, (counts.get(name) || 0) + 1);
            }
          }
          const budgetMentions = directBody.reduce((total, line) =>
            total + (recordOf(line).usesSafePointBudget ? 1 : 0), 0);
          let removed = false;
          directBody = directBody.filter((line) => {
            const record = recordOf(line);
            if (record.kind === "safePointBudgetDeclaration") {
              if (budgetMentions !== 1) return true;
              removed = true;
              return false;
            }
            if (!record.def || counts.get(record.def) !== 1 ||
                !removableDeclaration(record)) return true;
            removed = true;
            return false;
          });
          if (!removed) break;
        }
        const restoringPrologue = [
          restoringInitializationGuardDeclaration,
          directGuard,
          // These four are ambient, not operands: every tier declares them in
          // its outermost scope and no pass renames or removes one.
          st`const restorationDepth = thread.callStack.items.length;`,
          st`let frame = null;`,
          st`let locals = null;`,
          st`let stack = null;`,
        ].filter(Boolean);
        // The restoring tier wraps its whole body in one compiler-owned
        // try/catch. That wrapper is scaffolding, not a guest exception
        // region, so it does not make the body a single fragment: the opening
        // and the handler are their own fragments and the body between them
        // keeps its statement-level structure.
        const restoringWrapperOpen = st`try {`;
        const restoringIndentedBody = directBody.map((line) => `  ${line}`);
        const restoringWrapperClose = [
          st`} catch (error) {`,
          st`  if (frame !== null) {`,
          st`    helpers.structuredSsa.restoredDirectExceptionFrameCount += 1;`,
          st`    plan.restoreFrame(thread, frame, restorationDepth);`,
          blockEnd("  "),
          st`  throw error;`,
          blockEnd(""),
        ];
        const restoringPositionalLines = [
          ...restoringPrologue,
          restoringWrapperOpen,
          ...restoringIndentedBody,
          ...restoringWrapperClose,
        ];
        restoringDirectPositionalSource = specializeSelfRecursiveCalls(
          ["'use strict';", ...restoringPositionalLines].join("\n"),
          "ssa-direct-restoring-positional", true);
        if (process.env.JVM_DEBUG_INSERTION_VETO &&
            selfRecursiveCallExpressions.size) {
          require("fs").appendFileSync(process.env.JVM_DEBUG_INSERTION_VETO,
            "VETO self-recursive\n");
        }
        if (!selfRecursiveCallExpressions.size) {
          // The restoring tier is the body an exceptional inline candidate
          // contributes, so it publishes an insertable variant too. It carries
          // no `'use strict';` directive: a directive is only a directive at
          // the head of a program or a function body, and this body is
          // inserted into one.
          const restoringInsertable =
            insertableBodyOf(restoringPositionalLines);
          if (process.env.JVM_JIT_VERIFY_STATEMENT_IR && restoringInsertable) {
            auditStatementIrLines(restoringInsertable.lines, statementRecords,
              emittedNames, "restoring-insertion");
          }
          restoringDirectPositionalInsertion =
            publishInsertion(restoringInsertable, argumentNames);
        }
        if (!selfRecursiveCallExpressions.size) {
          const prologueFragments = regionFragmentsOf(restoringPrologue);
          const bodyFragments = regionFragmentsOf(restoringIndentedBody);
          regionFragments.jvmRestoringDirectPositionalSource =
            prologueFragments && bodyFragments
              ? [
                ...prologueFragments,
                {kind: "linear", lines: [restoringWrapperOpen],
                  declares: [], reads: [], writes: [],
                  statements: [regionStatementOf(restoringWrapperOpen)]},
                ...bodyFragments,
                {kind: "linear", lines: [...restoringWrapperClose],
                  declares: [],
                  reads: ["frame", "helpers", "plan", "thread",
                    "restorationDepth"],
                  writes: [],
                  statements: restoringWrapperClose.map(
                    (line) => regionStatementOf(line))},
              ].map((fragment, id) => ({...fragment, id}))
              : null;
        }
        // The published body late-binds two sentinel calls to captured
        // constants. Expand them in the fragments too, so the fragments still
        // join to exactly the published source.
        // The expansion is an exact-identity replacement of a token the
        // compiler emitted, so it is applied to the statement records the
        // fragments publish as well: to each statement's rendered text and to
        // the literal chunks of its parts list. A statement whose re-rendered
        // parts then disagree with its text keeps its text and loses its
        // parts, and a consumer leaves it alone.
        const expandSentinelsInFragments = (from, to) => {
          const fragments =
            regionFragments.jvmRestoringDirectPositionalSource;
          if (!fragments) return;
          for (const fragment of fragments) {
            fragment.lines = fragment.lines.map(
              (line) => line.split(from).join(to));
            fragment.statements = (fragment.statements || []).map(
              (statement) => {
                if (!statement) return statement;
                const text = statement.text.split(from).join(to);
                if (text === statement.text) return statement;
                return {
                  ...statement,
                  text,
                  parts: statement.parts.map((part) =>
                    typeof part === "string" ? part.split(from).join(to)
                      : part),
                };
              });
          }
        };
        // The insertable variant is the same body, so it late-binds the same
        // two sentinels. The module a region composes always captures both,
        // so the insertion expands them unconditionally.
        if (restoringDirectPositionalInsertion) {
          restoringDirectPositionalInsertion.source =
            restoringDirectPositionalInsertion.source
              .split("helpers.returnVoid()").join("ssaReturnVoid")
              .split("helpers.asyncInvokeSentinel()").join("ssaAsyncInvoke");
        }
        const restoringSentinelCaptures = {};
        if (restoringDirectPositionalSource.includes(
          "helpers.returnVoid()")) {
          restoringDirectPositionalSource = restoringDirectPositionalSource
            .split("helpers.returnVoid()").join("ssaReturnVoid");
          expandSentinelsInFragments("helpers.returnVoid()", "ssaReturnVoid");
          restoringSentinelCaptures.ssaReturnVoid =
            this.jit.returnVoid();
        }
        if (restoringDirectPositionalSource.includes(
          "helpers.asyncInvokeSentinel()")) {
          restoringDirectPositionalSource = restoringDirectPositionalSource
            .split("helpers.asyncInvokeSentinel()").join("ssaAsyncInvoke");
          expandSentinelsInFragments(
            "helpers.asyncInvokeSentinel()", "ssaAsyncInvoke");
          restoringSentinelCaptures.ssaAsyncInvoke =
            this.jit.asyncInvokeSentinel();
        }
        restoringDirectPositionalBody = createStructuredFunction(
          "ssa-direct-restoring-positional",
          ["helpers", "plan", ...argumentNames, "thread",
            "nestedEntryGuarded"],
          restoringDirectPositionalSource,
          null, false, false, {
            ...methodSpecializedCheckedCaptures,
            ...restoringSentinelCaptures,
          },
        );

        const singleLoopHeader = structured.loopHeaders.size === 1
          ? [...structured.loopHeaders][0] : null;
        const singleLoop = Number.isInteger(singleLoopHeader)
          ? countedLoopInfos.get(singleLoopHeader) : null;
        const countedRegionLoops = [...structured.loopHeaders]
          .map((header) => countedLoopInfos.get(header))
          .filter(Boolean)
          .sort((left, right) =>
            (countedLoopDepths.get(left.header) || 0) -
            (countedLoopDepths.get(right.header) || 0));
        nestedRuntimeCountedRegion =
          countedRegionLoops.length === structured.loopHeaders.size &&
          countedRegionLoops.length > 1 &&
          countedRegionLoops.length <= 3 &&
          countedRegionLoops.every((info, index) =>
            info.initial === 0 && info.increment === 1 &&
            (info.boundSlot === null || countedRegionLoops.every((other) =>
              !other.writtenSlots.has(info.boundSlot))) &&
            (index === 0 ||
              countedRegionLoops[index - 1].loopBlocks.has(info.header))) &&
          arrayRangeCheckCandidates.every((_candidate, index) =>
            trustedHoistedRangeGuards.has(`ssaArrayRangeGuard${index}`));
        const checkedLeafTripDeclarations = [];
        if (nestedRuntimeCountedRegion) {
          for (const info of countedRegionLoops) {
            checkedLeafCoarseLoopHeaders.add(info.header);
            checkedLeafTripDeclarations.push(
              `const ssaCheckedLeafTrips${info.header} = ` +
                `Math.max(0, ${info.boundExpression});`);
          }
          const tripVariables = countedRegionLoops.map((info) =>
            `ssaCheckedLeafTrips${info.header}`);
          checkedLeafTripDeclarations.push(
            `if (!(${tripVariables.map((variable) =>
              `${variable} <= ${runtimeCoarseTripLimit}`).join(" && ")} && ` +
              `${tripVariables.join(" * ")} <= 1000000)) ` +
              "return helpers.asyncInvokeSentinel();",
          );
        }
        if (shrinkingArrayWindowLeaf) {
          const shape = shrinkingArrayWindowLeaf;
          const prefix = `ssaShrinkingArrayWindow${shape.outerHeader}`;
          const threshold = `${prefix}Threshold`;
          const outerTrips = `${prefix}OuterTrips`;
          const innerTrips = `${prefix}InnerTrips`;
          checkedLeafCoarseLoopHeaders.add(shape.outerHeader);
          checkedLeafCoarseLoopHeaders.add(shape.innerHeader);
          arrayRangeGuardDataVariables.set(
            shape.variable, shape.arrayData);
          if (shape.window === shape.stride * 2) {
            const delta = `${prefix}Delta`;
            const maximumTrips = Math.min(
              runtimeCoarseTripLimit, Math.floor(Math.sqrt(1_000_000)));
            checkedLeafTripDeclarations.push(
              `const ${threshold} = local${shape.lowerSlot} + ` +
                `${shape.window};`,
              `let ${shape.variable} = ` +
                `local${shape.lowerSlot} <= ${2147483647 - shape.window};`,
              `if (${shape.variable} && ` +
                `local${shape.upperSlot} >= ${threshold}) {`,
              `  const ${delta} = local${shape.upperSlot} - ` +
                `local${shape.lowerSlot};`,
              `  ${shape.variable} = ` +
                `(` +
                `local${shape.lowerSlot} >= 0 && ` +
                `local${shape.upperSlot} <= ${shape.arrayData}.length && ` +
                `${delta} % ${shape.stride} === 0 && ` +
                `${delta} / ${shape.stride} - 1 <= ${maximumTrips});`,
              `}`,
              `if (!${shape.variable}) ` +
                "return helpers.asyncInvokeSentinel();",
            );
          } else checkedLeafTripDeclarations.push(
            `const ${threshold} = local${shape.lowerSlot} + ` +
              `${shape.window};`,
            `const ${outerTrips} = local${shape.upperSlot} < ${threshold} ` +
              `? 0 : Math.floor((local${shape.upperSlot} - ${threshold}) / ` +
              `${shape.stride}) + 1;`,
            `const ${innerTrips} = ${outerTrips} === 0 ? 0 : ` +
              `(local${shape.upperSlot} - local${shape.lowerSlot}) / ` +
              `${shape.stride} - 1;`,
            `const ${shape.variable} = ` +
              `(local${shape.lowerSlot} <= ${2147483647 - shape.window} && ` +
              `(${outerTrips} === 0 || (` +
              `local${shape.lowerSlot} >= 0 && ` +
              `local${shape.upperSlot} <= ${shape.arrayData}.length && ` +
              `(local${shape.upperSlot} - local${shape.lowerSlot}) % ` +
              `${shape.stride} === 0 && ${outerTrips} <= ` +
              `${runtimeCoarseTripLimit} && ${innerTrips} >= 0 && ` +
              `${innerTrips} <= ${runtimeCoarseTripLimit} && ` +
              `${outerTrips} * ${innerTrips} <= 1000000)));`,
            `if (!${shape.variable}) ` +
              "return helpers.asyncInvokeSentinel();",
          );
        }
        if (recursiveArrayPartitionLeaf) {
          const shape = recursiveArrayPartitionLeaf;
          const delta = `ssaRecursiveArrayWindow${shape.header}Delta`;
          checkedLeafCoarseLoopHeaders.add(shape.header);
          arrayRangeGuardDataVariables.set(shape.variable, shape.arrayData);
          checkedLeafTripDeclarations.push(
            `const ${delta} = local${shape.upperSlot} - ` +
              `local${shape.lowerSlot};`,
            `const ${shape.variable} = (` +
              `local${shape.lowerSlot} >= 0 && ` +
              `local${shape.upperSlot} >= local${shape.lowerSlot} && ` +
              `local${shape.upperSlot} <= ${shape.arrayData}.length && ` +
              `${delta} % ${shape.stride} === 0 && ` +
              `${delta} / ${shape.stride} <= ${runtimeCoarseTripLimit});`,
            `if (!${shape.variable}) ` +
              "return helpers.asyncInvokeSentinel();",
          );
        }
        const deepestCountedLoop = countedRegionLoops.at(-1) || null;
        const loopItems = deepestCountedLoop
          ? new Set([...deepestCountedLoop.loopBlocks].flatMap(
            (block) => cfg.blocks[block]?.insns || []))
          : new Set();
        const effectOps = new Set([
          "putfield", "putstatic",
          "iastore", "sastore", "bastore", "castore",
          "dastore", "fastore", "lastore", "aastore",
        ]);
        const throwingOrDynamicOps = new Set([
          "idiv", "irem", "getfield", "arraylength", "athrow",
          "new", "newarray", "anewarray", "multianewarray",
          "monitorenter", "monitorexit", "checkcast", "instanceof",
        ]);
        const primitiveArrayStoreOps = new Set([
          "iastore", "sastore", "bastore", "castore",
          "dastore", "fastore", "lastore",
        ]);
        const transactionalThrowingOps = new Set([
          "idiv", "irem", "getfield", "arraylength",
          "iaload", "saload", "baload", "caload",
          "daload", "faload", "laload",
          ...primitiveArrayStoreOps,
        ]);
        const provenNonThrowingArithmeticItem = (op, index) =>
          (op === "idiv" || op === "irem") &&
          (dominatedNonZeroDivisionItems.has(index) ||
            literalNonZeroDivisionItems.has(index));
        const reachableEffectItems = items
          .map((item, index) => ({
            index,
            op: opOf(item?.instruction),
          }))
          .filter(({ index, op }) =>
            normalReachableItems.has(index) && effectOps.has(op));
        const forwardOnlyCfg = cfg.blocks.every((block) =>
          !block || block.synthetic || (cfg.succ[block.id] || []).every(
            (successor) => cfg.blocks[successor]?.synthetic ||
              cfg.blocks[successor]?.insns?.[0] >= block.insns[0]));
        const onlyEffect = reachableEffectItems.length === 1
          ? reachableEffectItems[0] : null;
        const transactionalAcyclicShape =
          structured.loopHeaders.size === 0 &&
          forwardOnlyCfg &&
          (code.code.exceptionTable || []).length === 0 &&
          callSites.size === 0 &&
          onlyEffect && primitiveArrayStoreOps.has(onlyEffect.op) &&
          items.every((item, index) => {
            const op = opOf(item?.instruction);
            if (!op || !normalReachableItems.has(index)) return true;
            if (throwingOrDynamicOps.has(op) &&
                !transactionalThrowingOps.has(op)) return false;
            return !effectOps.has(op) || index === onlyEffect.index;
          });
        // A forward-only leaf that only reads primitive arrays is
        // transactional as well: a failed null/bounds/divisor predicate can
        // return to its canonical caller before the first guest side effect.
        // Publishing the checked ABI avoids carrying lazy Frame restoration
        // and function-wide try/catch scaffolding into a region-local lookup
        // that may execute once per sample or pixel.
        const transactionalAcyclicReadShape =
          structured.loopHeaders.size === 0 &&
          forwardOnlyCfg &&
          (code.code.exceptionTable || []).length === 0 &&
          callSites.size === 0 &&
          reachableEffectItems.length === 0 &&
          items.every((item, index) => {
            const op = opOf(item?.instruction);
            if (!op || !normalReachableItems.has(index)) return true;
            return !throwingOrDynamicOps.has(op) ||
              transactionalThrowingOps.has(op) ||
              provenNonThrowingArithmeticItem(op, index);
          });
        const lexicalCheckedLeafWrapperShape =
          structured.loopHeaders.size === 0 &&
          forwardOnlyCfg &&
          (code.code.exceptionTable || []).length === 0 &&
          reachableEffectItems.length === 0 &&
          callSites.size === 1 &&
          [...callSites.values()].every((site) =>
            site.returnsVoid &&
            site.directCheckedLeaf?.noThrow === true &&
            Boolean(site.directCheckedLeaf.inlineBody)) &&
          items.every((item, index) => {
            const op = opOf(item?.instruction);
            if (!op || !normalReachableItems.has(index)) return true;
            return (!throwingOrDynamicOps.has(op) ||
                provenNonThrowingArithmeticItem(op, index)) &&
              !effectOps.has(op);
          });
        lexicalCheckedLeafWrapper = lexicalCheckedLeafWrapperShape;
        const allCheckedLeafCallsAdmitted = callSites.size > 0 &&
          checkedCallAdmissionCandidates.length === callSites.size &&
          provenCheckedCallAdmissionCount === callSites.size &&
          [...callSites.values()].every((site) =>
            site.returnsVoid && site.directCheckedLeaf?.noThrow === true &&
            Boolean(site.directCheckedLeaf.inlineBody));
        const checkedLeafShape =
          (this.checkedLeafDirectPositionalEnabled ||
            this.jit.hotCallGraphRegions?.enabled) &&
          (((singleLoop && (atomicBoundedLoops ||
              runtimeCoarseCountedLoops.has(singleLoopHeader)) ||
            nestedRuntimeCountedRegion || shrinkingArrayWindowLeaf ||
            recursiveArrayPartitionLeaf) ||
            transactionalAcyclicShape || transactionalAcyclicReadShape) &&
            (callSites.size === 0 || allCheckedLeafCallsAdmitted ||
              recursiveArrayPartitionLeaf &&
                [...callSites.values()].every((site) => site.selfRecursive)) ||
            lexicalCheckedLeafWrapperShape) &&
          items.every((item, index) => {
            const op = opOf(item?.instruction);
            if (!op || !normalReachableItems.has(index)) return true;
            if (!transactionalAcyclicShape &&
                !transactionalAcyclicReadShape &&
                throwingOrDynamicOps.has(op) &&
                !provenNonThrowingArithmeticItem(op, index)) return false;
            return !effectOps.has(op) || transactionalAcyclicShape ||
              transactionalAcyclicReadShape ||
              recursiveArrayPartitionLeaf ||
              loopItems.has(index);
          });
        if (recursiveArrayPartitionLeaf && typeof process !== "undefined" &&
            process.env?.JVM_TRACE_STRUCTURED_RECURSIVE_ARRAY === "1") {
          console.error("[structured-recursive-array] checked shape", {
            checkedLeafShape,
            effects: reachableEffectItems,
          });
        }
        if (checkedLeafShape) {
          let checkedLeafRenderedTree = render(
            structured.tree, false, true,
            restoringDirectSafePointBudget, true, true);
          if (!recursiveArrayPartitionLeaf) {
            // The labeled body is part of the rendered tree from the start,
            // so every later pass sees a complete statement list and the
            // same lines serve the standalone entry and a lexical insertion.
            checkedLeafRenderedTree = [
              recordStatement([`${checkedLeafBodyLabel}: {`],
                {kind: "blockLabel", label: checkedLeafBodyLabel}),
              ...checkedLeafRenderedTree,
              blockEnd(""),
            ];
          }
          if (shrinkingArrayWindowLeaf) {
            const guard = shrinkingArrayWindowLeaf.variable;
            checkedLeafRenderedTree = substituteInLines(
              checkedLeafRenderedTree,
              new Map(shrinkingArrayWindowLeaf.accesses.map((access) =>
                [access.marker, [{ref: guard}]])));
            checkedLeafRenderedTree = specializeArrayRangeGuardedStores(
              checkedLeafRenderedTree, [guard]);
          }
          if (recursiveArrayPartitionLeaf) {
            const guard = recursiveArrayPartitionLeaf.variable;
            checkedLeafRenderedTree = substituteInLines(
              checkedLeafRenderedTree,
              new Map(recursiveArrayPartitionLeaf.accesses.map((access) =>
                [access.marker, [{ref: guard}]])));
            checkedLeafRenderedTree = specializeArrayRangeGuardedStores(
              checkedLeafRenderedTree, [guard]);
          }
          const checkedLeafSafeArithmeticGuards = [];
          // Java int multiplication/addition needs explicit wrapping for
          // arbitrary inputs. A checked leaf may use ordinary JS arithmetic
          // when one entry predicate bounds every contributing int argument
          // and interval propagation proves that the selected operations
          // cannot overflow anywhere in the finite region. The restoring
          // implementation remains the exact slow arm for guard failures.
          if ((code.code.exceptionTable || []).length === 0 &&
              hasOutlinedClippedLeaf) {
            // Wide enough to admit ordinary render/audio coordinates and
            // packed colors, while interval propagation still rejects an
            // operation whose constants could overflow at either endpoint.
            const assumedLimit = 100_000_000;
            const argumentIntSlots = new Map();
            let parameterSlot = receiverSlots;
            for (let parameter = 0;
              parameter < directMethodDescriptor.params.length;
              parameter += 1, parameterSlot += 1) {
              if (directMethodDescriptor.params[parameter] === "int" &&
                  !renderedAssignedLocalSlots.has(parameterSlot)) {
                argumentIntSlots.set(parameterSlot,
                  `argument${parameter + receiverSlots}`);
              }
            }
            const inductionRanges = new Map();
            for (const info of countedLoopInfos.values()) {
              if (!Number.isInteger(info.initial) ||
                  !Number.isInteger(info.bound) ||
                  !Number.isInteger(info.increment) ||
                  info.increment <= 0 || info.initial >= info.bound) continue;
              const trips = Math.ceil(
                (info.bound - info.initial) / info.increment);
              const maximum = info.initial + (trips - 1) * info.increment;
              if (maximum <= 2147483647) {
                inductionRanges.set(info.slot, {
                  minimum: info.initial,
                  maximum,
                  assumptions: new Set(),
                });
              }
            }
            const rangeMemo = new Map();
            const safeRange = (expression, visiting = new Set()) => {
              if (/^-?\d+$/.test(expression)) {
                const value = Number(expression);
                return Number.isSafeInteger(value) ? {
                  minimum: value, maximum: value, assumptions: new Set(),
                } : null;
              }
              if (rangeMemo.has(expression)) return rangeMemo.get(expression);
              if (visiting.has(expression)) return null;
              const origin = methodIntegerOrigins.get(expression);
              if (!origin) return null;
              const nextVisiting = new Set(visiting).add(expression);
              if (origin.kind === "local") {
                const induction = inductionRanges.get(origin.slot);
                if (induction) return induction;
                const argument = argumentIntSlots.get(origin.slot);
                if (argument) {
                  const result = {
                    minimum: -assumedLimit,
                    maximum: assumedLimit,
                    assumptions: new Set([origin.slot]),
                  };
                  rangeMemo.set(expression, result);
                  return result;
                }
                const fixed = boundedLocalDefinitionRange(origin.slot);
                return fixed ? {...fixed, assumptions: new Set()} : null;
              }
              const left = safeRange(origin.left, nextVisiting);
              const right = safeRange(origin.right, nextVisiting);
              if (!left || !right) return null;
              let minimum;
              let maximum;
              if (origin.kind === "iadd") {
                minimum = left.minimum + right.minimum;
                maximum = left.maximum + right.maximum;
              } else if (origin.kind === "isub") {
                minimum = left.minimum - right.maximum;
                maximum = left.maximum - right.minimum;
              } else if (origin.kind === "imul") {
                const products = [
                  left.minimum * right.minimum,
                  left.minimum * right.maximum,
                  left.maximum * right.minimum,
                  left.maximum * right.maximum,
                ];
                minimum = Math.min(...products);
                maximum = Math.max(...products);
              } else if (origin.kind === "irem" &&
                  right.minimum === right.maximum &&
                  right.minimum !== 0 &&
                  !(right.minimum === -1 &&
                    left.minimum === -2147483648)) {
                const limit = Math.abs(right.minimum) - 1;
                minimum = Math.max(left.minimum, -limit);
                maximum = Math.min(left.maximum, limit);
              } else return null;
              if (!Number.isSafeInteger(minimum) ||
                  !Number.isSafeInteger(maximum) ||
                  minimum < -2147483648 || maximum > 2147483647) return null;
              const result = {
                minimum,
                maximum,
                assumptions: new Set([
                  ...left.assumptions, ...right.assumptions,
                ]),
              };
              rangeMemo.set(expression, result);
              return result;
            };
            const usedAssumptions = new Set();
            // The interval proof runs on the compiler's own integer origins,
            // and the emitter recorded the exact line it rendered for each of
            // them together with the unmasked form of the same operation.
            // Proven lines are selected by that identity and replaced with
            // the emitter's alternative: no rendered statement is inspected,
            // and a statement another pass has already rewritten simply no
            // longer carries an emitted identity.
            checkedLeafRenderedTree = checkedLeafRenderedTree.map((line) => {
              const emitted = methodIntegerOriginLines.get(line.trim());
              if (!emitted) return line;
              const range = safeRange(emitted.name);
              if (!range) return line;
              for (const slot of range.assumptions) usedAssumptions.add(slot);
              const indentation =
                line.slice(0, line.length - line.trimStart().length);
              return `${indentation}${emitted.plain}`;
            });
            if (usedAssumptions.size) {
              const failures = [...usedAssumptions]
                .sort((left, right) => left - right)
                .map((slot) => {
                  const argument = argumentIntSlots.get(slot);
                  // Direct positional int arguments are already int32. Shift
                  // the symmetric interval into an unsigned range so one
                  // comparison proves both endpoints.
                  return exprConcat(
                    e`(((${argument} + ${assumedLimit}) >>> 0) > `,
                    e`${assumedLimit * 2})`);
                });
              checkedLeafSafeArithmeticGuards.push(stmt(exprConcat(
                e`if (`,
                ...failures.flatMap((failure, position) => [
                  position === 0 ? "" : " || ", failure,
                ]),
                e`) ${leafBailStatement()}`)));
              preflightedCheckedLeafArgumentSlots =
                [...usedAssumptions].sort((left, right) => left - right)
                  .map((slot) => argumentNames.indexOf(
                    argumentIntSlots.get(slot)))
                  .filter((index) => index >= 0);
              preflightedCheckedLeafArgumentLimit = assumedLimit;
            }
          }
          let checkedLeafTree = compactCheckedLeafLines(
            transactionalAcyclicShape || transactionalAcyclicReadShape
              ? transactionalizeAcyclicLeafLines(checkedLeafRenderedTree)
              : checkedLeafRenderedTree);
          checkedLeafTree = strengthReduceAffineStoreLoops(checkedLeafTree);
          // The entry locals of every checked-leaf tier. A slot the load/store
          // compaction proved dead is never declared, and a slot this region
          // never assigns is bound to its argument by declaration. Both were
          // previously done by rewriting the rendered text, which cannot tell
          // this method's `localN` from the compact `localN` namespace that a
          // lexically inserted child body brings into its own block scope.
          const checkedLeafEntryLocalDeclarations = () => declaredLocals
            .filter((index) => !eliminatedCheckedLeafLocalSlots.has(index))
            .map((index) => {
              const immutable = immutableEntryLocals.has(index) ||
                entryArguments.has(index) &&
                !callerAssignedLocalSlots.has(index) &&
                !renderedAssignedLocalSlots.has(index);
              const initializer = e`${entryLocalInitialValues.has(index)
                ? entryLocalInitialValues.get(index)
                : entryArgumentValue(index) || "undefined"}`;
              return immutable
                ? constDecl(localName(index), initializer)
                : letDecl(localName(index), initializer);
            });
          if (recursiveArrayPartitionLeaf) {
            let workerBody = [
              ...checkedLeafEntryLocalDeclarations(),
              constDecl(entryArrayDataVariable(
                recursiveArrayPartitionLeaf.arraySlot), e`argument0`),
              ...persistentStaticArrayDataDeclarations,
              ...declarations,
              ...checkedLeafTree,
            ].filter(Boolean);
            recursiveArrayWorkerSource =
              specializeCheckedLeafSelfRecursiveCalls(
                ["'use strict';", ...workerBody].join("\n"),
                "ssa-recursive-array-worker", true,
              );
            if (recursiveArrayWorkerSource) {
              // The worker must be a plain JavaScript function: no helper
              // call, no frame reconstruction, no throwing construct. That is
              // a question about the statements it ended up containing, and
              // the self-recursive specialization above records the direct
              // call it substituted, so every line has a record.
              const workerStatements = recursiveArrayWorkerSource.split("\n")
                .slice(1);
              const workerIsPlain = workerStatements.every((line) => {
                if (line.trim() === "") return true;
                const record = recordOf(line);
                if (!record) return false;
                return !record.callsRuntimeHelper && record.kind !== "spill" &&
                  record.kind !== "conditionalSpill" &&
                  record.throwsOrTries !== true;
              });
              recursiveArrayWorkerSource = recursiveArrayWorkerSource
                .split("helpers.returnVoid()").join("ssaReturnVoid");
              if (workerIsPlain) {
                recursiveArrayWorkerBody = createStructuredFunction(
                  "ssa-recursive-array-worker",
                  argumentNames,
                  recursiveArrayWorkerSource,
                  null, false, false,
                  {ssaReturnVoid: this.jit.returnVoid()},
                );
              }
            }
          }
          // Fragments whose form depends on whether the body stands alone or
          // is inserted lexically into a caller. An insertion receives its
          // caller's array views as feeds, drops the guards the caller has
          // proven and the safe-point accounting the caller owns, and leaves
          // its result in the labeled body's slot instead of returning.
          const entryArrayArgumentIndex = (slot) =>
            argumentNames.indexOf(entryArguments.get(slot));
          const checkedLeafEntryArrayDeclarationsFor = (inline) => inline
            ? entryArrayDataSlots.map((slot) => {
              const feed = inline.feeds.get(entryArrayArgumentIndex(slot));
              return feed
                ? `const ${entryArrayDataVariable(slot)} = ${feed.expression};`
                : entryArrayDataDeclarationFor(slot);
            })
            : entryArrayDataDeclarations;
          const checkedLeafArrayDataGuardFor = (inline) => {
            if (!inline) return directArrayDataGuard;
            const fed = new Set(entryArrayDataSlots
              .filter((slot) =>
                inline.feeds.get(entryArrayArgumentIndex(slot))?.nonNull)
              .map(entryArrayDataVariable));
            const guarded = guardedArrayDataVariables
              .filter((data) => !fed.has(data));
            return guarded.length
              ? `if (${guarded.map((data) => `${data} === null`)
                .join(" || ")}) { ${CHECKED_LEAF_BAIL} }`
              : null;
          };
          const checkedLeafFramedTreeFor = (inline) => {
            const treeLines = inline
              ? checkedLeafTree.filter((line) => {
                const omittable = checkedLeafOmittableLines.get(line.trim());
                if (!omittable) return true;
                if (omittable.kind === "safePoint") return false;
                return !omittable.guards.every((guard) =>
                  inline.provenGuards.has(guard));
              })
              : checkedLeafTree;
            if (recursiveArrayPartitionLeaf || inline) return treeLines;
            return [
              ...treeLines,
              directMethodDescriptor.returnType === "void"
                ? "return helpers.returnVoid();"
                : `return ${checkedLeafResultVariable};`,
            ];
          };
          const checkedLeafBodyFor = ({
            includeCallerOwnedChecks,
            includeRunCounter,
            tier,
            inline = null,
          }) => {
            let body = recursiveArrayWorkerBody
              ? [
                includeRunCounter && this.runCountersEnabled
                  ? stmt(exprConcat(e`if (nestedEntryGuarded !== 2) `,
                    e`helpers.structuredSsa.restoringDirectRunCount += 1;`))
                  : null,
                constDecl(entryArrayDataVariable(
                  recursiveArrayPartitionLeaf.arraySlot),
                arrayDataExpr("argument0")),
                directArrayDataGuard,
                ...[
                  recursiveArrayPartitionLeaf.lowerSlot,
                  recursiveArrayPartitionLeaf.upperSlot,
                ].map((slot) =>
                  `const local${slot} = ${entryArgumentValue(slot)};`),
                ...checkedLeafTripDeclarations,
                `return ssaRecursiveArrayWorker(${[
                  entryArrayDataVariable(
                    recursiveArrayPartitionLeaf.arraySlot),
                  ...argumentNames.slice(1),
                ].join(", ")});`,
              ].filter(Boolean)
              : [
                // The result slot precedes every guard: a lexical insertion
                // routes its prologue exits to this slot as well.
                `let ${checkedLeafResultVariable};`,
                ...directStaticDeclarations,
                ...lazyStaticDeclarations,
                ...directEntryStaticReadDeclarations,
                // Preflighted entries are an internal ABI whose caller has
                // already verified these exact capture and argument facts.
                // Select the fragments at IR emission time; generated source
                // is never parsed to discover or remove them.
                ...(includeCallerOwnedChecks
                  ? omitAdmissionOwnedCaptureRefreshes(
                    directPositionalCallCaptureDeclarations)
                  : []),
                ...(includeCallerOwnedChecks
                  ? directEntryCheckedAdmissionDeclarations : []),
                ...(includeCallerOwnedChecks
                  ? checkedLeafSafeArithmeticGuards : []),
                directBooleanGuard,
                includeRunCounter && !inline && this.runCountersEnabled
                  ? st`helpers.structuredSsa.restoringDirectRunCount += 1;`
                  : null,
                ...(atomicBoundedLoops || nestedRuntimeCountedRegion ||
                  shrinkingArrayWindowLeaf ||
                  recursiveArrayPartitionLeaf ||
                  transactionalAcyclicShape || lexicalCheckedLeafWrapperShape ||
                  inline
                  ? [] : [
                  stmt(e`let safePointBudget = ${restoringDirectSafePointBudget};`,
                    {kind: "safePointBudgetDeclaration"}),
                ]),
                ...checkedLeafEntryLocalDeclarations(),
                ...invariantPositionalCallDeclarations,
                ...checkedLeafEntryArrayDeclarationsFor(inline),
                ...persistentStaticArrayDataDeclarations,
                ...(transactionalAcyclicShape ? [
                  ...transactionalFieldReadCacheInitializations,
                ] : []),
                checkedLeafArrayDataGuardFor(inline),
                ...checkedLeafTripDeclarations,
                ...declarations,
                ...checkedLeafFramedTreeFor(inline),
              ].filter(Boolean);
            // Admission and constant/static specialization can leave a pure
            // capture alias, a staged inline operand, or an entry-local alias
            // without a consumer. There is deliberately no dead-declaration
            // pass here: the only available liveness signal would be counting
            // identifiers in the rendered statements, and the emitter cannot
            // answer the question cheaply either, because "does this tier's
            // tree still mention that name" is a fact about text that no
            // fragment producer records. Measured over the whole JIT test
            // suite the pass removed ten pure `const` aliases; every one of
            // them is a copy that the host engine's own SSA eliminates.
            if (recursiveArrayPartitionLeaf && !recursiveArrayWorkerBody) {
              const specialized = specializeCheckedLeafSelfRecursiveCalls(
                body.join("\n"), tier);
              if (specialized === null) return null;
              body = specialized.split("\n");
            }
            return body;
          };
          const checkedLeafBody = checkedLeafBodyFor({
            includeCallerOwnedChecks: true,
            includeRunCounter: true,
            tier: "ssa-checked-leaf-positional",
          });
          const checkedLeafRecursiveSpecialized = checkedLeafBody !== null;
          // A trusted checked leaf must contain no frame reconstruction, no
          // helper that can raise a guest exception, no unresolved array-range
          // token and no throwing construct. Transactionalization removes some
          // of those statements, so the question is about the statements that
          // actually survived into this body -- their records answer it.
          const unsafeCheckedLeafStatement = (line) => {
            const record = recordOf(line);
            if (!record) return false;
            if (record.kind === "spill" ||
                record.kind === "conditionalSpill" ||
                record.kind === "materializeSpill" ||
                record.guestArrayHelper === true ||
                record.throwsOrTries === true) return true;
            return partsReferences(record.parts)
              .some((name) => primitiveArrayAccessMarkers.has(name));
          };
          const unsafeCheckedLeafLine = !checkedLeafRecursiveSpecialized ||
            checkedLeafBody?.some(unsafeCheckedLeafStatement);
          if (recursiveArrayPartitionLeaf && unsafeCheckedLeafLine &&
              typeof process !== "undefined" &&
              process.env?.JVM_TRACE_STRUCTURED_RECURSIVE_ARRAY === "1") {
            console.error("[structured-recursive-array] unsafe", {
              checkedLeafRecursiveSpecialized,
              lines: checkedLeafBody.filter(unsafeCheckedLeafStatement),
            });
          }
          if (!unsafeCheckedLeafLine) {
            const trustedCheckedLeafBody = checkedLeafBodyFor({
              includeCallerOwnedChecks: true,
              includeRunCounter: false,
              tier: "ssa-trusted-checked-leaf-positional",
            });
            if (!trustedCheckedLeafBody) {
              throw new Error("failed to specialize trusted checked leaf");
            }
            checkedLeafDirectPositionalSource = [
              "'use strict';",
              restoringInitializationGuardDeclaration,
              directGuard,
              ...checkedLeafBody,
            ].join("\n");
            checkedLeafDirectPositionalBody =
              createStructuredFunction(
                "ssa-checked-leaf-positional",
                ["helpers", ...argumentNames, "thread",
                  "nestedEntryGuarded"],
                checkedLeafDirectPositionalSource,
                null, false, false,
                {
                  ...methodSpecializedCheckedCaptures,
                  ...(recursiveArrayWorkerBody
                    ? {ssaRecursiveArrayWorker: recursiveArrayWorkerBody}
                    : {}),
                },
              );
            // Positional generated callers invoke a checked child only after
            // their own scheduler/debug entry guard has succeeded. Publish a
            // second ABI for that structurally proven context so a large leaf
            // does not retain a dynamic truthiness branch merely because V8
            // declines to inline it. The child class-initialization epoch and
            // every array/range predicate remain in this entry; only the
            // already-dominated outer-entry condition is specialized.
            trustedCheckedLeafDirectPositionalSource = [
              "'use strict';",
              restoringInitializationGuardDeclaration,
              trustedDirectGuard,
              ...trustedCheckedLeafBody,
            ].join("\n");
            trustedCheckedLeafDirectPositionalBody =
              createStructuredFunction(
                "ssa-trusted-checked-leaf-positional",
                ["helpers", ...argumentNames, "thread"],
                trustedCheckedLeafDirectPositionalSource,
                null, false, false,
                {
                  ...methodSpecializedCheckedCaptures,
                  ...(recursiveArrayWorkerBody
                    ? {ssaRecursiveArrayWorker: recursiveArrayWorkerBody}
                    : {}),
                },
              );
            if (preflightedCheckedLeafVerifier &&
                preflightedCheckedLeafArgumentSlots?.length) {
              const preflightedCheckedLeafBody = checkedLeafBodyFor({
                includeCallerOwnedChecks: false,
                includeRunCounter: false,
                tier: "ssa-preflighted-checked-leaf-positional",
              });
              if (!preflightedCheckedLeafBody) {
                throw new Error("failed to specialize preflighted checked leaf");
              }
              preflightedCheckedLeafDirectPositionalSource = [
                "'use strict';",
                ...preflightedCheckedLeafBody,
              ].join("\n");
              preflightedCheckedLeafDirectPositionalBody =
                createStructuredFunction(
                  "ssa-preflighted-checked-leaf-positional",
                  ["helpers", ...argumentNames, "thread"],
                  preflightedCheckedLeafDirectPositionalSource,
                  null, false, false,
                  {
                    ...methodSpecializedCheckedCaptures,
                    ...(recursiveArrayWorkerBody
                      ? {ssaRecursiveArrayWorker: recursiveArrayWorkerBody}
                      : {}),
                  },
                );
            }
            transactionalAcyclicCheckedLeaf =
              transactionalAcyclicShape || transactionalAcyclicReadShape;
            const capturedCaches = [...entryStaticReadCaches.values()];
            if (capturedCaches.length > 0 &&
                capturedCaches.every((cache) => cache.direct) &&
                lazyStaticSites.size === 0 &&
                guardedStaticBooleanSites.size === 0) {
              const captureArguments = [];
              const captureDeclarations = [];
              const captures = [];
              capturedCheckedLeafCaptureArguments = captureArguments;
              for (const cache of capturedCaches) {
                const valueArgument =
                  `ssaCapturedStatic${captureArguments.length}`;
                captureArguments.push(valueArgument);
                captureDeclarations.push(
                  `const ${cache.value} = ${valueArgument};`);
                const capture = {
                  targetId: cache.direct.targetId,
                  kind: cache.direct.kind,
                  key: cache.direct.key,
                  className: cache.direct.className,
                  descriptor: cache.descriptor,
                  data: Boolean(cache.data),
                };
                if (cache.data) {
                  const dataArgument =
                    `ssaCapturedStatic${captureArguments.length}`;
                  captureArguments.push(dataArgument);
                  captureDeclarations.push(
                    `const ${cache.data} = ${dataArgument};`);
                }
                captures.push(capture);
              }
              capturedCheckedLeafBodyFor = (inline = null) =>
                [
                  `let ${checkedLeafResultVariable};`,
                  ...captureDeclarations,
                  !inline && this.runCountersEnabled
                    ? st`helpers.structuredSsa.restoringDirectRunCount += 1;`
                    : null,
                  ...(nestedRuntimeCountedRegion || shrinkingArrayWindowLeaf ||
                    recursiveArrayPartitionLeaf ||
                    transactionalAcyclicShape ||
                    lexicalCheckedLeafWrapperShape || inline
                    ? [] : [
                    stmt(e`let safePointBudget = ${restoringDirectSafePointBudget};`,
                      {kind: "safePointBudgetDeclaration"}),
                  ]),
                  ...checkedLeafEntryLocalDeclarations(),
                  ...checkedLeafEntryArrayDeclarationsFor(inline),
                  ...persistentStaticArrayDataDeclarations,
                  ...(transactionalAcyclicShape
                    ? transactionalFieldReadCacheInitializations : []),
                  checkedLeafArrayDataGuardFor(inline),
                  ...checkedLeafTripDeclarations,
                  ...declarations,
                  ...checkedLeafFramedTreeFor(inline),
                ].filter(Boolean);
              const capturedBody = capturedCheckedLeafBodyFor();
              capturedCheckedLeafDirectPositionalSource = [
                "'use strict';",
                restoringInitializationGuardDeclaration,
                directGuard,
                ...capturedBody,
              ].join("\n");
              capturedCheckedLeafDirectPositionalBody =
                createStructuredFunction(
                  "ssa-captured-checked-leaf-positional",
                  ["helpers", ...argumentNames, ...captureArguments,
                    "thread", "nestedEntryGuarded"],
                  capturedCheckedLeafDirectPositionalSource,
                );
              capturedCheckedLeafDirectPositionalPlan = {
                captures,
              };
            }
            // The body a lexical caller inserts. It is assembled from the same
            // fragments as the standalone entries under the caller's feeds
            // and proofs; the caller binds the parameter and capture names by
            // declaration around it and reads the result slot afterwards.
            checkedLeafInlineBody = recursiveArrayPartitionLeaf ||
              !checkedLeafDirectPositionalBody ? null : {
                serial: compileSerial,
                result: checkedLeafResultVariable,
                label: checkedLeafBodyLabel,
                returnsVoid: directMethodDescriptor.returnType === "void",
                argumentNames: [...argumentNames],
                captured: Boolean(capturedCheckedLeafDirectPositionalBody),
                captureArguments: capturedCheckedLeafDirectPositionalBody
                  ? [...capturedCheckedLeafCaptureArguments] : [],
                assemble: ({ feeds, provenGuards, exitLabel }) => {
                  const inline = { feeds, provenGuards };
                  const body = capturedCheckedLeafDirectPositionalBody
                    ? capturedCheckedLeafBodyFor(inline)
                    : checkedLeafBodyFor({
                      includeCallerOwnedChecks: true,
                      includeRunCounter: false,
                      tier: "ssa-inline-checked-leaf",
                      inline,
                    });
                  if (!body) return null;
                  // Exits precede the labeled tree as well as occur inside
                  // it, so they leave through the caller's enclosing label.
                  const retargeted = retargetCheckedLeafBails(body, {
                    result: checkedLeafResultVariable,
                    label: exitLabel,
                    returnsVoid: directMethodDescriptor.returnType === "void",
                  });
                  // Every exit must have been routed to the result slot; an
                  // unexpected return would leave the caller's activation.
                  if (retargeted.lines.some((line) =>
                    line.trim().startsWith("return "))) return null;
                  return retargeted;
                },
              };
          }
        }
      }
      let adaptivePositionalBody = null;
      let adaptivePositionalSource = null;
      let ordinaryAdaptive = false;
      // An ordinary adaptive body cannot preserve lexical SSA state when its
      // wall-clock quantum expires. That is safe for a positional call (the
      // caller receives the exact materialized deopt), and for a call-free
      // scheduler entry whose work is locally bounded. A call-bearing entry can
      // spend an unbounded amount of its host deadline in children; selecting
      // the ordinary body there strands the Frame at a mid-method PC and every
      // later scheduler turn falls through to the baseline resume body. Keep
      // the ordinary ABI for compiled callers, but let canonical call-bearing
      // Frames use the generator that retains their structured continuation.
      // Exact active-child continuations materialize the post-invoke parent
      // and restore it beneath a scheduler-visible child. Consequently a
      // verified non-recursive call graph may retain this Frame virtually and
      // keep invoking scalar children in one host activation. Mixed recursion
      // remains canonical because several omitted instances can otherwise
      // compete for one child return owner.
      const compiledCallChain = useContinuations && callSites.size > 0 &&
        !hasSelfRecursiveCall && this.jit.compiledCallChainsEnabled;
      const ordinaryAdaptiveCanonical =
        this.jit.ordinaryAdaptiveFramelessPositionalEnabled &&
        (callSites.size === 0 || compiledCallChain &&
          this.jit.ordinaryAdaptiveCallChainSafePointBudget > 0);
      if (useContinuations && (callSites.size === 0 || compiledCallChain ||
          regionCallGraphCandidate) &&
          this.jit.adaptiveFramelessPositionalEnabled) {
        const adaptiveBudgetMultiplier = regionCallGraphCandidate
          ? Math.max(this.jit.adaptiveFramelessBudgetMultiplier,
            this.restoringDirectBudgetMultiplier)
          : this.jit.adaptiveFramelessBudgetMultiplier;
        const configuredCallChainBudget = compiledCallChain
          ? this.jit.ordinaryAdaptiveCallChainSafePointBudget : 0;
        const adaptiveSafePointBudget = Math.min(100_000_000, Math.max(
          safePointInitialBudget * adaptiveBudgetMultiplier,
          configuredCallChainBudget,
        ));
        // Per-loop work weighting normally clamps the shared counter on loop
        // entry. Scale those exact loop budgets with the adaptive quantum;
        // otherwise every loop immediately overwrites the enlarged entry
        // budget with its canonical value and the multiplier is inert.
        const adaptiveLoopBudgetScale =
          adaptiveSafePointBudget / safePointInitialBudget;
        const adaptiveLoopSafePointBudgets = new Map(
          [...loopPollBudgets].map(([header, budget]) => [header,
            Math.min(100_000_000,
              Math.max(budget, Math.floor(
                budget * adaptiveLoopBudgetScale))),
          ]),
        );
        // A compiled call chain is valuable only if the host can optimize it
        // as an ordinary activation. Generator resumptions merely exchange a
        // JVM Frame boundary for a similarly costly host iterator boundary.
        // A real child/scheduler handoff already materializes the exact parent
        // and exits this function, so it needs no lexical iterator to resume.
        // A hot call-graph root can outlive one enlarged scheduler quantum.
        // Keep its positional entry as a generator so a safe-point exit on a
        // lazily restored child Frame retains the scalar iterator. Otherwise
        // the next turn can only restart method-at-a-time execution at the
        // materialized mid-method PC, permanently abandoning the region.
        // The independent ordinary-adaptive and compiled-chain experiments
        // retain their ordinary-function policy.
        ordinaryAdaptive = compiledCallChain || ordinaryAdaptiveCanonical;
        const adaptiveBody = buildBody(
          expandContinuationFallbacks(
            render(structured.tree, !ordinaryAdaptive, false,
              adaptiveSafePointBudget, false, false,
              adaptiveLoopSafePointBudgets),
            !ordinaryAdaptive),
          adaptiveSafePointBudget,
        );
        if (ordinaryAdaptive) {
          adaptiveBody.splice(1, 0,
            "helpers.ordinaryAdaptiveFramelessRunCount += 1;");
        }
        adaptivePositionalSource = adaptiveBody.join("\n");
        const adaptiveGeneratedBody = createStructuredFunction(
          "structured-ssa-adaptive-positional",
          ["frame", "thread", "helpers", "initialBytecodeChecks", "framelessEntry"],
          adaptivePositionalSource,
          null, false, !ordinaryAdaptive,
        );
        if (ordinaryAdaptive) {
          // Most hot browser loops finish inside the enlarged quantum. An
          // ordinary function lets SpiderMonkey optimize their numeric body;
          // the emitted non-generator safe point still materializes the exact
          // PC/locals/stack and deoptimizes if a run exceeds that quantum.
          adaptivePositionalBody = adaptiveGeneratedBody;
        } else {
          // The enlarged frameless quantum can still meet a wall-clock safe
          // point in a genuinely large guest loop. Keep its lexical iterator
          // on the lazily restored child Frame so the canonical structured
          // entry resumes the same scalar state on the next scheduler turn.
          adaptivePositionalBody = function (
            frame, thread, helpers, initialBytecodeChecks, framelessEntry,
          ) {
            let continuation = frame[STRUCTURED_CONTINUATION];
            if (continuation) {
              const bytecodeChecks = initialBytecodeChecks === undefined
                ? helpers.needsBytecodeChecks() : initialBytecodeChecks;
              const guardedStaticChanged =
                !guardedStaticBooleanStateMatches();
              const fieldBackedArrayChanged =
                !fieldBackedArrayStateMatches(
                  continuation.fieldBackedArrayState);
              if (continuation.pc !== frame.pc || bytecodeChecks ||
                  guardedStaticChanged || fieldBackedArrayChanged) {
                delete frame[STRUCTURED_CONTINUATION];
                try { continuation.iterator.return(); } catch (_) {}
                if (guardedStaticChanged) {
                  helpers.structuredSsa.guardedBooleanFallbackCount += 1;
                }
                if (fieldBackedArrayChanged) {
                  helpers.structuredSsa
                    .fieldBackedArrayContinuationFallbackCount += 1;
                }
                helpers.skipJitOnce(frame);
                return {
                  deopt: true, transient: true,
                  reason: "invalidated structured SSA continuation",
                };
              }
              if (frame !== null && thread.callStack.peek() !== frame) {
                return {
                  deopt: true, transient: true,
                  reason: "structured SSA continuation with active child",
                };
              }
            }
            const iterator = continuation?.iterator ||
              adaptiveGeneratedBody(
                frame, thread, helpers, initialBytecodeChecks, framelessEntry);
            let step;
            try {
              step = iterator.next();
            } catch (error) {
              delete frame[STRUCTURED_CONTINUATION];
              throw error;
            }
            if (step.done) {
              delete frame[STRUCTURED_CONTINUATION];
              return step.value;
            }
            frame[STRUCTURED_CONTINUATION] = {
              iterator,
              pc: Number.isInteger(step.value?.structuredResumePc)
                ? step.value.structuredResumePc : frame.pc,
              ownsFrame: step.value?.structuredResumeOwnsFrame === true,
              framelessEntry: true,
              fieldBackedArrayState: captureFieldBackedArrayState(frame),
            };
            return step.value;
          };
        }
        if (!ordinaryAdaptive) {
          adaptivePositionalBody.jvmSourceUrl = adaptiveGeneratedBody.jvmSourceUrl;
          adaptivePositionalBody.toString = () => adaptiveGeneratedBody.toString();
        }
      }
      const generated = useContinuations
        ? function (frame, thread, helpers, initialBytecodeChecks) {
          let continuation = frame[STRUCTURED_CONTINUATION];
          if (!continuation && ordinaryAdaptiveCanonical &&
              adaptivePositionalBody) {
            return adaptivePositionalBody(
              frame, thread, helpers, initialBytecodeChecks, false);
          }
          if (continuation) {
            const bytecodeChecks = initialBytecodeChecks === undefined
              ? helpers.needsBytecodeChecks() : initialBytecodeChecks;
            const guardedStaticChanged =
              !guardedStaticBooleanStateMatches();
            const fieldBackedArrayChanged =
              !fieldBackedArrayStateMatches(
                continuation.fieldBackedArrayState);
            if (continuation.pc !== frame.pc || bytecodeChecks ||
                guardedStaticChanged || fieldBackedArrayChanged) {
              delete frame[STRUCTURED_CONTINUATION];
              try { continuation.iterator.return(); } catch (_) {}
              if (guardedStaticChanged) {
                helpers.structuredSsa.guardedBooleanFallbackCount += 1;
              }
              if (fieldBackedArrayChanged) {
                helpers.structuredSsa
                  .fieldBackedArrayContinuationFallbackCount += 1;
              }
              helpers.skipJitOnce(frame);
              return {
                deopt: true, transient: true,
                reason: "invalidated structured SSA continuation",
              };
            }
            if (frame !== null && thread.callStack.peek() !== frame) {
              return {
                deopt: true, transient: true,
                reason: "structured SSA continuation with active child",
              };
            }
          }
          const iterator = continuation?.iterator ||
            generatedBody(frame, thread, helpers, initialBytecodeChecks);
          let step;
          try {
            step = iterator.next();
          } catch (error) {
            delete frame[STRUCTURED_CONTINUATION];
            throw error;
          }
          if (step.done) {
            delete frame[STRUCTURED_CONTINUATION];
            // A positional iterator that yielded was restored as a canonical
            // child Frame, but its lexical return path still carries the
            // original frameless-entry flag and therefore returns the Java
            // value directly. Complete the ordinary Frame protocol here once
            // that restored iterator finishes.
            if (continuation?.framelessEntry) {
              frame.stack.items.length = 0;
              frame.pc = items.length;
              thread.callStack.pop();
              return { returned: true, value: step.value };
            }
            return step.value;
          }
          frame[STRUCTURED_CONTINUATION] = {
            iterator,
            pc: Number.isInteger(step.value?.structuredResumePc)
              ? step.value.structuredResumePc : frame.pc,
            ownsFrame: step.value?.structuredResumeOwnsFrame === true,
            // A frameless adaptive iterator can require several ordinary
            // scheduler turns after it restores its child Frame. Preserve
            // that origin across every yield so the eventual completion pops
            // the restored child exactly once instead of restarting it from
            // a materialized loop PC.
            framelessEntry: continuation?.framelessEntry === true,
            fieldBackedArrayState: captureFieldBackedArrayState(frame),
          };
          return step.value;
        }
        : generatedBody;
      const wrapHotCallGraphGenerator = useContinuations
        ? (regionGeneratedBody) => function (
          frame, thread, helpers, initialBytecodeChecks,
        ) {
          let continuation = frame[STRUCTURED_CONTINUATION];
          if (continuation) {
            const bytecodeChecks = initialBytecodeChecks === undefined
              ? helpers.needsBytecodeChecks() : initialBytecodeChecks;
            const guardedStaticChanged = !guardedStaticBooleanStateMatches();
            const fieldBackedArrayChanged = !fieldBackedArrayStateMatches(
              continuation.fieldBackedArrayState);
            if (continuation.pc !== frame.pc || bytecodeChecks ||
                guardedStaticChanged || fieldBackedArrayChanged) {
              delete frame[STRUCTURED_CONTINUATION];
              try { continuation.iterator.return(); } catch (_) {}
              if (guardedStaticChanged) {
                helpers.structuredSsa.guardedBooleanFallbackCount += 1;
              }
              if (fieldBackedArrayChanged) {
                helpers.structuredSsa
                  .fieldBackedArrayContinuationFallbackCount += 1;
              }
              helpers.skipJitOnce(frame);
              return {
                deopt: true, transient: true,
                reason: "invalidated hot call-graph continuation",
              };
            }
            if (frame !== null && thread.callStack.peek() !== frame) {
              return {
                deopt: true, transient: true,
                reason: "hot call-graph continuation with active child",
              };
            }
          }
          const iterator = continuation?.iterator || regionGeneratedBody(
            frame, thread, helpers, initialBytecodeChecks, false);
          let step;
          try {
            step = iterator.next();
          } catch (error) {
            delete frame[STRUCTURED_CONTINUATION];
            throw error;
          }
          if (step.done) {
            delete frame[STRUCTURED_CONTINUATION];
            return step.value;
          }
          frame[STRUCTURED_CONTINUATION] = {
            iterator,
            pc: Number.isInteger(step.value?.structuredResumePc)
              ? step.value.structuredResumePc : frame.pc,
            ownsFrame: step.value?.structuredResumeOwnsFrame === true,
            framelessEntry: false,
            fieldBackedArrayState: captureFieldBackedArrayState(frame),
          };
          return step.value;
        }
        : null;
      if (useContinuations) {
        generated.jvmSourceUrl = generatedBody.jvmSourceUrl;
        generated.jvmHasStructuredContinuation =
          (frame) => Boolean(frame?.[STRUCTURED_CONTINUATION]);
        generated.jvmHasOwnedStructuredContinuation =
          (frame) => frame?.[STRUCTURED_CONTINUATION]?.ownsFrame === true;
        generated.jvmClearStructuredContinuation = (frame) => {
          const continuation = frame?.[STRUCTURED_CONTINUATION];
          if (!continuation) return false;
          delete frame[STRUCTURED_CONTINUATION];
          try { continuation.iterator.return(); } catch (_) {}
          return true;
        };
        generated.toString = () => generatedBody.toString();
      }
      generated.jvmSynchronous = true;
      generated.jvmStructuredSsa = true;
      generated.jvmStructuredRequiresBaselineFramedEntry =
        requiresBaselineFramedEntry && !useContinuations;
      generated.jvmStructuredContinuation = useContinuations;
      generated.jvmCompiledCallChain = compiledCallChain;
      generated.jvmHotCallGraphFramedSource = regionCallGraphCandidate
        ? generatedSource : null;
      generated.jvmHotCallGraphWrapGenerator = regionCallGraphCandidate
        ? wrapHotCallGraphGenerator : null;
      generated.jvmHotCallGraphHasContinuation = regionCallGraphCandidate
        ? (frame) => Boolean(frame?.[STRUCTURED_CONTINUATION]) : null;
      generated.jvmHotCallGraphHasOwnedContinuation = regionCallGraphCandidate
        ? (frame) => frame?.[STRUCTURED_CONTINUATION]?.ownsFrame === true : null;
      generated.jvmStructuredCanonicalNestedCalls = canonicalNestedCalls;
      // A call-bearing body may leave a scheduler-visible child Frame. The
      // positional wrapper can restore one omitted caller immediately beneath
      // that child, so ordinary acyclic call graphs retain their fast scalar
      // entry. Mixed self-recursion is different: several omitted instances
      // can own the same independently dispatched child transition. Keep that
      // verified shape Frame-backed, matching the restoring-direct admission
      // rule above, without penalizing every method that merely has a call.
      generated.jvmFramelessPositional =
        method.name !== "<init>" && !useContinuations &&
        !(hasSelfRecursiveCall && hasIndependentlySuspendableCall);
      generated.jvmDirectPositionalBody = directPositionalBody;
      // Statement-level fragments of each published positional body, for the
      // region compiler's outlining, partitioning and environment lifting.
      // The fragments' lines, joined in order, are exactly the published
      // source without its `'use strict';` directive. Loops and try/catch are
      // single fragments. `reads` includes the ambient names a fragment
      // mentions (`helpers`, `frame`, `thread`, `safePointBudget`, ...), which
      // an outlined unit has to receive even though no statement declares one.
      // Each fragment also publishes the statement record behind every one of
      // its lines: the parts list the emitter built, the operand names it
      // reads and writes, the block nesting it opens or closes, and how its
      // exits are re-established when the statement is relocated. A consumer
      // that outlines or partitions a body therefore rewrites parts lists,
      // never emitted characters. A statement whose parts no longer render
      // its line -- a late expansion the fragment could not follow -- is
      // published without them and is not relocatable.
      const publishedRegionStatement = (statement, line) => {
        // Every line of a published fragment has a record: `regionFragmentsOf`
        // refuses a body that contains a line no emitter recorded.
        if (!statement) return null;
        // Indentation is applied by the assembler and is not part of a
        // statement's identity, so the comparison is on the identity the
        // record was keyed by.
        if (renderParts(statement.parts).trim() !== line.trim()) {
          return {...statement, text: line, parts: null, relocatable: false};
        }
        return statement;
      };
      const publishedRegionFragments = Object.entries(regionFragments)
        .filter(([, fragments]) => Array.isArray(fragments))
        .map(([variant, fragments]) => [variant, fragments.map(
          (fragment) => ({
            id: fragment.id,
            kind: fragment.kind,
            lines: [...fragment.lines],
            declares: [...fragment.declares],
            reads: [...fragment.reads],
            writes: [...fragment.writes],
            statements: fragment.lines.map((line, index) =>
              publishedRegionStatement(
                (fragment.statements || [])[index], line)),
          }))])
        // A variant whose statements could not all be published loses its
        // fragments rather than publishing a partial record.
        .filter(([, fragments]) => fragments.every(
          (fragment) => fragment.statements.every(Boolean)));
      generated.jvmStructuredRegionFragments =
        Object.fromEntries(publishedRegionFragments);
      generated.jvmStructuredRegionLocalNames = Object.fromEntries(
        publishedRegionFragments.map(([variant, fragments]) =>
          [variant, regionLocalNamesOf(fragments)]));
      generated.jvmDirectPositionalSource = directPositionalSource;
      generated.jvmInternalRegionPositionalSource =
        internalRegionPositionalSource;
      generated.jvmRestoringDirectPositionalBody = restoringDirectPositionalBody;
      generated.jvmRestoringDirectPositionalSource = restoringDirectPositionalSource;
      // The insertable forms of the two bodies a hot call-graph region
      // inserts. Each publishes the body, the names it binds, and an
      // assembler; a consumer never rewrites the emitted text.
      generated.jvmInternalRegionPositionalInsertion =
        internalRegionPositionalInsertion;
      generated.jvmRestoringDirectPositionalInsertion =
        restoringDirectPositionalInsertion;
      const regionReceiverSlots = methodIsStatic ? 0 : 1;
      const regionArgumentCount = directMethodDescriptor.params.length +
        regionReceiverSlots;
      generated.jvmStructuredRegionArgumentNames = Array.from(
        {length: regionArgumentCount},
        (_unused, index) => `argument${index}`,
      );
      generated.jvmStructuredRegionCallSites = [...callSites.values()].map(
        (site) => ({
          id: site.id,
          pc: site.pc,
          op: site.op,
          declaredOwner: site.declaredOwner,
          memberName: site.memberName,
          descriptor: site.descriptor,
          resolvedMethod: site.resolvedMethod,
          exactTarget: site.exactTarget,
          dynamic: site.dynamic,
          directBoundary: Boolean(site.directJre || site.inline ||
            site.directIntrinsic || site.directCheckedLeaf),
          directFieldWriteKeys:
            Array.isArray(site.directJre?.fieldWriteKeys)
              ? [...site.directJre.fieldWriteKeys] : null,
          identifiers: {...site.identifiers},
          regionMarkers: {...site.regionMarkers},
          regionLowering: site.regionLowering || null,
        }));
      // A region that links a call site replaces the site's bindings by
      // identity. Publish the exact declaration text and declaration kind of
      // every binding this renderer emitted, in both the framed and the
      // positional variants, together with the dependency order among them.
      const regionCallBindingDeclarations = {};
      for (const declarationSet of [
        directPositionalCallDeclarationSet, positionalCallDeclarationSet,
      ]) {
        for (const [name, entry] of declarationSet.declarationsByName) {
          const entries = regionCallBindingDeclarations[name] || [];
          if (!entries.some((candidate) => candidate.text === entry.text)) {
            entries.push(entry);
          }
          regionCallBindingDeclarations[name] = entries;
        }
      }
      generated.jvmStructuredRegionCallBindingDeclarations =
        regionCallBindingDeclarations;
      // These sites read their call bindings from a declaration outside the
      // call's own marker span (the loop-invariant raw target). A region that
      // lowers such a site must keep the bindings it linked.
      generated.jvmStructuredRegionInvariantPositionalCallIndices =
        [...invariantPositionalReceiverSlots.keys()];
      // The exact run-accounting statements a fused internal node drops: the
      // graph is one execution unit and must not re-count each member entry.
      generated.jvmStructuredRegionRunCounterStatements =
        this.runCountersEnabled ? [
          stmt(exprConcat(e`if (nestedEntryGuarded !== 2) `,
            e`helpers.structuredSsa.runCount += 1;`)),
          stmt(exprConcat(e`if (nestedEntryGuarded !== 2) `,
            e`helpers.structuredSsa.restoringDirectRunCount += 1;`)),
          st`helpers.structuredSsa.runCount += 1;`,
          st`helpers.structuredSsa.restoringDirectRunCount += 1;`,
        ] : [];
      // The exact safe-point budget declarations this renderer emitted, one
      // per positional variant. A fused module owns a single counter and
      // removes these by identity rather than matching emitted text.
      generated.jvmStructuredSafePointBudgetDeclarations = [...new Set([
        safePointInitialBudget,
        regionCallGraphCandidate
          ? this.jit.hotCallGraphRegions.directSafePointBudget
          : safePointInitialBudget,
        Math.min(1_000_000, regionCallGraphCandidate
          ? this.jit.hotCallGraphRegions.directSafePointBudget
          : safePointInitialBudget * this.restoringDirectBudgetMultiplier),
      ])].map((budget) => `let safePointBudget = ${budget};`);
      generated.jvmCheckedLeafDirectPositionalBody =
        checkedLeafDirectPositionalBody;
      generated.jvmCheckedLeafDirectPositionalSource =
        checkedLeafDirectPositionalSource;
      generated.jvmTrustedCheckedLeafDirectPositionalBody =
        trustedCheckedLeafDirectPositionalBody;
      generated.jvmTrustedCheckedLeafDirectPositionalSource =
        trustedCheckedLeafDirectPositionalSource;
      generated.jvmPreflightedCheckedLeafDirectPositionalBody =
        preflightedCheckedLeafDirectPositionalBody;
      generated.jvmPreflightedCheckedLeafDirectPositionalSource =
        preflightedCheckedLeafDirectPositionalSource;
      generated.jvmPreflightedCheckedLeafStaticVerifier =
        preflightedCheckedLeafVerifier;
      generated.jvmPreflightedCheckedLeafArgumentSlots =
        preflightedCheckedLeafArgumentSlots;
      generated.jvmPreflightedCheckedLeafArgumentLimit =
        preflightedCheckedLeafArgumentLimit;
      generated.jvmCapturedCheckedLeafDirectPositionalBody =
        capturedCheckedLeafDirectPositionalBody;
      generated.jvmCapturedCheckedLeafDirectPositionalSource =
        capturedCheckedLeafDirectPositionalSource;
      generated.jvmCapturedCheckedLeafDirectPositionalPlan =
        capturedCheckedLeafDirectPositionalPlan;
      generated.jvmCheckedLeafInlineBody = checkedLeafInlineBody;
      // The region compiler also publishes an ordinary scalar module for
      // bounded invocations and differential tests. Keep the adaptive entry
      // available alongside it: callers of a continuation root need this
      // Frame-owning wrapper to preserve the iterator across a scheduler
      // boundary instead of resuming baseline bytecodes at a mid-method PC.
      generated.jvmAdaptivePositionalBody = adaptivePositionalBody;
      generated.jvmAdaptivePositionalSource = adaptivePositionalSource;
      generated.jvmAdaptivePositionalOrdinary =
        Boolean(adaptivePositionalBody && ordinaryAdaptive);
      generated.jvmStructuredLoopCount = structured.loopHeaders.size;
      generated.jvmStructuredNormalReachableCodeItemCount =
        normalReachableItems.size;
      generated.jvmStructuredSplitBlocks = splitBlocks;
      generated.jvmStructuredDispatchIslands = dispatchIslands;
      generated.jvmStructuredDeferredCallMaterializationCount =
        deferredCallMaterializationCount;
      generated.jvmStructuredReusedLocalLoadCount = reusedLocalLoadCount;
      generated.jvmStructuredEliminatedLocalStoreCount = eliminatedLocalStoreCount;
      generated.jvmStructuredEliminatedDeadLocalStoreCount =
        eliminatedDeadLocalStoreCount;
      generated.jvmStructuredSentinelArrayLoadCount = sentinelArrayLoadCount;
      generated.jvmStructuredBlockArrayDataViewCount =
        blockArrayDataViewCount;
      generated.jvmStructuredFixedPointScalarizationCount =
        fixedPointScalarizationCount;
      generated.jvmStructuredEliminatedArrayStoreCheckCount =
        eliminatedArrayStoreCheckCount;
      generated.jvmStructuredArrayRangeGuardCount =
        arrayRangeCheckCandidates.length;
      generated.jvmStructuredEntryFieldArrayLocalViewCount =
        entryFieldArrayLocalViews.size;
      generated.jvmStructuredNullableTestedStaticArrayCount =
        [...entryStaticReadCaches.values()].filter(
          (cache) => cache.data && cache.nullableTested).length;
      generated.jvmStructuredNullableStaticArrayGuardExclusionCount =
        hasNullableStaticArrayControl
          ? [...entryStaticReadCaches.values()].filter(
            (cache) => cache.data).length : 0;
      generated.jvmStructuredPersistentStaticArrayLocalViewCount =
        persistentStaticArrayLocalViews.size;
      generated.jvmStructuredPersistentProducedArrayLocalViewCount =
        persistentProducedArrayLocalViews.size;
      this.persistentProducedArrayLocalViewCompileCount +=
        persistentProducedArrayLocalViews.size;
      generated.jvmStructuredLoopInvariantStaticArrayViewCount =
        [...loopInvariantStaticArrayViewsByHeader.values()].reduce(
          (count, views) => count + views.size, 0);
      this.loopInvariantStaticArrayViewCompileCount +=
        generated.jvmStructuredLoopInvariantStaticArrayViewCount;
      generated.jvmStructuredFieldBackedArrayRangeCandidateCount =
        fieldBackedArrayRangeCandidateCount;
      generated.jvmStructuredIndirectArrayRangeCount =
        arrayRangeCheckCandidates.filter((candidate) =>
          candidate.kind === "indirect-entry-array" &&
          candidate.rangeGuardVariable).length;
      generated.jvmStructuredCoalescedArrayRangeGuardCount =
        coalescedArrayRangeGuardCount;
      generated.jvmStructuredBlockCoalescedArrayRangeAccessCount =
        blockCoalescedArrayRangeAccessCount;
      generated.jvmStructuredHoistedArrayRangeGuardCount =
        hoistedArrayRangeGuardCount;
      // Staging operations that reused an existing SSA value instead of
      // binding a second name to it. The copies are never emitted, so this
      // counts declarations avoided rather than declarations removed.
      generated.jvmStructuredCoalescedSsaCopyCount =
        coalescedSsaCopyCount;
      generated.jvmStructuredDominatedArithmeticGuardCount =
        dominatedArithmeticGuardCount;
      generated.jvmStructuredCapturedCheckedLeafCallCount =
        [...callSites.values()].filter((site) =>
          Array.isArray(site.directCheckedLeaf?.captures) &&
          site.directCheckedLeaf.captures.length > 0).length;
      generated.jvmStructuredLexicalCheckedLeafCallCount =
        [...callSites.values()].filter((site) =>
          Boolean(site.directCheckedLeaf?.inlineBody)).length;
      generated.jvmStructuredLexicalVoidFastPathCallCount =
        lexicalVoidFastPathSites.size;
      generated.jvmStructuredLexicalCheckedLeafWrapper = Boolean(
        checkedLeafDirectPositionalBody && lexicalCheckedLeafWrapper);
      generated.jvmStructuredNestedRuntimeCheckedLeaf = Boolean(
        checkedLeafDirectPositionalBody && nestedRuntimeCountedRegion);
      generated.jvmStructuredTransactionalAcyclicCheckedLeaf = Boolean(
        checkedLeafDirectPositionalBody && transactionalAcyclicCheckedLeaf);
      generated.jvmStructuredShrinkingArrayWindowCheckedLeaf = Boolean(
        checkedLeafDirectPositionalBody && shrinkingArrayWindowLeaf);
      generated.jvmStructuredShrinkingArrayWindowAccessCount =
        shrinkingArrayWindowLeaf?.accesses.length || 0;
      generated.jvmStructuredRecursiveArrayPartitionCheckedLeaf = Boolean(
        checkedLeafDirectPositionalBody && recursiveArrayPartitionLeaf);
      generated.jvmStructuredRecursiveArrayPartitionAccessCount =
        recursiveArrayPartitionLeaf?.accesses.length || 0;
      // Do not recover semantic contracts by parsing generated JavaScript.
      // A clipped-fill admission plan must eventually be published by the
      // bytecode/SSA analysis that proves argument and capture roles. Until
      // then the ordinary checked-leaf entry remains the canonical fast path.
      const clippedAffineFillAdmissionPlan = null;
      generated.jvmStructuredCheckedLeafAdmissionPlan =
        recursiveArrayPartitionLeaf ? {
          kind: "record-window",
          arraySlot: recursiveArrayPartitionLeaf.arraySlot,
          lowerSlot: recursiveArrayPartitionLeaf.lowerSlot,
          upperSlot: recursiveArrayPartitionLeaf.upperSlot,
          stride: recursiveArrayPartitionLeaf.stride,
          maximumRecords: runtimeCoarseTripLimit,
          guardVariable: recursiveArrayPartitionLeaf.variable,
        } : shrinkingArrayWindowLeaf ? {
          kind: "record-window",
          arraySlot: shrinkingArrayWindowLeaf.arraySlot,
          lowerSlot: shrinkingArrayWindowLeaf.lowerSlot,
          upperSlot: shrinkingArrayWindowLeaf.upperSlot,
          stride: shrinkingArrayWindowLeaf.stride,
          maximumRecords: Math.min(
            runtimeCoarseTripLimit,
            Math.floor(Math.sqrt(1_000_000))) + 1,
          guardVariable: shrinkingArrayWindowLeaf.variable,
        } : clippedAffineFillAdmissionPlan;
      generated.jvmStructuredRecursiveArrayPartitionWorkerSource =
        recursiveArrayWorkerBody ? recursiveArrayWorkerSource : null;
      generated.jvmStructuredBoundedIndexRangeCount =
        arrayRangeCheckCandidates.filter(
          (candidate) => candidate.kind === "bounded-index").length;
      generated.jvmStructuredScaledIndexRangeCount =
        arrayRangeCheckCandidates.filter(
          (candidate) => candidate.kind === "scaled-local").length;
      generated.jvmStructuredRecurrenceRangeCount =
        quotientProductRangePreambles.size;
      generated.jvmStructuredCyclicRangeCount =
        cyclicArrayRangeCandidates.size;
      generated.jvmStructuredSpecializedArrayRangeAccessCount =
        specializedArrayRangeAccessCount;
      generated.jvmStructuredDominatedFieldReceiverCheckCount =
        dominatedFieldReceiverCheckCount;
      generated.jvmStructuredDominatedEntryReferenceNullBranchCount =
        dominatedEntryReferenceNullBranchCount;
      generated.jvmStructuredEliminatedTerminalBreakCount =
        eliminatedTerminalStructuredBreakCount;
      generated.jvmStructuredEliminatedBlockCount =
        eliminatedStructuredBlockCount;
      generated.jvmStructuredRestoringRangeGuardDeoptCount =
        restoringRangeGuardDeoptCount;
      generated.jvmStructuredRestoringCoarseLoopDeoptCount =
        restoringCoarseLoopDeoptCount;
      generated.jvmStructuredRangeDominatedArithmeticGuardCount =
        rangeDominatedArithmeticGuardCount;
      generated.jvmStructuredLoopInvariantDivisorGuardCount =
        loopInvariantDivisorGuardCount;
      generated.jvmStructuredRestoringDirectFieldLayoutCount =
        restoringDirectFieldLayoutCaches.length;
      generated.jvmStructuredRestoringSpillCallCount =
        restoringSpillCallCount;
      generated.jvmStructuredRestoringSpillInlineCost =
        restoringSpillInlineCost;
      generated.jvmStructuredInlinedRestoringSpills =
        inlinedRestoringSpills;
      generated.jvmStructuredCaptureFreeRestoringSpills =
        captureFreeRestoringSpills;
      generated.jvmStructuredOutlinedCaptureFreeRestoringSpills =
        outlinedCaptureFreeRestoringSpills;
      generated.jvmStructuredEagerFieldReceiverNullCheckCount =
        eagerFieldReceiverNullChecks.size;
      generated.jvmStructuredRangeGuardDataVariableCount =
        arrayRangeGuardDataVariables.size;
      generated.jvmStructuredProvenDeferredStaticArrayAccessCount =
        provenDeferredStaticArrayAccesses.size;
      generated.jvmStructuredProvenCheckedCallAdmissionCount =
        provenCheckedCallAdmissionCount;
      generated.jvmStructuredGuardedBooleanSiteCount = guardedStaticBooleanSites.size;
      generated.jvmStructuredPrunedBooleanCfgBranchCount =
        prunedBooleanCfgBranches;
      generated.jvmStructuredDeclaredLocalCount = declaredLocals.length;
      generated.jvmStructuredSpilledLocalCount = spillSlots.length;
      generated.jvmStructuredRestoringFrameSlotCount =
        restoringFrameSlotCount;
      generated.jvmStructuredImmutableEntryLocalCount = immutableEntryLocals.size;
      generated.jvmStructuredFieldReadCacheCount = fieldReadCaches.size;
      generated.jvmStructuredEagerThisFieldCount = [...fieldReadCaches.values()]
        .filter((cache) => cache.eagerThis).length;
      generated.jvmStructuredEagerEntryFieldCount = [...fieldReadCaches.values()]
        .filter((cache) =>
          cache.eagerLocal !== null && cache.eagerLocal !== undefined).length;
      generated.jvmStructuredCoarseCountedLoopCount = coarseCountedLoops.size;
      generated.jvmStructuredRuntimeCoarseTripLimit = runtimeCoarseTripLimit;
      generated.jvmStructuredCountedLoopCount = countedLoopInfos.size;
      generated.jvmStructuredSafePointBudget = safePointInitialBudget;
      generated.jvmStructuredRestoringDirectSafePointBudget =
        restoringDirectPositionalBody
          ? Math.min(1_000_000, regionCallGraphCandidate
            ? this.jit.hotCallGraphRegions.directSafePointBudget
            : safePointInitialBudget * this.restoringDirectBudgetMultiplier)
          : 0;
      generated.jvmStructuredRestoringDirectRejection =
        restoringDirectPositionalEligible ? null : restoringDirectRejection;
      generated.jvmStructuredPositionalAstRejections = positionalAstRejections;
      generated.jvmStructuredLoopWorkEstimate = loopWorkEstimate;
      generated.jvmStructuredLoopPollBudgets = Object.fromEntries(
        loopPollBudgets);
      generated.jvmStructuredAtomicBoundedLoops = atomicBoundedLoops;
      generated.jvmStructuredBoundedIterationProduct =
        atomicBoundedLoops ? boundedIterationProduct : 0;
      generated.jvmStructuredSource = generatedSource;
      generated.jvmStructuredPartitionedSegmentCount =
        partitionedGenerated.count;
      generated.jvmStructuredPartitionedSourceBytes =
        partitionedGenerated.partitionedSourceBytes;
      generated.jvmStructuredPartitionAttemptedRuns =
        partitionedGenerated.attemptedRuns || 0;
      generated.jvmStructuredPartitionOversizedStatements =
        partitionedGenerated.oversizedStatements || 0;
      generated.jvmStructuredOutlinedLoopCount = outlinedGenerated.count;
      generated.jvmStructuredOutlinedLoopSourceBytes =
        outlinedGenerated.outlinedSourceBytes;
      this.compiledLoopCount += structured.loopHeaders.size;
      if (guardedStaticBooleanSites.size) {
        this.guardedBooleanMethodCount += 1;
        this.guardedBooleanSiteCount += guardedStaticBooleanSites.size;
      }
      if (splitBlocks > 0) {
        this.splitMethodCount += 1;
        this.splitBlockCount += splitBlocks;
      }
      if (dispatchIslands > 0) {
        this.dispatchIslandMethodCount += 1;
        this.dispatchIslandCount += dispatchIslands;
      }
      return generated;
    } catch (error) {
      this.lastCompileError = error;
      this.lastFailedSource = typeof generatedSource === "string"
        ? generatedSource : null;
      return reject(`JavaScript emission failed: ${error.message}`);
    }
  }
}

module.exports = JvmSsaBlockRenderer;
module.exports._test = {
  isIrreducibleError,
  unboundGeneratedSsaIdentifiers,
  reportStatementIrAudit,
};
