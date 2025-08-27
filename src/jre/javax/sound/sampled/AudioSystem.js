module.exports = {
  super: "java/lang/Object",
  staticMethods: {
    "getLine(Ljavax/sound/sampled/Line$Info;)Ljavax/sound/sampled/Line;": (
      jvm,
      obj,
      args,
      thread,
    ) => {
      const [info] = args;
      const lineClass =
        info.fields["javax/sound/sampled/Line$Info"]["lineClass"];
      const className = lineClass._classData.ast.classes[0].className;

      if (className === "javax/sound/sampled/SourceDataLine") {
        // Create a basic SourceDataLine object
        const sourceDataLine = {
          type: "javax/sound/sampled/SourceDataLine",
          fields: {},
          hashCode: jvm.nextHashCode++,
          isLocked: false,
          lockOwner: null,
          lockCount: 0,
          waitSet: [],
        };
        return sourceDataLine;
      }

      const exception = {
        type: "javax/sound/sampled/LineUnavailableException",
        message: "Line not supported: " + className,
        hashCode: jvm.nextHashCode++,
        isLocked: false,
        lockOwner: null,
        lockCount: 0,
        waitSet: [],
      };
      jvm.throwException(exception);
    },
    "getMixerInfo()[Ljavax/sound/sampled/Mixer$Info;": (
      jvm,
      obj,
      args,
      thread,
    ) => {
      // TODO: implement
      return null;
    },
  },
};
