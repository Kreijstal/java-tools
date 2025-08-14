module.exports = {
  'java/io/PrintStream.println(Ljava/lang/String;)V': (jvm, obj, args) => {
    console.log(args[0]);
  },
  'java/io/PrintStream.println(I)V': (jvm, obj, args) => {
    console.log(args[0]);
  },
  'java/io/PrintStream.println([C)V': (jvm, obj, args) => {
    console.log(String.fromCharCode.apply(null, args[0]));
  },
  'java/io/PrintStream.println(Ljava/lang/Object;)V': (jvm, obj, args) => {
    // This is a simplification. In a real JVM, it would call the object's toString() method.
    // For now, we'll just log the object directly.
    console.log(args[0]);
  },
  'java/io/PrintStream.println()V': (jvm, obj, args) => {
    console.log();
  },
  'java/io/PrintStream.println(Z)V': (jvm, obj, args) => {
    console.log(args[0] === 1 ? 'true' : 'false');
  },
};
