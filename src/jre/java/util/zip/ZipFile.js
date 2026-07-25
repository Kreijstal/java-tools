const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

function javaString(value) {
  if (value === null || value === undefined) return '';
  if (value && value.type === 'java/lang/String' && Object.prototype.hasOwnProperty.call(value, 'value')) return String(value.value);
  return String(value);
}

function byteArray(jvm, bytes) {
  const array = Array.from(bytes, b => (b << 24) >> 24);
  array.type = '[B';
  array.elementType = 'byte';
  array.length = array.length;
  array.hashCode = jvm.nextHashCode++;
  return array;
}

function makeEntry(jvm, name, zipObject) {
  return {
    type: 'java/util/zip/ZipEntry',
    name,
    zipObject,
    size: BigInt(zipObject && typeof zipObject._data?.uncompressedSize === 'number' ? zipObject._data.uncompressedSize : -1),
    directory: !!(zipObject && zipObject.dir),
    hashCode: jvm.nextHashCode++,
  };
}

async function openZip(jvm, obj, zipPath) {
  const resolved = path.resolve(zipPath);
  try {
    const stats = await fs.promises.stat(resolved);
    if (!stats.isFile()) {
      jvm.throwException('java/io/IOException', `${resolved} is not a file`);
    }
    const data = await fs.promises.readFile(resolved);
    obj.path = resolved;
    obj.zip = await JSZip.loadAsync(data);
    obj.closed = false;
  } catch (error) {
    if (error && error.type) throw error;
    jvm.throwException('java/io/IOException', error && error.message ? error.message : String(error));
  }
}

module.exports = {
  super: 'java/lang/Object',
  staticFields: {
    'OPEN_READ:I': 1,
    'OPEN_DELETE:I': 4,
  },
  methods: {
    '<init>(Ljava/lang/String;)V': async (jvm, obj, args) => {
      await openZip(jvm, obj, javaString(args[0]));
    },
    '<init>(Ljava/io/File;)V': async (jvm, obj, args) => {
      await openZip(jvm, obj, args[0].path);
    },
    '<init>(Ljava/io/File;I)V': async (jvm, obj, args) => {
      await openZip(jvm, obj, args[0].path);
    },
    'getEntry(Ljava/lang/String;)Ljava/util/zip/ZipEntry;': (jvm, obj, args) => {
      const name = javaString(args[0]);
      const entry = obj.zip && obj.zip.file(name);
      if (!entry) return null;
      return makeEntry(jvm, name, entry);
    },
    'entries()Ljava/util/Enumeration;': (jvm, obj) => {
      const entries = [];
      if (obj.zip) {
        obj.zip.forEach((name, zipObject) => {
          entries.push(makeEntry(jvm, name, zipObject));
        });
      }
      return { type: 'java/util/Enumeration', array: entries, index: 0, hashCode: jvm.nextHashCode++ };
    },
    'getInputStream(Ljava/util/zip/ZipEntry;)Ljava/io/InputStream;': async (jvm, obj, args) => {
      const entry = args[0];
      if (entry === null) {
        jvm.throwException('java/lang/NullPointerException');
      }
      const zipObject = entry.zipObject || (obj.zip && obj.zip.file(entry.name));
      if (!zipObject) return null;
      const data = await zipObject.async('uint8array');
      const bytes = byteArray(jvm, data);
      return {
        type: 'java/io/ByteArrayInputStream',
        buf: bytes,
        pos: 0,
        mark: 0,
        count: bytes.length,
        hashCode: jvm.nextHashCode++,
      };
    },
    'close()V': (jvm, obj) => {
      obj.closed = true;
      obj.zip = null;
    },
  },
};
