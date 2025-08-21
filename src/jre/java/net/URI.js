module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      const uriString = args[0];
      obj.uriString = uriString;
      // Simple parsing - in a real implementation this would be more complex
      try {
        const url = new URL(uriString.value);
        obj.scheme = jvm.internString(url.protocol.replace(':', ''));
        obj.host = jvm.internString(url.hostname || '');
        obj.port = url.port ? parseInt(url.port) : -1;
        obj.path = jvm.internString(url.pathname || '');
        obj.query = jvm.internString(url.search ? url.search.substring(1) : '');
        obj.fragment = jvm.internString(url.hash ? url.hash.substring(1) : '');
      } catch (e) {
        // If URL parsing fails, store basic info
        obj.scheme = null;
        obj.host = null;
        obj.port = -1;
        obj.path = null;
        obj.query = null;
        obj.fragment = null;
      }
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.uriString || jvm.internString('');
    },
    'getScheme()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.scheme;
    },
    'getHost()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.host;
    },
    'getPort()I': (jvm, obj, args) => {
      return obj.port;
    },
    'getPath()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.path;
    },
    'getQuery()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.query;
    },
    'getFragment()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.fragment;
    },
  },
};