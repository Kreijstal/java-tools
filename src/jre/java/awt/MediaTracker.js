module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(Ljava/awt/Component;)V': (jvm, obj, args) => { obj._component = args[0] || null; },
    'addImage(Ljava/awt/Image;I)V': (jvm, obj, args) => {
      if (!obj._images) obj._images = [];
      obj._images.push({ image: args[0] || null, id: args[1] || 0 });
    },
    'waitForAll()V': () => {},
  },
};
