// Requires AWT framework
const awtFramework = require('../../../platform/awt.js');

let frameCount = 0;
function dumpFrame(pixels, width, height) {
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
    if (process.env.JVM_EXIT_AFTER_FRAME_LIMIT === '1' && n / every + 1 >= limit) {
      // Profilers and repeatable boot benchmarks need a normal process exit so
      // V8 can flush its output. Defer until the completed frame is observable.
      setImmediate(() => process.exit(0));
    }
  } catch (e) {
    console.error(`frame dump failed: ${e.message}`);
  }
}

// A game ImageProducer (e.g. the RS-style DrawingArea) keeps its framebuffer
// as the largest int[] field on the producer object and its width/height as two
// int fields whose product is that array's usable length (allocated as
// `new int[1 + w*h]`). Recover them field-name-agnostically and expose the live
// array as a DataBufferInt-style raster so drawImage can blit/dump it.
function materializeProducerImage(imageObj) {
  const producer = imageObj._producer;
  if (!producer) return;
  // java.awt.image.MemoryImageSource is implemented by the browser JRE and
  // stores its constructor arguments directly on the host object.
  if (producer.pixels && producer.width > 0 && producer.height > 0) {
    imageObj._width = producer.width | 0;
    imageObj._height = producer.height | 0;
    imageObj._raster = { _dataBuffer: { _data: producer.pixels } };
    return;
  }
  if (!producer.fields) return;
  let pixels = null;
  const ints = [];
  for (const key of Object.keys(producer.fields)) {
    const v = producer.fields[key];
    if (Array.isArray(v) && v.type === '[I') {
      if (!pixels || v.length > pixels.length) pixels = v;
    } else if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 8192) {
      ints.push(v);
    }
  }
  if (!pixels || pixels.length < 2) return;
  const L = pixels.length;
  let w = 0, h = 0;
  // Prefer a (w,h) pair that are both actual int fields on the producer.
  for (const a of ints) {
    for (const target of [L - 1, L]) {
      if (a > 0 && target % a === 0 && ints.includes(target / a)) { w = a; h = target / a; break; }
    }
    if (w) break;
  }
  // Fallback: any factor of L-1 drawn from the int fields.
  if (!w) {
    for (const a of ints) { if (a > 1 && (L - 1) % a === 0) { w = a; h = (L - 1) / a; break; } }
  }
  if (!w || !h) return;
  imageObj._width = w;
  imageObj._height = h;
  imageObj._raster = { _dataBuffer: { _data: pixels } };
}

// Software raster for headless components: a Graphics with a _component but
// no native context paints into component._pixels so frames can be dumped.
function softSurface(jvm, obj) {
  const comp = obj._component;
  if (!comp) return null;
  const width = comp._width || 800;
  const height = comp._height || 600;
  if (!comp._pixels || comp._pixelsWidth !== width || comp._pixelsHeight !== height) {
    comp._pixels = new Array(width * height).fill(0);
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
      producerImages: 0,
      softwareBlits: 0,
    };
  }
  return jvm._awtPresentationStats;
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
  const context = canvas.getContext('2d');
  if (!context) return false;
  if (!comp._presentImageData || comp._presentImageData.width !== width ||
      comp._presentImageData.height !== height) {
    comp._presentImageData = context.createImageData(width, height);
    comp._presentPixels32 = new Uint32Array(comp._presentImageData.data.buffer);
  }
  const started = typeof performance !== 'undefined' && performance.now
    ? performance.now() : Date.now();
  const output = comp._presentPixels32;
  const count = Math.min(width * height, pixels.length);
  for (let index = 0; index < count; index += 1) {
    const rgb = Number(pixels[index]) >>> 0;
    // ImageData is RGBA bytes. On the little-endian browser platforms used by
    // Canvas, its Uint32 representation is AABBGGRR.
    output[index] = (0xff000000 | (rgb & 0xff) << 16 |
      rgb & 0xff00 | rgb >>> 16 & 0xff) >>> 0;
  }
  context.putImageData(comp._presentImageData, 0, 0);
  comp._presentedVersion = comp._pixelsVersion;
  const stats = presentationStats(jvm);
  if (stats) {
    const ended = typeof performance !== 'undefined' && performance.now
      ? performance.now() : Date.now();
    stats.presented += 1;
    stats.uploadMs += ended - started;
  }
  return true;
}

function markSoftSurfaceDirty(jvm, comp) {
  if (!comp) return;
  comp._pixelsVersion = (comp._pixelsVersion || 0) + 1;
  const stats = presentationStats(jvm);
  if (stats) stats.dirtyMarks += 1;
  if (!comp._canvasElement || typeof requestAnimationFrame !== 'function') return;
  if (comp._presentScheduled) {
    if (stats) stats.coalesced += 1;
    return;
  }
  comp._presentScheduled = true;
  if (stats) stats.scheduled += 1;
  requestAnimationFrame(() => {
    comp._presentScheduled = false;
    presentSoftSurface(jvm, comp);
  });
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

    'drawImage(Ljava/awt/Image;IILjava/awt/image/ImageObserver;)Z': (jvm, obj, args) => {
      const stats = presentationStats(jvm);
      if (stats) stats.drawImageCalls += 1;
      const graphicsContext = obj._awtGraphics;
      const imageObj = args[0];
      if (!imageObj) {
        return 0;
      }
      // An image created from the game's own ImageProducer carries a live
      // reference to that producer. Pull its current int[] framebuffer into a
      // raster so the shared blit/dump path below observes the real frame
      // (mutated in place each render), not just the fillRect background.
      if (imageObj._producer && !imageObj._raster) {
        materializeProducerImage(imageObj);
        if (stats && imageObj._raster) stats.producerImages += 1;
      }

      // Headless raster path: a BufferedImage over a DataBufferInt is the
      // game's framebuffer — record it on the target component and optionally
      // dump PNG frames (JVM_FRAME_DIR, JVM_FRAME_EVERY, JVM_FRAME_LIMIT).
      const raster = imageObj._raster;
      const pixels = raster && raster._dataBuffer && raster._dataBuffer._data;
      if (pixels && imageObj._width && imageObj._height) {
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
          if (presentedBySoftwareSurface) markSoftSurfaceDirty(jvm, target);
          if (stats && presentedBySoftwareSurface) stats.softwareBlits += 1;
        }
        dumpFrame(pixels, imageObj._width, imageObj._height);
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
