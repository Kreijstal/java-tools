module.exports = {
  super: 'java/lang/Object',
  isInterface: true,
  interfaces: [],
  methods: {
    // Headless: navigating the browser to a document is a no-op.
    'showDocument(Ljava/net/URL;)V': () => {},
    'showDocument(Ljava/net/URL;Ljava/lang/String;)V': () => {},
    'showStatus(Ljava/lang/String;)V': () => {},
  },
};
