// Explicit ESM exports for browser/CDN consumers of the CommonJS implementation.
import browser from './browser-entry.js';

export const BrowserJVMDebug = browser.BrowserJVMDebug;
export const thrownValueMessage = browser.thrownValueMessage;
export const JVM = browser.JVM;
export const Frame = browser.Frame;
export const DebugController = browser.DebugController;
export const BrowserFileProvider = browser.BrowserFileProvider;
export const browserJavaTools = browser.browserJavaTools;
export const javaTools = browser.javaTools;
export const awtFramework = browser.awtFramework;
export const audioPlatform = browser.audioPlatform;
export const legacyPlatform = browser.legacyPlatform;
export const raster = browser.raster;
export default browser;
