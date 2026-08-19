module.exports = {
  super: 'java/lang/Object',
  // A class, not an interface: MSJVM declares `WComponentPeer implements
  // ComponentPeer`, and the games' own original bytecode calls getHwnd through a
  // Methodref, which is only legal against a class. Modelling it as an interface
  // made the frontend emit invokeinterface where the original jar has
  // invokevirtual.
  isInterface: false,
  interfaces: ['java/awt/peer/ComponentPeer'],
  methods: {
    'getHwnd()I': (jvm, obj, args) => obj._hwnd || 0,
    'getTopHwnd()I': (jvm, obj, args) => obj._topHwnd || obj._hwnd || 0,
  },
};
