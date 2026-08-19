module.exports = {
  super: 'java/lang/Object',
  isInterface: true,
  interfaces: [],
  // Declared signature-only: the implementations are game classes. Leaving this
  // interface out of the model made the frontend fabricate these descriptors and,
  // worse, emit invokevirtual for them - which is an IncompatibleClassChangeError
  // ("Found interface java.awt.image.ImageConsumer, but class was expected") the
  // first time an image is prepared.
  methods: {
    'imageComplete(I)V': { isAbstract: true },
    'setColorModel(Ljava/awt/image/ColorModel;)V': { isAbstract: true },
    'setDimensions(II)V': { isAbstract: true },
    'setHints(I)V': { isAbstract: true },
    'setPixels(IIIILjava/awt/image/ColorModel;[BII)V': { isAbstract: true },
    'setPixels(IIIILjava/awt/image/ColorModel;[III)V': { isAbstract: true },
    'setProperties(Ljava/util/Hashtable;)V': { isAbstract: true },
  },
  staticFields: {
    'RANDOMPIXELORDER:I': 1,
    'TOPDOWNLEFTRIGHT:I': 2,
    'COMPLETESCANLINES:I': 4,
    'SINGLEPASS:I': 8,
    'SINGLEFRAME:I': 16,
    'IMAGEERROR:I': 1,
    'SINGLEFRAMEDONE:I': 2,
    'STATICIMAGEDONE:I': 3,
    'IMAGEABORTED:I': 4,
  },
};
