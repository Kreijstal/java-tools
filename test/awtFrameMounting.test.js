'use strict';
const test = require('tape');
const { JSDOM } = require('jsdom');
const { BrowserJVMDebug, javaTools } = require('../src/platform/browser-entry');
const frameMethods = require('../src/jre/java/awt/Frame').methods;

async function runSource(source, entry) {
  const debug = new BrowserJVMDebug();
  for (const artifact of javaTools.compileJava(source).artifacts) {
    debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
  }
  await debug.initialize();
  await debug.run(entry);
  return debug.debugController.jvm;
}

function installDom() {
  const previous = { document: global.document, window: global.window };
  const dom = new JSDOM('<div id="awt-container"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  return () => { Object.assign(global, previous); dom.window.close(); };
}

test('AWT Frame mounts, sizes its Canvas, and supports hide, resize, dispose and redisplay', async t => {
  const cleanup = installDom();
  try {
    const jvm = await runSource(`import java.awt.*;
      class PaintedCanvas extends Canvas {
        public void paint(Graphics g) { g.setColor(Color.RED); g.fillRect(0, 0, getWidth(), getHeight()); }
      }
      public class FrameProbe {
        public static Frame frame;
        public static Canvas canvas;
        public static void main(String[] args) {
          frame = new Frame("Mounted AWT"); canvas = new PaintedCanvas();
          frame.add(canvas); frame.setSize(650, 390); frame.setVisible(true);
        }
      }`, 'FrameProbe');
    const fields = jvm.classes.FrameProbe.staticFields;
    const frame = fields.get('frame:Ljava/awt/Frame;');
    const canvas = fields.get('canvas:Ljava/awt/Canvas;');
    const peer = frame._awtElement;
    t.equal(peer.parentNode, document.getElementById('awt-container'), 'frame mounts in the requested host');
    t.equal(peer.getAttribute('aria-label'), 'Mounted AWT', 'frame title labels its peer');
    t.ok(peer.contains(canvas._canvasElement), 'the original child Canvas is attached');
    t.deepEqual([canvas._width, canvas._height, canvas._canvasElement.width, canvas._canvasElement.height],
      [650, 390, 650, 390], 'default BorderLayout sizes the Java component and bitmap');
    t.equal(canvas._pixels[0], 0xff0000, 'showing a frame triggers its child paint');

    await frameMethods['setVisible(Z)V'](jvm, frame, [0]);
    t.equal(peer.style.display, 'none', 'hide removes the frame from display');
    await frameMethods['setVisible(Z)V'](jvm, frame, [1]);
    t.equal(document.querySelectorAll('.jvm-awt-frame').length, 1, 'show does not duplicate the frame');
    t.equal(frame._awtElement, peer, 'show preserves peer and child identity');
    await frameMethods['setSize(II)V'](jvm, frame, [320, 180]);
    t.deepEqual([canvas._width, canvas._height, canvas._canvasElement.width, canvas._canvasElement.height],
      [320, 180, 320, 180], 'resize updates native Canvas dimensions');
    t.equal(canvas._pixels[0], 0xff0000, 'resize repaints the child');
    frameMethods['setTitle(Ljava/lang/String;)V'](jvm, frame, ['Renamed']);
    t.equal(peer.getAttribute('aria-label'), 'Renamed', 'title updates the mounted peer');
    frameMethods['dispose()V'](jvm, frame, []);
    t.equal(peer.isConnected, false, 'dispose detaches the frame');
    t.equal(frame._visible, false, 'disposed frame is hidden');
    await frameMethods['setVisible(Z)V'](jvm, frame, [1]);
    t.equal(peer.isConnected, true, 'a disposed frame can be shown again');
    t.equal(frame._disposed, false, 'redisplay realizes the frame again');
    frameMethods['dispose()V'](jvm, frame, []);
    document.getElementById('awt-container').remove();
    await frameMethods['setVisible(Z)V'](jvm, frame, [1]);
    t.equal(peer.parentNode, document.body, 'standalone pages can mount a frame in body');
  } finally { cleanup(); }
  t.end();
});

test('Frame BorderLayout honors regions and explicit gaps', async t => {
  const cleanup = installDom();
  try {
    const jvm = await runSource(`import java.awt.*;
      public class FrameRegions {
        public static Frame frame;
        public static Canvas north, west, center;
        public static void main(String[] args) {
          frame = new Frame(); frame.setLayout(new BorderLayout(4, 6));
          north = new Canvas(); north.setPreferredSize(new Dimension(1, 40));
          west = new Canvas(); west.setPreferredSize(new Dimension(70, 1));
          center = new Canvas();
          frame.add(north, BorderLayout.NORTH); frame.add(west, BorderLayout.WEST);
          frame.add(center, BorderLayout.CENTER); frame.setSize(300, 200); frame.setVisible(true);
        }
      }`, 'FrameRegions');
    const fields = jvm.classes.FrameRegions.staticFields;
    const bounds = name => { const c = fields.get(`${name}:Ljava/awt/Canvas;`); return [c._x, c._y, c._width, c._height]; };
    t.deepEqual(bounds('north'), [0, 0, 300, 40], 'north uses its preferred height');
    t.deepEqual(bounds('west'), [0, 46, 70, 154], 'west fills the remaining height');
    t.deepEqual(bounds('center'), [74, 46, 226, 154], 'center fills the remaining bounds and gaps');
  } finally { cleanup(); }
  t.end();
});

test('JFrame still creates its Swing window peer and content pane', async t => {
  const cleanup = installDom();
  try {
    const jvm = await runSource(`import javax.swing.*;
      public class SwingFrameProbe {
        public static JFrame frame;
        public static void main(String[] args) {
          frame = new JFrame("Swing still works"); frame.add(new JLabel("Content"));
          frame.setSize(320, 180); frame.setVisible(true); frame.setBounds(5, 6, 400, 220);
        }
      }`, 'SwingFrameProbe');
    const frame = jvm.classes.SwingFrameProbe.staticFields.get('frame:Ljavax/swing/JFrame;');
    t.ok(frame._awtElement.classList.contains('jvm-swing-frame'), 'Swing retains its own window peer');
    t.ok(frame._awtElement.textContent.includes('Swing still works'), 'title bar remains present');
    t.ok(frame._awtElement.textContent.includes('Content'), 'content pane remains mounted');
    t.equal(frame._awtElement.parentNode, document.getElementById('awt-container'), 'Swing host behavior is preserved');
    t.equal(frame._awtElement.style.display, 'inline-flex', 'inherited setBounds preserves Swing window layout');
    t.deepEqual([frame._awtElement.style.width, frame._awtElement.style.height], ['400px', '220px'], 'inherited setBounds still resizes Swing peers');
  } finally { cleanup(); }
  t.end();
});

test('Frame null layout preserves explicit child bounds, including children added after show', async t => {
  const cleanup = installDom();
  try {
    const jvm = await runSource(`import java.awt.*;
      public class AbsoluteFrame {
        public static Canvas child;
        public static void main(String[] args) {
          Frame frame = new Frame(); frame.setLayout(null);
          frame.setBounds(8, 10, 300, 200); frame.setVisible(true);
          child = new Canvas(); child.setBounds(12, 18, 80, 60); frame.add(child);
        }
      }`, 'AbsoluteFrame');
    const child = jvm.classes.AbsoluteFrame.staticFields.get('child:Ljava/awt/Canvas;');
    t.deepEqual([child._x, child._y, child._width, child._height], [12, 18, 80, 60], 'explicit Java geometry is retained');
    t.deepEqual([child._canvasElement.style.left, child._canvasElement.style.top], ['12px', '18px'], 'peer follows the explicit location');
    t.ok(child._canvasElement.isConnected, 'a child added after showing the frame mounts immediately');
    const peer = document.querySelector('.jvm-awt-frame');
    t.deepEqual([peer.style.left, peer.style.top], ['8px', '10px'], 'setBounds location is applied when the frame peer is created');
  } finally { cleanup(); }
  t.end();
});

test('AWT Frame does not repaint nested Swing children twice', async t => {
  const cleanup = installDom();
  try {
    const jvm = await runSource(`import java.awt.*; import javax.swing.*;
      class SwingPaintCounter extends JPanel {
        public static int paints;
        protected void paintComponent(Graphics g) { paints++; }
      }
      public class MixedFrame {
        public static void main(String[] args) {
          Frame frame = new Frame(); JPanel parent = new JPanel();
          parent.add(new SwingPaintCounter()); frame.add(parent);
          frame.setSize(300, 200); frame.setVisible(true);
        }
      }`, 'MixedFrame');
    t.equal(jvm.classes.SwingPaintCounter.staticFields.get('paints:I'), 1,
      'Swing owns recursive painting below the AWT frame');
  } finally { cleanup(); }
  t.end();
});
