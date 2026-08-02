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
    'ACTION_EVENT:I': 1001,
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
    'SCROLL_LINE_UP:I': 601,
    'SCROLL_LINE_DOWN:I': 602,
    'SCROLL_PAGE_UP:I': 603,
    'SCROLL_PAGE_DOWN:I': 604,
    'SCROLL_ABSOLUTE:I': 605,
    'SCROLL_BEGIN:I': 606,
    'SCROLL_END:I': 607,
  },
  methods: {
    '<init>()V': (jvm, obj, args) => {
      initializeEvent(obj, {});
    },
    '<init>(Ljava/lang/Object;ILjava/lang/Object;)V': (jvm, obj, args) => {
      initializeEvent(obj, {
        target: args[0],
        id: args[1],
        arg: args[2],
      });
    },
    '<init>(Ljava/lang/Object;JIIIII)V': (jvm, obj, args) => {
      initializeEvent(obj, {
        target: args[0],
        when: args[1],
        id: args[2],
        x: args[3],
        y: args[4],
        key: args[5],
        modifiers: args[6],
      });
    },
    '<init>(Ljava/lang/Object;JIIIIILjava/lang/Object;)V': (jvm, obj, args) => {
      initializeEvent(obj, {
        target: args[0],
        when: args[1],
        id: args[2],
        x: args[3],
        y: args[4],
        key: args[5],
        modifiers: args[6],
        arg: args[7],
      });
    },
    'toString()Ljava/lang/String;': (jvm, obj, args) => {
      return 'java.awt.Event[source=' + String(obj.target && obj.target.type || obj.target) + ']';
    },
  },
};

function initializeEvent(obj, values) {
  const when = values.when == null ? 0n : BigInt(values.when);
  obj.target = values.target ?? null;
  obj.when = Number(when);
  obj.id = values.id || 0;
  obj.x = values.x || 0;
  obj.y = values.y || 0;
  obj.key = values.key || 0;
  obj.modifiers = values.modifiers || 0;
  obj.arg = values.arg ?? null;
  obj.clickCount = values.clickCount || 0;
  obj.fields = obj.fields || {};
  obj.fields['java/awt/Event.target'] = obj.target;
  obj.fields['java/awt/Event.when'] = when;
  obj.fields['java/awt/Event.id'] = obj.id;
  obj.fields['java/awt/Event.x'] = obj.x;
  obj.fields['java/awt/Event.y'] = obj.y;
  obj.fields['java/awt/Event.key'] = obj.key;
  obj.fields['java/awt/Event.modifiers'] = obj.modifiers;
  obj.fields['java/awt/Event.arg'] = obj.arg;
  obj.fields['java/awt/Event.clickCount'] = obj.clickCount;
}
