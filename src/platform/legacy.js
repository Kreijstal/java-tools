let legacyPlatform = null;

function setLegacyPlatform(platform) {
  legacyPlatform = platform || null;
}

function getLegacyPlatform() {
  return legacyPlatform || defaultLegacyPlatform;
}

const defaultLegacyPlatform = {
  getWindowObject() {
    return null;
  },

  getDisplayModes(filter) {
    const mode = {
      width: (filter && filter.width) || 0,
      height: (filter && filter.height) || 0,
      rgbBitCount: (filter && filter.rgbBitCount) || 32,
      refreshRate: (filter && filter.refreshRate) || 0,
    };
    return [mode];
  },

  setDisplayMode(_component, mode) {
    return mode;
  },

  restoreDisplayMode() {},

  setCursor(cursor) {
    return cursor || 0;
  },

  setCursorPos(x, y) {
    return { x: x || 0, y: y || 0 };
  },

  getComponentElement(_component) {
    return null;
  },
};

module.exports = {
  getLegacyPlatform,
  setLegacyPlatform,
};
