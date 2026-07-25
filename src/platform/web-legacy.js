(function registerWebLegacy(global) {
  if (!global || !global.JVMDebug || !global.JVMDebug.legacyPlatform) {
    return;
  }

  const platform = {
    getWindowObject() {
      return global;
    },

    getDisplayModes(filter) {
      const screenObj = global.screen || {};
      const current = {
        width: screenObj.width || 0,
        height: screenObj.height || 0,
        rgbBitCount: screenObj.colorDepth || screenObj.pixelDepth || 32,
        refreshRate: 0,
      };
      const modes = [
        current,
        { width: 640, height: 480, rgbBitCount: current.rgbBitCount, refreshRate: 0 },
        { width: 800, height: 600, rgbBitCount: current.rgbBitCount, refreshRate: 0 },
        { width: 1024, height: 768, rgbBitCount: current.rgbBitCount, refreshRate: 0 },
      ];
      const seen = new Set();
      return modes.filter((mode) => {
        if (filter && filter.width && filter.width !== mode.width) return false;
        if (filter && filter.height && filter.height !== mode.height) return false;
        const key = `${mode.width}x${mode.height}x${mode.rgbBitCount}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },

    setDisplayMode(component, mode) {
      const element = this.getComponentElement(component);
      if (element && typeof element.requestFullscreen === "function") {
        element.requestFullscreen().catch(() => {});
      }
      return mode;
    },

    restoreDisplayMode() {
      const doc = global.document;
      if (doc && doc.fullscreenElement && doc.exitFullscreen) {
        doc.exitFullscreen().catch(() => {});
      }
    },

    setCursor(cursor) {
      const doc = global.document;
      if (doc && doc.body) {
        doc.body.style.cursor = cursorToCss(cursor || 0);
      }
      return cursor || 0;
    },

    setCursorPos(x, y) {
      return { x: x || 0, y: y || 0 };
    },

    getComponentElement(component) {
      if (!component) return null;
      return component._awtElement ||
        component._canvasElement ||
        (component._awtComponent && component._awtComponent.canvasElement) ||
        null;
    },
  };

  global.JVMDebug.legacyPlatform.setLegacyPlatform(platform);
})(typeof window !== "undefined" ? window : globalThis);

function cursorToCss(cursor) {
  switch (cursor) {
    case 32512: return "default";
    case 32513: return "text";
    case 32514: return "wait";
    case 32515: return "crosshair";
    case 32649: return "pointer";
    default: return "default";
  }
}
