module.exports = {
  super: 'java/lang/Object',
  fields: {
    'x:I': 0,
    'y:I': 0,
    'width:I': 0,
    'height:I': 0,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.x = 0;
      obj.y = 0;
      obj.width = 0;
      obj.height = 0;
      setFields(obj);
    },
    '<init>(II)V': (jvm, obj, args) => {
      obj.x = 0;
      obj.y = 0;
      obj.width = args[0];
      obj.height = args[1];
      setFields(obj);
    },
    '<init>(IIII)V': (jvm, obj, args) => {
      obj.x = args[0];
      obj.y = args[1];
      obj.width = args[2];
      obj.height = args[3];
      setFields(obj);
    },
    '<init>(Ljava/awt/Dimension;)V': (jvm, obj, args) => {
      const dim = args[0] || {};
      obj.x = 0;
      obj.y = 0;
      obj.width = dim.width || (dim.fields && dim.fields['java/awt/Dimension.width']) || 0;
      obj.height = dim.height || (dim.fields && dim.fields['java/awt/Dimension.height']) || 0;
      setFields(obj);
    },
  },
};

function setFields(obj) {
  obj.fields = obj.fields || {};
  obj.fields['java/awt/Rectangle.x'] = obj.x;
  obj.fields['java/awt/Rectangle.y'] = obj.y;
  obj.fields['java/awt/Rectangle.width'] = obj.width;
  obj.fields['java/awt/Rectangle.height'] = obj.height;
}
