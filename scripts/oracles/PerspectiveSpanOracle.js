"use strict";

// Historical oracle for the classic eight-pixel perspective-textured scanline.
// Installation is gated by a complete, identity-canonicalized bytecode
// fingerprint plus descriptor, field-relationship, handler, and static-field
// checks. Guest owner/member names are never used for selection.

const { fingerprintMethods } = require("./FusedGradientOracle");

const DESCRIPTOR = "([I[IIIIIIIIIIIIII)V";
const KNOWN_FINGERPRINTS = new Set([
  2145417239,
]);

function getOp(instruction) {
  return typeof instruction === "string"
    ? instruction : instruction && instruction.op;
}

function fieldKey(field) {
  return Array.isArray(field) && Array.isArray(field[2])
    ? `${field[1]}\0${field[2][0]}\0${field[2][1]}` : null;
}

function sameField(left, right) {
  const leftKey = fieldKey(left);
  return leftKey !== null && leftKey === fieldKey(right);
}

function readTarget(target) {
  return target.kind === "map"
    ? target.fields.get(target.key) : target.fields[target.key];
}

function shadePixel(color, brightness) {
  const redBlue =
    Math.imul(color & 0x00ff00ff, brightness) & 0xff00ff00;
  const green =
    Math.imul(color & 0x0000ff00, brightness) & 0x00ff0000;
  return ((redBlue + green) >> 8) | 0;
}

function truncatingDivide(dividend, divisor) {
  return divisor === 0 ? 0 : (dividend / divisor) | 0;
}

function runKernel(destinationData, textureData, destinationIndex,
  startX, endX, shade, shadeStep, uNumerator, vNumerator, wNumerator,
  uStep, vStep, wStep, clipEnabled, clipRight, centerX,
  lowDetail, opaque) {
  destinationIndex |= 0;
  startX |= 0;
  endX |= 0;
  shade |= 0;
  shadeStep |= 0;
  uNumerator |= 0;
  vNumerator |= 0;
  wNumerator |= 0;
  uStep |= 0;
  vStep |= 0;
  wStep |= 0;
  clipRight |= 0;
  centerX |= 0;

  if (clipEnabled) {
    if (endX > clipRight) endX = clipRight;
    if (startX < 0) startX = 0;
  }
  if (startX >= endX) return;

  destinationIndex = (destinationIndex + startX) | 0;
  shade = (shade + Math.imul(shadeStep, startX)) | 0;
  let remaining = (endX - startX) | 0;
  const relativeX = (startX - centerX) | 0;
  uNumerator =
    (uNumerator + Math.imul(uStep >> 3, relativeX)) | 0;
  vNumerator =
    (vNumerator + Math.imul(vStep >> 3, relativeX)) | 0;
  wNumerator =
    (wNumerator + Math.imul(wStep >> 3, relativeX)) | 0;

  const denominatorShift = lowDetail ? 12 : 14;
  const coordinateShift = lowDetail ? 20 : 18;
  const textureMask = lowDetail ? 4032 : 16256;
  const textureColumnShift = lowDetail ? 26 : 25;

  let denominator = wNumerator >> denominatorShift;
  let u0 = truncatingDivide(uNumerator, denominator);
  let v0 = truncatingDivide(vNumerator, denominator);
  uNumerator = (uNumerator + uStep) | 0;
  vNumerator = (vNumerator + vStep) | 0;
  wNumerator = (wNumerator + wStep) | 0;
  denominator = wNumerator >> denominatorShift;
  let u1 = truncatingDivide(uNumerator, denominator);
  let v1 = truncatingDivide(vNumerator, denominator);
  let coordinate = ((u0 << coordinateShift) + v0) | 0;
  let coordinateStep = (((((u1 - u0) | 0) >> 3) << coordinateShift) +
    (((v1 - v0) | 0) >> 3)) | 0;
  let blockCount = remaining >> 3;
  shadeStep = (shadeStep << 3) | 0;
  let brightness = shade >> 8;

  while (blockCount > 0) {
    for (let pixel = 0; pixel < 8; pixel += 1) {
      const textureIndex =
        ((coordinate & textureMask) + (coordinate >>> textureColumnShift)) | 0;
      const color = textureData[textureIndex] | 0;
      if (opaque || color !== 0) {
        destinationData[destinationIndex] = shadePixel(color, brightness);
      }
      destinationIndex = (destinationIndex + 1) | 0;
      coordinate = (coordinate + coordinateStep) | 0;
    }

    u0 = u1;
    v0 = v1;
    uNumerator = (uNumerator + uStep) | 0;
    vNumerator = (vNumerator + vStep) | 0;
    wNumerator = (wNumerator + wStep) | 0;
    denominator = wNumerator >> denominatorShift;
    u1 = truncatingDivide(uNumerator, denominator);
    v1 = truncatingDivide(vNumerator, denominator);
    coordinate = ((u0 << coordinateShift) + v0) | 0;
    coordinateStep = (((((u1 - u0) | 0) >> 3) << coordinateShift) +
      (((v1 - v0) | 0) >> 3)) | 0;
    shade = (shade + shadeStep) | 0;
    brightness = shade >> 8;
    blockCount = (blockCount - 1) | 0;
  }

  remaining &= 7;
  while (remaining > 0) {
    const textureIndex =
      ((coordinate & textureMask) + (coordinate >>> textureColumnShift)) | 0;
    const color = textureData[textureIndex] | 0;
    if (opaque || color !== 0) {
      destinationData[destinationIndex] = shadePixel(color, brightness);
    }
    destinationIndex = (destinationIndex + 1) | 0;
    coordinate = (coordinate + coordinateStep) | 0;
    remaining = (remaining - 1) | 0;
  }
}

function createRun(jit, targets, owners, methodOwner, sentinels) {
  const { ASYNC_INVOKE, RETURN_VOID } = sentinels;
  const fallback = () => {
    jit.perspectiveSpanGuardedFallbackCount =
      (jit.perspectiveSpanGuardedFallbackCount | 0) + 1;
    return ASYNC_INVOKE;
  };

  return function run(destination, texture, unusedCoordinate, unusedColor,
    destinationIndex, startX, endX, shade, shadeStep,
    uNumerator, vNumerator, wNumerator, uStep, vStep, wStep) {
    if (jit._envInstrumented || jit.needsBytecodeChecks() ||
        owners.some((owner) =>
          jit.jvm.classInitializationState.get(owner) !== "INITIALIZED" ||
          jit.jvm.debugManager.isClassJitDeopted(owner)) ||
        jit.jvm.classInitializationState.get(methodOwner) !== "INITIALIZED" ||
        jit.jvm.debugManager.isClassJitDeopted(methodOwner)) {
      return fallback();
    }

    destinationIndex |= 0;
    startX |= 0;
    endX |= 0;
    shade |= 0;
    shadeStep |= 0;
    uNumerator |= 0;
    vNumerator |= 0;
    wNumerator |= 0;
    uStep |= 0;
    vStep |= 0;
    wStep |= 0;
    const clipEnabled = Boolean(readTarget(targets[0]));
    const clipRight = readTarget(targets[1]) | 0;
    const lowDetail = Boolean(readTarget(targets[2]));
    const centerX = readTarget(targets[3]) | 0;
    const opaque = Boolean(readTarget(targets[4]));

    let clippedStart = startX;
    let clippedEnd = endX;
    if (clipEnabled) {
      if (clippedEnd > clipRight) clippedEnd = clipRight;
      if (clippedStart < 0) clippedStart = 0;
    }
    if (clippedStart >= clippedEnd) {
      jit.perspectiveSpanRunCount =
        (jit.perspectiveSpanRunCount | 0) + 1;
      return RETURN_VOID;
    }
    const destinationData = jit.arrayData(destination);
    const textureData = jit.arrayData(texture);
    const destinationLength =
      destination?.length ?? destinationData?.length;
    const textureLength = texture?.length ?? textureData?.length;
    const firstDestination = (destinationIndex + clippedStart) | 0;
    const pixelCount = (clippedEnd - clippedStart) | 0;
    const requiredTextureLength = lowDetail ? 4096 : 16384;
    if (!destinationData || !textureData ||
        !Number.isInteger(destinationLength) ||
        !Number.isInteger(textureLength) ||
        firstDestination < 0 || pixelCount < 0 ||
        pixelCount > destinationLength - firstDestination ||
        textureLength < requiredTextureLength) {
      return fallback();
    }

    runKernel(destinationData, textureData, destinationIndex,
      startX, endX, shade, shadeStep, uNumerator, vNumerator, wNumerator,
      uStep, vStep, wStep, clipEnabled, clipRight, centerX,
      lowDetail, opaque);
    jit.perspectiveSpanRunCount =
      (jit.perspectiveSpanRunCount | 0) + 1;
    return RETURN_VOID;
  };
}

function createIntrinsic(jit, method, descriptor, sentinels) {
  if (descriptor !== DESCRIPTOR || !(method.flags || []).includes("static")) {
    return null;
  }
  const code = method.attributes.find(
    (attribute) => attribute.type === "code")?.code;
  if (!code || (code.exceptionTable || []).length !== 0) return null;
  const fingerprint = fingerprintMethods(jit, [method]);
  if (typeof process !== "undefined" && process.env &&
      process.env.JVM_PRINT_PERSPECTIVE_SPAN_FINGERPRINT === "1") {
    console.error(`perspective span fingerprint: ${fingerprint}`);
  }
  if (!KNOWN_FINGERPRINTS.has(fingerprint)) return null;

  const staticReads = jit.getCodeItems(method)
    .map((item) => item && item.instruction)
    .filter((instruction) => getOp(instruction) === "getstatic" &&
      Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]))
    .map((instruction) => instruction.arg);
  if (staticReads.length !== 8 ||
      staticReads.map((field) => field[2][1]).join("") !== "ZIIZIZIZ" ||
      !sameField(staticReads[1], staticReads[2]) ||
      !sameField(staticReads[4], staticReads[6]) ||
      !sameField(staticReads[5], staticReads[7]) ||
      sameField(staticReads[0], staticReads[3]) ||
      sameField(staticReads[0], staticReads[5]) ||
      sameField(staticReads[3], staticReads[5]) ||
      sameField(staticReads[1], staticReads[4])) {
    return null;
  }

  const selectedFields = [
    staticReads[0], // horizontal clipping enabled
    staticReads[1], // horizontal clip limit
    staticReads[3], // texture detail/layout mode
    staticReads[4], // horizontal perspective origin
    staticReads[5], // opaque texture mode
  ];
  const owners = [...new Set(selectedFields.map((field) => field[1]))];
  for (const field of selectedFields) {
    const ownerClass = jit.jvm.classes[field[1]];
    const declaration = ownerClass?.ast?.classes?.[0]?.items?.find((item) =>
      item?.type === "field" &&
      item.field?.name === field[2][0] &&
      item.field?.descriptor === field[2][1]);
    if (!declaration || (declaration.field.flags || []).includes("volatile")) {
      return null;
    }
  }
  const targets = selectedFields.map((field) => {
    const site = jit.registerFieldSite(field);
    const direct = jit.registerDirectStaticTarget(site);
    return direct ? jit.directStaticTargets[direct.targetId] : null;
  });
  if (targets.some((target) => !target)) return null;

  const methodOwner = jit.jvm.findClassNameForMethod?.(method) ||
    selectedFields[0][1];
  if (!methodOwner) return null;
  const run = createRun(jit, targets, owners, methodOwner, sentinels);

  const intrinsic = (stack, base) => run(
    stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
    stack[base + 4], stack[base + 5], stack[base + 6], stack[base + 7],
    stack[base + 8], stack[base + 9], stack[base + 10], stack[base + 11],
    stack[base + 12], stack[base + 13], stack[base + 14]);
  intrinsic.jvmDirectKind = "perspectiveTexturedSpan";
  intrinsic.jvmPositional = run;
  intrinsic.jvmDirectData = { fingerprint, methodOwner, owners };
  return intrinsic;
}

module.exports = {
  DESCRIPTOR,
  createIntrinsic,
  _test: {
    KNOWN_FINGERPRINTS,
    createRun,
    runKernel,
    shadePixel,
  },
};
