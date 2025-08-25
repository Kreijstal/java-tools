module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'getLine(Ljavax/sound/sampled/Line$Info;)Ljavax/sound/sampled/Line;': (jvm, obj, args, thread) => {
      const [info] = args;
      const lineClass = info.fields['javax/sound/sampled/Line$Info']['lineClass'];
      const className = lineClass._classData.ast.classes[0].className;

      if (className === 'javax/sound/sampled/SourceDataLine') {
        const sourceDataLine = jvm.newObject('javax/sound/sampled/SourceDataLine');
        return sourceDataLine;
      }

      const exception = jvm.newObject('javax/sound/sampled/LineUnavailableException');
      const msg = jvm.internString('Line not supported: ' + className);
      const exceptionClassDef = jvm.jre['java/lang/Exception'];
      exceptionClassDef.methods['<init>(Ljava/lang/String;)V'](jvm, exception, [msg]);
      jvm.throwException(exception);
    },
    'getMixerInfo()[Ljavax/sound/sampled/Mixer$Info;': (jvm, obj, args, thread) => {
      // TODO: implement
      return null;
    },
  },
};
