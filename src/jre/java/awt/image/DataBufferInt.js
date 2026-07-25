module.exports = {
  super: 'java/awt/image/DataBuffer',
  methods: {
    // Shares the caller's int[] — the game writes pixels into it directly.
    '<init>([II)V': (jvm, obj, args) => {
      obj._data = args[0];
      obj._size = args[1];
    },
    '<init>(I)V': (jvm, obj, args) => {
      obj._data = new Array(args[0]).fill(0);
      obj._size = args[0];
    },
    'getData()[I': (jvm, obj) => obj._data,
  },
};
