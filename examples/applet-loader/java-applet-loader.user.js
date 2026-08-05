// ==UserScript==
// @name         Java Applet Loader (jvm.js)
// @namespace    kreijstal.java-tools
// @version      0.2.0
// @description  Scans pages for <applet> tags and re-runs them inline in the
//               browser with jvm.js — no Java plugin, no appletviewer, no iframe.
// @author       kreijstal
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Base directory that holds applet-engine.js and jvm-debug.js.
  // The README documents window.JAVA_APPLET_BASE as the override, so honour it
  // rather than forcing every consumer to edit this file.
  const BASE = (typeof window.JAVA_APPLET_BASE === 'string' && window.JAVA_APPLET_BASE)
    ? window.JAVA_APPLET_BASE
    : 'http://localhost:3000/examples/applet-loader/';

  // jvm-debug.js is a webpack output in dist/, not next to applet-engine.js.
  const BUNDLE = (typeof window.JAVA_APPLET_BUNDLE === 'string' && window.JAVA_APPLET_BUNDLE)
    ? window.JAVA_APPLET_BUNDLE
    : 'http://localhost:3000/dist/jvm-debug.js';

  // Legacy <applet> selector plus the old object/embed variants.
  const APPLET_SELECTOR = 'applet, object[classid*="java"], embed[type*="java-applet"]';

  /**
   * Parse a single <applet> element into a launch descriptor.
   */
  function parseApplet(el) {
    const attr = (name) => el.getAttribute(name) || '';

    // <param name="x" value="y"> children. Collected first because the legacy
    // object/embed forms carry code/codebase/archive as params rather than
    // attributes -- without the fallback those elements parse to an empty
    // className and get silently skipped.
    const params = {};
    for (const p of el.querySelectorAll('param')) {
      const n = (p.getAttribute('name') || '').trim();
      const v = (p.getAttribute('value') || '').trim();
      if (n) params[n] = v;
    }
    const paramCI = (name) => {
      const key = Object.keys(params).find((k) => k.toLowerCase() === name);
      return key ? params[key] : '';
    };
    const launchField = (name) => (attr(name).trim() || paramCI(name).trim());

    const code = launchField('code');
    const codebase = launchField('codebase');
    const archive = launchField('archive');
    const width = parseInt(attr('width'), 10) || 300;
    const height = parseInt(attr('height'), 10) || 300;
    const name = attr('name').trim();

    let codebaseUrl;
    try {
      codebaseUrl = new URL(codebase || '.', location.href).href;
    } catch (_) {
      codebaseUrl = new URL('.', location.href).href;
    }
    const className = code.replace(/\.class$/i, '');

    // The applet spec defines `archive` as a comma-separated list. Splitting on
    // whitespace kept only "a.jar," from "a.jar, b.jar" -- a broken URL -- and
    // dropped every jar after the first, so applets whose classes span several
    // archives could never resolve.
    const archiveUrls = [];
    for (const nameRef of archive.split(',')) {
      const trimmed = nameRef.trim();
      if (!trimmed) continue;
      try {
        archiveUrls.push(new URL(trimmed, codebaseUrl).href);
      } catch (_) {
        // Skip the unresolvable entry, keep the rest of the list.
      }
    }

    return { el, className, codebaseUrl, archiveUrls, width, height, name, params };
  }

  // Every applet on the page shares one engine load. Checking
  // window.JavaAppletEngine per applet let two hosts both pass the check before
  // either script finished, injecting the engine twice; each copy then had its
  // own runtime cache, so applets that should have shared a JVM did not.
  let enginePromise = null;
  function ensureEngine() {
    if (window.JavaAppletEngine) return Promise.resolve();
    if (enginePromise) return enginePromise;
    enginePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = BASE + 'applet-engine.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + s.src));
      document.head.appendChild(s);
    });
    return enginePromise;
  }

  /**
   * Replace an <applet> element with an inline host div and run the applet.
   */
  function replaceApplet(desc) {
    const host = document.createElement('div');
    host.style.cssText =
      'width:' + desc.width + 'px;height:' + desc.height + 'px;' +
      'max-width:100%;overflow:hidden;background:#fff;border:1px solid #999;' +
      'position:relative;box-sizing:border-box;display:inline-block;';
    const loading = document.createElement('div');
    loading.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;' +
      'justify-content:center;font:13px system-ui,sans-serif;color:#666;' +
      'background:#f7f7f7;';
    loading.textContent = '☕ Starting ' + desc.className + ' with jvm.js…';
    host.appendChild(loading);
    desc.el.replaceWith(host);

    (async () => {
      await ensureEngine();
      await window.JavaAppletEngine.runApplet({
        container: host,
        className: desc.className,
        archiveUrls: desc.archiveUrls,
        // Keep the codebase even when archives are present: applets routinely
        // load extra classes and resources that are not inside the jars.
        codebase: desc.codebaseUrl,
        width: desc.width,
        height: desc.height,
        params: desc.params,
        // <applet name=...> is how applets on a page addressed each other
        // through AppletContext.getApplet(name).
        name: desc.name,
        base: BASE,
        bundleUrl: BUNDLE,
        onProgress: (msg) => { loading.textContent = msg; },
      });
    })().catch((err) => {
      console.error('[jvm.js applet loader]', desc.className, err);
      loading.textContent = '✗ Applet failed: ' + (err && err.message || err);
    });

    console.log('[jvm.js applet loader]', desc.className,
      desc.archiveUrls.length ? desc.archiveUrls : desc.codebaseUrl, desc.params);
  }

  // An element whose className could not be determined is left in the DOM, so
  // without this it would be re-parsed on every mutation for the page's life.
  const seen = new WeakSet();

  function scan() {
    const applets = document.querySelectorAll(APPLET_SELECTOR);
    let replaced = 0;
    for (const el of applets) {
      if (seen.has(el)) continue;
      seen.add(el);
      const desc = parseApplet(el);
      if (!desc.className) {
        console.warn('[jvm.js applet loader] skipping applet with no code attribute', el);
        continue;
      }
      replaceApplet(desc);
      replaced++;
    }
    if (replaced) {
      console.log('[jvm.js applet loader] replaced', replaced, 'applet(s)');
    }
  }

  function init() {
    setTimeout(scan, 250);
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          // Applets are usually inserted inside a container subtree rather than
          // as the added node itself, so matching only the node missed them.
          if ((node.matches && node.matches(APPLET_SELECTOR)) ||
              (node.querySelector && node.querySelector(APPLET_SELECTOR))) {
            scan();
            return;
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
