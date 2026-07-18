module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(I)V': (jvm, obj, args) => {
      obj.index = args[0] | 0;
      obj.errorIndex = -1;
    },
    'getIndex()I': (jvm, obj) => obj.index | 0,
    'setIndex(I)V': (jvm, obj, args) => { obj.index = args[0] | 0; },
    'getErrorIndex()I': (jvm, obj) => obj.errorIndex === undefined ? -1 : obj.errorIndex | 0,
    'setErrorIndex(I)V': (jvm, obj, args) => { obj.errorIndex = args[0] | 0; },
  },
};
