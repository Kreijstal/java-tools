'use strict';

/**
 * coalesceLoopLoad — collapse the "load X / goto T2 / T1: load X / T2: <use X>"
 * shape that survives multi-entry-loop normalization.
 *
 * Pattern in source order:
 *
 *   ... preheader code ...
 *       LOAD X            ; e.g. aload_2 / iload 7 / iload_3 / aload_0 /
 *                         ;     getstatic Field Foo bar I / iconst_1 / ldc "x"
 *       goto T2
 *   T1: LOAD X             ; identical opcode + operand
 *   T2: <use X>            ; first instruction at T2 consumes X
 *
 * Rewrite: collapse the duplicated load by redirecting the preheader past
 * the goto into the T1 path. The preheader's "LOAD X; goto T2" becomes
 * "goto T1" — the T1 LOAD then flows naturally into T2's use.
 *
 *   ... preheader code ...
 *       goto T1            ; preheader jumps to the duplicate's load
 *   T1: LOAD X
 *   T2: <use X>
 *
 * Result: one fewer LOAD instruction, two preheader paths converge on a
 * single basic block (the T1 block), and CFR can structure the surrounding
 * loop normally instead of emitting `** GOTO` markers.
 *
 * Safety constraints (refuse if any fail):
 *   1. The instruction immediately before the `goto T2` is a SAFE preheader
 *      LOAD with the SAME normalized key as the LOAD immediately after the
 *      labelDef T1. Recognized preheader-load classes:
 *        a) Local-variable loads: aload/iload/lload/fload/dload (numbered
 *           or _<n>). aload_0 is allowed ONLY if the enclosing method
 *           contains no astore_0 (slot 0 is never reassigned).
 *        b) Static-field reads: getstatic <FieldRef>, where the FieldRef
 *           on both sides compares equal (same owner.name:desc).
 *        c) Constant pushes: iconst_m1..iconst_5, lconst_0/1, fconst_0..2,
 *           dconst_0..1, aconst_null, bipush <byte>, sipush <short>,
 *           ldc/ldc_w/ldc2_w <constref>. The full instruction (opcode +
 *           operand) must compare equal between the preheader and T1.
 *      Field reads of instance fields (getfield) and computed loads (e.g.
 *      iaload, invokestatic, arithmetic) are not preheader-safe and are
 *      explicitly excluded.
 *   2. Label T1 exists and immediately precedes the duplicate LOAD X.
 *   3. Label T2 is the very next labelDef AFTER the post-T1 LOAD X.
 *   4. T2's predecessors are either:
 *        (a) Single-jump form: exactly one jump-predecessor — the preheader's
 *            `goto T2` — plus a fallthrough from the load right after T1.
 *        (b) Multi-jump form: N>=1 jump-predecessors, each one an
 *            UNCONDITIONAL `goto T2` whose immediately-preceding real
 *            instruction is the SAME LOAD X (identical normalized key) as
 *            the T1 fallthrough load. Plus a fallthrough from the load
 *            right after T1. Conditional jumps to T2 (or unconditional
 *            gotos to T2 not preceded by an identical LOAD X) reject the
 *            entire candidate.
 *      In both forms the post-T1 LOAD also flows by fallthrough into T2.
 *   5. T1 is reached ONLY by jumps (not a fallthrough from above), because
 *      we are about to redirect the preheader to T1 and the stack state
 *      from a fallthrough predecessor could disagree.
 *   6. T1 and T2 are not handler entries or exception-range labels.
 *
 * Returns { changed, fired } where `fired` is the number of patterns folded.
 */

// Local-variable loads, parameterized form (operand is the local index).
const LOCAL_LOAD_OPS = new Set(['aload', 'iload', 'lload', 'fload', 'dload']);

// Numbered local-variable loads (operand baked into opcode). aload_0 is
// gated separately because it represents `this` and is risky if the method
// reassigns slot 0; see `methodAllowsAload0`.
const NUMBERED_LOAD_OPS = new Set([
  'aload_0', 'aload_1', 'aload_2', 'aload_3',
  'iload_0', 'iload_1', 'iload_2', 'iload_3',
  'lload_0', 'lload_1', 'lload_2', 'lload_3',
  'fload_0', 'fload_1', 'fload_2', 'fload_3',
  'dload_0', 'dload_1', 'dload_2', 'dload_3',
]);

// Constant-push opcodes whose operand is baked into the opcode name. Two
// instances are equal iff the opcode names match.
const CONST_NULLARY_OPS = new Set([
  'iconst_m1', 'iconst_0', 'iconst_1', 'iconst_2', 'iconst_3', 'iconst_4', 'iconst_5',
  'lconst_0', 'lconst_1',
  'fconst_0', 'fconst_1', 'fconst_2',
  'dconst_0', 'dconst_1',
  'aconst_null',
]);

// Constant-push opcodes whose operand is a literal byte/short. Equality
// requires both opcode and operand to match.
const CONST_INT_LITERAL_OPS = new Set(['bipush', 'sipush']);

// Constant-pool ldc family. Equality requires both opcode and resolved
// constant ref to match.
const LDC_OPS = new Set(['ldc', 'ldc_w', 'ldc2_w']);

// Field accessor opcodes whose operand is a FieldRef. Only `getstatic` is a
// safe preheader load (it's side-effect-free given the obfuscated code
// already runs as-is). `getfield` is excluded because it reads from a
// stack-supplied object reference which the preheader rewrite can't preserve.
const STATIC_FIELD_OPS = new Set(['getstatic']);

// Slot-0 reassignment opcodes — used by `methodAllowsAload0` to gate
// `aload_0` candidates.
const ASTORE_0_OPS = new Set(['astore_0']);

const CONDITIONAL_JUMPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne',
  'ifnull', 'ifnonnull',
]);

const TERMINAL_OPCODES = new Set([
  'ret', 'return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'athrow',
]);

function runCoalesceLoopLoad(astRoot, options = {}) {
  const verbose = !!options.verbose;
  let totalFired = 0;

  for (const classItem of astRoot.classes || []) {
    for (const item of classItem.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        if (!attr || attr.type !== 'code' || !attr.code) continue;
        const codeItems = attr.code.codeItems;
        if (!Array.isArray(codeItems) || codeItems.length === 0) continue;
        const exceptionTable = Array.isArray(attr.code.exceptionTable) ? attr.code.exceptionTable : [];
        // Compute aload_0 gating once per method: aload_0 is only safe to
        // coalesce as a preheader load if no path in the method ever
        // reassigns slot 0 (i.e. no astore_0 anywhere). This is invariant
        // across rewrites by this pass — we never introduce new astore_0.
        const allowAload0 = methodAllowsAload0(codeItems);
        // Iterate fixed-pointed because each rewrite shifts indexes.
        // Rerun until no more changes for this method.
        let methodFired = 0;
        while (true) {
          const r = coalesceOnce(codeItems, exceptionTable, {
            verbose,
            owner: classItem.className,
            name: item.method.name,
            desc: item.method.descriptor,
            allowAload0,
          });
          if (r === 0) break;
          methodFired += r;
        }
        totalFired += methodFired;
      }
    }
  }
  return { changed: totalFired > 0, fired: totalFired };
}

function coalesceOnce(codeItems, exceptionTable, opts) {
  const protectedLabels = collectProtectedLabels(exceptionTable);
  // Iterate by T2 candidates: each labelDef whose first real instruction
  // is a "use" of an X loaded by an immediately-preceding LOAD on a
  // fallthrough block. We then identify T1 as the labelDef immediately
  // before that LOAD (still inside the same fallthrough block), and
  // collect jump-predecessors to T2 — each must be a `goto T2` preceded
  // by an identical LOAD X. The first `goto T2` is the preheader's; in
  // the multi-jump form there may be N>=1 such predecessors.
  for (let t2Idx = 0; t2Idx < codeItems.length; t2Idx++) {
    const t2Item = codeItems[t2Idx];
    if (!t2Item || !t2Item.labelDef) continue;
    const t2Name = trimLabel(t2Item.labelDef);
    if (!t2Name) continue;
    if (protectedLabels.has(t2Name)) continue;

    // T2 must have a fallthrough predecessor: the T1 LOAD just preceding
    // its labelDef. Walk backward over aux/labelDef items to find that
    // LOAD; if anything else (or method start / block terminator) sits
    // there, this isn't our pattern.
    const fallLoad = findPrevRealInsn(codeItems, t2Idx);
    if (!fallLoad) continue;
    if (!isSafeLoad(fallLoad.item.instruction, opts)) continue;
    const loadKey = loadKeyOf(fallLoad.item.instruction);
    if (!loadKey) continue;

    // T1's labelDef may sit on the SAME codeItem as the fallthrough LOAD
    // (typical Krak2 form: { labelDef: 'T1:', instruction: <load> }) or
    // on one or more preceding aux/labelDef items (alias chain). Collect
    // every label that resolves to the fallthrough LOAD's address; jumps
    // targeting any of them count toward the T1 predecessor set.
    const t1Aliases = collectT1Aliases(codeItems, fallLoad.idx);
    if (t1Aliases.length === 0) continue;
    // Pick the canonical T1 name as the alias with the most jump
    // predecessors. Ties broken by appearance order. This keeps the
    // rewritten goto pointing at the same name CFR / the source already
    // uses, which keeps surrounding label-naming stable.
    let t1Info = null;
    let bestJumps = -1;
    for (const a of t1Aliases) {
      if (protectedLabels.has(a.label)) continue;
      const n = collectJumpsToLabel(codeItems, a.label).length;
      if (n > bestJumps) { bestJumps = n; t1Info = a; }
    }
    if (!t1Info) continue;
    const t1Name = t1Info.label;
    if (protectedLabels.has(t1Name)) continue;
    if (t1Name === t2Name) continue;

    // T1 must be reached ONLY by jumps (no fallthrough predecessor),
    // because we will redirect preheader paths to T1; a fallthrough
    // predecessor could carry an incompatible stack state. Use the
    // EARLIEST alias index — the block's leading boundary — for the
    // fallthrough check.
    const t1BlockStartIdx = t1Aliases[0].idx;
    if (hasFallthroughPredecessor(codeItems, t1BlockStartIdx)) continue;
    // T1 must have at least one jump predecessor (otherwise unreachable
    // — there's nothing to coalesce).
    if (bestJumps === 0) continue;

    // Validate every jump to T2 is an unconditional `goto` preceded by
    // an identical LOAD X. Conditional jumps (or unconditional gotos
    // whose preceding insn is not the same LOAD X) reject the candidate.
    const t2Jumps = collectJumpsToLabel(codeItems, t2Name);
    if (t2Jumps.length === 0) continue;
    let multiJumpOk = true;
    const jumpLoads = []; // [{ gotoItem, gotoIdx, loadIdx }]
    for (const j of t2Jumps) {
      const op = getOp(j.item.instruction);
      if (op !== 'goto') { multiJumpOk = false; break; }
      const prev = findPrevRealInsn(codeItems, j.idx);
      if (!prev) { multiJumpOk = false; break; }
      if (!isSafeLoad(prev.item.instruction, opts)) { multiJumpOk = false; break; }
      if (loadKeyOf(prev.item.instruction) !== loadKey) { multiJumpOk = false; break; }
      jumpLoads.push({ gotoItem: j.item, gotoIdx: j.idx, loadIdx: prev.idx });
    }
    if (!multiJumpOk) continue;

    // ---- All safety checks pass. Rewrite. ----
    // For each jump-predecessor, retarget its `goto T2` to `goto T1`
    // and delete the immediately-preceding LOAD X. Walk in descending
    // index order so earlier indexes stay valid through splice() calls.
    jumpLoads.sort((a, b) => b.loadIdx - a.loadIdx);
    for (const jl of jumpLoads) {
      jl.gotoItem.instruction.arg = t1Name;
      deleteRealInsn(codeItems, jl.loadIdx);
    }

    if (opts.verbose) {
      const folded = jumpLoads.length;
      console.log(`  [coalesce] ${opts.owner}.${opts.name}${opts.desc}: ${folded}x[load(${loadKey}); goto ${t2Name}]; ${t1Name}: load — folded into goto ${t1Name}`);
    }
    return jumpLoads.length; // fold all jump-predecessors of this T2 in one pass
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSafeLoad(instruction, opts) {
  const op = getOp(instruction);
  if (!op) return false;
  // Local-variable loads (parameterized form). Operand is the slot index.
  if (LOCAL_LOAD_OPS.has(op)) return true;
  // Numbered local loads. aload_0 is gated on the method having no
  // astore_0 (slot 0 is never reassigned).
  if (NUMBERED_LOAD_OPS.has(op)) {
    if (op === 'aload_0' && !(opts && opts.allowAload0)) return false;
    return true;
  }
  // Constant pushes (nullary).
  if (CONST_NULLARY_OPS.has(op)) return true;
  // Constant pushes with literal byte/short operand.
  if (CONST_INT_LITERAL_OPS.has(op)) return true;
  // ldc family: operand is a constant-pool reference.
  if (LDC_OPS.has(op)) return true;
  // Static-field reads. Instance getfield is excluded — its objectref is
  // stack-supplied and the preheader rewrite cannot preserve it.
  if (STATIC_FIELD_OPS.has(op)) return true;
  return false;
}

// Return a normalized string key uniquely identifying a preheader load.
// Two loads coalesce iff their keys are equal. Covers every variant of
// `isSafeLoad` above; returns null for instructions that aren't safe loads
// or that have an unrecognized AST shape.
function loadKeyOf(instruction) {
  const op = getOp(instruction);
  if (!op) return null;
  // Numbered local loads: opcode is the full identity (operand baked in).
  if (NUMBERED_LOAD_OPS.has(op)) return op;
  // Constant nullary pushes: opcode is the full identity.
  if (CONST_NULLARY_OPS.has(op)) return op;
  // Local loads with separate operand (slot index).
  if (LOCAL_LOAD_OPS.has(op)) {
    const arg = getArg(instruction);
    if (arg === undefined || arg === null) return null;
    return op + ':' + String(arg);
  }
  // bipush <byte> / sipush <short>: operand is a numeric literal.
  if (CONST_INT_LITERAL_OPS.has(op)) {
    const arg = getArg(instruction);
    if (arg === undefined || arg === null) return null;
    return op + ':' + String(arg);
  }
  // ldc / ldc_w / ldc2_w: operand is a resolved constant value or a typed
  // wrapper. Identity is the opcode plus a stable serialization of the
  // resolved constant. Two ldc instructions are equal iff the serializations
  // match (which means the constant pool entries they reference are equal).
  if (LDC_OPS.has(op)) {
    const arg = getArg(instruction);
    if (arg === undefined) return null;
    return op + ':' + serializeConstantArg(arg);
  }
  // getstatic: operand is a FieldRef. Identity is opcode + owner.name:desc.
  if (STATIC_FIELD_OPS.has(op)) {
    const arg = getArg(instruction);
    const fk = fieldRefKey(arg);
    if (!fk) return null;
    return op + ':' + fk;
  }
  return null;
}

// Serialize an ldc operand to a stable string. The convert_tree pipeline
// gives us:
//   - String constants  -> a JS string (the literal value)
//   - Integer constants -> a JS number
//   - Long constants    -> a JS string (decimal)
//   - Float / Double    -> { value, type: 'Float'|'Double' }
//   - Class references  -> ['Class', 'java/lang/String']
// We tag each variant explicitly so cross-type collisions are impossible
// (e.g. the string "5" must not equal the integer 5).
function serializeConstantArg(arg) {
  if (arg === null) return 'null';
  if (typeof arg === 'string') return 'S:' + JSON.stringify(arg);
  if (typeof arg === 'number') return 'N:' + String(arg);
  if (typeof arg === 'boolean') return 'B:' + String(arg);
  if (Array.isArray(arg)) {
    // ['Class', name] form.
    if (arg.length === 2 && arg[0] === 'Class' && typeof arg[1] === 'string') {
      return 'C:' + arg[1];
    }
    return 'A:' + JSON.stringify(arg);
  }
  if (typeof arg === 'object') {
    if (arg.type === 'Float' || arg.type === 'Double') {
      return arg.type[0] + ':' + String(arg.value);
    }
    return 'O:' + JSON.stringify(arg);
  }
  return 'X:' + String(arg);
}

// Serialize a FieldRef AST to a stable owner.name:desc string. The AST
// shape from convert_tree is ['Field', owner, [name, desc]]. Some other
// codepaths represent it as a flat string ("Field Owner name desc") —
// support both forms but require all three components.
function fieldRefKey(arg) {
  if (Array.isArray(arg)) {
    if (arg.length >= 3 && arg[0] === 'Field' && typeof arg[1] === 'string' && Array.isArray(arg[2]) && arg[2].length >= 2) {
      const owner = arg[1];
      const name = arg[2][0];
      const desc = arg[2][1];
      if (typeof name !== 'string' || typeof desc !== 'string') return null;
      return owner + '.' + name + ':' + desc;
    }
    return null;
  }
  if (typeof arg === 'string') {
    // "Field Owner name desc" — split into 4 whitespace-delimited tokens.
    const parts = arg.trim().split(/\s+/);
    if (parts.length === 4 && parts[0] === 'Field') {
      return parts[1] + '.' + parts[2] + ':' + parts[3];
    }
    return null;
  }
  return null;
}

// Return true if the method body contains no astore_0 (parameterized
// `astore 0` or numbered `astore_0`). When false, aload_0 candidates in
// this method are uniformly refused — slot 0 may have been reassigned to
// something other than `this`.
function methodAllowsAload0(codeItems) {
  for (const it of codeItems) {
    if (!it || !it.instruction) continue;
    const op = getOp(it.instruction);
    if (!op) continue;
    if (ASTORE_0_OPS.has(op)) return false;
    if (op === 'astore') {
      const arg = getArg(it.instruction);
      if (arg !== undefined && arg !== null && String(arg) === '0') return false;
    }
  }
  return true;
}

function findPrevRealInsn(codeItems, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    const it = codeItems[i];
    if (!it) continue;
    if (it.instruction) return { item: it, idx: i };
    if (it.labelDef) return null; // labelDef boundary — preheader's LOAD must be on the same block as the goto
  }
  return null;
}

function findFirstLabelDefAfter(codeItems, idx) {
  for (let i = idx + 1; i < codeItems.length; i++) {
    const it = codeItems[i];
    if (it && it.labelDef) return { idx: i, label: trimLabel(it.labelDef) };
  }
  return null;
}

// Walk backward from `idx` (exclusive); return the nearest labelDef whose
// path back from `idx` traverses only aux/labelDef items (no real
// instructions). Used to identify the labelDef that immediately precedes
// a real instruction within a single basic block. Note: the codeItem at
// `idx` itself is NOT inspected — callers pass the idx of the real
// instruction whose preceding labelDef they want.
function findPrevLabelDefImmediately(codeItems, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    const it = codeItems[i];
    if (!it) continue;
    if (it.instruction) return null; // real insn intervenes; not "immediately preceding"
    if (it.labelDef) return { idx: i, label: trimLabel(it.labelDef) };
  }
  return null;
}

// Collect every label that resolves to the address of the real
// instruction at `loadIdx`. The chain comprises (in earliest-first
// order): any aux/labelDef-only items immediately preceding loadIdx,
// PLUS the labelDef on loadIdx itself if it has one. Returns an array
// of { idx, label }. The first entry is the EARLIEST alias (the block's
// leading boundary), the last entry is the labelDef on loadIdx (if any).
function collectT1Aliases(codeItems, loadIdx) {
  const out = [];
  // Walk backward from loadIdx-1 across labelDef-only items. Stop at
  // any real instruction (boundary of the previous block) or method start.
  for (let i = loadIdx - 1; i >= 0; i--) {
    const it = codeItems[i];
    if (!it) continue;
    if (it.instruction) break;
    if (it.labelDef) out.unshift({ idx: i, label: trimLabel(it.labelDef) });
  }
  // Then include the label on the load's own codeItem if present.
  const here = codeItems[loadIdx];
  if (here && here.labelDef) out.push({ idx: loadIdx, label: trimLabel(here.labelDef) });
  return out;
}

function findNextRealInsnFrom(codeItems, idx) {
  // Skip the labelDef item itself and any aux items, return first instruction.
  for (let i = idx; i < codeItems.length; i++) {
    const it = codeItems[i];
    if (!it) continue;
    if (it.instruction) return { item: it, idx: i };
    // labelDef without instruction is fine; alias label chain.
    // Continue scanning.
  }
  return null;
}

function anyRealInsnBetween(codeItems, fromIdxExclusive, toIdxExclusive) {
  for (let i = fromIdxExclusive + 1; i < toIdxExclusive; i++) {
    const it = codeItems[i];
    if (!it) continue;
    if (it.instruction) return true;
  }
  return false;
}

function hasFallthroughPredecessor(codeItems, labelIdx) {
  // The label sits at codeItems[labelIdx]. Walk back through aux items
  // and prior labelDefs (alias chain) until we hit a real instruction
  // or method start.
  for (let i = labelIdx - 1; i >= 0; i--) {
    const it = codeItems[i];
    if (!it) continue;
    if (it.instruction) {
      const op = getOp(it.instruction);
      if (op === 'goto' || op === 'jsr') return false;
      if (TERMINAL_OPCODES.has(op)) return false;
      if (op === 'tableswitch' || op === 'lookupswitch') return false;
      return true;
    }
    // labelDef or aux: keep walking.
  }
  return false;
}

function collectJumpsToLabel(codeItems, label) {
  const trimmed = trimLabel(label);
  const out = [];
  for (let i = 0; i < codeItems.length; i++) {
    const it = codeItems[i];
    if (!it || !it.instruction) continue;
    const op = getOp(it.instruction);
    if (!op) continue;
    const targets = jumpTargetsOf(it.instruction, op);
    if (targets.some((t) => trimLabel(t) === trimmed)) out.push({ item: it, idx: i });
  }
  return out;
}

function jumpTargetsOf(instruction, op) {
  if (!op || !instruction) return [];
  if (op === 'tableswitch') {
    const targets = Array.isArray(instruction.labels) ? [...instruction.labels] : [];
    if (instruction.defaultLbl) targets.push(instruction.defaultLbl);
    return targets;
  }
  if (op === 'lookupswitch') {
    const out = [];
    const arg = instruction.arg;
    if (arg) {
      if (Array.isArray(arg.pairs)) {
        for (const pair of arg.pairs) {
          if (Array.isArray(pair) && pair[1]) out.push(pair[1]);
        }
      }
      if (arg.defaultLabel) out.push(arg.defaultLabel);
    }
    return out;
  }
  if (typeof instruction === 'object' && typeof instruction.arg === 'string') {
    if (op === 'goto' || op === 'jsr' || CONDITIONAL_JUMPS.has(op)) return [instruction.arg];
  }
  return [];
}

function collectProtectedLabels(exceptionTable) {
  const set = new Set();
  for (const e of exceptionTable || []) {
    for (const key of ['startLbl', 'startLabel', 'start',
                       'endLbl', 'endLabel', 'end',
                       'handlerLbl', 'handlerLabel', 'handler', 'usingLbl']) {
      const v = e[key];
      if (typeof v === 'string') set.add(trimLabel(v));
    }
  }
  return set;
}

function deleteRealInsn(codeItems, idx) {
  const it = codeItems[idx];
  if (!it) return;
  if (it.labelDef || it.stackMapFrame) {
    // Preserve the label/frame; just drop the instruction.
    delete it.instruction;
    delete it.pc;
  } else {
    codeItems.splice(idx, 1);
  }
}

function getOp(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return instruction;
  return instruction.op || null;
}

function getArg(instruction) {
  return instruction && typeof instruction === 'object' ? instruction.arg : null;
}

function trimLabel(label) {
  if (typeof label !== 'string') return label;
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

module.exports = {
  runCoalesceLoopLoad,
};
