# Java Applet Loader (jvm.js)

A userscript that scans web pages for classic `<applet>` tags and re-runs
them in the browser using jvm.js — no Java plugin, no appletviewer, no
`<applet>` support needed.

## How it works

1. Scans the page for `<applet>` (and legacy `object`/`embed`) elements.
2. Reads the applet tag: `code`, `codebase`, `archive`, `width`, `height`,
   `name`, and `<param name=... value=...>` children.
3. Replaces each applet with an `<iframe>` loading `applet-viewer.html`
   with the archive/codebase, class name, size and applet parameters in the
   query string.
4. The viewer fetches the archive (`?url=`) or individual `.class` files
   from the codebase (`?codebase=` + `?class=`), then runs the applet:
   - applet lifecycle (`init`, `start`, `paint`)
   - legacy pre-1.1 event model (`postEvent` → `handleEvent`/`action`,
     `mouseDown`/`mouseDrag`/`mouseUp`) — buttons, scrollbars and canvas
     drag interactions work
   - AWT layout (GridLayout, BorderLayout, CardLayout, FlowLayout)

## Install

1. Build the browser bundle (the viewer needs `jvm-debug.js` next to
   `applet-viewer.html`):

   ```sh
   node scripts/generate-jre-index.js
   npx webpack --mode production
   ```

2. Serve the repo root (or copy `applet-viewer.html` + `dist/jvm-debug.js`
   to your static host). Update `VIEWER_URL` at the top of
   `java-applet-loader.user.js` to point at your `applet-viewer.html`.

3. Install `java-applet-loader.user.js` in Tampermonkey / Violentmonkey /
   Greasemonkey, or include it on any page that still has applet tags:

   ```html
   <script src="java-applet-loader.user.js"></script>
   ```

## Demo

`KiteModeler.demo.html` contains the original NASA KiteModeler applet tag:

```html
<applet code="Kite.class" width=710 height=400></applet>
```

Serve `dist/demo/kite/` (with the `Kite*.class` files) alongside the page,
open it, and the loader replaces the applet with the running jvm.js viewer.

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

- Cross-origin archives/class files must be served with CORS headers
  (`Access-Control-Allow-Origin: *`), since the viewer fetches them from
  the browser.
- The viewer page supports deep-linking:
  `applet-viewer.html?url=<archive>&class=<Name>&w=<width>&h=<height>&embed=1&param=value`
