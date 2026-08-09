// java.awt.GridLayout - Arranges components in a rectangular grid

const { withThrows } = require('../../helpers');

function initializeGridLayout(obj, rows, cols, hgap, vgap) {
  if (rows < 0 || cols < 0 || (rows === 0 && cols === 0)) {
    throw {
      type: 'java/lang/IllegalArgumentException',
      message: 'rows and columns must be non-negative and not both zero',
    };
  }
  obj._rows = rows;
  obj._cols = cols;
  obj._hgap = hgap;
  obj._vgap = vgap;
}

const checkedInitializer = (argumentCount) => withThrows((jvm, obj, args) => {
  initializeGridLayout(
    obj,
    args[0],
    args[1],
    argumentCount >= 3 ? args[2] : 0,
    argumentCount >= 4 ? args[3] : 0,
  );
}, ['java/lang/IllegalArgumentException']);

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
    '<init>(II)V': checkedInitializer(2),
    '<init>(III)V': checkedInitializer(3),
    '<init>(IIII)V': checkedInitializer(4),
    'getRows()I': (jvm, obj) => obj._rows,
    'getColumns()I': (jvm, obj) => obj._cols,
    'getHgap()I': (jvm, obj) => obj._hgap,
    'getVgap()I': (jvm, obj) => obj._vgap,
  },
};
