module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  staticMethods: {
    'newHttpClient()Ljava/net/http/HttpClient;': (jvm, args) => {
      return {
        type: 'java/net/http/HttpClient',
        connectTimeout: null,
        followRedirects: false,
      };
    },
    'newBuilder()Ljava/net/http/HttpClient$Builder;': (jvm, args) => {
      // Return a simple builder - in real implementation this would be more complex
      return {
        type: 'java/net/http/HttpClient$Builder',
        connectTimeout: null,
        followRedirects: false,
        'build()Ljava/net/http/HttpClient;': function(jvm, obj, args) {
          return {
            type: 'java/net/http/HttpClient',
            connectTimeout: this.connectTimeout,
            followRedirects: this.followRedirects,
          };
        },
      };
    },
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.connectTimeout = null;
      obj.followRedirects = false;
    },
    'send(Ljava/net/http/HttpRequest;Ljava/net/http/HttpResponse$BodyHandler;)Ljava/net/http/HttpResponse;': async (jvm, obj, args) => {
      const request = args[0];
      const bodyHandler = args[1];
      
      // Basic HTTP request simulation
      const uri = request.uri || { uriString: { value: 'http://localhost' } };
      const method = request.method || 'GET';
      
      try {
        // In a real implementation, this would make an actual HTTP request
        // For now, return a mock response
        return {
          type: 'java/net/http/HttpResponse',
          statusCode: 200,
          headers: new Map(),
          body: jvm.internString('Mock response body'),
          uri: uri,
        };
      } catch (error) {
        // Throw IOException
        const ioException = {
          type: 'java/io/IOException',
          message: jvm.internString('HTTP request failed: ' + error.message),
        };
        throw ioException;
      }
    },
  },
};