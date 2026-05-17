'use strict';

const { removeTrivialRethrowHandlers } = require('./removeTrivialRethrowHandlers');
const { analyzeRegion } = require('../analysis/regionSafety');

let clonePrefixCounter = 0;

function runPeepholeClean(astRoot, options = {}) {
  let changes = 0;
  const details = {
    rethrowHandlers: 0,
    nops: 0,
    threadedBranches: 0,
    protectedLoadBridges: 0,
    loopProducerBridges: 0,
    duplicateLoopTails: 0,
    forwardLoopEntryClones: 0,
    conditionalForwardLoopEntryClones: 0,
    conditionalForwardTailClones: 0,
    sharedFallthroughBlockClones: 0,
    invertedFallthroughGotos: 0,
    fallthroughGotos: 0,
    unreachableInstructions: 0,
    unusedLabels: 0,
  };

  if (options.removeRethrowHandlers !== false) {
    const rethrow = removeTrivialRethrowHandlers(astRoot, {
      removeHandlerCode: options.removeHandlerCode !== false,
    });
    if (rethrow.changed) {
      details.rethrowHandlers = rethrow.removals.length;
      changes += rethrow.removals.length;
    }
  }

  for (let i = 0; i < 4; i += 1) {
    const round = cleanOneRound(astRoot, {
      removeUnreachableCode: options.removeHandlerCode !== false,
      cloneForwardTails: options.cloneForwardTails === true,
      invertConditionalsOverGoto: options.invertConditionalsOverGoto === true,
      invertConditionalsOverGotoClasses: new Set(options.invertConditionalsOverGotoClasses || []),
    });
    details.nops += round.nops;
    details.threadedBranches += round.threadedBranches;
    details.protectedLoadBridges += round.protectedLoadBridges;
    details.loopProducerBridges += round.loopProducerBridges;
    details.duplicateLoopTails += round.duplicateLoopTails;
    details.forwardLoopEntryClones += round.forwardLoopEntryClones;
    details.conditionalForwardLoopEntryClones += round.conditionalForwardLoopEntryClones;
    details.conditionalForwardTailClones += round.conditionalForwardTailClones;
    details.sharedFallthroughBlockClones += round.sharedFallthroughBlockClones;
    details.invertedFallthroughGotos += round.invertedFallthroughGotos;
    details.fallthroughGotos += round.fallthroughGotos;
    details.unreachableInstructions += round.unreachableInstructions;
    details.unusedLabels += round.unusedLabels;
    changes += round.nops + round.threadedBranches + round.protectedLoadBridges + round.loopProducerBridges +
      round.duplicateLoopTails + round.forwardLoopEntryClones + round.conditionalForwardLoopEntryClones +
      round.conditionalForwardTailClones + round.sharedFallthroughBlockClones +
      round.invertedFallthroughGotos + round.fallthroughGotos +
      round.unreachableInstructions + round.unusedLabels;
    if (
      round.nops + round.threadedBranches + round.protectedLoadBridges + round.loopProducerBridges +
      round.duplicateLoopTails + round.forwardLoopEntryClones + round.conditionalForwardLoopEntryClones +
      round.conditionalForwardTailClones + round.sharedFallthroughBlockClones +
      round.invertedFallthroughGotos + round.fallthroughGotos +
      round.unreachableInstructions + round.unusedLabels === 0
    ) {
      break;
    }
  }

  return { changed: changes > 0, changes, details };
}

function cleanOneRound(astRoot, options = {}) {
  const details = {
    nops: 0,
    threadedBranches: 0,
    protectedLoadBridges: 0,
    loopProducerBridges: 0,
    duplicateLoopTails: 0,
    forwardLoopEntryClones: 0,
    conditionalForwardLoopEntryClones: 0,
    conditionalForwardTailClones: 0,
    sharedFallthroughBlockClones: 0,
    invertedFallthroughGotos: 0,
    fallthroughGotos: 0,
    unreachableInstructions: 0,
    unusedLabels: 0,
  };
  forEachCode(astRoot, (code, method, classItem) => {
    details.nops += removeNops(code.codeItems);
    details.threadedBranches += threadBranchesThroughGoto(code.codeItems);
    details.protectedLoadBridges += coalesceProtectedLoadBridges(code);
    details.loopProducerBridges += coalesceLoopProducerBridges(code);
    details.duplicateLoopTails += coalesceDuplicateLoopTails(code);
    details.forwardLoopEntryClones += cloneForwardLoopEntryGotos(code);
    details.conditionalForwardLoopEntryClones += cloneConditionalForwardLoopEntry(code);
    if (options.cloneForwardTails) {
      details.conditionalForwardTailClones += cloneConditionalForwardTailEntry(code);
      details.sharedFallthroughBlockClones += cloneSharedFallthroughBlocks(code);
    }
    const classAllowed = options.invertConditionalsOverGotoClasses.size === 0 ||
      options.invertConditionalsOverGotoClasses.has(classItem && classItem.className);
    if ((method && method.name === '<init>') ||
      (options.invertConditionalsOverGoto && classAllowed && (!method || method.name !== '<clinit>'))) {
      details.invertedFallthroughGotos += invertConditionalOverGoto(code);
    }
    if (method && method.name === '<init>') {
      details.unreachableInstructions += removeUnreachableUntilUsedLabel(code);
    }
    details.fallthroughGotos += removeSingleUseFallthroughGotos(code);
    if (options.removeUnreachableCode !== false) {
      details.unreachableInstructions += removeUnreachableAfterTerminal(code);
    }
    details.unusedLabels += removeUnusedLabels(code);
  });
  return details;
}

function forEachCode(astRoot, fn) {
  for (const classItem of astRoot.classes || []) {
    for (const item of classItem.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attr of item.method.attributes || []) {
        if (attr && attr.type === 'code' && attr.code && Array.isArray(attr.code.codeItems)) {
          fn(attr.code, item.method, classItem);
        }
      }
    }
  }
}

function removeNops(codeItems) {
  let removed = 0;
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || getOpcode(item.instruction) !== 'nop') continue;
    removeInstructionOnly(codeItems, i);
    removed += 1;
    if (!codeItems[i] || !codeItems[i].instruction) {
      i -= 1;
    }
  }
  return removed;
}

function threadBranchesThroughGoto(codeItems) {
  let changed = 0;
  const labelIndex = buildLabelIndex(codeItems);
  for (const item of codeItems) {
    if (!item || !item.instruction || !isConditionalBranch(getOpcode(item.instruction))) continue;
    const target = trimLabel(getInstructionArg(item.instruction));
    if (!target) continue;
    if (countInstructionLabelReferences(codeItems, target) !== 1) continue;
    if (hasFallthroughPredecessor(codeItems, labelIndex, target)) continue;
    const bridge = firstInstructionAtLabel(codeItems, labelIndex, target);
    if (!bridge || getOpcode(bridge.instruction) !== 'goto') continue;
    const nextTarget = trimLabel(getInstructionArg(bridge.instruction));
    if (!nextTarget || nextTarget === target) continue;
    item.instruction = setInstructionArg(item.instruction, nextTarget);
    changed += 1;
  }
  return changed;
}

function coalesceProtectedLoadBridges(code) {
  const codeItems = code.codeItems;
  const labelIndex = buildLabelIndex(codeItems);
  const protectedStarts = collectProtectedStarts(code);
  let changed = 0;

  for (const startLabel of protectedStarts) {
    const startIndex = labelIndex.get(startLabel);
    if (startIndex == null) continue;
    const protectedLoadIndex = nextInstructionIndex(codeItems, startIndex);
    if (protectedLoadIndex == null) continue;
    const protectedLoad = codeItems[protectedLoadIndex] && codeItems[protectedLoadIndex].instruction;
    if (!isSimpleLoadInstruction(protectedLoad)) continue;
    const joinIndex = nextInstructionIndex(codeItems, protectedLoadIndex + 1);
    if (joinIndex == null) continue;

    for (let i = 0; i < protectedLoadIndex; i += 1) {
      const item = codeItems[i];
      if (!item || !item.instruction || !sameInstruction(item.instruction, protectedLoad)) continue;
      if (item.labelDef && isLabelProtected(code, item.labelDef)) continue;
      const gotoIndex = nextInstructionIndex(codeItems, i + 1);
      if (gotoIndex == null) continue;
      if (getOpcode(codeItems[gotoIndex] && codeItems[gotoIndex].instruction) !== 'goto') continue;
      const target = trimLabel(getInstructionArg(codeItems[gotoIndex].instruction));
      if (!target || labelIndex.get(target) !== joinIndex) continue;
      if (hasInstructionBetween(codeItems, i + 1, gotoIndex)) continue;

      item.instruction = { op: 'goto', arg: startLabel };
      removeInstructionOnly(codeItems, gotoIndex);
      changed += 1;
    }
  }

  return changed;
}

function cloneForwardLoopEntryGotos(code) {
  const codeItems = code.codeItems;
  const labelIndex = buildLabelIndex(codeItems);
  let changed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || getOpcode(item.instruction) !== 'goto') continue;
    const prevIdx = previousInstructionIndex(codeItems, i - 1);
    if (prevIdx == null) continue;
    const prev = codeItems[prevIdx] && codeItems[prevIdx].instruction;
    if (!isConditionalBranch(getOpcode(prev))) continue;

    const target = trimLabel(getInstructionArg(item.instruction));
    const targetIdx = labelIndex.get(target);
    if (targetIdx == null || targetIdx <= i) continue;
    if (isLabelProtected(code, target)) continue;

    const alternate = trimLabel(getInstructionArg(prev));
    const alternateIdx = labelIndex.get(alternate);
    if (alternateIdx == null || alternateIdx <= i || alternateIdx >= targetIdx) continue;
    if (countInstructionLabelReferences(codeItems, target) !== 2) continue;
    if (hasFallthroughPredecessor(codeItems, labelIndex, target)) continue;
    if (!isStackNeutralConditionalGotoBlock(codeItems, prevIdx, i)) continue;

    const range = findForwardLoopRange(codeItems, labelIndex, targetIdx);
    if (!range) continue;
    const realInsns = countInstructions(codeItems, range.start, range.end);
    if (realInsns === 0 || realInsns > 140) continue;

    const clone = cloneRange(codeItems.slice(range.start, range.end), `L${90000 + changed * 1000}`);
    if (clone.length === 0) continue;
    codeItems.splice(i, 1, ...clone);
    changed += 1;
    break;
  }

  return changed;
}

function cloneConditionalForwardLoopEntry(code) {
  const codeItems = code.codeItems;
  const labelIndex = buildLabelIndex(codeItems);
  let changed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const opcode = getOpcode(item && item.instruction);
    if (!isConditionalBranch(opcode)) continue;

    const target = trimLabel(getInstructionArg(item.instruction));
    const targetIdx = labelIndex.get(target);
    if (targetIdx == null || targetIdx <= i) continue;
    if (isLabelProtected(code, target)) continue;
    if (!hasFallthroughPredecessor(codeItems, labelIndex, target)) continue;

    const range = findForwardLoopRange(codeItems, labelIndex, targetIdx);
    if (!range) continue;
    const exitLabel = trimLabel(codeItems[range.end] && codeItems[range.end].labelDef);
    if (!exitLabel) continue;
    if (!hasBranchToLabelBetween(codeItems, i + 1, targetIdx, exitLabel)) continue;

    const realInsns = countInstructions(codeItems, range.start, range.end);
    if (realInsns === 0 || realInsns > 220) continue;

    const summary = analyzeRegion(code, range.start, range.end);
    if (!summary.supported) continue;
    if (summary.touchesProtectedLabel || summary.overlapsExceptionRange) continue;
    if (summary.stack.delta !== 0 || summary.stack.underflowsEntry) continue;
    if (summary.inboundBranches.some((b) => b.fromIdx !== i || b.target !== target)) continue;

    const prefix = `L${96000 + changed * 1000}`;
    const clone = cloneRange(codeItems.slice(range.start, range.end), prefix);
    if (clone.length === 0) continue;
    const cloneEntry = trimLabel(clone[0] && clone[0].labelDef);
    if (!cloneEntry) continue;

    const guard = { instruction: { op: 'goto', arg: target } };
    codeItems.splice(targetIdx, 0, guard, ...clone);
    item.instruction = setInstructionArg(item.instruction, cloneEntry);
    changed += 1;
    break;
  }

  return changed;
}

function cloneConditionalForwardTailEntry(code) {
  const codeItems = code.codeItems;
  const labelIndex = buildLabelIndex(codeItems);
  const clonedTargets = getPeepholeSet(code, 'peepholeClonedForwardTails');
  let changed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const opcode = getOpcode(item && item.instruction);
    if (!isConditionalBranch(opcode)) continue;
    const target = trimLabel(getInstructionArg(item.instruction));
    const targetIdx = labelIndex.get(target);
    if (targetIdx == null || targetIdx <= i) continue;
    if (clonedTargets.has(target)) continue;
    if (isGeneratedCloneLabel(target) || hasPreservationGuard(codeItems, targetIdx, target)) continue;
    if (isLabelProtected(code, target)) continue;

    const range = findForwardTailRange(codeItems, labelIndex, targetIdx);
    if (!range) continue;
    const realInsns = countInstructions(codeItems, range.start, range.end);
    if (realInsns === 0 || realInsns > 120) continue;

    const summary = analyzeRegion(code, range.start, range.end, { allowControlFlow: true, allowSideEffects: true });
    if (!summary.supported) continue;
    if (summary.touchesProtectedLabel || summary.overlapsExceptionRange) continue;
    if (summary.stack.delta !== 0 || summary.stack.underflowsEntry) continue;
    if (!hasSharedForwardTargetInside(codeItems, range.start, range.end)) continue;
    if (summary.inboundBranches.length < 4 || summary.localBranches.length < 10) continue;
    const arrayStores = countArrayStoreOpcodes(codeItems, range.start, range.end);
    if (arrayStores.total < 2 || arrayStores.other !== 0 || arrayStores.iastore < 2) continue;
    if (summary.inboundBranches.some((b) => b.fromIdx !== i && !(b.fromIdx > i && b.fromIdx < targetIdx))) {
      continue;
    }

    const prefix = nextClonePrefix('L97');
    const clone = cloneRange(codeItems.slice(range.start, range.end), prefix);
    const cloneEntry = trimLabel(clone[0] && clone[0].labelDef);
    if (!cloneEntry) continue;
    codeItems.splice(targetIdx, 0, { instruction: { op: 'goto', arg: target }, peepholeGuard: true }, ...clone);
    item.instruction = setInstructionArg(item.instruction, cloneEntry);
    clonedTargets.add(target);
    changed += 1;
    break;
  }

  return changed;
}

function cloneSharedFallthroughBlocks(code) {
  const codeItems = code.codeItems;
  const labelIndex = buildLabelIndex(codeItems);
  const clonedTargets = getPeepholeSet(code, 'peepholeClonedForwardTails');
  if (clonedTargets.size === 0) return 0;
  const splitTargets = getPeepholeSet(code, 'peepholeSplitSharedBlocks');
  let changed = 0;

  for (const [label, startIdx] of labelIndex.entries()) {
    if (splitTargets.has(label)) continue;
    if (hasPreservationGuard(codeItems, startIdx, label)) continue;
    if (isLabelProtected(code, label)) continue;
    const refs = collectBranchRefsToLabel(codeItems, label);
    if (refs.length < 2) continue;
    const endIdx = nextLabelIndex(codeItems, startIdx + 1);
    if (endIdx == null || endIdx <= startIdx) continue;
    const fallthroughLabel = trimLabel(codeItems[endIdx] && codeItems[endIdx].labelDef);
    if (!fallthroughLabel) continue;
    const realInsns = countInstructions(codeItems, startIdx, endIdx);
    if (realInsns === 0 || realInsns > 8) continue;

    const summary = analyzeRegion(code, startIdx, endIdx, { allowSideEffects: true });
    if (!summary.supported) continue;
    if (summary.hasControlFlow || summary.hasTerminator) continue;
    if (summary.touchesProtectedLabel || summary.overlapsExceptionRange) continue;
    if (summary.stack.delta !== 0 || summary.stack.underflowsEntry) continue;
    if (!summary.hasObservableSideEffects) continue;

    const insert = [{ instruction: { op: 'goto', arg: label }, peepholeGuard: true }];
    refs.forEach((ref, refIdx) => {
      const clone = cloneRange(codeItems.slice(startIdx, endIdx), nextClonePrefix('L98'));
      const cloneEntry = trimLabel(clone[0] && clone[0].labelDef);
      if (!cloneEntry) return;
      clone.push({ instruction: { op: 'goto', arg: fallthroughLabel } });
      insert.push(...clone);
      ref.item.instruction = setInstructionArg(ref.item.instruction, cloneEntry);
    });
    if (insert.length <= 1) continue;
    codeItems.splice(startIdx, 0, ...insert);
    splitTargets.add(label);
    changed += refs.length;
    break;
  }

  return changed;
}

function coalesceLoopProducerBridges(code) {
  const codeItems = code.codeItems;
  const labelIndex = buildLabelIndex(codeItems);
  let changed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || !isSimpleProducerInstruction(item.instruction)) continue;
    const gotoIdx = nextInstructionIndex(codeItems, i + 1);
    if (gotoIdx == null) continue;
    const gotoInsn = codeItems[gotoIdx] && codeItems[gotoIdx].instruction;
    if (getOpcode(gotoInsn) !== 'goto') continue;
    if (hasInstructionBetween(codeItems, i + 1, gotoIdx)) continue;

    const target = trimLabel(getInstructionArg(gotoInsn));
    const targetIdx = labelIndex.get(target);
    if (targetIdx == null || targetIdx <= gotoIdx) continue;

    const producerIdx = previousInstructionIndex(codeItems, targetIdx - 1);
    if (producerIdx == null || producerIdx <= gotoIdx) continue;
    const producer = codeItems[producerIdx];
    const producerLabel = trimLabel(producer && producer.labelDef);
    if (!producerLabel || isLabelProtected(code, producerLabel)) continue;
    if (!sameInstruction(item.instruction, producer.instruction)) continue;
    if (nextInstructionIndex(codeItems, producerIdx + 1) !== targetIdx) continue;
    if (!hasBackwardGotoToLabel(codeItems, labelIndex, producerLabel, targetIdx + 1)) continue;

    item.instruction = { op: 'goto', arg: producerLabel };
    removeInstructionOnly(codeItems, gotoIdx);
    changed += 1;
  }

  return changed;
}

function coalesceDuplicateLoopTails(code) {
  const codeItems = code.codeItems;
  let changed = 0;

  for (let gotoIdx = 0; gotoIdx < codeItems.length; gotoIdx += 1) {
    const item = codeItems[gotoIdx];
    if (!item || !item.instruction || getOpcode(item.instruction) !== 'goto') continue;
    const loopHead = trimLabel(getInstructionArg(item.instruction));
    const labelIndex = buildLabelIndex(codeItems);
    const loopHeadIdx = labelIndex.get(loopHead);
    if (loopHeadIdx == null || loopHeadIdx >= gotoIdx) continue;
    const candidates = duplicateTailSuffixCandidates(codeItems, gotoIdx);
    for (const candidate of candidates) {
      const tail = findDuplicateTail(code, codeItems, labelIndex, gotoIdx + 1, loopHead, candidate.instructions);
      if (!tail) continue;
      const labelDef = codeItems[candidate.start] && codeItems[candidate.start].labelDef;
      const replacement = labelDef
        ? { labelDef, instruction: { op: 'goto', arg: tail.label } }
        : { instruction: { op: 'goto', arg: tail.label } };
      codeItems.splice(candidate.start, gotoIdx - candidate.start + 1, replacement);
      changed += 1;
      return changed;
    }
  }

  return changed;
}

function duplicateTailSuffixCandidates(codeItems, gotoIdx) {
  const candidates = [];
  let start = previousInstructionIndex(codeItems, gotoIdx - 1);
  for (let count = 1; start != null && count <= 12; count += 1) {
    if (codeItems[start] && codeItems[start].labelDef) break;
    const prev = previousInstructionIndex(codeItems, start - 1);
    if (prev != null && isConditionalBranch(getOpcode(codeItems[prev] && codeItems[prev].instruction))) {
      const instructions = instructionSlice(codeItems, start, gotoIdx);
      if (instructions.some((instruction) => opcodeMnemonic(instruction) === 'iinc')) {
        candidates.push({ start, instructions });
      }
    }
    start = prev;
  }
  return candidates;
}

function findDuplicateTail(code, codeItems, labelIndex, startSearch, loopHead, blockInstructions) {
  for (let i = startSearch; i < codeItems.length; i += 1) {
    const label = trimLabel(codeItems[i] && codeItems[i].labelDef);
    if (!label || isLabelProtected(code, label)) continue;
    const gotoIdx = instructionIndexAfterSequence(codeItems, i, blockInstructions);
    if (gotoIdx == null) continue;
    const tailGoto = codeItems[gotoIdx] && codeItems[gotoIdx].instruction;
    if (getOpcode(tailGoto) !== 'goto') continue;
    if (trimLabel(getInstructionArg(tailGoto)) !== loopHead) continue;
    if (labelIndex.get(label) !== i) continue;
    return { label, gotoIdx };
  }
  return null;
}

function instructionIndexAfterSequence(codeItems, startIdx, instructions) {
  let itemIdx = startIdx;
  for (const expected of instructions) {
    itemIdx = nextInstructionIndex(codeItems, itemIdx);
    if (itemIdx == null) return null;
    const actual = codeItems[itemIdx] && codeItems[itemIdx].instruction;
    if (!sameInstruction(actual, expected)) return null;
    itemIdx += 1;
  }
  return nextInstructionIndex(codeItems, itemIdx);
}

function removeSingleUseFallthroughGotos(code) {
  let removed = 0;
  const codeItems = code.codeItems;
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || getOpcode(item.instruction) !== 'goto') continue;
    const target = trimLabel(getInstructionArg(item.instruction));
    if (!target) continue;
    const nextLabel = findNextLabel(codeItems, i + 1);
    if (target !== nextLabel) continue;
    if (isLabelProtected(code, target)) continue;
    if (countInstructionLabelReferences(codeItems, target) !== 1) continue;
    removeInstructionOnly(codeItems, i);
    removed += 1;
    if (!codeItems[i] || !codeItems[i].instruction) {
      i -= 1;
    }
  }
  return removed;
}

function invertConditionalOverGoto(code) {
  let changed = 0;
  const codeItems = code.codeItems;
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const opcode = getOpcode(item && item.instruction);
    const inverse = INVERSE_CONDITIONALS[opcode];
    if (!inverse) continue;
    const bodyLabel = trimLabel(getInstructionArg(item.instruction));
    if (!bodyLabel) continue;
    const gotoIndex = nextInstructionIndex(codeItems, i + 1);
    if (gotoIndex == null || getOpcode(codeItems[gotoIndex] && codeItems[gotoIndex].instruction) !== 'goto') continue;
    const exitLabel = trimLabel(getInstructionArg(codeItems[gotoIndex].instruction));
    if (!exitLabel || exitLabel === bodyLabel) continue;
    if (findNextLabel(codeItems, gotoIndex + 1) !== bodyLabel) continue;
    if (isLabelProtected(code, bodyLabel) || isLabelProtected(code, exitLabel)) continue;
    item.instruction = { op: inverse, arg: exitLabel };
    removeInstructionOnly(codeItems, gotoIndex);
    changed += 1;
  }
  return changed;
}

function removeUnreachableAfterTerminal(code) {
  const codeItems = code.codeItems;
  const used = collectControlFlowLabels(code);
  const labelIndex = buildLabelIndex(codeItems);
  let removed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || !isTerminalOpcode(getOpcode(item.instruction))) continue;
    const dead = collectTrailingDeadBackedge(codeItems, used, labelIndex, i + 1, i);
    if (!dead) continue;
    for (let j = dead.end; j >= dead.start; j -= 1) {
      if (codeItems[j] && codeItems[j].instruction) removed += 1;
      codeItems.splice(j, 1);
    }
  }

  return removed;
}

function removeUnreachableUntilUsedLabel(code) {
  const codeItems = code.codeItems;
  const used = collectControlFlowLabels(code);
  let removed = 0;
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || !isTerminalOpcode(getOpcode(item.instruction))) continue;
    let end = i;
    for (let j = i + 1; j < codeItems.length; j += 1) {
      const next = codeItems[j];
      if (next && next.labelDef && used.has(trimLabel(next.labelDef))) break;
      end = j;
    }
    if (end <= i) continue;
    for (let j = end; j > i; j -= 1) {
      if (codeItems[j] && codeItems[j].instruction) removed += 1;
      codeItems.splice(j, 1);
    }
  }
  return removed;
}

function collectTrailingDeadBackedge(codeItems, usedLabels, labelIndex, start, terminalIndex) {
  let gotoCount = 0;
  let end = start - 1;

  for (let i = start; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item) continue;
    if (item.labelDef && usedLabels.has(trimLabel(item.labelDef))) return null;
    if (!item.instruction) {
      end = i;
      continue;
    }
    const opcode = getOpcode(item.instruction);
    if (opcode !== 'goto' && opcode !== 'goto_w') return null;
    const target = trimLabel(getInstructionArg(item.instruction));
    const targetIndex = labelIndex.get(target);
    if (targetIndex == null || targetIndex >= terminalIndex) return null;
    gotoCount += 1;
    end = i;
  }

  return gotoCount === 1 ? { start, end } : null;
}

function collectControlFlowLabels(code) {
  const used = new Set();
  for (const entry of code.exceptionTable || []) {
    addLabel(used, entry.startLbl || entry.startLabel || entry.start);
    addLabel(used, entry.endLbl || entry.endLabel || entry.end);
    addLabel(used, entry.handlerLbl || entry.handlerLabel || entry.handler || entry.usingLbl);
  }
  for (const item of code.codeItems || []) {
    collectInstructionLabels(item && item.instruction, used);
  }
  return used;
}

function collectProtectedStarts(code) {
  const starts = new Set();
  for (const entry of code.exceptionTable || []) {
    addLabel(starts, entry.startLbl || entry.startLabel || entry.start);
  }
  return starts;
}

function removeUnusedLabels(code) {
  const used = collectUsedLabels(code);
  let removed = 0;
  const codeItems = code.codeItems;
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.labelDef) continue;
    const label = trimLabel(item.labelDef);
    if (used.has(label)) continue;
    delete item.labelDef;
    removed += 1;
    if (!item.instruction && !item.stackMapFrame && !item.pc) {
      codeItems.splice(i, 1);
      i -= 1;
    }
  }
  return removed;
}

function collectUsedLabels(code) {
  const used = new Set();
  for (const entry of code.exceptionTable || []) {
    addLabel(used, entry.startLbl || entry.startLabel || entry.start);
    addLabel(used, entry.endLbl || entry.endLabel || entry.end);
    addLabel(used, entry.handlerLbl || entry.handlerLabel || entry.handler || entry.usingLbl);
  }
  for (const item of code.codeItems || []) {
    if (item && item.stackMapFrame && item.labelDef) {
      addLabel(used, item.labelDef);
    }
    if (item && item.lineNumber && item.lineNumber.start) {
      addLabel(used, item.lineNumber.start);
    }
    collectInstructionLabels(item && item.instruction, used);
  }
  return used;
}

function buildLabelIndex(codeItems) {
  const out = new Map();
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (item && item.labelDef) out.set(trimLabel(item.labelDef), i);
  }
  return out;
}

function firstInstructionAtLabel(codeItems, labelIndex, label) {
  const start = labelIndex.get(trimLabel(label));
  if (start == null) return null;
  for (let i = start; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (i !== start && item && item.labelDef) return null;
    if (item && item.instruction) return item;
  }
  return null;
}

function hasFallthroughPredecessor(codeItems, labelIndex, label) {
  const targetIndex = labelIndex.get(trimLabel(label));
  if (targetIndex == null) return false;
  for (let i = targetIndex - 1; i >= 0; i -= 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    return !isTerminalOpcode(getOpcode(item.instruction));
  }
  return false;
}

function hasBackwardGotoToLabel(codeItems, labelIndex, label, startIdx) {
  const targetIdx = labelIndex.get(label);
  if (targetIdx == null) return false;
  for (let i = startIdx; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || getOpcode(item.instruction) !== 'goto') continue;
    if (trimLabel(getInstructionArg(item.instruction)) === label && i > targetIdx) return true;
  }
  return false;
}

function findForwardLoopRange(codeItems, labelIndex, startIdx) {
  for (let i = startIdx + 1; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const labels = [];
    collectInstructionLabels(item.instruction, {
      add(label) {
        labels.push(trimLabel(label));
      },
    });
    for (const label of labels) {
      const targetIdx = labelIndex.get(label);
      if (targetIdx == null || targetIdx < startIdx || targetIdx >= i) continue;
      const endIdx = nextLabelIndex(codeItems, i + 1);
      if (endIdx == null || endIdx <= i) return null;
      return { start: startIdx, end: endIdx };
    }
  }
  return null;
}

function findForwardTailRange(codeItems, labelIndex, startIdx) {
  for (let i = startIdx + 1; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    let backTarget = null;
    collectInstructionLabels(item.instruction, {
      add(label) {
        const targetIdx = labelIndex.get(trimLabel(label));
        if (targetIdx != null && targetIdx < startIdx) backTarget = trimLabel(label);
      },
    });
    if (!backTarget) continue;
    const blockStart = previousLabelOrStart(codeItems, i);
    if (blockStart <= startIdx) return null;
    return { start: startIdx, end: blockStart };
  }
  return null;
}

function hasSharedForwardTargetInside(codeItems, startIdx, endIdx) {
  const labelIndex = buildLabelIndex(codeItems);
  for (let i = startIdx; i < endIdx; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const targets = [];
    collectInstructionLabels(item.instruction, {
      add(label) {
        targets.push(trimLabel(label));
      },
    });
    for (const target of targets) {
      const targetIdx = labelIndex.get(target);
      if (targetIdx != null && targetIdx > i && targetIdx < endIdx && countInstructionLabelReferences(codeItems, target) > 1) {
        return true;
      }
    }
  }
  return false;
}

function isStackNeutralConditionalGotoBlock(codeItems, conditionalIdx, gotoIdx) {
  const start = previousLabelOrStart(codeItems, conditionalIdx);
  let depth = 0;
  for (let i = start; i <= conditionalIdx; i += 1) {
    const instruction = codeItems[i] && codeItems[i].instruction;
    if (!instruction) continue;
    const delta = stackDelta(instruction);
    if (delta == null) return false;
    depth += delta;
    if (depth < 0) return false;
  }
  if (depth !== 0) return false;
  return nextInstructionIndex(codeItems, conditionalIdx + 1) === gotoIdx;
}

function collectBranchRefsToLabel(codeItems, label) {
  const out = [];
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const arg = getInstructionArg(item.instruction);
    if (typeof arg === 'string' && trimLabel(arg) === label) {
      out.push({ idx: i, item });
    }
  }
  return out;
}

function countArrayStoreOpcodes(codeItems, startIdx, endIdx) {
  const stores = new Set(['iastore', 'lastore', 'fastore', 'dastore', 'aastore', 'bastore', 'castore', 'sastore']);
  const counts = { total: 0, iastore: 0, other: 0 };
  for (let i = startIdx; i < endIdx; i += 1) {
    const opcode = opcodeMnemonic(codeItems[i] && codeItems[i].instruction);
    if (!stores.has(opcode)) continue;
    counts.total += 1;
    if (opcode === 'iastore') counts.iastore += 1;
    else counts.other += 1;
  }
  return counts;
}

function hasPreservationGuard(codeItems, labelIdx, label) {
  const prevIdx = previousInstructionIndex(codeItems, labelIdx - 1);
  if (prevIdx == null) return false;
  const prev = codeItems[prevIdx] && codeItems[prevIdx].instruction;
  return !!(codeItems[prevIdx] && codeItems[prevIdx].peepholeGuard) &&
    opcodeMnemonic(prev) === 'goto' && trimLabel(getInstructionArg(prev)) === label;
}

function isGeneratedCloneLabel(label) {
  return /^L(?:97|98)\d+_/.test(trimLabel(label) || '');
}

function nextClonePrefix(kind) {
  clonePrefixCounter += 1;
  return `${kind}${clonePrefixCounter}`;
}

function getPeepholeSet(code, key) {
  if (!Object.prototype.hasOwnProperty.call(code, key)) {
    Object.defineProperty(code, key, {
      value: new Set(),
      enumerable: false,
      configurable: true,
    });
  }
  return code[key];
}

function cloneRange(items, prefix) {
  const labels = [];
  for (const item of items) {
    const label = trimLabel(item && item.labelDef);
    if (label) labels.push(label);
  }
  if (labels.length === 0) return [];
  const labelMap = new Map(labels.map((label, index) => [label, `${prefix}_${index}`]));
  return items.map((item) => cloneItemWithLabels(item, labelMap));
}

function cloneItemWithLabels(item, labelMap) {
  const out = {};
  const label = trimLabel(item && item.labelDef);
  if (label) out.labelDef = `${labelMap.get(label)}:`;
  if (item && item.instruction) out.instruction = rewriteInstructionLabels(item.instruction, labelMap);
  if (item && item.stackMapFrame) out.stackMapFrame = cloneValue(item.stackMapFrame);
  if (item && item.lineNumber) out.lineNumber = cloneValue(item.lineNumber);
  return out;
}

function rewriteInstructionLabels(instruction, labelMap) {
  const out = cloneValue(instruction);
  rewriteLabelsInValue(out, labelMap);
  return out;
}

function rewriteLabelsInValue(value, labelMap) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.arg === 'string') {
    const label = trimLabel(value.arg);
    if (labelMap.has(label)) value.arg = labelMap.get(label);
  } else if (Array.isArray(value.arg)) {
    value.arg = value.arg.map((entry) => rewriteLabelValue(entry, labelMap));
  } else if (value.arg && typeof value.arg === 'object') {
    value.arg = rewriteLabelValue(value.arg, labelMap);
  }
}

function rewriteLabelValue(value, labelMap) {
  if (typeof value === 'string') {
    const label = trimLabel(value);
    return labelMap.has(label) ? labelMap.get(label) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => rewriteLabelValue(entry, labelMap));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = rewriteLabelValue(entry, labelMap);
    return out;
  }
  return value;
}

function countInstructions(codeItems, startIdx, endIdx) {
  let count = 0;
  for (let i = startIdx; i < endIdx; i += 1) {
    if (codeItems[i] && codeItems[i].instruction) count += 1;
  }
  return count;
}

function instructionSlice(codeItems, startIdx, endIdx) {
  const instructions = [];
  for (let i = startIdx; i < endIdx; i += 1) {
    if (codeItems[i] && codeItems[i].instruction) instructions.push(cloneValue(codeItems[i].instruction));
  }
  return instructions;
}

function hasInternalLabel(codeItems, startIdx, endIdx) {
  for (let i = startIdx; i < endIdx; i += 1) {
    if (codeItems[i] && codeItems[i].labelDef) return true;
  }
  return false;
}

function hasInstructionBetween(codeItems, startIndex, endIndex) {
  for (let i = startIndex; i < endIndex; i += 1) {
    if (codeItems[i] && codeItems[i].instruction) return true;
  }
  return false;
}

function hasBranchToLabelBetween(codeItems, startIndex, endIndex, label) {
  for (let i = startIndex; i < endIndex; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    let found = false;
    collectInstructionLabels(item.instruction, {
      add(candidate) {
        if (trimLabel(candidate) === label) found = true;
      },
    });
    if (found) return true;
  }
  return false;
}

function isConditionalBranch(opcode) {
  return /^if/.test(opcode || '');
}

function isSimpleLoadInstruction(instruction) {
  const opcode = getOpcode(instruction);
  return opcode === 'aload' || opcode === 'iload' || opcode === 'fload' ||
    opcode === 'lload' || opcode === 'dload' ||
    /^aload_\d$/.test(opcode || '') ||
    /^iload_\d$/.test(opcode || '') ||
    /^fload_\d$/.test(opcode || '') ||
    /^lload_\d$/.test(opcode || '') ||
    /^dload_\d$/.test(opcode || '');
}

function isSimpleProducerInstruction(instruction) {
  const opcode = getOpcode(instruction);
  if (typeof opcode !== 'string') return false;
  if (isSimpleLoadInstruction(instruction)) return true;
  return /^(aconst_null|iconst_m1|iconst_\d+|fconst_\d+|dconst_[01]|lconst_[01]|bipush|sipush|ldc|ldc_w|ldc2_w)(?:\s|$)/.test(opcode);
}

function sameInstruction(a, b) {
  if (getOpcode(a) !== getOpcode(b)) return false;
  return sameValue(getInstructionArg(a), getInstructionArg(b));
}

function sameValue(a, b) {
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return typeof a === typeof b && a === b;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => sameValue(entry, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]));
  }
  return a === b;
}

function isTerminalOpcode(opcode) {
  return opcode === 'goto' || opcode === 'goto_w' ||
    opcode === 'return' || opcode === 'ireturn' || opcode === 'lreturn' ||
    opcode === 'freturn' || opcode === 'dreturn' || opcode === 'areturn' ||
    opcode === 'athrow' || opcode === 'tableswitch' || opcode === 'lookupswitch';
}

function countInstructionLabelReferences(codeItems, label) {
  let count = 0;
  for (const item of codeItems || []) {
    if (!item || !item.instruction) continue;
    count += countLabelInValue(item.instruction.arg, label);
  }
  return count;
}

function collectInstructionLabels(instruction, used) {
  if (!instruction || typeof instruction !== 'object') return;
  collectLabelsFromValue(instruction.arg, used);
}

function collectLabelsFromValue(value, used) {
  if (!value) return;
  if (typeof value === 'string') {
    addLabel(used, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectLabelsFromValue(entry, used));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((entry) => collectLabelsFromValue(entry, used));
  }
}

function countLabelInValue(value, label) {
  if (!value) return 0;
  if (typeof value === 'string') {
    return trimLabel(value) === label ? 1 : 0;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + countLabelInValue(entry, label), 0);
  }
  if (typeof value === 'object') {
    return Object.values(value).reduce((sum, entry) => sum + countLabelInValue(entry, label), 0);
  }
  return 0;
}

function isLabelProtected(code, label) {
  for (const entry of code.exceptionTable || []) {
    if (trimLabel(entry.startLbl || entry.startLabel || entry.start) === label) return true;
    if (trimLabel(entry.endLbl || entry.endLabel || entry.end) === label) return true;
    if (trimLabel(entry.handlerLbl || entry.handlerLabel || entry.handler || entry.usingLbl) === label) {
      return true;
    }
  }
  return false;
}

function removeInstructionOnly(codeItems, index) {
  const item = codeItems[index];
  if (!item) return;
  if (item.labelDef || item.stackMapFrame) {
    delete item.instruction;
    delete item.pc;
  } else {
    codeItems.splice(index, 1);
  }
}

function findNextLabel(codeItems, startIndex) {
  for (let i = startIndex; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (item && item.labelDef) return trimLabel(item.labelDef);
    if (item && item.instruction) return null;
  }
  return null;
}

function nextInstructionIndex(codeItems, startIndex) {
  for (let i = startIndex; i < codeItems.length; i += 1) {
    if (codeItems[i] && codeItems[i].instruction) return i;
  }
  return null;
}

function previousInstructionIndex(codeItems, startIndex) {
  for (let i = startIndex; i >= 0; i -= 1) {
    if (codeItems[i] && codeItems[i].instruction) return i;
  }
  return null;
}

function previousLabelOrStart(codeItems, startIndex) {
  for (let i = startIndex; i >= 0; i -= 1) {
    if (codeItems[i] && codeItems[i].labelDef) return i;
  }
  return 0;
}

function nextLabelIndex(codeItems, startIndex) {
  for (let i = startIndex; i < codeItems.length; i += 1) {
    if (codeItems[i] && codeItems[i].labelDef) return i;
  }
  return null;
}

function getInstructionArg(instruction) {
  return instruction && typeof instruction === 'object' ? instruction.arg : null;
}

function setInstructionArg(instruction, arg) {
  if (!instruction || typeof instruction !== 'object') return instruction;
  return { ...instruction, arg };
}

function addLabel(set, label) {
  if (typeof label === 'string') {
    set.add(trimLabel(label));
  }
}

function getOpcode(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') return instruction;
  return instruction.op || null;
}

function opcodeMnemonic(instruction) {
  const op = getOpcode(instruction);
  return typeof op === 'string' ? op.split(/\s+/, 1)[0] : op;
}

function trimLabel(label) {
  if (typeof label !== 'string') return label;
  return label.endsWith(':') ? label.slice(0, -1) : label;
}

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof value === 'bigint') return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = cloneValue(entry);
  return out;
}

function stackDelta(instruction) {
  const op = getOpcode(instruction);
  if (!op) return null;
  if (isConditionalBranch(op)) return -conditionalPopCount(op);
  if (/^[afild]load(?:_\d+)?$/.test(op) || op === 'aload_0' || op === 'aload_1' || op === 'aload_2' || op === 'aload_3') return op[0] === 'd' || op[0] === 'l' ? 2 : 1;
  if (/^[afild]store(?:_\d+)?$/.test(op) || op === 'astore_0' || op === 'astore_1' || op === 'astore_2' || op === 'astore_3') return op[0] === 'd' || op[0] === 'l' ? -2 : -1;
  if (op.startsWith('iconst_') || op === 'bipush' || op === 'sipush' || op === 'ldc' || op === 'ldc_w' || op === 'aconst_null') return 1;
  if (op === 'ldc2_w' || op === 'lconst_0' || op === 'lconst_1' || op === 'dconst_0' || op === 'dconst_1') return 2;
  if (op === 'fconst_0' || op === 'fconst_1' || op === 'fconst_2') return 1;
  if (op === 'dup') return 1;
  if (op === 'pop') return -1;
  if (op === 'pop2') return -2;
  if (op === 'iinc' || op === 'nop' || op === 'goto') return 0;
  return null;
}

function conditionalPopCount(op) {
  if (op === 'ifnull' || op === 'ifnonnull') return 1;
  if (/^if(?:eq|ne|lt|ge|gt|le)$/.test(op)) return 1;
  if (/^if_[ai]cmp(?:eq|ne|lt|ge|gt|le)$/.test(op)) return 2;
  return 1;
}

const INVERSE_CONDITIONALS = {
  ifeq: 'ifne',
  ifne: 'ifeq',
  iflt: 'ifge',
  ifge: 'iflt',
  ifgt: 'ifle',
  ifle: 'ifgt',
  if_icmpeq: 'if_icmpne',
  if_icmpne: 'if_icmpeq',
  if_icmplt: 'if_icmpge',
  if_icmpge: 'if_icmplt',
  if_icmpgt: 'if_icmple',
  if_icmple: 'if_icmpgt',
  if_acmpeq: 'if_acmpne',
  if_acmpne: 'if_acmpeq',
  ifnull: 'ifnonnull',
  ifnonnull: 'ifnull',
};

module.exports = {
  runPeepholeClean,
  removeNops,
  threadBranchesThroughGoto,
  coalesceProtectedLoadBridges,
  coalesceLoopProducerBridges,
  coalesceDuplicateLoopTails,
  cloneForwardLoopEntryGotos,
  cloneConditionalForwardLoopEntry,
  cloneConditionalForwardTailEntry,
  cloneSharedFallthroughBlocks,
  invertConditionalOverGoto,
  removeUnreachableAfterTerminal,
  removeUnreachableUntilUsedLabel,
  removeSingleUseFallthroughGotos,
  removeUnusedLabels,
};
