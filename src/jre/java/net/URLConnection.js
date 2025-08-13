async function _connect(obj) {
  if (obj.connected) {
    return;
  }

  const response = await fetch(obj.url);
  const text = await response.text();

  obj.responseCode = response.status;
  obj.body = text;
  obj.connected = true;
}

module.exports = {
  _connect: _connect,
  'java/net/URLConnection.getInputStream': async (jvm, obj, args) => {
    await _connect(obj);
    const text = obj.body;
    let index = 0;

    const inputStream = { type: 'java/io/InputStream' };
    inputStream['java/io/InputStream'] = {
      read: () => {
        if (index < text.length) {
          return text.charCodeAt(index++);
        } else {
          return -1;
        }
      },
    };

    return inputStream;
  },
};
