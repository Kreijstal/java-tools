module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'toList()Ljava/util/stream/Collector;': () => ({
      type: 'java/util/stream/Collector',
      kind: 'toList',
    }),
    'toMap(Ljava/util/function/Function;Ljava/util/function/Function;)Ljava/util/stream/Collector;':
      (jvm, obj, args) => ({
        type: 'java/util/stream/Collector',
        kind: 'toMap',
        keyMapper: args[0],
        valueMapper: args[1],
      }),
  },
};
