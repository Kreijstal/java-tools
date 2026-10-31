#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const moduleUrl = process.argv[2];
assert.ok(moduleUrl, 'Usage: node scripts/test-browser-cdn.mjs <module-url>');
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<div id="awt-container" style="position:relative;width:800px;height:600px"></div>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const launchOptions = {};
if (process.env.BROWSER_EXECUTABLE_PATH) launchOptions.executablePath = process.env.BROWSER_EXECUTABLE_PATH;
if (process.env.HTTPS_PROXY) {
  const proxy = new URL(process.env.HTTPS_PROXY);
  launchOptions.proxy = {
    server: proxy.origin,
    bypass: ['127.0.0.1', process.env.NO_PROXY, process.env.no_proxy].filter(Boolean).join(','),
    username: decodeURIComponent(proxy.username),
    password: decodeURIComponent(proxy.password),
  };
}
let browser;
try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ ignoreHTTPSErrors: process.env.BROWSER_IGNORE_HTTPS_ERRORS === '1' });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const evaluation = page.evaluate(async url => {
    const { BrowserJVMDebug, javaTools } = await import(url);
    const debug = new BrowserJVMDebug();
    const compile = source => {
      const compiled = javaTools.compileJava(source);
      for (const artifact of compiled.artifacts) {
        debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
      }
    };
    compile('public class CdnSmoke { public static int value = 6 * 7; public static void main(String[] args) {} }');
    await debug.initialize();
    await debug.run('CdnSmoke');
    const value = debug.debugController.jvm.classes.CdnSmoke.staticFields.get('value:I');
    compile(`import java.applet.Applet;
      import java.awt.Color;
      import java.awt.Graphics;
      public class CdnCircle extends Applet {
        public void paint(Graphics g) {
          g.setColor(Color.RED);
          g.fillOval(10, 10, 80, 80);
        }
      }`);
    const launch = await debug.getClassLaunchInfo('CdnCircle');
    await debug.run('CdnCircle');
    const canvas = document.querySelector('#awt-container canvas');
    return { value, launchMode: launch.launchMode,
      pixel: Array.from(canvas.getContext('2d').getImageData(50, 50, 1, 1).data) };
  }, moduleUrl);
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('CDN smoke test timed out after 120 seconds')), 120_000);
  });
  const result = await Promise.race([evaluation, deadline]).finally(() => clearTimeout(timer));
  assert.equal(result.value, 42);
  assert.equal(result.launchMode, 'applet');
  assert.deepEqual(result.pixel, [255, 0, 0, 255]);
  console.log('CDN import, in-browser Java compilation, JVM execution and applet painting passed.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
