module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'black:Ljava/awt/Color;': {
      type: 'java/awt/Color',
      value: { r: 0, g: 0, b: 0, a: 255 },
    },
    'white:Ljava/awt/Color;': {
      type: 'java/awt/Color',
      value: { r: 255, g: 255, b: 255, a: 255 },
    },
  },
  methods: {
    '<init>(III)V': (jvm, obj, args) => {
      obj.value = { r: args[0], g: args[1], b: args[2], a: 255 };
    },
  },
};
