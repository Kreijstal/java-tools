# Browser imports from source

The package root points to `src/platform/browser-entry.js`. Its `browser` map
supplies the same aliases, polyfills and unavailable Node modules as the site
build in `config/browser-build.json`. Polyfills are runtime dependencies so
source-building CDNs can install them.

`src/jre/index.js` is a tracked source manifest: it lists relative imports of
JRE implementations, without copying their code. This lets CDNs discover the
JRE modules without running a filesystem generator. No bundled code is tracked.

After adding, removing or renaming JRE modules, run:

```sh
node scripts/generate-jre-index.js
npm run check:jre-index
```

The check detects stale manifests. Changes to existing JRE implementations are
picked up directly through their imports; no manifest update is needed.
The generator and Java compiler are JavaScript; neither requires an installed
Java JDK.

```js
import { BrowserJVMDebug, javaTools } from
  'https://esm.sh/gh/Kreijstal/java-tools@COMMIT?standalone';

const compiled = javaTools.compileJava(`
public class Hello {
  public static void main(String[] args) {
    System.out.println("Hello from Java compiled in the browser!");
  }
}
`);

const debug = new BrowserJVMDebug();
for (const artifact of compiled.artifacts) {
  debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
}
await debug.initialize();
await debug.run('Hello');
```

Replace `COMMIT` with a pushed commit SHA. esm.sh builds from that exact source
revision. Compilation returns class bytes in memory. Multi-file compilation
accepts a workspace filesystem through `javaTools.compileJavaFiles`.
Optional networking, audio and worker features still require support from the
embedding browser environment.
