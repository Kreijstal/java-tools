// ==UserScript==
// @name         Java Applet Loader (jvm.js)
// @namespace    kreijstal.java-tools
// @version      0.2.0
// @description  Scans pages for <applet> tags and re-runs them inline in the
//               browser with jvm.js — no Java plugin, no appletviewer, no iframe.
// @author       kreijstal
// @match        *://*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Base directory that holds applet-engine.js and jvm-debug.js.
  // Change to your deployed copy (or set window.JAVA_APPLET_BASE first).
  const BASE = 'http://localhost:3000/dist/';

  // Legacy <applet> selector plus the old object/embed variants.
  const APPLET_SELECTOR = 'applet, object[classid*="java"], embed[type*="java-applet"]';

  /**
   * Parse a single <applet> element into a launch descriptor.
   */
  function parseApplet(el) {
    const attr = (name) => el.getAttribute(name) || '';
    const code = attr('code').trim();
    const codebase = attr('codebase').trim();
    const archive = attr('archive').trim();
    const width = parseInt(attr('width'), 10) || 300;
    const height = parseInt(attr('height'), 10) || 300;
    const name = attr('name').trim();

    // <param name="x" value="y"> children
    const params = {};
    for (const p of el.querySelectorAll('param')) {
      const n = (p.getAttribute('name') || '').trim();
      const v = (p.getAttribute('value') || '').trim();
      if (n) params[n] = v;
    }

    let codebaseUrl;
    try {
      codebaseUrl = new URL(codebase || '.', location.href).href;
    } catch (_) {
      codebaseUrl = new URL('.', location.href).href;
    }
    const className = code.replace(/\.class$/i, '');

    let archiveUrl = null;
    if (archive) {
      const first = archive.split(/\s+/)[0];
      try {
        archiveUrl = new URL(first, codebaseUrl).href;
      } catch (_) {
        archiveUrl = null;
      }
    }

    return { el, className, codebaseUrl, archiveUrl, width, height, name, params };
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

    // Load the inline engine and run the applet directly in this page.
    const loadScript = (src) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });

    (async () => {
      if (!window.JavaAppletEngine) {
        await loadScript(BASE + 'applet-engine.js');
      }
      await window.JavaAppletEngine.runApplet({
        container: host,
        className: desc.className,
        archiveUrl: desc.archiveUrl,
        codebase: desc.archiveUrl ? null : desc.codebaseUrl,
        width: desc.width,
        height: desc.height,
        params: desc.params,
        base: BASE,
        onProgress: (msg) => { loading.textContent = msg; },
      });
    })().catch((err) => {
      console.error('[jvm.js applet loader]', desc.className, err);
      loading.textContent = '✗ Applet failed: ' + (err && err.message || err);
    });

    console.log('[jvm.js applet loader]', desc.className,
      desc.archiveUrl || desc.codebaseUrl, desc.params);
  }

  function scan() {
    const applets = document.querySelectorAll(APPLET_SELECTOR);
    for (const el of applets) {
      const desc = parseApplet(el);
      if (!desc.className) continue;
      replaceApplet(desc);
    }
    if (applets.length) {
      console.log('[jvm.js applet loader] replaced', applets.length, 'applet(s)');
    }
  }

  function init() {
    setTimeout(scan, 250);
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && node.matches && node.matches(APPLET_SELECTOR)) {
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
