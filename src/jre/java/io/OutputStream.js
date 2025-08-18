module.exports = {
  name: 'java/io/OutputStream',
  isAbstract: true,
  methods: [
    {
      name: 'close',
      sig: '()V',
      code: () => {}
    },
    {
      name: 'flush',
      sig: '()V',
      code: () => {}
    },
    {
      name: 'write',
      sig: '([B)V',
      code: (jvm, obj, args) => {
        const b = args[0];
        if (b === null) {
          jvm.throwException('java/lang/NullPointerException');
          return;
        }
        obj.callMethod(jvm, 'write', '([BII)V', [b, 0, b.length]);
      }
    },
    {
      name: 'write',
      sig: '([BII)V',
      code: (jvm, obj, args) => {
        const b = args[0];
        const off = args[1];
        const len = args[2];

        if (b === null) {
          jvm.throwException('java/lang/NullPointerException');
          return;
        }
        if (off < 0 || len < 0 || off + len > b.length) {
          jvm.throwException('java/lang/IndexOutOfBoundsException');
          return;
        }

        for (let i = 0; i < len; i++) {
          obj.callMethod(jvm, 'write', '(I)V', [b[off + i]]);
        }
      }
    },
    {
      name: 'write',
      sig: '(I)V',
      isAbstract: true
    }
  ]
};
