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
    comp._pixels = new Array(width * height).fill(0);
    comp._pixelsWidth = width;
    comp._pixelsHeight = height;
  }
  if (jvm && !jvm._softCanvases) jvm._softCanvases = new Set();
  if (jvm) jvm._softCanvases.add(comp);
  return { pixels: comp._pixels, width, height };
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
      const graphicsContext = obj._awtGraphics;
      const imageObj = args[0];
      if (!imageObj) {
        return 0;
      }

      // Headless raster path: a BufferedImage over a DataBufferInt is the
      // game's framebuffer — record it on the target component and optionally
      // dump PNG frames (JVM_FRAME_DIR, JVM_FRAME_EVERY, JVM_FRAME_LIMIT).
      const raster = imageObj._raster;
      const pixels = raster && raster._dataBuffer && raster._dataBuffer._data;
      if (pixels && imageObj._width && imageObj._height) {
        const target = obj._component;
        if (target) {
          target._lastFrame = {
            pixels,
            width: imageObj._width,
            height: imageObj._height,
            x: args[1],
            y: args[2],
          };
          const surface = softSurface(jvm, obj);
          if (surface) {
            const dx = args[1] | 0, dy = args[2] | 0;
            const w = imageObj._width, h = imageObj._height;
            for (let yy = 0; yy < h; yy++) {
              const ty = dy + yy;
              if (ty < 0 || ty >= surface.height) continue;
              const srow = yy * w, trow = ty * surface.width;
              for (let xx = 0; xx < w; xx++) {
                const tx = dx + xx;
                if (tx >= 0 && tx < surface.width) surface.pixels[trow + tx] = pixels[srow + xx] & 0xffffff;
              }
            }
          }
        }
        dumpFrame(pixels, imageObj._width, imageObj._height);
        if (!graphicsContext || !graphicsContext.drawImage) {
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
