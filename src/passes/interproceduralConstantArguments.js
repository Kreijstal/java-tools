'use strict';

const { convertAstToCfg } = require('../cfg/ast-to-cfg');
const { analyzeConstantCfg } = require('./constantFolder-cfg');
const { runRemoveUnreachableCodeCfg } = require('./removeUnreachableCodeCfg');

/**
 * Discover primitive parameters that receive one constant at every direct
 * call site in a closed set of classes, then replace reads of those parameters
 * in the callee. The method descriptor and its call sites are intentionally
 * left unchanged; ordinary constant folding and DCE can simplify the body.
 *
 * This is a closed-world optimization. Callers must gate it when classes may
 * be entered through reflection, native code, or code outside astRoot.
 */

const INT_LIKE_DESCRIPTORS = new Set(['Z', 'B', 'C', 'S', 'I']);
const INT_LOAD_OPS = new Set(['iload', 'iload_0', 'iload_1', 'iload_2', 'iload_3']);
const INT_STORE_OPS = new Set(['istore', 'istore_0', 'istore_1', 'istore_2', 'istore_3']);
const DIRECT_INVOKE_OPS = new Set(['invokestatic', 'invokespecial']);

function discoverInterproceduralConstantArguments(astRoot) {
  const definitions = collectDefinitions(astRoot);
  const classes = classMap(astRoot);
  const definitionsBySignature = new Map();
  for (const definition of definitions.values()) {
    if (!definitionsBySignature.has(definition.signature)) {
      definitionsBySignature.set(definition.signature, []);
    }
    definitionsBySignature.get(definition.signature).push(definition);
  }
  const observations = new Map();
  for (const key of definitions.keys()) {
    observations.set(key, { callCount: 0, value: undefined, rejected: false });
  }

  forEachMethod(astRoot, (_cls, method, codeItems) => {
    const analysis = analyzeConstantCfg(convertAstToCfg(method));
    if (analysis.limited) {
      rejectRawMethodCalls(codeItems, definitionsBySignature, observations, classes);
      return;
    }
    for (const invocation of analysis.invocations) {
      const ref = methodRef(invocation.arg);
      if (!ref) continue;
      const resolvedOwner = resolveMethodOwner(ref.owner, ref.name, ref.descriptor, classes);
      if (!resolvedOwner) continue;
      const signature = methodSignature(resolvedOwner, ref.name, ref.descriptor);
      const matchingDefinitions = definitionsBySignature.get(signature);
      if (!matchingDefinitions) continue;
      const parameters = parameterDescriptors(ref.descriptor);
      const argumentsByIndex = invocationArgumentValues(invocation, parameters);
      for (const definition of matchingDefinitions) {
        const observation = observations.get(definition.key);
        observation.callCount += 1;
        if (!DIRECT_INVOKE_OPS.has(invocation.op) || !argumentsByIndex) {
          observation.rejected = true;
          continue;
        }
        const constant = argumentsByIndex[definition.parameterIndex];
        if (constant == null) {
          observation.rejected = true;
          continue;
        }
        if (observation.value === undefined) observation.value = constant;
        else if (observation.value !== constant) observation.rejected = true;
      }
    }
  });

  const facts = [];
  for (const [key, definition] of definitions) {
    const observation = observations.get(key);
    if (observation.rejected || observation.callCount === 0 || observation.value === undefined) continue;
    facts.push({
      key,
      signature: definition.signature,
      owner: definition.owner,
      name: definition.name,
      descriptor: definition.descriptor,
      parameterIndex: definition.parameterIndex,
      localIndex: definition.localIndex,
      parameterDescriptor: definition.parameterDescriptor,
      value: observation.value,
      callCount: observation.callCount,
    });
  }
  facts.sort((a, b) => a.signature.localeCompare(b.signature)
    || a.parameterIndex - b.parameterIndex);
  return { facts, candidateCount: definitions.size };
}

function runInterproceduralConstantArguments(astRoot, options = {}) {
  const facts = Array.isArray(options.facts) ? options.facts : [];
  const bySignature = new Map();
  for (const fact of facts) {
    if (!bySignature.has(fact.signature)) bySignature.set(fact.signature, []);
    bySignature.get(fact.signature).push(fact);
  }
  let replacedLoads = 0;
  let specializedMethods = 0;
  let specializedParameters = 0;
  let foldedBranches = 0;

  forEachMethod(astRoot, (cls, method, codeItems, code) => {
    const signature = methodSignature(cls.className, method.name, method.descriptor);
    const methodFacts = bySignature.get(signature);
    if (!methodFacts || !methodFacts.length) return;
    let methodReplacements = 0;
    let methodSpecializedParameters = 0;
    for (const fact of methodFacts) {
      let parameterReplacements = 0;
      for (const item of codeItems) {
        const instruction = item && item.instruction;
        const op = instructionOp(instruction);
        if (!INT_LOAD_OPS.has(op) || localIndexOf(instruction, op) !== fact.localIndex) continue;
        item.instruction = intConstantInstruction(fact.value);
        parameterReplacements += 1;
      }
      if (parameterReplacements > 0) {
        methodReplacements += parameterReplacements;
        methodSpecializedParameters += 1;
      }
    }
    if (methodReplacements > 0) {
      specializedMethods += 1;
      specializedParameters += methodSpecializedParameters;
      replacedLoads += methodReplacements;
      foldedBranches += foldImmediateConstantBranches(codeItems, code.exceptionTable || []);
    }
  });

  return {
    changed: replacedLoads > 0,
    specializedMethods,
    specializedParameters,
    replacedLoads,
    foldedBranches,
  };
}

function runInterproceduralConstantArgumentFixedPoint(astRoot, options = {}) {
  const maxIterations = Number.isInteger(options.maxIterations) && options.maxIterations > 0
    ? options.maxIterations : 16;
  const factsByKey = new Map();
  let candidateCount = 0;
  let iterations = 0;
  let converged = false;
  let specializedParameters = 0;
  let replacedLoads = 0;
  let foldedBranches = 0;
  let unreachableSweeps = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    iterations = iteration;
    const discovery = discoverInterproceduralConstantArguments(astRoot);
    candidateCount = Math.max(candidateCount, discovery.candidateCount);
    const newFacts = discovery.facts.filter((fact) => !factsByKey.has(fact.key));
    for (const fact of newFacts) {
      fact.discoveredIteration = iteration;
      factsByKey.set(fact.key, fact);
    }

    const specialization = runInterproceduralConstantArguments(astRoot, { facts: newFacts });
    specializedParameters += specialization.specializedParameters;
    replacedLoads += specialization.replacedLoads;
    foldedBranches += specialization.foldedBranches;
    const expressionFold = runConstantExpressionFold(astRoot);
    const branchFold = runImmediateConstantBranchDce(astRoot);
    foldedBranches += branchFold.foldedBranches;
    const unreachable = runRemoveUnreachableCodeCfg(astRoot);
    if (unreachable.changed) unreachableSweeps += 1;

    if (!specialization.changed && !expressionFold.changed && !branchFold.changed && !unreachable.changed) {
      converged = true;
      break;
    }
  }

  const facts = [...factsByKey.values()].sort((a, b) =>
    a.signature.localeCompare(b.signature) || a.parameterIndex - b.parameterIndex);
  return {
    facts,
    candidateCount,
    iterations,
    converged,
    maxIterations,
    specializedParameters,
    replacedLoads,
    foldedBranches,
    unreachableSweeps,
  };
}

/**
 * Select descriptor changes that do not require renumbering any live local.
 *
 * A candidate must already have a closed-world constant-argument fact, be a
 * private or internal static method, and form a contiguous trailing run of
 * width-one parameters. Constant specialization has removed every read of
 * those parameters before this function is called. Constructors and virtual
 * dispatch are deliberately outside this separately gated transform.
 */
function discoverInterproceduralSignatureCompactions(astRoot, options = {}) {
  const facts = Array.isArray(options.facts) ? options.facts : [];
  const factsBySignature = new Map();
  for (const fact of facts) {
    if (!factsBySignature.has(fact.signature)) factsBySignature.set(fact.signature, new Map());
    factsBySignature.get(fact.signature).set(fact.parameterIndex, fact);
  }

  const classes = new Map(((astRoot && astRoot.classes) || [])
    .filter((cls) => cls && cls.className)
    .map((cls) => [cls.className, cls]));
  const occupied = new Set();
  const sourceMethods = new Map();
  forEachMethod(astRoot, (cls, method) => {
    const key = sourceMethodKey(cls.className, method.name, method.descriptor);
    occupied.add(key);
    const shape = sourceMethodShape(method.name, method.descriptor);
    if (!sourceMethods.has(shape)) sourceMethods.set(shape, []);
    sourceMethods.get(shape).push({ owner: cls.className, method });
  });

  const proposals = [];
  forEachMethod(astRoot, (cls, method, codeItems) => {
    if (method.name === '<init>' || method.name === '<clinit>') return;
    const flags = Array.isArray(method.flags) ? method.flags : [];
    if (!flags.includes('private') && !flags.includes('static')) return;
    const oldSignature = methodSignature(cls.className, method.name, method.descriptor);
    const methodFacts = factsBySignature.get(oldSignature);
    if (!methodFacts) return;
    const parameters = parameterDescriptors(method.descriptor);
    if (!parameters || parameters.length === 0) return;

    const removed = [];
    for (let index = parameters.length - 1; index >= 0; index -= 1) {
      const fact = methodFacts.get(index);
      const descriptor = parameters[index];
      if (!fact || !INT_LIKE_DESCRIPTORS.has(descriptor) || localWidth(descriptor) !== 1) break;
      if (readsLocal(codeItems, fact.localIndex) || writesLocal(codeItems, fact.localIndex)) break;
      removed.unshift({
        index,
        descriptor,
        value: fact.value,
        discoveredIteration: fact.discoveredIteration,
      });
    }
    if (removed.length === 0) return;

    const kept = parameters.slice(0, parameters.length - removed.length);
    const returnDescriptor = method.descriptor.slice(method.descriptor.indexOf(')') + 1);
    const newDescriptor = `(${kept.join('')})${returnDescriptor}`;
    const newSignature = methodSignature(cls.className, method.name, newDescriptor);
    const newSourceKey = sourceMethodKey(cls.className, method.name, newDescriptor);
    if (occupied.has(newSourceKey)) return;
    const hierarchyCollision = (sourceMethods.get(sourceMethodShape(method.name, newDescriptor)) || [])
      .some((other) => classesAreRelated(cls.className, other.owner, classes));
    if (hierarchyCollision) return;
    proposals.push({
      owner: cls.className,
      name: method.name,
      oldDescriptor: method.descriptor,
      newDescriptor,
      oldSignature,
      newSignature,
      newSourceKey,
      removedParameters: removed,
    });
  });

  proposals.sort((a, b) => a.oldSignature.localeCompare(b.oldSignature));
  const compactions = [];
  const selectedSourceKeys = new Set(occupied);
  for (const proposal of proposals) {
    if (selectedSourceKeys.has(proposal.newSourceKey)) continue;
    const selectedHierarchyCollision = compactions.some((other) =>
      sourceMethodShape(other.name, other.newDescriptor)
        === sourceMethodShape(proposal.name, proposal.newDescriptor)
      && classesAreRelated(other.owner, proposal.owner, classes));
    if (selectedHierarchyCollision) continue;
    selectedSourceKeys.add(proposal.newSourceKey);
    proposal.callSiteSignatures = [proposal.oldSignature];
    compactions.push(proposal);
  }
  const compactionsByDefinition = new Map(compactions.map((item) => [item.oldSignature, item]));
  forEachMethod(astRoot, (_cls, _method, codeItems) => {
    for (const item of codeItems) {
      const instruction = item && item.instruction;
      if (!DIRECT_INVOKE_OPS.has(instructionOp(instruction))) continue;
      const ref = methodRef(instructionArg(instruction));
      if (!ref) continue;
      const resolvedOwner = resolveMethodOwner(ref.owner, ref.name, ref.descriptor, classes);
      const compaction = resolvedOwner && compactionsByDefinition.get(
        methodSignature(resolvedOwner, ref.name, ref.descriptor),
      );
      if (!compaction) continue;
      const callSiteSignature = methodSignature(ref.owner, ref.name, ref.descriptor);
      if (!compaction.callSiteSignatures.includes(callSiteSignature)) {
        compaction.callSiteSignatures.push(callSiteSignature);
      }
    }
  });
  for (const compaction of compactions) compaction.callSiteSignatures.sort();
  return { compactions, candidateCount: proposals.length };
}

function sourceMethodShape(name, descriptor) {
  const close = typeof descriptor === 'string' ? descriptor.indexOf(')') : -1;
  return close >= 0 ? `${name}${descriptor.slice(0, close + 1)}` : `${name}${descriptor}`;
}

function sourceMethodKey(owner, name, descriptor) {
  return `${owner}.${sourceMethodShape(name, descriptor)}`;
}

function classesAreRelated(first, second, classes) {
  if (first === second) return true;
  return classHasAncestor(first, second, classes) || classHasAncestor(second, first, classes);
}

function classHasAncestor(className, wanted, classes) {
  const pending = [className];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const cls = classes.get(current);
    if (!cls) continue;
    for (const parent of [cls.superClassName, ...(cls.interfaces || [])]) {
      if (!parent) continue;
      if (parent === wanted) return true;
      if (classes.has(parent)) pending.push(parent);
    }
  }
  return false;
}

function runInterproceduralSignatureCompaction(astRoot, options = {}) {
  const compactions = Array.isArray(options.compactions) ? options.compactions : [];
  const byOldSignature = new Map(compactions.map((item) => [item.oldSignature, item]));
  const byCallSiteSignature = new Map();
  for (const compaction of compactions) {
    for (const signature of compaction.callSiteSignatures || [compaction.oldSignature]) {
      byCallSiteSignature.set(signature, compaction);
    }
  }
  let methodsChanged = 0;
  let callSitesChanged = 0;
  let removedParameters = 0;

  forEachMethod(astRoot, (cls, method, codeItems) => {
    const ownSignature = methodSignature(cls.className, method.name, method.descriptor);
    const ownCompaction = byOldSignature.get(ownSignature);
    if (ownCompaction) {
      method.descriptor = ownCompaction.newDescriptor;
      methodsChanged += 1;
      removedParameters += ownCompaction.removedParameters.length;
    }

    for (let index = 0; index < codeItems.length; index += 1) {
      const item = codeItems[index];
      const instruction = item && item.instruction;
      const op = instructionOp(instruction);
      if (!DIRECT_INVOKE_OPS.has(op)) continue;
      const arg = instructionArg(instruction);
      const ref = methodRef(arg);
      if (!ref) continue;
      const compaction = byCallSiteSignature.get(
        methodSignature(ref.owner, ref.name, ref.descriptor),
      );
      if (!compaction) continue;

      const pops = compaction.removedParameters.map(() => ({ instruction: 'pop' }));
      if (item.labelDef != null && pops.length > 0) {
        pops[0].labelDef = item.labelDef;
        delete item.labelDef;
      }
      codeItems.splice(index, 0, ...pops);
      index += pops.length;
      arg[2][1] = compaction.newDescriptor;
      callSitesChanged += 1;
    }
  });

  return {
    changed: methodsChanged > 0 || callSitesChanged > 0,
    methodsChanged,
    callSitesChanged,
    removedParameters,
  };
}

function runImmediateConstantBranchDce(astRoot) {
  let foldedBranches = 0;
  let methodsAffected = 0;
  forEachMethod(astRoot, (_cls, _method, codeItems, code) => {
    const folded = foldImmediateConstantBranches(codeItems, code.exceptionTable || []);
    if (folded > 0) {
      foldedBranches += folded;
      methodsAffected += 1;
    }
  });
  return {
    changed: foldedBranches > 0,
    foldedBranches,
    methodsAffected,
  };
}

/**
 * Fold side-effect-free integer and long literal expressions in bytecode.
 *
 * Doing this before decompilation matters even though javac would fold the
 * same source expressions later: the decompiler otherwise has to render the
 * obfuscator's literal arithmetic, and constant conditions remain structured
 * as live branches. Integer operations deliberately use JVM overflow and
 * shift-distance semantics. Division and remainder by zero are left intact so
 * their ArithmeticException remains observable.
 */
function runConstantExpressionFold(astRoot) {
  let foldedExpressions = 0;
  let normalizedShiftCounts = 0;
  let simplifiedIdentities = 0;
  let combinedConstantChains = 0;
  let methodsAffected = 0;

  forEachMethod(astRoot, (_cls, _method, codeItems, code) => {
    const result = foldConstantExpressions(codeItems, code.exceptionTable || []);
    if (result.foldedExpressions > 0 || result.normalizedShiftCounts > 0
      || result.simplifiedIdentities > 0 || result.combinedConstantChains > 0) {
      methodsAffected += 1;
      foldedExpressions += result.foldedExpressions;
      normalizedShiftCounts += result.normalizedShiftCounts;
      simplifiedIdentities += result.simplifiedIdentities;
      combinedConstantChains += result.combinedConstantChains;
    }
  });

  return {
    changed: foldedExpressions > 0 || normalizedShiftCounts > 0
      || simplifiedIdentities > 0 || combinedConstantChains > 0,
    foldedExpressions,
    normalizedShiftCounts,
    simplifiedIdentities,
    combinedConstantChains,
    methodsAffected,
  };
}

function foldConstantExpressions(codeItems, exceptionTable = []) {
  const incomingLabels = collectIncomingLabels(codeItems, exceptionTable);
  let foldedExpressions = 0;
  let normalizedShiftCounts = 0;
  let simplifiedIdentities = 0;
  let combinedConstantChains = 0;

  for (let index = 0; index < codeItems.length; index += 1) {
    const item = codeItems[index];
    const op = item && instructionOp(item.instruction);
    if (!op) continue;

    if (isIntShift(op) || isLongShift(op)) {
      const countIndex = previousNonNopInstructionIndex(codeItems, index);
      const count = countIndex >= 0 && decodeIntConstant(codeItems[countIndex].instruction);
      if (count != null) {
        const normalized = count & (isLongShift(op) ? 63 : 31);
        if (normalized !== count) {
          codeItems[countIndex].instruction = intConstantInstruction(normalized);
          normalizedShiftCounts += 1;
        }
      }
    }

    if (simplifyRightIdentity(codeItems, index, op, incomingLabels)) {
      simplifiedIdentities += 1;
      continue;
    }

    if (simplifySimpleLeftIdentity(codeItems, index, op, incomingLabels)) {
      simplifiedIdentities += 1;
      continue;
    }

    if (combineAdditiveConstantChain(codeItems, index, op, incomingLabels)) {
      combinedConstantChains += 1;
      continue;
    }

    if (isUnaryIntConstantOp(op)) {
      const operandIndex = previousNonNopInstructionIndex(codeItems, index);
      if (operandIndex < 0 || regionHasIncomingEntry(
        codeItems, operandIndex + 1, index, incomingLabels,
      )) continue;
      const operand = decodeIntConstant(codeItems[operandIndex].instruction);
      if (operand == null) continue;
      const value = evaluateUnaryIntConstant(op, operand);
      if (value == null) continue;
      replaceExpressionWithConstant(
        codeItems, [operandIndex], index, intConstantInstruction(value),
      );
      foldedExpressions += 1;
      continue;
    }

    if (isBinaryIntConstantOp(op)) {
      const rightIndex = previousNonNopInstructionIndex(codeItems, index);
      const leftIndex = previousNonNopInstructionIndex(codeItems, rightIndex);
      if (leftIndex < 0 || rightIndex < 0 || regionHasIncomingEntry(
        codeItems, leftIndex + 1, index, incomingLabels,
      )) continue;
      const left = decodeIntConstant(codeItems[leftIndex].instruction);
      const right = decodeIntConstant(codeItems[rightIndex].instruction);
      if (left == null || right == null) continue;
      const value = evaluateBinaryIntConstant(op, left, right);
      if (value == null) continue;
      replaceExpressionWithConstant(
        codeItems, [leftIndex, rightIndex], index, intConstantInstruction(value),
      );
      foldedExpressions += 1;
      continue;
    }

    if (op === 'i2l') {
      const operandIndex = previousNonNopInstructionIndex(codeItems, index);
      if (operandIndex < 0 || regionHasIncomingEntry(
        codeItems, operandIndex + 1, index, incomingLabels,
      )) continue;
      const operand = decodeIntConstant(codeItems[operandIndex].instruction);
      if (operand == null) continue;
      replaceExpressionWithConstant(
        codeItems, [operandIndex], index, longConstantInstruction(BigInt(operand)),
      );
      foldedExpressions += 1;
      continue;
    }

    if (op === 'l2i') {
      const operandIndex = previousNonNopInstructionIndex(codeItems, index);
      if (operandIndex < 0 || regionHasIncomingEntry(
        codeItems, operandIndex + 1, index, incomingLabels,
      )) continue;
      const operand = decodeLongConstant(codeItems[operandIndex].instruction);
      if (operand == null) continue;
      replaceExpressionWithConstant(
        codeItems, [operandIndex], index, intConstantInstruction(Number(BigInt.asIntN(32, operand))),
      );
      foldedExpressions += 1;
      continue;
    }

    if (op === 'lneg') {
      const operandIndex = previousNonNopInstructionIndex(codeItems, index);
      if (operandIndex < 0 || regionHasIncomingEntry(
        codeItems, operandIndex + 1, index, incomingLabels,
      )) continue;
      const operand = decodeLongConstant(codeItems[operandIndex].instruction);
      if (operand == null) continue;
      replaceExpressionWithConstant(codeItems, [operandIndex], index,
        longConstantInstruction(BigInt.asIntN(64, -operand)));
      foldedExpressions += 1;
      continue;
    }

    if (isBinaryLongConstantOp(op)) {
      const rightIndex = previousNonNopInstructionIndex(codeItems, index);
      const leftIndex = previousNonNopInstructionIndex(codeItems, rightIndex);
      if (leftIndex < 0 || rightIndex < 0 || regionHasIncomingEntry(
        codeItems, leftIndex + 1, index, incomingLabels,
      )) continue;
      const left = decodeLongConstant(codeItems[leftIndex].instruction);
      const right = isLongShift(op)
        ? decodeIntConstant(codeItems[rightIndex].instruction)
        : decodeLongConstant(codeItems[rightIndex].instruction);
      if (left == null || right == null) continue;
      const value = evaluateBinaryLongConstant(op, left, right);
      if (value == null) continue;
      replaceExpressionWithConstant(
        codeItems, [leftIndex, rightIndex], index, longConstantInstruction(value),
      );
      foldedExpressions += 1;
      continue;
    }

    if (op === 'lcmp') {
      const rightIndex = previousNonNopInstructionIndex(codeItems, index);
      const leftIndex = previousNonNopInstructionIndex(codeItems, rightIndex);
      if (leftIndex < 0 || rightIndex < 0 || regionHasIncomingEntry(
        codeItems, leftIndex + 1, index, incomingLabels,
      )) continue;
      const left = decodeLongConstant(codeItems[leftIndex].instruction);
      const right = decodeLongConstant(codeItems[rightIndex].instruction);
      if (left == null || right == null) continue;
      replaceExpressionWithConstant(codeItems, [leftIndex, rightIndex], index,
        intConstantInstruction(left < right ? -1 : left > right ? 1 : 0));
      foldedExpressions += 1;
    }
  }

  return {
    foldedExpressions,
    normalizedShiftCounts,
    simplifiedIdentities,
    combinedConstantChains,
  };
}

function simplifyRightIdentity(codeItems, operatorIndex, op, incomingLabels) {
  const rightIndex = previousNonNopInstructionIndex(codeItems, operatorIndex);
  if (rightIndex < 0 || regionHasIncomingEntry(
    codeItems, rightIndex + 1, operatorIndex, incomingLabels,
  )) return false;

  const intValue = decodeIntConstant(codeItems[rightIndex].instruction);
  const longValue = decodeLongConstant(codeItems[rightIndex].instruction);
  const intIdentity = (intValue === 0 && (
    op === 'iadd' || op === 'isub' || op === 'ior' || op === 'ixor'
      || op === 'ishl' || op === 'ishr' || op === 'iushr'
  )) || (intValue === 1 && (op === 'imul' || op === 'idiv'))
    || (intValue === -1 && op === 'iand');
  const longIdentity = (longValue === 0n && (
    op === 'ladd' || op === 'lsub' || op === 'lor' || op === 'lxor'
  )) || (longValue === 1n && (op === 'lmul' || op === 'ldiv'))
    || (longValue === -1n && op === 'land');
  const longShiftIdentity = intValue === 0
    && (op === 'lshl' || op === 'lshr' || op === 'lushr');
  if (!intIdentity && !longIdentity && !longShiftIdentity) return false;

  codeItems[rightIndex].instruction = 'nop';
  codeItems[operatorIndex].instruction = 'nop';
  return true;
}

function simplifySimpleLeftIdentity(codeItems, operatorIndex, op, incomingLabels) {
  const rightIndex = previousNonNopInstructionIndex(codeItems, operatorIndex);
  const leftIndex = previousNonNopInstructionIndex(codeItems, rightIndex);
  if (leftIndex < 0 || rightIndex < 0 || regionHasIncomingEntry(
    codeItems, leftIndex + 1, operatorIndex, incomingLabels,
  )) return false;

  // Locating the start of an arbitrary stack expression needs full frame
  // analysis. The common obfuscator shape is a literal followed by a local
  // load, which is unambiguous and covers `1 * value` without reordering or
  // deleting evaluation of a potentially effectful expression.
  const rightOp = instructionOp(codeItems[rightIndex].instruction);
  const intLoad = /^iload(?:_[0-3])?$/.test(rightOp || '');
  const longLoad = /^lload(?:_[0-3])?$/.test(rightOp || '');
  const intValue = decodeIntConstant(codeItems[leftIndex].instruction);
  const longValue = decodeLongConstant(codeItems[leftIndex].instruction);
  const intIdentity = intLoad && (
    (intValue === 0 && (op === 'iadd' || op === 'ior' || op === 'ixor'))
    || (intValue === 1 && op === 'imul')
    || (intValue === -1 && op === 'iand')
  );
  const longIdentity = longLoad && (
    (longValue === 0n && (op === 'ladd' || op === 'lor' || op === 'lxor'))
    || (longValue === 1n && op === 'lmul')
    || (longValue === -1n && op === 'land')
  );
  if (!intIdentity && !longIdentity) return false;

  codeItems[leftIndex].instruction = 'nop';
  codeItems[operatorIndex].instruction = 'nop';
  return true;
}

function combineAdditiveConstantChain(codeItems, operatorIndex, op, incomingLabels) {
  if (op !== 'iadd' && op !== 'isub' && op !== 'ladd' && op !== 'lsub') return false;
  const rightIndex = previousNonNopInstructionIndex(codeItems, operatorIndex);
  const firstOperatorIndex = previousNonNopInstructionIndex(codeItems, rightIndex);
  const leftConstantIndex = previousNonNopInstructionIndex(codeItems, firstOperatorIndex);
  if (leftConstantIndex < 0 || firstOperatorIndex < 0 || rightIndex < 0) return false;
  const firstOp = instructionOp(codeItems[firstOperatorIndex].instruction);
  const isInt = op === 'iadd' || op === 'isub';
  if (isInt ? (firstOp !== 'iadd' && firstOp !== 'isub')
    : (firstOp !== 'ladd' && firstOp !== 'lsub')) return false;
  if (regionHasIncomingEntry(
    codeItems, firstOperatorIndex, operatorIndex, incomingLabels,
  )) return false;

  if (isInt) {
    const first = decodeIntConstant(codeItems[leftConstantIndex].instruction);
    const second = decodeIntConstant(codeItems[rightIndex].instruction);
    if (first == null || second == null) return false;
    const firstDelta = firstOp === 'iadd' ? first : (-first) | 0;
    const secondDelta = op === 'iadd' ? second : (-second) | 0;
    const combined = (firstDelta + secondDelta) | 0;
    rewriteAdditiveConstantChain(
      codeItems, leftConstantIndex, firstOperatorIndex, rightIndex, operatorIndex,
      combined, false,
    );
    return true;
  }

  const first = decodeLongConstant(codeItems[leftConstantIndex].instruction);
  const second = decodeLongConstant(codeItems[rightIndex].instruction);
  if (first == null || second == null) return false;
  const firstDelta = firstOp === 'ladd' ? first : BigInt.asIntN(64, -first);
  const secondDelta = op === 'ladd' ? second : BigInt.asIntN(64, -second);
  const combined = BigInt.asIntN(64, firstDelta + secondDelta);
  rewriteAdditiveConstantChain(
    codeItems, leftConstantIndex, firstOperatorIndex, rightIndex, operatorIndex,
    combined, true,
  );
  return true;
}

function rewriteAdditiveConstantChain(
  codeItems,
  constantIndex,
  firstOperatorIndex,
  secondConstantIndex,
  secondOperatorIndex,
  combined,
  isLong,
) {
  const zero = isLong ? 0n : 0;
  const minimum = isLong ? -(1n << 63n) : -2147483648;
  if (combined === zero) {
    codeItems[constantIndex].instruction = 'nop';
    codeItems[firstOperatorIndex].instruction = 'nop';
  } else if (combined < zero && combined !== minimum) {
    codeItems[constantIndex].instruction = isLong
      ? longConstantInstruction(-combined)
      : intConstantInstruction(-combined);
    codeItems[firstOperatorIndex].instruction = isLong ? 'lsub' : 'isub';
  } else {
    codeItems[constantIndex].instruction = isLong
      ? longConstantInstruction(combined)
      : intConstantInstruction(combined);
    codeItems[firstOperatorIndex].instruction = isLong ? 'ladd' : 'iadd';
  }
  codeItems[secondConstantIndex].instruction = 'nop';
  codeItems[secondOperatorIndex].instruction = 'nop';
}

function isUnaryIntConstantOp(op) {
  return op === 'ineg' || op === 'i2b' || op === 'i2c' || op === 'i2s';
}

function isBinaryIntConstantOp(op) {
  return op === 'iadd' || op === 'isub' || op === 'imul'
    || op === 'idiv' || op === 'irem' || op === 'iand'
    || op === 'ior' || op === 'ixor' || isIntShift(op);
}

function isIntShift(op) {
  return op === 'ishl' || op === 'ishr' || op === 'iushr';
}

function isLongShift(op) {
  return op === 'lshl' || op === 'lshr' || op === 'lushr';
}

function isBinaryLongConstantOp(op) {
  return op === 'ladd' || op === 'lsub' || op === 'lmul'
    || op === 'ldiv' || op === 'lrem' || op === 'land'
    || op === 'lor' || op === 'lxor' || isLongShift(op);
}

function evaluateUnaryIntConstant(op, value) {
  if (op === 'ineg') return (-value) | 0;
  if (op === 'i2b') return (value << 24) >> 24;
  if (op === 'i2c') return value & 0xffff;
  if (op === 'i2s') return (value << 16) >> 16;
  return null;
}

function evaluateBinaryIntConstant(op, left, right) {
  const a = left | 0;
  const b = right | 0;
  if (op === 'iadd') return (a + b) | 0;
  if (op === 'isub') return (a - b) | 0;
  if (op === 'imul') return Math.imul(a, b);
  if (op === 'idiv') return b === 0 ? null : Math.trunc(a / b) | 0;
  if (op === 'irem') return b === 0 ? null : (a % b) | 0;
  if (op === 'iand') return a & b;
  if (op === 'ior') return a | b;
  if (op === 'ixor') return a ^ b;
  if (op === 'ishl') return a << (b & 31);
  if (op === 'ishr') return a >> (b & 31);
  if (op === 'iushr') return (a >>> (b & 31)) | 0;
  return null;
}

function evaluateBinaryLongConstant(op, left, right) {
  const a = BigInt.asIntN(64, left);
  if (isLongShift(op)) {
    const distance = BigInt(Number(right) & 63);
    if (op === 'lshl') return BigInt.asIntN(64, a << distance);
    if (op === 'lshr') return BigInt.asIntN(64, a >> distance);
    return BigInt.asIntN(64, BigInt.asUintN(64, a) >> distance);
  }
  const b = BigInt.asIntN(64, right);
  if (op === 'ladd') return BigInt.asIntN(64, a + b);
  if (op === 'lsub') return BigInt.asIntN(64, a - b);
  if (op === 'lmul') return BigInt.asIntN(64, a * b);
  if (op === 'ldiv') return b === 0n ? null : BigInt.asIntN(64, a / b);
  if (op === 'lrem') return b === 0n ? null : BigInt.asIntN(64, a % b);
  if (op === 'land') return BigInt.asIntN(64, a & b);
  if (op === 'lor') return BigInt.asIntN(64, a | b);
  if (op === 'lxor') return BigInt.asIntN(64, a ^ b);
  return null;
}

function replaceExpressionWithConstant(codeItems, producerIndexes, resultIndex, instruction) {
  for (const producerIndex of producerIndexes) codeItems[producerIndex].instruction = 'nop';
  codeItems[resultIndex].instruction = instruction;
}

function previousNonNopInstructionIndex(codeItems, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const item = codeItems[cursor];
    if (!item || !item.instruction || instructionOp(item.instruction) === 'nop') continue;
    return cursor;
  }
  return -1;
}

function regionHasIncomingEntry(codeItems, startIndex, endIndex, incomingLabels) {
  for (let index = startIndex; index <= endIndex; index += 1) {
    if (hasIncomingLabel(codeItems[index], incomingLabels)) return true;
  }
  return false;
}

function foldImmediateConstantBranches(codeItems, exceptionTable = []) {
  const incomingLabels = collectIncomingLabels(codeItems, exceptionTable);
  let rewrites = 0;
  for (let index = 0; index < codeItems.length; index += 1) {
    const branch = codeItems[index];
    const branchOp = branch && instructionOp(branch.instruction);
    if (isUnaryIntBranch(branchOp)) {
      const firstIndex = previousNonNopInstructionIndex(codeItems, index);
      const first = firstIndex >= 0 && codeItems[firstIndex];
      const firstValue = first && decodeIntConstant(first.instruction);
      if (firstValue == null || regionHasIncomingEntry(
        codeItems, firstIndex + 1, index, incomingLabels,
      )) continue;
      rewriteConstantBranch([first], branch, evaluateUnaryBranch(branchOp, firstValue));
      rewrites += 1;
      continue;
    }

    if (!isBinaryIntBranch(branchOp)) continue;
    const secondIndex = previousNonNopInstructionIndex(codeItems, index);
    const firstIndex = previousNonNopInstructionIndex(codeItems, secondIndex);
    const first = firstIndex >= 0 && codeItems[firstIndex];
    const second = secondIndex >= 0 && codeItems[secondIndex];
    const firstValue = first && decodeIntConstant(first.instruction);
    const secondValue = second && decodeIntConstant(second.instruction);
    if (firstValue == null || secondValue == null || regionHasIncomingEntry(
      codeItems, firstIndex + 1, index, incomingLabels,
    )) continue;
    rewriteConstantBranch(
      [first, second],
      branch,
      evaluateBinaryBranch(branchOp, firstValue, secondValue),
    );
    rewrites += 1;
  }
  return rewrites;
}

function hasIncomingLabel(item, incomingLabels) {
  return !!(item && item.labelDef && incomingLabels.has(trimLabel(item.labelDef)));
}

function collectIncomingLabels(codeItems, exceptionTable) {
  const labels = new Set();
  for (const entry of exceptionTable || []) {
    // Try-range start/end labels only delimit exception coverage; they do not
    // transfer control into an instruction. Handler entries do, with an
    // exception object already on the operand stack, so those remain protected.
    for (const label of [
      entry.handlerLbl, entry.handlerLabel, entry.handler, entry.usingLbl,
    ]) {
      if (label != null) labels.add(trimLabel(label));
    }
  }
  for (const item of codeItems) {
    const instruction = item && item.instruction;
    const op = instructionOp(instruction);
    if (op === 'tableswitch') {
      for (const label of instruction.labels || []) labels.add(trimLabel(label));
      if (instruction.defaultLbl != null) labels.add(trimLabel(instruction.defaultLbl));
      continue;
    }
    if (op === 'lookupswitch') {
      const arg = instructionArg(instruction);
      for (const pair of (arg && arg.pairs) || []) {
        if (Array.isArray(pair) && pair[1] != null) labels.add(trimLabel(pair[1]));
      }
      if (arg && arg.defaultLabel != null) labels.add(trimLabel(arg.defaultLabel));
      continue;
    }
    if (op && (op.startsWith('if') || op === 'goto' || op === 'goto_w' || op === 'jsr' || op === 'jsr_w')) {
      const label = instructionArg(instruction);
      if (label != null) labels.add(trimLabel(label));
    }
  }
  return labels;
}

function trimLabel(label) {
  return typeof label === 'string' && label.endsWith(':') ? label.slice(0, -1) : label;
}

function rewriteConstantBranch(producers, branchItem, taken) {
  for (const producer of producers) producer.instruction = 'nop';
  branchItem.instruction = taken
    ? { op: 'goto', arg: instructionArg(branchItem.instruction) }
    : 'nop';
}

function isUnaryIntBranch(op) {
  return op === 'ifeq' || op === 'ifne' || op === 'iflt'
    || op === 'ifge' || op === 'ifgt' || op === 'ifle';
}

function isBinaryIntBranch(op) {
  return op === 'if_icmpeq' || op === 'if_icmpne' || op === 'if_icmplt'
    || op === 'if_icmpge' || op === 'if_icmpgt' || op === 'if_icmple';
}

function evaluateUnaryBranch(op, value) {
  if (op === 'ifeq') return value === 0;
  if (op === 'ifne') return value !== 0;
  if (op === 'iflt') return value < 0;
  if (op === 'ifge') return value >= 0;
  if (op === 'ifgt') return value > 0;
  return value <= 0;
}

function evaluateBinaryBranch(op, left, right) {
  if (op === 'if_icmpeq') return left === right;
  if (op === 'if_icmpne') return left !== right;
  if (op === 'if_icmplt') return left < right;
  if (op === 'if_icmpge') return left >= right;
  if (op === 'if_icmpgt') return left > right;
  return left <= right;
}

function collectDefinitions(astRoot) {
  const definitions = new Map();
  const classes = new Map(((astRoot && astRoot.classes) || [])
    .filter((cls) => cls && cls.className)
    .map((cls) => [cls.className, cls]));
  const externalCallbackClasses = findExternalCallbackClasses(classes);
  forEachMethod(astRoot, (cls, method, codeItems) => {
    if (method.name === '<init>' || method.name === '<clinit>') return;
    if (!isInternalTarget(cls, method, externalCallbackClasses)) return;
    const parameters = parameterDescriptors(method.descriptor);
    if (!parameters || parameters.length === 0) return;
    const isStatic = Array.isArray(method.flags) && method.flags.includes('static');
    let localIndex = isStatic ? 0 : 1;
    const signature = methodSignature(cls.className, method.name, method.descriptor);
    for (let parameterIndex = 0; parameterIndex < parameters.length; parameterIndex += 1) {
      const parameterDescriptor = parameters[parameterIndex];
      if (INT_LIKE_DESCRIPTORS.has(parameterDescriptor) && !writesLocal(codeItems, localIndex)) {
        const key = factKey(signature, parameterIndex);
        definitions.set(key, {
          key,
          signature,
          owner: cls.className,
          name: method.name,
          descriptor: method.descriptor,
          parameterIndex,
          parameterDescriptor,
          localIndex,
        });
      }
      localIndex += localWidth(parameterDescriptor);
    }
  });
  return definitions;
}

function rejectRawMethodCalls(codeItems, definitionsBySignature, observations, classes) {
  for (const item of codeItems) {
    const instruction = item && item.instruction;
    const op = instructionOp(instruction);
    if (!op || !op.startsWith('invoke')) continue;
    const ref = methodRef(instructionArg(instruction));
    if (!ref) continue;
    const resolvedOwner = resolveMethodOwner(ref.owner, ref.name, ref.descriptor, classes);
    const definitions = resolvedOwner && definitionsBySignature.get(
      methodSignature(resolvedOwner, ref.name, ref.descriptor),
    );
    for (const definition of definitions || []) {
      const observation = observations.get(definition.key);
      observation.callCount += 1;
      observation.rejected = true;
    }
  }
}

function classMap(astRoot) {
  return new Map(((astRoot && astRoot.classes) || [])
    .filter((cls) => cls && cls.className)
    .map((cls) => [cls.className, cls]));
}

function resolveMethodOwner(owner, name, descriptor, classes) {
  const pending = [owner];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const cls = classes.get(current);
    if (!cls) continue;
    const declared = (cls.items || []).some((item) => item && item.type === 'method'
      && item.method && item.method.name === name && item.method.descriptor === descriptor);
    if (declared) return current;
    // Class inheritance wins over interface lookup during JVM resolution.
    if (cls.superClassName) pending.unshift(cls.superClassName);
    pending.push(...(cls.interfaces || []));
  }
  return null;
}

function invocationArgumentValues(invocation, parameters) {
  if (!invocation || !Array.isArray(invocation.consumed) || !Array.isArray(parameters)) return null;
  const values = new Array(parameters.length).fill(null);
  let consumedIndex = 0;
  for (let parameterIndex = parameters.length - 1; parameterIndex >= 0; parameterIndex -= 1) {
    const consumed = invocation.consumed[consumedIndex];
    if (!consumed || consumed.width !== localWidth(parameters[parameterIndex])) return null;
    if (INT_LIKE_DESCRIPTORS.has(parameters[parameterIndex])
      && consumed.kind === 'constant' && consumed.type === 'int'
      && Number.isInteger(consumed.value)) {
      values[parameterIndex] = consumed.value | 0;
    }
    consumedIndex += 1;
  }
  return values;
}

function isInternalTarget(cls, method, externalCallbackClasses) {
  const methodFlags = Array.isArray(method.flags) ? method.flags : [];
  if (methodFlags.includes('private')) return true;
  const classFlags = Array.isArray(cls.flags) ? cls.flags : [];
  if (classFlags.includes('public')) return false;
  if (methodFlags.includes('static')) return true;
  return !externalCallbackClasses.has(cls.className);
}

function findExternalCallbackClasses(classes) {
  const external = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, cls] of classes) {
      if (external.has(name)) continue;
      const externalInterface = (cls.interfaces || []).some((iface) => !classes.has(iface));
      const superName = cls.superClassName;
      const externalSuper = !!superName
        && superName !== 'java/lang/Object'
        && (!classes.has(superName) || external.has(superName));
      if (externalInterface || externalSuper) {
        external.add(name);
        changed = true;
      }
    }
  }
  return external;
}

function forEachMethod(astRoot, callback) {
  for (const cls of (astRoot && astRoot.classes) || []) {
    for (const item of cls.items || []) {
      if (!item || item.type !== 'method' || !item.method) continue;
      for (const attribute of item.method.attributes || []) {
        const code = attribute && attribute.type === 'code' && attribute.code;
        if (!code || !Array.isArray(code.codeItems)) continue;
        callback(cls, item.method, code.codeItems, code);
      }
    }
  }
}

function precedingIntConstant(codeItems, invokeIndex) {
  let previous = previousInstruction(codeItems, invokeIndex);
  if (!previous) return null;
  let cast = null;
  const castOp = instructionOp(previous.instruction);
  if (castOp === 'i2b' || castOp === 'i2c' || castOp === 'i2s') {
    cast = castOp;
    previous = previousInstruction(codeItems, previous.index);
    if (!previous) return null;
  }
  let value = decodeIntConstant(previous.instruction);
  if (value == null) return null;
  if (cast === 'i2b') value = (value << 24) >> 24;
  else if (cast === 'i2c') value &= 0xffff;
  else if (cast === 'i2s') value = (value << 16) >> 16;
  return value | 0;
}

function decodeIntConstant(instruction) {
  const op = instructionOp(instruction);
  if (op === 'iconst_m1') return -1;
  const iconst = /^iconst_([0-5])$/.exec(op || '');
  if (iconst) return Number(iconst[1]);
  if (op !== 'bipush' && op !== 'sipush' && op !== 'ldc' && op !== 'ldc_w') return null;
  const arg = instructionArg(instruction);
  if (typeof arg === 'number' && Number.isInteger(arg)) return arg;
  if (typeof arg === 'string' && /^-?\d+$/.test(arg.trim())) return Number(arg.trim());
  if (arg && typeof arg === 'object'
    && (!arg.type || arg.type === 'Integer' || arg.type === 'Int' || arg.type === 'int')
    && Number.isInteger(arg.value)) return arg.value;
  return null;
}

function decodeLongConstant(instruction) {
  const op = instructionOp(instruction);
  if (op === 'lconst_0') return 0n;
  if (op === 'lconst_1') return 1n;
  if (op !== 'ldc2_w') return null;
  const arg = instructionArg(instruction);
  if (typeof arg === 'bigint') return BigInt.asIntN(64, arg);
  if (typeof arg === 'number' && Number.isSafeInteger(arg)) return BigInt.asIntN(64, BigInt(arg));
  if (typeof arg === 'string' && /^-?\d+[lL]?$/.test(arg.trim())) {
    return BigInt.asIntN(64, BigInt(arg.trim().replace(/[lL]$/, '')));
  }
  if (arg && typeof arg === 'object'
    && (arg.type === 'Long' || arg.type === 'long')
    && /^-?\d+[lL]?$/.test(String(arg.value).trim())) {
    return BigInt.asIntN(64, BigInt(String(arg.value).trim().replace(/[lL]$/, '')));
  }
  return null;
}

function intConstantInstruction(value) {
  if (value === -1) return 'iconst_m1';
  if (value >= 0 && value <= 5) return `iconst_${value}`;
  if (value >= -128 && value <= 127) return { op: 'bipush', arg: String(value) };
  if (value >= -32768 && value <= 32767) return { op: 'sipush', arg: String(value) };
  return { op: 'ldc', arg: value };
}

function longConstantInstruction(value) {
  const normalized = BigInt.asIntN(64, value);
  if (normalized === 0n) return 'lconst_0';
  if (normalized === 1n) return 'lconst_1';
  return { op: 'ldc2_w', arg: normalized };
}

function writesLocal(codeItems, localIndex) {
  for (const item of codeItems) {
    const instruction = item && item.instruction;
    const op = instructionOp(instruction);
    if (INT_STORE_OPS.has(op) && localIndexOf(instruction, op) === localIndex) return true;
    if (op === 'iinc' && iincLocal(instruction) === localIndex) return true;
  }
  return false;
}

function readsLocal(codeItems, localIndex) {
  for (const item of codeItems) {
    const instruction = item && item.instruction;
    const op = instructionOp(instruction);
    if (INT_LOAD_OPS.has(op) && localIndexOf(instruction, op) === localIndex) return true;
  }
  return false;
}

function iincLocal(instruction) {
  if (instruction && typeof instruction === 'object') {
    const varnum = Number.parseInt(instruction.varnum, 10);
    if (Number.isInteger(varnum)) return varnum;
  }
  const arg = instructionArg(instruction);
  if (arg && typeof arg === 'object' && Number.isInteger(arg.local)) return arg.local;
  if (typeof arg === 'number') return arg;
  if (typeof arg === 'string') {
    const match = /^(\d+)\b/.exec(arg.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

function localIndexOf(instruction, op) {
  const numbered = /_(\d)$/.exec(op || '');
  if (numbered) return Number(numbered[1]);
  const arg = instructionArg(instruction);
  if (typeof arg === 'number') return arg;
  if (typeof arg === 'string' && /^\d+$/.test(arg.trim())) return Number(arg.trim());
  if (Array.isArray(arg) && arg.length > 0) return Number(arg[0]);
  return null;
}

function previousInstruction(codeItems, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const item = codeItems[cursor];
    if (item && item.instruction) return { instruction: item.instruction, index: cursor };
  }
  return null;
}

function parameterDescriptors(descriptor) {
  if (typeof descriptor !== 'string' || descriptor[0] !== '(') return null;
  const parameters = [];
  let cursor = 1;
  while (cursor < descriptor.length && descriptor[cursor] !== ')') {
    const start = cursor;
    while (descriptor[cursor] === '[') cursor += 1;
    if (descriptor[cursor] === 'L') {
      cursor = descriptor.indexOf(';', cursor);
      if (cursor < 0) return null;
      cursor += 1;
    } else if ('ZBCSIJFD'.includes(descriptor[cursor])) {
      cursor += 1;
    } else {
      return null;
    }
    parameters.push(descriptor.slice(start, cursor));
  }
  return descriptor[cursor] === ')' ? parameters : null;
}

function localWidth(descriptor) {
  return descriptor === 'J' || descriptor === 'D' ? 2 : 1;
}

function methodRef(arg) {
  if (!Array.isArray(arg) || arg.length < 3 || !Array.isArray(arg[2])) return null;
  const owner = arg[1];
  const [name, descriptor] = arg[2];
  if (!owner || !name || !descriptor) return null;
  return { owner, name, descriptor };
}

function methodSignature(owner, name, descriptor) {
  return `${owner}.${name}${descriptor}`;
}

function factKey(signature, parameterIndex) {
  return `${signature}#${parameterIndex}`;
}

function instructionOp(instruction) {
  return typeof instruction === 'string' ? instruction : instruction && instruction.op;
}

function instructionArg(instruction) {
  return instruction && typeof instruction === 'object' ? instruction.arg : null;
}

module.exports = {
  discoverInterproceduralSignatureCompactions,
  discoverInterproceduralConstantArguments,
  runInterproceduralConstantArgumentFixedPoint,
  runConstantExpressionFold,
  runImmediateConstantBranchDce,
  runInterproceduralConstantArguments,
  runInterproceduralSignatureCompaction,
  _internals: {
    decodeIntConstant,
    decodeLongConstant,
    evaluateBinaryIntConstant,
    evaluateBinaryLongConstant,
    findExternalCallbackClasses,
    foldConstantExpressions,
    foldImmediateConstantBranches,
    invocationArgumentValues,
    isInternalTarget,
    parameterDescriptors,
    precedingIntConstant,
  },
};
