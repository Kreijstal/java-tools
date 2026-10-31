'use strict';
const test = require('tape');
const fs = require('fs');
const path = require('path');
const { tokenizeJava } = require('../src/java-frontend/lexer');
const { BrowserJVMDebug, javaTools } = require('../src/platform/browser-entry');

test('leading-dot floating literals are single tokens without consuming member access or varargs', t => {
  const { tokens, diagnostics } = tokenizeJava('.35 .5f .012D .5e-2 -.25 .0_5 object.field String... args');
  t.deepEqual(diagnostics, [], 'no lexical errors');
  t.deepEqual(tokens.filter(token => token.kind === 'number').map(token => token.text),
    ['.35', '.5f', '.012D', '.5e-2', '.25', '.0_5'], 'decimal, suffix, exponent and underscore forms stay intact');
  t.ok(tokens.some(token => token.text === '.' && token.kind !== 'number'), 'member access stays a dot');
  t.ok(tokens.some(token => token.text === '...'), 'varargs stays an ellipsis');
  t.end();
});

test('leading-dot literals and RGB/alpha accessors compile and execute through the Graphics2D hierarchy', async t => {
  const source = `import java.awt.*;
    public class FloatingAwt {
      public static double value;
      public static float fraction;
      public static int red, green, blue, alpha, packed;
      public static boolean isGraphics2D, imageIsGraphics2D, rejectsInvalidAlpha;
      public static void main(String[] args) {
        value = .35;
        value += .5;
        value -= .5e-2;
        fraction = .012f;
        Color c = new Color(54, 124, 223, 165);
        red = c.getRed(); green = c.getGreen(); blue = c.getBlue();
        alpha = c.getAlpha(); packed = c.getRGB();
        Graphics graphics = new Canvas().getGraphics();
        isGraphics2D = graphics instanceof Graphics2D;
        Graphics2D g2 = (Graphics2D) graphics;
        g2.setColor(c);
        Graphics imageGraphics = new Canvas().createImage(2, 1).getGraphics();
        imageIsGraphics2D = imageGraphics instanceof Graphics2D;
        Graphics2D imageContext = (Graphics2D) imageGraphics;
        imageContext.setColor(c);
        try { new Color(1, 2, 3, 256); }
        catch (IllegalArgumentException expected) { rejectsInvalidAlpha = true; }
      }
    }`;
  const debug = new BrowserJVMDebug();
  for (const artifact of javaTools.compileJava(source).artifacts) {
    debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
  }
  await debug.initialize();
  await debug.run('FloatingAwt');
  const fields = debug.debugController.jvm.classes.FloatingAwt.staticFields;
  t.ok(Math.abs(fields.get('value:D') - .845) < 1e-12, 'double literals retain their values');
  t.equal(fields.get('fraction:F'), Math.fround(.012), 'float suffix retains float precision');
  t.deepEqual(['red', 'green', 'blue', 'alpha'].map(name => fields.get(`${name}:I`)), [54, 124, 223, 165], 'color channels round-trip');
  t.equal(fields.get('packed:I'), (165 << 24) | (54 << 16) | (124 << 8) | 223, 'packed ARGB retains alpha');
  t.equal(fields.get('isGraphics2D:Z'), 1, 'the returned context is a Graphics2D');
  t.equal(fields.get('imageIsGraphics2D:Z'), 1, 'image graphics can be cast to Graphics2D');
  t.equal(fields.get('rejectsInvalidAlpha:Z'), 1, 'out-of-range alpha throws the Java exception');
  t.end();
});

test('the unchanged software cube source compiles', t => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/frontend/Cube3D.java'), 'utf8');
  const result = javaTools.compileJava(source);
  t.deepEqual(result.artifacts.map(artifact => artifact.internalName), ['Cube3D'], 'the original source emits Cube3D');
  t.ok(result.artifacts[0].bytes.length > 0, 'bytecode is assembled');
  t.end();
});

test('malformed leading-dot literals are rejected before bytecode generation', t => {
  for (const literal of ['.5p+2', '.5L', '.5e', '.5_', '.5fgarbage']) {
    t.throws(() => javaTools.compileJava(`class Invalid { double value = ${literal}; }`),
      error => error.code === 'JAVA_INVALID_FLOAT_LITERAL' && Boolean(error.range),
      `${literal} has a located lexical error`);
  }
  t.end();
});

test('software fills composite alpha, and Swing painting receives Graphics2D', async t => {
  const source = `import java.awt.*; import javax.swing.*;
    class PaintPanel extends JPanel {
      public static boolean received2D;
      protected void paintComponent(Graphics graphics) {
        Graphics2D g = (Graphics2D) graphics;
        received2D = true;
        g.setColor(new Color(255, 0, 0, 128));
        g.fillRect(0, 0, 1, 1);
      }
    }
    public class SoftwareAlpha {
      public static Canvas surface;
      public static PaintPanel panel;
      public static void main(String[] args) {
        surface = new Canvas(); surface.setSize(2, 1);
        Graphics2D g = (Graphics2D)surface.getGraphics();
        g.setColor(new Color(0, 0, 255)); g.fillRect(0, 0, 2, 1);
        g.setColor(new Color(255, 0, 0, 128)); g.fillRect(0, 0, 1, 1);
        g.setColor(new Color(0, 255, 0, 0)); g.fillRect(0, 0, 2, 1);
        panel = new PaintPanel(); panel.setSize(2, 1); panel.repaint();
      }
    }`;
  const debug = new BrowserJVMDebug();
  for (const artifact of javaTools.compileJava(source).artifacts) {
    debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
  }
  await debug.initialize();
  await debug.run('SoftwareAlpha');
  const fields = debug.debugController.jvm.classes.SoftwareAlpha.staticFields;
  t.deepEqual(Array.from(fields.get('surface:Ljava/awt/Canvas;')._pixels), [0x80007f, 0xff],
    'source-over blends translucent red over blue and ignores fully transparent green');
  t.equal(debug.debugController.jvm.classes.PaintPanel.staticFields.get('received2D:Z'), 1,
    'Swing paintComponent can cast its context to Graphics2D');
  t.equal(fields.get('panel:LPaintPanel;')._pixels[0], 0x800000,
    'Swing translucent fill blends over its opaque black software surface');
  t.end();
});
