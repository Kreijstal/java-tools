module.exports = {
  super: 'java/lang/Object',
  fields: {
    'name': 'Ljava/lang/String;',
    'vendor': 'Ljava/lang/String;',
    'description': 'Ljava/lang/String;',
    'version': 'Ljava/lang/String;',
  },
  methods: {
    '<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (jvm, obj, args) => {
      const [name, vendor, description, version] = args;
      obj.fields['javax/sound/sampled/Mixer$Info'] = {
        name,
        vendor,
        description,
        version,
      };
    },
    'getName()Ljava/lang/String;': (jvm, obj, args) => {
      return obj.fields['javax/sound/sampled/Mixer$Info']['name'];
    },
  },
};
