module.exports = {
  'javax/sound/sampled/Line': {
    super: 'java/lang/Object',
    methods: {
      'open()V': (jvm, obj, args) => {
        // to be implemented by subclasses
      },
      'close()V': (jvm, obj, args) => {
        // to be implemented by subclasses
      },
    },
  },
  'javax/sound/sampled/Line$Info': {
    super: 'java/lang/Object',
    fields: {
      'lineClass': 'Ljava/lang/Class;',
    },
    methods: {
      '<init>(Ljava/lang/Class;)V': (jvm, obj, args) => {
        const [lineClass] = args;
        obj.fields['javax/sound/sampled/Line$Info']['lineClass'] = lineClass;
      },
      'getLineClass()Ljava/lang/Class;': (jvm, obj, args) => {
        return obj.fields['javax/sound/sampled/Line$Info']['lineClass'];
      },
    },
  },
};
