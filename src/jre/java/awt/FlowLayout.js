module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/awt/LayoutManager'],
  staticFields: {
    'LEFT:I': 0,
    'CENTER:I': 1,
    'RIGHT:I': 2
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._align = 1;
      obj._hgap = 5;
      obj._vgap = 5;
    },
    '<init>(I)V': (jvm, obj, args) => {
      obj._align = args[0];
      obj._hgap = 5;
      obj._vgap = 5;
    },
    '<init>(III)V': (jvm, obj, args) => {
      obj._align = args[0];
      obj._hgap = args[1];
      obj._vgap = args[2];
    }
  },
};
