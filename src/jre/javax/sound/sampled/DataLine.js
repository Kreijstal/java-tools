module.exports = {
  'javax/sound/sampled/DataLine': {
    super: 'javax/sound/sampled/Line',
    methods: {
      // DataLine is an interface, so methods are abstract
    },
  },
  'javax/sound/sampled/DataLine$Info': {
    super: 'javax/sound/sampled/Line$Info',
    fields: {
      'formats': '[Ljavax/sound/sampled/AudioFormat;',
      'minBufferSize': 'I',
      'maxBufferSize': 'I',
    },
    methods: {
      '<init>(Ljava/lang/Class;[Ljavax/sound/sampled/AudioFormat;II)V': (jvm, obj, args) => {
        const [lineClass, formats, minBufferSize, maxBufferSize] = args;
        const lineInfoClass = jvm.findClass('javax/sound/sampled/Line$Info');
        jvm.runMethod(lineInfoClass, '<init>(Ljava/lang/Class;)V', [obj, lineClass]);
        const fields = obj.fields['javax/sound/sampled/DataLine$Info'];
        fields['formats'] = formats;
        fields['minBufferSize'] = minBufferSize;
        fields['maxBufferSize'] = maxBufferSize;
      },
      '<init>(Ljava/lang/Class;Ljavax/sound/sampled/AudioFormat;I)V': (jvm, obj, args) => {
        const [lineClass, format, bufferSize] = args;
        const dataLineInfoClass = jvm.findClass('javax/sound/sampled/DataLine$Info');
        const audioFormatArray = jvm.createArray('[Ljavax/sound/sampled/AudioFormat;', 1);
        audioFormatArray[0] = format;
        jvm.runMethod(dataLineInfoClass, '<init>(Ljava/lang/Class;[Ljavax/sound/sampled/AudioFormat;II)V', [obj, lineClass, audioFormatArray, bufferSize, bufferSize]);
      },
      '<init>(Ljava/lang/Class;Ljavax/sound/sampled/AudioFormat;)V': (jvm, obj, args) => {
        const [lineClass, format] = args;
        const dataLineInfoClass = jvm.findClass('javax/sound/sampled/DataLine$Info');
        jvm.runMethod(dataLineInfoClass, '<init>(Ljava/lang/Class;Ljavax/sound/sampled/AudioFormat;I)V', [obj, lineClass, format, -1]);
      },
    },
  },
};
