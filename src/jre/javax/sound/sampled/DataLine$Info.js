module.exports = {
  super: 'javax/sound/sampled/Line$Info',
  fields: {
    'formats': '[Ljavax/sound/sampled/AudioFormat;',
    'minBufferSize': 'I',
    'maxBufferSize': 'I',
  },
  methods: {
    '<init>(Ljava/lang/Class;[Ljavax/sound/sampled/AudioFormat;II)V': (jvm, obj, args) => {
      const [lineClass, formats, minBufferSize, maxBufferSize] = args;
      const lineInfoClassDef = jvm.jre['javax/sound/sampled/Line$Info'];
      lineInfoClassDef.methods['<init>(Ljava/lang/Class;)V'](jvm, obj, [lineClass]);
      obj.fields['javax/sound/sampled/DataLine$Info'] = {
        formats,
        minBufferSize,
        maxBufferSize,
      };
    },
    '<init>(Ljava/lang/Class;Ljavax/sound/sampled/AudioFormat;I)V': (jvm, obj, args) => {
      const [lineClass, format, bufferSize] = args;
      const audioFormatClassObj = jvm.getClassObject('javax/sound/sampled/AudioFormat');
      const arrayClass = jvm.jre['java/lang/reflect/Array'];
      const audioFormatArray = arrayClass.staticMethods['newInstance(Ljava/lang/Class;I)Ljava/lang/Object;'](jvm, null, [audioFormatClassObj, 1]);
      audioFormatArray.elements[0] = format;
      const dataLineInfoClassDef = jvm.jre['javax/sound/sampled/DataLine$Info'];
      dataLineInfoClassDef.methods['<init>(Ljava/lang/Class;[Ljavax/sound/sampled/AudioFormat;II)V'](jvm, obj, [lineClass, audioFormatArray, bufferSize, bufferSize]);
    },
    '<init>(Ljava/lang/Class;Ljavax/sound/sampled/AudioFormat;)V': (jvm, obj, args) => {
      const [lineClass, format] = args;
      const dataLineInfoClassDef = jvm.jre['javax/sound/sampled/DataLine$Info'];
      dataLineInfoClassDef.methods['<init>(Ljava/lang/Class;Ljavax/sound/sampled/AudioFormat;I)V'](jvm, obj, [lineClass, format, -1]);
    },
  },
};
