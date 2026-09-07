const { readField } = require('../../../../core/objectModel');
module.exports = {
  super: 'java/lang/Object',
  fields: {
    'lineClass': 'Ljava/lang/Class;',
  },
  methods: {
    '<init>(Ljava/lang/Class;)V': (jvm, obj, args) => {
      const [lineClass] = args;
      readField(obj.fields, 'javax/sound/sampled/Line$Info') = {
        lineClass,
      };
    },
    'getLineClass()Ljava/lang/Class;': (jvm, obj, args) => {
      return readField(obj.fields, 'javax/sound/sampled/Line$Info')['lineClass'];
    },
  },
};
