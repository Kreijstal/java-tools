const fetch = require('../../../io/fetch-polyfill');
function javaString(value) {
  if (value === null || value === undefined) return '';
  if (value && value.type === 'java/lang/String' && Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
  return String(value);
}


module.exports = {
  super: 'java/lang/Object',
  staticFields: {},
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.url = args[0];
      return obj;
    },
    'openConnection()Ljava/net/URLConnection;': (jvm, obj, args) => {
      const urlConnection = { type: 'java/net/HttpURLConnection', url: obj.url };
      return urlConnection;
    },
    'getProtocol()Ljava/lang/String;': (jvm, obj, args) => {
      const urlString = javaString(obj.url);
      const protocol = new URL(urlString).protocol.replace(':', '');
      return jvm.internString(protocol);
    },

    '<init>(Ljava/net/URL;Ljava/lang/String;)V': (jvm, obj, args) => {
      const context = args[0];
      const spec = args[1];
      const contextString = javaString(context.url);
      const specString = javaString(spec);

      const newUrl = new URL(specString, contextString);
      obj.url = jvm.internString(newUrl.href);
      return obj;
    },

    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.url;
    },

    'getHost()Ljava/lang/String;': (jvm, obj, args) => {
      const urlString = javaString(obj.url);
      const host = new URL(urlString).hostname;
      return jvm.internString(host);
    },

    'getFile()Ljava/lang/String;': (jvm, obj, args) => {
      const urlString = javaString(obj.url);
      const url = new URL(urlString);
      const file = url.pathname + url.search;
      return jvm.internString(file);
    },

    'openStream()Ljava/io/InputStream;': async (jvm, obj, args) => {
      const urlString = javaString(obj.url);
      let response;
      try {
        response = await fetch(urlString);
      } catch (err) {
        // A network failure on a real JVM surfaces as a checked IOException the
        // caller catches; propagate it as such instead of letting the Node
        // fetch rejection escape as a fatal host error.
        throw { type: 'java/io/IOException', message: `openStream ${urlString}: ${err && err.message ? err.message : String(err)}` };
      }
      let body = response.body;
      if (!body) {
        throw { type: 'java/io/IOException', message: `openStream ${urlString}: no response body` };
      }
      // Node's built-in fetch returns a WHATWG ReadableStream, while the JRE
      // InputStream bridge consumes Node event streams. node-fetch returned
      // the latter, so normalize both implementations at this boundary.
      if (typeof body.on !== 'function' && typeof process !== 'undefined' && process.versions && process.versions.node) {
        const { Readable } = require('stream');
        if (typeof Readable.fromWeb === 'function' && typeof body.getReader === 'function') {
          body = Readable.fromWeb(body);
        }
      }
      if (typeof body.on !== 'function') {
        throw { type: 'java/io/IOException', message: `openStream ${urlString}: unsupported response stream` };
      }

      const inputStream = {
        type: 'java/io/InputStream',
        stream: body,
        _buffer: [],
        _ended: false,
      };

      body.on('data', (chunk) => {
        inputStream._buffer.push(chunk);
      });

      body.on('end', () => {
        inputStream._ended = true;
      });

      return inputStream;
    },
  }
};

// java.net.URL's public constructors declare `throws MalformedURLException` (a checked
// IOException subtype). Record it so callers that don't catch/declare it get an unchecked
// boundary wrap (mirrors the bytecode's real signature). __throws is read by jreMetadata.
module.exports.methods['<init>(Ljava/lang/String;)V'].__throws = ['java/net/MalformedURLException'];
module.exports.methods['<init>(Ljava/net/URL;Ljava/lang/String;)V'].__throws = ['java/net/MalformedURLException'];
