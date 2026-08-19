module.exports = {
  // An interface in the JDK. The flag is what makes the Java frontend choose
  // invokeinterface over invokevirtual, and a Methodref naming an interface links
  // cleanly and then throws IncompatibleClassChangeError the first time it runs.
  isInterface: true,
  super: 'java/lang/Object',
  methods: {
    'open()V': (jvm, obj, args) => {
      // No-arg open: mark the line usable. If no real audio device is wired
      // up, writes go to a discard sink (headless).
      obj.isOpen = true;
      if (!obj.audioOutput) {
        obj.audioOutput = {
          write() {},
          once(event, cb) { if (cb) cb(); },
          end() {},
        };
      }
    },
    'close()V': (jvm, obj, args) => {
      // to be implemented by subclasses
    },
  },
};
