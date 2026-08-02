// java.awt.GridLayout - Arranges components in a rectangular grid

module.exports = {
  super: 'java/lang/Object',
  interfaces: ['java/awt/LayoutManager'],
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._rows = 1;
      obj._cols = 0;
      obj._hgap = 0;
      obj._vgap = 0;
    },
    '<init>(II)V': (jvm, obj, args) => {
      obj._rows = args[0];
      obj._cols = args[1];
      obj._hgap = 0;
      obj._vgap = 0;
    },
    '<init>(III)V': (jvm, obj, args) => {
      obj._rows = args[0];
      obj._cols = args[1];
      obj._hgap = args[2];
      obj._vgap = 0;
    },
    '<init>(IIII)V': (jvm, obj, args) => {
      obj._rows = args[0];
      obj._cols = args[1];
      obj._hgap = args[2];
      obj._vgap = args[3];
    },
    'getRows()I': (jvm, obj) => obj._rows,
    'getColumns()I': (jvm, obj) => obj._cols,
    'getHgap()I': (jvm, obj) => obj._hgap,
    'getVgap()I': (jvm, obj) => obj._vgap,
  },
};
