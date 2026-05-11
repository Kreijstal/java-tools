module.exports = {
  super: 'java/lang/Object',
  fields: {
    'width:I': 0,
    'height:I': 0,
    'rgbBitCount:I': 0,
    'refreshRate:I': 0,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.width = 0;
      obj.height = 0;
      obj.rgbBitCount = 0;
      obj.refreshRate = 0;
      obj.fields = obj.fields || {};
      obj.fields['com/ms/directX/DDSurfaceDesc.width'] = 0;
      obj.fields['com/ms/directX/DDSurfaceDesc.height'] = 0;
      obj.fields['com/ms/directX/DDSurfaceDesc.rgbBitCount'] = 0;
      obj.fields['com/ms/directX/DDSurfaceDesc.refreshRate'] = 0;
    },
  },
};
