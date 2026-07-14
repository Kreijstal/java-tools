module.exports = {
  super: 'java/lang/Object',
  methods: {
    'open()V': (jvm, obj, args) => {
      // No-arg open: mark the line usable. If no real audio device is wired
      // up, writes go to a discard sink (headless).
      obj.isOpen = true;
      if (!obj.audioOutput) {
        obj.audioOutput = { write() {}, once(event, cb) { if (cb) cb(); } };
      }
    },
    'close()V': (jvm, obj, args) => {
      // to be implemented by subclasses
    },
  },
};
