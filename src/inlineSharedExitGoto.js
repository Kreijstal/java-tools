'use strict';

/**
 * inlineSharedExitGoto — tail-duplicate the body of a shared exit/merge
 * target at goto-sites reached as the fallthrough of a conditional jump.
 *
 * Pattern (in source order):
 *
 *   COND_JUMP T_THEN              ; conditional jump (ifeq, ifne, if_icmp*, ifnull, ...)
 *   GOTO T_TARGET                 ; the unconditional fallthrough that we will replace
 *   T_THEN: ...                   ; the conditional's then-target
 *   ...
 *   T_TARGET (possibly via goto chain): <body>
 *
 * Where the resolved T_TARGET is a label whose block:
 *   - has at least 2 forward predecessors (= a real join);
 *   - has a short body (≤ maxBodyInsns) ending in a terminator
 *     (goto / return / throw); no conditionals inside the body;
 *   - is not a handler entry or exception-range marker;
 *   - is not the same label as the COND_JUMP's then-target.
 *
 * Rewrite: replace the unconditional `GOTO T_TARGET` with an inlined,
 * label-renamed copy of T_TARGET's body. Other predecessors of T_TARGET
 * are unchanged. Net effect: the join at T_TARGET loses one forward
 * predecessor, which is often enough to let CFR re-structure the
 * surrounding loop nest.
 *
 * Empirically this pattern is what JAVAC produces for typical pre-loop
 * early-exits (e.g. "if (x > 0) { while (y != 0) { ... } } // exit")
 * and OR-shortcut chains ("if (a || b) { ... } else { merge_body; }").
 * The obfuscator/optimizer collapsed those inlines into shared
 * `goto SHARED_EXIT` chains, which CFR can't structure cleanly. Putting
 * the inline back targets exactly the missing shape.
 *
 * Returns { changed, fired } where `fired` is the number of inlined sites.
 */

const CONDITIONAL_JUMPS = new Set([
  'ifeq', 'ifne', 'iflt', 'ifge', 'ifgt', 'ifle',
  'if_icmpeq', 'if_icmpne', 'if_icmplt', 'if_icmpge', 'if_icmpgt', 'if_icmple',
  'if_acmpeq', 'if_acmpne',
  'ifnull', 'ifnonnull',
]);

const TERMINAL_OPCODES = new Set([
  'ret', 'return', 'ireturn', 'lreturn', 'freturn', 'dreturn', 'areturn', 'athrow',
]);

const ALL_JUMP_OPS = new Set([
  ...CONDITIONAL_JUMPS,
  'goto', 'goto_w', 'jsr', 'jsr_w', 'tableswitch', 'lookupswitch',
]);

function runInlineSharedExitGoto(astRoot, options = {}) {
  const maxBodyInsns = Math.max(1, options.maxBodyInsns || 20);
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
        const fired = inlineOneMethod(codeItems, exceptionTable, {
          maxBodyInsns, verbose,
          owner: classItem.className,
          name: item.method.name,
          desc: item.method.descriptor,
        });
        totalFired += fired;
      }
    }
  }
  return { changed: totalFired > 0, fired: totalFired };
}

function inlineOneMethod(codeItems, exceptionTable, opts) {
  const protectedLabels = collectProtectedLabels(exceptionTable);
  let fired = 0;
  const oncePerMethod = opts.oncePerMethod !== false;

  // Snapshot candidate sites: each is an unconditional goto whose
  // immediate predecessor (in source order) is a conditional jump.
  // Walk descending so splices don't invalidate later indices.
  const sites = [];
  for (let i = 0; i < codeItems.length; i++) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    if (getOp(item.instruction) !== 'goto') continue;
    if (typeof item.instruction.arg !== 'string') continue;
    const prev = findPrevRealInsn(codeItems, i);
    if (!prev) continue;
    if (!CONDITIONAL_JUMPS.has(getOp(prev.item.instruction))) continue;
    sites.push({ idx: i, item });
  }
  // Process in descending order so splices preserve earlier indices.
  sites.sort((a, b) => b.idx - a.idx);

  for (const site of sites) {
    // Re-resolve the index in case a previous splice moved it.
    const gotoIdx = codeItems.indexOf(site.item);
    if (gotoIdx < 0) continue;
    const gotoArg = trimLabel(site.item.instruction.arg);
    if (!gotoArg) continue;

    // Resolve goto chains: walk through bare `LBL: goto OTHER` blocks
    // until we hit the real body. Cap depth to avoid pathological loops.
    const finalLabel = resolveGotoChain(codeItems, gotoArg, /*maxHops=*/ 8);
    if (!finalLabel) continue;
    if (protectedLabels.has(finalLabel)) continue;

    const targetIdx = findLabelIndex(codeItems, finalLabel);
    if (targetIdx < 0) continue;

    // Skip when conditional's then-target is the same as the resolved
    // goto target — there's no structural join to break.
    const prev = findPrevRealInsn(codeItems, gotoIdx);
    if (!prev) continue;
    const condTargets = getJumpTargets(prev.item.instruction);
    if (condTargets.some((t) => trimLabel(t) === finalLabel)) continue;

    // Require at least `minPreds` forward predecessors at the resolved
    // label. Empirically the helpful shape needs ≥4 (td and lk both fit
    // this floor; lower thresholds fire on benign multi-pred joins).
    const preds = collectForwardPredecessors(codeItems, finalLabel, targetIdx);
    const minPreds = Math.max(2, opts.minPreds || 4);
    if (preds.totalForward < minPreds) continue;

    // Targeted gate: inlining only helps the structurer when the goto
    // target ALSO has a predecessor reachable from inside the
    // conditional's then-target body. That's the "forward shortcut into
    // a shared join" shape — a join in the middle of a nested
    // structure. Without this gate the pass over-fires on benign
    // multi-pred joins and inflates marker counts elsewhere.
    const condThenLabel = condTargets.length === 1 ? trimLabel(condTargets[0]) : null;
    if (!condThenLabel) continue;
    const condThenIdx = findLabelIndex(codeItems, condThenLabel);
    if (condThenIdx < 0) continue;
    const hasInnerPred = hasPredecessorAtOrAfter(codeItems, finalLabel, condThenIdx, targetIdx);
    if (!hasInnerPred) continue;

    // Extract the body. Refuse conditionals/switches inside (unless their
    // targets are local to the body), cap length, require a terminator.
    const body = extractTerminatorBody(codeItems, targetIdx, opts.maxBodyInsns);
    if (!body) continue;
    const minBodyInsns = Math.max(1, opts.minBodyInsns || 5);
    if (body.realCount < minBodyInsns) continue;

    // Build the inlined replacement: clone body with renamed internal
    // labels (so we don't collide with the originals).
    const cloneItems = cloneBodyItems(body, opts.owner, opts.name);

    // Replace the original goto with the inlined body in-place.
    codeItems.splice(gotoIdx, 1, ...cloneItems);
    fired += 1;
    if (oncePerMethod) {
      if (opts.verbose) {
        const lastOp = (() => {
          for (let i = cloneItems.length - 1; i >= 0; i--) {
            const it = cloneItems[i];
            if (it && it.instruction) return getOp(it.instruction);
          }
          return '?';
        })();
        console.log(
          `  [inline-exit] ${opts.owner}.${opts.name}${opts.desc}: ` +
          `goto ${gotoArg} (→${finalLabel}) inlined as ${cloneItems.length}-item body ` +
          `(target had ${preds.totalForward} fwd preds, lastOp=${lastOp})`
        );
      }
      return fired;
    }

    if (opts.verbose) {
      const lastOp = (() => {
        for (let i = cloneItems.length - 1; i >= 0; i--) {
          const it = cloneItems[i];
          if (it && it.instruction) return getOp(it.instruction);
        }
        return '?';
      })();
      console.log(
        `  [inline-exit] ${opts.owner}.${opts.name}${opts.desc}: ` +
        `goto ${gotoArg} (→${finalLabel}) inlined as ${cloneItems.length}-item body ` +
        `(target had ${preds.totalForward} fwd preds, lastOp=${lastOp})`
      );
    }
  }

  return fired;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveGotoChain(codeItems, label, maxHops) {
  let current = label;
  const visited = new Set();
  for (let hop = 0; hop < maxHops; hop++) {
    if (visited.has(current)) return null; // cycle guard
    visited.add(current);
    const idx = findLabelIndex(codeItems, current);
    if (idx < 0) return null;
    // First real instruction at the label.
    const first = findNextRealInsn(codeItems, idx);
    if (!first) return current;
    if (getOp(first.item.instruction) !== 'goto') return current;
    if (typeof first.item.instruction.arg !== 'string') return current;
    // Make sure no other label-defs sit between the labelDef and the first goto:
    // we want a "pure goto bridge" — the label's body is exactly one goto.
    const between = countRealInsnsBetween(codeItems, idx, first.idx);
    if (between !== 0) return current;
    current = trimLabel(first.item.instruction.arg);
  }
  return current;
}

/**
 * True iff `label` has any jump predecessor whose source instruction sits in
 * the half-open range [loIdx, hiIdx). Used to detect "shared join inside the
 * conditional's then-body" — i.e. the goto target is also reached by an
 * internal forward jump from inside the conditional's then-target body.
 */
function hasPredecessorAtOrAfter(codeItems, label, loIdx, hiIdx) {
  const target = trimLabel(label);
  for (let i = loIdx; i < hiIdx; i++) {
    const it = codeItems[i];
    if (!it || !it.instruction) continue;
    const targets = getJumpTargets(it.instruction);
    if (targets.some((t) => trimLabel(t) === target)) return true;
  }
  return false;
}

function collectForwardPredecessors(codeItems, label, targetIdx) {
  let totalForward = 0;
  for (let i = 0; i < targetIdx; i++) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const targets = getJumpTargets(item.instruction);
    if (targets.some((t) => trimLabel(t) === label)) totalForward += 1;
  }
  // Also count fallthrough predecessor (instruction immediately before the label
  // that is NOT a terminator/goto).
  for (let i = targetIdx - 1; i >= 0; i--) {
    const item = codeItems[i];
    if (!item) continue;
    if (item.instruction) {
      const op = getOp(item.instruction);
      if (op !== 'goto' && op !== 'jsr' && !TERMINAL_OPCODES.has(op) && op !== 'tableswitch' && op !== 'lookupswitch') {
        totalForward += 1;
      }
      break;
    }
  }
  return { totalForward };
}

function extractTerminatorBody(codeItems, startIdx, maxInsns) {
  const startItem = codeItems[startIdx];
  if (!startItem || !startItem.labelDef) return null;
  const body = [];
  let realCount = 0;
  // Track labelDefs we've seen inside the body — used to validate that
  // any conditional jumps inside the body target a label that's already
  // in the body or further inside it (so the clone is self-contained).
  const internalLabels = new Set();
  internalLabels.add(trimLabel(startItem.labelDef));

  // Pending conditional-jump targets that must show up as labelDefs
  // before the body terminates.
  const pendingTargets = new Set();

  function consumeInsn(it) {
    const op = getOp(it.instruction);
    if (op === 'jsr' || op === 'tableswitch' || op === 'lookupswitch') return 'reject';
    if (CONDITIONAL_JUMPS.has(op)) {
      const arg = it.instruction.arg;
      if (typeof arg !== 'string') return 'reject';
      // Only accept conditional jumps whose target is a label we'll
      // see later in the body (forward jumps inside the body).
      pendingTargets.add(trimLabel(arg));
    }
    body.push(it.instruction === startItem.instruction ? { instruction: it.instruction } : it);
    realCount++;
    if (realCount > maxInsns) return 'reject';
    if (TERMINAL_OPCODES.has(op) || op === 'goto') {
      // Body ends at a terminator. All pending conditional targets must
      // have been resolved by labelDefs we passed through.
      for (const t of pendingTargets) {
        if (!internalLabels.has(t)) return 'reject';
      }
      return 'done';
    }
    return 'continue';
  }

  // Krakatau combines labelDef + first instruction on a single item.
  if (startItem.instruction) {
    const r = consumeInsn(startItem);
    if (r === 'reject') return null;
    if (r === 'done') return { realCount, items: body };
  }
  for (let i = startIdx + 1; i < codeItems.length; i++) {
    const it = codeItems[i];
    if (!it) continue;
    if (it.labelDef) {
      internalLabels.add(trimLabel(it.labelDef));
      // Always include labelDefs in the body so cloneBodyItems can rename them.
      body.push({ labelDef: it.labelDef });
    }
    if (it.instruction) {
      const r = consumeInsn(it);
      if (r === 'reject') return null;
      if (r === 'done') return { realCount, items: body };
    }
  }
  return null;
}

let _cloneSerial = 0;
function cloneBodyItems(body, owner, name) {
  _cloneSerial++;
  const tag = `_inlex_${_cloneSerial}`;
  // Find any internal labelDefs in the body and rename them so the
  // clone doesn't reuse the original names.
  const internalLabels = new Set();
  for (const it of body.items) {
    if (it && it.labelDef) internalLabels.add(trimLabel(it.labelDef));
  }
  const renameMap = new Map();
  for (const lbl of internalLabels) renameMap.set(lbl, `${tag}_${lbl}`);

  const out = [];
  for (const it of body.items) {
    if (!it) continue;
    // Item may carry both labelDef and instruction (Krakatau combined
    // form). Emit a standalone labelDef and a separate instruction so the
    // clone doesn't accidentally fuse references.
    if (it.labelDef) {
      const orig = trimLabel(it.labelDef);
      out.push({ labelDef: `${renameMap.get(orig)}:` });
    }
    if (it.instruction) {
      const cloned = JSON.parse(JSON.stringify(it));
      delete cloned.labelDef;
      remapInstructionLabels(cloned.instruction, renameMap);
      out.push(cloned);
    }
  }
  return out;
}

function remapInstructionLabels(instruction, renameMap) {
  if (!instruction || typeof instruction !== 'object') return;
  if (typeof instruction.arg === 'string' && renameMap.has(instruction.arg)) {
    instruction.arg = renameMap.get(instruction.arg);
  }
  if (Array.isArray(instruction.arg)) {
    for (let i = 0; i < instruction.arg.length; i++) {
      const v = instruction.arg[i];
      if (typeof v === 'string' && renameMap.has(v)) {
        instruction.arg[i] = renameMap.get(v);
      }
    }
  }
}

function findPrevRealInsn(codeItems, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    const it = codeItems[i];
    if (!it) continue;
    if (it.instruction) return { item: it, idx: i };
  }
  return null;
}

function findNextRealInsn(codeItems, idx) {
  for (let i = idx; i < codeItems.length; i++) {
    const it = codeItems[i];
    if (!it) continue;
    if (it.instruction) return { item: it, idx: i };
  }
  return null;
}

function countRealInsnsBetween(codeItems, lo, hi) {
  let n = 0;
  for (let i = lo + 1; i < hi; i++) {
    const it = codeItems[i];
    if (it && it.instruction) n += 1;
  }
  return n;
}

function findLabelIndex(codeItems, label) {
  const target = trimLabel(label);
  for (let i = 0; i < codeItems.length; i++) {
    const it = codeItems[i];
    if (it && it.labelDef && trimLabel(it.labelDef) === target) return i;
  }
  return -1;
}

function getJumpTargets(instruction) {
  if (!instruction) return [];
  const op = getOp(instruction);
  if (!ALL_JUMP_OPS.has(op)) return [];
  const arg = instruction.arg;
  if (typeof arg === 'string') return [arg];
  if (Array.isArray(arg)) {
    const out = [];
    for (const v of arg) if (typeof v === 'string') out.push(v);
    return out;
  }
  if (arg && typeof arg === 'object') {
    const out = [];
    if (typeof arg.default === 'string') out.push(arg.default);
    if (Array.isArray(arg.cases)) {
      for (const c of arg.cases) if (typeof c.label === 'string') out.push(c.label);
    }
    if (Array.isArray(arg.entries)) {
      for (const e of arg.entries) if (typeof e.label === 'string') out.push(e.label);
    }
    return out;
  }
  return [];
}

function getOp(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return instruction;
  return instruction.op || null;
}

function trimLabel(label) {
  if (typeof label !== 'string') return label;
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

function collectProtectedLabels(exceptionTable) {
  const set = new Set();
  for (const e of exceptionTable || []) {
    for (const k of ['handlerLbl', 'handlerLabel', 'handler', 'usingLbl',
                     'startLbl', 'startLabel', 'start',
                     'endLbl', 'endLabel', 'end']) {
      const v = e[k];
      if (typeof v === 'string') set.add(trimLabel(v));
    }
  }
  return set;
}

module.exports = { runInlineSharedExitGoto };
