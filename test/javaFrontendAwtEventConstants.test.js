'use strict';

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const frontend = require('../src/java-frontend');
const { JVM } = require('../src/core/jvm');

// KeyEvent.VK_UP and friends used to be missing from the JRE stubs, so the
// frontend typed them as KeyEvent references and rejected `code == VK_UP`.
const SOURCE = `
  import java.awt.AWTEvent;
  import java.awt.event.InputEvent;
  import java.awt.event.KeyEvent;
  import java.awt.event.MouseEvent;

  public class AwtEventConstants {
    static int input(int code, char ch) {
      if (code == KeyEvent.VK_UP || ch == 'w') return 1;
      switch (code) {
        case KeyEvent.VK_DOWN: return 2;
        case KeyEvent.VK_SPACE: return 3;
        default: return 0;
      }
    }
    public static void main(String[] args) {
      System.out.println(input(38, 'x'));
      System.out.println(input(0, 'w'));
      System.out.println(input(40, 'x'));
      System.out.println(input(32, 'x'));
      System.out.println(input(1, 'x'));
      System.out.println(KeyEvent.KEY_PRESSED);
      System.out.println((int) KeyEvent.CHAR_UNDEFINED);
      System.out.println(MouseEvent.MOUSE_PRESSED);
      System.out.println(InputEvent.BUTTON3_MASK);
      System.out.println((int) (AWTEvent.KEY_EVENT_MASK | AWTEvent.MOUSE_EVENT_MASK));
    }
  }
`;

test('AWT event constants compile as their JDK primitive values', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-frontend-awt-constants-'));
  try {
    const result = frontend.compileJavaSource(SOURCE, { sourceFileName: 'AwtEventConstants.java', outputDir });
    t.equal(result.bytecodeIr.status, 'complete', 'the event constants lower completely');

    let output = '';
    const jvm = new JVM({ classpath: outputDir });
    jvm.registerJreMethods({
      'java/io/PrintStream': {
        'println(I)V': (jvmInstance, obj, args) => { output += `${args[0]}\n`; },
      },
    });
    await jvm.run('AwtEventConstants', { args: [] });
    // Expected values printed by HotSpot (JDK 11) for the same source.
    t.equal(output.trim(), '1\n1\n2\n3\n0\n401\n65535\n501\n4\n24', 'matches HotSpot');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  t.end();
});
