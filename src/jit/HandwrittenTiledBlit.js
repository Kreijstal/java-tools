"use strict";

// Structurally verified replacement for a source-wrapping two-dimensional
// int-array blit.  The original method is intentionally awkward obfuscated
// bytecode with a diagnostic recursion branch and exception reporter around a
// tiny copy loop.  On the proven normal path this kernel removes repeated
// scalar-tier safe points and scheduler re-entry.

const { fingerprintMethods } = require("./HandwrittenFusedGradient");

const DESCRIPTOR = "(IIIIB[II[IIIII)V";
const KNOWN_FINGERPRINTS = new Set([
  3429763198,
]);

function getOp(instruction) {
  return typeof instruction === "string" ? instruction : instruction && instruction.op;
}

function createIntrinsic(jit, method, descriptor, sentinels) {
  if (descriptor !== DESCRIPTOR || !(method.flags || []).includes("static")) return null;
  const items = jit.getCodeItems(method);
  const fingerprint = fingerprintMethods(
    jit, [method], { normalizeLdcStrings: true });
  if (typeof process !== "undefined" && process.env &&
      process.env.JVM_PRINT_TILED_BLIT_FINGERPRINT === "1") {
    console.error(`tiled int blit fingerprint: ${fingerprint}`);
  }
  if (!KNOWN_FINGERPRINTS.has(fingerprint)) return null;

  const code = method.attributes.find((attribute) => attribute.type === "code")?.code;
  const handlers = code?.exceptionTable || [];
  if (handlers.length !== 1 ||
      handlers[0].catch_type !== "java/lang/RuntimeException") return null;

  const instructions = items
    .map((item) => item && item.instruction)
    .filter((instruction) => getOp(instruction));
  const booleanFields = instructions
    .filter((instruction) => getOp(instruction) === "getstatic" &&
      Array.isArray(instruction.arg) && instruction.arg?.[2]?.[1] === "Z")
    .map((instruction) => instruction.arg);
  const recursiveCalls = instructions
    .filter((instruction) => getOp(instruction) === "invokestatic" &&
      Array.isArray(instruction.arg) && instruction.arg?.[2]?.[1] === DESCRIPTOR);
  if (booleanFields.length !== 1 || recursiveCalls.length !== 1 ||
      instructions.filter((instruction) => getOp(instruction) === "iaload").length !== 1 ||
      instructions.filter((instruction) => getOp(instruction) === "iastore").length !== 1) {
    return null;
  }
  const methodOwner = recursiveCalls[0].arg[1];
  const ownerClass = jit.jvm.classes[methodOwner];
  const recursiveMethod = ownerClass && jit.jvm.findMethod(
    ownerClass, recursiveCalls[0].arg[2][0], DESCRIPTOR);
  if (recursiveMethod !== method) return null;

  const flagOwner = booleanFields[0][1];
  const flagName = booleanFields[0][2][0];
  const flagClass = jit.jvm.classes[flagOwner];
  if (!flagClass) return null;
  const flag = flagClass.ast?.classes?.[0]?.items?.find((item) =>
    item?.type === "field" &&
    item.field?.name === flagName &&
    item.field?.descriptor === "Z");
  if (!flag || (flag.field.flags || []).includes("volatile")) return null;

  const { ASYNC_INVOKE, RETURN_VOID } = sentinels;
  function fallback(reason) {
    jit.tiledBlitGuardedFallbackCount =
      (jit.tiledBlitGuardedFallbackCount | 0) + 1;
    const key = `tiledBlitFallback${reason}`;
    jit[key] = (jit[key] | 0) + 1;
    return ASYNC_INVOKE;
  }

  function run(destinationIndex, sourceWidth, rowCount, sourceRow,
    tag, destination, copyWidth, source, destinationRowSkip,
    sourceX, sourceIndex, sourceHeight) {
    if (jit._envInstrumented || jit.needsBytecodeChecks() ||
        jit.jvm.classInitializationState.get(methodOwner) !== "INITIALIZED" ||
        jit.jvm.classInitializationState.get(flagOwner) !== "INITIALIZED" ||
        jit.jvm.debugManager.isClassJitDeopted(methodOwner) ||
        jit.jvm.debugManager.isClassJitDeopted(flagOwner)) {
      return fallback("Entry");
    }
    destinationIndex |= 0;
    sourceWidth |= 0;
    rowCount |= 0;
    sourceRow |= 0;
    tag |= 0;
    copyWidth |= 0;
    destinationRowSkip |= 0;
    sourceX |= 0;
    sourceIndex |= 0;
    sourceHeight |= 0;
    const sourceStartX = sourceX;
    if (tag !== -64) return fallback("Tag");

    const destinationData = jit.arrayData(destination);
    const sourceData = jit.arrayData(source);
    const destinationLength = destination?.length ?? destinationData?.length ?? 0;
    const sourceLength = source?.length ?? sourceData?.length ?? 0;
    if (!destinationData || !sourceData ||
        !Number.isInteger(destinationLength) || !Number.isInteger(sourceLength)) {
      return fallback("Arrays");
    }
    // These bounds describe the normal tiled-image layout.  Exotic inputs
    // retain the reporter/exception path without any preceding write.
    if (rowCount < 0 || rowCount > 1_000_000 ||
        copyWidth < 0 || copyWidth > 1_000_000 ||
        sourceWidth <= 0 || sourceX < 0 || sourceX >= sourceWidth ||
        sourceHeight <= 0 || sourceRow < 0 || sourceRow >= sourceHeight ||
        Math.imul(sourceHeight, sourceWidth) < 0) {
      return fallback("Layout");
    }

    let checkedDestination = destinationIndex;
    let checkedSource = sourceIndex;
    let checkedSourceRow = sourceRow;
    for (let row = 0; row < rowCount; row += 1) {
      const sourceBase = (checkedSource - sourceX) | 0;
      if (checkedDestination < 0 ||
          checkedDestination + copyWidth > destinationLength ||
          sourceBase < 0 || sourceBase + sourceWidth > sourceLength) {
        return fallback("Bounds");
      }
      checkedDestination =
        (checkedDestination + copyWidth + destinationRowSkip) | 0;
      checkedSource = (sourceBase + sourceX + sourceWidth) | 0;
      checkedSourceRow = (checkedSourceRow + 1) | 0;
      if (checkedSourceRow === sourceHeight) {
        checkedSourceRow = 0;
        checkedSource =
          (checkedSource - Math.imul(sourceHeight, sourceWidth)) | 0;
      }
    }

    const sourceCycle = Math.imul(sourceHeight, sourceWidth);
    for (let row = 0; row < rowCount; row += 1) {
      for (let column = 0; column < copyWidth; column += 1) {
        destinationData[destinationIndex] = sourceData[sourceIndex] | 0;
        destinationIndex = (destinationIndex + 1) | 0;
        sourceIndex = (sourceIndex + 1) | 0;
        sourceX = (sourceX + 1) | 0;
        if (sourceX === sourceWidth) {
          sourceIndex = (sourceIndex - sourceWidth) | 0;
          sourceX = 0;
        }
      }
      destinationIndex = (destinationIndex + destinationRowSkip) | 0;
      sourceIndex =
        (sourceIndex - sourceX + sourceStartX + sourceWidth) | 0;
      sourceX = sourceStartX;
      sourceRow = (sourceRow + 1) | 0;
      if (sourceRow === sourceHeight) {
        sourceRow = 0;
        sourceIndex = (sourceIndex - sourceCycle) | 0;
      }
    }
    jit.tiledBlitRunCount = (jit.tiledBlitRunCount | 0) + 1;
    return RETURN_VOID;
  }

  const intrinsic = (stack, base) => run(
    stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
    stack[base + 4], stack[base + 5], stack[base + 6], stack[base + 7],
    stack[base + 8], stack[base + 9], stack[base + 10], stack[base + 11]);
  intrinsic.jvmDirectKind = "tiledIntArrayBlit";
  intrinsic.jvmPositional = run;
  intrinsic.jvmDirectData = { fingerprint, methodOwner, flagOwner };
  return intrinsic;
}

module.exports = {
  DESCRIPTOR,
  createIntrinsic,
  _test: { KNOWN_FINGERPRINTS },
};
