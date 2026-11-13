'use strict';
const test = require('tape');
const { JSDOM } = require('jsdom');
const { BrowserJVMDebug, javaTools } = require('../src/platform/browser-entry');
const methods = require('../src/jre/java/awt/GraphicsDevice').methods;

test('headless GraphicsDevice keeps fullscreen unavailable', t => {
  t.equal(methods['isFullScreenSupported()Z'](), 0);
  t.equal(methods['isDisplayChangeSupported()Z'](), 0);
  t.deepEqual(methods['getDisplayModes()[Ljava/awt/DisplayMode;']({}), []);
  t.end();
});

test('Java fullscreen enters the browser, sizes its Canvas, restores the mode and exits', async t => {
  const previous = {window: global.window, document: global.document};
  const dom = new JSDOM('<div id="awt-container"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  let requests = 0, exits = 0;
  Object.defineProperties(document, {
    fullscreenEnabled: {value: true},
    fullscreenElement: {value: null, writable: true},
  });
  document.documentElement.requestFullscreen = async () => {
    requests++;
    document.fullscreenElement = document.documentElement;
  };
  document.exitFullscreen = async () => { exits++; document.fullscreenElement = null; };
  try {
    const debug = new BrowserJVMDebug();
    const source = `import java.awt.*;
      public class FullscreenProbe {
        public static boolean supported, active, restored;
        public static Canvas canvas;
        public static void main(String[] args) {
          GraphicsDevice device = GraphicsEnvironment.getLocalGraphicsEnvironment().getDefaultScreenDevice();
          supported = device.isFullScreenSupported();
          DisplayMode original = device.getDisplayMode();
          Frame frame = new Frame("Fullscreen probe"); canvas = new Canvas(); frame.add(canvas);
          device.setFullScreenWindow(frame);
          device.setDisplayMode(new DisplayMode(640,480,32,60));
          active = device.getFullScreenWindow() == frame && canvas.getWidth() == 640 && canvas.getHeight() == 480;
          device.setDisplayMode(original);
          restored = device.getDisplayMode() == original;
          device.setFullScreenWindow(null); frame.dispose();
        }
      }`;
    for (const artifact of javaTools.compileJava(source).artifacts) {
      debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
    }
    await debug.initialize();
    await debug.run('FullscreenProbe');
    const jvm = debug.debugController.jvm;
    const fields = jvm.classes.FullscreenProbe.staticFields;
    t.equal(fields.get('supported:Z'), 1, 'Java sees browser support');
    t.equal(fields.get('active:Z'), 1, 'fullscreen owns the original frame and resizes its Canvas');
    t.equal(fields.get('restored:Z'), 1, 'original mode identity survives restore');
    t.equal(requests, 1, 'one browser entry');
    t.equal(exits, 1, 'one browser exit');
    t.equal(methods['getFullScreenWindow()Ljava/awt/Window;'](jvm), null, 'exit clears the Java fullscreen window');

    document.documentElement.requestFullscreen = async () => { throw new Error('permission denied'); };
    for (const artifact of javaTools.compileJava(`import java.awt.*;
      public class DeniedFullscreenProbe {
        public static boolean caught;
        public static void main(String[] args) {
          try {
            GraphicsEnvironment.getLocalGraphicsEnvironment().getDefaultScreenDevice().setFullScreenWindow(new Frame());
          } catch (UnsupportedOperationException e) { caught = true; }
        }
      }`).artifacts) {
      debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
    }
    await debug.run('DeniedFullscreenProbe');
    const otherJvm = debug.debugController.jvm;
    t.equal(otherJvm.classes.DeniedFullscreenProbe.staticFields.get('caught:Z'), 1,
      'Java can catch browser permission denial and fall back');
    t.equal(methods['getFullScreenWindow()Ljava/awt/Window;'](otherJvm), null, 'failed entry leaves no fullscreen window');
    t.notEqual(methods['getDisplayMode()Ljava/awt/DisplayMode;'](otherJvm),
      methods['getDisplayMode()Ljava/awt/DisplayMode;'](jvm), 'display state is isolated between JVMs');
  } finally {
    Object.assign(global, previous);
    dom.window.close();
  }
  t.end();
});
