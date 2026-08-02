"use strict";

// Historical oracle for the polygon edge-table rasterizer used by several
// Jagex-era software renderers.  Recognition is deliberately independent of
// class, method, and field names:
//
//   public wrapper -> private wrapper -> edge builder + scan iterator -> span
//
// Descriptors and repeated owner/member relationships discover the graph, and
// an identity-canonicalized bytecode fingerprint proves the complete graph
// before this file assigns any semantic role to a field.  The runtime entry
// then checks class/debug state and validates every array/layout assumption
// before changing a guest static or destination pixel.

const { allocPrimitiveArray } = require("../../src/instructions/object");
const { fingerprintMethods } = require("./FusedGradientOracle");

// These are compiler-layout variants of the same audited source algorithm.
// Names are canonicalized out of every value.  Keep a variant only after its
// complete method suite has been inspected/differentially exercised.
const KNOWN_FLAT_FINGERPRINTS = new Set([
  671062924,
  3007741160,
]);
const KNOWN_ALPHA_FINGERPRINTS = new Set([
  1529013579,
]);

function getOp(instruction) {
  return typeof instruction === "string" ? instruction : instruction && instruction.op;
}

function codeItems(jit, method) {
  return method ? jit.getCodeItems(method) : [];
}

function calls(jit, method) {
  return codeItems(jit, method)
    .map((item) => item && item.instruction)
    .filter((instruction) => getOp(instruction)?.startsWith("invoke") &&
      Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]));
}

function fields(jit, method, op = null) {
  return codeItems(jit, method)
    .map((item) => item && item.instruction)
    .filter((instruction) => {
      const actual = getOp(instruction);
      return (actual === "getstatic" || actual === "putstatic") &&
        (!op || actual === op) &&
        Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]);
    })
    .map((instruction) => instruction.arg);
}

function refKey(ref) {
  return JSON.stringify(ref);
}

function sameRef(left, right) {
  return refKey(left) === refKey(right);
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

function resolveMethod(jit, instruction) {
  const arg = instruction && instruction.arg;
  if (!Array.isArray(arg) || !Array.isArray(arg[2])) return null;
  const owner = arg[1];
  const classData = jit.jvm.classes[owner];
  if (!classData) return null;
  return jit.jvm.findMethod(classData, arg[2][0], arg[2][1]) || null;
}

function findCall(jit, method, descriptor, owner = null) {
  const found = calls(jit, method).filter((instruction) =>
    instruction.arg[2][1] === descriptor &&
    (owner === null || instruction.arg[1] === owner));
  return found.length === 1 ? found[0] : null;
}

function bindStaticLocation(jit, ref, forWrite) {
  const site = jit.registerFieldSite(ref);
  // Before <clinit>, a class' static Map may not contain its declared keys
  // yet.  Resolving the canonical writable slot is still side-effect free and
  // gives the same location; entry guards prevent reading it while cold.
  const direct = jit.registerDirectStaticTarget(site, forWrite) ||
    (!forWrite ? jit.registerDirectStaticTarget(site, true) : null);
  if (!direct) return null;
  return jit.directStaticTargets[direct.targetId] || null;
}

function readLocation(location) {
  return location.kind === "map"
    ? location.fields.get(location.key)
    : location.fields[location.key];
}

function writeLocation(location, value) {
  if (location.kind === "map") location.fields.set(location.key, value);
  else location.fields[location.key] = value;
  if (location.versionCell) {
    if (location.versionCell.captureCaches) {
      for (const cache of location.versionCell.captureCaches) {
        cache.dirty = true;
        cache.specializedMatches = false;
        for (const key of cache.derivedGuardKeys) cache[key] = undefined;
      }
    }
  }
}

function ownerOf(ref) {
  return Array.isArray(ref) ? ref[1] : null;
}

function descriptorOf(ref) {
  return Array.isArray(ref) && Array.isArray(ref[2]) ? ref[2][1] : null;
}

function quickSortEdges(scratch, start, end) {
  if (end <= start + 4) return;
  let pivotIndex = start;
  const pivot0 = scratch[pivotIndex] | 0;
  const pivot1 = scratch[pivotIndex + 1] | 0;
  const pivot2 = scratch[pivotIndex + 2] | 0;
  const pivot3 = scratch[pivotIndex + 3] | 0;
  for (let index = start + 4; index < end; index += 4) {
    const sortValue = scratch[index + 1] | 0;
    if (sortValue < pivot1) {
      scratch[pivotIndex] = scratch[index] | 0;
      scratch[pivotIndex + 1] = sortValue;
      scratch[pivotIndex + 2] = scratch[index + 2] | 0;
      scratch[pivotIndex + 3] = scratch[index + 3] | 0;
      pivotIndex += 4;
      scratch[index] = scratch[pivotIndex] | 0;
      scratch[index + 1] = scratch[pivotIndex + 1] | 0;
      scratch[index + 2] = scratch[pivotIndex + 2] | 0;
      scratch[index + 3] = scratch[pivotIndex + 3] | 0;
    }
  }
  scratch[pivotIndex] = pivot0;
  scratch[pivotIndex + 1] = pivot1;
  scratch[pivotIndex + 2] = pivot2;
  scratch[pivotIndex + 3] = pivot3;
  quickSortEdges(scratch, start, pivotIndex);
  quickSortEdges(scratch, pivotIndex + 4, end);
}

function sortActiveEdges(scratch, start, end) {
  while (end >= start + 8) {
    let sorted = 1;
    for (let index = start + 4; index < end; index += 4) {
      const leftX = scratch[index - 4] | 0;
      const rightX = scratch[index] | 0;
      if (leftX > rightX) {
        sorted = 0;
        scratch[index - 4] = rightX;
        scratch[index] = leftX;
        let swap = scratch[index - 2] | 0;
        scratch[index - 2] = scratch[index + 2] | 0;
        scratch[index + 2] = swap;
        swap = scratch[index - 1] | 0;
        scratch[index - 1] = scratch[index + 3] | 0;
        scratch[index + 3] = swap;
      }
    }
    if (sorted !== 0) return;
    end -= 4;
  }
}

function drawFlatSpan(pixelData, x, y, count, color,
  clipTop, clipBottom, clipLeft, clipRight, surfaceWidth) {
  if (y < clipTop || y >= clipBottom) return;
  if (x < clipLeft) {
    count = (count - (clipLeft - x)) | 0;
    x = clipLeft;
  }
  if (((x + count) | 0) > clipRight) count = (clipRight - x) | 0;
  if (count <= 0) return;
  let pixel = (x + Math.imul(y, surfaceWidth)) | 0;
  for (let end = pixel + count; pixel < end; pixel += 1) {
    pixelData[pixel] = color | 0;
  }
}

function drawAlphaSpan(pixelData, x, y, count, inverseAlpha,
  sourceRed, sourceGreen, sourceBlue,
  clipTop, clipBottom, clipLeft, clipRight, surfaceWidth) {
  if (y < clipTop || y >= clipBottom) return;
  if (x < clipLeft) {
    count = (count - (clipLeft - x)) | 0;
    x = clipLeft;
  }
  if (((x + count) | 0) > clipRight) count = (clipRight - x) | 0;
  if (count <= 0) return;
  let pixel = (x + Math.imul(y, surfaceWidth)) | 0;
  for (let end = pixel + count; pixel < end; pixel += 1) {
    const destination = pixelData[pixel] | 0;
    pixelData[pixel] = (
      ((((sourceRed + Math.imul((destination >> 16) & 255, inverseAlpha)) >> 8) << 16) +
       (((sourceGreen + Math.imul((destination >> 8) & 255, inverseAlpha)) >> 8) << 8) +
       ((sourceBlue + Math.imul(destination & 255, inverseAlpha)) >> 8)) | 0
    );
  }
}

function analyze(jit, wrapperMethod, descriptor) {
  const alpha = descriptor === "([III)V";
  if (!alpha && descriptor !== "([II)V") return null;

  const wrapperCalls = calls(jit, wrapperMethod);
  const innerDescriptor = alpha ? "([IIIII[I[I)V" : "([IIII)V";
  const wrapperCall = wrapperCalls.length === 1 &&
    wrapperCalls[0].arg[2][1] === innerDescriptor
    ? wrapperCalls[0] : null;
  if (!wrapperCall || getOp(wrapperCall) !== "invokestatic") return null;
  const owner = wrapperCall.arg[1];
  const innerMethod = resolveMethod(jit, wrapperCall);
  if (!innerMethod || !(innerMethod.flags || []).includes("static")) return null;

  const resetCall = findCall(jit, innerMethod, "()V", owner);
  const buildCall = findCall(jit, innerMethod, "([III)V", owner);
  const scanDescriptor = alpha ? "(II[I[I)V" : "(I)V";
  const scanCall = findCall(jit, innerMethod, scanDescriptor, owner);
  if (!resetCall || !buildCall || !scanCall) return null;
  const resetMethod = resolveMethod(jit, resetCall);
  const buildMethod = resolveMethod(jit, buildCall);
  const scanMethod = resolveMethod(jit, scanCall);
  if (!resetMethod || !buildMethod || !scanMethod) return null;

  const prepareCall = findCall(jit, scanMethod, "()V", owner);
  const iteratorCall = findCall(jit, scanMethod, "()Z", owner);
  const spanDescriptor = alpha ? "(IIIII)V" : "(IIII)V";
  const spanCalls = calls(jit, scanMethod).filter((instruction) =>
    instruction.arg[2][1] === spanDescriptor && instruction.arg[1] !== owner);
  if (!prepareCall || !iteratorCall || spanCalls.length !== 1) return null;
  const prepareMethod = resolveMethod(jit, prepareCall);
  const iteratorMethod = resolveMethod(jit, iteratorCall);
  const spanMethod = resolveMethod(jit, spanCalls[0]);
  if (!prepareMethod || !iteratorMethod || !spanMethod) return null;

  const quickCall = findCall(jit, prepareMethod, "(II)V", owner);
  const bubbleCall = findCall(jit, iteratorMethod, "(II)V", owner);
  if (!quickCall || !bubbleCall) return null;
  const quickMethod = resolveMethod(jit, quickCall);
  const bubbleMethod = resolveMethod(jit, bubbleCall);
  if (!quickMethod || !bubbleMethod || quickMethod === bubbleMethod) return null;

  // The recursive sorter calls itself twice; the active-edge sorter has no
  // calls.  These relational checks reject descriptor collisions before the
  // stronger complete-suite fingerprint is considered.
  const quickCalls = calls(jit, quickMethod);
  if (quickCalls.length !== 2 ||
      quickCalls.some((instruction) =>
        instruction.arg[1] !== owner ||
        instruction.arg[2][1] !== "(II)V" ||
        resolveMethod(jit, instruction) !== quickMethod) ||
      calls(jit, bubbleMethod).length !== 0 ||
      calls(jit, buildMethod).length !== 0) return null;

  const suite = [
    wrapperMethod, innerMethod, resetMethod, buildMethod, scanMethod,
    prepareMethod, iteratorMethod, bubbleMethod, quickMethod, spanMethod,
  ];
  const fingerprint = fingerprintMethods(jit, suite);
  if (typeof process !== "undefined" && process.env &&
      process.env.JVM_PRINT_POLYGON_FINGERPRINT === "1") {
    console.error(`polygon ${alpha ? "alpha" : "flat"} fingerprint: ${fingerprint}`);
  }
  const known = alpha ? KNOWN_ALPHA_FINGERPRINTS : KNOWN_FLAT_FINGERPRINTS;
  if (!known.has(fingerprint)) return null;

  const resetWrites = fields(jit, resetMethod, "putstatic")
    .filter((ref) => ownerOf(ref) === owner && descriptorOf(ref) === "I");
  if (resetWrites.length !== 1) return null;
  const countField = resetWrites[0];

  const buildFields = fields(jit, buildMethod)
    .filter((ref) => ownerOf(ref) === owner);
  const scratchFields = uniqueRefs(buildFields.filter((ref) =>
    descriptorOf(ref) === "[I"));
  const buildIntegers = uniqueRefs(buildFields.filter((ref) =>
    descriptorOf(ref) === "I"));
  if (scratchFields.length !== 1 || buildIntegers.length !== 1 ||
      !sameRef(buildIntegers[0], countField)) return null;
  const scratchField = scratchFields[0];

  const scanOutputFields = fields(jit, scanMethod, "getstatic")
    .filter((ref) => ownerOf(ref) === owner && descriptorOf(ref) === "I");
  if (scanOutputFields.length !== 3 ||
      uniqueRefs(scanOutputFields).length !== 3) return null;
  const [leftField, rightField, yField] = scanOutputFields;

  const iteratorIntegerReads = fields(jit, iteratorMethod, "getstatic")
    .filter((ref) => ownerOf(ref) === owner && descriptorOf(ref) === "I");
  if (iteratorIntegerReads.length < 4) return null;
  const [activeEndField, pairCursorField, iteratorYField] = iteratorIntegerReads;
  if (!sameRef(iteratorYField, yField)) return null;

  const reserved = new Set([
    countField, leftField, rightField, yField,
    activeEndField, pairCursorField,
  ].map(refKey));
  const remaining = uniqueRefs(iteratorIntegerReads)
    .filter((ref) => !reserved.has(refKey(ref)));
  if (remaining.length !== 1) return null;
  const expiredStartField = remaining[0];

  const spanIntrinsic = jit.getSynchronousIntrinsic(spanMethod, spanDescriptor);
  const expectedSpanKind = alpha ? "clippedStaticAlphaSpan" : "clippedStaticSpan";
  if (spanIntrinsic?.jvmDirectKind !== expectedSpanKind ||
      !Array.isArray(spanIntrinsic.jvmDirectData?.staticFields) ||
      spanIntrinsic.jvmDirectData.staticFields.length !== 6) return null;

  const writableRefs = [
    countField, scratchField, leftField, rightField, yField,
    activeEndField, pairCursorField, expiredStartField,
  ];
  const locations = writableRefs.map((ref) => bindStaticLocation(jit, ref, true));
  const spanLocations = spanIntrinsic.jvmDirectData.staticFields
    .map((ref) => bindStaticLocation(jit, ref, false));
  if (locations.some((location) => !location) ||
      spanLocations.some((location) => !location)) return null;

  const classOwners = new Set([
    owner,
    spanCalls[0].arg[1],
    ...writableRefs.map(ownerOf),
    ...spanIntrinsic.jvmDirectData.staticFields.map(ownerOf),
  ]);

  return {
    alpha,
    fingerprint,
    owner,
    spanOwner: spanCalls[0].arg[1],
    methods: suite,
    classOwners: [...classOwners],
    locations: {
      count: locations[0],
      scratch: locations[1],
      left: locations[2],
      right: locations[3],
      y: locations[4],
      activeEnd: locations[5],
      pairCursor: locations[6],
      expiredStart: locations[7],
      clipTop: spanLocations[0],
      clipBottom: spanLocations[1],
      clipLeft: spanLocations[2],
      clipRight: spanLocations[3],
      surfaceWidth: spanLocations[4],
      pixels: spanLocations[5],
    },
  };
}

// Cheap relational probe used only to defer a cold decision.  It does not
// install or execute an optimization.  Once the referenced span owner loads,
// the complete analyze() proof above runs exactly once and either succeeds or
// permanently rejects the target.
function candidateDependencies(jit, wrapperMethod, descriptor) {
  const alpha = descriptor === "([III)V";
  if (!alpha && descriptor !== "([II)V") return null;
  const wrapperCalls = calls(jit, wrapperMethod);
  const innerDescriptor = alpha ? "([IIIII[I[I)V" : "([IIII)V";
  if (wrapperCalls.length !== 1 ||
      getOp(wrapperCalls[0]) !== "invokestatic" ||
      wrapperCalls[0].arg[2][1] !== innerDescriptor) return null;
  const owner = wrapperCalls[0].arg[1];
  const innerMethod = resolveMethod(jit, wrapperCalls[0]);
  if (!innerMethod) return null;
  const scanDescriptor = alpha ? "(II[I[I)V" : "(I)V";
  const scanCall = findCall(jit, innerMethod, scanDescriptor, owner);
  const scanMethod = resolveMethod(jit, scanCall);
  if (!scanMethod) return null;
  const spanDescriptor = alpha ? "(IIIII)V" : "(IIII)V";
  const spanCalls = calls(jit, scanMethod).filter((instruction) =>
    instruction.arg[2][1] === spanDescriptor && instruction.arg[1] !== owner);
  return spanCalls.length === 1 ? [spanCalls[0].arg[1]] : null;
}

function createIntrinsicForPlan(jit, plan, sentinels) {
  const { ASYNC_INVOKE, RETURN_VOID } = sentinels;
  const locations = plan.locations;

  function guardedFallback(reason) {
    jit.polygonRasterGuardedFallbackCount =
      (jit.polygonRasterGuardedFallbackCount | 0) + 1;
    const key = `polygonRasterFallback${reason}`;
    jit[key] = (jit[key] | 0) + 1;
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

  function run(vertices, color, alpha) {
    // Nothing below this preflight can throw for an accepted input.  A reject
    // delegates to the canonical generated/interpreted wrapper before reset()
    // changes the shared edge-table state.
    if (!ready() || vertices === null || vertices === undefined) {
      return guardedFallback("Entry");
    }
    const vertexData = jit.arrayData(vertices);
    const vertexLength = Number(vertices.length);
    if (!vertexData || !Number.isInteger(vertexLength) ||
        vertexLength < 4 || vertexLength > 16384 || (vertexLength & 1) !== 0 ||
        vertexData.length < vertexLength) {
      return guardedFallback("Vertices");
    }
    let hasEdge = false;
    for (let index = 0; index < vertexLength; index += 1) {
      const coordinate = vertexData[index];
      if (!Number.isInteger(coordinate) || (coordinate | 0) !== coordinate) {
        return guardedFallback("Coordinate");
      }
      if ((index & 1) !== 0) {
        const previous = index === 1 ? vertexLength - 1 : index - 2;
        if ((vertexData[previous] | 0) !== (coordinate | 0)) hasEdge = true;
      }
    }
    if (!hasEdge) {
      return guardedFallback("Degenerate");
    }

    const clipTop = readLocation(locations.clipTop) | 0;
    const clipBottom = readLocation(locations.clipBottom) | 0;
    const clipLeft = readLocation(locations.clipLeft) | 0;
    const clipRight = readLocation(locations.clipRight) | 0;
    const surfaceWidth = readLocation(locations.surfaceWidth) | 0;
    const pixels = readLocation(locations.pixels);
    const pixelData = jit.arrayData(pixels);
    const pixelLength = pixels?.length ?? pixelData?.length ?? 0;
    // When bottom <= top, prepare() clamps the first candidate row to top and
    // iterator() immediately returns false.  No span is invoked, so unusual
    // negative/off-screen clip state and even a missing surface are harmless;
    // the edge-table/cursor mutations still need to run exactly.
    const verticallyEmpty = clipBottom <= clipTop;
    if (!verticallyEmpty &&
        (!pixelData || !Number.isInteger(pixelLength) ||
         surfaceWidth <= 0 || clipTop < 0 ||
         clipLeft < 0 || clipRight < clipLeft || clipRight > surfaceWidth ||
         clipBottom * surfaceWidth > pixelLength)) {
      if (!jit.polygonRasterFallbackSurfaceSample) {
        jit.polygonRasterFallbackSurfaceSample = {
          hasPixelData: Boolean(pixelData),
          pixelLength,
          surfaceWidth,
          clipTop,
          clipBottom,
          clipLeft,
          clipRight,
        };
      }
      return guardedFallback("Surface");
    }

    let scratch = readLocation(locations.scratch);
    let scratchData = jit.arrayData(scratch);
    const required = vertexLength << 1;
    if (scratch !== null && scratch !== undefined &&
        (!scratchData || !Number.isInteger(scratch.length))) {
      return guardedFallback("Scratch");
    }
    if (!scratch || scratch.length < required) {
      scratch = allocPrimitiveArray(jit.jvm, "int", required);
      scratchData = jit.arrayData(scratch);
    }

    let edgeCount = 0;
    let previous = vertexLength - 2;
    for (let current = 0; current < vertexLength; current += 2) {
      const previousY = vertexData[previous + 1] | 0;
      const currentY = vertexData[current + 1] | 0;
      if (previousY < currentY) {
        scratchData[edgeCount++] = vertexData[previous] | 0;
        scratchData[edgeCount++] = previousY;
        scratchData[edgeCount++] = vertexData[current] | 0;
        scratchData[edgeCount++] = currentY;
      } else if (currentY < previousY) {
        scratchData[edgeCount++] = vertexData[current] | 0;
        scratchData[edgeCount++] = currentY;
        scratchData[edgeCount++] = vertexData[previous] | 0;
        scratchData[edgeCount++] = previousY;
      }
      previous = current;
    }

    // hasEdge proves edgeCount >= 4 and every division below has a non-zero
    // vertical denominator.
    quickSortEdges(scratchData, 0, edgeCount);
    let y = scratchData[1] | 0;
    if (y < clipTop) y = clipTop;
    let activeEnd = 0;
    while (activeEnd < edgeCount) {
      const edgeY = scratchData[activeEnd + 1] | 0;
      if (y < edgeY) break;
      const x0 = scratchData[activeEnd] | 0;
      const x1 = scratchData[activeEnd + 2] | 0;
      const y1 = scratchData[activeEnd + 3] | 0;
      const step = ((((x1 - x0) | 0) << 16) / ((y1 - edgeY) | 0)) | 0;
      const fixed = ((x0 << 16) + 32768) | 0;
      scratchData[activeEnd] =
        (fixed + Math.imul((y - edgeY) | 0, step)) | 0;
      scratchData[activeEnd + 2] = step;
      activeEnd += 4;
    }
    let expiredStart = 0;
    let pairCursor = activeEnd;
    let storedActiveEnd = activeEnd;
    let storedExpiredStart = expiredStart;
    let storedPairCursor = pairCursor;
    y = (y - 1) | 0;
    let outputLeft = readLocation(locations.left) | 0;
    let outputRight = readLocation(locations.right) | 0;

    const inverseAlpha = (256 - (alpha | 0)) | 0;
    const sourceRed = Math.imul(((color | 0) >> 16) & 255, alpha | 0);
    const sourceGreen = Math.imul(((color | 0) >> 8) & 255, alpha | 0);
    const sourceBlue = Math.imul((color | 0) & 255, alpha | 0);

    while (true) {
      if (pairCursor < activeEnd) {
        outputLeft = scratchData[pairCursor] >> 16;
        outputRight = scratchData[pairCursor + 4] >> 16;
        scratchData[pairCursor] =
          ((scratchData[pairCursor] | 0) + (scratchData[pairCursor + 2] | 0)) | 0;
        scratchData[pairCursor + 4] =
          ((scratchData[pairCursor + 4] | 0) +
           (scratchData[pairCursor + 6] | 0)) | 0;
        pairCursor += 8;
        storedPairCursor = pairCursor;
        const count = (outputRight - outputLeft) | 0;
        if (plan.alpha) {
          drawAlphaSpan(pixelData, outputLeft, y, count,
            inverseAlpha, sourceRed, sourceGreen, sourceBlue,
            clipTop, clipBottom, clipLeft, clipRight, surfaceWidth);
        } else {
          drawFlatSpan(pixelData, outputLeft, y, count, color,
            clipTop, clipBottom, clipLeft, clipRight, surfaceWidth);
        }
        continue;
      }

      y = (y + 1) | 0;
      if (y >= clipBottom) break;
      let newExpiredStart = expiredStart;
      while (activeEnd < edgeCount) {
        const edgeY = scratchData[activeEnd + 1] | 0;
        if (y < edgeY) break;
        const x0 = scratchData[activeEnd] | 0;
        const x1 = scratchData[activeEnd + 2] | 0;
        const y1 = scratchData[activeEnd + 3] | 0;
        const step = ((((x1 - x0) | 0) << 16) / ((y1 - edgeY) | 0)) | 0;
        scratchData[activeEnd] = ((x0 << 16) + 32768) | 0;
        scratchData[activeEnd + 2] = step;
        activeEnd += 4;
      }

      for (let index = newExpiredStart; index < activeEnd; index += 4) {
        const endY = scratchData[index + 3] | 0;
        if (y >= endY) {
          scratchData[index] = scratchData[newExpiredStart] | 0;
          scratchData[index + 1] = scratchData[newExpiredStart + 1] | 0;
          scratchData[index + 2] = scratchData[newExpiredStart + 2] | 0;
          scratchData[index + 3] = scratchData[newExpiredStart + 3] | 0;
          newExpiredStart += 4;
        }
      }
      if (newExpiredStart === edgeCount) {
        edgeCount = 0;
        break;
      }
      expiredStart = newExpiredStart;
      sortActiveEdges(scratchData, expiredStart, activeEnd);
      storedExpiredStart = expiredStart;
      storedActiveEnd = activeEnd;
      pairCursor = expiredStart;
    }

    writeLocation(locations.count, edgeCount);
    writeLocation(locations.scratch, scratch);
    writeLocation(locations.left, outputLeft);
    writeLocation(locations.right, outputRight);
    writeLocation(locations.y, y);
    writeLocation(locations.activeEnd, storedActiveEnd);
    writeLocation(locations.pairCursor, storedPairCursor);
    writeLocation(locations.expiredStart, storedExpiredStart);
    jit.polygonRasterRunCount = (jit.polygonRasterRunCount | 0) + 1;
    return RETURN_VOID;
  }

  const intrinsic = plan.alpha
    ? (stack, base) => run(stack[base], stack[base + 1], stack[base + 2])
    : (stack, base) => run(stack[base], stack[base + 1], 0);
  intrinsic.jvmDirectKind = plan.alpha ? "polygonAlphaRaster" : "polygonFlatRaster";
  intrinsic.jvmDirectData = { plan, run };
  intrinsic.jvmPositional = plan.alpha
    ? (vertices, color, alpha) => run(vertices, color, alpha)
    : (vertices, color) => run(vertices, color, 0);
  return intrinsic;
}

function createIntrinsic(jit, wrapperMethod, descriptor, sentinels) {
  const plan = analyze(jit, wrapperMethod, descriptor);
  return plan ? createIntrinsicForPlan(jit, plan, sentinels) : null;
}

module.exports = {
  analyze,
  candidateDependencies,
  createIntrinsic,
  _test: {
    KNOWN_FLAT_FINGERPRINTS,
    KNOWN_ALPHA_FINGERPRINTS,
    createIntrinsicForPlan,
  },
};
