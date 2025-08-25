module.exports = {
  'javax/sound/sampled/Mixer': {
    super: 'javax/sound/sampled/Line',
    methods: {
      // Mixer is an interface, so methods are abstract
    },
  },
  'javax/sound/sampled/Mixer$Info': {
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
        const fields = obj.fields['javax/sound/sampled/Mixer$Info'];
        fields['name'] = name;
        fields['vendor'] = vendor;
        fields['description'] = description;
        fields['version'] = version;
      },
      'getName()Ljava/lang/String;': (jvm, obj, args) => {
        return obj.fields['javax/sound/sampled/Mixer$Info']['name'];
      },
    },
  },
};
