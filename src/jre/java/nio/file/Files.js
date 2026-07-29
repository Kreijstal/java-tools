const fs = require('fs');

function noFollowLinks(options) {
  return Array.from(options || []).some((option) => {
    if (!option) return false;
    const name = option.name !== undefined ? option.name :
      (option.value !== undefined ? option.value : option.enumName);
    return String(name) === 'NOFOLLOW_LINKS';
  });
}

function statPath(jvm, target, options) {
  try {
    return noFollowLinks(options) ? fs.lstatSync(target.path) : fs.statSync(target.path);
  } catch (error) {
    jvm.throwException('java/io/IOException', error.message);
    return null;
  }
}

module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'readAttributes(Ljava/nio/file/Path;Ljava/lang/Class;[Ljava/nio/file/LinkOption;)Ljava/nio/file/attribute/BasicFileAttributes;':
      (jvm, obj, args) => ({
        type: 'java/nio/file/attribute/BasicFileAttributes',
        stats: statPath(jvm, args[0], args[2]),
      }),
    'exists(Ljava/nio/file/Path;[Ljava/nio/file/LinkOption;)Z': (jvm, obj, args) => {
      try {
        if (noFollowLinks(args[1])) fs.lstatSync(args[0].path);
        else fs.statSync(args[0].path);
        return 1;
      } catch (error) {
        return 0;
      }
    },
    'isDirectory(Ljava/nio/file/Path;[Ljava/nio/file/LinkOption;)Z': (jvm, obj, args) => {
      try {
        const stats = noFollowLinks(args[1])
          ? fs.lstatSync(args[0].path)
          : fs.statSync(args[0].path);
        return stats.isDirectory() ? 1 : 0;
      } catch (error) {
        return 0;
      }
    },
    'isRegularFile(Ljava/nio/file/Path;[Ljava/nio/file/LinkOption;)Z': (jvm, obj, args) => {
      try {
        const stats = noFollowLinks(args[1])
          ? fs.lstatSync(args[0].path)
          : fs.statSync(args[0].path);
        return stats.isFile() ? 1 : 0;
      } catch (error) {
        return 0;
      }
    },
    'size(Ljava/nio/file/Path;)J': (jvm, obj, args) =>
      BigInt(statPath(jvm, args[0], null).size),
  },
};
