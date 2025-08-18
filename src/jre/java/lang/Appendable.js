module.exports = {
  name: 'java/lang/Appendable',
  isInterface: true,
  methods: [
    {
      name: 'append',
      sig: '(C)Ljava/lang/Appendable;',
      isAbstract: true
    },
    {
      name: 'append',
      sig: '(Ljava/lang/CharSequence;)Ljava/lang/Appendable;',
      isAbstract: true
    },
    {
      name: 'append',
      sig: '(Ljava/lang/CharSequence;II)Ljava/lang/Appendable;',
      isAbstract: true
    }
  ]
};
