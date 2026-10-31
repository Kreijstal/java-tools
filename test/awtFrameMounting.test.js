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

test('BorderLayout dispatches inherited Java preferred-size overrides', async t => {
  const cleanup = installDom();
  try {
    const jvm = await runSource(`import java.awt.*;
      class PreferredEdge extends Canvas {
        public static int height = 35;
        public void paint(Graphics g) { g.setColor(Color.RED); g.fillRect(0, 0, getWidth(), getHeight()); }
        public Dimension getPreferredSize() {
          Dimension d = new Dimension(1, 1); d.width = 70; d.height = height; return d;
        }
      }
      class InheritedEdge extends PreferredEdge {}
      public class PreferredFrame {
        public static Frame frame;
        public static Canvas north, center;
        public static void main(String[] args) {
          frame = new Frame(); north = new InheritedEdge(); center = new Canvas();
          frame.add(north, BorderLayout.NORTH); frame.add(center);
          frame.setSize(300, 200); frame.setVisible(true);
        }
      }`, 'PreferredFrame');
    const fields = jvm.classes.PreferredFrame.staticFields;
    const north = fields.get('north:Ljava/awt/Canvas;');
    const center = fields.get('center:Ljava/awt/Canvas;');
    t.deepEqual([north._width, north._height], [300, 35], 'preferred dimensions come from Java bytecode and mutable Dimension fields');
    t.deepEqual([center._y, center._height], [35, 165], 'center uses the remaining space');
    jvm.classes.PreferredEdge.staticFields.set('height:I', 45);
    await frameMethods['doLayout()V'](jvm, fields.get('frame:Ljava/awt/Frame;'), []);
    t.equal(north._height, 45, 'explicit layout reads updated preferred dimensions');
    t.equal(north._pixels[0], 0xff0000, 'explicit layout repaints the resized Canvas');
  } finally { cleanup(); }
  t.end();
});

test('hidden BorderLayout children release space and relayout when shown after resize', async t => {
  const cleanup = installDom();
  try {
    const jvm = await runSource(`import java.awt.*;
      public class VisibilityFrame {
        public static Canvas west, center;
        public static int expandedWidth;
        public static void main(String[] args) {
          Frame frame = new Frame(); west = new Canvas(); center = new Canvas();
          west.setPreferredSize(new Dimension(70, 1));
          frame.add(west, BorderLayout.WEST); frame.add(center);
          frame.setSize(300, 200); frame.setVisible(true);
          west.setVisible(false); expandedWidth = center.getWidth();
          frame.setSize(360, 240); west.setVisible(true);
        }
      }`, 'VisibilityFrame');
    const fields = jvm.classes.VisibilityFrame.staticFields;
    const west = fields.get('west:Ljava/awt/Canvas;');
    const center = fields.get('center:Ljava/awt/Canvas;');
    t.equal(fields.get('expandedWidth:I'), 300, 'hidden west region reserves no space, matching OpenJDK');
    t.deepEqual([west._width, west._height], [70, 240], 'showing the child restores its current bounds');
    t.deepEqual([center._x, center._width], [70, 290], 'siblings relayout when the child is shown');
    t.notEqual(west._canvasElement.style.display, 'none', 'the canvas peer is visible again');
  } finally { cleanup(); }
  t.end();
});

test('Frame show restores visibility before dimensions exist and layout changes clear stale positioning', async t => {
  const cleanup = installDom();
  try {
    const jvm = await runSource(`import java.awt.*;
      public class LayoutSwitchFrame {
        public static Frame frame;
        public static Canvas child;
        public static void main(String[] args) {
          frame = new Frame(); child = new Canvas(); frame.add(child);
          frame.setVisible(true); frame.setVisible(false); frame.setVisible(true);
        }
      }`, 'LayoutSwitchFrame');
    const fields = jvm.classes.LayoutSwitchFrame.staticFields;
    const frame = fields.get('frame:Ljava/awt/Frame;');
    const child = fields.get('child:Ljava/awt/Canvas;');
    t.notEqual(frame._awtElement.style.display, 'none', 'show restores visibility without explicit dimensions');
    await frameMethods['setSize(II)V'](jvm, frame, [300, 200]);
    t.equal(child._canvasElement.style.position, 'absolute', 'BorderLayout establishes native child bounds');
    for (const type of ['java/awt/FlowLayout', 'java/awt/GridLayout']) {
      await frameMethods['setLayout(Ljava/awt/LayoutManager;)V'](jvm, frame, [{type, _rows: 1, _cols: 1}]);
      t.deepEqual([child._canvasElement.style.position, child._canvasElement.style.left, child._canvasElement.style.top], ['', '', ''], `${type} clears stale absolute positioning`);
    }
  } finally { cleanup(); }
  t.end();
});

test('Frame resolves BorderLayout aliases and re-added components use the default center', async t => {
  const cleanup = installDom();
  try {
    const jvm = await runSource(`import java.awt.*;
      public class AliasFrame {
        public static Frame frame;
        public static Canvas north, west, center;
        public static void main(String[] args) {
          frame = new Frame(); north = new Canvas(); west = new Canvas(); center = new Canvas();
          north.setPreferredSize(new Dimension(1, 25));
          west.setPreferredSize(new Dimension(40, 1));
          frame.add(north, BorderLayout.PAGE_START);
          frame.add(west, BorderLayout.LINE_START); frame.add(center);
          frame.setSize(300, 200); frame.setVisible(true);
        }
      }`, 'AliasFrame');
    const fields = jvm.classes.AliasFrame.staticFields;
    const frame = fields.get('frame:Ljava/awt/Frame;');
    const north = fields.get('north:Ljava/awt/Canvas;');
    const west = fields.get('west:Ljava/awt/Canvas;');
    const center = fields.get('center:Ljava/awt/Canvas;');
    t.deepEqual([north._x, north._y, north._width, north._height], [0, 0, 300, 25], 'PAGE_START uses the north region');
    t.deepEqual([west._x, west._y, west._width, west._height], [0, 25, 40, 175], 'LINE_START uses the left region');
    t.deepEqual([center._x, center._y, center._width, center._height], [40, 25, 260, 175], 'center respects aliases');
    await frameMethods['remove(Ljava/awt/Component;)V'](jvm, frame, [north]);
    await frameMethods['remove(Ljava/awt/Component;)V'](jvm, frame, [center]);
    await frameMethods['add(Ljava/awt/Component;)Ljava/awt/Component;'](jvm, frame, [north]);
    t.deepEqual([north._x, north._y, north._width, north._height], [40, 0, 260, 200], 're-adding without a constraint uses center');
  } finally { cleanup(); }
  t.end();
});
