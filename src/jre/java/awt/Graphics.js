// Requires AWT framework
const awtFramework = require('../../../platform/awt.js');

let frameCount = 0;
const COLOR_SWIZZLE_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
  0x01, 0x7f, 0x00, 0x03, 0x02, 0x01, 0x00, 0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x14, 0x02, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
  0x07, 0x73, 0x77, 0x69, 0x7a, 0x7a, 0x6c, 0x65, 0x00, 0x00, 0x0a, 0x4f,
  0x01, 0x4d, 0x01, 0x02, 0x7f, 0x02, 0x40, 0x03, 0x40, 0x20, 0x01, 0x20,
  0x00, 0x4f, 0x0d, 0x01, 0x20, 0x01, 0x41, 0x02, 0x74, 0x28, 0x02, 0x00,
  0x21, 0x02, 0x20, 0x01, 0x41, 0x02, 0x74, 0x41, 0x80, 0x80, 0x80, 0x78,
  0x20, 0x02, 0x41, 0xff, 0x01, 0x71, 0x41, 0x10, 0x74, 0x72, 0x20, 0x02,
  0x41, 0x80, 0xfe, 0x03, 0x71, 0x72, 0x20, 0x02, 0x41, 0x10, 0x76, 0x41,
  0xff, 0x01, 0x71, 0x72, 0x36, 0x02, 0x00, 0x20, 0x01, 0x41, 0x01, 0x6a,
  0x21, 0x01, 0x0c, 0x00, 0x0b, 0x0b, 0x0b,
]);
let colorSwizzleWasm;

function compileWebGlShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createWebGlPresenter(width, height, targetCanvas = null) {
  if (!targetCanvas && (typeof document === 'undefined' ||
      typeof document.createElement !== 'function')) return null;
  const canvas = targetCanvas || document.createElement('canvas');
  const direct = Boolean(targetCanvas);
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
  });
  if (!gl || typeof gl.texSubImage2D !== 'function') return null;
  const vertex = compileWebGlShader(gl, gl.VERTEX_SHADER, `
    attribute vec2 position;
    varying vec2 uv;
    void main() {
      gl_Position = vec4(position, 0.0, 1.0);
      uv = vec2((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5);
    }
  `);
  const fragment = compileWebGlShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec2 uv;
    uniform sampler2D frame;
    void main() {
      vec4 bgra = texture2D(frame, uv);
      gl_FragColor = vec4(bgra.b, bgra.g, bgra.r, 1.0);
    }
  `);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  if (!buffer || !texture) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1, 1, 1,
  ]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, 'frame'), 0);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  let textureWidth = 0;
  let textureHeight = 0;
  let sourceBuffer = null;
  let sourceOffset = -1;
  let sourceLength = -1;
  let sourceBytes = null;
  return {
    direct,
    present(targetContext, source, count, nextWidth, nextHeight) {
      if (!ArrayBuffer.isView(source) ||
          (!direct && typeof targetContext?.drawImage !== 'function')) {
        return false;
      }
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
      const byteLength = count * 4;
      if (sourceBuffer !== source.buffer || sourceOffset !== source.byteOffset ||
          sourceLength !== byteLength) {
        sourceBuffer = source.buffer;
        sourceOffset = source.byteOffset;
        sourceLength = byteLength;
        sourceBytes = new Uint8Array(sourceBuffer, sourceOffset, byteLength);
      }
      gl.viewport(0, 0, nextWidth, nextHeight);
      gl.useProgram(program);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (textureWidth !== nextWidth || textureHeight !== nextHeight) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, nextWidth, nextHeight, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, sourceBytes);
        textureWidth = nextWidth;
        textureHeight = nextHeight;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, nextWidth, nextHeight,
          gl.RGBA, gl.UNSIGNED_BYTE, sourceBytes);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.flush();
      if (!direct) {
        targetContext.drawImage(canvas, 0, 0, nextWidth, nextHeight);
      }
      return true;
    },
  };
}

function swizzleRgbToImageData(output, pixels, count) {
  const source = pixels && pixels.elements ? pixels.elements : pixels;
  // Wasm only wins when its staging copy can consume an existing typed view.
  // Converting a large JavaScript Array with Array.from().slice() allocated
  // two full framebuffer copies per presentation and caused periodic GC
  // stalls. Plain Java arrays use the single-pass output loop below instead.
  const typedSource = ArrayBuffer.isView(source) &&
    typeof source.subarray === 'function';
  if (!typedSource || count < 65536 || typeof WebAssembly === 'undefined') {
    return false;
  }
  try {
    if (colorSwizzleWasm === undefined) {
      const instance = new WebAssembly.Instance(
        new WebAssembly.Module(COLOR_SWIZZLE_WASM));
      colorSwizzleWasm = instance.exports;
    }
    if (!colorSwizzleWasm) return false;
    const requiredBytes = count * 4;
    const memory = colorSwizzleWasm.memory;
    if (memory.buffer.byteLength < requiredBytes) {
      memory.grow(Math.ceil((requiredBytes - memory.buffer.byteLength) / 65536));
    }
    const staging = new Uint32Array(memory.buffer, 0, count);
    staging.set(source.length === count ? source : source.subarray(0, count));
    colorSwizzleWasm.swizzle(count);
    output.set(staging);
    return true;
  } catch (_) {
    colorSwizzleWasm = null;
    return false;
  }
}

function dumpFrame(pixels, width, height, jvm) {
  if (typeof process === 'undefined' || !process.env || !process.env.JVM_FRAME_DIR) return;
  const every = Number(process.env.JVM_FRAME_EVERY) || 1;
  const limit = Number(process.env.JVM_FRAME_LIMIT) || 50;
  const n = frameCount++;
  if (n % every !== 0 || n / every >= limit) return;
  try {
    const fs = require('fs');
    const path = require('path');
    const { encodePng } = require('../../../io/pngEncoder');
    fs.mkdirSync(process.env.JVM_FRAME_DIR, { recursive: true });
    const file = path.join(process.env.JVM_FRAME_DIR, `frame-${String(n).padStart(5, '0')}.png`);
    fs.writeFileSync(file, encodePng(pixels, width, height));
    console.error(`[frame] +${(process.uptime()).toFixed(1)}s ${file} (${width}x${height})`);
    if (jvm && Number(process.env.JVM_PROFILE_SCHEDULER_RESET_FRAME) === n &&
        typeof jvm.resetSchedulerTimings === 'function') {
      jvm.resetSchedulerTimings();
    }
    if (process.env.JVM_EXIT_AFTER_FRAME_LIMIT === '1' && n / every + 1 >= limit) {
      // Profilers and repeatable boot benchmarks need a normal process exit so
      // V8 can flush its output. Defer until the completed frame is observable.
      setImmediate(() => {
        if (jvm && typeof jvm.dumpSchedulerTimings === 'function') {
          jvm.dumpSchedulerTimings(Number(process.env.JVM_PROFILE_SCHEDULER_LIMIT) || 30);
        }
        process.exit(0);
      });
    }
  } catch (e) {
    console.error(`frame dump failed: ${e.message}`);
  }
}

// Software raster for headless components: a Graphics with a _component but
// no native context paints into component._pixels so frames can be dumped.
function softSurface(jvm, obj) {
  const comp = obj._component;
  if (!comp) return null;
  const width = comp._width || 800;
  const height = comp._height || 600;
  if (!comp._pixels || comp._pixelsWidth !== width || comp._pixelsHeight !== height) {
    // A Java software raster is an int surface. Keeping it typed from its
    // first primitive draw also lets a complete-frame presenter consume the
    // stable bytes directly; a transient plain Array would force the visible
    // canvas into 2D mode before the first BufferedImage frame arrives.
    comp._pixels = new Int32Array(width * height);
    comp._pixelsWidth = width;
    comp._pixelsHeight = height;
  }
  if (jvm && !jvm._softCanvases) jvm._softCanvases = new Set();
  if (jvm) jvm._softCanvases.add(comp);
  return { pixels: comp._pixels, width, height };
}

function presentationStats(jvm) {
  if (!jvm) return null;
  if (!jvm._awtPresentationStats) {
    jvm._awtPresentationStats = {
      dirtyMarks: 0,
      scheduled: 0,
      coalesced: 0,
      presented: 0,
      uploadMs: 0,
      drawImageCalls: 0,
      softwareBlits: 0,
      blitCopyMs: 0,
      wasmSwizzles: 0,
      jsSwizzles: 0,
      webGlPresentations: 0,
      webGlDirectPresentations: 0,
      webGlFallbacks: 0,
      incrementalDirectPresentations: 0,
      lastCompletedAt: null,
      recentCompletionGaps: [],
      lastPresentedAt: null,
      lastPresentedCompletionAt: null,
      recentPresentationGaps: [],
      recentFrameTimings: [],
    };
  }
  return jvm._awtPresentationStats;
}

function recordPresentation(stats, completedAt = null, uploadMs = 0) {
  if (!stats) return;
  const now = typeof performance !== 'undefined' && performance.now
    ? performance.now() : Date.now();
  const presentationGapMs = stats.lastPresentedAt === null
    ? null : now - stats.lastPresentedAt;
  if (stats.lastPresentedAt !== null) {
    stats.recentPresentationGaps.push(presentationGapMs);
    if (stats.recentPresentationGaps.length > 256) {
      stats.recentPresentationGaps.shift();
    }
  }
  const completionGapMs = completedAt === null ||
      stats.lastPresentedCompletionAt === null
    ? null : completedAt - stats.lastPresentedCompletionAt;
  stats.recentFrameTimings.push({
    completedAt,
    presentedAt: now,
    completionGapMs,
    presentationGapMs,
    queueMs: completedAt === null ? null : now - completedAt,
    uploadMs,
  });
  if (stats.recentFrameTimings.length > 256) {
    stats.recentFrameTimings.shift();
  }
  if (completedAt !== null) stats.lastPresentedCompletionAt = completedAt;
  stats.lastPresentedAt = now;
  stats.presented += 1;
}

function presentSoftSurface(jvm, comp) {
  const canvas = comp && comp._canvasElement;
  const width = comp && comp._pixelsWidth;
  const height = comp && comp._pixelsHeight;
  const pixels = comp && comp._pixels;
  if (!canvas || !width || !height || !pixels ||
      typeof canvas.getContext !== 'function') return false;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    comp._presentImageData = null;
    comp._presentPixels32 = null;
  }
  const started = typeof performance !== 'undefined' && performance.now
    ? performance.now() : Date.now();
  const count = Math.min(width * height, pixels.length);
  const stats = presentationStats(jvm);
  const source = pixels && pixels.elements ? pixels.elements : pixels;
  let context = null;
  let usedWebGl = false;
  if (jvm?.awtWebGlPresentation && count === width * height &&
      ArrayBuffer.isView(source)) {
    if (comp._presentWebGl === undefined) {
      // Claim the visible canvas before any 2D context does. This publishes
      // the one complete software framebuffer directly, avoiding a second
      // full-canvas GPU-to-2D copy after the texture upload.
      comp._presentWebGl = createWebGlPresenter(width, height, canvas) || null;
    }
    try {
      if (comp._presentWebGl && comp._presentWebGl.direct !== true) {
        context = canvas.getContext('2d');
      }
      usedWebGl = Boolean(comp._presentWebGl?.present(
        context, source, count, width, height));
    } catch (_) {
      comp._presentWebGl = null;
    }

    // A canvas that was already claimed by 2D cannot also host WebGL. Keep
    // the exact prior offscreen presenter as a compatibility fallback.
    if (!usedWebGl && comp._presentWebGl === null) {
      context = context || canvas.getContext('2d');
      if (context) {
        comp._presentWebGl = createWebGlPresenter(width, height) || null;
        try {
          usedWebGl = Boolean(comp._presentWebGl?.present(
            context, source, count, width, height));
        } catch (_) {
          comp._presentWebGl = null;
        }
      }
    }
  }
  if (usedWebGl) {
    if (stats) stats.webGlPresentations += 1;
    if (stats && comp._presentWebGl?.direct === true) {
      stats.webGlDirectPresentations += 1;
    }
  } else {
    if (jvm?.awtWebGlPresentation && stats) stats.webGlFallbacks += 1;
    context = context || canvas.getContext('2d');
    if (!context) return false;
    if (!comp._presentImageData || comp._presentImageData.width !== width ||
        comp._presentImageData.height !== height) {
      comp._presentImageData = context.createImageData(width, height);
      comp._presentPixels32 = new Uint32Array(comp._presentImageData.data.buffer);
    }
    const output = comp._presentPixels32;
    const usedWasmSwizzle = swizzleRgbToImageData(output, pixels, count);
    if (usedWasmSwizzle) {
      if (stats) stats.wasmSwizzles += 1;
    } else {
      if (stats) stats.jsSwizzles += 1;
      for (let index = 0; index < count; index += 1) {
        const rgb = Number(pixels[index]) >>> 0;
        // ImageData is RGBA bytes. On little-endian browser platforms its
        // Uint32 representation is AABBGGRR.
        output[index] = (0xff000000 | (rgb & 0xff) << 16 |
          rgb & 0xff00 | rgb >>> 16 & 0xff) >>> 0;
      }
    }
    context.putImageData(comp._presentImageData, 0, 0);
  }
  comp._presentedVersion = comp._pixelsVersion;
  if (stats) {
    const ended = typeof performance !== 'undefined' && performance.now
      ? performance.now() : Date.now();
    const uploadMs = ended - started;
    recordPresentation(stats, comp._lastCompletedAt ?? null, uploadMs);
    stats.uploadMs += uploadMs;
  }
  return true;
}

function markSoftSurfaceDirty(jvm, comp, thread = null, immediate = false) {
  if (!comp) return;
  if (jvm && thread) jvm._awtFrameProducerThread = thread;
  const completedAt = typeof performance !== 'undefined' && performance.now
    ? performance.now() : Date.now();
  comp._lastCompletedAt = completedAt;
  comp._pixelsVersion = (comp._pixelsVersion || 0) + 1;
  const stats = presentationStats(jvm);
  if (stats) {
    if (stats.lastCompletedAt !== null) {
      stats.recentCompletionGaps.push(completedAt - stats.lastCompletedAt);
      if (stats.recentCompletionGaps.length > 256) {
        stats.recentCompletionGaps.shift();
      }
    }
    stats.lastCompletedAt = completedAt;
    stats.dirtyMarks += 1;
  }
  // An incremental raster change is observed only at a cooperative JVM
  // yield, after the mutating compiled region has materialized its effects.
  // Upload that stable intermediate surface now instead of waiting for a
  // requestAnimationFrame callback the browser may defer behind other task
  // queues. The scheduler follows it with one timer-task yield so the
  // browser still receives a rendering opportunity before the guest resumes.
  if (immediate && comp._canvasElement &&
      typeof requestAnimationFrame === 'function' &&
      !comp._presentScheduled && presentSoftSurface(jvm, comp)) {
    if (stats) {
      stats.scheduled += 1;
      stats.incrementalDirectPresentations += 1;
    }
    if (jvm) {
      jvm._awtIncrementalPresentationPending = false;
      jvm._awtDirectPresentationPendingYield = true;
      jvm._awtDroppedFrameBacklog = 0;
      const waiters = jvm._awtPresentationWaiters;
      if (waiters && waiters.length) {
        jvm._awtPresentationWaiters = [];
        for (let index = 0; index < waiters.length; index += 1) waiters[index]();
      }
    }
    return;
  }
  if (!comp._canvasElement || typeof requestAnimationFrame !== 'function') {
    // Headless jvm.js has no browser upload, but a completed software frame is
    // still an observable presentation boundary. Coalesce all publications in
    // one host event-loop turn, matching the browser requestAnimationFrame
    // path without imposing a timer/FPS cap or copying the framebuffer.
    if (typeof setImmediate !== 'function') return;
    if (comp._presentScheduled) {
      if (stats) stats.coalesced += 1;
      return;
    }
    comp._presentScheduled = true;
    if (stats) stats.scheduled += 1;
    setImmediate(() => {
      comp._presentScheduled = false;
      comp._presentedVersion = comp._pixelsVersion;
      recordPresentation(stats, comp._lastCompletedAt ?? null);
    });
    return;
  }
  if (comp._presentScheduled) {
    if (stats) stats.coalesced += 1;
    // A completed frame that is superseded before the host presented it is
    // raster work nobody ever sees. Publish the backlog so the scheduler can
    // give the host a rendering opportunity instead of another guest frame.
    if (jvm) {
      jvm._awtDroppedFrameBacklog = (jvm._awtDroppedFrameBacklog || 0) + 1;
    }
    return;
  }
  comp._presentScheduled = true;
  if (jvm) {
    jvm._awtPendingPresentationCount =
      (jvm._awtPendingPresentationCount || 0) + 1;
  }
  const presentationToken = (comp._presentToken || 0) + 1;
  comp._presentToken = presentationToken;
  if (stats) stats.scheduled += 1;
  const present = () => {
    if (!comp._presentScheduled || comp._presentToken !== presentationToken) {
      return;
    }
    comp._presentScheduled = false;
    if (jvm) {
      jvm._awtPendingPresentationCount = Math.max(0,
        (jvm._awtPendingPresentationCount || 0) - 1);
    }
    presentSoftSurface(jvm, comp);
    if (jvm) {
      jvm._awtDroppedFrameBacklog = 0;
      // A scheduler that parked the guest until this frame reached the screen
      // resumes here, so production is paced by presentation instead of
      // racing ahead of it.
      const waiters = jvm._awtPresentationWaiters;
      if (waiters && waiters.length) {
        jvm._awtPresentationWaiters = [];
        for (let index = 0; index < waiters.length; index += 1) waiters[index]();
      }
    }
  };
  // A browser-visible frame exists only at an animation opportunity. The JVM
  // scheduler observes _awtPendingPresentationCount and parks at its next
  // safe point, so Firefox gets that opportunity without a timer pretending
  // that an upload was displayed.
  requestAnimationFrame(present);
}

// Presents observable raster changes between guest drawImage calls. A
// catch-up scheduler can run many logic ticks (each mutating the software
// framebuffer the last present aliased) per full redraw; sampling those
// rasters at scheduler yields keeps presented fps tracking raster activity.
// Detection is workload-agnostic: rotating bounded sample sets, each phase
// compared only with its own preceding signature, so an unchanged idle
// surface never produces synthetic presentations while broad raster changes
// are detected without hashing the complete framebuffer.
function installIncrementalPresenter(jvm) {
  if (!jvm || jvm._awtPresentIntermediate) return;
  jvm._awtPresentIntermediate = () => {
    if (!jvm._softCanvases) return;
    for (const comp of jvm._softCanvases) {
      const frame = comp && comp._lastFrame;
      const pixels = frame && frame.pixels;
      const count = pixels && pixels.length;
      if (!count || comp._presentScheduled) continue;

      const phase = ((comp._incrementalSamplePhase || 0) + 1) & 7;
      comp._incrementalSamplePhase = phase;
      let signature = (count ^ phase) | 0;
      const samples = Math.min(256, count);
      const stride = Math.max(1, Math.floor(count / samples));
      let index = phase;
      for (let sample = 0; sample < samples; sample += 1) {
        signature = Math.imul(signature ^ (pixels[index % count] | 0),
          0x45d9f3b) | 0;
        index += stride;
      }
      const signatures = comp._incrementalSignatures ||
        (comp._incrementalSignatures = new Int32Array(8));
      const initialized = comp._incrementalSignatureInitialized || 0;
      const bit = 1 << phase;
      const changed = (initialized & bit) !== 0 &&
        signatures[phase] !== signature;
      signatures[phase] = signature;
      comp._incrementalSignatureInitialized = initialized | bit;
      if (!changed) continue;

      comp._pixels = pixels;
      comp._pixelsWidth = frame.width;
      comp._pixelsHeight = frame.height;
      jvm._awtIncrementalPresentationPending = true;
      markSoftSurfaceDirty(jvm, comp,
        jvm._awtFrameProducerThread || null, true);
    }
  };
}

function colorToRgb(colorObj) {
  if (!colorObj) return 0;
  const v = colorObj.value !== undefined ? colorObj.value : colorObj;
  if (typeof v === 'number') return v & 0xffffff;
  if (v && typeof v === 'object') return (((v.r & 0xff) << 16) | ((v.g & 0xff) << 8) | (v.b & 0xff));
  return 0;
}

function softFillRect(jvm, obj, x, y, w, h) {
  const surface = softSurface(jvm, obj);
  if (!surface) return;
  const rgb = obj._softColor || 0;
  const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
  const x1 = Math.min(surface.width, (x + w) | 0), y1 = Math.min(surface.height, (y + h) | 0);
  for (let yy = y0; yy < y1; yy++) {
    const row = yy * surface.width;
    for (let xx = x0; xx < x1; xx++) surface.pixels[row + xx] = rgb;
  }
  markSoftSurfaceDirty(jvm, obj._component);
}

module.exports = {
  super: 'java/lang/Object',
  isAbstract: true,
  methods: {
    // Abstract method - implementation should be in subclasses
    'drawString(Ljava/lang/String;II)V': (jvm, obj, args) => {
      // Get the native graphics context from the object
      const graphicsContext = obj._awtGraphics;

      if (graphicsContext && graphicsContext.drawString) {
        graphicsContext.drawString(args[0], args[1], args[2]);
      }
      // No fallback - rely on proper Graphics object creation
    },
    
    'setColor(Ljava/awt/Color;)V': (jvm, obj, args) => {
      const colorObj = args[0];
      obj._softColor = colorToRgb(colorObj);
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.setColor && colorObj) {
        const colorValue = (colorObj.value !== undefined) ? colorObj.value : colorObj;
        graphicsContext.setColor(colorValue);
      }
    },

    'fillRect(IIII)V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.fillRect) {
        graphicsContext.fillRect(args[0], args[1], args[2], args[3]);
        return;
      }
      softFillRect(jvm, obj, args[0], args[1], args[2], args[3]);
    },

    'drawRect(IIII)V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.drawRect) {
        graphicsContext.drawRect(args[0], args[1], args[2], args[3]);
        return;
      }
      const [x, y, w, h] = args;
      softFillRect(jvm, obj, x, y, w, 1);
      softFillRect(jvm, obj, x, y + h, w + 1, 1);
      softFillRect(jvm, obj, x, y, 1, h);
      softFillRect(jvm, obj, x + w, y, 1, h);
    },

    'drawLine(IIII)V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.drawLine) {
        graphicsContext.drawLine(args[0], args[1], args[2], args[3]);
      }
    },

    'fillOval(IIII)V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.fillOval) {
        graphicsContext.fillOval(args[0], args[1], args[2], args[3]);
      }
    },

    'fillArc(IIIIII)V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.fillArc) {
        graphicsContext.fillArc(args[0], args[1], args[2], args[3], args[4], args[5]);
      }
    },

    'drawOval(IIII)V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.drawOval) {
        graphicsContext.drawOval(args[0], args[1], args[2], args[3]);
      }
    },
    
    'setFont(Ljava/awt/Font;)V': (jvm, obj, args) => {
      const fontObj = args[0];
      if (fontObj && fontObj.value) {
        const graphicsContext = obj._awtGraphics;
        if (graphicsContext && graphicsContext.setFont) {
          graphicsContext.setFont(fontObj.value);
        }
      }
    },

    'fillPolygon([I[II)V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      const xs = args[0];
      const ys = args[1];
      const xVals = xs && xs.array ? Array.from(xs.array) : xs;
      const yVals = ys && ys.array ? Array.from(ys.array) : ys;
      if (graphicsContext && graphicsContext.fillPolygon && xVals && yVals) {
        graphicsContext.fillPolygon(xVals, yVals);
      }
    },

    'drawPolygon([I[II)V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      const xs = args[0];
      const ys = args[1];
      const xVals = xs && xs.array ? Array.from(xs.array) : xs;
      const yVals = ys && ys.array ? Array.from(ys.array) : ys;
      if (graphicsContext && graphicsContext.drawPolygon && xVals && yVals) {
        graphicsContext.drawPolygon(xVals, yVals);
      }
    },

    'drawImage(Ljava/awt/Image;IILjava/awt/image/ImageObserver;)Z': (jvm, obj, args, thread) => {
      const stats = presentationStats(jvm);
      if (stats) stats.drawImageCalls += 1;
      const graphicsContext = obj._awtGraphics;
      const imageObj = args[0];
      if (!imageObj) {
        return 0;
      }
      if (imageObj._producer && !imageObj._frameComplete) {
        return 0;
      }
      // Software raster path: publish only a complete BufferedImage or
      // ImageProducer frame and optionally dump it in headless runs.
      const raster = imageObj._raster;
      const pixels = raster && raster._dataBuffer && raster._dataBuffer._data;
      if (pixels && imageObj._width && imageObj._height) {
        if (jvm && jvm.awtIncrementalPresentation) {
          installIncrementalPresenter(jvm);
        }
        let target = obj._component;
        if (!target && graphicsContext && graphicsContext.ctx && graphicsContext.ctx.canvas) {
          const canvas = graphicsContext.ctx.canvas;
          target = obj._softComponent || {
            _width: canvas.width,
            _height: canvas.height,
            _canvasElement: canvas,
          };
          obj._softComponent = target;
        }
        let presentedBySoftwareSurface = false;
        if (target) {
          target._lastFrame = {
            pixels,
            width: imageObj._width,
            height: imageObj._height,
            x: args[1],
            y: args[2],
          };
          const dx = args[1] | 0, dy = args[2] | 0;
          const w = imageObj._width, h = imageObj._height;
          const targetWidth = target._width || 800;
          const targetHeight = target._height || 600;
          if (dx === 0 && dy === 0 && w === targetWidth && h === targetHeight &&
              pixels.length >= w * h) {
            const copyStarted = stats && typeof performance !== 'undefined' &&
              performance.now ? performance.now() : 0;
            const count = w * h;
            if (!(target._pixels instanceof Int32Array) || target._pixels.length !== count) {
              target._pixels = new Int32Array(count);
            }
            if (pixels.length === count && typeof target._pixels.set === 'function') {
              target._pixels.set(pixels);
            } else {
              for (let index = 0; index < count; index += 1) {
                target._pixels[index] = pixels[index] | 0;
              }
            }
            if (copyStarted) stats.blitCopyMs += performance.now() - copyStarted;
            target._pixelsWidth = w;
            target._pixelsHeight = h;
            if (!jvm._softCanvases) jvm._softCanvases = new Set();
            jvm._softCanvases.add(target);
            presentedBySoftwareSurface = true;
          } else {
            const surface = softSurface(jvm, obj);
            if (surface) {
              for (let yy = 0; yy < h; yy++) {
                const ty = dy + yy;
                if (ty < 0 || ty >= surface.height) continue;
                const srow = yy * w, trow = ty * surface.width;
                for (let xx = 0; xx < w; xx++) {
                  const tx = dx + xx;
                  if (tx >= 0 && tx < surface.width) {
                    surface.pixels[trow + tx] = pixels[srow + xx] & 0xffffff;
                  }
                }
              }
              presentedBySoftwareSurface = true;
            }
          }
          if (target && !target._canvasElement && jvm._awtCanvasElement) {
            target._canvasElement = jvm._awtCanvasElement;
          }
          if (presentedBySoftwareSurface) markSoftSurfaceDirty(jvm, target, thread);
          if (stats && presentedBySoftwareSurface) stats.softwareBlits += 1;
        }
        dumpFrame(pixels, imageObj._width, imageObj._height, jvm);
        if (presentedBySoftwareSurface || !graphicsContext || !graphicsContext.drawImage) {
          return 1;
        }
      }

      if (!graphicsContext || !graphicsContext.drawImage) {
        return 0;
      }
      const awtImage = imageObj._awtImage ? imageObj._awtImage : imageObj;
      return graphicsContext.drawImage(awtImage, args[1], args[2]) ? 1 : 0;
    },

    'getFontMetrics()Ljava/awt/FontMetrics;': (jvm, obj, args) => {
      return { type: 'java/awt/FontMetrics', _awtGraphics: obj._awtGraphics || null };
    },

    'getClipBounds()Ljava/awt/Rectangle;': (jvm, obj, args) => {
      return obj._clipBounds || null;
    },

    'getClip()Ljava/awt/Shape;': (jvm, obj) => obj._clip || null,

    'setClip(Ljava/awt/Shape;)V': (jvm, obj, args) => { obj._clip = args[0] || null; },

    'clipRect(IIII)V': () => {},
    
    'dispose()V': (jvm, obj, args) => {
      const graphicsContext = obj._awtGraphics;
      if (graphicsContext && graphicsContext.dispose) {
        graphicsContext.dispose();
      }
    }
  },
};
