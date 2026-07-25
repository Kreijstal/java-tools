const { getLegacyPlatform } = require('../../../../platform/legacy');

module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj._displayMode = null;
      obj._cooperativeComponent = null;
    },
    'initialize(Lcom/ms/com/_Guid;)V': (jvm, obj, args) => {
      obj._guid = args[0] || null;
    },
    'enumDisplayModes(ILcom/ms/directX/DDSurfaceDesc;Lcom/ms/com/IUnknown;Lcom/ms/directX/IEnumModesCallback;)V': (jvm, obj, args) => {
      const [, surfaceDesc, unknown, callback] = args;
      const modes = getLegacyPlatform().getDisplayModes(surfaceDesc);
      for (const mode of modes) {
      const desc = {
        type: 'com/ms/directX/DDSurfaceDesc',
        width: mode.width,
        height: mode.height,
        rgbBitCount: mode.rgbBitCount,
        refreshRate: mode.refreshRate,
        fields: {
          'com/ms/directX/DDSurfaceDesc.width': mode.width,
          'com/ms/directX/DDSurfaceDesc.height': mode.height,
          'com/ms/directX/DDSurfaceDesc.rgbBitCount': mode.rgbBitCount,
          'com/ms/directX/DDSurfaceDesc.refreshRate': mode.refreshRate,
        },
      };
        invokeEnumCallback(callback, desc, unknown);
      }
    },
    'setCooperativeLevel(Ljava/awt/Component;I)V': (jvm, obj, args) => {
      obj._cooperativeComponent = args[0] || null;
      obj._cooperativeFlags = args[1] || 0;
    },
    'setDisplayMode(IIIII)V': (jvm, obj, args) => {
      const [width, height, bitDepth, refreshRate, flags] = args;
      obj._displayMode = { width, height, bitDepth, refreshRate, flags };
      getLegacyPlatform().setDisplayMode(obj._cooperativeComponent, obj._displayMode);
    },
    'restoreDisplayMode()V': (jvm, obj, args) => {
      obj._displayMode = null;
      getLegacyPlatform().restoreDisplayMode();
    },
  },
};

function invokeEnumCallback(callback, desc, unknown) {
  if (!callback) return;
  const direct = callback.callbackEnumModes || callback['callbackEnumModes(Lcom/ms/directX/DDSurfaceDesc;Lcom/ms/com/IUnknown;)V'];
  if (typeof direct === 'function') {
    direct.call(callback, desc, unknown || null);
  }
}
