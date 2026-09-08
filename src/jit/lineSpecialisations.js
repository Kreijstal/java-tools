'use strict';

// Specialisations applied to already-rendered statement lines.
//
// Each one recognises a shape in the emitted lines -- a counted loop, a
// post-decrement loop, a non-zero branch, a deferred static array access, an
// acyclic checked leaf, a terminal break, a straight-line scope group -- and
// rewrites or annotates it, recording what it did in `stats`.
//
// These could not be moved out of compileMethodBody while they incremented bare
// `let` counters in its scope: the counters were part of the closure, so the
// helpers were welded to it. With the counters held in one `stats` record the
// dependency becomes an ordinary argument, and the whole family takes an
// explicit context instead of an implicit scope.
//
// `stats` is mutated here by design. It is created once per compileMethodBody
// call, written by these helpers and by the renderer, and read back by the
// caller as compile metadata; nothing else aliases it.
const { renderParts } = require('./statementParts');

function createLineSpecialisations({
  blockEnd,
  blockStart,
  countedLoopInfos,
  deferredStaticArrayAccessByMarker,
  indent,
  indentationOf,
  leafBailStatement,
  localName,
  operand,
  ownSsaValueNames,
  provenDeferredStaticArrayAccesses,
  recordOf,
  stats,
  e,
}) {
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
          stats.eliminatedTerminalStructuredBreakCount += 1;
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
          stats.dominatedArithmeticGuardCount += 1;
          index = close - 1;
        }
        return output;
      };

  const groupStraightScopes = (children, renderedChildren, isEntryChild) => {
        const declaredIn = renderedChildren.map((lines) => {
          const names = new Set();
          let unsafe = false;
          for (const line of lines) {
            if (line.trim() === "") continue;
            const record = recordOf(line);
            if (!record) { unsafe = true; break; }
            if (record.def) names.add(record.def);
            if (record.opens === "function" ||
                /HelperHeader$/.test(record.kind || "")) unsafe = true;
          }
          return {names, unsafe};
        });
        // References are found in the rendered text (a name a template wrote
        // as literal text is a reference too), so a name mentioned anywhere in
        // a later sibling keeps its declaring block open: conservative, and
        // independent of how faithfully a statement recorded its operands.
        const textOf = renderedChildren.map((lines) => lines.join("\n"));
        const mentions = (later, names) => {
          if (names.size === 0) return false;
          const pattern = new RegExp(`\\b(?:${[...names].join("|")})\\b`);
          return pattern.test(textOf[later]);
        };
        const output = [];
        let index = 0;
        while (index < children.length) {
          if (children[index].t !== "straight" || declaredIn[index].unsafe ||
              declaredIn[index].names.size === 0 || isEntryChild(index)) {
            output.push(renderedChildren[index]);
            index += 1;
            continue;
          }
          let end = index;
          const declared = new Set(declaredIn[index].names);
          let ok = true;
          for (;;) {
            let conflict = -1;
            for (let later = end + 1; later < children.length; later += 1) {
              if (mentions(later, declared)) { conflict = later; break; }
            }
            if (conflict < 0) break;
            // A loop keeps its own place: the passes that version a loop read
            // the declarations before its header at the header's own depth.
            for (let member = end + 1; member <= conflict; member += 1) {
              if (isEntryChild(member) || declaredIn[member].unsafe ||
                  children[member].t === "loop") ok = false;
            }
            if (!ok) break;
            for (let member = end + 1; member <= conflict; member += 1) {
              for (const name of declaredIn[member].names) declared.add(name);
            }
            end = conflict;
          }
          if (!ok) {
            output.push(renderedChildren[index]);
            index += 1;
            continue;
          }
          // Stay aligned with `children`: the group sits at its first
          // child's index and the merged followers contribute nothing.
          output.push([blockStart(""),
            ...indent(renderedChildren.slice(index, end + 1).flat()),
            blockEnd("")]);
          for (let member = index + 1; member <= end; member += 1) output.push([]);
          index = end + 1;
        }
        return output;
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

  return {
    canonicalCountedLoop,
    canonicalPostDecrementLoop,
    specializeDeferredStaticArrayAccessLines,
    removeTerminalBreakTo,
    specializeNonZeroBranch,
    groupStraightScopes,
    transactionalizeAcyclicLeafLines,
  };
}

module.exports = { createLineSpecialisations };
