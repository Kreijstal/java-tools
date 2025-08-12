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
  ...handlePrintStream
};

module.exports = jreMethods;
