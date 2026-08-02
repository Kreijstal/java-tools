# Java Applet Loader (jvm.js)

A userscript that scans web pages for classic `<applet>` tags and re-runs
them **inline** in the browser using jvm.js — no Java plugin, no
appletviewer, no iframe.

## How it works

1. Scans the page for `<applet>` (and legacy `object`/`embed`) elements.
2. Reads the applet tag: `code`, `codebase`, `archive`, `width`, `height`,
   `name`, and `<param name=... value=...>` children.
3. Replaces each applet with an inline host `<div>` sized to the applet's
   `width`/`height`, then runs `applet-engine.js` in the page itself:
   - fetches the jar/zip archive (`archive`) or individual `.class` files
     from the `codebase` on demand
   - instantiates the browser JVM, sets applet parameters, runs the applet
   - the applet's canvas is attached directly into the host div — no iframe,
     so archive fetches use the page's own origin (same-origin archives work
     with no CORS setup)

Because everything runs inline in the host page, the applet participates in
the page's DOM/scripts and there is no cross-origin isolation wall between
the page and the applet.

## Install

1. Build the browser bundle (the engine needs `jvm-debug.js` next to
   `applet-engine.js`):

   ```sh
   node scripts/generate-jre-index.js
   npx webpack --mode production
   ```

2. Serve the repo root (or copy `applet-engine.js` + `dist/jvm-debug.js` to
   your static host). Update `BASE` at the top of
   `java-applet-loader.user.js` (or set `window.JAVA_APPLET_BASE`) to point
   at that directory.

3. Install `java-applet-loader.user.js` in Tampermonkey / Violentmonkey /
   Greasemonkey, or include it on any page that still has applet tags:

   ```html
   <script src="java-applet-loader.user.js"></script>
   ```

## Demo

`KiteModeler.demo.html` contains the original NASA KiteModeler applet tag:

```html
<applet code="Kite.class" codebase="../../dist/demo/kite/" width=710 height=400></applet>
```

Serve the repo root, open the demo page, and the loader replaces the applet
with the running jvm.js viewer inline.

## Supported applet tag forms

```html
<!-- class files served from the codebase (classic form) -->
<applet code="Kite.class" codebase="../javplts/kite/" width=710 height=400>
  <param name="param1" value="value1">
</applet>

<!-- packaged in a jar/zip archive -->
<applet code="com.example.Applet" archive="applet.jar" width=400 height=300>
  <param name="color" value="red">
</applet>
```

## Notes

- Archives/class files fetched from a **different** origin still need CORS
  headers (`Access-Control-Allow-Origin: *`). Same-origin applets need no
  setup — this is why the applet runs inline in the page rather than in an
  iframe.
- The engine can also be used directly (e.g. from a bookmarklet or another
  script) via `JavaAppletEngine.runApplet({...})` — see the doc comment at
  the top of `applet-engine.js`.
