const zlib = require('zlib');

module.exports = {
  'java/util/zip/Inflater': {
    '<init>(Z)V': (thread, locals) => {
      const self = locals[0];
      const nowrap = locals[1];
      self['java/util/zip/Inflater/inflater'] = zlib.createInflateRaw({
        windowBits: nowrap ? 0 : 15,
      });
      self['java/util/zip/Inflater/buffer'] = null;
      thread.return();
    },
    'setInput([BII)V': (thread, locals) => {
      const self = locals[0];
      const b = locals[1].array;
      const off = locals[2];
      const len = locals[3];
      self['java/util/zip/Inflater/buffer'] = b.slice(off, off + len);
      thread.return();
    },
    'inflate([B)I': (thread, locals) => {
      const self = locals[0];
      const b = locals[1].array;
      const inflater = self['java/util/zip/Inflater/inflater'];
      const buffer = self['java/util/zip/Inflater/buffer'];
      if (buffer) {
        inflater.write(buffer);
      }
      const result = inflater.read();
      if (result) {
        result.copy(b);
        thread.pushStack(result.length);
      } else {
        thread.pushStack(0);
      }
    },
    'reset()V': (thread, locals) => {
      const self = locals[0];
      self['java/util/zip/Inflater/inflater'].reset();
      self['java/util/zip/Inflater/buffer'] = null;
      thread.return();
    },
  },
};
