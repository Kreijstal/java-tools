function setFields(obj) {
  obj.fields = obj.fields || {};
  obj.fields['java/awt/Point.x'] = obj.x;
  obj.fields['java/awt/Point.y'] = obj.y;
}

module.exports = {
  super: 'java/awt/geom/Point2D',
  fields: {
    'x:I': 0,
    'y:I': 0,
  },
  methods: {
    '<init>()V': (jvm, obj) => {
      obj.x = 0;
      obj.y = 0;
      setFields(obj);
    },
    '<init>(II)V': (jvm, obj, args) => {
      obj.x = args[0];
      obj.y = args[1];
      setFields(obj);
    },
    '<init>(Ljava/awt/Point;)V': (jvm, obj, args) => {
      obj.x = args[0] ? args[0].x : 0;
      obj.y = args[0] ? args[0].y : 0;
      setFields(obj);
    },
    'getX()D': (jvm, obj) => obj.x,
    'getY()D': (jvm, obj) => obj.y,
  },
};
