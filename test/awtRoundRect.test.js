'use strict';
const test = require('tape');
const fs = require('fs');
const path = require('path');
const { BrowserJVMDebug, javaTools } = require('../src/platform/browser-entry');
const source = fs.readFileSync(path.join(__dirname, 'fixtures/frontend/RoundedRectangles.java'), 'utf8');

test('rounded rectangles execute through Graphics and Graphics2D and paint the software raster', async t => {
  const debug = new BrowserJVMDebug();
  for (const artifact of javaTools.compileJava(source).artifacts) {
    debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
  }
  await debug.initialize();
  await debug.run('RoundedRectangles');
  const surface = debug.debugController.jvm.classes.RoundedRectangles.staticFields.get('surface:Ljava/awt/Canvas;');
  const pixel = (x, y) => surface._pixels[y * surface._width + x];
  t.equal(pixel(30, 25), 0xff0000, 'rounded fill paints the center');
  t.equal(pixel(10, 10), 0x0000ff, 'rounded fill leaves the corner untouched');
  t.equal(pixel(30, 10), 0xff0000, 'rounded fill reaches the top edge');
  t.equal(pixel(85, 25), 0x0000ff, 'outline leaves its interior untouched');
  t.equal(pixel(85, 10), 0x00ff00, 'outline paints its top edge');
  t.equal(pixel(105, 25), 0x00ff00, 'outline includes x + width');
  t.equal(pixel(85, 42), 0x00ff00, 'outline includes y + height');
  t.equal(pixel(65, 10), 0x0000ff, 'outline leaves its corner untouched');
  t.equal(pixel(30, 65), 0x80007f, 'translucent fill composites once, with clamped absolute arc diameters');
  t.equal(pixel(10, 55), 0x0000ff, 'oversized arcs remain rounded');
  t.equal(pixel(65, 55), 0xffffff, 'a zero arc diameter produces square corners');
  t.equal(pixel(95, 65), 0xffffff, 'square outline includes bottom-right edge');
  t.equal(pixel(110, 64), 0xffffff, 'zero-width outline draws a vertical line through its endpoint');
  t.equal(pixel(0, 80), 0xffffff, 'partially off-surface rounded rectangles are clipped');
  t.equal(pixel(85, 75), 0x80007f, 'translucent outline composites once on straight edges');
  t.equal(pixel(85, 80), 0x0000ff, 'translucent outline does not fill its interior');
  t.equal(pixel(0, 0), 0x0000ff, 'negative dimensions do not draw');
  t.end();
});
