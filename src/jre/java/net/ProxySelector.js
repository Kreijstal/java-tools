module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'getDefault()Ljava/net/ProxySelector;': (jvm, obj, args) => {
      // In a real JRE, this would return a system-wide singleton.
      const selector = {
        type: 'java/net/ProxySelector',
      };
      return selector;
    },
  },
  methods: {
    'select(Ljava/net/URI;)Ljava/util/List;': (jvm, obj, args) => {
      // A simple implementation that indicates no proxy should be used.
      // We return an empty ArrayList.
      const arrayList = {
        type: 'java/util/ArrayList',
        _list: [], // Internal storage for the list's elements
      };
      return arrayList;
    },
  }
};
