module.exports = {
  super: 'java/lang/Object',
  fields: {
    'id:I': 0,
    'target:Ljava/lang/Object;': null,
    'arg:Ljava/lang/Object;': null,
    'when:J': 0n,
    'x:I': 0,
    'y:I': 0,
    'key:I': 0,
    'modifiers:I': 0,
    'clickCount:I': 0,
  },
  staticFields: {
    // Legacy java.awt.Event ids
    'ACTION_EVENT:I': 401,
    'MOUSE_DOWN:I': 501,
    'MOUSE_UP:I': 502,
    'MOUSE_MOVE:I': 503,
    'MOUSE_ENTER:I': 504,
    'MOUSE_EXIT:I': 505,
    'MOUSE_DRAG:I': 506,
    'KEY_PRESS:I': 401,
    'KEY_ACTION:I': 403,
    'KEY_RELEASE:I': 402,
    'KEY_ACTION_RELEASE:I': 404,
    'WINDOW_DESTROY:I': 201,
    'SCROLL_LINE_UP:I': 602,
    'SCROLL_LINE_DOWN:I': 603,
    'SCROLL_PAGE_UP:I': 604,
    'SCROLL_PAGE_DOWN:I': 605,
    'SCROLL_ABSOLUTE:I': 606,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      obj.id = 0;
      obj.fields = obj.fields || {};
      obj.fields['java/awt/Event.id'] = 0;
    },
    // Legacy AWT Event: Event(Object target, long when, int id, int x, int y,
    // int key, int modifiers) and the shortened variants.
    '<init>(Ljava/lang/Object;IJ)V': (jvm, obj, args) => {
      obj.target = args[0];
      obj.id = args[2] || 0;
      obj.when = Number(args[1] || 0);
      obj.x = 0;
      obj.y = 0;
      obj.fields = obj.fields || {};
      obj.fields['java/awt/Event.id'] = obj.id;
    },
    '<init>(Ljava/lang/Object;IJIIII)V': (jvm, obj, args) => {
      obj.target = args[0];
      obj.id = args[2] || 0;
      obj.when = Number(args[1] || 0);
      obj.x = args[3] || 0;
      obj.y = args[4] || 0;
      obj.key = args[5] || 0;
      obj.modifiers = args[6] || 0;
      obj.fields = obj.fields || {};
      obj.fields['java/awt/Event.id'] = obj.id;
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return 'java.awt.Event[source=' + String(obj.target && obj.target.type || obj.target) + ']';
    },
  },
};
