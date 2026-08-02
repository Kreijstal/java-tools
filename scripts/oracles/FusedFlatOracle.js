"use strict";

// Historical implementation of the structurally verified constant-colour
// triangle raster family.  Parameter and static-field roles are supplied by
// FusedRegionCompiler's bytecode analysis; no guest class or method identity
// is used here.

module.exports = { installRaster };

function installRaster(region, jit, plan) {
  const targets = region.staticTargets;
  const generatedRaster = region.rasterKernel;
  const readStatic = (index) => targets[index].kind === "map"
    ? targets[index].fields.get(targets[index].key)
    : targets[index].fields[targets[index].key];

  function scan(dest, index, count, color) {
    index |= 0;
    count |= 0;
    color |= 0;
    for (let offset = 0; offset < count; offset += 1) {
      dest[index] = (color + ((dest[index] & 16711422) >> 1)) | 0;
      index += 1;
    }
  }

  function standardLayout(dest, rows, height, width, stride, yTop, yMid) {
    if (dest == null || rows == null) return false;
    if (height <= 0 || rows.length < height) return false;
    if (dest.length < (Math.imul(height - 1, stride) + width | 0)) return false;
    const top = yTop > 0 ? yTop : 0;
    const mid = yMid > 0 ? yMid : 0;
    if (top < height && rows[top] !== Math.imul(top, stride)) return false;
    if (mid < height && rows[mid] !== Math.imul(mid, stride)) return false;
    return true;
  }

  function raster(height, width, rows, stride,
    xTop, yMid, xBottom, yBottom, color, xMid, yTop, dest) {
    xTop |= 0; yMid |= 0; xBottom |= 0; yBottom |= 0;
    color |= 0; xMid |= 0; yTop |= 0;
    if (yBottom < 0 || yTop >= height) return;
    if (xTop < 0 && xMid < 0 && xBottom < 0) return;
    if (xTop >= width && xMid >= width && xBottom >= width) return;

    const fullHeight = (yBottom - yTop) | 0;
    let left = 0;
    let right = 0;
    let leftStep = 0;
    let rightStep = 0;
    let middleOnRight = 0;

    if (yMid !== yTop) {
      left = xTop << 16;
      right = left;
      const upperHeight = (yMid - yTop) | 0;
      rightStep = (((xBottom - xTop | 0) << 16) / fullHeight) | 0;
      leftStep = (((xMid - xTop | 0) << 16) / upperHeight) | 0;
      if (leftStep > rightStep) {
        const swap = leftStep;
        leftStep = rightStep;
        rightStep = swap;
        middleOnRight = 1;
      }

      if (yTop < 0) {
        if (yMid >= 0) {
          const advance = -yTop | 0;
          left = (left + Math.imul(advance, leftStep)) | 0;
          right = (right + Math.imul(advance, rightStep)) | 0;
          yTop = 0;
        } else {
          const advance = (yMid - yTop) | 0;
          left = (left + Math.imul(leftStep, advance)) | 0;
          right = (right + Math.imul(rightStep, advance)) | 0;
          yTop = yMid;
        }
      }

      if (yTop < yMid) {
        let rowBase = rows[yTop] | 0;
        while (yTop < yMid) {
          drawRow(dest, rowBase, width, left, right, color);
          yTop = (yTop + 1) | 0;
          if (yTop >= height) return;
          left = (left + leftStep) | 0;
          right = (right + rightStep) | 0;
          rowBase = (rowBase + stride) | 0;
        }
      }

      const lowerHeight = (yBottom - yMid) | 0;
      if (lowerHeight !== 0) {
        const bottom = xBottom << 16;
        if (middleOnRight !== 0) right = xMid << 16;
        else left = xMid << 16;
        rightStep = ((bottom - right | 0) / lowerHeight) | 0;
        leftStep = ((bottom - left | 0) / lowerHeight) | 0;
      } else {
        rightStep = 0;
        leftStep = 0;
      }
    } else {
      if (yTop !== yBottom) {
        const lowerHeight = (yBottom - yTop) | 0;
        if (xMid <= xTop) {
          leftStep = (((xBottom - xMid | 0) << 16) / lowerHeight) | 0;
          rightStep = (((xBottom - xTop | 0) << 16) / fullHeight) | 0;
          left = xMid << 16;
          right = xTop << 16;
        } else {
          left = xTop << 16;
          right = xMid << 16;
          leftStep = (((xBottom - xTop | 0) << 16) / fullHeight) | 0;
          rightStep = (((xBottom - xMid | 0) << 16) / lowerHeight) | 0;
        }
      } else {
        leftStep = 0;
        rightStep = 0;
        left = xTop << 16;
        right = xMid << 16;
      }
      if (yTop < 0) {
        const advance = Math.min(-yTop | 0, (yMid - yTop) | 0) | 0;
        left = (left + Math.imul(advance, leftStep)) | 0;
        right = (right + Math.imul(advance, rightStep)) | 0;
        yTop = 0;
      }
    }

    if (yTop < 0) {
      const advance = -yTop | 0;
      left = (left + Math.imul(leftStep, advance)) | 0;
      right = (right + Math.imul(rightStep, advance)) | 0;
      yTop = 0;
    }
    let rowBase = rows[yTop] | 0;
    if (plan.singleLowerScanline) {
      if (yTop < yBottom) drawRow(dest, rowBase, width, left, right, color);
      return;
    }
    while (yTop < yBottom) {
      drawRow(dest, rowBase, width, left, right, color);
      yTop = (yTop + 1) | 0;
      if (yTop >= height) return;
      left = (left + leftStep) | 0;
      right = (right + rightStep) | 0;
      rowBase = (rowBase + stride) | 0;
    }
  }

  function drawRow(dest, rowBase, width, leftFixed, rightFixed, color) {
    const xLeft = leftFixed >> 16;
    if (width <= xLeft) return;
    let count = ((rightFixed >> 16) - xLeft) | 0;
    if (count === 0) return;
    if (((xLeft + count) | 0) >= width) count = (((width - xLeft) | 0) - 1) | 0;
    if (xLeft >= 0) scan(dest, (rowBase + xLeft) | 0, count, color);
    else scan(dest, rowBase, (count + xLeft) | 0, color);
  }

  const semanticFlatRaster = function semanticFlatRaster(state, regionArg, helpers,
    a0, a1, a2, a3, a4, a5, a6, a7, a8) {
    const height = readStatic(plan.heightStatic) | 0;
    const width = readStatic(plan.widthStatic) | 0;
    const rows = readStatic(plan.rowsStatic);
    const stride = readStatic(plan.strideStatic) | 0;
    if ((a5 | 0) !== plan.tagValue ||
        !standardLayout(a8, rows, height, width, stride, a7 | 0, a1 | 0)) {
      return generatedRaster(state, regionArg, helpers,
        a0, a1, a2, a3, a4, a5, a6, a7, a8);
    }
    if (jit) jit.semanticFusedFlatRasterRunCount =
      (jit.semanticFusedFlatRasterRunCount | 0) + 1;
    return raster(height, width, rows, stride,
      a0, a1, a2, a3, a4, a6, a7, a8);
  };
  semanticFlatRaster.directKernel = function directFlatRaster(
    height, width, rows, stride, a0, a1, a2, a3, a4, a5, a6, a7, a8) {
    if (jit) jit.semanticFusedFlatRasterRunCount =
      (jit.semanticFusedFlatRasterRunCount | 0) + 1;
    return raster(height | 0, width | 0, rows, stride | 0,
      a0, a1, a2, a3, a4, a6, a7, a8);
  };
  return semanticFlatRaster;
}
