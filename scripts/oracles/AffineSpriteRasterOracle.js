"use strict";

// Historical oracle for a column-oriented affine sprite/mask rasterizer.
// Recognition is independent of guest class, method, and field names:
//
// - the complete descriptor and verified CFG/stack shape must match;
// - the method must call the same verified (III)I helper exactly twice;
// - repeated instance/static field relationships must match; and
// - identity-canonicalized bytecode fingerprints must identify an audited
//   compiler layout of the same algorithm.
//
// Entry validates all array/layout assumptions before the first pixel write.
// A rejected entry therefore delegates to the canonical implementation with
// no fused side effect and retains its normal Java exception semantics.

const FusedRegionCompiler = require("../../src/jit/FusedRegionCompiler");
const { fingerprintMethods } = require("./FusedGradientOracle");

const DESCRIPTOR = /^\(L[^;]+;L[^;]+;IIIIIIZZII\)V$/;
const KNOWN_CALLER_FINGERPRINTS = new Set([
  1773827786, // original classfile
  1163529563, // decompile + javac
]);
const KNOWN_HELPER_FINGERPRINTS = new Set([
  1778623157,
  182681963,
]);
const KNOWN_SUITE_FINGERPRINTS = new Set([
  2237033000,
  1400128061,
]);

function getOp(instruction) {
  return typeof instruction === "string" ? instruction : instruction && instruction.op;
}

function refKey(ref) {
  return JSON.stringify(ref);
}

function uniqueRefs(refs) {
  const result = [];
  const seen = new Set();
  for (const ref of refs) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function descriptorOf(ref) {
  return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
}

function ownerOf(ref) {
  return Array.isArray(ref) ? ref[1] : null;
}

function instructions(jit, method) {
  return jit.getCodeItems(method)
    .map((item) => item && item.instruction)
    .filter((instruction) => getOp(instruction));
}

function resolveMethod(jit, instruction) {
  const ref = instruction?.arg;
  if (!Array.isArray(ref) || !Array.isArray(ref[2])) return null;
  const classData = jit.jvm.classes[ref[1]];
  return classData
    ? jit.jvm.findMethod(classData, ref[2][0], ref[2][1]) || null
    : null;
}

function codeIsVerified(jit, method) {
  const codeItems = jit.getCodeItems(method);
  if (!codeItems.length) return false;
  const code = method.attributes?.find((attribute) => attribute.type === "code");
  const handlers = code?.code?.exceptionTable || [];
  if (handlers.length && !jit.hasOnlyNoOpExceptionHandlers(method, codeItems)) {
    return false;
  }
  const labels = FusedRegionCompiler._test.buildLabelMap(codeItems);
  return Boolean(jit.computeStackDepths(codeItems, labels));
}

function matchingCalls(jit, method) {
  return instructions(jit, method).filter((instruction) =>
    getOp(instruction) === "invokestatic" &&
    Array.isArray(instruction.arg) &&
    Array.isArray(instruction.arg[2]) &&
    instruction.arg[2][1] === "(III)I");
}

// This cheap probe exists only so a caller can be reconsidered after its
// structurally referenced helper owner loads. Full installation still requires
// the complete suite proof in analyze().
function candidateDependencies(jit, method, descriptor) {
  if (!DESCRIPTOR.test(descriptor) ||
      !KNOWN_CALLER_FINGERPRINTS.has(fingerprintMethods(jit, [method]))) {
    return null;
  }
  const calls = matchingCalls(jit, method);
  if (calls.length !== 2 || refKey(calls[0].arg) !== refKey(calls[1].arg)) {
    return null;
  }
  return [calls[0].arg[1]];
}

function analyze(jit, method, descriptor) {
  if (!DESCRIPTOR.test(descriptor) ||
      !(method.flags || []).includes("static") ||
      !codeIsVerified(jit, method)) return null;
  const callerFingerprint = fingerprintMethods(jit, [method]);
  if (!KNOWN_CALLER_FINGERPRINTS.has(callerFingerprint)) return null;

  const calls = matchingCalls(jit, method);
  if (calls.length !== 2 || refKey(calls[0].arg) !== refKey(calls[1].arg)) {
    return null;
  }
  const helperMethod = resolveMethod(jit, calls[0]);
  if (!helperMethod || !(helperMethod.flags || []).includes("static") ||
      !codeIsVerified(jit, helperMethod)) return null;
  const helperFingerprint = fingerprintMethods(jit, [helperMethod]);
  const suiteFingerprint = fingerprintMethods(jit, [method, helperMethod]);
  if (!KNOWN_HELPER_FINGERPRINTS.has(helperFingerprint) ||
      !KNOWN_SUITE_FINGERPRINTS.has(suiteFingerprint)) return null;

  const code = instructions(jit, method);
  const instanceRefs = code
    .filter((instruction) => getOp(instruction) === "getfield")
    .map((instruction) => instruction.arg);
  const staticRefs = code
    .filter((instruction) => getOp(instruction) === "getstatic")
    .map((instruction) => instruction.arg);
  const instanceInts = uniqueRefs(instanceRefs.filter((ref) => descriptorOf(ref) === "I"));
  const instancePixels = uniqueRefs(instanceRefs.filter((ref) => descriptorOf(ref) === "[I"));
  const instanceMasks = uniqueRefs(instanceRefs.filter((ref) => descriptorOf(ref) === "[B"));
  const staticInts = uniqueRefs(staticRefs.filter((ref) => descriptorOf(ref) === "I"));
  const staticPixels = uniqueRefs(staticRefs.filter((ref) => descriptorOf(ref) === "[I"));

  if (instanceInts.length !== 2 || instancePixels.length !== 1 ||
      instanceMasks.length !== 1 || staticInts.length !== 5 ||
      staticPixels.length !== 1) return null;
  const exactlyTwice = (ref) =>
    staticRefs.filter((candidate) => refKey(candidate) === refKey(ref)).length === 2;
  if (![...staticInts, ...staticPixels].every(exactlyTwice)) return null;

  // Fingerprinting proves the instruction order. First-use order now gives
  // semantic roles without consulting any owner/member spelling.
  return {
    callerFingerprint,
    helperFingerprint,
    suiteFingerprint,
    helperMethod,
    classOwners: uniqueRefs([
      method.className || jit.jvm.findClassNameForMethod?.(method) || null,
      calls[0].arg[1],
      ...instanceRefs.map(ownerOf),
      ...staticRefs.map(ownerOf),
    ].filter(Boolean)),
    fields: {
      spriteWidth: instanceInts[0],
      spriteHeight: instanceInts[1],
      spritePixels: instancePixels[0],
      maskPixels: instanceMasks[0],
      clipOuterStart: staticInts[0],
      clipOuterEnd: staticInts[1],
      clipInnerStart: staticInts[2],
      clipInnerEnd: staticInts[3],
      surfaceStride: staticInts[4],
      destination: staticPixels[0],
    },
  };
}

function readLocation(location) {
  return location.kind === "map"
    ? location.fields.get(location.key)
    : location.fields[location.key];
}

function bindStaticLocation(jit, ref) {
  const site = jit.registerFieldSite(ref);
  const direct = jit.registerDirectStaticTarget(site) ||
    jit.registerDirectStaticTarget(site, true);
  return direct ? jit.directStaticTargets[direct.targetId] || null : null;
}

function javaDivide(numerator, denominator) {
  return (numerator / denominator) | 0;
}

// The verified helper computes floor division for a positive denominator.
// Its unused first parameter is intentionally absent from this scalar form.
function roundedFloorDivide(denominator, numerator) {
  const sign = numerator >>> 31;
  return (javaDivide((numerator + sign) | 0, denominator) - sign) | 0;
}

function runRaster(data, args) {
  const {
    width, height, source, mask, destination,
    clipOuterStart, clipOuterEnd, clipInnerStart, clipInnerEnd, surfaceStride,
  } = data;
  let [
    outerStart, outerEnd, leftStart, leftEnd, rightStart, rightEnd,
    dim, blend, sourceOffset, maskOverride,
  ] = args.map((value) => value | 0);
  const outerSpan = (outerEnd - outerStart) | 0;
  let firstOuter = outerStart;
  if (firstOuter < clipOuterStart) firstOuter = clipOuterStart;
  let lastOuter = outerEnd;
  if (lastOuter > clipOuterEnd) lastOuter = clipOuterEnd;
  if (firstOuter >= lastOuter) return true;

  const sourceLength = width * height;
  if (outerSpan <= 0 || width <= 0 || height <= 0 ||
      !Number.isSafeInteger(sourceLength) || sourceLength > 0x7fffffff ||
      source.length < sourceLength ||
      (mask && mask.length < sourceLength) ||
      surfaceStride <= 0 || clipOuterStart < 0 || clipOuterEnd < clipOuterStart ||
      clipInnerStart < 0 || clipInnerEnd < clipInnerStart ||
      clipOuterEnd > surfaceStride ||
      sourceOffset < 0 || sourceOffset > (0x7fffffff - width) ||
      (maskOverride >= 0 && maskOverride >= width)) return false;

  const lastDestination =
    (clipInnerEnd - 1) * surfaceStride + (clipOuterEnd - 1);
  if (clipInnerEnd > clipInnerStart &&
      (!Number.isSafeInteger(lastDestination) ||
       lastDestination < 0 || lastDestination >= destination.length)) return false;

  const leftDelta = (leftEnd - leftStart) | 0;
  const rightDelta = (rightEnd - rightStart) | 0;
  // Validate every row's division denominator before the first write. Source
  // coordinates need no row pass: with positive span/width and non-negative
  // offset, the verified clamp and remainder always produce [0, width).
  for (let outer = firstOuter; outer < lastOuter; outer += 1) {
    const offset = (outer - outerStart) | 0;
    const left = (
      Math.imul(leftStart, outerSpan) +
      Math.imul(leftDelta, offset) +
      (leftDelta >> 1)
    ) | 0;
    const right = (
      Math.imul(rightStart, outerSpan) +
      Math.imul(rightDelta, offset) +
      (rightDelta >> 1)
    ) | 0;
    const innerSpan = (right - left) | 0;
    const sourceLimit = height * innerSpan;
    if (innerSpan <= 0 || !Number.isSafeInteger(sourceLimit) ||
        sourceLimit > 0x7fffffff) return false;
  }

  for (let outer = firstOuter; outer < lastOuter; outer += 1) {
    const offset = (outer - outerStart) | 0;
    let maskX = javaDivide(
      (Math.imul(width, offset) + (outerSpan >> 1)) | 0, outerSpan);
    if (maskX >= width) maskX = (width - 1) | 0;
    const sourceX = ((maskX + sourceOffset) | 0) % width;
    if (maskOverride >= 0) maskX = maskOverride;
    const left = (
      Math.imul(leftStart, outerSpan) +
      Math.imul(leftDelta, offset) +
      (leftDelta >> 1)
    ) | 0;
    const right = (
      Math.imul(rightStart, outerSpan) +
      Math.imul(rightDelta, offset) +
      (rightDelta >> 1)
    ) | 0;
    const innerSpan = (right - left) | 0;
    let firstInner = roundedFloorDivide(
      outerSpan, (left + (outerSpan >> 1)) | 0);
    if (firstInner < clipInnerStart) firstInner = clipInnerStart;
    let lastInner = roundedFloorDivide(
      outerSpan, (right + (outerSpan >> 1)) | 0);
    if (lastInner > clipInnerEnd) lastInner = clipInnerEnd;
    if (lastInner <= firstInner) continue;

    let sourceFixed = (
      Math.imul(height, (Math.imul(firstInner, outerSpan) - left) | 0) +
      (innerSpan >> 1)
    ) | 0;
    let sourceFixedLast = (
      Math.imul(height,
        (Math.imul((lastInner - 1) | 0, outerSpan) - left) | 0) +
      (innerSpan >> 1)
    ) | 0;
    if (sourceFixed <= -innerSpan) sourceFixed = (-innerSpan + 1) | 0;
    const sourceLimit = Math.imul(height, innerSpan);
    if (sourceFixed >= sourceLimit) sourceFixed = (sourceLimit - 1) | 0;
    if (sourceFixedLast >= sourceLimit) sourceFixedLast = (sourceLimit - 1) | 0;
    let sourceStep = 0;
    if (sourceFixedLast > sourceFixed) {
      const innerDenominator = (lastInner - firstInner - 1) | 0;
      sourceStep = javaDivide(
        (sourceFixedLast - sourceFixed) | 0, innerDenominator);
    }

    let destinationIndex =
      (Math.imul(firstInner, surfaceStride) + outer) | 0;
    for (let inner = firstInner; inner < lastInner; inner += 1) {
      const sourceY = javaDivide(sourceFixed, innerSpan);
      const sourceRow = Math.imul(sourceY, width);
      let color = source[(sourceRow + sourceX) | 0] | 0;
      if (color !== 0 &&
          (!mask || (mask[(sourceRow + maskX) | 0] | 0) !== 0)) {
        if (dim) color = (color >> 1) & 8355711;
        if (blend) {
          color = (
            color + ((destination[destinationIndex] >> 1) & 8355711)
          ) | 0;
        }
        destination[destinationIndex] = color;
      }
      destinationIndex = (destinationIndex + surfaceStride) | 0;
      sourceFixed = (sourceFixed + sourceStep) | 0;
    }
  }
  return true;
}

function createIntrinsic(jit, method, descriptor, sentinels) {
  if (!jit.affineSpriteRasterEnabled) return null;
  const plan = analyze(jit, method, descriptor);
  if (!plan) return null;
  const { ASYNC_INVOKE, RETURN_VOID } = sentinels;
  const fieldSites = {
    spriteWidth: jit.registerFieldSite(plan.fields.spriteWidth),
    spriteHeight: jit.registerFieldSite(plan.fields.spriteHeight),
    spritePixels: jit.registerFieldSite(plan.fields.spritePixels),
    maskPixels: jit.registerFieldSite(plan.fields.maskPixels),
  };
  const fieldKeys = Object.fromEntries(Object.entries(fieldSites).map(
    ([name, site]) => [name, jit.fieldSites[site]?.directInstanceKey || null]));
  const locations = {
    clipOuterStart: bindStaticLocation(jit, plan.fields.clipOuterStart),
    clipOuterEnd: bindStaticLocation(jit, plan.fields.clipOuterEnd),
    clipInnerStart: bindStaticLocation(jit, plan.fields.clipInnerStart),
    clipInnerEnd: bindStaticLocation(jit, plan.fields.clipInnerEnd),
    surfaceStride: bindStaticLocation(jit, plan.fields.surfaceStride),
    destination: bindStaticLocation(jit, plan.fields.destination),
  };
  if (Object.values(fieldKeys).some((key) => !key) ||
      Object.values(locations).some((location) => !location)) return null;

  function fallback() {
    jit.affineSpriteRasterGuardedFallbackCount =
      (jit.affineSpriteRasterGuardedFallbackCount | 0) + 1;
    return ASYNC_INVOKE;
  }

  function ready() {
    if (jit._envInstrumented || jit.needsBytecodeChecks()) return false;
    for (const owner of plan.classOwners) {
      if (jit.jvm.classInitializationState.get(owner) !== "INITIALIZED" ||
          jit.jvm.debugManager.isClassJitDeopted(owner)) return false;
    }
    return true;
  }

  function run(sprite, maskObject,
    outerStart, outerEnd, leftStart, leftEnd, rightStart, rightEnd,
    dim, blend, sourceOffset, maskOverride) {
    if (!ready() || sprite === null || sprite === undefined) return fallback();
    let widthValue;
    let heightValue;
    let sourceRef;
    let maskRef = null;
    const spriteFields = sprite.fields;
    const maskFields = maskObject?.fields;
    if (!spriteFields ||
        (maskObject !== null && maskObject !== undefined && !maskFields)) {
      return fallback();
    }
    widthValue = spriteFields[fieldKeys.spriteWidth];
    heightValue = spriteFields[fieldKeys.spriteHeight];
    sourceRef = spriteFields[fieldKeys.spritePixels];
    if (maskObject !== null && maskObject !== undefined) {
      maskRef = maskFields[fieldKeys.maskPixels];
    }
    if (!Number.isInteger(widthValue) || !Number.isInteger(heightValue)) {
      return fallback();
    }
    const source = jit.arrayData(sourceRef);
    const mask = maskObject === null || maskObject === undefined
      ? null : jit.arrayData(maskRef);
    const destinationRef = readLocation(locations.destination);
    const destination = jit.arrayData(destinationRef);
    if (!source || !destination ||
        (maskObject !== null && maskObject !== undefined && !mask)) {
      return fallback();
    }
    const accepted = runRaster({
      width: widthValue | 0,
      height: heightValue | 0,
      source,
      mask,
      destination,
      clipOuterStart: readLocation(locations.clipOuterStart) | 0,
      clipOuterEnd: readLocation(locations.clipOuterEnd) | 0,
      clipInnerStart: readLocation(locations.clipInnerStart) | 0,
      clipInnerEnd: readLocation(locations.clipInnerEnd) | 0,
      surfaceStride: readLocation(locations.surfaceStride) | 0,
    }, [
      outerStart, outerEnd, leftStart, leftEnd, rightStart, rightEnd,
      dim, blend, sourceOffset, maskOverride,
    ]);
    if (!accepted) return fallback();
    jit.affineSpriteRasterRunCount = (jit.affineSpriteRasterRunCount | 0) + 1;
    return RETURN_VOID;
  }

  const intrinsic = (stack, base) => run(
    stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
    stack[base + 4], stack[base + 5], stack[base + 6], stack[base + 7],
    stack[base + 8], stack[base + 9], stack[base + 10], stack[base + 11],
  );
  intrinsic.jvmDirectKind = "affineSpriteRaster";
  intrinsic.jvmDirectData = { plan, run };
  intrinsic.jvmPositional = run;
  return intrinsic;
}

module.exports = {
  analyze,
  candidateDependencies,
  createIntrinsic,
  DESCRIPTOR,
  _test: {
    KNOWN_CALLER_FINGERPRINTS,
    KNOWN_HELPER_FINGERPRINTS,
    KNOWN_SUITE_FINGERPRINTS,
    roundedFloorDivide,
    runRaster,
  },
};
