const jreClasses = {
  'java/lang/Object': require('./java/lang/Object'),
  'java/lang/System': require('./java/lang/System'),
  'java/lang/Class': require('./java/lang/Class'),
  'java/lang/String': require('./java/lang/String'),
  'java/lang/StringBuilder': require('./java/lang/StringBuilder'),
  'java/lang/Thread': require('./java/lang/Thread'),
  'java/lang/IllegalArgumentException': require('./java/lang/IllegalArgumentException'),
  'java/lang/NoSuchMethodException': require('./java/lang/NoSuchMethodException'),
  'java/lang/invoke/LambdaMetafactory': require('./java/lang/invoke/LambdaMetafactory'),
  'java/lang/reflect/Method': require('./java/lang/reflect/Method'),
  'java/io/InputStreamReader': require('./java/io/InputStreamReader'),
  'java/io/BufferedReader': require('./java/io/BufferedReader'),
  'java/io/BufferedInputStream': require('./java/io/BufferedInputStream'),
  'java/io/PrintStream': require('./java/io/PrintStream'),
  'java/net/URL': require('./java/net/URL'),
  'java/net/URLConnection': require('./java/net/URLConnection'),
  'java/net/HttpURLConnection': require('./java/net/HttpURLConnection'),
  'java/util/LinkedList': require('./java/util/LinkedList'),
};

module.exports = jreClasses;
