const handleSystem = require('./java/lang/System');
const handleInputStreamReader = require('./java/io/InputStreamReader');
const handleBufferedReader = require('./java/io/BufferedReader');
const handleBufferedInputStream = require('./java/io/BufferedInputStream');
const handlePrintStream = require('./java/io/PrintStream');

const jreMethods = {
  ...handleSystem,
  ...handleInputStreamReader,
  ...handleBufferedReader,
  ...handleBufferedInputStream,
  ...handlePrintStream,
  'java/lang/String.concat': (jvm, str, args) => str + args[0],
  'java/lang/String.toUpperCase': (jvm, str, args) => str.toUpperCase(),
  'java/lang/String.toLowerCase': (jvm, str, args) => str.toLowerCase(),
  'java/lang/String.length': (jvm, str, args) => str.length,
};

module.exports = jreMethods;
