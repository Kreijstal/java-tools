module.exports = {
  super: 'java/lang/Object',
  isInterface: true,
  interfaces: ['java/awt/peer/ComponentPeer'],
  methods: {
    'getHwnd()I': (jvm, obj, args) => obj._hwnd || 0,
    'getTopHwnd()I': (jvm, obj, args) => obj._topHwnd || obj._hwnd || 0,
  },
};
