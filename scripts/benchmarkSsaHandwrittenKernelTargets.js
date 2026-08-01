#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const Perspective = require('../src/jit/HandwrittenPerspectiveSpan');
const Tiled = require('../src/jit/HandwrittenTiledBlit');
const Bilinear = require('../src/jit/HandwrittenBilinearSampler');
const Polygon = require('../src/jit/HandwrittenPolygonRaster');

const root = path.resolve(__dirname, '..');
const source = path.join(
  root, 'benchmarks', 'SsaHandwrittenKernelTargetsBenchmark.java');
const className = 'SsaHandwrittenKernelTargetsBenchmark';
const iterations = positiveInteger('SSA_KERNEL_TARGET_ITERATIONS', 10000);
const rounds = positiveInteger('SSA_KERNEL_TARGET_ROUNDS', 7);
const warmups = positiveInteger('SSA_KERNEL_TARGET_WARMUPS', 4);
const trustedNestedEntry = process.env.SSA_TRUSTED_NESTED !== '0';

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function intArray(length, initialize) {
  const result = Array.from(
    { length }, (_unused, index) => initialize(index) | 0);
  result.type = '[I';
  return result;
}

function checksum(values) {
  let value = 0;
  for (let index = 0; index < values.length; index += 1) {
    value = (Math.imul(value, 31) + (values[index] | 0)) | 0;
  }
  return value;
}

function compileFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jvm-ssa-kernel-targets-'));
  execFileSync('javac', [
    '-source', '8', '-target', '8', '-d', directory, source,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return directory;
}

async function createRuntime(directory) {
  const jvm = new JVM({ classpath: [directory], jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
    profileMethods: false,
    structuredSsa: true,
    fusedRegions: false,
    guestKernelOracles: false,
    checkedLeafDirectPositional: true,
  } });
  const classData = await jvm.loadClassByName(className);
  classData.staticFieldsInitialized = true;
  jvm.classInitializationState.set(className, 'INITIALIZED');
  tiledOracleRun = Tiled._test.createRun(jvm.jit, className, className, {
    ASYNC_INVOKE: false,
    RETURN_VOID: true,
  });
  return { jvm, classData };
}

function planFor(method) {
  return {
    target: { freeFrame: null },
    Frame,
    lookupClass: className,
    method,
    restoreFrame(thread, frame, depth) {
      thread.callStack.items.splice(depth, 0, frame);
    },
  };
}

function compileBody(runtime, name, descriptor) {
  const method = runtime.jvm.findMethod(
    runtime.classData, name, descriptor);
  if (!method) throw new Error(`missing fixture method ${name}${descriptor}`);
  // Use the public cached JIT path. Besides matching production tier
  // selection, this makes an already compiled checked leaf available for
  // structural call-site insertion in methods compiled later in the fixture.
  const generated = runtime.jvm.jit.getGeneratedFunction(method);
  const body = generated?.jvmRestoringDirectPositionalBody;
  const checkedLeafBody = generated?.jvmCheckedLeafDirectPositionalBody;
  const trustedCheckedLeafBody =
    generated?.jvmTrustedCheckedLeafDirectPositionalBody;
  const capturedCheckedLeafBody =
    generated?.jvmCapturedCheckedLeafDirectPositionalBody;
  const capturedCheckedLeafPlan =
    generated?.jvmCapturedCheckedLeafDirectPositionalPlan;
  if (!(generated?.jvmStructuredSsa || generated?.jvmStructuredPositionalOnly) ||
      typeof body !== 'function') {
    const reason = runtime.jvm.jit.structuredSsa.lastRejectionReason ||
      runtime.jvm.jit.structuredSsa.lastCompileError?.stack || '';
    throw new Error(`generic SSA did not compile ${name}${descriptor}` +
      (reason ? `: ${reason}` : '') + ` keys=${Object.keys(generated || {})}`);
  }
  const dumpPattern = process.env.SSA_KERNEL_DUMP_METHOD || '';
  if (dumpPattern && `${name}${descriptor}`.includes(dumpPattern)) {
    const dumpTier = process.env.SSA_KERNEL_DUMP_TIER;
    const dumpedSource = dumpTier === 'trusted-checked-leaf'
      ? generated.jvmTrustedCheckedLeafDirectPositionalSource
      : dumpTier === 'captured-checked-leaf'
      ? generated.jvmCapturedCheckedLeafDirectPositionalSource
      : dumpTier === 'checked-leaf'
        ? generated.jvmCheckedLeafDirectPositionalSource
        : generated.jvmRestoringDirectPositionalSource;
    process.stderr.write(`/* ${name}${descriptor} */\n` +
      `${dumpedSource || ''}\n`);
  }
  return {
    method, generated, body, checkedLeafBody, trustedCheckedLeafBody,
    capturedCheckedLeafBody, capturedCheckedLeafPlan,
    plan: planFor(method),
  };
}

function benchmarkPair(name, generic, oracle, pixelsPerInvocation) {
  // Tiny runs are useful for checking compilation and checksums, but include
  // lazy JavaScript compilation/tiering in the timed sample.  Label them so a
  // focused smoke validation cannot be mistaken for steady-state throughput.
  const timingQualified =
    iterations >= 1000 && rounds >= 3 && warmups >= 4;
  let genericCursor = 0;
  let oracleCursor = 0;
  const genericBatch = () => {
    for (let call = 0; call < iterations; call += 1) {
      generic.invoke(genericCursor++ & 63);
    }
  };
  const oracleBatch = () => {
    for (let call = 0; call < iterations; call += 1) {
      oracle.invoke(oracleCursor++ & 63);
    }
  };
  for (let warmup = 0; warmup < warmups; warmup += 1) {
    generic.destination.fill(warmup);
    oracle.destination.fill(warmup);
    genericCursor = 0;
    oracleCursor = 0;
    if ((warmup & 1) === 0) {
      genericBatch();
      oracleBatch();
    } else {
      oracleBatch();
      genericBatch();
    }
  }
  const genericElapsed = [];
  const oracleElapsed = [];
  let genericChecksum = 0;
  let oracleChecksum = 0;
  for (let round = 0; round < rounds; round += 1) {
    generic.destination.fill(round);
    oracle.destination.fill(round);
    genericCursor = 0;
    oracleCursor = 0;
    let genericRound = 0;
    let oracleRound = 0;
    const order = (round & 1) === 0
      ? ['generic', 'oracle', 'oracle', 'generic']
      : ['oracle', 'generic', 'generic', 'oracle'];
    for (const target of order) {
      const started = process.hrtime.bigint();
      if (target === 'generic') genericBatch();
      else oracleBatch();
      const elapsed = Number(process.hrtime.bigint() - started);
      if (target === 'generic') genericRound += elapsed;
      else oracleRound += elapsed;
    }
    const left = checksum(generic.destination);
    const right = checksum(oracle.destination);
    if (left !== right) {
      throw new Error(`${name} checksum mismatch: ${left} !== ${right}`);
    }
    genericElapsed.push(genericRound);
    oracleElapsed.push(oracleRound);
    genericChecksum ^= left;
    oracleChecksum ^= right;
  }
  const pairedRatios = genericElapsed.map(
    (elapsed, index) => elapsed / oracleElapsed[index]);
  const medianPairedRatio = median(pairedRatios);
  const comparison = !timingQualified
    ? 'inconclusive-smoke-run'
    : medianPairedRatio < 1
      ? 'generic-faster'
      : medianPairedRatio > 1
        ? 'generic-slower'
        : 'equal';
  return {
    name,
    timingKind: timingQualified ? 'steady-state' : 'smoke-not-steady-state',
    timingQualified,
    timingWarning: timingQualified ? undefined :
      'timed sample is too small for a throughput comparison',
    ratioMeaning: 'generic elapsed / oracle elapsed; below 1.0 means generic is faster',
    comparison,
    iterationsPerSample: iterations * 2,
    rounds,
    warmups,
    pixelsPerInvocation,
    genericNanosecondsPerInvocation:
      median(genericElapsed) / (iterations * 2),
    oracleNanosecondsPerInvocation:
      median(oracleElapsed) / (iterations * 2),
    medianPairedRatio,
    genericSpeedupVsOracle: timingQualified
      ? 1 / medianPairedRatio
      : undefined,
    pairedRatios,
    checksum: genericChecksum,
    oracleChecksum,
    generated: generic.generated,
  };
}

function runTiledFixedCeiling(destination, source, item) {
  let destinationIndex = 0;
  const sourceWidth = 32;
  const rowCount = 8;
  let sourceRow = item & 15;
  const copyWidth = 16;
  const destinationRowSkip = 16;
  const sourceStartX = item & 15;
  let sourceX = sourceStartX;
  let sourceIndex = sourceRow * sourceWidth + sourceX;
  const sourceHeight = 16;
  const sourceCycle = sourceHeight * sourceWidth;
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < copyWidth; column += 1) {
      destination[destinationIndex++] = source[sourceIndex++] | 0;
      if (++sourceX === sourceWidth) {
        sourceIndex -= sourceWidth;
        sourceX = 0;
      }
    }
    destinationIndex += destinationRowSkip;
    sourceIndex = sourceIndex - sourceX + sourceStartX + sourceWidth;
    sourceX = sourceStartX;
    if (++sourceRow === sourceHeight) {
      sourceRow = 0;
      sourceIndex -= sourceCycle;
    }
  }
}

// The retirement comparator invokes the exact positional implementation used
// by the installed handwritten intrinsic. Keep the fixed workload above as an
// explicitly selected code-generation ceiling, not as the retirement gate.
let tiledOracleRun = null;

function runBilinearOracle(receiver, destination, destinationIndex,
  sourceX, sourceY, fractionX, fractionY) {
  const width = receiver.width;
  const height = receiver.height;
  const source = receiver.source;
  let index = Math.imul(sourceY, width) + sourceX | 0;
  fractionX &= 4095;
  fractionY &= 4095;
  let p00 = 0, p10 = 0, p01 = 0, p11 = 0;
  let w00 = 0, w10 = 0, w01 = 0, w11 = 0;
  if (sourceY >= 0) {
    if (sourceX >= 0) {
      p00 = source[index] | 0;
      if (p00 !== 0) w00 = Math.imul(4096 - fractionX, 4096 - fractionY);
    }
    if (sourceX < width - 1) {
      p10 = source[index + 1] | 0;
      if (p10 !== 0) w10 = Math.imul(fractionX, 4096 - fractionY);
    }
  }
  if (sourceY < height - 1) {
    if (sourceX >= 0) {
      p01 = source[index + width] | 0;
      if (p01 !== 0) w01 = Math.imul(4096 - fractionX, fractionY);
    }
    if (sourceX < width - 1) {
      p11 = source[index + width + 1] | 0;
      if (p11 !== 0) w11 = Math.imul(fractionX, fractionY);
    }
  }
  w00 >>= 16; w10 >>= 16; w01 >>= 16; w11 >>= 16;
  const alpha = (w00 + w10 + w01 + w11) | 0;
  if (alpha < 128) return;
  const redBlue = (Math.imul(p00 & 0xff00ff, w00) +
    Math.imul(p10 & 0xff00ff, w10) +
    Math.imul(p01 & 0xff00ff, w01) +
    Math.imul(p11 & 0xff00ff, w11)) | 0;
  const green = (Math.imul(p00 & 0xff00, w00) +
    Math.imul(p10 & 0xff00, w10) +
    Math.imul(p01 & 0xff00, w01) +
    Math.imul(p11 & 0xff00, w11)) | 0;
  let color = alpha >= 256
    ? (((redBlue >>> 8) & 0xff00ff) + ((green >>> 8) & 0xff00)) | 0
    : (((((redBlue >>> 16) / alpha) | 0) << 16) +
      (((green / alpha) | 0) & 0xff00) +
      (((redBlue & 65535) / alpha) | 0)) | 0;
  destination[destinationIndex] = color === 0 ? 1 : color;
}

function runPolygonOracle(destination, vertices, color) {
  const width = 64;
  const height = 64;
  const pairs = vertices.length >> 1;
  for (let y = 0; y < height; y += 1) {
    let left = width;
    let right = -1;
    let previous = pairs - 1;
    for (let current = 0; current < pairs; current += 1) {
      const x0 = vertices[previous << 1] | 0;
      const y0 = vertices[(previous << 1) + 1] | 0;
      const x1 = vertices[current << 1] | 0;
      const y1 = vertices[(current << 1) + 1] | 0;
      if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
        const x = (x0 +
          ((Math.imul(y - y0, x1 - x0) / (y1 - y0)) | 0)) | 0;
        if (x < left) left = x;
        if (x > right) right = x;
      }
      previous = current;
    }
    if (left <= right) {
      let count = (right - left + 1) | 0;
      let x = left;
      if (x < 0) {
        count = (count + x) | 0;
        x = 0;
      }
      if (x + count > width) count = width - x;
      let index = y * width + x;
      for (let offset = 0; offset < count; offset += 1) {
        destination[index + offset] = color | 0;
      }
    }
  }
}

(async () => {
  const directory = compileFixture();
  try {
    const runtime = await createRuntime(directory);
    const thread = {
      id: 1, name: 'ssa-kernel-targets', status: 'runnable',
      pendingException: null, callStack: new Stack(),
    };

    const tiled = compileBody(runtime, 'tiledBlit', '(IIIIB[II[IIIII)V');
    const tiledSource = intArray(32 * 16,
      index => Math.imul(index + 1, 0x10203));
    const tiledGenericDestination = intArray(256, () => 0);
    const tiledOracleDestination = intArray(256, () => 0);
    const tiledResult = benchmarkPair('tiled-blit', {
      destination: tiledGenericDestination,
      generated: tiled.generated,
      invoke(item) {
        const sourceX = item & 15;
        const sourceRow = item & 15;
        if (tiled.trustedCheckedLeafBody) {
          return tiled.trustedCheckedLeafBody(runtime.jvm.jit,
            0, 32, 8, sourceRow, -64, tiledGenericDestination, 16,
            tiledSource, 16, sourceX, sourceRow * 32 + sourceX, 16,
            thread);
        }
        if (tiled.checkedLeafBody) {
          return tiled.checkedLeafBody(runtime.jvm.jit,
            0, 32, 8, sourceRow, -64, tiledGenericDestination, 16,
            tiledSource, 16, sourceX, sourceRow * 32 + sourceX, 16,
            thread, trustedNestedEntry);
        }
        return tiled.body(runtime.jvm.jit, tiled.plan,
          0, 32, 8, sourceRow, -64, tiledGenericDestination, 16,
          tiledSource, 16, sourceX, sourceRow * 32 + sourceX, 16,
          thread, trustedNestedEntry);
      },
    }, {
      destination: tiledOracleDestination,
      invoke(item) {
        if (process.env.SSA_TILED_FIXED_CEILING === '1') {
          runTiledFixedCeiling(tiledOracleDestination, tiledSource, item);
          return;
        }
        const sourceX = item & 15;
        const sourceRow = item & 15;
        tiledOracleRun(
          0, 32, 8, sourceRow, -64, tiledOracleDestination, 16,
          tiledSource, 16, sourceX, sourceRow * 32 + sourceX, 16);
      },
    }, 128);
    tiledResult.oracleKind = process.env.SSA_TILED_FIXED_CEILING === '1'
      ? 'fixed-specialized-ceiling' : 'dynamic-guarded-handwritten';
    tiledResult.genericEntryKind = tiled.trustedCheckedLeafBody
      ? 'trusted-nested-checked-leaf' : tiled.checkedLeafBody
        ? 'dynamic-checked-leaf' : 'restoring-positional';

    // Keep a second tiled row where the constant layout operands are visible
    // at a compiled Java call site. This is the fair code-generation ceiling
    // for interprocedural specialization: unlike runTiledFixedCeiling it must
    // still retain the JVM entry and array-layout guards that make the call
    // semantically valid for arbitrary Java arrays.
    const tiledCaller = compileBody(runtime, 'tiledBlitFromCaller',
      '([I[II)V');
    const tiledCallerGenericDestination = intArray(256, () => 0);
    const tiledCallerCeilingDestination = intArray(256, () => 0);
    const tiledCallerResult = benchmarkPair('tiled-blit-compiled-caller', {
      destination: tiledCallerGenericDestination,
      generated: tiledCaller.generated,
      invoke(item) {
        if (tiledCaller.checkedLeafBody) {
          return tiledCaller.checkedLeafBody(runtime.jvm.jit,
            tiledCallerGenericDestination, tiledSource, item,
            thread, trustedNestedEntry);
        }
        return tiledCaller.body(runtime.jvm.jit, tiledCaller.plan,
          tiledCallerGenericDestination, tiledSource, item,
          thread, trustedNestedEntry);
      },
    }, {
      destination: tiledCallerCeilingDestination,
      invoke(item) {
        runTiledFixedCeiling(tiledCallerCeilingDestination, tiledSource, item);
      },
    }, 128);
    tiledCallerResult.oracleKind = 'fixed-specialized-ceiling';
    tiledCallerResult.genericEntryKind = 'lexically-fused-checked-leaf';

    const perspective = compileBody(runtime, 'perspectiveSpan',
      '([I[IIIIIIIIIIIIII)V');
    const texture = intArray(4096, index =>
      index % 13 === 0 ? 0 : Math.imul(index + 3, 0x10203));
    const perspectiveGenericDestination = intArray(256, () => 0);
    const perspectiveOracleDestination = intArray(256, () => 0);
    const perspectiveFields = new Map([
      ['clip', true], ['clipRight', 128], ['lowDetail', true],
      ['centerX', 64], ['opaque', false],
    ]);
    const perspectiveHandwritten = Perspective._test.createRun(
      runtime.jvm.jit,
      ['clip', 'clipRight', 'lowDetail', 'centerX', 'opaque'].map(
        (key) => ({ kind: 'map', fields: perspectiveFields, key })),
      [className], className,
      { ASYNC_INVOKE: false, RETURN_VOID: true });
    const perspectiveResult = benchmarkPair('perspective-span', {
      destination: perspectiveGenericDestination,
      generated: perspective.generated,
      invoke(item) {
        return perspective.body(runtime.jvm.jit, perspective.plan,
          perspectiveGenericDestination, texture, 0, 0, 0,
          item & 7, 96 + (item & 15), 65536 + item * 31, 128,
          8192 + item * 17, 4096 + item * 11, 1 << 20,
          256, 192, 1024, thread, trustedNestedEntry);
      },
    }, {
      destination: perspectiveOracleDestination,
      invoke(item) {
        if (process.env.SSA_PERSPECTIVE_FIXED_CEILING === '1') {
          Perspective._test.runKernel(
            perspectiveOracleDestination, texture, 0,
            item & 7, 96 + (item & 15), 65536 + item * 31, 128,
            8192 + item * 17, 4096 + item * 11, 1 << 20,
            256, 192, 1024, true, 128, 64, true, false);
          return;
        }
        perspectiveHandwritten(
          perspectiveOracleDestination, texture, 0, 0, 0,
          item & 7, 96 + (item & 15), 65536 + item * 31, 128,
          8192 + item * 17, 4096 + item * 11, 1 << 20,
          256, 192, 1024);
      },
    }, 96);
    perspectiveResult.oracleKind =
      process.env.SSA_PERSPECTIVE_FIXED_CEILING === '1'
        ? 'fixed-inner-kernel-ceiling' : 'dynamic-guarded-handwritten';

    const bilinearSource = intArray(64 * 64, index =>
      index % 11 === 0 ? 0 : Math.imul(index + 5, 0x10101));
    const bilinearGenericDestination = intArray(64, () => 0);
    const bilinearOracleDestination = intArray(64, () => 0);
    runtime.classData.staticFields.set(
      'bilinearDestination:[I', bilinearGenericDestination);
    const bilinear = compileBody(runtime, 'bilinearSample', '(IIIII)V');
    const receiver = {
      type: className,
      fields: {
        [`${className}.width`]: 64,
        [`${className}.height`]: 64,
        [`${className}.source`]: bilinearSource,
      },
    };
    const bilinearHandwritten = Bilinear._test.installStructurallyVerified(
      runtime.jvm.jit, bilinear.method);
    if (!bilinearHandwritten) {
      throw new Error('exact handwritten bilinear shape did not verify');
    }
    bilinearHandwritten.plan.destination = {
      kind: 'map',
      fields: new Map([
        ['bilinearDestination:[I', bilinearOracleDestination],
      ]),
      key: 'bilinearDestination:[I',
    };
    const bilinearHandwrittenInvocationPlan = {
      semantic: bilinearHandwritten.plan,
    };
    const bilinearResult = benchmarkPair('bilinear-sampler', {
      destination: bilinearGenericDestination,
      generated: bilinear.generated,
      invoke(item) {
        const x = 1 + (item * 17 % 62);
        const y = 1 + (item * 29 % 62);
        if (bilinear.checkedLeafBody) {
          return bilinear.checkedLeafBody(runtime.jvm.jit,
            receiver, item, x, y, item * 193, item * 317,
            thread, trustedNestedEntry);
        }
        return bilinear.body(runtime.jvm.jit, bilinear.plan,
          receiver, item, x, y, item * 193, item * 317,
          thread, trustedNestedEntry);
      },
    }, {
      destination: bilinearOracleDestination,
      invoke(item) {
        const x = 1 + (item * 17 % 62);
        const y = 1 + (item * 29 % 62);
        if (process.env.SSA_BILINEAR_FIXED_CEILING === '1') {
          runBilinearOracle({ width: 64, height: 64, source: bilinearSource },
            bilinearOracleDestination, item, x, y,
            item * 193, item * 317);
          return;
        }
        bilinearHandwritten.body(runtime.jvm.jit,
          bilinearHandwrittenInvocationPlan, receiver, item, x, y,
          item * 193, item * 317, thread);
      },
    }, 1);
    bilinearResult.oracleKind =
      process.env.SSA_BILINEAR_FIXED_CEILING === '1'
        ? 'fixed-specialized-ceiling' : 'dynamic-guarded-handwritten';

    const polygonGenericDestination = intArray(64 * 64, () => 0);
    const polygonOracleDestination = intArray(64 * 64, () => 0);
    runtime.classData.staticFields.set(
      'polygonDestination:[I', polygonGenericDestination);
    runtime.classData.staticFields.set('polygonWidth:I', 64);
    runtime.classData.staticFields.set('polygonHeight:I', 64);
    runtime.classData.staticFields.set('polygonClipLeft:I', 0);
    runtime.classData.staticFields.set('polygonClipRight:I', 64);
    runtime.classData.staticFields.set('polygonClipTop:I', 0);
    runtime.classData.staticFields.set('polygonClipBottom:I', 64);
    // Measure the steady-state initialized shape. The previous ordering
    // compiled these methods before installing their static field values,
    // permanently benchmarking first-link fallback branches that neither the
    // handwritten implementation nor a warmed application retains.
    // Compile the ordinary child first so the caller can link its positional
    // generated entry without depending on a warm interpreter invocation.
    compileBody(runtime, 'polygonSpan', '(IIII)V');
    const polygon = compileBody(runtime, 'polygonFill', '([II)V');
    const polygonCases = Array.from({ length: 64 }, (_unused, item) =>
      intArray(12, index => {
        const shape = [
          8 + (item & 7), 5,
          48, 9 + (item & 3),
          58 - (item & 3), 31,
          44, 55,
          13, 51 - (item & 3),
          4 + (item & 3), 25,
        ];
        return shape[index];
      }));
    const polygonResult = benchmarkPair('polygon-raster', {
      destination: polygonGenericDestination,
      generated: polygon.generated,
      invoke(item) {
        return polygon.body(runtime.jvm.jit, polygon.plan,
          polygonCases[item], (0xff000000 | Math.imul(item + 1, 0x10203)),
          thread, trustedNestedEntry);
      },
    }, {
      destination: polygonOracleDestination,
      invoke(item) {
        runPolygonOracle(polygonOracleDestination, polygonCases[item],
          0xff000000 | Math.imul(item + 1, 0x10203));
      },
    }, 1600);
    polygonResult.oracleKind = 'equivalent-scanline-ceiling';

    // Exercise the edge-table algorithm implemented by the historical
    // polygon intrinsic itself. The Java fixture mirrors that complete state
    // machine, including scratch sorting and all published cursor fields, so
    // this row is a same-algorithm comparator rather than the simpler
    // equivalent convex-scanline ceiling above.
    const polygonEdgeGenericDestination = intArray(64 * 64, () => 0);
    const polygonEdgeOracleDestination = intArray(64 * 64, () => 0);
    const polygonEdgeGenericScratch = intArray(24, () => 0);
    runtime.classData.staticFields.set(
      'polygonDestination:[I', polygonEdgeGenericDestination);
    runtime.classData.staticFields.set(
      'polygonEdgeScratch:[I', polygonEdgeGenericScratch);
    for (const key of [
      'polygonEdgeCount:I', 'polygonEdgeLeft:I', 'polygonEdgeRight:I',
      'polygonEdgeY:I', 'polygonEdgeActiveEnd:I',
      'polygonEdgePairCursor:I', 'polygonEdgeExpiredStart:I',
    ]) runtime.classData.staticFields.set(key, 0);
    const polygonEdge = compileBody(
      runtime, 'polygonEdgeFill', '([II)V');
    const oracleFields = new Map([
      ['count', 0], ['scratch', intArray(24, () => 0)],
      ['left', 0], ['right', 0], ['y', 0], ['activeEnd', 0],
      ['pairCursor', 0], ['expiredStart', 0],
      ['clipTop', 0], ['clipBottom', 64], ['clipLeft', 0],
      ['clipRight', 64], ['surfaceWidth', 64],
      ['pixels', polygonEdgeOracleDestination],
    ]);
    const mapLocation = (key) => ({ kind: 'map', fields: oracleFields, key });
    const polygonHandwritten = Polygon._test.createIntrinsicForPlan(
      runtime.jvm.jit, {
        alpha: false,
        classOwners: [className],
        locations: Object.fromEntries([
          'count', 'scratch', 'left', 'right', 'y', 'activeEnd',
          'pairCursor', 'expiredStart', 'clipTop', 'clipBottom',
          'clipLeft', 'clipRight', 'surfaceWidth', 'pixels',
        ].map((key) => [key, mapLocation(key)])),
      }, { ASYNC_INVOKE: false, RETURN_VOID: true });
    const polygonHandwrittenRun =
      polygonHandwritten.jvmDirectData.run;
    const polygonEdgeResult = benchmarkPair('polygon-edge-table', {
      destination: polygonEdgeGenericDestination,
      generated: polygonEdge.generated,
      invoke(item) {
        return polygonEdge.body(runtime.jvm.jit, polygonEdge.plan,
          polygonCases[item],
          0xff000000 | Math.imul(item + 1, 0x10203),
          thread, trustedNestedEntry);
      },
    }, {
      destination: polygonEdgeOracleDestination,
      invoke(item) {
        return polygonHandwrittenRun(polygonCases[item],
          0xff000000 | Math.imul(item + 1, 0x10203), 0);
      },
    }, 1600);
    polygonEdgeResult.oracleKind = 'exact-edge-table-handwritten';

    const genericState = [
      'polygonEdgeCount:I', 'polygonEdgeLeft:I', 'polygonEdgeRight:I',
      'polygonEdgeY:I', 'polygonEdgeActiveEnd:I',
      'polygonEdgePairCursor:I', 'polygonEdgeExpiredStart:I',
    ].map((key) => runtime.classData.staticFields.get(key) | 0);
    const oracleState = [
      'count', 'left', 'right', 'y', 'activeEnd',
      'pairCursor', 'expiredStart',
    ].map((key) => oracleFields.get(key) | 0);
    if (JSON.stringify(genericState) !== JSON.stringify(oracleState) ||
        checksum(polygonEdgeGenericScratch) !==
          checksum(oracleFields.get('scratch'))) {
      throw new Error('polygon edge-table state differs from handwritten oracle');
    }

    if (process.env.JVM_DUMP_SSA_KERNEL_TARGETS === '1') {
      for (const [name, compiled] of [
        ['tiled-blit', tiled],
        ['perspective-span', perspective],
        ['bilinear-sampler', bilinear],
        ['polygon-raster', polygon],
      ]) {
        process.stderr.write(`\n/* ${name} */\n` +
          `${compiled.generated.jvmRestoringDirectPositionalSource}\n`);
      }
    }
    const sanitize = (result) => ({
      ...result,
      generated: {
        loops: result.generated.jvmStructuredLoopCount,
        rangeGuards: result.generated.jvmStructuredArrayRangeGuardCount,
        boundedIndexRanges:
          result.generated.jvmStructuredBoundedIndexRangeCount,
        scaledIndexRanges:
          result.generated.jvmStructuredScaledIndexRangeCount,
        cyclicRanges: result.generated.jvmStructuredCyclicRangeCount,
        specializedRangeAccesses:
          result.generated.jvmStructuredSpecializedArrayRangeAccessCount,
        hoistedRangeGuards:
          result.generated.jvmStructuredHoistedArrayRangeGuardCount,
        coalescedSsaCopies:
          result.generated.jvmStructuredCoalescedSsaCopyCount,
        dominatedArithmeticGuards:
          result.generated.jvmStructuredDominatedArithmeticGuardCount,
        restoringCoarseLoopDeopts:
          result.generated.jvmStructuredRestoringCoarseLoopDeoptCount,
        capturedCheckedLeafCalls:
          result.generated.jvmStructuredCapturedCheckedLeafCallCount,
        lexicalCheckedLeafCalls:
          result.generated.jvmStructuredLexicalCheckedLeafCallCount,
        lexicalCheckedLeafWrapper:
          result.generated.jvmStructuredLexicalCheckedLeafWrapper,
        fieldReadCaches: result.generated.jvmStructuredFieldReadCacheCount,
        coarseLoops: result.generated.jvmStructuredCoarseCountedLoopCount,
        nestedRuntimeCheckedLeaf:
          result.generated.jvmStructuredNestedRuntimeCheckedLeaf,
        transactionalAcyclicCheckedLeaf:
          result.generated.jvmStructuredTransactionalAcyclicCheckedLeaf,
        restoringSpillCalls:
          result.generated.jvmStructuredRestoringSpillCallCount,
        restoringSpillInlineCost:
          result.generated.jvmStructuredRestoringSpillInlineCost,
        inlinedRestoringSpills:
          result.generated.jvmStructuredInlinedRestoringSpills,
        captureFreeRestoringSpills:
          result.generated.jvmStructuredCaptureFreeRestoringSpills,
        handwrittenInstalled: Boolean(
          result.generated.jvmRestoringDirectPositionalPlan),
      },
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      node: process.version,
      results: [
        tiledResult, tiledCallerResult, perspectiveResult, bilinearResult,
        polygonResult, polygonEdgeResult,
      ].map(sanitize),
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
