'use strict';

const { withThrows } = require('../../../helpers');

module.exports = {
  isInterface: true,
  methods: {
    'getTransferData(Ljava/awt/datatransfer/DataFlavor;)Ljava/lang/Object;': withThrows(
      () => null,
      ['java/awt/datatransfer/UnsupportedFlavorException', 'java/io/IOException'],
    ),
    'getTransferDataFlavors()[Ljava/awt/datatransfer/DataFlavor;': () => [],
    'isDataFlavorSupported(Ljava/awt/datatransfer/DataFlavor;)Z': () => false,
  },
};
