module.exports = {
  methods: {},
  staticMethods: {
    'emptyList()Ljava/util/List;': () => {
      return {
        type: 'java/util/ArrayList',
        items: [],
        size: 0
      };
    },
    'emptySet()Ljava/util/Set;': () => {
      return {
        type: 'java/util/HashSet',
        items: new Set()
      };
    },
    'emptyMap()Ljava/util/Map;': () => {
      return {
        type: 'java/util/HashMap',
        map: new Map()
      };
    },
    'singletonList(Ljava/lang/Object;)Ljava/util/List;': (jvm, obj, args) => {
      const item = args[0];
      return {
        type: 'java/util/ArrayList',
        items: [item],
        size: 1
      };
    },
    'singletonMap(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/Map;': (jvm, obj, args) => {
      return {
        type: 'java/util/HashMap',
        map: new Map([[args[0], args[1]]])
      };
    },
    'unmodifiableList(Ljava/util/List;)Ljava/util/List;': (jvm, obj, args) => {
      const list = args[0];
      // Create a proxy that prevents modification
      return new Proxy(list, {
        get(target, prop) {
          if (prop === 'add' || prop === 'remove' || prop === 'clear') {
            throw {
              type: 'java/lang/UnsupportedOperationException',
              message: 'Collection is unmodifiable'
            };
          }
          return target[prop];
        }
      });
    },
    'unmodifiableSet(Ljava/util/Set;)Ljava/util/Set;': (jvm, obj, args) => {
      const set = args[0];
      return new Proxy(set, {
        get(target, prop) {
          if (prop === 'add' || prop === 'remove' || prop === 'clear') {
            throw {
              type: 'java/lang/UnsupportedOperationException',
              message: 'Collection is unmodifiable'
            };
          }
          return target[prop];
        }
      });
    },
    'sort(Ljava/util/List;)V': (jvm, obj, args) => {
      const list = args[0];
      if (list && list.items && typeof list.items.sort === 'function') {
        list.items.sort();
      }
    },
    'sort(Ljava/util/List;Ljava/util/Comparator;)V': (jvm, obj, args) => {
      const list = args[0];
      const comparator = args[1];
      if (list && list.items && typeof list.items.sort === 'function') {
        if (comparator && comparator.methods && comparator.methods['compare(Ljava/lang/Object;Ljava/lang/Object;)I']) {
          list.items.sort((a, b) => {
            try {
              return comparator.methods['compare(Ljava/lang/Object;Ljava/lang/Object;)I'](
                null, comparator, [a, b]
              );
            } catch (e) {
              return 0; // Default comparison
            }
          });
        } else {
          list.items.sort((a, b) => {
            if (a < b) return -1;
            if (a > b) return 1;
            return 0;
          });
        }
      }
    },
    'reverse(Ljava/util/List;)V': (jvm, obj, args) => {
      const list = args[0];
      if (list && list.items) {
        list.items.reverse();
      }
    },
    'shuffle(Ljava/util/List;)V': (jvm, obj, args) => {
      const list = args[0];
      if (list && list.items) {
        // Fisher-Yates shuffle algorithm
        for (let i = list.items.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [list.items[i], list.items[j]] = [list.items[j], list.items[i]];
        }
      }
    },
    'max(Ljava/util/Collection;)Ljava/lang/Object;': (jvm, obj, args) => {
      const collection = args[0];
      if (!collection || !collection.items || collection.items.length === 0) {
        throw {
          type: 'java/util/NoSuchElementException',
          message: 'Collection is empty'
        };
      }

      let max = collection.items[0];
      for (let i = 1; i < collection.items.length; i++) {
        if (collection.items[i] > max) {
          max = collection.items[i];
        }
      }
      return max;
    },
    'min(Ljava/util/Collection;)Ljava/lang/Object;': (jvm, obj, args) => {
      const collection = args[0];
      if (!collection || !collection.items || collection.items.length === 0) {
        throw {
          type: 'java/util/NoSuchElementException',
          message: 'Collection is empty'
        };
      }

      let min = collection.items[0];
      for (let i = 1; i < collection.items.length; i++) {
        if (collection.items[i] < min) {
          min = collection.items[i];
        }
      }
      return min;
    }
  },
  staticFields: {
    EMPTY_LIST: {
      type: 'java/util/ArrayList',
      items: [],
      size: 0
    },
    EMPTY_SET: {
      type: 'java/util/HashSet',
      items: new Set()
    }
  }
};