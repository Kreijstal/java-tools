function color(r, g, b) {
  return { type: 'java/awt/Color', value: { r, g, b, a: 255 } };
}

const red = color(255, 0, 0);
const black = color(0, 0, 0);
const lightGray = color(192, 192, 192);
const gray = color(128, 128, 128);
const white = color(255, 255, 255);
const green = color(0, 255, 0);
const blue = color(0, 0, 255);
const yellow = color(255, 255, 0);
const cyan = color(0, 255, 255);
const magenta = color(255, 0, 255);
const orange = color(255, 200, 0);
const pink = color(255, 175, 175);
const darkGray = color(64, 64, 64);

module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'red:Ljava/awt/Color;': red,
    'RED:Ljava/awt/Color;': red,
    'black:Ljava/awt/Color;': black,
    'BLACK:Ljava/awt/Color;': black,
    'lightGray:Ljava/awt/Color;': lightGray,
    'LIGHT_GRAY:Ljava/awt/Color;': lightGray,
    'gray:Ljava/awt/Color;': gray,
    'GRAY:Ljava/awt/Color;': gray,
    'white:Ljava/awt/Color;': white,
    'WHITE:Ljava/awt/Color;': white,
    'green:Ljava/awt/Color;': green,
    'GREEN:Ljava/awt/Color;': green,
    'blue:Ljava/awt/Color;': blue,
    'BLUE:Ljava/awt/Color;': blue,
    'yellow:Ljava/awt/Color;': yellow,
    'YELLOW:Ljava/awt/Color;': yellow,
    'cyan:Ljava/awt/Color;': cyan,
    'CYAN:Ljava/awt/Color;': cyan,
    'magenta:Ljava/awt/Color;': magenta,
    'MAGENTA:Ljava/awt/Color;': magenta,
    'orange:Ljava/awt/Color;': orange,
    'ORANGE:Ljava/awt/Color;': orange,
    'pink:Ljava/awt/Color;': pink,
    'PINK:Ljava/awt/Color;': pink,
    'darkGray:Ljava/awt/Color;': darkGray,
    'DARK_GRAY:Ljava/awt/Color;': darkGray,
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
