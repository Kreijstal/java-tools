const { URL } = require('url');

module.exports = {
  '<init>(Ljava/lang/String;)V': (jvm, frame, locals) => {
    const thisUrl = locals[0];
    const urlString = locals[1];
    const jsUrlString = jvm.interned_string_to_string(urlString);

    try {
      const parsed = new URL(jsUrlString);
      thisUrl.set_field('java/net/URL', 'urlString', 'Ljava/lang/String;', urlString);
      thisUrl.set_field('java/net/URL', 'protocol', 'Ljava/lang/String;', jvm.intern_string(parsed.protocol.replace(':', '')));
      thisUrl.set_field('java/net/URL', 'host', 'Ljava/lang/String;', jvm.intern_string(parsed.hostname));
      thisUrl.set_field('java/net/URL', 'port', 'I', parsed.port ? parseInt(parsed.port) : -1);
      const file = parsed.pathname + parsed.search;
      thisUrl.set_field('java/net/URL', 'file', 'Ljava/lang/String;', jvm.intern_string(file));
    } catch (e) {
      // In a real implementation, we should throw MalformedURLException.
      // For now, we'll leave fields uninitialized, which will likely cause NullPointerException later.
    }
  },

  '<init>(Ljava/net/URL;Ljava/lang/String;)V': (jvm, frame, locals) => {
    const thisUrl = locals[0];
    const context = locals[1];
    const spec = locals[2];

    const contextString = jvm.interned_string_to_string(context.get_field('java/net/URL', 'urlString', 'Ljava/lang/String;'));
    const specString = jvm.interned_string_to_string(spec);

    try {
      const parsed = new URL(specString, contextString);
      const fullUrlString = jvm.intern_string(parsed.href);
      thisUrl.set_field('java/net/URL', 'urlString', 'Ljava/lang/String;', fullUrlString);
      thisUrl.set_field('java/net/URL', 'protocol', 'Ljava/lang/String;', jvm.intern_string(parsed.protocol.replace(':', '')));
      thisUrl.set_field('java/net/URL', 'host', 'Ljava/lang/String;', jvm.intern_string(parsed.hostname));
      thisUrl.set_field('java/net/URL', 'port', 'I', parsed.port ? parseInt(parsed.port) : -1);
      const file = parsed.pathname + parsed.search;
      thisUrl.set_field('java/net/URL', 'file', 'Ljava/lang/String;', jvm.intern_string(file));
    } catch (e) {
      // MalformedURLException
    }
  },

  'toString()Ljava/lang/String;': (jvm, frame, locals) => {
    const thisUrl = locals[0];
    const urlString = thisUrl.get_field('java/net/URL', 'urlString', 'Ljava/lang/String;');
    jvm.push_stack(urlString);
  },

  'getHost()Ljava/lang/String;': (jvm, frame, locals) => {
    const thisUrl = locals[0];
    const host = thisUrl.get_field('java/net/URL', 'host', 'Ljava/lang/String;');
    jvm.push_stack(host);
  },

  'getFile()Ljava/lang/String;': (jvm, frame, locals) => {
    const thisUrl = locals[0];
    const file = thisUrl.get_field('java/net/URL', 'file', 'Ljava/lang/String;');
    jvm.push_stack(file);
  },

  'getProtocol()Ljava/lang/String;': (jvm, frame, locals) => {
    const thisUrl = locals[0];
    const protocol = thisUrl.get_field('java/net/URL', 'protocol', 'Ljava/lang/String;');
    jvm.push_stack(protocol);
  },

  'openConnection()Ljava/net/URLConnection;': (jvm, frame, locals) => {
    const thisUrl = locals[0];
    const protocol = jvm.interned_string_to_string(thisUrl.get_field('java/net/URL', 'protocol', 'Ljava/lang/String;'));

    let connection;
    if (protocol === 'http' || protocol === 'https') {
      connection = jvm.new_class('java/net/HttpURLConnection');
    } else {
      // Other protocols would have different connection types.
      connection = jvm.new_class('java/net/URLConnection');
    }
    connection.set_field('java/net/URLConnection', 'url', 'Ljava/net/URL;', thisUrl);
    jvm.push_stack(connection);
  },

  'openStream()Ljava/io/InputStream;': (jvm, frame, locals) => {
    // This is a shorthand for openConnection().getInputStream().
    // Since we don't have a full implementation of URLConnection,
    // and specifically getInputStream(), we return null.
    jvm.push_stack(null);
  },
};
