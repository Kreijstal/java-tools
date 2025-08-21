module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  staticMethods: {
    'newBuilder()Ljava/net/http/HttpRequest$Builder;': (jvm, args) => {
      return {
        type: 'java/net/http/HttpRequest$Builder',
        uri: null,
        method: 'GET',
        headers: new Map(),
        timeout: null,
        'uri(Ljava/net/URI;)Ljava/net/http/HttpRequest$Builder;': function(jvm, obj, args) {
          this.uri = args[0];
          return this;
        },
        'build()Ljava/net/http/HttpRequest;': function(jvm, obj, args) {
          return {
            type: 'java/net/http/HttpRequest',
            uri: this.uri,
            method: this.method,
            headers: this.headers,
            timeout: this.timeout,
          };
        },
      };
    },
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.uri = null;
      obj.method = 'GET';
      obj.headers = new Map();
      obj.timeout = null;
    },
    'uri()Ljava/net/URI;': (jvm, obj, args) => {
      return obj.uri;
    },
    'method()Ljava/lang/String;': (jvm, obj, args) => {
      return jvm.internString(obj.method || 'GET');
    },
    'headers()Ljava/net/http/HttpHeaders;': (jvm, obj, args) => {
      // Return a simple headers object
      return {
        type: 'java/net/http/HttpHeaders',
        headers: obj.headers || new Map(),
      };
    },
    'timeout()Ljava/util/Optional;': (jvm, obj, args) => {
      // Return Optional.empty() for now
      return {
        type: 'java/util/Optional',
        value: obj.timeout,
        present: !!obj.timeout,
      };
    },
  },
};