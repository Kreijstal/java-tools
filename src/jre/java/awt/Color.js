module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'RED:Ljava/awt/Color;': {
      type: 'java/awt/Color',
      value: { r: 255, g: 0, b: 0, a: 255 },
    },
    'black:Ljava/awt/Color;': {
      type: 'java/awt/Color',
      value: { r: 0, g: 0, b: 0, a: 255 },
    },
    'lightGray:Ljava/awt/Color;': {
      type: 'java/awt/Color',
      value: { r: 192, g: 192, b: 192, a: 255 },
    },
    'gray:Ljava/awt/Color;': {
      type: 'java/awt/Color',
      value: { r: 128, g: 128, b: 128, a: 255 },
    },
    'white:Ljava/awt/Color;': {
      type: 'java/awt/Color',
      value: { r: 255, g: 255, b: 255, a: 255 },
    },
  },
  methods: {
    '<init>(I)V': (jvm, obj, args) => {
      const rgb = args[0] || 0;
      obj.value = {
        r: (rgb >> 16) & 0xff,
        g: (rgb >> 8) & 0xff,
        b: rgb & 0xff,
        a: 255,
      };
    },
    '<init>(III)V': (jvm, obj, args) => {
      obj.value = { r: args[0], g: args[1], b: args[2], a: 255 };
    },
  },
};
