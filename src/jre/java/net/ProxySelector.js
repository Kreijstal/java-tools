module.exports = {
  // Static method
  'getDefault()Ljava/net/ProxySelector;': (jvm, frame, locals) => {
    // In a real JRE, this would return a system-wide singleton.
    // For this implementation, we create a new one each time.
    const selector = jvm.new_class('java/net/ProxySelector');
    jvm.push_stack(selector);
  },

  'select(Ljava/net/URI;)Ljava/util/List;': (jvm, frame, locals) => {
    const thisSelector = locals[0];
    const uri = locals[1];

    // A simple implementation that indicates no proxy should be used.
    // The Java documentation says that a list containing only Proxy.NO_PROXY
    // should be returned for direct connections.
    // A robust implementation would inspect system properties or OS settings.
    // Here, we return an empty list, which is a valid return value,
    // although less explicit than returning a list with NO_PROXY.
    const arrayList = jvm.new_class('java/util/ArrayList');
    // Assuming new_class also calls the default constructor.
    jvm.push_stack(arrayList);
  },
};
