module.exports = {
  'java/io/PrintStream.println': (jvm, obj, args) => {
    console.log(args[0]);
  }
};
