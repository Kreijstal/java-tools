function javaString(value) {
  if (value === null || value === undefined) return '';
  if (value && value.type === 'java/lang/String' && Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
  return String(value);
}

function makeLogger(jvm, name) {
  return { type: 'java/util/logging/Logger', name, handlers: [], level: null, useParentHandlers: true, hashCode: jvm.nextHashCode++ };
}

module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'getLogger(Ljava/lang/String;)Ljava/util/logging/Logger;': (jvm, obj, args) => makeLogger(jvm, javaString(args[0])),
    'getLogger(Ljava/lang/String;Ljava/lang/String;)Ljava/util/logging/Logger;': (jvm, obj, args) => makeLogger(jvm, javaString(args[0])),
    'getAnonymousLogger()Ljava/util/logging/Logger;': (jvm) => makeLogger(jvm, ''),
  },
  methods: {
    '<init>()V': (jvm, obj) => { obj.handlers = []; obj.level = null; obj.useParentHandlers = true; },
    'setUseParentHandlers(Z)V': (jvm, obj, args) => { obj.useParentHandlers = !!args[0]; },
    'getUseParentHandlers()Z': (jvm, obj) => (obj.useParentHandlers ? 1 : 0),
    'addHandler(Ljava/util/logging/Handler;)V': (jvm, obj, args) => { if (!obj.handlers) obj.handlers = []; obj.handlers.push(args[0]); },
    'removeHandler(Ljava/util/logging/Handler;)V': (jvm, obj, args) => { if (obj.handlers) obj.handlers = obj.handlers.filter(h => h !== args[0]); },
    'setLevel(Ljava/util/logging/Level;)V': (jvm, obj, args) => { obj.level = args[0]; },
    'getLevel()Ljava/util/logging/Level;': (jvm, obj) => obj.level || null,
    'isLoggable(Ljava/util/logging/Level;)Z': () => 0,
    'log(Ljava/util/logging/Level;Ljava/lang/String;)V': () => {},
    'log(Ljava/util/logging/Level;Ljava/lang/String;Ljava/lang/Throwable;)V': () => {},
    'log(Ljava/util/logging/Level;Ljava/lang/String;[Ljava/lang/Object;)V': () => {},
    'info(Ljava/lang/String;)V': () => {},
    'warning(Ljava/lang/String;)V': () => {},
    'severe(Ljava/lang/String;)V': () => {},
    'fine(Ljava/lang/String;)V': () => {},
    'finer(Ljava/lang/String;)V': () => {},
    'finest(Ljava/lang/String;)V': () => {},
    'config(Ljava/lang/String;)V': () => {},
  },
};
