"use strict";
// Handwritten structured replacement for the fused gradient triangle region
// (wf.a wrapper -> oj.a raster -> inlined scanline). Derived from and validated
// bit-exact against the generated fused kernels on captured scene workloads
// (2140-triangle vk scene, FNV hash equality), then measured at 9.9x the
// generated kernel in SpiderMonkey (79ms -> 8ms per 20 scene passes).
//
// Safety model:
// - Installation is gated on an exact bytecode fingerprint of the wrapper,
//   raster, and scanline methods: these obfuscated classes are shared across
//   game builds with per-build argument reordering, and this translation
//   encodes one specific build's permutations and shift constants.
// - Every call runs a layout pre-flight (linear row-offset table, destination
//   bounds). Anything non-standard delegates to the generated kernel before
//   any side effect, preserving exact semantics including exception behavior.
// - The region guard already ensures the obfuscator diagnostic flag
//   (staticTargets[0], client.field_A) is false, which kills every diagnostic
//   path; with the pre-flight passed, no remaining path in the handwritten
//   raster can throw.

const FNV_OFFSET = 2166136261;

function mixString(hash, value) {
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
  }
  return hash;
}

function getOp(instruction) {
  return typeof instruction === "string" ? instruction : instruction && instruction.op;
}

function fingerprintMethods(jit, methods) {
  let hash = FNV_OFFSET;
  for (const method of methods) {
    for (const item of jit.getCodeItems(method)) {
      const instruction = item && item.instruction;
      const op = getOp(instruction);
      if (!op) continue;
      hash = mixString(hash, op);
      if (instruction && typeof instruction === "object" && "arg" in instruction) {
        hash = mixString(hash, JSON.stringify(instruction.arg) ?? "");
      }
    }
  }
  return hash >>> 0;
}

// dekobloko (original jar): wf.a(IIIIIIIIIIIIZIII)V + oj.a(IIIIIIIBIIII[IIIII)V
// + ve.a(IIIIIII[III)V — value printed via JVM_PRINT_FUSED_FINGERPRINT=1
const KNOWN_FINGERPRINTS = new Set([4128814000]);

module.exports = { fingerprintMethods, matches, install };

function matches(jit, region) {
  const fingerprint = fingerprintMethods(jit, [
    region.wrapperMethod, region.rasterMethod, region.scanlineMethod,
  ]);
  if (typeof process !== "undefined" && process.env &&
      process.env.JVM_PRINT_FUSED_FINGERPRINT === "1") {
    console.error(`fused ${region.family.name} fingerprint: ${fingerprint}`);
  }
  return KNOWN_FINGERPRINTS.has(fingerprint);
}

function install(region, jit) {
  const targets = region.staticTargets;
  const generatedWrapper = region.wrapperKernel;
  const readStatic = (i) => targets[i].kind === "map"
    ? targets[i].fields.get(targets[i].key) : targets[i].fields[targets[i].key];
  const writeStatic = (i, value) => {
    if (targets[i].kind === "map") targets[i].fields.set(targets[i].key, value);
    else targets[i].fields[targets[i].key] = value;
  };

  function scan(dest, index, count, green, greenStep, red, redStep, blue, blueStep) {
    index = index | 0; count = count | 0;
    green = green | 0; red = red | 0; blue = blue | 0;
    for (let k = 0; k < count; k += 1) {
      dest[index] = ((dest[index] >> 1 & 8355711) +
        (green >> 9 & 65280) + (red >> 1 & 16711680) + (blue >> 17 & 255)) | 0;
      index += 1;
      green = (green + greenStep) | 0;
      red = (red + redStep) | 0;
      blue = (blue + blueStep) | 0;
    }
  }

  // a3=yMid a11=yTop a14=yBot; a10/a4/a5 xTop/xMid/xBot; a2/a6/a9 green
  // top/mid/bot; a15/a8/a0 red; a16/a1/a13 blue; a12 dest.
  function raster(fieldE, fieldA, fieldD, stride, a0, a1, a2, a3, a4, a5, a6,
    a8, a9, a10, a11, a12, a13, a14, a15, a16) {
    const dest = a12;
    if (a14 < 0) return;
    if (a11 >= fieldE) return;
    if (!(a10 >= 0 || a4 >= 0 || a5 >= 0)) return;
    if (!(fieldA > a10 || fieldA > a4 || fieldA > a5)) return;

    let l11 = a11 | 0;
    const l34 = (a14 - l11) | 0;
    let l17 = 0, l18 = 0, l19 = 0, l20 = 0, l21 = 0, l22 = 0, l23 = 0, l24 = 0;
    let l25 = 0, l26 = 0, l27 = 0, l28 = 0, l29 = 0, l30 = 0, l31 = 0, l32 = 0;
    let l33 = 0;

    if (l11 === a3) {
      if (l11 !== a14) {
        const l35 = (a14 - a3) | 0;
        if (a4 > a10) {
          l24 = (((a0 - a8 | 0) << 16) / l35) | 0;
          l25 = a2 << 16; l18 = a4 << 16; l22 = a8 << 16;
          l31 = (((a13 - a16 | 0) << 16) / l34) | 0;
          l27 = (((a9 - a2 | 0) << 16) / l34) | 0;
          l17 = a10 << 16;
          l28 = (((a9 - a6 | 0) << 16) / l35) | 0;
          l23 = (((a0 - a15 | 0) << 16) / l34) | 0;
          l19 = (((a5 - a10 | 0) << 16) / l34) | 0;
          l26 = a6 << 16;
          l20 = (((a5 - a4 | 0) << 16) / l35) | 0;
          l21 = a15 << 16; l30 = a1 << 16;
          l32 = (((a13 - a1 | 0) << 16) / l35) | 0;
          l29 = a16 << 16;
        } else {
          l28 = (((a9 - a2 | 0) << 16) / l34) | 0;
          l27 = (((a9 - a6 | 0) << 16) / l35) | 0;
          l31 = (((a13 - a1 | 0) << 16) / l35) | 0;
          l21 = a8 << 16; l29 = a1 << 16; l22 = a15 << 16;
          l24 = (((a0 - a15 | 0) << 16) / l34) | 0;
          l20 = (((a5 - a10 | 0) << 16) / l34) | 0;
          l23 = (((a0 - a8 | 0) << 16) / l35) | 0;
          l26 = a2 << 16;
          l32 = (((a13 - a16 | 0) << 16) / l34) | 0;
          l30 = a16 << 16; l17 = a4 << 16; l25 = a6 << 16;
          l19 = (((a5 - a4 | 0) << 16) / l35) | 0;
          l18 = a10 << 16;
        }
      } else {
        // single row: colors intentionally unshifted, as the bytecode leaves them
        l29 = a16; l30 = a1; l26 = a6; l22 = a8;
        l18 = a4 << 16; l21 = a15; l25 = a2; l17 = a10 << 16;
      }
      if (l11 < 0) {
        const advance = Math.min(-l11 | 0, (a3 - l11) | 0) | 0;
        l26 = (l26 + Math.imul(advance, l28)) | 0;
        l30 = (l30 + Math.imul(advance, l32)) | 0;
        l18 = (l18 + Math.imul(advance, l20)) | 0;
        l17 = (l17 + Math.imul(advance, l19)) | 0;
        l21 = (l21 + Math.imul(l23, advance)) | 0;
        l22 = (l22 + Math.imul(l24, advance)) | 0;
        l29 = (l29 + Math.imul(advance, l31)) | 0;
        l25 = (l25 + Math.imul(advance, l27)) | 0;
        l11 = 0;
      }
      l33 = 0;
    } else {
      const startX = a10 << 16;
      l18 = startX; l17 = startX;
      const startB = a16 << 16;
      l30 = startB; l29 = startB;
      const startR = a15 << 16;
      l22 = startR; l21 = startR;
      const startG = a2 << 16;
      l26 = startG; l25 = startG;
      const l35 = (a3 - l11) | 0;
      l19 = (((a4 - a10 | 0) << 16) / l35) | 0;
      l20 = (((a5 - a10 | 0) << 16) / l34) | 0;
      if (l20 > l19) {
        l33 = 0;
        l27 = (((a6 - a2 | 0) << 16) / l35) | 0;
        l32 = (((a13 - a16 | 0) << 16) / l34) | 0;
        l24 = (((a0 - a15 | 0) << 16) / l34) | 0;
        l28 = (((a9 - a2 | 0) << 16) / l34) | 0;
        l31 = (((a1 - a16 | 0) << 16) / l35) | 0;
        l23 = (((a8 - a15 | 0) << 16) / l35) | 0;
      } else {
        const swap = l19; l19 = l20; l20 = swap;
        l27 = (((a9 - a2 | 0) << 16) / l34) | 0;
        l32 = (((a1 - a16 | 0) << 16) / l35) | 0;
        l31 = (((a13 - a16 | 0) << 16) / l34) | 0;
        l33 = 1;
        l28 = (((a6 - a2 | 0) << 16) / l35) | 0;
        l23 = (((a0 - a15 | 0) << 16) / l34) | 0;
        l24 = (((a8 - a15 | 0) << 16) / l35) | 0;
      }
      if (l11 < 0) {
        if (a3 >= 0) {
          const advance = -l11 | 0;
          l25 = (l25 + Math.imul(advance, l27)) | 0;
          l26 = (l26 + Math.imul(l28, advance)) | 0;
          l22 = (l22 + Math.imul(l24, advance)) | 0;
          l18 = (l18 + Math.imul(l20, advance)) | 0;
          l17 = (l17 + Math.imul(advance, l19)) | 0;
          l30 = (l30 + Math.imul(advance, l32)) | 0;
          l29 = (l29 + Math.imul(advance, l31)) | 0;
          l21 = (l21 + Math.imul(l23, advance)) | 0;
          l11 = 0;
        } else {
          const advance = (a3 - l11) | 0;
          l26 = (l26 + Math.imul(l28, advance)) | 0;
          l17 = (l17 + Math.imul(l19, advance)) | 0;
          l29 = (l29 + Math.imul(l31, advance)) | 0;
          l30 = (l30 + Math.imul(l32, advance)) | 0;
          l21 = (l21 + Math.imul(advance, l23)) | 0;
          l22 = (l22 + Math.imul(advance, l24)) | 0;
          l25 = (l25 + Math.imul(l27, advance)) | 0;
          l18 = (l18 + Math.imul(advance, l20)) | 0;
          l11 = a3 | 0;
        }
      }
      if (l11 < a3) {
        let rowBase = fieldD[l11] | 0;
        while (l11 < a3) {
          const xLeft = l17 >> 16;
          if (fieldA > xLeft) {
            let width = ((l18 >> 16) - xLeft) | 0;
            if (width !== 0) {
              const redStep = (((l22 - l21) | 0) / width) | 0;
              const greenStep = (((l26 - l25) | 0) / width) | 0;
              const blueStep = (((l30 - l29) | 0) / width) | 0;
              if (((xLeft + width) | 0) >= fieldA) width = (((fieldA - xLeft) | 0) - 1) | 0;
              if (xLeft >= 0) {
                scan(dest, (xLeft + rowBase) | 0, width,
                  l25, greenStep, l21, redStep, l29, blueStep);
              } else {
                scan(dest, rowBase, (width + xLeft) | 0,
                  (l25 - Math.imul(xLeft, greenStep)) | 0, greenStep,
                  (l21 - Math.imul(xLeft, redStep)) | 0, redStep,
                  (l29 - Math.imul(xLeft, blueStep)) | 0, blueStep);
              }
            }
          }
          l11 = (l11 + 1) | 0;
          if (l11 >= fieldE) return;
          l18 = (l18 + l20) | 0; l21 = (l21 + l23) | 0; l30 = (l30 + l32) | 0;
          l26 = (l26 + l28) | 0; l22 = (l22 + l24) | 0; rowBase = (rowBase + stride) | 0;
          l17 = (l17 + l19) | 0; l25 = (l25 + l27) | 0; l29 = (l29 + l31) | 0;
        }
      }
      const secondHeight = (a14 - a3) | 0;
      if (secondHeight !== 0) {
        const endX = a5 << 16, endR = a0 << 16, endG = a9 << 16, endB = a13 << 16;
        if (l33 === 0) {
          l21 = a8 << 16; l25 = a6 << 16; l29 = a1 << 16; l17 = a4 << 16;
        } else {
          l26 = a6 << 16; l22 = a8 << 16; l30 = a1 << 16; l18 = a4 << 16;
        }
        l31 = (((endB - l29) | 0) / secondHeight) | 0;
        l23 = (((endR - l21) | 0) / secondHeight) | 0;
        l27 = (((endG - l25) | 0) / secondHeight) | 0;
        l20 = (((endX - l18) | 0) / secondHeight) | 0;
        l24 = (((endR - l22) | 0) / secondHeight) | 0;
        l32 = (((endB - l30) | 0) / secondHeight) | 0;
        l19 = (((endX - l17) | 0) / secondHeight) | 0;
        l28 = (((endG - l26) | 0) / secondHeight) | 0;
      } else {
        l23 = 0; l19 = 0; l32 = 0; l20 = 0; l31 = 0; l24 = 0; l27 = 0; l28 = 0;
      }
    }

    if (l11 < 0) {
      const advance = -l11 | 0;
      l25 = (l25 + Math.imul(advance, l27)) | 0;
      l21 = (l21 + Math.imul(advance, l23)) | 0;
      l18 = (l18 + Math.imul(advance, l20)) | 0;
      l17 = (l17 + Math.imul(advance, l19)) | 0;
      l30 = (l30 + Math.imul(l32, advance)) | 0;
      l29 = (l29 + Math.imul(l31, advance)) | 0;
      l26 = (l26 + Math.imul(advance, l28)) | 0;
      l22 = (l22 + Math.imul(l24, advance)) | 0;
      l11 = 0;
    }
    let rowBase = fieldD[l11] | 0;
    while (l11 < a14) {
      const xLeft = l17 >> 16;
      if (fieldA > xLeft) {
        let width = ((l18 >> 16) - xLeft) | 0;
        if (width !== 0) {
          const redStep = (((l22 - l21) | 0) / width) | 0;
          const greenStep = (((l26 - l25) | 0) / width) | 0;
          const blueStep = (((l30 - l29) | 0) / width) | 0;
          if (fieldA <= ((width + xLeft) | 0)) width = (((fieldA - xLeft) | 0) - 1) | 0;
          if (xLeft >= 0) {
            scan(dest, (rowBase + xLeft) | 0, width,
              l25, greenStep, l21, redStep, l29, blueStep);
          } else {
            scan(dest, rowBase, (width + xLeft) | 0,
              (l25 - Math.imul(greenStep, xLeft)) | 0, greenStep,
              (l21 - Math.imul(redStep, xLeft)) | 0, redStep,
              (l29 - Math.imul(blueStep, xLeft)) | 0, blueStep);
          }
        }
      }
      l11 = (l11 + 1) | 0;
      if (l11 >= fieldE) return;
      l29 = (l29 + l31) | 0; rowBase = (rowBase + stride) | 0; l26 = (l26 + l28) | 0;
      l18 = (l18 + l20) | 0; l25 = (l25 + l27) | 0; l22 = (l22 + l24) | 0;
      l30 = (l30 + l32) | 0; l17 = (l17 + l19) | 0; l21 = (l21 + l23) | 0;
    }
  }

  // The clipped raster only writes indexes in
  // [fieldD[row], fieldD[startRow] + (rows-1)*stride + fieldA). With a linear
  // row table and a large enough destination no write can escape, so the
  // per-scanline guards of the generated kernel become provably dead.
  function standardLayout(dest, fieldD, fieldE, fieldA, stride, yTop, yMid) {
    if (dest == null || fieldD == null) return false;
    if (fieldE <= 0 || fieldD.length < fieldE) return false;
    if (dest.length < (Math.imul(fieldE - 1, stride) + fieldA | 0)) return false;
    const rowTop = yTop > 0 ? yTop : 0;
    const rowMid = yMid > 0 ? yMid : 0;
    if (rowTop < fieldE && fieldD[rowTop] !== Math.imul(rowTop, stride)) return false;
    if (rowMid < fieldE && fieldD[rowMid] !== Math.imul(rowMid, stride)) return false;
    return true;
  }

  function wrapper(state, regionArg, helpers, p0, p1, p2, p3, p4, p5, p6, p7,
    p8, p9, p10, p11, p12, p13, p14, p15) {
    p0 |= 0; p1 |= 0; p2 |= 0; p3 |= 0; p4 |= 0; p5 |= 0; p6 |= 0; p7 |= 0;
    p8 |= 0; p9 |= 0; p10 |= 0; p11 |= 0; p12 |= 0; p13 |= 0; p14 |= 0; p15 |= 0;
    const dest = readStatic(1);
    const fieldE = readStatic(3) | 0;
    const fieldA = readStatic(4) | 0;
    const fieldD = readStatic(5);
    const stride = readStatic(6) | 0;
    // vertex sort: y values are p1/p8/p11
    let yTop, yMid;
    if (p1 > p11) {
      if (p8 > p1) { yTop = p11; yMid = p1; }
      else if (p8 > p11) { yTop = p11; yMid = p8; }
      else { yTop = p8; yMid = p11; }
    } else if (p11 < p8) { yTop = p1; yMid = p11; }
    else if (p8 > p1) { yTop = p8; yMid = p1; }
    else { yTop = p1; yMid = p8; }
    if (!standardLayout(dest, fieldD, fieldE, fieldA, stride, yTop, yMid)) {
      return generatedWrapper(state, regionArg, helpers, p0, p1, p2, p3, p4,
        p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15);
    }
    if (jit) jit.handwrittenFusedRunCount = (jit.handwrittenFusedRunCount | 0) + 1;
    if (p1 > p11) {
      if (p8 > p1) {
        raster(fieldE, fieldA, fieldD, stride, p3, p7, p13, p1, p4, p14, p15, p9, p10, p2, p11, dest, p6, p8, p5, p0);
      } else if (p8 > p11) {
        raster(fieldE, fieldA, fieldD, stride, p9, p6, p13, p8, p14, p4, p10, p3, p15, p2, p11, dest, p7, p1, p5, p0);
      } else {
        raster(fieldE, fieldA, fieldD, stride, p9, p0, p10, p11, p2, p4, p13, p5, p15, p14, p8, dest, p7, p1, p3, p6);
      }
    } else if (p11 < p8) {
      raster(fieldE, fieldA, fieldD, stride, p3, p0, p15, p11, p2, p14, p13, p5, p10, p4, p1, dest, p6, p8, p9, p7);
    } else if (p8 > p1) {
      raster(fieldE, fieldA, fieldD, stride, p5, p6, p15, p8, p14, p2, p10, p3, p13, p4, p1, dest, p0, p11, p9, p7);
    } else {
      raster(fieldE, fieldA, fieldD, stride, p5, p7, p10, p1, p4, p2, p15, p9, p13, p14, p8, dest, p0, p11, p3, p6);
    }
    if (p12 !== 1) writeStatic(2, null);
  }

  return wrapper;
}
