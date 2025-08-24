const crypto = require('crypto');

module.exports = {
  'java/security/SecureRandom': {
    '<init>()V': (thread, locals) => {
      thread.return();
    },
    'nextInt()I': (thread, locals) => {
      const buffer = crypto.randomBytes(4);
      thread.pushStack(buffer.readInt32BE(0));
    },
  },
};
