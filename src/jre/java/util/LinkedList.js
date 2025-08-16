module.exports = {
  'java/util/LinkedList.<init>()V': (jvm, obj, args) => {
    obj.list = [];
  },
  'java/util/LinkedList.size()I': (jvm, obj, args) => {
    return obj.list.length;
  },
  'java/util/LinkedList.add(Ljava/lang/Object;)Z': (jvm, obj, args) => {
    obj.list.push(args[0]);
    return true;
  },
  'java/util/LinkedList.removeFirst()Ljava/lang/Object;': (jvm, obj, args) => {
    return obj.list.shift();
  },
};
