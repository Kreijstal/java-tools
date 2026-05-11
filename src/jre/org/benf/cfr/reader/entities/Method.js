const METHOD_CLASS = 'org/benf/cfr/reader/entities/Method';
const JAVA_REF_TYPE = 'org/benf/cfr/reader/bytecode/analysis/types/JavaRefTypeInstance';

function runtimeClassName(obj) {
  return obj && (obj._className || obj.type);
}

function fieldValue(obj, fieldName) {
  if (!obj || !obj.fields) return undefined;
  const exact = `${METHOD_CLASS}.${fieldName}`;
  if (Object.prototype.hasOwnProperty.call(obj.fields, exact)) return obj.fields[exact];
  const key = Object.keys(obj.fields).find(k => k.endsWith(`.${fieldName}`));
  return key ? obj.fields[key] : undefined;
}

function ensureMap(mapObj) {
  if (!mapObj) return null;
  if (mapObj.map instanceof Map) return mapObj.map;
  if (mapObj.entries instanceof Map) {
    mapObj.map = mapObj.entries;
    return mapObj.map;
  }
  mapObj.map = new Map();
  mapObj.entries = mapObj.map;
  return mapObj.map;
}

module.exports = {
  methods: {
    'markUsedLocalClassType(Lorg/benf/cfr/reader/bytecode/analysis/types/JavaTypeInstance;Ljava/lang/String;)V': async (jvm, obj, args) => {
      const type = args[0];
      const name = args[1];
      if (!type) return;
      const isRef = await jvm.isInstanceOfAsync(runtimeClassName(type), JAVA_REF_TYPE);
      if (!isRef) return;
      const localClasses = ensureMap(fieldValue(obj, 'localClasses'));
      if (localClasses) localClasses.set(type, name || null);
    },
    'markUsedLocalClassType(Lorg/benf/cfr/reader/bytecode/analysis/types/JavaTypeInstance;)V': async (jvm, obj, args) => {
      const method = module.exports.methods['markUsedLocalClassType(Lorg/benf/cfr/reader/bytecode/analysis/types/JavaTypeInstance;Ljava/lang/String;)V'];
      return method(jvm, obj, [args[0], null]);
    },
  },
};
