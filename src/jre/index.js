const handleObject = require('./java/lang/Object');
const handleSystem = require('./java/lang/System');
const handleClass = require('./java/lang/Class');
const handleReflect = require('./java/lang/reflect');
const handleInputStreamReader = require('./java/io/InputStreamReader');
const handleBufferedReader = require('./java/io/BufferedReader');
const handleBufferedInputStream = require('./java/io/BufferedInputStream');
const handlePrintStream = require('./java/io/PrintStream');
const handleURL = require('./java/net/URL');
const handleURLConnection = require('./java/net/URLConnection');
const handleHttpURLConnection = require('./java/net/HttpURLConnection');
const handleStringBuilder = require('./java/lang/StringBuilder');
const handleIllegalArgumentException = require('./java/lang/IllegalArgumentException');
const handleThread = require('./java/lang/Thread');
const handleNoSuchMethodException = require('./java/lang/NoSuchMethodException');
const handleLinkedList = require('./java/util/LinkedList');

const jreMethods = {
  ...handleLinkedList,
  ...handleStringBuilder,
  ...handleIllegalArgumentException,
  ...handleNoSuchMethodException,
  ...handleThread,
  ...handleObject,
  ...handleSystem,
  ...handleClass,
  ...handleReflect,
  ...handleInputStreamReader,
  ...handleBufferedReader,
  ...handleBufferedInputStream,
  ...handlePrintStream,
  ...handleURL,
  ...handleURLConnection,
  ...handleHttpURLConnection,
  'java/lang/String.concat(Ljava/lang/String;)Ljava/lang/String;': (jvm, str, args) => str + args[0],
  'java/lang/String.toUpperCase()Ljava/lang/String;': (jvm, str, args) => str.toUpperCase(),
  'java/lang/String.toLowerCase()Ljava/lang/String;': (jvm, str, args) => str.toLowerCase(),
  'java/lang/String.length()I': (jvm, str, args) => str.length,
  'java/lang/String.equals(Ljava/lang/Object;)Z': (jvm, str, args) => str === args[0],
};

module.exports = jreMethods;
