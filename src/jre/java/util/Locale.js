module.exports = {
  super: 'java/lang/Object',
  methods: {
    '<init>(Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.language = value(args[0]);
      obj.country = '';
      obj.variant = '';
    },
    '<init>(Ljava/lang/String;Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.language = value(args[0]);
      obj.country = value(args[1]);
      obj.variant = '';
    },
    '<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (jvm, obj, args) => {
      obj.language = value(args[0]);
      obj.country = value(args[1]);
      obj.variant = value(args[2]);
    },
    'getLanguage()Ljava/lang/String;': (jvm, obj) => jvm.internString(obj.language || ''),
    'getCountry()Ljava/lang/String;': (jvm, obj) => jvm.internString(obj.country || ''),
    'getVariant()Ljava/lang/String;': (jvm, obj) => jvm.internString(obj.variant || ''),
    'getDisplayName()Ljava/lang/String;': (jvm, obj) => jvm.internString(localeName(obj)),
    'toString()Ljava/lang/String;': (jvm, obj) => jvm.internString(localeName(obj)),
  },
};

function value(input) {
  return input && Object.prototype.hasOwnProperty.call(input, 'value') ? String(input.value) : String(input || '');
}

function localeName(locale) {
  return [locale.language, locale.country, locale.variant].filter(Boolean).join('_');
}
