'use strict';

const test = require('tape');
const {JSDOM} = require('jsdom');
const {JVM} = require('../src/core/jvm');

// A Swing program renders into the page: setVisible(true) mounts a window
// element in #awt-container, and a click on a JButton after main() returned
// still runs the guest ActionListener on the event dispatch thread.
test('Swing frame mounts in the DOM and handles clicks after main returns', async (t) => {
  const previous = {document: global.document, window: global.window};
  const dom = new JSDOM('<div id="awt-container"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  // jsdom has no 2D canvas; paintComponent then runs against a headless Graphics.
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const log = console.log;
  console.log = () => {};
  try {
    const jvm = new JVM({classpath: 'sources', prepareBeforeMain: false});
    await jvm.run('SwingCanvasSmoke');

    const frame = document.querySelector('#awt-container .jvm-swing-frame');
    t.ok(frame, 'JFrame is mounted in #awt-container');
    t.ok(frame.textContent.includes('Swing Canvas'), 'title bar shows the frame title');
    t.equal(frame.style.width, '320px', 'frame uses its setSize width');

    const button = frame.querySelector('button:not([title="Close"])');
    const label = [...frame.querySelectorAll('span')]
      .find(span => span.textContent.startsWith('Clicked'));
    t.equal(button && button.textContent, 'Done', 'JButton text reflects setText on the EDT');
    t.equal(label && label.textContent, 'Clicked Press 42', 'JLabel text reflects doClick listener');
    t.ok(frame.querySelector('canvas'), 'paintComponent override gets a canvas');

    button.click();
    const deadline = Date.now() + 5000;
    while (label.textContent !== 'Clicked Done 42' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    t.equal(label.textContent, 'Clicked Done 42', 'DOM click runs the ActionListener');
  } finally {
    console.log = log;
    Object.assign(global, previous);
    dom.window.close();
  }
  t.end();
});
