const { getLegacyPlatform } = require('../../../platform/legacy');

module.exports = {
  super: 'java/lang/Object',
  isAbstract: true,
  methods: {
    'call(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/Object;': (jvm, obj, args) => {
      const target = getTarget(obj);
      const method = target && target[toJsString(args[0])];
      if (typeof method !== 'function') return null;
      return method.apply(target, toJsArray(args[1]));
    },
    'eval(Ljava/lang/String;)Ljava/lang/Object;': (jvm, obj, args) => {
      const target = getTarget(obj);
      if (!target || typeof target.eval !== 'function') return null;
      return target.eval(toJsString(args[0]));
    },
    'getMember(Ljava/lang/String;)Ljava/lang/Object;': (jvm, obj, args) => {
      const target = getTarget(obj);
      return target ? target[toJsString(args[0])] ?? null : null;
    },
    'setMember(Ljava/lang/String;Ljava/lang/Object;)V': (jvm, obj, args) => {
      const target = getTarget(obj);
      if (target) target[toJsString(args[0])] = args[1];
    },
    'removeMember(Ljava/lang/String;)V': (jvm, obj, args) => {
      const target = getTarget(obj);
      if (target) delete target[toJsString(args[0])];
    },
    'getSlot(I)Ljava/lang/Object;': (jvm, obj, args) => {
      const target = getTarget(obj);
      return target ? target[args[0]] ?? null : null;
    },
    'setSlot(ILjava/lang/Object;)V': (jvm, obj, args) => {
      const target = getTarget(obj);
      if (target) target[args[0]] = args[1];
    },
  },
  staticMethods: {
    'getWindow(Ljava/applet/Applet;)Lnetscape/javascript/JSObject;': () => {
      const target = getLegacyPlatform().getWindowObject();
      return target ? { type: 'netscape/javascript/JSObject', _target: target } : null;
    },
  },
};

function getTarget(obj) {
  return obj && obj._target ? obj._target : null;
}

function toJsString(value) {
  return value == null ? '' : String(value.valueOf ? value.valueOf() : value);
}

function toJsArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.elements)) return value.elements;
  return [];
}
