module.exports = {
  super: null,
  name: 'java/lang/CharSequence',
  isInterface: true,
  methods: {
    'length()I': { isAbstract: true },
    'charAt(I)C': { isAbstract: true },
    'subSequence(II)Ljava/lang/CharSequence;': { isAbstract: true },
    'toString()Ljava/lang/String;': { isAbstract: true }
  }
};