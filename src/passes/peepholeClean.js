'use strict';

const { removeTrivialRethrowHandlers } = require('./removeTrivialRethrowHandlers');
const { analyzeRegion } = require('../analysis/regionSafety');
const { createMethodFacts } = require('../analysis/methodFacts');

let clonePrefixCounter = 0;
const tracePeepholeTimes = process.env.PEEPHOLE_TRACE_TIMES === '1';

function runPeepholeClean(astRoot, options = {}) {
  let changes = 0;
  const details = {
    rethrowHandlers: 0,
    nops: 0,
    threadedBranches: 0,
    threadedMultiUseGotoBridges: 0,
    protectedLoadBridges: 0,
    monitorWaitRegions: 0,
    nullCompareBranches: 0,
    dupStoreCompareBranches: 0,
    loopProducerBridges: 0,
    duplicateLoopTails: 0,
    duplicateLoopIncrementTails: 0,
    duplicateLoopBackedgeTails: 0,
    sharedLoopIncrementTailClones: 0,
    forwardLoopEntryClones: 0,
    conditionalForwardLoopEntryClones: 0,
    conditionalForwardTailClones: 0,
    sharedFallthroughBlockClones: 0,
    sharedFallthroughJoinClones: 0,
    smallTerminalSharedBlockClones: 0,
    conditionalSharedJoinClones: 0,
    sharedPureForwardJoinClones: 0,
    sharedSideEffectJoinClones: 0,
    longCompareSharedJoinClones: 0,
    conditionalSharedLoopTailClones: 0,
    nullableSharedJoinGuards: 0,
    conditionalFallthroughGotoBridges: 0,
    stackConditionalTargetClones: 0,
    forwardTerminalGotoTailClones: 0,
    forwardSharedInitPrefixClones: 0,
    boundedTerminalGotoTailClones: 0,
    loopValueContinuationClones: 0,
    conditionalTerminalTailClones: 0,
    invertedFallthroughGotos: 0,
    fallthroughGotos: 0,
    deadGotoIslands: 0,
    unreachableInstructions: 0,
    unusedLabels: 0,
    restoredPcTargetLabels: 0,
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

  const maxRounds = Math.max(1, Number(options.maxRounds || 4));
  for (let i = 0; i < maxRounds; i += 1) {
    const roundStart = Date.now();
    const round = cleanOneRound(astRoot, {
      removeUnreachableCode: options.removeHandlerCode !== false,
      cloneForwardTails: options.cloneForwardTails === true,
      invertConditionalsOverGoto: options.invertConditionalsOverGoto === true,
      invertConditionalsOverGotoClasses: new Set(options.invertConditionalsOverGotoClasses || []),
      cloneSharedFallthroughJoins: options.cloneSharedFallthroughJoins === true,
      cloneSharedFallthroughJoinClasses: new Set(options.cloneSharedFallthroughJoinClasses || []),
      cloneSmallTerminalSharedForwardBlocks: options.cloneSmallTerminalSharedForwardBlocks === true,
      cloneSmallTerminalSharedForwardBlockMinMethodInsns: options.cloneSmallTerminalSharedForwardBlockMinMethodInsns || 0,
      cloneSmallTerminalSharedForwardBlockMaxLocalIndex: options.cloneSmallTerminalSharedForwardBlockMaxLocalIndex || null,
      cloneConditionalSharedJoins: options.cloneConditionalSharedJoins === true,
      cloneSharedPureForwardJoins: options.cloneSharedPureForwardJoins === true,
      cloneSharedPureForwardJoinMinMethodInsns: options.cloneSharedPureForwardJoinMinMethodInsns || 0,
      cloneSharedPureForwardJoinMaxInsns: options.cloneSharedPureForwardJoinMaxInsns || 6,
      cloneSharedPureForwardJoinMaxRefs: options.cloneSharedPureForwardJoinMaxRefs || 8,
      cloneLongCompareSharedJoins: options.cloneLongCompareSharedJoins === true,
      cloneConditionalSharedJoinClasses: new Set(options.cloneConditionalSharedJoinClasses || []),
      cloneConditionalSharedJoinMinMethodInsns: options.cloneConditionalSharedJoinMinMethodInsns || 0,
      cloneConditionalSharedJoinMinArrayStores: options.cloneConditionalSharedJoinMinArrayStores || 0,
      cloneConditionalSharedJoinRequireNoExceptions: options.cloneConditionalSharedJoinRequireNoExceptions === true,
      cloneConditionalSharedJoinRequireStatic: options.cloneConditionalSharedJoinRequireStatic === true,
      cloneConditionalSharedJoinMaxLocalIndex: options.cloneConditionalSharedJoinMaxLocalIndex || null,
      cloneConditionalSharedJoinRequireIntArrayParameter: options.cloneConditionalSharedJoinRequireIntArrayParameter === true,
      nullableSharedJoinGuardMinMethodInsns: options.nullableSharedJoinGuardMinMethodInsns || 0,
      nullableSharedJoinGuardRequireNoExceptions: options.nullableSharedJoinGuardRequireNoExceptions === true,
      nullableSharedJoinGuardMaxLocalIndex: options.nullableSharedJoinGuardMaxLocalIndex || null,
      stripMonitorWaitExceptionRegions: options.stripMonitorWaitExceptionRegions === true,
      cloneConditionalSharedLoopTails: options.cloneConditionalSharedLoopTails === true,
      cloneConditionalSharedLoopTailClasses: new Set(options.cloneConditionalSharedLoopTailClasses || []),
      materializeNullableSharedJoinGuards: options.materializeNullableSharedJoinGuards === true,
      removeConditionalFallthroughGotoBridges: options.removeConditionalFallthroughGotoBridges === true,
      materializeDupStoreCompareBranches: options.materializeDupStoreCompareBranches === true,
      simplifyNullCompareBranches: options.simplifyNullCompareBranches === true,
      removeDeadGotoIslands: options.removeDeadGotoIslands === true,
      coalesceProtectedLoopProducerBridges: options.coalesceProtectedLoopProducerBridges === true,
      cloneStackConditionalTargets: options.cloneStackConditionalTargets === true,
      removeUnreachableUntilUsedLabels: options.removeUnreachableUntilUsedLabels === true,
      cloneForwardTerminalGotoTails: options.cloneForwardTerminalGotoTails === true,
      cloneForwardTerminalGotoTailMaxInsns: options.cloneForwardTerminalGotoTailMaxInsns || 0,
      cloneForwardTerminalGotoTailMaxMethodInsns: options.cloneForwardTerminalGotoTailMaxMethodInsns || 0,
      cloneForwardTerminalGotoTailMaxClones: options.cloneForwardTerminalGotoTailMaxClones || 1,
      cloneSharedSideEffectJoins: options.cloneSharedSideEffectJoins === true,
      cloneSharedSideEffectJoinMaxInsns: options.cloneSharedSideEffectJoinMaxInsns || 32,
      cloneSharedSideEffectJoinMaxRefs: options.cloneSharedSideEffectJoinMaxRefs || 4,
      cloneForwardSharedInitPrefixes: options.cloneForwardSharedInitPrefixes === true,
      cloneForwardSharedInitPrefixMaxInsns: options.cloneForwardSharedInitPrefixMaxInsns || 12,
      cloneForwardSharedInitPrefixMaxClones: options.cloneForwardSharedInitPrefixMaxClones || 2,
      cloneBoundedTerminalGotoTails: options.cloneBoundedTerminalGotoTails === true,
      cloneBoundedTerminalGotoTailMaxInsns: options.cloneBoundedTerminalGotoTailMaxInsns || 0,
      cloneBoundedTerminalGotoTailMaxClones: options.cloneBoundedTerminalGotoTailMaxClones || 1,
      cloneLoopValueContinuations: options.cloneLoopValueContinuations === true,
      cloneLoopValueContinuationMaxClones: options.cloneLoopValueContinuationMaxClones || 4,
      cloneConditionalTerminalTails: options.cloneConditionalTerminalTails === true,
      cloneConditionalTerminalTailMaxInsns: options.cloneConditionalTerminalTailMaxInsns || 0,
      cloneConditionalTerminalTailMaxMethodInsns: options.cloneConditionalTerminalTailMaxMethodInsns || 0,
      cloneConditionalTerminalTailMaxClones: options.cloneConditionalTerminalTailMaxClones || 1,
      coalesceDuplicateLoopBackedgeTails: options.coalesceDuplicateLoopBackedgeTails === true,
      cloneSharedLoopIncrementTails: options.cloneSharedLoopIncrementTails === true,
      cloneSharedLoopIncrementTailMaxInsns: options.cloneSharedLoopIncrementTailMaxInsns || 4,
      cloneSharedLoopIncrementTailMaxRefs: options.cloneSharedLoopIncrementTailMaxRefs || 8,
      threadMultiUseGotoBridges: options.threadMultiUseGotoBridges === true,
    });
    tracePeepholeRound(i, round, roundStart);
    details.nops += round.nops;
    details.threadedBranches += round.threadedBranches;
    details.threadedMultiUseGotoBridges += round.threadedMultiUseGotoBridges;
    details.protectedLoadBridges += round.protectedLoadBridges;
    details.monitorWaitRegions += round.monitorWaitRegions;
    details.nullCompareBranches += round.nullCompareBranches;
    details.dupStoreCompareBranches += round.dupStoreCompareBranches;
    details.loopProducerBridges += round.loopProducerBridges;
    details.duplicateLoopTails += round.duplicateLoopTails;
    details.duplicateLoopIncrementTails += round.duplicateLoopIncrementTails;
    details.duplicateLoopBackedgeTails += round.duplicateLoopBackedgeTails;
    details.sharedLoopIncrementTailClones += round.sharedLoopIncrementTailClones;
    details.forwardLoopEntryClones += round.forwardLoopEntryClones;
    details.conditionalForwardLoopEntryClones += round.conditionalForwardLoopEntryClones;
    details.conditionalForwardTailClones += round.conditionalForwardTailClones;
    details.sharedFallthroughBlockClones += round.sharedFallthroughBlockClones;
    details.sharedFallthroughJoinClones += round.sharedFallthroughJoinClones;
    details.smallTerminalSharedBlockClones += round.smallTerminalSharedBlockClones;
    details.conditionalSharedJoinClones += round.conditionalSharedJoinClones;
    details.sharedPureForwardJoinClones += round.sharedPureForwardJoinClones;
    details.sharedSideEffectJoinClones += round.sharedSideEffectJoinClones;
    details.longCompareSharedJoinClones += round.longCompareSharedJoinClones;
    details.conditionalSharedLoopTailClones += round.conditionalSharedLoopTailClones;
    details.nullableSharedJoinGuards += round.nullableSharedJoinGuards;
    details.conditionalFallthroughGotoBridges += round.conditionalFallthroughGotoBridges;
    details.stackConditionalTargetClones += round.stackConditionalTargetClones;
    details.forwardTerminalGotoTailClones += round.forwardTerminalGotoTailClones;
    details.forwardSharedInitPrefixClones += round.forwardSharedInitPrefixClones;
    details.boundedTerminalGotoTailClones += round.boundedTerminalGotoTailClones;
    details.loopValueContinuationClones += round.loopValueContinuationClones;
    details.conditionalTerminalTailClones += round.conditionalTerminalTailClones;
    details.invertedFallthroughGotos += round.invertedFallthroughGotos;
    details.fallthroughGotos += round.fallthroughGotos;
    details.deadGotoIslands += round.deadGotoIslands;
    details.unreachableInstructions += round.unreachableInstructions;
    details.unusedLabels += round.unusedLabels;
    details.restoredPcTargetLabels += round.restoredPcTargetLabels;
    const roundChanges = round.nops + round.threadedBranches + round.threadedMultiUseGotoBridges + round.protectedLoadBridges + round.monitorWaitRegions + round.nullCompareBranches + round.dupStoreCompareBranches + round.loopProducerBridges +
      round.duplicateLoopTails + round.duplicateLoopIncrementTails + round.duplicateLoopBackedgeTails +
      round.sharedLoopIncrementTailClones +
      round.forwardLoopEntryClones + round.conditionalForwardLoopEntryClones +
      round.conditionalForwardTailClones + round.sharedFallthroughBlockClones +
      round.sharedFallthroughJoinClones +
      round.smallTerminalSharedBlockClones +
      round.conditionalSharedJoinClones +
      round.sharedPureForwardJoinClones + round.sharedSideEffectJoinClones +
      round.longCompareSharedJoinClones +
      round.conditionalSharedLoopTailClones +
      round.nullableSharedJoinGuards +
      round.conditionalFallthroughGotoBridges +
      round.stackConditionalTargetClones +
      round.forwardTerminalGotoTailClones +
      round.forwardSharedInitPrefixClones +
      round.boundedTerminalGotoTailClones +
      round.loopValueContinuationClones +
      round.conditionalTerminalTailClones +
      round.invertedFallthroughGotos + round.fallthroughGotos +
      round.deadGotoIslands +
      round.unreachableInstructions + round.unusedLabels +
      round.restoredPcTargetLabels;
    changes += roundChanges;
    if (roundChanges === 0) {
      break;
    }
  }

  return { changed: changes > 0, changes, details };
}

function tracePeepholeRound(roundIndex, round, startMs) {
  if (!tracePeepholeTimes) return;
  const elapsed = Date.now() - startMs;
  const nonzero = Object.entries(round)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  console.error(`PEEPHOLE_ROUND ${roundIndex} ${elapsed}ms ${nonzero}`);
}

function cleanOneRound(astRoot, options = {}) {
  const details = {
    nops: 0,
    threadedBranches: 0,
    threadedMultiUseGotoBridges: 0,
    protectedLoadBridges: 0,
    monitorWaitRegions: 0,
    nullCompareBranches: 0,
    dupStoreCompareBranches: 0,
    loopProducerBridges: 0,
    duplicateLoopTails: 0,
    duplicateLoopIncrementTails: 0,
    duplicateLoopBackedgeTails: 0,
    sharedLoopIncrementTailClones: 0,
    forwardLoopEntryClones: 0,
    conditionalForwardLoopEntryClones: 0,
    conditionalForwardTailClones: 0,
    sharedFallthroughBlockClones: 0,
    sharedFallthroughJoinClones: 0,
    smallTerminalSharedBlockClones: 0,
    conditionalSharedJoinClones: 0,
    sharedPureForwardJoinClones: 0,
    sharedSideEffectJoinClones: 0,
    longCompareSharedJoinClones: 0,
    conditionalSharedLoopTailClones: 0,
    nullableSharedJoinGuards: 0,
    conditionalFallthroughGotoBridges: 0,
    stackConditionalTargetClones: 0,
    forwardTerminalGotoTailClones: 0,
    forwardSharedInitPrefixClones: 0,
    boundedTerminalGotoTailClones: 0,
    loopValueContinuationClones: 0,
    conditionalTerminalTailClones: 0,
    invertedFallthroughGotos: 0,
    fallthroughGotos: 0,
    deadGotoIslands: 0,
    unreachableInstructions: 0,
    unusedLabels: 0,
    restoredPcTargetLabels: 0,
  };
  forEachCode(astRoot, (code, method, classItem) => {
    const passFacts = () => createPeepholePassFacts(code);
    details.nops += tracePeepholeStep(classItem, method, 'removeNops', () => removeNops(code.codeItems));
    details.threadedBranches += tracePeepholeStep(classItem, method, 'threadBranchesThroughGoto', () => threadBranchesThroughGoto(code.codeItems));
    if (options.threadMultiUseGotoBridges) {
      details.threadedMultiUseGotoBridges += tracePeepholeStep(classItem, method, 'threadMultiUseGotoBridges', () => threadMultiUseGotoBridges(code, passFacts()));
    }
    details.protectedLoadBridges += tracePeepholeStep(classItem, method, 'coalesceProtectedLoadBridges', () => coalesceProtectedLoadBridges(code));
    if (options.stripMonitorWaitExceptionRegions) {
      details.monitorWaitRegions += stripMonitorWaitExceptionRegions(code, method);
    }
    if (options.simplifyNullCompareBranches) {
      details.nullCompareBranches += tracePeepholeStep(classItem, method, 'simplifyNullCompareBranches', () => simplifyNullCompareBranches(code));
    }
    if (options.materializeDupStoreCompareBranches &&
      methodMatchesConditionalSharedJoinGate(code, method, options)) {
      details.dupStoreCompareBranches += normalizeDupStoreCompareBranches(code);
    }
    details.loopProducerBridges += tracePeepholeStep(classItem, method, 'coalesceLoopProducerBridges', () => coalesceLoopProducerBridges(code, {
      allowProtectedProducer: options.coalesceProtectedLoopProducerBridges,
    }));
    details.duplicateLoopTails += tracePeepholeStep(classItem, method, 'coalesceDuplicateLoopTails', () => coalesceDuplicateLoopTails(code));
    const duplicateLoopIncrementTails = tracePeepholeStep(classItem, method, 'coalesceDuplicateLoopIncrementTails', () => coalesceDuplicateLoopIncrementTails(code, passFacts()));
    details.duplicateLoopIncrementTails += duplicateLoopIncrementTails;
    if (options.coalesceDuplicateLoopBackedgeTails && duplicateLoopIncrementTails === 0) {
      details.duplicateLoopBackedgeTails += tracePeepholeStep(classItem, method, 'coalesceDuplicateLoopBackedgeTails', () => coalesceDuplicateLoopBackedgeTails(code, passFacts()));
    }
    if (options.cloneSharedLoopIncrementTails) {
      details.sharedLoopIncrementTailClones += tracePeepholeStep(classItem, method, 'cloneSharedLoopIncrementTails', () => cloneSharedLoopIncrementTails(code, {
        maxInsns: options.cloneSharedLoopIncrementTailMaxInsns,
        maxRefs: options.cloneSharedLoopIncrementTailMaxRefs,
      }, passFacts()));
    }
    details.forwardLoopEntryClones += tracePeepholeStep(classItem, method, 'cloneForwardLoopEntryGotos', () => cloneForwardLoopEntryGotos(code));
    details.conditionalForwardLoopEntryClones += tracePeepholeStep(classItem, method, 'cloneConditionalForwardLoopEntry', () => cloneConditionalForwardLoopEntry(code));
    if (options.cloneForwardTails) {
      details.conditionalForwardTailClones += cloneConditionalForwardTailEntry(code);
      details.sharedFallthroughBlockClones += cloneSharedFallthroughBlocks(code);
    }
    const joinCloneClassAllowed = options.cloneSharedFallthroughJoinClasses.size === 0 ||
      options.cloneSharedFallthroughJoinClasses.has(classItem && classItem.className);
    if (options.cloneSharedFallthroughJoins && joinCloneClassAllowed) {
      details.sharedFallthroughJoinClones += cloneSharedFallthroughJoinGotos(code);
    }
    if (options.cloneSmallTerminalSharedForwardBlocks &&
      methodMatchesSmallTerminalSharedForwardBlockGate(code, options)) {
      details.smallTerminalSharedBlockClones += cloneSmallTerminalSharedForwardBlocks(code);
    }
    const conditionalJoinCloneClassAllowed = options.cloneConditionalSharedJoinClasses.size === 0 ||
      options.cloneConditionalSharedJoinClasses.has(classItem && classItem.className);
    if (options.cloneConditionalSharedJoins && conditionalJoinCloneClassAllowed &&
      methodMatchesConditionalSharedJoinGate(code, method, options)) {
      details.conditionalSharedJoinClones += cloneConditionalSharedJoinBranches(code);
    }
    if (options.cloneSharedPureForwardJoins &&
      methodMatchesSharedPureForwardJoinGate(code, options)) {
      details.sharedPureForwardJoinClones += cloneSharedPureForwardJoinBranches(code, {
        maxInsns: options.cloneSharedPureForwardJoinMaxInsns,
        maxRefs: options.cloneSharedPureForwardJoinMaxRefs,
      }, passFacts());
    }
    if (options.cloneSharedSideEffectJoins) {
      details.sharedSideEffectJoinClones += cloneSharedSideEffectJoinBranches(code, {
        maxInsns: options.cloneSharedSideEffectJoinMaxInsns,
        maxRefs: options.cloneSharedSideEffectJoinMaxRefs,
      }, passFacts());
    }
    if (options.cloneLongCompareSharedJoins && methodMatchesLongCompareSharedJoinGate(code, options)) {
      details.longCompareSharedJoinClones += cloneConditionalSharedJoinBranches(code, {
        requireLongCompareBranch: true,
      });
    }
    const conditionalLoopTailCloneClassAllowed = options.cloneConditionalSharedLoopTailClasses.size === 0 ||
      options.cloneConditionalSharedLoopTailClasses.has(classItem && classItem.className);
    if (options.cloneConditionalSharedLoopTails && conditionalLoopTailCloneClassAllowed) {
      details.conditionalSharedLoopTailClones += cloneConditionalSharedLoopTails(code);
    }
    if (options.materializeNullableSharedJoinGuards &&
      methodMatchesNullableSharedJoinGuardGate(code, options)) {
      details.nullableSharedJoinGuards += materializeNullableSharedJoinGuards(code);
    }
    if (options.removeConditionalFallthroughGotoBridges &&
      methodMatchesConditionalSharedJoinGate(code, method, options)) {
      details.conditionalFallthroughGotoBridges += removeConditionalFallthroughGotoBridges(code);
    }
    if (options.cloneStackConditionalTargets) {
      details.stackConditionalTargetClones += cloneStackConditionalTargets(code);
    }
    if (options.cloneForwardTerminalGotoTails) {
      const start = Date.now();
      details.forwardTerminalGotoTailClones += cloneForwardTerminalGotoTails(code, {
        maxInsns: options.cloneForwardTerminalGotoTailMaxInsns,
        maxMethodInsns: options.cloneForwardTerminalGotoTailMaxMethodInsns,
        maxClones: options.cloneForwardTerminalGotoTailMaxClones,
      });
      tracePeepholeTime(classItem, method, 'cloneForwardTerminalGotoTails', start);
    }
    if (options.cloneForwardSharedInitPrefixes) {
      const start = Date.now();
      details.forwardSharedInitPrefixClones += cloneForwardSharedInitPrefixes(code, {
        maxInsns: options.cloneForwardSharedInitPrefixMaxInsns,
        maxClones: options.cloneForwardSharedInitPrefixMaxClones,
      });
      tracePeepholeTime(classItem, method, 'cloneForwardSharedInitPrefixes', start);
    }
    if (options.cloneBoundedTerminalGotoTails) {
      const start = Date.now();
      details.boundedTerminalGotoTailClones += cloneBoundedTerminalGotoTails(code, {
        maxInsns: options.cloneBoundedTerminalGotoTailMaxInsns,
        maxClones: options.cloneBoundedTerminalGotoTailMaxClones,
      });
      tracePeepholeTime(classItem, method, 'cloneBoundedTerminalGotoTails', start);
    }
    if (options.cloneLoopValueContinuations) {
      const start = Date.now();
      details.loopValueContinuationClones += cloneLoopValueContinuations(code, {
        maxClones: options.cloneLoopValueContinuationMaxClones,
      });
      tracePeepholeTime(classItem, method, 'cloneLoopValueContinuations', start);
    }
    if (options.cloneConditionalTerminalTails) {
      const start = Date.now();
      details.conditionalTerminalTailClones += cloneConditionalTerminalTails(code, {
        maxInsns: options.cloneConditionalTerminalTailMaxInsns,
        maxMethodInsns: options.cloneConditionalTerminalTailMaxMethodInsns,
        maxClones: options.cloneConditionalTerminalTailMaxClones,
      });
      tracePeepholeTime(classItem, method, 'cloneConditionalTerminalTails', start);
    }
    const classAllowed = options.invertConditionalsOverGotoClasses.size === 0 ||
      options.invertConditionalsOverGotoClasses.has(classItem && classItem.className);
    if ((method && method.name === '<init>') ||
      (options.invertConditionalsOverGoto && classAllowed && (!method || method.name !== '<clinit>'))) {
      details.invertedFallthroughGotos += invertConditionalOverGoto(code);
    }
    if (options.removeDeadGotoIslands) {
      details.deadGotoIslands += tracePeepholeStep(classItem, method, 'removeDeadGotoIslandsAfterTerminals', () => removeDeadGotoIslandsAfterTerminals(code));
    }
    if ((method && method.name === '<init>') || options.removeUnreachableUntilUsedLabels) {
      details.unreachableInstructions += tracePeepholeStep(classItem, method, 'removeUnreachableUntilUsedLabel', () => removeUnreachableUntilUsedLabel(code));
    }
    details.fallthroughGotos += tracePeepholeStep(classItem, method, 'removeSingleUseFallthroughGotos', () => removeSingleUseFallthroughGotos(code, { allowMultiUse: method && method.name === '<init>' }));
    if (options.removeUnreachableCode !== false) {
      details.unreachableInstructions += tracePeepholeStep(classItem, method, 'removeUnreachableAfterTerminal', () => removeUnreachableAfterTerminal(code));
    }
    details.unusedLabels += tracePeepholeStep(classItem, method, 'removeUnusedLabels', () => removeUnusedLabels(code));
    details.restoredPcTargetLabels += tracePeepholeStep(classItem, method, 'restoreMissingPcTargetLabels', () => restoreMissingPcTargetLabels(code));
  });
  return details;
}

function tracePeepholeTime(classItem, method, name, startMs) {
  if (!tracePeepholeTimes) return;
  const elapsed = Date.now() - startMs;
  if (elapsed < 25) return;
  const className = classItem && classItem.className ? classItem.className : '?';
  const methodName = method && method.name ? method.name : '?';
  const descriptor = method && method.descriptor ? method.descriptor : '';
  console.error(`PEEPHOLE_TRACE ${className}.${methodName}${descriptor} ${name} ${elapsed}ms`);
}

function tracePeepholeStep(classItem, method, name, fn) {
  if (!tracePeepholeTimes) return fn();
  const start = Date.now();
  const result = fn();
  tracePeepholeTime(classItem, method, name, start);
  return result;
}

function createPeepholePassFacts(code) {
  return createMethodFacts(code, {
    analyzeRegion,
    regionTouchesProtectedLabel,
    opcodeMnemonic,
    isTerminalOpcode,
  });
}

function cachedAnalyzeRegion(facts, code, startIdx, endIdx, options) {
  if (!facts || facts.code !== code) return analyzeRegion(code, startIdx, endIdx, options);
  return facts.analyzeRegion(startIdx, endIdx, options);
}

function cachedRegionTouchesProtectedLabel(facts, code, startIdx, endIdx) {
  if (!facts || facts.code !== code) return regionTouchesProtectedLabel(code, startIdx, endIdx);
  return facts.regionTouchesProtectedLabel(startIdx, endIdx);
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
  for (let i = codeItems.length - 1; i >= 0; i -= 1) {
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

function threadBranchesThroughGoto(codeItems, context = null) {
  let changed = 0;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
  for (const item of codeItems) {
    if (!item || !item.instruction || !isConditionalBranch(getOpcode(item.instruction))) continue;
    const target = trimLabel(getInstructionArg(item.instruction));
    if (!target) continue;
    if ((refCounts.get(target) || 0) !== 1) continue;
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

function threadMultiUseGotoBridges(code, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refsByLabel = context ? context.branchRefsByLabel() : collectBranchRefsByLabel(codeItems);
  let changed = 0;
  const maxRefs = 500;

  for (const [label, refs] of refsByLabel.entries()) {
    if (changed >= maxRefs || refs.length < 2) continue;
    const targetIdx = labelIndex.get(label);
    if (targetIdx == null) continue;
    if (isLabelProtected(code, label)) continue;
    if (hasImmediateFallthroughPredecessor(codeItems, targetIdx)) continue;
    if (!refs.every((ref) => ref.idx !== targetIdx && isBranchOpcode(opcodeMnemonic(ref.item && ref.item.instruction)))) continue;

    const bridge = firstInstructionAtLabel(codeItems, labelIndex, label);
    if (!bridge || opcodeMnemonic(bridge.instruction) !== 'goto') continue;
    const successor = trimLabel(getBranchArg(bridge.instruction));
    if (!successor || successor === label || !labelIndex.has(successor)) continue;
    if (isLabelProtected(code, successor)) continue;

    for (const ref of refs) {
      ref.item.instruction = setBranchArg(ref.item.instruction, successor);
      changed += 1;
      if (changed >= maxRefs) break;
    }
  }

  if (changed > 0 && context && typeof context.invalidate === 'function') context.invalidate();
  return changed;
}

function coalesceProtectedLoadBridges(code, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
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

function stripMonitorWaitExceptionRegions(code, method) {
  if (!method || method.name !== 'run' || method.descriptor !== '()V') return 0;
  const codeItems = code.codeItems || [];
  if (!hasOpcode(codeItems, 'monitorenter') || !hasOpcode(codeItems, 'monitorexit')) return 0;
  if (!hasObjectWaitCall(codeItems)) return 0;
  if (!hasOutputStreamWriteCall(codeItems)) return 0;
  const exceptionTable = Array.isArray(code.exceptionTable) ? code.exceptionTable : [];
  const hasMonitorFinally = exceptionTable.some((entry) =>
    isAnyCatch(entry) && handlerHasMonitorRethrow(codeItems, entry.handlerLbl || entry.handlerLabel || entry.handler || entry.usingLbl));
  const hasInterruptedWaitCatch = exceptionTable.some((entry) =>
    entry && entry.catch_type === 'java/lang/InterruptedException');
  if (!hasMonitorFinally || !hasInterruptedWaitCatch) return 0;

  let rewrites = 0;
  for (const item of codeItems) {
    const opcode = getOpcode(item && item.instruction);
    if (opcode !== 'monitorenter' && opcode !== 'monitorexit') continue;
    item.instruction = 'pop';
    delete item.pc;
    rewrites += 1;
  }
  code.exceptionTable = exceptionTable.filter((entry) =>
    !(isAnyCatch(entry) || (entry && entry.catch_type === 'java/lang/InterruptedException')));
  return rewrites > 0 ? 1 : 0;
}

function hasOpcode(codeItems, opcode) {
  return codeItems.some((item) => getOpcode(item && item.instruction) === opcode);
}

function hasObjectWaitCall(codeItems) {
  return codeItems.some((item) => {
    const instruction = item && item.instruction;
    if (getOpcode(instruction) !== 'invokevirtual') return false;
    const arg = getInstructionArg(instruction);
    return Array.isArray(arg) && arg[0] === 'Method' && arg[1] === 'java/lang/Object' &&
      Array.isArray(arg[2]) && arg[2][0] === 'wait';
  });
}

function hasOutputStreamWriteCall(codeItems) {
  return codeItems.some((item) => {
    const instruction = item && item.instruction;
    if (getOpcode(instruction) !== 'invokevirtual') return false;
    const arg = getInstructionArg(instruction);
    return Array.isArray(arg) && arg[0] === 'Method' && arg[1] === 'java/io/OutputStream' &&
      Array.isArray(arg[2]) && arg[2][0] === 'write';
  });
}

function isAnyCatch(entry) {
  return entry && (entry.catch_type === 'any' || entry.catchType === 'any' || entry.catchType === null);
}

function handlerHasMonitorRethrow(codeItems, handlerLabel) {
  const start = findLabelIndexInItems(codeItems, handlerLabel);
  if (start < 0) return false;
  let sawMonitorExit = false;
  const end = Math.min(codeItems.length, start + 12);
  for (let i = start; i < end; i += 1) {
    const opcode = getOpcode(codeItems[i] && codeItems[i].instruction);
    if (opcode === 'monitorexit') sawMonitorExit = true;
    if (opcode === 'athrow') return sawMonitorExit;
  }
  return false;
}

function normalizeDupStoreCompareBranches(code) {
  const codeItems = code.codeItems || [];
  const usedLabels = collectUsedLabels(code);
  let rewrites = 0;

  for (let i = 0; i < codeItems.length - 3; i += 1) {
    if (opcodeMnemonic(codeItems[i] && codeItems[i].instruction) !== 'dup') continue;
    const store = codeItems[i + 1];
    if (!isIntStoreInstruction(store && store.instruction)) continue;
    const storeLabel = trimLabel(store && store.labelDef);
    if (storeLabel && usedLabels.has(storeLabel)) continue;

    const compareValueIdx = nextInstructionIndex(codeItems, i + 2);
    if (compareValueIdx == null) continue;
    const compareIdx = nextInstructionIndex(codeItems, compareValueIdx + 1);
    if (compareIdx == null) continue;
    const compareOp = opcodeMnemonic(codeItems[compareIdx] && codeItems[compareIdx].instruction);
    if (!/^if_icmp/.test(compareOp || '')) continue;
    const local = intStoreLocalIndex(store.instruction);
    if (local == null) continue;

    codeItems.splice(
      i,
      2,
      itemWithReplacedInstruction(codeItems[i], cloneValue(store.instruction)),
      { instruction: { op: 'iinc', varnum: String(local), incr: '0' } },
      itemWithReplacedInstruction(store, { op: 'iload', arg: String(local) })
    );
    rewrites += 1;
    i += 1;
  }

  return rewrites;
}

function simplifyNullCompareBranches(code) {
  const codeItems = code.codeItems || [];
  let rewrites = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const first = codeItems[i];
    const secondIdx = nextInstructionIndex(codeItems, i + 1);
    const branchIdx = secondIdx == null ? null : nextInstructionIndex(codeItems, secondIdx + 1);
    if (secondIdx == null || branchIdx == null) continue;
    const second = codeItems[secondIdx];
    const branch = codeItems[branchIdx];
    const branchOp = opcodeMnemonic(branch && branch.instruction);
    if (branchOp !== 'if_acmpeq' && branchOp !== 'if_acmpne') continue;
    if (hasLabelBetween(codeItems, i + 1, branchIdx + 1)) continue;
    if ((second && second.stackMapFrame) || (branch && branch.stackMapFrame)) continue;

    const firstOp = opcodeMnemonic(first && first.instruction);
    const secondOp = opcodeMnemonic(second && second.instruction);
    let loadInstruction = null;
    let removeIdx = null;
    if (firstOp === 'aconst_null' && isReferenceLoadInstruction(second && second.instruction)) {
      loadInstruction = cloneValue(second.instruction);
      removeIdx = secondIdx;
    } else if (isReferenceLoadInstruction(first && first.instruction) && secondOp === 'aconst_null') {
      loadInstruction = cloneValue(first.instruction);
      removeIdx = secondIdx;
    } else {
      continue;
    }

    first.instruction = loadInstruction;
    branch.instruction = setOpcode(branch.instruction, branchOp === 'if_acmpeq' ? 'ifnull' : 'ifnonnull');
    removeInstructionOnly(codeItems, removeIdx);
    rewrites += 1;
  }

  return rewrites;
}

function findLabelIndexInItems(codeItems, label) {
  const target = trimLabel(label);
  return codeItems.findIndex((item) => trimLabel(item && item.labelDef) === target);
}

function cloneForwardLoopEntryGotos(code, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
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
    if ((refCounts.get(target) || 0) < 2) continue;
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

function cloneConditionalForwardLoopEntry(code, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
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

    const summary = cachedAnalyzeRegion(context, code, range.start, range.end);
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

function cloneConditionalForwardTailEntry(code, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
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

    const summary = cachedAnalyzeRegion(context, code, range.start, range.end, { allowControlFlow: true, allowSideEffects: true });
    if (!summary.supported) continue;
    if (summary.touchesProtectedLabel || summary.overlapsExceptionRange) continue;
    if (summary.stack.underflowsEntry) continue;
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

function cloneSharedFallthroughBlocks(code, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
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

    const summary = cachedAnalyzeRegion(context, code, startIdx, endIdx, { allowSideEffects: true });
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

function cloneSharedFallthroughJoinGotos(code, context = null) {
  const codeItems = code.codeItems;
  const splitTargets = getPeepholeSet(code, 'peepholeSplitSharedFallthroughJoins');
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
  let changed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || getOpcode(item.instruction) !== 'goto') continue;
    const target = trimLabel(getInstructionArg(item.instruction));
    const startIdx = labelIndex.get(target);
    if (!target || startIdx == null || startIdx <= i) continue;
    if (splitTargets.has(target) || isLabelProtected(code, target)) continue;
    if (findNextLabel(codeItems, i + 1) !== target) continue;
    if ((refCounts.get(target) || 0) < 2) continue;

    const endIdx = nextLabelIndex(codeItems, startIdx + 1);
    if (endIdx == null || endIdx <= startIdx) continue;
    const fallthroughLabel = trimLabel(codeItems[endIdx] && codeItems[endIdx].labelDef);
    if (!fallthroughLabel || isLabelProtected(code, fallthroughLabel)) continue;
    const realInsns = countInstructions(codeItems, startIdx, endIdx);
    if (realInsns === 0 || realInsns > 80) continue;

    const summary = cachedAnalyzeRegion(context, code, startIdx, endIdx, { allowControlFlow: true, allowSideEffects: true });
    if (!summary.supported) continue;
    if (summary.touchesProtectedLabel || summary.overlapsExceptionRange) continue;
    if (summary.hasTerminator || summary.stack.delta !== 0 || summary.stack.underflowsEntry) continue;
    if (summary.inboundBranches.some((b) => b.target !== target)) continue;
    if (summary.outboundBranches.some((b) => b.target !== fallthroughLabel)) continue;

    const clone = cloneRange(codeItems.slice(startIdx, endIdx), nextClonePrefix('L99'));
    if (clone.length === 0) continue;
    const replacement = [];
    if (item.labelDef || item.stackMapFrame) {
      const labelOnly = {};
      if (item.labelDef) labelOnly.labelDef = item.labelDef;
      if (item.stackMapFrame) labelOnly.stackMapFrame = cloneValue(item.stackMapFrame);
      replacement.push(labelOnly);
    }
    replacement.push(...clone);
    const last = replacement[replacement.length - 1];
    const lastOp = getOpcode(last && last.instruction);
    if (!isTerminalOpcode(lastOp)) {
      replacement.push({ instruction: { op: 'goto', arg: fallthroughLabel } });
    }
    codeItems.splice(i, 1, ...replacement);
    splitTargets.add(target);
    changed += 1;
    break;
  }

  return changed;
}

function cloneSmallTerminalSharedForwardBlocks(code, context = null) {
  const codeItems = code.codeItems;
  const splitTargets = getPeepholeSet(code, 'peepholeSplitSmallTerminalSharedBlocks');
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refsByLabel = context ? context.branchRefsByLabel() : collectBranchRefsByLabel(codeItems);
  let changed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const opcode = opcodeMnemonic(item && item.instruction);
    if (!isConditionalBranch(opcode) && opcode !== 'goto') continue;

    const target = trimLabel(getBranchArg(item.instruction));
    const startIdx = labelIndex.get(target);
    if (!target || startIdx == null || startIdx <= i) continue;
    if (splitTargets.has(target) || isLabelProtected(code, target)) continue;
    if (hasPreservationGuard(codeItems, startIdx, target)) continue;
    const refs = refsByLabel.get(target) || [];
    if (refs.length < 2 || refs.some((ref) => ref.idx >= startIdx)) continue;

    const range = findSmallTerminalForwardBlock(codeItems, startIdx, 12);
    if (!range) continue;
    if (cachedRegionTouchesProtectedLabel(context, code, range.start, range.end)) continue;
    const stack = smallTerminalBlockStackSummary(codeItems, range.start, range.end);
    if (!stack || stack.delta !== 0 || stack.underflowsEntry) continue;
    if (!stack.hasObservableSideEffects && !(stack.hasLocalMutation && terminalBranchesBackward(codeItems, labelIndex, range))) {
      continue;
    }
    if (hasBranchToLabelBetween(codeItems, range.start, range.end - 1, target)) continue;

    const insert = [{ instruction: { op: 'goto', arg: target }, peepholeGuard: true }];
    for (const ref of refs) {
      const clone = cloneRange(codeItems.slice(range.start, range.end), nextClonePrefix('Lst'));
      const cloneEntry = trimLabel(clone[0] && clone[0].labelDef);
      if (!cloneEntry) continue;
      insert.push(...clone);
      ref.item.instruction = setBranchArg(ref.item.instruction, cloneEntry);
    }
    if (insert.length <= 1) continue;
    codeItems.splice(startIdx, 0, ...insert);
    splitTargets.add(target);
    changed += refs.length;
    break;
  }

  return changed;
}

function cloneConditionalSharedJoinBranches(code, options = {}, context = null) {
  const codeItems = code.codeItems;
  const splitTargets = getPeepholeSet(code, 'peepholeSplitConditionalSharedJoins');
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
  let changed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const opcode = opcodeMnemonic(item && item.instruction);
    if (!isConditionalBranch(opcode)) continue;
    if (options.requireLongCompareBranch) {
      const prevIdx = previousInstructionIndex(codeItems, i - 1);
      if (prevIdx == null || opcodeMnemonic(codeItems[prevIdx] && codeItems[prevIdx].instruction) !== 'lcmp') continue;
    }
    const target = trimLabel(getBranchArg(item.instruction));
    if (!target || splitTargets.has(target)) continue;

    const startIdx = labelIndex.get(target);
    if (startIdx == null || startIdx <= i) continue;
    if (isLabelProtected(code, target) || hasPreservationGuard(codeItems, startIdx, target)) continue;
    if ((refCounts.get(target) || 0) < 2) continue;

    const endIdx = nextLabelIndex(codeItems, startIdx + 1);
    if (endIdx == null || endIdx <= startIdx) continue;
    const fallthroughLabel = trimLabel(codeItems[endIdx] && codeItems[endIdx].labelDef);
    if (!fallthroughLabel || isLabelProtected(code, fallthroughLabel)) continue;
    const realInsns = countInstructions(codeItems, startIdx, endIdx);
    if (realInsns === 0 || realInsns > 12) continue;
    if (options.requireLongCompareBranch && realInsns < 4) continue;
    if (hasInternalControlFlowBeforeEnd(codeItems, startIdx, endIdx)) continue;

    const clone = cloneRange(codeItems.slice(startIdx, endIdx), nextClonePrefix('Lcsj'));
    const cloneEntry = trimLabel(clone[0] && clone[0].labelDef);
    if (!cloneEntry) continue;
    const last = clone[clone.length - 1];
    const lastOp = opcodeMnemonic(last && last.instruction);
    if (!isTerminalOpcode(lastOp)) {
      clone.push({ instruction: { op: 'goto', arg: fallthroughLabel } });
    }

    codeItems.splice(startIdx, 0, { instruction: { op: 'goto', arg: target }, peepholeGuard: true }, ...clone);
    item.instruction = setBranchArg(item.instruction, cloneEntry);
    splitTargets.add(target);
    changed += 1;
    break;
  }

  return changed;
}

function cloneSharedPureForwardJoinBranches(code, options = {}, context = null) {
  const codeItems = code.codeItems;
  const splitTargets = getPeepholeSet(code, 'peepholeSplitSharedPureForwardJoins');
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refsByLabel = context ? context.branchRefsByLabel() : collectBranchRefsByLabel(codeItems);
  const maxInsns = Math.max(1, Number(options.maxInsns || 6));
  const maxRefs = Math.max(2, Number(options.maxRefs || 8));
  let changed = 0;

  for (const [target, startIdx] of labelIndex.entries()) {
    if (splitTargets.has(target)) continue;
    if (isLabelProtected(code, target) || hasPreservationGuard(codeItems, startIdx, target)) continue;
    if (hasFallthroughPredecessor(codeItems, labelIndex, target)) continue;

    const refs = (refsByLabel.get(target) || [])
      .filter((ref) => ref.idx < startIdx && isBranchOpcode(opcodeMnemonic(ref.item && ref.item.instruction)));
    if (refs.length < 2 || refs.length > maxRefs) continue;

    const endIdx = nextLabelIndex(codeItems, startIdx + 1);
    if (endIdx == null || endIdx <= startIdx) continue;
    const fallthroughLabel = trimLabel(codeItems[endIdx] && codeItems[endIdx].labelDef);
    if (!fallthroughLabel || isLabelProtected(code, fallthroughLabel)) continue;

    const realInsns = countInstructions(codeItems, startIdx, endIdx);
    if (realInsns === 0 || realInsns > maxInsns) continue;
    if (!isReferenceArrayLoadStoreJoin(codeItems, startIdx, endIdx)) continue;
    const summary = cachedAnalyzeRegion(context, code, startIdx, endIdx, { allowMayThrow: true });
    if (!summary.supported) continue;
    if (summary.touchesProtectedLabel || summary.overlapsExceptionRange) continue;
    if (summary.hasControlFlow || summary.hasTerminator || summary.hasObservableSideEffects) continue;
    if (summary.stack.delta !== 0 || summary.stack.underflowsEntry) continue;
    if (summary.written.size !== 1 || summary.writtenAndLiveOut.size !== 1) continue;
    if (summary.inboundBranches.some((branch) => branch.target !== target)) continue;

    const insert = [{ instruction: { op: 'goto', arg: target }, peepholeGuard: true }];
    for (const ref of refs) {
      const clone = cloneRange(codeItems.slice(startIdx, endIdx), nextClonePrefix('Lspf'));
      const cloneEntry = trimLabel(clone[0] && clone[0].labelDef);
      if (!cloneEntry) continue;
      const last = clone[clone.length - 1];
      const lastOp = opcodeMnemonic(last && last.instruction);
      if (!isTerminalOpcode(lastOp)) {
        clone.push({ instruction: { op: 'goto', arg: fallthroughLabel } });
      }
      insert.push(...clone);
      ref.item.instruction = setBranchArg(ref.item.instruction, cloneEntry);
    }
    if (insert.length <= 1) continue;
    codeItems.splice(startIdx, 0, ...insert);
    splitTargets.add(target);
    changed += refs.length;
    break;
  }

  return changed;
}

function cloneSharedSideEffectJoinBranches(code, options = {}, context = null) {
  const codeItems = code.codeItems;
  const splitTargets = getPeepholeSet(code, 'peepholeSplitSharedSideEffectJoins');
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refsByLabel = context ? context.branchRefsByLabel() : collectBranchRefsByLabel(codeItems);
  const maxInsns = Math.max(1, Number(options.maxInsns || 32));
  const maxRefs = Math.max(2, Number(options.maxRefs || 4));
  let changed = 0;

  for (const [target, startIdx] of labelIndex.entries()) {
    if (splitTargets.has(target)) continue;
    if (isLabelProtected(code, target) || hasPreservationGuard(codeItems, startIdx, target)) continue;
    if (hasImmediateFallthroughPredecessor(codeItems, startIdx)) continue;

    const refs = (refsByLabel.get(target) || [])
      .filter((ref) => ref.idx < startIdx && isBranchOpcode(opcodeMnemonic(ref.item && ref.item.instruction)));
    if (refs.length < 2 || refs.length > maxRefs) continue;

    const endIdx = nextLabelIndex(codeItems, startIdx + 1);
    if (endIdx == null || endIdx <= startIdx) continue;
    const fallthroughLabel = trimLabel(codeItems[endIdx] && codeItems[endIdx].labelDef);
    if (!fallthroughLabel || isLabelProtected(code, fallthroughLabel)) continue;

    const realInsns = countInstructions(codeItems, startIdx, endIdx);
    if (realInsns === 0 || realInsns > maxInsns) continue;
    const summary = cachedAnalyzeRegion(context, code, startIdx, endIdx, { allowSideEffects: true, allowMayThrow: true });
    if (!summary.supported) continue;
    if (summary.touchesProtectedLabel || summary.overlapsExceptionRange) continue;
    if (summary.hasControlFlow || summary.hasTerminator || !summary.hasObservableSideEffects) continue;
    if (summary.stack.delta !== 0 || summary.stack.underflowsEntry) continue;
    if (summary.inboundBranches.some((branch) => branch.target !== target)) continue;

    const insert = [{ instruction: { op: 'goto', arg: target }, peepholeGuard: true }];
    for (const ref of refs) {
      const clone = cloneRange(codeItems.slice(startIdx, endIdx), nextClonePrefix('Lsse'));
      const cloneEntry = trimLabel(clone[0] && clone[0].labelDef);
      if (!cloneEntry) continue;
      clone.push({ instruction: { op: 'goto', arg: fallthroughLabel } });
      insert.push(...clone);
      ref.item.instruction = setBranchArg(ref.item.instruction, cloneEntry);
    }
    if (insert.length <= 1) continue;
    codeItems.splice(startIdx, 0, ...insert);
    splitTargets.add(target);
    changed += refs.length;
    break;
  }

  if (changed > 0 && context && typeof context.invalidate === 'function') context.invalidate();
  return changed;
}

function isReferenceArrayLoadStoreJoin(codeItems, startIdx, endIdx) {
  let sawAaload = false;
  let storeCount = 0;
  for (let i = startIdx; i < endIdx; i += 1) {
    const instruction = codeItems[i] && codeItems[i].instruction;
    const opcode = opcodeMnemonic(instruction);
    if (!opcode) continue;
    if (opcode === 'aaload') {
      sawAaload = true;
      continue;
    }
    if (astoreLocalIndex(instruction) != null) {
      storeCount += 1;
      continue;
    }
    if (opcode === 'aload' || opcode === 'iload' ||
      /^aload_[0-3]$/.test(opcode) || /^iload_[0-3]$/.test(opcode)) {
      continue;
    }
    return false;
  }
  return sawAaload && storeCount === 1;
}

function cloneConditionalSharedLoopTails(code, context = null) {
  const codeItems = code.codeItems;
  const splitTargets = getPeepholeSet(code, 'peepholeSplitConditionalSharedLoopTails');
  if (splitTargets.size > 0) return 0;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
  let changed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const opcode = opcodeMnemonic(item && item.instruction);
    if (!isConditionalBranch(opcode)) continue;
    const target = trimLabel(getBranchArg(item.instruction));
    if (!target || splitTargets.has(target)) continue;

    const startIdx = labelIndex.get(target);
    if (startIdx == null || startIdx <= i) continue;
    if (isLabelProtected(code, target) || hasPreservationGuard(codeItems, startIdx, target)) continue;
    if ((refCounts.get(target) || 0) < 2) continue;

    const range = findLoopTailRangeEndingAtBackedge(codeItems, labelIndex, startIdx);
    if (!range) continue;
    const realInsns = countInstructions(codeItems, range.start, range.end);
    if (realInsns < 100 || realInsns > 320) continue;

    const clone = cloneRange(codeItems.slice(range.start, range.end), nextClonePrefix('Lctl'));
    const cloneEntry = trimLabel(clone[0] && clone[0].labelDef);
    if (!cloneEntry) continue;

    codeItems.splice(startIdx, 0, { instruction: { op: 'goto', arg: target }, peepholeGuard: true }, ...clone);
    item.instruction = setBranchArg(item.instruction, cloneEntry);
    splitTargets.add(target);
    changed += 1;
    break;
  }

  return changed;
}

function materializeNullableSharedJoinGuards(code, context = null) {
  const codeItems = code.codeItems;
  const guardedTargets = getPeepholeSet(code, 'peepholeNullableSharedJoinGuards');
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
  let changed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const opcode = opcodeMnemonic(item && item.instruction);
    if (!isNonNullConditional(opcode)) continue;

    const local = referenceLoadLocalBeforeBranch(codeItems, i);
    if (local == null) continue;

    const target = trimLabel(getBranchArg(item.instruction));
    if (!target || guardedTargets.has(target)) continue;
    const targetIdx = labelIndex.get(target);
    if (targetIdx == null || targetIdx <= i) continue;
    if (isLabelProtected(code, target) || hasPreservationGuard(codeItems, targetIdx, target)) continue;
    if ((refCounts.get(target) || 0) < 2) continue;
    const targetInsnIdx = firstInstructionIndexAtOrAfter(codeItems, targetIdx);
    if (targetInsnIdx == null) continue;
    if (hasLabelBetween(codeItems, targetIdx + 1, targetInsnIdx + 1)) continue;
    if (!isAloadLocal(codeItems[targetInsnIdx] && codeItems[targetInsnIdx].instruction, local)) continue;

    const skip = findNullableJoinSkipGoto(codeItems, i + 1, targetIdx, local);
    if (!skip) continue;
    const exitLabel = skip.exitLabel;
    const exitIdx = labelIndex.get(exitLabel);
    if (exitIdx == null || exitIdx <= targetInsnIdx || isLabelProtected(code, exitLabel)) continue;
    if (countInstructions(codeItems, targetInsnIdx, exitIdx) > 14) continue;
    if (hasBranchToLabelBetween(codeItems, targetInsnIdx, exitIdx, target)) continue;
    if (!hasReferenceStoreBetween(codeItems, i + 1, skip.gotoIdx, local)) continue;

    codeItems[skip.gotoIdx].instruction = setBranchArg(codeItems[skip.gotoIdx].instruction, target);
    insertNullGuardAtLabel(codeItems, targetIdx, local, exitLabel);
    guardedTargets.add(target);
    changed += 1;
    break;
  }

  return changed;
}

function coalesceLoopProducerBridges(code, options = {}, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const allowProtectedProducer = options.allowProtectedProducer === true;
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
    if (!producerLabel) continue;
    if (!allowProtectedProducer && isLabelProtected(code, producerLabel)) continue;
    if (!sameInstruction(item.instruction, producer.instruction)) continue;
    if (nextInstructionIndex(codeItems, producerIdx + 1) !== targetIdx) continue;
    if (!hasBackwardGotoToLabel(codeItems, labelIndex, producerLabel, targetIdx + 1)) continue;

    item.instruction = { op: 'goto', arg: producerLabel };
    removeInstructionOnly(codeItems, gotoIdx);
    changed += 1;
  }

  return changed;
}

function coalesceDuplicateLoopTails(code, context = null) {
  const codeItems = code.codeItems;
  if (!hasPotentialDuplicateLoopTail(codeItems)) return 0;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  let changed = 0;

  for (let gotoIdx = 0; gotoIdx < codeItems.length; gotoIdx += 1) {
    const item = codeItems[gotoIdx];
    if (!item || !item.instruction || getOpcode(item.instruction) !== 'goto') continue;
    const loopHead = trimLabel(getInstructionArg(item.instruction));
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

function coalesceDuplicateLoopIncrementTails(code, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refsByLabel = context ? context.branchRefsByLabel() : collectBranchRefsByLabel(codeItems);
  const groups = new Map();
  let changed = 0;
  const maxChanges = 80;

  for (let i = 0; i + 1 < codeItems.length; i += 1) {
    const label = trimLabel(codeItems[i] && codeItems[i].labelDef);
    if (!label || isSharedLoopIncrementCloneLabel(label) || isLabelProtected(code, label)) continue;
    const iinc = readIincInstruction(codeItems[i] && codeItems[i].instruction);
    if (!iinc) continue;
    const jump = codeItems[i + 1] && codeItems[i + 1].instruction;
    if (opcodeMnemonic(jump) !== 'goto') continue;
    const loopHead = trimLabel(getBranchArg(jump));
    const loopHeadIdx = labelIndex.get(loopHead);
    if (loopHeadIdx == null || loopHeadIdx >= i) continue;
    if (!looksLikeLoopHeader(codeItems, loopHeadIdx)) continue;
    const refs = refsByLabel.get(label) || [];
    if (refs.length === 0) continue;
    if (!refs.every((ref) => isBranchOpcode(opcodeMnemonic(ref.item && ref.item.instruction)))) continue;

    const key = `${iinc.local}:${iinc.incr}->${loopHead}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push({ idx: i, label, hasFallthrough: hasImmediateFallthroughPredecessor(codeItems, i), refs });
  }

  for (const group of groups.values()) {
    if (changed >= maxChanges || group.length < 2) continue;
    group.sort((a, b) => Number(b.hasFallthrough) - Number(a.hasFallthrough) || a.idx - b.idx);
    const canonical = group[0];
    for (const tail of group.slice(1)) {
      if (changed >= maxChanges) break;
      if (tail.hasFallthrough) continue;
      if (!tail.refs.every((ref) => ref.idx !== tail.idx && isBranchOpcode(opcodeMnemonic(ref.item && ref.item.instruction)))) continue;
      for (const ref of tail.refs) {
        ref.item.instruction = setBranchArg(ref.item.instruction, canonical.label);
      }
      changed += 1;
    }
  }

  if (changed > 0 && context && typeof context.invalidate === 'function') context.invalidate();
  return changed;
}

function cloneSharedLoopIncrementTails(code, options = {}, context = null) {
  const codeItems = code.codeItems;
  const splitTargets = getPeepholeSet(code, 'peepholeSplitSharedLoopIncrementTails');
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refsByLabel = context ? context.branchRefsByLabel() : collectBranchRefsByLabel(codeItems);
  const maxInsns = Math.max(2, Number(options.maxInsns || 4));
  const maxRefs = Math.max(1, Number(options.maxRefs || 8));

  for (const [target, startIdx] of labelIndex.entries()) {
    if (splitTargets.has(target)) continue;
    if (isLabelProtected(code, target) || hasPreservationGuard(codeItems, startIdx, target)) continue;

    const refs = (refsByLabel.get(target) || [])
      .filter((ref) => ref.idx < startIdx && isBranchOpcode(opcodeMnemonic(ref.item && ref.item.instruction)));
    const hasFallthrough = hasImmediateFallthroughPredecessor(codeItems, startIdx);
    if (refs.length === 0 || refs.length > maxRefs) continue;
    if (refs.length + (hasFallthrough ? 1 : 0) < 2) continue;

    const tail = readSharedLoopIncrementTail(code, codeItems, labelIndex, refsByLabel, startIdx, maxInsns);
    if (!tail) continue;
    if (cachedRegionTouchesProtectedLabel(context, code, startIdx, tail.end)) continue;

    const insert = [{ instruction: { op: 'goto', arg: target }, peepholeGuard: true }];
    let clonedRefs = 0;
    for (const ref of refs) {
      const clone = cloneRange(codeItems.slice(startIdx, tail.end), nextClonePrefix('Lsit'));
      const cloneEntry = trimLabel(clone[0] && clone[0].labelDef);
      if (!cloneEntry) continue;
      insert.push(...clone);
      ref.item.instruction = setBranchArg(ref.item.instruction, cloneEntry);
      clonedRefs += 1;
    }
    if (clonedRefs === 0) continue;
    codeItems.splice(startIdx, 0, ...insert);
    splitTargets.add(target);
    if (context && typeof context.invalidate === 'function') context.invalidate();
    return clonedRefs;
  }

  return 0;
}

function readSharedLoopIncrementTail(code, codeItems, labelIndex, refsByLabel, startIdx, maxInsns) {
  let sawIncrement = false;
  let real = 0;
  for (let i = startIdx; i < codeItems.length && real < maxInsns; i += 1) {
    const label = trimLabel(codeItems[i] && codeItems[i].labelDef);
    if (i > startIdx && label && isLabelProtected(code, label)) return null;
    const instruction = codeItems[i] && codeItems[i].instruction;
    const opcode = opcodeMnemonic(instruction);
    if (!opcode) continue;
    real += 1;

    if (opcode === 'iinc') {
      sawIncrement = true;
      continue;
    }

    if (opcode !== 'goto') return null;
    if (!sawIncrement) return null;
    const loopHead = trimLabel(getBranchArg(instruction));
    const loopHeadIdx = labelIndex.get(loopHead);
    if (loopHeadIdx == null || loopHeadIdx >= startIdx) return null;
    if (!looksLikeLoopHeader(codeItems, loopHeadIdx)) return null;

    for (let j = startIdx + 1; j <= i; j += 1) {
      const innerLabel = trimLabel(codeItems[j] && codeItems[j].labelDef);
      if (!innerLabel) continue;
      const innerRefs = refsByLabel.get(innerLabel) || [];
      if (innerRefs.some((ref) => ref.idx >= i || ref.idx < startIdx)) return null;
    }
    return { end: i + 1, loopHead };
  }
  return null;
}

function coalesceDuplicateLoopBackedgeTails(code, context = null) {
  const codeItems = code.codeItems;
  const refsByLabel = context ? context.branchRefsByLabel() : collectBranchRefsByLabel(codeItems);
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const groups = new Map();
  let changed = 0;
  const maxChanges = 80;

  for (let i = 0; i < codeItems.length; i += 1) {
    const label = trimLabel(codeItems[i] && codeItems[i].labelDef);
    if (!label || isLabelProtected(code, label)) continue;
    const refs = refsByLabel.get(label) || [];
    if (refs.length === 0) continue;
    if (!refs.every((ref) => isBranchOpcode(opcodeMnemonic(ref.item && ref.item.instruction)))) continue;
    const tail = readDuplicateBackedgeTail(code, codeItems, labelIndex, refsByLabel, i);
    if (!tail) continue;
    let group = groups.get(tail.signature);
    if (!group) {
      group = [];
      groups.set(tail.signature, group);
    }
    group.push({ idx: i, label, refs, hasFallthrough: hasImmediateFallthroughPredecessor(codeItems, i) });
  }

  for (const group of groups.values()) {
    if (changed >= maxChanges || group.length < 2) continue;
    group.sort((a, b) => Number(b.hasFallthrough) - Number(a.hasFallthrough) || a.idx - b.idx);
    const canonical = group[0];
    for (const tail of group.slice(1)) {
      if (changed >= maxChanges) break;
      if (tail.hasFallthrough) continue;
      if (!tail.refs.every((ref) => ref.idx !== tail.idx && isBranchOpcode(opcodeMnemonic(ref.item && ref.item.instruction)))) continue;
      for (const ref of tail.refs) {
        ref.item.instruction = setBranchArg(ref.item.instruction, canonical.label);
      }
      changed += 1;
    }
  }

  if (changed > 0 && context && typeof context.invalidate === 'function') context.invalidate();
  return changed;
}

function readDuplicateBackedgeTail(code, codeItems, labelIndex, refsByLabel, startIdx) {
  if (readLoopValueContinuationBlock(codeItems, labelIndex, startIdx)) return null;
  const signature = [];
  let real = 0;
  for (let i = startIdx; i < Math.min(codeItems.length, startIdx + 8); i += 1) {
    const instruction = codeItems[i] && codeItems[i].instruction;
    const opcode = opcodeMnemonic(instruction);
    if (!opcode) continue;
    const label = trimLabel(codeItems[i] && codeItems[i].labelDef);
    if (i > startIdx && label && (isLabelProtected(code, label) || (refsByLabel.get(label) || []).length > 0)) return null;
    real += 1;
    signature.push(instructionSignature(instruction));
    if (opcode === 'goto') {
      const target = trimLabel(getBranchArg(instruction));
      const targetIdx = labelIndex.get(target);
      if (targetIdx == null || targetIdx >= startIdx || real < 2) return null;
      if (!looksLikeLoopHeader(codeItems, targetIdx)) return null;
      return { end: i, signature: signature.join('|') };
    }
    if (real > 1 && isBranchOpcode(opcode)) return null;
  }
  return null;
}

function hasPotentialDuplicateLoopTail(codeItems) {
  for (let gotoIdx = 0; gotoIdx < codeItems.length; gotoIdx += 1) {
    const item = codeItems[gotoIdx];
    if (!item || !item.instruction || getOpcode(item.instruction) !== 'goto') continue;
    let start = previousInstructionIndex(codeItems, gotoIdx - 1);
    for (let count = 1; start != null && count <= 12; count += 1) {
      if (codeItems[start] && codeItems[start].labelDef) break;
      const prev = previousInstructionIndex(codeItems, start - 1);
      if (prev != null && isConditionalBranch(getOpcode(codeItems[prev] && codeItems[prev].instruction)) &&
        instructionSlice(codeItems, start, gotoIdx).some((instruction) => opcodeMnemonic(instruction) === 'iinc')) {
        return true;
      }
      start = prev;
    }
  }
  return false;
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

function looksLikeLoopHeader(codeItems, idx) {
  for (let i = idx; i < Math.min(codeItems.length, idx + 8); i += 1) {
    if (isBranchOpcode(opcodeMnemonic(codeItems[i] && codeItems[i].instruction))) return true;
  }
  return false;
}

function hasImmediateFallthroughPredecessor(codeItems, idx) {
  const prev = previousInstructionIndex(codeItems, idx - 1);
  return prev != null && !isTerminalOpcode(opcodeMnemonic(codeItems[prev] && codeItems[prev].instruction));
}

function readIincInstruction(instruction) {
  if (opcodeMnemonic(instruction) !== 'iinc') return null;
  let local;
  let incr;
  if (instruction && typeof instruction === 'object' && instruction.varnum !== undefined) {
    local = Number(instruction.varnum);
    incr = Number(instruction.incr);
  } else if (instruction && typeof instruction === 'object' && Array.isArray(instruction.arg)) {
    local = Number(instruction.arg[0]);
    incr = Number(instruction.arg[1]);
  } else if (typeof instruction === 'string') {
    const parts = instruction.trim().split(/\s+/);
    local = Number(parts[1]);
    incr = Number(parts[2]);
  } else {
    const parts = String(instruction && instruction.arg || '').split(/\s+/);
    local = Number(parts[0]);
    incr = Number(parts[1]);
  }
  if (!Number.isFinite(local) || !Number.isFinite(incr)) return null;
  return { local, incr };
}

function instructionSignature(instruction) {
  return JSON.stringify([opcodeMnemonic(instruction), normalizeSignatureValue(instructionSignatureArg(instruction))]);
}

function instructionSignatureArg(instruction) {
  if (!instruction) return null;
  if (typeof instruction === 'string') {
    const parts = instruction.trim().split(/\s+/);
    return parts.slice(1).join(' ') || null;
  }
  if (instruction.varnum !== undefined) return [instruction.varnum, instruction.incr];
  return instruction.arg;
}

function normalizeSignatureValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalizeSignatureValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'pc' || key === 'cp_index') continue;
      out[key] = normalizeSignatureValue(entry);
    }
    return out;
  }
  return value;
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

function removeSingleUseFallthroughGotos(code, options = {}, context = null) {
  let removed = 0;
  const codeItems = code.codeItems;
  const refCounts = options.allowMultiUse
    ? null
    : (context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems));
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction || getOpcode(item.instruction) !== 'goto') continue;
    const target = trimLabel(getInstructionArg(item.instruction));
    if (!target) continue;
    const nextLabel = findNextLabel(codeItems, i + 1);
    if (target !== nextLabel) continue;
    if (isLabelProtected(code, target)) continue;
    if (!options.allowMultiUse && (refCounts.get(target) || 0) !== 1) continue;
    removeInstructionOnly(codeItems, i);
    if (refCounts) refCounts.set(target, Math.max(0, (refCounts.get(target) || 0) - 1));
    removed += 1;
    if (!codeItems[i] || !codeItems[i].instruction) {
      i -= 1;
    }
  }
  return removed;
}

function removeConditionalFallthroughGotoBridges(code, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
  let removed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const opcode = opcodeMnemonic(item && item.instruction);
    if (!isConditionalBranch(opcode)) continue;

    const bridgeLabel = trimLabel(getBranchArg(item.instruction));
    if (!bridgeLabel || isLabelProtected(code, bridgeLabel)) continue;

    const bridgeIdx = labelIndex.get(bridgeLabel);
    if (bridgeIdx == null || bridgeIdx <= i) continue;

    const bridgeInsnIdx = nextInstructionIndex(codeItems, bridgeIdx);
    if (bridgeInsnIdx == null) continue;
    const bridgeInsn = codeItems[bridgeInsnIdx] && codeItems[bridgeInsnIdx].instruction;
    if (opcodeMnemonic(bridgeInsn) !== 'goto') continue;
    if (previousLabelOrStart(codeItems, bridgeInsnIdx) !== bridgeIdx) continue;

    const joinLabel = trimLabel(getBranchArg(bridgeInsn));
    if (!joinLabel || joinLabel === bridgeLabel || isLabelProtected(code, joinLabel)) continue;
    if (findNextLabel(codeItems, bridgeInsnIdx + 1) !== joinLabel) continue;

    item.instruction = setBranchArg(item.instruction, joinLabel);
    refCounts.set(bridgeLabel, (refCounts.get(bridgeLabel) || 0) - 1);
    refCounts.set(joinLabel, (refCounts.get(joinLabel) || 0) + 1);
    if ((refCounts.get(bridgeLabel) || 0) === 0) {
      removeInstructionOnly(codeItems, bridgeInsnIdx);
    }
    removed += 1;
  }

  return removed;
}

function cloneStackConditionalTargets(code, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  let changed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const opcode = opcodeMnemonic(item && item.instruction);
    const inverse = INVERSE_CONDITIONALS[opcode];
    if (!inverse || conditionalPopCount(opcode) !== 1) continue;

    const target = trimLabel(getInstructionArg(item.instruction));
    const targetIdx = labelIndex.get(target);
    if (targetIdx == null || targetIdx <= i || isLabelProtected(code, target)) continue;
    if (isStackConditionalCloneLabel(target)) continue;

    const targetInsnIdx = codeItems[targetIdx] && codeItems[targetIdx].instruction
      ? targetIdx
      : nextInstructionIndex(codeItems, targetIdx + 1);
    if (targetInsnIdx == null || targetInsnIdx <= i) continue;
    const targetInsn = codeItems[targetInsnIdx] && codeItems[targetInsnIdx].instruction;
    const targetOpcode = opcodeMnemonic(targetInsn);
    if (!isConditionalBranch(targetOpcode) || conditionalPopCount(targetOpcode) < 2) continue;

    const fallthroughIdx = nextInstructionIndex(codeItems, i + 1);
    if (fallthroughIdx == null || fallthroughIdx === targetInsnIdx || fallthroughIdx > targetInsnIdx) continue;

    const targetNextIdx = nextInstructionIndex(codeItems, targetInsnIdx + 1);
    if (targetNextIdx == null) continue;

    const fallthroughLabel = ensureLabelAtInstruction(codeItems, fallthroughIdx, nextClonePrefix('Lscf'));
    const targetNextInsn = codeItems[targetNextIdx] && codeItems[targetNextIdx].instruction;
    const targetNextOpcode = opcodeMnemonic(targetNextInsn);
    const targetNextLabel = targetNextOpcode === 'goto' || targetNextOpcode === 'goto_w'
      ? trimLabel(getInstructionArg(targetNextInsn))
      : ensureLabelAtInstruction(codeItems, targetNextIdx, nextClonePrefix('Lsct'));
    if (!fallthroughLabel || !targetNextLabel) continue;

    item.instruction = setOpcode(setBranchArg(item.instruction, fallthroughLabel), inverse);
    codeItems.splice(i + 1, 0,
      { instruction: cloneValue(targetInsn) },
      { instruction: { op: 'goto', arg: targetNextLabel } },
    );
    changed += 1;
    break;
  }

  return changed;
}

function cloneForwardTerminalGotoTails(code, options = {}, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
  const suffixInstructionCounts = context ? context.suffixInstructionCounts() : buildSuffixInstructionCounts(codeItems);
  const maxInsns = Number(options.maxInsns || 0);
  const maxMethodInsns = Number(options.maxMethodInsns || 0);
  if (maxMethodInsns > 0 && suffixInstructionCounts[0] > maxMethodInsns) return 0;
  const maxClones = Math.max(1, Number(options.maxClones || 1));
  const candidates = [];

  for (let i = codeItems.length - 1; i >= 0; i -= 1) {
    const item = codeItems[i];
    const opcode = opcodeMnemonic(item && item.instruction);
    if (opcode !== 'goto' && opcode !== 'goto_w') continue;
    if (item.labelDef && (refCounts.get(trimLabel(item.labelDef)) || 0) > 0) continue;

    const target = trimLabel(getInstructionArg(item.instruction));
    const targetIdx = labelIndex.get(target);
    if (targetIdx == null || targetIdx <= i || isLabelProtected(code, target)) continue;
    if ((refCounts.get(target) || 0) < 2) continue;

    const range = { start: targetIdx, end: codeItems.length };
    const insns = countInstructionsFromSuffix(suffixInstructionCounts, range.start, range.end);
    if (insns === 0 || (maxInsns > 0 && insns > maxInsns)) continue;

    const summary = cachedAnalyzeRegion(context, code, range.start, range.end, { allowControlFlow: true, allowSideEffects: true });
    if (!summary.supported) continue;
    if (summary.touchesProtectedLabel || summary.overlapsExceptionRange) continue;
    if (summary.outboundBranches.length > 0) continue;
    if (summary.stack.underflowsEntry) continue;
    if (!summary.hasTerminator) continue;

    const clone = cloneRange(codeItems.slice(range.start, range.end), nextClonePrefix('Lft'));
    if (clone.length === 0) continue;
    if (item.labelDef) clone.unshift({ labelDef: item.labelDef });
    candidates.push({ index: i, clone });
    if (candidates.length >= maxClones) break;
  }

  const selected = candidates;
  for (const candidate of selected) {
    codeItems.splice(candidate.index, 1, ...candidate.clone);
  }

  return selected.length;
}

function cloneForwardSharedInitPrefixes(code, options = {}, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
  const maxInsns = Math.max(1, Number(options.maxInsns || 12));
  const maxClones = Math.max(1, Number(options.maxClones || 2));
  const candidates = [];

  for (let i = codeItems.length - 1; i >= 0; i -= 1) {
    const item = codeItems[i];
    const opcode = opcodeMnemonic(item && item.instruction);
    if (opcode !== 'goto' && opcode !== 'goto_w') continue;
    if (item.labelDef && (refCounts.get(trimLabel(item.labelDef)) || 0) > 0) continue;
    if (!isAfterVoidInvoke(codeItems, i)) continue;

    const target = trimLabel(getInstructionArg(item.instruction));
    const targetIdx = labelIndex.get(target);
    if (targetIdx == null || targetIdx <= i || isLabelProtected(code, target)) continue;
    if ((refCounts.get(target) || 0) !== 2) continue;

    const prefix = readForwardSharedInitPrefix(code, targetIdx, refCounts, maxInsns);
    if (!prefix) continue;
    const continuationLabel = ensureLabelAtInstruction(codeItems, prefix.continuationIdx, nextClonePrefix('Lfsic'));
    if (!continuationLabel) continue;
    const clone = cloneRange(codeItems.slice(targetIdx, prefix.continuationIdx), nextClonePrefix('Lfsi'));
    if (clone.length === 0) continue;
    if (item.labelDef || item.stackMapFrame) {
      const labelOnly = {};
      if (item.labelDef) labelOnly.labelDef = item.labelDef;
      if (item.stackMapFrame) labelOnly.stackMapFrame = cloneValue(item.stackMapFrame);
      clone.unshift(labelOnly);
    }
    clone.push({ instruction: { op: 'goto', arg: continuationLabel } });
    candidates.push({ index: i, clone });
    if (candidates.length >= maxClones) break;
  }

  for (const candidate of candidates) {
    codeItems.splice(candidate.index, 1, ...candidate.clone);
  }
  return candidates.length;
}

function readForwardSharedInitPrefix(code, startIdx, refCounts, maxInsns) {
  const codeItems = code.codeItems;
  let depth = 0;
  let insns = 0;
  const stores = [];
  for (let i = startIdx; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const label = trimLabel(item && item.labelDef);
    if (label && i !== startIdx && (refCounts.get(label) || 0) > 0) return null;
    if (!item || !item.instruction) continue;
    const op = opcodeMnemonic(item.instruction);
    if (isConditionalBranch(op) || op === 'goto' || op === 'goto_w' || op === 'tableswitch' || op === 'lookupswitch') {
      if (stores.length < 3 || depth !== 0) return null;
      const first = firstInstructionIndexAtOrAfter(codeItems, i);
      if (first == null || !isIntLoadOfLocal(codeItems[first] && codeItems[first].instruction, stores[stores.length - 1])) {
        return null;
      }
      return { continuationIdx: i, stores: stores.length };
    }
    if (op === 'iconst_0') {
      depth += 1;
    } else if (isIntStoreInstruction(item.instruction)) {
      if (depth <= 0) return null;
      depth -= 1;
      const local = intStoreLocalIndex(item.instruction);
      if (local == null || (stores.length > 0 && local !== stores[stores.length - 1] + 1)) return null;
      stores.push(local);
    } else {
      return null;
    }
    insns += 1;
    if (insns > maxInsns) return null;
  }
  return null;
}

function isAfterVoidInvoke(codeItems, gotoIdx) {
  const prev = previousInstructionIndex(codeItems, gotoIdx - 1);
  if (prev == null) return false;
  const instruction = codeItems[prev] && codeItems[prev].instruction;
  const op = opcodeMnemonic(instruction);
  if (!/^invoke/.test(op || '')) return false;
  const ref = getInstructionArg(instruction);
  return Array.isArray(ref) && Array.isArray(ref[2]) && typeof ref[2][1] === 'string' && ref[2][1].endsWith(')V');
}

function isIntLoadOfLocal(instruction, local) {
  const op = opcodeMnemonic(instruction);
  if (op === 'iload') return Number(getInstructionArg(instruction)) === local;
  const short = /^iload_(\d)$/.exec(op || '');
  return !!short && Number(short[1]) === local;
}

function cloneBoundedTerminalGotoTails(code, options = {}, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
  const firstRefIndex = collectFirstInstructionLabelReferenceIndex(codeItems);
  const suffixInstructionCounts = context ? context.suffixInstructionCounts() : buildSuffixInstructionCounts(codeItems);
  const maxInsns = Number(options.maxInsns || 0);
  const maxClones = Math.max(1, Number(options.maxClones || 1));
  const candidates = [];

  for (let i = codeItems.length - 1; i >= 0; i -= 1) {
    const item = codeItems[i];
    const opcode = opcodeMnemonic(item && item.instruction);
    if (opcode !== 'goto' && opcode !== 'goto_w') continue;
    if (item.labelDef && (refCounts.get(trimLabel(item.labelDef)) || 0) > 0) continue;

    const target = trimLabel(getInstructionArg(item.instruction));
    const targetIdx = labelIndex.get(target);
    if (targetIdx == null || targetIdx <= i || isLabelProtected(code, target)) continue;
    if ((refCounts.get(target) || 0) !== 3) continue;

    const endIdx = findFirstExternallyEnteredLabel(codeItems, targetIdx, firstRefIndex);
    if (endIdx == null || endIdx <= targetIdx) continue;
    const bridge = findTinyGotoBridgeRun(codeItems, endIdx);
    if (!bridge || bridge.bridges < 2 || isLabelProtected(code, bridge.successor)) continue;

    const insns = countInstructionsFromSuffix(suffixInstructionCounts, targetIdx, endIdx);
    if (insns === 0 || (maxInsns > 0 && insns > maxInsns)) continue;

    const summary = cachedAnalyzeRegion(context, code, targetIdx, endIdx, { allowControlFlow: true, allowSideEffects: true });
    if (!summary.supported) continue;
    if (summary.touchesProtectedLabel || summary.overlapsExceptionRange) continue;
    if (summary.outboundBranches.length > 0) continue;
    if (summary.stack.underflowsEntry) continue;
    if (!summary.hasTerminator) continue;

    const clone = cloneRange(codeItems.slice(targetIdx, endIdx), nextClonePrefix('Lbt'));
    if (clone.length === 0) continue;
    if (item.labelDef) clone.unshift({ labelDef: item.labelDef });
    candidates.push({ index: i, clone });
    if (candidates.length >= maxClones) break;
  }

  const selected = candidates;
  for (const candidate of selected) {
    codeItems.splice(candidate.index, 1, ...candidate.clone);
  }

  return selected.length;
}

function cloneLoopValueContinuations(code, options = {}, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
  const maxClones = Math.max(1, Number(options.maxClones || 4));
  const candidates = [];

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const opcode = opcodeMnemonic(item && item.instruction);
    if (opcode !== 'goto' && opcode !== 'goto_w') continue;
    if (item.labelDef && (refCounts.get(trimLabel(item.labelDef)) || 0) > 0) continue;

    const target = trimLabel(getBranchArg(item.instruction));
    const targetIdx = labelIndex.get(target);
    if (!target || targetIdx == null || targetIdx <= i || isLabelProtected(code, target)) continue;
    if ((refCounts.get(target) || 0) !== 1) continue;
    if (hasFallthroughPredecessor(codeItems, labelIndex, target)) continue;

    const continuation = readLoopValueContinuationBlock(codeItems, labelIndex, targetIdx);
    if (!continuation || continuation.loopHeadIdx >= i) continue;
    if (!loopHeadTestsContinuationLocal(codeItems, continuation.loopHeadIdx, continuation.local)) continue;
    if (regionTouchesProtectedLabel(code, targetIdx, continuation.end)) continue;

    const clone = cloneRange(codeItems.slice(targetIdx, continuation.end), nextClonePrefix('Lvc'));
    if (clone.length === 0) continue;
    if (item.labelDef || item.stackMapFrame) {
      const labelOnly = {};
      if (item.labelDef) labelOnly.labelDef = item.labelDef;
      if (item.stackMapFrame) labelOnly.stackMapFrame = cloneValue(item.stackMapFrame);
      clone.unshift(labelOnly);
    }
    candidates.push({ index: i, clone });
    if (candidates.length >= maxClones) break;
  }

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i];
    codeItems.splice(candidate.index, 1, ...candidate.clone);
  }

  return candidates.length;
}

function readLoopValueContinuationBlock(codeItems, labelIndex, startIdx) {
  const end = nextLabelIndex(codeItems, startIdx + 1) || codeItems.length;
  const instructions = [];
  for (let i = startIdx; i < end; i += 1) {
    if (codeItems[i] && codeItems[i].instruction) instructions.push(codeItems[i].instruction);
  }
  if (instructions.length !== 6 && instructions.length !== 7) return null;
  if (!isAloadLocal(instructions[0], 0)) return null;
  if (opcodeMnemonic(instructions[1]) !== 'getfield') return null;
  if (opcodeMnemonic(instructions[2]) !== 'iconst_0') return null;
  if (opcodeMnemonic(instructions[3]) !== 'invokevirtual') return null;

  const storeIdx = opcodeMnemonic(instructions[4]) === 'checkcast' ? 5 : 4;
  const local = astoreLocalIndex(instructions[storeIdx]);
  if (local == null) return null;

  const terminal = instructions[storeIdx + 1];
  const terminalOpcode = opcodeMnemonic(terminal);
  if (terminalOpcode !== 'goto' && terminalOpcode !== 'goto_w') return null;
  const loopHead = trimLabel(getBranchArg(terminal));
  const loopHeadIdx = labelIndex.get(loopHead);
  if (loopHeadIdx == null || loopHeadIdx >= startIdx) return null;

  return { end, local, loopHead, loopHeadIdx };
}

function loopHeadTestsContinuationLocal(codeItems, loopHeadIdx, local) {
  const loadIdx = firstInstructionIndexAtOrAfter(codeItems, loopHeadIdx);
  const branchIdx = loadIdx == null ? null : nextInstructionIndex(codeItems, loadIdx + 1);
  if (loadIdx == null || branchIdx == null) return false;
  if (!isAloadLocal(codeItems[loadIdx] && codeItems[loadIdx].instruction, local)) return false;
  const branchOpcode = opcodeMnemonic(codeItems[branchIdx] && codeItems[branchIdx].instruction);
  return branchOpcode === 'ifnull' || branchOpcode === 'ifnonnull';
}

function cloneConditionalTerminalTails(code, options = {}, context = null) {
  const codeItems = code.codeItems;
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
  const suffixInstructionCounts = context ? context.suffixInstructionCounts() : buildSuffixInstructionCounts(codeItems);
  const terminalPrefixCounts = context ? context.terminalPrefixCounts() : buildTerminalPrefixCounts(codeItems);
  const maxInsns = Number(options.maxInsns || 0);
  const maxMethodInsns = Number(options.maxMethodInsns || 0);
  if (maxMethodInsns > 0 && suffixInstructionCounts[0] > maxMethodInsns) return 0;
  const maxClones = Math.max(1, Number(options.maxClones || 1));
  const candidates = [];
  const tailCache = new Map();

  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    const opcode = opcodeMnemonic(item && item.instruction);
    const inverse = INVERSE_CONDITIONALS[opcode];
    if (!inverse) continue;

    const target = trimLabel(getInstructionArg(item.instruction));
    const targetIdx = labelIndex.get(target);
    if (targetIdx == null || targetIdx <= i || isLabelProtected(code, target)) continue;
    if ((refCounts.get(target) || 0) < 2) continue;

    const fallthroughIdx = nextInstructionIndex(codeItems, i + 1);
    if (fallthroughIdx == null || fallthroughIdx >= targetIdx) continue;
    if (!rangeContainsTerminalFromPrefix(terminalPrefixCounts, fallthroughIdx, targetIdx)) continue;

    let tail = tailCache.get(targetIdx);
    if (!tail) {
      const tailEnd = codeItems.length;
      const insns = countInstructionsFromSuffix(suffixInstructionCounts, targetIdx, tailEnd);
      if (insns === 0 || (maxInsns > 0 && insns > maxInsns)) {
        tail = { ok: false };
      } else {
        tail = {
          ok: true,
          end: tailEnd,
          summary: cachedAnalyzeRegion(context, code, targetIdx, tailEnd, { allowControlFlow: true, allowSideEffects: true }),
        };
      }
      tailCache.set(targetIdx, tail);
    }
    if (!tail.ok) continue;
    const summary = tail.summary;
    if (!summary.supported) continue;
    if (summary.touchesProtectedLabel || summary.overlapsExceptionRange) continue;
    if (summary.outboundBranches.length > 0) continue;
    if (summary.stack.underflowsEntry) continue;
    if (!summary.hasTerminator) continue;

    const clone = cloneRange(codeItems.slice(targetIdx, tail.end), nextClonePrefix('Lct'));
    if (clone.length === 0) continue;
    const fallthroughLabel = ensureLabelAtInstruction(codeItems, fallthroughIdx, nextClonePrefix('Lctf'));
    if (!fallthroughLabel) continue;
    candidates.push({ index: i, inverse, fallthroughLabel, clone });
    if (candidates.length >= maxClones) break;
  }

  const selected = candidates;
  for (let i = selected.length - 1; i >= 0; i -= 1) {
    const candidate = selected[i];
    const item = codeItems[candidate.index];
    item.instruction = setOpcode(setBranchArg(item.instruction, candidate.fallthroughLabel), candidate.inverse);
    codeItems.splice(candidate.index + 1, 0, ...candidate.clone);
  }

  return selected.length;
}

function removeDeadGotoIslandsAfterTerminals(code, context = null) {
  const codeItems = code.codeItems;
  const refCounts = context ? context.instructionLabelReferenceCounts() : collectInstructionLabelReferenceCounts(codeItems);
  let removed = 0;

  for (let i = 0; i < codeItems.length; i += 1) {
    const instruction = codeItems[i] && codeItems[i].instruction;
    if (!isTerminalOpcode(opcodeMnemonic(instruction))) continue;

    let j = nextInstructionIndex(codeItems, i + 1);
    while (j != null) {
      const label = trimLabel(codeItems[j] && codeItems[j].labelDef);
      if (label && ((refCounts.get(label) || 0) > 0 || isLabelProtected(code, label))) break;
      const op = opcodeMnemonic(codeItems[j] && codeItems[j].instruction);
      if (op !== 'goto' && op !== 'goto_w') break;
      const target = trimLabel(getBranchArg(codeItems[j].instruction));
      if (target) refCounts.set(target, Math.max(0, (refCounts.get(target) || 0) - 1));
      removeInstructionOnly(codeItems, j);
      removed += 1;
      j = nextInstructionIndex(codeItems, j + 1);
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

function removeUnreachableAfterTerminal(code, context = null) {
  const codeItems = code.codeItems;
  const used = collectControlFlowLabels(code);
  const labelIndex = context ? context.labelIndex() : buildLabelIndex(codeItems);
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
  let write = 0;
  for (let read = 0; read < codeItems.length; read += 1) {
    const item = codeItems[read];
    let keep = true;
    const label = item && item.labelDef ? trimLabel(item.labelDef) : null;
    if (label && !used.has(label)) {
      delete item.labelDef;
      removed += 1;
      if (!item.instruction && !item.stackMapFrame && !item.pc) keep = false;
    }
    if (keep) codeItems[write++] = item;
  }
  codeItems.length = write;
  return removed;
}

function restoreMissingPcTargetLabels(code) {
  const codeItems = code.codeItems || [];
  const labels = buildLabelIndex(codeItems);
  const pcIndex = new Map();
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (item && typeof item.pc === 'number' && !pcIndex.has(item.pc)) {
      pcIndex.set(item.pc, i);
    }
  }

  let restored = 0;
  const missingTargets = collectMissingInstructionTargets(codeItems, labels);
  for (const target of missingTargets) {
    const match = /^L(\d+)$/.exec(target);
    if (!match) continue;
    const index = pcIndex.get(Number(match[1]));
    if (index == null) continue;
    const item = codeItems[index];
    if (!item) continue;
    const existing = trimLabel(item.labelDef);
    if (existing) {
      retargetInstructionLabels(codeItems, target, existing);
    } else {
      item.labelDef = `${target}:`;
      labels.set(target, index);
    }
    restored += 1;
  }
  return restored;
}

function collectMissingInstructionTargets(codeItems, labels) {
  const missing = new Set();
  for (const item of codeItems) {
    for (const label of instructionLabelTargets(item && item.instruction)) {
      const normalized = trimLabel(label);
      if (normalized && !labels.has(normalized)) {
        missing.add(normalized);
      }
    }
  }
  return missing;
}

function instructionLabelTargets(instruction) {
  const out = [];
  collectInstructionLabels(instruction, {
    add(label) {
      out.push(label);
    },
  });
  return out;
}

function retargetInstructionLabels(codeItems, from, to) {
  for (const item of codeItems) {
    if (!item || !item.instruction) continue;
    item.instruction = rewriteOneInstructionLabel(item.instruction, from, to);
  }
}

function rewriteOneInstructionLabel(instruction, from, to) {
  const normalized = trimLabel(from);
  if (typeof instruction === 'string') {
    const arg = getBranchArg(instruction);
    return arg != null && trimLabel(arg) === normalized ? setBranchArg(instruction, to) : instruction;
  }
  if (!instruction || typeof instruction !== 'object') return instruction;
  const out = cloneValue(instruction);
  out.arg = rewriteOneLabelValue(out.arg, normalized, to);
  return out;
}

function rewriteOneLabelValue(value, from, to) {
  if (typeof value === 'string') {
    return trimLabel(value) === from ? to : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteOneLabelValue(entry, from, to));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = rewriteOneLabelValue(entry, from, to);
    }
    return out;
  }
  return value;
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

function findLoopTailRangeEndingAtBackedge(codeItems, labelIndex, startIdx) {
  const maxScan = Math.min(codeItems.length, startIdx + 420);
  for (let i = startIdx + 1; i < maxScan; i += 1) {
    const item = codeItems[i];
    const opcode = opcodeMnemonic(item && item.instruction);
    if (opcode !== 'goto' && opcode !== 'goto_w') continue;
    const target = trimLabel(getBranchArg(item.instruction));
    const targetIdx = labelIndex.get(target);
    if (targetIdx == null || targetIdx >= startIdx) continue;
    const end = nextLabelIndex(codeItems, i + 1) || nextInstructionIndex(codeItems, i + 1) || i + 1;
    return end > startIdx ? { start: startIdx, end } : null;
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
    const arg = getBranchArg(item.instruction);
    if (typeof arg === 'string' && trimLabel(arg) === label) {
      out.push({ idx: i, item });
    }
  }
  return out;
}

function collectBranchRefsByLabel(codeItems) {
  const out = new Map();
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const arg = getBranchArg(item.instruction);
    if (typeof arg !== 'string') continue;
    const label = trimLabel(arg);
    if (!label) continue;
    let refs = out.get(label);
    if (!refs) {
      refs = [];
      out.set(label, refs);
    }
    refs.push({ idx: i, item });
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

function methodMatchesConditionalSharedJoinGate(code, method, options) {
  if (options.cloneConditionalSharedJoinRequireStatic && !methodHasAccess(method, 'static')) {
    return false;
  }
  if (options.cloneConditionalSharedJoinRequireIntArrayParameter &&
    !(method && typeof method.descriptor === 'string' && method.descriptor.startsWith('(') && method.descriptor.includes('[I'))) {
    return false;
  }
  if (options.cloneConditionalSharedJoinRequireNoExceptions &&
    Array.isArray(code.exceptionTable) && code.exceptionTable.length > 0) {
    return false;
  }
  const codeItems = code.codeItems || [];
  const minInsns = Number(options.cloneConditionalSharedJoinMinMethodInsns || 0);
  if (minInsns > 0 && countInstructions(codeItems, 0, codeItems.length) < minInsns) return false;
  const minArrayStores = Number(options.cloneConditionalSharedJoinMinArrayStores || 0);
  if (minArrayStores > 0 && countArrayStoreOpcodes(codeItems, 0, codeItems.length).total < minArrayStores) {
    return false;
  }
  const maxLocalIndex = options.cloneConditionalSharedJoinMaxLocalIndex == null
    ? null
    : Number(options.cloneConditionalSharedJoinMaxLocalIndex);
  if (maxLocalIndex != null && maxLocalIndex >= 0 && highestReferencedLocalIndex(codeItems) > maxLocalIndex) {
    return false;
  }
  return true;
}

function methodMatchesSharedPureForwardJoinGate(code, options) {
  if (options.cloneConditionalSharedJoinRequireNoExceptions &&
    Array.isArray(code.exceptionTable) && code.exceptionTable.length > 0) {
    return false;
  }
  const codeItems = code.codeItems || [];
  const minInsns = Number(options.cloneSharedPureForwardJoinMinMethodInsns || 0);
  if (minInsns > 0 && countInstructions(codeItems, 0, codeItems.length) < minInsns) return false;
  const maxLocalIndex = options.cloneConditionalSharedJoinMaxLocalIndex == null
    ? null
    : Number(options.cloneConditionalSharedJoinMaxLocalIndex);
  if (maxLocalIndex != null && maxLocalIndex >= 0 && highestReferencedLocalIndex(codeItems) > maxLocalIndex) {
    return false;
  }
  return true;
}

function methodMatchesLongCompareSharedJoinGate(code, options) {
  if (options.cloneConditionalSharedJoinRequireNoExceptions &&
    Array.isArray(code.exceptionTable) && code.exceptionTable.length > 0) {
    return false;
  }
  const codeItems = code.codeItems || [];
  const minInsns = Number(options.cloneConditionalSharedJoinMinMethodInsns || 0);
  if (minInsns > 0 && countInstructions(codeItems, 0, codeItems.length) < minInsns) return false;
  const maxLocalIndex = options.cloneConditionalSharedJoinMaxLocalIndex == null
    ? null
    : Number(options.cloneConditionalSharedJoinMaxLocalIndex);
  if (maxLocalIndex != null && maxLocalIndex >= 0 && highestReferencedLocalIndex(codeItems) > maxLocalIndex) {
    return false;
  }
  return true;
}

function methodMatchesNullableSharedJoinGuardGate(code, options) {
  if (options.nullableSharedJoinGuardRequireNoExceptions &&
    Array.isArray(code.exceptionTable) && code.exceptionTable.length > 0) {
    return false;
  }
  const codeItems = code.codeItems || [];
  const minInsns = Number(options.nullableSharedJoinGuardMinMethodInsns || 0);
  if (minInsns > 0 && countInstructions(codeItems, 0, codeItems.length) < minInsns) return false;
  const maxLocalIndex = options.nullableSharedJoinGuardMaxLocalIndex == null
    ? null
    : Number(options.nullableSharedJoinGuardMaxLocalIndex);
  if (maxLocalIndex != null && maxLocalIndex >= 0 && highestReferencedLocalIndex(codeItems) > maxLocalIndex) {
    return false;
  }
  return true;
}

function methodMatchesSmallTerminalSharedForwardBlockGate(code, options) {
  const codeItems = code.codeItems || [];
  const minInsns = Number(options.cloneSmallTerminalSharedForwardBlockMinMethodInsns || 0);
  if (minInsns > 0 && countInstructions(codeItems, 0, codeItems.length) < minInsns) return false;
  const maxLocalIndex = options.cloneSmallTerminalSharedForwardBlockMaxLocalIndex == null
    ? null
    : Number(options.cloneSmallTerminalSharedForwardBlockMaxLocalIndex);
  if (maxLocalIndex != null && maxLocalIndex >= 0 && highestReferencedLocalIndex(codeItems) > maxLocalIndex) {
    return false;
  }
  return true;
}

function highestReferencedLocalIndex(codeItems) {
  let max = -1;
  for (const item of codeItems || []) {
    const index = referencedLocalIndex(item && item.instruction);
    if (index != null && index > max) max = index;
  }
  return max;
}

function referencedLocalIndex(instruction) {
  const op = opcodeMnemonic(instruction);
  if (!op) return null;
  const short = /^(?:[aidfl]load|[aidfl]store|ret)_(\d+)$/.exec(op);
  if (short) return Number(short[1]);
  if (!/^(?:[aidfl]load|[aidfl]store|ret|iinc)$/.test(op)) return null;
  const arg = getInstructionArg(instruction);
  if (typeof arg === 'number') return arg;
  if (typeof arg === 'bigint') return Number(arg);
  if (Array.isArray(arg) && arg.length > 0 && Number.isFinite(Number(arg[0]))) return Number(arg[0]);
  if (arg && typeof arg === 'object') {
    for (const key of ['index', 'local', 'var']) {
      if (Number.isFinite(Number(arg[key]))) return Number(arg[key]);
    }
  }
  if (typeof instruction === 'string') {
    const parts = instruction.trim().split(/\s+/);
    if (parts.length > 1 && Number.isFinite(Number(parts[1]))) return Number(parts[1]);
  }
  return null;
}

function methodHasAccess(method, flag) {
  const access = method && method.access;
  if (Array.isArray(access)) return access.includes(flag) || access.includes(`ACC_${flag.toUpperCase()}`);
  if (typeof access === 'string') return access.split(/\s+/).includes(flag) || access.split(/\s+/).includes(`ACC_${flag.toUpperCase()}`);
  if (method && Array.isArray(method.accessFlags)) return method.accessFlags.includes(flag) || method.accessFlags.includes(`ACC_${flag.toUpperCase()}`);
  if (method && Array.isArray(method.flags)) return method.flags.includes(flag) || method.flags.includes(`ACC_${flag.toUpperCase()}`);
  return false;
}

function hasPreservationGuard(codeItems, labelIdx, label) {
  const prevIdx = previousInstructionIndex(codeItems, labelIdx - 1);
  if (prevIdx == null) return false;
  const prev = codeItems[prevIdx] && codeItems[prevIdx].instruction;
  return !!(codeItems[prevIdx] && codeItems[prevIdx].peepholeGuard) &&
    opcodeMnemonic(prev) === 'goto' && trimLabel(getInstructionArg(prev)) === label;
}

function isGeneratedCloneLabel(label) {
  return /^L(?:97|98)\d+_/.test(trimLabel(label) || '') || /^Lsit\d+_/.test(trimLabel(label) || '');
}

function isSharedLoopIncrementCloneLabel(label) {
  return /^Lsit\d+_/.test(trimLabel(label) || '');
}

function isStackConditionalCloneLabel(label) {
  return /^Lsc[ft]\d+_/.test(trimLabel(label) || '');
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
  if (typeof instruction === 'string') {
    const arg = getBranchArg(instruction);
    if (arg == null) return instruction;
    const label = trimLabel(arg);
    return labelMap.has(label) ? setBranchArg(instruction, labelMap.get(label)) : instruction;
  }
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

function countInstructionsUpTo(codeItems, startIdx, endIdx, limit) {
  let count = 0;
  for (let i = startIdx; i < endIdx; i += 1) {
    if (codeItems[i] && codeItems[i].instruction) {
      count += 1;
      if (limit > 0 && count > limit) return count;
    }
  }
  return count;
}

function buildSuffixInstructionCounts(codeItems) {
  const counts = new Array(codeItems.length + 1);
  counts[codeItems.length] = 0;
  for (let i = codeItems.length - 1; i >= 0; i -= 1) {
    counts[i] = counts[i + 1] + (codeItems[i] && codeItems[i].instruction ? 1 : 0);
  }
  return counts;
}

function countInstructionsFromSuffix(counts, startIdx, endIdx) {
  return counts[startIdx] - counts[endIdx];
}

function buildTerminalPrefixCounts(codeItems) {
  const counts = new Array(codeItems.length + 1);
  counts[0] = 0;
  for (let i = 0; i < codeItems.length; i += 1) {
    const opcode = opcodeMnemonic(codeItems[i] && codeItems[i].instruction);
    counts[i + 1] = counts[i] + (isTerminalOpcode(opcode) ? 1 : 0);
  }
  return counts;
}

function rangeContainsTerminalFromPrefix(counts, startIdx, endIdx) {
  return counts[endIdx] - counts[startIdx] > 0;
}

function rangeContainsTerminal(codeItems, startIdx, endIdx) {
  for (let i = startIdx; i < endIdx; i += 1) {
    const opcode = opcodeMnemonic(codeItems[i] && codeItems[i].instruction);
    if (isTerminalOpcode(opcode)) return true;
  }
  return false;
}

function findFirstExternallyEnteredLabel(codeItems, startIdx, firstRefIndex) {
  for (let i = startIdx + 1; i < codeItems.length; i += 1) {
    const label = trimLabel(codeItems[i] && codeItems[i].labelDef);
    if (!label) continue;
    const firstRef = firstRefIndex.get(label);
    if (firstRef != null && firstRef < startIdx) return i;
  }
  return null;
}

function findTinyGotoBridgeRun(codeItems, startIdx) {
  let successor = null;
  let bridges = 0;
  let index = startIdx;

  while (index < codeItems.length) {
    const label = trimLabel(codeItems[index] && codeItems[index].labelDef);
    if (!label) break;

    const block = readTinyGotoBridge(codeItems, index);
    if (!block) break;
    if (successor == null) {
      successor = block.target;
    } else if (successor !== block.target) {
      break;
    }
    bridges += 1;
    index = block.nextIdx;
  }

  return bridges > 0 && successor != null ? { successor, bridges } : null;
}

function readTinyGotoBridge(codeItems, labelIdx) {
  let index = nextInstructionIndex(codeItems, labelIdx);
  let insns = 0;
  while (index != null) {
    if (index !== labelIdx && codeItems[index] && codeItems[index].labelDef) return null;
    const instruction = codeItems[index] && codeItems[index].instruction;
    if (instruction) {
      insns += 1;
      const opcode = opcodeMnemonic(instruction);
      if (opcode === 'goto' || opcode === 'goto_w') {
        return insns <= 4 ? {
          target: trimLabel(getBranchArg(instruction)),
          nextIdx: nextLabelIndex(codeItems, index + 1) || codeItems.length,
        } : null;
      }
      if (insns >= 4 || isConditionalBranch(opcode) || isTerminalOpcode(opcode)) return null;
    }
    index = nextInstructionIndex(codeItems, index + 1);
  }
  return null;
}

function collectFirstInstructionLabelReferenceIndex(codeItems) {
  const out = new Map();
  for (let i = 0; i < codeItems.length; i += 1) {
    const item = codeItems[i];
    if (!item || !item.instruction) continue;
    const branchArg = getBranchArg(item.instruction);
    if (branchArg != null) {
      recordFirstLabelReference(out, branchArg, i);
      continue;
    }
    collectLabelReferencesInValue(item.instruction.arg, (label) => recordFirstLabelReference(out, label, i));
  }
  return out;
}

function recordFirstLabelReference(out, label, index) {
  const normalized = trimLabel(label);
  if (normalized == null) return;
  if (!out.has(normalized) || index < out.get(normalized)) out.set(normalized, index);
}

function collectLabelReferencesInValue(value, visit) {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLabelReferencesInValue(item, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectLabelReferencesInValue(item, visit);
  }
}

function findSmallTerminalForwardBlock(codeItems, startIdx, maxInsns) {
  const firstInsn = nextInstructionIndex(codeItems, startIdx);
  if (firstInsn == null) return null;
  let count = 0;
  for (let i = firstInsn; i < codeItems.length; i += 1) {
    const instruction = codeItems[i] && codeItems[i].instruction;
    if (!instruction) continue;
    count += 1;
    if (count > maxInsns) return null;
    const opcode = opcodeMnemonic(instruction);
    if (isTerminalOpcode(opcode)) return { start: startIdx, end: i + 1, terminalIdx: i };
    if (isConditionalBranch(opcode) || opcode === 'tableswitch' || opcode === 'lookupswitch') return null;
  }
  return null;
}

function smallTerminalBlockStackSummary(codeItems, startIdx, endIdx) {
  let depth = 0;
  let hasObservableSideEffects = false;
  let hasLocalMutation = false;
  for (let i = startIdx; i < endIdx; i += 1) {
    const instruction = codeItems[i] && codeItems[i].instruction;
    if (!instruction) continue;
    const delta = extendedStackDelta(instruction);
    if (delta == null) return null;
    depth += delta;
    if (depth < 0) return { delta: depth, underflowsEntry: true, hasObservableSideEffects, hasLocalMutation };
    if (instructionHasObservableSideEffect(instruction)) hasObservableSideEffects = true;
    if (instructionMutatesLocal(instruction)) hasLocalMutation = true;
  }
  return { delta: depth, underflowsEntry: false, hasObservableSideEffects, hasLocalMutation };
}

function terminalBranchesBackward(codeItems, labelIndex, range) {
  const terminal = codeItems[range.terminalIdx] && codeItems[range.terminalIdx].instruction;
  const opcode = opcodeMnemonic(terminal);
  if (opcode !== 'goto' && opcode !== 'goto_w') return false;
  const target = trimLabel(getBranchArg(terminal));
  const targetIdx = labelIndex.get(target);
  return targetIdx != null && targetIdx < range.start;
}

function extendedStackDelta(instruction) {
  const basic = stackDelta(instruction);
  if (basic != null) return basic;
  const opcode = opcodeMnemonic(instruction);
  const text = instructionText(instruction);
  if (opcode === 'putfield') {
    const desc = trailingFieldDescriptor(text);
    if (!desc) return null;
    return -(1 + descriptorSlotSize(desc));
  }
  if (opcode === 'putstatic') {
    const desc = trailingFieldDescriptor(text);
    if (!desc) return null;
    return -descriptorSlotSize(desc);
  }
  if (opcode === 'getfield') {
    const desc = trailingFieldDescriptor(text);
    if (!desc) return null;
    return -1 + descriptorSlotSize(desc);
  }
  if (opcode === 'getstatic') {
    const desc = trailingFieldDescriptor(text);
    if (!desc) return null;
    return descriptorSlotSize(desc);
  }
  if (opcode === 'checkcast' || opcode === 'instanceof') return 0;
  if (/^invoke/.test(opcode || '')) {
    const desc = methodDescriptorFromText(text);
    if (!desc) return null;
    const receiver = opcode === 'invokestatic' ? 0 : 1;
    return -receiver - methodArgSlots(desc) + methodReturnSlots(desc);
  }
  return null;
}

function instructionHasObservableSideEffect(instruction) {
  const opcode = opcodeMnemonic(instruction);
  return opcode === 'putfield' || opcode === 'putstatic' ||
    opcode === 'aastore' || opcode === 'iastore' || opcode === 'bastore' ||
    opcode === 'sastore' || opcode === 'castore' || opcode === 'lastore' ||
    opcode === 'fastore' || opcode === 'dastore' ||
    /^invoke/.test(opcode || '');
}

function instructionMutatesLocal(instruction) {
  const opcode = opcodeMnemonic(instruction);
  return opcode === 'iinc' || /^(?:[aidfl]store)(?:_\d+)?$/.test(opcode || '');
}

function instructionText(instruction) {
  if (typeof instruction === 'string') return instruction;
  if (!instruction || typeof instruction !== 'object') return '';
  const arg = instruction.arg == null ? '' : String(instruction.arg);
  return `${instruction.op || ''}${arg ? ` ${arg}` : ''}`;
}

function trailingFieldDescriptor(text) {
  const parts = String(text || '').trim().split(/\s+/);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function methodDescriptorFromText(text) {
  const match = /\(([^)]*)\)(\S+)/.exec(String(text || ''));
  return match ? `(${match[1]})${match[2]}` : null;
}

function methodArgSlots(descriptor) {
  const end = descriptor.indexOf(')');
  if (!descriptor.startsWith('(') || end < 0) return 0;
  return descriptorSlots(descriptor.slice(1, end));
}

function methodReturnSlots(descriptor) {
  const end = descriptor.indexOf(')');
  if (end < 0) return 0;
  const ret = descriptor.slice(end + 1);
  return ret === 'V' ? 0 : descriptorSlotSize(ret);
}

function descriptorSlots(desc) {
  let slots = 0;
  for (let i = 0; i < desc.length; i += 1) {
    let ch = desc[i];
    while (ch === '[') {
      i += 1;
      ch = desc[i];
    }
    if (ch === 'L') {
      const end = desc.indexOf(';', i);
      if (end < 0) return slots;
      i = end;
      slots += 1;
    } else {
      slots += ch === 'J' || ch === 'D' ? 2 : 1;
    }
  }
  return slots;
}

function descriptorSlotSize(desc) {
  return desc && (desc[0] === 'J' || desc[0] === 'D') ? 2 : 1;
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

function hasLabelBetween(codeItems, startIdx, endIdx) {
  return hasInternalLabel(codeItems, startIdx, endIdx);
}

function hasInstructionBetween(codeItems, startIndex, endIndex) {
  for (let i = startIndex; i < endIndex; i += 1) {
    if (codeItems[i] && codeItems[i].instruction) return true;
  }
  return false;
}

function firstInstructionIndexAtOrAfter(codeItems, startIndex) {
  return nextInstructionIndex(codeItems, startIndex);
}

function hasInternalControlFlowBeforeEnd(codeItems, startIdx, endIdx) {
  const lastIdx = previousInstructionIndex(codeItems, endIdx - 1);
  for (let i = startIdx; i < endIdx; i += 1) {
    if (i === lastIdx) continue;
    const opcode = opcodeMnemonic(codeItems[i] && codeItems[i].instruction);
    if (!opcode) continue;
    if (isConditionalBranch(opcode) || opcode === 'goto' || opcode === 'goto_w' ||
      opcode === 'tableswitch' || opcode === 'lookupswitch') {
      return true;
    }
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

function findNullableJoinSkipGoto(codeItems, startIndex, endIndex, local) {
  const labelIndex = buildLabelIndex(codeItems);
  for (let i = startIndex; i < endIndex; i += 1) {
    const opcode = opcodeMnemonic(codeItems[i] && codeItems[i].instruction);
    if (!isNonNullConditional(opcode)) continue;
    if (referenceLoadLocalBeforeBranch(codeItems, i) !== local) continue;

    const nonNullLabel = trimLabel(getBranchArg(codeItems[i].instruction));
    const nonNullIdx = labelIndex.get(nonNullLabel);
    if (nonNullIdx == null || nonNullIdx <= i || nonNullIdx > endIndex) continue;
    const skip = firstForwardGotoBetween(codeItems, labelIndex, i + 1, nonNullIdx, endIndex);
    if (skip) return skip;
  }
  return null;
}

function firstForwardGotoBetween(codeItems, labelIndex, startIndex, endIndex, minTargetIndex) {
  for (let i = startIndex; i < endIndex; i += 1) {
    const instruction = codeItems[i] && codeItems[i].instruction;
    if (opcodeMnemonic(instruction) !== 'goto') continue;
    const exitLabel = trimLabel(getBranchArg(instruction));
    const exitIdx = labelIndex.get(exitLabel);
    if (exitIdx != null && exitIdx > minTargetIndex) return { gotoIdx: i, exitLabel };
  }
  return null;
}

function hasReferenceStoreBetween(codeItems, startIndex, endIndex, local) {
  for (let i = startIndex; i < endIndex; i += 1) {
    if (isAstoreLocal(codeItems[i] && codeItems[i].instruction, local)) return true;
  }
  return false;
}

function insertNullGuardAtLabel(codeItems, targetIdx, local, exitLabel) {
  const original = codeItems[targetIdx];
  if (original && original.labelDef && !original.instruction) {
    codeItems.splice(
      targetIdx + 1,
      0,
      { instruction: { op: 'aload', arg: String(local) } },
      { instruction: { op: 'ifnull', arg: exitLabel } },
    );
    return;
  }
  const labelDef = original && original.labelDef;
  const stackMapFrame = original && original.stackMapFrame;
  if (original) {
    delete original.labelDef;
    delete original.stackMapFrame;
  }
  const guardEntry = { labelDef, instruction: { op: 'aload', arg: String(local) } };
  if (stackMapFrame) guardEntry.stackMapFrame = stackMapFrame;
  codeItems.splice(
    targetIdx,
    0,
    guardEntry,
    { instruction: { op: 'ifnull', arg: exitLabel } },
  );
}

function referenceLoadLocalBeforeBranch(codeItems, branchIdx) {
  const opcode = opcodeMnemonic(codeItems[branchIdx] && codeItems[branchIdx].instruction);
  if (opcode === 'ifnonnull') {
    const loadIdx = previousInstructionIndex(codeItems, branchIdx - 1);
    if (loadIdx == null) return null;
    return aloadLocalIndex(codeItems[loadIdx] && codeItems[loadIdx].instruction);
  }
  if (opcode !== 'if_acmpne') return null;
  const rightIdx = previousInstructionIndex(codeItems, branchIdx - 1);
  const leftIdx = rightIdx == null ? null : previousInstructionIndex(codeItems, rightIdx - 1);
  if (rightIdx == null || leftIdx == null) return null;
  const rightLocal = aloadLocalIndex(codeItems[rightIdx] && codeItems[rightIdx].instruction);
  const leftLocal = aloadLocalIndex(codeItems[leftIdx] && codeItems[leftIdx].instruction);
  if (opcodeMnemonic(codeItems[leftIdx] && codeItems[leftIdx].instruction) === 'aconst_null' && rightLocal != null) {
    return rightLocal;
  }
  if (opcodeMnemonic(codeItems[rightIdx] && codeItems[rightIdx].instruction) === 'aconst_null' && leftLocal != null) {
    return leftLocal;
  }
  return null;
}

function isNonNullConditional(opcode) {
  return opcode === 'ifnonnull' || opcode === 'if_acmpne';
}

function isConditionalBranch(opcode) {
  return /^if/.test(opcode || '');
}

function isBranchOpcode(opcode) {
  return isConditionalBranch(opcode) || opcode === 'goto' || opcode === 'goto_w';
}

function isAloadLocal(instruction, local) {
  return aloadLocalIndex(instruction) === local;
}

function isAstoreLocal(instruction, local) {
  return astoreLocalIndex(instruction) === local;
}

function aloadLocalIndex(instruction) {
  const opcode = opcodeMnemonic(instruction);
  const short = /^aload_(\d)$/.exec(opcode || '');
  if (short) return Number(short[1]);
  if (opcode !== 'aload') return null;
  const arg = localInstructionArg(instruction);
  if (arg != null && arg !== '' && Number.isFinite(Number(arg))) return Number(arg);
  if (typeof instruction === 'string') {
    const parts = instruction.trim().split(/\s+/);
    if (parts.length === 2 && Number.isFinite(Number(parts[1]))) return Number(parts[1]);
  }
  return null;
}

function astoreLocalIndex(instruction) {
  const opcode = opcodeMnemonic(instruction);
  const short = /^astore_(\d)$/.exec(opcode || '');
  if (short) return Number(short[1]);
  if (opcode !== 'astore') return null;
  const arg = localInstructionArg(instruction);
  if (arg != null && arg !== '' && Number.isFinite(Number(arg))) return Number(arg);
  if (typeof instruction === 'string') {
    const parts = instruction.trim().split(/\s+/);
    if (parts.length === 2 && Number.isFinite(Number(parts[1]))) return Number(parts[1]);
  }
  return null;
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

function isReferenceLoadInstruction(instruction) {
  const opcode = opcodeMnemonic(instruction);
  return opcode === 'aload' || /^aload_\d$/.test(opcode || '');
}

function isIntStoreInstruction(instruction) {
  const opcode = opcodeMnemonic(instruction);
  return opcode === 'istore' || /^istore_[0-3]$/.test(opcode || '');
}

function intStoreLocalIndex(instruction) {
  const opcode = opcodeMnemonic(instruction);
  const short = /^istore_(\d)$/.exec(opcode || '');
  if (short) return Number(short[1]);
  if (opcode !== 'istore') return null;
  const arg = localInstructionArg(instruction);
  if (arg != null && arg !== '' && Number.isFinite(Number(arg))) return Number(arg);
  if (typeof instruction === 'string') {
    const parts = instruction.trim().split(/\s+/);
    if (parts.length === 2 && Number.isFinite(Number(parts[1]))) return Number(parts[1]);
  }
  return null;
}

function localInstructionArg(instruction) {
  if (!instruction || typeof instruction !== 'object') return null;
  if (Array.isArray(instruction.arg)) return instruction.arg[0] == null ? null : instruction.arg[0];
  if (instruction.arg != null) return instruction.arg;
  if (Array.isArray(instruction.args)) return instruction.args[0] == null ? null : instruction.args[0];
  return null;
}

function isSimpleProducerInstruction(instruction) {
  const opcode = getOpcode(instruction);
  if (typeof opcode !== 'string') return false;
  if (isSimpleLoadInstruction(instruction)) return true;
  return /^(aconst_null|iconst_m1|iconst_\d+|fconst_\d+|dconst_[01]|lconst_[01]|bipush|sipush|ldc|ldc_w|ldc2_w)(?:\s|$)/.test(opcode);
}

function itemWithReplacedInstruction(item, instruction) {
  const out = {};
  if (item && item.labelDef) out.labelDef = item.labelDef;
  if (item && item.stackMapFrame) out.stackMapFrame = cloneValue(item.stackMapFrame);
  if (item && item.lineNumber) out.lineNumber = cloneValue(item.lineNumber);
  out.instruction = instruction;
  return out;
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
    const branchArg = getBranchArg(item.instruction);
    if (branchArg != null) {
      count += trimLabel(branchArg) === trimLabel(label) ? 1 : 0;
      continue;
    }
    count += countLabelInValue(item.instruction.arg, label);
  }
  return count;
}

function collectInstructionLabels(instruction, used) {
  const branchArg = getBranchArg(instruction);
  if (branchArg != null) {
    addLabel(used, branchArg);
    return;
  }
  if (!instruction || typeof instruction !== 'object') return;
  collectLabelsFromValue(instruction.arg, used);
}

function collectInstructionLabelReferenceCounts(codeItems) {
  const out = new Map();
  for (const item of codeItems || []) {
    if (!item || !item.instruction) continue;
    collectInstructionLabels(item.instruction, {
      add(label) {
        const trimmed = trimLabel(label);
        out.set(trimmed, (out.get(trimmed) || 0) + 1);
      },
    });
  }
  return out;
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

function regionTouchesProtectedLabel(code, startIdx, endIdx) {
  const codeItems = code.codeItems || [];
  for (let i = startIdx; i < endIdx; i += 1) {
    const label = trimLabel(codeItems[i] && codeItems[i].labelDef);
    if (label && isLabelProtected(code, label)) return true;
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

function previousLabelIndex(codeItems, startIndex) {
  for (let i = startIndex; i >= 0; i -= 1) {
    if (codeItems[i] && codeItems[i].labelDef) return i;
  }
  return null;
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

function getBranchArg(instruction) {
  const arg = getInstructionArg(instruction);
  if (arg != null) return arg;
  if (typeof instruction !== 'string') return null;
  const parts = instruction.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  if (!isConditionalBranch(parts[0]) && parts[0] !== 'goto' && parts[0] !== 'goto_w') return null;
  return parts[1];
}

function setInstructionArg(instruction, arg) {
  if (!instruction || typeof instruction !== 'object') return instruction;
  return { ...instruction, arg };
}

function setBranchArg(instruction, arg) {
  if (instruction && typeof instruction === 'object') return setInstructionArg(instruction, arg);
  if (typeof instruction !== 'string') return instruction;
  const parts = instruction.trim().split(/\s+/);
  if (parts.length !== 2) return instruction;
  return `${parts[0]} ${arg}`;
}

function setOpcode(instruction, opcode) {
  if (instruction && typeof instruction === 'object') return { ...instruction, op: opcode };
  if (typeof instruction !== 'string') return instruction;
  const parts = instruction.trim().split(/\s+/);
  if (parts.length === 0) return instruction;
  parts[0] = opcode;
  return parts.join(' ');
}

function ensureLabelAtInstruction(codeItems, instructionIdx, prefix) {
  const item = codeItems[instructionIdx];
  if (!item) return null;
  const existing = trimLabel(item.labelDef);
  if (existing) return existing;
  const label = `${prefix}_0`;
  item.labelDef = `${label}:`;
  return label;
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
  threadMultiUseGotoBridges,
  coalesceProtectedLoadBridges,
  stripMonitorWaitExceptionRegions,
  simplifyNullCompareBranches,
  normalizeDupStoreCompareBranches,
  coalesceLoopProducerBridges,
  coalesceDuplicateLoopTails,
  coalesceDuplicateLoopIncrementTails,
  coalesceDuplicateLoopBackedgeTails,
  cloneSharedLoopIncrementTails,
  cloneForwardLoopEntryGotos,
  cloneConditionalForwardLoopEntry,
  cloneConditionalForwardTailEntry,
  cloneSharedFallthroughBlocks,
  cloneSharedFallthroughJoinGotos,
  cloneSmallTerminalSharedForwardBlocks,
  cloneConditionalSharedJoinBranches,
  cloneSharedPureForwardJoinBranches,
  cloneSharedSideEffectJoinBranches,
  cloneConditionalSharedLoopTails,
  removeConditionalFallthroughGotoBridges,
  cloneStackConditionalTargets,
  cloneForwardTerminalGotoTails,
  cloneBoundedTerminalGotoTails,
  cloneLoopValueContinuations,
  cloneConditionalTerminalTails,
  removeDeadGotoIslandsAfterTerminals,
  invertConditionalOverGoto,
  removeUnreachableAfterTerminal,
  removeUnreachableUntilUsedLabel,
  removeSingleUseFallthroughGotos,
  removeUnusedLabels,
};
