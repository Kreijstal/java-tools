module.exports = {
  super: 'java/lang/Object',
  fields: {
    'left:I': 0,
    'top:I': 0,
    'right:I': 0,
    'bottom:I': 0,
  },
  methods: {
    '<init>(IIII)V': (jvm, obj, args) => {
      obj.top = args[0];
      obj.left = args[1];
      obj.bottom = args[2];
      obj.right = args[3];
      obj.fields = obj.fields || {};
      obj.fields['java/awt/Insets.top'] = obj.top;
      obj.fields['java/awt/Insets.left'] = obj.left;
      obj.fields['java/awt/Insets.bottom'] = obj.bottom;
      obj.fields['java/awt/Insets.right'] = obj.right;
    },
  },
};
