/*!
 * Java Applet Engine (jvm.js) — runs a classic <applet> inline in the page.
 *
 * Loads the jvm.js browser bundle, fetches the applet's jar/zip archive (or
 * its .class files from a codebase), instantiates the applet, and attaches
 * the rendered canvas directly to the host page — no iframe, so no CORS
 * isolation issues.
 *
 * Usage:
 *   <script src="applet-engine.js"></script>
 *   <script>
 *     JavaAppletEngine.runApplet({
 *       container: document.getElementById('applet-host'),
 *       className: 'MyApplet',
 *       codebase: 'http://host/path/to/classes/',   // and/or archives:
 *       archiveUrls: ['http://host/applet.jar'],
 *       width: 710, height: 400,
 *       params: { foo: 'bar' },                     // applet parameters
 *       bundleUrl: '/dist/jvm-debug.js',            // optional
 *       onProgress: (msg) => { ... }                // optional
 *     });
 *   </script>
 */
(function (global) {
  'use strict';

  // Directory that holds jvm-debug.js. Override by setting
  // window.JAVA_APPLET_BASE before including this script.
  const DEFAULT_BASE =
    (typeof global.JAVA_APPLET_BASE !== 'undefined' && global.JAVA_APPLET_BASE)
      ? global.JAVA_APPLET_BASE
      : '';

  let depsPromise = null;

  function loadScript(src, integrity) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      // Third-party CDN code runs with full page privileges here, so pin it.
      if (integrity) {
        s.integrity = integrity;
        s.crossOrigin = 'anonymous';
        s.referrerPolicy = 'no-referrer';
      }
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensureDeps(bundleUrl) {
    if (depsPromise) return depsPromise;
    depsPromise = (async () => {
      if (!global.JSZip) {
        await loadScript(
          'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
          'sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg==');
      }
      if (!global.JVMDebug) {
        await loadScript(bundleUrl);
      }
    })();
    return depsPromise;
  }

  // Minimal styling for the inlined applet surface.
  function injectStyles() {
    if (document.getElementById('jvmjs-applet-styles')) return;
    const style = document.createElement('style');
    style.id = 'jvmjs-applet-styles';
    style.textContent =
      '.jvmjs-applet-host { position: relative; overflow: hidden; background: #fff; ' +
      '  border: 1px solid #999; box-sizing: border-box; }' +
      '.jvmjs-applet-host .awt-applet-root { position: relative; z-index: 0; ' +
      '  width: 100%; height: 100%; overflow: hidden; background: #fff; }' +
      '.jvmjs-applet-host .awt-applet-root canvas { image-rendering: pixelated; }' +
      '.jvmjs-applet-host .jvmjs-applet-loading { position: absolute; inset: 0; ' +
      '  display: flex; align-items: center; justify-content: center; ' +
      '  font: 13px system-ui, sans-serif; color: #666; background: #f7f7f7; }';
    document.head.appendChild(style);
  }

  // Fetch a jar/zip archive and unpack its classes into the virtual filesystem.
  async function loadArchive(debug, archiveUrl) {
    const resp = await fetch(archiveUrl);
    if (!resp.ok) throw new Error('Archive request failed: HTTP ' + resp.status);
    const zip = new global.JSZip();
    await zip.loadAsync(new Uint8Array(await resp.arrayBuffer()));
    let count = 0;
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir || !path.endsWith('.class')) continue;
      const norm = path.replace(/\\/g, '/');
      debug.fileProvider.virtualFS.set(norm, await entry.async('uint8array'));
      count++;
    }
    return count;
  }

  // Fetch <Class>.class from a codebase on demand (the classic applet form:
  // <applet code="MyApplet.class" codebase="..."> with no archive).
  function installCodebaseLoader(debug, jvm, codebase) {
    const base = codebase.endsWith('/') ? codebase : codebase + '/';
    const orig = jvm.loadClassByName.bind(jvm);
    // Misses are cached so a class the codebase does not host is not re-fetched
    // on every resolution attempt -- JRE-internal lookups miss constantly.
    const missing = new Set();
    jvm.loadClassByName = async (className) => {
      // orig may throw synchronously, in which case .catch() is not on the
      // return value at all and the rejection escapes.
      const local = await Promise.resolve()
        .then(() => orig(className))
        .catch(() => null);
      if (local && local.ast) return local;
      const slash = String(className).replace(/\./g, '/');
      if (missing.has(slash)) return null;
      try {
        const resp = await fetch(base + slash + '.class');
        if (!resp.ok) { missing.add(slash); return null; }
        debug.fileProvider.virtualFS.set(slash + '.class',
          new Uint8Array(await resp.arrayBuffer()));
        return await orig(className);
      } catch (_) {
        return null;
      }
    };
  }

  // Keep each canvas buffer matched to its laid-out size so drawImage blits
  // at 1:1 (real AWT behaviour, no letterboxing/distortion).
  //
  // Assigning canvas.width/height clears the canvas, and this runs on a timer,
  // so it must only fire when the size genuinely changed -- otherwise it blanks
  // the applet between paints. Sub-pixel layout jitter is ignored for the same
  // reason.
  function syncCanvasBuffers(host) {
    host.querySelectorAll('canvas').forEach((c) => {
      const w = Math.round(c.clientWidth || c.offsetWidth);
      const h = Math.round(c.clientHeight || c.offsetHeight);
      if (w > 0 && h > 0 && (c.width !== w || c.height !== h)) {
        c.width = w;
        c.height = h;
      }
    });
  }

  async function runApplet(options) {
    const {
      container,
      className,
      archiveUrl = null,
      archiveUrls = null,
      codebase = null,
      width = 800,
      height = 600,
      params = {},
      base = DEFAULT_BASE,
      // jvm-debug.js is a webpack output in dist/ while applet-engine.js is
      // checked in under examples/applet-loader/, so a single base directory
      // cannot locate both. Callers serving them together can ignore this.
      bundleUrl = base + 'jvm-debug.js',
      onProgress = () => {},
    } = options || {};

    if (!container) throw new Error('runApplet: container is required');
    if (!className) throw new Error('runApplet: className is required');

    injectStyles();
    container.classList.add('jvmjs-applet-host');
    container.style.width = width + 'px';
    container.style.height = height + 'px';
    container.style.maxWidth = '100%';

    const loading = document.createElement('div');
    loading.className = 'jvmjs-applet-loading';
    loading.textContent = '☕ Starting ' + className + ' with jvm.js…';
    container.appendChild(loading);

    onProgress('Loading the jvm.js runtime…');
    await ensureDeps(bundleUrl);
    if (!global.JVMDebug || !global.JVMDebug.BrowserJVMDebug) {
      throw new Error('jvm.js bundle not available at ' + bundleUrl);
    }
    global.JSZip = global.JSZip || global.window.JSZip;

    const debug = new global.JVMDebug.BrowserJVMDebug();
    global.jvmDebug = debug;
    debug.debugController.options.appletParameters = params;
    if (codebase) debug.debugController.options.appletCodeBase = codebase;

    onProgress('Initializing the browser JVM…');
    await debug.initialize();

    const jvm = debug.debugController.jvm;
    jvm._appletWidth = width;
    jvm._appletHeight = height;
    jvm.appletParameters = Object.keys(params).length ? params : null;
    if (codebase) jvm.appletCodeBase = codebase;

    // archiveUrl (singular) is kept for direct callers; the loader passes the
    // full comma-separated list from the applet tag's archive attribute.
    const archives = archiveUrls && archiveUrls.length
      ? archiveUrls
      : (archiveUrl ? [archiveUrl] : []);

    if (!archives.length && !codebase) {
      throw new Error('runApplet: provide archiveUrls/archiveUrl or codebase');
    }

    for (const url of archives) {
      onProgress('Downloading ' + url + '…');
      const n = await loadArchive(debug, url);
      onProgress('Loaded ' + n + ' classes from ' + url + '.');
    }

    // A codebase is still useful alongside archives: applets routinely pull
    // classes and resources that were never packed into the jars.
    if (codebase) installCodebaseLoader(debug, jvm, codebase);

    onProgress('Resolving ' + className + '…');
    const classData = await Promise.resolve(jvm.loadClassByName(className)).catch(() => null);
    if (!classData || !classData.ast) {
      throw new Error('Could not load ' + className + ' from ' +
        (archives.length ? archives.join(', ') : codebase));
    }

    onProgress('Starting ' + className + '…');
    // Real applets run indefinitely (their own threads), so do not await.
    jvm.run(className).catch((err) => {
      console.error('[jvm.js applet]', err);
      loading.textContent = '✗ Applet failed: ' + (err && err.message || err);
    });

    // Once the applet's canvas exists, move it into the host.
    //
    // document.querySelector('.awt-applet-root') matched the FIRST root in the
    // document, so on a page with two applets the second engine instance stole
    // the first one's canvas and the first host stayed stuck on its loading
    // message. Claim only roots that no host has adopted yet.
    const started = Date.now();
    const watch = setInterval(() => {
      if (!container.querySelector('.awt-applet-root')) {
        const roots = document.querySelectorAll('.awt-applet-root');
        for (const root of roots) {
          if (root.closest('.jvmjs-applet-host')) continue;
          container.appendChild(root);
          loading.remove();
          break;
        }
      }
      syncCanvasBuffers(container);
      if (Date.now() - started > 60000) clearInterval(watch);
    }, 100);

    return debug;
  }

  global.JavaAppletEngine = { runApplet };
})(window);
