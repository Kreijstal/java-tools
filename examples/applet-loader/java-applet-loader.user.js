// ==UserScript==
// @name         Java Applet Loader (jvm.js)
// @namespace    kreijstal.java-tools
// @version      0.1.0
// @description  Scans pages for <applet> tags and re-runs them in the browser
//               with jvm.js — no Java plugin, no appletviewer.
// @author       kreijstal
// @match        *://*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Where the applet viewer lives. Change this to your deployed copy.
  const VIEWER_URL = 'http://localhost:3000/dist/applet-viewer.html';

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

    const pageUrl = location.href;
    // Resolve codebase relative to the page (defaults to the page's dir).
    let codebaseUrl;
    try {
      codebaseUrl = new URL(codebase || '.', pageUrl).href;
    } catch (_) {
      codebaseUrl = new URL('.', pageUrl).href;
    }
    // The applet class name (code may be "Kite" or "Kite.class").
    const className = code.replace(/\.class$/i, '');

    let archiveUrl = null;
    if (archive) {
      // Multiple archives are space-separated; take the first.
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
   * Build the viewer URL for a descriptor.
   */
  function buildViewerUrl(desc) {
    const q = new URLSearchParams();
    q.set('class', desc.className);
    q.set('w', String(desc.width));
    q.set('h', String(desc.height));
    q.set('embed', '1');
    if (desc.name) q.set('name', desc.name);
    if (desc.archiveUrl) {
      q.set('url', desc.archiveUrl);
    } else {
      q.set('codebase', desc.codebaseUrl);
    }
    for (const [k, v] of Object.entries(desc.params)) {
      q.set(k, v);
    }
    return VIEWER_URL + '?' + q.toString();
  }

  /**
   * Replace an <applet> element with the jvm.js viewer iframe.
   */
  function replaceApplet(desc) {
    const frame = document.createElement('iframe');
    frame.src = buildViewerUrl(desc);
    frame.width = String(desc.width);
    frame.height = String(desc.height);
    frame.style.border = '1px solid #999';
    frame.style.maxWidth = '100%';
    frame.setAttribute('scrolling', 'no');

    const placeholder = document.createElement('div');
    placeholder.style.cssText =
      'font: 12px system-ui, sans-serif; color: #666; padding: 8px;' +
      ' background: #f6f6f6; border: 1px dashed #bbb; margin-bottom: 8px;';
    placeholder.textContent = '☕ Re-running applet ' +
      (desc.className || '?') + ' with jvm.js…';

    desc.el.replaceWith(placeholder, frame);
    console.log('[jvm.js applet loader]', desc.className,
      desc.archiveUrl || desc.codebaseUrl,
      desc.params);
  }

  function scan() {
    const applets = document.querySelectorAll(APPLET_SELECTOR);
    for (const el of applets) {
      const desc = parseApplet(el);
      if (!desc.className) continue; // not a real applet tag
      replaceApplet(desc);
    }
    if (applets.length) {
      console.log('[jvm.js applet loader] replaced', applets.length, 'applet(s)');
    }
  }

  // Run after the DOM settles; also re-scan when the page mutates.
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
