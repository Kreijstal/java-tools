const URLConnection = require('./URLConnection');
const connect = require('./URLConnection')._connect;

module.exports = {
  ...URLConnection,
  'java/net/HttpURLConnection.getResponseCode': async (jvm, obj, args) => {
    await connect(obj);
    return obj.responseCode;
  },
  'java/net/HttpURLConnection.disconnect': (jvm, obj, args) => {
    // no-op
  },
};
