module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  staticMethods: {
    'BodyHandlers.ofString()Ljava/net/http/HttpResponse$BodyHandler;': (jvm, args) => {
      return {
        type: 'java/net/http/HttpResponse$BodyHandler',
        handlerType: 'string',
      };
    },
    'BodyHandlers.ofByteArray()Ljava/net/http/HttpResponse$BodyHandler;': (jvm, args) => {
      return {
        type: 'java/net/http/HttpResponse$BodyHandler',
        handlerType: 'byteArray',
      };
    },
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.statusCode = 0;
      obj.headers = new Map();
      obj.body = null;
      obj.uri = null;
    },
    'statusCode()I': (jvm, obj, args) => {
      return obj.statusCode || 0;
    },
    'headers()Ljava/net/http/HttpHeaders;': (jvm, obj, args) => {
      return {
        type: 'java/net/http/HttpHeaders',
        headers: obj.headers || new Map(),
      };
    },
    'body()Ljava/lang/Object;': (jvm, obj, args) => {
      return obj.body;
    },
    'uri()Ljava/net/URI;': (jvm, obj, args) => {
      return obj.uri;
    },
  },
};