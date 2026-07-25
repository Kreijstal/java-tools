module.exports = {
  super: 'java/lang/Object',
  methods: {
    // Headless no-op Robot: games use it for mouse warping / idle simulation.
    '<init>()V': () => {},
    'mouseMove(II)V': () => {},
    'keyPress(I)V': () => {},
    'keyRelease(I)V': () => {},
    'mousePress(I)V': () => {},
    'mouseRelease(I)V': () => {},
    'setAutoDelay(I)V': () => {},
  },
};
