#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { firefox } = require("playwright");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "benchmarks", "JavaPcmPushDiagnostic.java");
const bundle = path.join(root, "dist", "jvm-debug.js");
const webAudio = path.join(root, "dist", "web-audio.js");
const seconds = positiveInteger(process.env.JAVA_PCM_SECONDS || "3");
const executablePath = process.env.FIREFOX_EXECUTABLE_PATH;

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("JAVA_PCM_SECONDS must be a positive integer");
  }
  return parsed;
}

function compileFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jvm-java-pcm-"));
  execFileSync("javac", ["-source", "8", "-target", "8", "-d", directory, source],
    { stdio: ["ignore", "ignore", "pipe"] });
  const jar = path.join(directory, "java-pcm-diagnostic.jar");
  execFileSync("jar", ["cf", jar, "-C", directory, "JavaPcmPushDiagnostic.class"]);
  return { directory, jar };
}

function startAssetServer() {
  const server = http.createServer((request, response) => {
    if (request.url === "/jvm-debug.js") {
      response.writeHead(200, {"Content-Type": "text/javascript"});
      fs.createReadStream(bundle).pipe(response);
      return;
    }
    if (request.url === "/web-audio.js") {
      response.writeHead(200, {"Content-Type": "text/javascript"});
      fs.createReadStream(webAudio).pipe(response);
      return;
    }
    response.writeHead(200, {"Content-Type": "text/html"});
    response.end(
      "<button id=\"unlock\">Run Java PCM</button>" +
      "<script src=\"/jvm-debug.js\"></script>" +
      "<script src=\"/web-audio.js\"></script>");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

(async () => {
  for (const file of [bundle, webAudio]) {
    if (!fs.existsSync(file)) throw new Error(`${file} is missing; run npm run build first`);
  }
  const fixture = compileFixture();
  const assets = await startAssetServer();
  const options = { headless: true };
  if (executablePath) options.executablePath = executablePath;
  let browser;
  try {
    browser = await firefox.launch(options);
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.stack || error.message));
    await page.goto(assets.url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.JVMDebug && window.JVMDebug.audioPlatform);
    const encoded = fs.readFileSync(fixture.jar).toString("base64");
    await page.evaluate(async jarBase64 => {
      const bytes = Uint8Array.from(atob(jarBase64), character => character.charCodeAt(0));
      window.pcmDebug = new JVMDebug.BrowserJVMDebug();
      await window.pcmDebug.initialize();
      await window.pcmDebug.loadFile(new File(
        [bytes], "java-pcm-diagnostic.jar", { type: "application/java-archive" }));
    }, encoded);
    await page.click("#unlock");
    const startedAt = Date.now();
    await page.evaluate(value => {
      window.pcmRun = { state: "running" };
      window.pcmDebug.run("JavaPcmPushDiagnostic", { args: [String(value)] }).then(
        () => { window.pcmRun = { state: "completed" }; },
        error => {
          window.pcmRun = {
            state: "failed",
            error: String(error && (error.stack || error.message) || error),
          };
        },
      );
    }, seconds);
    await page.waitForFunction(() => window.pcmRun && window.pcmRun.state !== "running",
      null, { timeout: (seconds + 20) * 1000 });
    const raw = await page.evaluate(() => {
      const jvm = window.pcmDebug.debugController.jvm;
      const fields = jvm.classes.JavaPcmPushDiagnostic.staticFields;
      const field = (name, descriptor) => fields.get(`${name}:${descriptor}`);
      return {
        run: window.pcmRun,
        generationNanos: String(field("generationNanos", "J")),
        writeNanos: String(field("writeNanos", "J")),
        waitNanos: String(field("waitNanos", "J")),
        pushNanos: String(field("pushNanos", "J")),
        drainNanos: String(field("drainNanos", "J")),
        targetFrames: field("targetFrames", "I") | 0,
        writtenFrames: field("writtenFrames", "I") | 0,
        writtenBytes: field("writtenBytes", "I") | 0,
        writes: field("writes", "I") | 0,
        blockedPolls: field("blockedPolls", "I") | 0,
        checksum: field("checksum", "I") | 0,
        error: field("error", "I") | 0,
        done: field("done", "I") | 0,
        audio: JVMDebug.audioPlatform.getWebAudioDiagnostics(),
      };
    });
    const pushMs = Number(raw.pushNanos) / 1e6;
    const result = {
      browser: await page.evaluate(() => navigator.userAgent),
      requestedSeconds: seconds,
      wallTimeMs: Date.now() - startedAt,
      ...raw,
      generationMs: Number(raw.generationNanos) / 1e6,
      bridgeWriteMs: Number(raw.writeNanos) / 1e6,
      backpressureWaitMs: Number(raw.waitNanos) / 1e6,
      pushMs,
      drainMs: Number(raw.drainNanos) / 1e6,
      audioSeconds: raw.writtenFrames / 22050,
      audioSecondsPerPushSecond:
        (raw.writtenFrames / 22050) / (pushMs / 1000),
      errors,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (raw.run.state !== "completed" || raw.error || !raw.done ||
        raw.writtenFrames !== raw.targetFrames || errors.length) {
      process.exitCode = 1;
    }
  } finally {
    if (browser) await browser.close();
    await assets.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
