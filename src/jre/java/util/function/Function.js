module.exports = {
  super: null,
  name: 'java/util/function/Function',
  isInterface: true,
  methods: {
    'apply(Ljava/lang/Object;)Ljava/lang/Object;': { isAbstract: true },
    'compose(Ljava/util/function/Function;)Ljava/util/function/Function;': { isAbstract: true },
    'andThen(Ljava/util/function/Function;)Ljava/util/function/Function;': { isAbstract: true }
  }
};