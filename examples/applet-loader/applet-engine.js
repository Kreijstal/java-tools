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
 *       className: 'Kite',
 *       codebase: 'http://host/path/to/classes/',   // or archiveUrl:
 *       archiveUrl: 'http://host/applet.jar',
 *       width: 710, height: 400,
 *       params: { foo: 'bar' },                     // applet parameters
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

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensureDeps(base) {
    if (depsPromise) return depsPromise;
    depsPromise = (async () => {
      if (!global.JSZip) {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
      }
      if (!global.JVMDebug) {
        await loadScript(base + 'jvm-debug.js');
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
  // <applet code="Kite.class" codebase="..."> with no archive).
  function installCodebaseLoader(debug, jvm, codebase) {
    const base = codebase.endsWith('/') ? codebase : codebase + '/';
    const orig = jvm.loadClassByName.bind(jvm);
    jvm.loadClassByName = async (className) => {
      const local = await orig(className).catch(() => null);
      if (local && local.ast) return local;
      const slash = String(className).replace(/\./g, '/');
      try {
        const resp = await fetch(base + slash + '.class');
        if (!resp.ok) return null;
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
  function syncCanvasBuffers(host) {
    host.querySelectorAll('canvas').forEach((c) => {
      const w = c.clientWidth || c.offsetWidth;
      const h = c.clientHeight || c.offsetHeight;
      if (w > 0 && h > 0 && (Math.abs(c.width - w) > 1 || Math.abs(c.height - h) > 1)) {
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
      codebase = null,
      width = 800,
      height = 600,
      params = {},
      base = DEFAULT_BASE,
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
    await ensureDeps(base);
    if (!global.JVMDebug || !global.JVMDebug.BrowserJVMDebug) {
      throw new Error('jvm.js bundle not available at ' + base);
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

    if (archiveUrl) {
      onProgress('Downloading ' + archiveUrl + '…');
      const n = await loadArchive(debug, archiveUrl);
      onProgress('Loaded ' + n + ' classes.');
    } else if (codebase) {
      onProgress('Resolving ' + className + ' from ' + codebase + '…');
      installCodebaseLoader(debug, jvm, codebase);
      const classData = await jvm.loadClassByName(className).catch(() => null);
      if (!classData || !classData.ast) {
        throw new Error('Could not load ' + className + ' from ' + codebase);
      }
    } else {
      throw new Error('runApplet: provide archiveUrl or codebase');
    }

    onProgress('Starting ' + className + '…');
    // Real applets run indefinitely (their own threads), so do not await.
    jvm.run(className).catch((err) => {
      console.error('[jvm.js applet]', err);
      loading.textContent = '✗ Applet failed: ' + (err && err.message || err);
    });

    // Once the applet's canvas exists, move it into the host and keep its
    // buffer in sync with the laid-out size.
    const started = Date.now();
    const watch = setInterval(() => {
      const root = document.querySelector('.awt-applet-root');
      if (root && root.parentNode !== container) {
        container.appendChild(root);
        loading.remove();
      }
      syncCanvasBuffers(container);
      if (Date.now() - started > 60000) clearInterval(watch);
    }, 100);

    return debug;
  }

  global.JavaAppletEngine = { runApplet };
})(window);
