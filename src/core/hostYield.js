'use strict';

let browserYieldChannel = null;
const browserYieldQueue = [];

// A rendering host paints between task-queue turns, so which task the JVM
// resumes from decides whether the browser ever gets a rendering opportunity.
// Node has no such distinction and keeps its immediate resumption.
function hostPaintsBetweenTasks() {
  return typeof requestAnimationFrame === "function" &&
    typeof document !== "undefined";
}

function yieldToEventLoop(delayMs = 0, strategy = "message-channel") {
  return new Promise((resolve) => {
    if (delayMs > 0) {
      setTimeout(resolve, delayMs);
    } else if (strategy === "timer" && hostPaintsBetweenTasks()) {
      // Bundled polyfills install a global setImmediate that resumes from a
      // postMessage task, which is exactly the continuously runnable queue a
      // caller asking for the timer strategy is trying to leave. Take the
      // rendering opportunity the caller asked for.
      setTimeout(resolve, 0);
    } else if (typeof setImmediate === "function" &&
        !(hostPaintsBetweenTasks() && typeof MessageChannel === "function")) {
      // Keep Node's native immediate. A browser's setImmediate is usually a
      // window.postMessage polyfill; do not let it override the explicitly
      // selected MessageChannel or route every yield through global listeners.
      setImmediate(resolve);
    } else if (strategy === "timer" || typeof MessageChannel !== "function") {
      // A timer gives the browser's rendering opportunity a task-queue
      // boundary. Firefox can otherwise keep selecting a continuously
      // replenished MessageChannel queue while requestAnimationFrame remains
      // pending, coalescing many completed guest frames without painting.
      setTimeout(resolve, 0);
    } else {
      // Browser setTimeout(0) is clamped after repeated scheduling. The JVM
      // reaches this safe point every wall-clock slice, so that clamp can
      // consume a material fraction of a render frame. MessageChannel avoids
      // that delay, but callers should select the timer strategy when their
      // browser prioritizes message tasks ahead of rendering opportunities.
      if (!browserYieldChannel) {
        browserYieldChannel = new MessageChannel();
        browserYieldChannel.port1.onmessage = () => {
          const resume = browserYieldQueue.shift();
          if (resume) resume();
        };
      }
      browserYieldQueue.push(resolve);
      browserYieldChannel.port2.postMessage(0);
    }
  });
}

module.exports = {yieldToEventLoop, hostPaintsBetweenTasks};
