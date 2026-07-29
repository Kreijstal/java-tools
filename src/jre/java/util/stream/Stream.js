const { invokeFunctional } = require('../../../functional');

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
    'collect(Ljava/util/stream/Collector;)Ljava/lang/Object;': (jvm, stream, args) => {
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
      const map = new Map();
      for (const entry of stream.array || []) {
        const key = entry && entry.key;
        map.set(`stream:${map.size}`, {
          type: 'java/util/Map$Entry',
          key,
          value: entry && entry.value,
        });
      }
      return {
        type: 'java/util/HashMap',
        map,
        sizeCache: map.size,
      };
    },
  },
};
