const { invokeFunctional } = require('../../../functional');
const HashMap = require('../HashMap');

module.exports = {
  isInterface: true,
  super: null,
  staticMethods: {
    'empty()Ljava/util/stream/Stream;':
      () => ({ type: 'java/util/stream/Stream', array: [] }),
    'concat(Ljava/util/stream/Stream;Ljava/util/stream/Stream;)Ljava/util/stream/Stream;':
      (jvm, obj, args) => ({
        type: 'java/util/stream/Stream',
        array: [
          ...(args[0] && args[0].array || []),
          ...(args[1] && args[1].array || []),
        ],
      }),
  },
  methods: {
    'filter(Ljava/util/function/Predicate;)Ljava/util/stream/Stream;':
      async (jvm, stream, args, thread) => {
        const array = [];
        for (const value of stream.array || []) {
          if (await invokeFunctional(jvm, args[0], [value], thread)) {
            array.push(value);
          }
        }
        return { type: 'java/util/stream/Stream', array };
      },
    'anyMatch(Ljava/util/function/Predicate;)Z':
      async (jvm, stream, args, thread) => {
        for (const value of stream.array || []) {
          if (await invokeFunctional(jvm, args[0], [value], thread)) return 1;
        }
        return 0;
      },
    'allMatch(Ljava/util/function/Predicate;)Z':
      async (jvm, stream, args, thread) => {
        for (const value of stream.array || []) {
          if (!(await invokeFunctional(jvm, args[0], [value], thread))) return 0;
        }
        return 1;
      },
    'noneMatch(Ljava/util/function/Predicate;)Z':
      async (jvm, stream, args, thread) => {
        for (const value of stream.array || []) {
          if (await invokeFunctional(jvm, args[0], [value], thread)) return 0;
        }
        return 1;
      },
    'findFirst()Ljava/util/Optional;': (jvm, stream) => {
      const values = stream.array || [];
      return {
        type: 'java/util/Optional',
        present: values.length > 0,
        value: values.length > 0 ? values[0] : null,
      };
    },
    'collect(Ljava/util/stream/Collector;)Ljava/lang/Object;':
      async (jvm, stream, args, thread) => {
        const collector = args[0];
        if (collector && collector.kind === 'toList') {
          const array = (stream.array || []).slice();
          return {
            type: 'java/util/ArrayList',
            array,
            items: array,
            size: array.length,
          };
        }
        if (!collector || collector.kind !== 'toMap') {
          throw new Error('Unsupported stream collector');
        }
        const result = {
          type: 'java/util/HashMap',
          map: new Map(),
          sizeCache: 0,
        };
        const containsKey = HashMap.methods[
          'containsKey(Ljava/lang/Object;)Z'
        ];
        const put = HashMap.methods[
          'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;'
        ];
        for (const element of stream.array || []) {
          const key = await invokeFunctional(
            jvm, collector.keyMapper, [element], thread,
          );
          const value = await invokeFunctional(
            jvm, collector.valueMapper, [element], thread,
          );
          if (value === null || value === undefined) {
            throw { type: 'java/lang/NullPointerException' };
          }
          if (containsKey(jvm, result, [key])) {
            throw { type: 'java/lang/IllegalStateException' };
          }
          put(jvm, result, [key, value]);
        }
        result.sizeCache = result.map.size;
        return result;
      },
  },
};
