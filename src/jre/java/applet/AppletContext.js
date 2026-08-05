// java.applet.AppletContext
//
// Applets on one page were able to find and call each other: the classic plugin
// kept every applet of a page in a single VM, isolated by class loader rather
// than by runtime, and exposed the others through getApplet()/getApplets().
// That is what <applet name="..."> was for. These lookups therefore only work
// when the embedder runs the page's applets on a shared JVM.

function registryFor(jvm, obj) {
  const owner = (obj && obj._jvm) || jvm;
  return (owner && owner._appletRegistry) || [];
}

module.exports = {
  super: 'java/lang/Object',
  isInterface: true,
  interfaces: [],
  methods: {
    // Headless: navigating the browser to a document is a no-op.
    'showDocument(Ljava/net/URL;)V': () => {},
    'showDocument(Ljava/net/URL;Ljava/lang/String;)V': () => {},
    'showStatus(Ljava/lang/String;)V': () => {},

    'getApplet(Ljava/lang/String;)Ljava/applet/Applet;': (jvm, obj, args) => {
      const wanted = args[0] == null ? '' : String(args[0]);
      const registry = registryFor(jvm, obj);
      const exact = registry.find((applet) => applet._appletName === wanted);
      if (exact) return exact;
      // Applet names were matched leniently by the plugin, and old pages are
      // inconsistent about casing.
      const lowered = wanted.toLowerCase();
      const loose = registry.find((applet) =>
        typeof applet._appletName === 'string' &&
        applet._appletName.toLowerCase() === lowered);
      return loose || null;
    },

    'getApplets()Ljava/util/Enumeration;': (jvm, obj, args) => {
      // java.util.Enumeration here reads plain {index, array} state.
      return {
        type: 'java/util/Enumeration',
        index: 0,
        array: registryFor(jvm, obj).slice(),
      };
    },
  },
};
