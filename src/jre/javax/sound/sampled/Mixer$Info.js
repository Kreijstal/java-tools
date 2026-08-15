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
    'getName()Ljava/lang/String;': (jvm, obj) => {
      return obj.fields['javax/sound/sampled/Mixer$Info']['name'];
    },
    // Games that scan the mixer list usually read getName(), but the other
    // three accessors are part of the same walk often enough to be worth
    // having: a missing method aborts the scan mid-loop.
    'getVendor()Ljava/lang/String;': (jvm, obj) => {
      return obj.fields['javax/sound/sampled/Mixer$Info']['vendor'];
    },
    'getDescription()Ljava/lang/String;': (jvm, obj) => {
      return obj.fields['javax/sound/sampled/Mixer$Info']['description'];
    },
    'getVersion()Ljava/lang/String;': (jvm, obj) => {
      return obj.fields['javax/sound/sampled/Mixer$Info']['version'];
    },
    'toString()Ljava/lang/String;': (jvm, obj) => {
      const info = obj.fields['javax/sound/sampled/Mixer$Info'];
      const text = (value) => (value && value.value !== undefined
        ? value.value
        : String(value == null ? '' : value));
      return jvm.internString(
        text(info['name']) + ', version ' + text(info['version']));
    },
  },
};
