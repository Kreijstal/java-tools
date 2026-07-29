module.exports = {
  isInterface: true,
  super: null,
  methods: {
    'lastModifiedTime()Ljava/nio/file/attribute/FileTime;': (jvm, obj) => ({
      type: 'java/nio/file/attribute/FileTime',
      millis: BigInt(Math.trunc(obj.stats.mtimeMs)),
    }),
    'lastAccessTime()Ljava/nio/file/attribute/FileTime;': (jvm, obj) => ({
      type: 'java/nio/file/attribute/FileTime',
      millis: BigInt(Math.trunc(obj.stats.atimeMs)),
    }),
    'creationTime()Ljava/nio/file/attribute/FileTime;': (jvm, obj) => ({
      type: 'java/nio/file/attribute/FileTime',
      millis: BigInt(Math.trunc(obj.stats.birthtimeMs || obj.stats.ctimeMs)),
    }),
    'isRegularFile()Z': (jvm, obj) => obj.stats.isFile() ? 1 : 0,
    'isDirectory()Z': (jvm, obj) => obj.stats.isDirectory() ? 1 : 0,
    'isSymbolicLink()Z': (jvm, obj) => obj.stats.isSymbolicLink() ? 1 : 0,
    'isOther()Z': (jvm, obj) =>
      !obj.stats.isFile() && !obj.stats.isDirectory() && !obj.stats.isSymbolicLink() ? 1 : 0,
    'size()J': (jvm, obj) => BigInt(obj.stats.size),
    'fileKey()Ljava/lang/Object;': () => null,
  },
};
