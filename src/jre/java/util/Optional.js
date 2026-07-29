const { invokeFunctional } = require('../../functional');

function optional(value) {
  return {
    type: 'java/util/Optional',
    present: value !== null && value !== undefined,
    value: value === undefined ? null : value,
  };
}

module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'empty()Ljava/util/Optional;': () => optional(null),
    'of(Ljava/lang/Object;)Ljava/util/Optional;': (jvm, obj, args) => {
      if (args[0] === null || args[0] === undefined) {
        throw { type: 'java/lang/NullPointerException' };
      }
      return optional(args[0]);
    },
    'ofNullable(Ljava/lang/Object;)Ljava/util/Optional;': (jvm, obj, args) =>
      optional(args[0]),
  },
  methods: {
    'get()Ljava/lang/Object;': (jvm, obj) => {
      if (!obj.present) throw { type: 'java/util/NoSuchElementException' };
      return obj.value;
    },
    'isPresent()Z': (jvm, obj) => obj.present ? 1 : 0,
    'map(Ljava/util/function/Function;)Ljava/util/Optional;':
      async (jvm, obj, args, thread) => {
        if (!obj.present) return optional(null);
        return optional(await invokeFunctional(jvm, args[0], [obj.value], thread));
      },
    'flatMap(Ljava/util/function/Function;)Ljava/util/Optional;':
      async (jvm, obj, args, thread) => {
        if (!obj.present) return optional(null);
        const result = await invokeFunctional(jvm, args[0], [obj.value], thread);
        if (result === null || result === undefined) {
          throw { type: 'java/lang/NullPointerException' };
        }
        return result;
      },
    'filter(Ljava/util/function/Predicate;)Ljava/util/Optional;':
      async (jvm, obj, args, thread) => {
        if (!obj.present) return obj;
        return await invokeFunctional(jvm, args[0], [obj.value], thread)
          ? obj
          : optional(null);
      },
    'orElse(Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) =>
      obj.present ? obj.value : args[0],
    'orElseGet(Ljava/util/function/Supplier;)Ljava/lang/Object;':
      async (jvm, obj, args, thread) =>
        obj.present ? obj.value :
          invokeFunctional(jvm, args[0], [], thread),
  },
};
